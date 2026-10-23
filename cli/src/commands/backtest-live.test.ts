import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planScalp, type ScalpPlan } from "../kucoin.js";
import { averagedEntry, averagedTpPrice } from "./degen.js";
import {
  entryFeePctFor,
  entryTouchFor,
  exitFeePctFor,
  liveByFillType,
  liveCandlesFromRows,
  liveExhaustionSignal,
  liveGate,
  liveKillLossUsd,
  livePositionBasis,
  liveRowAt,
  liveStatsFromTrades,
  liveTradeMoney,
  runLiveBacktest,
  sessionContextAt,
  simulateLiveEntry,
  simulateLivePosition,
  tradedThrough,
  validateBacktestLiveArgs,
  type LiveCandle,
  type LiveTradeRow,
} from "./backtest-live.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const T0 = Date.UTC(2026, 9, 15, 0, 0, 0);
const BAR_MS = 15 * 60 * 1000;

/** One candle from OHLC numbers (ts auto-increments). */
function bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 100,
): LiveCandle {
  return { tsMs: T0 + i * BAR_MS, open: o, high: h, low: l, close: c, volume: v };
}

/** A flat tape of `n` candles at `px` — the boring baseline. */
function flat(n: number, px = 100): LiveCandle[] {
  return Array.from({ length: n }, (_, i) => bar(i, px, px, px, px));
}

/**
 * The plan under test: planScalp(100, ATR 1%, long, $60, 2 steps).
 *   step 1 = 100.00 (the touch)  step 2 = 99.10 (ATR*0.9 away)
 *   TP = 100.40 (on a 1-step entry)   kill = 98.20
 */
const PLAN_LONG = planScalp(100, 1.0, "long", 60, 2) as ScalpPlan;
/** The short mirror: step 1 = 100.00, step 2 = 100.90, kill = 101.80. */
const PLAN_SHORT = planScalp(100, 1.0, "short", 60, 2) as ScalpPlan;

/** The touch a long rests at (step 1) — the price the entry must trade through. */
const TOUCH = entryTouchFor(PLAN_LONG);

/** A trade row with sensible defaults, for the aggregate tests. */
function trade(over: Partial<LiveTradeRow> = {}): LiveTradeRow {
  return {
    index: 0,
    mode: "maker",
    direction: "long",
    signalIndex: 0,
    signalTime: "2026-10-15T00:00:00.000Z",
    entryIndex: 1,
    entryTime: "2026-10-15T00:15:00.000Z",
    entryPrice: 100,
    fillType: "maker-fill",
    repices: 0,
    entrySlippagePct: 0,
    stepsFilled: 1,
    avgEntry: 100,
    tpPrice: 100.3,
    killPrice: 98.5,
    killLossUsd: null,
    exitIndex: 2,
    exitTime: "2026-10-15T00:30:00.000Z",
    exitPrice: 100.3,
    exitReason: "tp",
    ambiguousTie: false,
    notionalUsd: 120,
    grossUsd: 0.36,
    feesUsd: 0.048,
    netUsd: 0.312,
    netPct: 0.26,
    win: true,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

describe("tradedThrough", () => {
  it("a long fills only when the bar trades DOWN through the price", () => {
    // Low 99.90 <= 100 → the price came down through the resting limit.
    assert.equal(tradedThrough("long", bar(0, 100, 101, 99.9, 100), 100), true);
    // Low 100.001 > 100 → the price never came down to the limit.
    assert.equal(tradedThrough("long", bar(0, 100.5, 101, 100.001, 100.5), 100), false);
  });
  it("a short fills only when the bar trades UP through the price", () => {
    // High 100.10 >= 100 → the price came up through the resting limit.
    assert.equal(tradedThrough("short", bar(0, 100, 100.1, 98, 100), 100), true);
    // High 99.999 < 100 → the price never came up to the limit.
    assert.equal(tradedThrough("short", bar(0, 99.5, 99.999, 98, 99.5), 100), false);
  });
  it("a bar that never came to the price does not fill it", () => {
    // A long limit BELOW the bar's low (99.50 < 99.80) was never reached.
    assert.equal(tradedThrough("long", bar(0, 100, 100.5, 99.8, 100), 99.5), false);
    // A short limit ABOVE the bar's high (101.00 > 100.50) was never reached.
    assert.equal(tradedThrough("short", bar(0, 100, 100.5, 99.8, 100), 101), false);
  });
});

describe("simulateLiveEntry — maker", () => {
  it("fills ONLY when the price trades through the resting touch", () => {
    // The touch is 100.00. Bars whose LOW stays ABOVE 100 never trade
    // through it, so the limit rests and never fills.
    const resting = [bar(0, 100.2, 100.3, 100.1, 100.2), bar(1, 100.3, 100.4, 100.15, 100.25)];
    const e1 = simulateLiveEntry(resting, 0, PLAN_LONG, "maker", { entryBars: 2 });
    assert.equal(e1.filled, false);
    assert.equal(e1.reason, "expired");
    assert.equal(e1.fillType, "maker-fill");
    // The same tape with a bar whose LOW dips under the touch fills.
    const through = [bar(0, 100.2, 100.3, 100.1, 100.2), bar(1, 100.2, 100.25, TOUCH - 0.01, 100.15)];
    const e2 = simulateLiveEntry(through, 0, PLAN_LONG, "maker", { entryBars: 2 });
    assert.equal(e2.filled, true);
    assert.equal(e2.fillType, "maker-fill");
    assert.equal(e2.entryPrice, TOUCH);
    assert.equal(e2.repices, 0);
    assert.equal(e2.entryIndex, 1);
  });
  it("a maker fill never re-prices", () => {
    const candles = [bar(0, 100.2, 100.3, 100.1, 100.2), bar(1, 100.5, 101, 100.4, 101), bar(2, 101, 101.2, 100.8, 101)];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "maker", { entryBars: 3 });
    assert.equal(e.repices, 0);
  });
});

describe("simulateLiveEntry — chase", () => {
  it("re-prices to the new touch up to K times while it rests", () => {
    // The close walks up while each bar's LOW stays above the working
    // price, so the limit never trades through — it only re-prices.
    const candles = [
      bar(0, 100.2, 100.3, 100.1, 100.2),
      bar(1, 100.3, 100.4, 100.31, 100.35),
      bar(2, 100.4, 100.5, 100.36, 100.45),
    ];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "chase", { entryBars: 3, chaseMax: 5, chaseTakes: false });
    assert.equal(e.filled, false); // never traded through the last working price
    assert.equal(e.repices, 2); // re-priced to 100.35, then to 100.45
  });
  it("spends the chase budget, then the order rests instead of re-pricing", () => {
    const candles = [
      bar(0, 100.2, 100.3, 100.1, 100.2),
      bar(1, 100.3, 100.4, 100.31, 100.35),
      bar(2, 100.4, 100.5, 100.36, 100.45),
      bar(3, 100.5, 100.6, 100.46, 100.55),
    ];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "chase", { entryBars: 4, chaseMax: 1, chaseTakes: false });
    assert.equal(e.filled, false);
    assert.equal(e.repices, 1); // the budget stopped the second re-price
  });
  it("at the end of the window the chase cancels and TAKES the market", () => {
    // The window is bars 1..2; the order never trades through, so at the
    // end of the window the chase cancels and takes the market at the
    // last close (100.45).
    const candles = [
      bar(0, 100.2, 100.3, 100.1, 100.2),
      bar(1, 100.3, 100.4, 100.31, 100.35),
      bar(2, 100.4, 100.5, 100.36, 100.45),
    ];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "chase", { entryBars: 2, chaseMax: 5, chaseTakes: true });
    assert.equal(e.filled, true);
    assert.equal(e.fillType, "taker-fill");
    assert.equal(e.entryPrice, 100.45); // the last close in the window
    assert.equal(e.entryIndex, 2);
  });
  it("a chase that never moves still rests like a maker", () => {
    // Both bars close exactly on the touch, so the order never re-prices.
    const candles = [bar(0, 100, 100.2, 100.1, 100), bar(1, 100, 100.2, 100.1, 100)];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "chase", { entryBars: 2, chaseMax: 3, chaseTakes: false });
    assert.equal(e.filled, false);
    assert.equal(e.repices, 0);
  });
});

describe("simulateLiveEntry — taker", () => {
  it("fills at the OPEN of the next bar", () => {
    const candles = [bar(0, 100, 100.2, 99.9, 100), bar(1, 101.5, 102, 101, 101.2)];
    const e = simulateLiveEntry(candles, 0, PLAN_LONG, "taker", {});
    assert.equal(e.filled, true);
    assert.equal(e.entryIndex, 1);
    assert.equal(e.entryPrice, 101.5);
    assert.equal(e.fillType, "taker-fill");
  });
  it("does not fill when there is no next bar", () => {
    const e = simulateLiveEntry([bar(0, 100, 100.2, 99.9, 100)], 0, PLAN_LONG, "taker", {});
    assert.equal(e.filled, false);
    assert.equal(e.reason, "no-next-bar");
  });
});

/* ------------------------------------------------------------------ */
/* position: step 2, TP, kill                                         */
/* ------------------------------------------------------------------ */

describe("simulateLivePosition", () => {
  /** The TP in force on a ONE-step long entry at 100 (plan.tpPct off the entry). */
  const TP1 = averagedTpPrice(100, "long", PLAN_LONG.tpPct) as number;
  const KILL = PLAN_LONG.killPrice;
  /** A neutral bar that touches neither line. */
  const quiet = (i: number): LiveCandle => bar(i, 100, 100.05, 99.95, 100);

  it("the TP fills when the bar's range reaches it", () => {
    const candles = [quiet(0), bar(1, 100, TP1 + 0.05, 99.95, TP1)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.exitReason, "tp");
    assert.equal(p.exitPrice, TP1);
    assert.equal(p.exitIndex, 1);
    assert.equal(p.stepsFilled, 1);
    assert.equal(p.ambiguousTie, false);
  });
  it("an exit on the ENTRY bar is flagged — the fill and the exit share one bar", () => {
    const candles = [bar(0, 100, TP1 + 0.05, 99.95, 100.1), quiet(1)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.exitIndex, 0);
    assert.equal(p.exitReason, "tp");
    assert.equal(p.ambiguousTie, true);
  });
  it("the kill fills when the bar's range reaches it", () => {
    // The bar's low reaches the kill (98.20) — and on the way there it
    // crosses the averaging level (99.10), so the resting step-2 limit
    // fills first. The stop then closes the WHOLE averaged position.
    const s2 = PLAN_LONG.steps[1];
    assert.ok(s2);
    const candles = [quiet(0), bar(1, 100, 100.05, KILL - 0.05, KILL)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.exitReason, "kill");
    assert.equal(p.exitPrice, KILL);
    assert.equal(p.stepsFilled, 2);
    assert.equal(p.ambiguousTie, false);
    // The kill is sized on the AVERAGED entry, not on step 1 alone.
    assert.ok(Math.abs(p.avgEntry - (100 + s2.price) / 2) < 1e-9);
  });
  it("a bar that reaches BOTH lines resolves as a TP and is flagged ambiguous", () => {
    const candles = [quiet(0), bar(1, 100, TP1 + 0.05, KILL - 0.05, 100)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.exitReason, "tp");
    assert.equal(p.ambiguousTie, true);
  });
  it("step 2 fills at the plan's averaging level and the TP is recomputed on the averaged entry", () => {
    const s2 = PLAN_LONG.steps[1];
    assert.ok(s2);
    const avg = averagedEntry([
      { price: 100, sizeUsd: 60 },
      { price: s2.price, sizeUsd: 60 },
    ]) as number;
    const tpAfter = averagedTpPrice(avg, "long", PLAN_LONG.tpPct) as number;
    assert.ok(tpAfter < TP1, "averaging down must move the TP down");
    // Bar 1 trades through the averaging level (99.10); bar 2 reaches the
    // NEW TP (armed from bar 2, because the re-arm lands after the fill).
    const candles = [
      quiet(0),
      bar(1, 100, 100.05, s2.price - 0.01, s2.price),
      bar(2, 100, tpAfter + 0.05, 99.5, tpAfter),
    ];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.stepsFilled, 2);
    assert.equal(p.exitReason, "tp");
    assert.equal(p.exitPrice, tpAfter);
    assert.equal(p.avgEntry, avg);
  });
  it("the bar that fills step 2 is judged on the OLD TP (the re-arm lands after it)", () => {
    const s2 = PLAN_LONG.steps[1];
    assert.ok(s2);
    // This bar reaches the OLD TP but not the new one → it exits at the old TP.
    const candles = [quiet(0), bar(1, 100, TP1 + 0.05, s2.price - 0.01, s2.price)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 5 });
    assert.equal(p.stepsFilled, 2);
    assert.equal(p.exitReason, "tp");
    assert.equal(p.exitPrice, TP1);
  });
  it("exits at the close on timeout", () => {
    const candles = [quiet(0), bar(1, 100, 100.05, 99.95, 100.1), bar(2, 100.1, 100.15, 100.05, 100.2)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_LONG, { maxHoldBars: 2 });
    assert.equal(p.exitReason, "timeout");
    assert.equal(p.exitIndex, 2);
    assert.equal(p.exitPrice, 100.2);
  });
  it("a short mirrors the long: TP below, kill above", () => {
    const tpShort = averagedTpPrice(100, "short", PLAN_SHORT.tpPct) as number;
    const candles = [quiet(0), bar(1, 100.05, 100.1, tpShort - 0.05, 99.5)];
    const p = simulateLivePosition(candles, 0, 100, PLAN_SHORT, { maxHoldBars: 5 });
    assert.equal(p.exitReason, "tp");
    assert.equal(p.exitPrice, tpShort);
  });
});

/* ------------------------------------------------------------------ */
/* money                                                               */
/* ------------------------------------------------------------------ */

describe("entryFeePctFor / exitFeePctFor", () => {
  it("maker 0.02% on resting limits, taker 0.06% on market takes", () => {
    assert.equal(entryFeePctFor("maker-fill"), 0.02);
    assert.equal(entryFeePctFor("taker-fill"), 0.06);
    assert.equal(exitFeePctFor("tp"), 0.02); // a resting TP is maker
    assert.equal(exitFeePctFor("kill"), 0.06); // a stop is taker
    assert.equal(exitFeePctFor("timeout"), 0.06);
  });
});

describe("liveTradeMoney", () => {
  it("charges fees on the LEVERAGED notional, not the margin", () => {
    // $60 at $100 → 0.6 units; x2 leverage → $120 notional.
    const m = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 100, "long", 2, 0.02, 0.02);
    assert.equal(m.notionalUsd, 120);
    // 0.02% of $120 on each side = $0.024 + $0.024.
    assert.ok(Math.abs(m.feesUsd - 0.048) < 1e-9, `fees ${m.feesUsd}`);
    assert.ok(Math.abs(m.netUsd - -0.048) < 1e-9, `net ${m.netUsd}`);
  });
  it("a taker entry pays 3x the maker fee on the entry side", () => {
    const maker = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 100, "long", 2, 0.02, 0.02);
    const taker = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 100, "long", 2, 0.06, 0.02);
    // Same entry AND exit price → the same notional on both sides.
    // Entry side 0.06% vs 0.02% (3x), exit side unchanged → 2x in total.
    assert.ok(Math.abs(taker.feesUsd - maker.feesUsd * 2) < 1e-9, `${taker.feesUsd} vs ${maker.feesUsd}`);
    const takerBoth = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 100, "long", 2, 0.06, 0.06);
    assert.ok(Math.abs(takerBoth.feesUsd - maker.feesUsd * 3) < 1e-9);
  });
  it("leverage scales the P&L and the notional together", () => {
    const m = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 101, "long", 2, 0.02, 0.02);
    // 0.6 units × $1 × 2 = $1.20 gross.
    assert.ok(Math.abs(m.grossUsd - 1.2) < 1e-9, `gross ${m.grossUsd}`);
  });
  it("a short loses when the price rises", () => {
    const m = liveTradeMoney([{ price: 100, sizeUsd: 60 }], 101, "short", 1, 0.02, 0.02);
    assert.ok(m.grossUsd < 0, `gross ${m.grossUsd}`);
  });
});

describe("livePositionBasis / liveKillLossUsd", () => {
  it("the kill loss is sized on the AVERAGED position, not on step 1 alone", () => {
    const s2 = PLAN_LONG.steps[1];
    assert.ok(s2);
    const fills = [
      { price: 100, sizeUsd: 60 },
      { price: s2.price, sizeUsd: 60 },
    ];
    const basis = livePositionBasis(fills);
    assert.equal(basis.sizeUsd, 120);
    assert.ok(Math.abs(basis.avgEntry - (100 + s2.price) / 2) < 1e-9);
    // The loss covers BOTH filled steps at the kill price.
    const loss = liveKillLossUsd(fills, PLAN_LONG.killPrice, "long", 1);
    assert.ok(loss !== null && loss < 0, `loss ${loss}`);
    const step1Only = liveKillLossUsd([fills[0]!], PLAN_LONG.killPrice, "long", 1);
    assert.ok(loss !== null && step1Only !== null && loss < step1Only, "averaging in must cost more to stop out");
  });
  it("an empty position has no kill loss", () => {
    assert.equal(liveKillLossUsd([], 98, "long", 1), null);
  });
});

/* ------------------------------------------------------------------ */
/* filters (the live blocking rules)                                  */
/* ------------------------------------------------------------------ */

describe("sessionContextAt", () => {
  it("derives the day change and the session low from the candles", () => {
    const candles = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 100, 90, 100)];
    const ctx = sessionContextAt(candles, 2, { dayLookbackMs: 24 * 3600 * 1000, sessionLookbackMs: 60 * 60 * 1000 });
    assert.equal(ctx.price, 100);
    assert.ok(ctx.dayChgPct !== undefined && Math.abs(ctx.dayChgPct) < 1e-9, `day ${ctx.dayChgPct}`);
    assert.equal(ctx.sessionLow, 90);
  });
  it("an empty context never invents a number", () => {
    assert.deepEqual(sessionContextAt([], 0), {});
  });
});

describe("liveGate — the live blocking rules", () => {
  const ctx = { dayChgPct: -0.5, price: 100.5, sessionLow: 100 };
  it("passes a clean short", () => {
    const v = liveGate("SOLUSDTM", "short", ctx, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 100 });
    assert.equal(v.vetoed, false);
  });
  it("vetoes a short inside the CPI blackout (both directions)", () => {
    const v = liveGate("SOLUSDTM", "short", ctx, { nowMs: Date.UTC(2026, 9, 15, 12, 0), accountUsd: 100 });
    assert.equal(v.vetoed, true);
    assert.equal(v.rule, "cpi_blackout");
  });
  it("vetoes a short when the day is down more than 2%", () => {
    const v = liveGate("SOLUSDTM", "short", { ...ctx, dayChgPct: -2.5 }, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 100 });
    assert.equal(v.vetoed, true);
    assert.equal(v.rule, "extended_drop");
  });
  it("vetoes a short without a +0.4% bounce off the session low", () => {
    const v = liveGate("SOLUSDTM", "short", { dayChgPct: -0.5, price: 100.0, sessionLow: 100 }, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 100 });
    assert.equal(v.vetoed, true);
    assert.equal(v.rule, "bounce_required");
  });
  it("never vetoes a LONG on the short-only rules", () => {
    const v = liveGate("SOLUSDTM", "long", { dayChgPct: -5, price: 100, sessionLow: 100 }, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 100 });
    assert.equal(v.vetoed, false);
  });
  it("vetoes a small BTC trade on a small account (the fee veto)", () => {
    const v = liveGate("XBTUSDTM", "long", ctx, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 10, notionalUsd: 20 });
    assert.equal(v.vetoed, true);
    assert.equal(v.rule, "btc_fee");
  });
  it("frees BTC at a big notional or a better fee tier", () => {
    const big = liveGate("XBTUSDTM", "long", ctx, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 10, notionalUsd: 500 });
    assert.equal(big.vetoed, false);
    const tier = liveGate("XBTUSDTM", "long", ctx, { nowMs: Date.UTC(2026, 9, 15, 10, 0), accountUsd: 10, feeTierOk: true });
    assert.equal(tier.vetoed, false);
  });
});

/* ------------------------------------------------------------------ */
/* aggregates                                                          */
/* ------------------------------------------------------------------ */

describe("liveStatsFromTrades", () => {
  it("computes trades, WR, net%, expectancy and max drawdown", () => {
    const s = liveStatsFromTrades([
      trade({ netUsd: 10, netPct: 1, win: true }),
      trade({ netUsd: -4, netPct: -0.5, win: false }),
      trade({ netUsd: 6, netPct: 0.6, win: true }),
    ]);
    assert.equal(s.trades, 3);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.ok(Math.abs(s.winRate - (2 / 3) * 100) < 1e-9);
    assert.ok(Math.abs(s.netPct - 1.1) < 1e-9, `netPct ${s.netPct}`);
    assert.ok(Math.abs(s.netUsd - 12) < 1e-9);
    assert.ok(Math.abs(s.expectancyUsd - 4) < 1e-9);
    assert.ok(Math.abs(s.expectancyPctPerTrade - 1.1 / 3) < 1e-9);
    // Equity curve: +10 → +6 → +12; the drawdown is the 10→6 dip = 4.
    assert.ok(Math.abs(s.maxDrawdownUsd - 4) < 1e-9, `dd ${s.maxDrawdownUsd}`);
    assert.ok(Math.abs(s.maxDrawdownPct - 0.5) < 1e-9, `ddPct ${s.maxDrawdownPct}`);
  });
  it("an empty book reads zero, never NaN", () => {
    const s = liveStatsFromTrades([]);
    assert.equal(s.trades, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.expectancyUsd, 0);
    assert.equal(s.maxDrawdownUsd, 0);
  });
  it("charges an ambiguous tie as a loss in the conservative expectancy", () => {
    const tie = trade({ netUsd: 5, netPct: 1, win: true, ambiguousTie: true });
    const s = liveStatsFromTrades([tie]);
    assert.equal(s.ambiguousTies, 1);
    assert.ok(s.conservativeExpectancyPct < 0, `conservative ${s.conservativeExpectancyPct}`);
    assert.ok(s.expectancyPctPerTrade > 0);
  });
});

describe("liveByFillType", () => {
  it("splits the expectancy by maker-fill vs taker-fill", () => {
    const s = liveByFillType([
      trade({ fillType: "maker-fill", netUsd: 10, netPct: 1, win: true }),
      trade({ fillType: "maker-fill", netUsd: 10, netPct: 1, win: true }),
      trade({ fillType: "taker-fill", netUsd: -6, netPct: -0.6, win: false }),
    ]);
    assert.equal(s["maker-fill"].trades, 2);
    assert.equal(s["maker-fill"].winRate, 100);
    assert.ok(Math.abs(s["maker-fill"].expectancyPctPerTrade - 1) < 1e-9);
    assert.equal(s["taker-fill"].trades, 1);
    assert.equal(s["taker-fill"].winRate, 0);
    assert.ok(Math.abs(s["taker-fill"].expectancyPctPerTrade + 0.6) < 1e-9);
  });
});

/* ------------------------------------------------------------------ */
/* the whole book                                                      */
/* ------------------------------------------------------------------ */

describe("runLiveBacktest", () => {
  /**
   * A deterministic tape: bar 0 sets up the signal (its CLOSE is the mark
   * the plan is built from), bar 1 trades through the touch (the maker
   * entry fills), bar 2 reaches the TP.
   */
  function scripted(): LiveCandle[] {
    return [
      bar(0, 100.2, 100.3, 100.1, 100.2), // the signal bar (close 100.2 = the mark)
      bar(1, 100.2, 100.25, 99.95, 100.0), // low 99.95 trades through the touch
      bar(2, 100.0, 100.8, 99.99, 100.7), // reaches the TP
    ];
  }
  /** Always-long signal on every bar — the candidate edge under test. */
  const longOnly = (): "long" => "long";

  it("replays the entry, the ladder, the TP and the fees into a ledger", () => {
    const r = runLiveBacktest(scripted(), {
      mode: "maker",
      sizeUsd: 60,
      leverage: 2,
      signal: longOnly,
    });
    assert.equal(r.trades.length, 1);
    const t = r.trades[0] as LiveTradeRow;
    assert.equal(t.direction, "long");
    assert.equal(t.entryIndex, 1);
    assert.equal(t.fillType, "maker-fill");
    assert.equal(t.exitReason, "tp");
    assert.ok(t.feesUsd > 0);
    assert.ok(Number.isFinite(t.netUsd));
    assert.equal(t.netUsd, t.grossUsd - t.feesUsd);
    assert.equal(t.win, t.netUsd > 0);
    // The ledger carries the whole story.
    assert.ok(t.entryTime.length > 0 && t.exitTime.length > 0);
    assert.ok(t.tpPrice > 0 && t.killPrice > 0);
    // The plan is built from the SIGNAL BAR'S close (100.2).
    assert.ok(Math.abs(t.entryPrice - 100.2) < 1e-9, `entry ${t.entryPrice}`);
  });
  it("runs one position at a time — trades never overlap", () => {
    const r = runLiveBacktest(scripted(), { mode: "maker", signal: longOnly });
    for (let i = 1; i < r.trades.length; i++) {
      const prev = r.trades[i - 1] as LiveTradeRow;
      const cur = r.trades[i] as LiveTradeRow;
      assert.ok(cur.entryIndex > prev.exitIndex, `trade ${i} overlaps trade ${i - 1}`);
    }
  });
  it("the taker book pays the taker fee and fills at the next open", () => {
    const r = runLiveBacktest(scripted(), { mode: "taker", signal: longOnly });
    assert.equal(r.trades.length, 1);
    const t = r.trades[0] as LiveTradeRow;
    assert.equal(t.fillType, "taker-fill");
    assert.equal(t.entryPrice, 100.2); // the open of bar 1
  });
  it("'all' runs three independent books and never sums them", () => {
    const r = runLiveBacktest(scripted(), { mode: "all", signal: longOnly });
    assert.equal(r.books.maker.stats.trades, r.books.maker.trades);
    assert.equal(r.books.chase.stats.trades, r.books.chase.trades);
    assert.equal(r.books.taker.stats.trades, r.books.taker.trades);
    // The top-level ledger is ONE book, not the sum of three.
    assert.equal(r.trades.length, r.books[r.primaryMode].trades);
    assert.ok(r.trades.length <= r.books.maker.trades + r.books.chase.trades + r.books.taker.trades);
  });
  it("reports the expectancy split by fill type", () => {
    const r = runLiveBacktest(scripted(), { mode: "all", signal: longOnly });
    const split = r.byFillType;
    assert.equal(split["maker-fill"].trades + split["taker-fill"].trades, r.trades.length);
  });
  it("a vetoed signal produces no trade and is recorded", () => {
    // A SHORT on this tape is inside the flush (no +0.4% bounce off the
    // session low) → the live bounce-required veto kills it. The SOL book
    // produces NO trade and records the veto.
    const sol = runLiveBacktest(scripted(), {
      mode: "maker",
      signal: () => "short",
      symbol: "SOLUSDTM",
    });
    assert.equal(sol.trades.length, 0);
    assert.ok(sol.vetoes.length > 0);
    assert.equal(sol.vetoes[0]?.rule, "bounce_required");
    // A LONG on the same tape is not short-gated → it trades.
    const long = runLiveBacktest(scripted(), {
      mode: "maker",
      signal: () => "long",
      symbol: "SOLUSDTM",
    });
    assert.equal(long.trades.length, 1);
    assert.equal(long.vetoes.length, 0);
  });
  it("the BTC fee veto benches a small trade on a small account", () => {
    // A $10 step × 2 steps = $20 notional on a $10 account → below the
    // $50 notional floor AND below the $25 account floor → the btc_fee
    // rule fires (the live path reads JW3_ACCOUNT_USD).
    const btc = runLiveBacktest(scripted(), {
      mode: "maker",
      signal: () => "long",
      symbol: "XBTUSDTM",
      accountUsd: 10,
      leverage: 1,
      sizeUsd: 10,
    });
    assert.equal(btc.trades.length, 0);
    assert.ok(btc.vetoes.length > 0);
    assert.equal(btc.vetoes[0]?.rule, "btc_fee");
    // The same book on a SOL pair is NOT gated by the BTC fee rule.
    const sol = runLiveBacktest(scripted(), {
      mode: "maker",
      signal: () => "long",
      symbol: "SOLUSDTM",
      accountUsd: 10,
      leverage: 1,
      sizeUsd: 10,
    });
    assert.equal(sol.trades.length, 1);
  });
  it("an empty tape produces an empty book, not a crash", () => {
    const r = runLiveBacktest([], { mode: "all" });
    assert.equal(r.trades.length, 0);
    assert.equal(r.stats.trades, 0);
    assert.equal(r.stats.winRate, 0);
  });
});

/* ------------------------------------------------------------------ */
/* the signal + the command                                            */
/* ------------------------------------------------------------------ */

describe("liveExhaustionSignal", () => {
  it("is null on a neutral row — no direction, no trade", () => {
    const row = {
      chg: 0, vratio: 1, vslope: "up" as const, offHighPct: 0, offLowPct: 0,
      atrPct: 1, fundingPct: null, last: 100, n: 24, symbol: "",
    };
    assert.equal(liveExhaustionSignal(row), null);
  });
  it("is null on an AMBIGUOUS row — fade and dip fire together", () => {
    // fadeSignal and dipSignal share the faded-volume condition
    // (vratio < 0.85), so an exhaustion bar has no decidable direction
    // without the oracle's vote. The backtest must not invent one.
    const faded = {
      chg: 0, vratio: 0.5, vslope: "down" as const, offHighPct: 2, offLowPct: 0,
      atrPct: 1, fundingPct: null, last: 100, n: 24, symbol: "",
    };
    assert.equal(liveExhaustionSignal(faded), null);
  });
  it("is null without a row", () => {
    assert.equal(liveExhaustionSignal(null), null);
  });
});

describe("liveRowAt", () => {
  it("needs 24 bars of history before it reads a row", () => {
    assert.equal(liveRowAt(flat(23), 22), null);
    const row = liveRowAt(flat(24), 23);
    assert.ok(row !== null);
    assert.equal(row?.last, 100);
  });
});

describe("validateBacktestLiveArgs", () => {
  const good = { pair: "SOL/USDT", days: 30, tf: "15m", sizeUsd: 60, leverage: 2, mode: "all" as const, json: false };
  it("accepts a usable ticket", () => {
    assert.equal(validateBacktestLiveArgs(good), null);
  });
  it("rejects a bad pair, timeframe, size, leverage or mode", () => {
    assert.ok(validateBacktestLiveArgs({ ...good, pair: "SOL" }));
    assert.ok(validateBacktestLiveArgs({ ...good, pair: "SOL/USD" }));
    assert.ok(validateBacktestLiveArgs({ ...good, tf: "7m" }));
    assert.ok(validateBacktestLiveArgs({ ...good, sizeUsd: 0 }));
    assert.ok(validateBacktestLiveArgs({ ...good, leverage: -1 }));
    assert.ok(validateBacktestLiveArgs({ ...good, days: 0 }));
    assert.ok(validateBacktestLiveArgs({ ...good, mode: "market" as never }));
  });
});

describe("liveCandlesFromRows", () => {
  it("parses venue kline rows and drops malformed ones", () => {
    const rows = [
      [T0, 100, 101, 99, 100.5, 12, 1200],
      [T0 + BAR_MS, 100.5, 102, 100, 101, 8],
      [T0 + 2 * BAR_MS, 0, 1, 1, 0, 1], // a zero close is dropped
    ];
    const c = liveCandlesFromRows(rows);
    assert.equal(c.length, 2);
    assert.equal(c[0]?.open, 100);
    assert.equal(c[0]?.high, 101);
    assert.equal(c[0]?.low, 99);
    assert.equal(c[0]?.close, 100.5);
    assert.equal(c[0]?.tsMs, T0);
  });
});
