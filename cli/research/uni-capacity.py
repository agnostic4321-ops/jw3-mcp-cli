#!/usr/bin/env python3
"""
THE CAPACITY ARITHMETIC — the $500 a day, $60 a ticket, 8 tickets question.

THE CONSTRAINTS, FROM THE LIVE ACCOUNT
--------------------------------------
  $57.16 of equity
  $60 of notional per ticket (the cap that binds at every equity level
  above $45 — the ticket's DOLLARS are pinned, its PERCENTAGE falls as
  the equity grows)
  $500 of daily notional (the venue's cap; 14 live refusals in
  trade-loop.ndjson read "Daily notional cap would exceed $500")
  0.12% taker round trip = $0.0720 per ticket

WHAT THE EIGHT SHOULD BE, AND WHY THE RULE DOES NOT NEED LOOK-AHEAD
--------------------------------------------------------------------
The universe is decided ONCE PER DAY from the data available BEFORE that
day. So the pick is:
  * CAUSAL — it reads the trailing 24-hour ATR, the symbol's own
    trailing 3-day ATR baseline, the trailing 24-hour drift, and the
    symbol's median spread. None of those is from the day being traded.
  * REFRESHED DAILY — which is what a human would actually do, and
    which the capacity constraint implies anyway.
  * NOT AN ORACLE — the "best 8" chosen from the full 14 days IS an
    oracle, and its out-of-sample number is what it is worth.

THE ECONOMICS OF EIGHT TICKETS
-------------------------------
The daily P&L of 8 tickets is 8 x the per-ticket expectancy, and the
per-ticket expectancy is NEGATIVE on every arm measured. So the honest
capacity answer is: the cap is NOT the binding constraint. The ticket's
expectancy is.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import mean, se, median, NOTIONAL, TAKER_RT, EQUITY, DAILY_NOTIONAL_CAP
from uni_rules import cluster_excess, daily_features, DAY_MS, utc
from uni_sel import build_universe, f, pf, usd

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
PROF = R['profile']
TRADES_CORR = R['trades_corrected']
BARS1H = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))
SPREAD = {p: PROF[p]['spread_med'] for p in PROF}
K = 8

POOL_PNL = collections.defaultdict(list)
for x in TRADES_CORR: POOL_PNL[x['hour']].append(x['pnl_usd'])
BYP = collections.defaultdict(list)
for x in TRADES_CORR: BYP[x['pair']].append(x)


def main():
    print('=' * 118)
    print('THE CAPACITY ARITHMETIC')
    print('=' * 118)
    print(f'  equity            ${EQUITY:.2f}')
    print(f'  notional/ticket   ${NOTIONAL:.0f}   ({NOTIONAL/EQUITY:.3f}x the equity)')
    print(f'  daily cap         ${DAILY_NOTIONAL_CAP:.0f}  -> at most {int(DAILY_NOTIONAL_CAP/NOTIONAL)} tickets')
    print(f'  the cap binds at   {DAILY_NOTIONAL_CAP/NOTIONAL:.0f} tickets, leaving '
          f'${DAILY_NOTIONAL_CAP - K*NOTIONAL:.0f} of headroom UNUSED')
    print(f'  fee/ticket        {TAKER_RT*100:.2f}% of notional = ${TAKER_RT*NOTIONAL:.4f}')
    print(f'  a $60 ticket at a 0.30% target earns ${0.003*NOTIONAL:.2f} gross -> the fee is '
          f'{TAKER_RT*NOTIONAL/(0.003*NOTIONAL)*100:.0f}% of the win')
    print()
    print('  THE BINDING CONSTRAINT IS NOT THE CAP. It is the ticket\'s expectancy:')
    for name, key in [('as built (pre-fix)', 'trades_prefix'),
                      ('as it runs now (post-fix)', 'trades'),
                      ('corrected (target on the good side)', 'trades_corrected')]:
        t = R[key]
        c = collections.Counter(x['kind'] for x in t)
        wr = c['win'] / max(c['win'] + c['loss'], 1)
        ev = mean([x['pnl_usd'] for x in t])
        gw = mean([x['pnl_usd'] for x in t if x['kind'] == 'win'])
        gl = mean([x['pnl_usd'] for x in t if x['kind'] == 'loss'])
        be = (-gl / (gw - gl)) if (gw - gl) else None
        print(f'    {name:<38} WR {wr*100:>5.1f}%  BE {pf(be,1):>7}  net {usd(ev)}/trade  '
              f'-> 8 tickets = {usd(8*ev)}/day')
    print()
    print('  THE BREAKEVEN ARITHMETIC, in dollars, at the real size:')
    print(f'    a win  = ${NOTIONAL*0.003 - TAKER_RT*NOTIONAL:+.4f}   (0.30% target, fee deducted)')
    print(f'    a loss = ${-NOTIONAL*0.01 - TAKER_RT*NOTIONAL:+.4f}   (a 1.0% stop, fee deducted)')
    print(f'    the break-even win rate = {(-(-NOTIONAL*0.01-TAKER_RT*NOTIONAL))/((NOTIONAL*0.003-TAKER_RT*NOTIONAL)+(NOTIONAL*0.01+TAKER_RT*NOTIONAL))*100:.1f}%')
    print(f'    -> the fee is ${TAKER_RT*NOTIONAL:.4f} on EVERY ticket, so 8 tickets a day costs')
    print(f'       ${8*TAKER_RT*NOTIONAL:.4f} in fees before any edge. At 8 tickets a day that is')
    print(f'       ${8*TAKER_RT*NOTIONAL/30:.4f} a day, ${8*TAKER_RT*NOTIONAL*365:.2f} a year, against ${EQUITY:.2f} of equity.')
    print()

    # ── WHICH 8 ────────────────────────────────────────────────────────
    FEAT = daily_features(BARS1H, 14)
    days = sorted({d for (_, d) in FEAT})
    exc = {p: mean(cluster_excess(v, POOL_PNL) or [0]) for p, v in BYP.items()}
    oracle = sorted(exc, key=lambda p: -exc[p])[:K]

    print('=' * 118)
    print('WHICH 8 — three answers, in increasing order of honesty')
    print('=' * 118)
    print()
    print('  A. THE ORACLE (the 8 with the best full-window excess). LOOK-AHEAD: YES.')
    print(f'     {", ".join(oracle)}')
    sub = [t for t in TRADES_CORR if t['pair'] in set(oracle)]
    d = cluster_excess(sub, POOL_PNL)
    print(f'     in-sample excess {mean(d):+.4f}/hour over {len(d)} hours, t={mean(d)/se(d):.2f}')
    print('     -> a HYPOTHESIS for the next window. It has read the window it is measured on.')
    print()
    print('  B. THE FIRST-HALF RANKING, applied to the second half. LOOK-AHEAD: NO.')
    half = len(days) // 2
    first = set(days[:half]); second = set(days[half:])
    exc1 = {p: mean(cluster_excess([t for t in v if t['day'] in first], POOL_PNL) or [0])
            for p, v in BYP.items()}
    honest = sorted(exc1, key=lambda p: -exc1[p])[:K]
    print(f'     {", ".join(honest)}')
    sub2 = [t for t in TRADES_CORR if t['pair'] in set(honest) and t['day'] in second]
    pool2 = collections.defaultdict(list)
    for x in TRADES_CORR:
        if x['day'] in second: pool2[x['hour']].append(x['pnl_usd'])
    d2 = cluster_excess(sub2, pool2)
    print(f'     out-of-sample excess {mean(d2):+.4f}/hour over {len(d2)} hours, t={mean(d2)/se(d2):.2f}')
    print('     -> the operationally usable form: it ranks on what it knew, and it is measured')
    print('        on what it had not seen. This is the number that counts.')
    print()
    print('  C. THE OPERATIONAL RULE (a threshold, not a ranking). LOOK-AHEAD: NO.')
    print('     THE RULE: trade the symbols whose trailing 24-hour ATR is in the top half of the')
    print('     universe AND whose median spread is at or below 12 bps. Refreshed daily from')
    print('     the bars that closed before the day.')
    last = days[-1]
    for rule in ('VOL_FLOOR', 'SPREAD_VOL'):
        u = build_universe(FEAT, SPREAD, last, rule)
        print(f'       {rule:<12} -> {len(u)} symbols: {", ".join(sorted(u)) if u else "none"}')
    print()
    print('  THE LOOK-AHEAD REQUIREMENT, STATED:')
    print('    * The RULE (a threshold on trailing, causal features) needs NO look-ahead.')
    print('    * The RANKING (the specific 8 names) DOES need look-ahead if it is chosen on')
    print('      the same window it is reported on. Chosen on the first half and applied to')
    print('      the second, it needs none — and that is how it must be run.')
    print('    * The universe is refreshed ONCE PER DAY. Within a day it is fixed.')
    print()
    print('  THE EIGHT, AS A SET, AND WHY THE CAP IS NOT THE CONSTRAINT:')
    print('    the 8 symbols are not the scarce resource. The $500 cap allows 8 tickets and')
    print('    the machine fired 13 today — so the cap was hit and REFUSED 14 times.')
    print('    Picking the right 8 changes WHICH 8, but the number of tickets, the fee drag')
    print('    and the per-ticket expectancy are unchanged. On the corrected ticket, the')
    print(f'    measured expectancy is {usd(mean([x["pnl_usd"] for x in TRADES_CORR]))} per trade, so')
    print(f'    8 tickets a day is {usd(8*mean([x["pnl_usd"] for x in TRADES_CORR]))} a day.')


if __name__ == '__main__':
    main()
