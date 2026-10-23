#!/usr/bin/env node
/**
 * THE STUDY'S OWN ANALYZER, REPLICA — the validation harness.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 *
 * Two independent re-implementations of the geometry study produced
 * OPPOSITE pooled excesses on the same data (one negative, one positive).
 * When two implementations disagree, the only honest move is to run the
 * ORIGINAL logic and see which one reproduces it.
 *
 * So this file is `analyze-geometry.mjs` with ONE difference: it never
 * touches the network. The bar cache is pre-seeded from a sealed snapshot
 * and any pair that is not covered is treated as "no bars" — which is
 * exactly what the original does when a fetch fails, and it keeps the
 * run hermetic and reproducible.
 *
 * Everything else — the arms, the tie handling, the time exit, the
 * cluster statistics, the trim test, the regime decomposition — is the
 * study's own code, copied.
 *
 * It reads:
 *   ~/.hermes/cache/scratch/regime-excess-snap.ndjson   (sealed rows)
 *   ~/.hermes/cache/scratch/regime-excess-geometry-bars.json (sealed bars)
 * and writes NOTHING.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const HOME = homedir();
const IN = join(HOME, ".hermes/cache/scratch/regime-excess-snap.ndjson");
// The FULL bar cache: all 43 collector symbols, 15-minute bars. The
// earlier partial cache covered only 11 pairs, which silently shrank
// BOTH arms and changed the excess.
const CACHE_FILE = join(HOME, ".hermes/cache/scratch/regime-excess-fullbars.json");

/** The taker round trip, in %, charged on the notional. */
const TAKER_RT = 0.12;
const BAR_MIN = 15;
const MAX_HOLD_BARS = 16; // 4 hours at 15-minute bars
const BUCKET_MS = 5 * 60_000;

const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR cap .5, SL=1.34xATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5  SL 1.2", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8  SL 1.2", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0  SL 1.2", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2  SL 1.2", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2  SL 0.8", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5  SL 1.0", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0  SL 1.2", tp: 2.0, sl: 1.2 },
];

// ── the venue (DISABLED — the run is hermetic) ──
const CACHE = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

/** The bars for one pair, from the sealed cache only. */
function barsFor(pair) {
  const cached = CACHE[pair] ?? [];
  return cached;
}

// ── the statistics (the study's own) ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};

function outcome(bars, ts, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > ts) { start = i; break; }
  }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + MAX_HOLD_BARS);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return "loss";
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

function clusterStats(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const clusterMeans = [...byBucket.values()].map((a) => mean(a));
  return { clusters: clusterMeans.length, clusterMeans, mean: mean(clusterMeans), se: se(clusterMeans) };
}

function main() {
  if (!existsSync(IN)) {
    console.error(`[replica] no snapshot at ${IN}`);
    process.exitCode = 1;
    return;
  }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // The CONTROL arm: the tape and the models AGREE.
  const control = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const modelSide = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    if (!modelSide) continue;
    if (tapeSide !== modelSide) continue;
    control.push({ ...r, dir: tapeSide });
  }
  console.log(`[replica] ${rows.length} observations, ${control.length} on the machine's own signal (tape + models agree)`);

  const EQUITY = 57.2287;
  const NOTIONAL = 60.0;
  const notionalOverEquity = NOTIONAL / EQUITY;

  // The unconditional baseline: EVERY observation where the tape pointed
  // somewhere, taking the tape's direction.
  const unconditional = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    unconditional.push({ ...r, dir: tapeSide });
  }
  console.log(`[replica] the unconditional baseline: ${unconditional.length} observations`);

  const simulate = (set, g) => {
    const wins = [], losses = [];
    let unresolved = 0, ambiguous = 0, missingAtr = 0;
    const timeExits = [], timeExitMarks = [];
    const winBuckets = [], lossBuckets = [], timeExitBuckets = [];
    for (const c of set) {
      const bars = barsFor(c.pair);
      if (!bars?.length) { unresolved++; continue; }
      let idx = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t <= c.ts) idx = i;
        else break;
      }
      if (idx < 0) { unresolved++; continue; }
      const entry = bars[idx].c;
      const atrPct = Number(c.tapeAtrPct ?? c.tape?.atrPct ?? NaN);
      const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
      const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
      if (g.shipped) {
        if (!Number.isFinite(atrPct) || atrPct <= 0) { missingAtr++; unresolved++; continue; }
      }
      if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
      const long = c.dir === "long";
      const o = outcome(bars, c.ts, entry, tpPct, slPct, long);
      if (o === null) { unresolved++; continue; }
      const bucket = Math.floor(c.ts / BUCKET_MS);
      if (typeof o === "object") {
        timeExits.push((o.movePct - TAKER_RT) * notionalOverEquity);
        timeExitMarks.push(o.movePct);
        timeExitBuckets.push(bucket);
        continue;
      }
      if (o === "loss") {
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
      (o === "win" ? wins : losses).push(c);
      (o === "win" ? winBuckets : lossBuckets).push(bucket);
    }
    return { wins, losses, unresolved, ambiguous, missingAtr, timeExits, timeExitMarks, winBuckets, lossBuckets, timeExitBuckets };
  };

  console.log("\n  GEOMETRY                     n  win%  time%   break-even   EV/trade   uncond.EV   EXCESS      t  clus  verdict");
  console.log("  " + "-".repeat(112));
  const results = [];
  for (const g of GEOMETRIES) {
    const { wins, losses, unresolved, ambiguous, missingAtr, timeExits, timeExitMarks, winBuckets, lossBuckets, timeExitBuckets } = simulate(control, g);
    const n = wins.length + losses.length;
    if (n < 5) { console.log(`  ${g.name}: not enough resolved trades (${n})`); continue; }
    const winRate = wins.length / n;
    const perTrade = [
      ...wins.map(() => (g.tp ?? 0.4) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...losses.map(() => -(g.sl ?? 1.2) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...timeExits,
    ];
    const rBuckets = [...winBuckets, ...lossBuckets, ...timeExitBuckets];
    const ev = mean(perTrade);
    const evSe = se(perTrade);
    const evT = evSe > 0 ? ev / evSe : 0;
    const wbe = (g.sl ?? 1.2 + TAKER_RT) && ((g.sl ?? 1.2) + TAKER_RT) / ((g.tp ?? 0.4) + (g.sl ?? 1.2) + TAKER_RT);

    const U = simulate(unconditional, g);
    const uN = U.wins.length + U.losses.length;
    const uPerTrade = [
      ...U.wins.map(() => (g.tp ?? 0.4) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...U.losses.map(() => -(g.sl ?? 1.2) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...U.timeExits,
    ];
    const uBuckets = [...U.winBuckets, ...U.lossBuckets, ...U.timeExitBuckets];
    const uEv = uN + U.timeExits.length ? mean(uPerTrade) : 0;
    const excess = ev - uEv;
    const sCluster = clusterStats(perTrade, rBuckets);
    const uCluster = clusterStats(uPerTrade, uBuckets);
    const excessCluster = sCluster.mean - uCluster.mean;
    const excessClusterSe = Math.sqrt(sCluster.se ** 2 + uCluster.se ** 2);
    const excessT = excessClusterSe > 0 ? excessCluster / excessClusterSe : 0;
    results.push({ g, winRate, n, wbe, ev, evT, unresolved, ambiguous, missingAtr, timeExits: timeExits.length, meanTimeExit: mean(timeExitMarks), uEv, uN, uTimeExits: U.timeExits.length, uWinRate: uN ? U.wins.length / uN : 0, excess, excessT, sClusters: sCluster.clusters, uClusters: uCluster.clusters, perTrade });
  }
  for (const r of results) {
    const verdict = r.excess > 0 ? "EDGE" : "no edge";
    const name = r.g.name.padEnd(26);
    const timePct = r.n + r.timeExits > 0 ? (r.timeExits / (r.n + r.timeExits)) * 100 : 0;
    console.log(
      `  ${name} ${String(r.n).padStart(3)} ${(r.winRate * 100).toFixed(1).padStart(5)}% ${timePct.toFixed(0).padStart(5)}% ${(r.wbe * 100).toFixed(1).padStart(9)}%  ${(r.ev >= 0 ? "+" : "") + r.ev.toFixed(4)}% ${(r.uEv >= 0 ? "+" : "") + r.uEv.toFixed(4)}% ${(r.excess >= 0 ? "+" : "") + r.excess.toFixed(4)}% ${r.excessT.toFixed(2).padStart(6)} ${String(r.sClusters).padStart(4)}  ${verdict}`,
    );
  }
  console.log();
  for (const r of results) {
    console.log(
      `  ${r.g.name}: ${r.n} resolved at a level, ${r.timeExits} closed at the ${MAX_HOLD_BARS * BAR_MIN}min time exit (mean mark ${r.meanTimeExit >= 0 ? "+" : ""}${r.meanTimeExit.toFixed(3)}%), ${r.unresolved} unusable, ${r.ambiguous} ambiguous`,
    );
  }
  const positive = results.filter((r) => r.excess > 0);
  console.log();
  if (positive.length === 0) {
    console.log("[replica] NO geometry has a positive EXCESS over the unconditional baseline.");
  } else {
    console.log(`[replica] ${positive.length} geometry/ies have a positive EXCESS:`);
    for (const r of positive) console.log(`  ${r.g.name}: EXCESS ${r.excess >= 0 ? "+" : ""}${r.excess.toFixed(4)}% of equity per trade (t=${r.excessT.toFixed(2)}), win ${(r.winRate * 100).toFixed(1)}%, ${r.timeExits} time exits`);
  }
}

main();
