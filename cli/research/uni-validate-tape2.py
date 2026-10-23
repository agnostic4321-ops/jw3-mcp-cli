#!/usr/bin/env python3
"""
THE FIDELITY GATE FOR THE TAPE: can the freshly-fetched 1-hour bars
reproduce the tape the collector ACTUALLY recorded?

The collector wrote tapeVratio / tapeOffHighPct / tapeOffLowPct /
tapeAtrPct / tapeSide for every row it took, on KuCoin, at 5-minute
intervals. The 1-hour bars fetched from the same venue's public endpoint
over the same window must reproduce those numbers.

If it does, the 14-day tape built from these bars is the machine's own
state, and the 14-day study measures the same thing the live path does.

If it does NOT, the difference is stated and the study's limit is stated
with it.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_tape import tape_at, tape_side

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))

bars = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))
conf = [json.loads(l) for l in open(os.path.join(SCRATCH, 'confluence.ndjson')) if l.strip()]

errs = collections.defaultdict(list)
side_ok = 0; side_diff = 0; side_null_rec = 0; n = 0
rec_null_side = 0
per_pair = collections.defaultdict(lambda: collections.Counter())

for r in conf:
    p = r['pair']
    b = bars.get(p)
    if not b: continue
    m = tape_at(b, r['ts'])
    if m is None: continue
    n += 1
    for k in ('vratio', 'offHighPct', 'offLowPct', 'atrPct'):
        got = m[k]
        want = r.get('tape' + k[0].upper() + k[1:])
        if want is None or got is None: continue
        errs[k].append(abs(got - want))
    rs = tape_side(m)
    want_side = r.get('tapeSide')
    per_pair[p]['n'] += 1
    if rs == want_side:
        side_ok += 1; per_pair[p]['ok'] += 1
    elif want_side is None:
        rec_null_side += 1; per_pair[p]['extra'] += 1
    else:
        side_diff += 1; per_pair[p]['diff'] += 1

print('=' * 100)
print('THE TAPE FIDELITY GATE — 1-hour bars vs the collector\'s OWN recorded tape')
print('=' * 100)
print(f'collector rows compared: {n}')
print()
print('  metric        n     median|err|     p90|err|     max|err|')
print('  ' + '-' * 62)
for k in ('vratio', 'offHighPct', 'offLowPct', 'atrPct'):
    e = sorted(errs[k])
    if not e: continue
    print(f'  {k:<12} {len(e):<6} {e[len(e)//2]:>11.4f} {e[int(len(e)*0.9)]:>11.4f} {e[-1]:>11.4f}')
print()
print(f'  side AGREES with the collector:            {side_ok}/{n} ({side_ok/n*100:.2f}%)')
print(f'  side DIFFERS (collector had a side):        {side_diff}/{n} ({side_diff/n*100:.2f}%)')
print(f'  reconstruction found a side, collector had none: {rec_null_side}/{n} ({rec_null_side/n*100:.2f}%)')

# The worst pairs
worst = sorted(per_pair.items(), key=lambda kv: -(kv[1]['diff'] / max(kv[1]['n'], 1)))[:8]
print()
print('  the worst pairs by side disagreement rate:')
for p, c in worst:
    print(f'    {p:<18} n={c["n"]:<4} agree={c["ok"]:<4} differ={c["diff"]:<4} extra={c["extra"]:<4} '
          f'disagree={c["diff"]/max(c["n"],1)*100:.1f}%')
