/**
 * THE GEOMETRY STUDY — can this machine's ticket ever clear break-even?
 *
 * ── WHY THIS IS THE MOST IMPORTANT STUDY YET ──
 *
 * Everything measured so far has been a FORWARD RETURN at a fixed
 * horizon (1 hour). That is a research metric, not a trade outcome.
 * A trade's outcome is decided by two prices: does it hit the TARGET
 * first, or the STOP first?
 *
 * And the live ticket's geometry is brutal:
 *
 *   TP   = clamp(ATR * 0.4, 0.3%, 0.5%)   → at most 0.5%
 *   STOP = ATR-driven (the fee floor widens it) → typically 1.2%
 *
 * So the shipped ticket is about 1:3.4 reward-to-risk, and its
 * break-even win rate is 78.7%. Measured on the machine's OWN signal
 * (the control arm: tape and models agreeing), the 1-hour forward win
 * rate was 66.7% — twelve points BELOW break-even.
 *
 * So the honest question is not "is there an edge" but:
 *
 *   FOR WHICH (target, stop) GEOMETRY does the machine's own signal
 *   clear break-even?
 *
 * That question has a definite, computable answer, and this study
 * computes it by SIMULATING the actual ticket outcome: for each
 * observation, walk the forward bars and see which level is touched
 * first.
 *
 * ── THE MEASUREMENT ──
 *
 * For each observation in the CONTROL arm (tape and models agreeing —
 * the machine's own signal) and each (TP, SL) geometry:
 *
 *   - walk the bars after the observation
 *   - if the bar's range touches the TARGET and not the STOP → a win
 *   - if it touches the STOP and not the TARGET → a loss
 *   - if it touches BOTH → AMBIGUOUS, resolved CONSERVATIVELY as a loss
 *     (the same tie handling the backtest uses — an ambiguous bar is
 *     never counted as a win)
 *   - if neither is touched within the horizon → unresolved, and it is
 *     EXCLUDED from the win rate but reported, because excluding
 *     unresolved bars is exactly the "selected sample" trap
 *
 * Then the expectancy is computed at the ticket's REAL proportions:
 * the target and stop are percentages of the entry, the fee is the
 * taker round trip on the notional, and the notional is a fixed
 * fraction of equity. Break-even win rate is derived from those same
 * numbers, so the two can never be compared on different bases.
 *
 * THE CONTROLS, unchanged:
 *   - the unconditional baseline: the same geometry on the SAME symbols
 *     and windows with NO signal
 *   - the reversed direction: the same geometry, the opposite side
 *
 * A geometry that only looks good against a rising market is beta.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const IN = join(HOME, ".hermes/cache/scratch/confluence.ndjson");
const CACHE_FILE = join(HOME, ".hermes/cache/scratch/geometry-bars.json");

/** The taker round trip, in %, charged on the notional. */
const TAKER_RT = 0.12;
/** The bar interval, in minutes. KuCoin's granularity is in MINUTES. */
const BAR_MIN = 15;
/** How long a trade is held before it is called unresolved, in bars. */
const MAX_HOLD_BARS = 16; // 4 hours at 15-minute bars
/** The lookback for the bars, in minutes. */
const CACHE_MIN = 4320; // 3 days
/**
 * The CLUSTER size for the effective-sample-size correction: the
 * collector samples every 5 minutes, so all the symbols read in one
 * 5-minute window share a market state and their forward returns are
 * correlated. One cluster per 5-minute bucket.
 */
const BUCKET_MS = 5 * 60_000;
/**
 * THE CLUSTER BAR — the number of independent clusters an arm needs
 * before its verdict counts. This is the same bar the live evidence
 * gate applies (30 independent clusters at the ticket's holding
 * period).
 */
const MIN_CLUSTER_BAR = 30;
/**
 * THE INDEPENDENT UNIT IS THE TICKET'S HOLDING PERIOD, NOT THE
 * COLLECTOR'S CADENCE. The 5-minute bucket above is the CORRELATION
 * correction — several symbols read in the same 5-minute window share
 * a market state — but it is NOT the independent sample. Two signals
 * inside one 4-hour hold share the same entry, the same path and the
 * same exit, so they are ONE trade seen twice.
 *
 * A script that reports a verdict on 5-minute buckets reports it on
 * ~48x the apparent sample. The house rule is the ticket's full holding
 * period: 16 bars x 15 minutes = 240 minutes.
 */
const HOLD_MINUTES = MAX_HOLD_BARS * BAR_MIN; // 240
const HOLD_BUCKET_MS = HOLD_MINUTES * 60_000;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

/**
 * The geometries to test. The first is the SHIPPED ticket's geometry
 * (the TP and stop the live path actually produces); the rest are the
 * candidates worth testing.
 *
 * `tp` and `sl` are PERCENTAGES of the entry price. `tp: null` means
 * "derive it from ATR, exactly as the live path does".
 */
const GEOMETRIES = [
  { name: "SHIPPED (TP=0.4xATR capped 0.5%, SL=ATR)", tp: null, sl: null, shipped: true },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2%  SL 0.8%", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

// ── the venue ──
async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

const CACHE = {};
let CACHE_OLDEST = 0;

async function barsFor(pair, needUntilMs) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const now = Date.now();
  const cached = CACHE[pair] ?? [];
  const newest = cached.length ? cached[cached.length - 1].t : 0;
  if (cached.length && newest >= needUntilMs) return cached;

  const from = Math.min(now - CACHE_MIN * 60_000, (CACHE_OLDEST || now) - 3600_000);
  const out = [];
  let cursor = now;
  let guard = 0;
  // KuCoin returns AT MOST 200 bars per query — the most recent 200 in
  // the range — so the page size must be 200 BARS, not 200 hours. With
  // 15-minute bars, 200 bars is 50 hours, and a 200-HOUR page silently
  // returned a 2-day-stale window. The page length is therefore
  // BAR_COUNT * the bar interval.
  const PAGE_MS = 200 * BAR_MIN * 60_000;
  while (cursor > from && guard++ < 30) {
    const hi = Math.min(cursor, now);
    const lo = Math.max(from, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    let d;
    try {
      d = await futJson(
        `/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`,
      );
    } catch {
      break;
    }
    const rows = Array.isArray(d) ? d : [];
    if (!rows.length) break;
    for (const row of rows) {
      // [time, open, high, low, close, volume]
      out.push({ t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    }
    cursor = lo - 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  const merged = new Map();
  for (const b of cached) merged.set(b.t, b);
  for (const b of out) merged.set(b.t, b);
  const all = [...merged.values()].sort((a, b) => a.t - b.t);
  CACHE[pair] = all;
  return all;
}

// ── the statistics ──
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const tstat = (d) => {
  const s = se(d);
  return s > 0 ? mean(d) / s : 0;
};

/**
 * The trade outcome for one observation at one geometry.
 *
 * `long` means the trade is LONG (buys at the entry, sells at the
 * target). Walks the forward bars and returns:
 *   "win"  the target was touched first
 *   "loss" the stop was touched first, or the bar touched BOTH
 *           (AMBIGUOUS, resolved conservatively as a loss)
 *   null   neither was touched within the hold window
 */
function outcome(bars, ts, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  // The first bar at or after the observation.
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > ts) { start = i; break; }
  }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + MAX_HOLD_BARS);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return "loss"; // AMBIGUOUS -> conservative
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  // Neither level was reached. In a LIVE run this trade is STILL OPEN —
  // the live path has no time exit, so it holds margin indefinitely.
  //
  // Counting it as "unresolved" and dropping it would be the selected-
  // sample trap: the trades that DO resolve are exactly the ones that
  // moved far enough to hit a level, and at a wide stop that is a
  // 100%-win subset.
  //
  // So the study models the TIME EXIT explicitly: the trade is closed
  // at the horizon's close and booked at the mark-to-market. That is
  // the P&L a real run with a time exit would produce, and it is the
  // only way to compare geometries on the same basis.
  const last = bars[end - 1];
  if (!last) return null;
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", movePct: move * 100 };
}

/**
 * The expectancy, in % of equity, for a win rate at one geometry.
 *
 * `notionalOverEquity` is the ticket's exposure relative to equity.
 * The target and stop are percentages of the ENTRY, so they are
 * percentages of the notional, which is a fixed fraction of equity.
 */
function expectancyPctEquity(winRate, tpPct, slPct, notionalOverEquity) {
  const win = winRate * tpPct * notionalOverEquity;
  const loss = (1 - winRate) * slPct * notionalOverEquity;
  const fee = TAKER_RT * notionalOverEquity;
  return win - loss - fee;
}

/**
 * The win rate at which the expectancy is exactly zero.
 *
 * The fee CANCELS out of the tp+sl term:
 *   w*tp - (1-w)*sl - fee = 0  =>  w*(tp+sl) = sl + fee
 *   => w* = (sl + fee) / (tp + sl)
 *
 * The previous form had the fee in the denominator as well, which
 * understated the required win rate by 4.6-7.7 percentage points — the
 * wrong direction, because it makes a losing geometry look closer to
 * viable than it is.
 */
function breakEvenWinRate(tpPct, slPct) {
  return (slPct + TAKER_RT) / (tpPct + slPct);
}


/**
 * The EFFECTIVE sample size of a set of observations.
 *
 * ── WHY THIS IS NOT OPTIONAL ──
 *
 * The collector samples ~43 symbols at a time, every 5 minutes. The
 * rows in one bucket are 43 different symbols moving TOGETHER — crypto
 * is correlated, so a market-wide move produces 43 near-identical
 * observations. Treating them as 43 independent samples overstates the
 * evidence by roughly the square root of the cluster size.
 *
 * Measured on the 2026-10-21 sample: 609 rows, but only **11 distinct
 * 15-minute buckets** and **4 distinct hours**. So the raw n=81 is
 * really about n=11 clusters.
 *
 * The correction: compute the standard error of the CLUSTER MEANS
 * (one mean per time bucket) and use that. The t-statistic then
 * reflects the number of independent observations, which is the honest
 * number.
 */
function clusterStats(values, buckets) {
  // One mean per bucket.
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const clusterMeans = [...byBucket.values()].map((a) => mean(a));
  return {
    clusters: clusterMeans.length,
    clusterMeans,
    mean: mean(clusterMeans),
    se: se(clusterMeans),
  };
}

async function main() {
  if (!existsSync(IN)) {
    console.error(`[geometry] no confluence file at ${IN}`);
    process.exitCode = 1;
    return;
  }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // The CONTROL arm: the tape and the models AGREE. That is the
  // machine's own signal — the only thing it actually trades.
  const control = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const modelSide = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    if (!modelSide) continue;
    if (tapeSide !== modelSide) continue; // only the agreeing arm
    control.push({ ...r, dir: tapeSide });
  }
  console.log(`[geometry] ${rows.length} observations, ${control.length} on the machine's own signal (tape + models agree)`);
  if (control.length < 10) {
    console.log("[geometry] NOT ENOUGH HISTORY YET — the collector keeps running.");
    return;
  }
  CACHE_OLDEST = minBy(control, (c) => c.ts);

  // Fetch the bars for every symbol.
  const pairs = [...new Set(control.map((c) => c.pair))];
  const noBars = [];
  for (const p of pairs) {
    const need = maxOf(control.filter((c) => c.pair === p).map((c) => c.ts + MAX_HOLD_BARS * BAR_MIN * 60_000));
    const got = await barsFor(p, need);
    if (!got.length) noBars.push(p);
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  } catch {
    /* the cache is an optimisation */
  }
  if (noBars.length) console.log(`[geometry] ${noBars.length} symbol(s) had no bars`);

  // The ticket's exposure. The live path sizes to a $60 position cap on
  // a $57.23 account, so the notional is ~1.048x equity. The study uses
  // the account's ACTUAL equity so the expectancy is in real terms.
  const EQUITY = 57.2287;
  const NOTIONAL = 60.0;
  const notionalOverEquity = NOTIONAL / EQUITY;

  console.log(`[geometry] exposure: ${NOTIONAL.toFixed(2)} notional on ${EQUITY.toFixed(2)} equity = ${notionalOverEquity.toFixed(4)}x`);
  console.log();

  // ── THE UNCONDITIONAL BASELINE ──
  //
  // The same geometry, the same symbols, the same windows, with NO
  // model filter at all: EVERY observation where the tape pointed
  // somewhere, taking the tape's direction. If the models' agreement
  // adds nothing, the two arms are identical.
  //
  // This is the control the earlier forward-return studies lacked, and
  // it matters here because the sample is 72/72 SHORT: a "winning"
  // short in a window where the market fell 0.28% is beta, not edge.
  const unconditional = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    unconditional.push({ ...r, dir: tapeSide });
  }
  console.log(`[geometry] the unconditional baseline: ${unconditional.length} observations (the tape's direction, with NO model filter)`);

  // ── THE REGIME DECOMPOSITION ──
  //
  // The excess is only an edge if it holds WITHIN a market regime. If
  // it appears in one regime and not the others, it is that regime's
  // drift — the models' agreement simply happens to correlate with
  // the regime — and not a signal.
  //
  // The regimes are the market's own state, measured by the tape's
  // geometry: near the high (an uptrend), near the low (a downtrend),
  // or neither/both (flat-ish).
  const regimeOf = (r) => {
    const oh = Number(r.tapeOffHighPct ?? 0);
    const ol = Number(r.tapeOffLowPct ?? 0);
    if (ol < 8 && oh >= 8) return "down";
    if (oh < 8 && ol >= 8) return "up";
    return "flat";
  };

  const results = [];
  /**
   * Simulate one geometry over one set of observations.
   * Identical logic for the signal arm and the unconditional arm, so
   * the two are comparable by construction.
   */
  const simulate = (set, g) => {
    const wins = [];
    const losses = [];
    let unresolved = 0;
    let ambiguous = 0;
    let missingAtr = 0;
    /** The per-trade equity P&L of the time exits, and their raw marks. */
    const timeExits = [];
    const timeExitMarks = [];
    /** The time bucket of each win / loss / time exit, for the cluster
     *  statistics. Split by outcome so the per-trade array (wins, then
     *  losses, then time exits) can be paired with them exactly. */
    const winBuckets = [];
    const lossBuckets = [];
    const timeExitBuckets = [];
    for (const c of set) {
      const bars = CACHE[c.pair];
      if (!bars?.length) { unresolved++; continue; }
      // The entry is the close of the last bar at or before the
      // observation — the same anchor the live path uses.
      let idx = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t <= c.ts) idx = i;
        else break;
      }
      if (idx < 0) { unresolved++; continue; }
      const entry = bars[idx].c;
      // The collector's row is FLAT (tapeAtrPct), while the trade
      // loop's log nests the tape (tape.atrPct). Reading the wrong one
      // silently yields 0, and a 0 ATR makes the shipped geometry fall
      // back to a 0.3% stop — a tiny stop that resolves fast and
      // inflates the win rate. The guard below refuses to guess.
      const atrPct = Number(c.tapeAtrPct ?? c.tape?.atrPct ?? NaN);
      // The SHIPPED geometry: TP = clamp(ATR*0.4, 0.3, 0.5), SL = the
      // live path's ATR-driven stop. The observed stop was ~1.34x ATR,
      // so that is what the shipped row uses.
      const tpPct = g.tp != null ? g.tp : Math.min(0.5, Math.max(0.3, atrPct * 0.4));
      const slPct = g.sl != null ? g.sl : Math.max(0.3, atrPct * 1.34);
      if (g.shipped) {
        if (!Number.isFinite(atrPct) || atrPct <= 0) {
          // No ATR means the shipped geometry cannot be reproduced. It
          // must be REFUSED, not approximated: a fallback stop of 0.3%
          // resolves far faster than the real one and turns a negative
          // ticket into an apparently positive one.
          missingAtr++;
          unresolved++;
          continue;
        }
      }
      if (!(tpPct > 0) || !(slPct > 0)) { unresolved++; continue; }
      const long = c.dir === "long";
      const o = outcome(bars, c.ts, entry, tpPct, slPct, long);
      if (o === null) { unresolved++; continue; }
      const bucket = Math.floor(c.ts / BUCKET_MS);
      if (typeof o === "object") {
        // A TIME EXIT: the trade was closed at the horizon's close and
        // booked at the mark. Its P&L is the mark, less the fee.
        timeExits.push((o.movePct - TAKER_RT) * notionalOverEquity);
        timeExitMarks.push(o.movePct);
        timeExitBuckets.push(bucket);
        continue;
      }
      // An ambiguous bar (both levels touched) is a loss — the same
      // conservative tie handling the backtest uses.
      if (o === "loss") {
        // Detect the ambiguous case for the report.
        const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
        const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
        let start = -1;
        for (let i = 0; i < bars.length; i++) { if (bars[i].t > c.ts) { start = i; break; } }
        if (start >= 0) {
          for (let i = start; i < Math.min(bars.length, start + MAX_HOLD_BARS); i++) {
            const b = bars[i];
            const hitTp = long ? b.h >= tp : b.l <= tp;
            const hitSl = long ? b.l <= sl : b.h >= sl;
            if (hitTp && hitSl) { ambiguous++; break; }
            if (hitTp || hitSl) break;
          }
        }
      }
      (o === "win" ? wins : losses).push(c);
      (o === "win" ? winBuckets : lossBuckets).push(bucket);
    }
    return {
      wins, losses, unresolved, ambiguous, missingAtr,
      timeExits, timeExitMarks,
      winBuckets, lossBuckets, timeExitBuckets,
    };
  };

  for (const g of GEOMETRIES) {
    const { wins, losses, unresolved, ambiguous, missingAtr, timeExits, timeExitMarks, winBuckets, lossBuckets, timeExitBuckets } = simulate(control, g);
    const n = wins.length + losses.length;
    if (n < 5) {
      console.log(`  ${g.name}: not enough resolved trades (${n})`);
      continue;
    }
    const winRate = wins.length / n;
    // The EXPECTANCY is the mean of the PER-TRADE equity P&L, with the
    // time exits booked at their mark. A win RATE alone cannot describe
    // this outcome set, because a time exit is neither a win nor a
    // loss — it is a small number that can be either sign.
    // The per-trade array is built in the SAME order as the buckets:
    // the wins, then the losses, then the time exits. (The simulation
    // pushes them in observation order, so the buckets array is
    // interleaved — the cluster statistics below use the wins' and
    // losses' buckets and the time exits' buckets separately, and the
    // order does not matter for a mean, only for a per-row pairing.)
    const perTrade = [
      ...wins.map(() => (g.tp ?? 0.4) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...losses.map(() => -(g.sl ?? 1.2) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...timeExits,
    ];
    const rBuckets = [...winBuckets, ...lossBuckets, ...timeExitBuckets];
    const ev = mean(perTrade);
    const evSe = se(perTrade);
    const evT = evSe > 0 ? ev / evSe : 0;
    const wbe = breakEvenWinRate(g.tp ?? 0.4, g.sl ?? 1.2);

    // The SAME geometry on the unconditional set: the tape's direction
    // with NO model filter. The EXCESS is the models' contribution —
    // what the confirmation layer actually adds.
    const U = simulate(unconditional, g);
    const uN = U.wins.length + U.losses.length;
    const uPerTrade = [
      ...U.wins.map(() => (g.tp ?? 0.4) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...U.losses.map(() => -(g.sl ?? 1.2) * notionalOverEquity - TAKER_RT * notionalOverEquity),
      ...U.timeExits,
    ];
    const uBuckets = [...U.winBuckets, ...U.lossBuckets, ...U.timeExitBuckets];
    const uEv = uN + U.timeExits.length ? mean(uPerTrade) : 0;
    const excess = ev - uEv;
    // The excess's standard error is the STANDARD ERROR OF THE
    // DIFFERENCE OF TWO MEANS — the two arms are different sets of
    // observations, so they must NOT be paired by index. (An earlier
    // version paired perTrade[i] with uPerTrade[i], which is invalid:
    // the arrays have different lengths and different compositions, so
    // the pairing compared unrelated trades and produced a confident,
    // meaningless t.)
    const uSe = se(uPerTrade);
    // The excess's standard error, computed on CLUSTER MEANS (one per
    // time bucket) rather than on individual rows. The rows in one
    // bucket are ~43 correlated symbols moving together, so the row
    // level standard error understates the true uncertainty by roughly
    // the square root of the cluster size.
    const sCluster = clusterStats(perTrade, rBuckets);
    const uCluster = clusterStats(uPerTrade, uBuckets);
    // THE INDEPENDENT-CLUSTER COUNT AT THE TICKET'S HOLDING PERIOD.
    //
    // The 5-minute bucket above is the CORRELATION correction: the
    // rows in one bucket are ~43 symbols moving together. But it is NOT
    // the independent sample — two signals inside one 4-hour hold share
    // the same entry, the same path and the same exit, so they are ONE
    // trade seen twice. The house rule is the ticket's full holding
    // period (240 minutes), and the cluster BAR is counted there.
    // The buckets are BUCKET INDICES (floor(ts / BUCKET_MS)), not
    // milliseconds — so the holding-period cluster is the bucket index
    // divided by the number of 5-minute buckets in one 240-minute hold.
    const HOLD_BUCKET_COUNT = Math.round(HOLD_BUCKET_MS / BUCKET_MS); // 48
    const sHoldClusters = new Set(
      [...winBuckets, ...lossBuckets, ...timeExitBuckets].map((b) =>
        Math.floor(b / HOLD_BUCKET_COUNT),
      ),
    ).size;
    const excessCluster = sCluster.mean - uCluster.mean;
    const excessClusterSe = Math.sqrt(sCluster.se ** 2 + uCluster.se ** 2);
    const excessT = excessClusterSe > 0 ? excessCluster / excessClusterSe : 0;
    const excessSe = excessClusterSe;
    // The per-observation excess, for the trim test. The two arms are
    // DIFFERENT sets, so the excess per observation is not a
    // difference-of-pairs — the trim test below therefore trims the
    // SIGNAL arm's per-trade P&L and re-measures, which is the honest
    // way to ask "does the result survive without its best rows?".
    const signalPerTrade = perTrade;

    results.push({
      g, winRate, n, wbe, ev, evSe, evT, unresolved, ambiguous, missingAtr,
      timeExits: timeExits.length, meanTimeExit: mean(timeExitMarks),
      uEv, uN, uTimeExits: U.timeExits.length, uWinRate: uN ? U.wins.length / uN : 0,
      excess, excessSe, excessT, uSe, signalPerTrade,
      sClusters: sCluster.clusters, uClusters: uCluster.clusters,
      sHoldClusters,
      tp: g.tp, sl: g.sl, perTrade,
    });
  }

  console.log("  GEOMETRY                     n  win%  time%   break-even   EV/trade   uncond.EV   EXCESS      t  clus  hold  verdict");
  console.log("  " + "-".repeat(112));
  for (const r of results) {
    // THE VERDICT MUST APPLY THE HOUSE BAR, NOT JUST THE SIGN.
    //
    // This used to be `r.excess > 0 ? "EDGE" : "no edge"` — a
    // POSITIVE EXCESS ALONE was declared an edge, with no t, no
    // cluster count and no fee floor. That printed "EDGE" for the
    // SHIPPED geometry at t=0.26 on 37 five-minute buckets, with a
    // 100% win rate and 32% of the trades exiting ON THE CLOCK — and
    // the numbers MOVED between runs (the excess read +0.0684% and
    // then +0.0275%) because the script reads the LIVE bar cache.
    //
    // A positive excess is a PATTERN, not a finding. To be an edge it
    // must clear all four:
    //   1. the excess is positive
    //   2. its t on the CLUSTER MEANS is >= 2
    //   3. the cluster count meets the bar
    //   4. the arm's OWN net EV clears the fee floor — an excess is a
    //      DIFFERENCE, so an arm can beat a losing control and still
    //      lose after the fee
    // THE FEE FLOOR, in % OF EQUITY — the same units as r.ev.
    // The EV is built as `(tpPct * notionalOverEquity) - (TAKER_RT *
    // notionalOverEquity)`, so the fee term is ALREADY in % of equity.
    // Multiplying by 100 again would put the floor at 12.58% and make
    // the "EDGE" verdict unreachable — a false negative that would hide
    // a genuine edge.
    const feeFloorPct = TAKER_RT * (NOTIONAL / EQUITY);
    const clusterOk = (r.sHoldClusters ?? r.sClusters) >= MIN_CLUSTER_BAR;
    const tOk = r.excessT >= 2;
    const excessOk = r.excess > 0;
    const ownEvOk = r.ev > feeFloorPct;
    const verdict = excessOk && tOk && clusterOk && ownEvOk
      ? "EDGE"
      : excessOk
        ? "candidate"
        : "no edge";
    const name = r.g.name.padEnd(26);
    const timePct = r.n + r.timeExits > 0 ? (r.timeExits / (r.n + r.timeExits)) * 100 : 0;
    console.log(
      `  ${name} ${String(r.n).padStart(3)} ${(r.winRate * 100).toFixed(1).padStart(5)}% ${timePct.toFixed(0).padStart(5)}% ${(r.wbe * 100).toFixed(1).padStart(9)}%  ${(r.ev >= 0 ? "+" : "") + r.ev.toFixed(4)}% ${(r.uEv >= 0 ? "+" : "") + r.uEv.toFixed(4)}% ${(r.excess >= 0 ? "+" : "") + r.excess.toFixed(4)}% ${r.excessT.toFixed(2).padStart(6)} ${String(r.sClusters).padStart(4)} ${String(r.sHoldClusters ?? r.sClusters).padStart(4)}  ${verdict}`,
    );
  }
  console.log();
  // The trim test: if one or two observations carry the excess, the
  // result is those observations, not the sample. The excess's own
  // per-observation values are trimmed and re-tested.
  console.log("  EV/trade   the signal arm's mean per-trade equity P&L");
  console.log("  uncond.EV  the SAME geometry with NO model filter — the beta");
  console.log("  EXCESS     uncond.EV subtracted: what the models' agreement adds");
  console.log("  t          computed on CLUSTER MEANS, not on individual rows");
  console.log("  clus       the number of independent 5-minute buckets (the CORRELATION correction)");
  console.log("  hold       the number of independent clusters at the TICKET'S 240-minute holding");
  console.log("             period — this is the INDEPENDENT SAMPLE, and the one the bar counts");
  console.log("  verdict    EDGE needs: positive excess, t>=2, hold>=30 clusters, AND the arm's");
  console.log("             own net EV above the fee floor. Anything less is a 'candidate'.");
  console.log();
  console.log("  The rows in one bucket are ~43 symbols moving TOGETHER, so the");
  console.log("  row-level t overstates the evidence by roughly the square root");
  console.log("  of the cluster size. The clustered t is the honest one.");
  console.log();
  console.log();
  for (const r of results) {
    console.log(
      `  ${r.g.name}: ${r.n} resolved at a level, ${r.timeExits} closed at the ${MAX_HOLD_BARS * BAR_MIN}min time exit (mean mark ${r.meanTimeExit >= 0 ? "+" : ""}${r.meanTimeExit.toFixed(3)}%), ${r.unresolved} unusable, ${r.ambiguous} ambiguous (both levels touched — counted as LOSSES)${r.missingAtr ? `, ${r.missingAtr} MISSING ATR` : ""}`,
    );
  }
  console.log();
  console.log("  EV/trade is the mean PER-TRADE equity P&L, in % of equity, with the fee");
  console.log("  charged on every trade. It is the number that decides whether a");
  console.log("  geometry pays for itself.");
  console.log();
  // ── THE TRIM TEST, PER GEOMETRY ──
  //
  // The signal arm's per-trade P&L, with the worst 3 and the best 3
  // dropped. The excess is re-measured against the same unconditional
  // baseline. If the excess survives both trims, it is a property of
  // the sample; if it collapses, it was a handful of rows.
  {
    console.log("  TRIM TEST (the signal arm's best/worst 3 dropped, excess re-measured)");
    for (const r of results) {
      if (!r.signalPerTrade || r.signalPerTrade.length < 8) continue;
      const sorted = [...r.signalPerTrade].sort((a, b) => a - b);
      const trimWorst = sorted.slice(3);
      const trimBest = sorted.slice(0, sorted.length - 3);
      const mw = mean(trimWorst);
      const mb = mean(trimBest);
      const exW = mw - r.uEv;
      const exB = mb - r.uEv;
      const stable = (exW > 0 && exW / (se(trimWorst) || 1) >= 2) || (exB > 0 && exB / (se(trimBest) || 1) >= 2);
      console.log(
        `    ${r.g.name.padEnd(26)} worst-3: ${exW >= 0 ? "+" : ""}${exW.toFixed(4)}pp   best-3: ${exB >= 0 ? "+" : ""}${exB.toFixed(4)}pp   ${stable ? "STABLE" : "not stable"}`,
      );
    }
    console.log();
  }
  console.log();
  // ── THE REGIME TABLE ──
  //
  // The excess, split by the market's regime. The signal arm and the
  // unconditional arm are compared WITHIN each regime, so the regime's
  // own drift cannot produce the difference.
  {
    console.log("  REGIME DECOMPOSITION (the excess, within each market regime)");
    for (const reg of ["up", "flat", "down"]) {
      const sg = simulate(control.filter((c) => regimeOf(c) === reg), GEOMETRIES[0]);
      const un = simulate(unconditional.filter((c) => regimeOf(c) === reg), GEOMETRIES[0]);
      const sN = sg.wins.length + sg.losses.length + sg.timeExits.length;
      const uN = un.wins.length + un.losses.length + un.timeExits.length;
      if (!sN || !uN) {
        console.log(`    ${reg.padEnd(6)} signal n=${String(sN).padStart(3)}  uncond n=${String(uN).padStart(3)}  -> no data`);
        continue;
      }
      const sPer = [
        ...sg.wins.map(() => 0.4 - TAKER_RT),
        ...sg.losses.map(() => -1.2 - TAKER_RT),
        ...sg.timeExits,
      ];
      const uPer = [
        ...un.wins.map(() => 0.4 - TAKER_RT),
        ...un.losses.map(() => -1.2 - TAKER_RT),
        ...un.timeExits,
      ];
      const sMean = mean(sPer);
      const uMean = mean(uPer);
      const d = Math.sqrt(se(sPer) ** 2 + se(uPer) ** 2);
      const t = d > 0 ? (sMean - uMean) / d : 0;
      console.log(
        `    ${reg.padEnd(6)} signal n=${String(sN).padStart(3)} mean=${sMean >= 0 ? "+" : ""}${sMean.toFixed(4)}%  uncond n=${String(uN).padStart(3)} mean=${uMean >= 0 ? "+" : ""}${uMean.toFixed(4)}%  EXCESS=${(sMean - uMean) >= 0 ? "+" : ""}${(sMean - uMean).toFixed(4)}pp  t=${t.toFixed(2)}`,
      );
    }
    console.log("    An excess that appears in ONE regime only is that regime's drift, not an edge.");
    console.log();
  }
  const positive = results.filter((r) => r.excess > 0);
  if (positive.length === 0) {
    console.log("[geometry] NO geometry has a positive EXCESS over the unconditional baseline.");
    console.log("[geometry] The signal arm's raw EV is not evidence: the same geometry without the model filter pays the same, so what looks like edge is the market's drift over these windows.");
  } else {
    console.log(`[geometry] ${positive.length} geometry/ies have a positive EXCESS over the unconditional baseline:`);
    for (const r of positive) {
      const t = r.excessT;
      console.log(`  ${r.g.name}: EXCESS ${r.excess >= 0 ? "+" : ""}${r.excess.toFixed(4)}% of equity per trade (t=${t.toFixed(2)}), win ${(r.winRate * 100).toFixed(1)}%, ${r.timeExits} time exits`);
    }
  }
  console.log("[geometry] The sample is small and the collector is still running; a positive result here is a CANDIDATE for a full backtest, not a finding.");
}

main().catch((e) => {
  console.error(`[geometry] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
