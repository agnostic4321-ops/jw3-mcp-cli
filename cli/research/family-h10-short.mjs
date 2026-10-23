#!/usr/bin/env node
/**
 * THE ONE CELL THAT SURVIVED CLUSTERING — 10:00 UTC SHORT.
 *
 * WHAT THE OTHER SCRIPTS ESTABLISHED
 * ----------------------------------
 * - The hourly profile's t-statistics were UNCLUSTERED (43 symbols in
 *   one hour treated as 43 independent observations). Re-clustered at the
 *   DAY (the honest replication unit for an intraday claim: 13-14
 *   independent days), most of the apparent edges collapsed.
 * - What survived: hour 10:00, where the LONG is worse than the market
 *   at EVERY horizon (-0.337%, -0.894%, -0.177%, -0.068% over 1h, 4h,
 *   8h, 16h) with a day-clustered t of -3.92 at 1 hour. A SHORT at
 *   10:00 is the mirror of that.
 * - The hour-placebo null: the real search's best |t| at the 1-hour
 *   horizon (3.92) sits at the 4.2nd percentile of 2,800 placebo cells.
 *
 * THIS SCRIPT SUBMITS THAT ONE CELL TO THE FULL BAR.
 *
 *   1. The CORRECT fill rule: first touch of TP or the kill; both
 *      touched in the same bar is a LOSS; neither is a TIME EXIT at its
 *      mark. The target is always beyond the market, so no scratch.
 *   2. The CORRECT clustering: the ticket's holding period.
 *   3. The fee: the venue's real 0.12% taker round trip, $0.0720.
 *   4. The placebo: the same times, the same symbols, the same size,
 *      the times destroyed. The real EV must beat the placebo's BEST
 *      cell of the same sweep, not its median.
 *   5. The trim: the worst 3 and the best 3 dropped.
 *   6. The days: the per-day EV, and how many of the 13 days are
 *      positive.
 *   7. The symbols: the per-symbol breakdown, and the top symbol's
 *      share of the net.
 *   8. The mirror: the same times, traded LONG, to show what the short
 *      is actually capturing.
 *
 * AND IT SWEEPS THE GEOMETRY ONE LAST TIME, WIDE, so that the cell's
 * best geometry is not a boundary artefact.
 *
 * READ-ONLY. Local caches only.
 */
import {
  EQUITY, NOTIONAL, RHO, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
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
      gross = kind === "win" ? h.tpFrac : -h.stopFrac;
    } else if (lose) { kind = "loss"; gross = -h.stopFrac; }
    else if (win) { kind = "win"; gross = h.tpFrac; }
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
  const ts = trades.map((t) => t.ts);
  return {
    n: trades.length, clusters: cs.clusters, evUsd: mean(usd), evEq: mean(trades.map((t) => t.pnlEq)),
    t: cs.t, seUsd: stdev(usd) / Math.sqrt(usd.length),
    wins: trades.filter((t) => t.kind === "win").length,
    losses: trades.filter((t) => t.kind === "loss").length,
    times: trades.filter((t) => t.kind === "time").length,
    winRate: trades.filter((t) => t.kind === "win").length / trades.length,
    trimmedUsd: mean(trim(usd, 3)),
    span: [minOf(ts), maxOf(ts)],
  };
}
function perSymbol(trades) {
  const m = new Map();
  for (const t of trades) {
    const e = m.get(t.pair) ?? { pair: t.pair, n: 0, pnl: 0, wins: 0, losses: 0 };
    e.n++; e.pnl += t.pnlUsd; if (t.kind === "win") e.wins++; if (t.kind === "loss") e.losses++;
    m.set(t.pair, e);
  }
  const arr = [...m.values()].sort((a, b) => b.pnl - a.pnl);
  const total = arr.reduce((s, e) => s + e.pnl, 0);
  return { rows: arr, symbols: arr.length, total, top: arr[0] ? { ...arr[0], share: total !== 0 ? (arr[0].pnl / total) * 100 : 0 } : null };
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

console.log("═".repeat(118));
console.log("THE 10:00 UTC SHORT — the one cell that survived the day-clustered test");
console.log("═".repeat(118));
console.log(`  equity $${EQUITY.toFixed(2)}  notional $${NOTIONAL.toFixed(2)}  taker RT ${(TAKER_RT * 100).toFixed(2)}% = $${FEE_USD.toFixed(4)}/trade`);
console.log(`  the fee floor: $${FEE_USD.toFixed(4)}/trade = ${FEE_FLOOR_EQ_PCT.toFixed(5)}% of equity per trade`);

const shortSig = todSignals(10, -1);
const longSig = todSignals(10, 1);
console.log(`  signals: ${shortSig.length} short entries at 10:00 UTC over ${pairs.length} symbols`);

// ── the wide geometry sweep for this cell ──
const TPS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const STOPS = [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const HOLDS = [4, 8, 16, 32, 64, 96];
const cands = [];
for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
  const tr = resolve(shortSig, tpPct, stopPct, hold);
  if (tr.length < 30) continue;
  const s = stats(tr, hold);
  cands.push({ tpPct, stopPct, hold, s, tr });
}
cands.sort((a, b) => b.s.evUsd - a.s.evUsd);
console.log(`\n  ${TPS.length * STOPS.length * HOLDS.length} geometries; the best 10 by net EV per trade:`);
console.log(`  ${"TP%".padStart(5)} ${"SL%".padStart(5)} {"hold".padStart(5)} {"n".padStart(5)} {"clus".padStart(5)} {"EV$".padStart(9)} {"EV%eq".padStart(9)} {"t".padStart(7)} {"win%".padStart(7)} {"trim$".padStart(9)} {"be%".padStart(7)} ${"floor".padStart(6)}`);
for (const c of cands.slice(0, 10)) {
  const s = c.s;
  const be = ((c.stopPct + TAKER_RT * 100) / (c.tpPct + c.stopPct)) * 100;
  console.log(`  ${String(c.tpPct).padStart(5)} ${String(c.stopPct).padStart(5)} ${String(c.hold).padStart(5)} ${String(s.n).padStart(5)} ${String(s.clusters).padStart(5)} ${s.evUsd.toFixed(4).padStart(9)} ${s.evEq.toFixed(4).padStart(9)} ${s.t.toFixed(2).padStart(7)} ${(s.winRate * 100).toFixed(1).padStart(7)} ${s.trimmedUsd.toFixed(4).padStart(9)} ${be.toFixed(1).padStart(7)} ${(s.evUsd > FEE_USD ? "YES" : "no").padStart(6)}`);
}

// ── the full bar on the best geometry ──
const best = cands[0];
const s = best.s;
console.log(`\n${"#".repeat(118)}`);
console.log(`#  THE FULL BAR — 10:00 UTC SHORT, TP ${best.tpPct}% SL ${best.stopPct}% hold ${best.hold} bars (${best.hold * 15 / 60}h)`);
console.log("#".repeat(118));
console.log(`  the sample span: ${new Date(s.span[0]).toISOString().slice(0, 16)} → ${new Date(s.span[1]).toISOString().slice(0, 16)}`);
console.log(`  ${s.n} trades over ${s.clusters} INDEPENDENT CLUSTERS at the ${best.hold}-bar holding period`);
console.log(`  net EV $${s.evUsd.toFixed(4)}/trade  (${s.evEq.toFixed(4)}% of equity)  — the fee floor is $${FEE_USD.toFixed(4)}`);
console.log(`  t ${s.t.toFixed(2)}   win ${(s.winRate * 100).toFixed(1)}%   wins ${s.wins} / losses ${s.losses} / time ${s.times}`);
console.log(`  trimmed (worst 3 and best 3 dropped): $${s.trimmedUsd.toFixed(4)}  ${s.trimmedUsd > FEE_USD ? "STILL ABOVE THE FLOOR" : "BELOW THE FLOOR"}`);

// the placebo: the same sweep on the placebo's times
console.log(`\n  PLACEBO — the same ${TPS.length * STOPS.length * HOLDS.length}-geometry sweep on placebo times:`);
const byPair = new Map();
for (const s2 of shortSig) {
  if (!byPair.has(s2.pair)) byPair.set(s2.pair, []);
  byPair.get(s2.pair).push(s2);
}
const validIdx = new Map();
for (const p of byPair.keys()) {
  const bars = pbars[p].bars; const v = [];
  for (let i = 0; i + best.hold < bars.length; i++) v.push(i);
  validIdx.set(p, v);
}
const DRAW = 200;
const placeboBest = [];
const placeboEv = [];
for (let d = 0; d < DRAW; d++) {
  const rand = mulberry32(20261021 + d * 7919);
  const sh = [];
  for (const [p, list] of byPair) {
    const v = validIdx.get(p); const bars = pbars[p].bars;
    for (const s2 of list) {
      const j = v[Math.floor(rand() * v.length)];
      sh.push({ ...s2, idx: j, ts: bars[j].t, entry: bars[j].c });
    }
  }
  let bb = null;
  for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
    const tr = resolve(sh, tpPct, stopPct, hold);
    if (tr.length < 30) continue;
    const st = stats(tr, hold);
    if (!bb || st.evUsd > bb) bb = st.evUsd;
  }
  if (bb != null) { placeboBest.push(bb); placeboEv.push(bb); }
}
placeboBest.sort((a, b) => a - b);
const pMed = quantile(placeboBest, 0.5), p95 = quantile(placeboBest, 0.95);
const ge = placeboBest.filter((x) => x >= s.evUsd).length;
console.log(`     ${DRAW} draws; the placebo's BEST cell of the sweep: median $${pMed.toFixed(4)}, p95 $${p95.toFixed(4)}, max $${maxOf(placeboBest).toFixed(4)}`);
console.log(`     the real cell $${s.evUsd.toFixed(4)} is at the ${(100 * ge / placeboBest.length).toFixed(1)}th percentile${ge <= placeboBest.length * 0.05 ? " — BEATS the placebo" : " — does NOT beat the placebo"}`);

// the mirror: the same times, long
const mirrorTr = resolve(longSig, best.tpPct, best.stopPct, best.hold);
const ms = stats(mirrorTr, best.hold);
console.log(`\n  MIRROR (the same times, LONG): EV $${ms.evUsd.toFixed(4)}/trade, t ${ms.t.toFixed(2)} — so the short's excess over the long is $${(s.evUsd - ms.evUsd).toFixed(4)}/trade`);

// the per-day replication
const byDay = new Map();
for (const t of best.tr) {
  const d = new Date(t.ts).toISOString().slice(0, 10);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(t);
}
const days = [...byDay.entries()].sort();
const posDays = days.filter(([, v]) => mean(v.map((t) => t.pnlUsd)) > 0).length;
console.log(`\n  PER-DAY REPLICATION (${days.length} independent days): ${posDays} positive`);
console.log(`     ${days.map(([d, v]) => `${d.slice(5)} $${mean(v.map((t) => t.pnlUsd)).toFixed(3)}`).join("  ")}`);
const dayMeans = days.map(([, v]) => mean(v.map((t) => t.pnlUsd)));
const daySe = stdev(dayMeans) / Math.sqrt(dayMeans.length);
console.log(`     the day-level mean $${mean(dayMeans).toFixed(4)}/trade, t ${(mean(dayMeans) / daySe).toFixed(2)}`);

// the per-symbol breakdown
const ps = perSymbol(best.tr);
console.log(`\n  PER-SYMBOL: ${ps.symbols} symbols traded, ${ps.rows.filter((r) => r.pnl > 0).length} positive`);
console.log(`     the TOP symbol is ${ps.top.pair}: $${ps.top.pnl.toFixed(4)} over ${ps.top.n} trades = ${ps.top.share.toFixed(1)}% of the net`);
for (const r of ps.rows.slice(0, 8)) {
  console.log(`        ${r.pair.padEnd(16)} n ${String(r.n).padStart(3)}  net $${r.pnl.toFixed(4).padStart(9)}  win ${(100 * r.wins / r.n).toFixed(0).padStart(3)}%  loss ${(100 * r.losses / r.n).toFixed(0).padStart(3)}%`);
}
const neg = ps.rows.filter((r) => r.pnl < 0);
console.log(`        ${neg.length} of ${ps.rows.length} symbols lost money; the worst ${neg[neg.length - 1]?.pair} at $${neg[neg.length - 1]?.pnl.toFixed(4)}`);

// the bars
console.log(`\n  THE FIVE BARS:`);
const bars = [
  ["net EV above the fee floor", s.evUsd > FEE_USD, `$${s.evUsd.toFixed(4)} vs $${FEE_USD.toFixed(4)}`],
  ["t >= 2 at the holding period", s.t >= 2, `t = ${s.t.toFixed(2)}`],
  ["trim-stable (worst 3, best 3)", s.trimmedUsd > FEE_USD, `$${s.trimmedUsd.toFixed(4)}`],
  ["beats the size-matched placebo", ge <= placeboBest.length * 0.05, `${(100 * ge / placeboBest.length).toFixed(1)}th percentile`],
  ["stable across days", posDays >= Math.ceil(days.length / 2), `${posDays}/${days.length} days positive`],
];
for (const [name, ok, detail] of bars) console.log(`     ${(ok ? "PASS" : "FAIL").padStart(4)}  ${name.padEnd(38)} ${detail}`);
const pass = bars.every((b) => b[1]);
console.log(`\n  VERDICT: ${pass ? "PASSES EVERY BAR" : "does NOT pass every bar"}`);
console.log("");
