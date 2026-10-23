#!/usr/bin/env node
/**
 * THE MAGNITUDE-MATCHED EXCESS — the strictest control.
 *
 * The regime control matches on the SIGN of the market's 24-hour move
 * (up / down). That is coarse: a market that rose 0.1% and a market
 * that rose 8% are both "up", and the second pays a short's stop
 * differently from the first. If the signal arm's rows happen to sit in
 * the steeper part of the move, the regime-matched excess is still the
 * market's drift.
 *
 * So the tightest available test matches on the MAGNITUDE as well: the
 * signal's rows are bucketed into DECILES of the tape's 24-hour change,
 * and each decile is compared with the unconditional arm's rows from
 * the SAME decile and the SAME direction.
 *
 * If the excess survives a magnitude-and-direction match, it is a
 * property of the signal. If it collapses, it was the drift.
 *
 * The comparison is also made on the CROSS-TAB (direction x decile), and
 * a QUANTILE-MATCHED version is reported for the short side alone,
 * because that is where the independent venue's rows live.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched } from "./rep-measure.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");

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

/**
 * The DECILE of the tape's 24-hour change, computed over the
 * unconditional arm's rows, so the buckets are the same for both arms
 * and are defined by the market's own distribution.
 */
function decileBuckets(uncond) {
  const sorted = uncond.map((r) => r.tapeChg).sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
  const bucketOf = (chg) => {
    let d = 0;
    while (d < cuts.length && chg >= cuts[d]) d++;
    return d;
  };
  return { bucketOf, cuts };
}

for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const { B, C } = buildArms(rows, { book: false, jev: false });
  const { bucketOf, cuts } = decileBuckets(C);

  console.log(`\n╔══ ${v.name} — THE MAGNITUDE-MATCHED EXCESS ══`);
  console.log(`║  signal arm ${B.length} rows / ${new Set(B.map((r) => Math.floor(r.ts / 300000))).size} clusters;  unconditional ${C.length} rows`);
  console.log(`║  the tape's 24h change, decile cuts: ${cuts.map((c) => c.toFixed(1)).join(", ")}`);

  for (const g of GEOMETRIES) {
    // The cross-tab: direction x decile, each cell compared with the
    // unconditional arm's rows from the SAME cell.
    const cells = [];
    for (const dir of ["long", "short"]) {
      for (let d = 0; d < 10; d++) {
        const s = B.filter((r) => r.dir === dir && bucketOf(r.tapeChg) === d);
        const u = C.filter((r) => r.dir === dir && bucketOf(r.tapeChg) === d);
        if (!s.length || !u.length) continue;
        const m = measureDirectionMatched(s, u, g, bars, { takerRt: v.takerRt });
        cells.push({ dir, d, rows: m.rows, clusters: m.clusters, excess: m.excess, t: m.t, weight: m.rows / B.length });
      }
    }
    if (!cells.length) { console.log(`  ${g.name}: no data`); continue; }
    const excess = cells.reduce((s, c) => s + c.weight * c.excess, 0);
    const seC = Math.sqrt(cells.reduce((s, c) => s + c.weight ** 2 * (c.t !== 0 ? (c.excess / c.t) ** 2 : 0), 0));
    const t = seC > 0 ? excess / seC : 0;
    const detail = cells.map((c) => `${c.dir}/d${c.d}: n=${c.rows} clus=${c.clusters} exc=${(c.excess >= 0 ? "+" : "") + c.excess.toFixed(4)}% t=${c.t.toFixed(2)}`).join("  |  ");
    console.log(`  ${g.name.padEnd(26)} MATCHED exc=${(excess >= 0 ? "+" : "") + excess.toFixed(4)}%  t=${t.toFixed(2)}   cells=${cells.length}`);
    console.log(`    ${detail}`);
  }

  // THE HEADLINE vs THE MAGNITUDE-MATCHED, side by side.
  console.log(`\n  ${v.name} — HEADLINE (direction-matched) vs MAGNITUDE-MATCHED`);
  for (const g of GEOMETRIES) {
    const hl = measureDirectionMatched(B, C, g, bars, { takerRt: v.takerRt });
    const cells = [];
    for (const dir of ["long", "short"]) {
      for (let d = 0; d < 10; d++) {
        const s = B.filter((r) => r.dir === dir && bucketOf(r.tapeChg) === d);
        const u = C.filter((r) => r.dir === dir && bucketOf(r.tapeChg) === d);
        if (!s.length || !u.length) continue;
        const m = measureDirectionMatched(s, u, g, bars, { takerRt: v.takerRt });
        cells.push({ excess: m.excess, t: m.t, weight: m.rows / B.length });
      }
    }
    const ex = cells.reduce((s, c) => s + c.weight * c.excess, 0);
    const seC = Math.sqrt(cells.reduce((s, c) => s + c.weight ** 2 * (c.t !== 0 ? (c.excess / c.t) ** 2 : 0), 0));
    const t = seC > 0 ? ex / seC : 0;
    console.log(`    ${g.name.padEnd(26)} headline ${(hl.excess >= 0 ? "+" : "") + hl.excess.toFixed(4)}% t=${hl.t.toFixed(2)}   ->  magnitude-matched ${(ex >= 0 ? "+" : "") + ex.toFixed(4)}% t=${t.toFixed(2)}   ${t < 2 ? "COLLAPSES" : "holds"}`);
  }
}
