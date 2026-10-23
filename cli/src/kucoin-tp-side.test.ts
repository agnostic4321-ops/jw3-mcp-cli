import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planScalp } from "./kucoin.js";

/**
 * THE SCRATCH ARTEFACT — the take-profit must be BEYOND the market.
 *
 * THE DEFECT
 * ----------
 * `planScalp` used to derive the take-profit from the ladder's offset
 * average entry. For a SHORT that average sits ABOVE the last price
 * (`last x (1 + d/200)`), so the target sat above the market — and a
 * buy limit above the market is MARKETABLE: it fills instantly at the
 * ask.
 *
 * The target cleared the market only if `tp > d/2`, and with
 * `tp = 0.4 x ATR` and `d = 0.9 x ATR` that is FALSE for every ATR.
 * So every short's "take-profit" was a scratch.
 *
 * MEASURED LIVE on 2026-10-21: 6 of the 8 real round trips were
 * scratches that closed in 4-7 seconds, net -$0.5708 on $0.5672 of
 * fees. And in every simulation the scratch was booked as a full
 * take-profit, which is where the 90-95% win rates came from.
 *
 * THE RULE
 * --------
 * The take-profit is measured from the MARKET, in the profitable
 * direction, so the market has to MOVE to reach it.
 */
describe("planScalp — the take-profit is beyond the market", () => {
  const atrCases = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 4.0, 8.0];
  const lastCases = [0.5, 1, 12.37, 273.71, 0.0000073];

  for (const atr of atrCases) {
    for (const last of lastCases) {
      test(`a short's take-profit is BELOW the market (ATR ${atr}%, last ${last})`, () => {
        const p = planScalp(last, atr, "short", 60, 2);
        assert.ok(p, "the plan must exist");
        assert.ok(
          p.tpPrice < last,
          `a short's take-profit ${p.tpPrice} must be BELOW the market ${last} — above it, the order is marketable and fills at the ask`,
        );
      });

      test(`a long's take-profit is ABOVE the market (ATR ${atr}%, last ${last})`, () => {
        const p = planScalp(last, atr, "long", 60, 2);
        assert.ok(p, "the plan must exist");
        assert.ok(
          p.tpPrice > last,
          `a long's take-profit ${p.tpPrice} must be ABOVE the market ${last} — below it, the order is marketable and fills at the bid`,
        );
      });
    }
  }

  test("the take-profit sits at the planned distance from the market", () => {
    const last = 100;
    const atr = 1.0;
    const p = planScalp(last, atr, "short", 60, 2);
    assert.ok(p);
    // tpPct = clamp(0.4 x ATR, 0.3, 0.5) = 0.4
    const expected = last * (1 - 0.4 / 100);
    assert.ok(Math.abs(p.tpPrice - expected) < 1e-9, `expected ${expected}, got ${p.tpPrice}`);
  });

  test("the stop is on the ADVERSE side of the market", () => {
    const last = 100;
    const p = planScalp(last, 1.0, "short", 60, 2);
    assert.ok(p);
    assert.ok(p.killPrice > last, "a short's stop must be ABOVE the market");
    const l = planScalp(last, 1.0, "long", 60, 2);
    assert.ok(l);
    assert.ok(l.killPrice < last, "a long's stop must be BELOW the market");
  });

  test("the take-profit and the stop are on OPPOSITE sides of the market", () => {
    for (const atr of atrCases) {
      const s = planScalp(100, atr, "short", 60, 2);
      const l = planScalp(100, atr, "long", 60, 2);
      assert.ok(s && l);
      assert.ok(s.tpPrice < 100 && s.killPrice > 100, `short ATR ${atr}`);
      assert.ok(l.tpPrice > 100 && l.killPrice < 100, `long ATR ${atr}`);
    }
  });
});
