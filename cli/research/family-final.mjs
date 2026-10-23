#!/usr/bin/env node
/**
 * THE FINAL REPORT — the five families, measured with the corrected
 * fill rule and the corrected clustering, and the verdict.
 *
 * THE TWO CORRECTIONS THIS INSTRUMENT MAKES
 * -----------------------------------------
 * 1. THE FILL RULE. First touch of the target or the kill wins. A bar
 *    that touches BOTH is a LOSS. A trade that touches neither is a
 *    TIME EXIT at the mark of the last bar of the hold. The target is
 *    always beyond the market, so the scratch artefact is impossible by
 *    construction.
 *    (The resolver's sign was audited by research/family-resolver-test.mjs
 *    — 11 checks, all passing. An earlier version of this harness booked
 *    a SHORT's win as a loss; that bug is fixed, and the unit test is
 *    the reason it cannot come back.)
 *
 * 2. THE CLUSTERING. The t-statistic is computed on cluster means at
 *    the TICKET'S OWN HOLDING PERIOD (hold x 15 minutes), never on the
 *    collector's 5-minute round.
 *
 * THE FEE
 * -------
 * The venue's real taker round trip: 0.12% of notional
 * (src/kucoin.ts: SCALP_TAKER_FEE_PCT = 0.06 per side), which is
 * $0.0720 on a $60 ticket against a $56.89 equity. THE FEE FLOOR is
 * $0.0720 per trade.
 *
 * THE BARS A CANDIDATE MUST CLEAR
 * -------------------------------
 *   - net EV above the fee floor
 *   - t >= 2 on the cluster means at the holding period
 *   - trim-stable (the worst 3 and the best 3 dropped)
 *   - a size-matched placebo beside it: the real cell must beat the
 *     placebo's BEST cell of the SAME sweep (the multiple-testing null)
 *   - the excess over the UNCONDITIONAL arm is positive
 *   - stable across the independent days
 *   - the house's own bar: 30 independent clusters
 *
 * THE CROSS-SECTIONAL FAMILY IS MEASURED TWO WAYS
 * -----------------------------------------------
 * (a) LEG BY LEG: each leg as its own trade, one fee each.
 * (b) AS A MARKET-NEUTRAL PAIR: the long leg and the short leg of the
 *     SAME round are netted against each other, and BOTH legs' fees are
 *     charged ($0.1440 round trip). This is the honest form of a
 *     market-neutral setup, and it is what the family actually is.
 *
 * READ-ONLY. Local caches and the keyless public kline API only.
 * No account calls, no venue calls, no orders.
 */
import {
  EQUITY, NOTIONAL, RHO, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
  loadBars, mean, stdev, fmt, pct, mulberry32, quantile, trim, clusterStats,
} from "./family-harness.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const pbars = loadBars({ withVolume: true });
const pairs = Object.keys(pbars);
const DAY = 24 * 3600_000;
const TPS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const STOPS = [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const HOLDS = [4, 8, 16, 32, 64, 96];

// ══════════════════════════════════════════════════════════════════════
// THE RESOLVER
// ══════════════════════════════════════════════════════════════════════
function hits(pb, idx, dir, tpPct, stopPct) {
  const bars = pb.bars;
  const entry = bars[idx].c;
  const tp = dir > 0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const noStop = !(stopPct > 0);
  const sl = noStop ? -Infinity : (dir > 0 ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100));
  const end = Math.min(bars.length, idx + 1 + maxOf(HOLDS));
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
    if (s.idx + hold >= pb.bars.length) continue;   // strict censoring
    const h = hits(pb, s.idx, s.dir, tpPct, stopPct);
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
    trades.push({ pair: s.pair, ts: s.ts, dir: s.dir, kind, gross, pnlUsd, pnlEq: (pnlUsd / EQUITY) * 100, meta: s.meta ?? null });
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
    const e = m.get(t.pair) ?? { pair: t.pair, n: 0, pnl: 0, wins: 0 };
    e.n++; e.pnl += t.pnlUsd; if (t.kind === "win") e.wins++;
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
function unconditional(dir) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir, entry: bars[i].c });
  }
  return sigs;
}
function xsecRounds(minSyms) {
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
  const out = [];
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
    out.push({
      t,
      loser: { pair: loser.pair, idx: idxOf.get(loser.pair).get(t), c: loser.c, r: loser.r },
      winner: { pair: winner.pair, idx: idxOf.get(winner.pair).get(t), c: winner.c, r: winner.r },
      med, n: rows.length,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// THE FIVE FAMILIES' SIGNAL SETS
// ══════════════════════════════════════════════════════════════════════
function genF1(lookback, volMult) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = lookback + 50; i < bars.length; i++) {
      const v = bars[i].v; if (v == null) continue;
      let pv = 0, pvN = 0, hi = -Infinity, lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (bars[k].h > hi) hi = bars[k].h;
        if (bars[k].l < lo) lo = bars[k].l;
        if (bars[k].v != null) { pv += bars[k].v; pvN++; }
      }
      if (!pvN) continue;
      const vma = pv / pvN; if (!(vma > 0)) continue;
      if (v < volMult * vma) continue;
      const c = bars[i].c;
      if (c > hi) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: c });
      else if (c < lo) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: -1, entry: c });
    }
  }
  return sigs;
}
function genF2(xPct) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 60; i < bars.length; i++) {
      const prev = bars[i - 1].c; if (!(prev > 0)) continue;
      const m = (bars[i].c / prev - 1) * 100;
      if (m >= xPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: bars[i].c });
      else if (m <= -xPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: -1, entry: bars[i].c });
    }
  }
  return sigs;
}
function genF3(dropPct, lookback) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = lookback + 10; i < bars.length; i++) {
      let hi = -Infinity;
      for (let k = i - lookback + 1; k <= i; k++) if (bars[k].h > hi) hi = bars[k].h;
      const c = bars[i].c; if (!(hi > 0)) continue;
      if ((hi - c) / hi * 100 >= dropPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: c });
    }
  }
  return sigs;
}

// ══════════════════════════════════════════════════════════════════════
// THE SWEEP
// ══════════════════════════════════════════════════════════════════════
console.log("═".repeat(120));
console.log("THE FIVE FAMILIES — the final measurement");
console.log("═".repeat(120));
console.log(`  equity $${EQUITY.toFixed(2)}   notional $${NOTIONAL.toFixed(2)}   taker round trip ${(TAKER_RT * 100).toFixed(2)}% = $${FEE_USD.toFixed(4)}/trade`);
console.log(`  THE FEE FLOOR: $${FEE_USD.toFixed(4)} per trade = ${FEE_FLOOR_EQ_PCT.toFixed(5)}% of equity per trade`);
console.log(`  the bar cache: ${pairs.length} pairs, ${pbars[pairs[0]].bars.length} 15-minute bars each`);
console.log(`  the grid: ${TPS.length} targets x ${STOPS.length} stops x ${HOLDS.length} holds = ${TPS.length * STOPS.length * HOLDS.length} geometries per cell`);

const CELLS = [];
// F1
for (const lb of [4, 8, 16]) for (const vm of [1.0, 1.5, 2.0]) CELLS.push({ fam: "F1 BREAKOUT", name: `new ${lb}-bar high, volume x${vm}`, sig: () => genF1(lb, vm), uncond: 1 });
// F2
for (const x of [0.3, 0.5, 0.75, 1.0, 1.5]) CELLS.push({ fam: "F2 MOMENTUM", name: `15-min move >= ${x}%`, sig: () => genF2(x), uncond: 1 });
// F3
for (const d of [0.5, 1.0, 1.5, 2.0, 3.0]) for (const lb of [32, 96, 192]) CELLS.push({ fam: "F3 MEAN-REV", name: `drop >= ${d}% from the ${lb}-bar high`, sig: () => genF3(d, lb), uncond: 1 });
// F4
for (const h of [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22]) for (const d of [1, -1]) {
  CELLS.push({ fam: "F4 TIME-OF-DAY", name: `${String(h).padStart(2, "0")}:00 UTC ${d > 0 ? "LONG" : "SHORT"}`, sig: () => todSignals(h, d), uncond: d });
}

const results = [];
for (const cell of CELLS) {
  const sig = cell.sig();
  if (!sig.length || sig.length < 30) continue;
  let best = null;
  for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
    const tr = resolve(sig, tpPct, stopPct, hold);
    if (tr.length < 30) continue;
    const s = stats(tr, hold);
    if (!best || s.evUsd > best.s.evUsd) best = { tpPct, stopPct, hold, s, tr };
  }
  if (!best) continue;
  results.push({ ...cell, ...best });
}

// ── F5, leg by leg and as a market-neutral pair ──
const F5ROUNDS = xsecRounds(40);
const f5Legs = [];
for (const r of F5ROUNDS) {
  f5Legs.push({ pair: r.loser.pair, ts: r.t, idx: r.loser.idx, dir: 1, entry: r.loser.c });
  f5Legs.push({ pair: r.winner.pair, ts: r.t, idx: r.winner.idx, dir: -1, entry: r.winner.c });
}
let f5Best = null;
for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
  const tr = resolve(f5Legs, tpPct, stopPct, hold);
  if (tr.length < 30) continue;
  const s = stats(tr, hold);
  if (!f5Best || s.evUsd > f5Best.s.evUsd) f5Best = { tpPct, stopPct, hold, s, tr };
}
results.push({ fam: "F5 X-SECT", name: "rank the universe, trade the extreme (legs)", sig: () => f5Legs, uncond: -1, ...f5Best });

// the market-neutral pair: the two legs netted, BOTH fees charged
function f5PairBest() {
  let best = null;
  for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
    const longs = resolve(f5Legs.filter((s) => s.dir > 0), tpPct, stopPct, hold);
    const shorts = resolve(f5Legs.filter((s) => s.dir < 0), tpPct, stopPct, hold);
    // pair by round
    const lBy = new Map(longs.map((t) => [t.ts, t]));
    const sBy = new Map(shorts.map((t) => [t.ts, t]));
    const pairTrades = [];
    for (const [ts, l] of lBy) {
      const s = sBy.get(ts);
      if (!s) continue;
      // the pair's net: the long leg's gross minus the short leg's gross,
      // with BOTH fees charged (the fee floor for a pair is $0.1440)
      const gross = l.gross + s.gross;
      const pnlUsd = gross * NOTIONAL - 2 * FEE_USD;
      pairTrades.push({ pair: `${l.pair}/${s.pair}`, ts, dir: 0, kind: "pair", gross, pnlUsd, pnlEq: (pnlUsd / EQUITY) * 100 });
    }
    if (pairTrades.length < 30) continue;
    const s = stats(pairTrades, hold);
    if (!best || s.evUsd > best.s.evUsd) best = { tpPct, stopPct, hold, s, tr: pairTrades };
  }
  return best;
}
const f5Pair = f5PairBest();

// ══════════════════════════════════════════════════════════════════════
// THE REPORT
// ══════════════════════════════════════════════════════════════════════
console.log(`\n${"#".repeat(120)}`);
console.log(`#  EVERY CELL'S BEST GEOMETRY — ${results.length} cells x ${TPS.length * STOPS.length * HOLDS.length} geometries`);
console.log("#".repeat(120));
console.log(`  ${"family".padEnd(16)} ${"cell".padEnd(36)} ${"TP".padStart(5)} ${"SL".padStart(5)} {"hold".padStart(4)} ${"n".padStart(5)} ${"clus".padStart(4)} ${"EV$".padStart(8)} ${"t".padStart(7)} ${"win%".padStart(6)} ${"trim$".padStart(8)} ${"floor".padStart(6)}`);
for (const r of results) {
  const s = r.s;
  console.log(`  ${r.fam.padEnd(16)} ${r.name.slice(0, 36).padEnd(36)} ${String(r.tpPct).padStart(5)} ${String(r.stopPct).padStart(5)} ${String(r.hold).padStart(4)} ${String(s.n).padStart(5)} ${String(s.clusters).padStart(4)} ${s.evUsd.toFixed(4).padStart(8)} ${s.t.toFixed(2).padStart(7)} ${(s.winRate * 100).toFixed(1).padStart(6)} ${s.trimmedUsd.toFixed(4).padStart(8)} ${(s.evUsd > FEE_USD ? "YES" : "no").padStart(6)}`);
}

// the per-family best
console.log(`\n${"═".repeat(120)}`);
console.log("THE FIVE FAMILIES — the best cell of each, in dollars");
console.log("═".repeat(120));
const fams = [...new Set(results.map((r) => r.fam))];
const famBest = fams.map((f) => ({ f, r: results.filter((x) => x.fam === f).sort((a, b) => b.s.evUsd - a.s.evUsd)[0] }));
for (const { f, r } of famBest) {
  const s = r.s;
  console.log(`  ${f.padEnd(16)} ${r.name.slice(0, 34).padEnd(34)}  TP ${String(r.tpPct).padStart(4)}%  SL ${String(r.stopPct).padStart(4)}%  hold ${String(r.hold).padStart(3)} (${(r.hold * 15 / 60).toFixed(0)}h)`);
  console.log(`  ${"".padEnd(16)}   net EV $${s.evUsd.toFixed(4)}/trade   ${s.evEq.toFixed(4)}% of equity   t ${s.t.toFixed(2)}   ${s.clusters} independent clusters   n ${s.n}`);
  console.log(`  ${"".padEnd(16)}   span ${new Date(s.span[0]).toISOString().slice(0, 10)} → ${new Date(s.span[1]).toISOString().slice(0, 10)}   win ${(s.winRate * 100).toFixed(1)}%   trimmed $${s.trimmedUsd.toFixed(4)}   ${s.evUsd > FEE_USD ? "ABOVE the fee floor" : "BELOW the fee floor"}`);
}

// ══════════════════════════════════════════════════════════════════════
// THE FULL BAR ON THE TOP CANDIDATES
// ══════════════════════════════════════════════════════════════════════
const top = results.sort((a, b) => b.s.evUsd - a.s.evUsd).slice(0, 6);
console.log(`\n${"═".repeat(120)}`);
console.log("THE FULL BAR — the six highest cells, against a placebo and a drift control");
console.log("═".repeat(120));

const finalRows = [];
for (const r of top) {
  const sig = r.sig();
  const s = r.s;
  const uc = resolve(unconditional(r.uncond), r.tpPct, r.stopPct, r.hold);
  const us = stats(uc, r.hold);
  const drift = s.evUsd - us.evUsd;
  const dse = Math.sqrt(s.seUsd ** 2 + us.seUsd ** 2);
  const dt = dse > 0 ? drift / dse : 0;

  // the placebo: the same sweep on placebo times
  const byPair = new Map();
  for (const x of sig) {
    if (!byPair.has(x.pair)) byPair.set(x.pair, []);
    byPair.get(x.pair).push(x);
  }
  const validIdx = new Map();
  for (const p of byPair.keys()) {
    const bars = pbars[p].bars; const v = [];
    for (let i = 0; i + r.hold < bars.length; i++) v.push(i);
    validIdx.set(p, v);
  }
  const pBest = [];
  for (let d = 0; d < 150; d++) {
    const rand = mulberry32(20261021 + d * 7919);
    const sh = [];
    for (const [p, list] of byPair) {
      const v = validIdx.get(p); const bars = pbars[p].bars;
      for (const x of list) {
        const j = v[Math.floor(rand() * v.length)];
        sh.push({ ...x, idx: j, ts: bars[j].t, entry: bars[j].c });
      }
    }
    let bb = null;
    for (const tpPct of TPS) for (const stopPct of STOPS) for (const hold of HOLDS) {
      const t2 = resolve(sh, tpPct, stopPct, hold);
      if (t2.length < 30) continue;
      const st2 = stats(t2, hold);
      if (!bb || st2.evUsd > bb) bb = st2.evUsd;
    }
    if (bb != null) pBest.push(bb);
  }
  pBest.sort((a, b) => a - b);
  const ge = pBest.filter((x) => x >= s.evUsd).length;

  // the per-day replication
  const byDay = new Map();
  for (const t of r.tr) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(t);
  }
  const days = [...byDay.entries()].sort();
  const dayMeans = days.map(([, v]) => mean(v.map((t) => t.pnlUsd)));
  const posDays = dayMeans.filter((x) => x > 0).length;

  const ps = perSymbol(r.tr);
  const bars = [
    ["net EV above the fee floor", s.evUsd > FEE_USD, `$${s.evUsd.toFixed(4)} vs $${FEE_USD.toFixed(4)}`],
    ["t >= 2 at the holding period", s.t >= 2, `t = ${s.t.toFixed(2)}`],
    ["trim-stable (worst 3, best 3)", s.trimmedUsd > FEE_USD, `$${s.trimmedUsd.toFixed(4)}`],
    ["beats the size-matched placebo", ge <= pBest.length * 0.05, `${(100 * ge / pBest.length).toFixed(1)}th pct of ${pBest.length}`],
    ["excess over the unconditional arm", drift > 0 && dt >= 2, `$${drift.toFixed(4)}/trade, t ${dt.toFixed(2)}`],
    ["stable across the independent days", posDays >= Math.ceil(days.length / 2), `${posDays}/${days.length}`],
    ["30 independent clusters (the house bar)", s.clusters >= 30, `${s.clusters}`],
  ];
  const pass = bars.every((b) => b[1]);
  finalRows.push({ r, s, bars, pass, drift, dt, ge, pBest, ps, posDays, days, us });

  console.log(`\n  ${r.fam} | ${r.name}  —  TP ${r.tpPct}% SL ${r.stopPct}% hold ${r.hold} (${(r.hold * 15 / 60).toFixed(0)}h)`);
  console.log(`     net EV $${s.evUsd.toFixed(4)}/trade  t ${s.t.toFixed(2)}  ${s.clusters} clusters  n ${s.n}  span ${new Date(s.span[0]).toISOString().slice(0, 10)}→${new Date(s.span[1]).toISOString().slice(0, 10)}`);
  console.log(`     the unconditional arm at the same geometry: $${us.evUsd.toFixed(4)}/trade → the signal's excess $${drift.toFixed(4)} (t ${dt.toFixed(2)})`);
  console.log(`     the placebo's best-of-sweep: median $${quantile(pBest, 0.5).toFixed(4)}, p95 $${quantile(pBest, 0.95).toFixed(4)}, max $${maxOf(pBest).toFixed(4)} → the real cell is at the ${(100 * ge / pBest.length).toFixed(1)}th pct`);
  console.log(`     the top symbol: ${ps.top.pair} = $${ps.top.pnl.toFixed(4)} over ${ps.top.n} trades = ${ps.top.share.toFixed(1)}% of the net`);
  for (const [name, ok, detail] of bars) console.log(`     ${(ok ? "PASS" : "FAIL").padStart(4)}  ${name.padEnd(40)} ${detail}`);
  console.log(`     VERDICT: ${pass ? "PASSES EVERY BAR" : "does NOT pass every bar"}`);
}

// ── the market-neutral cross-sectional pair ──
if (f5Pair) {
  const ps = f5Pair.s;
  console.log(`\n${"═".repeat(120)}`);
  console.log("F5 AS A MARKET-NEUTRAL PAIR — the long leg and the short leg netted, BOTH fees charged");
  console.log("═".repeat(120));
  console.log(`  best geometry: TP ${f5Pair.tpPct}% SL ${f5Pair.stopPct}% hold ${f5Pair.hold} (${(f5Pair.hold * 15 / 60).toFixed(0)}h)`);
  console.log(`  ${ps.n} pairs over ${ps.clusters} independent clusters, span ${new Date(ps.span[0]).toISOString().slice(0, 10)} → ${new Date(ps.span[1]).toISOString().slice(0, 10)}`);
  console.log(`  net EV $${ps.evUsd.toFixed(4)} per PAIR — the pair's fee floor is $${(2 * FEE_USD).toFixed(4)} (two taker round trips)`);
  console.log(`  t ${ps.t.toFixed(2)}   trimmed $${ps.trimmedUsd.toFixed(4)}   ${ps.evUsd > 2 * FEE_USD ? "ABOVE the pair's fee floor" : "BELOW the pair's fee floor"}`);
}

// ── the answer ──
console.log(`\n${"═".repeat(120)}`);
console.log("THE ANSWER");
console.log("═".repeat(120));
const passers = finalRows.filter((x) => x.pass);
console.log(`  cells that clear EVERY bar: ${passers.length}`);
if (passers.length) {
  for (const p of passers) console.log(`     ${p.r.fam} | ${p.r.name}: $${p.s.evUsd.toFixed(4)}/trade, t ${p.s.t.toFixed(2)}, ${p.s.clusters} clusters`);
} else {
  console.log(`     NONE.`);
}
const aboveFloor = results.filter((r) => r.s.evUsd > FEE_USD);
console.log(`  cells whose raw net EV is above the $${FEE_USD.toFixed(4)} fee floor: ${aboveFloor.length} of ${results.length}`);
console.log(`  of those, the ones that also clear t >= 2: ${aboveFloor.filter((r) => r.s.t >= 2).length}`);
console.log(`  of those, the ones that also beat the size-matched placebo: ${aboveFloor.filter((r) => r.s.t >= 2 && finalRows.some((f) => f.r === r && f.ge <= f.pBest.length * 0.05)).length}`);
console.log("");
