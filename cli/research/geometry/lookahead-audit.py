#!/usr/bin/env python3
"""
THE LOOK-AHEAD AUDIT — does the conclusion depend on knowing the future?

THE CONCERN
------------
The tape is a function of the last 24 x 1-HOUR bars. A bar stamped at t
covers [t, t+1h) and its CLOSE is only known at t+1h. So a state
computed from the bar stamped at t is only AVAILABLE at t+1h.

The repo's own 14-day reconstruction (`uni_tape.py`, `uni-study.py`)
stamps the state at the bar's OPEN time, which lets a grid point read
the final close of an hour bar that had not finished. That is up to one
hour of look-ahead.

This script measures the SAME geometry under BOTH conventions:
  HONEST   the state is stamped at t+1h, when it first becomes knowable
  LOOKAHEAD the state is stamped at t (the repo's convention)

and reports the difference. If the conclusion is the same under both,
the conclusion does not rest on the look-ahead.

It also reports the DIRECTION of the market over the window, because a
signal that is SHORT in a market that went UP is not a "no edge" — it
is a signal whose direction was wrong for the whole window, and the
reader needs to know which.
"""
import os, sys, json, math, collections
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (EQUITY, NOTIONAL, TAKER_RT, RHO, HOUR_MS, GRID_MS, DAY_MS,
                  mean, se, load_venue, tape_states, build_signals,
                  resolve_many, apply_single_position, cluster_stats, utc, coverage_cut, MIN_COVERAGE_DAYS)
from harness import verdict

GEO2 = os.path.dirname(os.path.abspath(__file__))
VENUE = os.environ.get("VENUE", "bin")
RES = os.environ.get("RES", "15m")
BAR_MIN = 15 if RES == "15m" else 60
BARS_PER_HOUR = 60 // BAR_MIN

# the headline geometries, from the grid
CASES = [(1.0, 0.5, 4), (1.5, 0.75, 4), (2.0, 1.0, 4), (3.0, 1.5, 4),
         (1.0, 0.5, 12), (2.0, 1.0, 12), (3.0, 1.5, 12),
         (1.0, 0.5, 24), (2.0, 1.0, 24), (3.0, 1.5, 24)]


def run(bars1h, res_bars, common, honest, tp, stop, hold_h):
    states = tape_states({p: bars1h[p] for p in common}, honest=honest)
    lo = max(int(bars1h[p].t[0]) for p in common) + 24 * HOUR_MS
    hi = min(int(res_bars[p].t[-1]) for p in common) - 24 * BARS_PER_HOUR * BAR_MIN * 60_000
    sigs = build_signals(states, res_bars, lo, hi, bar_minutes=BAR_MIN)
    by_pair = collections.defaultdict(list)
    for s in sigs:
        by_pair[s[0]].append(s)
    trades = []
    for p, ss in by_pair.items():
        bb = res_bars[p]
        idx = np.searchsorted(bb.t, np.array([x[1] for x in ss]), side='right')
        ok = idx < bb.n
        ss2 = [x for x, o in zip(ss, ok) if o]
        idx = idx[ok]
        if not len(idx):
            continue
        entry = np.array([x[3] for x in ss2])
        long = np.array([x[2] == 'long' for x in ss2])
        ts = np.array([x[1] for x in ss2])
        out, gross, mae, used = resolve_many(bb, idx, entry, long, tp, stop, hold_h * BARS_PER_HOUR)
        taken = apply_single_position(ts, used, BAR_MIN * 60_000)
        for j in range(len(out)):
            if not taken[j]:
                continue
            trades.append(dict(bucket=int(ts[j]) // (hold_h * HOUR_MS), net=float((gross[j] - TAKER_RT) * NOTIONAL)))
    if not trades:
        return None
    cs = cluster_stats(trades, hold_h * HOUR_MS, value_key='net')
    return dict(n=len(trades), ev=cs['ev'], t=cs['t'], clus=cs['clusters'], trimmed=cs['trimmed'])


def main():
    print("=" * 118)
    print("THE LOOK-AHEAD AUDIT — the same geometry, with and without the tape's one-hour look-ahead")
    print("=" * 118)
    bars1h, bars15 = load_venue(VENUE)
    res_bars = bars15 if (RES == "15m" and bars15) else bars1h
    common = sorted(set(bars1h) & set(res_bars))
    # THE SAME COVERAGE CUT AS geo1 — one symbol with 5 days of history
    # inside a 45-day set must not decide the window for all the others.
    common, dropped, _ulo, _uhi = coverage_cut(bars1h, res_bars, common, MIN_COVERAGE_DAYS)
    if dropped:
        print(f"symbols kept: {len(common)}   dropped for short history: "
              + ", ".join(f"{p} ({d:.1f}d)" for p, d in sorted(dropped, key=lambda x: x[1])))
    print(f"venue: {VENUE}   resolution: {RES}   symbols: {len(common)}")

    # ── THE MARKET'S DIRECTION OVER THE WINDOW ───────────────────────
    print("\n" + "-" * 118)
    print("0. THE DIRECTION OF THE MARKET OVER THE WINDOW — the context every number below sits in")
    print("-" * 118)
    rets = []
    for p in common:
        bb = bars1h[p]
        if bb.n < 48:
            continue
        rets.append((bb.c[-1] / bb.c[0] - 1) * 100)
    rets = np.array(rets)
    print(f"  {len(rets)} symbols over the window: median return {np.median(rets):+.2f}%, "
          f"mean {rets.mean():+.2f}%, {np.sum(rets>0)} went UP and {np.sum(rets<=0)} went DOWN")
    print(f"  p10 {np.percentile(rets,10):+.2f}%   p90 {np.percentile(rets,90):+.2f}%")
    # the tape's own side balance
    states = tape_states({p: bars1h[p] for p in common}, honest=True)
    sides = collections.Counter(s[1] for st in states.values() for s in st)
    tot = sum(v for k, v in sides.items() if k)
    print(f"  the tape's own signals: {sides.get('short',0)} short, {sides.get('long',0)} long "
          f"({sides.get('short',0)/max(1,tot)*100:.1f}% short)")
    print("  So the signal is overwhelmingly SHORT. If the market went UP over the window,")
    print("  a short signal loses by construction — that is a DIRECTIONAL MISMATCH, and the")
    print("  EXCESS over the same-symbol/opposite-side control is what separates a mismatch")
    print("  from a real edge.")

    # ── THE AUDIT ────────────────────────────────────────────────────
    print("\n" + "-" * 118)
    print("1. THE SAME GEOMETRY UNDER BOTH CONVENTIONS")
    print("-" * 118)
    print(f"  {'hold':>4} {'TP':>6} {'SL':>6} | {'HONEST n':>9} {'EV$':>9} {'t':>7} | "
          f"{'LOOKAHEAD n':>11} {'EV$':>9} {'t':>7} | {'delta$':>9}")
    for tp, stop, hold_h in CASES:
        a = run(bars1h, res_bars, common, True, tp / 100, stop / 100, hold_h)
        b = run(bars1h, res_bars, common, False, tp / 100, stop / 100, hold_h)
        if not a or not b:
            continue
        print(f"  {hold_h:>4}h {tp:>5.1f}% {stop:>5.2f}% | {a['n']:>9} {a['ev']:>+9.4f} {a['t']:>7.2f} | "
              f"{b['n']:>11} {b['ev']:>+9.4f} {b['t']:>7.2f} | {a['ev']-b['ev']:>+9.4f}")

    print("\n  READ: if the HONEST column's verdicts match the LOOK-AHEAD column's, the")
    print("  conclusion does not rest on the look-ahead. The look-ahead's VALUE is the")
    print("  delta column: how much a result IMPROVES when the future is peeped at.")

    # ── THE DIRECTION-MISMATCH DECOMPOSITION ─────────────────────────
    print("\n" + "-" * 118)
    print("2. IS THE LOSS A DIRECTION MISMATCH, OR A BROKEN SIGNAL?")
    print("-" * 118)
    print("  The control is the SAME symbol, SAME timestamp, OPPOSITE side. So the market's")
    print("  drift cancels EXACTLY and the excess is purely 'what the signal's direction buys'.")
    print(f"\n  {'hold':>4} {'TP':>6} {'SL':>6} {'n':>7} {'signal$':>9} {'control$':>10} {'excess$':>9} {'t':>7}")
    for tp, stop, hold_h in CASES:
        states = tape_states({p: bars1h[p] for p in common}, honest=True)
        lo = max(int(bars1h[p].t[0]) for p in common) + 24 * HOUR_MS
        hi = min(int(res_bars[p].t[-1]) for p in common) - 24 * BARS_PER_HOUR * BAR_MIN * 60_000
        sigs = build_signals(states, res_bars, lo, hi, bar_minutes=BAR_MIN)
        by_pair = collections.defaultdict(list)
        for s in sigs:
            by_pair[s[0]].append(s)
        trades = []
        for p, ss in by_pair.items():
            bb = res_bars[p]
            idx = np.searchsorted(bb.t, np.array([x[1] for x in ss]), side='right')
            ok = idx < bb.n
            ss2 = [x for x, o in zip(ss, ok) if o]
            idx = idx[ok]
            if not len(idx):
                continue
            entry = np.array([x[3] for x in ss2])
            long = np.array([x[2] == 'long' for x in ss2])
            ts = np.array([x[1] for x in ss2])
            out, gross, mae, used = resolve_many(bb, idx, entry, long, tp / 100, stop / 100, hold_h * BARS_PER_HOUR)
            outf, grossf, _, _ = resolve_many(bb, idx, entry, ~long, tp / 100, stop / 100, hold_h * BARS_PER_HOUR)
            taken = apply_single_position(ts, used, BAR_MIN * 60_000)
            for j in range(len(out)):
                if not taken[j]:
                    continue
                trades.append(dict(bucket=int(ts[j]) // (hold_h * HOUR_MS),
                                    v=float((gross[j] - TAKER_RT) * NOTIONAL),
                                    c=float((grossf[j] - TAKER_RT) * NOTIONAL),
                                    ex=float((gross[j] - TAKER_RT) * NOTIONAL) - float((grossf[j] - TAKER_RT) * NOTIONAL)))
        if not trades:
            continue
        cs = cluster_stats(trades, hold_h * HOUR_MS, value_key='ex')
        csig = mean([t['v'] for t in trades]); cctl = mean([t['c'] for t in trades])
        print(f"  {hold_h:>4}h {tp:>5.1f}% {stop:>5.2f}% {len(trades):>7} {csig:>+9.4f} {cctl:>+10.4f} "
              f"{cs['ev']:>+9.4f} {cs['t']:>7.2f}")
    print("\n  READ: if the CONTROL (the opposite side, same symbol, same instant) is also")
    print("  negative, then the ticket itself loses and no direction would have helped.")
    print("  If the control is POSITIVE and the signal is negative, the signal's direction is")
    print("  the wrong way round for this window — a mismatch, not a broken ticket.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
