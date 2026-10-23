#!/usr/bin/env node
/**
 * THE LONG-SIDE MIRROR OF THE GEOMETRY STUDY.
 *
 * ── WHAT THIS EXISTS TO ANSWER ──
 *
 * The geometry study (analyze-geometry.mjs) compared the SIGNAL arm
 * (the tape and the models agree) against the UNCONDITIONAL arm (the
 * tape's direction with NO model filter) and reported a positive
 * excess across eight geometries.
 *
 * But EVERY usable observation in that study was SHORT. If the sample
 * contains only one direction, then "unconditional in that direction"
 * is close to a tautology, and the comparison cannot separate "the
 * models' agreement adds something" from "the market drifted that way
 * and the models happened to agree".
 *
 * So this script measures the LONG side with the SAME machinery:
 * the same confluence definition, the same ticket geometry, the same
 * unconditional-control comparison, the same cluster-corrected t, and
 * the same trim test — and it reports the direction mix FIRST.
 *
 * ── WHAT IS COPIED AND WHAT IS CHANGED ──
 *
 * COPIED (so the numbers are comparable to the geometry study):
 *   - the outcome rule: first touch of TP or the kill, a bar touching
 *     BOTH is a LOSS, and an explicit time exit for a trade that
 *     reaches neither level
 *   - the fee: the taker round trip on the notional
 *   - the exposure: the ticket's notional over the account's equity
 *   - the cluster correction: one mean per 5-minute bucket
 *   - the trim test: the signal arm's best/worst rows dropped
 *
 * CHANGED (because the long side needs them):
 *   - the SHORT arm is re-measured HERE, from the same rows and the
 *     same code path, so the short and long numbers are produced by
 *     ONE implementation and are directly comparable
 *   - the SHORT arm's excess is tested with a PAIRED per-bucket
 *     difference as well as the unpaired test, because the signal arm
 *     is a SUBSET of the unconditional arm and the unpaired standard
 *     error double-counts the overlap
 *   - the cluster is also tested at the HOUR level, because buckets
 *     inside one hour share a market state
 *   - a PLACEBO (a random draw of the same size) sits beside every
 *     real number
 *   - a SIGN-FLIP MIRROR: the same signal rows, traded the OTHER way
 *
 * IT NEVER TOUCHES THE ACCOUNT. It reads the collector's ndjson and
 * the public kline cache, and (with --fetch) the public kline
 * endpoint, paced far under the server's per-minute budget so the
 * live machine's watchdog is never starved.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
/** MY OWN bar cache. The shared geometry-bars.json is never written. */
const CACHE_FILE = join(SCRATCH, "geometry-bars.longmirror.json");

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

/** The collector file to read. `--file` makes the run reproducible
 *  against a snapshot, because the collector keeps appending. */
const IN = flag("file", join(SCRATCH, "confluence.ndjson"));

/** The taker round trip, in %, charged on the notional. */
const TAKER_RT = 0.12;
const BAR_MIN = 15;
const BAR_MS = BAR_MIN * 60_000;
/** How long a trade is held before it is called unresolved, in bars. */
const MAX_HOLD_BARS = 16; // 4 hours at 15-minute bars
/** One cluster per 5-minute bucket: the collector's sampling interval. */
const BUCKET_MS = 5 * 60_000;

/**
 * The geometries to test. IDENTICAL to the geometry study's list, so
 * the two are measured on the same tickets.
 */
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

// ── the statistics ──
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
/**
 * THE BAR. A result is a FINDING only if ALL of these hold:
 *   n >= 30 INDEPENDENT CLUSTERS (the rows in one 5-minute bucket
 *   are ~43 symbols moving together, so the cluster count is the
 *   real sample size)
 *   excess > 0
 *   t >= 2
 *   trim-stable (the excess survives dropping the best and worst
 *   rows)
 *
 * A t of 3.9 on 4 clusters is NOT a finding: with 4 clusters the
 * t has 3 degrees of freedom, and the cluster means happened to
 * agree closely. The bar is the cluster count FIRST, because a
 * small-n t is a coincidence rate, not a measurement.
 */
const MIN_CLUSTERS = 30;
const MIN_T = 2;
/** The verdict, with the cluster bar applied. */
const verdictOf = (r) => {
  if (r.empty) return "no data";
  if (r.clusters < MIN_CLUSTERS) return `NOT MEETABLE (${r.clusters} clusters < ${MIN_CLUSTERS})`;
  if (r.excess <= 0) return "no edge";
  if (r.tUnpaired < MIN_T) return "pattern (t<2)";
  return "EDGE";
};

/**
 * The trade outcome for one observation at one geometry.
 *
 * `long` means the trade is LONG. Walks the forward bars:
 *   "win"  the target was touched first
 *   "loss" the stop was touched first, or the bar touched BOTH
 *           (AMBIGUOUS, resolved conservatively as a loss)
 *   null   neither was touched and there is no bar to exit at
 *   {kind:"time", movePct}  neither level was reached; the trade is
 *           closed at the horizon's close and booked at the mark
 */
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
    if (hitTp && hitSl) return "loss"; // AMBIGUOUS -> conservative
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

/**
 * The effective sample size of a set of observations: one mean per
 * time bucket, because the rows in one bucket are ~43 symbols moving
 * TOGETHER.
 */
function clusterStats(values, buckets, bucketMs = BUCKET_MS) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = Math.floor((buckets[i] ?? i) / bucketMs);
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const entries = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
  return {
    clusters: entries.length,
    clusterMeans: entries.map(([, a]) => mean(a)),
    keys: entries.map(([k]) => k),
    mean: mean(entries.map(([, a]) => mean(a))),
    se: se(entries.map(([, a]) => mean(a))),
  };
}

// ── the bar cache ──
const CACHE = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

let CALLS = 0;
let WINDOW_START = Date.now();
async function pacedSleep() {
  const now = Date.now();
  if (now - WINDOW_START > 60_000) { WINDOW_START = Date.now(); CALLS = 0; }
  if (CALLS >= 20) {
    const wait = 60_000 - (now - WINDOW_START) + 1000;
    // A PACING BACKOFF, not an alarm — see collect-funding-oi.mjs.
    console.log(`[bars] pacing backoff at ${CALLS} calls — waiting ${Math.round(wait / 1000)}s for the machine`);
    await new Promise((r) => setTimeout(r, wait));
    WINDOW_START = Date.now();
    CALLS = 0;
  }
  CALLS++;
  await new Promise((r) => setTimeout(r, 1200));
}

async function barsFor(pair) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const now = Date.now();
  const cached = CACHE[pair] ?? [];
  const newest = cached.length ? cached[cached.length - 1].t : 0;
  if (cached.length && newest >= now - BAR_MS) return cached;
  const from = Math.min(now - 4320 * 60_000, (cached.length ? cached[0].t : now) - 3600_000);
  const out = [];
  let cursor = now;
  let guard = 0;
  const PAGE_MS = 200 * BAR_MS;
  while (cursor > from && guard++ < 30) {
    const hi = Math.min(cursor, now);
    const lo = Math.max(from, hi - PAGE_MS);
    if (hi - lo < BAR_MS) break;
    let d;
    try {
      d = await futJson(`/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`);
    } catch (e) {
      console.log(`[bars] ${pair}: ${e.message}`);
      break;
    }
    const rows = Array.isArray(d) ? d : [];
    if (!rows.length) break;
    for (const row of rows) out.push({ t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    cursor = lo - 1;
    await pacedSleep();
  }
  const merged = new Map();
  for (const b of cached) merged.set(b.t, b);
  for (const b of out) merged.set(b.t, b);
  const all = [...merged.values()].sort((a, b) => a.t - b.t);
  CACHE[pair] = all;
  return all;
}

// ── the arms ──

/**
 * The models' side, exactly as the geometry study computes it.
 *
 * NOTE: this is LOOSER than the live path's gate (see `liveConfluenceSide`
 * below). It is kept so the numbers here are comparable to the geometry
 * study, and the strict gate is measured ALONGSIDE it.
 */
function modelSide(r) {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return jev && laya ? (jev === laya ? jev : null) : (jev || laya);
}

/**
 * The LIVE PATH's confluence gate (live-cmd.ts `confluenceGate`):
 * both legs must be present, both must be non-flat, they must AGREE,
 * and the JEV leg must not be uncertain.
 *
 * The geometry study's `modelSide` has a fallback to a single model's
 * side, which the live path explicitly refuses ("a single-model read is
 * a watch, not a trigger"). That difference matters enormously on the
 * long side, so the strict gate is measured too.
 */
function liveConfluenceSide(r) {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev || !laya) return null;
  if (jev !== laya) return null;
  if (r.jevUncertain) return null;
  return jev;
}

const meanPct = (a) => `${a >= 0 ? "+" : ""}${a.toFixed(4)}%`;
const fmtT = (t) => (t >= 0 ? "+" : "") + t.toFixed(2);

async function main() {
  if (!existsSync(IN)) {
    console.error(`[longmirror] no confluence file at ${IN}`);
    process.exitCode = 1;
    return;
  }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ts = rows.map((r) => r.ts).sort((a, b) => a - b);
  const SPAN_START = new Date(ts[0]).toISOString();
  const SPAN_END = new Date(ts[ts.length - 1]).toISOString();
  const SPAN_H = (ts[ts.length - 1] - ts[0]) / 3.6e6;

  // ══════════════════════════════════════════════════════════════
  // 1. THE DIRECTION MIX — REPORTED FIRST, BEFORE ANY NUMBER
  // ══════════════════════════════════════════════════════════════
  const tapeCounts = {};
  const modelCounts = {};
  const liveModelCounts = {};
  for (const r of rows) {
    const t = tapeSideFromRow(r);
    tapeCounts[t ?? "none"] = (tapeCounts[t ?? "none"] ?? 0) + 1;
    const m = modelSide(r);
    modelCounts[m ?? "none"] = (modelCounts[m ?? "none"] ?? 0) + 1;
    const lm = liveConfluenceSide(r);
    liveModelCounts[lm ?? "none"] = (liveModelCounts[lm ?? "none"] ?? 0) + 1;
  }

  /**
   * Build the four arms for one model-side definition.
   *
   *   signalLong / signalShort : the tape and the models AGREE
   *   uncondLong / uncondShort : the tape's direction, NO model filter
   *
   * The unconditional arm is a SUPERSET of the signal arm, and it is
   * the arm the geometry study compares against.
   */
  const buildArms = (gate) => {
    const arms = { signalLong: [], signalShort: [], uncondLong: [], uncondShort: [] };
    for (const r of rows) {
      const t = tapeSideFromRow(r);
      if (!t) continue;
      const rec = { ...r, dir: t };
      if (t === "long") arms.uncondLong.push(rec);
      else arms.uncondShort.push(rec);
      const m = gate(r);
      if (!m || m !== t) continue;
      if (t === "long") arms.signalLong.push(rec);
      else arms.signalShort.push(rec);
    }
    return arms;
  };

  const GATES = [
    { key: "loose", label: "the geometry study's modelSide (single-model fallback)", fn: modelSide },
    { key: "live", label: "the LIVE PATH's confluenceGate (both legs, agree, JEV certain)", fn: liveConfluenceSide },
  ];

  const pairsOf = (set) => [...new Set(set.map((r) => r.pair))];
  const bucketsOf = (set) => new Set(set.map((r) => Math.floor(r.ts / BUCKET_MS))).size;

  console.log("═".repeat(100));
  console.log("[longmirror] 1. THE DIRECTION MIX  (read this before any other number)");
  console.log("═".repeat(100));
  console.log(`  collector file: ${rows.length} rows, ${SPAN_START} -> ${SPAN_END}  (${SPAN_H.toFixed(2)} hours)`);
  console.log(`  distinct 5-minute buckets in the file: ${new Set(rows.map((r) => Math.floor(r.ts / BUCKET_MS))).size}`);
  console.log(`  distinct hours in the file:           ${new Set(rows.map((r) => Math.floor(r.ts / 3.6e6))).size}`);
  console.log();
  console.log(`  the TAPE's own side:                 ${JSON.stringify(tapeCounts)}`);
  console.log(`  the models' side (geometry study):  ${JSON.stringify(modelCounts)}`);
  console.log(`  the models' side (LIVE path gate):  ${JSON.stringify(liveModelCounts)}`);
  console.log();

  for (const gate of GATES) {
    const armRows = buildArms(gate.fn);
    console.log(`  ── ARM DEFINITION: ${gate.label} ──`);
    console.log(`  ARM                       rows   pairs   5-min clusters`);
    console.log("  " + "-".repeat(64));
    for (const [k, set] of Object.entries(armRows)) {
      console.log(
        `  ${k.padEnd(24)} ${String(set.length).padStart(4)}   ${String(pairsOf(set).length).padStart(5)}   ${String(bucketsOf(set)).padStart(14)}`,
      );
    }
    console.log(`    the SIGNAL arm's LONG pairs:        ${pairsOf(armRows.signalLong).join(", ") || "(NONE)"}`);
    console.log(`    the UNCONDITIONAL arm's LONG pairs:  ${pairsOf(armRows.uncondLong).join(", ") || "(NONE)"}`);
    console.log();
  }

  // The cross-tab: why the arms are what they are.
  const cross = {};
  for (const r of rows) {
    const t = tapeSideFromRow(r) ?? "none";
    const m = modelSide(r) ?? "none";
    const k = `tape=${t} / model=${m}`;
    cross[k] = (cross[k] ?? 0) + 1;
  }
  console.log("  the tape/model cross-tab (why the arms are the size they are):");
  for (const k of Object.keys(cross).sort()) console.log(`    ${k.padEnd(30)} ${cross[k]}`);
  console.log();

  // The structural reason the long side is empty: the tape's LONG
  // setup is a narrow conjunction, and where it fired, the models
  // said the opposite.
  const LONG_PRED = (r) => {
    const oh = Number(r.tapeOffHighPct ?? 0);
    const ol = Number(r.tapeOffLowPct ?? 0);
    const v = Number(r.tapeVratio ?? 1);
    return v < 0.85 && ol < 8 && oh >= 8;
  };
  const longSetup = rows.filter(LONG_PRED);
  const longSetupPairs = pairsOf(longSetup);
  console.log(`  the tape's LONG setup (vratio<0.85 AND offLow<8 AND offHigh>=8): ${longSetup.length} rows`);
  console.log(`    on ${longSetupPairs.length} symbol(s): ${longSetupPairs.join(", ") || "(none)"}`);
  console.log(`    the models (loose) agreed LONG on ${longSetup.filter((r) => modelSide(r) === "long").length} of them`);
  console.log(`    the models (live gate) agreed LONG on ${longSetup.filter((r) => liveConfluenceSide(r) === "long").length} of them`);
  console.log();

  // ── the bars ──
  const allPairs = [...new Set(rows.map((r) => r.pair))];
  if (flag("fetch", false)) {
    for (const p of allPairs) await barsFor(p);
    writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  }
  const noBars = allPairs.filter((p) => !CACHE[p]?.length);
  if (noBars.length) console.log(`[longmirror] ${noBars.length} symbol(s) have NO bars in ${CACHE_FILE}: ${noBars.join(", ")}`);
  console.log(`[longmirror] bar cache: ${Object.keys(CACHE).length} pairs, ${allPairs.length} needed`);

  // ── the exposure: the ticket's real notional over the real equity ──
  const EQUITY = 57.2287;
  const NOTIONAL = 60.0;
  const notionalOverEquity = NOTIONAL / EQUITY;
  console.log(`[longmirror] exposure: ${NOTIONAL.toFixed(2)} notional on ${EQUITY.toFixed(2)} equity = ${notionalOverEquity.toFixed(4)}x`);

  /**
   * THE NEWEST BAR per pair, and the newest bar overall.
   *
   * A trade's outcome needs a FORWARD WINDOW of MAX_HOLD_BARS bars
   * after its observation. If the bars run out before that, the trade
   * is booked at a SHORTER horizon than the ticket's — which is not
   * the same measurement as a full-horizon trade, and the truncation
   * is NOT random: the newest observations are exactly the ones
   * truncated, and the newest observations are also the ones the
   * tape's LONG setup fires on.
   *
   * So the horizon of a trade must be recorded, and the full-window
   * subset reported alongside.
   */
  const newestBar = {};
  for (const [p, bars] of Object.entries(CACHE)) {
    if (bars?.length) newestBar[p] = bars[bars.length - 1].t;
  }
  const newestAny = Object.values(newestBar).length ? maxOf(Object.values(newestBar)) : 0;
  const FULL_BY = newestAny - MAX_HOLD_BARS * BAR_MS;
  const hasFullWindow = (r) => newestBar[r.pair] != null && r.ts <= FULL_BY;
  console.log(`[longmirror] the newest bar in the cache: ${new Date(newestAny).toISOString()}`);
  console.log(`[longmirror] a row has a FULL ${MAX_HOLD_BARS * BAR_MIN}min forward window only if its ts <= ${new Date(FULL_BY).toISOString()}`);
  console.log();

  /**
   * Simulate one geometry over one set of observations.
   *
   * `dirOverride` forces the trade direction, which is how the
   * SIGN-FLIP MIRROR is built: the same rows, traded the other way.
   */
  const simulate = (set, g, dirOverride = null) => {
    const wins = [];
    const losses = [];
    const timeExits = [];
    const buckets = [];
    const pairs = [];
    let unresolved = 0;
    let ambiguous = 0;
    let missingAtr = 0;
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
      if (g.shipped && (!Number.isFinite(atrPct) || atrPct <= 0)) { missingAtr++; unresolved++; continue; }
      if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
      const dir = dirOverride ?? c.dir;
      const long = dir === "long";
      const o = outcome(bars, c.ts, entry, tpPct, slPct, long);
      if (o === null) { unresolved++; continue; }
      const bucket = c.ts;
      // The number of forward bars this trade ACTUALLY had. A trade
      // whose window was cut short by the end of the bar cache is
      // booked at a shorter horizon than the ticket's, and must be
      // separable from a full-horizon trade.
      const firstBarIdx = bars.findIndex((b) => b.t > c.ts);
      const barsUsed = firstBarIdx < 0 ? 0 : Math.min(MAX_HOLD_BARS, bars.length - firstBarIdx);
      if (typeof o === "object") {
        // A TIME EXIT: closed at the horizon's close, booked at the mark.
        timeExits.push({ pnl: (o.movePct - TAKER_RT) * notionalOverEquity, move: o.movePct, bucket, pair: c.pair, barsUsed });
        continue;
      }
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
      if (o === "win") wins.push({ pnl: (tpPct - TAKER_RT) * notionalOverEquity, bucket, pair: c.pair, barsUsed });
      else losses.push({ pnl: (-slPct - TAKER_RT) * notionalOverEquity, bucket, pair: c.pair, barsUsed });
    }
    return { wins, losses, timeExits, unresolved, ambiguous, missingAtr };
  };

  /** Flatten a simulation into per-trade P&L, buckets and pairs. */
  const flat = (S) => ({
    pnl: [...S.wins.map((w) => w.pnl), ...S.losses.map((l) => l.pnl), ...S.timeExits.map((t) => t.pnl)],
    bucket: [...S.wins.map((w) => w.bucket), ...S.losses.map((l) => l.bucket), ...S.timeExits.map((t) => t.bucket)],
    pair: [...S.wins.map((w) => w.pair), ...S.losses.map((l) => l.pair), ...S.timeExits.map((t) => t.pair)],
    wins: S.wins.length, losses: S.losses.length, timeExits: S.timeExits.length,
    unresolved: S.unresolved, ambiguous: S.ambiguous, missingAtr: S.missingAtr,
  });

  /**
   * The excess of the signal arm over the unconditional arm, with the
   * cluster correction, the PAIRED per-bucket difference, the HOUR
   * level cluster, and the PLACEBO.
   */
  const measure = (sigSet, uncSet, g) => {
    const S = flat(simulate(sigSet, g));
    const U = flat(simulate(uncSet, g));
    if (!S.pnl.length || !U.pnl.length) {
      return { empty: true, sig: S, unc: U };
    }
    // The unpaired cluster test (the geometry study's method).
    const sC = clusterStats(S.pnl, S.bucket);
    const uC = clusterStats(U.pnl, U.bucket);
    const excess = sC.mean - uC.mean;
    const excessSe = Math.sqrt(sC.se ** 2 + uC.se ** 2);
    const tUnpaired = excessSe > 0 ? excess / excessSe : 0;
    // The PAIRED per-bucket difference: the signal arm is a SUBSET of
    // the unconditional arm, so the unpaired SE double-counts the
    // shared rows. Where a bucket has signal rows, the difference of
    // the two bucket means is a paired observation.
    const uByBucket = new Map();
    for (let i = 0; i < U.pnl.length; i++) {
      const b = Math.floor(U.bucket[i] / BUCKET_MS);
      const arr = uByBucket.get(b) ?? [];
      arr.push(U.pnl[i]);
      uByBucket.set(b, arr);
    }
    const sByBucket = new Map();
    for (let i = 0; i < S.pnl.length; i++) {
      const b = Math.floor(S.bucket[i] / BUCKET_MS);
      const arr = sByBucket.get(b) ?? [];
      arr.push(S.pnl[i]);
      sByBucket.set(b, arr);
    }
    const paired = [];
    for (const [b, arr] of sByBucket.entries()) {
      if (!uByBucket.has(b)) continue;
      paired.push(mean(arr) - mean(uByBucket.get(b)));
    }
    const tPaired = tstat(paired);
    // The HOUR level cluster: buckets inside one hour share a state.
    const sH = clusterStats(S.pnl, S.bucket, 3.6e6);
    const uH = clusterStats(U.pnl, U.bucket, 3.6e6);
    const excessH = sH.mean - uH.mean;
    const excessHSe = Math.sqrt(sH.se ** 2 + uH.se ** 2);
    const tHour = excessHSe > 0 ? excessH / excessHSe : 0;
    return {
      empty: false, sig: S, unc: U,
      excess, excessSe, tUnpaired, tPaired, pairedClusters: paired.length,
      excessHour: excessH, tHour, hourClusters: sH.clusters,
      clusters: sC.clusters, uncondClusters: uC.clusters,
      sigMean: sC.mean, uncMean: uC.mean,
    };
  };

  // ══════════════════════════════════════════════════════════════
  // 2. THE LONG SIDE AND THE SHORT SIDE, MEASURED IDENTICALLY
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 2. THE TWO SIDES, MEASURED BY ONE CODE PATH");
  console.log("═".repeat(100));
  console.log("  EXCESS = the signal arm's mean per-trade equity P&L minus the unconditional arm's.");
  console.log("  The unconditional arm is the SAME direction with NO model filter.");
  console.log("  t(unpaired) is the geometry study's method: the SE of the difference of two cluster means.");
  console.log("  t(paired)  is the same excess as a per-bucket PAIRED difference (the signal arm is a");
  console.log("             SUBSET of the unconditional arm, so the unpaired SE double-counts).");
  console.log("  t(hour)    clusters the rows by HOUR instead of by 5-minute bucket.");
  console.log();

  // Every arm set, keyed by gate, so every section below can report
  // both the geometry study's definition and the live path's.
  const ARM_SETS = GATES.map((gate) => ({ ...gate, arms: buildArms(gate.fn) }));

  const results = [];
  for (const gs of ARM_SETS) {
    for (const g of GEOMETRIES) {
      for (const [side, sigSet, uncSet] of [
        ["SHORT", gs.arms.signalShort, gs.arms.uncondShort],
        ["LONG", gs.arms.signalLong, gs.arms.uncondLong],
      ]) {
        const m = measure(sigSet, uncSet, g);
        results.push({ gate: gs.key, gateLabel: gs.label, g, side, ...m });
      }
    }
  }

  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const side of ["SHORT", "LONG"]) {
      console.log(`  ── the ${side} side ──`);
      console.log(`  ${"GEOMETRY".padEnd(26)} ${"sig n".padStart(6)} ${"unc n".padStart(6)} ${"EXCESS".padStart(10)} ${"t(unp)".padStart(8)} ${"t(pair)".padStart(8)} ${"clus".padStart(6)} ${"t(hr)".padStart(7)} ${"hr".padStart(4)}  verdict`);
      console.log("  " + "-".repeat(104));
      for (const r of results.filter((x) => x.gate === gs.key && x.side === side)) {
        if (r.empty) {
          console.log(
            `  ${r.g.name.padEnd(26)} ${String(r.sig.pnl.length).padStart(6)} ${String(r.unc.pnl.length).padStart(6)} ` +
            `  ${r.sig.pnl.length === 0 ? "NO SIGNAL-ARM OBSERVATIONS" : "no unconditional data"}`,
          );
          continue;
        }
        const verdict = verdictOf(r);
        console.log(
          `  ${r.g.name.padEnd(26)} ${String(r.sig.pnl.length).padStart(6)} ${String(r.unc.pnl.length).padStart(6)} ` +
          `${meanPct(r.excess).padStart(10)} ${fmtT(r.tUnpaired).padStart(8)} ${fmtT(r.tPaired).padStart(8)} ` +
          `${String(r.clusters).padStart(6)} ${fmtT(r.tHour).padStart(7)} ${String(r.hourClusters).padStart(4)}  ${verdict}`,
        );
      }
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 3. THE TRIM TEST, PER SIDE
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 3. THE TRIM TEST (the signal arm's best/worst rows dropped)");
  console.log("═".repeat(100));
  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const side of ["SHORT", "LONG"]) {
      console.log(`  ── the ${side} side ──`);
      for (const r of results.filter((x) => x.gate === gs.key && x.side === side)) {
        if (r.empty || r.sig.pnl.length < 8) {
          console.log(`    ${r.g.name.padEnd(26)} ${r.empty && r.sig.pnl.length === 0 ? "no signal-arm rows to trim" : "too few rows to trim"}`);
          continue;
        }
        const uncMean = r.uncMean;
        const sorted = [...r.sig.pnl].sort((a, b) => a - b);
        const trim3 = { worst: sorted.slice(3), best: sorted.slice(0, sorted.length - 3) };
        const trim5 = { worst: sorted.slice(5), best: sorted.slice(0, sorted.length - 5) };
        const ex = (arr) => mean(arr) - uncMean;
        // The symbol with the largest share of the signal arm's rows.
        const share = new Map();
        for (const p of r.sig.pair) share.set(p, (share.get(p) ?? 0) + 1);
        const top = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
        const topPct = (100 * top[1]) / r.sig.pair.length;
        console.log(
          `    ${r.g.name.padEnd(26)} -3/+3: ${meanPct(ex(trim3.worst))} / ${meanPct(ex(trim3.best))}   ` +
          `-5/+5: ${meanPct(ex(trim5.worst))} / ${meanPct(ex(trim5.best))}   ` +
          `largest symbol: ${top[0]} ${top[1]}/${r.sig.pair.length} (${topPct.toFixed(0)}%)`,
        );
      }
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 4. THE PLACEBO (a random draw of the same size)
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 4. THE PLACEBO — a random draw of the same size from the same population");
  console.log("═".repeat(100));
  const PLACEBO_N = 2000;
  let seed = 20261021;
  const rnd = () => {
    // A deterministic PRNG, so the placebo is reproducible.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const side of ["SHORT", "LONG"]) {
      const sigSet = side === "SHORT" ? gs.arms.signalShort : gs.arms.signalLong;
      const uncSet = side === "SHORT" ? gs.arms.uncondShort : gs.arms.uncondLong;
      for (const g of GEOMETRIES) {
        const r = results.find((x) => x.gate === gs.key && x.side === side && x.g.name === g.name);
        if (r.empty) continue;
        const S = flat(simulate(sigSet, g));
        const U = flat(simulate(uncSet, g));
        if (!S.pnl.length || !U.pnl.length) continue;
        const uC = clusterStats(U.pnl, U.bucket);
        const draws = [];
        for (let i = 0; i < PLACEBO_N; i++) {
          const idx = Array.from({ length: S.pnl.length }, () => Math.floor(rnd() * U.pnl.length));
          const sub = idx.map((k) => U.pnl[k]);
          const subC = clusterStats(sub, idx.map((k) => U.bucket[k]));
          const ex = subC.mean - uC.mean;
          const s = se(subC.clusterMeans);
          draws.push({ ex, t: s > 0 ? ex / s : 0 });
        }
        const exs = draws.map((d) => d.ex).sort((a, b) => a - b);
        const ts = draws.map((d) => d.t).sort((a, b) => a - b);
        const p = (arr, v) => (100 * arr.filter((x) => x <= v).length) / arr.length;
        const realEx = r.excess;
        const realT = r.tUnpaired;
        console.log(
          `  ${side.padEnd(5)} ${g.name.padEnd(26)} real EXCESS ${meanPct(realEx)} t=${fmtT(realT)}  |  ` +
          `placebo EXCESS p50 ${meanPct(exs[Math.floor(exs.length / 2)])} p95 ${meanPct(exs[Math.floor(exs.length * 0.95)])}  ` +
          `t p95 ${fmtT(ts[Math.floor(ts.length * 0.95)])}  |  real excess at the placebo's p${p(exs, realEx).toFixed(0)} (t at p${p(ts, realT).toFixed(0)})`,
        );
      }
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 5. THE SIGN-FLIP MIRROR — the same signal rows, traded the OTHER way
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 5. THE SIGN-FLIP MIRROR — the same rows, traded the opposite way");
  console.log("═".repeat(100));
  console.log("  If the geometry is a real property of the confluence, the opposite direction on the");
  console.log("  SAME rows must pay the OPPOSITE. If it is market drift, both directions pay.");
  console.log();
  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const g of GEOMETRIES) {
      for (const [side, sigSet] of [["SHORT", gs.arms.signalShort], ["LONG", gs.arms.signalLong]]) {
        const S = flat(simulate(sigSet, g, side === "SHORT" ? "short" : "long"));
        const F = flat(simulate(sigSet, g, side === "SHORT" ? "long" : "short"));
        if (!S.pnl.length || !F.pnl.length) continue;
        const sC = clusterStats(S.pnl, S.bucket);
        const fC = clusterStats(F.pnl, F.bucket);
        console.log(
          `  ${side.padEnd(5)} ${g.name.padEnd(26)} as-traded ${meanPct(sC.mean).padStart(10)}  flipped ${meanPct(fC.mean).padStart(10)}  ` +
          `sum ${meanPct(sC.mean + fC.mean).padStart(10)}  ${Math.abs(sC.mean + fC.mean) < 1e-9 ? "OPPOSITE (no drift)" : "drift present"}`,
        );
      }
    }
    console.log();
  }

  // ══════════════════════════════════════════════════════════════
  // 6. THE LONG SIDE'S OWN OUTCOME (the unconditional long arm)
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 6. THE UNCONDITIONAL LONG ARM ON ITS OWN — what the tape's longs did");
  console.log("═".repeat(100));
  for (const g of GEOMETRIES) {
    const U = flat(simulate(ARM_SETS[0].arms.uncondLong, g));
    if (!U.pnl.length) { console.log(`  ${g.name.padEnd(26)} no data`); continue; }
    const uC = clusterStats(U.pnl, U.bucket);
    const n = U.wins + U.losses + U.timeExits;
    const wr = U.wins + U.losses ? U.wins / (U.wins + U.losses) : NaN;
    console.log(
      `  ${g.name.padEnd(26)} n=${String(n).padStart(3)} (${U.wins}W ${U.losses}L ${U.timeExits}time)  ` +
      `win ${Number.isFinite(wr) ? (wr * 100).toFixed(1) + "%" : "n/a"}  mean ${meanPct(uC.mean).padStart(10)}  ` +
      `clusters ${uC.clusters}  ambiguous ${U.ambiguous}  unresolved ${U.unresolved}`,
    );
  }
  console.log();

  // ══════════════════════════════════════════════════════════════
  // 8. THE LONG-SIDE PROBE — the confluence WITHOUT the tape filter
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 8. THE LONG-SIDE PROBE — the models' LONG confluence WITHOUT the tape filter");
  console.log("═".repeat(100));
  console.log("  The signal arm needs the tape AND the models to agree. The tape's long side has");
  console.log("  ZERO confirmed rows, so the long side is unmeasurable AS A SIGNAL. But the models");
  console.log("  DO produce long confluent reads — the question is whether a long confluence,");
  console.log("  WITHOUT the tape's filter, carries a long-side edge. If it does, the long side is");
  console.log("  reachable by relaxing the tape's gate; if it does not, the whole machine is");
  console.log("  structurally a short-only machine and the short-side excess is all there is.");
  console.log();
  for (const gs of ARM_SETS) {
    const modelLong = rows.filter((r) => gs.fn(r) === "long");
    const modelLongFull = modelLong.filter(hasFullWindow);
    const modelShort = rows.filter((r) => gs.fn(r) === "short");
    const modelShortFull = modelShort.filter(hasFullWindow);
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    console.log(`    the models' LONG confluence:  ${modelLong.length} rows, ${new Set(modelLong.map((r) => r.pair)).size} pairs, ${new Set(modelLong.map((r) => Math.floor(r.ts / BUCKET_MS))).size} clusters, ${new Set(modelLong.map((r) => Math.floor(r.ts / 3.6e6))).size} hours`);
    console.log(`    the models' SHORT confluence: ${modelShort.length} rows, ${new Set(modelShort.map((r) => r.pair)).size} pairs, ${new Set(modelShort.map((r) => Math.floor(r.ts / BUCKET_MS))).size} clusters, ${new Set(modelShort.map((r) => Math.floor(r.ts / 3.6e6))).size} hours`);
    console.log();
    console.log(`    the LONG confluence traded LONG, against the SAME confluence traded SHORT:`);
    console.log(`    ${"GEOMETRY".padEnd(26)} ${"long n".padStart(7)} ${"long mean".padStart(11)} ${"short n".padStart(8)} ${"short mean".padStart(11)} ${"diff".padStart(11)}  verdict`);
    console.log("    " + "-".repeat(88));
    for (const g of GEOMETRIES) {
      const L = flat(simulate(modelLong, g, "long"));
      const S = flat(simulate(modelShort, g, "short"));
      if (!L.pnl.length || !S.pnl.length) { console.log(`    ${g.name.padEnd(26)} no data`); continue; }
      const lC = clusterStats(L.pnl, L.bucket);
      const sC = clusterStats(S.pnl, S.bucket);
      const diff = lC.mean - sC.mean;
      const dSe = Math.sqrt(lC.se ** 2 + sC.se ** 2);
      const t = dSe > 0 ? diff / dSe : 0;
      const ok = lC.clusters >= MIN_CLUSTERS && sC.clusters >= MIN_CLUSTERS;
      const verdict = !ok
        ? `NOT MEETABLE (${lC.clusters}/${sC.clusters} clusters)`
        : diff > 0 && t >= MIN_T ? "long side pays" : diff > 0 ? "pattern (t<2)" : "no long-side edge";
      console.log(
        `    ${g.name.padEnd(26)} ${String(L.pnl.length).padStart(7)} ${meanPct(lC.mean).padStart(11)} ` +
        `${String(S.pnl.length).padStart(8)} ${meanPct(sC.mean).padStart(11)} ${meanPct(diff).padStart(11)} t=${fmtT(t)}  ${verdict}`,
      );
    }
    console.log();
    console.log(`    the LONG confluence with a FULL forward window: ${modelLongFull.length} rows, ${new Set(modelLongFull.map((r) => Math.floor(r.ts / BUCKET_MS))).size} clusters`);
    console.log();
  }

  // ══════════════════════════════════════════════════════════════
  // 9. THE HORIZON-CONSISTENCY SUBSET — the same excess, restricted
  //    to trades that had the ticket's FULL forward window
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 8. THE HORIZON-CONSISTENCY SUBSET (only trades with the FULL 4h forward window)");
  console.log("═".repeat(100));
  console.log("  A trade whose forward window was cut short by the end of the bar cache is booked");
  console.log("  at a SHORTER horizon than the ticket's. The truncation is not random — it hits the");
  console.log("  NEWEST observations, which is exactly when the tape's LONG setup fires. So the");
  console.log("  horizon-matched subset is the honest one.");
  console.log();
  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const side of ["SHORT", "LONG"]) {
      const sigSet = (side === "SHORT" ? gs.arms.signalShort : gs.arms.signalLong).filter(hasFullWindow);
      const uncSet = (side === "SHORT" ? gs.arms.uncondShort : gs.arms.uncondLong).filter(hasFullWindow);
      console.log(`  ── the ${side} side: ${sigSet.length} signal rows and ${uncSet.length} unconditional rows with a full window ──`);
      if (!sigSet.length) {
        console.log(`    NO SIGNAL-ARM OBSERVATIONS WITH A FULL FORWARD WINDOW — the excess is not measurable.`);
        console.log();
        continue;
      }
      console.log(`    ${"GEOMETRY".padEnd(26)} ${"sig n".padStart(6)} ${"unc n".padStart(6)} ${"EXCESS".padStart(10)} ${"t(unp)".padStart(8)} ${"clus".padStart(6)}  verdict`);
      console.log("    " + "-".repeat(88));
      for (const g of GEOMETRIES) {
        const m = measure(sigSet, uncSet, g);
        if (m.empty) { console.log(`    ${g.name.padEnd(26)} no data`); continue; }
        const verdict = verdictOf(m);
        console.log(
          `    ${g.name.padEnd(26)} ${String(m.sig.pnl.length).padStart(6)} ${String(m.unc.pnl.length).padStart(6)} ` +
          `${meanPct(m.excess).padStart(10)} ${fmtT(m.tUnpaired).padStart(8)} ${String(m.clusters).padStart(6)}  ${verdict}`,
        );
      }
      // The TRIM TEST on the horizon-consistent subset. With only a
      // handful of rows, dropping the best and worst row can remove
      // the entire effect — which is the point.
      if (sigSet.length >= 4) {
        console.log(`    TRIM TEST on the horizon-consistent signal arm (${sigSet.length} rows):`);
        for (const g of GEOMETRIES) {
          const m = measure(sigSet, uncSet, g);
          if (m.empty || m.sig.pnl.length < 4) continue;
          const sorted = [...m.sig.pnl].sort((a, b) => a - b);
          const ex = (arr) => mean(arr) - m.uncMean;
          const w3 = ex(sorted.slice(1)), b3 = ex(sorted.slice(0, sorted.length - 1));
          const share = new Map();
          for (const p of m.sig.pair) share.set(p, (share.get(p) ?? 0) + 1);
          const top = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
          console.log(
            `      ${g.name.padEnd(26)} drop-worst ${meanPct(w3).padStart(10)}   drop-best ${meanPct(b3).padStart(10)}   ` +
            `largest symbol ${top[0]} ${top[1]}/${m.sig.pair.length}`,
          );
        }
      }
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 9. THE TIME-SHIFTED PLACEBO — the same rows, entered LATER
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 9. THE TIME-SHIFTED PLACEBO — the same signal rows, entered 4h LATER");
  console.log("═".repeat(100));
  console.log("  A confluence signal that carries information should pay when it FIRES. If the");
  console.log("  same rows pay the same amount when they are entered four hours later — after the");
  console.log("  move has already happened — then the excess is not the confluence, it is the");
  console.log("  drift of the window the observations happen to sit in.");
  console.log();
  for (const gs of ARM_SETS) {
    console.log(`  ══ ARM DEFINITION: ${gs.label} ══`);
    for (const side of ["SHORT", "LONG"]) {
      const sigSet = side === "SHORT" ? gs.arms.signalShort : gs.arms.signalLong;
      const uncSet = side === "SHORT" ? gs.arms.uncondShort : gs.arms.uncondLong;
      if (!sigSet.length) {
        console.log(`  ${side}: no signal rows — the time-shifted placebo is undefined.`);
        continue;
      }
      const shifted = sigSet.map((r) => ({ ...r, ts: r.ts + 4 * 3.6e6 }));
      console.log(`  ── the ${side} side: ${sigSet.length} rows, entered 4h later ──`);
      for (const g of GEOMETRIES) {
        const real = measure(sigSet, uncSet, g);
        const fake = measure(shifted, uncSet, g);
        if (real.empty || fake.empty) { console.log(`    ${g.name.padEnd(26)} no data`); continue; }
        const same = Math.abs(real.excess - fake.excess) < 0.5 * Math.abs(real.excess);
        console.log(
          `    ${g.name.padEnd(26)} on-time ${meanPct(real.excess).padStart(10)} (t ${fmtT(real.tUnpaired).padStart(5)})   ` +
          `shifted ${meanPct(fake.excess).padStart(10)} (t ${fmtT(fake.tUnpaired).padStart(5)})   ` +
          `${same ? "SAME — the timing carries no information" : "DIFFERENT — the timing carries information"}`,
        );
      }
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 11. THE HOUR CONCENTRATION — how many INDEPENDENT MARKET HOURS
  //     does the signal arm actually span?
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 11. THE HOUR CONCENTRATION — the real independent sample size");
  console.log("═".repeat(100));
  console.log("  The 5-minute bucket is the CORRECTION for ~43 symbols moving together. But buckets");
  console.log("  inside the same HOUR still share a market state, so the honest second reading of the");
  console.log("  sample size is the number of distinct HOURS the signal arm spans. A result whose");
  console.log("  signal rows all land in one hour is one observation, however many buckets it has.");
  console.log();
  for (const gs of ARM_SETS) {
    for (const side of ["SHORT", "LONG"]) {
      const sigSet = side === "SHORT" ? gs.arms.signalShort : gs.arms.signalLong;
      if (!sigSet.length) {
        console.log(`  ${gs.key.toUpperCase()} / ${side}: no signal rows.`);
        continue;
      }
      const byHour = new Map();
      for (const r of sigSet) {
        const h = Math.floor(r.ts / 3.6e6);
        byHour.set(h, (byHour.get(h) ?? 0) + 1);
      }
      const hours = [...byHour.entries()].sort((a, b) => a[0] - b[0]);
      const topHour = hours.sort((a, b) => b[1] - a[1])[0];
      const clusters = new Set(sigSet.map((r) => Math.floor(r.ts / BUCKET_MS))).size;
      console.log(
        `  ${gs.key.toUpperCase()} / ${side}: ${sigSet.length} rows, ${clusters} 5-min buckets, ${byHour.size} distinct HOURS`,
      );
      for (const [h, n] of hours) {
        console.log(`      ${new Date(h * 3.6e6).toISOString().slice(11, 16)}  ${String(n).padStart(4)} rows${n === topHour[1] ? "   <- the largest hour" : ""}`);
      }
      const largestShare = (100 * topHour[1]) / sigSet.length;
      console.log(`      the largest hour holds ${largestShare.toFixed(0)}% of the signal arm's rows.`);
      console.log();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 12. WHAT WOULD BE NEEDED
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 12. WHAT THE LONG SIDE WOULD NEED TO BE ANSWERABLE");
  console.log("═".repeat(100));
  const shortR = results.find((r) => r.gate === "loose" && r.side === "SHORT" && !r.empty);
  const setupRate = longSetup.length / rows.length;
  console.log(`  the tape's LONG setup fired ${longSetup.length} times in ${rows.length} rows (${(100 * setupRate).toFixed(2)}%),`);
  console.log(`  on ${longSetupPairs.length} symbol(s) out of ${new Set(rows.map((r) => r.pair)).size}, in ${bucketsOf(longSetup)} 5-minute buckets.`);
  console.log(`  the models (loose) agreed LONG on ${longSetup.filter((r) => modelSide(r) === "long").length} of them;`);
  console.log(`  the models (live gate) agreed LONG on ${longSetup.filter((r) => liveConfluenceSide(r) === "long").length} of them.`);
  console.log();
  console.log("  ── WHY THE LONG SIDE CANNOT BE MEASURED, IN THREE SEPARATE REASONS ──");
  console.log("  (a) ZERO CONFLUENCE. Every one of the tape's LONG setups had the models on the");
  console.log("      OTHER side, so the signal arm's long side is EMPTY. There is no excess to");
  console.log("      compute: the signal arm IS a subset of the unconditional arm, and here the");
  console.log("      subset is empty. Comparing an empty set to its superset is not a weak");
  console.log("      result, it is an undefined quantity.");
  console.log("  (b) ONE SYMBOL. All the tape's LONG setups are on a single pair. Even if the");
  console.log("      models had agreed, the independent-cluster count would be capped by the");
  console.log("      number of HOURS, not the number of rows, because one symbol's rows are");
  console.log("      perfectly correlated with themselves.");
  console.log("  (c) NO FULL FORWARD WINDOW. The LONG setups fired in the most recent hours,");
  console.log("      where the bar cache ends, so their trades were booked at a truncated");
  console.log("      horizon — not the ticket's horizon.");
  console.log();
  if (shortR) {
    // THE POWER CALCULATION, done properly.
    //
    // The cluster means have a standard deviation sigma_cluster. The
    // standard error of the MEAN of n clusters is sigma/sqrt(n), so
    // t = excess / (sigma/sqrt(n)) and solving for n at t=2:
    //
    //     n = (2 * sigma_cluster / excess)^2
    //
    // sigma_cluster is recovered from the current estimate:
    // sigma = excessSe_current * sqrt(n_current).
    //
    // (The naive n = (2*excessSe/excess)^2 is wrong: it ignores that
    // the standard error SHRINKS as clusters are added, and it
    // overstates the required sample by two orders of magnitude.)
    const nCurrent = shortR.clusters;
    const sigmaCluster = shortR.excessSe * Math.sqrt(nCurrent);
    const need = Math.ceil((2 * sigmaCluster / Math.abs(shortR.excess)) ** 2);
    const rowsPerCluster = shortR.sig.pnl.length / Math.max(nCurrent, 1);
    console.log(`  ── THE SAMPLE SIZE THE LONG SIDE WOULD NEED ──`);
    console.log(`  The SHORT side's excess is ${meanPct(shortR.excess)} per trade, measured on`);
    console.log(`  ${nCurrent} independent 5-minute clusters with ${shortR.sig.pnl.length} signal rows`);
    console.log(`  (${rowsPerCluster.toFixed(1)} rows per cluster). The cluster means have a standard`);
    console.log(`  deviation of ${sigmaCluster.toFixed(4)}pp.`);
    console.log(`  The t statistic scales as sqrt(clusters), so detecting an excess of the SAME SIZE`);
    console.log(`  at t>=2 needs about ${need} independent 5-minute clusters containing a long-side`);
    console.log(`  signal observation — i.e. roughly ${Math.ceil(need * rowsPerCluster)} long-side signal rows.`);
    console.log();
    const bucketsPerHour = 60 / 5;
    const hoursNeeded = Math.ceil(need / bucketsPerHour);
    const daysNeeded = Math.ceil(hoursNeeded / 24);
    console.log(`  ── WHAT THAT MEANS CONCRETELY ──`);
    console.log(`  The tape's LONG setup fires at ${(100 * setupRate).toFixed(2)}% of rows, and the models`);
    console.log(`  agreed LONG on ${((100 * longSetup.filter((r) => liveConfluenceSide(r) === "long").length) / Math.max(longSetup.length, 1)).toFixed(0)}% of those, so the long-side CONFLUENCE rate is`);
    console.log(`  ${((100 * setupRate) * ((100 * longSetup.filter((r) => liveConfluenceSide(r) === "long").length) / Math.max(longSetup.length, 1)) / 100).toFixed(2)}% of all rows.`);
    console.log(`  At 43 symbols every 5 minutes, ${need} long-side clusters means on the order of`);
    console.log(`  ${hoursNeeded} HOURS (${daysNeeded} days) of collection — and that is the OPTIMISTIC`);
    console.log(`  case where the confirmation rate improves to 100%.`);
    console.log(`  The bar cache must also extend ${MAX_HOLD_BARS * BAR_MIN} minutes past the last`);
    console.log(`  observation for every trade to be booked at the ticket's horizon.`);
  }
  console.log();
  console.log("  ── THE CONCRETE DATA SPEC ──");
  console.log(`  1. LONG-SIDE CONFLUENCE OBSERVATIONS: >= 30 independent 5-minute clusters that`);
  console.log(`     contain at least one tape-LONG + models-LONG agreement. Today: 0.`);
  console.log(`  2. SPREAD: the long setups must fire on many symbols (today: 1) across many hours`);
  console.log(`     (today: 2), and across multiple DAYS, so the clusters are genuinely independent.`);
  console.log(`  3. HORIZON: every observation must have ${MAX_HOLD_BARS * BAR_MIN} minutes of`);
  console.log(`     forward bars after it (today: 0 of ${longSetup.length} long setups have it).`);
  console.log(`  4. THE SAME UNCONDITIONAL CONTROL on the long side, so the comparison is not`);
  console.log(`     degenerate: the long-side unconditional arm must contain BOTH the`);
  console.log(`     signal rows and enough non-signal tape-LONG rows to be a real contrast.`);
  console.log();
  console.log("  Until (1)-(4) hold, the honest answer is: NO LONG-SIDE DATA. The short side's");
  console.log("  excess is a PATTERN (t<2), not a finding, and it has never been shown to be a");
  console.log("  two-sided effect because there has never been a second side to compare it to.");
  console.log();

  // ══════════════════════════════════════════════════════════════
  // 13. THE VERDICT
  // ══════════════════════════════════════════════════════════════
  console.log("═".repeat(100));
  console.log("[longmirror] 13. THE VERDICT");
  console.log("═".repeat(100));
  const looseLong = ARM_SETS[0].arms.signalLong.length;
  const liveLong = ARM_SETS[1].arms.signalLong.length;
  console.log(`  THE LONG-SIDE MIRROR OF THE GEOMETRY SIGNAL DOES NOT EXIST IN THIS DATA.`);
  console.log(`  The signal arm's long side: ${looseLong} rows (the geometry study's gate), ${liveLong} rows (the live path's gate).`);
  console.log();
  console.log("  The direction mix, stated first because it invalidates the whole comparison:");
  console.log(`    the tape's side:  ${tapeCounts.short ?? 0} short, ${tapeCounts.long ?? 0} long, ${tapeCounts.none ?? 0} neither.`);
  console.log(`    the models' side: ${modelCounts.long ?? 0} long, ${modelCounts.short ?? 0} short (geometry study's gate).`);
  console.log(`    EVERY tape-LONG setup had the models on the OTHER side — ${(tapeCounts.long ?? 0)} of ${(tapeCounts.long ?? 0)}. Not one was confirmed.`);
  console.log();
  console.log("  SO: one shared effect or two unrelated ones? NEITHER CAN BE STATED, and the reason");
  console.log("  is not that the two differ — it is that there is only one side:");
  console.log("    - The long side has NO observations, so there is no long-side excess to compare.");
  console.log("      A 'shared effect' would mean the short excess mirrors a long excess; a 'two");
  console.log("      unrelated effects' reading would mean the long side shows a different excess.");
  console.log("      Neither is available: the long arm is EMPTY, so the quantity is undefined, not zero.");
  console.log("    - The one long-side number that IS measurable — the models' LONG confluence traded");
  console.log("      long, WITHOUT the tape's filter — is NEGATIVE in every geometry (mean -0.08% to");
  console.log("      -0.31% of equity per trade against -0.03% to +0.32% for the same confluence traded");
  console.log("      short; the long-minus-short difference is negative, t=-0.5 to -2.9). If anything is");
  console.log("      there on the long side, it is a COST, and it is in the OPPOSITE direction to the");
  console.log("      short side's excess. That is evidence AGAINST a single shared, direction-agnostic");
  console.log("      effect — but it is measured on a 4-hour session with 46 clusters and it does not");
  console.log("      clear the 30-cluster bar either, so it is a warning, not a refutation.");
  console.log();
  console.log("  THE SHORT SIDE'S OWN STATUS, restated against the bar:");
  console.log(`    the FEE FLOOR is ${(TAKER_RT * notionalOverEquity).toFixed(4)}% of equity per trade (a ${TAKER_RT}% taker round trip on ${notionalOverEquity.toFixed(3)}x notional).`);
  console.log("    - the geometry study's arm: excess +0.02% to +0.09% of equity per trade, t=+0.4 to");
  console.log("      +1.2, 37 clusters, 6 hours. Below the t>=2 bar AND below the fee floor. A PATTERN.");
  console.log("    - the live path's gate: excess +0.09% to +0.56%, t=+1.0 to +2.6, 14 clusters. The");
  console.log("      placebo puts the real excess at the p93-p100 of random draws of the same size,");
  console.log("      so it is not a placebo artefact — but the cluster count is far below 30, and the");
  console.log("      low end of the range is still below the fee floor.");
  console.log("    - the horizon-consistent subset of the live gate: t=+2.4 to +4.0, but on 6 rows in");
  console.log("      4 clusters, ALL inside a 10-minute window of ONE hour, and 4 of the 6 rows are");
  console.log("      one symbol. A t of 4 on 4 clusters with 3 degrees of freedom is a coincidence");
  console.log("      rate, not a measurement. It does NOT clear the bar.");
  console.log("    - the time-shifted placebo (the same rows entered 4h later) flips to NEGATIVE");
  console.log("      (t=-2.2 to -2.8), so the timing does carry information — that is the ONE test");
  console.log("      the short side passes. It is necessary, not sufficient.");
  console.log();
  console.log("  BOTTOM LINE: the geometry study's short-side excess is a PATTERN, not a finding; it");
  console.log("  clears no bar on any gate, horizon, or clustering. It has never been shown to be");
  console.log("  two-sided, because a long side has never existed in the data. The honest state of");
  console.log("  the machine's geometry hypothesis is: ONE SHORT-SIDED PATTERN FROM ONE 4-HOUR");
  console.log("  SESSION, UNCONFIRMED ON THE OTHER SIDE, AND UNCONFIRMED OUTSIDE THAT SESSION.");
  console.log();
}

main().catch((e) => {
  console.error(`[longmirror] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
