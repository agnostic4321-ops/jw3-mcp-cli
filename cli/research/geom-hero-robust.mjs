#!/usr/bin/env node
/**
 * THE ROBUSTNESS ANALYSIS — is any of the sweep's positive expectancy real?
 *
 * The sweep found 441 geometries with a positive net expectancy. Before
 * any of them means anything, three things have to hold:
 *
 *   1. THE UNSELECTED SUBSET MUST PAY. The level-resolved subset is
 *      SELECTED (only the trades that moved far enough to hit a level
 *      are in it), and at a wide stop inside a short hold it is 100%
 *      wins by construction. If the time-exit subset — every trade a
 *      mark, no selection at all — is negative, the positive expectancy
 *      is the selected-sample trap and nothing else.
 *
 *   2. THE SIGN MUST SURVIVE A TIME SPLIT. The collector's window is a
 *      few hours in a falling market. A geometry whose edge is really
 *      just that window's drift flips sign in the second half.
 *
 *   3. THE COMPARISON MUST BE HONEST. The task's 66.7% is a 1-HOUR
 *      FORWARD RETURN win rate: the probability the price is on the
 *      right side of the entry after an hour. A geometry's break-even
 *      win rate is P(TARGET touched before STOP) — a different quantity.
 *      Both are measured here, on the same arm, so they can be compared
 *      without conflating them.
 *
 * READ-ONLY. Local files and the public kline endpoint only.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN = join(SCRATCH, "confluence.ndjson");
const BARS_CACHE = join(SCRATCH, "geom-hero-bars.json");
const SNAPSHOT = join(SCRATCH, "geom-hero-snapshot.ndjson");

const TAKER_RT = 0.12;
const LIVE_RT = 0.08;
const BUCKET_MS = 5 * 60_000;
const INTERVAL_MIN = 5;
const NOTIONAL_OVER_EQUITY = 59.0 / 57.35;

const GRID_TP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0];
const GRID_SL = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.5, 2.0];
const GRID_HOLD = [15, 30, 60, 120, 240];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};
const clusterMeans = (values, buckets) => {
  const by = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = by.get(b) ?? [];
    arr.push(values[i]);
    by.set(b, arr);
  }
  return [...by.values()].map((a) => mean(a));
};
const breakEvenWinRate = (tp, sl, f) => (sl + f) / (tp + sl);

const CACHE = JSON.parse(readFileSync(BARS_CACHE, "utf8"));

// The signal arm, read from the SNAPSHOT the sweep wrote, so this
// analysis is against exactly the same rows.
const rows = readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const modelSide = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return j && l ? (j === l ? j : null) : (j || l);
};
const SIGNAL = rows
  .map((r) => ({ ...r, tape: tapeSideFromRow(r), model: modelSide(r) }))
  .filter((r) => r.tape && r.model && r.model === r.tape);
const CONTROL = rows
  .map((r) => ({ ...r, tape: tapeSideFromRow(r) }))
  .filter((r) => r.tape && r.tape === "short");

// The time-split point: the median observation timestamp of the arm.
const _ts = SIGNAL.map((r) => r.ts).sort((a, b) => a - b);
const MID_TS = _ts[Math.floor(_ts.length / 2)];

console.log(`[robust] ${SIGNAL.length} signal rows, ${new Set(SIGNAL.map((r) => Math.floor(r.ts / BUCKET_MS))).size} clusters`);
console.log(`[robust] ${CONTROL.length} control rows, ${new Set(CONTROL.map((r) => Math.floor(r.ts / BUCKET_MS))).size} clusters`);
console.log();

// ── prepare ──
function prepare(obs, holdMin) {
  const bars = CACHE[obs.pair];
  if (!bars?.length) return null;
  const entry = Number(obs.price);
  if (!(entry > 0)) return null;
  const nBars = Math.round(holdMin / INTERVAL_MIN);
  const start = bars.findIndex((b) => b.t > obs.ts);
  if (start < 0) return null;
  const end = start + nBars;
  if (end > bars.length) return null;
  const win = bars.slice(start, end);
  const runMax = [], runMin = [];
  let mx = -Infinity, mn = Infinity;
  for (const b of win) { mx = Math.max(mx, b.h); mn = Math.min(mn, b.l); runMax.push(mx); runMin.push(mn); }
  const close = win[win.length - 1].c;
  const long = obs.dir === "long";
  const mark = (long ? (close - entry) / entry : (entry - close) / entry) * 100;
  return { entry, long, runMax, runMin, mark, ts: obs.ts, pair: obs.pair };
}
function resolve(prep, tpPct, slPct) {
  const tp = prep.long ? prep.entry * (1 + tpPct / 100) : prep.entry * (1 - tpPct / 100);
  const sl = prep.long ? prep.entry * (1 - slPct / 100) : prep.entry * (1 + slPct / 100);
  for (let i = 0; i < prep.runMax.length; i++) {
    const hitTp = prep.long ? prep.runMax[i] >= tp : prep.runMin[i] <= tp;
    const hitSl = prep.long ? prep.runMin[i] <= sl : prep.runMax[i] >= sl;
    if (hitTp && hitSl) return "loss";
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  return "time";
}
function simulate(prepared, tp, sl, rt) {
  const trades = [];
  for (const p of prepared) {
    const kind = resolve(p.prep, tp, sl);
    const pnl = kind === "win" ? tp - rt : kind === "loss" ? -sl - rt : p.prep.mark - rt;
    trades.push({ kind, pnl, bucket: p.bucket, ts: p.ts, dir: p.dir, firstHalf: p.ts < MID_TS });
  }
  return trades;
}
function stats(trades) {
  const wins = trades.filter((t) => t.kind === "win");
  const losses = trades.filter((t) => t.kind === "loss");
  const times = trades.filter((t) => t.kind === "time");
  const resolved = wins.length + losses.length;
  const pnl = trades.map((t) => t.pnl);
  const cm = clusterMeans(pnl, trades.map((t) => t.bucket));
  return {
    n: trades.length, wins: wins.length, losses: losses.length, times: times.length, resolved,
    winRate: resolved ? wins.length / resolved : 0,
    ev: mean(pnl),
    evResolved: mean(trades.filter((t) => t.kind !== "time").map((t) => t.pnl)),
    evTime: mean(trades.filter((t) => t.kind === "time").map((t) => t.pnl)),
    clusters: cm.length, clusterMean: mean(cm), clusterSe: se(cm),
    pnl, trades,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. THE 66.7% FIGURE: WHAT IT IS, AND WHAT THE TICKET'S OWN WIN
//    RATE ACTUALLY IS
// ═══════════════════════════════════════════════════════════════════
console.log("═══ 1. THE OBSERVED WIN RATE, MEASURED BOTH WAYS ═══");
console.log("  (a) the task's number: a 1-HOUR FORWARD RETURN win rate — the price is");
console.log("      on the right side of the entry 60 minutes later.");
console.log("  (b) the ticket's number: P(TARGET touched before STOP) — a different");
// console.log("      quantity, and the one a geometry's break-even must be compared to.");
console.log();
for (const holdMin of [15, 30, 60]) {
  const prepared = [];
  for (const o of SIGNAL) {
    const p = prepare(o, holdMin);
    if (!p) continue;
    prepared.push({ prep: p, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, dir: o.dir });
  }
  if (!prepared.length) continue;
  // (a) the forward-return win rate: the sign of the horizon's mark.
  const fwd = prepared.map((p) => (p.prep.mark > 0 ? 1 : 0));
  const fwdWin = fwd.reduce((s, x) => s + x, 0) / fwd.length;
  console.log(`  hold ${String(holdMin + "m").padStart(4)}: n=${String(prepared.length).padStart(3)}  forward-return win rate ${(fwdWin * 100).toFixed(1)}%`);
}
console.log();
console.log("  The 66.7% in the task (and in docs/research/falsified-leads.md) is a");
console.log("  1-HOUR FORWARD RETURN win rate from the CONFLICT/CONTROL study: n=39,");
console.log("  the models agreeing with the tape. It is NOT a P(TP before SL) rate.");
console.log();

// ═══════════════════════════════════════════════════════════════════
// 2. THE UNSELECTED SUBSET MUST PAY
// ═══════════════════════════════════════════════════════════════════
console.log("═══ 2. THE UNSELECTED SUBSET MUST PAY ═══");
console.log("  For every geometry with a positive pooled expectancy: is the edge in the");
console.log("  time-exit subset (every trade a mark, no selection) or only in the");
console.log("  level-resolved subset (the selected sample)?");
console.log();

const rowsOut = [];
for (const hold of GRID_HOLD) {
  const prepFor = (set) => {
    const prepared = [];
    for (const o of set) {
      const p = prepare(o, hold);
      if (!p) continue;
      prepared.push({ prep: p, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, dir: o.dir });
    }
    return prepared;
  };
  const S = prepFor(SIGNAL);
  const C = prepFor(CONTROL);
  if (!S.length) continue;
  for (const tp of GRID_TP) {
    for (const sl of GRID_SL) {
      if (tp > sl * 4) continue;
      const sig = stats(simulate(S, tp, sl, TAKER_RT));
      if (!sig.n) continue;
      const ctl = stats(simulate(C, tp, sl, TAKER_RT));
      const d = sig.clusterMean - ctl.clusterMean;
      const sd = Math.sqrt(sig.clusterSe ** 2 + ctl.clusterSe ** 2);
      rowsOut.push({
        hold, tp, sl, n: sig.n, clusters: sig.clusters,
        winRate: sig.winRate, be: breakEvenWinRate(tp, sl, TAKER_RT),
        ev: sig.ev, evResolved: sig.evResolved, evTime: sig.evTime,
        timeN: sig.times, resolvedN: sig.resolved,
        controlEv: ctl.ev, excess: d, t: sd > 0 ? d / sd : 0,
        resolvedWinRate: sig.resolved ? sig.wins / sig.resolved : 0,
        // The time-split.
        evFirstHalf: mean(sig.trades.filter((t) => t.firstHalf).map((t) => t.pnl)),
        evSecondHalf: mean(sig.trades.filter((t) => !t.firstHalf).map((t) => t.pnl)),
        nFirstHalf: sig.trades.filter((t) => t.firstHalf).length,
        nSecondHalf: sig.trades.filter((t) => !t.firstHalf).length,
      });
    }
  }
}
const pos = rowsOut.filter((r) => r.ev > 0);
const posTime = pos.filter((r) => r.evTime > 0);
console.log(`  geometries with a positive pooled expectancy: ${pos.length} of ${rowsOut.length}`);
console.log(`  ...of which the UNSELECTED (time-exit) subset ALSO pays: ${posTime.length}`);
console.log(`  ...of which the time-exit subset has at least 10 trades: ${posTime.filter((r) => r.timeN >= 10).length}`);
console.log();
console.log("  The ones where BOTH subsets pay AND the clusters reach the bar:");
const both = posTime.filter((r) => r.clusters >= 30 && r.timeN >= 10 && r.excess > 0 && r.t >= 2);
console.log(`    ${both.length}`);
for (const r of both.slice(0, 20)) {
  console.log(`      TP ${r.tp}% SL ${r.sl}% hold ${r.hold}m  EV ${r.ev.toFixed(4)}%  resolved ${r.resolvedN}@${(r.evResolved * 100).toFixed(3)}%  time ${r.timeN}@${(r.evTime * 100).toFixed(3)}%  excess ${r.excess.toFixed(4)}%  t ${r.t.toFixed(2)}  clusters ${r.clusters}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// 3. THE TIME SPLIT
// ═══════════════════════════════════════════════════════════════════
console.log("═══ 3. THE TIME SPLIT — does the sign survive? ═══");
const allTs = SIGNAL.map((r) => r.ts).sort((a, b) => a - b);
const midTs = allTs[Math.floor(allTs.length / 2)];
console.log(`  the signal arm spans ${new Date(allTs[0]).toISOString()} -> ${new Date(allTs[allTs.length - 1]).toISOString()}`);
console.log(`  the split is at ${new Date(midTs).toISOString()}`);
console.log();
// The forward market drift over the whole window, in each half: the
// benchmark any "edge" has to beat.
const mkMark = (o, hold) => {
  const p = prepare(o, hold);
  return p ? p.mark : null;
};
for (const hold of [30, 60]) {
  const first = [], second = [];
  for (const o of SIGNAL) {
    const m = mkMark(o, hold);
    if (m == null) continue;
    (o.ts < midTs ? first : second).push(m);
  }
  console.log(`  hold ${String(hold + "m").padStart(4)}: the signal arm's forward mark averages ${mean(first).toFixed(3)}% in the FIRST half and ${mean(second).toFixed(3)}% in the SECOND (n=${first.length}/${second.length})`);
}
console.log();
console.log("  The best geometry's expectancy in each half:");
const cands = [...rowsOut].sort((a, b) => b.ev - a.ev).slice(0, 10);
console.log("      TP%   SL%  hold     EV     1st half (n)        2nd half (n)");
for (const c of cands) {
  console.log(`     ${String(c.tp).padStart(4)} ${String(c.sl).padStart(5)} ${String(c.hold + "m").padStart(5)} ${(c.ev >= 0 ? "+" : "") + c.ev.toFixed(4)}%  ${(c.evFirstHalf >= 0 ? "+" : "") + c.evFirstHalf.toFixed(4)}% (${c.nFirstHalf})   ${(c.evSecondHalf >= 0 ? "+" : "") + c.evSecondHalf.toFixed(4)}% (${c.nSecondHalf})`);
}
console.log();
const signFlips = rowsOut.filter((r) => r.ev > 0 && r.nFirstHalf >= 5 && r.nSecondHalf >= 5 && r.evFirstHalf * r.evSecondHalf < 0);
console.log(`  geometries with a positive pooled expectancy whose sign FLIPS between the`);
console.log(`  two halves: ${signFlips.length} of ${rowsOut.filter((r) => r.ev > 0).length} positive geometries.`);
console.log();

// ═══════════════════════════════════════════════════════════════════
// 4. THE FORWARD-RETURN WIN RATE, measured properly on this sample
// ═══════════════════════════════════════════════════════════════════
console.log("═══ 4. THE FORWARD-RETURN WIN RATE ON THIS SAMPLE ═══");
for (const holdMin of [15, 30, 60, 120]) {
  const prepared = [];
  for (const o of SIGNAL) {
    const p = prepare(o, holdMin);
    if (!p) continue;
    prepared.push({ prep: p, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, dir: o.dir });
  }
  if (!prepared.length) { console.log(`  hold ${holdMin}m: no covered windows`); continue; }
  const wins = prepared.filter((p) => p.prep.mark > 0).length;
  const cm = clusterMeans(prepared.map((p) => (p.prep.mark > 0 ? 1 : 0)), prepared.map((p) => p.bucket));
  const t = se(cm) > 0 ? mean(cm) / se(cm) : 0;
  console.log(`  hold ${String(holdMin + "m").padStart(4)}: forward-return win rate ${(wins / prepared.length * 100).toFixed(1)}%  of ${prepared.length} trades, ${cm.length} clusters, cluster t ${t.toFixed(2)}`);
}
console.log();

// ═══════════════════════════════════════════════════════════════════
// 5. THE SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log("═══ 5. THE SUMMARY ═══");
const withBar = rowsOut.filter((r) => r.clusters >= 30);
console.log(`  geometries with >= 30 independent clusters: ${withBar.length}`);
const withBarPos = withBar.filter((r) => r.ev > 0);
console.log(`  ...with a positive expectancy: ${withBarPos.length}`);
const withBarAll = withBarPos.filter((r) => r.excess > 0 && r.t >= 2);
console.log(`  ...with a positive excess over the control AND t >= 2: ${withBarAll.length}`);
const withBarAllTime = withBarAll.filter((r) => r.evTime > 0);
console.log(`  ...AND with the unselected time-exit subset paying too: ${withBarAllTime.length}`);
console.log();
if (withBarAllTime.length) {
  for (const r of withBarAllTime.slice(0, 10)) {
    console.log(`    TP ${r.tp}% SL ${r.sl}% hold ${r.hold}m: EV ${r.ev.toFixed(4)}%  excess ${r.excess.toFixed(4)}%  t ${r.t.toFixed(2)}  clusters ${r.clusters}`);
  }
} else {
  console.log("  NONE clears all four: positive expectancy, positive excess over the");
  console.log("  unconditional control, t >= 2 on cluster means, >= 30 clusters, AND the");
  console.log("  unselected time-exit subset paying.");
}
