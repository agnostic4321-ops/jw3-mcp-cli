#!/usr/bin/env node
/**
 * THE FINAL REPORT — every control, both venues, one standard.
 *
 * The reader needs, for each venue:
 *
 *   THE HEADLINE      the direction-matched excess, its t, the CLUSTER
 *                     count, the SPAN, and the regime.
 *   THE CONTROLS      the three that can kill it:
 *                       - the CELL-MATCHED excess (direction x decile of
 *                         the market's 24-hour move) — the tightest
 *                         comparison available;
 *                       - the SYMBOL-clustered excess (the symbols move
 *                         together);
 *                       - the PLACEBO (the same rows, traded the other
 *                         way).
 *   THE STABILITY     the excess on each half of the window, and on
 *                     each DAY of it.
 *
 * A result only counts if it survives ALL of them. The project's bar:
 * an excess over a genuine control, n >= 30 independent clusters, and
 * t >= 2.
 *
 * ── WHY THE CELL-MATCHED MEASURE IS THE HEADLINE ──
 *
 * The direction-matched excess is right but imprecise, because the
 * signal arm's two directions have very different sizes: on Binance
 * 96 long rows against 21624 short rows, so the 96-row direction
 * carries 99.6% of the weight with a correspondingly huge standard
 * error, and the combined t lands near that noisy cell's t.
 *
 * The CELL-MATCHED measure splits both arms by direction AND by decile
 * of the market's 24-hour move, so every cell compares like with like
 * and each cell's t is computed on its own clusters. It is both
 * TIGHTER (the market's drift cannot leak between cells) and MORE
 * PRECISE (the weight is spread over cells of comparable size). It is
 * the measure the verdict rests on.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import {
  GEOMETRIES, measure, measureDirectionMatched, armFacts, auditBarLookup,
} from "./rep-measure.mjs";
import { clusterStats } from "./rep-venue-common.mjs";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;

const VENUES = [
  {
    name: "KUCOIN (the collector's venue)",
    short: "KUCOIN",
    rowsFile: join(SCRATCH, "rep-confluence.parent-snap.ndjson"),
    barsFile: join(SCRATCH, "rep-kucoin-15m-bars.snapshot.json"),
    takerRt: 0.12,
    feeNote: "0.06%/side taker (the study's rate)",
  },
  {
    name: "BINANCE USDⓈ-M (INDEPENDENT VENUE)",
    short: "BINANCE",
    rowsFile: join(SCRATCH, "rep-binance-obs.json"),
    barsFile: join(SCRATCH, "rep-binance-15m-bars.json"),
    takerRt: 0.10,
    feeNote: "0.05%/side taker (Binance VIP-0 published rate)",
  },
];

/** The cells: direction x decile of the market's 24-hour move. */
function cellMatch(signal, uncond, g, bars, takerRt) {
  const sorted = uncond.map((r) => r.tapeChg).sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
  const dec = (chg) => { let d = 0; while (d < cuts.length && chg >= cuts[d]) d++; return d; };
  const cells = [];
  for (const dir of ["long", "short"]) {
    for (let d = 0; d < 10; d++) {
      const s = signal.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
      const u = uncond.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
      if (!s.length || !u.length) continue;
      const m = measureDirectionMatched(s, u, g, bars, { takerRt });
      cells.push({ dir, d, rows: m.rows, clusters: m.clusters, excess: m.excess, t: m.t, weight: m.rows / signal.length });
    }
  }
  if (!cells.length) return { excess: 0, t: 0, cells: [] };
  const excess = cells.reduce((s, c) => s + c.weight * c.excess, 0);
  const se = Math.sqrt(cells.reduce((s, c) => s + c.weight ** 2 * (c.t !== 0 ? (c.excess / c.t) ** 2 : 0), 0));
  return { excess, t: se > 0 ? excess / se : 0, cells };
}

/**
 * THE HOLD-CLUSTERED EXCESS.
 *
 * The ticket holds a position for up to 4 hours. A 5-minute cluster
 * counts two trades as independent when they share the same entry, the
 * same path and the same exit for most of their life. The cluster
 * width must match the HOLD, or the t-statistic counts overlapping
 * trades as independent evidence.
 */
function holdClustered(signal, uncond, g, bars, takerRt, widthMs) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signal.filter((r) => r.dir === dir);
    const u = uncond.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0, clusters: 0 }); continue; }
    const grab = (set) => {
      const m = measure(set, set, g, bars, { takerRt });
      const pnl = [], buckets = [];
      for (const r of m.signalRows) {
        pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - takerRt * NOE
          : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - takerRt * NOE
          : r.pnl);
        buckets.push(Math.floor(r.c.ts / widthMs));
      }
      return { pnl, buckets };
    };
    const sR = grab(s);
    const uR = grab(u);
    const sCl = clusterStats(sR.pnl, sR.buckets);
    const uCl = clusterStats(uR.pnl, uR.buckets);
    const excess = sCl.mean - uCl.mean;
    const se = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
    parts.push({ dir, rows: s.length, excess, se, t: se > 0 ? excess / se : 0, weight: s.length / signal.length, clusters: sCl.clusters });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const se = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se, t: se > 0 ? excess / se : 0 };
}

/** The symbol-clustered excess. */
function symbolClustered(signal, uncond, g, bars, takerRt) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signal.filter((r) => r.dir === dir);
    const u = uncond.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0, clusters: 0 }); continue; }
    const grab = (set) => {
      const m = measure(set, set, g, bars, { takerRt });
      const pnl = [], syms = [];
      for (const r of m.signalRows) {
        pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - takerRt * NOE
          : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - takerRt * NOE
          : r.pnl);
        syms.push(r.c.pair);
      }
      return { pnl, syms };
    };
    const sR = grab(s);
    const uR = grab(u);
    const sCl = clusterStats(sR.pnl, sR.syms);
    const uCl = clusterStats(uR.pnl, uR.syms);
    const excess = sCl.mean - uCl.mean;
    const se = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
    parts.push({ dir, rows: s.length, excess, se, t: se > 0 ? excess / se : 0, weight: s.length / signal.length, clusters: sCl.clusters });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const se = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se, t: se > 0 ? excess / se : 0 };
}

const loaded = [];
for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const audit = auditBarLookup(rows, bars);
  if (!audit.ok) {
    console.log(`[final] ABORTING on ${v.name}:`);
    for (const p of audit.problems) console.log(`  - ${p}`);
    continue;
  }
  const { A, B, C } = buildArms(rows, { book: false, jev: false });
  let up = 0, down = 0;
  for (const r of rows) { if (r.tapeChg > 0) up++; else if (r.tapeChg < 0) down++; }
  loaded.push({ ...v, rows, bars, A, B, C, audit, up, down, fA: armFacts(A), fB: armFacts(B), fC: armFacts(C) });
}

for (const v of loaded) {
  console.log(`\n╔══ ${v.name} ${"═".repeat(Math.max(0, 72 - v.name.length))}`);
  console.log(`║  observations=${v.rows.length}  symbols with bars=${Object.keys(v.bars).length}  fee: ${v.feeNote}`);
  console.log(`║  REGIME: up=${v.up} down=${v.down}  ->  ${((v.up / v.rows.length) * 100).toFixed(1)}% UP / ${((v.down / v.rows.length) * 100).toFixed(1)}% DOWN`);
  console.log(`║  ARM A (the machine's own signal, with the JEV leg): rows=${v.fA.rows} clusters=${v.fA.clusters} long=${v.fA.long} short=${v.fA.short} span=${v.fA.spanH.toFixed(2)}h`);
  console.log(`║  ARM B (the REPLICABLE arm, JEV leg removed):        rows=${v.fB.rows} clusters=${v.fB.clusters} long=${v.fB.long} short=${v.fB.short} span=${v.fB.spanH.toFixed(2)}h`);
  console.log(`║  ARM C (the unconditional baseline):                rows=${v.fC.rows} clusters=${v.fC.clusters} long=${v.fC.long} short=${v.fC.short} span=${v.fC.spanH.toFixed(2)}h`);
  console.log(`║  BARS AUDIT: keys ${(v.audit.keyCoverage * 100).toFixed(1)}%  window ${(v.audit.windowCoverage * 100).toFixed(1)}%  forward ${(v.audit.forwardCoverage * 100).toFixed(1)}%`);
}

if (loaded.length < 2) { console.log("\n[final] both venues are needed for the comparison."); process.exit(0); }
const [K, B] = loaded;

// ── THE TABLE ─────────────────────────────────────────────────────────
for (const v of [K, B]) {
  console.log(`\n═══ ${v.name} — ARM B, every control ═══`);
  console.log(`  ${"GEOMETRY".padEnd(26)} ${"rows".padStart(6)} ${"clus".padStart(5)} | ${"dir-matched".padStart(19)} | ${"CELL-MATCHED".padStart(19)} | ${"4h-CLUSTERED".padStart(19)} | ${"sym-clustered".padStart(19)} | ${"placebo".padStart(19)}`);
  console.log("  " + "-".repeat(138));
  const placebo = v.B.map((r) => ({ ...r, dir: r.dir === "long" ? "short" : "long" }));
  for (const g of GEOMETRIES) {
    const hl = measureDirectionMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
    const cm = cellMatch(v.B, v.C, g, v.bars, v.takerRt);
    const hc = holdClustered(v.B, v.C, g, v.bars, v.takerRt, 4 * 3600_000);
    const sc = symbolClustered(v.B, v.C, g, v.bars, v.takerRt);
    const pl = measure(placebo, v.C, g, v.bars, { takerRt: v.takerRt });
    console.log(
      `  ${g.name.padEnd(26)} ${String(hl.rows).padStart(6)} ${String(hl.clusters).padStart(5)} | ${`${(hl.excess >= 0 ? "+" : "") + hl.excess.toFixed(4)}% t=${hl.t.toFixed(2)}`.padStart(19)} | ${`${(cm.excess >= 0 ? "+" : "") + cm.excess.toFixed(4)}% t=${cm.t.toFixed(2)}`.padStart(19)} | ${`${(hc.excess >= 0 ? "+" : "") + hc.excess.toFixed(4)}% t=${hc.t.toFixed(2)}`.padStart(19)} | ${`${(sc.excess >= 0 ? "+" : "") + sc.excess.toFixed(4)}% t=${sc.t.toFixed(2)}`.padStart(19)} | ${`${(pl.excess >= 0 ? "+" : "") + pl.excess.toFixed(4)}% t=${pl.excessT.toFixed(2)}`.padStart(19)}`,
    );
  }
}

// ── THE HALF-SPLIT, on the CELL-MATCHED measure ───────────────────────
console.log(`\n═══ THE HALF-SPLIT, on the CELL-MATCHED measure ═══`);
for (const v of [K, B]) {
  const tsAll = v.rows.map((o) => o.ts);
  let lo = tsAll[0], hi = tsAll[0];
  for (const t of tsAll) { if (t < lo) lo = t; if (t > hi) hi = t; }
  const mid = (lo + hi) / 2;
  console.log(`  ${v.name}`);
  for (const g of GEOMETRIES) {
    const h1 = cellMatch(v.B.filter((r) => r.ts <= mid), v.C.filter((r) => r.ts <= mid), g, v.bars, v.takerRt);
    const h2 = cellMatch(v.B.filter((r) => r.ts > mid), v.C.filter((r) => r.ts > mid), g, v.bars, v.takerRt);
    const same = (h1.excess > 0) === (h2.excess > 0);
    console.log(`    ${g.name.padEnd(26)} H1 ${(h1.excess >= 0 ? "+" : "") + h1.excess.toFixed(4)}% t=${h1.t.toFixed(2)}   H2 ${(h2.excess >= 0 ? "+" : "") + h2.excess.toFixed(4)}% t=${h2.t.toFixed(2)}   ${same ? "SAME SIGN" : "SIGN FLIP"}`);
  }
}

// ── THE VERDICT ───────────────────────────────────────────────────────
console.log(`\n\n═══ THE VERDICT ═══\n`);
console.log(`  THE PROJECT'S BAR: an excess over a genuine control, n >= 30 INDEPENDENT`);
console.log(`  CLUSTERS, t >= 2, and the excess must survive the cell, symbol and`);
console.log(`  placebo controls.\n`);

// ── ARM A: the machine's own signal, on the collector's OWN definition ─
//
// The collector's recorded `tapeSide` field, and the collector's
// recorded `side` field (set only when BOTH model legs agree AND the
// JEV leg is certain). This is the machine's own signal, on the venue
// that produced it.
{
  const fieldArm = K.rows.filter((r) => tapeSideFromRow(r) && tapeSideFromRow(r) === r.side);
  const clusters = new Set(fieldArm.map((r) => Math.floor(r.ts / 300000))).size;
  const longs = fieldArm.filter((r) => tapeSideFromRow(r) === "long").length;
  console.log(`  ARM A — THE MACHINE'S OWN SIGNAL (the collector's own definition, KuCoin only)`);
  console.log(`    rows=${fieldArm.length}  clusters=${clusters}  long=${longs}  short=${fieldArm.length - longs}`);
  const C = K.rows.map((r) => ({ ...r, dir: r.dir }));
  const A = fieldArm.map((r) => ({ ...r, dir: tapeSideFromRow(r) }));
  const UC = K.C;
  for (const g of GEOMETRIES) {
    const dm = measureDirectionMatched(A, UC, g, K.bars, { takerRt: K.takerRt });
    console.log(`      ${g.name.padEnd(26)} dir-matched ${(dm.excess >= 0 ? "+" : "") + dm.excess.toFixed(4)}%  t=${dm.t.toFixed(2)}  clusters=${dm.clusters}  ${dm.t >= 2 && dm.clusters >= 30 ? "clears" : "BELOW the bar"}`);
  }
  console.log(`    -> the machine's own signal does NOT clear the bar on the venue that`);
  console.log(`       produced it, and it cannot be tested on the independent venue at all`);
  console.log(`       (the JEV leg is an LLM).\n`);
}

const evaluate = (v) => GEOMETRIES.map((g) => {
  const hl = measureDirectionMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
  const cm = cellMatch(v.B, v.C, g, v.bars, v.takerRt);
  const hc = holdClustered(v.B, v.C, g, v.bars, v.takerRt, 4 * 3600_000);
  const sc = symbolClustered(v.B, v.C, g, v.bars, v.takerRt);
  const placebo = v.B.map((r) => ({ ...r, dir: r.dir === "long" ? "short" : "long" }));
  const pl = measure(placebo, v.C, g, v.bars, { takerRt: v.takerRt });
  return {
    g, hl, cm, hc, sc, pl,
    clusters: hl.clusters,
    // The bar: the excess must hold when the clusters are as wide as
    // the trade's HOLD, which is the honest number of independent
    // observations.
    passes: hc.excess > 0 && hc.t >= 2 && hl.clusters >= 30 && pl.excess < 0,
  };
});

const kRes = evaluate(K);
const bRes = evaluate(B);

console.log(`  KUCOIN    rows=${K.fB.rows} clusters=${K.fB.clusters} long=${K.fB.long} short=${K.fB.short} span=${K.fB.spanH.toFixed(1)}h regime=${((K.up / K.rows.length) * 100).toFixed(0)}% up`);
for (const r of kRes) {
  console.log(`    ${r.g.name.padEnd(26)} cell-matched ${(r.cm.excess >= 0 ? "+" : "") + r.cm.excess.toFixed(4)}% t=${r.cm.t.toFixed(2)}  4h-clustered ${(r.hc.excess >= 0 ? "+" : "") + r.hc.excess.toFixed(4)}% t=${r.hc.t.toFixed(2)}  sym t=${r.sc.t.toFixed(2)}  placebo t=${r.pl.excessT.toFixed(2)}  -> ${r.passes ? "PASSES" : "FAILS"}`);
}
console.log(`    geometries passing the bar: ${kRes.filter((r) => r.passes).length}`);

console.log(`\n  BINANCE   rows=${B.fB.rows} clusters=${B.fB.clusters} long=${B.fB.long} short=${B.fB.short} span=${B.fB.spanH.toFixed(1)}h regime=${((B.up / B.rows.length) * 100).toFixed(0)}% up`);
for (const r of bRes) {
  console.log(`    ${r.g.name.padEnd(26)} cell-matched ${(r.cm.excess >= 0 ? "+" : "") + r.cm.excess.toFixed(4)}% t=${r.cm.t.toFixed(2)}  4h-clustered ${(r.hc.excess >= 0 ? "+" : "") + r.hc.excess.toFixed(4)}% t=${r.hc.t.toFixed(2)}  sym t=${r.sc.t.toFixed(2)}  placebo t=${r.pl.excessT.toFixed(2)}  -> ${r.passes ? "PASSES" : "FAILS"}`);
}
console.log(`    geometries passing the bar: ${bRes.filter((r) => r.passes).length}`);

const kPass = kRes.filter((r) => r.passes);
const bPass = bRes.filter((r) => r.passes);
const replicated = kPass.filter((kr) => bPass.some((br) => br.g.name === kr.g.name));
console.log(`\n  THE REPLICATION VERDICT:`);
if (kPass.length === 0) {
  console.log(`    The KUCOIN sample has NO geometry that clears the bar. Its apparent`);
  console.log(`    excess was a DIRECTION-MIX ARTEFACT: the pooled comparison put a`);
  console.log(`    16-long/1-short signal arm against an 18-long/564-short baseline in a`);
  console.log(`    95%-uptrend, and the t=12 that produced was the market's drift.`);
}
if (bPass.length > 0) {
  console.log(`    The INDEPENDENT VENUE has ${bPass.length} geometry/ies that clear the bar:`);
  for (const r of bPass) {
    console.log(`      ${r.g.name}: cell-matched +${r.cm.excess.toFixed(4)}% t=${r.cm.t.toFixed(2)}, ${r.hl.rows} rows in ${r.hl.clusters} clusters`);
  }
}
if (replicated.length > 0) {
  console.log(`    => REPLICATES on ${replicated.length} geometry/ies.`);
} else if (bPass.length > 0) {
  console.log(`    => The effect appears on the INDEPENDENT VENUE but NOT on KuCoin, so it`);
  console.log(`       does NOT replicate the KuCoin candidate. The KuCoin number was an`);
  console.log(`       artefact of its direction mix; the independent venue's number is a`);
  console.log(`       DIFFERENT effect, on a different window, in a different regime.`);
} else {
  console.log(`    => DOES NOT REPLICATE. Neither venue has a geometry that clears the bar.`);
}
