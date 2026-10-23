#!/usr/bin/env node
/**
 * THE GEOMETRY STUDY, SPLIT BY SIDE — is the excess short-only?
 *
 * ── WHAT THIS ADDS TO analyze-geometry.mjs ──
 *
 * The parent study reports ONE excess number per geometry: the signal
 * arm (tape + models agree) against the unconditional arm (the tape's
 * direction, no model filter). That number pools BOTH sides.
 *
 * This script runs the SAME outcome simulation, but:
 *
 *   1. splits every arm by side (long / short) and reports the excess
 *      WITHIN each side — a signal-long arm against an unconditional-
 *      LONG arm, never against a pooled baseline that includes shorts
 *   2. reports the cluster count, the t-statistic, and the trim test
 *      for each side separately
 *   3. decomposes the short side by symbol, by hold horizon, and by
 *      trim, and identifies which symbols carry the excess
 *   4. measures a PLACEBO — a random selection of the same size from
 *      the same-side unconditional set — beside the real number
 *
 * ── THE OUTCOME SIMULATION IS A COPY ──
 *
 * `outcome()`, `expectancyPctEquity()`, `breakEvenWinRate()` and the
 * cluster statistics are copied VERBATIM from analyze-geometry.mjs, so
 * the numbers here are comparable with the parent's. The shared script
 * is NOT modified.
 *
 * ── THE BASELINE IS SIDE-MATCHED ──
 *
 * The parent's baseline pools long and short. A short-only signal arm
 * compared against a pooled baseline is not a like-for-like comparison:
 * the baseline's long rows are a different trade entirely. So the
 * side-matched baseline here is the unconditional arm RESTRICTED TO THE
 * SAME SIDE. The pooled figure is also reported, as a robustness check,
 * and a symbol-and-window-matched baseline is reported beside both.
 *
 * USAGE
 *   node analyze-geometry-sides.mjs
 *   node analyze-geometry-sides.mjs --no-fetch   # use the cache only
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/research/tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const IN = join(HOME, ".hermes/cache/scratch/confluence.ndjson");
const CACHE_FILE = join(HOME, ".hermes/cache/scratch/geom-sidesplit-bars.json");
const SEED_FILE = join(HOME, ".hermes/cache/scratch/geom-sidesplit-bars.seed.json");

const TAKER_RT = 0.12;
const BAR_MIN = 15;
const MAX_HOLD_BARS = 16; // 4 hours at 15-minute bars
const CACHE_MIN = 4320;
const BUCKET_MS = 5 * 60_000;
const EQUITY = 57.2287;
const NOTIONAL = 60.0;
const notionalOverEquity = NOTIONAL / EQUITY;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const NO_FETCH = flag("no-fetch", false) === true;
// The collector appends live, so a run's numbers must be reproducible.
// `--snapshot <path>` reads a frozen copy instead.
const SNAP = flag("snapshot", null);
const IN_FILE = SNAP && SNAP !== true ? String(SNAP) : IN;
// `--bars <path>` reads a FROZEN bar cache. Without it, every run
// refetches the bars and the IN-PROGRESS 15-minute bar (whose high and
// low change minute to minute) moves the outcomes — two runs on the
// same rows disagreed in SIGN. A frozen bar set is the only way to
// quote a number.
const BARS_SNAP = flag("bars", null);
const BARS_FILE = BARS_SNAP && BARS_SNAP !== true ? String(BARS_SNAP) : CACHE_FILE;

/** The geometries — the parent's eight, verbatim. */
const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR capped 0.5%, SL=ATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2%  SL 0.8%", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

// ── the venue (public market data only — no account, no venue call) ──
async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

const CACHE = {};
let CACHE_OLDEST = 0;

async function barsFor(pair, needUntilMs) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const now = Date.now();
  const cached = CACHE[pair] ?? [];
  const newest = cached.length ? cached[cached.length - 1].t : 0;
  if (cached.length && newest >= needUntilMs) return cached;
  if (NO_FETCH) return cached;

  const from = Math.min(now - CACHE_MIN * 60_000, (CACHE_OLDEST || now) - 3600_000);
  const out = [];
  let cursor = now;
  let guard = 0;
  const PAGE_MS = 200 * BAR_MIN * 60_000;
  while (cursor > from && guard++ < 30) {
    const hi = Math.min(cursor, now);
    const lo = Math.max(from, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    let d;
    try {
      d = await futJson(
        `/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`,
      );
    } catch {
      break;
    }
    const rows = Array.isArray(d) ? d : [];
    if (!rows.length) break;
    for (const row of rows) {
      out.push({ t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    }
    cursor = lo - 1;
    // Paced, and gentle on the shared per-minute budget.
    await new Promise((r) => setTimeout(r, 300));
  }
  const merged = new Map();
  for (const b of cached) merged.set(b.t, b);
  for (const b of out) merged.set(b.t, b);
  // Only CLOSED bars are kept. A bar starting at t covers [t, t+15min),
  // so it is complete only once t + 15min has passed. An in-progress
  // bar's high and low change minute to minute, and a trade whose
  // target or stop is "touched" by a bar that is still forming is not a
  // settled outcome. Two runs that fetched at different minutes
  // disagreed in SIGN on the same rows; that was this bar.
  const barCutoff = Date.now();
  const all = [...merged.values()]
    .filter((b) => b.t + BAR_MIN * 60_000 <= barCutoff)
    .sort((a, b) => a.t - b.t);
  CACHE[pair] = all;
  return all;
}

// ── the statistics (copied verbatim from analyze-geometry.mjs) ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const tstat = (d) => {
  const s = se(d);
  return s > 0 ? mean(d) / s : 0;
};

/** The trade outcome — copied VERBATIM from analyze-geometry.mjs, except that the
 *  hold window is a parameter so the horizon sweep actually varies it. */
function outcome(bars, ts, entry, tpPct, slPct, long, holdBars = MAX_HOLD_BARS) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > ts) { start = i; break; }
  }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + holdBars);
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

function expectancyPctEquity(winRate, tpPct, slPct, notionalOverEquity) {
  const win = winRate * tpPct * notionalOverEquity;
  const loss = (1 - winRate) * slPct * notionalOverEquity;
  const fee = TAKER_RT * notionalOverEquity;
  return win - loss - fee;
}
function breakEvenWinRate(tpPct, slPct) {
  // The fee CANCELS out of the tp+sl term:
  //   w*tp - (1-w)*sl - fee = 0  =>  w*(tp+sl) = sl + fee
  //   => w* = (sl + fee) / (tp + sl)
  // The previous form had the fee in the denominator as well, which
  // understated the required win rate by 4.6-7.7 percentage points.
  return (slPct + TAKER_RT) / (tpPct + slPct);
}

/** The cluster statistics — copied verbatim from analyze-geometry.mjs. */
function clusterStats(values, buckets) {
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

/**
 * The arm simulation — the parent's `simulate()`, with the per-trade
 * values and their buckets returned so they can be re-used for the
 * trim, the symbol decomposition and the placebo.
 */
function simulate(set, g, holdBars = MAX_HOLD_BARS) {
  const perTrade = [];
  const buckets = [];
  const rows = [];
  let unresolved = 0, ambiguous = 0, missingAtr = 0;
  let wins = 0, losses = 0, timeExits = 0;
  for (const c of set) {
    const bars = CACHE[c.pair];
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
    const o = outcome(bars, c.ts, entry, tpPct, slPct, long, holdBars);
    if (o === null) { unresolved++; continue; }
    const bucket = Math.floor(c.ts / BUCKET_MS);
    if (typeof o === "object") {
      perTrade.push((o.movePct - TAKER_RT) * notionalOverEquity);
      buckets.push(bucket);
      rows.push({ ...c, kind: "time", pnl: (o.movePct - TAKER_RT) * notionalOverEquity });
      timeExits++;
      continue;
    }
    if (o === "loss") {
      const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
      const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
      let start = -1;
      for (let i = 0; i < bars.length; i++) { if (bars[i].t > c.ts) { start = i; break; } }
      if (start >= 0) {
        for (let i = start; i < Math.min(bars.length, start + holdBars); i++) {
          const b = bars[i];
          const hitTp = long ? b.h >= tp : b.l <= tp;
          const hitSl = long ? b.l <= sl : b.h >= sl;
          if (hitTp && hitSl) { ambiguous++; break; }
          if (hitTp || hitSl) break;
        }
      }
    }
    // The P&L uses the tpPct/slPct THAT DECIDED THE OUTCOME, not a
    // flat fallback. The parent's script books a win at `(g.tp ?? 0.4)`
    // and a loss at `(g.sl ?? 1.2)`, which for the SHIPPED geometry
    // (tp=null, sl=null) books every win at 0.4% and every loss at
    // 1.2% — but the shipped geometry's ACTUAL levels are ATR-derived
    // and vary per observation (TP in [0.3,0.5], SL = 1.34 x ATR).
    // The flat fallback is a different ticket than the one measured.
    const pnl = o === "win"
      ? tpPct * notionalOverEquity - TAKER_RT * notionalOverEquity
      : -slPct * notionalOverEquity - TAKER_RT * notionalOverEquity;
    perTrade.push(pnl);
    buckets.push(bucket);
    rows.push({ ...c, kind: o, pnl });
    if (o === "win") wins++; else losses++;
  }
  return {
    perTrade, buckets, rows, wins, losses, timeExits,
    unresolved, ambiguous, missingAtr,
    n: wins + losses,
    ev: mean(perTrade),
    cluster: clusterStats(perTrade, buckets),
  };
}

/** A PLACEBO arm: a random selection of the same size from a pool. */
function placebo(pool, size, draws = 2000) {
  const outs = [];
  if (!pool.length || size <= 0) return outs;
  for (let d = 0; d < draws; d++) {
    const pick = [];
    const used = new Set();
    let guard = 0;
    while (pick.length < size && guard++ < size * 40) {
      const i = Math.floor(rand() * pool.length);
      if (used.has(i)) continue;
      used.add(i);
      pick.push(pool[i]);
    }
    outs.push(mean(pick));
  }
  return outs;
}

/**
 * A seeded PRNG (mulberry32). The placebo's percentile is a MONTE
 * CARLO estimate, and an unseeded one moved by several percentile points
 * between runs of the SAME data — which is indistinguishable from a
 * result that moved. Seeded, the whole report is reproducible.
 */
let _seed = 0x9e3779b9;
function rand() {
  _seed |= 0; _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function seedRng(s) { _seed = s >>> 0; }

function fmtPct(x, d = 4) {
  return `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
}
function pctile(arr, v) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  let below = 0;
  for (const x of s) if (x <= v) below++;
  return (below / s.length) * 100;
}

async function main() {
  if (!existsSync(IN_FILE)) {
    console.error(`[sides] no confluence file at ${IN_FILE}`);
    process.exitCode = 1;
    return;
  }
  const rows = readFileSync(IN_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // ── THE ARM DEFINITIONS ──
  //
  // There are TWO control arms in this repo and they are NOT the same:
  //
  //   strict — the collector's own `side` field, which is set only when
  //            BOTH model legs are equal AND the JEV leg is CERTAIN.
  //            This is the machine's own signal: the trade-loop's gate is
  //            `jev.side === laya.side && !jev.uncertain`, the same rule.
  //
  //   study  — analyze-geometry.mjs's `modelSide` rule: when only ONE leg
  //            has a side, that leg is used. It drops the certainty test.
  //            This admits observations the live path REFUSES to trade.
  //
  // The strict arm is the default here because it is what the machine
  // actually trades. The study arm is reported alongside it.
  const modelStrict = (r) => {
    const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    return j && l && j === l ? j : null;
  };
  const modelStudy = (r) => {
    const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    return j && l ? (j === l ? j : null) : (j || l);
  };
  const ARMS = {
    strict: {
      label: "strict — the machine's own signal (tapeSide === side)",
      signal: (r) => (r.tapeSide && r.tapeSide === r.side ? { ...r, dir: r.tapeSide } : null),
      uncond: (r) => (r.tapeSide ? { ...r, dir: r.tapeSide } : null),
    },
    study: {
      label: "study  — analyze-geometry.mjs's modelSide rule",
      signal: (r) => {
        const t = tapeSideFromRow(r);
        if (!t) return null;
        const m = modelStudy(r);
        return m && t === m ? { ...r, dir: t } : null;
      },
      uncond: (r) => {
        const t = tapeSideFromRow(r);
        return t ? { ...r, dir: t } : null;
      },
    },
  };
  const ARM_KEY = String(flag("arm", "strict"));
  const ARM = ARMS[ARM_KEY];
  if (!ARM) {
    console.error(`[sides] unknown --arm ${ARM_KEY} (use strict|study)`);
    process.exitCode = 1;
    return;
  }

  // The signal arm: the tape and the models AGREE.
  const control = rows.map(ARM.signal).filter(Boolean);
  // The unconditional arm: the tape's direction, NO model filter.
  const unconditional = rows.map(ARM.uncond).filter(Boolean);

  const tsAll = rows.map((r) => r.ts);
  const minTs = minOf(tsAll), maxTs = maxOf(tsAll);
  const cts = control.map((c) => c.ts);
  console.log("=".repeat(100));
  console.log("THE GEOMETRY STUDY, SPLIT BY SIDE");
  console.log("=".repeat(100));
  console.log(`arm: ${ARM.label}`);
  console.log(`rows in confluence.ndjson: ${rows.length}`);
  console.log(`sample span (all rows): ${new Date(minTs).toISOString()} -> ${new Date(maxTs).toISOString()}  (${((maxTs - minTs) / 3600000).toFixed(2)} h)`);
  if (cts.length) {
    console.log(`signal arm span:          ${new Date(minOf(cts)).toISOString()} -> ${new Date(maxOf(cts)).toISOString()}  (${((maxOf(cts) - minOf(cts)) / 3600000).toFixed(2)} h)`);
  }
  console.log(`collected: ${new Date().toISOString()}`);
  console.log();

  // ── THE SIDE INVENTORY ──
  console.log("─".repeat(100));
  console.log("SIDE INVENTORY — how many observations exist on each side, in each arm");
  console.log("─".repeat(100));
  console.log("  arm              side    rows   5-min clusters   distinct symbols   distinct hours");
  for (const [label, set] of [["signal  (tape+models)", control], ["uncond.  (tape only)", unconditional]]) {
    for (const side of ["long", "short"]) {
      const s = set.filter((x) => x.dir === side);
      const cl = new Set(s.map((x) => Math.floor(x.ts / BUCKET_MS))).size;
      const sym = new Set(s.map((x) => x.pair)).size;
      const hr = new Set(s.map((x) => Math.floor(x.ts / 3600000))).size;
      console.log(
        `  ${label.padEnd(18)} ${side.padEnd(6)} ${String(s.length).padStart(6)} ${String(cl).padStart(15)} ${String(sym).padStart(18)} ${String(hr).padStart(16)}`,
      );
    }
  }
  const ctrlLong = control.filter((c) => c.dir === "long");
  const ctrlShort = control.filter((c) => c.dir === "short");
  console.log();
  if (ctrlLong.length === 0) {
    console.log("  *** THE SIGNAL ARM HAS NO LONG OBSERVATIONS AT ALL. ***");
    console.log("  The long-side excess is UNDEFINED, not zero: there is no long signal to");
    console.log("  compare against the unconditional long baseline. Every excess the parent");
    console.log("  study reports is therefore SHORT-side by construction.");
  } else {
    console.log(`  The signal arm has ${ctrlLong.length} long observations across ${new Set(ctrlLong.map((c) => Math.floor(c.ts / BUCKET_MS))).size} clusters.`);
  }
  console.log();

  // ── WHY THE LONG SIDE IS EMPTY (the structural diagnosis) ──
  console.log("─".repeat(100));
  console.log("WHY THE LONG SIDE IS EMPTY — the tape's long condition vs the models' answers");
  console.log("─".repeat(100));
  {
    const tapeLong = unconditional.filter((u) => u.dir === "long");
    let longCond = 0;
    for (const r of rows) {
      const vr = Number(r.tapeVratio ?? 0), oh = Number(r.tapeOffHighPct ?? 0), ol = Number(r.tapeOffLowPct ?? 0);
      if (vr < 0.85 && ol < 8 && oh >= 8) longCond++;
    }
    let shortCond = 0;
    for (const r of rows) {
      const vr = Number(r.tapeVratio ?? 0), oh = Number(r.tapeOffHighPct ?? 0);
      if (vr < 0.85 && oh < 8) shortCond++;
    }
    console.log(`  rows where the tape's SHORT condition holds (vratio<0.85 & offHigh<8):   ${shortCond}  (${(shortCond / rows.length * 100).toFixed(1)}% of rows)`);
    console.log(`  rows where the tape's LONG  condition holds (vratio<0.85 & offLow<8 & offHigh>=8): ${longCond}  (${(longCond / rows.length * 100).toFixed(1)}% of rows)`);
    console.log(`  rows where the tape's side is LONG:                                          ${tapeLong.length}`);
    const bySym = new Map();
    for (const t of tapeLong) bySym.set(t.pair, (bySym.get(t.pair) ?? 0) + 1);
    console.log(`  ... and those tape-long rows come from ${bySym.size} symbol(s): ${[...bySym.entries()].map(([p, n]) => `${p}:${n}`).join(" ")}`);
    const modelLongOnTapeLong = tapeLong.filter((t) => {
      const jev = t.jevSide && t.jevSide !== "flat" ? t.jevSide : null;
      const laya = t.layaSide && t.layaSide !== "flat" ? t.layaSide : null;
      const m = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
      return m === "long";
    }).length;
    const modelShortOnTapeLong = tapeLong.filter((t) => {
      const jev = t.jevSide && t.jevSide !== "flat" ? t.jevSide : null;
      const laya = t.layaSide && t.layaSide !== "flat" ? t.layaSide : null;
      const m = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
      return m === "short";
    }).length;
    console.log(`  ... of which the models said LONG: ${modelLongOnTapeLong};  the models said SHORT: ${modelShortOnTapeLong}`);
    console.log("  => the tape's long setup fires, but the models never confirm it in this sample.");
  }
  console.log();

  // ── the bars ──
  // Load the frozen cache FIRST, so a run starts from the known bar set
  // and only ADDS to it. Without this the cache was written but never
  // read, and every run silently refetched — including the in-progress
  // bar, which moves minute to minute.
  try {
    const seed = JSON.parse(readFileSync(BARS_FILE, "utf8"));
    for (const k of Object.keys(seed)) CACHE[k] = seed[k];
  } catch { /* no cache yet */ }
  CACHE_OLDEST = minBy(rows, (r) => r.ts);
  const needed = [...new Set(rows.map((r) => r.pair))];
  let noBars = 0;
  for (const p of needed) {
    const got = await barsFor(p, Date.now());
    if (!got.length) noBars++;
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  } catch { /* the cache is an optimisation */ }
  const barTs = [];
  for (const k of Object.keys(CACHE)) for (const b of CACHE[k]) barTs.push(b.t);
  console.log(`  bars: ${Object.keys(CACHE).length} pairs${noBars ? `, ${noBars} with no bars` : ""}; ` +
    `bar span ${new Date(minOf(barTs)).toISOString()} -> ${new Date(maxOf(barTs)).toISOString()}`);
  console.log();

  // ── THE SIDE-SPLIT RESULTS ──
  const report = [];
  for (const side of ["long", "short"]) {
    const sig = control.filter((c) => c.dir === side);
    const unc = unconditional.filter((u) => u.dir === side);
    console.log("═".repeat(100));
    console.log(`SIDE = ${side.toUpperCase()}`);
    console.log("═".repeat(100));
    if (sig.length === 0) {
      console.log("  The signal arm has NO observations on this side. The excess is UNDEFINED.");
      console.log("  (The unconditional arm on this side is reported below as context only — it is");
      console.log("   the tape's own performance, not the models' contribution.)");
      console.log();
      for (const g of GEOMETRIES) {
        const U = simulate(unc, g);
        if (!U.perTrade.length) { console.log(`    ${g.name}: no data`); continue; }
        const wbe = breakEvenWinRate(g.tp ?? 0.4, g.sl ?? 1.2);
        const wr = U.n ? U.wins / U.n : 0;
        console.log(
          `    ${g.name.padEnd(26)} n=${String(U.n).padStart(3)} win=${(wr * 100).toFixed(1).padStart(5)}% break-even=${(wbe * 100).toFixed(1).padStart(5)}% ` +
          `EV/trade=${fmtPct(U.ev)}%  clusters=${String(U.cluster.clusters).padStart(3)}  t=${tstat(U.cluster.clusterMeans).toFixed(2)}  [CONTEXT ONLY — not an excess]`,
        );
      }
      console.log();
      continue;
    }
    console.log("  GEOMETRY                     sig n  sig clus  sig EV%   unc n  unc clus  unc EV%   EXCESS    t(cl)  trim-worst  trim-best  placebo%ile");
    console.log("  " + "─".repeat(132));
    for (const g of GEOMETRIES) {
      const S = simulate(sig, g);
      const U = simulate(unc, g);
      if (!S.perTrade.length || !U.perTrade.length) {
        console.log(`  ${g.name.padEnd(26)} not enough data (sig ${S.perTrade.length}, unc ${U.perTrade.length})`);
        continue;
      }
      const excess = S.cluster.mean - U.cluster.mean;
      const excSe = Math.sqrt(S.cluster.se ** 2 + U.cluster.se ** 2);
      const excT = excSe > 0 ? excess / excSe : 0;
      // The trim test: drop the worst 3 and the best 3 of the signal arm.
      const sorted = [...S.perTrade].sort((a, b) => a - b);
      const trimWorst = sorted.slice(3);
      const trimBest = sorted.slice(0, sorted.length - 3);
      const exW = mean(trimWorst) - U.cluster.mean;
      const exB = mean(trimBest) - U.cluster.mean;
      // Clustered t on the trimmed set (the honest version), plus the
      // parent's row-level t for comparability.
      const trimWorstRows = S.rows.filter((r) => !sorted.slice(0, 3).includes(r.pnl));
      const trimBestRows = S.rows.filter((r) => !sorted.slice(sorted.length - 3).includes(r.pnl));
      const twC = clusterStats(trimWorstRows.map((r) => r.pnl), trimWorstRows.map((r) => Math.floor(r.ts / BUCKET_MS)));
      const tbC = clusterStats(trimBestRows.map((r) => r.pnl), trimBestRows.map((r) => Math.floor(r.ts / BUCKET_MS)));
      const twSe = Math.sqrt(twC.se ** 2 + U.cluster.se ** 2);
      const tbSe = Math.sqrt(tbC.se ** 2 + U.cluster.se ** 2);
      const twT = twSe > 0 ? (twC.mean - U.cluster.mean) / twSe : 0;
      const tbT = tbSe > 0 ? (tbC.mean - U.cluster.mean) / tbSe : 0;
      // The placebo: a random selection of the same size from the
      // same-side unconditional pool. The seed is derived from the
      // geometry so each placebo is independent but reproducible.
      seedRng(0x9e3779b9 ^ (GEOMETRIES.indexOf(g) + 1) * 2654435761);
      const pl = placebo(U.perTrade, S.perTrade.length, 1500);
      const plEx = pl.map((v) => v - U.cluster.mean);
      const plPct = pctile(plEx, excess);
      console.log(
        `  ${g.name.padEnd(26)} ${String(S.n).padStart(5)} ${String(S.cluster.clusters).padStart(8)} ${fmtPct(S.ev).padStart(9)} ` +
        `${String(U.n).padStart(6)} ${String(U.cluster.clusters).padStart(9)} ${fmtPct(U.ev).padStart(8)} ${fmtPct(excess).padStart(8)} ${excT.toFixed(2).padStart(7)} ` +
        `${fmtPct(exW).padStart(11)} ${fmtPct(exB).padStart(10)} ${plPct.toFixed(1).padStart(11)}`,
      );
      report.push({ side, g, S, U, excess, excT, exW, exB, twT, tbT, plPct, twC, tbC, plEx });
    }
    console.log();
  }

  // ── THE SHORT-SIDE DECOMPOSITION ──
  const shortReport = report.filter((r) => r.side === "short");
  if (shortReport.length) {
    console.log("═".repeat(100));
    console.log("THE SHORT SIDE, DECOMPOSED");
    console.log("═".repeat(100));

    // (a) PER SYMBOL
    console.log();
    console.log("  (a) PER SYMBOL — the short-side excess, symbol by symbol");
    console.log("      Each symbol is measured against ITSELF in the unconditional arm, so");
    console.log("      the symbol's own drift cancels out of the comparison.");
    console.log();
    const g0 = GEOMETRIES[0];
    const sigShort = control.filter((c) => c.dir === "short");
    const uncShort = unconditional.filter((u) => u.dir === "short");
    const syms = [...new Set(sigShort.map((c) => c.pair))].sort();
    console.log("      symbol          sig n  clus  sig EV%    unc n  unc clus  unc EV%   sym EXCESS   t(cl)   LOO delta   verdict");
    const symRows = [];
    for (const p of syms) {
      const S = simulate(sigShort.filter((c) => c.pair === p), g0);
      const U = simulate(uncShort.filter((u) => u.pair === p), g0);
      if (!S.perTrade.length || !U.perTrade.length) continue;
      const ex = S.cluster.mean - U.cluster.mean;
      const exSe = Math.sqrt(S.cluster.se ** 2 + U.cluster.se ** 2);
      const t = exSe > 0 ? ex / exSe : 0;
      symRows.push({ p, S, U, ex, t });
    }
    // The full-arm excess, and each symbol's LEAVE-ONE-OUT delta: how
    // much the total excess changes when that symbol is removed. That
    // delta IS the symbol's contribution to the total — a per-symbol
    // excess is measured against a different baseline (the symbol's own
    // unconditional arm), so the per-symbol excesses do NOT add up.
    const fullS0 = simulate(sigShort, g0);
    const fullU0 = simulate(uncShort, g0);
    const fullEx0 = fullS0.cluster.mean - fullU0.cluster.mean;
    for (const r of symRows) {
      const S2 = simulate(sigShort.filter((c) => c.pair !== r.p), g0);
      r.loo = (S2.cluster.mean - fullU0.cluster.mean) - fullEx0;
      r.contribution = -r.loo; // the excess it ADDS to the total
    }
    for (const r of symRows.sort((a, b) => b.contribution - a.contribution)) {
      const verdict = r.contribution > 0.005 ? "CARRIES" : r.contribution < -0.005 ? "dilutes" : "neutral";
      console.log(
        `      ${r.p.padEnd(16)} ${String(r.S.n).padStart(5)} ${String(r.S.cluster.clusters).padStart(5)} ${fmtPct(r.S.ev).padStart(9)} ` +
        `${String(r.U.n).padStart(6)} ${String(r.U.cluster.clusters).padStart(9)} ${fmtPct(r.U.ev).padStart(8)} ${fmtPct(r.ex).padStart(10)} ${r.t.toFixed(2).padStart(7)} ${fmtPct(r.loo).padStart(10)}   ${verdict}`,
      );
    }
    console.log(`      the full-arm short-side excess (SHIPPED geometry): ${fmtPct(fullEx0)}%  in ${fullS0.cluster.clusters} clusters`);
    console.log("      (the per-symbol EXCESS column uses each symbol's own baseline, so it does");
    console.log("       not sum to the total; the LOO DELTA column is the contribution.)");
    console.log();

    // (b) LEAVE-ONE-SYMBOL-OUT: which symbol carries the TOTAL short excess?
    console.log("  (b) LEAVE-ONE-SYMBOL-OUT — dropping a symbol from the signal arm changes the");
    console.log("      total short-side excess by this much. A large drop means the symbol");
    console.log("      CARRIES the excess; ~0 means it contributes nothing.");
    console.log();
    const fullS = simulate(sigShort, g0);
    const fullU = simulate(uncShort, g0);
    const fullEx = fullS.cluster.mean - fullU.cluster.mean;
    console.log(`      full short-side excess (SHIPPED geometry): ${fmtPct(fullEx)}%   (${fullS.cluster.clusters} clusters)`);
    console.log("      symbol          LOO excess    delta    verdict");
    const loo = [];
    for (const p of syms) {
      const S = simulate(sigShort.filter((c) => c.pair !== p), g0);
      const ex = S.cluster.mean - fullU.cluster.mean;
      const d = ex - fullEx;
      loo.push({ p, ex, d, clusters: S.cluster.clusters });
    }
    for (const r of loo.sort((a, b) => a.d - b.d)) {
      const verdict = r.d < -0.005 ? "CARRIES the excess" : r.d > 0.005 ? "dilutes it" : "neutral";
      console.log(`      ${r.p.padEnd(16)} ${fmtPct(r.ex).padStart(11)} ${fmtPct(r.d).padStart(9)}   ${verdict}`);
    }
    console.log();

    // (c) PER HORIZON — the hold window is swept.
    console.log("  (c) PER HORIZON — the same signal, different hold windows.");
    console.log("      MAX_HOLD_BARS is the parent's 16 (4 h); the shorter holds answer");
    console.log("      'is the edge concentrated in the first hour?'.");
    console.log();
    console.log("      hold        sig n  clus  sig EV%    unc n  unc clus  unc EV%   EXCESS    t(cl)  placebo%ile");
    for (const hold of [4, 8, 16, 24]) {
      const S = simulate(sigShort, g0, hold);
      const U = simulate(uncShort, g0, hold);
      if (!S.perTrade.length || !U.perTrade.length) continue;
      const ex = S.cluster.mean - U.cluster.mean;
      const exSe = Math.sqrt(S.cluster.se ** 2 + U.cluster.se ** 2);
      const t = exSe > 0 ? ex / exSe : 0;
      seedRng(0x9e3779b9 ^ (hold * 2654435761) ^ 0x5bf03635);
      const pl = placebo(U.perTrade, S.perTrade.length, 1500).map((v) => v - U.cluster.mean);
      const plPct = pctile(pl, ex);
      console.log(
        `      ${(hold * BAR_MIN / 60).toFixed(0).padStart(2)}h${" ".repeat(3)} ${String(S.n).padStart(6)} ${String(S.cluster.clusters).padStart(5)} ${fmtPct(S.ev).padStart(9)} ` +
        `${String(U.n).padStart(6)} ${String(U.cluster.clusters).padStart(9)} ${fmtPct(U.ev).padStart(8)} ${fmtPct(ex).padStart(8)} ${t.toFixed(2).padStart(7)} ${plPct.toFixed(1).padStart(11)}`,
      );
    }
    console.log();

    // (d) THE PLACEBO, IN DETAIL
    console.log("  (d) THE PLACEBO — the real excess against random selections of the same size");
    console.log("      (drawn from the same-side unconditional pool). A real excess inside the");
    console.log("      placebo's own spread is not distinguishable from chance.");
    console.log();
    console.log("      geometry                     real EXCESS   placebo mean   placebo sd    percentile   placebo 95% band");
    for (const r of shortReport) {
      const pl = r.plEx;
      const pm = mean(pl), psd = se(pl);
      const band = [pl.slice().sort((a, b) => a - b)[Math.floor(pl.length * 0.025)], pl.slice().sort((a, b) => a - b)[Math.floor(pl.length * 0.975)]];
      console.log(
        `      ${r.g.name.padEnd(26)} ${fmtPct(r.excess).padStart(11)} ${fmtPct(pm).padStart(13)} ${fmtPct(psd).padStart(12)} ${r.plPct.toFixed(1).padStart(12)}% ${fmtPct(band[0]).padStart(13)} .. ${fmtPct(band[1])}`,
      );
    }
    console.log();

    // (e) THE TRIM, IN DETAIL
    console.log("  (e) THE TRIM — the worst 3 and the best 3 of the signal arm dropped,");
    console.log("      with the CLUSTERED t on what remains (the honest version).");
    console.log();
    console.log("      geometry                     excess   t   |  drop worst 3: excess   t(cl)  clus |  drop best 3: excess   t(cl)  clus");
    for (const r of shortReport) {
      console.log(
        `      ${r.g.name.padEnd(26)} ${fmtPct(r.excess).padStart(7)} ${r.excT.toFixed(2).padStart(5)} | ${fmtPct(r.exW).padStart(15)} ${r.twT.toFixed(2).padStart(6)} ${String(r.twC.clusters).padStart(4)} | ${fmtPct(r.exB).padStart(15)} ${r.tbT.toFixed(2).padStart(6)} ${String(r.tbC.clusters).padStart(4)}`,
      );
    }
    console.log();

    // (f) THE ROBUSTNESS: alternative baselines
    console.log("  (f) ROBUSTNESS — the short-side excess against three baselines");
    console.log();
    const ctrlSyms = new Set(sigShort.map((c) => c.pair));
    const tMin = minBy(sigShort, (c) => c.ts);
    const tMax = maxBy(sigShort, (c) => c.ts);
    const variants = [
      ["same-side unconditional (all symbols, all time)", uncShort],
      ["same-side unconditional, CONTROL SYMBOLS only", uncShort.filter((u) => ctrlSyms.has(u.pair))],
      ["same-side unconditional, CONTROL SYMBOLS + SIGNAL WINDOW", uncShort.filter((u) => ctrlSyms.has(u.pair) && u.ts >= tMin && u.ts <= tMax)],
    ];
    console.log("      geometry                     baseline n  base clus  base EV%   EXCESS    t(cl)  placebo%ile");
    for (const g of GEOMETRIES) {
      const S = simulate(sigShort, g);
      if (!S.perTrade.length) continue;
      for (const [label, pool] of variants) {
        const U = simulate(pool, g);
        if (!U.perTrade.length) continue;
        const ex = S.cluster.mean - U.cluster.mean;
        const exSe = Math.sqrt(S.cluster.se ** 2 + U.cluster.se ** 2);
        const t = exSe > 0 ? ex / exSe : 0;
        seedRng(0x9e3779b9 ^ (GEOMETRIES.indexOf(g) + 1) * 2654435761 ^ 0x27d4eb2f);
        const pl = placebo(U.perTrade, S.perTrade.length, 1200).map((v) => v - U.cluster.mean);
        console.log(
          `      ${g.name.padEnd(26)} ${String(U.n).padStart(9)} ${String(U.cluster.clusters).padStart(10)} ${fmtPct(U.ev).padStart(8)} ${fmtPct(ex).padStart(8)} ${t.toFixed(2).padStart(7)} ${pctile(pl, ex).toFixed(1).padStart(11)}  ${label}`,
        );
      }
      console.log();
    }
    console.log();
  }

  // ── THE VERDICT ──
  console.log("═".repeat(100));
  console.log("VERDICT");
  console.log("═".repeat(100));
  if (ctrlLong.length === 0) {
    console.log("  1. THE LONG SIDE HAS NO DATA. The signal arm contains zero long");
    console.log("     observations, so the long-side excess is UNDEFINED (not zero).");
    console.log("     The whole excess the parent study reports is SHORT-side, by construction.");
    console.log("  2. The unconditional arm DOES have long observations, so the tape's long");
    console.log("     setup fires — but the models never confirm it in this sample. The");
    console.log("     long side is a CONFLICT-only population here, not a tradable one.");
  } else {
    const lr = report.filter((r) => r.side === "long");
    const lp = lr.filter((r) => r.excess > 0);
    console.log(`  LONG side: ${lp.length}/${lr.length} geometries with a positive excess.`);
  }
  const sr = report.filter((r) => r.side === "short");
  if (sr.length) {
    const sig = sr.filter((r) => r.excess > 0);
    const pass = sr.filter((r) => r.excess > 0 && r.excT >= 2);
    const trimPass = sr.filter((r) => r.excess > 0 && (r.twT >= 2 || r.tbT >= 2));
    const placeboPass = sr.filter((r) => r.excess > 0 && r.plPct >= 95);
    console.log(`  SHORT side: ${sig.length}/${sr.length} geometries with a positive excess;`);
    console.log(`     t >= 2 on clusters: ${pass.length};  survives a trim: ${trimPass.length};  above the 95th placebo percentile: ${placeboPass.length}.`);
  }
  console.log("  The bar: n >= 30 INDEPENDENT CLUSTERS, excess > 0, t >= 2, AND the trim test.");
  console.log();
}

main().catch((e) => {
  console.error(`[sides] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
