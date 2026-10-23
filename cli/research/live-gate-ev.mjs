#!/usr/bin/env node
/**
 * THE DECISIVE MEASUREMENT: the LIVE-GATE arm's real net EV per trade.
 *
 * ══ WHY THIS SCRIPT EXISTS ══
 *
 * The geometry study (`analyze-geometry.mjs`) measures an arm that the
 * live path DOES NOT TRADE. The fidelity audit measured the gap:
 *
 *   STUDY control arm                    159 rows
 *   LIVE-gate arm                          19 rows
 *   study rows the live path REFUSES     140 (88%)
 *
 * The study's rule lets a SINGLE model leg define the trade direction:
 *     (jev && laya) ? (jev === laya ? jev : null) : (jev || laya)
 *
 * The live path requires BOTH, agreeing, and (per the loop) neither
 * uncertain:
 *     if (!jev)  refuse — "a watch, not a trigger"
 *     if (!laya) refuse — "a watch, not a trigger"
 *     if (jev.side !== laya.side) refuse — "models disagree"
 *
 * The study also books a FLAT 0.4% win and a FLAT 1.2% loss, anchors
 * the entry on the last 15m bar's CLOSE, and uses a hardcoded
 * 1.34xATR stop. The live path derives all of those:
 *     d          = clamp(0.9 x ATR, 0.6, 1.5)      (kucoin.ts)
 *     avgEntry   = last x (1 + d/200)  for a short (live-cmd.ts)
 *     stop%      = 3d/(200+d)
 *     TP         = clamp(0.4 x ATR, 0.3, 0.5)
 *
 * And the fee: the live path places a MARKET entry, so BOTH legs are
 * takers — 0.12% of notional, which is 0.1258% of equity at the
 * account's 1.0484x exposure. (The live path used to assume 0.08%;
 * the venue's own fills settled it at 0.0600% on every leg.)
 *
 * So the study's +0.1150% of equity per trade is a number for a
 * DIFFERENT trade. This script measures the trade the MACHINE makes.
 *
 * ══ WHAT IT REPORTS ══
 *
 * For the live-gate arm, with the live geometry and the live fee:
 *   - the net EV per trade (percent of equity)
 *   - the win rate and the break-even win rate
 *   - the same for a TAPE-ONLY control (the tape's direction with NO
 *     model filter) — the excess is what the CONFIRMATION adds
 *   - the same for ALWAYS-SHORT on the same symbols and times — the
 *     market's own drift, so the excess is not drift
 *   - the cluster-corrected t on the excess
 *
 * A positive net EV for the live-gate arm would be the first tradeable
 * edge in this project. A negative one closes the question.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
// THE SHARED FILL RULE. The geometry sweep used to re-implement the
// bar walk and OMIT the scratch rule, so it booked a target on the
// wrong side of the market as a FULL WIN — which is how the same 181
// rows could read -0.2390% of equity for the arm and +0.0892% for the
// SHIPPED geometry on the same trades. The rule lives in ONE module
// precisely so that it cannot drift; a sweep that re-implements it
// will drift.
import { resolveTicket } from "./ticket-fill.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

// ── the live path's constants (kucoin.ts / live-cmd.ts / sizing.ts) ──
const ATR_MULT_STOP = 0.9; // d = clamp(0.9 x ATR, 0.6, 1.5)
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16; // 16 x 15m = 240 minutes
const BAR_MIN = 15;
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY; // exposure
const TAKER = 0.0006; // per leg, of NOTIONAL
const ROUND_TRIP = TAKER * 2; // 0.0012

const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};

console.log(`[livegate] ${rows.length} collector rows`);

// ── the live gate, exactly as live-cmd.ts implements it ──
function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev) return null;
  if (!laya) return null;
  if (jev !== laya) return null;
  return jev;
}
// the tape's side, exactly as tape-signal.mjs defines it
function tapeSide(r) {
  return tapeSideFromRow(r) ?? null;
}

// The LIVE-GATE arm: what the machine actually trades — the live path
// requires the tape's exhaustion AND the two models agreeing on the
// same side (the loop additionally requires neither model uncertain).
const liveArm = [];
// The TAPE-ONLY arm: the control — the tape's direction with NO model
// filter.
const tapeArm = [];
// The ALWAYS-SHORT arm: the market's own drift on the traded symbols
// and times, so the excess is provably not drift.
const driftArm = [];
for (const r of rows) {
  const t = tapeSide(r);
  if (!t) continue;
  tapeArm.push({ ...r, dir: t });
  const g = liveGate(r);
  if (g && g === t) {
    liveArm.push({ ...r, dir: g, both: true });
    // The drift control: the SAME symbols and times, always short. If
    // the live-gate arm is entirely short (it is), this is the same
    // trade — which is itself the finding: the machine's arm has no
    // long side to compare against.
    driftArm.push({ ...r, dir: "short" });
  }
}

// ── the ticket, in the live path's geometry ──
function ticketFor(r) {
  const atrPct = r.tapeAtrPct;
  if (!(atrPct > 0)) return null; // the live path REFUSES a missing ATR
  // ── THE UNITS, EXACTLY AS THE LIVE PATH USES THEM ──
  //
  // `d` and `tpPct` are PERCENT NUMBERS here, not fractions. The live
  // path's formulas are:
  //     d       = clamp(0.9 x ATR%, 0.6, 1.5)      (a percent number)
  //     avgEntry= last x (1 + d/200)               (a short)
  //     stop%   = 3d/(200+d)                       (a FRACTION of avgEntry)
  //
  // A first version of this script divided d by 100 FIRST, which made
  // the entry 10x too close and the stop 6x too tight — and produced a
  // 7% win rate, which is the signal that something was wrong: a 0.5%
  // target against a 1.1% stop should win far more often than that.
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = r.price;
  if (!(last > 0)) return null;
  const avgEntry = r.dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = r.dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = r.dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, last, stopPrice, targetPrice };
}

/**
 * Walk the forward bars and resolve the ticket.
 * A bar touching BOTH levels is a LOSS (conservative).
 * A trade reaching neither level is closed at the time exit, booked
 * at its mark — it is a real outcome, not an unresolved one.
 */
function resolve(r, ticket) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = r.dir === "long";
  // ── THE SCRATCH ARTEFACT, CORRECTED ──
  //
  // A take-profit that is ALREADY SATISFIED at the market is a
  // MARKETABLE order: it fills instantly at the touch, so the gross is
  // ~zero and the trade books the fee. Booking the full target distance
  // for it produced the 90-95% win rates this project reported for
  // weeks.
  //
  // The ticket's target is derived from the ladder's offset average
  // entry, which for a short sits ABOVE the last price — so the target
  // cleared the market only if `tp > d/2`, and with `tp = 0.4 x ATR`
  // and `d = 0.9 x ATR` it NEVER does. See
  // docs/research/the-scratch-artefact.md.
  const tpWrongSide = long ? ticket.targetPrice < ticket.last : ticket.targetPrice > ticket.last;
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) {
      return { outcome: "loss", bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
    }
    if (hitTp) {
      if (tpWrongSide) {
        // A marketable limit: it fills at the touch, seconds later, at
        // essentially the same price. The gross is ~zero and the trade
        // books the fee.
        return { outcome: "scratch", bars: k - i + 1, pnlPct: -ROUND_TRIP };
      }
      // `tpFrac` is the FRACTION (0.005 for a 0.5% target). Using
      // `tpPct` here (the percent number, 0.5) inflated the P&L 100x
      // and produced an absurd +40% of equity per trade.
      return { outcome: "win", bars: k - i + 1, pnlPct: ticket.tpFrac - ROUND_TRIP };
    }
    if (hitSl) {
      return { outcome: "loss", bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
    }
  }
  // the time exit: the mark at the last bar
  const lastBar = b[end - 1];
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: movePct - ROUND_TRIP };
}

function simulate(arm, label) {
  const perTrade = [];
  const buckets = [];
  let wins = 0, losses = 0, times = 0, scratches = 0, noBars = 0;
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) { noBars++; continue; }
    const o = resolve(r, t);
    if (!o) { noBars++; continue; }
    const pnlEquity = o.pnlPct * RHO * 100; // percent of equity
    perTrade.push(pnlEquity);
    // THE CLUSTER WIDTH IS THE TICKET'S HOLDING PERIOD.
    //
    // The ticket resolves over BARS_BEFORE (16 x 15m = 240 minutes), so
    // two signals inside one 4-hour window share the same entry, the
    // same path and the same exit — they are ONE trade seen twice.
    // Clustering at the collector's 5-minute round counts them as two
    // independent observations, and the reported t is then a measure of
    // the cluster size rather than of the arm.
    //
    // `test-cluster-width.mjs` measures the arm at four widths, and the
    // excess is negative at EVERY one — but the 4-hour width is the one
    // the bar must be judged at, because that is how long the trade is
    // actually held.
    buckets.push(Math.floor(r.ts / (BARS_BEFORE * 15 * 60 * 1000)));
    if (o.outcome === "win") wins++;
    else if (o.outcome === "loss") losses++;
    else if (o.outcome === "scratch") scratches++;
    else times++;
  }
  const n = wins + losses;
  const winRate = n ? wins / n : 0;
  const ev = mean(perTrade);
  // the cluster-corrected standard error: the mean per time bucket
  const byBucket = new Map();
  perTrade.forEach((p, i) => {
    const b = buckets[i];
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(p);
  });
  const clusterMeans = [...byBucket.values()].map((v) => mean(v));
  const cSe = clusterMeans.length > 1 ? stdev(clusterMeans) / Math.sqrt(clusterMeans.length) : 0;
  return {
    label, n: perTrade.length, wins, losses, times, noBars,
    winRate, ev, clusters: clusterMeans.length, clusterSe: cSe,
    clusterMeans,
    perTrade, buckets,
  };
}

const A = simulate(liveArm, "LIVE-GATE (the machine's trade)");
const B = simulate(tapeArm, "TAPE-ONLY (the control)");
const D = simulate(driftArm, "ALWAYS SHORT (the drift)");

console.log(`[livegate] live-gate arm: ${liveArm.length} rows | tape arm: ${tapeArm.length} rows`);
console.log();
console.log("  arm                    n   resolved   win%    time%   EV % of equity   clusters");
for (const s of [A, B, D]) {
  console.log(
    `  ${s.label.padEnd(22)}${String(s.n).padStart(4)}${String(s.n).padStart(10)}` +
    `${(s.winRate * 100).toFixed(1).padStart(7)}${((s.times / Math.max(1, s.n)) * 100).toFixed(1).padStart(8)}` +
    `${fmt(s.ev).padStart(16)}${String(s.clusters).padStart(11)}`,
  );
}

// the excess: the confirmation layer's contribution, on the SAME
// symbols and times. Pair by cluster so the market's drift cancels.
const byBucketA = new Map(), byBucketB = new Map();
A.perTrade.forEach((p, i) => {
  const b = A.buckets[i];
  if (!byBucketA.has(b)) byBucketA.set(b, []);
  byBucketA.get(b).push(p);
});
B.perTrade.forEach((p, i) => {
  const b = B.buckets[i];
  if (!byBucketB.has(b)) byBucketB.set(b, []);
  byBucketB.get(b).push(p);
});
const diffs = [];
for (const [b, va] of byBucketA) {
  const vb = byBucketB.get(b);
  if (!vb || !vb.length) continue;
  diffs.push(mean(va) - mean(vb));
}
const dMean = mean(diffs);
const dSe = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
const dT = dSe > 0 ? dMean / dSe : 0;

console.log();
console.log("  ── THE EXCESS: what the CONFIRMATION layer adds (paired by cluster) ──");
console.log(`     paired clusters: ${diffs.length}`);
console.log(`     excess: ${fmt(dMean)}% of equity per trade   se ${fmt(dSe)}   t = ${fmt(dT, 2)}`);
console.log();
// the excess over the market's own drift on the SAME symbols and times
const byBucketD = new Map();
D.perTrade.forEach((p, i) => {
  const b = D.buckets[i];
  if (!byBucketD.has(b)) byBucketD.set(b, []);
  byBucketD.get(b).push(p);
});
const driftDiffs = [];
for (const [b, va] of byBucketA) {
  const vb = byBucketD.get(b);
  if (!vb || !vb.length) continue;
  driftDiffs.push(mean(va) - mean(vb));
}
const drMean = mean(driftDiffs);
const drSe = driftDiffs.length > 1 ? stdev(driftDiffs) / Math.sqrt(driftDiffs.length) : 0;
const drT = drSe > 0 ? drMean / drSe : 0;
console.log();
console.log("  ── THE EXCESS over the MARKET'S OWN DRIFT (same symbols+times) ──");
console.log(`     paired clusters: ${driftDiffs.length}`);
console.log(`     excess: ${fmt(drMean)}% of equity per trade   se ${fmt(drSe)}   t = ${fmt(drT, 2)}`);

console.log();
console.log("  ── THE FEE FLOOR ──");
console.log(`     taker round trip: ${(ROUND_TRIP * 100).toFixed(4)}% of notional = ${(ROUND_TRIP * RHO * 100).toFixed(4)}% of equity per trade`);
console.log(`     the live-gate arm's NET EV: ${fmt(A.ev)}% of equity per trade`);
console.log(`     => the live-gate trade ${A.ev > 0 ? "PAYS" : "DOES NOT PAY"} for itself`);
console.log();
console.log("  ── THE VERDICT ──");
if (A.n < 10) {
  console.log(`     NOT ENOUGH DATA: ${A.n} resolved trades in the live-gate arm.`);
} else if (A.ev <= 0) {
  console.log(`     The machine's own trade has a NEGATIVE net EV (${fmt(A.ev)}% of equity per trade).`);
  console.log(`     The study's positive number belonged to a population the machine refuses.`);
} else {
  console.log(`     The machine's own trade is NET POSITIVE: ${fmt(A.ev)}% of equity per trade,`);
  console.log(`     win rate ${(A.winRate * 100).toFixed(1)}% over ${A.n} trades in ${A.clusters} clusters.`);
  console.log(`     The excess over the tape-only control: ${fmt(dMean)}% (t=${fmt(dT, 2)}).`);
}

writeFileSync(
  join(SCRATCH, "live-gate-ev.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      // THE CLUSTER WIDTH, published with the counts, so a consumer
      // cannot mistake a 5-minute count for a 4-hour one.
      clusterWidthMinutes: (BARS_BEFORE * 15),
      // The CLUSTER MEANS are published, not just their count.
      //
      // A power analysis needs the variance ACROSS the cluster means,
      // and a consumer cannot recover it from the aggregate standard
      // error: that se is the se of the DIFFERENCE between the two
      // arms, and the arms' variances are not separable from it. So
      // the means are published, which is what makes the power
      // question answerable from the evidence file alone.
      liveGate: {
        n: A.n,
        wins: A.wins,
        losses: A.losses,
        times: A.times,
        winRate: A.winRate,
        ev: A.ev,
        clusters: A.clusters,
        clusterSe: A.clusterSe,
        clusterMeans: A.clusterMeans,
      },
      tapeOnly: {
        n: B.n,
        winRate: B.winRate,
        ev: B.ev,
        clusters: B.clusters,
        clusterSe: B.clusterSe,
        clusterMeans: B.clusterMeans,
      },
      excess: { pairedClusters: diffs.length, mean: dMean, se: dSe, t: dT },
      feeFloorPctEquity: ROUND_TRIP * RHO * 100,
      rho: RHO,
    },
    null,
    2,
  ),
);

// ══════════════════════════════════════════════════════════════════════
// THE GEOMETRY SWEEP ON THE LIVE-GATE ARM
//
// The live ticket is 1:3.4 R:R (TP 0.48%, stop 1.61%) and needs an
// 82.8% win rate to break even. It has measured ~100% on 11 trades —
// so the ticket is profitable, but it is fragile: at an 80% win rate
// it is negative, and every loss is 3.4 wins.
//
// The excursion distribution says a TIGHTER stop is reachable in most
// windows, so a smaller stop with a proportionally smaller target
// would have a much lower break-even and a far more robust win rate.
// This sweep asks which geometry is actually best ON THE ARM THE
// MACHINE TRADES.
// ══════════════════════════════════════════════════════════════════════
console.log();
console.log("  ── THE GEOMETRY SWEEP on the live-gate arm ──");
console.log("  tpMult stopMult hold |  n  win%  scr%  time% |  EV %eq |  BE-WR | tp%   stop%");
console.log("  (the win rate is over the trades that reached a LEVEL; the EV includes every trade)");

function runGeometry(tpMult, stopMult, holdBars) {
  const ev = [];
  let wins = 0, losses = 0, times = 0, scratches = 0;
  const tpPcts = [];
  const stopFracs = [];
  for (const r of liveArm) {
    const t = ticketFor(r);
    if (!t) continue;
    const b = bars[r.pair];
    if (!b) continue;
    const i = b.findIndex((x) => x.t > r.ts);
    if (i < 0) continue;
    const end = Math.min(b.length, i + holdBars);
    if (end - i < 2) continue;
    const tpPct = Math.min(Math.max(tpMult * t.atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
    const stopFrac = stopMult * t.stopFrac;
    const tpFrac = tpPct / 100;
    const sl = r.dir === "short" ? t.avgEntry * (1 + stopFrac) : t.avgEntry * (1 - stopFrac);
    const tp = r.dir === "short" ? t.avgEntry * (1 - tpFrac) : t.avgEntry * (1 + tpFrac);
    // THE SHARED RESOLVER — so the sweep and the arm's own simulation
    // book the SAME trade the SAME way.
    //
    // The old loop here had no wrong-side check, so a target already
    // satisfied at the market was booked as a full target win. That is
    // exactly the scratch artefact: the arm's own simulation (which
    // DOES apply the rule) read these 181 rows at -0.2390% of equity
    // while this sweep read the SHIPPED geometry at +0.0892% on the
    // same rows. One of them was wrong, and it was this one.
    tpPcts.push(tpPct);
    stopFracs.push(stopFrac);
    const o = resolveTicket(b, i, holdBars, r.dir, {
      targetPrice: tp,
      stopPrice: sl,
      tpFrac,
      stopFrac,
      // THE TWO ANCHORS, AND THEY ARE NOT THE SAME PRICE.
      //
      // `last` is the MARKET price (r.price) and `avgEntry` is the
      // ENTRY anchor (the ladder's offset average, which for a short
      // sits ABOVE the market). The resolver reads `last` for the
      // wrong-side check and `avgEntry` for the time exit's mark.
      //
      // Passing `last: t.avgEntry` — which is what this call did —
      // broke the wrong-side check in a way that INVERTED the result:
      // the arm's own simulation read these 173 rows at -0.2462% of
      // equity with 125 scratches, while the shared resolver read
      // +0.0761% with 154 wins, on the SAME rows and the SAME ticket.
      // The target is on the wrong side of the MARKET (0.00177436 above
      // a market of 0.00177000) and the arm was right to scratch it.
      // Two prices, two jobs: the market decides the side, the entry
      // anchor books the trade.
      last: t.last,
      avgEntry: t.avgEntry,
    });
    if (!o) continue;
    if (o.outcome === "win") wins++;
    else if (o.outcome === "loss") losses++;
    else if (o.outcome === "scratch") scratches++;
    else times++;
    ev.push(o.pnlPct * RHO * 100);
  }
  const n = ev.length;
  // THE WIN RATE, over the trades that reached a LEVEL. A time exit
  // reached neither, so it is excluded from the win rate (it is a
  // mark, not a target) — and the EV, which decides, includes it.
  const wr = wins + losses ? wins / (wins + losses) : 0;
  const m = n ? mean(ev) : 0;
  // THE REPORTED GEOMETRY, as the MEAN over the rows actually traded.
  //
  // It used to be the FIRST row's ATR, while every trade used its own
  // ATR — so the table described a ticket that was never placed, and
  // its break-even was the break-even of a DIFFERENT ticket. The
  // sweep's whole purpose is to say which geometry to trade, so the
  // geometry it reports must be the geometry it traded.
  const tpPctMean = mean(tpPcts);
  const stopFracMean = mean(stopFracs);
  const winEq = (tpPctMean / 100) * RHO * 100 - ROUND_TRIP * RHO * 100;
  const lossEq = -stopFracMean * RHO * 100 - ROUND_TRIP * RHO * 100;
  const be = winEq - lossEq !== 0 ? -lossEq / (winEq - lossEq) : 0;
  return {
    n, wins, losses, times, scratches, wr, ev: m, be,
    tpPct: tpPctMean, stopFrac: stopFracMean,
  };
}

const SWEEP = [
  [0.4, 1.0, 16],   // the SHIPPED geometry
  [0.4, 0.5, 16],
  [0.4, 0.3, 16],
  [0.4, 0.2, 16],
  [0.4, 0.15, 16],
  [0.3, 0.2, 16],
  [0.4, 0.3, 8],
  [0.4, 0.3, 32],
  [0.4, 0.2, 32],
  [0.25, 0.15, 16],
];
let bestGeo = null;
for (const [tm, sm, hb] of SWEEP) {
  const r = runGeometry(tm, sm, hb);
  const tag = tm === 0.4 && sm === 1.0 && hb === 16 ? "  <- SHIPPED" : "";
  console.log(
    `  ${String(tm).padEnd(7)}${String(sm).padEnd(9)}${String(hb).padEnd(5)}|` +
    `${String(r.n).padStart(4)}${(r.wr * 100).toFixed(1).padStart(6)}${((r.scratches / Math.max(1, r.n)) * 100).toFixed(1).padStart(5)}${((r.times / Math.max(1, r.n)) * 100).toFixed(1).padStart(7)} |` +
    `${fmt(r.ev).padStart(9)} |${(r.be * 100).toFixed(1).padStart(7)}% |${r.tpPct.toFixed(2).padStart(5)} ${r.stopFrac.toFixed(3).padStart(7)}${tag}`,
  );
  if (!bestGeo || r.ev > bestGeo.ev) bestGeo = { ...r, tm, sm, hb };
}
console.log();
console.log(`  the best EV on this arm: tpMult ${bestGeo.tm} / stopMult ${bestGeo.sm} / hold ${bestGeo.hb}`);
console.log(`    EV ${fmt(bestGeo.ev)}% of equity per trade | win ${(bestGeo.wr * 100).toFixed(1)}% | break-even ${(bestGeo.be * 100).toFixed(1)}%`);
console.log("    (n is small: " + bestGeo.n + " trades. A geometry chosen on 11 trades is a HYPOTHESIS.)");
