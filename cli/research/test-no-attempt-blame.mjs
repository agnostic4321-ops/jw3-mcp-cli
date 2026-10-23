#!/usr/bin/env node
/**
 * THE NO-ATTEMPT CASE MUST NOT BLAME THE VENUE.
 *
 * Observed live: a cycle died with
 *
 *   {"event":"cycle-error","cycle":1,
 *    "error":"Unexpected token 'N', \"No gainers\"... is not valid JSON",
 *    "venueOrders":[],"recentFills":[],"venueReadOk":false,
 *    "fillsReadOk":false,"readErrors":["no pair","no pair"],
 *    "attemptStartedAt":null,
 *    "note":"THE VENUE COULD NOT BE READ (no pair; no pair) — the state
 *            of this pair is UNKNOWN. A trade may have gone through."}
 *
 * Three things were wrong with that one line, and each is its own
 * failure mode:
 *
 * 1. THE VENUE WAS BLAMED FOR A MARKET READ. The scan runs BEFORE the
 *    per-pair loop, so the cycle died with no pair attempted. The
 *    reconciliation then asked for "no pair" twice and reported the
 *    answer — "no pair" — as a FAILED VENUE READ. The venue was fine.
 *    On a leveraged account this note says a trade may be outstanding
 *    and must be reconciled, when nothing was ever attempted.
 *
 * 2. THE NOTE CLAIMED A CHECK THAT DID NOT HAPPEN. "THE VENUE COULD
 *    NOT BE READ" names a read that was never made, and "A trade may
 *    have gone through" describes a risk that did not exist — the
 *    attempt never started.
 *
 * 3. THE EVENT WAS NOT WATCHED AT ALL. The loop's watch list covered
 *    FIRED, the two failed-venue states and entry-throttled — but not
 *    `cycle-error`, which is the loop's own failure event. So a cycle
 *    that died was SILENT, while a bare pattern on the event NAME
 *    matched a DEAD run's buffered stdout two hours later.
 *
 * The underlying cause (a scanner that answers in prose) was already
 * fixed in `tapeCandidates`; this test pins the two that were not.
 *
 * Run: node research/test-no-attempt-blame.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOP = readFileSync(join(HERE, "trade-loop.mjs"), "utf8");
const KEEPER = readFileSync(join(HERE, "watch-keep.mjs"), "utf8");

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
console.log("THE NO-ATTEMPT CASE MUST NOT BLAME THE VENUE");
console.log("══════════════════════════════════════════════════════════════");
console.log("");

// ── 1. The no-attempt case is DETECTED ──────────────────────────────
console.log("1. THE NO-ATTEMPT CASE IS DETECTED");
check(
  "the handler asks whether an attempt was made",
  /const attempted = Boolean\(currentPair\)/.test(LOOP),
  "no `attempted` flag",
);
check(
  "the flag is derived from the pair, not a guess",
  /attempted\s*\?\s*await openOrdersForChecked\(currentPair\)/.test(LOOP),
  "the venue read is not guarded by the flag",
);
check(
  "the fills read is guarded by the same flag",
  /attempted\s*\?\s*await recentFillsForChecked\(currentPair, currentPairSince\)/.test(LOOP),
  "the fills read is not guarded by the flag",
);
check(
  "the venue is NOT read when no attempt was made",
  /: \{ rows: \[\], ok: true, error: null \}/.test(LOOP),
  "the no-attempt branch still reads something",
);
console.log("");

// ── 2. The note states what actually happened ───────────────────────
console.log("2. THE NOTE STATES WHAT ACTUALLY HAPPENED");
const noteIdx = LOOP.indexOf("note: !attempted");
check("the no-attempt note comes FIRST in the ternary", noteIdx > 0, "the no-attempt branch is not first");
const noteBlock = noteIdx > 0 ? LOOP.slice(noteIdx, noteIdx + 400) : "";
check(
  "the no-attempt note says NO ATTEMPT WAS MADE",
  /NO ATTEMPT WAS MADE/.test(noteBlock),
  "the note does not name the state",
);
check(
  "the no-attempt note says there is nothing to reconcile",
  /nothing to reconcile/i.test(noteBlock),
  "the note does not say what to do",
);
check(
  "the no-attempt note says the venue was not read",
  /venue was not read/i.test(noteBlock),
  "the note does not say the venue is irrelevant",
);
check(
  "the venue-unreadable note is still reachable for a REAL attempt",
  /THE VENUE COULD NOT BE READ/.test(LOOP),
  "the real venue-unreadable note was removed",
);
// The phrase also appears in a COMMENT above the ternary, so the
// comparison must be against the ternary itself, not the whole file.
const noteTernary = noteIdx > 0 ? LOOP.slice(noteIdx, noteIdx + 1600) : "";
check(
  "the real venue-unreadable note is in the `attempted` branch",
  noteTernary.indexOf("THE VENUE COULD NOT BE READ") > 0,
  "the real note is not after the no-attempt branch",
);
console.log("");

// ── 3. The attempt state is LOGGED, not just the note ───────────────
console.log("3. THE ATTEMPT STATE IS LOGGED, not just the note");
// The field is `attempted,` — a shorthand property — so the test must
// accept the shorthand as well as `attempted: attempted`.
check(
  "the log carries whether an attempt was made",
  /attempted:\s*attempted/.test(LOOP) || /\n\s*attempted,\n/.test(LOOP),
  "the log has no `attempted` field",
);
check(
  "the log's `attempted` field is inside the cycle-error event",
  /event:\s*"cycle-error"[\s\S]{0,1200}attempted:\s*attempted/.test(LOOP) ||
    /event:\s*"cycle-error"[\s\S]{0,1200}\n\s*attempted,\n/.test(LOOP),
  "the field is not on the cycle-error event",
);
console.log("");

// ── 4. The event is WATCHED ─────────────────────────────────────────
console.log("4. THE EVENT IS WATCHED");
const eventsBlock = /events:\s*\[([^\]]*)\]/.exec(KEEPER);
check("the keeper has an event list", eventsBlock !== null);
const keeperEvents = eventsBlock ? eventsBlock[1] : "";
check(
  "the loop's cycle-error is on the watch list",
  /cycle-error/.test(keeperEvents),
  "a cycle that dies is silent",
);
check(
  "the watch list still covers the firing and the failed states",
  /FIRED/.test(keeperEvents) &&
    /failed-venue-unreadable/.test(keeperEvents) &&
    /failed-but-venue-checked/.test(keeperEvents) &&
    /entry-throttled/.test(keeperEvents),
  "an existing watch was dropped",
);
check(
  "the pattern is run-scoped, so a dead run's line cannot match",
  /`"event":"\$\{runId\}:\$\{e\}"`/.test(KEEPER),
  "the pattern must carry the run id in the EVENT NAME, which is what the stdout line carries",
);
check(
  "the run-scoped form is used WHEN a run id exists",
  /if \(runId\)/.test(KEEPER),
  "the run id is not consulted",
);
check(
  "a bare-name pattern is only used where it is SAFE — a live stdout stream",
  /if \(spec\.bareOk\) return spec\.events;/.test(KEEPER) && /return null;/.test(KEEPER),
  "the loop's audit log is never truncated, so a bare pattern on it matches all of history; the collectors write to a live stdout stream, so theirs is bounded by the process lifetime",
);
check(
  "the keeper NEVER installs a bare pattern for the trade-loop",
  /research\/trade-loop\.mjs[\s\S]{0,700}?bareOk:\s*true/.test(KEEPER) === false,
  "the loop's audit log is the trade history and is never truncated",
);
check(
  "a DEAD session's watch is cleared, so the desktop stops matching it",
  /entry\.watch_patterns = \[\]/.test(KEEPER) && /function isAlive\(/.test(KEEPER),
);
console.log("");

// ── 5. THE ROOT CAUSE STAYS FIXED ───────────────────────────────────
console.log("5. THE ROOT CAUSE STAYS FIXED");
check(
  "the scanner's prose answer is an empty set, not a crash",
  /JSON\.parse\(out\)[\s\S]{0,200}catch[\s\S]{0,160}return \[\]/.test(LOOP),
  "the prose parse is not guarded",
);
check(
  "the guard's comment still names the observed failure",
  /No gainers/.test(LOOP),
  "the regression comment was removed",
);
console.log("");

console.log("══════════════════════════════════════════════════════════════");
console.log(`  ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════════");
process.exit(fail ? 1 : 0);
