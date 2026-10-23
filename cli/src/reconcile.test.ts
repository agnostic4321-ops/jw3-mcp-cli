import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStrays,
  isOpenPosition,
  readLocalStates,
  rowMatchesPair,
  rowPairOf,
  startupGate,
  statePathsFor,
  TRAIL_SUPERVISOR_GRACE_MS,
  type LocalState,
} from "./reconcile.js";

describe("rowPairOf / rowMatchesPair", () => {
  it("reads pair/symbol/instrument fields, canonicalizes", () => {
    assert.equal(rowPairOf({ pair: "BTC/USDT" }), "BTC/USDT");
    assert.equal(rowPairOf({ symbol: "BTCUSDT" }), "BTCUSDT");
    assert.equal(rowPairOf({ instrument: "XBTUSDTM" }), "XBTUSDTM");
    assert.equal(rowPairOf({}), "");
  });
  it("matches across separator variants, keeps server-scoped rows", () => {
    assert.equal(rowMatchesPair({ symbol: "BTCUSDT" }, "BTC/USDT"), true);
    assert.equal(rowMatchesPair({ symbol: "ETH/USDT" }, "BTC/USDT"), false);
    assert.equal(rowMatchesPair({}, "BTC/USDT"), true);
  });
  it("folds the futures M suffix and the XBT/BTC alias", () => {
    assert.equal(rowMatchesPair({ symbol: "XBTUSDTM" }, "BTC/USDT"), true);
    assert.equal(rowMatchesPair({ symbol: "BTCUSDTM" }, "BTC/USDT"), true);
    assert.equal(rowMatchesPair({ symbol: "ETHUSDTM" }, "BTC/USDT"), false);
  });
});

describe("isOpenPosition", () => {
  it("treats nonzero sizes as open, zero as flat", () => {
    assert.equal(isOpenPosition({ size: 2 }), true);
    assert.equal(isOpenPosition({ currentQty: "0" }), false);
    assert.equal(isOpenPosition({ positionAmt: 0 }), false);
  });
  it("treats a sizeless listed row as open (never hides a stray)", () => {
    assert.equal(isOpenPosition({ symbol: "BTCUSDTM" }), true);
  });
});

const local = (kind: "scalp" | "grid" | "trail", orderIds: string[] = []): LocalState => ({
  kind,
  path: `/tmp/${kind}_x.json`,
  pair: "BTC/USDT",
  orderIds,
  updatedAtMs: 0,
  summary: kind,
});

describe("classifyStrays", () => {
  it("is clean when state owns the venue rows", () => {
    const s = classifyStrays({
      pair: "BTC/USDT",
      local: [local("scalp", ["o1"])],
      unreadable: [],
      positions: [{ symbol: "BTCUSDTM", size: 1 }],
      orders: [{ orderId: "o1", symbol: "BTC/USDT" }],
    });
    assert.deepEqual(s, []);
  });
  it("flags unmanaged positions and stray orders as errors", () => {
    const s = classifyStrays({
      pair: "BTC/USDT",
      local: [],
      unreadable: [],
      positions: [{ symbol: "BTCUSDTM", size: 1 }],
      orders: [{ orderId: "z9", symbol: "BTC/USDT" }],
    });
    assert.ok(s.some((x) => x.code === "unmanaged-position" && x.level === "error"));
    assert.ok(s.some((x) => x.code === "stray-orders" && x.level === "error"));
  });
  it("flags state-without-venue as stale (warn, not error)", () => {
    const s = classifyStrays({
      pair: "BTC/USDT",
      local: [local("trail")],
      unreadable: [],
      positions: [],
      orders: [],
    });
    assert.equal(s.length, 1);
    assert.equal(s[0]?.code, "stale-state");
    assert.equal(s[0]?.level, "warn");
  });
  it("flags unreadable states as errors and null venue as unchecked", () => {
    const s = classifyStrays({ pair: "BTC/USDT", local: [], unreadable: ["/tmp/x.json"], positions: null, orders: null });
    assert.ok(s.some((x) => x.code === "unreadable-state"));
    assert.ok(s.some((x) => x.code === "venue-unchecked"));
  });
  it("ignores other pairs", () => {
    const s = classifyStrays({
      pair: "BTC/USDT",
      local: [],
      unreadable: [],
      positions: [{ symbol: "ETHUSDTM", size: 5 }],
      orders: [{ orderId: "e1", symbol: "ETH/USDT" }],
    });
    assert.deepEqual(s, []);
  });
});

describe("readLocalStates + startupGate", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jw3-reconcile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it("reads written states and reports paths", () => {
    writeFileSync(join(dir, "scalp_btc.json"), JSON.stringify({ kind: "scalp", pair: "BTC/USDT", direction: "long", placed: [{ orderId: "o1" }], tpArmed: true }));
    const { states, unreadable } = readLocalStates("BTC", dir);
    assert.equal(unreadable.length, 0);
    assert.equal(states.length, 1);
    assert.deepEqual(states[0]?.orderIds, ["o1"]);
    assert.deepEqual(statePathsFor("BTC", dir).scalp, join(dir, "scalp_btc.json"));
  });
  it("lists corrupt files as unreadable", () => {
    writeFileSync(join(dir, "trail_btc.json"), "{nope");
    const { states, unreadable } = readLocalStates("BTC", dir);
    assert.equal(states.length, 0);
    assert.equal(unreadable.length, 1);
  });
  it("startupGate: scalp/grid refuse with state present, pass when absent", () => {
    assert.equal(startupGate("scalp", "BTC", dir).ok, true);
    writeFileSync(join(dir, "scalp_btc.json"), JSON.stringify({ kind: "scalp", pair: "BTC/USDT", direction: "long" }));
    const blocked = startupGate("scalp", "BTC", dir);
    assert.equal(blocked.ok, false);
    assert.match((blocked as { ok: false; reason: string }).reason, /kill/);
    writeFileSync(join(dir, "grid_btc.json"), JSON.stringify({ kind: "grid", pair: "BTC/USDT" }));
    assert.equal(startupGate("grid", "BTC", dir).ok, false);
  });
  it("startupGate: trail refuses fresh unfinished, supersedes closed/stale", () => {
    const p = join(dir, "trail_btc.json");
    writeFileSync(p, JSON.stringify({ kind: "trail", pair: "BTC/USDT", closed: false }));
    const fresh = startupGate("trail", "BTC", dir, Date.now());
    assert.equal(fresh.ok, false);
    assert.match((fresh as { ok: false; reason: string }).reason, /supervisor/);
    writeFileSync(p, JSON.stringify({ kind: "trail", pair: "BTC/USDT", closed: true }));
    const closed = startupGate("trail", "BTC", dir, Date.now());
    assert.equal(closed.ok, true);
    assert.match((closed as { ok: true; notice?: string }).notice ?? "", /superseding/);
    writeFileSync(p, JSON.stringify({ kind: "trail", pair: "BTC/USDT", closed: false }));
    const stale = startupGate("trail", "BTC", dir, Date.now() + TRAIL_SUPERVISOR_GRACE_MS + 1000);
    assert.equal(stale.ok, true);
  });
});
