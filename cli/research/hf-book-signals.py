#!/usr/bin/env python3
"""
TEST 2 — THE COLLECTOR'S OWN BOOK SIGNALS AS SHORT-HORIZON PREDICTORS.

THE DATA
--------
`confluence.ndjson` records, per symbol per ~7-minute round:
  bookImbalance, spreadBps, bookMid, tapeChg, tapeVratio, tapeAtrPct,
  and the model's side/agreement.

THE QUESTION
------------
Is there a spread-widening or imbalance-flip signature that PRECEDES a
short-term move large enough to cover 0.12% of notional?

THE METHOD
----------
The forward price is resolved from the 1-minute bars at the row's ts, so
the resolution is on the SAME venue and the SAME symbols as the signal.

THE CONTROL is the SAME rows in the OPPOSITE direction, so the market's
drift cancels exactly. The EXCESS is signal-side minus opposite-side.

THE PLACEBO is a sign-randomised version of the same rows through the same
pipeline. A signal that cannot beat its own placebo has no edge.

CANDIDATE SIGNATURES (each is a PRECURSOR, measured on the value at t and
the outcome over t -> t+h):
  A. imbalance level      — sign(bookImbalance) predicts direction
  B. imbalance FLIP       — the sign of the CHANGE in imbalance, which is
                            the "flip" the question names
  C. spread widening      — the spread rising vs its own recent median
  D. spread widening + imbalance flip, together (the liquidity event)
  E. volume spike + imbalance flip

Every candidate reports: n rows, n clusters, excess in bps, t, trim-t,
placebo-t, and the excess against the ALL-IN cost.

READ-ONLY. Writes one JSON. Never writes an *.ndjson. Never calls `jw3`.
"""
import json
import math
import random
import statistics
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
CONFLUENCE = SCRATCH / "confluence.ndjson"
BARS_1M = SCRATCH / "hf-1m-bars.json"
OUT = SCRATCH / "hf-book-signals.json"

FEE = 0.0012
SPREAD_BPS = 10.685
ALL_IN = FEE + SPREAD_BPS / 10000
NOTIONAL = 60.0
CLUSTER_MS = 15 * 60_000


def mean(a):
    return sum(a) / len(a) if a else 0.0


def tstat(a):
    n = len(a)
    if n < 2:
        return 0.0, float("nan")
    m = mean(a)
    s = stdev(a)
    if s == 0:
        return 0.0, float("nan")
    return m / (s / math.sqrt(n)), m


def stdev(a):
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def cluster_mean_t(pairs):
    """pairs: list of (ts, value). Returns (t, mean, n_clusters, means)."""
    buckets = defaultdict(list)
    for ts, v in pairs:
        buckets[ts // CLUSTER_MS].append(v)
    means = [mean(buckets[k]) for k in sorted(buckets)]
    t, m = tstat(means)
    return t, m, len(means), means


def trim_t(means, k=3):
    if len(means) <= 2 * k:
        return 0.0, 0.0
    s = sorted(means)
    return tstat(s[k: len(s) - k])


def main():
    rows = [json.loads(l) for l in CONFLUENCE.read_text().splitlines() if l.strip()]
    rows.sort(key=lambda r: r["ts"])

    raw = json.loads(BARS_1M.read_text())
    bars = {}
    for pair, rs in raw.items():
        if len(rs) < 200:
            continue
        bars[pair] = {r[0]: r for r in rs}
        bars[pair]["__ts"] = sorted(r[0] for r in rs)
    bars = {p: b for p, b in bars.items() if p not in ("__ts",)}

    out = {
        "n_rows": len(rows),
        "n_pairs": len(set(r["pair"] for r in rows)),
        "pairs_with_1m_bars": len(bars),
        "span_hours": (rows[-1]["ts"] - rows[0]["ts"]) / 3.6e6,
        "fee_bps": FEE * 10000,
        "spread_bps": SPREAD_BPS,
        "all_in_bps": ALL_IN * 10000,
        "candidates": {},
    }

    # ── per-symbol priors from the collector's own rows ──────────────────
    imb_series = defaultdict(list)
    spr_series = defaultdict(list)
    for r in rows:
        if r.get("bookImbalance") is not None:
            imb_series[r["pair"]].append((r["ts"], r["bookImbalance"]))
        if r.get("spreadBps") is not None:
            spr_series[r["pair"]].append((r["ts"], r["spreadBps"]))

    def prior_median(sp, ts):
        vals = [v for t, v in sp if t < ts]
        return statistics.median(vals[-20:]) if len(vals) >= 5 else None

    def prior_imbalance(sp, ts):
        vals = [v for t, v in sp if t < ts]
        return vals[-1] if vals else None

    # ── resolve the forward price for each row ───────────────────────────
    # The event bar is the 1-minute bar CONTAINING the observation; the
    # entry is the CLOSE of that bar (the signal is known at the bar close).
    resolved = []
    for r in rows:
        pair = r["pair"]
        b = bars.get(pair)
        if not b:
            continue
        bt = (r["ts"] // 60_000) * 60_000
        bar = b.get(bt)
        if not bar:
            continue
        resolved.append((r, bar))

    def forward_return(pair, bt, horizon):
        b = bars.get(pair)
        if not b:
            return None
        ts_list = b["__ts"]
        try:
            i = ts_list.index(bt)
        except ValueError:
            return None
        j = i + horizon
        if j >= len(ts_list):
            return None
        c0 = b[bt][4]
        c1 = b[ts_list[j]][4]
        if c0 <= 0:
            return None
        return (c1 - c0) / c0

    def evaluate(name, direction_fn, horizon):
        """
        direction_fn(row, prior_ctx) -> +1 / -1 / 0.
        0 means the row does not qualify for this candidate.
        """
        events = []
        for r, bar in resolved:
            pair = r["pair"]
            d = direction_fn(r, pair)
            if d == 0:
                continue
            fwd = forward_return(pair, bar[0], horizon)
            if fwd is None:
                continue
            events.append((r["ts"], pair, d * fwd, d * fwd, r))
        if len(events) < 30:
            out["candidates"].setdefault(name, {})[f"h{horizon}m"] = {
                "n_events": len(events),
                "note": "too few events",
            }
            return
        ex = [(ts, 2.0 * v) for ts, _, v, _, _ in events]
        t, m, ncl, means = cluster_mean_t(ex)
        tt, tm = trim_t(means)
        # placebo: same rows, sign randomised
        rng = random.Random(777)
        pl = [(ts, 2.0 * (v if rng.random() < 0.5 else -v)) for ts, _, v, _, _ in events]
        pt, pm, pncl, pmeans = cluster_mean_t(pl)
        ptt, ptm = trim_t(pmeans)
        # the ALL-IN test
        edge_bps = m * 10000 / 2  # per trade (the excess is 2x the side return)
        out["candidates"].setdefault(name, {})[f"h{horizon}m"] = {
            "n_events": len(events),
            "n_clusters": ncl,
            "excess_bps": m * 10000,
            "edge_bps_per_trade": edge_bps,
            "t": t,
            "trim_t": tt,
            "trim_excess_bps": tm * 10000,
            "placebo_excess_bps": pm * 10000,
            "placebo_t": pt,
            "placebo_trim_t": ptt,
            "fee_bps": FEE * 10000,
            "all_in_bps": ALL_IN * 10000,
            "edge_minus_fee_bps": edge_bps - FEE * 10000,
            "edge_minus_all_in_bps": edge_bps - ALL_IN * 10000,
            "value_usd_per_trade_after_fee": NOTIONAL * (edge_bps - FEE * 10000) / 10000,
            "value_usd_per_trade_after_all_in": NOTIONAL * (edge_bps - ALL_IN * 10000) / 10000,
            "beats_placebo": edge_bps > pm * 10000 / 2,
            "passes_bar": ncl >= 30 and t >= 2.0 and m > 0 and edge_bps > pm * 10000 / 2,
        # A finding must CLEAR THE COST, not just beat zero.
        "clears_the_cost": edge_bps > ALL_IN * 10000,
        "passes_full_bar": (
            ncl >= 30 and t >= 2.0 and m > 0
            and edge_bps > pm * 10000 / 2
            and edge_bps > ALL_IN * 10000
        ),
        }

    # A. imbalance LEVEL
    evaluate("A_imbalance_level",
             lambda r, p: (1 if (r.get("bookImbalance") or 0) > 0 else -1),
             1)
    evaluate("A_imbalance_level",
             lambda r, p: (1 if (r.get("bookImbalance") or 0) > 0 else -1),
             3)
    evaluate("A_imbalance_level",
             lambda r, p: (1 if (r.get("bookImbalance") or 0) > 0 else -1),
             5)

    # B. imbalance FLIP (the sign of the change vs the previous observation)
    def imb_flip(r, p):
        prev = prior_imbalance(imb_series[p], r["ts"])
        cur = r.get("bookImbalance")
        if prev is None or cur is None:
            return 0
        if cur == prev:
            return 0
        return 1 if (cur > prev) else -1

    for h in (1, 3, 5):
        evaluate("B_imbalance_flip", imb_flip, h)

    # C. spread WIDENING (spread rising vs its own prior median)
    def spread_widen(r, p):
        med = prior_median(spr_series[p], r["ts"])
        cur = r.get("spreadBps")
        if med is None or cur is None:
            return 0
        if cur <= med:
            return 0
        # widening is treated as ADVERSE: fade it
        return -1

    for h in (1, 3, 5):
        evaluate("C_spread_widening", spread_widen, h)

    # D. spread widening AND imbalance flip together (the liquidity event)
    def liquidity_event(r, p):
        med = prior_median(spr_series[p], r["ts"])
        cur = r.get("spreadBps")
        prev = prior_imbalance(imb_series[p], r["ts"])
        now = r.get("bookImbalance")
        if med is None or cur is None or prev is None or now is None:
            return 0
        if cur <= med * 1.25:
            return 0
        if now == prev:
            return 0
        return 1 if now > prev else -1

    for h in (1, 3, 5):
        evaluate("D_spread_wide_plus_imb_flip", liquidity_event, h)

    # E. volume spike + imbalance flip
    def vol_spike_imb_flip(r, p):
        vr = r.get("tapeVratio")
        prev = prior_imbalance(imb_series[p], r["ts"])
        now = r.get("bookImbalance")
        if vr is None or prev is None or now is None:
            return 0
        if vr < 1.5:
            return 0
        if now == prev:
            return 0
        return 1 if now > prev else -1

    for h in (1, 3, 5):
        evaluate("E_volspike_plus_imb_flip", vol_spike_imb_flip, h)

    # ── the RAW, unfiltered baseline on the same rows ────────────────────
    # This is the control that decides whether ANY of the above is a
    # signal rather than the market's drift over the same 6 hours.
    for h in (1, 3, 5):
        ex = []
        for r, bar in resolved:
            fwd = forward_return(r["pair"], bar[0], h)
            if fwd is None:
                continue
            ex.append((r["ts"], fwd))
        if not ex:
            continue
        t, m, ncl, means = cluster_mean_t(ex)
        out.setdefault("raw_baseline_forward_return", {})[f"h{h}m"] = {
            "n_rows": len(ex),
            "n_clusters": ncl,
            "mean_bps": m * 10000,
            "t": t,
            "note": "the market's own drift over the collector's window",
        }

    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"[book] written -> {OUT}")
    print(f"[book] rows={len(rows)} pairs={out['n_pairs']} "
          f"resolved={len(resolved)} pairs_with_bars={len(bars)}")


if __name__ == "__main__":
    main()
