import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickConnection } from "./commands/market.js";
import {
  extractOpenOrders,
  loopKillReason,
  normalizeRiskLimits,
  selectCancelTargets,
  validateCancelAll,
  validateExecute,
} from "./commands/trade.js";

describe("pickConnection", () => {
  const rows = [
    { id: "a", exchange: "kucoin", markets: "spot" },
    { id: "b", exchange: "kucoin", markets: "both" },
    { id: "c", exchange: "binance", markets: "spot" },
  ];
  it("prefers a futures-covering row when asked", () => {
    assert.equal(pickConnection(rows, "kucoin", true)?.id, "b");
    assert.equal(pickConnection(rows, "kucoin", false)?.id, "a");
  });
  it("matches case-insensitively, null when absent", () => {
    assert.equal(pickConnection(rows, "KuCoin", true)?.id, "b");
    assert.equal(pickConnection(rows, "kraken"), null);
    assert.equal(pickConnection([], "kucoin")?.id ?? null, null);
  });
});

describe("validateExecute", () => {
  it("accepts amount and risk-usd sizings", () => {
    assert.equal(
      validateExecute({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 }),
      null,
    );
    assert.equal(
      validateExecute({ exchange: "kucoin", pair: "BTC/USDT", side: "sell", riskUsd: 50, stop: 88000 }),
      null,
    );
  });
  it("rejects missing sides, double sizing, no sizing, bad enums", () => {
    const base = { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 };
    assert.match(validateExecute({ ...base, side: "hold" }) as string, /side/);
    assert.match(validateExecute({ ...base, riskUsd: 10 }) as string, /not both/);
    assert.match(validateExecute({ exchange: "kucoin", pair: "BTC/USDT", side: "buy" }) as string, /amount.*risk-usd/);
    assert.match(validateExecute({ ...base, amount: 0 }) as string, /amount/);
    assert.match(validateExecute({ ...base, market: "options" }) as string, /market/);
    assert.match(validateExecute({ ...base, marginMode: "shared" }) as string, /margin-mode/);
  });
  it("accepts tp and rejects non-positive tp", () => {
    const base = { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 };
    assert.equal(validateExecute({ ...base, tp: 95000 }), null);
    assert.match(validateExecute({ ...base, tp: 0 }) as string, /tp/);
    assert.match(validateExecute({ ...base, tp: -5 }) as string, /tp/);
  });
  it("actor mirrors the server enum (machine|owner), omitted stays omitted", () => {
    const base = { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 };
    assert.equal(validateExecute({ ...base }), null);
    assert.equal(validateExecute({ ...base, actor: "machine" }), null);
    assert.equal(validateExecute({ ...base, actor: "Owner" }), null);
    assert.match(validateExecute({ ...base, actor: "bot" }) as string, /actor must be machine\|owner/);
  });
});

describe("validateCancelAll", () => {
  it("accepts a pair-scoped ticket", () => {
    assert.equal(validateCancelAll({ exchange: "kucoin", pair: "BTC/USDT" }), null);
    assert.equal(validateCancelAll({ exchange: "kucoin", pair: "BTC/USDT", market: "futures" }), null);
  });
  it("never runs book-wide: pair with a slash is required", () => {
    assert.match(validateCancelAll({ exchange: "kucoin", pair: "" }) as string, /pair/);
    assert.match(validateCancelAll({ exchange: "kucoin", pair: "BTC" }) as string, /pair/);
    assert.match(validateCancelAll({ exchange: "", pair: "BTC/USDT" }) as string, /exchange/);
    assert.match(validateCancelAll({ exchange: "kucoin", pair: "BTC/USDT", market: "options" }) as string, /market/);
  });
});

describe("extractOpenOrders", () => {
  const rows = [{ orderId: "a" }, { orderId: "b" }];
  it("takes the bare cex-proxy array as-is", () => {
    assert.deepEqual(extractOpenOrders(rows), rows);
  });
  it("unwraps orders/openOrders/result envelopes", () => {
    assert.deepEqual(extractOpenOrders({ orders: rows }), rows);
    assert.deepEqual(extractOpenOrders({ openOrders: rows }), rows);
    assert.deepEqual(extractOpenOrders({ result: rows }), rows);
  });
  it("degrades to [] on garbage, never to a phantom cancel", () => {
    assert.deepEqual(extractOpenOrders(null), []);
    assert.deepEqual(extractOpenOrders({ orders: "nope" }), []);
    assert.deepEqual(extractOpenOrders({}), []);
  });
});

describe("selectCancelTargets", () => {
  const book = [
    { orderId: "1", symbol: "BTC/USDT" },
    { orderId: "2", symbol: "BTCUSDT" },
    { orderId: "3", symbol: "ETH/USDT" },
    { orderId: "", symbol: "BTC/USDT" },
    { symbol: "BTC/USDT" },
  ];
  it("keeps this pair across separator variants, drops the rest", () => {
    assert.deepEqual(selectCancelTargets(book, "BTC/USDT"), [
      { orderId: "1", symbol: "BTC/USDT" },
      { orderId: "2", symbol: "BTCUSDT" },
    ]);
  });
  it("accepts id/ordId rows and keeps symbol-less rows the server scoped", () => {
    assert.deepEqual(selectCancelTargets([{ id: "9" }, { ordId: "8", symbol: "BTC/USDT" }], "BTC/USDT"), [
      { orderId: "9", symbol: "" },
      { orderId: "8", symbol: "BTC/USDT" },
    ]);
  });
});

describe("normalizeRiskLimits + loopKillReason", () => {
  it("reads the {risk_limits} envelope in snake case", () => {
    const r = normalizeRiskLimits({
      risk_limits: {
        kill_switch_enabled: false,
        circuit_breaker_tripped_at: null,
        autonomy_level: "yolo",
        daily_realized_loss_usd: 10,
        max_daily_loss_usd: 100,
        daily_trade_count: 1,
        max_trades_per_day: 10,
      },
    });
    assert.equal(r.killSwitch, false);
    assert.equal(r.breakerTripped, false);
    assert.equal(r.autonomy, "yolo");
    assert.equal(loopKillReason(r), null);
  });
  it("reads a bare camelCase row too", () => {
    const r = normalizeRiskLimits({ killSwitchEnabled: true, autonomyLevel: "propose_only" });
    assert.equal(r.killSwitch, true);
    assert.equal(loopKillReason(r), "kill switch engaged");
  });
  it("halts on breaker, loss cap, and trade cap — in that priority", () => {
    assert.match(
      loopKillReason({ killSwitch: false, breakerTripped: true, autonomy: null, dailyLoss: 200, maxDailyLoss: 100, tradesToday: 99, maxTrades: 10 }) as string,
      /breaker/,
    );
    assert.match(
      loopKillReason({ killSwitch: false, breakerTripped: false, autonomy: null, dailyLoss: 100, maxDailyLoss: 100, tradesToday: 0, maxTrades: 10 }) as string,
      /daily loss/,
    );
    assert.match(
      loopKillReason({ killSwitch: false, breakerTripped: false, autonomy: null, dailyLoss: 0, maxDailyLoss: 100, tradesToday: 10, maxTrades: 10 }) as string,
      /max trades/,
    );
  });
  it("unknown stays clear: missing caps never read as hit", () => {
    const r = normalizeRiskLimits({ note: "no row — defaults apply" });
    assert.equal(r.killSwitch, null);
    assert.equal(loopKillReason(r), null);
    assert.equal(loopKillReason({ killSwitch: null, breakerTripped: null, autonomy: null, dailyLoss: null, maxDailyLoss: null, tradesToday: null, maxTrades: null }), null);
  });
});
