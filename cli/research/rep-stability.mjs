#!/usr/bin/env node
/**
 * THE STABILITY TEST — is the effect in EVERY stretch of the window?
 *
 * The controls disagree on the independent venue:
 *
 *   - the direction-matched excess is positive with t=2.3-3.4;
 *   - the regime-matched (sign) version is t=0.8-1.7;
 *   - the cell-matched (direction x decile) version is t=1.9-3.2;
 *   - the randomization test says the signal beats a random draw from
 *     the same market state, p=0.002.
 *
 * Disagreement between controls like that has one usual cause: the
 * effect is CONCENTRATED. A handful of stretches of the window carry
 * it, and a control that happens to include or exclude those stretches
 * moves the answer.
 *
 * So the effect is measured on EVERY DAY of the window separately, and
 * the question asked is: in how many of them is the excess positive?
 * A real effect is in most of them. An effect carried by two or three
 * days out of fourteen is a market event, not a signal.
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArms } from "./rep-arms.mjs";
import { GEOMETRIES, measureDirectionMatched, measure } from "./rep-measure.mjs";

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

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

for (const v of VENUES) {
  const raw = readFileSync(v.rowsFile, "utf8");
  const rows = raw.trimStart().startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bars = JSON.parse(readFileSync(v.barsFile, "utf8"));
  const { B, C } = buildArms(rows, { book: false, jev: false });

  const days = [...new Set(rows.map((r) => dayOf(r.ts)))].sort();
  console.log(`\n╔══ ${v.name} — THE DAY-BY-DAY STABILITY TEST ══`);
  console.log(`║  ${days.length} days in the window; the signal arm has ${B.length} rows`);

  for (const g of GEOMETRIES) {
    const perDay = [];
    for (const d of days) {
      const s = B.filter((r) => dayOf(r.ts) === d);
      const u = C.filter((r) => dayOf(r.ts) === d);
      if (s.length < 2) continue;
      // The cell-matched excess within the day, so the market's drift
      // in that day is not the answer.
      const sorted = u.map((r) => r.tapeChg).sort((a, b) => a - b);
      const cuts = [];
      for (let i = 1; i < 10; i++) cuts.push(sorted[Math.floor((sorted.length * i) / 10)]);
      const dec = (chg) => { let x = 0; while (x < cuts.length && chg >= cuts[x]) x++; return x; };
      const cells = [];
      for (const dir of ["long", "short"]) {
        for (let b = 0; b < 10; b++) {
          const ss = s.filter((r) => r.dir === dir && dec(r.tapeChg) === b);
          const uu = u.filter((r) => r.dir === dir && dec(r.tapeChg) === b);
          if (!ss.length || !uu.length) continue;
          const m = measureDirectionMatched(ss, uu, g, bars, { takerRt: v.takerRt });
          cells.push({ excess: m.excess, t: m.t, weight: m.rows / s.length });
        }
      }
      if (!cells.length) continue;
      const ex = cells.reduce((z, c) => z + c.weight * c.excess, 0);
      const se = Math.sqrt(cells.reduce((z, c) => z + c.weight ** 2 * (c.t !== 0 ? (c.excess / c.t) ** 2 : 0), 0));
      perDay.push({ d, n: s.length, excess: ex, t: se > 0 ? ex / se : 0 });
    }
    if (!perDay.length) { console.log(`  ${g.name}: no data`); continue; }
    const pos = perDay.filter((x) => x.excess > 0).length;
    const sig = perDay.filter((x) => x.t >= 2).length;
    const sigNeg = perDay.filter((x) => x.t <= -2).length;
    const detail = perDay.map((x) => `${x.d.slice(5)}:${x.n}(${(x.excess >= 0 ? "+" : "") + x.excess.toFixed(3)},t${x.t.toFixed(1)})`).join(" ");
    console.log(`  ${g.name.padEnd(26)} ${pos}/${perDay.length} days positive, ${sig} significant, ${sigNeg} significantly NEGATIVE`);
    console.log(`    ${detail}`);
  }
}
