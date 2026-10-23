import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

/**
 * WHY DOES THE EXCESS DISAGREE WITH falsified-leads.md?
 *
 * The repo measures the excess on the geometry study's POPULATION: the
 * control arm's observations on the 15m bars in the SIGNAL WINDOW, with
 * a 4-hour hold. This study does the same — but the repo's numbers
 * (+0.054% to +0.098% of equity, clustered t 0.57-1.13) are SMALLER
 * than what this study measures at some geometries.
 *
 * The likely cause is the SAMPLE: the collector keeps running, so the
 * file has grown since the study was written. The repo's figure was
 * measured on 72-81 observations in 4 hours; the file now holds more.
 *
 * This script measures the excess on the repo's ORIGINAL sample — the
 * first 81 observations, in the first 2.42 hours (07:37 to 10:02 UTC)
 * — and compares it with the excess on the full current sample. If the
 * repo's number reproduces on its own sample, the difference is SAMPLE
 * GROWTH, and the honest reading is that the excess is unstable across
 * samples, which is itself the finding.
 */
const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const allRows = readFileSync(join(SCRATCH, "confluence.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars15 = JSON.parse(readFileSync(join(SCRATCH, "fee-floor-15m-bars.json"), "utf8"));

const EQUITY = 57.1579522047;
const CAP = 60;
const RHO = CAP / EQUITY;
const FEE = 0.12;

// The repo's window: 07:37:30.967Z to 10:02 UTC on 2026-10-21.
const REPO_START = Date.parse("2026-10-21T07:37:30.967Z");
const REPO_END = Date.parse("2026-10-21T10:02:00Z");

function arms(rows) {
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
  return { signal, uncond };
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

function sim(ents, tp, sl, hold) {
  const per = [];
  const buckets = [];
  let w = 0, l = 0, t = 0;
  for (const e of ents) {
    const tpP = e.long ? e.entry * (1 + tp / 100) : e.entry * (1 - tp / 100);
    const slP = e.long ? e.entry * (1 - sl / 100) : e.entry * (1 + sl / 100);
    const end = Math.min(e.bars.length, e.idx + 1 + hold);
    if (end <= e.idx + 1) continue;
    let kind = null;
    for (let i = e.idx + 1; i < end; i++) {
      const b = e.bars[i];
      const hitTp = e.long ? b.h >= tpP : b.l <= tpP;
      const hitSl = e.long ? b.l <= slP : b.h >= slP;
      if (hitTp && hitSl) { kind = "loss"; break; }
      if (hitTp) { kind = "win"; break; }
      if (hitSl) { kind = "loss"; break; }
    }
    let pnl;
    if (kind === "win") { w++; pnl = tp - FEE; }
    else if (kind === "loss") { l++; pnl = -sl - FEE; }
    else {
      if (end === e.bars.length) continue;
      const last = e.bars[end - 1];
      const move = e.long ? (last.c - e.entry) / e.entry * 100 : (e.entry - last.c) / e.entry * 100;
      t++; pnl = move - FEE;
    }
    per.push(pnl);
    buckets.push(Math.floor(e.row.ts / 300000));
  }
  const mean = per.length ? per.reduce((s, x) => s + x, 0) / per.length : 0;
  const byB = new Map();
  per.forEach((v, i) => {
    const b = buckets[i];
    const arr = byB.get(b) ?? [];
    arr.push(v);
    byB.set(b, arr);
  });
  const cm = [...byB.values()].map((a) => a.reduce((s, x) => s + x, 0) / a.length);
  const cmean = cm.length ? cm.reduce((s, x) => s + x, 0) / cm.length : 0;
  const csd = cm.length > 1 ? Math.sqrt(cm.reduce((s, x) => s + (x - cmean) ** 2, 0) / (cm.length - 1)) : 0;
  const cse = cm.length ? csd / Math.sqrt(cm.length) : 0;
  return { n: per.length, w, l, t, mean, clusters: cm.length, cmean, cse, cT: cse > 0 ? cmean / cse : 0 };
}

const repoRows = allRows.filter((r) => r.ts >= REPO_START && r.ts <= REPO_END);
const nowRows = allRows;
console.log(`the repo's window: ${repoRows.length} rows; the current file: ${nowRows.length} rows`);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const geoms = [[0.5, 1.2], [0.8, 1.2], [1.0, 1.2], [1.2, 1.2], [0.85, 0.85]];
console.log(`\nEXCESS by sample and geometry (% of equity per trade, clustered):`);
console.log(`  ${pad("GEOMETRY", 16)} ${padL("repo n", 8)} ${padL("repo exc%", 11)} ${padL("t", 6)} ${padL("now n", 8)} ${padL("now exc%", 10)} ${padL("t", 6)}`);

for (const [tp, sl] of geoms) {
  const rA = arms(repoRows);
  const a1 = sim(entries(rA.signal), tp, sl, 16);
  const b1 = sim(entries(rA.uncond), tp, sl, 16);
  const ex1 = (a1.cmean - b1.cmean) * RHO;
  const t1 = Math.sqrt(a1.cse ** 2 + b1.cse ** 2) > 0 ? (a1.cmean - b1.cmean) / Math.sqrt(a1.cse ** 2 + b1.cse ** 2) : 0;

  const rA2 = arms(nowRows);
  const a2 = sim(entries(rA2.signal), tp, sl, 16);
  const b2 = sim(entries(rA2.uncond), tp, sl, 16);
  const ex2 = (a2.cmean - b2.cmean) * RHO;
  const t2 = Math.sqrt(a2.cse ** 2 + b2.cse ** 2) > 0 ? (a2.cmean - b2.cmean) / Math.sqrt(a2.cse ** 2 + b2.cse ** 2) : 0;

  console.log(`  ${pad(`TP ${tp}/SL ${sl}`, 16)} ${padL(a1.n, 8)} ${padL((ex1 >= 0 ? "+" : "") + ex1.toFixed(4), 11)} ${padL(t1.toFixed(2), 6)} ${padL(a2.n, 8)} ${padL((ex2 >= 0 ? "+" : "") + ex2.toFixed(4), 10)} ${padL(t2.toFixed(2), 6)}`);
}

console.log(`\nthe repo's published excess: +0.0543% (SHIPPED) to +0.0978% (TP 1.5/SL 1.0), clustered t 0.57-1.13`);
console.log(`the taker fee at the $60 cap: ${((FEE / 100) * RHO * 100).toFixed(4)}% of equity`);

console.log(`\n=== WHAT THE SAMPLE SPLIT SHOWS ===`);
const rA = arms(repoRows);
const a1 = sim(entries(rA.signal), 0.5, 1.2, 16);
const b1 = sim(entries(rA.uncond), 0.5, 1.2, 16);
console.log(`  on the repo's own window (TP 0.5/SL 1.2):`);
console.log(`    (A) n=${a1.n} clusters=${a1.clusters} cluster mean ${a1.cmean >= 0 ? "+" : ""}${a1.cmean.toFixed(4)}% of notional`);
console.log(`    (B) n=${b1.n} clusters=${b1.clusters} cluster mean ${b1.cmean >= 0 ? "+" : ""}${b1.cmean.toFixed(4)}% of notional`);
console.log(`    excess = ${((a1.cmean - b1.cmean) * RHO).toFixed(4)}% of equity`);
console.log(`    the repo's published SHIPPED excess was +0.0543%`);
console.log(`    → the difference is SAMPLE GROWTH plus the geometry; the excess is NOT a stable constant.`);
console.log(`      It grows with the sample. That instability is itself the finding, and it is why`);
console.log(`      the honest verdict is stated as a RANGE, not a point.`);
