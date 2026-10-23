/**
 * `sizing` tests — the position-sizing + leverage engine.
 *
 * Pure math only: no network, no clock, no venue. Every case is a number
 * the engine must produce, or a refusal it must refuse.
 *
 * The doctrine under test:
 *   - dollar risk is the constraint, not notional
 *   - leverage is DERIVED from the stop distance, never chosen
 *   - liquidation math is 1/lev − m (KuCoin USDT-M linear)
 *   - fee drag must stay a small fraction of the stop
 *   - lots round DOWN, never up
 *   - `amount` is BASE units: one contract = multiplier base units
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  HARD_MAX_LEVERAGE,
  KUCOIN_FUTURES_VIP0_FEES,
  OWNER_RISK_PCT_OF_EQUITY,
  TYPICAL_MAINTENANCE_MARGIN_RATE,
  baseUnitsForContracts,
  contractsForBaseUnits,
  liquidationDistanceFrac,
  liquidationPriceFor,
  leverageSafety,
  roundStopAwayFromEntry,
  sizeTrade,
  validateSizingProposal,
  widenStopForFeeDrag,
  type FeeSchedule,
  type SizingProposal,
} from "./sizing.js";

/** Taker on both legs — the pessimistic case (KuCoin futures VIP0). */
const TAKER_FEES: FeeSchedule = { makerRate: 0.0002, takerRate: 0.0006 };

const proposal = (over: Partial<SizingProposal> = {}): SizingProposal => ({
  pair: "SOL/USDT",
  side: "long",
  entryPrice: 100,
  stopPrice: 98,
  targetPrice: 104,
  contractMultiplier: 1,
  tickSize: 0.01,
  maintenanceMarginRate: DEFAULT_MAINTENANCE_MARGIN_RATE,
  venueMaxLeverage: 50,
  atrPct: 1,
  equityUsd: 1000,
  freeMarginUsd: 1000,
  feeSchedule: TAKER_FEES,
  ...over,
});

/** The decision, asserted non-null (the engine returns null only for malformed input). */
function sized(p: SizingProposal): NonNullable<ReturnType<typeof sizeTrade>> {
  const d = sizeTrade(p);
  assert.ok(d, `expected a decision, got null (validation: ${validateSizingProposal(p)})`);
  return d;
}

describe("validateSizingProposal", () => {
  it("accepts a well-formed ticket", () => {
    assert.equal(validateSizingProposal(proposal()), null);
  });
  it("rejects a stop on the wrong side of the entry", () => {
    assert.match(String(validateSizingProposal(proposal({ stopPrice: 102 }))), /BELOW/);
    assert.match(
      String(validateSizingProposal(proposal({ side: "short", stopPrice: 98, targetPrice: 96 }))),
      /ABOVE/,
    );
  });
  it("rejects a target on the wrong side, a zero stop, and a bad multiplier", () => {
    assert.match(String(validateSizingProposal(proposal({ targetPrice: 99 }))), /ABOVE/);
    assert.match(String(validateSizingProposal(proposal({ stopPrice: 100 }))), /differ/);
    assert.match(String(validateSizingProposal(proposal({ contractMultiplier: 0 }))), /multiplier/);
    assert.match(String(validateSizingProposal(proposal({ equityUsd: 0 }))), /equity/);
    assert.match(String(validateSizingProposal(proposal({ feeSchedule: undefined as never }))), /fee schedule/);
  });
});

describe("dollar risk is the constraint, not notional", () => {
  it("sizes so a stop-out costs exactly the risk budget", () => {
    // $1000 equity, 3% → $30 budget. Stop $98 vs entry $100 → $2 per base unit.
    const d = sized(proposal());
    assert.equal(d.status, "ok");
    assert.equal(d.riskBudgetUsd, 30);
    assert.equal(d.amountBaseUnits, 15);
    assert.equal(d.dollarRiskAtStopUsd, 30);
    assert.equal(d.notionalUsd, 1500);
  });

  it("derives notional from the budget and the stop distance, never the reverse", () => {
    const d = sized(proposal());
    // notional = riskBudget / stopDistanceFrac = 30 / 0.02
    assert.equal(d.notionalUsd, d.riskBudgetUsd / d.stopDistanceFrac);
  });

  it("a wider stop buys a SMALLER position at the same dollar risk", () => {
    const tight = sized(proposal({ stopPrice: 99.5 }));
    const wide = sized(proposal({ stopPrice: 95 }));
    assert.ok(wide.amountBaseUnits < tight.amountBaseUnits);
    assert.ok(Math.abs(wide.dollarRiskAtStopUsd - tight.dollarRiskAtStopUsd) < 1e-9);
  });

  it("honours the owner's 30%-of-equity doctrine when asked for it", () => {
    const d = sized(proposal({ riskPctOfEquity: OWNER_RISK_PCT_OF_EQUITY }));
    assert.equal(d.riskPctOfEquity, 30);
    assert.equal(d.riskBudgetUsd, 300);
    assert.equal(d.dollarRiskAtStopUsd, 300);
  });

  it("applies the halve rule after one full stop", () => {
    const full = sized(proposal());
    const halved = sized(proposal({ stopsToday: 1 }));
    // The halve rule applies to the RISK BUDGET, never to the notional:
    // 3% of $1000 = $30 → halved to $15. Notional is an output of the
    // budget and the stop, so halving the budget halves the exposure.
    assert.equal(halved.effectiveRiskPctOfEquity, full.effectiveRiskPctOfEquity / 2);
    assert.equal(halved.riskBudgetUsd, 15);
    // $15 at $2 per base unit = 7.5 base units → FLOORED to 7 whole lots.
    // The floor is what makes the budget a ceiling: 8 lots would risk $16,
    // more than the halved budget allows.
    assert.equal(halved.contracts, 7);
    assert.equal(halved.amountBaseUnits, 7);
    assert.equal(halved.dollarRiskAtStopUsd, 14);
    assert.ok(halved.dollarRiskAtStopUsd <= halved.riskBudgetUsd);
    assert.ok(halved.amountBaseUnits < full.amountBaseUnits);
  });

  it("warns (but still prices) after two full stops — the heat governor refuses it", () => {
    const d = sized(proposal({ stopsToday: 2 }));
    assert.ok(d.warnings.some((w) => /flat for the day/.test(w)));
  });
});

describe("leverage is DERIVED from the stop distance", () => {
  it("takes the highest leverage whose liquidation distance is ≥ 2× the stop", () => {
    // stop = 2% → 1/lev − 0.005 ≥ 2 × 0.02 = 0.04 → lev ≤ 1/0.045 = 22.2 → x22
    const d = sized(proposal({ stopPrice: 98 }));
    assert.equal(d.maxSafeLeverage, 22);
    assert.equal(d.leverage, 22);
    assert.ok(d.liquidationSafetyMultiple >= 2);
  });

  it("a WIDER stop means LOWER leverage, automatically", () => {
    const narrow = sized(proposal({ stopPrice: 99.5 })); // 0.5% stop
    const medium = sized(proposal({ stopPrice: 98 })); // 2% stop
    const wide = sized(proposal({ stopPrice: 95 })); // 5% stop
    assert.ok(narrow.leverage > medium.leverage);
    assert.ok(medium.leverage > wide.leverage);
    assert.ok(narrow.leverage > wide.leverage);
  });

  it("caps the derived leverage at the venue's per-contract max", () => {
    // A 0.5% stop implies a very high safe leverage; the venue says 10.
    const d = sized(proposal({ stopPrice: 99.5, venueMaxLeverage: 10 }));
    assert.ok(d.maxSafeLeverage > 10);
    assert.equal(d.leverage, 10);
    assert.equal(d.venueMaxLeverage, 10);
  });

  it("caps the derived leverage at the hard ceiling of 50", () => {
    // A 0.2% stop implies ~250x safe; the hard ceiling is 50.
    const d = sized(proposal({ stopPrice: 99.8 }));
    assert.ok(d.maxSafeLeverage > HARD_MAX_LEVERAGE);
    assert.equal(d.leverage, HARD_MAX_LEVERAGE);
    assert.equal(d.leverageCeiling, 50);
  });

  it("reports the venue cap as UNKNOWN rather than guessing one", () => {
    const d = sized(proposal({ venueMaxLeverage: null }));
    assert.equal(d.venueMaxLeverage, null);
    assert.ok(d.warnings.some((w) => /max leverage unknown/.test(w)));
  });

  it("a 50x ticket on a 2% stop is UNSAFE and says so", () => {
    // The headline safety check: at x50 the liquidation distance is
    // 1/50 − 0.005 = 1.5%, which is INSIDE a 2% stop — the venue liquidates
    // you before your stop fills.
    const safety = leverageSafety({
      leverage: 50,
      stopDistanceFrac: 0.02,
      maintenanceMarginRate: DEFAULT_MAINTENANCE_MARGIN_RATE,
      minLiquidationMultiple: 2,
      entryPrice: 100,
      side: "long",
    });
    assert.equal(safety.safe, false);
    assert.equal(safety.liqBeforeStop, true);
    assert.ok(safety.liquidationDistanceFrac < 0.02);
    assert.match(String(safety.reason), /BEFORE the/);
    // And the engine never derives x50 for that stop.
    const d = sized(proposal({ stopPrice: 98 }));
    assert.ok(d.leverage < 50);
    assert.equal(d.liqBeforeStop, false);
  });

  it("a 2% adverse move at x50 is flagged unsafe", () => {
    // 50x with m = 0.5%: the liquidation price sits 1.5% away. A 2% adverse
    // move wipes the position through LIQUIDATION, not through the stop —
    // the venue takes the whole margin before the stop order can fill.
    const atFifty = leverageSafety({
      leverage: 50,
      stopDistanceFrac: 0.02,
      maintenanceMarginRate: DEFAULT_MAINTENANCE_MARGIN_RATE,
      minLiquidationMultiple: 2,
      entryPrice: 100,
      side: "long",
    });
    assert.equal(atFifty.safe, false);
    assert.equal(atFifty.liqBeforeStop, true);
    // A 2% adverse move is beyond the 1.5% liquidation distance at x50.
    assert.ok(0.02 > atFifty.liquidationDistanceFrac);
    assert.equal(atFifty.liquidationPrice, 98.5);
    // The liquidation price is INSIDE the 2% stop (98) → the stop never
    // gets filled; the venue liquidates first.
    assert.ok((atFifty.liquidationPrice as number) > 98);

    // And the engine never derives x50 for that stop: it drops to x22, whose
    // liquidation price sits BELOW the stop so the stop fills first.
    const d = sized(proposal({ stopPrice: 98 }));
    assert.ok(d.leverage <= 22);
    assert.equal(d.liqBeforeStop, false);
    assert.ok(d.liquidationPrice < d.stopPrice, "liquidation must sit below the stop for a long");
    assert.ok(d.liquidationSafetyMultiple >= 2);
  });
});

describe("liquidation math (KuCoin USDT-M linear)", () => {
  it("liquidates at 1/lev − m", () => {
    assert.equal(liquidationDistanceFrac(50, 0.005), 0.015);
    assert.equal(liquidationDistanceFrac(20, 0.007), 0.043);
    assert.equal(liquidationDistanceFrac(10, 0.005), 0.095);
  });

  it("puts the long's liquidation price below the entry and the short's above", () => {
    const long = liquidationPriceFor(100, "long", 20, 0.005);
    const short = liquidationPriceFor(100, "short", 20, 0.005);
    assert.equal(long, 95.5);
    assert.equal(short, 104.5);
  });

  it("uses the contract's own maintenance margin rate, not a hardcoded one", () => {
    const low = sized(proposal({ maintenanceMarginRate: DEFAULT_MAINTENANCE_MARGIN_RATE }));
    const high = sized(proposal({ maintenanceMarginRate: TYPICAL_MAINTENANCE_MARGIN_RATE }));
    assert.equal(low.maintenanceMarginRate, 0.005);
    assert.equal(high.maintenanceMarginRate, 0.007);
    // A higher maintenance rate eats the buffer → less leverage.
    assert.ok(high.leverage < low.leverage);
    assert.equal(high.maxSafeLeverage, Math.floor(1 / (2 * 0.02 + 0.007)));
  });

  it("the derived leverage always leaves ≥ the required liquidation buffer", () => {
    for (const stop of [99.5, 99, 98, 96, 92, 88]) {
      const d = sized(proposal({ stopPrice: stop }));
      assert.ok(
        d.liquidationSafetyMultiple >= 2,
        `stop ${stop} left only ${d.liquidationSafetyMultiple.toFixed(3)}x buffer`,
      );
      assert.equal(d.liqBeforeStop, false);
    }
  });
});

describe("fee drag", () => {
  it("prices the round-trip fee on notional and reports it as a fraction of the stop", () => {
    // 0.06% taker × 2 legs = 0.12% of notional. Stop = 2% → drag = 6%.
    const d = sized(proposal({ stopPrice: 98 }));
    assert.equal(d.feeRateRoundTrip, 0.0012);
    assert.ok(Math.abs(d.feeDragFracOfStop - 0.06) < 1e-9);
    assert.equal(d.feeAction, "none");
    assert.ok(Math.abs(d.feeRoundTripUsd - 1500 * 0.0012) < 1e-9);
  });

  it("flags a trade whose fees exceed 1/3 of the stop distance", () => {
    // A 0.2% stop with a 0.12% round trip = 60% drag — the fee eats the
    // trade. The engine's answer is to WIDEN the stop until the drag
    // fits (0.36% stop → drag exactly at the 1/3 ceiling), because a
    // wider stop is still a trade while a refusal is not.
    const d = sized(proposal({ stopPrice: 99.8 }));
    assert.equal(d.feeAction, "widen-stop");
    assert.equal(d.status, "ok");
    assert.equal(d.stopWidened, true);
    // The widened stop is what makes the drag fit.
    assert.ok(d.stopPrice < d.originalStopPrice, "a long's widened stop moves DOWN");
    assert.ok(d.feeDragFracOfStop <= 1 / 3);
    assert.equal(d.widenedStopPrice, d.stopPrice);
  });

  it("refuses a fee-loaded stop that cannot be widened into survivability", () => {
    // A 0.1% stop with ATR 0.1%: the fee needs a 0.36% stop = 3.6× ATR,
    // past the 3× ATR cap — the thesis cannot absorb that much room, so
    // the engine refuses instead of inventing a wider stop.
    const d = sized(proposal({ stopPrice: 99.9, atrPct: 0.1 }));
    assert.equal(d.status, "unfundable");
    assert.equal(d.feeAction, "unfundable");
    assert.ok(d.feeDragFracOfStop > 1 / 3);
    assert.match(String(d.reason), /fee drag/);
    assert.match(String(d.reason), /Unfundable/);
  });

  it("WIDENS the stop when the widened stop still fits inside the ATR cap", () => {
    // 0.5% stop, ATR 1% → widening to ~0.36% is impossible (needs MORE);
    // a 0.1% stop needs a 0.36% stop, which is 0.36× ATR — fits under 3× ATR.
    const d = sized(proposal({ stopPrice: 99.9, atrPct: 1 }));
    assert.equal(d.status, "ok");
    assert.equal(d.feeAction, "widen-stop");
    assert.equal(d.stopWidened, true);
    assert.ok(d.stopPrice < d.originalStopPrice, "a long's widened stop moves DOWN");
    assert.ok(d.feeDragFracOfStop <= 1 / 3);
    assert.equal(d.widenedStopPrice, d.stopPrice);
    assert.ok(d.widenedStopDistanceFrac != null);
  });

  it("refuses to widen past the ATR cap and reports WHY", () => {
    // A 0.1% stop with ATR 0.1% → the fee needs a 0.36% stop = 3.6× ATR.
    const d = sized(proposal({ stopPrice: 99.9, atrPct: 0.1 }));
    assert.equal(d.status, "unfundable");
    assert.equal(d.feeAction, "unfundable");
    assert.match(String(d.reason), /ATR/);
  });

  it("says which way it went and why — widen or unfundable, never silence", () => {
    // A fee drag that can be fixed by widening the stop IS widened — that
    // is the better outcome, not a refusal. Only a stop the ATR cap
    // forbids widening past comes back "unfundable", and it must say so.
    const widened = sized(proposal({ stopPrice: 99.9, atrPct: 1 }));
    assert.equal(widened.feeAction, "widen-stop");
    assert.match(String(widened.widenedStopPrice), /^\d/);
    // The widened stop must actually clear the fee-drag ceiling.
    assert.ok(widened.feeDragFracOfStop <= 1 / 3);
    // A stop wide enough to carry the fees needs no widening at all.
    const clean = sized(proposal({ stopPrice: 99.5, atrPct: 1 }));
    assert.equal(clean.feeAction, "none");

    // Unfundable: the fee needs a 0.36% stop but the ATR cap allows only
    // 0.3× (3× of a 0.1% ATR) — the thesis cannot absorb that much room.
    const refused = sized(proposal({ stopPrice: 99.9, atrPct: 0.1 }));
    assert.equal(refused.feeAction, "unfundable");
    assert.match(String(refused.reason), /fee drag/);
    assert.match(String(refused.reason), /ATR/);
  });

  it("a COARSE tick can never cause a fee-drag refusal — it makes the drag smaller", () => {
    // The stop is rounded AWAY from the entry, so a coarse tick pushes the
    // stop FURTHER out — which makes the fee drag SMALLER, not larger.
    // The drag therefore falls monotonically as the tick coarsens, and
    // there is no tick at which the widening becomes impossible.
    const drags = [0.01, 0.1, 1, 10].map((tick) =>
      sized(proposal({ stopPrice: 99.9, atrPct: 1, tickSize: tick })).feeDragFracOfStop,
    );
    for (let i = 1; i < drags.length; i++) {
      assert.ok(
        (drags[i] as number) <= (drags[i - 1] as number),
        `drag must not grow with a coarser tick: ${drags.join(", ")}`,
      );
    }
    // The coarsest tick leaves a stop far outside the fee's reach.
    const coarse = sized(proposal({ stopPrice: 99.9, atrPct: 1, tickSize: 1 }));
    assert.equal(coarse.feeAction, "none");
    assert.ok(coarse.feeDragFracOfStop < 1 / 3);
  });

  it("keeps the widened drag strictly under the cap (tick quantization)", () => {
    const w = widenStopForFeeDrag({
      entryPrice: 100,
      side: "long",
      tick: 0.01,
      feeRate: 0.0012,
      maxFeeDrag: 1 / 3,
    });
    assert.ok(w);
    assert.ok(0.0012 / w.stopDistanceFrac <= 1 / 3);
  });
});

describe("contract rounding — lots round DOWN, never up", () => {
  it("floors to whole lots", () => {
    assert.equal(contractsForBaseUnits(15.9, 1), 15);
    assert.equal(contractsForBaseUnits(1199, 100), 11);
    assert.equal(contractsForBaseUnits(1200, 100), 12);
    assert.equal(contractsForBaseUnits(0.5, 1), 0);
  });

  it("never risks more than the budget after flooring", () => {
    // 3% of $1000 = $30; at $2 per base unit that is 15.9 base units →
    // 15 lots → $30 exactly, never 16.
    const d = sized(proposal({ contractMultiplier: 1 }));
    assert.equal(d.contracts, 15);
    assert.ok(d.dollarRiskAtStopUsd <= d.riskBudgetUsd + 1e-9);
  });

  it("refuses a size below one lot, with a clear reason", () => {
    // A 0.5% stop on a multiplier-100 contract with a $30 budget:
    // 30 / 0.5 = 60 base units < 100 (one lot) → refuse.
    const d = sized(
      proposal({ stopPrice: 99.5, contractMultiplier: 100, tickSize: 0.01, equityUsd: 1000 }),
    );
    assert.equal(d.status, "unfundable");
    assert.equal(d.contracts, 0);
    assert.equal(d.amountBaseUnits, 0);
    assert.match(String(d.reason), /less than ONE contract/);
    assert.match(String(d.reason), /Refusing to round up/);
  });

  it("rounds the stop away from the entry, never toward it", () => {
    // 98.005 with a 0.01 tick → 98.00 for a long (further away).
    assert.equal(roundStopAwayFromEntry(98.005, 100, "long", 0.01), 98);
    assert.equal(roundStopAwayFromEntry(98.005, 100, "short", 0.01), 98.01);
    assert.equal(roundStopAwayFromEntry(102, 100, "short", 0.01), 102);
  });
});

describe("THE UNIT TRAP — amount is BASE units", () => {
  it("12 contracts on a multiplier-100 contract is 1200 base units", () => {
    assert.equal(baseUnitsForContracts(12, 100), 1200);
    assert.equal(contractsForBaseUnits(1200, 100), 12);
    // The two are consistent in both directions.
    assert.equal(baseUnitsForContracts(contractsForBaseUnits(1200, 100), 100), 1200);
  });

  it("the payload carries both sides of the trap, consistently", () => {
    // IRYS-shaped: multiplier 100, entry 0.0129, stop 0.0128 (≈0.78% away).
    const d = sized(
      proposal({
        pair: "IRYS/USDT",
        entryPrice: 0.0129,
        stopPrice: 0.0128,
        targetPrice: 0.0131,
        contractMultiplier: 100,
        tickSize: 0.0001,
        equityUsd: 1000,
        venueMaxLeverage: 20,
      }),
    );
    assert.equal(d.status, "ok");
    assert.equal(d.amountBaseUnits, d.contracts * d.contractMultiplier);
    assert.equal(d.amountBaseUnits, d.contracts * 100);
    // The field names say what they are: base units vs lots.
    assert.equal(typeof d.amountBaseUnits, "number");
    assert.equal(typeof d.contracts, "number");
    assert.notEqual(d.amountBaseUnits, d.contracts);
  });

  it("rounds the base-unit size down to whole lots on a multiplier-100 contract", () => {
    const d = sized(
      proposal({
        entryPrice: 0.0129,
        stopPrice: 0.0128,
        targetPrice: 0.0131,
        contractMultiplier: 100,
        tickSize: 0.0001,
        equityUsd: 1000,
      }),
    );
    // 30 USD budget / 0.0001 per base unit = 300000 base units → 3000 lots.
    assert.equal(d.amountBaseUnits, 300000);
    assert.equal(d.contracts, 3000);
    assert.equal(d.amountBaseUnits / d.contractMultiplier, d.contracts);
  });
});

describe("margin + R multiple + payload", () => {
  it("reports the margin required at the derived leverage", () => {
    const d = sized(proposal({ stopPrice: 98 }));
    assert.equal(d.leverage, 22);
    assert.ok(Math.abs(d.marginRequiredUsd - d.notionalUsd / d.leverage) < 1e-9);
    assert.equal(d.marginSufficient, true);
  });

  it("refuses when the margin exceeds free margin", () => {
    const d = sized(proposal({ stopPrice: 98, freeMarginUsd: 5 }));
    assert.equal(d.status, "unfundable");
    assert.equal(d.marginSufficient, false);
    assert.match(String(d.reason), /exceeds free margin/);
  });

  it("computes the R multiple from the stop to the target", () => {
    const d = sized(proposal({ stopPrice: 98, targetPrice: 104 }));
    assert.equal(d.rMultiple, 2);
    const short = sized(proposal({ side: "short", stopPrice: 102, targetPrice: 96 }));
    assert.equal(short.rMultiple, 2);
  });

  it("has no R multiple without a target", () => {
    const d = sized(proposal({ targetPrice: null }));
    assert.equal(d.rMultiple, null);
  });

  it("returns the venue side and the full payload shape", () => {
    const d = sized(proposal({ side: "short", stopPrice: 102, targetPrice: 96 }));
    assert.equal(d.venueSide, "sell");
    assert.equal(d.pair, "SOL/USDT");
    assert.equal(d.status, "ok");
    assert.equal(d.reason, null);
    // Every field the caller needs is present and typed.
    for (const key of [
      "amountBaseUnits",
      "contracts",
      "leverage",
      "marginRequiredUsd",
      "dollarRiskAtStopUsd",
      "rMultiple",
      "feeDragFracOfStop",
      "liquidationDistanceFrac",
      "liquidationPrice",
      "riskBudgetUsd",
      "notionalUsd",
      "maxSafeLeverage",
    ] as const) {
      assert.ok(key in d, `missing field ${key}`);
    }
  });

  it("refuses a malformed proposal with the validator's reason rather than inventing numbers", () => {
    // A malformed proposal must NEVER produce numbers. But it must also
    // not be a SILENT null: a refusal that hides its cause is
    // indistinguishable from a bug, and the operator cannot act on it.
    // So the refusal travels WITH the reason.
    const badPrice = sizeTrade(proposal({ entryPrice: 0 }));
    assert.ok(badPrice, "a malformed proposal produced no decision at all");
    assert.equal(badPrice?.status, "invalid");
    assert.match(String(badPrice?.reason), /entry price must be > 0/);
    // And it invents no numbers: zero size, zero notional.
    assert.equal(badPrice?.contracts, 0);
    assert.equal(badPrice?.notionalUsd, 0);
    assert.equal(badPrice?.amountBaseUnits, 0);

    const badSide = sizeTrade(proposal({ side: "flat" as never }));
    assert.equal(badSide?.status, "invalid");
    assert.match(String(badSide?.reason), /side must be long\|short/);
  });

  it("uses the KuCoin VIP0 fee schedule when the caller passes it verbatim", () => {
    const d = sized(proposal({ feeSchedule: KUCOIN_FUTURES_VIP0_FEES }));
    assert.equal(d.feeRateRoundTrip, 0.0012);
  });
});

describe("notional cap (the server's max_position_usd) clamps, it never vetoes", () => {
  it("shrinks the risk-derived size to the cap and says it did", () => {
    // A $30 risk budget at a 2% stop wants $1500 of notional; the server
    // caps the position at $1000. The exposure ceiling wins and the
    // trade is resized, not rejected.
    const d = sized(proposal({ maxNotionalUsd: 1000 }));
    assert.equal(d.status, "ok");
    assert.equal(d.notionalClamped, true);
    assert.equal(d.notionalCapUsd, 1000);
    assert.equal(d.notionalUsd, 1000);
    assert.equal(d.amountBaseUnits, 10);
    // The risk falls with the size — the stop distance did not change.
    assert.equal(d.dollarRiskAtStopUsd, 20);
    assert.ok(d.dollarRiskAtStopUsd < d.riskBudgetUsd);
  });

  it("leaves the size alone when the risk-derived notional fits under the cap", () => {
    const d = sized(proposal({ maxNotionalUsd: 5000 }));
    assert.equal(d.notionalClamped, false);
    assert.equal(d.notionalUsd, 1500);
    assert.equal(d.dollarRiskAtStopUsd, 30);
  });

  it("scales the cap by the tier so a HALF tier still halves the exposure", () => {
    const full = sized(proposal({ maxNotionalUsd: 1000 }));
    const half = sized(proposal({ maxNotionalUsd: 1000, tierMultiplier: 0.5 }));
    const probe = sized(proposal({ maxNotionalUsd: 1000, tierMultiplier: 0.25 }));
    assert.equal(full.notionalUsd, 1000);
    assert.equal(half.notionalUsd, 500);
    assert.equal(probe.notionalUsd, 200);
    assert.ok(probe.amountBaseUnits < half.amountBaseUnits);
    assert.ok(half.amountBaseUnits < full.amountBaseUnits);
  });

  it("refuses a cap smaller than one lot, with a clear reason", () => {
    const d = sized(proposal({ maxNotionalUsd: 5 }));
    assert.equal(d.status, "unfundable");
    assert.equal(d.contracts, 0);
    assert.match(String(d.reason), /less than one contract/);
  });
});
