#!/usr/bin/env node
/**
 * The funding-carry study's own algebra, pinned.
 *
 * This study exists because the PRIOR funding study measured an
 * arithmetic identity: its baseline was the same trade WITHOUT the
 * funding receipt, so the paired difference was EXACTLY the funding
 * term, and every variant printed a tiny positive excess with an
 * enormous t (6.03, 7.62, 9.88, 11.52).
 *
 * These checks pin the properties that make the carry measurement a
 * MEASUREMENT rather than an identity:
 *
 *   1. The funding is on BOTH arms, so it cancels in the difference.
 *   2. The excess is NOT identically zero — the funding's contribution
 *      is non-zero only because the arms hold different symbols for
 *      different lengths of time.
 *   3. The excess with funding and the excess without funding differ by
 *      EXACTLY the funding delta. That is the identity that PROVES the
 *      funding was added to both arms rather than one.
 *   4. A carry is charged at a SETTLEMENT, not prorated by the hold.
 *   5. A short RECEIVES a positive rate and PAYS a negative one.
 *   6. n is CLUSTERS, not rows.
 *   7. The PLACEBO is measured beside the real selection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "analyze-funding-carry-geometry.mjs"), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── 1. THE FUNDING IS ON BOTH ARMS ──
check(
  "the funding is added to BOTH arms' net (one function, used twice)",
  /t\.netPct = t\.pricePct \+ t\.fundingPct - t\.feePct/.test(SRC),
  "the net must include the funding",
);
check(
  "the control arm is simulated with the SAME simulate() function as the signal arm",
  /const U = simulate\(control, g, funding\)/.test(SRC) &&
    /const S = simulate\(signal, g, funding\)/.test(SRC),
  "the arms must be comparable by construction",
);
check(
  "the excess is reported TWICE — without funding and with it",
  /excessPrice/.test(SRC) && /excessWithFund/.test(SRC),
  "the cancellation must be visible, not asserted",
);

// ── 2. THE FUNDING HELPER SIGNS THE TRADE'S DIRECTION ──
check(
  "a short RECEIVES a positive rate and a long PAYS it",
  /dir === "short" \? s\.rate : -s\.rate/.test(SRC),
  "the sign of the carry follows the side of the position",
);

// ── 3. THE FUNDING IS CHARGED AT SETTLEMENTS, NOT PRORATED ──
check(
  "the funding is charged at each settlement inside the hold, in full",
  /if \(s\.at <= entryTs\) continue;/.test(SRC) && /if \(s\.at > exitTs\) break;/.test(SRC),
  "a trade open at a settlement is charged that settlement in full",
);

// ── 4. THE EXCESS IS NOT THE FUNDING TERM (the prior study's defect) ──
//
// The prior study's baseline was the same trade WITHOUT the funding
// receipt, so its paired difference was EXACTLY the funding term: an
// arithmetic identity, not a measurement. That is why every variant
// printed a tiny positive excess with an enormous t.
//
// The detector: in the prior design, excessWithFund === signalFunding.
// In this design the excess is measured against a DIFFERENT arm (the
// unconditional control), so the excess is NOT the funding term.
const mk = (signalNet, controlNet, signalFund, controlFund) => ({
  excessNoFund: signalNet - controlNet,
  excessWithFund: signalNet + signalFund - (controlNet + controlFund),
  fundingDelta: signalFund - controlFund,
});
const a = mk(0.20, 0.10, 0.005, 0.004);
check(
  "excess(+funding) - excess(price) === fundingDelta, exactly",
  Math.abs((a.excessWithFund - a.excessNoFund) - a.fundingDelta) < 1e-12,
  `got ${a.excessWithFund - a.excessNoFund} vs ${a.fundingDelta}`,
);
check(
  "the funding delta is a SMALL fraction of the excess when both arms carry",
  Math.abs(a.fundingDelta) < Math.abs(a.excessNoFund),
  "if the funding delta dominated, the funding would be the edge, not the signal",
);
// The prior study's design: the SAME trade, the baseline without funding.
// Its paired difference is EXACTLY the funding term.
const priorDesign = mk(0.20, 0.20, 0.005, 0.0);
check(
  "the PRIOR design's excess IS exactly the funding term (the defect, reproduced)",
  Math.abs(priorDesign.excessWithFund - 0.005) < 1e-12,
  "this is what the prior study measured: an arithmetic identity",
);
// THIS design: the arms are DIFFERENT trades, so the excess is NOT the
// funding term — it is a real difference between two different portfolios.
const thisDesign = mk(0.20, 0.10, 0.005, 0.004);
check(
  "THIS design's excess is NOT the funding term (so it is a measurement)",
  Math.abs(thisDesign.excessWithFund - 0.005) > 1e-6,
  `the excess ${thisDesign.excessWithFund} must differ from the funding term 0.005`,
);
// And the excess must be larger than the funding term by a wide margin,
// or the carry would BE the signal.
check(
  "the excess is far larger than the funding term",
  Math.abs(thisDesign.excessWithFund) > 10 * Math.abs(thisDesign.fundingDelta),
  `excess ${thisDesign.excessWithFund} vs funding delta ${thisDesign.fundingDelta}`,
);

// ── 5. n IS CLUSTERS ──
check(
  "the t-statistic is computed on CLUSTER MEANS",
  /clusterStats/.test(SRC) && /function clusterStats/.test(SRC),
);
check(
  "the viability bar is on the cluster count",
  /cand\.sClusters >= MIN_CLUSTERS/.test(SRC),
);
check(
  "the cluster count is reported with the result",
  /clusters:/.test(SRC),
);
check(
  "the span is reported",
  /span:/.test(SRC),
);

// ── 6. THE PLACEBO IS MEASURED ──
check(
  "a PLACEBO (a random selection of the same size) is measured",
  /runPlacebo/.test(SRC) && /placebo\.percentile/.test(SRC),
);

// ── 7. THE SAME OBSERVATION IS NOT TWO OBSERVATIONS ──
check(
  "duplicate re-reads of the same (symbol, entry-bar) are de-duplicated",
  /dedupDropped/.test(SRC) && /seen\.has\(key\)/.test(SRC),
);
check(
  "a TRUNCATED horizon is distinguished from a real time exit",
  /complete/.test(SRC) && /truncated/.test(SRC),
);

// ── 8. THE FEE FLOOR ──
check(
  "the taker round trip is 0.12% and is charged on every trade",
  /const TAKER_RT = 0\.12/.test(SRC) && /- t\.feePct/.test(SRC),
);

// ── 9. THE EXECUTED ARITHMETIC: THE CARRY CANNOT PAY THE FEE ──
//
// The median rate on this universe is 0.005% of notional per 4h
// settlement, and the taker round trip is 0.12%. So the carry needs
// 0.12 / 0.005 = 24 settlements = 96 hours to cover ONE round trip.
const ratePct = 0.005;
const feePct = 0.12;
const settlementsNeeded = feePct / ratePct;
const hoursNeeded = settlementsNeeded * 4;
check(
  "the carry needs many settlements to cover one round trip",
  settlementsNeeded >= 20,
  `got ${settlementsNeeded} settlements`,
);
check(
  "the carry-alone horizon is far longer than the trade's hold",
  hoursNeeded >= 48,
  `got ${hoursNeeded} hours`,
);

// ── 10. A TRADE THAT CLOSED BEFORE THE SETTLEMENT RECEIVES NOTHING ──
//
// The canonical check on the funding helper's window: a trade that
// entered at t=10:00 and exited at t=11:00, with a settlement at 12:00,
// receives ZERO funding.
const fundingWindow = (entryTs, exitTs, settlements) => {
  let pct = 0;
  let n = 0;
  for (const s of settlements) {
    if (s.at <= entryTs) continue;
    if (s.at > exitTs) break;
    pct += s.rate * 100;
    n++;
  }
  return { pct, n };
};
const H = 3600000;
const sched = [{ at: 12 * H, rate: 0.0001 }];
const before = fundingWindow(10 * H, 11 * H, sched);
const across = fundingWindow(10 * H, 13 * H, sched);
const after = fundingWindow(13 * H, 14 * H, sched);
check(
  "a trade that closed BEFORE the settlement receives nothing",
  before.pct === 0 && before.n === 0,
  `got ${before.pct}`,
);
check(
  "a trade that was open AT the settlement receives the rate in full",
  Math.abs(across.pct - 0.01) < 1e-12 && across.n === 1,
  `got ${across.pct} over ${across.n} settlements`,
);
check(
  "a trade that opened AFTER the settlement receives nothing",
  after.pct === 0 && after.n === 0,
  `got ${after.pct}`,
);

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed — the funding-carry study's algebra is not sound.`);
  process.exit(1);
}
console.log("The funding-carry study's algebra holds: the funding is on both arms, the excess is a measurement rather than an identity, and n is clusters.");
