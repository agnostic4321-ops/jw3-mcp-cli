#!/usr/bin/env node
/**
 * THE RANDOMIZATION TEST'S OWN POSITIVE CONTROL.
 *
 * A test that always says "not significant" is worthless. So the
 * randomization test is run on a SYNTHETIC signal that is KNOWN to
 * carry information, and it must find it.
 *
 * THREE SYNTHETIC SIGNALS, on the real Binance data:
 *
 *   A. A GENUINE EDGE — a signal that is deliberately chosen to be
 *      profitable (the rows whose forward 4-hour move was positive, in
 *      hindsight). The test MUST reject the null for this.
 *
 *   B. A RANDOM SELECTION — a signal built by picking rows at random.
 *      The test MUST NOT reject the null for this.
 *
 *   C. A REGIME-ONLY SIGNAL — a signal that selects rows purely by the
 *      market's own 24-hour move (the same shape as the real tape
 *      signal). The test MUST NOT reject the null for this, because
 *      such a signal carries no information beyond the market.
 *
 * If A is rejected and B and C are not, the test is calibrated: it can
 * detect a real edge, and it does not mistake the market's drift for
 * one.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { measure } from "./rep-measure.mjs";
import { mean } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;
const DRAWS = 300;

const raw = readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8");
const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(join(SCRATCH, "rep-binance-15m-bars.json"), "utf8"));
const TAKER_RT = 0.10;
const { B, C } = buildArms(rows, { book: false, jev: false });

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The forward 4-hour move of a row, in %. */
function fwdMove(r) {
  const bb = bars[r.pair];
  if (!bb) return null;
  let idx = -1;
  for (let i = 0; i < bb.length; i++) { if (bb[i].t <= r.ts) idx = i; else break; }
  if (idx < 0) return null;
  const entry = bb[idx].c;
  const last = bb[Math.min(bb.length - 1, idx + 16)];
  if (!last) return null;
  return ((last.c - entry) / entry) * 100;
}

/** The randomization test, on an arbitrary signal subset. */
function randomizeTest(signal, uncond, g, seed) {
  const pnlOf = (set) => {
    const m = measure(set, set, g, bars, { takerRt: TAKER_RT });
    const pnl = [];
    for (const r of m.signalRows) {
      pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - TAKER_RT * NOE
        : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - TAKER_RT * NOE
        : r.pnl);
    }
    return pnl;
  };
  const sP = pnlOf(signal);
  const uP = pnlOf(uncond);
  if (!sP.length || !uP.length) return null;
  const rand = mulberry32(seed);
  // The NULL HYPOTHESIS: the signal is a random subset of the
  // unconditional arm. Under it, the signal's MEAN is distributed like
  // the mean of a random draw of the same size.
  //
  // So the test statistic is the signal's mean, and the null
  // distribution is the distribution of the random draws' means. (An
  // earlier version compared the signal's mean to ONE random draw's
  // mean and used that as the observed value — which is a random
  // quantity, so the test had no power. The positive control caught it:
  // a signal with a KNOWN edge came out "not significant".)
  const drawMeans = [];
  for (let d = 0; d < DRAWS; d++) {
    const idx = new Array(uP.length);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const take = idx.slice(0, sP.length);
    drawMeans.push(mean(take.map((i) => uP[i])));
  }
  const obs = mean(sP);
  const nullMean = mean(drawMeans);
  const sd = Math.sqrt(mean(drawMeans.map((x) => (x - nullMean) ** 2)));
  const p = (drawMeans.filter((x) => x >= obs).length + 1) / (drawMeans.length + 1);
  return { obs, nullMean, z: sd > 0 ? (obs - nullMean) / sd : 0, p };
}

const g = { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 };
const n = B.length;

// A. A GENUINE EDGE: the rows whose forward move was positive.
const withFwd = C.map((r) => ({ r, m: fwdMove(r) })).filter((x) => x.m != null);
withFwd.sort((a, b) => b.m - a.m);
const genuine = withFwd.slice(0, n).map((x) => x.r);

// B. A RANDOM SELECTION.
const rand = mulberry32(0xBEEF);
const shuffled = [...C];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const randomSel = shuffled.slice(0, n);

// C. A REGIME-ONLY SIGNAL: the rows with the most negative 24-hour
// move (the market's drift, selected on nothing else).
const byDrift = [...C].sort((a, b) => a.tapeChg - b.tapeChg);
const regimeOnly = byDrift.slice(0, n);

console.log(`[positive-control] the real tape signal: ${B.length} rows of ${C.length}`);
console.log(`[positive-control] the synthetic A (a genuine edge):   ${genuine.length} rows`);
console.log(`[positive-control] the synthetic B (a random pick):     ${randomSel.length} rows`);
console.log(`[positive-control] the synthetic C (regime only):        ${regimeOnly.length} rows\n`);

for (const [label, sig] of [
  ["A  a GENUINE EDGE (must be REJECTED -> p < 0.05)", genuine],
  ["B  a RANDOM PICK (must NOT be rejected)", randomSel],
  ["C  REGIME ONLY (must NOT be rejected)", regimeOnly],
  ["the REAL tape signal", B],
]) {
  const r = randomizeTest(sig, C, g, 0x1234 ^ sig.length);
  if (!r) { console.log(`  ${label}: no data`); continue; }
  const verdict = r.p < 0.05 ? "SIGNIFICANT" : r.p < 0.2 ? "marginal" : "not significant";
  console.log(`  ${label.padEnd(50)} obs=${(r.obs >= 0 ? "+" : "") + r.obs.toFixed(4)}%  null=${(r.nullMean >= 0 ? "+" : "") + r.nullMean.toFixed(4)}%  z=${r.z.toFixed(2)}  p=${r.p.toFixed(3)}  ${verdict}`);
}
