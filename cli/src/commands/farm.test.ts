import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FARM_MIN_TRADES,
  breakoutFarmSignal,
  farmRowFor,
  fundingFarmSignal,
  momentumFarmSignal,
  pickFarmWinner,
  replayFarmStrategy,
  sortFarmLeaderboard,
  type FarmRow,
  type FarmSignalCtx,
} from "./farm.js";
import type { ScalpKline } from "../kucoin.js";

function ctx(over: Partial<FarmSignalCtx>): FarmSignalCtx {
  return {
    m: null,
    last: 100,
    closes: [],
    highs: [],
    lows: [],
    vols: [],
    i: 23,
    ...over,
  };
}

/** Rising closes + rising vols → valid fadeMetrics window shape. */
function trendKlines(n: number, drift: number): ScalpKline[] {
  const out: ScalpKline[] = [];
  let px = 100;
  for (let k = 0; k < n; k++) {
    px *= 1 + drift;
    out.push({ open: px, high: px * 1.002, low: px * 0.998, close: px, volume: 1000 + k * 10 });
  }
  return out;
}

function row(over: Partial<FarmRow>): FarmRow {
  return {
    strategy: "fade", pair: "SOL/USDT", symbol: "SOLUSDTM", candles: 720,
    signals: 20, n: 20, wins: 12, losses: 8, winRate: 60, totalNetPct: 2,
    expectancyPct: 0.1, avgWinPct: 0.4, avgLossPct: -0.3, breakevenWr: 42.9,
    meetsGate: true,
    ...over,
  };
}

describe("momentumFarmSignal", () => {
  it("goes long on a 12h climb with rising volume, flat otherwise", () => {
    const closes = Array.from({ length: 30 }, (_, k) => 100 + k); // +~29% over window
    const vols = Array.from({ length: 30 }, (_, k) => 100 + k * 20);
    const highs = closes.map((c) => c * 1.001);
    const lows = closes.map((c) => c * 0.999);
    const m = { chg: 20, vratio: 1.8, vslope: "up" as const, offHighPct: 1, offLowPct: 20, atrPct: 0.8, n: 24 };
    assert.equal(momentumFarmSignal(ctx({ m, last: closes[23]!, closes, highs, lows, vols, i: 23 })), "long");
    assert.equal(momentumFarmSignal(ctx({ m: { ...m, vratio: 1.0 }, last: closes[23]!, closes, highs, lows, vols, i: 23 })), null);
  });
});

describe("breakoutFarmSignal", () => {
  it("goes long on a close above the prior-24h high", () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes[24] = 110; // breakout bar
    const highs = closes.map((c) => c);
    const lows = closes.map((c) => c * 0.999);
    const vols = Array.from({ length: 30 }, () => 1000);
    const m = { chg: 8, vratio: 1.5, vslope: "up" as const, offHighPct: 0, offLowPct: 9, atrPct: 0.8, n: 24 };
    assert.equal(breakoutFarmSignal(ctx({ m, last: 110, closes, highs, lows, vols, i: 24 })), "long");
    assert.equal(breakoutFarmSignal(ctx({ m, last: 100, closes, highs, lows, vols, i: 24 })), null);
  });
});

describe("fundingFarmSignal", () => {
  it("fades ±5% overextensions, flat inside", () => {
    const base = ctx({});
    assert.equal(fundingFarmSignal({ ...base, m: { chg: 6, vratio: 1, vslope: "up", offHighPct: 1, offLowPct: 5, atrPct: 1, n: 24 } }), "short");
    assert.equal(fundingFarmSignal({ ...base, m: { chg: -6, vratio: 1, vslope: "down", offHighPct: 5, offLowPct: 1, atrPct: 1, n: 24 } }), "long");
    assert.equal(fundingFarmSignal({ ...base, m: { chg: 2, vratio: 1, vslope: "up", offHighPct: 1, offLowPct: 1, atrPct: 1, n: 24 } }), null);
    assert.equal(fundingFarmSignal({ ...base, m: null }), null);
  });
});

describe("replayFarmStrategy", () => {
  it("returns null on thin history, zero trades on a flat tape", () => {
    assert.equal(replayFarmStrategy(trendKlines(10, 0), momentumFarmSignal), null);
    const flat = Array.from({ length: 100 }, () => ({ open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 }));
    const r = replayFarmStrategy(flat, momentumFarmSignal);
    assert.ok(r);
    assert.equal(r.trades.length, 0);
    assert.equal(r.expectancyPct, 0);
  });
  it("finds momentum trades on a steady climb", () => {
    const klines = trendKlines(200, 0.004).map((k, idx) => ({ ...k, volume: 1000 + idx * 80 }));
    const r = replayFarmStrategy(klines, momentumFarmSignal);
    assert.ok(r);
    assert.ok(r.signals > 0);
    assert.ok(r.trades.length > 0);
  });
});

describe("pickFarmWinner", () => {
  it("picks top expectancy among gate-clearers, rejects thin or negative rows", () => {
    assert.equal(FARM_MIN_TRADES, 15);
    const rows = [
      row({ strategy: "fade", expectancyPct: 0.5, n: 30 }), // winner
      row({ strategy: "momentum", expectancyPct: 0.9, n: 5 }), // thin — ineligible
      row({ strategy: "breakout", expectancyPct: -0.2, n: 40 }), // negative — ineligible
      row({ strategy: "funding", expectancyPct: 0.3, n: 20 }),
    ];
    assert.equal(pickFarmWinner(rows)?.strategy, "fade");
    assert.equal(pickFarmWinner([row({ expectancyPct: 0.9, n: 5 })]), null);
    assert.equal(pickFarmWinner([]), null);
  });
});

describe("sortFarmLeaderboard", () => {
  it("sorts expectancy desc", () => {
    const sorted = sortFarmLeaderboard([row({ expectancyPct: 0.1 }), row({ expectancyPct: 0.4 }), row({ expectancyPct: -0.2 })]);
    assert.deepEqual(sorted.map((r) => r.expectancyPct), [0.4, 0.1, -0.2]);
  });
});

describe("farmRowFor", () => {
  it("marks the gate on replay stats, false on null", () => {
    const r = replayFarmStrategy(trendKlines(200, 0.004), momentumFarmSignal)!;
    const good = farmRowFor("momentum", "SOL/USDT", "SOLUSDTM", r);
    assert.equal(good.meetsGate, good.expectancyPct > 0 && good.n >= 15);
    const empty = farmRowFor("fade", "SOL/USDT", "SOLUSDTM", null);
    assert.equal(empty.n, 0);
    assert.equal(empty.meetsGate, false);
  });
});
