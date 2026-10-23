#!/usr/bin/env node
/**
 * IS THE TIGHTER STOP REAL?
 *
 * The geometry sweep says the live-gate arm's best ticket is
 * TP=0.4xATR / stop=0.3xATR, with 4.6x the EV of the shipped ticket
 * (0.1907% vs 0.0415% of equity per trade) at the SAME win rate
 * (90.9%).
 *
 * A tighter stop that changes nothing about the win rate is strange.
 * Two readings, with opposite consequences:
 *
 *   (a) The stop fires on the SAME losing trades either way, so a
 *       tighter stop means a SMALLER loss on them — the EV gain is
 *       arithmetic, not an edge.
 *   (b) The EV gain is carried by a handful of losing trades, so it
 *       is a small-sample artefact that a trim destroys.
 *
 * THE GEOMETRY, EXACTLY AS THE LIVE PATH BUILDS IT
 * -------------------------------------------------
 * The live path (kucoin.ts planScalp + live-cmd.ts) uses PERCENT
 * numbers, and the entry is NOT the signal's price — it is offset by
 * half the stop:
 *
 *     d        = clamp(0.9 x ATR%, 0.6, 1.5)      a percent number
 *     avgEntry = last x (1 + d/200)               for a short
 *     stopFrac = 3d / (200 + d)                   a FRACTION of avgEntry
 *     tpFrac   = clamp(0.4 x ATR%, 0.3, 0.5) / 100
 *
 * So the live stop is NOT d. At d=1.0 the stop fraction is
 * 3/(201) = 1.4925% — and the study's "stop=1.0xATR" row is the
 * closest match. A first version of this script used the ATR
 * directly as the stop fraction and the ATR directly as the entry
 * offset, which produced a 48% win rate and identical numbers for
 * every geometry — a clear signal that the geometry was not being
 * applied at all.
 *
 * WHAT THIS SCRIPT SETTLES
 * -------------------------
 *   1. THE TRIM: drop the worst 3 and the best 3 trades and re-measure
 *      the EV gap. If the gap survives, it is not one trade.
 *   2. THE DRIFT: the arm's excess over "always the market's side" was
 *      NEGATIVE. A better ticket on a signal with no edge over its own
 *      drift is a better way to lose.
 *   3. THE FEE FRACTION: the fee must be a small fraction of the stop
 *      room. At 0.3xATR the fee is ~50% of the stop — above the 1/3
 *      threshold in the standing rules.
 *   4. THE PLACEBO: the same EV gap on the TAPE-ONLY arm (562 trades,
 *      47 clusters). If the tighter stop helps there too, the effect is
 *      about the GEOMETRY, not the signal — and that is the useful
 *      version of the result, because the geometry is what the machine
 *      controls.
 *
 * The bar for a finding: the EV gap survives the trim, the gain is
 * visible on the control arm too, and the net EV after the fee stays
 * positive.
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
const TAKER = 0.0006;
const ROUND_TRIP = TAKER * 2;

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
const tapeArm = rows.filter((r) => tapeSideFromRow(r));

/**
 * The ticket, in the live path's geometry, with the stop multiple as a
 * parameter. `stopMult` scales the ATR that the stop is derived from,
 * so stopMult=1 is the live path's own ticket and stopMult=0.3 is a
 * stop three times tighter.
 */
function ticketFor(r, stopMult) {
  const atrPct = Number(r.tapeAtrPct);
  if (!(atrPct > 0)) return null; // the live path REFUSES a missing ATR
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const dir = tapeSideFromRow(r);
  const avgEntry = dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  // The stop: the live path's 3d/(200+d) fraction, but with the ATR
  // scaled by stopMult — so the entry offset and the stop move
  // together, as they would if the ticket were simply built with a
  // different ATR multiple.
  const dEff = Math.min(Math.max(ATR_MULT_STOP * stopMult * atrPct, ATR_CLAMP_LO * stopMult), ATR_CLAMP_HI * stopMult);
  const avgEntryEff = dir === "short" ? last * (1 + dEff / 200) : last * (1 - dEff / 200);
  const stopFrac = (3 * dEff) / (200 + dEff);
  const tpFrac = tpPct / 100;
  const stopPrice = dir === "short" ? avgEntryEff * (1 + stopFrac) : avgEntryEff * (1 - stopFrac);
  const targetPrice = dir === "short" ? avgEntryEff * (1 - tpFrac) : avgEntryEff * (1 + tpFrac);
  return { atrPct, d, dEff, tpPct, stopFrac, tpFrac, avgEntry: avgEntryEff, last, stopPrice, targetPrice };
}

/**
 * Walk the forward bars and resolve the ticket.
 * A bar touching BOTH levels is a LOSS (conservative).
 * A trade reaching neither is a TIME EXIT at its mark.
 */
function resolve(r, ticket) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = tapeSideFromRow(r) === "long";
  // A take-profit already satisfied at the market is a MARKETABLE order:
  // it fills instantly at the touch, so the gross is ~zero and the trade
  // books the fee. See research/ticket-fill.mjs.
  const tpWrongSide = isTargetWrongSide(tapeSideFromRow(r), ticket.targetPrice, ticket.last);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
    if (hitTp) {
      if (tpWrongSide) return { outcome: "scratch", bars: k - i + 1, pnlPct: -ROUND_TRIP };
      return { outcome: "win", bars: k - i + 1, pnlPct: ticket.tpFrac - ROUND_TRIP };
    }
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
  }
  const lastBar = b[end - 1];
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: movePct - ROUND_TRIP };
}

function measure(arm, stopMult) {
  const trades = [];
  for (const r of arm) {
    const ticket = ticketFor(r, stopMult);
    if (!ticket) continue;
    const o = resolve(r, ticket);
    if (!o) continue;
    trades.push({ ...o, pair: r.pair, ts: r.ts, side: tapeSideFromRow(r), atrPct: ticket.atrPct, stopFrac: ticket.stopFrac });
  }
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const times = trades.filter((t) => t.outcome === "time").length;
  const evEq = trades.map((t) => t.pnlPct * RHO * 100);
  return {
    trades,
    n: trades.length,
    wins,
    losses,
    times,
    winRate: trades.length ? wins / trades.length : 0,
    ev: mean(evEq),
    evEq,
    clusters: new Set(trades.map((t) => Math.floor(t.ts / 300_000))).size,
  };
}

/** Drop the n worst and the n best trades, then re-measure. */
function trim(evs, n) {
  const s = [...evs].sort((a, b) => a - b);
  return s.slice(n, s.length - n);
}

const GEOMS = [
  { label: "SHIPPED  stop=1.0x", mult: 1.0 },
  { label: "stop=0.7x", mult: 0.7 },
  { label: "stop=0.5x", mult: 0.5 },
  { label: "stop=0.3x", mult: 0.3 },
  { label: "stop=0.2x", mult: 0.2 },
];

console.log("═".repeat(92));
console.log("IS THE TIGHTER STOP REAL?");
console.log("═".repeat(92));
console.log(`the live-gate arm: ${liveArm.length} observations | the tape-only control: ${tapeArm.length}`);

for (const [name, arm] of [["LIVE-GATE", liveArm], ["TAPE-ONLY (control)", tapeArm]]) {
  console.log(`\n── ${name} ──`);
  console.log("  geometry            n  win%  time%   EV %eq   BE-WR   trim(w3)  gap vs shipped");
  const base = measure(arm, 1.0);
  const baseTrim = mean(trim(base.evEq, 3));
  const beWrOf = (m) => {
    const w = m.trades.filter((t) => t.outcome === "win");
    const l = m.trades.filter((t) => t.outcome === "loss");
    if (!w.length || !l.length) return NaN;
    const winEq = mean(w.map((t) => t.pnlPct)) * RHO * 100;
    const lossEq = Math.abs(mean(l.map((t) => t.pnlPct)) * RHO * 100);
    return (lossEq / (winEq + lossEq)) * 100;
  };
  console.log(
    `  ${GEOMS[0].label.padEnd(18)} ${String(base.n).padStart(3)} ${(base.winRate * 100).toFixed(1).padStart(5)} ` +
    `${((base.times / Math.max(1, base.n)) * 100).toFixed(1).padStart(5)} ${fmt(base.ev).padStart(8)}   ` +
    `${fmt(beWrOf(base), 1).padStart(5)}%   ${fmt(baseTrim).padStart(7)}`,
  );
  for (const g of GEOMS.slice(1)) {
    const m = measure(arm, g.mult);
    const t3 = mean(trim(m.evEq, 3));
    const gapRaw = m.ev - base.ev;
    const gapTrim = t3 - baseTrim;
    console.log(
      `  ${g.label.padEnd(18)} ${String(m.n).padStart(3)} ${(m.winRate * 100).toFixed(1).padStart(5)} ` +
      `${((m.times / Math.max(1, m.n)) * 100).toFixed(1).padStart(5)} ${fmt(m.ev).padStart(8)}   ` +
      `${fmt(beWrOf(m), 1).padStart(5)}%   ${fmt(t3).padStart(7)}   ${fmt(gapRaw, 4).padStart(6)} -> trimmed ${fmt(gapTrim, 4)}`,
    );
  }

  // ── THE DRIFT: the arm's excess over "always the market's side" ──
  const arm03 = measure(arm, 0.3);
  const alwaysShort = measure(arm.map((r) => ({ ...r, tapeSide: "short" })), 0.3);
  console.log(
    `\n  the DRIFT at 0.3x: arm EV ${fmt(arm03.ev)} vs always-short EV ${fmt(alwaysShort.ev)}` +
    `  => excess ${fmt(arm03.ev - alwaysShort.ev, 4)} pp of equity`,
  );

  // ── THE FEE FRACTION at the median ATR ──
  const atrs = arm.map((r) => Number(r.tapeAtrPct)).filter((a) => Number.isFinite(a) && a > 0).sort((a, b) => a - b);
  const medAtr = atrs.length ? atrs[Math.floor(atrs.length / 2)] : 1;
  const feeEq = ROUND_TRIP * RHO * 100;
  console.log(`  the fee fraction at the median ATR (${fmt(medAtr, 3)}%):`);
  for (const g of GEOMS) {
    const dEff = Math.min(Math.max(ATR_MULT_STOP * g.mult * medAtr, ATR_CLAMP_LO * g.mult), ATR_CLAMP_HI * g.mult);
    // stopFrac is a FRACTION of the entry; the fee is a FRACTION of the
    // notional. To compare them the stop must be in PERCENT, and the
    // fee must be scaled from notional into the same notional units.
    const stopPct = (3 * dEff) / (200 + dEff) * 100;
    const feePctNotional = ROUND_TRIP * 100;
    console.log(`    ${g.label.padEnd(18)} stop ${fmt(stopPct, 3)}%  the fee ${fmt(feePctNotional, 3)}% is ${fmt((feePctNotional / stopPct) * 100, 0)}% of the stop room`);
  }
  console.log("");
}
