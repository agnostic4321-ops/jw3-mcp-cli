import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSweepCurrency, validateReserveSweep } from "./reserve.js";

describe("normalizeSweepCurrency", () => {
  it("uppercases and maps the futures-host XBT spelling to BTC", () => {
    assert.equal(normalizeSweepCurrency("usdt"), "USDT");
    assert.equal(normalizeSweepCurrency("XBT"), "BTC");
    assert.equal(normalizeSweepCurrency("xbt"), "BTC");
  });
});

describe("validateReserveSweep", () => {
  it("accepts the default sweep ticket", () => {
    assert.equal(validateReserveSweep({ exchange: "kucoin", keep: 10, currency: "USDT" }), null);
  });
  it("rejects non-KuCoin venues, negative keep, and unknown currencies", () => {
    assert.match(
      validateReserveSweep({ exchange: "binance", keep: 10, currency: "USDT" }) as string,
      /KuCoin-only/,
    );
    assert.match(
      validateReserveSweep({ exchange: "kucoin", keep: -1, currency: "USDT" }) as string,
      /keep/,
    );
    assert.match(
      validateReserveSweep({ exchange: "kucoin", keep: NaN, currency: "USDT" }) as string,
      /keep/,
    );
    assert.match(
      validateReserveSweep({ exchange: "kucoin", keep: 10, currency: "SOL" }) as string,
      /currency/,
    );
    assert.match(
      validateReserveSweep({ exchange: "", keep: 10, currency: "USDT" }) as string,
      /exchange/,
    );
  });
  it("accepts XBT as BTC", () => {
    assert.equal(validateReserveSweep({ exchange: "kucoin", keep: 10, currency: "XBT" }), null);
  });
});
