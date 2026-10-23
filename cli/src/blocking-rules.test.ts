import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CPI_BLACKOUT_END_MIN,
  CPI_BLACKOUT_START_MIN,
  EXTENDED_DROP_PCT,
  BOUNCE_REQUIRED_PCT,
  BTC_FEE_VETO_ACCOUNT_USD,
  BTC_FEE_VETO_MIN_NOTIONAL_USD,
  bounceOffLowPct,
  bounceRequiredVeto,
  btcFeeVeto,
  clampShortVerdict,
  cpiBlackout,
  extendedDropVeto,
  precheck,
} from "./blocking-rules.js";

const utc = (h: number, m: number): number => Date.UTC(2026, 9, 15, h, m, 0);

describe("threshold lockstep with ~/kronos/data/blocking_rules.py", () => {
  it("thresholds match the Python pre-filters", () => {
    assert.equal(CPI_BLACKOUT_START_MIN, 11 * 60 + 30);
    assert.equal(CPI_BLACKOUT_END_MIN, 13 * 60 + 30);
    assert.equal(EXTENDED_DROP_PCT, 2.0);
    assert.equal(BOUNCE_REQUIRED_PCT, 0.4);
    assert.equal(BTC_FEE_VETO_ACCOUNT_USD, 25.0);
    assert.equal(BTC_FEE_VETO_MIN_NOTIONAL_USD, 50.0);
  });
});

describe("cpiBlackout", () => {
  it("vetoes 12:00Z, passes 10:00Z and 14:00Z", () => {
    assert.equal(cpiBlackout(utc(12, 0)), true);
    assert.equal(cpiBlackout(utc(11, 30)), true);
    assert.equal(cpiBlackout(utc(13, 29)), true);
    assert.equal(cpiBlackout(utc(10, 0)), false);
    assert.equal(cpiBlackout(utc(13, 30)), false);
    assert.equal(cpiBlackout(utc(14, 0)), false);
  });
});

describe("extendedDropVeto", () => {
  it("vetoes past -2%, passes above, ignores missing", () => {
    assert.equal(extendedDropVeto(-2.5), true);
    assert.equal(extendedDropVeto(-2.0), false);
    assert.equal(extendedDropVeto(-0.5), false);
    assert.equal(extendedDropVeto(undefined), false);
    assert.equal(extendedDropVeto(null), false);
  });
});

describe("bounceRequiredVeto", () => {
  it("shorts need +0.4% off the low; longs never vetoed", () => {
    assert.equal(bounceRequiredVeto("short", 100.0, 100.0), true);
    assert.equal(bounceRequiredVeto("short", 100.5, 100.0), false);
    assert.equal(bounceRequiredVeto("long", 100.0, 100.0), false);
    assert.equal(bounceRequiredVeto("short", undefined, 100.0), true);
  });
  it("bounceOffLowPct math", () => {
    const b = bounceOffLowPct(100.4, 100);
    assert.ok(b !== null && Math.abs(b - 0.4) < 1e-9);
    assert.equal(bounceOffLowPct(undefined, 100), null);
  });
});

describe("btcFeeVeto", () => {
  it("benches BTC small, frees ETH / big size / fee tier", () => {
    assert.equal(btcFeeVeto("BTC/USDT", { accountUsd: 10 }), true);
    assert.equal(btcFeeVeto("BTC/USDT", {}), true);
    assert.equal(btcFeeVeto("BTC/USDT", { accountUsd: 100 }), false);
    assert.equal(btcFeeVeto("BTC/USDT", { accountUsd: 10, notionalUsd: 60 }), false);
    assert.equal(btcFeeVeto("BTC/USDT", { accountUsd: 10, feeTierOk: true }), false);
    assert.equal(btcFeeVeto("ETH/USDT", { accountUsd: 10 }), false);
  });
});

describe("precheck precedence", () => {
  it("cpi > extended_drop > bounce_required > btc_fee; pass case", () => {
    const cpi = precheck({ symbol: "ETH", side: "short", dayChgPct: -5, nowMs: utc(12, 0) });
    assert.equal(cpi.rule, "cpi_blackout");
    const drop = precheck({ symbol: "ETH", side: "short", dayChgPct: -2.5, price: 100, sessionLow: 100, nowMs: utc(10, 0) });
    assert.equal(drop.rule, "extended_drop");
    const bounce = precheck({ symbol: "SOL", side: "short", dayChgPct: -0.5, price: 100, sessionLow: 100, nowMs: utc(10, 0) });
    assert.equal(bounce.rule, "bounce_required");
    const fee = precheck({ symbol: "BTC", side: "short", dayChgPct: -0.5, price: 100, sessionLow: 99, accountUsd: 10, nowMs: utc(10, 0) });
    assert.equal(fee.rule, "btc_fee");
    const ok = precheck({ symbol: "ETH", side: "short", dayChgPct: -0.5, price: 100.5, sessionLow: 100, accountUsd: 100, nowMs: utc(10, 0) });
    assert.equal(ok.vetoed, false);
  });
});

describe("precheck unevaluated", () => {
  it("zero-data stage skips data rules instead of failing closed", () => {
    const v = precheck({ symbol: "SOL", side: "short", accountUsd: 100, nowMs: utc(10, 0) });
    assert.equal(v.vetoed, false);
    assert.deepEqual(v.unevaluated, ["extended_drop", "bounce_required"]);
  });
});
describe("clampShortVerdict", () => {
  it("clamps model-short to flat on extended drop; longs pass through", () => {
    const c = clampShortVerdict("short", { dayChgPct: -3 });
    assert.equal(c.side, "flat");
    assert.equal(c.clamped, true);
    assert.equal(c.rule, "extended_drop");
    const l = clampShortVerdict("long", { dayChgPct: -3 });
    assert.equal(l.side, "long");
    assert.equal(l.clamped, false);
  });
});
