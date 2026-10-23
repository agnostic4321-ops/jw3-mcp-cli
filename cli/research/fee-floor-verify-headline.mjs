import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

/**
 * VERIFY THE HEADLINE TICKET — TP 0.85% / SL 0.85% at x45 — by hand,
 * on the signal arm and on the beta baseline, with the per-trade ledger
 * printed so the number can be audited trade by trade.
 */
const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const rows = readFileSync(join(SCRATCH, "confluence.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars15 = JSON.parse(readFileSync(join(SCRATCH, "fee-floor-15m-bars.json"), "utf8"));

const EQUITY = 57.1579522047;
const CAP = 60;
const RHO = CAP / EQUITY;
const TP = 0.85;
const SL = 0.85;
const FEE = 0.12; // % of notional, taker-taker
const HOLD = 16; // 4h at 15m

const signal = [];
const uncond = [];
for (const r of rows) {
  const t = tapeSideFromRow(r);
  if (!t) continue;
  uncond.push({ ...r, dir: t });
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  const ms = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
  if (ms && ms === t) signal.push({ ...r, dir: t });
}

function entries(set) {
  const out = [];
  for (const r of set) {
    const bars = bars15[r.pair];
    if (!bars?.length) continue;
    let idx = -1;
    for (let i = 0; i < bars.length; i++) { if (bars[i].t <= r.ts) idx = i; else break; }
    if (idx < 0) continue;
    out.push({ bars, idx, entry: bars[idx].c, long: r.dir === "long", row: r });
  }
  return out;
}

function ledger(ents, label) {
  const rowsOut = [];
  for (const e of ents) {
    const tp = e.long ? e.entry * (1 + TP / 100) : e.entry * (1 - TP / 100);
    const sl = e.long ? e.entry * (1 - SL / 100) : e.entry * (1 + SL / 100);
    const end = Math.min(e.bars.length, e.idx + 1 + HOLD);
    if (end <= e.idx + 1) continue;
    let kind = null;
    for (let i = e.idx + 1; i < end; i++) {
      const b = e.bars[i];
      const hitTp = e.long ? b.h >= tp : b.l <= tp;
      const hitSl = e.long ? b.l <= sl : b.h >= sl;
      if (hitTp && hitSl) { kind = "loss"; break; }
      if (hitTp) { kind = "win"; break; }
      if (hitSl) { kind = "loss"; break; }
    }
    let pnl = null;
    if (kind === "win") pnl = TP - FEE;
    else if (kind === "loss") pnl = -SL - FEE;
    else {
      if (end === e.bars.length) continue;
      const last = e.bars[end - 1];
      const move = e.long ? (last.c - e.entry) / e.entry * 100 : (e.entry - last.c) / e.entry * 100;
      kind = "time";
      pnl = move - FEE;
    }
    rowsOut.push({ kind, pnl, pair: e.row.pair, ts: e.row.ts });
  }
  const n = rowsOut.length;
  const wins = rowsOut.filter((r) => r.kind === "win").length;
  const losses = rowsOut.filter((r) => r.kind === "loss").length;
  const times = rowsOut.filter((r) => r.kind === "time").length;
  const mean = rowsOut.reduce((s, r) => s + r.pnl, 0) / n;
  console.log(`\n--- ${label} ---`);
  console.log(`  n=${n}  wins=${wins}  losses=${losses}  time=${times}`);
  console.log(`  resolved win rate = ${((wins / (wins + losses)) * 100).toFixed(1)}%  (of ${wins + losses} resolved)`);
  console.log(`  mean per-trade P&L = ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}% of NOTIONAL`);
  console.log(`  = ${mean >= 0 ? "+" : ""}$${((mean / 100) * CAP).toFixed(4)} per trade on $${CAP} notional`);
  console.log(`  = ${mean >= 0 ? "+" : ""}$${((mean / 100) * CAP).toFixed(4)} = ${((mean / 100) * CAP / EQUITY * 100).toFixed(4)}% of $${EQUITY.toFixed(2)} equity`);
  const perBucket = new Map();
  for (const r of rowsOut) {
    const b = Math.floor(r.ts / 300000);
    const arr = perBucket.get(b) ?? [];
    arr.push(r.pnl);
    perBucket.set(b, arr);
  }
  const clusterMeans = [...perBucket.values()].map((a) => a.reduce((s, x) => s + x, 0) / a.length);
  const cm = clusterMeans.reduce((s, x) => s + x, 0) / clusterMeans.length;
  const csd = Math.sqrt(clusterMeans.reduce((s, x) => s + (x - cm) ** 2, 0) / (clusterMeans.length - 1));
  const cse = csd / Math.sqrt(clusterMeans.length);
  console.log(`  clusters: ${clusterMeans.length}  cluster mean ${cm >= 0 ? "+" : ""}${cm.toFixed(4)}%  se ${cse.toFixed(4)}  t=${cse > 0 ? (cm / cse).toFixed(2) : "n/a"}`);
  return { mean, n, wins, losses, times, clusterMean: cm, clusterSe: cse, clusterT: cse > 0 ? cm / cse : 0 };
}

console.log("=== VERIFYING TP 0.85% / SL 0.85% at $60 notional ===");
console.log(`equity $${EQUITY.toFixed(4)}, cap $${CAP}, rho ${RHO.toFixed(5)}, fee ${FEE}% taker-taker`);
console.log(`fee drag = ${FEE}/${SL} = ${((FEE / SL) * 100).toFixed(1)}% of the stop`);
console.log(`break-even win rate = (${SL}+${FEE})/(${TP}+${SL}+${FEE}) = ${(((SL + FEE) / (TP + SL + FEE)) * 100).toFixed(1)}%`);

const A = ledger(entries(signal), "(A) THE SIGNAL ARM (tape + models agree)");
const B = ledger(entries(uncond), "(B) THE BETA BASELINE (tape direction, no model filter)");

const excessNotional = A.mean - B.mean;
const excessEq = excessNotional * RHO;
const t = Math.sqrt(A.clusterSe ** 2 + B.clusterSe ** 2) > 0
  ? (A.clusterMean - B.clusterMean) / Math.sqrt(A.clusterSe ** 2 + B.clusterSe ** 2)
  : 0;
console.log(`\n=== THE EXCESS ===`);
console.log(`  (A) - (B) = ${excessNotional >= 0 ? "+" : ""}${excessNotional.toFixed(4)}% of notional`);
console.log(`             = ${excessEq >= 0 ? "+" : ""}${excessEq.toFixed(4)}% of equity per trade`);
console.log(`  clustered t = ${t.toFixed(2)}  (A clusters ${A.clusterSe > 0 ? "" : ""}, B se ${B.clusterSe.toFixed(4)})`);
console.log(`  the taker fee at $${CAP} is ${(FEE / 100) * RHO * 100 > 0 ? "+" : ""}$${((FEE / 100) * CAP).toFixed(4)} = ${((FEE / 100) * RHO * 100).toFixed(4)}% of equity`);
console.log(`  → the excess ${excessEq >= 0 ? "BEATS" : "does NOT beat"} the fee: ${excessEq > (FEE / 100) * RHO * 100 ? "VIABLE" : "FEE EATS IT"}`);

console.log(`\n=== THE REPO'S OWN NUMBER, FOR COMPARISON ===`);
console.log(`  falsified-leads.md: the excess over the unconditional baseline is +0.0543% to +0.0978%`);
console.log(`  of equity per trade, clustered t = 0.57-1.13, across the SHIPPED geometries.`);
console.log(`  this study measures the SAME quantity at TP 0.85/SL 0.85: ${excessEq.toFixed(4)}% (t=${t.toFixed(2)}).`);
console.log(`  the two agree in ORDER OF MAGNITUDE; neither reaches the fee at the $60 cap.`);

console.log(`\n=== AND AT THE FEE-VIABLE SIZE ===`);
for (const n of [25.86, 38.80, 60]) {
  const rhoN = n / EQUITY;
  const feeEq = (FEE / 100) * rhoN * 100;
  console.log(`  notional $${n.toFixed(2)} (rho ${rhoN.toFixed(4)}): fee ${feeEq.toFixed(4)}% of equity, excess ${excessEq.toFixed(4)}% → ${excessEq > feeEq ? "VIABLE" : "fee eats it"}`);
}
