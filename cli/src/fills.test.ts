import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  summarizePnl,
  validateDays,
  validateLimit,
  validateMarket,
} from "./commands/fills.js";

describe("validateMarket", () => {
  it("accepts spot, futures, all (case-insensitive) and the default", () => {
    assert.equal(validateMarket(undefined), null);
    assert.equal(validateMarket("spot"), null);
    assert.equal(validateMarket("futures"), null);
    assert.equal(validateMarket("ALL"), null);
  });
  it("rejects anything else", () => {
    assert.match(validateMarket("options") as string, /spot\|futures\|all/);
    assert.match(validateMarket("") as string, /spot\|futures\|all/);
  });
});

describe("validateDays", () => {
  it("accepts 1..90 and the default", () => {
    assert.equal(validateDays(undefined), null);
    assert.equal(validateDays(1), null);
    assert.equal(validateDays(90), null);
  });
  it("rejects out-of-range and non-numbers", () => {
    assert.match(validateDays(0) as string, /days/);
    assert.match(validateDays(91) as string, /days/);
    assert.match(validateDays(NaN) as string, /days/);
  });
});

describe("validateLimit", () => {
  it("accepts 1..500 and the default", () => {
    assert.equal(validateLimit(undefined), null);
    assert.equal(validateLimit(1), null);
    assert.equal(validateLimit(500), null);
  });
  it("rejects out-of-range and non-numbers", () => {
    assert.match(validateLimit(0) as string, /limit/);
    assert.match(validateLimit(501) as string, /limit/);
    assert.match(validateLimit(NaN) as string, /limit/);
  });
});

describe("summarizePnl", () => {
  it("totals pnl/fees and counts wins vs losses", () => {
    const s = summarizePnl([
      { id: "a", symbol: "BTC/USDT", side: "long", qty: 1, entryPrice: 60000, exitPrice: 61000, pnl: 100, fees: 2, closedAt: 1 },
      { id: "b", symbol: "ETH/USDT", side: "short", qty: 2, entryPrice: 3000, exitPrice: 3100, pnl: -50, fees: 1, closedAt: 2 },
      { id: "c", symbol: "SOL/USDT", side: null, qty: null, entryPrice: 0, exitPrice: 150, pnl: 0, fees: 0.5, closedAt: 3 },
    ]);
    assert.equal(s.totalPnl, 50);
    assert.equal(s.totalFees, 3.5);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
  });
  it("is empty-safe and ignores non-finite money", () => {
    assert.deepEqual(summarizePnl([]), { totalPnl: 0, totalFees: 0, wins: 0, losses: 0 });
    const s = summarizePnl([
      { id: "x", symbol: "BTC/USDT", side: null, qty: null, entryPrice: 0, exitPrice: 0, pnl: NaN, fees: NaN, closedAt: 0 },
    ]);
    assert.deepEqual(s, { totalPnl: 0, totalFees: 0, wins: 0, losses: 0 });
  });
});
