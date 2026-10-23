#!/usr/bin/env python3
"""
THE TIGHTEST CONTROL — direction-matched and regime-matched.

THE PROBLEM WITH THE POOL CONTROL
----------------------------------
The pool control compares a selected universe against every symbol's
signals. But the tape is 94% SHORT, and the market's own drift over the
window decides a short-only arm's P&L. So a selected universe can look
good simply because it happened to be short more, or because it traded
in a falling market.

THE REPO'S OWN STANDARD (rep-measure.mjs's measureDirectionMatched) is
the direction-matched control: compare the selection against the SAME
symbols and the SAME direction, so the direction cancels.

This file measures FOUR controls, from tightest to loosest:
  1. DIRECTION-MATCHED: the selection vs the pool's SAME-direction
     signals, in the same hour.
  2. REGIME-MATCHED: the selection vs the pool's signals in the same
     hour AND the same market regime (the tape's own drift: up/down).
  3. DIRECTION-AND-REGIME-MATCHED: both at once.
  4. THE RAW POOL: everything, no matching (the loosest).

If the selection's excess survives control 3, it is a symbol effect. If
it only survives control 4, it is the market's drift.
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
BARS1H = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))

# ── the market's regime per hour: the BTC-relative drift ─────────────
# The regime is the tape's own change sign over the hour (chg), which is
# the market's direction in the symbol's own terms. A market-wide move
# moves every symbol the same way, so the SIGN of chg is the regime.
def regime_of(trade):
    return 'up' if trade['chg'] > 0 else ('down' if trade['chg'] < 0 else 'flat')


def matched_excess(subset, pool, keyfn):
    """The per-hour excess, where the pool is matched on (hour, key)."""
    byh = collections.defaultdict(list)
    for t in subset:
        byh[t['hour']].append(t)
    diffs = []
    for h, v in byh.items():
        pv = [p for p in pool.get(h, []) if keyfn(p) == keyfn(v[0])]
        if not pv: continue
        diffs.append(mean([x['pnl_usd'] for x in v]) - mean([x['pnl_usd'] for x in pv]))
    return diffs


def matched_excess_by_dir_and_regime(subset, pool):
    """The per-hour excess, matched on (hour, direction, regime)."""
    byh = collections.defaultdict(list)
    for t in subset:
        byh[(t['hour'], t['side'], regime_of(t))].append(t)
    diffs = []
    for (h, d, r), v in byh.items():
        pv = [p for p in pool.get(h, [])
              if p['side'] == d and regime_of(p) == r]
        if not pv: continue
        diffs.append(mean([x['pnl_usd'] for x in v]) - mean([x['pnl_usd'] for x in pv]))
    return diffs


def report(label, diffs):
    if not diffs:
        print(f'  {label:<44} no matched clusters'); return None
    m = mean(diffs); s = se(diffs)
    t = m / s if s > 0 else None
    ss = sorted(diffs)
    trimmed = mean(ss[3:-3]) if len(ss) > 6 else None
    t_trim = (trimmed / se(ss[3:-3])) if trimmed is not None and se(ss[3:-3]) > 0 else None
    print(f'  {label:<44} n={len(diffs):>4}  excess {m:+.4f}  t={t if t is None else round(t,2):>6}  '
          f'trim t={t_trim if t_trim is None else round(t_trim,2):>6}  '
          f'worst3 {mean(ss[:3]):+.4f}  best3 {mean(ss[-3:]):+.4f}')
    return dict(n=len(diffs), mean=m, t=t, trimmed=trimmed, t_trim=t_trim)


def main():
    pool_by_hour = collections.defaultdict(list)
    for x in T: pool_by_hour[x['hour']].append(x)
    BYP = collections.defaultdict(list)
    for x in T: BYP[x['pair']].append(x)

    # the oracle (the in-sample ranking)
    pool_pnl = collections.defaultdict(list)
    for x in T: pool_pnl[x['hour']].append(x['pnl_usd'])
    exc = {p: mean(cluster_excess(v, pool_pnl) or [0]) for p, v in BYP.items()}
    top8 = set(sorted(exc, key=lambda p: -exc[p])[:8])
    sub = [t for t in T if t['pair'] in top8]

    print('=' * 118)
    print('THE TIGHTEST CONTROL — the in-sample oracle, against four controls')
    print('=' * 118)
    print(f'  the oracle: {", ".join(sorted(top8))}')
    print()
    print('  1. THE RAW POOL (no matching) — the loosest control:')
    report('     vs every signal on every symbol', cluster_excess(sub, pool_pnl))
    print('  2. THE DIRECTION-MATCHED control (the repo\'s own standard):')
    report('     vs the pool\'s SAME-direction signals', matched_excess(sub, pool_by_hour, lambda t: t['side']))
    print('  3. THE REGIME-MATCHED control (same hour, same market drift):')
    report('     vs the pool\'s SAME-regime signals', matched_excess(sub, pool_by_hour, regime_of))
    print('  4. THE DIRECTION-AND-REGIME-MATCHED control (the tightest):')
    report('     vs the pool\'s SAME direction AND regime', matched_excess_by_dir_and_regime(sub, pool_by_hour))

    print()
    print('=' * 118)
    print('THE DIRECTION SPLIT of the oracle itself')
    print('=' * 118)
    for d in ('long', 'short'):
        s = [t for t in sub if t['side'] == d]
        if not s: continue
        c = collections.Counter(x['kind'] for x in s)
        print(f'  {d:<6} {len(s):>6} trades  WR {c["win"]/max(c["win"]+c["loss"],1)*100:>5.1f}%  '
              f'net {mean([x["pnl_usd"] for x in s]):+.4f}/trade')
    print()
    print('  the pool, for reference:')
    for d in ('long', 'short'):
        s = [t for t in T if t['side'] == d]
        if not s: continue
        c = collections.Counter(x['kind'] for x in s)
        print(f'  {d:<6} {len(s):>6} trades  WR {c["win"]/max(c["win"]+c["loss"],1)*100:>5.1f}%  '
              f'net {mean([x["pnl_usd"] for x in s]):+.4f}/trade')

    # the direction composition of the oracle vs the pool
    print()
    print('  THE DIRECTION COMPOSITION — the artefact\'s likely mechanism:')
    for name, s in [('the oracle', sub), ('the pool', T)]:
        l = sum(1 for x in s if x['side'] == 'long')
        sh = sum(1 for x in s if x['side'] == 'short')
        print(f'    {name:<12} {l:>6} long ({l/len(s)*100:>5.2f}%)  {sh:>6} short ({sh/len(s)*100:>5.2f}%)')


if __name__ == '__main__':
    main()
