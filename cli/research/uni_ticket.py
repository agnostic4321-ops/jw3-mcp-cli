#!/usr/bin/env python3
"""
THE TICKET, POST-FIX — the ticket the machine runs AFTER commit a63880e8.

WHAT THE FIX CHANGED
--------------------
Before the fix, the shipped ticket's take-profit could land on the
WRONG SIDE of the market (above the last price, for a short), so its
trigger was already satisfied and the leg filled instantly at the ask.
The first two live trades closed 4-6 seconds after entry that way.

After the fix, the venue proxy DROPS a wrong-sided take-profit and arms
the STOP only:

    "The take-profit is dropped and the STOP is kept: the stop is on
     the ADVERSE side, so it can never be wrong. A position with a stop
     and no take-profit is PROTECTED."

So the POST-FIX ticket on a short is:

    entry  = the market price (the fill)
    stop   = killPrice, anchored to the market  -> ALWAYS armed
    target = avgEntry x (1 - tpPct/100)
             -> if that is ABOVE the market, the take-profit is DROPPED
                and the trade becomes a STOP-ONLY trade, resolved by the
                stop or by the 240-minute time exit.

THE TWO GEOMETRIES, AND WHY BOTH ARE MEASURED
----------------------------------------------
  A. THE TICKET AS BUILT (PRE-FIX, and what the research scripts
     simulate): the take-profit is placed where the plan says, so a
     short's target can be immediately satisfied and the trade closes at
     once for a fee. This is the geometry that produced the machine's
     "100% win rate" — and it is a measurement artefact, not an edge.

  B. THE TICKET AS IT RUNS NOW (POST-FIX): the take-profit is dropped
     when it is on the wrong side, so those trades become stop-only
     trades resolved by the kill or the time exit.

Both are simulated. A is reported because it explains the live numbers.
B is the one that decides whether any symbol selection rule can work,
because B is what the machine will actually do.
"""
import math
import bisect


def plan(atr_pct, side):
    """The plan the live path builds, from src/kucoin.ts planScalp.

    The plan is built from the MARKET price (`last`), and it produces
    three prices:
        avgEntry  the size-weighted mean of the rungs
        tpPrice   avgEntry x (1 -/+ tpPct/100)
        killPrice last x (1 -/+ steps x stepDropPct/100)

    For a SHORT, with steps=2 and stepDrop = clamp(0.9 x ATR, 0.6, 1.5):
        avgEntry = last x (1 + step/200)
        tpPrice  = last x (1 + step/200 - tpPct/100)
        killPrice= last x (1 + 2 x step/100)

    So the take-profit's position RELATIVE TO THE MARKET is
    `step/200 - tpPct`, which is POSITIVE for almost every ATR — the
    take-profit lands ABOVE the market, on the wrong side, and fills
    instantly. That is the defect commit a63880e8 fixed by DROPPING it.

    This returns the RELATIVE prices (over the market price `last`).
    """
    if not (atr_pct and atr_pct > 0):
        return None
    tp_pct = min(0.5, max(0.3, atr_pct * 0.4))
    step_drop_pct = min(1.5, max(0.6, atr_pct * 0.9))
    sign = 1 if side == 'short' else -1
    # 2 rungs, mults [1, 1] -> avgEntry = last x (1 + sign x step/200)
    avg_entry = 1.0 + sign * step_drop_pct / 200.0
    tp_rel = avg_entry * (1 - sign * tp_pct / 100.0)
    kill_rel = 1.0 * (1 + sign * (2 * step_drop_pct / 100.0))
    wrong_side = (tp_rel >= 1.0) if side == 'short' else (tp_rel <= 1.0)
    return dict(tp_pct=tp_pct, step_drop_pct=step_drop_pct,
                avg_entry_rel=avg_entry, tp_rel=tp_rel, kill_rel=kill_rel,
                wrong_side=wrong_side,
                tp_vs_market_pct=(tp_rel - 1.0) * 100.0,
                tp_move_frac=abs(tp_rel - 1.0),
                sl_move_frac=abs(kill_rel - 1.0),
                tp_frac=abs(tp_rel - avg_entry) / avg_entry,
                sl_frac=abs(kill_rel - avg_entry) / avg_entry)


def resolve(bars15, ts, market, tk, side, max_hold=16, drop_wrong_side=True):
    """The ticket's outcome against the forward 15-minute bars.

    market   the fill price (the last CLOSED 15m bar at ts)
    tk       the plan
    drop_wrong_side  True  -> POST-FIX (the venue proxy drops a
                           wrong-sided take-profit; the trade becomes
                           stop-only)
                  False -> PRE-FIX (the take-profit is placed where the
                           plan says, so an already-satisfied trigger
                           closes the position on the first forward bar)

    Returns (kind, move_fraction, bars_held, how)
    """
    long = side == 'long'
    tp_price = market * tk['tp_rel']
    kill_price = market * tk['kill_rel']
    tp_move = (tp_price - market) / market if long else (market - tp_price) / market
    sl_move = (kill_price - market) / market if long else (market - kill_price) / market

    start = bisect.bisect_right([b['t'] for b in bars15], ts)
    if start >= len(bars15):
        return None
    end = min(len(bars15), start + max_hold)
    if end - start < 1:
        return None

    tp_armed = True
    if drop_wrong_side and tk['wrong_side']:
        tp_armed = False

    for i in range(start, end):
        b = bars15[i]
        hit_tp = tp_armed and (b['h'] >= tp_price if long else b['l'] <= tp_price)
        hit_sl = b['l'] <= kill_price if long else b['h'] >= kill_price
        if hit_tp and hit_sl:
            return ('loss', sl_move, i - start + 1, 'both')
        if hit_tp:
            return ('win', tp_move, i - start + 1, 'tp')
        if hit_sl:
            return ('loss', sl_move, i - start + 1, 'sl')
    last = bars15[end - 1]
    move = (last['c'] - market) / market if long else (market - last['c']) / market
    return ('time', move, end - start, 'time')


def resolve_corrected(bars15, ts, market, tk, side, max_hold=16):
    """THE CORRECTED TICKET — the take-profit on the CORRECT side.

    The shipped plan puts the target on the wrong side of the market for
    92% of signals (see the module docstring). The natural repair keeps
    the SAME distances and puts the target where it was obviously
    intended: on the favourable side of the FILL.

        target = market x (1 -/+ tpPct/100)     <- the same tpPct, anchored
                                                   to the market instead
                                                   of to avgEntry
        stop   = market x (1 +/+ 2 x stepDrop/100)  <- unchanged

    This is the arm that answers the task's real question: can a symbol
    SELECTION RULE beat the rotating pool on a ticket that actually
    works? A selection rule measured on a broken ticket measures
    nothing.
    """
    long = side == 'long'
    # The take-profit is on the FAVOURABLE side of the market: BELOW for
    # a short, ABOVE for a long.
    tp_price = market * ((1 + tk['tp_pct'] / 100.0) if long else (1 - tk['tp_pct'] / 100.0))
    kill_price = market * tk['kill_rel']
    tp_move = (tp_price - market) / market if long else (market - tp_price) / market
    sl_move = (kill_price - market) / market if long else (market - kill_price) / market

    start = bisect.bisect_right([b['t'] for b in bars15], ts)
    if start >= len(bars15):
        return None
    end = min(len(bars15), start + max_hold)
    if end - start < 1:
        return None
    for i in range(start, end):
        b = bars15[i]
        hit_tp = b['h'] >= tp_price if long else b['l'] <= tp_price
        hit_sl = b['l'] <= kill_price if long else b['h'] >= kill_price
        if hit_tp and hit_sl:
            return ('loss', sl_move, i - start + 1, 'both')
        if hit_tp:
            return ('win', tp_move, i - start + 1, 'tp')
        if hit_sl:
            return ('loss', sl_move, i - start + 1, 'sl')
    last = bars15[end - 1]
    move = (last['c'] - market) / market if long else (market - last['c']) / market
    return ('time', move, end - start, 'time')
