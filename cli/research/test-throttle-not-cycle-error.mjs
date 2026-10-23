/**
 * A THROTTLE ON THE LIVE PATH MUST NOT BECOME A CYCLE ERROR.
 *
 * Observed live: a `cycle-error` whose message was
 *
 *   Command failed: env -u JW3_CONFIG_HOME jw3 live --pair DOT/USDT
 *   --exchange kucoin --side short --risk 2 --size 15 --session loop
 *   --turn c15-mvhtidva --json --yes
 *   Failed: rate_limited: Rate limit exceeded — try again in 60s
 *
 * The CLI classifies a rate limit as `retryable: true` and prints that
 * classification as JSON. It ALSO exits non-zero, and the loop's
 * `jw3()` helper rejects on a non-zero exit — so the throw ESCAPED the
 * per-pair handler and landed in the cycle-error path, bypassing the
 * `entry-throttled` classification that already existed.
 *
 * So a normal, retryable, DEFINITELY-BEFORE-DISPATCH refusal on the
 * shared 60/min budget was reported as a FAULT, and the watcher fired
 * on it.
 *
 * This test pins the three properties:
 *   1. a throttled live attempt is logged as `entry-throttled`
 *   2. it is NOT logged as `cycle-error`
 *   3. the CLI's `retryable: true` survives the non-zero exit
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "research");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`      [PASS] ${name}`); }
  else { fail++; console.log(`      [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

const src = readFileSync(join(RES, "trade-loop.mjs"), "utf8");

console.log("════════════════════════════════════════════════════════════════════");
console.log("A THROTTLE ON THE LIVE PATH MUST NOT BECOME A CYCLE ERROR — the tests");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

console.log("1. THE LIVE ATTEMPT CATCHES THE THROW");
{
  // The catch must be AT the live attempt, not only at the cycle
  // level — a catch at the cycle level cannot classify a throttle as
  // `entry-throttled`, because that name is chosen per pair.
  const liveCall = src.indexOf('pacedJw3(args, 180000)');
  check("the live attempt call is present", liveCall > 0, "the call site was found");
  // The window must be the NEAREST try/catch before the call, not a
  // fixed span — a fixed span captured an EARLIER try and reported a
  // missing catch that was not missing. (The same defect class as the
  // fixed 900-character source window that failed when a comment grew.)
  const tryAt = src.lastIndexOf("try {", liveCall);
  const catchAt = src.indexOf("catch", tryAt);
  check(
    "the try sits immediately before the call",
    tryAt > 0 && liveCall - tryAt < 200,
    `the try is ${liveCall - tryAt} characters back`,
  );
  check(
    "the catch comes AFTER the call",
    catchAt > liveCall,
    `the catch is at ${catchAt} and the call at ${liveCall}`,
  );
  // The window must reach the END of the catch block. A FIXED offset
  // (the original 900 characters) reports a missing catch when a
  // COMMENT GREW — the same defect class as the fixed 900-character
  // window in another source-pattern test. So the block is measured by
  // its braces, not by a character count.
  let depth = 0;
  let catchEnd = catchAt;
  let seenBrace = false;
  for (let i = catchAt; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seenBrace = true;
    } else if (src[i] === "}") {
      depth--;
      if (seenBrace && depth === 0) {
        catchEnd = i + 1;
        break;
      }
    }
  }
  const before = src.slice(tryAt, catchEnd);
  check(
    "the live attempt is wrapped in a try/catch",
    /try\s*\{[\s\S]*?catch\s*\(e\)/.test(before),
    "the throw escapes the per-pair handler without a catch",
  );
  check(
    "the catch RECOVERS the body from the error's stdout",
    /e\?\.stdout|e\.stdout/.test(before),
    "execFile's error carries stdout, so the body is available",
  );
  check(
    "the catch keeps the CLI's own retryable verdict",
    /retryable\s*===\s*true/.test(before),
    "the throttle must be recognised by the CLI's own flag",
  );
  check(
    "a NON-throttle failure is re-thrown",
    /throw e;/.test(before),
    "an unclassifiable error must still reach the cycle handler",
  );
}

console.log("");
console.log("2. THE EVENT NAMES ARE DISTINCT");
{
  // The three states, three names. The throttle's name must be the
  // retryable one, and the cycle-error name must not be reachable for
  // a throttle.
  check(
    "the loop has an `entry-throttled` name",
    /"entry-throttled"/.test(src),
    "the retryable name is missing",
  );
  check(
    "the loop has a `failed-but-venue-checked` name",
    /"failed-but-venue-checked"/.test(src),
    "the known-state name is missing",
  );
  check(
    "the loop has a `failed-venue-unreadable` name",
    /"failed-venue-unreadable"/.test(src),
    "the unknown-state name is missing",
  );
  check(
    "the throttle name is chosen from the retryable flag",
    /eventName\s*=\s*retryable\s*\?\s*\n?\s*"entry-throttled"/.test(src),
    "the throttle is not selected by the retryable flag",
  );
}

console.log("");
console.log("3. THE CLI PRINTS THE CLASSIFICATION THE LOOP NEEDS");
{
  const live = readFileSync(join(HERE, "..", "src", "commands", "live.ts"), "utf8");
  check(
    "the live command reports a `retryable` flag",
    /retryable\??:\s*boolean/.test(live),
    "the live result has no retryable flag",
  );
  check(
    "the live command classifies a rate limit as retryable",
    /rate[_ ]?limit|too many requests/i.test(live),
    "the rate-limit pattern is missing",
  );
}

console.log("");
console.log("4. THE PLAIN-TEXT STDERR THROTTLE IS RECOVERED AT RUNTIME");
{
  // THE DEFECT THIS PINS. The observed throttle arrived as
  //   Failed: rate_limited: Rate limit exceeded — try again in 60s
  // which the CLI's TOP-LEVEL handler writes with console.error — so it
  // is PLAIN TEXT on STDERR, and stdout was EMPTY. A fix that recovers
  // stdout and JSON.parses it FAILS on the empty string, re-throws, and
  // the throttle lands in the cycle-error path again.
  //
  // The source-shape checks above cannot catch that, because the shape
  // is identical either way. So this section EXECUTES the
  // classification against the real error shape.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  // The exact classification the loop performs, extracted so it can be
  // exercised. If the loop's logic changes, this must change too — so
  // the test also asserts the loop's source carries the same pieces.
  const throttleRe = /rate[_ ]?limit|too many requests/i;

  const classify = (stdoutBody, stderrBody) => {
    const body = stdoutBody.trim() ? stdoutBody : stderrBody;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* not JSON */
    }
    if (parsed && (parsed.retryable === true || parsed.status === "failed")) {
      return { recovered: true, retryable: parsed.retryable === true, kind: "json" };
    }
    if (parsed === null && throttleRe.test(body)) {
      return { recovered: true, retryable: true, kind: "plain-text" };
    }
    return { recovered: false, retryable: false, kind: "rethrow" };
  };

  check(
    "the loop reads BOTH stdout and stderr",
    /stdoutBody[\s\S]{0,200}stderrBody/.test(src),
    "the loop does not read stderr",
  );
  check(
    "the loop has a plain-text throttle branch",
    /parsed === null && THROTTLE_RE\.test\(body\)/.test(src),
    "the plain-text branch is missing",
  );

  // the REAL error shape: plain text on stderr, stdout empty
  const plain = await new Promise((resolve) => {
    exec("/bin/sh", [
      "-c",
      "echo 'Failed: rate_limited: Rate limit exceeded — try again in 60s' 1>&2; exit 1",
    ]).then(
      () => resolve({ stdout: "", stderr: "" }),
      (err) => resolve({ stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") }),
    );
  });
  const plainResult = classify(plain.stdout, plain.stderr);
  check(
    "the plain-text throttle is RECOVERED (not re-thrown)",
    plainResult.recovered,
    "it was re-thrown -> the throttle becomes a cycle-error",
  );
  check(
    "the plain-text throttle is RETRYABLE",
    plainResult.retryable,
    "it was not marked retryable",
  );
  check(
    "it was recovered from the STDERR stream",
    plainResult.kind === "plain-text" && plain.stderr.length > 0,
    "the stderr body was not used",
  );

  // the JSON case must still work
  const jsonResult = classify(JSON.stringify({ status: "failed", retryable: true }), "");
  check(
    "the JSON verdict is still recovered",
    jsonResult.recovered && jsonResult.retryable && jsonResult.kind === "json",
    "the JSON path regressed",
  );

  // a GENUINE fault must still be re-thrown — a fix that recovers
  // everything would hide real errors
  const fault = classify("", "Failed: something genuinely broken");
  check(
    "a genuine fault is still RE-THROWN",
    !fault.recovered,
    "a real fault was swallowed",
  );
}

console.log("");
console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
