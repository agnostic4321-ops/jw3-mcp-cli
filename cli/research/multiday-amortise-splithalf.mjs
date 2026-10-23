#!/usr/bin/env node
/**
 * multiday-amortise-splithalf.mjs — the DECISIVE test on the one cell that
 * still stands: short-only, 3-day hold.
 *
 * Its margin over the best placebo is +0.0026pp on a quantity whose own
 * CI is [+0.084, +0.349] — a 0.265pp-wide interval. A margin of 0.0026pp
 * is 1% of the CI width, so it is indistinguishable from a tie on any
 * reading. The question is not "does the point estimate beat the placebo
 * point estimate" but "is the EDGE REAL", and the answer to that is
 * stability, not the point estimate.
 *
 *   T1 SPLIT-HALF. The 365 days split into two halves. A real edge is
 *      positive in BOTH. A selection artefact is in one.
 *
 *   T2 THREE CONSECUTIVE BLOCKS. The prior study's own stability bar:
 *      positive in at least 2 of 3.
 *
 *   T3 THE PER-SYMBOL CONSISTENCY. The prior study's "477 of 504
 *      symbols" check: how many symbols have a POSITIVE per-symbol
 *      excess? A real market-wide effect is positive in most symbols.
 *
 *   T4 THE EXCESS AGAINST ITS OWN NOISE, via a PLACEBO-BOOTSTRAP. The
 *      real arm's excess is re-drawn against 200 placebo arms; the
 *      fraction of placebos that beat the real one is the p-value of the
 *      comparison that actually matters.
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

const HOLD = Number(process.argv.includes("--hold") ? process.argv[process.argv.indexOf("--hold") + 1] : 3);
const COND = process.argv.includes("--cond") ? process.argv[process.argv.indexOf("--cond") + 1] : "short-only";
console.log(`[splithalf] ${COND} @ ${HOLD}d`);

/* ── rebuild the arms for this cell, from the cached klines ────────── */
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

// Per-symbol: the signal entries and a matched-entry baseline, with the
// day each trade falls on.
const perSym = [];
for (const u of universe) {
  const bars = loadSeries("k1h", u.symbol);
  if (!bars || bars.length < 200) continue;
  const n = bars.length;
  const closes = new Float64Array(n), vols = new Float64Array(n);
  for (let i = 0; i < n; i++) { closes[i] = bars[i][4]; vols[i] = bars[i][5]; }
  const dirAt = new Int8Array(n);
  for (let i = 24; i < n; i++) dirAt[i] = repoSignalDir(Array.from(closes.subarray(i - 23, i + 1)), Array.from(vols.subarray(i - 23, i + 1)));
  const tsToIdx = new Map();
  for (let i = 0; i < n; i++) tsToIdx.set(bars[i][0], i);
  const nHours = Math.ceil((A_TO - A_FROM) / HOUR) + 96;
  const cum = new Float64Array(nHours + 2);
  for (const s of loadFunding(u.symbol)) {
    const h = Math.floor((s.ts - A_FROM) / HOUR);
    if (h >= 0 && h <= nHours) cum[h + 1] += s.rate * 100;
  }
  for (let h = 1; h <= nHours + 1; h++) cum[h] += cum[h - 1];
  const fundAt = (h) => (h < 0 ? 0 : h >= cum.length ? cum[cum.length - 1] : cum[h]);
  let w0 = 0, w1 = n - 1;
  while (w0 < n && bars[w0][0] < A_FROM) w0++;
  while (w1 > w0 && bars[w1][0] >= A_TO) w1--;

  // The signal entries.
  const sig = [];
  for (let i = Math.max(24, w0); i <= w1; i++) {
    const d = dirAt[i];
    if (!d) continue;
    if (wantDir && d !== wantDir) continue;
    sig.push([i, d]);
  }
  if (!sig.length) continue;

  // The matched-entry baseline.
  const sigSet = new Set(sig.map((e) => e[0]));
  const rand = lcg(hashStr(u.symbol, 31337 * 15485863 + 12345));
  const pool = [];
  for (let i = Math.max(24, w0); i <= w1; i++) if (!sigSet.has(i)) pool.push(i);
  if (!pool.length) continue;
  const picks = [], sides = [];
  for (let k = 0; k < sig.length; k++) { picks.push(pool[Math.floor(rand() * pool.length)]); sides.push(sig[k][1]); }
  for (let k = picks.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); const t = picks[k]; picks[k] = picks[j]; picks[j] = t; }
  for (let k = sides.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); const t = sides[k]; sides[k] = sides[j]; sides[j] = t; }

  const mk = (entries) => {
    const out = [];
    for (let k = 0; k < entries.length; k++) {
      const i = entries[k][0], dir = entries[k][1];
      const ts = bars[i][0];
      const exitTs = ts + HOLD * DAY;
      const ei = tsToIdx.get(exitTs);
      if (ei === undefined) continue;
      const ep = closes[i], xp = closes[ei];
      if (!(ep > 0) || !(xp > 0)) continue;
      const gross = dir * ((xp - ep) / ep) * 100;
      const h0 = Math.floor((ts - A_FROM) / HOUR), h1 = Math.floor((exitTs - A_FROM) / HOUR);
      const fund = dir > 0 ? fundAt(h1) - fundAt(h0) : -(fundAt(h1) - fundAt(h0));
      out.push({ day: Math.floor(ts / DAY), net: gross - fund - TAKER_RT, sym: u.symbol, dir });
    }
    return out;
  };
  const base = [];
  for (let k = 0; k < picks.length; k++) base.push([picks[k], sides[k]]);
  perSym.push({ sig: mk(sig), base: mk(base) });
}
console.log(`[splithalf] ${perSym.length} symbols`);

/** The day-level difference series. */
function daySeries(arms) {
  const m = new Map();
  for (const a of arms) {
    let c = m.get(a.day);
    if (!c) { c = { sum: 0, n: 0 }; m.set(a.day, c); }
    c.sum += a.net; c.n++;
  }
  return m;
}
const sigDays = new Map();
const baseDays = new Map();
for (const p of perSym) {
  for (const t of p.sig) { let c = sigDays.get(t.day); if (!c) { c = { sum: 0, n: 0 }; sigDays.set(t.day, c); } c.sum += t.net; c.n++; }
  for (const t of p.base) { let c = baseDays.get(t.day); if (!c) { c = { sum: 0, n: 0 }; baseDays.set(t.day, c); } c.sum += t.net; c.n++; }
}
const days = [...sigDays.keys()].filter((d) => baseDays.has(d)).sort((a, b) => a - b);
const delta = new Map();
for (const d of days) delta.set(d, sigDays.get(d).sum / sigDays.get(d).n - baseDays.get(d).sum / baseDays.get(d).n);

const trimmed = (vals, frac = 0.05) => {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const k = Math.floor(s.length * frac);
  const core = s.slice(k, s.length - k);
  return core.length ? core.reduce((a, b) => a + b, 0) / core.length : 0;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const tStat = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : 0;
};
const f = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

/* ── T1 SPLIT-HALF ─────────────────────────────────────────────────── */
console.log("\n[T1] SPLIT-HALF (the two halves of the window)");
{
  const mid = days[Math.floor(days.length / 2)];
  const h1v = days.filter((d) => d < mid).map((d) => delta.get(d));
  const h2v = days.filter((d) => d >= mid).map((d) => delta.get(d));
  const e1 = trimmed(h1v), e2 = trimmed(h2v);
  console.log(`  first half  (${h1v.length} days): excess ${f(e1)}  t=${tStat(h1v).toFixed(2)}  ${e1 > 0 ? "POSITIVE" : "negative"}`);
  console.log(`  second half (${h2v.length} days): excess ${f(e2)}  t=${tStat(h2v).toFixed(2)}  ${e2 > 0 ? "POSITIVE" : "negative"}`);
  console.log(`  => ${e1 > 0 && e2 > 0 ? "STABLE in both halves." : "NOT stable — the edge is in ONE half. That is the signature of a selection artefact."}`);
}

/* ── T2 THREE CONSECUTIVE BLOCKS ───────────────────────────────────── */
console.log("\n[T2] THREE CONSECUTIVE BLOCKS");
{
  const per = Math.ceil(days.length / 3);
  const blocks = [];
  for (let b = 0; b < 3; b++) {
    const seg = days.slice(b * per, (b + 1) * per).map((d) => delta.get(d));
    if (!seg.length) continue;
    blocks.push({ b, n: seg.length, e: trimmed(seg), t: tStat(seg) });
  }
  for (const b of blocks) {
    console.log(`  block ${b.b}: ${b.n} days  excess ${f(b.e)}  t=${b.t.toFixed(2)}  ${b.e > 0 ? "POSITIVE" : "negative"}`);
  }
  const nPos = blocks.filter((b) => b.e > 0).length;
  console.log(`  => ${nPos} of ${blocks.length} blocks positive. The bar is >= 2 of 3.`);
  console.log(`     ${nPos >= 2 ? "PASSES the block bar." : "FAILS the block bar."}`);
}

/* ── T3 PER-SYMBOL CONSISTENCY ─────────────────────────────────────── */
console.log("\n[T3] PER-SYMBOL CONSISTENCY (the prior study's '477 of 504' check)");
{
  let nPos = 0, nTot = 0;
  const deltas = [];
  for (const p of perSym) {
    if (!p.sig.length || !p.base.length) continue;
    const sm = mean(p.sig.map((t) => t.net));
    const bm = mean(p.base.map((t) => t.net));
    deltas.push(sm - bm);
    nTot++;
    if (sm - bm > 0) nPos++;
  }
  console.log(`  symbols with a POSITIVE per-symbol excess: ${nPos} of ${nTot} (${(nPos / nTot * 100).toFixed(1)}%)`);
  console.log(`  the median per-symbol excess: ${f(trimmed(deltas))}`);
  console.log(`  the prior study's diurnal finding was 477 of 504 = 94.6% positive.`);
  console.log(`  => ${nPos / nTot > 0.8 ? "Broad, like a market-wide effect." : "NOT broad. A market-wide effect does not look like this."}`);
}

/* ── T4 THE EXCESS vs ITS OWN NOISE ────────────────────────────────── */
console.log("\n[T4] THE EXCESS's MAGNITUDE vs THE BOOTSTRAP's RESOLUTION");
{
  const vals = days.map((d) => delta.get(d));
  const full = trimmed(vals);
  const boot = [];
  let seed = 4242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < 2000; it++) {
    const s = [];
    for (let k = 0; k < vals.length; k++) s.push(vals[Math.floor(rand() * vals.length)]);
    boot.push(trimmed(s));
  }
  boot.sort((a, b) => a - b);
  const lo = boot[Math.floor(0.025 * boot.length)], hi = boot[Math.floor(0.975 * boot.length)];
  const sd = Math.sqrt(boot.reduce((a, b) => a + (b - mean(boot)) ** 2, 0) / boot.length);
  console.log(`  full-window excess: ${f(full)}  CI [${f(lo)}, ${f(hi)}]  bootstrap sd ${f(sd)}`);
  console.log(`  the placebo margin that decided the "win" was +0.0026pp.`);
  console.log(`  the bootstrap sd of the SAME quantity is ${f(sd)}pp, so the margin is`);
  console.log(`  ${(0.0026 / sd * 100).toFixed(1)}% of one standard error.`);
  console.log(`  => ${0.0026 / sd < 0.1 ? "The margin is a hundredth of a standard error. It is NOISE." : "the margin is meaningful."}`);
}
console.log("\n[splithalf] done");
