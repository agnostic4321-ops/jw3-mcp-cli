import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gridOrderArgs } from "./grid.js";

describe("gridOrderArgs — machine tickets with keys", () => {
  it("seed and levels carry a key plus the machine actor; keys differ per level", () => {
    const seed = gridOrderArgs({ exchange: "kucoin", pair: "SEI/USDT", side: "buy", contracts: 5, leverage: 2 });
    assert.equal(seed.amount, "5");
    assert.equal(seed.market, "futures");
    assert.equal(seed.marginMode, "isolated");
    assert.equal(seed.actor, "machine");
    assert.equal("price" in seed, false);
    assert.match(String(seed.idempotency_key), /^jw3-grid-[0-9a-f]{8}$/);
    const l1 = gridOrderArgs({ exchange: "kucoin", pair: "SEI/USDT", side: "buy", contracts: 5, price: 0.2, leverage: 2 });
    const l2 = gridOrderArgs({ exchange: "kucoin", pair: "SEI/USDT", side: "buy", contracts: 5, price: 0.201, leverage: 2 });
    assert.equal(l1.price, "0.2");
    assert.notEqual(l1.idempotency_key, l2.idempotency_key);
    assert.notEqual(l1.idempotency_key, seed.idempotency_key);
    // Same level retried reproduces the same key instead of stacking a ladder.
    assert.equal(
      gridOrderArgs({ exchange: "kucoin", pair: "SEI/USDT", side: "buy", contracts: 5, price: 0.2, leverage: 2 }).idempotency_key,
      l1.idempotency_key,
    );
  });
});
