#!/usr/bin/env python3
"""
THE SHARED HARNESS — the bar's tests, applied to every geometry.

THE BAR (from the task)
------------------------
1. net EV above the FEE FLOOR
2. t >= 2 on CLUSTER MEANS at the ticket's OWN holding period
3. trim-stable (the worst 3 and the best 3 cluster means dropped)
4. a SIZE-MATCHED PLACEBO beside it
5. a per-symbol or per-pair CONCENTRATION named

THE PLACEBO
------------
A size-matched placebo of the SAME SHAPE, measured identically. For the
single-symbol geometries it is: the same number of trades, drawn from
the same symbols at the same times, but with the signal's side RANDOMISED
— i.e. the ticket with the signal removed. That is the honest null for
"the signal's direction is what pays": if a random side pays the same,
the ticket is paying the market's drift, not the signal.

For the pair geometry the placebo is the same construction on the spread.

THE CLUSTERING
--------------
One cluster per the ticket's holding period. Two signals inside one
window share the path that decides the outcome, so the finest
genuinely independent cluster at a 24-hour hold is the DAY.
"""
import math, collections, random
from core import mean, se, sd, T_BAR, MIN_CLUSTERS, TRIM_N


def trimmed(means, n=TRIM_N):
    if len(means) < 2 * n + 1:
        return None
    s = sorted(means)
    return mean(s[n:-n])


def worst3_best3(means, n=TRIM_N):
    if len(means) < 2 * n + 1:
        return None, None
    s = sorted(means)
    return mean(s[:n]), mean(s[-n:])


def cluster_t(values, buckets):
    """The t on cluster means, at the given bucket width."""
    by = collections.defaultdict(list)
    for v, b in zip(values, buckets):
        by[b].append(v)
    means = [mean(v) for v in by.values()]
    if len(means) < 2:
        return dict(clusters=len(means), ev=mean(means) if means else 0.0, se=0.0, t=0.0, means=means)
    m = mean(means)
    s = se(means)
    return dict(clusters=len(means), ev=m, se=s, t=(m / s if s > 0 else 0.0), means=means)


def placebo_random_side(trades, hold_ms, draws=200, seed=20261021):
    """The SIZE-MATCHED PLACEBO: the same trades with the side RANDOMISED.

    `trades` is a list of dicts with 'bucket', 'pair', 'ts', 'side',
    'net' (the net $ of the trade as it was) and 'net_flip' (the net $
    of the SAME ticket with the opposite side). The placebo's
    distribution is the clustered EV of the side-flipped trades, drawn
    `draws` times with a random flip per trade.

    The observed statistic is where the real arm sits in that
    distribution. A p-value near 1.0 means the signal's side is WORSE
    than a coin flip; a p-value near 0.0 means it is better than chance.
    """
    if not trades:
        return None
    rng = random.Random(seed)
    obs = cluster_t([t['net'] for t in trades], [t['bucket'] for t in trades])
    ge = 0
    vals = []
    buckets = [t['bucket'] for t in trades]
    for _ in range(draws):
        pick = []
        for t in trades:
            if rng.random() < 0.5:
                pick.append(t['net'])
            else:
                pick.append(t['net_flip'])
        c = cluster_t(pick, buckets)
        vals.append(c['ev'])
        if c['ev'] >= obs['ev']:
            ge += 1
    return dict(p=(ge + 1) / (draws + 1), obs=obs['ev'],
                placebo_mean=mean(vals), placebo_sd=sd(vals),
                placebo_p95=sorted(vals)[int(0.95 * len(vals))])


def concentration(trades, key='pair'):
    """The per-symbol (or per-pair) concentration: the share of the total
    excess carried by the single best symbol."""
    by = collections.defaultdict(list)
    for t in trades:
        by[t[key]].append(t['ex'])
    if not by:
        return None
    ev = {k: mean(v) for k, v in by.items()}
    tot = sum(sum(v) for v in by.values())
    best = max(ev, key=ev.get)
    worst = min(ev, key=ev.get)
    n_best = len(by[best])
    share = (sum(by[best]) / tot) if tot != 0 else None
    # the per-symbol mean's own t: is the best symbol's own edge
    # significant on its own?
    return dict(n_symbols=len(by), best=best, best_ev=ev[best], worst=worst,
                worst_ev=ev[worst], best_share=share, best_n=n_best,
                ev=ev)


def verdict(ev_usd, floor_usd, t, clusters, trimmed_mean, p_placebo=None,
            concentration_info=None):
    """The bar, applied. Returns (passes: bool, reasons: list)."""
    reasons = []
    if ev_usd <= floor_usd:
        reasons.append(f"EV ${ev_usd:+.4f} is not above the fee floor ${floor_usd:.4f}")
    if t < T_BAR:
        reasons.append(f"t {t:.2f} < {T_BAR}")
    if clusters < MIN_CLUSTERS:
        reasons.append(f"{clusters} clusters < {MIN_CLUSTERS}")
    if trimmed_mean is not None and trimmed_mean <= floor_usd:
        reasons.append(f"trimmed EV ${trimmed_mean:+.4f} is not above the floor")
    if p_placebo is not None and p_placebo >= 0.5:
        reasons.append(f"the placebo p is {p_placebo:.3f} — indistinguishable from a coin flip")
    return (len(reasons) == 0, reasons)
