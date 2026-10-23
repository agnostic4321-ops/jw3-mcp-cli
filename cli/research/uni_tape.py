#!/usr/bin/env python3
"""
THE TAPE — a verbatim port of the machine's own tape, on 1-HOUR bars.

THE MACHINE'S TAPE
------------------
`jw3 decide` reads DECIDE_KLINES=60 x DECIDE_GRANULARITY_MIN=60 (a
60-hour window) and hands it to `fadeMetrics`, which takes the LAST 24
bars -> a 24-HOUR window of 60-minute bars. `futuresFade` (used by the
live path and the loop) uses `granularity=60` too, which on KuCoin's
futures API is 60 MINUTES, and takes the last 24. So both paths read the
same state: 24 x 1h bars.

The outputs:
  vratio     = mean(vol of last 12 bars) / mean(vol of the 12 before)
  offHighPct = (max(high) - last) / max(high) * 100
  offLowPct  = (last - min(low)) / min(low) * 100
  atrPct     = mean(true range over the last 15 bars) / last * 100
  chg        = (last - close 24 bars ago) / that close * 100

And the side, in the ORDER the code checks them:
  fade first  -> 'fade-short' => SHORT
  then dip    -> 'dip-long'   => LONG
so a market that is near its high AND its low books SHORT. That
asymmetry is STRUCTURAL, and it is the reason the live arm is 100%
short.
"""
import math


def fade_metrics(closes, vols, highs, lows):
    """VERBATIM port of fadeMetrics in packages/jw3-cli/src/kucoin.ts."""
    if len(closes) < 24 or len(vols) < 24:
        return None
    recent = vols[-12:]
    prior = vols[-24:-12]
    rmean = sum(recent) / 12.0
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
    return dict(
        chg=((last - first) / first * 100.0) if first != 0 else 0.0,
        vratio=rmean / pmean,
        offHighPct=((hi - last) / hi) * 100.0,
        offLowPct=((last - lo) / lo) * 100.0,
        atrPct=atrPct,
        last=last,
    )


def fade_signal(r):
    """VERBATIM port of fadeSignal in src/kucoin.ts."""
    if r['offHighPct'] > 15: return 'late'
    if r['vratio'] < 0.85 and r['offHighPct'] < 8: return 'fade-short'
    if r['vratio'] > 3: return 'strong'
    return 'neutral'


def dip_signal(r):
    """VERBATIM port of dipSignal in src/kucoin.ts."""
    if r['offLowPct'] > 15: return 'extended'
    if r['vratio'] > 3: return 'capitulation'
    if r['vratio'] < 0.85 and r['offLowPct'] < 8: return 'dip-long'
    return 'neutral'


def tape_side(r):
    """VERBATIM port of tapeSideOf in research/tape-signal.mjs.

    The FADE is checked FIRST. A market near its high AND its low books
    SHORT; the long side can only fire when the market is near its low
    and NOT near its high.
    """
    if fade_signal(r) == 'fade-short': return 'short'
    if dip_signal(r) == 'dip-long': return 'long'
    return None


def tape_side_and_why(r):
    """The side AND the reason, so the long side's scarcity is visible."""
    f = fade_signal(r); d = dip_signal(r)
    side = None
    if f == 'fade-short': side = 'short'
    elif d == 'dip-long': side = 'long'
    fade_cond = r['vratio'] < 0.85 and r['offHighPct'] < 8
    dip_cond = r['vratio'] < 0.85 and r['offLowPct'] < 8
    return side, f, d, fade_cond, dip_cond


def tape_at(bars, ts):
    """The tape at wall-clock ts, over the last 24 x 1h bars.

    `bars` must be sorted by t and must carry 'v'. The bar whose
    timestamp is <= ts is the FORMING bar (the live path's query ends at
    `now`, and the feed's last bar is the one in progress).
    """
    win = []
    for i in range(len(bars) - 1, -1, -1):
        b = bars[i]
        if b['t'] > ts: continue
        win.append(b)
        if len(win) >= 24: break
    win.reverse()
    if len(win) < 24: return None
    return fade_metrics([b['c'] for b in win], [b['v'] for b in win],
                         [b['h'] for b in win], [b['l'] for b in win])
