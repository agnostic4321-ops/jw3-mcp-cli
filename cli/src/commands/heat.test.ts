import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountFromBalances,
  blackoutWindowVetoes,
  checkHeat,
  cmdHeat,
  defaultHeat,
  degenHeatPath,
  effectiveSize,
  evaluateHeat,
  inUtcWindow,
  isKnownPosition,
  loadHeat,
  positionMargin,
  positionNotional,
  saveHeat,
  type DegenHeat,
  type HeatAccount,
} from "./heat.js";
import type { LocalState } from "../reconcile.js";
import { makeSandbox, readJson, writeJson } from "../test-fixtures.js";

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

/* ------------------------------------------------------------------ */
/* heat-cap governor — the ONE implementation (moved from degen.ts)    */
/* ------------------------------------------------------------------ */

describe("checkHeat", () => {
  const heat = (over: Partial<DegenHeat> = {}): DegenHeat => ({ ...defaultHeat("2026-10-14"), ...over });
  it("clears fresh books", () => {
    assert.equal(checkHeat(heat(), 1.5, "SOL/USDT", Date.parse("2026-10-14T10:00:00Z")), null);
  });
  it("flat after two stops, duplicates, caps, and cooldowns", () => {
    assert.match(String(checkHeat(heat({ stopsToday: 2 }), 1, "SOL/USDT", Date.now())), /flat for the day/);
    assert.match(String(checkHeat(heat({ open: [{ pair: "SOL/USDT", riskUsd: 1 }] }), 1, "sol/usdt", Date.now())), /already open/);
    assert.match(String(checkHeat(heat({ open: [{ pair: "A/USDT", riskUsd: 1 }, { pair: "B/USDT", riskUsd: 1 }] }), 1, "C/USDT", Date.now())), /concurrent/);
    assert.match(String(checkHeat(heat({ lastStopAt: new Date(Date.now() - 10 * 60000).toISOString() }), 1, "C/USDT", Date.now())), /cooldown/);
    assert.match(String(checkHeat(heat({ heatUsd: 5.5 }), 1, "C/USDT", Date.now())), /heat cap/);
    assert.match(String(checkHeat(heat(), NaN, "C/USDT", Date.now())), /unmeasurable/);
  });
  it("halves size after one stop", () => {
    assert.equal(effectiveSize(15, 0), 15);
    assert.equal(effectiveSize(15, 1), 7.5);
  });
});

describe("heat-cap store (degen-heat.json on json-store)", () => {
  it("loads a file written in the OLD format unchanged", () => {
    const sb = makeSandbox("jw3-heat-");
    try {
      // Byte shape of the old degen.ts saveHeat: JSON.stringify(store, null, 2)
      // plus an unknown future field the sanitizer must ignore.
      const old = {
        day: "2026-10-14",
        stopsToday: 1,
        heatUsd: 1.25,
        open: [{ pair: "SOL/USDT", riskUsd: 1.25 }, { pair: 42, riskUsd: "x" }],
        lastStopAt: "2026-10-14T09:00:00.000Z",
        futureField: true,
      };
      const path = writeJson(sb.dir, "degen-heat.json", old);
      const loaded = loadHeat(path, Date.parse("2026-10-14T10:00:00Z"));
      assert.equal(loaded.day, "2026-10-14");
      assert.equal(loaded.stopsToday, 1);
      assert.equal(loaded.heatUsd, 1.25);
      assert.deepEqual(loaded.open, [{ pair: "SOL/USDT", riskUsd: 1.25 }]);
      assert.equal(loaded.lastStopAt, "2026-10-14T09:00:00.000Z");
      assert.equal("futureField" in loaded, false);
    } finally {
      sb.cleanup();
    }
  });
  it("rolls the day (counters reset, open kept) and falls back on corrupt files", () => {
    const sb = makeSandbox("jw3-heat-");
    try {
      const path = writeJson(sb.dir, "degen-heat.json", {
        day: "2026-10-13",
        stopsToday: 2,
        heatUsd: 5,
        open: [{ pair: "SOL/USDT", riskUsd: 1 }],
        lastStopAt: null,
      });
      const rolled = loadHeat(path, Date.parse("2026-10-14T10:00:00Z"));
      assert.equal(rolled.day, "2026-10-14");
      assert.equal(rolled.stopsToday, 0);
      assert.equal(rolled.heatUsd, 0);
      assert.deepEqual(rolled.open, [{ pair: "SOL/USDT", riskUsd: 1 }]);
      const corruptPath = join(sb.dir, "corrupt.json");
      writeFileSync(corruptPath, "{ not json");
      assert.deepEqual(loadHeat(corruptPath, Date.parse("2026-10-14T10:00:00Z")), defaultHeat("2026-10-14"));
      const dflt = loadHeat(`${sb.dir}/missing.json`, Date.parse("2026-10-14T10:00:00Z"));
      assert.deepEqual(dflt, defaultHeat("2026-10-14"));
    } finally {
      sb.cleanup();
    }
  });
  it("round-trips through saveHeat on the default path", () => {
    const sb = makeSandbox("jw3-heat-");
    try {
      const path = degenHeatPath(sb.dir);
      assert.match(path, /degen-heat\.json$/);
      const heat = { ...defaultHeat("2026-10-14"), stopsToday: 1, heatUsd: 2 };
      saveHeat(path, heat);
      assert.deepEqual(readJson<typeof heat>(path), heat);
      assert.deepEqual(loadHeat(path, Date.parse("2026-10-14T10:00:00Z")), heat);
    } finally {
      sb.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* blackout windows — the ONE matcher (moved from committee.ts)        */
/* ------------------------------------------------------------------ */

describe("blackout windows", () => {
  it("inUtcWindow handles a normal and a midnight-wrapping window", () => {
    assert.equal(inUtcWindow(12 * 60, 11 * 60 + 30, 13 * 60 + 30), true);
    assert.equal(inUtcWindow(14 * 60, 11 * 60 + 30, 13 * 60 + 30), false);
    assert.equal(inUtcWindow(23 * 60, 22 * 60, 60), true); // wraps past midnight
    assert.equal(inUtcWindow(30, 22 * 60, 60), true);
    assert.equal(inUtcWindow(120, 22 * 60, 60), false);
  });
  it("emits one veto per hit window with the committee's rule strings", () => {
    const vetoes = blackoutWindowVetoes(
      [
        { name: "FOMC", startMin: 9 * 60, endMin: 11 * 60 },
        { name: "CPI", startMin: 11 * 60 + 30, endMin: 13 * 60 + 30 },
      ],
      10 * 60,
    );
    assert.deepEqual(vetoes, [
      { rule: "blackout:FOMC", detail: "FOMC blackout 0540-0660Z — no directional entries" },
    ]);
    assert.deepEqual(blackoutWindowVetoes([], 10 * 60), []);
    assert.deepEqual(blackoutWindowVetoes(undefined, 10 * 60), []);
  });
});
