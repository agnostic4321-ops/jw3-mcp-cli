#!/usr/bin/env node
/**
 * THE MAKER-FIRST ENTRY — the only lever that changes the economics
 * without changing the signal.
 *
 * WHY THIS IS THE LAST LEVER
 * --------------------------
 * The signal has no demonstrable edge:
 *   - the live-gate arm's excess over the tape arm is INDISTINGUISHABLE
 *     from a random subset of the same shape, and NEGATIVE (-0.1934 pp
 *     of equity, at the 87.6th percentile of a size-matched placebo)
 *   - at the ticket's 4-hour holding period every arm has 2
 *     independent clusters against a bar of 30
 *   - the tighter stop that seemed to fix the EV does not survive the
 *     trim, and is monotonically worse on the 515-trade control arm
 *
 * A better signal is not available on this data. But the FEE is not the
 * signal:
 *
 *   taker round trip   0.12% of notional = $0.0720 on $60
 *   maker round trip   0.04% of notional = $0.0240 on $60
 *
 * The saving is $0.0480 per trade. The machine makes ~13 trades a day,
 * so a maker-first entry is worth ~$0.62 a day — larger than the
 * entire daily loss budget of $12 divided by twenty, and larger than
 * the account's entire measured daily loss.
 *
 * THE TRAP, AND WHY IT MUST BE MEASURED
 * -------------------------------------
 * A resting limit that gets FILLED is disproportionately a fill that
 * is about to go against you: you are the liquidity someone else
 * needed. So the maker entry buys a smaller fee and pays it with
 * ADVERSE SELECTION. If the adverse selection exceeds $0.048, the
 * maker entry is a trap and the taker entry is correct.
 *
 * So the simulation must measure three things and compare them:
 *
 *   1. THE FILL RATE: how often would a limit at the signal's price
 *      have been filled within N bars?
 *   2. THE ADVERSE SELECTION: on the filled subset, what was the
 *      immediate follow-through — the move AGAINST the position in
 *      the first bar after the fill?
 *   3. THE NET EXPECTANCY: maker-first-with-a-chase against
 *      taker-first, at $60 of notional.
 *
 * THE CHASE
 * ---------
 * A maker order that is not filled does not trade. So a maker-first
 * entry needs a chase: if the limit is not filled within the patience
 * window, take the market. The chase pays the full taker fee on the
 * UNFILLED portion, so the saving is only realised on the fills.
 *
 * THE HONEST SIMULATION
 * ---------------------
 * For each signal:
 *   - the limit price is the signal's own price (the market at the
 *     signal), or one tick better
 *   - a fill happens if a later bar's range TOUCHES the limit price
 *   - the fill price is the limit price (a resting limit fills AT its
 *     price — that is the whole point)
 *   - the immediate follow-through is the first bar's move against the
 *     position
 *   - if there is no fill within the patience window, the chase enters
 *     at the market on the bar where the patience expires, and pays
 *     the taker fee
 *
 * Every outcome is then resolved with the SAME ticket geometry and the
 * SAME first-touch TP/kill rules as the live path, so the only thing
 * that changes between the two arms is the ENTRY.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { isTargetWrongSide } from "./ticket-fill.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const ATR_MULT_STOP = 0.9;
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16;
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const TAKER = 0.0006; // per leg
const MAKER = 0.0002; // per leg
const FEE = { taker: TAKER * 2, maker: MAKER * 2 };

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(BARS, "utf8"));

function liveGateSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}
const liveArm = rows.filter((r) => tapeSideFromRow(r) && liveGateSide(r) === tapeSideFromRow(r));

/** The live path's avgEntry, derived from the signal's own price. */
function liveEntry(r) {
  const atrPct = Number(r.tapeAtrPct);
  const last = Number(r.price);
  if (!(atrPct > 0) || !(last > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  return tapeSideFromRow(r) === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
}

/** The ticket, in the live path's geometry, anchored on a given entry. */
function ticketFor(r, entry) {
  const atrPct = Number(r.tapeAtrPct);
  if (!(atrPct > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const long = tapeSideFromRow(r) === "long";
  const avgEntry = long ? entry * (1 - d / 200) : entry * (1 + d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  return {
    // `last` is the MARKET price the entry fills at — the anchor the
    // wrong-side test compares the target against.
    atrPct, stopFrac, tpFrac, avgEntry, last: entry,
    stopPrice: long ? avgEntry * (1 - stopFrac) : avgEntry * (1 + stopFrac),
    targetPrice: long ? avgEntry * (1 + tpFrac) : avgEntry * (1 - tpFrac),
  };
}

/** Resolve a ticket from a given entry price, starting at bar index i. */
/**
 * Resolve with the ticket's TP and SL levels HELD FIXED, and only the
 * entry price varying. This isolates the fee from the entry.
 */
function resolveFixed(b, i, ticket, side, roundTrip, entry) {
  const long = side === "long";
  const end = Math.min(b.length, i + BARS_BEFORE);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) {
      const pnl = long
        ? (ticket.targetPrice - entry) / entry
        : (entry - ticket.stopPrice) / entry;
      return { outcome: "loss", pnlPct: pnl - roundTrip };
    }
    if (hitTp) {
      const pnl = long
        ? (ticket.targetPrice - entry) / entry
        : (entry - ticket.targetPrice) / entry;
      return { outcome: "win", pnlPct: pnl - roundTrip };
    }
    if (hitSl) {
      const pnl = long
        ? (ticket.stopPrice - entry) / entry
        : (entry - ticket.stopPrice) / entry;
      return { outcome: "loss", pnlPct: pnl - roundTrip };
    }
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - entry) / entry
    : (entry - lastBar.c) / entry;
  return { outcome: "time", pnlPct: movePct - roundTrip };
}

function resolveFrom(b, i, ticket, side, roundTrip) {
  const long = side === "long";
  const end = Math.min(b.length, i + BARS_BEFORE);
  // A take-profit already satisfied at the market is a MARKETABLE order:
  // it fills instantly at the touch, so the gross is ~zero and the trade
  // books the fee. See research/ticket-fill.mjs.
  const tpWrongSide = isTargetWrongSide(side, ticket.targetPrice, ticket.last);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - roundTrip };
    if (hitTp) {
      if (tpWrongSide) return { outcome: "scratch", pnlPct: -roundTrip };
      return { outcome: "win", pnlPct: ticket.tpFrac - roundTrip };
    }
    if (hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - roundTrip };
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", pnlPct: movePct - roundTrip };
}

console.log("═".repeat(94));
console.log("THE MAKER-FIRST ENTRY — the fee is the lever, not the signal");
console.log("═".repeat(94));
console.log(`the live-gate arm: ${liveArm.length} observations`);
console.log(`the fee: taker ${(FEE.taker * 100).toFixed(2)}% = $${(FEE.taker * NOTIONAL).toFixed(4)} | maker ${(FEE.maker * 100).toFixed(2)}% = $${(FEE.maker * NOTIONAL).toFixed(4)} | the saving $${((FEE.taker - FEE.maker) * NOTIONAL).toFixed(4)} per trade`);

// ── the TAKER arm: the live path's own behaviour ──
const takerResults = [];
for (const r of liveArm) {
  const b = bars[r.pair];
  if (!b) continue;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) continue;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) continue;
  // The ticket is built from the signal's LAST price, and the entry is
  // the ticket's own avgEntry -- which is what the live path does.
  //
  // A first version passed liveEntry(r) into ticketFor, which applies
  // the d/200 offset to whatever it is given, so the offset was applied
  // TWICE and the TP and SL sat twice as far away as the live path's.
  // The tell was the taker arm's EV: -0.3315% of equity, where the
  // correct figure is +0.0415%.
  const last = Number(r.price);
  if (!(last > 0)) continue;
  const ticket = ticketFor(r, last);
  if (!ticket) continue;
  const entry = ticket.avgEntry;
  // THE SAME resolution as the maker arm, so the two arms differ ONLY in
  // the entry price and the fee.
  const o = resolveFrom(b, i, ticket, tapeSideFromRow(r), FEE.taker);
  if (!o) continue;
  takerResults.push({ ...o, pnlEq: o.pnlPct * RHO * 100 });
}
const takerEv = mean(takerResults.map((t) => t.pnlEq));
const takerWins = takerResults.filter((t) => t.outcome === "win").length;

console.log(`\n\u2500\u2500 the TAKER arm (the live path today) \u2500\u2500`);
console.log(`  n ${takerResults.length} | wins ${takerWins} | win rate ${fmt((takerWins / Math.max(1, takerResults.length)) * 100, 1)}% | EV ${fmt(takerEv)} % of equity per trade`);
console.log(`  the fee is already inside: ${fmt(FEE.taker * RHO * 100, 4)} % of equity per trade`);

const PATIENCE = [1, 2, 3, 4, 8];

/**
 * The MAKER arm: a limit order with a chase.
 *
 * `limitOf(r)` gives the limit price for a row. The fill is when the
 * market REACHES it: a short's offer rests ABOVE the market and fills
 * on a RISE (bar.h >= limit); a long's bid rests BELOW and fills on a
 * FALL (bar.l <= limit).
 *
 * A first version had the short's condition inverted, which made its
 * "resting" limit fill on a RISE - at the market, not in a queue - and
 * produced a false positive: a 95.5% fill rate and an apparent
 * +$0.0458 per trade. A fill rate that high for a passive order is the
 * tell that the simulation is not simulating a queue at all.
 */
function runMaker(limitOf, label) {
  console.log(`\n\u2500\u2500 the MAKER arm: ${label} \u2500\u2500`);
  console.log("  patience  fill%   filled     adverse sel.   EV %eq     vs taker    net $");
  for (const patience of PATIENCE) {
    const res = [];
    let fills = 0;
    let adverseSum = 0;
    let adverseN = 0;
    for (const r of liveArm) {
      const b = bars[r.pair];
      if (!b) continue;
      const i = b.findIndex((x) => x.t > r.ts);
      if (i < 0) continue;
      const end = Math.min(b.length, i + BARS_BEFORE);
      if (end - i < 2) continue;
      const long = tapeSideFromRow(r) === "long";
      const limit = limitOf(r);
      if (!(limit > 0)) continue;

      let fillIdx = -1;
      for (let k = i; k < Math.min(end, i + patience); k++) {
        const bar = b[k];
        const touched = long ? bar.l <= limit : bar.h >= limit;
        if (touched) { fillIdx = k; break; }
      }
      let entry;
      let roundTrip;
      let startIdx;
      if (fillIdx >= 0) {
        fills++;
        entry = limit;
        roundTrip = FEE.maker;
        startIdx = fillIdx;
        // THE ADVERSE SELECTION: the move AGAINST the position from the
        // fill to the close of the fill's own bar.
        const bar = b[fillIdx];
        const adv = long ? (limit - bar.c) / limit : (bar.c - limit) / limit;
        adverseSum += adv;
        adverseN++;
      } else {
        // THE CHASE: the patience expired, so take the market and pay
        // the taker fee.
        startIdx = Math.min(end - 1, i + patience);
        const bar = b[startIdx];
        // The chase enters at the bar's CLOSE — the price the market is
        // at when the patience expires. Filling at the bar's high (for a
        // short) or its low (for a long) is impossible: a market order
        // does not get the extreme of the bar it enters, and assuming it
        // does manufactures a large loss on every chased trade.
        entry = bar.c;
        roundTrip = FEE.taker;
      }
      // THE LEGS ARE REBASED ONTO THE FILL, exactly as the machine does
      // after the rebase fix. That preserves the GEOMETRY — the distance
      // from the entry to the take-profit — and changes only the fee and
      // where the entry landed relative to the market. Both are real
      // effects of switching to a maker entry.
      //
      // A first version held the taker arm's ABSOLUTE levels fixed while
      // the maker entry moved, which measured a machine no one would
      // build: a maker fill with a take-profit left at the taker's price
      // sits ~0.05% away, so the trade either wins instantly for nothing
      // or loses the full stop.
      const rebased = ticketFor(r, entry);
      if (!rebased) continue;
      const o = resolveFrom(b, startIdx, rebased, tapeSideFromRow(r), roundTrip);
      if (!o) continue;
      res.push({ ...o, pnlEq: o.pnlPct * RHO * 100, filled: fillIdx >= 0 });
    }
    if (!res.length) continue;
    const ev = mean(res.map((t) => t.pnlEq));
    const fillRate = (fills / res.length) * 100;
    const delta = ev - takerEv;
    console.log(
      `  ${String(patience).padStart(6)} bar ${fmt(fillRate, 1).padStart(5)}%  ${String(fills).padStart(3)}/${String(res.length).padEnd(3)}  ` +
      `${fmt(adverseN ? (adverseSum / adverseN) * 100 : 0, 4).padStart(9)}%  ${fmt(ev).padStart(9)}   ` +
      `${fmt(delta, 4).padStart(8)}   ${fmt((delta / 100) * EQUITY, 4).padStart(7)}`,
    );
  // THE FILLED / CHASED SPLIT — the decision-grade breakdown. The fee
  // saving is only realised on the FILLED trades; the chased ones pay
  // the taker fee and are pure entry-quality change.
  const filledTrades = res.filter((t) => t.filled);
  const chasedTrades = res.filter((t) => !t.filled);
  const takerFilled = takerResults.slice();
  if (filledTrades.length) {
    const fEv = mean(filledTrades.map((t) => t.pnlEq));
    const tEv = mean(takerFilled.map((t) => t.pnlEq));
    console.log(
      `    the FILLED subset: n ${filledTrades.length} | EV ${fmt(fEv)} %eq | the taker arm's EV on the same n ${fmt(tEv)} | the difference ${fmt(fEv - tEv, 4)} pp = $${fmt(((fEv - tEv) / 100) * EQUITY, 4)}`,
    );
  }
  if (chasedTrades.length) {
    const cEv = mean(chasedTrades.map((t) => t.pnlEq));
    console.log(
      `    the CHASED subset: n ${chasedTrades.length} | EV ${fmt(cEv)} %eq | these pay the TAKER fee, so the saving does not apply to them`,
    );
  }
  }
  // the adverse selection, in dollars, against the saving
  let adverseSum = 0;
  let adverseN = 0;
  let fills = 0;
  for (const r of liveArm) {
    const b = bars[r.pair];
    if (!b) continue;
    const i = b.findIndex((x) => x.t > r.ts);
    if (i < 0) continue;
    const end = Math.min(b.length, i + BARS_BEFORE);
    if (end - i < 2) continue;
    const long = tapeSideFromRow(r) === "long";
    const limit = limitOf(r);
    if (!(limit > 0)) continue;
    for (let k = i; k < Math.min(end, i + 4); k++) {
      const bar = b[k];
      const touched = long ? bar.l <= limit : bar.h >= limit;
      if (touched) {
        fills++;
        const adv = long ? (limit - bar.c) / limit : (bar.c - limit) / limit;
        adverseSum += adv;
        adverseN++;
        break;
      }
    }
  }
  if (adverseN) {
    console.log(`    the adverse selection: $${fmt((adverseSum / adverseN) * NOTIONAL, 4)} per fill against a $${fmt((FEE.taker - FEE.maker) * NOTIONAL, 4)} saving`);
  }
}

// PLACEMENT A: a limit AT THE SIGNAL'S OWN PRICE. This is NOT passive:
// the signal's price is the last trade, and the next bar's range almost
// always covers it, so the order crosses the spread.
runMaker((r) => Number(r.price), "a limit AT THE SIGNAL'S PRICE (crosses the spread)");
// PLACEMENT B: the live path's own avgEntry - for a short that is ABOVE
// the market, so it is a genuine queue with a real (low) fill rate.
runMaker((r) => {
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const t = ticketFor(r, last);
  return t ? t.avgEntry : null;
}, "a limit at the LIVE PATH'S avgEntry (a real queue)");

console.log("");
