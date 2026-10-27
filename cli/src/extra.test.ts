import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dailyPrepParams, formatRiskState, newsParams, validateDiaryNote, validatePropose } from "./commands/extra.js";

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

describe("newsParams", () => {
  it("omits pair when absent (all three assets)", () => {
    assert.deepEqual(newsParams({}), { params: {} });
  });
  it("passes pair through for single-asset narrowing", () => {
    assert.deepEqual(newsParams({ pair: "BTC" }), { params: { pair: "BTC" } });
  });
  it("passes source/limit/window_hrs through when valid", () => {
    assert.deepEqual(
      newsParams({ source: "CoinDesk", limit: 3, windowHrs: 24 }),
      { params: { source: "CoinDesk", limit: 3, window_hrs: 24 } },
    );
  });
  it("rejects out-of-range limit and window", () => {
    assert.match((newsParams({ limit: 0 }) as { error: string }).error, /limit/);
    assert.match((newsParams({ limit: 13 }) as { error: string }).error, /limit/);
    assert.match((newsParams({ limit: 2.5 }) as { error: string }).error, /limit/);
    assert.match((newsParams({ windowHrs: 0 }) as { error: string }).error, /window-hrs/);
    assert.match((newsParams({ windowHrs: 169 }) as { error: string }).error, /window-hrs/);
    assert.match((newsParams({ windowHrs: NaN }) as { error: string }).error, /window-hrs/);
  });
});

describe("validateDiaryNote", () => {
  it("accepts a minimal body (day/mode default server-side)", () => {
    assert.equal(validateDiaryNote({ body: "held through the wick, no tilt" }), null);
  });
  it("accepts explicit day + replace mode", () => {
    assert.equal(
      validateDiaryNote({ day: "2026-10-27", body: "rewrite", mode: "replace" }),
      null,
    );
  });
  it("rejects blanks, bad days, bad modes, oversized bodies", () => {
    assert.match(validateDiaryNote({ body: "   " }) as string, /body/);
    assert.match(validateDiaryNote({ day: "tomorrow", body: "x" }) as string, /day/);
    assert.match(validateDiaryNote({ body: "x", mode: "upsert" }) as string, /mode/);
    assert.match(validateDiaryNote({ body: "x".repeat(4001) }) as string, /4000/);
  });
});

describe("formatRiskState", () => {
  it("summarizes the envelope posture, never inventing unknowns", () => {
    const line = formatRiskState({
      risk_limits: {
        kill_switch_enabled: false,
        autonomy_level: "propose_only",
        circuit_breaker_enabled: true,
        circuit_breaker_tripped_at: null,
        daily_realized_loss_usd: 12.5,
        max_daily_loss_usd: 100,
        daily_trade_count: 3,
        max_trades_per_day: 120,
        daily_notional_usd: 322.52,
        max_daily_notional_usd: 500,
        max_position_usd: 50,
        max_leverage: 5,
      },
    });
    assert.match(line, /kill_switch=false/);
    assert.match(line, /autonomy=propose_only/);
    assert.match(line, /breaker=true/);
    assert.match(line, /12\.5\/100/);
    assert.match(line, /3\/120/);
  });
  it("reads unknown fields as unknown, never as safe", () => {
    const line = formatRiskState({ risk_limits: { note: "no row — defaults apply" } });
    assert.match(line, /kill_switch=\?/);
    assert.match(line, /uncapped/);
    assert.equal(formatRiskState(null), "risk state unreadable (no row)");
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
