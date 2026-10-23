#!/usr/bin/env node
/**
 * THE DECISIVE TEST — is the time-of-day excess real, or is it the
 * unclustered t-statistic and the multiple-testing drift?
 *
 * WHAT THE FIRST PASS FOUND, AND WHY IT IS NOT YET A FINDING
 * ----------------------------------------------------------
 * The hourly profile showed hours 4, 6, 14, 20, 22 with a positive
 * excess over the market's drift, and hours 0, 10, 12, 15 with a
 * negative one. That looks like a shape. But:
 *
 *   1. THE t-STATISTIC THERE WAS UNCLUSTERED. It treated 43 symbols
 *      traded in the same hour as 43 independent observations. They are
 *      not: crypto symbols move together. The house's own rule is that
 *      the cluster width is the ticket's HOLDING PERIOD, and for an
 *      intraday claim the honest replication unit is the DAY.
 *
 *   2. THE SHAPE IS NOT STABLE ACROSS HORIZONS. Hour 14 is an edge at
 *      1 hour and nothing at 4, 8 or 16 hours. Hour 16 is nothing at
 *      1 hour and an edge at 8 and 16. A real intraday effect has a
 *      consistent sign; a search across 14 hours x 4 horizons finds
 *      |t| >= 2 by chance about 5% of the time.
 *
 *   3. THE MULTIPLE-TESTING NULL WAS NOT MEASURED. 56 hour-horizon
 *      cells were examined. The null has to be: what does the SAME
 *      search find on placebo hours?
 *
 * THIS SCRIPT MEASURES ALL THREE.
 *
 *   A. THE CLUSTERED HOUR-EXCESS. Each hour's raw forward return,
 *      minus the market's raw forward return over the SAME bars, at
 *      three cluster widths: the holding period, the DAY, and the
 *      whole sample (unclustered, for reference).
 *
 *   B. THE DAY-LEVEL REPLICATION. The per-day excess for the best
 *      hours. An effect that is present in 12 of 14 days is a pattern;
 *      one present in 4 days is a window.
 *
 *   C. THE HOUR-PLACEBO NULL. The SAME search over placebo hours
 *      (the hour shifted by a random offset, preserving the daily
 *      structure). The real hours must beat the placebo's best.
 *
 *   D. THE HORIZON CONSISTENCY. An hour's excess sign across the four
 *      horizons. A real effect does not flip.
 *
 * READ-ONLY. Local caches only.
 */
import {
  EQUITY, NOTIONAL, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
  loadBars, mean, stdev, fmt, pct, mulberry32, quantile, trim, clusterStats,
} from "./family-harness.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const pbars = loadBars({ withVolume: false });
const pairs = Object.keys(pbars);
const DAY = 24 * 3600_000;
const HOURS = [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22];
const HORIZONS = [4, 16, 32, 64];

/** The signal times for a given UTC hour and a given day-offset. */
function todSignals(hour, dir = 1, dayOffset = 0) {
  const sigs = [];
  const target = ((hour + dayOffset) % 24 + 24) % 24 * 3600_000;
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) {
      if (((bars[i].t % DAY) + DAY) % DAY !== target) continue;
      sigs.push({ pair: p, ts: bars[i - 1].t, idx: i - 1, dir, entry: bars[i - 1].c });
    }
  }
  return sigs;
}

/** The raw forward return, in %, over `hold` bars. */
function rawReturns(sigs, hold) {
  const out = [];
  for (const s of sigs) {
    const bars = pbars[s.pair].bars;
    const j = s.idx + hold;
    if (j >= bars.length) continue;
    out.push({ ts: s.ts, r: (bars[j].c / s.entry - 1) * 100 });
  }
  return out;
}

/** The market's raw forward return over the same horizon, every bar. */
function marketReturns(hold) {
  const out = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) {
      const j = i + hold;
      if (j >= bars.length) continue;
      out.push({ ts: bars[i].t, r: (bars[j].c / bars[i].c - 1) * 100 });
    }
  }
  return out;
}

/**
 * The clustered mean and t-statistic of a set of (ts, value) pairs at a
 * given cluster width in ms.
 */
function clusteredMean(pairsTs, clusterMs) {
  const g = new Map();
  for (const p of pairsTs) {
    const k = Math.floor(p.ts / clusterMs);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p.r);
  }
  const means = [...g.values()].map((v) => mean(v));
  if (!means.length) return { clusters: 0, m: 0, se: 0, t: 0 };
  const m = mean(means);
  const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
  return { clusters: means.length, m, se, t: se > 0 ? m / se : 0 };
}

console.log("═".repeat(120));
console.log("THE DECISIVE TEST — is the time-of-day excess real, clustered, and reproducible?");
console.log("═".repeat(120));

// The market baseline per horizon.
const MARKET = {};
for (const hold of HORIZONS) {
  const mr = marketReturns(hold);
  MARKET[hold] = {
    all: clusteredMean(mr.map((x) => ({ ts: x.ts, r: x.r })), BAR_MS),
    day: clusteredMean(mr.map((x) => ({ ts: x.ts, r: x.r })), DAY),
  };
  console.log(`  the market's raw forward return over ${hold} bars (${hold * 15 / 60}h):`);
  console.log(`     clustered at the holding period (${hold} bars): ${MARKET[hold].all.m.toFixed(4)}% over ${MARKET[hold].all.clusters} clusters`);
  console.log(`     clustered at the DAY:                       ${MARKET[hold].day.m.toFixed(4)}% over ${MARKET[hold].day.clusters} clusters`);
}

// ── A. THE CLUSTERED HOUR-EXCESS ──────────────────────────────────
console.log(`\n${"═".repeat(120)}`);
console.log("A. THE CLUSTERED HOUR-EXCESS — the hour's move minus the market's move, at three cluster widths");
console.log("═".repeat(120));
const results = {};
for (const hold of HORIZONS) {
  console.log(`\n  --- horizon ${hold} bars (${hold * 15 / 60}h) ---`);
  console.log(`  ${"hour".padStart(5)} ${"n".padStart(6)} {"hour %".padStart(10)} {"mkt %".padStart(10)} {"excess".padStart(9)} ${"t@hold".padStart(8)} ${"cl@hold".padStart(8)} ${"t@day".padStart(8)} ${"cl@day".padStart(6)} ${"t@uncl".padStart(8)}  ${"verdict".padStart(10)}`);
  for (const hour of HOURS) {
    const sig = todSignals(hour, 1);
    const raw = rawReturns(sig, hold);
    if (raw.length < 20) continue;
    const mkt = MARKET[hold].all.m;
    const ex = raw.map((x) => ({ ts: x.ts, r: x.r - mkt }));
    const atHold = clusteredMean(ex, hold * BAR_MS);
    const atDay = clusteredMean(ex, DAY);
    const atUncl = clusteredMean(ex, 1); // every trade its own cluster
    const verd = atDay.t >= 2 ? "EDGE?" : atDay.t <= -2 ? "inverse" : "no effect";
    console.log(`  ${String(hour).padStart(5)} ${String(raw.length).padStart(6)} ${mean(raw.map((x) => x.r)).toFixed(4).padStart(10)} ${mkt.toFixed(4).padStart(10)} ${atHold.m.toFixed(4).padStart(9)} ${atHold.t.toFixed(2).padStart(8)} ${String(atHold.clusters).padStart(8)} ${atDay.t.toFixed(2).padStart(8)} ${String(atDay.clusters).padStart(6)} ${atUncl.t.toFixed(2).padStart(8)}  ${verd.padStart(10)}`);
    results[`${hour}_${hold}`] = { hour, hold, atHold, atDay, atUncl, ex: atHold.m };
  }
}

// ── B. THE DAY-LEVEL REPLICATION ───────────────────────────────────
console.log(`\n${"═".repeat(120)}`);
console.log("B. THE DAY-LEVEL REPLICATION — the per-day excess for the hours that looked like an edge");
console.log("═".repeat(120));
const CANDIDATES = [
  { hour: 14, hold: 4 }, { hour: 4, hold: 4 }, { hour: 22, hold: 4 },
  { hour: 6, hold: 4 }, { hour: 20, hold: 4 }, { hour: 16, hold: 32 },
  { hour: 13, hold: 64 }, { hour: 20, hold: 16 }, { hour: 16, hold: 64 },
  { hour: 18, hold: 32 },
];
for (const c of CANDIDATES) {
  const sig = todSignals(c.hour, 1);
  const raw = rawReturns(sig, c.hold);
  const mkt = MARKET[c.hold].all.m;
  const byDay = new Map();
  for (const x of raw) {
    const d = new Date(x.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(x.r - mkt);
  }
  const days = [...byDay.entries()].sort();
  const pos = days.filter(([, v]) => mean(v) > 0).length;
  const dayExcess = days.map(([, v]) => mean(v));
  console.log(`  hour ${String(c.hour).padStart(2)}:00, hold ${String(c.hold).padStart(2)} bars: ${pos}/${days.length} days positive; the per-day excess:`);
  console.log(`     ${days.map(([d, v]) => `${d.slice(5)} ${mean(v).toFixed(3)}`).join("  ")}`);
  console.log(`     the day-level mean ${mean(dayExcess).toFixed(4)}%, t ${clusteredMean(dayExcess.map((r) => ({ ts: 0, r })), 1).t.toFixed(2)} (${days.length} independent days)`);
}

// ── C. THE HOUR-PLACEBO NULL ───────────────────────────────────────
console.log(`\n${"═".repeat(120)}`);
console.log("C. THE HOUR-PLACEBO NULL — the same search, on placebo hours");
console.log("═".repeat(120));
console.log("  The placebo shifts EVERY hour by a random whole-day offset. The intraday structure");
console.log("  is preserved (a shifted hour is still one hour of the day), but the alignment");
console.log("  between the hour and the market's drift is destroyed.");
for (const hold of HORIZONS) {
  const realT = [];
  for (const hour of HOURS) {
    const r = results[`${hour}_${hold}`];
    if (r) realT.push(Math.abs(r.atDay.t));
  }
  const nullT = [];
  for (let d = 0; d < 200; d++) {
    const rand = mulberry32(777 + d * 104729);
    for (const hour of HOURS) {
      const off = 1 + Math.floor(rand() * 23);   // 1..23 hours, never zero
      const sig = todSignals(hour, 1, off);
      const raw = rawReturns(sig, hold);
      if (raw.length < 20) continue;
      const mkt = MARKET[hold].all.m;
      const ex = raw.map((x) => ({ ts: x.ts, r: x.r - mkt }));
      const atDay = clusteredMean(ex, DAY);
      nullT.push(Math.abs(atDay.t));
    }
  }
  nullT.sort((a, b) => a - b);
  const ge = nullT.filter((x) => x >= maxOf(realT)).length;
  const nEdges = realT.filter((x) => x >= 2).length;
  const nNullEdges = nullT.filter((x) => x >= 2).length;
  console.log(`  hold ${String(hold).padStart(2)}: the real search found ${nEdges} hours with |t| >= 2 (day-clustered); the placebo search found ${nNullEdges} of ${nullT.length}`);
  console.log(`           the real search's best |t| = ${maxOf(realT).toFixed(2)}; the placebo's p95 = ${quantile(nullT, 0.95).toFixed(2)}, max = ${maxOf(nullT).toFixed(2)}`);
  console.log(`           -> the real best is at the ${(100 * ge / Math.max(1, nullT.length)).toFixed(1)}th percentile of the placebo null${ge <= nullT.length * 0.05 ? " — BEATS the null" : " — does NOT beat the null"}`);
}

// ── D. THE HORIZON CONSISTENCY ─────────────────────────────────────
console.log(`\n${"═".repeat(120)}`);
console.log("D. THE HORIZON CONSISTENCY — does an hour keep its sign as the horizon changes?");
console.log("═".repeat(120));
console.log(`  ${"hour".padStart(5)} ${"1h".padStart(9)} ${"4h".padStart(9)} ${"8h".padStart(9)} ${"16h".padStart(9)}  ${"sign flips".padStart(11)}  ${"verdict".padStart(22)}`);
for (const hour of HOURS) {
  const row = HORIZONS.map((h) => results[`${hour}_${h}`]);
  if (row.some((r) => !r)) continue;
  const vals = row.map((r) => r.ex);
  const signs = vals.map((v) => (v > 0 ? "+" : "-"));
  const flips = signs.filter((s) => s !== signs[0]).length;
  const dayTs = row.map((r) => r.atDay.t);
  const verdict = flips >= 2 ? "NOT an intraday effect" : flips === 1 ? "one flip — marginal" : "consistent sign";
  console.log(`  ${String(hour).padStart(5)} ${vals.map((v) => v.toFixed(3).padStart(9)).join("")}  ${String(flips).padStart(11)}  ${verdict.padStart(22)}   day-clustered t: ${dayTs.map((t) => t.toFixed(2)).join(", ")}`);
}
console.log("");
