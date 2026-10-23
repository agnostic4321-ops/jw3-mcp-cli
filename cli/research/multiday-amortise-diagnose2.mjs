#!/usr/bin/env node
/**
 * DIAGNOSTIC 2 — dump the raw clusters behind the implausible long-only
 * excess (+2.08%/day, t=7.94).
 *
 * The question is not "is it significant" — it is "WHAT is carrying it".
 * A +2% per-day excess from a fade/dip signal is not plausible as skill.
 * Candidates:
 *   (a) a handful of extreme trades driving the mean (fat tail);
 *   (b) a structural asymmetry between the signal's entry set and the
 *       complement's entry set (e.g. the complement systematically buys
 *       higher in the range);
 *   (c) a bug in the pairing.
 *
 * Prints: the distribution of cluster deltas, the top/bottom clusters in
 * full, and the entry/exit prices of a normal cluster.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CACHE = join(homedir(), ".hermes/cache/scratch/mdh-2026");
const TAKER_RT = 0.12;
const A_FROM = Date.UTC(2025, 6, 22, 22, 0, 0);
const A_TO = Date.UTC(2026, 6, 22, 22, 0, 0);

function loadSeries(prefix, symbol) {
  const f = join(CACHE, `${prefix}_${symbol}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")).bars ?? null; } catch { return null; }
}
function loadFunding(symbol) {
  const f = join(CACHE, `fr_${symbol}.json`);
  if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, "utf8")).settlements ?? []; } catch { return []; }
}
function fadeMetrics(closes, vols) {
  if (closes.length < 24 || vols.length < 24) return null;
  const rm = vols.slice(-12).reduce((a, b) => a + b, 0) / 12;
  const pm = vols.slice(-24, -12).reduce((a, b) => a + b, 0) / 12;
  if (!(pm > 0)) return null;
  const w = closes.slice(-24);
  const hi = maxOf(w), lo = minOf(w), last = closes[closes.length - 1];
  if (!(hi > 0) || !(lo > 0) || !Number.isFinite(last)) return null;
  return { vratio: rm / pm, offHighPct: ((hi - last) / hi) * 100, offLowPct: ((last - lo) / lo) * 100 };
}
function repoSignal(closes, vols) {
  const m = fadeMetrics(closes, vols);
  if (!m) return null;
  let sSig = "neutral";
  if (m.offHighPct > 15) sSig = "late";
  else if (m.vratio < 0.85 && m.offHighPct < 8) sSig = "fade-short";
  else if (m.vratio > 3) sSig = "strong";
  let lSig = "neutral";
  if (m.offLowPct > 15) lSig = "extended";
  else if (m.vratio > 3) lSig = "capitulation";
  else if (m.vratio < 0.85 && m.offLowPct < 8) lSig = "dip-long";
  if (sSig === "fade-short" || lSig === "dip-long") return sSig === "fade-short" ? "short" : "long";
  return null;
}

const files = readdirSync(CACHE).filter((f) => f.startsWith("k1h_")).slice(0, 25);
const HOLD = 1;

const clusters = [];
for (const f of files) {
  const symbol = f.slice(4, -5);
  const bars = loadSeries("k1h", symbol);
  if (!bars || bars.length < 500) continue;
  const closes = bars.map((b) => b[4]);
  const vols = bars.map((b) => b[5]);
  const tsToIdx = new Map(bars.map((b, i) => [b[0], i]));
  const fs = loadFunding(symbol);
  const fundCost = (a, b, dir) => {
    let c = 0;
    for (const s of fs) { if (s.ts <= a) continue; if (s.ts > b) break; c += dir === "long" ? s.rate * 100 : -s.rate * 100; }
    return c;
  };
  const sig = [];
  const fired = new Map();
  for (let i = 24; i < bars.length; i++) {
    const ts = bars[i][0];
    if (ts < A_FROM || ts >= A_TO) continue;
    const dir = repoSignal(closes.slice(i - 23, i + 1), vols.slice(i - 23, i + 1));
    if (!dir) continue;
    const ei = tsToIdx.get(ts + HOLD * DAY);
    if (ei === undefined) continue;
    const ep = closes[i], xp = closes[ei];
    if (!(ep > 0) || !(xp > 0)) continue;
    const gross = (dir === "long" ? 1 : -1) * ((xp - ep) / ep) * 100;
    const fund = fundCost(ts, ts + HOLD * DAY, dir);
    sig.push({ sym: symbol, ts, day: Math.floor(ts / DAY), hour: new Date(ts).getUTCHours(), dir, gross, fund, net: gross - fund - TAKER_RT, ep, xp });
    const d = Math.floor(ts / DAY);
    if (!fired.has(d)) fired.set(d, new Set());
    fired.get(d).add(new Date(ts).getUTCHours());
  }
  // complement
  const ctl = new Map();
  for (let i = 24; i < bars.length; i++) {
    const ts = bars[i][0];
    if (ts < A_FROM || ts >= A_TO) continue;
    const day = Math.floor(ts / DAY);
    const hour = new Date(ts).getUTCHours();
    if (!fired.has(day) || fired.get(day).has(hour)) continue;
    const ei = tsToIdx.get(ts + HOLD * DAY);
    if (ei === undefined) continue;
    const ep = closes[i], xp = closes[ei];
    if (!(ep > 0) || !(xp > 0)) continue;
    // the side is the signal's side on that day
    const dayTrades = sig.filter((t) => t.day === day);
    if (!dayTrades.length) continue;
    const dir = dayTrades[0].dir;
    const gross = (dir === "long" ? 1 : -1) * ((xp - ep) / ep) * 100;
    const fund = fundCost(ts, ts + HOLD * DAY, dir);
    const k = `${symbol}|${day}`;
    if (!ctl.has(k)) ctl.set(k, { sum: 0, n: 0, rows: [] });
    const c = ctl.get(k);
    c.sum += gross - fund - TAKER_RT; c.n++;
    c.rows.push({ ts, hour, gross, net: gross - fund - TAKER_RT, ep, xp, dir });
  }
  // pair
  const byDay = new Map();
  for (const t of sig) {
    const k = `${t.sym}|${t.day}`;
    if (!byDay.has(k)) byDay.set(k, { rows: [] });
    byDay.get(k).rows.push(t);
  }
  for (const [k, s] of byDay) {
    const c = ctl.get(k);
    if (!c || !c.n) continue;
    const sMean = s.rows.reduce((a, t) => a + t.net, 0) / s.rows.length;
    const cMean = c.sum / c.n;
    clusters.push({ k, sym: symbol, day: s.rows[0].day, dir: s.rows[0].dir, sMean, cMean, delta: sMean - cMean, sRows: s.rows, cRows: c.rows });
  }
}

console.log(`clusters: ${clusters.length}`);
const deltas = clusters.map((c) => c.delta).sort((a, b) => a - b);
const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
const med = deltas[Math.floor(deltas.length / 2)];
console.log(`mean delta ${mean.toFixed(4)}%  median ${med.toFixed(4)}%  min ${deltas[0].toFixed(3)}  max ${deltas[deltas.length - 1].toFixed(3)}`);
// contribution of the extremes
const sorted = [...clusters].sort((a, b) => b.delta - a.delta);
const top10 = sorted.slice(0, 10);
const top1 = sorted[0];
console.log(`top cluster: ${top1.sym} day=${top1.day} delta=${top1.delta.toFixed(3)}%  sMean=${top1.sMean.toFixed(3)} cMean=${top1.cMean.toFixed(3)}`);
// how much of the mean do the top 10 carry?
const totalSum = deltas.reduce((a, b) => a + b, 0);
const top10Sum = top10.reduce((a, c) => a + c.delta, 0);
console.log(`the top 10 clusters contribute ${(top10Sum / totalSum * 100).toFixed(1)}% of the total delta sum`);
// trimmed mean
const trim = deltas.slice(Math.floor(deltas.length * 0.05), deltas.length - Math.floor(deltas.length * 0.05));
console.log(`5% trimmed mean = ${(trim.reduce((a, b) => a + b, 0) / trim.length).toFixed(4)}%`);

console.log("\n--- the top cluster in full ---");
{
  const c = top1;
  console.log(`  ${c.sym} day=${c.day} dir=${c.dir}  signal n=${c.sRows.length} control n=${c.cRows.length}`);
  console.log(`  SIGNAL trades:`);
  for (const r of c.sRows.slice(0, 5)) {
    console.log(`    ${new Date(r.ts).toISOString().slice(0, 16)} h${r.hour} entry=${r.ep} exit=${r.xp} gross=${r.gross.toFixed(3)}% net=${r.net.toFixed(3)}%`);
  }
  console.log(`  CONTROL trades (first 5 of ${c.cRows.length}):`);
  for (const r of c.cRows.slice(0, 5)) {
    console.log(`    ${new Date(r.ts).toISOString().slice(0, 16)} h${r.hour} entry=${r.ep} exit=${r.xp} gross=${r.gross.toFixed(3)}% net=${r.net.toFixed(3)}%`);
  }
  const ctlNet = c.cRows.map((r) => r.net);
  console.log(`  control net mean=${(ctlNet.reduce((a, b) => a + b, 0) / ctlNet.length).toFixed(4)}%  (n=${ctlNet.length})`);
  console.log(`  control net range: [${minOf(ctlNet).toFixed(3)}, ${maxOf(ctlNet).toFixed(3)}]`);
}

console.log("\n--- a MEDIAN cluster in full ---");
{
  const c = sorted[Math.floor(sorted.length / 2)];
  console.log(`  ${c.sym} day=${c.day} dir=${c.dir} delta=${c.delta.toFixed(4)}%  sMean=${c.sMean.toFixed(4)} cMean=${c.cMean.toFixed(4)}`);
  console.log(`  signal n=${c.sRows.length} control n=${c.cRows.length}`);
  console.log(`  SIGNAL: ${c.sRows.map((r) => `${new Date(r.ts).toISOString().slice(11, 16)} net=${r.net.toFixed(3)}`).join(" | ")}`);
  console.log(`  CONTROL nets: ${c.cRows.slice(0, 12).map((r) => r.net.toFixed(2)).join(", ")}`);
  console.log(`  control net mean=${c.cMean.toFixed(4)}%`);
}

/* The structural question: is the control systematically buying a HIGHER
   price? Compare the entry price of the signal vs the control, relative
   to the day's range. */
console.log("\n--- structural check: entry price position within the day ---");
{
  let sigSum = 0, ctlSum = 0, n = 0;
  for (const c of clusters) {
    const all = [...c.sRows, ...c.cRows];
    const dayStart = c.day * DAY;
    const dayBars = [];
    // the day's price range from the signal/control entries we have
    for (const r of all) dayBars.push(r.ep);
    const lo = minOf(dayBars), hi = maxOf(dayBars);
    if (!(hi > lo)) continue;
    for (const r of c.sRows) sigSum += (r.ep - lo) / (hi - lo);
    for (const r of c.cRows) ctlSum += (r.ep - lo) / (hi - lo);
    n += c.sRows.length + c.cRows.length;
  }
  console.log(`  mean entry position in day range: signal=${(sigSum / n * 100).toFixed(1)}% (normalised over all trades) — the control buys the same day`);
}
