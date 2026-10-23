#!/usr/bin/env python3
"""
THE 14-DAY UNIVERSE STUDY — per-symbol profile, the exhaustion fire rate,
the LONG side's scarcity, and the shipped ticket's net expectancy in DOLLARS.

WHAT IT MEASURES
----------------
1. THE PER-SYMBOL PROFILE
     ATR%          the tape's own ATR (mean true range over 15 x 1h bars)
     spread bps    the venue's spread, from the collector + a live ticker
     trend 15m/1h  the drift of the symbol over the window
     realised vol  the annualised stdev of 1h log returns
     fire rate     how often the tape's exhaustion condition fires
     LONG share    how much of that is the LONG side

2. THE TICKET
   The SHIPPED geometry, verified against the 9 FIRED trades in
   trade-loop.ndjson:
     TP  = clamp(0.4 x ATR%, 0.3, 0.5)      -> target, from avgEntry
     SL  = 3d/(200+d), d = clamp(0.9 x ATR%, 0.6, 1.5)
     hold = 16 x 15m = 240 minutes
   First touch wins. A bar touching BOTH levels is a LOSS.
   A trade reaching neither level is a TIME EXIT at the mark.
   Fee: 0.12% taker round trip on the notional ($60).

3. THE DOLLARS
     net per trade = (gross % of notional - 0.12%) x $60
     NOT the % of equity. The binding constraint is $60 of notional on
     $57.16 of equity, so the dollars are what the account feels.

THE STATISTICS
--------------
   Rows are NOT observations. The statistics are on CLUSTER MEANS, one
   cluster per 5-minute bucket, and the excess is over a GENUINE CONTROL:
   the same symbol, the same timestamp, the OPPOSITE side.
"""
import json, os, math, collections, statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uni_tape import fade_metrics, tape_side, tape_side_and_why

SCRATCH = os.path.dirname(os.path.abspath(__file__))

# ── THE BINDING CONSTRAINTS ─────────────────────────────────────────────
EQUITY = 57.16
NOTIONAL = 60.0
TAKER_RT = 0.0012          # 0.06% per side, both legs taker
DAILY_NOTIONAL_CAP = 500.0 # the venue's cap (the 14 live refusals prove it)
MAX_HOLD_BARS = 16         # 16 x 15m = 240 minutes

# ── THE SHIPPED GEOMETRY ────────────────────────────────────────────────
def shipped_ticket(atr_pct, side):
    """The ticket the live path builds, from src/kucoin.ts planScalp and
    src/commands/live-cmd.ts. Verified against the 9 FIRED trades."""
    if not (atr_pct and atr_pct > 0): return None
    tp_pct = min(0.5, max(0.3, atr_pct * 0.4))
    d = min(max(0.9 * atr_pct, 0.6), 1.5)
    step_drop_pct = min(1.5, max(0.6, atr_pct * 0.9))
    # 2 rungs (planScalp's maxSteps=2), multipliers [1,1] -> the entry is
    # the size-weighted mean of two prices separated by step_drop_pct.
    prices = [1.0, 1.0 - step_drop_pct / 100.0] if side == 'long' else [1.0, 1.0 + step_drop_pct / 100.0]
    avg_entry_rel = sum(prices) / len(prices)
    tp_rel = avg_entry_rel * (1 + (tp_pct / 100.0) * (1 if side == 'long' else -1))
    kill_rel = 1.0 * (1 - step_drop_pct * 2 / 100.0 * (1 if side == 'long' else -1))
    # The target and stop, as FRACTIONS of the average entry.
    tp_frac = (tp_rel - avg_entry_rel) / avg_entry_rel * (1 if side == 'long' else -1)
    sl_frac = (avg_entry_rel - kill_rel) / avg_entry_rel * (1 if side == 'long' else -1)
    return dict(tp_pct=tp_pct, d=d, step_drop_pct=step_drop_pct,
                tp_frac=abs(tp_frac), sl_frac=abs(sl_frac),
                r_multiple=abs(tp_frac) / abs(sl_frac) if sl_frac else None)


def resolve(bars15, ts, entry, tp_frac, sl_frac, long, max_hold=MAX_HOLD_BARS):
    """The ticket's outcome: first-touch TP/kill, both = LOSS, else a time
    exit at the mark. VERBATIM in behaviour from rep-venue-common.mjs's
    outcome()."""
    tp = entry * (1 + tp_frac) if long else entry * (1 - tp_frac)
    sl = entry * (1 - sl_frac) if long else entry * (1 + sl_frac)
    start = -1
    for i in range(len(bars15)):
        if bars15[i]['t'] > ts:
            start = i
            break
    if start < 0: return None
    end = min(len(bars15), start + max_hold)
    if end - start < 1: return None
    for i in range(start, end):
        b = bars15[i]
        hit_tp = b['h'] >= tp if long else b['l'] <= tp
        hit_sl = b['l'] <= sl if long else b['h'] >= sl
        if hit_tp and hit_sl: return ('loss', -sl_frac, i - start + 1)
        if hit_tp: return ('win', tp_frac, i - start + 1)
        if hit_sl: return ('loss', -sl_frac, i - start + 1)
    last = bars15[end - 1]
    move = (last['c'] - entry) / entry if long else (entry - last['c']) / entry
    return ('time', move, end - start)


# ── helpers ─────────────────────────────────────────────────────────────
def mean(a): return sum(a) / len(a) if a else 0.0
def sd(a):
    if len(a) < 2: return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))
def se(a):
    if len(a) < 2: return 0.0
    return sd(a) / math.sqrt(len(a))
def median(a):
    if not a: return float('nan')
    s = sorted(a); m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2
def pct(a, p):
    if not a: return float('nan')
    s = sorted(a)
    return s[min(len(s) - 1, int(p * len(s)))]
def bucket_of(ts): return ts // (5 * 60_000)


def cluster_means(values, buckets):
    by = collections.defaultdict(list)
    for v, b in zip(values, buckets):
        by[b].append(v)
    return [mean(v) for v in by.values()], by


def welch_t(a, b):
    """The t of the difference of two UNPAIRED means."""
    if len(a) < 2 or len(b) < 2: return (None, None)
    d = mean(a) - mean(b)
    s = math.sqrt(se(a) ** 2 + se(b) ** 2)
    return (d / s if s > 0 else None), d


def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (t & 0x1D872B41) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t & 0x9FB21C651) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return nxt


def placebo_excess_t(values, buckets, sizes, draws=2000, seed=12345):
    """The PLACEBO of the same shape: random groups of the same sizes,
    measured the same way. Returns the p-value of the observed excess."""
    rnd = mulberry32(seed)
    cms, by = cluster_means(values, buckets)
    pool = [mean(v) for v in by.values() if v]
    if not pool: return None, None
    obs_groups = []
    for b in sizes:
        obs_groups.append([v for k, v in by.items() if k == b])
    obs_parts = [mean(g) for g in obs_groups if g]
    if not obs_parts: return None, None
    obs_excess = mean(obs_parts)
    ge = 0
    for _ in range(draws):
        sh = pool[:]
        for i in range(len(sh) - 1, 0, -1):
            j = int(rnd() * (i + 1))
            sh[i], sh[j] = sh[j], sh[i]
        idx = 0; parts = []
        for s in sizes:
            g = sh[idx:idx + s]; idx += s
            if g: parts.append(mean(g))
        if not parts: continue
        if mean(parts) >= obs_excess: ge += 1
    return (ge + 1) / (draws + 1), obs_excess
