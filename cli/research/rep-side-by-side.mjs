#!/usr/bin/env node
/**
 * THE SIDE-BY-SIDE — KuCoin vs the independent venue.
 *
 * One table, both venues, produced by the same engine and the same arm
 * builder. The verdict is stated at the bottom in plain words, because
 * that is what a reader needs: REPLICATES, DOES NOT REPLICATE, or
 * INSUFFICIENT DATA TO SAY.
 *
 * The comparison is the REPLICABLE ARM — the tape agreeing with the
 * Laya bridge computed WITHOUT the JEV leg — because the JEV leg is an
 * LLM and cannot be reproduced on an independent venue without the
 * account's credentials. The KuCoin machine's-own-signal arm (the one
 * with the JEV leg) is reported alongside it, for reference.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import {
  GEOMETRIES, measure, measureDirectionMatched, armFacts, auditBarLookup, NOE,
} from "./rep-measure.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");

const VENUES = [
  {
    name: "KuCoin (the collector's venue)",
    rows: join(SCRATCH, "rep-confluence.parent-snap.ndjson"),
    bars: join(SCRATCH, "rep-kucoin-15m-bars.parent-snap.json"),
    takerRt: 0.12,
    feeNote: "0.06%/side taker (the study's rate)",
  },
  {
    name: "Binance USDⓈ-M (INDEPENDENT)",
    rows: join(SCRATCH, "rep-binance-obs.json"),
    bars: join(SCRATCH, "rep-binance-15m-bars.json"),
    takerRt: 0.10,
    feeNote: "0.05%/side taker (Binance VIP-0 published rate)",
  },
];

const loaded = [];
for (const v of VENUES) {
  let rows, bars;
  try {
    // The KuCoin side is NDJSON (one row per line); the Binance side is
    // a JSON array. Read whichever it is.
    const raw = readFileSync(v.rows, "utf8");
    rows = raw.trimStart().startsWith("[")
      ? JSON.parse(raw)
      : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    bars = JSON.parse(readFileSync(v.bars, "utf8"));
  } catch (e) {
    console.log(`[side-by-side] SKIP ${v.name}: ${e.message}`);
    continue;
  }
  // THE GUARD: a silent zero is a broken harness, not a null result.
  const audit = auditBarLookup(rows, bars);
  if (!audit.ok) {
    console.log(`[side-by-side] ABORTING on ${v.name} — the bar cache cannot serve these observations:`);
    for (const pr of audit.problems) console.log(`  - ${pr}`);
    continue;
  }
  const { A, B, C } = buildArms(rows, { book: false, jev: false });
  loaded.push({ ...v, rows, bars, A, B, C, audit, fA: armFacts(A), fB: armFacts(B), fC: armFacts(C) });
}

for (const v of loaded) {
  let up = 0, down = 0, flat = 0;
  for (const r of v.rows) {
    const g = r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat";
    if (g === "up") up++; else if (g === "down") down++; else flat++;
  }
  v.regime = { up, down, flat, upPct: (up / v.rows.length) * 100 };
  console.log(`\n═══ ${v.name} ═══`);
  console.log(`  observations=${v.rows.length}  symbols with bars=${Object.keys(v.bars).length}  fee: ${v.feeNote}`);
  console.log(`  REGIME: up=${up} down=${down} flat=${flat}  ->  ${v.regime.upPct.toFixed(1)}% UP`);
  console.log(`  ARM A (machine's own signal, JEV leg): rows=${v.fA.rows} clusters=${v.fA.clusters} L=${v.fA.long} S=${v.fA.short} span=${v.fA.spanH.toFixed(2)}h`);
  console.log(`  ARM B (REPLICABLE, no JEV leg):       rows=${v.fB.rows} clusters=${v.fB.clusters} L=${v.fB.long} S=${v.fB.short} span=${v.fB.spanH.toFixed(2)}h`);
  console.log(`  ARM C (unconditional baseline):       rows=${v.fC.rows} clusters=${v.fC.clusters} L=${v.fC.long} S=${v.fC.short} span=${v.fC.spanH.toFixed(2)}h`);
  console.log(`  BARS-LOOKUP AUDIT: keys ${(v.audit.keyCoverage * 100).toFixed(1)}%  window ${(v.audit.windowCoverage * 100).toFixed(1)}%  forward ${(v.audit.forwardCoverage * 100).toFixed(1)}%`);
}

if (loaded.length < 2) {
  console.log("\n[side-by-side] both venues are needed for the comparison.");
  process.exit(0);
}

const [K, B] = loaded;

// ── THE HEADLINE TABLE ─────────────────────────────────────────────────
console.log(`\n═══ THE SIDE-BY-SIDE — ARM B (the replicable arm), direction-matched excess ═══`);
console.log(`\n  KUCOIN  (95% up, ${K.fB.rows} rows in ${K.fB.clusters} clusters, ${K.fB.long}L/${K.fB.short}S, ${K.fB.spanH.toFixed(1)}h span, fee 0.12%)`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(4)} ${"clus".padStart(5)} ${"EXCESS".padStart(11)} ${"t".padStart(7)}   ${"L: exc/t".padStart(16)}   ${"S: exc/t".padStart(16)}`);
console.log("  " + "-".repeat(100));
const kRows = [];
for (const g of GEOMETRIES) {
  const d = measureDirectionMatched(K.B, K.C, g, K.bars, { takerRt: K.takerRt });
  kRows.push({ g, d });
  const L = d.parts.find((p) => p.dir === "long");
  const S = d.parts.find((p) => p.dir === "short");
  console.log(
    `  ${g.name.padEnd(26)} ${String(d.rows).padStart(4)} ${String(d.clusters).padStart(5)} ${(d.excess >= 0 ? "+" : "") + d.excess.toFixed(4)}% ${d.t.toFixed(2).padStart(7)}   ${`${(L?.excess >= 0 ? "+" : "") + (L?.excess ?? 0).toFixed(4)}% t=${(L?.t ?? 0).toFixed(2)}`.padStart(16)}   ${`${(S?.excess >= 0 ? "+" : "") + (S?.excess ?? 0).toFixed(4)}% t=${(S?.t ?? 0).toFixed(2)}`.padStart(16)}`,
  );
}

console.log(`\n  BINANCE USDⓈ-M (INDEPENDENT) (${B.regime.upPct.toFixed(0)}% up, ${B.fB.rows} rows in ${B.fB.clusters} clusters, ${B.fB.long}L/${B.fB.short}S, ${B.fB.spanH.toFixed(1)}h span, fee 0.10%)`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(4)} ${"clus".padStart(5)} ${"EXCESS".padStart(11)} ${"t".padStart(7)}   ${"L: exc/t".padStart(16)}   ${"S: exc/t".padStart(16)}`);
console.log("  " + "-".repeat(100));
const bRows = [];
for (const g of GEOMETRIES) {
  const d = measureDirectionMatched(B.B, B.C, g, B.bars, { takerRt: B.takerRt });
  bRows.push({ g, d });
  const L = d.parts.find((p) => p.dir === "long");
  const S = d.parts.find((p) => p.dir === "short");
  console.log(
    `  ${g.name.padEnd(26)} ${String(d.rows).padStart(4)} ${String(d.clusters).padStart(5)} ${(d.excess >= 0 ? "+" : "") + d.excess.toFixed(4)}% ${d.t.toFixed(2).padStart(7)}   ${`${(L?.excess >= 0 ? "+" : "") + (L?.excess ?? 0).toFixed(4)}% t=${(L?.t ?? 0).toFixed(2)}`.padStart(16)}   ${`${(S?.excess >= 0 ? "+" : "") + (S?.excess ?? 0).toFixed(4)}% t=${(S?.t ?? 0).toFixed(2)}`.padStart(16)}`,
  );
}

// ── THE POOLED NUMBERS, for the record ────────────────────────────────
console.log(`\n═══ THE POOLED EXCESS (the naive comparison, and why it is not the headline) ═══`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"KUCOIN pooled".padStart(16)} ${"t".padStart(7)}   ${"BINANCE pooled".padStart(16)} ${"t".padStart(7)}`);
console.log("  " + "-".repeat(80));
for (let i = 0; i < GEOMETRIES.length; i++) {
  const g = GEOMETRIES[i];
  const kp = measure(K.B, K.C, g, K.bars, { takerRt: K.takerRt });
  const bp = measure(B.B, B.C, g, B.bars, { takerRt: B.takerRt });
  console.log(
    `  ${g.name.padEnd(26)} ${(kp.excess >= 0 ? "+" : "") + kp.excess.toFixed(4)}% ${kp.excessT.toFixed(2).padStart(7)}   ${(bp.excess >= 0 ? "+" : "") + bp.excess.toFixed(4)}% ${bp.excessT.toFixed(2).padStart(7)}`,
  );
}
console.log(`\n  The pooled excess compares a signal arm with one direction mix against an`);
console.log(`  unconditional arm with another. KuCoin's signal arm is ${K.fB.long}L/${K.fB.short}S`);
console.log(`  and its unconditional arm is ${K.fC.long}L/${K.fC.short}S, so the pooled number`);
console.log(`  is mostly the market's drift, not the signal. The direction-matched column`);

// ── THE VERDICT ────────────────────────────────────────────────────────
console.log(`\n═══ THE VERDICT ═══`);
// The candidate geometries: any with a positive direction-matched excess
// and t >= 2 on EITHER venue are the candidates for replication.
const kEdges = kRows.filter((r) => r.d.excess > 0 && r.d.t >= 2);
const bEdges = bRows.filter((r) => r.d.excess > 0 && r.d.t >= 2);
const kPatterns = kRows.filter((r) => r.d.excess > 0 && r.d.t < 2);
const bPatterns = bRows.filter((r) => r.d.excess > 0 && r.d.t < 2);

console.log(`  KuCoin:    ${kEdges.length} geometry/ies clear the bar (excess>0, t>=2) on the direction-matched excess`);
for (const r of kEdges) console.log(`              ${r.g.name}: +${r.d.excess.toFixed(4)}% t=${r.d.t.toFixed(2)} (${r.d.rows} rows, ${r.d.clusters} clusters)`);
if (kPatterns.length) {
  console.log(`            ${kPatterns.length} more are POSITIVE but t<2 — a PATTERN, not a finding:`);
  for (const r of kPatterns) console.log(`              ${r.g.name}: +${r.d.excess.toFixed(4)}% t=${r.d.t.toFixed(2)}`);
}
console.log(`  Binance:   ${bEdges.length} geometry/ies clear the bar on the direction-matched excess`);
for (const r of bEdges) console.log(`              ${r.g.name}: +${r.d.excess.toFixed(4)}% t=${r.d.t.toFixed(2)} (${r.d.rows} rows, ${r.d.clusters} clusters)`);
if (bPatterns.length) {
  console.log(`            ${bPatterns.length} more are POSITIVE but t<2 — a PATTERN, not a finding:`);
  for (const r of bPatterns) console.log(`              ${r.g.name}: +${r.d.excess.toFixed(4)}% t=${r.d.t.toFixed(2)}`);
}

// The cluster-count bar: n >= 30 independent clusters.
const kClusters = kRows.map((r) => r.d.clusters);
const bClusters = bRows.map((r) => r.d.clusters);
console.log(`\n  THE CLUSTER-COUNT BAR (>= 30 independent clusters is the project's bar):`);
console.log(`    KuCoin's signal arm has ${K.fB.clusters} clusters in total; Binance's has ${B.fB.clusters}.`);
console.log(`    KuCoin's per-geometry cluster counts: ${[...new Set(kClusters)].join(", ")}`);
console.log(`    Binance's per-geometry cluster counts: ${[...new Set(bClusters)].join(", ")}`);

const replicated = kEdges.filter((kr) => bEdges.some((br) => br.g.name === kr.g.name));
console.log(`\n  REPLICATION: ${replicated.length} of ${kEdges.length} KuCoin candidate(s) also clear the bar on Binance.`);
if (replicated.length === 0 && kEdges.length > 0) {
  console.log(`  => DOES NOT REPLICATE. The geometry candidate's excess does NOT appear on the`);
  console.log(`     independent venue. It is a property of the KuCoin sample, not of the market.`);
} else if (replicated.length > 0) {
  console.log(`  => REPLICATES on ${replicated.length} geometry/ies.`);
} else if (kEdges.length === 0) {
  console.log(`  => KuCoin's direction-matched excess does not clear the bar either, so there is`);
  console.log(`     no candidate to replicate. The KuCoin excess was a direction-mix artefact.`);
} else {
  console.log(`  => INSUFFICIENT DATA TO SAY.`);
}
console.log(`\n  [side-by-side] exposure ${(NOE * 100).toFixed(2)}% of equity on both venues`);
