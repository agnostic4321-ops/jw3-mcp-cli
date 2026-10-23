/**
 * `jw3 ttm` tests — ladder math, floor gate, arg validation, dry-run
 * parity. No network: cmdTtm imports no venue client. No trades.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TTM_FLOOR_EQUITY_USD,
  TTM_LADDER_MULTS,
  averagedEntry,
  buildLadder,
  cmdTtm,
  floorHalt,
  legMargin,
  planTtm,
  sleeveAllocation,
  validateTtmArgs,
  type TtmArgs,
} from "./ttm.js";

const args = (over: Partial<TtmArgs> = {}): TtmArgs => ({
  pair: "SOL/USDT",
  side: "long",
  equityUsd: 10,
  baseNotionalUsd: 5,
  leverage: 25,
  entryPrice: 100,
  atrPct: 0.8,
  json: false,
  ...over,
});

let logSink: string[];
let errSink: string[];
const realLog = console.log;
const realErr = console.error;

beforeEach(() => {
  process.exitCode = 0;
  logSink = [];
  errSink = [];
  console.log = (...a: unknown[]) => {
    logSink.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errSink.push(a.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  console.error = realErr;
  process.exitCode = 0;
});

describe("validateTtmArgs", () => {
  it("accepts a usable plan", () => {
    assert.equal(validateTtmArgs(args()), null);
  });
  it("rejects leverage outside 25-50", () => {
    assert.match(validateTtmArgs(args({ leverage: 2 })) ?? "", /25-50/);
    assert.match(validateTtmArgs(args({ leverage: 24 })) ?? "", /25-50/);
    assert.match(validateTtmArgs(args({ leverage: 51 })) ?? "", /25-50/);
  });
  it("accepts the 25 and 50 boundaries", () => {
    assert.equal(validateTtmArgs(args({ leverage: 25 })) , null);
    assert.equal(validateTtmArgs(args({ leverage: 50 })), null);
  });
  it("rejects bad pair, side, sleeve", () => {
    assert.ok(validateTtmArgs(args({ pair: "SOL" })));
    assert.ok(validateTtmArgs(args({ side: "flat" as never })));
    assert.ok(validateTtmArgs(args({ sleeve: "carry" as never })));
  });
});

describe("floorHalt", () => {
  it("halts at and below $3", () => {
    assert.equal(floorHalt(3), true);
    assert.equal(floorHalt(2.99), true);
    assert.equal(floorHalt(10), false);
    assert.equal(floorHalt(3.01), false);
  });
});

describe("ladder", () => {
  it("uses 1x/2x/4x notionals", () => {
    const legs = buildLadder(args({ baseNotionalUsd: 5 }));
    assert.deepEqual(
      legs.map((l) => l.notionalUsd),
      [5, 10, 20],
    );
    assert.deepEqual([...TTM_LADDER_MULTS], [1, 2, 4]);
  });
  it("margins are notional/lev (isolated)", () => {
    assert.equal(legMargin(20, 25), 0.8);
    const legs = buildLadder(args({ baseNotionalUsd: 7, leverage: 50 }));
    const total = legs.reduce((s, l) => s + l.marginUsd, 0);
    assert.ok(Math.abs(total - 49 / 50) < 1e-9);
  });
  it("long steps down, short steps up by ATR", () => {
    const longs = buildLadder(args({ side: "long", entryPrice: 100, atrPct: 1 }));
    assert.deepEqual(
      longs.map((l) => l.price),
      [100, 99, 98],
    );
    const shorts = buildLadder(args({ side: "short", entryPrice: 100, atrPct: 1 }));
    assert.deepEqual(
      shorts.map((l) => l.price),
      [100, 101, 102],
    );
  });
  it("averaged entry is notional-weighted", () => {
    const legs = buildLadder(args({ side: "long", entryPrice: 100, atrPct: 1, baseNotionalUsd: 5 }));
    // (5*100 + 10*99 + 20*98) / 35
    assert.ok(Math.abs(averagedEntry(legs) - 98.571429) < 1e-4);
  });
  it("sleeve split is equal-weight", () => {
    assert.equal(sleeveAllocation(10), 2.5);
  });
  it("flags a ladder that exceeds its sleeve", () => {
    const fits = planTtm(args({ baseNotionalUsd: 1, leverage: 50 }));
    assert.equal(fits?.ladderFitsSleeve, true);
    const fat = planTtm(args({ baseNotionalUsd: 50, leverage: 25 }));
    assert.equal(fat?.ladderFitsSleeve, false);
  });
});

describe("cmdTtm dry-run", () => {
  it("prints a plan and touches no exit code", async () => {
    await cmdTtm(args());
    assert.equal(process.exitCode, 0);
    assert.match(logSink.join("\n"), /TTM plan \(DRY-RUN/);
    assert.match(logSink.join("\n"), /leg1 1x/);
    assert.equal(errSink.length, 0);
  });
  it("emits JSON with dryRun flag", async () => {
    await cmdTtm(args({ json: true }));
    const parsed = JSON.parse(logSink.join("\n")) as { halt: boolean; dryRun: boolean };
    assert.equal(parsed.halt, false);
    assert.equal(parsed.dryRun, true);
  });
  it("halts at the floor without planning", async () => {
    await cmdTtm(args({ equityUsd: TTM_FLOOR_EQUITY_USD }));
    assert.equal(process.exitCode, 0);
    assert.match(logSink.join("\n"), /FLOOR HALT/);
  });
  it("refuses --live and --yes (no live path)", async () => {
    await cmdTtm(args(), { live: true });
    assert.equal(process.exitCode, 2);
    process.exitCode = 0;
    await cmdTtm(args(), { yes: true });
    assert.equal(process.exitCode, 2);
    assert.match(errSink.join("\n"), /dry-run only/);
  });
  it("rejects bad args with exit 2", async () => {
    await cmdTtm(args({ leverage: 2 }));
    assert.equal(process.exitCode, 2);
  });
});
