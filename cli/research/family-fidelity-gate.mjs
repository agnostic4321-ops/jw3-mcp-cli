#!/usr/bin/env node
/**
 * THE FIDELITY GATE — does this harness reproduce the HOUSE's own
 * measurement exactly?
 *
 * A new instrument is only as good as its agreement with the instrument
 * already in the repo. This script runs the house's own resolver
 * (research/sweep-corrected.mjs's `trade()`) and this harness's
 * resolver over the SAME signals and the SAME geometries, and prints
 * the differences.
 *
 * THE TWO RESOLVERS, AND WHERE THEY CAN DIFFER
 * --------------------------------------------
 * 1. THE ENTRY ANCHOR. The house uses the collector's `price` (the
 *    market at the signal); this harness uses the bar's CLOSE at the
 *    signal bar. These differ by up to one bar's move, so the
 *    comparison uses the SAME entry for both (the bar close), and the
 *    house's own entry is checked separately as a sensitivity.
 *
 * 2. THE FIRST-TOUCH ORDER. The house's `trade()` checks the stop
 *    BEFORE the target within each bar, so a bar touching both is a
 *    loss; but it does not compare the TOUCH ORDER across bars. This
 *    harness does. The difference is reported, not hidden.
 *
 * 3. THE LOSS SIZE. Both book the loss at the STOP DISTANCE.
 *
 * 4. THE TIME EXIT. Both mark at the close of the last bar of the hold.
 *
 * 5. THE CENSORING. The house drops a signal whose forward window runs
 *    past the cache; so does this harness.
 *
 * If the two agree on the outcomes, this harness measures what the
 * house measures, and the family results can be read as house results.
 *
 * READ-ONLY. Local caches only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBars, mean, NOTIONAL, TAKER_RT } from "./family-harness.mjs";
import { resolveTrade } from "./family-resolver-test.mjs";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rawBars = JSON.parse(readFileSync(BARS, "utf8"));
const pbars = loadBars({ withVolume: false });

// ══════════════════════════════════════════════════════════════════════
// THE HOUSE'S RESOLVER — transcribed from research/sweep-corrected.mjs
// ══════════════════════════════════════════════════════════════════════
function houseTrade(r, tpPct, stopPct, holdBars, fee) {
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const b = rawBars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + holdBars);
  if (end - i < 2) return null;
  const long = tapeSideFromRow(r) === "long";
  const entry = last;
  const target = long ? last * (1 + tpPct / 100) : last * (1 - tpPct / 100);
  const stop = long ? last * (1 - stopPct / 100) : last * (1 + stopPct / 100);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitSl) return { outcome: "loss", pnlPct: -stopPct / 100 - fee };
    if (hitTp) return { outcome: "win", pnlPct: tpPct / 100 - fee };
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { outcome: "time", pnlPct: movePct - fee };
}

// ══════════════════════════════════════════════════════════════════════
// THIS HARNESS'S RESOLVER
// ══════════════════════════════════════════════════════════════════════
// THIS HARNESS'S RESOLVER — imported from the ONE place the sign rule
// lives, so the fidelity gate and the studies cannot drift apart.
function harnessTrade(pb, idx, dir, tpPct, stopPct, hold) {
  const o = resolveTrade(pb, idx, dir, tpPct, stopPct, hold);
  if (!o) return null;
  return { outcome: o.kind, pnlPct: o.gross - TAKER_RT };
}

// The house's scan starts at the first bar AFTER the signal's timestamp.
// The harness's signal bar is the bar whose close is the entry. For the
// comparison, find the bar index of the first bar with t > r.ts, and use
// the PREVIOUS bar as the harness's signal bar (its close is the entry).
// The house's resolver, but with the entry and the scan-start bar
// INJECTED — so the only difference left against this harness is the
// FILL RULE.
function houseTradeMatched(entry, long, b, scanStart, end, tpPct, stopPct, fee) {
  const target = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const stop = long ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  for (let k = scanStart; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitSl) return { outcome: "loss", pnlPct: -stopPct / 100 - fee };
    if (hitTp) return { outcome: "win", pnlPct: tpPct / 100 - fee };
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { outcome: "time", pnlPct: movePct - fee };
}

const GEOMS = [
  { tp: 0.3, stop: 0.5, hold: 16 },
  { tp: 0.4, stop: 1.0, hold: 16 },
  { tp: 1.0, stop: 0.5, hold: 8 },
  { tp: 2.0, stop: 1.0, hold: 32 },
  { tp: 0.5, stop: 0.0, hold: 16 },
];

console.log("═".repeat(112));
console.log("THE FIDELITY GATE — this harness vs the house's own resolver");
console.log("═".repeat(112));

let totalCmp = 0, totalAgree = 0, totalDiffPnl = 0;
for (const g of GEOMS) {
  let n = 0, agree = 0, sameKind = 0, diffPnl = 0, firstTouchDiff = 0;
  const examples = [];
  for (const r of rows) {
    if (!tapeSideFromRow(r)) continue;
    const b = rawBars[r.pair];
    if (!b) continue;
    const i = b.findIndex((x) => x.t > r.ts);
    if (i < 0) continue;
    const pb = pbars[r.pair];
    if (!pb) continue;
    // the harness's signal bar: the bar before the house's first scan bar
    const hIdx = pb.bars.findIndex((x) => x.t === b[i - 1]?.t);
    if (hIdx < 0) continue;
    const dir = tapeSideFromRow(r) === "long" ? 1 : -1;
    const h = harnessTrade(pb, hIdx, dir, g.tp, g.stop, g.hold);
    const hh = houseTrade(r, g.tp, g.stop, g.hold, TAKER_RT);
    if (!h || !hh) continue;
    // The harness's time exit needs the full hold window; the house's
    // scan may be shorter because its forward window is clipped by the
    // cache. Skip the comparison when the harness cannot complete.
    if (h.outcome === "time" && hIdx + g.hold >= pb.bars.length) continue;
    n++;
    const d = Math.abs(h.pnlPct - hh.pnlPct);
    diffPnl += d;
    if (h.outcome === hh.outcome) sameKind++;
    if (d < 1e-9) agree++;
    else if (examples.length < 3 && h.outcome !== hh.outcome) {
      firstTouchDiff++;
      examples.push({ pair: r.pair, ts: new Date(r.ts).toISOString(), house: hh.outcome, harness: h.outcome, housePnl: hh.pnlPct, harnessPnl: h.pnlPct });
    }
  }
  totalCmp += n; totalAgree += agree; totalDiffPnl += diffPnl;
  console.log(`\n  TP ${g.tp}% SL ${g.stop}% hold ${g.hold}: ${n} comparable trades`);
  console.log(`     identical OUTCOME and P&L: ${agree} (${(100 * agree / Math.max(1, n)).toFixed(2)}%)`);
  console.log(`     same outcome class (win/loss/time): ${sameKind} (${(100 * sameKind / Math.max(1, n)).toFixed(2)}%)`);
  console.log(`     mean |P&L difference|: ${(100 * diffPnl / Math.max(1, n)).toFixed(4)} percentage points`);
  for (const e of examples) {
    console.log(`       e.g. ${e.pair} @ ${e.ts}: house ${e.house} ${(100 * e.housePnl).toFixed(4)}%  vs  harness ${e.harness} ${(100 * e.harnessPnl).toFixed(4)}%`);
  }
}
console.log(`\n  OVERALL: ${totalAgree}/${totalCmp} identical (${(100 * totalAgree / Math.max(1, totalCmp)).toFixed(2)}%), mean |P&L difference| ${(100 * totalDiffPnl / Math.max(1, totalCmp)).toFixed(4)} pp`);

// ══════════════════════════════════════════════════════════════════════
// THE MATCHED-ANCHOR TEST — the FILL RULE alone
// ══════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(112)}`);
console.log("THE MATCHED-ANCHOR TEST — the fill rule alone, with the same entry and the same scan start");
console.log("═".repeat(112));
console.log("  The house anchors on the collector's live mid-price inside the signal bar; this");
console.log("  harness anchors on the PREVIOUS bar's close (what a bar-driven backtest can know).");
console.log("  That difference is real and is the house's to make. This test gives BOTH the");
console.log("  same entry and the same scan-start bar, so what is left is the FILL RULE.");

for (const g of GEOMS) {
  let n = 0, agree = 0, sameKind = 0, diffPnl = 0, orderOnly = 0;
  const ex = [];
  for (const r of rows) {
    if (!tapeSideFromRow(r)) continue;
    const b = rawBars[r.pair];
    if (!b) continue;
    const i = b.findIndex((x) => x.t > r.ts);
    if (i < 0) continue;
    const pb = pbars[r.pair];
    if (!pb) continue;
    const hIdx = pb.bars.findIndex((x) => x.t === b[i - 1]?.t);
    if (hIdx < 0) continue;
    if (hIdx + g.hold >= pb.bars.length) continue;
    const dir = tapeSideFromRow(r) === "long" ? 1 : -1;
    const entry = pb.bars[hIdx].c;
    const h = harnessTrade(pb, hIdx, dir, g.tp, g.stop, g.hold);
    // the house's scan starts at the bar after the signal bar
    const hh = houseTradeMatched(entry, dir > 0, b, i, Math.min(b.length, i + g.hold), g.tp, g.stop, TAKER_RT);
    if (!h || !hh) continue;
    n++;
    const d = Math.abs(h.pnlPct - hh.pnlPct);
    diffPnl += d;
    if (h.outcome === hh.outcome) sameKind++;
    if (d < 1e-9) agree++;
    else if (ex.length < 3) {
      orderOnly++;
      ex.push({ pair: r.pair, ts: new Date(r.ts).toISOString(), house: hh.outcome, harness: h.outcome, housePnl: hh.pnlPct, harnessPnl: h.pnlPct });
    }
  }
  console.log(`\n  TP ${g.tp}% SL ${g.stop}% hold ${g.hold}: ${n} comparable trades`);
  console.log(`     identical OUTCOME and P&L: ${agree} (${(100 * agree / Math.max(1, n)).toFixed(2)}%)`);
  console.log(`     same outcome class: ${sameKind} (${(100 * sameKind / Math.max(1, n)).toFixed(2)}%)`);
  console.log(`     mean |P&L difference|: ${(100 * diffPnl / Math.max(1, n)).toFixed(4)} percentage points`);
  for (const e of ex) {
    console.log(`       e.g. ${e.pair} @ ${e.ts}: house ${e.house} ${(100 * e.housePnl).toFixed(4)}%  vs  harness ${e.harness} ${(100 * e.harnessPnl).toFixed(4)}%`);
  }
}
console.log("");
