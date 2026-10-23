#!/usr/bin/env node
/**
 * THE OUT-OF-SAMPLE VIABILITY CHECK — does ANY ticket geometry clear
 * break-even on this venue, at this fee, on real 15-minute bars?
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * The geometry study measures the MACHINE'S OWN SIGNAL against the
 * unconditional tape. That is the right question for "is there an edge".
 * But the machine will trade the signal whether or not it has an edge, so
 * the decision-grade question is different:
 *
 *   ON THIS ACCOUNT, WITH THIS FEE, IS THE TICKET NET-POSITIVE AT ALL?
 *
 * If the answer is no, then NO universe change can fix it — a different
 * symbol set produces the same bleed. That is the answer that decides
 * whether the machine should trade, and it has to be measured on the
 * VENUE'S OWN RESOLUTION (15-minute bars), not on a 1-hour proxy.
 *
 * ── WHAT IT MEASURES ──
 *
 * For each (TP, SL) geometry, on both sides:
 *   - every 15-minute bar of the 3-day cache is an entry
 *   - walk the next 16 bars (4 hours): which level is touched first?
 *   - a bar touching BOTH is a LOSS (the conservative tie handling)
 *   - neither level touched -> the trade is closed at the mark (the live
 *     path has a time exit), booked at the mark-to-market
 *   - the fee is charged on the notional: 0.08% (maker 0.02 entry +
 *     taker 0.06 exit — the live path's own schedule)
 *
 * The win rate is then compared to the break-even win rate, and the net
 * expectancy per trade is reported in % of notional and in % of equity.
 *
 * ── THE BREAK-EVEN ──
 *
 *   wBE = (sl + f) / (tp + sl + f)
 *
 * This ALREADY includes the fee, so the comparison "w > wBE" IS the
 * profitability test. There is no second fee to subtract.
 *
 * USAGE
 *   node research/viability-oos.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BARS = flag("bars", join(HOME, ".hermes/cache/scratch/screen-universe-bars.snapshot.json"));

const FEE_LIVE = 0.08; // % of notional, round trip: maker entry + taker exit
const FEE_TAKER = 0.12;
const FEE_MAKER = 0.04;
const EQUITY = 57.16;
const NOTIONAL_CAP = 60.0;
const MAX_HOLD = 16; // 4 hours at 15-minute bars
const notionalOverEquity = NOTIONAL_CAP / EQUITY;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const BARS_RAW = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};
const SYMS = Object.keys(BARS_RAW);
if (!SYMS.length) {
  console.error(`[oos] no bars at ${BARS} — run the geometry study first`);
  process.exit(1);
}

/** Simulate one geometry on one side over EVERY entry bar. */
function sim(dir, tp, sl, fee) {
  let win = 0, lose = 0, time = 0, amb = 0;
  const pnl = [];
  for (const sym of SYMS) {
    const b = BARS_RAW[sym];
    for (let i = 1; i < b.length - MAX_HOLD; i++) {
      const e = b[i].c;
      const tpP = dir === "long" ? e * (1 + tp / 100) : e * (1 - tp / 100);
      const slP = dir === "long" ? e * (1 - sl / 100) : e * (1 + sl / 100);
      let res = null;
      for (let j = i + 1; j < Math.min(b.length, i + 1 + MAX_HOLD); j++) {
        const hTp = dir === "long" ? b[j].h >= tpP : b[j].l <= tpP;
        const hSl = dir === "long" ? b[j].l <= slP : b[j].h >= slP;
        if (hTp && hSl) { res = "loss"; amb++; break; }
        if (hTp) { res = "win"; break; }
        if (hSl) { res = "loss"; break; }
      }
      if (res === "win") { win++; pnl.push(tp); }
      else if (res === "loss") { lose++; pnl.push(-sl); }
      else {
        time++;
        const lb = b[Math.min(b.length - 1, i + MAX_HOLD)];
        pnl.push(dir === "long" ? ((lb.c - e) / e) * 100 : ((e - lb.c) / e) * 100);
      }
    }
  }
  const n = win + lose;
  const w = n ? win / n : 0;
  const gross = mean(pnl);
  return { n, w, gross, net: gross - fee, time, amb, win, lose };
}

console.log("=".repeat(104));
console.log("THE OUT-OF-SAMPLE VIABILITY CHECK — real 15-minute bars, every entry, both sides");
console.log("=".repeat(104));
console.log(`  bars: ${SYMS.length} symbols from ${BARS.split("/").pop()}`);
console.log(`  equity $${EQUITY} | notional cap $${NOTIONAL_CAP} | notional/equity ${notionalOverEquity.toFixed(4)}x`);
console.log(`  fee: LIVE ${FEE_LIVE}% of notional (maker 0.02 entry + taker 0.06 exit)`);
console.log(`  hold: 4 hours (${MAX_HOLD} x 15-min bars); a bar touching both levels is a LOSS`);
console.log();

const TPS = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5];
const SLS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];

console.log("  THE FULL GRID — net expectancy per trade, % of NOTIONAL, at the live fee");
console.log("  rows = TP, cols = SL; a POSITIVE cell is a geometry that pays for itself");
console.log();
console.log("  LONG side:");
console.log("        SL:" + SLS.map((s) => `${s.toFixed(1)}`.padStart(8)).join(""));
const gridLong = [];
for (const tp of TPS) {
  const cells = [];
  for (const sl of SLS) {
    if (sl <= tp) { cells.push("       -"); continue; }
    const r = sim("long", tp, sl, FEE_LIVE);
    gridLong.push({ tp, sl, ...r });
    cells.push((r.net >= 0 ? "+" : "") + r.net.toFixed(3).padStart(7));
  }
  console.log(`  TP ${tp.toFixed(2)} ${cells.join("")}`);
}
console.log();
console.log("  SHORT side:");
console.log("        SL:" + SLS.map((s) => `${s.toFixed(1)}`.padStart(8)).join(""));
const gridShort = [];
for (const tp of TPS) {
  const cells = [];
  for (const sl of SLS) {
    if (sl <= tp) { cells.push("       -"); continue; }
    const r = sim("short", tp, sl, FEE_LIVE);
    gridShort.push({ tp, sl, ...r });
    cells.push((r.net >= 0 ? "+" : "") + r.net.toFixed(3).padStart(7));
  }
  console.log(`  TP ${tp.toFixed(2)} ${cells.join("")}`);
}

const all = [...gridLong, ...gridShort];
const viable = all.filter((r) => r.net > 0);
const best = [...all].sort((a, b) => b.net - a.net)[0];
console.log();
console.log("=".repeat(104));
console.log("THE VERDICT");
console.log("=".repeat(104));
console.log(`  geometries tested: ${all.length} (${gridLong.length} long, ${gridShort.length} short)`);
console.log(`  geometries NET-POSITIVE after the ${FEE_LIVE}% live fee: ${viable.length}`);
console.log(`  the best geometry found: ${best.tp}% TP / ${best.sl}% SL, net ${best.net.toFixed(4)}% of notional`);
console.log(`    win rate ${(best.w * 100).toFixed(1)}%  break-even ${(((best.sl + FEE_LIVE) / (best.tp + best.sl + FEE_LIVE)) * 100).toFixed(1)}%`);
console.log(`    on $${EQUITY} equity at $${NOTIONAL_CAP} notional: $${((best.net / 100) * NOTIONAL_CAP).toFixed(4)} per trade`);
console.log();
console.log("  AT MAKER-MAKER FEES (0.04%) — the best case if every leg filled passively:");
let bestMaker = null;
for (const tp of TPS) for (const sl of SLS) {
  if (sl <= tp) continue;
  for (const dir of ["long", "short"]) {
    const r = sim(dir, tp, sl, FEE_MAKER);
    if (!bestMaker || r.net > bestMaker.net) bestMaker = { tp, sl, dir, ...r };
  }
}
const viableMaker = [];
for (const tp of TPS) for (const sl of SLS) {
  if (sl <= tp) continue;
  for (const dir of ["long", "short"]) {
    const r = sim(dir, tp, sl, FEE_MAKER);
    if (r.net > 0) viableMaker.push({ tp, sl, dir, ...r });
  }
}
console.log(`    geometries net-positive at maker fees: ${viableMaker.length}`);
if (bestMaker) {
  console.log(`    the best: ${bestMaker.dir.toUpperCase()} ${bestMaker.tp}%/${bestMaker.sl}%  net ${bestMaker.net.toFixed(4)}%  win ${(bestMaker.w * 100).toFixed(1)}%`);
}
console.log();
console.log("  AT TAKER-TAKER FEES (0.12%) — the pessimistic case:");
let viableTaker = 0;
for (const tp of TPS) for (const sl of SLS) {
  if (sl <= tp) continue;
  for (const dir of ["long", "short"]) {
    const r = sim(dir, tp, sl, FEE_TAKER);
    if (r.net > 0) viableTaker++;
  }
}
console.log(`    geometries net-positive: ${viableTaker}`);
console.log();
console.log("  WHAT THIS MEANS FOR THE UNIVERSE QUESTION:");
console.log("  A universe screen can only choose WHICH SYMBOLS to trade. It cannot change");
console.log("  the fee, the resolution, or the fact that the price random-walks across the");
console.log("  ticket's own levels. If NO geometry is net-positive on the bare market, then");
console.log("  NO symbol subset can be: the best subset is the one that loses least, and the");
console.log("  loss is the market's, not the symbol's.");
console.log("  The screen therefore has a clear job: it must find the symbols whose");
console.log("  TICKET is the LEAST unprofitable, and it must say that the machine is trading");
console.log("  a negative-expectancy ticket, not a good universe with a bad trade.");
