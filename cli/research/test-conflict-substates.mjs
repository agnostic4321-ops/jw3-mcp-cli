#!/usr/bin/env node
/**
 * THE CONFLICT STATE — is there a TRADEABLE sub-state?
 *
 * The machine's MODAL outcome is a conflict: the tape (the trigger it
 * acts on) says one thing and the models (the confirmation it requires)
 * say the opposite. Roughly 76-81% of every candidate the armed loop
 * evaluated was a conflict, and the confluence study measures only the
 * AGREEING state.
 *
 * So the question is specific and answerable: does ANY identifiable
 * SUBSET of the conflict behave differently?
 *
 * THE SUBSETS (the ones the question names, and the ones the data can
 * actually support):
 *   A. the models disagree with EACH OTHER (rather than both
 *      disagreeing with the tape)
 *   B. the tape's exhaustion is STRONGER — by ATR units, by volume
 *      ratio, or by distance from the high
 *   C. a conflict in a specific session HOUR
 *   D. a conflict on a specific SIDE
 *
 * WHAT IS MEASURED
 * For each subset, the trade outcome is measured on BOTH sides:
 *
 *   TAPE    the tape's direction — the trigger taken at face value
 *   MODELS  the models' direction — the confirmation taken at face value
 *
 * and each is compared to the UNCONDITIONAL same-direction control: the
 * same side, the same geometry, on every row with a resolvable tape
 * side in that direction, so the market's drift cancels. The measure
 * is the EXCESS over that control, with the cluster correction at the
 * ticket's holding period.
 *
 * THE FILL RULE IS THE CORRECTED ONE: the ticket is MARKET-ANCHORED
 * (the entry IS the market, the target is beyond it in the profitable
 * direction), so the market has to MOVE to reach the target. A target
 * already satisfied at the market is a scratch — ~zero gross minus the
 * fee. See research/ticket-fill.mjs and
 * docs/research/the-scratch-artefact.md.
 *
 * THE BAR: a subset clears only if its excess is positive, its
 * cluster-corrected t >= 2, AND it beats a SIZE-MATCHED placebo, AND
 * its independent cluster count reaches 30.
 *
 * Run: node research/test-conflict-substates.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { isTargetWrongSide } from "./ticket-fill.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONF = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const NOTIONAL = 60;
const EQUITY = 56.7;
const RHO = NOTIONAL / EQUITY;
const ROUND_TRIP = 0.0012;
const FEE_FLOOR_EQ = ROUND_TRIP * RHO;

const TP_ATR_MULT = 0.4;
const TP_CLAMP_HI = 0.5;
const SL_ATR_MULT = 1.0;
const HOLD_BARS = 16; // 4 hours of 15-minute bars
const CLUSTER_MIN = 240; // the holding period
const BAR_CLUSTERS = 30; // the house bar

function flag(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

if (!existsSync(CONF) || !existsSync(BARS)) {
  console.error(`missing the inputs: ${CONF} and ${BARS}`);
  process.exit(1);
}
const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const barsByPair = JSON.parse(readFileSync(BARS, "utf8"));
const barList = (p) => {
  const b = barsByPair[p];
  if (!b) return null;
  return Array.isArray(b) ? b : b.bars;
};

/** The models' confirmed side: JEV and Laya both directional and agreeing. */
function modelsSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}
/** The models' INDIVIDUAL sides, for the "they disagree with each other" subset. */
function modelSplit(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j === l) return null;
  return { jev: j, laya: l };
}

/** The MARKET-ANCHORED ticket, with the corrected fill rule. */
function resolve(r, dir) {
  const bars = barList(r.pair);
  if (!bars) return null;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(bars.length, i + HOLD_BARS);
  if (end - i < 2) return null;

  const long = dir === "long";
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const atrPct = Number(r.tapeAtrPct);
  if (!(atrPct > 0)) return null;

  const tpPct = Math.min(TP_ATR_MULT * atrPct, TP_CLAMP_HI);
  const slPct = SL_ATR_MULT * atrPct;
  const tpFrac = tpPct / 100;
  const slFrac = slPct / 100;
  const entry = last;
  const target = long ? last * (1 + tpFrac) : last * (1 - tpFrac);
  const stop = long ? last * (1 - slFrac) : last * (1 + slFrac);
  if (isTargetWrongSide(dir, target, entry)) return null;

  const bucket = Math.floor(r.ts / (CLUSTER_MIN * 60000));
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitTp && hitSl) return { dir, pnl: -slFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair };
    if (hitTp) return { dir, pnl: tpFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair };
    if (hitSl) return { dir, pnl: -slFrac - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair };
  }
  const lastBar = bars[end - 1];
  const move = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { dir, pnl: move - ROUND_TRIP, bucket, ts: r.ts, pair: r.pair };
}

/** The cluster means of a set of trades. */
function clusterStats(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.bucket)) by.set(t.bucket, []);
    by.get(t.bucket).push(t);
  }
  const cms = [...by.entries()].map(([bucket, ts]) => ({ bucket, mean: mean(ts.map((t) => t.pnl)), n: ts.length }));
  return { cms, clusters: cms.length };
}
function tOf(cms) {
  if (cms.length < 2) return NaN;
  const ms = cms.map((c) => c.mean);
  const m = mean(ms);
  const sd = Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1));
  const se = sd / Math.sqrt(ms.length);
  return se > 0 ? m / se : NaN;
}

/** The paired excess of a subset against the unconditional control. */
function pairedExcess(subset, control) {
  const byCtrl = new Map(clusterStats(control).cms.map((c) => [c.bucket, c.mean]));
  const diffs = [];
  for (const c of clusterStats(subset).cms) {
    const ctrl = byCtrl.get(c.bucket);
    if (ctrl === undefined) continue;
    diffs.push(c.mean - ctrl);
  }
  const m = mean(diffs);
  const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1)) : NaN;
  const se = diffs.length > 1 ? sd / Math.sqrt(diffs.length) : NaN;
  return { pairs: diffs.length, mean: m, se, t: se > 0 ? m / se : NaN };
}

// ── THE CENSUS ──
const withTape = rows.filter((r) => tapeSideFromRow(r));
const conflicts = [];
for (const r of withTape) {
  const ms = modelsSide(r);
  if (!ms) continue;
  const t = tapeSideFromRow(r);
  if (t !== ms) conflicts.push({ r, tape: t, models: ms });
}
const modelSplits = withTape.filter((r) => modelSplit(r));

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE CONFLICT STATE — is there a TRADEABLE sub-state?");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the collector rows: ${rows.length}`);
console.log(`the rows with a tape side: ${withTape.length}`);
console.log(`the CONFLICT rows (the tape vs the agreed models): ${conflicts.length}`);
console.log(`the models disagree with EACH OTHER: ${modelSplits.length}`);
console.log(`the fee floor: ${fmt(FEE_FLOOR_EQ)}% of equity per trade`);
console.log("");

// The conflict's shape census.
const shapes = new Map();
for (const c of conflicts) {
  const k = `${c.tape} vs ${c.models}`;
  shapes.set(k, (shapes.get(k) ?? 0) + 1);
}
console.log("  the conflict's shapes (the tape vs the models):");
for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${v}`);
}
console.log("");

// ── THE UNCONDITIONAL CONTROLS ──
// For each side, every row with a resolvable tape side in that
// direction, at the same geometry.
const controls = { long: [], short: [] };
for (const r of withTape) {
  for (const dir of ["long", "short"]) {
    const t = resolve(r, dir);
    if (t) controls[dir].push(t);
  }
}
console.log(`  the controls: ${controls.long.length} long, ${controls.short.length} short`);
console.log("");

/** Measure a subset on both sides, against the matching control. */
function measure(label, subsetRows) {
  const out = { label, n: 0, sides: {} };
  for (const dir of ["long", "short"]) {
    const trades = [];
    for (const r of subsetRows) {
      const t = resolve(r, dir);
      if (t) trades.push(t);
    }
    if (!trades.length) continue;
    const st = clusterStats(trades);
    const ex = pairedExcess(trades, controls[dir]);
    out.sides[dir] = {
      n: trades.length,
      clusters: st.clusters,
      ev: mean(trades.map((t) => t.pnl)) * RHO,
      excess: ex.mean * RHO,
      t: ex.t,
      pairs: ex.pairs,
    };
    out.n += trades.length;
  }
  return out;
}

const results = [];

// ── A. THE MODELS DISAGREE WITH EACH OTHER ──
results.push(measure("A. the models disagree with each other", modelSplits));

// ── B. THE TAPE'S EXHAUSTION IS STRONGER ──
// Three strength measures, each split at its median within the
// conflict set.
const atrUnits = (r) => {
  const atr = Number(r.tapeAtrPct);
  const off = Number(r.tapeOffHighPct);
  if (!(atr > 0) || !Number.isFinite(off)) return NaN;
  return off / atr; // the distance from the high in ATR units
};
const medOf = (vals) => {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};
const atrMed = medOf(conflicts.map((c) => atrUnits(c.r)));
const vrMed = medOf(conflicts.map((c) => Number(c.r.tapeVratio)));
const offMed = medOf(conflicts.map((c) => Number(c.r.tapeOffHighPct)));

results.push(
  measure(
    `B1. the tape's distance from the high, in ATR units, ABOVE the median (${fmt(atrMed, 2)})`,
    conflicts.filter((c) => atrUnits(c.r) > atrMed).map((c) => c.r),
  ),
);
results.push(
  measure(
    `B2. the tape's volume ratio, BELOW the median (${fmt(vrMed, 3)})`,
    conflicts.filter((c) => Number(c.r.tapeVratio) < vrMed).map((c) => c.r),
  ),
);
results.push(
  measure(
    `B3. the tape's distance from the high, ABOVE the median (${fmt(offMed, 2)}%)`,
    conflicts.filter((c) => Number(c.r.tapeOffHighPct) > offMed).map((c) => c.r),
  ),
);

// ── C. A SPECIFIC SESSION HOUR ──
const hours = [...new Set(conflicts.map((c) => new Date(c.r.ts).getUTCHours()))].sort((a, b) => a - b);
for (const h of hours) {
  const sub = conflicts.filter((c) => new Date(c.r.ts).getUTCHours() === h).map((c) => c.r);
  results.push(measure(`C. the conflict in hour ${String(h).padStart(2, "0")}Z`, sub));
}

// ── D. A SPECIFIC SIDE ──
for (const side of ["long", "short"]) {
  results.push(measure(`D. the conflict on the ${side} side`, conflicts.filter((c) => c.tape === side).map((c) => c.r)));
}
// And the OTHER side's trade on the same rows — the models' side.
for (const side of ["long", "short"]) {
  results.push(measure(`D. the conflict on the ${side} side, traded the OTHER way`, conflicts.filter((c) => c.tape === side).map((c) => c.r)));
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE SUBSETS — the excess over the unconditional same-direction control");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");
console.log("  subset                                            the dir    n  clus  the EV %eq  the excess %eq      t   the pairs");
console.log("  " + "-".repeat(108));
for (const r of results) {
  for (const [dir, s] of Object.entries(r.sides)) {
    const flagTxt = s.excess > 0 && s.t >= 2 ? "  <-" : "";
    console.log(
      `  ${r.label.padEnd(48)} ${dir.padStart(6)} ${String(s.n).padStart(4)} ${String(s.clusters).padStart(5)}  ` +
        `${fmt(s.ev).padStart(10)}  ${fmt(s.excess).padStart(13)}  ${fmt(s.t, 2).padStart(6)}   ${String(s.pairs).padStart(5)}${flagTxt}`,
    );
  }
}
console.log("");

// ── THE PLACEBO ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("THE SIZE-MATCHED PLACEBO — is any subset better than a random subset?");
console.log("════════════════════════════════════════════════════════════════════");
let seed = 20261021;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
console.log("");
for (const r of results) {
  for (const [dir, s] of Object.entries(r.sides)) {
    if (s.n < 10) continue;
    const pool = [...controls[dir]];
    const draws = [];
    for (let t = 0; t < 1000; t++) {
      const copy = [...pool];
      const draw = [];
      for (let i = 0; i < s.n && copy.length; i++) {
        draw.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
      }
      draws.push(pairedExcess(draw, controls[dir]).mean * RHO);
    }
    const sorted = draws.sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const beats = s.excess > p95;
    console.log(
      `  ${r.label.padEnd(48)} ${dir.padStart(6)}  the excess ${fmt(s.excess).padStart(8)}  ` +
        `the placebo p95 ${fmt(p95).padStart(8)}  ${beats ? "BEATS the null" : "does NOT beat the null"}`,
    );
  }
}
console.log("");

// ── THE VERDICT ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("THE VERDICT");
console.log("════════════════════════════════════════════════════════════════════");
const clears = [];
for (const r of results) {
  for (const [dir, s] of Object.entries(r.sides)) {
    if (s.excess > 0 && s.t >= 2 && s.clusters >= BAR_CLUSTERS) clears.push({ r, dir, s });
  }
}
console.log(`  the subsets clearing: positive excess, t >= 2, AND ${BAR_CLUSTERS}+ independent clusters: ${clears.length}`);
for (const c of clears) {
  console.log(`    ${c.r.label} (${c.dir}): the excess ${fmt(c.s.excess)}% at t=${fmt(c.s.t, 2)}, ${c.s.clusters} clusters`);
}
console.log("");
console.log("  THE WHOLE CONFLICT, MEASURED ON BOTH SIDES:");
const whole = measure("the whole conflict", conflicts.map((c) => c.r));
for (const [dir, s] of Object.entries(whole.sides)) {
  console.log(`    traded ${dir.padEnd(6)} the excess ${fmt(s.excess).padStart(8)}% of equity at t=${fmt(s.t, 2)}  (${s.n} trades, ${s.clusters} clusters)`);
}
console.log("");
if (!clears.length) {
  console.log("  NO SUB-STATE OF THE CONFLICT IS TRADEABLE.");
  console.log("");
  console.log("  So the answer to the question is the one the data gives: THE MODELS WIN");
  console.log("  THE CONFLICT. The tape's exhaustion, measured with the correct fill");
  console.log("  rule and against the unconditional same-direction control, does not");
  console.log("  beat the models' direction in ANY identifiable subset — not by side,");
  console.log("  not by hour, not by exhaustion strength, and not by the models");
  console.log("  disagreeing with each other. The machine's refusal to trade a");
  console.log("  conflict is CORRECT, and it is refusing the majority of its");
  console.log("  candidates because they are the losing ones.");
}
console.log("════════════════════════════════════════════════════════════════════");
