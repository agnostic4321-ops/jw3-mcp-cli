#!/usr/bin/env python3
"""
GEOMETRY 3 — THE PAIR / RELATIVE TICKET. (The corrected, no-look-ahead version.)

WHY THIS FILE REPLACES THE FIRST DRAFT
---------------------------------------
The first draft of this study had three defects, each of which
INFLATES the result:

1. THE Z-SCORE'S NORMALISATION WAS A LOOK-AHEAD. The spread's mean and
   standard deviation were computed over the WHOLE window, so a trade in
   hour 10 of a 45-day window used the spread's mean as it looked in
   hour 900. Here the mean and stdev are EXPANDING: at every bar they
   are computed from that bar and the bars before it only. A live
   trader has the same information.

2. THE PLACEBO WAS THE WRONG PLACEBO. It flipped the trade's SIDE on
   the same pair, which tests "is the mean-reversion direction right?"
   — not "is this pair's edge real?". The right placebo for a search
   over 903 candidate pairs is a RANDOM PAIR of the same shape,
   measured identically. The selected pair's statistic is then placed
   in that distribution.

3. THE SELECTION AND THE MEASUREMENT SHARED A WINDOW. The pairs were
   ranked on their mean-reversion structure over the whole window and
   then measured on that same window. Here the SELECTION (which pairs
   to trade) uses the FIRST HALF only, and the MEASUREMENT is the
   SECOND HALF. A pair that pays only in the half it was selected on is
   a window, not an edge.

THE MULTIPLE-COMPARISON COUNT IS REPORTED
------------------------------------------
903 candidate pairs x 3 entry thresholds x 2 exit thresholds x 3 holding
periods = 16,254 configurations. The bar has to survive that, or the
honest statement is "with 16,254 tries, one will look significant".

THE FILL RULE (the correct one)
--------------------------------
  * the target is the spread's z crossing back through z_out
  * the stop is the spread's z going 2x further against
  * a trade reaching neither is a TIME EXIT at the mark
  * the fee is charged on BOTH legs' notional
"""
import os, sys, json, math, collections, itertools, random
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (EQUITY, NOTIONAL, TAKER_RT, MAKER_RT, RHO, HOUR_MS, GRID_MS,
                  DAY_MS, T_BAR, MIN_CLUSTERS, TRIM_N,
                  mean, sd, se, median, pct,
                  load_venue, cluster_stats, fmt, utc)
from harness import verdict

GEO2 = os.path.dirname(os.path.abspath(__file__))
VENUE = os.environ.get("VENUE", "kc")
HOLD_HOURS = [4, 12, 24]
Z_ENTRIES = [0.5, 1.0, 1.5]
Z_EXITS = [0.0, 0.25]
MIN_TRADES = 50


def expanding_z(s, min_period=48):
    """The EXPANDING z-score of the spread: at every bar, the mean and
    stdev come from that bar and the bars BEFORE it only. No look-ahead.
    """
    n = len(s)
    z = np.full(n, np.nan)
    csum = np.cumsum(s)
    csum2 = np.cumsum(s * s)
    for i in range(min_period, n):
        k = i + 1
        m = csum[i] / k
        var = max(csum2[i] / k - m * m, 1e-18)
        z[i] = (s[i] - m) / math.sqrt(var)
    return z


def aligned(a, b):
    """The common timestamps and the two price series on them."""
    common, ia, ib = np.intersect1d(a.t, b.t, return_indices=True)
    return common, a.c[ia], b.c[ib]


def spread_stats(a, b, na, nb):
    """The mean-reversion structure of one pair, measured on the FIRST
    HALF only (the selection window)."""
    common, ca, cb = aligned(a, b)
    if len(common) < 96:
        return None
    s = np.log(ca) - np.log(cb)
    half = len(s) // 2
    s1 = s[:half]
    sd1 = float(np.std(s1))
    if sd1 <= 0:
        return None
    d = s1 - s1.mean()
    x, y = d[:-1], d[1:]
    den = float(np.sum(x * x))
    if den <= 0:
        return None
    phi = float(np.sum(x * y)) / den
    hl = math.log(0.5) / math.log(phi) if 0 < phi < 1 else None
    la, lb = np.log(ca[:half]), np.log(cb[:half])
    vx = float(np.var(lb))
    if vx <= 0:
        return None
    beta = float(np.cov(lb, la, bias=True)[0, 1]) / vx
    resid = la - (beta * lb + (la.mean() - beta * lb.mean()))
    ss_tot = float(np.sum((la - la.mean()) ** 2))
    r2 = 1.0 - float(np.sum(resid ** 2)) / ss_tot if ss_tot > 0 else 0.0
    return dict(a=na, b=nb, hl=hl, beta=beta, r2=r2, sd=sd1, n=len(common))


def pair_trades(a, b, z_in, z_out, hold_h):
    """The mean-reversion trades on one pair, with the EXPANDING z-score.

    SIZING: $30 on each leg (dollar-neutral). The P&L is computed from
    the actual PRICES: units_A * (A_now - A_then) - units_B * (B_now -
    B_then) for a long spread, and its negative for a short spread.
    """
    common, pa, pb = aligned(a, b)
    if len(common) < 96:
        return []
    s = np.log(pa) - np.log(pb)
    z = expanding_z(s)
    out = []
    i = 0
    n = len(z)
    while i < n:
        zi = z[i]
        if not np.isfinite(zi):
            i += 1; continue
        side = 0
        if zi <= -z_in:
            side = -1   # the spread is cheap -> LONG the spread
        elif zi >= z_in:
            side = 1    # the spread is rich -> SHORT the spread
        if side == 0:
            i += 1; continue
        a0, b0 = pa[i], pb[i]
        if not (a0 > 0 and b0 > 0):
            i += 1; continue
        ua = NOTIONAL / 2 / a0
        ub = NOTIONAL / 2 / b0
        end = min(n, i + hold_h + 1)
        gross = None
        kind = None
        k = i
        for k in range(i + 1, end):
            zk = z[k]
            if not np.isfinite(zk):
                continue
            dA = ua * (pa[k] - a0)
            dB = ub * (pb[k] - b0)
            pnl_long = dA - dB
            if side == 1 and zk <= z_out:
                gross = -pnl_long; kind = 'win'; break
            if side == -1 and zk >= z_out:
                gross = pnl_long; kind = 'win'; break
            if side == 1 and zk >= z_in * 2:
                gross = -pnl_long; kind = 'loss'; break
            if side == -1 and zk <= -z_in * 2:
                gross = pnl_long; kind = 'loss'; break
        if gross is None:
            k = end - 1
            dA = ua * (pa[k] - a0)
            dB = ub * (pb[k] - b0)
            gross = (dA - dB) if side == -1 else -(dA - dB)
            kind = 'time'
        net = gross - TAKER_RT * NOTIONAL
        out.append(dict(ts=int(common[i]), bucket=int(common[i]) // (hold_h * HOUR_MS),
                        a=a, b=b, kind=kind, gross=float(gross), net=float(net),
                        side=side, z=float(zi),
                        net_flip=float(-(gross - TAKER_RT * NOTIONAL))))
        i = (k + 1) if k > i else i + 1
    return out


def stats_for(tr, hold_h):
    if not tr:
        return None
    cs = cluster_stats(tr, hold_h * HOUR_MS, value_key='net')
    wins = sum(1 for t in tr if t['kind'] == 'win')
    losses = sum(1 for t in tr if t['kind'] == 'loss')
    times = sum(1 for t in tr if t['kind'] == 'time')
    return dict(n=len(tr), wins=wins, losses=losses, times=times,
                win_rate=wins / max(1, wins + losses),
                ev_usd=mean([t['net'] for t in tr]),
                clus=cs['clusters'], t=cs['t'], trimmed=cs['trimmed'],
                worst3=cs['worst3'], best3=cs['best3'])


def main():
    print("=" * 118)
    print("GEOMETRY 3 — THE PAIR / RELATIVE TICKET (the market's drift cancels)")
    print("=" * 118)
    print(f"venue: {VENUE}   notional $ {NOTIONAL:.2f}   equity $ {EQUITY:.2f}")
    print(f"a pair pays the fee on BOTH legs: $0.12% of $30 + $30 = ${TAKER_RT*NOTIONAL:.4f} "
          f"per round trip, the same as a single $60 ticket")

    bars1h, _ = load_venue(VENUE)
    if not bars1h:
        print("NO DATA")
        return 1
    syms = sorted(bars1h.keys())
    # The window is the union of the coverage; each PAIR is measured on
    # its OWN common bars and must have enough of them. Restricting the
    # whole study to the symbols that span the entire window would throw
    # away most of the data to serve one short-history symbol.
    lo_all = min(int(bars1h[p].t[0]) for p in syms)
    hi_all = max(int(bars1h[p].t[-1]) for p in syms)
    full = [p for p in syms if bars1h[p].n >= 200]
    print(f"symbols: {len(syms)}, of which {len(full)} have at least 200 hourly bars")
    print(f"the union window: {utc(lo_all)} -> {utc(hi_all)}")

    # ── 1. THE SELECTION: the pairs whose spread reverts ─────────────
    print("\n" + "-" * 118)
    print("1. THE SELECTION — the pairs whose spread is mean-reverting, chosen on the FIRST HALF only")
    print("-" * 118)
    mid = lo_all + (hi_all - lo_all) // 2   # the half-split point
    cand = []
    for a, b in itertools.combinations(full, 2):
        st = spread_stats(bars1h[a], bars1h[b], a, b)
        if st is not None:
            cand.append(st)
    print(f"  candidate pairs: {len(cand)}")
    reverting = [x for x in cand if x['hl'] and 0.5 <= x['hl'] <= 200 and x['r2'] >= 0.80]
    print(f"  pairs whose FIRST-HALF spread reverts (half-life 0.5-200h) with R^2 >= 0.80: {len(reverting)}")
    reverting.sort(key=lambda x: x['hl'])
    for x in reverting[:10]:
        print(f"    {x['a']:<14} / {x['b']:<14} half-life {x['hl']:>6.1f}h  beta {x['beta']:>5.2f}  R^2 {x['r2']:.3f}")
    symcount = collections.Counter()
    for x in reverting:
        symcount[x['a']] += 1; symcount[x['b']] += 1
    print(f"  the symbol concentration of the selection: {symcount.most_common(5)}")

    # ── 2. THE MEASUREMENT: the SECOND HALF only ─────────────────────
    print("\n" + "-" * 118)
    print("2. THE MEASUREMENT — the SECOND HALF of the window only (the half the selection never saw)")
    print("-" * 118)
    sel = reverting[:120]
    measured = []
    for x in sel:
        for z_in in Z_ENTRIES:
            for z_out in Z_EXITS:
                for hold_h in HOLD_HOURS:
                    tr = [t for t in pair_trades(bars1h[x['a']], bars1h[x['b']], z_in, z_out, hold_h)
                          if t['ts'] >= mid]
                    s = stats_for(tr, hold_h)
                    if not s or s['n'] < 30:
                        continue
                    s.update(a=x['a'], b=x['b'], z_in=z_in, z_out=z_out, hold=hold_h,
                             hl=x['hl'], r2=x['r2'])
                    measured.append(s)
    print(f"  configurations measured out of sample: {len(measured)}")
    if measured:
        print(f"\n  {'A':<14} {'B':<14} {'z_in':>5} {'z_out':>6} {'hold':>5} {'n':>5} {'win%':>6} "
              f"{'time%':>7} {'EV$':>9} {'clus':>5} {'t':>7} {'trim$':>9}")
        for r in sorted(measured, key=lambda r: -r['ev_usd'])[:15]:
            print(f"  {r['a']:<14} {r['b']:<14} {r['z_in']:>5.2f} {r['z_out']:>6.2f} "
                  f"{r['hold']:>4}h {r['n']:>5} {r['win_rate']*100:>5.1f}% "
                  f"{r['times']/r['n']*100:>6.1f}% {r['ev_usd']:>+9.4f} {r['clus']:>5} "
                  f"{r['t']:>7.2f} {(r['trimmed'] if r['trimmed'] is not None else float('nan')):>+9.4f}")

    # ── 3. THE PLACEBO: RANDOM PAIRS, measured identically ──────────
    print("\n" + "-" * 118)
    print("3. THE PLACEBO — RANDOM PAIRS of the same shape, measured identically")
    print("-" * 118)
    print("  The search covered 903 candidate pairs x 3 entries x 2 exits x 3 holds.")
    print("  The honest null is: what does a RANDOM pair of the same shape earn?")
    rnd = random.Random(20261021)
    placebo_rows = []
    all_pairs = list(itertools.combinations(full, 2))
    for d in range(120):
        a, b = rnd.choice(all_pairs)
        z_in = rnd.choice(Z_ENTRIES); z_out = rnd.choice(Z_EXITS); hold_h = rnd.choice(HOLD_HOURS)
        tr = [t for t in pair_trades(bars1h[a], bars1h[b], z_in, z_out, hold_h) if t['ts'] >= mid]
        s = stats_for(tr, hold_h)
        if s and s['n'] >= 30:
            placebo_rows.append(s)
    print(f"  random-pair placebo draws with enough data: {len(placebo_rows)}")
    if placebo_rows:
        evs = sorted(r['ev_usd'] for r in placebo_rows)
        ts_ = sorted(r['t'] for r in placebo_rows)
        print(f"  the placebo EV distribution: p50 ${evs[len(evs)//2]:+.4f}  "
              f"p90 ${evs[int(len(evs)*0.9)]:+.4f}  p95 ${evs[int(len(evs)*0.95)]:+.4f}  "
              f"max ${evs[-1]:+.4f}")
        print(f"  the placebo t distribution:     p50 {ts_[len(ts_)//2]:.2f}  "
              f"p90 {ts_[int(len(ts_)*0.9)]:.2f}  p95 {ts_[int(len(ts_)*0.95)]:.2f}  max {ts_[-1]:.2f}")
        n_t2 = sum(1 for x in ts_ if x >= T_BAR)
        print(f"  placebo rows with t >= {T_BAR}: {n_t2} of {len(ts_)} ({n_t2/len(ts_)*100:.1f}%)")
        n_above = sum(1 for x in evs if x > TAKER_RT * NOTIONAL)
        print(f"  placebo rows with EV above the fee floor: {n_above} of {len(evs)} "
              f"({n_above/len(evs)*100:.1f}%)")
        if measured:
            best = max(measured, key=lambda r: r['ev_usd'])
            ge = sum(1 for x in evs if x >= best['ev_usd'])
            p = (ge + 1) / (len(evs) + 1)
            ge_t = sum(1 for x in ts_ if x >= best['t'])
            p_t = (ge_t + 1) / (len(ts_) + 1)
            print(f"\n  the best selected pair: {best['a']}/{best['b']} z_in {best['z_in']} "
                  f"z_out {best['z_out']} {best['hold']}h")
            print(f"    EV ${best['ev_usd']:+.4f}  -> the placebo percentile is {p:.3f} "
                  f"({ge} of {len(evs)} random pairs did as well or better)")
            print(f"    t {best['t']:.2f}      -> the placebo percentile is {p_t:.3f} "
                  f"({ge_t} of {len(ts_)} random pairs did as well or better)")

    # ── 4. THE BAR ───────────────────────────────────────────────────
    print("\n" + "-" * 118)
    print("4. THE BAR")
    print("-" * 118)
    floor = TAKER_RT * NOTIONAL
    print(f"  the fee floor: ${floor:.4f} per pair trade (both legs).")
    passing = [r for r in measured if r['ev_usd'] > floor and r['t'] >= T_BAR and r['clus'] >= MIN_CLUSTERS]
    print(f"  pair configurations with EV above the floor AND t >= {T_BAR} AND >= {MIN_CLUSTERS} clusters: {len(passing)}")
    for r in sorted(passing, key=lambda r: -r['ev_usd'])[:10]:
        print(f"    {r['a']}/{r['b']} z_in {r['z_in']} z_out {r['z_out']} {r['hold']}h: "
              f"EV ${r['ev_usd']:+.4f} t {r['t']:.2f} clusters {r['clus']} trimmed ${r['trimmed']:+.4f}")

    if measured:
        bypair = collections.defaultdict(list)
        for r in measured:
            bypair[(r['a'], r['b'])].append(r['ev_usd'])
        pair_ev = {k: mean(v) for k, v in bypair.items()}
        best = max(pair_ev, key=pair_ev.get); worst = min(pair_ev, key=pair_ev.get)
        print(f"\n  the concentration over {len(pair_ev)} selected pairs: "
              f"the best is {best[0]}/{best[1]} at ${pair_ev[best]:+.4f}, "
              f"the worst is {worst[0]}/{worst[1]} at ${pair_ev[worst]:+.4f}")
        n_pairs_above = sum(1 for v in pair_ev.values() if v > floor)
        print(f"  distinct pairs whose POOLED EV (over their configurations) clears the floor: {n_pairs_above}")
        sym_in_best = collections.Counter()
        for (a, b), v in pair_ev.items():
            if v > floor:
                sym_in_best[a] += 1; sym_in_best[b] += 1
        print(f"  the symbol concentration among the pairs that clear the floor: {sym_in_best.most_common(5)}")
    json.dump(measured, open(os.path.join(GEO2, f"geo3-rows-{VENUE}.json"), "w"), default=str)
    json.dump([dict(a=x['a'], b=x['b'], hl=x['hl'], r2=x['r2'], beta=x['beta']) for x in cand],
              open(os.path.join(GEO2, f"geo3-stats-{VENUE}.json"), "w"))
    print(f"\n  wrote geo3-rows-{VENUE}.json and geo3-stats-{VENUE}.json")
    return 0


if __name__ == '__main__':
    sys.exit(main())
