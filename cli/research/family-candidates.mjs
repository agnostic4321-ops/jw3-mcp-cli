#!/usr/bin/env node
/**
 * THE CANDIDATES — the cells that survive the sweep, put through the
 * FULL bar with a DRIFT CONTROL.
 *
 * WHY A DRIFT CONTROL IS THE DECIDING TEST HERE
 * ---------------------------------------------
 * After the resolver's sign was fixed, every time-of-day SHORT cell
 * looks profitable, and some of them look very profitable. But the
 * PLACEBO for those cells also produces high numbers, which means a
 * large part of the profit is not about the hour at all: it is the
 * market's own drift over the sample.
 *
 * So each candidate is measured against the UNCONDITIONAL arm: the
 * same geometry, the same symbols, every bar, with no hour filter.
 * The difference is what the HOUR adds. If the difference is zero,
 * the cell is the market wearing a costume.
 *
 * THE BARS, ALL OF THEM
 *   1. net EV above the fee floor ($0.0720/trade)
 *   2. t >= 2 on the cluster means AT THE TICKET'S HOLDING PERIOD
 *   3. trim-stable: the mean survives dropping the worst 3 and best 3
 *   4. a size-matched placebo beside it: the real cell must beat the
 *      placebo's BEST cell of the same sweep
 *   5. the excess over the UNCONDITIONAL arm is positive and
 *      significant
 *   6. per-day replication: the effect is present in most days
 *   7. the HOUSE'S OWN CLUSTER BAR: 30 independent clusters
 *   8. a per-symbol breakdown with the top symbol's share named
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
function idx0(s) { return s.idx; }
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
/** EVERY bar, every symbol, one direction — the unconditional arm. */
function unconditional(dir) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir, entry: bars[i].c });
  }
  return sigs;
}
/** The cross-sectional signals, for the F5 candidates. */
function xsecSignals(mode, minSyms) {
  const rounds = new Map();
  for (const p of pairs) for (const b of pbars[p].bars) {
    if (!rounds.has(b.t)) rounds.set(b.t, []);
    rounds.get(b.t).push({ pair: p, c: b.c });
  }
  const tsS = [...rounds.keys()].sort((a, b) => a - b);
  const idxOf = new Map();
  for (const p of pairs) {
    const m = new Map();
    pbars[p].bars.forEach((b, i) => m.set(b.t, i));
    idxOf.set(p, m);
  }
  const sigs = [];
  for (let r = 1; r < tsS.length; r++) {
    const t = tsS[r], tPrev = tsS[r - 1];
    if (t - tPrev !== BAR_MS) continue;
    const prev = new Map();
    for (const e of rounds.get(tPrev)) prev.set(e.pair, e.c);
    const rows = [];
    for (const e of rounds.get(t)) {
      const pc = prev.get(e.pair);
      if (!(pc > 0) || !(e.c > 0)) continue;
      rows.push({ pair: e.pair, c: e.c, r: (e.c / pc - 1) * 100 });
    }
    if (rows.length < minSyms) continue;
    rows.sort((a, b) => a.r - b.r);
    const loser = rows[0], winner = rows[rows.length - 1];
    const med = rows[Math.floor(rows.length / 2)].r;
    if (mode === "both" || med <= 0) { const i = idxOf.get(loser.pair).get(t); sigs.push({ pair: loser.pair, ts: t, idx: i, dir: 1, entry: loser.c }); }
    if (mode === "both" || med >= 0) { const i = idxOf.get(winner.pair).get(t); sigs.push({ pair: winner.pair, ts: t, idx: i, dir: -1, entry: winner.c }); }
  }
  return sigs;
}

console.log("═".repeat(118));
console.log("THE CANDIDATES — the cells that survived the sweep, against a DRIFT CONTROL");
console.log("═".repeat(118));
console.log(`  equity $${EQUITY.toFixed(2)}  notional $${NOTIONAL.toFixed(2)}  taker RT ${(TAKER_RT * 100).toFixed(2)}% = $${FEE_USD.toFixed(4)}/trade`);
console.log(`  the fee floor: $${FEE_USD.toFixed(4)}/trade = ${FEE_FLOOR_EQ_PCT.toFixed(5)}% of equity per trade`);

// ── first: what does the market itself do? ──
console.log(`\n${"═".repeat(118)}`);
console.log("THE UNCONDITIONAL ARM — every bar, every symbol, one direction. This is the market.");
console.log("═".repeat(118));
console.log(`  ${"geometry".padEnd(26)} {"long EV$".padStart(10)} {"short EV$".padStart(11)} {"market drift (short-long)".padStart(28)}`);
const UNCOND = [];
for (const g of [
  { tp: 4, stop: 0, hold: 16, lbl: "TP 4% SL none hold 16" },
  { tp: 6, stop: 3, hold: 32, lbl: "TP 6% SL 3% hold 32" },
  { tp: 4, stop: 1.5, hold: 96, lbl: "TP 4% SL 1.5% hold 96" },
  { tp: 6, stop: 6, hold: 96, lbl: "TP 6% SL 6% hold 96" },
]) {
  const lt = stats(resolve(unconditional(1), g.tp, g.stop, g.hold), g.hold);
  const st = stats(resolve(unconditional(-1), g.tp, g.stop, g.hold), g.hold);
  UNCOND.push({ g, lt, st });
  console.log(`  ${g.lbl.padEnd(26)} ${lt.evUsd.toFixed(4).padStart(10)} ${st.evUsd.toFixed(4).padStart(11)} ${((st.evUsd - lt.evUsd) >= 0 ? "+" : "") + (st.evUsd - lt.evUsd).toFixed(4) + " (the market's own tilt)".padStart(28)}`);
}

// ── the candidates ──
const CANDIDATES = [
  { name: "F4 06:00 UTC SHORT", sig: () => todSignals(6, -1), geom: { tp: 6, stop: 3, hold: 32 }, uncond: -1 },
  { name: "F4 10:00 UTC SHORT", sig: () => todSignals(10, -1), geom: { tp: 4, stop: 0, hold: 16 }, uncond: -1 },
  { name: "F4 08:00 UTC SHORT", sig: () => todSignals(8, -1), geom: { tp: 4, stop: 1.5, hold: 96 }, uncond: -1 },
  { name: "F4 15:00 UTC SHORT", sig: () => todSignals(15, -1), geom: { tp: 6, stop: 6, hold: 96 }, uncond: -1 },
  { name: "F5 cross-sectional, both, min40", sig: () => xsecSignals("both", 40), geom: { tp: 6, stop: 1.5, hold: 96 }, uncond: -1 },
];

for (const c of CANDIDATES) {
  const sig = c.sig();
  const tr = resolve(sig, c.geom.tp, c.geom.stop, c.geom.hold);
  const s = stats(tr, c.geom.hold);
  if (!s) { console.log(`\n  ${c.name}: NO TRADES`); continue; }
  console.log(`\n${"#".repeat(118)}`);
  console.log(`#  ${c.name}  —  TP ${c.geom.tp}% SL ${c.geom.stop}% hold ${c.geom.hold} bars (${c.geom.hold * 15 / 60}h)`);
  console.log("#".repeat(118));
  console.log(`  the sample span: ${new Date(s.span[0]).toISOString().slice(0, 16)} → ${new Date(s.span[1]).toISOString().slice(0, 16)}`);
  console.log(`  ${s.n} trades over ${s.clusters} INDEPENDENT CLUSTERS at the ${c.geom.hold}-bar holding period`);
  console.log(`  net EV $${s.evUsd.toFixed(4)}/trade (${s.evEq.toFixed(4)}% of equity)   t ${s.t.toFixed(2)}   win ${(s.winRate * 100).toFixed(1)}%   (wins ${s.wins} / losses ${s.losses} / time ${s.times})`);
  console.log(`  trimmed $${s.trimmedUsd.toFixed(4)}`);

  // THE DRIFT CONTROL: the unconditional arm at the same geometry.
  const uc = resolve(unconditional(c.uncond), c.geom.tp, c.geom.stop, c.geom.hold);
  const us = stats(uc, c.geom.hold);
  const drift = s.evUsd - us.evUsd;
  const dse = Math.sqrt(s.seUsd ** 2 + us.seUsd ** 2);
  const dt = dse > 0 ? drift / dse : 0;
  console.log(`  DRIFT CONTROL (unconditional ${c.uncond > 0 ? "long" : "short"}, same geometry): EV $${us.evUsd.toFixed(4)}/trade over ${us.n} trades`);
  console.log(`     the HOUR'S EXCESS over the market's drift: $${drift.toFixed(4)}/trade  (t ${dt.toFixed(2)})`);

  // the placebo: the same sweep on placebo times
  const byPair = new Map();
  for (const s2 of sig) {
    if (!byPair.has(s2.pair)) byPair.set(s2.pair, []);
    byPair.get(s2.pair).push(s2);
  }
  const validIdx = new Map();
  for (const p of byPair.keys()) {
    const bars = pbars[p].bars; const v = [];
    for (let i = 0; i + c.geom.hold < bars.length; i++) v.push(i);
    validIdx.set(p, v);
  }
  const TPS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
  const STOPS = [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
  const HOLDS = [4, 8, 16, 32, 64, 96];
  const placeboBest = [];
  for (let d = 0; d < 200; d++) {
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
      const t2 = resolve(sh, tpPct, stopPct, hold);
      if (t2.length < 30) continue;
      const st2 = stats(t2, hold);
      if (!bb || st2.evUsd > bb) bb = st2.evUsd;
    }
    if (bb != null) placeboBest.push(bb);
  }
  placeboBest.sort((a, b) => a - b);
  const ge = placeboBest.filter((x) => x >= s.evUsd).length;
  console.log(`  PLACEBO (the same 486-geometry sweep, 200 draws, times destroyed): best-of-sweep median $${quantile(placeboBest, 0.5).toFixed(4)}, p95 $${quantile(placeboBest, 0.95).toFixed(4)}, max $${maxOf(placeboBest).toFixed(4)}`);
  console.log(`     the real cell $${s.evUsd.toFixed(4)} is at the ${(100 * ge / placeboBest.length).toFixed(1)}th percentile${ge <= placeboBest.length * 0.05 ? " — BEATS the placebo" : " — does NOT beat the placebo"}`);

  // the per-day replication
  const byDay = new Map();
  for (const t of tr) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const days = [...byDay.entries()].sort();
  const dayMeans = days.map(([, v]) => mean(v.map((t) => t.pnlUsd)));
  const posDays = dayMeans.filter((x) => x > 0).length;
  const daySe = stdev(dayMeans) / Math.sqrt(dayMeans.length);
  console.log(`  PER-DAY (${days.length} independent days): ${posDays} positive; the day-level mean $${mean(dayMeans).toFixed(4)}, t ${(mean(dayMeans) / daySe).toFixed(2)}`);
  console.log(`     ${days.map(([d, v]) => `${d.slice(5)} $${mean(v.map((t) => t.pnlUsd)).toFixed(2)}`).join("  ")}`);

  // the per-symbol breakdown
  const ps = perSymbol(tr);
  console.log(`  PER-SYMBOL: ${ps.symbols} symbols, ${ps.rows.filter((r) => r.pnl > 0).length} positive`);
  console.log(`     the TOP symbol is ${ps.top.pair}: $${ps.top.pnl.toFixed(4)} over ${ps.top.n} trades = ${ps.top.share.toFixed(1)}% of the net`);
  for (const r of ps.rows.slice(0, 5)) {
    console.log(`        ${r.pair.padEnd(16)} n ${String(r.n).padStart(3)}  net $${r.pnl.toFixed(4).padStart(9)}  win ${(100 * r.wins / r.n).toFixed(0).padStart(3)}%`);
  }

  // the bars
  const bars = [
    ["net EV above the fee floor", s.evUsd > FEE_USD, `$${s.evUsd.toFixed(4)} vs $${FEE_USD.toFixed(4)}`],
    ["t >= 2 at the holding period", s.t >= 2, `t = ${s.t.toFixed(2)}`],
    ["trim-stable (worst 3, best 3)", s.trimmedUsd > FEE_USD, `$${s.trimmedUsd.toFixed(4)}`],
    ["beats the size-matched placebo", ge <= placeboBest.length * 0.05, `${(100 * ge / placeboBest.length).toFixed(1)}th pct`],
    ["excess over the unconditional arm", drift > 0 && dt >= 2, `$${drift.toFixed(4)}/trade, t ${dt.toFixed(2)}`],
    ["stable across days", posDays >= Math.ceil(days.length / 2), `${posDays}/${days.length}`],
    ["30 independent clusters (the house bar)", s.clusters >= 30, `${s.clusters}`],
  ];
  console.log(`  THE BARS:`);
  for (const [name, ok, detail] of bars) console.log(`     ${(ok ? "PASS" : "FAIL").padStart(4)}  ${name.padEnd(38)} ${detail}`);
  console.log(`  VERDICT: ${bars.every((b) => b[1]) ? "PASSES EVERY BAR" : "does NOT pass every bar"}`);
}
console.log("");
