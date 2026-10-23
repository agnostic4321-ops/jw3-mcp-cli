#!/usr/bin/env node
/**
 * DIAGNOSTICS for the hero geometry sweep.
 *
 * Answers, before any geometry is simulated:
 *   1. Can the signal arm be extended EARLIER than the collector's
 *      `tapeSide` field begins (so a 240-minute time exit has forward
 *      coverage)?
 *   2. How good is the entry anchor: the collector's book mid vs the last
 *      CLOSED bar's close?
 *   3. What is the real 4-hour excursion, and what fraction of windows
 *      reach a given target / stop?
 *   4. The long side: does the signal arm have ANY long observation?
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN = join(SCRATCH, "confluence.ndjson");

const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(join(SCRATCH, "geom-hero-bars.json"), "utf8"));

// ── 1. can the arm be extended earlier? ──
const tapeSideDerived = (r) => tapeSideFromRow(r);
const modelSideOf = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return j && l ? (j === l ? j : null) : (j || l);
};
const strict = (r) => r.side && r.tapeSide && r.tapeSide === r.side && r.jevUncertain === false;
const loose = (r) => {
  const t = tapeSideDerived(r);
  if (!t) return false;
  const m = modelSideOf(r);
  return !!m && m === t;
};
const hasTape = (r) => Number.isFinite(Number(r.tapeVratio)) && Number.isFinite(Number(r.tapeOffHighPct));

console.log("═══ 1. THE SIGNAL ARM, AND HOW FAR BACK IT GOES ═══");
const groups = {
  "ALL rows": rows,
  "rows with the derived tape side": rows.filter(tapeSideDerived),
  "LOOSE arm (tape agrees with a model leg)": rows.filter(loose),
  "STRICT arm (the machine's own gate)": rows.filter(strict),
};
for (const [name, set] of Object.entries(groups)) {
  if (!set.length) { console.log(`  ${name.padEnd(40)} n=0`); continue; }
  const ts = set.map((r) => r.ts);
  const sides = {};
  for (const r of set) { const s = r.dir ?? r.side ?? r.tapeSide; sides[s] = (sides[s] ?? 0) + 1; }
  console.log(
    `  ${name.padEnd(40)} n=${String(set.length).padStart(4)}  clusters=${String(new Set(set.map((r) => Math.floor(r.ts / 300000))).size).padStart(3)}  ${new Date(minOf(ts)).toISOString().slice(11, 16)} -> ${new Date(maxOf(ts)).toISOString().slice(11, 16)}  sides=${JSON.stringify(sides)}`,
  );
}
console.log("  Rows with the DERIVED tape side but no `tapeSide` FIELD (the collector's early rows):");
const early = rows.filter((r) => hasTape(r) && !r.tapeSide && tapeSideDerived(r));
console.log(`    ${early.length} rows; the earliest is ${early.length ? new Date(minBy(early, (r) => r.ts)).toISOString() : "n/a"}`);
console.log(`  The FIRST row overall: ${new Date(minBy(rows, (r) => r.ts)).toISOString()}`);
console.log(`  The FIRST row with a derived tape side: ${new Date(minOf(rows.filter(tapeSideDerived).map((r) => r.ts))).toISOString()}`);
console.log();

// ── 2. the entry anchor ──
console.log("═══ 2. THE ENTRY ANCHOR — the collector's book mid vs the last CLOSED bar ═══");
const lastClosedClose = (pair, ts) => {
  const b = bars[pair];
  if (!b?.length) return null;
  let idx = -1;
  for (let i = 0; i < b.length; i++) { if (b[i].t + 300000 <= ts) idx = i; else break; }
  return idx < 0 ? null : { c: b[idx].c, t: b[idx].t };
};
for (const [name, set] of [["LOOSE", rows.filter(loose)], ["ALL", rows]]) {
  const diffs = [];
  let noBar = 0;
  for (const r of set) {
    const lc = lastClosedClose(r.pair, r.ts);
    if (!lc) { noBar++; continue; }
    const px = Number(r.price);
    if (!(px > 0)) continue;
    diffs.push(Math.abs((px - lc.c) / lc.c) * 100);
  }
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  const p95 = diffs[Math.floor(diffs.length * 0.95)];
  const worst = diffs[diffs.length - 1];
  console.log(`  ${name.padEnd(6)} n=${String(diffs.length).padStart(4)} (no bar: ${noBar})  |price - close|  median ${med.toFixed(4)}%  p95 ${p95.toFixed(4)}%  worst ${worst.toFixed(4)}%`);
  console.log(`         ${(diffs.filter((d) => d > 1).length)} rows are more than 1% off the last close, ${(diffs.filter((d) => d > 5).length)} more than 5%.`);
}
console.log();

// ── 3. the excursion, measured on the signal arm's own bars ──
console.log("═══ 3. THE REAL EXCURSION (signal arm, 5-minute bars) ═══");
const HORIZONS = [15, 30, 60, 120, 180, 240];
const sig = rows.filter(loose);
for (const H of HORIZONS) {
  const ups = [], downs = [];
  let n = 0, neither = 0;
  for (const r of sig) {
    const b = bars[r.pair];
    if (!b?.length) continue;
    const lc = lastClosedClose(r.pair, r.ts);
    if (!lc) continue;
    // The forward window from the observation.
    const fwd = b.filter((x) => x.t + 300000 > r.ts && x.t <= r.ts + H * 60000);
    if (!fwd.length) continue;
    n++;
    const up = (maxBy(fwd, (x) => x.h) - lc.c) / lc.c * 100;
    const dn = (lc.c - minBy(fwd, (x) => x.l)) / lc.c * 100;
    ups.push(up); downs.push(dn);
    if (up < 0.5 && dn < 1.2) neither++;
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log(
    `  ${String(H + "m").padStart(5)}  n=${String(n).padStart(3)}  up mean ${mean(ups).toFixed(3)}% med ${med(ups).toFixed(3)}%   down mean ${mean(downs).toFixed(3)}% med ${med(downs).toFixed(3)}%   neither(0.5/1.2): ${neither ? ((neither / n) * 100).toFixed(0) : "-"}%`,
  );
}
console.log();

// ── 4. the long side ──
console.log("═══ 4. THE LONG SIDE ═══");
const longTape = rows.filter((r) => tapeSideDerived(r) === "long");
console.log(`  rows whose tape points LONG: ${longTape.length}`);
const longSignal = sig.filter((r) => r.dir === "long");
console.log(`  rows in the signal arm that are LONG: ${longSignal.length}`);
const longStrict = rows.filter(strict).filter((r) => r.side === "long");
console.log(`  rows in the strict arm that are LONG: ${longStrict.length}`);
const dipRows = rows.filter((r) => {
  const t = tapeSideDerived(r);
  return t === "long";
});
console.log(`  dip-long rows: ${dipRows.length}, of which the models agreed: ${dipRows.filter((r) => modelSideOf(r) === "long").length}`);
console.log();

// ── 5. the fee schedule reality ──
console.log("═══ 5. THE FEE, AS THE LIVE PATH CHARGES IT ═══");
console.log("  live.ts: entryLeg = 'maker' (0.02%), exitLeg = 'taker' (0.06%) -> round trip 0.08% of notional");
console.log("  the task's floor: 100% taker -> 0.12% of notional");
console.log("  the sweep reports BOTH. The 0.12% is the conservative primary.");
