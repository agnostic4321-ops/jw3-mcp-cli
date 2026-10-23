#!/usr/bin/env python3
"""
THE FINAL DECISIVE TEST — is the oracle's edge a SYMBOL effect, or a
DIRECTION effect that any symbol could have captured?

WHAT THE ORACLE FOUND
---------------------
The oracle's excess survives the direction-and-regime-matched control
(t = 7.69). Its mechanism is visible in the split: the oracle's SHORT
side wins 92.2% against the pool's 87.0%, while its LONG side is the
same as the pool's (76.4%). So the excess comes from the SHORT side.

THE QUESTION THAT MATTERS
-------------------------
If the short side is better on those 8 symbols, is that because the 8
symbols are special, or because the SHORT side is better in that part of
the window? The distinguishing test: take the oracle's 8 symbols and
compare their SHORT-side performance against the SAME 8 symbols' LONG
side, and against the pool's short side IN THE SAME HOURS.

If the 8 symbols' shorts beat the pool's shorts in the same hours, the
symbols carry it. If they do not, the excess is the market's drift
differing across the window, and the "ranking" just happened to pick
symbols that were in the good part of the market.

THE THREE ARMS
--------------
  A. THE ORACLE'S 8 SYMBOLS, SHORT side, vs the pool's short side,
     in the SAME hours. (the symbol effect, direction-matched)
  B. THE ORACLE'S 8 SYMBOLS, ALL sides, vs the pool, same hours.
  C. A SHUFFLED-ORACLE: the oracle's 8 symbols, with the assignment of
     each symbol's SIGNALS randomly reassigned across the pool's
     symbols. If the excess survives this, it is the SYMBOL's identity
     that carries it. If it collapses, it was the symbol's TIMING.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st, random

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import mean, se, median
from uni_rules import cluster_excess

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
T = R['trades_corrected']
POOL = collections.defaultdict(list)
for x in T: POOL[x['hour']].append(x)
POOL_PNL = collections.defaultdict(list)
for x in T: POOL_PNL[x['hour']].append(x['pnl_usd'])
BYP = collections.defaultdict(list)
for x in T: BYP[x['pair']].append(x)


def stat_line(label, diffs):
    if not diffs:
        print(f'  {label:<52} no matched clusters'); return None
    m = mean(diffs); s = se(diffs); t = m / s if s > 0 else None
    ss = sorted(diffs)
    tr = mean(ss[3:-3]) if len(ss) > 6 else None
    tt = (tr / se(ss[3:-3])) if tr is not None and se(ss[3:-3]) > 0 else None
    print(f'  {label:<52} n={len(diffs):>4} excess {m:+.4f}  t={t if t is None else round(t,2):>6}  '
          f'trim t={tt if tt is None else round(tt,2):>6}')
    return dict(n=len(diffs), mean=m, t=t, trimmed=tr, t_trim=tt)


def main():
    exc = {p: mean(cluster_excess(v, POOL_PNL) or [0]) for p, v in BYP.items()}
    top8 = set(sorted(exc, key=lambda p: -exc[p])[:8])
    print('=' * 122)
    print('IS IT A SYMBOL EFFECT OR A TIMING EFFECT?')
    print('=' * 122)
    print(f'  the oracle: {", ".join(sorted(top8))}')
    print()

    # A. the oracle's SHORT side vs the pool's short side, same hours
    sub_s = [t for t in T if t['pair'] in top8 and t['side'] == 'short']
    pool_s = collections.defaultdict(list)
    for x in T:
        if x['side'] == 'short': pool_s[x['hour']].append(x['pnl_usd'])
    dA = []
    byh = collections.defaultdict(list)
    for t in sub_s: byh[t['hour']].append(t['pnl_usd'])
    for h, v in byh.items():
        pv = pool_s.get(h)
        if pv: dA.append(mean(v) - mean(pv))
    print('  A. THE ORACLE\'S SHORT SIDE vs the pool\'s SHORT side, in the SAME hours:')
    stat_line('     the SYMBOL effect', dA)

    # B. the oracle's LONG side vs the pool's long side, same hours
    sub_l = [t for t in T if t['pair'] in top8 and t['side'] == 'long']
    pool_l = collections.defaultdict(list)
    for x in T:
        if x['side'] == 'long': pool_l[x['hour']].append(x['pnl_usd'])
    dB = []
    byh = collections.defaultdict(list)
    for t in sub_l: byh[t['hour']].append(t['pnl_usd'])
    for h, v in byh.items():
        pv = pool_l.get(h)
        if pv: dB.append(mean(v) - mean(pv))
    print('  B. THE ORACLE\'S LONG SIDE vs the pool\'s LONG side, in the SAME hours:')
    stat_line('     the SYMBOL effect (long)', dB)

    # C. THE SHUFFLED-ORACLE: the oracle's symbols' signals, reassigned
    #    at random across the pool's symbols. If the excess survives, the
    #    symbol's IDENTITY carries it.
    print()
    print('  C. THE SHUFFLED-ORACLE — the oracle\'s symbols, with each symbol\'s signals')
    print('     randomly reassigned to the pool\'s symbols. The excess that survives')
    print('     this is the SYMBOL\'s identity; the excess that dies is the TIMING.')
    rnd = random.Random(31337)
    survivors = []
    for trial in range(40):
        # the pool's symbol list, weighted by how many signals each has
        all_pairs = [x['pair'] for x in T]
        rnd.shuffle(all_pairs)
        shuffled = []
        for i, t in enumerate(T):
            q = dict(t)
            q['pair'] = all_pairs[i]
            shuffled.append(q)
        sh_pool = collections.defaultdict(list)
        for x in shuffled: sh_pool[x['hour']].append(x['pnl_usd'])
        sub = [x for x in shuffled if x['pair'] in top8]
        d = cluster_excess(sub, sh_pool)
        if d: survivors.append(mean(d))
    obs = mean(dA)
    ge = sum(1 for s in survivors if s >= obs)
    print(f'     the observed symbol effect (arm A): {obs:+.4f}')
    print(f'     the shuffled-ORACLE distribution: median {median(survivors):+.4f}  '
          f'p95 {sorted(survivors)[int(0.95*len(survivors))]:+.4f}  max {max(survivors):+.4f}')
    print(f'     the observed effect exceeds {ge} of {len(survivors)} shuffles -> '
          f'p = {(ge+1)/(len(survivors)+1):.4f}')

    # D. the DECISIVE one: the oracle's 8 symbols, but the ranking is
    #    taken from the OTHER half of the window. If the effect is a
    #    symbol property, the symbols carry it. If it is timing, it dies.
    print()
    print('  D. THE HONEST SPLIT — rank on the FIRST half, measure on the SECOND half,')
    print('     with the direction-matched control:')
    DAYS = sorted({t['day'] for t in T})
    half = len(DAYS) // 2
    first = set(DAYS[:half]); second = set(DAYS[half:])
    exc1 = {}
    for p, v in BYP.items():
        d = cluster_excess([t for t in v if t['day'] in first], POOL_PNL)
        exc1[p] = mean(d) if d else 0.0
    top1 = set(sorted(exc1, key=lambda p: -exc1[p])[:8])
    print(f'     the first half\'s top 8: {", ".join(sorted(top1))}')
    # the second half: the short side of those 8 vs the pool's short side
    sub2 = [t for t in T if t['pair'] in top1 and t['side'] == 'short' and t['day'] in second]
    pool_s2 = collections.defaultdict(list)
    for x in T:
        if x['side'] == 'short' and x['day'] in second:
            pool_s2[x['hour']].append(x['pnl_usd'])
    d2 = []
    byh = collections.defaultdict(list)
    for t in sub2: byh[t['hour']].append(t['pnl_usd'])
    for h, v in byh.items():
        pv = pool_s2.get(h)
        if pv: d2.append(mean(v) - mean(pv))
    stat_line('     the symbol effect, out of sample', d2)
    # and the random-8 comparison on the same footing
    rnd2 = random.Random(99)
    rand_d = []
    all_pairs = sorted(BYP.keys())
    for _ in range(200):
        sel = set(rnd2.sample(all_pairs, 8))
        s2 = [t for t in T if t['pair'] in sel and t['side'] == 'short' and t['day'] in second]
        bh = collections.defaultdict(list)
        for t in s2: bh[t['hour']].append(t['pnl_usd'])
        dd = []
        for h, v in bh.items():
            pv = pool_s2.get(h)
            if pv: dd.append(mean(v) - mean(pv))
        if dd: rand_d.append(mean(dd))
    rand_d.sort()
    if d2:
        rank = sum(1 for x in rand_d if x < mean(d2)) / len(rand_d)
        print(f'     random 8-symbol universes on the same footing: median {median(rand_d):+.4f}  '
              f'p95 {rand_d[int(0.95*len(rand_d))]:+.4f}  max {max(rand_d):+.4f}')
        print(f'     the first-half ranking sits at the {rank*100:.1f}th percentile '
              f'({sum(1 for x in rand_d if x < mean(d2))} of {len(rand_d)} random universes)')


if __name__ == '__main__':
    main()
