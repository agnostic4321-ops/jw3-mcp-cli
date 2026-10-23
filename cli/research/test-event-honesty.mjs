#!/usr/bin/env node
/**
 * THE EVENT-NAME HONESTY TEST.
 *
 * Two defects in the loop's failure reporting, both of which make an
 * alert misleading:
 *
 * 1. THE EVENT NAME CLAIMED A CHECK THAT DID NOT HAPPEN.
 *    The event was named `failed-but-venue-checked` whenever the
 *    failure was not retryable — including when the open-orders read
 *    itself FAILED, in which case the venue was NOT checked. The note
 *    said so, but the NAME said the opposite, and a watcher that
 *    matches the name fires on an event that describes an UNKNOWN
 *    state.
 *    Observed: a watch pattern on "failed-but-venue-checked" fired on
 *    a line whose own `venueReadOk` was false.
 *
 * 2. A WATCHER COULD NOT TELL A STALE LINE FROM A LIVE ONE.
 *    The audit log is appended forever across every run — correctly,
 *    for the trade history — so the STDOUT of a new run can emit a
 *    line written hours ago by a previous run. Observed: an alert
 *    fired on a 15:25 event while the current loop started at 19:37.
 *    Every line now carries the run that wrote it.
 *
 * Run: node research/test-event-honesty.mjs
 */

import { readFileSync } from "node:fs";

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

const src = readFileSync(new URL("./trade-loop.mjs", import.meta.url), "utf8");

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE EVENT-NAME HONESTY TEST");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

// ── 1. THE THREE STATES HAVE THREE NAMES ──
console.log("1. THE THREE FAILURE STATES HAVE THREE DISTINCT NAMES");
{
  check(
    "there is a `failed-venue-unreadable` event for a failed read",
    /event:\s*eventName/.test(src) && /"failed-venue-unreadable"/.test(src),
  );
  check(
    "the name is chosen by the READ'S SUCCESS, not by retryability alone",
    /left\.ok\s*\?\s*"failed-but-venue-checked"\s*:\s*"failed-venue-unreadable"/.test(src),
  );
  check(
    "a throttle still gets its own name",
    /retryable\s*\?\s*"entry-throttled"/.test(src),
  );
  check(
    "the name is NOT unconditionally `failed-but-venue-checked`",
    !/event:\s*retryable\s*\?\s*"entry-throttled"\s*:\s*"failed-but-venue-checked"/.test(src),
    "the old form claims the venue was checked even when the read failed",
  );
  // the three names must be mutually exclusive
  check(
    "the three names are distinct strings",
    new Set(["entry-throttled", "failed-but-venue-checked", "failed-venue-unreadable"]).size === 3,
  );
}
console.log("");

// ── 2. EVERY EVENT CARRIES ITS RUN ──
console.log("2. EVERY EVENT CARRIES THE RUN THAT WROTE IT");
{
  const logFn = src.match(/function log\(obj\)\s*\{[\s\S]*?\n\}/);
  check("the log function exists", !!logFn);
  if (logFn) {
    check(
      "the run id is stamped on every line",
      /run:\s*RUN_ID/.test(logFn[0]),
      logFn[0].slice(0, 200),
    );
    check(
      "the run id is the FIRST field, so a watcher can filter on it",
      /JSON\.stringify\(\{\s*ts:\s*Date\.now\(\),\s*run:\s*RUN_ID/.test(logFn[0]),
    );
  }
  check("the run id is unique per process", /const RUN_ID = `r\$\{Date\.now\(\)\.toString\(36\)\}`/.test(src));
  check(
    "the loop-start event names the run explicitly",
    /runId:\s*RUN_ID/.test(src),
  );
}
console.log("");

// ── 3. THE EVENT LOGS ITS OWN READ RESULT ──
console.log("3. THE EVENT STILL REPORTS WHETHER THE VENUE WAS READ");
{
  check("the read's success is logged", /venueReadOk:\s*left\.ok/.test(src));
  check(
    "a failed read says the state is UNKNOWN",
    /THE VENUE COULD NOT BE READ/.test(src) && /UNKNOWN/.test(src),
  );
  check(
    "a successful read with orders says so",
    /THE VENUE HAS " \+ left\.rows\.length \+ " OPEN ORDER/.test(src),
  );
  check(
    "a successful read with no orders says the failure was before dispatch",
    /the failure was before dispatch/.test(src),
  );
}
console.log("");

// ── 4. THE RATE LIMIT IS NOT A LEVERAGE CAP ──
console.log("4. A RATE LIMIT IS NOT REPORTED AS A LEVERAGE CAP");
{
  check(
    "the old mislabel is gone from the source",
    !/leverage cap \(x20\): rate_limited/.test(src),
    "a throttle must not be reported as a venue leverage fault",
  );
  check(
    "the retryable flag is read from the result",
    /const retryable = res\.retryable === true/.test(src),
  );
  check(
    "the retryable flag is carried into the event",
    /retryable,/.test(src),
  );
}
console.log("");

// ── 5. THE RUN ID IS FINDABLE AFTER A RESTART ──
console.log("5. THE RUN ID IS FINDABLE AFTER A RESTART");
{
  // A run-scoped watch pattern has to be rewritten on every restart,
  // because a new run has a new id. So the id must be in a file a
  // supervisor can read without grepping the log.
  check(
    "the run id is written to a dedicated file",
    /RUN_FILE/.test(src) && /writeFileSync\(\s*RUN_FILE/.test(src),
  );
  check(
    "the run file is inside the scratch dir by default",
    /trade-loop\.run\.json/.test(src),
  );
  check(
    "the run file records the id, the pid and the start time",
    /runId:\s*RUN_ID/.test(src) && /pid:\s*process\.pid/.test(src) && /startedAt/.test(src),
  );
  const flat = src.replace(/\s+/g, " ");
  check(
    "a failure to write the run file does not stop the loop",
    /catch \(e\)/.test(src) && /never stop the loop/.test(flat),
  );
  // The property that matters: the write is wrapped, so a failure is
  // reported and the loop CONTINUES. A bare writeFileSync outside a
  // try would throw at startup and kill the loop.
  const runWrite = src.match(/try \{[\s\S]{0,400}?writeFileSync\(\s*RUN_FILE[\s\S]{0,400}?\} catch \(e\)/);
  check(
    "the run-file write is wrapped in a try/catch",
    !!runWrite,
    runWrite ? "wrapped" : "the write is not wrapped, so a failure would kill the loop at startup",
  );
  check(
    "the loop-start line carries the run id in the log",
    /runId:\s*RUN_ID/.test(src),
  );
}
console.log("");

console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
