#!/usr/bin/env node
/**
 * THE ACHIEVABLE EXPECTANCY — the non-overlapping portfolio, and the
 * combination arm.
 *
 * ══ WHY THE OVERLAP MATTERS ══
 *
 * The deep arms take a trade on EVERY 5-minute observation with a
 * 240-minute hold. On 38 symbols over 14 days that is 61,524 trades —
 * 4,400 per symbol, one every four minutes, each held for four hours.
 * You cannot hold those. Only one position per symbol can exist at a
 * time, so the measured EV per trade is the EV of a portfolio the
 * account could never run.
 *
 * So every arm is re-measured with a PORTFOLIO CONSTRAINT: a symbol
 * that is already in a trade is skipped. That is the number a machine
 * could actually earn.
 *
 * ══ THE COMBINATION ARM ══
 *
 * The machine's own signal is the tape's exhaustion, confirmed by the
 * models. The natural order-flow refinement is: exhaustion AND the
 * taker flow AGREES with it. If the informed flow is selling into a
 * fade-short, the exhaustion is where the smart money is getting
 * filled. If the taker flow is buying, the exhaustion is a trap.
 *
 * READ-ONLY. Local files only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRATCH, loadBars, mean, stdev, fmt, bucketOf, NOTIONAL, EQUITY, RHO, ROUND_TRIP, FEE_USD, rng,
} from "./lib.mjs";
import { measureArm, tradeExcess, trimTrade, fmtArm } from "./trade.mjs";
import { marketTicket } from "./ticket.mjs";

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
deep.sort((a, b) => a.ts - b.ts);
const dts = deep.map((o) => o.ts);
console.log(`[p3] deep ${deep.length} rows | ${new Date(dts[0]).toISOString()} -> ${new Date(dts[dts.length - 1]).toISOString()}`);

const tapeSideOf = (r) => {
  const vratio = Number(r.tapeVratio ?? 1);
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  if (vratio < 0.85 && oh < 8) return "short";
  if (vratio < 0.85 && ol < 8) return "long";
  return null;
};

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

/**
 * THE PORTFOLIO: one open position per symbol at a time.
 * The trades are taken in TIME ORDER, and a symbol that already has an
 * open trade is skipped until that trade closes.
 */
function portfolioTrades(armRowsD, dirOf, hold = 48) {
  const openUntil = new Map(); // symbol -> the ts when the trade closes
  const trades = [];
  let skipped = 0;
  for (const o of armRowsD) {
    const until = openUntil.get(o.base);
    if (until != null && o.ts < until) { skipped++; continue; }
    const dir = dirOf(o);
    const tk = marketTicket(o.r.tapeAtrPct, o.price, dir);
    if (!tk) continue;
    const res = resolveChecked(tk, dir, bars5ByBase.get(o.base), o.ts, hold);
    if (!res) continue;
    const endTs = o.ts + res.bars * 5 * 60_000;
    openUntil.set(o.base, endTs);
    trades.push({
      ...res, dir, sym: o.base, ts: o.ts,
      bucket: bucketOf(o.ts), pnlUsd: res.pnlPct * NOTIONAL,
    });
  }
  return { trades, skipped };
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
  return { trials: ts.length, tMean: mean(ts), tP95: sorted[Math.floor(sorted.length * 0.95)], significant: ts.filter((t) => Math.abs(t) >= 2).length };
}

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
  return { days: days.length, tP5: sorted[Math.floor(sorted.length * 0.05)], tP95: sorted[Math.floor(sorted.length * 0.95)], p: ts.filter((x) => Math.abs(x) >= Math.abs(realT)).length / ts.length };
}

// the control is ALSO a portfolio, so the comparison is like for like
function controlPortfolio(dir) {
  const openUntil = new Map();
  const trades = [];
  for (const o of deep) {
    const until = openUntil.get(o.base);
    if (until != null && o.ts < until) continue;
    const tk = marketTicket(o.r.tapeAtrPct, o.price, dir);
    if (!tk) continue;
    const res = resolveChecked(tk, dir, bars5ByBase.get(o.base), o.ts, 48);
    if (!res) continue;
    openUntil.set(o.base, o.ts + res.bars * 5 * 60_000);
    trades.push({ ...res, dir, sym: o.base, ts: o.ts, bucket: bucketOf(o.ts), pnlUsd: res.pnlPct * NOTIONAL });
  }
  return trades;
}

const CTL_LONG = controlPortfolio("long");
const CTL_SHORT = controlPortfolio("short");
console.log(`[p3] control portfolios: always-long ${CTL_LONG.length} trades | always-short ${CTL_SHORT.length} trades`);

function report(label, armRowsD, dirOf, ctlTrades, ctlLabel) {
  const { trades, skipped } = portfolioTrades(armRowsD, dirOf);
  if (trades.length < 60) { console.log(`\n  ${label}: n=${trades.length} TOO FEW`); return null; }
  const m = measureArm(trades, label);
  const cm = measureArm(ctlTrades, ctlLabel);
  const ex = tradeExcess(trades, ctlTrades);
  const tm = trimTrade(ex.diffs, 3);
  const pl = tradePlacebo(trades, ctlTrades);
  const boot = dayBlockBootstrapTrades(trades, ctlTrades, ex.t);
  const winN = trades.filter((t) => t.outcome === "win").length;
  const wicks = trades.filter((t) => t.outcome === "win" && t.wick).length;
  const bySym = new Map();
  for (const t of trades) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  // the total over the window, and the days
  const days = new Set(trades.map((t) => Math.floor(t.ts / 86400000))).size;
  console.log(`\n  ══ ${label} ══`);
  console.log(`     PORTFOLIO: ${trades.length} trades (${skipped} skipped for an open position) | ${sorted.length} symbols | ${days} days`);
  console.log(`     ARM      ${fmtArm(m)}`);
  console.log(`     CONTROL  ${fmtArm(cm)}`);
  console.log(`     EXCESS over the control: $${ex.mean.toFixed(5)}/trade  se $${ex.se.toFixed(5)}  t=${fmt(ex.t, 2)}  (${ex.n} paired clusters)`);
  console.log(`     TRIM worst-3/best-3: t=${fmt(tm.t, 2)} (n=${tm.n})  worst3=[${tm.worst3}] best3=[${tm.best3}]`);
  console.log(`     PLACEBO: t mean ${fmt(pl.tMean, 2)}  t p95 ${fmt(pl.tP95, 2)}  runs |t|>=2: ${pl.significant}/${pl.trials}`);
  if (boot) console.log(`     DAY-BLOCK BOOTSTRAP (${boot.days} days): t p5 ${fmt(boot.tP5, 2)}  t p95 ${fmt(boot.tP95, 2)}  p(obs) ${(boot.p * 100).toFixed(1)}%`);
  console.log(`     WICK CHECK: ${wicks}/${winN} wins touched the target only on the bar's high/low, never on its close`);
  console.log(`     symbols: largest ${sorted[0][0]} ${((sorted[0][1] / total) * 100).toFixed(1)}%  next ${sorted.slice(1, 4).map((s) => `${s[0]} ${((s[1] / total) * 100).toFixed(1)}%`).join(", ")}`);
  console.log(`     THE WINDOW TOTAL: ${trades.length} trades x $${m.evUsd.toFixed(4)} = $${(trades.length * m.evUsd).toFixed(2)} over 14 days`);
  return { label, m, cm, ex, tm, pl, boot, trades };
}

const out = [];
console.log("\n══════════════════════════════════════════════════════════════");
console.log(" PART 3 — THE ACHIEVABLE (NON-OVERLAPPING) PORTFOLIO");
console.log("══════════════════════════════════════════════════════════════");

console.log("\n  ── the machine's own signal, and the order-flow refinements ──");
const exh = deep.filter((o) => tapeSideOf(o.r));
out.push(report("EXHAUSTION (the tape's side)", exh, (o) => tapeSideOf(o.r), CTL_SHORT, "always-SHORT portfolio"));

// the COMBINATION: the exhaustion AND the taker flow agrees with it
for (const th of [0.15, 0.3]) {
  const comb = exh.filter((o) => {
    const t = tapeSideOf(o.r);
    return t === "short" ? o.flow.tfi <= -th : o.flow.tfi >= th;
  });
  out.push(report(`EXHAUSTION + taker flow AGREES (|TFI|>=${th})`, comb, (o) => tapeSideOf(o.r), CTL_SHORT, "always-SHORT portfolio"));
  // and the DISAGREEMENT: the exhaustion against the taker flow
  const dis = exh.filter((o) => {
    const t = tapeSideOf(o.r);
    return t === "short" ? o.flow.tfi >= th : o.flow.tfi <= -th;
  });
  out.push(report(`EXHAUSTION but the taker flow DISAGREES (|TFI|>=${th})`, dis, (o) => tapeSideOf(o.r), CTL_SHORT, "always-SHORT portfolio"));
}

// the standalone order-flow arms, as portfolios
out.push(report("TFI <= -0.15 -> SHORT (taker selling)", deep.filter((o) => o.flow.tfi <= -0.15), () => "short", CTL_SHORT, "always-SHORT portfolio"));
out.push(report("TFI >= +0.15 -> LONG (taker buying)", deep.filter((o) => o.flow.tfi >= 0.15), () => "long", CTL_LONG, "always-LONG portfolio"));
out.push(report("VWAP gap >= +0.15% -> SHORT (paid up)", deep.filter((o) => o.flow.closeToVwap >= 0.15), () => "short", CTL_SHORT, "always-SHORT portfolio"));
out.push(report("VWAP gap <= -0.15% -> LONG (washed out)", deep.filter((o) => o.flow.closeToVwap <= -0.15), () => "long", CTL_LONG, "always-LONG portfolio"));
out.push(report("SURGE>=1.5x DOWN bar -> LONG (exhaustion)", deep.filter((o) => o.flow.vSurge >= 1.5 && o.r.tapeChg < 0), () => "long", CTL_LONG, "always-LONG portfolio"));

writeFileSync(join(SCRATCH, "oflow/portfolio-results.json"), JSON.stringify(
  out.filter(Boolean).map((r) => ({
    label: r.label, n: r.m.n, wins: r.m.wins, losses: r.m.losses, times: r.m.times,
    winRate: r.m.winRate, evUsd: r.m.evUsd, evPctEquity: r.m.evPctEquity, be: r.m.be,
    avgWinUsd: r.m.avgWinUsd, avgLossUsd: r.m.avgLossUsd,
    excessUsd: r.ex.mean, excessT: r.ex.t, excessClusters: r.ex.n,
    trimT: r.tm.t, placebo: r.pl, bootstrap: r.boot,
  })), null, 2));
console.log("\n[p3] wrote portfolio-results.json");
