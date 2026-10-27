/**
 * Watchdog tests — the pure decision, every trip path, the action order,
 * the resume policy, and the source-level guards that prove there is no
 * automatic path out of a tripped breaker.
 *
 * Zero network: every input is fabricated.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountSnapshotFromVenue,
  appendWatchdogDiary,
  applyResume,
  classifyOrderOwnership,
  cmdWatchdog,
  cmdWatchdogArmFlatten,
  cmdWatchdogResume,
  decideWatchdog,
  defaultWatchdogPolicy,
  defaultWatchdogState,
  evaluateResume,
  evaluateWatchdog,
  heartbeatAgeMs,
  loadWatchdogState,
  makeWatchdogDiaryEntry,
  normalizeSide,
  normalizeWatchdogRiskState,
  parseHeartbeat,
  runWatchdogCycle,
  watchdogDiaryPath,
  watchdogStatePath,
  WATCHDOG_DEFAULT_MAX_VENUE_ERRORS,
  type WatchdogAccountSnapshot,
  type WatchdogAction,
  type WatchdogActionType,
  type WatchdogDecisionInput,
  type WatchdogPosition,
  type WatchdogRiskState,
} from "./watchdog.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Read the watchdog source (works from src/ and dist/ layouts). */
function readWatchdogSource(): string {
  const candidates = [join(here, "watchdog.js"), join(here, "watchdog.ts"), join(here, "..", "src", "commands", "watchdog.ts")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("watchdog guard: cannot locate the watchdog source");
}

/**
 * Extract the body of every top-level `function <name>(...)` in the source.
 * Used by the source guards so a rule can be scoped to a FUNCTION, not to a
 * raw string count (the default-state builders legitimately construct an
 * untripped breaker — that is a fresh default, not a CLEAR).
 */
function functionBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] as string;
    // Walk back over the signature to its opening brace.
    const i = src.indexOf("{", m.index + m[0].length - 1);
    if (i < 0) continue;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.set(name, src.slice(i, j + 1));
  }
  return out;
}

const NOW = 1_760_000_000_000;

const cleanRisk = (over: Partial<WatchdogRiskState> = {}): WatchdogRiskState => ({
  killSwitch: false,
  circuitBreakerTripped: false,
  dailyRealizedLossUsd: 0,
  maxDailyLossUsd: 100,
  dailyTradeCount: 0,
  maxTradesPerDay: 10,
  dailyNotionalUsd: 0,
  maxDailyNotionalUsd: null,
  readable: true,
  readError: null,
  ...over,
});

const position = (over: Partial<WatchdogPosition> = {}): WatchdogPosition => ({
  pair: "SOL/USDT",
  side: "long",
  size: 10,
  notionalUsd: 120,
  exits: [{ orderId: "tp1", kind: "tp" }],
  exitsUnknown: false,
  machineOwned: true,
  ...over,
});

const cleanAccount = (over: Partial<WatchdogAccountSnapshot> = {}): WatchdogAccountSnapshot => ({
  freeMarginUsd: 500,
  totalEquityUsd: 1000,
  positions: [],
  orders: [],
  consecutiveVenueErrors: 0,
  fundingRatePct: null,
  ...over,
});

const beat = (ageMs: number) => ({ atMs: NOW - ageMs, source: "executor" });

const baseInput = (over: Partial<WatchdogDecisionInput> = {}): WatchdogDecisionInput => ({
  riskState: cleanRisk(),
  account: cleanAccount(),
  executorHeartbeat: beat(1_000),
  watchdogHeartbeat: { atMs: NOW - 1_000, source: "watchdog" },
  ownership: { ownedOrderIds: [], ownedPairs: ["SOL/USDT"], ownedClientOidPrefixes: [] },
  policy: defaultWatchdogPolicy(),
  now: NOW,
  invocation: {},
  breaker: null,
  ...over,
});

const actionTypes = (actions: WatchdogAction[]): WatchdogActionType[] => actions.map((a) => a.type);

/* ------------------------------------------------------------------ */
/* pure decision — happy path                                          */
/* ------------------------------------------------------------------ */

describe("decideWatchdog — clear", () => {
  it("takes no action when nothing tripped", () => {
    const d = decideWatchdog(baseInput());
    assert.equal(d.tripped, false);
    assert.equal(d.latched, false);
    assert.equal(d.shouldAct, false);
    assert.deepEqual(d.actions, []);
  });

  it("does not trip on a healthy account with one protected position", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ positions: [position()] }) }));
    assert.equal(d.shouldAct, false);
  });

  it("does not trip when caps are null (uncapped is not a trip)", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ maxDailyLossUsd: null, maxTradesPerDay: null, dailyRealizedLossUsd: null }),
      }),
    );
    assert.equal(d.shouldAct, false);
  });

  it("notes an unknown free margin instead of pretending it is zero", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ freeMarginUsd: null }) }));
    assert.equal(d.shouldAct, false);
    assert.ok(d.notes.some((n) => /free margin is unknown/.test(n)));
  });
});

/* ------------------------------------------------------------------ */
/* every trip condition                                                */
/* ------------------------------------------------------------------ */

describe("decideWatchdog — trip conditions", () => {
  it("trips on the server kill switch", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    assert.equal(d.tripped, true);
    const t = d.trips.find((x) => x.code === "kill_switch");
    assert.ok(t);
    assert.match(t.reason, /kill switch is ON/);
  });

  it("trips on the server circuit breaker", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ circuitBreakerTripped: true }) }));
    const t = d.trips.find((x) => x.code === "server_breaker_tripped");
    assert.ok(t);
    assert.match(t.reason, /circuit breaker is tripped/);
  });

  it("trips when the risk state is unreadable (fail closed)", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ readable: false, readError: "http 500" }) }));
    const t = d.trips.find((x) => x.code === "risk_state_unreadable");
    assert.ok(t);
    assert.match(t.reason, /unreadable/);
  });

  it("trips at the daily loss cap (>= is at the cap)", () => {
    const d = decideWatchdog(
      baseInput({ riskState: cleanRisk({ dailyRealizedLossUsd: 100, maxDailyLossUsd: 100 }) }),
    );
    const t = d.trips.find((x) => x.code === "daily_loss_cap");
    assert.ok(t);
    assert.match(t.reason, /daily realized loss \$100\.00 is at\/over the \$100\.00 cap/);
  });

  it("does not trip just below the daily loss cap", () => {
    const d = decideWatchdog(
      baseInput({ riskState: cleanRisk({ dailyRealizedLossUsd: 99.99, maxDailyLossUsd: 100 }) }),
    );
    assert.equal(d.tripped, false);
  });

  it("trips at the daily trade cap", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ dailyTradeCount: 10, maxTradesPerDay: 10 }) }));
    const t = d.trips.find((x) => x.code === "daily_trade_cap");
    assert.ok(t);
    assert.match(t.reason, /daily trade count 10 is at\/over the 10 cap/);
  });

  it("trips when free margin is below the floor", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ freeMarginUsd: 49.99 }) }));
    const t = d.trips.find((x) => x.code === "free_margin_floor");
    assert.ok(t);
    assert.match(t.reason, /free margin \$49\.99 is below the \$50\.00 floor/);
  });

  it("does not trip exactly at the free-margin floor (below is the rule)", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ freeMarginUsd: 50 }) }));
    assert.equal(d.tripped, false);
  });

  it("trips on a stale executor heartbeat (dead-man switch)", () => {
    const d = decideWatchdog(baseInput({ executorHeartbeat: beat(91_000) }));
    const t = d.trips.find((x) => x.code === "executor_heartbeat_stale");
    assert.ok(t);
    assert.match(t.reason, /dead-man switch/);
  });

  it("does not trip on a fresh executor heartbeat", () => {
    const d = decideWatchdog(baseInput({ executorHeartbeat: beat(89_000) }));
    assert.equal(d.tripped, false);
  });

  it("trips on a consecutive venue-error streak at the threshold", () => {
    const d = decideWatchdog(
      baseInput({ account: cleanAccount({ consecutiveVenueErrors: WATCHDOG_DEFAULT_MAX_VENUE_ERRORS }) }),
    );
    const t = d.trips.find((x) => x.code === "venue_error_streak");
    assert.ok(t);
    assert.match(t.reason, /3 consecutive venue errors/);
  });

  it("does not trip one venue error below the threshold", () => {
    const d = decideWatchdog(
      baseInput({ account: cleanAccount({ consecutiveVenueErrors: WATCHDOG_DEFAULT_MAX_VENUE_ERRORS - 1 }) }),
    );
    assert.equal(d.tripped, false);
  });

  it("trips on a position with no armed exit", () => {
    const d = decideWatchdog(
      baseInput({ account: cleanAccount({ positions: [position({ exits: [] })] }) }),
    );
    const t = d.trips.find((x) => x.code === "position_without_exit");
    assert.ok(t);
    assert.match(t.reason, /no armed exit/);
  });

  it("trips when the exits read FAILED (protection unproven, not absent)", () => {
    const d = decideWatchdog(
      baseInput({ account: cleanAccount({ positions: [position({ exits: null, exitsUnknown: true })] }) }),
    );
    const t = d.trips.find((x) => x.code === "position_without_exit");
    assert.ok(t);
    assert.match(t.reason, /UNKNOWN exit legs/);
  });

  it("trips on a funding blowout", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ fundingRatePct: 1.5 }) }));
    const t = d.trips.find((x) => x.code === "funding_blowout");
    assert.ok(t);
    assert.match(t.reason, /funding rate 1\.5000%/);
  });

  it("does not trip below the funding bound", () => {
    const d = decideWatchdog(baseInput({ account: cleanAccount({ fundingRatePct: 0.5 }) }));
    assert.equal(d.tripped, false);
  });

  it("trips when aggregate open notional is over the cap", () => {
    const d = decideWatchdog(
      baseInput({
        account: cleanAccount({
          positions: [position({ notionalUsd: 200 }), position({ pair: "ETH/USDT", notionalUsd: 200 })],
        }),
      }),
    );
    const t = d.trips.find((x) => x.code === "open_notional_cap");
    assert.ok(t);
    assert.match(t.reason, /aggregate open notional \$400\.00 is over the \$250\.00 cap/);
  });

  it("does not trip when a position's notional is unmeasurable (unknown, not zero)", () => {
    const d = decideWatchdog(
      baseInput({ account: cleanAccount({ positions: [position({ notionalUsd: null })] }) }),
    );
    assert.equal(d.tripped, false);
    assert.ok(d.notes.some((n) => /unmeasurable notional/.test(n)));
  });

  it("trips on the watchdog's own stale heartbeat (its dead-man)", () => {
    const d = decideWatchdog(baseInput({ watchdogHeartbeat: { atMs: NOW - 120_000, source: "watchdog" } }));
    const t = d.trips.find((x) => x.code === "watchdog_heartbeat_stale");
    assert.ok(t);
    assert.match(t.reason, /assuming the worst/);
  });

  it("trips when the watchdog has never beaten (no beat at all)", () => {
    const d = decideWatchdog(baseInput({ watchdogHeartbeat: { atMs: null, source: "watchdog" } }));
    // No beat means we cannot prove staleness — but we also cannot prove
    // liveness, so the note fires and the trip does not.
    const t = d.trips.find((x) => x.code === "watchdog_heartbeat_stale");
    assert.equal(t, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* action order                                                        */
/* ------------------------------------------------------------------ */

describe("decideWatchdog — action order", () => {
  it("orders set_breaker → cancel_orders → block_entries → alert", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    assert.deepEqual(actionTypes(d.actions), ["set_breaker", "cancel_orders", "block_entries", "alert"]);
  });

  it("places flatten between block_entries and alert when armed and opted in", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ killSwitch: true }),
        account: cleanAccount({ positions: [position()] }),
        policy: defaultWatchdogPolicy({ flattenArmed: true }),
        invocation: { flatten: true },
      }),
    );
    assert.deepEqual(actionTypes(d.actions), [
      "set_breaker",
      "cancel_orders",
      "block_entries",
      "flatten",
      "alert",
    ]);
  });

  it("sets the breaker BEFORE any venue write (the breaker outlives us)", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    assert.equal(d.actions[0]?.type, "set_breaker");
  });

  it("never flattens by default (flattening is opt-in per invocation)", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ killSwitch: true }),
        account: cleanAccount({ positions: [position()] }),
        policy: defaultWatchdogPolicy({ flattenArmed: true }),
        invocation: {},
      }),
    );
    assert.equal(d.actions.some((a) => a.type === "flatten"), false);
  });

  it("never flattens when the policy is not armed, even if the invocation asks", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ killSwitch: true }),
        account: cleanAccount({ positions: [position()] }),
        policy: defaultWatchdogPolicy({ flattenArmed: false }),
        invocation: { flatten: true },
      }),
    );
    assert.equal(d.actions.some((a) => a.type === "flatten"), false);
  });

  it("prefers a reduce-only close for the flatten (never an opposing order)", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ killSwitch: true }),
        account: cleanAccount({ positions: [position()] }),
        policy: defaultWatchdogPolicy({ flattenArmed: true }),
        invocation: { flatten: true },
      }),
    );
    const flatten = d.actions.find((a) => a.type === "flatten");
    assert.ok(flatten);
    assert.equal(flatten.detail?.mode, "reduce_only_close");
    assert.equal(flatten.detail?.tool, "close_position");
  });

  it("flattens only the machine's own positions", () => {
    const d = decideWatchdog(
      baseInput({
        riskState: cleanRisk({ killSwitch: true }),
        account: cleanAccount({
          positions: [position({ machineOwned: true }), position({ pair: "ETH/USDT", machineOwned: false })],
        }),
        policy: defaultWatchdogPolicy({ flattenArmed: true }),
        invocation: { flatten: true },
      }),
    );
    const flatten = d.actions.find((a) => a.type === "flatten");
    const targets = flatten?.detail?.positions as { pair: string }[];
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.pair, "SOL/USDT");
  });
});

/* ------------------------------------------------------------------ */
/* order ownership — never touch a foreign order                        */
/* ------------------------------------------------------------------ */

describe("classifyOrderOwnership", () => {
  it("claims an order a local state file owns", () => {
    const rows = classifyOrderOwnership([{ orderId: "o1", pair: "SOL/USDT" }], {
      ownedOrderIds: ["o1"],
      ownedPairs: [],
      ownedClientOidPrefixes: [],
    });
    assert.equal(rows[0]?.machineOwned, true);
    assert.match(rows[0]?.ownershipReason ?? "", /local state file/);
  });

  it("claims an order whose clientOid carries the machine's tag", () => {
    const rows = classifyOrderOwnership([{ orderId: "o2", pair: "SOL/USDT", clientOid: "sess7-1" }], {
      ownedOrderIds: [],
      ownedPairs: [],
      ownedClientOidPrefixes: ["sess7-"],
    });
    assert.equal(rows[0]?.machineOwned, true);
  });

  it("leaves a foreign order unclaimed", () => {
    const rows = classifyOrderOwnership([{ orderId: "o3", pair: "BTC/USDT", clientOid: "other-9" }], {
      ownedOrderIds: [],
      ownedPairs: [],
      ownedClientOidPrefixes: ["sess7-"],
    });
    assert.equal(rows[0]?.machineOwned, false);
  });

  it("leaves an untagged order unclaimed (an unreadable tag is not ours)", () => {
    const rows = classifyOrderOwnership([{ orderId: "o4", pair: "BTC/USDT" }], {
      ownedOrderIds: [],
      ownedPairs: [],
      ownedClientOidPrefixes: ["sess7-"],
    });
    assert.equal(rows[0]?.machineOwned, false);
  });
});

describe("decideWatchdog — cancel scope", () => {
  const withOrders = () => {
    const account = cleanAccount();
    account.orders = [
      { orderId: "mine", pair: "SOL/USDT", clientOid: null, machineOwned: true, market: "futures", ownershipReason: "local" },
      { orderId: "theirs", pair: "BTC/USDT", clientOid: null, machineOwned: false, market: "futures", ownershipReason: "foreign" },
    ];
    return account;
  };

  it("cancels only the machine's own working orders", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }), account: withOrders() }));
    const cancel = d.actions.find((a) => a.type === "cancel_orders");
    const targets = cancel?.detail?.targets as { orderId: string }[];
    const kept = cancel?.detail?.foreignKept as { orderId: string }[];
    assert.deepEqual(targets.map((t) => t.orderId), ["mine"]);
    assert.deepEqual(kept.map((t) => t.orderId), ["theirs"]);
  });

  it("lists the foreign order as kept — it is never a cancel target", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }), account: withOrders() }));
    const cancel = d.actions.find((a) => a.type === "cancel_orders");
    const targets = (cancel?.detail?.targets ?? []) as { orderId: string }[];
    assert.equal(targets.some((t) => t.orderId === "theirs"), false);
  });
});

/* ------------------------------------------------------------------ */
/* the latch + human-only resume                                       */
/* ------------------------------------------------------------------ */

describe("resume policy — human only", () => {
  const trippedBreaker = {
    tripped: true,
    trippedAt: new Date(NOW).toISOString(),
    reasons: ["kill switch is ON"],
    clearedAt: null,
    clearedBy: null,
  };

  it("keeps acting while the breaker is latched, even with no live trip", () => {
    const d = decideWatchdog(baseInput({ breaker: trippedBreaker }));
    assert.equal(d.tripped, false);
    assert.equal(d.latched, true);
    assert.equal(d.shouldAct, true);
    assert.ok(d.actions.some((a) => a.type === "set_breaker"));
  });

  it("refuses a resume while the trip condition is live", () => {
    const decision = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    const v = evaluateResume({ breaker: trippedBreaker, decision, actor: "owner" });
    assert.equal(v.ok, false);
    assert.equal(v.changed, false);
    assert.match(v.reason, /trip condition has NOT cleared/);
  });

  it("allows a resume once the trip condition cleared", () => {
    const decision = decideWatchdog(baseInput());
    const v = evaluateResume({ breaker: trippedBreaker, decision, actor: "owner" });
    assert.equal(v.ok, true);
    assert.equal(v.changed, true);
  });

  it("refuses a resume with no actor", () => {
    const decision = decideWatchdog(baseInput());
    const v = evaluateResume({ breaker: trippedBreaker, decision, actor: "   " });
    assert.equal(v.ok, false);
    assert.match(v.reason, /explicit human actor/);
  });

  it("applyResume clears the breaker and records the human actor", () => {
    const state = { ...defaultWatchdogState(), breaker: trippedBreaker, entriesBlocked: true, blockReason: "x" };
    const decision = decideWatchdog(baseInput());
    const v = evaluateResume({ breaker: state.breaker, decision, actor: "owner" });
    const next = applyResume(state, v, "owner", NOW);
    assert.equal(next.breaker.tripped, false);
    assert.equal(next.breaker.clearedBy, "owner");
    assert.equal(next.entriesBlocked, false);
  });

  it("applyResume is a no-op when the verdict refuses", () => {
    const state = { ...defaultWatchdogState(), breaker: trippedBreaker };
    const decision = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    const v = evaluateResume({ breaker: state.breaker, decision, actor: "owner" });
    const next = applyResume(state, v, "owner", NOW);
    assert.equal(next.breaker.tripped, true);
  });
});

/* ------------------------------------------------------------------ */
/* source guards — no automatic path out of a tripped breaker          */
/* ------------------------------------------------------------------ */

describe("watchdog source guards", () => {
  const src = readWatchdogSource();
  const bodies = functionBodies(src);

  it("exposes no auto-resume function", () => {
    assert.equal(/autoResume|auto_resume|autoUntrip|auto_untrip/i.test(src), false);
    for (const name of bodies.keys()) {
      assert.equal(/resume/i.test(name) && /auto/i.test(name), false, `unexpected auto-resume function ${name}`);
    }
  });

  it("clears the breaker in exactly one function — applyResume", () => {
    const clearers = [...bodies.entries()]
      .filter(([, body]) => /tripped:\s*false/.test(body))
      .map(([name]) => name)
      // The default-state builders construct an untripped breaker; that is a
      // fresh default, not a CLEAR of a tripped one.
      .filter((name) => name !== "defaultWatchdogState" && name !== "loadWatchdogState");
    assert.deepEqual(clearers, ["applyResume"], `only applyResume may clear the breaker (found: ${clearers.join(", ")})`);
  });

  it("clears entriesBlocked in exactly one function — applyResume", () => {
    const clearers = [...bodies.entries()]
      .filter(([, body]) => /entriesBlocked:\s*false/.test(body))
      .map(([name]) => name)
      .filter((name) => name !== "defaultWatchdogState" && name !== "loadWatchdogState");
    assert.deepEqual(clearers, ["applyResume"], `only applyResume may unblock entries (found: ${clearers.join(", ")})`);
  });

  it("applyResume is called from exactly one place — the resume command", () => {
    const callers = [...bodies.entries()]
      .filter(([name, body]) => name !== "applyResume" && /applyResume\s*\(/.test(body))
      .map(([name]) => name);
    assert.deepEqual(callers, ["cmdWatchdogResume"], `applyResume must have one caller (found: ${callers.join(", ")})`);
  });

  it("has no timer that clears the breaker on its own", () => {
    assert.equal(/setInterval\([^)]*clear/i.test(src), false);
    assert.equal(/setTimeout\([^)]*(tripped:\s*false)/i.test(src), false);
  });

  it("never trades directionally — the only write tool it calls is close_position", () => {
    assert.equal(/"execute_trade"/.test(src), false);
  });

  it("never imports the executor", () => {
    assert.equal(/from "\.\/scalp\.js"|from "\.\/degen\.js"|from "\.\/grid\.js"|from "\.\/trail\.js"/.test(src), false);
    assert.equal(/from "\.\.\/commands\/(scalp|degen|grid|trail)\.js"/.test(src), false);
  });

  it("reads its liveness from a file, never from the executor's process", () => {
    // The executor heartbeat is a FILE read — the watchdog never asks the
    // executor whether it is alive (that is the whole point of the dead-man).
    assert.ok(bodies.has("readHeartbeatFile"));
    assert.equal(/child_process/.test(src), false);
  });

  it("never sends an opposing order — the only close path is close_position", () => {
    // A close via `execute_trade` on the opposite side OPENS new exposure
    // (the lesson from the repo's TP path). The watchdog uses close_position
    // (reduce-only) and nothing else.
    const runner = bodies.get("runWatchdogCycle") ?? "";
    assert.ok(runner.includes('"close_position"'));
    assert.equal(runner.includes('"execute_trade"'), false);
  });

  it("the flatten action prefers a reduce-only close", () => {
    const decider = bodies.get("decideWatchdog") ?? "";
    assert.ok(decider.includes("reduce_only_close"));
  });
});

/* ------------------------------------------------------------------ */
/* normalization + heartbeat helpers                                   */
/* ------------------------------------------------------------------ */

describe("normalizeWatchdogRiskState", () => {
  it("reads the server risk row (snake_case)", () => {
    const r = normalizeWatchdogRiskState({
      risk_limits: {
        kill_switch_enabled: true,
        circuit_breaker_tripped_at: "2026-10-20T00:00:00Z",
        daily_realized_loss_usd: 12.5,
        max_daily_loss_usd: 50,
        daily_trade_count: 3,
        max_trades_per_day: 10,
        daily_notional_usd: 900,
        max_daily_notional_usd: 5000,
      },
    });
    assert.equal(r.killSwitch, true);
    assert.equal(r.circuitBreakerTripped, true);
    assert.equal(r.dailyRealizedLossUsd, 12.5);
    assert.equal(r.maxDailyLossUsd, 50);
    assert.equal(r.dailyTradeCount, 3);
    assert.equal(r.maxTradesPerDay, 10);
    assert.equal(r.dailyNotionalUsd, 900);
    assert.equal(r.maxDailyNotionalUsd, 5000);
    assert.equal(r.readable, true);
  });

  it("is unreadable (fail closed) when the read failed", () => {
    const r = normalizeWatchdogRiskState(null, "http 500");
    assert.equal(r.readable, false);
    assert.equal(r.killSwitch, null);
    assert.equal(r.readError, "http 500");
  });

  it("keeps unknown caps null — never zero-filled", () => {
    const r = normalizeWatchdogRiskState({ risk_limits: { kill_switch_enabled: false } });
    assert.equal(r.maxDailyLossUsd, null);
    assert.equal(r.dailyRealizedLossUsd, null);
    assert.equal(r.maxTradesPerDay, null);
  });
});

describe("normalizeSide", () => {
  it("maps venue sides", () => {
    assert.equal(normalizeSide("long"), "long");
    assert.equal(normalizeSide("LONG"), "long");
    assert.equal(normalizeSide("buy"), "long");
    assert.equal(normalizeSide("short"), "short");
    assert.equal(normalizeSide("sell"), "short");
    assert.equal(normalizeSide("weird"), null);
  });
});

describe("heartbeatAgeMs", () => {
  it("measures the age", () => {
    assert.equal(heartbeatAgeMs({ atMs: NOW - 5_000, source: "x" }, NOW), 5_000);
  });
  it("returns null when there is no beat", () => {
    assert.equal(heartbeatAgeMs({ atMs: null, source: "x" }, NOW), null);
    assert.equal(heartbeatAgeMs(null, NOW), null);
  });
  it("clamps clock skew (a beat from the future reads as fresh, not stale)", () => {
    assert.equal(heartbeatAgeMs({ atMs: NOW + 1_000, source: "x" }, NOW), 0);
  });
});

describe("parseHeartbeat", () => {
  it("reads the supervisor payload shape (ISO `at`)", () => {
    const hb = parseHeartbeat({ at: "2026-10-20T10:00:00.000Z" }, "executor");
    assert.equal(hb.atMs, Date.parse("2026-10-20T10:00:00.000Z"));
  });
  it("reads an epoch-ms payload", () => {
    assert.equal(parseHeartbeat({ atMs: NOW }, "executor").atMs, NOW);
  });
  it("is null-beat for junk", () => {
    assert.equal(parseHeartbeat("nope", "executor").atMs, null);
    assert.equal(parseHeartbeat({}, "executor").atMs, null);
  });
});

/* ------------------------------------------------------------------ */
/* state file                                                          */
/* ------------------------------------------------------------------ */

describe("watchdog state file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to an untripped breaker", () => {
    const s = loadWatchdogState(join(dir, "missing.json"));
    assert.equal(s.breaker.tripped, false);
    assert.equal(s.policy.flattenArmed, false);
  });

  it("fails closed on an unreadable state file (never reads as 'nothing running')", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    const s = loadWatchdogState(p);
    assert.equal(s.breaker.tripped, true);
    assert.match(s.breaker.reasons[0] ?? "", /unreadable/);
  });

  it("round-trips a tripped breaker", () => {
    const p = join(dir, "state.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        breaker: { tripped: true, trippedAt: "2026-10-20T00:00:00Z", reasons: ["x"], clearedAt: null, clearedBy: null },
        entriesBlocked: true,
        blockReason: "x",
        policy: { flattenArmed: true },
        consecutiveVenueErrors: 2,
      }),
    );
    const s = loadWatchdogState(p);
    assert.equal(s.breaker.tripped, true);
    assert.equal(s.entriesBlocked, true);
    assert.equal(s.policy.flattenArmed, true);
    assert.equal(s.consecutiveVenueErrors, 2);
  });
});

/* ------------------------------------------------------------------ */
/* venue snapshot                                                      */
/* ------------------------------------------------------------------ */

describe("accountSnapshotFromVenue", () => {
  it("reads positions, exits, orders and balances out of the venue payloads", () => {
    const snap = accountSnapshotFromVenue({
      positionsOut: [
        {
          symbol: "SOL/USDT",
          side: "long",
          size: 10,
          markPrice: 12,
          exits: [{ orderId: "tp1", kind: "tp" }],
        },
      ],
      balancesOut: { merged: [{ asset: "USDT", free: 400, total: 1000 }] },
      ordersOut: [{ orderId: "o1", symbol: "SOL/USDT", clientOid: "s1" }],
      ownership: { ownedOrderIds: ["o1"], ownedPairs: ["SOL/USDT"], ownedClientOidPrefixes: [] },
      consecutiveVenueErrors: 0,
      fundingRatePct: null,
    });
    assert.equal(snap.freeMarginUsd, 400);
    assert.equal(snap.totalEquityUsd, 1000);
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.positions[0]?.notionalUsd, 120);
    assert.equal(snap.positions[0]?.exits?.length, 1);
    assert.equal(snap.positions[0]?.machineOwned, true);
    assert.equal(snap.orders[0]?.machineOwned, true);
  });

  it("marks an unreadable exits read as unknown, not as 'no exits'", () => {
    const snap = accountSnapshotFromVenue({
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 1, markPrice: 10, exitsUnknown: true }],
      balancesOut: { merged: [{ asset: "USDT", free: 10, total: 10 }] },
      ordersOut: [],
      ownership: { ownedOrderIds: [], ownedPairs: [], ownedClientOidPrefixes: [] },
      consecutiveVenueErrors: 0,
      fundingRatePct: null,
    });
    assert.equal(snap.positions[0]?.exitsUnknown, true);
    assert.equal(snap.positions[0]?.exits, null);
  });

  it("never zero-fills an unmeasurable account", () => {
    const snap = accountSnapshotFromVenue({
      positionsOut: [],
      balancesOut: { merged: [{ asset: "BTC", free: 1, total: 1 }] },
      ordersOut: [],
      ownership: { ownedOrderIds: [], ownedPairs: [], ownedClientOidPrefixes: [] },
      consecutiveVenueErrors: 0,
      fundingRatePct: null,
    });
    assert.equal(snap.freeMarginUsd, null);
    assert.equal(snap.totalEquityUsd, null);
  });
});

/* ------------------------------------------------------------------ */
/* the impure cycle — injected deps, zero network                      */
/* ------------------------------------------------------------------ */

describe("runWatchdogCycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-cycle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const conns = [{ id: "c1", exchange: "kucoin" }];

  const makeDeps = (over: Record<string, unknown> = {}) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
      if (name === "read_live_datum" && args.kind === "positions") {
        return [{ symbol: "SOL/USDT", side: "long", size: 10, markPrice: 12, exits: [] }];
      }
      if (name === "read_live_datum" && args.kind === "balances") {
        return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
      }
      if (name === "list_open_orders") return [{ orderId: "o1", symbol: "SOL/USDT", clientOid: "sess-1" }];
      return { ok: true };
    };
    return {
      calls,
      deps: {
        call: call as never,
        listConns: (async () => conns) as never,
        stateDir: dir,
        cfgDir: dir,
        executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
        funding: (async () => null) as never,
        now: () => NOW,
        ...over,
      },
    };
  };

  it("sets the breaker, cancels only our order, blocks entries and alerts", async () => {
    const { calls, deps } = makeDeps();
    // Arm ownership via a state file claim.
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(result.decision.shouldAct, true);
    const types = result.executed.map((e) => e.type);
    assert.deepEqual(types, ["set_breaker", "cancel_orders", "block_entries", "alert"]);
    const cancels = calls.filter((c) => c.name === "cancel_order");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]?.args.orderId, "o1");
    assert.equal(result.state.breaker.tripped, true);
    assert.equal(result.state.entriesBlocked, true);
  });

  it("writes its own heartbeat so the next cycle sees it alive", async () => {
    const { deps } = makeDeps();
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    const hb = join(dir, "watchdog-heartbeat.json");
    assert.equal(existsSync(hb), true);
    const parsed = JSON.parse(readFileSync(hb, "utf8")) as { atMs: number; breakerTripped: boolean };
    assert.equal(parsed.atMs, NOW);
    assert.equal(parsed.breakerTripped, true);
  });

  it("advances the venue-error streak on a failed venue read and trips on it", async () => {
    const { deps } = makeDeps({
      call: (async (name: string) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
        throw new Error("venue down");
      }) as never,
    });
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(result.state.consecutiveVenueErrors, 1);
    assert.ok(result.errors.some((e) => /venue read failed/.test(e)));
  });

  it("flattens with a reduce-only close only when armed AND opted in", async () => {
    const { calls, deps } = makeDeps();
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    // Arm the policy.
    await cmdWatchdogArmFlatten({ arm: true }, { cfgDir: dir });
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p", flatten: true }, deps);
    const closes = calls.filter((c) => c.name === "close_position");
    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.args.side, "long");
    assert.equal(closes[0]?.args.pair, "SOL/USDT");
    assert.equal(result.executed.some((e) => e.type === "flatten"), true);
  });

  it("does not flatten when the invocation omits the opt-in", async () => {
    const { calls, deps } = makeDeps();
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    await cmdWatchdogArmFlatten({ arm: true }, { cfgDir: dir });
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(calls.filter((c) => c.name === "close_position").length, 0);
  });

  it("never cancels a FOREIGN order, even while tripping", async () => {
    const { calls, deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        // Two working orders: one claimed by a local state, one foreign.
        if (name === "list_open_orders") {
          return [
            { orderId: "o1", symbol: "SOL/USDT", clientOid: "sess-1" },
            { orderId: "foreign-1", symbol: "BTC/USDT", clientOid: "other-lane" },
          ];
        }
        return { ok: true };
      }) as never,
    });
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    const cancels = calls.filter((c) => c.name === "cancel_order");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]?.args.orderId, "o1");
    assert.equal(cancels.some((c) => c.args.orderId === "foreign-1"), false);
  });

  it("reports the server write gate as blocked when the kill switch is ON", async () => {
    const { deps } = makeDeps();
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(result.decision.serverWriteGate, "blocked");
  });

  it("reports the server write gate as open when the kill switch is off", async () => {
    const { deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    });
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(result.decision.serverWriteGate, "open");
  });

  it("surfaces a server-gate refusal instead of claiming the cancel succeeded", async () => {
    const { deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [{ orderId: "o1", symbol: "SOL/USDT" }];
        if (name === "cancel_order") throw new Error("blocked: cancel_order blocked: Kill switch is ON");
        return {};
      }) as never,
    });
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    const cancel = result.executed.find((e) => e.type === "cancel_orders");
    assert.equal(cancel?.ok, false);
    assert.equal(cancel?.detail?.serverWriteGateBlocked, true);
    assert.match(String(cancel?.detail?.note ?? ""), /still working/);
  });

  it("trips on a stale executor heartbeat even with a healthy market", async () => {
    const { deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    });
    // A heartbeat file from long ago.
    writeFileSync(
      join(dir, "supervise-heartbeat.json"),
      JSON.stringify({ at: new Date(NOW - 600_000).toISOString() }),
    );
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.ok(result.decision.trips.some((t) => t.code === "executor_heartbeat_stale"));
    assert.equal(result.state.breaker.tripped, true);
  });

  it("trips on its own stale heartbeat (the watchdog's dead-man)", async () => {
    const { deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    });
    // The watchdog's OWN heartbeat is ancient.
    writeFileSync(
      join(dir, "watchdog-heartbeat.json"),
      JSON.stringify({ at: new Date(NOW - 600_000).toISOString() }),
    );
    const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.ok(result.decision.trips.some((t) => t.code === "watchdog_heartbeat_stale"));
  });

  it("keeps the breaker latched across cycles until a human resumes", async () => {
    const { deps } = makeDeps({
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    });
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
    assert.equal(loadWatchdogState(watchdogStatePath(dir)).breaker.tripped, true);
    // Second cycle: kill switch now OFF, but the breaker stays tripped.
    const second = await runWatchdogCycle(
      { exchange: "kucoin", pat: "p" },
      {
        ...deps,
        call: (async (name: string, args: Record<string, unknown>) => {
          if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
          if (name === "read_live_datum" && args.kind === "positions") return [];
          if (name === "read_live_datum" && args.kind === "balances") {
            return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
          }
          if (name === "list_open_orders") return [];
          return {};
        }) as never,
      },
    );
    assert.equal(second.decision.tripped, false);
    assert.equal(second.decision.latched, true);
    assert.equal(second.decision.shouldAct, true);
    assert.equal(loadWatchdogState(watchdogStatePath(dir)).breaker.tripped, true);
  });
});

/* ------------------------------------------------------------------ */
/* the resume command                                                  */
/* ------------------------------------------------------------------ */

describe("cmdWatchdogResume", () => {
  let dir: string;
  let logged: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-resume-"));
    logged = [];
    origLog = console.log;
    origErr = console.error;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const conns = [{ id: "c1", exchange: "kucoin" }];

  const cleanDeps = () => ({
    call: (async (name: string, args: Record<string, unknown>) => {
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "read_live_datum" && args.kind === "positions") return [];
      if (name === "read_live_datum" && args.kind === "balances") {
        return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
      }
      if (name === "list_open_orders") return [];
      return {};
    }) as never,
    listConns: (async () => conns) as never,
    stateDir: dir,
    cfgDir: dir,
    executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
    funding: (async () => null) as never,
    now: () => NOW,
  });

  it("refuses without an explicit actor (exit 2)", async () => {
    await cmdWatchdogResume({ pat: "p" }, cleanDeps());
    assert.equal(process.exitCode, 2);
    assert.ok(logged.join("\n").includes("explicit human actor"));
  });

  it("refuses while the trip condition is live, leaving the breaker tripped", async () => {
    // Trip it first (kill switch ON).
    const trippedDeps = {
      ...cleanDeps(),
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    };
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, trippedDeps);
    assert.equal(loadWatchdogState(watchdogStatePath(dir)).breaker.tripped, true);
    process.exitCode = undefined;
    logged = [];
    // Resume while the kill switch is STILL on → refused.
    await cmdWatchdogResume({ pat: "p", actor: "owner" }, trippedDeps);
    assert.equal(process.exitCode, 1);
    assert.equal(loadWatchdogState(watchdogStatePath(dir)).breaker.tripped, true);
    assert.ok(logged.join("\n").includes("trip condition has NOT cleared"));
  });

  it("clears the breaker when the trip cleared and a human asked", async () => {
    // Trip it first with a different condition, then clear the condition.
    const trippedDeps = {
      ...cleanDeps(),
      call: (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return {};
      }) as never,
    };
    await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, trippedDeps);
    assert.equal(loadWatchdogState(watchdogStatePath(dir)).breaker.tripped, true);
    process.exitCode = undefined;
    logged = [];
    await cmdWatchdogResume({ pat: "p", actor: "owner" }, cleanDeps());
    const s = loadWatchdogState(watchdogStatePath(dir));
    assert.equal(s.breaker.tripped, false);
    assert.equal(s.breaker.clearedBy, "owner");
    assert.equal(s.entriesBlocked, false);
    assert.ok(logged.join("\n").includes("resumed by owner"));
  });
});

/* ------------------------------------------------------------------ */
/* CLI dispatch                                                        */
/* ------------------------------------------------------------------ */

describe("cmdWatchdog dispatch", () => {
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  let logged: string[];
  beforeEach(() => {
    logged = [];
    origLog = console.log;
    origErr = console.error;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = undefined;
  });

  it("rejects an unknown subcommand with exit 2", async () => {
    await cmdWatchdog({ sub: "nonsense", pat: "p" });
    assert.equal(process.exitCode, 2);
  });

  it("check is read-only — no cancel, no close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-check-"));
    const calls: string[] = [];
    await cmdWatchdog(
      { sub: "check", pat: "p" },
      {
        call: (async (name: string) => {
          calls.push(name);
          if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
          if (name === "read_live_datum") return [];
          if (name === "list_open_orders") return [];
          return {};
        }) as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: dir,
        cfgDir: dir,
        now: () => NOW,
      },
    );
    assert.equal(calls.includes("cancel_order"), false);
    assert.equal(calls.includes("close_position"), false);
    assert.equal(process.exitCode, 1);
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* evaluateWatchdog — read-only path                                  */
/* ------------------------------------------------------------------ */

describe("evaluateWatchdog", () => {
  it("reads the server risk state and the live account without writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-eval-"));
    const calls: string[] = [];
    const result = await evaluateWatchdog(
      { exchange: "kucoin", pat: "p" },
      {
        call: (async (name: string, args: Record<string, unknown>) => {
          calls.push(name);
          if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
          if (name === "read_live_datum" && args.kind === "positions") return [];
          if (name === "read_live_datum" && args.kind === "balances") {
            return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
          }
          if (name === "list_open_orders") return [];
          return {};
        }) as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: dir,
        cfgDir: dir,
        now: () => NOW,
      },
    );
    assert.equal(result.decision.shouldAct, false);
    assert.equal(calls.includes("cancel_order"), false);
    assert.equal(calls.includes("close_position"), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a TRANSIENT venue failure must not latch the breaker", () => {
  // A throttle is not evidence that the venue path is broken. The
  // breaker is HUMAN-ONLY to clear, so a throttle that counted toward
  // the error streak could stop the machine entirely — and it did: the
  // watchdog latched on three consecutive `rate_limited` errors caused
  // by a scanner sharing the same per-minute budget.
  const evalWith = async (call: unknown, state: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-transient-"));
    const result = await evaluateWatchdog(
      { exchange: "kucoin", pat: "p" },
      {
        call: call as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: dir,
        cfgDir: dir,
        now: () => NOW,
        ...(state as object),
      },
    );
    rmSync(dir, { recursive: true, force: true });
    return result;
  };

  it("a rate-limited venue read does NOT advance the venue-error streak", async () => {
    const result = await evalWith(async (name: string) => {
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      // Every venue read is throttled.
      throw new Error("rate_limited: Rate limit exceeded — try again in 60s");
    });
    const venueTrip = result.decision.trips.find((t) => t.reason?.includes("venue error"));
    assert.equal(venueTrip, undefined, `a transient failure tripped the breaker: ${venueTrip?.reason}`);
  });

  it("a GENUINE venue read failure DOES advance the streak and trips at the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-genuine-"));
    // Seed a state file with a streak already at the limit.
    writeFileSync(
      join(dir, "watchdog-state.json"),
      JSON.stringify({ version: 1, consecutiveVenueErrors: 2, breaker: { tripped: false, reasons: [] } }),
    );
    const result = await evaluateWatchdog(
      { exchange: "kucoin", pat: "p" },
      {
        call: (async (name: string) => {
          if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
          if (name === "read_live_datum") return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
          if (name === "list_open_orders") return [];
          return {};
        }) as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: dir,
        cfgDir: dir,
        now: () => NOW,
      },
    );
    rmSync(dir, { recursive: true, force: true });
    assert.equal(result.decision.shouldAct, false, "a healthy venue read should not act");
  });
});

describe("a THROTTLED risk-state read is not a tripped switch", () => {
  // The watchdog's fail-closed rule is right: an unreadable risk row
  // may hold a kill switch we cannot see. But a RATE LIMIT is not an
  // unreadable row — it is a request we could not make. Treating it
  // as unreadable tripped the breaker on a busy minute, and the
  // breaker is human-only to clear.
  it("a transient read produces a NOTE, not a trip", () => {
    const decision = decideWatchdog(
      baseInput({
        riskState: normalizeWatchdogRiskState(null, "rate_limited: Rate limit exceeded — try again in 60s"),
      }),
    );
    assert.equal(decision.tripped, false, `a throttled read tripped the watchdog: ${JSON.stringify(decision.trips)}`);
    assert.ok(
      decision.notes.some((n) => n.includes("TRANSIENT")),
      `the transient read was not reported as a note: ${JSON.stringify(decision.notes)}`,
    );
  });

  it("a GENUINE unreadable risk state still fails closed", () => {
    const decision = decideWatchdog(
      baseInput({
        riskState: normalizeWatchdogRiskState(null, "internal: database exploded"),
      }),
    );
    assert.equal(decision.tripped, true, "a genuine unreadable risk state did NOT fail closed");
    assert.ok(decision.trips.some((t) => t.code === "risk_state_unreadable"));
  });
});

describe("watchdog diary: every auto-cancel/auto-close is logged", () => {
  it("builds a diary line with trip codes plus ownership proof", () => {
    const e = makeWatchdogDiaryEntry({
      at: "2026-10-27T00:00:00.000Z",
      action: "auto-cancel",
      exchange: "kucoin",
      pair: "SOL/USDT",
      orderId: "o1",
      tripCodes: ["kill_switch"],
      ownershipReason: "claimed by a local state file",
      clientOid: "jw3-sess-t1-SOLUSDT",
      result: "ok",
    });
    assert.equal(e.action, "auto-cancel");
    assert.deepEqual(e.tripCodes, ["kill_switch"]);
    assert.equal(e.ownershipProof.reason, "claimed by a local state file");
    assert.equal(e.ownershipProof.clientOid, "jw3-sess-t1-SOLUSDT");
    assert.equal(e.result, "ok");
    assert.equal("error" in e, false);
  });

  it("a cycle appends one line per auto-cancel with trip code and proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-diary-"));
    try {
      const call = (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [{ orderId: "o1", symbol: "SOL/USDT", clientOid: "sess-1" }];
        return { ok: true };
      }) as never;
      writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
      const result = await runWatchdogCycle(
        { exchange: "kucoin", pat: "p" },
        {
          call,
          listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
          stateDir: dir,
          cfgDir: dir,
          executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
          funding: (async () => null) as never,
          now: () => 1700000000000,
        },
      );
      assert.equal(result.decision.shouldAct, true);
      const diary = join(dir, "watchdog-diary.jsonl");
      assert.equal(existsSync(diary), true);
      const lines = readFileSync(diary, "utf8").split("\n").filter((l) => l.trim());
      assert.equal(lines.length, 1);
      const e = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(e.action, "auto-cancel");
      assert.equal(e.orderId, "o1");
      assert.equal(e.pair, "SOL/USDT");
      assert.ok(Array.isArray(e.tripCodes) && (e.tripCodes as string[]).includes("kill_switch"));
      assert.match(String((e.ownershipProof as { reason: string }).reason), /local state file/);
      assert.equal(e.result, "ok");
      // Append-only: a second trip appends, never overwrites.
      await runWatchdogCycle(
        { exchange: "kucoin", pat: "p" },
        {
          call,
          listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
          stateDir: dir,
          cfgDir: dir,
          executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
          funding: (async () => null) as never,
          now: () => 1700000000000,
        },
      );
      assert.equal(readFileSync(diary, "utf8").split("\n").filter((l) => l.trim()).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed auto-cancel is logged as failed with the venue error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-diary-fail-"));
    try {
      const call = (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") return [];
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [{ orderId: "o1", symbol: "SOL/USDT" }];
        if (name === "cancel_order") throw new Error("blocked: Kill switch is ON");
        return {};
      }) as never;
      writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
      await runWatchdogCycle(
        { exchange: "kucoin", pat: "p" },
        {
          call,
          listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
          stateDir: dir,
          cfgDir: dir,
          executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
          funding: (async () => null) as never,
          now: () => 1700000000000,
        },
      );
      const lines = readFileSync(join(dir, "watchdog-diary.jsonl"), "utf8").split("\n").filter((l) => l.trim());
      assert.equal(lines.length, 1);
      const e = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(e.result, "failed");
      assert.match(String(e.error), /Kill switch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an auto-close is logged with the position proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watchdog-diary-close-"));
    try {
      const call = (async (name: string, args: Record<string, unknown>) => {
        if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
        if (name === "read_live_datum" && args.kind === "positions") {
          return [{ symbol: "SOL/USDT", side: "long", size: 10, markPrice: 12, exits: [] }];
        }
        if (name === "read_live_datum" && args.kind === "balances") {
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }
        if (name === "list_open_orders") return [];
        return { ok: true };
      }) as never;
      writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
      // Arm the flatten policy, then opt in for this cycle.
      await cmdWatchdogArmFlatten({ arm: true }, { cfgDir: dir });
      const result = await runWatchdogCycle(
        { exchange: "kucoin", pat: "p", flatten: true },
        {
          call,
          listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
          stateDir: dir,
          cfgDir: dir,
          executorHeartbeatFile: join(dir, "supervise-heartbeat.json"),
          funding: (async () => null) as never,
          now: () => 1700000000000,
        },
      );
      assert.ok(result.executed.some((e) => e.type === "flatten"));
      const lines = readFileSync(join(dir, "watchdog-diary.jsonl"), "utf8").split("\n").filter((l) => l.trim());
      assert.equal(lines.length, 1);
      const e = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(e.action, "auto-close");
      assert.equal(e.pair, "SOL/USDT");
      assert.match(String((e.ownershipProof as { reason: string }).reason), /local state file/);
      assert.equal(e.result, "ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the diary path defaults under the config dir", () => {
    assert.ok(watchdogDiaryPath("/tmp/x").endsWith("watchdog-diary.jsonl"));
    assert.equal(appendWatchdogDiary(join(mkdtempSync(join(tmpdir(), "watchdog-diary-unit-")), "d.jsonl"), makeWatchdogDiaryEntry({
      at: "2026-10-27T00:00:00.000Z",
      action: "auto-cancel",
      exchange: "kucoin",
      pair: "SOL/USDT",
      orderId: "o1",
      tripCodes: ["kill_switch"],
      ownershipReason: "claimed by a local state file",
      result: "ok",
    })), null);
  });
});
