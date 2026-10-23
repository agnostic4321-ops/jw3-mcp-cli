import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  accountFromBalances,
  cmdHeat,
  evaluateHeat,
  isKnownPosition,
  positionMargin,
  positionNotional,
  type HeatAccount,
} from "./heat.js";
import type { LocalState } from "../reconcile.js";

describe("positionNotional", () => {
  it("prefers explicit venue notionals", () => {
    assert.equal(positionNotional({ size: 1, markPrice: 100, markValue: 250 }), 250);
    assert.equal(positionNotional({ size: 1, markPrice: 100, notional: 300 }), 300);
  });
  it("falls back to |size| x mark, then entry", () => {
    assert.equal(positionNotional({ symbol: "BTC/USDT", side: "short", size: -0.007, markPrice: 90000 }), 630);
    assert.equal(positionNotional({ size: "2", entryPrice: 50 }), 100);
    assert.equal(positionNotional({ currentQty: 3, mark: 10 }), 30);
  });
  it("returns null when unmeasurable, never 0-filled", () => {
    assert.equal(positionNotional({ symbol: "BTC/USDT" }), null);
    assert.equal(positionNotional({ size: 2 }), null);
  });
});

describe("positionMargin", () => {
  it("prefers explicit venue margin", () => {
    assert.deepEqual(positionMargin({ margin: 60, leverage: 10 }, 600), { locked: 60, estimated: false });
  });
  it("estimates notional / leverage when the venue is silent", () => {
    assert.deepEqual(positionMargin({ leverage: 10 }, 600), { locked: 60, estimated: true });
  });
  it("reports unknown for cross rows with no leverage, never fabricated", () => {
    assert.deepEqual(positionMargin({ leverage: 0 }, 600), { locked: null, estimated: false });
    assert.deepEqual(positionMargin({}, 600), { locked: null, estimated: false });
    assert.deepEqual(positionMargin({ leverage: 10 }, null), { locked: null, estimated: false });
  });
});

describe("accountFromBalances", () => {
  it("sums quote funds from merged rows, locked = total - free", () => {
    const a = accountFromBalances({ merged: [{ asset: "USDT", free: 20, total: 100 }, { asset: "BTC", free: 1, total: 1 }] });
    assert.equal(a.unknown, false);
    assert.equal(a.totalUsd, 100);
    assert.equal(a.freeUsd, 20);
    assert.equal(a.lockedUsd, 80);
  });
  it("reads balances arrays and coin-keyed rows", () => {
    const a = accountFromBalances({ balances: [{ coin: "USDC", available: 5, total: 15 }] });
    assert.deepEqual([a.totalUsd, a.freeUsd, a.lockedUsd], [15, 5, 10]);
  });
  it("is unknown when no quote row exists, never zero-filled", () => {
    const a = accountFromBalances({ merged: [{ asset: "BTC", free: 1, total: 1 }] });
    assert.equal(a.unknown, true);
    assert.equal(a.totalUsd, null);
  });
});

const local = (pair: string): LocalState => ({
  kind: "trail",
  path: "/tmp/trail_x.json",
  pair,
  orderIds: [],
  updatedAtMs: 0,
  summary: "trail",
});

describe("isKnownPosition", () => {
  it("matches owners across pair spellings", () => {
    assert.equal(isKnownPosition({ symbol: "XBTUSDTM", side: "short" }, [local("BTC/USDT")]), true);
    assert.equal(isKnownPosition({ symbol: "ETH/USDT" }, [local("BTC/USDT")]), false);
  });
  it("flags ownerless rows, keeps server-scoped rows with any state", () => {
    assert.equal(isKnownPosition({ symbol: "ETH/USDT" }, []), false);
    assert.equal(isKnownPosition({}, [local("BTC/USDT")]), true);
    assert.equal(isKnownPosition({}, []), false);
  });
});

const acct = (over: Partial<HeatAccount> = {}): HeatAccount => ({
  totalUsd: 1000,
  freeUsd: 400,
  lockedUsd: 600,
  quote: "USDT",
  unknown: false,
  ...over,
});

describe("evaluateHeat", () => {
  it("is clean when every position is owned and free covers the floor", () => {
    const r = evaluateHeat({
      exchange: "kucoin",
      positions: [{ symbol: "BTC/USDT", side: "short", size: 0.007, markPrice: 90000, margin: 63 }],
      local: [local("BTC/USDT")],
      unreadable: [],
      account: acct(),
      minFree: 50,
    });
    assert.equal(r.clean, true);
    assert.equal(r.flags.length, 0);
    assert.equal(r.positions[0]?.notionalUsd, 630);
    assert.equal(r.positions[0]?.notionalAcctPct, 63);
    assert.equal(r.positions[0]?.known, true);
  });
  it("flags unknown-origin positions as errors (the 0.007 BTC-short case)", () => {
    const r = evaluateHeat({
      exchange: "kucoin",
      positions: [{ symbol: "BTC/USDT", side: "short", size: -0.007, markPrice: 90000, leverage: 5 }],
      local: [],
      unreadable: [],
      account: acct({ totalUsd: 100, freeUsd: 5, lockedUsd: 95 }),
      minFree: 0,
    });
    assert.equal(r.clean, false);
    assert.ok(r.flags.some((f) => f.level === "error" && f.code === "unknown-origin"));
    assert.equal(r.positions[0]?.known, false);
  });
  it("flags free < min-free as an error", () => {
    const r = evaluateHeat({
      exchange: "kucoin",
      positions: [],
      local: [],
      unreadable: [],
      account: acct({ freeUsd: 10 }),
      minFree: 50,
    });
    assert.equal(r.clean, false);
    assert.ok(r.flags.some((f) => f.code === "low-free-margin"));
  });
  it("fails closed on unreadable states and unchecked balances", () => {
    const r = evaluateHeat({
      exchange: "kucoin",
      positions: [],
      local: [],
      unreadable: ["/tmp/scalp_btc.json"],
      account: acct({ unknown: true, totalUsd: null, freeUsd: null, lockedUsd: null }),
      minFree: 0,
    });
    assert.equal(r.clean, false);
    assert.ok(r.flags.some((f) => f.code === "unreadable-state"));
    assert.ok(r.flags.some((f) => f.code === "balances-unchecked"));
  });
  it("warns (but passes) on estimated margins", () => {
    const r = evaluateHeat({
      exchange: "kucoin",
      positions: [{ symbol: "SOL/USDT", side: "long", size: 1, markPrice: 100, leverage: 2 }],
      local: [local("SOL/USDT")],
      unreadable: [],
      account: acct(),
      minFree: 0,
    });
    assert.equal(r.clean, true);
    assert.ok(r.flags.some((f) => f.level === "warn" && f.code === "estimated-margin"));
  });
});

describe("cmdHeat", () => {
  let logged: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
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

  const conns = [{ id: "c1", exchange: "kucoin" }];
  const call = async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "read_live_datum");
    if (args.kind === "positions") {
      return { positions: [{ symbol: "BTC/USDT", side: "short", size: -0.007, markPrice: 90000, leverage: 5 }] };
    }
    return { merged: [{ asset: "USDT", free: 5, total: 100 }] };
  };

  it("exits 1 on an unknown-origin position with no local state", async () => {
    await cmdHeat(
      { exchange: "kucoin", minFree: 0, json: true, pat: "p" },
      { call: call as never, listConns: (async () => conns) as never, stateDir: "/nonexistent-heat-dir" },
    );
    assert.equal(process.exitCode, 1);
    const report = JSON.parse(logged.join("\n"));
    assert.equal(report.clean, false);
    assert.ok((report.flags as { code: string }[]).some((f) => f.code === "unknown-origin"));
    assert.equal(report.account.freeUsd, 5);
    assert.equal(report.positions[0].notionalUsd, 630);
  });

  it("rejects a negative --min-free with exit 2 and no venue read", async () => {
    let called = false;
    await cmdHeat(
      { exchange: "kucoin", minFree: NaN, json: true, pat: "p" },
      { call: (async () => { called = true; return {}; }) as never, listConns: (async () => conns) as never },
    );
    assert.equal(process.exitCode, 2);
    assert.equal(called, false);
  });
});
