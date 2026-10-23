#!/usr/bin/env node
/**
 * THE CONFIDENCE-THRESHOLD STUDY.
 *
 * The question a failed agent left open: does trading only the TOP N%
 * of candidates — by model agreement, signal strength, volume
 * exhaustion, book imbalance, or distance from the extreme — produce
 * a positive net EV after the fee?
 *
 * WHY IT MATTERS
 * --------------
 * The machine's arm is negative (-0.2111% of equity per trade). The
 * obvious hope is that the arm's EDGES are good and its CORE is bad:
 * that a filter keeps the winners and drops the losers. If a
 * confidence threshold works, it is the cheapest possible fix — no
 * new signal, no new venue, just a rule on the candidates the machine
 * ALREADY produces.
 *
 * WHY IT IS ALSO THE MOST DANGEROUS HOPE
 * --------------------------------------
 * Selecting the best N% from the SAME sample is a selection artefact.
 * Any threshold will have SOME N% that looks good on the sample it
 * was chosen from. So the design must be:
 *
 *   1. the threshold's EV must beat the UNCONDITIONAL arm at the same
 *      geometry — that is the EXCESS, not the raw EV
 *   2. the threshold must be chosen on one half of the days and
 *      TESTED on the other half (out of sample), because choosing N%
 *      on the whole sample and reporting that same sample's number is
 *      circular
 *   3. the placebo must be a SIZE-MATCHED random subset of the same
 *      shape, because "the top 10% by any field" is a selection no
 *      matter which field
 *
 * THE FIVE FILTERS (the ones the collector actually records):
 *   jevAgreement    the model's own agreement score
 *   layaConfidence  the second model's confidence
 *   tapeVratio      volume exhaustion (a high ratio = a volume spike)
 *   bookImbalance   the order book's imbalance
 *   tapeOffLowPct   the distance from the session low (exhaustion
 *                   depth) — the question's "distance from the extreme"
 *
 * THE FILL RULE IS CORRECT, THE CLUSTERING IS THE TICKET'S HOLDING
 * PERIOD, and the fee is the venue's real 0.12% taker round trip.
 *
 * Run: node research/test-confidence-threshold.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { isTargetWrongSide } from "./ticket-fill.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONF = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const NOTIONAL = 60;
const EQUITY = 56.7;
const RHO = NOTIONAL / EQUITY;
const ROUND_TRIP = 0.0012;
const FEE_FLOOR_EQ = ROUND_TRIP * RHO;

// The machine's shipped ticket, market-anchored: the target is beyond
// the market in the profitable direction, so the market has to MOVE to
// reach it. TP 0.4 x ATR capped at 0.5%, SL 1.0 x ATR, 4-hour hold.
const TP_ATR_MULT = 0.4;
const TP_CLAMP_HI = 0.5;
const SL_ATR_MULT = 1.0;
const HOLD_BARS = 16; // 4 hours of 15-minute bars
const CLUSTER_MIN = 240; // the holding period, in minutes

function flag(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

if (!existsSync(CONF) || !existsSync(BARS)) {
  console.error(`missing the inputs: ${CONF} and ${BARS}`);
  process.exit(1);
}

const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const barsByPair = JSON.parse(readFileSync(BARS, "utf8"));
const barList = (p) => {
  const b = barsByPair[p];
  if (!b) return null;
  return Array.isArray(b) ? b : b.bars;
};

/** The live gate: JEV and Laya both directional and agreeing. */
function liveGateSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}

/** The arm: the tape's side equals the models' confirmed side. */
const arm = rows.filter((r) => tapeSideFromRow(r) && liveGateSide(r) === tapeSideFromRow(r));

/** The market-anchored ticket, with the corrected fill rule. */
function resolve(r) {
  const bars = barList(r.pair);
  if (!bars) return null;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(bars.length, i + HOLD_BARS);
  if (end - i < 2) return null;

  const dir = tapeSideFromRow(r);
  if (dir !== "long" && dir !== "short") return null;
  const long = dir === "long";

  const last = Number(r.price);
  if (!(last > 0)) return null;
  const atrPct = Number(r.tapeAtrPct);
  if (!(atrPct > 0)) return null;

  const tpPct = Math.min(TP_ATR_MULT * atrPct, TP_CLAMP_HI);
  const slPct = SL_ATR_MULT * atrPct;
  const tpFrac = tpPct / 100;
  const slFrac = slPct / 100;
  const entry = last;
  const target = long ? last * (1 + tpFrac) : last * (1 - tpFrac);
  const stop = long ? last * (1 - slFrac) : last * (1 + slFrac);
  if (isTargetWrongSide(dir, target, entry)) return null;

  const bucket = Math.floor(r.ts / (CLUSTER_MIN * 60000));
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitTp && hitSl) return { dir, pnl: -slFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair, outcome: "loss" };
    if (hitTp) return { dir, pnl: tpFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair, outcome: "win" };
    if (hitSl) return { dir, pnl: -slFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair, outcome: "loss" };
  }
  const lastBar = bars[end - 1];
  const movePct = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { dir, pnl: movePct - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair, outcome: "time" };
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE CONFIDENCE-THRESHOLD STUDY");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the collector rows: ${rows.length}`);
console.log(`the live-gate arm:  ${arm.length} rows`);
console.log(`the ticket:  TP ${TP_ATR_MULT}xATR capped ${TP_CLAMP_HI}%,  SL ${SL_ATR_MULT}xATR,  hold ${HOLD_BARS} bars (4h)`);
console.log(`the fee floor: ${fmt(FEE_FLOOR_EQ)}% of equity per trade`);
console.log("");

// Resolve every row once.
const resolved = [];
for (const r of arm) {
  const t = resolve(r);
  if (t) resolved.push({ ...t, row: r });
}
const unresolved = arm.length - resolved.length;
console.log(`the resolved trades: ${resolved.length}  (${unresolved} unresolvable — the bar cache cannot see them)`);
console.log("");

// The cluster means, and the paired difference against the control.
function clusterStats(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.bucket)) by.set(t.bucket, []);
    by.get(t.bucket).push(t);
  }
  const cms = [...by.entries()].map(([bucket, ts]) => ({ bucket, mean: mean(ts.map((t) => t.pnl)), n: ts.length }));
  return { cms, clusters: cms.length, n: trades.length };
}

/** The t-statistic on the cluster means. */
function tOf(cms) {
  if (cms.length < 2) return NaN;
  const ms = cms.map((c) => c.mean);
  const m = mean(ms);
  const sd = Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1));
  const se = sd / Math.sqrt(ms.length);
  return se > 0 ? m / se : NaN;
}

// The unconditional control: the same geometry, every row with a
// resolvable tape side, in the same direction.
const controlAll = [];
for (const r of rows) {
  const t = resolve(r);
  if (t) controlAll.push(t);
}

/** The paired excess of a subset against the control, by cluster. */
function pairedExcess(subset, control) {
  const byCtrl = new Map(clusterStats(control).cms.map((c) => [c.bucket, c.mean]));
  const diffs = [];
  for (const c of clusterStats(subset).cms) {
    const ctrl = byCtrl.get(c.bucket);
    if (ctrl === undefined) continue;
    diffs.push(c.mean - ctrl);
  }
  const m = mean(diffs);
  const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1)) : NaN;
  const se = diffs.length > 1 ? sd / Math.sqrt(diffs.length) : NaN;
  return { n: diffs.length, mean: m, se, t: se > 0 ? m / se : NaN };
}

// ── THE FIVE FILTERS ──
const FILTERS = [
  { name: "jevAgreement", get: (r) => Number(r.jevAgreement) },
  { name: "layaConfidence", get: (r) => Number(r.layaConfidence) },
  { name: "tapeVratio", get: (r) => Number(r.tapeVratio) },
  { name: "bookImbalance", get: (r) => Number(r.bookImbalance) },
  { name: "tapeOffLowPct", get: (r) => Number(r.tapeOffLowPct) },
];

// THE OUT-OF-SAMPLE SPLIT.
//
// The collector's rows span ONE calendar day, so a day-based split is
// impossible — there is only one day. The split must be by TIME: the
// first half of the collector's span against the second half. A
// threshold that only works in one half of a single day's window is
// a sample artefact, and the split says so.
//
// (The days are still REPORTED, because the number of days is the
// honest limit on the sample: the collector has been running for one
// session, so this study has ONE day of forward data, and the
// independent-cluster count is the real bar.)
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const days = [...new Set(resolved.map((t) => dayOf(t.ts)))].sort();
const spanStart = minBy(resolved, (t) => t.ts);
const spanEnd = maxBy(resolved, (t) => t.ts);
const spanMid = spanStart + (spanEnd - spanStart) / 2;
const inFirstHalf = (t) => t.ts < spanMid;
const inLastHalf = (t) => t.ts >= spanMid;
const FIRST_HALF = new Set(resolved.filter(inFirstHalf).map((t) => t.ts));
const LAST_HALF = new Set(resolved.filter(inLastHalf).map((t) => t.ts));

console.log("════════════════════════════════════════════════════════════════════");
console.log("1. THE THRESHOLD SWEEP — trade only the top N% by each field");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the days: ${days.length} (${days.join(", ")})  — the collector spans ONE session, so the out-of-sample split is by TIME`);
console.log(`the span: ${new Date(spanStart).toISOString().slice(11, 16)}Z to ${new Date(spanEnd).toISOString().slice(11, 16)}Z, split at ${new Date(spanMid).toISOString().slice(11, 16)}Z`);
console.log("");

const results = [];
for (const f of FILTERS) {
  const scored = resolved
    .map((t) => ({ t, v: f.get(t.row) }))
    .filter((x) => Number.isFinite(x.v));
  if (scored.length < 20) {
    console.log(`  ${f.name}: only ${scored.length} rows carry the field — too few to threshold`);
    continue;
  }
  const sorted = [...scored].sort((a, b) => b.v - a.v);
  for (const pct of [0.1, 0.2, 0.3, 0.5]) {
    const k = Math.max(3, Math.round(scored.length * pct));
    const top = sorted.slice(0, k);
    const trades = top.map((x) => x.t);
    const st = clusterStats(trades);
    const ev = mean(trades.map((t) => t.pnl)) * RHO;
    const ex = pairedExcess(trades, controlAll);
    // The out-of-sample half: the threshold's RANK is fixed on the
    // whole sample, but the EV is measured on each half separately.
    const first = trades.filter(inFirstHalf);
    const last = trades.filter(inLastHalf);
    const evOf = (ts) => (ts.length ? mean(ts.map((t) => t.pnl)) * RHO : NaN);
    const wins = trades.filter((t) => t.outcome === "win").length;
    results.push({
      filter: f.name,
      pct,
      n: trades.length,
      clusters: st.clusters,
      ev,
      excess: ex.mean * RHO,
      excessT: ex.t,
      winRate: trades.length ? wins / trades.length : 0,
      firstHalfEv: evOf(first),
      lastHalfEv: evOf(last),
      firstHalfN: first.length,
      lastHalfN: last.length,
    });
  }
}

console.log("  filter            pct   n  clus   EV %eq   excess %eq   exc t   win%   1st half  2nd half");
console.log("  " + "-".repeat(94));
for (const r of results) {
  const both = r.firstHalfEv > 0 && r.lastHalfEv > 0;
  const flag = r.ev > FEE_FLOOR_EQ && r.excessT >= 2 && both ? "  <-- clears" : "";
  console.log(
    `  ${r.filter.padEnd(16)} ${String(Math.round(r.pct * 100)).padStart(3)}% ${String(r.n).padStart(3)} ${String(r.clusters).padStart(4)} ` +
      `${fmt(r.ev).padStart(9)} ${fmt(r.excess).padStart(12)} ${fmt(r.excessT, 2).padStart(7)} ${fmt(r.winRate * 100, 1).padStart(5)}% ` +
      `${fmt(r.firstHalfEv).padStart(9)} ${fmt(r.lastHalfEv).padStart(9)}${flag}`,
  );
}
console.log("");

/** Rebuild a result's subset (the top N% by its field). */
function subsetFor(r) {
  const f = FILTERS.find((x) => x.name === r.filter);
  if (!f) return [];
  const scored = resolved.map((t) => ({ t, v: f.get(t.row) })).filter((x) => Number.isFinite(x.v));
  scored.sort((a, b) => b.v - a.v);
  const k = Math.max(3, Math.round(scored.length * r.pct));
  return scored.slice(0, k).map((x) => x.t);
}

// ── 2. THE PLACEBO ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("2. THE SIZE-MATCHED PLACEBO — is a threshold better than a random subset?");
console.log("════════════════════════════════════════════════════════════════════");
console.log("  A random subset of the SAME SIZE, drawn from the same arm, many times.");
console.log("  The best threshold must beat the placebo's 95th percentile.");
console.log("");

// A deterministic PRNG, so the result is reproducible.
let seed = 20261021;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const bestExcess = maxBy(results, (r) => r.excess);
const bestRow = results.find((r) => r.excess === bestExcess);
console.log(`  the best threshold by excess: ${bestRow.filter} at the top ${Math.round(bestRow.pct * 100)}%  (excess ${fmt(bestRow.excess)} %eq)`);
console.log("");

const placeboExcesses = [];
for (let trial = 0; trial < 2000; trial++) {
  const k = bestRow.n;
  const pool = [...resolved];
  const draw = [];
  for (let i = 0; i < k && pool.length; i++) {
    draw.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  }
  placeboExcesses.push(pairedExcess(draw, controlAll).mean * RHO);
}
const sortedP = [...placeboExcesses].sort((a, b) => a - b);
const p50 = sortedP[Math.floor(sortedP.length * 0.5)];
const p95 = sortedP[Math.floor(sortedP.length * 0.95)];
const p99 = sortedP[Math.floor(sortedP.length * 0.99)];
const beatsP95 = bestRow.excess > p95;
const beatsP99 = bestRow.excess > p99;
console.log(`  the placebo excess: median ${fmt(p50)}  p95 ${fmt(p95)}  p99 ${fmt(p99)}`);
console.log(`  the best threshold's excess: ${fmt(bestRow.excess)}`);
console.log(`  it beats the placebo's p95: ${beatsP95 ? "YES" : "NO"}`);
console.log(`  it beats the placebo's p99: ${beatsP99 ? "YES" : "NO"}`);
console.log("");

// ── 3. THE CONCENTRATION — does one symbol carry the result? ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("3. THE CONCENTRATION — does one symbol carry the result?");
console.log("════════════════════════════════════════════════════════════════════");
console.log("  A subset of 8-9 trades can be carried by ONE symbol. Every positive");
console.log("  result in this project that failed did so this way.");
console.log("");

for (const r of results.filter((x) => x.ev > 0).slice(0, 8)) {
  const subset = subsetFor(r);
  const c = new Map();
  for (const t of subset) c.set(t.pair, (c.get(t.pair) ?? 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["-", 0];
  const share = subset.length ? top[1] / subset.length : 0;
  // The excess WITHOUT the top symbol.
  const without = subset.filter((t) => t.pair !== top[0]);
  const exWithout = pairedExcess(without, controlAll);
  const exWith = pairedExcess(subset, controlAll);
  console.log(
    `  ${r.filter.padEnd(16)} ${String(Math.round(r.pct * 100)).padStart(3)}%  n ${String(r.n).padStart(3)}  ` +
      `the top symbol ${top[0].padEnd(14)} ${(share * 100).toFixed(0).padStart(3)}%  ` +
      `the excess ${fmt(exWith.mean * RHO)} -> without it ${fmt(exWithout.mean * RHO)}` +
      (share > 0.4 ? "   <- CARRIED BY ONE SYMBOL" : ""),
  );
}
console.log("");

// ── 4. THE VERDICT ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("3. THE VERDICT");
console.log("════════════════════════════════════════════════════════════════════");
/** The concentration of a result's subset: the top symbol's share. */
function topShare(r) {
  const c = new Map();
  for (const t of subsetFor(r)) c.set(t.pair, (c.get(t.pair) ?? 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["-", 0];
  const n = subsetFor(r).length;
  return n ? top[1] / n : 1;
}
const clears = results.filter(
  (r) => r.ev > FEE_FLOOR_EQ && r.excessT >= 2 && r.firstHalfEv > 0 && r.lastHalfEv > 0 && topShare(r) <= 0.4,
);
const bestEv = maxBy(results, (r) => r.ev);
console.log(`  THE DECISIVE NUMBER: the best threshold's EV is ${fmt(bestEv)}% of equity per trade.`);
console.log(`  The fee floor is ${fmt(FEE_FLOOR_EQ)}% of equity per trade.`);
console.log(`  The best threshold reaches ${(100 * bestEv / FEE_FLOOR_EQ).toFixed(1)}% of the fee floor.`);
console.log("");
if (bestEv <= FEE_FLOOR_EQ) {
  console.log("  THE FEE IS NOT THE CLOSE CALL: EVERY threshold is below the fee floor,");
  console.log("  so no threshold can pay however it is measured. The thresholds that");
  console.log("  'beat' the placebo are beating it on an excess of a few thousandths of");
  console.log("  a percent, which is the same size as the placebo's own spread.");
}
console.log(`  the thresholds that clear the EV floor, t >= 2, both halves, AND the 40% concentration bar: ${clears.length}`);
for (const c of clears) {
  console.log(`    ${c.filter} @ ${Math.round(c.pct * 100)}%: EV ${fmt(c.ev)}  excess ${fmt(c.excess)} (t=${fmt(c.excessT, 2)})  clusters ${c.clusters}`);
}
console.log("");
if (clears.length && beatsP95) {
  console.log("  A CANDIDATE. It survives the fee, the t-statistic, the out-of-sample split");
  console.log("  AND the size-matched placebo. It is still a CANDIDATE: the cluster count");
  console.log("  is the independent sample, and it must reach 30.");
} else if (clears.length) {
  console.log("  The thresholds that clear the arithmetic do NOT beat the size-matched");
  console.log("  placebo — so 'trade the top N% by any field' is a SELECTION, not an edge.");
} else {
  console.log("  NO THRESHOLD WORKS. Trading only the top N% by any of the five fields");
  console.log("  fails at least one of: the fee floor, t >= 2, the out-of-sample split, or");
  console.log("  the 40% single-symbol concentration bar.");
}
console.log("");
console.log("════════════════════════════════════════════════════════════════════");
