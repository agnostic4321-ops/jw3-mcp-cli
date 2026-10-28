/**
 * `scan fade` — gainers (MCP screener) × futures tape (public KuCoin).
 * Finds rallies running out of volume: the exhaustion-short setup.
 * Read-only. Ranks fade-short first, flags already-dumped as late.
 */
import { callTool } from "../mcp.js";
import {
  dipSignal,
  fadeSignal,
  futuresFade,
  planScalp,
  scanBase,
  type FadeRow,
} from "../kucoin.js";
import { fail, needPat } from "./market.js";

type Tick = { s: string; p: number; chg: number | null; vol: number | null };

export async function cmdScanFade(opts: {
  exchange: string;
  minChg: number;
  limit: number;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let ticks: Tick[];
  try {
    const out = (await callTool(
      "read_live_datum",
      { kind: "screener", exchange: opts.exchange || "kucoin" },
      pat,
      opts.url,
    )) as { topByVolume?: Tick[] };
    ticks = out.topByVolume ?? [];
  } catch (e) {
    fail(e);
    return;
  }
  const cands = ticks
    .filter((t) => (t.chg ?? -Infinity) >= opts.minChg)
    .map((t) => ({ tick: t, base: scanBase(t.s) }))
    .filter((c): c is { tick: Tick; base: string } => c.base !== null)
    .slice(0, opts.limit);
  if (cands.length === 0) {
    if (opts.json) console.log(JSON.stringify([]));
    else console.log(`No gainers ≥ ${opts.minChg}% in the top-by-volume board — nothing to fade.`);
    return;
  }
  const rows: (FadeRow & { chg24: number | null; sSig: string; lSig: string })[] = [];
  for (const c of cands) {
    try {
      const r = await futuresFade(c.base);
      rows.push({ ...r, chg24: c.tick.chg, sSig: fadeSignal(r), lSig: dipSignal(r) });
    } catch {
      rows.push({
        symbol: `${c.base}USDTM`,
        last: NaN,
        chg: NaN,
        vratio: NaN,
        vslope: "up",
        offHighPct: NaN,
        offLowPct: NaN,
        atrPct: null,
        fundingPct: null,
        n: 0,
        chg24: c.tick.chg,
        sSig: "no-tape",
        lSig: "no-tape",
      });
    }
  }
  const rank: Record<string, number> = {
    "fade-short": 0, "dip-long": 0, neutral: 1, strong: 2, capitulation: 2,
    late: 3, extended: 3, "no-tape": 4,
  };
  rows.sort((a, b) => Math.min(rank[a.sSig] ?? 5, rank[a.lSig] ?? 5) - Math.min(rank[b.sSig] ?? 5, rank[b.lSig] ?? 5));
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log("SYM        24H%  VOLx12/12  SLOPE  OFF-HI  OFF-LO   ATR%  FUND%   SHORT-SIG  LONG-SIG");
  for (const r of rows) {
    const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : "—");
    console.log(
      [
        r.symbol.replace("USDTM", "").padEnd(10),
        (r.chg24 == null ? "—" : `${r.chg24 > 0 ? "+" : ""}${r.chg24.toFixed(1)}%`).padStart(6),
        f(r.vratio).padStart(9),
        r.vslope.padStart(6),
        (Number.isFinite(r.offHighPct) ? `${r.offHighPct.toFixed(1)}%` : "—").padStart(7),
        (Number.isFinite(r.offLowPct) ? `${r.offLowPct.toFixed(1)}%` : "—").padStart(7),
        (r.atrPct == null ? "—" : r.atrPct.toFixed(2)).padStart(6),
        (r.fundingPct == null ? "—" : r.fundingPct.toFixed(4)).padStart(7),
        r.sSig.padStart(10),
        r.lSig,
      ].join("  "),
    );
  }
}

/**
 * `scalp plan` — read-only. Measures the futures tape (ATR% + volume
 * regime) and derives the full mechanic: TP%, step spacing, 1/1/2 sizes,
 * averaged entry, moving TP, kill line with its dollar cost.
 */
export async function cmdScalpPlan(opts: {
  pair: string;
  direction: "long" | "short";
  size: number;
  steps: number;
  json: boolean;
}): Promise<void> {
  const base = (opts.pair.split("/")[0] ?? "").toUpperCase();
  if (!base || (opts.direction !== "long" && opts.direction !== "short") || !(opts.size > 0)) {
    console.error("Usage: jw3 scalp plan --pair SOL/USDT --long|--short [--size 15] [--steps 3] [--json]");
    process.exitCode = 2;
    return;
  }
  let row: FadeRow;
  try {
    row = await futuresFade(base);
  } catch (e) {
    console.error(`No futures tape for ${base}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const plan = planScalp(row.last, row.atrPct, opts.direction, opts.size, opts.steps);
  if (!plan) {
    console.error("Could not derive a plan from this tape — no numbers invented.");
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ symbol: row.symbol, tape: row, plan }, null, 2));
    return;
  }
  const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));
  console.log(`${opts.direction.toUpperCase()} ${opts.pair} @ ${px(plan.last)}  (ATR ${plan.atrPct?.toFixed(2) ?? "—"}%, vol x${Number.isFinite(row.vratio) ? row.vratio.toFixed(2) : "—"} ${row.vslope})`);
  for (const s of plan.steps) {
    console.log(`  step ${s.step}: ${opts.direction} $${s.sizeUsd.toFixed(0)} @ ${px(s.price)} (${s.dropFromLastPct === 0 ? "touch" : `-${s.dropFromLastPct.toFixed(2)}%`})`);
  }
  console.log(`  avg entry ${px(plan.avgEntry)} → TP +${plan.tpPct.toFixed(2)}% @ ${px(plan.tpPrice)} = +$${plan.tpProfitUsd.toFixed(2)}`);
  console.log(`  kill line ${px(plan.killPrice)} = -$${plan.killLossUsd.toFixed(2)}  ·  max capital $${plan.maxCapitalUsd.toFixed(0)}`);
  console.log("Plan only — nothing sent. Fire steps with `execute` + move TP with `exits --yes`.");
}
