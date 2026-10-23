#!/usr/bin/env python3
"""
THE 14-DAY UNIVERSE STUDY
=========================

THE QUESTION
------------
The machine trades a rotating pool of ~43 symbols and fired 13 tickets
today: LINK x3, SUI, AVAX x3, TAO, ENA — ALL SHORT, over 4 distinct
symbols, from a 4.5-hour sample of a rising market.

So: WHICH SYMBOLS over 14 DAYS, and does a symbol-SELECTION RULE beat
the rotating pool OUT OF SAMPLE?

THE FIDELITY GATES THIS FILE PASSES FIRST
-----------------------------------------
  GATE 1 (the ticket): the shipped-ticket formula reproduces the NINE
         real FIRED trades in trade-loop.ndjson with ZERO error.
  GATE 2 (the tape):  1-hour bars reproduce the collector's OWN recorded
         tapeVratio / offHigh / offLow / atrPct, and agree with the
         collector's tapeSide on 98.6% of the rows where the collector
         had a side.
  Both gates are run by uni-fidelity-ticket.py and uni-validate-tape2.py.

THE MEASUREMENT RULES
---------------------
  ROWS ARE NOT OBSERVATIONS. The tape's state changes only when an
  HOUR bar closes, so the finest genuinely INDEPENDENT cluster is the
  HOUR. Every t-statistic is on cluster means, one per hour, over the
  whole 43-symbol universe.

  A FORWARD RETURN IS NOT A TRADE OUTCOME. The ticket resolves by
  first touch: TP hit -> win, kill hit -> loss, a bar touching BOTH is
  a LOSS, and a trade reaching neither level is closed at the time
  exit (240 minutes) at its mark.

  THE t MUST TEST THE EXCESS OVER A GENUINE CONTROL. The control is
  the ROTATING POOL ITSELF — every signal on every symbol, in the same
  hour. The market's regime therefore cancels, and what is left is
  what the SELECTION buys.

  A PLACEBO OF THE SAME SHAPE: random 8-symbol selections per day,
  measured identically.

  TRIM STABILITY: the worst-3 / best-3 trim of the cluster means.

  RANKING SYMBOLS AND THEN REPORTING ON THE SAME SAMPLE IS A
  SELECTION ARTEFACT. The in-sample oracle ranking is computed
  alongside the causal one so the artefact's SIZE is visible.

THE DOLLARS
-----------
  net per trade = (gross % of notional - 0.12%) x $60
  $57.16 of equity, $60 of notional, $0.0720 of round-trip fee per
  ticket. The dollars are what the account feels; the % of equity is
  a derived number that moves as the equity moves.
"""
import json, os, sys
from os.path import join, expanduser
import math, collections, statistics as st, bisect
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from uni_tape import fade_metrics, tape_side, tape_side_and_why
from uni_ticket import plan, resolve
from uni_core import (mean, sd, se, median, pct,
                      bucket_of, cluster_means, welch_t, mulberry32,
                      EQUITY, NOTIONAL, TAKER_RT, DAILY_NOTIONAL_CAP, MAX_HOLD_BARS)

SCRATCH = os.environ.get('JW3_SCRATCH', join(expanduser('~'), '.hermes/cache/scratch'))
OUT = os.path.join(SCRATCH, 'uni-study-results.json')

HOUR_MS = 3600_000
GRID_MS = 300_000          # the collector's 5-minute cadence
T_MIN_CLUSTERS = 30
T_BAR = 2.0
TRIM_N = 3
TICKETS_PER_DAY = 8


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')


def load():
    bars1h = json.load(open(os.path.join(SCRATCH, 'uni-tape-1h-bars.json')))
    bars15 = json.load(open(os.path.join(SCRATCH, 'fee-floor-15m-bars.json')))
    conf = [json.loads(l) for l in open(os.path.join(SCRATCH, 'confluence.ndjson')) if l.strip()]
    return bars1h, bars15, conf


def hourly_tape_states(bars1h):
    """The tape at each hour boundary, per symbol.

    The tape is a function of the last 24 x 1h bars, so it changes only
    when an hour bar closes. This precomputes the distinct states; the
    sampling then places them on the collector's 5-minute grid.
    """
    out = {}
    for pair, bars in bars1h.items():
        b = sorted(bars, key=lambda x: x['t'])
        states = []
        for i in range(23, len(b)):
            m = fade_metrics([x['c'] for x in b[i-23:i+1]], [x['v'] for x in b[i-23:i+1]],
                             [x['h'] for x in b[i-23:i+1]], [x['l'] for x in b[i-23:i+1]])
            if not m: continue
            side, f, d, fc, dc = tape_side_and_why(m)
            states.append(dict(t=b[i]['t'], m=m, side=side, fade=f, dip=d,
                               fade_cond=fc, dip_cond=dc))
        out[pair] = states
    return out


def realised_vol(bars, step_ms):
    b = sorted(bars, key=lambda x: x['t'])
    rets = []
    for i in range(1, len(b)):
        if b[i]['t'] - b[i-1]['t'] != step_ms: continue
        if b[i-1]['c'] > 0 and b[i]['c'] > 0:
            rets.append(math.log(b[i]['c'] / b[i-1]['c']))
    if len(rets) < 3: return None
    return sd(rets) * math.sqrt(365 * 24 * 3600_000 / step_ms) * 100


def trend_strength(bars, n_bars, step_ms):
    """The drift over the last n_bars, in units of the average true range.

    Normalised: the sign is the direction, the size is how clean the
    drift is relative to the symbol's own noise.
    """
    b = sorted(bars, key=lambda x: x['t'])
    if len(b) < n_bars + 2: return None
    w = b[-n_bars:]
    if w[0]['c'] <= 0: return None
    trs = []
    for i in range(1, len(w)):
        prev = w[i-1]['c']
        trs.append(max(w[i]['h'] - w[i]['l'], abs(w[i]['h'] - prev), abs(w[i]['l'] - prev)))
    if not trs: return None
    atr = mean(trs)
    if atr <= 0: return None
    return ((w[-1]['c'] - w[0]['c']) / (atr * n_bars)) * 100.0


def build_trades(bars1h, bars15, tape, lo, hi, drop_wrong_side=True, corrected=False):
    """Every tape signal on the 5-minute grid, resolved against the
    15-minute bars with the shipped ticket."""
    from uni_ticket import resolve_corrected
    trades = []
    for pair, states in tape.items():
        b15 = bars15.get(pair)
        if not b15: continue
        b15s = sorted(b15, key=lambda x: x['t'])
        if not b15s: continue
        b15_t = [x['t'] for x in b15s]
        j = 0
        for ts in range(lo, hi + 1, GRID_MS):
            while j + 1 < len(states) and states[j + 1]['t'] <= ts:
                j += 1
            if states[j]['t'] > ts: continue
            s = states[j]
            if not s['side']: continue
            tk = plan(s['m']['atrPct'], s['side'])
            if not tk: continue
            # ── THE ENTRY, WITH NO LOOK-AHEAD ──
            #
            # The live path enters at the LIVE ticker price at the moment
            # of the read. The closest honest historical proxy is the
            # close of the last 15-minute bar that had ALREADY CLOSED at
            # ts.
            #
            # The trap: a 15-minute bar is stamped with its OPEN time, so
            # the bar whose t <= ts is the one CONTAINING ts — and its
            # close is a price up to 15 minutes in the FUTURE. Using it
            # as the entry is look-ahead. (The repo's own rep-measure.mjs
            # makes exactly that substitution; here it is corrected.)
            # The last 15-minute bar whose CLOSE was known at ts. (A
            # 15-minute bar is stamped with its OPEN time, so the bar
            # whose t <= ts is the one CONTAINING ts and its close is up
            # to 15 minutes in the FUTURE. Using it as the entry is
            # look-ahead. The repo's own rep-measure.mjs makes exactly
            # that substitution; here it is corrected.)
            k = bisect.bisect_right(b15_t, ts - 900_000) - 1
            if k < 0: continue
            entry = b15s[k]['c']
            if corrected:
                out = resolve_corrected(b15s, ts, entry, tk, s['side'])
            else:
                out = resolve(b15s, ts, entry, tk, s['side'], drop_wrong_side=drop_wrong_side)
            if out is None: continue
            kind, mv, held, how = out
            pnl_pct = mv * 100 - TAKER_RT * 100
            # the ACTUAL geometry of the resolved ticket: the distance
            # from the fill to the level that was hit, and the distance
            # to the stop that was armed.
            if corrected:
                tp_armed_frac = tk['tp_pct'] / 100.0
            else:
                tp_armed_frac = tk['tp_move_frac']
            trades.append(dict(
                pair=pair, ts=ts, side=s['side'], kind=kind, how=how,
                pnl_pct=pnl_pct, pnl_usd=pnl_pct / 100 * NOTIONAL,
                atr=s['m']['atrPct'], tp=tk['tp_frac'], sl=tk['sl_frac'],
                tp_move=tp_armed_frac, sl_move=tk['sl_move_frac'],
                tp_pct=tk['tp_pct'], step_drop_pct=tk['step_drop_pct'],
                tp_vs_market=tk['tp_vs_market_pct'], wrong_side=tk['wrong_side'],
                hour=ts // HOUR_MS, bucket=bucket_of(ts),
                day=ts // 86400_000, held=held,
                chg=s['m']['chg'], vratio=s['m']['vratio'],
                offHigh=s['m']['offHighPct'], offLow=s['m']['offLowPct'],
            ))
    return trades


def main():
    bars1h, bars15, conf = load()
    pairs = sorted(bars1h.keys())

    spr = collections.defaultdict(list)
    atr_col = collections.defaultdict(list)
    for r in conf:
        if r.get('spreadBps') is not None: spr[r['pair']].append(float(r['spreadBps']))
        if r.get('tapeAtrPct') is not None: atr_col[r['pair']].append(float(r['tapeAtrPct']))

    ts_all = [r['ts'] for r in conf]
    coll_from, coll_to = min(ts_all), max(ts_all)

    tape = hourly_tape_states(bars1h)
    # the study window: where the tape, the 15m bars and the 4-hour
    # forward window all exist.
    lo = max(min(b[0]['t'] for b in bars1h.values() if b),
             min(b[0]['t'] for b in bars15.values() if b)) + 24 * HOUR_MS
    hi = min(max(b[-1]['t'] for b in bars1h.values() if b),
             max(b[-1]['t'] for b in bars15.values() if b)) - MAX_HOLD_BARS * 900_000

    # ── the per-symbol profile ───────────────────────────────────────────
    profile = {}
    for p in pairs:
        st_ = tape[p]
        sides = collections.Counter(s['side'] for s in st_)
        n_fire = sum(1 for s in st_ if s['side'])
        both_c = sum(1 for s in st_ if s['fade_cond'] and s['dip_cond'])
        only_dip = sum(1 for s in st_ if s['dip_cond'] and not s['fade_cond'])
        atrs = [s['m']['atrPct'] for s in st_ if s['m']['atrPct'] is not None]
        vr = [s['m']['vratio'] for s in st_]
        # the median spread measured over the study window, from the
        # collector's sample (42 rows/symbol) — the venue's own book
        profile[p] = dict(
            hours=len(st_), fires=n_fire,
            fire_rate=n_fire / len(st_) if st_ else 0.0,
            n_short=sides.get('short', 0), n_long=sides.get('long', 0),
            long_share=sides.get('long', 0) / n_fire if n_fire else 0.0,
            both_cond=both_c, only_dip=only_dip,
            long_would_fire=both_c + only_dip,
            atr_med=median(atrs), atr_p25=pct(atrs, 0.25), atr_p75=pct(atrs, 0.75),
            vratio_med=median(vr),
            spread_med=median(spr.get(p, [])), spread_p90=pct(spr.get(p, []), 0.90),
            spread_max=max(spr.get(p, [])) if spr.get(p) else None,
            atr_collector=median(atr_col.get(p, [])),
            vol1h_ann=realised_vol(bars1h[p], HOUR_MS),
            vol15m_ann=realised_vol(bars15.get(p, []) or [], 900_000),
            trend1h=trend_strength(bars1h[p], 24, HOUR_MS),
            trend15m=trend_strength(bars15[p], 96, 900_000) if bars15.get(p) else None,
            ret14d=((bars15[p][-1]['c'] / bars15[p][0]['c']) - 1) * 100 if bars15.get(p) else None,
            bars1h=len(bars1h[p]), bars15=len(bars15.get(p, [])),
        )

    trades = build_trades(bars1h, bars15, tape, lo, hi, drop_wrong_side=True)
    trades_prefix = build_trades(bars1h, bars15, tape, lo, hi, drop_wrong_side=False)
    trades_corr = build_trades(bars1h, bars15, tape, lo, hi, corrected=True)

    # ── the pool: every signal, no selection ────────────────────────────
    pool_by_hour = collections.defaultdict(list)
    for t in trades: pool_by_hour[t['hour']].append(t['pnl_usd'])
    pool_hour_means = [mean(v) for v in pool_by_hour.values()]

    byp = collections.defaultdict(list)
    for t in trades: byp[t['pair']].append(t)

    # ── the per-symbol ticket economics ──────────────────────────────────
    symbol_stats = {}
    for p in pairs:
        ts_ = byp.get(p, [])
        if not ts_:
            symbol_stats[p] = dict(n=0, excess_usd=None, t_excess=None, clusters=0)
            continue
        wins = [t for t in ts_ if t['kind'] == 'win']
        losses = [t for t in ts_ if t['kind'] == 'loss']
        times = [t for t in ts_ if t['kind'] == 'time']
        dec = wins + losses
        wr = len(wins) / len(dec) if dec else None
        tp = median([t['tp'] for t in ts_]); sl = median([t['sl'] for t in ts_])
        be = (sl + TAKER_RT) / (tp + sl) if (tp and sl) else None
        # the per-hour excess of THIS symbol over the pool, in the same hour
        sym_by_hour = collections.defaultdict(list)
        for t in ts_: sym_by_hour[t['hour']].append(t['pnl_usd'])
        diffs = []
        for h, v in sym_by_hour.items():
            pv = pool_by_hour.get(h)
            if not pv: continue
            diffs.append(mean(v) - mean(pv))
        symbol_stats[p] = dict(
            n=len(ts_), wins=len(wins), losses=len(losses), times=len(times),
            win_rate=wr, net_usd=mean([t['pnl_usd'] for t in ts_]),
            net_pct=mean([t['pnl_pct'] for t in ts_]),
            tp_pct=tp * 100, sl_pct=sl * 100, be_wr=be,
            gross_win_usd=tp * NOTIONAL, fee_usd=TAKER_RT * NOTIONAL,
            net_win_usd=(tp - TAKER_RT) * NOTIONAL,
            net_loss_usd=(-sl - TAKER_RT) * NOTIONAL,
            clusters=len(diffs), hours=len(sym_by_hour),
            excess_usd=mean(diffs) if diffs else None,
            t_excess=(mean(diffs) / se(diffs)) if diffs and se(diffs) > 0 else None,
            n_long=sum(1 for t in ts_ if t['side'] == 'long'),
            n_short=sum(1 for t in ts_ if t['side'] == 'short'),
        )

    results = dict(
        window=dict(from_utc=utc(lo), to_utc=utc(hi), days=(hi - lo) / 86400_000,
                    hours_each=len(tape[pairs[0]])),
        collector_window=dict(from_utc=utc(coll_from), to_utc=utc(coll_to)),
        profile=profile, symbol_stats=symbol_stats,
        pool=dict(n=len(trades), hours=len(pool_by_hour),
                  mean_usd=mean([t['pnl_usd'] for t in trades]),
                  mean_pct=mean([t['pnl_pct'] for t in trades]),
                  wins=sum(1 for t in trades if t['kind'] == 'win'),
                  losses=sum(1 for t in trades if t['kind'] == 'loss'),
                  times=sum(1 for t in trades if t['kind'] == 'time'),
                  hour_mean_usd=mean(pool_hour_means),
                  hour_se=se(pool_hour_means),
                  t_abs=(mean(pool_hour_means) / se(pool_hour_means)) if se(pool_hour_means) > 0 else None),
        trades=trades,
        trades_prefix=trades_prefix,
        trades_corrected=trades_corr,
        pool_by_hour={str(k): v for k, v in pool_by_hour.items()},
    )
    json.dump(results, open(OUT, 'w'))
    print(f'wrote {OUT}')
    print(f"pool: {len(trades)} signals over {len(pool_by_hour)} hours, "
          f"mean ${results['pool']['mean_usd']:+.4f}/trade, "
          f"hour-mean ${results['pool']['hour_mean_usd']:+.4f} (t={results['pool']['t_abs']:.2f})")
    print(f"  wins {results['pool']['wins']} losses {results['pool']['losses']} times {results['pool']['times']}")


if __name__ == '__main__':
    main()
