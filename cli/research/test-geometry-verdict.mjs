#!/usr/bin/env node
/**
 * THE GEOMETRY VERDICT MUST APPLY THE HOUSE BAR, NOT JUST THE SIGN.
 *
 * THE DEFECT THIS PINS.
 *
 * `analyze-geometry.mjs` used to decide:
 *
 *     const verdict = r.excess > 0 ? "EDGE" : "no edge";
 *
 * A POSITIVE EXCESS ALONE was declared an edge — no t-statistic, no
 * cluster count, no fee floor. On the live sample that printed
 * "EDGE" for the SHIPPED geometry at t=0.26, with a 100% win rate,
 * on 37 five-minute buckets — and the numbers MOVED between runs
 * (+0.0684% then +0.0275%) because the script reads the LIVE bar
 * cache. A reader who trusted "EDGE" would have shipped a losing
 * geometry.
 *
 * FOUR THINGS MUST ALL HOLD FOR AN EDGE:
 *
 *   1. the excess is POSITIVE
 *   2. its t on the cluster means is >= 2
 *   3. the independent-cluster count meets the bar — counted at the
 *      TICKET'S HOLDING PERIOD (240 minutes), not the collector's
 *      5-minute cadence, because two signals inside one hold share the
 *      same entry, path and exit and are ONE trade seen twice
 *   4. the arm's OWN net EV clears the FEE FLOOR — an excess is a
 *      DIFFERENCE, so an arm can beat a losing control and still lose
 *      after the fee
 *
 * Anything short of all four is a CANDIDATE, not an edge.
 *
 * The test also pins the two UNIT traps, because both produce a
 * false negative (an edge that can never be reported) rather than a
 * false positive, and a false negative is just as wrong:
 *
 *   - the fee floor is already in % OF EQUITY, so it must NOT be
 *     multiplied by 100 again
 *   - the cluster buckets are INDICES (floor(ts / BUCKET_MS)), not
 *     milliseconds, so the holding-period cluster divides the INDEX by
 *     the number of 5-minute buckets in one hold
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "analyze-geometry.mjs");
const src = readFileSync(SRC, "utf8");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`        [PASS] ${name}`);
  } else {
    fail++;
    console.log(`        [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("");
console.log("1. THE VERDICT APPLIES THE HOUSE BAR, NOT JUST THE SIGN");
{
  check(
    "the old sign-only verdict is gone",
    !/const verdict = r\.excess > 0 \? "EDGE" : "no edge"/.test(src),
    "the sign-only verdict is still there",
  );
  check(
    "the verdict requires a POSITIVE excess",
    /excessOk/.test(src) && /r\.excess > 0/.test(src),
    "the excess test is missing",
  );
  check(
    "the verdict requires t >= 2",
    /excessT >= 2/.test(src),
    "the t bar is missing",
  );
  check(
    "the verdict requires the CLUSTER BAR",
    /MIN_CLUSTER_BAR/.test(src),
    "the cluster bar is missing",
  );
  check(
    "the verdict requires the arm's OWN net EV above the fee floor",
    /ownEvOk/.test(src) && /r\.ev > feeFloorPct/.test(src),
    "the fee-floor test is missing",
  );
  check(
    "a positive excess that fails the bar is a CANDIDATE, not an edge",
    /"candidate"/.test(src),
    "the candidate label is missing",
  );
}

console.log("");
console.log("2. THE INDEPENDENT SAMPLE IS THE TICKET'S HOLDING PERIOD");
{
  check(
    "the holding period is defined from the ticket's own bars",
    /HOLD_MINUTES = MAX_HOLD_BARS \* BAR_MIN/.test(src),
    "the holding period is not derived from the ticket",
  );
  check(
    "the holding period is 240 minutes for the shipped 4-hour ticket",
    /HOLD_MINUTES = MAX_HOLD_BARS \* BAR_MIN/.test(src) &&
      /\/\/ 240/.test(src),
    "the holding period is not annotated",
  );
  check(
    "the cluster bar is 30 — the same bar the live evidence gate uses",
    /MIN_CLUSTER_BAR = 30/.test(src),
    "the cluster bar is not 30",
  );
  check(
    "the row carries the holding-period cluster count",
    /sHoldClusters/.test(src),
    "the holding-period cluster count is missing",
  );
  check(
    "the verdict counts the HOLDING-period clusters",
    /r\.sHoldClusters \?\? r\.sClusters/.test(src),
    "the verdict still counts the 5-minute buckets",
  );
  check(
    "the buckets are treated as INDICES, not milliseconds",
    /HOLD_BUCKET_COUNT = Math\.round\(HOLD_BUCKET_MS \/ BUCKET_MS\)/.test(src),
    "the bucket-index correction is missing",
  );
}

console.log("");
console.log("3. THE FEE FLOOR IS IN THE SAME UNITS AS THE EV");
{
  check(
    "the fee floor is TAKER_RT * (NOTIONAL / EQUITY)",
    /const feeFloorPct = TAKER_RT \* \(NOTIONAL \/ EQUITY\);/.test(src),
    "the fee floor is not in % of equity",
  );
  check(
    "the fee floor is NOT multiplied by 100 again",
    !/feeFloorPct = TAKER_RT \* \(NOTIONAL \/ EQUITY\) \* 100/.test(src),
    "the fee floor is in the wrong units — an edge could never be reported",
  );
}

console.log("");
console.log("4. THE VERDICT LOGIC BEHAVES — THE CLASSIFIER, EXECUTED");
{
  // The classifier, extracted so it can be EXERCISED. A source-shape
  // check cannot tell a passing row from a failing one, because the
  // shape is identical either way.
  const MIN_CLUSTER_BAR = 30;
  const feeFloorPct = 0.12 * (60 / 57.2287); // % of equity

  const verdictOf = (r) => {
    const excessOk = r.excess > 0;
    const tOk = r.excessT >= 2;
    const clusterOk = (r.sHoldClusters ?? r.sClusters) >= MIN_CLUSTER_BAR;
    const ownEvOk = r.ev > feeFloorPct;
    return excessOk && tOk && clusterOk && ownEvOk
      ? "EDGE"
      : excessOk
        ? "candidate"
        : "no edge";
  };

  // THE POSITIVE EXCESS ALONE — the exact case the old code called
  // an edge. It must NOT be an edge.
  check(
    "a positive excess with t=0.26 is NOT an edge",
    verdictOf({
      excess: 0.0684,
      excessT: 0.26,
      sClusters: 37,
      sHoldClusters: 6,
      ev: -0.0297,
    }) !== "EDGE",
    "it was called an edge",
  );
  check(
    "...and it is reported as a CANDIDATE",
    verdictOf({
      excess: 0.0684,
      excessT: 0.26,
      sClusters: 37,
      sHoldClusters: 6,
      ev: -0.0297,
    }) === "candidate",
    "it was not reported as a candidate",
  );

  // A GENUINE edge: positive excess, strong t, enough independent
  // clusters, and the arm's own net EV above the fee floor.
  check(
    "a genuine edge IS reported as an edge",
    verdictOf({
      excess: 0.182,
      excessT: 5.58,
      sClusters: 84,
      sHoldClusters: 31,
      ev: 0.208,
    }) === "EDGE",
    "a genuine edge was hidden",
  );

  // Each of the four gates must be able to BLOCK an edge on its own.
  check(
    "a weak t blocks an edge",
    verdictOf({ excess: 0.18, excessT: 1.2, sHoldClusters: 40, ev: 0.2 }) !== "EDGE",
    "a weak t did not block it",
  );
  check(
    "too few independent clusters blocks an edge",
    verdictOf({ excess: 0.18, excessT: 5.5, sHoldClusters: 6, ev: 0.2 }) !== "EDGE",
    "too few clusters did not block it",
  );
  check(
    "an arm that LOSES after the fee is blocked even with a positive excess",
    verdictOf({ excess: 0.18, excessT: 5.5, sHoldClusters: 40, ev: -0.02 }) !== "EDGE",
    "a losing arm was called an edge",
  );
  check(
    "a NEGATIVE excess is not an edge",
    verdictOf({ excess: -0.02, excessT: 5.5, sHoldClusters: 40, ev: 0.2 }) === "no edge",
    "a negative excess was called an edge",
  );

  // THE UNIT TRAP. If the fee floor were in the wrong units the edge
  // would be unreachable — a false NEGATIVE.
  const wrongFloor = 0.12 * (60 / 57.2287) * 100;
  const genuine = { excess: 0.182, excessT: 5.58, sHoldClusters: 31, ev: 0.208 };
  check(
    "the WRONG fee-floor units would hide a genuine edge",
    !(genuine.ev > wrongFloor) && genuine.ev > feeFloorPct,
    "the unit trap does not behave as expected",
  );

  // THE BUCKET-INDEX TRAP. If the buckets were treated as milliseconds
  // the holding-period cluster count would collapse to ~1.
  const BUCKET_MS = 5 * 60_000;
  const HOLD_BUCKET_MS = 240 * 60_000;
  const HOLD_BUCKET_COUNT = Math.round(HOLD_BUCKET_MS / BUCKET_MS);
  const bucketIndices = [10, 11, 12, 200, 201];
  const right = new Set(bucketIndices.map((b) => Math.floor(b / HOLD_BUCKET_COUNT))).size;
  const wrong = new Set(bucketIndices.map((b) => Math.floor(b / HOLD_BUCKET_MS))).size;
  check(
    "the bucket-index correction changes the count (the trap is real)",
    right !== wrong,
    "the two ways agree — the trap is not exercised",
  );
  check(
    "the corrected count is the larger one",
    right > wrong,
    "the corrected count is not larger",
  );
}

console.log("");
console.log("════════════════════════════════════════════════════════════════════");
console.log(
  fail === 0
    ? `PASSED — ${pass}/${pass} checks`
    : `FAILED — ${fail} of ${pass + fail} checks failed`,
);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
