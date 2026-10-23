#!/usr/bin/env node
/**
 * THE RANDOMIZATION TEST — the decisive control, calibrated.
 *
 * ── THE PROBLEM IT SOLVES ──
 *
 * THE SIGNAL ARM IS A SUBSET OF THE UNCONDITIONAL ARM: every row the
 * signal selects is also a row the unconditional arm contains. So the
 * two arms are not independent samples, and "the signal arm's mean
 * minus the unconditional arm's mean" is a SELECTION effect, not two
 * independent estimates being compared.
 *
 * And a naive randomization test — "is the signal's mean better than
 * a random draw of the same size from the whole unconditional arm?"
 * — has no power to tell a REAL edge from a REGIME SELECTION, because
 * both beat a random draw. (The positive control below shows exactly
 * that: a signal that selects rows purely by the market's own move is
 * "significant" under that test.)
 *
 * THE TEST: the null hypothesis is that the signal is a random subset
 * of the unconditional arm WITHIN each market-state cell. Each cell is
 * a direction crossed with a decile of the market's 24-hour move — so
 * a random draw from the cell has the SAME direction and the SAME
 * market state as the rows being tested. If the signal carries no
 * information beyond the market state, a random draw from the cell
 * does just as well, and the test comes out flat.
 *
 * THE POSITIVE CONTROLS, on the same real data:
 *
 *   A. A GENUINE EDGE — built WITHIN cells: from each cell, the rows
 *      whose forward 4-hour move was best. The test MUST reject the
 *      null for this. If it does not, the test has no power and the
 *      result on the real signal means nothing.
 *   B. A RANDOM SELECTION — MUST NOT be rejected.
 *   C. A REGIME-ONLY SELECTION — rows chosen purely by the market's
 *      move. This is the shape the real tape signal has, and it MUST
 *      NOT be rejected, because such a signal carries no information
 *      beyond the market.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure } from "./rep-measure.mjs";
import { mean } from "./rep-venue-common.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;
const DRAWS = 400;

const VENUES = [
  {
    name: "KUCOIN",
    rowsFile: join(SCRATCH, "rep-confluence.parent-snap.ndjson"),
    barsFile: join(SCRATCH, "rep-kucoin-15m-bars.snapshot.json"),
    takerRt: 0.12,
  },
  {
    name: "BINANCE",
    rowsFile: join(SCRATCH, "rep-binance-obs.json"),
    barsFile: join(SCRATCH, "rep-binance-15m-bars.json"),
    takerRt: 0.10,
  },
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * THE CELL-MATCHED RANDOMIZATION TEST.
 *
 * The statistic is the signal arm's mean per-trade P&L. The null
 * distribution is the mean of the SAME-SIZE random draws taken from
 * the SAME cell of the unconditional arm.
 */
function cellRandomizationTest(signal, uncond, g, bars, takerRt, seed) {
  // The cells: direction x decile of the market's 24-hour move, cut on
  // the unconditional arm's distribution.
  const sorted = uncond.map((r) => r.tapeChg).sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
  const dec = (chg) => { let d = 0; while (d < cuts.length && chg >= cuts[d]) d++; return d; };
  const key = (r) => `${r.dir}|${dec(r.tapeChg)}`;

  const pnlOf = (set) => {
    const m = measure(set, set, g, bars, { takerRt });
    const pnl = [];
    for (const r of m.signalRows) {
      pnl.push(r.kind === "win" ? (g.tp ?? 0.4) * NOE - takerRt * NOE
        : r.kind === "loss" ? -(g.sl ?? 1.2) * NOE - takerRt * NOE
        : r.pnl);
    }
    return pnl;
  };

  const sigCells = new Map();
  for (const r of signal) {
    const k = key(r);
    if (!sigCells.has(k)) sigCells.set(k, []);
    sigCells.get(k).push(r);
  }
  const uncCells = new Map();
  for (const r of uncond) {
    const k = key(r);
    if (!uncCells.has(k)) uncCells.set(k, []);
    uncCells.get(k).push(r);
  }

  // The signal's per-cell P&L and the per-cell pool to draw from.
  const cells = [];
  for (const [k, sRows] of sigCells) {
    const uRows = uncCells.get(k) ?? [];
    if (!uRows.length) continue;
    const sP = pnlOf(sRows);
    const uP = pnlOf(uRows);
    if (!sP.length) continue;
    cells.push({ k, sP, uP, n: sP.length });
  }
  if (!cells.length) return null;

  const rand = mulberry32(seed);
  const drawMeans = [];
  for (let d = 0; d < DRAWS; d++) {
    let sum = 0, n = 0;
    for (const c of cells) {
      const idx = new Array(c.uP.length);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const take = idx.slice(0, Math.min(c.n, c.uP.length));
      sum += take.reduce((a, i) => a + c.uP[i], 0);
      n += take.length;
    }
    if (n) drawMeans.push(sum / n);
  }
  if (!drawMeans.length) return null;
  const sigPnl = cells.flatMap((c) => c.sP);
  const obs = mean(sigPnl);
  const nullMean = mean(drawMeans);
  const sd = Math.sqrt(mean(drawMeans.map((x) => (x - nullMean) ** 2)));
  const p = (drawMeans.filter((x) => x >= obs).length + 1) / (drawMeans.length + 1);
  return {
    obs, nullMean, z: sd > 0 ? (obs - nullMean) / sd : 0, p,
    cells: cells.length,
    detail: cells.map((c) => `${c.k}: n=${c.n} exc=${(mean(c.sP) - mean(c.uP) >= 0 ? "+" : "") + (mean(c.sP) - mean(c.uP)).toFixed(4)}%`).join("  "),
  };
}

/** The forward 4-hour move of a row, in %. */
function fwdMove(r, bars) {
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

for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const { B, C } = buildArms(rows, { book: false, jev: false });

  console.log(`\n╔══ ${v.name} — THE CELL-MATCHED RANDOMIZATION TEST ══`);
  console.log(`║  signal arm ${B.length} rows; unconditional ${C.length} rows; ${DRAWS} draws per cell; seed fixed`);

  // ── THE POSITIVE CONTROLS, on this venue's own data ───────────────
  const g = GEOMETRIES[3];
  console.log(`\n  POSITIVE CONTROLS (geometry: ${g.name})`);
  {
    // A: a genuine edge, built WITHIN cells — from each cell, the rows
    // whose forward 4-hour move was best (in the signal's direction).
    const sorted = C.map((r) => r.tapeChg).sort((a, b) => a - b);
    const cuts = [];
    for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
    const dec = (chg) => { let d = 0; while (d < cuts.length && chg >= cuts[d]) d++; return d; };
    const byCell = new Map();
    for (const r of C) {
      const k = `${r.dir}|${dec(r.tapeChg)}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(r);
    }
    const genuine = [];
    for (const [, set] of byCell) {
      const withFwd = set.map((r) => ({ r, m: fwdMove(r, bars) })).filter((x) => x.m != null);
      // The best rows in the signal's own direction.
      withFwd.sort((a, b) => (a.r.dir === "long" ? b.m - a.m : a.m - b.m));
      const take = Math.max(1, Math.round(withFwd.length * (B.length / C.length)));
      genuine.push(...withFwd.slice(0, take).map((x) => x.r));
    }
    const rand = mulberry32(0xBEEF);
    const shuffled = [...C];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const randomSel = shuffled.slice(0, B.length);
    const regimeOnly = [...C].sort((a, b) => a.tapeChg - b.tapeChg).slice(0, B.length);

    for (const [label, sig, must] of [
      ["A  a GENUINE EDGE, built within cells", genuine, "MUST be rejected"],
      ["B  a RANDOM SELECTION", randomSel, "must NOT be rejected"],
      ["C  a REGIME-ONLY SELECTION", regimeOnly, "must NOT be rejected"],
    ]) {
      const r = cellRandomizationTest(sig, C, g, bars, v.takerRt, 0x1234);
      if (!r) { console.log(`  ${label.padEnd(42)} no data`); continue; }
      const verdict = r.p < 0.05 ? "SIGNIFICANT" : r.p < 0.2 ? "marginal" : "not significant";
      console.log(`  ${label.padEnd(42)} obs=${(r.obs >= 0 ? "+" : "") + r.obs.toFixed(4)}%  null=${(r.nullMean >= 0 ? "+" : "") + r.nullMean.toFixed(4)}%  z=${r.z.toFixed(2)}  p=${r.p.toFixed(3)}  ${verdict}   [${must}]`);
    }
  }

  // ── THE REAL SIGNAL, every geometry ───────────────────────────────
  console.log(`\n  THE REAL TAPE SIGNAL`);
  for (const g of GEOMETRIES) {
    const r = cellRandomizationTest(B, C, g, bars, v.takerRt, 0x5EED);
    if (!r) { console.log(`  ${g.name.padEnd(42)} no data`); continue; }
    const verdict = r.p < 0.05 ? "SIGNIFICANT" : r.p < 0.2 ? "marginal" : "NOT SIGNIFICANT";
    console.log(`  ${g.name.padEnd(42)} obs=${(r.obs >= 0 ? "+" : "") + r.obs.toFixed(4)}%  null=${(r.nullMean >= 0 ? "+" : "") + r.nullMean.toFixed(4)}%  z=${r.z.toFixed(2)}  p=${r.p.toFixed(3)}  ${verdict}  cells=${r.cells}`);
  }
}
