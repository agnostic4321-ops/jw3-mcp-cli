// mcp-server/daily-prep.ts — the daily_prep tool handler (moved out of index.ts).
//
// Morning brief: public fan-out + account snapshot + JEV bias per name,
// composed by daily-prep-lib and recorded as the day's "Daily analysis" in
// diary_day_notes (replace-or-append, so a re-run never duplicates). Reads
// ride mcp:read; the diary write needs trade:propose (PAT) — JWT callers
// keep legacy behavior. Behavior identical to the inline block.
import { buildCexTimeframes } from "../_shared/snapshot.ts";
import { toolError, toolOk, type ToolCtx } from "./tools.ts";
import {
  MAX_DAILY_PREP_CONNECTIONS,
  MAX_DAILY_PREP_NAMES,
  internalErrorText,
  logServer,
  newCorrelationId,
  upstreamErrorText,
} from "./tools.ts";

export async function handleDailyPrep(
  ctx: ToolCtx, id: unknown, args: Record<string, unknown>,
): Promise<Response> {
  const corr = newCorrelationId();
  const { admin, userId, supaUrl, authHeader, viaPat, scopes, callEdge } = ctx;
  // Morning brief: public fan-out + account snapshot + JEV bias per
  // name, composed by daily-prep-lib and recorded as the day's
  // "Daily analysis" in diary_day_notes (replace-or-append, so a
  // re-run never duplicates). Reads ride mcp:read; the diary write
  // needs trade:propose (PAT) — JWT callers keep legacy behavior.
  const write = args.write !== false;
  const dayRaw = typeof args.day === "string" ? args.day : "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : new Date().toISOString().slice(0, 10);
  if (write && viaPat && !scopes.includes("trade:propose") && !scopes.includes("trade:execute")) {
    return toolError(id, "auth: daily_prep write needs the trade:propose scope (mint it in Settings → Harness Access), or pass write:false for a dry run");
  }
  const atIso = new Date().toISOString();
  const settled = await Promise.allSettled([
    // Double cold-start (both fns redeployed) + 13 upstreams can
    // exceed 60s — allow 120s before degrading to an empty brief.
    callEdge(supaUrl, authHeader, "daily-brief", {}, 120000),
    admin.from("exchange_connections").select("id,exchange,label,status,markets").eq("user_id", userId),
    admin.from("risk_limits").select("autonomy_level,kill_switch_enabled,max_position_usd,max_trades_per_day,max_daily_loss_usd,daily_realized_loss_usd,daily_trade_count").eq("user_id", userId).maybeSingle(),
    callEdge(supaUrl, authHeader, "cex-proxy", { action: "tickers", exchange: "binance" }, 30000),
  ]);
  const brief = settled[0].status === "fulfilled" ? settled[0].value as Record<string, unknown> : {};
  if (settled[0].status === "rejected") {
    logServer(corr, "daily-brief fan-out failed:", String(settled[0].reason).slice(0, 500));
  }
  const allConns = (settled[1].status === "fulfilled" && !settled[1].value.error ? settled[1].value.data : []) as Array<Record<string, string>>;
  // Cap the per-connection fan-out: each connection costs two venue reads.
  const connsTruncated = allConns.length > MAX_DAILY_PREP_CONNECTIONS;
  const conns = allConns.slice(0, MAX_DAILY_PREP_CONNECTIONS);
  if (connsTruncated) logServer(corr, `connection fan-out capped at ${MAX_DAILY_PREP_CONNECTIONS} of ${allConns.length}`);
  const rl = (settled[2].status === "fulfilled" && !settled[2].value.error ? settled[2].value.data : null) as Record<string, number | string | boolean | null> | null;
  // Raw cex-proxy tickers need the same normalize step as the screener branch.
  const rawTicks = ((((settled[3].status === "fulfilled" ? settled[3].value : null) as { tickers?: Array<Record<string, unknown>> } | null)?.tickers) ?? []);
  const ticks = rawTicks.map((t) => {
    // change24h arrives as PERCENT (0.257 = +0.257%) — store fraction.
    const chgPc = typeof t.change24h === "number" ? t.change24h : (typeof t.priceChangePercent === "number" ? t.priceChangePercent : null);
    const px = typeof t.last === "number" ? t.last : (typeof t.price === "number" ? t.price : null);
    const baseVol = typeof t.quoteVolume === "number" ? t.quoteVolume : (typeof t.volume === "number" ? t.volume : null);
    return {
      s: t.symbol ?? t.pair ?? null, p: px,
      chg: chgPc == null ? null : chgPc / 100,
      qvol: baseVol == null || px == null ? null : (typeof t.quoteVolume === "number" ? baseVol : baseVol * px),
    };
  }).filter((t) => t.s && t.p != null);
  const chgOf = (base: string): number | null => {
    const t = ticks.find((x) => String(x.s ?? "").replace("/", "") === `${base}USDT`);
    return typeof t?.chg === "number" ? t.chg : null;
  };
  // Per-connection account snapshot (positions + working orders).
  const accounts = await Promise.all(conns.map(async (c) => {
    const [posR, ordR] = await Promise.allSettled([
      callEdge(supaUrl, authHeader, "cex-proxy", { action: "positions", connectionId: c.id, withExits: true }, 30000),
      callEdge(supaUrl, authHeader, "cex-proxy", { action: "openOrders", connectionId: c.id }, 30000),
    ]);
    // cex-proxy returns raw arrays for positions/openOrders.
    const posVal = posR.status === "fulfilled" ? posR.value : null;
    const ordVal = ordR.status === "fulfilled" ? ordR.value : null;
    const rows = (Array.isArray(posVal) ? posVal : (posVal as { positions?: Array<Record<string, unknown>> } | null)?.positions ?? []) as Array<Record<string, unknown>>;
    const orders = (Array.isArray(ordVal) ? ordVal : (ordVal as { orders?: unknown[] } | null)?.orders ?? []) as unknown[];
    return {
      exchange: String(c.exchange ?? "?"), label: String(c.label ?? ""),
      positions: rows.filter((p) => p.symbol ?? p.pair).map((p) => {
        const exits = Array.isArray(p.exits) ? p.exits : [];
        return {
          symbol: String(p.symbol ?? p.pair ?? "?"),
          side: String(p.side ?? "?"),
          qty: typeof p.qty === "number" ? p.qty : (typeof p.size === "number" ? p.size : null),
          entry: typeof p.entryPrice === "number" ? p.entryPrice : (typeof p.entry === "number" ? p.entry : null),
          mark: typeof p.markPrice === "number" ? p.markPrice : (typeof p.mark === "number" ? p.mark : null),
          upnl: typeof p.unrealizedPnl === "number" ? p.unrealizedPnl : (typeof p.upnl === "number" ? p.upnl : null),
          exitsArmed: exits.length > 0,
        };
      }),
      openOrders: orders.length,
      ...(ordR.status === "rejected" ? { ordersError: "read failed" } : {}),
    };
  }));
  // Names: BTC/ETH/SOL + top-2 movers by |24h change|, ex-majors/stables,
  // with quality gates (priced, ≥$1M quote volume, |move| ≤ 50%).
  const moverPicks = ticks
    .filter((t) => typeof t.s === "string" && t.s.endsWith("/USDT") && typeof t.chg === "number")
    .map((t) => ({ pair: t.s as string, chg: t.chg as number, px: t.p as number, qv: t.qvol as number | null }))
    .filter((t) => t.px > 0 && (t.qv ?? 0) >= 1e6 && Math.abs(t.chg) <= 0.5)
    .filter((t) => !["BTC/USDT", "ETH/USDT", "SOL/USDT"].includes(t.pair) && !/^(USDC|FDUSD|TUSD|DAI|USDE)\/USDT$/.test(t.pair))
    .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
    .slice(0, 2);
  const nameSpecs = [
    { name: "BTC", pair: "BTC/USDT" }, { name: "ETH", pair: "ETH/USDT" },
    { name: "SOL", pair: "SOL/USDT" },
    ...moverPicks.map((m) => ({ name: m.pair.replace("/USDT", ""), pair: m.pair })),
  ].slice(0, MAX_DAILY_PREP_NAMES);
  const { atrPct, prevDayHL } = await import("../_shared/daily-brief-lib.ts");
  const { composeBrief } = await import("../_shared/daily-prep-lib.ts");
  // JEV runs SEQUENTIAL: parallel model calls trip the key's RPM
  // (observed 429s). Each name stays fail-soft — levels without bias.
  const names: Array<{
    name: string; pair: string; price: number | null; chg24h: number | null;
    pdh: number | null; pdl: number | null; atrPct: number | null;
    jev: string; jevConf: number | null; jevError?: string;
  }> = [];
  for (const spec of nameSpecs) {
    const base = { name: spec.name, pair: spec.pair, price: null as number | null, chg24h: chgOf(spec.name), pdh: null as number | null, pdl: null as number | null, atrPct: null as number | null, jev: "n/a", jevConf: null as number | null, jevError: undefined as string | undefined };
    try {
      const tfs = await buildCexTimeframes(async (b) => {
        return await callEdge(supaUrl, authHeader, "cex-proxy", { ...b, exchange: "binance" });
      }, "binance", spec.pair);
      const daily = tfs.find((t) => t.tf === "1440");
      const candles = (daily?.candles ?? []).map((c) => ({ o: c.o, h: c.h, l: c.l, c: c.c }));
      const hl = prevDayHL(candles);
      base.pdh = hl?.h ?? null; base.pdl = hl?.l ?? null; base.atrPct = atrPct(candles);
      const last = candles[candles.length - 1];
      base.price = last?.c ?? null;
      const runJev = () => callEdge(supaUrl, authHeader, "jev-analyze", {
        family: "cex", venue: "binance", symbol: spec.pair,
        snapshot: { timeframes: tfs }, snapshotAt: atIso,
      }, 60000) as Promise<{ error?: unknown; verdict?: { trend?: { verdict?: string; agreement?: number } } }>;
      if (tfs.length === 0) {
        base.jevError = "no candles from venue";
      } else {
        let out: { error?: unknown; verdict?: { trend?: { verdict?: string; agreement?: number } } };
        try {
          out = await runJev();
        } catch (e) {
          // One bounded retry on explicit 429 backoff — the shared
          // key's RPM fits ~4 names/min; the 5th may need a nap.
          const waitMs = Number((e instanceof Error ? e.message : "").match(/retry after (\d+)\s*ms/i)?.[1] ?? NaN);
          if (Number.isFinite(waitMs) && waitMs > 0 && waitMs <= 65000) {
            await new Promise((r) => setTimeout(r, waitMs + 2000));
            out = await runJev();
          } else {
            throw e;
          }
        }
        if (typeof out.error === "string" && out.error) {
          logServer(corr, `JEV bias failed for ${spec.pair}:`, String(out.error).slice(0, 300));
          base.jevError = `unavailable (ref ${corr})`;
        } else {
          base.jev = out.verdict?.trend?.verdict ?? "n/a";
          base.jevConf = typeof out.verdict?.trend?.agreement === "number" ? out.verdict.trend.agreement : null;
        }
      }
    } catch (e) {
      logServer(corr, `JEV bias threw for ${spec.pair}:`, e instanceof Error ? e.message : e);
      base.jevError = `unavailable (ref ${corr})`;
    }
    names.push(base);
  }
  const markdown = composeBrief(day, atIso, {
    maxDailyLoss: typeof rl?.max_daily_loss_usd === "number" ? rl.max_daily_loss_usd : null,
    realizedLoss: typeof rl?.daily_realized_loss_usd === "number" ? rl.daily_realized_loss_usd : null,
    maxTrades: typeof rl?.max_trades_per_day === "number" ? rl.max_trades_per_day : null,
    tradeCount: typeof rl?.daily_trade_count === "number" ? rl.daily_trade_count : null,
    maxPos: typeof rl?.max_position_usd === "number" ? rl.max_position_usd : null,
    kill: rl?.kill_switch_enabled === true,
    autonomy: typeof rl?.autonomy_level === "string" ? rl.autonomy_level : null,
  }, accounts, brief, names);
  let wrote = false;
  if (write) {
    const header = `## Daily analysis — ${day}`;
    const { data: existing } = await admin.from("diary_day_notes")
      .select("body_md").eq("user_id", userId).eq("day", day).maybeSingle();
    const cur = (existing as { body_md?: string | null } | null)?.body_md ?? "";
    let nextBody: string;
    if (cur.includes(header)) {
      const start = cur.indexOf(header);
      const rest = cur.slice(start);
      const cut = rest.indexOf("\n## ", 1);
      nextBody = cur.slice(0, start) + markdown + (cut === -1 ? "" : rest.slice(cut));
    } else {
      nextBody = cur ? `${cur}\n\n${markdown}` : markdown;
    }
    const { error } = await admin.from("diary_day_notes")
      .upsert({ user_id: userId, day, body_md: nextBody }, { onConflict: "user_id,day" });
    if (error) {
      logServer(corr, "brief built but diary write failed:", error.message);
      return toolError(id, internalErrorText(corr));
    }
    wrote = true;
  }
  return toolOk(id, {
    day, wrote, brief_chars: markdown.length,
    brief_ok: settled[0].status === "fulfilled",
    ...(settled[0].status === "rejected" ? { brief_error: upstreamErrorText(corr) } : {}),
    connections_capped: connsTruncated,
    risk: { kill: rl?.kill_switch_enabled === true, autonomy: rl?.autonomy_level ?? null },
    jev: names.map((n) => ({ name: n.name, jev: n.jev, err: n.jevError ?? null })),
    sections: {
      funding: (brief.funding as unknown[] ?? []).length,
      macro: ((brief.macro as { events?: unknown[] } | undefined)?.events ?? []).length,
      news: ((brief.news as { items?: unknown[] } | undefined)?.items ?? []).length,
      gaps: ["etfFlows", "unlocks", "sentiment"].filter((k) => (brief[k] as { status?: string } | undefined)?.status === "unavailable"),
    },
    ...(write ? { note: "Full text recorded in diary_day_notes." } : { brief: markdown }),
  });
}
