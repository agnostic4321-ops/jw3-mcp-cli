import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forecastSymbolForPair, parseForecastOutput } from "./forecast.js";

const good = {
  direction: "up",
  expected_move_pct: 0.42,
  last_close: 3421.1,
  pred_last_close: 3435.51,
  pred_closes: [3422.0, 3435.51],
  horizon: 2,
  lookback: 400,
  ms: 23400,
};

describe("forecastSymbolForPair", () => {
  it("maps pairs to futures symbols, BTC aliases XBT", () => {
    assert.equal(forecastSymbolForPair("ETH/USDT"), "ETHUSDTM");
    assert.equal(forecastSymbolForPair("eth/usdt"), "ETHUSDTM");
    assert.equal(forecastSymbolForPair("BTC/USDT"), "XBTUSDTM");
    assert.equal(forecastSymbolForPair("SOL/USDT"), "SOLUSDTM");
  });
  it("rejects non-USDT quotes and malformed pairs", () => {
    assert.equal(forecastSymbolForPair("ETH/USD"), null);
    assert.equal(forecastSymbolForPair("ETH"), null);
    assert.equal(forecastSymbolForPair(""), null);
    assert.equal(forecastSymbolForPair("ETH/USDT/PERP"), null);
  });
});

describe("parseForecastOutput (mocked bridge shape)", () => {
  it("accepts a well-formed bridge verdict", () => {
    assert.deepEqual(parseForecastOutput(good), good);
  });
  it("accepts down and flat directions", () => {
    assert.equal(parseForecastOutput({ ...good, direction: "down" })?.direction, "down");
    assert.equal(parseForecastOutput({ ...good, direction: "flat" })?.direction, "flat");
  });
  it("rejects unknown directions", () => {
    assert.equal(parseForecastOutput({ ...good, direction: "moon" }), null);
  });
  it("rejects non-finite or non-positive prices", () => {
    assert.equal(parseForecastOutput({ ...good, expected_move_pct: NaN }), null);
    assert.equal(parseForecastOutput({ ...good, last_close: 0 }), null);
    assert.equal(parseForecastOutput({ ...good, pred_last_close: -5 }), null);
  });
  it("rejects empty or dirty pred_closes", () => {
    assert.equal(parseForecastOutput({ ...good, pred_closes: [] }), null);
    assert.equal(parseForecastOutput({ ...good, pred_closes: [1, NaN] }), null);
    assert.equal(parseForecastOutput({ ...good, pred_closes: "up" }), null);
  });
  it("rejects missing or bad counters", () => {
    const noHorizon: Record<string, unknown> = { ...good };
    delete noHorizon["horizon"];
    assert.equal(parseForecastOutput(noHorizon), null);
    assert.equal(parseForecastOutput({ ...good, horizon: 0 }), null);
    assert.equal(parseForecastOutput({ ...good, lookback: -1 }), null);
    assert.equal(parseForecastOutput({ ...good, ms: -2 }), null);
  });
  it("rejects non-objects", () => {
    assert.equal(parseForecastOutput(null), null);
    assert.equal(parseForecastOutput("up"), null);
    assert.equal(parseForecastOutput(42), null);
  });
});
