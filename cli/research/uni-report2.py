#!/usr/bin/env python3
"""
THE SELECTION RULE, THE OUT-OF-SAMPLE CHECK, AND THE CAPACITY.

THE RULE IS OPERATIONAL
------------------------
A universe is decided ONCE PER DAY from the data available BEFORE that
day. So the rule needs NO look-ahead within the day, and it is refreshed
daily — which is what the capacity constraint implies anyway.

THE OUT-OF-SAMPLE TEST
-----------------------
The 14-day window is split IN HALF by TIME. The rule's parameters are
chosen on the FIRST half and measured on the SECOND. A rule that only
works in-sample is a selection artefact.

THE PLACEBO
------------
Random K-symbol universes, measured identically. If the rule's excess is
inside the placebo's distribution, the rule is indistinguishable from
luck.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import mean, se, median, pct, NOTIONAL, TAKER_RT, EQUITY, DAILY_NOTIONAL_CAP
from uni_rules import (HOUR_MS, DAY_MS, K, T_MIN_CLUSTERS, T_BAR, TRIM_N,
                       utc, daily_features, cluster_excess, stat_block)
from uni_sel import build_universe, run_rule, placebo_p, f, pf, usd

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
PROF = R['profile']
TRADES = R['trades']; TRADES_CORR = R['trades_corrected']
BARS1H = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))
SPREAD = {p: PROF[p]['spread_med'] for p in PROF}

RULES = ['NONE', 'VOL_PERCENTILE', 'VOL_FLOOR', 'SPREAD', 'SPREAD_VOL',
         'TREND', 'TREND_QUIET']


def line(c='='): print(c * 134)


def arm_stats(subset, pool_by_hour, label):
    """The statistic block for a selected subset against the pool."""
    diffs = cluster_excess(subset, pool_by_hour)
    b = stat_block(diffs)
    b['trades'] = len(subset)
    b['net_usd'] = mean([t['pnl_usd'] for t in subset]) if subset else None
    b['label'] = label
    return b


def main():
    FEAT = daily_features(BARS1H, 14)
    days = sorted({d for (_, d) in FEAT})
    # the pool's hour means, on the CORRECTED arm
    pool_by_hour = collections.defaultdict(list)
    for x in TRADES_CORR: pool_by_hour[x['hour']].append(x['pnl_usd'])
    bypair = collections.defaultdict(list)
    for x in TRADES_CORR: bypair[x['pair']].append(x)

    line()
    print('3. THE SELECTION RULE — the out-of-sample test')
    line()
    print(f"  the window splits into {len(days)} operating days: {utc(days[0]*DAY_MS)} .. {utc((days[-1]+1)*DAY_MS)}")
    half = len(days) // 2
    first = set(days[:half]); second = set(days[half:])
    print(f"  FIRST half (TRAIN): {len(first)} days, {utc(min(first)*DAY_MS)} -> {utc((max(first)+1)*DAY_MS)}")
    print(f"  SECOND half (TEST): {len(second)} days, {utc(min(second)*DAY_MS)} -> {utc((max(second)+1)*DAY_MS)}")
    print()
    print('  EVERY RULE is defined CAUSALLY: the universe for day D is computed from the')
    print('  bars that closed BEFORE day D. There is NO look-ahead inside the rule.')
    print()

    # ── the rules, in and out of sample ─────────────────────────────────
    print(f"  {'rule':<16} {'half':<6} {'trades':>7} {'hrs':>5} {'excess$/hr':>11} {'t':>7} {'trim$':>9} "
          f"{'t_trim':>7} {'worst3':>9} {'best3':>8} {'largest%':>9} {'placebo p':>10} {'verdict':>10}")
    print('  ' + '-' * 132)
    results = {}
    for rule in RULES:
        for half_name, dayset in [('TRAIN', first), ('TEST', second)]:
            sub = run_rule(TRADES_CORR, FEAT, SPREAD, rule, pool_by_hour,
                           day_lo=min(dayset), day_hi=max(dayset))
            b = arm_stats(sub, pool_by_hour, f'{rule}/{half_name}')
            # the placebo: the SAME number of symbols, at random
            pl = placebo_p(cluster_excess(sub, pool_by_hour), bypair, pool_by_hour,
                           n_syms=max(len(set(t['pair'] for t in sub)), 1))
            b['placebo_p'] = pl
            results[(rule, half_name)] = b
            # the verdict
            n_ok = b['n'] >= T_MIN_CLUSTERS
            t_ok = (b['t'] is not None and b['t'] >= T_BAR)
            ex_ok = (b['mean'] is not None and b['mean'] > 0)
            trim_ok = (b['t_trim'] is not None and b['t_trim'] >= T_BAR)
            place_ok = (pl is not None and pl <= 0.05)
            verdict = 'PASS' if (n_ok and t_ok and ex_ok and trim_ok and place_ok) else 'fail'
            why = []
            if not n_ok: why.append(f'n<{T_MIN_CLUSTERS}')
            if not ex_ok: why.append('excess<=0')
            if not t_ok: why.append('t<2')
            if not trim_ok: why.append('trim t<2')
            if not place_ok: why.append('placebo')
            print(f"  {rule:<16} {half_name:<6} {b['trades']:>7} {b['n']:>5} "
                  f"{usd(b['mean'],11)} {f(b['t'],2,7)} {usd(b['trimmed'],9)} {f(b['t_trim'],2,7)} "
                  f"{usd(b['worst3'],9)} {usd(b['best3'],8)} "
                  f"{pf(b['largest_share'],1,9)} {f(pl,4,10)} "
                  f"{(verdict if verdict=='PASS' else 'fail'):>10}  {','.join(why)}")

    print()
    print('  THE BAR: n >= 30 independent hour clusters, excess > 0, t >= 2, trim-stable')
    print('  (t >= 2 after dropping the worst 3 and best 3 hours), and the placebo p <= 0.05.')

    # ── the selection artefact: the in-sample oracle ───────────────────
    line()
    print('4. THE SELECTION ARTEFACT — how much an in-sample ranking can manufacture')
    line()
    # the ORACLE: rank the symbols by their own full-window excess, then
    # report on the SAME window. This is the number a naive "we picked
    # the best symbols" report would produce.
    sym_exc = {}
    for p in bypair:
        sub = bypair[p]
        d = cluster_excess(sub, pool_by_hour)
        sym_exc[p] = mean(d) if d else 0.0
    ranked = sorted(sym_exc, key=lambda p: -sym_exc[p])
    oracle_top = set(ranked[:K])
    oracle_sub = [t for t in TRADES_CORR if t['pair'] in oracle_top]
    ob = arm_stats(oracle_sub, pool_by_hour, 'ORACLE')
    print(f"  THE ORACLE: the top {K} symbols by their OWN full-window excess, reported on that")
    print(f"  SAME window. This is what a ranking-then-report would show.")
    print(f"    the {K}: {', '.join(sorted(oracle_top))}")
    print(f"    excess {usd(ob['mean'])}/hour over {ob['n']} clusters, t = {f(ob['t'],2)}, "
          f"trim t = {f(ob['t_trim'],2)}")
    print()
    # the SAME 8 symbols, applied to the SECOND half only
    oracle_test = [t for t in TRADES_CORR if t['pair'] in oracle_top and t['day'] in second]
    ot = arm_stats(oracle_test, pool_by_hour, 'ORACLE/TEST')
    print(f"  THE SAME 8 SYMBOLS, applied to the SECOND HALF ONLY (the honest test of a ranking):")
    print(f"    excess {usd(ot['mean'])}/hour over {ot['n']} clusters, t = {f(ot['t'],2)}, "
          f"trim t = {f(ot['t_trim'],2)}")
    print(f"    the in-sample excess falls from {usd(ob['mean'])} to {usd(ot['mean'])} "
          f"({(ot['mean']-ob['mean'])/abs(ob['mean'])*100 if ob['mean'] else 0:+.0f}%).")
    print()
    print('  THE ARTEFACT\'S SIZE, DIRECTLY: how often does a random 8-symbol universe beat the')
    print('  in-sample oracle? (the placebo on the SAME window):')
    pl = placebo_p(cluster_excess(oracle_sub, pool_by_hour), bypair, pool_by_hour, n_syms=K)
    print(f"    placebo p for the oracle = {f(pl,4)}  ->  "
          f"{'the oracle is INDISTINGUISHABLE from random selection' if (pl or 1) > 0.05 else 'the oracle beats random'}")

    # ── the capacity arithmetic ─────────────────────────────────────────
    line()
    print('5. THE CAPACITY ARITHMETIC — $500 a day, $60 a ticket, 8 tickets')
    line()
    print(f"  the venue's cap: Daily notional cap would exceed $500  (14 live refusals in trade-loop.ndjson)")
    print(f"  a ticket is ${NOTIONAL:.0f} of notional -> {int(DAILY_NOTIONAL_CAP/NOTIONAL)} tickets a day, with")
    print(f"  ${DAILY_NOTIONAL_CAP - K*NOTIONAL:.0f} of headroom unused (the cap is not the binding constraint)")
    print(f"  the account's equity is ${EQUITY:.2f}; the ${NOTIONAL:.0f} notional is {NOTIONAL/EQUITY:.3f}x the equity")
    print(f"  so the leverage is {NOTIONAL/EQUITY:.2f}x at most and the ticket's DOLLARS are pinned at ${NOTIONAL:.0f}")
    print(f"  while the PERCENTAGE return falls as the equity grows. The dollars are the constant.")
    print()
    print('  THE ARITHMETIC OF A DAY, at the CORRECTED ticket\'s measured win rate:')
    for wr in [0.863, 0.828]:
        gw = 0.1853; gl = -1.4533
        ev = wr * gw + (1 - wr) * gl
        print(f"    at a {wr*100:.1f}% win rate: {K} tickets -> {K*ev:+.4f} a day, "
              f"{K*ev/EQUITY*100:+.3f}% of equity")
    print(f"    the CORRECTED pool's measured break-even is 88.7% and it measures 86.3% —")
    print(f"    so 8 tickets a day is 8 x a negative expectancy. At the measured rate the account")
    print(f"    loses ${8*mean([x['pnl_usd'] for x in TRADES_CORR]):.4f} a day on 8 tickets.")
    print()
    print('  THE 8 TO PICK, and the rule that picks them:')
    # the operationally-selected universe for the LAST day, and its stats
    last_day = days[-1]
    for rule in ['NONE', 'VOL_PERCENTILE', 'SPREAD_VOL']:
        uni = build_universe(FEAT, SPREAD, last_day, rule)
        sub = [t for t in TRADES_CORR if t['day'] == last_day and t['pair'] in uni]
        b = arm_stats(sub, pool_by_hour, rule)
        print(f"    {rule:<16} -> {len(uni)} symbols: {', '.join(sorted(uni)) if uni else 'none'}")
        print(f"    {'':<16}    that day: {len(sub)} trades, net {usd(b['net_usd'])}/trade")
    print()
    print('  THE LOOK-AHEAD REQUIREMENT:')
    print('    NONE for the RULES as tested. The universe for day D is computed from the bars')
    print('    that closed before day D (the trailing 24-hour ATR, the trailing 7-day median')
    print('    ATR, the trailing 24-hour drift). No rule reads a price, a signal or an outcome')
    print('    from day D or later.')
    print('    BUT the RANKING DOES: "the 8 best symbols" chosen from the full 14 days is a')
    print('    HYPOTHESIS for the next window, not a result. It is an oracle, and its')
    print('    out-of-sample number above is what it is worth.')

    return results


if __name__ == '__main__':
    main()
