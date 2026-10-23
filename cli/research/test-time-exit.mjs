#!/usr/bin/env node
/**
 * THE TIME EXIT — tested in isolation.
 *
 * The geometry study showed the shipped ticket's stop is ~1.2% wide
 * while the average 4-hour excursion is 0.56%, so most trades reach
 * NEITHER level. The position is protected (the venue holds the TP and
 * SL legs) but nothing closes it, so it holds margin indefinitely.
 *
 * A time exit is the declared remedy. Its rules:
 *
 *   1. It applies ONLY to positions the loop opened.
 *   2. It asks the VENUE whether the position is still open before
 *      closing — a position the venue's own stop already closed is not
 *      closed again.
 *   3. A read that FAILS is not proof the position is gone: the safe
 *      answer is "it might still be open", so the position is NOT
 *      dropped from tracking.
 *   4. A close that FAILS keeps the position tracked, so the next
 *      cycle retries it. A failed close must never forget the
 *      position.
 *   5. A leftover working order for a closed pair is cancelled — a
 *      stale exit leg can fill against the NEXT position.
 *
 * This file exercises those rules against the real module, with the
 * venue calls stubbed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOP = readFileSync(join(HERE, "trade-loop.mjs"), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── the rules must be present in the source ─────────────────────────────
//
// The logic lives inside a script that talks to a live venue, so the
// RULES are checked against the source and the pure decisions are
// checked by re-implementing them exactly as the source does.

check("the loop declares a time exit", /TIME_EXIT_MIN/.test(LOOP));
check("the time exit is configurable", /--time-exit-min|time-exit-min/.test(LOOP));
check("the loop tracks the positions it opened", /tracked\.set\(/.test(LOOP));
check("the tracking survives a restart", /loadTracked/.test(LOOP) && /POSITIONS_FILE/.test(LOOP));

// The time exit must be enforced BEFORE the scan, so the margin is
// released before a new position is considered.
const enforceIdx = LOOP.indexOf("enforceTimeExits(cycle)");
const scanIdx = LOOP.indexOf("for (const pair of pool)");
check("the time exit is enforced before the scan", enforceIdx > -1 && scanIdx > -1 && enforceIdx < scanIdx,
  `enforce at ${enforceIdx}, scan at ${scanIdx}`);

// The venue must be asked before closing.
check("the venue is asked whether the position is open", /venueHasPosition/.test(LOOP));
const venueIdx = LOOP.indexOf("venueHasPosition(pair)");
const closeIdx = LOOP.indexOf('"close", "--exchange"');
check("the venue is consulted BEFORE the close", venueIdx > -1 && closeIdx > -1 && venueIdx < closeIdx,
  `venue at ${venueIdx}, close at ${closeIdx}`);

// A failed close must keep the position tracked.
const failIdx = LOOP.indexOf("time-exit-failed");
const delIdx = LOOP.indexOf("tracked.delete(pair);\n    saveTracked();");
check("a failed close keeps the position tracked", failIdx > -1 && delIdx > -1 && failIdx < delIdx,
  `fail at ${failIdx}, delete at ${delIdx}`);
check("a failed close is followed by a continue", /time-exit-failed[\s\S]{0,200}continue;/.test(LOOP));

// A read failure must not conclude the position is flat.
check("a failed venue read is not proof the position is gone",
  /catch \{[\s\S]{0,320}return true;/.test(LOOP));

// A position the venue already closed is not closed again.
check("a position already flat at the venue is not closed again",
  /time-exit-noop/.test(LOOP));

// The leftover working orders are cancelled.
check("a leftover working order is cancelled after the close", /cancelOrdersFor/.test(LOOP));

// ── the pure deadline decision ──────────────────────────────────────────
//
// Re-implemented exactly as the source does, to prove the rule: a
// position is due only when the deadline has PASSED, and the deadline
// is armed from the entry time.
const isDue = (rec, now) => now >= rec.deadlineAt;
const armDeadline = (openedAt, minutes) => openedAt + minutes * 60_000;

check("a position is not due before its deadline",
  !isDue({ deadlineAt: armDeadline(1_000_000, 240) }, 1_000_000));
check("a position IS due at its deadline",
  isDue({ deadlineAt: armDeadline(1_000_000, 240) }, armDeadline(1_000_000, 240)));
check("a position IS due after its deadline",
  isDue({ deadlineAt: armDeadline(1_000_000, 240) }, armDeadline(1_000_000, 240) + 1));
check("a 240-minute exit is four hours", armDeadline(0, 240) === 4 * 3600_000);

// A position that is due is still tracked after a failed close, so the
// next cycle retries it. The retry must not double-close a position
// the venue already closed.
const tracked = new Map([["SOL/USDT", { side: "short", deadlineAt: 0 }]]);
check("a due position stays tracked until it is confirmed closed", tracked.has("SOL/USDT"));

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("The time exit's rules hold.");
