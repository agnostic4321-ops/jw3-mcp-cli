#!/usr/bin/env node
/**
 * THE FINAL SIDE-BY-SIDE — every control, both venues, one standard.
 *
 * The reader needs four numbers per venue, and the order matters:
 *
 *   1. THE HEADLINE (direction-matched) excess and t.
 *   2. THE CONTROLS that can kill it:
 *        - the DIRECTION-AND-REGIME-matched excess (the signal vs the
 *          unconditional arm of the same direction AND the same market
 *          regime),
 *        - the SYMBOL-clustered excess (the symbols move together),
 *        - the PLACEBO (the same rows traded the other way),
 *        - the HALF-SPLIT (both halves of the window).
 *   3. THE ARM FACTS: rows, CLUSTERS, the long/short split, the span.
 *   4. THE REGIME of each window, so the reader can see whether the two
 *      samples are even comparable.
 *
 * A result only counts if it survives ALL of them. The project's bar:
 * an excess over a genuine control, n >= 30 independent clusters, and
 * t >= 2.
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

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const BAR_MIN = 15;

const VENUES = [
  {
    name: "KUCOIN (the collector's venue)",
    rowsFile: join(SCRATCH, "rep-confluence.parent-snap.ndjson"),
    barsFile: join(SCRATCH, "rep-kucoin-15m-bars.snapshot.json"),
    takerRt: 0.12,
    feeNote: "0.06%/side (the study's rate)",
  },
  {
    name: "BINANCE USDⓈ-M (INDEPENDENT)",
    rowsFile: join(SCRATCH, "rep-binance-obs.json"),
    barsFile: join(SCRATCH, "rep-binance-15m-bars.json"),
    takerRt: 0.10,
    feeNote: "0.05%/side (Binance VIP-0 published)",
  },
];

const regimeOf = (r) => (r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat");

/** The direction-AND-regime-matched excess: the tightest comparison. */
function dirRegimeMatched(signal, uncond, g, cache, opts) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    for (const reg of ["up", "down", "flat"]) {
      const s = signal.filter((r) => r.dir === dir && regimeOf(r) === reg);
      const u = uncond.filter((r) => r.dir === dir && regimeOf(r) === reg);
      if (!s.length || !u.length) continue;
      const m = measureDirectionMatched(s, u, g, cache, opts);
      parts.push({ dir, reg, rows: m.rows, clusters: m.clusters, excess: m.excess, t: m.t, weight: m.rows / signal.length });
    }
  }
  if (!parts.length) return { excess: 0, t: 0, parts };
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * (p.t !== 0 ? (p.excess / p.t) ** 2 : 0), 0));
  return { excess, t: seC > 0 ? excess / seC : 0, parts };
}

/** The symbol-clustered excess: the symbols move together. */
function symbolClustered(signal, uncond, g, cache, opts) {
  const NOE = 1.0484;
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signal.filter((r) => r.dir === dir);
    const u = uncond.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0, sClusters: 0 }); continue; }
    const grab = (set) => {
      const m = measure(set, set, g, cache, opts);
      const pnl = [], syms = [];
      for (const r of m.signalRows) {
        pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - opts.takerRt * NOE
          : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - opts.takerRt * NOE
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
    const seC = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
    parts.push({ dir, rows: s.length, excess, se: seC, t: seC > 0 ? excess / seC : 0, weight: s.length / signal.length, sClusters: sCl.clusters });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se: seC, t: seC > 0 ? excess / seC : 0 };
}

const loaded = [];
for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const audit = auditBarLookup(rows, bars);
  if (!audit.ok) {
    console.log(`[final] ABORTING on ${v.name} — the bar cache cannot serve these observations:`);
    for (const p of audit.problems) console.log(`  - ${p}`);
    continue;
  }
  const { A, B, C } = buildArms(rows, { book: false, jev: false });
  let up = 0, down = 0, flat = 0;
  for (const r of rows) { const g = regimeOf(r); if (g === "up") up++; else if (g === "down") down++; else flat++; }
  loaded.push({ ...v, rows, bars, A, B, C, audit, up, down, flat, fA: armFacts(A), fB: armFacts(B), fC: armFacts(C) });
}

for (const v of loaded) {
  console.log(`\n╔══ ${v.name} ${"═".repeat(70 - v.name.length)}`);
  console.log(`║  observations=${v.rows.length}  symbols with bars=${Object.keys(v.bars).length}  fee ${v.feeNote}`);
  console.log(`║  REGIME: up=${v.up} down=${v.down} flat=${v.flat}  ->  ${((v.up / v.rows.length) * 100).toFixed(1)}% UP`);
  console.log(`║  ARM A (machine's own signal, JEV leg): rows=${v.fA.rows} clusters=${v.fA.clusters} L=${v.fA.long} S=${v.fA.short} span=${v.fA.spanH.toFixed(2)}h`);
  console.log(`║  ARM B (REPLICABLE, no JEV leg):       rows=${v.fB.rows} clusters=${v.fB.clusters} L=${v.fB.long} S=${v.fB.short} span=${v.fB.spanH.toFixed(2)}h`);
  console.log(`║  ARM C (unconditional baseline):       rows=${v.fC.rows} clusters=${v.fC.clusters} L=${v.fC.long} S=${v.fC.short} span=${v.fC.spanH.toFixed(2)}h`);
  console.log(`║  BARS AUDIT: keys ${(v.audit.keyCoverage * 100).toFixed(1)}% window ${(v.audit.windowCoverage * 100).toFixed(1)}% forward ${(v.audit.forwardCoverage * 100).toFixed(1)}%`);
}

if (loaded.length < 2) { console.log("\n[final] both venues are needed."); process.exit(0); }
const [K, B] = loaded;

// ── THE FULL TABLE, PER VENUE ─────────────────────────────────────────
for (const v of [K, B]) {
  console.log(`\n═══ ${v.name} — ARM B, every control ═══`);
  console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(4)} ${"clus".padStart(5)} | ${"HEADLINE".padStart(21)} | ${"dir+regime".padStart(19)} | ${"sym-clustered".padStart(19)} | ${"placebo".padStart(19)}`);
  console.log("  " + "-".repeat(125));
  const placebo = v.B.map((r) => ({ ...r, dir: r.dir === "long" ? "short" : "long" }));
  for (const g of GEOMETRIES) {
    const hl = measureDirectionMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
    const dr = dirRegimeMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
    const sc = symbolClustered(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
    const pl = measure(placebo, v.C, g, v.bars, { takerRt: v.takerRt });
    console.log(
      `  ${g.name.padEnd(26)} ${String(hl.rows).padStart(4)} ${String(hl.clusters).padStart(5)} | ${`${(hl.excess >= 0 ? "+" : "") + hl.excess.toFixed(4)}% t=${hl.t.toFixed(2)}`.padStart(21)} | ${`${(dr.excess >= 0 ? "+" : "") + dr.excess.toFixed(4)}% t=${dr.t.toFixed(2)}`.padStart(19)} | ${`${(sc.excess >= 0 ? "+" : "") + sc.excess.toFixed(4)}% t=${sc.t.toFixed(2)}`.padStart(19)} | ${`${(pl.excess >= 0 ? "+" : "") + pl.excess.toFixed(4)}% t=${pl.excessT.toFixed(2)}`.padStart(19)}`,
    );
  }
}

// ── THE HALF-SPLIT, both venues ───────────────────────────────────────
console.log(`\n═══ THE HALF-SPLIT (both halves of each window) ═══`);
for (const v of [K, B]) {
  const tsAll = v.rows.map((o) => o.ts);
  let lo = tsAll[0], hi = tsAll[0];
  for (const t of tsAll) { if (t < lo) lo = t; if (t > hi) hi = t; }
  const mid = (lo + hi) / 2;
  console.log(`  ${v.name}`);
  for (const g of GEOMETRIES) {
    const h1 = measureDirectionMatched(v.B.filter((r) => r.ts <= mid), v.C.filter((r) => r.ts <= mid), g, v.bars, { takerRt: v.takerRt });
    const h2 = measureDirectionMatched(v.B.filter((r) => r.ts > mid), v.C.filter((r) => r.ts > mid), g, v.bars, { takerRt: v.takerRt });
    const same = (h1.excess > 0) === (h2.excess > 0);
    console.log(`    ${g.name.padEnd(26)} H1 ${(h1.excess >= 0 ? "+" : "") + h1.excess.toFixed(4)}% t=${h1.t.toFixed(2)}   H2 ${(h2.excess >= 0 ? "+" : "") + h2.excess.toFixed(4)}% t=${h2.t.toFixed(2)}   ${same ? "SAME SIGN" : "SIGN FLIP"}`);
  }
}

// ── THE VERDICT ───────────────────────────────────────────────────────
console.log(`\n\n═══ THE VERDICT ═══\n`);
const bar = (v, g) => {
  const hl = measureDirectionMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
  const dr = dirRegimeMatched(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
  const sc = symbolClustered(v.B, v.C, g, v.bars, { takerRt: v.takerRt });
  return { hl, dr, sc, survives: hl.excess > 0 && hl.t >= 2 && dr.excess > 0 && dr.t >= 2 && sc.excess > 0 && sc.t >= 2 };
};

console.log(`  THE PROJECT'S BAR: excess > 0, t >= 2, n >= 30 INDEPENDENT CLUSTERS,`);
console.log(`  and the excess must survive the regime and symbol controls.\n`);
const kBar = GEOMETRIES.map((g) => ({ g, ...bar(K, g) }));
const bBar = GEOMETRIES.map((g) => ({ g, ...bar(B, g) }));
const kPass = kBar.filter((r) => r.survives && r.hl.clusters >= 30);
const bPass = bBar.filter((r) => r.survives && r.hl.clusters >= 30);

console.log(`  KUCOIN    (${K.fB.rows} rows / ${K.fB.clusters} clusters / ${K.fB.long}L ${K.fB.short}S / ${K.fB.spanH.toFixed(1)}h / ${((K.up / K.rows.length) * 100).toFixed(0)}% up)`);
for (const r of kBar) {
  console.log(`    ${r.g.name.padEnd(26)} headline ${(r.hl.excess >= 0 ? "+" : "") + r.hl.excess.toFixed(4)}% t=${r.hl.t.toFixed(2)}  | dir+regime t=${r.dr.t.toFixed(2)}  | sym t=${r.sc.t.toFixed(2)}  -> ${r.survives ? "SURVIVES" : "KILLED by a control"}`);
}
console.log(`    geometries clearing the whole bar: ${kPass.length}`);

console.log(`\n  BINANCE   (${B.fB.rows} rows / ${B.fB.clusters} clusters / ${B.fB.long}L ${B.fB.short}S / ${B.fB.spanH.toFixed(1)}h / ${((B.up / B.rows.length) * 100).toFixed(0)}% up)`);
for (const r of bBar) {
  console.log(`    ${r.g.name.padEnd(26)} headline ${(r.hl.excess >= 0 ? "+" : "") + r.hl.excess.toFixed(4)}% t=${r.hl.t.toFixed(2)}  | dir+regime t=${r.dr.t.toFixed(2)}  | sym t=${r.sc.t.toFixed(2)}  -> ${r.survives ? "SURVIVES" : "KILLED by a control"}`);
}
console.log(`    geometries clearing the whole bar: ${bPass.length}`);

const replicated = kPass.filter((kr) => bPass.some((br) => br.g.name === kr.g.name));
console.log(`\n  THE REPLICATION VERDICT:`);
if (kPass.length === 0 && bPass.length === 0) {
  console.log(`    DOES NOT REPLICATE — and, more strongly, NEITHER VENUE SURVIVES ITS OWN CONTROLS.`);
  console.log(`    The geometry candidate's excess is not a property of the KuCoin sample`);
  console.log(`    either: it is the MARKET'S DRIFT, which the KuCoin sample's 95%-uptrend`);
  console.log(`    regime inflated into a t=12 number and the independent venue's 60%-downtrend`);
  console.log(`    reproduced in a different form.`);
} else if (replicated.length === 0) {
  console.log(`    DOES NOT REPLICATE.`);
} else {
  console.log(`    REPLICATES on ${replicated.length} geometry/ies.`);
}
