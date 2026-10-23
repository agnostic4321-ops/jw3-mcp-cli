#!/usr/bin/env python3
"""
THE GEOMETRY SWITCH — the shared core for testing three NON-SCALPING
ticket geometries.

WHAT IS FIXED AND WHAT VARIES
-----------------------------
FIXED: the SIGNAL. It is the machine's own tape (fadeMetrics over the
last 24 x 1-hour bars -> a side), reconstructed on the collector's
5-minute cadence, exactly as `uni_tape.py` ports it from
`packages/jw3-cli/src/kucoin.ts`. The question is NOT "is there a
signal" — the project has already measured that. The question is
"does the SAME signal pay under a DIFFERENT ticket geometry".

VARIES: the ticket. Three geometries are tested:

  1. WIDE TARGET / LONG HOLD   a 1-3% target held 4-24 hours
  2. MAKER ONLY                a 0.04% round trip, a resting entry
  3. PAIR / RELATIVE           the spread between two symbols

THE FILL RULE (the correct one, from docs/research/the-scratch-artefact.md)
---------------------------------------------------------------------------
  * the take-profit is BEYOND the market in the profitable direction
  * first touch of TP or the kill WINS that touch
  * a bar that touches BOTH is a LOSS (conservative)
  * a trade that reaches NEITHER is a TIME EXIT at the mark
  * the fee is charged on the NOTIONAL

THE CLUSTERING
--------------
The t-statistic is computed on cluster means at the TICKET'S OWN holding
period, because two signals inside one window share the path that
decides the outcome. The collector's 5-minute round is NOT the cluster
width for a long-hold ticket.

THE CONTROL
-----------
The control is the SAME symbol, the SAME timestamp, the OPPOSITE side.
That cancels the market's drift exactly, so the excess measures what
the signal's DIRECTION buys and nothing else.

THE DOLLARS
-----------
$60 of notional. The fee rides on the notional. The account has $56.89
of equity. Net expectancy is reported in DOLLARS because that is what
the account feels.
"""
import json, os, sys, math, bisect, collections
import numpy as np

# The BARS live in the shared scratch dir, not in the repo: they are
# ~10MB of 15-minute and 1-hour bars for 43 symbols over 45 days, and
# the fetchers regenerate them. `node fetch-kucoin.mjs --days 45`
# writes them there.
SCRATCH = os.path.join(os.path.expanduser("~"), ".hermes/cache/scratch")
GEO2 = os.path.join(SCRATCH, "geo2")

# ── THE BINDING CONSTRAINTS ──────────────────────────────────────────
EQUITY = 56.89          # the account's equity
NOTIONAL = 60.0         # per ticket
TAKER_RT = 0.0012       # 0.06% per side, both legs taker
MAKER_RT = 0.0004       # 0.02% per side, both legs maker
RHO = NOTIONAL / EQUITY
HOUR_MS = 3600_000
GRID_MS = 300_000       # the collector's 5-minute cadence
DAY_MS = 86400_000

# ── THE BAR ─────────────────────────────────────────────────────────
T_BAR = 2.0
MIN_CLUSTERS = 30
TRIM_N = 3
# A symbol must cover this many days to stay in a study. The floor
# exists so that ONE short-history symbol cannot decide the window for
# all the others — without it, the window is the intersection, and one
# 5-day symbol inside a 45-day set cuts the study to 3 days.
MIN_COVERAGE_DAYS = 30.0


def mean(a):
    a = list(a)
    return sum(a) / len(a) if a else 0.0


def sd(a):
    a = list(a)
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def se(a):
    a = list(a)
    return sd(a) / math.sqrt(len(a)) if len(a) > 1 else 0.0


def median(a):
    a = sorted(a)
    if not a:
        return float('nan')
    m = len(a) >> 1
    return a[m] if len(a) % 2 else (a[m - 1] + a[m]) / 2


def pct(a, p):
    a = sorted(a)
    if not a:
        return float('nan')
    return a[min(len(a) - 1, int(p * len(a)))]


def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) + 0x6D2B79F5 + 0x6D2B79F5
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (1 | t)
        t = (t + ((t ^ (t >> 7)) * (61 | t))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return nxt


# ── THE TAPE (verbatim port of packages/jw3-cli/src/kucoin.ts) ───────
def fade_metrics(closes, vols, highs, lows):
    """VERBATIM port of fadeMetrics."""
    if len(closes) < 24 or len(vols) < 24:
        return None
    recent = vols[-12:]
    prior = vols[-24:-12]
    pmean = sum(prior) / 12.0
    if not (pmean > 0):
        return None
    window = closes[-24:]
    hi = max(window)
    lo = min(window)
    last = closes[-1]
    if not (hi > 0 and lo > 0 and math.isfinite(last)):
        return None
    first = closes[-24]
    atrPct = None
    if len(highs) >= 15 and len(lows) >= 15 and len(closes) >= 15:
        h = highs[-15:]; l = lows[-15:]; c = closes[-15:]
        trs = []
        for i in range(1, 15):
            prev = c[i - 1]
            trs.append(max(h[i] - l[i], abs(h[i] - prev), abs(l[i] - prev)))
        atr = sum(trs) / len(trs)
        if atr > 0 and last > 0:
            atrPct = (atr / last) * 100.0
    rmean = sum(recent) / 12.0
    return dict(
        chg=((last - first) / first * 100.0) if first != 0 else 0.0,
        vratio=rmean / pmean,
        offHighPct=((hi - last) / hi * 100.0),
        offLowPct=((last - lo) / lo * 100.0),
        atrPct=atrPct,
        last=last,
    )


def tape_side(m):
    """VERBATIM port of tapeSideOf: the FADE is checked FIRST."""
    # fade_signal
    if m['offHighPct'] > 15:
        fade = 'late'
    elif m['vratio'] < 0.85 and m['offHighPct'] < 8:
        fade = 'fade-short'
    elif m['vratio'] > 3:
        fade = 'strong'
    else:
        fade = 'neutral'
    # dip_signal
    if m['offLowPct'] > 15:
        dip = 'extended'
    elif m['vratio'] > 3:
        dip = 'capitulation'
    elif m['vratio'] < 0.85 and m['offLowPct'] < 8:
        dip = 'dip-long'
    else:
        dip = 'neutral'
    if fade == 'fade-short':
        return 'short'
    if dip == 'dip-long':
        return 'long'
    return None


# ── BAR LOADING ─────────────────────────────────────────────────────
class Bars:
    """Bars for one symbol, as numpy arrays."""

    __slots__ = ("t", "h", "l", "c", "v", "n")

    def __init__(self, rows):
        self.n = len(rows)
        self.t = np.array([r['t'] for r in rows], dtype=np.int64)
        self.h = np.array([r['h'] for r in rows], dtype=np.float64)
        self.l = np.array([r['l'] for r in rows], dtype=np.float64)
        self.c = np.array([r['c'] for r in rows], dtype=np.float64)
        self.v = np.array([r.get('v', 0.0) for r in rows], dtype=np.float64)


def load_bars(path):
    raw = json.load(open(path))
    out = {}
    for p, rows in raw.items():
        rows = sorted(rows, key=lambda x: x['t'])
        if len(rows) >= 30:
            out[p] = Bars(rows)
    return out


def load_venue(which="kc"):
    """The 1-hour bars WITH volume (for the tape) and the 15-minute bars
    (for the ticket's resolution)."""
    if which == "kc":
        p1 = os.path.join(GEO2, "geo-kc-1h.json")
        p15 = os.path.join(GEO2, "geo-kc-15m.json")
    else:
        p1 = os.path.join(GEO2, "geo-binance-1h.json")
        p15 = os.path.join(GEO2, "geo-binance-15m.json")
    b1 = load_bars(p1) if os.path.exists(p1) else {}
    b15 = load_bars(p15) if os.path.exists(p15) else {}
    return b1, b15


def coverage_cut(bars1h, res_bars, symbols, min_days=30.0):
    """Keep the symbols that can cover the window; report the ones dropped.

    THE DEFECT THIS FIXES. The study's window used to be the
    INTERSECTION of every symbol's history. Inside a 45-day set, one
    symbol with 5 days of history collapses that intersection to 3
    days — throwing away 92% of the sample, and at a 24h hold making
    30 clusters structurally impossible, so every long-hold row failed
    its own bar for a reason that had nothing to do with the geometry.

    The union of what the bars cover is what the data supports; the
    intersection is what one bad symbol decides. So the symbols that
    cannot cover the window are DROPPED, and what survived is STATED —
    because a reader cannot otherwise tell a narrow window from a wide
    one.

    Returns (kept, dropped, union_lo, union_hi).
    """
    union_lo = max(int(bars1h[p].t[0]) for p in symbols)
    union_hi = min(int(res_bars[p].t[-1]) for p in symbols)
    kept, dropped = [], []
    for p in symbols:
        s0, e0 = int(bars1h[p].t[0]), int(res_bars[p].t[-1])
        cover = min(e0, union_hi) - max(s0, union_lo)
        if (e0 - s0) >= min_days * DAY_MS and cover > 0:
            kept.append(p)
        else:
            dropped.append((p, (e0 - s0) / DAY_MS))
    return kept, dropped, union_lo, union_hi


def resolution_bars(bars15, bars1h, prefer="15m"):
    """The bars the ticket's resolution walks.

    For a 4-24 hour hold the 15-minute granularity is not needed to
    resolve a 1-3% target, and the 1-hour bars carry the same volume
    series, so either works. 15m is preferred where it exists; the
    script states which it used.
    """
    if prefer == "15m" and bars15:
        return bars15, 15
    return bars1h, 60


# ── THE TAPE STATES ─────────────────────────────────────────────────
def tape_states(bars1h, honest=True):
    """The tape state at each hour boundary, per symbol.

    The tape is a function of the last 24 x 1h bars, so it changes only
    when an hour bar closes.

    THE LOOK-AHEAD, AND HOW IT IS HANDLED
    --------------------------------------
    A bar stamped at t covers [t, t+1h) and its CLOSE is only known at
    t+1h. So a state computed from bars up to and including the bar
    stamped at t is only AVAILABLE at t+1h.

    `honest=True` stamps the state at t+1h, the moment the state first
    becomes knowable. A grid point then takes the last state whose
    stamp is <= the grid point, so no state ever uses information that
    did not exist yet.

    `honest=False` stamps the state at t (the OPEN time), which is the
    convention the repo's own 14-day reconstruction uses. It lets a
    state read the final close of a bar that had not finished, so it
    carries up to one hour of look-ahead. It is measured here only to
    show what the look-ahead is worth: if the conclusion is the same
    with and without it, the conclusion does not depend on it.
    """
    out = {}
    for pair, bb in bars1h.items():
        n = bb.n
        if n < 24:
            continue
        states = []
        cl, vo, hi_, lo_ = bb.c, bb.v, bb.h, bb.l
        for i in range(23, n):
            m = fade_metrics(cl[i - 23:i + 1], vo[i - 23:i + 1],
                             hi_[i - 23:i + 1], lo_[i - 23:i + 1])
            if not m:
                continue
            side = tape_side(m)
            stamp = int(bb.t[i]) + (HOUR_MS if honest else 0)
            states.append((stamp, side, m['atrPct']))
        out[pair] = states
    return out


# ── SIGNAL GENERATION ───────────────────────────────────────────────
def build_signals(states, bars, lo, hi, bar_minutes=15, grid_ms=GRID_MS):
    """Every tape signal on the grid, with the entry price taken from the
    last resolution bar whose CLOSE was already known at the signal time.

    A bar is stamped with its OPEN time, so the bar whose t <= ts is the
    one CONTAINING ts and its close is up to `bar_minutes` in the future.
    Using it as the entry would be look-ahead. So the entry is the close
    of the bar stamped at ts - bar_minutes, which closed exactly at ts.
    """
    sig = []
    grid = np.arange(lo, hi + 1, grid_ms)
    for pair, st in states.items():
        bb = bars.get(pair)
        if bb is None:
            continue
        t15 = bb.t
        # the index of the bar stamped at (ts - bar_minutes)
        idx = np.searchsorted(t15, grid - bar_minutes * 60_000, side='right') - 1
        # the tape state at each grid point: the last state with t <= ts
        sidx = np.searchsorted(np.array([s[0] for s in st]), grid, side='right') - 1
        ok = (idx >= 0) & (sidx >= 0)
        for j in range(len(grid)):
            if not ok[j]:
                continue
            s = st[sidx[j]]
            if s[1] is None:
                continue
            entry = bb.c[idx[j]]
            if not (entry > 0):
                continue
            sig.append((pair, int(grid[j]), s[1], float(entry), s[2], int(sidx[j])))
    return sig


# ── THE TICKET RESOLUTION ───────────────────────────────────────────
def resolve_many(bb, sig_idx, entry, long, tp_frac, sl_frac, hold_bars):
    """Resolve many signals against one symbol's bars, VECTORISED.

    sig_idx : the index of the FIRST bar strictly after the signal
    entry   : the fill price for each signal
    long    : a boolean array, one per signal
    tp_frac : the take-profit distance as a FRACTION of the entry
    sl_frac : the stop distance as a FRACTION of the entry

    Returns (outcome_codes, gross_frac, mae_frac, bars_used).
      outcome 0 = win (TP touched first), 1 = loss (stop touched first,
      or both touched), 2 = time exit at the mark.
    """
    n = len(sig_idx)
    if n == 0:
        return (np.zeros(0, dtype=np.int8), np.zeros(0), np.zeros(0), np.zeros(0, dtype=np.int32))
    steps = np.arange(hold_bars)
    idx = sig_idx[:, None] + steps[None, :]
    valid = idx < bb.n
    idx_c = np.clip(idx, 0, bb.n - 1)
    H = bb.h[idx_c]
    L = bb.l[idx_c]
    valid &= steps[None, :] < (bb.n - sig_idx[:, None])
    is_long = np.asarray(long, dtype=bool)
    target = entry * (1.0 + tp_frac) if True else entry
    target = np.where(is_long, entry * (1.0 + tp_frac), entry * (1.0 - tp_frac))
    stop = np.where(is_long, entry * (1.0 - sl_frac), entry * (1.0 + sl_frac))
    hit_tp = valid & np.where(is_long[:, None], H >= target[:, None], L <= target[:, None])
    hit_sl = valid & np.where(is_long[:, None], L <= stop[:, None], H >= stop[:, None])

    any_tp = hit_tp.any(axis=1)
    any_sl = hit_sl.any(axis=1)
    first_tp = np.where(any_tp, hit_tp.argmax(axis=1), -1)
    first_sl = np.where(any_sl, hit_sl.argmax(axis=1), -1)

    out = np.full(n, 2, dtype=np.int8)
    # the stop is touched first (or in the same bar as the target) -> LOSS
    sl_first = any_sl & (~any_tp | (first_sl <= first_tp))
    out[sl_first] = 1
    tp_only = any_tp & (~any_sl | (first_tp < first_sl))
    out[tp_only] = 0

    # the BARS CONSUMED: the bar at which the position resolved, plus one.
    # A time exit consumes the whole horizon.
    res_bar = np.full(n, hold_bars, dtype=np.int64)
    res_bar[sl_first] = first_sl[sl_first] + 1
    res_bar[tp_only] = first_tp[tp_only] + 1
    res_bar = np.minimum(res_bar, valid.sum(axis=1))

    gross = np.zeros(n)
    win = out == 0
    loss = out == 1
    gross[win] = tp_frac
    gross[loss] = -sl_frac
    # the time exit: the mark at the last covered bar
    last_idx = np.clip(sig_idx + hold_bars - 1, 0, bb.n - 1)
    mark = bb.c[last_idx]
    tm = out == 2
    gross[tm] = np.where(is_long[tm], (mark[tm] - entry[tm]) / entry[tm],
                          (entry[tm] - mark[tm]) / entry[tm])

    # the MAXIMUM ADVERSE EXCURSION over the window, as a positive
    # fraction (how far against the position it went)
    adv_long = np.maximum(0.0, (entry[:, None] - L) / entry[:, None]).max(axis=1)
    adv_short = np.maximum(0.0, (H - entry[:, None]) / entry[:, None]).max(axis=1)
    mae = np.where(is_long, adv_long, adv_short)
    mae = np.where(valid.any(axis=1), mae, 0.0)
    used = res_bar
    return out, gross, mae, used


# ── THE STATISTICS ──────────────────────────────────────────────────
def apply_single_position(ts, bars_used, bar_ms, order=None):
    """The account holds ONE position per symbol at a time.

    The collector polls every 5 minutes and the machine would trade each
    poll, so for a 4-24 hour hold the naive simulation stacks 48-288
    overlapping positions on the same symbol and counts the same price
    path many times. The account cannot do that: the notional is
    reserved by an open position.

    So the signals are walked in time order and a signal is TAKEN only
    if no earlier position on that symbol is still open. The blocking
    window is the position's ACTUAL holding period (the bar at which it
    resolved), not the full horizon.

    `ts` are millisecond timestamps; `bars_used` is the number of
    resolution bars the position consumed; `bar_ms` is the resolution
    bar's length in milliseconds.

    Returns a boolean mask: True for the signals that were taken.
    """
    n = len(ts)
    if n == 0:
        return np.zeros(0, dtype=bool)
    idx = np.arange(n) if order is None else np.asarray(order)
    taken = np.zeros(n, dtype=bool)
    free_at = -np.inf
    for i in idx:
        t = ts[i]
        if t >= free_at:
            taken[i] = True
            free_at = t + bars_used[i] * bar_ms
    return taken


def cluster_stats(trades, cluster_ms, value_key='v'):
    """The cluster means at the ticket's holding period.

    `value_key` names the field whose cluster means are taken. It must be
    explicit: a trade dict carries several numbers (the signal's net, the
    control's net, their difference) and silently defaulting to one of
    them is how a result gets mislabelled.
    """
    by = collections.defaultdict(list)
    for t in trades:
        by[t['bucket']].append(t[value_key])
    means = [mean(v) for v in by.values()]
    if not means:
        return dict(clusters=0, ev=0.0, se=0.0, t=0.0, trimmed=None,
                    worst3=None, best3=None, means=means)
    m = mean(means)
    s = se(means)
    t = m / s if s > 0 else 0.0
    trimmed = None
    worst3 = best3 = None
    if len(means) >= TRIM_N * 2 + 1:
        ss = sorted(means)
        trimmed = mean(ss[TRIM_N:-TRIM_N])
        worst3 = mean(ss[:TRIM_N])
        best3 = mean(ss[-TRIM_N:])
    return dict(clusters=len(means), ev=m, se=s, t=t, trimmed=trimmed,
                worst3=worst3, best3=best3, means=means)


def fmt(x, d=4):
    return f"{x:.{d}f}" if isinstance(x, (int, float)) and math.isfinite(x) else "n/a"


def utc(ms):
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc).strftime('%Y-%m-%d %H:%M')
