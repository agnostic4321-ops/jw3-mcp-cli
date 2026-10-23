#!/usr/bin/env node
/**
 * THE RANDOM SYMBOL-SUBSAMPLE TEST — is the deep sample's excess a
 * property of the CONFIRMATION LAYER, or of the particular symbols?
 *
 * The earlier stride-based subsample was not nested and was therefore
 * uninterpretable. This one draws RANDOM symbol subsets (with a fixed
 * seed, so it is reproducible) and asks the right question:
 *
 *   If the effect is a property of the CONFIRMATION LAYER, it should
 *   appear in every random subset of the symbols, with an excess that
 *   does not shrink with the subset's size.
 *
 *   If it is a property of a FEW symbols, the excess will be unstable
 *   across subsets and will not be present in all of them.
 *
 * The comparison is made at a FIXED number of rounds so the subsets are
 * comparable — no: the excess is compared at a FIXED number of symbols,
 * and the rounds come out of that. Both are reported.
 *
 * READ-ONLY. No venue calls, no account calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mean, se, simulate, pairedExcess } from "./core.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

const fmt = (x, d = 5) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const int = (n) => Number(n).toLocaleString("en-US");

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
const rowKey = (r) => `${r.pair}|${r.ts}`;
const roundIdx = new Map();
rows.forEach((r) => { roundIdx.set(rowKey(r), Math.floor(r.ts / 300_000)); });

const tapeArm = [], confArm = [];
for (const r of rows) {
  if (!r.tapeSide) continue;
  const rec = { ...r, dir: r.tapeSide };
  tapeArm.push(rec);
  if (r.layaSide && r.layaSide === r.tapeSide) confArm.push(rec);
}
const S = { tape: simulate(tapeArm, bars, roundIdx, rowKey), conf: simulate(confArm, bars, roundIdx, rowKey) };

const allPairs = [...new Set(S.conf.trades.map((t) => t.pair))].sort();
console.log("=".repeat(112));
console.log("THE RANDOM SYMBOL-SUBSAMPLE TEST");
console.log("=".repeat(112));
console.log(`\n  ${allPairs.length} symbols carry confirmed trades.`);

const RES = {};
for (const k of [1, 2, 4, 8, 19, 38]) {
  const DRAWS = 40;
  const rnd = mulberry32(4242 + k);
  const excesses = [], ts = [], roundsList = [];
  for (let d = 0; d < DRAWS; d++) {
    // a random subset of k symbols
    const idx = allPairs.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const keep = new Set(idx.slice(0, k).map((i) => allPairs[i]));
    const sig = S.conf.trades.filter((t) => keep.has(t.pair));
    const ctl = S.tape.trades.filter((t) => keep.has(t.pair));
    const e = pairedExcess(sig, ctl);
    excesses.push(e.excess); ts.push(e.t); roundsList.push(e.rounds);
  }
  const m = mean(excesses), s = se(excesses);
  const pos = excesses.filter((x) => x > 0).length;
  const sigPos = excesses.filter((_, i) => ts[i] >= 2).length;
  const sigNeg = excesses.filter((_, i) => ts[i] <= -2).length;
  RES[k] = { mean: m, sd: s, pos, sigPos, sigNeg, n: DRAWS, rounds: mean(roundsList) };
  console.log(`\n  ${k} symbols (${DRAWS} random subsets):`);
  console.log(`    excess: mean ${fmt(m)}%  sd ${fmt(s)}%  |  positive in ${pos}/${DRAWS}  | t>=2 in ${sigPos}/${DRAWS}  | t<=-2 in ${sigNeg}/${DRAWS}`);
  console.log(`    mean rounds per subset ${int(mean(roundsList))}`);
  if (k === 38) {
    // with the whole universe there is only ONE subset, so measure it exactly
    const e = pairedExcess(S.conf.trades, S.tape.trades);
    console.log(`    (the full universe is ONE subset, not ${DRAWS}: excess ${fmt(e.excess)}% se ${fmt(e.se)} t ${fmt(e.t, 2)} over ${int(e.rounds)} rounds)`);
    RES[38] = { mean: e.excess, sd: 0, pos: 1, sigPos: e.t >= 2 ? 1 : 0, sigNeg: e.t <= -2 ? 1 : 0, n: 1, rounds: e.rounds, exact: true };
  }
}

// ── the SIGN TEST on the random subsets: is the excess present in most
//    random subsets, or only in some? ──
console.log(`\n  ── THE READING ──`);
for (const k of [1, 2, 4, 8, 19]) {
  const r = RES[k];
  console.log(`  ${String(k).padStart(2)} symbols: positive in ${r.pos}/${r.n} random subsets (${(r.pos / r.n * 100).toFixed(0)}%), t>=2 in ${r.sigPos}/${r.n}`);
}
console.log(`
  A property of the CONFIRMATION LAYER would appear in EVERY subset.
  A property of a FEW SYMBOLS appears only in the subsets that happen to
  contain them.`);

writeFileSync(join(OUT, "symbol-subsample.json"), JSON.stringify(RES, null, 2));
console.log(`\n  wrote ${join(OUT, "symbol-subsample.json")}`);
