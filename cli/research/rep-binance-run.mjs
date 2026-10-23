#!/usr/bin/env node
/**
 * THE INDEPENDENT VENUE RUN — Binance USDⓈ-M perpetuals.
 *
 * The same measurement engine (`rep-measure.mjs`) and the same arm
 * builder (`rep-arms.mjs`) as the KuCoin baseline, so the two numbers
 * are produced by identical code. Any difference between them is a
 * property of the DATA.
 *
 * THE FEE
 *
 * The KuCoin study charges a 0.12% taker round trip (0.06% per side).
 * Binance USDⓈ-M's published VIP-0 taker rate is 0.05% per side — a
 * 0.10% round trip, which is CHEAPER. Charging Binance KuCoin's rate
 * would make the replication look worse than the venue is; charging
 * Binance a rate worse than its own would flatter it. So the
 * independent venue is charged ITS OWN published rate, and the KuCoin
 * side is reported at KuCoin's.
 *
 * The fee enters the expectancy identically on both: the taker round
 * trip on the notional, scaled by the exposure (notional / equity), and
 * charged on EVERY trade including the time exits.
 *
 * USAGE
 *   node research/rep-binance-run.mjs [obs.json] [bars.json] [takerRt]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import {
  GEOMETRIES, measure, measureDirectionMatched, trimTest, armFacts, auditBarLookup, NOE,
} from "./rep-measure.mjs";
import { mean, se } from "./rep-venue-common.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OBS_FILE = process.argv[2] ?? join(SCRATCH, "rep-binance-obs.json");
const BARS_FILE = process.argv[3] ?? join(SCRATCH, "rep-binance-15m-bars.json");
/** Binance USDⓈ-M VIP-0 taker: 0.05% per side = 0.10% round trip. */
const TAKER_RT = Number(process.argv[4] ?? 0.10);

// The observations are NDJSON (one row per line) — a JSON array of
// 150k objects overflows the serializer's stack.
const rawObs = readFileSync(OBS_FILE, "utf8");
const obs = rawObs.trimStart().startsWith("[")
  ? JSON.parse(rawObs)
  : rawObs.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const CACHE = JSON.parse(readFileSync(BARS_FILE, "utf8"));

console.log(`[binance-run] obs=${OBS_FILE}`);
console.log(`[binance-run] bars=${BARS_FILE}`);
console.log(`[binance-run] ${obs.length} observations, ${Object.keys(CACHE).length} symbols with 15m bars`);
console.log(`[binance-run] taker round trip ${TAKER_RT}% (Binance USDⓈ-M VIP-0: 0.05% per side)`);

// THE GUARD: a silent zero is a broken harness, not a null result.
const audit = auditBarLookup(obs, CACHE);
console.log(`\n  BARS-LOOKUP AUDIT: keys ${(audit.keyCoverage * 100).toFixed(1)}%  window ${(audit.windowCoverage * 100).toFixed(1)}%  forward ${(audit.forwardCoverage * 100).toFixed(1)}%  (sampled ${audit.sampled})`);
if (!audit.ok) {
  console.error("[binance-run] ABORTED — the bar cache cannot serve these observations:");
  for (const pr of audit.problems) console.error(`  - ${pr}`);
  console.error("[binance-run] NO RESULT IS REPORTED. A broken harness must never be read as a null.");
  process.exit(1);
}
console.log(`  -> the harness can resolve these observations. A result below is a real measurement.`);

const { A, B, C } = buildArms(obs, { book: false, jev: false });
const fA = armFacts(A);
const fB = armFacts(B);
const fC = armFacts(C);

const showArm = (label, f) => {
  console.log(`  ${label}`);
  console.log(`         rows=${f.rows}  clusters=${f.clusters}  long=${f.long}  short=${f.short}  span=${f.spanH.toFixed(2)}h`);
  console.log(`         regimes (tape geometry): up=${f.regimes.up} down=${f.regimes.down} flat=${f.regimes.flat}`);
};
console.log("");
showArm("ARM A  the machine's own signal (NOT AVAILABLE on an independent venue — the JEV leg is an LLM)", fA);
showArm("ARM B  the REPLICABLE arm (tape + Laya bridge without the JEV leg)", fB);
showArm("ARM C  the unconditional baseline (the tape's direction, NO filter)", fC);

let up = 0, down = 0, flat = 0;
for (const r of obs) {
  const g = r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat";
  if (g === "up") up++; else if (g === "down") down++; else flat++;
}
console.log(`\n  THE WINDOW'S REGIME (all ${obs.length} observations by the tape's own change): up=${up} down=${down} flat=${flat}`);
console.log(`  -> ${((up / obs.length) * 100).toFixed(1)}% of the window is an UPTREND.`);
console.log(`  -> the arms' direction mixes: B ${fB.long}L/${fB.short}S, C ${fC.long}L/${fC.short}S.`);

// ── the headline table ──
const rowsOut = [];
for (const g of GEOMETRIES) {
  const bP = measure(B, C, g, CACHE, { takerRt: TAKER_RT });
  const bD = measureDirectionMatched(B, C, g, CACHE, { takerRt: TAKER_RT });
  rowsOut.push({ g, bP, bD });
}

console.log(`\n  ARM B — THE REPLICABLE ARM (pooled, then direction-matched)`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(4)} ${"clus".padStart(5)} ${"L/S".padStart(8)} | ${"pooled.EXC".padStart(11)} ${"t".padStart(6)} | ${"dir-mat.EXC".padStart(12)} ${"t".padStart(6)}  verdict`);
console.log("  " + "-".repeat(110));
for (const r of rowsOut) {
  const d = r.bD;
  const verdict = d.excess > 0 && d.t >= 2 ? "EDGE" : d.excess > 0 ? "positive, t<2 (PATTERN)" : "no edge";
  console.log(
    `  ${r.g.name.padEnd(26)} ${String(r.bP.n).padStart(4)} ${String(d.clusters).padStart(5)} ${`${fB.long}L/${fB.short}S`.padStart(8)} | ${(r.bP.excess >= 0 ? "+" : "") + r.bP.excess.toFixed(4)}% ${r.bP.excessT.toFixed(2).padStart(6)} | ${(d.excess >= 0 ? "+" : "") + d.excess.toFixed(4)}% ${d.t.toFixed(2).padStart(6)}  ${verdict}`,
  );
}

console.log(`\n  ARM B — THE DIRECTION MATCH, in detail`);
for (const r of rowsOut) {
  const p = r.bD.parts.map((x) => `${x.dir}: n=${x.rows} clus=${x.clusters} exc=${(x.excess >= 0 ? "+" : "") + x.excess.toFixed(4)}% t=${x.t.toFixed(2)}`).join("  |  ");
  console.log(`    ${r.g.name.padEnd(26)} ${p}`);
}

// ── THE PLACEBO: the REVERSED direction, same geometry, same rows ──────
//
// The placebo is the same observations traded the OTHER way. A signal
// that shows an excess only in one direction, and a negative excess in
// the other, is a DIRECTION artefact, not an edge.
console.log(`\n  THE PLACEBO — the SAME rows, traded the OPPOSITE way`);
const placebo = B.map((r) => ({ ...r, dir: r.dir === "long" ? "short" : "long" }));
for (const r of rowsOut) {
  const m = measure(placebo, C, r.g, CACHE, { takerRt: TAKER_RT });
  console.log(`    ${r.g.name.padEnd(26)} placebo EXCESS=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}%  t=${m.excessT.toFixed(2)}  win%=${(m.winRate * 100).toFixed(1)}`);
}

// ── THE TRIM TEST ──────────────────────────────────────────────────────
console.log(`\n  TRIM TEST (the signal arm's best/worst 3 dropped, excess re-measured)`);
for (const r of rowsOut) {
  const t = trimTest(r.bP);
  if (!t) continue;
  console.log(`    ${r.g.name.padEnd(26)} worst3 ${(t.exWorst >= 0 ? "+" : "") + t.exWorst.toFixed(4)} / best3 ${(t.exBest >= 0 ? "+" : "") + t.exBest.toFixed(4)}  ${t.stable ? "STABLE" : "not stable"}`);
}

// ── THE HALF-SPLIT ─────────────────────────────────────────────────────
//
// The effect must be in BOTH halves of the window to be a property of
// the window and not of one stretch of it.
console.log(`\n  HALF-SPLIT (the window's first half vs its second half)`);
const tsAll = obs.map((o) => o.ts);
// minOf(ts) with 150k arguments overflows the call stack.
let loTs = tsAll[0];
let hiTs = tsAll[0];
for (const t of tsAll) { if (t < loTs) loTs = t; if (t > hiTs) hiTs = t; }
const mid = (loTs + hiTs) / 2;
for (const g of GEOMETRIES) {
  const h1 = measureDirectionMatched(B.filter((r) => r.ts <= mid), C.filter((r) => r.ts <= mid), g, CACHE, { takerRt: TAKER_RT });
  const h2 = measureDirectionMatched(B.filter((r) => r.ts > mid), C.filter((r) => r.ts > mid), g, CACHE, { takerRt: TAKER_RT });
  const same = (h1.excess > 0) === (h2.excess > 0);
  console.log(`    ${g.name.padEnd(26)} H1 exc=${(h1.excess >= 0 ? "+" : "") + h1.excess.toFixed(4)}% t=${h1.t.toFixed(2)} (n=${h1.rows} clus=${h1.clusters})  H2 exc=${(h2.excess >= 0 ? "+" : "") + h2.excess.toFixed(4)}% t=${h2.t.toFixed(2)} (n=${h2.rows} clus=${h2.clusters})  ${same ? "SAME SIGN" : "SIGN FLIP"}`);
}
console.log(`\n  [binance-run] exposure ${(NOE * 100).toFixed(2)}% of equity, taker round trip ${TAKER_RT}% on notional`);
