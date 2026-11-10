/**
 * Kill-switch path pins (OQ-08 guard).
 *
 * `watchdog` (the independent kill-switch) is KEPT while `supervise` is
 * folded into `daemon` and deleted. These pins freeze the kill-switch
 * behavior so the fold cannot change it: the pure trip, the full
 * read→decide→act cycle with the server switch ON, and heartbeat-file
 * parsing for both the old supervise-heartbeat.json payload and the new
 * daemon-heartbeat.json payload. No network: every venue call is
 * injected. No state-changing commands: only check/cycle reads plus the
 * cycle's own cancel in the injected fake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeSandbox, writeJson } from "../test-fixtures.js";
import {
  decideWatchdog,
  defaultWatchdogPolicy,
  evaluateWatchdog,
  executorHeartbeatPath,
  readHeartbeatFile,
  runWatchdogCycle,
  type WatchdogAccountSnapshot,
  type WatchdogDecisionInput,
  type WatchdogRiskState,
} from "./watchdog.js";

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

const cleanAccount = (over: Partial<WatchdogAccountSnapshot> = {}): WatchdogAccountSnapshot => ({
  freeMarginUsd: 500,
  totalEquityUsd: 1000,
  positions: [],
  orders: [],
  consecutiveVenueErrors: 0,
  fundingRatePct: null,
  ...over,
});

const baseInput = (over: Partial<WatchdogDecisionInput> = {}): WatchdogDecisionInput => ({
  riskState: cleanRisk(),
  account: cleanAccount(),
  executorHeartbeat: { atMs: NOW - 1_000, source: "executor" },
  watchdogHeartbeat: { atMs: NOW - 1_000, source: "watchdog" },
  ownership: { ownedOrderIds: [], ownedPairs: ["SOL/USDT"], ownedClientOidPrefixes: [] },
  policy: defaultWatchdogPolicy(),
  now: NOW,
  invocation: {},
  breaker: null,
  ...over,
});

describe("kill-switch pin — pure decision", () => {
  it("trips kill_switch with the exact reason, blocks the server gate, breaker first", () => {
    const d = decideWatchdog(baseInput({ riskState: cleanRisk({ killSwitch: true }) }));
    assert.equal(d.tripped, true);
    assert.equal(d.shouldAct, true);
    assert.equal(d.latched, false);
    const trip = d.trips.find((t) => t.code === "kill_switch");
    assert.ok(trip, "expected a kill_switch trip");
    assert.equal(trip.reason, "server kill switch is ON — the operator halted trading");
    assert.deepEqual(trip.detail, { source: "risk_limits.kill_switch_enabled" });
    assert.equal(d.serverWriteGate, "blocked");
    assert.deepEqual(
      d.actions.map((a) => a.type),
      ["set_breaker", "cancel_orders", "block_entries", "alert"],
    );
  });

  it("leaves the gate open and takes no action when the switch is off", () => {
    const d = decideWatchdog(baseInput());
    assert.equal(d.tripped, false);
    assert.equal(d.shouldAct, false);
    assert.equal(d.serverWriteGate, "open");
    assert.deepEqual(d.actions, []);
  });

  it("reports the gate blocked through evaluateWatchdog when the server switch is ON", async () => {
    const sb = makeSandbox("jw3-killswitch-pin-");
    try {
      const hb = writeJson(sb.dir, "exec-heartbeat.json", {
        event: "daemon-heartbeat",
        at: new Date(NOW - 5_000).toISOString(),
      });
      const deps = {
        call: (async (name: string) => {
          if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: true } };
          if (name === "list_open_orders") return [];
          return { merged: [{ asset: "USDT", free: 400, total: 1000 }] };
        }) as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: sb.dir,
        cfgDir: sb.dir,
        executorHeartbeatFile: hb,
        funding: (async () => null) as never,
        now: () => NOW,
      };
      const ev = await evaluateWatchdog({ exchange: "kucoin", pat: "p", sub: "check" }, deps);
      const trip = ev.decision.trips.find((t) => t.code === "kill_switch");
      assert.ok(trip, "expected a kill_switch trip from the live risk read");
      assert.equal(ev.decision.serverWriteGate, "blocked");
      assert.equal(ev.decision.shouldAct, true);
    } finally {
      sb.cleanup();
    }
  });
});

describe("kill-switch pin — cycle acts breaker-first and latches", () => {
  it("set_breaker → cancel own orders → block entries → alert, breaker latched", async () => {
    const sb = makeSandbox("jw3-killswitch-pin-");
    try {
      writeJson(sb.dir, "scalp_sol.json", { pair: "SOL/USDT", placed: [{ orderId: "o1" }] });
      const calls: { name: string; args: Record<string, unknown> }[] = [];
      const deps = {
        call: (async (name: string, args: Record<string, unknown>) => {
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
        }) as never,
        listConns: (async () => [{ id: "c1", exchange: "kucoin" }]) as never,
        stateDir: sb.dir,
        cfgDir: sb.dir,
        executorHeartbeatFile: join(sb.dir, "exec-heartbeat.json"),
        funding: (async () => null) as never,
        now: () => NOW,
      };
      const result = await runWatchdogCycle({ exchange: "kucoin", pat: "p" }, deps);
      assert.deepEqual(
        result.executed.map((e) => e.type),
        ["set_breaker", "cancel_orders", "block_entries", "alert"],
      );
      assert.equal(result.state.breaker.tripped, true);
      assert.equal(result.state.entriesBlocked, true);
      const cancels = calls.filter((c) => c.name === "cancel_order");
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0]?.args.orderId, "o1");
    } finally {
      sb.cleanup();
    }
  });
});

describe("kill-switch pin — heartbeat-file compat", () => {
  it("parses both the supervise and daemon heartbeat payloads; missing reads as no beat", () => {
    const sb = makeSandbox("jw3-killswitch-pin-");
    try {
      const at = new Date(NOW - 5_000).toISOString();
      const sup = writeJson(sb.dir, "supervise-heartbeat.json", {
        event: "supervise-heartbeat",
        at,
        uptimeSec: 12,
      });
      const daemon = writeJson(sb.dir, "daemon-heartbeat.json", {
        event: "daemon-heartbeat",
        at,
        uptimeSec: 12,
      });
      assert.equal(readHeartbeatFile(sup, "executor").atMs, Date.parse(at));
      assert.equal(readHeartbeatFile(daemon, "executor").atMs, Date.parse(at));
      assert.equal(readHeartbeatFile(join(sb.dir, "nope.json"), "executor").atMs, null);
    } finally {
      sb.cleanup();
    }
  });

  it("default executor heartbeat is the daemon's (OQ-08 fold target)", () => {
    assert.equal(executorHeartbeatPath("/cfg"), "/cfg/daemon-heartbeat.json");
  });
});
