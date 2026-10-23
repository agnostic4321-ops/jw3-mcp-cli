#!/usr/bin/env node
/**
 * THE REGIME QUESTION — the long side, and the window structure.
 *
 * ══ TWO THINGS THIS ANSWERS ══
 *
 * 1. THE LONG SIDE. The arm is 92.9% short, because the tape's rule
 *    checks the FADE before the DIP: whenever the market is near its
 *    high AND near its low, the fade fires and the dip never gets a
 *    look. So a long signal requires a market that is near its low and
 *    NOT near its high — a specific REGIME. If the candidate needs a
 *    downtrend for a long side to exist at all, then the stopping rule
 *    has to be conditional on that regime being present, and this
 *    measures how often it is.
 *
 * 2. THE REGIME-WINDOWED EXCESS. If the excess only exists in one
 *    regime, then it is not an edge, it is a regime. So the excess is
 *    measured inside each regime separately.
 *
 * READ-ONLY. No venue calls, no account calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mean, se, tPval, simulate, armStats, pairedExcess } from "./core.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

const fmt = (x, d = 4) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const int = (n) => Number(n).toLocaleString("en-US");

/**
 * The tape's regime, exactly as `regimeOf` in the shared module:
 *   down  the market is near its low and not near its high
 *   up    the market is near its high and not near its low
 *   flat  neither
 */
function regimeOf(offHighPct, offLowPct) {
  const oh = Number(offHighPct ?? 0);
  const ol = Number(offLowPct ?? 0);
  if (ol < 8 && oh >= 8) return "down";
  if (oh < 8 && ol >= 8) return "up";
  return "flat";
}

const deep = JSON.parse(readFileSync(join(OUT, "deep-observations.json"), "utf8"));
const bars = JSON.parse(readFileSync(join(OUT, "binance-90d-15m.json"), "utf8"));
const rows = deep.rows;
const rowKey = (r) => `${r.pair}|${r.ts}`;
const roundIdx = new Map();
rows.forEach((r) => { roundIdx.set(rowKey(r), Math.floor(r.ts / 300_000)); });

console.log("=".repeat(112));
console.log("THE REGIME QUESTION — the long side, and the regime-windowed excess");
console.log("=".repeat(112));

// ══ 1. HOW OFTEN DOES A LONG SIGNAL EXIST? ══
const all = rows;
const regCount = { down: 0, up: 0, flat: 0 };
for (const r of all) regCount[regimeOf(r.tapeOffHighPct, r.tapeOffLowPct)]++;
const N = all.length;
console.log(`\n  ── 1. THE REGIME MIX over all ${int(N)} observations ──`);
console.log(`     down (near its low, not near its high): ${int(regCount.down)} (${(regCount.down / N * 100).toFixed(2)}%)`);
console.log(`     up   (near its high, not near its low): ${int(regCount.up)} (${(regCount.up / N * 100).toFixed(2)}%)`);
console.log(`     flat (neither):                        ${int(regCount.flat)} (${(regCount.flat / N * 100).toFixed(2)}%)`);

const tapeRows = rows.filter((r) => r.tapeSide);
const tapeLong = tapeRows.filter((r) => r.tapeSide === "long");
const tapeShort = tapeRows.filter((r) => r.tapeSide === "short");
console.log(`\n     the tape's signals: ${int(tapeRows.length)} total | ${int(tapeShort.length)} short | ${int(tapeLong.length)} long`);
console.log(`     the long side is ${(tapeLong.length / tapeRows.length * 100).toFixed(2)}% of the tape's signals`);

// per DAY: how often does a long signal exist at all?
const daysWithLong = new Set();
const days = new Set();
for (const r of tapeRows) {
  const d = Math.floor(r.ts / 86400000);
  days.add(d);
  if (r.tapeSide === "long") daysWithLong.add(d);
}
console.log(`\n     days with AT LEAST ONE long tape signal: ${daysWithLong.size} of ${days.size} (${(daysWithLong.size / days.size * 100).toFixed(1)}%)`);
// and the long side's DAILY COUNT
const longPerDay = new Map();
for (const r of tapeLong) {
  const d = Math.floor(r.ts / 86400000);
  longPerDay.set(d, (longPerDay.get(d) ?? 0) + 1);
}
const counts = [...longPerDay.values()].sort((a, b) => a - b);
console.log(`     long signals per day: median ${counts[Math.floor(counts.length / 2)]} | p10 ${counts[Math.floor(counts.length * 0.1)]} | p90 ${counts[Math.floor(counts.length * 0.9)]} | max ${counts[counts.length - 1]}`);

// ══ 2. THE EXCESS INSIDE EACH REGIME ══
console.log(`\n  ── 2. THE CONFIRMATION LAYER'S EXCESS, BY REGIME ──`);

const tapeArm = [], confArm = [];
for (const r of rows) {
  if (!r.tapeSide) continue;
  const rec = { ...r, dir: r.tapeSide, regime: regimeOf(r.tapeOffHighPct, r.tapeOffLowPct) };
  tapeArm.push(rec);
  if (r.layaSide && r.layaSide === r.tapeSide) confArm.push(rec);
}
const S = {
  tape: simulate(tapeArm, bars, roundIdx, rowKey),
  conf: simulate(confArm, bars, roundIdx, rowKey),
};
// the regime of each trade, looked up once (not per comparison)
const regOfTrade = new Map();
for (const r of tapeArm) {
  regOfTrade.set(`${r.pair}|${r.ts}`, r.regime);
}
console.log(`\n  ${"regime".padEnd(10)}${"sigN".padStart(10)}${"ctlN".padStart(10)}${"rounds".padStart(9)}${"excess %eq".padStart(13)}${"se".padStart(10)}${"t".padStart(8)}${"p".padStart(10)}`);
const byRegime = {};
for (const reg of ["down", "up", "flat"]) {
  const sig = S.conf.trades.filter((t) => regOfTrade.get(`${t.pair}|${t.ts}`) === reg);
  const ctl = S.tape.trades.filter((t) => regOfTrade.get(`${t.pair}|${t.ts}`) === reg);
  const e = pairedExcess(sig, ctl);
  byRegime[reg] = { n: sig.length, rounds: e.rounds, excess: e.excess, t: e.t, p: e.p };
  console.log(`  ${pad(reg, 10)}${rpad(int(sig.length), 10)}${rpad(int(ctl.length), 10)}${rpad(int(e.rounds), 9)}${rpad(fmt(e.excess, 5), 13)}${rpad(fmt(e.se, 5), 10)}${rpad(fmt(e.t, 2), 8)}${rpad(e.p.toFixed(4), 10)}`);
}

// ══ 3. THE LONG SIDE, MEASURED ══
console.log(`\n  ── 3. THE LONG SIDE, MEASURED ON ITS OWN ──`);
for (const side of ["long", "short"]) {
  const sig = S.conf.trades.filter((t) => t.dir === side);
  const ctl = S.tape.trades.filter((t) => t.dir === side);
  const e = pairedExcess(sig, ctl);
  const sigEV = sig.length ? mean(sig.map((t) => t.pnl)) : 0;
  const ctlEV = ctl.length ? mean(ctl.map((t) => t.pnl)) : 0;
  console.log(`\n  the ${side.toUpperCase()} side:`);
  console.log(`    confirmed ${int(sig.length)} trades | tape-only ${int(ctl.length)} trades`);
  console.log(`    confirmed EV ${fmt(sigEV)}% | tape-only EV ${fmt(ctlEV)}% | excess ${fmt(e.excess)}% se ${fmt(e.se)} t ${fmt(e.t, 2)} over ${int(e.rounds)} rounds`);
  console.log(`    => ${e.rounds === 0 ? "NO PAIRED ROUNDS — the side cannot be judged" : (Math.abs(e.t) >= 2 ? "judged: significant" : "judged: a PATTERN, not a finding")}`);
}

// ══ 4. THE WINDOW STRUCTURE: how long does a regime last? ══
console.log(`\n  ── 4. THE REGIME'S PERSISTENCE — how long does a downtrend last? ──`);
// the longest run of consecutive ROUNDS in the 'down' regime, per symbol
const regByRoundSym = new Map();
for (const r of tapeArm) {
  const k = `${r.pair}|${Math.floor(r.ts / 300000)}`;
  regByRoundSym.set(k, regimeOf(r.tapeOffHighPct, r.tapeOffLowPct));
}
const byPair = new Map();
for (const [k, reg] of regByRoundSym) {
  const p = k.split("|")[0];
  const rd = Number(k.split("|")[1]);
  const a = byPair.get(p) ?? [];
  a.push([rd, reg]);
  byPair.set(p, a);
}
let longestDown = 0, runs = [];
for (const [, arr] of byPair) {
  arr.sort((a, b) => a[0] - b[0]);
  let run = 0;
  for (const [, reg] of arr) {
    if (reg === "down") { run++; longestDown = Math.max(longestDown, run); }
    else { if (run) runs.push(run); run = 0; }
  }
  if (run) runs.push(run);
}
runs.sort((a, b) => a - b);
console.log(`    the longest 'down' regime run: ${longestDown} rounds = ${(longestDown * 5 / 60).toFixed(1)} hours`);
console.log(`    the median 'down' run: ${runs[Math.floor(runs.length / 2)]} rounds = ${(runs[Math.floor(runs.length / 2)] * 5 / 60).toFixed(1)} hours`);
console.log(`    the number of 'down' runs: ${runs.length} across ${byPair.size} symbols`);

writeFileSync(join(OUT, "regime.json"), JSON.stringify({
  regimeCounts: regCount, nObservations: N,
  tapeSignals: tapeRows.length, tapeLong: tapeLong.length, tapeShort: tapeShort.length,
  daysWithLong: daysWithLong.size, days: days.size,
  longPerDayMedian: counts[Math.floor(counts.length / 2)],
  byRegime, longestDownRounds: longestDown, medianDownRun: runs[Math.floor(runs.length / 2)],
}, null, 2));
console.log(`\n  wrote ${join(OUT, "regime.json")}`);
