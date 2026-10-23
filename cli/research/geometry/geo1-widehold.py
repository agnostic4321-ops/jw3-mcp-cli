#!/usr/bin/env python3
"""
GEOMETRY 1 — THE WIDE-TARGET, LONG-HOLD TICKET.

THE QUESTION
------------
The signal family is exhausted AT THE SCALPING TICKET GEOMETRY. But
the geometry is a choice. The scalping ticket's target is $0.18 of
gross (0.3% of $60) against a $0.0713 taker round trip — the fee is
40% of the gross win, and the break-even win rate is 82.8%.

A wide-target ticket changes the arithmetic:
  target 1-3% of $60 = $0.60 to $1.80 of gross
  fee $0.0713 = 4% to 12% of the gross
  hold 4-24 hours

WHAT IS MEASURED
----------------
1. THE MAXIMUM ADVERSE EXCURSION (MAE) DISTRIBUTION over 4h, 12h and
   24h, because the MAE decides the stop distance: a stop tighter than
   the MAE fires on noise, and a stop looser than the target makes the
   loss bigger than the win.
2. WHAT STOP DISTANCE KEEPS THE LOSS SMALLER THAN THE TARGET.
3. THE NET EXPECTANCY IN DOLLARS at $60 of notional over a grid of
   (target, stop, hold), under the CORRECT fill rule.
4. THE BAR: net EV above the fee floor, t >= 2 on cluster means at the
   ticket's own holding period, trim-stable, a size-matched placebo
   beside it, and the per-symbol concentration named.
"""
import os, sys, json, math, collections
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import (EQUITY, NOTIONAL, TAKER_RT, MAKER_RT, RHO, HOUR_MS, GRID_MS,
                  DAY_MS, T_BAR, MIN_CLUSTERS, TRIM_N,
                  mean, sd, se, median, pct, mulberry32,
                  load_venue, coverage_cut, tape_states, build_signals, resolve_many,
                  apply_single_position, cluster_stats, fmt, utc, MIN_COVERAGE_DAYS)
from harness import placebo_random_side, concentration, verdict

GEO2 = os.path.dirname(os.path.abspath(__file__))
VENUE = os.environ.get("VENUE", "kc")
RES = os.environ.get("RES", "15m")     # the resolution granularity
BAR_MIN = 15 if RES == "15m" else 60
# A symbol must cover this many days to stay in the study. The floor
# exists so that ONE short-history symbol cannot decide the window for
# all the others — without it, the window is the intersection and one
# 5-day symbol inside a 45-day set cuts the study to 3 days.
BARS_PER_HOUR = 60 // BAR_MIN

TP_FRACS = [0.010, 0.015, 0.020, 0.025, 0.030]
STOP_FRACS = [0.005, 0.0075, 0.010, 0.015, 0.020, 0.030]
HOLD_HOURS = [4, 12, 24]


def prepare(by_pair, bars):
    """The per-symbol arrays the vectorised resolution needs."""
    out = {}
    for p, ss in by_pair.items():
        bb = bars[p]
        idx = np.searchsorted(bb.t, np.array([x[1] for x in ss]), side='right')
        ok = idx < bb.n
        ss2 = [x for x, o in zip(ss, ok) if o]
        idx = idx[ok]
        out[p] = (bb, idx,
                  np.array([x[3] for x in ss2]),
                  np.array([x[2] == 'long' for x in ss2]),
                  np.array([x[1] for x in ss2]),
                  np.array([x[0] for x in ss2]))
    return out


def main():
    print("=" * 122)
    print("GEOMETRY 1 — THE WIDE-TARGET, LONG-HOLD TICKET (1-3% target, 4-24h hold)")
    print("=" * 122)
    print(f"venue: {VENUE}   resolution bars: {RES}   notional $ {NOTIONAL:.2f}   equity $ {EQUITY:.2f}")
    print(f"taker round trip {TAKER_RT*100:.2f}% = ${TAKER_RT*NOTIONAL:.4f}   "
          f"maker round trip {MAKER_RT*100:.2f}% = ${MAKER_RT*NOTIONAL:.4f}   "
          f"rho {RHO:.4f}")

    bars1h, bars15 = load_venue(VENUE)
    if not bars1h:
        print("NO 1h DATA")
        return 1
    res_bars = bars15 if (RES == "15m" and bars15) else bars1h
    common = sorted(set(bars1h) & set(res_bars))
    print(f"symbols: {len(bars1h)} (1h, volume) x {len(res_bars)} ({RES}) -> {len(common)} common")

    # THE WINDOW. The union of what the bars cover is what the data
    # supports; the INTERSECTION is what one short-history symbol
    # decides. A symbol with 5 days of history inside a 45-day set
    # collapses the intersection to 3 days and throws away 92% of the
    # sample — and, at a 24h hold, makes 30 clusters structurally
    # impossible, so every 24h row fails its own bar for a reason that
    # has nothing to do with the geometry.
    #
    # So the symbols that cannot cover the window are DROPPED, and the
    # coverage that survived is STATED — because a reader cannot
    # otherwise tell a narrow window from a wide one.
    kept, dropped, union_lo, union_hi = coverage_cut(
        bars1h, res_bars, common, MIN_COVERAGE_DAYS)
    union_days = (union_hi - union_lo) / DAY_MS
    print(f"window: {utc(union_lo)} -> {utc(union_hi)}  ({union_days:.1f} days)")
    print(f"symbols kept: {len(kept)} of {len(common)}"
          + (("   dropped for short history: "
              + ", ".join(f"{p} ({d:.1f}d)" for p, d in sorted(dropped, key=lambda x: x[1])))
             if dropped else ""))
    common = kept
    if len(common) < 10:
        print("TOO FEW SYMBOLS AFTER THE COVERAGE CUT")
        return 1

    states = tape_states({p: bars1h[p] for p in common})
    lo = max(int(bars1h[p].t[0]) for p in common) + 24 * HOUR_MS
    hi = min(int(res_bars[p].t[-1]) for p in common) - 24 * BARS_PER_HOUR * BAR_MIN * 60_000
    # The window the study ACTUALLY used — the one above is the union
    # before the coverage cut, so it can be much wider than this. A
    # reader must see the width the signals really span.
    print(f"the window used: {utc(lo)} -> {utc(hi)}  ({(hi - lo) / DAY_MS:.1f} days)")
    sigs = build_signals(states, res_bars, lo, hi, bar_minutes=BAR_MIN)
    sides = collections.Counter(s[2] for s in sigs)
    print(f"signals: {len(sigs)}  ({dict(sides)})  from {utc(sigs[0][1])} to {utc(sigs[-1][1])}")
    if len(sigs) < 200:
        print("TOO FEW SIGNALS")
        return 1

    by_pair = collections.defaultdict(list)
    for s in sigs:
        by_pair[s[0]].append(s)
    prepared = prepare(by_pair, res_bars)

    # ── 1. THE MAE DISTRIBUTION ──────────────────────────────────────
    print("\n" + "-" * 122)
    print("1. THE MAXIMUM ADVERSE EXCURSION — how far AGAINST the position it went")
    print("-" * 122)
    for hold_h in HOLD_HOURS:
        hold_bars = hold_h * BARS_PER_HOUR
        all_mae = []
        n_all = 0
        n_taken = 0
        for p, (bb, idx, entry, long, ts, pairs) in prepared.items():
            out, gross, mae, used = resolve_many(bb, idx, entry, long, 0.02, 0.02, hold_bars)
            taken = apply_single_position(ts, used, BAR_MIN * 60_000)
            n_all += len(out)
            n_taken += int(taken.sum())
            all_mae.extend(mae[taken].tolist())
        a = np.array(all_mae)
        print(f"\n  hold {hold_h}h   the MAE on the {n_taken} POSITIONS THE ACCOUNT COULD ACTUALLY HOLD "
              f"(of {n_all} signals; one position per symbol at a time)")
        print(f"    MAE %:  mean {a.mean()*100:.4f}  p50 {np.percentile(a,50)*100:.4f}  "
              f"p75 {np.percentile(a,75)*100:.4f}  p90 {np.percentile(a,90)*100:.4f}  "
              f"p95 {np.percentile(a,95)*100:.4f}  p99 {np.percentile(a,99)*100:.4f}  max {a.max()*100:.4f}")
        print(f"    MAE $ on $60: p50 ${np.percentile(a,50)*NOTIONAL:.4f}  "
              f"p90 ${np.percentile(a,90)*NOTIONAL:.4f}  p95 ${np.percentile(a,95)*NOTIONAL:.4f}  "
              f"max ${a.max()*NOTIONAL:.4f}")
        for tp in [0.01, 0.02, 0.03]:
            need90 = np.percentile(a, 90)
            need95 = np.percentile(a, 95)
            print(f"    vs a {tp*100:.1f}% target (${tp*NOTIONAL:.4f} gross): the p90 MAE is "
                  f"{need90*100:.3f}% (${need90*NOTIONAL:.4f}) and the p95 MAE is "
                  f"{need95*100:.3f}% (${need95*NOTIONAL:.4f});")
            print(f"       a stop at the p90 MAE is ${need90*NOTIONAL:.4f} — "
                  f"{'LARGER' if need90 > tp else 'smaller'} than the target's gross, so the "
                  f"R:R at p90 is 1:{tp/max(need90,1e-9):.2f}"
                  + (f" and at p95 1:{tp/max(need95,1e-9):.2f}" if need95 > 0 else ""))
    print()
    print("  READ: the MAE is the ticket's own risk budget. A stop must sit")
    print("  OUTSIDE the MAE's bulk or it fires on noise; and for the loss to")
    print("  stay under the target the stop must sit INSIDE the target. Both")
    print("  at once means: target > stop > p90(MAE). The table below is")
    print("  exactly that test.")

    # ── 2. THE GEOMETRY GRID ─────────────────────────────────────────
    print("\n" + "-" * 122)
    print("2. THE NET EXPECTANCY OF EVERY (target, stop, hold) — the CORRECT fill rule")
    print("-" * 122)
    floor = TAKER_RT * NOTIONAL
    rows = []
    for hold_h in HOLD_HOURS:
        hold_bars = hold_h * BARS_PER_HOUR
        # resolve every (target, stop) at once per symbol
        for tp in TP_FRACS:
            for stop in STOP_FRACS:
                if stop > tp:
                    continue
                trades = []
                ctrl = {}
                for p, (bb, idx, entry, long, ts, pairs) in prepared.items():
                    out, gross, mae, used = resolve_many(bb, idx, entry, long, tp, stop, hold_bars)
                    outf, grossf, _, _ = resolve_many(bb, idx, entry, ~long, tp, stop, hold_bars)
                    # THE ACCOUNT HOLDS ONE POSITION PER SYMBOL: a signal is
                    # taken only if no earlier position on this symbol is
                    # still open.
                    taken = apply_single_position(ts, used, BAR_MIN * 60_000)
                    net = (gross - TAKER_RT) * NOTIONAL
                    netf = (grossf - TAKER_RT) * NOTIONAL
                    for j in range(len(out)):
                        if not taken[j]:
                            continue
                        trades.append(dict(bucket=int(ts[j]) // (hold_h * HOUR_MS),
                                            ts=int(ts[j]), pair=p,
                                            side='long' if long[j] else 'short',
                                            out=int(out[j]), gross=float(gross[j]),
                                            net=float(net[j]), net_flip=float(netf[j]),
                                            mae=float(mae[j])))
                if len(trades) < 200:
                    continue
                cs = cluster_stats(trades, hold_h * HOUR_MS, value_key='net')
                wins = sum(1 for t in trades if t['out'] == 0)
                losses = sum(1 for t in trades if t['out'] == 1)
                times = sum(1 for t in trades if t['out'] == 2)
                ev_usd = mean([t['net'] for t in trades])
                # the EXCESS over the same symbol/timestamp with the side flipped
                ex = []
                for t in trades:
                    ex.append(dict(bucket=t['bucket'], ts=t['ts'], pair=t['pair'],
                                   v=t['net'], c=t['net_flip'], ex=t['net'] - t['net_flip']))
                exs = cluster_stats(ex, hold_h * HOUR_MS, value_key='ex')
                # the placebo: the same trades with a random side
                pb = placebo_random_side(trades, hold_h * HOUR_MS, draws=120)
                conc = concentration(ex)
                rows.append(dict(tp=tp, stop=stop, hold=hold_h, n=len(trades),
                                 wins=wins, losses=losses, times=times,
                                 win_rate=wins / max(1, wins + losses),
                                 ev_usd=ev_usd, clus=cs['clusters'], t=cs['t'],
                                 trimmed=cs['trimmed'], worst3=cs['worst3'], best3=cs['best3'],
                                 excess_usd=exs['ev'], excess_t=exs['t'],
                                 placebo_p=(pb['p'] if pb else None),
                                 conc=conc))
                print(f"  hold {hold_h:>2}h  TP {tp*100:>4.1f}%  SL {stop*100:>4.2f}%  "
                      f"n {len(trades):>6}  win {wins/max(1,wins+losses)*100:>5.1f}%  "
                      f"time {times/len(trades)*100:>5.1f}%  "
                      f"EV ${ev_usd:+.4f}  excess ${exs['ev']:+.4f}  "
                      f"clus {cs['clusters']:>3}  t {cs['t']:>6.2f}  "
                      f"trim ${(cs['trimmed'] if cs['trimmed'] is not None else float('nan')):+.4f}  "
                      f"p={pb['p']:.3f}" if pb else "")

    # ── 3. THE BAR ───────────────────────────────────────────────────
    print("\n" + "-" * 122)
    print("3. THE BAR")
    print("-" * 122)
    print(f"  the fee floor: ${floor:.4f} per ticket (the taker round trip on $60).")
    print(f"  a geometry must make MORE than that to break even.")
    print(f"\n  the best rows by the clustered EV:")
    print(f"  {'hold':>4} {'TP':>6} {'SL':>6} {'n':>7} {'win%':>6} {'time%':>7} {'EV$':>9} "
          f"{'excess$':>9} {'clus':>5} {'t':>7} {'trim$':>9} {'p':>6}  concentration")
    for r in sorted(rows, key=lambda r: -r['ev_usd'])[:14]:
        c = r['conc']
        cs = (f"{c['best']} ${c['best_ev']:+.4f} (n={c['best_n']})" if c else "n/a")
        print(f"  {r['hold']:>4}h {r['tp']*100:>5.1f}% {r['stop']*100:>5.2f}% {r['n']:>7} "
              f"{r['win_rate']*100:>5.1f}% {r['times']/r['n']*100:>6.1f}% {r['ev_usd']:>+9.4f} "
              f"{r['excess_usd']:>+9.4f} {r['clus']:>5} {r['t']:>7.2f} "
              f"{(r['trimmed'] if r['trimmed'] is not None else float('nan')):>+9.4f} "
              f"{(r['placebo_p'] if r['placebo_p'] is not None else float('nan')):>6.3f}  {cs}")

    passing = []
    for r in rows:
        ok, why = verdict(r['ev_usd'], floor, r['t'], r['clus'], r['trimmed'], r['placebo_p'])
        r['passes'] = ok; r['why'] = why
        if ok:
            passing.append(r)
    print(f"\n  geometries that CLEAR THE BAR: {len(passing)} of {len(rows)}")
    for r in passing:
        print(f"    hold {r['hold']}h TP {r['tp']*100:.1f}% SL {r['stop']*100:.2f}%: "
              f"EV ${r['ev_usd']:+.4f} t {r['t']:.2f} clusters {r['clus']} p {r['placebo_p']:.3f}")
    if not passing:
        # why the best row failed, item by item
        best = max(rows, key=lambda r: r['ev_usd'])
        ok, why = verdict(best['ev_usd'], floor, best['t'], best['clus'], best['trimmed'], best['placebo_p'])
        print(f"\n  the best row (hold {best['hold']}h TP {best['tp']*100:.1f}% SL {best['stop']*100:.2f}%) "
              f"fails on:")
        for w in why:
            print(f"    - {w}")
    json.dump(rows, open(os.path.join(GEO2, f"geo1-rows-{VENUE}-{RES}.json"), "w"), default=str)
    print(f"\n  wrote geo1-rows-{VENUE}-{RES}.json")
    return 0


if __name__ == '__main__':
    sys.exit(main())
