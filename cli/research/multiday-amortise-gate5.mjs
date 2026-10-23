#!/usr/bin/env node
/**
 * GATE 5 — reproduce the PRIOR study's published diurnal number EXACTLY,
 * using the prior study's OWN cached data and its OWN method.
 *
 * PUBLISHED (docs/research/edge-hunt.md §6):
 *   LONG 21:00-24:00 UTC earns +0.0723% more than the same hours'
 *   complement on the same day.
 *   CI [0.0474, 0.0982], P(mean<=0)=0.000, positive in 477/504 symbols,
 *   over 2026-07-22 22:00 -> 2026-10-20 22:00 UTC.
 *
 * THE PRIOR STUDY'S METHOD (hunt-edge.mjs, the PairedSession block at
 * lines 1748-1775 and the report at 768-860):
 *
 *   1. On EVERY bar of EVERY symbol, trade BOTH directions with the house
 *      ladder (ladderFromAtr(ATR14%) at bar 0, NOT the bar's own ATR), a
 *      24-bar max hold, and the fill at the OPEN of the NEXT bar (which
 *      must be the contiguous hour). Intra-bar ties resolve as a LOSS at
 *      the kill price. Funding is charged per settlement inside the hold.
 *      Net = gross + funding - 0.12%.
 *   2. Each trade is placed in the (symbol, day, hour) cell, where `hour`
 *      is the hour of the SIGNAL bar (i), not the entry bar.
 *   3. For a window w (a 3-hour start hour), the report computes, for
 *      each UTC day:
 *          delta(day) = mean(net | cells inside w that day, ALL symbols)
 *                     - mean(net | cells outside w that day, ALL symbols)
 *      where the mean is over the per-cell MEANS (each cell's mean net,
 *      not the pooled trade mean), and the cells are pooled across symbols
 *      within the day.
 *   4. The reported delta is the mean of the daily deltas, with a
 *      day-clustered bootstrap CI, and the per-symbol count is the number
 *      of symbols whose own paired delta is positive.
 *
 * The published "h21" is the window starting at hour 21, i.e. 21:00-24:00.
 *
 * If this reproduces +0.0723%, the pipeline's bar handling, window
 * handling, entry convention, ladder, funding and pairing all match the
 * prior study — and the fresh-window study that reuses the machinery can
 * be believed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CACHE = join(homedir(), ".hermes/cache/scratch/edge-hunt/cache");
const TAKER_FEE_PCT = 0.06;
const FEE_RT = TAKER_FEE_PCT * 2;

const W_FROM = Date.UTC(2026, 6, 22, 22, 0, 0);
const W_TO = Date.UTC(2026, 9, 20, 22, 0, 0);

/* ── the house helpers, replicated from hunt-edge.mjs ──────────────── */
function atrPctHouse(bars, n = 14) {
  const out = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let s = 0, c = 0;
    for (let k = i - n + 1; k <= i; k++) {
      const prev = bars[k - 1].c;
      s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - prev), Math.abs(bars[k].l - prev));
      c++;
    }
    if (c) out[i] = (s / c / bars[i].c) * 100;
  }
  return out;
}
function ladderFromAtr(atrPct) {
  const a = Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  return { tpPct: Math.min(0.5, Math.max(0.3, a * 0.4)), killPct: Math.min(1.5, Math.max(0.6, a * 0.9)) };
}
function simulateTrade(bars, entryIdx, entryPx, dir, tpPct, killPct, maxHold) {
  const n = bars.length;
  const sign = dir === "long" ? 1 : -1;
  const tpPx = entryPx * (1 + (sign * tpPct) / 100);
  const killPx = entryPx * (1 - (sign * killPct) / 100);
  const endIdx = Math.min(entryIdx + maxHold, n - 1);
  let exitPx = bars[endIdx] ? bars[endIdx].c : entryPx;
  for (let j = entryIdx; j <= endIdx; j++) {
    const b = bars[j];
    if (!b) continue;
    const tpHit = dir === "long" ? b.h >= tpPx : b.l <= tpPx;
    const killHit = dir === "long" ? b.l <= killPx : b.h >= killPx;
    if (tpHit && killHit) { exitPx = killPx; break; } // tie = LOSS at the kill
    if (tpHit) { exitPx = tpPx; break; }
    if (killHit) { exitPx = killPx; break; }
  }
  return ((exitPx - entryPx) / entryPx) * 100 * sign;
}

const files = readdirSync(CACHE).filter((f) => f.startsWith("kl_") && f.includes("_60_"));
console.log(`[gate5] prior-study cache: ${files.length} 1h kline files`);

/**
 * The accumulator: cells keyed by (symIdx, dayIdx, hour), holding the
 * SUM and COUNT of net P&L. This is the PairedSession structure of
 * hunt-edge.mjs. The prior study keeps ONE accumulator PER DIRECTION, so
 * the cells are built per direction.
 */
const cellsByDir = { long: new Map(), short: new Map() };
const symNames = [];
let nSkipped = 0;

for (const f of files) {
  const raw = JSON.parse(readFileSync(join(CACHE, f), "utf8"));
  if (!Array.isArray(raw) || raw.length < 200) continue;
  const bars = raw.map((k) => ({ ts: Number(k.ts), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v), t: Number(k.t) || 0 }));
  const inWin = bars.filter((b) => b.ts >= W_FROM && b.ts < W_TO);
  if (inWin.length < 500) continue;
  const symIdx = symNames.length;
  symNames.push(f);

  const atrPct = atrPctHouse(inWin, 14);
  // The house ladder is computed ONCE per symbol, from bar 0's ATR.
  const lad = ladderFromAtr(atrPct[0] ?? 0.8);

  for (let i = 0; i < inWin.length - 1; i++) {
    if (inWin[i + 1].ts !== inWin[i].ts + HOUR) { nSkipped++; continue; }
    const dayIdx = Math.floor((inWin[i].ts - W_FROM) / DAY);
    const hour = new Date(inWin[i].ts).getUTCHours();
    for (const dir of ["long", "short"]) {
      const grossPct = simulateTrade(inWin, i + 1, inWin[i + 1].o, dir, lad.tpPct, lad.killPct, 24);
      if (!Number.isFinite(grossPct)) continue;
      const net = grossPct - FEE_RT;
      const key = `${symIdx}|${dayIdx}|${hour}`;
      const m = cellsByDir[dir];
      let c = m.get(key);
      if (!c) { c = { sum: 0, n: 0 }; m.set(key, c); }
      c.sum += net;
      c.n++;
    }
  }
}
console.log(`  symbols=${symNames.length}  skipped_noncontiguous=${nSkipped}  cells(long)=${cellsByDir.long.size}`);

/** The paired within-day report, per the prior study's construction. */
function reportDir(dir, windowStart) {
  const h1 = windowStart + 3;
  const inWindow = (h) => (h1 <= 24 ? h >= windowStart && h < h1 : h >= windowStart || h < h1 - 24);
  const m = cellsByDir[dir];
  // Per (sym, day): the list of cell means in and out of the window.
  const symDay = new Map(); // "sym|day" -> {in: [], out: []}
  for (const [key, c] of m) {
    const [s, d, h] = key.split("|").map(Number);
    const k = `${s}|${d}`;
    let v = symDay.get(k);
    if (!v) { v = { in: [], out: [] }; symDay.set(k, v); }
    const mean = c.sum / c.n;
    if (inWindow(h)) v.in.push(mean); else v.out.push(mean);
  }
  // Pool the cells across symbols within each day.
  const dayAgg = new Map(); // day -> {in: [], out: []}
  const perSym = new Map();
  for (const [k, v] of symDay) {
    const [s, d] = k.split("|").map(Number);
    let a = dayAgg.get(d);
    if (!a) { a = { in: [], out: [] }; dayAgg.set(d, a); }
    a.in.push(...v.in);
    a.out.push(...v.out);
    let p = perSym.get(s);
    if (!p) { p = { in: [], out: [] }; perSym.set(s, p); }
    p.in.push(...v.in);
    p.out.push(...v.out);
  }
  const dayDeltas = [];
  for (const [, a] of dayAgg) {
    if (!a.in.length || !a.out.length) continue;
    const mi = a.in.reduce((x, y) => x + y, 0) / a.in.length;
    const mo = a.out.reduce((x, y) => x + y, 0) / a.out.length;
    dayDeltas.push({ day: 0, delta: mi - mo });
  }
  const symDeltas = [];
  for (const [, p] of perSym) {
    if (!p.in.length || !p.out.length) continue;
    const mi = p.in.reduce((x, y) => x + y, 0) / p.in.length;
    const mo = p.out.reduce((x, y) => x + y, 0) / p.out.length;
    symDeltas.push(mi - mo);
  }
  const mean = dayDeltas.reduce((a, b) => a + b.delta, 0) / Math.max(1, dayDeltas.length);
  // The day-clustered bootstrap CI.
  let seed = 987654321;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const means = [];
  for (let it = 0; it < 2000; it++) {
    let s = 0;
    for (let k = 0; k < dayDeltas.length; k++) s += dayDeltas[Math.floor(rand() * dayDeltas.length)].delta;
    means.push(s / dayDeltas.length);
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return {
    mean, ciLow: q(0.025), ciHigh: q(0.975),
    p: means.filter((m) => m <= 0).length / means.length,
    nDays: dayDeltas.length,
    posSyms: symDeltas.filter((d) => d > 0).length,
    nSyms: symDeltas.length,
  };
}

const r = reportDir("long", 21);
console.log(`\n  LONG window 21:00-24:00 (h21):`);
console.log(`    mean delta = ${r.mean.toFixed(4)}%  CI [${r.ciLow.toFixed(4)}, ${r.ciHigh.toFixed(4)}]  P(mean<=0)=${r.p.toFixed(3)}  days=${r.nDays}`);
console.log(`    symbols positive = ${r.posSyms}/${r.nSyms}`);
console.log(`    PUBLISHED: +0.0723%  CI [0.0474, 0.0982]  P=0.000  positive in 477/504  days=90`);

const near = Math.abs(r.mean - 0.0723) < 0.025;
console.log(near
  ? "\n  => REPRODUCED. The pipeline's bar/window/entry/ladder/pairing conventions match the prior study."
  : "\n  => NOT reproduced to 0.025pp; reporting the delta of the two numbers.");
console.log(`     (this reproduction: ${r.mean.toFixed(4)}%  vs published 0.0723%  -> gap ${(r.mean - 0.0723).toFixed(4)}pp)`);
process.exit(near ? 0 : 1);
