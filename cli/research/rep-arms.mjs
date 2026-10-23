#!/usr/bin/env node
/**
 * THE ARM BUILDER — identical on both venues.
 *
 * The arms must be built by the SAME code on KuCoin and on the
 * independent venue, or a difference in the result could be a
 * difference in the harness rather than in the market.
 *
 * THREE ARMS:
 *
 *   A. THE MACHINE'S OWN SIGNAL — the collector's `side` field (set
 *      only when BOTH model legs agree AND the JEV leg is certain) and
 *      the tape agreeing with it. This is what the live path trades.
 *      Only the KuCoin side has it: the `side` field is the collector's
 *      own record of the JEV leg's output.
 *
 *   B. THE REPLICABLE ARM — the tape agreeing with the LAYA bridge
 *      computed WITHOUT the JEV leg. The JEV leg is an LLM, so it
 *      cannot be reproduced on an independent venue without the
 *      account's credentials. This is the arm the replication measures.
 *
 *   C. THE UNCONDITIONAL BASELINE — the tape's direction with NO model
 *      filter at all. The excess of A or B over C is the edge; C alone
 *      is beta.
 *
 * THE BOOK LEG, AND WHY IT IS A FLAG
 *
 * The Laya bridge has three legs: JEV (the LLM), TAPE (momentum) and
 * BOOK (top-5 imbalance). The BOOK can only be read LIVE — a depth
 * snapshot is the book at that instant, and it cannot be backfilled
 * from klines. So:
 *
 *   book=true   the arm includes the book leg. Only possible over a
 *               live-sampled window.
 *   book=false  the arm omits the book leg. Fully backfillable, and so
 *               the only variant that can cover a long historical
 *               window on an independent venue.
 *
 * BOTH venues are measured in BOTH variants, so the book leg's
 * contribution is visible rather than assumed, and the comparison
 * between the venues is like-for-like.
 */
import { tapeSideFromRow, layaVerdict } from "./rep-venue-common.mjs";

/** The tape's side, from the SHARED module (not a re-implementation). */
export function tapeOf(r) {
  return tapeSideFromRow(r);
}

/**
 * The Laya bridge's choice for a row, with the JEV leg optionally
 * blanked and the book leg optionally included.
 */
export function layaChoice(r, { useJev = false, useBook = true } = {}) {
  if (r.tapeChg == null) return null;
  const jevSide = useJev && r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  return layaVerdict({
    chg: r.tapeChg,
    atrPct: r.tapeAtrPct,
    jevSide,
    jevAgreement: r.jevAgreement,
    jevUncertain: r.jevUncertain,
    imb: useBook ? r.bookImbalance : null,
    sprBps: r.spreadBps,
  }).choice;
}

/**
 * Build the three arms from a set of rows.
 *
 * `opts.book`  include the book leg in the Laya bridge (default true)
 * `opts.jev`   include the JEV leg (default false — it is an LLM)
 */
export function buildArms(rows, { book = true, jev = false } = {}) {
  const A = [];
  const B = [];
  const C = [];
  for (const r of rows) {
    const t = tapeOf(r);
    if (!t) continue;
    C.push({ ...r, dir: t });
    // ARM A needs the collector's own `side` field, so it only exists
    // where the collector ran.
    if (r.side && t === r.side) A.push({ ...r, dir: t });
    const l = layaChoice(r, { useJev: jev, useBook: book });
    if (l && l === t) B.push({ ...r, dir: t });
  }
  return { A, B, C };
}
