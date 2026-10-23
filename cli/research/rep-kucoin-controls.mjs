#!/usr/bin/env node
/**
 * THE SAME THREE CONTROLS, ON THE KUCOIN SIDE.
 *
 * The independent venue's excess was killed by three controls:
 *
 *   1. the DIRECTION-AND-REGIME-matched excess (the signal compared
 *      with the unconditional arm of the same direction AND the same
 *      market regime);
 *   2. the SYMBOL-clustered excess (the 38 symbols move together, so a
 *      market-wide move produces 38 near-identical rows);
 *   3. the PLACEBO (the same rows traded the other way).
 *
 * The comparison is only fair if the KuCoin side is put through the
 * SAME controls. This runs them there, so the two venues' numbers are
 * measured by one standard.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched } from "./rep-measure.mjs";
import { clusterStats } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const rows = readFileSync(join(SCRATCH, "rep-confluence.parent-snap.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "rep-kucoin-15m-bars.parent-snap.json"), "utf8"));
const TAKER_RT = 0.12;

const { A, B, C } = buildArms(rows, { book: false, jev: false });
console.log(`[kucoin-controls] ${rows.length} rows, signal arm ${B.length}, unconditional ${C.length}`);

const regimeOf = (r) => (r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat");

// ── CONTROL 1: the DIRECTION-AND-REGIME-matched excess ───────────────
console.log(`\n═══ CONTROL 1 — THE DIRECTION-AND-REGIME-MATCHED EXCESS ═══`);
for (const g of GEOMETRIES) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    for (const reg of ["up", "down", "flat"]) {
      const s = B.filter((r) => r.dir === dir && regimeOf(r) === reg);
      const u = C.filter((r) => r.dir === dir && regimeOf(r) === reg);
      if (!s.length || !u.length) continue;
      const m = measureDirectionMatched(s, u, g, CACHE, { takerRt: TAKER_RT });
      parts.push({ dir, reg, rows: m.rows, clusters: m.clusters, excess: m.excess, t: m.t, weight: m.rows / B.length });
    }
  }
  if (!parts.length) { console.log(`  ${g.name}: no data`); continue; }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * (p.t !== 0 ? (p.excess / p.t) ** 2 : 0), 0));
  const t = seC > 0 ? excess / seC : 0;
  const detail = parts.map((p) => `${p.dir}/${p.reg}: n=${p.rows} clus=${p.clusters} exc=${(p.excess >= 0 ? "+" : "") + p.excess.toFixed(4)}% t=${p.t.toFixed(2)}`).join("  |  ");
  console.log(`  ${g.name.padEnd(26)} COMBINED exc=${(excess >= 0 ? "+" : "") + excess.toFixed(4)}% t=${t.toFixed(2)}`);
  console.log(`    ${detail}`);
}

// ── CONTROL 2: the SYMBOL-clustered excess ───────────────────────────
console.log(`\n═══ CONTROL 2 — THE SYMBOL-CLUSTERED EXCESS ═══`);
function symbolClustered(signalSet, uncondSet, g, cache, opts) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signalSet.filter((r) => r.dir === dir);
    const u = uncondSet.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0, sClusters: 0 }); continue; }
    const NOE = 1.0484;
    const grab = (set) => {
      const m = measure(set, set, g, cache, opts);
      const rowsArr = m.signalRows;
      const pnl = [], syms = [];
      for (const r of rowsArr) {
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
    parts.push({ dir, rows: s.length, excess, se: seC, t: seC > 0 ? excess / seC : 0, weight: s.length / signalSet.length, sClusters: sCl.clusters });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se: seC, t: seC > 0 ? excess / seC : 0 };
}
for (const g of GEOMETRIES) {
  const m = symbolClustered(B, C, g, CACHE, { takerRt: TAKER_RT });
  const detail = m.parts.map((p) => `${p.dir}: n=${p.rows} symClus=${p.sClusters} exc=${(p.excess >= 0 ? "+" : "") + p.excess.toFixed(4)}% t=${p.t.toFixed(2)}`).join("  |  ");
  console.log(`  ${g.name.padEnd(26)} COMBINED exc=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}% t=${m.t.toFixed(2)}`);
  console.log(`    ${detail}`);
}

// ── CONTROL 3: the PLACEBO ───────────────────────────────────────────
console.log(`\n═══ CONTROL 3 — THE PLACEBO (the same rows, traded the other way) ═══`);
const placebo = B.map((r) => ({ ...r, dir: r.dir === "long" ? "short" : "long" }));
for (const g of GEOMETRIES) {
  const m = measure(placebo, C, g, CACHE, { takerRt: TAKER_RT });
  console.log(`  ${g.name.padEnd(26)} placebo EXCESS=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}%  t=${m.excessT.toFixed(2)}  win%=${(m.winRate * 100).toFixed(1)}`);
}

// ── AND the machine's OWN signal, under the same controls ────────────
console.log(`\n═══ THE MACHINE'S OWN SIGNAL (arm A), under the same controls ═══`);
for (const g of GEOMETRIES.slice(0, 5)) {
  const dm = measureDirectionMatched(A, C, g, CACHE, { takerRt: TAKER_RT });
  const sc = symbolClustered(A, C, g, CACHE, { takerRt: TAKER_RT });
  console.log(`  ${g.name.padEnd(26)} dir-mat exc=${(dm.excess >= 0 ? "+" : "") + dm.excess.toFixed(4)}% t=${dm.t.toFixed(2)}   sym-clust exc=${(sc.excess >= 0 ? "+" : "") + sc.excess.toFixed(4)}% t=${sc.t.toFixed(2)}`);
}
