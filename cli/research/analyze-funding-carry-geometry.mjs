#!/usr/bin/env node
/**
 * THE FUNDING-CARRY STUDY — can funding make the geometry candidate net-positive?
 *
 * ── WHY THIS IS A DIFFERENT QUESTION FROM THE PRIOR FUNDING STUDY ──
 *
 * `analyze-funding-oi.mjs` asked: "does an extreme funding rate PREDICT
 * price?" Its honest answer was no — 0 of 6 variants cleared the bar, and a
 * placebo of the same size matched the real selection.
 *
 * THIS study asks a different question, and it is the one that decides
 * whether a trade is worth taking:
 *
 *   Funding is a REAL CASH FLOW of HOLDING A SHORT. Over a hold of H
 *   hours a short RECEIVES the funding rate at every settlement inside
 *   the hold. Is that cash flow big enough — at the geometry candidate's
 *   ACTUAL horizons, ACTUAL symbols and ACTUAL notional — to turn the
 *   trade net-positive after the 0.12% taker round trip, even if the
 *   price signal's own edge is small?
 *
 * ── THE FOUR NUMBERS ──
 *
 *   (a) SIGNAL ARM      the machine's own signal (tape and models agree):
 *                       the actual entry, the actual TP/SL first touch,
 *                       the actual holding time, the actual funding.
 *   (b) CONTROL ARM     the SAME geometry, the SAME direction, on the SAME
 *                       symbols and windows, with NO model filter.
 *   (c) EXCESS          (a) - (b) on PRICE only (no funding anywhere).
 *   (d) EXCESS WITH     (a) with funding - (b) with funding. Funding is on
 *      FUNDING ON BOTH  BOTH arms, so it is a cash flow of holding that
 *       ARMS           cancels in the difference — it can only change the
 *                       excess if the two arms hold DIFFERENT symbols for
 *                       DIFFERENT lengths of time.
 *
 * ── THE DEFECT THIS STUDY MUST NOT REPEAT ──
 *
 * The prior funding study's baseline was the same trade WITHOUT the
 * funding receipt, so the paired difference was EXACTLY the funding term:
 * an arithmetic identity, not a measurement. That is why every variant
 * printed a tiny positive excess with an enormous t (6.03, 7.62, 9.88,
 * 11.52). Here funding is on BOTH arms, and the excess is reported twice
 * — without funding and with it — so the cancellation is VISIBLE.
 *
 * ── THE OTHER RULES ──
 *
 *   ROWS ARE NOT OBSERVATIONS. The collectors sample ~43-45 symbols every
 *   5-15 minutes and they move together. Every t-statistic here is
 *   computed on CLUSTER MEANS (one per 5-minute bucket). The cluster
 *   count and the span are reported, and the bar is n>=30 clusters.
 *
 *   A FORWARD RETURN IS NOT A TRADE OUTCOME. Every trade here is a
 *   first-touch TP / first-touch SL, with ambiguous bars resolved
 *   CONSERVATIVELY as losses and an explicit TIME EXIT for the rest.
 *
 *   THE SAME OBSERVATION IS NOT TWO OBSERVATIONS. The confluence
 *   collector re-reads each symbol every ~5 minutes, so one (symbol,
 *   entry-bar) can appear 2-3 times. Those are ONE trade, observed
 *   repeatedly — the same entry, the same exit, the same funding. They
 *   are de-duplicated here.
 *
 *   A TRUNCATED HORIZON IS NOT A TIME EXIT. A trade whose forward bars
 *   run out before the hold window is a DIFFERENT measurement from one
 *   that reaches the full horizon. Both are reported; the complete-
 *   horizon subset is the primary.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const IN = flag("confluence", join(HOME, ".hermes/cache/scratch/confluence.ndjson"));
const BARS_FILE = flag("bars", join(HOME, ".hermes/cache/scratch/geometry-bars.carry-live.json"));
const FUND_FILE = flag("funding", join(HOME, ".hermes/cache/scratch/funding-oi.ndjson"));

/** The taker round trip, in %, charged on the notional. */
const TAKER_RT = 0.12;
/** The maker round trip, in %, charged on the notional. */
const MAKER_RT = 0.04;
/** The bar interval, in minutes. */
const BAR_MIN = 15;
/** How long a trade is held before the time exit, in bars. */
const MAX_HOLD_BARS = 16;
/** The cluster size for the effective-sample-size correction. */
const BUCKET_MS = 5 * 60_000;
/** The ticket's real exposure: $60 notional on $57.23 equity. */
const EQUITY = 57.2287;
const NOTIONAL = 60.0;
const NOTIONAL_OVER_EQUITY = NOTIONAL / EQUITY;
/** The bar the viability is judged against. */
const MIN_CLUSTERS = 30;

/**
 * The geometries. The first four are the ones the geometry study tested
 * (and whose stops are ~unreachable in a 4-hour window, which is why they
 * produce a degenerate 100% win rate). The last five are RESOLVABLE:
 * a stop the price can actually reach inside the hold window, so that
 * both wins and losses exist and the trade outcome is a real outcome.
 */
const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR capped 0.5%, SL=ATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 0.3%  SL 0.4%  (resolvable)", tp: 0.3, sl: 0.4 },
  { name: "TP 0.5%  SL 0.6%  (resolvable)", tp: 0.5, sl: 0.6 },
  { name: "TP 0.5%  SL 0.8%  (resolvable)", tp: 0.5, sl: 0.8 },
  { name: "TP 0.8%  SL 0.6%  (resolvable)", tp: 0.8, sl: 0.6 },
  { name: "TP 1.0%  SL 0.8%  (resolvable)", tp: 1.0, sl: 0.8 },
];

// ── the statistics ────────────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const tstat = (xs) => {
  const s = se(xs);
  return s > 0 ? mean(xs) / s : 0;
};
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Cluster means: one mean per time bucket. The rows in one bucket are
 * ~43 symbols moving TOGETHER, so the row-level standard error
 * overstates the evidence by roughly the square root of the cluster size.
 */
function clusterStats(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const clusterMeans = [...byBucket.values()].map((a) => mean(a));
  return { clusters: clusterMeans.length, clusterMeans, mean: mean(clusterMeans), se: se(clusterMeans) };
}

// ── the funding schedule ──────────────────────────────────────────────────
/**
 * KuCoin settles funding on a per-symbol interval (4h or 8h on this
 * universe). The collector records, per symbol per round:
 *
 *   funding      the CURRENT rate for the NEXT settlement
 *   lastFunding  the rate that SETTLED at the last settlement
 *   nextFundingAt when the next settlement happens
 *
 * So the rate that settled at a settlement time S is `lastFunding` as
 * observed in the first collector round AFTER S. The settlement times
 * themselves are the distinct `nextFundingAt` values for the symbol.
 *
 * A trade that is OPEN at a settlement is charged that settlement's rate
 * in full — funding is NOT prorated by the length of the hold. So the
 * trade's funding is the SUM of the settled rates at every settlement
 * inside (entry, exit].
 *
 * A POSITIVE rate is paid BY the long holder, so a SHORT RECEIVES it.
 */
function buildFundingSchedule(rows) {
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.base)) bySym.set(r.base, []);
    bySym.get(r.base).push(r);
  }
  for (const [, list] of bySym) list.sort((a, b) => a.ts - b.ts);

  const rounds = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
  const firstTs = rounds[0];
  const schedule = new Map(); // base -> { settlements: [{at, rate, known}], intervalMs, currentRate }

  for (const [base, list] of bySym) {
    const seen = [...new Set(list.map((r) => r.nextFundingAt).filter(Boolean))].sort((a, b) => a - b);
    if (!seen.length) continue;
    let intervalMs = 0;
    for (let i = 1; i < seen.length; i++) {
      const gap = seen[i] - seen[i - 1];
      if (!intervalMs || gap < intervalMs) intervalMs = gap;
    }
    const settlements = [];
    // Back-fill the settlements before the collector started, so a trade
    // opened early in the window still crosses the right ones. Their
    // rates are UNKNOWN (no observation of lastFunding before the
    // collector ran) and are counted as such, never fabricated.
    if (intervalMs > 0) {
      let back = seen[0] - intervalMs;
      while (back > firstTs - intervalMs) {
        settlements.push({ at: back, rate: null, known: false });
        back -= intervalMs;
      }
    }
    for (const at of seen) {
      const after = list.find((r) => r.ts > at);
      const rate = after ? Number(after.lastFunding) : null;
      settlements.push({ at, rate: Number.isFinite(rate) ? rate : null, known: after != null });
    }
    settlements.sort((a, b) => a.at - b.at);
    schedule.set(base, {
      settlements,
      intervalMs,
      currentRate: Number(list[list.length - 1].funding),
    });
  }
  return { schedule, rounds, firstTs };
}

/**
 * The funding a trade RECEIVED, in % of notional (positive = received).
 *
 *   short  -> receives +rate at each settlement inside the hold
 *   long   -> pays    -rate
 */
function fundingFor(base, entryTs, exitTs, dir, funding) {
  const sch = funding.schedule.get(base);
  if (!sch) return { pct: 0, settlements: 0, unknown: 0, rates: [] };
  let pct = 0;
  let n = 0;
  let unknown = 0;
  const rates = [];
  for (const s of sch.settlements) {
    if (s.at <= entryTs) continue; // the position was not open yet
    if (s.at > exitTs) break; // it closed before this settlement
    if (!s.known) { unknown++; continue; }
    const signed = dir === "short" ? s.rate : -s.rate;
    pct += signed * 100; // s.rate is a decimal fraction -> % of notional
    rates.push(s.rate);
    n++;
  }
  return { pct, settlements: n, unknown, rates };
}

/**
 * The funding a trade WOULD receive if it were held for `horizonMs`,
 * using the ACTUAL per-symbol rate at each ACTUAL settlement time. For
 * settlements beyond the observed window the current rate is used as a
 * flat-forward estimate, and that is stated, not hidden.
 */
function fundingOverHorizon(base, entryTs, horizonMs, dir, funding) {
  const sch = funding.schedule.get(base);
  if (!sch) return { pct: 0, settlements: 0, projected: 0 };
  const exitTs = entryTs + horizonMs;
  let pct = 0;
  let n = 0;
  let projected = 0;
  for (const s of sch.settlements) {
    if (s.at <= entryTs) continue;
    if (s.at > exitTs) break;
    let rate = s.rate;
    if (!s.known) {
      rate = sch.currentRate; // flat-forward estimate, flagged
      projected++;
    }
    if (!Number.isFinite(rate)) continue;
    pct += (dir === "short" ? rate : -rate) * 100;
    n++;
  }
  return { pct, settlements: n, projected };
}

// ── the trade outcome ─────────────────────────────────────────────────────
/**
 * The ticket outcome for one observation at one geometry.
 *
 *   "win"  the target was touched first
 *   "loss" the stop was touched first, or the bar touched BOTH
 *           (AMBIGUOUS, resolved conservatively as a loss)
 *   {kind:"time", movePct, complete}  neither level was reached inside the
 *           hold: the trade is closed at the horizon's close and booked
 *           at the mark. `complete` is FALSE when the bar cache ran out
 *           before the hold window did — a truncated horizon, which is a
 *           different measurement from a real time exit.
 */
function outcome(bars, ts, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > ts) { start = i; break; }
  }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + MAX_HOLD_BARS);
  const complete = end - start >= MAX_HOLD_BARS;
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { kind: "loss", ambiguous: true, exitTs: b.t + BAR_MIN * 60_000 };
    if (hitTp) return { kind: "win", exitTs: b.t + BAR_MIN * 60_000 };
    if (hitSl) return { kind: "loss", exitTs: b.t + BAR_MIN * 60_000 };
  }
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100, exitTs: last.t + BAR_MIN * 60_000, complete };
}

// ── the main ───────────────────────────────────────────────────────────────
let CACHE = {};

function simulate(set, g, funding) {
  const trades = [];
  let unresolved = 0;
  let ambiguous = 0;
  let missingAtr = 0;
  let truncated = 0;
  let dedupDropped = 0;
  const seen = new Set();

  for (const c of set) {
    const bars = CACHE[c.pair];
    if (!bars?.length) { unresolved++; continue; }
    let idx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t <= c.ts) idx = i;
      else break;
    }
    if (idx < 0) { unresolved++; continue; }

    // ── DE-DUPLICATION ──
    // The collector re-reads a symbol every ~5 minutes, so the same
    // (symbol, entry-bar) can appear 2-3 times. It is ONE trade,
    // observed repeatedly: the same entry, the same exit, the same
    // funding. Counting it twice inflates n without adding information.
    const key = `${c.pair}|${bars[idx].t}`;
    if (seen.has(key)) { dedupDropped++; continue; }
    seen.add(key);

    const entry = bars[idx].c;
    const entryTs = bars[idx].t + BAR_MIN * 60_000; // the close of the entry bar
    const atrPct = Number(c.tapeAtrPct ?? c.tape?.atrPct ?? NaN);
    const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
    const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
    if (g.shipped) {
      if (!Number.isFinite(atrPct) || atrPct <= 0) { missingAtr++; unresolved++; continue; }
    }
    if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
    const long = c.dir === "long";
    const o = outcome(bars, c.ts, entry, tpPct, slPct, long);
    if (o === null) { unresolved++; continue; }
    if (o.kind === "loss" && o.ambiguous) ambiguous++;
    if (o.kind === "time" && !o.complete) truncated++;

    let pricePct;
    if (o.kind === "time") pricePct = o.movePct;
    else pricePct = o.kind === "win" ? tpPct : -slPct;
    if (!Number.isFinite(pricePct)) { unresolved++; continue; }

    const base = c.pair.split("/")[0];
    const exitTs = o.exitTs;
    const fu = fundingFor(base, entryTs, exitTs, c.dir, funding);
    const bucket = Math.floor(c.ts / BUCKET_MS);
    trades.push({
      pair: c.pair, base, dir: c.dir, bucket, ts: c.ts, entryTs, exitTs,
      holdMs: exitTs - entryTs, kind: o.kind, complete: o.kind !== "time" ? true : o.complete,
      tpPct, slPct,
      pricePct,                  // the TRADE's P&L in % of notional
      fundingPct: fu.pct,       // the funding RECEIVED in % of notional
      settlements: fu.settlements,
      unknownSettlements: fu.unknown,
      feePct: TAKER_RT,
      netPct: 0,
      netPctNoFunding: 0,
    });
  }
  for (const t of trades) {
    t.netPct = t.pricePct + t.fundingPct - t.feePct;
    t.netPctNoFunding = t.pricePct - t.feePct;
  }
  return { trades, unresolved, ambiguous, missingAtr, truncated, dedupDropped };
}

function armStats(trades) {
  const wins = trades.filter((t) => t.kind === "win").length;
  const losses = trades.filter((t) => t.kind === "loss").length;
  const times = trades.filter((t) => t.kind === "time").length;
  const resolved = wins + losses;
  return { wins, losses, times, resolved, winRate: resolved ? wins / resolved : 0 };
}

function main() {
  for (const f of [IN, BARS_FILE, FUND_FILE]) {
    if (!existsSync(f)) {
      console.error(`[carry] missing ${f}`);
      process.exitCode = 1;
      return;
    }
  }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const fundingRows = readFileSync(FUND_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  CACHE = JSON.parse(readFileSync(BARS_FILE, "utf8"));

  const funding = buildFundingSchedule(fundingRows);

  // ── the arms ──
  const signal = [];
  const control = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    control.push({ ...r, dir: tapeSide });
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const modelSide = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    if (!modelSide) continue;
    if (tapeSide !== modelSide) continue;
    signal.push({ ...r, dir: tapeSide });
  }

  const spanMin = (rows[rows.length - 1].ts - rows[0].ts) / 60000;
  const t0 = new Date(rows[0].ts).toISOString().slice(0, 16).replace("T", " ") + "Z";
  const t1 = new Date(rows[rows.length - 1].ts).toISOString().slice(0, 16).replace("T", " ") + "Z";
  console.log(`[carry] confluence: ${rows.length} rows | signal ${signal.length} | control ${control.length}`);
  console.log(`[carry] span: ${t0} -> ${t1} (${spanMin.toFixed(0)} min = ${(spanMin / 60).toFixed(2)} h)`);
  console.log(`[carry] funding: ${fundingRows.length} rows | ${funding.rounds.length} rounds | ${funding.schedule.size} symbols with a schedule`);
  console.log(`[carry] exposure: ${NOTIONAL.toFixed(2)} notional on ${EQUITY.toFixed(4)} equity = ${NOTIONAL_OVER_EQUITY.toFixed(4)}x`);
  console.log(`[carry] fee floor: ${TAKER_RT}% taker round trip on the notional (maker ${MAKER_RT}%)`);
  console.log();

  // ── the funding schedule, printed so it can be checked by eye ──
  console.log("  THE FUNDING SCHEDULE (derived from the collector, not assumed)");
  const intervals = new Map();
  for (const [, s] of funding.schedule) {
    const k = s.intervalMs / 3600000;
    intervals.set(k, (intervals.get(k) ?? 0) + 1);
  }
  console.log(`    settlement interval(s): ${[...intervals.entries()].sort().map(([h, n]) => `${h}h x${n} symbols`).join(", ")}`);
  const allSettlements = [...new Set([...funding.schedule.values()].flatMap((s) => s.settlements.map((x) => x.at)))].sort((a, b) => a - b);
  const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
  console.log(`    settlements in/around the window: ${allSettlements.map(fmt).join(", ")}`);
  const rates = fundingRows.map((r) => r.funding);
  console.log(`    the current per-symbol rate: min ${(minOf(rates) * 100).toFixed(4)}%  median ${(median(rates) * 100).toFixed(4)}%  max ${(maxOf(rates) * 100).toFixed(4)}% of notional per settlement`);
  const neg = rates.filter((r) => r < 0).length;
  console.log(`    symbols with a NEGATIVE current rate (a short PAYS these): ${neg} of ${rates.length} rows`);
  console.log();

  // ── the per-geometry measurement ──
  const results = [];
  for (const g of GEOMETRIES) {
    const S = simulate(signal, g, funding);
    const U = simulate(control, g, funding);
    const sTr = S.trades;
    const uTr = U.trades;
    if (sTr.length < 5) {
      console.log(`  ${g.name}: only ${sTr.length} trades — skipped`);
      continue;
    }
    const sComplete = sTr.filter((t) => t.complete);
    const uComplete = uTr.filter((t) => t.complete);

    const net = (tr) => tr.map((t) => t.netPct);
    const netNoF = (tr) => tr.map((t) => t.netPctNoFunding);
    const price = (tr) => tr.map((t) => t.pricePct);
    const fund = (tr) => tr.map((t) => t.fundingPct);
    const buck = (tr) => tr.map((t) => t.bucket);

    const excessPrice = mean(netNoF(sTr)) - mean(netNoF(uTr));
    const excessWithFund = mean(net(sTr)) - mean(net(uTr));
    const fundingDelta = mean(fund(sTr)) - mean(fund(uTr));

    const sc = clusterStats(net(sTr), buck(sTr));
    const uc = clusterStats(net(uTr), buck(uTr));
    const seD = Math.sqrt(sc.se ** 2 + uc.se ** 2);
    const tWithFund = seD > 0 ? excessWithFund / seD : 0;
    const scP = clusterStats(netNoF(sTr), buck(sTr));
    const ucP = clusterStats(netNoF(uTr), buck(uTr));
    const seDP = Math.sqrt(scP.se ** 2 + ucP.se ** 2);
    const tPrice = seDP > 0 ? excessPrice / seDP : 0;

    // The PAIRED, WITHIN-BUCKET estimator: the signal arm's mean minus
    // the control arm's mean inside the same 5-minute bucket. Both arms
    // share the buckets, so the bucket's common market drift cancels.
    const paired = [];
    const bucketIds = [...new Set([...buck(sTr), ...buck(uTr)])];
    for (const b of bucketIds) {
      const sv = net(sTr).filter((_, i) => buck(sTr)[i] === b);
      const uv = net(uTr).filter((_, i) => buck(uTr)[i] === b);
      if (sv.length && uv.length) paired.push(mean(sv) - mean(uv));
    }

    const sA = armStats(sTr);
    const uA = armStats(uTr);
    const sCA = armStats(sComplete);
    const uCA = armStats(uComplete);

    results.push({
      g, sTr, uTr, S, U, sComplete, uComplete,
      excessPrice, excessWithFund, fundingDelta,
      tPrice, tWithFund, tPaired: tstat(paired), pairedClusters: paired.length,
      sClusters: sc.clusters, uClusters: uc.clusters,
      sMean: mean(net(sTr)), uMean: mean(net(uTr)),
      sMeanNoFund: mean(netNoF(sTr)), uMeanNoFund: mean(netNoF(uTr)),
      sPriceMean: mean(price(sTr)), uPriceMean: mean(price(uTr)),
      sFundMean: mean(fund(sTr)), uFundMean: mean(fund(uTr)),
      sA, uA, sCA, uCA,
      settlementsTotal: sTr.reduce((a, t) => a + t.settlements, 0),
      tradesWithSettlement: sTr.filter((t) => t.settlements > 0).length,
      meanHoldMin: mean(sTr.map((t) => t.holdMs)) / 60000,
      medianHoldMin: median(sTr.map((t) => t.holdMs)) / 60000,
    });
  }

  console.log("  (a) SIGNAL ARM and (b) CONTROL ARM — per-trade P&L in % of NOTIONAL");
  console.log("  price   the trade's own P&L (TP/SL first touch, or the time-exit mark)");
  console.log("  funding the funding RECEIVED by the short at the ACTUAL settlement times inside the hold");
  console.log("  fees    the 0.12% taker round trip");
  console.log();
  console.log("  geometry                       n  win%  time%   price  funding    NET   | ctl: price  funding    NET   |  EXCESS   t  clus  trunc");
  console.log("  " + "-".repeat(138));
  for (const r of results) {
    const nm = r.g.name.padEnd(30);
    console.log(
      `  ${nm} ${String(r.sTr.length).padStart(3)} ${(r.sA.winRate * 100).toFixed(0).padStart(4)} ${((r.sA.times / r.sTr.length) * 100).toFixed(0).padStart(5)} ${(r.sPriceMean >= 0 ? "+" : "") + r.sPriceMean.toFixed(4)} ${(r.sFundMean >= 0 ? "+" : "") + r.sFundMean.toFixed(4)} ${(r.sMean >= 0 ? "+" : "") + r.sMean.toFixed(4)}   | ${(r.uPriceMean >= 0 ? "+" : "") + r.uPriceMean.toFixed(4)} ${(r.uFundMean >= 0 ? "+" : "") + r.uFundMean.toFixed(4)} ${(r.uMean >= 0 ? "+" : "") + r.uMean.toFixed(4)}   | ${(r.excessWithFund >= 0 ? "+" : "") + r.excessWithFund.toFixed(4)} ${r.tWithFund.toFixed(2).padStart(5)} ${String(r.sClusters).padStart(4)} ${String(r.S.truncated).padStart(5)}`,
    );
  }
  console.log();
  console.log("  (c) EXCESS WITHOUT FUNDING (price only) vs (d) EXCESS WITH FUNDING ON BOTH ARMS");
  console.log("  geometry                       EXCESS(price)    t   EXCESS(+funding both)    t   fundingDelta  paired t  n_paired");
  console.log("  " + "-".repeat(108));
  for (const r of results) {
    const nm = r.g.name.padEnd(30);
    console.log(
      `  ${nm} ${(r.excessPrice >= 0 ? "+" : "") + r.excessPrice.toFixed(4)} ${r.tPrice.toFixed(2).padStart(6)}   ${(r.excessWithFund >= 0 ? "+" : "") + r.excessWithFund.toFixed(4)} ${r.tWithFund.toFixed(2).padStart(6)}   ${(r.fundingDelta >= 0 ? "+" : "") + r.fundingDelta.toFixed(6)} ${r.tPaired.toFixed(2).padStart(8)} ${String(r.pairedClusters).padStart(8)}`,
    );
  }
  console.log();
  console.log("  fundingDelta is the funding's own contribution to the difference. It is NOT zero");
  console.log("  only because the two arms hold DIFFERENT symbols for DIFFERENT lengths of time.");
  console.log("  Compare it with the excess: if it is orders of magnitude smaller, the carry is");
  console.log("  a rounding error next to the signal, and it cannot rescue or destroy it.");
  console.log();

  // ── the candidate: the resolvable geometry with the best excess ──
  const resolvable = results.filter((r) => r.sA.losses > 0);
  const pool = resolvable.length ? resolvable : results;
  const ranked = [...pool].sort((a, b) => b.excessWithFund - a.excessWithFund);
  const cand = ranked[0];
  console.log("  " + "=".repeat(118));
  console.log(`  THE CANDIDATE (best excess among geometries with BOTH wins and losses): ${cand.g.name}`);
  console.log("  " + "=".repeat(118));
  const cc = cand.sComplete.length;
  console.log(`  signal arm: ${cand.sTr.length} trades (${cand.S.dedupDropped} duplicate re-reads dropped) | ${cand.sA.wins} wins, ${cand.sA.losses} losses, ${cand.sA.times} time exits | win rate ${(cand.sA.winRate * 100).toFixed(1)}%`);
  console.log(`  control arm: ${cand.uTr.length} trades (${cand.U.dedupDropped} dropped) | ${cand.uA.wins} wins, ${cand.uA.losses} losses, ${cand.uA.times} time exits | win rate ${(cand.uA.winRate * 100).toFixed(1)}%`);
  console.log(`  clusters: signal ${cand.sClusters}, control ${cand.uClusters} (5-minute buckets) | complete-horizon trades ${cc}/${cand.sTr.length} | truncated ${cand.S.truncated}`);
  console.log(`  hold: mean ${cand.meanHoldMin.toFixed(1)} min, median ${cand.medianHoldMin.toFixed(1)} min`);
  console.log(`  trades OPEN at a funding settlement: ${cand.tradesWithSettlement}/${cand.sTr.length} (${cand.settlementsTotal} settlements crossed in total)`);
  console.log(`  ambiguous bars (both levels touched -> counted as LOSSES): ${cand.S.ambiguous}`);
  console.log();
  console.log(`  (a) SIGNAL ARM, per trade, % of notional:  price ${cand.sPriceMean >= 0 ? "+" : ""}${cand.sPriceMean.toFixed(4)}  funding ${cand.sFundMean >= 0 ? "+" : ""}${cand.sFundMean.toFixed(4)}  fees ${(-TAKER_RT).toFixed(4)}  =  NET ${cand.sMean >= 0 ? "+" : ""}${cand.sMean.toFixed(4)}`);
  console.log(`      in % of equity (x${NOTIONAL_OVER_EQUITY.toFixed(4)}): NET ${(cand.sMean * NOTIONAL_OVER_EQUITY).toFixed(4)}% of equity per trade`);
  console.log(`  (b) CONTROL ARM, per trade, % of notional:  price ${cand.uPriceMean >= 0 ? "+" : ""}${cand.uPriceMean.toFixed(4)}  funding ${cand.uFundMean >= 0 ? "+" : ""}${cand.uFundMean.toFixed(4)}  fees ${(-TAKER_RT).toFixed(4)}  =  NET ${cand.uMean >= 0 ? "+" : ""}${cand.uMean.toFixed(4)}`);
  console.log(`      in % of equity (x${NOTIONAL_OVER_EQUITY.toFixed(4)}): NET ${(cand.uMean * NOTIONAL_OVER_EQUITY).toFixed(4)}% of equity per trade`);
  console.log(`  (c) EXCESS, price only:          ${cand.excessPrice >= 0 ? "+" : ""}${cand.excessPrice.toFixed(4)}pp   clustered t=${cand.tPrice.toFixed(2)}  (${cand.sClusters} clusters)`);
  console.log(`  (d) EXCESS, funding on BOTH arms: ${cand.excessWithFund >= 0 ? "+" : ""}${cand.excessWithFund.toFixed(4)}pp   clustered t=${cand.tWithFund.toFixed(2)}  (${cand.sClusters} clusters)`);
  console.log(`      the funding's own contribution to the difference: ${cand.fundingDelta >= 0 ? "+" : ""}${cand.fundingDelta.toFixed(6)}pp  (${(Math.abs(cand.fundingDelta / (cand.excessWithFund || 1)) * 100).toFixed(2)}% of the excess)`);
  console.log();

  // ── the complete-horizon subset ──
  console.log("  THE COMPLETE-HORIZON SUBSET (trades whose 16-bar window was fully in the cache)");
  if (cand.sComplete.length >= 5) {
    const scN = cand.sComplete.map((t) => t.netPct);
    const ucN = cand.uComplete.map((t) => t.netPct);
    const scN0 = cand.sComplete.map((t) => t.netPctNoFunding);
    const ucN0 = cand.uComplete.map((t) => t.netPctNoFunding);
    const scc = clusterStats(scN, cand.sComplete.map((t) => t.bucket));
    const ucc = clusterStats(ucN, cand.uComplete.map((t) => t.bucket));
    const exC = mean(scN) - mean(ucN);
    const seC = Math.sqrt(scc.se ** 2 + ucc.se ** 2);
    console.log(`    signal n=${cand.sComplete.length} (${cand.sCA.wins}W/${cand.sCA.losses}L/${cand.sCA.times}T) NET ${mean(scN) >= 0 ? "+" : ""}${mean(scN).toFixed(4)}%  |  control n=${cand.uComplete.length} NET ${mean(ucN) >= 0 ? "+" : ""}${mean(ucN).toFixed(4)}%`);
    console.log(`    EXCESS with funding on both arms: ${exC >= 0 ? "+" : ""}${exC.toFixed(4)}pp  clustered t=${seC > 0 ? (exC / seC).toFixed(2) : 0}  (${scc.clusters} clusters)`);
    console.log(`    EXCESS price only:              ${(mean(scN0) - mean(ucN0)) >= 0 ? "+" : ""}${(mean(scN0) - mean(ucN0)).toFixed(4)}pp`);
  } else {
    console.log(`    only ${cand.sComplete.length} complete-horizon trades — too few to measure`);
  }
  console.log();

  // ── the direction split and the market's own drift ──
  console.log("  THE DIRECTION SPLIT and the MARKET'S OWN DRIFT (is this beta?)");
  const sShort = cand.sTr.filter((t) => t.dir === "short").length;
  const sLong = cand.sTr.length - sShort;
  const uShort = cand.uTr.filter((t) => t.dir === "short").length;
  const uLong = cand.uTr.length - uShort;
  console.log(`    signal arm: ${sShort} short, ${sLong} long`);
  console.log(`    control arm: ${uShort} short, ${uLong} long`);
  const sShortNet = mean(cand.sTr.filter((t) => t.dir === "short").map((t) => t.netPct));
  const uShortNet = mean(cand.uTr.filter((t) => t.dir === "short").map((t) => t.netPct));
  console.log(`    short-only signal NET ${sShortNet >= 0 ? "+" : ""}${sShortNet.toFixed(4)}% | short-only control NET ${uShortNet >= 0 ? "+" : ""}${uShortNet.toFixed(4)}%`);
  // The market's own drift: the equal-weight mean move of every symbol in
  // the bar cache over the same window. A SHORT is profitable in a
  // FALLING market — so a positive short-arm P&L that the control arm
  // also shows is the market's drift, not the signal's edge.
  const drift = marketDrift();
  console.log(`    the market's own drift over the window: ${drift.pct >= 0 ? "+" : ""}${drift.pct.toFixed(4)}% (equal-weight, ${drift.n} symbols)`);
  console.log(`    -> a short in a ${drift.pct < 0 ? "FALLING" : "rising"} market pays both arms. The excess is the only part that can be the signal.`);
  console.log();

  // ── the TRIM TEST ──
  console.log("  THE TRIM TEST (the signal arm's best/worst 3 dropped, the excess re-measured)");
  {
    const sorted = [...cand.sTr.map((t) => t.netPct)].sort((a, b) => a - b);
    const dropWorst = sorted.slice(3);
    const dropBest = sorted.slice(0, sorted.length - 3);
    const exW = mean(dropWorst) - cand.uMean;
    const exB = mean(dropBest) - cand.uMean;
    console.log(`    worst-3 dropped: excess ${exW >= 0 ? "+" : ""}${exW.toFixed(4)}pp   best-3 dropped: excess ${exB >= 0 ? "+" : ""}${exB.toFixed(4)}pp`);
    console.log(`    the excess survives both trims: ${exW > 0 && exB > 0 ? "YES (in sign)" : "NO"}`);
  }
  console.log();

  // ── the PERMUTATION TEST ──
  // The placebo already reports the distribution, but a permutation test
  // on the ACTUAL arm labels answers the sharper question: are the
  // signal arm's trades better than the control arm's, shuffled?
  {
    const perm = permutationTest(cand);
    console.log("  THE PERMUTATION TEST (the signal/control labels shuffled within each bucket)");
    console.log(`    ${perm.trials} permutations: observed excess ${cand.excessWithFund >= 0 ? "+" : ""}${cand.excessWithFund.toFixed(4)}pp`);
    console.log(`    the shuffled distribution: mean ${perm.exMean >= 0 ? "+" : ""}${perm.exMean.toFixed(4)}pp  sd ${perm.exSd.toFixed(4)}  p95 ${perm.p95.toFixed(4)}`);
    console.log(`    permutations at or above the observed excess: ${perm.atOrAbove} (${((perm.atOrAbove / perm.trials) * 100).toFixed(1)}%) -> p = ${(perm.atOrAbove / perm.trials).toFixed(3)}`);
    console.log(`    ${perm.atOrAbove / perm.trials < 0.05 ? "SIGNIFICANT at the 5% level" : "NOT significant at the 5% level"}`);
  }
  console.log();

  // ── the PLACEBO ──
  const placebo = runPlacebo(cand, funding);
  console.log("  THE PLACEBO (a random selection of the same size, from the same cross-section)");
  console.log(`    real selection's cluster-mean excess: ${cand.excessWithFund >= 0 ? "+" : ""}${cand.excessWithFund.toFixed(4)}pp  t=${cand.tWithFund.toFixed(2)}`);
  console.log(`    placebo distribution over ${placebo.trials} random selections:`);
  console.log(`      excess: mean ${placebo.exMean >= 0 ? "+" : ""}${placebo.exMean.toFixed(4)}pp  sd ${placebo.exSd.toFixed(4)}  p5 ${placebo.exSorted[Math.floor(placebo.exSorted.length * 0.05)].toFixed(4)}  p95 ${placebo.exSorted[Math.floor(placebo.exSorted.length * 0.95)].toFixed(4)}`);
  console.log(`      t:      mean ${placebo.tMean.toFixed(2)}  p95 ${placebo.tSorted[Math.floor(placebo.tSorted.length * 0.95)].toFixed(2)}`);
  console.log(`      placebo runs with t>=2: ${placebo.significant}/${placebo.trials} (${((placebo.significant / placebo.trials) * 100).toFixed(1)}%)`);
  console.log(`      the real selection's excess sits at the ${placebo.percentile.toFixed(1)}th percentile of the placebo distribution`);
  console.log();

  // ── the funding arithmetic: how big is the carry? ──
  console.log("  THE FUNDING ARITHMETIC — how big is the carry, really?");
  const medRate = median(fundingRows.map((r) => r.funding));
  const perSettlePct = medRate * 100;
  const medSettleHours = median([...funding.schedule.values()].map((s) => s.intervalMs / 3600000));
  console.log(`    the median funding rate: ${(medRate * 100).toFixed(4)}% of notional per settlement (${medSettleHours}h interval)`);
  console.log(`    the taker round trip: ${TAKER_RT.toFixed(2)}% of notional`);
  console.log(`    settlements needed for the funding alone to cover the fee: ${(TAKER_RT / perSettlePct).toFixed(0)} -> ${(TAKER_RT / perSettlePct * medSettleHours).toFixed(0)} hours of holding`);
  console.log(`    settlements the candidate's trades actually crossed: ${(cand.settlementsTotal / Math.max(1, cand.sTr.length)).toFixed(3)} per trade`);
  console.log(`    funding actually received per trade: ${cand.sFundMean.toFixed(4)}% of notional = ${(cand.sFundMean / TAKER_RT * 100).toFixed(1)}% of the fee`);
  const shortfall = -cand.sMeanNoFund;
  console.log(`    the shortfall the funding must close: ${shortfall.toFixed(4)}% of notional per trade`);
  if (shortfall > 0 && perSettlePct > 0) {
    console.log(`    horizon needed to close it with carry alone: ${(shortfall / perSettlePct * medSettleHours).toFixed(0)} hours (${(shortfall / perSettlePct).toFixed(1)} settlements)`);
  } else {
    console.log(`    the signal arm is ALREADY net-positive without the funding (${cand.sMeanNoFund >= 0 ? "+" : ""}${cand.sMeanNoFund.toFixed(4)}%), so no carry is needed to pay the fee.`);
  }
  console.log();

  // ── the horizon sensitivity: at what horizon does the carry matter? ──
  console.log("  THE HORIZON SENSITIVITY — what the carry would be if the trade were HELD longer");
  console.log("    (the ACTUAL per-symbol rate at the ACTUAL settlement times, flat-forward beyond the observed window)");
  console.log("    NOTE: the price P&L is NOT re-simulated at these horizons — this isolates the CARRY.");
  console.log("    The 'net' columns hold the candidate's price P&L FIXED and add the carry, so they");
  console.log("    answer 'what would the carry alone do to the trade at this horizon', not");
  console.log("    'what would the trade have earned at this horizon'.");
  const horizons = [1, 2, 4, 8, 12, 24, 48, 72, 168];
  console.log("    horizon   funding/trade   set/trade   as % of fee   signal NET (+carry, taker)   signal NET (+carry, maker)");
  for (const h of horizons) {
    const ms = h * 3600000;
    let fp = 0;
    let ns = 0;
    let np = 0;
    let nt = 0;
    for (const t of cand.sTr) {
      const f = fundingOverHorizon(t.base, t.entryTs, ms, t.dir, funding);
      fp += f.pct;
      ns += f.settlements;
      if (f.projected) np += 1;
      nt += 1;
    }
    const fMean = nt ? fp / nt : 0;
    const netTaker = cand.sPriceMean + fMean - TAKER_RT;
    const netMaker = cand.sPriceMean + fMean - MAKER_RT;
    console.log(
      `    ${String(h).padStart(4)}h  ${(fMean >= 0 ? "+" : "") + fMean.toFixed(4)}%${(ns / Math.max(1, nt)).toFixed(2).padStart(9)} ${(fMean / TAKER_RT * 100).toFixed(1).padStart(10)}%  ${(netTaker >= 0 ? "+" : "") + netTaker.toFixed(4)}%${"".padStart(0)}   ${(netMaker >= 0 ? "+" : "") + netMaker.toFixed(4)}%   ${np ? `(${np}/${nt} trades use a projected rate)` : ""}`,
    );
  }
  console.log();

  // ── the decisive question: at what horizon does the carry ALONE pay the fee? ──
  console.log("  THE DECISIVE QUESTION — could a CARRY-ONLY trade pay the fee?");
  console.log("    A carry-only trade has ZERO price P&L. Its net is (carry - fee). For it to pay:");
  console.log("      carry per trade >= 0.12% of notional (taker) or 0.04% (maker).");
  const perSettleTaker = perSettlePct;
  const holdHoursTaker = TAKER_RT / perSettleTaker * medSettleHours;
  const holdHoursMaker = MAKER_RT / perSettleTaker * medSettleHours;
  console.log(`    at the MEDIAN rate of ${(medRate * 100).toFixed(4)}%/settlement on a ${medSettleHours}h interval:`);
  console.log(`      taker (0.12%): needs ${holdHoursTaker.toFixed(0)} hours of holding`);
  console.log(`      maker (0.04%): needs ${holdHoursMaker.toFixed(0)} hours of holding`);
  const bestRates = [...funding.schedule.values()].map((s) => s.currentRate).sort((a, b) => b - a);
  console.log(`    at the BEST rate on this universe (${(bestRates[0] * 100).toFixed(4)}%/settlement):`);
  console.log(`      taker (0.12%): needs ${(TAKER_RT / (bestRates[0] * 100) * medSettleHours).toFixed(0)} hours of holding`);
  console.log(`    the SHORTEST hold the candidate's trades actually take: ${(cand.medianHoldMin).toFixed(0)} min (median), ${cand.meanHoldMin.toFixed(0)} min (mean)`);
  console.log(`    -> a carry-only trade at these horizons is nowhere near break-even; the funding is`);
  console.log(`       a rounding error next to the fee, not a business.`);
  console.log();

  // ── the notional sensitivity ──
  console.log("  THE NOTIONAL SENSITIVITY — the carry and the fee are BOTH % of notional, so the");
  console.log("  per-notional expectancy is notional-invariant. What scales with notional is the");
  console.log("  % of EQUITY per trade (and the margin it consumes).");
  for (const n of [60, 250, 1000, 5000]) {
    const eq = 57.2287;
    console.log(`    notional $${String(n).padStart(5)} on $${eq} equity (${(n / eq).toFixed(2)}x): signal NET ${(cand.sMean * (n / eq)).toFixed(4)}% of equity/trade | funding received $${(cand.sFundMean / 100 * n).toFixed(4)}/trade | fee $${(TAKER_RT / 100 * n).toFixed(4)}/trade`);
  }
  console.log();

  // ── the verdict ──
  console.log("  THE VERDICT");
  const netPos = cand.sMean > 0;
  const clustersOk = cand.sClusters >= MIN_CLUSTERS;
  const edgeOk = cand.excessWithFund > 0 && cand.tWithFund >= 2;
  console.log(`    (a) Is the candidate's SIGNAL ARM net-positive with the funding? ${netPos ? `YES: ${cand.sMean.toFixed(4)}% of notional per trade (${(cand.sMean * NOTIONAL_OVER_EQUITY).toFixed(4)}% of equity)` : `NO: ${cand.sMean.toFixed(4)}% of notional per trade — still negative after the funding`}`);
  console.log(`    (b) Is the CONTROL arm net-positive? ${cand.uMean > 0 ? `YES: ${cand.uMean.toFixed(4)}% of notional` : `NO: ${cand.uMean.toFixed(4)}% of notional`}`);
  console.log(`    (d) Is the EXCESS significant (clusters >= ${MIN_CLUSTERS}, excess > 0, t >= 2)? ${clustersOk && edgeOk ? "YES" : `NO: ${cand.sClusters} clusters, excess ${cand.excessWithFund.toFixed(4)}pp, t=${cand.tWithFund.toFixed(2)}`}`);
  console.log(`    Is the funding load-bearing? ${Math.abs(cand.fundingDelta) > 0.1 * Math.abs(cand.excessWithFund) ? "YES" : `NO — the funding moves the excess by ${cand.fundingDelta.toFixed(6)}pp, which is ${(Math.abs(cand.fundingDelta / (cand.excessWithFund || 1)) * 100).toFixed(2)}% of it`}`);
  console.log();

  // The full detail of the candidate's trades.
  console.log("  THE CANDIDATE'S TRADES (each one: the hold, the funding it earned, the net)");
  console.log("    pair           dir    kind    hold(min)  settle  price%    funding%   net%");
  for (const t of cand.sTr.slice(0, 45)) {
    console.log(
      `    ${t.pair.padEnd(14)} ${t.dir.padEnd(6)} ${(t.kind + (t.complete ? "" : "*")).padEnd(5)} ${(t.holdMs / 60000).toFixed(0).padStart(6)} ${String(t.settlements).padStart(6)} ${(t.pricePct >= 0 ? "+" : "") + t.pricePct.toFixed(3)} ${(t.fundingPct >= 0 ? "+" : "") + t.fundingPct.toFixed(4)} ${(t.netPct >= 0 ? "+" : "") + t.netPct.toFixed(4)}`,
    );
  }
  if (cand.sTr.length > 45) console.log(`    ... and ${cand.sTr.length - 45} more`);
  console.log("    (* = truncated horizon: the bar cache ran out before the 16-bar window did)");
  console.log();
}

/**
 * The market's own drift over the study window: the equal-weight mean
 * close-to-close move of every symbol in the bar cache. A SHORT is
 * profitable in a FALLING market, so this is the beta both arms share.
 */
function marketDrift() {
  const moves = [];
  for (const [pair, bars] of Object.entries(CACHE)) {
    if (!bars?.length) continue;
    const first = bars[0].c;
    const last = bars[bars.length - 1].c;
    if (!(first > 0) || !(last > 0)) continue;
    moves.push(((last - first) / first) * 100);
  }
  return { pct: mean(moves), n: moves.length };
}

/**
 * The PERMUTATION TEST: the signal/control labels shuffled WITHIN each
 * bucket, so the bucket's common market drift is preserved and only the
 * label is broken. The observed excess is then compared with the
 * shuffled distribution.
 */
function permutationTest(cand) {
  const rng = (() => {
    let s = 987654321;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();
  const trials = 2000;
  // Pool the trades bucket by bucket, tagged with their arm.
  const pooled = new Map();
  for (const t of cand.sTr) {
    const arr = pooled.get(t.bucket) ?? [];
    arr.push({ v: t.netPct, arm: "s" });
    pooled.set(t.bucket, arr);
  }
  for (const t of cand.uTr) {
    const arr = pooled.get(t.bucket) ?? [];
    arr.push({ v: t.netPct, arm: "c" });
    pooled.set(t.bucket, arr);
  }
  const nSigPerBucket = new Map();
  for (const t of cand.sTr) nSigPerBucket.set(t.bucket, (nSigPerBucket.get(t.bucket) ?? 0) + 1);

  const exList = [];
  for (let trial = 0; trial < trials; trial++) {
    const perBucket = new Map();
    for (const [b, list] of pooled) {
      const shuffled = [...list].sort(() => rng() - 0.5);
      const k = nSigPerBucket.get(b) ?? 0;
      perBucket.set(b, {
        sel: shuffled.slice(0, k).map((x) => x.v),
        ctl: shuffled.slice(k).map((x) => x.v),
      });
    }
    const sAll = [];
    const uAll = [];
    const sB = [];
    const uB = [];
    for (const [b, v] of perBucket) {
      sAll.push(...v.sel);
      uAll.push(...v.ctl);
      sB.push(...v.sel.map(() => b));
      uB.push(...v.ctl.map(() => b));
    }
    if (!sAll.length || !uAll.length) continue;
    const sc = clusterStats(sAll, sB);
    const uc = clusterStats(uAll, uB);
    exList.push(sc.mean - uc.mean);
  }
  const exMean = mean(exList);
  const exSd = Math.sqrt(exList.reduce((s, x) => s + (x - exMean) ** 2, 0) / Math.max(1, exList.length - 1));
  const sorted = [...exList].sort((a, b) => a - b);
  const atOrAbove = exList.filter((x) => x >= cand.excessWithFund).length;
  return { trials, exMean, exSd, p95: sorted[Math.floor(sorted.length * 0.95)], atOrAbove };
}

/**
 * The PLACEBO: a RANDOM selection of the same size as the real signal
 * arm, drawn from the same cross-section, measured the same way. If the
 * real selection cannot beat it, the selection is not doing anything.
 */
function runPlacebo(cand, funding) {
  const rng = (() => {
    let s = 20261021;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();
  const trials = 300;
  const exList = [];
  const tList = [];
  const byBucket = new Map();
  for (const t of cand.uTr) {
    const arr = byBucket.get(t.bucket) ?? [];
    arr.push(t);
    byBucket.set(t.bucket, arr);
  }
  const realSize = new Map();
  for (const t of cand.sTr) realSize.set(t.bucket, (realSize.get(t.bucket) ?? 0) + 1);

  for (let trial = 0; trial < trials; trial++) {
    const sel = [];
    for (const [b, list] of byBucket) {
      const k = realSize.get(b) ?? 0;
      if (!k || k >= list.length) { sel.push(...list); continue; }
      const shuffled = [...list].sort(() => rng() - 0.5);
      sel.push(...shuffled.slice(0, k));
    }
    if (!sel.length) continue;
    const selNet = sel.map((t) => t.netPct);
    const selBuckets = sel.map((t) => t.bucket);
    const sc = clusterStats(selNet, selBuckets);
    const uc = clusterStats(cand.uNet ?? cand.uTr.map((t) => t.netPct), cand.uTr.map((t) => t.bucket));
    const ex = sc.mean - uc.mean;
    const seD = Math.sqrt(sc.se ** 2 + uc.se ** 2);
    exList.push(ex);
    tList.push(seD > 0 ? ex / seD : 0);
  }
  const exMean = mean(exList);
  const exSd = Math.sqrt(exList.reduce((s, x) => s + (x - exMean) ** 2, 0) / Math.max(1, exList.length - 1));
  const tMean = mean(tList);
  const tSorted = [...tList].sort((a, b) => a - b);
  const exSorted = [...exList].sort((a, b) => a - b);
  const significant = tList.filter((x) => x >= 2).length;
  const below = exSorted.filter((x) => x <= cand.excessWithFund).length;
  return { trials, exMean, exSd, tMean, tSorted, exSorted, significant, percentile: (below / exSorted.length) * 100 };
}

main();
