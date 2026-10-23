#!/usr/bin/env python3
"""
GEOMETRY 2 — THE MAKER-ONLY TICKET.

THE QUESTION
------------
The maker round trip is 0.04% of the notional ($0.0240 on $60) against
the taker's 0.12% ($0.0720). The saving is $0.0480 per trade. If the
ticket's target is wide enough, the fee becomes a small fraction of the
gross and the ticket can pay.

BUT the project has ALREADY REFUSED the maker path once, and the refusal
is structural, not a preference:

  `scalp start` places a LADDER of RESTING LIMIT orders, and the exit
  legs are venue-native conditionals that attach to a POSITION. A
  resting limit has no position until it fills, so between placement and
  fill there is nothing for a stop to attach to. Observed live: a
  PEPE/USDT buy limit at 0.00000456 RESTED (filled: 0), so no position
  existed and the TP and stop could not attach. It was a $14.23
  leveraged order with NO STOP. The path now REFUSES.

  (packages/jw3-cli/src/commands/scalp.ts:229-255)

So the maker-only ticket is only alive if the machine can place a
RESTING LIMIT and STILL ARM PROTECTION. That is a venue capability
question, and the geometry must be stated against it.

WHAT IS MEASURED
----------------
1. THE NET EXPECTANCY at each target distance under the maker round trip,
   with the maker entry SIMULATED HONESTLY: a resting limit at the
   signal's price, filled only if a later bar's range TOUCHES it, with
   the fill price AT the limit, and the adverse selection measured as
   the move AGAINST the position in the fill's own bar.
2. THE FILL RATE THE ACCOUNT WOULD NEED: the fill rate at which the
   maker arm's expectancy (with its adverse selection) beats the taker
   arm's expectancy.
3. THE PROTECTION CONSTRAINT, stated plainly: what a resting entry can
   and cannot have attached to it, and what the project already refused.

THE FILL RULE
-------------
Same as everywhere: the take-profit is beyond the market, first touch
wins, both-touched is a LOSS, neither is a TIME EXIT at its mark.
"""
import os, sys, json, math, collections
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (EQUITY, NOTIONAL, TAKER_RT, MAKER_RT, RHO, HOUR_MS, GRID_MS,
                  DAY_MS, T_BAR, MIN_CLUSTERS, TRIM_N,
                  mean, sd, se, median, pct, mulberry32,
                  load_venue, tape_states, build_signals, resolve_many,
                  cluster_stats, fmt, utc, coverage_cut, MIN_COVERAGE_DAYS)

GEO2 = os.path.dirname(os.path.abspath(__file__))
VENUE = os.environ.get("VENUE", "kc")
BAR15 = 900_000
BARS_PER_HOUR = 4

TP_FRACS = [0.005, 0.0075, 0.010, 0.015, 0.020, 0.030]
STOP_FRACS = [0.005, 0.010, 0.015, 0.020, 0.030]
HOLD_HOURS = [4, 24]
# the patience window for the resting limit, in bars
PATIENCE_BARS = [4, 8, 16, 32, 64]


def maker_arm(bb, sig_idx, entry, long, tp, stop, hold_bars, patience):
    """The maker arm: a resting limit at the signal's price, with a
    chase when the patience expires.

    A resting limit fills only if a later bar's range TOUCHES the limit
    price:
      a LONG rests BELOW the market and fills on a FALL (bar.l <= limit)
      a SHORT rests ABOVE the market and fills on a RISE (bar.h >= limit)

    The fill price is the limit price. The adverse selection is the move
    AGAINST the position from the fill to the close of the fill's own
    bar — the price the market moved against the fill while it sat.

    If the patience expires unfilled, the CHASE enters at the market on
    the bar where the patience expired (at that bar's CLOSE, because a
    market order does not get the extreme of the bar it enters) and pays
    the TAKER fee.
    """
    n = len(sig_idx)
    filled = np.zeros(n, dtype=bool)
    fill_idx = np.full(n, -1, dtype=np.int64)
    entry_price = entry.copy()
    fee = np.full(n, TAKER_RT)
    adverse = np.zeros(n)

    pat = np.minimum(sig_idx + patience, bb.n - 1)
    # walk the patience window
    for k in range(patience):
        j = sig_idx + k
        ok = j < bb.n
        if not ok.any():
            break
        jj = np.clip(j, 0, bb.n - 1)
        touched = np.where(long, bb.l[jj] <= entry, bb.h[jj] >= entry)
        newly = touched & ok & (~filled)
        if newly.any():
            fill_idx[newly] = j[newly]
            filled[newly] = True
            entry_price[newly] = entry[newly]
            fee[newly] = MAKER_RT
            # the adverse selection: the move against the position from
            # the limit to the close of the fill's own bar
            cl = bb.c[jj]
            adv = np.where(long, (entry - cl) / entry, (cl - entry) / entry)
            adverse[newly] = np.maximum(0.0, adv[newly])
    # the chase: the unfilled take the market at the close of the bar
    # where the patience expired
    chase_idx = np.clip(sig_idx + patience, 0, bb.n - 1)
    entry_price[~filled] = bb.c[chase_idx[~filled]]
    return filled, fill_idx, entry_price, fee, adverse


def main():
    print("=" * 118)
    print("GEOMETRY 2 — THE MAKER-ONLY TICKET (0.04% round trip)")
    print("=" * 118)
    print(f"venue: {VENUE}   notional $ {NOTIONAL:.2f}   equity $ {EQUITY:.2f}")
    print(f"taker round trip {TAKER_RT*100:.2f}% = ${TAKER_RT*NOTIONAL:.4f}   "
          f"maker round trip {MAKER_RT*100:.2f}% = ${MAKER_RT*NOTIONAL:.4f}   "
          f"saving ${(TAKER_RT-MAKER_RT)*NOTIONAL:.4f}")

    bars1h, bars15 = load_venue(VENUE)
    common = sorted(set(bars1h) & set(bars15))
    print(f"symbols in both: {len(common)}")
    if not common:
        print("NO DATA")
        return 1
    states = tape_states({p: bars1h[p] for p in common})
    # THE SAME COVERAGE CUT AS geo1 — one symbol with 5 days of history
    # inside a 45-day set must not decide the window for all the others.
    kept, dropped, _ulo, _uhi = coverage_cut(bars1h, bars15, common, MIN_COVERAGE_DAYS)
    if dropped:
        print(f"symbols kept: {len(kept)} of {len(common)}   dropped for short history: "
              + ", ".join(f"{p} ({d:.1f}d)" for p, d in sorted(dropped, key=lambda x: x[1])))
    common = kept
    if len(common) < 10:
        print("TOO FEW SYMBOLS AFTER THE COVERAGE CUT")
        return 1
    lo = max(int(bars1h[p].t[0]) for p in common) + 24 * HOUR_MS
    hi = min(int(bars15[p].t[-1]) for p in common) - 24 * BARS_PER_HOUR * BAR15
    sigs = build_signals(states, bars15, lo, hi)
    print(f"signals: {len(sigs)}")

    by_pair = collections.defaultdict(list)
    for s in sigs:
        by_pair[s[0]].append(s)

    # ── 1. THE PROTECTION CONSTRAINT, STATED ─────────────────────────
    print("\n" + "-" * 118)
    print("1. THE PROTECTION CONSTRAINT — why a maker-only ticket is not a free choice")
    print("-" * 118)
    print("""
  The exit legs on this venue are VENUE-NATIVE CONDITIONALS that attach to a
  POSITION. A resting limit order has no position until it fills.

    * between placement and fill: NO position -> NO stop -> NO take-profit.
      The order is a leveraged naked order waiting to become a leveraged
      naked position. This was OBSERVED LIVE on 2026-10-21: a PEPE/USDT
      buy limit at 0.00000456 RESTED (filled: 0), so the TP and stop
      could not attach. It was a $14.23 leveraged order with NO STOP.
    * `jw3 scalp start` now REFUSES to place exactly this, and points at
      `jw3 live --pair ... --direction ... --yes`, which enters at the
      MARKET so the position exists immediately and the stop attaches at
      once.  (packages/jw3-cli/src/commands/scalp.ts:229-255)

  So the maker-only ticket is only ALIVE if the machine can place a
  resting limit and STILL arm protection. Two ways that could work:
    (a) the venue attaches the conditional to the ORDER rather than to
        the position (KuCoin's stop-order / split-order families) —
        the account's own path does NOT do this today;
    (b) the machine places the resting limit, and a supervisor arms the
        protective legs WITHIN THE SAME TICK as the fill — which requires
        a fill callback and a window in which the position is unprotected.

  Everything below is measured under the ASSUMPTION that (a) or (b) is
  available. If neither is, the maker-only geometry is not reachable at
  all, and its numbers are moot. That is stated before the numbers, not
  after.
""")

    # ── 2. THE MAKER ARM vs THE TAKER ARM ───────────────────────────
    print("-" * 118)
    print("2. THE MAKER ARM vs THE TAKER ARM, AT EVERY TARGET DISTANCE")
    print("-" * 118)

    prepared = {}
    for p, ss in by_pair.items():
        bb = bars15[p]
        idx = np.searchsorted(bb.t, np.array([x[1] for x in ss]), side='right')
        ok = idx < bb.n
        ss2 = [x for x, o in zip(ss, ok) if o]
        idx = idx[ok]
        prepared[p] = (bb, idx,
                       np.array([x[3] for x in ss2]),
                       np.array([x[2] == 'long' for x in ss2]),
                       np.array([x[1] for x in ss2]),
                       np.array([x[0] for x in ss2]))

    rows = []
    for hold_h in HOLD_HOURS:
        hold_bars = hold_h * BARS_PER_HOUR
        for tp in TP_FRACS:
            for stop in STOP_FRACS:
                if stop > tp:
                    continue
                # the TAKER arm (the control the maker arm must beat)
                taker_trades = []
                for p, (bb, idx, entry, long, ts, pairs) in prepared.items():
                    out, gross, mae, used = resolve_many(bb, idx, entry, long, tp, stop, hold_bars)
                    net = (gross - TAKER_RT) * NOTIONAL
                    for j in range(len(out)):
                        taker_trades.append(dict(bucket=int(ts[j]) // (hold_h * HOUR_MS),
                                                 ts=int(ts[j]), pair=p, net=float(net[j])))
                taker_ev = mean([t['net'] for t in taker_trades])

                for patience in PATIENCE_BARS:
                    trades = []
                    fill_rate_all = []
                    adv_all = []
                    for p, (bb, idx, entry, long, ts, pairs) in prepared.items():
                        filled, fill_idx, ep, fee, adverse = maker_arm(
                            bb, idx, entry, long, tp, stop, hold_bars, patience)
                        # the legs are rebased onto the FILL (the machine's
                        # own rebase fix), so the geometry is preserved and
                        # only the entry and the fee change
                        start = np.where(filled, fill_idx, np.clip(idx + patience, 0, bb.n - 1))
                        out, gross, mae, used = resolve_many(bb, start, ep, long, tp, stop, hold_bars)
                        net = (gross - fee) * NOTIONAL
                        for j in range(len(out)):
                            trades.append(dict(bucket=int(ts[j]) // (hold_h * HOUR_MS),
                                               ts=int(ts[j]), pair=p, net=float(net[j]),
                                               filled=bool(filled[j])))
                        fill_rate_all.extend(filled.tolist())
                        adv_all.extend(adverse.tolist())
                    if len(trades) < 100:
                        continue
                    fr = mean(fill_rate_all)
                    adv = mean(adv_all)
                    maker_ev = mean([t['net'] for t in trades])
                    cs = cluster_stats(trades, hold_h * HOUR_MS, value_key='net')
                    filled_tr = [t for t in trades if t['filled']]
                    chased_tr = [t for t in trades if not t['filled']]
                    rows.append(dict(
                        hold=hold_h, tp=tp, stop=stop, patience=patience,
                        n=len(trades), fill_rate=fr,
                        adv_usd=adv * NOTIONAL,
                        taker_ev=taker_ev, maker_ev=maker_ev,
                        delta=maker_ev - taker_ev,
                        clus=cs['clusters'], t=cs['t'], trimmed=cs['trimmed'],
                        filled_ev=mean([t['net'] for t in filled_tr]) if filled_tr else None,
                        chased_ev=mean([t['net'] for t in chased_tr]) if chased_tr else None,
                        n_filled=len(filled_tr), n_chased=len(chased_tr),
                    ))

    # print the table, sorted by the maker arm's excess over the taker arm
    print(f"  {'hold':>4} {'TP':>6} {'SL':>6} {'pat':>4} {'fill%':>7} {'adv$':>7} "
          f"{'taker$':>8} {'maker$':>8} {'delta$':>8} {'clus':>5} {'t':>7} {'trim$':>8}")
    for r in sorted(rows, key=lambda r: -r['delta'])[:30]:
        print(f"  {r['hold']:>4}h {r['tp']*100:>5.1f}% {r['stop']*100:>5.2f}% {r['patience']:>4} "
              f"{r['fill_rate']*100:>6.1f}% {r['adv_usd']:>7.4f} {r['taker_ev']:>+8.4f} "
              f"{r['maker_ev']:>+8.4f} {r['delta']:>+8.4f} {r['clus']:>5} {r['t']:>7.2f} "
              f"{(r['trimmed'] if r['trimmed'] is not None else float('nan')):>+8.4f}")

    # ── 3. THE FILL RATE THE ACCOUNT WOULD NEED ─────────────────────
    print("\n" + "-" * 118)
    print("3. THE FILL RATE THE ACCOUNT WOULD NEED")
    print("-" * 118)
    # The maker arm's expectancy, as a function of the fill rate f:
    #   EV(f) = f * EV_filled + (1-f) * EV_chased
    # The maker arm BEATS the taker arm when:
    #   f > (EV_taker - EV_chased) / (EV_filled - EV_chased)
    print(f"  {'hold':>4} {'TP':>6} {'SL':>6} {'pat':>4} {'EV_fill$':>9} {'EV_chase$':>10} "
          f"{'EV_taker$':>10} {'f* needed':>11} {'f actual':>9}")
    need_rows = []
    for r in sorted(rows, key=lambda r: -(r['tp'])):
        if r['filled_ev'] is None or r['chased_ev'] is None:
            continue
        denom = r['filled_ev'] - r['chased_ev']
        if denom <= 0:
            continue
        f_star = (r['taker_ev'] - r['chased_ev']) / denom
        need_rows.append((r, f_star))
        if len(need_rows) <= 18:
            print(f"  {r['hold']:>4}h {r['tp']*100:>5.1f}% {r['stop']*100:>5.2f}% {r['patience']:>4} "
                  f"{r['filled_ev']:>+9.4f} {r['chased_ev']:>+10.4f} {r['taker_ev']:>+10.4f} "
                  f"{f_star*100:>10.1f}% {r['fill_rate']*100:>8.1f}%")
    if need_rows:
        best = min(need_rows, key=lambda x: x[1])
        print(f"\n  the EASIEST row to satisfy: hold {best[0]['hold']}h TP {best[0]['tp']*100:.1f}% "
              f"SL {best[0]['stop']*100:.2f}% patience {best[0]['patience']} bars — "
              f"the account would need a {best[1]*100:.1f}% fill rate, and the simulation measured "
              f"{best[0]['fill_rate']*100:.1f}%")
        achievable = [x for x in need_rows if x[0]['fill_rate'] >= x[1]]
        print(f"  rows where the MEASURED fill rate clears the REQUIRED fill rate: {len(achievable)}")
        for r, fs in achievable[:8]:
            print(f"    hold {r['hold']}h TP {r['tp']*100:.1f}% SL {r['stop']*100:.2f}% pat {r['patience']}: "
                  f"need {fs*100:.1f}%, measured {r['fill_rate']*100:.1f}%, "
                  f"maker EV ${r['maker_ev']:+.4f} vs taker ${r['taker_ev']:+.4f}")

    # ── 4. THE BAR ───────────────────────────────────────────────────
    print("\n" + "-" * 118)
    print("4. THE BAR")
    print("-" * 118)
    fee_floor = TAKER_RT * NOTIONAL
    maker_floor = MAKER_RT * NOTIONAL
    print(f"  the maker floor: ${maker_floor:.4f} per ticket (the maker round trip).")
    print(f"  the taker floor: ${fee_floor:.4f} per ticket.")
    passing = [r for r in rows if r['maker_ev'] > maker_floor and r['t'] >= T_BAR and r['clus'] >= MIN_CLUSTERS]
    print(f"  maker geometries with EV above the maker floor AND t >= {T_BAR} AND >= {MIN_CLUSTERS} clusters: {len(passing)}")
    for r in sorted(passing, key=lambda r: -r['maker_ev'])[:8]:
        print(f"    hold {r['hold']}h TP {r['tp']*100:.1f}% SL {r['stop']*100:.2f}% pat {r['patience']}: "
              f"maker EV ${r['maker_ev']:+.4f} (floor ${maker_floor:.4f}) t {r['t']:.2f} clusters {r['clus']} "
              f"fill {r['fill_rate']*100:.1f}% trimmed ${r['trimmed']:+.4f}")
    json.dump(rows, open(os.path.join(GEO2, f"geo2-rows-{VENUE}.json"), "w"))
    print(f"\n  wrote geo2-rows-{VENUE}.json")
    return 0


if __name__ == '__main__':
    sys.exit(main())
