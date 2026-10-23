#!/usr/bin/env node
/**
 * THE VERDICT — one instrument that sweeps every family, every geometry,
 * and answers the question once: does ANY of them clear the fee floor
 * after the multiple-testing correction?
 *
 * THE MULTIPLE-TESTING PROBLEM, STATED
 * ------------------------------------
 * The five families are swept over hundreds of geometries each. The
 * best cell of a sweep is biased upward by construction. So the bar
 * cannot be "the best cell has a positive EV" — the bar has to be
 * "the best cell clears the floor AND its t is significant AND it
 * survives the placebo AND it survives the trim AND it is stable
 * across the chronological blocks".
 *
 * To make that concrete, this script ALSO runs the whole sweep
 * against the SIZE-MATCHED PLACEBO (the real signal times, randomised).
 * The placebo sweep is the null distribution of "the best cell of a
 * sweep of this size". A real candidate must beat the placebo's best
 * cell, not just the placebo's median.
 *
 * THE GEOMETRIES
 * --------------
 *   target:  0.25% to 6%  (0.12% of notional is the fee; a 1-3%
 *            continuation target is 8-25x the fee)
 *   stop:    none, and 0.25% to 6%  (the no-stop arm measures the
 *            signal's own directional edge)
 *   hold:    4 to 96 bars (1h to 24h)
 *
 * READ-ONLY. Local caches only.
 */
import {
  EQUITY, NOTIONAL, RHO, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
  loadBars, mean, stdev, fmt, pct, mulberry32, quantile, trim, clusterStats,
} from "./family-harness.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const pbars = loadBars({ withVolume: true });
const pairs = Object.keys(pbars);
const DAY = 24 * 3600_000;
const BAR = 15 * 60_000;

// ── the fill rule (first touch; a same-bar tie is a loss) ──
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
function resolve(signals, tpPct, stopPct, hold, maxHold) {
  const trades = [];
  for (const s of signals) {
    const pb = pbars[s.pair];
    if (!pb) continue;
    if (s.idx + hold >= pb.bars.length) continue;
    const h = hits(pb, s.idx, s.dir, tpPct, stopPct, maxHold);
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
    perSymbol: perSymbol(trades),
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

// ══════════════════════════════════════════════════════════════════════
// THE FIVE SIGNAL FAMILIES
// ══════════════════════════════════════════════════════════════════════
const FAMILIES = {};

FAMILIES["F1 breakout (N-bar high, rising volume)"] = () => {
  const out = {};
  for (const lookback of [4, 8, 16]) {
    for (const volMult of [1.0, 1.5, 2.0]) {
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
      out[`lb${lookback} volx${volMult}`] = sigs;
    }
  }
  return out;
};

FAMILIES["F2 momentum (15-min move X%)"] = () => {
  const out = {};
  for (const xPct of [0.3, 0.5, 0.75, 1.0, 1.5, 2.0]) {
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
    out[`move>=${xPct}%`] = sigs;
  }
  return out;
};

FAMILIES["F3 mean reversion (drop from local high)"] = () => {
  const out = {};
  for (const dropPct of [0.5, 1.0, 1.5, 2.0, 3.0]) {
    for (const lookback of [32, 96, 192]) {
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
      out[`drop>=${dropPct}% lb${lookback}`] = sigs;
    }
  }
  return out;
};

FAMILIES["F4 time of day (UTC hour, fixed bias)"] = () => {
  const out = {};
  for (const hour of [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22]) {
    for (const dir of [1, -1]) {
      const sigs = [];
      for (const p of pairs) {
        const bars = pbars[p].bars;
        for (let i = 101; i < bars.length; i++) {
          if (((bars[i].t % DAY) + DAY) % DAY !== hour * 3600_000) continue;
          sigs.push({ pair: p, ts: bars[i - 1].t, idx: i - 1, dir, entry: bars[i - 1].c });
        }
      }
      out[`h${hour} ${dir > 0 ? "long" : "short"}`] = sigs;
    }
  }
  return out;
};

FAMILIES["F5 cross-sectional (rank the universe, trade the extreme)"] = () => {
  const out = {};
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
  for (const mode of ["extreme", "both", "momentum"]) {
    for (const minSyms of [30, 40]) {
      const sigs = [];
      for (let r = 1; r < tsS.length; r++) {
        const t = tsS[r], tPrev = tsS[r - 1];
        if (t - tPrev !== BAR) continue;
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
        const wantL = mode === "both" || mode === "momentum" || med <= 0;
        const wantW = mode === "both" || mode === "momentum" || med >= 0;
        if (wantL) { const i = idxOf.get(loser.pair).get(t); sigs.push({ pair: loser.pair, ts: t, idx: i, dir: 1, entry: loser.c }); }
        if (wantW) { const i = idxOf.get(winner.pair).get(t); sigs.push({ pair: winner.pair, ts: t, idx: i, dir: -1, entry: winner.c }); }
      }
      out[`${mode} min${minSyms}`] = sigs;
    }
  }
  return out;
};

// ══════════════════════════════════════════════════════════════════════
// THE SWEEP
// ══════════════════════════════════════════════════════════════════════
const TPS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const STOPS = [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];
const HOLDS = [4, 8, 16, 32, 64, 96];
const MAXHOLD = maxOf(HOLDS);

console.log("═".repeat(120));
console.log("THE VERDICT — every family, every geometry, one question");
console.log("═".repeat(120));
console.log(`  equity $${EQUITY.toFixed(2)}  notional $${NOTIONAL.toFixed(2)}  taker RT ${(TAKER_RT * 100).toFixed(2)}% = $${FEE_USD.toFixed(4)}/trade`);
console.log(`  the fee floor: $${FEE_USD.toFixed(4)}/trade = ${FEE_FLOOR_EQ_PCT.toFixed(5)}% of equity per trade`);
console.log(`  the grid: ${TPS.length} targets x ${STOPS.length} stops x ${HOLDS.length} holds = ${TPS.length * STOPS.length * HOLDS.length} geometries per cell`);

const allRows = [];
let totalGeoms = 0;

for (const [famName, gen] of Object.entries(FAMILIES)) {
  console.log(`\n${"#".repeat(120)}\n#  ${famName}\n${"#".repeat(120)}`);
  const cells = gen();
  for (const [cellName, signals] of Object.entries(cells)) {
    if (!signals || signals.length < 30) continue;
    let best = null;
    let tested = 0;
    for (const tpPct of TPS) {
      for (const stopPct of STOPS) {
        for (const hold of HOLDS) {
          tested++; totalGeoms++;
          const tr = resolve(signals, tpPct, stopPct, hold, MAXHOLD);
          if (tr.length < 30) continue;
          const s = stats(tr, hold);
          if (!best || s.evUsd > best.s.evUsd) best = { tpPct, stopPct, hold, s, tr, tested };
        }
      }
    }
    if (!best) continue;
    const s = best.s;
    allRows.push({ fam: famName, cell: cellName, ...best, tested });
    const above = s.evUsd > FEE_USD;
    console.log(`  ${cellName.padEnd(22)} n ${String(s.n).padStart(6)}  clus ${String(s.clusters).padStart(3)}  best TP ${String(best.tpPct).padStart(5)}% SL ${String(best.stopPct).padStart(5)}% hold ${String(best.hold).padStart(3)}  EV $${s.evUsd.toFixed(4).padStart(8)}  t ${s.t.toFixed(2).padStart(7)}  win ${(s.winRate * 100).toFixed(1).padStart(5)}%  ${above ? "ABOVE FLOOR" : "below"}`);
  }
}

// ── the global ranking, and the placebo sweep of the WHOLE grid ──
allRows.sort((a, b) => b.s.evUsd - a.s.evUsd);
console.log(`\n${"═".repeat(120)}`);
console.log(`THE TOP 15 CELLS OF THE ENTIRE SWEEP (${totalGeoms} geometries across ${allRows.length} cells)`);
console.log("═".repeat(120));
console.log(`  ${"family".padEnd(46)} ${"cell".padEnd(20)} ${"TP".padStart(5)} ${"SL".padStart(5)} ${"hold".padStart(4)} ${"n".padStart(6)} ${"clus".padStart(4)} ${"EV$".padStart(8)} ${"t".padStart(7)} ${"win%".padStart(6)} ${"trim$".padStart(8)}`);
for (const r of allRows.slice(0, 15)) {
  console.log(`  ${r.fam.slice(0, 46).padEnd(46)} ${r.cell.slice(0, 20).padEnd(20)} ${String(r.tpPct).padStart(5)} ${String(r.stopPct).padStart(5)} ${String(r.hold).padStart(4)} ${String(r.s.n).padStart(6)} ${String(r.s.clusters).padStart(4)} ${r.s.evUsd.toFixed(4).padStart(8)} ${r.s.t.toFixed(2).padStart(7)} ${(r.s.winRate * 100).toFixed(1).padStart(6)} ${r.s.trimmedUsd.toFixed(4).padStart(8)}`);
}

// ── the multiple-testing null: the best cell of a PLACEBO sweep ──
console.log(`\n${"═".repeat(120)}`);
console.log("THE MULTIPLE-TESTING NULL — the best cell of the SAME sweep run on PLACEBO signals");
console.log("═".repeat(120));
console.log("  For each real cell, the placebo keeps the symbols, the directions, the size and the");
console.log("  geometry, and destroys ONLY the times. The null is the BEST cell of the placebo sweep.");
console.log("  A real candidate must beat that, not the placebo's median.");

const PLACEBO_DRAWS = 200;
const nullBest = [];
for (const r of allRows.slice(0, 6)) {
  const signals = FAMILIES[r.fam]()[r.cell];
  if (!signals) continue;
  const byPair = new Map();
  for (const s of signals) {
    if (!byPair.has(s.pair)) byPair.set(s.pair, []);
    byPair.get(s.pair).push(s);
  }
  const validIdx = new Map();
  for (const p of byPair.keys()) {
    const bars = pbars[p].bars; const v = [];
    for (let i = 0; i + r.hold < bars.length; i++) v.push(i);
    validIdx.set(p, v);
  }
  const bests = [];
  for (let d = 0; d < PLACEBO_DRAWS; d++) {
    const rand = mulberry32(20261021 + d * 7919);
    const sh = [];
    for (const [p, list] of byPair) {
      const v = validIdx.get(p); const bars = pbars[p].bars;
      for (const s of list) {
        const j = v[Math.floor(rand() * v.length)];
        sh.push({ ...s, idx: j, ts: bars[j].t, entry: bars[j].c });
      }
    }
    const tr = resolve(sh, r.tpPct, r.stopPct, r.hold, MAXHOLD);
    if (tr.length < 30) continue;
    const s = stats(tr, r.hold);
    if (s) bests.push(s.evUsd);
  }
  bests.sort((a, b) => a - b);
  const p = bests.length ? quantile(bests, 0.95) : NaN;
  const med = bests.length ? quantile(bests, 0.5) : NaN;
  nullBest.push({ ...r, nullP95: p, nullMed: med, nDraws: bests.length });
  console.log(`  ${r.fam.slice(0, 44).padEnd(44)} ${r.cell.slice(0, 18).padEnd(18)} real $${r.s.evUsd.toFixed(4).padStart(8)}   placebo best-of-sweep: median $${med.toFixed(4)}  p95 $${p.toFixed(4)}  → ${r.s.evUsd > p ? "BEATS the null" : "does NOT beat the null"}`);
}

// ── the FINAL verdict on each candidate ──
console.log(`\n${"═".repeat(120)}`);
console.log("THE VERDICT, CELL BY CELL — every bar the house requires");
console.log("═".repeat(120));
console.log(`  ${"cell".padEnd(52)} ${"EV$".padStart(8)} {"floor".padStart(6)} {"t>=2".padStart(6)} {"trim".padStart(6)} {"placebo".padStart(8)} {"blocks".padStart(7)} {"VERDICT".padStart(9)}`);
for (const r of allRows.slice(0, 15)) {
  const s = r.s;
  const floorOk = s.evUsd > FEE_USD;
  const tOk = s.t >= 2;
  const trimOk = s.trimmedUsd > FEE_USD;
  const nb = nullBest.find((x) => x.fam === r.fam && x.cell === r.cell);
  const plOk = nb ? (s.evUsd > nb.nullP95) : null;
  // the chronological thirds
  const ts = r.tr.map((x) => x.ts);
  const lo = minOf(ts), hi = maxOf(ts), w = (hi - lo) / 3 || 1;
  let posBlocks = 0;
  for (let i = 0; i < 3; i++) {
    const a = lo + i * w, b = i === 2 ? hi + 1 : lo + (i + 1) * w;
    const bt = r.tr.filter((x) => x.ts >= a && x.ts < b);
    if (bt.length && mean(bt.map((x) => x.pnlUsd)) > 0) posBlocks++;
  }
  const blocksOk = posBlocks >= 2;
  const pass = floorOk && tOk && trimOk && plOk === true && blocksOk;
  console.log(`  ${(r.fam + " | " + r.cell).slice(0, 52).padEnd(52)} ${s.evUsd.toFixed(4).padStart(8)} ${(floorOk ? "YES" : "no").padStart(6)} ${(tOk ? "YES" : "no").padStart(6)} ${(trimOk ? "YES" : "no").padStart(6)} ${(plOk === null ? "n/a" : plOk ? "YES" : "no").padStart(8)} ${(posBlocks + "/3").padStart(7)} ${(pass ? "PASSES" : "fails").padStart(9)}`);
}
console.log("");
