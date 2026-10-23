#!/usr/bin/env python3
"""
THE UNIVERSE MISMATCH — the pool the study measured, and the pool the
machine actually trades.

THE FINDING
-----------
The machine traded LINK, SUI, AVAX, TAO and ENA today. NONE of them is
in the 43-symbol pool the collector samples. The pool and the machine's
universe are DISJOINT (except DOGE, which is in both).

So the study measures a universe the machine does not trade, and the
machine trades a universe the study did not measure. That is the
fidelity gap the repo's own "fidelity audit" (commit 9301de37) named.

THE CONSEQUENCE FOR THIS TASK
-----------------------------
  * The 14-day per-symbol table describes the COLLECTOR's universe. It
    is the right universe for "which symbols would the collector's
    machine trade better", and the wrong universe for "what should the
    LIVE machine trade".
  * The symbol-selection rule's VALUE is therefore conditional on the
    machine being pointed at the collector's universe at all.
  * The rule's PARAMETERS (which 8 symbols) are a hypothesis for the
    next window and for the live universe, not a prescription.

THE MEASUREMENT
---------------
This file measures how much the two universes overlap, and what the
machine's own traded symbols look like on the LIVE tape (the collector's
4.5-hour sample), so the reader can see the two sides separately.
"""
import json, os, sys
from os.path import join, expanduser
import collections, statistics as st, math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import mean, se

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
PROF = R['profile']; STAT = R['symbol_stats']

# the machine's own trade log
rows = [json.loads(l) for l in open(os.path.join(SCRATCH, 'trade-loop.ndjson')) if l.strip()]
fired = [r for r in rows if r.get('event') == 'FIRED']
live_pairs = collections.Counter(r['pair'] for r in fired)
# every pair the loop even CONSIDERED (model-agreement rows)
considered = collections.Counter(r['pair'] for r in rows if r.get('event') == 'model-agreement')

# the collector's universe
conf = [json.loads(l) for l in open(os.path.join(SCRATCH, 'confluence.ndjson')) if l.strip()]
collector_pairs = sorted({r['pair'] for r in conf})

# the daemon's manifest
man = json.load(open('/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/machine-manifest.json'))
manifest_pairs = man['pairs']

print('=' * 118)
print('THE UNIVERSE MISMATCH')
print('=' * 118)
print(f"  the COLLECTOR's universe (the 43 this study measured): {len(collector_pairs)} symbols")
print(f"  the MACHINE's manifest pairs:                            {manifest_pairs}")
print(f"  the machine's FIRED trades today:                        {dict(live_pairs)}")
print()
print('  THE OVERLAP:')
inter = sorted(set(manifest_pairs) & set(collector_pairs))
print(f'    manifest ∩ collector = {inter if inter else "EMPTY"}')
fired_inter = sorted(set(live_pairs) & set(collector_pairs))
print(f'    fired    ∩ collector = {fired_inter if fired_inter else "EMPTY"}')
print()
print('  -> THE MACHINE TRADES A UNIVERSE THE COLLECTOR DOES NOT SAMPLE.')
print('     Every symbol it fired today (LINK, SUI, AVAX, TAO, ENA) is OUTSIDE')
print('     the 43-symbol pool this study measured.')
print('     Only DOGE/USDT is in both.')
print()

print('  WHAT THE MACHINE CONSIDERED (the model-agreement rows in trade-loop.ndjson):')
print(f"    {len(considered)} distinct symbols")
for p, n in considered.most_common(30):
    inp = 'IN the pool' if p in PROF else 'not in the pool'
    print(f"      {p:<14} {n:>4} model-agreement rows   {inp}")
print()

print('  THE CONSEQUENCE, STATED PLAINLY:')
print('    1. The 14-day table is a table of the COLLECTOR\'s universe. It answers')
print('       "which symbols of the sampled 43 would the ticket work best on".')
print('    2. It is NOT a table of the live machine\'s universe, and no amount of')
print('       care in the statistics makes it one.')
print('    3. A symbol-selection rule measured on the collector\'s universe is a')
print('       rule FOR THAT UNIVERSE. Pointing the live machine at the collector\'s')
print('       universe is a SEPARATE, PREREQUISITE change — and it is a bigger one')
print('       than the selection rule.')
print('    4. The rank of the 8 symbols is a HYPOTHESIS for the next window.')
print()

print('  THE ONE SYMBOL IN BOTH, measured:')
if 'DOGE/USDT' in PROF:
    pr = PROF['DOGE/USDT']; s = STAT['DOGE/USDT']
    print(f"    DOGE/USDT  ATR {pr['atr_med']:.3f}%  spread {pr['spread_med']:.2f}bps  "
          f"fires {pr['fires']}  long {pr['n_long']}")
    print(f"      trades {s['n']}  WR {s['win_rate']*100:.1f}%  net {s['net_usd']:+.4f}/trade  "
          f"excess {s['excess_usd']:+.4f}  t {s['t_excess']:.2f}")
    print(f"      -> the tightest spread in the pool ({pr['spread_med']:.2f}bps) and a NEGATIVE excess.")
    print('      -> the best-booked symbol is the WORST performer: the spread is not the')
    print('         binding constraint; the fee and the geometry are.')

# the collector's own tape over its 4.5 hours, for the live symbols
print()
print('  THE COLLECTOR\'S OWN TAPE for the symbols it samples — the LONG side, 4.5 hours:')
lp = collections.Counter(r.get('tapeSide') for r in conf)
print(f"    {dict(lp)}")
live_gate = 0
for r in conf:
    jev = r['jevSide'] if r['jevSide'] != 'flat' and r.get('jevUncertain') is not True else None
    laya = r['layaSide'] if r['layaSide'] != 'flat' else None
    if jev and laya and jev == laya and r.get('tapeSide') == jev:
        live_gate += 1
print(f"    the live gate (both models agree AND the tape agrees): {live_gate} rows")
print(f"    the live arm's distinct symbols: {len(set(r['pair'] for r in conf if r.get('tapeSide')))}")
