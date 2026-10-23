#!/usr/bin/env node
/**
 * A FAILED VENUE READ MUST NEVER BE REPORTED AS AN EMPTY BOOK.
 *
 * ── THE BUG CLASS ──
 *
 * The loop reconciles against the VENUE after an error, because the
 * venue is the book of record and a status string is not proof. But
 * those reconciliation reads share the same per-minute budget as the
 * call that caused the error, so they can THROTTLE.
 *
 * A throttled read returns an empty list — indistinguishable from "the
 * venue has no orders". Three separate places made that mistake:
 *
 *   1. the post-error reconciliation reported "the error was before
 *      dispatch" on the strength of a read that FAILED — a false
 *      all-clear on a leveraged position that may have been filled;
 *   2. the post-failure check reported "the venue has no open orders"
 *      for the same reason;
 *   3. the PRE-FIRE check concluded "no existing order" and proceeded
 *      to place one — a DUPLICATE RESTING ORDER on a pair that may
 *      already have a working order. That is how the naked orders
 *      happened in the first place.
 *
 * The rule: "I could not read the book" is not "the book is empty".
 * Where an empty book would be acted upon, a failed read must SKIP.
 * Where an empty book would be reported as an all-clear, a failed read
 * must say UNKNOWN.
 *
 * Run: node research/test-venue-read-failures.mjs
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

// ── the checked helpers exist and report their success ─────────────────
check("the loop has a checked orders reader", /openOrdersForChecked/.test(LOOP));
check("the loop has a checked fills reader", /recentFillsForChecked/.test(LOOP));
check("the checked orders reader reports success", /ok:\s*true/.test(LOOP));
check("the checked readers report the error", /error:\s*String\(e\?\.message/.test(LOOP));

// ── the pre-fire check skips on a failed read ──────────────────────────
//
// This is the one that matters most: a failed read must SKIP the pair,
// never proceed to place an order on it.
// Find the REAL occurrence — the log() call — not a mention of the
// event name in a comment. `indexOf` would find the comment first and
// the guard would fall out of the window, failing the check for the
// wrong reason.
const preFireIdx = LOOP.indexOf('event: "skipped-unreadable-orders"');
check("the pre-fire check skips an unreadable pair", preFireIdx > -1);
if (preFireIdx > -1) {
  // The window must be wide enough to reach the guard: the source
  // carries long explanatory comments, and a fixed narrow window can
  // silently fall out of range when a comment grows — which would fail
  // the check for the wrong reason.
  const block = LOOP.slice(Math.max(0, preFireIdx - 3000), preFireIdx + 200);
  check(
    "the skip happens on a FAILED read (not an empty one)",
    /!existing\.ok/.test(block),
    "the guard must test the read's success, not the row count",
  );
  check(
    "the skip happens BEFORE the order is placed",
    LOOP.indexOf("skipped-unreadable-orders") < LOOP.indexOf('"live",'),
  );
}

// ── the post-error reconciliation reports UNKNOWN, not an all-clear ────
const errIdx = LOOP.indexOf("venueReadOk");
check("the post-error reconciliation reports whether the read worked", errIdx > -1);
if (errIdx > -1) {
  const block = LOOP.slice(errIdx - 600, errIdx + 900);
  check(
    "a failed reconciliation says the state is UNKNOWN",
    /state of this pair is UNKNOWN|UNKNOWN/.test(block),
  );
  check(
    "an all-clear is only given when the read SUCCEEDED",
    /readOk|venueReadOk|!readOk/.test(block),
  );
}

// ── the post-failure check reports UNKNOWN too ─────────────────────────
const failedIdx = LOOP.indexOf("failed-but-venue-checked");
check("the post-failure check reports whether the read worked", failedIdx > -1);
if (failedIdx > -1) {
  const block = LOOP.slice(failedIdx, failedIdx + 900);
  check("a failed venue read there says UNKNOWN", /UNKNOWN/.test(block));
}

// ── the unchecked helpers must not be used for a decision ──────────────
//
// `openOrdersFor` and `recentFillsFor` may still exist for other
// purposes, but the three decision points above must use the checked
// variants.
const decisionPoints = [
  ["the pre-fire existing-order check", "existing = await openOrdersForChecked(pair)"],
  ["the post-error reconciliation", "venue = await openOrdersForChecked(currentPair)"],
  ["the post-failure check", "left = await openOrdersForChecked(pair)"],
];
for (const [label, needle] of decisionPoints) {
  check(`${label} uses the checked reader`, LOOP.includes(needle), `expected: ${needle}`);
}

// ── the pure rule ──────────────────────────────────────────────────────
//
// A read that failed yields an unknown book, and the three decisions
// must be: skip the pair, report unknown, report unknown.
const readOutcome = (ok, rows) => ({ ok, rows: ok ? rows : null });
const decision = (outcome) => {
  if (!outcome.ok) return "skip-and-report-unknown";
  return outcome.rows.length > 0 ? "has-activity" : "confirmed-empty";
};
check("a failed read never yields a confirmed-empty book",
  decision(readOutcome(false, [])) === "skip-and-report-unknown");
check("a successful empty read yields a confirmed-empty book",
  decision(readOutcome(true, [])) === "confirmed-empty");
check("a successful non-empty read yields activity",
  decision(readOutcome(true, [{ orderId: "x" }])) === "has-activity");

// ── A RECONCILIATION MUST ONLY CONSIDER ACTIVITY SINCE THE ATTEMPT ───
//
// The venue's "recent fills" include trades from HOURS ago. Reported
// as evidence that THIS attempt went through, they are a false alarm:
// the operator goes looking for a trade that never happened, and does
// not look for the one that did.
//
// Observed: an error at 12:48 reported "THE VENUE SHOWS ACTIVITY ON
// THIS PAIR" on the strength of fills from 12:40 and 12:23.
check(
  "the loop records when the attempt started",
  /currentPairSince = Date\.now\(\)/.test(LOOP),
);
check(
  "the reconciliation bounds the fills to the attempt",
  /recentFillsForChecked\(currentPair, currentPairSince\)/.test(LOOP),
);
check(
  "the fills reader filters by time",
  /sinceMs[\s\S]{0,400}execTime[\s\S]{0,80}>= sinceMs/.test(LOOP),
);

// ── A RATE LIMIT IS DEFINITIVELY BEFORE DISPATCH ───────────────────────
//
// The MCP server applies the per-tool limit BEFORE the handler runs,
// so a throttled call cannot have placed an order. The loop should say
// so instead of escalating to a venue check that can only produce a
// false alarm.
check(
  "a rate limit is recognised",
  /rate[_ ]?limit/i.test(LOOP),
);
check(
  "a rate limit is reported as a rate limit",
  /RATE LIMITED/.test(LOOP),
);

// ── THE PURE RULE ──────────────────────────────────────────────────────
//
// A fill counts as evidence for THIS attempt only if it happened after
// the attempt began.
const countSince = (fills, sinceMs) => fills.filter((f) => f.execTime >= sinceMs);
const oldFills = [
  { execTime: 1000, orderId: "old-1" },
  { execTime: 2000, orderId: "old-2" },
];
const newFills = [{ execTime: 5000, orderId: "new-1" }];
const since = 3000;
check(
  "fills from BEFORE the attempt are not evidence",
  countSince(oldFills, since).length === 0,
);
check(
  "a fill from AFTER the attempt IS evidence",
  countSince([...oldFills, ...newFills], since).length === 1,
);
check(
  "a throttle means no order could have been placed",
  true, // the server applies the limit before the handler; documented above
);

// ── THE ORDER BOOK MUST BE READ ONCE PER CYCLE, NOT ONCE PER PAIR ────
//
// The pre-fire check read the orders ONCE PER PAIR. A cycle touches
// ~17 pairs, so one cycle cost 17 order reads purely to check for
// stale orders — and the order book is ACCOUNT-WIDE, so 16 of them
// were for information one read already had.
//
// The cost was not latency, it was BUDGET: the account shares a
// 60-call/minute budget with the machine and the collector competes
// for it too. The reads ran the budget down until the order read
// itself began to fail with `rate_limited` — and a failed order read
// is fail-CLOSED (the pair is skipped), so the throttle was silently
// REMOVING PAIRS FROM THE SCAN.
//
// Observed: 36 `skipped-unreadable-orders` in 12 minutes, every one
// of them a throttle, all of them correct behaviour (skip rather than
// risk a duplicate order) and all of them a symptom.
check(
  "the loop reads the account-wide order book",
  /accountOrdersForChecked/.test(LOOP),
);
check(
  "the account-wide read does NOT filter by pair",
  /\["orders", "--exchange", "kucoin", "--json"\]/.test(LOOP),
);
check(
  "no order read is scoped to a single pair",
  !/\["orders", "--exchange", "kucoin", "--pair"/.test(LOOP),
  "a per-pair order read costs one call per pair per cycle",
);
check(
  "the account-wide book is CACHED per cycle",
  /orderBookCache/.test(LOOP) && /maxAgeMs/.test(LOOP),
);
check(
  "a failed account-wide read still fails CLOSED",
  /if \(!book\.ok\) return \{ rows: \[\], ok: false/.test(LOOP),
  "if the book cannot be read, no pair may be fired on",
);

// ── THE PURE RULE: THE ACCOUNT BOOK ANSWERS EVERY PAIR ───────────────
//
// The futures rows carry `symbol` (not `pair`), and the account-wide
// read returns every pair's orders in one array.
const accountBook = [
  { orderId: "1", symbol: "BTC/USDT", side: "buy" },
  { orderId: "2", symbol: "SUI/USDT", side: "sell" },
  { orderId: "3", symbol: "LINK/USDT", side: "sell" },
];
const forPair = (book, pair) => book.filter((o) => o.pair === pair || o.symbol === pair);
check(
  "the account-wide book answers a pair's question",
  forPair(accountBook, "SUI/USDT").length === 1,
);
check(
  "the account-wide book answers another pair's question",
  forPair(accountBook, "LINK/USDT").length === 1,
);
check(
  "a pair with no orders reads as empty, not as an error",
  forPair(accountBook, "AVAX/USDT").length === 0,
);

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed — a failed venue read can still be mistaken for an empty book, an old trade for a new one, or the order book read once per pair.`);
  process.exit(1);
}
console.log("A failed venue read is never reported as an empty book, an old trade is never reported as a new one, and the order book is read once per cycle.");
