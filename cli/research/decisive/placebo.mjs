#!/usr/bin/env node
/**
 * THE RANDOMIZATION PLACEBO — does the confirmation layer's SELECTION
 * carry information beyond its COUNT?
 *
 * ══ WHY THIS IS THE DECISIVE TEST ══
 *
 * On the deep sample the confirmation layer is the Laya bridge WITHOUT
 * the book leg and WITHOUT the JEV leg. Its decision is then a monotone
 * function of the tape's own state:
 *
 *     score = sign(chg) x min(|chg| / max(2 x ATR, 0.5), 1) x 0.6
 *     short if score <= -0.35
 *
 * so "Laya confirms a fade-short" means "the tape's fade-short signal
 * had a LARGE |chg| relative to ATR". That is a statement about the
 * STRENGTH OF THE EXHAUSTION, not about any model's opinion.
 *
 * So a positive excess for that arm is not yet evidence that a
 * CONFIRMATION LAYER works. It could be the much weaker claim that
 * "the most extreme exhaustion signals are the better ones" — which is
 * a momentum/volatility effect with no model in it at all.
 *
 * ══ THE PLACEBO ══
 *
 * The honest null: the confirmation layer adds nothing beyond choosing
 * WHICH SIGNALS to take, and the choice is arbitrary. So build the
 * placebo by RANDOMLY choosing, within each round, the same NUMBER of
 * tape signals that the confirmation layer chose — from the same tape
 * signals in that round — and repeat. The observed excess's position in
 * that null distribution is the answer.
 *
 * The placebo is run on the ROUND-level paired differences, so the
 * market's drift cancels exactly as it does in the real measurement.
 *
 * READ-ONLY. No venue calls, no account calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mean, se, sd, tPval, simulate, armStats, pairedExcess, roundMeans } from "./core.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

const fmt = (x, d = 4) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const rpad = (s, n) => String(s).padStart(n);
const int = (n) => Number(n).toLocaleString("en-US");

// a deterministic PRNG so the result is reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deep = JSON.parse(readFileSync(join(OUT, "deep-observations.json"), "utf8"));
const bars = JSON.parse(readFileSync(join(OUT, "binance-90d-15m.json"), "utf8"));
const rows = deep.rows;

console.log("=".repeat(118));
console.log("THE RANDOMIZATION PLACEBO — is the confirmation layer's SELECTION better than a random pick of the same size?");
console.log("=".repeat(118));

// ── build the arms on the deep sample ──
const rowKey = (r) => `${r.pair}|${r.ts}`;
const roundOf = (r) => Math.floor(r.ts / 300_000);
const roundIdx = new Map();
rows.forEach((r) => { roundIdx.set(rowKey(r), roundOf(r)); });

const tapeArm = [], confArm = [];
for (const r of rows) {
  if (!r.tapeSide) continue;
  tapeArm.push({ ...r, dir: r.tapeSide });
  if (r.layaSide && r.layaSide === r.tapeSide) confArm.push({ ...r, dir: r.layaSide });
}
console.log(`\n  tape signals ${int(tapeArm.length)} | confirmed ${int(confArm.length)}`);

const S = {
  tape: simulate(tapeArm, bars, roundIdx, rowKey),
  conf: simulate(confArm, bars, roundIdx, rowKey),
};
const A = { tape: armStats(S.tape), conf: armStats(S.conf) };
console.log(`\n  ${"arm".padEnd(14)}${"n".padStart(10)}${"rounds".padStart(10)}${"EV %eq".padStart(12)}${"EV se".padStart(11)}`);
console.log(`  ${"TAPE-ONLY".padEnd(14)}${rpad(int(A.tape.n), 10)}${rpad(int(A.tape.rounds), 10)}${rpad(fmt(A.tape.ev), 12)}${rpad(fmt(A.tape.evSe), 11)}`);
console.log(`  ${"CONFIRMED".padEnd(14)}${rpad(int(A.conf.n), 10)}${rpad(int(A.conf.rounds), 10)}${rpad(fmt(A.conf.ev), 12)}${rpad(fmt(A.conf.evSe), 11)}`);

const obs = pairedExcess(S.conf.trades, S.tape.trades);
console.log(`\n  OBSERVED paired-by-round excess: ${fmt(obs.excess)}%  se ${fmt(obs.se)}  t ${fmt(obs.t, 2)}  over ${int(obs.rounds)} rounds`);

// ── the placebo: within each round, pick the SAME NUMBER of tape trades
//    at random, and recompute the paired-by-round excess ──
// The trade objects carry the pnl, so a placebo arm is a SUBSET of the
// tape arm's trades. We build it per round.
const tapeByRound = new Map();
for (const t of S.tape.trades) {
  const a = tapeByRound.get(t.round) ?? [];
  a.push(t);
  tapeByRound.set(t.round, a);
}
const confCountByRound = new Map();
for (const t of S.conf.trades) {
  confCountByRound.set(t.round, (confCountByRound.get(t.round) ?? 0) + 1);
}
// the tape arm's trades in rounds the confirmation layer also traded
const pairedRounds = [...confCountByRound.keys()].filter((r) => tapeByRound.has(r)).sort((a, b) => a - b);
console.log(`  ${int(pairedRounds.length)} rounds have both arms trading`);

const DRAWS = 2000;
const rnd = mulberry32(20261021);
const placeboExcess = [];
for (let d = 0; d < DRAWS; d++) {
  // for each round, the placebo picks min(count, available) tape trades
  const diffs = [];
  for (const r of pairedRounds) {
    const pool = tapeByRound.get(r);
    const k = Math.min(confCountByRound.get(r), pool.length);
    // pick k at random WITHOUT replacement
    const idx = pool.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const sel = idx.slice(0, k);
    const placeMean = sel.reduce((s, i) => s + pool[i].pnl, 0) / k;
    // the CONTROL side: the tape arm's mean over the SAME round's OTHER
    // trades (the ones the placebo did not pick). This is exactly the
    // disjoint structure of the real measurement.
    const rest = idx.slice(k).map((i) => pool[i].pnl);
    if (!rest.length) continue;
    const restMean = rest.reduce((s, x) => s + x, 0) / rest.length;
    diffs.push(placeMean - restMean);
  }
  placeboExcess.push(mean(diffs));
}
placeboExcess.sort((a, b) => a - b);
const p2 = (v) => placeboExcess.filter((x) => x <= v).length / DRAWS;
const pct = (v) => placeboExcess.filter((x) => x <= v).length / DRAWS;
console.log(`\n  PLACEBO (${DRAWS} random within-round picks of the same size):`);
console.log(`    mean   ${fmt(mean(placeboExcess))}%`);
console.log(`    sd     ${fmt(sd(placeboExcess))}%`);
console.log(`    p05    ${fmt(placeboExcess[Math.floor(0.05 * DRAWS)])}%`);
console.log(`    p50    ${fmt(placeboExcess[Math.floor(0.50 * DRAWS)])}%`);
console.log(`    p95    ${fmt(placeboExcess[Math.floor(0.95 * DRAWS)])}%`);
console.log(`    max    ${fmt(placeboExcess[DRAWS - 1])}%`);
const rank = placeboExcess.filter((x) => x <= obs.excess).length / DRAWS;
console.log(`\n    OBSERVED excess ${fmt(obs.excess)}%  ->  placebo percentile ${(rank * 100).toFixed(1)}%  (p = ${(1 - rank).toFixed(4)})`);
console.log(`    VERDICT: ${rank > 0.95 ? "the selection is BETTER than a random pick of the same size" : "the selection is NOT distinguishable from a random pick of the same size"}`);

// ── THE DRIFT CONTROL: always-short on the same rounds ──
// (the deep sample's tape is 92.9% short, so drift is a live rival)
const shortOnly = tapeArm.filter((r) => r.dir === "short");
const Sshort = simulate(shortOnly, bars, roundIdx, rowKey);
const drift = pairedExcess(S.conf.trades, Sshort.trades);
console.log(`\n  THE DRIFT CONTROL (always-short on the same rounds):`);
console.log(`    the tape's short share: ${(shortOnly.length / tapeArm.length * 100).toFixed(1)}%`);
console.log(`    excess of CONFIRMED over ALWAYS-SHORT: ${fmt(drift.excess)}%  se ${fmt(drift.se)}  t ${fmt(drift.t, 2)}  over ${int(drift.rounds)} rounds`);
console.log(`    => ${Math.abs(drift.t) >= 2 ? "the excess survives the drift control" : "the excess does NOT survive the drift control"}`);

writeFileSync(join(OUT, "placebo.json"), JSON.stringify({
  observed: { excess: obs.excess, se: obs.se, t: obs.t, rounds: obs.rounds },
  placebo: {
    draws: DRAWS, mean: mean(placeboExcess), sd: sd(placeboExcess),
    p05: placeboExcess[Math.floor(0.05 * DRAWS)],
    p50: placeboExcess[Math.floor(0.50 * DRAWS)],
    p95: placeboExcess[Math.floor(0.95 * DRAWS)],
    max: placeboExcess[DRAWS - 1],
    percentile: rank, p: 1 - rank,
  },
  drift: { excess: drift.excess, se: drift.se, t: drift.t, rounds: drift.rounds },
}, null, 2));
console.log(`\n  wrote ${join(OUT, "placebo.json")}`);
