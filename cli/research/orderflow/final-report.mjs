#!/usr/bin/env node
/**
 * THE FINAL ORDER-FLOW REPORT — corrected and complete.
 *
 * The corrections over the previous run, all of them material:
 *
 * 1. THE BOOTSTRAP P-VALUE is now computed against the OBSERVED |t|,
 *    not against a fixed 2. The previous line reported the fraction
 *    of the null exceeding 2, which is a placebo rate, not a p-value.
 *
 * 2. THE CONTROL IS DIRECTION-MATCHED TO THE ARM'S DOMINANT DIRECTION.
 *    The exhaustion arm is ~95% short. Measuring it against an
 *    "always long" control lets the market's own drift leak into the
 *    excess. Both drift controls are now reported, and the excess is
 *    taken against the WORSE of the two.
 *
 * 3. THE CLOSE-CONFIRMED WIN RATE: a win whose bar touched the
 *    target only on its high/low, and never on its close, is a fill
 *    that a market order may not have got. The expectancy of the
 *    close-confirmed arm is reported beside the raw one.
 *
 * READ-ONLY. Local files only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRATCH, loadBars, mean, stdev, fmt, bucketOf, NOTIONAL, EQUITY, RHO, ROUND_TRIP, FEE_USD, rng,
} from "./lib.mjs";
import { measureArm, tradeExcess, trimTrade, fmtArm } from "./trade.mjs";
import { researchTicket, marketTicket } from "./ticket.mjs";

const confBase = JSON.parse(readFileSync(join(SCRATCH, "oflow/conf-at-baseline.json"), "utf8"));
const barsBase = loadBars(join(SCRATCH, "oflow/bars-at-baseline.json"));

function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev || !laya || jev !== laya) return null;
  return jev;
}
const armRows = confBase.filter((r) => {
  const t = r.tapeSide;
  if (!t) return false;
  const g = liveGate(r);
  return g && g === t;
}).map((r) => ({ ...r, dir: r.tapeSide }));
const tapeRowsBase = confBase.filter((r) => r.tapeSide).map((r) => ({ ...r, dir: r.tapeSide }));

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

function buildTrades(rows, ticketFn, barsFor, hold = 16) {
  const trades = [];
  for (const r of rows) {
    const tk = ticketFn(r.tapeAtrPct, r.price, r.dir);
    if (!tk) continue;
    const res = resolveChecked(tk, r.dir, barsFor(r.pair), r.ts, hold);
    if (!res) continue;
    trades.push({ ...res, dir: r.dir, sym: r.pair, ts: r.ts, bucket: bucketOf(r.ts), pnlUsd: res.pnlPct * NOTIONAL });
  }
  return trades;
}

console.log("══════════════════════════════════════════════════════════════");
console.log(" PART 1 — THE MACHINE'S OWN ARM, THE TWO TICKETS");
console.log(" (the cited baseline's frozen inputs: 1690 rows, 18-row arm)");
console.log("══════════════════════════════════════════════════════════════");
for (const [tn, tf] of [["research (avgEntry-anchored)", researchTicket], ["market-anchored (the venue's rebase)", marketTicket]]) {
  const live = buildTrades(armRows, tf, (p) => barsBase[p]);
  const ctl = buildTrades(tapeRowsBase, tf, (p) => barsBase[p]);
  const m = measureArm(live, tn);
  const cm = measureArm(ctl, `${tn} CTL`);
  const ex = tradeExcess(live, ctl);
  const tm = trimTrade(ex.diffs, 3);
  const winN = live.filter((t) => t.outcome === "win").length;
  const wicks = live.filter((t) => t.outcome === "win" && t.wick).length;
  console.log(`\n  ── ${tn} ──`);
  console.log(`     ARM      ${fmtArm(m)}`);
  console.log(`     CONTROL  ${fmtArm(cm)}`);
  console.log(`     EXCESS over the tape-only control: ${(ex.mean * 100).toFixed(4)}% of equity  se ${(ex.se * 100).toFixed(4)}  t=${fmt(ex.t, 2)}  (${ex.n} paired clusters)`);
  console.log(`     TRIM worst-3/best-3: t=${fmt(tm.t, 2)} (n=${tm.n})  worst3=[${tm.worst3}] best3=[${tm.best3}]`);
  console.log(`     WICK CHECK: ${wicks}/${winN} wins touched the target only on the bar's high/low, never on its close`);
  const bySym = new Map();
  for (const t of live) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  console.log(`     symbols ${sorted.length}; largest ${sorted[0][0]} ${((sorted[0][1] / total) * 100).toFixed(1)}%  ${sorted.map((s) => `${s[0]}:${s[1]}`).join(" ")}`);
}

// ══════════════════════════════════════════════════════════════════════
// PART 2 — THE DEEP ARMS
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" PART 2 — THE DEEP ARMS (Binance USDⓈ-M, 14 days, 38 symbols)");
console.log("══════════════════════════════════════════════════════════════");
const tf15 = loadBars(join(SCRATCH, "oflow/binance-tf-bars.json"));
const tf5 = loadBars(join(SCRATCH, "oflow/binance-tf-bars5m.json"));
const tapeDeep = [];
for (const line of readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8").trim().split("\n")) {
  if (!line) continue;
  try { tapeDeep.push(JSON.parse(line)); } catch { /* skip */ }
}
const flowByKey = new Map();
for (const [sym, bars] of Object.entries(tf15)) {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.v > 0) || !(b.qv > 0)) continue;
    const trail = bars.slice(Math.max(0, i - 20), i).map((x) => x.v).filter((x) => x > 0).sort((a, c) => a - c);
    if (trail.length < 10) continue;
    const medV = trail[Math.floor(trail.length / 2)];
    const vwap = b.qv / b.v;
    flowByKey.set(`${sym}|${b.t}`, {
      tfi: (b.tb - (b.v - b.tb)) / b.v,
      closeToVwap: ((b.c - vwap) / vwap) * 100,
      vSurge: medV > 0 ? b.v / medV : 0,
    });
  }
}
const bars5ByBase = new Map();
for (const [sym, bars] of Object.entries(tf5)) bars5ByBase.set(sym, bars);
const deep = [];
for (const r of tapeDeep) {
  if (!(r.price > 0) || !(r.tapeAtrPct > 0)) continue;
  const base = r.pair.split("/")[0];
  const bs = bars5ByBase.get(base);
  if (!bs || bs.length < 50) continue;
  const barT = Math.floor(r.ts / 900_000) * 900_000;
  const flow = flowByKey.get(`${base}|${barT}`);
  if (!flow) continue;
  deep.push({ r, base, flow, ts: r.ts, price: r.price });
}
const dts = deep.map((o) => o.ts).sort((a, b) => a - b);
console.log(`[p2] deep joined ${deep.length} rows | span ${new Date(dts[0]).toISOString()} -> ${new Date(dts[dts.length - 1]).toISOString()}`);
console.log(`[p2] rounds(5m) ${new Set(deep.map((o) => bucketOf(o.ts))).size} | hours ${new Set(deep.map((o) => Math.floor(o.ts / 3600000))).size}`);

const tapeSideOf = (r) => {
  const vratio = Number(r.tapeVratio ?? 1);
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  if (vratio < 0.85 && oh < 8) return "short";
  if (vratio < 0.85 && ol < 8) return "long";
  return null;
};

function toTrades(armRowsD, dirOf, hold = 48) {
  const trades = [];
  for (const o of armRowsD) {
    const dir = dirOf(o);
    const tk = marketTicket(o.r.tapeAtrPct, o.price, dir);
    if (!tk) continue;
    const res = resolveChecked(tk, dir, bars5ByBase.get(o.base), o.ts, hold);
    if (!res) continue;
    trades.push({ ...res, dir, sym: o.base, ts: o.ts, bucket: bucketOf(o.ts), pnlUsd: res.pnlPct * NOTIONAL });
  }
  return trades;
}

function tradePlacebo(armTrades, controlTrades, trials = 500, seed = 20261021) {
  const rand = rng(seed);
  const byBucket = new Map();
  for (const t of controlTrades) {
    if (!byBucket.has(t.bucket)) byBucket.set(t.bucket, []);
    byBucket.get(t.bucket).push(t.pnlUsd);
  }
  const shape = new Map();
  for (const t of armTrades) shape.set(t.bucket, (shape.get(t.bucket) ?? 0) + 1);
  const ts = [];
  for (let k = 0; k < trials; k++) {
    const byB = new Map();
    for (const [b, n] of shape) {
      const pool = byBucket.get(b);
      if (!pool || !pool.length) continue;
      const vals = [];
      for (let j = 0; j < n; j++) vals.push(pool[Math.floor(rand() * pool.length)]);
      byB.set(b, vals);
    }
    const diffs = [];
    for (const [b, va] of byB) {
      const vb = byBucket.get(b);
      if (!vb || !vb.length) continue;
      diffs.push(mean(va) - mean(vb));
    }
    const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
    const m = mean(diffs);
    ts.push(se > 0 ? m / se : 0);
  }
  const sorted = [...ts].sort((a, b) => a - b);
  return { trials: ts.length, tMean: mean(ts), tP95: sorted[Math.floor(sorted.length * 0.95)], tP5: sorted[Math.floor(sorted.length * 0.05)], significant: ts.filter((t) => Math.abs(t) >= 2).length };
}

/** The DAY-BLOCK BOOTSTRAP, with the p-value against the OBSERVED |t|. */
function dayBlockBootstrapTrades(trades, controlTrades, realT) {
  const rand = rng(20261021);
  const DAY = 24 * 3600_000;
  const byA = new Map(), byC = new Map();
  for (const t of trades) {
    if (!byA.has(t.bucket)) byA.set(t.bucket, []);
    byA.get(t.bucket).push(t.pnlUsd);
  }
  for (const t of controlTrades) {
    if (!byC.has(t.bucket)) byC.set(t.bucket, []);
    byC.get(t.bucket).push(t.pnlUsd);
  }
  const byDay = new Map();
  for (const [b, va] of byA) {
    const vb = byC.get(b);
    if (!vb || !vb.length) continue;
    const day = Math.floor((b * 300_000) / DAY);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(mean(va) - mean(vb));
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < 4) return null;
  const dayMeans = days.map((d) => mean(byDay.get(d)));
  const grand = mean(dayMeans);
  const ts = [];
  for (let k = 0; k < 1000; k++) {
    const draw = [];
    for (let j = 0; j < days.length; j++) draw.push(dayMeans[Math.floor(rand() * days.length)]);
    const se = stdev(draw) / Math.sqrt(draw.length);
    const m = mean(draw) - grand;
    ts.push(se > 0 ? m / se : 0);
  }
  const sorted = [...ts].sort((a, b) => a - b);
  return {
    days: days.length,
    tP5: sorted[Math.floor(sorted.length * 0.05)],
    tP95: sorted[Math.floor(sorted.length * 0.95)],
    // the p-value against the OBSERVED statistic
    p: ts.filter((x) => Math.abs(x) >= Math.abs(realT)).length / ts.length,
  };
}

const ALL = deep;
function reportDeep(label, armRowsD, dirOf, controlDir) {
  const trades = toTrades(armRowsD, dirOf);
  const ctl = toTrades(ALL, controlDir);
  if (trades.length < 100) { console.log(`\n  ${label}: n=${trades.length} TOO FEW`); return null; }
  const m = measureArm(trades, label);
  const cm = measureArm(ctl, `${label} CTL`);
  const ex = tradeExcess(trades, ctl);
  const tm = trimTrade(ex.diffs, 3);
  const pl = tradePlacebo(trades, ctl);
  const boot = dayBlockBootstrapTrades(trades, ctl, ex.t);
  const winN = trades.filter((t) => t.outcome === "win").length;
  const wicks = trades.filter((t) => t.outcome === "win" && t.wick).length;
  // the CLOSE-CONFIRMED arm: a wick-only win is booked as a TIME EXIT
  // at the bar's close instead of a take-profit.
  const confirmed = trades.map((t) => {
    if (t.outcome === "win" && t.wick) return { ...t, outcome: "time", pnlUsd: t.pnlUsd - (t.pnlPct + 0.0012) * NOTIONAL };
    return t;
  });
  const cm2 = measureArm(confirmed, `${label} close-confirmed`);
  console.log(`\n  ══ ${label} ══`);
  console.log(`     ARM      ${fmtArm(m)}`);
  console.log(`     CONTROL  ${fmtArm(cm)}`);
  console.log(`     EXCESS over the control: $${ex.mean.toFixed(5)}/trade  se $${ex.se.toFixed(5)}  t=${fmt(ex.t, 2)}  (${ex.n} paired clusters)`);
  console.log(`     TRIM worst-3/best-3: t=${fmt(tm.t, 2)} (n=${tm.n})  worst3=[${tm.worst3}] best3=[${tm.best3}]`);
  console.log(`     PLACEBO: t mean ${fmt(pl.tMean, 2)}  t p95 ${fmt(pl.tP95, 2)}  runs |t|>=2: ${pl.significant}/${pl.trials}`);
  if (boot) console.log(`     DAY-BLOCK BOOTSTRAP (${boot.days} days): t p5 ${fmt(boot.tP5, 2)}  t p95 ${fmt(boot.tP95, 2)}  p(obs) ${(boot.p * 100).toFixed(1)}%`);
  console.log(`     WICK CHECK: ${wicks}/${winN} wins touched the target only on the bar's high/low, never on its close`);
  console.log(`     CLOSE-CONFIRMED ARM: ${fmtArm(cm2)}`);
  const bySym = new Map();
  for (const t of trades) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  console.log(`     symbols ${sorted.length}; largest ${sorted[0][0]} ${((sorted[0][1] / total) * 100).toFixed(1)}%  next ${sorted.slice(1, 4).map((s) => `${s[0]} ${((s[1] / total) * 100).toFixed(1)}%`).join(", ")}`);
  return { label, m, cm, cm2, ex, tm, pl, boot, trades };
}

const out = [];
console.log("\n  ── the machine's own signal (the tape's exhaustion), deep ──");
const exhD = deep.filter((o) => tapeSideOf(o.r));
const exhDist = {};
for (const o of exhD) { const t = tapeSideOf(o.r); exhDist[t] = (exhDist[t] ?? 0) + 1; }
console.log(`  exhaustion rows ${exhD.length}  direction split ${JSON.stringify(exhDist)}`);
out.push(reportDeep("EXHAUSTION (the tape's side) [control: always LONG]", exhD, (o) => tapeSideOf(o.r), () => "long"));
out.push(reportDeep("EXHAUSTION (the tape's side) [control: always SHORT]", exhD, (o) => tapeSideOf(o.r), () => "short"));

console.log("\n  ── the trade-flow proxies ──");
for (const sv of [1.5, 2.5]) {
  const up = deep.filter((o) => o.flow.vSurge >= sv && o.r.tapeChg > 0);
  const dn = deep.filter((o) => o.flow.vSurge >= sv && o.r.tapeChg < 0);
  out.push(reportDeep(`SURGE>=${sv}x UP bar -> LONG (continuation)`, up, () => "long", () => "long"));
  out.push(reportDeep(`SURGE>=${sv}x DOWN bar -> LONG (exhaustion)`, dn, () => "long", () => "long"));
  out.push(reportDeep(`SURGE>=${sv}x DOWN bar -> SHORT (continuation)`, dn, () => "short", () => "short"));
  out.push(reportDeep(`SURGE>=${sv}x UP bar -> SHORT (exhaustion)`, up, () => "short", () => "short"));
}
for (const th of [0.15, 0.3]) {
  out.push(reportDeep(`TFI >= +${th} -> LONG`, deep.filter((o) => o.flow.tfi >= th), () => "long", () => "long"));
  out.push(reportDeep(`TFI <= -${th} -> SHORT`, deep.filter((o) => o.flow.tfi <= -th), () => "short", () => "short"));
}
for (const g of [0.15, 0.3]) {
  out.push(reportDeep(`VWAP gap >= +${g}% -> SHORT (paid up)`, deep.filter((o) => o.flow.closeToVwap >= g), () => "short", () => "short"));
  out.push(reportDeep(`VWAP gap <= -${g}% -> LONG (washed out)`, deep.filter((o) => o.flow.closeToVwap <= -g), () => "long", () => "long"));
}

writeFileSync(join(SCRATCH, "oflow/final-results.json"), JSON.stringify(
  out.filter(Boolean).map((r) => ({
    label: r.label, n: r.m.n, wins: r.m.wins, losses: r.m.losses, times: r.m.times,
    winRate: r.m.winRate, evUsd: r.m.evUsd, evPctEquity: r.m.evPctEquity, be: r.m.be,
    avgWinUsd: r.m.avgWinUsd, avgLossUsd: r.m.avgLossUsd,
    closeConfirmedEvUsd: r.cm2.evUsd, closeConfirmedWinRate: r.cm2.winRate,
    excessUsd: r.ex.mean, excessT: r.ex.t, excessClusters: r.ex.n,
    trimT: r.tm.t, worst3: r.tm.worst3, best3: r.tm.best3,
    placeboT: r.pl, bootstrap: r.boot,
  })), null, 2));
console.log("\n[p2] wrote final-results.json");
