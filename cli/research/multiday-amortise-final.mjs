#!/usr/bin/env node
/**
 * multiday-amortise-final.mjs — the two questions that settle the verdict.
 *
 * QUESTION 1 — IS THE RESIDUAL EXCESS A PRICE-POSITION ARTEFACT?
 *
 *   The diagnosis found that the fade/dip signal fires at the EXTREMES of
 *   its 24-hour range (a dip-long fires near the day's low; a fade-short
 *   fires near the day's high). The matched-entry baseline picks RANDOM
 *   non-signal bars, which sit in the MIDDLE of the range. So the baseline
 *   buys or sells a systematically different price position, and any
 *   "excess" against it is a price-position difference, not skill.
 *
 *   The fix is a PRICE-POSITION-MATCHED baseline: for each signal entry,
 *   pick a non-signal entry whose own position within its trailing-24h
 *   range is in the SAME bucket. If the excess vanishes against that
 *   baseline, the whole measured excess was the price position.
 *
 *   The independent evidence for this is already in hand: the
 *   DIRECTION-SHUFFLE placebo, which keeps the signal's bar set and
 *   randomises only the direction, scores as well as or better than the
 *   real signal in 4 of the 5 cells with a positive excess. A signal
 *   whose direction is random and which still "works" has no directional
 *   information at all.
 *
 * QUESTION 2 — WHAT DOES THE FEE ACTUALLY COST AT EACH HORIZON?
 *
 *   The premise of the study is that a multi-day hold amortises the fee.
 *   That is only true if the EXPECTED MOVE grows with the hold. This
 *   decomposes the drag per horizon into:
 *     - the FEE (0.12% per round trip, fixed per TRADE, so it does NOT
 *       amortise with the hold at all — it is paid once whatever the hold);
 *     - the FUNDING (charged per settlement inside the hold, so it DOES
 *       grow with the hold);
 *     - the BETA (what an unconditional position on the same side earned);
 *     - the EXCESS (the part the signal actually added).
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

const args = process.argv.slice(2);
const fl = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const HOLD = Number(fl("hold", 3));
const COND = fl("cond", "short-only");
const NSYM = Number(fl("symbols", 60));
const f = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);
const pad = (s, n) => String(s).padStart(n);
const padL = (s, n) => String(s).padEnd(n);

console.log(`[final] ${COND} @ ${HOLD}d, ${NSYM} symbols\n`);

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
function lcg(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; }; }
function hashStr(str, salt) { let h = (2166136261 ^ salt) >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

const wantDir = COND === "long-only" ? 1 : COND === "short-only" ? -1 : 0;
const universe = JSON.parse(readFileSync(join(CACHE, "universe.json"), "utf8"));
const files = readdirSync(CACHE).filter((x) => x.startsWith("k1h_")).slice(0, NSYM);

/** The price position of bar i within its trailing-24h range, 0..1. */
function pricePos(closes, i) {
  let hi = -Infinity, lo = Infinity;
  for (let k = i - 23; k <= i; k++) { if (closes[k] > hi) hi = closes[k]; if (closes[k] < lo) lo = closes[k]; }
  if (!(hi > lo)) return 0.5;
  return (closes[i] - lo) / (hi - lo);
}

let nUsed = 0;
const sigNet = [], posNet = [], timeNet = [], betaNet = [];
let sigPosSum = 0, ctlPosSum = 0, nPos = 0;

for (const f of files) {
  const symbol = f.slice(4, -5);
  const bars = loadSeries("k1h", symbol);
  if (!bars || bars.length < 300) continue;
  const n = bars.length;
  const closes = new Float64Array(n), vols = new Float64Array(n);
  for (let i = 0; i < n; i++) { closes[i] = bars[i][4]; vols[i] = bars[i][5]; }
  const dirAt = new Int8Array(n);
  for (let i = 24; i < n; i++) dirAt[i] = repoSignalDir(Array.from(closes.subarray(i - 23, i + 1)), Array.from(vols.subarray(i - 23, i + 1)));
  const tsToIdx = new Map();
  for (let i = 0; i < n; i++) tsToIdx.set(bars[i][0], i);
  const nHours = Math.ceil((A_TO - A_FROM) / HOUR) + 96;
  const cum = new Float64Array(nHours + 2);
  for (const s of loadFunding(symbol)) {
    const h = Math.floor((s.ts - A_FROM) / HOUR);
    if (h >= 0 && h <= nHours) cum[h + 1] += s.rate * 100;
  }
  for (let h = 1; h <= nHours + 1; h++) cum[h] += cum[h - 1];
  const fundAt = (h) => (h < 0 ? 0 : h >= cum.length ? cum[cum.length - 1] : cum[h]);
  let w0 = 0, w1 = n - 1;
  while (w0 < n && bars[w0][0] < A_FROM) w0++;
  while (w1 > w0 && bars[w1][0] >= A_TO) w1--;

  const netOf = (i, dir) => {
    const ts = bars[i][0];
    const ei = tsToIdx.get(ts + HOLD * DAY);
    if (ei === undefined) return null;
    const ep = closes[i], xp = closes[ei];
    if (!(ep > 0) || !(xp > 0)) return null;
    const gross = dir * ((xp - ep) / ep) * 100;
    const h0 = Math.floor((ts - A_FROM) / HOUR), h1 = Math.floor((ts + HOLD * DAY - A_FROM) / HOUR);
    const fund = dir > 0 ? fundAt(h1) - fundAt(h0) : -(fundAt(h1) - fundAt(h0));
    return { gross, fund, net: gross - fund - TAKER_RT };
  };

  // The signal entries.
  const sig = [];
  for (let i = Math.max(24, w0); i <= w1; i++) {
    const d = dirAt[i];
    if (!d) continue;
    if (wantDir && d !== wantDir) continue;
    sig.push(i);
  }
  if (!sig.length) continue;
  nUsed++;

  // The candidate pool: the non-signal bars, with their price positions.
  const sigSet = new Set(sig);
  const pool = [];
  for (let i = Math.max(24, w0); i <= w1; i++) if (!sigSet.has(i)) pool.push(i);

  // (a) THE PRICE-POSITION-MATCHED baseline: for each signal entry, a
  //     non-signal entry in the same price-position bucket.
  const NBUCKET = 10;
  const bucketOf = new Map();
  for (const p of pool) {
    const b = Math.min(NBUCKET - 1, Math.floor(pricePos(closes, p) * NBUCKET));
    if (!bucketOf.has(b)) bucketOf.set(b, []);
    bucketOf.get(b).push(p);
  }
  const rand = lcg(hashStr(symbol, 987654321));
  for (const s of sig) {
    const t = netOf(s, dirAt[s]);
    if (!t) continue;
    sigNet.push(t.net);
    sigPosSum += pricePos(closes, s);
    nPos++;
    const b = Math.min(NBUCKET - 1, Math.floor(pricePos(closes, s) * NBUCKET));
    let cands = bucketOf.get(b);
    if (!cands || !cands.length) {
      // The nearest bucket.
      let best = null, bestD = Infinity;
      for (const [bb, arr] of bucketOf) {
        const d = Math.abs(bb - b);
        if (d < bestD) { bestD = d; best = arr; }
      }
      cands = best;
    }
    if (!cands || !cands.length) continue;
    const p = cands[Math.floor(rand() * cands.length)];
    const tt = netOf(p, dirAt[s]);
    if (!tt) continue;
    posNet.push(tt.net);
    ctlPosSum += pricePos(closes, p);
    // (b) THE TIME-MATCHED baseline: a random non-signal entry.
    const p2 = pool[Math.floor(rand() * pool.length)];
    const t2 = netOf(p2, dirAt[s]);
    if (t2) timeNet.push(t2.net);
  }
  // (c) THE BETA: the same side, on EVERY bar. A separate sweep, so it
  //     does not truncate the signal loop above.
  if (wantDir) {
    for (let i = Math.max(24, w0); i <= w1; i++) {
      const b2 = netOf(i, wantDir);
      if (b2) betaNet.push(b2.net);
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`[final] ${nUsed} symbols used | ${sigNet.length} signal trades | ${posNet.length} price-matched | ${timeNet.length} time-matched | ${betaNet.length} beta\n`);

console.log("=== QUESTION 1: THE PRICE-POSITION ARTEFACT ===");
console.log(`  mean price position in the 24h range: signal ${(sigPosSum / Math.max(1, nPos) * 100).toFixed(1)}%  vs its control ${(ctlPosSum / Math.max(1, posNet.length) * 100).toFixed(1)}%`);
console.log(`  (0% = the day's low, 100% = the day's high)`);
const sm = mean(sigNet), pm = mean(posNet), tm = mean(timeNet), bm = mean(betaNet);
console.log(`\n  signal arm net:                        ${f(sm)}%`);
console.log(`  TIME-matched baseline:                 ${f(tm)}%   -> excess ${f(sm - tm)}%`);
console.log(`  PRICE-POSITION-matched baseline:        ${f(pm)}%   -> excess ${f(sm - pm)}%`);
if (wantDir) console.log(`  unconditional BETA (same side, every bar): ${f(bm)}%   -> excess ${f(sm - bm)}%`);
console.log(`\n  => if the PRICE-MATCHED excess is materially smaller than the TIME-MATCHED one,`);
console.log("     the measured excess was the PRICE POSITION, not the signal.");

console.log("\n=== QUESTION 2: THE FEE vs FUNDING DECOMPOSITION, BY HORIZON ===");
{
  const R = JSON.parse(readFileSync(join(CACHE, "multiday-results.json"), "utf8"));
  const rows = R.results.filter((r) => r.condition === COND);
  console.log(`  ${padL("hold", 6)}${padL("net/trd", 10)}${padL("gross", 10)}${padL("fund", 10)}${padL("fee", 8)}${padL("beta", 10)}${padL("excess", 10)}${padL("fee%move", 11)}${padL("fund%move", 11)}`);
  for (const r of rows.sort((a, b) => a.holdDays - b.holdDays)) {
    const feePctMove = r.grossPerTrade !== 0 ? Math.abs(TAKER_RT / r.grossPerTrade) * 100 : Infinity;
    const fundPctMove = r.grossPerTrade !== 0 ? Math.abs(r.fundPerTrade / r.grossPerTrade) * 100 : Infinity;
    console.log(
      `${padL(r.holdDays + "d", 6)}${pad(f(r.netPerTrade), 9)}%${pad(f(r.grossPerTrade), 9)}%` +
        `${pad(f(r.fundPerTrade), 9)}%${pad("0.12", 7)}%${pad(f(r.betaMean), 9)}%${pad(f(r.excess), 9)}%` +
        `${padL(feePctMove > 999 ? ">999" : feePctMove.toFixed(0) + "%", 11)}` +
        `${padL(fundPctMove > 999 ? ">999" : fundPctMove.toFixed(0) + "%", 11)}`,
    );
  }
  console.log("\n  The FEE is charged ONCE per trade, so it does NOT amortise with the hold at all:");
  console.log("  it is 0.12% whatever the hold length. The FUNDING is charged per settlement");
  console.log("  inside the hold, so it GROWS with the hold and dominates the drag at long H.");
}
console.log("\n[final] done");
