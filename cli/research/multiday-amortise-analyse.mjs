#!/usr/bin/env node
/**
 * multiday-amortise-analyse.mjs — the ANALYSIS half of the multi-day-hold study.
 *
 * READ-ONLY. Reads cached klines from the scratch dir. No network, no
 * account, no venue, no orders.
 *
 * THE QUESTION
 *   Does a MULTI-DAY hold amortise the 0.12% taker round trip enough to make
 *   a directional rule profitable, where the same rule was measured EMPTY at
 *   short horizons?
 *
 * THE WINDOW (fresh — zero overlap with the exhausted 90-day study)
 *   analysis: 2025-07-22 22:00 -> 2026-07-22 22:00 UTC (365 days)
 *   exhausted: 2026-07-22 22:00 -> 2026-10-20 22:00 UTC (90 days)
 *
 * THE THREE CONDITIONS
 *   1. long-only  — the repo's shipped fade/dip signal, LONG side only
 *   2. short-only — the same signal, SHORT side only
 *   3. confluence — the signal PLUS a multi-timeframe agreement condition:
 *                   the last COMPLETED 4h bar must close on the same side of
 *                   its 4h EMA(20)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CONTROLS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A FIRST DRAFT of this analysis reported a long-only "excess" of +2.08%
 * PER DAY with t=7.94, which is not plausible as skill. The diagnosis
 * (multiday-amortise-diagnose2.mjs) found the cause: the control was the
 * same symbol's NON-signal hours on the same day, which buys the day's
 * AVERAGE while the signal buys the day's LOW. That is a mechanical
 * price-position advantage, not skill — and the pairing also clustered
 * too finely (one market move = many same-day symbols = ONE bet, not 38).
 *
 * The controls here are built to survive that:
 *
 *   CONTROL 1 — THE MATCHED-ENTRY BASELINE (the primary control).
 *     For each symbol, the SAME number of entries, the SAME side mix, the
 *     SAME hold, the SAME fee and funding model, but entered at RANDOM
 *     non-signal times inside the same window. Shape-matched by
 *     construction: it differs from the signal arm ONLY in WHEN it enters.
 *     It is NOT an arithmetic identity — the trades are different trades,
 *     priced independently.
 *
 *   CONTROL 2 — THE REVERSED DIRECTION on the same signal bars.
 *     The same bars, the opposite side, with the opposite funding sign.
 *
 *   CONTROL 3 — THE UNCONDITIONAL BETA BASELINE.
 *     The same side, held for the same duration on EVERY bar. This is the
 *     control that killed the diurnal lead and the BTC lead-lag lead. A
 *     rule that beats the matched-entry baseline but not the unconditional
 *     one is beta, not alpha.
 *
 *   The EXCESS the t-statistic tests is (signal arm) MINUS (the
 *   matched-entry baseline), aggregated to DAY clusters. The DAY is the
 *   market factor: one market-wide move fires the same signal on every
 *   symbol, so the independent unit is the day, and |t| on a 365-day
 *   window is bounded by sqrt(365) ~ 19. The cluster count and the span
 *   are reported with every result.
 *
 * THE PLACEBO FAMILIES (the bar)
 *   Three families of the same shape, run alongside, so the bar is "what
 *   does the best placebo score?" and not "p < 0.05":
 *
 *     P1 TIME-DISPLACEMENT: the signal evaluated 7/14/21/28 days EARLIER
 *        and traded now. Same shape, same count, same fee, same hold.
 *     P2 PER-SYMBOL RANDOM SHIFT: each symbol's own signal set circularly
 *        shifted by its own random offset in [30, 330] days. The within-
 *        symbol spacing and count are preserved EXACTLY; only the
 *        alignment to price is destroyed. This is the strongest null,
 *        because it keeps the signal's own clustering.
 *     P3 DIRECTION SHUFFLE: the signal's own bars with the directions
 *        permuted among them. It destroys only the DIRECTION, so it prices
 *        "does it know which way to go".
 *
 *   A candidate must beat the BEST placebo in ANY family at the same
 *   horizon and condition.
 *
 * THE BAR a condition must clear (per horizon, per side)
 *   (a) net expectancy > 0 (after the 0.12% taker round trip AND funding)
 *   (b) EXCESS over the matched-entry baseline > 0
 *   (c) t >= 2 on the DAY clusters
 *   (d) n_clusters >= 30
 *   (e) trim-stable: the 5% trimmed mean keeps the sign
 *   (f) beats EVERY placebo family
 *   A positive excess with t < 2 is a PATTERN, not a finding.
 *
 * FUNDING
 *   Charged per real settlement inside each holding window at the symbol's
 *   actual settled rate (long pays, short receives). Settlement spacing is
 *   read from the data, never assumed. At multi-day horizons this is a
 *   first-order cost: an 8-day hold crosses 24-48 settlements.
 *
 * USAGE
 *   node research/multiday-amortise-analyse.mjs [--json <file>] [--symbols N]
 *       [--min-clusters 30] [--cap 100] [--seed 12345]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/* ------------------------------------------------------------------ */
/* config                                                             */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const CACHE = flag("cache", join(homedir(), ".hermes/cache/scratch/mdh-2026"));
const OUT_JSON = flag("json", join(CACHE, "multiday-results.json"));
const MIN_CLUSTERS = Number(flag("min-clusters", 30));
const SYMBOL_LIMIT = Number(flag("symbols", 0));
const RETURN_CAP = Number(flag("cap", 100));
const MASTER_SEED = Number(flag("seed", 12345));

const A_FROM = Date.UTC(2025, 6, 22, 22, 0, 0);
const A_TO = Date.UTC(2026, 6, 22, 22, 0, 0);

const TAKER_RT = 0.12;
const HOLD_DAYS = [1, 2, 3, 5, 8];
const PLACEBO_LAGS = [7, 14, 21, 28];
const SHIFT_SEEDS = [1, 2, 3];
const SHUFFLE_SEEDS = [1, 2, 3];
const BOOT_ITERS = 2000;

/* ------------------------------------------------------------------ */
/* data loading                                                       */
/* ------------------------------------------------------------------ */

function loadSeries(prefix, symbol) {
  const f = join(CACHE, `${prefix}_${symbol}.json`);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(j.bars) ? j.bars : null;
  } catch { return null; }
}
function loadFunding(symbol) {
  const f = join(CACHE, `fr_${symbol}.json`);
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(j.settlements) ? j.settlements : [];
  } catch { return []; }
}

/* ------------------------------------------------------------------ */
/* the repo's shipped signal, replicated EXACTLY                       */
/* ------------------------------------------------------------------ */

function fadeMetrics(closes, vols) {
  if (closes.length < 24 || vols.length < 24) return null;
  const recent = vols.slice(-12);
  const prior = vols.slice(-24, -12);
  const rmean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const pmean = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(pmean > 0)) return null;
  const window = closes.slice(-24);
  const hi = maxOf(window);
  const lo = minOf(window);
  const last = closes[closes.length - 1];
  if (!(hi > 0) || !(lo > 0) || !Number.isFinite(last)) return null;
  const first = closes[closes.length - 24];
  return {
    vratio: rmean / pmean,
    offHighPct: ((hi - last) / hi) * 100,
    offLowPct: ((last - lo) / lo) * 100,
  };
}

/** Returns 1 for long, -1 for short, 0 for no signal. */
function repoSignalDir(closes, vols) {
  const m = fadeMetrics(closes, vols);
  if (!m) return 0;
  const { vratio, offHighPct, offLowPct } = m;
  let sSig = "neutral";
  if (offHighPct > 15) sSig = "late";
  else if (vratio < 0.85 && offHighPct < 8) sSig = "fade-short";
  else if (vratio > 3) sSig = "strong";
  let lSig = "neutral";
  if (offLowPct > 15) lSig = "extended";
  else if (vratio > 3) lSig = "capitulation";
  else if (vratio < 0.85 && offLowPct < 8) lSig = "dip-long";
  if (sSig === "fade-short" || lSig === "dip-long") return sSig === "fade-short" ? -1 : 1;
  return 0;
}

function emaSeries(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  if (!arr.length) return out;
  const k = 2 / (n + 1);
  let prev = arr[0];
  out[0] = prev;
  for (let i = 1; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}
function hashStr(str, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* per-symbol precomputation                                           */
/* ------------------------------------------------------------------ */

/**
 * For one symbol, precompute the signal direction at every bar, the 4h
 * confluence flag, the bar index by timestamp, and a funding prefix array
 * so funding(t0, t1] is O(1).
 */
function prepareSymbol(symbol) {
  const bars = loadSeries("k1h", symbol);
  if (!bars || bars.length < 200) return null;
  const n = bars.length;
  const closes = new Float64Array(n);
  const vols = new Float64Array(n);
  for (let i = 0; i < n; i++) { closes[i] = bars[i][4]; vols[i] = bars[i][5]; }

  const dirAt = new Int8Array(n);
  for (let i = 24; i < n; i++) {
    dirAt[i] = repoSignalDir(
      Array.from(closes.subarray(i - 23, i + 1)),
      Array.from(vols.subarray(i - 23, i + 1)),
    );
  }

  const mtfUp = new Int8Array(n);
  const b4 = loadSeries("k4h", symbol);
  if (b4 && b4.length >= 30) {
    const e4 = emaSeries(b4.map((x) => x[4]), 20);
    const m = new Map();
    for (let i = 0; i < b4.length; i++) m.set(b4[i][0], { close: b4[i][4], ema: e4[i] });
    for (let i = 0; i < n; i++) {
      const start = Math.floor(bars[i][0] / (4 * HOUR)) * (4 * HOUR) - 4 * HOUR;
      const rec = m.get(start);
      mtfUp[i] = rec && Number.isFinite(rec.ema) && rec.close > 0 ? (rec.close > rec.ema ? 1 : -1) : 0;
    }
  }

  const tsToIdx = new Map();
  for (let i = 0; i < n; i++) tsToIdx.set(bars[i][0], i);

  // The funding prefix array, indexed by hour offset from A_FROM.
  const nHours = Math.ceil((A_TO - A_FROM) / HOUR) + 96;
  const cum = new Float64Array(nHours + 2);
  const fs = loadFunding(symbol).slice().sort((a, b) => a.ts - b.ts);
  for (const s of fs) {
    const h = Math.floor((s.ts - A_FROM) / HOUR);
    if (h >= 0 && h <= nHours) cum[h + 1] += s.rate * 100;
  }
  for (let h = 1; h <= nHours + 1; h++) cum[h] += cum[h - 1];

  // The window's bar index range (the first and last bar inside it).
  let w0 = 0, w1 = n - 1;
  while (w0 < n && bars[w0][0] < A_FROM) w0++;
  while (w1 > w0 && bars[w1][0] >= A_TO) w1--;

  return { symbol, bars, closes, dirAt, mtfUp, tsToIdx, cum, nHours, w0, w1, nSettle: fs.length };
}

function cumAt(prep, h) {
  if (h < 0) return 0;
  if (h >= prep.cum.length) return prep.cum[prep.cum.length - 1];
  return prep.cum[h];
}
function fundingBetween(prep, t0, t1, sign) {
  const h0 = Math.floor((t0 - A_FROM) / HOUR);
  const h1 = Math.floor((t1 - A_FROM) / HOUR);
  if (h1 < 0) return 0;
  const d = cumAt(prep, h1) - cumAt(prep, h0);
  return sign > 0 ? d : -d;
}

/* ------------------------------------------------------------------ */
/* trade arms, held in flat typed arrays (memory)                      */
/* ------------------------------------------------------------------ */

/**
 * A trade arm is a set of flat arrays, so 50M trades cost ~1GB of
 * primitives rather than ~10GB of JS objects.
 */
class Arm {
  constructor(cap = 0) {
    this.n = 0;
    this.cap = cap;
    this.sym = new Int32Array(cap);
    this.day = new Int32Array(cap);
    this.gross = new Float64Array(cap);
    this.fund = new Float64Array(cap);
    this.net = new Float64Array(cap);
  }
  _grow() {
    const cap = this.cap || 1024;
    const g = (Arr, T) => { const a = new T(cap * 2); a.set(this[Arr]); return a; };
    this.sym = g("sym", Int32Array);
    this.day = g("day", Int32Array);
    this.gross = g("gross", Float64Array);
    this.fund = g("fund", Float64Array);
    this.net = g("net", Float64Array);
    this.cap = cap * 2;
  }
  push(sym, day, gross, fund) {
    if (this.n >= this.cap) this._grow();
    const i = this.n++;
    this.sym[i] = sym; this.day[i] = day;
    this.gross[i] = gross; this.fund[i] = fund;
    this.net[i] = gross - fund - TAKER_RT;
  }
  get meanNet() { return this.n ? this.net.subarray(0, this.n).reduce((a, b) => a + b, 0) / this.n : 0; }
}

/**
 * Build a trade arm from a list of (barIndex, direction) entries.
 * Entry = the bar's close; exit = the close of the bar exactly holdDays
 * later on the SAME symbol. A missing exit bar DROPS the trade, and the
 * drop is COUNTED (never silently).
 */
function buildArm(prep, entries, holdDays, arm) {
  let dropped = 0;
  for (let k = 0; k < entries.length; k += 2) {
    const i = entries[k];
    const dir = entries[k + 1];
    const ts = prep.bars[i][0];
    const exitTs = ts + holdDays * DAY;
    const ei = prep.tsToIdx.get(exitTs);
    if (ei === undefined) { dropped++; continue; }
    const ep = prep.closes[i];
    const xp = prep.closes[ei];
    if (!(ep > 0) || !(xp > 0)) { dropped++; continue; }
    const gross = dir * ((xp - ep) / ep) * 100;
    const fund = fundingBetween(prep, ts, exitTs, dir);
    arm.push(prep.symIndex, Math.floor(ts / DAY), gross, fund);
  }
  return dropped;
}

/* ------------------------------------------------------------------ */
/* statistics                                                         */
/* ------------------------------------------------------------------ */

function tTest(vals) {
  const n = vals.length;
  if (n < 2) return { n, mean: 0, se: 0, t: 0, sd: 0 };
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of vals) ss += (v - mean) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, se, t: se > 0 ? mean / se : 0, sd };
}

/**
 * A bootstrap CI on the TRIMMED mean — the SAME functional as the
 * headline estimate.
 *
 * The repo's `kucoin-futures-data` skill states the rule: "Quote the
 * point estimate and the CI from the same functional. A 5%-trimmed mean
 * over raw events with a bootstrap that trims per-timestamp means produces
 * a CI that does not bracket its own point estimate." Bootstrapping the
 * RAW mean while reporting the TRIMMED mean is the same error in the
 * other direction, so this resamples and trims on every iteration.
 */
function bootCITrimmed(vals, iters = BOOT_ITERS) {
  if (vals.length < 5) return null;
  let seed = 987654321;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const means = new Float64Array(iters);
  const draw = new Float64Array(vals.length);
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < vals.length; k++) draw[k] = vals[Math.floor(rand() * vals.length)];
    means[it] = trimmedMean(draw, 0.05);
  }
  means.sort();
  const q = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  const mMean = means.reduce((a, b) => a + b, 0) / means.length;
  const mSd = Math.sqrt(means.reduce((a, b) => a + (b - mMean) ** 2, 0) / means.length);
  return {
    ciLow: q(0.025), ciHigh: q(0.975),
    pNotGreaterThanZero: means.filter((m) => m <= 0).length / means.length,
    sd: mSd,
  };
}

function trimmedMean(vals, frac = 0.05) {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const k = Math.floor(s.length * frac);
  const core = s.slice(k, s.length - k);
  if (!core.length) return s[Math.floor(s.length / 2)];
  let sum = 0;
  for (const v of core) sum += v;
  return sum / core.length;
}

/**
 * The measured result for one (condition, horizon, side).
 *
 * The HEADLINE excess and the t-statistic refer to the SAME estimand: the
 * DAY-level difference (signal mean - matched-entry baseline mean), pooled
 * over days, with a 5% trim for the fat tail. The day is the cluster
 * because the market factor is the day.
 */
function measure(sig, base, revMean, betaMean) {
  // Per-symbol means, for the secondary (equal-weight-per-symbol) estimand.
  const symSig = new Map();
  const symBase = new Map();
  for (let i = 0; i < sig.n; i++) {
    let c = symSig.get(sig.sym[i]);
    if (!c) { c = { sum: 0, n: 0 }; symSig.set(sig.sym[i], c); }
    c.sum += sig.net[i]; c.n++;
  }
  for (let i = 0; i < base.n; i++) {
    let c = symBase.get(base.sym[i]);
    if (!c) { c = { sum: 0, n: 0 }; symBase.set(base.sym[i], c); }
    c.sum += base.net[i]; c.n++;
  }
  const symExcess = [];
  for (const [sym, s] of symSig) {
    const b = symBase.get(sym);
    if (!b || !b.n) continue;
    symExcess.push({ sym, delta: s.sum / s.n - b.sum / b.n });
  }
  const symExcessTrim = trimmedMean(symExcess.map((e) => e.delta));
  const symExcessRaw = symExcess.length ? symExcess.reduce((a, e) => a + e.delta, 0) / symExcess.length : 0;
  const sorted = [...symExcess].sort((a, b) => b.delta - a.delta);
  const totalAbs = symExcess.reduce((a, e) => a + Math.abs(e.delta), 0);
  const top10Share = totalAbs > 0 ? sorted.slice(0, 10).reduce((a, e) => a + Math.abs(e.delta), 0) / totalAbs : 0;

  // The DAY-level difference — the market factor is the day.
  const sigDay = new Map();
  const baseDay = new Map();
  for (let i = 0; i < sig.n; i++) {
    const d = sig.day[i];
    let c = sigDay.get(d);
    if (!c) { c = { sum: 0, n: 0 }; sigDay.set(d, c); }
    c.sum += sig.net[i]; c.n++;
  }
  for (let i = 0; i < base.n; i++) {
    const d = base.day[i];
    let c = baseDay.get(d);
    if (!c) { c = { sum: 0, n: 0 }; baseDay.set(d, c); }
    c.sum += base.net[i]; c.n++;
  }
  const dayDeltas = [];
  for (const [d, c] of sigDay) {
    const b = baseDay.get(d);
    if (!b) continue;
    dayDeltas.push({ day: d, mean: c.sum / c.n - b.sum / b.n });
  }
  const dayVals = dayDeltas.map((d) => d.mean);
  const excStat = tTest(dayVals);
  const boot = bootCITrimmed(dayVals);
  const excessTrim = trimmedMean(dayVals, 0.05);
  const excessRaw = dayVals.length ? dayVals.reduce((a, b) => a + b, 0) / dayVals.length : 0;
  const trimStable = Math.sign(excessTrim) === Math.sign(excessRaw);
  // The bootstrap's own resolution: the standard error of the SAME
  // statistic. A margin over a placebo bar smaller than this is a TIE,
  // not a win, and the bar must be measured against it.
  const bootSd = boot?.sd ?? null;

  // ── STABILITY ──
  // The prior study's own out-of-sample discipline: the excess must
  // survive a split-half and be positive in at least 2 of 3 consecutive
  // blocks. A candidate that lives in one half of the window is a
  // selection artefact, and this is the check that says so.
  const sortedDays = dayDeltas.slice().sort((a, b) => a.day - b.day);
  const half = Math.floor(sortedDays.length / 2);
  const h1 = sortedDays.slice(0, half).map((d) => d.mean);
  const h2 = sortedDays.slice(half).map((d) => d.mean);
  const half1 = trimmedMean(h1, 0.05);
  const half2 = trimmedMean(h2, 0.05);
  const per = Math.ceil(sortedDays.length / 3);
  const blocks = [];
  for (let b = 0; b < 3; b++) {
    const seg = sortedDays.slice(b * per, (b + 1) * per).map((d) => d.mean);
    blocks.push({ n: seg.length, e: seg.length ? trimmedMean(seg, 0.05) : 0, t: tTest(seg).t });
  }
  const blocksPositive = blocks.filter((b) => b.n > 0 && b.e > 0).length;
  const stableHalves = half1 > 0 && half2 > 0;

  // The per-symbol consistency (the prior study's "477 of 504" check).
  let nSymPos = 0;
  for (const e of symExcess) if (e.delta > 0) nSymPos++;

  const nTrades = sig.n;
  let netSum = 0, grossSum = 0, fundSum = 0, wins = 0, nClipped = 0;
  for (let i = 0; i < nTrades; i++) {
    netSum += sig.net[i]; grossSum += sig.gross[i]; fundSum += sig.fund[i];
    if (sig.net[i] > 0) wins++;
    if (Math.abs(sig.gross[i]) > RETURN_CAP) nClipped++;
  }
  const days = [...sigDay.keys()];
  const spanDays = days.length ? maxOf(days) - minOf(days) + 1 : 0;

  return {
    nTrades, nClusters: dayDeltas.length, nSignalDays: sigDay.size, nBaseDays: baseDay.size,
    nSymbols: symExcess.length,
    netPerTrade: nTrades ? netSum / nTrades : 0,
    grossPerTrade: nTrades ? grossSum / nTrades : 0,
    fundPerTrade: nTrades ? fundSum / nTrades : 0,
    winRate: nTrades ? (wins / nTrades) * 100 : 0,
    excess: excessTrim, excessRaw,
    symExcess: symExcessTrim, symExcessRaw,
    excessT: excStat.t, trimStable,
    half1, half2, stableHalves,
    blocks, blocksPositive,
    nSymPos, symPosPct: symExcess.length ? (nSymPos / symExcess.length) * 100 : 0,
    reverseMean: revMean, betaMean,
    top10Share, nClipped,
    ciLow: boot?.ciLow ?? null, ciHigh: boot?.ciHigh ?? null,
    pNotGreaterThanZero: boot?.pNotGreaterThanZero ?? null,
    bootSd,
    spanDays,
  };
}

/* ------------------------------------------------------------------ */
/* the run                                                            */
/* ------------------------------------------------------------------ */

const universe = JSON.parse(readFileSync(join(CACHE, "universe.json"), "utf8"));
let symbols = universe.map((u) => u.symbol);
if (SYMBOL_LIMIT > 0) symbols = symbols.slice(0, SYMBOL_LIMIT);

console.log(
  `[analyse] window ${new Date(A_FROM).toISOString().slice(0, 16)} -> ${new Date(A_TO).toISOString().slice(0, 16)} UTC` +
    ` | ${symbols.length} symbols | holds ${HOLD_DAYS.join(",")}d | cap ${RETURN_CAP}%`,
);

const t0 = Date.now();
const preps = [];
for (const s of symbols) {
  const p = prepareSymbol(s);
  if (p) { p.symIndex = preps.length; preps.push(p); }
}
console.log(`[analyse] prepared ${preps.length} symbols in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/**
 * The signal entry set for a given (variant, condition) — a flat array of
 * (barIndex, direction) pairs.
 *
 * variant: "real" (lag 0), "lag7".."lag28", "shift{s}", "shuffle{s}".
 */
function signalEntries(prep, variant, useConfluence, wantDir) {
  const n = prep.bars.length;
  const out = [];
  const w0 = prep.w0, w1 = prep.w1;

  if (variant === "real") {
    for (let i = Math.max(24, w0); i <= w1; i++) {
      const d = prep.dirAt[i];
      if (!d) continue;
      if (wantDir && d !== wantDir) continue;
      if (useConfluence && (!prep.mtfUp[i] || prep.mtfUp[i] !== d)) continue;
      out.push(i, d);
    }
    return out;
  }

  if (variant.startsWith("lag")) {
    const lagBars = Number(variant.slice(3)) * 24;
    for (let i = Math.max(24, w0); i <= w1; i++) {
      const si = i - lagBars;
      if (si < 24) continue;
      const d = prep.dirAt[si];
      if (!d) continue;
      if (wantDir && d !== wantDir) continue;
      if (useConfluence && (!prep.mtfUp[i] || prep.mtfUp[i] !== d)) continue;
      out.push(i, d);
    }
    return out;
  }

  if (variant.startsWith("shift")) {
    // Circular shift of the symbol's OWN signal set by a per-symbol random
    // offset in [30, 330] days. The count and the within-symbol spacing are
    // preserved exactly; only the alignment to price is destroyed.
    const seed = Number(variant.slice(5));
    const rand = lcg(hashStr(prep.symbol, seed * 7919 + MASTER_SEED));
    const span = w1 - w0 + 1;
    const offset = 30 * 24 + Math.floor(rand() * (300 * 24));
    for (let k = 0; k < out.length; k += 2) {
      const i = out[k];
      let j = w0 + ((i - w0 + offset) % span);
      if (j < 24) j += 24;
      if (j > w1) continue;
      out[k] = j;
    }
    // Rebuild from the base set (the shift must apply to the base set).
    const base = [];
    for (let i = Math.max(24, w0); i <= w1; i++) {
      const d = prep.dirAt[i];
      if (!d) continue;
      if (wantDir && d !== wantDir) continue;
      if (useConfluence && (!prep.mtfUp[i] || prep.mtfUp[i] !== d)) continue;
      base.push(i, d);
    }
    const shifted = [];
    for (let k = 0; k < base.length; k += 2) {
      let j = w0 + ((base[k] - w0 + offset) % span);
      if (j < 24) j += 24;
      if (j > w1) continue;
      shifted.push(j, base[k + 1]);
    }
    return shifted;
  }

  if (variant.startsWith("shuffle")) {
    const seed = Number(variant.slice(6));
    const rand = lcg(hashStr(prep.symbol, seed * 104729 + MASTER_SEED));
    const base = [];
    for (let i = Math.max(24, w0); i <= w1; i++) {
      const d = prep.dirAt[i];
      if (!d) continue;
      if (wantDir && d !== wantDir) continue;
      if (useConfluence && (!prep.mtfUp[i] || prep.mtfUp[i] !== d)) continue;
      base.push(i, d);
    }
    const nEnt = base.length / 2;
    const dirs = new Int8Array(nEnt);
    for (let k = 0; k < nEnt; k++) dirs[k] = base[k * 2 + 1];
    for (let k = nEnt - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      const t = dirs[k]; dirs[k] = dirs[j]; dirs[j] = t;
    }
    const out2 = [];
    for (let k = 0; k < nEnt; k++) out2.push(base[k * 2], dirs[k]);
    return out2;
  }
  throw new Error(`unknown variant ${variant}`);
}

/**
 * THE MATCHED-ENTRY BASELINE: the same NUMBER of entries, the SAME side
 * mix, entered at RANDOM non-signal times inside the same window. Same
 * hold, same fee, same funding model. It differs from the signal arm ONLY
 * in WHEN it enters.
 */
function matchedEntries(prep, sigEntries, armSeed) {
  const n = prep.bars.length;
  const sigSet = new Set();
  for (let k = 0; k < sigEntries.length; k += 2) sigSet.add(sigEntries[k]);
  const rand = lcg(hashStr(prep.symbol, armSeed * 15485863 + MASTER_SEED));
  const nEnt = sigEntries.length / 2;
  if (!nEnt) return [];
  // The candidate non-signal bars.
  const pool = [];
  for (let i = Math.max(24, prep.w0); i <= prep.w1; i++) if (!sigSet.has(i)) pool.push(i);
  if (!pool.length) return [];
  const nLong = Math.round((sigEntries.filter((_, k) => k % 2 === 1 && sigEntries[k] > 0).length / nEnt) * nEnt);
  const out = [];
  // Draw the times first, then assign the sides — so the timing is
  // independent of the side.
  const picks = [];
  for (let k = 0; k < nEnt; k++) picks.push(pool[Math.floor(rand() * pool.length)]);
  // Shuffle the picks so the side assignment is uncorrelated with the time.
  for (let k = picks.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    const t = picks[k]; picks[k] = picks[j]; picks[j] = t;
  }
  // The side mix: read the signal's own sides, in their own order.
  const sides = [];
  for (let k = 0; k < nEnt; k++) sides.push(sigEntries[k * 2 + 1]);
  for (let k = sides.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    const t = sides[k]; sides[k] = sides[j]; sides[j] = t;
  }
  for (let k = 0; k < nEnt; k++) out.push(picks[k], sides[k]);
  return out;
}

const results = [];
const placeboResults = [];
const tRun = Date.now();

const VARIANTS = [
  "real",
  ...PLACEBO_LAGS.map((d) => `lag${d}`),
  ...SHIFT_SEEDS.map((s) => `shift${s}`),
  ...SHUFFLE_SEEDS.map((s) => `shuffle${s}`),
];
const FAMILIES = {
  real: "real",
  ...Object.fromEntries(PLACEBO_LAGS.map((d) => [`lag${d}`, "P1-displace"])),
  ...Object.fromEntries(SHIFT_SEEDS.map((s) => [`shift${s}`, "P2-shift"])),
  ...Object.fromEntries(SHUFFLE_SEEDS.map((s) => [`shuffle${s}`, "P3-shuffle"])),
};

for (const condition of ["long-only", "short-only", "confluence"]) {
  const useConf = condition === "confluence";
  const wantDir = condition === "long-only" ? 1 : condition === "short-only" ? -1 : 0;

  // The entry sets are computed ONCE per (condition, variant) and reused
  // across the hold lengths.
  const perVariant = new Map();
  for (const variant of VARIANTS) {
    perVariant.set(variant, preps.map((prep) => ({
      prep,
      entries: signalEntries(prep, variant, useConf, wantDir || null),
    })));
  }

  for (const holdDays of HOLD_DAYS) {
    for (const variant of VARIANTS) {
      const perSym = perVariant.get(variant);
      const sigArm = new Arm();
      const baseArm = new Arm();
      const revArm = new Arm();
      let betaSum = 0, betaN = 0;
      let dropped = 0;

      for (const { prep, entries } of perSym) {
        if (!entries.length) continue;
        dropped += buildArm(prep, entries, holdDays, sigArm);

        // The matched-entry baseline, with a variant-specific seed so each
        // placebo family gets its OWN baseline.
        const armSeed = hashStr(variant, 31337) % 100000;
        const mEntries = matchedEntries(prep, entries, armSeed);
        if (mEntries.length) dropped += buildArm(prep, mEntries, holdDays, baseArm);

        // The reversed direction on the same bars.
        const rev = new Int32Array(entries.length);
        for (let k = 0; k < entries.length; k += 2) { rev[k] = entries[k]; rev[k + 1] = -entries[k + 1]; }
        buildArm(prep, rev, holdDays, revArm);

        // The unconditional beta baseline: the same side, every bar. It is
        // streamed (sum and count only), because it is one bar per hour per
        // symbol and would otherwise dominate memory.
        if (wantDir) {
          for (let i = Math.max(24, prep.w0); i <= prep.w1; i++) {
            const ts = prep.bars[i][0];
            const exitTs = ts + holdDays * DAY;
            const ei = prep.tsToIdx.get(exitTs);
            if (ei === undefined) continue;
            const ep = prep.closes[i], xp = prep.closes[ei];
            if (!(ep > 0) || !(xp > 0)) continue;
            const gross = wantDir * ((xp - ep) / ep) * 100;
            const fund = fundingBetween(prep, ts, exitTs, wantDir);
            betaSum += gross - fund - TAKER_RT;
            betaN++;
          }
        } else {
          // The confluence arm has no single side, so the beta is the
          // signal's own side on that bar's day, held on every bar.
          for (let i = Math.max(24, prep.w0); i <= prep.w1; i++) {
            const ts = prep.bars[i][0];
            const exitTs = ts + holdDays * DAY;
            const ei = prep.tsToIdx.get(exitTs);
            if (ei === undefined) continue;
            const ep = prep.closes[i], xp = prep.closes[ei];
            if (!(ep > 0) || !(xp > 0)) continue;
            const dir = i > 0 ? Math.sign(prep.closes[i] - prep.closes[i - 1]) || 1 : 1;
            const gross = dir * ((xp - ep) / ep) * 100;
            const fund = fundingBetween(prep, ts, exitTs, dir);
            betaSum += gross - fund - TAKER_RT;
            betaN++;
          }
        }
      }

      const m = measure(sigArm, baseArm, revArm.meanNet, betaN ? betaSum / betaN : 0);
      const rec = { holdDays, variant, family: FAMILIES[variant], condition, isPlacebo: variant !== "real", dropped, ...m };
      if (variant === "real") results.push(rec);
      else placeboResults.push(rec);
    }
    console.log(`[analyse] ${condition} hold=${holdDays}d done — ${((Date.now() - tRun) / 1000).toFixed(0)}s`);
  }
}

/* ------------------------------------------------------------------ */
/* the report                                                         */
/* ------------------------------------------------------------------ */

const f = (x, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);
const pad = (s, n) => String(s).padStart(n);
const padL = (s, n) => String(s).padEnd(n);

console.log("\n" + "=".repeat(146));
console.log("MULTI-DAY HOLD: does the fee drag amortise?  (fresh 365d window, ZERO overlap with the exhausted 90d study)");
console.log("=".repeat(146));
console.log(`fee: ${TAKER_RT}% taker round trip on notional + real funding per settlement`);
console.log(`excess = 5% trimmed DAY-level (signal - MATCHED-ENTRY baseline); t on the same day clusters`);

for (const condition of ["long-only", "short-only", "confluence"]) {
  console.log(`\n### ${condition}`);
  console.log(
    `${padL("hold", 6)}${padL("net/trd", 11)}${padL("gross", 10)}${padL("fund", 9)}${padL("excess", 11)}` +
      `${padL("sym_exc", 10)}${pad("t(exc)", 8)}${pad("clus", 6)}${pad("sym", 5)}${pad("span", 6)}` +
      `${padL("rev", 10)}${padL("beta", 10)}${padL("top10%", 8)}${padL("best_pb", 10)}${padL("p<=0", 7)}${padL("verdict", 22)}`,
  );
  for (const holdDays of HOLD_DAYS) {
    const r = results.find((x) => x.holdDays === holdDays && x.condition === condition);
    if (!r) continue;
    const cands = placeboResults.filter((x) => x.holdDays === holdDays && x.condition === condition);
    const best = cands.length ? cands.reduce((a, b) => (b.excess > a.excess ? b : a)) : null;
    // The margin over the placebo bar, and the bootstrap's own resolution.
    // A margin SMALLER than one standard error of the same statistic is a
    // TIE, not a win — the two numbers are indistinguishable.
    const margin = best ? r.excess - best.excess : 0;
    const marginInNoise = best && r.bootSd != null && margin < r.bootSd;
    // THE BAR. Every clause must hold:
    //   (a) net expectancy > 0 after the fee and funding
    //   (b) excess over the matched-entry baseline > 0
    //   (c) t >= 2 on the day clusters
    //   (d) n_clusters >= 30
    //   (e) trim-stable
    //   (f) beats EVERY placebo family, BY MORE THAN THE NOISE
    //   (g) STABLE: positive in both halves of the window
    //   (h) positive in >= 2 of 3 consecutive blocks
    //   (i) broad: a majority of symbols individually positive
    const passes =
      r.nClusters >= MIN_CLUSTERS && r.netPerTrade > 0 && r.excess > 0 &&
      r.excessT >= 2 && r.trimStable && best && margin > 0 && !marginInNoise &&
      r.stableHalves && r.blocksPositive >= 2 && r.symPosPct > 50;
    const verdict = passes
      ? "*** CLEARS THE BAR ***"
      : marginInNoise
        ? "ties the placebo bar"
        : r.excess > 0 && r.excessT < 2
          ? "pattern (t<2)"
          : r.netPerTrade > 0
            ? "no excess over control"
            : "net negative";
    console.log(
      `${padL(holdDays + "d", 6)}${pad(f(r.netPerTrade), 10)}%${pad(f(r.grossPerTrade), 9)}%` +
        `${pad(f(r.fundPerTrade), 8)}%${pad(f(r.excess), 10)}%${pad(f(r.symExcess), 9)}%` +
        `${pad(r.excessT.toFixed(2), 8)}${pad(r.nClusters, 6)}${pad(r.nSymbols, 5)}${pad(r.spanDays, 6)}` +
        `${pad(f(r.reverseMean), 9)}%${pad(f(r.betaMean), 9)}%${pad((r.top10Share * 100).toFixed(0) + "%", 8)}` +
        `${padL(best ? f(best.excess) : "-", 10)}${padL(r.pNotGreaterThanZero?.toFixed(3) ?? "-", 7)}` +
        `${padL(verdict, 22)}`,
    );
  }
}

console.log("\n### STABILITY (the out-of-sample bar) — halves, blocks, per-symbol breadth");
console.log(
  `${padL("condition", 14)}${padL("hold", 6)}${padL("excess", 10)}${padL("half1", 10)}${padL("half2", 10)}` +
    `${padL("blocks", 10)}${padL("blocks+", 9)}${padL("sym_pos", 10)}${padL("stable", 10)}`,
);
for (const r of results) {
  const btxt = r.blocks.map((b) => f(b.e, 3)).join(" ");
  console.log(
    `${padL(r.condition, 14)}${padL(r.holdDays + "d", 6)}${pad(f(r.excess), 9)}%` +
      `${pad(f(r.half1), 9)}%${pad(f(r.half2), 9)}%${padL(btxt, 10)}` +
      `${padL(r.blocksPositive + "/3", 9)}${padL(r.nSymPos + "/" + r.nSymbols, 10)}` +
      `${padL(r.stableHalves ? "yes" : "NO", 10)}`,
  );
}

console.log("\n### THE MARGIN OVER THE PLACEBO BAR vs THE BOOTSTRAP's OWN NOISE");
console.log("  A margin smaller than one standard error of the same statistic is a TIE.");
console.log(
  `${padL("condition", 14)}${padL("hold", 6)}${padL("excess", 10)}${padL("best_pb", 10)}${padL("margin", 10)}` +
    `${padL("boot_sd", 10)}${padL("margin/sd", 11)}${padL("verdict", 24)}`,
);
for (const r of results) {
  const cands = placeboResults.filter((x) => x.holdDays === r.holdDays && x.condition === r.condition);
  const best = cands.length ? cands.reduce((a, b) => (b.excess > a.excess ? b : a)) : null;
  if (!best) continue;
  const margin = r.excess - best.excess;
  const ratio = r.bootSd ? margin / r.bootSd : NaN;
  const verdict = margin <= 0
    ? "LOSES to a placebo"
    : ratio < 1
      ? "TIE (margin < 1 sd)"
      : "beats the placebo by >1 sd";
  console.log(
    `${padL(r.condition, 14)}${padL(r.holdDays + "d", 6)}${pad(f(r.excess), 9)}%${pad(f(best.excess), 9)}%` +
      `${pad(f(margin), 9)}%${pad(f(r.bootSd ?? 0), 9)}%${padL(isNaN(ratio) ? "-" : ratio.toFixed(2) + "x", 11)}` +
      `${padL(verdict, 24)}`,
  );
}

console.log("\n### THE PLACEBO FAMILIES (same shape, edge removed) — excess over the same matched-entry baseline");
console.log(`${padL("hold", 6)}${padL("condition", 14)}${padL("family", 14)}per-variant (excess, t, clusters)`);
for (const holdDays of HOLD_DAYS) {
  for (const condition of ["long-only", "short-only", "confluence"]) {
    for (const family of ["P1-displace", "P2-shift", "P3-shuffle"]) {
      const cands = placeboResults.filter((x) => x.holdDays === holdDays && x.condition === condition && x.family === family);
      if (!cands.length) continue;
      const txt = cands.map((c) => `${c.variant}(${f(c.excess)}, t=${c.excessT.toFixed(1)}, n=${c.nClusters})`).join(" ");
      console.log(`${padL(holdDays + "d", 6)}${padL(condition, 14)}${padL(family, 14)}${txt}`);
    }
  }
}

console.log("\n### DETAIL (real cells)");
for (const r of results) {
  if (r.nClusters === 0) continue;
  console.log(
    `  ${padL(r.condition, 14)} ${padL(r.holdDays + "d", 5)} ` +
      `trades=${pad(r.nTrades, 7)} day_clusters=${pad(r.nClusters, 4)} syms=${pad(r.nSymbols, 4)} ` +
      `span=${pad(r.spanDays, 4)}d  net/trd=${pad(f(r.netPerTrade), 9)}%  ` +
      `excess=${pad(f(r.excess), 9)}% (raw ${f(r.excessRaw)}, sym ${f(r.symExcess)})  t=${pad(r.excessT.toFixed(2), 6)}  ` +
      `CI[${f(r.ciLow ?? 0, 3)}, ${f(r.ciHigh ?? 0, 3)}]  p(<=0)=${r.pNotGreaterThanZero?.toFixed(3) ?? "-"}` +
      `  halves ${f(r.half1)}/${f(r.half2)}  blocks ${r.blocksPositive}/3  sym+ ${r.symPosPct.toFixed(0)}%` +
      `  rev=${f(r.reverseMean)}%  beta=${f(r.betaMean)}%  trim_stable=${r.trimStable}  clipped=${r.nClipped}`,
  );
}

console.log("\n### THE HORIZON ARITHMETIC (what hold would make the fee matter less)");
console.log("  The fee is a FIXED 0.12% per round trip; the gross move scales with the hold,");
console.log("  so the fee's share of the move falls as 1/H — but only if the move is REAL.");
for (const condition of ["long-only", "short-only", "confluence"]) {
  const rows = HOLD_DAYS.map((h) => {
    const r = results.find((x) => x.holdDays === h && x.condition === condition);
    return r ? { h, gross: r.grossPerTrade, excess: r.excess, net: r.netPerTrade } : null;
  }).filter(Boolean);
  if (!rows.length) continue;
  const gpd = rows.map((r) => r.gross / r.h);
  const meanGpd = gpd.reduce((a, b) => a + b, 0) / gpd.length;
  const absGpd = Math.abs(meanGpd);
  console.log(`  ${padL(condition, 14)} gross/day = ${f(meanGpd, 4)}%/day (|.| = ${absGpd.toFixed(4)}%/day)`);
  for (const frac of [0.5, 0.25, 0.1]) {
    const H = absGpd > 0 ? TAKER_RT / (frac * absGpd) : Infinity;
    console.log(
      `      the fee is ${(frac * 100).toFixed(0)}% of the move at H = ${H > 10000 ? ">10000" : H.toFixed(1)} days` +
        `  (gross over H = ${(absGpd * Math.min(H, 10000)).toFixed(3)}%)`,
    );
  }
}

writeFileSync(OUT_JSON, JSON.stringify({
  window: { from: A_FROM, to: A_TO },
  holdDays: HOLD_DAYS, placeboLags: PLACEBO_LAGS, shiftSeeds: SHIFT_SEEDS, shuffleSeeds: SHUFFLE_SEEDS,
  takerRT: TAKER_RT, minClusters: MIN_CLUSTERS, nSymbols: preps.length, returnCap: RETURN_CAP,
  results, placeboResults,
}, null, 1));
console.log(`\n[analyse] -> ${OUT_JSON}`);
console.log(`[analyse] done in ${((Date.now() - tRun) / 1000).toFixed(0)}s`);
