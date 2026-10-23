#!/usr/bin/env python3
"""
THE 14-DAY POLICY STUDY — the policy question on the sample that can
actually answer it.

WHY A SECOND DATASET
---------------------
The collector's own rows carry the MODEL legs (jevSide, layaSide,
agreement, confidence) and the book imbalance — so they are the only
place a threshold on MODEL AGREEMENT can be fitted. But the collector
has run for 7 hours, and the ticket holds for 4 hours, so the
live-gate arm has TWO independent clusters at the ticket's holding
period. Two clusters cannot support any conclusion about a threshold,
a Kelly fraction, or a confidence interval.

The 14-day tape reconstruction has 43 pairs x 336 hours of 1h bars
WITH VOLUME, so the machine's own tape can be rebuilt offline
(validated at 98.6% agreement on the tape's SIDE) and placed on the
same 5-minute grid. That yields 77 independent 4-hour clusters — a
sample that can answer the policy question for the TAPE arm.

It cannot answer it for the MODEL filter, because the models' output
does not exist at that scale. That asymmetry is itself a finding, and
it is reported as such rather than papered over.

THE FIDELITY GATE
-----------------
This script's 14-day engine must reproduce the repo's published 14-day
number from `uni-study-results.json`: EV -$0.0857/trade on 49,866
trades, win rate 86.3% against an 88.7% break-even. If it does not,
nothing downstream is trustworthy.

READ-ONLY. Local files only. No account call, no venue call.
"""
import bisect
import collections
import json
import math
import os
import sys
from datetime import datetime, timezone
from os.path import join, expanduser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import policy_core as pc
from policy_core import (mean, sd, se, median, cluster_stats, kelly_grid,
                          kelly_mv, kelly_discrete, bootstrap_kelly,
                          daily_loss_draws, EQUITY, NOTIONAL, RHO, TAKER_RT,
                          FEE_USD, FEE_FLOOR_EQ, DAILY_NOTIONAL_CAP,
                          DAILY_LOSS_CAP, MAX_TICKETS, HOLD_MS, BUCKET_MS,
                          HOUR_MS, SCRATCH, SHIPPED, FIXED, LIVE)
from uni_tape import fade_metrics, tape_side

GRID_MS = 300_000
BARS1H = join(SCRATCH, 'uni-tape-1h-bars.json')
BARS15 = join(SCRATCH, 'fee-floor-15m-bars.json')
UNI_RESULTS = join(SCRATCH, 'uni-study-results.json')

OUT = {}


def u(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')


def rule(c='='):
    print(c * 118)


def fmt(x, d=4):
    return f'{x:.{d}f}' if isinstance(x, (int, float)) and math.isfinite(x) else 'n/a'


def sgn(x, d=4):
    if not isinstance(x, (int, float)) or not math.isfinite(x):
        return 'n/a'
    return f'{x:+.{d}f}'


def usd(x, d=4):
    if not isinstance(x, (int, float)) or not math.isfinite(x):
        return 'n/a'
    return f'{"+" if x >= 0 else "-"}${abs(x):.{d}f}'


# ═══════════════════════════════════════════════════════════════════════
# THE 14-DAY TAPE RECONSTRUCTION
# ═══════════════════════════════════════════════════════════════════════
def hourly_states(bars1h):
    """The machine's tape state at every hour boundary, per symbol.

    `fade_metrics` is a VERBATIM port of the CLI's `fadeMetrics`, and
    `tape_side` a verbatim port of `tapeSideOf` — so this is the same
    signal the machine trades, rebuilt offline from 1h bars with volume.
    """
    out = {}
    for pair, bars in bars1h.items():
        b = sorted(bars, key=lambda x: x['t'])
        states = []
        for i in range(23, len(b)):
            w = b[i - 23:i + 1]
            m = fade_metrics([x['c'] for x in w], [x['v'] for x in w],
                             [x['h'] for x in w], [x['l'] for x in w])
            if not m:
                continue
            states.append(dict(t=b[i]['t'], m=m, side=tape_side(m)))
        out[pair] = states
    return out


def build_14day(states, bars15, geom=LIVE):
    """Every tape signal on the 5-minute grid, resolved under the correct
    fill rule, with NO LOOK-AHEAD in the entry.

    The entry is the close of the last 15-minute bar that had ALREADY
    CLOSED at the observation time. (A 15m bar is stamped with its OPEN
    time, so the bar whose t <= ts is the one CONTAINING ts and its
    close is up to 15 minutes in the future. Using it is look-ahead.)
    """
    trades = []
    for pair, st in states.items():
        b15 = bars15.get(pair)
        if not b15:
            continue
        t15 = b15['_t']
        bars = b15['bars']
        j = 0
        for ts in range(st[0]['t'] if st else 0, (st[-1]['t'] + 1) if st else 0, GRID_MS):
            while j + 1 < len(st) and st[j + 1]['t'] <= ts:
                j += 1
            if not st or st[j]['t'] > ts:
                continue
            s = st[j]
            if not s['side']:
                continue
            tk = pc.plan(s['m']['atrPct'], s['side'], geom)
            if not tk:
                continue
            k = bisect.bisect_right(t15, ts - 900_000) - 1
            if k < 0:
                continue
            entry = bars[k]['c']
            out = pc.resolve(b15, ts, entry, tk)
            if out is None:
                continue
            kind, gross, held, how = out
            pnl_frac = gross - TAKER_RT
            trades.append(dict(
                pair=pair, ts=ts, side=s['side'], kind=kind, how=how, held=held,
                gross=gross, pnl_frac=pnl_frac,
                pnl_eq=pnl_frac * RHO * 100,
                pnl_usd=pnl_frac * NOTIONAL,
                atr=s['m']['atrPct'], chg=s['m']['chg'], vratio=s['m']['vratio'],
                off_high=s['m']['offHighPct'], off_low=s['m']['offLowPct'],
                hour=ts // HOUR_MS, day=ts // 86_400_000,
                tp_pct=tk['tp_pct'], d=tk['d'],
            ))
    return trades


def main():
    rule()
    print('THE 14-DAY POLICY STUDY — the sample that can answer the policy question')
    rule()

    bars1h = json.load(open(BARS1H))
    bars15_raw = json.load(open(BARS15))
    bars15 = {}
    for pair, bb in bars15_raw.items():
        bb = sorted(bb, key=lambda x: x['t'])
        bars15[pair] = {'_t': [x['t'] for x in bb], 'bars': bb}

    states = hourly_states(bars1h)
    all_t = [s['t'] for st in states.values() for s in st]
    print(f'  1h bars with volume      {len(bars1h)} pairs, '
          f'{u(min(all_t))} -> {u(max(all_t))} UTC')
    print(f'  distinct tape states     {len(set(all_t))} hours')

    live_trades = build_14day(states, bars15, LIVE)
    print(f'  tape signals on the grid {len(live_trades)} resolved trades')

    # ── THE FIDELITY GATE against the repo's published 14-day number ────
    rule()
    print('THE FIDELITY GATE — this engine vs the repo\'s published 14-day number')
    rule()
    fails = 0

    def check(name, got, want, tol, unit=''):
        nonlocal fails
        ok = abs(got - want) <= tol
        if not ok:
            fails += 1
        print(f'  [{"PASS" if ok else "FAIL"}] {name:<48} got {got:>11.4f}{unit}  '
              f'want {want:>11.4f}{unit}  (tol {tol})')

    wins = [t for t in live_trades if t['kind'] == 'win']
    loss = [t for t in live_trades if t['kind'] == 'loss']
    tim = [t for t in live_trades if t['kind'] == 'time']
    ev_usd = mean([t['pnl_usd'] for t in live_trades])
    gw = mean([t['pnl_usd'] for t in wins]) if wins else 0.0
    gl = mean([t['pnl_usd'] for t in loss]) if loss else 0.0
    wr = len(wins) / max(1, len(wins) + len(loss))
    be = (-gl / (gw - gl)) if (gw - gl) > 0 else float('nan')
    print(f'  n {len(live_trades)} | win {len(wins)} | loss {len(loss)} | time {len(tim)}')
    check('EV $/trade', ev_usd, -0.0857, 0.005, '$')
    check('EV % of equity per trade', ev_usd / EQUITY * 100, -0.1507, 0.010, '%')
    check('win rate (decided) %', wr * 100, 86.31, 1.5, '%')
    check('break-even win rate %', be * 100, 88.69, 1.5, '%')
    print(f'  the fee floor is {FEE_FLOOR_EQ:.4f}% of equity = ${FEE_USD:.4f}; '
          f'the measured EV is {ev_usd/EQUITY*100:+.4f}% = {usd(ev_usd)}.')
    print(f'  -> the edge is {"BELOW" if ev_usd < 0 else "ABOVE"} the floor, by '
          f'{abs(ev_usd - (-FEE_USD)):+.4f} $/trade.')

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('1. THE KELLY FRACTION — on the MEASURED return distribution')
    rule()
    print('  The objective is E[log(1 + f*r)] over the MEASURED per-trade returns r (as a')
    print('  fraction of equity), maximised over f. That is the growth rate a compounding')
    print('  account actually earns, so it is the right objective for a policy decision.')
    print('  A NEGATIVE-edge distribution has its maximum at f = 0: trade NOTHING.')
    print()
    print(f'  {"arm":<14} {"n":>6} {"clusters":>9} {"EV %eq/tr":>10} {"EV $/tr":>9} '
          f'{"sd %eq":>8} {"kelly f*":>9} {"f* (mv)":>9} {"CI95 on f*":>22} {"g(f*)":>10}')
    print('  ' + '-' * 116)

    rets = [t['pnl_frac'] * RHO for t in live_trades]
    # kelly_grid returns a DICT: a negative-edge distribution has its
    # supremum at f -> 0+, so the interior maximum a fine grid lands on
    # is an artefact of the grid, not an edge. The flag says so.
    # The shared grid: the point estimate and the bootstrap MUST use the
    # same one, or the CI does not bracket the estimate.
    _kelly = kelly_grid(rets, steps=pc.KELLY_GRID_STEPS)
    f_star = _kelly["f_star"]
    g = _kelly["g"]
    negative_edge = _kelly.get("negative_edge", False)
    at_boundary = _kelly.get("at_boundary", False)
    f_mv = kelly_mv(rets)
    cs = cluster_stats(live_trades, HOLD_MS)
    bs = bootstrap_kelly(live_trades, HOLD_MS, n_boot=2000, steps=pc.KELLY_GRID_STEPS)
    ci = f'[{bs["lo"]:+.4f}, {bs["hi"]:+.4f}]' if bs else 'n/a'
    print(f'  {"TAPE 14-day":<14} {len(live_trades):>6} {cs["n_clusters"]:>9} '
          f'{sgn(cs["ev"]):>10} {usd(ev_usd):>9} {fmt(sd(rets)*100):>8} '
          f'{f_star:>+9.4f} {f_mv:>+9.4f} {ci:>22} {g:>+10.5f}')
    print()
    print(f'  the closed-form check: p(win) {wr*100:.2f}% | net win {usd(gw)} | net loss {usd(gl)}')
    f_closed = kelly_discrete(wr, gw, -gl) if gw > 0 and gl < 0 else 0.0
    print(f'  Kelly (f* = (p*b - (1-p))/b) = {f_closed:+.4f}  -> '
          f'{"NEGATIVE: trade NOTHING" if f_closed < 0 else "positive"}')
    print(f'  the discrete-grid maximum over f in (0,1]: f* = {f_star:+.4f} '
          f'(g(f*) = {g:+.6f} per trade)')
    print(f'  the cluster bootstrap 95% CI on f*: {ci}  '
          f'({bs["n_boot"] if bs else 0} resamples of whole 4-hour clusters)')
    OUT['kelly'] = dict(f_star=f_star, f_mv=f_mv, f_closed=f_closed, ci=bs, g=g)

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('1b. HOW MUCH BETTER MUST THE SIGNAL BE?')
    rule()
    print(f'  The 14-day tape arm: {len(live_trades)} trades in {cs["n_clusters"]} clusters at')
    print(f'  the ticket\'s 4-hour holding period.')
    print(f'    cluster-corrected EV   {sgn(cs["ev"])} % of equity per trade')
    print(f'    cluster-corrected se   {fmt(cs["se"])}')
    print(f'    t                      {sgn(cs["t"], 2)}  (df {cs["n_clusters"]-1})')
    print(f'    95% CI                 [{sgn(cs["lo"])}, {sgn(cs["hi"])}] % of equity')
    print()
    tc = pc.t_crit(cs['n_clusters'] - 1)
    half = tc * cs['se']
    print(f'    the 95% CI half-width is t_crit({cs["n_clusters"]-1}) x se = {tc:.3f} x '
          f'{cs["se"]:.4f} = {half:.4f} % of equity')
    print(f'    so the edge would have to be at least {half:.4f}% of equity per trade')
    print(f'    (i.e. {half/EQUITY*100:+.3f}% of the account, or {usd(half/100*EQUITY)} a trade)')
    print(f'    for the CI to exclude zero. The measured edge is {cs["ev"]:+.4f}%.')
    print()
    print(f'  THE HYPOTHETICAL: if the edge were -0.02% instead of {cs["ev"]:+.4f}%,')
    se_needed = 0.02 / tc
    n_needed = (cs['sd'] / 0.02) ** 2 if cs['sd'] > 0 else float('inf')
    print(f'  would the CI exclude zero? Only if the standard error were below {se_needed:.5f}%.')
    print(f'  The measured cluster sd is {cs["sd"]:.4f}%, so the sample needed is')
    print(f'    n = (sd/|edge|)^2 = ({cs["sd"]:.4f}/0.02)^2 = {n_needed:.0f} clusters,')
    print(f'  which is {n_needed/max(cs["n_clusters"],1):.1f}x the {cs["n_clusters"]} measured.')
    print(f'  At the 14-day tape arm\'s rate of {len(live_trades)/12.79/24:.1f} trades/hour,')
    print(f'  that is {n_needed/ (len(live_trades)/12.79) * 4 /24:.0f} days of collection.')
    print()
    print(f'  {"true edge %eq":>14} {"clusters for t=2":>18} {"vs today":>9} {"days at 14d rate":>18}')
    for e in (0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40):
        nreq = (cs['sd'] / e) ** 2
        days = nreq / max(len(live_trades) / 12.79, 1e-9) * 4 / 24
        print(f'  {e:>14.2f} {nreq:>18.0f} {nreq/max(cs["n_clusters"],1):>8.0f}x {days:>17.0f}')

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('2. THE THRESHOLD RULE — trading only the highest-conviction candidates')
    rule()
    print('  Every score is a HIGHER-is-BETTER conviction score; the threshold keeps the')
    print('  top N% of the signals. The cluster is the 4-hour holding period.')
    print()
    print(f'  {"score":<26} {"top":>5} {"kept":>5} {"clusters":>9} {"EV %eq":>9} {"se":>8} '
          f'{"t":>7} {"EV $/tr":>9} {"win%":>7} {"loss%":>7} {"VERDICT":>10}')
    print('  ' + '-' * 116)

    def score_rows(trades):
        out = []
        for t in trades:
            tt = dict(t)
            tt['volume_exhaustion'] = 1.0 - t['vratio']
            tt['distance_from_extreme'] = (t['off_high'] if t['side'] == 'short'
                                           else t['off_low'])
            tt['signal_strength'] = abs(t['chg'])
            tt['atr_pct'] = t['atr']
            out.append(tt)
        return out

    scored = score_rows(live_trades)
    SCORES = [
        ('volume exhaustion (1-vratio)', 'volume_exhaustion', True),
        ('distance from the extreme', 'distance_from_extreme', False),
        ('signal strength |chg|', 'signal_strength', True),
        ('ATR% (volatility)', 'atr_pct', True),
    ]
    TOP_PCTS = (0.05, 0.10, 0.20, 0.50)

    threshold_results = []
    for label, key, higher in SCORES:
        for pct in TOP_PCTS:
            vals = sorted(t[key] for t in scored)
            if higher:
                cut = vals[min(int((1 - pct) * len(vals)), len(vals) - 1)]
                kept = [t for t in scored if t[key] >= cut]
            else:
                cut = vals[min(int(pct * len(vals)), len(vals) - 1)]
                kept = [t for t in scored if t[key] <= cut]
            if len(kept) < 30:
                continue
            c = cluster_stats(kept, HOLD_MS)
            w = sum(1 for t in kept if t['kind'] == 'win')
            l = sum(1 for t in kept if t['kind'] == 'loss')
            evu = mean([t['pnl_usd'] for t in kept])
            ok = (c['ev'] > 0) and (c['t'] >= 2) and (c['n_clusters'] >= 30)
            verdict = 'PASS' if ok else ('positive' if c['ev'] > 0 else 'fail')
            print(f'  {label:<26} {pct*100:>4.0f}% {len(kept):>5} {c["n_clusters"]:>9} '
                  f'{sgn(c["ev"]):>9} {fmt(c["se"]):>8} {sgn(c["t"],2):>7} {usd(evu):>9} '
                  f'{w/max(1,w+l)*100:>6.1f}% {l/max(1,w+l)*100:>6.1f}% {verdict:>10}')
            threshold_results.append(dict(score=label, key=key, pct=pct, n=len(kept),
                                          clusters=c['n_clusters'], ev=c['ev'],
                                          t=c['t'], se=c['se'], ev_usd=evu,
                                          verdict=verdict))
    OUT['thresholds'] = threshold_results
    n_pos = sum(1 for r in threshold_results if r['ev'] > 0)
    n_pass = sum(1 for r in threshold_results if r['verdict'] == 'PASS')
    print()
    print(f'  {n_pos} of {len(threshold_results)} thresholds have a POSITIVE cluster-corrected EV;')
    print(f'  {n_pass} of {len(threshold_results)} clear the full bar (EV>0, t>=2, >=30 clusters).')
    print(f'  The pool itself is {sgn(cs["ev"])} %eq/trade in {cs["n_clusters"]} clusters '
          f'(t {sgn(cs["t"],2)}), so')
    print(f'  a threshold is only interesting if it beats a NEGATIVE pool.')

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('3. THE OUT-OF-SAMPLE CHECK — fit on the first half, test on the second')
    rule()
    print('  A threshold chosen on the same sample it is reported on is a SELECTION')
    print('  ARTEFACT. So each threshold is FIT on the FIRST 7 days and TESTED on the')
    print('  LAST 7 days, and the reverse is run as a robustness check.')
    print()
    days = sorted(set(t['day'] for t in scored))
    half = days[:len(days) // 2]
    second_days = set(days[len(days) // 2:])
    first = [t for t in scored if t['day'] in set(half)]
    second = [t for t in scored if t['day'] in second_days]
    print(f'  the split: {len(half)} days TRAIN ({u(half[0]*86_400_000)} -> '
          f'{u((half[-1]+1)*86_400_000)}) | {len(second_days)} days TEST '
          f'({u(min(second_days)*86_400_000)} -> {u((max(second_days)+1)*86_400_000)})')
    fc = cluster_stats(first, HOLD_MS)
    sc = cluster_stats(second, HOLD_MS)
    print(f'    TRAIN arm: {len(first)} trades, {fc["n_clusters"]} clusters, '
          f'EV {sgn(fc["ev"])} %eq, t {sgn(fc["t"],2)}')
    print(f'    TEST  arm: {len(second)} trades, {sc["n_clusters"]} clusters, '
          f'EV {sgn(sc["ev"])} %eq, t {sgn(sc["t"],2)}')
    print()
    print(f'  {"score":<26} {"top":>5} | {"fit EV":>9} {"n":>5} {"cl":>4} {"t":>7} '
          f'| {"TEST EV":>9} {"n":>5} {"cl":>4} {"t":>7} | {"HELD?":>10}')
    print('  ' + '-' * 116)
    oos = []
    for label, key, higher in SCORES:
        for pct in TOP_PCTS:
            fv = sorted(t[key] for t in first)
            if len(fv) < 30:
                continue
            if higher:
                cut = fv[min(int((1 - pct) * len(fv)), len(fv) - 1)]
                fk = [t for t in first if t[key] >= cut]
                tk_ = [t for t in second if t[key] >= cut]
            else:
                cut = fv[min(int(pct * len(fv)), len(fv) - 1)]
                fk = [t for t in first if t[key] <= cut]
                tk_ = [t for t in second if t[key] <= cut]
            if len(fk) < 10 or len(tk_) < 10:
                continue
            a = cluster_stats(fk, HOLD_MS)
            b = cluster_stats(tk_, HOLD_MS)
            held = ('YES' if (a['ev'] > 0 and b['ev'] > 0)
                    else ('sign-flip' if a['ev'] > 0 else 'no'))
            print(f'  {label:<26} {pct*100:>4.0f}% | {sgn(a["ev"]):>9} {len(fk):>5} '
                  f'{a["n_clusters"]:>4} {sgn(a["t"],2):>7} | {sgn(b["ev"]):>9} '
                  f'{len(tk_):>5} {b["n_clusters"]:>4} {sgn(b["t"],2):>7} | {held:>10}')
            oos.append(dict(score=label, pct=pct, cut=cut, fit_ev=a['ev'],
                            fit_t=a['t'], fit_n=len(fk), fit_clusters=a['n_clusters'],
                            test_ev=b['ev'], test_t=b['t'], test_n=len(tk_),
                            test_clusters=b['n_clusters'], held=held))
    OUT['oos'] = oos

    # the reverse split as a robustness check
    print()
    print('  THE REVERSE SPLIT (fit on the LAST 7 days, test on the FIRST 7) — the')
    print('  robustness check on the split itself:')
    print(f'  {"score":<26} {"top":>5} | {"fit EV":>9} {"cl":>4} | {"TEST EV":>9} '
          f'{"cl":>4} | {"HELD?":>10}')
    rev = []
    for label, key, higher in SCORES:
        for pct in TOP_PCTS:
            fv = sorted(t[key] for t in second)
            if len(fv) < 30:
                continue
            if higher:
                cut = fv[min(int((1 - pct) * len(fv)), len(fv) - 1)]
                fk = [t for t in second if t[key] >= cut]
                tk_ = [t for t in first if t[key] >= cut]
            else:
                cut = fv[min(int(pct * len(fv)), len(fv) - 1)]
                fk = [t for t in second if t[key] <= cut]
                tk_ = [t for t in first if t[key] <= cut]
            if len(fk) < 10 or len(tk_) < 10:
                continue
            a = cluster_stats(fk, HOLD_MS)
            b = cluster_stats(tk_, HOLD_MS)
            held = ('YES' if (a['ev'] > 0 and b['ev'] > 0)
                    else ('sign-flip' if a['ev'] > 0 else 'no'))
            print(f'  {label:<26} {pct*100:>4.0f}% | {sgn(a["ev"]):>9} '
                  f'{a["n_clusters"]:>4} | {sgn(b["ev"]):>9} {b["n_clusters"]:>4} | {held:>10}')
            rev.append(dict(score=label, pct=pct, fit_ev=a['ev'], test_ev=b['ev'], held=held))
    OUT['oos_reverse'] = rev

    # the size of the artefact
    print()
    print('  THE SIZE OF THE ARTEFACT: the best in-sample threshold, and the same')
    print('  threshold measured out of sample.')
    best = max(threshold_results, key=lambda r: r['ev']) if threshold_results else None
    if best:
        match = [o for o in oos if o['score'] == best['score'] and o['pct'] == best['pct']]
        rmatch = [o for o in rev if o['score'] == best['score'] and o['pct'] == best['pct']]
        print(f'    best in-sample: {best["score"]}, top {best["pct"]*100:.0f}%')
        print(f'      in-sample  EV {sgn(best["ev"])} %eq, t {sgn(best["t"],2)}, '
              f'{best["clusters"]} clusters, {best["n"]} trades')
        if match:
            o = match[0]
            print(f'      FORWARD OOS  EV {sgn(o["test_ev"])} %eq, t {sgn(o["test_t"],2)}, '
                  f'{o["test_clusters"]} clusters, {o["test_n"]} trades  -> {o["held"]}')
        if rmatch:
            o = rmatch[0]
            print(f'      REVERSE OOS  EV {sgn(o["test_ev"])} %eq, {o["held"]}')

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('4. THE DAILY-LOSS ARITHMETIC — what the owner is exposed to')
    rule()
    print(f'  The daily loss cap is ${DAILY_LOSS_CAP:.0f} and it counts GROSS LOSSES (a')
    print('  profit does not offset a loss — realized-pnl-reconcile.ts). The daily')
    print(f'  notional budget is ${DAILY_NOTIONAL_CAP:.0f}, so at ${NOTIONAL:.0f} a ticket the')
    print(f'  machine can take at most {MAX_TICKETS} tickets a day.')
    print()
    print(f'  {"arm":<14} {"tickets":>8} {"EV $/tr":>9} {"EV $/day":>10} '
          f'{"P(loss counter >= $12)":>22} {"P(net <= -$12)":>15} '
          f'{"median loss":>12} {"p95 loss":>9} {"p99 loss":>9}')
    print('  ' + '-' * 116)
    daily = []
    for n_t in (8, 4, 1):
        d = daily_loss_draws(live_trades, n_t, n_draws=120000)
        daily.append(dict(tickets=n_t, **d))
        print(f'  {"TAPE 14-day":<14} {n_t:>8} {usd(d["ev_usd"]):>9} '
              f'{usd(d["ev_day_usd"]):>10} {d["p_cap"]*100:>21.2f}% '
              f'{d["p_net_cap"]*100:>14.2f}% {usd(d["median_loss"],2):>12} '
              f'{usd(d["p95_loss"],2):>9} {usd(d["p99_loss"],2):>9}')
    OUT['daily'] = daily
    print()
    print('  The SAME arithmetic on the collector\'s live-gate arm (the 7-hour sample,')
    print('  the LIVE geometry) — but with its 2 clusters, so the distribution is not')
    print('  trustworthy; it is printed for completeness, not for a decision.')
    rows = pc.read_rows(join(SCRATCH, 'confluence.ndjson'))
    pc.BARS = pc.read_bars(join(SCRATCH, 'fee-floor-15m-bars.json'))
    live7 = [r for r in rows if r.get('tapeSide')
             and pc.live_gate_side(r) == r['tapeSide']]
    tr7 = pc.simulate(live7, LIVE)
    for n_t in (8, 4, 1):
        d = daily_loss_draws(tr7, n_t, n_draws=120000)
        print(f'  {"LIVE-GATE 7h":<14} {n_t:>8} {usd(d["ev_usd"]):>9} '
              f'{usd(d["ev_day_usd"]):>10} {d["p_cap"]*100:>21.2f}% '
              f'{d["p_net_cap"]*100:>14.2f}% {usd(d["median_loss"],2):>12} '
              f'{usd(d["p95_loss"],2):>9} {usd(d["p99_loss"],2):>9}')

    # ═══════════════════════════════════════════════════════════════════
    rule()
    print('5. THE VERDICT')
    rule()
    print(f'  (a) KEEP TRADING 8/DAY')
    d8 = daily[0]
    print(f'      EV {sgn(cs["ev"])} %eq/trade (t {sgn(cs["t"],2)}, {cs["n_clusters"]} clusters)')
    print(f'      expected {usd(d8["ev_day_usd"])} a day')
    print(f'      P(the ${DAILY_LOSS_CAP:.0f} loss cap fires) {d8["p_cap"]*100:.2f}%')
    print(f'      VERDICT: the edge is negative, so every ticket has a negative expected')
    print(f'      value. REJECT — this option loses money on average.')

    json.dump(OUT, open(join(SCRATCH, 'policy-study-14day.json'), 'w'),
              indent=2, default=str)
    print()
    print(f'  [written] {join(SCRATCH, "policy-study-14day.json")}')
    print()
    print(f'  FIDELITY GATE: {"PASSED" if fails == 0 else f"FAILED ({fails} checks)"}')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
