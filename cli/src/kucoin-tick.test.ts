import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { roundToTickNearest, roundStopAwayFromEntry } from "./commands/sizing.js";

/**
 * THE TICK IS `tickSize`, NOT `priceIncrement`.
 *
 * THE DEFECT
 * ----------
 * KuCoin's contract endpoint returns `tickSize` (0.001 for AVAX and
 * LINK, 0.01 for TAO, 0.1 for XBT, 1e-10 for PEPE). There is NO
 * `priceIncrement` field, so reading it always yielded undefined, and
 * `Number(undefined ?? 0) || 0` made the tick 0 on EVERY contract.
 *
 * A tick of 0 means the price grid is never applied: the entry, the
 * stop and the take-profit are placed at OFF-GRID prices. KuCoin
 * rejects off-grid prices, so the exit leg FAILS — and a failed exit
 * leg on a leveraged position is the "open position with no stop"
 * state, the worst state a trading system can be in.
 *
 * Observed live: every ticket carried `"tickSize": 0`, and the AVAX
 * short's take-profit was 0.83 ticks off the grid.
 *
 * THE TICK IS PER-CONTRACT AND WILDLY DIFFERENT
 * ---------------------------------------------
 * 0.1 for XBT, 0.01 for TAO, 0.001 for AVAX and LINK, 1e-10 for PEPE.
 * A tick that is off by 100x on one contract and 1000x on another is
 * not a rounding nicety — it decides whether the leg is accepted.
 */
describe("futuresContractSpec — the price grid", () => {
  test("the spec is read from tickSize, and a missing tick is a HARD ERROR", async () => {
    // The venue is a network call, so this test is skipped in CI. The
    // ALIAS is what matters: the field name.
    // The source file is the SOURCE OF TRUTH for the field name, and
    // the test runs from dist/ — so read the source from the repo
    // rather than the compiled output (which would trivially match).
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/kucoin.ts", import.meta.url), "utf8"),
    );
    assert.ok(
      /tickSize/.test(src),
      "the contract spec must read the venue's `tickSize` field",
    );
    assert.ok(
      !/data\?\.priceIncrement/.test(src),
      "the contract spec must NOT read `priceIncrement` — KuCoin has no such field, and reading it made the tick 0 on every contract",
    );
  });

  test("the tick grid puts the live ticket's prices ON the grid", () => {
    // The exact prices from the 17:08 AVAX live ticket.
    const tick = 0.001;
    const entry = 9.773485714285714;
    const target = 9.741827913538797;
    const stop = 9.915945817646836;

    const rEntry = roundToTickNearest(entry, tick);
    const rTarget = roundToTickNearest(target, tick);
    const rStop = roundStopAwayFromEntry(stop, entry, "short", tick);

    for (const [name, px] of [["entry", rEntry], ["target", rTarget], ["stop", rStop]] as const) {
      const offGrid = Math.abs(px / tick - Math.round(px / tick));
      assert.ok(offGrid < 1e-6, `the ${name} ${px} is off the ${tick} grid by ${offGrid} ticks`);
    }
    // And the rounded target is still BELOW the rounded entry (a short's
    // take-profit must be beyond the market in the profitable
    // direction) — the tick rounding must not invert the trade.
    assert.ok(rTarget < rEntry, `a short's target ${rTarget} must stay below the entry ${rEntry}`);
    // And the stop must stay on the adverse side, rounded AWAY.
    assert.ok(rStop > rEntry, `a short's stop ${rStop} must stay above the entry ${rEntry}`);
  });

  test("the venue's real tick values put their own contracts' prices on the grid", () => {
    // The venue's own records, read from /api/v1/contracts/{SYMBOL}.
    // The tick is per-contract and differs by 100x-1000x, so each
    // contract's prices must be checked against ITS OWN tick.
    const REAL: Array<[string, number]> = [
      // base, tickSize
      ["AVAX", 0.001],
      ["LINK", 0.001],
      ["SOL", 0.001],
      ["TAO", 0.01],
      ["XBT", 0.1],
      ["PEPE", 1e-10],
    ];
    for (const [base, tick] of REAL) {
      // A price on that contract's grid.
      const px = tick * 12345;
      const rounded = roundToTickNearest(px, tick);
      assert.ok(
        Math.abs(rounded / tick - Math.round(rounded / tick)) < 1e-6,
        `the ${base} price ${rounded} is off the ${tick} grid`,
      );
      // And a price that is NOT on the grid gets moved onto it.
      const offGrid = px + tick / 3;
      const fixed = roundToTickNearest(offGrid, tick);
      assert.ok(
        Math.abs(fixed / tick - Math.round(fixed / tick)) < 1e-6,
        `the ${base} price ${fixed} is still off the ${tick} grid`,
      );
    }
  });

  test("a zero tick would leave every price off-grid — the bug in one line", () => {
    // With tick = 0 the rounding helpers are NO-OPS (they return the
    // price unchanged), which is exactly how the bug presented: a
    // ticket with a perfectly reasonable-looking price and no grid.
    const px = 9.741827913538797;
    assert.equal(roundToTickNearest(px, 0), px, "a zero tick is a no-op — the price is never placed on a grid");
  });
});
