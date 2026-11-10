import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "../test-fixtures.js";
import {
  cmdAlert,
  consoleTransport,
  DEFAULT_ALERT_POLICY,
  deriveFindings,
  diffMachineState,
  dispatchAlerts,
  evaluateAlerts,
  fileTransport,
  formatAlert,
  loadAlertState,
  saveAlertState,
  type Alert,
  type AlertKey,
  type AlertState,
  type MachineSnapshot,
  type StateChange,
} from "./alert.js";

const T0 = 1_700_000_000_000;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Every alert a decision produced, flattened to one line each. */
function lines(alerts: readonly Alert[]): string[] {
  return alerts.map((a) => `${a.severity} ${a.headline}`);
}

/** The single alert of a decision (fails loudly if there is not exactly one). */
function only(alerts: readonly Alert[]): Alert {
  assert.equal(alerts.length, 1, `expected exactly one alert, got ${alerts.length}: ${lines(alerts).join(" | ")}`);
  return alerts[0];
}

const marginChange = (freeUsd: number, floorUsd = 50): StateChange => ({
  kind: "margin",
  freeUsd,
  floorUsd,
  totalUsd: 1000,
});

const noExitChange = (pair = "SOL/USDT"): StateChange => ({
  kind: "position-opened",
  pair,
  side: "long",
  size: 12,
  price: 118.4,
  notionalUsd: 1420.8,
  marginUsd: 94.72,
  exitArmed: false,
});

/* ------------------------------------------------------------------ */
/* the catalogue — every listed trigger produces its alert            */
/* ------------------------------------------------------------------ */

describe("alert catalogue", () => {
  it("alerts on the kill switch, critically, with an action", () => {
    const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /KILL SWITCH ENGAGED/);
    assert.ok(a.action.length > 20);
    assert.ok(a.detail.includes("kill switch"));
  });

  it("alerts on a circuit breaker trip with its reason", () => {
    const d = evaluateAlerts([], [{ kind: "circuit-breaker", tripped: true, reason: "3 consecutive losses" }], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /CIRCUIT BREAKER TRIPPED/);
    assert.match(a.headline, /3 consecutive losses/);
  });

  it("alerts on free margin below the floor, with both numbers", () => {
    const d = evaluateAlerts([], [marginChange(12.5)], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /FREE MARGIN BELOW FLOOR/);
    assert.ok(a.headline.includes("$12.50"));
    assert.ok(a.headline.includes("$50.00"));
    assert.equal(a.numbers["freeUsd"], 12.5);
    assert.equal(a.numbers["floorUsd"], 50);
  });

  it("alerts on the daily loss limit, with both numbers", () => {
    const d = evaluateAlerts([], [{ kind: "daily-loss", lossUsd: 6, limitUsd: 5 }], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /DAILY LOSS LIMIT REACHED/);
    assert.ok(a.headline.includes("$6.00"));
    assert.ok(a.headline.includes("$5.00"));
  });

  it("alerts on a position opened without an exit armed, with pair/size/price", () => {
    const d = evaluateAlerts([], [noExitChange()], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /POSITION OPENED WITHOUT EXIT ARMED/);
    assert.ok(a.headline.includes("SOL/USDT"));
    assert.ok(a.headline.includes("12"));
    assert.ok(a.detail.includes("118.4"));
    assert.ok(a.detail.includes("$1,420.80"));
    assert.ok(a.action.includes("exits") || a.action.includes("close"));
  });

  it("alerts on an unknown-origin position, with pair and size", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 0.007, price: 90000, notionalUsd: 630 }],
      T0,
    );
    const a = only(d.alerts);
    assert.equal(a.severity, "warning");
    assert.match(a.headline, /UNKNOWN-ORIGIN POSITION/);
    assert.ok(a.headline.includes("BTC/USDT"));
    assert.ok(a.detail.includes("630"));
    assert.ok(a.detail.includes("no local state"));
  });

  it("alerts on a fill confirmed, with pair/size/price/fee", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "fill", pair: "SOL/USDT", side: "buy", size: 12, price: 118.4, feeUsd: 0.05, fillId: "f1" }],
      T0,
    );
    const a = only(d.alerts);
    assert.equal(a.severity, "info");
    assert.match(a.headline, /FILL CONFIRMED/);
    assert.ok(a.headline.includes("SOL/USDT"));
    assert.ok(a.detail.includes("fee $0.05"));
  });

  it("alerts on a TP fill", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "fill", pair: "SOL/USDT", side: "sell", size: 12, price: 119.4, fillKind: "tp", fillId: "f2" }],
      T0,
    );
    const a = only(d.alerts);
    assert.match(a.headline, /TP FILLED/);
    assert.equal(a.severity, "info");
  });

  it("alerts on a stop hit", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "fill", pair: "SOL/USDT", side: "sell", size: 12, price: 117.1, fillKind: "sl", fillId: "f3" }],
      T0,
    );
    const a = only(d.alerts);
    assert.match(a.headline, /STOP HIT/);
    assert.equal(a.severity, "warning");
  });

  it("alerts on a daemon crash, critically", () => {
    const d = evaluateAlerts([], [{ kind: "daemon", event: "crash", pid: 4242, exitCode: 1 }], T0);
    const a = only(d.alerts);
    assert.equal(a.severity, "critical");
    assert.match(a.headline, /DAEMON CRASHED/);
    assert.ok(a.headline.includes("4242"));
  });

  it("alerts on a daemon restart", () => {
    const d = evaluateAlerts([], [{ kind: "daemon", event: "restart", pid: 4243 }], T0);
    const a = only(d.alerts);
    assert.match(a.headline, /DAEMON RESTARTED/);
    assert.equal(a.severity, "warning");
  });

  it("alerts on the daily summary with trades/wins/losses/net P&L/fees", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "daily-summary", trades: 7, wins: 4, losses: 3, netPnlUsd: -1.25, feesUsd: 0.42, day: "2026-10-21" }],
      T0,
    );
    const a = only(d.alerts);
    assert.match(a.headline, /DAILY SUMMARY/);
    assert.ok(a.headline.includes("7 trades"));
    assert.ok(a.headline.includes("4W/3L"));
    assert.ok(a.headline.includes("-$1.25"));
    assert.ok(a.detail.includes("$0.42"));
    assert.equal(a.numbers["feesUsd"], 0.42);
  });

  it("never alerts on a position that opened WITH its exit armed", () => {
    const d = evaluateAlerts(
      [],
      [{ kind: "position-opened", pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: true }],
      T0,
    );
    assert.equal(d.alerts.length, 0);
  });

  it("stays silent when nothing changed", () => {
    const d = evaluateAlerts([], [], T0);
    assert.equal(d.alerts.length, 0);
    assert.equal(d.suppressed.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* dedup / cooldown                                                   */
/* ------------------------------------------------------------------ */

describe("dedup + cooldown", () => {
  it("does not re-alert the same finding on the next poll", () => {
    const first = evaluateAlerts([], [marginChange(12.5)], T0);
    assert.equal(first.alerts.length, 1);
    const second = evaluateAlerts(first.state.keys, [marginChange(12.5)], T0 + 60_000);
    assert.equal(second.alerts.length, 0, "the same finding must not re-alert inside the cooldown");
    assert.equal(second.suppressed.length, 1);
    assert.equal(second.suppressed[0]?.key, "margin:free-below-floor");
  });

  it("re-alerts once the cooldown window has passed", () => {
    const first = evaluateAlerts([], [marginChange(12.5)], T0);
    const later = evaluateAlerts(first.state.keys, [marginChange(12.5)], T0 + DEFAULT_ALERT_POLICY.cooldownMs + 1);
    assert.equal(later.alerts.length, 1);
  });

  it("respects a custom cooldown window", () => {
    const policy = { cooldownMs: 60_000 };
    const first = evaluateAlerts([], [marginChange(12.5)], T0, { policy });
    const second = evaluateAlerts(first.state.keys, [marginChange(12.5)], T0 + 30_000, { policy });
    assert.equal(second.alerts.length, 0);
    const third = evaluateAlerts(first.state.keys, [marginChange(12.5)], T0 + 61_000, { policy });
    assert.equal(third.alerts.length, 1);
  });

  it("re-alerts when the material numbers change (same key, worse numbers)", () => {
    const first = evaluateAlerts([], [marginChange(40)], T0); // 80% of floor -> band b75
    assert.equal(first.alerts.length, 1);
    const second = evaluateAlerts(first.state.keys, [marginChange(5)], T0 + 60_000); // band b25
    assert.equal(second.alerts.length, 1, "a changed fingerprint is news even inside the cooldown");
    assert.ok(second.alerts[0]?.headline.includes("$5.00"));
  });

  it("keeps different findings on different keys independent", () => {
    const first = evaluateAlerts([], [marginChange(12.5)], T0);
    const second = evaluateAlerts(first.state.keys, [noExitChange("ETH/USDT")], T0 + 1_000);
    assert.equal(second.alerts.length, 1);
    assert.match(second.alerts[0]?.headline ?? "", /ETH\/USDT/);
  });

  it("is a pure function of (previousAlertKeys, incomingChanges, now)", () => {
    const keys: AlertKey[] = [];
    const a = evaluateAlerts(keys, [marginChange(12.5)], T0);
    const b = evaluateAlerts(keys, [marginChange(12.5)], T0);
    assert.deepEqual(a.alerts, b.alerts);
    assert.deepEqual(a.state.keys, b.state.keys);
  });

  it("does not mutate the caller's previous keys", () => {
    const keys: AlertKey[] = [];
    const snapshot = JSON.stringify(keys);
    evaluateAlerts(keys, [marginChange(12.5)], T0);
    assert.equal(JSON.stringify(keys), snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* escalation                                                         */
/* ------------------------------------------------------------------ */

describe("escalation", () => {
  it("escalates a warning finding to critical after N polls", () => {
    const policy = { escalateAfterPolls: 2 };
    let keys: AlertKey[] = [];
    const change: StateChange = { kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 0.007 };

    const p1 = evaluateAlerts(keys, [change], T0, { policy });
    assert.equal(p1.alerts[0]?.severity, "warning");
    keys = p1.state.keys;

    const p2 = evaluateAlerts(keys, [change], T0 + 60_000, { policy });
    assert.equal(p2.alerts.length, 0, "inside the cooldown the same finding is suppressed (the poll still counts)");
    assert.equal(p2.state.keys.find((k) => k.key === "unknown-origin:BTC/USDT:short")?.occurrences, 2);
    keys = p2.state.keys;

    const p3 = evaluateAlerts(keys, [change], T0 + 120_000, { policy });
    assert.equal(p3.alerts.length, 1);
    assert.equal(p3.alerts[0]?.severity, "critical", "past the threshold the finding escalates");
    assert.match(p3.alerts[0]?.headline ?? "", /ESCALATED/);
    assert.equal(p3.alerts[0]?.escalated, true);
  });

  it("keeps a persistent critical loud instead of re-firing the original alert", () => {
    const policy = { escalateAfterPolls: 2 };
    let keys: AlertKey[] = [];
    const change = marginChange(12.5);

    const p1 = evaluateAlerts(keys, [change], T0, { policy });
    keys = p1.state.keys;
    const p2 = evaluateAlerts(keys, [change], T0 + 60_000, { policy });
    keys = p2.state.keys;
    const p3 = evaluateAlerts(keys, [change], T0 + 120_000, { policy });

    assert.equal(p3.alerts.length, 1);
    assert.match(p3.alerts[0]?.headline ?? "", /ESCALATED/);
    assert.match(p3.alerts[0]?.headline ?? "", /still true after 3 polls/);
  });

  it("does not re-escalate on every poll (the escalation has its own cooldown)", () => {
    const policy = { escalateAfterPolls: 1, escalationCooldownMs: 30 * 60_000 };
    let keys: AlertKey[] = [];
    const change = marginChange(12.5);

    const p1 = evaluateAlerts(keys, [change], T0, { policy });
    keys = p1.state.keys;
    const p2 = evaluateAlerts(keys, [change], T0 + 60_000, { policy });
    assert.equal(p2.alerts.length, 1, "the escalation fires when the condition crosses the threshold");
    keys = p2.state.keys;

    const p3 = evaluateAlerts(keys, [change], T0 + 120_000, { policy });
    assert.equal(p3.alerts.length, 0, "a second escalation inside the escalation cooldown would be spam");
    keys = p3.state.keys;

    const p4 = evaluateAlerts(keys, [change], T0 + 31 * 60_000, { policy });
    assert.equal(p4.alerts.length, 1, "the escalation fires again once its cooldown expires");
  });
});

/* ------------------------------------------------------------------ */
/* resolution ("all clear")                                            */
/* ------------------------------------------------------------------ */

describe("resolution", () => {
  it("emits an all-clear when a finding clears", () => {
    const first = evaluateAlerts([], [marginChange(12.5)], T0);
    assert.equal(first.alerts.length, 1);
    const cleared = evaluateAlerts(first.state.keys, [marginChange(80)], T0 + 60_000);
    const a = only(cleared.alerts);
    assert.equal(a.tier, "resolution");
    assert.match(a.headline, /ALL CLEAR/);
    assert.ok(a.headline.includes("$80.00"));
  });

  it("drops the key after a resolution so a fresh episode alerts again", () => {
    const first = evaluateAlerts([], [marginChange(12.5)], T0);
    const cleared = evaluateAlerts(first.state.keys, [marginChange(80)], T0 + 60_000);
    assert.equal(cleared.state.keys.filter((k) => k.key === "margin:free-below-floor").length, 0);
    const fresh = evaluateAlerts(cleared.state.keys, [marginChange(10)], T0 + 120_000);
    assert.equal(fresh.alerts.length, 1, "a new breach must alert immediately, not wait out a cooldown");
  });

  it("does not emit an all-clear for a condition that was never open", () => {
    const d = evaluateAlerts([], [marginChange(80)], T0);
    assert.equal(d.alerts.length, 0);
  });

  it("resolves an unprotected position when its exit is armed", () => {
    const opened = evaluateAlerts([], [noExitChange()], T0);
    assert.equal(opened.alerts.length, 1);
    const armed = evaluateAlerts(opened.state.keys, [{ kind: "exit-armed", pair: "SOL/USDT", why: "armed" }], T0 + 60_000);
    const a = only(armed.alerts);
    assert.equal(a.tier, "resolution");
    assert.match(a.headline, /ALL CLEAR/);
    assert.match(a.headline, /SOL\/USDT/);
  });

  it("resolves an unknown-origin position when it is cleared", () => {
    const open = evaluateAlerts([], [{ kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 0.007 }], T0);
    const closed = evaluateAlerts(
      open.state.keys,
      [{ kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 0.007, cleared: true }],
      T0 + 60_000,
    );
    const a = only(closed.alerts);
    assert.match(a.headline, /ALL CLEAR/);
    assert.match(a.headline, /BTC\/USDT/);
  });

  it("drops the escalation companion with the condition it belongs to", () => {
    const policy = { escalateAfterPolls: 1 };
    let keys: AlertKey[] = [];
    const change = marginChange(12.5);
    const p1 = evaluateAlerts(keys, [change], T0, { policy });
    keys = p1.state.keys;
    const p2 = evaluateAlerts(keys, [change], T0 + 60_000, { policy });
    keys = p2.state.keys;
    assert.ok(keys.some((k) => k.key === "margin:free-below-floor#escalated"), "the escalation key exists while the condition is open");

    const cleared = evaluateAlerts(keys, [marginChange(90)], T0 + 120_000, { policy });
    assert.equal(cleared.state.keys.filter((k) => k.key.startsWith("margin:free-below-floor")).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* grouping                                                           */
/* ------------------------------------------------------------------ */

describe("grouping", () => {
  it("collapses several changes in one poll into one message per tier", () => {
    const d = evaluateAlerts(
      [],
      [
        noExitChange("SOL/USDT"),
        noExitChange("ETH/USDT"),
        { kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 0.007 },
      ],
      T0,
    );
    assert.equal(d.alerts.length, 2, "one critical group + one warning group");
    const crit = d.alerts.find((a) => a.tier === "critical");
    assert.ok(crit);
    assert.match(crit.headline, /2× position opened without exit armed/);
    assert.ok(crit.headline.includes("SOL/USDT"));
    assert.ok(crit.headline.includes("ETH/USDT"));
    assert.equal(crit.findings.length, 2);
  });

  it("puts the numbers of every member in the detail", () => {
    const d = evaluateAlerts(
      [],
      [noExitChange("SOL/USDT"), noExitChange("ETH/USDT")],
      T0,
    );
    const crit = d.alerts.find((a) => a.tier === "critical");
    assert.ok(crit);
    assert.ok(crit.detail.includes("SOL/USDT"));
    assert.ok(crit.detail.includes("ETH/USDT"));
    assert.ok(crit.detail.includes("118.4"));
  });

  it("keeps the daily summary out of the routine info group", () => {
    const d = evaluateAlerts(
      [],
      [
        { kind: "fill", pair: "SOL/USDT", side: "buy", size: 12, price: 118.4, fillId: "f9" },
        { kind: "daily-summary", trades: 2, wins: 1, losses: 1, netPnlUsd: 0.5, feesUsd: 0.1, day: "2026-10-21" },
      ],
      T0,
    );
    assert.equal(d.alerts.length, 2);
    assert.ok(d.alerts.some((a) => a.tier === "info"));
    assert.ok(d.alerts.some((a) => a.tier === "summary"));
  });

  it("puts every action in the grouped detail", () => {
    const d = evaluateAlerts([], [noExitChange("SOL/USDT"), noExitChange("ETH/USDT")], T0);
    const crit = d.alerts.find((a) => a.tier === "critical");
    assert.ok(crit);
    assert.equal((crit.detail.match(/ACTION:/g) ?? []).length, 2);
  });
});

/* ------------------------------------------------------------------ */
/* rate limiting                                                      */
/* ------------------------------------------------------------------ */

describe("global rate limit", () => {
  it("holds routine alerts past the budget instead of dropping them", () => {
    const policy = { maxAlertsPerWindow: 1, rateWindowMs: 600_000 };
    // Three DIFFERENT tiers, so grouping cannot collapse them into one
    // message: an info fill, a warning stop hit, a critical breaker.
    const d = evaluateAlerts(
      [],
      [
        { kind: "fill", pair: "SOL/USDT", side: "buy", size: 1, price: 1, fillId: "a" },
        { kind: "fill", pair: "ETH/USDT", side: "sell", size: 1, price: 2, fillKind: "sl", fillId: "b" },
        { kind: "circuit-breaker", tripped: true, reason: "loss streak" },
      ],
      T0,
      { policy },
    );
    // The critical always goes out; the two routine tiers share the one
    // remaining slot and the rest are queued, not dropped.
    assert.equal(d.alerts.filter((a) => a.severity === "critical").length, 1, "a critical is never held back");
    assert.equal(d.alerts.length, 2, "one critical + one routine slot");
    assert.equal(d.queued.length, 1, "the overflow routine alert is queued, not dropped");
  });

  it("flushes the queued alerts on a later poll", () => {
    const policy = { maxAlertsPerWindow: 1, rateWindowMs: 60_000 };
    const first = evaluateAlerts(
      [],
      [
        { kind: "fill", pair: "SOL/USDT", side: "buy", size: 1, price: 1, fillId: "a" },
        { kind: "fill", pair: "ETH/USDT", side: "sell", size: 1, price: 2, fillKind: "sl", fillId: "b" },
      ],
      T0,
      { policy },
    );
    assert.equal(first.queued.length, 1);
    const queuedHeadline = first.queued[0]?.headline ?? "";

    const second = evaluateAlerts(first.state.keys, [], T0 + 120_000, { policy, sends: first.state.sends, pending: first.state.pending });
    assert.equal(second.alerts.length, 1, "the queued alert flushes once the window rolls");
    assert.equal(second.alerts[0]?.headline, queuedHeadline, "the queued alert is the one that flushes — nothing is lost or reordered");
    assert.equal(second.queued.length, 0);
  });

  it("never delays a CRITICAL alert", () => {
    const policy = { maxAlertsPerWindow: 1, rateWindowMs: 600_000 };
    const d = evaluateAlerts(
      [],
      [
        { kind: "fill", pair: "SOL/USDT", side: "buy", size: 1, price: 1, fillId: "a" },
        { kind: "kill-switch", engaged: true },
      ],
      T0,
      { policy },
    );
    assert.ok(d.alerts.some((a) => a.severity === "critical"), "a critical goes out even over the budget");
  });

  it("never drops a critical from the queue", () => {
    const policy = { maxAlertsPerWindow: 0, rateWindowMs: 600_000, maxPending: 1 };
    const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0, { policy });
    assert.equal(d.alerts.length, 1);
    assert.equal(d.queued.length, 0);
  });

  it("does not rate-limit an all-clear resolution", () => {
    const policy = { maxAlertsPerWindow: 1, rateWindowMs: 600_000 };
    const first = evaluateAlerts([], [marginChange(12.5)], T0, { policy });
    const cleared = evaluateAlerts(first.state.keys, [marginChange(90)], T0 + 1_000, { policy, sends: first.state.sends });
    assert.ok(cleared.alerts.some((a) => a.tier === "resolution"));
  });
});

/* ------------------------------------------------------------------ */
/* the diff (monitor → changes)                                       */
/* ------------------------------------------------------------------ */

describe("diffMachineState", () => {
  it("reports nothing when the machine state is unchanged", () => {
    const snap: MachineSnapshot = {
      killSwitchEngaged: false,
      freeMarginUsd: 500,
      marginFloorUsd: 50,
      positions: [{ pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: true }],
    };
    assert.equal(diffMachineState(snap, snap).length, 0);
  });

  it("reports a new position without an exit armed", () => {
    const changes = diffMachineState(
      { positions: [] },
      { positions: [{ pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: false }] },
    );
    assert.equal(changes.filter((c) => c.kind === "position-opened").length, 1);
  });

  it("re-reports an unprotected position every poll so it can escalate", () => {
    const prev: MachineSnapshot = { positions: [{ pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: false }] };
    const next: MachineSnapshot = { positions: [{ pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: false }] };
    const changes = diffMachineState(prev, next);
    assert.equal(changes.filter((c) => c.kind === "position-opened").length, 1);
  });

  it("reports a margin breach while it lasts and once more when it clears", () => {
    const prev: MachineSnapshot = { freeMarginUsd: 500, marginFloorUsd: 50 };
    const breach: MachineSnapshot = { freeMarginUsd: 10, marginFloorUsd: 50 };
    const ok: MachineSnapshot = { freeMarginUsd: 500, marginFloorUsd: 50 };
    assert.equal(diffMachineState(prev, breach).filter((c) => c.kind === "margin").length, 1);
    assert.equal(diffMachineState(breach, ok).filter((c) => c.kind === "margin").length, 1, "the clearing is reported once");
    assert.equal(diffMachineState(ok, ok).filter((c) => c.kind === "margin").length, 0);
  });

  it("reports a new fill exactly once", () => {
    const prev: MachineSnapshot = { fills: [{ id: "f1", pair: "SOL/USDT", side: "buy", size: 1, price: 2 }] };
    const next: MachineSnapshot = { fills: [{ id: "f1", pair: "SOL/USDT", side: "buy", size: 1, price: 2 }] };
    assert.equal(diffMachineState(prev, next).filter((c) => c.kind === "fill").length, 0);
    const fresh = diffMachineState(
      { fills: [] },
      { fills: [{ id: "f2", pair: "SOL/USDT", side: "buy", size: 1, price: 3 }] },
    );
    assert.equal(fresh.filter((c) => c.kind === "fill").length, 1);
  });

  it("reports a closed position", () => {
    const changes = diffMachineState(
      { positions: [{ pair: "SOL/USDT", side: "long", size: 12, price: 118.4, exitArmed: true }] },
      { positions: [] },
    );
    assert.equal(changes.filter((c) => c.kind === "position-closed").length, 1);
  });

  it("reports a daemon crash and a restart", () => {
    assert.equal(diffMachineState({ daemon: { status: "up" } }, { daemon: { status: "crashed", pid: 1, exitCode: 1 } })[0]?.kind, "daemon");
    assert.equal(diffMachineState({ daemon: { status: "up" } }, { daemon: { status: "restarted", pid: 2 } })[0]?.kind, "daemon");
  });
});

/* ------------------------------------------------------------------ */
/* transports                                                         */
/* ------------------------------------------------------------------ */

describe("transports", () => {
  it("uses the injected sender (a fake in tests)", async () => {
    const sent: Alert[] = [];
    const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0);
    const n = await dispatchAlerts(d.alerts, async (a) => {
      sent.push(a);
    });
    assert.equal(n, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.headline ?? "", /KILL SWITCH/);
  });

  it("the console transport writes the headline and the action", async () => {
    const linesOut: string[] = [];
    const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0);
    await dispatchAlerts(d.alerts, consoleTransport((l) => linesOut.push(l)));
    assert.equal(linesOut.length, 1);
    assert.match(linesOut[0] ?? "", /\[CRITICAL\]/);
    assert.ok((linesOut[0] ?? "").includes("ACTION:"));
  });

  it("the file transport appends JSONL", async () => {
    const sb = makeSandbox("jw3-alert-");
    try {
      const path = join(sb.dir, "alerts.jsonl");
      const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0);
      await dispatchAlerts(d.alerts, fileTransport(path));
      await dispatchAlerts(d.alerts, fileTransport(path));
      const raw = readFileSync(path, "utf8").trim().split("\n");
      assert.equal(raw.length, 2);
      const row = JSON.parse(raw[0] as string) as Alert;
      assert.equal(row.severity, "critical");
    } finally {
      sb.cleanup();
    }
  });

  it("formatAlert carries severity, headline and action", () => {
    const d = evaluateAlerts([], [{ kind: "kill-switch", engaged: true }], T0);
    const text = formatAlert(only(d.alerts));
    assert.match(text, /\[CRITICAL\]/);
    assert.match(text, /ACTION:/);
  });
});

/* ------------------------------------------------------------------ */
/* state persistence                                                  */
/* ------------------------------------------------------------------ */

describe("alert state persistence", () => {
  it("round-trips the retained state", () => {
    const sb = makeSandbox("jw3-alert-state-");
    try {
      const path = join(sb.dir, "state.json");
      const state: AlertState = {
        keys: [{ key: "margin:free-below-floor", fingerprint: "margin:b25", occurrences: 2, lastSentAt: T0, lastSeenAt: T0, active: true, escalated: false }],
        sends: [T0],
        pending: [],
      };
      saveAlertState(path, state);
      const back = loadAlertState(path);
      assert.equal(back.keys.length, 1);
      assert.equal(back.keys[0]?.occurrences, 2);
      assert.deepEqual(back.sends, [T0]);
    } finally {
      sb.cleanup();
    }
  });

  it("loads a file written in the OLD format unchanged", () => {
    const sb = makeSandbox("jw3-alert-state-");
    try {
      // Byte shape of the old saveAlertState: JSON + trailing newline.
      const path = join(sb.dir, "state.json");
      writeFileSync(path, `${JSON.stringify({ keys: [{ key: "k" }], sends: [T0], pending: [], extra: true }, null, 2)}\n`);
      const back = loadAlertState(path);
      assert.equal(back.keys.length, 1);
      assert.deepEqual(back.sends, [T0]);
      assert.equal("extra" in back, false);
    } finally {
      sb.cleanup();
    }
  });

  it("an empty state when the file does not exist", () => {
    const sb = makeSandbox("jw3-alert-state-");
    try {
      const state = loadAlertState(join(sb.dir, "nope.json"));
      assert.deepEqual(state.keys, []);
      assert.deepEqual(state.sends, []);
      assert.deepEqual(state.pending, []);
    } finally {
      sb.cleanup();
    }
  });

  it("refuses to reset an unreadable state (that would re-alert everything)", () => {
    const sb = makeSandbox("jw3-alert-state-");
    try {
      const path = join(sb.dir, "state.json");
      writeFileSync(path, "{ not json");
      assert.throws(() => loadAlertState(path), /not valid JSON/);
    } finally {
      sb.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* the command                                                        */
/* ------------------------------------------------------------------ */

describe("cmdAlert", () => {
  let sb: { dir: string; cleanup: () => void };
  let dir: string;
  let logged: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    sb = makeSandbox("jw3-alert-cmd-");
    dir = sb.dir;
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
    sb.cleanup();
  });

  const snapshot = (over: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
    killSwitchEngaged: false,
    freeMarginUsd: 500,
    marginFloorUsd: 50,
    positions: [],
    ...over,
  });

  it("alerts through the injected sender and persists the state", async () => {
    const snapPath = join(dir, "snap.json");
    const statePath = join(dir, "state.json");
    writeFileSync(snapPath, JSON.stringify(snapshot({ killSwitchEngaged: true })));

    const sent: Alert[] = [];
    await cmdAlert({
      snapshot: snapPath,
      statePath,
      prevSnapshot: join(dir, "prev.json"),
      now: T0,
      send: async (a) => {
        sent.push(a);
      },
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.headline ?? "", /KILL SWITCH ENGAGED/);
    assert.ok(loadAlertState(statePath).keys.length > 0, "the dedup state is retained for the next poll");
  });

  it("stays quiet on the second poll for the same finding", async () => {
    const snapPath = join(dir, "snap.json");
    const statePath = join(dir, "state.json");
    const prevPath = join(dir, "prev.json");
    writeFileSync(snapPath, JSON.stringify(snapshot({ killSwitchEngaged: true })));

    const sent: Alert[] = [];
    const send = async (a: Alert): Promise<void> => {
      sent.push(a);
    };
    await cmdAlert({ snapshot: snapPath, statePath, prevSnapshot: prevPath, now: T0, send });
    assert.equal(sent.length, 1);

    await cmdAlert({ snapshot: snapPath, statePath, prevSnapshot: prevPath, now: T0 + 60_000, send });
    assert.equal(sent.length, 1, "the same finding must not re-alert");
  });

  it("exits 1 on an unreadable snapshot and alerts nothing", async () => {
    const sent: Alert[] = [];
    await cmdAlert({
      snapshot: join(dir, "missing.json"),
      statePath: join(dir, "state.json"),
      now: T0,
      send: async (a) => {
        sent.push(a);
      },
    });
    assert.equal(process.exitCode, 1);
    assert.equal(sent.length, 0);
    assert.ok(logged.join("\n").includes("Failed"));
  });

  it("exits 2 without a snapshot path", async () => {
    await cmdAlert({ snapshot: "", now: T0 });
    assert.equal(process.exitCode, 2);
  });
});

/* ------------------------------------------------------------------ */
/* deriveFindings — the per-change mapping                           */
/* ------------------------------------------------------------------ */

describe("deriveFindings", () => {
  it("maps every change kind to at least one finding", () => {
    const changes: StateChange[] = [
      { kind: "kill-switch", engaged: true },
      { kind: "circuit-breaker", tripped: true, reason: "x" },
      { kind: "margin", freeUsd: 1, floorUsd: 50 },
      { kind: "daily-loss", lossUsd: 9, limitUsd: 5 },
      { kind: "position-opened", pair: "SOL/USDT", side: "long", size: 1, price: 2, exitArmed: false },
      { kind: "fill", pair: "SOL/USDT", side: "buy", size: 1, price: 2 },
      { kind: "fill", pair: "SOL/USDT", side: "sell", size: 1, price: 3, fillKind: "tp" },
      { kind: "fill", pair: "SOL/USDT", side: "sell", size: 1, price: 1, fillKind: "sl" },
      { kind: "unknown-origin", pair: "BTC/USDT", side: "short", size: 1 },
      { kind: "daemon", event: "crash", pid: 1 },
      { kind: "daemon", event: "restart", pid: 2 },
      { kind: "daily-summary", trades: 1, wins: 1, losses: 0, netPnlUsd: 1, feesUsd: 0.1 },
    ];
    for (const c of changes) {
      const f = deriveFindings(c);
      assert.ok(f.length > 0, `${c.kind} produced no finding`);
      for (const x of f) {
        assert.ok(x.headline.length > 0, `${c.kind} produced an empty headline`);
        assert.ok(x.action.length > 0, `${c.kind} produced no action`);
        assert.ok(x.key.length > 0, `${c.kind} produced no dedup key`);
        assert.ok(x.fingerprint.length > 0, `${c.kind} produced no fingerprint`);
      }
    }
  });

  it("numbers the money, never a vague message", () => {
    const f = deriveFindings({ kind: "margin", freeUsd: 3.2, floorUsd: 50, totalUsd: 500 })[0];
    assert.ok(f);
    assert.ok(f.headline.includes("$3.20"));
    assert.ok(f.headline.includes("$50.00"));
    assert.ok(f.detail.includes("$500.00"));
    assert.ok(f.action.includes("$50.00"));
  });
});
