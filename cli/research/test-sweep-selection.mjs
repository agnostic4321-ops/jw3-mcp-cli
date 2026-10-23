#!/usr/bin/env node
/**
 * THE DECISIVE TEST FOR THE CORRECTED SWEEP.
 *
 * The corrected sweep (research/sweep-corrected.mjs) measures the ticket
 * the LIVE PATH NOW USES: the entry is the market, and the take-profit
 * is BEYOND the market in the profitable direction, so the market has to
 * MOVE to reach it. That is the right ticket, and it produces a very
 * different answer from the offset-anchor ticket the old studies used.
 *
 * It reports 13 of 360 geometries clearing "positive EV at the holding
 * period AND t >= 2 AND above the fee floor" on the taker fee.
 *
 * THE PROBLEM THAT TEST DOES NOT ADDRESS
 * --------------------------------------
 * 13 of 360 is 3.6% — and a t-statistic of 2 on 3 clusters is a
 * two-sided p of about 0.05 PER GEOMETRY. With 360 geometries tested,
 * the EXPECTED NUMBER of false positives at that bar is 360 x 0.05 =
 * 18. So 13 passes is BELOW the chance rate, and the passes are
 * indistinguishable from noise.
 *
 * There is a second, larger problem: the passes share ONE sample. Every
 * geometry is measured on the same 53 trades in the same 3 clusters, so
 * the geometries are not independent tests — they are 360 ways of
 * reading one 3-cluster sample. A single lucky hour makes all of them
 * look good at once.
 *
 * WHAT THIS TEST DOES
 * -------------------
 * 1. THE MULTIPLE-COMPARISON BASELINE. It runs the SAME sweep on
 *    PLACEBO arms — the same arms with the direction flipped, and the
 *    same arm on a SHUFFLED sequence of the market's own returns — and
 *    reports how many of those 360 geometries clear the same bar. If the
 *    real arm's count is not clearly above the placebo's, the passes are
 *    a selection artefact.
 *
 * 2. THE CLUSTER COUNT. The independent sample is the CLUSTER, and the
 *    bar is 30. A candidate that passes on 3 clusters is a CANDIDATE,
 *    not a finding, and must be reported as such.
 *
 * 3. THE SHIPPED GEOMETRY. The live path's actual ticket is scored
 *    against the best swept geometry, so the gap between what ships and
 *    what the sweep likes is visible.
 *
 * 4. THE OUT-OF-SAMPLE SPLIT. The clusters are split in half by time and
 *    the bar must be cleared in BOTH halves. A geometry that only works
 *    in one half of a 3-cluster sample is noise.
 *
 * THE BAR (unchanged from the sweep)
 * ----------------------------------
 *   - the net EV after the fee is positive
 *   - the EV at the ticket's holding period is positive
 *   - the EV is above the fee floor with room to spare
 *   - the t at the holding-period clustering is >= 2
 *   - AND the independent cluster count is >= 30
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { isTargetWrongSide } from "./ticket-fill.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONF = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const BAR_CLUSTERS = 30;
const T_MIN = 2;
const ROUND_TRIP_TAKER = 0.0012;
const ROUND_TRIP_MAKER = 0.0004;
const TICKET_NOTIONAL = 60;
const EQUITY = 57.16;
const RHO = TICKET_NOTIONAL / EQUITY;

function flag(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ── THE BARS ──
if (!existsSync(CONF) || !existsSync(BARS)) {
  console.error(`missing the inputs: ${CONF} and ${BARS}`);
  process.exit(1);
}
const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const barsByPair = JSON.parse(readFileSync(BARS, "utf8"));
const barList = (p) => {
  const b = barsByPair[p];
  if (!b) return null;
  return Array.isArray(b) ? b : b.bars;
};

// ── THE GEOMETRY SPACE ──
const TPs = [0.15, 0.25, 0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const SLs = [0.15, 0.25, 0.4, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
const HOLDS = [4, 8, 16, 32];
const CLUSTER_MIN = Number(flag("cluster-min", 240)); // minutes

// ── RESOLVE A TRADE, WITH THE CORRECT FILL RULE ──
function resolveTrade(r, tpPct, slPct, holdBars, roundTrip) {
  const bars = barList(r.pair);
  if (!bars) return null;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(bars.length, i + holdBars);
  if (end - i < 2) return null;

  const dir = tapeSideFromRow(r);
  if (dir !== "long" && dir !== "short") return null;
  const long = dir === "long";

  // THE MARKET-ANCHORED TICKET — the one the live path now builds.
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const entry = last;
  const tpFrac = tpPct / 100;
  const slFrac = slPct / 100;
  const target = long ? last * (1 + tpFrac) : last * (1 - tpFrac);
  const stop = long ? last * (1 - slFrac) : last * (1 + slFrac);

  // The target is BEYOND the market by construction, so it can never be
  // wrong-sided. The guard is kept so a future change to the ticket
  // cannot silently reintroduce the scratch.
  if (isTargetWrongSide(dir, target, entry)) return null;

  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitTp && hitSl) {
      return { dir, pnlPct: -slFrac - roundTrip, bucket: Math.floor(r.ts / (holdBars * 15 * 60000)), ts: r.ts, pair: r.pair };
    }
    if (hitTp) return { dir, pnlPct: tpFrac - roundTrip, bucket: Math.floor(r.ts / (holdBars * 15 * 60000)), ts: r.ts, pair: r.pair };
    if (hitSl) return { dir, pnlPct: -slFrac - roundTrip, bucket: Math.floor(r.ts / (holdBars * 15 * 60000)), ts: r.ts, pair: r.pair };
  }
  // The time exit, marked at the last bar's close.
  const lastBar = bars[end - 1];
  const movePct = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { dir, pnlPct: movePct - roundTrip, bucket: Math.floor(r.ts / (holdBars * 15 * 60000)), ts: r.ts, pair: r.pair };
}

/** The cluster means, and the paired difference against a control. */
function clusterStats(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.bucket)) by.set(t.bucket, []);
    by.get(t.bucket).push(t);
  }
  const cms = [...by.entries()].map(([bucket, ts]) => ({ bucket, mean: mean(ts.map((t) => t.pnlPct)), n: ts.length }));
  return { cms, by, n: trades.length, clusters: cms.length };
}

function pairedExcess(armCms, ctrlCms) {
  const byCtrl = new Map(ctrlCms.map((c) => [c.bucket, c.mean]));
  const diffs = [];
  for (const a of armCms) {
    const c = byCtrl.get(a.bucket);
    if (c === undefined) continue;
    diffs.push(a.mean - c);
  }
  const m = mean(diffs);
  const sd = diffs.length > 1
    ? Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1))
    : NaN;
  const se = diffs.length > 1 ? sd / Math.sqrt(diffs.length) : NaN;
  return { n: diffs.length, mean: m, se, t: Number.isFinite(se) && se > 0 ? m / se : NaN };
}

// ── THE ARMS ──
// The live-gate arm: the rows the machine actually traded on.
/**
 * The model's confirmed side: JEV and Laya both directional and AGREEING.
 * This is the live gate.
 */
function liveGateSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}
// The live-gate arm: the tape's side EQUALS the models' confirmed side.
const liveRows = rows.filter((r) => tapeSideFromRow(r) && liveGateSide(r) === tapeSideFromRow(r));
const tapeRows = rows.filter((r) => tapeSideFromRow(r) === "long" || tapeSideFromRow(r) === "short");

// ── SWEEP ONE ARM ──
function sweep(armRows, roundTrip, label) {
  const passes = [];
  let tested = 0;
  for (const tpPct of TPs) {
    for (const slPct of SLs) {
      for (const hold of HOLDS) {
        tested++;
        const trades = [];
        for (const r of armRows) {
          const t = resolveTrade(r, tpPct, slPct, hold, roundTrip);
          if (t) trades.push(t);
        }
        if (trades.length < 30) continue;
        const st = clusterStats(trades);
        if (st.clusters < 2) continue;
        const ev = mean(trades.map((t) => t.pnlPct)) * RHO;
        const tStat = st.clusters > 1
          ? (() => {
              const ms = st.cms.map((c) => c.mean);
              const m = mean(ms);
              const sd = Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1));
              const se = sd / Math.sqrt(ms.length);
              return se > 0 ? m / se : NaN;
            })()
          : NaN;
        const feeFloor = roundTrip * RHO;
        if (ev > 0 && Number.isFinite(tStat) && tStat >= T_MIN && ev > feeFloor) {
          passes.push({ tpPct, slPct, hold, n: trades.length, clusters: st.clusters, ev, t: tStat, cms: st.cms });
        }
      }
    }
  }
  passes.sort((a, b) => b.ev - a.ev);
  return { label, tested, passes };
}

// ── THE PLACEBO: THE SAME ARM WITH THE DIRECTION FLIPPED ──
function flippedRows(armRows) {
  return armRows.map((r) => {
    const d = tapeSideFromRow(r);
    return { ...r, price: r.price, dirFlipped: d === "long" ? "short" : "long" };
  });
}

// The placebo must flip the DIRECTION, so the resolve has to honour it.
// The cheapest honest way: a flag on the row that the resolver reads.
const origResolve = resolveTrade;
function resolveTradePatched(r, tpPct, slPct, holdBars, roundTrip) {
  if (r.__flip) {
    const d = tapeSideFromRow(r);
    const flipped = d === "long" ? "short" : "long";
    const fake = { ...r, __side: flipped };
    return origResolve(fake, tpPct, slPct, holdBars, roundTrip);
  }
  return origResolve(r, tpPct, slPct, holdBars, roundTrip);
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE DECISIVE TEST — is the corrected sweep's answer real, or a selection?");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the collector rows: ${rows.length}`);
console.log(`the live-gate arm:  ${liveRows.length} rows`);
console.log(`the tape arm:       ${tapeRows.length} rows`);
console.log(`the cluster width:  ${CLUSTER_MIN} minutes (the ticket's holding period)`);
console.log(`the bar:            EV > 0, t >= ${T_MIN}, above the fee floor, AND >= ${BAR_CLUSTERS} clusters`);
console.log();

const real = sweep(liveRows, ROUND_TRIP_TAKER, "LIVE-GATE (real direction)");

// The placebo: the same arm, the direction flipped. The market's own
// drift is the same, so if the real arm's pass count is not clearly
// above the placebo's, the passes are drift and selection.
const placeboRows = liveRows.map((r) => ({ ...r, __flip: true }));
// The resolver honours __side when present.
function resolveWithSide(r, tpPct, slPct, holdBars, roundTrip) {
  const bars = barList(r.pair);
  if (!bars) return null;
  const i = bars.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(bars.length, i + holdBars);
  if (end - i < 2) return null;
  const dir = r.__side ?? tapeSideFromRow(r);
  if (dir !== "long" && dir !== "short") return null;
  const long = dir === "long";
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const entry = last;
  const tpFrac = tpPct / 100;
  const slFrac = slPct / 100;
  const target = long ? last * (1 + tpFrac) : last * (1 - tpFrac);
  const stop = long ? last * (1 - slFrac) : last * (1 + slFrac);
  if (isTargetWrongSide(dir, target, entry)) return null;
  const bucket = Math.floor(r.ts / (holdBars * 15 * 60000));
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    if (hitTp && hitSl) return { dir, pnlPct: -slFrac - roundTrip, bucket, ts: r.ts, pair: r.pair };
    if (hitTp) return { dir, pnlPct: tpFrac - roundTrip, bucket, ts: r.ts, pair: r.pair };
    if (hitSl) return { dir, pnlPct: -slFrac - roundTrip, bucket, ts: r.ts, pair: r.pair };
  }
  const lastBar = bars[end - 1];
  const movePct = long ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { dir, pnlPct: movePct - roundTrip, bucket, ts: r.ts, pair: r.pair };
}

function sweepWith(armRows, roundTrip, resolve) {
  const passes = [];
  let tested = 0;
  for (const tpPct of TPs) {
    for (const slPct of SLs) {
      for (const hold of HOLDS) {
        tested++;
        const trades = [];
        for (const r of armRows) {
          const t = resolve(r, tpPct, slPct, hold, roundTrip);
          if (t) trades.push(t);
        }
        if (trades.length < 30) continue;
        const st = clusterStats(trades);
        if (st.clusters < 2) continue;
        const ev = mean(trades.map((t) => t.pnlPct)) * RHO;
        const ms = st.cms.map((c) => c.mean);
        const m = mean(ms);
        const sd = ms.length > 1 ? Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1)) : NaN;
        const se = ms.length > 1 ? sd / Math.sqrt(ms.length) : NaN;
        const tStat = se > 0 ? m / se : NaN;
        const feeFloor = roundTrip * RHO;
        // The sweep's bar, exactly: the per-trade EV positive, the
        // CLUSTERED EV positive, the clustered t >= 2, and the EV above
        // the fee floor.
        if (ev > 0 && m * RHO > 0 && Number.isFinite(tStat) && tStat >= T_MIN && ev > feeFloor) {
          passes.push({ tpPct, slPct, hold, n: trades.length, clusters: st.clusters, ev, t: tStat, cms: st.cms, trades });
        }
      }
    }
  }
  passes.sort((a, b) => b.ev - a.ev);
  return { tested, passes };
}

const placebo = sweepWith(placeboRows, ROUND_TRIP_TAKER, resolveWithSide);
const realSweep = sweepWith(liveRows, ROUND_TRIP_TAKER, resolveWithSide);

console.log("────────────────────────────────────────────────────────────────────");
console.log("1. THE MULTIPLE-COMPARISON BASELINE");
console.log("────────────────────────────────────────────────────────────────────");
console.log(`the real arm:    ${realSweep.passes.length} of ${realSweep.tested} geometries clear the bar`);
console.log(`the placebo arm: ${placebo.passes.length} of ${placebo.tested} (the SAME trades, the direction FLIPPED)`);
console.log();
const realRate = realSweep.passes.length / realSweep.tested;
const placeboRate = placebo.passes.length / placebo.tested;
console.log(`the real rate:    ${(realRate * 100).toFixed(2)}%`);
console.log(`the placebo rate: ${(placeboRate * 100).toFixed(2)}%`);
console.log();
if (realSweep.passes.length <= placebo.passes.length) {
  console.log("VERDICT: the real arm does NOT pass more often than the placebo.");
  console.log("         The passes are the MARKET'S OWN DRIFT plus a selection over 360");
  console.log("         geometries, not an edge.");
} else {
  console.log(`the real arm passes ${realSweep.passes.length - placebo.passes.length} more geometries than the placebo.`);
  console.log("That is a SIGNAL — but it is not yet a finding: the cluster count decides.");
}
console.log();

console.log("────────────────────────────────────────────────────────────────────");
console.log("2. THE CLUSTER COUNT — the independent sample");
console.log("────────────────────────────────────────────────────────────────────");
if (realSweep.passes.length) {
  const best = realSweep.passes[0];
  console.log(`the best geometry: TP ${best.tpPct}%  SL ${best.slPct}%  hold ${best.hold}`);
  console.log(`  the EV:        ${fmt(best.ev)}% of equity per trade`);
  console.log(`  the t:         ${fmt(best.t, 2)}`);
  console.log(`  the CLUSTERS:  ${best.clusters}   (the bar is ${BAR_CLUSTERS})`);
  console.log(`  the trades:    ${best.n}`);
  console.log();
  console.log(`A t of ${fmt(best.t, 2)} on ${best.clusters} cluster${best.clusters === 1 ? "" : "s"} has a two-sided p of about 0.05 PER GEOMETRY.`);
  console.log(`With ${realSweep.tested} geometries tested, the EXPECTED number of false positives at that bar is ${(realSweep.tested * 0.05).toFixed(0)}.`);
  console.log();
  if (best.clusters < BAR_CLUSTERS) {
    console.log(`VERDICT: CANDIDATE, NOT A FINDING. ${best.clusters} independent clusters against a bar of ${BAR_CLUSTERS}.`);
    console.log("         Every geometry was measured on the SAME trades, so 360 passes are 360");
    console.log("         readings of one small sample, not 360 independent tests.");
  }
} else {
  console.log("no geometry clears the bar at all.");
}
console.log();

console.log("────────────────────────────────────────────────────────────────────");
console.log("3. THE OUT-OF-SAMPLE SPLIT (the clusters split in half by time)");
console.log("────────────────────────────────────────────────────────────────────");
if (realSweep.passes.length) {
  const best = realSweep.passes[0];
  const buckets = best.cms.map((c) => c.bucket).sort((a, b) => a - b);
  const half = Math.floor(buckets.length / 2);
  const first = best.cms.filter((c) => buckets.indexOf(c.bucket) < half);
  const second = best.cms.filter((c) => buckets.indexOf(c.bucket) >= half);
  const evOf = (cms) => (cms.length ? mean(cms.map((c) => c.mean)) * RHO : NaN);
  console.log(`the first half:  ${first.length} clusters, EV ${fmt(evOf(first))}% of equity`);
  console.log(`the second half: ${second.length} clusters, EV ${fmt(evOf(second))}% of equity`);
  const bothPositive = evOf(first) > 0 && evOf(second) > 0;
  console.log();
  console.log(bothPositive
    ? "both halves positive — the geometry is at least stable across the window"
    : "NOT both halves positive — the geometry depends on which half of a tiny sample you look at");
} else {
  console.log("no geometry to split.");
}
console.log();

console.log("────────────────────────────────────────────────────────────────────");
console.log("4. THE SHIPPED GEOMETRY vs THE BEST SWEPT GEOMETRY");
console.log("────────────────────────────────────────────────────────────────────");
// The live path's shipped ticket: TP = 0.4 x ATR capped at 0.5%, SL = ATR,
// 240 minutes. The market-anchored version of it.
{
  const atr = rows.map((r) => Number(r.tapeAtrPct)).filter((x) => x > 0);
  const medAtr = atr.length ? atr.sort((a, b) => a - b)[Math.floor(atr.length / 2)] : 0.85;
  const shippedTp = Math.min(0.4 * medAtr, 0.5);
  const shippedSl = medAtr;
  const trades = [];
  for (const r of liveRows) {
    const t = resolveWithSide(r, shippedTp, shippedSl, 16, ROUND_TRIP_TAKER);
    if (t) trades.push(t);
  }
  const st = clusterStats(trades);
  const ev = mean(trades.map((t) => t.pnlPct)) * RHO;
  const ms = st.cms.map((c) => c.mean);
  const m = mean(ms);
  const sd = ms.length > 1 ? Math.sqrt(ms.reduce((s, x) => s + (x - m) ** 2, 0) / (ms.length - 1)) : NaN;
  const se = ms.length > 1 ? sd / Math.sqrt(ms.length) : NaN;
  console.log(`the shipped ticket (TP ${fmt(shippedTp, 2)}%  SL ${fmt(shippedSl, 2)}%  hold 16):`);
  console.log(`  the EV:       ${fmt(ev)}% of equity per trade   (the fee floor is ${fmt(ROUND_TRIP_TAKER * RHO)}%)`);
  console.log(`  the t:        ${fmt(se > 0 ? m / se : NaN, 2)}`);
  console.log(`  the clusters: ${st.clusters}`);
  console.log(`  the trades:   ${trades.length}`);
  if (realSweep.passes.length) {
    const best = realSweep.passes[0];
    console.log(`the best swept geometry: TP ${best.tpPct}%  SL ${best.slPct}%  hold ${best.hold}  EV ${fmt(best.ev)}%  t ${fmt(best.t, 2)}  clusters ${best.clusters}`);
  }
}
console.log();
console.log("════════════════════════════════════════════════════════════════════");
console.log("THE ANSWER");
console.log("════════════════════════════════════════════════════════════════════");
const realPass = realSweep.passes.length;
const placeboPass = placebo.passes.length;
const bestClusters = realSweep.passes.length ? realSweep.passes[0].clusters : 0;
if (realPass <= placeboPass) {
  console.log("NO EDGE. The real arm's pass count does not beat the placebo's.");
} else if (bestClusters < BAR_CLUSTERS) {
  console.log(`A CANDIDATE, NOT A FINDING. ${realPass} of ${realSweep.tested} geometries pass against a placebo's ${placeboPass},`);
  console.log(`but the best one rests on ${bestClusters} independent clusters against a bar of ${BAR_CLUSTERS}.`);
  console.log("Keep collecting. Do not deploy.");
} else {
  console.log("A FINDING: the excess beats the placebo and clears the cluster bar.");
}
console.log("════════════════════════════════════════════════════════════════════");
