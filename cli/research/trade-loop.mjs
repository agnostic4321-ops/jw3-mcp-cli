#!/usr/bin/env node
/**
 * THE LIVE TRADER.
 *
 * A loop that runs the REAL `jw3 live` path — every gate, every refusal,
 * every size calculation — and lets it fire when the gates align. It does
 * not implement a second, looser version of the strategy: it calls the
 * same binary the operator would call, so what it fires is exactly what
 * a manual run would fire.
 *
 * WHAT IT DOES EACH CYCLE
 *   1. Scans the universe for a TAPE setup (the exhaustion signal).
 *   2. For each tape candidate, reads the two model legs.
 *   3. If the models agree with the tape, runs `jw3 live` on it.
 *   4. `jw3 live` re-reads everything fresh and either fires or refuses
 *      with a reason. The scanner records the reason either way.
 *
 * WHY IT RE-READS FRESH EVERY TIME
 *   The book imbalance flips. BOME's Laya leg went from short to flat
 *   within minutes because the order book changed. A scanner that
 *   decided on a stale read would fire on a setup that no longer exists.
 *
 * THE HARD RULES, IN CODE
 *   - One trade per cycle, ever. Not a burst.
 *   - The kill switch is checked before every cycle and honoured.
 *   - The scanner NEVER passes --yes unless the operator armed it with
 *     --armed. Without it, the scanner runs in observe mode and reports
 *     what it WOULD have fired.
 *   - Every cycle is logged, so the record shows what was considered and
 *     why it was not taken.
 *
 * USAGE
 *   node trade-loop.mjs --observe                 # report only, never fire
 *   node trade-loop.mjs --armed --yes             # fire when the gates align
 *   node trade-loop.mjs --armed --yes --pairs A/B,C/D
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tapeSideOf } from "./tape-signal.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisifySafe();
function promisifySafe() {
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
}

const HOME = homedir();
const argv = process.argv.slice(2);
// `has(n)` takes the FLAG NAME WITHOUT dashes. `has("--armed")` would look
// for the literal string "----armed" and never match — so `--armed --yes`
// silently left the loop in OBSERVE mode, and the loop reported
// "OBSERVE" while the operator believed it was armed.
const has = (n) => argv.includes(`--${n.replace(/^-+/, "")}`);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n.replace(/^-+/, "")}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const ARMED = has("--armed");

// ── THE DEPLOYMENT EVIDENCE GATE ──
//
// The machine's arm was measured, and the measurement says it LOSES:
// the corrected live-gate EV is -0.2111% of equity per trade against a
// +0.1260% fee floor, and the confirmation layer's excess over the tape
// control is -0.0241% at t=-2.29. The corrected sweep's best geometry
// rests on 3 independent clusters and passes exactly as often as a
// placebo with the direction flipped.
//
// So the machine stays ARMED — the collector keeps running, the gates
// keep evaluating, the audit trail keeps building — but it must not put
// REAL MONEY on a ticket that the project's own evidence says loses.
//
// WHAT THE GATE READS
//   ~/.hermes/cache/scratch/live-gate-ev.json, published by
//   research/live-gate-monitor.mjs. It is the arm's own measured
//   expectancy, the fee floor, the excess over the control, and the
//   independent cluster count.
//
// WHAT IT REQUIRES TO FIRE
//   - the measured net EV is ABOVE the fee floor
//   - the excess over the control is POSITIVE
//   - the independent cluster count has reached the bar
//
// WHAT IT DOES WHEN THE EVIDENCE IS NOT THERE
//   It REFUSES TO FIRE and says so. A missing or unreadable evidence
//   file is NOT a pass: the gate is fail-closed, because the one time
//   "no data" must mean "fire" is the time it costs real money.
//
// The gate can be overridden with --evidence-gate=off for an operator
// who has decided to take the ticket regardless — and the override is
// recorded in the log, so the audit trail shows the trade was fired
// against its own measured evidence.
const EVIDENCE = flag("evidence", join(HOME, ".hermes/cache/scratch/live-gate-ev.json"));
const EVIDENCE_GATE = (flag("evidence-gate", "on") || "on").toLowerCase() !== "off";
const EVIDENCE_MIN_CLUSTERS = Number(flag("evidence-min-clusters", 30));
// The ticket's holding period, in minutes. The evidence's cluster width
// must be at least this: a narrower cluster counts one trade several
// times. The live path's time exit is 240 minutes, and the research
// ticket resolves over 16 x 15m bars = 240 minutes.
const EVIDENCE_CLUSTER_MINUTES = Number(flag("evidence-cluster-minutes", 240));

/**
 * Read the arm's published evidence and decide whether it may fire.
 * @returns {{allowed: boolean, reason: string, detail: object}}
 */
function evidenceGate() {
  if (!EVIDENCE_GATE) {
    return { allowed: true, reason: "the evidence gate is OFF (the operator took the ticket regardless)", detail: { overridden: true } };
  }
  if (!existsSync(EVIDENCE)) {
    return {
      allowed: false,
      reason: `the evidence gate: no published evidence at ${EVIDENCE} — refusing to fire (the gate is fail-closed)`,
      detail: { missing: true },
    };
  }
  let pub;
  try {
    pub = JSON.parse(readFileSync(EVIDENCE, "utf8"));
  } catch (e) {
    return {
      allowed: false,
      reason: `the evidence gate: the published evidence is unreadable — refusing to fire (${e.message})`,
      detail: { unreadable: true },
    };
  }
  const live = pub.liveGate || {};
  const excess = pub.excess || {};
  const floor = pub.feeFloorPctEquity ?? 0;
  const ev = live.ev ?? NaN;
  const clusters = live.clusters ?? 0;
  const ex = excess.mean ?? NaN;
  const problems = [];
  if (!Number.isFinite(ev)) problems.push("the measured EV is not a number");
  else if (ev <= floor) problems.push(`the measured EV ${ev.toFixed(4)}% of equity is not above the ${floor.toFixed(4)}% fee floor`);
  if (!Number.isFinite(ex)) problems.push("the excess over the control is not a number");
  else if (ex <= 0) problems.push(`the excess over the control is ${ex.toFixed(4)}% of equity, not positive`);
  if (clusters < EVIDENCE_MIN_CLUSTERS) problems.push(`${clusters} independent clusters, the bar is ${EVIDENCE_MIN_CLUSTERS}`);
  // THE CLUSTER WIDTH MUST BE THE TICKET'S HOLDING PERIOD.
  //
  // The ticket resolves over 240 minutes, so two signals inside one
  // 4-hour window share the same entry, the same path and the same
  // exit — ONE trade seen twice. A cluster count at the collector's
  // 5-minute round therefore counts the same trade several times, and a
  // bar of 30 met at 5 minutes is a bar of about 3 at the width the
  // trade is actually held.
  //
  // So the evidence must SAY which width it used, and if that width is
  // not the ticket's holding period the evidence is not about this
  // ticket at all. A missing width is treated as a failure, not as a
  // pass: the publisher always writes it now.
  const width = pub.clusterWidthMinutes;
  if (!Number.isFinite(width)) {
    problems.push("the evidence does not say which cluster width it used");
  } else if (width < EVIDENCE_CLUSTER_MINUTES) {
    problems.push(
      `the evidence clustered at ${width} minutes, but the ticket holds ${EVIDENCE_CLUSTER_MINUTES} minutes — ` +
        `its ${clusters} clusters are not independent`,
    );
  }
  // IS THE ARM CONFIRMED-NEGATIVE, OR JUST NOT YET PROVEN?
  //
  // Both refuse, but they are different facts and the operator needs to
  // know which: one is waiting on collection time, the other is waiting
  // on a change of STRATEGY, because no amount of more data will make a
  // confirmed loss into a fee-clearing edge.
  //
  // The test is the arm's own EV against the fee floor, on the cluster
  // means, at the ticket's holding-period width. If the arm is losing
  // by more than the critical t, the loss is confirmed and the
  // collection stops for THIS arm.
  const means = live.clusterMeans;
  const clusterSe = live.clusterSe;
  let verdict = "unproven";
  let tFloor = NaN;
  if (Array.isArray(means) && means.length >= 3 && Number.isFinite(clusterSe) && clusterSe > 0) {
    const k = means.length;
    const meanEv = means.reduce((a, b) => a + b, 0) / k;
    // the two-sided 95% critical value for k-1 degrees of freedom
    const T_CRIT = k <= 4 ? 3.182 : k <= 6 ? 2.776 : k <= 10 ? 2.262 : 2.131;
    tFloor = (meanEv - floor) / clusterSe;
    if (Number.isFinite(tFloor) && tFloor <= -T_CRIT) verdict = "confirmed-negative";
    else if (Number.isFinite(tFloor) && tFloor <= -1) verdict = "negative-not-confirmed";
  }
  const verdictNote =
    verdict === "confirmed-negative"
      ? ` — the arm's loss is CONFIRMED (t=${tFloor.toFixed(2)} against the fee floor on ${clusters} clusters at ${width ?? "?"}m), so more collection will not change it for this arm`
      : "";

  return {
    allowed: problems.length === 0,
    verdict,
    reason: problems.length
      ? `the evidence gate: ${problems.join("; ")} — refusing to fire${verdictNote}`
      : "the evidence gate: the arm's measured EV clears the fee floor, the excess is positive and the cluster bar is met",
    detail: { ev, floor, excess: ex, clusters, verdict, tFloor, publishedAt: pub.generatedAt },
  };
}
const YES = has("--yes");
const INTERVAL = Number(flag("interval", 120)) * 1000;
const RISK = flag("risk", "2");
const SIZE = flag("size", "15");
// The session is the LOOP's identity on the account. The turn is per
// attempt (see below) — a constant turn would make every later intent
// for the same shape dedupe against the first.
const SESSION = flag("session", "loop");
const MAX_CYCLES = Number(flag("max-cycles", 0));
const PAIRS = flag("pairs", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOG = flag("log", join(HOME, ".hermes/cache/scratch/trade-loop.ndjson"));
/**
 * The TIME EXIT, in minutes.
 *
 * ── WHY A POSITION NEEDS ONE ──
 *
 * The geometry study measured the average 4-hour excursion on these
 * symbols at 0.31% up and 0.56% down, while the shipped stop is ~1.2%
 * wide. So at the shipped geometry, 84% of trades reach NEITHER the
 * target nor the stop inside four hours.
 *
 * The live path arms venue-native TP and SL legs, so such a position
 * is PROTECTED — it is not naked. But nothing closes it: the daemon's
 * own rule is that "no path flattens a position by itself". So an
 * unresolved position holds margin indefinitely, and with
 * `maxOpenPositions: 3` the machine would eventually be unable to
 * trade at all.
 *
 * A time exit is a DECLARED exit, not a panic flatten. It is part of
 * the entry intent, it applies only to positions this loop opened, and
 * it is the same kind of exit as the stop — just on a clock.
 */
const TIME_EXIT_MIN = Number(flag("time-exit-min", 240));
// A THROTTLE, recognised from its MESSAGE. The CLI's own classification
// is the primary source (a JSON body carrying `retryable: true`), but
// when the failure escapes the command's handler the message is the
// only thing left — and it arrives as plain text on stderr.
const THROTTLE_RE = /rate[_ ]?limit|too many requests/i;
/** The tracked positions this loop opened, with their time-exit deadlines. */
const POSITIONS_FILE = flag("positions", join(HOME, ".hermes/cache/scratch/trade-loop-positions.json"));
const UNIVERSE_FILE = flag("universe", join(HOME, ".hermes/cache/scratch/universe.json"));

mkdirSync(join(HOME, ".hermes/cache/scratch"), { recursive: true });
if (!existsSync(LOG)) writeFileSync(LOG, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jw3(args, timeoutMs = 120000) {
  const { stdout } = await exec("env", ["-u", "JW3_CONFIG_HOME", "jw3", ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// ── RATE LIMIT DISCIPLINE ──
//
// The MCP server allows 60 calls per minute per user, and the LIVE PATH
// makes about ten of them per attempt (balances, positions, orders,
// risk limits, the entry, the exits, then a second account read to
// verify). A scanner that tries ten pairs in a row bursts straight
// through that budget, and the call that gets throttled is the one that
// arms the STOP — leaving a leveraged position with no protection.
//
// So the loop paces itself: it counts every call it makes and waits
// when it nears the server's budget. A missed trade is cheap; a naked
// leveraged position is not.
let CALLS = 0;
let WINDOW_START = Date.now();
const WINDOW_MS = 60_000;
const CALL_BUDGET = 45; // stay under the server's 60
const MIN_GAP_MS = 120;

async function pacedJw3(args, timeoutMs = 120000) {
  const now = Date.now();
  if (now - WINDOW_START > WINDOW_MS) {
    WINDOW_START = now;
    CALLS = 0;
  }
  if (CALLS >= CALL_BUDGET) {
    const wait = WINDOW_MS - (now - WINDOW_START) + 500;
    // A PACING BACKOFF, not an alarm. The event name says so, so a
    // watcher on "budget reached" cannot fire on normal operation.
    log({ event: "rate-pace", note: `pacing backoff at ${CALLS}/${CALL_BUDGET} calls — waiting ${Math.round(wait / 1000)}s` });
    await sleep(wait);
    WINDOW_START = Date.now();
    CALLS = 0;
  }
  CALLS++;
  await sleep(MIN_GAP_MS);
  return jw3(args, timeoutMs);
}

/**
 * The RUN ID — a marker that says which run of the loop wrote a line.
 *
 * WHY
 * ---
 * The audit log is APPENDED FOREVER across every run: `if
 * (!existsSync(LOG)) writeFileSync(LOG, "")` creates it once and never
 * truncates it. That is right for the audit trail — the history of
 * every trade the machine ever made is worth keeping — but it means
 * the STDOUT of a new run can emit a line that was written hours ago
 * by a previous run.
 *
 * Observed: a watch pattern on "failed-but-venue-checked" fired on a
 * line from 15:25 while the current loop had started at 19:37. The
 * event was real but STALE, and an operator reading the alert would
 * have gone looking for a problem in a run that was no longer running.
 *
 * So every line carries the run that wrote it. A watcher can then
 * require the CURRENT run's id, and a stale line is identifiable
 * instead of merely old.
 */
const RUN_ID = `r${Date.now().toString(36)}`;

// THE RUN ID MUST BE FINDABLE AFTER A RESTART, because a watch
// pattern that is run-scoped has to be rewritten every time the
// process restarts. A pattern on a bare event NAME matches the
// PERSISTED stdout buffer of a dead run — observed: the same "FIRED"
// line (an AVAX short that opened and scratched three hours earlier)
// was delivered twice, hours apart, by a process that had already
// exited. So the run id is written to its own file, and the first
// line of the log carries it too.
const RUN_FILE = flag("run-file", join(HOME, ".hermes/cache/scratch/trade-loop.run.json"));
try {
  writeFileSync(
    RUN_FILE,
    JSON.stringify({ runId: RUN_ID, pid: process.pid, startedAt: Date.now(), startedAtIso: new Date().toISOString() }, null, 1),
  );
} catch (e) {
  // A missing run file only costs a stale watch pattern. It must
  // never stop the loop from running.
  console.error(`[loop] could not write the run file (${e.message}) — a watch pattern will have to be set by hand`);
}

function log(obj) {
  // TWO FORMS, ON PURPOSE.
  //
  // The AUDIT LOG keeps the plain event name — it is the trade
  // history, it is never truncated, and every tool that reads it
  // (the evidence gate, the power analysis, the studies) greps for
  // those names.
  //
  // The STDOUT line carries a RUN-SCOPED event name instead. The
  // stdout is what the desktop captures into the session's rolling
  // tail, and the tail is what the watch matcher scans — a bare event
  // name in the tail matches EVERY historical line of the same event
  // in that tail, and the matcher re-scans the tail every 5 seconds
  // for as long as the session is watched. So a session that dies with
  // a bare name in its tail re-fires the same historical line
  // forever: nine distinct injections of one 9-hour-old refusal were
  // observed for two dead sessions.
  //
  // The run-scoped name cannot match history — no other run's line
  // carries this run's id — and the run id is the first field, so
  // the pattern is trivially matchable.
  const { event, ...rest } = obj;
  const audit = JSON.stringify({ ts: Date.now(), run: RUN_ID, ...obj });
  appendFileSync(LOG, `${audit}\n`);
  const stdout = JSON.stringify({
    ts: Date.now(),
    run: RUN_ID,
    ...(event ? { event: `${RUN_ID}:${event}` } : {}),
    ...rest,
  });
  console.log(stdout);
}

/** The kill switch and the account state, read fresh. */
async function guard() {
  const out = await pacedJw3(["risk", "--json"], 60000);
  const d = JSON.parse(out);
  const data = d.data ?? d;
  const kill = data.killSwitch ?? data.kill_switch ?? data.killSwitchOn;
  const autonomy = data.autonomy ?? data.autonomyMode ?? data.autonomy;
  // The DAILY NOTIONAL BUDGET, so an exhausted day is refused LOCALLY.
  //
  // The server enforces this cap, and the client could not SEE it — so
  // the machine discovered the exhausted budget the expensive way, one
  // live call per candidate. Measured: 19 "Daily notional cap would
  // exceed $500" refusals in 20 minutes (AVAX 7, DOT 6, ARB 4, LINK
  // 2), each a full MCP round trip against the shared 60/min budget
  // that the stop-arming path also needs.
  //
  // A NULL cap means the server's FLOOR of $500 (risk-gate.ts), so a
  // NULL is a cap, not "unlimited" — the same rule as every other
  // null column.
  const RISK_FLOOR_MAX_DAILY_NOTIONAL_USD = 500;
  const used = Number(data.daily_notional_usd ?? 0);
  const cap = Number(data.max_daily_notional_usd ?? RISK_FLOOR_MAX_DAILY_NOTIONAL_USD);
  return { kill, autonomy, raw: data, dailyNotionalUsed: used, dailyNotionalCap: cap };
}

async function universe() {
  if (PAIRS.length) return PAIRS;
  try {
    return JSON.parse(readFileSync(UNIVERSE_FILE, "utf8")).map((b) => `${b}/USDT`);
  } catch {
    return ["SOL/USDT", "XBT/USDT", "ETH/USDT"];
  }
}

/**
 * The tape scan — which pairs even have an exhaustion setup right now.
 *
 * A NON-JSON BODY IS AN EMPTY RESULT, not a crash. The scanner answers
 * with the plain string "No gainers" when nothing is up, and
 * JSON.parse on that throws — which killed the whole cycle and made
 * the loop's error handler report a VENUE read failure ("no pair"),
 * sending the operator after a phantom venue fault.
 *
 * Observed live: a cycle died with `Unexpected token 'N', "No
 * gainers"... is not valid JSON` and the reconciliation then reported
 * that the venue could not be read, when in fact the venue was fine
 * and there was simply nothing to scan.
 */
async function tapeCandidates() {
  const out = await pacedJw3(["scan", "fade", "--exchange", "kucoin", "--min-chg", "2.5", "--limit", "20", "--json"], 120000);
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    // A scanner with nothing to report answers in prose. That is an
    // EMPTY candidate set, not an error.
    return [];
  }
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    pair: `${String(r.symbol).replace("USDTM", "")}/USDT`,
    chg: r.chg,
    offHighPct: r.offHighPct,
    offLowPct: r.offLowPct,
    atrPct: r.atrPct,
    sSig: r.sSig,
    lSig: r.lSig,
  }));
}

/** The two model legs, fresh. */
async function models(pair) {
  const out = await pacedJw3(["decide", "--pair", pair, "--exchange", "kucoin", "--json"], 120000);
  const d = JSON.parse(out);
  const st = d.state ?? {};
  const v = d.verdict ?? {};
  return {
    jev: st.jev ?? null,
    laya: { side: v.choice, confidence: v.confidence, reasons: v.reasons },
    tape: st.tape ?? null,
    book: st.book ?? null,
  };
}

/** The venue's own open orders for a pair — the book of record. */
async function openOrdersFor(pair) {
  const r = await openOrdersForChecked(pair);
  if (!r.ok) throw new Error(r.error ?? "the venue's orders could not be read");
  return r.rows;
}

/**
 * The venue's open orders, AND whether the read actually SUCCEEDED.
 *
 * ── WHY THE SUCCESS FLAG MATTERS ──
 *
 * The reconciliation after an error asks the venue whether a trade went
 * through. But the reconciliation reads can THROTTLE under the same
 * budget that caused the original error — and a throttled read returns
 * an empty list, which is indistinguishable from "the venue has no
 * orders".
 *
 * So an empty result from a FAILED read used to be reported as "the
 * error was before dispatch" — a false all-clear on a leveraged
 * position that may well have been filled. The venue is the book of
 * record, and "I could not read the book" is not "the book is empty".
 *
 * The success flag separates the two: an empty list from a SUCCESSFUL
 * read means flat; an empty list from a FAILED read means unknown, and
 * the caller must say so.
 */
/**
 * The venue's OPEN ORDERS for the WHOLE ACCOUNT, cached per cycle.
 *
 * ── WHY THIS EXISTS ──
 *
 * The pre-fire check read the orders ONCE PER PAIR. A cycle touches
 * ~17 pairs, so one cycle cost 17 order reads purely to check for
 * stale orders — and the order book is ACCOUNT-WIDE, so 16 of those
 * reads were for information one read already had.
 *
 * The cost was not latency, it was BUDGET: the account shares a
 * 60-call/minute budget with the machine, and the collector competes
 * for it too. The reads ran the budget down until the order read
 * itself began to fail with `rate_limited` — and a failed order read
 * is fail-CLOSED (the pair is skipped), so the throttle was silently
 * removing pairs from the scan.
 *
 * Observed: 36 `skipped-unreadable-orders` in 12 minutes, every one
 * of them a throttle, all of them correct behaviour (skip rather than
 * risk a duplicate order) and all of them a symptom.
 *
 * So: ONE account-wide read per cycle, cached, and every pair's check
 * answered from the cache. The read is still fail-closed — if it
 * fails, the cycle skips every pair rather than firing blind.
 */
let orderBookCache = { at: 0, rows: null, ok: false, error: null };

async function accountOrdersForChecked(maxAgeMs = 60000) {
  const now = Date.now();
  if (orderBookCache.rows !== null && now - orderBookCache.at < maxAgeMs) {
    return orderBookCache;
  }
  try {
    // No --pair: the account-wide book.
    const out = await pacedJw3(["orders", "--exchange", "kucoin", "--json"], 90000);
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : (parsed.orders ?? []);
    orderBookCache = { at: now, rows, ok: true, error: null };
  } catch (e) {
    orderBookCache = { at: now, rows: [], ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
  return orderBookCache;
}

/** The account-wide open orders for ONE pair, from the cached book. */
async function openOrdersForChecked(pair) {
  if (!pair) return { rows: [], ok: false, error: "no pair" };
  const book = await accountOrdersForChecked();
  if (!book.ok) return { rows: [], ok: false, error: book.error };
  const orders = (book.rows ?? []).filter((o) => o.pair === pair || o.symbol === pair);
  return {
    rows: orders.map((o) => ({ orderId: o.orderId, side: o.side, price: o.price, quantity: o.quantity, filled: o.filled, status: o.status })),
    ok: true,
    error: null,
  };
}

/** The venue's recent fills for a pair — the book of record. */
async function recentFillsFor(pair) {
  if (!pair) return [];
  try {
    const out = await pacedJw3(["fills", "--exchange", "kucoin", "--market", "futures", "--days", "1", "--limit", "10", "--json"], 90000);
    const rows = JSON.parse(out);
    const fills = rows.fills ?? [];
    return fills
      .filter((f) => f.symbol === pair)
      .map((f) => ({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee, execTime: f.execTime, orderId: f.orderId }));
  } catch {
    return [];
  }
}

/**
 * The venue's recent fills, AND whether the read actually SUCCEEDED.
 *
 * `sinceMs` bounds the result to activity AFTER that moment. Without
 * it, the venue's "recent fills" include trades from HOURS ago, and
 * the post-error reconciliation reports them as evidence that THIS
 * attempt went through — a false alarm that tells the operator to look
 * for a trade that never happened, and not to look for one that did.
 * (Observed: an error at 12:48 reported "THE VENUE SHOWS ACTIVITY" on
 * the strength of fills from 12:40 and 12:23.)
 */
async function recentFillsForChecked(pair, sinceMs = 0) {
  if (!pair) return { rows: [], ok: false, error: "no pair" };
  try {
    const out = await pacedJw3(["fills", "--exchange", "kucoin", "--market", "futures", "--days", "1", "--limit", "10", "--json"], 90000);
    const rows = JSON.parse(out);
    const fills = rows.fills ?? [];
    return {
      rows: fills
        .filter((f) => f.symbol === pair)
        .map((f) => ({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fee: f.fee, execTime: f.execTime, orderId: f.orderId }))
        // Only activity AFTER the attempt began.
        .filter((f) => !sinceMs || Number(f.execTime ?? 0) >= sinceMs),
      ok: true,
      error: null,
    };
  } catch (e) {
    return { rows: [], ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}


/**
 * The positions this loop opened, and when each must be closed.
 *
 * Persisted so a loop restart does not lose track of a position that
 * is still open — an untracked open position would be a position the
 * loop can never close.
 */
const tracked = new Map();

function loadTracked() {
  try {
    if (!existsSync(POSITIONS_FILE)) return;
    const raw = JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
    for (const [pair, rec] of Object.entries(raw ?? {})) {
      tracked.set(pair, rec);
    }
    if (tracked.size) {
      log({ event: "positions-recovered", count: tracked.size, pairs: [...tracked.keys()] });
    }
  } catch {
    // A corrupt state file must not stop the loop; the venue is the
    // book of record, so the reconciliation below re-derives it.
  }
}

function saveTracked() {
  try {
    writeFileSync(POSITIONS_FILE, JSON.stringify(Object.fromEntries(tracked), null, 2));
  } catch {
    /* the venue remains the book of record */
  }
}

/**
 * Close any tracked position whose time exit has passed.
 *
 * Only positions THIS loop opened are touched. The venue is consulted
 * first: if the position is already gone (the stop or the target
 * filled), the record is simply dropped.
 */
async function enforceTimeExits(cycle) {
  if (tracked.size === 0) return;
  const now = Date.now();
  for (const [pair, rec] of [...tracked.entries()]) {
    if (now < rec.deadlineAt) continue;
    log({ event: "time-exit-due", cycle, pair, side: rec.side, openedAt: rec.openedAt, note: "the position passed its time exit" });
    // Is it still open at the venue?
    const stillOpen = await venueHasPosition(pair);
    if (!stillOpen) {
      tracked.delete(pair);
      saveTracked();
      log({ event: "time-exit-noop", cycle, pair, note: "the position is already flat — the venue's own exit filled" });
      continue;
    }
    // Close it. The position is already protected by the venue's TP
    // and SL legs; this is the declared exit, executed.
    try {
      const out = await pacedJw3(
        ["close", "--exchange", "kucoin", "--pair", pair, "--side", rec.side, "--yes", "--json"],
        90000,
      );
      log({ event: "time-exit-closed", cycle, pair, side: rec.side, note: "closed on the time exit", result: String(out ?? "").slice(0, 200) });
    } catch (e) {
      log({ event: "time-exit-failed", cycle, pair, error: String(e?.message ?? e).slice(0, 160) });
      // Keep tracking it: an unclosed position must be retried, not
      // forgotten.
      continue;
    }
    // Any leftover working orders for that pair would be a stale exit
    // leg against a flat position — it can fill against the NEXT
    // position. Cancel them.
    await cancelOrdersFor(pair, cycle);
    tracked.delete(pair);
    saveTracked();
  }
}


/** Is there still a live position on this pair at the venue? */
async function venueHasPosition(pair) {
  try {
    const out = await pacedJw3(
      ["positions", "--exchange", "kucoin", "--pair", pair, "--json"],
      90000,
    );
    const rows = JSON.parse(out);
    if (Array.isArray(rows)) return rows.length > 0;
    // The wrapped shape.
    const venues = rows?.venues ?? [];
    for (const v of venues) {
      const data = v?.data;
      if (Array.isArray(data)) {
        if (data.length > 0) return true;
      } else if (Array.isArray(data?.data)) {
        if (data.data.length > 0) return true;
      }
    }
    return false;
  } catch {
    // A read that failed is NOT proof the position is gone. The safe
    // answer is "it might still be open", so the caller must not
    // conclude the position is flat.
    return true;
  }
}

/** Cancel the venue's working orders for a pair (a stale exit leg). */
async function cancelOrdersFor(pair, cycle) {
  try {
    // The LIST comes from the cached account-wide book, so a cancel
    // sweep costs one read per cycle rather than one per pair.
    const book = await accountOrdersForChecked();
    if (!book.ok) throw new Error(book.error ?? "the venue's orders could not be read");
    const list = (book.rows ?? []).filter((o) => o.pair === pair || o.symbol === pair);
    for (const o of list) {
      const id = o?.orderId;
      if (!id) continue;
      try {
        await pacedJw3(["cancel", "--exchange", "kucoin", "--order-id", String(id), "--yes", "--json"], 60000);
        log({ event: "order-cancelled", cycle, pair, orderId: id, note: "a stale exit leg against a closed position" });
      } catch (e) {
        log({ event: "order-cancel-failed", cycle, pair, orderId: id, error: String(e?.message ?? e).slice(0, 140) });
      }
    }
  } catch {
    /* best effort — the venue is the book of record */
  }
}

async function main() {
  const mode = ARMED && YES ? "ARMED (will fire)" : ARMED ? "ARMED but no --yes (observe only)" : "OBSERVE (will not fire)";
  log({ event: "loop-start", mode, armed: ARMED, yes: YES, intervalSec: INTERVAL / 1000, riskPct: RISK, sizeUsd: SIZE, runId: RUN_ID });
  // If the operator asked to arm and the loop is not armed, say so LOUDLY
  // and stop — a loop that silently observes while the operator believes
  // it is trading is worse than no loop.
  if (YES && !ARMED) {
    console.error("[loop] --yes was given without --armed. Refusing to run: this loop cannot fire. (Pass --armed --yes.)");
    log({ event: "loop-refused", reason: "--yes without --armed" });
    process.exit(2);
  }
  if (ARMED && !YES) {
    console.error("[loop] --armed was given without --yes. Refusing to run: --armed without --yes cannot fire, and pretending otherwise is how a loop ends up in a mode nobody chose.");
    log({ event: "loop-refused", reason: "--armed without --yes" });
    process.exit(2);
  }

  let cycle = 0;
  let fired = 0;
  // The pair currently being attempted. An error must reconcile the pair
  // it happened on, not an arbitrary one.
  let currentPair = "";
  // When the current attempt started, so the post-error reconciliation
  // can ignore activity from BEFORE it.
  let currentPairSince = 0;

  loadTracked();

  for (;;) {
    cycle++;
    try {
      // ── THE TIME EXIT ──
      // A position this loop opened, that has passed its declared
      // time exit, is closed. It runs BEFORE the scan so the margin
      // it holds is released before a new position is considered.
      await enforceTimeExits(cycle);
      // The evidence gate, evaluated ONCE per cycle. A refusal here
      // costs zero venue calls.
      // ── THE RECONCILER, ONCE PER CYCLE ──
      //
      // A trade that closes on its OWN — a venue-native stop or
      // take-profit filling on the venue's separate stop-order book —
      // never goes through the app's close path, so its notional is
      // never released, and the daily-notional counter keeps holding a
      // position that no longer exists.
      //
      // The release lives in the RECONCILER, which reads the venue's
      // closed trades, and the reconciler used to run ONLY AFTER a
      // successful fire. So a trade that closed and was followed by no
      // new fire leaked its notional forever.
      //
      // Observed live on 2026-10-21: the account was FLAT at 13:14 and
      // the counter still held the closed trades' notional, so 19
      // entries were REFUSED in 20 minutes — "Daily notional cap
      // would exceed $500" — for a budget that was actually free. The
      // refusals are not a risk decision; they are a leak.
      //
      // So the loop reconciles every cycle, and it does so BEFORE the
      // evidence gate: the reconcile is BOOKKEEPING, and the daily
      // counters must be released whether or not the machine is allowed
      // to trade. A gate that refuses first would leave the leak in
      // place for as long as the gate is closed.
      //
      // The reconciler is idempotent (the ledger is keyed on the
      // venue's own trade id), so running it every cycle is safe and
      // costs one read.
      try {
        const rec = await pacedJw3(["pnl-reconcile", "--exchange", "kucoin", "--days", "1", "--json"], 90000);
        const rd = JSON.parse(rec);
        // The reconciler's payload field names, verified against the
        // live tool: `counted` is the new losses recorded, and
        // `notionalReleasedUsd` is what the release gave back to the
        // daily budget.
        const counted = Number(rd.counted ?? 0);
        const released = Number(rd.notionalReleasedUsd ?? 0);
        if (counted > 0 || released > 0) {
          log({
            event: "reconciled",
            counted,
            releasedNotionalUsd: released,
            releasedFor: rd.notionalReleasedFor ?? [],
          });
        }
      } catch (e) {
        // A failed reconcile is NOT a reason to stop trading: the
        // budget check below is the server's own counter, so a stale
        // read can only make the loop refuse EARLIER, never fire
        // more. So this is a note, not a gate.
        log({ event: "reconcile-skipped", error: String(e?.message ?? e).slice(0, 140) });
      }

      const cycleEvidence = evidenceGate();
      if (!cycleEvidence.allowed) {
        log({ event: "evidence-gate", cycle, allowed: false, reason: cycleEvidence.reason, detail: cycleEvidence.detail });
        if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
        await sleep(INTERVAL);
        continue;
      }
      const g = await guard();
      if (g.kill === true || g.kill === "on" || g.kill === "true") {
        log({ event: "kill-switch", cycle, note: "the kill switch is ON — no trade this cycle" });
        if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
        await sleep(INTERVAL);
        continue;
      }

      // THE DAY'S NOTIONAL BUDGET, checked ONCE per cycle, before the
      // scan. The server will refuse the entry anyway; refusing it
      // here costs zero venue calls and keeps the shared budget for
      // the stop-arming path. The check is a refusal, not a gate on
      // the strategy: when the budget is spent, the day is over for
      // trading, and the collector keeps running.
      if (g.dailyNotionalUsed >= g.dailyNotionalCap) {
        log({
          event: "daily-budget-spent",
          cycle,
          usedUsd: g.dailyNotionalUsed,
          capUsd: g.dailyNotionalCap,
          note: "the day's notional budget is spent — no entry this cycle (the server would refuse it)",
        });
        if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
        await sleep(INTERVAL);
        continue;
      }

      const cands = await tapeCandidates();
      const univ = await universe();
      // The pool is the TAPE candidates. The universe is only a fallback
      // when the tape finds nothing — intersecting the two would silently
      // discard a tape setup on a symbol outside the saved list, which is
      // exactly the setup we want to see.
      const pool = cands.length
        ? cands.map((c) => c.pair).filter((p) => PAIRS.length === 0 || PAIRS.includes(p))
        : univ;

      log({
        event: "cycle",
        cycle,
        tapeCandidates: cands.length,
        pool: pool.length,
        pairs: pool.slice(0, 12),
      });

      for (const pair of pool) {
        currentPair = pair;
        // When THIS attempt started. The reconciliation after an error
        // must only consider activity AFTER this moment: the venue's
        // "recent fills" include trades from hours ago, and reporting
        // those as evidence that THIS attempt went through is a false
        // alarm — it tells the operator to look for a trade that never
        // happened, and not to look for one that did.
        currentPairSince = Date.now();
        // The account's own book, checked BEFORE the live path. The live
        // path's preflight also checks this, but a loop that reaches the
        // gate and is refused is a wasted cycle AND a risk of a duplicate
        // resting order. Check first, cheaply, from the venue.
        const existing = await openOrdersForChecked(pair);
        if (!existing.ok) {
          // The read FAILED. That is not proof the venue has no working
          // order on this pair — it is proof the venue could not be
          // read. Placing a second order on a pair that already has
          // one is a DUPLICATE RESTING ORDER, which is how the naked
          // orders happened in the first place.
          //
          // So the safe answer to "I could not read the book" is to
          // SKIP THE PAIR, not to assume it is empty.
          log({
            event: "skipped-unreadable-orders",
            cycle,
            pair,
            readError: existing.error,
            note: "the venue's orders could not be read — skipping this pair rather than risking a duplicate order",
          });
          continue;
        }
        if (existing.rows.length > 0) {
          log({
            event: "skipped-existing-order",
            cycle,
            pair,
            openOrders: existing.rows,
            note: "the venue already has a working order on this pair — not adding another",
          });
          continue;
        }

        let m;
        try {
          m = await models(pair);
        } catch (e) {
          log({ event: "model-read-failed", cycle, pair, error: String(e?.message ?? e).slice(0, 120) });
          continue;
        }
        const jev = m.jev;
        const laya = m.laya;
        if (!jev || !laya) continue;
        const agree =
          jev.side === laya.side &&
          (jev.side === "long" || jev.side === "short") &&
          !jev.uncertain;
        if (!agree) continue;

        log({
          event: "model-agreement",
          cycle,
          pair,
          side: jev.side,
          jev: jev.agreement,
          laya: laya.confidence,
          tape: m.tape,
          book: m.book,
          reasons: laya.reasons,
        });

        // ── THE TAPE PRE-CHECK (free) ──
        //
        // The live path refuses when the tape shows no exhaustion
        // setup, and that refusal is the machine's most common outcome
        // by a wide margin. The `decide` read already returned the tape,
        // so the pre-check costs NOTHING and it is exactly the live
        // path's own logic (the same thresholds as
        // src/kucoin.ts's fadeSignal / dipSignal).
        //
        // Without it, every model agreement costs a full `jw3 live`
        // round trip — which re-reads the tape, the book, the models,
        // the risk state and the venue, and then refuses. That is the
        // loop's biggest call cost and it buys nothing.
        //
        // It also sharpens the audit trail: the refusal reason is
        // recorded with the models' side attached, which is what made
        // the CONFLICT state visible (it turned out to be 81% of every
        // evaluation).
        const tapeSide = tapeSideOf(m.tape);
        if (!tapeSide) {
          log({
            event: "live-result",
            cycle,
            pair,
            side: jev.side,
            status: "no-trade",
            reason: "no trade: the tape shows no exhaustion signal (pre-check, no live call)",
          });
          continue;
        }
        if (tapeSide !== jev.side) {
          log({
            event: "live-result",
            cycle,
            pair,
            side: jev.side,
            status: "no-trade",
            reason: `no trade: the tape shows a ${tapeSide} exhaustion but the models say ${jev.side}`,
          });
          continue;
        }

        // The REAL path. It re-reads everything fresh and enforces the
        // bounce, the geometry, the sizing and every risk gate.
        //
        // The `--turn` is this attempt's IDENTITY. The server's dedupe
        // arbiter keys on session+turn+the trade's shape, so:
        //   - a RETRY of this attempt reuses the turn and dedupes
        //   - a LATER attempt uses a new turn and is a new intent
        // With a constant turn, the first fire for a given shape would
        // dedupe every later one forever — the server would correctly
        // refuse to double-fill, and the loop would never trade again.
        const turn = `c${cycle}-${Date.now().toString(36)}`;
        const args = [
          "live",
          "--pair", pair,
          "--exchange", "kucoin",
          "--side", jev.side,
          "--risk", RISK,
          "--size", SIZE,
          "--session", SESSION,
          "--turn", turn,
          "--json",
        ];
        if (ARMED && YES) args.push("--yes");
        // A THROTTLE MUST NOT BECOME A CYCLE ERROR.
        //
        // The CLI classifies a rate limit as `retryable: true` and
        // prints that classification as JSON — but the CLI ALSO exits
        // non-zero, and `jw3()` rejects on a non-zero exit. The
        // rejection carries stdout (execFile's error object has
        // `.stdout`), so the body IS available — the loop just never
        // read it, and the throw escaped to the cycle-error handler.
        //
        // So a throttle on the shared 60/min budget was reported as a
        // CYCLE ERROR, which is a fault, and which the watcher fires
        // on — for a condition that is a normal, retryable, DEFINITELY
        // BEFORE-DISPATCH refusal. The per-pair handler below already
        // had the right event name (`entry-throttled`); the throw
        // bypassed it.
        //
        // The fix: catch the throw HERE, recover the JSON body from the
        // error, and let the existing per-pair classification decide
        // the name. A throttle then reads as `entry-throttled`.
        let out;
        try {
          out = await pacedJw3(args, 180000);
        } catch (e) {
          // THE BODY CAN BE ON STDOUT **OR** STDERR, AND IT CAN BE
          // JSON **OR** PLAIN TEXT.
          //
          // Observed live on 2026-10-21: the throttle arrived as
          // `Failed: rate_limited: Rate limit exceeded — try again in
          // 60s` — the CLI's TOP-LEVEL handler writes that with
          // console.error, so it is PLAIN TEXT on STDERR, and stdout
          // was EMPTY. The fix recovered stdout and JSON.parsed it,
          // which failed on the empty string, so it RE-THREW and the
          // throttle landed in the cycle-error path again — the same
          // defect, one layer further out.
          //
          // So the body is read from BOTH streams, the JSON is tried
          // first, and a PLAIN-TEXT throttle is recognised by its
          // message. A throttle is a DEFINITIVELY-BEFORE-DISPATCH
          // refusal, so nothing was placed and the trade can be
          // retried; it is not a fault.
          const stdoutBody = String(e?.stdout ?? "");
          const stderrBody = String(e?.stderr ?? "");
          const body = stdoutBody.trim() ? stdoutBody : stderrBody;
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* the body is not JSON — fall through to the text check */
          }
          if (parsed && (parsed.retryable === true || parsed.status === "failed")) {
            // The CLI's own verdict, carried through. The per-pair
            // handler below classifies it, reconciles the venue, and
            // picks the event name.
            out = body;
          } else if (parsed === null && THROTTLE_RE.test(body)) {
            // A plain-text throttle. The CLI could not print its JSON
            // verdict because the failure escaped the command's own
            // handler, so the classification is reconstructed HERE —
            // from the same evidence the CLI would have used.
            out = JSON.stringify({
              status: "failed",
              retryable: true,
              reason: `entry was REFUSED before dispatch by the server's rate limit — no order was placed and the trade can be retried: ${body.trim().slice(0, 200)}`,
            });
          } else {
            throw e;
          }
        }
        let res;
        try {
          res = JSON.parse(out);
        } catch {
          res = { status: "unparsed", raw: out.slice(0, 400) };
        }
        log({ event: "live-result", cycle, pair, side: jev.side, ...res });

        if (res.status === "fired") {
          fired++;
          log({ event: "FIRED", cycle, pair, side: jev.side, orderId: res.orderId, ticket: res.ticket });
          // Track the position so its TIME EXIT can be honoured. The
          // loop is the owner of what it opened, and the deadline is
          // part of the entry intent.
          //
          // The side is recorded as the loop's own directional side
          // (`long`/`short`); the venue's position side is the same
          // thing for the close call.
          tracked.set(pair, {
            side: jev.side,
            openedAt: Date.now(),
            deadlineAt: Date.now() + TIME_EXIT_MIN * 60_000,
            orderId: res.orderId ?? null,
            timeExitMin: TIME_EXIT_MIN,
          });
          saveTracked();
          log({
            event: "time-exit-armed",
            cycle,
            pair,
            side: jev.side,
            timeExitMin: TIME_EXIT_MIN,
            deadlineAt: new Date(Date.now() + TIME_EXIT_MIN * 60_000).toISOString(),
            note: "the position must be closed by this deadline if neither level is reached",
          });
          // ONE trade per cycle, ever. A burst is not a strategy.
          break;
        }
        if (res.status === "failed") {
          // A FAILED fire can still have placed an order. The venue is the
          // book of record, so ASK IT — never infer from the status
          // string. A loop that trusts the status reports "no order" while
          // a naked order sits on the book.
          // The venue's OPEN ORDERS for this pair. An order from an
          // EARLIER attempt would be reported here too, so the note
          // says what the orders are, not that "a trade may have gone
          // through": the open-orders read carries no timestamp, so
          // the loop cannot tell which attempt an order belongs to.
          // What it CAN say is whether there is an order at all, and
          // whether the read succeeded.
          const left = await openOrdersForChecked(pair);
          // A RATE LIMIT is a refusal BEFORE dispatch: no order was
          // placed and the trade can be retried. Recording it as an
          // ordinary failure hides a retryable miss behind a venue
          // error, and the operator is left looking for a venue fault
          // that never happened.
          const retryable = res.retryable === true;
          // THE EVENT NAME MUST NOT CLAIM A CHECK THAT DID NOT HAPPEN.
          //
          // "failed-but-venue-checked" says the venue was asked. When
          // the open-orders read itself FAILED, the venue was NOT
          // checked, and the note says so — but the name still said it
          // was. A watcher that matches the NAME therefore fires on an
          // event that describes an UNKNOWN state, and an operator who
          // trusts the name believes the venue was consulted when it
          // was not.
          //
          // Three distinct states, three distinct names:
          //   entry-throttled        a rate limit: before dispatch, retryable
          //   failed-but-venue-checked  the venue was read: the state is known
          //   failed-venue-unreadable    the venue could NOT be read: UNKNOWN
          const eventName = retryable
            ? "entry-throttled"
            : left.ok
              ? "failed-but-venue-checked"
              : "failed-venue-unreadable";
          log({
            event: eventName,
            cycle,
            pair,
            side: jev.side,
            reason: res.reason,
            retryable,
            openOrders: left.rows,
            venueReadOk: left.ok,
            readError: left.error,
            note: !left.ok
              ? "THE VENUE COULD NOT BE READ (" + left.error + ") — the state of this pair is UNKNOWN. A trade may have been placed. Reconcile before the next cycle."
              : left.rows.length
                ? "THE VENUE HAS " + left.rows.length + " OPEN ORDER(S) ON THIS PAIR. The open-orders read carries no timestamp, so this cannot be attributed to this attempt — cancel the pair's orders and reconcile before the next cycle."
                : "the venue was read successfully and has no open orders on this pair — the failure was before dispatch.",
          });
        }
        await sleep(600);
      }
    } catch (e) {
      // An error here can mean a trade went through and the READ after it
      // failed. A throttle on the verification step is the common case:
      // the entry is filled and the exits are armed, and then the
      // confirm-read is throttled. The venue is the book of record, so
      // ASK IT before concluding anything.
      const errText = String(e?.message ?? e);
      // A RATE LIMIT is DEFINITIVELY before dispatch: the MCP server
      // applies the per-tool limit BEFORE the handler runs, so no order
      // can have been placed. Say so outright instead of escalating to
      // a venue check that can only produce a false alarm.
      const throttled = /rate[_ ]?limit|too many requests/i.test(errText);
      // Reconcile against the VENUE — but ASK WHETHER the reads
      // succeeded, and only consider activity AFTER this attempt
      // started. A throttled reconciliation returns an empty list,
      // which is indistinguishable from "the venue has no orders", and
      // the venue's "recent fills" include trades from hours ago.
      //
      // Reporting "the error was before dispatch" on the strength of a
      // read that FAILED is a false all-clear on a leveraged position
      // that may have been filled. And reporting activity from BEFORE
      // the attempt is a false ALARM on a trade that never happened.
      // "I could not read the book" is not "the book is empty", and
      // "this pair traded earlier" is not "this attempt traded".
      // DID THIS CYCLE EVER ATTEMPT A PAIR? The scan and the time exit
      // run BEFORE the per-pair loop, so a failure in either happens
      // with currentPair still empty. Reconciling then reads "no pair"
      // twice — a read that never HAPPENED, reported as a failed VENUE
      // read, with the note "A trade may have gone through."
      //
      // That is a false alarm on a leveraged account: it says the venue
      // is unreadable and a trade may be outstanding, when the cycle
      // died in a MARKET read and no order was ever attempted. So the
      // no-attempt case is reported as what it is, and the venue is
      // not read at all — an unnecessary read on the account's shared
      // budget, for a pair that does not exist.
      const attempted = Boolean(currentPair);
      const venue = attempted
        ? await openOrdersForChecked(currentPair)
        : { rows: [], ok: true, error: null };
      const fills = attempted
        ? await recentFillsForChecked(currentPair, currentPairSince)
        : { rows: [], ok: true, error: null };
      const readOk = venue.ok && fills.ok;
      const activity = venue.rows.length || fills.rows.length;
      log({
        event: "cycle-error",
        cycle,
        error: errText.slice(0, 300),
        venueOrders: venue.rows,
        recentFills: fills.rows,
        venueReadOk: venue.ok,
        fillsReadOk: fills.ok,
        readErrors: [venue.error, fills.error].filter(Boolean),
        attemptStartedAt: currentPairSince ? new Date(currentPairSince).toISOString() : null,
        // Whether an order was ever ATTEMPTED. A watcher can then tell
        // "the cycle died before any pair was tried" from "the cycle
        // died mid-attempt" without parsing the note.
        attempted,
        note: !attempted
          ? "NO ATTEMPT WAS MADE — the cycle failed before any pair was tried, so no order was placed and there is nothing to reconcile. The venue was not read and does not need to be."
          : throttled
            ? "RATE LIMITED — the server refused the call BEFORE dispatch, so no order was placed and nothing needs reconciling. The next cycle will retry."
            : !readOk
            ? "THE VENUE COULD NOT BE READ (" +
              [venue.error, fills.error].filter(Boolean).join("; ") +
              ") — the state of this pair is UNKNOWN. A trade may have gone through. Reconcile before the next cycle."
            : activity
              ? "THE VENUE SHOWS ACTIVITY ON THIS PAIR SINCE THIS ATTEMPT STARTED — a trade may have gone through despite this error. Reconcile before the next cycle."
              : "the venue was read successfully and shows no orders and no fills since this attempt started — the error was before dispatch.",
      });
    }

    if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
    await sleep(INTERVAL);
  }

  log({ event: "loop-end", cycles: cycle, fired });
}

main().catch((e) => {
  console.error(`[loop] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
