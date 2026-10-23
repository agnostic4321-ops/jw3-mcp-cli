/**
 * THE TICKET — the two geometries, and why they differ.
 *
 * ══ THE LIVE PATH'S GEOMETRY (src/kucoin.ts, planScalp) ══
 *
 *   planScalp(last, atrPct, side, sizeUsd, 2)  →  TWO ladder steps:
 *
 *     step 1: price = last,                    size 1x
 *     step 2: price = last*(1 + dirSign*stepDropPct/100), size 1x
 *
 *     avgEntry = the size-weighted mean of the ladder's entries
 *     tpPrice  = avgEntry * (1 + tpDir*tpPct/100)
 *     killPrice= last * (1 + dirSign*(steps*stepDropPct)/100)
 *
 *   The exit legs are then ARMED with referencePrice = sizing.entryPrice
 *   (= avgEntry), and the venue REBASES them onto the actual fill,
 *   keeping each leg's DISTANCE from that reference.
 *
 * ══ THE CONSEQUENCE — TWO DIFFERENT TICKETS ══
 *
 *   A. THE RESEARCH TICKET (what live-gate-ev.mjs and this project's
 *      earlier studies resolve): the TP and the stop are anchored on
 *      avgEntry, and the resolution compares the FORWARD BARS against
 *      those anchored levels.
 *
 *      For a SHORT, avgEntry sits ABOVE the market by d/200 (0.27%-0.75%
 *      for ATR 0.6%-1.5%), while the TP distance is only tpPct (0.32%-
 *      0.48%). So the anchored TP lands ON OR ABOVE the market price —
 *      the target is already satisfied the instant the trade opens, and
 *      the FIRST forward bar's high/low touches it. The trade wins on
 *      a noise move, in BOTH directions, regardless of the market.
 *
 *      This is not a hypothesis: the venue's own code comments record a
 *      live instance of the same failure ("an AVAX short whose
 *      reference was 9.7895 filled at 9.754, so the take-profit sat
 *      0.04% ABOVE the fill and the st-order filled instantly, closing
 *      the position 7 seconds after opening" — src/commands/live.ts).
 *
 *   B. THE MARKET-ANCHORED TICKET (what the venue actually arms once
 *      it rebases onto the fill): the entry is the MARKET price (a
 *      market order), so the TP is tpPct away from the FILL and the
 *      stop is the ladder distance away from the FILL.
 *
 *      The DISTANCES are identical in both (the research formula
 *      (3d)/(200+d) is an exact algebraic re-expression of the live
 *      ladder's |killPrice - avgEntry|). Only the ANCHOR differs, and
 *      the anchor is what decides whether the target is inside the
 *      first bar's noise.
 *
 * ══ WHAT IS MEASURED HERE ══
 *
 * The research ticket and the market-anchored ticket, side by side, on
 * the same rows, with the same distances.
 */
import {
  ATR_MULT_STOP, ATR_CLAMP_LO, ATR_CLAMP_HI, TP_ATR_MULT, TP_CLAMP_LO, TP_CLAMP_HI,
} from "./lib.mjs";

/** The live path's ladder, exactly as planScalp builds it. */
export function ladder(atrPct, price, dir) {
  const atr = atrPct != null && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  const tpPct = Math.min(0.5, Math.max(0.3, atr * TP_ATR_MULT));
  const stepDropPct = Math.min(1.5, Math.max(0.6, atr * ATR_MULT_STOP));
  const steps = 2;
  const mults = [1, 1, 2].slice(0, steps);
  const dirSign = dir === "long" ? -1 : 1;
  const planSteps = mults.map((m, i) => ({
    price: price * (1 + (dirSign * (i * stepDropPct)) / 100),
    sizeUsd: m,
  }));
  const totalSize = planSteps.reduce((a, s) => a + s.sizeUsd, 0);
  const avgEntry = planSteps.reduce((a, s) => a + s.price * s.sizeUsd, 0) / totalSize;
  const tpDir = dir === "long" ? 1 : -1;
  const tpPrice = avgEntry * (1 + (tpDir * tpPct) / 100);
  const killPrice = price * (1 + (dirSign * (steps * stepDropPct)) / 100);
  // the distances the venue keeps when it rebases onto the fill
  const tpDistFrac = Math.abs(tpPrice - avgEntry) / avgEntry;
  const slDistFrac = Math.abs(killPrice - avgEntry) / avgEntry;
  return {
    atr, tpPct, stepDropPct, steps, avgEntry, tpPrice, killPrice,
    tpDistFrac, slDistFrac,
  };
}

/**
 * A. THE RESEARCH TICKET — anchored on avgEntry, as live-gate-ev.mjs.
 * The distances are the live path's, expressed as the research
 * formula (3d)/(200+d), which is algebraically identical to the live
 * ladder's |killPrice - avgEntry|/avgEntry.
 */
export function researchTicket(atrPct, price, dir) {
  if (!(atrPct > 0) || !(price > 0)) return null;
  const L = ladder(atrPct, price, dir);
  const tpFrac = L.tpDistFrac;
  const stopFrac = L.slDistFrac;
  const sign = dir === "short" ? -1 : 1;
  return {
    avgEntry: L.avgEntry,
    targetPrice: L.avgEntry * (1 + (sign * tpFrac)),
    stopPrice: L.avgEntry * (1 - (sign * stopFrac)),
    tpFrac, stopFrac, tpPct: L.tpPct, anchor: "avgEntry",
    ladder: L,
  };
}

/**
 * B. THE MARKET-ANCHORED TICKET — the venue's rebased legs: the entry
 * is the MARKET price, and the TP and the stop keep the live path's
 * distances from it.
 */
export function marketTicket(atrPct, price, dir) {
  if (!(atrPct > 0) || !(price > 0)) return null;
  const L = ladder(atrPct, price, dir);
  const tpFrac = L.tpDistFrac;
  const stopFrac = L.slDistFrac;
  const sign = dir === "short" ? -1 : 1;
  return {
    avgEntry: price,
    targetPrice: price * (1 + (sign * tpFrac)),
    stopPrice: price * (1 - (sign * stopFrac)),
    tpFrac, stopFrac, tpPct: L.tpPct, anchor: "market",
    ladder: L,
  };
}
