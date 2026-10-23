#!/usr/bin/env python3
"""
THE FIDELITY GATE — does the reconstructed tape reproduce the tape the
COLLECTOR ACTUALLY RECORDED?

WHY THIS GATE EXISTS
---------------------
The whole study is "the SAME signal, a DIFFERENT ticket". If the signal
were a reconstruction that differs from what the machine really trades,
the answer would be about a different signal than the machine's.

The collector wrote tapeVratio / tapeOffHighPct / tapeOffLowPct /
tapeAtrPct / tapeSide for every row it took, on KuCoin, at 5-minute
intervals. The 1-hour bars from the same venue's public endpoint, over
the same window, must reproduce those numbers.

The collector's own rows are read from ~/.hermes/cache/scratch/
confluence.ndjson. The bar cache is read from the geo2 directory.
Nothing else is touched, and the account is never read.
"""
import os, sys, json, math, collections
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (fade_metrics, tape_side, load_venue, utc, HOUR_MS)

# The scratch directory. This used to point at the RESEARCH FOLDER —
# the script's own parent — so it looked for confluence.ndjson next to
# itself and raised FileNotFoundError on every run. Every other script
# in this tree resolves the real scratch; core.py already has the
# right constant, so the fix is to USE it rather than to have a second
# definition that drifts.
SCRATCH = os.path.join(os.path.expanduser("~"), ".hermes/cache/scratch")
CONFLUENCE = os.path.join(SCRATCH, "confluence.ndjson")
VENUE = os.environ.get("VENUE", "kc")


def main():
    print("=" * 100)
    print("THE FIDELITY GATE — the reconstructed tape vs the collector's OWN recorded tape")
    print("=" * 100)
    bars1h, _ = load_venue(VENUE)
    rows = [json.loads(l) for l in open(CONFLUENCE) if l.strip()]
    print(f"collector rows: {len(rows)}   symbols with 1h bars: {len(bars1h)}")

    # the tape at a wall-clock ts, over the last 24 x 1h bars
    errs = collections.defaultdict(list)
    side_ok = side_diff = extra = 0
    n = 0
    per_pair = collections.defaultdict(collections.Counter)
    for r in rows:
        bb = bars1h.get(r['pair'])
        if bb is None:
            continue
        ts = r['ts']
        # the bar whose t <= ts is the FORMING bar
        i = int(np.searchsorted(bb.t, ts, side='right')) - 1
        if i < 23:
            continue
        m = fade_metrics(bb.c[i - 23:i + 1], bb.v[i - 23:i + 1],
                         bb.h[i - 23:i + 1], bb.l[i - 23:i + 1])
        if m is None:
            continue
        n += 1
        for k in ('vratio', 'offHighPct', 'offLowPct', 'atrPct'):
            got = m[k]
            want = r.get('tape' + k[0].upper() + k[1:])
            if want is None or got is None:
                continue
            errs[k].append(abs(got - want))
        rs = tape_side(m)
        want_side = r.get('tapeSide')
        per_pair[r['pair']]['n'] += 1
        if rs == want_side:
            side_ok += 1; per_pair[r['pair']]['ok'] += 1
        elif want_side is None:
            extra += 1; per_pair[r['pair']]['extra'] += 1
        else:
            side_diff += 1; per_pair[r['pair']]['diff'] += 1

    print(f"collector rows compared: {n}")
    print("\n  metric          n      median|err|     p90|err|     max|err|")
    print("  " + "-" * 62)
    for k in ('vratio', 'offHighPct', 'offLowPct', 'atrPct'):
        e = sorted(errs[k])
        if not e:
            continue
        print(f"  {k:<14} {len(e):<6} {e[len(e)//2]:>12.4f} {e[int(len(e)*0.9)]:>12.4f} {e[-1]:>12.4f}")
    print(f"\n  side AGREES with the collector:                        {side_ok}/{n} ({side_ok/max(1,n)*100:.2f}%)")
    print(f"  side DIFFERS (the collector had a side):               {side_diff}/{n} ({side_diff/max(1,n)*100:.2f}%)")
    print(f"  the reconstruction found a side, the collector had none: {extra}/{n} ({extra/max(1,n)*100:.2f}%)")
    worst = sorted(per_pair.items(), key=lambda kv: -(kv[1]['diff'] / max(1, kv[1]['n'])))[:8]
    print("\n  the worst pairs by side disagreement:")
    for p, c in worst:
        print(f"    {p:<18} n={c['n']:<4} agree={c['ok']:<4} differ={c['diff']:<4} extra={c['extra']:<4} "
              f"disagree={c['diff']/max(1,c['n'])*100:.1f}%")
    return 0


if __name__ == '__main__':
    sys.exit(main())
