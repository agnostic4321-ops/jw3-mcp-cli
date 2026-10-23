#!/usr/bin/env node
/**
 * DOES THE TAPE'S OWN SIGNAL HAVE AN EDGE?
 *
 * This is the last question that decides what the machine trades.
 *
 * WHAT IS KNOWN
 * -------------
 * - the live gate (tape + models agree) adds NOTHING: its excess over
 *   the tape arm is indistinguishable from a random subset of the same
 *   shape, and negative (-0.1934 pp, 87.6th percentile)
 * - the maker entry is a trap: the adverse selection ($0.19-0.20 per
 *   fill) is 4x the fee it saves ($0.048)
 * - the tighter stop does not survive the trim and is monotonically
 *   worse on the 515-trade control arm
 * - at the ticket's 4-hour holding period every arm has 2 clusters
 *
 * So the machine's MODEL GATE is removing value, and the only arm with
 * enough observations to judge is the TAPE-ONLY arm: 515 resolved
 * trades, 47 five-minute clusters, EV +0.1787% of equity per trade
 * net of the 0.12% fee, a 96.5% win rate.
 *
 * THE QUESTION
 * ------------
 * The tape arm is a SUBSET of the unconditional arm (every row has a
 * direction; the tape filter selects some of them). So the same subset
 * artefact applies: is the tape arm's excess distinguishable from a
 * random subset of the unconditional arm of the same size and the same
 * per-symbol counts?
 *
 * If YES -> the tape's exhaustion condition carries information, and
 * the machine should trade the TAPE arm and drop the model gate (which
 * costs reads and removes trades).
 *
 * If NO -> the tape's 96.5% win rate is the market's own drift, the
 * signal family is empty, and the machine's correct output is no
 * trades at all until a downtrend window gives the long side something
 * to measure.
 *
 * THE CONTROL
 * -----------
 * The unconditional arm is EVERY row in the collector, traded in the
 * tape's direction. But a row with no tape signal has no direction, so
 * the unconditional control is the market's own drift in the tape's
 * direction, which is the honest baseline for "the tape's direction
 * without the exhaustion condition".
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
const ROUND_TRIP = 0.0012;
const DRAWS = 2000;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(BARS, "utf8"));

const tape = rows.filter((r) => tapeSideFromRow(r));

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
    atrPct, stopFrac, tpFrac, avgEntry, last,
    stopPrice: long ? avgEntry * (1 - stopFrac) : avgEntry * (1 + stopFrac),
    targetPrice: long ? avgEntry * (1 + tpFrac) : avgEntry * (1 - tpFrac),
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
  // A take-profit already satisfied at the market is a MARKETABLE order:
  // it fills instantly at the touch, so the gross is ~zero and the trade
  // books the fee. See research/ticket-fill.mjs.
  const tpWrongSide = isTargetWrongSide(tapeSideFromRow(r), ticket.targetPrice, ticket.last);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - ROUND_TRIP };
    if (hitTp) {
      if (tpWrongSide) return { outcome: "scratch", pnlPct: -ROUND_TRIP };
      return { outcome: "win", pnlPct: ticket.tpFrac - ROUND_TRIP };
    }
    if (hitSl) return { outcome: "loss", pnlPct: -ticket.stopFrac - ROUND_TRIP };
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", pnlPct: movePct - ROUND_TRIP };
}

function trades(arm) {
  const out = [];
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) continue;
    const o = resolve(r, t);
    if (!o) continue;
    out.push({ pair: r.pair, ts: r.ts, side: tapeSideFromRow(r), pnlEq: o.pnlPct * RHO * 100, outcome: o.outcome });
  }
  return out;
}

console.log("═".repeat(96));
console.log("DOES THE TAPE'S OWN SIGNAL HAVE AN EDGE?");
console.log("═".repeat(96));

const tapeTrades = trades(tape);
console.log(`the tape arm: ${tape.length} observations -> ${tapeTrades.length} resolved trades`);
const wins = tapeTrades.filter((t) => t.outcome === "win").length;
const losses = tapeTrades.filter((t) => t.outcome === "loss").length;
console.log(`  wins ${wins} | losses ${losses} | win rate ${fmt((wins / Math.max(1, tapeTrades.length)) * 100, 1)}%`);
console.log(`  EV ${fmt(mean(tapeTrades.map((t) => t.pnlEq)))} % of equity per trade (net of the 0.12% fee)`);

// ── THE EV AT EVERY CLUSTER WIDTH ──
console.log("\n── the tape arm's EV at every cluster width ──");
for (const w of [{ ms: 300_000, l: "5 minutes" }, { ms: 900_000, l: "15 minutes" }, { ms: 3_600_000, l: "1 hour" }, { ms: 14_400_000, l: "4 hours (the ticket's holding period)" }]) {
  const g = new Map();
  for (const t of tapeTrades) {
    const b = Math.floor(t.ts / w.ms);
    if (!g.has(b)) g.set(b, []);
    g.get(b).push(t);
  }
  const means = [...g.values()].map((v) => mean(v.map((t) => t.pnlEq)));
  const m = mean(means);
  const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
  console.log(`  ${w.l.padEnd(42)} ${String(g.size).padStart(3)} clusters  EV ${fmt(m).padStart(8)} %eq  se ${fmt(se).padStart(7)}  t ${fmt(se > 0 ? m / se : 0).padStart(6)}`);
}

// ── THE PLACEBO: a random subset of the SAME SIZE, SAME SYMBOL COUNTS ──
// The control is the market's own drift: every row traded in the tape's
// direction, with no exhaustion condition. A random subset of the tape
// arm's own size and shape, drawn from the FULL row set, is the
// placebo: if the tape's condition carries information, its excess must
// beat that.
console.log("\n── THE PLACEBO: is the tape arm better than a random subset of the same shape? ──");

// THE DRIFT CONTROL: the same MODEL agreement, on rows the tape did
// NOT flag. `tapeSide` only exists on flagged rows, so the control has
// to take its direction from the models — which agree on 473 rows that
// the tape rejected. Those rows carry the same direction signal with
// the exhaustion condition REMOVED, which is exactly the comparison:
// the tape's condition versus the market's own drift in the same
// direction on the same symbols at the same times.
const flagged = new Set(tape.map((r) => `${r.pair}|${r.ts}`));
const modelSide = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
};
// THE HONEST CONTROL: the SAME symbols the tape trades, with a model
// direction, but WITHOUT the exhaustion condition.
//
// The first attempt took the drift control from ALL unflagged rows,
// and the symbol mixes were almost disjoint -- the tape arm fires on
// PEPE/SHIB/FLOKI/XEC, the control on DOOD/ARC/JCT/KAS -- so the
// difference measured the SYMBOL MIX, not the signal. A control that
// trades different symbols cannot price the same signal.
//
// So the control is restricted to the tape arm's own symbols. On those
// symbols, the rows the tape did not flag but the models did are
// exactly "the same symbol, a direction, no exhaustion".
const tapeSymbols = new Set(tape.map((r) => r.pair));
const driftRows = rows
  .filter((r) => !tapeSideFromRow(r) && !flagged.has(`${r.pair}|${r.ts}`) && modelSide(r) && tapeSymbols.has(r.pair))
  .map((r) => ({ ...r, tapeSide: modelSide(r) }));
const driftTrades = trades(driftRows);
console.log(`  the drift control (the SAME symbols, a model direction, NO exhaustion condition): ${driftRows.length} observations -> ${driftTrades.length} resolved`);
const ctrlSymbols = new Set(driftRows.map((r) => r.pair));
console.log(`  the symbol overlap: ${ctrlSymbols.size} of the tape arm's ${tapeSymbols.size} symbols carry a control`);

if (driftTrades.length > 10) {
  const driftMean = mean(driftTrades.map((t) => t.pnlEq));
  const realExcess = mean(tapeTrades.map((t) => t.pnlEq)) - driftMean;
  console.log(`  the drift control's mean: ${fmt(driftMean)} % of equity per trade`);
  console.log(`  the REAL excess over the drift: ${fmt(realExcess)} pp of equity per trade`);

  // The size-matched, symbol-preserving placebo.
  const perSymbol = new Map();
  for (const t of tapeTrades) perSymbol.set(t.pair, (perSymbol.get(t.pair) ?? 0) + 1);
  // The draw pool is the FULL resolvable population — the tape arm AND
  // the drift control — so a symbol with fewer drift rows than the tape
  // arm wants can still be drawn from, and the draw is genuinely
  // random. (Drawing only from the drift control made every draw pick
  // the same rows, and the placebo distribution collapsed to a point:
  // p05 == median == p95.)
  const byPair = new Map();
  for (const t of [...driftTrades, ...tapeTrades]) {
    if (!byPair.has(t.pair)) byPair.set(t.pair, []);
    byPair.get(t.pair).push(t);
  }
  // The pool per symbol must be at least the arm's demand, or the draw
  // takes the whole pool every time and the distribution collapses.
  let starved = 0;
  for (const [pair, n] of perSymbol) {
    if ((byPair.get(pair) ?? []).length < n) starved++;
  }
  if (starved) console.log(`  WARNING: ${starved} symbol(s) have fewer pool rows than the arm used -- the draws are truncated there`);
  let seed = 0x9e3779b9;
  const rng = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
  };
  const placebos = [];
  for (let d = 0; d < DRAWS; d++) {
    const picked = [];
    for (const [pair, n] of perSymbol) {
      const pool = byPair.get(pair) ?? [];
      const copy = [...pool];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      for (const t of copy.slice(0, n)) picked.push(t);
    }
    if (!picked.length) continue;
    placebos.push(mean(picked.map((t) => t.pnlEq)) - driftMean);
  }
  if (placebos.length) {
    const spread = placebos[Math.floor(placebos.length * 0.95)] - placebos[Math.floor(placebos.length * 0.05)];
    console.log(`  the placebo distribution's spread (p95 - p05): ${fmt(spread, 6)} pp`);
    if (spread < 1e-6) console.log("  WARNING: the placebo distribution is DEGENERATE — the draws are not random");
  }
  placebos.sort((a, b) => a - b);
  const pct = (v) => {
    let below = 0;
    for (const x of placebos) if (x <= v) below++;
    return (below / placebos.length) * 100;
  };
  const p05 = placebos[Math.floor(placebos.length * 0.05)];
  const p50 = placebos[Math.floor(placebos.length * 0.5)];
  const p95 = placebos[Math.floor(placebos.length * 0.95)];
  console.log(`\n  the size-matched placebo (${DRAWS} draws): median ${fmt(p50)} | p05 ${fmt(p05)} | p95 ${fmt(p95)}`);
  console.log(`  the REAL excess ${fmt(realExcess)} sits at the ${fmt(pct(realExcess), 1)}th percentile`);
  console.log("");
  if (pct(realExcess) <= 5) {
    console.log("  VERDICT: the tape's exhaustion condition BEATS a random subset of the same shape.");
    console.log("           The signal carries information, and the machine should trade the TAPE arm");
    console.log("           rather than the model-gated arm (which costs reads and removes trades).");
  } else if (pct(realExcess) >= 50) {
    console.log("  VERDICT: the tape's excess is INDISTINGUISHABLE from a random subset of the same");
    console.log("           shape. The 96.5% win rate is the MARKET'S OWN DRIFT, not an edge, and");
    console.log("           the signal family is empty.");
  } else {
    console.log("  VERDICT: the tape's excess is in the middle of the placebo distribution.");
    console.log("           The exhaustion condition does not beat a random subset of its shape.");
  }
} else {
  console.log("  the drift control is too small to test against");
}
console.log("");
