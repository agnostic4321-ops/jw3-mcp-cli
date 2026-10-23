#!/usr/bin/env python3
"""
THE POWER ANALYSIS — how much data is needed to tell a real small effect
from a window artefact?

═══════════════════════════════════════════════════════════════════════

THE BINDING CONSTRAINT

    equity $57.16 | notional $60.00 | exposure 1.0497x
    taker round trip 0.12% of notional = $0.0720 per trade = 0.1260% of equity
    gross take-profit $0.18 (0.30% of $60)
    break-even win rate 82.8%

So the fee is 40% of the gross win, and the excess the confirmation layer
adds must be measured in DOLLARS at this size, not in percent of a
notional that does not exist.

═══════════════════════════════════════════════════════════════════════

THE ESTIMATOR

A PAIRED-BY-ROUND estimator. One observation per ROUND: the difference
of the two arms' round means. The standard error of the mean excess is

    SE(n) = sd_round / sqrt(n)

where sd_round is the standard deviation of the per-round differences —
the CLUSTER-level variance, never the row-level variance. With ~45
symbols per round, the row-level variance is ~45x smaller in variance
terms and would overstate the evidence by ~6.7x in the t-statistic.

The test statistic is t = excess / SE(n), and the target is t >= 2 at
80% power. The power at a given n and true effect delta is

    power(n, delta) = P( T_{n-1}(ncp) > t_crit ) + P( T_{n-1}(ncp) < -t_crit )

with ncp = delta / SE(n) and t_crit the two-sided 5% critical value.

═══════════════════════════════════════════════════════════════════════
"""
import json
import math
import os
from scipy import stats
import numpy as np

SCRATCH = os.path.expanduser("~/.hermes/cache/scratch")
OUT = os.path.join(SCRATCH, "decisive")

EQUITY = 57.1579522047
NOTIONAL = 60.0
RHO = NOTIONAL / EQUITY
FEE_PCT_NOTIONAL = 0.12
FEE_PCT_EQUITY = FEE_PCT_NOTIONAL / 100 * RHO * 100
FEE_DOLLARS = FEE_PCT_NOTIONAL / 100 * NOTIONAL
GROSS_TP_DOLLARS = 0.30 / 100 * NOTIONAL   # 0.30% target
BREAK_EVEN_WR = 82.8 / 100


def fmt(x, d=4):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "n/a"
    return f"{x:+.4f}" if d <= 4 else f"{x:.{d}f}"


def dollars(pct_of_equity):
    return pct_of_equity / 100.0 * EQUITY


def power_at_n(n, delta, sd, alpha=0.05):
    """Two-sided power of a one-sample t-test for a mean of delta."""
    if n < 2:
        return float("nan")
    se = sd / math.sqrt(n)
    ncp = delta / se
    crit = stats.t.ppf(1 - alpha / 2, n - 1)
    # P(|T| > crit) with T ~ noncentral t(df=n-1, ncp)
    return float(stats.nct.sf(crit, n - 1, ncp) + stats.nct.cdf(-crit, n - 1, ncp))


def required_n(delta, sd, alpha=0.05, target=0.80, nmax=200000):
    """The smallest n with power >= target for a true effect of delta."""
    if delta <= 0:
        return None
    # Start from the normal approximation, then refine.
    lo = 2
    # doubling search
    hi = 16
    while hi <= nmax and power_at_n(hi, delta, sd, alpha) < target:
        lo = hi
        hi *= 2
    if hi > nmax:
        return None
    # binary search
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if power_at_n(mid, delta, sd, alpha) >= target:
            hi = mid
        else:
            lo = mid
    return hi


def mde_at_n(n, sd, alpha=0.05, target=0.80):
    """The smallest true effect detectable with power >= target at n."""
    if n < 2:
        return float("nan")
    crit = stats.t.ppf(1 - alpha / 2, n - 1)
    z = stats.norm.ppf(1 - (1 - target) / 2)  # z for 80% power, two-sided
    # exact: find delta with power(delta) = target
    lo, hi = 0.0, 10 * sd
    for _ in range(200):
        mid = (lo + hi) / 2
        if power_at_n(n, mid, sd, alpha) < target:
            lo = mid
        else:
            hi = mid
    return hi


def p_true_le_zero(estimate, se):
    """
    The posterior probability that the TRUE effect is <= 0, given the
    estimate and its uncertainty, under a flat prior on the effect over a
    symmetric interval (the usual "significance as a probability" reading
    of a normal approximation; the t-distribution version is used for the
    p-value itself).

    For a normal likelihood with a flat prior the posterior on delta is
    N(estimate, se^2), so

        P(true <= 0) = Phi(0 - estimate) / se

    For a t-likelihood with df = n-1, the corresponding quantity is the
    t-distribution CDF at -t.
    """
    if se <= 0:
        return 0.5 if estimate <= 0 else 0.0
    return float(stats.norm.cdf(-estimate / se))


def report(title, lines):
    print()
    print("=" * 100)
    print(title)
    print("=" * 100)
    for l in lines:
        print(l)


# ══════════════════════════════════════════════════════════════════════
# LOAD THE MEASURED RESULTS
# ══════════════════════════════════════════════════════════════════════
ku = json.load(open(os.path.join(OUT, "result-ku.json")))
deep = json.load(open(os.path.join(OUT, "result-deep.json")))
corr = json.load(open(os.path.join(OUT, "correlation-aware.json")))
placebo = json.load(open(os.path.join(OUT, "placebo.json")))

print("THE MEASURED EXCESSES (paired by round)")
print("-" * 100)
for name, res, keys in [
    ("KUCOIN collector (6.06 h, 45 rounds)", ku, ["live_vs_tape", "live_vs_rejected", "laya_vs_tape", "laya_vs_rejected", "loose_vs_tape"]),
    ("BINANCE 90d (2165 h, 25,990 rounds)", deep, ["laya_vs_tape", "laya_vs_rejected"]),
]:
    print(f"\n  {name}")
    for k in keys:
        e = res["excess"].get(k)
        if not e or e["rounds"] == 0:
            continue
        sd = e["se"] * math.sqrt(e["rounds"])
        print(f"    {k:24s} rounds {e['rounds']:>7,}  excess {fmt(e['excess']):>10}  "
              f"se {fmt(e['se']):>10}  t {e['t']:>6.2f}  p {e['p']:.2e}   "
              f"cluster sd {fmt(sd):>10}  = ${dollars(e['excess']):+.4f}/trade")

# ══════════════════════════════════════════════════════════════════════
# THE CLUSTER-LEVEL VARIANCE — the single number the power calc needs
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("THE CLUSTER-LEVEL VARIANCE (the only variance a power calculation may use)")
print("=" * 100)

VARIANCES = {}
for name, res, key in [
    ("KUCOIN collector LIVE-GATE vs TAPE", ku, "live_vs_tape"),
    ("KUCOIN collector LAYA-ONLY vs TAPE", ku, "laya_vs_tape"),
    ("BINANCE 90d LAYA-ONLY vs TAPE", deep, "laya_vs_tape"),
]:
    e = res["excess"][key]
    n = e["rounds"]
    sd = e["se"] * math.sqrt(n)
    VARIANCES[name] = {"n": n, "excess": e["excess"], "se": e["se"], "t": e["t"], "sd": sd}
    print(f"  {name}")
    print(f"    paired rounds {n:>7,} | cluster sd of the per-round difference {fmt(sd):>10} % of equity")
    print(f"    = ${dollars(sd):.4f} of equity per round")

print()
print("=" * 100)
print("THE CORRELATION CORRECTION — the per-round differences are serially correlated")
print("=" * 100)
print("""
  A paired-by-round estimator treats one round as one observation. But a
  market regime that lasts an hour moves every round inside it the same
  way, so the round-level standard error UNDERSTATES the uncertainty.
  Two corrections are applied and reported side by side:

    AR(1)      the effective n is n x (1-rho)/(1+rho), with rho the
               lag-1 autocorrelation of the per-round differences.
    DAY        the day is the independent unit: 91 days.
""")
for lab, c in corr.items():
    print(f"  {lab}")
    print(f"    naive t {c['naive_t']:.2f} | AR(1)-corrected t {c['ar1_t']:.2f} | Newey-West t {c['nw_t']:.2f} | day-level t {c['day_t']:.2f} | 24h block-bootstrap p {c['boot_p']:.4f}")
    if c.get("boot_ci"):
        print(f"    24h block-bootstrap 95% CI: [{c['boot_ci'][0]:+.5f}, {c['boot_ci'][1]:+.5f}]  (includes zero: {c['boot_ci'][0] <= 0 <= c['boot_ci'][1]})")
    print(f"    excess {c['excess']:+.5f}% = ${dollars(c['excess']):+.4f}/trade")

# the CORRELATION-AWARE standard error is what the power calc must use
print()
print("  The power calculations below use the AR(1)-corrected effective n,")
print("  because that is the honest number of independent observations.")
for lab, res, key, ck in [
    ("KUCOIN collector LIVE-GATE vs TAPE", ku, "live_vs_tape", "ku_live"),
    ("KUCOIN collector LAYA-ONLY vs TAPE", ku, "laya_vs_tape", "ku_laya"),
    ("BINANCE 90d LAYA-ONLY vs TAPE", deep, "laya_vs_tape", "deep_laya"),
]:
    c = corr[ck]
    e = res["excess"][key]
    n_eff = e["rounds"] * (e["se"] / (e["excess"] / c["ar1_t"])) ** 2
    VARIANCES[lab]["n_eff"] = n_eff
    VARIANCES[lab]["ar1_t"] = c["ar1_t"]
    print(f"    {lab:<46} naive n {e['rounds']:>7,} -> effective n {n_eff:>9,.0f}   (t {e['t']:.2f} -> {c['ar1_t']:.2f})")

# ══════════════════════════════════════════════════════════════════════
# 1. THE EFFECT SIZE TO DETECT
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("1. THE EFFECT SIZE THAT MATTERS — what excess is worth having, in DOLLARS?")
print("=" * 100)
print(f"""
  The account: equity ${EQUITY:.2f}, notional ${NOTIONAL:.2f}, exposure {RHO:.4f}x.
  The fee: {FEE_PCT_NOTIONAL}% taker round trip = ${FEE_DOLLARS:.4f} per trade
           = {FEE_PCT_EQUITY:.4f}% of equity.
  A gross take-profit of 0.30% of notional = ${GROSS_TP_DOLLARS:.4f}.
  The fee is {FEE_DOLLARS / GROSS_TP_DOLLARS * 100:.0f}% of the gross win.
  Break-even win rate {BREAK_EVEN_WR * 100:.1f}%.

  So the excess the confirmation layer adds is worth having only if it
  either (a) pays for a round trip it would not otherwise have paid, or
  (b) is large enough to move the WIN RATE, since every point of win rate
  is worth {dollars(FEE_PCT_EQUITY)}/({3.4:.1f} wins) of expectancy.
""")

# (a) the fee-covering excess
EX_FEE = FEE_PCT_EQUITY
print(f"  (a) the excess that COVERS ONE ROUND TRIP: {EX_FEE:.4f}% of equity = ${dollars(EX_FEE):.4f}/trade")
print(f"  (b) the excess that BUYS ONE POINT OF WIN RATE:")
# EV(w) = w*(tp_frac*RHO - fee*RHO) + (1-w)*(-stop*RHO - fee*RHO); d(EV)/dw = (tp+stop)*RHO
# from the live ticket: tp ~0.4% of notional, stop ~ 3d/(200+d) with d~1.08 -> ~1.61%
for tp_pct, stop_pct in [(0.30, 1.61), (0.50, 1.61), (0.30, 0.60)]:
    dEV_dw = (tp_pct + stop_pct) / 100 * RHO * 100  # % of equity per unit win rate
    print(f"      tp {tp_pct:.2f}% / stop {stop_pct:.2f}%: one point of win rate = {dEV_dw:.4f}% of equity = ${dollars(dEV_dw):.4f}")

# the CLAIMED effect, in dollars
CLAIM_PCT = 0.0752
print(f"\n  The CLAIMED excess: {CLAIM_PCT}% of equity = ${dollars(CLAIM_PCT):.4f} per trade")
print(f"    = {CLAIM_PCT / EX_FEE * 100:.0f}% of one round trip's fee")

# ══════════════════════════════════════════════════════════════════════
# 2. THE POWER CURVE
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("2. THE POWER CURVE — paired-by-round estimator, CLUSTER-level variance, AR(1)-corrected n")
print("=" * 100)
print("""
  The power is computed with the EXACT noncentral-t, at the observed
  cluster-level standard deviation of the per-round difference. The
  n in the table is the number of INDEPENDENT observations, i.e. the
  AR(1)-effective number of rounds.
""")


def power_curve(sd, deltas, ns, alpha=0.05):
    print(f"\n  cluster sd = {fmt(sd)}% of equity per round")
    print("  n (independent obs)" + "".join(f"  d={d:+.4f}" for d in deltas))
    for n in ns:
        line = f"  {n:>18,} "
        for d in deltas:
            p = power_at_n(int(n), d, sd, alpha)
            line += f"  {p:>9.3f}"
        print(line)


# The most relevant scenario: the collector's own cluster-level sd, and
# the CLAIMED effect size.
ku_live = VARIANCES["KUCOIN collector LIVE-GATE vs TAPE"]
deep_laya = VARIANCES["BINANCE 90d LAYA-ONLY vs TAPE"]

print("\n  ── SCENARIO A: the collector's own cluster variance, the CLAIMED effect (0.0752%) ──")
power_curve(ku_live["sd"], [0.0752, 0.05, 0.0376, 0.02, 0.01], [9, 13, 18, 30, 45, 60, 90, 120, 180, 240])

print("\n  ── SCENARIO B: the DEEP sample's cluster variance, the CLAIMED effect and smaller ──")
power_curve(deep_laya["sd"], [0.0752, 0.05, 0.0376, 0.02, 0.01, 0.0042], [20, 45, 91, 180, 360, 720, 1440, 3003])

# ══════════════════════════════════════════════════════════════════════
# 3. REQUIRED CLUSTER COUNT
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("3. THE REQUIRED CLUSTER COUNT for t >= 2 at 80% power")
print("=" * 100)
print(f"\n  {'scenario':<52}{'delta %':>10}{'$/trade':>10}{'n required':>13}{'have':>10}{'shortfall':>12}")

REQ = {}
scenarios = []
for lab, sd, have, have_eff in [
    ("KUCOIN collector LIVE-GATE", ku_live["sd"], ku_live["n"], ku_live.get("n_eff", ku_live["n"])),
    ("KUCOIN collector LAYA-ONLY", VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["sd"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["n"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"].get("n_eff", 1)),
    ("BINANCE 90d LAYA-ONLY", deep_laya["sd"], deep_laya["n"], deep_laya.get("n_eff", deep_laya["n"])),
]:
    for dlabel, delta in [("claimed 0.0752", 0.0752), ("half 0.0376", 0.0376), ("a quarter 0.0188", 0.0188), ("the measured deep 0.0042", 0.0042)]:
        if lab == "BINANCE 90d LAYA-ONLY" and dlabel not in ("claimed 0.0752", "half 0.0376", "the measured deep 0.0042"):
            continue
        n_req = required_n(delta, sd)
        scenarios.append((lab, dlabel, delta, n_req, have))
        short = max(0, (n_req or 0) - have_eff)
        print(f"  {lab + ' @ ' + dlabel:<52}{delta:>10.4f}{dollars(delta):>10.4f}{(n_req if n_req else -1):>13,}{have_eff:>10,.0f}{short:>12,.0f}")
        REQ[(lab, dlabel)] = {"n_req": n_req, "have": have, "have_eff": have_eff}

# ══════════════════════════════════════════════════════════════════════
# 4. CURRENT POWER AND MDE
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("4. THE CURRENT POWER and the MINIMUM DETECTABLE EFFECT")
print("=" * 100)
print(f"\n  {'scenario':<46}{'n (eff)':>10}{'t (raw)':>9}{'t (corr)':>10}{'power@obs':>12}{'MDE %':>11}{'MDE $':>10}")

POWER = {}
for lab, sd, have, obs_t, obs_excess, ck in [
    ("KUCOIN collector LIVE-GATE vs TAPE", ku_live["sd"], ku_live["n"], ku_live["t"], ku_live["excess"], "ku_live"),
    ("KUCOIN collector LAYA-ONLY vs TAPE", VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["sd"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["n"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["t"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["excess"], "ku_laya"),
    ("BINANCE 90d LAYA-ONLY vs TAPE", deep_laya["sd"], deep_laya["n"], deep_laya["t"], deep_laya["excess"], "deep_laya"),
]:
    c = corr[ck]
    n_eff = VARIANCES[lab]["n_eff"]
    mde = mde_at_n(int(n_eff), sd)
    # the power of the test to detect the OBSERVED effect if it were true
    pw_obs = power_at_n(int(n_eff), obs_excess, sd)
    POWER[lab] = {"n": have, "n_eff": n_eff, "sd": sd, "mde": mde, "power_obs": pw_obs,
                  "obs": obs_excess, "t": obs_t, "t_corr": c["ar1_t"], "day_t": c["day_t"]}
    print(f"  {lab:<46}{n_eff:>10,.0f}{obs_t:>9.2f}{c['ar1_t']:>10.2f}{pw_obs:>12.3f}{mde:>11.4f}{dollars(mde):>10.4f}")

# ══════════════════════════════════════════════════════════════════════
# 5. P(THE TRUE EFFECT <= 0)
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("5. THE PROBABILITY THAT THE TRUE EFFECT IS <= 0")
print("=" * 100)
print(f"\n  {'scenario':<46}{'estimate %':>12}{'se (corr) %':>14}{'P(true<=0)':>13}{'half-size P':>13}{'t raw':>7}{'t corr':>8}")

PROBS = {}
for lab, sd, have, obs_t, obs_excess, se, ck in [
    ("KUCOIN collector LIVE-GATE vs TAPE", ku_live["sd"], ku_live["n"], ku_live["t"], ku_live["excess"], ku_live["se"], "ku_live"),
    ("KUCOIN collector LAYA-ONLY vs TAPE", VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["sd"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["n"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["t"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["excess"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["se"], "ku_laya"),
    ("BINANCE 90d LAYA-ONLY vs TAPE", deep_laya["sd"], deep_laya["n"], deep_laya["t"], deep_laya["excess"], deep_laya["se"], "deep_laya"),
]:
    c = corr[ck]
    se_corr = obs_excess / c["ar1_t"] if c["ar1_t"] else se
    p0 = p_true_le_zero(obs_excess, se_corr)
    # if the true effect were HALF the observed size, what is the
    # probability that we would still have concluded "significant"?
    p_half = p_true_le_zero(obs_excess / 2, se_corr)
    pw_half = power_at_n(int(VARIANCES[lab]["n_eff"]), obs_excess / 2, sd)
    PROBS[lab] = {"p0": p0, "p_half": p_half, "power_half": pw_half, "se_corr": se_corr}
    print(f"  {lab:<46}{obs_excess:>12.4f}{se_corr:>14.4f}{p0:>13.4f}{p_half:>13.4f}{obs_t:>7.2f}{c['ar1_t']:>8.2f}")
    print(f"      if the true effect is HALF the observed size: the current test's power to detect it = {pw_half:.3f} "
          f"({pw_half*100:.1f}%)")
    print(f"      the day's own t (the most conservative cluster): {c['day_t']:.2f} | the 24h block bootstrap p: {c['boot_p']:.4f}")

# ══════════════════════════════════════════════════════════════════════
# 6. THE TIME ESTIMATE
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("6. HOW LONG — at the MEASURED collection rate")
print("=" * 100)

# the measured rate: the collector's own sample
ku_rows = ku["rows"]
ku_rounds = ku["rounds"]
ku_span_h = ku["spanH"]
print(f"""
  MEASURED COLLECTION RATE (the collector's own sample):
    {ku_rows:,} rows over {ku_span_h:.2f} h = {ku_rows/ku_span_h:.1f} rows/hour
    {ku_rounds} rounds over {ku_span_h:.2f} h = {ku_rounds/ku_span_h:.2f} rounds/hour
    the collector's cadence is one round every ~5 minutes = 12 rounds/hour

  The ARM's rate, which is what the power calculation needs:
""")

# how many rounds does the arm produce per hour? On the collector's
# sample: the live-gate arm's paired rounds and the loose/laya arm's.
for key, lab, res in [("live", "LIVE-GATE", ku), ("laya", "LAYA-ONLY", ku)]:
    n = res["excess"][f"{key}_vs_tape"]["rounds"]
    # a "paired round" is a round where BOTH arms traded. The rate at
    # which new paired rounds accumulate is what matters.
    print(f"    {lab:<12} {n:>4} paired rounds over {ku_span_h:.2f} h = {n/ku_span_h:.2f} paired rounds/hour")

# the loose arm is the one that is used on the collector, and the deep
# sample's rate
print(f"""
  THE DEEP SAMPLE's rate (an independent venue, 90 days):
    {deep['rounds']:,} rounds over {deep['spanH']/24:.1f} days = {deep['rounds']/deep['spanH']:.2f} rounds/hour
    the LAYA arm's paired rounds: {deep['excess']['laya_vs_tape']['rounds']:,} over {deep['spanH']/24:.1f} days
      = {deep['excess']['laya_vs_tape']['rounds']/deep['spanH']:.2f} paired rounds/hour
""")

# The rate that matters: how fast does the collector accumulate PAIRED
# ROUNDS for the arm? Measured from the collector's own sample.
live_paired_per_h = ku["excess"]["live_vs_tape"]["rounds"] / ku_span_h
laya_paired_per_h = ku["excess"]["laya_vs_tape"]["rounds"] / ku_span_h
loose_paired_per_h = ku["excess"]["loose_vs_tape"]["rounds"] / ku_span_h
print(f"  The arm rates that matter (paired rounds per hour):")
print(f"    LIVE-GATE {live_paired_per_h:.2f}/h | LAYA-ONLY {laya_paired_per_h:.2f}/h | LOOSE {loose_paired_per_h:.2f}/h")

print(f"\n  TIME TO THE REQUIRED CLUSTER COUNT")
print(f"\n  {'scenario':<52}{'delta %':>10}{'n required':>13}{'rate /h':>10}{'hours':>10}{'days':>10}")
TIMES = []
for lab, vkey, sd, have, rate in [
    ("KUCOIN collector LIVE-GATE", "KUCOIN collector LIVE-GATE vs TAPE", ku_live["sd"], ku_live["n"], live_paired_per_h),
    ("KUCOIN collector LAYA-ONLY", "KUCOIN collector LAYA-ONLY vs TAPE", VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["sd"], VARIANCES["KUCOIN collector LAYA-ONLY vs TAPE"]["n"], laya_paired_per_h),
]:
    have_eff = VARIANCES[vkey]["n_eff"]
    for dlabel, delta in [("claimed 0.0752", 0.0752), ("half 0.0376", 0.0376)]:
        n_req = required_n(delta, sd)
        if not n_req:
            print(f"  {lab + ' @ ' + dlabel:<52}{delta:>10.4f}{'unreachable':>13}")
            continue
        need = max(0, n_req - have_eff)
        hours = need / rate if rate > 0 else float("inf")
        TIMES.append((lab, dlabel, delta, n_req, have, have_eff, rate, hours))
        print(f"  {lab + ' @ ' + dlabel:<52}{delta:>10.4f}{n_req:>13,}{rate:>10.2f}{hours:>10.1f}{hours/24:>10.1f}")

# the deep sample's time: it already has 90 days of data, so the
# question is whether MORE 90-day samples are needed
deep_req_measured = required_n(0.0042, deep_laya["sd"])
deep_req_half = required_n(0.0021, deep_laya["sd"])
deep_have_eff = VARIANCES["BINANCE 90d LAYA-ONLY vs TAPE"]["n_eff"]
print(f"\n  THE DEEP SAMPLE already contains {deep['excess']['laya_vs_tape']['rounds']:,} paired rounds "
      f"({deep_have_eff:,.0f} independent after the AR(1) correction).")
print(f"    to detect the effect it measured (+0.0042%) at 80% power: {deep_req_measured:,} independent obs "
      f"-> {'ALREADY EXCEEDED' if deep_have_eff >= deep_req_measured else f'short by {deep_req_measured - deep_have_eff:,.0f}'}")
print(f"    to detect HALF of it (+0.0021%): {deep_req_half:,} independent obs "
      f"-> {'ALREADY EXCEEDED' if deep_have_eff >= deep_req_half else f'short by {deep_req_half - deep_have_eff:,.0f}'}")
if deep_req_half and deep_have_eff < deep_req_half:
    # the deep sample's rate of independent observations per day
    rate_deep = deep_have_eff / (deep["spanH"] / 24)
    print(f"    the deep sample's rate of INDEPENDENT observations: {rate_deep:,.1f}/day")
    print(f"    => {deep_req_half - deep_have_eff:,.0f} more -> {(deep_req_half - deep_have_eff) / rate_deep:,.0f} more DAYS "
          f"= {(deep_req_half - deep_have_eff) / rate_deep / 30.4:,.1f} months")

print(f"\n  (the DEEP sample already has {deep['excess']['laya_vs_tape']['rounds']:,} paired rounds — "
      f"{deep['excess']['laya_vs_tape']['rounds']:,} / {required_n(0.0042, deep_laya['sd']) or 0:,} = "
      f"{(deep['excess']['laya_vs_tape']['rounds']/(required_n(0.0042, deep_laya['sd']) or 1)):.0f}x the requirement "
      f"for detecting the effect it actually measured)")

# ══════════════════════════════════════════════════════════════════════
# 7. THE HALF-SIZE PESSIMISTIC CASE, IN FULL
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("7. THE PESSIMISTIC CASE — the true effect is HALF the observed size")
print("=" * 100)
for lab in POWER:
    d = POWER[lab]
    half = d["obs"] / 2
    n_req = required_n(half, d["sd"])
    print(f"\n  {lab}")
    print(f"    observed excess {fmt(d['obs'])}%  |  half of it {fmt(half)}% = ${dollars(half):.4f}/trade")
    print(f"    independent observations now: {d['n_eff']:,.0f} (from {d['n']:,} paired rounds)")
    print(f"    power to detect the half-size effect now: {power_at_n(int(d['n_eff']), half, d['sd']):.3f}")
    print(f"    n required for 80% power at the half-size effect: {n_req:,}" if n_req else "    n required: unreachable")
    print(f"    P(true <= 0) if the estimate had been the half-size: {p_true_le_zero(half, d['se'] if 'se' in d else d['obs']/d['t_corr']):.4f}")
    print(f"    P(true <= 0) at the observed estimate: {PROBS[lab]['p0']:.4f}")

# ══════════════════════════════════════════════════════════════════════
# 8. THE DOLLARS
# ══════════════════════════════════════════════════════════════════════
print()
print("=" * 100)
print("8. THE NET EXPECTANCY IN DOLLARS AT THE REAL SIZE")
print("=" * 100)
for lab, res, key in [
    ("KUCOIN collector LIVE-GATE vs TAPE", ku, "live_vs_tape"),
    ("KUCOIN collector LAYA-ONLY vs TAPE", ku, "laya_vs_tape"),
    ("BINANCE 90d LAYA-ONLY vs TAPE", deep, "laya_vs_tape"),
]:
    e = res["excess"][key]
    arm_key = "live" if "LIVE" in lab else "laya"
    ev = res["arms"][arm_key]["ev"]
    print(f"\n  {lab}")
    print(f"    arm gross EV            {fmt(ev)}% of equity = ${dollars(ev):+.4f}/trade")
    print(f"    the excess               {fmt(e['excess'])}% of equity = ${dollars(e['excess']):+.4f}/trade")
    print(f"    the fee                  {fmt(-FEE_PCT_EQUITY)}% of equity = ${-FEE_DOLLARS:+.4f}/trade")
    if arm_key == "live":
        print(f"    NET after the fee        {fmt(ev - FEE_PCT_EQUITY)}% of equity = ${dollars(ev - FEE_PCT_EQUITY):+.4f}/trade")
    print(f"    the excess as a fraction of one round trip's fee: {e['excess']/FEE_PCT_EQUITY*100:.1f}%")

# ══════════════════════════════════════════════════════════════════════
# WRITE THE MACHINE-READABLE RESULT
# ══════════════════════════════════════════════════════════════════════
json.dump({
    "equity": EQUITY, "notional": NOTIONAL, "rho": RHO,
    "feePctNotional": FEE_PCT_NOTIONAL, "feePctEquity": FEE_PCT_EQUITY,
    "feeDollars": FEE_DOLLARS, "grossTpDollars": GROSS_TP_DOLLARS,
    "breakEvenWinRate": BREAK_EVEN_WR,
    "variances": VARIANCES,
    "required": [{"scenario": s, "delta": d, "n_required": n, "have": h} for s, l, d, n, h in scenarios],
    "power": POWER,
    "probs": PROBS,
    "times": [{"scenario": s, "delta": d, "n_required": n, "have": h, "have_eff": he, "rate": r, "hours": hrs}
              for s, l, d, n, h, he, r, hrs in TIMES],
}, open(os.path.join(OUT, "power.json"), "w"), indent=2)
print(f"\n  wrote {os.path.join(OUT, 'power.json')}")
