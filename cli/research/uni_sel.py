#!/usr/bin/env python3
"""
THE SELECTION-RULE ENGINE — the operational rules, the half-split
out-of-sample check, the placebo, and the capacity arithmetic.
"""
import json, os, sys, math, collections, statistics as st
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uni_core import (mean, sd, se, median, pct, mulberry32,
                      NOTIONAL, TAKER_RT, EQUITY, DAILY_NOTIONAL_CAP)
from uni_rules import (HOUR_MS, DAY_MS, K, T_MIN_CLUSTERS, T_BAR, TRIM_N,
                       utc, daily_features, cluster_excess, stat_block)

SCRATCH = os.path.dirname(os.path.abspath(__file__))


def f(x, d=3, pad=None):
    if x is None or (isinstance(x, float) and math.isnan(x)): s = 'n/a'
    else: s = f'{x:.{d}f}'
    return s.rjust(pad) if pad else s


def pf(x, d=1, pad=None):
    if x is None or (isinstance(x, float) and math.isnan(x)): s = 'n/a'
    else: s = f'{x*100:.{d}f}%'
    return s.rjust(pad) if pad else s


def usd(x, pad=None):
    if x is None: s = 'n/a'
    else: s = f'${x:+.4f}'
    return s.rjust(pad) if pad else s


def build_universe(features, spread, day, rule, k=K):
    """The universe for ONE day, under ONE rule, from the features
    available BEFORE that day. NO LOOK-AHEAD.

    features: {(pair, day): {atr24, atr7d, vol_ratio, drift24}}
    spread:   {pair: median spread bps}
    """
    cands = []
    for (p, d), ft in features.items():
        if d != day: continue
        if ft['vol_ratio'] is None: continue
        cands.append((p, ft))
    if not cands: return set()
    if rule == 'NONE':
        return {p for p, _ in cands}
    if rule == 'VOL_PERCENTILE':
        # the K symbols whose 24h ATR is highest RELATIVE to their own
        # 7-day median: the ones that are unusually active right now
        cands.sort(key=lambda x: -x[1]['vol_ratio'])
        return {p for p, _ in cands[:k]}
    if rule == 'VOL_FLOOR':
        # the symbols whose 24h ATR is in the top half of the universe
        vs = sorted(x[1]['vol_ratio'] for x in cands)
        med = median(vs)
        sel = [p for p, ft in cands if ft['vol_ratio'] >= med]
        return set(sel[:k]) if len(sel) > k else set(sel)
    if rule == 'SPREAD':
        cands.sort(key=lambda x: spread.get(x[0], 1e9))
        return {p for p, _ in cands[:k]}
    if rule == 'SPREAD_VOL':
        # the tightest spreads, and only those with an above-median
        # volatility: the fee floor needs a wide enough move, and the
        # spread eats the edge
        vs = sorted(x[1]['vol_ratio'] for x in cands)
        med = median(vs)
        cands.sort(key=lambda x: spread.get(x[0], 1e9))
        sel = [p for p, ft in cands
               if spread.get(p, 1e9) <= 12.0 and ft['vol_ratio'] >= med]
        return set(sel[:k]) if sel else set()
    if rule == 'TREND':
        cands.sort(key=lambda x: -abs(x[1]['drift24']))
        return {p for p, _ in cands[:k]}
    if rule == 'TREND_QUIET':
        cands.sort(key=lambda x: abs(x[1]['drift24']))
        return {p for p, _ in cands[:k]}
    if rule == 'FIRE_RATE':
        # the K symbols with the most exhaustion signals per hour over
        # the preceding day -- a LIQUIDITY-of-signal proxy
        raise NotImplementedError
    return set()


def run_rule(trades, features, spread, rule, pool_by_hour, day_lo=None, day_hi=None):
    """Apply a rule day by day and collect the trades it selects."""
    bypair = collections.defaultdict(list)
    for t in trades: bypair[t['pair']].append(t)
    days = sorted({d for (_, d) in features})
    selected = []
    for day in days:
        if day_lo is not None and day < day_lo: continue
        if day_hi is not None and day > day_hi: continue
        uni = build_universe(features, spread, day, rule)
        if not uni: continue
        for t in trades:
            if t['day'] == day and t['pair'] in uni:
                selected.append(t)
    return selected


def mulberry32(seed):
    """A seeded PRNG with the `random.Random` interface the placebos
    need (`sample`, `shuffle`, `randrange`)."""
    import random
    return random.Random(seed)


def placebo_p(subset_diffs, all_trades_by_pair, pool_by_hour, n_syms, draws=1500, seed=20241021):
    """The PLACEBO of the same shape: random K-symbol universes, measured
    identically, with the SAME number of trades per day."""
    rnd = mulberry32(seed)
    pairs = list(all_trades_by_pair.keys())
    if len(pairs) < n_syms or n_syms <= 0: return None
    obs = mean(subset_diffs) if subset_diffs else 0.0
    ge = 0
    for _ in range(draws):
        sel = set(rnd.sample(pairs, n_syms))
        sub = [t for p in sel for t in all_trades_by_pair[p]]
        d = cluster_excess(sub, pool_by_hour)
        if d and mean(d) >= obs: ge += 1
    return (ge + 1) / (draws + 1)
