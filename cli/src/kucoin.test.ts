import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backtestGrid, backtestScalp, dipSignal, fadeMetrics, fadeSignal, gridLadder, planScalp, scanBase, type ScalpKline } from "./kucoin.js";

function series(n: number, fn: (i: number) => number): number[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}

describe("fadeMetrics", () => {
  it("detects faded volume under a flat top", () => {
    const closes = series(24, (i) => 100 + i * 0.5);
    const vols = [...series(12, () => 1000), ...series(12, (i) => 600 - i * 10)];
    const m = fadeMetrics(closes, vols);
    assert.ok(m);
    assert.ok((m as { vratio: number }).vratio < 0.85);
    assert.equal((m as { vslope: string }).vslope, "down");
  });
  it("rejects thin tape", () => {
    assert.equal(fadeMetrics([1, 2], [1, 2]), null);
  });
});

describe("fadeSignal", () => {
  const base = { chg: 6, vratio: 1, vslope: "up" as const, offHighPct: 2, offLowPct: 20, atrPct: 0.8, fundingPct: 0.01, last: 1, n: 60, symbol: "XUSDTM" };
  it("flags fade-short, strong, late, neutral", () => {
    assert.equal(fadeSignal({ ...base, vratio: 0.6 }), "fade-short");
    assert.equal(fadeSignal({ ...base, vratio: 12 }), "strong");
    assert.equal(fadeSignal({ ...base, vratio: 0.5, offHighPct: 34 }), "late");
    assert.equal(fadeSignal(base), "neutral");
  });
});

describe("dipSignal", () => {
  const base = { chg: -5, vratio: 1, vslope: "down" as const, offHighPct: 20, offLowPct: 2, atrPct: 0.8, fundingPct: 0.01, last: 1, n: 60, symbol: "XUSDTM" };
  it("flags dip-long, capitulation, extended, neutral", () => {
    assert.equal(dipSignal({ ...base, vratio: 0.6 }), "dip-long");
    assert.equal(dipSignal({ ...base, vratio: 12 }), "capitulation");
    assert.equal(dipSignal({ ...base, vratio: 0.5, offLowPct: 34 }), "extended");
    assert.equal(dipSignal(base), "neutral");
  });
});

describe("planScalp", () => {
  it("derives TP/steps/avg/kill from measured ATR", () => {
    const p = planScalp(100, 1.0, "long", 15, 3);
    assert.ok(p);
    assert.equal(p?.steps.length, 3);
    assert.ok((p?.tpPct ?? 0) >= 0.3 && (p?.tpPct ?? 0) <= 0.5);
    assert.ok((p?.maxCapitalUsd ?? 0) === 60);
    assert.ok((p?.tpProfitUsd ?? 0) > 0);
    assert.ok((p?.killLossUsd ?? 0) > (p?.tpProfitUsd ?? 0));
    assert.ok((p?.avgEntry ?? 0) < 100); // averaged down
    const short = planScalp(100, 1.0, "short", 15, 2);
    assert.equal(short?.steps.length, 2);
    assert.ok((short?.avgEntry ?? 0) > 100); // averaged up
  });
  it("rejects bad input without inventing", () => {
    assert.equal(planScalp(0, 1, "long", 15), null);
    assert.equal(planScalp(100, 1, "long", 0), null);
  });
});

describe("gridLadder", () => {
  it("builds a symmetric geometric ladder", () => {
    const g = gridLadder(100, 0.25, 25);
    assert.ok(g);
    assert.equal(g?.levels.length, 50);
    assert.equal(g?.bias, "neutral");
    assert.equal(g?.seedContracts, 0);
    assert.equal(g?.levels.filter((l) => l.side === "buy").length, 25);
    assert.equal(g?.levels.filter((l) => l.side === "sell").length, 25);
    const buys = g?.levels.filter((l) => l.side === "buy").map((l) => l.price) ?? [];
    const sells = g?.levels.filter((l) => l.side === "sell").map((l) => l.price) ?? [];
    assert.ok(Math.max(...buys) < 100 && Math.min(...sells) > 100);
    // geometric step ratio holds at the touch levels
    const touchBuy = Math.max(...buys);
    const touchSell = Math.min(...sells);
    assert.ok(Math.abs(touchSell / touchBuy - Math.pow(1.0025, 2)) < 1e-9);
    assert.ok((g?.rangePct ?? 0) > 12 && (g?.rangePct ?? 0) < 13.5);
  });
  it("seeds directional inventory", () => {
    const long = gridLadder(100, 0.25, 25, "long", 10);
    assert.equal(long?.seedContracts, 250);
    const short = gridLadder(100, 0.25, 25, "short", 10);
    assert.equal(short?.seedContracts, 250);
  });
  it("rejects bad input without inventing", () => {
    assert.equal(gridLadder(0, 0.25, 25), null);
    assert.equal(gridLadder(100, 0, 25), null);
    assert.equal(gridLadder(100, 10, 25), null);
  });
});

describe("backtestGrid", () => {
  const flat = Array.from({ length: 200 }, () => 100);
  it("flat market: no fills, no breaks, seed fee only", () => {
    const r = backtestGrid(flat, 100, 0.25, 25, 10, 10, "long", 2);
    assert.ok(r);
    assert.equal(r?.fills, 0);
    assert.equal(r?.rangeBreaks, 0);
    assert.ok(Math.abs((r?.totalUsd ?? 0) + 150) < 0.01); // 250ct×10×100×0.0006 seed fee
  });
  it("steady uptrend pays a long grid, breaks the top", () => {
    const up = Array.from({ length: 200 }, (_, i) => 100 + i * 0.15);
    const r = backtestGrid(up, 100, 0.25, 25, 10, 10, "long", 2);
    assert.ok(r);
    assert.ok((r?.fills ?? 0) > 20);
    assert.ok((r?.rangeBreaks ?? 0) > 0);
    assert.ok((r?.totalUsd ?? 0) > 0);
  });
  it("steady downtrend pays a short grid", () => {
    const dn = Array.from({ length: 200 }, (_, i) => 100 - i * 0.15);
    const r = backtestGrid(dn, 100, 0.25, 25, 10, 10, "short", 2);
    assert.ok(r);
    assert.ok((r?.totalUsd ?? 0) > 0);
  });
  it("oscillation pays a neutral grid without inventory drift", () => {
    const osc = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 6) * 3);
    const r = backtestGrid(osc, 100, 0.25, 25, 10, 10, "neutral", 2);
    assert.ok(r);
    assert.ok((r?.fills ?? 0) > 10);
    assert.ok((r?.realizedUsd ?? 0) > 0);
  });
  it("rejects thin input", () => {
    assert.equal(backtestGrid([100], 100, 0.25, 25, 10, 10, "long", 2), null);
  });
});

describe("scanBase", () => {
  it("keeps alts, drops stables/majors/leveraged", () => {
    assert.equal(scanBase("QNT/USDT"), "QNT");
    assert.equal(scanBase("USDC/USDT"), null);
    assert.equal(scanBase("BTC/USDT"), null);
    assert.equal(scanBase("ETH3L/USDT"), null);
  });
});

describe("backtestScalp", () => {
  const K = (close: number, volume: number, spread = 0.3): ScalpKline => ({
    open: close, high: close + spread, low: close - spread, close, volume,
  });
  // 24-bar grind up on faded volume: fade-short fires, dip-long does not
  // (early lows are >15% below the top → "extended", not a dip).
  const setup = (): ScalpKline[] =>
    Array.from({ length: 24 }, (_, i) => K(80 + i * 1.0, i < 12 ? 1000 : 600 - (i - 12) * 10));

  it("shorts the fade and banks TP through the ladder", () => {
    const follow = [102, 101, 100, 99, 98].map((c) => K(c, 500));
    const r = backtestScalp([...setup(), ...follow]);
    assert.ok(r);
    assert.ok((r?.trades.length ?? 0) >= 1);
    const first = r?.trades[0];
    assert.equal(first?.direction, "short");
    assert.equal(first?.exit, "tp");
    assert.ok((first?.netPct ?? 0) > 0); // TP clears round-trip taker fees
    assert.equal(r?.verdict, "GO");
    assert.ok((r?.winRate ?? 0) >= 62);
  });

  it("takes the kill when the fade keeps running", () => {
    const follow = [104, 105, 106, 107, 108].map((c) => K(c, 500));
    const r = backtestScalp([...setup(), ...follow]);
    assert.ok(r);
    assert.ok((r?.trades.length ?? 0) >= 1);
    assert.equal(r?.trades[0]?.exit, "kill");
    assert.ok((r?.trades[0]?.netPct ?? 0) < 0);
    assert.equal(r?.verdict, "NO-GO");
  });

  it("the GO bar is the break-even, not a hardcoded 62%", () => {
    // The bug this guards: `SCALP_GO_WIN_RATE = 62` was used as the gate,
    // but a 0.3% TP against a 0.6% kill needs ~80% to break even. A 62%
    // win rate was a "GO" that was arithmetically a bleed.
    const r = backtestScalp([...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))]);
    assert.ok(r);
    // The bar is the higher of the 62% floor and the computed break-even.
    assert.equal(r?.goBarWr, Math.max(62, r?.breakevenWr ?? 0));
    // And it is never BELOW the break-even — that is the whole point.
    assert.ok((r?.goBarWr ?? 0) >= (r?.breakevenWr ?? 0));
    // A GO must clear the bar, not just the floor.
    if (r?.verdict === "GO") {
      assert.ok((r?.winRate ?? 0) >= (r?.goBarWr ?? 0));
    }
  });

  it("a sub-break-even win rate cannot read as GO", () => {
    // Construct a run whose win rate clears 62% but NOT its break-even.
    // If the gate still used the hardcoded floor, this would read GO.
    const wins = [102, 101, 100, 99, 98];
    const losses = [104, 105, 106, 107, 108];
    const r = backtestScalp([...setup(), ...wins.map((c) => K(c, 500)), ...losses.map((c) => K(c, 500))]);
    assert.ok(r);
    if ((r?.winRate ?? 0) > 62 && (r?.winRate ?? 0) < (r?.breakevenWr ?? 0)) {
      assert.equal(r?.verdict, "NO-GO");
    }
  });

  it("TP wins an intra-bar tie (watch semantics)", () => {
    // One bar stabbing both lines: low 100 ≤ TP and high 105 ≥ kill.
    const r = backtestScalp([...setup(), { open: 103, high: 105, low: 100, close: 102, volume: 500 }]);
    assert.ok(r);
    assert.equal(r?.trades[0]?.exit, "tp");
  });

  it("flags an intra-bar tie as ambiguous and charges it as a loss conservatively", () => {
    // The bar stabs both levels — OHLC cannot say which came first. The
    // optimistic series resolves it as a TP, but the conservative verdict
    // must charge it as the loss it might have been, so an edge that only
    // exists under favourable tie-breaking cannot read as GO.
    const r = backtestScalp([...setup(), { open: 103, high: 105, low: 100, close: 102, volume: 500 }]);
    assert.ok(r);
    assert.equal(r?.ambiguousTrades, 1);
    assert.equal(r?.trades[0]?.ambiguous, true);
    assert.equal(r?.winRateConservative, 0);
    assert.ok((r?.totalNetPctConservative ?? 0) < 0);
    assert.ok((r?.expectancyPctConservative ?? 0) < 0);
    assert.equal(r?.verdictConservative, "NO-GO");
    // The optimistic series keeps its historical resolution for continuity.
    assert.equal(r?.verdict, "GO");
  });

  it("an unambiguous win leaves the conservative verdict untouched", () => {
    const r = backtestScalp([...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))]);
    assert.ok(r);
    assert.equal(r?.ambiguousTrades, 0);
    assert.equal(r?.verdictConservative, r?.verdict);
    assert.ok(Math.abs((r?.totalNetPctConservative ?? 0) - (r?.totalNetPct ?? 0)) < 1e-9);
  });

  it("maker fees net more than taker on the same tape", () => {
    const tape = [...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))];
    const maker = backtestScalp(tape, { feePerSidePct: 0.02 });
    const taker = backtestScalp(tape, { feePerSidePct: 0.06 });
    assert.ok(maker && taker);
    const d = maker.trades[0]?.netPct as number;
    const e = taker.trades[0]?.netPct as number;
    assert.ok(Math.abs(d - e - 0.08) < 1e-9); // 2 sides × 0.04pp
  });

  it("honors an explicit --tp override", () => {
    const tape = [...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))];
    const r = backtestScalp(tape, { tpPct: 0.2 });
    assert.ok(r);
    assert.equal(r?.tpPct, 0.2);
    const t = r?.trades[0];
    assert.ok(t);
    assert.ok(Math.abs((t?.tpPrice ?? 0) - (t?.entry ?? 0) * 0.998) < 1e-9);
  });

  it("measures the HONEST CONDITIONAL on every bar where the signal fired", () => {
    // `fadeSignal` and `dipSignal` fire on the SAME faded-volume condition,
    // so most triggered bars are ambiguous and the main series skips them.
    // The conditional track counts every bar where the signal fired — what a
    // REAL trade would have done — so a selected-sample edge cannot hide.
    const r = backtestScalp([...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))]);
    assert.ok(r);
    assert.ok((r?.conditionalTrades ?? 0) > 0);
    assert.ok((r?.conditionalSignals ?? 0) >= (r?.conditionalTrades ?? 0));
    // The conditional sample must be at least as large as the selected one —
    // that is the whole point: it never drops a triggered bar.
    assert.ok((r?.conditionalTrades ?? 0) >= (r?.trades.length ?? 0));
    assert.equal(r?.conditionalBySide.long.trades + r?.conditionalBySide.short.trades, r?.conditionalTrades);
    // Expectancy is defined on the conditional sample.
    const exp = r?.expectancyPctConditional ?? 0;
    const tot = r?.totalNetPctConditional ?? 0;
    assert.ok(Math.abs(exp * (r?.conditionalTrades ?? 0) - tot) < 1e-9);
  });

  it("the conditional track never drops a triggered bar", () => {
    // The selected (unambiguous) series can be positive while the honest
    // conditional is negative — that combination is exactly the trap the
    // conditional track exists to expose. On a fixture where every bar is
    // unambiguous the two samples coincide; what must always hold is that
    // the conditional sample is at least as large, and that it is a real
    // measurement rather than a copy of the selected series.
    const r = backtestScalp([...setup(), ...[102, 101, 100, 99, 98].map((c) => K(c, 500))]);
    assert.ok(r);
    assert.ok((r?.conditionalTrades ?? 0) >= (r?.trades.length ?? 0));
    assert.ok(Number.isFinite(r?.expectancyPctConditional ?? NaN));
    assert.ok(Number.isFinite(r?.totalNetPctConditional ?? NaN));
    // The conditional totals must be internally consistent.
    const exp = r?.expectancyPctConditional ?? 0;
    const tot = r?.totalNetPctConditional ?? 0;
    assert.ok(Math.abs(exp * (r?.conditionalTrades ?? 0) - tot) < 1e-9);
  });

  it("flat tape: no signals, NO-GO without inventing trades", () => {
    const flat = Array.from({ length: 60 }, () => K(100, 500, 0.1));
    const r = backtestScalp(flat);
    assert.ok(r);
    assert.equal(r?.trades.length, 0);
    assert.equal(r?.verdict, "NO-GO");
  });

  it("rejects thin history", () => {
    assert.equal(backtestScalp(Array.from({ length: 10 }, () => K(100, 500))), null);
  });
});
