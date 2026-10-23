#!/usr/bin/env node
/**
 * THE LAST CONTROL — is the Binance excess just SHORTING A DOWNTREND?
 *
 * The independent venue's window is 60% DOWN. The signal arm is 21624
 * SHORT rows and 96 LONG rows. So the arm is, in substance, a short
 * book, and a short book in a falling market makes money.
 *
 * THE BASELINE THAT KILLS IT: an unconditional SHORT on every row of
 * the SAME window, regardless of the tape's read. If the signal's
 * excess over THAT is zero, the signal adds nothing to simply
 * shorting a falling market.
 *
 * And the same comparison is made with the market's DIRECTION
 * controlled: the signal's short rows are compared with the
 * unconditional short rows from the same 24-hour-move decile, so the
 * market's drift is removed cell by cell.
 *
 * This is the version that decides whether the independent venue's
 * result is an edge or the market.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measure, measureDirectionMatched } from "./rep-measure.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const NOE = 1.0484;

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

for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const { B, C } = buildArms(rows, { book: false, jev: false });

  // THE BASELINE: an unconditional SHORT on every row of the window,
  // and an unconditional LONG on every row. Neither looks at the tape.
  const allShort = rows.map((r) => ({ ...r, dir: "short" }));
  const allLong = rows.map((r) => ({ ...r, dir: "long" }));

  // The deciles, for the cell-matched version.
  const sorted = C.map((r) => r.tapeChg).sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
  const dec = (chg) => { let d = 0; while (d < cuts.length && chg >= cuts[d]) d++; return d; };

  console.log(`\n╔══ ${v.name} — THE DOWNTREND BASELINE ══`);
  console.log(`║  the signal arm: ${B.filter((r) => r.dir === "long").length}L / ${B.filter((r) => r.dir === "short").length}S`);

  for (const g of GEOMETRIES) {
    // (a) The signal arm vs the UNCONDITIONAL TAPE arm (the study's own baseline).
    const a = measureDirectionMatched(B, C, g, bars, { takerRt: v.takerRt });
    // (b) The signal arm vs an unconditional SHORT on EVERY row (the
    //     downtrend baseline), direction-matched so the comparison is
    //     like-for-like on the short side.
    const shortSignal = B.filter((r) => r.dir === "short");
    const b = measureDirectionMatched(shortSignal, allShort, g, bars, { takerRt: v.takerRt });
    // (c) The CELL-MATCHED version: the signal's rows vs the
    //     unconditional rows of the same direction in the same decile.
    const cells = [];
    for (const dir of ["long", "short"]) {
      for (let d = 0; d < 10; d++) {
        const s = B.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
        const u = C.filter((r) => r.dir === dir && dec(r.tapeChg) === d);
        if (!s.length || !u.length) continue;
        const m = measureDirectionMatched(s, u, g, bars, { takerRt: v.takerRt });
        cells.push({ dir, d, rows: m.rows, clusters: m.clusters, excess: m.excess, t: m.t, weight: m.rows / B.length });
      }
    }
    const cEx = cells.reduce((s, x) => s + x.weight * x.excess, 0);
    const cSe = Math.sqrt(cells.reduce((s, x) => s + x.weight ** 2 * (x.t !== 0 ? (x.excess / x.t) ** 2 : 0), 0));
    const cT = cSe > 0 ? cEx / cSe : 0;

    console.log(`  ${g.name}`);
    console.log(`    (a) vs the UNCONDITIONAL TAPE arm:      exc=${(a.excess >= 0 ? "+" : "") + a.excess.toFixed(4)}%  t=${a.t.toFixed(2)}   [n=${a.rows} clus=${a.clusters}]`);
    console.log(`    (b) vs an unconditional SHORT on EVERY row: exc=${(b.excess >= 0 ? "+" : "") + b.excess.toFixed(4)}%  t=${b.t.toFixed(2)}   [n=${b.rows} clus=${b.clusters}]`);
    console.log(`    (c) CELL-MATCHED (direction x decile):  exc=${(cEx >= 0 ? "+" : "") + cEx.toFixed(4)}%  t=${cT.toFixed(2)}   cells=${cells.length}`);
    for (const x of cells) {
      console.log(`          ${x.dir}/d${x.d}: n=${String(x.rows).padStart(5)} clus=${String(x.clusters).padStart(4)} exc=${(x.excess >= 0 ? "+" : "") + x.excess.toFixed(4)}% t=${x.t.toFixed(2)}`);
    }
  }
}
