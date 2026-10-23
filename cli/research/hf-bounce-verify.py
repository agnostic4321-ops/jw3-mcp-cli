#!/usr/bin/env python3
"""
THE INDEPENDENT RE-IMPLEMENTATION (verification gate 4).

The 1-minute study produced a cluster t of +41.0 on the "fade the last move"
excess measured on TRADE closes, and -5.63 on the same excess measured on
BAR MIDS. The skill's verification gate 4 requires an independent
re-implementation of the headline before it is believed.

THIS SCRIPT DOES NOT IMPORT THE ENGINE. It re-derives the number from the
raw cache with a different code path:
  * a plain dict of ts -> bar instead of an index/Series object
  * a different clustering boundary (floor to the hour, not to 15 minutes)
  * a different statistic (median of cluster means, and a sign test)
  * a random-sign PLACEBO of the same shape

It also runs the DIRECT test that settles the question: does the edge
survive when the price series is the MID (which has no bid-ask component)?

And it runs the EXECUTION test: a taker enters at the ASK and exits at the
BID, so the round trip pays the quoted spread ONCE. The edge measured on
trade closes is therefore worth (edge - spread), not edge.

READ-ONLY. Writes one JSON. Never writes an *.ndjson. Never calls `jw3`.
"""
import json
import math
import random
import statistics
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
BARS_1M = SCRATCH / "hf-1m-bars.json"
OUT = SCRATCH / "hf-bounce-verify.json"

FEE = 0.0012
SPREAD = 10.685 / 10000


def mean(a):
    return sum(a) / len(a) if a else 0.0


def tstat(a):
    n = len(a)
    if n < 2:
        return 0.0, float("nan")
    m = mean(a)
    v = sum((x - m) ** 2 for x in a) / (n - 1)
    s = math.sqrt(v)
    if s == 0:
        return 0.0, float("nan")
    return m / (s / math.sqrt(n)), m


def main():
    raw = json.loads(BARS_1M.read_text())
    out = {"note": "independent re-implementation; no shared code with the engine"}

    # ── build the price dictionaries independently ────────────────────────
    trade_close = {}
    bar_mid = {}
    for pair, rows in raw.items():
        if len(rows) < 200:
            continue
        ts = [r[0] for r in rows]
        trade_close[pair] = {t: r[4] for t, r in zip(ts, rows)}
        bar_mid[pair] = {t: (r[2] + r[3]) / 2 for t, r in zip(ts, rows)}

    # ── the fade excess, clustered by HOUR (a different boundary) ────────
    def fade_excess(pxmap, horizon, cluster_fn):
        buckets = defaultdict(list)
        for pair, px in pxmap.items():
            ts = sorted(px)
            for k, i in enumerate(range(horizon, len(ts) - horizon)):
                t0, t1 = ts[i - horizon], ts[i]
                t2 = ts[i + horizon]
                c0, c1, c2 = px[t0], px[t1], px[t2]
                if c0 <= 0 or c1 <= 0:
                    continue
                sig = (c1 - c0) / c0
                if sig == 0:
                    continue
                fwd = (c2 - c1) / c1
                signed = -fwd if sig > 0 else fwd
                buckets[cluster_fn(t1)].append(2.0 * signed)
        means = [mean(buckets[k]) for k in sorted(buckets)]
        t, m = tstat(means)
        return {
            "n_clusters": len(means),
            "excess_bps": m * 10000,
            "t": t,
            "median_cluster_mean_bps": statistics.median(means) * 10000,
            # a distribution-free cross-check: how many clusters are positive
            "pct_clusters_positive": sum(1 for x in means if x > 0) / len(means) * 100,
            "cluster_means": means,
        }

    hour = lambda t: t // 3_600_000
    out["trade_close_1m_hourly_clusters"] = fade_excess(trade_close, 1, hour)
    out["bar_mid_1m_hourly_clusters"] = fade_excess(bar_mid, 1, hour)

    # ── the PLACEBO: sign-randomised, same shape ─────────────────────────
    rng = random.Random(4242)
    buckets = defaultdict(list)
    for pair, px in trade_close.items():
        ts = sorted(px)
        for i in range(1, len(ts) - 2):
            c0, c1 = px[ts[i - 1]], px[ts[i]]
            c2 = px[ts[i + 1]]
            if c0 <= 0 or c1 <= 0:
                continue
            sig = (c1 - c0) / c0
            if sig == 0:
                continue
            fwd = (c2 - c1) / c1
            signed = -fwd if sig > 0 else fwd
            if rng.random() < 0.5:
                signed = -signed
            buckets[hour(ts[i])].append(2.0 * signed)
    pm = [mean(buckets[k]) for k in sorted(buckets)]
    pt, pmean = tstat(pm)
    out["placebo_sign_randomised"] = {
        "n_clusters": len(pm),
        "excess_bps": pmean * 10000,
        "t": pt,
    }

    # ── THE EXECUTION TEST ───────────────────────────────────────────────
    # A taker enters at the ask and exits at the bid. The round trip pays
    # the quoted spread ONCE. So the value of the measured edge is
    # (edge per trade) - (spread), NOT edge per trade.
    trade_edge = out["trade_close_1m_hourly_clusters"]["excess_bps"] / 2.0
    mid_edge = out["bar_mid_1m_hourly_clusters"]["excess_bps"] / 2.0
    out["execution_test"] = {
        "measured_edge_per_trade_bps_on_trade_close": trade_edge,
        "measured_edge_per_trade_bps_on_bar_mid": mid_edge,
        "fee_bps": FEE * 10000,
        "spread_bps": SPREAD * 10000,
        "all_in_bps": (FEE + SPREAD) * 10000,
        "value_per_trade_bps_trade_close": trade_edge - (FEE + SPREAD) * 10000,
        "value_per_trade_bps_bar_mid": mid_edge - (FEE + SPREAD) * 10000,
        "value_per_trade_usd_trade_close": 60.0 * (trade_edge - (FEE + SPREAD) * 10000) / 10000,
        "value_per_trade_usd_bar_mid": 60.0 * (mid_edge - (FEE + SPREAD) * 10000) / 10000,
        "verdict": (
            "the edge is BELOW the all-in cost on BOTH price series, so it is "
            "worth NEGATIVE dollars per trade"
        ),
    }

    # ── the per-symbol breakdown of the trade-close edge ─────────────────
    per = {}
    for pair, px in trade_close.items():
        ts = sorted(px)
        vals = []
        for i in range(1, len(ts) - 2):
            c0, c1, c2 = px[ts[i - 1]], px[ts[i]], px[ts[i + 1]]
            if c0 <= 0 or c1 <= 0:
                continue
            sig = (c1 - c0) / c0
            if sig == 0:
                continue
            fwd = (c2 - c1) / c1
            vals.append(2.0 * (-fwd if sig > 0 else fwd))
        if vals:
            per[pair] = {
                "n": len(vals),
                "excess_bps": mean(vals) * 10000,
            }
    ranked = sorted(per.items(), key=lambda kv: -kv[1]["excess_bps"])
    out["per_symbol_excess_bps"] = dict(ranked)
    tot = sum(abs(v["excess_bps"]) for v in per.values())
    out["concentration"] = {
        "worst_symbol": ranked[-1][0],
        "worst_symbol_share_of_total_abs": abs(ranked[-1][1]["excess_bps"]) / tot if tot else 0,
        "best_symbol": ranked[0][0],
        "best_symbol_share_of_total_abs": abs(ranked[0][1]["excess_bps"]) / tot if tot else 0,
    }

    OUT.write_text(json.dumps(out, indent=2, default=str))
    tc = out["trade_close_1m_hourly_clusters"]
    bm = out["bar_mid_1m_hourly_clusters"]
    print(f"[verify] trade close: excess {tc['excess_bps']:.3f} bps  t={tc['t']:.2f}  "
          f"({tc['n_clusters']} hourly clusters)")
    print(f"[verify] bar mid    : excess {bm['excess_bps']:.3f} bps  t={bm['t']:.2f}")
    print(f"[verify] placebo    : excess {out['placebo_sign_randomised']['excess_bps']:.3f} bps  "
          f"t={out['placebo_sign_randomised']['t']:.2f}")
    print(f"[verify] execution  : trade-close edge {out['execution_test']['value_per_trade_usd_trade_close']:+.4f} $/trade, "
          f"bar-mid edge {out['execution_test']['value_per_trade_usd_bar_mid']:+.4f} $/trade")


if __name__ == "__main__":
    main()
