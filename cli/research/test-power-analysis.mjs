// THE POWER ANALYSIS'S TESTS.
//
// The delegated power task failed with a connection error, and its
// harness survives in the scratch directory. It is worth recording
// what was wrong with it, because both errors are the kind this
// project has already paid for:
//
//   1. IT CLUSTERED AT 5-MINUTE BUCKETS (BUCKET_MS = 5 * 60_000) --
//      the collector's cadence, not the ticket's holding period. So
//      its "38 signal buckets" were NOT 38 independent clusters. The
//      width defect this project already corrected once, reintroduced
//      in a new harness.
//
//   2. ITS SE SCALING. The se of the mean at k clusters is
//      sqrt(var / k) -- and comparing that against the CURRENT se
//      instead of the variance makes the se at the current sample
//      TWICE as large as the truth, which makes the arm look "already
//      powered" and puts the clusters-needed at the sample in hand.
//      The first version of THIS file made exactly that mistake and
//      printed "4 clusters needed, 0 days to go" for an arm with 4
//      clusters and a negative effect.
//
// So the tests pin the three things that make a power number
// meaningful: the WIDTH, the SCALING, and the UNITS.
//
// Run: node research/test-power-analysis.mjs

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
};

const HERE = new URL(".", import.meta.url).pathname;
const src = readFileSync(join(HERE, "power-analysis.mjs"), "utf8");
const EV = join(homedir(), ".hermes/cache/scratch/live-gate-ev.json");

console.log("====================================================================");
console.log("THE POWER ANALYSIS'S TESTS");
console.log("====================================================================");
console.log("");

// -- 1. THE WIDTH --
console.log("1. THE WIDTH");
{
  check(
    "the analysis reads the width from the evidence file",
    /clusterWidthMinutes/.test(src),
    "the width is the ticket's holding period, never the collector's cadence",
  );
  // The check must look at CODE, not at the comment that names the
  // failed task's defect. Strip the comments first.
  const codeOnly = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  check(
    "it does NOT hard-code a 5-minute bucket",
    !/5 \* 60_000/.test(codeOnly) && !/BUCKET_MS/.test(codeOnly),
    "a 5-minute bucket is the collector's cadence -- the defect the failed task carried",
  );
  check(
    "the cluster means come from the evidence",
    /clusterMeans/.test(src),
  );
}
console.log("");

// -- 2. THE SCALING --
console.log("2. THE SCALING");
{
  check(
    "the se at k clusters scales as sqrt(obsVar / k)",
    /Math\.sqrt\(obsVar \/ k\)/.test(src),
    "the se of the mean of k cluster-differences is sqrt(variance / k)",
  );
  check(
    "it does NOT scale against the CURRENT se",
    !/obsSe \* Math\.sqrt\(1 \/ k\)/.test(src),
    "that makes the se at the current sample twice as large as the truth",
  );
  check(
    "the clusters-needed starts at the CURRENT count",
    /for \(let k = Math\.max\(2, nA\)/.test(src),
  );
}
console.log("");

// -- 3. THE UNITS --
console.log("3. THE UNITS");
{
  check(
    "the fee floor is NOT multiplied by 100 on read",
    !/feeFloorPctEquity \* 100/.test(src),
    "the evidence file already stores the fee floor as a PERCENT of equity",
  );
  check(
    "the EV is read as a percent of equity",
    /lg\.ev\.toFixed\(4\)/.test(src),
  );
  check(
    "the units are stated in the file's own comments",
    /already a percent of equity/.test(src),
  );
}
console.log("");

// -- 4. THE ARITHMETIC, from the live evidence --
console.log("4. THE ARITHMETIC, FROM THE LIVE EVIDENCE");
if (!existsSync(EV)) {
  check("the evidence file exists", false, EV);
} else {
  const ev = JSON.parse(readFileSync(EV, "utf8"));
  const A = ev.liveGate.clusterMeans ?? [];
  const B = ev.tapeOnly.clusterMeans ?? [];
  const nA = A.length;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const diffs = A.map((a, i) => a - (B[i] ?? mean(B)));
  const m = mean(diffs);
  const varOf = (a) => {
    if (a.length < 2) return 0;
    const mm = mean(a);
    return a.reduce((s, x) => s + (x - mm) ** 2, 0) / (a.length - 1);
  };
  const obsVar = varOf(diffs);
  const se = Math.sqrt(obsVar / nA);

  const out = execFileSync(process.execPath, [join(HERE, "power-analysis.mjs")], { encoding: "utf8" });
  check("the script runs", out.includes("THE POWER ANALYSIS"));

  const reported = /the excess: (-?[\d.]+)% of equity/.exec(out);
  check(
    "the reported excess matches the independent arithmetic",
    !!reported && Math.abs(Math.abs(Number(reported[1])) - Math.abs(m)) < 5e-5,
    `the script says ${reported?.[1]}, the arithmetic says ${m.toFixed(6)}`,
  );
  const repSe = /the se:\s+(-?[\d.]+)%/.exec(out);
  check(
    "the reported se matches sqrt(var / n)",
    !!repSe && Math.abs(Number(repSe[1]) - se) < 5e-5,
    `the script says ${repSe?.[1]}, the arithmetic says ${se.toFixed(6)}`,
  );
  const kObs = /at 80% power: (\d+) clusters/.exec(out);
  check(
    "the clusters needed to detect the observed effect EXCEEDS the current count",
    !!kObs && Number(kObs[1]) > nA,
    `the script says ${kObs?.[1]} and the current count is ${nA}`,
  );
  const t = /the t:\s+(-?[\d.]+)/.exec(out);
  check(
    "the reported t matches m / se",
    !!t && Math.abs(Number(t[1]) - m / se) < 0.02,
    `the script says ${t?.[1]}, the arithmetic says ${(m / se).toFixed(3)}`,
  );
  const fee = ev.feeFloorPctEquity;
  // The stored value IS a percent of equity (the publisher computes
  // ROUND_TRIP * RHO * 100), so 0.126 means 0.126% of equity. The
  // plausible band for a round-trip taker fee on a leveraged ticket is
  // 0.02% to 0.5% of equity.
  check(
    "the fee floor is a plausible percent of equity (0.02% to 0.5%)",
    fee > 0.02 && fee < 0.5,
    `it is ${fee}`,
  );
  check("the decision names the house bar of 30 clusters", /reaches 30, and/.test(out));
  check(
    "the decision states the days to the house bar",
    /to reach the 30-cluster house bar takes [\d.]+ days/.test(out),
  );
}
console.log("");
console.log("====================================================================");
console.log(fail === 0 ? `PASSED -- ${pass}/${pass + fail} checks` : `FAILED -- ${fail} of ${pass + fail} checks failed`);
console.log("====================================================================");
if (fail) process.exit(1);
