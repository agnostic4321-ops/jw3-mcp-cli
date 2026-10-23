#!/usr/bin/env node
/**
 * THE OVERLAP CHECK — is the independent venue's effect real, or an
 * artefact of OVERLAPPING trades?
 *
 * The ticket holds a position for up to 4 hours. The clusters are 5
 * minutes wide. So a trade opened at 10:00 and a trade opened at 10:05
 * are, for most of their life, THE SAME TRADE: they share the same
 * entry price, the same path, and the same exit. The 5-minute cluster
 * counts them as independent, and they are not.
 *
 * The number of INDEPENDENT observations in a 4-hour-hold window is
 * closer to (span / 4 hours) than to (span / 5 minutes). For a 14-day
 * window that is ~84, not ~3144. So the clustered t-statistic computed
 * at 5 minutes is optimistic, and the effect has to be re-measured
 * with a cluster width that matches the trade's holding period.
 *
 * This re-measures the excess with the cluster width set to 4 HOURS —
 * the actual holding period — so that two rows in one cluster are two
 * trades that genuinely overlap.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched } from "./rep-measure.mjs";
import { mean, se, clusterStats } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;
const HOLD_MS = 4 * 3600_000; // the ticket's maximum hold

const raw = readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8");
const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(join(SCRATCH, "rep-binance-15m-bars.json"), "utf8"));
const TAKER_RT = 0.10;
const { B, C } = buildArms(rows, { book: false, jev: false });

/**
 * The excess with the cluster width set to the trade's holding period.
 * The per-trade P&L is built exactly as the engine builds it, then
 * clustered by a 4-hour bucket instead of a 5-minute one.
 */
function holdClustered(signal, uncond, g, widthMs) {
  const parts = [];
  for (const dir of ["long", "short"]) {
    const s = signal.filter((r) => r.dir === dir);
    const u = uncond.filter((r) => r.dir === dir);
    if (!s.length) { parts.push({ dir, rows: 0, excess: 0, se: 0, weight: 0, t: 0, clusters: 0 }); continue; }
    const grab = (set) => {
      const m = measure(set, set, g, bars, { takerRt: TAKER_RT });
      const pnl = [], buckets = [];
      for (const r of m.signalRows) {
        pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - TAKER_RT * NOE
          : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - TAKER_RT * NOE
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
    const seC = Math.sqrt(sCl.se ** 2 + uCl.se ** 2);
    parts.push({ dir, rows: s.length, excess, se: seC, t: seC > 0 ? excess / seC : 0, weight: s.length / signal.length, clusters: sCl.clusters });
  }
  const excess = parts.reduce((s, p) => s + p.weight * p.excess, 0);
  const seC = Math.sqrt(parts.reduce((s, p) => s + p.weight ** 2 * p.se ** 2, 0));
  return { parts, excess, se: seC, t: seC > 0 ? excess / seC : 0 };
}

console.log(`[overlap] the ticket holds for up to 4 hours, so a 5-minute cluster counts`);
console.log(`[overlap] trades that share most of their life as INDEPENDENT.`);
console.log(`[overlap] signal arm ${B.length} rows; unconditional ${C.length} rows\n`);

for (const g of GEOMETRIES) {
  const m5 = holdClustered(B, C, g, 5 * 60_000);
  const m60 = holdClustered(B, C, g, 60 * 60_000);
  const mHold = holdClustered(B, C, g, HOLD_MS);
  const mDay = holdClustered(B, C, g, 24 * 3600_000);
  console.log(`  ${g.name}`);
  console.log(`    cluster  5 min: exc=${(m5.excess >= 0 ? "+" : "") + m5.excess.toFixed(4)}%  t=${m5.t.toFixed(2)}  (${m5.parts.reduce((s, p) => s + p.clusters, 0)} clusters)`);
  console.log(`    cluster  1 hour: exc=${(m60.excess >= 0 ? "+" : "") + m60.excess.toFixed(4)}%  t=${m60.t.toFixed(2)}  (${m60.parts.reduce((s, p) => s + p.clusters, 0)} clusters)`);
  console.log(`    cluster  4 hours (the HOLD): exc=${(mHold.excess >= 0 ? "+" : "") + mHold.excess.toFixed(4)}%  t=${mHold.t.toFixed(2)}  (${mHold.parts.reduce((s, p) => s + p.clusters, 0)} clusters)`);
  console.log(`    cluster  1 day:   exc=${(mDay.excess >= 0 ? "+" : "") + mDay.excess.toFixed(4)}%  t=${mDay.t.toFixed(2)}  (${mDay.parts.reduce((s, p) => s + p.clusters, 0)} clusters)`);
}

// The number of genuinely independent 4-hour windows in the window.
const tsAll = rows.map((o) => o.ts);
let lo = tsAll[0], hi = tsAll[0];
for (const t of tsAll) { if (t < lo) lo = t; if (t > hi) hi = t; }
const spanH = (hi - lo) / 3_600_000;
console.log(`\n[overlap] the window spans ${spanH.toFixed(1)} hours = ${(spanH / 4).toFixed(0)} independent 4-hour trade windows.`);
console.log(`[overlap] the 5-minute clustering counts ${new Set(B.map((r) => Math.floor(r.ts / 300000))).size} clusters for the signal arm —`);
console.log(`[overlap] ${(new Set(B.map((r) => Math.floor(r.ts / 300000))).size / (spanH / 4)).toFixed(0)}x more than the trade can actually be independent.`);
