#!/usr/bin/env python3
"""MEASURE THE THREE NEW ARMS before any of them touches money.

The owner asked for: lower leverage with higher profit targets, a
compounding logic, and a DCA logic with multiple steps inside a single
trade.

This script does NOT ship any of them. It MEASURES them against the
same evidence bar the live gate uses, because two of the three have
already been measured once and refused:

  - WIDER TARGETS were measured (geo1): 42.9 days, 121,329 signals,
    0 of 69 wide-target combinations cleared the bar, best row
    -$0.0297 at t=-1.35. So the "higher profit target" arm must be
    re-measured with the CURRENT fee and the CURRENT fill rule, not
    assumed from the old run.
  - A DCA LADDER of resting limits cannot be protected: the exit legs
    are venue-native conditionals that attach to a POSITION, and a
    resting limit has no position until it fills. So a ladder as an
    ENTRY is not measurable here — it is forbidden. The measurable
    version is a SCALE-OUT of a FILLED position, which is protected,
    and that is what this script measures.
  - COMPOUNDING is already mechanical: the sizing engine takes the
    risk budget as a PERCENT OF EQUITY, so every trade sizes on the
    CURRENT balance. What compounding changes is the RETURN, and the
    return is what is negative. So this script measures the ARMS'
    returns, and separately reports what compounding would do to each
    arm's equity curve (including the fee drag of more, smaller
    trades, which compounding always pays).

THE HOUSE BAR, unchanged from the live gate:
  a candidate must clear FOUR things to be an EDGE
    1. the excess over the unconditional control is positive
    2. t on the cluster means is >= 2
    3. at least 30 INDEPENDENT 240-minute hold clusters
    4. the arm's OWN net EV clears the FEE FLOOR

THE FILL RULE is the shared one (research/ticket-fill.mjs), in Python:
  - a take-profit on the WRONG SIDE of the market is a SCRATCH: it
    fills instantly at the touch, so the gross is ~zero minus the fee
  - a bar touching BOTH the target and the stop books the LOSS
  - a trade that lives out its hold exits at the mark

THE INDEPENDENT UNIT is the ticket's full 240-minute holding period.
The 15-minute bars mean 16 bars per hold. Signals are clustered by the
240-minute bucket they start in, so two signals 4 minutes apart are
ONE independent observation, not two.

Run: python3 geo4-newarms.py
"""

import collections
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

GEO = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, GEO)

from core import (  # noqa: E402
    build_signals,
    coverage_cut,
    load_bars,
    resolve_many,
    tape_states,
)

SCRATCH = os.path.join(os.path.expanduser("~"), ".hermes/cache/scratch")
BARS_1H = os.path.join(SCRATCH, "cont-1h-bars.json")
BARS_15M = os.path.join(SCRATCH, "cont-15m-bars.json")

# ── THE HOUSE CONSTANTS ────────────────────────────────────────────────
TAKER_RT_PCT = 0.12          # the venue's taker round trip, percent of notional
EQUITY_USD = 56.35           # the account's free margin
NOTIONAL_USD = 60.0          # the ticket's notional
HOLD_BARS = 16               # 16 x 15-minute bars = 240 minutes
HOLD_MS = 240 * 60_000
CLUSTER_MS = HOLD_MS
MIN_CLUSTER_BAR = 30
BAR_MIN = 15
GRID_MS = 5 * 60_000
MIN_CLUSTER_T = 2.0

# the fee floor, in % OF EQUITY per trade — the same units as the EV
FEE_FLOOR_PCT = TAKER_RT_PCT * (NOTIONAL_USD / EQUITY_USD)
FEE_FRAC = TAKER_RT_PCT / 100.0


def load_pairs(bars_1h, bars_15m):
    """The symbols that have BOTH a tape history and a resolution
    history.

    THE UNION, NOT THE INTERSECTION. The intersection is what one
    short-history symbol decides: inside a 45-day set, one symbol with
    5 days of history collapses the intersection to 3 days and throws
    away 92% of the sample.
    """
    common = sorted(set(bars_1h) & set(bars_15m))
    if not common:
        return [], (0, 0)
    keep, dropped, union_lo, union_hi = coverage_cut(
        bars_1h, bars_15m, common, min_days=0.0
    )
    if union_hi - union_lo < HOLD_MS * MIN_CLUSTER_BAR:
        return [], (union_lo, union_hi)
    return keep, (union_lo, union_hi)


def prepare(by_pair, bars):
    """The per-symbol arrays the vectorised resolution needs.

    A signal is the tuple (pair, ts_ms, side, entry, direction, idx)
    from core.build_signals. The resolution starts at the FIRST bar
    STRICTLY AFTER the signal, so the entry bar is never the signal
    bar and the entry is never look-ahead.
    """
    out = {}
    for p, ss in by_pair.items():
        bb = bars[p]
        idx = np.searchsorted(bb.t, np.array([x[1] for x in ss]), side="right")
        ok = idx < bb.n
        ss2 = [x for x, o in zip(ss, ok) if o]
        idx = idx[ok]
        out[p] = (
            bb,
            idx,
            np.array([x[3] for x in ss2], dtype=float),
            np.array([x[2] == "long" for x in ss2]),
            np.array([x[1] for x in ss2], dtype=float),
            np.array([x[2] for x in ss2]),
        )
    return out


def cluster_of(ts, lo):
    """The independent cluster a signal belongs to: the 240-minute
    bucket it starts in."""
    return int((ts - lo) // CLUSTER_MS)


def resolve_arm(prepared, lo, tp_frac, sl_frac, hold_bars, scale_steps=None):
    """Resolve every signal with the shared rule and return
    (cluster, gross_fraction_of_notional) per trade.

    `scale_steps` is the SCALE-OUT geometry: a list of (fraction of the
    position taken, tp_frac_at_that_step). The position is closed in
    slices — the first target reached takes its slice, and the REST of
    the position keeps running to the next target or to the stop.

    That is a ladder of PROFIT targets on a position that ALREADY
    EXISTS, which is protected — unlike a ladder of resting ENTRY
    limits, which has no position until it fills and therefore cannot
    be protected at all.
    """
    outcomes = []
    for p, (bb, idx, entry, is_long, ts, sides) in prepared.items():
        if len(idx) == 0:
            continue
        codes, gross, mae, used = resolve_many(
            bb, idx, entry, is_long, tp_frac, sl_frac, hold_bars
        )
        for j in range(len(codes)):
            e = entry[j]
            tp_price = e * (1.0 + tp_frac) if is_long[j] else e * (1.0 - tp_frac)
            # THE SCRATCH RULE (the shared one): a target on the WRONG
            # SIDE of the market fills instantly at the touch, so the
            # gross is ~zero minus the fee.
            wrong_side = (tp_price <= e) if is_long[j] else (tp_price >= e)
            if wrong_side:
                outcomes.append((cluster_of(ts[j], lo), -FEE_FRAC))
                continue
            c = int(codes[j])
            if scale_steps:
                # THE SCALE-OUT NEEDS ITS OWN BAR WALK, because the
                # vectorised resolver knows only ONE target and a
                # scale-out has several. Resolving it with the outer
                # target alone makes every slice identical to the
                # shipped arm — which is a defect in the ARM SPEC, not
                # a finding about scale-outs.
                g = scale_out_walk(
                    bb, int(idx[j]), entry[j], bool(is_long[j]),
                    tp_frac, sl_frac, hold_bars, scale_steps,
                )
            elif c == 0:
                g = tp_frac
            elif c == 1:
                g = -sl_frac
            else:
                g = 0.0
            outcomes.append((cluster_of(ts[j], lo), g))
    return outcomes


def scale_out_walk(bb, from_idx, entry, is_long, tp_frac, sl_frac, hold_bars,
                    steps):
    """The gross fraction of the notional a SCALE-OUT books, by walking
    the BARS.

    THE SCALE-OUT IS A LADDER OF PROFIT TARGETS ON A POSITION THAT
    ALREADY EXISTS. It is protected: the exit legs attach to the
    position. That is what makes it measurable where a ladder of
    resting ENTRY limits is not (a resting limit has no position until
    it fills, so it cannot be protected).

    THE CONSERVATIVE ORDERING, and it matters: within ONE bar, the STOP
    is applied BEFORE the targets. A bar that touches both is assumed to
    have reached the stop first, because the path within the bar is
    unknown. So a bar that hits a slice's target and the stop together
    books the stop for the remaining position — the losing side wins
    the tie.

    The slices are SEQUENTIAL IN PRICE: slice 1's target is the
    nearest, and only when it is reached does slice 2 become live.
    """
    end = min(bb.n, from_idx + hold_bars)
    if end - from_idx < 2:
        return 0.0

    stop_price = entry * (1.0 - sl_frac) if is_long else entry * (1.0 + sl_frac)
    # the slice targets, in order, as ABSOLUTE prices
    targets = []
    for frac, tp in steps:
        price = entry * (1.0 + tp) if is_long else entry * (1.0 - tp)
        targets.append((price, frac))

    remaining = 1.0
    total = 0.0
    next_slice = 0

    for k in range(from_idx, end):
        if remaining <= 0:
            break
        h = float(bb.h[k])
        l = float(bb.l[k])

        # ── THE STOP FIRST, CONSERVATIVELY ──
        hit_stop = (l <= stop_price) if is_long else (h >= stop_price)
        if hit_stop and remaining > 0:
            total += remaining * (-sl_frac)
            remaining = 0.0
            break

        # ── THEN THE SLICE TARGETS, in order ──
        while next_slice < len(targets) and remaining > 0:
            price, frac = targets[next_slice]
            hit = (h >= price) if is_long else (l <= price)
            if not hit:
                break
            total += remaining * frac * (tp_frac_of(price, entry, is_long))
            remaining *= (1.0 - frac)
            next_slice += 1

    # ── THE HOLD EXPIRED WITH POSITION LEFT: EXIT AT THE MARK ──
    if remaining > 0:
        mark = float(bb.c[end - 1])
        move = (mark - entry) / entry if is_long else (entry - mark) / entry
        total += remaining * move

    return total


def tp_frac_of(price, entry, is_long):
    """The fraction of the entry that a target price represents."""
    if is_long:
        return (price - entry) / entry
    return (entry - price) / entry


def arm_stats(outcomes, lo, hi, label):
    """The house statistics for one arm."""
    if not outcomes:
        return None
    by_cluster = collections.defaultdict(list)
    for c, g in outcomes:
        by_cluster[c].append(g)
    cl_keys = sorted(by_cluster)
    if not cl_keys:
        return None

    # the fee is charged on the NOTIONAL of every resolved trade
    net = [(c, g - FEE_FRAC) for c, g in outcomes]
    per_cluster = [
        float(np.mean([g for cc, g in net if cc == c])) for c in cl_keys
    ]
    cluster_mean = float(np.mean(per_cluster))
    se = (
        float(np.std(per_cluster, ddof=1) / np.sqrt(len(per_cluster)))
        if len(per_cluster) > 1
        else 0.0
    )
    t = cluster_mean / se if se > 0 else 0.0

    # the EV in % OF EQUITY: the gross fraction is of the notional, and
    # the notional is NOTIONAL_USD of an EQUITY_USD account
    scale = (NOTIONAL_USD / EQUITY_USD) * 100.0
    ev_pct = float(np.mean([g for _, g in net])) * scale

    wins = sum(1 for _, g in net if g > 1e-12)
    losses = sum(1 for _, g in net if g < -1e-12)
    scratches = sum(1 for _, g in net if abs(g) <= 1e-12)

    return {
        "label": label,
        "n": len(outcomes),
        "clusters": len(cl_keys),
        "win_rate": wins / len(outcomes),
        "scratches": scratches,
        "ev_pct": ev_pct,
        "cluster_mean_pct": cluster_mean * scale,
        "se_pct": se * scale,
        "t": t,
        "fee_floor_pct": FEE_FLOOR_PCT,
        "span_days": (hi - lo) / 86_400_000.0,
    }


def compounding_curve(stats, starting_equity=EQUITY_USD, days=30):
    """What COMPOUNDING would do to this arm's equity.

    Compounding is not a new strategy — it is a way of SIZING a return.
    The engine already sizes the risk as a PERCENT OF THE CURRENT
    EQUITY, so a positive EV compounds by construction. What this shows
    is the honest curve for each arm, including the fee drag of a
    SMALLER notional per trade (compounding always pays MORE fees in
    total for the same return).

    The arm's per-cluster EV is spread over the clusters it has; a
    cluster is a 240-minute hold, so a cluster is a quarter of a day of
    trading opportunity.
    """
    if not stats or stats["clusters"] == 0:
        return None
    per_cluster_pct = stats["cluster_mean_pct"]
    clusters_per_day = 24 * 60 / 240.0
    daily_pct = per_cluster_pct * clusters_per_day
    eq = starting_equity
    curve = [eq]
    for _ in range(days):
        eq *= (1.0 + daily_pct / 100.0)
        curve.append(eq)
    return {
        "daily_pct": daily_pct,
        "after_30d": curve[-1],
        "curve": curve,
        "notional": NOTIONAL_USD,
        "fee_per_trade_usd": FEE_FRAC * NOTIONAL_USD,
        "trades_per_day": clusters_per_day,
    }


def main():
    print("=" * 100)
    print("THE THREE NEW ARMS, MEASURED")
    print("=" * 100)
    print(f"  the fee: {TAKER_RT_PCT}% round trip, taker")
    print(f"  the equity: ${EQUITY_USD:.2f} | the notional per ticket: ${NOTIONAL_USD:.2f}")
    print(f"  the fee floor: {FEE_FLOOR_PCT:.4f}% of equity per trade")
    print(f"  the hold: {HOLD_BARS} bars = {HOLD_BARS * BAR_MIN} minutes")
    print(f"  the cluster bar: {MIN_CLUSTER_BAR} independent {HOLD_BARS * BAR_MIN}-minute clusters")
    print()

    if not (os.path.exists(BARS_1H) and os.path.exists(BARS_15M)):
        print("  MISSING the bar caches:")
        print(f"    {BARS_1H}")
        print(f"    {BARS_15M}")
        return 1

    bars_1h = load_bars(BARS_1H)
    bars_15m = load_bars(BARS_15M)
    print(f"  the 1h bars: {len(bars_1h)} symbols | the 15m bars: {len(bars_15m)} symbols")

    keep, (lo, hi) = load_pairs(bars_1h, bars_15m)
    if not keep:
        print("  no symbol pair survived the coverage cut")
        return 1
    print(
        f"  the window: {datetime.fromtimestamp(lo/1000, timezone.utc).isoformat()}"
        f" -> {datetime.fromtimestamp(hi/1000, timezone.utc).isoformat()}"
    )
    print(f"  the span: {(hi - lo)/86_400_000.0:.1f} days | the symbols: {len(keep)}")

    # ── THE SIGNALS: the tape on the 1h bars, resolved on the 15m ──
    bars_1h_keep = {p: bars_1h[p] for p in keep if p in bars_1h}
    bars_15m_keep = {p: bars_15m[p] for p in keep if p in bars_15m}
    states = tape_states(bars_1h_keep, honest=True)
    sigs = build_signals(
        states, bars_15m_keep, lo, hi, bar_minutes=BAR_MIN, grid_ms=GRID_MS
    )
    by_pair = collections.defaultdict(list)
    for s in sigs:
        by_pair[s[0]].append(s)
    total_signals = sum(len(v) for v in by_pair.values())
    sides = collections.Counter(s[2] for s in sigs)
    print(f"  the signals: {total_signals} across {len(by_pair)} symbols ({dict(sides)})")
    if total_signals < 200:
        print("  TOO FEW SIGNALS")
        return 1
    prepared = prepare(by_pair, bars_15m_keep)
    print()

    # ── THE ARMS ───────────────────────────────────────────────────────
    # The fractions are stated directly so the comparison is exact.
    # The SHIPPED arm is the control: tp 0.4 x ATR capped at 0.5%, stop
    # at 1 ATR — close to 0.40% / 0.90% on these instruments.
    arms = [
        # THE REFERENCE: the SHIPPED geometry on the same signals. It is
        # the reference point for the GEOMETRY comparison, NOT a
        # model-filtered control — this study has no model data, so
        # every arm here is the TAPE-ONLY arm and the live gate's
        # "excess over the control" is NOT measurable in it.
        ("REFERENCE tp 0.40% sl 0.90% (the shipped geometry)", 0.0040, 0.0090, None),
        ("WIDE-1   tp 0.80% sl 0.90%", 0.0080, 0.0090, None),
        ("WIDE-2   tp 1.20% sl 1.20%", 0.0120, 0.0120, None),
        ("WIDE-3   tp 2.00% sl 1.20%", 0.0200, 0.0120, None),
        ("SCALE-2  tp 0.40/1.00% sl 0.90%",
         0.0040, 0.0090, [(0.5, 0.0040), (0.5, 0.0100)]),
        ("SCALE-3  tp 0.40/0.80/1.40% sl 0.90%",
         0.0040, 0.0090, [(0.34, 0.0040), (0.33, 0.0080), (0.33, 0.0140)]),
    ]

    results = []
    for label, tp, sl, steps in arms:
        outcomes = resolve_arm(prepared, lo, tp, sl, HOLD_BARS, steps)
        st = arm_stats(outcomes, lo, hi, label)
        if st is None:
            print(f"  {label}: NO TRADES")
            continue
        results.append(st)

    # ── THE TABLE ──────────────────────────────────────────────────────
    print("=" * 100)
    print(
        f"  {'arm':<32} {'n':>6} {'clus':>5} {'win%':>6} {'scr%':>6} "
        f"{'EV%':>9} {'floor%':>8} {'excess%':>9} {'t':>7}  VERDICT"
    )
    print("  " + "-" * 98)
    # THE EXCESS HERE IS THE GEOMETRY'S EXCESS OVER THE REFERENCE
    # GEOMETRY — a comparison of two ticket shapes on the same signals.
    # IT IS NOT THE LIVE GATE'S "EXCESS OVER THE UNCONDITIONAL CONTROL",
    # because that control needs model data this study does not have.
    ref = next((x for x in results if x["label"].startswith("REFERENCE")), None)
    ref_mean = ref["cluster_mean_pct"] if ref else 0.0
    for st in results:
        st["excess_pct"] = st["cluster_mean_pct"] - ref_mean
        st["excessIsModelFiltered"] = False
    for st in results:
        clears_floor = st["ev_pct"] > st["fee_floor_pct"]
        significant = st["t"] >= MIN_CLUSTER_T
        enough_clusters = st["clusters"] >= MIN_CLUSTER_BAR
        if clears_floor and significant and enough_clusters and st["excess_pct"] > 0:
            # it clears the floor on its OWN and it is significant, but
            # the MODEL-FILTERED excess is NOT measured here — so it is
            # a candidate for the full gate, not a deployable edge.
            verdict = "candidate (the model excess is unmeasured)"
        elif st["excess_pct"] > 0:
            verdict = "candidate"
        else:
            verdict = "no edge"
        st["verdict"] = verdict
        print(
            f"  {st['label']:<32} {st['n']:>6} {st['clusters']:>5} "
            f"{st['win_rate']*100:>5.1f} {st['scratches']/max(1,st['n'])*100:>5.1f} "
            f"{st['ev_pct']:>+9.4f} {st['fee_floor_pct']:>+8.4f} "
            f"{st['excess_pct']:>+9.4f} {st['t']:>+7.2f}  {verdict}"
        )
    print()

    # ── THE COMPOUNDING ────────────────────────────────────────────────
    print("=" * 100)
    print(f"  THE COMPOUNDING, 30 days from ${EQUITY_USD:.2f}")
    print("=" * 100)
    print(
        f"  {'arm':<32} {'the daily %':>12} {'after 30d':>12} {'the fees/day':>13}"
    )
    for st in results:
        c = compounding_curve(st)
        if not c:
            continue
        st["compound"] = c
        print(
            f"  {st['label']:<32} {c['daily_pct']:>+11.4f}% "
            f"${c['after_30d']:>10.2f} ${c['fee_per_trade_usd']*c['trades_per_day']:>11.4f}"
        )
    print()
    print("  COMPOUNDING IS NOT A STRATEGY. It is a way of sizing a RETURN.")
    print("  The engine already sizes the risk as a PERCENT OF THE CURRENT")
    print("  EQUITY, so a positive EV compounds by construction. What")
    print("  compounding changes is the FEE DRAG: more, smaller trades pay")
    print("  more fees in total for the same return. And a NEGATIVE EV")
    print("  compounds the loss faster than a fixed size does.")
    print()

    # ── THE LEVERAGE, WITH THE ENGINE'S OWN ARITHMETIC ───────────────
    # The engine DERIVES the leverage from the stop width:
    #     lev <= 1 / (k * stopDistanceFrac + m)
    # with k = the safety multiple (2.0) and m = the maintenance
    # margin rate (0.007 for KuCoin's USDT-M contracts).
    #
    # So "lower leverage" is NOT a free parameter, and it is NOT an
    # EDGE parameter: the EV is a FRACTION OF THE NOTIONAL, so the
    # leverage does not change the EV at all. What it changes is the
    # MARGIN COMMITTED and the LIQUIDATION DISTANCE.
    #
    # AND THE HONEST POINT: at a FIXED dollar risk, a wider stop
    # (hence lower leverage) means a SMALLER notional, so the same
    # percentage EV moves the same percentage of equity. Lower
    # leverage buys a SAFER LIQUIDATION DISTANCE, not a better return.
    K_SAFETY = 2.0
    M_MAINT = 0.007
    print("=" * 100)
    print("  THE LEVERAGE, DERIVED FROM THE STOP WIDTH (the engine's own arithmetic)")
    print("=" * 100)
    print(
        f"  {'the stop':>9} {'the lev <=':>11} {'the liq dist':>12} "
        f"{'the margin':>12} {'the fee/stop':>12}"
    )
    lev_rows = []
    for stop in [0.0040, 0.0090, 0.0120, 0.0200]:
        lev = min(1.0 / (K_SAFETY * stop + M_MAINT), 50.0)
        liq = 1.0 / lev - M_MAINT
        margin = NOTIONAL_USD / lev
        drag = FEE_FRAC / stop * 100.0
        lev_rows.append(
            {"stopPct": stop * 100.0, "leverage": lev, "liqDistancePct": liq * 100.0,
             "marginUsd": margin, "feeDragPctOfStop": drag}
        )
        print(
            f"  {stop*100:>8.2f}% {lev:>11.1f} {liq*100:>11.2f}% "
            f"${margin:>11.2f} {drag:>11.1f}%"
        )
    print()
    print("  THE EV IS A FRACTION OF THE NOTIONAL, so the leverage does not")
    print("  change the EV. It changes the MARGIN COMMITTED and the")
    print("  LIQUIDATION DISTANCE. And the FEE DRAG is a share of the")
    print("  STOP, not of the margin — so a lower leverage does not")
    print("  reduce the fees. A wider target with a wider stop is what")
    print("  reduces the fee's share of the trade, and the table above")
    print("  shows that: 30% of the stop at 0.40%, 6% at 2.00%.")
    print()

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "leverageTable": lev_rows,
        "feeRoundTripPct": TAKER_RT_PCT,
        "equityUsd": EQUITY_USD,
        "notionalUsd": NOTIONAL_USD,
        "feeFloorPct": FEE_FLOOR_PCT,
        "holdMinutes": HOLD_BARS * BAR_MIN,
        "clusterWidthMinutes": HOLD_BARS * BAR_MIN,
        "minClusterBar": MIN_CLUSTER_BAR,
        "spanDays": (hi - lo) / 86_400_000.0,
        "signals": total_signals,
        "symbols": len(keep),
        "arms": [
            {k: v for k, v in st.items() if k not in ("compound",)}
            for st in results
        ],
    }
    path = os.path.join(GEO, "geo4-newarms.json")
    json.dump(out, open(path, "w"), indent=1, default=str)
    print(f"  wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
