#!/usr/bin/env node
/**
 * The funding/OI analysis — the one lead that needs forward-collected data.
 *
 * WHY THIS IS SEPARATE FROM THE BACKTESTER
 * ----------------------------------------
 * KuCoin's public API exposes `openInterest` on the contract record, but
 * only as a CURRENT snapshot: there is no historical OI endpoint. So the
 * edge hunt (which used klines only) could not test this family, and the
 * `collect-funding-oi.mjs` collector gathers it going forward.
 *
 * THE HYPOTHESIS
 * --------------
 * A symbol whose funding is extreme against the crowd (longs paying, i.e.
 * funding strongly POSITIVE) AND whose open interest is RISING is
 * over-levered long: new money is joining a crowded long, paying a
 * premium to hold it. When that crowding unwinds, price falls.
 *
 * So: SHORT when funding is extreme-positive AND OI is rising.
 *
 * THE CONTROLS (this is the part that matters)
 * ----------------------------------------------
 * A backtest that only shows "the signal made money" proves nothing —
 * the earlier lead-lag lead looked excellent until it was compared
 * against an unconditional long and turned out to be market beta. So
 * every measurement here carries its control:
 *
 *   1. THE UNCONDITIONAL BASELINE. The same symbols, the same windows,
 *      held in the OPPOSITE direction. If the signal is just beta, the
 *      reversed version earns about the same.
 *   2. THE PER-SIDE BREAKDOWN. A signal that only works one way is
 *      half an edge.
 *   3. THE FEE. Funding is charged to the holder; the round-trip taker
 *      fee is 0.12% of notional. A gross edge below that is not an edge.
 *   4. THE SAMPLE SIZE. With 15-minute samples, a few days is a
 *      handful of observations per symbol. The analysis reports n
 *      honestly and refuses to call anything viable below it.
 *
 * USAGE
 *   node analyze-funding-oi.mjs --data ~/.hermes/cache/scratch/funding-oi.ndjson
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const DATA = flag("data", join(homedir(), ".hermes/cache/scratch/funding-oi.ndjson"));
const TAKER_RT = 0.12; // percent of notional, round trip
const FUNDING_RT = 0.12; // percent of notional per 8h, charged to the holder
const MIN_N = 30; // below this, nothing is claimed

if (!existsSync(DATA)) {
  console.error(`[analysis] no data at ${DATA} — run the collector first`);
  process.exit(1);
}

const rows = readFileSync(DATA, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// ── shape ────────────────────────────────────────────────────────────────
const bySymbol = new Map();
const rounds = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
for (const r of rows) {
  if (!bySymbol.has(r.base)) bySymbol.set(r.base, []);
  bySymbol.get(r.base).push(r);
}
for (const [, list] of bySymbol) list.sort((a, b) => a.ts - b.ts);

const spanMin = (rounds[rounds.length - 1] - rounds[0]) / 60000;
console.log(`[analysis] ${rows.length} rows | ${bySymbol.size} symbols | ${rounds.length} rounds | ${spanMin.toFixed(0)} min span`);

if (rounds.length < 4) {
  console.log("[analysis] too few rounds to measure anything. The collector needs time.");
  process.exit(0);
}

// ── the funding/OI features, per symbol, per round ──────────────────────
//
// The SIGNALS need a comparable scale, so the features are CROSS-SECTIONAL
// RANKS: a symbol's funding relative to the OTHER symbols at the same
// instant, and its OI change relative to its own recent history.
//
// WHY A RANK AND NOT A Z-SCORE
// ----------------------------
// A parametric z-score is destroyed by a single outlier. MEW's funding
// sits at -0.0129 while the rest of the universe is at +0.00005 — a
// 250x gap. The mean and standard deviation are set entirely by that
// one symbol, so every other symbol's z-score collapses into a band of
// roughly [-0.5, +0.5] and a threshold of "z > 1" can NEVER fire, for
// any symbol, ever. The measurement silently produced an empty sample
// while looking like it was working.
//
// A rank is immune to that by construction: the extreme symbol is simply
// rank 1 of 45, and the threshold is a position in the distribution, not
// a distance from a mean that one point controls.
const rankByRound = new Map();
for (const t of rounds) {
  const inRound = rows.filter((r) => r.ts === t);
  const sorted = [...inRound].sort((a, b) => a.funding - b.funding);
  const m = new Map();
  sorted.forEach((r, i) => m.set(r.base, (i + 1) / inRound.length));
  rankByRound.set(t, m);
}

const features = []; // {ts, base, fundRank, oiChgPct, price, oi, fundingRate}
for (const [base, list] of bySymbol) {
  for (let i = 1; i < list.length; i++) {
    const oiPrev = list[i - 1].oi;
    const oi = list[i].oi;
    if (!(oiPrev > 0) || !(oi > 0) || !(list[i].price > 0)) continue;
    const oiChgPct = ((oi - oiPrev) / oiPrev) * 100;
    const fundRank = rankByRound.get(list[i].ts)?.get(base);
    if (fundRank == null) continue;
    features.push({
      ts: list[i].ts,
      base,
      fundRank,
      oiChgPct,
      price: list[i].price,
      oi,
      fundingRate: list[i].funding,
    });
  }
}
console.log(`[analysis] ${features.length} usable observations`);

// ── the forward return, from the collected prices ───────────────────────
//
// The collector samples every 15 minutes, so the "forward return" over
// the next sample is a 15-minute move — a real, measurable, and (for a
// 15-minute hold) fee-relevant horizon. This is the honest test: can a
// funding/OI extreme predict the NEXT 15 minutes, net of the funding
// paid and the taker fee?
function forwardReturn(base, ts, barsAhead) {
  const list = bySymbol.get(base);
  if (!list) return null;
  const i = list.findIndex((r) => r.ts === ts);
  if (i < 0 || i + barsAhead >= list.length) return null;
  const p0 = list[i].price;
  const p1 = list[i + barsAhead].price;
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return { ret: ((p1 - p0) / p0) * 100, bars: barsAhead };
}

// ── the measurement ─────────────────────────────────────────────────────
//
// TWO CORRECTIONS, both learned the hard way.
//
// 1. THE t-STATISTIC MUST TEST THE EXCESS, NOT THE SIGNAL.
//    The old code computed `t = s.mean / s.se` — the RAW signal's mean
//    over its own standard error. That measures the signal's
//    DIRECTIONAL return, which is a question nobody asked, while the
//    bar asks whether the EXCESS over the unconditional baseline is
//    real. The two disagree: the old run printed "excess
//    +0.0007pp, t=-2.69" — a positive excess with a strongly NEGATIVE
//    t, because the t belonged to a different quantity. The excess is
//    now tested directly, on the PAIRED difference.
//
// 2. ROWS ARE NOT OBSERVATIONS.
//    The collector samples 45 symbols every 15 minutes, so all the
//    symbols in one round move TOGETHER. Treating them as independent
//    overstates the evidence and the t-statistic silently measures the
//    CLUSTER SIZE. The old run reported n=369 and n=492 — those are
//    ROW counts (17 rounds x ~22-27 qualifying symbols), not
//    observations. The independent sample is the ROUND: 17.
//
// So the excess is measured as the paired difference
// (signal row - ITS OWN unconditional baseline row), averaged within
// each round, and the t-statistic is computed on the per-round means.
function measure(pick, label) {
  // Each entry carries its round, so the per-round means can be built.
  const arms = { signal: [], reversed: [], unconditional: [] };
  const perRound = new Map(); // round -> { sel: [], all: [], rev: [], diffs: [], peer }
  for (const f of features) {
    // The filter defines the SIGNAL; the universe defines the BASELINE.
    // A baseline built only from the selected rows is the signal again.
    const selected = pick(f);
    for (const ahead of [1, 2, 4]) {
      const fw = forwardReturn(f.base, f.ts, ahead);
      if (!fw) continue;
      const dir = -1; // the signal is a SHORT
      const gross = dir * fw.ret;
      // Funding: a positive funding rate is paid by LONGS. A short
      // RECEIVES it. Over `ahead` 15-minute bars.
      const fundingPct = (f.fundingRate ?? 0) * 100 * (ahead * 15 / 480);
      // ── THE ARMS, AND WHY EACH ONE EXISTS ──
      //
      // The signal: SHORT a symbol whose funding is extreme against
      // the crowd (longs pay) — optionally conditioned on OI.
      //
      //   signal       = the selected short, with the funding it RECEIVES
      //   unconditional = ALWAYS SHORT the same symbol over the same
      //                 window, with the funding it receives
      //   reversed     = always LONG, the opposite bet
      //
      // ── THE FIRST BUG: A DEGENERATE BASELINE ──
      // The original baseline was `-fw.ret - TAKER_RT`: the same trade
      // WITHOUT the funding receipt. The paired difference was then
      // EXACTLY the funding term — an ARITHMETIC IDENTITY, not a
      // measurement, which is why every variant printed a tiny
      // positive excess with an enormous t. (The same defect killed
      // the conflict study's first arms.)
      //
      // ── THE SECOND BUG: A BASELINE THAT IS THE SAME TRADE ──
      // Adding the funding to that baseline made it identical to the
      // signal arm, so the excess became exactly 0.0000 — a perfect
      // null, which is equally uninformative.
      //
      // ── THE DESIGN THAT WORKS ──
      // The claim a funding/OI signal makes is: "SELECTING the extreme
      // funding symbols gives a BETTER short than shorting everything".
      // So the baseline must be the SAME DIRECTION on the SAME SYMBOL
      // over the SAME window — only the SELECTION differs. The funding
      // then cancels out of the paired difference by construction
      // (both arms receive it), which is exactly right: funding is a
      // cash flow of holding a short, not a signal.
      const net = gross - TAKER_RT + fundingPct;
      const rev = -gross - TAKER_RT + fundingPct;
      const uncond = gross - TAKER_RT + fundingPct; // always short
      if (selected) {
        arms.signal.push(net);
        arms.reversed.push(rev);
      }
      // The baseline arm covers EVERY symbol in the round, selected or
      // not — the round's CROSS-SECTION.
      arms.unconditional.push(uncond);
      // Per-round bookkeeping: the selected rows' net, and the round's
      // own mean. The paired difference is against the ROUND's peer
      // group, not against the symbol itself.
      //
      // ── WHY THE PEER GROUP ──
      // A baseline built from the SAME SYMBOL is the same trade, so
      // the difference is identically zero. A baseline built from the
      // whole round is the market's drift, which every symbol shares.
      // The MEAN of the OTHER symbols in the same round is the peer
      // group: the market's drift, estimated from the symbols that
      // did NOT pass the filter. Subtracting it leaves the selected
      // symbol's own move, with the market's move removed.
      if (!perRound.has(f.ts)) perRound.set(f.ts, { sel: [], all: [], rev: [], diffs: [], peer: 0 });
      const bucket = perRound.get(f.ts);
      bucket.all.push(uncond);
      if (selected) {
        bucket.sel.push(net);
        bucket.rev.push(rev);
      }
    }
  }
  // The per-round PEER means: the mean of the UNSELECTED symbols in the
  // same round, at the same horizon.
  for (const [, bucket] of perRound) {
    const selCount = bucket.sel.length;
    const allSum = bucket.all.reduce((a, b) => a + b, 0);
    const selSum = bucket.sel.reduce((a, b) => a + b, 0);
    const peerCount = bucket.all.length - selCount;
    if (peerCount < 3) {
      // Too few peers for a cross-sectional baseline — the round
      // cannot support the comparison.
      bucket.diffs = [];
      continue;
    }
    const peerMean = (allSum - selSum) / peerCount;
    bucket.peer = peerMean;
    for (const net of bucket.sel) bucket.diffs.push(net - peerMean);
  }
  const stat = (xs) => {
    if (!xs.length) return { n: 0, mean: 0, se: 0, win: 0 };
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
    return { n: xs.length, mean: m, se: sd / Math.sqrt(xs.length), win: (xs.filter((x) => x > 0).length / xs.length) * 100 };
  };
  const s = stat(arms.signal);
  const r = stat(arms.reversed);
  const u = stat(arms.unconditional);

  // The per-round means of the paired difference.
  const roundMeans = [];
  for (const [, bucket] of perRound) {
    // A round with no qualifying row contributes NO cluster — it is
    // not a zero, and dividing by zero would poison the mean.
    if (!bucket.diffs.length) continue;
    const m = bucket.diffs.reduce((a, b) => a + b, 0) / bucket.diffs.length;
    roundMeans.push(m);
  }
  const rm = stat(roundMeans);
  const excess = s.mean - u.mean;
  // The t-statistic of the EXCESS, on the cluster means.
  const t = rm.se > 0 ? rm.mean / rm.se : 0;
  const clusters = roundMeans.length;

  console.log(`\n  ${label}`);
  console.log(`    signal (short)   n=${String(s.n).padStart(5)}  net ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(4)}%/obs  win ${s.win.toFixed(1)}%  se ${s.se.toFixed(4)}`);
  console.log(`    REVERSED (long)  n=${String(r.n).padStart(5)}  net ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(4)}%/obs  win ${r.win.toFixed(1)}%`);
  console.log(`    UNCONDITIONAL    n=${String(u.n).padStart(5)}  net ${u.mean >= 0 ? "+" : ""}${u.mean.toFixed(4)}%/obs  win ${u.win.toFixed(1)}%`);
  console.log(`    EXCESS over the unconditional baseline: ${excess >= 0 ? "+" : ""}${excess.toFixed(4)}pp`);
  console.log(`    CLUSTERS: ${clusters} rounds | cluster-mean excess ${rm.mean >= 0 ? "+" : ""}${rm.mean.toFixed(4)}pp  se ${rm.se.toFixed(4)}  ->  t=${t.toFixed(2)}`);
  const verdict =
    clusters < MIN_N ? `NOT ENOUGH DATA (${clusters} clusters < ${MIN_N})`
    : excess <= 0 ? "NO EXCESS — the signal is beta"
    : t < 2 ? `excess is positive but not significant (t=${t.toFixed(2)})`
    : `EXCESS EDGE (t=${t.toFixed(2)}, ${clusters} clusters)`;
  console.log(`    => ${verdict}`);
  return { label, ...s, excess, reversed: r.mean, unconditional: u.mean, t, clusters, clusterMeanExcess: rm.mean };
}

console.log("\n[analysis] THE TEST — a short when funding is extreme-positive and OI is rising");

// The funding RANK is ascending: rank 1 = the LOWEST funding (shorts
// pay), rank 1.0 = the HIGHEST funding (longs pay). A crowded long is
// the HIGH end, so the signal fires on a HIGH rank.
//
// (A POSITIVE funding rate is paid BY the long holder, so a high
// positive funding rate means longs are crowded and paying.)
const results = [];
results.push(measure((f) => f.fundRank > 0.8 && f.oiChgPct > 0.0, "funding rank > 0.8 (top 20%) and OI rising"));
results.push(measure((f) => f.fundRank > 0.9 && f.oiChgPct > 0.0, "funding rank > 0.9 (top 10%) and OI rising"));
results.push(measure((f) => f.fundRank > 0.8 && f.oiChgPct > 0.25, "funding rank > 0.8 and OI up > 0.25%"));
results.push(measure((f) => f.fundRank > 0.8, "funding rank > 0.8 (no OI filter)"));
results.push(measure((f) => f.fundRank > 0.5 && f.oiChgPct > 0.0, "funding rank > 0.5 and OI rising"));
results.push(measure((f) => f.fundRank > 0.8 && f.oiChgPct < 0, "funding rank > 0.8 and OI FALLING (the crowded-unwind variant)"));

// ── the verdict ─────────────────────────────────────────────────────────
const viable = results.filter((r) => r.clusters >= MIN_N && r.excess > 0 && r.t >= 2);
console.log(`\n[analysis] VERDICT: ${viable.length} of ${results.length} variants clear the bar (>=${MIN_N} INDEPENDENT CLUSTERS, excess>0, t>=2)`);
if (viable.length === 0) {
  const best = results.filter((r) => r.clusters >= MIN_N).sort((a, b) => b.excess - a.excess)[0];
  if (best) {
    console.log(`[analysis] The best variant is "${best.label}" with an excess of ${best.excess.toFixed(4)}pp (t=${best.t.toFixed(2)}, ${best.clusters} clusters).`);
  }
  console.log(`[analysis] NOT ENOUGH HISTORY YET — ${rounds.length} rounds over ${spanMin.toFixed(0)} minutes.`);
  console.log(`[analysis] The collector keeps running; re-run this when there are days of history.`);
  console.log(`[analysis] A positive excess at a SMALL n is not a finding — it is the same selection artefact the edge hunt found.`);
} else {
  for (const v of viable) console.log(`[analysis]   ${v.label}: excess ${v.excess.toFixed(4)}pp, t=${v.t.toFixed(2)}, n=${v.n}`);
}
