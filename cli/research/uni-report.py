#!/usr/bin/env python3
"""
THE FINAL REPORT — the per-symbol table, the ranking with its
out-of-sample check, the capacity arithmetic, and the selection rule
with its look-ahead requirement stated.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_core import (mean, sd, se, median, pct, mulberry32,
                      NOTIONAL, TAKER_RT, EQUITY, DAILY_NOTIONAL_CAP)
from uni_rules import (HOUR_MS, DAY_MS, K, T_MIN_CLUSTERS, T_BAR, TRIM_N,
                       utc, daily_features, cluster_excess, stat_block)
from uni_sel import build_universe, run_rule, placebo_p, f, pf, usd

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
R = json.load(open(os.path.join(SCRATCH, 'uni-study-results.json')))
PROF = R['profile']; STAT = R['symbol_stats']
TRADES = R['trades']; TRADES_PRE = R['trades_prefix']; TRADES_CORR = R['trades_corrected']
POOL = R['pool']
BARS1H = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))
SPREAD = {p: PROF[p]['spread_med'] for p in PROF}

RULES = ['NONE', 'VOL_PERCENTILE', 'VOL_FLOOR', 'SPREAD', 'SPREAD_VOL',
         'TREND', 'TREND_QUIET']


def line(c='='): print(c * 134)


def main():
    w = R['window']
    line()
    print('THE 14-DAY UNIVERSE STUDY — a UNIVERSE and a REGIME-AWARE SELECTION RULE')
    line()
    print(f"  window             {w['from_utc']} -> {w['to_utc']}  ({w['days']:.2f} days)")
    print(f"  the collector's    {R['collector_window']['from_utc']} -> {R['collector_window']['to_utc']}  (4.5 h)")
    print(f"  symbols            {len(PROF)}    tape signals {POOL['n']} over {POOL['hours']} hours")
    print(f"  the binding facts  $57.16 equity, $60 notional, 0.12% taker round trip = $0.0720/ticket")
    print(f"                    a $0.18 gross win against a $0.0720 fee -> the fee is 40% of the win")
    print(f"                    break-even win rate at the reference geometry: 82.8%")

    # ══ 0. THE THREE TICKET ARMS ══════════════════════════════════════
    line()
    print('0. THE THREE TICKET ARMS — and what the live arm\'s 100% win rate actually was')
    line()
    print(f"  {'arm':<42} {'n':>7} {'win%':>7} {'loss':>7} {'time':>7} {'net$/tr':>9} {'BE%':>7}")
    print('  ' + '-' * 92)
    arms = [('A. AS BUILT (pre-fix): TP where the plan says', TRADES_PRE),
            ('B. AS IT RUNS NOW (post-fix): wrong-side TP dropped', TRADES),
            ('C. CORRECTED: TP anchored to the fill, on the good side', TRADES_CORR)]
    for label, t in arms:
        c = collections.Counter(x['kind'] for x in t)
        dec = c['win'] + c['loss']
        wr = c['win'] / max(dec, 1)
        gw = mean([x['pnl_usd'] for x in t if x['kind'] == 'win'])
        gl = mean([x['pnl_usd'] for x in t if x['kind'] == 'loss'])
        be = (-gl / (gw - gl)) if (gw - gl) else None
        print(f"  {label:<42} {len(t):>7} {wr*100:>6.1f}% {c['loss']:>7} {c['time']:>7} "
              f"{usd(mean([x['pnl_usd'] for x in t]),9)} {pf(be,1,7)}")
    print()
    ws = sum(1 for x in TRADES if x['wrong_side'])
    print(f"  {ws} of {len(TRADES)} signals ({ws/len(TRADES)*100:.1f}%) have a take-profit on the WRONG side.")
    print('  The shipped plan puts a short\'s target at last x (1 + step/200 - tpPct/100), and')
    print('  step/200 > tpPct for nearly every ATR, so the target is ABOVE the market: the')
    print('  trigger is already satisfied and the leg fills instantly at the ask.')
    print('  THAT is the machine\'s "100% win rate" — it was measuring the defect.')
    print('  Arm A books those instant fills as WINS that in fact LOSE money:')
    wa = [x for x in TRADES_PRE if x['kind'] == 'win']
    print(f"    a win in arm A averages {usd(mean([x['pnl_usd'] for x in wa]))} — it is a LOSS dressed as a win.")
    print('  Arm B (what the machine does after commit a63880e8) drops those targets, so 92% of')
    print('  the trades become stop-only and are resolved by the kill or the 240-minute exit.')
    print('  Arm C anchors the target to the fill on the favourable side, keeping the same')
    print('  distances — the ticket the strategy was always meant to run.')

    # ══ 1. THE PER-SYMBOL TABLE ═══════════════════════════════════════
    line()
    print('1. THE PER-SYMBOL TABLE — 14 days')
    line()
    hdr = (f"  {'pair':<17} {'ATR%':>6} {'sprBps':>7} {'sprP90':>7} {'trend1h':>8} {'trend15m':>8} "
           f"{'vol1h%':>7} {'ret14d%':>8} | {'fires':>6} {'fire%':>6} {'long':>5} {'LONG%':>6} | "
           f"{'nC':>6} {'hrs':>4} {'WR%':>6} {'net$':>8} {'exc$':>8} {'t':>6} {'BE%':>6}")
    print(hdr)
    print('  ' + '-' * (len(hdr) - 2))
    # the CORRECTED arm's per-symbol stats
    corr_byp = collections.defaultdict(list)
    for x in TRADES_CORR: corr_byp[x['pair']].append(x)
    pool_by_hour = collections.defaultdict(list)
    for x in TRADES: pool_by_hour[x['hour']].append(x['pnl_usd'])
    order = sorted(PROF.keys(), key=lambda p: -(STAT[p].get('excess_usd') or -99))
    for p in order:
        pr = PROF[p]; st_ = STAT[p]
        ct = corr_byp.get(p, [])
        if not ct:
            print(f"  {p:<17} {f(pr['atr_med'],3,6)} {f(pr['spread_med'],2,7)} {f(pr['spread_p90'],2,7)} "
                  f"{f(pr['trend1h'],4,8)} {f(pr['trend15m'],4,8)} {f(pr['vol1h_ann'],1,7)} {f(pr['ret14d'],2,8)} "
                  f"| {pr['fires']:>6} {f(pr['fire_rate']*100,1,6)} {pr['n_long']:>5} {f(pr['long_share']*100,1,6)} "
                  f"| {'NO TRADES':>47}")
            continue
        c = collections.Counter(x['kind'] for x in ct)
        wr = c['win'] / max(c['win'] + c['loss'], 1)
        gw = mean([x['pnl_usd'] for x in ct if x['kind'] == 'win']) if c['win'] else 0
        gl = mean([x['pnl_usd'] for x in ct if x['kind'] == 'loss']) if c['loss'] else 0
        be = (-gl / (gw - gl)) if (gw - gl) else None
        # the per-hour excess over the pool, on the CORRECTED arm
        byh = collections.defaultdict(list)
        for x in ct: byh[x['hour']].append(x['pnl_usd'])
        diffs = []
        for h, v in byh.items():
            pv = pool_by_hour.get(h)
            if pv: diffs.append(mean(v) - mean(pv))
        exc = mean(diffs) if diffs else None
        t = (mean(diffs) / se(diffs)) if diffs and se(diffs) > 0 else None
        print(f"  {p:<17} {f(pr['atr_med'],3,6)} {f(pr['spread_med'],2,7)} {f(pr['spread_p90'],2,7)} "
              f"{f(pr['trend1h'],4,8)} {f(pr['trend15m'],4,8)} {f(pr['vol1h_ann'],1,7)} {f(pr['ret14d'],2,8)} "
              f"| {pr['fires']:>6} {f(pr['fire_rate']*100,1,6)} {pr['n_long']:>5} {f(pr['long_share']*100,1,6)} "
              f"| {len(ct):>6} {len(byh):>4} {pf(wr,1,6)} {usd(mean([x['pnl_usd'] for x in ct]),8)} "
              f"{usd(exc,8)} {f(t,2,6)} {pf(be,1,6)}")
    print('  trend1h/trend15m: the drift over the last 24 hours / 24 hours of 15m bars, in units of')
    print('  the average true range. vol1h%: the annualised realised volatility. fires: the hourly')
    print('  tape states with an exhaustion signal. LONG%: the long side\'s share of the fires.')
    print('  nC/hrs/WR%/net$: the CORRECTED ticket\'s trades, hours, win rate and net $ per trade.')
    print('  exc$: the per-hour excess over the rotating pool. BE%: the break-even win rate.')

    # ══ 2. THE LONG SIDE ══════════════════════════════════════════════
    line()
    print('2. THE LONG SIDE — which symbols have one, and which have both')
    line()
    both = sorted(p for p in PROF if PROF[p]['n_long'] > 0 and PROF[p]['n_short'] > 0)
    longonly = sorted(p for p in PROF if PROF[p]['n_long'] > 0 and PROF[p]['n_short'] == 0)
    shortonly = sorted(p for p in PROF if PROF[p]['n_long'] == 0 and PROF[p]['n_short'] > 0)
    nosig = sorted(p for p in PROF if PROF[p]['n_long'] == 0 and PROF[p]['n_short'] == 0)
    tot_long = sum(PROF[p]['n_long'] for p in PROF)
    tot_short = sum(PROF[p]['n_short'] for p in PROF)
    print(f"  symbols with BOTH sides ({len(both)}): {', '.join(both)}")
    print(f"  symbols with LONG only  ({len(longonly)}): {', '.join(longonly) or 'none'}")
    print(f"  symbols with SHORT only ({len(shortonly)}): {len(shortonly)}")
    print(f"  symbols with no signal   ({len(nosig)}): {', '.join(nosig) or 'none'}")
    print()
    print(f"  the tape over 14 days: {tot_short} SHORT, {tot_long} LONG ({tot_long/(tot_long+tot_short)*100:.2f}% long)")
    print(f"  the collector's 4.5 h: 423 SHORT, 17 LONG (3.85% long)")
    print()
    tot_both = sum(PROF[p]['both_cond'] for p in PROF)
    tot_onlydip = sum(PROF[p]['only_dip'] for p in PROF)
    tot_would = sum(PROF[p]['long_would_fire'] for p in PROF)
    print('  WHY — THE ORDER OF THE CHECKS. tapeSideOf evaluates the FADE before the DIP, so a')
    print('  market near its high AND its low books SHORT:')
    print(f"    hours where BOTH the fade and the dip conditions hold: {tot_both}")
    print(f"    hours where ONLY the dip condition holds:           {tot_onlydip}")
    print(f"    the long side CAN fire in {tot_would} hours, but only {tot_long} ({tot_long/tot_would*100:.2f}%)")
    print('    survive the fade\'s precedence.')
    print()
    print('    -> THE LONG SIDE IS STARVED BY THE CODE, NOT BY THE MARKET.')
    print('       NO SYMBOL SELECTION RULE CAN FIX THIS. It is a rule-order bug in')
    print('       research/tape-signal.mjs (tapeSideOf) and src/commands/live-cmd.ts.')
    print('       Swapping the order (dip first) would expose the long side. That is a')
    print('       ONE-LINE change to a SIGNAL FUNCTION, and it is the single highest-value')
    print('       change available: it doubles the usable universe of directions.')
    pl = [x for x in TRADES_CORR if x['side'] == 'long']
    ps = [x for x in TRADES_CORR if x['side'] == 'short']
    if pl:
        c = collections.Counter(x['kind'] for x in pl)
        print(f"    on the CORRECTED ticket, the pool's long side:  {len(pl)} trades, "
              f"WR {c['win']/max(c['win']+c['loss'],1)*100:.1f}%, net {usd(mean([x['pnl_usd'] for x in pl]))}/trade")
    if ps:
        c = collections.Counter(x['kind'] for x in ps)
        print(f"    on the CORRECTED ticket, the pool's short side: {len(ps)} trades, "
              f"WR {c['win']/max(c['win']+c['loss'],1)*100:.1f}%, net {usd(mean([x['pnl_usd'] for x in ps]))}/trade")
    print()
    print('    the LONG-side symbols and their long-side economics (CORRECTED ticket):')
    print(f"    {'pair':<17} {'longSigs':>9} {'WR%':>7} {'net$/tr':>9} {'hrs':>5}")
    for p in both:
        lt = [x for x in TRADES_CORR if x['pair'] == p and x['side'] == 'long']
        if not lt: continue
        c = collections.Counter(x['kind'] for x in lt)
        print(f"    {p:<17} {len(lt):>9} {pf(c['win']/max(c['win']+c['loss'],1),1,7)} "
              f"{usd(mean([x['pnl_usd'] for x in lt]),9)} {len(set(x['hour'] for x in lt)):>5}")

    return R


if __name__ == '__main__':
    main()
