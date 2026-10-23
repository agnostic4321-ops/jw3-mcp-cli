#!/usr/bin/env python3
"""
THE BID-ASK BOUNCE AUDIT.

WHY THIS EXISTS
---------------
The 1-minute study measured a mean-reversion excess of +0.081% per event
with a CLUSTERED t of +40.5 over 1,345 independent clusters. That is a
statistically overwhelming number, and at this project has produced
overwhelming numbers before (the 100% win rate, the +1.01%/trade), so it
is audited before it is believed.

THE HYPOTHESIS
--------------
KuCoin's klines are TRADE bars: the close is the last TRADE price, not a
mid. If the market's trade price alternates between the bid and the ask,
then the trade-to-trade series contains a mechanical ZENO/BOUNCE
component: every down-tick is followed by an up-tick and vice versa. A
"fade the last move" rule collects that bounce mechanically.

THE POINT
---------
A TRADER CANNOT CAPTURE THE BOUNCE. Entering at the ask and exiting at the
bid means the bounce is exactly what you PAY. So if the measured
mean-reversion edge IS the bounce, the edge is an artefact of measuring
mid-to-mid on trade prices, and it is worth LESS than zero after the
spread — it is worth exactly minus the spread.

THE TESTS
---------
  1. The lag-1 autocorrelation of the 1-minute RETURN series. A bounce
     gives negative autocorrelation; a random walk gives ~0; a trending
     market gives positive.
  2. The excess at each horizon. Bounce decays fast: if the excess at
     5 minutes is much smaller than at 1 minute, that is the bounce's
     half-life.
  3. The same measurement on the MID (the average of the bar's high and
     low, which removes the bid-ask component), against the same fee.
  4. The size of the excess against the ALL-IN cost (fee + the measured
     spread).

READ-ONLY. Writes one JSON. Never writes an *.ndjson. Never calls `jw3`.
"""
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
BARS_1M = SCRATCH / "hf-1m-bars.json"
OUT = SCRATCH / "hf-bounce-audit.json"

TAKER_ROUND_TRIP = 0.0012
MEDIAN_SPREAD_BPS = 10.685
NOTIONAL = 60.0


def mean(a):
    return sum(a) / len(a) if a else 0.0


def stdev(a):
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def tstat(a):
    n = len(a)
    if n < 2:
        return 0.0, float("nan")
    m = mean(a)
    s = stdev(a)
    if s == 0:
        return 0.0, float("nan")
    return m / (s / math.sqrt(n)), m


def load():
    raw = json.loads(BARS_1M.read_text())
    return {p: sorted(r, key=lambda x: x[0]) for p, r in raw.items() if len(r) >= 200}


def autocorrelation(rets, lag=1):
    """Pearson correlation of rets[lag:] against rets[:-lag]."""
    if len(rets) < lag + 10:
        return None
    x = rets[:-lag]
    y = rets[lag:]
    mx, my = mean(x), mean(y)
    sx, sy = stdev(x), stdev(y)
    if sx == 0 or sy == 0:
        return None
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    den = math.sqrt(sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y))
    return num / den if den else None


def cluster_means(pairs_of_ts_val):
    """Group (ts, val) into 15-minute clusters and return the cluster means."""
    buckets = defaultdict(list)
    for ts, v in pairs_of_ts_val:
        buckets[ts // (15 * 60_000)].append(v)
    return [mean(buckets[k]) for k in sorted(buckets)]


def main():
    data = load()
    out = {
        "pairs": len(data),
        "bars_total": sum(len(v) for v in data.values()),
        "fee_bps": TAKER_ROUND_TRIP * 10000,
        "spread_bps": MEDIAN_SPREAD_BPS,
        "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
    }

    # ── TEST 1: the autocorrelation of the 1-minute return ───────────────
    ac1 = []
    ac_all = []
    for pair, rows in data.items():
        c = [r[4] for r in rows]
        rets = [(c[i] - c[i - 1]) / c[i - 1] for i in range(1, len(c)) if c[i - 1] > 0]
        a = autocorrelation(rets, 1)
        if a is not None:
            ac1.append(a)
            for lag in (2, 3, 5):
                aa = autocorrelation(rets, lag)
                if aa is not None:
                    ac_all.append((lag, aa))
    t, m = tstat(ac1)
    out["lag1_autocorrelation"] = {
        "n_pairs": len(ac1),
        "mean": m,
        "median": statistics.median(ac1),
        "t_across_pairs": t,
        "verdict": (
            "NEGATIVE mean autocorrelation across pairs = a bid-ask bounce "
            "signature in the TRADE-price series"
            if m < 0 else "no negative autocorrelation"
        ),
    }
    by_lag = defaultdict(list)
    for lag, a in ac_all:
        by_lag[lag].append(a)
    out["autocorrelation_by_lag"] = {
        str(lag): {"mean": mean(v), "t": tstat(v)[0]} for lag, v in sorted(by_lag.items())
    }

    # ── TEST 2 + 3: the excess on TRADE closes and on MID ───────────────
    # For each horizon h, the "fade the last h-minute move" excess:
    #   excess = 2 * (mean signed return of the FADE direction)
    # computed on (a) the trade close and (b) the bar mid = (h+l)/2.
    def excess_table(price_of):
        res = {}
        for h in (1, 2, 3, 5, 10):
            ex = []
            for pair, rows in data.items():
                px = [price_of(r) for r in rows]
                for i in range(h, len(px) - h - 1):
                    c0, c1 = px[i - h], px[i]
                    if c0 <= 0:
                        continue
                    sig = (c1 - c0) / c0
                    if sig == 0:
                        continue
                    fwd = (px[i + h] - px[i]) / px[i]
                    if px[i] <= 0:
                        continue
                    # FADE: take the opposite of the trailing move
                    ex.append((rows[i][0], -2.0 * (1 if sig > 0 else -1) * fwd))
            if not ex:
                continue
            cm = cluster_means(ex)
            t, mm = tstat(cm)
            trimmed = sorted(cm)[3: len(cm) - 3] if len(cm) > 6 else cm
            tt, tm = tstat(trimmed)
            res[f"{h}m"] = {
                "n_clusters": len(cm),
                "excess_pct": mm * 100,
                "excess_bps": mm * 10000,
                "t": t,
                "trim_t": tt,
                "trim_excess_bps": tm * 10000,
                "gross_edge_bps_per_trade": mm * 10000 / 2,
                "excess_minus_fee_bps": mm * 10000 / 2 - TAKER_ROUND_TRIP * 10000,
                "excess_minus_all_in_bps": mm * 10000 / 2 - (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS),
            }
        return res

    out["fade_excess_on_trade_close"] = excess_table(lambda r: r[4])
    out["fade_excess_on_bar_mid"] = excess_table(lambda r: (r[2] + r[3]) / 2)

    # ── TEST 4: the move distribution vs the cost ────────────────────────
    mv = {}
    for h in (1, 2, 3, 5):
        rets = []
        for pair, rows in data.items():
            c = [r[4] for r in rows]
            for i in range(0, len(c) - h - 1, 5):
                if c[i] > 0:
                    rets.append(abs((c[i + h] - c[i]) / c[i]))
        if not rets:
            continue
        a = sorted(rets)
        n = len(a)
        mv[f"{h}m"] = {
            "n": n,
            "median_abs_bps": a[n // 2] * 10000,
            "mean_abs_bps": mean(a) * 10000,
            "p90_abs_bps": a[int(0.9 * n)] * 10000,
            "fee_bps": TAKER_ROUND_TRIP * 10000,
            "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
            "median_minus_fee_bps": a[n // 2] * 10000 - TAKER_ROUND_TRIP * 10000,
            "median_minus_all_in_bps": a[n // 2] * 10000 - (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS),
            "pct_beating_fee": sum(1 for x in a if x > TAKER_ROUND_TRIP) / n * 100,
            "pct_beating_all_in": sum(1 for x in a if x > TAKER_ROUND_TRIP + MEDIAN_SPREAD_BPS / 10000) / n * 100,
        }
    out["move_distribution"] = mv

    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"[bounce] written -> {OUT}")
    print(f"[bounce] lag1 autocorr mean {out['lag1_autocorrelation']['mean']:.5f} "
          f"t={out['lag1_autocorrelation']['t_across_pairs']:.2f} over "
          f"{out['lag1_autocorrelation']['n_pairs']} pairs")


if __name__ == "__main__":
    main()
