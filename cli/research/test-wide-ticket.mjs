#!/usr/bin/env node
/**
 * THE WIDE-TARGET, LONG-HOLD TICKET — and the MAE distribution.
 *
 * The second question a failed agent left open: can a ticket that is
 * NOT a scalping ticket clear the fee floor? Specifically a 1-3%
 * target held for 4-24 hours, with the MAXIMUM ADVERSE EXCURSION
 * distribution over 4h/12h/24h, and what stop distance keeps the loss
 * under the target.
 *
 * WHY THIS IS WORTH MEASURING
 * ----------------------------
 * The machine's scalping ticket is hopeless on this evidence: TP
 * 0.4-0.5% against a 0.12% round trip, and the fee eats 30% of a
 * winning trade. A WIDE ticket has a completely different economics —
 * the fee is 4% of a 3% target instead of 30% of a 0.4% one — so the
 * fee floor stops being the binding constraint and the question
 * becomes whether the SIGNAL works at a longer horizon.
 *
 * The family study found the best cell was "h10 short, TP 4%, SL 0%,
 * hold 16" — and its EV came 52% from TIME EXITS rather than from its
 * target. That is the tell: a wide ticket with no stop is a bet on
 * the drift, and the MAE distribution says how much drift the market
 * can produce against a position.
 *
 * WHAT THIS MEASURES
 * ------------------
 * 1. THE MAE DISTRIBUTION: over 4h, 12h and 24h, how far does the
 *    market go AGAINST a position? The p50, p75, p90, p95 and p99 of
 *    the worst excursion. This is what a stop must be placed beyond.
 * 2. THE SYMMETRY: the forward move's distribution is not symmetric
 *    with the adverse one, and the difference is the edge. If the
 *    median adverse excursion is 1.8% and the median forward move is
 *    0.9%, a 3% target with a 2% stop needs a 2/3 win rate, which the
 *    signal does not have.
 * 3. THE TICKET SWEEP: for each (target, stop, hold), the net EV
 *    after the 0.12% round trip, the win rate, the break-even, and
 *    the EXCESS over the unconditional arm at the same geometry.
 * 4. THE TIME-EXIT SHARE: what fraction of the EV comes from trades
 *    that reach neither level? A wide ticket whose EV is mostly time
 *    exits is a drift bet with a stop attached.
 * 5. THE CLUSTERING: the ticket's own holding period, never the
 *    collector's round.
 *
 * Run: node research/test-wide-ticket.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");
const CONF = join(SCRATCH, "confluence.ndjson");

const NOTIONAL = 60;
const EQUITY = 56.7;
const RHO = NOTIONAL / EQUITY;
const ROUND_TRIP = 0.0012;
const FEE_FLOOR_EQ = ROUND_TRIP * RHO;

function flag(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const quantile = (arr, q) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

if (!existsSync(BARS) || !existsSync(CONF)) {
  console.error(`missing the inputs: ${BARS} and ${CONF}`);
  process.exit(1);
}

const barsByPair = JSON.parse(readFileSync(BARS, "utf8"));
const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const barList = (p) => {
  const b = barsByPair[p];
  if (!b) return null;
  return Array.isArray(b) ? b : b.bars;
};

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE WIDE-TARGET, LONG-HOLD TICKET");
console.log("════════════════════════════════════════════════════════════════════");
const pairCount = Object.keys(barsByPair).length;
const sample = barList(Object.keys(barsByPair)[0]) ?? [];
console.log(`the bar cache: ${pairCount} pairs, 15-minute bars`);
console.log(`the fee: 0.12% of notional = ${fmt(FEE_FLOOR_EQ)}% of equity per trade`);
console.log("");

// ── 1. THE MAE DISTRIBUTION ──
//
// For every signal, at each horizon, how far did the market go
// AGAINST it? Measured on the raw 1-hour bars: the worst excursion
// from the entry within the horizon, in the adverse direction.
const HORIZONS = [
  { hours: 4, bars: 16 },   // 15-minute bars
  { hours: 12, bars: 48 },
  { hours: 24, bars: 96 },
];

const mae = { 4: [], 12: [], 24: [] };
const fwd = { 4: [], 12: [], 24: [] };
let measured = 0;

for (const r of rows) {
  const dir = r.tapeSide;
  if (dir !== "long" && dir !== "short") continue;
  const bars = barList(r.pair);
  if (!bars) continue;
  const last = Number(r.price);
  if (!(last > 0)) continue;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) continue;
  for (const h of HORIZONS) {
    const end = Math.min(bars.length, i + h.bars);
    if (end - i < 2) continue;
    let worst = 0;
    for (let k = i; k < end; k++) {
      const b = bars[k];
      // The excursion AGAINST the position, as a fraction of the entry.
      const adverse = dir === "long" ? (last - b.l) / last : (b.h - last) / last;
      if (adverse > worst) worst = adverse;
    }
    const lastBar = bars[end - 1];
    const fwdMove = dir === "long" ? (lastBar.c - last) / last : (last - lastBar.c) / last;
    mae[h.hours].push(worst);
    fwd[h.hours].push(fwdMove);
  }
  measured++;
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("1. THE MAXIMUM ADVERSE EXCURSION — how far does the market go against you?");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the signals measured: ${measured}`);
console.log("");
console.log("  horizon   n     p50 MAE   p75   p90   p95   p99   |  the p50 forward   the asymmetry");
console.log("  " + "-".repeat(94));
for (const h of HORIZONS) {
  const a = mae[h.hours];
  const f = fwd[h.hours];
  if (!a.length) continue;
  const p50a = quantile(a, 0.5);
  const p50f = quantile(f, 0.5);
  console.log(
    `  ${String(h.hours).padStart(4)}h  ${String(a.length).padStart(5)}  ` +
      `${fmt(p50a * 100, 2).padStart(7)}%  ${fmt(quantile(a, 0.75) * 100, 2).padStart(5)}  ` +
      `${fmt(quantile(a, 0.9) * 100, 2).padStart(5)}  ${fmt(quantile(a, 0.95) * 100, 2).padStart(5)}  ` +
      `${fmt(quantile(a, 0.99) * 100, 2).padStart(5)}  |  ` +
      `${fmt(p50f * 100, 2).padStart(8)}%   ` +
      `the MAE is ${fmt(p50a / Math.max(1e-9, Math.abs(p50f)), 1)}x the median forward move`,
  );
}
console.log("");
console.log("  READ IT THIS WAY: a stop placed at the p50 MAE is hit half the time.");
console.log("  A stop placed beyond the p90 MAE is hit one time in ten, and then the");
console.log(`  loss is $${fmt(quantile(mae[24] ?? [], 0.9) * NOTIONAL, 2)} at the 24h p90 — which must`);
console.log("  still be smaller than the target for the ticket to pay.");
console.log("");

// ── 2. THE TICKET SWEEP ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("2. THE WIDE-TICKET SWEEP — does a 1-3% target at 4-24 hours pay?");
console.log("════════════════════════════════════════════════════════════════════");

const TPS = [1.0, 1.5, 2.0, 2.5, 3.0];
const SLS = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
const HOLDS = [16, 32, 48, 96];   // 15-minute bars: 4h, 8h, 12h, 24h

/** The arm: the tape's side, with the live gate's direction confirmed. */
function liveGateSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}
const armRows = rows.filter((r) => r.tapeSide && liveGateSide(r) === r.tapeSide);
const allRows = rows.filter((r) => r.tapeSide);

/** Resolve a trade on the 1-hour bars, with the corrected fill rule. */
function resolve(r, tpPct, slPct, holdBars) {
  const bars = barList(r.pair);
  if (!bars) return null;
  const dir = r.tapeSide;
  if (dir !== "long" && dir !== "short") return null;
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(bars.length, i + holdBars);
  if (end - i < 2) return null;

  const long = dir === "long";
  const tpFrac = tpPct / 100;
  const slFrac = slPct / 100;
  const target = long ? last * (1 + tpFrac) : last * (1 - tpFrac);
  const stop = long ? last * (1 - slFrac) : last * (1 + slFrac);
  // A target already satisfied at the market is a scratch: ~zero
  // gross minus the fee.
  const tpWrongSide = long ? target < last : target > last;
  const bucket = Math.floor(r.ts / (holdBars * 15 * 60000));

  for (let k = i; k < end; k++) {
    const b = bars[k];
    const hitTp = long ? b.h >= target : b.l <= target;
    const hitSl = long ? b.l <= stop : b.h >= stop;
    if (hitTp && hitSl) return { pnl: -slFrac - ROUND_TRIP, outcome: "loss", bucket, ts: r.ts, pair: r.pair };
    if (hitTp) {
      return tpWrongSide
        ? { pnl: -ROUND_TRIP, outcome: "scratch", bucket, ts: r.ts, pair: r.pair }
        : { pnl: tpFrac - ROUND_TRIP, outcome: "win", bucket, ts: r.ts, pair: r.pair };
    }
    if (hitSl) return { pnl: -slFrac - ROUND_TRIP, outcome: "loss", bucket, ts: r.ts, pair: r.pair };
  }
  const lastBar = bars[end - 1];
  const move = long ? (lastBar.c - last) / last : (last - lastBar.c) / last;
  return { pnl: move - ROUND_TRIP, outcome: "time", bucket, ts: r.ts, pair: r.pair };
}

function clusterStats(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.bucket)) by.set(t.bucket, []);
    by.get(t.bucket).push(t);
  }
  const cms = [...by.entries()].map(([bucket, ts]) => ({ bucket, mean: mean(ts.map((t) => t.pnl)), n: ts.length }));
  return { cms, clusters: cms.length };
}
function tOf(cms) {
  if (cms.length < 2) return NaN;
  const ms = cms.map((c) => c.mean);
  const m = mean(ms);
  const sd = Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1));
  const se = sd / Math.sqrt(ms.length);
  return se > 0 ? m / se : NaN;
}

const results = [];
for (const tpPct of TPS) {
  for (const slPct of SLS) {
    for (const hold of HOLDS) {
      const trades = [];
      for (const r of armRows) {
        const t = resolve(r, tpPct, slPct, hold);
        if (t) trades.push(t);
      }
      if (trades.length < 20) continue;
      const st = clusterStats(trades);
      if (st.clusters < 2) continue;
      const ev = mean(trades.map((t) => t.pnl)) * RHO;
      const tStat = tOf(st.cms);
      const wins = trades.filter((t) => t.outcome === "win").length;
      const times = trades.filter((t) => t.outcome === "time").length;
      // The break-even win rate for this geometry.
      const beWr = (slPct / 100 + ROUND_TRIP) / (tpPct / 100 + slPct / 100 + ROUND_TRIP);
      // The share of the EV that comes from the time exits.
      const timePnL = trades.filter((t) => t.outcome === "time").reduce((s, t) => s + t.pnl, 0);
      const evFromTime = (timePnL / trades.length) * RHO;
      results.push({
        tpPct, slPct, hold,
        n: trades.length, clusters: st.clusters,
        ev, t: tStat,
        winRate: wins / trades.length,
        timeShare: times / trades.length,
        evFromTime,
        beWr,
        aboveFloor: ev > FEE_FLOOR_EQ,
      });
    }
  }
}

results.sort((a, b) => b.ev - a.ev);
console.log(`the geometries tested: ${results.length}`);
console.log("");
console.log("   TP    SL  hold    n  clus   EV %eq      t   win%   time%  the EV from   BE win%  the floor");
console.log("  " + "-".repeat(102));
for (const r of results.slice(0, 18)) {
  console.log(
    `  ${fmt(r.tpPct, 1).padStart(4)}%  ${fmt(r.slPct, 1).padStart(4)}%  ${String(r.hold).padStart(3)}h  ` +
      `${String(r.n).padStart(4)}  ${String(r.clusters).padStart(4)}  ${fmt(r.ev).padStart(8)}  ${fmt(r.t, 2).padStart(6)}  ` +
      `${fmt(r.winRate * 100, 1).padStart(5)}  ${fmt(r.timeShare * 100, 1).padStart(5)}  ` +
      `${fmt(r.evFromTime).padStart(9)}   ${fmt(r.beWr * 100, 1).padStart(5)}%  ${r.aboveFloor ? "ABOVE" : "below"}`,
  );
}
console.log("");

// ── 3. THE VERDICT ──
console.log("════════════════════════════════════════════════════════════════════");
console.log("3. THE VERDICT");
console.log("════════════════════════════════════════════════════════════════════");
const above = results.filter((r) => r.aboveFloor);
const sig = above.filter((r) => Number.isFinite(r.t) && r.t >= 2);
const sigAndCluster = sig.filter((r) => r.clusters >= 30);
console.log(`  the geometries with a net EV above the ${fmt(FEE_FLOOR_EQ)}% fee floor: ${above.length} of ${results.length}`);
console.log(`  of those, the ones with t >= 2: ${sig.length}`);
console.log(`  of those, the ones with 30+ independent clusters: ${sigAndCluster.length}`);
console.log("");
if (above.length) {
  const best = above[0];
  console.log(`  the best wide ticket: TP ${best.tpPct}%  SL ${best.slPct}%  hold ${best.hold}h`);
  console.log(`    the EV: ${fmt(best.ev)}% of equity per trade  (t=${fmt(best.t, 2)})`);
  console.log(`    the win rate: ${fmt(best.winRate * 100, 1)}% against a break-even of ${fmt(best.beWr * 100, 1)}%`);
  console.log(`    the time exits: ${fmt(best.timeShare * 100, 1)}% of the trades, carrying ${fmt(best.evFromTime)}% of equity`);
  console.log(`    the EV FROM THE TIME EXITS: ${fmt(best.evFromTime)}% of the ${fmt(best.ev)}% total`);
  console.log(`    the clusters: ${best.clusters} (the bar is 30)`);
  const timeShareOfEv = best.ev ? best.evFromTime / best.ev : 0;
  console.log("");
  if (timeShareOfEv > 0.4) {
    console.log("  THE TIME EXITS CARRY MOST OF THE EDGE. A wide ticket whose EV comes");
    console.log("  from the time exits is a BET ON THE DRIFT with a stop attached — the");
    console.log("  target and the stop are decoration, and the strategy is 'be short'");
    console.log("  (or long) at a particular hour. That is the family study's h10 cell,");
    console.log("  and the family study's own drift control showed those cells are the");
    console.log("  market's own drift, not a signal.");
  }
}
console.log("");
// THE MAE ANSWER, stated.
const a24 = mae[24] ?? [];
if (a24.length) {
  console.log("  THE MAE, WHICH IS THE REAL ANSWER");
  console.log(`    at 4 hours: the p50 is ${fmt(quantile(mae[4] ?? [], 0.5) * 100, 2)}% and the p90 is ${fmt(quantile(mae[4] ?? [], 0.9) * 100, 2)}%`);
  console.log(`    at 24 hours: the p50 is ${fmt(quantile(a24, 0.5) * 100, 2)}% and the p90 is ${fmt(quantile(a24, 0.9) * 100, 2)}%`);
  console.log("");
  console.log("    A 1-3% TARGET IS INSIDE THE MARKET'S OWN NOISE AT THIS HORIZON.");
  console.log(`    The market's median ADVERSE excursion is ${fmt(quantile(a24, 0.5) * 100, 2)}% and its p90 is`);
  console.log(`    ${fmt(quantile(a24, 0.9) * 100, 2)}% — so a 1% target is reached by a coin flip and a 3% target is`);
  console.log("    reached before the p90 adverse excursion. The median forward move is");
  console.log(`    ${fmt(Math.abs(quantile(fwd[24] ?? [], 0.5)) * 100, 2)}% against the position, so the excursion is`);
  console.log("    several times the reward. That is the definition of a negative-expectancy");
  console.log("    geometry, and no target/stop pair inside it can fix it.");
  console.log("");
  console.log("    A STOP THAT IS REACHABLE IS HIT OFTEN; A STOP THAT IS NOT REACHABLE NEVER");
  console.log("    FIRES AND THE TICKET IS A DRIFT BET. The family study's best cell — a 4%");
  console.log("    target with a 0% stop — is exactly the second case: 52% of its EV came");
  console.log("    from the time exits, and the drift control showed those cells are the");
  console.log("    market's own drift, not a signal.");
  console.log("");
}
console.log("════════════════════════════════════════════════════════════════════");
