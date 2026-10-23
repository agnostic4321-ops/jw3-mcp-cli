#!/usr/bin/env python3
"""
THE FIDELITY GATE — does this study measure the SAME trade the repo's
published scripts measure?

WHY THIS FILE EXISTS
--------------------
The policy study introduces a third ticket geometry (the one `planScalp`
builds TODAY) alongside the two the repo has already published. A new
geometry that is not anchored to the old ones is a new claim, not a
measurement, so this file pins the engine against the repo's OWN
scripts on the SAME data:

  A. test-scratch-artefact.mjs   the CORRECT fill rule, SHIPPED geometry
  B. test-fixed-ticket.mjs        the FIXED geometry (TP beyond the market)
  C. the scratch ARTEFACT itself  the ratio of scratches to wins, which is
                                  the project's headline finding

If this file's numbers do not reproduce the repo's, the engine is wrong
and every downstream number is wrong.
"""
import json
import os
import sys
from os.path import join, expanduser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import policy_core as pc
from policy_core import mean, cluster_stats, HOLD_MS, BUCKET_MS, SHIPPED, FIXED, LIVE

SCRATCH = pc.SCRATCH
CONFLUENCE = join(SCRATCH, 'confluence.ndjson')
BAR_CACHE = join(SCRATCH, 'fee-floor-15m-bars.json')


def main():
    rows = pc.read_rows(CONFLUENCE)
    pc.BARS = pc.read_bars(BAR_CACHE)
    tape = [r for r in rows if r.get('tapeSide')]
    live = [r for r in tape if pc.live_gate_side(r) == r['tapeSide']]
    print('=' * 110)
    print('THE FIDELITY GATE — this engine vs the repo\'s own published scripts')
    print('=' * 110)
    print(f'  rows {len(rows)} | tape arm {len(tape)} | live-gate arm {len(live)}')
    print()

    fails = 0

    def check(name, got, want, tol, unit=''):
        nonlocal fails
        ok = abs(got - want) <= tol
        if not ok:
            fails += 1
        print(f'  [{"PASS" if ok else "FAIL"}] {name:<52} got {got:>10.4f}{unit}  '
              f'want {want:>10.4f}{unit}  (tol {tol})')

    # ── A. the SHIPPED geometry under the CORRECT fill rule ─────────────
    # The repo's test-scratch-artefact.mjs reports the "correct" row as:
    #   n, win%, scratch%, loss%, time%, EV %eq, se, t
    # at the collector's 5-minute cluster width.
    tr = pc.simulate(live, SHIPPED)
    n = len(tr)
    wins = sum(1 for t in tr if t['kind'] == 'win')
    scr = sum(1 for t in tr if t['kind'] == 'scratch')
    loss = sum(1 for t in tr if t['kind'] == 'loss')
    tim = sum(1 for t in tr if t['kind'] == 'time')
    cs5 = cluster_stats(tr, BUCKET_MS)
    print('  A. THE SHIPPED GEOMETRY, CORRECT FILL RULE (the repo\'s "correct" row)')
    print(f'     n {n} | win {wins} | scratch {scr} | loss {loss} | time {tim}')
    check('shipped/correct: win rate %', wins / n * 100, 17.8, 6.0, '%')
    check('shipped/correct: scratch rate %', scr / n * 100, 75.6, 12.0, '%')
    check('shipped/correct: EV %eq (5-min clusters)', cs5['ev'], -0.3311, 0.10, '%')
    check('shipped/correct: t (5-min clusters)', cs5['t'], -2.2076, 0.9)

    # ── B. the FIXED geometry ────────────────────────────────────────────
    # The repo's test-fixed-ticket.mjs, FIXED row, live-gate arm, at 5 min:
    #   n 45 | win 38 | scratch 0 | loss 5 | time 2
    #   EV -0.1463 %eq, se 0.1928, t -0.7589
    trf = pc.simulate(live, FIXED)
    n = len(trf)
    wins = sum(1 for t in trf if t['kind'] == 'win')
    scr = sum(1 for t in trf if t['kind'] == 'scratch')
    loss = sum(1 for t in trf if t['kind'] == 'loss')
    tim = sum(1 for t in trf if t['kind'] == 'time')
    cs5f = cluster_stats(trf, BUCKET_MS)
    print()
    print('  B. THE FIXED GEOMETRY (the repo\'s "FIXED" row)')
    print(f'     n {n} | win {wins} | scratch {scr} | loss {loss} | time {tim}')
    check('fixed: win count', wins, 38, 4)
    check('fixed: scratch count', scr, 0, 1)
    check('fixed: EV %eq (5-min clusters)', cs5f['ev'], -0.1463, 0.12, '%')
    check('fixed: t (5-min clusters)', cs5f['t'], -0.7589, 0.8)

    # ── C. the scratch ARTEFACT ─────────────────────────────────────────
    # The repo's headline: on the SHIPPED geometry, most trades are
    # scratches; on the TAPE arm it is 74.4%.
    trt = pc.simulate(tape, SHIPPED)
    nt = len(trt)
    sct = sum(1 for t in trt if t['kind'] == 'scratch')
    cst = cluster_stats(trt, BUCKET_MS)
    print()
    print('  C. THE SCRATCH ARTEFACT (the project\'s headline finding)')
    print(f'     tape arm n {nt} | scratches {sct} ({sct/nt*100:.1f}%)')
    check('tape/correct: scratch rate %', sct / nt * 100, 74.4, 12.0, '%')
    check('tape/correct: EV %eq (5-min clusters)', cst['ev'], -0.1855, 0.12, '%')

    # ── D. the THIRD geometry (what the code runs today) ────────────────
    trl = pc.simulate(live, LIVE)
    nl = len(trl)
    w = sum(1 for t in trl if t['kind'] == 'win')
    l = sum(1 for t in trl if t['kind'] == 'loss')
    t_ = sum(1 for t in trl if t['kind'] == 'time')
    print()
    print('  D. THE LIVE GEOMETRY (planScalp as it stands today) — NOT in the repo yet')
    print(f'     n {nl} | win {w} | loss {l} | time {t_} | scratches '
          f'{sum(1 for t in trl if t["kind"]=="scratch")}')
    print(f'     NOTE: the take-profit is derived from the MARKET, so it can never be a')
    print(f'     scratch — which is exactly the fix the project shipped. The stop is')
    print(f'     2 x stepDrop from the market, so it is 1.2%-3.0% away.')

    print()
    print('=' * 110)
    print(f'  FIDELITY GATE: {"PASSED" if fails == 0 else f"FAILED ({fails} checks)"}')
    print('=' * 110)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
