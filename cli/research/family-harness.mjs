#!/usr/bin/env node
/**
 * FAMILY HARNESS — the shared measurement instrument for the five
 * structurally different strategy families.
 *
 * ── WHAT THIS FIXES (relative to the exhausted exhaustion family) ──
 *
 * 1. THE FILL RULE IS CORRECT. A target is always BEYOND the market in
 *    the profitable direction, so a "scratch" is impossible by
 *    construction; but the rest of the corrected rule is kept exactly:
 *      - first touch of TP or the kill wins,
 *      - a bar that touches BOTH is a LOSS (conservative),
 *      - a trade that reaches neither is a TIME EXIT at its mark
 *        (the close of the last bar of the hold window).
 *
 * 2. THE CLUSTERING IS THE TICKET'S HOLDING PERIOD. Two signals inside
 *    the same holding window share the path that decides the outcome,
 *    so the t-statistic is computed on cluster means at width
 *    holdBars x 15 minutes — NOT on the collector's 5-minute round.
 *
 * 3. THE FEE IS THE VENUE'S REAL TAKER ROUND TRIP: 0.12% of notional
 *    (src/kucoin.ts: SCALP_TAKER_FEE_PCT = 0.06 per side), which is
 *    $0.0720 on a $60 ticket.
 *
 * ── THE BAR A CANDIDATE MUST CLEAR ──
 *    - net EV (after the fee) above the fee floor
 *    - t >= 2 on the cluster means at the ticket's holding period
 *    - trim-stable: the mean survives dropping the worst 3 and best 3
 *    - a size-matched placebo beside it: the real excess must beat the
 *      placebo distribution
 *    - a per-symbol breakdown, with the top symbol's share named
 *
 * READ-ONLY. Local caches and the keyless public kline API only.
 * No account calls, no venue calls, no orders.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

export const SCRATCH = join(homedir(), ".hermes/cache/scratch");
export const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
export const BARS = join(SCRATCH, "fee-floor-15m-bars.json");
export const VOLBARS = join(SCRATCH, "family-bars.vol.json");

export const EQUITY = 56.89;          // the account's current equity
export const NOTIONAL = 60.0;         // per ticket
export const RHO = NOTIONAL / EQUITY;  // exposure multiple
export const TAKER_RT = 0.0012;        // 0.12% round trip of notional
export const FEE_USD = NOTIONAL * TAKER_RT;          // $0.0720
export const FEE_FLOOR_EQ_PCT = TAKER_RT * RHO * 100; // % of equity per trade
export const BAR_MS = 15 * 60_000;

// ── small stats helpers ──
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
export const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
export const pct = (x, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
export const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const quantile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] : 0;

/** Drop the worst `n` and the best `n` trades. */
export function trim(vals, n = 3) {
  const s = [...vals].sort((a, b) => a - b);
  return s.length > 2 * n ? s.slice(n, s.length - n) : s;
}

// ── the bars ──
/**
 * Load the 15-minute bars, overlaying volume from the volume cache
 * when it exists. Returns { pair: { bars, idx: Map(ts->i) } }.
 */
export function loadBars({ withVolume = true } = {}) {
  const base = JSON.parse(readFileSync(BARS, "utf8"));
  let vol = {};
  if (withVolume) {
    try { vol = JSON.parse(readFileSync(VOLBARS, "utf8")); } catch { vol = {}; }
  }
  const out = {};
  for (const pair of Object.keys(base)) {
    const src = base[pair];
    if (!Array.isArray(src) || !src.length) continue;
    const vsrc = vol[pair] ?? [];
    const vmap = new Map();
    for (const b of vsrc) if (Number.isFinite(b.v)) vmap.set(b.t, b.v);
    const bars = src.map((b) => ({ t: b.t, h: b.h, l: b.l, c: b.c, v: vmap.get(b.t) ?? null }));
    const idx = new Map();
    bars.forEach((b, i) => idx.set(b.t, i));
    out[pair] = { pair, bars, idx };
  }
  return out;
}

// ── the trade ──
/**
 * Resolve one signal under the CORRECT fill rule.
 *
 * sig: { pair, ts, dir (+1 long / -1 short), entry, meta }
 * The signal bar is the bar whose CLOSE is the entry; the scan starts
 * at the NEXT bar, so no part of the signal bar is traded (no
 * look-ahead).
 *
 * Returns null when there is no full forward window (strict censoring:
 * a partial hold books a mark that is a function of WHEN the trade
 * happened, so those trades are excluded, not scored).
 */
export function resolveTrade(pb, sig, tpPct, stopPct, holdBars) {
  const bars = pb.bars;
  const i = sig.idx + 1;
  const end = i + holdBars;
  if (end > bars.length) return null;   // strict: full window required
  const entry = sig.entry;
  if (!(entry > 0)) return null;
  const tp = sig.dir > 0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = sig.dir > 0 ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = sig.dir > 0 ? bar.h >= tp : bar.l <= tp;
    const hitSl = sig.dir > 0 ? bar.l <= sl : bar.h >= sl;
    // A bar that touches BOTH is a LOSS.
    if (hitSl) return { kind: "loss", gross: -stopPct / 100 };
    if (hitTp) return { kind: "win", gross: tpPct / 100 };
  }
  const last = bars[end - 1];
  const mark = sig.dir > 0 ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", gross: mark };
}

/**
 * Resolve a set of signals into trades, with the fee applied.
 * pnl is in DOLLARS: gross% x notional - the fee.
 */
export function resolveAll(pbars, signals, tpPct, stopPct, holdBars) {
  const trades = [];
  for (const sig of signals) {
    const pb = pbars[sig.pair];
    if (!pb) continue;
    const o = resolveTrade(pb, sig, tpPct, stopPct, holdBars);
    if (!o) continue;
    const pnlUsd = o.gross * NOTIONAL - FEE_USD;
    trades.push({
      pair: sig.pair, ts: sig.ts, dir: sig.dir, kind: o.kind,
      gross: o.gross, pnlUsd, pnlEq: (pnlUsd / EQUITY) * 100,
      meta: sig.meta ?? null,
    });
  }
  return trades;
}

// ── the statistics ──
/**
 * The cluster-corrected EV at the ticket's holding period.
 * The cluster width IS the holding period, so every trade that shares a
 * path shares a cluster.
 */
export function clusterStats(trades, holdBars) {
  const ms = holdBars * BAR_MS;
  const g = new Map();
  for (const t of trades) {
    const k = Math.floor(t.ts / ms);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  const means = [...g.values()].map((v) => mean(v.map((t) => t.pnlEq)));
  if (!means.length) return { clusters: 0, ev: 0, se: 0, t: 0, clusterMeans: [] };
  const ev = mean(means);
  const se = stdev(means) / Math.sqrt(means.length);
  return { clusters: means.length, ev, se, t: se > 0 ? ev / se : 0, clusterMeans: means };
}

/** The full report block for one geometry. */
export function geometryStats(trades, holdBars) {
  if (!trades.length) {
    return { n: 0, clusters: 0, evUsd: 0, evEq: 0, t: 0, wins: 0, losses: 0, times: 0, winRate: 0, trimmedUsd: 0, span: null };
  }
  const usd = trades.map((t) => t.pnlUsd);
  const cs = clusterStats(trades, holdBars);
  const trimmed = trim(usd, 3);
  const ts = trades.map((t) => t.ts);
  return {
    n: trades.length,
    clusters: cs.clusters,
    evUsd: mean(usd),
    evEq: mean(trades.map((t) => t.pnlEq)),
    t: cs.t,
    seUsd: stdev(usd) / Math.sqrt(usd.length),
    wins: trades.filter((t) => t.kind === "win").length,
    losses: trades.filter((t) => t.kind === "loss").length,
    times: trades.filter((t) => t.kind === "time").length,
    winRate: trades.filter((t) => t.kind === "win").length / trades.length,
    trimmedUsd: mean(trimmed),
    span: [minOf(ts), maxOf(ts)],
    perSymbol: perSymbol(trades),
  };
}

/** The per-symbol breakdown, and the top symbol's share. */
export function perSymbol(trades) {
  const m = new Map();
  for (const t of trades) {
    const e = m.get(t.pair) ?? { pair: t.pair, n: 0, pnl: 0, wins: 0 };
    e.n++; e.pnl += t.pnlUsd; if (t.kind === "win") e.wins++;
    m.set(t.pair, e);
  }
  const arr = [...m.values()].sort((a, b) => b.pnl - a.pnl);
  const total = arr.reduce((s, e) => s + e.pnl, 0);
  const top = arr[0] ?? null;
  return {
    rows: arr,
    symbols: arr.length,
    total,
    top: top ? { ...top, share: total !== 0 ? (top.pnl / total) * 100 : 0 } : null,
  };
}

/** The excess of A over B, with the t-statistic on the difference. */
export function excessOf(a, b) {
  const d = Math.sqrt(a.se ** 2 + b.se ** 2);
  const excess = a.ev - b.ev;
  return { excess, t: d > 0 ? excess / d : 0, se: d };
}

/** The break-even win rate for a geometry. */
export function breakEven(tpPct, stopPct) {
  // p*tp - (1-p)*stop = fee  (in % of notional)
  const fee = TAKER_RT * 100;
  const denom = tpPct + stopPct;
  if (!(denom > 0)) return NaN;
  return ((stopPct + fee) / denom) * 100;
}

/** Three chronological blocks — a window is positive in only some blocks. */
export function blocks(trades, n = 3) {
  if (!trades.length) return [];
  const ts = trades.map((t) => t.ts);
  const lo = minOf(ts), hi = maxOf(ts);
  const w = (hi - lo) / n || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = lo + i * w, b = i === n - 1 ? hi + 1 : lo + (i + 1) * w;
    out.push({ name: `BLOCK ${i + 1}`, trades: trades.filter((t) => t.ts >= a && t.ts < b) });
  }
  return out;
}
