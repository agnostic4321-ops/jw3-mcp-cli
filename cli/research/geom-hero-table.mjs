#!/usr/bin/env node
/**
 * THE FINAL TABLE — every geometry tried, in one place.
 *
 * The table the report needs: for each geometry, the TP, the stop, the R
 * multiple, the hold, the win rate, the break-even win rate, the net
 * expectancy, the excess over the unconditional same-direction control,
 * the cluster t, and the cluster count — on BOTH sides of the book.
 *
 * READ-ONLY.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "geom-hero-bars.json"), "utf8"));
const SNAPSHOT = join(SCRATCH, "geom-hero-snapshot.ndjson");
const TAKER_RT = 0.12;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};
const clusterMeans = (v, b) => {
  const by = new Map();
  for (let i = 0; i < v.length; i++) { const a = by.get(b[i] ?? i) ?? []; a.push(v[i]); by.set(b[i] ?? i, a); }
  return [...by.values()].map(mean);
};
const be = (tp, sl, f) => (sl + f) / (tp + sl);

const rows = readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const modelSide = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return j && l ? (j === l ? j : null) : (j || l);
};
const SIGNAL = rows.map((r) => ({ ...r, tape: tapeSideFromRow(r), model: modelSide(r) })).filter((r) => r.tape && r.model && r.model === r.tape);
const STRICT = rows.filter((r) => r.side && r.tapeSide && r.tapeSide === r.side && r.jevUncertain === false);
const CONTROL = rows.map((r) => ({ ...r, tape: tapeSideFromRow(r) })).filter((r) => r.tape && r.tape === "short");
const tsAll = SIGNAL.map((r) => r.ts).sort((a, b) => a - b);
const MID = tsAll[Math.floor(tsAll.length / 2)];

function prepare(o, holdMin) {
  const bars = CACHE[o.pair];
  if (!bars?.length) return null;
  const entry = Number(o.price);
  if (!(entry > 0)) return null;
  const nBars = Math.round(holdMin / 5);
  const start = bars.findIndex((b) => b.t > o.ts);
  if (start < 0) return null;
  const end = start + nBars;
  if (end > bars.length) return null;
  const win = bars.slice(start, end);
  const runMax = [], runMin = [];
  let mx = -Infinity, mn = Infinity;
  for (const b of win) { mx = Math.max(mx, b.h); mn = Math.min(mn, b.l); runMax.push(mx); runMin.push(mn); }
  const close = win[win.length - 1].c;
  const long = o.dir === "long";
  return { entry, long, runMax, runMin, mark: (long ? (close - entry) / entry : (entry - close) / entry) * 100, ts: o.ts };
}
function resolve(prep, tp, sl) {
  const T = prep.long ? prep.entry * (1 + tp / 100) : prep.entry * (1 - tp / 100);
  const S = prep.long ? prep.entry * (1 - sl / 100) : prep.entry * (1 + sl / 100);
  for (let i = 0; i < prep.runMax.length; i++) {
    const hT = prep.long ? prep.runMax[i] >= T : prep.runMin[i] <= T;
    const hS = prep.long ? prep.runMin[i] <= S : prep.runMax[i] >= S;
    if (hT && hS) return "loss";
    if (hT) return "win";
    if (hS) return "loss";
  }
  return "time";
}
function arm(set, hold, tp, sl, flip = false) {
  const trades = [];
  for (const o of set) {
    const p = prepare(o, hold);
    if (!p) continue;
    const long = flip ? !p.long : p.long;
    const q = { ...p, long };
    const kind = resolve(q, tp, sl);
    const mark = flip ? -p.mark : p.mark;
    const pnl = kind === "win" ? tp - TAKER_RT : kind === "loss" ? -sl - TAKER_RT : mark - TAKER_RT;
    trades.push({ kind, pnl, bucket: Math.floor(o.ts / 300000), ts: o.ts, first: o.ts < MID });
  }
  return trades;
}
function stat(trades) {
  const w = trades.filter((t) => t.kind === "win").length;
  const l = trades.filter((t) => t.kind === "loss").length;
  const res = w + l;
  const pnl = trades.map((t) => t.pnl);
  const cm = clusterMeans(pnl, trades.map((t) => t.bucket));
  return {
    n: trades.length, w, l, t: trades.filter((x) => x.kind === "time").length,
    winRate: res ? w / res : 0,
    ev: mean(pnl), clusters: cm.length, clusterMean: mean(cm), clusterSe: se(cm),
    evResolved: mean(trades.filter((x) => x.kind !== "time").map((x) => x.pnl)),
    evTime: mean(trades.filter((x) => x.kind === "time").map((x) => x.pnl)),
    pnl, trades,
  };
}

const GRID_TP = [0.3, 0.45, 0.6, 0.9, 1.2, 1.5];
const GRID_SL = [0.4, 0.6, 0.8, 1.0, 1.2, 1.4];
const HOLDS = [15, 30, 60, 120];

const table = [];
for (const hold of HOLDS) {
  for (const tp of GRID_TP) {
    for (const sl of GRID_SL) {
      const s = stat(arm(SIGNAL, hold, tp, sl));
      if (!s.n) continue;
      const c = stat(arm(CONTROL, hold, tp, sl));
      const r = stat(arm(SIGNAL, hold, tp, sl, true));
      const d = s.clusterMean - c.clusterMean;
      const sd = Math.sqrt(s.clusterSe ** 2 + c.clusterSe ** 2);
      const sorted = [...s.pnl].sort((a, b) => a - b);
      table.push({
        hold, tp, sl, r: tp / sl,
        winRate: s.winRate, be: be(tp, sl, TAKER_RT),
        ev: s.ev, evEquity: s.ev * (59.0 / 57.35),
        excess: d, t: sd > 0 ? d / sd : 0, clusters: s.clusters,
        n: s.n, w: s.w, l: s.l, time: s.t,
        controlEv: c.ev, controlWinRate: c.winRate, controlClusters: c.clusters,
        reverseEv: r.ev, reverseWinRate: r.winRate,
        evResolved: s.evResolved, evTime: s.evTime,
        trimWorst: mean(sorted.slice(3)) - c.ev,
        trimBest: mean(sorted.slice(0, sorted.length - 3)) - c.ev,
        stopFires: (s.l / s.n) * 100,
      });
    }
  }
}

console.log("═══ THE FULL TABLE — 144 geometries, taker 0.12% round trip ═══");
console.log("  EV is % of NOTIONAL; EV/eq is % of equity at the ticket's 1.029x exposure.");
console.log("  'stop%' is how often the stop is actually reached — a stop that never");
console.log("  fires is not a stop, it is a wider time exit.");
console.log();
console.log("   hold   TP%   SL%   1:R     n  W   L  time  stop%   win%     BE%    EV/not   EV/eq  control   EXCESS      t  clus  t_exitEV  rev.EV");
for (const g of table) {
  console.log(
    `  ${String(g.hold + "m").padStart(5)} ${String(g.tp).padStart(5)} ${String(g.sl).padStart(5)} ${(1 / g.r).toFixed(2).padStart(5)} ${String(g.n).padStart(4)} ${String(g.w).padStart(3)} ${String(g.l).padStart(3)} ${String(g.time).padStart(5)} ${g.stopFires.toFixed(0).padStart(5)}% ${(g.winRate * 100).toFixed(1).padStart(6)} ${(g.be * 100).toFixed(1).padStart(7)} ${(g.ev >= 0 ? "+" : "") + g.ev.toFixed(4)} ${(g.evEquity >= 0 ? "+" : "") + g.evEquity.toFixed(4)} ${(g.controlEv >= 0 ? "+" : "") + g.controlEv.toFixed(4)} ${(g.excess >= 0 ? "+" : "") + g.excess.toFixed(4)} ${g.t.toFixed(2).padStart(6)} ${String(g.clusters).padStart(5)} ${(g.evTime >= 0 ? "+" : "") + g.evTime.toFixed(3)} ${(g.reverseEv >= 0 ? "+" : "") + g.reverseEv.toFixed(3)}`,
  );
}
console.log();
const withBar = table.filter((g) => g.clusters >= 30);
console.log(`  geometries with >= 30 clusters: ${withBar.length} of ${table.length}`);
console.log(`  ...positive EV:                 ${withBar.filter((g) => g.ev > 0).length}`);
console.log(`  ...positive EV AND excess>0 AND t>=2: ${withBar.filter((g) => g.ev > 0 && g.excess > 0 && g.t >= 2).length}`);
console.log(`  ...AND the unselected time-exit subset also pays: ${withBar.filter((g) => g.ev > 0 && g.excess > 0 && g.t >= 2 && g.evTime > 0).length}`);
console.log();
writeFileSync(join(SCRATCH, "geom-hero-table.json"), JSON.stringify(table, null, 2));
console.log(`  written to ${join(SCRATCH, "geom-hero-table.json")}`);
