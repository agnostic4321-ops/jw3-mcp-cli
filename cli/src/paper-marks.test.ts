/**
 * paper-marks tests — fee math, pnl math, virtual TP/SL settlement.
 * Pure functions only: no IO, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCALP_MAKER_FEE_PCT,
  SCALP_TAKER_FEE_PCT,
  feeRateFor,
  feeTierForFlag,
  grossPnlUsd,
  legsForMark,
  paperFeeUsd,
  summarizePaperAccount,
  unrealizedPnlUsd,
} from "./paper-marks.js";
import type { PaperPosition } from "./paper-store.js";

const pos = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: "paper-pos-1",
  pair: "SOL/USDT",
  side: "long",
  qty: 2,
  entryPrice: 100,
  leverage: 2,
  marginLockedUsd: 100,
  tp: 110,
  sl: 95,
  strategy: null,
  feeTier: "taker",
  openedAt: new Date().toISOString(),
  ...over,
});

describe("fees", () => {
  it("reuses the backtest schedule (maker 0.02 / taker 0.06 per side)", () => {
    assert.equal(SCALP_MAKER_FEE_PCT, 0.02);
    assert.equal(SCALP_TAKER_FEE_PCT, 0.06);
    assert.equal(feeRateFor("maker"), 0.0002);
    assert.equal(feeRateFor("taker"), 0.0006);
    assert.equal(feeRateFor("VIP"), null);
  });

  it("flag parsing defaults to taker, rejects garbage", () => {
    assert.equal(feeTierForFlag(undefined), "taker");
    assert.equal(feeTierForFlag("maker"), "maker");
    assert.equal(feeTierForFlag("MAKER"), "maker");
    assert.equal(feeTierForFlag("free"), null);
  });

  it("flat % per side, rounded to cents", () => {
    assert.equal(paperFeeUsd(10000, "taker"), 6);
    assert.equal(paperFeeUsd(10000, "maker"), 2);
    assert.equal(paperFeeUsd(0, "taker"), 0);
  });
});

describe("pnl math", () => {
  it("gross pnl mirrors by side", () => {
    assert.equal(grossPnlUsd("long", 100, 110, 2), 20);
    assert.equal(grossPnlUsd("long", 100, 90, 2), -20);
    assert.equal(grossPnlUsd("short", 100, 90, 2), 20);
    assert.equal(grossPnlUsd("short", 100, 110, 2), -20);
  });

  it("unrealized values at the mark", () => {
    assert.equal(unrealizedPnlUsd(pos(), 105), 10);
    assert.equal(unrealizedPnlUsd(pos({ side: "short" }), 105), -10);
  });
});

describe("legsForMark", () => {
  it("long TP fills at/above tp, SL at/below sl", () => {
    assert.deepEqual(legsForMark([pos()], 110), [{ positionId: "paper-pos-1", kind: "tp", fillPrice: 110 }]);
    assert.deepEqual(legsForMark([pos()], 95), [{ positionId: "paper-pos-1", kind: "sl", fillPrice: 95 }]);
    assert.deepEqual(legsForMark([pos()], 100), []);
  });

  it("short legs mirror", () => {
    const s = pos({ side: "short", tp: 90, sl: 105 });
    assert.deepEqual(legsForMark([s], 90), [{ positionId: "paper-pos-1", kind: "tp", fillPrice: 90 }]);
    assert.deepEqual(legsForMark([s], 105), [{ positionId: "paper-pos-1", kind: "sl", fillPrice: 105 }]);
    assert.deepEqual(legsForMark([s], 100), []);
  });

  it("a tick through both legs settles at SL (conservative)", () => {
    // Only reachable via hand-edited/inverted legs — the store refuses to
    // open these — but the engine must still pick the safe leg.
    const inverted = pos({ tp: 90, sl: 110 });
    assert.deepEqual(legsForMark([inverted], 85), [{ positionId: "paper-pos-1", kind: "sl", fillPrice: 110 }]);
  });

  it("positions without legs never settle; bad marks settle nothing", () => {
    assert.deepEqual(legsForMark([pos({ tp: null, sl: null })], 1000), []);
    assert.deepEqual(legsForMark([pos()], NaN), []);
    assert.deepEqual(legsForMark([pos()], -5), []);
  });

  it("settles each position at most once per tick", () => {
    const a = pos({ id: "a", tp: 110, sl: null });
    const b = pos({ id: "b", tp: null, sl: 95 });
    const legs = legsForMark([a, b], 112);
    assert.equal(legs.length, 1);
    assert.equal(legs[0]?.positionId, "a");
  });
});

describe("summarizePaperAccount", () => {
  it("equity = cash + locked + unrealized at marks", () => {
    const s = summarizePaperAccount("desk", 9000, 50, 1.5, [pos()], { "SOL/USDT": 105 });
    assert.equal(s.lockedMarginUsd, 100);
    assert.equal(s.unrealizedPnlUsd, 10);
    assert.equal(s.equityUsd, 9000 + 100 + 10);
    assert.equal(s.openPositions, 1);
  });

  it("unmarked pairs value at entry (unrealized 0, never guessed)", () => {
    const s = summarizePaperAccount("desk", 9000, 0, 0, [pos()]);
    assert.equal(s.unrealizedPnlUsd, 0);
    assert.equal(s.equityUsd, 9100);
  });
});
