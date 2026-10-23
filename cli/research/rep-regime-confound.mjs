#!/usr/bin/env node
/**
 * IS THE INDEPENDENT VENUE'S EXCESS A SIGNAL, OR THE MARKET'S DRIFT?
 *
 * The Binance run showed a POSITIVE direction-matched excess, and the
 * placebo (the same rows traded the other way) is strongly NEGATIVE.
 * That is the right shape for an edge — but it is ALSO the right shape
 * for a market that fell, because in a falling market a SHORT wins and
 * a LONG loses, whatever the signal says.
 *
 * So the excess must be tested against the RIGHT baseline: not "the
 * tape's direction, unfiltered" but "the SAME DIRECTION, on a market
 * that moved the same way". The project's own rule is that a signal
 * which merely tracks the market is beta, not edge.
 *
 * THE TEST: the REGIME-MATCHED EXCESS.
 *
 * Each observation carries the market's own state at that instant (the
 * tape's 24-hour change). The signal arm's rows are bucketed by that
 * state, and each bucket is compared with the unconditional arm's rows
 * from the SAME bucket. A signal that only works in a falling market
 * shows an excess there, and its excess in a RISING market is zero or
 * negative. A real signal shows an excess in BOTH.
 *
 * THE SECOND TEST: the DIRECTION-ONLY EXCESS. Take the signal arm's
 * rows and compare them with the unconditional arm's rows of the SAME
 * direction AND the SAME regime bucket. That is the tightest
 * comparison available, and it is the number that answers the question.
 *
 * THE THIRD TEST: the SYMBOL-CLUSTERED version. The 38 symbols are
 * correlated with each other, and a market-wide move produces 38
 * near-identical rows. So the excess is also measured with the symbol
 * as the cluster, not just time. If the excess survives being clustered
 * by symbol, it is not one symbol's move.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched, armFacts, bucketOf } from "./rep-measure.mjs";
import { mean, se, clusterStats } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const rawObs = readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8");
const obs = rawObs.trimStart().startsWith("[")
  ? JSON.parse(rawObs)
  : rawObs.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "rep-binance-15m-bars.json"), "utf8"));
const TAKER_RT = 0.10;

const { B, C } = buildArms(obs, { book: false, jev: false });
console.log(`[regime] ${obs.length} observations, signal arm ${B.length} rows, unconditional ${C.length} rows`);

/**
 * The market's state at the observation, from the tape's own 24-hour
 * change: up (chg > 0), down (chg < 0), flat (chg == 0).
 */
const regimeOf = (r) => (r.tapeChg > 0 ? "up" : r.tapeChg < 0 ? "down" : "flat");

// ── TEST 1: THE REGIME-MATCHED EXCESS ─────────────────────────────────
console.log(`\n═══ TEST 1 — THE REGIME-MATCHED EXCESS (the signal compared with the`);
console.log(`    unconditional arm of the SAME regime) ═══`);
for (const g of GEOMETRIES) {
  const lines = [];
  for (const reg of ["up", "down", "flat"]) {
    const s = B.filter((r) => regimeOf(r) === reg);
    const u = C.filter((r) => regimeOf(r) === reg);
    if (!s.length || !u.length) { lines.push(`${reg}: no data`); continue; }
    const m = measureDirectionMatched(s, u, g, CACHE, { takerRt: TAKER_RT });
    lines.push(`${reg}: n=${m.rows} clus=${m.clusters} exc=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}% t=${m.t.toFixed(2)}`);
  }
  console.log(`  ${g.name}`);
  for (const l of lines) console.log(`    ${l}`);
}

// ── TEST 2: THE DIRECTION-AND-REGIME-MATCHED EXCESS ──────────────────
console.log(`\n═══ TEST 2 — THE DIRECTION-AND-REGIME-MATCHED EXCESS (the tightest) ═══`);
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

// ── TEST 3: THE SYMBOL-CLUSTERED EXCESS ──────────────────────────────
console.log(`\n═══ TEST 3 — THE SYMBOL-CLUSTERED EXCESS (cluster by SYMBOL, not by time) ═══`);
console.log(`    The 38 symbols move together, so a market-wide move produces 38`);
console.log(`    near-identical rows. If the excess survives being clustered by`);
console.log(`    symbol, it is not one symbol's move.`);

/**
 * The direction-matched excess with the SYMBOL as the cluster.
 *
 * The measurement engine clusters by TIME bucket. This variant clusters
 * by symbol instead, so the t-statistic reflects the number of
 * independent SYMBOLS rather than the number of independent moments.
 */
function measureSymbolClustered(signalSet, uncondSet, g, cache, opts) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signalSet.filter((r) => r.dir === dir);
    const u = uncondSet.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0 }); continue; }
    // The per-trade P&L, built exactly as the engine builds it, but
    // clustered by SYMBOL.
    const perTrade = (set) => {
      const wins = [], losses = [], timeExits = [], syms = [];
      const m = measure(set, set, g, cache, opts); // the outcomes
      // Rebuild from the engine's row-level output.
      for (const row of m.signalRows) {
        (row.kind === "win" ? wins : row.kind === "loss" ? losses : timeExits).push(row);
        syms.push(row.c.pair);
      }
      return { wins, losses, timeExits, syms };
    };
    // Measure the signal and the unconditional arms with the engine, then
    // regroup their per-trade P&L by symbol.
    const sRes = perTrade(s);
    const uRes = perTrade(u);
    const sPnl = [...sRes.wins.map(() => (g.tp ?? 0.4) * 1.0484 - TAKER_RT * 1.0484),
                  ...sRes.losses.map(() => -(g.sl ?? 1.2) * 1.0484 - TAKER_RT * 1.0484),
                  ...sRes.timeExits.map((r) => r.pnl)];
    const uPnl = [...uRes.wins.map(() => (g.tp ?? 0.4) * 1.0484 - TAKER_RT * 1.0484),
                  ...uRes.losses.map(() => -(g.sl ?? 1.2) * 1.0484 - TAKER_RT * 1.0484),
                  ...uRes.timeExits.map((r) => r.pnl)];
    const sCl = clusterStats(sPnl, sRes.syms);
    const uCl = clusterStats(uPnl, uRes.syms);
    const excess = sCl.mean - uCl.mean;
    const seC = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
    parts.push({
      dir, rows: s.length, excess, se: seC, t: seC > 0 ? excess / seC : 0,
      weight: s.length / signalSet.length,
      sClusters: sCl.clusters, uClusters: uCl.clusters,
    });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se: seC, t: seC > 0 ? excess / seC : 0 };
}

for (const g of GEOMETRIES) {
  const m = measureSymbolClustered(B, C, g, CACHE, { takerRt: TAKER_RT });
  const detail = m.parts.map((p) => `${p.dir}: n=${p.rows} symClus=${p.sClusters} exc=${(p.excess >= 0 ? "+" : "") + p.excess.toFixed(4)}% t=${p.t.toFixed(2)}`).join("  |  ");
  console.log(`  ${g.name.padEnd(26)} COMBINED exc=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}% t=${m.t.toFixed(2)}`);
  console.log(`    ${detail}`);
}
