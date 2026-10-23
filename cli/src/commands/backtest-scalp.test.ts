import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scalpFeeForFlag, scalpSymbolForPair } from "./backtest-scalp.js";

describe("scalpSymbolForPair", () => {
  it("maps pairs to futures symbols, BTC aliases XBT", () => {
    assert.equal(scalpSymbolForPair("SOL/USDT"), "SOLUSDTM");
    assert.equal(scalpSymbolForPair("sol/usdt"), "SOLUSDTM");
    assert.equal(scalpSymbolForPair("BTC/USDT"), "XBTUSDTM");
    assert.equal(scalpSymbolForPair("ETH/USDT"), "ETHUSDTM");
  });
  it("rejects non-USDT quotes and malformed pairs", () => {
    assert.equal(scalpSymbolForPair("ETH/USD"), null);
    assert.equal(scalpSymbolForPair("ETH"), null);
    assert.equal(scalpSymbolForPair(""), null);
    assert.equal(scalpSymbolForPair("ETH/USDT/PERP"), null);
  });
});

describe("scalpFeeForFlag", () => {
  it("maps maker|taker to per-side pct, defaulting to taker", () => {
    assert.equal(scalpFeeForFlag("maker"), 0.02);
    assert.equal(scalpFeeForFlag("taker"), 0.06);
    assert.equal(scalpFeeForFlag(undefined), 0.06);
    assert.equal(scalpFeeForFlag("MAKER"), 0.02);
  });
  it("rejects unknown fee flags", () => {
    assert.equal(scalpFeeForFlag("vip0"), null);
    assert.equal(scalpFeeForFlag(""), null);
  });
});
