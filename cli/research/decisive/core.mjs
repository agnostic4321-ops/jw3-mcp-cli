#!/usr/bin/env node
/**
 * THE DECISIVE HARNESS — does the confirmation layer's excess survive?
 *
 * ══ WHAT THIS MEASURES ══
 *
 * The claim under test: the confirmation layer (the two models agreeing
 * with the tape) adds a POSITIVE excess over the tape alone, on the live
 * ticket, with the live fee.
 *
 * Three things this does that the previous measurements did not:
 *
 * 1. THE CLUSTER IS THE ROUND, NOT THE ROW. The collector reads 43
 *    symbols SEQUENTIALLY, so a round is 43 rows spanning 3-5 minutes of
 *    wall clock that all share ONE market state. The 5-minute bucketing
 *    used by the study SPLITS rounds that straddle a boundary. Every
 *    statistic here is on ROUND-level means.
 *
 * 2. THE PAIRED-BY-ROUND EXCESS OVER A GENUINE CONTROL. The control is
 *    the tape-only arm (every tape signal, no model filter), restricted
 *    to the SAME rounds as the signal arm. The pairing cancels the
 *    market's own drift in that round, so the difference is the
 *    confirmation layer's contribution and nothing else.
 *
 * 3. THE LIVE TICKET AND THE LIVE FEE. d = clamp(0.9 x ATR%, 0.6, 1.5);
 *    avgEntry = last  (MARKET-ANCHORED — see the note in buildTicket);
 *    stop% = 3d/(200+d);
 *    TP = clamp(0.4 x ATR%, 0.3, 0.5). The fee is taker+taker = 0.12% of
 *    NOTIONAL, which is 0.1260% of equity at the account's 1.0484x
 *    exposure. First-touch resolution; a bar touching BOTH levels is a
 *    LOSS; an explicit 240-minute TIME EXIT books the trade at its mark.
 *
 * READ-ONLY. No venue calls, no account calls. Writes only to decisive/*.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/research/tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

// ── the live path's constants (kucoin.ts / live-cmd.ts) ──
const ATR_MULT_STOP = 0.9;
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16; // 16 x 15m = 240 minutes
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const TAKER = 0.0006; // per leg, of NOTIONAL
const ROUND_TRIP = TAKER * 2;

// ── statistics ──
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
export const se = (a) => (a.length < 2 ? 0 : sd(a) / Math.sqrt(a.length));

/**
 * The two-sided p-value for a t statistic with df degrees of freedom,
 * via the regularized incomplete beta function:
 *
 *     p_two_sided = I_{df/(df+t^2)}(df/2, 1/2)
 *
 * (Numerical Recipes' `betai` with the Lentz continued fraction.)
 */
export function tPval(t, df) {
  if (!Number.isFinite(t) || df < 1) return 1;
  return betai(df / 2, 0.5, df / (df + t * t));
}
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function lgamma(z) {
  // Lanczos approximation
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * The two-sided critical |t| at `alpha` for df degrees of freedom:
 * the value with a TWO-SIDED p-value of exactly `alpha`.
 */
export function tCrit(alpha, df) {
  // tPval returns the two-sided p, so the critical value satisfies
  // tPval(t, df) === alpha. Bisection on the exact p-value.
  let lo = 0, hi = 200;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (tPval(mid, df) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── the round assignment ──
/**
 * A ROUND is a maximal run of consecutive collector rows whose inter-row
 * gap is <= 60s. The collector reads 43 symbols sequentially, so a round
 * is 43 rows spanning 3-5 minutes that all share one market state.
 */
export function roundAssign(allRows) {
  const roundOf = new Map();
  let round = 0, i = 0;
  while (i < allRows.length) {
    const start = i;
    let j = i;
    while (j + 1 < allRows.length && allRows[j + 1].ts - allRows[j].ts <= 60_000) j++;
    for (let k = start; k <= j; k++) roundOf.set(k, round);
    round++;
    i = j + 1;
  }
  return roundOf;
}

// ── the ticket ──
export function ticketFor(r) {
  const atrPct = r.tapeAtrPct;
  if (!(atrPct > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = r.price;
  if (!(last > 0)) return null;
  // THE MARKET-ANCHORED TICKET — the one the live path now builds.
  //
  // The offset anchor (avgEntry = last*(1 + d/200)) put the take-profit
  // on the WRONG SIDE of the market for a short, so every trade was a
  // marketable scratch that the simulation booked as a full target win.
  // See docs/research/the-scratch-artefact.md.
  //
  // The entry IS the market, and the target is beyond it in the
  // profitable direction, so the market has to MOVE to reach it.
  const avgEntry = last;
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = r.dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = r.dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, stopPrice, targetPrice };
}

/**
 * Resolve the ticket on the forward 15-minute bars.
 *   - a bar touching BOTH levels is a LOSS (conservative)
 *   - a trade reaching neither level is closed at the TIME EXIT, booked at
 *     its mark — a real outcome, not an unresolved one
 */
export function resolve(r, ticket, bars) {
  let i = -1;
  for (let k = 0; k < bars.length; k++) { if (bars[k].t > r.ts) { i = k; break; } }
  if (i < 0) return null;
  const end = Math.min(bars.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = r.dir === "long";
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= ticket.targetPrice : bar.l <= ticket.targetPrice;
    const hitSl = long ? bar.l <= ticket.stopPrice : bar.h >= ticket.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", ambiguous: true, bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
    if (hitTp) return { outcome: "win", bars: k - i + 1, pnlPct: ticket.tpFrac - ROUND_TRIP };
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -ticket.stopFrac - ROUND_TRIP };
  }
  const lastBar = bars[end - 1];
  const movePct = long
    ? (lastBar.c - ticket.avgEntry) / ticket.avgEntry
    : (ticket.avgEntry - lastBar.c) / ticket.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: movePct - ROUND_TRIP };
}

/**
 * Simulate one arm. Returns one record per TRADE with its round key, so
 * the cluster statistic is on round means.
 */
export function simulate(arm, barsByPair, roundOf, rowKey) {
  const trades = [];
  let wins = 0, losses = 0, times = 0, ambiguous = 0, unresolved = 0;
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) { unresolved++; continue; }
    const b = barsByPair[r.pair];
    if (!b) { unresolved++; continue; }
    const o = resolve(r, t, b);
    if (!o) { unresolved++; continue; }
    const pnlEquity = o.pnlPct * RHO * 100; // percent of equity
    trades.push({
      ts: r.ts, pair: r.pair, dir: r.dir, round: roundOf.get(rowKey(r)) ?? r.ts,
      outcome: o.outcome, pnl: pnlEquity, atrPct: t.atrPct, tpPct: t.tpPct,
      stopFrac: t.stopFrac, bars: o.bars, ambiguous: !!o.ambiguous,
    });
    if (o.outcome === "win") wins++;
    else if (o.outcome === "loss") losses++;
    else times++;
    if (o.ambiguous) ambiguous++;
  }
  return { trades, wins, losses, times, ambiguous, unresolved };
}

/** Group trades into round-level means. */
export function roundMeans(trades) {
  const m = new Map();
  for (const t of trades) {
    const a = m.get(t.round) ?? [];
    a.push(t.pnl);
    m.set(t.round, a);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ round: k, n: v.length, mean: mean(v) }));
}

/**
 * THE PAIRED-BY-ROUND EXCESS.
 *
 * For each round that appears in BOTH arms, the difference of the two
 * arms' round means. The market's drift in that round cancels, because
 * both arms were traded in it. What is left is the confirmation layer's
 * contribution.
 */
export function pairedExcess(sigTrades, ctlTrades) {
  const s = new Map(roundMeans(sigTrades).map((c) => [c.round, c.mean]));
  const c = new Map(roundMeans(ctlTrades).map((x) => [x.round, x.mean]));
  const shared = [...s.keys()].filter((k) => c.has(k)).sort((a, b) => a - b);
  const diffs = shared.map((k) => s.get(k) - c.get(k));
  const m = mean(diffs);
  const sE = se(diffs);
  const t = sE > 0 ? m / sE : 0;
  const df = diffs.length - 1;
  return {
    rounds: diffs.length,
    excess: m,
    se: sE,
    t,
    df,
    p: diffs.length > 1 ? 2 * tPval(Math.abs(t), df) : 1,
    crit05: diffs.length > 1 ? tCrit(0.05, df) : NaN,
    diffs,
    shared,
  };
}

/** The arm's own EV on ROUND means (not on rows). */
export function armStats(sim) {
  const cm = roundMeans(sim.trades);
  return {
    n: sim.trades.length,
    wins: sim.wins, losses: sim.losses, times: sim.times,
    ambiguous: sim.ambiguous, unresolved: sim.unresolved,
    winRate: sim.wins + sim.losses ? sim.wins / (sim.wins + sim.losses) : 0,
    rounds: cm.length,
    ev: mean(cm.map((c) => c.mean)),
    evSe: se(cm.map((c) => c.mean)),
    clusterMeans: cm,
  };
}
