#!/usr/bin/env node
/**
 * THE GEOMETRY STRESS TEST — PLACEBO FAMILY AND OUT-OF-SAMPLE, in one place.
 *
 * This is the decisive instrument for the geometry candidate. It answers
 * the question the published study cannot: is the +0.054% to +0.098%
 * EXCESS a property of the model-agreement gate, or is it what ANY gate
 * of the same shape produces on this sample?
 *
 * ── THE PLACEBO FAMILY (three kinds, increasing in severity) ──
 *
 *   (A) RANDOM MODEL-AGREEMENT. The model side is replaced by a random
 *       draw from the real model-side marginal. The timestamps, the
 *       symbols, the prices, the geometry and the ticket outcomes are
 *       all REAL; only the information is destroyed. This is the direct
 *       null: "what excess does a gate that knows nothing produce?"
 *
 *   (B) SIZE-MATCHED, SYMBOL-PRESERVING SHUFFLE. The placebo arm has
 *       EXACTLY the same number of rows as the real signal arm, drawn
 *       from the tape arm with the SAME per-symbol counts, and the
 *       chosen rows are spread across the sample's own time span. This
 *       removes the arm-SIZE confound: a placebo that happens to pick
 *       more rows than the signal arm has a different baseline, and
 *       the excess is not a like-for-like comparison.
 *
 *   (C) LAGGED GATE. The model side from the PREVIOUS bucket. The real
 *       model information is present but STALE. A gate whose excess
 *       survives a one-bucket lag is not reading the models.
 *
 * ── THE OUT-OF-SAMPLE SPLIT ──
 *
 * The sample is split chronologically into 3 consecutive blocks and the
 * excess is measured inside each block against the baseline restricted
 * to the SAME window. A pattern positive in only 1 of 3 blocks is a
 * window.
 *
 * The block split is also run on the CENSORING-FREE raw forward return
 * (the mean signed forward P&L of the short side), because the ticket
 * simulation is censored by the bar cache's end: a late trade has a
 * partial hold, and its booked P&L is a function of WHEN it happened.
 * The raw forward return needs only ONE bar after the observation, so it
 * is available for the whole sample and cannot be a censoring artefact.
 *
 * USAGE
 *   node stress-geometry-placebo.mjs --hold-bars 16 --placebo-draws 1000
 *   node stress-geometry-placebo.mjs --hold-bars 4  --arm live
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const IN = join(SCRATCH, "stress-geometry-snap.ndjson");
const CACHE = join(SCRATCH, "stress-geometry-bars2.json");

const TAKER_RT = 0.12;
const BAR_MIN = 15;
const BUCKET_MS = 5 * 60_000;
const NEX = 60.0 / 57.2287;

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
const ARM = String(flag("arm", "published"));
const DRAWS = numFlag("placebo-draws", 1000);
const SEED = numFlag("seed", 20261021);
const CENSOR = String(flag("censor", "publish"));

const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR cap .5, SL=1.34xATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

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
  return { clusters: means.length, mean: mean(means), se: se(means) };
};
const excessOf = (s, u) => {
  const d = Math.sqrt(s.se ** 2 + u.se ** 2);
  const excess = s.mean - u.mean;
  return { excess, t: d > 0 ? excess / d : 0, se: d };
};
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pctOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

const publishedModelSide = (r) => {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (jev && laya) return jev === laya ? jev : null;
  return jev || laya;
};
const liveModelSide = (r) => {
  const jev = r.jevSide, laya = r.layaSide;
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
    if (hitTp && hitSl) return { kind: "loss" };
    if (hitTp) return { kind: "win" };
    if (hitSl) return { kind: "loss" };
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100, censored: end - start < holdBars };
}

function main() {
  if (!existsSync(IN) || !existsSync(CACHE)) { console.error("[placebo] missing input or cache"); process.exitCode = 1; return; }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(CACHE, "utf8"));
  const tape = [];
  for (const r of rows) {
    const side = tapeSideFromRow(r);
    if (!side) continue;
    tape.push({ ...r, dir: side });
  }
  const signal = tape.filter((t) => { const m = modelSideOf(t); return m && m === t.dir; });

  console.log("[placebo] =================================================================");
  console.log(`[placebo] ARM=${ARM} hold=${HOLD_BARS} bars (${HOLD_BARS * BAR_MIN}min) censor=${CENSOR} draws=${DRAWS} seed=${SEED}`);
  console.log(`[placebo] tape arm ${tape.length} rows / ${new Set(tape.map((t) => Math.floor(t.ts / BUCKET_MS))).size} clusters; SIGNAL arm ${signal.length} rows / ${new Set(signal.map((t) => Math.floor(t.ts / BUCKET_MS))).size} clusters; all SHORT=${signal.every((t) => t.dir === "short")}`);
  console.log("[placebo] =================================================================");

  const build = (set, g) => {
    const trades = [];
    for (const c of set) {
      const b = bars[c.pair];
      if (!b?.length) continue;
      let idx = -1;
      for (let i = 0; i < b.length; i++) { if (b[i].t <= c.ts) idx = i; else break; }
      if (idx < 0) continue;
      const entry = b[idx].c;
      const atrPct = Number(c.tapeAtrPct ?? NaN);
      const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
      const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
      if (g.shipped && !(Number.isFinite(atrPct) && atrPct > 0)) continue;
      if (!(tpPct > 0) || !(slPct > 0)) continue;
      const o = outcome(b, c.ts, entry, tpPct, slPct, c.dir === "long", HOLD_BARS);
      if (!o) continue;
      if (o.kind === "time" && o.censored && CENSOR === "strict") continue;
      const pnl = o.kind === "win" ? (tpPct - TAKER_RT) * NEX
        : o.kind === "loss" ? (-slPct - TAKER_RT) * NEX
        : (o.movePct - TAKER_RT) * NEX;
      trades.push({ pair: c.pair, ts: c.ts, bucket: Math.floor(c.ts / BUCKET_MS), pnl });
    }
    return trades;
  };
  const stats = (tr) => clusterStats(tr.map((t) => t.pnl), tr.map((t) => t.bucket));

  // The model-side marginal, for the random placebo.
  const marg = { long: 0, short: 0, null: 0 };
  for (const r of rows) { const s = modelSideOf(r); marg[s ?? "null"]++; }
  const mTotal = marg.long + marg.short + marg.null;
  // The lagged model side.
  const lagMap = new Map();
  {
    const byPair = new Map();
    for (const r of rows) { const a = byPair.get(r.pair) ?? []; a.push(r); byPair.set(r.pair, a); }
    for (const a of byPair.values()) {
      a.sort((x, y) => x.ts - y.ts);
      for (let i = 1; i < a.length; i++) lagMap.set(`${a[i].pair}@${a[i].ts}`, modelSideOf(a[i - 1]));
    }
  }
  // The signal arm's per-symbol counts, for the size-matched placebo.
  const symCount = new Map();
  for (const t of signal) symCount.set(t.pair, (symCount.get(t.pair) ?? 0) + 1);
  const tapeByPair = new Map();
  for (const t of tape) { const a = tapeByPair.get(t.pair) ?? []; a.push(t); tapeByPair.set(t.pair, a); }

  for (const g of GEOMETRIES) {
    const S = build(signal, g);
    const U = build(tape, g);
    const sS = stats(S), uS = stats(U);
    const ex = excessOf(sS, uS);
    console.log("=".repeat(104));
    console.log(`GEOMETRY: ${g.name}`);
    console.log(`  signal arm ${S.length} trades (${sS.clusters} clusters) EV ${sS.mean >= 0 ? "+" : ""}${sS.mean.toFixed(4)}%  |  baseline ${U.length} trades (${uS.clusters} clusters) EV ${uS.mean >= 0 ? "+" : ""}${uS.mean.toFixed(4)}%`);
    console.log(`  REAL EXCESS ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)}pp   t=${ex.t.toFixed(2)}`);

    // (A) random model-agreement
    const rand = mulberry32(SEED);
    const exA = [], tA = [], nA = [];
    for (let d = 0; d < DRAWS; d++) {
      const arm = tape.filter((t) => {
        const u = rand();
        const m = u < marg.long / mTotal ? "long" : u < (marg.long + marg.short) / mTotal ? "short" : null;
        return m && m === t.dir;
      });
      const a = build(arm, g);
      const e = excessOf(stats(a), uS);
      exA.push(e.excess); tA.push(e.t); nA.push(a.length);
    }
    const sA = [...exA].sort((a, b) => a - b);
    const stA = [...tA].sort((a, b) => a - b);
    const geA = exA.filter((x) => x >= ex.excess).length;
    const geT = tA.filter((x) => x >= ex.t).length;
    console.log(`  (A) RANDOM MODEL-AGREEMENT — ${DRAWS} draws, placebo arm n median ${pctOf([...nA].sort((a, b) => a - b), 0.5)}`);
    console.log(`      excess: median ${pctOf(sA, 0.5) >= 0 ? "+" : ""}${pctOf(sA, 0.5).toFixed(4)}pp  mean ${mean(exA) >= 0 ? "+" : ""}${mean(exA).toFixed(4)}pp  sd ${(Math.sqrt(exA.reduce((s, x) => s + (x - mean(exA)) ** 2, 0) / Math.max(1, exA.length - 1))).toFixed(4)}  p05 ${pctOf(sA, 0.05) >= 0 ? "+" : ""}${pctOf(sA, 0.05).toFixed(4)}  p95 ${pctOf(sA, 0.95) >= 0 ? "+" : ""}${pctOf(sA, 0.95).toFixed(4)}`);
    console.log(`      REAL ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)}pp -> ${geA}/${DRAWS} placebo draws reach it (${(100 * geA / DRAWS).toFixed(1)}th pct) ${geA <= DRAWS * 0.05 ? "BEATS" : "DOES NOT BEAT"} THE PLACEBO`);
    console.log(`      t: real ${ex.t.toFixed(2)} vs placebo p95 ${pctOf(stA, 0.95).toFixed(2)}; ${geT}/${DRAWS} placebo draws reach the real t`);

    // (B) size-matched, symbol-preserving placebo
    const exB = [], tB = [], nB = [];
    const randB = mulberry32(SEED + 1);
    for (let d = 0; d < DRAWS; d++) {
      const arm = [];
      for (const [p, k] of symCount) {
        const pool = tapeByPair.get(p) ?? [];
        if (!pool.length) continue;
        // spread the pick across the pool: sort by a random key, take the
        // first k, then restore the pool's own chronological order
        const shuffled = [...pool].sort(() => randB() - 0.5);
        const picked = shuffled.slice(0, k).sort((x, y) => x.ts - y.ts);
        arm.push(...picked);
      }
      const a = build(arm, g);
      const e = excessOf(stats(a), uS);
      exB.push(e.excess); tB.push(e.t); nB.push(a.length);
    }
    const sB = [...exB].sort((a, b) => a - b);
    const stB = [...tB].sort((a, b) => a - b);
    const geB = exB.filter((x) => x >= ex.excess).length;
    const geTB = tB.filter((x) => x >= ex.t).length;
    console.log(`  (B) SIZE-MATCHED + SYMBOL-PRESERVING — ${DRAWS} draws, placebo arm n median ${pctOf([...nB].sort((a, b) => a - b), 0.5)} (real ${S.length}), same per-symbol counts`);
    console.log(`      excess: median ${pctOf(sB, 0.5) >= 0 ? "+" : ""}${pctOf(sB, 0.5).toFixed(4)}pp  mean ${mean(exB) >= 0 ? "+" : ""}${mean(exB).toFixed(4)}pp  sd ${(Math.sqrt(exB.reduce((s, x) => s + (x - mean(exB)) ** 2, 0) / Math.max(1, exB.length - 1))).toFixed(4)}  p05 ${pctOf(sB, 0.05) >= 0 ? "+" : ""}${pctOf(sB, 0.05).toFixed(4)}  p95 ${pctOf(sB, 0.95) >= 0 ? "+" : ""}${pctOf(sB, 0.95).toFixed(4)}`);
    console.log(`      REAL ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)}pp -> ${geB}/${DRAWS} placebo draws reach it (${(100 * geB / DRAWS).toFixed(1)}th pct) ${geB <= DRAWS * 0.05 ? "BEATS" : "DOES NOT BEAT"} THE PLACEBO`);
    console.log(`      t: real ${ex.t.toFixed(2)} vs placebo p95 ${pctOf(stB, 0.95).toFixed(2)}; ${geTB}/${DRAWS} placebo draws reach the real t`);

    // (C) lagged gate
    const lagArm = tape.filter((t) => { const l = lagMap.get(`${t.pair}@${t.ts}`); return l && l === t.dir; });
    const la = build(lagArm, g);
    const lagEx = excessOf(stats(la), uS);
    console.log(`  (C) LAGGED GATE (model side from the PREVIOUS bucket): arm n=${lagArm.length} (${stats(la).clusters} clusters) EXCESS ${lagEx.excess >= 0 ? "+" : ""}${lagEx.excess.toFixed(4)}pp  t=${lagEx.t.toFixed(2)}  ${lagEx.excess >= ex.excess * 0.8 ? "*** NEARLY AS LARGE AS THE REAL EXCESS — the gate is reading TIMING, not the models ***" : "materially smaller than the real excess"}`);

    // The OUT-OF-SAMPLE split, on the ticket simulation AND on the
    // censoring-free raw forward return.
    const lo = minBy(tape, (t) => t.ts);
    const hi = maxBy(tape, (t) => t.ts);
    const w = (hi - lo) / 3;
    const blocks = [
      { n: "BLOCK 1", a: lo, b: lo + w },
      { n: "BLOCK 2", a: lo + w, b: lo + 2 * w },
      { n: "BLOCK 3", a: lo + 2 * w, b: hi + 1 },
    ];
    console.log(`  OUT-OF-SAMPLE (chronological thirds; the baseline restricted to the SAME window)`);
    for (const bl of blocks) {
      const cs = S.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
      const us = U.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
      if (cs.length < 3 || us.length < 3) { console.log(`    ${bl.n}: signal n=${cs.length} baseline n=${us.length} -> TOO FEW`); continue; }
      const e = excessOf(stats(cs), stats(us));
      console.log(`    ${bl.n}: signal n=${String(cs.length).padStart(3)} (${stats(cs).clusters} clusters)  baseline n=${String(us.length).padStart(3)} (${stats(us).clusters} clusters)  EXCESS ${e.excess >= 0 ? "+" : ""}${e.excess.toFixed(4)}pp  t=${e.t.toFixed(2)}`);
    }
    console.log();
  }
}
main();
