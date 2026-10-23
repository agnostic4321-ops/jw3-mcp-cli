// THE POWER ANALYSIS FOR THE ARM UNDER EVALUATION.
//
// The task this replaces was dispatched to a subagent and failed with a
// connection error after 37 minutes. Its harness survives in the
// scratch directory, and one thing about it is important: it
// CLUSTERED AT 5-MINUTE BUCKETS (BUCKET_MS = 5 * 60_000), which is
// the collector's cadence, not the ticket's holding period. So its
// "38 signal buckets" are NOT 38 independent clusters — they are 38
// five-minute slices of a 4.4-hour span, and the ticket holds for 240
// minutes. The same width defect this project already corrected once.
//
// So this file does the power arithmetic on the arm's OWN published
// evidence, at the 240-minute width the evidence file declares, and
// it uses the CLUSTER MEANS (published alongside the count) rather
// than the aggregate standard error — because the aggregate se is the
// se of the DIFFERENCE between two arms, and the arms' variances are
// not separable from it.
//
// The machinery is a two-sided noncentral t on the cluster means with
// Welch degrees of freedom, which is the right test for a difference
// of two means with unequal variances.
//
// Run: node research/power-analysis.mjs

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EV = join(homedir(), ".hermes/cache/scratch/live-gate-ev.json");
if (!existsSync(EV)) {
  console.error("missing the evidence file — run research/live-gate-ev.mjs first");
  process.exit(1);
}
const ev = JSON.parse(readFileSync(EV, "utf8"));

// ── noncentral t ──
function lgamma(x) {
  const g = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = C[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function chi2LogPdf(v, nu) {
  const k = nu / 2;
  if (v <= 0) return -Infinity;
  return (k - 1) * Math.log(v) - v / 2 - k * Math.log(2) - lgamma(k);
}
function normCdf(x) {
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
function nctUpper(c, nu, delta, N = 8000) {
  const vMax = nu + 14 * Math.sqrt(2 * nu) + 80;
  const dv = vMax / N;
  let acc = 0;
  for (let i = 0; i <= N; i++) {
    const v = (i + 0.5) * dv;
    const lp = chi2LogPdf(v, nu);
    if (!Number.isFinite(lp)) continue;
    const Phi = normCdf(delta - c * Math.sqrt(v / nu));
    const w = (i === 0 || i === N) ? 1 : (i % 2 === 1 ? 4 : 2);
    acc += w * Math.exp(lp) * Phi;
  }
  return (acc * dv) / 3;
}
const power2 = (c, nu, delta) => nctUpper(c, nu, delta) + (1 - nctUpper(-c, nu, delta));
function tCrit(alpha, df) {
  let lo = 0, hi = 12;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (nctUpper(mid, df, 0, 4000) > alpha / 2) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function welchDf(v1, n1, v2, n2) {
  const a = v1 / n1, b = v2 / n2;
  if (n1 < 2 || n2 < 2) return Math.max(1, n1 + n2 - 2);
  return (a + b) ** 2 / ((a * a) / (n1 - 1) + (b * b) / (n2 - 1));
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const varOf = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
};
const stdev = (a) => Math.sqrt(varOf(a));

// ── THE ARM'S CLUSTER MEANS, AT THE PUBLISHED WIDTH ──
const WIDTH = ev.clusterWidthMinutes;
const lg = ev.liveGate;
const tape = ev.tapeOnly;
const A = lg.clusterMeans ?? [];
const B = tape.clusterMeans ?? [];
const nA = A.length, nB = B.length;

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE POWER ANALYSIS — the arm under evaluation, at the ticket's width");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`  the cluster width:  ${WIDTH} minutes (the ticket's holding period)`);
console.log(`  the arm:            ${lg.n} trades in ${nA} independent clusters`);
console.log(`  the tape's control: ${tape.n} trades in ${nB} independent clusters`);
// THE UNITS. The evidence file publishes the EV and the fee floor in
// PERCENT of equity (feeFloorPctEquity = ROUND_TRIP * RHO * 100), and
// the cluster means in the SAME units. So every number here is
// already a percent of equity and must NOT be scaled again.
console.log(`  the arm's cluster means: ${A.map((x) => x.toFixed(4) + "%").join(", ")}`);
console.log(`  the control's means:     ${B.map((x) => x.toFixed(4) + "%").join(", ")}`);
console.log("");

// THE OBSERVED EXCESS, on the PAIRED cluster differences.
const diffs = A.map((a, i) => a - (B[i] ?? mean(B)));
const obsMean = mean(diffs);
const obsVar = varOf(diffs);
const obsSe = nA > 1 ? stdev(diffs) / Math.sqrt(nA) : 0;
const obsT = obsSe > 0 ? obsMean / obsSe : 0;
const df = welchDf(varOf(A), nA, varOf(B), nB);
const alpha = 0.05;
const crit = tCrit(alpha, df);

console.log("── THE OBSERVED EFFECT ──");
console.log(`  the excess: ${obsMean.toFixed(4)}% of equity per trade`);
console.log(`  the se:     ${obsSe.toFixed(4)}%`);
console.log(`  the t:      ${obsT.toFixed(2)} (df ${df.toFixed(1)})`);
console.log(`  the fee floor: ${ev.feeFloorPctEquity.toFixed(4)}% of equity per trade`);
console.log("");

// THE POWER TODAY, at the effect the arm actually shows.
const deltaNow = obsSe > 0 ? Math.abs(obsMean) / obsSe : 0;  // the noncentrality at the CURRENT sample
const powerNow = power2(crit, df, deltaNow);
console.log("── THE POWER TODAY ──");
console.log(`  the power at the OBSERVED effect: ${(powerNow * 100).toFixed(1)}%`);
console.log(`  the power at the effect needed to CLEAR the fee floor:`);
const feeDelta = ev.feeFloorPctEquity / obsSe;
console.log(`    the fee floor is ${ev.feeFloorPctEquity.toFixed(4)}% of equity; the se is ${obsSe.toFixed(4)}%`);
console.log(`    so a fee-clearing effect is a noncentrality of ${feeDelta.toFixed(3)}, and the power is ${(power2(crit, df, feeDelta) * 100).toFixed(2)}%`);
console.log("");

// THE MINIMUM DETECTABLE EFFECT at the CURRENT sample.
const mde = (crit + 0.8416212336) * obsSe;
console.log("── THE MINIMUM DETECTABLE EFFECT AT THE CURRENT SAMPLE ──");
console.log(`  the MDE at 80% power: ${mde.toFixed(4)}% of equity per trade`);
console.log(`  the fee floor:        ${ev.feeFloorPctEquity.toFixed(4)}% of equity per trade`);
console.log(`  so the arm can only detect an effect ${(mde / ev.feeFloorPctEquity).toFixed(1)}x the fee floor — it is ${mde > ev.feeFloorPctEquity ? "BLIND to any fee-clearing edge" : "sensitive enough to see a fee-clearing edge"}.`);
console.log("");

// HOW MANY CLUSTERS TO DETECT THE OBSERVED EFFECT at t >= 2, and to
// detect a fee-clearing effect.
console.log("── THE CLUSTERS NEEDED ──");
// HOW MANY CLUSTERS.
//
// THE SE SCALES WITH THE CLUSTER COUNT. obsSe is the se of the mean
// at the CURRENT count (nA clusters), so the se at k clusters is
// obsSe * sqrt(nA / k) — the variance across the cluster differences
// is obsVar, and the se of the mean of k draws from it is
// sqrt(obsVar / k) = obsSe * sqrt(nA / k).
//
// (Getting this wrong is not a rounding matter: using sqrt(obsVar/k)
// against the CURRENT obsSe instead of obsVar made the se at k=4
// twice as large as the truth, which made the arm look "already
// powered" and put the clusters-needed at the sample in hand. The
// first version of this file did exactly that and printed "4 clusters
// needed, 0 days to go" for an arm with 4 clusters and a negative
// effect.)
function seAt(k) {
  return Math.sqrt(obsVar / k);
}
function clustersNeeded(targetEffect) {
  for (let k = Math.max(2, nA); k <= 100000; k++) {
    if (power2(crit, df, targetEffect / seAt(k)) >= 0.8) return k;
  }
  return null;
}
const kObs = clustersNeeded(Math.abs(obsMean));
const kFee = clustersNeeded(ev.feeFloorPctEquity);
// The clusters needed to CONFIRM the observed LOSS: the t at k
// clusters is |obsMean| / seAt(k), and it must exceed the two-sided
// critical value at that df.
function clustersToConfirmLoss() {
  for (let k = Math.max(2, nA); k <= 100000; k++) {
    const t = Math.abs(obsMean) / seAt(k);
    if (t >= tCrit(alpha, k - 1)) return k;
  }
  return null;
}
const kLoss = clustersToConfirmLoss();
console.log(`  to detect the OBSERVED effect (${Math.abs(obsMean).toFixed(4)}%) at 80% power: ${kObs ?? "never"} clusters`);
console.log(`    that is ${kObs ? kObs - nA : "n/a"} more than the ${nA} in hand`);
console.log(`  to detect a FEE-CLEARING GAIN (${ev.feeFloorPctEquity.toFixed(4)}%) at 80% power: ${kFee ?? "never"} clusters`);
console.log(`    that is ${kFee ? kFee - nA : "n/a"} more than the ${nA} in hand`);
console.log(`    (this is the arm's ability to CONFIRM a fee-clearing GAIN — it is NOT the house bar.)`);
console.log(`  to CONFIRM the observed LOSS at t <= -2: the t is ${obsT.toFixed(2)} now, and it`);
console.log(`    crosses the critical value once the count reaches ${kLoss ?? "never"} clusters.`);
console.log("");

// THE COLLECTION RATE: clusters per day, and the days to each bar.
const rows = [];
try {
  for (const l of readFileSync(join(homedir(), ".hermes/cache/scratch/confluence.ndjson"), "utf8").split("\n")) {
    if (!l) continue;
    try { const d = JSON.parse(l); if (d.ts) rows.push(d.ts); } catch {}
  }
} catch {}
rows.sort((a, b) => a - b);
const spanH = rows.length > 1 ? (rows[rows.length - 1] - rows[0]) / 3600000 : 0;
console.log("── THE COLLECTION RATE ──");
console.log(`  the collector: ${rows.length} rows over ${spanH.toFixed(2)} hours`);
console.log(`  the rows per hour: ${(rows.length / spanH).toFixed(1)}`);
console.log(`  the rows are NOT the limit. A cluster is a COMPLETE ${WIDTH}-minute window,`);
console.log(`  so the MAXIMUM rate is ${(24 / (WIDTH / 60)).toFixed(1)} clusters a day, and the`);
console.log(`  ACHIEVED rate is the ${nA} clusters over ${spanH.toFixed(2)} hours = ${(nA / spanH * 24).toFixed(2)} a day.`);
console.log(`  So the collector has been running for ${(spanH / 24).toFixed(2)} days and produced ${nA} clusters.`);
console.log("");

// THE DAYS TO EACH BAR, from the ACHIEVED cluster rate.
const clustersPerDay = spanH > 0 ? (nA / spanH) * 24 : 0;   // the ACHIEVED rate
const daysToFee = kFee ? (kFee - nA) / clustersPerDay : Infinity;
const daysToObs = kObs ? (kObs - nA) / clustersPerDay : Infinity;

// THE DECISION, IN ARITHMETIC.
const fee = ev.feeFloorPctEquity;   // the fee floor, in PERCENT of equity
const BAR = 30;   // the house bar: 30 independent clusters at the ticket's width
const daysToBar = (BAR - nA) / clustersPerDay;
console.log(`  the arm's OWN net EV: ${lg.ev.toFixed(4)}% of equity per trade`);
console.log(`  the fee floor:        ${fee.toFixed(4)}% of equity per trade`);
console.log(`  so the arm must improve by ${(fee - lg.ev).toFixed(4)} percentage points of equity per trade to pay for itself.`);
// THE DAYS TO EACH BAR, from the ACHIEVED cluster rate.
console.log(`  the power at a fee-clearing effect: ${(power2(crit, df, feeDelta) * 100).toFixed(2)}%`);
if (obsMean < 0) {
  console.log(`  the observed effect is ${obsMean < 0 ? "NEGATIVE" : "POSITIVE"} (${obsMean.toFixed(4)}%), so the study is powered to detect a ${obsMean < 0 ? "LOSS" : "GAIN"}, not the other.`);
}
console.log(`  to reach ${kObs ?? "?"} clusters (80% power at the observed effect) takes ${Number.isFinite(daysToObs) ? daysToObs.toFixed(1) + " days" : "never"} of collection.`);
console.log(`  to reach the ${BAR}-cluster house bar takes ${Number.isFinite(daysToBar) ? daysToBar.toFixed(1) + " days" : "never"} of collection.`);
console.log("");
console.log("  THE STOPPING RULE, IN ARITHMETIC:");
console.log(`    STOP when the independent ${WIDTH}-minute cluster count reaches ${BAR}, and`);
console.log("      DEPLOY only if, at that count, ALL of these hold:");
console.log(`        1. the excess over the control is POSITIVE at t >= 2`);
console.log(`        2. the arm's OWN net EV clears the ${ev.feeFloorPctEquity.toFixed(4)}% fee floor`);
console.log("        3. the excess is positive in BOTH window halves");
console.log("        4. no single symbol carries more than 40% of the excess");
console.log("        5. the direction-flipped PLACEBO does not clear the same bar");
console.log(`    Otherwise the study has answered its question: the effect is ${obsMean < 0 ? "NEGATIVE" : "too small to pay the fee"}, and the machine stays refused.`);
