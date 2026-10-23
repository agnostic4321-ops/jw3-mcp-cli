import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SPIKE_SYMS,
  spikeBaselineStats,
  spikeImbalance,
  spikeNotionals,
  spikeSpreadBps,
  spikeSymbolForBase,
  spikeThrust,
  spikeVolTrigger,
  spikeWall,
} from "./kucoin.js";
import { parseSpikePairs } from "./commands/spikes.js";

describe("spikeSymbolForBase", () => {
  it("maps bases to futures symbols, BTC aliases XBT", () => {
    assert.equal(spikeSymbolForBase("XBT"), "XBTUSDTM");
    assert.equal(spikeSymbolForBase("btc"), "XBTUSDTM");
    assert.equal(spikeSymbolForBase("eth"), "ETHUSDTM");
    assert.equal(spikeSymbolForBase("SOL"), "SOLUSDTM");
    assert.equal(spikeSymbolForBase("gram"), "GRAMUSDTM");
    assert.equal(spikeSymbolForBase("SUI"), "SUIUSDTM");
    assert.equal(spikeSymbolForBase("dot"), "DOTUSDTM");
    assert.equal(spikeSymbolForBase("DOGE"), "DOGEUSDTM");
    assert.equal(spikeSymbolForBase("pepe"), "PEPEUSDTM");
    assert.equal(spikeSymbolForBase("UNI"), "UNIUSDTM");
    assert.equal(spikeSymbolForBase("BONK"), null);
  });
});

describe("parseSpikePairs", () => {
  it("defaults to all four symbols", () => {
    assert.deepEqual(parseSpikePairs(undefined), ["XBTUSDTM", "ETHUSDTM", "SOLUSDTM", "GRAMUSDTM"]);
    assert.deepEqual(parseSpikePairs(""), ["XBTUSDTM", "ETHUSDTM", "SOLUSDTM", "GRAMUSDTM"]);
  });
  it("parses bases, dedupes, accepts BTC as XBT", () => {
    assert.deepEqual(parseSpikePairs("GRAM,SOL"), ["GRAMUSDTM", "SOLUSDTM"]);
    assert.deepEqual(parseSpikePairs("BTC,XBT"), ["XBTUSDTM"]);
  });
  it("rejects unknown bases without inventing", () => {
    assert.equal(parseSpikePairs("BONK"), null);
    assert.equal(parseSpikePairs("SOL,BONK"), null);
  });
  it("parses the alt-book campaign set", () => {
    assert.deepEqual(parseSpikePairs("SUI,DOT,DOGE,PEPE,UNI"), ["SUIUSDTM", "DOTUSDTM", "DOGEUSDTM", "PEPEUSDTM", "UNIUSDTM"]);
  });
});

describe("spikeVolTrigger", () => {
  it("is max(3xmed, p90, floor)", () => {
    const vols = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    // sorted med = 550 → 3x = 1650; p90 = 1000; floor 2500 wins
    assert.equal(spikeVolTrigger(vols, 2500), 2500);
    // big floor loses to a hot book
    const hot = [...vols, 9000, 9500];
    assert.ok(spikeVolTrigger(hot, 2500) >= 3 * 600);
    // empty baseline falls back to the floor, never 0
    assert.equal(spikeVolTrigger([], 4000), 4000);
  });
});

describe("spikeBaselineStats", () => {
  it("reports n/med/p90/max", () => {
    const st = spikeBaselineStats([10, 20, 30, 40]);
    assert.equal(st.n, 4);
    assert.equal(st.volMed, 25);
    assert.equal(st.volMax, 40);
    assert.ok(st.volP90 >= 30);
  });
});

describe("spikeThrust", () => {
  it("fires at the per-symbol threshold", () => {
    assert.equal(spikeThrust(100, 100.2, 0.1).fired, true);
    assert.equal(spikeThrust(100, 100.05, 0.1).fired, false);
    assert.equal(spikeThrust(0, 100, 0.1).fired, false);
  });
});

describe("spikeImbalance / spread", () => {
  it("signs book pressure, 0 on empty", () => {
    assert.ok(spikeImbalance(700, 300) > 0.39);
    assert.ok(spikeImbalance(300, 700) < -0.39);
    assert.equal(spikeImbalance(0, 0), 0);
  });
  it("measures spread in bps", () => {
    const bps = spikeSpreadBps(100, 100.05);
    assert.ok(bps > 4 && bps < 6);
    assert.equal(spikeSpreadBps(0, 0), 0);
  });
});

describe("spikeNotionals / spikeWall", () => {
  it("converts lots to USD notionals", () => {
    const lv = spikeNotionals([["10", "5"]], 0.1);
    assert.equal(lv[0]?.notional, 5);
  });
  it("flags a 6x level above the minimum", () => {
    const side = [
      { price: 1, notional: 100 },
      { price: 2, notional: 110 },
      { price: 3, notional: 90 },
      { price: 4, notional: 105 },
      { price: 5, notional: 20000 },
    ];
    const w = spikeWall(side, 1000);
    assert.equal(w?.price, 5);
    assert.equal(spikeWall(side.slice(0, 4), 1000), null);
    assert.equal(spikeWall(side, 999999), null);
  });
});

describe("spike config parity with the monitor", () => {
  it("keeps per-symbol floors/thrust/spread/wall", () => {
    assert.deepEqual(
      [SPIKE_SYMS.XBTUSDTM, SPIKE_SYMS.ETHUSDTM, SPIKE_SYMS.SOLUSDTM, SPIKE_SYMS.GRAMUSDTM].map((c) => c?.volFloor),
      [2500, 4000, 4000, 5000],
    );
    assert.deepEqual(
      [SPIKE_SYMS.XBTUSDTM, SPIKE_SYMS.ETHUSDTM, SPIKE_SYMS.SOLUSDTM, SPIKE_SYMS.GRAMUSDTM].map((c) => c?.thrustPct),
      [0.1, 0.1, 0.1, 0.25],
    );
    assert.equal(SPIKE_SYMS.GRAMUSDTM?.spreadBps, 10);
    assert.equal(SPIKE_SYMS.GRAMUSDTM?.wallMin, 1000);
    assert.deepEqual(
      [SPIKE_SYMS.SUIUSDTM, SPIKE_SYMS.DOTUSDTM, SPIKE_SYMS.DOGEUSDTM, SPIKE_SYMS.PEPEUSDTM, SPIKE_SYMS.UNIUSDTM].map((c) => c?.symbol),
      ["SUIUSDTM", "DOTUSDTM", "DOGEUSDTM", "PEPEUSDTM", "UNIUSDTM"],
    );
    // Multipliers are venue contract sizes (verified against /api/v1/contracts/<SYM>).
    assert.deepEqual(
      [SPIKE_SYMS.SUIUSDTM, SPIKE_SYMS.DOTUSDTM, SPIKE_SYMS.DOGEUSDTM, SPIKE_SYMS.PEPEUSDTM, SPIKE_SYMS.UNIUSDTM].map((c) => c?.mult),
      [1.0, 1.0, 100.0, 520000.0, 1.0],
    );
  });
});
