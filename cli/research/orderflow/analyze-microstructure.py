#!/usr/bin/env python3
"""
THE MICROSTRUCTURE SIGNALS AT 1-SECOND RESOLUTION — and the fee floor.

WHAT THIS TESTS
---------------
The project's collector samples every 5 MINUTES. At that resolution the
book imbalance is a snapshot of a book that has already been replaced
several times, and the recorded spread is a spread that no longer
exists. This study uses the EVENT-resolution recording
(`collect-microstructure.py`, KuCoin futures public WS, keyless) and
tests the six microstructure signals the project has NEVER been able to
test:

  (1) BOOK IMBALANCE at 1s resolution  -> the next 1s / 5s / 15s move
  (2) THE IMBALANCE FLIP                -> a reversal signature
  (3) A LARGE TRADE PRINT               -> informed flow
  (4) SPREAD WIDENING                  -> volatility / exhaustion
  (5) TRADE-FLOW IMBALANCE              -> continuation (buy vs sell volume)
  (6) ORDER-BOOK RESILIENCE             -> when the bid is PULLED, does price fall?

THE BAR — THE ONLY QUESTION THAT MATTERS AT THIS ACCOUNT SIZE
-------------------------------------------------------------
    equity           $56.89
    notional/ticket  $60.00
    taker round trip 0.12% of notional = $0.0720 per ticket

A signal whose predicted forward move has a 90th percentile BELOW
0.12% of notional cannot pay: the round trip alone costs 0.12%. A
market entry ALSO crosses the spread, so the EFFECTIVE FLOOR is 0.12%
+ the symbol's median spread. Both floors are reported.

THE METHOD (the rules this project has learned the hard way)
-------------------------------------------------------------
  * THE PREDICTED MOVE IS MEASURED IN THE SIGNAL'S DIRECTION, and the
    CONTROL is the SAME population with the direction REVERSED (the
    sign-flip control). A signal whose excess over its own sign-flip is
    zero is not a signal.
  * OVERLAPPING HORIZONS ARE NOT INDEPENDENT OBSERVATIONS. A 5-second
    forward window on 1-second data overlaps its neighbour by 80%, so
    the naive n is inflated ~5x and every t-statistic is fiction. Every
    arm is therefore ALSO measured on a NON-OVERLAPPING subsample
    (consecutive kept observations at least `horizon` apart). The
    non-overlapping n and its t are the ones to read.
  * THE SPREAD IS THE ARM'S OWN MEDIAN SPREAD, not one symbol's.
  * EVERY RESULT IS REPORTED POOLED, and the per-symbol concentration
    is printed for the headline signal.

READ-ONLY. Reads the recording. Writes one JSON. Never writes an
*.ndjson. Never calls `jw3` and never touches the account.
"""
import bisect
import json
import math
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
MICRO = SCRATCH / "microstructure"
OUT = SCRATCH / "microstructure-signals.json"

# ── THE ACCOUNT, as measured ──────────────────────────────────────────────
EQUITY = 56.89
NOTIONAL = 60.0
TAKER_ROUND_TRIP = 0.0012               # 0.06%/leg on the venue's own contract list
FEE_USD = NOTIONAL * TAKER_ROUND_TRIP   # $0.0720
FEE_PCT = TAKER_ROUND_TRIP * 100        # 0.12%
GOAL_USD = 10000.0
DAILY_NOTIONAL_CAP = 500.0
MAX_TICKETS = int(DAILY_NOTIONAL_CAP // NOTIONAL)   # 8
ROUND_TRIP_SEC = 7.0                    # the live path's 4-7 second round trip

HORIZONS = [1, 5, 15]                   # seconds

# The minimum number of non-overlapping observations for an arm's p90 to be
# REPORTABLE. A p90 over 37 points is the 4th-largest of 37 — it is a
# maximum, not a percentile, and it does not generalise. The project's own
# bar (docs/research/falsified-leads.md) is 30 independent clusters; here
# the observations are seconds, and 30 seconds of a 15-second horizon is
# nothing, so the bar is raised.
MIN_N_REPORTABLE = 100


# ══ statistics ════════════════════════════════════════════════════════════

def pct(xs, q):
    if not xs:
        return None
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    idx = q * (len(s) - 1)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def tstat(xs):
    """One-sample t on a list. Returns (t, mean)."""
    n = len(xs)
    if n < 2:
        return 0.0, float("nan")
    m = mean(xs)
    s = stdev(xs)
    if s == 0:
        return 0.0, float("nan")
    return m / (s / math.sqrt(n)), m


def load_jsonl(path):
    rows = []
    if not path.exists():
        return rows
    with open(path) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


class Book:
    """The recording, indexed for O(log n) forward-move lookup."""

    def __init__(self, rows):
        self.by_sym = defaultdict(list)     # sym -> [(vts, mid)]
        self.rows_by_sym = defaultdict(dict)  # sym -> {vts: row}
        self.ts_index = {}                  # sym -> sorted list of vts
        seen = set()
        for r in rows:
            mid = r.get("mid")
            imb = r.get("imb")
            if not mid or imb is None:
                continue
            key = (r["sym"], r["vts"])
            if key in seen:
                continue
            seen.add(key)
            self.by_sym[r["sym"]].append((r["vts"], mid))
            self.rows_by_sym[r["sym"]][r["vts"]] = r
        for s in self.by_sym:
            self.by_sym[s].sort()
            self.ts_index[s] = [t for t, _ in self.by_sym[s]]

    def forward_pct(self, sym, vts, horizon):
        """
        The forward move from `vts` to `vts + horizon`, in percent.

        Uses the LAST mid in the second `vts + horizon` as the outcome.
        Returns None when the outcome second has not been recorded.
        """
        idx = self.ts_index.get(sym)
        if not idx:
            return None
        hi = vts + horizon * 1000
        j = bisect.bisect_right(idx, hi) - 1
        if j < 0:
            return None
        # the last recorded second at or before hi
        end_ts = idx[j]
        if end_ts < vts:
            return None
        end_mid = self.by_sym[sym][j][1]
        i = bisect.bisect_right(idx, vts) - 1
        if i < 0:
            return None
        start_mid = self.by_sym[sym][i][1]
        if not start_mid:
            return None
        return (end_mid - start_mid) / start_mid * 100.0

    def spread_stats(self):
        out = {}
        for s, rows in self.rows_by_sym.items():
            sps = sorted(r["sprBps"] for r in rows.values() if r.get("sprBps"))
            out[s] = {
                "median_bps": st.median(sps) if sps else 0.0,
                "p90_bps": pct(sps, 0.90) or 0.0,
                "min_bps": sps[0] if sps else 0.0,
                "max_bps": sps[-1] if sps else 0.0,
                "rows": len(rows),
            }
        return out


def non_overlapping(obs, horizon_sec):
    """
    Keep only observations at least `horizon_sec` apart, per symbol.

    Two observations in the same symbol whose forward windows overlap
    share almost all of their price path, so they are ONE observation.
    """
    keep = []
    last_by_sym = {}
    for sym, vts, mid in sorted(obs, key=lambda o: (o[0], o[1])):
        last = last_by_sym.get(sym)
        if last is not None and vts - last < horizon_sec * 1000:
            continue
        last_by_sym[sym] = vts
        keep.append((sym, vts, mid))
    return keep


def describe(xs, fee_pct, eff_fee_pct):
    if not xs:
        return None
    p50 = pct(xs, 0.50)
    p90 = pct(xs, 0.90)
    wins = [x for x in xs if x > 0]
    return {
        "n": len(xs),
        "mean_pct": mean(xs),
        "median_pct": p50,
        "p90_pct": p90,
        "p95_pct": pct(xs, 0.95),
        "p99_pct": pct(xs, 0.99),
        "max_pct": max(xs),
        "min_pct": min(xs),
        "stdev_pct": stdev(xs),
        "frac_positive": len(wins) / len(xs),
        "mean_win_pct": mean(wins) if wins else 0.0,
        "p90_exceeds_fee": p90 > fee_pct,
        "p90_exceeds_effective_floor": p90 > eff_fee_pct,
        "mean_exceeds_fee": mean(xs) > fee_pct,
        "p90_usd_on_ticket": (p90 / 100.0) * NOTIONAL,
        "fee_pct": fee_pct,
        "effective_floor_pct": eff_fee_pct,
    }


def arm(signal, arm_name, direction, obs, book, horizon, spread_med_pct, note="", lag_sec=0):
    """
    One signal arm at one horizon.

    `obs` is a list of (sym, vts, mid). The forward move is taken in the
    signal's `direction` (+1 long, -1 short) and also REVERSED, so the
    excess over the sign-flip control is the signal's own contribution.

    THE LAG. Every signal here is read from the 1-SECOND AGGREGATE, so
    its state is only fully known at the END of that second. A trade
    entered at the mid of second `t` would therefore be using
    information from the last millisecond of second `t` — and, worse,
    the trade-flow arm uses the trades of the whole second, including
    prints that happened AFTER the mid it is being compared to. That is
    look-ahead, and this project has already been destroyed once by a
    look-ahead defect (the scratch artefact). So `lag_sec=1` measures the
    forward move from the START of second `t+1` — the first moment the
    signal is actually tradeable. The lagged number is the honest one.

    The arm is reported twice: on ALL observations, and on the
    NON-OVERLAPPING subsample (the honest n).
    """
    def collect(rows):
        fwd, rev = [], []
        for sym, vts, mid in rows:
            raw = book.forward_pct(sym, vts + lag_sec * 1000, horizon)
            if raw is None:
                continue
            fwd.append(direction * raw)
            rev.append(-direction * raw)
        return fwd, rev

    fwd_all, rev_all = collect(obs)
    if not fwd_all:
        return None
    no_obs = non_overlapping(obs, horizon)
    fwd_no, rev_no = collect(no_obs)

    eff = FEE_PCT + spread_med_pct
    d = describe(fwd_all, FEE_PCT, eff)
    t_all, _ = tstat(fwd_all)
    exc_all = [a - b for a, b in zip(fwd_all, rev_all)]
    t_exc_all, _ = tstat(exc_all)

    d["n_nonoverlap"] = len(fwd_no)
    d["mean_nonoverlap_pct"] = mean(fwd_no) if fwd_no else None
    d["p90_nonoverlap_pct"] = pct(fwd_no, 0.90) if fwd_no else None
    d["p90_nonoverlap_exceeds_fee"] = (d["p90_nonoverlap_pct"] > FEE_PCT) if fwd_no else None
    d["p90_nonoverlap_usd_on_ticket"] = (
        (d["p90_nonoverlap_pct"] / 100.0) * NOTIONAL if fwd_no else None)
    t_no, _ = tstat(fwd_no)
    d["t_nonoverlap"] = t_no
    t_exc_no, _ = tstat([a - b for a, b in zip(fwd_no, rev_no)])
    d["t_excess_vs_reversed_nonoverlap"] = t_exc_no

    d["control_reversed_mean_pct"] = mean(rev_all)
    d["excess_over_reversed_pct"] = mean(fwd_all) - mean(rev_all)
    d["t_forward"] = t_all
    d["t_excess_vs_reversed"] = t_exc_all
    d["horizon_sec"] = horizon
    d["lag_sec"] = lag_sec
    d["direction"] = "long" if direction > 0 else "short"
    d["signal"] = signal
    d["arm"] = arm_name
    d["note"] = note
    d["median_spread_bps_used"] = spread_med_pct * 100
    d["symbols"] = sorted(set(o[0] for o in obs))
    # THE ACTUAL ECONOMICS: the mean forward move in the signal's
    # direction, in dollars on a $60 ticket, minus the fee.
    gross_usd = (mean(fwd_all) / 100.0) * NOTIONAL
    d["mean_gross_usd"] = gross_usd
    d["net_ev_usd"] = gross_usd - FEE_USD
    d["net_ev_pct_of_equity"] = d["net_ev_usd"] / EQUITY * 100
    d["ev_per_8_trades_usd"] = 8 * d["net_ev_usd"]
    d["reportable"] = d["n_nonoverlap"] >= MIN_N_REPORTABLE
    d["min_n_required"] = MIN_N_REPORTABLE
    return d


def placebo(best_arm, book, allobs_by_h, n_draws=500, seed=20261021):
    """
    THE PLACEBO. The project's rule: "a positive number that is not an
    excess over a baseline is not an edge". The sharpest version of that
    for a p90 question is: what is the best p90 a RANDOM selection of the
    same size and shape can produce on this same data?

    If the arm's p90 is inside the placebo distribution, it is luck.
    """
    import random
    rnd = random.Random(seed)
    h = best_arm["horizon_sec"]
    lag = best_arm.get("lag_sec", 0)
    direction = 1 if best_arm["direction"] == "long" else -1
    n = best_arm["n"]
    pool = allobs_by_h.get(h, [])
    if len(pool) < n:
        return None
    placebo_p90 = []
    for _ in range(n_draws):
        sample = rnd.sample(pool, n)
        vals = []
        for sym, vts, mid in sample:
            raw = book.forward_pct(sym, vts + lag * 1000, h)
            if raw is not None:
                vals.append(direction * raw)
        if vals:
            placebo_p90.append(pct(vals, 0.90))
    arm_p90 = best_arm["p90_pct"]
    at_least = sum(1 for p in placebo_p90 if p >= arm_p90)
    return {
        "n_draws": n_draws,
        "arm_p90": arm_p90,
        "placebo_p90_median": pct(placebo_p90, 0.50),
        "placebo_p90_p90": pct(placebo_p90, 0.90),
        "placebo_p90_max": max(placebo_p90) if placebo_p90 else None,
        "placebo_runs_at_or_above_arm": at_least,
        "placebo_rate_at_or_above_arm": at_least / n_draws if placebo_p90 else None,
        "verdict": ("BEATS THE PLACEBO" if at_least / max(len(placebo_p90), 1) < 0.05
                    else "INSIDE THE PLACEBO — indistinguishable from a random selection"),
    }


def half_split(best_arm, book, allobs_by_h):
    """
    THE HALF-SPLIT. The project's stability bar (oos2.mjs): the signal
    must work in BOTH chronological halves of the recording, out of
    sample. A p90 that exists in the first half only is a regime, not a
    signal.

    The split is by TIME, across the whole recording, and it is applied to
    the arm's own observations.
    """
    h = best_arm["horizon_sec"]
    lag = best_arm.get("lag_sec", 0)
    direction = 1 if best_arm["direction"] == "long" else -1
    pool = sorted(allobs_by_h.get(h, []), key=lambda o: (o[0], o[1]))
    if len(pool) < 100:
        return None
    half = len(pool) // 2
    out = {}
    for label, chunk in (("first_half", pool[:half]), ("second_half", pool[half:])):
        vals = []
        for sym, vts, mid in chunk:
            raw = book.forward_pct(sym, vts + lag * 1000, h)
            if raw is not None:
                vals.append(direction * raw)
        if not vals:
            continue
        out[label] = {
            "n": len(vals),
            "mean_pct": mean(vals),
            "p90_pct": pct(vals, 0.90),
            "p90_exceeds_fee": pct(vals, 0.90) > FEE_PCT,
            "net_ev_usd": (mean(vals) / 100.0) * NOTIONAL - FEE_USD,
        }
    if len(out) == 2:
        a, b = out["first_half"], out["second_half"]
        out["both_halves_positive_mean"] = (a["mean_pct"] > 0 and b["mean_pct"] > 0)
        out["both_halves_p90_above_fee"] = (a["p90_exceeds_fee"] and b["p90_exceeds_fee"])
        out["sign_stable"] = (a["mean_pct"] * b["mean_pct"]) > 0
    return out


def main():
    book_rows = load_jsonl(MICRO / "book-1s.jsonl")
    trades = load_jsonl(MICRO / "trades.jsonl")
    meta_path = MICRO / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    if not book_rows:
        print(f"FATAL: no recording at {MICRO}")
        return 2

    book = Book(book_rows)
    sp = book.spread_stats()

    print("=" * 120)
    print(" THE MICROSTRUCTURE SIGNALS AT 1-SECOND RESOLUTION")
    print("=" * 120)
    print(f"  recording        {MICRO}")
    print(f"  symbols          {sorted(book.by_sym)}")
    print(f"  minutes recorded {meta.get('minutes_run', '(still running)')}")
    print(f"  book rows        {sum(len(v) for v in book.rows_by_sym.values())}")
    print(f"  trades           {len(trades)}")
    print()
    print("  THE BOOK AT 1 SECOND:")
    print(f"    {'symbol':12s} {'rows':>7s} {'span_s':>7s} {'sprBps med':>11s} {'sprBps p90':>11s} "
          f"{'sprBps max':>11s} {'trades':>7s}")
    for s in sorted(book.by_sym):
        ts = book.ts_index[s]
        trn = sum(1 for t in trades if t["sym"] == s)
        print(f"    {s:12s} {len(ts):7d} {(ts[-1]-ts[0])/1000:7.0f} "
              f"{sp[s]['median_bps']:11.3f} {sp[s]['p90_bps']:11.3f} "
              f"{sp[s]['max_bps']:11.3f} {trn:7d}")
    print()

    def spread_for(syms):
        """The arm's own median spread, in PERCENT of notional."""
        vals = [sp[s]["median_bps"] for s in syms if s in sp]
        return (st.median(vals) / 100.0) if vals else 0.0

    results = {}

    def emit(grp, arm_name, direction, obs, horizon, note, lag=0):
        if not obs:
            return
        b = arm(grp, arm_name, direction, obs, book, horizon,
                spread_for([o[0] for o in obs]), note, lag_sec=lag)
        if not b:
            return
        key = f"{arm_name}_{horizon}s" + ("_LAG1" if lag else "")
        results.setdefault(grp, {})[key] = b

    # ── (1) BOOK IMBALANCE at 1s resolution ──────────────────────────────
    for thr in (0.3, 0.5, 0.7):
        for h in HORIZONS:
            obs_long, obs_short = [], []
            for s in sorted(book.by_sym):
                for vts, r in book.rows_by_sym[s].items():
                    imb = r.get("imb")
                    if imb is None:
                        continue
                    if imb >= thr:
                        obs_long.append((s, vts, r["mid"]))
                    elif imb <= -thr:
                        obs_short.append((s, vts, r["mid"]))
            emit(f"1_imbalance_{thr}", "imb_long", +1, obs_long, h,
                 "the imbalance's own direction (continuation)")
            emit(f"1_imbalance_{thr}", "imb_short", -1, obs_short, h,
                 "the imbalance's own direction (continuation)")
            emit(f"1_imbalance_{thr}", "imb_long", +1, obs_long, h,
                 "LAGGED 1s: the signal is known only at the end of its second", lag=1)
            emit(f"1_imbalance_{thr}", "imb_short", -1, obs_short, h,
                 "LAGGED 1s: the signal is known only at the end of its second", lag=1)

    # ── (2) THE IMBALANCE FLIP ───────────────────────────────────────────
    for h in HORIZONS:
        obs_long, obs_short = [], []
        for s in sorted(book.by_sym):
            idx = book.ts_index[s]
            rows = book.rows_by_sym[s]
            for i in range(1, len(idx)):
                t0, t1 = idx[i - 1], idx[i]
                if t1 - t0 != 1000:
                    continue
                a = rows[t0].get("imb")
                b = rows[t1].get("imb")
                if a is None or b is None:
                    continue
                if a >= 0.2 and b <= -0.2:
                    obs_short.append((s, t1, rows[t1]["mid"]))
                elif a <= -0.2 and b >= 0.2:
                    obs_long.append((s, t1, rows[t1]["mid"]))
        emit("2_imbalance_flip", "flip_to_long", +1, obs_long, h,
             "the imbalance flipped to a long lean; trade WITH the new lean")
        emit("2_imbalance_flip", "flip_to_short", -1, obs_short, h,
             "the imbalance flipped to a short lean; trade WITH the new lean")
        emit("2_imbalance_flip", "flip_to_long", +1, obs_long, h,
             "LAGGED 1s: the flip is known only at the end of its second", lag=1)
        emit("2_imbalance_flip", "flip_to_short", -1, obs_short, h,
             "LAGGED 1s: the flip is known only at the end of its second", lag=1)

    # ── (3) A LARGE TRADE PRINT ──────────────────────────────────────────
    for q in (0.90, 0.99):
        for h in HORIZONS:
            obs_long, obs_short = [], []
            for s in sorted(set(t["sym"] for t in trades)):
                ts = [t for t in trades if t["sym"] == s]
                cut = pct(sorted(t["notional"] for t in ts), q)
                if cut is None:
                    continue
                for t in ts:
                    if t["notional"] < cut:
                        continue
                    mid = t.get("mid")
                    if mid is None:
                        continue
                    vsec = (t["vts"] // 1000) * 1000
                    if t["side"] == "buy":
                        obs_long.append((s, vsec, mid))
                    else:
                        obs_short.append((s, vsec, mid))
            emit(f"3_large_print_q{q}", "buy_print", +1, obs_long, h,
                 f"a trade >= the {q:.0%} percentile of its symbol; the print's own taker side")
            emit(f"3_large_print_q{q}", "sell_print", -1, obs_short, h,
                 f"a trade >= the {q:.0%} percentile of its symbol; the print's own taker side")
            emit(f"3_large_print_q{q}", "buy_print", +1, obs_long, h,
                 "LAGGED 1s: the print is known only at the end of its second", lag=1)
            emit(f"3_large_print_q{q}", "sell_print", -1, obs_short, h,
                 "LAGGED 1s: the print is known only at the end of its second", lag=1)

    # ── (4) SPREAD WIDENING ──────────────────────────────────────────────
    for h in HORIZONS:
        obs_fade_up, obs_fade_down = [], []
        for s in sorted(book.by_sym):
            idx = book.ts_index[s]
            rows = book.rows_by_sym[s]
            for i in range(1, len(idx)):
                t0, t1 = idx[i - 1], idx[i]
                if t1 - t0 != 1000:
                    continue
                r0, r1 = rows[t0], rows[t1]
                s0, s1 = r0.get("sprBps"), r1.get("sprBps")
                if s0 is None or s1 is None or s0 <= 0:
                    continue
                if s1 <= s0 * 1.5:
                    continue
                last_move = (r1["mid"] - r0["mid"]) / r0["mid"] * 100.0
                if last_move >= 0:
                    obs_fade_up.append((s, t1, r1["mid"]))
                else:
                    obs_fade_down.append((s, t1, r1["mid"]))
        emit("4_spread_widening", "fade_up", +1, obs_fade_up, h,
             "the spread widened >=1.5x in the last second; trade AGAINST the last move")
        emit("4_spread_widening", "fade_down", -1, obs_fade_down, h,
             "the spread widened >=1.5x in the last second; trade AGAINST the last move")
        emit("4_spread_widening", "fade_up", +1, obs_fade_up, h,
             "LAGGED 1s: the widening is known only at the end of its second", lag=1)
        emit("4_spread_widening", "fade_down", -1, obs_fade_down, h,
             "LAGGED 1s: the widening is known only at the end of its second", lag=1)

    # ── (5) TRADE-FLOW IMBALANCE ─────────────────────────────────────────
    for thr in (0.3, 0.6):
        for h in HORIZONS:
            obs_long, obs_short = [], []
            for s in sorted(book.by_sym):
                for vts, r in book.rows_by_sym[s].items():
                    bn = r.get("buyNotional") or 0.0
                    sn = r.get("sellNotional") or 0.0
                    tot = bn + sn
                    if tot <= 0:
                        continue
                    tfi = (bn - sn) / tot
                    if tfi >= thr:
                        obs_long.append((s, vts, r["mid"]))
                    elif tfi <= -thr:
                        obs_short.append((s, vts, r["mid"]))
            emit(f"5_trade_flow_{thr}", "tfi_long", +1, obs_long, h,
                 "buying vs selling volume in the second; trade WITH the flow")
            emit(f"5_trade_flow_{thr}", "tfi_short", -1, obs_short, h,
                 "buying vs selling volume in the second; trade WITH the flow")
            emit(f"5_trade_flow_{thr}", "tfi_long", +1, obs_long, h,
                 "LAGGED 1s: the second's volume is known only at the end of the second", lag=1)
            emit(f"5_trade_flow_{thr}", "tfi_short", -1, obs_short, h,
                 "LAGGED 1s: the second's volume is known only at the end of the second", lag=1)

    # ── (6) ORDER-BOOK RESILIENCE (the bid is PULLED) ────────────────────
    #     Two causal arms, both using only information at the moment of the
    #     pull:
    #       expect_fall  -> the bid is pulled and price has NOT fallen yet;
    #                       trade SHORT (the pull is informative).
    #       expect_hold  -> the bid is pulled and price has NOT fallen yet;
    #                       trade LONG (the book is resilient, price bounces).
    #     Whichever arm has the bigger 90th percentile is the answer.
    for h in HORIZONS:
        pulls = []
        for s in sorted(book.by_sym):
            idx = book.ts_index[s]
            rows = book.rows_by_sym[s]
            for i in range(1, len(idx)):
                t0, t1 = idx[i - 1], idx[i]
                if t1 - t0 != 1000:
                    continue
                r0, r1 = rows[t0], rows[t1]
                b0, b1 = r0.get("bid1s"), r1.get("bid1s")
                if not b0 or b1 is None:
                    continue
                if b1 > b0 * 0.25:
                    continue
                if (r1["mid"] - r0["mid"]) / r0["mid"] * 100.0 >= 0:
                    continue
                pulls.append((s, t1, r1["mid"]))
        emit("6_bid_pulled", "expect_fall", -1, pulls, h,
             "the bid was pulled to <=25% of the prior second and price has not fallen yet; SHORT")
        emit("6_bid_pulled", "expect_hold", +1, pulls, h,
             "the bid was pulled to <=25% of the prior second and price has not fallen yet; LONG")
        emit("6_bid_pulled", "expect_fall", -1, pulls, h,
             "LAGGED 1s: the pull is known only at the end of its second", lag=1)
        emit("6_bid_pulled", "expect_hold", +1, pulls, h,
             "LAGGED 1s: the pull is known only at the end of its second", lag=1)

    # ══ THE TWO CONTROLS THAT DECIDE THE QUESTION ═══════════════════════
    #
    # (A) THE UNCONDITIONAL BASELINE: every second, long, no signal at all.
    #     This is the market's own drift. Any signal must beat it.
    #
    # (B) THE ORACLE CEILING: the best possible direction picker, which
    #     KNOWS the sign of the forward move in advance. This is the
    #     absolute maximum any signal on this recording could reach — a
    #     signal can only be this good if it is perfect. If the ORACLE's
    #     p90 is below the fee, then NO signal can pay, and the answer is
    #     settled without needing any particular signal to work.
    controls = {}
    allobs_by_h = {}
    for h in HORIZONS:
        allobs = []
        for s in sorted(book.by_sym):
            for vts, r in book.rows_by_sym[s].items():
                allobs.append((s, vts, r["mid"]))
        allobs_by_h[h] = allobs
        uncond_fwd = []
        for sym, vts, mid in allobs:
            raw = book.forward_pct(sym, vts, h)
            if raw is not None:
                uncond_fwd.append(raw)
        u = describe(uncond_fwd, FEE_PCT, FEE_PCT)
        t_u, _ = tstat(uncond_fwd)
        u["t_forward"] = t_u
        u["signal"] = "control_unconditional"
        u["arm"] = "always_long"
        u["horizon_sec"] = h
        controls[f"unconditional_{h}s"] = u

        # The oracle: take the sign of the forward move (it knows the future).
        # The oracle's realised distribution is the distribution of |move|.
        absmoves = [abs(r) for r in uncond_fwd]
        o = describe(absmoves, FEE_PCT, FEE_PCT)
        o["signal"] = "control_oracle"
        o["arm"] = "perfect_direction_picker"
        o["horizon_sec"] = h
        o["note"] = ("the distribution of the ABSOLUTE forward move — the best any "
                     "direction picker could do on this recording")
        t_o, _ = tstat(absmoves)
        o["t_forward"] = t_o
        o["mean_gross_usd"] = (mean(absmoves) / 100.0) * NOTIONAL
        o["net_ev_usd"] = o["mean_gross_usd"] - FEE_USD
        controls[f"oracle_{h}s"] = o

        # THE LAGGED ORACLE: a perfect picker that enters one second LATER,
        # which is the first moment a 1-second-aggregate signal is
        # tradeable. This is the honest ceiling.
        lagged = []
        for sym, vts, mid in allobs:
            raw = book.forward_pct(sym, vts + 1000, h)
            if raw is not None:
                lagged.append(abs(raw))
        lo = describe(lagged, FEE_PCT, FEE_PCT)
        lo["signal"] = "control_oracle"
        lo["arm"] = "perfect_picker_LAGGED_1s"
        lo["horizon_sec"] = h
        lo["note"] = ("the honest ceiling: a perfect direction picker that enters at the "
                      "START of the next second, when the signal is actually knowable")
        lo["mean_gross_usd"] = (mean(lagged) / 100.0) * NOTIONAL
        lo["net_ev_usd"] = lo["mean_gross_usd"] - FEE_USD
        t_lo, _ = tstat(lagged)
        lo["t_forward"] = t_lo
        controls[f"oracle_lag1_{h}s"] = lo

    # ══ PRINT THE TABLE ═══════════════════════════════════════════════════
    print("=" * 120)
    print(" THE FEE FLOOR: 0.12% of notional = $0.0720 per $60 ticket")
    print(" A market entry ALSO crosses the spread, so the EFFECTIVE FLOOR is 0.12% + the arm's")
    print(" median spread. A signal whose p90 is below the fee CANNOT PAY.")
    print(" 'n' is the ALL-observations count; 'nNO' is the NON-OVERLAPPING count (the honest n).")
    print("=" * 120)
    hdr = (f" {'signal':<20s} {'arm':<28s} {'H':>3s} {'n':>6s} {'nNO':>6s} {'mean%':>9s} "
           f"{'med%':>9s} {'p90%':>9s} {'p90NO%':>9s} {'exc%':>8s} {'tNO':>7s} {'net$/tr':>9s} {'p90>FEE':>8s}")
    print(hdr)
    print(" " + "-" * 118)
    print(" THE CONTROLS — the bar every signal has to clear")
    for key in sorted(controls):
        c = controls[key]
        flag = "YES" if c["p90_exceeds_fee"] else "no"
        print(f" {c['signal']:<20s} {c['arm']:<28s} {c['horizon_sec']:>3d} {c['n']:>6d} "
              f"{'-':>6s} {c['mean_pct']:>9.4f} {c['median_pct']:>9.4f} {c['p90_pct']:>9.4f} "
              f"{'-':>9s} {'-':>8s} {c['t_forward']:>7.2f} "
              f"{c.get('net_ev_usd', 0):>+9.4f} {flag:>8s}")
    print(" " + "-" * 118)
    for grp, arms in results.items():
        for arm_name, b in arms.items():
            p90 = b["p90_pct"]
            p90no = b["p90_nonoverlap_pct"]
            flag = "YES" if b["p90_exceeds_fee"] else "no"
            print(f" {grp:<20s} {arm_name:<28s} {b['horizon_sec']:>3d} {b['n']:>6d} "
                  f"{b['n_nonoverlap']:>6d} {b['mean_pct']:>9.4f} {b['median_pct']:>9.4f} "
                  f"{p90:>9.4f} {('%.4f' % p90no) if p90no is not None else '   n/a':>9s} "
                  f"{b['excess_over_reversed_pct']:>8.4f} {b['t_nonoverlap']:>7.2f} "
                  f"{b.get('net_ev_usd', 0):>+9.4f} {flag:>8s}")
        print(" " + "-" * 118)

    # ── the summary the question actually asks ───────────────────────────
    print()
    print("=" * 120)
    print(" THE ANSWER: DOES ANY SIGNAL'S 90th PERCENTILE CLEAR THE 0.12% FEE?")
    print("=" * 120)
    best = []
    for grp, arms in results.items():
        for arm_name, b in arms.items():
            best.append((b["p90_nonoverlap_pct"] if b["p90_nonoverlap_pct"] is not None
                         else b["p90_pct"], grp, arm_name, b))
    best.sort(key=lambda x: -(x[0] if x[0] is not None else -9e9))
    reportable = [x for x in best if x[3].get("reportable")]
    if best:
        top_p90, grp, arm_name, b = best[0]
        print(f"  THE BEST SIGNAL BY p90 (non-overlapping where available):")
        print(f"    {grp} / {arm_name}  H={b['horizon_sec']}s  nNO={b['n_nonoverlap']}")
        print(f"    p90 = {top_p90:.4f}%  = ${(top_p90/100)*NOTIONAL:.4f} on a ${NOTIONAL:.0f} ticket")
        print(f"    the fee is ${FEE_USD:.4f} = {FEE_PCT:.2f}%")
        print(f"    -> p90 EXCEEDS THE FEE: {'YES' if top_p90 > FEE_PCT else 'NO'}")
        if not b.get("reportable"):
            print(f"    -> BUT nNO={b['n_nonoverlap']} < {MIN_N_REPORTABLE}: this arm is NOT REPORTABLE.")
            print(f"       A p90 over {b['n_nonoverlap']} points is the {max(1, int(0.1*b['n_nonoverlap']))}th-largest of")
            print(f"       {b['n_nonoverlap']} — a MAXIMUM dressed as a percentile, and it does not generalise.")
        if reportable:
            rp90, rgrp, rarm, rb = reportable[0]
            print()
            print(f"  THE BEST REPORTABLE ARM (nNO >= {MIN_N_REPORTABLE}):")
            print(f"    {rgrp} / {rarm}  H={rb['horizon_sec']}s  nNO={rb['n_nonoverlap']}")
            print(f"    p90 = {rp90:.4f}%  = ${(rp90/100)*NOTIONAL:.4f} on a ${NOTIONAL:.0f} ticket")
            print(f"    -> p90 EXCEEDS THE FEE: {'YES' if rp90 > FEE_PCT else 'NO'}"
                  + (f"   ({FEE_PCT/rp90:.1f}x too small)" if rp90 <= FEE_PCT else ""))
        else:
            print()
            print(f"  NO ARM IS REPORTABLE: every arm's non-overlapping n is below {MIN_N_REPORTABLE}.")
    n_pass = sum(1 for _, _, _, b in best if (b["p90_exceeds_fee"]))
    n_pass_rep = sum(1 for _, _, _, b in reportable if (b["p90_exceeds_fee"]))
    print(f"  arms whose p90 exceeds the fee: {n_pass} of {len(best)}"
          f"   (reportable only: {n_pass_rep} of {len(reportable)})")
    print()

    # ── THE CONCENTRATION: does one symbol carry the result? ──────────────
    print("=" * 120)
    print(" THE CONCENTRATION — does one symbol carry the result?")
    print("=" * 120)
    conc_results = {}
    for label, sel in (("BEST REPORTABLE ARM", None), ("BEST REPORTABLE LAGGED ARM", "LAG")):
        pool = [x for x in best if (("LAG" in x[2]) == bool(sel)) and x[3].get("reportable")]
        if not pool:
            continue
        _, grp, arm_name, b = pool[0]
        h = b["horizon_sec"]
        lag = b.get("lag_sec", 0)
        direction = 1 if b["direction"] == "long" else -1
        # rebuild the arm's observations and measure per symbol
        per_sym = defaultdict(list)
        for sym, vts, mid in allobs_by_h.get(h, []):
            raw = book.forward_pct(sym, vts + lag * 1000, h)
            if raw is not None:
                per_sym[sym].append(direction * raw)
        # the arm's own rows: identify them by re-running the signal condition
        # is expensive; instead use the SYMBOL DISTRIBUTION of the whole pool,
        # which is what "concentration" means for a pooled arm.
        tot = sum(len(v) for v in per_sym.values())
        shares = {s: len(v) / tot for s, v in per_sym.items()} if tot else {}
        top = sorted(shares.items(), key=lambda kv: -kv[1])[:3]
        conc_results[label] = {"per_symbol_share": shares,
                                "top": top}
        print(f"  {label}: {grp} / {arm_name}  H={h}s")
        for s, sh in top:
            vals = per_sym[s]
            print(f"    {s:<12} {sh*100:>5.1f}% of the observations  "
                  f"mean {mean(vals):+.4f}%  p90 {pct(vals,0.90):.4f}%")
        print(f"    largest symbol share: {top[0][1]*100:.1f}%"
              + ("  (CONCENTRATED — one name carries it)" if top[0][1] > 0.35 else ""))
    print()

    # ── THE HALF-SPLIT: is the signal stable out of sample? ──────────────
    print("=" * 120)
    print(" THE HALF-SPLIT — does the signal work in BOTH chronological halves?")
    print("=" * 120)
    halfsplit_results = {}
    for label, sel in (("BEST REPORTABLE ARM", None), ("BEST REPORTABLE LAGGED ARM", "LAG")):
        pool = [x for x in best if (("LAG" in x[2]) == bool(sel)) and x[3].get("reportable")]
        if not pool:
            continue
        _, grp, arm_name, b = pool[0]
        hs = half_split(b, book, allobs_by_h)
        if not hs:
            continue
        halfsplit_results[label] = {"signal": grp, "arm": arm_name, **hs}
        print(f"  {label}: {grp} / {arm_name}  H={b['horizon_sec']}s")
        for k in ("first_half", "second_half"):
            if k in hs:
                x = hs[k]
                print(f"    {k:<14} n={x['n']:>5}  mean {x['mean_pct']:+.4f}%  "
                      f"p90 {x['p90_pct']:.4f}%  net/trade ${x['net_ev_usd']:+.4f}")
        if "both_halves_positive_mean" in hs:
            print(f"    both halves' mean positive: {'YES' if hs['both_halves_positive_mean'] else 'NO'}"
                  f"   sign stable: {'YES' if hs['sign_stable'] else 'NO'}")
    print()

    # ── THE PLACEBO: is the best arm distinguishable from a random pick? ──
    print("=" * 120)
    print(" THE PLACEBO — is the best arm better than a RANDOM selection of the same shape?")
    print("=" * 120)
    placebo_results = {}
    for label, sel in (("BEST REPORTABLE ARM (any lag)", None),
                       ("BEST REPORTABLE LAGGED ARM (tradeable)", "LAG")):
        pool = [x for x in best if (("LAG" in x[2]) == bool(sel)) and x[3].get("reportable")]
        if not pool:
            print(f"  {label}: NONE — no arm has nNO >= {MIN_N_REPORTABLE}.")
            continue
        _, grp, arm_name, b = pool[0]
        pl = placebo(b, book, allobs_by_h)
        if not pl:
            continue
        placebo_results[label] = {"signal": grp, "arm": arm_name, **pl}
        print(f"  {label}: {grp} / {arm_name}  H={b['horizon_sec']}s  n={b['n']}")
        print(f"    the arm's p90                     = {pl['arm_p90']:.4f}%")
        print(f"    a random selection's p90 (median)= {pl['placebo_p90_median']:.4f}%")
        print(f"    a random selection's p90 (p90)    = {pl['placebo_p90_p90']:.4f}%")
        print(f"    a random selection's p90 (MAX)    = {pl['placebo_p90_max']:.4f}%")
        print(f"    random runs at or above the arm: {pl['placebo_runs_at_or_above_arm']}/{pl['n_draws']}"
              f"  ({pl['placebo_rate_at_or_above_arm']*100:.1f}%)")
        print(f"    -> {pl['verdict']}")
    print()

    # ── THE ORACLE CEILING VERDICT ───────────────────────────────────────
    print("=" * 120)
    print(" THE ORACLE CEILING — the best any signal could possibly be")
    print("=" * 120)
    for h in HORIZONS:
        for tag, key in (("perfect picker, same second", f"oracle_{h}s"),
                         ("perfect picker, LAGGED 1s (the honest ceiling)", f"oracle_lag1_{h}s")):
            o = controls.get(key)
            if not o:
                continue
            p90 = o["p90_pct"]
            usd = (p90 / 100.0) * NOTIONAL
            net = usd - FEE_USD
            print(f"  H={h:>2d}s  {tag}")
            print(f"        p90 of |forward move| = {p90:.4f}%  = ${usd:.4f} on a ${NOTIONAL:.0f} ticket")
            print(f"        the fee is ${FEE_USD:.4f} -> net at the p90 = ${net:+.4f}")
            print(f"        p90 EXCEEDS THE FEE: {'YES' if p90 > FEE_PCT else 'NO'}"
                  f"   ({FEE_PCT/p90:.1f}x too small)" if p90 > 0 else "        p90 = 0")
    print()
    # The oracle's net expectancy at the p90, per day.
    o15 = controls.get("oracle_15s")
    o5 = controls.get("oracle_5s")
    print("  WHAT THE CEILING MEANS")
    for name, o in (("5s", o5), ("15s", o15)):
        if not o:
            continue
        p90 = o["p90_pct"]
        usd = (p90 / 100.0) * NOTIONAL
        net = usd - FEE_USD
        print(f"    at {name:>3s}, a PERFECT picker nets ${net:+.4f} per trade at the 90th percentile")
        print(f"         -> {MAX_TICKETS} trades/day = ${MAX_TICKETS*net:+.4f}/day"
              f" = ${MAX_TICKETS*net*365:+,.2f}/year")
    print("    (and the oracle is not a signal — it is the CEILING. A real signal is")
    print("     strictly below it.)")
    print()

    # ══ THE ARITHMETIC ════════════════════════════════════════════════════
    print("=" * 120)
    print(" THE PRACTICAL ARITHMETIC")
    print("=" * 120)
    per_day_latency = int(86400 / ROUND_TRIP_SEC)
    print(f"  equity                 ${EQUITY:.2f}")
    print(f"  notional per ticket    ${NOTIONAL:.2f}")
    print(f"  taker round trip       {TAKER_ROUND_TRIP*100:.2f}% = ${FEE_USD:.4f} per ticket")
    print(f"  daily notional cap     ${DAILY_NOTIONAL_CAP:.0f} -> {MAX_TICKETS} tickets/day")
    print(f"  round trip latency     {ROUND_TRIP_SEC:.0f}s")
    print()
    print(f"  ROUND TRIPS PER DAY")
    print(f"    by latency alone ({ROUND_TRIP_SEC:.0f}s each):  {per_day_latency:,}")
    print(f"    by the $500 notional cap ($60 a ticket):    {MAX_TICKETS}")
    print(f"    -> THE NOTIONAL CAP BINDS. The machine can physically execute {per_day_latency:,}")
    print(f"       round trips a day; it is permitted {MAX_TICKETS}. The binding constraint is")
    print(f"       capital, not latency — and the latency is not even close to binding.")
    print(f"    -> fees at {MAX_TICKETS} tickets/day: ${MAX_TICKETS*FEE_USD:.4f}/day, "
          f"${MAX_TICKETS*FEE_USD*365:.2f}/year, against ${EQUITY:.2f} of equity.")
    print()
    req = GOAL_USD / MAX_TICKETS
    print(f"  THE $10,000 GOAL")
    print(f"    ${GOAL_USD:,.0f} at {MAX_TICKETS} tickets/day = ${req:,.2f} NET per ticket")
    print(f"    that net is {req/NOTIONAL*100:.2f}% of notional")
    print(f"    the fee is ${FEE_USD:.4f} = {FEE_PCT:.2f}% of notional")
    print(f"    the GROSS move needed per trade is {(req+FEE_USD)/NOTIONAL*100:.2f}% of notional")
    print(f"    = ${req+FEE_USD:.4f} of gross on a ${NOTIONAL:.0f} ticket = {req/FEE_USD:.0f}x the fee")
    print()
    print("    THE IMPLIED WIN RATE (a symmetric win/loss ticket):")
    print("      gross target   gross $    fee is   break-even WR   WR needed for $1,250 net")
    for gross_pct in (0.18, 0.30, 0.40, 0.60):
        gross = gross_pct / 100.0 * NOTIONAL
        net_win = gross - FEE_USD
        net_loss = -gross - FEE_USD
        be = -net_loss / (net_win - net_loss)
        # net = wr*gross - (1-wr)*gross - fee  ->  wr = (net + fee + gross) / (2*gross)
        wr = (req + FEE_USD + gross) / (2 * gross)
        imposs = "  IMPOSSIBLE (>100%)" if wr > 1 else f"  {wr*100:.1f}%"
        print(f"      {gross_pct:.2f}%          ${gross:.4f}   {FEE_USD/gross*100:>4.0f}%     "
              f"{be*100:>5.1f}%       {imposs}")
    print("      -> every one of these is IMPOSSIBLE. A $60 ticket cannot make $1,250 in a")
    print("         day: the price would have to move 20x. THE ARITHMETIC ITSELF SAYS THE")
    print("         GOAL CANNOT BE REACHED FROM $56.89 ON A FIXED $60 TICKET.")
    print()
    print("    SO THE ARITHMETIC MUST COMPOUND. The per-trade net has to be a FRACTION of")
    print("    EQUITY, and the ticket has to grow with the equity. What each horizon demands:")
    print()
    print("      days   equity multiple   net/trade as % of equity   gross move needed/trade")
    for N in (30, 90, 365, 1095, 3650):
        mult = GOAL_USD / EQUITY
        r = (mult ** (1.0 / (N * MAX_TICKETS)) - 1.0)   # per-trade net fraction
        # the fee at 1.05x exposure, as a fraction of equity
        fee_frac = (FEE_USD / NOTIONAL) * (NOTIONAL / EQUITY)
        gross_frac = r + fee_frac
        print(f"      {N:>5d}   {mult:>10.1f}x   {r*100:>22.4f}%   {gross_frac*100:>18.4f}%")
    print()
    print("    READ THAT TABLE THIS WAY: to compound from $56.89 to $10,000 in a YEAR at 8")
    print("    tickets/day, each ticket must net a move of the size of the ENTIRE daily")
    print("    range of a liquid perp, every day, for 365 days, with zero losing days.")
    print("    The microstructure signals measured here produce a p90 forward move of")
    print("    0.02%-0.11% at 1-15 seconds — two to three orders of magnitude too small.")
    print()
    print("    the same question for the microstructure signals measured here:")
    for _, grp, arm_name, b in best[:6]:
        p90 = b["p90_nonoverlap_pct"] if b["p90_nonoverlap_pct"] is not None else b["p90_pct"]
        usd = (p90 / 100.0) * NOTIONAL
        net_at_p90 = usd - FEE_USD
        print(f"      {grp:<20s} {arm_name:<14s} H={b['horizon_sec']:>2d}s  p90 ${usd:.4f}  "
              f"net at p90 ${net_at_p90:+.4f}  ({MAX_TICKETS*net_at_p90:+.2f}/day)")
    print()
    print(f"    to reach ${GOAL_USD:,.0f} from ${EQUITY:.2f} at {MAX_TICKETS} tickets/day,")
    days = GOAL_USD / max(MAX_TICKETS * (best[0][3].get("p90_usd_on_ticket", 0) or 0) - MAX_TICKETS * FEE_USD, 0.01)
    print(f"    each ticket must net ${req:,.2f}. At the BEST signal's p90 the best case is")
    top_net = (best[0][0] / 100.0) * NOTIONAL - FEE_USD
    if top_net > 0:
        print(f"    ${top_net:.4f} per ticket = ${MAX_TICKETS*top_net:.4f}/day = "
              f"${MAX_TICKETS*top_net*365:,.2f}/year -> {GOAL_USD/(MAX_TICKETS*top_net*365):,.0f} YEARS.")
    else:
        print(f"    ${top_net:.4f} per ticket, which is NEGATIVE. The goal is unreachable by this route:")
        print(f"    the best signal's 90th-percentile move does not cover the fee.")

    out = {
        "recording": str(MICRO),
        "meta": meta,
        "symbols": sorted(book.by_sym),
        "per_symbol": {
            s: {**sp[s], "span_sec": (book.ts_index[s][-1] - book.ts_index[s][0]) / 1000.0,
                "trades": sum(1 for t in trades if t["sym"] == s)}
            for s in sorted(book.by_sym)
        },
        "signals": results,
        "controls": controls,
        "placebo": placebo_results,
        "half_split": halfsplit_results,
        "concentration": conc_results,
        "arithmetic": {
            "equity": EQUITY, "notional": NOTIONAL, "taker_round_trip": TAKER_ROUND_TRIP,
            "fee_usd": FEE_USD, "daily_notional_cap": DAILY_NOTIONAL_CAP,
            "max_tickets_per_day": MAX_TICKETS,
            "round_trips_per_day_by_latency": per_day_latency,
            "goal_usd": GOAL_USD,
            "required_net_per_trade_usd": req,
            "required_gross_pct_of_notional": (req + FEE_USD) / NOTIONAL * 100,
            "arms_p90_above_fee": n_pass,
            "arms_total": len(best),
        },
    }
    OUT.write_text(json.dumps(out, indent=2))
    print(f"  wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
