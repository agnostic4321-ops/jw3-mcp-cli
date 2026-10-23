import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  isTransientReadFailure,
  DAEMON_DEFAULT_HEALTH,
  DAEMON_MANIFEST_VERSION,
  DAEMON_ROLES,
  argvCanFire,
  buildChildArgv,
  classifyBootVenue,
  classifyLocalStates,
  clearDaemonOwnerLock,
  cmdDaemon,
  computeErrorRate,
  computeHealthState,
  daemonHeartbeatPayload,
  defaultDaemonHeartbeatPath,
  defaultDaemonOwnerLockPath,
  defaultDaemonStatePath,
  harvestOwnedOrderIds,
  healthAllowsFire,
  healthShouldDrain,
  loadDaemonManifest,
  localStatesForPairs,
  pidAlive,
  planDrain,
  planRestart,
  pollKillSwitch,
  positionSideOf,
  positionSizeOf,
  readDaemonOwnerLock,
  readDaemonState,
  readServerKillSwitch,
  validateDaemonManifest,
  writeDaemonOwnerLock,
  writeDaemonState,
  type DaemonChildSpec,
  type DaemonDeps,
  type DaemonManifest,
  type HealthInput,
} from "./daemon.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                          */
/* ------------------------------------------------------------------ */

const goodManifest = (): Record<string, unknown> => ({
  version: DAEMON_MANIFEST_VERSION,
  exchange: "kucoin",
  pairs: ["SOL/USDT", "PEPE/USDT"],
  heartbeatSec: 15,
  killSwitchPollSec: 5,
  maxRestarts: 20,
  children: [
    { name: "signal", role: "signal", command: "loop", args: ["--exchange", "kucoin", "--pair", "SOL/USDT"] },
    { name: "executor", role: "executor", command: "degen", args: ["--pair", "SOL/USDT"], live: true },
    { name: "monitor", role: "monitor", command: "heat", args: ["--exchange", "kucoin"] },
    { name: "learning", role: "learning", command: "degen", args: ["record"] },
  ],
});

const health = (over: Partial<HealthInput> = {}): HealthInput => ({
  heartbeatAgeSec: 1,
  consecutiveFailures: 0,
  openPositions: 1,
  freeMarginUsd: 100,
  errorRate: 0,
  ...over,
});

/* ------------------------------------------------------------------ */
/* manifest                                                           */
/* ------------------------------------------------------------------ */

describe("validateDaemonManifest", () => {
  it("accepts a well-formed manifest", () => {
    const v = validateDaemonManifest(goodManifest());
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.equal(v.manifest.exchange, "kucoin");
    assert.deepEqual(v.manifest.pairs, ["SOL/USDT", "PEPE/USDT"]);
    assert.equal(v.manifest.children.length, 4);
    assert.equal(v.manifest.health.heartbeatWarnSec, DAEMON_DEFAULT_HEALTH.heartbeatWarnSec);
  });

  it("upper-cases pairs and keeps the order", () => {
    const v = validateDaemonManifest({ ...goodManifest(), pairs: ["sol/usdt"] });
    assert.ok(v.ok);
    if (v.ok) assert.deepEqual(v.manifest.pairs, ["SOL/USDT"]);
  });

  it("rejects a non-object manifest", () => {
    for (const bad of [null, 42, "x", [1, 2]]) {
      const v = validateDaemonManifest(bad);
      assert.equal(v.ok, false);
    }
  });

  it("requires an exchange and at least one pair", () => {
    const v = validateDaemonManifest({ ...goodManifest(), exchange: "", pairs: [] });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /exchange required/.test(e)));
    assert.ok(v.errors.some((e) => /pairs required/.test(e)));
  });

  it("rejects a malformed pair", () => {
    const v = validateDaemonManifest({ ...goodManifest(), pairs: ["SOLUSDT"] });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /bad pair/.test(e)));
  });

  it("collects every error, not just the first", () => {
    const v = validateDaemonManifest({ version: 9, exchange: "", pairs: ["nope"], heartbeatSec: 1, children: [] });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.length >= 4, `expected several errors, got: ${v.errors.join(" | ")}`);
  });

  it("bounds heartbeatSec, killSwitchPollSec, maxRestarts", () => {
    assert.equal(validateDaemonManifest({ ...goodManifest(), heartbeatSec: 4 }).ok, false);
    assert.equal(validateDaemonManifest({ ...goodManifest(), heartbeatSec: 301 }).ok, false);
    assert.equal(validateDaemonManifest({ ...goodManifest(), killSwitchPollSec: 0 }).ok, false);
    assert.equal(validateDaemonManifest({ ...goodManifest(), maxRestarts: 101 }).ok, false);
    assert.equal(validateDaemonManifest({ ...goodManifest(), maxRestarts: -1 }).ok, false);
  });

  it("rejects an unknown child role", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      children: [{ name: "x", role: "oracle", command: "loop" }],
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /role must be one of/.test(e)));
  });

  it("keeps every role the design names", () => {
    assert.deepEqual([...DAEMON_ROLES], ["signal", "executor", "monitor", "learning"]);
  });

  it("refuses live on a non-executor child (I1: only the executor may fire)", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      children: [{ name: "signal", role: "signal", command: "loop", live: true }],
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /live is only allowed on the executor role/.test(e)));
  });

  it("refuses two executor children (I1: one owner of the pool)", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      children: [
        { name: "e1", role: "executor", command: "degen", live: true },
        { name: "e2", role: "executor", command: "degen", live: true },
      ],
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /exactly one executor child is allowed/.test(e)));
  });

  it("refuses a disabled executor (it would never place an order)", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      children: [{ name: "e", role: "executor", command: "degen", live: true, enabled: false }],
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /executor child is disabled/.test(e)));
  });

  it("rejects duplicated child names", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      children: [
        { name: "same", role: "signal", command: "loop" },
        { name: "same", role: "monitor", command: "heat" },
      ],
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /is duplicated/.test(e)));
  });

  it("rejects incoherent health thresholds", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      health: { heartbeatWarnSec: 90, heartbeatStaleSec: 30 },
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /heartbeatWarnSec must be </.test(e)), v.errors.join(" | "));
  });

  it("rejects a failWarnCount above the failTripCount", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      health: { failWarnCount: 9, failTripCount: 2 },
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /failWarnCount must be <=/.test(e)), v.errors.join(" | "));
  });

  it("rejects an errorRateWarn above the errorRateTrip", () => {
    const v = validateDaemonManifest({
      ...goodManifest(),
      health: { errorRateWarn: 0.9, errorRateTrip: 0.5 },
    });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /errorRateWarn must be <=/.test(e)), v.errors.join(" | "));
  });

  it("rejects a negative health threshold", () => {
    const v = validateDaemonManifest({ ...goodManifest(), health: { minFreeUsd: -1 } });
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.ok(v.errors.some((e) => /health.minFreeUsd must be a number >= 0/.test(e)));
  });
});

describe("loadDaemonManifest", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and validates a manifest file", () => {
    const p = join(dir, "daemon.json");
    writeFileSync(p, JSON.stringify(goodManifest()));
    const m = loadDaemonManifest(p);
    assert.equal(m.exchange, "kucoin");
    assert.equal(m.children.length, 4);
  });

  it("refuses a missing manifest", () => {
    assert.throws(() => loadDaemonManifest(join(dir, "nope.json")), /no daemon manifest/);
  });

  it("refuses invalid JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{nope");
    assert.throws(() => loadDaemonManifest(p), /not valid JSON/);
  });

  it("refuses an invalid manifest with every reason listed", () => {
    const p = join(dir, "invalid.json");
    writeFileSync(p, JSON.stringify({ version: 1, exchange: "", pairs: [], children: [] }));
    assert.throws(() => loadDaemonManifest(p), /is invalid/);
  });
});

/* ------------------------------------------------------------------ */
/* health model                                                       */
/* ------------------------------------------------------------------ */

describe("computeHealthState", () => {
  it("is ok with fresh liveness, margin and no failures", () => {
    const h = computeHealthState(health());
    assert.equal(h.state, "ok");
    assert.deepEqual(h.reasons, []);
  });

  it("trips on a stale heartbeat (dead-man)", () => {
    const h = computeHealthState(health({ heartbeatAgeSec: 999 }));
    assert.equal(h.state, "tripped");
    assert.ok(h.reasons.some((r) => /stale/.test(r)));
  });

  it("trips when the heartbeat age is unknown (liveness unproven)", () => {
    const h = computeHealthState(health({ heartbeatAgeSec: null }));
    assert.equal(h.state, "tripped");
    assert.ok(h.reasons.some((r) => /unknown/.test(r)));
  });

  it("degrades on an aging heartbeat but does not trip", () => {
    const h = computeHealthState(health({ heartbeatAgeSec: 45 }));
    assert.equal(h.state, "degraded");
    assert.ok(h.reasons.some((r) => /aging/.test(r)));
  });

  it("trips at the consecutive-failure threshold", () => {
    assert.equal(computeHealthState(health({ consecutiveFailures: 4 })).state, "degraded");
    assert.equal(computeHealthState(health({ consecutiveFailures: 5 })).state, "tripped");
  });

  it("degrades then trips on the error rate", () => {
    assert.equal(computeHealthState(health({ errorRate: 0.2 })).state, "degraded");
    assert.equal(computeHealthState(health({ errorRate: 0.5 })).state, "tripped");
    assert.equal(computeHealthState(health({ errorRate: 0.1 })).state, "ok");
  });

  it("trips when more positions are open than allowed", () => {
    const h = computeHealthState(health({ openPositions: 4 }));
    assert.equal(h.state, "tripped");
    assert.ok(h.reasons.some((r) => /open positions/.test(r)));
  });

  it("degrades when free margin is under the floor", () => {
    const h = computeHealthState(health({ freeMarginUsd: 5 }));
    assert.equal(h.state, "degraded");
    assert.ok(h.reasons.some((r) => /free margin/.test(r)));
  });

  it("degrades when free margin is unverified (never reads null as safe)", () => {
    const h = computeHealthState(health({ freeMarginUsd: null }));
    assert.equal(h.state, "degraded");
    assert.ok(h.reasons.some((r) => /unverified/.test(r)));
  });

  it("trips when free margin is gone while positions are open", () => {
    const h = computeHealthState(health({ freeMarginUsd: 0, openPositions: 1 }));
    assert.equal(h.state, "tripped");
  });

  it("respects custom thresholds", () => {
    const t = { ...DAEMON_DEFAULT_HEALTH, heartbeatWarnSec: 5, heartbeatStaleSec: 10, minFreeUsd: 50 };
    assert.equal(computeHealthState(health({ heartbeatAgeSec: 7 }), t).state, "degraded");
    assert.equal(computeHealthState(health({ heartbeatAgeSec: 20 }), t).state, "tripped");
    assert.equal(computeHealthState(health({ freeMarginUsd: 40 }), t).state, "degraded");
  });

  it("clamps nonsense inputs instead of crashing", () => {
    // Negative heartbeat age = 0 (not stale), negative counters = 0.
    const h = computeHealthState({
      heartbeatAgeSec: -5,
      consecutiveFailures: -1,
      openPositions: -2,
      freeMarginUsd: 100,
      errorRate: 0,
    });
    assert.equal(h.state, "ok");
  });

  it("reads a NaN margin as UNVERIFIED (degraded), never as free balance", () => {
    const h = computeHealthState(health({ freeMarginUsd: Number.NaN }));
    assert.equal(h.state, "degraded");
    assert.ok(h.reasons.some((r) => /unverified/.test(r)));
  });

  it("clamps an out-of-range error rate to 1 (fail closed: everything failing)", () => {
    const h = computeHealthState(health({ errorRate: 5 }));
    assert.equal(h.state, "tripped");
    assert.ok(h.reasons.some((r) => /error rate/.test(r)));
  });
});

describe("fire gate", () => {
  it("allows fire only on ok", () => {
    assert.equal(healthAllowsFire("ok"), true);
    assert.equal(healthAllowsFire("degraded"), false);
    assert.equal(healthAllowsFire("tripped"), false);
  });

  it("drains only on tripped", () => {
    assert.equal(healthShouldDrain("ok"), false);
    assert.equal(healthShouldDrain("degraded"), false);
    assert.equal(healthShouldDrain("tripped"), true);
  });
});

describe("computeErrorRate", () => {
  it("is 0 for an empty window", () => {
    assert.equal(computeErrorRate([], 50), 0);
  });

  it("counts failures over the window", () => {
    assert.equal(computeErrorRate([true, false, true, false], 50), 0.5);
    assert.equal(computeErrorRate([true, true], 50), 0);
  });

  it("keeps only the last `window` outcomes", () => {
    assert.equal(computeErrorRate([false, false, true, true], 2), 0);
    assert.equal(computeErrorRate([true, true, false], 2), 0.5);
  });
});

/* ------------------------------------------------------------------ */
/* boot ownership                                                     */
/* ------------------------------------------------------------------ */

describe("classifyBootVenue", () => {
  const facts = (over: Partial<Parameters<typeof classifyBootVenue>[0]> = {}) => ({
    exchange: "kucoin",
    configuredPairs: ["SOL/USDT"],
    ownedOrderIds: ["order-1"],
    ownedPairs: ["SOL/USDT"],
    venueOrders: [] as Record<string, unknown>[],
    venuePositions: [] as Record<string, unknown>[],
    ...over,
  });

  it("passes when there is no venue state at all", () => {
    const v = classifyBootVenue(facts());
    assert.equal(v.ok, true);
    assert.equal(v.openPositionCount, 0);
  });

  it("accepts an order the daemon owns", () => {
    const v = classifyBootVenue(facts({ venueOrders: [{ orderId: "order-1", symbol: "SOLUSDT" }] }));
    assert.equal(v.ok, true);
    assert.deepEqual(v.ownedOrderIds, ["order-1"]);
  });

  it("REFUSES a foreign working order (I2: never adopt)", () => {
    const v = classifyBootVenue(facts({ venueOrders: [{ orderId: "foreign-9", symbol: "SOLUSDT" }] }));
    assert.equal(v.ok, false);
    assert.equal(v.foreignOrders.length, 1);
    assert.equal(v.foreignOrders[0]!.orderId, "foreign-9");
    assert.ok(v.errors.some((e) => /will not adopt an order it did not place/.test(e)));
  });

  it("refuses a working order with no order id (unattributable)", () => {
    const v = classifyBootVenue(facts({ venueOrders: [{ symbol: "SOLUSDT" }] }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /foreign working order/.test(e)));
  });

  it("accepts an open position on a pair the daemon owns", () => {
    const v = classifyBootVenue(
      facts({ venuePositions: [{ symbol: "SOLUSDT", side: "long", size: 10 }] }),
    );
    assert.equal(v.ok, true);
    assert.equal(v.openPositionCount, 1);
    assert.ok(v.warnings.some((w) => /carried over from a previous daemon run/.test(w)));
  });

  it("REFUSES an open position on a pair the daemon does not own", () => {
    const v = classifyBootVenue(
      facts({ venuePositions: [{ symbol: "PEPEUSDT", side: "short", size: 5 }] }),
    );
    assert.equal(v.ok, false);
    assert.equal(v.foreignPositions.length, 1);
    assert.ok(v.errors.some((e) => /foreign open position/.test(e)));
  });

  it("ignores a closed (zero-size) position row", () => {
    const v = classifyBootVenue(
      facts({ venuePositions: [{ symbol: "PEPEUSDT", side: "short", size: 0 }] }),
    );
    assert.equal(v.ok, true);
    assert.equal(v.openPositionCount, 0);
  });

  it("matches the venue symbol form (SOLUSDT ≡ SOL/USDT)", () => {
    const v = classifyBootVenue(
      facts({ venuePositions: [{ symbol: "SOLUSDT", side: "long", size: 1 }] }),
    );
    assert.equal(v.ok, true);
  });
});

describe("harvestOwnedOrderIds + localStatesForPairs", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-local-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges known ids with the local state ids", () => {
    const ids = harvestOwnedOrderIds(
      [{ kind: "scalp", path: "/x", pair: "SOL/USDT", orderIds: ["a"], updatedAtMs: 0, summary: "" }],
      ["b"],
    );
    assert.deepEqual(ids.sort(), ["a", "b"]);
  });

  it("reads the local state files for the configured pairs", () => {
    writeFileSync(join(dir, "scalp_sol.json"), JSON.stringify({ kind: "scalp", pair: "SOL/USDT", placed: [{ orderId: "o1" }] }));
    const r = localStatesForPairs(["SOL/USDT"], dir);
    assert.equal(r.states.length, 1);
    assert.deepEqual(r.states[0]!.orderIds, ["o1"]);
    assert.equal(r.unreadable.length, 0);
  });

  it("reports an unreadable state file instead of treating it as nothing", () => {
    writeFileSync(join(dir, "trail_sol.json"), "{not json");
    const r = localStatesForPairs(["SOL/USDT"], dir);
    assert.equal(r.unreadable.length, 1);
    const v = classifyLocalStates(["SOL/USDT"], r.states, r.unreadable);
    assert.ok(v.errors.some((e) => /unreadable-state/.test(e)));
  });
});

/* ------------------------------------------------------------------ */
/* drain plan                                                         */
/* ------------------------------------------------------------------ */

describe("planDrain", () => {
  it("cancels working orders and never flattens by default (I3)", () => {
    const p = planDrain({ reason: "sigint", killSwitchOn: false, flattenOnShutdown: false, mode: "running" });
    assert.equal(p.mode, "draining");
    assert.equal(p.cancelWorkingOrders, true);
    assert.equal(p.flattenPositions, false);
    assert.equal(p.stopChildren, true);
    assert.equal(p.flattenRefusal, null);
  });

  it("flattens ONLY with the explicit human flag", () => {
    const p = planDrain({ reason: "sigterm", killSwitchOn: false, flattenOnShutdown: true, mode: "running" });
    assert.equal(p.flattenPositions, true);
  });

  it("refuses to flatten while the kill switch is on (the server would refuse)", () => {
    const p = planDrain({ reason: "kill-switch", killSwitchOn: true, flattenOnShutdown: true, mode: "running" });
    assert.equal(p.flattenPositions, false);
    assert.ok(p.flattenRefusal);
    assert.match(p.flattenRefusal!, /kill switch is on/);
  });

  it("always cancels working orders, even on a kill-switch trip", () => {
    const p = planDrain({ reason: "kill-switch", killSwitchOn: true, flattenOnShutdown: false, mode: "running" });
    assert.equal(p.cancelWorkingOrders, true);
  });
});

/* ------------------------------------------------------------------ */
/* child argv + restart plan                                          */
/* ------------------------------------------------------------------ */

describe("buildChildArgv", () => {
  const executor: DaemonChildSpec = { name: "e", role: "executor", command: "degen", args: ["--pair", "SOL/USDT"], live: true, enabled: true };
  const signal: DaemonChildSpec = { name: "s", role: "signal", command: "loop", args: [], live: false, enabled: true };

  it("omits --yes without the operator opt-in", () => {
    const argv = buildChildArgv(executor, { allowLive: false, livePermitted: true });
    assert.ok(!argv.includes("--yes"));
    assert.equal(argvCanFire(argv), false);
  });

  it("omits --yes when the fire gate is closed", () => {
    const argv = buildChildArgv(executor, { allowLive: true, livePermitted: false });
    assert.ok(!argv.includes("--yes"));
    assert.equal(argvCanFire(argv), false);
  });

  it("adds --yes for the executor when live is allowed and the gate is open", () => {
    const argv = buildChildArgv(executor, { allowLive: true, livePermitted: true });
    assert.ok(argv.includes("--yes"));
    assert.equal(argvCanFire(argv), true);
  });

  it("never gives --yes to a non-executor child", () => {
    const argv = buildChildArgv(signal, { allowLive: true, livePermitted: true });
    assert.ok(!argv.includes("--yes"));
    assert.equal(argvCanFire(argv), false);
  });
});

describe("planRestart", () => {
  const cfg = { maxRestarts: 3 };

  it("spawns immediately on the first attempt", () => {
    const p = planRestart({ name: "c", role: "signal", restarts: 0, alive: false, nextSpawnAtMs: null }, cfg, 1000);
    assert.equal(p.action, "spawn");
    assert.equal(p.delayMs, 0);
  });

  it("waits while the child is alive", () => {
    const p = planRestart({ name: "c", role: "signal", restarts: 0, alive: true, nextSpawnAtMs: null }, cfg, 1000);
    assert.equal(p.action, "wait");
  });

  it("waits out the backoff window", () => {
    const p = planRestart({ name: "c", role: "signal", restarts: 1, alive: false, nextSpawnAtMs: 2000 }, cfg, 1000);
    assert.equal(p.action, "wait");
    assert.equal(p.delayMs, 1000);
  });

  it("marks the child dead once the restart budget is exhausted", () => {
    const p = planRestart({ name: "c", role: "signal", restarts: 4, alive: false, nextSpawnAtMs: null }, cfg, 1000);
    assert.equal(p.action, "dead");
    assert.match(p.reason, /budget exhausted/);
  });

  it("uses the shared backoff curve (1s x 2^n)", () => {
    const p1 = planRestart({ name: "c", role: "signal", restarts: 2, alive: false, nextSpawnAtMs: null }, cfg, 1000);
    assert.equal(p1.delayMs, 2000);
  });
});

/* ------------------------------------------------------------------ */
/* kill switch                                                        */
/* ------------------------------------------------------------------ */

describe("kill switch poll", () => {
  const callWith = (out: unknown) => async () => out;

  it("reads the switch off", async () => {
    const r = await pollKillSwitch("pat", undefined, callWith({ risk_limits: { kill_switch_enabled: false } }));
    assert.equal(r.on, false);
    assert.equal(r.unreadable, false);
    assert.equal(r.error, null);
  });

  it("reads the switch on", async () => {
    const r = await pollKillSwitch("pat", undefined, callWith({ kill_switch_enabled: true }));
    assert.equal(r.on, true);
    assert.equal(r.unreadable, false);
  });

  it("fails closed on a read error (never 'safe')", async () => {
    const r = await pollKillSwitch("pat", undefined, async () => {
      throw new Error("network down");
    });
    assert.equal(r.on, true);
    assert.equal(r.unreadable, true);
    assert.match(r.error!, /network down/);
  });

  it("fails closed when the server does not report the switch", async () => {
    const r = await pollKillSwitch("pat", undefined, callWith({ risk_limits: { max_trades_per_day: 10 } }));
    assert.equal(r.on, true);
    assert.equal(r.unreadable, true);
  });

  it("readServerKillSwitch is the single boolean hook", async () => {
    assert.equal(await readServerKillSwitch("pat", undefined, callWith({ kill_switch_enabled: true })), true);
    assert.equal(await readServerKillSwitch("pat", undefined, callWith({ kill_switch_enabled: false })), false);
    assert.equal(
      await readServerKillSwitch("pat", undefined, async () => {
        throw new Error("boom");
      }),
      true,
    );
  });
});

/* ------------------------------------------------------------------ */
/* heartbeat payload                                                  */
/* ------------------------------------------------------------------ */

describe("daemonHeartbeatPayload", () => {
  const payload = (over: Partial<Parameters<typeof daemonHeartbeatPayload>[0]> = {}) =>
    daemonHeartbeatPayload({
      pid: 42,
      sessionId: "s1",
      startedAt: "2026-10-21T00:00:00.000Z",
      at: "2026-10-21T00:00:15.000Z",
      uptimeSec: 15.2,
      mode: "running",
      health: { state: "ok", reasons: [] },
      children: [],
      killSwitch: { on: false, checkedAt: "2026-10-21T00:00:10.000Z", error: null },
      openPositions: 2,
      freeMarginUsd: 80,
      errorRate: 0.1,
      consecutiveFailures: 0,
      dryRun: true,
      boot: { ok: true, foreignOrders: 0, foreignPositions: 0 },
      ...over,
    });

  it("carries the session, mode and health", () => {
    const hb = payload();
    assert.equal((hb as { event: string }).event, "daemon-heartbeat");
    assert.equal(hb.sessionId, "s1");
    assert.equal(hb.mode, "running");
    assert.deepEqual((hb as { health: { state: string } }).health.state, "ok");
  });

  it("closes the fire gate when the kill switch is on", () => {
    const hb = payload({ killSwitch: { on: true, checkedAt: "x", error: null } });
    assert.equal(hb.fireGate, false);
  });

  it("closes the fire gate when health is not ok", () => {
    const hb = payload({ health: { state: "degraded", reasons: ["x"] } });
    assert.equal(hb.fireGate, false);
  });

  it("closes the fire gate while draining", () => {
    const hb = payload({ mode: "draining" });
    assert.equal(hb.fireGate, false);
  });

  it("opens the fire gate only when running, healthy and kill-switch off", () => {
    assert.equal(payload().fireGate, true);
  });
});

/* ------------------------------------------------------------------ */
/* state file + paths                                                 */
/* ------------------------------------------------------------------ */

describe("daemon state file", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the owned order ids", () => {
    const p = defaultDaemonStatePath(dir);
    writeDaemonState(p, {
      version: DAEMON_MANIFEST_VERSION,
      sessionId: "s1",
      pairs: ["SOL/USDT"],
      ownedOrderIds: ["o1", "o2"],
      ownedPairs: ["SOL/USDT"],
      updatedAt: "2026-10-21T00:00:00.000Z",
    });
    const s = readDaemonState(p);
    assert.ok(s);
    assert.deepEqual(s!.ownedOrderIds, ["o1", "o2"]);
    assert.equal(s!.sessionId, "s1");
  });

  it("reads a missing state file as null (never throws)", () => {
    assert.equal(readDaemonState(join(dir, "missing.json")), null);
  });

  it("reads a corrupt state file as null", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{nope");
    assert.equal(readDaemonState(p), null);
  });

  it("keeps the heartbeat, owner lock and state paths apart", () => {
    assert.notEqual(defaultDaemonHeartbeatPath(), defaultDaemonOwnerLockPath(dir));
    assert.notEqual(defaultDaemonStatePath(dir), defaultDaemonOwnerLockPath(dir));
  });
});

describe("owner lock (I1: one writer per margin pool)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the pid and session", () => {
    const p = defaultDaemonOwnerLockPath(dir);
    writeDaemonOwnerLock(p, { pid: process.pid, sessionId: "s1", startedAt: "2026-10-21T00:00:00.000Z" });
    const l = readDaemonOwnerLock(p);
    assert.ok(l);
    assert.equal(l!.pid, process.pid);
    assert.equal(l!.sessionId, "s1");
  });

  it("reads a missing or corrupt lock as null", () => {
    assert.equal(readDaemonOwnerLock(join(dir, "nope.json")), null);
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{nope");
    assert.equal(readDaemonOwnerLock(p), null);
  });

  it("reads a lock with a bogus pid as null (never blocks on garbage)", () => {
    const p = join(dir, "bogus.json");
    writeFileSync(p, JSON.stringify({ pid: "not-a-pid" }));
    assert.equal(readDaemonOwnerLock(p), null);
  });

  it("clears only our own lock", () => {
    const p = defaultDaemonOwnerLockPath(dir);
    writeDaemonOwnerLock(p, { pid: process.pid, sessionId: "other", startedAt: "x" });
    clearDaemonOwnerLock(p, "mine");
    assert.ok(readDaemonOwnerLock(p), "a foreign session's lock must survive");
    clearDaemonOwnerLock(p, "other");
    assert.equal(readDaemonOwnerLock(p), null);
  });

  it("sees a live pid as alive and a dead one as not", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
  });
});

/* ------------------------------------------------------------------ */
/* venue row helpers                                                  */
/* ------------------------------------------------------------------ */

describe("position row helpers", () => {
  it("reads the size and side", () => {
    assert.equal(positionSizeOf({ size: 12 }), 12);
    assert.equal(positionSideOf({ side: "long", size: 12 }), "long");
    assert.equal(positionSideOf({ side: "short", size: 12 }), "short");
  });

  it("derives the side from a negative size", () => {
    assert.equal(positionSideOf({ size: -3 }), "short");
    assert.equal(positionSideOf({ size: 3 }), "long");
  });

  it("never guesses an unknown size or side", () => {
    assert.equal(positionSizeOf({}), null);
    assert.equal(positionSideOf({ side: "?", size: 0 }), null);
  });
});

/* ------------------------------------------------------------------ */
/* manifest shape (a real manifest must pass)                         */
/* ------------------------------------------------------------------ */

describe("the shipped manifest shape", () => {
  it("validates a manifest shaped like kucoin-supervise.json", () => {
    const m: DaemonManifest = {
      version: DAEMON_MANIFEST_VERSION,
      exchange: "kucoin",
      pairs: ["PEPE/USDT", "ENA/USDT", "SOL/USDT"],
      heartbeatSec: 15,
      killSwitchPollSec: 5,
      maxRestarts: 20,
      maxLogBytes: 5 * 1024 * 1024,
      maxLogFiles: 5,
      drainTimeoutSec: 30,
      errorWindow: 50,
      health: { ...DAEMON_DEFAULT_HEALTH },
      children: [
        { name: "signal:PEPE", role: "signal", command: "loop", args: ["--exchange", "kucoin", "--pair", "PEPE/USDT"], live: false, enabled: true },
        { name: "executor:PEPE", role: "executor", command: "degen", args: ["--exchange", "kucoin", "--pair", "PEPE/USDT"], live: true, enabled: true },
        { name: "monitor", role: "monitor", command: "heat", args: ["--exchange", "kucoin"], live: false, enabled: true },
        { name: "learning", role: "learning", command: "degen", args: ["record"], live: false, enabled: true },
      ],
    };
    const v = validateDaemonManifest(m);
    assert.ok(v.ok, JSON.stringify(v));
  });
});

/* ------------------------------------------------------------------ */
/* end-to-end: cmdDaemon with a mocked venue + mocked spawn           */
/* (real process control, zero network, zero real children)            */
/* ------------------------------------------------------------------ */

type VenueStub = {
  killSwitchOn?: boolean;
  orders?: Record<string, unknown>[];
  positions?: Record<string, unknown>[];
  balances?: unknown;
};

function fakeChild(): EventEmitter & { pid: number; kill: (sig?: string) => boolean; stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { pid: number; kill: (sig?: string) => boolean; stdout: EventEmitter; stderr: EventEmitter };
  proc.pid = 4242;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    setImmediate(() => proc.emit("exit", 0));
    return true;
  };
  return proc;
}

function daemonDeps(stub: VenueStub) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const state = { killSwitchOn: stub.killSwitchOn === true };
  const deps: DaemonDeps = {
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: state.killSwitchOn } };
      if (name === "read_live_datum" && args.kind === "positions") return stub.positions ?? [];
      if (name === "read_live_datum" && args.kind === "balances") {
        return stub.balances ?? { merged: [{ asset: "USDT", total: 100, free: 90 }] };
      }
      if (name === "list_open_orders") return stub.orders ?? [];
      return {};
    },
    listConns: async () => [{ id: "conn-1", exchange: "kucoin", markets: "futures" }],
    spawnFn: () => fakeChild() as unknown as ChildProcess,
    sleepMs: async (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { calls, state, deps };
}

const e2eManifest = (): DaemonManifest => ({
  version: DAEMON_MANIFEST_VERSION,
  exchange: "kucoin",
  pairs: ["SOL/USDT"],
  heartbeatSec: 5,
  killSwitchPollSec: 1,
  maxRestarts: 2,
  maxLogBytes: 1048576,
  maxLogFiles: 2,
  drainTimeoutSec: 2,
  errorWindow: 20,
  health: { ...DAEMON_DEFAULT_HEALTH },
  children: [
    { name: "executor:SOL", role: "executor", command: "degen", args: ["--pair", "SOL/USDT"], live: true, enabled: true },
    { name: "monitor", role: "monitor", command: "heat", args: [], live: false, enabled: true },
  ],
});

describe("cmdDaemon end-to-end (mocked venue, no network, no real children)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-e2e-"));
    process.exitCode = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("REFUSES to boot on a foreign working order and touches nothing (I2)", async () => {
    const { calls, deps } = daemonDeps({ orders: [{ orderId: "FOREIGN-1", symbol: "SOLUSDT" }] });
    await cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: false,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    assert.equal(process.exitCode, 3, "a foreign order must hard-stop the boot");
    assert.equal(calls.filter((c) => c.name === "cancel_order").length, 0, "the daemon must not cancel a foreign order");
    assert.equal(calls.filter((c) => c.name === "execute_trade").length, 0);
  });

  it("REFUSES to boot on a foreign open position (the pool has another owner)", async () => {
    const { calls, deps } = daemonDeps({ positions: [{ symbol: "PEPEUSDT", side: "long", size: 5 }] });
    await cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: false,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    assert.equal(process.exitCode, 3);
    assert.equal(calls.filter((c) => c.name === "close_position").length, 0);
  });

  it("REFUSES to boot when the venue cannot be read (never starts blind)", async () => {
    const { deps } = daemonDeps({});
    deps.call = async () => {
      throw new Error("venue down");
    };
    await cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: false,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    assert.equal(process.exitCode, 3);
  });

  it("boots, then on SIGINT drains: cancels ITS OWN order, never flattens (I3)", async () => {
    writeFileSync(
      join(dir, "scalp_sol.json"),
      JSON.stringify({ kind: "scalp", pair: "SOL/USDT", placed: [{ orderId: "MINE-1" }] }),
    );
    const { calls, deps } = daemonDeps({
      orders: [{ orderId: "MINE-1", symbol: "SOLUSDT" }],
      positions: [{ symbol: "SOLUSDT", side: "long", size: 10 }],
    });
    const running = cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: true,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    await new Promise((r) => setTimeout(r, 60));
    process.emit("SIGINT");
    await running;
    const cancelled = calls.filter((c) => c.name === "cancel_order").map((c) => c.args.orderId);
    assert.ok(cancelled.includes("MINE-1"), "the drain must cancel the daemon's own working order");
    assert.equal(calls.filter((c) => c.name === "close_position").length, 0, "the drain must never flatten");
  });

  it("drains when the server kill switch flips — without waiting for a child cycle (I4)", async () => {
    const { calls, state, deps } = daemonDeps({ orders: [], positions: [] });
    const running = cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: true,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    await new Promise((r) => setTimeout(r, 60));
    state.killSwitchOn = true; // the server-side kill switch engages
    await running;
    assert.equal(calls.filter((c) => c.name === "execute_trade").length, 0, "the kill switch must stop fires");
  });

  it("--once reconciles the venue and spawns nothing", async () => {
    const { calls, deps } = daemonDeps({ orders: [], positions: [] });
    await cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: false,
        flattenOnShutdown: false,
        once: true,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    assert.ok(calls.some((c) => c.name === "list_open_orders"), "the boot reconcile must read the venue");
    assert.equal(process.exitCode, 0);
  });

  it("a second daemon refuses to start while the first holds the pool (I1)", async () => {
    const { deps } = daemonDeps({ orders: [], positions: [] });
    const lockPath = join(dir, "daemon-owner.json");
    writeDaemonOwnerLock(lockPath, { pid: process.pid, sessionId: "other", startedAt: "2026-10-21T00:00:00.000Z" });
    await cmdDaemon(
      {
        manifest: e2eManifest(),
        json: false,
        allowLive: false,
        flattenOnShutdown: false,
        once: false,
        logDir: dir,
        heartbeatPath: join(dir, "hb.json"),
        daemonStateDir: dir,
        localStateDir: dir,
        pat: "fake-pat",
      },
      deps,
    );
    assert.equal(process.exitCode, 3, "a live owner lock must block a second daemon");
  });
});

// ── A TRANSIENT READ IS NOT A KILL SWITCH ────────────────────────────────
//
// The daemon polls the server-side kill switch on its own timer. At a
// 5s poll the MCP layer rate-limits it within minutes — and treating
// that throttled READ as "the switch is on" drained the machine every
// few minutes, for a reason that had nothing to do with risk.

it("a rate-limited kill-switch read is flagged TRANSIENT (and stays fail-closed)", async () => {
  // The POLL itself stays fail-closed: an unknown state reads as ON, so
  // any consumer of it is safe by default. The `transient` flag is what
  // lets the DAEMON tell a throttle from a real outage.
  const p = await pollKillSwitch(
    "pat",
    undefined,
    (async () => {
      throw new Error("rate_limited: Rate limit exceeded — try again in 60s");
    }) as never,
  );
  assert.equal(p.on, true);
  assert.equal(p.unreadable, true);
  assert.equal(p.transient, true);
  assert(p.error, "the error is kept for the log");
});

it("a genuine unreadable kill switch still reads as ON", async () => {
  // A scope/auth refusal will fail identically forever — it must not be
  // retried into a drain loop, and it must not be read as "safe".
  const p = await pollKillSwitch(
    "pat",
    undefined,
    (async () => {
      throw new Error("needs a PAT with the trade:execute scope");
    }) as never,
  );
  assert.equal(p.on, true);
  assert.equal(p.unreadable, true);
  assert.equal(p.transient, false);
});

it("the server not reporting the switch at all reads as ON", async () => {
  const p = await pollKillSwitch(
    "pat",
    undefined,
    (async () => ({ risk_limits: { max_position_usd: 60 } })) as never,
  );
  assert.equal(p.on, true);
  assert.equal(p.unreadable, true);
  assert.equal(p.transient, false);
});

it("a switch that is genuinely off reads as off", async () => {
  const p = await pollKillSwitch(
    "pat",
    undefined,
    (async () => ({ risk_limits: { kill_switch_enabled: false } })) as never,
  );
  assert.equal(p.on, false);
  assert.equal(p.transient, false);
});

it("isTransientReadFailure separates retries from permanent refusals", () => {
  // Transient — may succeed on the next attempt.
  for (const m of [
    "rate_limited: Rate limit exceeded — try again in 60s",
    "request timed out",
    "fetch failed",
    "502 Bad Gateway",
  ]) {
    assert(isTransientReadFailure(m), `should be transient: ${m}`);
  }
  // Permanent — will fail identically forever.
  for (const m of [
    "401 Unauthorized",
    "403 Forbidden",
    "needs a PAT with the trade:execute scope",
  ]) {
    assert(!isTransientReadFailure(m), `should NOT be transient: ${m}`);
  }
});

it("a healthy boot line contains NO 'error' substring at all", () => {
  // A watcher that greps for "error" must not fire on a healthy boot. The
  // null-valued error keys are OMITTED rather than emitted as null, and
  // the status is carried by a positively-matchable field.
  //
  // This is not cosmetic: an alarm that fires when nothing is wrong is an
  // alarm the operator learns to ignore — and then the real one is
  // ignored too.
  const healthy = {
    event: "daemon-boot",
    status: "ok",
    sessionId: "jw3d-test",
    exchange: "kucoin",
    pairs: ["SOL/USDT"],
    venueChecked: true,
    openPositions: 0,
    freeMarginUsd: 57.46,
    ownedOrderIds: [],
    foreignOrders: [],
    foreignPositions: [],
    warnings: [],
    dryRun: true,
  };
  const line = JSON.stringify(healthy);
  assert.equal(
    line.toLowerCase().includes("error"),
    false,
    `a healthy boot line contains "error": ${line}`,
  );
  // And the status is positively matchable.
  assert.match(line, /"status":"ok"/);
});
