#!/usr/bin/env python3
"""
THE WINNER'S-CURSE PLACEBO — the decisive test of a SELECTED universe.

THE PROBLEM
-----------
The oracle (the 8 symbols with the best full-window excess) was CHOSEN
from the same window it is measured on. Comparing it against a SINGLE
random 8-symbol universe is the wrong test: the oracle is the maximum
over 43 symbols, so of course it beats one random draw.

THE RIGHT TEST
--------------
The MAXIMUM excess over many random 8-symbol universes. That is what
"picking the best 8" buys you BY CONSTRUCTION, with no skill. If the
oracle's excess is inside that distribution, the selection bought
nothing: it is the winner's curse, not an edge.

So:
    1. draw N random 8-symbol universes, measure each one's excess
    2. take the MAXIMUM of those N
    3. ask where the oracle sits in that maximum's distribution

If the oracle is at the top of it, the oracle is exactly what chance
selection would have produced, and the "ranking" is an artefact.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import mean, se, median
from uni_rules import cluster_excess

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
T = R['trades_corrected']
POOL = collections.defaultdict(list)
for x in T: POOL[x['hour']].append(x['pnl_usd'])
BYP = collections.defaultdict(list)
for x in T: BYP[x['pair']].append(x)

import random
DRAWS = 400
K = 8
rnd = random.Random(20241021)
pairs = list(BYP.keys())

print('=' * 100)
print('THE WINNER\'S-CURSE PLACEBO')
print('=' * 100)
print(f'  the universe is {len(pairs)} symbols; the selection is {K} of them')
print(f'  {DRAWS} random {K}-symbol universes, each measured on the SAME window')
print()

exc = {}
for p, v in BYP.items():
    d = cluster_excess(v, POOL)
    exc[p] = mean(d) if d else 0.0
ranked = sorted(exc, key=lambda p: -exc[p])
top = set(ranked[:K])
oracle_d = cluster_excess([t for t in T if t['pair'] in top], POOL)
oracle = mean(oracle_d)

draws = []
for _ in range(DRAWS):
    sel = set(rnd.sample(pairs, K))
    d = cluster_excess([t for p in sel for t in BYP[p]], POOL)
    draws.append(mean(d) if d else 0.0)
draws.sort()

print(f'  the ORACLE (the best 8, chosen on this window): {oracle:+.4f}/hour')
print(f'  random {K}-symbol universes:')
print(f'    median {median(draws):+.4f}   mean {mean(draws):+.4f}   p95 {draws[int(0.95*len(draws))]:+.4f}')
print(f'    MAXIMUM over {DRAWS} draws: {draws[-1]:+.4f}')
print(f'    the oracle EXCEEDS {sum(1 for d in draws if d >= oracle)} of the {DRAWS} random draws')
print()
rank = sum(1 for d in draws if d < oracle) / len(draws)
print(f'  the oracle\'s percentile among random universes: {rank*100:.1f}%')
print()
if rank < 0.95:
    print('  -> THE ORACLE IS INSIDE THE WINNER\'S-CURSE DISTRIBUTION.')
    print('     Picking the best 8 BY RANKING buys exactly what chance selection buys.')
    print('     The in-sample excess is a SELECTION ARTEFACT, not an edge.')
else:
    print('  -> the oracle exceeds the winner\'s curse. But it was chosen on this window,')
    print('     so the number is still a HYPOTHESIS for the next window, not a result.')

# and the same test, split in half: rank on the first half, measure on the second
print()
print('=' * 100)
print('AND THE SAME TEST, HONESTLY SPLIT: rank on the FIRST half, measure on the SECOND')
print('=' * 100)
DAYS = sorted({t['day'] for t in T})
half = len(DAYS) // 2
first = set(DAYS[:half]); second = set(DAYS[half:])
print(f'  train days {len(first)}   test days {len(second)}')

# the ranking on the FIRST half only
exc1 = {}
for p, v in BYP.items():
    d = cluster_excess([t for t in v if t['day'] in first], POOL)
    exc1[p] = mean(d) if d else 0.0
top1 = set(sorted(exc1, key=lambda p: -exc1[p])[:K])
print(f'  the top {K} by the FIRST half alone: {", ".join(sorted(top1))}')


def excess_on(pairs_set, day_filter):
    sub = [t for t in T if t['pair'] in pairs_set and t['day'] in day_filter]
    byh = collections.defaultdict(list)
    for t in sub: byh[t['hour']].append(t['pnl_usd'])
    out = []
    for h, v in byh.items():
        pv = POOL.get(h)
        if pv: out.append(mean(v) - mean(pv))
    return out


d1 = excess_on(top1, second)
print(f'  its excess on the SECOND half: {mean(d1):+.4f}/hour over {len(d1)} hours '
      f'(t={mean(d1)/se(d1) if se(d1) else 0:.2f})')
# the random-8 comparison on the SECOND half
rnd2 = random.Random(7)
draws2 = []
for _ in range(DRAWS):
    sel = set(rnd2.sample(pairs, K))
    dd = excess_on(sel, second)
    if dd: draws2.append(mean(dd))
draws2.sort()
print(f'  random {K}-symbol universes on the SECOND half: median {median(draws2):+.4f}  '
      f'max {draws2[-1]:+.4f} over {len(draws2)} draws')
rank2 = sum(1 for d in draws2 if d < mean(d1)) / len(draws2)
print(f'  the first-half ranking sits at the {rank2*100:.1f}th percentile of random '
      f'{K}-symbol universes on the second half.')
if rank2 < 0.95:
    print('  -> THE FIRST-HALF RANKING IS ALSO INSIDE THE WINNER\'S CURSE.')
    print('     A symbol ranking does not beat a random pick, even when the ranking is')
    print('     chosen on data it has never seen.')
else:
    print('  -> the ranking survives the split. (Still a hypothesis for the next window.)')
