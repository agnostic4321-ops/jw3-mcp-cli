#!/usr/bin/env node
/**
 * THE CLUSTERING TEST THAT DECIDES IT.
 *
 * A REPLICATION AGENT FOUND THE CRUX (docs/research/geometry-replication.md):
 *
 *   "The ticket holds for up to 4 hours, so trades opened 5 minutes
 *    apart share the same entry, the same path and the same exit for
 *    most of their life. A 5-minute cluster counts 3144 'independent'
 *    observations where the window contains only 84 genuinely
 *    independent 4-hour trade windows. The excess was carried by
 *    overlapping trades."
 *
 * That applies directly to the live-gate arm, and it is why every
 * measurement of it so far has been over-counted: the arm's
 * cluster-mean t-statistic has used 5-MINUTE buckets, but the ticket
 * it measures holds for 240 minutes. Two signals in the same 4-hour
 * window are not two observations of the trade — they are one trade
 * seen twice, and they share the path that decides the outcome.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 * It re-measures the arm's excess over the unconditional control at
 * FOUR cluster widths and prints the t at each:
 *
 *   5 minutes  — the collector's round. WRONG for a 4-hour ticket.
 *   30 minutes
 *   1 hour
 *   4 hours    — the ticket's own holding period. The honest one.
 *
 * A result that only exists at 5 minutes is a result about
 * overlapping trades.
 *
 * It also reports the INDEPENDENT CLUSTER COUNT at each width, because
 * the bar is n >= 30 independent clusters, and the answer may be that
 * the arm is simply not measurable yet.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { isTargetWrongSide } from "./ticket-fill.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const ATR_MULT_STOP = 0.9;
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16; // 16 x 15m = 240 minutes
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const TAKER = 0.0006;
const ROUND_TRIP = TAKER * 2;

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
  const stopPrice = tapeSideFromRow(r) === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = tapeSideFromRow(r) === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, stopFrac, tpFrac, avgEntry, last, stopPrice, targetPrice };
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
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", pnlPct: movePct - ROUND_TRIP };
}

/** The per-trade P&L in percent of equity, for every resolvable row. */
function perTrade(arm) {
  const out = [];
  for (const r of arm) {
    const ticket = ticketFor(r);
    if (!ticket) continue;
    const o = resolve(r, ticket);
    if (!o) continue;
    out.push({ ...o, ts: r.ts, pair: r.pair, side: tapeSideFromRow(r), pnlEq: o.pnlPct * RHO * 100 });
  }
  return out;
}

/**
 * The cluster-mean difference between the arm and the control, at a
 * given cluster width. The control is the tape-only arm with the
 * arm's own rows removed, so the two arms never share an observation.
 */
function pairedExcess(armTrades, controlTrades, clusterMs) {
  // Bucket every trade by its cluster.
  const bucket = (t) => Math.floor(t.ts / clusterMs);
  const armBy = new Map();
  for (const t of armTrades) {
    const b = bucket(t);
    if (!armBy.has(b)) armBy.set(b, []);
    armBy.get(b).push(t);
  }
  const ctlBy = new Map();
  for (const t of controlTrades) {
    const b = bucket(t);
    if (!ctlBy.has(b)) ctlBy.set(b, []);
    ctlBy.get(b).push(t);
  }
  // Only the clusters where BOTH arms have observations can be paired.
  const diffs = [];
  for (const [b, aTrades] of armBy) {
    const cTrades = ctlBy.get(b);
    if (!cTrades || !cTrades.length) continue;
    diffs.push(mean(aTrades.map((t) => t.pnlEq)) - mean(cTrades.map((t) => t.pnlEq)));
  }
  const m = mean(diffs);
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  return { n: diffs.length, excess: m, se, t: se > 0 ? m / se : 0 };
}

console.log("═".repeat(96));
console.log("THE CLUSTERING TEST — the ticket holds 4 hours, so the clusters must be 4 hours");
console.log("═".repeat(96));

const armTrades = perTrade(liveArm);
const armKeys = new Set(liveArm.map((r) => `${r.pair}|${r.ts}`));
const controlTrades = perTrade(tapeArm.filter((r) => !armKeys.has(`${r.pair}|${r.ts}`)));

console.log(`the live-gate arm: ${liveArm.length} observations -> ${armTrades.length} resolved`);
console.log(`the control arm:   ${tapeArm.length} observations -> ${controlTrades.length} resolved (the arm's rows removed)`);
const spanH = (maxBy(liveArm, (r) => r.ts) - minBy(liveArm, (r) => r.ts)) / 3600000;
console.log(`the span: ${spanH.toFixed(2)} hours`);

const WIDTHS = [
  { label: "5 minutes (the collector's round)", ms: 300_000 },
  { label: "30 minutes", ms: 1_800_000 },
  { label: "1 hour", ms: 3_600_000 },
  { label: "4 hours (the ticket's holding period)", ms: 14_400_000 },
];

console.log("\n  cluster width                     clusters  paired  excess %eq      se        t      bar (30 clusters)");
console.log("  " + "─".repeat(94));
for (const w of WIDTHS) {
  const totalClusters = new Set(liveArm.map((r) => Math.floor(r.ts / w.ms))).size;
  const p = pairedExcess(armTrades, controlTrades, w.ms);
  const clears = p.t >= 2 && p.excess > 0 ? "CLEARS" : (p.n < 30 ? "not judgeable" : "no");
  console.log(
    `  ${w.label.padEnd(32)} ${String(totalClusters).padStart(7)} ${String(p.n).padStart(7)} ` +
    `${fmt(p.excess).padStart(11)} ${fmt(p.se).padStart(9)} ${fmt(p.t).padStart(8)}   ${clears}`,
  );
}

console.log("\n  THE ARM'S OWN EV at each cluster width (does the arm even pay?):");
for (const w of WIDTHS) {
  const by = new Map();
  for (const t of armTrades) {
    const b = Math.floor(t.ts / w.ms);
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(t);
  }
  const means = [...by.values()].map((g) => mean(g.map((t) => t.pnlEq)));
  const m = mean(means);
  const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
  console.log(
    `  ${w.label.padEnd(32)} clusters ${String(by.size).padStart(3)}  EV ${fmt(m).padStart(8)} %eq  se ${fmt(se).padStart(7)}  t ${fmt(se > 0 ? m / se : 0).padStart(6)}`,
  );
}

console.log("\n  THE PLACEBO: the same arm's trades, with the direction flipped.");
console.log("  (a positive excess with a strongly negative placebo is beta, not edge)");
for (const w of [WIDTHS[0], WIDTHS[3]]) {
  const flipped = armTrades.map((t) => ({ ...t, pnlEq: -t.pnlEq }));
  const p = pairedExcess(flipped, controlTrades, w.ms);
  console.log(`  ${w.label.padEnd(32)} placebo excess ${fmt(p.excess).padStart(9)} %eq  t ${fmt(p.t).padStart(7)}`);
}
console.log("");
