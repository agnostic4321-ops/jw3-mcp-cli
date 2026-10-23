import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dailyPrepParams, validatePropose } from "./commands/extra.js";

describe("validatePropose", () => {
  it("accepts a full ticket", () => {
    assert.equal(
      validatePropose({ pair: "BTC/USDT", side: "long", entry: 90000, stop: 88000 }),
      null,
    );
  });
  it("rejects blanks, bad sides, non-positive numbers", () => {
    assert.match(validatePropose({ pair: "", side: "long", entry: 1, stop: 1 }) as string, /pair/);
    assert.match(validatePropose({ pair: "BTC/USDT", side: "hold", entry: 1, stop: 1 }) as string, /side/);
    assert.match(validatePropose({ pair: "BTC/USDT", side: "buy", entry: 0, stop: 1 }) as string, /entry/);
    assert.match(validatePropose({ pair: "BTC/USDT", side: "buy", entry: 1, stop: -5 }) as string, /stop/);
    assert.match(
      validatePropose({ pair: "BTC/USDT", side: "buy", entry: 1, stop: 1, sizeUsd: 0 }) as string,
      /size_usd/,
    );
  });
});

describe("dailyPrepParams", () => {
  it("defaults to write with no params", () => {
    assert.deepEqual(dailyPrepParams({ dry: false }), { params: {} });
  });
  it("dry run passes write:false, day passes through", () => {
    assert.deepEqual(dailyPrepParams({ dry: true, day: "2026-09-29" }), {
      params: { write: false, day: "2026-09-29" },
    });
  });
  it("rejects malformed days", () => {
    assert.match((dailyPrepParams({ dry: false, day: "tomorrow" }) as { error: string }).error, /YYYY-MM-DD/);
  });
});
