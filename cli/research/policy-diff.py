#!/usr/bin/env python3
"""
THE DIFF — a literal port of `research/test-scratch-artefact.mjs`,
compared TRADE BY TRADE with `policy_core.py`.

If the two disagree, the policy study is measuring a different trade
than the repo publishes, and every number in it is wrong. This file
exists so that disagreement is impossible to miss.
"""
import json
import os
import sys
import bisect
from os.path import join

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import policy_core as pc

# ── VERBATIM constants from test-scratch-artefact.mjs ────────────────────
ATR_MULT_STOP = 0.9
ATR_CLAMP_LO = 0.6
ATR_CLAMP_HI = 1.5
TP_ATR_MULT = 0.4
TP_CLAMP_LO = 0.3
TP_CLAMP_HI = 0.5
BARS_BEFORE = 16
EQUITY_JS = 57.1579522047
NOTIONAL = 60.0
RHO_JS = NOTIONAL / EQUITY_JS
ROUND_TRIP = 0.0012


def liveGateSide(r):
    jev = r.get('jevSide')
    laya = r.get('layaSide')
    if not jev or jev == 'flat' or r.get('jevUncertain') is True:
        return None
    if not laya or laya == 'flat':
        return None
    if jev != laya:
        return None
    return jev


def ticketFor(r):
    atrPct = float(r['tapeAtrPct'])
    last = float(r['price'])
    if not (atrPct > 0) or not (last > 0):
        return None
    d = min(max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI)
    tpPct = min(max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI)
    long = r['tapeSide'] == 'long'
    avgEntry = last * (1 - d / 200) if long else last * (1 + d / 200)
    stopFrac = (3 * d) / (200 + d)
    tpFrac = tpPct / 100
    return dict(
        atrPct=atrPct, d=d, tpPct=tpPct, stopFrac=stopFrac, tpFrac=tpFrac,
        avgEntry=avgEntry, last=last, long=long,
        stopPrice=avgEntry * (1 - stopFrac) if long else avgEntry * (1 + stopFrac),
        targetPrice=avgEntry * (1 + tpFrac) if long else avgEntry * (1 - tpFrac),
    )


def resolve_js(r, ticket, rule, bars):
    b = bars.get(r['pair'])
    if not b:
        return None
    ts_list = b['_t']
    i = bisect.bisect_right(ts_list, r['ts'])
    if i >= len(ts_list):
        return None
    end = min(len(ts_list), i + BARS_BEFORE)
    if end - i < 2:
        return None
    long = ticket['long']
    tpWrongSide = ticket['targetPrice'] < ticket['last'] if long else ticket['targetPrice'] > ticket['last']
    for k in range(i, end):
        bar = b['bars'][k]
        hitTp = bar['h'] >= ticket['targetPrice'] if long else bar['l'] <= ticket['targetPrice']
        hitSl = bar['l'] <= ticket['stopPrice'] if long else bar['h'] >= ticket['stopPrice']
        if hitTp and hitSl:
            return dict(outcome='loss', pnlPct=-ticket['stopFrac'] - ROUND_TRIP)
        if hitSl:
            return dict(outcome='loss', pnlPct=-ticket['stopFrac'] - ROUND_TRIP)
        if hitTp:
            if rule == 'old':
                return dict(outcome='win', pnlPct=ticket['tpFrac'] - ROUND_TRIP)
            if not tpWrongSide:
                return dict(outcome='win', pnlPct=ticket['tpFrac'] - ROUND_TRIP)
            return dict(outcome='scratch' if tpWrongSide else 'win', pnlPct=0 - ROUND_TRIP)
    lastBar = b['bars'][end - 1]
    movePct = ((lastBar['c'] - ticket['avgEntry']) / ticket['avgEntry'] if long
               else (ticket['avgEntry'] - lastBar['c']) / ticket['avgEntry'])
    return dict(outcome='time', pnlPct=movePct - ROUND_TRIP)


def main():
    rows = pc.read_rows(join(pc.SCRATCH, 'confluence.ndjson'))
    bars = pc.read_bars(join(pc.SCRATCH, 'fee-floor-15m-bars.json'))
    pc.BARS = bars   # policy_core.simulate reads the module global
    tape = [r for r in rows if r.get('tapeSide')]
    live = [r for r in tape if liveGateSide(r) == r['tapeSide']]

    print('=' * 100)
    print('THE DIFF — a literal port of test-scratch-artefact.mjs vs policy_core.py')
    print('=' * 100)

    for arm_name, arm in (('LIVE-GATE', live), ('TAPE-ONLY', tape)):
        js = {}
        for r in arm:
            t = ticketFor(r)
            if not t:
                continue
            o = resolve_js(r, t, 'correct', bars)
            if not o:
                continue
            js[(r['pair'], r['ts'])] = (o['outcome'], o['pnlPct'])

        mine = {}
        for t in pc.simulate(arm, pc.SHIPPED):
            mine[(t['pair'], t['ts'])] = (t['kind'], t['pnl_frac'])

        common = set(js) & set(mine)
        only_js = set(js) - set(mine)
        only_mine = set(mine) - set(js)
        outcome_diff = []
        pnl_diff = []
        for k in common:
            o1, p1 = js[k]
            o2, p2 = mine[k]
            if o1 != o2:
                outcome_diff.append((k, o1, o2))
            if abs(p1 - p2) > 1e-9:
                pnl_diff.append((k, p1, p2))
        print(f'\n  {arm_name}: js {len(js)} trades | mine {len(mine)} trades | '
              f'common {len(common)}')
        print(f'    only in js: {len(only_js)} | only in mine: {len(only_mine)}')
        print(f'    OUTCOME differences: {len(outcome_diff)}')
        print(f'    P&L differences:     {len(pnl_diff)}')
        for k in list(only_mine)[:5]:
            print(f'      only mine: {k} -> {mine[k]}')
        for k in list(only_js)[:5]:
            print(f'      only js:   {k} -> {js[k]}')
        for k, o1, o2 in outcome_diff[:8]:
            print(f'      outcome: {k} js={o1} mine={o2}')
        for k, p1, p2 in pnl_diff[:8]:
            print(f'      pnl:     {k} js={p1:.8f} mine={p2:.8f} diff={p2-p1:+.2e}')

        # the clustered EV, both ways
        def clustered(d):
            import collections
            by = collections.defaultdict(list)
            for (pair, ts), (o, p) in d.items():
                by[ts // 300_000].append(p * RHO_JS * 100)
            cms = [sum(v) / len(v) for v in by.values()]
            m = sum(cms) / len(cms)
            if len(cms) > 1:
                sd = (sum((x - m) ** 2 for x in cms) / (len(cms) - 1)) ** 0.5
                se = sd / (len(cms) ** 0.5)
            else:
                se = 0.0
            return len(cms), m, se, (m / se if se > 0 else 0.0)

        print(f'    js    clustered (5 min): n {clustered(js)[0]} EV {clustered(js)[1]:+.4f} '
              f'se {clustered(js)[2]:.4f} t {clustered(js)[3]:+.2f}')
        print(f'    mine  clustered (5 min): n {clustered(mine)[0]} EV {clustered(mine)[1]:+.4f} '
              f'se {clustered(mine)[2]:.4f} t {clustered(mine)[3]:+.2f}')
        # the plain per-trade mean
        print(f'    js    plain mean: {sum(p for _, p in js.values())/len(js):+.4f} %eq')
        print(f'    mine  plain mean: {sum(p for _, p in mine.values())/len(mine):+.4f} %eq')


if __name__ == '__main__':
    main()
