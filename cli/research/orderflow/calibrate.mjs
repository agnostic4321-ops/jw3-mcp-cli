/**
 * CALIBRATION — does this harness reproduce the CITED baseline?
 *
 * The project has already measured, with its own machinery:
 *   - the live-gate arm: 11 resolved trades, 11 wins,
 *     EV +0.3244% of equity per trade
 *   - the confirmation layer's excess over the tape-only control:
 *     +0.0752% of equity per trade, t = 3.15, over 9 paired clusters
 *
 * If this harness cannot reproduce those numbers on the same data, then
 * every number it produces afterwards is meaningless.
 */
import { join } from "node:path";
import {
  SCRATCH, loadRows, loadBars, mean, fmt, clusterStats, pairedExcess,
  resolveTicket, RHO, ROUND_TRIP, NOTIONAL, EQUITY, bucketOf,
} from "./lib.mjs";

const rows = loadRows(join(SCRATCH, "oflow/conf-at-baseline.json"));
const bars = loadBars(join(SCRATCH, "oflow/bars-at-baseline.json"));

console.log(`[calib] rows ${rows.length}`);
const ts = rows.map((r) => r.ts).sort((a, b) => a - b);
console.log(`[calib] span ${new Date(ts[0]).toISOString()} -> ${new Date(ts[ts.length - 1]).toISOString()}`);

// ── the live gate, exactly as live-gate-ev.mjs implements it ──
function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev || !laya || jev !== laya) return null;
  return jev;
}
const tapeSide = (r) => r.tapeSide ?? null;

const liveArm = [], tapeArm = [];
for (const r of rows) {
  const t = tapeSide(r);
  if (!t) continue;
  tapeArm.push({ ...r, dir: t });
  const g = liveGate(r);
  if (g && g === t) liveArm.push({ ...r, dir: g });
}

function simulate(arm, label) {
  const perTrade = [], buckets = [];
  let wins = 0, losses = 0, times = 0;
  for (const r of arm) {
    const o = resolveTicket(r, r.dir, bars);
    if (!o) continue;
    perTrade.push(o.pnlPct * RHO * 100); // % of equity
    buckets.push(bucketOf(r.ts));
    if (o.outcome === "win") wins++;
    else if (o.outcome === "loss") losses++;
    else times++;
  }
  const n = wins + losses;
  const cs = clusterStats(perTrade, buckets);
  return {
    label, n: perTrade.length, wins, losses, times,
    winRate: n ? wins / n : 0,
    ev: mean(perTrade), clusters: cs.clusters, clusterSe: cs.se,
    perTrade, buckets,
  };
}

const A = simulate(liveArm, "LIVE-GATE");
const B = simulate(tapeArm, "TAPE-ONLY");

console.log();
console.log("  arm            n  resolved  win%  time%  EV % of equity  clusters");
for (const s of [A, B]) {
  console.log(`  ${s.label.padEnd(13)}${String(s.n).padStart(3)}${String(s.n).padStart(9)}` +
    `${(s.winRate * 100).toFixed(1).padStart(7)}${((s.times / Math.max(1, s.n)) * 100).toFixed(1).padStart(8)}` +
    `${fmt(s.ev).padStart(17)}${String(s.clusters).padStart(10)}`);
}

const ex = pairedExcess(A.perTrade, B.perTrade, A.buckets, B.buckets);
console.log();
console.log("  ── THE EXCESS over the tape-only control (paired by cluster) ──");
console.log(`     paired clusters: ${ex.n}`);
console.log(`     excess: ${fmt(ex.mean)}% of equity   se ${fmt(ex.se)}   t = ${fmt(ex.t, 2)}`);

console.log();
console.log("  ── THE CITED BASELINE ──");
console.log("     11 resolved trades, 11 wins, EV +0.3244% of equity");
console.log("     confirmation excess +0.0752% of equity, t = 3.15, 9 paired clusters");
console.log("  ── THIS HARNESS ──");
console.log(`     ${A.n} resolved trades, ${A.wins} wins, EV ${fmt(A.ev)}% of equity`);
console.log(`     excess ${fmt(ex.mean)}% of equity, t = ${fmt(ex.t, 2)}, ${ex.n} paired clusters`);
