#!/usr/bin/env node
/**
 * THE MEASUREMENT ENGINE — identical on both venues.
 *
 * This is the part that must be BYTE-IDENTICAL between the KuCoin run
 * and the independent-venue run, or the comparison is meaningless. It
 * takes a set of observations (a tape side, a direction, a timestamp) and
 * a set of 15-minute bars, and produces:
 *
 *   - the ticket outcome per observation (first-touch TP/kill, a bar
 *     touching both is a LOSS, an explicit time exit)
 *   - the per-trade equity P&L
 *   - the EXCESS over the unconditional baseline
 *   - the t-statistic on CLUSTER MEANS (one cluster per 5-minute bucket),
 *     because the symbols in one bucket move together
 *
 * The geometry list, the fee, the exposure, the cluster size and the
 * bucket width are all read from ONE place, so the two venues cannot
 * drift apart on a constant.
 */
import {
  outcome, mean, se, clusterStats, bucketOf, regimeOf,
} from "./rep-venue-common.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

/** The taker round trip, in %, charged on the notional. */
export const TAKER_RT = 0.12;
/** The bar interval, in minutes. */
export const BAR_MIN = 15;
/** How long a trade is held before it is called unresolved, in bars. */
export const MAX_HOLD_BARS = 16; // 4 hours at 15-minute bars
/** The exposure: $60 notional on $57.23 equity. */
export const EQUITY = 57.2287;
export const NOTIONAL = 60.0;
export const NOE = NOTIONAL / EQUITY;

/**
 * The geometries to test. The first is the SHIPPED ticket's geometry
 * (the TP and stop the live path actually produces); the rest are the
 * candidates worth testing. `tp: null` means "derive it from ATR,
 * exactly as the live path does".
 */
export const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR capped 0.5%, SL=ATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2%  SL 0.8%", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

/**
 * Simulate one geometry over one set of observations.
 *
 * Identical logic for the signal arm and the unconditional arm, so the
 * two are comparable by construction. The per-trade array is built in
 * the SAME order as the bucket array, so the cluster statistics pair
 * them exactly.
 */
export function simulate(set, g, CACHE, opts = {}) {
  // The venue's own taker round trip. KuCoin's study uses 0.12%; Binance
  // USDⓈ-M's published VIP-0 taker is 0.05% per side, so 0.10%. The
  // fee enters the expectancy identically on both venues.
  const TAKER = opts.takerRt ?? TAKER_RT;
  const wins = [], losses = [];
  let unresolved = 0, ambiguous = 0, missingAtr = 0, truncated = 0;
  const timeExits = [], timeExitMarks = [];
  const winBuckets = [], lossBuckets = [], timeExitBuckets = [];
  const rows = [];
  for (const c of set) {
    const bars = CACHE[c.pair];
    if (!bars?.length) { unresolved++; continue; }
    // The entry is the close of the last bar at or before the observation.
    let idx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t <= c.ts) idx = i;
      else break;
    }
    if (idx < 0) { unresolved++; continue; }
    const entry = bars[idx].c;
    const atrPct = Number(c.tapeAtrPct ?? c.tape?.atrPct ?? NaN);
    // The SHIPPED geometry: TP = clamp(ATR*0.4, 0.3, 0.5), SL = the live
    // path's ATR-driven stop (the observed stop was ~1.34x ATR).
    const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
    const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
    if (g.shipped) {
      // No ATR means the shipped geometry cannot be reproduced. It must
      // be REFUSED, not approximated.
      if (!Number.isFinite(atrPct) || atrPct <= 0) { missingAtr++; unresolved++; continue; }
    }
    if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
    if (opts.strictWindow) {
      // The observation needs a bar at or after ts + 4h, so a "time
      // exit" is a real 4-hour mark and not a truncated one.
      const need = c.ts + MAX_HOLD_BARS * BAR_MIN * 60_000;
      let ok = false;
      for (let i = 0; i < bars.length; i++) if (bars[i].t >= need) { ok = true; break; }
      if (!ok) { truncated++; unresolved++; continue; }
    }
    const long = c.dir === "long";
    const o = outcome(bars, c.ts, entry, tpPct, slPct, long, MAX_HOLD_BARS);
    if (o === null) { unresolved++; continue; }
    const bucket = bucketOf(c.ts);
    if (typeof o === "object") {
      // A TIME EXIT: closed at the horizon's close, booked at the mark.
      timeExits.push((o.movePct - TAKER) * NOE);
      timeExitMarks.push(o.movePct);
      timeExitBuckets.push(bucket);
      rows.push({ c, kind: "time", pnl: (o.movePct - TAKER_RT) * NOE, bucket });
      continue;
    }
    if (o === "loss") {
      // Detect the ambiguous case (both levels touched) for the report.
      const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
      const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
      let start = -1;
      for (let i = 0; i < bars.length; i++) { if (bars[i].t > c.ts) { start = i; break; } }
      if (start >= 0) {
        for (let i = start; i < Math.min(bars.length, start + MAX_HOLD_BARS); i++) {
          const b = bars[i];
          const hitTp = long ? b.h >= tp : b.l <= tp;
          const hitSl = long ? b.l <= sl : b.h >= sl;
          if (hitTp && hitSl) { ambiguous++; break; }
          if (hitTp || hitSl) break;
        }
      }
    }
    const pnl = o === "win"
      ? (g.tp ?? 0.4) * NOE - TAKER * NOE
      : -(g.sl ?? 1.2) * NOE - TAKER * NOE;
    (o === "win" ? wins : losses).push(c);
    (o === "win" ? winBuckets : lossBuckets).push(bucket);
    rows.push({ c, kind: o, pnl, bucket });
  }
  return {
    wins, losses, unresolved, ambiguous, missingAtr, truncated,
    timeExits, timeExitMarks,
    winBuckets, lossBuckets, timeExitBuckets,
    rows,
  };
}

/**
 * The expectancy and the EXCESS over the unconditional baseline, with
 * the t-statistic on CLUSTER MEANS.
 *
 * The excess's standard error is the standard error of the DIFFERENCE of
 * two means — the two arms are different sets of observations, so they
 * must NOT be paired by index. Both arms' standard errors are computed
 * on CLUSTER MEANS (one per 5-minute bucket), because the rows in one
 * bucket are ~40 correlated symbols moving together.
 */
export function measure(signalSet, uncondSet, g, CACHE, opts = {}) {
  const TAKER = opts.takerRt ?? TAKER_RT;
  const S = simulate(signalSet, g, CACHE, opts);
  const U = simulate(uncondSet, g, CACHE, opts);
  const sPer = [
    ...S.wins.map(() => (g.tp ?? 0.4) * NOE - TAKER * NOE),
    ...S.losses.map(() => -(g.sl ?? 1.2) * NOE - TAKER * NOE),
    ...S.timeExits,
  ];
  const uPer = [
    ...U.wins.map(() => (g.tp ?? 0.4) * NOE - TAKER * NOE),
    ...U.losses.map(() => -(g.sl ?? 1.2) * NOE - TAKER * NOE),
    ...U.timeExits,
  ];
  const sBuckets = [...S.winBuckets, ...S.lossBuckets, ...S.timeExitBuckets];
  const uBuckets = [...U.winBuckets, ...U.lossBuckets, ...U.timeExitBuckets];
  const sCl = clusterStats(sPer, sBuckets);
  const uCl = clusterStats(uPer, uBuckets);
  const excess = sCl.mean - uCl.mean;
  const excessSe = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
  const excessT = excessSe > 0 ? excess / excessSe : 0;
  const n = S.wins.length + S.losses.length;
  const uN = U.wins.length + U.losses.length;
  return {
    g, n, winRate: n ? S.wins.length / n : 0,
    timeExits: S.timeExits.length, unresolved: S.unresolved,
    ambiguous: S.ambiguous, missingAtr: S.missingAtr, truncated: S.truncated,
    ev: sCl.mean, evSe: sCl.se, sClusters: sCl.clusters,
    uEv: uCl.mean, uSe: uCl.se, uClusters: uCl.clusters,
    uN, uWinRate: uN ? U.wins.length / uN : 0,
    uTimeExits: U.timeExits.length,
    excess, excessSe, excessT,
    sPerTrade: sPer, uPerTrade: uPer,
    signalRows: S.rows, uncondRows: U.rows,
  };
}

/**
 * THE TRIM TEST. The signal arm's per-trade P&L, with the worst 3 and the
 * best 3 dropped, and the excess re-measured against the same
 * unconditional baseline. If the excess survives both trims, it is a
 * property of the sample; if it collapses, it was a handful of rows.
 */
export function trimTest(r) {
  if (!r.sPerTrade || r.sPerTrade.length < 8) return null;
  const sorted = [...r.sPerTrade].sort((a, b) => a - b);
  const trimWorst = sorted.slice(3);
  const trimBest = sorted.slice(0, sorted.length - 3);
  const exW = mean(trimWorst) - r.uEv;
  const exB = mean(trimBest) - r.uEv;
  const tW = se(trimWorst) > 0 ? exW / se(trimWorst) : 0;
  const tB = se(trimBest) > 0 ? exB / se(trimBest) : 0;
  return {
    exWorst: exW, exBest: exB, tWorst: tW, tBest: tB,
    stable: (exW > 0 && tW >= 2) || (exB > 0 && tB >= 2),
  };
}

/** The arm's descriptive facts: rows, clusters, direction split. */
export function armFacts(set) {
  const clusters = new Set(set.map((r) => bucketOf(r.ts))).size;
  let long = 0, short = 0;
  for (const r of set) {
    const d = r.dir ?? r.tapeSide;
    if (d === "long") long++;
    else if (d === "short") short++;
  }
  const regimes = { up: 0, down: 0, flat: 0 };
  for (const r of set) {
    const g = regimeOf(r.tapeOffHighPct, r.tapeOffLowPct);
    regimes[g] = (regimes[g] ?? 0) + 1;
  }
  const ts = set.map((r) => r.ts);
  return {
    rows: set.length, clusters, long, short, regimes,
    spanH: ts.length ? (maxOf(ts) - minOf(ts)) / 3_600_000 : 0,
    from: ts.length ? minOf(ts) : null,
    to: ts.length ? maxOf(ts) : null,
  };
}

/**
 * THE BARS-LOOKUP GUARD.
 *
 * A silent zero is the worst possible failure mode for a replication: an
 * empty bar cache makes every observation "unresolved", every arm empty,
 * and every excess exactly 0.0000% with t=0.00 — which reads as a
 * clean null when it is actually a broken harness.
 *
 * This checks that the bar cache can actually serve the observations:
 * that the keys MATCH, that the bars COVER the observation window, and
 * that a decent share of observations resolve to an outcome. A run that
 * fails this guard must not report a result at all.
 */
export function auditBarLookup(obs, CACHE, { minCoverage = 0.5, minResolve = 0.2 } = {}) {
  const keys = new Set(Object.keys(CACHE));
  const sample = obs.length > 2000 ? obs.filter((_, i) => i % Math.ceil(obs.length / 2000) === 0) : obs;
  let keyHit = 0;
  let inWindow = 0;
  let hasForward = 0;
  for (const o of sample) {
    const bars = CACHE[o.pair];
    if (!bars?.length) continue;
    keyHit++;
    const lo = bars[0].t;
    const hi = bars[bars.length - 1].t;
    if (o.ts >= lo && o.ts <= hi) inWindow++;
    // A bar AFTER the observation is needed for the forward walk.
    if (hi > o.ts) hasForward++;
  }
  const n = sample.length;
  const keyCoverage = n ? keyHit / n : 0;
  const windowCoverage = n ? inWindow / n : 0;
  const forwardCoverage = n ? hasForward / n : 0;
  // The share of observations whose symbol has a bar at or before the
  // observation AND one after it — the precondition for a resolution.
  const resolvable = n ? (hasForward / n) * (inWindow / n) : 0;
  const problems = [];
  if (keyCoverage < minCoverage) problems.push(`only ${(keyCoverage * 100).toFixed(1)}% of observations have bars under their pair key (the cache's keys and the observations' pairs do not MATCH)`);
  if (windowCoverage < minCoverage) problems.push(`only ${(windowCoverage * 100).toFixed(1)}% of observations fall inside their symbol's bar window`);
  if (forwardCoverage < minCoverage) problems.push(`only ${(forwardCoverage * 100).toFixed(1)}% of observations have a FORWARD bar (the ticket walk needs one)`);
  return {
    sampled: n, keyCoverage, windowCoverage, forwardCoverage, resolvable,
    ok: problems.length === 0, problems,
  };
}

/**
 * THE DIRECTION-MATCHED EXCESS.
 *
 * ── WHY THIS EXISTS ──
 *
 * A pooled excess (signal arm minus unconditional arm) is only meaningful
 * when the two arms have the SAME DIRECTION MIX. They generally do not:
 * the signal arm is selected by a rule that fires on exhaustion reads,
 * and the unconditional arm is every tape read. On KuCoin's 4.5-hour
 * sample the replicable signal arm was 16 long / 4 short while the
 * unconditional arm was 18 long / 600 short. A pooled excess of two
 * such arms is not a comparison of like with like — it is mostly a
 * comparison of a LONG book with a SHORT book, which measures the
 * market's drift, not the signal.
 *
 * The fix: compare the signal arm against the unconditional arm WITHIN
 * each direction, and combine the per-direction excesses weighted by the
 * signal arm's own direction mix. Each side is then a stand-alone test
 * of the effect, and neither side can be contaminated by the other's
 * regime.
 *
 *   excess = SUM over directions of
 *              (signal rows in that direction / total signal rows)
 *              x (excess in that direction)
 *
 * where each direction's excess is measured against the unconditional
 * arm of the SAME direction. The standard error of a weighted sum of
 * independent per-direction excesses is sqrt(SUM w^2 se^2).
 */
export function measureDirectionMatched(signalSet, uncondSet, g, CACHE, opts = {}) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signalSet.filter((r) => (r.dir ?? r.tapeSide) === dir);
    const u = uncondSet.filter((r) => (r.dir ?? r.tapeSide) === dir);
    if (!s.length) {
      parts.push({ dir, rows: 0, n: 0, clusters: 0, excess: 0, t: 0, se: 0, weight: 0 });
      continue;
    }
    const m = measure(s, u, g, CACHE, opts);
    parts.push({
      dir, rows: s.length, n: m.n, clusters: m.sClusters,
      excess: m.excess, t: m.excessT, se: m.excessSe,
      weight: s.length / signalSet.length,
      ev: m.ev, uEv: m.uEv,
      winRate: m.winRate, uWinRate: m.uWinRate,
      timeExits: m.timeExits,
    });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seCombined = Math.sqrt(parts.reduce((s, p) => s + (p.weight ** 2) * (p.se ?? 0) ** 2, 0));
  const t = seCombined > 0 ? excess / seCombined : 0;
  const clusters = new Set(signalSet.map((r) => bucketOf(r.ts))).size;
  return { parts, excess, se: seCombined, t, clusters, rows: signalSet.length };
}

export { mean, se, clusterStats, bucketOf, regimeOf };
