#!/usr/bin/env node
/**
 * THE REGIME TEST — ADDENDUM. Four questions the main test leaves open:
 *
 *   1. IS THE EXCESS A MARKET-DRIFT ARTEFACT? The control arm's cluster
 *      means are regressed against the MARKET's own move in the same
 *      bucket. If the control arm simply rides the market, then what the
 *      models add is the market's drift, not skill.
 *   2. LEAVE-ONE-BLOCK-OUT. The excess on each PAIR of blocks. A robust
 *      effect is positive on all three pairs.
 *   3. THE FEE FLOOR. A regime filter is only worth trading if the
 *      STRATEGY's net EV per trade clears the taker round trip. The
 *      filter's improvement is measured against the fee, not against
 *      zero.
 *   4. DOES A REGIME FILTER IMPROVE THE POOLED RESULT AT ALL? The best
 *      regime is chosen on blocks 1+2 and applied to block 3, and the
 *      resulting strategy EV is compared with the unfiltered one.
 *
 * Read-only. No venue calls. Writes nothing.
 *
 * USAGE
 *   node research/regime-excess-addendum.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const SNAP = join(SCRATCH, "regime-excess-snap.ndjson");
const BARS_FILE = join(SCRATCH, "regime-excess-fullbars.json");
const CONF_BARS = join(SCRATCH, "regime-excess-confluence-bars.json");

const TAKER_RT = 0.12;
const EQUITY = 57.2287;
const NOTIONAL = 60.0;
const NOE = NOTIONAL / EQUITY;
const BUCKET_MS = 5 * 60_000;
const HOLD_BARS = 16;
const TRIM_N = 3;
const MIN_CLUSTERS = 30;
const T_BAR = 2;

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

function clusterMeans(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i];
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(values[i]);
  }
  return new Map([...byBucket.entries()].map(([b, a]) => [b, mean(a)]));
}

function modelSideOf(r) {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return jev && laya ? (jev === laya ? jev : null) : (jev || laya);
}

function outcome(bars, ts, entry, tpPct, slPct, long, maxHoldBars) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].t > ts) { start = i; break; } }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + maxHoldBars);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { kind: "loss" };
    if (hitTp) return { kind: "win" };
    if (hitSl) return { kind: "loss" };
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

function simulateTicket(rows, geo, bars, holdBars) {
  const trades = [];
  let unresolved = 0, ambiguous = 0;
  for (const r of rows) {
    if (!r._tape) continue;
    const a = bars[r.pair];
    if (!a?.length) { unresolved++; continue; }
    let idx = -1;
    for (let i = 0; i < a.length; i++) { if (a[i].t <= r.ts) idx = i; else break; }
    if (idx < 0) { unresolved++; continue; }
    const entry = a[idx].c;
    const atrPct = Number(r.tapeAtrPct ?? NaN);
    const tpPct = geo.tp != null ? geo.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
    const slPct = geo.sl != null ? geo.sl : Math.max(0.3, atrPct * 1.34);
    if (geo.shipped && (!Number.isFinite(atrPct) || atrPct <= 0)) { unresolved++; continue; }
    if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
    const long = r._tape === "long";
    const o = outcome(a, r.ts, entry, tpPct, slPct, long, holdBars);
    if (o === null) { unresolved++; continue; }
    if (o.kind === "loss") ambiguous++;
    let pnl;
    if (o.kind === "win") pnl = (tpPct - TAKER_RT) * NOE;
    else if (o.kind === "loss") pnl = (-slPct - TAKER_RT) * NOE;
    else pnl = (o.movePct - TAKER_RT) * NOE;
    trades.push({ ...r, pnl, kind: o.kind });
  }
  return { trades, unresolved, ambiguous };
}

function sliceStats(trades, bucketSet) {
  const inSlice = trades.filter((t) => bucketSet.has(t._bucket));
  const sig = inSlice.filter((t) => t._signal);
  const sCM = clusterMeans(sig.map((t) => t.pnl), sig.map((t) => t._bucket));
  const uCM = clusterMeans(inSlice.map((t) => t.pnl), inSlice.map((t) => t._bucket));
  const sVals = [...sCM.values()], uVals = [...uCM.values()];
  const sMean = mean(sVals), uMean = mean(uVals);
  const excess = sMean - uMean;
  const seDiff = Math.sqrt(se(sVals) ** 2 + se(uVals) ** 2);
  const diffs = [];
  for (const [b, sm] of sCM) if (uCM.has(b)) diffs.push(sm - uCM.get(b));
  const pSe = se(diffs);
  return {
    sigRows: sig.length, sigClusters: sCM.size,
    uRows: inSlice.length, uClusters: uCM.size,
    sMean, uMean, excess, seDiff,
    t: seDiff > 0 ? excess / seDiff : null,
    pairedT: pSe > 0 ? mean(diffs) / pSe : null,
    mde: 2 * seDiff,
    sCM, uCM,
  };
}

function trimStats(trades, bucketSet, uMean, uSe) {
  const sig = trades.filter((t) => t._signal && bucketSet.has(t._bucket));
  if (sig.length < 2 * TRIM_N + 2) return null;
  const sorted = [...sig].sort((a, b) => a.pnl - b.pnl);
  const wCM = clusterMeans(sorted.slice(TRIM_N).map((t) => t.pnl), sorted.slice(TRIM_N).map((t) => t._bucket));
  const bCM = clusterMeans(sorted.slice(0, sorted.length - TRIM_N).map((t) => t.pnl), sorted.slice(0, sorted.length - TRIM_N).map((t) => t._bucket));
  const wVals = [...wCM.values()], bVals = [...bCM.values()];
  return {
    worstExcess: mean(wVals) - uMean, bestExcess: mean(bVals) - uMean,
    worstT: (Math.sqrt(se(wVals) ** 2 + uSe ** 2) > 0) ? (mean(wVals) - uMean) / Math.sqrt(se(wVals) ** 2 + uSe ** 2) : null,
    bestT: (Math.sqrt(se(bVals) ** 2 + uSe ** 2) > 0) ? (mean(bVals) - uMean) / Math.sqrt(se(bVals) ** 2 + uSe ** 2) : null,
  };
}

// ── load ──
// The regime fields are computed on the ROWS BEFORE the trades are
// simulated, because simulateTicket copies the rows into the trades and
// a field set afterwards never reaches the trade.
const rows = readFileSync(SNAP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const r of rows) {
  r._tape = tapeSideFromRow(r);
  r._model = modelSideOf(r);
  r._signal = !!r._tape && r._model === r._tape;
  r._bucket = Math.floor(r.ts / BUCKET_MS);
  r._hour = new Date(r.ts).getUTCHours();
  r._dow = new Date(r.ts).getUTCDay();
  r._atr = Number(r.tapeAtrPct ?? NaN);
  r._chg = Number(r.tapeChg ?? 0);
  r._nearHigh = Number(r.tapeOffHighPct ?? 0) < 8;
  const oh = Number(r.tapeOffHighPct ?? 0), ol = Number(r.tapeOffLowPct ?? 0);
  r._regime3 = ol < 8 && oh >= 8 ? "nearLow" : oh < 8 && ol >= 8 ? "nearHigh" : "flat";
}
// The volatility regime: ATR tertiles over the sample. The cuts come FROM
// THE SAMPLE, so this family is in-sample by construction.
const atrList = rows.map((r) => r._atr).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const tert = (p) => atrList[Math.min(atrList.length - 1, Math.floor(p * atrList.length))];
const ATR_T1 = tert(1 / 3), ATR_T2 = tert(2 / 3);
for (const r of rows) {
  r._vol = !Number.isFinite(r._atr) ? "unknown" : r._atr <= ATR_T1 ? "low" : r._atr <= ATR_T2 ? "mid" : "high";
}
const geoBars = JSON.parse(readFileSync(BARS_FILE, "utf8"));
const confBars = JSON.parse(readFileSync(CONF_BARS, "utf8"));
const PRIMARY_GEO = { name: "TP 1.2 / SL 1.2", tp: 1.2, sl: 1.2 };

// The MARKET's own move per bucket: the cross-sectional mean of the
// collector's 1-hour forward book-mid return across all 43 symbols.
const bookSeries = new Map();
for (const r of rows) {
  if (!(r.price > 0)) continue;
  if (!bookSeries.has(r.pair)) bookSeries.set(r.pair, []);
  bookSeries.get(r.pair).push([r.ts, r.price]);
}
for (const a of bookSeries.values()) a.sort((x, y) => x[0] - y[0]);
const marketByBucket = new Map(); // bucket -> mean 1h forward return (%)
{
  const perBucket = new Map();
  for (const r of rows) {
    if (!r._tape) continue;
    const a = bookSeries.get(r.pair);
    if (!a?.length) continue;
    let idx = -1;
    for (let i = 0; i < a.length; i++) { if (a[i][0] <= r.ts) idx = i; else break; }
    if (idx < 0) continue;
    const need = r.ts + 3600000;
    let out = -1;
    for (let i = idx; i < a.length; i++) { if (a[i][0] >= need) { out = i; break; } }
    if (out < 0) continue;
    const ret = ((a[out][1] - a[idx][1]) / a[idx][1]) * 100;
    if (!perBucket.has(r._bucket)) perBucket.set(r._bucket, []);
    perBucket.get(r._bucket).push(ret);
  }
  for (const [b, v] of perBucket) marketByBucket.set(b, mean(v));
}

const { trades, unresolved, ambiguous } = simulateTicket(rows, PRIMARY_GEO, geoBars, HOLD_BARS);
const allBuckets = new Set(trades.map((t) => t._bucket));
const all = [...allBuckets].sort((a, b) => a - b);

console.log("=".repeat(120));
console.log("[add] THE REGIME TEST — ADDENDUM (read-only, sealed snapshot)");
console.log("=".repeat(120));
console.log(`[add] control rows ${rows.filter((r) => r._signal).length} | control clusters ${new Set(rows.filter((r) => r._signal).map((r) => r._bucket)).size} | trades ${trades.length} | unresolved ${unresolved} | ambiguous ${ambiguous}`);

// ── 1. the beta check ──
console.log("\n" + "-".repeat(120));
console.log("  1. IS THE CONTROL ARM RIDING THE MARKET? The control arm's per-cluster EV against the market's own 1h move in that bucket.");
console.log("-".repeat(120));
{
  const pts = [];
  for (const [b, sm] of sliceStats(trades, allBuckets).sCM) {
    const mk = marketByBucket.get(b);
    if (mk === undefined) continue;
    pts.push([mk, sm]);
  }
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  const cov = mean(pts.map((p) => (p[0] - mx) * (p[1] - my)));
  const sx = sd(pts.map((p) => p[0])), sy = sd(pts.map((p) => p[1]));
  const r = sx > 0 && sy > 0 ? cov / (sx * sy) : null;
  const slope = sx > 0 ? cov / (sx * sx) : null;
  console.log(`    n buckets with both a control cluster and a market move: ${pts.length}`);
  console.log(`    correlation(control cluster EV, market 1h move) = ${r === null ? "n/a" : r.toFixed(3)}`);
  console.log(`    slope (control EV per 1% of market move) = ${fmt(slope)} % of equity`);
  console.log(`    the market's own move per bucket: mean ${fmt(mx, 3)}%  sd ${fmt(sx, 3)}%`);
  // The same for the UNCONDITIONAL arm, for comparison.
  const upts = [];
  const uCM = sliceStats(trades, allBuckets).uCM;
  for (const [b, um] of uCM) {
    const mk = marketByBucket.get(b);
    if (mk === undefined) continue;
    upts.push([mk, um]);
  }
  const ux = mean(upts.map((p) => p[0])), uy = mean(upts.map((p) => p[1]));
  const ucov = mean(upts.map((p) => (p[0] - ux) * (p[1] - uy)));
  const usx = sd(upts.map((p) => p[0])), usy = sd(upts.map((p) => p[1]));
  console.log(`    the SAME for the unconditional arm: correlation = ${usx > 0 && usy > 0 ? (ucov / (usx * usy)).toFixed(3) : "n/a"}  (n=${upts.length})`);
  console.log("    if BOTH arms track the market, the excess is the market's drift with the models' filter on top — not directional skill.");
}

// ── 2. leave-one-block-out ──
console.log("\n" + "-".repeat(120));
console.log("  2. LEAVE-ONE-BLOCK-OUT — the excess on each PAIR of chronological blocks.");
console.log("-".repeat(120));
{
  const per = Math.ceil(all.length / 3);
  const blocks = [];
  for (let i = 0; i < 3; i++) {
    const sl = all.slice(i * per, (i + 1) * per);
    if (sl.length) blocks.push({ idx: i, set: new Set(sl), from: sl[0], to: sl[sl.length - 1] });
  }
  console.log("    pair        window                          ctl clus   EXCESS       t   paired t     MDE@2");
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const set = new Set([...blocks[i].set, ...blocks[j].set]);
      const s = sliceStats(trades, set);
      console.log(
        `    ${blocks[i].idx + 1}+${blocks[j].idx + 1}         ${new Date(blocks[i].from * BUCKET_MS).toISOString().slice(11, 16)}-${new Date(blocks[j].to * BUCKET_MS).toISOString().slice(11, 16)}   ${rpad(s.sigClusters, 7)}  ${fmt(s.excess)} ${rpad(fmt(s.t, 2), 7)} ${rpad(fmt(s.pairedT, 2), 9)} ${rpad(fmt(s.mde), 9)}`,
      );
    }
  }
  console.log("    a robust effect is positive on all three pairs; one negative pair is the window.");
}

// ── 3 & 4. the fee floor and whether a regime filter pays ──
console.log("\n" + "=".repeat(120));
console.log("  3+4. THE FEE FLOOR, AND WHETHER A REGIME FILTER IMPROVES THE POOLED RESULT");
console.log("=".repeat(120));
{
  const FEE_EQ = TAKER_RT * NOE; // the fee in % of equity per trade
  const pooled = sliceStats(trades, allBuckets);
  console.log(`\n    the taker round trip is ${TAKER_RT}% of notional = ${fmt(FEE_EQ)}% of equity per trade (exposure ${NOE.toFixed(4)}x)`);
  console.log(`    the UNFILTERED control arm: EV ${fmt(pooled.sMean)}% of equity per trade, net of that fee`);
  console.log(`    the model's EXCESS over the unconditional baseline: ${fmt(pooled.excess)}% of equity per trade`);
  console.log(`    → the excess is ${pooled.excess > FEE_EQ ? "ABOVE" : "BELOW"} the fee floor (${fmt(FEE_EQ)}): a model filter that pays ${fmt(pooled.excess)} of extra edge per trade ${pooled.excess > FEE_EQ ? "would" : "would NOT"} cover a taker round trip.`);

  const FAMILIES = [
    { key: "hour", label: "session hour (UTC)", field: "_hour" },
    { key: "regime3", label: "trend regime", field: "_regime3" },
    { key: "nearHigh", label: "near the high", field: "_nearHigh" },
    { key: "vol", label: "volatility regime (IN-SAMPLE cuts)", field: "_vol" },
    { key: "chg", label: "market direction", field: "_chg" },
  ];
  // The regime fields were computed on the rows before the trades were
  // simulated, so the trades already carry them.
  const labelOf = (t, fam) => {
    const v = t[fam.field];
    if (fam.key === "nearHigh") return v ? "nearHigh" : "notNearHigh";
    if (fam.key === "chg") return v > 0 ? "up" : v < 0 ? "down" : "flat";
    if (fam.key === "regime3") {
      const oh = Number(t.tapeOffHighPct ?? 0), ol = Number(t.tapeOffLowPct ?? 0);
      if (ol < 8 && oh >= 8) return "nearLow";
      if (oh < 8 && ol >= 8) return "nearHigh";
      return "flat";
    }
    return String(v);
  };
  const per = Math.ceil(all.length / 3);
  const blocks = [];
  for (let i = 0; i < 3; i++) {
    const sl = all.slice(i * per, (i + 1) * per);
    if (sl.length) blocks.push({ idx: i, set: new Set(sl), from: sl[0], to: sl[sl.length - 1] });
  }
  const discovery = new Set([...blocks[0].set, ...blocks[1].set]);
  const oos = blocks[2].set;

  console.log(`\n    The filter is CHOSEN on blocks 1+2 and APPLIED to block 3. The comparison is the strategy EV per trade, net of the fee.`);
  console.log("    family       regime        in-sample EXCESS (blk1+2)   OOS strategy EV   OOS ctl clus   vs unfiltered   pays the fee?");
  for (const fam of FAMILIES) {
    // The groups over the discovery window.
    const lm = new Map();
    for (const t of trades) {
      if (!discovery.has(t._bucket)) continue;
      const sigLbls = new Set(trades.filter((x) => x._bucket === t._bucket && x._signal).map((x) => labelOf(x, fam)));
      const chosen = sigLbls.size === 1 ? [...sigLbls][0] : sigLbls.size > 1 ? "MIXED" : labelOf(t, fam);
      if (!lm.has(t._bucket) || lm.get(t._bucket) === null) lm.set(t._bucket, chosen);
    }
    const groups = [...new Set([...lm.values()])].sort();
    let bestG = null, bestEx = -Infinity, bestCl = 0;
    for (const g of groups) {
      const bset = new Set([...lm.entries()].filter(([, l]) => l === g).map(([b]) => b));
      const s = sliceStats(trades, bset);
      if (s.sigClusters === 0) continue;
      if (s.excess > bestEx) { bestEx = s.excess; bestG = g; bestCl = s.sigClusters; }
    }
    if (!bestG) { console.log(`    ${pad(fam.key, 12)} (no group with control data)`); continue; }
    // Apply that regime to block 3.
    const oosLm = new Map();
    for (const t of trades) {
      if (!oos.has(t._bucket)) continue;
      const sigLbls = new Set(trades.filter((x) => x._bucket === t._bucket && x._signal).map((x) => labelOf(x, fam)));
      const chosen = sigLbls.size === 1 ? [...sigLbls][0] : sigLbls.size > 1 ? "MIXED" : labelOf(t, fam);
      if (!oosLm.has(t._bucket) || oosLm.get(t._bucket) === null) oosLm.set(t._bucket, chosen);
    }
    const oosSet = new Set([...oosLm.entries()].filter(([, l]) => l === bestG).map(([b]) => b));
    const oosS = sliceStats(trades, oosSet);
    const unfilteredOos = sliceStats(trades, oos);
    const diff = oosS.sMean - unfilteredOos.sMean;
    console.log(
      `    ${pad(fam.key, 12)} ${pad(bestG, 12)} ${fmt(bestEx).padStart(10)} (${bestCl} cl)   ${fmt(oosS.sMean).padStart(13)}   ${rpad(oosS.sigClusters, 11)}   ${fmt(diff).padStart(12)}   ${oosS.sMean > FEE_EQ ? "YES" : "NO — below the " + fmt(FEE_EQ) + " fee"}`,
    );
  }
  console.log(`    the unfiltered control arm's EV in block 3: ${fmt(sliceStats(trades, oos).sMean)}% of equity per trade (${oos.size} clusters)`);
}

// ── 5. the trim on the pooled result ──
console.log("\n" + "-".repeat(120));
console.log("  5. THE TRIM TEST on the pooled result and on the best block.");
console.log("-".repeat(120));
{
  const pooled = sliceStats(trades, allBuckets);
  const tr = trimStats(trades, allBuckets, pooled.uMean, se([...pooled.uCM.values()]));
  console.log(`    pooled: worst-3 dropped → excess ${fmt(tr?.worstExcess)} (t=${fmt(tr?.worstT, 2)}); best-3 dropped → excess ${fmt(tr?.bestExcess)} (t=${fmt(tr?.bestT, 2)})`);
  const per = Math.ceil(all.length / 3);
  for (let i = 0; i < 3; i++) {
    const sl = all.slice(i * per, (i + 1) * per);
    if (!sl.length) continue;
    const set = new Set(sl);
    const s = sliceStats(trades, set);
    const t2 = trimStats(trades, set, s.uMean, se([...s.uCM.values()]));
    console.log(`    block ${i + 1}: excess ${fmt(s.excess)} (t=${fmt(s.t, 2)}) | worst-3 → ${fmt(t2?.worstExcess)} | best-3 → ${fmt(t2?.bestExcess)}`);
  }
}

console.log("\n" + "=".repeat(120));
console.log("[add] DONE");
console.log("=".repeat(120));
