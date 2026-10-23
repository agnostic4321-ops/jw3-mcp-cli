#!/usr/bin/env node
/**
 * THE GEOMETRY STRESS TEST — is the geometry candidate a stable pattern,
 * a window effect, or nothing?
 *
 * ── THE ARM DEFINITIONS, RESOLVED ──
 *
 * Two different "control arms" exist in this repo and they are NOT the
 * same, which changes every number downstream:
 *
 *   PUBLISHED-STUDY ARM  (analyze-geometry.mjs): the model side is
 *     jev, or laya, or (if both are present) jev when the two agree.
 *     A SINGLE model read is enough to arm the signal. On this sample
 *     that is 110 rows in 31 buckets.
 *
 *   LIVE-GATE ARM  (the machine's real signal): BOTH the JEV and the Laya
 *     read must be present, they must agree, and neither may be
 *     uncertain — the `confluenceGate` in src/commands/live-cmd.ts:
 *       "A single-model read is a watch, not a trigger"
 *     On this sample that is 11 rows in 9 buckets.
 *
 * The published study measures the WIDER arm, which is not the arm the
 * live path trades. Both are reported here, because the question is
 * whether the GEOMETRY carries the result, and that has to be answered
 * for the arm that actually trades.
 *
 * ── THE FOUR ATTACKS ──
 *
 *   1. OUT-OF-SAMPLE: the sample split chronologically into 3
 *      consecutive blocks; the excess is measured inside each block
 *      against the baseline restricted to the SAME window.
 *   2. PLACEBO: a family of the SAME SHAPE with the information
 *      destroyed — (a) random model-agreement with the real model-side
 *      marginal, (b) the model side LAGGED by one bucket. The real
 *      excess is placed in the placebo's distribution.
 *   3. TRIM: the signal arm's worst 3 and best 3 trades dropped, then
 *      the worst 5 and best 5, and the excess re-measured.
 *   4. PER-SYMBOL: each symbol's own excess, the largest contributor
 *      flagged, and the leave-one-symbol-out excess.
 *
 * ── CENSORING ──
 *
 * A trade is only resolved if the forward bars reach the hold horizon.
 * The published study books a trade whose forward window ended early as
 * a "time exit" at that mark, which on a sample whose bar cache ends
 * before the sample does means the time-exit bucket is a mixture of
 * incomparable holds whose P&L depends on WHEN the observation happened.
 *
 *   --censor publish  the published behaviour (partial holds booked)
 *   --censor strict   only trades with a COMPLETE forward window are
 *                     kept, in both arms equally
 *
 * USAGE
 *   node stress-geometry-test.mjs --arm live --censor strict
 *   node stress-geometry-test.mjs --arm published --censor publish
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN_DEFAULT = join(SCRATCH, "stress-geometry-snap.ndjson");
const CACHE_DEFAULT = join(SCRATCH, "stress-geometry-bars2.json");

const TAKER_RT = 0.12;
const BAR_MIN = 15;
const BUCKET_MS = 5 * 60_000;
const EQUITY = 57.2287;
const NOTIONAL = 60.0;
const NEX = NOTIONAL / EQUITY;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const numFlag = (name, dflt) => {
  const v = flag(name, null);
  return v == null ? dflt : Number(v);
};

const HOLD_BARS = numFlag("hold-bars", 16);
const CENSOR = String(flag("censor", "strict"));
const ARM = String(flag("arm", "live"));
const PLACEBO_DRAWS = numFlag("placebo-draws", 600);
const SEED = numFlag("seed", 20261021);
const MAX_ROWS = numFlag("max-rows", 0); // 0 = all
const IN = String(flag("in", IN_DEFAULT));
const CACHE = String(flag("cache", CACHE_DEFAULT));
/**
 * When set, BOTH arms are restricted to the time range over which EVERY
 * observation has a COMPLETE forward window for the hold horizon, and the
 * 3-block split is taken over that restricted range.
 *
 * WHY: the bar cache ends before the sample does, so a late observation
 * has NO forward data at all and a late trade has only a partial hold.
 * Splitting the full sample then puts the last block entirely inside the
 * unevaluable tail, and the split cannot discriminate. Restricting both
 * arms to the evaluable range first is the only way to compare blocks on
 * the same basis.
 */
const COMPLETE_RANGE = !!flag("complete-range", false);

const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR cap .5, SL=1.34xATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2%  SL 0.8%", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

// ── statistics ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const clusterStats = (values, buckets) => {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const means = [...byBucket.values()].map((a) => mean(a));
  return { clusters: means.length, means, mean: mean(means), se: se(means) };
};
const excessOf = (s, u) => {
  if (!s.means.length || !u.means.length) return { excess: 0, t: 0, se: 0, sClusters: 0, uClusters: 0 };
  const d = Math.sqrt(s.se ** 2 + u.se ** 2);
  const excess = s.mean - u.mean;
  return { excess, t: d > 0 ? excess / d : 0, se: d, sClusters: s.clusters, uClusters: u.clusters };
};
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/** The model's side, under each arm's definition. */
const publishedModelSide = (r) => {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (jev && laya) return jev === laya ? jev : null;
  return jev || laya;
};
/** The LIVE gate: BOTH legs present, agreeing, neither uncertain. */
const liveModelSide = (r) => {
  const jev = r.jevSide;
  const laya = r.layaSide;
  if (!jev || !laya) return null;
  if (jev === "flat" || laya === "flat") return null;
  if (jev !== laya) return null;
  if (r.jevUncertain) return null;
  return jev;
};
const modelSideOf = ARM === "published" ? publishedModelSide : liveModelSide;

function outcome(bars, ts, entry, tpPct, slPct, long, holdBars) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i].t > ts) { start = i; break; }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + holdBars);
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
  return { kind: "time", movePct: move * 100, censored: end - start < holdBars, heldBars: end - start };
}

function main() {
  if (!existsSync(IN)) { console.error(`[stress] no ${IN}`); process.exitCode = 1; return; }
  if (!existsSync(CACHE)) { console.error(`[stress] no bar cache at ${CACHE}`); process.exitCode = 1; return; }
  const bars = JSON.parse(readFileSync(CACHE, "utf8"));
  let rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (MAX_ROWS) rows = rows.slice(-MAX_ROWS);

  // The tape arm: every observation where the tape points somewhere.
  const tape = [];
  for (const r of rows) {
    const side = tapeSideFromRow(r);
    if (!side) continue;
    tape.push({ ...r, dir: side });
  }
  // The signal arm: the tape and the models agree.
  const signal = tape.filter((t) => {
    const ms = modelSideOf(t);
    return ms && ms === t.dir;
  });

  const spanLo = minBy(tape, (t) => t.ts);
  const spanHi = maxBy(tape, (t) => t.ts);

  /**
   * EVALUABILITY, PER OBSERVATION.
   *
   * An observation is EVALUABLE if its own symbol's bar series reaches
   * HOLD_BARS bars past its entry bar. An unevaluable observation is
   * dropped from BOTH arms, and so is every trade it would have produced
   * — including the ones that happened to resolve (a trade that hit its
   * target inside a truncated window is still a trade whose COUNTERPART
   * was dropped, which is the selected-sample trap).
   *
   * This is per observation, NOT a global time cut: the bar cache has a
   * different end for every symbol, so a global cut would be driven by
   * the symbol with the shortest history and would delete the whole tail
   * of the sample. Per-observation keeps the temporal spread, and the
   * drop rule is identical in both arms.
   */
  const isEvaluable = (t) => {
    const b = bars[t.pair];
    if (!b?.length) return false;
    let idx = -1;
    for (let i = 0; i < b.length; i++) { if (b[i].t <= t.ts) idx = i; else break; }
    if (idx < 0) return false;
    return idx + HOLD_BARS < b.length;
  };
  const tapeAll = tape;
  const tapeIn = COMPLETE_RANGE ? tape.filter(isEvaluable) : tape;
  const signalAll = signal;
  const signalIn = COMPLETE_RANGE ? signal.filter(isEvaluable) : signal;
  if (COMPLETE_RANGE) {
    console.log(`[stress] COMPLETE-RANGE mode (per observation): tape arm ${tapeAll.length} -> ${tapeIn.length} rows; signal arm ${signalAll.length} -> ${signalIn.length} rows`);
  }

  console.log("[stress] =================================================================");
  console.log(`[stress] ARM=${ARM}  hold=${HOLD_BARS} bars (${HOLD_BARS * BAR_MIN}min)  censor=${CENSOR}  placebo draws=${PLACEBO_DRAWS}  seed=${SEED}`);
  console.log(`[stress] rows=${rows.length}  tape arm=${tape.length} rows / ${new Set(tape.map((t) => Math.floor(t.ts / BUCKET_MS))).size} five-min buckets / ${new Set(tape.map((t) => t.pair)).size} symbols`);
  console.log(`[stress] SIGNAL arm (${ARM} gate) = ${signal.length} rows / ${new Set(signal.map((t) => Math.floor(t.ts / BUCKET_MS))).size} five-min buckets / ${new Set(signal.map((t) => t.pair)).size} symbols`);
  console.log(`[stress]   sides: ${JSON.stringify(signal.reduce((a, t) => ((a[t.dir] = (a[t.dir] || 0) + 1), a), {}))}`);
  console.log(`[stress]   per symbol: ${[...new Set(signal.map((t) => t.pair))].map((p) => `${p}=${signal.filter((t) => t.pair === p).length}`).join("  ")}`);
  console.log(`[stress]   span: ${new Date(spanLo).toISOString()} -> ${new Date(spanHi).toISOString()}  (${((spanHi - spanLo) / 3600_000).toFixed(2)}h of wall clock)`);
  const sSpan = signal.length ? (maxBy(signal, (t) => t.ts) - minBy(signal, (t) => t.ts)) / 3600_000 : 0;
  console.log(`[stress]   the SIGNAL arm's own span: ${sSpan.toFixed(2)}h`);
  console.log("[stress] =================================================================");
  console.log();

  // The build: one geometry over one set of observations.
  const build = (set, g) => {
    const trades = [];
    let unresolved = 0, ambiguous = 0, missingAtr = 0, censored = 0, partialHold = 0, noBars = 0;
    for (const c of set) {
      const b = bars[c.pair];
      if (!b?.length) { noBars++; unresolved++; continue; }
      let idx = -1;
      for (let i = 0; i < b.length; i++) { if (b[i].t <= c.ts) idx = i; else break; }
      if (idx < 0) { unresolved++; continue; }
      const entry = b[idx].c;
      const atrPct = Number(c.tapeAtrPct ?? c.tape?.atrPct ?? NaN);
      const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
      const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
      if (g.shipped && !(Number.isFinite(atrPct) && atrPct > 0)) { missingAtr++; unresolved++; continue; }
      if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
      const long = c.dir === "long";
      const o = outcome(b, c.ts, entry, tpPct, slPct, long, HOLD_BARS);
      if (o === null) { unresolved++; continue; }
      if (o.kind === "time" && o.censored) {
        if (CENSOR === "strict") { censored++; continue; }
        partialHold++;
      }
      if (o.kind === "loss" && o.ambiguous) ambiguous++;
      let pnl;
      if (o.kind === "win") pnl = (tpPct - TAKER_RT) * NEX;
      else if (o.kind === "loss") pnl = (-slPct - TAKER_RT) * NEX;
      else pnl = (o.movePct - TAKER_RT) * NEX;
      trades.push({ pair: c.pair, ts: c.ts, dir: c.dir, bucket: Math.floor(c.ts / BUCKET_MS), kind: o.kind, pnl });
    }
    return { trades, unresolved, ambiguous, missingAtr, censored, partialHold, noBars };
  };
  const statsOf = (trades) => clusterStats(trades.map((t) => t.pnl), trades.map((t) => t.bucket));

  // The model-side marginal, for the random placebo.
  const marg = { long: 0, short: 0, null: 0 };
  for (const r of rows) { const s = modelSideOf(r); marg[s ?? "null"]++; }
  const margTotal = marg.long + marg.short + marg.null;
  // The lagged model side: the previous bucket's model side for the same pair.
  const lagMap = new Map();
  {
    const byPair = new Map();
    for (const r of rows) { const a = byPair.get(r.pair) ?? []; a.push(r); byPair.set(r.pair, a); }
    for (const a of byPair.values()) {
      a.sort((x, y) => x.ts - y.ts);
      for (let i = 1; i < a.length; i++) lagMap.set(`${a[i].pair}@${a[i].ts}`, modelSideOf(a[i - 1]));
    }
  }

  for (const g of GEOMETRIES) {
    const S = build(signalIn, g);
    const U = build(tapeIn, g);
    const sS = statsOf(S.trades), uS = statsOf(U.trades);
    const ex = excessOf(sS, uS);
    const kinds = (a) => `w=${a.filter((t) => t.kind === "win").length} l=${a.filter((t) => t.kind === "loss").length} t=${a.filter((t) => t.kind === "time").length}`;

    console.log("=".repeat(96));
    console.log(`GEOMETRY: ${g.name}`);
    console.log(`  signal arm : ${S.trades.length} trades | ${kinds(S.trades)} | unresolved ${S.unresolved} (noBars ${S.noBars}) | censored ${S.censored} | partial-hold booked ${S.partialHold} | ambiguous ${S.ambiguous}`);
    console.log(`  baseline   : ${U.trades.length} trades | ${kinds(U.trades)} | unresolved ${U.unresolved} (noBars ${U.noBars}) | censored ${U.censored} | partial-hold booked ${U.partialHold} | ambiguous ${U.ambiguous}`);
    console.log(`  EV/trade   : signal ${sS.mean >= 0 ? "+" : ""}${sS.mean.toFixed(4)}%   baseline ${uS.mean >= 0 ? "+" : ""}${uS.mean.toFixed(4)}%`);
    console.log(`  EXCESS     : ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)}pp of equity per trade   t=${ex.t.toFixed(2)}   clusters: signal ${sS.clusters} / baseline ${uS.clusters}`);
    console.log();

    // ── 1. OUT-OF-SAMPLE ──
    console.log(`  [1] OUT-OF-SAMPLE — chronological thirds, baseline restricted to the SAME window`);
    if (S.trades.length) {
      // The split is over the EVALUABLE range of the TAPE arm (the
      // baseline's span), not the signal arm's own span. The signal arm
      // is front-loaded by the collector, so splitting on its span
      // would push the last two blocks into the sample's tail and
      // manufacture empty blocks.
      const spanT = tapeIn.map((t) => t.ts);
      const lo = minOf(spanT);
      const hi = maxOf(spanT);
      const w = (hi - lo) / 3;
      const blocks = [
        { n: "BLOCK 1", a: lo, b: lo + w },
        { n: "BLOCK 2", a: lo + w, b: lo + 2 * w },
        { n: "BLOCK 3", a: lo + 2 * w, b: hi + 1 },
      ];
      for (const bl of blocks) {
        const cs = S.trades.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
        const us = U.trades.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
        const cS = statsOf(cs), uS2 = statsOf(us);
        const e = excessOf(cS, uS2);
        const iso = (t) => new Date(t).toISOString().slice(11, 16);
        console.log(`    ${bl.n} ${iso(bl.a)}-${iso(bl.b)}: signal n=${String(cs.length).padStart(3)} (${cS.clusters} clusters) EV ${cS.mean >= 0 ? "+" : ""}${cS.mean.toFixed(4)}%  |  baseline n=${String(us.length).padStart(3)} (${uS2.clusters} clusters) EV ${uS2.mean >= 0 ? "+" : ""}${uS2.mean.toFixed(4)}%  |  EXCESS ${e.excess >= 0 ? "+" : ""}${e.excess.toFixed(4)}pp  t=${e.t.toFixed(2)}`);
      }
      const nz = blocks.map((bl) => {
        const cs = S.trades.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
        return cs.length;
      });
      console.log(`    signal-arm rows per block: ${nz.join(" / ")}  (a block with 1-2 rows cannot discriminate — treat it as NO DATA, not as a result)`);
    } else {
      console.log(`    no signal-arm trades: the split cannot be run.`);
    }
    console.log();

    // ── 2. PLACEBO ──
    console.log(`  [2] PLACEBO FAMILY — same shape, information destroyed`);
    const rand = mulberry32(SEED);
    const pEx = [], pT = [], pN = [];
    for (let d = 0; d < PLACEBO_DRAWS; d++) {
      const arm = [];
      for (const t of tapeIn) {
        const u = rand();
        const ms = u < marg.long / margTotal ? "long" : u < (marg.long + marg.short) / margTotal ? "short" : null;
        if (ms && ms === t.dir) arm.push(t);
      }
      const pa = build(arm, g);
      const pS = statsOf(pa.trades);
      const e = excessOf(pS, uS);
      pEx.push(e.excess); pT.push(e.t); pN.push(pa.trades.length);
    }
    const lagArm = tapeIn.filter((t) => { const l = lagMap.get(`${t.pair}@${t.ts}`); return l && l === t.dir; });
    const la = build(lagArm, g);
    const lS = statsOf(la.trades);
    const lagEx = excessOf(lS, uS);
    const exSorted = [...pEx].sort((a, b) => a - b);
    const tSorted = [...pT].sort((a, b) => a - b);
    const ge = pEx.filter((x) => x >= ex.excess).length;
    const tge = pT.filter((x) => x >= ex.t).length;
    console.log(`    random model-agreement: ${PLACEBO_DRAWS} draws, placebo arm n median ${pct([...pN].sort((a, b) => a - b), 0.5)} (real signal arm n=${S.trades.length})`);
    console.log(`      excess distribution: median ${pct(exSorted, 0.5) >= 0 ? "+" : ""}${pct(exSorted, 0.5).toFixed(4)}pp | mean ${mean(pEx) >= 0 ? "+" : ""}${mean(pEx).toFixed(4)}pp | sd ${(Math.sqrt(pEx.reduce((s, x) => s + (x - pMean2(pEx)) ** 2, 0) / Math.max(1, pEx.length - 1))).toFixed(4)} | p05 ${pct(exSorted, 0.05) >= 0 ? "+" : ""}${pct(exSorted, 0.05).toFixed(4)} | p95 ${pct(exSorted, 0.95) >= 0 ? "+" : ""}${pct(exSorted, 0.95).toFixed(4)}`);
    console.log(`      THE REAL EXCESS ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)}pp  ->  ${ge}/${PLACEBO_DRAWS} placebo draws reach or exceed it  (${(100 * ge / PLACEBO_DRAWS).toFixed(1)}th percentile)  ${ge <= PLACEBO_DRAWS * 0.05 ? "BEATS THE PLACEBO" : "DOES NOT BEAT THE PLACEBO"}`);
    console.log(`      t: real ${ex.t.toFixed(2)} vs placebo p95 ${pct(tSorted, 0.95).toFixed(2)}; ${tge}/${PLACEBO_DRAWS} placebo draws reach or exceed the real t`);
    console.log(`    lagged gate (the model side from the PREVIOUS bucket): arm n=${lagArm.length}, EXCESS ${lagEx.excess >= 0 ? "+" : ""}${lagEx.excess.toFixed(4)}pp  t=${lagEx.t.toFixed(2)}  clusters ${lagEx.sClusters}`);
    console.log();

    // ── 3. TRIM ──
    console.log(`  [3] TRIM TEST — the signal arm's extremes dropped, excess re-measured against the same baseline`);
    for (const k of [3, 5]) {
      if (S.trades.length < k + 2) { console.log(`    (only ${S.trades.length} signal trades — cannot trim ${k} and keep a cluster)`); continue; }
      const sorted = [...S.trades].sort((a, b) => a.pnl - b.pnl);
      const dropWorst = sorted.slice(k);
      const dropBest = sorted.slice(0, sorted.length - k);
      const wS = statsOf(dropWorst), bS = statsOf(dropBest);
      const ew = excessOf(wS, uS), eb = excessOf(bS, uS);
      console.log(`    worst ${k} dropped: n=${dropWorst.length} (${wS.clusters} cl) EV ${wS.mean >= 0 ? "+" : ""}${wS.mean.toFixed(4)}%  EXCESS ${ew.excess >= 0 ? "+" : ""}${ew.excess.toFixed(4)}pp  t=${ew.t.toFixed(2)}  ${ew.excess > 0 ? "survives" : "COLLAPSES"}`);
      console.log(`    best  ${k} dropped: n=${dropBest.length} (${bS.clusters} cl) EV ${bS.mean >= 0 ? "+" : ""}${bS.mean.toFixed(4)}%  EXCESS ${eb.excess >= 0 ? "+" : ""}${eb.excess.toFixed(4)}pp  t=${eb.t.toFixed(2)}  ${eb.excess > 0 ? "survives" : "COLLAPSES"}`);
    }
    console.log();

    // ── 4. PER-SYMBOL ──
    console.log(`  [4] PER-SYMBOL — each symbol's own excess, and the leave-one-symbol-out excess`);
    const syms = [...new Set(S.trades.map((t) => t.pair))].sort();
    const symRows = [];
    for (const p of syms) {
      const cs = S.trades.filter((t) => t.pair === p);
      const us = U.trades.filter((t) => t.pair === p);
      if (!cs.length || !us.length) continue;
      const cS = statsOf(cs), uS2 = statsOf(us);
      const e = excessOf(cS, uS2);
      const cs2 = S.trades.filter((t) => t.pair !== p);
      const us2 = U.trades.filter((t) => t.pair !== p);
      const e2 = excessOf(statsOf(cs2), statsOf(us2));
      symRows.push({ p, n: cs.length, un: us.length, ev: cS.mean, uev: uS2.mean, excess: e.excess, t: e.t, clusters: cS.clusters, loo: e2.excess, loot: e2.t, kinds: kinds(cs) });
    }
    symRows.sort((a, b) => b.excess - a.excess);
    console.log(`    ${"symbol".padEnd(15)} ${"n".padStart(3)} ${"clu".padStart(4)} ${"EV%".padStart(9)} ${"uncondEV%".padStart(10)} ${"EXCESS".padStart(9)} ${"t".padStart(6)} ${"LOO-EXC".padStart(9)} ${"LOO-t".padStart(6)}  mix`);
    for (const s of symRows) {
      console.log(`    ${s.p.padEnd(15)} ${String(s.n).padStart(3)} ${String(s.clusters).padStart(4)} ${(s.ev >= 0 ? "+" : "") + s.ev.toFixed(4)} ${(s.uev >= 0 ? "+" : "") + s.uev.toFixed(4)} ${(s.excess >= 0 ? "+" : "") + s.excess.toFixed(4)} ${s.t.toFixed(2).padStart(6)} ${(s.loo >= 0 ? "+" : "") + s.loo.toFixed(4)} ${s.loot.toFixed(2).padStart(6)}  ${s.kinds}`);
    }
    if (symRows.length) {
      const top = symRows[0];
      console.log(`    LARGEST CONTRIBUTOR: ${top.p} (n=${top.n}, ${top.clusters} clusters, own excess ${top.excess >= 0 ? "+" : ""}${top.excess.toFixed(4)}pp)`);
      console.log(`    LEAVE-IT-OUT: without ${top.p} the excess is ${top.loo >= 0 ? "+" : ""}${top.loo.toFixed(4)}pp (t=${top.loot.toFixed(2)})  ${top.loo <= 0 ? ">>> THE EXCESS WAS THAT SYMBOL" : "the excess survives without it"}`);
    }
    console.log();
  }
}
const pMean2 = (a) => mean(a);

main();
