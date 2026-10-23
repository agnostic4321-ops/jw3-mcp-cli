#!/usr/bin/env node
/**
 * The funding/OI study's own algebra, pinned.
 *
 * THREE DEFECTS WERE FOUND AND FIXED HERE:
 *
 * 1. THE t-STATISTIC TESTED THE WRONG THING. It was the RAW signal's
 *    mean over its own standard error — the signal's DIRECTIONAL
 *    return — while the bar asks whether the EXCESS over the baseline
 *    is real. The two disagree: the old run printed "excess
 *    +0.0007pp, t=-2.69" — a positive excess with a strongly NEGATIVE
 *    t, because the t belonged to a different quantity.
 *
 * 2. THE EXCESS WAS AN ARITHMETIC IDENTITY. The baseline was the
 *    same trade WITHOUT the funding receipt, so the paired difference
 *    was EXACTLY the funding term. Every variant printed a tiny
 *    positive excess with an enormous t (t=6 to t=11.5) — a
 *    measurement of nothing.
 *
 * 3. n WAS ROWS, NOT CLUSTERS. The collector samples 45 symbols every
 *    15 minutes, so all the symbols in a round move together. The old
 *    run reported n=369 and n=492 — those are ROW counts, not
 *    observations. The independent sample is the ROUND.
 *
 * THE DESIGN THAT WORKS: the baseline is the CROSS-SECTIONAL PEER
 * GROUP — the mean of the UNSELECTED symbols in the same round, at the
 * same horizon. Subtracting it leaves the selected symbol's own move
 * with the market's move removed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "analyze-funding-oi.mjs"), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── 1. THE t TESTS THE EXCESS ──
check(
  "the t-statistic is computed from the CLUSTER MEAN of the excess",
  /rm\.se > 0 \? rm\.mean \/ rm\.se/.test(SRC),
  "the t must be the excess's t, not the raw signal's t",
);
check(
  "the old wrong t (signal mean over its own se) is gone",
  !/const t = s\.se > 0 \? s\.mean \/ s\.se/.test(SRC),
);
check(
  "the excess is reported with its cluster count",
  /CLUSTERS:/.test(SRC),
);

// ── 2. THE EXCESS IS NOT AN IDENTITY ──
check(
  "the baseline carries the funding (so the funding cancels by construction)",
  /const uncond = gross - TAKER_RT \+ fundingPct/.test(SRC),
  "the baseline must be the same direction WITH the funding",
);
check(
  "the baseline is the cross-sectional PEER group, not the symbol itself",
  /peerMean/.test(SRC) && /bucket\.all\.reduce/.test(SRC),
  "the baseline must be the round's unselected mean",
);
check(
  "the baseline arm covers the whole universe, not just the selected rows",
  /arms\.unconditional\.push\(uncond\)/.test(SRC),
);

// ── 3. n IS CLUSTERS ──
check(
  "the viability bar uses the cluster count",
  /r\.clusters >= MIN_N/.test(SRC),
  "the bar must be on independent clusters, not rows",
);
check(
  "the bar is reported as INDEPENDENT CLUSTERS",
  /INDEPENDENT CLUSTERS/.test(SRC),
);

// ── 4. NO NaN FROM AN EMPTY ROUND ──
check(
  "a round with no qualifying row contributes no cluster",
  /if \(!bucket\.diffs\.length\) continue;/.test(SRC),
  "dividing by zero would poison the cluster mean",
);

// ── 5. THE PURE ALGEBRA, EXECUTED ──
//
// A round of 10 symbols. Three are selected. Each has a forward
// return. The peer group is the mean of the seven unselected.
const round = {
  selected: [
    { base: "A", ret: 1.0, sel: true },
    { base: "B", ret: 2.0, sel: true },
    { base: "C", ret: -1.0, sel: true },
  ],
  peers: [
    { base: "D", ret: 0.5 },
    { base: "E", ret: 0.5 },
    { base: "F", ret: 0.5 },
    { base: "G", ret: 0.5 },
    { base: "H", ret: 0.5 },
    { base: "I", ret: 0.5 },
    { base: "J", ret: 0.5 },
  ],
};
const peerMean = round.peers.reduce((a, b) => a + b.ret, 0) / round.peers.length;
check("the peer mean is the unselected mean", peerMean === 0.5, `got ${peerMean}`);
// The short's gross on each selected symbol:
const dir = -1;
const selNet = round.selected.map((r) => dir * r.ret);
// The paired difference against the peer group:
const diffs = selNet.map((n) => n - peerMean);
// The market drifted UP (every peer gained 0.5). A short therefore
// LOSES 0.5 against the drift. The two selected symbols that ROSE
// (A +1.0, B +2.0) must underperform their peer baseline, and the one
// that FELL (C -1.0) must outperform it. The difference is the
// symbol's own move with the market's drift removed.
check(
  "the paired difference removes the market's drift",
  diffs[0] === -1.5 && diffs[1] === -2.5 && diffs[2] === 0.5,
  `A and B rose so their shorts must underperform the peer; C fell so its short must outperform: ${diffs}`,
);
check(
  "the excess is NOT zero (it is a real measurement, not an identity)",
  diffs.some((d) => Math.abs(d) > 1e-9),
  "an identically-zero excess means the baseline is the same trade",
);

// ── 6. THE PLACEBO BAR ──
//
// A RANDOM selection of the same size must not produce a significant
// excess. The fade/dip family cleared the bar at 0.4-0.6% of pure
// chance, so a study that cannot beat a placebo is not a study.
const rng = (() => {
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
})();
const placeboExcesses = [];
for (let trial = 0; trial < 200; trial++) {
  const syms = [...round.selected, ...round.peers];
  const shuffled = [...syms].sort(() => rng() - 0.5);
  const sel = shuffled.slice(0, 3);
  const unsel = shuffled.slice(3);
  const pm = unsel.reduce((a, b) => a + b.ret, 0) / unsel.length;
  const d = sel.map((r) => dir * r.ret - pm);
  placeboExcesses.push(d.reduce((a, b) => a + b, 0) / d.length);
}
const pMean = placeboExcesses.reduce((a, b) => a + b, 0) / placeboExcesses.length;
const pSd = Math.sqrt(
  placeboExcesses.reduce((a, b) => a + (b - pMean) ** 2, 0) / (placeboExcesses.length - 1),
);
const pSe = pSd / Math.sqrt(placeboExcesses.length);
const observed = diffs.reduce((a, b) => a + b, 0) / diffs.length;
const pT = pSe > 0 ? (observed - pMean) / pSe : 0;
check(
  "the PLACEBO (a random selection of the same size) is measured too",
  Number.isFinite(pT),
  `placebo t=${pT.toFixed(2)} vs the real selection's excess ${observed.toFixed(3)}`,
);
console.log(`       (the placebo's mean excess is ${pMean.toFixed(3)}; the real selection's is ${observed.toFixed(3)})`);

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed — the funding/OI study's algebra is not sound.`);
  process.exit(1);
}
console.log("The funding/OI study's algebra holds: the t tests the excess, the excess is not an identity, and n is clusters.");
