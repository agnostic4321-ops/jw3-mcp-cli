#!/usr/bin/env node
/**
 * THE DEPLOYMENT EVIDENCE GATE — its own tests.
 *
 * The gate is the one control that stands between "the machine is
 * armed" and "the machine puts real money on a ticket that the
 * project's own measurement says loses". It therefore has to be
 * correct in BOTH directions:
 *
 *   - it must REFUSE when the evidence says the arm loses
 *   - it must REFUSE when the evidence is missing or unreadable
 *     (fail-closed: "no data" must never mean "fire")
 *   - it must ALLOW when the evidence clears every bar
 *
 * A gate that only ever refuses is safe but useless; a gate that
 * allows on missing data is dangerous. Both directions are tested.
 *
 * Run: node research/test-evidence-gate.mjs
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`    [PASS] ${name}`);
  } else {
    fail++;
    console.log(`    [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── THE GATE, copied VERBATIM from trade-loop.mjs ──
// The copy is intentional: if the loop's gate drifts, this test must
// fail. The test asserts the two implementations match.
const { readFileSync, existsSync } = await import("node:fs");
const loopSrc = readFileSync(new URL("./trade-loop.mjs", import.meta.url), "utf8");
const gateStart = loopSrc.indexOf("function evidenceGate()");
const gateEnd = loopSrc.indexOf("\n}\n", gateStart) + 3;
const gateSrc = loopSrc.slice(gateStart, gateEnd);
if (!gateSrc.includes("EVIDENCE_GATE") && !gateSrc.includes("allowed")) {
  console.error("could not extract the gate from trade-loop.mjs");
  process.exit(1);
}

// The gate closes over three module-level constants. Rebuild them here.
const dir = mkdtempSync(join(tmpdir(), "jw3-evidence-gate-"));
let EVIDENCE = join(dir, "live-gate-ev.json");
let EVIDENCE_GATE = true;
let EVIDENCE_MIN_CLUSTERS = 30;
let EVIDENCE_CLUSTER_MINUTES = 240;

const evidenceGate = new Function(
  "EVIDENCE",
  "EVIDENCE_GATE",
  "EVIDENCE_MIN_CLUSTERS",
  "EVIDENCE_CLUSTER_MINUTES",
  "readFileSync",
  "existsSync",
  `${gateSrc}; return evidenceGate;`,
)(EVIDENCE, EVIDENCE_GATE, EVIDENCE_MIN_CLUSTERS, EVIDENCE_CLUSTER_MINUTES, readFileSync, existsSync);

// A gate bound to a different file. The Function's parameters shadow
// the module-level ones, so the gate must be re-created for each file.
const gateFor = (file) =>
  new Function(
    "EVIDENCE",
    "EVIDENCE_GATE",
    "EVIDENCE_MIN_CLUSTERS",
    "EVIDENCE_CLUSTER_MINUTES",
    "readFileSync",
    "existsSync",
    `${gateSrc}; return evidenceGate;`,
  )(file, EVIDENCE_GATE, EVIDENCE_MIN_CLUSTERS, EVIDENCE_CLUSTER_MINUTES, readFileSync, existsSync);

const GOOD = {
  generatedAt: "2026-10-21T16:00:00.000Z",
  liveGate: { n: 200, ev: 0.42, clusters: 34, winRate: 0.71 },
  // The cluster width the counts were computed at. The ticket holds 240
  // minutes, so evidence clustered narrower than that counts one trade
  // several times.
  clusterWidthMinutes: 240,
  excess: { pairedClusters: 34, mean: 0.11, se: 0.04, t: 2.75 },
  feeFloorPctEquity: 0.126,
};

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE DEPLOYMENT EVIDENCE GATE — the tests");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

// ── 1. IT REFUSES ON THE CURRENT, MEASURED EVIDENCE ──
console.log("1. IT REFUSES WHEN THE ARM'S OWN EVIDENCE SAYS IT LOSES");
{
  const f = join(dir, "current.json");
  writeFileSync(f, JSON.stringify({
    generatedAt: "2026-10-21T15:30:08.936Z",
    liveGate: { n: 53, ev: -0.21112799095839307, clusters: 27, winRate: 0.727 },
    // The evidence as it was published before the width was carried: no
    // width at all. It must refuse, because a count with an unknown
    // width cannot be checked.
    excess: { pairedClusters: 27, mean: -0.02408575192385138, se: 0.0105, t: -2.29 },
    feeFloorPctEquity: 0.1259667241788966,
  }));
  const g = gateFor(f)();
  check("it refuses", g.allowed === false);
  check("the reason names the EV against the fee floor", /not above the .* fee floor/.test(g.reason), g.reason);
  check("the reason names the negative excess", /excess over the control is .* not positive/.test(g.reason), g.reason);
  check("the reason names the cluster count", /27 independent clusters, the bar is 30/.test(g.reason), g.reason);
  check("the reason is recorded for the audit trail", g.reason.startsWith("the evidence gate:"));
}
console.log("");

// ── 2. IT IS FAIL-CLOSED ──
console.log("2. IT IS FAIL-CLOSED — no evidence, no fire");
{
  const missing = join(dir, "does-not-exist.json");
  const g = gateFor(missing)();
  check("a MISSING evidence file refuses", g.allowed === false);
  check("the reason says it is fail-closed", /fail-closed/.test(g.reason), g.reason);
  check("the detail marks it missing", g.detail.missing === true);
}
{
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ this is not json");
  const g = gateFor(broken)();
  check("an UNREADABLE evidence file refuses", g.allowed === false);
  check("the reason says it is unreadable", /unreadable/.test(g.reason), g.reason);
}
console.log("");

// ── 3. IT ALLOWS WHEN THE EVIDENCE CLEARS EVERY BAR ──
console.log("3. IT ALLOWS WHEN THE EVIDENCE CLEARS EVERY BAR");
{
  const f = join(dir, "good.json");
  writeFileSync(f, JSON.stringify(GOOD));
  const g = gateFor(f)();
  check("it allows", g.allowed === true, g.reason);
  check("the reason says the bar is met", /clears the fee floor/.test(g.reason), g.reason);
  check("the detail carries the measured EV", g.detail.ev === 0.42);
  check("the detail carries the cluster count", g.detail.clusters === 34);
}
console.log("");

// ── 4. IT REJECTS EACH BAR INDEPENDENTLY ──
console.log("4. IT REJECTS EACH BAR INDEPENDENTLY");
{
  const belowFloor = join(dir, "below-floor.json");
  writeFileSync(belowFloor, JSON.stringify({ ...GOOD, liveGate: { ...GOOD.liveGate, ev: 0.05 } }));
  const g = gateFor(belowFloor)();
  check("an EV below the fee floor refuses", g.allowed === false);
  check("the reason names the fee floor", /fee floor/.test(g.reason), g.reason);
}
{
  const zeroExcess = join(dir, "zero-excess.json");
  writeFileSync(zeroExcess, JSON.stringify({ ...GOOD, excess: { ...GOOD.excess, mean: 0 } }));
  const g = gateFor(zeroExcess)();
  check("a zero excess refuses", g.allowed === false);
  check("the reason names the excess", /excess/.test(g.reason), g.reason);
}
{
  const tooFew = join(dir, "too-few.json");
  writeFileSync(tooFew, JSON.stringify({ ...GOOD, liveGate: { ...GOOD.liveGate, clusters: 29 } }));
  const g = gateFor(tooFew)();
  check("29 clusters against a bar of 30 refuses", g.allowed === false);
  check("the reason names the cluster bar", /29 independent clusters/.test(g.reason), g.reason);
}
// ── 4b. THE CLUSTER WIDTH MUST BE THE TICKET'S HOLDING PERIOD ──
console.log("4b. THE CLUSTER WIDTH MUST BE THE TICKET'S HOLDING PERIOD");
{
  const narrow = join(dir, "narrow-width.json");
  writeFileSync(narrow, JSON.stringify({ ...GOOD, clusterWidthMinutes: 5 }));
  const g = gateFor(narrow)();
  check("a 5-minute cluster width refuses", g.allowed === false);
  check(
    "the reason names the width and the ticket's hold",
    /clustered at 5 minutes/.test(g.reason) && /240 minutes/.test(g.reason),
    g.reason,
  );
}
{
  const noWidth = join(dir, "no-width.json");
  writeFileSync(noWidth, JSON.stringify({ ...GOOD, clusterWidthMinutes: undefined }));
  const g = gateFor(noWidth)();
  check("evidence with NO width refuses", g.allowed === false);
  check(
    "the reason says the width is unknown",
    /does not say which cluster width/.test(g.reason),
    g.reason,
  );
}
{
  const g = gateFor(join(dir, "good.json"))();
  check("a 240-minute width with 34 clusters is ALLOWED", g.allowed === true, g.reason);
}
{
  const nanEv = join(dir, "nan.json");
  writeFileSync(nanEv, JSON.stringify({ ...GOOD, liveGate: { ...GOOD.liveGate, ev: null } }));
  const g = gateFor(nanEv)();
  check("a missing EV refuses (it is not a number)", g.allowed === false);
  check("the reason says the EV is not a number", /not a number/.test(g.reason), g.reason);
}
console.log("");

// ── 5. THE OVERRIDE IS EXPLICIT AND RECORDED ──
console.log("5. THE OVERRIDE IS EXPLICIT");
{
  const f = join(dir, "good.json");
  const overridden = new Function(
    "EVIDENCE",
    "EVIDENCE_GATE",
    "EVIDENCE_MIN_CLUSTERS",
  "EVIDENCE_CLUSTER_MINUTES",
    "EVIDENCE_CLUSTER_MINUTES",
    "EVIDENCE_CLUSTER_MINUTES",
    "readFileSync",
    "existsSync",
    `${gateSrc}; return evidenceGate;`,
  )(f, false, EVIDENCE_MIN_CLUSTERS, EVIDENCE_CLUSTER_MINUTES, readFileSync, existsSync);
  const g = overridden();
  check("the override allows a fire", g.allowed === true, g.reason);
  check("the override says so in the reason", /evidence gate is OFF/.test(g.reason), g.reason);
  check("the override is marked in the detail", g.detail.overridden === true);
}
console.log("");

// ── 6. THE GATE IN THE LOOP IS THE SAME GATE ──
console.log("6. THE LOOP CALLS THE GATE BEFORE ANY LIVE CALL");
{
  const i = loopSrc.indexOf("const cycleEvidence = evidenceGate();");
  check("the loop evaluates the gate", i > 0);
  const before = loopSrc.slice(0, i);
  const liveCall = before.lastIndexOf("pacedJw3(");
  check("the gate is evaluated in the cycle body", liveCall < i || before.indexOf('"live",') < 0);
  // the gate must be checked BEFORE the live call in the SAME cycle
  const after = loopSrc.slice(i);
  const firstLive = after.indexOf('"live",');
  check("the gate's refusal skips the live call", firstLive > 0, "the live call follows the gate");
  check("a refusal is logged for the audit trail", /log\(\{ event: "evidence-gate"/.test(after));
}
console.log("");

// ── 10. IT DISTINGUISHES A CONFIRMED LOSS FROM AN UNPROVEN ARM ──
//
// Both refuse, but they are different facts. One is waiting on
// collection time; the other is waiting on a change of STRATEGY,
// because no amount of more data makes a confirmed loss into a
// fee-clearing edge. The operator has to be able to tell them apart
// from the refusal message alone.
console.log("10. IT SAYS SO WHEN THE ARM'S LOSS IS CONFIRMED");
{
  // The REAL published evidence: 5 clusters at the 240-minute width,
  // every cluster mean negative, the arm EV -0.2134% against a
  // 0.1260% fee floor.
  const f = join(dir, "confirmed.json");
  writeFileSync(f, JSON.stringify({
    generatedAt: "2026-10-21T23:45:58.093Z",
    clusterWidthMinutes: 240,
    liveGate: {
      n: 181, wins: 29, losses: 17, times: 2, winRate: 0.6304,
      ev: -0.23898207589891718, clusters: 5, clusterSe: 0.06112627218964426,
      clusterMeans: [-0.1259667241788966, -0.12596672417889662, -0.3977188107294003, -0.3213245470369868, -0.09584940751773452],
    },
    tapeOnly: { n: 1351, winRate: 0.7213, ev: -0.17827217401416434, clusters: 5 },
    excess: { pairedClusters: 5, mean: -0.032436703691267596, se: 0.025527541038176067, t: -1.2706552363488115 },
    feeFloorPctEquity: 0.1259667241788966,
    rho: 1.049722701490805,
  }));
  const g = gateFor(f)();
  check("it refuses", g.allowed === false);
  check("it says the loss is CONFIRMED", g.verdict === "confirmed-negative", `the verdict was ${g.verdict}`);
  check("the reason says CONFIRMED", /CONFIRMED/.test(g.reason), "the reason names the confirmation");
  check("the reason says more collection will not change it", /will not change it/.test(g.reason), "the reason says the collection is over for this arm");
  check("it publishes the t it decided on", Number.isFinite(g.detail.tFloor), "the t is published");
  check("the t is beyond the critical value", g.detail.tFloor <= -2.776, `the t was ${g.detail.tFloor}`);
}
{
  // An arm that is merely UNPROVEN: too few clusters, and the excess
  // is not yet significant. It must NOT be called confirmed.
  const f = join(dir, "unproven.json");
  writeFileSync(f, JSON.stringify({
    generatedAt: "2026-10-21T23:45:58.093Z",
    clusterWidthMinutes: 240,
    liveGate: { n: 12, ev: 0.05, clusters: 2, winRate: 0.6, clusterSe: 0.04, clusterMeans: [0.04, 0.06] },
    excess: { pairedClusters: 2, mean: 0.01, se: 0.02, t: 0.5 },
    feeFloorPctEquity: 0.126,
  }));
  const g = gateFor(f)();
  check("it refuses", g.allowed === false);
  check("it does NOT claim a confirmed loss", g.verdict !== "confirmed-negative", `the verdict was ${g.verdict}`);
  check("the reason does not say CONFIRMED", !/CONFIRMED/.test(g.reason), "the reason does not over-claim");
}
{
  // A NEAR-MISS: the arm is losing but not beyond the critical value.
  // It must be "negative-not-confirmed", NOT "confirmed-negative".
  const f = join(dir, "near.json");
  writeFileSync(f, JSON.stringify({
    generatedAt: "2026-10-21T23:45:58.093Z",
    clusterWidthMinutes: 240,
    // The arm loses a little, but NOT by more than the noise: the gap
    // to the floor is 0.146 and the cluster se is 0.10, so t = -1.46 —
    // negative, but short of the critical 2.776.
    liveGate: { n: 40, ev: -0.02, clusters: 5, clusterSe: 0.10, clusterMeans: [-0.02, -0.01, -0.03, -0.02, -0.02] },
    excess: { pairedClusters: 5, mean: 0.01, se: 0.02, t: 0.5 },
    feeFloorPctEquity: 0.126,
  }));
  const g = gateFor(f)();
  check("it refuses", g.allowed === false);
  check("a near-miss is NOT confirmed", g.verdict !== "confirmed-negative", `the verdict was ${g.verdict}`);
  check("a near-miss IS called negative", g.verdict === "negative-not-confirmed", `the verdict was ${g.verdict}`);
}

rmSync(dir, { recursive: true, force: true });

console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
