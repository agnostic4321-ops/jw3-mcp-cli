#!/usr/bin/env node
/**
 * DIAGNOSTIC — why is the long-only excess so large?
 *
 * The first partial run showed long-only excess of +2.08% PER DAY with
 * t=7.94, which is implausible for a fade/dip signal. Before believing
 * any number, find out WHY.
 *
 * HYPOTHESIS 1 — SPARSITY. The repo's fadeMetrics assumes the trailing
 *   24 BARS are 24 HOURS. On an illiquid symbol that prints 6 bars/day,
 *   the "24-bar" window spans 4 DAYS, so "the 24h high/low" is really a
 *   multi-day high/low and the signal degenerates into a multi-day
 *   mean-reversion entry — which a 1-day hold then captures. That would
 *   produce exactly this kind of large, consistent excess.
 *
 * HYPOTHESIS 2 — a sign or arithmetic error in the control.
 *
 * This script prints, for a few (symbol, day) clusters: the signal trade,
 * the complement trades, the bar spacing, and the lookback span.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CACHE = join(homedir(), ".hermes/cache/scratch/mdh-2026");

function loadSeries(prefix, symbol) {
  const f = join(CACHE, `${prefix}_${symbol}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")).bars ?? null; } catch { return null; }
}

const files = readdirSync(CACHE).filter((f) => f.startsWith("k1h_")).slice(0, 200);

let nSparse = 0, nDense = 0, nTot = 0;
const spanHist = [];
const perSymbol = [];

for (const f of files) {
  const bars = loadSeries("k1h", f.slice(4, -5));
  if (!bars || bars.length < 500) continue;
  nTot++;
  // The lookback span: how many hours does the trailing-24-bar window cover?
  const lookbackSpans = [];
  for (let i = 24; i < bars.length; i += 97) {
    lookbackSpans.push((bars[i][0] - bars[i - 23][0]) / HOUR);
  }
  lookbackSpans.sort((a, b) => a - b);
  const med = lookbackSpans[Math.floor(lookbackSpans.length / 2)];
  // The bar coverage over the analysis window.
  const inWin = bars.filter((b) => b[0] >= Date.UTC(2025, 6, 22, 22) && b[0] < Date.UTC(2026, 6, 22, 22));
  const cov = inWin.length / 365;
  spanHist.push({ sym: f.slice(4, -5), medLookbackH: med, coverage: cov, bars: bars.length });
  if (med > 48) nSparse++; else nDense++;
  perSymbol.push({ sym: f.slice(4, -5), medLookbackH: med, coverage: cov, bars: bars.length, inWin: inWin.length });
}

spanHist.sort((a, b) => a.medLookbackH - b.medLookbackH);
console.log(`symbols checked: ${nTot} | median-lookback > 48h (SPARSE): ${nSparse} | <= 48h (DENSE): ${nDense}`);
console.log("\nlookback span (hours) of the trailing-24-bar window, per symbol — the extremes:");
for (const s of spanHist.slice(0, 8)) {
  console.log(`  ${s.sym.padEnd(18)} med_lookback=${String(s.medLookbackH).padStart(7)}h  coverage=${(s.coverage * 100).toFixed(1)}%  bars=${s.bars}`);
}
console.log("  ...");
for (const s of spanHist.slice(-8)) {
  console.log(`  ${s.sym.padEnd(18)} med_lookback=${String(s.medLookbackH).padStart(7)}h  coverage=${(s.coverage * 100).toFixed(1)}%  bars=${s.bars}`);
}

/* Now: does the excess concentrate in the SPARSE symbols? */
console.log("\n--- a concrete cluster dump on the sparsest symbol ---");
const sparse = spanHist[0];
if (sparse) {
  const bars = loadSeries("k1h", sparse.sym);
  const closes = bars.map((b) => b[4]);
  const vols = bars.map((b) => b[5]);
  // find a LONG signal
  const longIdx = [];
  for (let i = 24; i < bars.length; i++) {
    const w = closes.slice(i - 23, i + 1), v = vols.slice(i - 23, i + 1);
    const recent = v.slice(-12), prior = v.slice(-24, -12);
    const rm = recent.reduce((a, b) => a + b, 0) / 12, pm = prior.reduce((a, b) => a + b, 0) / 12;
    if (!(pm > 0)) continue;
    const hi = maxOf(w), lo = minOf(w), last = w[w.length - 1];
    const offHigh = ((hi - last) / hi) * 100, offLow = ((last - lo) / lo) * 100;
    const vratio = rm / pm;
    const sSig = offHigh > 15 ? "late" : (vratio < 0.85 && offHigh < 8 ? "fade-short" : (vratio > 3 ? "strong" : "neutral"));
    const lSig = offLow > 15 ? "extended" : (vratio > 3 ? "capitulation" : (vratio < 0.85 && offLow < 8 ? "dip-long" : "neutral"));
    const dir = sSig === "fade-short" ? "short" : lSig === "dip-long" ? "long" : null;
    if (dir === "long") longIdx.push(i);
  }
  console.log(`  ${sparse.sym}: ${longIdx.length} LONG signals; median lookback ${sparse.medLookbackH}h`);
  for (const i of longIdx.slice(0, 4)) {
    const ts = bars[i][0];
    const lb = (bars[i][0] - bars[i - 23][0]) / HOUR;
    const ei = bars.findIndex((b) => b[0] === ts + DAY);
    const r = ei >= 0 ? ((bars[ei][4] - bars[i][4]) / bars[i][4]) * 100 : null;
    // the bar spacing around the entry
    const gaps = [];
    for (let k = i - 6; k <= i; k++) gaps.push(((bars[k + 1][0] - bars[k][0]) / HOUR).toFixed(0));
    console.log(
      `    entry ${new Date(ts).toISOString().slice(0, 16)} lookback=${lb}h  1d_return=${r === null ? "n/a" : r.toFixed(3) + "%"}` +
        `  bar_gaps(h)=[${gaps.join(",")}]`,
    );
  }
}
