/**
 * THE ORDER-FLOW STUDY — shared harness.
 *
 * ══ THE RULES THIS FILE ENCODES ══
 *
 * 1. ROWS ARE NOT OBSERVATIONS. ~45 symbols every 5 minutes, all
 *    correlated. Every t-statistic is computed on CLUSTER MEANS, with
 *    the cluster being one 5-minute round (the collector's own cadence).
 *    A conservative hourly clustering is reported alongside, because 60
 *    consecutive 5-minute buckets is not 60 independent observations.
 *
 * 2. A FORWARD RETURN IS NOT A TRADE OUTCOME. Forward returns measure a
 *    PREDICTOR (test 1 asks for exactly that). A trade outcome is a
 *    first-touch TP / kill, with a bar touching BOTH booked as a LOSS,
 *    and an explicit TIME EXIT for a trade that reaches neither level.
 *
 * 3. THE t MUST TEST THE EXCESS OVER A GENUINE CONTROL. Every excess
 *    here is the signal arm minus the UNCONDITIONAL arm on the same
 *    symbols and the same rounds, paired by cluster, so the market's
 *    drift cancels.
 *
 * 4. A PLACEBO OF THE SAME SHAPE. A random selection of the same size,
 *    same shape, from the same population.
 *
 * 5. TRIM. The worst-3 and best-3 clusters are dropped and the t is
 *    recomputed, so one lucky round cannot carry the result.
 *
 * READ-ONLY. No account call, no venue call except the explicitly
 * keyless public endpoints in the fetch script.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCRATCH = join(homedir(), ".hermes/cache/scratch");
export const OFLOW = join(SCRATCH, "oflow");

// ── THE BINDING CONSTRAINT ──
export const EQUITY = 57.1579522047;
export const NOTIONAL = 60.0;
export const RHO = NOTIONAL / EQUITY;
export const TAKER = 0.0006; // per leg, of notional
export const ROUND_TRIP = TAKER * 2; // 0.0012 of notional
export const FEE_USD = NOTIONAL * ROUND_TRIP; // $0.0720

// ── the live path's ticket geometry (kucoin.ts / live-cmd.ts) ──
export const ATR_MULT_STOP = 0.9;
export const ATR_CLAMP_LO = 0.6;
export const ATR_CLAMP_HI = 1.5;
export const TP_ATR_MULT = 0.4;
export const TP_CLAMP_LO = 0.3;
export const TP_CLAMP_HI = 0.5;
export const BARS_BEFORE = 16; // 16 x 15m = 240 minutes

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (m - b) ** 2, 0) / (xs.length - 1));
};
export const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
export const bucketOf = (ts) => Math.floor(ts / (5 * 60_000));
export const hourBucketOf = (ts) => Math.floor(ts / (60 * 60_000));

/** A deterministic PRNG, so every placebo is reproducible. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

// ── LOADERS ──
export function loadRows(path) {
  const txt = readFileSync(path, "utf8").trim();
  if (path.endsWith(".json")) {
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : j.rows ?? [];
  }
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function loadBars(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── CLUSTER STATISTICS ──
/** The mean per cluster, and the cluster-corrected standard error. */
export function clusterStats(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(values[i]);
  }
  const clusterMeans = [...byBucket.values()].map(mean);
  const se = clusterMeans.length > 1 ? stdev(clusterMeans) / Math.sqrt(clusterMeans.length) : 0;
  return { clusters: clusterMeans.length, clusterMeans, mean: mean(clusterMeans), se };
}

/**
 * THE PAIRED EXCESS: signal cluster mean minus control cluster mean,
 * within the same round. The market's drift cancels, because both arms
 * are measured on the same symbols at the same time.
 */
export function pairedExcess(signal, control, buckets, controlBuckets = buckets) {
  const byS = new Map(), byC = new Map();
  for (let i = 0; i < signal.length; i++) {
    const b = buckets[i];
    if (!byS.has(b)) byS.set(b, []);
    byS.get(b).push(signal[i]);
  }
  for (let i = 0; i < control.length; i++) {
    const b = controlBuckets[i];
    if (!byC.has(b)) byC.set(b, []);
    byC.get(b).push(control[i]);
  }
  const diffs = [];
  const pairs = [];
  for (const [b, va] of byS) {
    const vb = byC.get(b);
    if (!vb || !vb.length) continue;
    const d = mean(va) - mean(vb);
    diffs.push(d);
    pairs.push({ bucket: b, sig: mean(va), ctl: mean(vb), diff: d });
  }
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  const m = mean(diffs);
  return { n: diffs.length, mean: m, se, t: se > 0 ? m / se : 0, diffs, pairs };
}

/** TRIM: drop the worst-3 and best-3 clusters, recompute the t. */
export function trimmed(diffs, k = 3) {
  if (diffs.length <= 2 * k) return { n: diffs.length, mean: mean(diffs), se: 0, t: 0, trimmedOut: 0 };
  const s = [...diffs].sort((a, b) => a - b);
  const kept = s.slice(k, s.length - k);
  const se = kept.length > 1 ? stdev(kept) / Math.sqrt(kept.length) : 0;
  const m = mean(kept);
  return {
    n: kept.length,
    mean: m,
    se,
    t: se > 0 ? m / se : 0,
    trimmedOut: diffs.length - kept.length,
    worst3: s.slice(0, k),
    best3: s.slice(s.length - k),
  };
}

/**
 * THE PLACEBO: a random selection of the same SIZE and the same SHAPE
 * (the same number of rows per round) drawn from the same population.
 * Returns the distribution of the excess and the t.
 */
export function placebo(signalArm, controlArm, buckets, trials = 2000, seed = 20261021) {
  const rand = rng(seed);
  // the shape: how many rows the signal arm has in each round
  const shape = new Map();
  for (let i = 0; i < signalArm.length; i++) {
    const b = buckets[i];
    shape.set(b, (shape.get(b) ?? 0) + 1);
  }
  const ctlByB = new Map();
  for (let i = 0; i < controlArm.length; i++) {
    const b = buckets[i];
    if (!ctlByB.has(b)) ctlByB.set(b, []);
    ctlByB.get(b).push(controlArm[i]);
  }
  const ctlBuckets = [...ctlByB.keys()];
  const exs = [], ts = [];
  for (let t = 0; t < trials; t++) {
    // a random selection of the signal arm's rows, per round
    const picked = [];
    for (const [b, n] of shape) {
      const pool = ctlByB.get(b);
      if (!pool || !pool.length) continue;
      for (let k = 0; k < n; k++) picked.push(pool[Math.floor(rand() * pool.length)]);
    }
    if (!picked.length) continue;
    const pk = picked.map((_, i) => 0);
    const ex = pairedExcess(picked, controlArm, picked.map((_, i) => shapeKeys[i]));
    // the placebo's excess uses the control's own values as the "signal",
    // which is the null: the same rows, re-drawn.
    exs.push(ex.mean);
    ts.push(ex.t);
  }
  const sortedEx = [...exs].sort((a, b) => a - b);
  const sortedT = [...ts].sort((a, b) => a - b);
  const real = mean(exs);
  const pct = (sortedEx.filter((x) => x < real).length / sortedEx.length) * 100;
  return {
    trials: exs.length,
    exMean: real,
    exSd: stdev(exs),
    exP5: sortedEx[Math.floor(sortedEx.length * 0.05)],
    exP95: sortedEx[Math.floor(sortedEx.length * 0.95)],
    tMean: mean(ts),
    tP95: sortedT[Math.floor(sortedT.length * 0.95)],
    significant: ts.filter((t) => t >= 2).length,
    percentile: pct,
  };
}

/**
 * A cleaner placebo: shuffle the SIGNAL arm's ROW ASSIGNMENT within each
 * round, so the arm's SIZE and SHAPE and the control are identical, and
 * only the pairing between the signal and the control is broken.
 */
export function pairedPlacebo(signal, control, buckets, trials = 2000, seed = 20261021) {
  const rand = rng(seed);
  const exs = [], ts = [];
  for (let t = 0; t < trials; t++) {
    // shuffle the signal values within the whole sample, keeping the
    // bucket labels attached to the rows (so the cluster structure of
    // the SIGNAL arm is preserved) — this destroys the signal/control
    // correspondence only.
    const idx = signal.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const sh = idx.map((i) => signal[i]);
    const ex = pairedExcess(sh, control, buckets);
    exs.push(ex.mean);
    ts.push(ex.t);
  }
  const sortedEx = [...exs].sort((a, b) => a - b);
  const sortedT = [...ts].sort((a, b) => a - b);
  const real = mean(exs);
  return {
    trials: exs.length,
    exMean: real,
    exSd: stdev(exs),
    exP5: sortedEx[Math.floor(sortedEx.length * 0.05)],
    exP95: sortedEx[Math.floor(sortedEx.length * 0.95)],
    tMean: mean(ts),
    tP95: sortedT[Math.floor(sortedT.length * 0.95)],
    significant: ts.filter((t) => t >= 2).length,
    percentile: (sortedEx.filter((x) => x < real).length / sortedEx.length) * 100,
  };
}

// ── FORWARD RETURNS (a PREDICTOR, not a trade outcome) ──
/**
 * The forward return over H minutes from the recorded book mid at ts.
 * The exit is the CLOSE of the last 15-minute bar at or before ts+H.
 * Returns null when the bar cache does not reach that far.
 */
export function forwardReturn(r, bars, horizonMin) {
  const b = bars[r.pair];
  if (!b || !b.length) return null;
  if (!(r.price > 0)) return null;
  // The forward window starts at the FIRST bar after the read, which is
  // exactly where the ticket's trade starts — so the predictor and the
  // trade resolution use the same price path.
  let i = -1;
  for (let k = 0; k < b.length; k++) if (b[k].t > r.ts) { i = k; break; }
  if (i < 0) return null;
  const nBars = Math.max(1, Math.round(horizonMin / 15));
  const exitIdx = i + nBars - 1;
  if (exitIdx >= b.length) return null;
  const exitBar = b[exitIdx];
  return { ret: (exitBar.c - r.price) / r.price, exitT: exitBar.t, bars: nBars };
}

// ── THE TICKET (a trade outcome) ──
/**
 * The live path's ticket, in the live path's units: `d` and `tpPct` are
 * PERCENT NUMBERS.
 */
export function ticketFor(r, dir) {
  const atrPct = r.tapeAtrPct;
  if (!(atrPct > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = r.price;
  if (!(last > 0)) return null;
  const avgEntry = dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, stopPrice, targetPrice };
}

/**
 * Resolve the ticket against the forward bars.
 *  - a bar touching BOTH levels is a LOSS (conservative)
 *  - a trade reaching neither level is a TIME EXIT at the mark
 */
export function resolveTicket(r, dir, bars, holdBars = BARS_BEFORE) {
  const t = ticketFor(r, dir);
  if (!t) return null;
  const b = bars[r.pair];
  if (!b || !b.length) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + holdBars);
  if (end - i < 2) return null;
  const long = dir === "long";
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= t.targetPrice : bar.l <= t.targetPrice;
    const hitSl = long ? bar.l <= t.stopPrice : bar.h >= t.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -t.stopFrac - ROUND_TRIP, ticket: t };
    if (hitTp) return { outcome: "win", bars: k - i + 1, pnlPct: t.tpFrac - ROUND_TRIP, ticket: t };
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -t.stopFrac - ROUND_TRIP, ticket: t };
  }
  const lastBar = b[end - 1];
  const movePct = long
    ? (lastBar.c - t.avgEntry) / t.avgEntry
    : (t.avgEntry - lastBar.c) / t.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: movePct - ROUND_TRIP, ticket: t };
}

/** The dollars. The net expectancy per trade, at the real size. */
export const pnlUsd = (pnlPct) => pnlPct * NOTIONAL;

/** The break-even win rate for a given win/loss pair, in dollars. */
export function breakEvenWinRate(winUsd, lossUsd) {
  const denom = winUsd - lossUsd;
  return denom !== 0 ? -lossUsd / denom : 0;
}
