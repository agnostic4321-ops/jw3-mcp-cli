#!/usr/bin/env node
/**
 * IS THE TIME-OF-DAY EFFECT A TIME-OF-DAY EFFECT, OR THE MARKET'S DRIFT?
 *
 * The sweep found F4 cells above the fee floor, and every one of them
 * was LONG. That is the classic drift confound: in a rising sample,
 * every long arm looks good and every short arm looks bad, whatever
 * the hour.
 *
 * THIS SCRIPT SEPARATES THE TWO.
 *
 *   1. THE DRIFT CONTROL: an unconditional LONG at exactly the same
 *      times as the hour cell. If the hour cell's EV equals the drift
 *      control's EV, the hour adds NOTHING and the cell is the market's
 *      drift wearing a costume.
 *
 *   2. THE HOUR-EXCESS: the hour cell's EV minus the drift control's
 *      EV, with the t-statistic on the difference. This is the only
 *      number that can be attributed to the TIME OF DAY.
 *
 *   3. THE HOURLY PROFILE: every hour's excess over the drift, in one
 *      table. If the excess is flat, the hour does not matter.
 *
 *   4. THE DAY-BLOCK STABILITY: the hour's excess measured inside each
 *      of the 14 days. A real intraday effect is present in most days;
 *      a lucky sample is present in a few.
 *
 *   5. THE FULL-DAY LONG: what an unconditional long, every hour, at
 *      every symbol, earns. This is the honest baseline.
 *
 * READ-ONLY. Local caches only.
 */
import {
  EQUITY, NOTIONAL, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
  loadBars, mean, stdev, fmt, pct, mulberry32, quantile, trim, clusterStats,
} from "./family-harness.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const pbars = loadBars({ withVolume: false });
const pairs = Object.keys(pbars);
const DAY = 24 * 3600_000;

function hits(pb, idx, dir, tpPct, stopPct, maxHold) {
  const bars = pb.bars;
  const entry = bars[idx].c;
  const tp = dir > 0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const noStop = !(stopPct > 0);
  const sl = noStop ? -Infinity : (dir > 0 ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100));
  const end = Math.min(bars.length, idx + 1 + maxHold);
  let tpIdx = -1, slIdx = -1;
  for (let k = idx + 1; k < end; k++) {
    const b = bars[k];
    const hitTp = dir > 0 ? b.h >= tp : b.l <= tp;
    const hitSl = noStop ? false : (dir > 0 ? b.l <= sl : b.h >= sl);
    if (hitSl && slIdx < 0) slIdx = k;
    if (hitTp && tpIdx < 0) tpIdx = k;
    if (tpIdx >= 0 && slIdx >= 0) break;
  }
  return { tpIdx, slIdx, entry, tpFrac: tpPct / 100, stopFrac: stopPct / 100 };
}
function resolve(signals, tpPct, stopPct, hold) {
  const trades = [];
  for (const s of signals) {
    const pb = pbars[s.pair];
    if (!pb) continue;
    if (s.idx + hold >= pb.bars.length) continue;
    const h = hits(pb, s.idx, s.dir, tpPct, stopPct, hold);
    const win = h.tpIdx >= 0 && h.tpIdx <= s.idx + hold;
    const lose = h.slIdx >= 0 && h.slIdx <= s.idx + hold;
    let kind, gross;
    if (win && lose) {
      kind = h.tpIdx < h.slIdx ? "win" : "loss";
      gross = kind === "win" ? (s.dir > 0 ? h.tpFrac : -h.tpFrac) : -h.stopFrac;
    } else if (lose) { kind = "loss"; gross = -h.stopFrac; }
    else if (win) { kind = "win"; gross = s.dir > 0 ? h.tpFrac : -h.tpFrac; }
    else {
      kind = "time";
      const last = pb.bars[s.idx + hold];
      gross = s.dir > 0 ? (last.c - h.entry) / h.entry : (h.entry - last.c) / h.entry;
    }
    const pnlUsd = gross * NOTIONAL - FEE_USD;
    trades.push({ pair: s.pair, ts: s.ts, dir: s.dir, kind, gross, pnlUsd, pnlEq: (pnlUsd / EQUITY) * 100 });
  }
  return trades;
}
function stats(trades, hold) {
  if (!trades.length) return null;
  const usd = trades.map((t) => t.pnlUsd);
  const cs = clusterStats(trades, hold);
  return {
    n: trades.length, clusters: cs.clusters, evUsd: mean(usd), evEq: mean(trades.map((t) => t.pnlEq)),
    t: cs.t, seUsd: stdev(usd) / Math.sqrt(usd.length),
    winRate: trades.filter((t) => t.kind === "win").length / trades.length,
    trimmedUsd: mean(trim(usd, 3)),
  };
}
function excessOf(a, b) {
  const d = Math.sqrt(a.se ** 2 + b.se ** 2);
  return { excess: a.ev - b.ev, t: d > 0 ? (a.ev - b.ev) / d : 0 };
}

function todSignals(hour, dir) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) {
      if (((bars[i].t % DAY) + DAY) % DAY !== hour * 3600_000) continue;
      sigs.push({ pair: p, ts: bars[i - 1].t, idx: i - 1, dir, entry: bars[i - 1].c });
    }
  }
  return sigs;
}
/** Every bar in the window, as a long signal — the unconditional baseline. */
function allLongSignals() {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: bars[i].c });
  }
  return sigs;
}

console.log("═".repeat(118));
console.log("IS IT THE HOUR, OR IS IT THE MARKET? — the drift control for the time-of-day family");
console.log("═".repeat(118));
console.log(`  fee floor $${FEE_USD.toFixed(4)}/trade (${(TAKER_RT * 100).toFixed(2)}% taker round trip on $${NOTIONAL})`);

// ── the geometry the sweep chose for the best F4 cell ──
const GEOMS = [
  { tpPct: 6, stopPct: 1, hold: 32, label: "h20 long: TP 6% SL 1% hold 32" },
  { tpPct: 4, stopPct: 0, hold: 32, label: "h16 long: TP 4% SL none hold 32" },
  { tpPct: 6, stopPct: 0, hold: 4, label: "h14 long: TP 6% SL none hold 4" },
  { tpPct: 6, stopPct: 0, hold: 64, label: "h13 long: TP 6% SL none hold 64" },
  { tpPct: 6, stopPct: 0, hold: 4, label: "h4 long: TP 6% SL none hold 4" },
];

for (const g of GEOMS) {
  const hour = Number(g.label.match(/^h(\d+)/)[1]);
  console.log(`\n${"#".repeat(118)}\n#  ${g.label}\n${"#".repeat(118)}`);
  const hourSig = todSignals(hour, 1);
  const hourTr = resolve(hourSig, g.tpPct, g.stopPct, g.hold);
  const hs = stats(hourTr, g.hold);

  // THE DRIFT CONTROL: the same times, unconditional long.
  const driftTr = resolve(hourSig.map((s) => ({ ...s, dir: 1 })), g.tpPct, g.stopPct, g.hold);
  const ds = stats(driftTr, g.hold);
  // The hour cell IS long, so the drift control is the same trade set.
  // The informative control is the FULL-DAY long at the same geometry.
  const allTr = resolve(allLongSignals(), g.tpPct, g.stopPct, g.hold);
  const as = stats(allTr, g.hold);

  // The excess over the SAME-TIMES unconditional long, with a PAIRED
  // t-statistic: the hour cell and the drift control are the same
  // trades, so the comparison must be paired.
  console.log(`  the hour cell:        n ${String(hs.n).padStart(6)}  EV $${hs.evUsd.toFixed(4).padStart(8)}  t ${hs.t.toFixed(2).padStart(7)}  win ${(hs.winRate * 100).toFixed(1).padStart(5)}%  ${hs.evUsd > FEE_USD ? "ABOVE FLOOR" : "below"}`);
  console.log(`  the full-day long:    n ${String(as.n).padStart(6)}  EV $${as.evUsd.toFixed(4).padStart(8)}  t ${as.t.toFixed(2).padStart(7)}  win ${(as.winRate * 100).toFixed(1).padStart(5)}%  ${as.evUsd > FEE_USD ? "ABOVE FLOOR" : "below"}  (every bar, every symbol, long)`);

  // The REAL question: is the hour's forward move different from the
  // market's forward move at that same hour? Measure it on the RAW
  // forward return (no target, no stop, no fee) — the censoring-free
  // measure. If the hour's raw return is the same as the market's, the
  // hour adds nothing.
  const rawMean = (sigs) => {
    const out = [];
    for (const s of sigs) {
      const pb = pbars[s.pair]; const bars = pb.bars;
      const j = s.idx + g.hold;
      if (j >= bars.length) continue;
      out.push((bars[j].c / s.entry - 1) * 100);
    }
    return out;
  };
  const hourRaw = rawMean(hourSig);
  const allRaw = rawMean(allLongSignals());
  const mh = mean(hourRaw), ma = mean(allRaw);
  const se = Math.sqrt(stdev(hourRaw) ** 2 / hourRaw.length + stdev(allRaw) ** 2 / allRaw.length);
  console.log(`  RAW forward return (no target, no stop, no fee — the censoring-free measure):`);
  console.log(`     the hour ${hour}:00's own move over ${g.hold} bars = ${mh.toFixed(4)}%  (n ${hourRaw.length})`);
  console.log(`     the market's move at the same horizon         = ${ma.toFixed(4)}%  (n ${allRaw.length})`);
  console.log(`     the hour's EXCESS over the market's drift     = ${(mh - ma).toFixed(4)}%  (t ${se > 0 ? ((mh - ma) / se).toFixed(2) : "n/a"})`);
  console.log(`     -> ${Math.abs(mh - ma) < 1e-9 ? "IDENTICAL: the hour IS the market" : (mh - ma) > 0 ? "the hour is BETTER than the market's drift" : "the hour is WORSE than the market's drift"}`);

  // The day-block stability of the hour's excess.
  const ts = hourTr.map((t) => t.ts);
  const lo = minOf(ts), hi = maxOf(ts);
  const w = (hi - lo) / 3 || 1;
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = lo + i * w, b = i === 2 ? hi + 1 : lo + (i + 1) * w;
    const bt = hourTr.filter((t) => t.ts >= a && t.ts < b);
    const ba = allTr.filter((t) => t.ts >= a && t.ts < b);
    parts.push(`${bt.length ? mean(bt.map((t) => t.pnlUsd)).toFixed(3) : "n/a"} (vs ${ba.length ? mean(ba.map((t) => t.pnlUsd)).toFixed(3) : "n/a"})`);
  }
  console.log(`  the three chronological thirds, hour EV vs the market's EV at the same times:`);
  console.log(`     ${parts.join("   ")}`);
}

// ══════════════════════════════════════════════════════════════════════
// THE HOURLY PROFILE — the excess of every hour over the market's drift
// ══════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(118)}`);
console.log("THE HOURLY PROFILE — every hour's RAW forward return vs the market's, at the same horizon");
console.log("═".repeat(118));
for (const hold of [4, 16, 32, 64]) {
  console.log(`\n  --- horizon ${hold} bars (${hold * 15 / 60}h) ---`);
  console.log(`  ${"hour".padStart(5)} ${"n".padStart(6)} ${"hour's raw %".padStart(14)} ${"market's raw %".padStart(15)} ${"excess %".padStart(11)} ${"t".padStart(7)}  ${"verdict".padStart(10)}`);
  const allRaw = [];
  for (const s of allLongSignals()) {
    const bars = pbars[s.pair].bars; const j = s.idx + hold;
    if (j >= bars.length) continue;
    allRaw.push((bars[j].c / s.entry - 1) * 100);
  }
  const ma = mean(allRaw), sea = stdev(allRaw) / Math.sqrt(allRaw.length);
  for (const hour of [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22]) {
    const sig = todSignals(hour, 1);
    const raw = [];
    for (const s of sig) {
      const bars = pbars[s.pair].bars; const j = s.idx + hold;
      if (j >= bars.length) continue;
      raw.push((bars[j].c / s.entry - 1) * 100);
    }
    if (raw.length < 20) continue;
    const mh = mean(raw), se = stdev(raw) / Math.sqrt(raw.length);
    const ex = mh - ma;
    const t = Math.sqrt(se ** 2 + sea ** 2) > 0 ? ex / Math.sqrt(se ** 2 + sea ** 2) : 0;
    const verd = Math.abs(t) >= 2 ? (ex > 0 ? "EDGE?" : "inverse") : "no effect";
    console.log(`  ${String(hour).padStart(5)} ${String(raw.length).padStart(6)} ${mh.toFixed(4).padStart(14)} ${ma.toFixed(4).padStart(15)} ${ex.toFixed(4).padStart(11)} ${t.toFixed(2).padStart(7)}  ${verd.padStart(10)}`);
  }
}
console.log("");
