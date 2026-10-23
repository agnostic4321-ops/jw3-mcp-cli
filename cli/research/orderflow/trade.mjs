#!/usr/bin/env node
/**
 * THE TRADE OUTCOME — the net expectancy in DOLLARS at the real size.
 *
 * ══ WHY THIS FILE EXISTS ══
 *
 * A forward return is not a trade. The machine places a market entry on
 * both sides, so it pays the taker fee TWICE, and it has a take-profit
 * and a kill level, not a horizon. The number that decides whether to
 * arm is:
 *
 *     NET EXPECTANCY IN DOLLARS PER TRADE at $60 notional
 *
 * with the 0.12% taker round trip ($0.0720 per ticket) subtracted from
 * every trade, and the ticket's own geometry (a live-path ATR-derived
 * take-profit and stop) applied.
 *
 * ══ THE RESOLUTION RULES, EXACTLY AS THE PROJECT'S OWN ══
 *
 *   - first touch of the take-profit or the kill level wins;
 *   - a bar touching BOTH is a LOSS (conservative);
 *   - a trade reaching NEITHER is closed at the TIME EXIT, booked at
 *     its mark — a real outcome, not an unresolved one;
 *   - the 240-minute (16 x 15m) time exit.
 *
 * ══ THE GEOMETRY, THE LIVE PATH'S OWN ══
 *
 *   d       = clamp(0.9 x ATR%, 0.6, 1.5)          (a percent number)
 *   avgEntry= last x (1 + d/200)   for a short
 *   stop%   = 3d / (200 + d)                        (a fraction)
 *   TP      = clamp(0.4 x ATR%, 0.3, 0.5)          (a percent number)
 *
 * ══ THE WIN RATE THAT MATTERS ══
 *
 * The break-even win rate at the real size, computed from the ACTUAL
 * win and loss sizes of the arm — not assumed. The fee is 40% of the
 * gross win, so the break-even is high, and a measured win rate below
 * it is a losing trade no matter how good the t looks.
 *
 * READ-ONLY. Local files only.
 */
import { mean, stdev, fmt, bucketOf, hourBucketOf } from "./lib.mjs";
import {
  NOTIONAL, EQUITY, RHO, ROUND_TRIP, FEE_USD,
  ATR_MULT_STOP, ATR_CLAMP_LO, ATR_CLAMP_HI, TP_ATR_MULT, TP_CLAMP_LO, TP_CLAMP_HI,
} from "./lib.mjs";

/** The live path's ticket. `atrPct` and `price` come from the row. */
export function ticket(atrPct, price, dir) {
  if (!(atrPct > 0) || !(price > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const avgEntry = dir === "short" ? price * (1 + d / 200) : price * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, stopPrice, targetPrice };
}

/**
 * Resolve a ticket against the forward bars.
 * `bars` must be the symbol's bar array, ascending by time, and
 * `entryAfterTs` is the timestamp the trade starts after.
 */
export function resolve(tk, dir, bars, entryAfterTs, holdBars = 16) {
  if (!tk || !bars || !bars.length) return null;
  let i = -1;
  for (let k = 0; k < bars.length; k++) if (bars[k].t > entryAfterTs) { i = k; break; }
  if (i < 0) return null;
  const end = Math.min(bars.length, i + holdBars);
  if (end - i < 2) return null;
  const long = dir === "long";
  for (let k = i; k < end; k++) {
    const bar = bars[k];
    const hitTp = long ? bar.h >= tk.targetPrice : bar.l <= tk.targetPrice;
    const hitSl = long ? bar.l <= tk.stopPrice : bar.h >= tk.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -tk.stopFrac - ROUND_TRIP };
    if (hitTp) return { outcome: "win", bars: k - i + 1, pnlPct: tk.tpFrac - ROUND_TRIP };
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -tk.stopFrac - ROUND_TRIP };
  }
  const lb = bars[end - 1];
  const mv = long ? (lb.c - tk.avgEntry) / tk.avgEntry : (tk.avgEntry - lb.c) / tk.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: mv - ROUND_TRIP };
}

/**
 * Measure an arm of resolved trades: the win rate, the net expectancy
 * in dollars, the break-even win rate, and the cluster-corrected t on
 * the excess over the control arm.
 */
export function measureArm(trades, label) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const times = trades.filter((t) => t.outcome === "time");
  const decided = wins.length + losses.length;
  const winRate = decided ? wins.length / decided : 0;
  const usd = trades.map((t) => t.pnlPct * NOTIONAL);
  const evUsd = mean(usd);
  const evPctEquity = evUsd / EQUITY * 100;
  const avgWinUsd = wins.length ? mean(wins.map((t) => t.pnlPct * NOTIONAL)) : 0;
  const avgLossUsd = losses.length ? mean(losses.map((t) => t.pnlPct * NOTIONAL)) : 0;
  const be = (avgWinUsd - avgLossUsd) !== 0 ? -avgLossUsd / (avgWinUsd - avgLossUsd) : 0;
  // the fee as a share of the gross win
  const grossWin = avgWinUsd + FEE_USD;
  const feeShare = grossWin > 0 ? FEE_USD / grossWin : 0;
  return {
    label, n, wins: wins.length, losses: losses.length, times: times.length,
    winRate, evUsd, evPctEquity, avgWinUsd, avgLossUsd, be,
    feeShareOfGrossWin: feeShare,
    timesShare: times.length / n,
  };
}

/** The paired excess between two arms of trades, by cluster. */
export function tradeExcess(arm, control) {
  const byA = new Map(), byC = new Map();
  for (const t of arm) {
    if (!byA.has(t.bucket)) byA.set(t.bucket, []);
    byA.get(t.bucket).push(t.pnlUsd);
  }
  for (const t of control) {
    if (!byC.has(t.bucket)) byC.set(t.bucket, []);
    byC.get(t.bucket).push(t.pnlUsd);
  }
  const diffs = [];
  for (const [b, va] of byA) {
    const vb = byC.get(b);
    if (!vb || !vb.length) continue;
    diffs.push(mean(va) - mean(vb));
  }
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  const m = mean(diffs);
  return { n: diffs.length, mean: m, se, t: se > 0 ? m / se : 0, diffs };
}

/** The trim: drop the worst-3 and best-3 clusters, recompute the t. */
export function trimTrade(diffs, k = 3) {
  if (diffs.length <= 2 * k) return { n: diffs.length, mean: mean(diffs), se: 0, t: 0 };
  const s = [...diffs].sort((a, b) => a - b);
  const kept = s.slice(k, s.length - k);
  const se = kept.length > 1 ? stdev(kept) / Math.sqrt(kept.length) : 0;
  const m = mean(kept);
  return {
    n: kept.length, mean: m, se, t: se > 0 ? m / se : 0,
    worst3: s.slice(0, k).map((v) => v.toFixed(5)),
    best3: s.slice(s.length - k).map((v) => v.toFixed(5)),
  };
}

export function fmtArm(a) {
  if (!a) return "n/a";
  return `n=${a.n} win ${(a.winRate * 100).toFixed(1)}% time ${(a.timesShare * 100).toFixed(1)}% | ` +
    `EV $${a.evUsd.toFixed(4)} (${a.evPctEquity.toFixed(4)}% of equity) | BE-WR ${(a.be * 100).toFixed(1)}% | ` +
    `win $${a.avgWinUsd.toFixed(4)} loss $${a.avgLossUsd.toFixed(4)} | fee ${(a.feeShareOfGrossWin * 100).toFixed(1)}% of gross win`;
}
