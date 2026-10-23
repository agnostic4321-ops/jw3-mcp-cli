#!/usr/bin/env node
/**
 * multiday-amortise-confound.mjs — the ALTERNATIVE-EXPLANATION check.
 *
 * A directional excess can come from three places, and only the third is
 * skill:
 *
 *   1. BETA — the market drifted up, so being long earned money. Priced by
 *      the unconditional beta baseline (the same side, every bar).
 *   2. VOLATILITY SELECTION — the signal fires in HIGH-volatility moments
 *      (a dip is a high-vol event), and high-vol windows have wider
 *      outcomes. A rule that merely picks high-volatility windows will
 *      show a directional excess that is not directional at all. This is
 *      the "same-bar comparison" trap the repo's skill warns about:
 *      "signals fire in high-vol moments, so their barriers resolve more
 *      often — that alone inflates the apparent edge."
 *   3. SKILL — the signal's DIRECTION carries information.
 *
 * This script measures 1 and 2 and prices 3 against them:
 *
 *   A. THE VOLATILITY PROFILE OF THE SIGNAL vs THE BASELINE.
 *      The realised volatility (std of 1h log returns) over the hold
 *      window, for the signal's entry bars and for the matched-entry
 *      baseline's entry bars. If the signal's entries are materially more
 *      volatile, then ANY excess must be tested against a
 *      volatility-matched baseline, not a time-matched one.
 *
 *   B. THE VOLATILITY-MATCHED BASELINE.
 *      Re-draw the matched-entry baseline so that its entries have the
 *      SAME volatility profile as the signal's — by pairing each signal
 *      entry with a non-signal entry whose prior-24h realised volatility is
 *      in the same bucket. The excess against THIS baseline is the only
 *      excess that survives the volatility confound.
 *
 *   C. THE DIRECTION-ONLY TEST.
 *      The signal's own bars, with the direction shuffled (placebo family
 *      P3). If the shuffled version earns about as much, the signal's
 *      information is in the TIMING, not the direction.
 *
 * This is what decides whether any "excess" is tradeable.
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
function repoSignalDir(closes, vols) {
  const m = fadeMetrics(closes, vols);
  if (!m) return 0;
  let sSig = "neutral";
  if (m.offHighPct > 15) sSig = "late";
  else if (m.vratio < 0.85 && m.offHighPct < 8) sSig = "fade-short";
  else if (m.vratio > 3) sSig = "strong";
  let lSig = "neutral";
  if (m.offLowPct > 15) lSig = "extended";
  else if (m.vratio > 3) lSig = "capitulation";
  else if (m.vratio < 0.85 && m.offLowPct < 8) lSig = "dip-long";
  if (sSig === "fade-short" || lSig === "dip-long") return sSig === "fade-short" ? -1 : 1;
  return 0;
}

const args = process.argv.slice(2);
const fl = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const HOLD = Number(fl("hold", 1));
const LIMIT = Number(fl("symbols", 60));

const files = readdirSync(CACHE).filter((f) => f.startsWith("k1h_")).slice(0, LIMIT);
console.log(`[confound] hold=${HOLD}d  symbols=${files.length}`);

/* Collect, per symbol: the signal entries and a pool of non-signal
   entries, each with its prior-24h realised volatility. */
const data = [];
for (const f of files) {
  const symbol = f.slice(4, -5);
  const bars = loadSeries("k1h", symbol);
  if (!bars || bars.length < 400) continue;
  const closes = bars.map((b) => b[4]);
  const vols = bars.map((b) => b[5]);
  const fs = loadFunding(symbol);
  // prior-24h realised volatility (std of 1h log returns over 24 bars)
  const rv = new Array(bars.length).fill(NaN);
  for (let i = 24; i < bars.length; i++) {
    let s = 0, m = 0, c = 0;
    for (let k = i - 23; k <= i; k++) {
      if (k === 0) continue;
      const r = Math.log(closes[k] / closes[k - 1]);
      m += r; c++;
    }
    m /= c;
    for (let k = i - 23; k <= i; k++) {
      if (k === 0) continue;
      s += (Math.log(closes[k] / closes[k - 1]) - m) ** 2;
    }
    rv[i] = Math.sqrt(s / Math.max(1, c - 1)) * 100;
  }
  const sig = [];
  const pool = [];
  for (let i = 24; i < bars.length; i++) {
    const ts = bars[i][0];
    if (ts < A_FROM || ts >= A_TO) continue;
    const d = repoSignalDir(closes.slice(i - 23, i + 1), vols.slice(i - 23, i + 1));
    if (!Number.isFinite(rv[i])) continue;
    if (d) sig.push({ i, ts, dir: d, rv: rv[i] });
    else pool.push({ i, ts, rv: rv[i] });
  }
  if (sig.length && pool.length) {
    // A timestamp index, so the exit lookup is O(1) rather than O(n).
    const tsToIdx = new Map();
    for (let i = 0; i < bars.length; i++) tsToIdx.set(bars[i][0], i);
    // A funding prefix array indexed by hour, so the funding lookup is O(1).
    const nH = Math.ceil((A_TO - A_FROM) / HOUR) + 96;
    const cum = new Float64Array(nH + 2);
    for (const s of fs) {
      const h = Math.floor((s.ts - A_FROM) / HOUR);
      if (h >= 0 && h <= nH) cum[h + 1] += s.rate * 100;
    }
    for (let h = 1; h <= nH + 1; h++) cum[h] += cum[h - 1];
    const fundAt = (h) => (h < 0 ? 0 : h >= cum.length ? cum[cum.length - 1] : cum[h]);
    const poolSorted = [...pool].sort((a, b) => a.rv - b.rv);
    data.push({ symbol, bars, closes, sig, pool, poolSorted, fs, tsToIdx, fundAt, A_FROM });
  }
}
console.log(`[confound] prepared ${data.length} symbols`);

/** Build a trade from a bar index. */
function trade(d, i, dir) {
  const ts = d.bars[i][0];
  const exitTs = ts + HOLD * DAY;
  const ei = d.tsToIdx.get(exitTs);
  if (ei === undefined) return null;
  const ep = d.closes[i], xp = d.closes[ei];
  if (!(ep > 0) || !(xp > 0)) return null;
  const h0 = Math.floor((ts - d.A_FROM) / HOUR);
  const h1 = Math.floor((exitTs - d.A_FROM) / HOUR);
  const fund = dir > 0 ? d.fundAt(h1) - d.fundAt(h0) : -(d.fundAt(h1) - d.fundAt(h0));
  const gross = dir * ((xp - ep) / ep) * 100;
  return { gross, fund, net: gross - fund - TAKER_RT };
}

/* ── A. THE VOLATILITY PROFILE ─────────────────────────────────────── */
console.log("\n[A] the volatility profile of the signal's entries vs the market");
{
  let sigRvs = [], poolRvs = [];
  for (const d of data) {
    for (const s of d.sig) sigRvs.push(s.rv);
    for (const p of d.pool) poolRvs.push(p.rv);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`  signal entries: n=${sigRvs.length} median rv=${med(sigRvs).toFixed(4)}% mean rv=${mean(sigRvs).toFixed(4)}%`);
  console.log(`  all other bars: n=${poolRvs.length} median rv=${med(poolRvs).toFixed(4)}% mean rv=${mean(poolRvs).toFixed(4)}%`);
  console.log(`  ratio (signal / market), MEDIAN: ${(med(sigRvs) / med(poolRvs)).toFixed(3)}x`);
  console.log(`  ratio (signal / market), MEAN:   ${(mean(sigRvs) / mean(poolRvs)).toFixed(3)}x`);
  const hi = sigRvs.filter((v) => v > med(poolRvs)).length / sigRvs.length;
  console.log(`  share of signal entries above the market's median rv: ${(hi * 100).toFixed(1)}%`);
  console.log("  => if this ratio is materially above 1, the signal SELECTS VOLATILITY,");
  console.log("     so any directional excess must be tested against a");
  console.log("     VOLATILITY-MATCHED baseline, not just a time-matched one.");
}

/* ── B. THE VOLATILITY-MATCHED BASELINE ────────────────────────────── */
console.log("\n[B] the excess against a VOLATILITY-MATCHED baseline");
{
  // For each signal entry, find a non-signal entry in the same volatility
  // bucket (by prior-24h realised vol), with the SAME side. If none, use
  // the nearest-volatility non-signal entry.
  const buckets = new Map(); // sym -> Map(bucket -> [pool entries])
  const BUCKET = 0.0005; // 5 bps of hourly vol per bucket
  for (const d of data) {
    const m = new Map();
    for (const p of d.pool) {
      const b = Math.floor(p.rv / BUCKET);
      if (!m.has(b)) m.set(b, []);
      m.get(b).push(p);
    }
    buckets.set(d.symbol, m);
  }
  let nMatched = 0, nFallback = 0, nUnmatched = 0;
  const sigTrades = [], volTrades = [], timeTrades = [];
  for (const d of data) {
    const bm = buckets.get(d.symbol);
    for (const s of d.sig) {
      const t = trade(d, s.i, s.dir);
      if (!t) continue;
      sigTrades.push(t);
      const b = Math.floor(s.rv / BUCKET);
      let cand = bm.get(b);
      let used = false;
      if (cand && cand.length) {
        const p = cand[Math.floor(Math.random() * cand.length)];
        const tt = trade(d, p.i, s.dir);
        if (tt) { volTrades.push(tt); nMatched++; used = true; }
      }
      if (!used) {
        // Nearest-volatility fallback: scan the pool once, keeping the
        // closest. The pool is pre-sorted by rv, so a binary search finds
        // the nearest neighbour in O(log n).
        const sortedPool = d.poolSorted;
        let lo = 0, hi = sortedPool.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedPool[mid].rv < s.rv) lo = mid + 1; else hi = mid;
        }
        const candIdx = [lo - 1, lo].filter((k) => k >= 0 && k < sortedPool.length);
        let best = null, bestD = Infinity;
        for (const k of candIdx) {
          const p = sortedPool[k];
          const dd = Math.abs(p.rv - s.rv);
          if (dd < bestD) { bestD = dd; best = p; }
        }
        if (best) {
          const tt = trade(d, best.i, s.dir);
          if (tt) { volTrades.push(tt); nFallback++; used = true; }
        }
      }
      if (!used) { nUnmatched++; continue; }
      // a TIME-matched baseline: a random non-signal entry, same side
      const p = d.pool[Math.floor(Math.random() * d.pool.length)];
      const tt = trade(d, p.i, s.dir);
      if (tt) timeTrades.push(tt);
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sigM = mean(sigTrades.map((t) => t.net));
  const volM = mean(volTrades.map((t) => t.net));
  const timeM = mean(timeTrades.map((t) => t.net));
  console.log(`  signal arm:      n=${sigTrades.length}  net=${sigM.toFixed(4)}%`);
  console.log(`  TIME-matched:     n=${timeTrades.length}  net=${timeM.toFixed(4)}%  -> excess ${(sigM - timeM).toFixed(4)}%`);
  console.log(`  VOL-matched:      n=${volTrades.length}  net=${volM.toFixed(4)}%  -> excess ${(sigM - volM).toFixed(4)}%`);
  console.log(`  (vol-matched: ${nMatched} exact-bucket, ${nFallback} nearest-vol fallback, ${nUnmatched} unmatched)`);
  const rvOf = (trades) => mean(trades.map(() => 0));
  console.log("  => the difference between the two excesses is the part of the edge that is");
  console.log("     VOLATILITY SELECTION rather than direction.");
}

/* ── C. THE DIRECTION-ONLY TEST ───────────────────────────────────── */
console.log("\n[C] does the signal know WHICH WAY? (direction shuffled on its own bars)");
{
  const sigN = [], shufN = [];
  let rnd = 12345;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
  for (const d of data) {
    const dirs = d.sig.map((s) => s.dir);
    const shuffled = [...dirs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    d.sig.forEach((s, k) => {
      const t1 = trade(d, s.i, s.dir);
      const t2 = trade(d, s.i, shuffled[k]);
      if (t1) sigN.push(t1.net);
      if (t2) shufN.push(t2.net);
    });
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  console.log(`  signal direction: n=${sigN.length} net=${mean(sigN).toFixed(4)}%`);
  console.log(`  shuffled direction: n=${shufN.length} net=${mean(shufN).toFixed(4)}%`);
  console.log(`  difference: ${(mean(sigN) - mean(shufN)).toFixed(4)}%`);
  console.log("  => if the shuffled arm is about the same, the signal's information is in");
  console.log("     WHEN to trade, not WHICH WAY, and no multi-day hold can fix that.");
}
console.log("\n[confound] done");
