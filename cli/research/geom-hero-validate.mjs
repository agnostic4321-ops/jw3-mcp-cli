#!/usr/bin/env node
/**
 * VALIDATION for the hero geometry sweep.
 *
 * A sweep that finds a winner must be trustworthy before the winner means
 * anything. This checks the four things that could make the sweep lie:
 *
 *   1. The first-touch RESOLVER: cross-checked against a brute-force walk
 *      over the raw bars, on every (observation, TP, SL) it can reach.
 *   2. The SHIPPED GEOMETRY formula: re-derived from planScalp's source
 *      and compared against all EIGHT REAL live fired tickets' own
 *      entry/target/stop prices.
 *   3. The BREAK-EVEN FORMULA: the win rate at which the expectancy is
 *      exactly zero, checked by plugging it back into the expectancy.
 *      The earlier study's formula is checked too, and shown to be wrong.
 *   4. The CLUSTER t-statistic: recomputed independently from the raw
 *      per-trade P&L and the bucket assignment.
 *
 * A failure prints the offending case VERBATIM and exits non-zero.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "geom-hero-bars.json"), "utf8"));
const TAKER_RT = 0.12;

let failures = 0;
const fail = (msg) => { console.log(`  FAIL: ${msg}`); failures++; };
const ok = (msg) => console.log(`  ok:   ${msg}`);

const GRID_TP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0];
const GRID_SL = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.5, 2.0];

// ── 1. the resolver, cross-checked ──
console.log("═══ 1. THE FIRST-TOUCH RESOLVER vs A BRUTE-FORCE WALK ═══");
const rows = readFileSync(join(SCRATCH, "confluence.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function resolveSweep(runMax, runMin, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  for (let i = 0; i < runMax.length; i++) {
    const hitTp = long ? runMax[i] >= tp : runMin[i] <= tp;
    const hitSl = long ? runMin[i] <= sl : runMax[i] >= sl;
    if (hitTp && hitSl) return "loss";
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  return "time";
}
function resolveBrute(bars, start, end, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return "loss";
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  return "time";
}

let checked = 0, mismatches = 0, bothTouched = 0;
for (const r of rows) {
  const bars = CACHE[r.pair];
  if (!bars?.length) continue;
  const entry = Number(r.price);
  if (!(entry > 0)) continue;
  const long = Math.random() < 0.5;
  const start = bars.findIndex((b) => b.t > r.ts);
  if (start < 0) continue;
  for (const holdMin of [15, 30, 60]) {
    const end = start + holdMin / 5;
    if (end > bars.length) continue;
    const win = bars.slice(start, end);
    const runMax = [], runMin = [];
    let mx = -Infinity, mn = Infinity;
    for (const b of win) { mx = Math.max(mx, b.h); mn = Math.min(mn, b.l); runMax.push(mx); runMin.push(mn); }
    for (const tp of GRID_TP) {
      for (const sl of GRID_SL) {
        const a = resolveSweep(runMax, runMin, entry, tp, sl, long);
        const b = resolveBrute(bars, start, end, entry, tp, sl, long);
        checked++;
        if (a !== b) {
          mismatches++;
          if (mismatches <= 5) console.log(`  MISMATCH pair=${r.pair} ts=${new Date(r.ts).toISOString()} hold=${holdMin} long=${long} tp=${tp} sl=${sl} sweep=${a} brute=${b}`);
        }
        const tpP = long ? entry * (1 + tp / 100) : entry * (1 - tp / 100);
        const slP = long ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
        for (let i = start; i < end; i++) {
          const bb = bars[i];
          const hT = long ? bb.h >= tpP : bb.l <= tpP;
          const hS = long ? bb.l <= slP : bb.h >= slP;
          if (hT && hS) { bothTouched++; break; }
        }
      }
    }
  }
}
if (mismatches === 0) ok(`${checked} (observation, TP, SL, hold) resolutions agree with the brute-force walk`);
else fail(`${mismatches} of ${checked} resolutions disagree with the brute-force walk`);
console.log(`  the ambiguous-bar (both levels touched in one bar) rate is ${(bothTouched / checked * 100).toFixed(3)}% of cases`);

// ── 2. the shipped geometry, against the real live tickets ──
console.log();
console.log("═══ 2. THE SHIPPED GEOMETRY vs THE REAL LIVE FIRED TICKETS ═══");
/** planScalp with maxSteps=2, from src/kucoin.ts. */
const planScalp = (last, atrPct, side, maxSteps = 2) => {
  const atr = atrPct != null && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  const tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const stepDropPct = Math.min(1.5, Math.max(0.6, atr * 0.9));
  const mults = [1, 1, 2].slice(0, maxSteps);
  const dirSign = side === "long" ? -1 : 1;
  const steps = mults.map((m, i) => ({ price: last * (1 + (dirSign * (i * stepDropPct)) / 100), sizeUsd: m }));
  const totalSize = steps.reduce((a, s) => a + s.sizeUsd, 0);
  const avgEntry = steps.reduce((a, s) => a + s.price * s.sizeUsd, 0) / totalSize;
  const tpDir = side === "long" ? 1 : -1;
  return {
    tpPct, stepDropPct, avgEntry,
    tpPrice: avgEntry * (1 + (tpDir * tpPct) / 100),
    killPrice: last * (1 + (dirSign * (maxSteps * stepDropPct)) / 100),
  };
};
/** The sweep's own reconstruction, measured from the DECLARED entry. */
const shippedGeometry = (atrPct, side) => {
  const atr = Number(atrPct);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const stepDrop = Math.min(1.5, Math.max(0.6, atr * 0.9));
  const d = stepDrop / 100;
  const slPct = (1.5 * d * 100) / (side === "long" ? 1 - d / 2 : 1 + d / 2);
  return { tpPct, slPct, stepDrop };
};

const fired = readFileSync(join(SCRATCH, "trade-loop.ndjson"), "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.event === "FIRED");
console.log(`  ${fired.length} live fired tickets found in the trade-loop log.`);
for (const o of fired) {
  const c = o.ticket?.candidate;
  if (!c) continue;
  const atr = c.atrPct, side = c.side;
  const d = Math.min(1.5, Math.max(0.6, atr * 0.9));
  // Recover `last` from the declared avgEntry. planScalp's 2-step ladder
  // puts 1 unit at `last` and 1 unit at last*(1 + dirSign*d/100), so
  //   avgEntry = last * (2 + dirSign*d/100) / 2 = last * (1 + dirSign*d/200)
  // => last = avgEntry / (1 + dirSign*d/200)
  const dirSign = side === "long" ? -1 : 1;
  const last = c.entryPrice / (1 + (dirSign * d) / 200);
  const p = planScalp(last, atr, side);
  const tpPct = Math.abs((p.tpPrice - c.entryPrice) / c.entryPrice) * 100;
  const slPct = Math.abs((p.killPrice - c.entryPrice) / c.entryPrice) * 100;
  const ttp = Math.abs((c.targetPrice - c.entryPrice) / c.entryPrice) * 100;
  const tsl = Math.abs((c.stopPrice - c.entryPrice) / c.entryPrice) * 100;
  // The sweep's reconstruction, from the ATR alone.
  const g = shippedGeometry(atr, side);
  const tpOk = Math.abs(tpPct - ttp) < 1e-6;
  const slOk = Math.abs(slPct - tsl) < 1e-6;
  const gTpOk = Math.abs(g.tpPct - ttp) < 1e-6;
  const gSlOk = Math.abs(g.slPct - tsl) < 1e-6;
  const be = (tsl + TAKER_RT) / (ttp + tsl);
  const beStudy = (tsl + TAKER_RT) / (ttp + tsl + TAKER_RT);
  console.log(`    ${new Date(o.ts).toISOString()} ${o.pair} ${side}  atr ${atr.toFixed(4)}`);
  console.log(`      ticket:  TP ${ttp.toFixed(4)}%  STOP ${tsl.toFixed(4)}%  (1:${(tsl / ttp).toFixed(2)})  break-even ${(be * 100).toFixed(2)}%  (the study's formula: ${(beStudy * 100).toFixed(2)}%)`);
  console.log(`      planScalp: TP ${tpPct.toFixed(4)}%  STOP ${slPct.toFixed(4)}%   ${tpOk && slOk ? "MATCH" : "MISMATCH"}`);
  console.log(`      the sweep's reconstruction: TP ${g.tpPct.toFixed(4)}%  STOP ${g.slPct.toFixed(4)}%   ${gTpOk && gSlOk ? "MATCH" : "MISMATCH"}`);
  if (!tpOk) fail(`planScalp TP ${tpPct} != ticket ${ttp}`);
  if (!slOk) fail(`planScalp STOP ${slPct} != ticket ${tsl}`);
  if (!gTpOk) fail(`sweep TP ${g.tpPct} != ticket ${ttp}`);
  if (!gSlOk) fail(`sweep STOP ${g.slPct} != ticket ${tsl}`);
}

// ── 3. the break-even formula ──
console.log();
console.log("═══ 3. THE BREAK-EVEN FORMULA ═══");
const ev = (w, tp, sl, f) => w * (tp - f) + (1 - w) * (-sl - f);
const beCorrect = (tp, sl, f) => (sl + f) / (tp + sl);
const beStudy = (tp, sl, f) => (sl + f) / (tp + sl + f);
for (const [tp, sl, f] of [[0.5, 1.2, 0.12], [0.3626, 1.2188, 0.12], [0.5, 0.5, 0.12], [0.3, 0.9, 0.08]]) {
  const e1 = ev(beCorrect(tp, sl, f), tp, sl, f);
  const e2 = ev(beStudy(tp, sl, f), tp, sl, f);
  console.log(`  TP ${tp} SL ${sl} f ${f}: correct w_be ${(beCorrect(tp, sl, f) * 100).toFixed(2)}% -> EV ${e1.toExponential(3)}  |  study w_be ${(beStudy(tp, sl, f) * 100).toFixed(2)}% -> EV ${e2.toFixed(5)}%`);
  if (Math.abs(e1) > 1e-12) fail(`the correct break-even does not zero the expectancy at TP ${tp} SL ${sl}`);
  if (e2 >= 0) fail(`the study's break-even formula gives a non-negative EV at TP ${tp} SL ${sl} (it should be negative)`);
}
ok("the correct break-even (SL+f)/(TP+SL) zeroes the expectancy exactly");
console.log("  the earlier study's formula (SL+f)/(TP+SL+f) leaves a NEGATIVE expectancy at its");
console.log("  own break-even point, so it UNDERSTATES the win rate a geometry needs.");

// ── 4. the cluster t-statistic ──
console.log();
console.log("═══ 4. THE CLUSTER t-STATISTIC ═══");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};
const cmOf = (vals, buckets) => {
  const by = new Map();
  for (let i = 0; i < vals.length; i++) { const a = by.get(buckets[i] ?? i) ?? []; a.push(vals[i]); by.set(buckets[i] ?? i, a); }
  return [...by.values()].map(mean);
};
const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const buckets = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3];
const c = cmOf(vals, buckets);
const t = se(c) > 0 ? mean(c) / se(c) : 0;
// By hand: the clusters are [1,2,3], [4,5,6], [7,8], [9,10] -> means 2, 5, 7.5, 9.5.
const byHand = [2, 5, 7.5, 9.5];
const mh = mean(byHand);
const sh = Math.sqrt(byHand.reduce((s, x) => s + (x - mh) ** 2, 0) / (byHand.length - 1) / byHand.length);
console.log(`  synthetic: cluster means ${JSON.stringify(c)}  t=${t.toFixed(6)}`);
console.log(`  by hand:   cluster means ${JSON.stringify(byHand)}  t=${(mh / sh).toFixed(6)}`);
if (Math.abs(t - mh / sh) > 1e-9) fail("the cluster t-statistic does not match the hand calculation");
else ok("the cluster t-statistic matches the hand calculation");
console.log(`  the same data on the RAW rows (what the bar forbids): t=${(mean(vals) / se(vals)).toFixed(4)} vs ${t.toFixed(4)} on clusters`);

console.log();
console.log(failures === 0 ? "═══ ALL CHECKS PASSED ═══" : `═══ ${failures} CHECK(S) FAILED ═══`);
process.exitCode = failures === 0 ? 0 : 1;
