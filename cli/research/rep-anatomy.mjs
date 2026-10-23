#!/usr/bin/env node
/**
 * THE ANATOMY OF THE BINANCE SIGNAL — what the replicable arm IS.
 *
 * The cell-matched randomization test says the independent venue's
 * signal beats a random draw from the same market state (p=0.002). That
 * is a real result, and it needs an explanation before it is reported,
 * because the signal is NOT the machine's own signal — the JEV leg is an
 * LLM and cannot be reproduced. So what does the arm actually select?
 *
 * The arm is: the tape's exhaustion side == the Laya bridge's choice,
 * with the JEV leg blanked and the book leg blanked. The Laya bridge
 * without the JEV and book legs is:
 *
 *   score = sign(chg) x min(|chg| / max(2xATR, 0.5), 1) x 0.6
 *   choice = long if score >= 0.35, short if score <= -0.35, else flat
 *
 * So with the book leg gone, the Laya bridge is a pure 24-HOUR
 * MOMENTUM vote on the tape's own change, and it only DECIDES when
 * |chg| is large relative to ATR.
 *
 * The arm therefore selects: rows where the tape's EXHAUSTION read
 * (near the high, faded volume -> short; near the low, faded volume ->
 * long) agrees with a LARGE 24-hour move in that same direction.
 *
 * This script reports the anatomy, the per-cell detail, and — the
 * important one — the excess measured with the JEV-and-book-free Laya
 * leg REPLACED BY a pure momentum vote, so the reader can see how much
 * of the edge is the tape's exhaustion read and how much is the
 * momentum vote it is being compared against.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched } from "./rep-measure.mjs";
import { layaVerdict } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;
const TAKER_RT = 0.10;

const raw = readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8");
const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(join(SCRATCH, "rep-binance-15m-bars.json"), "utf8"));

const { B, C } = buildArms(rows, { book: false, jev: false });
console.log(`[anatomy] ${rows.length} observations, signal arm ${B.length} rows, unconditional ${C.length}`);

// ── 1. THE ARM'S ANATOMY ──────────────────────────────────────────────
console.log(`\n═══ 1. THE ANATOMY OF THE SIGNAL ARM ═══`);
const anatomy = { long: 0, short: 0 };
const chgStats = { long: [], short: [] };
const offHigh = { long: [], short: [] };
const offLow = { long: [], short: [] };
const vratio = { long: [], short: [] };
const atr = { long: [], short: [] };
for (const r of B) {
  anatomy[r.dir] = (anatomy[r.dir] ?? 0) + 1;
  chgStats[r.dir].push(r.tapeChg);
  offHigh[r.dir].push(r.tapeOffHighPct);
  offLow[r.dir].push(r.tapeOffLowPct);
  vratio[r.dir].push(r.tapeVratio);
  atr[r.dir].push(r.tapeAtrPct);
}
const med = (a) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const dir of ["long", "short"]) {
  if (!anatomy[dir]) continue;
  console.log(`  ${dir.toUpperCase()} (${anatomy[dir]} rows):  median chg=${med(chgStats[dir]).toFixed(2)}%  offHigh=${med(offHigh[dir]).toFixed(1)}pp  offLow=${med(offLow[dir]).toFixed(1)}pp  vratio=${med(vratio[dir]).toFixed(2)}  atr=${med(atr[dir]).toFixed(2)}pp`);
}
console.log(`\n  The Laya bridge with the JEV and book legs blanked is a pure 24-hour`);
console.log(`  MOMENTUM vote: it says LONG when chg is a large POSITIVE, SHORT when a`);
console.log(`  large NEGATIVE, and flat otherwise. So the arm selects rows where the`);
console.log(`  tape's EXHAUSTION read agrees with a LARGE 24-hour move in the same`);

// ── 2. THE SIGNAL'S OWN PREDICTIVE POWER ─────────────────────────────
console.log(`\n═══ 2. HOW MUCH OF THE EDGE IS THE TAPE'S EXHAUSTION READ? ═══`);
console.log(`  The arm is compared against three baselines, each nested:`);

/**
 * A PURE MOMENTUM baseline: the same rows, but the direction is the
 * 24-hour momentum (the Laya bridge's tape term) with no exhaustion
 * read at all. If the excess over THIS baseline is zero, the tape's
 * exhaustion read is doing nothing and the arm is just momentum.
 */
const momentumOnly = (r) => {
  const atr = r.tapeAtrPct;
  const denom = atr != null && atr > 0 ? Math.max(2 * atr, 0.5) : 0.5;
  const tu = Math.max(-1, Math.min(r.tapeChg / denom, 1));
  const score = (tu >= 0 ? 1 : -1) * Math.abs(tu) * 0.6;
  if (score >= 0.35) return "long";
  if (score <= -0.35) return "short";
  return null;
};
const momC = C.filter((r) => momentumOnly(r)).map((r) => ({ ...r, dir: momentumOnly(r) }));
const momB = B.map((r) => ({ ...r, dir: momentumOnly(r) ?? r.dir }));
console.log(`  BASELINE 1  the unconditional tape arm (every tape read, the study's own)`);
console.log(`  BASELINE 2  the MOMENTUM arm (the Laya tape term alone, no exhaustion read)`);
console.log(`  BASELINE 3  the arm compared with ITSELF, no model filter (sanity)\n`);

for (const g of GEOMETRIES) {
  const m1 = measureDirectionMatched(B, C, g, bars, { takerRt: TAKER_RT });
  const m2 = measureDirectionMatched(momB, momC, g, bars, { takerRt: TAKER_RT });
  console.log(`  ${g.name.padEnd(26)} vs BASELINE 1: ${(m1.excess >= 0 ? "+" : "") + m1.excess.toFixed(4)}% t=${m1.t.toFixed(2)}   vs BASELINE 2 (momentum): ${(m2.excess >= 0 ? "+" : "") + m2.excess.toFixed(4)}% t=${m2.t.toFixed(2)}`);
}

// ── 3. THE PER-CELL DETAIL ────────────────────────────────────────────
console.log(`\n═══ 3. THE PER-CELL DETAIL (direction x decile of the 24h move) ═══`);
const sorted = C.map((r) => r.tapeChg).sort((a, b) => a - b);
const cuts = [];
for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
console.log(`  decile cuts: ${cuts.map((c) => c.toFixed(1)).join(", ")}`);
const dec = (chg) => { let d = 0; while (d < cuts.length && chg >= cuts[d]) d++; return d; };
for (const g of GEOMETRIES.slice(0, 4)) {
  console.log(`  ${g.name}`);
  for (const dir of ["long", "short"]) {
    for (let d = 0; d < 10; d++) {
      const s = B.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
      const u = C.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
      if (!s.length || !u.length) continue;
      const m = measureDirectionMatched(s, u, g, bars, { takerRt: TAKER_RT });
      // The win rates come from the DIRECT measure, not from the
      // direction-matched wrapper: the wrapper's parts[] is indexed by
      // the DIRECTION list ("long" first), so for a short-only cell
      // parts[0] is the empty LONG part.
      const raw = measure(s, u, g, bars, { takerRt: TAKER_RT });
      console.log(`    ${dir}/d${d}: signal n=${String(m.rows).padStart(5)} clus=${String(m.clusters).padStart(4)} uncond n=${String(u.length).padStart(5)}  EXCESS=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}%  t=${m.t.toFixed(2)}  sigWin%=${(raw.winRate * 100).toFixed(1)}  uncWin%=${(raw.uWinRate * 100).toFixed(1)}`);
    }
  }
}
