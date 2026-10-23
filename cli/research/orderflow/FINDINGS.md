# THE ORDER-FLOW STUDY — what the imbalances actually buy

**Date:** 2026-10-21
**Author:** research
**Scripts:** `packages/jw3-cli/research/orderflow/`
**Data:** KuCoin collector (`~/.hermes/cache/scratch/confluence.ndjson`, frozen) + Binance USDⓈ-M public klines (14 days, 38 symbols, keyless, no account call)

---

## 0. THE HEADLINE

**The strongest order-flow signal found is NOT the book imbalance. It is the tape's own
exhaustion read, and the order-flow proxies ADD NOTHING to it.**

| arm | n | win% | EV $/trade | BE-WR | excess $/trade | t | clusters | day-boot p |
|---|---|---|---|---|---|---|---|---|
| **EXHAUSTION (the tape's side)** | 9,861 | 90.0% | **+$0.0554** | 85.3% | **+$0.10576** | **13.95** | 3,071 | 0.000 |
| EXHAUSTION + taker flow AGREES | 4,278 | 89.8% | +$0.0491 | 84.4% | +$0.09331 | 9.43 | 1,900 | 0.000 |
| EXHAUSTION but taker flow DISAGREES | 4,157 | 90.7% | +$0.0580 | 84.8% | +$0.11602 | 11.37 | 1,911 | 0.000 |
| TFI ≥ +0.15 → LONG (taker buying) | 9,743 | 87.8% | +$0.0148 | 84.9% | +$0.07026 | 10.15 | 2,930 | 0.000 |
| VWAP gap ≥ +0.15% → SHORT (paid up) | 15,656 | 88.3% | +$0.0276 | 85.7% | +$0.05555 | 9.75 | 3,476 | 0.000 |
| VWAP gap ≤ −0.15% → LONG (washed out) | 15,750 | 88.1% | +$0.0211 | 86.0% | +$0.05120 | 8.36 | 3,502 | 0.000 |
| SURGE ≥ 1.5x DOWN bar → LONG | 9,345 | 90.5% | +$0.0584 | 85.7% | +$0.05836 | 7.03 | 2,517 | 0.000 |
| TFI ≤ −0.15 → SHORT (taker selling) | 11,324 | 86.2% | −$0.0095 | 85.6% | +$0.05322 | 7.90 | 3,037 | 0.000 |

The order-flow arms all beat their control, but so does plain exhaustion — and the
flow-conditioned version of exhaustion is **not better** than exhaustion alone
($0.0491 vs $0.0554; the "disagrees" arm is actually *higher* at $0.0580). The flow adds
no filter value.

---

## 1. A DEGENERACY FOUND FIRST, WHICH CHANGES EVERY NUMBER

### The ticket's take-profit is anchored on a price the market never traded at

The live path places a **market** order (`src/commands/live.ts:256`, `type: "market"`)
and arms its exits with `referencePrice = sizing.entryPrice = avgEntry`
(`src/commands/live.ts:874`). The venue rebases the legs onto the actual fill, keeping
each leg's **distance** from that reference.

The research script `live-gate-ev.mjs` resolves the ticket at the **avgEntry-anchored
level**, not at the fill.

For a SHORT, `avgEntry` sits **above** the market by `d/200` (0.27%–0.75% for ATR
0.6%–1.5%), while the take-profit distance is only `tpPct` (0.32%–0.48%). So the
anchored TP lands **on or above the market price** — the target is already satisfied the
instant the trade opens, and the first forward bar's high/low touches it.

Measured on the deep dataset (153,216 observations):

| | median distance from market to TP | TP on the wrong side of the price | resolved on bar 0 |
|---|---|---|---|
| research ticket, long | −0.11% | **100.0%** | 81.3% |
| research ticket, short | −0.10% | **97.6%** | 78.7% |
| market-anchored ticket | +0.347% | 0.0% | — |

**This is not a hypothesis.** The venue's own code records the failure happening live
(`src/commands/live.ts:862-870`):

> Observed live on 2026-10-21: an AVAX short whose reference was 9.7895 filled at
> 9.754, so the take-profit (0.32% below the reference) sat 0.04% ABOVE the fill and the
> st-order filled instantly, closing the position 7 seconds after opening.

### What it does to the numbers

On the deep dataset the research ticket shows a **98.3% win rate in BOTH directions**,
while 29 of 38 symbols FELL over the window (median per-symbol change −7.25%). A ticket
that wins 98% of the time regardless of direction is not measuring an edge — it is
measuring the anchor.

With the **market-anchored** ticket (the venue's actual rebase), the same arms show
**85–90%** win rates and real, sign-sensitive excesses.

### The cited baseline is affected

The cited 11-trade baseline reproduces **exactly** with the research ticket
(11 resolved, 11 wins, EV +0.3249% of equity, excess +0.0752%, t=3.15, 9 clusters —
verified in `reconcile.mjs`). With the market-anchored ticket the same 11 rows give
**100% win rate but 36.4% time exits** and EV **+$0.0971 (+0.1699% of equity)**, with
the excess t dropping to **1.99** from 3.15.

`calibrate.mjs` reproduces the cited baseline to the digit, so the harness is sound.
The finding is about the ticket, not the measurement.

---

## 2. THE FOUR QUESTIONS, ANSWERED

### (1) The book imbalance as a predictor of the next 15m / 1h / 4h move

The collector's `bookImbalance` = `(bid5Usd − ask5Usd)/(bid5Usd + ask5Usd)`
(`src/commands/decide.ts:186-194`). Span: **2026-10-21T07:37:30Z → 13:27:11Z, 1,819
rows, 43 symbols, 61 rounds (7 hours)**.

Control: the same population, same direction, paired by cluster. Sign-flip control
beside it. Placebo and day-block bootstrap on the trade arms.

**As a forward-return predictor — a PATTERN, not a finding:**

| condition | n | clusters | excess @15m | t | excess @60m | t | excess @240m | t |
|---|---|---|---|---|---|---|---|---|
| imb ≥ +0.3 → LONG | 333 | 52 | +0.0313% | 0.32 | **+0.4617%** | **2.34** | +0.0401% | 0.05 |
| imb ≤ −0.3 → SHORT | 366 | 46 | +0.0801% | 1.08 | +0.8516% | 1.61 | +0.2415% | 0.26 |
| imb ≥ +0.5 → LONG | 210 | 48 | +0.0895% | 0.67 | **+0.5863%** | **2.68** | +0.5980% | 0.38 |
| imb ≤ −0.5 → SHORT | 247 | 46 | +0.0916% | 1.17 | +0.3735% | 0.99 | +0.0587% | 0.04 |

Only two cells reach t ≥ 2, both at the 60-minute horizon, and the 240-minute horizon
collapses to **3 clusters** (the data simply does not reach 4 hours). The sign-flip
control is the mirror image in every case (−0.0313% / t=−0.32 etc.), which is what
makes the excess readable at all — but with 7 hourly clusters the t is not trustworthy.

**With the exhaustion condition — the imbalance does NOT help:**

| condition | n | clusters | excess @15m | t | excess @60m | t |
|---|---|---|---|---|---|---|
| EXHAUSTION alone | 703 | 60 | −0.1175% | **−2.22** | −0.5057% | **−3.26** |
| EXHAUSTION + imb agrees (\|imb\| ≥ 0.3) | 116 | 42 | −0.0728% | −1.14 | −0.3264% | −1.92 |
| EXHAUSTION + imb agrees (\|imb\| ≥ 0.5) | 66 | 34 | −0.0801% | −1.06 | −0.3945% | −1.81 |

Adding the imbalance **weakens** the signal at every threshold. Symbol concentration
also degrades badly: JASMY alone is **18.1%** of the 0.3 arm and **25.8%** of the 0.5
arm (11–13 distinct symbols).

### (2) Does a large imbalance predict a REVERSAL rather than a continuation?

**No.** The continuation and reversal excesses are exact mirrors, because they are the
same rows scored in opposite directions — so the comparison is a clean sign test of
which direction the arm actually has.

| condition | n | clusters | continuation excess (t) | reversal excess (t) |
|---|---|---|---|---|
| imb ≥ +0.5 @15m | 210 | 48 | +0.0895% (0.67) | −0.0895% (−0.67) |
| imb ≥ +0.7 @15m | 122 | 42 | +0.1987% (1.07) | −0.1987% (−1.07) |
| imb ≥ +0.5 @60m | 155 | 41 | +0.5863% (2.68) | −0.5863% (−2.68) |
| imb ≥ +0.7 @60m | 90 | 33 | +0.4933% (1.92) | −0.4933% (−1.92) |

The largest imbalance leans **with** the price, not against it, and the lean is
**weak** (t = 0.67–2.68, 41–48 clusters). **Adverse selection is NOT present in the
resting book at this horizon.** The mirror symmetry also means none of these arms
survives a sign test at t ≥ 2 with any power.

**As a trade** (market-anchored ticket, dollars):

| arm | n | win% | EV $ | excess | t | clusters |
|---|---|---|---|---|---|---|
| imb ≥ +0.3 → LONG | 300 | 85.0% | −$0.1143 | +2.18% equity | 0.56 | 49 |
| imb ≤ −0.3 → SHORT | 345 | 87.1% | −$0.0207 | +4.77% equity | 2.27 | 45 |
| imb ≥ +0.5 → LONG | 189 | 83.6% | −$0.1263 | +1.80% equity | 0.40 | 44 |
| imb ≤ −0.5 → SHORT | 231 | 86.0% | −$0.0206 | +5.35% equity | 2.00 | 45 |

**Every book-imbalance arm has a NEGATIVE absolute EV.** The excess is positive only
against a control that is also negative. The book imbalance does not pay for itself.

### (3) Does the imbalance diverge from the price move? (the exhaustion signature)

The hypothesis: a price that rises while the book leans short is exhaustion.

**As a forward-return predictor:**

| condition | n | clusters | excess @15m | t | excess @60m | t |
|---|---|---|---|---|---|---|
| DIVERGENCE: price UP, book SHORT → LONG | 344 | 46 | −0.0101% | −0.18 | −0.7295% | −1.37 |
| CONVERGENCE (control): price UP, book LONG → LONG | 305 | 49 | **+0.1445%** | **2.17** | +0.3145% | 1.39 |

**The divergence is worse than the convergence, and the convergence is the only cell
that reaches t ≥ 2.** The exhaustion signature as stated is **not there** — the book
leaning against a rising price does not predict a reversal; the book leaning **with**
it does.

**As a trade** (the same rows, dollars):

| arm | n | win% | EV $ | excess | t | clusters |
|---|---|---|---|---|---|---|
| DIVERGENCE price UP + book SHORT → LONG (\|imb\|≥0.3) | 327 | 80.5% | −$0.1586 | −1.00% equity | −0.30 | 45 |
| DIVERGENCE price UP + book SHORT → LONG (\|imb\|≥0.5) | 219 | 82.1% | −$0.1537 | +0.23% equity | 0.06 | 45 |
| CONVERGENCE price UP + book LONG → LONG (\|imb\|≥0.3) | 280 | 87.9% | −$0.0853 | +3.75% equity | 1.04 | 47 |
| CONVERGENCE price UP + book LONG → LONG (\|imb\|≥0.5) | 176 | 87.1% | −$0.0921 | +3.48% equity | 0.87 | 43 |

**Every divergence arm loses money in absolute terms.** The "price up, book short"
pattern has an 80.5% win rate against a 86.0% break-even. It is a losing trade.

### (4) Trade-flow proxies: volume surge against price direction, and the VWAP gap

Measured on **Binance USDⓈ-M, 14 days, 38 symbols, 151,848 joined observations on a
5-minute grid, 3,996 rounds (15 days), 333 hours** — keyless public klines, no account
call. Resolved on 5-minute bars with a 240-minute hold. **Portfolio-constrained** (one
open position per symbol), so the numbers are achievable.

**The volume surge, both directions:**

| arm | n | win% | EV $ | BE-WR | excess $ | t | clusters | trim t | boot p |
|---|---|---|---|---|---|---|---|---|---|
| SURGE≥1.5x UP bar → LONG (continuation) | 16,026 | 80.5% | **−$0.0852** | 85.4% | −$0.06923 | **−9.84** | 3,339 | −9.91 | 0.000 |
| SURGE≥1.5x UP bar → SHORT (exhaustion) | 16,026 | 86.3% | −$0.0066 | 85.7% | −$0.05128 | **−7.68** | 3,339 | −7.72 | 0.000 |
| SURGE≥1.5x DOWN bar → SHORT (continuation) | 22,233 | 85.4% | −$0.0139 | 85.1% | −$0.00295 | −0.58 | 3,417 | −0.51 | 0.594 |
| **SURGE≥1.5x DOWN bar → LONG (exhaustion)** | 9,345 | **90.5%** | **+$0.0584** | 85.7% | **+$0.05836** | **7.03** | 2,517 | 7.17 | 0.000 |
| SURGE≥2.5x UP bar → LONG | 6,633 | 76.2% | −$0.1427 | 85.5% | −$0.08844 | −9.37 | 2,484 | −9.42 | 0.000 |
| SURGE≥2.5x DOWN bar → SHORT | 9,027 | 82.2% | −$0.0539 | 85.4% | −$0.02836 | −3.72 | 2,505 | −3.71 | 0.106 |

**A volume surge on an UP bar is a continuation signal that LOSES badly** (t = −9.84) —
volume confirms a rally that keeps going, and fading it costs. **A volume surge on a
DOWN bar is an exhaustion signal that PAYS** (t = +7.03, EV +$0.0584): a high-volume
sell-off that has already happened is a long. The asymmetry is large and consistent:
the same 1.5x surge is worth −$0.069 (going long) versus +$0.058 (going long on the
down bar).

**The VWAP gap:**

| arm | n | win% | EV $ | BE-WR | excess $ | t | clusters | trim t | boot p |
|---|---|---|---|---|---|---|---|---|---|
| **VWAP gap ≥ +0.15% → SHORT (paid up)** | 15,656 | 88.3% | **+$0.0276** | 85.7% | **+$0.05555** | **9.75** | 3,476 | 9.93 | 0.000 |
| VWAP gap ≤ −0.15% → LONG (washed out) | 15,750 | 88.1% | +$0.0211 | 86.0% | +$0.05120 | 8.36 | 3,502 | 8.51 | 0.000 |
| VWAP gap ≥ +0.3% → SHORT | 14,907 | 87.2% | +$0.0135 | 85.6% | +$0.01202 | 1.86 | 3,462 | 1.93 | 0.094 |
| VWAP gap ≤ −0.3% → LONG | 13,497 | 86.9% | +$0.0035 | 85.9% | +$0.00711 | 0.96 | 3,402 | 1.04 | 0.377 |

**The VWAP gap works in BOTH directions** — a close above the bar's VWAP (the late
trades paid up) is a short; a close below it (washed out) is a long. Both reach t ≥ 8
over 3,476+ clusters with a day-block bootstrap p of 0.000. This is the most
**symmetric** order-flow signal found, and the one most likely to be a real edge.

**The trade-flow imbalance (taker buy/sell share):**

| arm | n | win% | EV $ | BE-WR | excess $ | t | clusters | trim t | boot p |
|---|---|---|---|---|---|---|---|---|---|
| TFI ≤ −0.15 → SHORT | 11,324 | 86.2% | **−$0.0095** | 85.6% | +$0.05322 | 7.90 | 3,037 | 8.06 | 0.000 |
| TFI ≥ +0.15 → LONG | 9,743 | 87.8% | +$0.0148 | 84.9% | +$0.07026 | 10.15 | 2,930 | 10.35 | 0.000 |
| TFI ≤ −0.3 → SHORT | 20,403* | 87.3% | −$0.0011 | 84.6% | +$0.01544 | 4.79 | 3,837 | 5.06 | 0.003 |
| TFI ≥ +0.3 → LONG | 17,319* | 84.7% | −$0.0279 | 83.6% | +$0.00348 | 1.00 | 3,681 | 1.17 | 0.335 |

(*unconstrained counts; the portfolio-constrained counts are the 9,743 / 11,324 above)

**The asymmetry is stark: taker BUYING is profitable (+$0.0148), taker SELLING is not
(−$0.0095)** — despite the market falling over the window (29 of 38 symbols down,
median −7.25%). That is the opposite of the drift, and it is the one place where the
signal's direction contradicts the market's. The excess over the always-short control
is large (t = 7.90) precisely because the drift works against it.

---

## 3. THE DOLLARS AT THE REAL SIZE

- equity **$57.16**, notional **$60.00**, exposure **1.0497x**
- taker round trip **0.12% of notional = $0.0720** per ticket
- the fee is **~26–28% of the gross win** on these tickets (the prompt's 40% applies to
  the $0.18 gross take-profit of the narrower geometry)
- break-even win rate on the market-anchored ticket: **84.5–86.1%**

| arm | win% | BE-WR | cushion | EV $/trade | 14-day portfolio total |
|---|---|---|---|---|---|
| EXHAUSTION | 90.0% | 85.3% | **+4.7pp** | +$0.0554 | +$545.94 |
| SURGE≥1.5x DOWN → LONG | 90.5% | 85.7% | +4.8pp | +$0.0584 | +$546.07 |
| VWAP gap ≥ +0.15% → SHORT | 88.3% | 85.7% | +2.6pp | +$0.0276 | +$432.23 |
| VWAP gap ≤ −0.15% → LONG | 88.1% | 86.0% | +2.1pp | +$0.0211 | +$332.92 |
| TFI ≥ +0.15 → LONG | 87.8% | 84.9% | +2.9pp | +$0.0148 | +$143.83 |
| TFI ≤ −0.15 → SHORT | 86.2% | 85.6% | **+0.6pp** | −$0.0095 | −$107.46 |

**The cushion is 0.6–4.8 percentage points.** At $60 notional on this ticket a 1pp
change in win rate is worth **$0.0139** per trade (0.01 × (win − loss) = 0.01 ×
($0.2044 + $1.1863)). The whole edge sits inside that margin.

---

## 4. WHAT SURVIVES, AND WHAT DOES NOT

**SURVIVES (all criteria met: excess > 0, t ≥ 2, n ≥ 30 independent clusters, trim-stable,
placebo passes, day-block bootstrap p = 0.000, symbol concentration < 7%):**

1. **EXHAUSTION (the tape's side)** — n=9,861, win 90.0%, EV **+$0.0554**, excess
   **+$0.10576**, **t = 13.95** over 3,071 clusters, trim t = 14.17, placebo 26/500 runs
   |t| ≥ 2, day-boot p = 0.000, largest symbol JCT 6.6%.
2. **SURGE ≥ 1.5x on a DOWN bar → LONG** — n=9,345, win 90.5%, EV **+$0.0584**, excess
   **+$0.05836**, **t = 7.03** over 2,517 clusters, trim t = 7.17, placebo 22/500,
   day-boot p = 0.000, largest symbol SOPH 4.2%.
3. **VWAP gap ≥ +0.15% → SHORT** — n=15,656, win 88.3%, EV **+$0.0276**, excess
   **+$0.05555**, **t = 9.75** over 3,476 clusters, trim t = 9.93, placebo 19/500,
   day-boot p = 0.000, largest symbol ICNT 6.5%.
4. **VWAP gap ≤ −0.15% → LONG** — n=15,750, win 88.1%, EV **+$0.0211**, excess
   **+$0.05120**, **t = 8.36** over 3,502 clusters, trim t = 8.51, placebo 16/500,
   day-boot p = 0.000, largest symbol JCT 6.2%.
5. **TFI ≥ +0.15 → LONG** — n=9,743, win 87.8%, EV **+$0.0148**, excess **+$0.07026**,
   **t = 10.15** over 2,930 clusters, trim t = 10.35, placebo 28/500, day-boot p = 0.000,
   largest symbol ZK 3.6%.

**DOES NOT SURVIVE:**

- **The book imbalance, in every form.** As a predictor it reaches t ≥ 2 only in two
  cells, both at the 60-minute horizon with 6 hourly clusters. As a trade, every
  imbalance arm has a **negative absolute EV**; the positive excess is against a control
  that is also negative. It also **weakens** the exhaustion signal when added to it
  (t = −2.22 → −1.14 at 15m, −3.26 → −1.92 at 60m).
- **The divergence signature** (price up, book short). Excess is negative or zero in
  every form, and the absolute EV is −$0.15.
- **Volume-surge continuation** (a big-volume up bar, going long). Strongly NEGATIVE:
  t = −9.84.
- **TFI ≤ −0.15 → SHORT.** Positive excess (t = 7.90) but **negative absolute EV**
  (−$0.0095) and only a 0.6pp cushion over break-even.
- **The flow-conditioned exhaustion arm.** Exhaustion alone ($0.0554) beats
  exhaustion + flow agreeing ($0.0491). The filter makes it worse.

---

## 5. THE CAVEATS THAT DOMINATE

1. **The anchor.** Every number above uses the market-anchored ticket. The research
   script's ticket inflates the win rate to 98% in both directions by putting the
   take-profit on the wrong side of the market. **The cited 11-trade baseline is
   affected**: its excess t drops from 3.15 to 1.99 under the faithful ticket. The
   baseline's 11 trades also remain 4 symbols (XAN 45.5%) and 100% short.
2. **A single-direction sample is a tautology.** The exhaustion arm is **92% short**
   (56,748 short / 4,776 long) in a window where 29 of 38 symbols fell. The excess is
   therefore measured against an **always-short** portfolio control, which is the
   market's own drift in ticket form (EV −$0.0321/trade over 27,611 trades). That
   control is the strict one, and the arm still clears it at t = 13.95.
3. **The wick problem.** **4,026 of 8,654** exhaustion wins (46.5%) touched the target
   only on the bar's high/low and never on its close. A market order may not have got
   that fill. Booking those as time exits at the mark instead drops the win rate from
   90.0% to **77.7%** — **below the 84.6% break-even**. The headline EV is unchanged
   ($0.0145) only because the time exit is booked at the bar's close and the close is
   usually still on the profitable side of the target; **the win RATE is what breaks**,
   and the win rate is what the fee floor is judged on.
4. **The edge is the ticket's geometry, not a directional forecast.** The exhaustion
   arm's forward return at 15m and 60m is **worse** than the unconditional control
   (t = −2.22 and −3.26). It makes money because the ticket wins small and loses large
   (≈1:3.4 R:R), not because the direction is right.
5. **The deep data is Binance, the machine trades KuCoin.** The 14-day arms are
   measured on an independent venue's public klines with a reconstructed tape; the
   book imbalance exists only on KuCoin for 7 hours. The two are not the same feed.
6. **Symbol concentration.** Largest symbol share: ZK 3.2%, JCT 6.6%, ICNT 6.5%,
   XAN 4.3%. No single name carries any arm — but the KuCoin machine's own arm remains
   4 symbols with XAN at 45.5%.

---

## 6. WHAT THIS SUGGESTS NEXT

1. **Fix the anchor in the research scripts** (`live-gate-ev.mjs` and everything that
   reuses its ticket). Until the ticket is resolved from the market fill, every
   win rate in this project is inflated.
2. **The VWAP gap is the most promising NEW signal** — symmetric in direction,
   t ≥ 8 in both, and it is not a function of the tape. It deserves its own
   confirmation layer on the KuCoin collector (which records `bookMid` and could
   record the bar's VWAP).
3. **Do not add the book imbalance to the gate.** It measurably hurts.
4. **The volume-surge exhaustion reading is worth testing on the live tape** — a
   high-volume down bar that has already happened.
5. **Get a close-confirmed fill model.** 46.5% of wins are wick-only, and the
   close-confirmed win rate (77.7%) is below break-even. This is the single largest
   open risk in the ticket.

---

## 7. REPRODUCTION

```
cd packages/jw3-cli/research/orderflow
node calibrate.mjs        # reproduces the cited baseline: 11/11 wins, EV +0.3249%, excess +0.0752%, t=3.15, 9 clusters
node reconcile.mjs        # explains the 11 vs 18 trade difference (7 rows had no forward bars at the baseline run)
node deg-audit.mjs        # the TP-anchor degeneracy: 98% win rate in BOTH directions, 79-81% resolve on bar 0
node deg2-machine-arm.mjs # both tickets on the machine's own arm
node orderflow-final.mjs  # tests 1-3: the predictor arms with the sign-flip and the trim
node collector-trades.mjs # the collector's book imbalance as a trade, in dollars
node portfolio.mjs        # the deep arms, portfolio-constrained, with the placebo and the day-block bootstrap
```

All scripts are read-only. The only network access is Binance's keyless public kline
and depth endpoints (`fapi.binance.com`), on a separate IP budget from the account's
venue. No account call, no KuCoin call, no venue write.
