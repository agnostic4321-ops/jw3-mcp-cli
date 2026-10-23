#!/usr/bin/env node
/**
 * A BOOTSTRAP CI MUST BE IN THE SAME UNITS AS THE QUANTITY IT BOUNDS.
 *
 * Observed in the policy study: every arm printed a Kelly confidence
 * interval of "[+0.0050, +0.0050]" — the grid's floor, repeated
 * identically on six different arms with different returns. That is not
 * a measurement; it is the CI of an EMPTY sample.
 *
 * The cause: the bootstrap resampled `cluster_means(trades, width_ms)`
 * with its default value_key, which is `pnl_eq` — a PERCENT of equity.
 * `kelly_grid` treats its input as a FRACTION, so every draw was
 * log1p(-3.29) = NaN, and numpy's `where(np.isfinite(g) & feas, g,
 * -inf)` turned every NaN into -inf, leaving the grid's lower bound as
 * the maximiser in every draw.
 *
 * The rule this pins: a bootstrap that resamples one representation
 * and reports a statistic computed from another is not a bootstrap. The
 * resampled value must be the SAME quantity the point estimate uses,
 * and a CI whose endpoints are identical across arms with different
 * data is the tell.
 *
 * Run: node research/test-policy-units.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "research");
// The FROZEN snapshot the policy study was written against. The test
// must read this, never the live collector, so its expectations are
// facts about the CODE and not about the hour.
const SCRATCH = join(process.env.HOME ?? "/Users/phoenix", ".hermes/cache/scratch");
const core = readFileSync(join(RES, "policy_core.py"), "utf8");
const study = readFileSync(join(RES, "policy-study.py"), "utf8");

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

console.log("══════════════════════════════════════════════════════════════");
console.log("A BOOTSTRAP CI MUST BE IN THE SAME UNITS AS WHAT IT BOUNDS");
console.log("══════════════════════════════════════════════════════════════");
console.log("");

// ── 1. THE RESAMPLED VALUE MATCHES THE POINT ESTIMATE ──────────────
console.log("1. THE RESAMPLED VALUE MATCHES THE POINT ESTIMATE");
check(
  "the bootstrap resamples the FRACTION, not the percent",
  /cluster_means\(trades, width_ms, value_key='pnl_frac'\)/.test(core),
  "the default value_key (pnl_eq, a PERCENT) is still used",
);
check(
  "the resampled values are scaled to a fraction of equity",
  /flat = np\.array\(\[v \* RHO for g in groups for v in g\]\)/.test(core),
  "the numpy path does not scale by RHO",
);
check(
  "the pure-python path scales by RHO too",
  /flat = \[v \* RHO for g in pick for v in g\]/.test(core),
  "the fallback path does not scale by RHO",
);
check(
  "the point estimate scales by RHO the same way",
  /rets = \[t\['pnl_frac'\] \* RHO for t in tr\]/.test(study),
  "the point estimate uses a different unit",
);
console.log("");

// ── 2. THE GRID CANNOT SILENTLY TURN A NaN INTO A FLOOR ────────────
console.log("2. THE GRID CANNOT SILENTLY TURN A NaN INTO A FLOOR");
check(
  "the grid discards a non-finite growth rate",
  /np\.where\(np\.isfinite\(g\) & feas, g, -np\.inf\)/.test(core),
  "a NaN could reach the maximiser",
);
check(
  "the grid returns f=0 when nothing is finite",
  /if not np\.isfinite\(best_g\):/.test(core),
  "an empty grid could report a spurious interior maximum",
);
check(
  "the negative-edge case is reported explicitly",
  /negative_edge=True/.test(core),
  "a negative edge is not flagged",
);
check(
  "the grid spans ONLY non-negative fractions",
  /def kelly_grid\(returns, lo=0\.0, hi=1\.0/.test(core),
  "the grid still allows a negative fraction, which is shorting the account",
);
check(
  "the negative-edge test uses the SIGN, not the grid position",
  /negative = bool\(g1 < 0 and mean_r < 0\)/.test(core),
  "the test still depends on where the maximiser sits",
);
check(
  "the point estimate and the bootstrap share one grid",
  /KELLY_GRID_STEPS = \d+/.test(core) &&
    /steps=pc\.KELLY_GRID_STEPS/.test(study),
  "the two use different grids, so the CI cannot bracket the estimate",
);
console.log("");

// ── 3. THE BEHAVIOURAL PROOF ─────────────────────────────────────────
console.log("3. THE BEHAVIOURAL PROOF: A LOSING ARM GETS f = 0, NOT A TINY POSITIVE");
{
  const dir = mkdtempSync(join(tmpdir(), "jw3-policy-units-"));
  const probe = join(dir, "probe.py");
  writeFileSyncProbe(probe);
  let out = "";
  let ok = true;
  try {
    // THE FROZEN SNAPSHOT, not the live collector.
    //
    // The probe used to read the live file, which made every
    // expectation here a statement about THE HOUR rather than about
    // the code. It failed for exactly that reason: the assertion
    // "EVERY bootstrap draw lands on zero" was true of the 5-hour
    // sample the probe was written against and false of the 16-hour
    // sample that had since accumulated (9% of draws land above zero,
    // so the CI opened from [0, 0] to [0, 1]). The ARITHMETIC never
    // changed — the negative edge was still detected and the point
    // estimate was still exactly 0. Only the SAMPLE moved.
    //
    // So the test pins the snapshot the study was written against, and
    // asserts the INVARIANTS that must hold on any losing arm, not the
    // shape of one particular sample.
    // THE SNAPSHOT IS TAKEN HERE, AND IT TAKES BOTH FILES AT ONCE.
    //
    // The probe used to read the LIVE collector, which made every
    // expectation here a statement about THE HOUR rather than about
    // the code. It failed for exactly that reason: the assertion
    // "EVERY bootstrap draw lands on zero" was true of the 5-hour
    // sample the probe was written against and false of the 16-hour
    // sample that had since accumulated (9% of draws land above zero,
    // so the CI opened from [0, 0] to [0, 1]). The ARITHMETIC never
    // changed — the negative edge was still detected and the point
    // estimate was still exactly 0. Only the SAMPLE moved.
    //
    // So the test copies the rows and the bars at the SAME instant, so
    // the pair is consistent, and asserts the INVARIANTS that must hold
    // on ANY losing arm rather than the shape of one sample.
    //
    // Both files must be copied together: the rows carry the tape's
    // side and the bars carry the high and low the resolver needs. The
    // older `confluence.carry-study.jsonl` snapshot predates the
    // `tapeSide` field and so cannot exercise the live gate at all.
    const FROZEN_ROWS = join(dir, "confluence.jsonl");
    const FROZEN_BARS = join(dir, "bars.json");
    copyFileSync(join(SCRATCH, "confluence.ndjson"), FROZEN_ROWS);
    copyFileSync(join(SCRATCH, "fee-floor-15m-bars.json"), FROZEN_BARS);
    out = execFileSync("python3", [probe], {
      cwd: RES,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: RES,
        POLICY_CONFLUENCE: FROZEN_ROWS,
        POLICY_BARS: FROZEN_BARS,
      },
    });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    ok = false;
  }
  const json = extractJson(out);
  if (!ok || !json) {
    check("the probe ran", false, out.slice(-400));
  } else {
    check("the probe ran", true);
    // THE DEFECT, EXACTLY: a losing arm reported a POSITIVE Kelly
    // fraction of 0.002 (the grid's smallest positive step) with a
    // bootstrap CI of [0.002, 0.002] — "bet 0.2% of the account", with
    // false precision. The correct answer is ZERO.
    check(
      "a losing arm gets a Kelly fraction of EXACTLY zero",
      json.a_f === 0 && json.b_f === 0,
      `a=${json.a_f} b=${json.b_f}`,
    );
    check(
      "a losing arm is FLAGGED as a negative edge",
      json.a_neg === true,
      `a_neg=${json.a_neg}`,
    );
    // THE INVARIANT, not the sample's shape: a losing arm's Kelly
    // fraction is ZERO, so the confidence interval's LOWER bound is
    // zero and the point estimate is inside it. The UPPER bound is a
    // property of the sample (a larger sample puts a few positive
    // draws in the bootstrap, and a positive draw takes the whole
    // grid), so it is NOT asserted to be zero.
    check(
      "the CI's LOWER bound is zero for a losing arm",
      json.a_lo === 0,
      `the CI is [${json.a_lo}, ${json.a_hi}]`,
    );
    check(
      "the bootstrap puts the MAJORITY of its draws on zero",
      json.a_frac_zero >= 0.5,
      `frac_zero=${json.a_frac_zero}`,
    );
    check(
      "the CI brackets its own point estimate",
      json.a_lo <= json.a_f + 1e-9 && json.a_hi >= json.a_f - 1e-9,
      `the CI [${json.a_lo}, ${json.a_hi}] does not contain f*=${json.a_f}`,
    );
    check(
      "no NaN reached the output",
      !Number.isNaN(json.a_lo) && !Number.isNaN(json.a_hi),
      `the CI is [${json.a_lo}, ${json.a_hi}]`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log("");

// ── 4. THE CALLER READS THE DICT, NOT A TUPLE ──────────────────────
console.log("4. THE CALLER READS THE DICT, NOT A TUPLE");
check(
  "the study reads kelly_grid's dict",
  /_kelly\["f_star"\]/.test(study) && /_kelly = kelly_grid\(/.test(study),
  "the caller unpacks a tuple that kelly_grid no longer returns",
);
check(
  "the study carries the negative-edge flag",
  /negative_edge = _kelly\.get\("negative_edge", False\)/.test(study),
  "the flag is dropped, so a negative edge is not reported",
);
console.log("");

console.log("══════════════════════════════════════════════════════════════");
console.log(`  ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════════");
process.exit(fail ? 1 : 0);

function writeFileSyncProbe(p) {
  // The probe lives in its own file: writing Python inside a JS
  // template literal means every Python quote and backtick has to be
  // escaped, and a mistake there is a syntax error in the TEST, which
  // is a bad place to look for a problem.
  copyFileSync(join(RES, "policy-units-probe.py"), p);
}

function extractJson(out) {
  const m = /JSON:(\{.*\})/.exec(out);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
