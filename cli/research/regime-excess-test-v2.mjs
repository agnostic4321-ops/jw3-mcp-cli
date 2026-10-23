#!/usr/bin/env node
/**
 * THE REGIME TEST (v2) — does the geometry candidate's excess live in a
 * REGIME that can be identified IN ADVANCE, and does that regime survive a
 * CHRONOLOGICAL split?
 *
 * ── WHY v2 ──
 *
 * v1 read a 11-pair bar cache. A partial cache silently shrinks BOTH arms
 * and changes the excess. The 43-pair cache (regime-excess-fullbars.json)
 * is the one that reproduces the geometry study, so v2 uses it and adds:
 *
 *   - the study's own 16-bar (4h) hold as the PRIMARY basis, because that
 *     is the basis the study's headline number was measured on;
 *   - the ROW-level excess beside the CLUSTER-level excess, so the two
 *     statistics can be compared directly (the study reports the row
 *     excess as "EXCESS" and the cluster excess as "t");
 *   - the MDE at t=2 — the minimum detectable excess — so the power of the
 *     sample is stated as a number instead of a hedge;
 *   - a TRUE out-of-sample regime test: the regime is CHOSEN on blocks 1+2
 *     and MEASURED on block 3. That is the only way a regime discovered in
 *     this sample can be used in this sample without the selection
 *     artefact.
 *
 * ── THE DISCIPLINE ──
 *
 *   1. CHRONOLOGICAL SPLIT. A regime that only appears in one block is a
 *      WINDOW, not a regime.
 *   2. A PLACEBO family of the SAME SHAPE — the control arm's clusters
 *      randomly re-assigned to groups of the same sizes — as the bar the
 *      real regime has to beat.
 *   3. The TRIM test (worst 3 and best 3 dropped).
 *
 * ── THE ARMS (the study's own definitions) ──
 *
 *   CONTROL       tapeSide === modelSide, where
 *                 modelSide = (jev && laya) ? (jev === laya ? jev : null)
 *                                            : (jev || laya)
 *   UNCONDITIONAL every row with a tape side (the tape's own direction)
 *
 * The EXCESS is the control arm's mean per-trade P&L minus the
 * unconditional arm's. Both arms are computed on CLUSTER MEANS (one mean
 * per 5-minute bucket): the collector reads ~43 symbols every five
 * minutes and they move together, so the rows in one bucket are not
 * independent observations.
 *
 *   UNPAIRED  mean(control cluster means) - mean(uncond cluster means).
 *   PAIRED    the same difference WITHIN each 5-minute bucket, then the t
 *             on those differences. The bucket is one market state, so
 *             this removes the drift both arms share.
 *
 * ── THE FEE ──
 *
 * Both arms charge the SAME taker fee on every trade, so the fee CANCELS
 * in the excess: the excess is a difference of GROSS returns. The fee
 * bounds the FILTERED STRATEGY's per-trade EV, not the excess.
 *
 * ── WHAT THIS FILE DOES NOT DO ──
 *
 * It never touches the venue, never places an order, and never writes to
 * the shared collector files. It reads a SEALED SNAPSHOT of the rows and a
 * snapshot of the bar caches.
 *
 * USAGE
 *   node research/regime-excess-test-v2.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
// The SEALED snapshot of the collector's rows. The shared file keeps
// growing under the running collector, so the analysis runs against a copy.
const SNAP = join(SCRATCH, "regime-excess-snap.ndjson");
// The FULL bar cache: all 43 collector symbols at 15-minute granularity.
const BARS_FILE = join(SCRATCH, "regime-excess-fullbars.json");
const CONF_BARS = join(SCRATCH, "regime-excess-confluence-bars.json");

const TAKER_RT = 0.12; // % of notional, taker round trip
const EQUITY = 57.2287;
const NOTIONAL = 60.0;
const NOE = NOTIONAL / EQUITY;
const BUCKET_MS = 5 * 60_000;
const PLACEBO_DRAWS = 2000;
const MIN_CLUSTERS = 30;
const T_BAR = 2;
const TRIM_N = 3;
const HOLD_BARS = 16; // 4 hours at 15-minute bars — the study's hold

/** Deterministic PRNG so a placebo run is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the statistics ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const se = (a) => (a.length < 2 ? 0 : sd(a) / Math.sqrt(a.length));

/** One mean per bucket. */
function clusterMeans(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i];
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(values[i]);
  }
  return new Map([...byBucket.entries()].map(([b, a]) => [b, mean(a)]));
}

const fmt = (x, d = 4) =>
  x === null || x === undefined || Number.isNaN(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

// ── the geometries (the study's own list) ──
const GEOMETRIES = [
  { name: "SHIPPED (ATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5 / SL 1.2", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8 / SL 1.2", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0 / SL 1.2", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2 / SL 1.2", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2 / SL 0.8", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5 / SL 1.0", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0 / SL 1.2", tp: 2.0, sl: 1.2 },
];

/**
 * The trade outcome for one observation at one geometry. Identical tie
 * handling to the geometry study: a bar that touches BOTH the target and
 * the stop is resolved CONSERVATIVELY as a loss; a trade that touches
 * NEITHER is closed at the horizon's close (the time exit) at the mark.
 */
function outcome(bars, ts, entry, tpPct, slPct, long, maxHoldBars) {
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
    if (hitTp && hitSl) return { kind: "loss", ambiguous: true };
    if (hitTp) return { kind: "win" };
    if (hitSl) return { kind: "loss" };
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

/** The model's side, exactly as the geometry study computes it. */
function modelSideOf(r) {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return jev && laya ? (jev === laya ? jev : null) : (jev || laya);
}

/** The study's own trend regime. */
function regime3Of(r) {
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  if (ol < 8 && oh >= 8) return "nearLow";
  if (oh < 8 && ol >= 8) return "nearHigh";
  return "flat";
}

function loadRows() {
  if (!existsSync(SNAP)) {
    console.error(`[regime] no snapshot at ${SNAP}`);
    process.exit(1);
  }
  const rows = readFileSync(SNAP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    r._tape = tapeSideFromRow(r);
    r._model = modelSideOf(r);
    r._signal = !!r._tape && r._model === r._tape;
    r._bucket = Math.floor(r.ts / BUCKET_MS);
    r._regime3 = regime3Of(r);
    r._nearHigh = Number(r.tapeOffHighPct ?? 0) < 8;
    r._hour = new Date(r.ts).getUTCHours();
    r._dow = new Date(r.ts).getUTCDay();
    r._atr = Number(r.tapeAtrPct ?? NaN);
    r._chg = Number(r.tapeChg ?? 0);
  }
  // The volatility regime: ATR tertiles over the sample. The cuts come FROM
  // THE SAMPLE, so this family is in-sample by construction.
  const atrs = rows.map((r) => r._atr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p) => atrs[Math.min(atrs.length - 1, Math.floor(p * atrs.length))];
  const T1 = q(1 / 3), T2 = q(2 / 3);
  for (const r of rows) {
    r._vol = !Number.isFinite(r._atr) ? "unknown" : r._atr <= T1 ? "low" : r._atr <= T2 ? "mid" : "high";
  }
  return { rows, volCuts: [T1, T2] };
}

/** Simulate the ticket; one trade per resolvable row, in % of equity, net of the fee. */
function simulateTicket(rows, geo, bars, holdBars) {
  const trades = [];
  let unresolved = 0, ambiguous = 0, missingAtr = 0;
  for (const r of rows) {
    if (!r._tape) continue;
    const a = bars[r.pair];
    if (!a?.length) { unresolved++; continue; }
    let idx = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i].t <= r.ts) idx = i;
      else break;
    }
    if (idx < 0) { unresolved++; continue; }
    const entry = a[idx].c;
    const atrPct = Number(r.tapeAtrPct ?? NaN);
    const tpPct = geo.tp != null ? geo.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
    const slPct = geo.sl != null ? geo.sl : Math.max(0.3, atrPct * 1.34);
    if (geo.shipped && (!Number.isFinite(atrPct) || atrPct <= 0)) { missingAtr++; unresolved++; continue; }
    if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
    const long = r._tape === "long";
    const o = outcome(a, r.ts, entry, tpPct, slPct, long, holdBars);
    if (o === null) { unresolved++; continue; }
    if (o.kind === "loss" && o.ambiguous) ambiguous++;
    let pnl;
    if (o.kind === "win") pnl = (tpPct - TAKER_RT) * NOE;
    else if (o.kind === "loss") pnl = (-slPct - TAKER_RT) * NOE;
    else pnl = (o.movePct - TAKER_RT) * NOE;
    trades.push({ ...r, pnl, kind: o.kind, tp: tpPct, sl: slPct });
  }
  return { trades, unresolved, ambiguous, missingAtr };
}

/** The forward-return basis. */
function simulateForward(rows, series, holdMs) {
  const trades = [];
  let unresolved = 0;
  for (const r of rows) {
    if (!r._tape) continue;
    const a = series.get(r.pair);
    if (!a?.length) { unresolved++; continue; }
    let idx = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i][0] <= r.ts) idx = i;
      else break;
    }
    if (idx < 0) { unresolved++; continue; }
    const need = r.ts + holdMs;
    let out = -1;
    for (let i = idx; i < a.length; i++) {
      if (a[i][0] >= need) { out = i; break; }
    }
    if (out < 0) { unresolved++; continue; }
    const p0 = a[idx][1], p1 = a[out][1];
    if (!(p0 > 0) || !(p1 > 0)) { unresolved++; continue; }
    const move = r._tape === "long" ? (p1 - p0) / p0 : (p0 - p1) / p0;
    trades.push({ ...r, pnl: (move * 100 - TAKER_RT) * NOE, kind: "fwd" });
  }
  return { trades, unresolved };
}

/** THE SLICE STATISTIC. */
function sliceStats(trades, bucketSet) {
  const inSlice = trades.filter((t) => bucketSet.has(t._bucket));
  const sig = inSlice.filter((t) => t._signal);
  const sCM = clusterMeans(sig.map((t) => t.pnl), sig.map((t) => t._bucket));
  const uCM = clusterMeans(inSlice.map((t) => t.pnl), inSlice.map((t) => t._bucket));
  const sVals = [...sCM.values()];
  const uVals = [...uCM.values()];
  const sMean = mean(sVals), uMean = mean(uVals);
  const excess = sMean - uMean;
  const seDiff = Math.sqrt(se(sVals) ** 2 + se(uVals) ** 2);
  const t = seDiff > 0 ? excess / seDiff : null;
  const diffs = [];
  for (const [b, sm] of sCM) if (uCM.has(b)) diffs.push(sm - uCM.get(b));
  const pMean = mean(diffs);
  const pSe = se(diffs);
  const sRows = sig.map((t) => t.pnl);
  const uRows = inSlice.map((t) => t.pnl);
  return {
    sigRows: sig.length, sigClusters: sCM.size,
    uRows: inSlice.length, uClusters: uCM.size,
    sMean, uMean, excess, seDiff, t,
    rowExcess: mean(sRows) - mean(uRows),
    pairedN: diffs.length, pairedMean: pMean, pairedSe: pSe,
    pairedT: pSe > 0 ? pMean / pSe : null,
    mde: 2 * seDiff, // the minimum detectable excess at t=2
    sCM, uCM,
  };
}

/** The trim test. */
function trimStats(trades, bucketSet, uMean, uSe) {
  const sig = trades.filter((t) => t._signal && bucketSet.has(t._bucket));
  if (sig.length < 2 * TRIM_N + 2) return null;
  const sorted = [...sig].sort((a, b) => a.pnl - b.pnl);
  const worst = sorted.slice(TRIM_N);
  const best = sorted.slice(0, sorted.length - TRIM_N);
  const wCM = clusterMeans(worst.map((t) => t.pnl), worst.map((t) => t._bucket));
  const bCM = clusterMeans(best.map((t) => t.pnl), best.map((t) => t._bucket));
  const wVals = [...wCM.values()], bVals = [...bCM.values()];
  const wEx = mean(wVals) - uMean;
  const bEx = mean(bVals) - uMean;
  const wSe = Math.sqrt(se(wVals) ** 2 + uSe ** 2);
  const bSe = Math.sqrt(se(bVals) ** 2 + uSe ** 2);
  return {
    worstExcess: wEx, bestExcess: bEx,
    worstT: wSe > 0 ? wEx / wSe : null, bestT: bSe > 0 ? bEx / bSe : null,
    worstClusters: wCM.size, bestClusters: bCM.size,
  };
}

// ── the regime families ──
const FAMILIES = [
  { key: "hour", label: "session hour (UTC)", field: "_hour" },
  { key: "dow", label: "day of week", field: "_dow" },
  { key: "regime3", label: "trend regime (near high / near low / flat)", field: "_regime3" },
  { key: "nearHigh", label: "near the high (offHighPct<8) vs not", field: "_nearHigh" },
  { key: "vol", label: "volatility regime (ATR tertile, IN-SAMPLE cuts)", field: "_vol" },
  { key: "dir", label: "the tape's side (long / short)", field: "_tape" },
  { key: "chg", label: "the market's direction (tape chg>0 / <0)", field: "_chg" },
];

function groupLabel(t, fam) {
  const v = t[fam.field];
  if (fam.key === "nearHigh") return v ? "nearHigh" : "notNearHigh";
  if (fam.key === "chg") return v > 0 ? "up" : v < 0 ? "down" : "flat";
  return String(v);
}

// ═══════════════════════════════════════════════════════════════════════
console.log("=".repeat(126));
console.log("[regime] THE REGIME TEST (v2) — is the geometry candidate's excess in a regime that can be identified in advance?");
console.log("[regime] Read-only: a sealed snapshot of the collector's rows and a sealed bar cache. No venue calls, no orders.");
console.log("=".repeat(126));

const { rows, volCuts } = loadRows();
const tsAll = rows.map((r) => r.ts);
const spanStart = minOf(tsAll), spanEnd = maxOf(tsAll);
const allBuckets = [...new Set(rows.map((r) => r._bucket))].sort((a, b) => a - b);
const tapeRows = rows.filter((r) => r._tape);
const signalRows = rows.filter((r) => r._signal);

console.log(`\n[regime] SNAPSHOT  ${new Date(spanStart).toISOString()} -> ${new Date(spanEnd).toISOString()}  (${((spanEnd - spanStart) / 3600000).toFixed(2)} h)`);
console.log(`[regime] rows ${rows.length} | symbols ${new Set(rows.map((r) => r.pair)).size} | 5-min buckets ${allBuckets.length}`);
console.log(`[regime] CONTROL (tape + models agree) ${signalRows.length} rows | ${new Set(signalRows.map((r) => r._bucket)).size} clusters | long ${signalRows.filter((r) => r._tape === "long").length} short ${signalRows.filter((r) => r._tape === "short").length}`);
console.log(`[regime] UNCONDITIONAL (tape side only) ${tapeRows.length} rows | ${new Set(tapeRows.map((r) => r._bucket)).size} clusters | long ${tapeRows.filter((r) => r._tape === "long").length} short ${tapeRows.filter((r) => r._tape === "short").length}`);
console.log(`[regime] volatility tertile cuts (ATR%): low<=${volCuts[0].toFixed(3)}  mid<=${volCuts[1].toFixed(3)}  high>${volCuts[1].toFixed(3)}   [in-sample cuts]`);
console.log(`[regime] fee ${TAKER_RT}% taker RT on notional = ${(TAKER_RT * NOE).toFixed(4)}% of equity per trade; exposure ${NOE.toFixed(4)}x`);

// ── the data sources ──
const geoBars = existsSync(BARS_FILE) ? JSON.parse(readFileSync(BARS_FILE, "utf8")) : {};
const confBars = existsSync(CONF_BARS) ? JSON.parse(readFileSync(CONF_BARS, "utf8")) : {};
const bookSeries = new Map();
for (const r of rows) {
  if (!(r.price > 0)) continue;
  if (!bookSeries.has(r.pair)) bookSeries.set(r.pair, []);
  bookSeries.get(r.pair).push([r.ts, r.price]);
}
for (const a of bookSeries.values()) a.sort((x, y) => x[0] - y[0]);
const confSeries = new Map();
for (const k of Object.keys(confBars)) confSeries.set(k, confBars[k].map((b) => [b.t, b.c]));

const PRIMARY_GEO = { name: "TP 1.2 / SL 1.2", tp: 1.2, sl: 1.2 };

const BASES = [
  { key: "ticket4h", label: "TICKET 15m bars, 4h hold (16 bars) [the study's]", make: () => simulateTicket(rows, PRIMARY_GEO, geoBars, HOLD_BARS) },
  { key: "ticket1h", label: "TICKET 15m bars, 1h hold (4 bars)", make: () => simulateTicket(rows, PRIMARY_GEO, geoBars, 4) },
  { key: "ticket2h", label: "TICKET 15m bars, 2h hold (8 bars)", make: () => simulateTicket(rows, PRIMARY_GEO, geoBars, 8) },
  { key: "book1h", label: "BOOK MID forward 1h (43 symbols)", make: () => simulateForward(rows, bookSeries, 3600000) },
  { key: "book2h", label: "BOOK MID forward 2h (43 symbols)", make: () => simulateForward(rows, bookSeries, 7200000) },
  { key: "conf1h", label: "HOURLY CLOSE forward 1h (24 symbols)", make: () => simulateForward(rows, confSeries, 3600000) },
];

// ── the pooled result for every geometry ──
console.log("\n" + "-".repeat(126));
console.log(`  THE POOLED RESULT — every geometry, TICKET basis (15m bars, ${HOLD_BARS}-bar hold, the study's own)`);
console.log("  EXCESS  = control mean - unconditional mean, on CLUSTER MEANS (one mean per 5-min bucket)");
console.log("  rowExc  = the same difference on the RAW rows (the study's headline statistic)");
console.log("  paired  = the cluster excess computed WITHIN each 5-min bucket (market drift removed)");
console.log("  MDE@2   = the minimum detectable excess at t=2 — this sample's power, as a number");
console.log("-".repeat(126));
console.log("  geometry           ctl rows clus  uncond rows clus    ctl EV    uncond EV    EXCESS   rowExc       t   paired t  paired n     MDE@2");
const geoRows = [];
for (const g of GEOMETRIES) {
  const { trades, unresolved, ambiguous, missingAtr } = simulateTicket(rows, g, geoBars, HOLD_BARS);
  const all = new Set(trades.map((t) => t._bucket));
  const s = sliceStats(trades, all);
  geoRows.push({ g, s, trades, unresolved, ambiguous, missingAtr });
  const flag = s.sigClusters >= MIN_CLUSTERS ? "" : `  (${s.sigClusters} clusters < ${MIN_CLUSTERS})`;
  console.log(
    `  ${pad(g.name, 16)} ${rpad(s.sigRows, 7)} ${rpad(s.sigClusters, 4)}  ${rpad(s.uRows, 11)} ${rpad(s.uClusters, 4)}  ${fmt(s.sMean)}   ${fmt(s.uMean)}  ${fmt(s.excess)} ${fmt(s.rowExcess)} ${rpad(fmt(s.t, 2), 7)} ${rpad(fmt(s.pairedT, 2), 8)} ${rpad(s.pairedN, 8)} ${rpad(fmt(s.mde), 9)}${flag}`,
  );
}
console.log(`\n  [regime] unresolved (no forward bars) / ambiguous (both levels touched): ` +
  geoRows.map((r) => `${r.g.name}: ${r.unresolved}/${r.ambiguous}`).join("  "));
console.log(`  [regime] the BAR is n>=${MIN_CLUSTERS} INDEPENDENT CLUSTERS, excess>0, t>=${T_BAR}, trim-stable, placebo-beaten.`);

// ── the bases ──
console.log("\n" + "-".repeat(126));
console.log("  THE BASES — the pooled excess on each measurement basis (the primary geometry, TP 1.2 / SL 1.2)");
console.log("-".repeat(126));
console.log("  basis                                       ctl rows clus  uncond rows clus    ctl EV    uncond EV    EXCESS   rowExc       t   paired t  paired n     MDE@2");
const bases = {};
for (const b of BASES) {
  const { trades, unresolved } = b.make();
  const all = new Set(trades.map((t) => t._bucket));
  const s = sliceStats(trades, all);
  bases[b.key] = { ...b, trades, unresolved, s, all };
  console.log(
    `  ${pad(b.label, 42)} ${rpad(s.sigRows, 7)} ${rpad(s.sigClusters, 4)}  ${rpad(s.uRows, 11)} ${rpad(s.uClusters, 4)}  ${fmt(s.sMean)}   ${fmt(s.uMean)}  ${fmt(s.excess)} ${fmt(s.rowExcess)} ${rpad(fmt(s.t, 2), 7)} ${rpad(fmt(s.pairedT, 2), 8)} ${rpad(s.pairedN, 8)} ${rpad(fmt(s.mde), 9)}`,
  );
}

// ── the chronological split ──
console.log("\n" + "=".repeat(126));
console.log("  THE CHRONOLOGICAL SPLIT — the decisive test. A regime that only appears in one block is a WINDOW.");
console.log("=".repeat(126));

function blockBuckets(buckets, n) {
  const per = Math.ceil(buckets.length / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const slice = buckets.slice(i * per, (i + 1) * per);
    if (slice.length) out.push({ idx: i, buckets: new Set(slice), from: slice[0], to: slice[slice.length - 1] });
  }
  return out;
}

for (const key of ["ticket4h", "ticket1h", "book1h"]) {
  const B = bases[key];
  console.log(`\n  ── ${B.label} ──`);
  console.log("  block   UTC window          ctl rows clus    ctl EV    uncond EV    EXCESS       t   paired t   uncond clus     MDE@2");
  const blocks = blockBuckets([...B.all].sort((a, b) => a - b), 3);
  const blockExcesses = [], ctlEvs = [], uncondEvs = [];
  for (const blk of blocks) {
    const s = sliceStats(B.trades, blk.buckets);
    blockExcesses.push(s.excess);
    ctlEvs.push(s.sMean);
    uncondEvs.push(s.uMean);
    console.log(
      `  ${rpad(blk.idx + 1, 4)}   ${new Date(blk.from * BUCKET_MS).toISOString().slice(11, 16)}-${new Date(blk.to * BUCKET_MS).toISOString().slice(11, 16)}  ${rpad(s.sigRows, 8)} ${rpad(s.sigClusters, 4)}  ${fmt(s.sMean)}   ${fmt(s.uMean)}   ${fmt(s.excess)} ${rpad(fmt(s.t, 2), 7)} ${rpad(fmt(s.pairedT, 2), 9)} ${rpad(s.uClusters, 11)} ${rpad(fmt(s.mde), 9)}`,
    );
  }
  const pos = blockExcesses.filter((x) => x > 0).length;
  console.log(`  → excess positive in ${pos}/3 blocks ${blockExcesses.map((x) => fmt(x)).join(" ")}   ${pos === 3 ? "CONSISTENT ACROSS BLOCKS" : pos >= 2 ? "MARGINAL — one block is negative" : "A WINDOW, NOT A REGIME"}`);
  console.log(`    the CONTROL arm's own EV across the blocks:   ${ctlEvs.map((x) => fmt(x)).join(" ")}    <- if this moves, the excess moves with the MARKET`);
  console.log(`    the UNCONDITIONAL arm's EV across the blocks: ${uncondEvs.map((x) => fmt(x)).join(" ")}`);
}

// ── the regime families ──
console.log("\n" + "=".repeat(126));
console.log("  THE REGIME FAMILIES — the excess within each regime, with its cluster count, the trim, and the placebo");
console.log("=".repeat(126));

/**
 * The PLACEBO family of the same shape: the control arm's clusters are
 * randomly re-assigned to groups with the SAME group sizes, and each
 * placebo group's excess is measured the same way. The bar the real regime
 * must beat is the distribution of the BEST placebo group.
 */
function placebo(trades, groupSizes, seed) {
  const rnd = mulberry32(seed);
  const sig = trades.filter((t) => t._signal);
  const uAll = trades.filter((t) => !t._signal);
  const sCM = clusterMeans(sig.map((t) => t.pnl), sig.map((t) => t._bucket));
  const uCM = clusterMeans(uAll.map((t) => t.pnl), uAll.map((t) => t._bucket));
  const sBuckets = [...sCM.keys()];
  if (!sBuckets.length || !uCM.size) return null;
  const best = [];
  for (let d = 0; d < PLACEBO_DRAWS; d++) {
    const shuffled = [...sBuckets];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let idx = 0, worst = -Infinity;
    for (const size of groupSizes) {
      const grp = shuffled.slice(idx, idx + size);
      idx += size;
      if (!grp.length) continue;
      const sv = grp.map((b) => sCM.get(b)).filter((x) => x !== undefined);
      const uv = grp.map((b) => uCM.get(b)).filter((x) => x !== undefined);
      if (!sv.length || !uv.length) continue;
      const ex = mean(sv) - mean(uv);
      if (ex > worst) worst = ex;
    }
    best.push(worst);
  }
  best.sort((a, b) => a - b);
  return {
    p50: best[Math.floor(PLACEBO_DRAWS * 0.5)],
    p95: best[Math.floor(PLACEBO_DRAWS * 0.95)],
    max: best[PLACEBO_DRAWS - 1],
  };
}

/** The bucket -> label map for a family over a scope. */
function labelMap(trades, fam, scopeBuckets) {
  const m = new Map();
  for (const b of scopeBuckets) m.set(b, null);
  for (const t of trades) {
    if (!scopeBuckets.has(t._bucket)) continue;
    const sigLbls = new Set(trades.filter((x) => x._bucket === t._bucket && x._signal).map((x) => groupLabel(x, fam)));
    const chosen = sigLbls.size === 1 ? [...sigLbls][0] : sigLbls.size > 1 ? "MIXED" : groupLabel(t, fam);
    if (m.get(t._bucket) === null) m.set(t._bucket, chosen);
  }
  return m;
}

for (const key of ["ticket4h", "book1h"]) {
  const B = bases[key];
  console.log(`\n  ══ ${B.label} ══`);
  for (const fam of FAMILIES) {
    const lm = labelMap(B.trades, fam, B.all);
    const groups = [...new Set([...lm.values()].filter((v) => v !== null))].sort();
    console.log(`\n    ── FAMILY: ${fam.label} ──`);
    console.log("    regime        ctl rows clus   ctl EV    uncond EV    EXCESS       t   paired t  paired n    MDE@2   trim(worst3/best3)        placebo p95/max       VERDICT");
    const groupSizes = [];
    const groupStats = [];
    for (const g of groups) {
      const bset = new Set([...lm.entries()].filter(([, l]) => l === g).map(([b]) => b));
      const s = sliceStats(B.trades, bset);
      groupStats.push({ g, bset, s });
      if (s.sigClusters > 0) groupSizes.push(s.sigClusters);
    }
    const pl = placebo(B.trades, groupSizes, 12345 + fam.key.length);
    for (const { g, bset, s } of groupStats) {
      const tr = trimStats(B.trades, bset, s.uMean, se([...s.uCM.values()]));
      const trimTxt = tr ? `${fmt(tr.worstExcess)} / ${fmt(tr.bestExcess)} (${tr.worstClusters}/${tr.bestClusters} cl)` : "n/a";
      const plTxt = pl ? `${fmt(pl.p95)} / ${fmt(pl.max)}` : "n/a";
      const beats = pl ? s.excess > pl.p95 : false;
      let verdict;
      if (s.sigClusters === 0) verdict = "NO CONTROL DATA";
      else if (s.sigClusters < MIN_CLUSTERS) verdict = `too few clusters (${s.sigClusters})`;
      else if (s.excess <= 0) verdict = "no excess";
      else if ((s.t ?? 0) < T_BAR) verdict = "excess but t<2";
      else if (!beats) verdict = "does NOT beat placebo";
      else verdict = "CANDIDATE";
      console.log(
        `    ${pad(g, 12)} ${rpad(s.sigRows, 8)} ${rpad(s.sigClusters, 4)}  ${fmt(s.sMean)}   ${fmt(s.uMean)}   ${fmt(s.excess)} ${rpad(fmt(s.t, 2), 7)} ${rpad(fmt(s.pairedT, 2), 8)} ${rpad(s.pairedN, 8)} ${rpad(fmt(s.mde), 8)}   ${pad(trimTxt, 26)} ${pad(plTxt, 20)} ${verdict}`,
      );
    }
  }
}

// ── the TRUE out-of-sample regime test ──
console.log("\n" + "=".repeat(126));
console.log("  THE OUT-OF-SAMPLE REGIME TEST — the regime is CHOSEN on blocks 1+2, then MEASURED on block 3.");
console.log("  This is the only way a regime found in this sample can be used in this sample without the selection artefact.");
console.log("=".repeat(126));

for (const key of ["ticket4h", "book1h"]) {
  const B = bases[key];
  const blocks = blockBuckets([...B.all].sort((a, b) => a - b), 3);
  const inSample = new Set([...blocks[0].buckets, ...blocks[1].buckets]);
  const oos = blocks[2].buckets;
  console.log(`\n  ── ${B.label} ──`);
  console.log(`    discovery window: ${new Date(blocks[0].from * BUCKET_MS).toISOString().slice(11, 16)}-${new Date(blocks[1].to * BUCKET_MS).toISOString().slice(11, 16)}  (blocks 1+2)`);
  console.log(`    test window:      ${new Date(blocks[2].from * BUCKET_MS).toISOString().slice(11, 16)}-${new Date(blocks[2].to * BUCKET_MS).toISOString().slice(11, 16)}  (block 3)`);
  console.log("    family           regime       in-sample EXCESS (blk1+2)   OOS EXCESS (blk3)   OOS clusters   verdict");
  for (const fam of FAMILIES) {
    const lmIS = labelMap(B.trades, fam, inSample);
    const lmOOS = labelMap(B.trades, fam, oos);
    const groups = [...new Set([...lmIS.values()].filter((v) => v !== null))].sort();
    let bestG = null, bestEx = -Infinity, bestS = null;
    for (const g of groups) {
      const bset = new Set([...lmIS.entries()].filter(([, l]) => l === g).map(([b]) => b));
      const s = sliceStats(B.trades, bset);
      if (s.sigClusters === 0) continue;
      if (s.excess > bestEx) { bestEx = s.excess; bestG = g; bestS = s; }
    }
    if (!bestG) { console.log(`    ${pad(fam.key, 14)} (no group with control data)`); continue; }
    const oosSet = new Set([...lmOOS.entries()].filter(([, l]) => l === bestG).map(([b]) => b));
    const oosS = sliceStats(B.trades, oosSet);
    const oosVerdict =
      oosS.sigClusters === 0 ? "NO OOS DATA"
      : oosS.excess <= 0 ? "OOS excess NEGATIVE — the regime did not hold"
      : (oosS.t ?? 0) < T_BAR ? "OOS positive but t<2"
      : "OOS POSITIVE";
    console.log(
      `    ${pad(fam.key, 14)} ${pad(bestG, 12)} ${fmt(bestEx).padStart(10)} (${bestS.sigClusters} cl)   ${fmt(oosS.excess).padStart(14)}   ${rpad(oosS.sigClusters, 11)}   ${oosVerdict}`,
    );
  }
}

console.log("\n" + "=".repeat(126));
console.log("[regime] DONE");
console.log("=".repeat(126));
