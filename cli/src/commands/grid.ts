/**
 * Neutral futures grid: 50 levels × 0.25% around center, limit orders
 * both sides, x2 isolated. `plan` is read-only (ladder + margin check
 * vs live free balance). `start` previews once, then fires every level
 * with --yes. Refill/range watch rides a bounded poll loop (EVENT lines).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { callTool } from "../mcp.js";
import {
  backtestGrid,
  futuresCenter,
  futuresCloses,
  futuresContractSpec,
  gridLadder,
  type ContractSpec,
  type GridBias,
} from "../kucoin.js";
import { fail, listConnections, needPat, pickConnection } from "./market.js";
import { startupGate } from "../reconcile.js";
import { makeIntentKey, ACTOR_MACHINE } from "./trade.js";

export type GridArgs = {
  exchange: string;
  pair: string;
  stepPct: number;
  levelsPerSide: number;
  stepUsd: number;
  leverage: number;
  bias: GridBias;
};

function roundToTick(px: number, tick: number): number {
  if (tick > 0) return Math.round(px / tick) * tick;
  if (px >= 100) return Math.round(px * 100) / 100;
  if (px >= 1) return Math.round(px * 1000) / 1000;
  return Number(px.toPrecision(5));
}

/**
 * `grid backtest` — read-only. Replays 15m klines through all three
 * biases and prints the comparison. Model limits are stated on
 * `backtestGrid` — closes-only, fee-flat, no spread/slippage.
 */
export async function cmdGridBacktest(opts: {
  pair: string;
  stepPct: number;
  levelsPerSide: number;
  contracts: number;
  leverage: number;
  days: number;
  json: boolean;
}): Promise<void> {
  const base = (opts.pair.split("/")[0] ?? "").toUpperCase();
  if (!base || !(opts.days > 0) || !(opts.stepPct > 0) || !(opts.levelsPerSide >= 1) || !(opts.leverage > 0)) {
    console.error("Usage: jw3 grid backtest --pair SEI/USDT [--step-pct 0.25] [--levels 25] [--contracts 19] [--lev 2] [--days 30] [--json]");
    process.exitCode = 2;
    return;
  }
  const sym = `${base}USDTM`;
  const now = Date.now();
  const from = now - Math.min(opts.days, 90) * 86400 * 1000;
  let closes: number[];
  try {
    closes = await futuresCloses(sym, 15, from, now);
  } catch (e) {
    fail(e);
    return;
  }
  if (closes.length < 100) {
    console.error(`Only ${closes.length} candles — no backtest on thin history.`);
    process.exitCode = 1;
    return;
  }
  const center = closes[closes.length - 1] as number;
  const spec = await futuresContractSpec(base).catch(() => ({ multiplier: 1, tick: 0 }));
  const rows = (["long", "short", "neutral"] as GridBias[]).map((bias) => ({
    bias,
    ...(backtestGrid(
      closes, center, opts.stepPct, opts.levelsPerSide,
      opts.contracts, spec.multiplier, bias, opts.leverage,
    ) ?? {}),
  }));
  if (opts.json) {
    console.log(JSON.stringify({ pair: opts.pair, candles: closes.length, center, rows }));
    return;
  }
  console.log(`BACKTEST ${opts.pair} — ${closes.length}×15m closes, center ${center}, ${opts.contracts}ct/lvl ×${opts.leverage}`);
  console.log("bias     fills  realized$  inv$     total$   ret%    breaks  maxAdv%");
  for (const r of rows) {
    const f = (v: unknown, d = 1): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
    console.log(
      [
        String(r.bias).padEnd(8),
        String(r.fills ?? "—").padStart(6),
        f(r.realizedUsd).padStart(9),
        f(r.inventoryUpnlUsd).padStart(7),
        f(r.totalUsd).padStart(8),
        f(r.returnPct).padStart(6),
        String(r.rangeBreaks ?? "—").padStart(7),
        f(r.maxAdversePct).padStart(7),
      ].join("  "),
    );
  }
  console.log("Model: closes-only, 0.06%/fill, no spread/slippage, breaks held + counted.");
}

export function gridContracts(stepUsd: number, center: number, multiplier: number): number {
  return Math.max(1, Math.round(stepUsd / (multiplier * center)));
}

/**
 * SINGLE construction site for grid fire tickets (seed + every level).
 * Machine strategy path: actor "machine" (see ACTOR MAP in trade.ts), and
 * a per-INTENT idempotency key derived from the level's own shape (mirror
 * live.ts), so a retried `grid start` reproduces the same keys instead of
 * stacking a second ladder.
 */
export function gridOrderArgs(o: {
  exchange: string;
  pair: string;
  side: "buy" | "sell";
  contracts: number;
  price?: number;
  leverage: number;
}): Record<string, unknown> {
  const amount = String(o.contracts);
  const price = o.price === undefined ? undefined : String(o.price);
  return {
    exchange: o.exchange,
    pair: o.pair,
    side: o.side,
    amount,
    ...(price !== undefined ? { price } : {}),
    market: "futures",
    leverage: o.leverage,
    marginMode: "isolated",
    idempotency_key: makeIntentKey(
      "grid",
      [o.exchange, o.pair, o.side, amount, price ?? "market", o.leverage].join("|"),
    ),
    actor: ACTOR_MACHINE,
  };
}

async function freeFuturesUsd(exchange: string, pat: string, url?: string): Promise<number> {
  const conns = await listConnections(pat, url);
  const conn = pickConnection(conns, exchange || undefined, false);
  if (!conn || !exchange) throw new Error(`no ${exchange || "?"} connection — connect it in-app first`);
  const out = (await callTool(
    "read_live_datum",
    { kind: "balances", connectionId: conn.id },
    pat, url,
  )) as {
    accounts?: { futures?: { asset: string; free: number; total: number }[] };
    merged?: { asset: string; free: number; total: number }[];
  };
  const rows = out.accounts?.futures ?? out.merged ?? [];
  const usdt = rows.find((r) => r.asset === "USDT") ?? rows[0];
  const f = usdt?.free ?? NaN;
  if (!Number.isFinite(f)) throw new Error("could not read free futures balance — no grid without capital proof");
  return f as number;
}

export async function cmdGrid(
  mode: "plan" | "start",
  a: GridArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const base = (a.pair.split("/")[0] ?? "").toUpperCase();
  if (!base || !(a.stepPct > 0) || a.stepPct > 5 || !(a.levelsPerSide >= 1) || !(a.stepUsd > 0) || !(a.leverage > 0)) {
    console.error("Usage: jw3 grid plan|start --pair SEI/USDT [--bias long|short|neutral] [--step-pct 0.25] [--levels 25] [--size 15] [--lev 2] [--yes]");
    process.exitCode = 2;
    return;
  }
  const bias: GridBias = a.bias === "short" ? "short" : a.bias === "long" ? "long" : "neutral";
  let center: number;
  let spec: ContractSpec;
  try {
    [center, spec] = await Promise.all([futuresCenter(base), futuresContractSpec(base)]);
  } catch (e) {
    fail(e);
    return;
  }
  const contracts = gridContracts(a.stepUsd, center, spec.multiplier);
  const ladder = gridLadder(center, a.stepPct, a.levelsPerSide, bias, contracts);
  if (!ladder) {
    console.error("Bad grid params — nothing invented, nothing sent.");
    process.exitCode = 2;
    return;
  }
  const stepNotional = contracts * spec.multiplier * center;
  // Capital: seed inventory (directional) + one full ladder side, on leverage.
  const marginReq = ((ladder.seedContracts + ladder.levelsPerSide * contracts) * spec.multiplier * center) / a.leverage;
  let free: number;
  try {
    free = await freeFuturesUsd(a.exchange, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  const ok = free >= marginReq + 30;
  const summary = {
    pair: a.pair, exchange: a.exchange, center, stepPct: a.stepPct,
    bias, seedContracts: ladder.seedContracts,
    levels: ladder.levels.length, lower: ladder.lower, upper: ladder.upper,
    rangePct: ladder.rangePct, contractsPerLevel: contracts,
    stepNotionalUsd: stepNotional,
    totalNotionalUsd: (ladder.seedContracts + ladder.levelsPerSide * contracts) * spec.multiplier * center,
    leverage: a.leverage, marginRequiredUsd: marginReq,
    freeFuturesUsd: free, funded: ok,
    roundTripFeePct: 0.12, netPerPairPct: a.stepPct * 2 - 0.12,
  };
  if (opts.json) {
    console.log(JSON.stringify({ ...summary, ladder: ladder.levels.map((l) => ({ ...l, price: roundToTick(l.price, spec.tick) })) }));
    return;
  }
  console.log(`GRID ${mode.toUpperCase()} ${bias.toUpperCase()} — ${a.pair} @ ${center} (${ladder.levels.length} levels × ${a.stepPct}%, x${a.leverage} isolated)`);
  if (bias !== "neutral") console.log(`  seed ${bias.toUpperCase()} ${ladder.seedContracts} contracts @ market (covers all ${ladder.levelsPerSide} ${bias === "long" ? "sell" : "buy"} levels)`);
  console.log(`  range ${roundToTick(ladder.lower, spec.tick)} … ${roundToTick(ladder.upper, spec.tick)} (${ladder.rangePct.toFixed(2)}%)`);
  console.log(`  ${contracts} contracts/level ≈ $${stepNotional.toFixed(2)} → margin $${marginReq.toFixed(0)} vs free $${free.toFixed(0)} — ${ok ? "FUNDED" : "UNDERFUNDED"}`);
  console.log(`  net per pair-fill ≈ ${(a.stepPct * 2 - 0.12).toFixed(2)}% ≈ $${((stepNotional * (a.stepPct * 2 - 0.12)) / 100).toFixed(3)}`);
  if (!ok) {
    console.error("Refusing: free balance does not cover margin + $30 buffer. Reduce --size or --levels.");
    process.exitCode = 1;
    return;
  }
  if (mode === "plan") {
    console.log("Plan only — nothing sent. `grid start --bias … --yes` fires seed + all levels.");
    return;
  }
  // No-strays gate (start only — plan is read-only): a leftover grid
  // state means a previous run may still own this pair's ladder.
  const gate0 = startupGate("grid", base);
  if (!gate0.ok) {
    console.error(gate0.reason);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes) {
    console.log("Dry run — nothing sent. Re-run with --yes to fire seed + all levels (real money).");
    return;
  }
  let seedOrderId: string | null = null;
  if (bias !== "neutral" && ladder.seedContracts > 0) {
    try {
      const seed = (await callTool(
        "execute_trade",
        gridOrderArgs({
          exchange: a.exchange, pair: a.pair,
          side: bias === "long" ? "buy" : "sell",
          contracts: ladder.seedContracts,
          leverage: a.leverage,
        }),
        pat, opts.url,
      )) as { orderId?: string };
      seedOrderId = String(seed.orderId ?? "?");
      console.log(`SEED ${bias.toUpperCase()} ${ladder.seedContracts} @ market → ${seedOrderId}`);
    } catch (e) {
      console.error(`Seed failed — aborting ladder, no levels placed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
  }
  const placed: { side: string; price: number; orderId: string }[] = [];
  const failed: { side: string; price: number; error: string }[] = [];
  for (const l of ladder.levels) {
    const px = roundToTick(l.price, spec.tick);
    try {
      const out = (await callTool(
        "execute_trade",
        gridOrderArgs({
          exchange: a.exchange, pair: a.pair,
          side: l.side === "buy" ? "buy" : "sell",
          contracts,
          price: px,
          leverage: a.leverage,
        }),
        pat, opts.url,
      )) as { orderId?: string };
      placed.push({ side: l.side, price: px, orderId: String(out.orderId ?? "?") });
    } catch (e) {
      failed.push({ side: l.side, price: px, error: e instanceof Error ? e.message : String(e) });
    }
  }
  console.log(`PLACED ${placed.length}/${ladder.levels.length} levels, ${failed.length} failed.`);
  for (const f of failed.slice(0, 10)) console.log(`  FAIL ${f.side} @ ${f.price}: ${f.error.slice(0, 160)}`);
  const state = { ...summary, center, tick: spec.tick, multiplier: spec.multiplier, seedOrderId, placed, failed: failed.length };
  const statePath = join(tmpdir(), `grid_${base.toLowerCase()}.json`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`Grid state → ${statePath}`);
  if (failed.length > 0) process.exitCode = 1;
}
