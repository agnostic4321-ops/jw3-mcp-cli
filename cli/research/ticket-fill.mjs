// THE TICKET'S FILL RULE — shared, so every study resolves a trade the
// way the VENUE does.
//
// THE DEFECT THIS EXISTS TO PREVENT
// ---------------------------------
// A study that resolves a trade by asking "did the bar's LOW reach the
// target price?" and then pays the FULL target distance books a
// MARKETABLE order as a full win.
//
// For a SHORT whose ticket is anchored on the offset average entry —
// `avgEntry = last * (1 + d/200)`, so the entry sits ABOVE the last
// price — the target `avgEntry * (1 - tpFrac)` is only BELOW the market
// when `tpFrac > d/200`. With the live path's `tp = 0.4 x ATR` and
// `d = 0.9 x ATR` that is FALSE FOR EVERY ATR, so the target is always
// ABOVE the market.
//
// A buy limit above the market is MARKETABLE: it fills instantly at the
// ask. The gross is ~zero and the trade books the fee. Booked as a
// full target win, it produced the 90-95% win rates this project
// reported for weeks.
//
// See docs/research/the-scratch-artefact.md.
//
// THE RULE
// --------
// 1. A take-profit on the WRONG SIDE of the market is a scratch: ~zero
//    gross, minus the fee.
// 2. A bar that touches BOTH the target and the stop is a LOSS
//    (conservative: the path is unknown, so assume the bad order).
// 3. A trade that reaches neither level is a TIME EXIT, marked at the
//    last bar's close — not "unresolved" and not dropped.
//
// Every study that resolves a ticket outcome must use this module, so
// the fill rule cannot drift between the study and the live path.

/** The taker round trip as a FRACTION of notional. */
export const ROUND_TRIP = 0.0012;

/**
 * Is the take-profit on the wrong side of the MARKET?
 *
 * For a short the target must be BELOW the market; for a long, ABOVE.
 * A target that is already satisfied is marketable, so it fills at the
 * touch.
 *
 * @param {string} dir   "long" | "short"
 * @param {number} targetPrice
 * @param {number} marketPrice
 */
export function isTargetWrongSide(dir, targetPrice, marketPrice) {
  if (!Number.isFinite(targetPrice) || !Number.isFinite(marketPrice)) return false;
  return dir === "long" ? targetPrice < marketPrice : targetPrice > marketPrice;
}

/**
 * Resolve a trade against a bar series.
 *
 * @param {Array<{t:number, h:number, l:number, c:number}>} bars
 * @param {number} fromIdx        the first bar AFTER the signal
 * @param {number} barLimit       how many bars the ticket may live
 * @param {string} dir            "long" | "short"
 * @param {{targetPrice:number, stopPrice:number, tpFrac:number, stopFrac:number, last:number}} ticket
 * @param {number} roundTrip      the taker round trip as a fraction
 * @returns {{outcome:"win"|"loss"|"scratch"|"time", bars:number, pnlPct:number} | null}
 */
export function resolveTicket(bars, fromIdx, barLimit, dir, ticket, roundTrip = ROUND_TRIP) {
  if (!bars || fromIdx < 0) return null;
  const end = Math.min(bars.length, fromIdx + barLimit);
  if (end - fromIdx < 2) return null;

  const long = dir === "long";
  // A target already satisfied at the market fills instantly at the
  // touch, so the gross is ~zero.
  const tpWrongSide = isTargetWrongSide(dir, ticket.targetPrice, ticket.last);

  for (let k = fromIdx; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;

    // A bar touching both is resolved CONSERVATIVELY as a loss: the
    // path within the bar is unknown.
    if (hitTp && hitSl) {
      return { outcome: "loss", bars: k - fromIdx + 1, pnlPct: -ticket.stopFrac - roundTrip };
    }
    if (hitTp) {
      if (tpWrongSide) {
        return { outcome: "scratch", bars: k - fromIdx + 1, pnlPct: -roundTrip };
      }
      return { outcome: "win", bars: k - fromIdx + 1, pnlPct: ticket.tpFrac - roundTrip };
    }
    if (hitSl) {
      return { outcome: "loss", bars: k - fromIdx + 1, pnlPct: -ticket.stopFrac - roundTrip };
    }
  }

  // The time exit: the ticket lived its full life and reached neither
  // level. It is marked at the last bar's close — a real outcome, not a
  // dropped observation.
  const lastBar = bars[end - 1];
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", bars: end - fromIdx, pnlPct: movePct - roundTrip };
}
