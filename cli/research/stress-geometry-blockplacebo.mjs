#!/usr/bin/env node
/**
 * THE PER-BLOCK PLACEBO — the last instrument.
 *
 * The size-matched placebo showed that a RANDOM subset of the tape arm,
 * with the same size and the same per-symbol counts as the real signal
 * arm, produces an excess of the same ORDER as the real one. That means
 * the published "excess" is at least partly a mechanical consequence of
 * the signal arm being a SUBSET of the baseline arm: comparing a subset
 * to its superset produces a difference that depends on the subset's
 * size and on the market's drift, not only on the information the gate
 * carries.
 *
 * So the excess must be measured against a placebo that shares the arm's
 * size AND the arm's time distribution. This script does that, PER
 * BLOCK: for each chronological third, the real block excess is compared
 * with the distribution of the same block's size-matched placebos.
 *
 * If the real block excess sits INSIDE the placebo distribution in every
 * block, the excess is a window effect and the gate adds nothing.
 * If the real block excess sits above the placebo in every block, the
 * gate is real.
 *
 * It also runs the LAGGED gate per block: a gate reading the model side
 * from the PREVIOUS bucket. A real edge cannot survive a one-bucket lag.
 *
 * USAGE
 *   node stress-geometry-blockplacebo.mjs --arm published --hold-bars 16
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
];

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clusterStats = (values, buckets) => {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const means = [...byBucket.values()].map((a) => mean(a));
  const n = means.length;
  const m = n ? mean(means) : 0;
  const v = n > 1 ? means.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) : 0;
  return { clusters: n, mean: m, se: n > 1 ? Math.sqrt(v / n) : 0 };
};
const excessOf = (s, u) => {
  const d = Math.sqrt(s.se ** 2 + u.se ** 2);
  const excess = s.mean - u.mean;
  return { excess, t: d > 0 ? excess / d : 0 };
};
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pctOf = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];

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
  if (!existsSync(IN) || !existsSync(CACHE)) { console.error("[blockplacebo] missing input"); process.exitCode = 1; return; }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(CACHE, "utf8"));
  const tape = [];
  for (const r of rows) {
    const side = tapeSideFromRow(r);
    if (!side) continue;
    tape.push({ ...r, dir: side });
  }
  const signal = tape.filter((t) => { const m = modelSideOf(t); return m && m === t.dir; });
  const lagMap = new Map();
  {
    const byPair = new Map();
    for (const r of rows) { const a = byPair.get(r.pair) ?? []; a.push(r); byPair.set(r.pair, a); }
    for (const a of byPair.values()) {
      a.sort((x, y) => x.ts - y.ts);
      for (let i = 1; i < a.length; i++) lagMap.set(`${a[i].pair}@${a[i].ts}`, modelSideOf(a[i - 1]));
    }
  }
  console.log("[blockplacebo] ARM=" + ARM + " hold=" + HOLD_BARS + " bars (" + HOLD_BARS * BAR_MIN + "min) censor=" + CENSOR + " draws=" + DRAWS);
  console.log("[blockplacebo] tape arm " + tape.length + " rows / " + new Set(tape.map((t) => Math.floor(t.ts / BUCKET_MS))).size + " clusters; SIGNAL " + signal.length + " rows / " + new Set(signal.map((t) => Math.floor(t.ts / BUCKET_MS))).size + " clusters");

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

  const lo = minBy(tape, (t) => t.ts);
  const hi = maxBy(tape, (t) => t.ts);
  const w = (hi - lo) / 3;
  const blocks = [
    { n: "BLOCK 1", a: lo, b: lo + w },
    { n: "BLOCK 2", a: lo + w, b: lo + 2 * w },
    { n: "BLOCK 3", a: lo + 2 * w, b: hi + 1 },
  ];

  for (const g of GEOMETRIES) {
    const S = build(signal, g);
    const U = build(tape, g);
    console.log("=".repeat(100));
    console.log("GEOMETRY: " + g.name);
    const lagArm = tape.filter((t) => { const l = lagMap.get(`${t.pair}@${t.ts}`); return l && l === t.dir; });
    const L = build(lagArm, g);

    for (const bl of blocks) {
      const cs = S.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
      const us = U.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
      const ls = L.filter((t) => t.ts >= bl.a && t.ts <= bl.b);
      if (cs.length < 3 || us.length < 3) {
        console.log(`  ${bl.n}: signal n=${cs.length} baseline n=${us.length} -> TOO FEW TO TEST`);
        continue;
      }
      const real = excessOf(stats(cs), stats(us));
      const lag = excessOf(stats(ls), stats(us));
      // the size-matched placebo for THIS block: the same per-symbol
      // counts as the signal arm, drawn from the block's tape OBSERVATIONS
      // (not from the already-built trades — a trade has no ATR and no
      // direction, so building a placebo from trades silently produces an
      // empty or wrong arm).
      const symCount = new Map();
      for (const t of signal) if (t.ts >= bl.a && t.ts <= bl.b) symCount.set(t.pair, (symCount.get(t.pair) ?? 0) + 1);
      const poolByPair = new Map();
      for (const t of tape) {
        if (t.ts < bl.a || t.ts > bl.b) continue;
        const arr = poolByPair.get(t.pair) ?? [];
        arr.push(t);
        poolByPair.set(t.pair, arr);
      }
      const rand = mulberry32(SEED + bl.n.charCodeAt(6));
      const pex = [];
      for (let d = 0; d < DRAWS; d++) {
        const arm = [];
        for (const [p, k] of symCount) {
          const pool = poolByPair.get(p) ?? [];
          if (!pool.length) continue;
          const sh = [...pool].sort(() => rand() - 0.5).slice(0, k).sort((x, y) => x.ts - y.ts);
          arm.push(...sh);
        }
        const a = build(arm, g);
        if (a.length < 3) continue;
        pex.push(excessOf(stats(a), stats(us)).excess);
      }
      if (!pex.length) { console.log(`     (no placebo arms could be built for this block)`); continue; }
      const s = pex.sort((a, b) => a - b);
      const ge = pex.filter((x) => x >= real.excess).length;
      const pct = (100 * ge / DRAWS);
      console.log(`  ${bl.n}: signal n=${cs.length} (${stats(cs).clusters} cl) | baseline n=${us.length} (${stats(us).clusters} cl)`);
      console.log(`     REAL EXCESS ${real.excess >= 0 ? "+" : ""}${real.excess.toFixed(4)}pp t=${real.t.toFixed(2)}`);
      console.log(`     size-matched PLACEBO (same n, same symbols, same window): median ${pctOf(s, 0.5) >= 0 ? "+" : ""}${pctOf(s, 0.5).toFixed(4)}pp  p05 ${pctOf(s, 0.05) >= 0 ? "+" : ""}${pctOf(s, 0.05).toFixed(4)}  p95 ${pctOf(s, 0.95) >= 0 ? "+" : ""}${pctOf(s, 0.95).toFixed(4)}`);
      console.log(`     -> ${ge}/${DRAWS} placebos reach it (${pct.toFixed(1)}th pct)  ${pct <= 5 ? "BEATS" : "DOES NOT BEAT"} the placebo`);
      console.log(`     LAGGED gate in the same block: EXCESS ${lag.excess >= 0 ? "+" : ""}${lag.excess.toFixed(4)}pp t=${lag.t.toFixed(2)}  ${lag.excess >= real.excess * 0.8 ? "*** NEARLY AS LARGE — the gate is not reading the models ***" : ""}`);
    }
    console.log();
  }
}
main();
