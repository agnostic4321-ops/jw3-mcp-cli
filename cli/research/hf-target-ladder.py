#!/usr/bin/env python3
"""
THE TARGET LADDER — can a WIDER TARGET rescue the microstructure edge?

WHY THIS EXISTS
---------------
The fee floor says the shipped $0.18 gross take-profit is 40% consumed by
the 0.12% taker fee (79% by fee + spread). The obvious question is: what
if the target is wider, so the fee amortises over a bigger move?

THE ANSWER MUST BE MEASURED, NOT ASSUMED, because a wider target also
means the move takes LONGER to happen, which changes the horizon the
signal has to work at, and it changes the hit rate.

THE DESIGN
----------
For each (target, stop, time-exit) triple, the SAME signal family is run:
  - the "fade the last move" family (the only family with a measured
    edge, and that edge is a bid-ask bounce — see hf-bounce-audit.py)
  - the "follow the last move" family (the control)
  - an ALWAYS-LONG arm (the market's own drift) as the beta baseline

Each is resolved with FIRST-TOUCH barriers on 1-minute bars (both levels
touched = LOSS, neither level touched = TIME EXIT), and the net is
reported in DOLLARS on the real $60 ticket with the 0.12% taker fee AND
with the median 10.7 bps spread added.

The verdict per row is the NET DOLLARS PER TRADE, and the question is
whether ANY row is positive.

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
OUT = SCRATCH / "hf-target-ladder.json"

FEE = 0.0012
SPREAD = 0.0010685
NOTIONAL = 60.0
CLUSTER_MS = 15 * 60_000


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


def main():
    raw = json.loads(BARS_1M.read_text())
    bars = {}
    for pair, rs in raw.items():
        if len(rs) < 2000:
            continue
        rs = sorted(rs, key=lambda r: r[0])
        bars[pair] = {"ts": [r[0] for r in rs], "rows": rs}

    out = {
        "pairs": len(bars),
        "bars_total": sum(len(b["ts"]) for b in bars.values()),
        "fee_round_trip_pct": FEE * 100,
        "spread_pct": SPREAD * 100,
        "notional": NOTIONAL,
        "ladder": [],
    }

    def run(kind, target, stop, time_exit, lookback):
        """
        kind: "fade" | "follow" | "always_long"
        Returns the trade list.
        """
        trades = []
        for pair, b in bars.items():
            ts = b["ts"]
            rows = b["rows"]
            n = len(rows)
            for i in range(lookback, n - 2):
                c0 = rows[i - lookback][4]
                c1 = rows[i][4]
                if c0 <= 0 or c1 <= 0:
                    continue
                sig = (c1 - c0) / c0
                if kind == "always_long":
                    side = "long"
                else:
                    if sig == 0:
                        continue
                    if kind == "fade":
                        side = "short" if sig > 0 else "long"
                    else:
                        side = "long" if sig > 0 else "short"
                entry = c1
                if side == "long":
                    tgt = entry * (1 + target)
                    stp = entry * (1 - stop)
                else:
                    tgt = entry * (1 - target)
                    stp = entry * (1 + stop)
                jmax = min(i + time_exit, n - 1)
                outcome = None
                ret = None
                for j in range(i + 1, jmax + 1):
                    h = rows[j][2]
                    l = rows[j][3]
                    ht = (h >= tgt) if side == "long" else (l <= tgt)
                    hs = (l <= stp) if side == "long" else (h >= stp)
                    if ht and hs:
                        outcome, ret = "loss", -stop
                        break
                    if hs:
                        outcome, ret = "loss", -stop
                        break
                    if ht:
                        outcome, ret = "win", target
                        break
                if outcome is None:
                    ex = rows[jmax][4]
                    outcome = "time"
                    ret = (ex - entry) / entry if side == "long" else (entry - ex) / entry
                trades.append((ts[i], pair, outcome, ret))
        return trades

    def summarize(trades, label, target, stop, time_exit, kind):
        if not trades:
            return None
        nets_fee = [NOTIONAL * (r - FEE) for (_, _, _, r) in trades]
        nets_all = [NOTIONAL * (r - FEE - SPREAD) for (_, _, _, r) in trades]
        buckets = defaultdict(list)
        for (ts, p, o, r), net in zip(trades, nets_fee):
            buckets[ts // CLUSTER_MS].append(net)
        cm = [mean(buckets[k]) for k in sorted(buckets)]
        t, m = tstat(cm)
        wins = sum(1 for x in trades if x[2] == "win")
        losses = sum(1 for x in trades if x[2] == "loss")
        times = sum(1 for x in trades if x[2] == "time")
        trimmed = sorted(cm)[3: len(cm) - 3] if len(cm) > 6 else cm
        tt, tm = tstat(trimmed)
        # placebo: same trades, direction flipped for half of them
        rng = random.Random(31337)
        pb = defaultdict(list)
        for (ts, p, o, r) in trades:
            if rng.random() < 0.5:
                r = -r
            pb[ts // CLUSTER_MS].append(NOTIONAL * (r - FEE))
        pcm = [mean(pb[k]) for k in sorted(pb)]
        pt, pm = tstat(pcm)
        return {
            "arm": label,
            "kind": kind,
            "target_pct": target * 100,
            "stop_pct": stop * 100,
            "time_exit_min": time_exit,
            "n_trades": len(trades),
            "n_clusters": len(cm),
            "win_rate": wins / len(trades),
            "n_win": wins,
            "n_loss": losses,
            "n_time": times,
            "net_per_trade_usd_fee_only": mean(nets_fee),
            "net_per_trade_usd_all_in": mean(nets_all),
            "total_net_usd_fee_only": sum(nets_fee),
            "cluster_t": t,
            "cluster_mean_usd": m,
            "trim_t": tt,
            "trim_mean_usd": tm,
            "placebo_net_per_trade_usd": pm,
            "placebo_t": pt,
            "beats_placebo": mean(nets_fee) > pm,
        }

    # ── the ladder ───────────────────────────────────────────────────────
    triples = [
        (0.0012, 0.0012, 5),   # the fee itself, 1:1, 5-minute exit
        (0.0012, 0.0024, 5),
        (0.0024, 0.0024, 5),
        (0.0024, 0.0048, 10),
        (0.0048, 0.0048, 15),
        (0.0048, 0.0096, 30),
        (0.0096, 0.0096, 60),
        (0.0096, 0.0192, 120),
        (0.0192, 0.0192, 240),
    ]
    for target, stop, te in triples:
        for kind, label in (("fade", "FADE (the measured edge)"),
                            ("follow", "FOLLOW (momentum control)"),
                            ("always_long", "ALWAYS LONG (beta)")):
            tr = run(kind, target, stop, te, 1)
            s = summarize(tr, label, target, stop, te, kind)
            if s:
                out["ladder"].append(s)

    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"[ladder] written -> {OUT}")
    print(f"[ladder] {len(out['ladder'])} rows, pairs={out['pairs']}")


if __name__ == "__main__":
    main()
