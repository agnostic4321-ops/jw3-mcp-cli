#!/usr/bin/env node
/**
 * THE KUCOIN BASELINE — the number the independent venue must beat.
 *
 * This runs the SAME measurement engine (`rep-measure.mjs`) over the
 * collector's own rows and the CACHED 15-minute bars, so the KuCoin
 * figure and the independent-venue figure are produced by identical
 * code. Any difference between them is a property of the DATA, not of
 * the harness.
 *
 * It reports THREE arms:
 *
 *   A. THE MACHINE'S OWN SIGNAL — the collector's `side` field (set
 *      only when BOTH model legs agree AND the JEV leg is certain) and
 *      the tape agreeing with it.
 *
 *   B. THE REPLICABLE ARM — the tape agreeing with the LAYA bridge
 *      computed WITHOUT the JEV leg. This is the arm an independent
 *      venue can reproduce, because the JEV leg is an LLM.
 *
 *   C. THE UNCONDITIONAL BASELINE — the tape's direction with NO model
 *      filter at all. The excess of A or B over C is the edge; C alone
 *      is beta.
 *
 * AND TWO WAYS OF MEASURING THE EXCESS:
 *
 *   POOLED        signal arm minus unconditional arm, as-is. Only valid
 *                 when the two arms share a direction mix.
 *   DIRECTION-MATCHED
 *                 the signal arm compared with the unconditional arm
 *                 WITHIN each direction, combined weighted by the
 *                 signal arm's own mix. This is the valid one.
 *
 * USAGE
 *   node research/rep-kucoin-baseline.mjs [rows.ndjson] [bars.json]
 *
 * READ-ONLY. No venue calls. No account calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow, layaVerdict } from "./rep-venue-common.mjs";
import {
  GEOMETRIES, measure, measureDirectionMatched, trimTest, armFacts, NOE, TAKER_RT,
} from "./rep-measure.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const ROWS_FILE = process.argv[2] ?? join(SCRATCH, "rep-confluence.snapshot.ndjson");
const BARS_FILE = process.argv[3] ?? join(SCRATCH, "rep-kucoin-15m-bars.snapshot.json");

const rows = readFileSync(ROWS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const CACHE = JSON.parse(readFileSync(BARS_FILE, "utf8"));

console.log(`[kucoin-baseline] rows=${ROWS_FILE}`);
console.log(`[kucoin-baseline] bars=${BARS_FILE}`);
console.log(`[kucoin-baseline] ${rows.length} rows, ${Object.keys(CACHE).length} symbols with 15m bars`);

const tapeOf = (r) => tapeSideFromRow(r);
const layaNoJev = (r) => {
  if (r.tapeChg == null) return null;
  return layaVerdict({
    chg: r.tapeChg, atrPct: r.tapeAtrPct,
    jevSide: null, jevAgreement: 0, jevUncertain: true,
    imb: r.bookImbalance, sprBps: r.spreadBps,
  }).choice;
};

const armA = [];
const armB = [];
const armC = [];
for (const r of rows) {
  const t = tapeOf(r);
  if (!t) continue;
  armC.push({ ...r, dir: t });
  if (r.side && t === r.side) armA.push({ ...r, dir: t });
  const l = layaNoJev(r);
  if (l && l === t) armB.push({ ...r, dir: t });
}

const fA = armFacts(armA);
const fB = armFacts(armB);
const fC = armFacts(armC);

const showArm = (label, f) => {
  console.log(`  ${label}`);
  console.log(`         rows=${f.rows}  clusters=${f.clusters}  long=${f.long}  short=${f.short}  span=${f.spanH.toFixed(2)}h`);
};
console.log("");
showArm("ARM A  the machine's own signal (tape + both model legs agree)", fA);
showArm("ARM B  the REPLICABLE arm (tape + Laya bridge without the JEV leg)", fB);
showArm("ARM C  the unconditional baseline (the tape's direction, NO filter)", fC);

let up = 0, down = 0, flat = 0;
for (const r of rows) {
  const g = r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat";
  if (g === "up") up++; else if (g === "down") down++; else flat++;
}
console.log(`\n  THE SAMPLE'S REGIME (all ${rows.length} rows by the tape's own change): up=${up} down=${down} flat=${flat}`);
console.log(`  -> ${((up / rows.length) * 100).toFixed(1)}% of the sample is an UPTREND.`);
console.log(`  -> the arms' direction mixes DIFFER: A ${fA.long}L/${fA.short}S, B ${fB.long}L/${fB.short}S, C ${fC.long}L/${fC.short}S.`);
console.log(`     A pooled excess between arms with different mixes measures the market's`);
console.log(`     DRIFT, not the signal, so the DIRECTION-MATCHED column is the headline.`);

const rowsOut = [];
for (const g of GEOMETRIES) {
  rowsOut.push({
    g,
    aP: measure(armA, armC, g, CACHE, { takerRt: TAKER_RT }),
    aD: measureDirectionMatched(armA, armC, g, CACHE, { takerRt: TAKER_RT }),
    bP: measure(armB, armC, g, CACHE, { takerRt: TAKER_RT }),
    bD: measureDirectionMatched(armB, armC, g, CACHE, { takerRt: TAKER_RT }),
  });
}

console.log(`\n  ARM A — THE MACHINE'S OWN SIGNAL (pooled, then direction-matched)`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(3)} ${"clus".padStart(4)} ${"L/S".padStart(7)} | ${"pooled.EXC".padStart(11)} ${"t".padStart(6)} | ${"dir-mat.EXC".padStart(12)} ${"t".padStart(6)}  verdict`);
console.log("  " + "-".repeat(104));
for (const r of rowsOut) {
  const d = r.aD;
  const verdict = d.excess > 0 && d.t >= 2 ? "EDGE" : d.excess > 0 ? "positive, t<2 (PATTERN)" : "no edge";
  console.log(
    `  ${r.g.name.padEnd(26)} ${String(r.aP.n).padStart(3)} ${String(d.clusters).padStart(4)} ${`${fA.long}L/${fA.short}S`.padStart(7)} | ${(r.aP.excess >= 0 ? "+" : "") + r.aP.excess.toFixed(4)}% ${r.aP.excessT.toFixed(2).padStart(6)} | ${(d.excess >= 0 ? "+" : "") + d.excess.toFixed(4)}% ${d.t.toFixed(2).padStart(6)}  ${verdict}`,
  );
}

console.log(`\n  ARM B — THE REPLICABLE ARM (pooled, then direction-matched)`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"n".padStart(3)} ${"clus".padStart(4)} ${"L/S".padStart(7)} | ${"pooled.EXC".padStart(11)} ${"t".padStart(6)} | ${"dir-mat.EXC".padStart(12)} ${"t".padStart(6)}  verdict`);
console.log("  " + "-".repeat(104));
for (const r of rowsOut) {
  const d = r.bD;
  const verdict = d.excess > 0 && d.t >= 2 ? "EDGE" : d.excess > 0 ? "positive, t<2 (PATTERN)" : "no edge";
  console.log(
    `  ${r.g.name.padEnd(26)} ${String(r.bP.n).padStart(3)} ${String(d.clusters).padStart(4)} ${`${fB.long}L/${fB.short}S`.padStart(7)} | ${(r.bP.excess >= 0 ? "+" : "") + r.bP.excess.toFixed(4)}% ${r.bP.excessT.toFixed(2).padStart(6)} | ${(d.excess >= 0 ? "+" : "") + d.excess.toFixed(4)}% ${d.t.toFixed(2).padStart(6)}  ${verdict}`,
  );
}

console.log(`\n  ARM B — THE DIRECTION MATCH, in detail`);
for (const r of rowsOut) {
  const p = r.bD.parts.map((x) => `${x.dir}: n=${x.rows} clus=${x.clusters} exc=${(x.excess >= 0 ? "+" : "") + x.excess.toFixed(4)}% t=${x.t.toFixed(2)}`).join("  |  ");
  console.log(`    ${r.g.name.padEnd(26)} ${p}`);
}

console.log(`\n  TRIM TEST (the signal arm's best/worst 3 dropped, excess re-measured)`);
for (const r of rowsOut) {
  const tA = trimTest(r.aP);
  const tB = trimTest(r.bP);
  if (!tA && !tB) continue;
  console.log(`    ${r.g.name.padEnd(26)} A: worst3 ${tA ? (tA.exWorst >= 0 ? "+" : "") + tA.exWorst.toFixed(4) : "n/a"} / best3 ${tA ? (tA.exBest >= 0 ? "+" : "") + tA.exBest.toFixed(4) : "n/a"} ${tA?.stable ? "STABLE" : "not stable"}`);
  console.log(`    ${"".padEnd(26)} B: worst3 ${tB ? (tB.exWorst >= 0 ? "+" : "") + tB.exWorst.toFixed(4) : "n/a"} / best3 ${tB ? (tB.exBest >= 0 ? "+" : "") + tB.exBest.toFixed(4) : "n/a"} ${tB?.stable ? "STABLE" : "not stable"}`);
}

console.log(`\n  [kucoin-baseline] exposure ${(NOE * 100).toFixed(2)}% of equity, taker round trip ${TAKER_RT}% on notional`);
