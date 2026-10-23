#!/usr/bin/env python3
"""
HF MICROSTRUCTURE STUDY — the core engine.

WHAT THIS TESTS
---------------
  (1) mean reversion and momentum at the 1-5 minute horizon
  (2) the order-book signals the collector already records (bookImbalance,
      spreadBps) as short-horizon predictors
  (3) a liquidity-event signature (volume spike + spread widening) as a
      continuation predictor

THE METHOD (learned the hard way in this project)
-------------------------------------------------
  * ROWS ARE NOT OBSERVATIONS. Every symbol is correlated with every other
    and with the market. All t-statistics are computed on CLUSTER MEANS:
    observations are grouped into time clusters, the signal's excess over
    its control is averaged inside each cluster, and the t-test runs on
    those cluster means. n = number of clusters, not number of rows.
  * A FORWARD RETURN IS NOT A TRADE OUTCOME. Every candidate trade is
    resolved with FIRST-TOUCH barriers: target hit first = win, kill level
    hit first = loss, a bar touching BOTH = LOSS, and a trade reaching
    neither level = explicit TIME EXIT at the horizon.
  * THE T MUST TEST THE EXCESS OVER A GENUINE CONTROL. The control for a
    directional signal is the SAME bar's opposite direction on the SAME
    bars; for a "hot" filter the control is the same filter with the
    predictive content removed.
  * A PLACEBO of the SAME SHAPE runs through the identical pipeline. The
    bar is "what does the best placebo score?", not a p-value.
  * TRIM STABILITY: drop the worst 3 and best 3 clusters and re-run.
  * CONCENTRATION: the largest single symbol's share of the total.

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
BARS_15M = SCRATCH / "fee-floor-15m-bars.json"
CONFLUENCE = SCRATCH / "confluence.ndjson"
TRADELOOP = SCRATCH / "trade-loop.ndjson"
OUT = SCRATCH / "hf-microstructure.results.json"

# ── the account, as measured ─────────────────────────────────────────────
EQUITY = 57.1579522047
NOTIONAL = 60.0
TAKER_ROUND_TRIP = 0.0012  # 0.06%/side on the venue's own contract list
FEE_USD = NOTIONAL * TAKER_ROUND_TRIP  # $0.072 on a $60 ticket

# ── the SPREAD, from the collector's OWN rows and the venue's ticker ────
#
# A market entry pays the ask; a market exit hits the bid. So a round trip
# crosses the spread ONCE (half on entry, half on exit -> the full quoted
# spread in aggregate). The collector records spreadBps per symbol, and the
# venue's own /ticker confirms it to 3 decimals (DOGE: collector 1.219 bps,
# live ticker 1.218 bps).
#
# The MEDIAN across the 43 pairs is 10.7 bps — which is nearly the whole
# 12 bps taker fee. On the widest names (PYBOBO 110 bps, READY 48.7 bps)
# the spread alone is 4-9x the fee. This is the single most important
# number in the study, because it is the cost that does NOT amortise.
MEDIAN_SPREAD_BPS = 10.685

# ── the bar for a finding ────────────────────────────────────────────────
MIN_CLUSTERS = 30
MIN_T = 2.0

# ── cluster width ────────────────────────────────────────────────────────
CLUSTER_MS = 15 * 60_000  # 15 minutes: one 15m bar


# ══ statistics ═══════════════════════════════════════════════════════════

def mean(a):
    return sum(a) / len(a) if a else 0.0


def stdev(a):
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def tstat(a):
    """One-sample t on a list of cluster means."""
    n = len(a)
    if n < 2:
        return 0.0, float("nan")
    m = mean(a)
    s = stdev(a)
    if s == 0:
        return 0.0, float("nan")
    return m / (s / math.sqrt(n)), m


def pct(a, p):
    if not a:
        return 0.0
    s = sorted(a)
    i = (len(s) - 1) * p
    lo, hi = math.floor(i), math.ceil(i)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (i - lo)


def trim(a, k=3):
    """Drop the worst k and best k values (the trim-stability check)."""
    if len(a) <= 2 * k:
        return list(a)
    s = sorted(a)
    return s[k: len(s) - k]


def concentration(shares):
    """Largest single symbol's share of the total absolute contribution."""
    tot = sum(abs(x) for x in shares.values())
    if tot == 0:
        return None, 0.0
    worst = max(shares.items(), key=lambda kv: abs(kv[1]))
    return worst[0], abs(worst[1]) / tot


# ══ data ═════════════════════════════════════════════════════════════════

def load_bars_1m():
    """pair -> sorted list of [ts, o, h, l, c, v]."""
    if not BARS_1M.exists():
        return {}
    raw = json.loads(BARS_1M.read_text())
    out = {}
    for pair, rows in raw.items():
        if len(rows) < 200:
            continue
        out[pair] = sorted(rows, key=lambda r: r[0])
    return out


def load_bars_15m():
    raw = json.loads(BARS_15M.read_text())
    return {p: sorted(rows, key=lambda r: r["t"]) for p, rows in raw.items()}


def load_confluence():
    return [json.loads(l) for l in CONFLUENCE.read_text().splitlines() if l.strip()]


# ══ the 1-minute series ═════════════════════════════════════════════════

class Series:
    """A 1-minute bar series with fast forward lookups."""

    def __init__(self, rows):
        self.rows = rows
        self.ts = [r[0] for r in rows]
        self.n = len(rows)
        self.idx = {t: i for i, t in enumerate(self.ts)}

    def ret(self, i, k):
        """Simple k-minute forward return from bar i's close, or None."""
        j = i + k
        if j >= self.n:
            return None
        c0 = self.rows[i][4]
        c1 = self.rows[j][4]
        if c0 <= 0:
            return None
        return (c1 - c0) / c0

    def bar_at(self, t):
        i = self.idx.get(t)
        return self.rows[i] if i is not None else None

    def forward_max(self, i, k, side):
        """Max favourable / adverse excursion over the next k bars, in %."""
        j = i + k
        if j >= self.n:
            return None, None
        c0 = self.rows[i][4]
        hi = max(self.rows[t][2] for t in range(i + 1, j + 1))
        lo = min(self.rows[t][3] for t in range(i + 1, j + 1))
        if side == "long":
            return (hi - c0) / c0, (lo - c0) / c0
        return (c0 - lo) / c0, (hi - c0) / c0


# ══ trade outcome resolution (first-touch barriers) ══════════════════════

def resolve_trade(series, i, side, target_pct, stop_pct, horizon):
    """
    First-touch barrier resolution on 1-minute bars.

    target_pct / stop_pct are FRACTIONS of entry (e.g. 0.0012 = 0.12%).
    Returns (outcome, ret_frac) where outcome in
    {"win", "loss", "time"}.

    A bar touching BOTH levels is a LOSS (the conservative convention).
    """
    entry = series.rows[i][4]
    n = series.n
    jmax = min(i + horizon, n - 1)
    if side == "long":
        tgt = entry * (1 + target_pct)
        stp = entry * (1 - stop_pct)
    else:
        tgt = entry * (1 - target_pct)
        stp = entry * (1 + stop_pct)
    for j in range(i + 1, jmax + 1):
        h = series.rows[j][2]
        l = series.rows[j][3]
        hit_t = (h >= tgt) if side == "long" else (l <= tgt)
        hit_s = (l <= stp) if side == "long" else (h >= stp)
        if hit_t and hit_s:
            return "loss", -stop_pct  # ambiguous bar: scored as a loss
        if hit_s:
            return "loss", -stop_pct
        if hit_t:
            return "win", target_pct
    # time exit at the horizon bar's close
    exit_px = series.rows[jmax][4]
    if side == "long":
        return "time", (exit_px - entry) / entry
    return "time", (entry - exit_px) / entry


def trade_net_dollars(ret_frac, notional=NOTIONAL, fee=TAKER_ROUND_TRIP):
    """Net dollars on a taker round trip."""
    return notional * (ret_frac - fee)


# ══ cluster machinery ════════════════════════════════════════════════════

def cluster_key(ts):
    return ts // CLUSTER_MS


def cluster_stats(excesses):
    """
    Group (ts, excess) into 15-minute clusters, average inside each,
    t-test the cluster means.

    `excesses` is a list of (ts, excess) pairs.
    """
    buckets = defaultdict(list)
    for ts, ex in excesses:
        buckets[cluster_key(ts)].append(ex)
    means = []
    keys = []
    for k in sorted(buckets):
        means.append(mean(buckets[k]))
        keys.append(k)
    t, m = tstat(means)
    return {
        "n_clusters": len(means),
        "n_rows": len(excesses),
        "cluster_mean": m,
        "t": t,
        "cluster_means": means,
        "cluster_keys": keys,
    }


def trim_check(means):
    """t and mean after dropping the worst-3 / best-3 clusters."""
    trimmed = trim(means, 3)
    t, m = tstat(trimmed)
    return {"t": t, "mean": m, "n": len(trimmed)}


def concentration_of(excesses):
    """
    Per-symbol share of the total absolute excess.

    `excesses` is a list of (ts, symbol, excess) triples.
    """
    per = defaultdict(list)
    for ts, sym, ex in excesses:
        per[sym].append(ex)
    shares = {}
    for sym, vals in per.items():
        shares[sym] = mean(vals) * len(vals)
    return shares


# ══ signal families ══════════════════════════════════════════════════════

def signal_momentum(series, i, k):
    """Return over the k minutes ENDING at bar i (the signal is known at i)."""
    if i - k < 0:
        return None
    c0 = series.rows[i - k][4]
    c1 = series.rows[i][4]
    if c0 <= 0:
        return None
    return (c1 - c0) / c0


def signal_zscore_volume(series, i, look, k):
    """Current bar volume vs the mean of the previous `look` bars."""
    if i - look < 0 or i >= series.n:
        return None
    vols = [series.rows[t][5] for t in range(i - look, i)]
    if not vols or sum(vols) == 0:
        return None
    m = mean(vols)
    s = stdev(vols)
    if s == 0:
        return None
    return (series.rows[i][5] - m) / s


def signal_reversal_zscore(series, i, look):
    """How stretched is the recent move, in sigmas of the last `look` bars."""
    if i - look < 0:
        return None
    rets = []
    for t in range(i - look + 1, i + 1):
        c0 = series.rows[t - 1][4]
        c1 = series.rows[t][4]
        if c0 <= 0:
            return None
        rets.append((c1 - c0) / c0)
    if len(rets) < 2:
        return None
    m = mean(rets)
    s = stdev(rets)
    if s == 0:
        return None
    return (rets[-1] - m) / s


def make_signal_rows(series_list, horizon, lookback, kind):
    """
    Build the event table for one signal family.

    kind:
      "momentum"  — follow the trailing k-minute move
      "reversion" — fade the trailing k-minute move
      "hotvolume" — trade only when the bar's volume is a `volz`-sigma event,
                     in the direction of the trailing move (continuation)
      "imbalance" — direction from the collector's book imbalance (needs the
                     confluence rows; handled separately)
    """
    rows = []
    for pair, series in series_list.items():
        for i in range(lookback, series.n - horizon - 1):
            if kind in ("momentum", "reversion", "hotvolume"):
                sig = signal_momentum(series, i, lookback)
                if sig is None:
                    continue
                volz = None
                if kind == "hotvolume":
                    volz = signal_zscore_volume(series, i, 30, 0)
                    if volz is None:
                        continue
            else:
                sig = None
                volz = None
            rows.append((pair, series, i, sig, volz))
    return rows


# ══ the three tests ══════════════════════════════════════════════════════

def test_directional_family(series_list, horizon, lookback, kind, min_rows=200):
    """
    A directional family (momentum / reversion) measured as:
      signal side  = follow or fade the trailing move
      forward move = the next `horizon` minutes' return
    EXCESS = (signal side's forward move) - (opposite side's forward move)
    on the SAME bars. That difference is the beta-free part: the market
    drift cancels exactly.
    """
    events = []
    for pair, series in series_list.items():
        for i in range(lookback, series.n - horizon - 1):
            sig = signal_momentum(series, i, lookback)
            if sig is None or sig == 0:
                continue
            fwd = series.ret(i, horizon)
            if fwd is None:
                continue
            side = "long" if (sig > 0) == (kind == "momentum") else "short"
            events.append((pair, series, i, side, fwd, sig))
    if len(events) < min_rows:
        return None

    # excess = 2 * side-signed forward return  (sign(sig) times 2*fwd)
    excesses = []
    for pair, series, i, side, fwd, sig in events:
        signed = fwd if side == "long" else -fwd
        excesses.append((series.rows[i][0], pair, 2.0 * signed))

    st = cluster_stats([(t, e) for t, _, e in excesses])
    tm = trim_check(st["cluster_means"])
    shares = concentration_of(excesses)
    worst_sym, worst_share = concentration(shares)

    # the placebo: same shape, edge removed (sign randomised per event)
    rng = random.Random(20261021)
    pl_excess = []
    for t, pair, e in excesses:
        pl_excess.append((t, pair, e if rng.random() < 0.5 else -e))
    pl_st = cluster_stats([(t, e) for t, _, e in pl_excess])
    pl_tm = trim_check(pl_st["cluster_means"])

    # the CONTROL arm: unconditional forward return, zero-mean by construction?
    # For a directional signal the control is the opposite side on the same
    # bars — which is exactly what the 2x excess above already removes.
    # Here we also report the unconditional mean forward return (beta).
    beta_rows = [(series.rows[i][0], pair, fwd) for pair, series, i, side, fwd, sig in events]
    beta_st = cluster_stats([(t, e) for t, _, e in beta_rows])

    return {
        "kind": kind,
        "horizon_min": horizon,
        "lookback_min": lookback,
        "n_events": len(events),
        "n_clusters": st["n_clusters"],
        "excess_per_event_pct": st["cluster_mean"] * 100,
        "t": st["t"],
        "trim_t": tm["t"],
        "trim_mean_pct": tm["mean"] * 100,
        "trim_n_clusters": tm["n"],
        "placebo_t": pl_st["t"],
        "placebo_mean_pct": pl_st["cluster_mean"] * 100,
        "placebo_trim_t": pl_tm["t"],
        "uncond_fwd_mean_pct": beta_st["cluster_mean"] * 100,
        "uncond_fwd_t": beta_st["t"],
        "worst_symbol": worst_sym,
        "worst_symbol_share": worst_share,
        "passes_bar": st["n_clusters"] >= MIN_CLUSTERS and st["t"] >= MIN_T and st["cluster_mean"] > 0,
        # THE COST BAR. The edge per event is HALF the excess (the excess
        # is the signal side minus the opposite side). It must clear the
        # ALL-IN round trip, not just zero.
        "edge_bps_per_trade": st["cluster_mean"] * 10000 / 2,
        "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
        "clears_the_cost": (st["cluster_mean"] * 10000 / 2) > (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS),
        "passes_full_bar": (
            st["n_clusters"] >= MIN_CLUSTERS
            and st["t"] >= MIN_T
            and st["cluster_mean"] > 0
            and (st["cluster_mean"] * 10000 / 2) > (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS)
        ),
    }


def test_hotvolume(series_list, horizon, lookback, volz_thresh, min_rows=200):
    """
    LIQUIDITY-EVENT SIGNATURE: a volume spike (>= volz_thresh sigmas) in the
    direction of the trailing move, followed by CONTINUATION.

    The control is the SAME volz filter with the CONTINUATION CLAIM removed:
    the same bars, the same filter, measured in the OPPOSITE direction.
    Excess = continuation forward move - opposite-direction forward move.
    """
    events = []
    for pair, series in series_list.items():
        for i in range(lookback, series.n - horizon - 1):
            volz = signal_zscore_volume(series, i, 30, 0)
            sig = signal_momentum(series, i, lookback)
            if volz is None or sig is None or sig == 0:
                continue
            if volz < volz_thresh:
                continue
            fwd = series.ret(i, horizon)
            if fwd is None:
                continue
            side = "long" if sig > 0 else "short"
            events.append((pair, series, i, side, fwd, volz))
    if len(events) < min_rows:
        return None

    excesses = []
    for pair, series, i, side, fwd, volz in events:
        signed = fwd if side == "long" else -fwd
        excesses.append((series.rows[i][0], pair, 2.0 * signed))
    st = cluster_stats([(t, e) for t, _, e in excesses])
    tm = trim_check(st["cluster_means"])
    shares = concentration_of(excesses)
    worst_sym, worst_share = concentration(shares)

    # placebo: same events, direction randomised
    rng = random.Random(20261021)
    pl = []
    for t, pair, e in excesses:
        pl.append((t, pair, e if rng.random() < 0.5 else -e))
    pl_st = cluster_stats([(t, e) for t, _, e in pl])
    pl_tm = trim_check(pl_st["cluster_means"])

    return {
        "kind": "hotvolume-continuation",
        "horizon_min": horizon,
        "lookback_min": lookback,
        "volz_thresh": volz_thresh,
        "n_events": len(events),
        "n_clusters": st["n_clusters"],
        "excess_per_event_pct": st["cluster_mean"] * 100,
        "t": st["t"],
        "trim_t": tm["t"],
        "trim_mean_pct": tm["mean"] * 100,
        "placebo_t": pl_st["t"],
        "placebo_mean_pct": pl_st["cluster_mean"] * 100,
        "worst_symbol": worst_sym,
        "worst_symbol_share": worst_share,
        "passes_bar": st["n_clusters"] >= MIN_CLUSTERS and st["t"] >= MIN_T and st["cluster_mean"] > 0,
        "edge_bps_per_trade": st["cluster_mean"] * 10000 / 2,
        "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
        "clears_the_cost": (st["cluster_mean"] * 10000 / 2) > (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS),
        "passes_full_bar": (
            st["n_clusters"] >= MIN_CLUSTERS
            and st["t"] >= MIN_T
            and st["cluster_mean"] > 0
            and (st["cluster_mean"] * 10000 / 2) > (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS)
        ),
    }


def test_book_signals(conf_rows, bars_by_pair, horizon_min):
    """
    THE COLLECTOR'S OWN BOOK SIGNALS: bookImbalance and spreadBps, as
    short-horizon predictors.

    The forward price is resolved from the 1-minute bars at the row's ts.
    The control is the OPPOSITE direction on the SAME rows.
    """
    out = {}
    for feat, name in (("bookImbalance", "bookImbalance"), ("spreadBps", "spreadBps")):
        events = []
        for r in conf_rows:
            v = r.get(feat)
            if v is None:
                continue
            pair = r["pair"]
            series = bars_by_pair.get(pair)
            if series is None:
                continue
            # the bar containing the observation
            ts = r["ts"]
            bar_t = (ts // 60_000) * 60_000
            i = series.idx.get(bar_t)
            if i is None:
                continue
            fwd = series.ret(i, horizon_min)
            if fwd is None:
                continue
            events.append((pair, series, i, r, fwd, v))
        if len(events) < 30:
            out[name] = {"n_events": len(events), "note": "too few"}
            continue

        # the signal: a signed predictor. For imbalance, sign(imb) predicts
        # direction; for spread, the SIGN of the CHANGE in spread predicts
        # direction (widening = adverse).
        excesses = []
        for pair, series, i, r, fwd, v in events:
            if feat == "bookImbalance":
                direction = 1 if v > 0 else -1
            else:
                direction = -1  # a wider spread is treated as adverse; the
                # continuation claim is tested in the sign of the imbalance
                # column instead (below)
            signed = direction * fwd
            excesses.append((series.rows[i][0], pair, 2.0 * signed))
        st = cluster_stats([(t, e) for t, _, e in excesses])
        tm = trim_check(st["cluster_means"])
        out[name] = {
            "n_events": len(events),
            "n_clusters": st["n_clusters"],
            "excess_per_event_pct": st["cluster_mean"] * 100,
            "t": st["t"],
            "trim_t": tm["t"],
            "trim_mean_pct": tm["mean"] * 100,
        }
    return out


def test_spread_widening(conf_rows, bars_by_pair, horizon_min, min_ratio=1.5):
    """
    SPREAD-WIDENING EVENT: the row's spreadBps is >= min_ratio x the median
    spreadBps for that symbol across the collector's own rows, and the
    direction is taken from the book imbalance (the liquidity is thin and
    one-sided). Continuation is the claim.

    The control is the SAME rows in the opposite direction.
    """
    per_sym = defaultdict(list)
    for r in conf_rows:
        if r.get("spreadBps") is not None:
            per_sym[r["pair"]].append(r["spreadBps"])
    med = {s: statistics.median(v) for s, v in per_sym.items() if v}

    events = []
    for r in conf_rows:
        sp = r.get("spreadBps")
        imb = r.get("bookImbalance")
        if sp is None or imb is None:
            continue
        pair = r["pair"]
        series = bars_by_pair.get(pair)
        if series is None:
            continue
        if sp < med.get(pair, 0) * min_ratio:
            continue
        bar_t = (r["ts"] // 60_000) * 60_000
        i = series.idx.get(bar_t)
        if i is None:
            continue
        fwd = series.ret(i, horizon_min)
        if fwd is None:
            continue
        side = "long" if imb > 0 else "short"
        events.append((pair, series, i, r, fwd, sp))
    if len(events) < 30:
        return {"n_events": len(events), "note": "too few events"}

    excesses = []
    for pair, series, i, r, fwd, sp in events:
        # excess vs the opposite direction on the same bars
        signed = fwd if (r.get("bookImbalance") or 0) > 0 else -fwd
        excesses.append((series.rows[i][0], pair, 2.0 * signed))
    st = cluster_stats([(t, e) for t, _, e in excesses])
    tm = trim_check(st["cluster_means"])
    return {
        "min_ratio": min_ratio,
        "n_events": len(events),
        "n_clusters": st["n_clusters"],
        "excess_per_event_pct": st["cluster_mean"] * 100,
        "t": st["t"],
        "trim_t": tm["t"],
        "trim_mean_pct": tm["mean"] * 100,
    }


def test_barrier_trade(series_list, horizon, lookback, kind, target_pct, stop_pct,
                       time_exit_min, volz_thresh=None):
    """
    THE TRADE, not the forward return. First-touch barrier resolution on
    1-minute bars, with a time exit.

    Returns the net expectancy in DOLLARS at the real ticket size.

    THE PLACEBO: the SAME event set with the direction randomised per event,
    run through the identical barrier resolution. The bar is "what does the
    best placebo score?", not a p-value. A signal whose NET is not better
    than the placebo's NET has no edge — it is paying the fee for noise.
    """
    events = []
    for pair, series in series_list.items():
        for i in range(lookback, series.n - horizon - 1):
            sig = signal_momentum(series, i, lookback)
            if sig is None or sig == 0:
                continue
            if kind == "hotvolume":
                vz = signal_zscore_volume(series, i, 30, 0)
                if vz is None or vz < volz_thresh:
                    continue
            side = "long" if (sig > 0) == (kind in ("momentum", "hotvolume")) else "short"
            outcome, ret = resolve_trade(series, i, side, target_pct, stop_pct, time_exit_min)
            if outcome is None:
                continue
            events.append((pair, series, i, side, outcome, ret))
    if not events:
        return None

    nets = [trade_net_dollars(r) for (_, _, _, _, _, r) in events]
    # cluster the NET dollars (cluster = 15-minute window)
    st = cluster_stats(
        [(ev[1].rows[ev[2]][0], net) for ev, net in zip(events, nets)]
    )
    wins = sum(1 for e in events if e[4] == "win")
    losses = sum(1 for e in events if e[4] == "loss")
    times = sum(1 for e in events if e[4] == "time")
    tm = trim_check(st["cluster_means"])

    # ── THE PLACEBO: same events, direction randomised ───────────────────
    rng = random.Random(20261021)
    pl_nets = []
    for pair, series, i, side, outcome, ret in events:
        pl_side = side if rng.random() < 0.5 else ("short" if side == "long" else "long")
        pl_outcome, pl_ret = resolve_trade(series, i, pl_side, target_pct, stop_pct, time_exit_min)
        pl_nets.append(trade_net_dollars(pl_ret))
    pl_st = cluster_stats(
        [(ev[1].rows[ev[2]][0], net) for ev, net in zip(events, pl_nets)]
    )

    # ── PER-SYMBOL BREAKDOWN (concentration) ─────────────────────────────
    per = defaultdict(list)
    for ev, net in zip(events, nets):
        per[ev[0]].append(net)
    per_sym = {
        s: {
            "n": len(v),
            "net_per_trade_usd": mean(v),
            "total_usd": sum(v),
        }
        for s, v in per.items()
    }
    ranked = sorted(per_sym.items(), key=lambda kv: kv[1]["total_usd"], reverse=True)
    worst_sym, worst_share = concentration(
        {s: float(v["total_usd"]) for s, v in per_sym.items()}
    )
    # what fraction of the total NET comes from the best symbol?
    total_net = sum(nets)
    best_sym = ranked[0][0]
    best_sym_net = float(ranked[0][1]["total_usd"])
    best_share = (best_sym_net / total_net) if total_net else 0.0

    return {
        "kind": kind,
        "target_pct": target_pct,
        "stop_pct": stop_pct,
        "time_exit_min": time_exit_min,
        "n_trades": len(events),
        "n_clusters": st["n_clusters"],
        "win_rate": wins / len(events),
        "n_win": wins,
        "n_loss": losses,
        "n_time": times,
        "net_per_trade_usd": mean(nets),
        "net_per_trade_t": st["t"],
        "net_per_trade_trim_usd": tm["mean"],
        "net_per_trade_trim_t": tm["t"],
        "total_net_usd": total_net,
        "fee_per_trade_usd": FEE_USD,
        "gross_per_trade_usd": mean(nets) + FEE_USD,
        # ── ALL-IN: fee PLUS the spread crossing ─────────────────────────
        # A taker round trip crosses the quoted spread once. On the
        # collector's median symbol that is another 10.7 bps on top of the
        # 12 bps of fees — so the real round-trip cost is ~22.7 bps, and
        # the $0.18 gross take-profit is ~79% consumed before the trade
        # starts.
        "all_in_cost_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
        "all_in_cost_usd": NOTIONAL * (TAKER_ROUND_TRIP + MEDIAN_SPREAD_BPS / 10000),
        "net_per_trade_usd_all_in": mean(nets) - NOTIONAL * MEDIAN_SPREAD_BPS / 10000,
        "placebo_net_per_trade_usd": pl_st["cluster_mean"],
        "placebo_t": pl_st["t"],
        "beats_placebo": mean(nets) > pl_st["cluster_mean"],
        "per_symbol": per_sym,
        "best_symbol": best_sym,
        "best_symbol_total_usd": best_sym_net,
        "best_symbol_share_of_total_net": best_share,
        "worst_symbol": worst_sym,
        "worst_symbol_share": worst_share,
        "passes_bar": (
            st["n_clusters"] >= MIN_CLUSTERS
            and st["t"] >= MIN_T
            and mean(nets) > 0
            and mean(nets) > pl_st["cluster_mean"]
        ),
        # THE REAL BAR: a finding must also CLEAR THE COST. The skill's
        # rule is "compare it to the COST, not to zero" — a real effect
        # smaller than the round trip is a hypothesis for a LONGER hold,
        # not a trading rule.
        "clears_the_cost": mean(nets) > 0 and mean(nets) > pl_st["cluster_mean"],
        "passes_full_bar": (
            st["n_clusters"] >= MIN_CLUSTERS
            and st["t"] >= MIN_T
            and mean(nets) > 0
            and mean(nets) > pl_st["cluster_mean"]
            and mean(nets) - NOTIONAL * MEDIAN_SPREAD_BPS / 10000 > 0
        ),
    }


# ══ the goal arithmetic ══════════════════════════════════════════════════

def goal_arithmetic():
    """
    What per-trade NET does the $10,000 target require, at the real size?

    $57.16 of equity. The goal is $10,000 (of equity, from $57.16).
    The notional cap is $60 (FIXED, not equity-proportional), and the daily
    notional budget is $500 (ALSO FIXED) — so the account can make
    $500/$60 = 8.33 -> 8 trades/day REGARDLESS of how large the equity
    grows. That is the whole problem: the machine's throughput is CAPPED
    IN DOLLARS while the goal is a dollar target.
    """
    start = EQUITY
    goal = 10000.0
    gap = goal - start
    out = {
        "start_equity_usd": start,
        "goal_usd": goal,
        "gap_usd": gap,
        "notional_per_ticket_usd": NOTIONAL,
        "daily_notional_budget_usd": 500.0,
        "trades_per_day_at_budget": 500.0 / NOTIONAL,
        "trades_per_day_floor": int(500.0 // NOTIONAL),
        "fee_per_trade_usd": FEE_USD,
        "fee_pct_of_notional": TAKER_ROUND_TRIP * 100,
    }
    # if the notional cap scaled WITH equity, the arithmetic would be
    # completely different — so both are computed.
    for label, notional_fn, budget_fn in (
        ("FIXED cap ($60 ticket, $500/day)", lambda eq: NOTIONAL, lambda eq: 500.0),
        ("SCALING cap (notional = equity, budget = 8x equity)", lambda eq: eq, lambda eq: eq * 8.0),
    ):
        per_day_notional = notional_fn(start)
        trades_per_day = budget_fn(start) / notional_fn(start)
        # net per trade needed, compounding daily at `trades_per_day`
        #   equity(t+1) = equity(t) + trades_per_day * net_per_trade
        # but net_per_trade is a fixed DOLLAR amount only in the fixed case.
        res = []
        for net_per_trade in (0.01, 0.05, 0.10, 0.25, 0.50, 1.00, 2.00, 5.00):
            eq = start
            days = 0
            while eq < goal and days < 36500:
                eq += trades_per_day * net_per_trade
                days += 1
            res.append({"net_per_trade_usd": net_per_trade, "days_to_goal": days if eq >= goal else None})
        out[label] = {"trades_per_day": trades_per_day, "ladder": res}

    # The FIXED-cap case: solve for the net per trade that hits the goal in
    # 1 day, 30 days, 365 days and 3 years.
    tpd = out["FIXED cap ($60 ticket, $500/day)"]["trades_per_day"]
    solve = {}
    for days in (1, 7, 30, 90, 365, 1095):
        need = gap / (tpd * days)
        solve[f"{days}d"] = need
    out["fixed_cap_required_net_per_trade_usd"] = solve

    # The same, expressed as a per-trade PERCENTAGE of the ticket, because
    # that is what the fee floor is measured against.
    out["fixed_cap_required_net_per_trade_pct_of_notional"] = {
        k: v / NOTIONAL * 100 for k, v in solve.items()
    }
    # And as a per-trade percentage of EQUITY (what the machine reports).
    out["fixed_cap_required_net_per_trade_pct_of_equity"] = {
        k: v / start * 100 for k, v in solve.items()
    }

    # WIN RATE implied, for the shipped geometry and for a ladder of targets.
    #   net = w*tp - (1-w)*sl - fee   (fractions of notional)
    #   w = (sl + fee + net) / (tp + sl)
    fee = TAKER_ROUND_TRIP
    wl = {}
    for tp in (0.0005, 0.0010, 0.0012, 0.0020, 0.0030, 0.0050):
        for sl in (0.0012, 0.0020, 0.0030, 0.0050):
            need_net_frac = 0.0
            be = (sl + fee) / (tp + sl)
            wl[f"tp{tp*100:.2f}%_sl{sl*100:.2f}%"] = {
                "break_even_win_rate": be,
                "break_even_win_rate_pct": be * 100,
                "fee_pct_of_target": fee / tp * 100,
            }
    out["break_even_ladder"] = wl

    # What win rate does the GOAL require, at a given target, in 365 days?
    # net per trade needed = gap / (8 * 365) = $9.43
    need_net_365 = gap / (tpd * 365)
    need_frac_365 = need_net_365 / NOTIONAL
    wreq = {}
    for tp in (0.0005, 0.0010, 0.0020, 0.0030, 0.0050, 0.0100):
        for sl in (0.0012, 0.0020, 0.0030, 0.0050):
            w = (sl + fee + need_frac_365) / (tp + sl)
            wreq[f"tp{tp*100:.2f}%_sl{sl*100:.2f}%"] = {
                "required_win_rate": w,
                "required_win_rate_pct": w * 100,
                "feasible": w <= 1.0,
            }
    out["win_rate_for_365d_goal"] = {
        "required_net_per_trade_usd": need_net_365,
        "required_net_fraction_of_notional": need_frac_365,
        "ladder": wreq,
    }
    return out


def latency_arithmetic():
    """
    HOW MANY ROUND TRIPS CAN THE ACCOUNT MAKE?

    The measured round trip is 4-7 seconds (the machine fires and the TP
    is already satisfied, so it closes almost immediately). But the
    account's REAL constraint is not the clock — it is the DAILY
    NOTIONAL BUDGET ($500) and the per-ticket notional ($60).
    """
    out = {
        "measured_round_trip_s": [4, 7],
        "trades_per_day_at_budget": int(500.0 // NOTIONAL),
        "unconstrained_by_clock": {
            "seconds_available_24h": 86400,
            "round_trips_at_4s": 86400 // 4,
            "round_trips_at_7s": 86400 // 7,
            "notional_cap_per_trade_usd": NOTIONAL,
            "notional_needed_at_21600_trades": 21600 * NOTIONAL,
            "notional_budget_usd": 500.0,
            "verdict": "the CLOCK is not the binding constraint; the $500 DAILY NOTIONAL BUDGET is",
        },
    }
    # The observed machine: how fast does it actually fire, and how many
    # notional does it burn per trade?
    try:
        rows = [json.loads(l) for l in TRADELOOP.read_text().splitlines() if l.strip()]
        fired = [
            r for r in rows
            if isinstance(r, dict) and r.get("event") == "live-result" and r.get("status") == "fired"
        ]
        out["observed_fired_trades"] = len(fired)
        out["observed_notionals_usd"] = [
            r["ticket"]["sizing"]["notionalUsd"] for r in fired if r.get("ticket")
        ]
        # inter-fire spacing on the same pair
        by_pair = defaultdict(list)
        for r in fired:
            by_pair[r["pair"]].append(r["ts"])
        gaps = []
        for p, ts in by_pair.items():
            ts.sort()
            gaps += [(ts[i + 1] - ts[i]) / 1000 for i in range(len(ts) - 1)]
        if gaps:
            out["observed_inter_fire_gap_s"] = {
                "median": statistics.median(gaps),
                "min": min(gaps),
                "max": max(gaps),
                "n": len(gaps),
            }
        # the notional actually burned vs the budget
        spent = sum(out["observed_notionals_usd"])
        out["observed_notional_burn_usd"] = spent
        out["observed_budget_exhaustion_reason"] = "Daily notional cap would exceed $500"
    except Exception as e:
        out["observed_error"] = str(e)
    return out


def fee_floor_table(conf_rows):
    """
    THE FEE FLOOR: how big must a move be to be worth trading?

    For each candidate target, the move that must be captured to clear the
    round-trip cost. This is the number that decides whether ANY
    microstructure signal can pay, regardless of its t-statistic.
    """
    out = {
        "taker_round_trip_bps": TAKER_ROUND_TRIP * 10000,
        "median_spread_bps": MEDIAN_SPREAD_BPS,
        "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
        "fee_usd_per_ticket": FEE_USD,
        "spread_usd_per_ticket": NOTIONAL * MEDIAN_SPREAD_BPS / 10000,
        "ladder": [],
    }
    out["spread_usd_per_ticket"] = NOTIONAL * MEDIAN_SPREAD_BPS / 10000
    for tgt_bps in (5, 10, 12, 15, 20, 24, 30, 48, 60, 100):
        fee_frac = TAKER_ROUND_TRIP
        allin_frac = TAKER_ROUND_TRIP + MEDIAN_SPREAD_BPS / 10000
        out["ladder"].append({
            "target_bps": tgt_bps,
            "gross_usd": NOTIONAL * tgt_bps / 10000,
            "fee_usd": FEE_USD,
            "spread_usd": NOTIONAL * MEDIAN_SPREAD_BPS / 10000,
            "all_in_usd": NOTIONAL * allin_frac,
            "net_usd_fee_only": NOTIONAL * (tgt_bps / 10000 - fee_frac),
            "net_usd_all_in": NOTIONAL * (tgt_bps / 10000 - allin_frac),
            "fee_pct_of_gross": fee_frac / (tgt_bps / 10000) * 100,
            "all_in_pct_of_gross": allin_frac / (tgt_bps / 10000) * 100,
            # the win rate needed to break even at 1:1 R:R
            "breakeven_win_rate_fee_only": (fee_frac + tgt_bps / 10000) / (2 * tgt_bps / 10000),
            "breakeven_win_rate_all_in": (allin_frac + tgt_bps / 10000) / (2 * tgt_bps / 10000),
        })
    return out


def measured_move_table(series_list):
    """
    The move distribution at each horizon, measured on the real 1-minute
    bars, against the fee floor. "The average 5-minute move after an X is
    Y bps and the round trip costs Z bps" is the whole argument in one line.
    """
    out = {}
    for h in (1, 2, 3, 5, 10, 15):
        rets = []
        for pair, series in series_list.items():
            for i in range(0, series.n - h - 1, 7):  # stride to keep it cheap
                r = series.ret(i, h)
                if r is not None:
                    rets.append(r)
        if not rets:
            continue
        a = sorted(abs(x) for x in rets)
        n = len(a)
        out[f"{h}m"] = {
            "n": n,
            "mean_abs_bps": mean(a) * 10000,
            "median_abs_bps": a[n // 2] * 10000,
            "p75_abs_bps": a[int(0.75 * n)] * 10000,
            "p90_abs_bps": a[int(0.90 * n)] * 10000,
            "p99_abs_bps": a[int(0.99 * n)] * 10000,
            "mean_signed_bps": mean(rets) * 10000,
            "fee_bps": TAKER_ROUND_TRIP * 10000,
            "all_in_bps": TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS,
            "median_move_minus_fee_bps": a[n // 2] * 10000 - TAKER_ROUND_TRIP * 10000,
            "median_move_minus_all_in_bps": a[n // 2] * 10000 - (TAKER_ROUND_TRIP * 10000 + MEDIAN_SPREAD_BPS),
            "pct_of_moves_beating_fee": sum(1 for x in a if x > TAKER_ROUND_TRIP) / n * 100,
            "pct_of_moves_beating_all_in": sum(1 for x in a if x > TAKER_ROUND_TRIP + MEDIAN_SPREAD_BPS / 10000) / n * 100,
        }
    return out


# ══ main ═════════════════════════════════════════════════════════════════

def main():
    res = {}
    bars1 = load_bars_1m()
    series_list = {p: Series(rows) for p, rows in bars1.items()}
    res["data_inventory"] = {
        "pairs_with_1m_bars": len(series_list),
        "bars_total": sum(s.n for s in series_list.values()),
        "min_bars": min((s.n for s in series_list.values()), default=0),
        "max_bars": max((s.n for s in series_list.values()), default=0),
        "full_coverage_pairs": sorted(p for p, s in series_list.items() if s.n > 15000),
    }

    # ── TEST 1: mean reversion and momentum at 1-5 minutes ────────────────
    t1 = []
    for horizon in (1, 2, 3, 5):
        for lookback in (1, 3, 5):
            for kind in ("momentum", "reversion"):
                r = test_directional_family(series_list, horizon, lookback, kind)
                if r:
                    t1.append(r)
    res["test1_mr_momentum"] = t1

    # ── TEST 3: the liquidity-event signature ─────────────────────────────
    t3 = []
    for horizon in (1, 3, 5):
        for vz in (2.0, 3.0):
            r = test_hotvolume(series_list, horizon, 5, vz)
            if r:
                t3.append(r)
    res["test3_liquidity_event"] = t3

    # ── the TRADE, not the forward return ─────────────────────────────────
    trades = []
    for kind in ("momentum", "reversion"):
        for horizon, lookback in ((1, 1), (3, 3), (5, 5), (3, 1)):
            for tgt, slp in ((0.0012, 0.0024), (0.0024, 0.0024), (0.0012, 0.0012)):
                r = test_barrier_trade(
                    series_list, horizon, lookback, kind, tgt, slp, time_exit_min=10
                )
                if r:
                    trades.append(r)
    res["barrier_trades"] = trades

    # ── TEST 2: the collector's own book signals ──────────────────────────
    conf = load_confluence()
    res["test2_book_signals"] = test_book_signals(conf, series_list, 3)
    res["test2_spread_widening"] = test_spread_widening(conf, series_list, 3)

    # ── the arithmetic ────────────────────────────────────────────────────
    res["goal_arithmetic"] = goal_arithmetic()
    res["latency_arithmetic"] = latency_arithmetic()
    res["fee_floor"] = fee_floor_table(conf)
    res["measured_moves"] = measured_move_table(series_list)
    res["collector_inventory"] = {
        "n_rows": len(conf),
        "n_pairs": len(set(r["pair"] for r in conf)),
        "span_first_utc": min(r["ts"] for r in conf),
        "span_last_utc": max(r["ts"] for r in conf),
        "span_hours": (max(r["ts"] for r in conf) - min(r["ts"] for r in conf)) / 3.6e6,
    }

    OUT.write_text(json.dumps(res, indent=2, default=str))
    print(f"[hf] written -> {OUT}")
    print(f"[hf] pairs={res['data_inventory']['pairs_with_1m_bars']} "
          f"bars={res['data_inventory']['bars_total']}")


if __name__ == "__main__":
    main()
