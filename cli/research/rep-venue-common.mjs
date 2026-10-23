#!/usr/bin/env node
/**
 * THE INDEPENDENT-VENUE REPLICATION — shared helpers.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * The GEOMETRY study measures one thing: does the machine's own signal
 * (the tape's exhaustion read, confirmed by the models) clear break-even
 * at some (target, stop) geometry, and does that beat the SAME geometry
 * on the SAME symbols with NO model filter?
 *
 * It has been measured on ONE venue's data (KuCoin). The prior three
 * families all produced false positives until a control or a replication
 * killed them, so the only untested question left is whether the excess
 * is a property of the MARKET or of the SAMPLE.
 *
 * This file holds everything both venues' runs share:
 *
 *   1. THE TAPE — the same `fadeMetrics` maths as `src/kucoin.ts`, ported
 *      verbatim so the independent venue measures the same state.
 *      (The SHARED `research/tape-signal.mjs` holds the SIGNAL half and
 *      is imported, not re-implemented.)
 *   2. THE LAYA BRIDGE — the deterministic Python rule engine at
 *      `packages/jw3-cli/python/laya_decide.py`, ported verbatim. The
 *      bridge is pure stdlib and rule-based, so it can be reproduced on
 *      any venue's market state. (Verified: it reproduces the collector's
 *      recorded `layaSide` on 1346/1346 rows.)
 *   3. THE TICKET SIMULATION — the first-touch TP/kill walk with
 *      conservative ties and an explicit time exit, identical to
 *      `analyze-geometry.mjs`'s `outcome()`.
 *   4. THE CLUSTER STATISTICS — t-statistics on CLUSTER MEANS, because
 *      the symbols in one time bucket move together and a row is not an
 *      observation.
 *
 * WHAT CANNOT BE REPLICATED, AND WHY IT MATTERS
 * ---------------------------------------------
 *
 * The machine's signal is a CONFLUENCE of two legs:
 *
 *   - the TAPE, a pure function of candles and volume. REPLICABLE.
 *   - the MODELS, and here the legs are:
 *       * LAYA — a deterministic rule bridge over the market state.
 *         REPLICABLE exactly.
 *       * JEV  — an LLM (typesafe/jev-1.13) reading a 7-timeframe
 *         feature snapshot. NOT REPLICABLE without the account's
 *         credentials, and calling it is out of scope for a read-only
 *         replication.
 *
 * So the replication cannot reproduce the JEV leg. It therefore tests
 * the CONFIRMATION LAYER THAT IS REPRODUCIBLE — the Laya bridge — and
 * states that limit plainly rather than pretending the full confluence
 * was reproduced. The JEV leg's role is quantified separately on the
 * KuCoin sample (how much of the arm's selection does the JEV leg
 * account for), so the reader knows exactly what the independent venue's
 * number does and does not cover.
 */
import { tapeSideFromRow, tapeSideOf, fadeSignal, dipSignal } from "/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/research/tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

export { tapeSideFromRow, tapeSideOf, fadeSignal, dipSignal };

// ── THE TAPE ────────────────────────────────────────────────────────────
//
// A verbatim port of `fadeMetrics` in `packages/jw3-cli/src/kucoin.ts`.
// The inputs are 1-minute candles: the live path reads 60 one-minute
// klines and takes the last 24 as the window.
//
//   vratio     = mean(volume of the last 12) / mean(volume of the 12 before)
//   offHighPct = (max(high) - last) / max(high) * 100
//   offLowPct  = (last - min(low)) / min(low) * 100
//   atrPct     = mean(true range over the last 15 candles) / last * 100
//   chg        = (last - close 24 candles ago) / that close * 100
export function fadeMetrics(closes, vols, highs, lows) {
  if (closes.length < 24 || vols.length < 24) return null;
  const recent = vols.slice(-12);
  const prior = vols.slice(-24, -12);
  const rmean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const pmean = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(pmean > 0)) return null;
  const mean5 = 5.5;
  const slope = recent.reduce((acc, v, i) => acc + (i - mean5) * (v - rmean), 0);
  const window = closes.slice(-24);
  const hi = maxOf(window);
  const lo = minOf(window);
  const last = closes[closes.length - 1];
  if (!(hi > 0) || !(lo > 0) || !Number.isFinite(last)) return null;
  const first = closes[closes.length - 24];
  let atrPct = null;
  if (highs && lows && highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
    const h = highs.slice(-15);
    const l = lows.slice(-15);
    const c = closes.slice(-15);
    const trs = [];
    for (let i = 1; i < 15; i++) {
      const prev = c[i - 1];
      trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - prev), Math.abs(l[i] - prev)));
    }
    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    if (atr > 0 && last > 0) atrPct = (atr / last) * 100;
  }
  return {
    chg: first !== 0 ? ((last - first) / first) * 100 : 0,
    vratio: rmean / pmean,
    vslope: slope < 0 ? "down" : "up",
    offHighPct: ((hi - last) / hi) * 100,
    offLowPct: ((last - lo) / lo) * 100,
    atrPct,
    n: closes.length,
  };
}

// ── THE LAYA BRIDGE ────────────────────────────────────────────────────
//
// A verbatim port of `packages/jw3-cli/python/laya_decide.py`.
//
//   jev   = side x agreement x 1.0        (absent/uncertain -> 0)
//   tape  = sign(chg) x min(|chg| / max(2xATR, 0.5), 1) x 0.6
//   book  = imb x 0.5                      (absent -> 0)
//   score = jev + tape + book
//   |score| >= 0.35 decides long/short, else flat
//   confidence = 0.5 + 0.4 x min(|score|, 1), capped 0.9;
//                x0.7 when JEV is missing/uncertain, x0.8 on a wide spread
export const DECIDE_THRESHOLD = 0.35;
export const WIDE_SPREAD_BPS = 10.0;

export function layaVerdict({ chg, atrPct, jevSide, jevAgreement, jevUncertain, imb, sprBps }) {
  const reasons = [];
  let jevTerm = 0;
  if (jevSide === "long" || jevSide === "short") {
    if (!jevUncertain) {
      jevTerm = (jevSide === "long" ? 1 : -1) * Math.max(0, Math.min(jevAgreement ?? 0, 1));
      reasons.push(`jev ${jevSide} (agreement ${(jevAgreement ?? 0).toFixed(2)})`);
    } else {
      reasons.push("jev absent or uncertain — no vote");
    }
  } else {
    reasons.push("jev absent or uncertain — no vote");
  }
  const denom = atrPct != null && atrPct > 0 ? Math.max(2 * atrPct, 0.5) : 0.5;
  const tapeUnit = Math.max(-1, Math.min(chg / denom, 1));
  const tapeTerm = (tapeUnit >= 0 ? 1 : -1) * Math.abs(tapeUnit) * 0.6;
  const bookTerm = imb != null ? Math.max(-1, Math.min(imb, 1)) * 0.5 : 0;
  const score = jevTerm + tapeTerm + bookTerm;
  const choice = score >= DECIDE_THRESHOLD ? "long" : score <= -DECIDE_THRESHOLD ? "short" : "flat";
  let conf = 0.5 + 0.4 * Math.min(Math.abs(score), 1);
  if (jevSide == null || jevUncertain) conf *= 0.7;
  if (sprBps != null && sprBps > WIDE_SPREAD_BPS) conf *= 0.8;
  conf = Math.max(0, Math.min(Math.round(conf * 10000) / 10000, 0.9));
  return { choice, confidence: conf, score: Math.round(score * 10000) / 10000, reasons };
}

// ── THE BOOK ───────────────────────────────────────────────────────────
//
// `spikeImbalance` / `spikeSpreadBps` in `src/kucoin.ts`:
//   imbalance = (bid5 - ask5) / (bid5 + ask5)
//   spreadBps = (ask - bid) / mid * 1e4
// where bid5/ask5 are the NOTIONAL of the top 5 levels on each side.
export function spikeImbalance(bid5, ask5) {
  if (!((bid5 + ask5) > 0)) return 0;
  return (bid5 - ask5) / (bid5 + ask5);
}
export function spikeSpreadBps(bid, ask) {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return 0;
  return ((ask - bid) / mid) * 1e4;
}

// ── THE TICKET SIMULATION ──────────────────────────────────────────────
//
// A verbatim port of `analyze-geometry.mjs`'s `outcome()`.
//
//   "win"  the target was touched first
//   "loss" the stop was touched first, OR the bar touched BOTH
//          (AMBIGUOUS, resolved conservatively as a loss)
//   null   neither was touched within the hold window
//   {kind:"time", movePct}  neither level was reached within the window,
//          so the trade is closed at the horizon's close and booked at
//          the mark-to-market (the explicit time exit)
export function outcome(bars, ts, entry, tpPct, slPct, long, maxHoldBars) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > ts) { start = i; break; }
  }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + maxHoldBars);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return "loss"; // AMBIGUOUS -> conservative
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

// ── THE STATISTICS ─────────────────────────────────────────────────────
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
export const tstat = (d) => {
  const s = se(d);
  return s > 0 ? mean(d) / s : 0;
};

/**
 * The EFFECTIVE sample size of a set of observations.
 *
 * The collector samples ~43 symbols at a time every 5 minutes. The rows
 * in one bucket are 43 different symbols moving TOGETHER — crypto is
 * correlated, so a market-wide move produces 43 near-identical
 * observations. Treating them as 43 independent samples overstates the
 * evidence by roughly the square root of the cluster size.
 *
 * The correction: the standard error of the CLUSTER MEANS (one mean per
 * time bucket). The t-statistic then reflects the number of INDEPENDENT
 * observations, which is the honest number.
 */
export function clusterStats(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const clusterMeans = [...byBucket.values()].map((a) => mean(a));
  return {
    clusters: clusterMeans.length,
    clusterMeans,
    mean: mean(clusterMeans),
    se: se(clusterMeans),
  };
}

/** The bucket key for an observation: one cluster per 5-minute bucket. */
export const bucketOf = (ts) => Math.floor(ts / (5 * 60_000));

// ── THE REGIME ─────────────────────────────────────────────────────────
//
// The market's own state, measured by the tape's geometry — the same
// split `analyze-geometry.mjs` uses. An excess that appears in ONE
// regime only is that regime's drift, not an edge.
export function regimeOf(offHighPct, offLowPct) {
  const oh = Number(offHighPct ?? 0);
  const ol = Number(offLowPct ?? 0);
  if (ol < 8 && oh >= 8) return "down";
  if (oh < 8 && ol >= 8) return "up";
  return "flat";
}
