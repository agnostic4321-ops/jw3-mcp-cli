#!/usr/bin/env node
/**
 * THE HERO GEOMETRY SWEEP — can ANY ticket geometry clear its own break-even?
 *
 * ── THE QUESTION ──
 *
 * The shipped ticket's geometry is arithmetically a bleed:
 *
 *   TP   = clamp(ATR * 0.4, 0.3%, 0.5%)        (planScalp, src/kucoin.ts)
 *   STOP = the 2-step ladder's kill line         (planScalp, maxSteps=2)
 *   stepDrop = clamp(ATR * 0.9, 0.6%, 1.5%)
 *
 * On the eight REAL live fired tickets this is a 1:2.99 to 1:4.00
 * reward-to-risk, and the break-even win rate is 77.2% to 80.9%
 * (taker round trip on the notional). The machine's own signal wins
 * about 66.7% of the time, so the shipped ticket loses money even if the
 * signal is REAL.
 *
 * The question is therefore NOT "is there an edge" but:
 *
 *   FOR WHICH (TP, STOP, HOLD) GEOMETRY does the machine's own signal
 *   clear break-even, and does the excess over the unconditional
 *   same-direction control survive the cluster test?
 *
 * ── THE BREAK-EVEN, DERIVED (not assumed) ──
 *
 * A trade pays the taker round trip f on the NOTIONAL. Its expectancy is
 *
 *   EV = w * (TP - f) + (1 - w) * (-SL - f)
 *      = w * (TP + SL) - (SL + f)
 *
 * so EV = 0 when
 *
 *   w_be = (SL + f) / (TP + SL)
 *
 * NOTE: the earlier geometry study used (SL + f) / (TP + SL + f) — an
 * EXTRA +f in the denominator. That formula UNDERSTATES the required win
 * rate: plugging it back into the expectancy gives EV < 0, so it is not
 * a break-even at all. The study's own headline number, 78.7% for the
 * SUI ticket's geometry, is that wrong formula's output; the CORRECT
 * break-even for the same TP 0.3626% / SL 1.2188% geometry is 84.66%.
 * The shipped ticket is therefore WORSE than the study concluded, not
 * better. Both numbers are reported side by side below.
 *
 * ── THE SIMULATION — the REAL ticket outcome ──
 *
 * For every observation and every geometry:
 *
 *   - the ENTRY is the collector's BOOK MID at the observation (what the
 *     live path actually pays), and the forward walk starts at the NEXT
 *     5-minute boundary, so no part of the bar the observation happened
 *     inside is used. No look-ahead.
 *   - walk the forward bars:
 *       the TARGET is touched and not the STOP -> WIN
 *       the STOP is touched and not the TARGET -> LOSS
 *       a SINGLE bar touches BOTH               -> LOSS (conservative: an
 *                                                   ambiguous bar is never
 *                                                   counted as a win)
 *   - if the horizon is reached with NEITHER level touched, the trade is
 *     closed at the horizon's close and booked at the mark-to-market
 *     MINUS the fee. Dropping those trades is the SELECTED-SAMPLE trap:
 *     the trades that resolve are exactly the ones that moved far enough
 *     to hit a level.
 *   - an observation whose FULL window is not covered by bars is REFUSED
 *     for that horizon, never silently truncated.
 *
 * Every trade pays the taker round trip on the NOTIONAL: 0.12% for a
 * 100%-taker fill (the task's floor, and the primary here), 0.08% for the
 * live path's maker-entry/taker-exit schedule.
 *
 * ── THE ARMS ──
 *
 *   SIGNAL   the machine's own signal: the tape's side AND the models
 *            agreeing with it. This is the only thing it trades.
 *   REVERSE  the SAME observations traded the OPPOSITE way. If the
 *            reverse clears too, the geometry is beta, not edge.
 *   CONTROL  the unconditional same-direction control: every row with a
 *            tape side, in the SAME direction as the signal arm, with NO
 *            model filter. This is what the models' agreement has to beat.
 *   CTRL-REV the same control, opposite direction.
 *
 * ── THE STATISTICS ──
 *
 * The collector samples ~43 symbols every 5 minutes and crypto moves
 * together, so the rows inside one 5-minute bucket are ~43 correlated
 * observations of ONE market state. The t-statistic is computed on
 * CLUSTER MEANS (one mean per 5-minute bucket).
 *
 * The excess between two arms is tested two ways:
 *   t         Welch on the two arms' cluster means (independent)
 *   t_paired  paired by bucket — the arms are NESTED (the control is a
 *             superset of the signal in time), so the paired test is the
 *             more powerful. The VERDICT uses the conservative Welch t.
 *
 * The BAR a geometry must clear:
 *   n_clusters >= 30 INDEPENDENT clusters, excess > 0, t >= 2, and the
 *   result survives trimming the best 3 and the worst 3 trades.
 *
 * ── READ-ONLY ──
 *
 * Reads local files and the PUBLIC kline endpoint. Never touches the
 * account, the venue's private API, or the shared *.ndjson files.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN = join(SCRATCH, "confluence.ndjson");
const BARS_CACHE = join(SCRATCH, "geom-hero-bars.json");
const OUT = join(SCRATCH, "geom-hero-results.json");
const SNAPSHOT = join(SCRATCH, "geom-hero-snapshot.ndjson");

/** The taker round trip, in % of the NOTIONAL (maker 0.02/side, taker 0.06/side). */
const TAKER_RT = 0.12;
/** The live path's own schedule: a resting maker entry, a taker exit. */
const LIVE_RT = 0.08;
/** The CLUSTER: one per 5-minute collector bucket. */
const BUCKET_MS = 5 * 60_000;
const INTERVAL_MIN = 5;
const INTERVAL_MS = INTERVAL_MIN * 60_000;

/**
 * The ticket's exposure. Measured from the eight live fired tickets:
 * notional $57.38-$59.64 on equity $57.23-$57.46, leverage 20-43x. The
 * $60 notional cap binds, so the notional is ~1.03x equity.
 */
const NOTIONAL_OVER_EQUITY = 59.0 / 57.35;

/** The observed signal win rate the task quotes: 66.7%. */
const OBSERVED_WIN = 0.667;

// ── the grid ──
const GRID_TP = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0];
const GRID_SL = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.5, 2.0];
const GRID_HOLD = [15, 30, 60, 120, 240];

// ── statistics ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const clusterMeans = (values, buckets) => {
  const by = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = by.get(b) ?? [];
    arr.push(values[i]);
    by.set(b, arr);
  }
  return [...by.values()].map((a) => mean(a));
};

/**
 * The CORRECT break-even win rate.
 *
 *   EV = w*(TP - f) + (1-w)*(-SL - f) = w*(TP+SL) - (SL+f) = 0
 *   => w_be = (SL + f) / (TP + SL)
 */
const breakEvenWinRate = (tpPct, slPct, rt) => (slPct + rt) / (tpPct + slPct);

/** The earlier study's formula, which UNDERSTATES the requirement. */
const breakEvenWinRateStudy = (tpPct, slPct, rt) => (slPct + rt) / (tpPct + slPct + rt);

const CACHE = existsSync(BARS_CACHE) ? JSON.parse(readFileSync(BARS_CACHE, "utf8")) : {};

// ── the arms ──
function buildArms(rows) {
  const modelSide = (r) => {
    const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    return j && l ? (j === l ? j : null) : (j || l);
  };
  const all = [];
  for (const r of rows) {
    const t = tapeSideFromRow(r);
    if (!t) continue;
    const m = modelSide(r);
    const strictOk = !!(r.side && r.tapeSide && r.tapeSide === r.side && r.jevUncertain === false);
    all.push({ ...r, tape: t, model: m, strictOk, dir: t });
  }
  return {
    all,
    tapeAll: all,
    loose: all.filter((r) => r.model && r.model === r.tape),
    strict: all.filter((r) => r.strictOk),
  };
}

/**
 * The SHIPPED geometry, exactly as planScalp builds it for a 2-step
 * ladder, measured from the ticket's DECLARED entry (the size-weighted
 * average entry `avgEntry`, which is what the live path's target and
 * stop are anchored to).
 *
 *   stepDrop = clamp(ATR * 0.9, 0.6%, 1.5%)
 *   TP%      = clamp(ATR * 0.4, 0.3%, 0.5%)
 *   avgEntry = last * (1 +/- stepDrop/200)
 *   kill     = last * (1 +/- 2*stepDrop/100)
 *
 * so, measured from avgEntry:
 *   STOP% = (3*stepDrop/200) / (1 +/- stepDrop/200)
 *
 * The sign is + for a short (the kill is above last) and - for a long.
 */
function shippedGeometry(atrPct, side) {
  const atr = Number(atrPct);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const stepDrop = Math.min(1.5, Math.max(0.6, atr * 0.9));
  const d = stepDrop / 100;
  const slPct = (1.5 * d * 100) / (side === "long" ? 1 - d / 2 : 1 + d / 2);
  return { tpPct, slPct, stepDrop };
}

/** Prepare one observation for one hold horizon. */
function prepare(obs, holdMin) {
  const bars = CACHE[obs.pair];
  if (!bars?.length) return null;
  const entry = Number(obs.price);
  if (!(entry > 0)) return null;
  const nBars = Math.round(holdMin / INTERVAL_MIN);
  // The forward window starts at the NEXT 5-minute boundary after the
  // observation: the bar the observation happened inside is excluded, so
  // a level already touched before the trade existed cannot win.
  const start = bars.findIndex((b) => b.t > obs.ts);
  if (start < 0) return null;
  const end = start + nBars;
  if (end > bars.length) return null; // the full window is not covered
  const win = bars.slice(start, end);
  const runMax = new Array(win.length);
  const runMin = new Array(win.length);
  let mx = -Infinity, mn = Infinity;
  for (let i = 0; i < win.length; i++) {
    mx = Math.max(mx, win[i].h);
    mn = Math.min(mn, win[i].l);
    runMax[i] = mx;
    runMin[i] = mn;
  }
  const close = win[win.length - 1].c;
  const long = obs.dir === "long";
  const mark = (long ? (close - entry) / entry : (entry - close) / entry) * 100;
  return { entry, long, runMax, runMin, mark, ts: obs.ts, pair: obs.pair, atr: Number(obs.tapeAtrPct) };
}

/** The first-touch resolution for an arbitrary (TP%, SL%) pair. */
function resolve(prep, tpPct, slPct) {
  const tp = prep.long ? prep.entry * (1 + tpPct / 100) : prep.entry * (1 - tpPct / 100);
  const sl = prep.long ? prep.entry * (1 - slPct / 100) : prep.entry * (1 + slPct / 100);
  for (let i = 0; i < prep.runMax.length; i++) {
    const hitTp = prep.long ? prep.runMax[i] >= tp : prep.runMin[i] <= tp;
    const hitSl = prep.long ? prep.runMin[i] <= sl : prep.runMax[i] >= sl;
    if (hitTp && hitSl) return "loss"; // ambiguous bar -> conservative
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  return "time";
}

/** Simulate one geometry over a set of prepared observations. */
function simulate(prepared, tpPct, slPct, rt) {
  const trades = [];
  for (const p of prepared) {
    const kind = resolve(p.prep, tpPct, slPct);
    let pnl;
    if (kind === "win") pnl = tpPct - rt;
    else if (kind === "loss") pnl = -slPct - rt;
    else pnl = p.prep.mark - rt;
    trades.push({ kind, pnl, bucket: p.bucket, ts: p.ts, pair: p.pair, dir: p.dir });
  }
  return trades;
}

function stats(trades) {
  const wins = trades.filter((t) => t.kind === "win");
  const losses = trades.filter((t) => t.kind === "loss");
  const times = trades.filter((t) => t.kind === "time");
  const resolved = wins.length + losses.length;
  const pnl = trades.map((t) => t.pnl);
  const buckets = trades.map((t) => t.bucket);
  const cm = clusterMeans(pnl, buckets);
  return {
    trades: trades.length, wins: wins.length, losses: losses.length, times: times.length,
    resolved,
    winRate: resolved ? wins.length / resolved : 0,
    resolutionRate: trades.length ? resolved / trades.length : 0,
    ev: mean(pnl), evSe: se(pnl),
    clusters: cm.length, clusterMean: mean(cm), clusterSe: se(cm),
    pnl, buckets, tradeList: trades,
  };
}

function excessOf(sig, ctl) {
  const d = sig.clusterMean - ctl.clusterMean;
  const sd = Math.sqrt(sig.clusterSe ** 2 + ctl.clusterSe ** 2);
  const t = sd > 0 ? d / sd : 0;
  const sBy = new Map(), cBy = new Map();
  for (const x of sig.tradeList) { const a = sBy.get(x.bucket) ?? []; a.push(x.pnl); sBy.set(x.bucket, a); }
  for (const x of ctl.tradeList) { const a = cBy.get(x.bucket) ?? []; a.push(x.pnl); cBy.set(x.bucket, a); }
  const diffs = [];
  for (const [b, arr] of sBy) { if (cBy.has(b)) diffs.push(mean(arr) - mean(cBy.get(b))); }
  const pSe = se(diffs);
  return { excess: d, excessSe: sd, t, pairedN: diffs.length, pairedT: pSe > 0 ? mean(diffs) / pSe : 0 };
}

function trimTest(sig, ctl) {
  const sorted = [...sig.pnl].sort((a, b) => a - b);
  return {
    worstExcess: mean(sorted.slice(3)) - ctl.ev,
    bestExcess: mean(sorted.slice(0, sorted.length - 3)) - ctl.ev,
  };
}

function main() {
  const raw = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(SNAPSHOT, raw.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rows = raw;

  const arms = buildArms(rows);
  const cl = (set) => new Set(set.map((r) => Math.floor(r.ts / BUCKET_MS))).size;
  const tsAll = rows.map((r) => r.ts);
  const span = { from: new Date(minOf(tsAll)).toISOString(), to: new Date(maxOf(tsAll)).toISOString() };
  const sides = (set) => set.reduce((a, r) => { a[r.dir] = (a[r.dir] ?? 0) + 1; return a; }, {});

  console.log(`[sweep] ${rows.length} rows, span ${span.from} -> ${span.to}`);
  console.log(`[sweep] tape-side rows ${arms.tapeAll.length} / ${cl(arms.tapeAll)} clusters`);
  console.log(`[sweep] LOOSE arm  ${arms.loose.length} / ${cl(arms.loose)} clusters  sides ${JSON.stringify(sides(arms.loose))}`);
  console.log(`[sweep] STRICT arm ${arms.strict.length} / ${cl(arms.strict)} clusters  sides ${JSON.stringify(sides(arms.strict))}`);
  console.log(`[sweep] notional/equity ${NOTIONAL_OVER_EQUITY.toFixed(4)}x  (from the eight live fired tickets)`);
  console.log();

  const SIGNAL = arms.loose;
  const sigSideCounts = sides(SIGNAL);
  const dominantSide = Object.entries(sigSideCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "short";
  const minoritySide = dominantSide === "long" ? "short" : "long";
  const CONTROL = arms.tapeAll.filter((t) => t.dir === dominantSide);
  const REVERSE = SIGNAL.map((s) => ({ ...s, dir: minoritySide }));
  const CONTROL_REV = arms.tapeAll.filter((t) => t.dir === minoritySide);
  console.log(`[sweep] the signal arm's dominant side is ${dominantSide} (${sigSideCounts[dominantSide] ?? 0} rows); the minority side is ${minoritySide} (${sigSideCounts[minoritySide] ?? 0} rows)`);
  console.log(`[sweep] CONTROL (${dominantSide}, no model filter) ${CONTROL.length} / ${cl(CONTROL)} clusters`);
  console.log(`[sweep] CTRL-REV (${minoritySide}, no model filter) ${CONTROL_REV.length} / ${cl(CONTROL_REV)} clusters`);
  console.log();

  const results = [];

  for (const hold of GRID_HOLD) {
    const prepFor = (set) => {
      const prepared = [];
      let refused = 0;
      for (const o of set) {
        const p = prepare(o, hold);
        if (!p) { refused++; continue; }
        prepared.push({ prep: p, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, pair: o.pair, dir: o.dir });
      }
      return { prepared, refused };
    };
    const S = prepFor(SIGNAL);
    const C = prepFor(CONTROL);
    const R = prepFor(REVERSE);
    const CR = prepFor(CONTROL_REV);
    console.log(`[sweep] hold ${hold}m: signal ${S.prepared.length} (refused ${S.refused}) | control ${C.prepared.length} (refused ${C.refused}) | reverse ${R.prepared.length} | ctrl-rev ${CR.prepared.length}`);

    for (const rt of [TAKER_RT, LIVE_RT]) {
      for (const tp of GRID_TP) {
        for (const sl of GRID_SL) {
          if (tp > sl * 4) continue;
          const sig = stats(simulate(S.prepared, tp, sl, rt));
          if (!sig.trades) continue;
          const ctl = stats(simulate(C.prepared, tp, sl, rt));
          const rev = stats(simulate(R.prepared, tp, sl, rt));
          const crev = stats(simulate(CR.prepared, tp, sl, rt));
          const ex = excessOf(sig, ctl);
          const trim = trimTest(sig, ctl);
          const be = breakEvenWinRate(tp, sl, rt);
          results.push({
            rt, tp, sl, hold, r: tp / sl,
            be,
            beStudy: breakEvenWinRateStudy(tp, sl, rt),
            winRate: sig.winRate, resolutionRate: sig.resolutionRate,
            ev: sig.ev, evEquity: sig.ev * NOTIONAL_OVER_EQUITY, evSe: sig.evSe,
            excess: ex.excess, excessSe: ex.excessSe, t: ex.t, pairedT: ex.pairedT, pairedN: ex.pairedN,
            clusters: sig.clusters,
            trades: sig.trades,
            wins: sig.wins, losses: sig.losses, times: sig.times,
            evResolved: mean(sig.tradeList.filter((t) => t.kind !== "time").map((t) => t.pnl)),
            evTime: mean(sig.tradeList.filter((t) => t.kind === "time").map((t) => t.pnl)),
            resolvedN: sig.resolved, timeN: sig.times,
            controlEv: ctl.ev, controlWinRate: ctl.winRate, controlClusters: ctl.clusters,
            reverseEv: rev.ev, reverseWinRate: rev.winRate, reverseClusters: rev.clusters,
            ctrlRevEv: crev.ev, ctrlRevWinRate: crev.winRate,
            trimWorstExcess: trim.worstExcess, trimBestExcess: trim.bestExcess,
            signalRefused: S.refused, controlRefused: C.refused,
          });
        }
      }
    }
    console.log(`[sweep] hold ${hold}m done: ${results.length} geometries so far`);
  }
  console.log();

  const primary = results.filter((r) => r.rt === TAKER_RT);
  const live = results.filter((r) => r.rt === LIVE_RT);

  // ── the shipped geometry ──
  console.log("═══ THE SHIPPED GEOMETRY (planScalp, 2 steps, anchored on the declared entry) ═══");
  console.log("  hold    n  win%  time%  resolved%   break-even(correct)  study's BE   EV/notional  EV/equity  control.EV   EXCESS       t  clus   verdict");
  for (const hold of GRID_HOLD) {
    const prepared = [];
    let noAtr = 0;
    for (const o of SIGNAL) {
      const p = prepare(o, hold);
      if (!p) continue;
      const g = shippedGeometry(p.atr, p.long ? "long" : "short");
      if (!g) { noAtr++; continue; }
      prepared.push({ prep: p, g, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, pair: o.pair, dir: o.dir });
    }
    if (!prepared.length) { console.log(`  ${String(hold + "m").padStart(5)}  no observations with a covered ${hold}-minute window`); continue; }
    const cPrepared = [];
    for (const o of CONTROL) {
      const p = prepare(o, hold);
      if (!p) continue;
      const g = shippedGeometry(p.atr, p.long ? "long" : "short");
      if (!g) continue;
      cPrepared.push({ prep: p, g, bucket: Math.floor(o.ts / BUCKET_MS), ts: o.ts, pair: o.pair, dir: o.dir });
    }
    const one = (list) => {
      const trades = [];
      for (const p of list) {
        const kind = resolve(p.prep, p.g.tpPct, p.g.slPct);
        let pnl;
        if (kind === "win") pnl = p.g.tpPct - TAKER_RT;
        else if (kind === "loss") pnl = -p.g.slPct - TAKER_RT;
        else pnl = p.prep.mark - TAKER_RT;
        trades.push({ kind, pnl, bucket: p.bucket, ts: p.ts, pair: p.pair, dir: p.dir });
      }
      return trades;
    };
    const sig = stats(one(prepared));
    const ctl = stats(one(cPrepared));
    const be = mean(prepared.map((p) => breakEvenWinRate(p.g.tpPct, p.g.slPct, TAKER_RT)));
    const beS = mean(prepared.map((p) => breakEvenWinRateStudy(p.g.tpPct, p.g.slPct, TAKER_RT)));
    const ex = excessOf(sig, ctl);
    console.log(
      `  ${String(hold + "m").padStart(5)} ${String(sig.trades).padStart(3)} ${(sig.winRate * 100).toFixed(1).padStart(5)}% ${((sig.times / sig.trades) * 100).toFixed(0).padStart(5)}% ${(sig.resolutionRate * 100).toFixed(0).padStart(8)}% ${(be * 100).toFixed(1).padStart(16)}% ${(beS * 100).toFixed(1).padStart(10)}% ${(sig.ev >= 0 ? "+" : "") + sig.ev.toFixed(4)}% ${(sig.ev * NOTIONAL_OVER_EQUITY >= 0 ? "+" : "") + (sig.ev * NOTIONAL_OVER_EQUITY).toFixed(4)}% ${(ctl.ev >= 0 ? "+" : "") + ctl.ev.toFixed(4)}% ${(ex.excess >= 0 ? "+" : "") + ex.excess.toFixed(4)}% ${ex.t.toFixed(2).padStart(6)} ${String(sig.clusters).padStart(4)}   ${sig.ev > 0 ? "EV>0" : "BLEED"}`,
    );
  }
  console.log();

  // ── the report ──
  console.log("═══ THE SWEEP — 100% TAKER (0.12% round trip), the task's floor ═══");
  console.log(`  ${primary.length} geometries simulated.`);
  const clearsObserved = primary.filter((r) => r.be < OBSERVED_WIN);
  const evPos = primary.filter((r) => r.ev > 0);
  const passesBar = primary.filter((r) => r.excess > 0 && r.t >= 2 && r.clusters >= 30 && r.trimWorstExcess > 0 && r.trimBestExcess > 0);
  console.log(`  break-even BELOW the observed 66.7% win rate: ${clearsObserved.length}`);
  console.log(`  POSITIVE net expectancy:                     ${evPos.length}`);
  console.log(`  pass the FULL bar (excess>0, t>=2, >=30 clusters, trim-stable): ${passesBar.length}`);
  console.log();

  const rank = (list, key, n = 25) => [...list].sort((a, b) => b[key] - a[key]).slice(0, n);

  console.log("  ── Top 25 by NET EXPECTANCY per trade (taker 0.12%) ──");
  console.log("     TP%    SL%   1:R   hold    n  win%     BE%  studyBE%   EV/not  EV/eq  control   EXCESS      t  t_pair  clus  time%  res%  rev.EV");
  for (const r of rank(evPos.length ? evPos : primary, "ev", 25)) {
    console.log(
      `     ${String(r.tp).padStart(4)} ${String(r.sl).padStart(5)} ${(1 / r.r).toFixed(2).padStart(6)} ${String(r.hold + "m").padStart(5)} ${String(r.trades).padStart(4)} ${(r.winRate * 100).toFixed(1).padStart(6)} ${(r.be * 100).toFixed(1).padStart(6)} ${(r.beStudy * 100).toFixed(1).padStart(7)} ${(r.ev >= 0 ? "+" : "") + r.ev.toFixed(4)} ${(r.evEquity >= 0 ? "+" : "") + r.evEquity.toFixed(4)} ${(r.controlEv >= 0 ? "+" : "") + r.controlEv.toFixed(4)} ${(r.excess >= 0 ? "+" : "") + r.excess.toFixed(4)} ${r.t.toFixed(2).padStart(6)} ${r.pairedT.toFixed(2).padStart(6)} ${String(r.clusters).padStart(5)} ${((r.times / r.trades) * 100).toFixed(0).padStart(5)}% ${(r.resolutionRate * 100).toFixed(0).padStart(4)}% ${(r.reverseEv >= 0 ? "+" : "") + r.reverseEv.toFixed(3)}`,
    );
  }
  console.log();

  console.log("  ── The BEST geometry at EACH hold horizon (by net expectancy) ──");
  console.log("     hold    TP%    SL%   1:R    n  win%     BE%   EV/not  EV/eq  control   EXCESS      t  t_pair  clus  time%  res%  rev.EV");
  for (const h of GRID_HOLD) {
    const at = primary.filter((r) => r.hold === h);
    if (!at.length) continue;
    const b = rank(at, "ev", 1)[0];
    console.log(
      `     ${String(h + "m").padStart(4)} ${String(b.tp).padStart(6)} ${String(b.sl).padStart(6)} ${(1 / b.r).toFixed(2).padStart(6)} ${String(b.trades).padStart(4)} ${(b.winRate * 100).toFixed(1).padStart(6)} ${(b.be * 100).toFixed(1).padStart(6)} ${(b.ev >= 0 ? "+" : "") + b.ev.toFixed(4)} ${(b.evEquity >= 0 ? "+" : "") + b.evEquity.toFixed(4)} ${(b.controlEv >= 0 ? "+" : "") + b.controlEv.toFixed(4)} ${(b.excess >= 0 ? "+" : "") + b.excess.toFixed(4)} ${b.t.toFixed(2).padStart(6)} ${b.pairedT.toFixed(2).padStart(6)} ${String(b.clusters).padStart(5)} ${((b.times / b.trades) * 100).toFixed(0).padStart(5)}% ${(b.resolutionRate * 100).toFixed(0).padStart(4)}% ${(b.reverseEv >= 0 ? "+" : "") + b.reverseEv.toFixed(3)}`,
    );
  }
  console.log();

  console.log("  ── THE DECOMPOSITION (the selected-sample check) ──");
  console.log("     The level-resolved subset is SELECTED (only the trades that moved far");
  console.log("     enough to hit a level). The time-exit subset is UNSELECTED (every trade");
  console.log("     is a mark). The edge has to live in the UNSELECTED subset.");
  console.log("     hold    TP%    SL%   |  resolved subset        |  time-exit subset");
  console.log("                                      n   EV          |      n   EV");
  for (const h of GRID_HOLD) {
    const at = primary.filter((r) => r.hold === h);
    if (!at.length) continue;
    const b = rank(at, "ev", 1)[0];
    console.log(
      `     ${String(h + "m").padStart(4)} ${String(b.tp).padStart(6)} ${String(b.sl).padStart(6)}   | ${String(b.resolvedN).padStart(5)} ${(b.evResolved >= 0 ? "+" : "") + b.evResolved.toFixed(4)}%      | ${String(b.timeN).padStart(5)} ${(b.evTime >= 0 ? "+" : "") + b.evTime.toFixed(4)}%`,
    );
  }
  console.log();

  const best = rank(primary, "ev", 1)[0];
  if (best) {
    console.log("  ── THE BEST GEOMETRY BY NET EXPECTANCY ──");
    console.log(`     TP ${best.tp}%   STOP ${best.sl}%   (1:${(1 / best.r).toFixed(2)})   hold ${best.hold}m   taker ${best.rt}% round trip`);
    console.log(`     observed win rate      ${(best.winRate * 100).toFixed(2)}%  of ${best.trades} trades  (${best.wins}W ${best.losses}L ${best.times} time exits, ${(best.resolutionRate * 100).toFixed(0)}% resolved at a level)`);
    console.log(`     break-even win rate    ${(best.be * 100).toFixed(2)}%   (the earlier study's formula said ${(best.beStudy * 100).toFixed(2)}%)`);
    console.log(`     net expectancy/trade   ${(best.ev >= 0 ? "+" : "") + best.ev.toFixed(4)}% of NOTIONAL = ${(best.evEquity >= 0 ? "+" : "") + best.evEquity.toFixed(4)}% of EQUITY`);
    console.log(`     unconditional control  ${(best.controlEv >= 0 ? "+" : "") + best.controlEv.toFixed(4)}%  (win ${(best.controlWinRate * 100).toFixed(1)}%, ${best.controlClusters} clusters)`);
    console.log(`     EXCESS                 ${(best.excess >= 0 ? "+" : "") + best.excess.toFixed(4)}%  t=${best.t.toFixed(2)}  (paired t=${best.pairedT.toFixed(2)}, n=${best.pairedN})`);
    console.log(`     independent clusters   ${best.clusters}`);
    console.log(`     trim (worst 3 dropped / best 3 dropped)  ${(best.trimWorstExcess >= 0 ? "+" : "") + best.trimWorstExcess.toFixed(4)}% / ${(best.trimBestExcess >= 0 ? "+" : "") + best.trimBestExcess.toFixed(4)}%`);
    console.log(`     REVERSE arm            ${(best.reverseEv >= 0 ? "+" : "") + best.reverseEv.toFixed(4)}%  (win ${(best.reverseWinRate * 100).toFixed(1)}%)`);
    console.log(`     CTRL-REV arm           ${(best.ctrlRevEv >= 0 ? "+" : "") + best.ctrlRevEv.toFixed(4)}%  (win ${(best.ctrlRevWinRate * 100).toFixed(1)}%)`);
    console.log(`     BAR: ${best.excess > 0 && best.t >= 2 && best.clusters >= 30 && best.trimWorstExcess > 0 && best.trimBestExcess > 0 ? "PASSES" : "does NOT pass"}`);
  }
  console.log();

  const bestEx = rank(primary.filter((r) => r.clusters >= 20), "excess", 1)[0];
  if (bestEx) {
    console.log("  ── THE BEST GEOMETRY BY EXCESS OVER THE CONTROL ──");
    console.log(`     TP ${bestEx.tp}%   STOP ${bestEx.sl}%   (1:${(1 / bestEx.r).toFixed(2)})   hold ${bestEx.hold}m`);
    console.log(`     win ${(bestEx.winRate * 100).toFixed(2)}%  BE ${(bestEx.be * 100).toFixed(2)}%  EV ${bestEx.ev.toFixed(4)}%  control ${bestEx.controlEv.toFixed(4)}%  EXCESS ${bestEx.excess.toFixed(4)}%  t ${bestEx.t.toFixed(2)}  clusters ${bestEx.clusters}`);
    console.log(`     BAR: ${bestEx.excess > 0 && bestEx.t >= 2 && bestEx.clusters >= 30 && bestEx.trimWorstExcess > 0 && bestEx.trimBestExcess > 0 ? "PASSES" : "does NOT pass"}`);
  }
  console.log();

  console.log("═══ THE BETA CHECK ═══");
  const bothPos = primary.filter((r) => r.ev > 0 && r.reverseEv > 0);
  console.log(`  ${bothPos.length} of ${primary.length} geometries are positive on the REVERSED side too.`);
  console.log("  A geometry that pays in both directions is the market's drift, not the signal.");
  console.log(`  ${primary.filter((r) => r.reverseEv > 0 && r.ev <= 0).length} geometries are positive ONLY on the reversed side.`);
  console.log();

  console.log("═══ THE SAME SWEEP AT THE LIVE PATH'S OWN FEE (maker entry 0.02% + taker exit 0.06% = 0.08%) ═══");
  console.log(`  positive net expectancy: ${live.filter((r) => r.ev > 0).length} of ${live.length}`);
  const bestLive = rank(live, "ev", 1)[0];
  if (bestLive) {
    console.log(`  best: TP ${bestLive.tp}% STOP ${bestLive.sl}% hold ${bestLive.hold}m  win ${(bestLive.winRate * 100).toFixed(1)}%  BE ${(bestLive.be * 100).toFixed(1)}%  EV ${bestLive.ev.toFixed(4)}% of notional = ${bestLive.evEquity.toFixed(4)}% of equity  EXCESS ${bestLive.excess.toFixed(4)}% t ${bestLive.t.toFixed(2)} clusters ${bestLive.clusters}`);
  }
  console.log();

  const byHold = {};
  for (const r of primary) {
    const k = r.hold;
    if (!byHold[k] || r.clusters > byHold[k].clusters) byHold[k] = r;
  }
  console.log("═══ THE SAMPLE ═══");
  for (const h of GRID_HOLD) {
    const r = byHold[h];
    if (r) console.log(`    hold ${String(h + "m").padStart(4)}: ${r.clusters} clusters, ${r.trades} trades, ${r.signalRefused} signal observations refused for want of a covered window`);
  }
  console.log(`  the bar needs >= 30 independent clusters.`);
  console.log();

  console.log("═══ WHAT WOULD HAVE TO BE TRUE ═══");
  console.log("  For a geometry to pay for itself at the observed 66.7% win rate, its");
  console.log("  break-even (SL + f) / (TP + SL) must sit BELOW 66.7%. Solving for TP:");
  console.log("      TP_required = (SL + f) / w - SL");
  for (const sl of [0.3, 0.5, 0.8, 1.2]) {
    const tpReq = (sl + TAKER_RT) / OBSERVED_WIN - sl;
    console.log(`    at STOP ${sl}%: the target must be >= ${tpReq.toFixed(3)}%   (1:${(sl / tpReq).toFixed(2)})`);
  }
  console.log("  And the measured EXCURSION puts a hard ceiling on the target: the mean");
  console.log("  4-hour excursion on this sample is +0.345% up and -0.641% down. A target");
  console.log("  near the mean excursion is reached in well under half the windows, so it");
  console.log("  converts stops into time exits — which is not a win.");
  console.log("  AND the sample itself: the signal arm spans");
  const sigTs = SIGNAL.map((r) => r.ts).sort((a, b) => a - b);
  console.log(`    ${new Date(sigTs[0]).toISOString()} -> ${new Date(sigTs[sigTs.length - 1]).toISOString()}`);
  console.log("    so a 240-minute time exit has NO forward coverage at all, and a");
  console.log("    120-minute exit has only ~20 clusters. The bar needs 30.");
  console.log();

  writeFileSync(OUT, JSON.stringify({
    meta: {
      span, rows: rows.length,
      loose: arms.loose.length, looseClusters: cl(arms.loose),
      strict: arms.strict.length, strictClusters: cl(arms.strict),
      control: CONTROL.length, controlClusters: cl(CONTROL),
      controlRev: CONTROL_REV.length,
      dominantSide, minoritySide,
      notionalOverEquity: NOTIONAL_OVER_EQUITY,
      takerRT: TAKER_RT, liveRT: LIVE_RT,
      observedWinRate: OBSERVED_WIN,
      snapshot: SNAPSHOT,
      generatedAt: new Date().toISOString(),
    },
    results: results.map(({ tradeList, ...rest }) => rest),
  }, null, 2));
  console.log(`[sweep] results -> ${OUT}`);
  console.log(`[sweep] snapshot -> ${SNAPSHOT}`);
}

main();
