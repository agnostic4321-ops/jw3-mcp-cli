#!/usr/bin/env node
/**
 * THE SUBSET ARTEFACT — tested directly on the live-gate arm.
 *
 * A stress-test agent found the deepest problem with the whole
 * geometry family (GEOMETRY-STRESS-FINDINGS.md):
 *
 *   "The size-matched placebo is the answer. A random subset of the
 *    tape arm, with the same size and the same per-symbol counts,
 *    produces an excess of the SAME ORDER as the real one. The
 *    published 'excess' is substantially a mechanical consequence of
 *    the signal arm being a SUBSET of the baseline arm: comparing a
 *    subset to its superset produces a difference that depends on the
 *    subset's size and the market's drift, not only on the
 *    information the gate carries."
 *
 * THIS IS A DESIGN FLAW IN THE MEASUREMENT, not a property of the
 * signal. The live-gate arm (tape + models agree) IS a subset of the
 * tape arm (the tape's direction with no model filter). So
 *
 *     excess = mean(signal arm) - mean(tape arm)
 *
 * compares a SUBSET to its SUPERSET. If the gate selects the trades
 * that happened to go well, the difference is positive — and a RANDOM
 * subset of the same size, with the same per-symbol counts, would
 * show a difference of the SAME ORDER purely from the market's drift
 * and the subset's size.
 *
 * So the question is not "is the excess positive?" It is:
 *
 *     IS THE REAL EXCESS DISTINGUISHABLE FROM A RANDOM SUBSET OF
 *     THE SAME SHAPE?
 *
 * THE TEST
 * --------
 * Draw 2000 random subsets of the tape arm, each with the SIGNAL
 * arm's exact size and per-symbol counts, and measure each one's
 * "excess" over the whole tape arm. Then report where the REAL
 * signal's excess falls in that distribution.
 *
 *   - at the 5th percentile or below  -> the signal beats a random
 *     subset of its own shape, and the gate carries information
 *   - in the middle                   -> the excess is the subset
 *     artefact, and the gate carries nothing
 *
 * A PLACEBO THAT FAILS TO BEAT ITS OWN PLACEBO IS NOT A FINDING.
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
const TAKER = 0.0006;
const ROUND_TRIP = TAKER * 2;
const DRAWS = 2000;

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

function ticketFor(r) {
  const atrPct = Number(r.tapeAtrPct);
  if (!(atrPct > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const avgEntry = tapeSideFromRow(r) === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  return {
    atrPct, stopFrac, tpFrac, avgEntry,
    stopPrice: tapeSideFromRow(r) === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac),
    targetPrice: tapeSideFromRow(r) === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac),
  };
}

function resolve(r, ticket) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = tapeSideFromRow(r) === "long";
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { pnlPct: -ticket.stopFrac - ROUND_TRIP };
    if (hitTp) return { pnlPct: ticket.tpFrac - ROUND_TRIP };
    if (hitSl) return { pnlPct: -ticket.stopFrac - ROUND_TRIP };
  }
  const lastBar = b[end - 1];
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { pnlPct: movePct - ROUND_TRIP };
}

/** Every resolvable trade: the P&L in percent of equity. */
function trades(arm) {
  const out = [];
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) continue;
    const o = resolve(r, t);
    if (!o) continue;
    out.push({ pair: r.pair, ts: r.ts, pnlEq: o.pnlPct * RHO * 100 });
  }
  return out;
}

console.log("═".repeat(94));
console.log("THE SUBSET ARTEFACT — does the live-gate arm beat a RANDOM subset of its own shape?");
console.log("═".repeat(94));

const signalTrades = trades(liveArm);
const tapeTrades = trades(tapeArm);
const tapeMean = mean(tapeTrades.map((t) => t.pnlEq));
const signalMean = mean(signalTrades.map((t) => t.pnlEq));

console.log(`the live-gate arm (the subset): ${liveArm.length} observations -> ${signalTrades.length} resolved`);
console.log(`the tape arm (the superset):   ${tapeArm.length} observations -> ${tapeTrades.length} resolved`);
console.log(`the signal arm IS a subset of the tape arm: TRUE (the gate only removes rows)`);
console.log(`\nthe tape arm's mean:      ${fmt(tapeMean)} % of equity per trade`);
console.log(`the signal arm's mean:    ${fmt(signalMean)} % of equity per trade`);
const realExcess = signalMean - tapeMean;
console.log(`the REAL excess:          ${fmt(realExcess)} pp of equity per trade`);

// ── the size-matched, symbol-preserving placebo ──
// The signal arm's exact size and its exact per-symbol counts.
const perSymbol = new Map();
for (const t of signalTrades) perSymbol.set(t.pair, (perSymbol.get(t.pair) ?? 0) + 1);
const byPair = new Map();
for (const t of tapeTrades) {
  if (!byPair.has(t.pair)) byPair.set(t.pair, []);
  byPair.get(t.pair).push(t);
}

const rng = (() => {
  let seed = 0x9e3779b9;
  return () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
})();

const placeboExcesses = [];
for (let d = 0; d < DRAWS; d++) {
  const picked = [];
  for (const [pair, n] of perSymbol) {
    const pool = byPair.get(pair) ?? [];
    // If the symbol has fewer trades than the signal arm used, take
    // what is there (and the draw is still the same shape).
    const copy = [...pool];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    for (const t of copy.slice(0, n)) picked.push(t);
  }
  if (!picked.length) continue;
  placeboExcesses.push(mean(picked.map((t) => t.pnlEq)) - tapeMean);
}
placeboExcesses.sort((a, b) => a - b);
const pct = (v) => {
  let below = 0;
  for (const x of placeboExcesses) if (x <= v) below++;
  return (below / placeboExcesses.length) * 100;
};
const p05 = placeboExcesses[Math.floor(placeboExcesses.length * 0.05)];
const p50 = placeboExcesses[Math.floor(placeboExcesses.length * 0.5)];
const p95 = placeboExcesses[Math.floor(placeboExcesses.length * 0.95)];

console.log(`\n── THE SIZE-MATCHED, SYMBOL-PRESERVING PLACEBO (${DRAWS} draws) ──`);
console.log(`  each draw: a random subset of the tape arm with the signal arm's`);
console.log(`  exact size and its exact per-symbol counts`);
console.log(`  placebo excess: median ${fmt(p50)} | p05 ${fmt(p05)} | p95 ${fmt(p95)}`);
console.log(`  the REAL excess ${fmt(realExcess)} sits at the ${fmt(pct(realExcess), 1)}th percentile`);
console.log("");
if (pct(realExcess) <= 5) {
  console.log("  VERDICT: the real excess BEATS the placebo — the gate carries information.");
} else if (pct(realExcess) >= 50) {
  console.log("  VERDICT: the real excess is INDISTINGUISHABLE from a random subset of its own");
  console.log("           shape. The 'excess' is the SUBSET ARTEFACT, not an edge. The gate");
  console.log("           carries no information the tape's own direction does not.");
} else {
  console.log("  VERDICT: the real excess is in the middle of the placebo distribution.");
  console.log("           The gate does not beat a random subset of its own shape.");
}
console.log("");
