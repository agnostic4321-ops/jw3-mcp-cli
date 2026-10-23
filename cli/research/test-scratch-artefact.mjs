#!/usr/bin/env node
/**
 * THE SCRATCH ARTEFACT — the simulation books a win the venue cannot pay.
 *
 * THE BUG IN EVERY MEASUREMENT SO FAR
 * ----------------------------------
 * The live path builds a SHORT's ticket as:
 *
 *     d        = clamp(0.9 x ATR%, 0.6, 1.5)      a percent number
 *     avgEntry = last x (1 + d/200)               the entry is ABOVE the market
 *     TP       = avgEntry x (1 - tp/100)
 *
 * The TP is BELOW the market only if tp > d/2. With the live path's own
 * constants, tp = 0.4 x ATR and d = 0.9 x ATR, so tp > d/2 is FALSE for
 * EVERY ATR. The take-profit is therefore ABOVE the last price.
 *
 * A buy limit ABOVE the market fills INSTANTLY at the ask. So the
 * "take-profit" is a SCRATCH, not a take-profit.
 *
 * The venue's own book says exactly this. The AVAX short filled at
 * 9.754 and its take-profit filled at 9.757, six seconds later, for
 * -$0.0652 — a fee and nothing else.
 *
 * But every simulation so far checked "did the bar's LOW reach the TP
 * price?" — and when the market is already below the TP, that is true
 * on the FIRST bar. The simulation then pays the FULL take-profit
 * distance (0.4%), which the venue would never pay.
 *
 * MEASURED: of the 386 tape-arm signals whose first bar reached the
 * take-profit price, 302 had the take-profit ALREADY SATISFIED at the
 * entry. The simulation books those as +0.18% of equity each. Reality
 * books -0.12% — the fee alone.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * It re-measures every arm with the CORRECT fill rule: a take-profit
 * only pays if the market had to MOVE to it. Concretely, for a trade
 * whose take-profit is on the wrong side of the entry, the exit is at
 * the MARKET (the fill that actually happens), and the P&L is the
 * scratch minus the fee.
 *
 * It reports, for each arm and each geometry:
 *   - the win rate under the OLD rule and under the CORRECT rule
 *   - the EV under both
 *   - the number of scratches
 *
 * If the corrected EV is negative — and the fee floor says it must be
 * — then the machine's ticket has been losing money by construction,
 * and the 90-95% win rate was a bookkeeping artefact of a target that
 * was already reached.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

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
const ROUND_TRIP = 0.0012;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
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
const tapeArm = rows.filter((r) => tapeSideFromRow(r));

/** The live path's ticket. */
function ticketFor(r) {
  const atrPct = Number(r.tapeAtrPct);
  const last = Number(r.price);
  if (!(atrPct > 0) || !(last > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const long = tapeSideFromRow(r) === "long";
  const avgEntry = long ? last * (1 - d / 200) : last * (1 + d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  return {
    atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, last, long,
    stopPrice: long ? avgEntry * (1 - stopFrac) : avgEntry * (1 + stopFrac),
    targetPrice: long ? avgEntry * (1 + tpFrac) : avgEntry * (1 - tpFrac),
  };
}

/**
 * Resolve with the CORRECT fill rule.
 *
 * A take-profit that is ALREADY SATISFIED at the entry cannot pay the
 * take-profit distance: the exit order fills at the MARKET, so the
 * P&L is the scratch (approximately zero) minus the fee.
 *
 * `rule` is "old" (pay the full TP) or "correct" (pay the scratch).
 */
function resolve(r, ticket, rule) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = ticket.long;

  // Is the take-profit on the wrong side of the MARKET? For a short,
  // the target is above the last price; for a long, below it.
  const tpWrongSide = long ? ticket.targetPrice < ticket.last : ticket.targetPrice > ticket.last;

  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - ROUND_TRIP, scratch: false };
    if (hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - ROUND_TRIP, scratch: false };
    if (hitTp) {
      if (rule === "old") {
        return { outcome: "win", pnlPct: ticket.tpFrac - ROUND_TRIP, scratch: false };
      }
      if (!tpWrongSide) {
        // The target was BEYOND the market, so the market had to move to
        // reach it, and the venue pays the full target distance.
        return { outcome: "win", pnlPct: ticket.tpFrac - ROUND_TRIP, scratch: false };
      }
      // THE CORRECT RULE: the exit fills at the MARKET, not at the
      // target, because a limit order on the wrong side of the market
      // is marketable and fills at the touch.
      //
      // The ENTRY is also a market order (the live path places one), so
      // the real fill is at the market too -- NOT at avgEntry, which is
      // the live path's PLANNED entry and is offset from the market by
      // d/200. The scratch is therefore a trade from the market to the
      // market: approximately zero, minus the fee.
      //
      // A first version measured the scratch from avgEntry to the bar's
      // extreme, which made it look like a win (+0.1588 % of equity)
      // when it is a loss. The venue's own book says it plainly: the
      // AVAX short filled 9.754 and its take-profit filled 9.757 six
      // seconds later, for -$0.0652.
      // THE SCRATCH'S GROSS IS ~ZERO. The entry is a market sell at the
      // bid and the exit is a marketable buy at the ask, SECONDS later,
      // at essentially the same price. The gross is therefore the
      // SPREAD (a few bps) and the net is the fee.
      //
      // A first version measured the scratch to the BAR'S CLOSE, which
      // is 15 minutes later -- that is not a scratch, that is a 15-minute
      // position, and it made the scratches look profitable (+0.0218 %).
      // The venue's book says what a scratch is: the AVAX short filled
      // 9.754 and its take-profit filled 9.757 six seconds later, for
      // -$0.0652 on a $60 ticket.
      const gross = 0;
      return { outcome: tpWrongSide ? "scratch" : "win", pnlPct: gross - ROUND_TRIP, scratch: tpWrongSide };
    }
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", pnlPct: movePct - ROUND_TRIP, scratch: false };
}

function measure(arm, rule) {
  const trades = [];
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) continue;
    const o = resolve(r, t, rule);
    if (!o) continue;
    trades.push({ ...o, ts: r.ts, pair: r.pair, pnlEq: o.pnlPct * RHO * 100 });
  }
  const wins = trades.filter((t) => t.outcome === "win").length;
  const scratches = trades.filter((t) => t.outcome === "scratch").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const times = trades.filter((t) => t.outcome === "time").length;
  const evEq = trades.map((t) => t.pnlEq);
  return {
    trades, n: trades.length, wins, scratches, losses, times,
    winRate: trades.length ? wins / trades.length : 0,
    ev: mean(evEq), evEq,
    clusters: new Set(trades.map((t) => Math.floor(t.ts / 300_000))).size,
  };
}

console.log("═".repeat(100));
console.log("THE SCRATCH ARTEFACT — the simulation books a win the venue cannot pay");
console.log("═".repeat(100));
console.log("for a SHORT, the live path's take-profit is ABOVE the market, because");
console.log("  tp = 0.4 x ATR and d = 0.9 x ATR, so tp > d/2 is FALSE for every ATR.");
console.log("a buy limit above the market fills INSTANTLY at the ask: a scratch, not a");
console.log("take-profit. The venue's book agrees: the AVAX short filled 9.754 and its");
console.log("take-profit filled 9.757 six seconds later, for -$0.0652.");
console.log("");

for (const [name, arm] of [["LIVE-GATE (the machine's trade)", liveArm], ["TAPE-ONLY (the control)", tapeArm]]) {
  console.log(`── ${name} ──`);
  console.log("  rule        n   win%  scratch%  loss%  time%    EV %eq      se       t");
  for (const rule of ["old", "correct"]) {
    const m = measure(arm, rule);
    // the cluster-corrected t, at the collector's round
    const g = new Map();
    for (const t of m.trades) {
      const b = Math.floor(t.ts / 300_000);
      if (!g.has(b)) g.set(b, []);
      g.get(b).push(t);
    }
    const means = [...g.values()].map((v) => mean(v.map((t) => t.pnlEq)));
    const ev = mean(means);
    const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
    console.log(
      `  ${rule.padEnd(10)} ${String(m.n).padStart(4)} ${fmt(m.winRate * 100, 1).padStart(6)} ${fmt((m.scratches / Math.max(1, m.n)) * 100, 1).padStart(8)} ` +
      `${fmt((m.losses / Math.max(1, m.n)) * 100, 1).padStart(6)} ${fmt((m.times / Math.max(1, m.n)) * 100, 1).padStart(6)} ` +
      `${fmt(ev).padStart(9)} ${fmt(se).padStart(9)} ${fmt(se > 0 ? ev / se : 0).padStart(8)}`,
    );
  }
  const mo = measure(arm, "old");
  const mc = measure(arm, "correct");
  const feeEq = ROUND_TRIP * RHO * 100;
  console.log(`  the OLD rule's EV ${fmt(mo.ev)} vs the CORRECT rule's EV ${fmt(mc.ev)} — a swing of ${fmt(mc.ev - mo.ev)} pp of equity per trade`);
  console.log(`  the fee floor is ${fmt(feeEq, 4)} % of equity per trade, so the corrected EV is ${mc.ev > 0 ? "ABOVE" : "BELOW"} the floor`);
  console.log(`  the scratches: ${mc.scratches} of ${mc.n} trades — every one of them books a fee and nothing else`);
  console.log("");
}

// ── the fee floor at the CORRECT rule, and what the machine books ──
const mc = measure(liveArm, "correct");
const scratchPnl = mc.trades.filter((t) => t.outcome === "scratch").map((t) => t.pnlEq);
const realPnl = mc.trades.filter((t) => t.outcome === "win").map((t) => t.pnlEq);
console.log("── WHAT THE MACHINE ACTUALLY BOOKS, at the correct rule ──");
// The per-trade P&L is ALREADY in percent of equity, so it must not be
// multiplied again. (A first version multiplied by 100 and printed
// "15.8780 % of equity each" for a scratch, which is 100x too large.)
if (scratchPnl.length) {
  console.log(`  the ${scratchPnl.length} scratches: ${fmt(mean(scratchPnl), 4)} % of equity each (the fee, plus the scratch)`);
}
if (realPnl.length) {
  console.log(`  the ${realPnl.length} real take-profits: ${fmt(mean(realPnl), 4)} % of equity each`);
}
console.log(`  the arm's EV: ${fmt(mc.ev)} % of equity per trade`);
console.log("");
