#!/usr/bin/env python3
"""
THE SELECTION-RULE ENGINE
==========================

THE RULE IS OPERATIONAL, NOT ORACLE
-----------------------------------
A universe is decided ONCE PER DAY, from the data available BEFORE that
day, and every signal on those symbols is traded that day. So:

  * the universe for day D is computed from bars up to the close of
    day D-1  -> NO LOOK-AHEAD within the day
  * it is refreshed daily, which matches the capacity constraint (8
    tickets/day) and the way a human would actually run it
  * the RULE'S PARAMETERS are chosen on the FIRST HALF of the window and
    measured on the SECOND HALF

THE CANDIDATE RULES
-------------------
  A. NO SELECTION — the rotating pool (the control).
  B. VOLATILITY PERCENTILE: the K symbols whose trailing 24-hour ATR is
     the highest relative to their own trailing 7-day median. "Ride
     the volatile ones."
  C. VOLATILITY FLOOR: the symbols whose trailing 24-hour ATR is above
     a percentile threshold.
  D. SPREAD TIGHTNESS: the K symbols with the tightest spread. The
     spread is a per-symbol STRUCTURAL property (tick size and book
     depth), so it is stable, but it was MEASURED in the collector's
     4.5-hour window — which is stated as a limit.
  E. TREND: the K symbols whose trailing 24-hour drift is strongest.
  F. TREND-QUIET: the K symbols with the FLATTEST trailing drift — the
     fade needs a range to fade, but a strong trend means the fade
     keeps fading.
  G. COMBINED: volatility percentile + a spread ceiling.

THE STATISTICS
--------------
  Every t is on HOUR CLUSTER MEANS (one per hour), because the tape's
  state changes only when an hour bar closes, and the symbols in an
  hour move together.
  The EXCESS is over the rotating pool in the SAME hour, so the market's
  regime cancels.
  A PLACEBO of the same shape: random K-symbol universes, measured
  identically.
  TRIM STABILITY: the worst-3 / best-3 trim of the hour means.
"""
import json, os, sys, math, collections, statistics as st
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uni_core import (mean, sd, se, median, pct, mulberry32,
                      NOTIONAL, TAKER_RT, EQUITY, DAILY_NOTIONAL_CAP)

SCRATCH = os.path.dirname(os.path.abspath(__file__))
HOUR_MS = 3600_000
DAY_MS = 86400_000
K = 8          # the capacity: 8 tickets a day
T_MIN_CLUSTERS = 30
T_BAR = 2.0
TRIM_N = 3
PLACEBO_DRAWS = 2000


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')


def atr_pct_over(bars, n):
    """The mean true range over the last n bars, as a % of the last close."""
    b = sorted(bars, key=lambda x: x['t'])
    if len(b) < n + 1: return None
    w = b[-(n + 1):]
    trs = []
    for i in range(1, len(w)):
        prev = w[i - 1]['c']
        trs.append(max(w[i]['h'] - w[i]['l'], abs(w[i]['h'] - prev), abs(w[i]['l'] - prev)))
    if not trs: return None
    atr = mean(trs)
    if atr <= 0 or w[-1]['c'] <= 0: return None
    return atr / w[-1]['c'] * 100.0


def drift_over(bars, n):
    """The drift over the last n bars, in % of the last close."""
    b = sorted(bars, key=lambda x: x['t'])
    if len(b) < n + 1: return None
    if b[-n - 1]['c'] <= 0: return None
    return (b[-1]['c'] / b[-n - 1]['c'] - 1) * 100.0


def daily_features(bars1h, days, atr_baseline_hours=72):
    """For each DAY, the per-symbol features computed from the data
    available BEFORE that day. NO LOOK-AHEAD by construction.

    `atr_baseline_hours` is the lookback for the symbol's own BASELINE
    ATR, against which the trailing 24-hour ATR is compared to form the
    volatility ratio. It is 72 hours (3 days) rather than 7 days so that
    the study window yields enough OPERATING DAYS to split in half: a
    7-day baseline needs 7 days of history before the first day, which
    would leave only 7 operating days in a 14-day window.
    """
    out = {}
    for p, bars in bars1h.items():
        b = sorted(bars, key=lambda x: x['t'])
        for d in sorted({x['t'] // DAY_MS for x in b}):
            prior = [x for x in b if x['t'] < d * DAY_MS]
            if len(prior) < 48: continue
            atr24 = atr_pct_over(prior, 24)
            atr_base = atr_pct_over(prior, atr_baseline_hours)
            drift24 = drift_over(prior, 24)
            if atr24 is None or atr_base is None or drift24 is None: continue
            if atr_base <= 0: continue
            out[(p, d)] = dict(atr24=atr24, atr7d=atr_base,
                               vol_ratio=atr24 / atr_base,
                               drift24=drift24)
    return out


def cluster_excess(trades_subset, pool_by_hour):
    """The per-hour cluster-mean excess of a subset over the pool."""
    by = collections.defaultdict(list)
    for t in trades_subset:
        by[t['hour']].append(t['pnl_usd'])
    diffs = []
    for h, v in by.items():
        pv = pool_by_hour.get(h)
        if not pv: continue
        diffs.append(mean(v) - mean(pv))
    return diffs


def stat_block(diffs, label=''):
    """The full statistic block for a set of hour-cluster diffs."""
    if not diffs:
        return dict(n=0)
    m = mean(diffs); s = se(diffs)
    t = m / s if s > 0 else None
    full = m
    trimmed = None; worst = None; best = None
    if len(diffs) >= TRIM_N * 2 + 1:
        ss = sorted(diffs)
        trimmed = mean(ss[TRIM_N:-TRIM_N])
        worst = mean(ss[:TRIM_N]); best = mean(ss[-TRIM_N:])
    # the largest single cluster's share of the total
    tot = sum(diffs)
    largest = (max(diffs) / tot) if tot != 0 else None
    # the t WITHOUT the three biggest clusters (the fragility check)
    ss = sorted(diffs)
    if len(ss) > TRIM_N:
        cut = ss[:-TRIM_N]
        t_trim = (mean(cut) / se(cut)) if se(cut) > 0 else None
    else:
        t_trim = None
    return dict(n=len(diffs), mean=full, t=t, se=s,
                trimmed=trimmed, worst3=worst, best3=best, t_trim=t_trim,
                largest_share=largest,
                mean_trim=(trimmed - full) if (trimmed is not None) else None)


def placebo(diffs, n_syms, trades_by_pair, pool_by_hour, draws=PLACEBO_DRAWS, seed=99):
    """The PLACEBO: random K-symbol universes, measured identically."""
    rnd = mulberry32(seed)
    pairs = list(trades_by_pair.keys())
    if len(pairs) < n_syms: return None
    obs = mean(diffs) if diffs else 0.0
    ge = 0
    for _ in range(draws):
        sel = set(rnd.sample(pairs, n_syms))
        sub = [t for p in sel for t in trades_by_pair[p]]
        d = cluster_excess(sub, pool_by_hour)
        if d and mean(d) >= obs: ge += 1
    return (ge + 1) / (draws + 1)
