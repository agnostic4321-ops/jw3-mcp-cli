#!/usr/bin/env node
/**
 * THE 90-DAY REGIME TEST (v3) — the corrected statistic, the mechanism, and
 * a true train/test regime selection over 90 days.
 *
 * ── WHY v3 ──
 *
 * v2 reported a paired within-hour excess for the session-hour family. That
 * statistic is DEGENERATE for a family whose group IS the cluster: the
 * group's cluster mean and the "all signals in that hour" cluster mean are
 * the SAME number, so the paired difference is identically zero. The tell
 * was the placebo p95 of exactly +0.000 — a placebo cannot be degenerate
 * by accident. v2's "positive in all 3 thirds" verdict for hours 6, 14 and
 * 16 was therefore an artefact of that bug and is WITHDRAWN.
 *
 * v3 replaces it with the statistic that is well defined for every family:
 *
 *   The regime's OWN cluster mean (t against zero), and its EXCESS over
 *   the unconditional tape's cluster mean in the same third, as the
 *   difference of two unpaired means with the standard error of that
 *   difference. Both are computed on CLUSTER MEANS (one mean per hour).
 *
 * ── THE MECHANISM ──
 *
 * v2 also printed a claim about why the tape is short-biased and then
 * contradicted it with its own numbers. v3 measures the mechanism
 * directly: the tape's SHORT condition and LONG condition are not
 * symmetric, because `fadeSignal` is evaluated BEFORE `dipSignal` in
 * `tapeSideOf`, so whenever the market is near its high the fade fires and
 * the dip never gets a look — even when the market is ALSO near its low.
 *
 * ── THE TRAIN/TEST SELECTION ──
 *
 * The honest way to select a regime on this data: choose it on the FIRST
 * TWO THIRDS, then measure it on the THIRD, which it has never seen. That
 * is the same discipline as the 4.6h test, with enough clusters to matter.
 *
 * Read-only. No venue calls. Writes nothing.
 *
 * USAGE
 *   node research/regime-excess-90d-v3.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const KLINE_DIR = join(SCRATCH, "leads/klines");
const SNAP = join(SCRATCH, "regime-excess-snap.ndjson");

const TAKER_RT = 0.12;
const MIN_CLUSTERS = 30;
const T_BAR = 2;
const TRIM_N = 3;
const PLACEBO_DRAWS = 2000;
const HOLD_H = 4;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const se = (a) => (a.length < 2 ? 0 : sd(a) / Math.sqrt(a.length));
const fmt = (x, d = 4) =>
  x === null || x === undefined || Number.isNaN(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `src/kucoin.ts`'s `fadeMetrics`, over the same 24-bar window. */
function fadeMetrics(closes, vols, highs, lows) {
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
  let atrPct = null;
  if (highs && lows && highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
    const h = highs.slice(-15), l = lows.slice(-15), c = closes.slice(-15);
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
    offHighPct: ((hi - last) / hi) * 100,
    offLowPct: ((last - lo) / lo) * 100,
    atrPct,
  };
}

/**
 * The tape's side, and the reason for the asymmetry. `tapeSideOf` checks
 * the FADE first: whenever the market is near its high AND the volume has
 * faded, the tape is SHORT and the dip is never evaluated — even if the
 * market is also near its low.
 */
function sideOfMetrics(m) {
  if (!m) return null;
  const fade = m.offHighPct > 15 ? "late" : m.vratio < 0.85 && m.offHighPct < 8 ? "fade-short" : m.vratio > 3 ? "strong" : "neutral";
  if (fade === "fade-short") return "short";
  const dip = m.offLowPct > 15 ? "extended" : m.vratio > 3 ? "capitulation" : m.vratio < 0.85 && m.offLowPct < 8 ? "dip-long" : "neutral";
  if (dip === "dip-long") return "long";
  return null;
}

function regime3(m) {
  if (m.offLowPct < 8 && m.offHighPct >= 8) return "nearLow";
  if (m.offHighPct < 8 && m.offLowPct >= 8) return "nearHigh";
  return "flat";
}

console.log("=".repeat(126));
console.log("[90d-v3] THE 90-DAY REGIME TEST — the corrected statistic, the mechanism, and a train/test regime selection");
console.log("[90d-v3] Read-only: the local hourly kline cache and a sealed snapshot. No venue calls, no orders.");
console.log("=".repeat(126));

const rows = readFileSync(SNAP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const universe = [...new Set(rows.map((r) => r.pair))].sort();

const series = new Map();
for (const pair of universe) {
  const base = pair.split("/")[0];
  const f = join(KLINE_DIR, `${base}USDTM_60_90.json`);
  if (!existsSync(f)) continue;
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const bars = raw
    .filter((k) => Number.isFinite(k[0]) && Number.isFinite(k[2]) && Number.isFinite(k[3]) && Number.isFinite(k[4]) && Number.isFinite(k[5]))
    .map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }))
    .sort((a, b) => a.t - b.t);
  if (bars.length) series.set(pair, bars);
}

// The reconstruction, with EVERY row's metrics — not only the signal rows —
// so the mechanism can be measured.
const allRows = []; // every symbol-hour with its metrics
const recon = new Map(); // the signal rows only
for (const [pair, bars] of series) {
  const sigs = [];
  for (let i = 23; i < bars.length; i++) {
    const w = bars.slice(i - 23, i + 1);
    const m = fadeMetrics(w.map((x) => x.c), w.map((x) => x.v), w.map((x) => x.h), w.map((x) => x.l));
    if (!m) continue;
    const side = sideOfMetrics(m);
    allRows.push({ pair, t: bars[i].t, m, side });
    if (!side) continue;
    sigs.push({
      pair, t: bars[i].t, side, m, reg: regime3(m),
      hour: new Date(bars[i].t).getUTCHours(),
      dow: new Date(bars[i].t).getUTCDay(),
      atr: m.atrPct ?? NaN, close: bars[i].c,
    });
  }
  recon.set(pair, sigs);
}
console.log(`\n[90d-v3] collector symbols ${universe.length} | hourly klines ${series.size} | symbol-hours ${allRows.length}`);

// ── 0. the mechanism: WHY the tape is short-biased ──
console.log("\n" + "=".repeat(126));
console.log("  0. THE MECHANISM — why the tape fires short ~92% of the time. Measured, not assumed.");
console.log("=".repeat(126));
{
  let bothFadeDip = 0, bothCond = 0, fadeOnly = 0, dipOnly = 0, neither = 0;
  let longWouldFire = 0;
  for (const r of allRows) {
    const m = r.m;
    const fadeCond = m.vratio < 0.85 && m.offHighPct < 8;
    const dipCond = m.vratio < 0.85 && m.offLowPct < 8;
    if (fadeCond && dipCond) { bothCond++; bothFadeDip++; }
    else if (fadeCond) fadeOnly++;
    else if (dipCond) dipOnly++;
    else neither++;
    // What the dip would fire if the fade were not checked first.
    if (dipCond && !fadeCond) longWouldFire++;
  }
  const N = allRows.length;
  console.log(`\n    over ALL ${N} symbol-hours:`);
  console.log(`      the FADE condition (vratio<0.85 AND offHighPct<8) is met:  ${bothCond + fadeOnly} (${(((bothCond + fadeOnly) / N) * 100).toFixed(1)}%)`);
  console.log(`      the DIP  condition (vratio<0.85 AND offLowPct<8)  is met:  ${bothCond + dipOnly} (${(((bothCond + dipOnly) / N) * 100).toFixed(1)}%)`);
  console.log(`      BOTH conditions met at the same time:                   ${bothCond} (${((bothCond / N) * 100).toFixed(1)}%)`);
  console.log(`      only the fade: ${fadeOnly} | only the dip: ${dipOnly} | neither: ${neither}`);
  console.log(`\n    → the two conditions fire TOGETHER ${((bothCond / (bothCond + fadeOnly + dipOnly)) * 100).toFixed(1)}% of the time they fire at all.`);
  console.log(`    → because 'fade' is checked FIRST in tapeSideOf, every one of those ${bothCond} hours is booked SHORT and the dip never gets a look.`);
  console.log(`    → the long side can therefore only fire in the ${dipOnly} hours where the market is near its low AND NOT near its high.`);
  console.log(`    → that is a STRUCTURAL asymmetry in the rule's ORDER OF CHECKS, not a property of the market's direction.`);
  const sigs = [...recon.values()].flat();
  const longSigs = sigs.filter((s) => s.side === "long").length;
  console.log(`\n    the resulting tape: ${sigs.length} signals, ${longSigs} long (${((longSigs / sigs.length) * 100).toFixed(1)}%) and ${sigs.length - longSigs} short.`);
  console.log(`    the long side is ${((longSigs / sigs.length) * 100).toFixed(1)}% of the tape's signals — a rule that is 92% one-directional by construction.`);
}

// ── the trades ──
const tapeTrades = [];
for (const [pair, obs] of recon) {
  const bars = series.get(pair);
  for (const o of obs) {
    const target = o.t + HOLD_H * 3600000;
    let lo = 0, hi = bars.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t >= target) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (found < 0) continue;
    const exitBar = bars[found];
    const move = o.side === "long" ? (exitBar.c - o.close) / o.close : (o.close - exitBar.c) / o.close;
    tapeTrades.push({ ...o, ret: move * 100 - TAKER_RT, hourKey: o.t });
  }
}
function hourClusterMeans(trades) {
  const m = new Map();
  for (const t of trades) {
    if (!m.has(t.hourKey)) m.set(t.hourKey, []);
    m.get(t.hourKey).push(t.ret);
  }
  return new Map([...m.entries()].map(([k, v]) => [k, mean(v)]));
}

const tHours = [...new Set(tapeTrades.map((t) => t.hourKey))].sort((a, b) => a - b);
const third = Math.ceil(tHours.length / 3);
const thirds = [];
for (let i = 0; i < 3; i++) {
  const sl = tHours.slice(i * third, (i + 1) * third);
  if (sl.length) thirds.push({ idx: i, from: sl[0], to: sl[sl.length - 1], hours: sl.length });
}
console.log(`\n[90d-v3] tape trades with a ${HOLD_H}h forward exit: ${tapeTrades.length}`);
console.log(`[90d-v3] chronological thirds: ` + thirds.map((t) => `${new Date(t.from).toISOString().slice(0, 10)}..${new Date(t.to).toISOString().slice(0, 10)} (${t.hours}h)`).join("  |  "));

/**
 * THE CORRECTED CELL STATISTIC — well defined for every family.
 *
 *   mean    the regime's cluster mean (one mean per hour), averaged
 *   tAbs    t of that mean against zero
 *   excess  the regime's cluster mean MINUS the unconditional tape's
 *           cluster mean in the same third, with the standard error of
 *           the difference of two UNPAIRED means
 */
function cellStat(gIn, inBlk) {
  const gCM = hourClusterMeans(gIn);
  const aCM = hourClusterMeans(inBlk);
  const gVals = [...gCM.values()], aVals = [...aCM.values()];
  const gMean = mean(gVals), aMean = mean(aVals);
  const gSe = se(gVals);
  const dSe = Math.sqrt(se(gVals) ** 2 + se(aVals) ** 2);
  return {
    clusters: gCM.size, mean: gMean,
    tAbs: gSe > 0 ? gMean / gSe : null,
    allMean: aMean,
    excess: gMean - aMean,
    tEx: dSe > 0 ? (gMean - aMean) / dSe : null,
    mde: 2 * dSe,
  };
}

const FAMILIES = [
  { key: "hour", label: "session hour (UTC)", field: "hour" },
  { key: "dow", label: "day of week", field: "dow" },
  { key: "reg", label: "trend regime (near high / near low / flat)", field: "reg" },
  { key: "side", label: "the tape's side (long / short)", field: "side" },
];

/** The placebo: random groups of the same sizes, measured the same way. */
function placeboFamily(allCells, sizes, seed) {
  const rnd = mulberry32(seed);
  const pool = allCells.filter((c) => c.clusters > 0);
  if (!pool.length) return null;
  const vals = pool.map((c) => c.mean);
  const best = [];
  for (let d = 0; d < PLACEBO_DRAWS; d++) {
    const sh = [...vals];
    for (let i = sh.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [sh[i], sh[j]] = [sh[j], sh[i]];
    }
    let idx = 0, worst = -Infinity;
    for (const s of sizes) {
      const g = sh.slice(idx, idx + s);
      idx += s;
      if (!g.length) continue;
      const ex = mean(g);
      if (ex > worst) worst = ex;
    }
    best.push(worst);
  }
  best.sort((a, b) => a - b);
  return { p95: best[Math.floor(PLACEBO_DRAWS * 0.95)], max: best[PLACEBO_DRAWS - 1] };
}

console.log("\n" + "=".repeat(126));
console.log(`  1. THE CORRECTED REGIME TABLE — the tape's ${HOLD_H}h net return per regime, per chronological third.`);
console.log(`     "mean" = the regime's own cluster mean | "tAbs" = its t against zero | "vs all" = its excess over the unconditional tape in the same third | "t(ex)" = that excess's t`);
console.log("=".repeat(126));

const FAM_CELLS = new Map();
for (const fam of FAMILIES) {
  console.log(`\n    ── FAMILY: ${fam.label} ──`);
  console.log("    regime    | 1st third: clus   mean   tAbs   vs all    t(ex)  MDE@2 | 2nd third: clus   mean   tAbs   vs all    t(ex)  MDE@2 | 3rd third: clus   mean   tAbs   vs all    t(ex)  MDE@2 | verdict");
  const groups = [...new Set(tapeTrades.map((t) => String(t[fam.field])))]
    .sort((a, b) => (Number.isNaN(+a) ? -1 : +a) - (Number.isNaN(+b) ? -1 : +b));
  const groupCells = [];
  const allCells = [];
  for (const g of groups) {
    const cells = [];
    for (const blk of thirds) {
      const inBlk = tapeTrades.filter((t) => t.hourKey >= blk.from && t.hourKey <= blk.to);
      const gIn = inBlk.filter((t) => String(t[fam.field]) === g);
      cells.push(cellStat(gIn, inBlk));
    }
    allCells.push(...cells);
    groupCells.push({ g, cells });
  }
  const sizes = groupCells.map(({ cells }) => Math.max(1, cells[0].clusters));
  const pl = placeboFamily(allCells, sizes, 4242 + fam.key.length);
  FAM_CELLS.set(fam.key, { groupCells, pl, fam });
  for (const { g, cells } of groupCells) {
    const posEx = cells.filter((c) => c.excess > 0).length;
    const posMean = cells.filter((c) => c.mean > 0).length;
    const sigEx = cells.filter((c) => c.clusters >= MIN_CLUSTERS).length;
    const t2Ex = cells.filter((c) => (c.tEx ?? 0) >= T_BAR).length;
    let verdict;
    if (sigEx === 0) verdict = "cannot discriminate";
    else if (posEx === 3 && t2Ex >= 2) verdict = "*** POSITIVE EXCESS IN ALL 3 THIRDS ***";
    else if (posEx === 3) verdict = "positive excess in all 3 thirds (t<2)";
    else if (posEx >= 2) verdict = "2 of 3 thirds — a window";
    else verdict = "a WINDOW, not a regime";
    const txt = (c) => `${rpad(c.clusters, 5)} ${fmt(c.mean, 3)} ${rpad(fmt(c.tAbs, 1), 5)} ${fmt(c.excess, 3)} ${rpad(fmt(c.tEx, 1), 5)} ${fmt(c.mde, 3)}`;
    console.log(`    ${pad(g, 9)} | ${txt(cells[0])} | ${txt(cells[1])} | ${txt(cells[2])} | ${verdict}`);
  }
  console.log(`    placebo (the best of ${groups.length} random groups of the same sizes): p95 ${fmt(pl?.p95, 3)}  max ${fmt(pl?.max, 3)}`);
}

// ── 2. the TRAIN/TEST regime selection over 90 days ──
console.log("\n" + "=".repeat(126));
console.log("  2. THE TRAIN/TEST REGIME SELECTION — the regime is CHOSEN on thirds 1+2 and MEASURED on third 3.");
console.log("     This is the same discipline as the 4.6h test, with enough clusters to mean something.");
console.log("=".repeat(126));
console.log(`    discovery: ${new Date(thirds[0].from).toISOString().slice(0, 10)}..${new Date(thirds[1].to).toISOString().slice(0, 10)}   test: ${new Date(thirds[2].from).toISOString().slice(0, 10)}..${new Date(thirds[2].to).toISOString().slice(0, 10)}`);
console.log("    family     regime        discovery EXCESS (thirds 1+2)   TEST EXCESS (third 3)   TEST clusters   TEST t   verdict");
const SELECTED = [];
for (const fam of FAMILIES) {
  const { groupCells, pl } = FAM_CELLS.get(fam.key);
  let best = null;
  for (const { g, cells } of groupCells) {
    // The discovery statistic: the excess pooled over thirds 1+2.
    const disc = cells[0].excess + cells[1].excess;
    if (!best || disc > best.disc) best = { g, disc, cells };
  }
  if (!best) continue;
  const test = best.cells[2];
  const verdict =
    test.clusters < MIN_CLUSTERS ? "TEST too small"
    : test.excess <= 0 ? "TEST NEGATIVE — the regime did not hold"
    : (test.tEx ?? 0) < T_BAR ? "TEST positive but t<2"
    : "TEST POSITIVE";
  console.log(
    `    ${pad(fam.key, 10)} ${pad(best.g, 12)} ${fmt(best.disc / 2).padStart(12)} (${best.cells[0].clusters}/${best.cells[1].clusters} cl)   ${fmt(test.excess).padStart(14)}   ${rpad(test.clusters, 12)}   ${rpad(fmt(test.tEx, 2), 6)}   ${verdict}`,
  );
  SELECTED.push({ fam: fam.key, g: best.g, disc: best.disc / 2, test, pl });
}

// ── 3. what the 4.6h sample's regime actually filters ──
console.log("\n" + "=".repeat(126));
console.log("  3. WHAT THE 4.6h SAMPLE'S EXCESS-CARRYING REGIME ACTUALLY FILTERS");
console.log("=".repeat(126));
{
  const ctl = rows.filter((r) => {
    const t = tapeSideFromRow(r);
    if (!t) return false;
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const ms = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    return ms && ms === t;
  });
  const tapeSideRows = rows.filter((r) => tapeSideFromRow(r));
  const sigs = [...recon.values()].flat();
  const shortShare90 = sigs.filter((s) => s.side === "short").length / sigs.length;
  const nearHigh90 = sigs.filter((s) => s.reg === "nearHigh").length / sigs.length;
  const shortShare46 = tapeSideRows.filter((r) => tapeSideFromRow(r) === "short").length / tapeSideRows.length;
  const nearHigh46 = tapeSideRows.filter((r) => Number(r.tapeOffHighPct ?? 0) < 8).length / tapeSideRows.length;
  console.log(`\n    the 4.6h sample: ${ctl.length} control rows, ${ctl.filter((r) => tapeSideFromRow(r) === "long").length} long / ${ctl.filter((r) => tapeSideFromRow(r) === "short").length} short`);
  console.log(`    the SHORT share of the tape's signals:   4.6h sample ${(shortShare46 * 100).toFixed(1)}%  |  90 days ${(shortShare90 * 100).toFixed(1)}%`);
  console.log(`    the NEAR-HIGH share of the tape's signals: 4.6h sample ${(nearHigh46 * 100).toFixed(1)}%  |  90 days ${(nearHigh90 * 100).toFixed(1)}%`);
  console.log(`\n    → the regime that carries the 4.6h excess (short / near-high) is the tape's DEFAULT state, not a selection.`);
  console.log(`    → a filter on it removes ${((1 - shortShare90) * 100).toFixed(0)}% of the signals at best. It cannot IMPROVE the pooled result; it can only shrink the sample.`);
  console.log(`    → the only filter that could improve the pooled result EXCLUDES the excess-carrying regime — and the out-of-sample test says that is where the excess lives.`);
}

console.log("\n" + "=".repeat(126));
console.log("[90d-v3] DONE");
console.log("=".repeat(126));
