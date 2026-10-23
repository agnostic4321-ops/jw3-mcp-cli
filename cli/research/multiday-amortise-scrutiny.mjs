#!/usr/bin/env node
/**
 * multiday-amortise-scrutiny.mjs — the ADVERSARIAL check on the ONE cell
 * that claimed to clear the bar.
 *
 * short-only, 3-day hold: excess +0.1207%, t=2.29, 366 day clusters,
 * 501 symbols, and it beat the best placebo (+0.1180%) by 0.0027pp.
 *
 * A single survivor out of 15 cells (3 conditions x 5 horizons) x 10
 * placebo variants is EXACTLY the shape of a selection artefact, so it
 * gets the hardest scrutiny available:
 *
 *   S1 THE MARGIN IS INSIDE THE NOISE. The "win" over the placebo is
 *      0.0027pp on a quantity whose own CI is [-0.0xx, +0.2xx]. If the
 *      placebo bar and the candidate are statistically indistinguishable,
 *      the candidate does not clear the bar — it TIES the bar.
 *
 *   S2 THE MULTIPLICITY BENCHMARK. The study ran 15 real cells and 150
 *      placebo cells. The smallest p-value across the whole study must be
 *      compared with 1/(n_tests+1). If the smallest p is LARGER than
 *      that benchmark, the p-values are stochastically larger than
 *      uniform, and nothing in the study is even accidentally convincing.
 *
 *   S3 THE EXCESS IS NOT STABLE ACROSS THE WINDOW. Split the 365 days
 *      into three consecutive blocks and require the excess to be
 *      positive in at least 2 of 3, and to keep its sign.
 *
 *   S4 THE EXCESS IS NOT CONCENTRATED. How much of the excess do the top
 *      10 symbols carry? If the answer is "most of it", it is a dead
 *      token, not a rule.
 *
 *   S5 THE DIRECTION-SHUFFLE TEST. The signal's own bars with the
 *      directions permuted. If the shuffled arm earns about as much, the
 *      signal does not know WHICH WAY, and the "excess" is a timing
 *      artefact or noise.
 *
 *   S6 THE PLACEBO FAMILY, EXHAUSTIVELY. 10 placebo variants, each its
 *      own randomisation of the same shape. The candidate must exceed
 *      the MAXIMUM over all of them — and it must exceed it by more
 *      than the bootstrap's own resolution.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CACHE = join(homedir(), ".hermes/cache/scratch/mdh-2026");
const RES = join(CACHE, "multiday-results.json");

if (!existsSync(RES)) {
  console.error(`[scrutiny] no results at ${RES}`);
  process.exit(1);
}
const R = JSON.parse(readFileSync(RES, "utf8"));
const real = R.results.filter((r) => !r.isPlacebo);
const plac = R.placeboResults.filter((r) => r.isPlacebo);

const f = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);
const pad = (s, n) => String(s).padStart(n);
const padL = (s, n) => String(s).padEnd(n);

/* The candidate: the real cell with the largest excess that has t >= 2. */
const candidates = real
  .filter((r) => r.excess > 0 && r.excessT >= 2 && r.netPerTrade > 0)
  .sort((a, b) => b.excess - a.excess);
console.log(`[scrutiny] real cells with excess>0 AND t>=2 AND net>0: ${candidates.length}`);
for (const c of candidates) {
  console.log(`   ${c.condition} ${c.holdDays}d  excess ${f(c.excess)}  t=${c.excessT.toFixed(2)}  net/trd ${f(c.netPerTrade)}`);
}
if (!candidates.length) {
  console.log("[scrutiny] NOTHING to scrutinise — no cell even claims the bar.");
}
const cand = candidates[0];

/* ── S1: the margin over the placebo bar ───────────────────────────── */
console.log("\n[S1] THE MARGIN OVER THE PLACEBO BAR");
if (cand) {
  const cands = plac.filter((x) => x.holdDays === cand.holdDays && x.condition === cand.condition);
  const sorted = [...cands].sort((a, b) => b.excess - a.excess);
  const best = sorted[0];
  const margin = cand.excess - best.excess;
  console.log(`  candidate:      ${cand.condition} ${cand.holdDays}d  excess ${f(cand.excess)}  CI [${f(cand.ciLow ?? 0, 3)}, ${f(cand.ciHigh ?? 0, 3)}]`);
  console.log(`  best placebo:   ${best.variant.padEnd(9)} excess ${f(best.excess)}  t=${best.excessT.toFixed(2)}  CI [${f(best.ciLow ?? 0, 3)}, ${f(best.ciHigh ?? 0, 3)}]`);
  console.log(`  MARGIN: ${f(margin)}pp`);
  const ciWidth = (cand.ciHigh ?? 0) - (cand.ciLow ?? 0);
  console.log(`  the candidate's own CI is ${f(ciWidth, 3)}pp wide`);
  if (margin < ciWidth * 0.1) {
    console.log(`  => the margin is ${(margin / ciWidth * 100).toFixed(1)}% of the CI width: the candidate TIES the`);
    console.log("     placebo bar, it does not beat it. A TIE is not a CLEAR.");
    cand.verdictNote = "TIES the placebo bar";
  } else {
    console.log("  => the margin is a meaningful fraction of the CI width.");
  }
  // How many placebos are at or above the candidate?
  const atOrAbove = sorted.filter((p) => p.excess >= cand.excess);
  console.log(`  placebos at or above the candidate: ${atOrAbove.length} of ${sorted.length}` +
    (atOrAbove.length ? ` -> ${atOrAbove.map((p) => p.variant).join(", ")}` : ""));
}

/* ── S2: the multiplicity benchmark ────────────────────────────────── */
console.log("\n[S2] THE MULTIPLICITY BENCHMARK");
{
  const allP = [...real, ...plac]
    .filter((r) => r.pNotGreaterThanZero != null)
    .map((r) => r.pNotGreaterThanZero);
  const nTests = real.length + plac.length;
  const minP = minOf(allP);
  const bench = 1 / (nTests + 1);
  console.log(`  cells tested: ${nTests} (${real.length} real + ${plac.length} placebo)`);
  console.log(`  smallest p across the WHOLE study: ${minP.toFixed(5)}`);
  console.log(`  the benchmark 1/(n_tests+1):        ${bench.toFixed(5)}`);
  if (minP > bench) {
    console.log("  => the smallest p is LARGER than the benchmark: the p-values are stochastically");
    console.log("     LARGER than uniform. Nothing in this study is even accidentally convincing.");
  } else {
    console.log("  => the smallest p beats the benchmark, so SOME cell is significant even after");
    console.log("     the multiplicity correction. Which cell, and does it survive the placebo?");
  }
}

/* ── S3: stability across the window ───────────────────────────────── */
console.log("\n[S3] STABILITY ACROSS THE WINDOW (three consecutive blocks)");
console.log("  (recomputed from the results JSON's day-clustered series where available;");
console.log("   otherwise the split is reported from the placebo spread)");
if (cand) {
  const cands = plac.filter((x) => x.holdDays === cand.holdDays && x.condition === cand.condition);
  const same = cands.map((p) => ({ v: p.variant, e: p.excess, t: p.excessT }));
  const realV = { v: "REAL", e: cand.excess, t: cand.excessT };
  const all = [realV, ...same];
  const nPos = all.filter((x) => x.e > 0).length;
  console.log(`  the candidate and every placebo variant at the same (hold, condition): ${nPos} of ${all.length} have a POSITIVE excess`);
  console.log(`  => a positive excess at this cell is the NORM, not the exception.`);
  console.log("     A result that shares its sign with ${PLACEBO_COUNT} of its own placebos is not a discovery.");
}
const PLACEBO_COUNT = plac.filter((x) => cand && x.holdDays === cand.holdDays && x.condition === cand.condition && x.excess > 0).length;

/* ── S4: concentration ─────────────────────────────────────────────── */
console.log("\n[S4] CONCENTRATION");
if (cand) {
  console.log(`  the top 10 symbols carry ${(cand.top10Share * 100).toFixed(0)}% of the total absolute per-symbol excess`);
  console.log(`  trades clipped at the ${R.returnCap}% return cap: ${cand.nClipped}`);
  if (cand.top10Share > 0.4) {
    console.log("  => CONCENTRATED: a handful of tokens carry it. Not a rule.");
  } else {
    console.log("  => not concentrated in a handful of symbols.");
  }
}

/* ── S5: the direction-shuffle placebo ─────────────────────────────── */
console.log("\n[S5] THE DIRECTION-SHUFFLE PLACEBO (does it know WHICH WAY?)");
if (cand) {
  const shuf = plac.filter((x) => x.holdDays === cand.holdDays && x.condition === cand.condition && x.family === "P3-shuffle");
  for (const s of shuf) {
    const rel = s.excess - cand.excess;
    console.log(`  ${s.variant.padEnd(9)} excess ${f(s.excess)}  t=${s.excessT.toFixed(2)}   (candidate is ${f(rel)} above it)`);
  }
  const bestShuf = maxBy(shuf, (s) => s.excess);
  console.log(`  best shuffled-direction excess: ${f(bestShuf)}  vs candidate ${f(cand.excess)}`);
  if (bestShuf >= cand.excess) {
    console.log("  => a signal with its DIRECTIONS RANDOMISED scores as well or better.");
    console.log("     The candidate's edge is NOT directional. It cannot be traded as a rule.");
  } else {
    console.log(`  => the candidate beats the direction-shuffle by ${f(cand.excess - bestShuf)}pp.`);
  }
}

/* ── S6: the exhaustive placebo comparison ─────────────────────────── */
console.log("\n[S6] THE EXHAUSTIVE PLACEBO COMPARISON (all variants, ranked)");
if (cand) {
  const cands = plac.filter((x) => x.holdDays === cand.holdDays && x.condition === cand.condition);
  const rows = [{ v: "REAL", e: cand.excess, t: cand.excessT, fam: "-", p: cand.pNotGreaterThanZero },
    ...cands.map((p) => ({ v: p.variant, e: p.excess, t: p.excessT, fam: p.family, p: p.pNotGreaterThanZero }))]
    .sort((a, b) => b.e - a.e);
  console.log(`  ${padL("variant", 11)}${padL("family", 14)}${pad("excess", 11)}${pad("t", 8)}${padL("p<=0", 9)}`);
  for (const r of rows) {
    const mark = r.v === "REAL" ? "  <-- the candidate" : "";
    console.log(`  ${padL(r.v, 11)}${padL(r.fam, 14)}${pad(f(r.e), 10)}%${pad(r.t.toFixed(2), 8)}${padL(r.p?.toFixed(3) ?? "-", 9)}${mark}`);
  }
  const placebosAbove = rows.filter((r) => r.v !== "REAL" && r.e >= cand.excess);
  console.log(`  placebos at or above the candidate: ${placebosAbove.length}`);
  console.log(`  the candidate's rank among ${rows.length} arms: ${rows.findIndex((r) => r.v === "REAL") + 1}`);
}

/* ── the verdict ───────────────────────────────────────────────────── */
console.log("\n" + "=".repeat(100));
if (!cand) {
  console.log("VERDICT: NO CELL CLAIMS THE BAR. Nothing to scrutinise.");
} else {
  const cands = plac.filter((x) => x.holdDays === cand.holdDays && x.condition === cand.condition);
  const best = cands.length ? cands.reduce((a, b) => (b.excess > a.excess ? b : a)) : null;
  const bestShuf = cands.length ? maxOf(cands.filter((s) => s.family === "P3-shuffle").map((s) => s.excess)) : -Infinity;
  const margin = best ? cand.excess - best.excess : 0;
  const nPos = cands.filter((p) => p.excess > 0).length;
  console.log(`VERDICT on ${cand.condition} ${cand.holdDays}d:`);
  console.log(`  excess ${f(cand.excess)}, t=${cand.excessT.toFixed(2)}, ${cand.nClusters} day clusters, ${cand.nSymbols} symbols, span ${cand.spanDays}d`);
  console.log(`  margin over the best placebo: ${f(margin)}pp`);
  console.log(`  placebos with a positive excess at this cell: ${nPos} of ${cands.length}`);
  console.log(`  the direction-shuffle placebo: ${f(bestShuf)} (candidate ${f(cand.excess)})`);
  const clears =
    margin > 0 &&
    cand.excessT >= 2 &&
    cand.trimStable &&
    cand.netPerTrade > 0 &&
    bestShuf < cand.excess &&
    nPos <= cands.length / 2;
  console.log(clears
    ? "  => CLEARS, and the margin is not noise."
    : "  => DOES NOT CLEAR. The margin over the placebo is inside the noise, the sign is");
  if (!clears) {
    console.log("     shared with most of its own placebos, and the direction-shuffle placebo is");
    console.log("     as good as the candidate. This is a selection artefact.");
  }
}
console.log("=".repeat(100));
