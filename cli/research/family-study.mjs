#!/usr/bin/env node
/**
 * THE FIVE FAMILIES — a search for a strategy family that is NOT the
 * exhausted exhaustion family.
 *
 * Every family is measured with the SAME instrument:
 *   - the CORRECT fill rule: first touch of TP or the kill wins; a bar
 *     touching BOTH is a LOSS; neither is a TIME EXIT at its mark.
 *     Every target is beyond the market by construction, so the scratch
 *     artefact is impossible.
 *   - the CORRECT clustering: cluster means at the TICKET'S HOLDING
 *     PERIOD (holdBars x 15 min), never the collector's 5-minute round.
 *   - the venue's real taker round trip: 0.12% of notional = $0.0720
 *     on a $60 ticket. The fee floor is $0.0720/trade = 0.12656% of
 *     the $56.89 equity.
 *   - a SIZE-MATCHED PLACEBO beside every candidate: the real signals
 *     with their TIMES destroyed (same symbols, same directions, same
 *     size, same geometry). The real excess must beat the placebo
 *     distribution.
 *   - trim-stability: the mean survives dropping the worst 3 and best 3.
 *   - a per-symbol breakdown with the top symbol's share named.
 *
 * READ-ONLY. Local caches only. No account calls, no venue calls.
 *
 * USAGE
 *   node research/family-study.mjs --family 1
 *   node research/family-study.mjs --family all --placebo 300
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCRATCH, EQUITY, NOTIONAL, RHO, TAKER_RT, FEE_USD, FEE_FLOOR_EQ_PCT, BAR_MS,
  loadBars, mean, stdev, fmt, pct, mulberry32, quantile, trim,
  clusterStats, excessOf, breakEven, perSymbol,
} from "./family-harness.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const FAMILY = String(argOf("family", "all"));
const PLACEBO_DRAWS = Number(argOf("placebo", 200));
const SEED = Number(argOf("seed", 20261021));

const pbars = loadBars({ withVolume: true });
const pairs = Object.keys(pbars);
console.log("═".repeat(118));
console.log("THE FIVE FAMILIES — a search for a family that is not the exhaustion family");
console.log("═".repeat(118));
console.log(`  equity $${EQUITY.toFixed(2)}   notional $${NOTIONAL.toFixed(2)}   taker round trip ${(TAKER_RT * 100).toFixed(2)}% = $${FEE_USD.toFixed(4)}/trade`);
console.log(`  the fee floor: $${FEE_USD.toFixed(4)} per trade = ${FEE_FLOOR_EQ_PCT.toFixed(5)}% of equity per trade`);
console.log(`  bars: ${pairs.length} pairs, ${pbars[pairs[0]].bars.length} bars each (15-min)`);

// ── the fast resolver ─────────────────────────────────────────────────
// For one signal and one (tp, stop) geometry, find the FIRST bar that
// touches the target and the FIRST bar that touches the stop. Every
// hold length is then answered from those two indices.
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

/**
 * The outcome of a signal at a given hold, from the precomputed hits.
 *
 * FIRST TOUCH decides. If the kill was touched before the target, the
 * trade is a LOSS even if the target is reached later in the hold; a
 * bar that touches BOTH is a LOSS (the conservative reading).
 *
 * The kill is filled AT THE STOP PRICE (the house convention:
 * research/sweep-corrected.mjs books `-stopPct/100 - fee`), not at the
 * bar's extreme.
 */
function outcomeAt(pb, idx, dir, hold, h) {
  const win = h.tpIdx >= 0 && h.tpIdx <= idx + hold;
  const lose = h.slIdx >= 0 && h.slIdx <= idx + hold;
  // Both touched inside the hold: whichever came FIRST decides; a tie
  // (the same bar) is a loss.
  if (win && lose) {
    return h.tpIdx < h.slIdx
      ? { kind: "win", gross: h.tpFrac }
      : { kind: "loss", gross: -h.stopFrac };
  }
  if (lose) return { kind: "loss", gross: -h.stopFrac };
  if (win) return { kind: "win", gross: h.tpFrac };
  // neither touched: a TIME EXIT at the mark of the last bar of the hold
  const last = pb.bars[idx + hold];
  const mark = dir > 0 ? (last.c - h.entry) / h.entry : (h.entry - last.c) / h.entry;
  return { kind: "time", gross: mark };
}

/**
 * Resolve a signal set into trades for one geometry.
 * strict: a signal without a full forward window is DROPPED (not
 * scored at a partial hold, which would be a censoring artefact).
 *
 * stopPct === 0 means NO STOP: the trade is target-or-time-exit only.
 * That arm measures the signal's own directional edge, without the stop
 * geometry dragging on it.
 */
function resolve(signals, tpPct, stopPct, hold, maxHold) {
  const trades = [];
  for (const s of signals) {
    const pb = pbars[s.pair];
    if (!pb) continue;
    if (s.idx + hold >= pb.bars.length) continue;   // strict censoring
    const h = hits(pb, s.idx, s.dir, tpPct, stopPct, maxHold);
    const o = outcomeAt(pb, s.idx, s.dir, hold, h);
    const pnlUsd = o.gross * NOTIONAL - FEE_USD;
    trades.push({
      pair: s.pair, ts: s.ts, dir: s.dir, kind: o.kind, gross: o.gross,
      pnlUsd, pnlEq: (pnlUsd / EQUITY) * 100, meta: s.meta ?? null,
    });
  }
  return trades;
}

/** The full stat block for one geometry. */
function stats(trades, hold) {
  if (!trades.length) {
    return { n: 0, clusters: 0, evUsd: 0, evEq: 0, t: 0, winRate: 0, wins: 0, losses: 0, times: 0, trimmedUsd: 0, span: null, perSymbol: null };
  }
  const usd = trades.map((t) => t.pnlUsd);
  const cs = clusterStats(trades, hold);
  const ts = trades.map((t) => t.ts);
  return {
    n: trades.length,
    clusters: cs.clusters,
    evUsd: mean(usd),
    evEq: mean(trades.map((t) => t.pnlEq)),
    t: cs.t,
    seUsd: stdev(usd) / Math.sqrt(usd.length),
    wins: trades.filter((t) => t.kind === "win").length,
    losses: trades.filter((t) => t.kind === "loss").length,
    times: trades.filter((t) => t.kind === "time").length,
    winRate: trades.filter((t) => t.kind === "win").length / trades.length,
    trimmedUsd: mean(trim(usd, 3)),
    span: [minOf(ts), maxOf(ts)],
    perSymbol: perSymbol(trades),
  };
}

/**
 * THE SIZE-MATCHED PLACEBO: the real signals with their TIMES destroyed.
 * Same symbols, same directions, same size, same geometry; only the
 * moment the signal fires is randomised, over the same pair's own
 * valid index range. This is the null: "what does a signal of this
 * shape produce when it knows nothing?"
 */
function placebo(signals, tpPct, stopPct, hold, maxHold, draws) {
  const byPair = new Map();
  for (const s of signals) {
    if (!byPair.has(s.pair)) byPair.set(s.pair, []);
    byPair.get(s.pair).push(s);
  }
  const validIdx = new Map();
  for (const p of byPair.keys()) {
    const bars = pbars[p].bars;
    const v = [];
    for (let i = 0; i + hold < bars.length; i++) v.push(i);
    validIdx.set(p, v);
  }
  const evs = [];
  for (let d = 0; d < draws; d++) {
    const rand = mulberry32(SEED + d * 7919);
    const shuffled = [];
    for (const [p, list] of byPair) {
      const v = validIdx.get(p);
      for (const s of list) {
        const j = v[Math.floor(rand() * v.length)];
        const bars = pbars[p].bars;
        shuffled.push({ ...s, idx: j, ts: bars[j].t, entry: bars[j].c });
      }
    }
    const tr = resolve(shuffled, tpPct, stopPct, hold, maxHold);
    if (tr.length !== signals.length) continue;   // exact size match
    const cs = clusterStats(tr, hold);
    evs.push(cs.ev);
  }
  evs.sort((a, b) => a - b);
  return evs;
}

// ══════════════════════════════════════════════════════════════════════
// THE SIGNAL GENERATORS
// ══════════════════════════════════════════════════════════════════════

/** F1: TREND-FOLLOWING BREAKOUT — a new N-bar high on rising volume. */
function genBreakout({ lookback, volMult, minSyms }) {
  const sigs = [];
  const noVol = pairs.filter((p) => pbars[p].bars.every((b) => b.v == null));
  if (noVol.length) {
    console.log(`  [F1] WARNING: no volume for ${noVol.length} pairs (${noVol.slice(0, 3).join(",")}…) — those are excluded`);
  }
  for (const p of pairs) {
    const bars = pbars[p].bars;
    if (bars.length < lookback + 200) continue;
    for (let i = lookback + 50; i < bars.length; i++) {
      const v = bars[i].v;
      if (v == null) continue;
      let pv = 0, pvN = 0, hi = -Infinity, lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (bars[k].h > hi) hi = bars[k].h;
        if (bars[k].l < lo) lo = bars[k].l;
        if (bars[k].v != null) { pv += bars[k].v; pvN++; }
      }
      if (!pvN) continue;
      const vma = pv / pvN;
      if (!(vma > 0)) continue;
      if (v < volMult * vma) continue;
      const c = bars[i].c;
      let dir = 0;
      if (c > hi) dir = 1;
      else if (c < lo) dir = -1;
      if (!dir) continue;
      sigs.push({ pair: p, ts: bars[i].t, idx: i, dir, entry: c, meta: { vRatio: v / vma } });
    }
  }
  return sigs;
}

/** F2: MOMENTUM — a 15-minute move of X%, held for hours. */
function genMomentum({ xPct }) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 60; i < bars.length; i++) {
      const prev = bars[i - 1].c;
      if (!(prev > 0)) continue;
      const m = (bars[i].c / prev - 1) * 100;
      if (m >= xPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: bars[i].c, meta: { m } });
      else if (m <= -xPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: -1, entry: bars[i].c, meta: { m } });
    }
  }
  return sigs;
}

/** F3: MEAN REVERSION — a drop of X% from the local high, held for hours. */
function genMeanReversion({ dropPct, lookback }) {
  const sigs = [];
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = lookback + 10; i < bars.length; i++) {
      let hi = -Infinity;
      for (let k = i - lookback + 1; k <= i; k++) if (bars[k].h > hi) hi = bars[k].h;
      const c = bars[i].c;
      if (!(hi > 0)) continue;
      const drop = (hi - c) / hi * 100;
      if (drop >= dropPct) sigs.push({ pair: p, ts: bars[i].t, idx: i, dir: 1, entry: c, meta: { drop } });
    }
  }
  return sigs;
}

/** F4: TIME OF DAY — enter at the top of a chosen UTC hour, fixed bias. */
function genTimeOfDay({ hour, dir }) {
  const sigs = [];
  const DAY = 24 * 3600_000;
  // KuCoin's bar timestamp is the bar's OPEN time. The bar opening at
  // the top of `hour` has t mod DAY == hour*3600000. The position is
  // entered at that bar's OPEN — the previous bar's CLOSE — and the scan
  // starts at the hour's first bar, so no part of the entry bar is
  // traded and there is no look-ahead.
  const targetMs = hour * 3600_000;
  for (const p of pairs) {
    const bars = pbars[p].bars;
    for (let i = 101; i < bars.length; i++) {
      const t = bars[i].t;
      if (((t % DAY) + DAY) % DAY !== targetMs) continue;
      const prev = bars[i - 1];
      sigs.push({ pair: p, ts: prev.t, idx: i - 1, dir, entry: prev.c, meta: { hour } });
    }
  }
  return sigs;
}

/** F5: CROSS-SECTIONAL — rank the universe each round, trade the extreme. */
function genCrossSectional({ mode, minSyms }) {
  // rounds by bar timestamp
  const rounds = new Map();
  for (const p of pairs) {
    for (const b of pbars[p].bars) {
      if (!rounds.has(b.t)) rounds.set(b.t, []);
      rounds.get(b.t).push({ pair: p, c: b.c });
    }
  }
  const tsSorted = [...rounds.keys()].sort((a, b) => a - b);
  const sigs = [];
  for (let r = 1; r < tsSorted.length; r++) {
    const t = tsSorted[r], tPrev = tsSorted[r - 1];
    if (t - tPrev !== BAR_MS) continue;            // a contiguous round
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
    const idxOf = new Map();
    for (const p of pairs) {
      const bars = pbars[p].bars;
      idxOf.set(p, bars.findIndex((b) => b.t === t));
    }
    if (mode === "extreme" || mode === "both" || mode === "momentum") {
      // fade the loser (long) and the winner (short) — market-neutral
      if (mode === "both" || mode === "momentum" || med <= 0) {
        const i = idxOf.get(loser.pair);
        if (i >= 0) sigs.push({ pair: loser.pair, ts: t, idx: i, dir: 1, entry: loser.c, meta: { r: loser.r, side: "loser", med } });
      }
      if (mode === "both" || mode === "momentum" || med >= 0) {
        const i = idxOf.get(winner.pair);
        if (i >= 0) sigs.push({ pair: winner.pair, ts: t, idx: i, dir: -1, entry: winner.c, meta: { r: winner.r, side: "winner", med } });
      }
    }
  }
  return sigs;
}

// ══════════════════════════════════════════════════════════════════════
// THE SWEEPS
// ══════════════════════════════════════════════════════════════════════

const RESULTS = {};

function report(familyName, signalName, signals, grid, { note = "" } = {}) {
  if (!signals.length) {
    console.log(`\n── ${familyName} | ${signalName} ── NO SIGNALS`);
    return [];
  }
  const maxHold = maxOf(grid.holds);
  const cands = [];
  let tested = 0;
  for (const tpPct of grid.tps) {
    for (const stopPct of grid.stops) {
      for (const hold of grid.holds) {
        tested++;
        const tr = resolve(signals, tpPct, stopPct, hold, maxHold);
        if (tr.length < 20) continue;
        const s = stats(tr, hold);
        cands.push({ tpPct, stopPct, hold, s, tr });
      }
    }
  }
  cands.sort((a, b) => b.s.evUsd - a.s.evUsd);
  const span = signals.length
    ? [minBy(signals, (x) => x.ts), maxBy(signals, (x) => x.ts)]
    : null;
  console.log(`\n── ${familyName} | ${signalName} ──`);
  console.log(`   signals ${signals.length} over ${new Set(signals.map((x) => x.pair)).size} pairs; signal span ${new Date(span[0]).toISOString().slice(0, 16)} → ${new Date(span[1]).toISOString().slice(0, 16)}${note ? "  " + note : ""}`);
  console.log(`   ${tested} geometries; the fee floor is $${FEE_USD.toFixed(4)}/trade`);
  console.log(`   ${"TP%".padStart(5)} ${"SL%".padStart(5)} ${"hold".padStart(5)} ${"n".padStart(5)} ${"clus".padStart(5)} ${"EV$".padStart(9)} ${"EV%eq".padStart(9)} ${"t".padStart(7)} ${"win%".padStart(6)} ${"trim$".padStart(9)} ${"brk-even".padStart(9)} ${"floor?".padStart(7)}`);
  const passing = [];
  for (const c of cands.slice(0, 8)) {
    const s = c.s;
    const be = breakEven(c.tpPct, c.stopPct);
    const above = s.evUsd > FEE_USD;
    console.log(
      `   ${String(c.tpPct).padStart(5)} ${String(c.stopPct).padStart(5)} ${String(c.hold).padStart(5)} ${String(s.n).padStart(5)} ${String(s.clusters).padStart(5)} ` +
      `${s.evUsd.toFixed(4).padStart(9)} ${s.evEq.toFixed(4).padStart(9)} ${s.t.toFixed(2).padStart(7)} ${(s.winRate * 100).toFixed(1).padStart(6)} ` +
      `${s.trimmedUsd.toFixed(4).padStart(9)} ${(be.toFixed(1) + "%").padStart(9)} ${(above ? "YES" : "no").padStart(7)}`,
    );
    if (s.evUsd > 0 && s.t >= 2) passing.push(c);
  }
  if (!cands.length) console.log("   (no geometry produced 20+ resolvable trades)");
  // The best candidate by EV, then the placebo test on it.
  if (cands.length) {
    const best = cands[0];
    const pl = placebo(signals, best.tpPct, best.stopPct, best.hold, maxHold, PLACEBO_DRAWS);
    const p = pl.length ? quantile(pl, 0.5) : NaN;
    const p95 = pl.length ? quantile(pl, 0.95) : NaN;
    const ge = pl.filter((x) => x >= best.s.evEq).length;
    console.log(`   PLACEBO (size-matched, times destroyed): ${pl.length} draws, median EV ${pct(p)} %eq, p95 ${pct(p95)}; the real EV ${pct(best.s.evEq)} is at the ${(100 * ge / Math.max(1, pl.length)).toFixed(1)}th percentile${ge <= pl.length * 0.05 ? " — BEATS the placebo" : " — does NOT beat the placebo"}`);
    const s = best.s;
    console.log(`   the best geometry: TP ${best.tpPct}% SL ${best.stopPct}% hold ${best.hold} bars (${best.hold * 15 / 60}h) — n ${s.n} trades, ${s.clusters} independent clusters, EV $${s.evUsd.toFixed(4)}/trade, t ${s.t.toFixed(2)}, win ${(s.winRate * 100).toFixed(1)}%, trimmed $${s.trimmedUsd.toFixed(4)}`);
    if (s.span) console.log(`   the trade span: ${new Date(s.span[0]).toISOString().slice(0, 16)} → ${new Date(s.span[1]).toISOString().slice(0, 16)}`);
    if (s.perSymbol) {
      const ps = s.perSymbol;
      console.log(`   per-symbol: ${ps.symbols} symbols traded; top ${ps.top.pair} = $${ps.top.pnl.toFixed(4)} over ${ps.top.n} trades = ${ps.top.share.toFixed(1)}% of the net`);
      for (const r of ps.rows.slice(0, 6)) {
        console.log(`      ${r.pair.padEnd(16)} n ${String(r.n).padStart(4)}  net $${r.pnl.toFixed(4).padStart(9)}  win ${(100 * r.wins / r.n).toFixed(0).padStart(3)}%`);
      }
      const neg = ps.rows.filter((r) => r.pnl < 0);
      console.log(`      ${neg.length} of ${ps.rows.length} symbols lost money`);
    }
    // The mirror arm: the SAME signal times, traded the OTHER way, with
    // the same geometry. It is RE-RESOLVED, not approximated — the levels
    // swap, so a trade that lost at the stop becomes a trade that won at
    // the target only if the target was actually reached first.
    const mirrorSig = signals.map((s) => ({ ...s, dir: -s.dir }));
    const mirrorTr = resolve(mirrorSig, best.tpPct, best.stopPct, best.hold, maxHold);
    const ms = stats(mirrorTr, best.hold);
    const ex = excessOf({ ev: s.evEq, se: (s.seUsd ?? 0) / EQUITY * 100 }, { ev: ms.evEq, se: (ms.seUsd ?? 0) / EQUITY * 100 });
    console.log(`   MIRROR arm (the same signal times, the other side, re-resolved): EV $${ms.evUsd.toFixed(4)}/trade, n ${ms.n} — the real side's excess ${ex.excess >= 0 ? "+" : ""}${ex.excess.toFixed(4)} %eq (t ${ex.t.toFixed(2)})`);
    // The drift control: an unconditional entry at the SAME times, both
    // directions, with no signal at all. This is what the market did.
    const driftSig = signals.map((s) => ({ ...s, dir: 1 }));
    const driftTr = resolve(driftSig, best.tpPct, best.stopPct, best.hold, maxHold);
    const ds = stats(driftTr, best.hold);
    console.log(`   DRIFT control (unconditional long at the same times): EV $${ds.evUsd.toFixed(4)}/trade, n ${ds.n} — the market's own drift over this window`);
    // The side split: the long half and the short half of the SAME signal
    // set, at the SAME geometry. A directional edge shows up here even
    // when the pooled arm is dragged down by the other side.
    for (const [lbl, sel] of [["LONG only", (t) => t.dir > 0], ["SHORT only", (t) => t.dir < 0]]) {
      const sub = best.tr.filter(sel);
      if (sub.length < 20) { console.log(`   side split ${lbl}: only ${sub.length} trades — TOO FEW`); continue; }
      const ss = stats(sub, best.hold);
      console.log(`   side split ${lbl.padEnd(11)}: n ${String(ss.n).padStart(5)}  EV $${ss.evUsd.toFixed(4).padStart(9)}  t ${ss.t.toFixed(2).padStart(7)}  win ${(ss.winRate * 100).toFixed(1).padStart(5)}%  trimmed $${ss.trimmedUsd.toFixed(4).padStart(9)}  ${ss.evUsd > FEE_USD ? "clears the floor" : "below the floor"}`);
      if (ss.evUsd > FEE_USD) {
        const pl = placebo(signals.filter(sel), best.tpPct, best.stopPct, best.hold, maxHold, PLACEBO_DRAWS);
        const ge = pl.filter((x) => x >= ss.evEq).length;
        console.log(`      its own placebo: ${pl.length} draws, median EV ${pct(pl.length ? quantile(pl, 0.5) : NaN)} %eq, p95 ${pct(pl.length ? quantile(pl, 0.95) : NaN)}; the real ${pct(ss.evEq)} is at the ${(100 * ge / Math.max(1, pl.length)).toFixed(1)}th percentile${ge <= pl.length * 0.05 ? " — BEATS the placebo" : " — does NOT beat the placebo"}`);
        RESULTS[`${familyName} | ${signalName} | ${lbl}`] = { grid: best, stats: ss, placebo: { n: pl.length, pct: (100 * ge / Math.max(1, pl.length)) } };
      }
    }
    // The three chronological blocks
    const ts = best.tr.map((t) => t.ts);
    const lo = minOf(ts), hi = maxOf(ts), w = (hi - lo) / 3 || 1;
    const bl = [];
    for (let i = 0; i < 3; i++) {
      const a = lo + i * w, b = i === 2 ? hi + 1 : lo + (i + 1) * w;
      bl.push(best.tr.filter((t) => t.ts >= a && t.ts < b));
    }
    console.log(`   out-of-sample thirds: ${bl.map((b, i) => `B${i + 1} n${b.length} $${b.length ? mean(b.map((t) => t.pnlUsd)).toFixed(4) : "n/a"}`).join("  ")}`);
    RESULTS[`${familyName} | ${signalName}`] = { grid: best, stats: s, placebo: { n: pl.length, median: p, p95, pct: (100 * ge / Math.max(1, pl.length)) }, mirror: ms, blocks: bl.map((b) => ({ n: b.length, ev: b.length ? mean(b.map((t) => t.pnlUsd)) : null })) };
  }
  return cands;
}

// ── F1 ──
if (FAMILY === "1" || FAMILY === "all") {
  console.log("\n" + "#".repeat(118));
  console.log("#  FAMILY 1 — TREND-FOLLOWING BREAKOUT: a new N-bar high on rising volume, entering on the break");
  console.log("#".repeat(118));
  const volPairs = pairs.filter((p) => pbars[p].bars.some((b) => b.v != null));
  console.log(`  volume available for ${volPairs.length}/${pairs.length} pairs`);
  for (const lookback of [4, 8, 16]) {
    for (const volMult of [1.2, 1.5, 2.0]) {
      const sigs = genBreakout({ lookback, volMult, minSyms: 0 });
      report("F1 BREAKOUT", `lookback ${lookback} bars, volume x${volMult}`, sigs, {
        tps: [1.0, 1.5, 2.0, 3.0, 4.0, 5.0], stops: [0, 1.0, 1.5, 2.0, 3.0], holds: [16, 32, 64, 96],
      });
    }
  }
}

// ── F2 ──
if (FAMILY === "2" || FAMILY === "all") {
  console.log("\n" + "#".repeat(118));
  console.log("#  FAMILY 2 — MOMENTUM: a 15-minute move of X%, held for hours");
  console.log("#".repeat(118));
  for (const xPct of [0.3, 0.5, 0.75, 1.0, 1.5]) {
    const sigs = genMomentum({ xPct });
    report("F2 MOMENTUM", `15-minute move >= ${xPct}%`, sigs, {
      tps: [1.0, 2.0, 3.0, 4.0, 5.0], stops: [0, 0.5, 1.0, 1.5, 2.0], holds: [16, 32, 64, 96],
    });
  }
}

// ── F3 ──
if (FAMILY === "3" || FAMILY === "all") {
  console.log("\n" + "#".repeat(118));
  console.log("#  FAMILY 3 — MEAN REVERSION on a longer horizon: a drop from the local high, a recovery target");
  console.log("#".repeat(118));
  for (const dropPct of [1.0, 1.5, 2.0]) {
    for (const lookback of [32, 96]) {
      const sigs = genMeanReversion({ dropPct, lookback });
      report("F3 MEAN-REV", `drop >= ${dropPct}% from the ${lookback}-bar local high`, sigs, {
        tps: [0.5, 0.75, 1.0, 1.5, 2.0], stops: [0, 0.5, 1.0, 1.5, 2.0], holds: [16, 32, 64, 96],
      });
    }
  }
}

// ── F4 ──
if (FAMILY === "4" || FAMILY === "all") {
  console.log("\n" + "#".repeat(118));
  console.log("#  FAMILY 4 — TIME OF DAY: enter at the top of a fixed UTC hour, a fixed bias, a wide target");
  console.log("#".repeat(118));
  const hours = [0, 2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 18, 20, 22];
  const rows = [];
  for (const hour of hours) {
    for (const dir of [1, -1]) {
      const sigs = genTimeOfDay({ hour, dir });
      if (!sigs.length) continue;
      const grid = { tps: [0.5, 1.0, 1.5, 2.0, 3.0, 4.0], stops: [0, 0.5, 1.0, 1.5, 2.0], holds: [8, 16, 32, 64] };
      const maxHold = maxOf(grid.holds);
      let best = null;
      for (const tpPct of grid.tps) for (const stopPct of grid.stops) for (const hold of grid.holds) {
        const tr = resolve(sigs, tpPct, stopPct, hold, maxHold);
        if (tr.length < 20) continue;
        const s = stats(tr, hold);
        if (!best || s.evUsd > best.s.evUsd) best = { tpPct, stopPct, hold, s, tr };
      }
      if (!best) continue;
      const be = breakEven(best.tpPct, best.stopPct);
      rows.push({ hour, dir, best });
      console.log(`   hour ${String(hour).padStart(2)}:00 UTC  ${dir > 0 ? "LONG " : "SHORT"}  best TP ${best.tpPct}% SL ${best.stopPct}% hold ${best.hold}  n ${String(best.s.n).padStart(4)}  EV $${best.s.evUsd.toFixed(4).padStart(8)}  t ${best.s.t.toFixed(2).padStart(6)}  win ${(best.s.winRate * 100).toFixed(1).padStart(5)}%  be ${be.toFixed(1)}%  floor ${best.s.evUsd > FEE_USD ? "YES" : "no"}`);
      RESULTS[`F4 TOD hour ${hour} ${dir > 0 ? "long" : "short"}`] = { grid: best, stats: best.s };
    }
  }
  // The best hour, with the placebo and the per-symbol breakdown.
  rows.sort((a, b) => b.best.s.evUsd - a.best.s.evUsd);
  if (rows.length) {
    const top = rows[0];
    console.log(`\n   the best time-of-day cell: ${String(top.hour).padStart(2)}:00 UTC ${top.dir > 0 ? "LONG" : "SHORT"}`);
    report("F4 TOD", `hour ${top.hour}:00 UTC ${top.dir > 0 ? "LONG" : "SHORT"}`, genTimeOfDay({ hour: top.hour, dir: top.dir }), {
      tps: [0.5, 1.0, 2.0], stops: [0.5, 1.0, 1.5], holds: [8, 16, 32],
    });
  }
}

// ── F5 ──
if (FAMILY === "5" || FAMILY === "all") {
  console.log("\n" + "#".repeat(118));
  console.log("#  FAMILY 5 — CROSS-SECTIONAL: rank the universe each round, trade the extreme toward the mean");
  console.log("#".repeat(118));
  for (const mode of ["extreme", "both", "momentum"]) {
    for (const minSyms of [30, 40]) {
      const sigs = genCrossSectional({ mode, minSyms });
      report("F5 X-SECT", `${mode}, >= ${minSyms} symbols per round`, sigs, {
        tps: [0.5, 1.0, 1.5, 2.0, 3.0, 4.0], stops: [0, 0.5, 1.0, 1.5], holds: [8, 16, 32, 64],
      });
    }
  }
}

console.log("\n" + "═".repeat(118));
console.log("SUMMARY — the best geometry of every cell, by net EV in dollars per trade");
console.log("═".repeat(118));
const rows = Object.entries(RESULTS)
  .map(([k, v]) => ({ k, ...v }))
  .sort((a, b) => b.stats.evUsd - a.stats.evUsd);
console.log(`   ${"cell".padEnd(42)} ${"TP".padStart(5)} ${"SL".padStart(5)} ${"hold".padStart(5)} ${"n".padStart(5)} ${"clus".padStart(5)} ${"EV$".padStart(9)} ${"t".padStart(7)} ${"floor?".padStart(7)}`);
for (const r of rows) {
  console.log(`   ${r.k.slice(0, 42).padEnd(42)} ${String(r.grid.tpPct).padStart(5)} ${String(r.grid.stopPct).padStart(5)} ${String(r.grid.hold).padStart(5)} ${String(r.stats.n).padStart(5)} ${String(r.stats.clusters).padStart(5)} ${r.stats.evUsd.toFixed(4).padStart(9)} ${r.stats.t.toFixed(2).padStart(7)} ${(r.stats.evUsd > FEE_USD ? "YES" : "no").padStart(7)}`);
}
console.log(`\n   the fee floor is $${FEE_USD.toFixed(4)} per trade; a cell that does NOT say YES does not clear it.`);
console.log("");
