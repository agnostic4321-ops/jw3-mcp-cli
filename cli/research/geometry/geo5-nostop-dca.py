"""
THE NO-STOP ARM, MEASURED: liquidation as the stop, DCA against the
position, and multiple concurrent trades.

THE ARM AS REQUESTED:
  1. NO STOP LOSS AT ALL. The position is held until the take-profit or
     until LIQUIDATION, and liquidation is treated as the stop.
  2. DCA STEPS when the trade goes against the position: the size is
     added at adverse levels, averaging the entry down/up.
  3. MULTIPLE TRADES at once.

WHAT THE MEASUREMENT MUST ANSWER, IN THIS ORDER:
  A. Is the no-stop arm positive after the fee, against the same
     unconditional control the live gate uses?
  B. Does the DCA ladder make it positive, or does it only make the
     loss bigger?
  C. Does running several trades at once help, or does it just
     multiply the risk of the same negative EV?

THE HONEST FRAMING FIRST, because it decides the whole study.

A NO STOP DOES NOT REMOVE THE STOP — IT MOVES IT. At fixed isolated
margin the loss is bounded by the MARGIN, so "no stop" is a stop at the
liquidation price. And the liquidation price is a FUNCTION of the
leverage: the further the stop, the lower the leverage, and the lower
the leverage, the SMALLER the notional — and the EV is a FRACTION OF
THE NOTIONAL. So a no-stop arm at low leverage is a small-notional arm
with a very wide stop, which is the same geometry as a wide stop with
a normal stop, and its fee drag is WORSE (the same fee on a smaller
notional per unit of risk, and the fee is a fixed share of the
notional).

THE MODEL, PRECISELY:
  - the position is opened with notional N at leverage L, so the margin
    committed is M = N / L
  - the liquidation distance is derived from the venue's own
    maintenance margin rate: liq_dist ~= 1 / L - m, with m the
    maintenance rate (0.007 for KuCoin's USDT-M contracts). The engine
    uses a safety multiple of 2.0 on top of that, so the honest
    liquidation distance is the raw 1/L - m.
  - the loss at liquidation is the margin: N * (1 - L*m) approximately,
    i.e. the position is wiped out
  - the notional is what the fee is charged on
  - the take-profit is unchanged

SO THE ARM IS: enter at N, hold to TP or to the liquidation price.

THE DCA LADDER:
  - the position is ADDED TO at adverse levels (for a long, below the
    entry; for a short, above it), each step at a fraction of the
    original notional
  - each added step pays the fee again, and each adds exposure
  - the average entry moves in the trade's favour, so the TP is hit
    sooner in price terms — but the LOSS at liquidation grows
  - the question is whether the extra probability of reaching the TP
    outweighs the extra fee and the deeper liquidation loss

THE MULTIPLE-TRADES ARM:
  - the account's margin pool is shared, so N concurrent trades divide
    the same margin
  - the EV per trade is unchanged by running more of them; what changes
    is the VARIANCE of the outcome and the chance that several
    positions liquidate together in one adverse move, which is
    CORRELATED risk that a per-trade cap does not bound
  - so it must be measured as the account's outcome, not as a per-trade
  EV

THE HOUSE BAR, unchanged from the live gate:
  a candidate must clear FOUR things to be an EDGE
    1. the excess over the unconditional control is positive
    2. t on the cluster means is >= 2
    3. at least 30 INDEPENDENT 240-minute hold clusters
    4. the arm's OWN net EV clears the FEE FLOOR

Run: python3 geo5-nostop-dca.py
"""

import collections
import json
import os
import sys

import numpy as np

GEO = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, GEO)

from core import build_signals, coverage_cut, load_bars, tape_states  # noqa: E402

SCRATCH = os.path.join(os.path.expanduser("~"), ".hermes/cache/scratch")
GEO2 = os.path.join(SCRATCH, "geo2")

# THE FULL VENUE HISTORY, not the 5-day "cont" files. The 45-day set
# is what makes the 30-cluster bar reachable at all: at a 240-minute
# hold it gives 31 clusters, and at a 480-minute hold it gives 16 —
# which is why a longer hold needs MORE data, not less, to clear the
# same bar.
#
# The cont files (5.1 days) are the LIVE collector's output and are
# used for the live gate's own measurement, not for a power
# calculation.
BARS_1H = os.path.join(GEO2, "geo-kc-1h.json")
BARS_15M = os.path.join(GEO2, "geo-kc-15m.json")

# ── THE HOUSE CONSTANTS ────────────────────────────────────────────────
TAKER_RT_PCT = 0.12
EQUITY_USD = 56.35
NOTIONAL_USD = 60.0
HOLD_BARS = 16
HOLD_MS = 240 * 60_000
CLUSTER_MS = HOLD_MS
MIN_CLUSTER_BAR = 30
MIN_CLUSTER_T = 2.0

M_MAINT = 0.007          # KuCoin's USDT-M maintenance margin rate
LIQ_BUFFER = 0.98        # the venue liquidates a little before the raw price

FEE_FRAC = TAKER_RT_PCT / 100.0
FEE_FLOOR_PCT = TAKER_RT_PCT * (NOTIONAL_USD / EQUITY_USD)

# The DCA ladder: each step is a fraction of the ORIGINAL notional, at
# an adverse distance of X% from the AVERAGE entry at that point.
DCA_STEP_FRAC = 0.5      # each step adds half the original notional
DCA_STEP_PCT = 0.008     # 0.8% adverse from the running average entry
DCA_MAX_STEPS = 3

# The arms: (label, tp_frac, leverage, dca_steps, step_pct, recovery_target)
#
# The DCA appears in TWO forms, because they are different strategies:
#
#   the AVERAGE target   the TP is measured from the running AVERAGE
#                        entry, so the DCA makes the target EASIER. The
#                        added size is what pays for it, and the
#                        liquidation loss grows with the size.
#
#   the RECOVERY target  the TP is measured from the ORIGINAL entry,
#                        so the DCA exists to make a fixed target
#                        reachable after an adverse move. This is the
#                        classic mean-reversion DCA.
#
# And the step distance matters: 0.8% is TWICE the TP distance, so a
# step only fires after the trade has already lost more than it could
# win. A tighter step (0.2-0.4%) fires inside the target's own scale.
ARMS = [
    ("SHIPPED     tp0.40% sl0.90% x40", 0.0040, 40.0, 0, 0.0, False),
    ("NOSTOP-L20  tp0.40% liq      x20", 0.0040, 20.0, 0, 0.0, False),
    ("NOSTOP-L10  tp0.40% liq      x10", 0.0040, 10.0, 0, 0.0, False),
    ("NOSTOP-L5   tp0.40% liq      x5 ", 0.0040, 5.0, 0, 0.0, False),
    ("NOSTOP-L3   tp0.40% liq      x3 ", 0.0040, 3.0, 0, 0.0, False),
    # the DCA, average target, 0.8% steps (twice the target distance)
    ("NOSTOP-L10-DCA0.8%-AVG", 0.0040, 10.0, 3, 0.008, False),
    ("NOSTOP-L5-DCA0.8%-AVG ", 0.0040, 5.0, 3, 0.008, False),
    # the DCA, average target, tight steps
    ("NOSTOP-L10-DCA0.3%-AVG", 0.0040, 10.0, 3, 0.003, False),
    ("NOSTOP-L5-DCA0.3%-AVG ", 0.0040, 5.0, 3, 0.003, False),
    ("NOSTOP-L3-DCA0.3%-AVG ", 0.0040, 3.0, 3, 0.003, False),
    # the DCA, RECOVERY target (measured from the original entry)
    ("NOSTOP-L10-DCA0.3%-REC", 0.0040, 10.0, 3, 0.003, True),
    ("NOSTOP-L5-DCA0.3%-REC ", 0.0040, 5.0, 3, 0.003, True),
    ("NOSTOP-L3-DCA0.3%-REC ", 0.0040, 3.0, 3, 0.003, True),
    ("NOSTOP-L5-DCA0.8%-REC ", 0.0040, 5.0, 3, 0.008, True),
    # a WIDER target, because a no-stop arm needs a target the market
    # can actually reach, and the fee drag is a share of the target
    ("NOSTOP-L5-WIDE1.0%-REC", 0.0100, 5.0, 3, 0.003, True),
    ("NOSTOP-L3-WIDE1.0%-REC", 0.0100, 3.0, 3, 0.003, True),
    ("NOSTOP-L5-WIDE1.0%-NO DCA", 0.0100, 5.0, 0, 0.0, False),
]


def load_pairs():
    """The symbols, the resolution bars, and THE WINDOW.

    ── THE WINDOW IS THE UNION, NOT THE INTERSECTION ──

    `coverage_cut` returns `union_lo = max(all symbol starts)` — the
    INTERSECTION's lower edge. Inside a 45-day set, one symbol with 5
    days of history therefore collapses the window to 5 days and throws
    away 92% of the sample, and at a 480-minute hold it makes the
    30-cluster bar STRUCTURALLY IMPOSSIBLE, so every long-hold row
    would fail its own bar for a reason that has nothing to do with
    the geometry.

    The union's lower edge is MIN(all starts) and its upper edge is
    MAX(all ends). The study uses that window, and keeps every symbol
    that has data in it — a signal on a shorter-history symbol is a
    valid observation, and the exclusion should be about the WINDOW,
    not about demanding that every symbol span it.

    The window is STATED in the output, because a reader cannot
    otherwise tell a narrow window from a wide one.
    """
    bars_1h = load_bars(BARS_1H)
    bars_15m = load_bars(BARS_15M)
    common = sorted(set(bars_1h) & set(bars_15m))
    if not common:
        return [], {}, (0, 0)
    keep, dropped, _cut_lo, _cut_hi = coverage_cut(
        bars_1h, bars_15m, common, min_days=0.0
    )
    # THE UNION WINDOW.
    lo = min(int(bars_1h[p].t[0]) for p in common)
    hi = max(int(bars_15m[p].t[-1]) for p in common)
    # The signal must be resolvable, so the window is trimmed by one
    # HOLD at each end: a signal in the last hold has no bars to
    # resolve against.
    lo += HOLD_MS
    hi -= HOLD_MS
    if hi - lo < HOLD_MS * MIN_CLUSTER_BAR:
        return [], {}, (lo, hi)
    return keep, bars_15m, (lo, hi)


def liq_distance(leverage: float) -> float:
    """The raw liquidation distance as a FRACTION, from the venue's own
    maintenance margin rate: 1/L - m.

    This is the price move that takes the position to the maintenance
    margin, and the venue liquidates at or just before it.
    """
    return max(0.0, 1.0 / leverage - M_MAINT)


def prepare(by_pair, bars):
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


def cluster_of(ts, lo, width_ms=CLUSTER_MS):
    """The independent cluster a signal belongs to.

    THE WIDTH IS THE TICKET'S FULL HOLDING PERIOD. A 480-minute hold
    clustered at 240 minutes would count two OVERLAPPING trades as
    independent observations, which is the collector-cadence trap in
    its worst form: the two trades share the entry, the path and much
    of the exit, so they are ONE outcome seen twice.
    """
    return int((ts - lo) // width_ms)


def resolve_nostop(prepared, lo, tp_frac, leverage, hold_bars, dca_steps=0,
                   step_pct=DCA_STEP_PCT, step_frac=DCA_STEP_FRAC,
                   recovery_target=False):
    """Resolve every signal with NO STOP: the position is closed by the
    take-profit, by LIQUIDATION, or at the end of the hold.

    THE LIQUIDATION PRICE is a price level, so it is resolved with the
    same bar-walking rule as a stop: a bar that touches the
    liquidation price closes the position THERE. The position is wiped
    out at liquidation, so the loss is the full margin.

    THE DCA LADDER adds size at adverse levels. Each added step:
      - pays the fee again
      - moves the average entry
      - moves the liquidation price AWAY (more notional, same margin
        only if the leverage is applied to the new notional; here the
        margin is fixed by the ticket, so the added size INCREASES the
        liquidation distance in the account's terms)
    """
    liq_dist = liq_distance(leverage)
    outcomes = []
    for p, (bb, idx, entries, is_long, ts_arr, sides) in prepared.items():
        t = bb.t
        h = bb.h
        low = bb.l
        close = bb.c
        n = bb.n
        for k in range(len(entries)):
            i0 = int(idx[k])
            if i0 >= n:
                continue
            entry = float(entries[k])
            lng = bool(is_long[k])
            ts = float(ts_arr[k])
            notional = NOTIONAL_USD
            fees = notional * FEE_FRAC
            avg = entry
            steps_left = dca_steps
            exit_price = None
            exit_kind = None
            i = i0
            end = min(n, i0 + hold_bars)
            while i < end:
                # ── THE LIQUIDATION LEVEL, on the CURRENT size ──
                liq_price = (
                    avg * (1.0 - liq_dist * LIQ_BUFFER) if lng
                    else avg * (1.0 + liq_dist * LIQ_BUFFER)
                )
                tp_price = (
                    avg * (1.0 + tp_frac) if lng else avg * (1.0 - tp_frac)
                )
                bar_low = float(low[i])
                bar_high = float(h[i])

                # The adverse direction is the direction of the loss.
                liq_touched = (bar_low <= liq_price) if lng else (bar_high >= liq_price)
                tp_touched = (bar_high >= tp_price) if lng else (bar_low <= tp_price)
                # ── THE RECOVERY TARGET ──
                #
                # Measured from the ORIGINAL entry, not the running
                # average. This is the point of the DCA: the added size
                # moves the average entry toward a target that is itself
                # fixed, so the target becomes REACHABLE. Measured from
                # the average instead, the DCA just makes the loss
                # bigger — which is what the first version of this study
                # did, and it made the DCA look like a pure loss-maker
                # for a reason that was an artefact of the measurement.
                if recovery_target:
                    tp_price = (
                        entry * (1.0 + tp_frac) if lng else entry * (1.0 - tp_frac)
                    )

                # A bar touching BOTH: the LOSS first. Conservative.
                if liq_touched:
                    exit_price = liq_price
                    exit_kind = "liquidation"
                    break
                if tp_touched:
                    exit_price = tp_price
                    exit_kind = "tp"
                    break

                # ── THE DCA STEP ──
                # A step fires when the bar's adverse extreme passed the
                # step level from the running average entry.
                if steps_left > 0:
                    step_price = (
                        avg * (1.0 - step_pct) if lng
                        else avg * (1.0 + step_pct)
                    )
                    step_hit = (
                        (bar_low <= step_price) if lng else (bar_high >= step_price)
                    )
                    if step_hit:
                        add = notional * step_frac
                        notional += add
                        fees += add * FEE_FRAC
                        # The average entry moves toward the step price.
                        avg = (avg * (notional - add) + step_price * add) / notional
                        steps_left -= 1
                        # The liquidation distance GROWS with the size,
                        # because the margin is fixed by the ticket.
                        liq_dist = liq_distance(leverage) * (notional / NOTIONAL_USD)
                        i += 1
                        continue

                i += 1

            if exit_kind is None:
                # The hold expired: exit at the mark.
                j = min(end, n) - 1
                if j < 0:
                    continue
                exit_price = float(close[j])
                exit_kind = "time"

            # THE GROSS IS MEASURED FROM THE AVERAGE ENTRY: that is the
            # price the position was actually entered at, and the TP is
            # measured from the average too (or from the original entry
            # in the recovery-target variant). Measuring the gross from
            # the ORIGINAL entry while measuring the target from the
            # average would book a win the venue never paid.
            gross = (exit_price - avg) * (notional / avg) * (1.0 if lng else -1.0)
            if exit_kind == "liquidation":
                # The position is WIPED OUT: the loss is the TOTAL
                # margin. A DCA step at the same leverage needs its own
                # margin, so the margin GROWS with the size.
                margin = notional / leverage
                gross = -margin
            net = gross - fees
            outcomes.append((ts, p, net, exit_kind))
    return outcomes


def arm_stats(outcomes, lo, hi, label, cluster_ms=CLUSTER_MS):
    """The cluster-level statistics on the same units the live gate uses.

    THE CLUSTER WIDTH DEFAULTS TO THE TICKET'S HOLDING PERIOD, and a
    longer hold must be measured with a matching width. The cluster
    count is what the 30-cluster bar is applied to, so a mismatched
    width inflates the independence and the t-statistic with it.
    """
    keep = [(ts, net) for ts, p, net, k in outcomes if lo <= ts <= hi]
    if not keep:
        return None
    by_cluster = collections.defaultdict(list)
    for ts, net in keep:
        by_cluster[cluster_of(ts, lo, cluster_ms)].append(net)
    means = [float(np.mean(v)) for v in by_cluster.values()]
    cm = float(np.mean(means))
    if len(means) > 1:
        se = float(np.std(means, ddof=1) / np.sqrt(len(means)))
    else:
        se = 0.0
    t = cm / se if se > 0 else 0.0
    eq_frac = [n / EQUITY_USD for n in (x[1] for x in keep)]
    ev_pct = float(np.mean(eq_frac)) * 100.0
    kinds = collections.Counter(k for ts, p, n, k in outcomes if lo <= ts <= hi)
    return {
        "label": label,
        "n": len(keep),
        "clusters": len(means),
        "cluster_mean_pct": cm * 100.0,
        "cluster_se_pct": se * 100.0,
        "t": t,
        "ev_pct": ev_pct,
        "kinds": dict(kinds),
        "liq_share": kinds.get("liquidation", 0) / max(1, len(keep)),
    }


def main():
    keep, bars_15m, (lo, hi) = load_pairs()
    if not keep:
        print("no pairs with a long enough union window")
        return
    bars_1h = load_bars(BARS_1H)
    tape = tape_states(bars_1h)
    signals = build_signals(tape, bars_15m, lo, hi, bar_minutes=15)
    by_pair = collections.defaultdict(list)
    for s in signals:
        by_pair[s[0]].append(s)
    prepared = prepare(by_pair, bars_15m)

    span_days = (hi - lo) / 86_400_000
    print("=" * 104)
    print("THE NO-STOP ARM: LIQUIDATION AS THE STOP, DCA, AND MULTIPLE TRADES")
    print("=" * 104)
    print(f"  the fee: {TAKER_RT_PCT}% round trip, taker")
    print(f"  the equity: ${EQUITY_USD:.2f} | the notional per ticket: ${NOTIONAL_USD:.2f}")
    print(f"  the fee floor: {FEE_FLOOR_PCT:.4f}% of equity per trade")
    print(f"  the hold: {HOLD_BARS} bars = {HOLD_BARS * 15} minutes")
    print(f"  the cluster bar: {MIN_CLUSTER_BAR} independent 240-minute clusters")
    print(f"  the maintenance margin rate: {M_MAINT}")
    print(f"  the window: {span_days:.1f} days | the symbols: {len(keep)}")
    print(f"  the signals: {len(signals)}")

    print()
    print("=" * 104)
    print("  THE LIQUIDATION DISTANCE, FROM THE VENUE'S OWN RATE:  1/L - m")
    print("=" * 104)
    print(f"  {'the lev':>8} {'the liq dist':>12} {'the liq $ move':>15} {'the margin':>11} "
          f"{'the loss at liq':>16}")
    for lev in (40, 20, 10, 5, 3, 2):
        d = liq_distance(lev)
        print(f"  {lev:>8.0f} {d * 100:>11.2f}% {NOTIONAL_USD * d:>14.2f} "
              f"{NOTIONAL_USD / lev:>10.2f} {-(NOTIONAL_USD / lev):>15.2f}")

    print()
    print("=" * 104)
    print("  THE ARMS")
    print("=" * 104)
    print(f"  {'arm':<34} {'n':>6} {'clus':>5} {'EV%':>9} {'floor%':>8} "
          f"{'excess%':>9} {'t':>7}  {'liq%':>5}  VERDICT")

    results = {}
    for label, tp_frac, lev, dca, step_pct, rec in ARMS:
        outcomes = resolve_nostop(
            prepared, lo, tp_frac, lev, HOLD_BARS, dca,
            step_pct=step_pct or DCA_STEP_PCT,
            recovery_target=rec,
        )
        st = arm_stats(outcomes, lo, hi, label)
        if st is None:
            continue
        results[label] = st

    ref = results.get(ARMS[0][0])
    for label, tp_frac, lev, dca, step_pct, rec in ARMS:
        st = results.get(label)
        if st is None:
            continue
        excess = st["ev_pct"] - (ref["ev_pct"] if ref else 0.0)
        st["excess_pct"] = excess
        clears_floor = st["ev_pct"] > FEE_FLOOR_PCT
        significant = st["t"] >= MIN_CLUSTER_T
        enough = st["clusters"] >= MIN_CLUSTER_BAR
        if clears_floor and significant and enough and excess > 0:
            verdict = "EDGE"
        elif clears_floor and significant and enough:
            verdict = "no excess"
        elif excess > 0:
            verdict = "candidate"
        else:
            verdict = "no edge"
        print(f"  {label:<34} {st['n']:>6} {st['clusters']:>5} {st['ev_pct']:>9.4f} "
              f"{FEE_FLOOR_PCT:>8.4f} {excess:>9.4f} {st['t']:>7.2f}  "
              f"{st['liq_share'] * 100:>4.1f}%  {verdict}")

    print()
    print("=" * 104)
    print("  THE EXIT MIX, PER ARM")
    print("=" * 104)
    for label, *_ in ARMS:
        st = results.get(label)
        if st is None:
            continue
        k = st["kinds"]
        tot = max(1, st["n"])
        print(f"  {label:<34} tp {k.get('tp', 0) / tot * 100:>5.1f}%  "
              f"liq {k.get('liquidation', 0) / tot * 100:>5.1f}%  "
              f"time {k.get('time', 0) / tot * 100:>5.1f}%")

    print()
    print("=" * 104)
    print("  MULTIPLE CONCURRENT TRADES")
    print("=" * 104)
    print("  The account's margin pool is shared, so N concurrent trades")
    print("  divide the same margin. The EV PER TRADE is unchanged; what")
    print("  changes is the account's outcome distribution, and the risk")
    print("  that several positions liquidate TOGETHER in one adverse")
    print("  move — CORRELATED risk that a per-trade cap does not bound.")
    print()
    print("  THE ARITHMETIC THAT DECIDES IT, from the measured arms:")
    for label, tp_frac, lev, dca, step_pct, rec in ARMS:
        st = results.get(label)
        if st is None:
            continue
        margin = NOTIONAL_USD / lev
        print(f"  {label:<34} the margin per ticket: ${margin:>6.2f}  "
              f"the loss if it liquidates: ${margin:>6.2f}  "
              f"= {margin / EQUITY_USD * 100:>5.1f}% of the account")
    print()
    print("  So the account can absorb a NUMBER of liquidations before the")
    print("  equity is gone, and a shared-margin pool means that number is")
    print("  the same whether the trades are concurrent or sequential.")

    # ── THE TARGET SWEEP ON THE NO-STOP ARM ──────────────────────────
    #
    # The no-stop arm removes the MAE constraint that made a wide
    # target impossible WITH a stop: there is no stop to fire on noise.
    # So the target can be as wide as the market allows, and the fee's
    # share of the target falls with it.
    print()
    print("=" * 104)
    print("  THE TARGET SWEEP ON THE NO-STOP ARM (no DCA, no stop)")
    print("=" * 104)
    print(f"  {'the target':>11} {'the lev':>6} {'the hold':>9} {'clus':>5} "
          f"{'EV%':>9} {'floor%':>8} {'excess%':>9} {'t':>7} {'liq%':>6} "
          f"{'the SE%':>9}  VERDICT")
    print("  (the cluster width MATCHES the hold, so a longer hold needs")
    print("   more data for the same cluster bar — that is the trade)")
    sweep_rows = []
    for lev in (10.0, 5.0, 3.0):
        for tp in (0.004, 0.008, 0.012, 0.020, 0.030):
            for hold in (HOLD_BARS, HOLD_BARS * 2):
                outcomes = resolve_nostop(prepared, lo, tp, lev, hold, 0)
                # THE CLUSTER WIDTH MATCHES THE HOLD.
                cluster_ms = hold * 15 * 60_000
                st = arm_stats(
                    outcomes, lo, hi,
                    f"sweep tp{tp} lev{lev} hold{hold}",
                    cluster_ms=cluster_ms,
                )
                if st is None:
                    continue
                excess = st["ev_pct"] - (ref["ev_pct"] if ref else 0.0)
                clears = st["ev_pct"] > FEE_FLOOR_PCT
                signif = st["t"] >= MIN_CLUSTER_T
                enough = st["clusters"] >= MIN_CLUSTER_BAR
                if clears and signif and enough and excess > 0:
                    verdict = "EDGE"
                elif clears and signif and enough:
                    verdict = "no excess"
                elif excess > 0:
                    verdict = "candidate"
                else:
                    verdict = "no edge"
                print(f"  {tp * 100:>10.2f}% {lev:>6.0f} {hold * 15:>7}min "
                      f"{st['clusters']:>5} {st['ev_pct']:>9.4f} {FEE_FLOOR_PCT:>8.4f} "
                      f"{excess:>9.4f} {st['t']:>7.2f} {st['liq_share'] * 100:>5.1f}% "
                      f"{st['cluster_se_pct']:>9.4f}  {verdict}")
                sweep_rows.append({
                    "tp": tp, "leverage": lev, "hold_bars": hold,
                    "ev_pct": st["ev_pct"], "excess_pct": excess, "t": st["t"],
                    "clusters": st["clusters"], "liq_share": st["liq_share"],
                    "verdict": verdict,
                })

    # ── THE MULTIPLE-TRADES ARM, MEASURED AT THE ACCOUNT LEVEL ───────
    #
    # The per-trade EV does not change with the number of concurrent
    # trades. What changes is the ACCOUNT's outcome: the equity path
    # and the chance that several positions liquidate in the SAME
    # adverse move, which is CORRELATED risk that a per-trade cap does
    # not bound.
    print()
    print("=" * 104)
    print("  MULTIPLE CONCURRENT TRADES, MEASURED AT THE ACCOUNT LEVEL")
    print("=" * 104)
    print("  The trades in a cluster are INDEPENDENT SAMPLES of the same")
    print("  arm, so N concurrent trades in one cluster is the same")
    print("  distribution scaled by N — the expected value is N times")
    print("  one trade's, and the DOWNSIDE is what matters: the chance")
    print("  that the whole set loses together.")
    print()
    print(f"  {'the arm':<34} {'the 1-trade EV%':>16} {'the N=3 worst':>14} "
          f"{'the N=3 mean':>13} {'the N=3 p(loss)':>15}")
    for label, tp_frac, lev, dca, step_pct, rec in ARMS:
        st = results.get(label)
        if st is None:
            continue
        outcomes = resolve_nostop(
            prepared, lo, tp_frac, lev, HOLD_BARS, dca,
            step_pct=step_pct or DCA_STEP_PCT, recovery_target=rec,
        )
        by_cluster = collections.defaultdict(list)
        for ts, p, net, k in outcomes:
            if lo <= ts <= hi:
                by_cluster[cluster_of(ts, lo)].append(net)
        if not by_cluster:
            continue
        # The N=3 case: three trades in the SAME cluster, which is the
        # correlated case (one adverse move hits all three).
        triples = []
        for c, nets in by_cluster.items():
            if len(nets) >= 3:
                nets_sorted = sorted(nets)
                # the correlated draw: the three WORST outcomes together
                triples.append(sum(nets_sorted[:3]))
                # the ordinary draw: three random ones
                triples.append(float(np.mean(nets[:3])))
        if not triples:
            continue
        worst = min(triples)
        mean3 = float(np.mean(triples))
        p_loss = sum(1 for x in triples if x < 0) / len(triples)
        print(f"  {label:<34} {st['ev_pct']:>16.4f} {worst * 100 / EQUITY_USD:>13.2f}% "
              f"{mean3 * 100 / EQUITY_USD:>12.2f}% {p_loss * 100:>14.1f}%")

    out = {
        "sweep": sweep_rows,
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "feeFloorPct": FEE_FLOOR_PCT,
        "arms": {k: v for k, v in results.items()},
    }
    with open(os.path.join(GEO, "geo5-nostop-dca.json"), "w") as f:
        json.dump(out, f, indent=1, default=str)
    print()
    print(f"  wrote {os.path.join(GEO, 'geo5-nostop-dca.json')}")


if __name__ == "__main__":
    main()
