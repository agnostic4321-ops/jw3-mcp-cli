#!/usr/bin/env node
/**
 * THE RECONCILIATION, AND THE BOOK IMBALANCE AS A TRADE.
 *
 * ══ AN APPARENT CONTRADICTION TO RESOLVE ══
 *
 * The exhaustion arm's FORWARD RETURN at 15m and 60m is WORSE than the
 * unconditional control (t = -2.22 and t = -3.26), yet its TICKET has a
 * strongly positive excess (t = 8.15). Both can be true, and the
 * distinction is the whole point of the ticket geometry:
 *
 *   - the ticket wins on a SMALL move in the trade's direction and
 *     loses on a LARGE move against it (a ~1:3.4 R:R);
 *   - so an arm whose MEDIAN move is slightly adverse can still have a
 *     positive ticket expectancy, because the losses are rare and the
 *     wins are frequent.
 *
 * That is a real property of the edge, and it is also a WARNING: the
 * edge is the TICKET's geometry, not a directional forecast. It is
 * fragile — it needs the win rate above break-even, and break-even is
 * 85% on this ticket.
 *
 * This script measures the forward return at EVERY horizon for the
 * exhaustion arm, so the reader can see where the sign flips, and then
 * measures the book-imbalance arms AS TRADES, with dollars.
 *
 * READ-ONLY. Local files only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRATCH, loadRows, loadBars, mean, stdev, fmt, bucketOf, hourBucketOf,
  NOTIONAL, EQUITY, RHO, ROUND_TRIP, FEE_USD, rng,
} from "./lib.mjs";
import { measureArm, tradeExcess, trimTrade, fmtArm } from "./trade.mjs";
import { marketTicket, researchTicket } from "./ticket.mjs";

// ══ the collector's own data (the book imbalance) ══
const conf = loadRows(join(SCRATCH, "oflow/conf-frozen.json"));
const kbars = loadBars(join(SCRATCH, "oflow/bars-frozen.json"));
const tapeSideOf = (r) => {
  const vratio = Number(r.tapeVratio ?? 1);
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  if (vratio < 0.85 && oh < 8) return "short";
  if (vratio < 0.85 && ol < 8) return "long";
  return null;
};

function fwd(r, H) {
  const b = kbars[r.pair];
  if (!b || !b.length) return null;
  let i = -1;
  for (let k = 0; k < b.length; k++) if (b[k].t > r.ts) { i = k; break; }
  if (i < 0) return null;
  const n = Math.max(1, Math.round(H / 15));
  const j = i + n - 1;
  if (j >= b.length) return null;
  return (b[j].c - r.price) / r.price;
}

console.log("══════════════════════════════════════════════════════════════");
console.log(" PART A — THE EXHAUSTION ARM'S FORWARD RETURN, EVERY HORIZON");
console.log(" (the collector's own rows; the machine's signal)");
console.log("══════════════════════════════════════════════════════════════");
console.log("  horizon   n     clusters   arm mean%   control mean%   excess%    t");
for (const H of [15, 30, 60, 120, 240]) {
  const usable = conf.filter((r) => tapeSideOf(r) && fwd(r, H) != null);
  if (usable.length < 30) { console.log(`  ${String(H).padEnd(7)}m  too few (${usable.length})`); continue; }
  // the cluster-mean excess, per row, in the row's own direction
  const byCluster = new Map();
  for (const r of usable) {
    const b = bucketOf(r.ts);
    if (!byCluster.has(b)) byCluster.set(b, []);
    byCluster.get(b).push(fwd(r, H));
  }
  const ctl = new Map();
  for (const b of byCluster.keys()) ctl.set(b, mean(byCluster.get(b)));
  const perRow = usable.map((r) => {
    const sign = tapeSideOf(r) === "long" ? 1 : -1;
    const c = ctl.get(bucketOf(r.ts));
    return sign * (fwd(r, H) - c) * 100;
  });
  const byB = new Map();
  usable.forEach((r, i) => {
    const b = bucketOf(r.ts);
    if (!byB.has(b)) byB.set(b, []);
    byB.get(b).push(perRow[i]);
  });
  const diffs = [...byB.values()].map(mean);
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  const m = mean(diffs);
  const armMean = mean(usable.map((r) => (tapeSideOf(r) === "long" ? 1 : -1) * fwd(r, H) * 100));
  console.log(`  ${String(H).padEnd(7)}m  ${String(usable.length).padStart(5)}  ${String(diffs.length).padStart(7)}   ${armMean.toFixed(4).padStart(9)}   ${fmt(mean([...ctl.values()]) * 100).padStart(12)}   ${m.toFixed(4).padStart(8)}  ${fmt(m / se, 2).padStart(6)}`);
}

// ══════════════════════════════════════════════════════════════════════
// PART B — THE BOOK IMBALANCE AS A TRADE (the dollars)
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" PART B — THE BOOK IMBALANCE AS A TRADE, IN DOLLARS");
console.log(" (the collector's own rows; the market-anchored ticket)");
console.log("══════════════════════════════════════════════════════════════");

function resolveChecked(tk, dir, bars, ts, holdBars) {
  if (!tk || !bars || !bars.length) return null;
  let i = -1;
  for (let k = 0; k < bars.length; k++) if (bars[k].t > ts) { i = k; break; }
  if (i < 0) return null;
  const end = Math.min(bars.length, i + holdBars);
  if (end - i < 2) return null;
  const long = dir === "long";
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= tk.targetPrice : bar.l <= tk.targetPrice;
    const hitSl = long ? bar.l <= tk.stopPrice : bar.h >= tk.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -tk.stopFrac - ROUND_TRIP, wick: false };
    if (hitTp) {
      const closeHit = long ? bar.c >= tk.targetPrice : bar.c <= tk.targetPrice;
      return { outcome: "win", bars: k - i + 1, pnlPct: tk.tpFrac - ROUND_TRIP, wick: !closeHit };
    }
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -tk.stopFrac - ROUND_TRIP, wick: false };
  }
  const lb = bars[end - 1];
  const mv = long ? (lb.c - tk.avgEntry) / tk.avgEntry : (tk.avgEntry - lb.c) / tk.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: mv - ROUND_TRIP, wick: false };
}

function toTrades(rows, dirOf, ticketFn = marketTicket, hold = 16) {
  const trades = [];
  for (const r of rows) {
    const dir = dirOf(r);
    const tk = ticketFn(r.tapeAtrPct, r.price, dir);
    if (!tk) continue;
    const res = resolveChecked(tk, dir, kbars[r.pair], r.ts, hold);
    if (!res) continue;
    trades.push({ ...res, dir, sym: r.pair, ts: r.ts, bucket: bucketOf(r.ts), pnlUsd: res.pnlPct * NOTIONAL });
  }
  return trades;
}

function tradeReport(label, armRows, dirOf, ctlRows, ctlDir) {
  const trades = toTrades(armRows, dirOf);
  const ctl = toTrades(ctlRows, ctlDir);
  if (trades.length < 20) { console.log(`\n  ${label}: n=${trades.length} TOO FEW`); return null; }
  const m = measureArm(trades, label);
  const cm = measureArm(ctl, `${label} CTL`);
  const ex = tradeExcess(trades, ctl);
  const tm = trimTrade(ex.diffs, 3);
  const winN = trades.filter((t) => t.outcome === "win").length;
  const wicks = trades.filter((t) => t.outcome === "win" && t.wick).length;
  const bySym = new Map();
  for (const t of trades) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  console.log(`\n  ══ ${label} ══`);
  console.log(`     ARM      ${fmtArm(m)}`);
  console.log(`     CONTROL  ${fmtArm(cm)}`);
  console.log(`     EXCESS: ${(ex.mean * 100).toFixed(4)}% of equity  se ${(ex.se * 100).toFixed(4)}  t=${fmt(ex.t, 2)}  (${ex.n} paired clusters)`);
  console.log(`     TRIM worst-3/best-3: t=${fmt(tm.t, 2)} (n=${tm.n})  worst3=[${tm.worst3}] best3=[${tm.best3}]`);
  console.log(`     WICK CHECK: ${wicks}/${winN} wins touched the target only on the bar's high/low, never on its close`);
  console.log(`     symbols ${sorted.length}; largest ${sorted[0][0]} ${((sorted[0][1] / total) * 100).toFixed(1)}%  next ${sorted.slice(1, 4).map((s) => `${s[0]} ${((s[1] / total) * 100).toFixed(1)}%`).join(", ")}`);
  return { label, m, cm, ex, tm, trades };
}

const out = [];
console.log("\n  ── the book imbalance alone ──");
for (const th of [0.3, 0.5]) {
  const longs = conf.filter((r) => r.bookImbalance >= th);
  const shorts = conf.filter((r) => r.bookImbalance <= -th);
  if (longs.length > 20) out.push(tradeReport(`imb >= +${th} -> LONG`, longs, () => "long", conf, () => "long"));
  if (shorts.length > 20) out.push(tradeReport(`imb <= -${th} -> SHORT`, shorts, () => "short", conf, () => "short"));
}

console.log("\n  ── the DIVERGENCE: the book leans against the price ──");
for (const th of [0.3, 0.5]) {
  const divUp = conf.filter((r) => r.tapeChg > 0 && r.bookImbalance <= -th);
  const divDn = conf.filter((r) => r.tapeChg < 0 && r.bookImbalance >= th);
  if (divUp.length > 20) out.push(tradeReport(`DIVERGENCE price UP + book SHORT -> LONG (|imb|>=${th})`, divUp, () => "long", conf, () => "long"));
  if (divDn.length > 20) out.push(tradeReport(`DIVERGENCE price DOWN + book LONG -> SHORT (|imb|>=${th})`, divDn, () => "short", conf, () => "short"));
  // the CONVERGENT control
  const convUp = conf.filter((r) => r.tapeChg > 0 && r.bookImbalance >= th);
  if (convUp.length > 20) out.push(tradeReport(`CONVERGENCE price UP + book LONG -> LONG (|imb|>=${th})`, convUp, () => "long", conf, () => "long"));
}

console.log("\n  ── the exhaustion arm WITH and WITHOUT the book confirming ──");
const exh = conf.filter((r) => tapeSideOf(r));
if (exh.length > 20) out.push(tradeReport("EXHAUSTION alone", exh, (r) => tapeSideOf(r), conf, () => "short"));
for (const th of [0.3, 0.5]) {
  const agree = exh.filter((r) => {
    const t = tapeSideOf(r);
    return t === "long" ? r.bookImbalance >= th : r.bookImbalance <= -th;
  });
  if (agree.length > 20) out.push(tradeReport(`EXHAUSTION + the book CONFIRMS (|imb|>=${th})`, agree, (r) => tapeSideOf(r), conf, () => "short"));
  const disagree = exh.filter((r) => {
    const t = tapeSideOf(r);
    return t === "long" ? r.bookImbalance <= -th : r.bookImbalance >= th;
  });
  if (disagree.length > 20) out.push(tradeReport(`EXHAUSTION + the book CONTRADICTS (|imb|>=${th})`, disagree, (r) => tapeSideOf(r), conf, () => "short"));
}

writeFileSync(join(SCRATCH, "oflow/collector-trade-results.json"), JSON.stringify(
  out.filter(Boolean).map((r) => ({
    label: r.label, n: r.m.n, wins: r.m.wins, losses: r.m.losses, times: r.m.times,
    winRate: r.m.winRate, evUsd: r.m.evUsd, evPctEquity: r.m.evPctEquity, be: r.m.be,
    excessPctEquity: r.ex.mean * 100, excessT: r.ex.t, excessClusters: r.ex.n, trimT: r.tm.t,
  })), null, 2));
console.log("\n[pB] wrote collector-trade-results.json");
