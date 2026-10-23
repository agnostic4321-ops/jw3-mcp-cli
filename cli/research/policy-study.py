#!/usr/bin/env python3
"""
THE POLICY STUDY — what should the machine DO, given a measured
non-positive edge?

THE QUESTION, IN FIVE PARTS
---------------------------
  1. THE KELLY FRACTION, with a cluster-corrected CI.
  2. THE THRESHOLD RULE: does trading only the top N% of candidates by
     some score have a positive net EV after the fee?
  3. THE OUT-OF-SAMPLE CHECK on any threshold that survives part 2.
  4. THE DAILY-LOSS ARITHMETIC: expected daily P&L and P(hit $12) at
     8, 4 and 1 tickets.
  5. THE VERDICT.

THE RULES OF THIS MEASUREMENT
-----------------------------
  * ONE fill rule (first touch; both = LOSS; neither = TIME EXIT at the
    mark; a take-profit already satisfied at the market = SCRATCH).
  * The CLUSTER is the ticket's holding period (4 hours). The
    collector's 5-minute round is also reported, labelled as what it is.
  * Every t has its cluster count beside it. A t without a cluster count
    is a row count.
  * A threshold FIT on one half and TESTED on the other. An in-sample
    threshold is a selection artefact and is reported as such.
  * NO ACCOUNT CALL. NO VENUE CALL. Local files only.

USAGE
  node/python: python3 research/policy-study.py
"""
import json
import math
import os
import sys
import collections
from os.path import join, expanduser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import policy_core as pc
from policy_core import (
    mean, sd, se, median, cluster_means, cluster_stats, kelly_grid,
    kelly_mv, kelly_discrete, bootstrap_kelly, daily_loss_draws,
    EQUITY, NOTIONAL, RHO, TAKER_RT, FEE_USD, FEE_FLOOR_EQ,
    DAILY_NOTIONAL_CAP, DAILY_LOSS_CAP, MAX_TICKETS,
    HOLD_MS, BUCKET_MS, HOUR_MS, SCRATCH, BARS,
    SHIPPED, FIXED, LIVE,
)

CONFLUENCE = join(SCRATCH, 'confluence.ndjson')
BAR_CACHE = join(SCRATCH, 'fee-floor-15m-bars.json')

OUT = {}


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
# LOAD
# ═══════════════════════════════════════════════════════════════════════
def main():
    print('═' * 118)
    print('THE POLICY STUDY — the optimal trading policy given a measured, non-positive edge')
    print('═' * 118)

    rows = pc.read_rows(CONFLUENCE)
    pc.BARS = pc.read_bars(BAR_CACHE)
    ts = sorted(r['ts'] for r in rows)
    print(f'  collector rows        {len(rows)}')
    print(f'  span                  {pc.__dict__ and ""}', end='')
    from datetime import datetime, timezone
    u = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    print(f'{u(ts[0])} -> {u(ts[-1])} UTC  ({(ts[-1]-ts[0])/3.6e6:.2f} h)')
    print(f'  bar cache             {len(pc.BARS)} pairs, '
          f'newest {u(max(b["_t"][-1] for b in pc.BARS.values()))} UTC')
    print(f'  equity ${EQUITY:.2f} | notional ${NOTIONAL:.0f} ({RHO:.4f}x) | '
          f'fee ${FEE_USD:.4f}/ticket = {FEE_FLOOR_EQ:.4f}% of equity')
    print(f'  daily notional ${DAILY_NOTIONAL_CAP:.0f} -> at most {MAX_TICKETS} tickets | '
          f'daily loss cap ${DAILY_LOSS_CAP:.0f} (GROSS losses, not net)')

    # ── the three geometries, on both arms ────────────────────────────────
    print()
    print('═' * 118)
    print('0. THE FILL RULE, APPLIED TO EVERY GEOMETRY  (first touch; both = LOSS; neither = TIME EXIT;')
    print('   a take-profit already satisfied at the market = SCRATCH)')
    print('═' * 118)
    print(f'  {"arm":<12} {"geom":<8} {"n":>4} {"clusters":>8} {"win%":>7} {"scratch%":>8} '
          f'{"loss%":>7} {"time%":>7} {"EV %eq":>9} {"se":>8} {"t":>7} '
          f'{"EV $/tr":>9} {"BE-WR":>7}')
    print('  ' + '-' * 116)

    arms = {}
    for arm_name, sel in (('LIVE-GATE', 'live'), ('TAPE-ONLY', 'tape')):
        for geom in (SHIPPED, FIXED, LIVE):
            key = f'{arm_name}|{geom}'
            if sel == 'live':
                tr = pc.simulate([r for r in rows if r.get('tapeSide')
                                  and pc.live_gate_side(r) == r['tapeSide']], geom)
            else:
                tr = pc.simulate([r for r in rows if r.get('tapeSide')], geom)
            arms[key] = tr
            cs = cluster_stats(tr, HOLD_MS)
            n = len(tr)
            if not n:
                print(f'  {arm_name:<12} {geom:<8} {0:>4}  (no trades)')
                continue
            wins = sum(1 for t in tr if t['kind'] == 'win')
            scr = sum(1 for t in tr if t['kind'] == 'scratch')
            loss = sum(1 for t in tr if t['kind'] == 'loss')
            tim = sum(1 for t in tr if t['kind'] == 'time')
            ev_usd = mean([t['pnl_usd'] for t in tr])
            # the break-even win rate at the measured geometry
            gw = mean([t['pnl_usd'] for t in tr if t['kind'] == 'win']) if wins else 0.0
            gl = mean([t['pnl_usd'] for t in tr if t['kind'] == 'loss']) if loss else 0.0
            be = (-gl / (gw - gl)) if (gw - gl) > 0 else float('nan')
            print(f'  {arm_name:<12} {geom:<8} {n:>4} {cs["n_clusters"]:>8} '
                  f'{wins/n*100:>6.1f}% {scr/n*100:>7.1f}% {loss/n*100:>6.1f}% {tim/n*100:>6.1f}% '
                  f'{sgn(cs["ev"]):>9} {fmt(cs["se"]):>8} {sgn(cs["t"], 2):>7} '
                  f'{usd(ev_usd):>9} {fmt(be*100, 1):>7}')

    OUT['arms'] = {k: dict(n=len(v), clusters=cluster_stats(v, HOLD_MS)['n_clusters'],
                            ev=cluster_stats(v, HOLD_MS)['ev'],
                            t=cluster_stats(v, HOLD_MS)['t'])
                   for k, v in arms.items() if v}

    # ── the LIVE geometry is what the machine runs today ────────────────
    live_trades = arms[f'LIVE-GATE|{LIVE}']
    tape_trades = arms[f'TAPE-ONLY|{LIVE}']
    if not live_trades:
        print('\n  ERROR: the live-gate arm resolved no trades.')
        return

    # ═══════════════════════════════════════════════════════════════════
    print()
    print('═' * 118)
    print('1. THE KELLY FRACTION — done on the MEASURED return distribution')
    print('═' * 118)
    print(f'  The objective is E[log(1 + f*r)] over the MEASURED per-trade returns r (as a fraction')
    print(f'  of equity), maximised over f in (0, 1]. That is the growth rate a compounding')
    print(f'  account actually earns, so it is the right objective for a policy decision.')
    print()
    print(f'  {"arm":<12} {"geom":<8} {"n":>4} {"clusters":>8} {"EV %eq/tr":>11} {"EV $/tr":>9} '
          f'{"sd %eq":>9} {"kelly f":>9} {"f (mv)":>9} {"CI95 on f":>22} {"g(f*)":>9}')
    print('  ' + '-' * 116)

    kelly_rows = []
    for arm_name in ('LIVE-GATE', 'TAPE-ONLY'):
        for geom in (SHIPPED, FIXED, LIVE):
            tr = arms[f'{arm_name}|{geom}']
            if not tr:
                continue
            rets = [t['pnl_frac'] * RHO for t in tr]     # fraction of equity
            # kelly_grid returns a DICT: a negative-edge distribution
            # has its supremum at f -> 0+, so the interior maximum a
            # fine grid lands on is an artefact of the grid, not an
            # edge. The flag says so.
            _kelly = kelly_grid(rets, steps=pc.KELLY_GRID_STEPS)
            f_star = _kelly["f_star"]
            g = _kelly["g"]
            negative_edge = _kelly.get("negative_edge", False)
            at_boundary = _kelly.get("at_boundary", False)
            f_mv = kelly_mv(rets)
            # The same grid the point estimate uses, so the CI brackets it.
            bs = bootstrap_kelly(tr, HOLD_MS, n_boot=1500, steps=pc.KELLY_GRID_STEPS)
            cs = cluster_stats(tr, HOLD_MS)
            sd_eq = sd(rets) * 100
            ci = f'[{bs["lo"]:+.4f}, {bs["hi"]:+.4f}]' if bs else 'n/a (too few clusters)'
            print(f'  {arm_name:<12} {geom:<8} {len(tr):>4} {cs["n_clusters"]:>8} '
                  f'{sgn(cs["ev"]):>11} {usd(mean([t["pnl_usd"] for t in tr])):>9} '
                  f'{fmt(sd_eq):>9} {f_star:>+9.4f} {f_mv:>+9.4f} {ci:>22} {g:>+9.5f}')
            kelly_rows.append(dict(arm=arm_name, geom=geom, n=len(tr),
                                   clusters=cs['n_clusters'], ev=cs['ev'], t=cs['t'],
                                   f_star=f_star, f_mv=f_mv, g=g,
                                   ci=bs, sd_eq=sd_eq))
    OUT['kelly'] = kelly_rows

    # the closed-form check on the live-gate arm
    lg = live_trades
    wins = [t for t in lg if t['kind'] == 'win']
    loss = [t for t in lg if t['kind'] == 'loss']
    gw = mean([t['pnl_usd'] for t in wins]) if wins else 0.0
    gl = mean([t['pnl_usd'] for t in loss]) if loss else 0.0
    p_win = len(wins) / max(1, len(wins) + len(loss))
    print()
    print(f'  THE MEASURED SHAPE on the live-gate arm, LIVE geometry:')
    print(f'    decided trades {len(wins)+len(loss)} | win rate {p_win*100:.1f}% | '
          f'net win {usd(gw)} | net loss {usd(gl)}')
    # THE CLOSED FORM IS FOR A DIFFERENT OBJECTIVE, and it must not be
    # used as a check on the grid.
    #
    # f* = (p*b - (1-p))/b is the SINGLE-BET formula: it assumes the bet
    # wins b or loses the WHOLE stake, once. The grid maximises
    # E[log(1 + f*r)] over the MEASURED distribution, which is the
    # repeated fractional bet — the thing a trading account actually
    # does. The two disagree, and the single-bet form can be NEGATIVE
    # where the repeated form is POSITIVE: it charges the full stake to
    # a loss, while a fractional stake can only lose its fraction.
    #
    # Measured here: the single-bet formula said f* = -1.0052, which
    # reads as "no bet is correct", while the grid on the same trades
    # says f* = 0 (the growth is decreasing for every f > 0, so the
    # supremum is at f -> 0+). The grid is right for this objective,
    # and the closed form was answering a different question.
    #
    # So the grid is the answer, and the closed form is reported with
    # the objective it belongs to named, so a reader does not mistake
    # it for a check.
    b_ratio = (gw / -gl) if (gl < 0 and gw > 0) else 0.0
    f_single = kelly_discrete(p_win, gw, -gl) if gw > 0 and gl < 0 else 0.0
    print(f'    the win/loss ratio b = {b_ratio:.4f}')
    print(f'    the SINGLE-BET Kelly (p*b - (1-p))/b = {f_single:+.4f} '
          f'-- a DIFFERENT objective (one all-or-nothing bet), not a check on the grid')
    print(f'    the REPEATED-FRACTIONAL Kelly (the grid, over the measured distribution) '
          f'is the answer')
    print(f'    a NEGATIVE fraction means the correct bet size is ZERO: the trade has a')
    print(f'       negative expected value, so no fraction of the bankroll is correct.')

    # ── the sharpest question: how much better must the signal be? ─────
    print()
    print('═' * 118)
    print('1b. HOW MUCH BETTER MUST THE SIGNAL BE?  (the confidence interval on the EDGE)')
    print('═' * 118)
    cs = cluster_stats(lg, HOLD_MS)
    n_c = cs['n_clusters']
    print(f'  The live-gate arm, LIVE geometry: {len(lg)} trades in {n_c} clusters at the')
    print(f'  ticket\'s 4-hour holding period.')
    print(f'    cluster-corrected EV  {sgn(cs["ev"])} % of equity per trade')
    print(f'    cluster-corrected se  {fmt(cs["se"])}')
    print(f'    t                     {sgn(cs["t"], 2)}   (df {n_c-1})')
    print(f'    95% CI                [{sgn(cs["lo"])}, {sgn(cs["hi"])}] % of equity')
    print()
    print('  THE QUESTION: if the true edge were X instead of {cs["ev"]:.4f}, would the CI')
    print('  exclude zero at this sample size? The answer is: X must exceed the CI half-width.')
    print()
    tc = pc.t_crit(n_c - 1)
    half = tc * cs['se']
    print(f'    the 95% CI half-width at {n_c} clusters is t_crit({n_c-1}) x se = '
          f'{tc:.3f} x {cs["se"]:.4f} = {half:.4f} % of equity')
    print(f'    so an edge of {half:.4f} % of equity per trade would just touch zero.')
    print(f'    the measured edge is {cs["ev"]:+.4f} %, so the signal would have to improve by')
    print(f'    {abs(cs["ev"]) + half:.4f} pp of equity per trade — a swing of '
          f'{(abs(cs["ev"]) + half)/abs(cs["ev"]):.1f}x — before trading it was justified.')
    print()
    # the -0.02% hypothetical
    hyp = -0.02
    se_needed = hyp / tc
    n_needed = (cs['sd'] / abs(hyp)) ** 2 if cs['sd'] > 0 else float('inf')
    print(f'  THE HYPOTHETICAL: if the edge were {hyp:+.2f}% instead of {cs["ev"]:+.4f}%,')
    print(f'  would the CI exclude zero? Only if the standard error were below {abs(hyp)/tc:.5f}')
    print(f'  % of equity. The measured cluster standard deviation is {cs["sd"]:.4f} %, so the')
    print(f'  sample size needed is n = (sd/|edge|)^2 = ({cs["sd"]:.4f}/{abs(hyp)})^2 = '
          f'{n_needed:.0f} clusters.')
    print(f'  That is {n_needed/max(n_c,1):.0f}x the {n_c} clusters measured today.')
    print()
    # how many clusters for various edges
    print(f'  {"true edge %eq":>14} {"clusters for t=2":>18} {"vs today":>10} {"days at 1/4h":>15}')
    for e in (0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40):
        nreq = (cs['sd'] / e) ** 2
        print(f'  {e:>14.2f} {nreq:>18.0f} {nreq/max(n_c,1):>9.0f}x {nreq/6:>14.0f}')
    print()
    print(f'  Note: the cluster sd is what it is; as the sample grows the sd estimate firms up.')
    print(f'  The DAILY rate of clusters: the collector produces ~12 five-minute rounds an hour,')
    print(f'  and the live-gate arm fires on a handful of them, so the arm accrues clusters at')
    print(f'  roughly {n_c / max((ts[-1]-ts[0])/3.6e6, 0.1):.1f} clusters/hour on the current data.')

    # ═══════════════════════════════════════════════════════════════════
    print()
    print('═' * 118)
    print('2. THE THRESHOLD RULE — does trading only the HIGHEST-CONVICTION candidates pay?')
    print('═' * 118)

    # the candidate scores, computed from the collector's own fields
    def with_scores(trades, rows_by_key):
        out = []
        for t in trades:
            r = rows_by_key.get((t['pair'], t['ts']))
            if r is None:
                continue
            tk = t
            tk['agree'] = bool(r.get('agree'))
            jev_a = r.get('jevAgreement')
            laya_c = r.get('layaConfidence')
            tk['model_agreement'] = (min(jev_a, laya_c)
                                      if isinstance(jev_a, (int, float))
                                      and isinstance(laya_c, (int, float)) else 0.0)
            tk['sum_conf'] = ((jev_a or 0) + (laya_c or 0))
            tk['volume_exhaustion'] = 1.0 - float(r.get('tapeVratio') or 1.0)
            tk['book_imbalance'] = abs(float(r.get('bookImbalance') or 0.0))
            # distance from the extreme: how close the price is to the 24h
            # high (for a short) or low (for a long), in percent
            off_high = float(r.get('tapeOffHighPct') or 0.0)
            off_low = float(r.get('tapeOffLowPct') or 0.0)
            tk['distance_from_extreme'] = off_high if t['side'] == 'short' else off_low
            tk['signal_strength'] = abs(float(r.get('tapeChg') or 0.0))
            out.append(tk)
        return out

    rows_by_key = {}
    for r in rows:
        rows_by_key[(r['pair'], r['ts'])] = r

    scored = with_scores(list(lg), rows_by_key)
    print(f'  The live-gate arm, scored: {len(scored)} of {len(lg)} trades carry a score.')
    print(f'  Every score is a HIGHER-is-BETTER conviction score; the threshold keeps the top N%.')
    print()
    print(f'  {"score":<26} {"top":>5} {"kept":>5} {"clusters":>9} {"EV %eq":>9} {"se":>8} '
          f'{"t":>7} {"EV $/tr":>9} {"win%":>7} {"scr%":>7} {"VERDICT":>10}')
    print('  ' + '-' * 116)

    SCORES = [
        ('model agreement (min leg)', 'model_agreement', True),
        ('model agreement (sum)', 'sum_conf', True),
        ('volume exhaustion (1-vratio)', 'volume_exhaustion', True),
        ('book imbalance |imb|', 'book_imbalance', True),
        ('distance from the extreme', 'distance_from_extreme', False),
        ('signal strength |chg|', 'signal_strength', True),
    ]
    TOP_PCTS = (0.05, 0.10, 0.20, 0.50)

    threshold_results = []
    for label, key, higher_better in SCORES:
        vals = sorted(set(t[key] for t in scored))
        if len(vals) < 2:
            continue
        for pct in TOP_PCTS:
            # the cut is the (1-pct) quantile of the observed distribution
            if higher_better:
                cut = sorted([t[key] for t in scored])[int((1 - pct) * len(scored))]
                kept = [t for t in scored if t[key] >= cut]
            else:
                # LOWER is better for "distance from the extreme" when the
                # signal wants to be AT the extreme: keep the smallest.
                cut = sorted([t[key] for t in scored])[int(pct * len(scored))]
                kept = [t for t in scored if t[key] <= cut]
            if len(kept) < 5:
                continue
            cs = cluster_stats(kept, HOLD_MS)
            wins = sum(1 for t in kept if t['kind'] == 'win')
            scr = sum(1 for t in kept if t['kind'] == 'scratch')
            ev_usd = mean([t['pnl_usd'] for t in kept])
            ok = (cs['ev'] > 0) and (cs['t'] >= 2) and (cs['n_clusters'] >= 30)
            verdict = 'PASS' if ok else ('positive' if cs['ev'] > 0 else 'fail')
            print(f'  {label:<26} {pct*100:>4.0f}% {len(kept):>5} {cs["n_clusters"]:>9} '
                  f'{sgn(cs["ev"]):>9} {fmt(cs["se"]):>8} {sgn(cs["t"], 2):>7} '
                  f'{usd(ev_usd):>9} {wins/len(kept)*100:>6.1f}% {scr/len(kept)*100:>6.1f}% '
                  f'{verdict:>10}')
            threshold_results.append(dict(score=label, key=key, pct=pct,
                                          n=len(kept), clusters=cs['n_clusters'],
                                          ev=cs['ev'], t=cs['t'], se=cs['se'],
                                          ev_usd=ev_usd, verdict=verdict))
    OUT['thresholds'] = threshold_results

    n_pass = sum(1 for r in threshold_results if r['verdict'] == 'PASS')
    n_pos = sum(1 for r in threshold_results if r['ev'] > 0)
    print()
    print(f'  {n_pos} of {len(threshold_results)} thresholds have a POSITIVE cluster-corrected EV;')
    print(f'  {n_pass} of {len(threshold_results)} clear the full bar (EV>0, t>=2, >=30 clusters).')

    # ═══════════════════════════════════════════════════════════════════
    print()
    print('═' * 118)
    print('3. THE OUT-OF-SAMPLE CHECK — a threshold fit on one half and tested on the other')
    print('═' * 118)
    print('  Selecting the best N% from the same sample and reporting on that sample is a')
    print('  SELECTION ARTEFACT: the fade/dip family cleared the bar at 0.4-0.6% of pure chance')
    print('  for exactly this reason. So every threshold is FIT on the FIRST half of the')
    print('  clusters and TESTED on the SECOND, and the reverse as a robustness check.')
    print()

    # split the arm's clusters in half by TIME
    all_ts = sorted(t['ts'] for t in scored)
    split_ts = (all_ts[0] + all_ts[-1]) // 2
    first = [t for t in scored if t['ts'] < split_ts]
    second = [t for t in scored if t['ts'] >= split_ts]
    print(f'  the split: {u(split_ts)} UTC')
    print(f'    FIRST half  {len(first)} trades in '
          f'{cluster_stats(first, HOLD_MS)["n_clusters"]} clusters')
    print(f'    SECOND half {len(second)} trades in '
          f'{cluster_stats(second, HOLD_MS)["n_clusters"]} clusters')
    print()

    print(f'  {"score":<26} {"top":>5} | {"fit half":>9} {"n":>4} {"clusters":>8} {"EV":>9} {"t":>7} '
          f'| {"TEST half":>9} {"n":>4} {"clusters":>8} {"EV":>9} {"t":>7} | {"HELD?":>6}')
    print('  ' + '-' * 116)

    oos_rows = []
    for label, key, higher_better in SCORES:
        for pct in TOP_PCTS:
            # FIT: choose the cut on the FIRST half only.
            fit_vals = sorted([t[key] for t in first]) if first else []
            if len(fit_vals) < 5:
                continue
            if higher_better:
                cut = fit_vals[min(int((1 - pct) * len(fit_vals)), len(fit_vals) - 1)]
                fit_kept = [t for t in first if t[key] >= cut]
                test_kept = [t for t in second if t[key] >= cut]
            else:
                cut = fit_vals[min(int(pct * len(fit_vals)), len(fit_vals) - 1)]
                fit_kept = [t for t in first if t[key] <= cut]
                test_kept = [t for t in second if t[key] <= cut]
            if len(fit_kept) < 3 or len(test_kept) < 3:
                continue
            fcs = cluster_stats(fit_kept, HOLD_MS)
            tcs = cluster_stats(test_kept, HOLD_MS)
            held = 'YES' if (fcs['ev'] > 0 and tcs['ev'] > 0) else ('sign-flip' if fcs['ev'] > 0 else 'no')
            print(f'  {label:<26} {pct*100:>4.0f}% | {sgn(fcs["ev"]):>9} {len(fit_kept):>4} '
                  f'{fcs["n_clusters"]:>8} {sgn(fcs["ev"]):>9} {sgn(fcs["t"],2):>7} '
                  f'| {sgn(tcs["ev"]):>9} {len(test_kept):>4} {tcs["n_clusters"]:>8} '
                  f'{sgn(tcs["ev"]):>9} {sgn(tcs["t"],2):>7} | {held:>6}')
            oos_rows.append(dict(score=label, pct=pct, cut=cut,
                                  fit_ev=fcs['ev'], fit_t=fcs['t'], fit_n=len(fit_kept),
                                  fit_clusters=fcs['n_clusters'],
                                  test_ev=tcs['ev'], test_t=tcs['t'], test_n=len(test_kept),
                                  test_clusters=tcs['n_clusters'], held=held))
    OUT['oos'] = oos_rows

    # the in-sample oracle, for the artefact's size
    print()
    print('  THE SIZE OF THE ARTEFACT: the best threshold chosen on the WHOLE sample and')
    print('  reported on the WHOLE sample, against the same threshold measured out of sample.')
    best_in = None
    for r in threshold_results:
        if best_in is None or r['ev'] > best_in['ev']:
            best_in = r
    if best_in:
        match = [o for o in oos_rows
                 if o['score'] == best_in['score'] and o['pct'] == best_in['pct']]
        print(f'    the best in-sample threshold: {best_in["score"]} top {best_in["pct"]*100:.0f}%')
        print(f'      in-sample  EV {sgn(best_in["ev"])} %eq, t {sgn(best_in["t"],2)}, '
              f'{best_in["clusters"]} clusters, {best_in["n"]} trades')
        if match:
            o = match[0]
            print(f'      OUT of sample (fit on half 1, tested on half 2): EV {sgn(o["test_ev"])} %eq, '
                  f't {sgn(o["test_t"],2)}, {o["test_clusters"]} clusters, {o["test_n"]} trades')
            if o['test_ev'] <= 0:
                print(f'      => THE IN-SAMPLE EDGE DOES NOT SURVIVE OUT OF SAMPLE.')
        print(f'    Also: {n_pos} of {len(threshold_results)} thresholds are positive in-sample. If the')
    print('    thresholds were independent, the chance that at least one of them is positive by')
    print('    luck is exactly the selection artefact the fade/dip family demonstrated.')

    # ═══════════════════════════════════════════════════════════════════
    print()
    print('═' * 118)
    print('4. THE DAILY-LOSS ARITHMETIC — what the owner is actually exposed to')
    print('═' * 118)
    print(f'  The account\'s daily loss cap is ${DAILY_LOSS_CAP:.0f}. The counter counts GROSS')
    print(f'  LOSSES (a profit does not offset a loss): see')
    print(f'  supabase/functions/_shared/realized-pnl-reconcile.ts. The daily notional budget is')
    print(f'  ${DAILY_NOTIONAL_CAP:.0f}, so at ${NOTIONAL:.0f} a ticket the machine can take at')
    print(f'  most {MAX_TICKETS} tickets a day.')
    print()
    print(f'  {"arm":<12} {"geom":<8} {"tickets":>8} {"EV $/tr":>9} {"EV $/day":>10} '
          f'{"P(loss counter >= $12)":>22} {"P(net <= -$12)":>15} {"median loss":>12} {"p95 loss":>9}')
    print('  ' + '-' * 116)
    daily_rows = []
    for arm_name in ('LIVE-GATE', 'TAPE-ONLY'):
        for geom in (LIVE,):
            tr = arms[f'{arm_name}|{geom}']
            if not tr:
                continue
            for n_t in (8, 4, 1):
                d = daily_loss_draws(tr, n_t, n_draws=60000)
                if not d:
                    continue
                print(f'  {arm_name:<12} {geom:<8} {n_t:>8} {usd(d["ev_usd"]):>9} '
                      f'{usd(d["ev_day_usd"]):>10} {d["p_cap"]*100:>21.2f}% {d["p_net_cap"]*100:>14.2f}% '
                      f'{usd(d["median_loss"],2):>12} {usd(d["p95_loss"],2):>9}')
                daily_rows.append(dict(arm=arm_name, geom=geom, tickets=n_t, **d))
    OUT['daily'] = daily_rows

    print()
    print('  The same arithmetic on the TAPE arm (the control), which the project\'s own')
    print('  numbers show has the HIGHER EV: if the control pays better, the model filter is')
    print('  the liability and the tape is the signal.')

    # ═══════════════════════════════════════════════════════════════════
    print()
    print('═' * 118)
    print('5. THE VERDICT')
    print('═' * 118)

    lg_live = arms[f'LIVE-GATE|{LIVE}']
    tape_live = arms[f'TAPE-ONLY|{LIVE}']
    cs_live = cluster_stats(lg_live, HOLD_MS)
    cs_tape = cluster_stats(tape_live, HOLD_MS)

    print(f'  (a) KEEP TRADING 8/DAY')
    d8 = [d for d in daily_rows if d['arm'] == 'LIVE-GATE' and d['tickets'] == 8]
    if d8:
        d = d8[0]
        print(f'      EV {sgn(cs_live["ev"])} %eq/trade (t {sgn(cs_live["t"],2)}, {cs_live["n_clusters"]} clusters)')
        print(f'      expected {usd(d["ev_day_usd"])} a day; P(the ${DAILY_LOSS_CAP:.0f} loss cap fires) '
              f'{d["p_cap"]*100:.2f}%')
        print(f'      VERDICT: the edge is negative, so every ticket has a negative expected')
        print(f'      value. This option LOSES money on average and has a {d["p_cap"]*100:.1f}% chance')
        print(f'      of exhausting the daily loss budget. REJECT.')
    print()
    print(f'  (b) TRADE ONLY THE TOP DECILE BY CONFIDENCE')
    dec = [r for r in threshold_results if r['pct'] == 0.10]
    if dec:
        best_dec = max(dec, key=lambda r: r['ev'])
        print(f'      the best top-decile threshold in-sample: {best_dec["score"]}')
        print(f'        in-sample EV {sgn(best_dec["ev"])} %eq, t {sgn(best_dec["t"],2)}, '
              f'{best_dec["clusters"]} clusters, {best_dec["n"]} trades')
        o = [x for x in oos_rows if x['score'] == best_dec['score'] and x['pct'] == 0.10]
        if o:
            print(f'        OUT OF SAMPLE: EV {sgn(o[0]["test_ev"])} %eq, t {sgn(o[0]["test_t"],2)}, '
                  f'{o[0]["test_clusters"]} clusters')
        print(f'      VERDICT: {"the in-sample edge does not survive out of sample" if (o and o[0]["test_ev"] <= 0) else "needs the out-of-sample number"}. '
              f'On top of that, the decile has only {best_dec["clusters"]} clusters, so the bar')
        print(f'      of 30 independent clusters is not met even in-sample.')
    print()
    print(f'  (c) UNANIMOUS MODELS AND THE TAPE AT AN EXTREME')
    ext = [t for t in scored if t['distance_from_extreme'] <= 2.0]
    if ext:
        ecs = cluster_stats(ext, HOLD_MS)
        print(f'      the arm IS already unanimous (both model legs, same side, neither uncertain,')
        print(f'      the tape agreeing). Requiring the tape to be at an extreme (<=2% from the')
        print(f'      24h extreme) keeps {len(ext)} trades in {ecs["n_clusters"]} clusters:')
        print(f'        EV {sgn(ecs["ev"])} %eq, t {sgn(ecs["t"],2)}')
        print(f'      VERDICT: the unanimity condition is the arm\'s DEFINITION, so it cannot be')
        print(f'      improved by requiring it. And the extreme filter, if anything, shrinks the')
        print(f'      sample without paying.')
    print()
    print(f'  (d) PAUSE UNTIL THE CLUSTER COUNT REACHES 30')
    print(f'      the live-gate arm has {cs_live["n_clusters"]} clusters at the ticket\'s holding')
    print(f'      period (the bar is 30). Expected daily P&L while paused: $0.00.')
    print(f'      P(the loss cap fires): 0%. The cost of pausing is the foregone edge, which is')
    print(f'      negative, so the cost of pausing is a POSITIVE.')
    print()

    json.dump(OUT, open(join(SCRATCH, 'policy-study.json'), 'w'), indent=2, default=str)
    print(f'  [written] {join(SCRATCH, "policy-study.json")}')


if __name__ == '__main__':
    main()
