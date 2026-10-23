#!/usr/bin/env node
/**
 * THE LAST CHECKS — the two things that decide whether ANY geometry clears.
 *
 *   1. THE FORWARD DRIFT, MEASURED DIRECTLY on both arms. The signal
 *      arm's forward mark and the control's forward mark, in each half
 *      of the collector's window. If the control (every tape-short row,
 *      no model filter) has the SAME forward mark as the signal arm,
 *      then the signal adds nothing and any positive expectancy is the
 *      market's drift.
 *
 *   2. IS THE STOP EVEN REACHABLE? A geometry with 76W 0L has not found
 *      an edge — it has found a stop the price cannot reach inside the
 *      hold window. The loss side of the ticket is then priced by the
 *      TIME EXIT, not by the stop, and the "win rate" is just the
 *      probability of reaching the target. This counts, for every
 *      geometry, how often the stop is touched at all.
 *
 * READ-ONLY.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "geom-hero-bars.json"), "utf8"));
const SNAPSHOT = join(SCRATCH, "geom-hero-snapshot.ndjson");
const TAKER_RT = 0.12;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};
const clusterMeans = (v, b) => {
  const by = new Map();
  for (let i = 0; i < v.length; i++) { const a = by.get(b[i] ?? i) ?? []; a.push(v[i]); by.set(b[i] ?? i, a); }
  return [...by.values()].map(mean);
};

const rows = readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const modelSide = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return j && l ? (j === l ? j : null) : (j || l);
};
const SIGNAL = rows.map((r) => ({ ...r, tape: tapeSideFromRow(r), model: modelSide(r) })).filter((r) => r.tape && r.model && r.model === r.tape);
const CONTROL = rows.map((r) => ({ ...r, tape: tapeSideFromRow(r) })).filter((r) => r.tape && r.tape === "short");
const tsAll = SIGNAL.map((r) => r.ts).sort((a, b) => a - b);
const MID = tsAll[Math.floor(tsAll.length / 2)];

function prepare(o, holdMin) {
  const bars = CACHE[o.pair];
  if (!bars?.length) return null;
  const entry = Number(o.price);
  if (!(entry > 0)) return null;
  const nBars = Math.round(holdMin / 5);
  const start = bars.findIndex((b) => b.t > o.ts);
  if (start < 0) return null;
  const end = start + nBars;
  if (end > bars.length) return null;
  const win = bars.slice(start, end);
  const runMax = [], runMin = [];
  let mx = -Infinity, mn = Infinity;
  for (const b of win) { mx = Math.max(mx, b.h); mn = Math.min(mn, b.l); runMax.push(mx); runMin.push(mn); }
  const close = win[win.length - 1].c;
  const long = o.dir === "long";
  return { entry, long, runMax, runMin, mark: (long ? (close - entry) / entry : (entry - close) / entry) * 100, ts: o.ts };
}
/** The pure forward mark of an observation: no target, no stop, no fee. */
function marks(set, hold) {
  const out = [];
  for (const o of set) {
    const p = prepare(o, hold);
    if (!p) continue;
    out.push({ mark: p.mark, bucket: Math.floor(o.ts / 300000), ts: o.ts, first: o.ts < MID });
  }
  return out;
}
function resolve(prep, tp, sl) {
  const T = prep.long ? prep.entry * (1 + tp / 100) : prep.entry * (1 - tp / 100);
  const S = prep.long ? prep.entry * (1 - sl / 100) : prep.entry * (1 + sl / 100);
  for (let i = 0; i < prep.runMax.length; i++) {
    const hT = prep.long ? prep.runMax[i] >= T : prep.runMin[i] <= T;
    const hS = prep.long ? prep.runMin[i] <= S : prep.runMax[i] >= S;
    if (hT && hS) return "loss";
    if (hT) return "win";
    if (hS) return "loss";
  }
  return "time";
}
function arm(set, hold, tp, sl) {
  const trades = [];
  for (const o of set) {
    const p = prepare(o, hold);
    if (!p) continue;
    const kind = resolve(p, tp, sl);
    const pnl = kind === "win" ? tp - TAKER_RT : kind === "loss" ? -sl - TAKER_RT : p.mark - TAKER_RT;
    trades.push({ kind, pnl, bucket: Math.floor(o.ts / 300000), ts: o.ts, first: o.ts < MID });
  }
  return trades;
}
function stat(trades) {
  const w = trades.filter((t) => t.kind === "win").length;
  const l = trades.filter((t) => t.kind === "loss").length;
  const res = w + l;
  const pnl = trades.map((t) => t.pnl);
  const cm = clusterMeans(pnl, trades.map((t) => t.bucket));
  return { n: trades.length, w, l, t: trades.filter((x) => x.kind === "time").length, winRate: res ? w / res : 0, ev: mean(pnl), clusters: cm.length, clusterMean: mean(cm), clusterSe: se(cm), pnl };
}

console.log("═══ 1. THE FORWARD DRIFT, MEASURED DIRECTLY ON BOTH ARMS ═══");
console.log("  The forward mark is the raw price move over the horizon, no target, no");
console.log("  stop, no fee. The CONTROL is every tape-short row with NO model filter.");
console.log();
console.log("   hold     signal: 1st half   2nd half      all   |  control: 1st half   2nd half      all   |  EXCESS(all)");
for (const hold of [15, 30, 60, 120]) {
  const s = marks(SIGNAL, hold), c = marks(CONTROL, hold);
  if (!s.length || !c.length) continue;
  const sf = s.filter((x) => x.first), ss = s.filter((x) => !x.first);
  const cf = c.filter((x) => x.first), cs = c.filter((x) => !x.first);
  const sAll = mean(s.map((x) => x.mark)), cAll = mean(c.map((x) => x.mark));
  console.log(
    `  ${String(hold + "m").padStart(5)}  ${(mean(sf.map((x) => x.mark)) >= 0 ? "+" : "") + mean(sf.map((x) => x.mark)).toFixed(3)}% (${sf.length}) ${(mean(ss.map((x) => x.mark)) >= 0 ? "+" : "") + mean(ss.map((x) => x.mark)).toFixed(3)}% (${ss.length}) ${(sAll >= 0 ? "+" : "") + sAll.toFixed(3)}%  |  ${(mean(cf.map((x) => x.mark)) >= 0 ? "+" : "") + mean(cf.map((x) => x.mark)).toFixed(3)}% (${cf.length}) ${(mean(cs.map((x) => x.mark)) >= 0 ? "+" : "") + mean(cs.map((x) => x.mark)).toFixed(3)}% (${cs.length}) ${(cAll >= 0 ? "+" : "") + cAll.toFixed(3)}%  |  ${(sAll - cAll >= 0 ? "+" : "") + (sAll - cAll).toFixed(3)}pp`,
  );
}
console.log();

console.log("═══ 2. IS THE STOP EVEN REACHABLE? ═══");
console.log("  A geometry with 76W 0L has not found an edge: it has found a stop the");
console.log("  price cannot reach inside the hold. The loss side is then priced by the");
console.log("  TIME EXIT, and the 'win rate' is just P(reaching the target).");
console.log();
console.log("   hold   TP%   SL%   n   W    L    time   stop touched   win%   EV%");
for (const [hold, tp, sl] of [[120, 0.45, 1.4], [120, 0.45, 1.2], [120, 1.5, 0.9], [60, 0.45, 1.2], [60, 0.35, 1.1], [30, 1.5, 1.2], [15, 1.5, 1.2]]) {
  const s = arm(SIGNAL, hold, tp, sl);
  if (!s.length) continue;
  const st = stat(s);
  console.log(
    `  ${String(hold + "m").padStart(5)} ${String(tp).padStart(5)} ${String(sl).padStart(5)} ${String(st.n).padStart(4)} ${String(st.w).padStart(4)} ${String(st.l).padStart(4)} ${String(st.t).padStart(7)} ${String(((st.l / st.n) * 100).toFixed(1) + "%").padStart(12)}   ${(st.winRate * 100).toFixed(1).padStart(5)} ${(st.ev >= 0 ? "+" : "") + st.ev.toFixed(4)}`,
  );
}
console.log();

console.log("═══ 3. THE SAME, FOR EVERY GEOMETRY: does ANY of them lose? ═══");
console.log("  For a geometry to be TRADEABLE, the stop has to be reachable: a stop");
console.log("  that never triggers is not a stop, it is a wider time exit.");
console.log();
const grid = [];
for (const hold of [15, 30, 60, 120]) {
  for (const tp of [0.3, 0.45, 0.6, 0.9, 1.2, 1.5]) {
    for (const sl of [0.4, 0.6, 0.8, 1.0, 1.2, 1.4]) {
      const s = arm(SIGNAL, hold, tp, sl);
      if (!s.length) continue;
      const st = stat(s);
      grid.push({ hold, tp, sl, n: st.n, w: st.w, l: st.l, t: st.t, winRate: st.winRate, ev: st.ev, clusters: st.clusters });
    }
  }
}
const reachable = grid.filter((g) => g.l / g.n >= 0.05);   // the stop fires on >= 5% of trades
console.log(`  geometries where the stop fires on >= 5% of trades: ${reachable.length} of ${grid.length}`);
console.log();
console.log("   hold   TP%   SL%    n   W    L   time   win%     EV%   clusters");
for (const g of reachable.sort((a, b) => b.ev - a.ev).slice(0, 20)) {
  console.log(`  ${String(g.hold + "m").padStart(5)} ${String(g.tp).padStart(5)} ${String(g.sl).padStart(5)} ${String(g.n).padStart(4)} ${String(g.w).padStart(4)} ${String(g.l).padStart(4)} ${String(g.t).padStart(6)} ${(g.winRate * 100).toFixed(1).padStart(6)} ${(g.ev >= 0 ? "+" : "") + g.ev.toFixed(4)} ${String(g.clusters).padStart(8)}`);
}
console.log();
const reachPos = reachable.filter((g) => g.ev > 0);
console.log(`  of the geometries whose stop is REACHABLE, ${reachPos.length} have a positive expectancy.`);
for (const g of reachPos.slice(0, 10)) {
  console.log(`    TP ${g.tp}% SL ${g.sl}% hold ${g.hold}m: ${g.w}W ${g.l}L ${g.t} time, win ${(g.winRate * 100).toFixed(1)}%, EV ${g.ev.toFixed(4)}%, clusters ${g.clusters}`);
}
