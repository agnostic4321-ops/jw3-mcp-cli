#!/usr/bin/env node
/**
 * WHY IS THE KUCOIN REPLICABLE ARM'S EXCESS SO LARGE? — a look-ahead audit.
 *
 * The KuCoin baseline's replicable arm (the tape agreeing with the Laya
 * bridge computed WITHOUT the JEV leg) showed a large positive excess —
 * large enough that it deserves an audit before it is used as a
 * baseline at all.
 *
 * THE SUSPICION: the tape's exhaustion read is a REVERSAL signal. A
 * fade-short fires when the market is near its high and the volume has
 * faded; a dip-long fires when the market is near its low and the
 * volume has faded. BOTH are trades AGAINST the recent move. So the
 * arm's direction is, by construction, a COUNTER-TREND bet.
 *
 * In a sample that is 94% an UPTREND, the tape's short signals are
 * counter-trend. If the Laya bridge's tape leg (sign(chg) x ...) is
 * ALSO pushing the same way as the exhaustion read, then "the tape
 * agrees with Laya" may be selecting rows where the Laya leg is
 * dominated by the tape's own momentum term — and where the outcome is
 * then a bet against a market that is about to keep going up.
 *
 * The AUDIT answers one question: is the excess concentrated in rows
 * whose outcome is decided by a SMALL number of observations, and does
 * it survive a placebo — the same geometry on a DIRECTION-REVERSED
 * arm (the tape against the models' direction)?
 *
 * READ-ONLY. No venue calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow, layaVerdict } from "./rep-venue-common.mjs";
import { GEOMETRIES, measure, armFacts } from "./rep-measure.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const rows = readFileSync(join(SCRATCH, "rep-confluence.snapshot.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const CACHE = JSON.parse(readFileSync(join(SCRATCH, "rep-kucoin-15m-bars.snapshot.json"), "utf8"));

const tapeOf = (r) => tapeSideFromRow(r);
const layaNoJev = (r) => {
  if (r.tapeChg == null) return null;
  return layaVerdict({
    chg: r.tapeChg, atrPct: r.tapeAtrPct,
    jevSide: null, jevAgreement: 0, jevUncertain: true,
    imb: r.bookImbalance, sprBps: r.spreadBps,
  }).choice;
};

const agree = [];   // the tape and the models agree
const oppose = [];  // the tape and the models CONTRADICT — the placebo
const uncond = [];
for (const r of rows) {
  const t = tapeOf(r);
  if (!t) continue;
  uncond.push({ ...r, dir: t });
  const l = layaNoJev(r);
  if (!l) continue;
  if (l === t) agree.push({ ...r, dir: t });
  else oppose.push({ ...r, dir: t === "long" ? "short" : "long" }); // the placebo: the OPPOSITE side
}

const fa = armFacts(agree);
const fo = armFacts(oppose);
const fu = armFacts(uncond);
console.log(`  AGREE arm (the signal):   rows=${fa.rows} clusters=${fa.clusters} long=${fa.long} short=${fa.short}`);
console.log(`  OPPOSE arm (the placebo): rows=${fo.rows} clusters=${fo.clusters} long=${fo.long} short=${fo.short}`);
console.log(`  UNCOND arm:               rows=${fu.rows} clusters=${fu.clusters} long=${fu.long} short=${fu.short}`);

console.log(`\n  THE EXCESS OF EACH ARM OVER THE UNCONDITIONAL BASELINE`);
console.log(`  ${"GEOMETRY".padEnd(26)} ${"agree.EXC".padStart(11)} ${"t".padStart(7)} ${"oppose.EXC".padStart(12)} ${"t".padStart(7)}   verdict`);
console.log("  " + "-".repeat(90));
for (const g of GEOMETRIES) {
  const a = measure(agree, uncond, g, CACHE);
  const o = measure(oppose, uncond, g, CACHE);
  // The PLACEBO: if the reverse arm shows a similar excess, the "signal"
  // is not selecting a direction, it is selecting a REGIME.
  const placeboFails = Math.abs(o.excess) >= Math.abs(a.excess);
  const verdict = a.excess > 0 && a.excessT >= 2 ? (placeboFails ? "PLACEBO FAILS (regime, not signal)" : "EDGE") : (a.excess > 0 ? "positive, t<2 (PATTERN)" : "no edge");
  console.log(
    `  ${g.name.padEnd(26)} ${(a.excess >= 0 ? "+" : "") + a.excess.toFixed(4)}% ${a.excessT.toFixed(2).padStart(7)} ${(o.excess >= 0 ? "+" : "") + o.excess.toFixed(4)}% ${o.excessT.toFixed(2).padStart(7)}   ${verdict}`,
  );
}

// The mechanism: what is the Laya bridge actually saying on the agree arm?
console.log(`\n  THE MECHANISM — what drives the Laya bridge on the agree arm?`);
const terms = { jev: 0, tape: 0, book: 0, flat: 0 };
for (const r of agree) {
  const atr = r.tapeAtrPct;
  const denom = atr != null && atr > 0 ? Math.max(2 * atr, 0.5) : 0.5;
  const tu = Math.max(-1, Math.min(r.tapeChg / denom, 1));
  const tapeTerm = (tu >= 0 ? 1 : -1) * Math.abs(tu) * 0.6;
  const bookTerm = r.bookImbalance != null ? Math.max(-1, Math.min(r.bookImbalance, 1)) * 0.5 : 0;
  const v = layaVerdict({ chg: r.tapeChg, atrPct: atr, jevSide: null, jevAgreement: 0, jevUncertain: true, imb: r.bookImbalance, sprBps: r.spreadBps });
  if (v.choice === "flat") { terms.flat++; continue; }
  if (Math.abs(tapeTerm) >= Math.abs(bookTerm)) terms.tape++;
  else terms.book++;
}
console.log(`    on the agree arm, the deciding leg is: tape ${terms.tape}, book ${terms.book}, flat ${terms.flat}`);
console.log(`    => the Laya bridge's TAPE term is sign(chg) x momentum. On the AGREE arm,`);
console.log(`       the tape's exhaustion read and the Laya momentum term can point the`);
console.log(`       SAME way, because a fade-short fires after a RISE that faded.`);

// How many of the agree arm's rows are in the same 5-minute bucket?
console.log(`\n  THE CLUSTER STRUCTURE of the agree arm`);
const byBucket = new Map();
for (const r of agree) {
  const b = Math.floor(r.ts / 300_000);
  byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
}
console.log(`    ${byBucket.size} buckets, sizes: ${[...byBucket.values()].sort((a, b) => b - a).join(",")}`);
console.log(`    -> ${fa.rows} rows in ${fa.clusters} buckets; a bucket's rows are the SAME`);
console.log(`       market state read on different symbols.`);

// The decisive check: the excess with the DIRECTION held fixed.
console.log(`\n  THE EXCESS WITH THE DIRECTION HELD FIXED (each side alone, vs the same-side unconditional)`);
for (const dir of ["short", "long"]) {
  const s = agree.filter((r) => r.dir === dir);
  const u = uncond.filter((r) => r.dir === dir);
  if (!s.length || !u.length) { console.log(`    ${dir}: no data`); continue; }
  console.log(`    ${dir.toUpperCase()}: signal n=${s.length} (${new Set(s.map((r) => Math.floor(r.ts / 300000))).size} clusters) uncond n=${u.length}`);
  for (const g of GEOMETRIES.slice(0, 5)) {
    const m = measure(s, u, g, CACHE);
    console.log(`      ${g.name.padEnd(26)} EXCESS=${(m.excess >= 0 ? "+" : "") + m.excess.toFixed(4)}%  t=${m.excessT.toFixed(2)}  win%=${(m.winRate * 100).toFixed(0)}  uncond win%=${(m.uWinRate * 100).toFixed(0)}`);
  }
}
