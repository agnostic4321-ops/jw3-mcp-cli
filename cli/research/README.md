# JW3 research scripts

Every script here answers one question and prints its verdict with the
**control it needs** — because the recurring failure mode in this
project was never a bad number, it was a real number measured
*without its baseline*.

## The rule these scripts enforce

> A positive number that is not an **EXCESS over a baseline** is not an
> edge.

The three falsified leads all died the same way: the raw number was
real, and the baseline was bigger. See `docs/research/falsified-leads.md`.

## The scripts

| Script | Question | Verdict |
|---|---|---|
| `hunt-edge.mjs` | Does any kline-only signal family have an edge? | **No** — 0/89 candidates, 0/118 sides with positive taker expectancy over 504 perps × 1,053,582 bars |
| `test-leads.mjs` | Diurnal / funding-OI / lead-lag — the three remaining leads | **No** — see below |
| `collect-funding-oi.mjs` | Forward-collects open interest + funding (no historical endpoint exists) | Running |
| `analyze-funding-oi.mjs` | Does a funding extreme with rising OI predict a move? | **Too little data yet** — 6 rounds; re-tested every 6h |
| `analyze-funding-carry-geometry.mjs` | Can FUNDING CARRY make the geometry candidate net-positive? | **No** — the carry is 0.2-0.8% of the excess; it cannot rescue it |
| `trade-loop.mjs` | Runs the real `jw3 live` path continuously, armed | Running |
| `hf-microstructure.py` | Is there a high-frequency (1–5 min) microstructure edge worth the fee? | **No** — the 1-minute mean-reversion edge is real (t = +40) but is a bid-ask bounce worth **−$0.12/trade**; it vanishes on the bar mid |
| `hf-bounce-audit.py` | Is the 1-minute mean-reversion edge a bid-ask bounce? | **Yes** — trade close +5.8 bps (t = +40) vs bar mid −0.87 bps (t = −6.1); lag-1 autocorrelation −0.157 |
| `hf-bounce-verify.py` | Independent re-implementation of the headline | **Reproduces it** — different code path, hourly clusters: trade close +5.86 bps (t = +30), bar mid −0.87 bps (t = −4.3) |
| `hf-book-signals.py` | Do the collector's own `bookImbalance` / `spreadBps` predict the next 1–5 minutes? | **No** — 0 of 15 signatures clear the cost; an imbalance FLIP is significantly *negative* (t = −2.4) |
| `hf-target-ladder.py` | Does a WIDER target rescue the edge? | **No** — all 27 rows negative; the best is −$0.055/trade at a 1.92% target over 240 minutes |
| `hf-goal-arithmetic.py` | What per-trade edge does $10,000 actually require? | **It is a CAP problem** — $60/$500 are fixed dollars, so the count is 8/day forever; a perfect machine needs **5.7 years**, and the 365-day goal needs a **374–2,465%** win rate |
| `hf-machine-session.py` | What did the machine's own session actually earn? | **Nothing** — 8 trades, $474.51 notional, $0.5694 fees, −$0.5708 realized ⇒ **gross −$0.0014** |
| `gap.mjs` | The beta control for BTC lead-lag, per parameter set | **No edge** — 0 of 19 parameter sets pass, including every "MAKER-VIABLE" row the raw scan printed |
| `sweep_hold.mjs` | Does the diurnal effect survive a longer hold? | **No** — net negative at 7 of 9 hold lengths |
| `paired2.mjs` | The diurnal effect, paired within-day against its own complement | **No** — negative in 2 of 3 blocks |
| `control.mjs` | Lead-lag vs an unconditional long | **No** — the signal is beta |
| `excess.mjs` | Lead-lag excess over the baseline, per block | **No** — 0.46% of the edge is noise |
| `oos2.mjs` | Out-of-sample stability of the lead-lag | **No** — fails the 2/3-blocks bar |
| `regime-excess-test-v2.mjs` | Is the geometry excess in a regime that can be identified in advance? | **No** — a window, not a regime: positive in 1 of 3 chronological blocks, every regime negative out-of-sample, and the excess is below the fee floor |
| `regime-excess-addendum.mjs` | The beta check, leave-one-block-out, the fee floor, and the filter's value | **No** — both arms track the market at r=-0.69/-0.79; no regime filter improves the pooled result |
| `regime-excess-90d-v3.mjs` | The regime question with 90 days of reconstructed tape | **The long side is the only stable structure** — `nearLow` is positive in all 3 thirds and beats the placebo, and the 4.6h sample has zero long rows |
| `live-gate-monitor.mjs` | Is the live-gate candidate judgeable YET — and if not, why not? | **Continuous watch.** Prints the arm's counts, the cluster-corrected excess over the control, the trimmed excess, the per-symbol concentration, the market regime and a plain verdict. Exits 0 always. `--self-test` recomputes the published numbers |
| `regime-excess-study-replica.mjs` | The geometry study's own analyzer, with the network removed | Reproduces the study's positive-but-not-significant excess; used to prove a partial bar cache was distorting both arms |
| `power-analysis.mjs` | Is the live-gate study WORTH CONTINUING, and for how long? | **4 more days, then it stops either way.** The arm's own net EV is **-0.3335 %eq** against a 0.1260 %eq fee floor; the excess is **-0.0558 %eq at t=-1.95**; the power today at the observed effect is **37.6%**; the MDE is **0.0940 %eq** (BELOW the fee floor, so the arm is not blind to a fee-clearing edge). The loss is confirmed at **7 clusters** (~0.5 days) and the 30-cluster house bar is **3.9 days** away at the achieved 6.64 clusters/day. The delegated task that failed had clustered at 5 MINUTES and mis-scaled the se — see `docs/research/the-power-verdict.md` |
| `test-scratch-artefact.mjs` | Was the 90% win rate a BOOKKEEPING ARTEFACT? | **YES** — the take-profit was on the wrong side of the market, so 18 of 22 live-gate trades were scratches. See `docs/research/the-scratch-artefact.md` |
| `test-fixed-ticket.mjs` | With the take-profit beyond the market, does any geometry pay? | **NO** — the shipped ticket's EV is **-0.1713 %eq at the 4-hour holding period** (t=-3.78) for the live-gate arm, against the 0.1260 %eq fee floor. The tape-only control is -0.0478 %eq at 5 minutes and the live-gate arm is worse at every width |
| `test-sweep-selection.mjs` | Are the sweep's passing geometries real, or a SELECTION over the search space? | **NO** — the same sweep with the direction FLIPPED passes **8 of 484** against the real arm's **8 of 484**. Identical: the signal adds nothing over flipping the direction, and the best geometry rests on 3 clusters against a bar of 30 |
| `test-watch-keep.mjs` | Does the watch-pattern keeper repair a drifted pattern and leave a correct one alone? | **YES** — 18/18. It matches a process by its COMMAND (the session id changes on every restart), writes run-scoped patterns, and finds nothing to repair on a second pass |
| `test-event-honesty.mjs` | Do the loop's event names say what actually happened? | **YES** — 23/23. Three failure states, three names; every line carries its run; the run id is findable after a restart |
| `family-verdict.mjs` | Do FIVE structurally different families pay? | **NO** — 58 cells swept, 24 above the fee floor, 2 reach t>=2, **0 beat their own placebo**. The best two (time-of-day 15:00 UTC short, a 16-bar breakout) are the sample's drift: every top cell is a short, and the unconditional short at the same geometry earns the same |
| `family-resolver-test.mjs` | Does the family study's resolver agree with the house's own? | **YES** — 11 checks, and it caught a sign bug in the study's own resolver (a short's win booked as -tp, penalising every short arm by 2x target). The fidelity gate now shows 100% identical outcome and P&L against the house resolver |
| `family-drift-control.mjs` | Is a family's edge its own, or the market's drift? | The control that kills the family result: every top cell is a short, and at 15:00 the placebo's best-of-sweep median is $0.4697 against the real $0.5717 (16th percentile) |
| `test-confidence-threshold.mjs` | Does trading only the TOP N% of candidates — by model agreement, confidence, volume exhaustion, book imbalance or exhaustion depth — pay after the fee? | **NO** — 0 of 20 threshold/filter combinations clear the fee floor, t >= 2, the out-of-sample split AND the 40% single-symbol concentration bar together. The near-misses have a **100% win rate on 8-9 trades**, and every positive excess IMPROVES when the top symbol is dropped, so the thresholds select nothing. See `docs/research/the-confidence-threshold-study.md` |
| `test-wide-ticket.mjs` | Can a WIDE-target, long-hold ticket (a 1-3% target held 4-24 hours) clear the fee floor, and what does the market's adverse-excursion distribution say? | **NO** — 0 of 90 geometries clear the +0.0013% fee floor; the best is -0.0032 %eq at t=-2.32. The MAE is the real answer: the median adverse excursion is **0.74%** and the p90 is **3.61%** at 24h, so a 1-3% target lives INSIDE the market's own noise, and a reachable stop is hit constantly while an unreachable one makes the ticket a drift bet |
| `check-bar-coverage.mjs` | Is the bar cache a study reads CURRENT, or is it silently biasing the sample? | **The check** — it reports each cache's lag, the pairs it cannot resolve, and it SPLITS the stale pairs into the ones the studies READ and the ones nothing reads. A stale cache discards the most recent observations, and the losers resolve LATER than the winners, so it FLATTERS the strategy: the live-gate arm's EV moved from -0.2111% to -0.3362% when the cache was refreshed |
| `decisive/run-decisive.mjs` | THE DECISIVE TEST — is the confirmation layer's edge real, measured with a round-paired estimator on an INDEPENDENT venue? | **NO — it is SIGNIFICANTLY NEGATIVE.** On 90 days of Binance (987,620 rows, 22,068 paired rounds) the tape arm's EV is -0.0238% of equity and the confirmation layer's excess is **-0.0121% at t=-4.01, p=0.0001** (and -0.0287 at t=-6.71 against the disjoint REJECTED arm). The excess is negative in 34 of 91 days against 22 positive, and the day-sign test says the sign is consistent with random. The one-day KuCoin result (+0.2180% at t=2.10) was a window artefact. See `docs/research/the-decisive-test.md` |
| `test-conflict-deep.mjs` | Is there a TRADEABLE sub-state of the CONFLICT — the machine's modal outcome, 32% of the tape's signals? | **YES — the first candidate in this project.** On 90 days of Binance (987,620 rows, 121,856 conflicts, 533 clusters): the conflicts where **the tape says LONG and the models say SHORT, traded the tape's way**, have an excess of **+0.2042% of equity at t=9.55** and an arm's own EV of **+0.1196%** against a 0.1058% fee floor, with **0 sign flips** across the 1h/4h/8h/16h holds, a 6% top-symbol share, both window halves positive, and a size-matched placebo beaten. The tape WINS the conflict on the long side; the models win it on the short side. **Not deployable yet**: it is on Binance with a no-book Laya proxy, and the machine's own venue has 56 such conflicts in 4 clusters. See `docs/research/the-conflict-substate.md` |
| `sweep-corrected.mjs` | The full geometry sweep with the CORRECT fill rule, the correct clustering and both fee schedules | **1,440 geometries; 13 pass at taker fees on the live-gate arm, 0 on the tape arm** — and the passes are a SELECTION, not an edge: `test-sweep-selection.mjs` runs the same sweep with the direction FLIPPED and gets **8 of 484 for the real arm and 8 of 484 for the placebo**. The best geometry rests on **3 independent clusters** against a bar of 30 |
| `test-cluster-width.mjs` | Does the excess survive clustering at the ticket's holding period? | **NO** — the arm's own EV is negative at EVERY width: -0.2931 %eq (t=-2.39) at 5 minutes, -0.1542 (t=-7.09) at 30 minutes, -0.1461 (t=-7.25) at 1 hour, **-0.1702 (t=-3.85) at 4 hours**. The PLACEBO flips sign with the rule, which is the tell that the whole signal was the scratch artefact |
| `test-subset-placebo.mjs` | Does the live-gate arm beat a RANDOM subset of its own shape? | **NO** — its excess is **-0.0981 pp, at the 72.5th percentile** of a size-matched placebo (median -0.1154, p95 -0.0940), so it is indistinguishable from a random subset of its own shape. The 'excess' is the SUBSET ARTEFACT |
| `test-tape-edge.mjs` | Does the TAPE's own exhaustion condition beat a size-matched placebo? | **NO** — the 95% win rate is the market's own drift, not an edge |
| `geo1-widehold.py` / `geo2-maker.py` / `geo3-pair.py` | Can a DIFFERENT ticket geometry clear the fee floor — a wide 1-3% target held 4-24h, a maker-only entry at 0.04%, or a pair/relative trade? | **TWO DECISIVELY NO, ONE A CANDIDATE.** The wide ticket has **no stop that keeps the loss under the target** (p90 MAE 5.03% at 4h, 12.16% at 24h, against a 1-3% target) and **0 of 69 geometries clear the bar** (the best makes +$0.3060 at t=0.55 on 4 clusters). The maker entry is **worse than taker in every row** (adverse selection: −$0.0442 vs −$0.0273) and the fill rate needed is **>100%**. The **pair trade** produced **2 distinct pairs** whose out-of-sample configurations clear the bar (KAS/SPELL +$0.1084 at t=2.08 on 55 clusters; 1000CHEEMS/DOGE +$0.0950 at t=2.04 on 31) at the 1st percentile of a properly-paired placebo — out of a 16,254-configuration search, so a thin margin. See `docs/research/the-other-geometries.md` |
| `test-maker-entry.mjs` | Would a maker-first entry fix the economics? | **NO** — it is a TRAP: the adverse selection ($0.19-0.20 per fill) is 4x the $0.048 fee it saves |
| `test-tighter-stop.mjs` | Does a tighter stop fix the EV? | **NO** — the gain does not survive the trim, and it is monotonically worse on the 515-trade control arm |
| `fee-schedule-comparison.mjs` | What does KuCoin's VOLUME-BASED futures fee schedule cost this account, and would a cheaper venue move the fee floor? | **The fee is NOT the binding constraint.** The account is at **VIP 0** (maker 0.02% / taker 0.06%); the next tier is **$5M of 30-day futures volume = 10,000 days** of trading, and it changes the maker rate by 0.002%/side. The taker round trip **never** falls below 0.05% on KuCoin at any tier; the maker round trip is already 0.040% at VIP 0. Across all 10 CEX venues the base-tier taker round trip spans 0.080%–0.120% — the best perps-wired switch (KuCoin→Binance) saves **$0.0120/ticket, $0.096/day**, against a measured daily loss of $0.5708. The whole fee lever is worth **7.9 pp of win rate**, and the task's "51%" needs a **1:1 ticket**, not the machine's 1:3.36 |
| `orderflow/collect-microstructure.py` | Records the order book at EVENT resolution (KuCoin futures public WS, keyless) — the collector's own 5-minute sampling can never see a tradeable imbalance | The recorder: top-5 book + every public trade + the machine's own imbalance/spread formulas, bucketed to 1 second on the VENUE's clock. **2 REST calls, 0 account calls** |
| `orderflow/analyze-microstructure.py` | Do the six microstructure signals predict the next 1s/5s/15s move — and does the 90th percentile clear the 0.12% fee? | **The signals do not pay.** Measured against a perfect-picker CEILING, a sign-flip control, a 500-draw placebo, and a non-overlapping n. See `docs/research/microstructure-signals.md` |
| `orderflow/microstructure-cost.py` | What does the high-resolution recording cost (rate, disk, CPU)? | The websocket replaces **60 REST calls/min** (the account's ENTIRE budget) with pushes on a separate connection, at ~3% of one core |
| `orderflow/microstructure-summary.py` | The one-page answer | The ceiling, the six signals, the placebo, and the arithmetic |
| `orderflow/microstructure-gates.py` | Is the recording what it claims to be? | **7 fidelity gates** — continuity, trade alignment, monotonicity, the imbalance/spread formula, the contract multiplier, the taker side, and no look-ahead. All pass with zero error |
| `orderflow/microstructure-lookahead-audit.py` | Where does the apparent edge in the un-lagged arm live? | **The edge IS the look-ahead.** 49-61% of the un-lagged large-print move evaporates within one second; the tradeable residual is $0.0068 of gross against a $0.0720 fee |
| `refresh-bars.mjs` | Tops the bar cache up to the PRESENT for the live-gate arm's pairs | Running on demand — a stale cache made the freshest signals unmeasurable (18 of 29) |

### The "what is actually available" study

`docs/research/what-is-actually-available.md` answers the question the
empty signal family raises: **how much more data is needed and how long it
takes, what regime is needed, what the machine should do meanwhile, what
else the collector could measure, and what the arithmetic from $56.89 to
$10,000 actually says.** Its headline numbers:

- **3.4 days** to 30 clusters at the ticket's 4-hour holding period
  (1.1 days at 1 hour) — the arm's rate is 11.3 live-gate rows/hour
- the corrected live-gate arm's expectancy: **−$0.0048/trade** (45 trades,
  22 clusters) — negative on every arm and every estimator
- **the sweep's 20 "candidates" all sit on 2 clusters** — none clears 30
- the long side is **regime-starved, not scarce**: a down window arrives
  every ~1 day, and the tape's long share goes 3.8% → **11.7%** in it
- **5 of the 6 alternative measurements are answerable right now** on
  Binance's keyless REST endpoints, on history that already exists; 4 of
  them are already answered (null or negative). The 1 that is open — the
  **volatility-regime classifier** — costs nothing, because the collector
  already records the ATR it needs
- **$56.89 → $10,000 is 58.3 years** at the best expectancy measured
  anywhere in this project, and **235 years** on that arm's close-confirmed
  number. At the machine's own arm it is **never**
- the recommendation: **pause the live arm, keep the collector** (it uses
  5.3 of the shared 60 venue calls/min)

### The 14-day universe study

| Script | Question | Verdict |
|---|---|---|
| `uni-fetch-tape-source.mjs` | Fetches 1-hour bars WITH VOLUME for the collector's 43 pairs over 14 days | The tape needs volume; the 15-minute cache has none, and the 90-day cache ends before the collector ran |
| `uni-fetch-binance-1h.mjs` | The same window from Binance USDⓈ-M (independent venue, keyless) | The cross-check on KuCoin's 1h bars |
| `uni-study.py` | The 14-day tape, the three ticket arms, and the per-symbol table | The corrected ticket measures 86.3% against an 88.7% break-even — **−$0.0857 a trade** |
| `uni-report.py` | The per-symbol table, the three arms, and the long side's scarcity | 22 symbols have both sides, 0 have long only; the long side is 6.68% starved by `tapeSideOf`'s check order |
| `uni-report2.py` | The selection rules and the half-split out-of-sample test | **No causal threshold rule clears the bar**; a ranking does (+$0.0747/hour, t=4.10) |
| `uni-decisive.py` | Is the ranking a SYMBOL effect or a TIMING effect? | The shuffled-oracle kills the timing story (p=0.024) |
| `uni-falsify.py` | Six falsification attempts on the ranking | All survive: leave-one-out, day replication, reversed ticket, permutation |
| `uni-lookahead-audit.py` | Proves the rules read only the past | 464 (symbol, day) pairs, max error 0.00e+00 |
| `uni-capacity.py` | The $500 / $60 / 8-ticket arithmetic and which 8 | The cap is not the binding constraint; the expectancy is |
| `uni-universe-mismatch.py` | The collector's universe vs the machine's | **Only DOGE is in both** — every symbol the machine fired is outside the measured pool |
| `uni-selfcheck.py` | The fidelity gates (ticket, tape, entry, fee, signs) | The ticket reproduces the 9 real FIRED trades with **zero** error |
| `uni-14day-study.mjs` | Prints the whole answer in order | `node research/uni-14day-study.mjs` |

The findings are in `docs/research/universe-14day.md`, and the lead is
recorded in `docs/research/falsified-leads.md`.

## Running them

They read cached klines from `~/.hermes/cache/scratch/leads/klines`
and fetch from KuCoin's public API. No credentials, no money.

```bash
cd packages/jw3-cli
node research/test-leads.mjs --only diurnal --days 90
node research/gap.mjs
node research/sweep_hold.mjs
node research/analyze-funding-oi.mjs
node research/analyze-funding-carry-geometry.mjs   # the carry on the geometry candidate
node research/test-funding-carry-geometry.mjs      # pins the carry study's algebra
```

### The live-gate monitor

`live-gate-monitor.mjs` is the continuous watch on the machine's own
arm. It reads local files only (never the account), always exits 0, and
ends with a plain verdict on whether the candidate can be judged yet.

```bash
node research/live-gate-monitor.mjs              # the status block
node research/live-gate-monitor.mjs --self-test  # recomputes the published numbers
node research/live-gate-monitor.mjs --json       # machine-readable
```

`--self-test` replays the collector's rows as of the published
snapshot's timestamp against the bar cache as it stood at that moment,
and checks that the published numbers are reproduced exactly. It catches
a regression in the collector or the bar cache. It is anchored to the
cache's right edge on purpose: the bar cache is a rolling window that
other jobs refresh, so an unanchored replay would fail on a cache
refresh rather than on a real regression.

`analyze-funding-carry-geometry.mjs` reads the collector's own output
and the geometry bar cache. It reads the LIVE files by default and
accepts `--confluence`, `--bars` and `--funding` overrides. The frozen
snapshots it was run against are `*.carry-study.*` in the scratch dir.

`gap.mjs`, `sweep_hold.mjs`, `paired2.mjs`, `control.mjs`, `excess.mjs`
and `oos2.mjs` read the kline cache directly. Fetch it first:

```bash
node research/test-leads.mjs --only diurnal --days 90   # populates the cache
```

## What a reader should take away

Six families were measured and falsified with controls: the fade/dip
signal, the five signal families, the confirmation layer, the
multi-day hold, the funding/OI carry, and the geometry candidate. The
funding/OI family is still collecting data and is re-tested every 6
hours with a half-split robustness check.

**The geometry candidate is falsified, and its loss is CONFIRMED.** The
15-agent batch attacked it five independent ways and it failed at every
one: the study is a function of the wall clock (0 of 81 trades had a
complete 4-hour window), the excess decays monotonically as data
accumulates, 88% of the study's arm is a single-model read the live path
refuses outright, 0 of 8 geometries cleared the bar on an independent
venue, and the adversarial review fails the multiple-comparison threshold
(Holm-adjusted p = 0.112). On the machine's own venue and the real gate,
the arm's own EV is **-0.21337% of equity per trade against a 0.12597%
fee floor** — it loses 1.69x the fee — on 5 clusters at 240 minutes,
with every cluster mean negative, at **t = -5.55** against the floor.

So the 30-cluster collection is **stopped, not paused**: a confirmed
loss is a stopping point, and more clusters would only re-establish it.
The evidence gate's refusal now says so in the operator's terms.

**The correct output of the session is zero orders.** That is a
successful result, not a failure to deliver.

## The one live thread

The **conflict candidate** — the conflicts where the tape says LONG and
the models say SHORT, traded the tape's way: +0.2042% of equity at
t = 9.55, arm EV +0.1196% against a 0.1058% fee floor, zero sign flips
across the 1h/4h/8h/16h holds, 1st-percentile against a random-pair
placebo, 6% top-symbol share, both window halves positive.

It is measured on 90 days of **Binance** with a **no-book Laya proxy**,
because JEV does not exist on that venue. So it is a candidate, not a
finding. Its re-measurement on the machine's own venue with the real
JEV+Laya gate at 240-minute clusters is `docs/research/the-conflict-on-kucoin.md`:
after ~26h of collection the verdict is **NOT JUDGEABLE** — 5 independent
clusters against a bar of 30, arm EV -0.4548% against a +0.1270% fee floor,
excess negative at every resolvable hold. Too-small-sample null, not a
contradiction. The collectors keep running because that is what this
candidate needs.

## The other geometries, also measured

| geometry | result |
|---|---|
| wide target (1-3%, 4-24h) | **0 of 69** combinations clear; the p90 MAE (5.03% at 4h, 12.16% at 24h) is larger than the target, so no stop fits |
| maker-only entry | **worse than taker in every row** (-$0.0442 vs -$0.0273); the fill rate needed exceeds 100% |
| pair / relative | 2 pairs pass locally (KAS/SPELL, 1000CHEEMS/DOGE) out of 16,254 configurations; a candidate, not a deployment |
| multi-day hold | **13 of 15 cells lose to a placebo**; the fee never amortises, funding replaces it |

The scripts are in `research/geometry/` and `research/multiday-amortise-*.mjs`;
the write-ups are `docs/research/the-other-geometries.md` and
`docs/research/multiday-amortise.md`.
