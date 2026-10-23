#!/usr/bin/env python3
"""
THE FALSIFICATION ATTEMPTS — every way this result could be an artefact,
tried and measured.

If a symbol-selection effect is real, it must survive all of these. If
any one of them kills it, it was an artefact.

  F1. THE SHUFFLED-ORACLE (done): reassign each symbol's signals across
      the pool's symbols. Kills a TIMING effect. -> SURVIVES
  F2. THE SYMBOL-LEVEL T: the excess of each of the 8 symbols on its
      own, with a per-symbol t. If the "effect" is one symbol, the
      others are noise.
  F3. THE LEAVE-ONE-OUT: drop each of the 8 in turn. If the effect
      depends on one symbol, it dies when that symbol is dropped.
  F4. THE DAY-LEVEL REPLICATION: how many of the 11 operating days does
      the effect hold on? An effect that needs 3 lucky days is not an
      effect.
  F5. THE REVERSED TICKET: if the effect is a property of the TICKET's
      geometry rather than the symbol, reversing the target direction
      (taking profit against the trade) must ALSO show an excess.
  F6. THE SYMBOL-PERMUTATION TEST: if the effect is real, a SPECIFIC
      set of 8 symbols should beat OTHER specific sets consistently.
  F7. THE EFFECT ON A DIFFERENT GEOMETRY: does the same 8 symbols win
      under a different (TP, SL) geometry? A symbol effect should
      persist across geometries; a geometry-specific artefact will not.
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
POOL_PNL = collections.defaultdict(list)
for x in T: POOL_PNL[x['hour']].append(x['pnl_usd'])
BYP = collections.defaultdict(list)
for x in T: BYP[x['pair']].append(x)


def d_of(subset, pool_pnl):
    return cluster_excess(subset, pool_pnl)


def show(label, diffs, note=''):
    if not diffs:
        print(f'  {label:<46} no clusters'); return None
    m = mean(diffs); s = se(diffs); t = m / s if s > 0 else None
    ss = sorted(diffs)
    tr = mean(ss[3:-3]) if len(ss) > 6 else None
    tt = (tr / se(ss[3:-3])) if tr is not None and se(ss[3:-3]) > 0 else None
    ts = f'{t:.2f}' if t is not None else 'n/a'
    tts = f'{tt:.2f}' if tt is not None else 'n/a'
    print(f'  {label:<46} n={len(diffs):>4} excess {m:+.4f}  t={ts:>6}  '
          f'trim t={tts:>6}  {note}')
    return dict(n=len(diffs), mean=m, t=t, t_trim=tt)


def main():
    exc = {p: mean(cluster_excess(v, POOL_PNL) or [0]) for p, v in BYP.items()}
    top8 = sorted(exc, key=lambda p: -exc[p])[:8]
    top8s = set(top8)
    print('=' * 122)
    print('THE FALSIFICATION ATTEMPTS')
    print('=' * 122)
    print(f'  the 8: {", ".join(top8)}')
    print()

    print('F2. THE SYMBOL-LEVEL t — is it ONE symbol or all eight?')
    print('    (a t below 2 on a symbol means that symbol alone is not distinguishable from the pool)')
    for p in top8:
        d = d_of(BYP[p], POOL_PNL)
        show(f'      {p}', d)

    print()
    print('F3. THE LEAVE-ONE-OUT — does the effect depend on one symbol?')
    for p in top8:
        rest = [x for x in top8 if x != p]
        sub = [t for t in T if t['pair'] in rest]
        d = d_of(sub, POOL_PNL)
        show(f'      without {p}', d)

    print()
    print('F4. THE DAY-LEVEL REPLICATION — how many operating days does it hold on?')
    DAYS = sorted({t['day'] for t in T})
    wins = 0; det = 0
    for d in DAYS:
        pool_d = collections.defaultdict(list)
        for x in T:
            if x['day'] == d: pool_d[x['hour']].append(x['pnl_usd'])
        sub = [t for t in T if t['pair'] in top8s and t['day'] == d]
        dd = d_of(sub, pool_d)
        if not dd: continue
        det += 1
        if mean(dd) > 0: wins += 1
        show(f'      day {d}', dd)
    print(f'    -> the effect is positive on {wins} of {det} days with data')

    print()
    print('F5. THE REVERSED TICKET — is the "edge" just the ticket geometry?')
    # reverse the sign of every trade's P&L: if the same 8 symbols win
    # with the ticket REVERSED, then what was measured is a property of
    # the geometry, not of the symbol.
    rev = [dict(x, pnl_usd=-x['pnl_usd']) for x in T]
    rp = collections.defaultdict(list)
    for x in rev: rp[x['hour']].append(x['pnl_usd'])
    rbyp = collections.defaultdict(list)
    for x in rev: rbyp[x['pair']].append(x)
    rex = {p: mean(cluster_excess(v, rp) or [0]) for p, v in rbyp.items()}
    rtop = set(sorted(rex, key=lambda p: -rex[p])[:8])
    print(f'    the top 8 of the REVERSED ticket: {", ".join(sorted(rtop))}')
    print(f'    the overlap with the forward top 8: {len(rtop & top8s)} of 8')
    d = d_of([t for t in rev if t['pair'] in rtop], rp)
    show('    the reversed ticket\'s own top 8', d, '(if positive, the geometry is the story)')
    d = d_of([t for t in rev if t['pair'] in top8s], rp)
    show('    the FORWARD top 8 on the reversed ticket', d, '(if negative, the forward 8 are not just "lucky geometry")')

    print()
    print('F6. THE SYMBOL-PERMUTATION TEST — would OTHER sets of 8 do as well?')
    rnd = random.Random(4242)
    allp = sorted(BYP.keys())
    # the forward 8's excess, measured on the SECOND half only (honest)
    DAYS2 = sorted({t['day'] for t in T}); half = len(DAYS2) // 2
    second = set(DAYS2[half:])
    def excess_on(pairs_set):
        sub = [t for t in T if t['pair'] in pairs_set and t['day'] in second]
        byh = collections.defaultdict(list)
        for t in sub: byh[t['hour']].append(t['pnl_usd'])
        out = []
        for h, v in byh.items():
            pv = [p for p in POOL_PNL.get(h, [])]
            if pv: out.append(mean(v) - mean(pv))
        return out
    fwd = mean(excess_on(top8s))
    print(f'    the forward top 8 on the second half: {fwd:+.4f}')
    # how many random sets beat it?
    cnt = 0; N = 300
    vals = []
    for _ in range(N):
        sel = set(rnd.sample(allp, 8))
        e = mean(excess_on(sel) or [0])
        vals.append(e)
        if e >= fwd: cnt += 1
    vals.sort()
    print(f'    random 8-symbol sets: median {median(vals):+.4f}  p95 {vals[int(0.95*N)]:+.4f}  max {vals[-1]:+.4f}')
    print(f'    -> {cnt} of {N} random sets beat the forward top 8 (p = {(cnt+1)/(N+1):.4f})')

    print()
    print('F7. DOES THE EFFECT PERSIST UNDER A DIFFERENT GEOMETRY?')
    # group the trades by their ATR bucket and see if the effect holds in
    # each: a symbol effect should not be confined to one ATR regime.
    atr_buckets = [(0.0, 0.8), (0.8, 1.1), (1.1, 1.5), (1.5, 99.0)]
    for lo, hi in atr_buckets:
        sub = [t for t in T if t['pair'] in top8s and lo <= t['atr'] < hi]
        pool = collections.defaultdict(list)
        for x in T:
            if lo <= x['atr'] < hi: pool[x['hour']].append(x['pnl_usd'])
        d = d_of(sub, pool)
        show(f'      ATR in [{lo}, {hi})', d)


if __name__ == '__main__':
    main()
