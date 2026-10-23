#!/usr/bin/env node
/**
 * THE FINAL VERDICT — the best candidate, examined to death.
 *
 * The best candidate that has BOTH a positive expectancy AND a reachable
 * stop (the stop fires on >= 5% of trades) at a horizon with the most
 * clusters is:
 *
 *     TP 1.5% / STOP 1.0% / 120 minutes
 *     11W 6L 92 time exits, win 64.7%, EV +0.1086% of notional
 *
 * This script puts it through every test the bar asks for, plus the ones
 * the bar does not ask for but which decide whether it is real:
 *
 *   - the excess over the unconditional same-direction control
 *   - the cluster t-statistic (one mean per 5-minute bucket)
 *   - the trim test (best 3 and worst 3 dropped)
 *   - the time split (does the sign survive the second half?)
 *   - the reverse arm (is it beta?)
 *   - the decomposition (is the edge in the selected or the unselected
 *     subset?)
 *   - the cluster count
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
const be = (tp, sl, f) => (sl + f) / (tp + sl);

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
function arm(set, hold, tp, sl, flip = false) {
  const trades = [];
  for (const o of set) {
    const p = prepare(o, hold);
    if (!p) continue;
    const long = flip ? !p.long : p.long;
    const q = { ...p, long };
    const kind = resolve(q, tp, sl);
    // `p.mark` is ALREADY the mark in the trade's own direction (it is
    // (close-entry)/entry for a long and (entry-close)/entry for a short),
    // so a FLIPPED trade negates it and an unflipped one does not.
    const mark = flip ? -p.mark : p.mark;
    const pnl = kind === "win" ? tp - TAKER_RT : kind === "loss" ? -sl - TAKER_RT : mark - TAKER_RT;
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
  return {
    n: trades.length, w, l, t: trades.filter((x) => x.kind === "time").length,
    winRate: res ? w / res : 0,
    ev: mean(pnl), evSe: se(pnl),
    evResolved: mean(trades.filter((x) => x.kind !== "time").map((x) => x.pnl)),
    evTime: mean(trades.filter((x) => x.kind === "time").map((x) => x.pnl)),
    clusters: cm.length, clusterMean: mean(cm), clusterSe: se(cm),
    pnl, trades,
  };
}

const HOLD = Number(process.argv[2] ?? 120);
const TP = Number(process.argv[3] ?? 1.5);
const SL = Number(process.argv[4] ?? 1.0);
console.log(`═══ THE CANDIDATE: TP ${TP}% / STOP ${SL}% / ${HOLD} minutes ═══\n`);
const sig = stat(arm(SIGNAL, HOLD, TP, SL));
const ctl = stat(arm(CONTROL, HOLD, TP, SL));
const rev = stat(arm(SIGNAL, HOLD, TP, SL, true));
const crev = stat(arm(CONTROL, HOLD, TP, SL, true));

console.log(`  observed win rate       ${(sig.winRate * 100).toFixed(2)}%  (${sig.w}W ${sig.l}L ${sig.t} time exits of ${sig.n})`);
console.log(`  break-even win rate     ${(be(TP, SL, TAKER_RT) * 100).toFixed(2)}%`);
console.log(`  net expectancy/trade    ${(sig.ev >= 0 ? "+" : "") + sig.ev.toFixed(4)}% of notional`);
console.log(`  the control (no filter) ${(ctl.ev >= 0 ? "+" : "") + ctl.ev.toFixed(4)}%  (win ${(ctl.winRate * 100).toFixed(2)}%, ${ctl.clusters} clusters)`);
const d = sig.clusterMean - ctl.clusterMean;
const sd = Math.sqrt(sig.clusterSe ** 2 + ctl.clusterSe ** 2);
const t = sd > 0 ? d / sd : 0;
console.log(`  EXCESS over the control ${(d >= 0 ? "+" : "") + d.toFixed(4)}%   cluster t = ${t.toFixed(2)}`);
console.log(`  independent clusters    ${sig.clusters}   (the bar needs >= 30)`);

// The trim test.
const sorted = [...sig.pnl].sort((a, b) => a - b);
const tw = mean(sorted.slice(3)) - ctl.ev;
const tb = mean(sorted.slice(0, sorted.length - 3)) - ctl.ev;
console.log(`  trim (worst 3 dropped)  ${(tw >= 0 ? "+" : "") + tw.toFixed(4)}%`);
console.log(`  trim (best 3 dropped)   ${(tb >= 0 ? "+" : "") + tb.toFixed(4)}%`);

// The time split.
const first = sig.trades.filter((t) => t.first), second = sig.trades.filter((t) => !t.first);
const cfirst = ctl.trades.filter((t) => t.first), csecond = ctl.trades.filter((t) => !t.first);
console.log(`  FIRST half:  signal ${first.length} EV ${mean(first.map((t) => t.pnl)).toFixed(4)}%  control ${cfirst.length} EV ${mean(cfirst.map((t) => t.pnl)).toFixed(4)}%  excess ${(mean(first.map((t) => t.pnl)) - mean(cfirst.map((t) => t.pnl))).toFixed(4)}%`);
console.log(`  SECOND half: signal ${second.length} EV ${mean(second.map((t) => t.pnl)).toFixed(4)}%  control ${csecond.length} EV ${mean(csecond.map((t) => t.pnl)).toFixed(4)}%  excess ${(mean(second.map((t) => t.pnl)) - mean(csecond.map((t) => t.pnl))).toFixed(4)}%`);

// The decomposition.
console.log(`  resolved subset (SELECTED)  ${sig.w + sig.l} trades, EV ${(sig.evResolved >= 0 ? "+" : "") + sig.evResolved.toFixed(4)}%`);
console.log(`  time-exit subset (UNSELECTED) ${sig.t} trades, EV ${(sig.evTime >= 0 ? "+" : "") + sig.evTime.toFixed(4)}%`);

// The beta check.
console.log(`  REVERSE arm  ${(rev.ev >= 0 ? "+" : "") + rev.ev.toFixed(4)}%  (win ${(rev.winRate * 100).toFixed(1)}%)`);
console.log(`  CTRL-REV arm ${(crev.ev >= 0 ? "+" : "") + crev.ev.toFixed(4)}%  (win ${(crev.winRate * 100).toFixed(1)}%)`);

console.log();
const bar = [
  ["net expectancy > 0", sig.ev > 0],
  ["excess over the control > 0", d > 0],
  ["cluster t >= 2", t >= 2],
  [">= 30 independent clusters", sig.clusters >= 30],
  ["trim-stable (both trims keep the excess positive)", tw > 0 && tb > 0],
  ["the unselected (time-exit) subset also pays", sig.evTime > 0],
  ["the sign survives the time split", second.length === 0 || (mean(first.map((t) => t.pnl)) > 0 && mean(second.map((t) => t.pnl)) > 0)],
  ["the reverse arm does not also pay", rev.ev <= 0],
];
console.log("  THE BAR, item by item:");
for (const [label, pass] of bar) console.log(`    ${pass ? "PASS" : "FAIL"}  ${label}`);
console.log();
console.log(`  VERDICT: ${bar.every(([, p]) => p) ? "CLEARS" : "does NOT clear"}`);
