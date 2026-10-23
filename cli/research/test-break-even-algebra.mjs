#!/usr/bin/env node
/**
 * THE BREAK-EVEN WIN RATE MUST AGREE WITH THE EXPECTANCY FUNCTION.
 *
 * Three research scripts carried a break-even formula with the fee in
 * BOTH the numerator and the denominator:
 *
 *   (sl + fee) / (tp + sl + fee)
 *
 * The fee CANCELS out of the tp+sl term, so it must not be in the
 * denominator:
 *
 *   expectancy(w) = rho * (w*tp - (1-w)*sl - fee) = 0
 *     => w*tp - w*sl - sl - fee = 0
 *     => w*(tp + sl) = sl + fee
 *     => w* = (sl + fee) / (tp + sl)
 *
 * The wrong form UNDERSTATES the required win rate by 4.6-7.7
 * percentage points — the wrong direction, because it makes a losing
 * geometry look closer to viable than it is. Measured: a geometry that
 * needed 90.5% to pay was reported as needing 85.1%.
 *
 * And the wrong form disagreed with the expectancy function sitting in
 * the SAME FILE, which uses the correct algebra. A file that
 * contradicts itself on the same quantity cannot be trusted to reason
 * about viability.
 *
 * The test is the property, not the formula: for a range of
 * geometries, the break-even win rate must be a ZERO of the
 * expectancy function. That holds for the correct form and only for
 * the correct form.
 *
 * Run: node research/test-break-even-algebra.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/** The expectancy function, in the units the scripts use. */
function expectancy(winRate, tp, sl, fee) {
  return winRate * tp - (1 - winRate) * sl - fee;
}

/** The CORRECT break-even. */
function correct(tp, sl, fee) {
  return (sl + fee) / (tp + sl);
}

/** The WRONG form the scripts carried. */
function wrong(tp, sl, fee) {
  return (sl + fee) / (tp + sl + fee);
}

const GEOMETRIES = [
  [0.3, 1.6, 0.12],
  [0.3, 0.9, 0.12],
  [0.5, 1.5, 0.12],
  [0.4, 1.2, 0.12],
  [0.85, 0.85, 0.12],
  [0.3234, 1.0875, 0.12],
  [0.02, 0.02, 0.0012],
];

console.log("══════════════════════════════════════════════════════════════");
console.log("THE BREAK-EVEN WIN RATE MUST AGREE WITH THE EXPECTANCY FUNCTION");
console.log("══════════════════════════════════════════════════════════════");
console.log("");

// ── 1. THE PROPERTY: the break-even is a ZERO of the expectancy ────
console.log("1. THE PROPERTY: the break-even is a ZERO of the expectancy");
for (const [tp, sl, fee] of GEOMETRIES) {
  const w = correct(tp, sl, fee);
  const e = expectancy(w, tp, sl, fee);
  check(
    `tp ${tp} / sl ${sl} / fee ${fee}: the expectancy at the break-even is zero`,
    Math.abs(e) < 1e-12,
    `the expectancy is ${e}`,
  );
}
console.log("");

// ── 2. THE WRONG FORM IS NOT A ZERO ────────────────────────────────
console.log("2. THE WRONG FORM IS NOT A ZERO (so it is not a break-even)");
for (const [tp, sl, fee] of GEOMETRIES) {
  const w = wrong(tp, sl, fee);
  const e = expectancy(w, tp, sl, fee);
  check(
    `tp ${tp} / sl ${sl} / fee ${fee}: the wrong form leaves a residual`,
    Math.abs(e) > 1e-9,
    `the wrong form's expectancy is ${e} — it happens to be a zero`,
  );
}
console.log("");

// ── 3. THE DIRECTION OF THE ERROR ──────────────────────────────────
console.log("3. THE DIRECTION OF THE ERROR: the wrong form UNDERSTATES");
for (const [tp, sl, fee] of GEOMETRIES) {
  const c = correct(tp, sl, fee);
  const w = wrong(tp, sl, fee);
  check(
    `tp ${tp} / sl ${sl}: the wrong form is LOWER (flattering)`,
    w < c,
    `the wrong form says ${(w * 100).toFixed(2)}% and the correct one ${(c * 100).toFixed(2)}%`,
  );
}
console.log("");

// ── 4. THE MAGNITUDE, ON THE GEOMETRIES THE MACHINE SHIPS ──────────
console.log("4. THE MAGNITUDE, IN PERCENTAGE POINTS");
{
  const rows = [
    [0.3234, 1.0875, 0.12, "the median FIRED ticket"],
    [0.3, 1.6, 0.12, "the shipped geometry"],
    [0.3, 0.9, 0.12, "the LIVE geometry"],
    [0.85, 0.85, 0.12, "the 1:1 the goal study priced"],
  ];
  for (const [tp, sl, fee, label] of rows) {
    const c = correct(tp, sl, fee);
    const w = wrong(tp, sl, fee);
    console.log(
      `    ${label.padEnd(28)} the correct ${(c * 100).toFixed(1)}%  the wrong ${(w * 100).toFixed(1)}%  ` +
        `-> understated by ${((c - w) * 100).toFixed(1)} pp`,
    );
  }
  console.log("");
}

// ── 5. THE REPO'S COPIES ARE CORRECT NOW ────────────────────────────
console.log("5. THE REPO'S COPIES ARE CORRECT NOW");
for (const file of [
  "fee-floor-study.mjs",
  "analyze-geometry.mjs",
  "analyze-geometry-sides.mjs",
]) {
  const src = readFileSync(join(HERE, file), "utf8");
  check(
    `${file} does not put the fee in the denominator`,
    !/\/\s*\(\s*\w*Pct\s*\+\s*\w*Pct\s*\+\s*(?:TAKER_RT|feePct)\s*\)/.test(src),
    "the wrong form is still there",
  );
}
{
  // The family harness derives it from the expectancy algebra, so it
  // is correct — and it is the reference.
  const src = readFileSync(join(HERE, "family-harness.mjs"), "utf8");
  check(
    "family-harness.mjs derives it from the algebra (the reference form)",
    /const denom = tpPct \+ stopPct;/.test(src),
    "the family harness changed",
  );
}
console.log("");

console.log("══════════════════════════════════════════════════════════════");
console.log(`  ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════════");
process.exit(fail ? 1 : 0);
