#!/usr/bin/env python3
"""
THE SELF-CHECK — the guards that catch the mistakes this study actually
made, so a reader can trust the numbers.

The bugs it catches (all found the hard way, in this session):
  B1  a binary search that narrows AWAY from the match -> a wrong entry
      price -> a 10.7% move on a 0.8%-ATR symbol
  B2  an entry taken from a bar that had not CLOSED yet -> look-ahead
  B3  a time exit booked at the wrong bar
  B4  the ticket formula drifting from the live path
  B5  a fee applied as a fraction instead of on the notional
"""
import json, os, sys, bisect, math, collections
from os.path import join, expanduser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uni_ticket import plan, resolve

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
FAIL = []


def check(name, cond, detail=''):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  {detail}" if detail else ''))
    if not cond: FAIL.append(name)


print('=' * 100)
print('THE SELF-CHECK')
print('=' * 100)

bars = json.load(open(os.path.join(SCRATCH, 'fee-floor-15m-bars.json')))
p = '10000REKT/USDT'
b15 = sorted(bars[p], key=lambda x: x['t'])
ts = 1792558800000   # 2026-10-21 05:00

print('\nB1 — THE ENTRY LOOKUP')
cut = ts - 900_000
k_bisect = bisect.bisect_right([x['t'] for x in b15], cut) - 1
# the buggy search, for comparison
lo, hi, k_bug = 0, len(b15) - 1, None
while lo <= hi:
    mid = (lo + hi) >> 1
    if b15[mid]['t'] <= cut: k_bug = mid; hi = mid - 1
    else: lo = mid + 1
check('the binary search finds the LAST bar at or before the cut',
      b15[k_bisect]['t'] <= cut < b15[k_bisect + 1]['t'],
      f'idx={k_bisect} t={b15[k_bisect]["t"]}')
check('the buggy search is caught (it lands on bar 0)',
      k_bug == 0 and k_bisect != 0, f'buggy idx={k_bug} correct idx={k_bisect}')

print('\nB2 — NO LOOK-AHEAD IN THE ENTRY')
entry_bar = b15[k_bisect]
check('the entry bar CLOSED before the signal',
      entry_bar['t'] + 900_000 <= ts,
      f"bar closes at {entry_bar['t']+900_000} <= {ts}")
# the bar CONTAINING ts
k_containing = bisect.bisect_right([x['t'] for x in b15], ts) - 1
check('the containing bar WOULD have been look-ahead',
      b15[k_containing]['t'] + 900_000 > ts,
      f"containing bar closes at {b15[k_containing]['t']+900_000} > {ts}")

print('\nB3 — THE TIME EXIT IS BOOKED AT THE RIGHT BAR')
tk = plan(0.9916, 'short')
market = entry_bar['c']
out = resolve(b15, ts, market, tk, 'short')
kind, mv, held, how = out
start = bisect.bisect_right([x['t'] for x in b15], ts)
end = min(len(b15), start + 16)
last_bar = b15[end - 1]
expect = (market - last_bar['c']) / market
check('the time-exit move matches the horizon bar',
      abs(mv - expect) < 1e-12, f'move={mv:.8f} expected={expect:.8f}')
check('the time exit is bounded by the symbol\'s own volatility',
      abs(mv) < 0.05, f'|move|={abs(mv)*100:.3f}% (a 0.99% ATR symbol over 4h)')
check('the horizon is 16 x 15m = 240 minutes',
      last_bar['t'] - ts <= 16 * 900_000, f"{last_bar['t']-ts}ms")

print('\nB4 — THE TICKET MATCHES THE LIVE PATH')
rows = [json.loads(l) for l in open(os.path.join(SCRATCH, 'trade-loop.ndjson')) if l.strip()]
fired = [r for r in rows if r.get('event') == 'FIRED']
maxerr = 0.0
for r in fired:
    c = r['ticket']['candidate']
    tk2 = plan(c['atrPct'], r['side'])
    # The candidate's entryPrice IS plan.avgEntry. So the MARKET price
    # (`last`) is avgEntry / avgEntry_rel, and every other price follows.
    market = c['entryPrice'] / tk2['avg_entry_rel']
    my_tp = market * tk2['tp_rel']
    my_sl = market * tk2['kill_rel']
    real_tp = c['targetPrice']; real_sl = c['stopPrice']
    maxerr = max(maxerr, abs(my_tp - real_tp) / real_tp, abs(my_sl - real_sl) / real_sl)
check('the plan reproduces the live tickets\' prices', maxerr < 1e-9,
      f'max rel err = {maxerr*100:.8f}% of the level (ZERO expected)')

print('\nB5 — THE FEE IS ON THE NOTIONAL')
from uni_core import NOTIONAL, TAKER_RT, EQUITY
check('the round-trip fee is 0.12% of the notional',
      abs(TAKER_RT - 0.0012) < 1e-12, f'{TAKER_RT}')
check('the fee in dollars is $0.0720 on a $60 ticket',
      abs(TAKER_RT * NOTIONAL - 0.072) < 1e-9, f'${TAKER_RT*NOTIONAL:.4f}')
check('the fee is 40% of the $0.18 gross win',
      abs((TAKER_RT * NOTIONAL) / 0.18 - 0.40) < 0.001,
      f'{(TAKER_RT*NOTIONAL)/0.18*100:.1f}%')
check('the break-even win rate at TP 0.48% / SL 1.6114% is 82.8%',
      abs((0.016114 + TAKER_RT) / (0.0048 + 0.016114) - 0.8279) < 0.001,
      f"{(0.016114+TAKER_RT)/(0.0048+0.016114)*100:.2f}%")

print('\nB6 — THE WRONG-SIDE DEFECT IS DETECTED')
tk3 = plan(1.2, 'short')
check('a short at ATR 1.2% has a wrong-sided take-profit',
      tk3['wrong_side'], f"target is {tk3['tp_vs_market_pct']:+.4f}% vs the market")
tk4 = plan(1.2, 'long')
check('the LONG side has the opposite defect (target below the market)',
      tk4['wrong_side'], f"target is {tk4['tp_vs_market_pct']:+.4f}% vs the market")

print('\nB7 — THE CORRECTED TICKET PUTS THE TARGET ON THE FAVOURABLE SIDE')
from uni_ticket import resolve_corrected
# a synthetic bar set that moves DOWN, so a short's take-profit is hit
synth = [dict(t=1000 * 900_000 + i * 900_000, h=100.0, l=100.0, c=100.0) for i in range(40)]
for i in range(1, 20):
    synth[i] = dict(t=synth[i]['t'], h=100.0, l=99.0, c=99.5)   # a drop
mkt = 100.0
tk_s = plan(1.0, 'short')
out_s = resolve_corrected(synth, synth[0]['t'] + 1000, mkt, tk_s, 'short')
check('a short whose price drops books a POSITIVE win',
      out_s and out_s[0] == 'win' and out_s[1] > 0,
      f'{out_s[:2] if out_s else None}')
synth_up = [dict(t=1000 * 900_000 + i * 900_000, h=100.0, l=100.0, c=100.0) for i in range(40)]
for i in range(1, 20):
    synth_up[i] = dict(t=synth_up[i]['t'], h=101.0, l=100.0, c=100.5)   # a rise
tk_l = plan(1.0, 'long')
out_l = resolve_corrected(synth_up, synth_up[0]['t'] + 1000, mkt, tk_l, 'long')
check('a long whose price rises books a POSITIVE win',
      out_l and out_l[0] == 'win' and out_l[1] > 0,
      f'{out_l[:2] if out_l else None}')
# and the stop books a negative
synth_up2 = [dict(t=1000 * 900_000 + i * 900_000, h=100.0, l=100.0, c=100.0) for i in range(40)]
for i in range(1, 20):
    synth_up2[i] = dict(t=synth_up2[i]['t'], h=103.0, l=100.0, c=102.0)   # a big rise: the short stops out
out_s2 = resolve_corrected(synth_up2, synth_up2[0]['t'] + 1000, mkt, tk_s, 'short')
check('a short whose price rises books a NEGATIVE loss',
      out_s2 and out_s2[0] == 'loss' and out_s2[1] < 0,
      f'{out_s2[:2] if out_s2 else None}')

print('\nB8 — THE POST-FIX ARM DROPS THE WRONG-SIDED TAKE-PROFIT')
from uni_ticket import resolve as resolve_ship
out_pre = resolve_ship(synth, synth[0]['t'] + 1000, mkt, tk_s, 'short', drop_wrong_side=False)
out_post = resolve_ship(synth, synth[0]['t'] + 1000, mkt, tk_s, 'short', drop_wrong_side=True)
check('PRE-FIX books the (already-satisfied) take-profit',
      out_pre and out_pre[0] == 'win', f'{out_pre[:2] if out_pre else None}')
check('POST-FIX does not', out_post and out_post[0] != 'win',
      f'{out_post[:2] if out_post else None}')

print('\n' + '=' * 100)
print(f'{len(FAIL)} FAILURES' if FAIL else 'ALL CHECKS PASS')
print('=' * 100)
sys.exit(1 if FAIL else 0)
