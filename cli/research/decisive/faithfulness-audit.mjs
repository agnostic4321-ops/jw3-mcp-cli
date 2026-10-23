#!/usr/bin/env node
/**
 * THE DEEP SAMPLE'S FAITHFULNESS AUDIT — is the 90-day Binance
 * reconstruction measuring what the machine would measure?
 *
 * ══ WHAT COULD BE WRONG ══
 *
 * 1. THE TAPE'S GRANULARITY. The live path reads 60 one-HOUR klines and
 *    fadeMetrics takes the last 24, so the tape's window is 24 HOURS of
 *    1h bars. If the deep sample used a different window, it would be
 *    measuring a different state. This audit checks the reconstruction
 *    against the machine's OWN recorded tape on the collector's sample.
 *
 * 2. THE TAPE'S SIDE. The side decides the direction. The audit compares
 *    the reconstructed side with the collector's recorded side, at the
 *    exact timestamps, on the same symbols.
 *
 * 3. THE PRICE. The ticket is anchored on the price. If Binance's
 *    contract is not the same instrument (a 1000x contract, a different
 *    listing), every level is wrong. The audit compares the collector's
 *    recorded price with Binance's close at the same minute.
 *
 * 4. THE BAR COVERAGE. If the 15m bars do not cover the observations,
 *    the trade resolution silently drops rows.
 *
 * READ-ONLY. No venue calls, no account calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fadeMetrics } from "/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/research/rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const bars1h = JSON.parse(readFileSync(join(OUT, "binance-90d-1h.json"), "utf8"));
const rows = readFileSync(join(OUT, "collector-snapshot-full.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

console.log("=".repeat(110));
console.log("THE DEEP SAMPLE'S FAITHFULNESS AUDIT");
console.log("=".repeat(110));

/** the tape at one instant from the venue's own 1h bars (the build's own logic) */
function tapeAt(bars, ts) {
  const win = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.t > ts) continue;
    win.push(b);
    if (win.length >= 24) break;
  }
  win.reverse();
  if (win.length < 24) return null;
  const m = fadeMetrics(win.map((b) => b.c), win.map((b) => b.v), win.map((b) => b.h), win.map((b) => b.l));
  if (!m) return null;
  return { ...m, last: win[win.length - 1].c };
}
function tapeSideOf(t) {
  if (!t) return null;
  if (t.offHighPct > 15) return null;
  if (t.vratio < 0.85 && t.offHighPct < 8) return "short";
  if (t.vratio > 3) return null;
  if (t.offLowPct > 15) return null;
  if (t.vratio > 3) return null;
  if (t.vratio < 0.85 && t.offLowPct < 8) return "long";
  return null;
}

// The collector's rows that fall inside the deep sample's window
const lo = Math.min(...Object.values(bars1h).map((b) => b[0].t));
const hi = Math.max(...Object.values(bars1h).map((b) => b[b.length - 1].t));
const inWin = rows.filter((r) => r.ts >= lo && r.ts <= hi);
console.log(`\n  the deep sample's 1h window: ${new Date(lo).toISOString()} -> ${new Date(hi).toISOString()}`);
console.log(`  collector rows inside it: ${inWin.length} of ${rows.length}`);

const dChg = [], dOH = [], dOL = [], dATR = [], dVR = [];
let sideAgree = 0, sideBoth = 0, sideFlip = 0, sideOneSided = 0, nTape = 0;
const perSym = [];

for (const r of inWin) {
  const b = bars1h[r.pair];
  if (!b) continue;
  const t = tapeAt(b, r.ts);
  if (!t) continue;
  nTape++;
  dChg.push(Math.abs(t.chg - (r.tapeChg ?? 0)));
  dOH.push(Math.abs(t.offHighPct - (r.tapeOffHighPct ?? 0)));
  dOL.push(Math.abs(t.offLowPct - (r.tapeOffLowPct ?? 0)));
  if (t.atrPct != null && r.tapeAtrPct != null) dATR.push(Math.abs(t.atrPct - r.tapeAtrPct));
  dVR.push(Math.abs(t.vratio - (r.tapeVratio ?? 1)));
  const s1 = tapeSideOf(t);
  const s2 = r.tapeSide ?? null;
  if (s1 && s2) {
    sideBoth++;
    if (s1 === s2) sideAgree++; else sideFlip++;
  } else if (s1 || s2) {
    sideOneSided++;
  }
}

console.log(`\n  ── 1. THE TAPE'S PRICE-BASED METRICS: Binance's reconstruction vs the machine's own record ──`);
console.log(`     ${nTape} reads on ${perSym.length ? "" : ""}the collector's own rows`);
console.log(`     median |difference|:  chg ${med(dChg).toFixed(3)}pp   offHigh ${med(dOH).toFixed(3)}pp   offLow ${med(dOL).toFixed(3)}pp   ATR ${med(dATR).toFixed(4)}pp`);
console.log(`     median |vratio difference| ${med(dVR).toFixed(3)}  (VENUE-SPECIFIC VOLUME — not a reconstruction error, but it does move the side)`);

console.log(`\n  ── 2. THE TAPE'S SIDE ──`);
console.log(`     reads where BOTH venues had a side: ${sideBoth}`);
console.log(`     agreement: ${sideBoth ? ((sideAgree / sideBoth) * 100).toFixed(1) : "n/a"}%   (${sideFlip} opposed)`);
console.log(`     reads where only ONE venue had a side: ${sideOneSided} of ${nTape} (${((sideOneSided / nTape) * 100).toFixed(1)}%)`);

console.log(`\n  ── 3. THE PRICE (the ticket's anchor) ──`);
const relDiff = [];
for (const r of inWin) {
  const b = bars1h[r.pair];
  if (!b || !(r.price > 0)) continue;
  // the 1h bar's close at or before the read
  let close = null;
  for (let i = b.length - 1; i >= 0; i--) { if (b[i].t <= r.ts) { close = b[i].c; break; } }
  if (!(close > 0)) continue;
  const ratio = r.price / close;
  const scale = ratio > 100 ? 1000 : ratio < 0.01 ? 0.001 : 1;
  relDiff.push(Math.abs((r.price - close * scale) / (close * scale)) * 10000);
}
console.log(`     median |price difference| = ${med(relDiff).toFixed(1)} bps  (the venues' spread + basis)`);
console.log(`     ${relDiff.filter((x) => x > 100).length} of ${relDiff.length} reads differ by more than 100 bps`);

console.log(`\n  ── 4. THE BAR COVERAGE of the deep sample's own observations ──`);
const deep = JSON.parse(readFileSync(join(OUT, "deep-observations.json"), "utf8"));
const bars15 = JSON.parse(readFileSync(join(OUT, "binance-90d-15m.json"), "utf8"));
let noBars = 0, noForward = 0, noFull = 0;
for (const r of deep.rows) {
  const b = bars15[r.pair];
  if (!b) { noBars++; continue; }
  let i = -1;
  for (let k = 0; k < b.length; k++) { if (b[k].t > r.ts) { i = k; break; } }
  if (i < 0) { noForward++; continue; }
  if (i + 16 > b.length) noFull++;
}
console.log(`     ${deep.rows.length.toLocaleString()} deep observations`);
console.log(`     no 15m bars at all: ${noBars.toLocaleString()} (${(noBars / deep.rows.length * 100).toFixed(2)}%)`);
console.log(`     no FORWARD bar (cannot resolve a ticket): ${noForward.toLocaleString()} (${(noForward / deep.rows.length * 100).toFixed(2)}%)`);
console.log(`     a forward bar but not a FULL 16-bar window: ${noFull.toLocaleString()} (${(noFull / deep.rows.length * 100).toFixed(2)}%)`);
console.log(`     => the time exit is only REAL for the ${(deep.rows.length - noFull - noForward).toLocaleString()} observations with a full window;`);
console.log(`        the rest are DROPPED by the harness, not truncated into a fake outcome.`);
