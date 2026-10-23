#!/usr/bin/env python3
"""
THE CORRELATION-AWARE RE-ESTIMATE — is the round-level t inflated?

═══════════════════════════════════════════════════════════════════════

THE PROBLEM

The paired-by-round estimator treats one round as one observation. But
the per-round differences are SERIALLY CORRELATED: a market regime that
lasts an hour moves every round inside it the same way. So the
round-level standard error UNDERSTATES the true uncertainty, and the
round-level t OVERSTATES the evidence.

Measured on the 90-day deep sample: the lag-1 autocorrelation of the
per-round differences is rho = 0.76. The naive effective sample size
would be

    n_eff = n x (1 - rho) / (1 + rho)

═══════════════════════════════════════════════════════════════════════

THE THREE CORRECTIONS, and what each one is for

1. THE AUTOCORRELATION-CORRECTED t (Newey-West / AR(1) effective n).
   The right correction for the round-level estimator.

2. THE DAY-LEVEL t. Treat the DAY as the independent unit. 91 days.
   This is the most conservative cluster and the one that matches the
   project's own "the effect must be in most days" standard.

3. THE BLOCK BOOTSTRAP. Resample whole blocks of consecutive rounds.
   Makes no normality assumption and no assumption about the shape of
   the autocorrelation.

═══════════════════════════════════════════════════════════════════════

AND THE SIGN TEST'S POWER

The day-sign test came back at p = 1.00 (55 of 91 days positive). That
is NOT evidence of randomness: it is a test with very low POWER. The
sign test only detects an effect whose size is large compared with the
day-to-day noise. Here the day-to-day noise is several times the
effect, so the test cannot see the effect even if it is real. This file
computes the sign test's power under the observed noise, so the p = 1.00
is read correctly.
"""
import json
import math
import os
import random
from collections import defaultdict

import numpy as np
from scipy import stats

SCRATCH = os.path.expanduser("~/.hermes/cache/scratch")
OUT = os.path.join(SCRATCH, "decisive")


def load(name):
    return json.load(open(os.path.join(OUT, name)))


ku = load("result-ku.json")
deep = load("result-deep.json")

print("=" * 100)
print("1. THE AUTOCORRELATION OF THE PER-ROUND DIFFERENCES")
print("=" * 100)


def ac(x, lag):
    x = np.asarray(x, dtype=float)
    m = x.mean()
    num = np.sum((x[:-lag] - m) * (x[lag:] - m))
    den = np.sum((x - m) ** 2)
    return float(num / den) if den else float("nan")


def newey_west_se(x, lag):
    """Newey-West HAC standard error of the mean."""
    x = np.asarray(x, dtype=float)
    n = len(x)
    m = x.mean()
    u = x - m
    gamma0 = np.sum(u ** 2) / n
    lrv = gamma0
    for L in range(1, lag + 1):
        w = 1 - L / (lag + 1)
        g = np.sum(u[L:] * u[:-L]) / n
        lrv += 2 * w * g
    lrv = max(lrv, 1e-18)
    return float(math.sqrt(lrv / n)), lrv


def block_bootstrap(x, block, n_boot, seed):
    rng = random.Random(seed)
    x = list(x)
    n = len(x)
    nblocks = max(1, n // block)
    means = []
    for _ in range(n_boot):
        s = []
        for _ in range(nblocks):
            i = rng.randrange(0, max(1, n - block))
            s.extend(x[i:i + block])
        means.append(sum(s) / len(s))
    means.sort()
    lo = means[int(0.025 * n_boot)]
    hi = means[int(0.975 * n_boot)]
    p_two = 2 * min(
        sum(1 for v in means if v <= 0) / n_boot,
        sum(1 for v in means if v >= 0) / n_boot,
    )
    return float(sum(means) / n_boot), lo, hi, min(1.0, p_two)


CASES = []
for lab, res, key in [
    ("KUCOIN collector  LIVE-GATE vs TAPE", ku, "live_vs_tape"),
    ("KUCOIN collector  LAYA-ONLY vs TAPE", ku, "laya_vs_tape"),
    ("BINANCE 90d        LAYA-ONLY vs TAPE", deep, "laya_vs_tape"),
]:
    e = res["excess"][key]
    diffs = e["diffs"]
    if len(diffs) < 10:
        continue
    CASES.append((lab, e, diffs))

for lab, e, diffs in CASES:
    print(f"\n  {lab}")
    print(f"    rounds {e['rounds']:,} | excess {e['excess']:+.5f}% | naive se {e['se']:.5f} | naive t {e['t']:.2f}")
    r1 = ac(diffs, 1)
    r5 = ac(diffs, 5)
    r60 = ac(diffs, 60)
    print(f"    autocorrelation: lag-1 {r1:+.4f}  lag-5 {r5:+.4f}  lag-60 (1h) {r60:+.4f}")
    if r1 == r1:  # not NaN
        neff = len(diffs) * (1 - r1) / (1 + r1)
        se_corr = e["se"] * math.sqrt(len(diffs) / neff)
        print(f"    AR(1)-effective n = {neff:,.0f} (from {len(diffs):,})  ->  corrected se {se_corr:.5f}  corrected t {e['excess']/se_corr:.2f}")
    # Newey-West with a 1-hour lag (12 rounds of 5 min)
    nw_se, lrv = newey_west_se(diffs, 12)
    print(f"    Newey-West HAC (lag=12 rounds = 1h): se {nw_se:.5f}  t {e['excess']/nw_se:.2f}")
    # block bootstrap
    for block in (12, 288):
        if len(diffs) < block * 4:
            continue
        m, lo, hi, p = block_bootstrap(diffs, block, 2000, 12345 + block)
        print(f"    block bootstrap (block={block:>3} rounds = {block*5/60:.0f}h): mean {m:+.5f}  95% CI [{lo:+.5f}, {hi:+.5f}]  p {p:.4f}")

print()
print("=" * 100)
print("2. THE DAY-LEVEL t — the day as the independent unit")
print("=" * 100)
for lab, res, key in [
    ("KUCOIN collector  LIVE-GATE vs TAPE", ku, "live_vs_tape"),
    ("KUCOIN collector  LAYA-ONLY vs TAPE", ku, "laya_vs_tape"),
    ("BINANCE 90d        LAYA-ONLY vs TAPE", deep, "laya_vs_tape"),
]:
    ds = res["dayStability"].get("laya" if "LAYA" in lab else "live")
    if not ds:
        continue
    ex = np.array([x["excess"] for x in ds["per"]])
    n = len(ex)
    m = ex.mean()
    sd = ex.std(ddof=1)
    se = sd / math.sqrt(n)
    t = m / se
    p = 2 * (1 - stats.t.cdf(abs(t), n - 1))
    crit = stats.t.ppf(0.975, n - 1)
    print(f"\n  {lab}")
    print(f"    {n} days | mean of the daily excesses {m:+.5f}% | sd across days {sd:.5f} | se {se:.5f}")
    print(f"    t = {t:.2f}  (critical |t| at 5% with {n-1} df = {crit:.2f})  p = {p:.4f}")
    print(f"    positive on {ds['positive']}/{n} days ({ds['positive']/n*100:.1f}%) | sign test p = {ds['signTestP']:.3f}")

print()
print("=" * 100)
print("3. IS THE SIGN TEST INFORMATIVE? — its power under the observed noise")
print("=" * 100)
print("""
  The sign test asks: over the days, is the excess positive more often
  than not? Its power depends on the ratio of the effect to the
  day-to-day noise. If the daily noise is several times the effect, the
  test cannot see the effect even when it is real — and p = 1.00 then
  means "this test was blind", not "there is no effect".
""")
for lab, res, key in [
    ("KUCOIN collector  LIVE-GATE vs TAPE", ku, "live_vs_tape"),
    ("KUCOIN collector  LAYA-ONLY vs TAPE", ku, "laya_vs_tape"),
    ("BINANCE 90d        LAYA-ONLY vs TAPE", deep, "laya_vs_tape"),
]:
    ds = res["dayStability"].get("laya" if "LAYA" in lab else "live")
    if not ds:
        continue
    ex = np.array([x["excess"] for x in ds["per"]])
    n = len(ex)
    sd = ex.std(ddof=1)
    eff = float(np.mean(ex))
    # under the hypothesis "true effect = eff, daily noise sd = sd",
    # each day is positive with probability Phi(eff/sd)
    p_pos = stats.norm.cdf(eff / sd) if sd > 0 else 0.5
    from math import comb
    def p_two_sided(k, n):
        tail = sum(comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
        return min(1.0, 2 * tail)
    p_null = p_two_sided(ds["positive"], n)
    crit_k = None
    for k in range(n // 2, n + 1):
        if p_two_sided(k, n) < 0.05:
            crit_k = k
            break
    print(f"\n  {lab}")
    print(f"    true effect {eff:+.5f}% | day-to-day sd {sd:.5f}% | ratio {eff/sd:.3f}")
    print(f"    => a day is positive with probability {p_pos:.3f}")
    print(f"    => expected positive days out of {n}: {n*p_pos:.1f}   OBSERVED: {ds['positive']}")
    if crit_k:
        p_detect = sum(comb(n, i) * p_pos ** i * (1 - p_pos) ** (n - i) for i in range(crit_k, n + 1))
        print(f"    a significant sign result needs >= {crit_k}/{n} days positive")
        print(f"    the sign test's POWER to detect this effect: {p_detect:.3f} ({p_detect*100:.1f}%)")
        print(f"    the null p-value at the observed {ds['positive']}/{n}: {p_null:.4f}")
        if p_detect < 0.2:
            print(f"    => the sign test is BLIND here. p={p_null:.3f} is uninformative about the effect.")
        else:
            print(f"    => the sign test has power; its p={p_null:.4f} IS informative.")

print()
print("=" * 100)
print("4. THE SUMMARY TABLE — one row per estimator")
print("=" * 100)
print(f"\n  {'case':<40}{'rounds':>9}{'excess %':>11}{'naive t':>9}{'AR1 t':>8}{'NW t':>8}{'day t':>8}{'boot p':>9}")


def summarise(lab, res, key, dskey):
    e = res["excess"][key]
    diffs = e["diffs"]
    r1 = ac(diffs, 1)
    neff = len(diffs) * (1 - r1) / (1 + r1)
    se_ar1 = e["se"] * math.sqrt(len(diffs) / neff)
    nw_se, _ = newey_west_se(diffs, 12)
    ds = res["dayStability"].get(dskey)
    if ds:
        ex = np.array([x["excess"] for x in ds["per"]])
        dt = ex.mean() / (ex.std(ddof=1) / math.sqrt(len(ex)))
    else:
        dt = float("nan")
    m, lo, hi, p = block_bootstrap(diffs, 12, 2000, 999)
    print(f"  {lab:<40}{e['rounds']:>9,}{e['excess']:>+11.5f}{e['t']:>9.2f}{e['excess']/se_ar1:>8.2f}"
          f"{e['excess']/nw_se:>8.2f}{dt:>8.2f}{p:>9.4f}")
    return {"naive_t": e["t"], "ar1_t": e["excess"] / se_ar1, "nw_t": e["excess"] / nw_se,
            "day_t": dt, "boot_p": p, "boot_ci": [lo, hi], "excess": e["excess"], "rounds": e["rounds"]}


SUMMARY = {}
SUMMARY["ku_live"] = summarise("KUCOIN collector LIVE-GATE vs TAPE", ku, "live_vs_tape", "live")
SUMMARY["ku_laya"] = summarise("KUCOIN collector LAYA-ONLY vs TAPE", ku, "laya_vs_tape", "laya")
SUMMARY["deep_laya"] = summarise("BINANCE 90d       LAYA-ONLY vs TAPE", deep, "laya_vs_tape", "laya")

json.dump(SUMMARY, open(os.path.join(OUT, "correlation-aware.json"), "w"), indent=2)
print(f"\n  wrote {os.path.join(OUT, 'correlation-aware.json')}")
