#!/usr/bin/env python3
"""
THE POLICY ENGINE — one fill rule, three ticket geometries, and the
statistics the policy question needs.

WHY THIS FILE EXISTS
--------------------
The task is not "is there an edge" — that is measured and settled. The
task is "what is the OPTIMAL POLICY given a measured, non-positive
edge". That needs four things the existing scripts do not provide in
one place:

  1. ONE fill rule, applied identically to every arm:
       - first touch of the take-profit or the stop wins
       - a bar touching BOTH is a LOSS (conservative)
       - a trade reaching neither level is a TIME EXIT at its mark
       - a take-profit ALREADY SATISFIED at the market is a SCRATCH:
         the exit order is marketable, it fills at the touch, the gross
         is ~zero and the trade books the fee
  2. THREE ticket geometries, so the measurement can be compared with
     the published numbers AND with the ticket the code actually runs:
       - SHIPPED  the pre-fix geometry (target from the ladder's offset
                 average entry) — the one that produced the 90-95% win
                 rates
       - FIXED    the research scripts' repair (target beyond the
                 market, stop at the same distance from the entry)
       - LIVE     the geometry `planScalp` builds TODAY (entry = the
                 market, target beyond the market, stop 2 x stepDrop
                 from the market) — this is what the machine places
  3. THE CLUSTER CORRECTION AT THE TICKET'S HOLDING PERIOD. The
     ticket holds 16 x 15m = 240 minutes, so two signals inside the
     same 4-hour window share the path that decides the outcome. The
     honest cluster width is 4 hours. The collector's 5-minute round
     is reported too, and labelled as what it is.
  4. THE KELLY MACHINERY, done on the MEASURED return distribution
     rather than on a guessed win rate.

READ-ONLY. Local files only. Never touches the account or the venue.
"""
import json
import math
import os
import bisect
import collections
from os.path import join, expanduser

# ── THE BINDING CONSTRAINTS ───────────────────────────────────────────────
EQUITY = 56.89                 # the account, after -$0.5708 of realized loss
NOTIONAL = 60.0                # the venue's per-position cap
RHO = NOTIONAL / EQUITY        # 1.0547x exposure
TAKER_RT = 0.0012              # 0.06% per side, both legs taker (the venue's real rate)
FEE_USD = NOTIONAL * TAKER_RT  # $0.0720 per ticket
FEE_FLOOR_EQ = TAKER_RT * RHO * 100  # 0.1260 % of equity per trade
DAILY_NOTIONAL_CAP = 500.0     # the venue's cap -> at most 8 tickets
DAILY_LOSS_CAP = 12.0          # the account's loss budget (max_daily_loss_usd)
MAX_TICKETS = int(DAILY_NOTIONAL_CAP // NOTIONAL)

# ── THE TICKET GEOMETRY (src/kucoin.ts planScalp) ────────────────────────
ATR_MULT_STOP = 0.9
ATR_CLAMP_LO = 0.6
ATR_CLAMP_HI = 1.5
TP_ATR_MULT = 0.4
TP_CLAMP_LO = 0.3
TP_CLAMP_HI = 0.5
BARS_BEFORE = 16               # 16 x 15m = 240 minutes of holding
HOLD_MS = BARS_BEFORE * 900_000
BUCKET_MS = 300_000            # the collector's round
HOUR_MS = 3_600_000

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))


# ═══════════════════════════════════════════════════════════════════════
# SMALL STATISTICS
# ═══════════════════════════════════════════════════════════════════════
def mean(a):
    return sum(a) / len(a) if a else 0.0


def sd(a):
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def se(a):
    return sd(a) / math.sqrt(len(a)) if len(a) > 1 else 0.0


def median(a):
    if not a:
        return float('nan')
    s = sorted(a)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def t_crit(df, p=0.975):
    """The two-sided t critical value. Uses scipy when available."""
    try:
        from scipy import stats
        return float(stats.t.ppf(p, df))
    except Exception:
        # A small, accurate-enough table for the df this study uses.
        table = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
                 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
                 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110,
                 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074,
                 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052,
                 28: 2.048, 29: 2.045, 30: 2.042, 40: 2.021, 50: 2.009,
                 60: 2.000, 80: 1.990, 100: 1.984}
        keys = sorted(table)
        best = min(keys, key=lambda k: abs(k - df))
        if df > 100:
            return 1.960
        return table[best]


def cluster_means(trades, width_ms, value_key='pnl_eq'):
    """One mean per cluster. The cluster is the ticket's holding period."""
    by = collections.defaultdict(list)
    for t in trades:
        by[math.floor(t['ts'] / width_ms)].append(t[value_key])
    return [mean(v) for v in by.values()], by


def cluster_stats(trades, width_ms, value_key='pnl_eq'):
    """The cluster-corrected EV, its standard error, its t and its CI."""
    cms, by = cluster_means(trades, width_ms, value_key)
    n = len(cms)
    if n == 0:
        return dict(n_clusters=0, ev=0.0, se=0.0, t=0.0, lo=0.0, hi=0.0,
                    sd=0.0, cms=[])
    m = mean(cms)
    s = se(cms)
    tc = t_crit(n - 1) if n > 1 else float('nan')
    return dict(n_clusters=n, ev=m, se=s, t=(m / s if s > 0 else 0.0),
                sd=(sd(cms) if n > 1 else 0.0),
                lo=(m - tc * s if n > 1 else float('nan')),
                hi=(m + tc * s if n > 1 else float('nan')))


# ═══════════════════════════════════════════════════════════════════════
# THE TICKET, IN THREE GEOMETRIES
# ═══════════════════════════════════════════════════════════════════════
SHIPPED = 'SHIPPED'   # pre-fix: target from the ladder's offset average entry
FIXED = 'FIXED'       # the research scripts' repair
LIVE = 'LIVE'         # what planScalp builds TODAY


def plan(atr_pct, side, geom=SHIPPED):
    """The ticket, as RELATIVE prices (multiples of the market price).

    `sign` is +1 for a short and -1 for a long, so a take-profit is
    ALWAYS `1 - sign * tp/100` and a stop is ALWAYS `1 + sign * sl/100`.

    Three geometries, all from the live path's own constants:
      SHIPPED  avgEntry = 1 + sign x d/200
               target   = avgEntry x (1 - sign x tpPct/100)
               stop     = avgEntry x (1 + sign x 3d/(200+d))
      FIXED    entry    = 1 (the market)
               target   = 1 - sign x tpPct/100
               stop     = 1 + sign x stopFrac, where stopFrac is the
                         shipped stop's distance from the shipped entry
      LIVE     entry    = 1 (the market — the live path places a MARKET order)
               target   = 1 - sign x tpPct/100
               stop     = 1 + sign x 2 x stepDropPct/100
    """
    if not (atr_pct and atr_pct > 0):
        return None
    tp_pct = min(TP_CLAMP_HI, max(TP_CLAMP_LO, atr_pct * TP_ATR_MULT))
    d = min(ATR_CLAMP_HI, max(ATR_CLAMP_LO, atr_pct * ATR_MULT_STOP))
    sign = 1 if side == 'short' else -1

    avg_entry = 1.0 + sign * d / 200.0
    if geom == SHIPPED:
        tp_rel = avg_entry * (1 - sign * tp_pct / 100.0)
        stop_rel = avg_entry * (1 + sign * (3 * d) / (200 + d))
        entry_rel = avg_entry
    elif geom == FIXED:
        kill_rel = 1.0 + sign * (2 * d) / 100.0
        stop_frac = abs(kill_rel - avg_entry) / avg_entry
        tp_rel = 1.0 - sign * tp_pct / 100.0
        stop_rel = 1.0 + sign * stop_frac
        entry_rel = 1.0
    elif geom == LIVE:
        tp_rel = 1.0 - sign * tp_pct / 100.0
        stop_rel = 1.0 + sign * (2 * d) / 100.0
        entry_rel = 1.0
    else:
        raise ValueError(f'unknown geometry {geom}')

    # A take-profit on the WRONG side of the market is marketable: it
    # fills instantly at the touch. This is the scratch.
    wrong_side = (tp_rel >= 1.0) if side == 'short' else (tp_rel <= 1.0)
    return dict(
        geom=geom, side=side, sign=sign, atr=atr_pct, d=d, tp_pct=tp_pct,
        entry_rel=entry_rel, tp_rel=tp_rel, stop_rel=stop_rel,
        wrong_side=wrong_side,
        # the gross, as a fraction of the entry, for each outcome.
        # BOTH are POSITIVE numbers: a win pays win_gross, a loss costs
        # loss_gross.
        win_gross=abs(tp_rel - entry_rel) / entry_rel,
        loss_gross=abs(stop_rel - entry_rel) / entry_rel,
        stop_dist=abs(stop_rel - entry_rel) / entry_rel,
        tp_dist=abs(tp_rel - entry_rel) / entry_rel,
    )


def resolve(bars15, ts, market, tk):
    """THE CORRECT FILL RULE.

    `bars15` is the pair's bar bundle: {'_t': [timestamps], 'bars': [...]}.

    Returns (kind, gross_fraction, bars_held, how) where gross_fraction
    is a fraction of the ENTRY (so it is directly comparable across
    geometries), or None when the trade cannot be resolved.

      win      the take-profit was touched first
      loss     the stop was touched first (or both were touched: a LOSS)
      scratch  the take-profit was ALREADY satisfied at the market
      time     neither level was reached: a time exit at the mark
    """
    if not bars15:
        return None
    ts_list = bars15['_t']
    bars = bars15['bars']
    start = bisect.bisect_right(ts_list, ts)
    if start >= len(ts_list):
        return None
    end = min(len(ts_list), start + BARS_BEFORE)
    if end - start < 1:
        return None

    entry = market * tk['entry_rel']
    tp = market * tk['tp_rel']
    sl = market * tk['stop_rel']
    long = tk['side'] == 'long'

    for i in range(start, end):
        b = bars[i]
        hit_tp = (b['h'] >= tp) if long else (b['l'] <= tp)
        hit_sl = (b['l'] <= sl) if long else (b['h'] >= sl)
        if hit_tp and hit_sl:
            return ('loss', -tk['loss_gross'], i - start + 1, 'both')
        if hit_sl:
            return ('loss', -tk['loss_gross'], i - start + 1, 'sl')
        if hit_tp:
            if tk['wrong_side']:
                # THE SCRATCH: the exit fills at the touch, seconds later,
                # at essentially the market. The gross is ~zero.
                return ('scratch', 0.0, i - start + 1, 'scratch')
            return ('win', tk['win_gross'], i - start + 1, 'tp')

    last = bars[end - 1]
    move = ((last['c'] - entry) / entry) if long else ((entry - last['c']) / entry)
    return ('time', move, end - start, 'time')


# ═══════════════════════════════════════════════════════════════════════
# THE ARMS
# ═══════════════════════════════════════════════════════════════════════
def read_rows(path):
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass   # the collector writes this file while it is read
    return rows


def read_bars(path):
    raw = json.load(open(path))
    out = {}
    for pair, bars in raw.items():
        b = sorted(bars, key=lambda x: x['t'])
        out[pair] = {'_t': [x['t'] for x in b], 'bars': b}
    return out


def live_gate_side(r):
    """The live gate, exactly as `live-cmd.ts` implements it: both model
    legs present, on the SAME side, neither uncertain, AND the tape
    agreeing with them."""
    jev = r.get('jevSide')
    laya = r.get('layaSide')
    if not jev or jev == 'flat' or r.get('jevUncertain') is True:
        return None
    if not laya or laya == 'flat':
        return None
    if jev != laya:
        return None
    return jev


def build_arm(rows, geom=LIVE):
    """The machine's trade, and the tape-only control, resolved under the
    correct fill rule."""
    tape_rows = [r for r in rows if r.get('tapeSide')]
    live_rows = [r for r in tape_rows if live_gate_side(r) == r['tapeSide']]
    return simulate(live_rows, geom), simulate(tape_rows, geom), tape_rows, live_rows


def simulate(rows, geom=LIVE):
    """Resolve every row into a trade with its P&L in % of equity."""
    bars = BARS
    trades = []
    for r in rows:
        atr = r.get('tapeAtrPct')
        price = r.get('price')
        if not (atr and atr > 0) or not (price and price > 0):
            continue
        tk = plan(float(atr), r['tapeSide'], geom)
        if not tk:
            continue
        b = bars.get(r['pair'])
        if not b:
            continue
        out = resolve(b, r['ts'], float(price), tk)
        if out is None:
            continue
        kind, gross, held, how = out
        pnl_frac = gross - TAKER_RT
        trades.append(dict(
            pair=r['pair'], ts=r['ts'], side=r['tapeSide'], kind=kind, how=how,
            held=held, gross=gross,
            pnl_frac=pnl_frac,
            pnl_eq=pnl_frac * RHO * 100,      # % of equity
            pnl_usd=pnl_frac * NOTIONAL,      # dollars
            atr=tk['atr'], tp_pct=tk['tp_pct'], d=tk['d'],
            stop_dist=tk['stop_dist'], tp_dist=tk['tp_dist'],
            atr_pct=float(atr), price=float(price),
        ))
    return trades


# ═══════════════════════════════════════════════════════════════════════
# KELLY
# ═══════════════════════════════════════════════════════════════════════
def kelly_grid(returns, lo=0.0, hi=1.0, steps=20001):
    """The Kelly fraction for a DISCRETE per-trade return distribution.

    `returns` are per-trade returns on equity (a fraction, e.g. -0.0031
    for -0.31% of equity). We maximise E[log(1 + f*r)] over f, which is
    the correct objective for a compounding account: it is the growth
    rate the strategy actually produces.

    A NEGATIVE-edge distribution has g(f) strictly DECREASING for f > 0,
    so its supremum is at f -> 0+ and the correct bet size is ZERO. That
    case is detected explicitly and reported as `f_star = 0` with
    `negative_edge = True`, rather than as the spurious interior maximum
    a fine grid would land on.

    THE GRID SPANS f >= 0 ONLY, and that is the whole point.

    The first version searched [-1, 1], which includes NEGATIVE
    fractions — and a negative fraction is not a bet size, it is
    SHORTING the account. Two things broke:

    1. The negative-edge test was `best_f <= lo + 1e-6`, and with
       lo = -1 that is never true for a maximiser at the bottom of the
       feasible positive range. So a LOSING arm reported
       `negative_edge = False`.
    2. The maximiser for a negative-edge arm landed on the grid's
       smallest POSITIVE step — 0.002 at 1001 steps over [-1, 1] — and
       was reported as a POSITIVE Kelly fraction of 0.002, on every
       arm, with a bootstrap CI of [0.002, 0.002].

    So the answer for a losing strategy was "bet 0.2% of the account",
    and the confidence interval said the same thing with false
    precision. The correct answer is ZERO, and the grid now spans
    [0, 1] so the supremum at f -> 0+ is the grid's own lower bound.

    A POSITIVE-edge distribution has an interior maximum. If the grid's
    maximiser sits at the upper boundary (f = 1), the true optimum is
    above the boundary and is reported as `f_star = None` with
    `at_boundary = True` — because "bet the whole bankroll" is a
    statement about the grid, not about the strategy.
    """
    if returns is None:
        return dict(f_star=0.0, g=0.0, negative_edge=True, at_boundary=False,
                    g0=0.0, g1=0.0)
    try:
        import numpy as np
        r = np.asarray(returns, dtype=float)
        if r.size == 0:
            return dict(f_star=0.0, g=0.0, negative_edge=True, at_boundary=False,
                        g0=0.0, g1=0.0)
        fs = np.linspace(lo, hi, steps)
        best_f, best_g = 0.0, -np.inf
        # Chunked so the outer product never exceeds memory: the full
        # (steps x n) matrix would be 8 GB at n=50,000.
        CHUNK = 512
        for start in range(0, len(fs), CHUNK):
            sub = fs[start:start + CHUNK]
            with np.errstate(divide='ignore', invalid='ignore'):
                g = np.log1p(np.outer(sub, r)).mean(axis=1)
            feas = (1.0 + np.outer(sub, r).min(axis=1)) > 0
            g = np.where(np.isfinite(g) & feas, g, -np.inf)
            g[sub <= 0] = -np.inf
            i = int(np.argmax(g))
            if np.isfinite(g[i]) and g[i] > best_g:
                best_g, best_f = float(g[i]), float(sub[i])
        if not np.isfinite(best_g):
            return dict(f_star=0.0, g=0.0, negative_edge=True, at_boundary=False,
                        g0=0.0, g1=0.0)
        # g(0+) is the limit at f -> 0: g(f) -> 0 as f -> 0, so the
        # comparison is against the growth of NOT trading, which is 0.
        # g(1) is the growth at the upper boundary.
        # log1p(-1) is -inf, so a return of exactly -100% makes the mean
        # -inf. That is the CORRECT value for a total loss, but numpy
        # warns about it, and a warning in a research output trains the
        # reader to ignore warnings. The domain check is explicit: a
        # return at or below -1 means the account is wiped at that
        # fraction, so the growth rate is -inf by definition.
        with np.errstate(divide="ignore", invalid="ignore"):
            g1 = float(np.log1p(r).mean())
        at_boundary = best_f >= hi - 1e-9
        # A negative edge shows up as g(1) < 0 AND the maximiser sitting
        # at the bottom of the feasible range.
        # A NEGATIVE edge is not a matter of WHERE the maximiser sits —
        # it is a matter of the SIGN of the growth.
        #
        # The right test is: does the growth DECREASE from f = 0? If
        # g(1) < 0 and the mean return is negative, then every f > 0
        # loses money, so the supremum is the limit at f -> 0+, which is
        # g = 0 — the growth of NOT trading — and the correct bet size
        # is ZERO.
        #
        # The first version tested `best_f <= lo + 1e-6` with lo = -1,
        # which a maximiser at the grid's smallest positive step could
        # never satisfy, so a LOSING arm reported negative_edge = False
        # and a Kelly fraction of 0.002. Then the grid was narrowed to
        # [0, 1] and the same test had to become a comparison against
        # the grid's own smallest POSITIVE step, not against 0.
        #
        # The robust test: the growth at the best f must not be better
        # than the growth of not trading (which is 0), AND the growth
        # must be falling as f rises. `g1 < 0` says the growth at the
        # upper boundary is negative; combined with a negative mean
        # return, the distribution cannot pay at any f.
        mean_r = float(r.mean()) if hasattr(r, "mean") else 0.0
        negative = bool(g1 < 0 and mean_r < 0)
        return dict(f_star=(0.0 if negative else best_f), g=(0.0 if negative else best_g),
                    negative_edge=bool(negative or best_f < 1e-4),
                    at_boundary=bool(at_boundary),
                    g0=0.0, g1=g1, raw_f=best_f, raw_g=best_g)
    except ImportError:
        pass
    best_f, best_g = 0.0, None
    for i in range(steps):
        f = lo + (hi - lo) * i / (steps - 1)
        if f <= 0:
            continue
        g = 0.0
        ok = True
        for r in returns:
            x = 1.0 + f * r
            if x <= 0:
                ok = False
                break
            g += math.log(x)
        if not ok:
            continue
        g /= len(returns)
        if best_g is None or g > best_g:
            best_g, best_f = g, f
    return dict(f_star=(0.0 if (best_f or 0) < 1e-4 else best_f),
                g=(0.0 if (best_f or 0) < 1e-4 else best_g),
                negative_edge=bool((best_f or 0) < 1e-4), at_boundary=False,
                g0=0.0, g1=0.0, raw_f=best_f, raw_g=best_g)


def kelly_mv(returns):
    """The mean-variance Kelly fraction: f* = mu / sigma^2."""
    if not returns:
        return 0.0
    mu = mean(returns)
    v = sd(returns) ** 2
    return mu / v if v > 0 else 0.0


def kelly_discrete(p_win, net_win, net_loss):
    """The closed-form Kelly for a two-outcome bet.

    net_win and net_loss are POSITIVE numbers (the loss is a loss).
    f* = (p*b - (1-p)) / b, with b = net_win / net_loss.
    """
    if net_loss <= 0:
        return 0.0
    b = net_win / net_loss
    if b <= 0:
        return 0.0
    return (p_win * b - (1 - p_win)) / b


# The grid the point estimate and the bootstrap BOTH use.
#
# They must be the same grid. The first version used 20001 steps for
# the point estimate and 401 for the bootstrap, so the smallest positive
# fraction was 0.0001 in one and 0.005 in the other. When the maximiser
# sits at the bottom of the range (a negative edge, where the answer IS
# the bottom), the point estimate printed 0.0001 and the CI's lower
# bound printed 0.005 — so the CI did not BRACKET the estimate it was
# supposed to bound. A confidence interval that does not contain the
# point estimate is not a confidence interval.
#
# The resolution only has to be finer than the answer's precision: a
# Kelly fraction of 0.05 needs a step far below 0.05, and 1001 steps
# over [-1, 1] gives a step of 0.002. 20001 steps cost 20x the time
# in every bootstrap draw for no extra information.
KELLY_GRID_STEPS = 1001


def bootstrap_kelly(trades, width_ms, n_boot=2000, seed=20261021, steps=KELLY_GRID_STEPS):
    """A cluster bootstrap CI for the Kelly fraction.

    The bootstrap resamples CLUSTERS (not trades), because trades inside
    a cluster share their outcome path.

    THE UNIT HERE IS A FRACTION OF EQUITY, and it must match the unit
    the point estimate uses.

    The first version resampled `cluster_means(trades, width_ms)` with
    its DEFAULT value_key, which is `pnl_eq` — a PERCENT of equity.
    kelly_grid treats its input as a FRACTION, so every draw was
    log1p(-3.29) = NaN, and the CI it printed was the CI of an empty
    sample: "[+0.0050, +0.0050]" on every arm, which is the grid's
    floor, not a measurement.

    So the resampled value is the trade's `pnl_frac * RHO` — the same
    quantity the point estimate is built from — and the bootstrap's
    result is on the same scale as the f it bounds.
    """
    cms, by = cluster_means(trades, width_ms, value_key='pnl_frac')
    if len(cms) < 3:
        return None
    groups = list(by.values())
    try:
        import numpy as np
        rng = np.random.default_rng(seed)
        lens = np.array([len(g) for g in groups])
        # the index of each group's first element in the flat array
        starts = np.concatenate([[0], np.cumsum(lens)[:-1]])
        # The same quantity the point estimate uses: the trade's
        # fraction of notional, scaled to a fraction of equity.
        flat = np.array([v * RHO for g in groups for v in g])
        ks = []
        for _ in range(n_boot):
            pick = rng.integers(0, len(groups), len(groups))
            idx = (starts[pick][:, None]
                   + np.arange(lens[pick].max())[None, :])
            mask = np.arange(lens[pick].max())[None, :] < lens[pick][:, None]
            sample = flat[idx[mask]]
            kg = kelly_grid(sample, steps=steps)
            ks.append(kg['f_star'])
        ks = sorted(ks)
        return dict(lo=ks[int(0.025 * len(ks))], hi=ks[int(0.975 * len(ks))],
                    median=ks[len(ks) // 2], n_boot=n_boot, steps=steps,
                    frac_zero=(sum(1 for x in ks if x <= 0) / len(ks)))
    except ImportError:
        pass
    rng = random.Random(seed)
    ks = []
    for _ in range(n_boot):
        pick = [rng.choice(groups) for _ in range(len(groups))]
        flat = [v * RHO for g in pick for v in g]
        kg = kelly_grid(flat, steps=steps)
        ks.append(kg['f_star'])
    ks.sort()
    return dict(lo=ks[int(0.025 * len(ks))], hi=ks[int(0.975 * len(ks))],
                median=ks[len(ks) // 2], n_boot=n_boot, steps=steps,
                frac_zero=(sum(1 for x in ks if x <= 0) / len(ks)))


import random  # noqa: E402  (used by bootstrap_kelly)


# ═══════════════════════════════════════════════════════════════════════
# THE DAILY-LOSS ARITHMETIC
# ═══════════════════════════════════════════════════════════════════════
def daily_loss_draws(trades, n_tickets, n_draws=100000, seed=424242):
    """Monte-Carlo the DAILY LOSS COUNTER.

    The account's cap counts GROSS LOSSES, not net P&L: a profit does
    not offset a loss (supabase/functions/_shared/realized-pnl-reconcile.ts).
    So the counter after a day is the sum of max(0, -pnl) over the day's
    losing trades, and the cap fires when that reaches $12.
    """
    pnls = [t['pnl_usd'] for t in trades]
    if not pnls:
        return None
    try:
        import numpy as np
        rng = np.random.default_rng(seed)
        p = np.asarray(pnls, dtype=float)
        draws = rng.integers(0, len(p), size=(n_draws, n_tickets))
        day = p[draws]                       # (n_draws, n_tickets)
        counter = np.maximum(0.0, -day).sum(axis=1)
        net = day.sum(axis=1)
        totals = np.sort(net)
        losses = np.sort(counter)
        return dict(
            n_tickets=n_tickets,
            ev_usd=float(p.mean()),
            ev_day_usd=float(p.mean() * n_tickets),
            p_cap=float((counter >= DAILY_LOSS_CAP).mean()),
            p_net_cap=float((net <= -DAILY_LOSS_CAP).mean()),
            median_loss=float(losses[len(losses) // 2]),
            p95_loss=float(losses[int(0.95 * len(losses))]),
            p99_loss=float(losses[int(0.99 * len(losses))]),
            max_loss=float(losses[-1]),
            p05_pnl=float(totals[int(0.05 * len(totals))]),
            median_pnl=float(totals[len(totals) // 2]),
        )
    except ImportError:
        pass
    rng = random.Random(seed)
    hits = 0
    net_hits = 0
    totals = []
    losses = []
    for _ in range(n_draws):
        day = []
        for _ in range(n_tickets):
            day.append(pnls[rng.randrange(len(pnls))])
        counter = sum(-p for p in day if p < 0)
        net = sum(day)
        totals.append(net)
        losses.append(counter)
        if counter >= DAILY_LOSS_CAP:
            hits += 1
        if net <= -DAILY_LOSS_CAP:
            net_hits += 1
    totals.sort()
    losses.sort()
    return dict(
        n_tickets=n_tickets,
        ev_usd=mean([t['pnl_usd'] for t in trades]),
        ev_day_usd=mean([t['pnl_usd'] for t in trades]) * n_tickets,
        p_cap=hits / n_draws,
        p_net_cap=net_hits / n_draws,
        median_loss=losses[len(losses) // 2],
        p95_loss=losses[int(0.95 * len(losses))],
        p99_loss=losses[int(0.99 * len(losses))],
        max_loss=losses[-1],
        p05_pnl=totals[int(0.05 * len(totals))],
        median_pnl=totals[len(totals) // 2],
    )


BARS = {}
