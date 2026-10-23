#!/usr/bin/env node
/**
 * hunt-edge.mjs — search for a genuinely tradeable edge in the KuCoin futures
 * universe, beyond the known-broken fade/dip signal.
 *
 * READ-ONLY. Public endpoints only, no auth, no orders.
 *
 * WHAT IT DOES
 *   1. Pulls the FULL crypto USDT-margined perpetual universe
 *      (`/api/v1/contracts/active`, assetClass=CRYPTO, quote=USDT, linear).
 *   2. Fetches 90 days of 1h klines (plus 4h for multi-timeframe alignment,
 *      plus funding-rate history) per contract.
 *   3. Builds MANY candidate signal definitions — momentum breakout,
 *      RSI/MACD mean-reversion and momentum, volume-spike continuation/fade,
 *      funding-rate extremes, session-of-day, volatility-regime gates,
 *      multi-timeframe alignment, and combinations — each replayed through a
 *      TP/kill ladder.
 *   4. Measures every candidate on EVERY bar the signal fires: no sample
 *      selection, no skipping of ambiguous bars, no dropping of losers.
 *
 * MEASUREMENT RULES (the ones that decide whether a number means anything)
 *   - Entry: the signal is computed from data through bar i's close; the fill
 *     happens at the OPEN of bar i+1. The next bar must be the contiguous
 *     hour, else the signal is counted and reported as skipped (never
 *     silently dropped).
 *   - Every signal bar produces a trade. Trades MAY overlap in time. This is
 *     a per-signal expectancy, not a portfolio P&L — the honest conditional
 *     measure the task demands.
 *   - Intra-bar TP/kill tie (one bar touches BOTH levels) resolves as a LOSS
 *     at the kill price. OHLC cannot say which level printed first, and the
 *     optimistic (TP-first) reading flatters every candidate. The tie is
 *     counted separately so its weight is visible.
 *   - Fees: maker 0.02%/side and taker 0.06%/side on both legs of every trade
 *     (round trip 0.04% maker / 0.12% taker).
 *   - Funding is charged for every settlement inside the holding window
 *     (long pays, short receives) at that symbol's real settled rate.
 *   - LONG and SHORT are reported SEPARATELY — the aggregate hides a losing
 *     side.
 *   - Out-of-sample: three consecutive 30-day blocks over the 90-day window,
 *     per-side taker expectancy reported per block.
 *   - A day-clustered bootstrap CI on each side's taker expectancy: signals
 *     cluster (one market-wide move fires many same-hour signals), so an
 *     i.i.d. CI would be far too narrow.
 *
 * THE BAR a candidate must clear (per side):
 *   (a) positive net expectancy at TAKER fees,
 *   (b) positive taker expectancy in >= 2 of the 3 out-of-sample blocks,
 *   (c) n >= 30 trades on that side.
 *
 * USAGE
 *   node packages/jw3-cli/research/hunt-edge.mjs [--days 90] [--workers 16]
 *       [--smoke] [--out <file.json>] [--cache-dir <dir>] [--validate]
 *
 *   --smoke     small universe (8 symbols) — pipeline check.
 *   --validate  reproduce the repo's shipped `backtest scalp` numbers with
 *               this pipeline (ETH/USDT, 90d, taker) and print the delta.
 *
 * Writes only its own JSON output; the cache lives in the scratch dir, never
 * in the repo.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

/* ------------------------------------------------------------------ */
/* config                                                             */
/* ------------------------------------------------------------------ */

const FUT = "https://api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};

const HOUR = 3600_000;
const DAY = 86_400_000;

const MAKER_FEE_PCT = 0.02; // per side (verified on /contracts/active: makerFeeRate 0.0002)
const TAKER_FEE_PCT = 0.06; // per side (verified: takerFeeRate 0.0006)

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  days: 90,
  workers: 16,
  smoke: false,
  validate: false,
  out: null,
  cacheDir: join(process.env.HOME ?? "/tmp", ".hermes/cache/scratch/edge-hunt/cache"),
};

function parseArgs(argv) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") cfg.days = Number(argv[++i]);
    else if (a === "--workers") cfg.workers = Number(argv[++i]);
    else if (a === "--out") cfg.out = argv[++i];
    else if (a === "--cache-dir") cfg.cacheDir = argv[++i];
    else if (a === "--smoke") cfg.smoke = true;
    else if (a === "--validate") cfg.validate = true;
  }
  return cfg;
}

/* ------------------------------------------------------------------ */
/* http: shared rate limiter + retry                                  */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Global token bucket — the venue's budget is shared per IP. */
const limiter = {
  nextAt: 0,
  minGapMs: 40, // ~25 req/s ceiling
  async take() {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.minGapMs;
    const wait = at - now;
    if (wait > 0) await sleep(wait);
  },
};

async function getJson(path, attempt = 0) {
  await limiter.take();
  let res;
  try {
    res = await fetch(FUT + path, { headers: UA });
  } catch (e) {
    if (attempt < 4) {
      await sleep(200 + Math.random() * 400);
      return getJson(path, attempt + 1);
    }
    throw e;
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? "0");
    await sleep((ra > 0 ? ra * 1000 : 300) + Math.random() * 250);
    return getJson(path, attempt + 1);
  }
  if (res.status >= 500 && attempt < 4) {
    await sleep(200 + Math.random() * 500);
    return getJson(path, attempt + 1);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 140);
    throw new Error(`HTTP ${res.status} ${path} ${body}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* universe                                                           */
/* ------------------------------------------------------------------ */

/**
 * Crypto USDT-margined linear perps. Equity/index contracts are excluded by
 * assetClass (NOT by ticker name — SPXUSDTM is a memecoin, not the S&P 500).
 */
function selectUniverse(contracts) {
  return contracts
    .filter(
      (c) =>
        c.assetClass === "CRYPTO" &&
        c.quoteCurrency === "USDT" &&
        String(c.symbol).endsWith("USDTM") &&
        c.status === "Open" &&
        !c.isInverse,
    )
    .map((c) => ({
      symbol: c.symbol,
      multiplier: Number(c.multiplier) || 1,
      makerFeeRate: Number(c.makerFeeRate),
      takerFeeRate: Number(c.takerFeeRate),
      turnover24h: Number(c.turnoverOf24h) || 0,
      firstOpenDate: Number(c.firstOpenDate) || 0,
    }))
    .sort((a, b) => b.turnover24h - a.turnover24h);
}

/* ------------------------------------------------------------------ */
/* fetchers (disk-cached; cache lives OUTSIDE the repo)               */
/* ------------------------------------------------------------------ */

function cacheKey(dir, name) {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

function cachePut(dir, name, value) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(value));
  } catch {
    /* cache is best-effort */
  }
}

/**
 * KuCoin kline rows: [ts, open, high, low, close, volume(lots), turnover].
 * Timestamps are bar-OPEN times. The endpoint returns at most 200 rows per
 * call, so we page forward from the last row's ts+1 (never a fixed stride —
 * bars are omitted entirely when a symbol does not trade).
 */
async function fetchKlines(symbol, granMin, fromMs, toMs, cacheDir) {
  const dayAnchor = Math.floor(toMs / DAY);
  const key = `kl_${symbol}_${granMin}_${dayAnchor}.json`;
  const hit = cacheKey(cacheDir, key);
  if (hit) return hit;
  const byTs = new Map();
  const stepMs = granMin * 60_000;
  let cursor = fromMs;
  let guard = 0;
  while (cursor <= toMs && guard++ < 500) {
    const pageTo = Math.min(cursor + 200 * stepMs, toMs);
    const d = await getJson(
      `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granMin}&from=${cursor}&to=${pageTo}`,
    );
    const rows = Array.isArray(d.data) ? d.data : [];
    if (rows.length === 0) break;
    for (const k of rows) {
      const ts = Number(k[0]);
      if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
      byTs.set(ts, {
        ts,
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
        t: Number(k[6]) || 0,
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    if (rows.length < 200) cursor = Math.max(cursor, pageTo + 1);
  }
  const out = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  cachePut(cacheDir, key, out);
  return out;
}

/**
 * Funding settlements. Caps at 100 rows/call, returns NEWEST first, so we
 * page BACKWARD with `to`. Cadence is derived from the actual settlement
 * spacing, never assumed (8h vs 4h per contract, and it can change
 * mid-window).
 */
async function fetchFunding(symbol, fromMs, toMs, cacheDir) {
  const dayAnchor = Math.floor(toMs / DAY);
  const key = `fr_${symbol}_${dayAnchor}.json`;
  const hit = cacheKey(cacheDir, key);
  if (hit) return hit;
  const byTs = new Map();
  let to = toMs;
  let guard = 0;
  while (to >= fromMs && guard++ < 30) {
    const d = await getJson(
      `/api/v1/contract/funding-rates?symbol=${encodeURIComponent(symbol)}&from=${fromMs}&to=${to}`,
    );
    const rows = Array.isArray(d.data) ? d.data : [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const tp = Number(r.timepoint);
      if (!Number.isFinite(tp) || tp < fromMs || tp > toMs) continue;
      byTs.set(tp, Number(r.fundingRate));
    }
    const oldest = minBy(rows, (r) => Number(r.timepoint));
    if (oldest <= fromMs) break;
    to = oldest - 1;
  }
  const out = [...byTs.entries()].map(([ts, rate]) => ({ ts, rate })).sort((a, b) => a.ts - b.ts);
  cachePut(cacheDir, key, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* indicators                                                         */
/* ------------------------------------------------------------------ */

/** EMA, seeded with the first value. */
function ema(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  if (arr.length === 0) return out;
  const k = 2 / (n + 1);
  let prev = arr[0];
  out[0] = prev;
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RMA (the smoothing RSI uses). */
function rma(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) continue;
    if (prev === null) {
      sum += arr[i];
      prev = sum / (i + 1);
      out[i] = prev;
      continue;
    }
    prev = (prev * (n - 1) + arr[i]) / n;
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI on closes. */
function rsi(closes, n = 14) {
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, n);
  const al = rma(losses, n);
  const out = new Array(closes.length).fill(NaN);
  for (let i = 1; i < closes.length; i++) {
    const g = ag[i - 1];
    const l = al[i - 1];
    if (!Number.isFinite(g) || !Number.isFinite(l)) continue;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/**
 * ATR% — the HOUSE convention: the simple mean of the last 14 true ranges
 * divided by the close. This is exactly what `fadeMetrics` computes in
 * src/kucoin.ts (a 15-bar window -> 14 TRs), so the ladder derived from it
 * matches the shipped `scalp plan` and the shipped `backtest scalp`.
 */
function atrPctHouse(bars, n = 14) {
  const out = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const b = bars[j];
      const pc = bars[j - 1].c;
      sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    }
    const c = bars[i].c;
    out[i] = c > 0 ? (sum / n / c) * 100 : NaN;
  }
  return out;
}

/** Rolling extreme over the PRIOR n bars (current bar excluded). */
function rollingPriorExtreme(values, n, pick) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let m = pick === "max" ? -Infinity : Infinity;
    for (let j = i - n; j < i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) continue;
      if (pick === "max" ? v > m : v < m) m = v;
    }
    out[i] = Number.isFinite(m) ? m : NaN;
  }
  return out;
}

/** Rolling median over the PRIOR n bars (current bar excluded). */
function rollingPriorMedian(values, n) {
  const out = new Array(values.length).fill(NaN);
  const buf = new Array(n);
  for (let i = n; i < values.length; i++) {
    for (let j = 0; j < n; j++) buf[j] = values[i - n + j];
    const s = buf.filter(Number.isFinite).sort((a, b) => a - b);
    out[i] = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  }
  return out;
}

/** Rolling mean over the PRIOR n bars (current bar excluded). */
function rollingPriorMean(values, n) {
  const out = new Array(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = i - n; j < i; j++) {
      if (!Number.isFinite(values[j])) continue;
      s += values[j];
      c++;
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* trade simulation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Replay one signal through the TP/kill ladder.
 *
 * Entry at the open of bar entryIdx (or at the close of the signal bar when
 * the candidate asks for the repo's fade convention). Walk forward up to
 * maxHold bars. A tie (one bar touches BOTH the TP and the kill) resolves as
 * a LOSS at the kill price. Funding settlements inside the holding window are
 * charged (long pays, short receives).
 */
function simulateTrade(bars, entryIdx, entryPx, dir, tpPct, killPct, maxHold, fundPrefix, fundMinHour, skipEntryBar) {
  const n = bars.length;
  const entry = bars[entryIdx];
  if (!entry || !(entryPx > 0)) return null;
  const sign = dir === "long" ? 1 : -1;
  const tpPx = entryPx * (1 + (sign * tpPct) / 100);
  const killPx = entryPx * (1 - (sign * killPct) / 100);
  const endIdx = Math.min(entryIdx + maxHold, n - 1);
  let exitType = "timeout";
  let exitPx = bars[endIdx] ? bars[endIdx].c : entryPx;
  let exitIdx = endIdx;
  for (let j = entryIdx; j <= endIdx; j++) {
    const b = bars[j];
    if (!b) continue;
    // When the fill happens at the CLOSE of bar entryIdx, that bar's range is
    // already in the past — its high/low must not be read as a TP/kill touch.
    if (j === entryIdx && skipEntryBar) continue;
    const tpHit = dir === "long" ? b.h >= tpPx : b.l <= tpPx;
    const killHit = dir === "long" ? b.l <= killPx : b.h >= killPx;
    if (tpHit && killHit) {
      exitType = "tie";
      exitPx = killPx; // tie = LOSS, at the kill price
      exitIdx = j;
      break;
    }
    if (tpHit) {
      exitType = "tp";
      exitPx = tpPx;
      exitIdx = j;
      break;
    }
    if (killHit) {
      exitType = "kill";
      exitPx = killPx;
      exitIdx = j;
      break;
    }
  }
  const grossPct = ((exitPx - entryPx) / entryPx) * 100 * sign;
  // Funding: longs pay positive rates, shorts receive them. O(1) via the
  // hourly prefix sum (settlements at 00/08/16 UTC sit on hour boundaries).
  let fundingPct = 0;
  const entryHour = Math.floor(entry.ts / HOUR);
  const exitHour = Math.floor((bars[exitIdx] ? bars[exitIdx].ts : entry.ts) / HOUR);
  if (fundPrefix && exitHour >= entryHour) {
    const hi = Math.min(fundPrefix.length - 1, exitHour - fundMinHour + 1);
    const lo = Math.max(0, entryHour - fundMinHour + 1);
    if (hi >= lo) fundingPct = (fundPrefix[hi] - fundPrefix[lo]) * 100 * sign;
  }
  return {
    entryTs: entry.ts,
    exitTs: bars[exitIdx] ? bars[exitIdx].ts : entry.ts,
    dir,
    grossPct,
    fundingPct,
    exitType,
    // The two readings of an intra-bar tie: "kill" charges the loss it might
    // have been; "tp" is the repo's house convention.
    tieGrossKillPct: -killPct,
    tieGrossTpPct: tpPct,
  };
}

/** TP/kill percentages from ATR% (the shipped convention), clamped. */
function ladderFromAtr(atrPct) {
  const a = Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  return {
    tpPct: Math.min(0.5, Math.max(0.3, a * 0.4)),
    killPct: Math.min(1.5, Math.max(0.6, a * 0.9)),
  };
}

/**
 * Fixed ladders used for the robustness sweep. Includes SYMMETRIC ladders
 * (TP == kill), because the house ladder is 1:2.25 and a negative expectancy
 * can mean "no signal" OR "the fee+kill geometry ate it". The symmetric
 * ladders separate those two explanations.
 */
const FIXED_LADDERS = [
  { name: "tp0.3_k0.6", tpPct: 0.3, killPct: 0.6 },
  { name: "tp0.5_k1.0", tpPct: 0.5, killPct: 1.0 },
  { name: "tp1.0_k1.5", tpPct: 1.0, killPct: 1.5 },
  { name: "tp1.5_k3.0", tpPct: 1.5, killPct: 3.0 },
  { name: "sym0.3_k0.3", tpPct: 0.3, killPct: 0.3 },
  { name: "sym0.5_k0.5", tpPct: 0.5, killPct: 0.5 },
  { name: "sym0.75_k0.75", tpPct: 0.75, killPct: 0.75 },
  { name: "sym1.0_k1.0", tpPct: 1.0, killPct: 1.0 },
  { name: "sym1.5_k1.5", tpPct: 1.5, killPct: 1.5 },
  { name: "sym2.0_k2.0", tpPct: 2.0, killPct: 2.0 },
];

/* ------------------------------------------------------------------ */
/* streaming accumulator                                              */
/* ------------------------------------------------------------------ */

/**
 * Accumulates trade statistics in ONE pass, without storing the trades.
 *
 * Everything the report needs is a running total: counts, net sums per fee
 * model, win/loss sums, exit-type counts, per-block splits, per-side splits,
 * per-day sums (for the clustered bootstrap) and per-symbol sums (for the
 * "how many symbols carry this" check).
 *
 * MEMORY: with ~90 candidates x 11 ladders x 504 symbols, a per-symbol
 * per-side Map-of-days (needed for a slice-level bootstrap) is fatal — it
 * OOMs Node. So:
 *   - `trackSymbols` is off for the fixed-ladder accumulators (slices are
 *     only needed for the primary ladder);
 *   - the per-symbol record holds FLAT counters (no per-day map); the
 *     day-clustered bootstrap runs off the top-level side accumulator.
 */
class Accum {
  constructor(startTs, opts = {}) {
    this.startTs = startTs;
    this.trackSymbols = opts.trackSymbols !== false;
    this.n = 0;
    this.wins = 0;
    this.gross = 0;
    this.funding = 0;
    this.netMaker = 0;
    this.netTaker = 0;
    this.winSum = 0;
    this.winN = 0;
    this.lossSum = 0;
    this.lossN = 0;
    this.exits = { tp: 0, kill: 0, tie: 0, timeout: 0 };
    this.blocks = [0, 1, 2].map(() => ({ n: 0, netTaker: 0, wins: 0 }));
    this.sides = { long: this._side(), short: this._side() };
    this.sym = new Map(); // symbol -> { n, netTaker }
    // per symbol AND per side, flat counters, so a liquidity slice can be
    // assembled without re-running the simulation.
    this.symSide = new Map(); // symbol -> { long: SideAcc, short: SideAcc }
  }
  _side() {
    return {
      n: 0,
      wins: 0,
      gross: 0,
      funding: 0,
      netMaker: 0,
      netTaker: 0,
      blocks: [0, 1, 2].map(() => ({ n: 0, netTaker: 0, wins: 0 })),
      days: new Map(), // day -> { sum, n }
    };
  }
  add(tr) {
    const netTaker = tr.grossPct + tr.fundingPct - TAKER_FEE_PCT * 2;
    const netMaker = tr.grossPct + tr.fundingPct - MAKER_FEE_PCT * 2;
    const win = netTaker > 0;
    const b = Math.min(2, Math.max(0, Math.floor((tr.entryTs - this.startTs) / (30 * DAY))));
    this.n++;
    this.wins += win ? 1 : 0;
    this.gross += tr.grossPct;
    this.funding += tr.fundingPct;
    this.netMaker += netMaker;
    this.netTaker += netTaker;
    if (win) {
      this.winSum += netTaker;
      this.winN++;
    } else {
      this.lossSum += netTaker;
      this.lossN++;
    }
    this.exits[tr.exitType] = (this.exits[tr.exitType] ?? 0) + 1;
    this.blocks[b].n++;
    this.blocks[b].netTaker += netTaker;
    this.blocks[b].wins += win ? 1 : 0;
    const s = this.sides[tr.dir];
    s.n++;
    s.wins += win ? 1 : 0;
    s.gross += tr.grossPct;
    s.funding += tr.fundingPct;
    s.netMaker += netMaker;
    s.netTaker += netTaker;
    s.blocks[b].n++;
    s.blocks[b].netTaker += netTaker;
    s.blocks[b].wins += win ? 1 : 0;
    const day = Math.floor(tr.entryTs / DAY);
    const dm = s.days.get(day);
    if (dm) {
      dm.sum += netTaker;
      dm.n++;
    } else {
      s.days.set(day, { sum: netTaker, n: 1 });
    }
    if (tr.symbol && this.trackSymbols) {
      const sm = this.sym.get(tr.symbol);
      if (sm) {
        sm.n++;
        sm.netTaker += netTaker;
      } else {
        this.sym.set(tr.symbol, { n: 1, netTaker });
      }
      let per = this.symSide.get(tr.symbol);
      if (!per) {
        per = { long: this._flatSide(), short: this._flatSide() };
        this.symSide.set(tr.symbol, per);
      }
      const ps = per[tr.dir];
      ps.n++;
      ps.wins += win ? 1 : 0;
      ps.gross += tr.grossPct;
      ps.funding += tr.fundingPct;
      ps.netMaker += netMaker;
      ps.netTaker += netTaker;
      ps.blocks[b].n++;
      ps.blocks[b].netTaker += netTaker;
      ps.blocks[b].wins += win ? 1 : 0;
    }
  }
  /** Flat per-symbol side record — no nested Maps (memory). */
  _flatSide() {
    return {
      n: 0,
      wins: 0,
      gross: 0,
      funding: 0,
      netMaker: 0,
      netTaker: 0,
      blocks: [0, 1, 2].map(() => ({ n: 0, netTaker: 0, wins: 0 })),
    };
  }
  /**
   * Build an accumulator over a symbol subset. The top-level side day maps
   * cannot be reconstructed from flat per-symbol records, so a slice has no
   * clustered bootstrap — the primary accumulator's CI is reported instead.
   */
  slice(symbols) {
    const out = new Accum(this.startTs, { trackSymbols: false });
    for (const [sym, per] of this.symSide) {
      if (symbols && !symbols.has(sym)) continue;
      for (const dir of ["long", "short"]) {
        const src = per[dir];
        const dst = out.sides[dir];
        dst.n += src.n;
        dst.wins += src.wins;
        dst.gross += src.gross;
        dst.funding += src.funding;
        dst.netMaker += src.netMaker;
        dst.netTaker += src.netTaker;
        for (let b = 0; b < 3; b++) {
          dst.blocks[b].n += src.blocks[b].n;
          dst.blocks[b].wins += src.blocks[b].wins;
          dst.blocks[b].netTaker += src.blocks[b].netTaker;
        }
        out.n += src.n;
        out.wins += src.wins;
        out.gross += src.gross;
        out.funding += src.funding;
        out.netMaker += src.netMaker;
        out.netTaker += src.netTaker;
        for (let b = 0; b < 3; b++) {
          out.blocks[b].n += src.blocks[b].n;
          out.blocks[b].wins += src.blocks[b].wins;
          out.blocks[b].netTaker += src.blocks[b].netTaker;
        }
      }
    }
    return out;
  }
}

/** Day-clustered bootstrap CI for a side's mean taker P&L. */
function bootFromDays(days, iters = 2000) {
  const keys = [...days.keys()];
  const nDays = keys.length;
  if (nDays < 5) return null;
  const sums = keys.map((k) => days.get(k).sum);
  const counts = keys.map((k) => days.get(k).n);
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const means = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < nDays; k++) {
      const idx = Math.floor(rand() * nDays);
      s += sums[idx];
      c += counts[idx];
    }
    if (c > 0) means.push(s / c);
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return {
    ci95Low: q(0.025),
    ci95High: q(0.975),
    pMeanNotGreaterThanZero: means.filter((m) => m <= 0).length / means.length,
    days: nDays,
  };
}

/* ------------------------------------------------------------------ */
/* paired within-day session test                                     */
/* ------------------------------------------------------------------ */

/**
 * The session family is the ONLY thing that beats the unconditional
 * baseline in this study, so it deserves the repo's own "matched placebo"
 * discipline (see the `kucoin-futures-data` skill): an unpaired window mean
 * can be pure market drift.
 *
 * This accumulator answers the paired question — WITHIN the same symbol and
 * the same UTC day, is the long/short P&L inside a 3-hour window different
 * from the P&L outside it?
 *
 *   delta(day, window) = mean(net | bar inside window, all symbols that day)
 *                        - mean(net | bar outside window, all symbols that day)
 *
 * Pairing within (symbol, day) removes both the market drift and the
 * symbol-level heterogeneity that made the prior review's unpaired funding
 * window look like an edge. A day-clustered bootstrap over the 91 daily
 * deltas then gives the CI.
 */
class PairedSession {
  constructor(nSym, nDays) {
    this.nSym = nSym;
    this.nDays = nDays;
    this.nHours = 24;
    const cells = nSym * nDays * 24;
    // Per (symbol, day, hour) sums and counts, so a paired report can be
    // produced for ANY symbol subset (a liquidity slice) without re-running
    // the simulation. Flat typed arrays: ~13 MB per direction.
    this.sums = { long: new Float64Array(cells), short: new Float64Array(cells) };
    this.counts = { long: new Int32Array(cells), short: new Int32Array(cells) };
    // hour -> list of windows containing that hour (precomputed)
    this.inWindows = [];
    for (let h = 0; h < 24; h++) {
      const list = [];
      for (let w = 0; w < 24; w++) {
        const h1 = w + 3;
        if (h1 <= 24 ? h >= w && h < h1 : h >= w || h < h1 - 24) list.push(w);
      }
      this.inWindows.push(list);
    }
  }
  add(symIdx, dir, hour, dayIdx, net) {
    if (dayIdx < 0 || dayIdx >= this.nDays) return;
    const idx = (symIdx * this.nDays + dayIdx) * 24 + hour;
    this.sums[dir][idx] += net;
    this.counts[dir][idx] += 1;
  }
  /**
   * Per-window paired result for one direction, over a symbol subset.
   *   delta(day) = mean(net | bars inside w that day) - mean(net | bars outside w that day)
   * Pooled across the subset's symbols within each day, then bootstrapped
   * over days.
   */
  report(dir, symIdx = null, opts = {}) {
    const out = [];
    const symList = symIdx ?? Array.from({ length: this.nSym }, (_, i) => i);
    for (let w = 0; w < 24; w++) {
      const days = [];
      let inTrades = 0;
      let outTrades = 0;
      for (let d = 0; d < this.nDays; d++) {
        let inSum = 0;
        let inN = 0;
        let outSum = 0;
        let outN = 0;
        for (const si of symList) {
          const base = (si * this.nDays + d) * 24;
          for (let h = 0; h < 24; h++) {
            const c = this.counts[dir][base + h];
            if (c === 0) continue;
            const s = this.sums[dir][base + h];
            if (this.inWindows[h].includes(w)) {
              inSum += s;
              inN += c;
            } else {
              outSum += s;
              outN += c;
            }
          }
        }
        if (inN === 0 || outN === 0) continue;
        days.push(inSum / inN - outSum / outN);
        inTrades += inN;
        outTrades += outN;
      }
      if (days.length < 10) {
        out.push({ window: w, days: days.length, mean: null });
        continue;
      }
      const mean = days.reduce((a, b) => a + b, 0) / days.length;
      let seed = 987654321;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const means = [];
      for (let it = 0; it < 2000; it++) {
        let s = 0;
        for (let k = 0; k < days.length; k++) s += days[Math.floor(rand() * days.length)];
        means.push(s / days.length);
      }
      means.sort((a, b) => a - b);
      const q = (p) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
      const rec = {
        window: w,
        days: days.length,
        mean,
        ci95Low: q(0.025),
        ci95High: q(0.975),
        pMeanNotGreaterThanZero: means.filter((m) => m <= 0).length / means.length,
        inTrades,
        outTrades,
        dailyDeltas: opts.keepDaily ? days : undefined,
      };
      if (opts.perSymbol) {
        // Per-symbol paired delta for this window — the consistency check.
        const perSym = [];
        for (const si of symList) {
          let iS = 0;
          let iN = 0;
          let oS = 0;
          let oN = 0;
          for (let d = 0; d < this.nDays; d++) {
            const base = (si * this.nDays + d) * 24;
            for (let h = 0; h < 24; h++) {
              const c = this.counts[dir][base + h];
              if (c === 0) continue;
              const s = this.sums[dir][base + h];
              if (this.inWindows[h].includes(w)) {
                iS += s;
                iN += c;
              } else {
                oS += s;
                oN += c;
              }
            }
          }
          if (iN === 0 || oN === 0) continue;
          perSym.push({ symIdx: si, delta: iS / iN - oS / oN, inN: iN, outN: oN });
        }
        rec.perSymbol = perSym;
      }
      out.push(rec);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* statistics                                                         */
/* ------------------------------------------------------------------ */

function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26 erf approximation.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Two-sided binomial test of WR against the breakeven WR. */
function binomTwoSided(k, n, p0) {
  if (n <= 0 || !(p0 > 0) || !(p0 < 1)) return 1;
  const mean = n * p0;
  const sd = Math.sqrt(n * p0 * (1 - p0));
  if (sd < 1e-9) return 1;
  const z = Math.max(0, (Math.abs(k - mean) - 0.5) / sd);
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

/** Turn an Accum into the reported summary shape + the pass/fail verdict. */
function summarize(acc) {
  const avgWin = acc.winN ? acc.winSum / acc.winN : 0;
  const avgLoss = acc.lossN ? acc.lossSum / acc.lossN : 0;
  const wr = acc.n ? (acc.wins / acc.n) * 100 : 0;
  const breakevenWr =
    avgWin > 0 && avgLoss < 0 ? (Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss))) * 100 : wr;
  const bySide = {};
  for (const d of ["long", "short"]) {
    const s = acc.sides[d];
    const blocks = s.blocks.map((b) => ({
      n: b.n,
      wr: b.n ? (b.wins / b.n) * 100 : 0,
      netTakerPct: b.netTaker,
      expTakerPct: b.n ? b.netTaker / b.n : 0,
    }));
    const boot = bootFromDays(s.days);
    const why = [];
    const expTaker = s.n ? s.netTaker / s.n : 0;
    const blocksPositive = s.blocks.filter((b) => b.n > 0 && b.netTaker > 0).length;
    if (!(expTaker > 0)) why.push("taker expectancy <= 0");
    if (blocksPositive < 2) why.push(`only ${blocksPositive}/3 blocks positive`);
    if (s.n < 30) why.push(`n=${s.n} < 30`);
    bySide[d] = {
      n: s.n,
      wr: s.n ? (s.wins / s.n) * 100 : 0,
      grossPct: s.gross,
      fundingPct: s.funding,
      grossExpPct: s.n ? s.gross / s.n : 0,
      fundingExpPct: s.n ? s.funding / s.n : 0,
      netMakerPct: s.netMaker,
      netTakerPct: s.netTaker,
      expMakerPct: s.n ? s.netMaker / s.n : 0,
      expTakerPct: expTaker,
      bootTaker: boot,
      blocks,
      blocksPositive,
      blocksWithData: s.blocks.filter((b) => b.n > 0).length,
      clearsBar: why.length === 0,
      why,
    };
  }
  return {
    n: acc.n,
    wins: acc.wins,
    wr,
    grossPct: acc.gross,
    fundingPct: acc.funding,
    netMakerPct: acc.netMaker,
    netTakerPct: acc.netTaker,
    expMakerPct: acc.n ? acc.netMaker / acc.n : 0,
    expTakerPct: acc.n ? acc.netTaker / acc.n : 0,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    breakevenWr,
    pValue: binomTwoSided(acc.wins, acc.n, breakevenWr / 100),
    exits: acc.exits,
    blocks: acc.blocks.map((b) => ({
      n: b.n,
      wr: b.n ? (b.wins / b.n) * 100 : 0,
      netTakerPct: b.netTaker,
      expTakerPct: b.n ? b.netTaker / b.n : 0,
    })),
    blocksPositive: acc.blocks.filter((b) => b.n > 0 && b.netTaker > 0).length,
    bySide,
    clearsBar: bySide.long.clearsBar || bySide.short.clearsBar,
    clearingSides: ["long", "short"].filter((s) => bySide[s].clearsBar),
  };
}

/* ------------------------------------------------------------------ */
/* per-symbol context                                                 */
/* ------------------------------------------------------------------ */

function buildSymbolContext(bars1, bars4, funding) {
  const n = bars1.length;
  const closes = new Float64Array(n);
  const highs = new Float64Array(n);
  const lows = new Float64Array(n);
  const opens = new Float64Array(n);
  const vols = new Float64Array(n);
  const turnovers = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    closes[i] = bars1[i].c;
    highs[i] = bars1[i].h;
    lows[i] = bars1[i].l;
    opens[i] = bars1[i].o;
    vols[i] = bars1[i].v;
    turnovers[i] = bars1[i].t;
  }
  const cl = Array.from(closes);

  const atrPct = atrPctHouse(bars1, 14);
  const rsi14 = rsi(cl, 14);
  const e12 = ema(cl, 12);
  const e26 = ema(cl, 26);
  const line = cl.map((_, i) => e12[i] - e26[i]);
  const sig = ema(line, 9);
  const hist = line.map((v, i) => v - sig[i]);
  const ema20 = ema(cl, 20);
  const volMed48 = rollingPriorMedian(Array.from(vols), 48);
  const atrMean100 = rollingPriorMean(atrPct, 100);
  const hours = new Uint8Array(n);
  for (let i = 0; i < n; i++) hours[i] = new Date(bars1[i].ts).getUTCHours();

  // prior-N-bar extremes (current bar excluded)
  const priorHigh = {};
  const priorLow = {};
  for (const look of [24, 48]) {
    priorHigh[look] = rollingPriorExtreme(Array.from(highs), look, "max");
    priorLow[look] = rollingPriorExtreme(Array.from(lows), look, "min");
  }

  // The repo's fadeMetrics inputs, precomputed over trailing-24 CLOSES:
  // vratio (recent-12h mean / prior-12h mean), offHighPct, offLowPct.
  // NOTE: these MUST be NaN-initialised. A Float64Array defaults to 0, and a
  // 0 vratio would look like "volume collapsed" and fire a spurious signal on
  // the very first bar. (This was a real bug — caught by the validation pass.)
  const vratio24 = new Float64Array(n).fill(NaN);
  const offHigh24 = new Float64Array(n).fill(NaN);
  const offLow24 = new Float64Array(n).fill(NaN);
  for (let i = 23; i < n; i++) {
    let rsum = 0;
    let psum = 0;
    for (let j = i - 11; j <= i; j++) rsum += vols[j];
    for (let j = i - 23; j <= i - 12; j++) psum += vols[j];
    const rm = rsum / 12;
    const pm = psum / 12;
    vratio24[i] = pm > 0 ? rm / pm : NaN;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - 23; j <= i; j++) {
      if (closes[j] > hi) hi = closes[j];
      if (closes[j] < lo) lo = closes[j];
    }
    const last = closes[i];
    offHigh24[i] = hi > 0 ? ((hi - last) / hi) * 100 : NaN;
    offLow24[i] = lo > 0 ? ((last - lo) / lo) * 100 : NaN;
  }

  // 4h context: the last COMPLETED 4h bar at each 1h bar's close.
  // Precomputed as an index array — a shared moving pointer would be wrong
  // when candidates are evaluated in separate passes over i.
  const mt4idx = new Int32Array(n).fill(-1);
  const mt4close = new Float64Array(n);
  const mt4ema = new Float64Array(n);
  if (bars4.length) {
    const closes4 = bars4.map((b) => b.c);
    const ema20_4 = ema(closes4, 20);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const closeTs = bars1[i].ts + HOUR; // the 1h bar's own close time
      while (p + 1 < bars4.length && bars4[p + 1].ts + 4 * HOUR <= closeTs) p++;
      mt4idx[i] = p;
      mt4close[i] = closes4[p];
      mt4ema[i] = ema20_4[p];
    }
  }

  // The settlement in force at each 1h bar (most recent at or before its open).
  const settlementAt = new Array(n).fill(null);
  {
    let fi = 0;
    for (let i = 0; i < n; i++) {
      while (fi + 1 < funding.length && funding[fi + 1].ts <= bars1[i].ts) fi++;
      if (funding.length && funding[fi].ts <= bars1[i].ts) {
        settlementAt[i] = { rate: funding[fi].rate, ageH: (bars1[i].ts - funding[fi].ts) / HOUR };
      }
    }
  }

  // Hourly funding prefix sums for O(1) holding-window funding.
  let fundMinHour = Infinity;
  for (const f of funding) fundMinHour = Math.min(fundMinHour, Math.floor(f.ts / HOUR));
  if (!Number.isFinite(fundMinHour)) fundMinHour = 0;
  const maxHour = n > 0 ? Math.floor(bars1[n - 1].ts / HOUR) : fundMinHour;
  const fundPrefix = new Float64Array(Math.max(1, maxHour - fundMinHour + 2));
  {
    const rateByHour = new Map();
    for (const f of funding) {
      const h = Math.floor(f.ts / HOUR);
      rateByHour.set(h, (rateByHour.get(h) ?? 0) + f.rate);
    }
    let acc = 0;
    for (let h = fundMinHour; h <= maxHour + 1; h++) {
      acc += rateByHour.get(h) ?? 0;
      fundPrefix[h - fundMinHour + 1] = acc;
    }
  }

  // Median hourly turnover over the window (USD) — an IN-WINDOW liquidity
  // ranking, NOT today's turnover snapshot (that would be look-ahead).
  const sortedTurn = [...turnovers].filter((t) => t > 0).sort((a, b) => a - b);
  const medianTurnover = sortedTurn.length ? sortedTurn[Math.floor(sortedTurn.length / 2)] : 0;

  return {
    bars: bars1,
    closes,
    highs,
    lows,
    opens,
    vols,
    atrPct,
    rsi14,
    macd: { line, sig, hist },
    ema20,
    volMed48,
    atrMean100,
    priorHigh,
    priorLow,
    hours,
    vratio24,
    offHigh24,
    offLow24,
    settlementAt,
    mt4idx,
    mt4close,
    mt4ema,
    funding,
    fundPrefix,
    fundMinHour,
    medianTurnover,
  };
}

/* ------------------------------------------------------------------ */
/* candidate definitions                                              */
/* ------------------------------------------------------------------ */

/**
 * Each candidate is a pure function (ctx, i) -> "long" | "short" | null,
 * computed from data through bar i only.
 */
function buildCandidates() {
  const C = [];
  const add = (id, family, def, fn, opts = {}) =>
    C.push({ id, family, def, fn, entry: opts.entry ?? "next_open" });

  const breakoutDir = (ctx, i, look, vmult) => {
    if (i < look + 48) return null;
    const hi = ctx.priorHigh[look][i];
    const lo = ctx.priorLow[look][i];
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
    if (vmult > 0) {
      const vm = ctx.volMed48[i];
      if (!Number.isFinite(vm) || !(vm > 0) || !(ctx.vols[i] > vmult * vm)) return null;
    }
    if (ctx.closes[i] > hi) return "long";
    if (ctx.closes[i] < lo) return "short";
    return null;
  };
  const rsiDir = (ctx, i, lo, hi) => {
    const r = ctx.rsi14[i];
    if (!Number.isFinite(r)) return null;
    if (r < lo) return "long";
    if (r > hi) return "short";
    return null;
  };
  const macdCrossDir = (ctx, i) => {
    if (i < 40) return null;
    const { line, sig } = ctx.macd;
    if (!Number.isFinite(line[i - 1]) || !Number.isFinite(line[i])) return null;
    if (!Number.isFinite(sig[i - 1]) || !Number.isFinite(sig[i])) return null;
    if (line[i - 1] <= sig[i - 1] && line[i] > sig[i]) return "long";
    if (line[i - 1] >= sig[i - 1] && line[i] < sig[i]) return "short";
    return null;
  };
  const macdHistDir = (ctx, i) => {
    if (i < 40) return null;
    const { hist } = ctx.macd;
    if (!Number.isFinite(hist[i - 1]) || !Number.isFinite(hist[i])) return null;
    if (hist[i - 1] < 0 && hist[i] > 0) return "long";
    if (hist[i - 1] > 0 && hist[i] < 0) return "short";
    return null;
  };
  const volSpikeDir = (ctx, i, mult, fade) => {
    if (i < 50) return null;
    const vm = ctx.volMed48[i];
    if (!Number.isFinite(vm) || !(vm > 0) || !(ctx.vols[i] > mult * vm)) return null;
    const up = ctx.closes[i] > ctx.opens[i];
    const down = ctx.closes[i] < ctx.opens[i];
    if (fade) return down ? "long" : up ? "short" : null;
    return up ? "long" : down ? "short" : null;
  };
  const hiReg = (ctx, i) => Number.isFinite(ctx.atrMean100[i]) && ctx.atrPct[i] > ctx.atrMean100[i];
  const loReg = (ctx, i) => Number.isFinite(ctx.atrMean100[i]) && ctx.atrPct[i] < ctx.atrMean100[i];
  const mtfAgrees = (ctx, i, dir) => {
    if (ctx.mt4idx[i] < 0) return false;
    const e = ctx.mt4ema[i];
    if (!Number.isFinite(e)) return false;
    return dir === "long" ? ctx.mt4close[i] > e : ctx.mt4close[i] < e;
  };

  /* --- A. momentum breakout --- */
  for (const look of [24, 48]) {
    for (const vmult of [1.5, 3.0]) {
      add(
        `A_brk${look}_v${String(vmult).replace(".", "")}`,
        "momentum-breakout",
        `LONG when close[i] > max(high[i-${look}..i-1]) AND vol[i] > ${vmult}x median(vol, prior 48); SHORT mirror`,
        (ctx, i) => breakoutDir(ctx, i, look, vmult),
      );
    }
    add(
      `A_brk${look}_novol`,
      "momentum-breakout",
      `LONG when close[i] > max(high[i-${look}..i-1]); SHORT mirror (no volume filter)`,
      (ctx, i) => breakoutDir(ctx, i, look, 0),
    );
  }

  /* --- B. mean reversion / momentum from oscillators --- */
  for (const [lo, hi, tag] of [
    [30, 70, "3070"],
    [20, 80, "2080"],
    [25, 75, "2575"],
  ]) {
    add(
      `B_rsi14_${tag}`,
      "mean-reversion",
      `LONG when RSI(14) < ${lo}; SHORT when RSI(14) > ${hi}`,
      (ctx, i) => rsiDir(ctx, i, lo, hi),
    );
  }
  add(
    "B_macd_hist_rev",
    "mean-reversion",
    "LONG when MACD(12,26,9) histogram crosses negative -> positive; SHORT mirror (fade the extreme)",
    (ctx, i) => macdHistDir(ctx, i),
  );
  add(
    "B_macd_cross",
    "momentum",
    "LONG when the MACD line crosses above its 9-period signal; SHORT mirror (continuation)",
    (ctx, i) => macdCrossDir(ctx, i),
  );

  /* --- C. volume spike continuation / fade --- */
  for (const mult of [2, 3]) {
    add(
      `C_vol${mult}_cont`,
      "volume-spike",
      `vol[i] > ${mult}x median(vol, prior 48); direction = sign(close[i]-open[i]) (continuation)`,
      (ctx, i) => volSpikeDir(ctx, i, mult, false),
    );
    add(
      `C_vol${mult}_fade`,
      "volume-spike",
      `vol[i] > ${mult}x median(vol, prior 48); direction = -sign(close[i]-open[i]) (fade the spike)`,
      (ctx, i) => volSpikeDir(ctx, i, mult, true),
    );
  }

  /* --- D. funding-rate extremes --- */
  for (const [thr, tag] of [
    [0.03, "003"],
    [0.1, "010"],
  ]) {
    add(
      `D_fundfade_${tag}`,
      "funding-extreme",
      `SHORT while the in-force funding rate is > +${thr}%; LONG while it is < -${thr}%`,
      (ctx, i) => {
        const s = ctx.settlementAt[i];
        if (!s) return null;
        const ratePct = s.rate * 100;
        if (ratePct > thr) return "short";
        if (ratePct < -thr) return "long";
        return null;
      },
    );
  }
  add(
    "D_fundcont_003",
    "funding-extreme",
    "LONG while the in-force funding rate is > +0.03% (continuation); SHORT while it is < -0.03%",
    (ctx, i) => {
      const s = ctx.settlementAt[i];
      if (!s) return null;
      const ratePct = s.rate * 100;
      if (ratePct > 0.03) return "long";
      if (ratePct < -0.03) return "short";
      return null;
    },
  );

  /* --- E. session of day (UTC) --- */
  for (const [name, h0, h1] of [
    ["asia", 0, 2],
    ["london", 7, 10],
    ["ny", 12, 15],
    ["postfund", 16, 18],
    ["usclose", 20, 23],
  ]) {
    for (const dir of ["long", "short"]) {
      add(
        `E_${name}_${dir}`,
        "session-tod",
        `${dir.toUpperCase()} on every bar whose UTC hour is in [${h0}, ${h1})`,
        (ctx, i) => (ctx.hours[i] >= h0 && ctx.hours[i] < h1 ? dir : null),
      );
    }
  }

  /* --- E2. session PLACEBO: every rolling 3-hour window, both directions.
     The session family above tests 5 named windows. If a named window looks
     good, the honest question is whether it beats the OTHER 19 windows of
     the same shape. This family provides that null distribution INSIDE the
     same script, on the same data, with the same fee and tie rules — so
     "the best hour" can be compared against its own placebo instead of
     against zero. --- */
  for (let h0 = 0; h0 < 24; h0++) {
    const h1 = h0 + 3;
    for (const dir of ["long", "short"]) {
      add(
        `E2_h${String(h0).padStart(2, "0")}_${dir}`,
        "session-placebo",
        `PLACEBO: ${dir.toUpperCase()} on every bar whose UTC hour is in [${h0}, ${h1}) (wrapping past 23 into the next day); one of 24 identical-shape windows, used to price the session effect against its own null`,
        (ctx, i) => {
          const h = ctx.hours[i];
          const inWindow = h1 <= 24 ? h >= h0 && h < h1 : h >= h0 || h < h1 - 24;
          return inWindow ? dir : null;
        },
      );
    }
  }

  /* --- F. volatility-regime gates --- */
  add(
    "F_brk24_v15_hiATR",
    "vol-regime",
    "A_brk24_v1.5 restricted to ATR% above its prior-100-bar mean",
    (ctx, i) => (hiReg(ctx, i) ? breakoutDir(ctx, i, 24, 1.5) : null),
  );
  add(
    "F_brk24_v15_loATR",
    "vol-regime",
    "A_brk24_v1.5 restricted to ATR% below its prior-100-bar mean",
    (ctx, i) => (loReg(ctx, i) ? breakoutDir(ctx, i, 24, 1.5) : null),
  );
  add(
    "F_rsi3070_hiATR",
    "vol-regime",
    "B_rsi14_3070 restricted to ATR% above its prior-100-bar mean",
    (ctx, i) => (hiReg(ctx, i) ? rsiDir(ctx, i, 30, 70) : null),
  );
  add(
    "F_rsi3070_loATR",
    "vol-regime",
    "B_rsi14_3070 restricted to ATR% below its prior-100-bar mean",
    (ctx, i) => (loReg(ctx, i) ? rsiDir(ctx, i, 30, 70) : null),
  );

  /* --- G. multi-timeframe alignment --- */
  add(
    "G_mtf4h_brk24",
    "mtf-alignment",
    "A_brk24_v1.5 AND the last COMPLETED 4h bar closes on the same side of its 4h EMA(20)",
    (ctx, i) => {
      const d = breakoutDir(ctx, i, 24, 1.5);
      return d && mtfAgrees(ctx, i, d) ? d : null;
    },
  );
  add(
    "G_mtf4h_rsi",
    "mtf-alignment",
    "B_rsi14_3070 AND the last COMPLETED 4h bar closes on the same side of its 4h EMA(20)",
    (ctx, i) => {
      const d = rsiDir(ctx, i, 30, 70);
      return d && mtfAgrees(ctx, i, d) ? d : null;
    },
  );
  add(
    "G_mtf4h_macd",
    "mtf-alignment",
    "B_macd_cross AND the last COMPLETED 4h bar closes on the same side of its 4h EMA(20)",
    (ctx, i) => {
      const d = macdCrossDir(ctx, i);
      return d && mtfAgrees(ctx, i, d) ? d : null;
    },
  );

  /* --- H. combinations --- */
  add(
    "H_brk24_and_vol2",
    "combination",
    "A_brk24_v1.5 AND vol[i] > 2x median(vol, prior 48)",
    (ctx, i) => {
      const d = breakoutDir(ctx, i, 24, 1.5);
      if (!d) return null;
      const vm = ctx.volMed48[i];
      if (!Number.isFinite(vm) || !(vm > 0) || !(ctx.vols[i] > 2 * vm)) return null;
      return d;
    },
  );
  add(
    "H_rsi3070_and_vol2",
    "combination",
    "B_rsi14_3070 AND vol[i] > 2x median(vol, prior 48)",
    (ctx, i) => {
      const d = rsiDir(ctx, i, 30, 70);
      if (!d) return null;
      const vm = ctx.volMed48[i];
      if (!Number.isFinite(vm) || !(vm > 0) || !(ctx.vols[i] > 2 * vm)) return null;
      return d;
    },
  );
  add(
    "H_mtf4h_brk24_loATR",
    "combination",
    "G_mtf4h_brk24 AND ATR% below its prior-100-bar mean",
    (ctx, i) => {
      if (!loReg(ctx, i)) return null;
      const d = breakoutDir(ctx, i, 24, 1.5);
      return d && mtfAgrees(ctx, i, d) ? d : null;
    },
  );

  /* --- Z. controls --- */
  add("Z_always_long", "control", "LONG on every bar (unconditional baseline — prices the null)", () => "long");
  add("Z_always_short", "control", "SHORT on every bar (unconditional baseline — prices the null)", () => "short");

  /* The known-broken fade/dip signal, replicated EXACTLY as the repo's
     `backtestScalp` computes it (src/kucoin.ts): fadeMetrics over the trailing
     24 CLOSES, fadeSignal/dipSignal with the "late"/"extended" suppressors,
     entry at the signal bar's CLOSE. Used to validate this pipeline against
     the shipped numbers, and reported as the incumbent baseline.

     Direction note: the repo charges an ambiguous bar (both signals fire) as
     a SHORT — `condDir = sSig === "fade-short" ? "short" : "long"`. We
     replicate that so the comparison is apples-to-apples. */
  add(
    "Z_fade_dip_repo",
    "control",
    "the shipped fade/dip signal, replicated from src/kucoin.ts: trailing-24-CLOSE fadeMetrics, fadeSignal/dipSignal with the late/extended suppressors, entry at the signal bar's CLOSE (repo convention)",
    (ctx, i) => {
      if (i < 24) return null;
      const vratio = ctx.vratio24[i];
      if (!Number.isFinite(vratio)) return null;
      const offHigh = ctx.offHigh24[i];
      const offLow = ctx.offLow24[i];
      if (!Number.isFinite(offHigh) || !Number.isFinite(offLow)) return null;
      let sSig = "neutral";
      if (offHigh > 15) sSig = "late";
      else if (vratio < 0.85 && offHigh < 8) sSig = "fade-short";
      else if (vratio > 3) sSig = "strong";
      let lSig = "neutral";
      if (offLow > 15) lSig = "extended";
      else if (vratio > 3) lSig = "capitulation";
      else if (vratio < 0.85 && offLow < 8) lSig = "dip-long";
      if (sSig === "fade-short" || lSig === "dip-long") {
        // repo convention: fade-short wins when both fire (short)
        return sSig === "fade-short" ? "short" : "long";
      }
      return null;
    },
    { entry: "signal_close" },
  );

  return C;
}

/* ------------------------------------------------------------------ */
/* pipeline validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate this pipeline against the repo's OWN shipped engine
 * (`backtestScalp` + `fadeMetrics` from src/kucoin.ts, compiled to dist/).
 *
 * Two comparisons, because "the same number" can hide two different errors:
 *
 *  1. SIGNAL FIDELITY — run the repo's fadeMetrics/fadeSignal/dipSignal over
 *     the same klines and check that this file's replicated signal fires on
 *     exactly the same bars with exactly the same directions.
 *
 *  2. TRADE FIDELITY — replay the repo's exact trade loop (entry at the
 *     signal bar's CLOSE, one position at a time, ties resolved as the repo
 *     resolves them) using this file's simulator, and check that the
 *     per-trade P&L matches the repo's trade-by-trade.
 *
 * If both match, any difference in the headline numbers is a real difference
 * in MEASUREMENT RULES (this file charges ties as losses and fills at the
 * next open), not a bug in the fetch, the indicators, or the ladder.
 */
async function validateAgainstRepo(cfg, fromMs, toMs) {
  const dist = join(HERE, "..", "dist", "kucoin.js");
  const repo = await import(dist);
  const { backtestScalp, fadeMetrics, fadeSignal, dipSignal } = repo;

  const symbol = "ETHUSDTM";
  const rawRows = await fetchKlines(symbol, 60, fromMs, toMs, cfg.cacheDir);
  // ONE filter, applied to both paths, so the bar indices line up exactly.
  const rows = rawRows.filter(
    (k) => k.c > 0 && k.h >= k.l && Number.isFinite(k.v) && Number.isFinite(k.o),
  );
  const klines = rows.map((k) => ({ open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v }));

  const out = { symbol, candles: klines.length };

  const closes = klines.map((k) => k.close);
  const vols = klines.map((k) => k.volume);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);

  // ---- 1. signal fidelity ----
  const repoSignals = []; // { i, dir, ambiguous }
  for (let i = 23; i < klines.length - 1; i++) {
    const m = fadeMetrics(
      closes.slice(i - 23, i + 1),
      vols.slice(i - 23, i + 1),
      highs.slice(i - 23, i + 1),
      lows.slice(i - 23, i + 1),
    );
    if (!m) continue;
    const row = { ...m, fundingPct: null, last: closes[i], symbol };
    const sSig = fadeSignal(row);
    const lSig = dipSignal(row);
    if (sSig === "fade-short" || lSig === "dip-long") {
      repoSignals.push({
        i,
        dir: sSig === "fade-short" ? "short" : "long",
        ambiguous: sSig === "fade-short" && lSig === "dip-long",
      });
    }
  }

  // This file's replicated signal, computed on the SAME filtered rows.
  const ctx = buildSymbolContext(rows, [], []);
  const mineSignals = [];
  for (let i = 23; i < ctx.closes.length - 1; i++) {
    const v = ctx.vratio24[i];
    if (!Number.isFinite(v)) continue;
    const offHigh = ctx.offHigh24[i];
    const offLow = ctx.offLow24[i];
    if (!Number.isFinite(offHigh) || !Number.isFinite(offLow)) continue;
    let sSig = "neutral";
    if (offHigh > 15) sSig = "late";
    else if (v < 0.85 && offHigh < 8) sSig = "fade-short";
    else if (v > 3) sSig = "strong";
    let lSig = "neutral";
    if (offLow > 15) lSig = "extended";
    else if (v > 3) lSig = "capitulation";
    else if (v < 0.85 && offLow < 8) lSig = "dip-long";
    if (sSig === "fade-short" || lSig === "dip-long") {
      mineSignals.push({
        i,
        dir: sSig === "fade-short" ? "short" : "long",
        ambiguous: sSig === "fade-short" && lSig === "dip-long",
      });
    }
  }
  const repoSet = new Set(repoSignals.map((s) => `${s.i}:${s.dir}`));
  const mineSet = new Set(mineSignals.map((s) => `${s.i}:${s.dir}`));
  let intersection = 0;
  for (const k of repoSet) if (mineSet.has(k)) intersection++;
  out.signal = {
    repoBars: repoSet.size,
    mineBars: mineSet.size,
    agreeing: intersection,
    mismatched: repoSet.size + mineSet.size - 2 * intersection,
  };

  // ---- 2. trade fidelity (the repo's MAIN series rules) ----
  // The repo's main series: entry at the signal bar's CLOSE, one position at
  // a time (i advances past the exit), ambiguous bars SKIPPED, intra-bar ties
  // resolved as a TP (its optimistic reading), ATR-derived TP/kill from its
  // own atrPct. Reproduce that loop exactly, then compare trade-by-trade
  // against the repo's own output.
  const repoTrade = backtestScalp(klines, { feePerSidePct: TAKER_FEE_PCT });
  const repoTrades = repoTrade.trades;
  const myTrades = [];
  let i = 23;
  while (i < klines.length - 1) {
    const sig = mineSignals.find((s) => s.i === i);
    if (!sig) {
      i++;
      continue;
    }
    const m = fadeMetrics(
      closes.slice(i - 23, i + 1),
      vols.slice(i - 23, i + 1),
      highs.slice(i - 23, i + 1),
      lows.slice(i - 23, i + 1),
    );
    const atr0 = m && m.atrPct != null && Number.isFinite(m.atrPct) && m.atrPct > 0 ? m.atrPct : 0.8;
    const tpPct = Math.min(0.5, Math.max(0.3, atr0 * 0.4));
    const killPct = Math.min(1.5, Math.max(0.6, atr0 * 0.9));
    const entryPx = closes[i];
    const sign = sig.dir === "long" ? 1 : -1;
    const tpPx = entryPx * (1 + (sign * tpPct) / 100);
    const killPx = entryPx * (1 - (sign * killPct) / 100);
    let exitPx = klines[Math.min(i + 24, klines.length - 1)].close;
    let end = Math.min(i + 24, klines.length - 1);
    let exit = "timeout";
    let ambiguous = false;
    for (let j = i + 1; j <= Math.min(i + 24, klines.length - 1); j++) {
      const b = klines[j];
      const tpHit = sig.dir === "long" ? b.high >= tpPx : b.low <= tpPx;
      const killHit = sig.dir === "long" ? b.low <= killPx : b.high >= killPx;
      if (tpHit && killHit) {
        ambiguous = true;
        exit = "tp";
        exitPx = tpPx;
        end = j;
        break;
      }
      if (tpHit || killHit) {
        exit = tpHit ? "tp" : "kill";
        exitPx = tpHit ? tpPx : killPx;
        end = j;
        break;
      }
      exitPx = b.close;
      end = j;
    }
    if (sig.ambiguous) {
      // The repo's MAIN series skips ambiguous bars — but it still walks the
      // holding window and advances past the exit, so the next tradable bar
      // is the same for both implementations.
      i = end + 1;
      continue;
    }
    const gross = ((exitPx - entryPx) / entryPx) * 100 * sign;
    myTrades.push({
      signalIndex: i,
      direction: sig.dir,
      entry: entryPx,
      exitPrice: exitPx,
      exit,
      grossPct: gross,
      netPct: gross - 2 * TAKER_FEE_PCT,
      ambiguous,
    });
    i = end + 1; // one position at a time, exactly like the repo
  }
  const repoSum = repoTrades.reduce((a, t) => a + t.netPct, 0);
  const mineSum = myTrades.reduce((a, t) => a + t.netPct, 0);
  const n = Math.min(repoTrades.length, myTrades.length);
  let maxAbsDiff = 0;
  let matched = 0;
  let exitMismatch = 0;
  let idxMismatch = 0;
  for (let k = 0; k < n; k++) {
    const d = Math.abs(repoTrades[k].netPct - myTrades[k].netPct);
    if (d < 1e-9) matched++;
    if (d > maxAbsDiff) maxAbsDiff = d;
    if (repoTrades[k].exit !== myTrades[k].exit) exitMismatch++;
    if (repoTrades[k].signalIndex !== myTrades[k].signalIndex) idxMismatch++;
  }
  out.trade = {
    repoTrades: repoTrades.length,
    myTrades: myTrades.length,
    matched,
    maxAbsDiffPct: maxAbsDiff,
    exitTypeMismatches: exitMismatch,
    signalIndexMismatches: idxMismatch,
    repoNet: repoSum,
    myNet: mineSum,
    repoExp: repoTrades.length ? repoSum / repoTrades.length : 0,
    myExp: myTrades.length ? mineSum / myTrades.length : 0,
    repoCondTrades: repoTrade.conditionalTrades,
    repoCondExp: repoTrade.expectancyPctConditional,
    repoCondNet: repoTrade.totalNetPctConditional,
  };
  return out;
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  mkdirSync(cfg.cacheDir, { recursive: true });
  const log = (...a) => console.error(...a);

  const toMs = Math.floor(Date.now() / HOUR) * HOUR;
  const fromMs = toMs - cfg.days * DAY;
  const startTs = fromMs;

  log(`[hunt-edge] window ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`);

  const contracts = (await getJson("/api/v1/contracts/active")).data;
  let universe = selectUniverse(contracts);
  log(`[hunt-edge] crypto USDT linear universe: ${universe.length}`);
  if (cfg.smoke) universe = universe.slice(0, 8);

  // ---- fetch klines (1h + 4h) and funding, bounded worker pool ----
  const data = new Map();
  let done = 0;
  const fetchOne = async (c) => {
    try {
      const [kl1, kl4, fr] = await Promise.all([
        fetchKlines(c.symbol, 60, fromMs, toMs, cfg.cacheDir),
        fetchKlines(c.symbol, 240, fromMs, toMs, cfg.cacheDir),
        fetchFunding(c.symbol, fromMs, toMs, cfg.cacheDir),
      ]);
      data.set(c.symbol, { meta: c, bars1: kl1, bars4: kl4, funding: fr });
    } catch (e) {
      log(`[hunt-edge] fetch failed ${c.symbol}: ${e.message}`);
    }
    done++;
    if (done % 50 === 0) log(`[hunt-edge] fetched ${done}/${universe.length}`);
  };
  const queue = [...universe];
  const workers = Array.from({ length: Math.min(cfg.workers, queue.length) }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      await fetchOne(c);
    }
  });
  await Promise.all(workers);
  log(`[hunt-edge] fetched ${data.size}/${universe.length} symbols`);

  const candidates = buildCandidates();

  // accumulators: candidateId -> { primary, fixed: Map(ladder -> Accum) }
  const acc = new Map();
  for (const cand of candidates) {
    acc.set(cand.id, {
      primary: new Accum(startTs, { trackSymbols: true }),
      // The fixed ladders do not need per-symbol tracking (liquidity slices
      // are only reported for the primary ladder). Tracking them would hold
      // 89 candidates x 11 ladders x 504 symbols x 2 sides in memory and
      // OOM Node.
      fixed: new Map(FIXED_LADDERS.map((l) => [l.name, new Accum(startTs, { trackSymbols: false })])),
    });
  }
  const signals = new Map();
  const skipped = new Map();
  for (const cand of candidates) {
    signals.set(cand.id, 0);
    skipped.set(cand.id, 0);
  }
  const symMedianTurnover = new Map();
  const barsSeen = { total: 0, min: Infinity, max: 0 };
  // The paired within-day session test: every hourly bar, long AND short,
  // charged against its own (day, window) complement.
  const nDays = Math.ceil(cfg.days * DAY / DAY) + 1;
  // Symbols are indexed by their position in a stable list, so the paired
  // arrays can be sliced by liquidity rank later without re-running. The
  // arrays are sized for the whole universe; only the used prefix counts.
  const symIndex = new Map();
  let symCounter = 0;
  const paired = new PairedSession(universe.length, nDays);

  for (const [symbol, d] of data) {
    const bars1 = d.bars1;
    if (bars1.length < 200) continue; // need indicator history + forward bars
    const ctx = buildSymbolContext(bars1, d.bars4, d.funding);
    const n = bars1.length;
    symMedianTurnover.set(symbol, ctx.medianTurnover);
    barsSeen.total += n;
    barsSeen.min = Math.min(barsSeen.min, n);
    barsSeen.max = Math.max(barsSeen.max, n);
    if (!symIndex.has(symbol)) {
      symIndex.set(symbol, symCounter++);
    }
    const symIdx = symIndex.get(symbol);

    // The paired within-day session test: on EVERY bar, trade both
    // directions with the house ladder and charge the result against its
    // own (day, window) complement. This is the "always trade everything"
    // series, which is what a session effect must beat ON TOP of.
    {
      const lad = ladderFromAtr(ctx.atrPct[0] ?? 0.8);
      for (let i = 0; i < n - 1; i++) {
        if (bars1[i + 1].ts !== bars1[i].ts + HOUR) continue;
        const dayIdx = Math.floor((bars1[i].ts - startTs) / DAY);
        for (const dir of ["long", "short"]) {
          const tr = simulateTrade(
            bars1,
            i + 1,
            bars1[i + 1].o,
            dir,
            lad.tpPct,
            lad.killPct,
            24,
            ctx.fundPrefix,
            ctx.fundMinHour,
            false,
          );
          if (!tr) continue;
          const net = tr.grossPct + tr.fundingPct - TAKER_FEE_PCT * 2;
          paired.add(symIdx, dir, ctx.hours[i], dayIdx, net);
        }
      }
    }

    for (const cand of candidates) {
      const bucket = acc.get(cand.id);
      for (let i = 0; i < n; i++) {
        const dir = cand.fn(ctx, i);
        if (!dir) continue;
        signals.set(cand.id, signals.get(cand.id) + 1);

        let entryIdx;
        let entryPx;
        let skipEntryBar = false;
        if (cand.entry === "signal_close") {
          entryIdx = i;
          entryPx = ctx.closes[i];
          skipEntryBar = true; // the fill is at this bar's CLOSE — its range is past
        } else {
          entryIdx = i + 1;
          if (entryIdx >= n) {
            skipped.set(cand.id, skipped.get(cand.id) + 1);
            continue;
          }
          // The next bar must be the contiguous hour, else the fill is fiction.
          if (bars1[entryIdx].ts !== bars1[i].ts + HOUR) {
            skipped.set(cand.id, skipped.get(cand.id) + 1);
            continue;
          }
          entryPx = bars1[entryIdx].o;
        }

        const lad = ladderFromAtr(ctx.atrPct[i]);
        const tr = simulateTrade(
          bars1,
          entryIdx,
          entryPx,
          dir,
          lad.tpPct,
          lad.killPct,
          24,
          ctx.fundPrefix,
          ctx.fundMinHour,
          skipEntryBar,
        );
        if (!tr) {
          skipped.set(cand.id, skipped.get(cand.id) + 1);
          continue;
        }
        tr.symbol = symbol;
        bucket.primary.add(tr);

        for (const L of FIXED_LADDERS) {
          const t2 = simulateTrade(
            bars1,
            entryIdx,
            entryPx,
            dir,
            L.tpPct,
            L.killPct,
            24,
            ctx.fundPrefix,
            ctx.fundMinHour,
            skipEntryBar,
          );
          if (t2) {
            t2.symbol = symbol;
            bucket.fixed.get(L.name).add(t2);
          }
        }
      }
    }
  }

  // ---- aggregate ----
  const agg = [];
  for (const cand of candidates) {
    const bucket = acc.get(cand.id);
    const s = summarize(bucket.primary);
    const symStats = [...bucket.primary.sym.entries()]
      .map(([symbol, v]) => ({ symbol, n: v.n, exp: v.netTaker / v.n }))
      .filter((x) => x.n >= 5)
      .sort((a, b) => b.exp - a.exp);
    agg.push({
      id: cand.id,
      family: cand.family,
      def: cand.def,
      entry: cand.entry,
      signals: signals.get(cand.id),
      skippedNoEntry: skipped.get(cand.id),
      ...s,
      symbolsTraded: bucket.primary.sym.size,
      symbolsWith5plus: symStats.length,
      symbolsPositive: symStats.filter((x) => x.exp > 0).length,
      symbolExpMedian: symStats.length
        ? symStats.map((x) => x.exp).sort((a, b) => a - b)[Math.floor(symStats.length / 2)]
        : 0,
      fixedLadders: FIXED_LADDERS.map((L) => ({
        ladder: L.name,
        ...summarize(bucket.fixed.get(L.name)),
      })),
    });
  }

  // ---- liquidity slices (in-window median hourly turnover) ----
  const liqRank = [...symMedianTurnover.entries()]
    .map(([sym, m]) => ({ sym, m }))
    .sort((a, b) => b.m - a.m);
  const sliceDefs = [
    { name: "ALL", symbols: null },
    { name: "LIQ_TOP150", symbols: new Set(liqRank.slice(0, 150).map((x) => x.sym)) },
    { name: "LIQ_TOP50", symbols: new Set(liqRank.slice(0, 50).map((x) => x.sym)) },
  ];
  const slices = {};
  for (const slice of sliceDefs) {
    slices[slice.name] = {};
    for (const cand of candidates) {
      const sub = acc.get(cand.id).primary.slice(slice.symbols);
      const s = summarize(sub);
      slices[slice.name][cand.id] = {
        n: s.n,
        wr: s.wr,
        expTakerPct: s.expTakerPct,
        expMakerPct: s.expMakerPct,
        netTakerPct: s.netTakerPct,
        blocksPositive: s.blocksPositive,
        long: {
          n: s.bySide.long.n,
          wr: s.bySide.long.wr,
          expTakerPct: s.bySide.long.expTakerPct,
          blocksPositive: s.bySide.long.blocksPositive,
          clearsBar: s.bySide.long.clearsBar,
        },
        short: {
          n: s.bySide.short.n,
          wr: s.bySide.short.wr,
          expTakerPct: s.bySide.short.expTakerPct,
          blocksPositive: s.bySide.short.blocksPositive,
          clearsBar: s.bySide.short.clearsBar,
        },
        clearsBar: s.clearsBar,
        clearingSides: s.clearingSides,
      };
    }
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      windowStart: new Date(fromMs).toISOString(),
      windowEnd: new Date(toMs).toISOString(),
      days: cfg.days,
      universeRequested: universe.length,
      universeFetched: data.size,
      universeUsed: symMedianTurnover.size,
      barsTotal: barsSeen.total,
      barsPerSymbolMin: barsSeen.min === Infinity ? 0 : barsSeen.min,
      barsPerSymbolMax: barsSeen.max,
      feeMakerPctPerSide: MAKER_FEE_PCT,
      feeTakerPctPerSide: TAKER_FEE_PCT,
      primaryLadder: "TP = clamp(ATR14% * 0.4, 0.30, 0.50); kill = clamp(ATR14% * 0.9, 0.60, 1.50); maxHold 24 bars",
      fixedLadders: FIXED_LADDERS,
      entryRule: "signal on bar i (data through bar i close) -> fill at OPEN of bar i+1; the next bar must be the contiguous hour",
      tieRule: "a bar touching BOTH the TP and the kill resolves as a LOSS at the kill price",
      fundingRule: "settlements inside the holding window charged at the symbol's real settled rate (long pays, short receives)",
      blocks: "three consecutive 30-day blocks over the window",
      bar: "per side: taker expectancy > 0 AND >= 2/3 blocks positive AND n >= 30",
      overlapNote:
        "every signal bar produces a trade; trades may overlap in time. This is a per-signal expectancy, not a portfolio P&L.",
      candidatesTested: agg.length,
    },
    candidates: agg,
    slices,
    liquidityRanking: liqRank.slice(0, 30).map((x) => ({ symbol: x.sym, medianHourlyTurnoverUsd: Math.round(x.m) })),
  };

  const outPath = cfg.out ?? join(cfg.cacheDir, "..", "results.json");
  const writeOut = () => {
    writeFileSync(outPath, JSON.stringify(out, null, 1));
    log(`[hunt-edge] wrote ${outPath}`);
  };

  // ---- console summary ----
  const pad = (s, n) => String(s).padEnd(n);
  const f = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "—");
  console.log("");
  console.log(
    `UNIVERSE ${out.meta.universeUsed} crypto USDT perps | ${out.meta.windowStart.slice(0, 10)}..${out.meta.windowEnd.slice(0, 10)} | candidates ${agg.length}`,
  );
  console.log("");
  console.log(
    pad("id", 20) +
      pad("sig", 8) +
      pad("n", 7) +
      pad("WR%", 8) +
      pad("expT", 10) +
      pad("expM", 10) +
      pad("blk+", 6) +
      pad("L expT", 10) +
      pad("L n", 7) +
      pad("S expT", 10) +
      pad("S n", 7) +
      pad("BAR", 8),
  );
  console.log("-".repeat(112));
  const sorted = [...agg].sort((a, b) => {
    const ae = Math.max(a.bySide.long.expTakerPct, a.bySide.short.expTakerPct);
    const be = Math.max(b.bySide.long.expTakerPct, b.bySide.short.expTakerPct);
    return be - ae;
  });
  for (const a of sorted) {
    console.log(
      pad(a.id, 20) +
        pad(a.signals, 8) +
        pad(a.n, 7) +
        pad(f(a.wr, 1), 8) +
        pad(f(a.expTakerPct), 10) +
        pad(f(a.expMakerPct), 10) +
        pad(a.blocksPositive + "/3", 6) +
        pad(f(a.bySide.long.expTakerPct), 10) +
        pad(a.bySide.long.n, 7) +
        pad(f(a.bySide.short.expTakerPct), 10) +
        pad(a.bySide.short.n, 7) +
        pad(a.clearsBar ? "YES" : "-", 8),
    );
  }
  const winners = agg.filter((a) => a.clearsBar);
  console.log("");
  console.log(
    `CLEARING THE BAR (per side): ${winners.length ? winners.map((w) => `${w.id} [${w.clearingSides.join("+")}]`).join(", ") : "NONE"}`,
  );

  // ---- pipeline validation against the repo's shipped backtest ----
  if (cfg.validate) {
    console.log("");
    console.log("PIPELINE VALIDATION — this pipeline vs the repo's shipped `backtest scalp` engine:");
    const v = await validateAgainstRepo(cfg, fromMs, toMs);
    console.log(`  ${v.symbol}: ${v.candles} x 1h candles`);
    console.log(
      `  SIGNAL fidelity : repo fired ${v.signal.repoBars} bars, this file fired ${v.signal.mineBars}, ` +
        `agreeing ${v.signal.agreeing}, mismatched ${v.signal.mismatched}`,
    );
    console.log(
      `  TRADE  fidelity : repo ${v.trade.repoTrades} trades, this file ${v.trade.myTrades}, ` +
        `exact P&L match on ${v.trade.matched}, max |diff| ${v.trade.maxAbsDiffPct.toExponential(2)}pp`,
    );
    console.log(
      `  TRADE  net      : repo ${v.trade.repoNet.toFixed(3)}% (exp ${v.trade.repoExp.toFixed(4)}%) vs ` +
        `this file ${v.trade.myNet.toFixed(3)}% (exp ${v.trade.myExp.toFixed(4)}%)`,
    );
    console.log(
      `  repo's own CONDITIONAL (honest, non-overlapping): n=${v.trade.repoCondTrades} exp=${v.trade.repoCondExp.toFixed(4)}%`,
    );
    const mine = agg.find((a) => a.id === "Z_fade_dip_repo");
    console.log(
      `  this file's CONDITIONAL (every signal bar, ties=loss): n=${mine.n} exp=${mine.expTakerPct.toFixed(4)}% ` +
        `| exits ${JSON.stringify(mine.exits)}`,
    );
    console.log(
      `  NOTE: the headline numbers differ BY DESIGN — this file fills at the next OPEN (the repo fills at the ` +
        `signal CLOSE), measures EVERY signal bar (the repo's conditional skips ahead past each trade), and ` +
        `charges intra-bar ties as LOSSES (the repo charges them as its optimistic TP reading).`,
    );
    out.validation = v;
  }
  // ---- paired within-day session test ----
  // Liquidity slices for the paired test, using the SAME in-window turnover
  // ranking as the candidate slices.
  const liqRankForPaired = [...symMedianTurnover.entries()]
    .map(([sym, m]) => ({ sym, m }))
    .sort((a, b) => b.m - a.m);
  const top150 = new Set(liqRankForPaired.slice(0, 150).map((x) => x.sym));
  const top50 = new Set(liqRankForPaired.slice(0, 50).map((x) => x.sym));
  const idxTop150 = [...top150].map((s) => symIndex.get(s)).filter((x) => x != null);
  const idxTop50 = [...top50].map((s) => symIndex.get(s)).filter((x) => x != null);
  const usedIdx = [...symIndex.values()];

  const pairedOut = {
    note:
      "Paired within-day test. For each 3-hour UTC window w and each direction, " +
      "delta(day) = mean(net P&L | bars inside w that day, all symbols) - mean(net P&L | bars outside w that day, all symbols). " +
      "Pairing removes market drift and symbol heterogeneity. CI is a bootstrap over the 91 daily deltas.",
    long: paired.report("long", usedIdx, { perSymbol: true }),
    short: paired.report("short", usedIdx, { perSymbol: true }),
    longTop150: paired.report("long", idxTop150),
    shortTop150: paired.report("short", idxTop150),
    longTop50: paired.report("long", idxTop50),
    shortTop50: paired.report("short", idxTop50),
  };

  console.log("");
  console.log("PAIRED WITHIN-DAY SESSION TEST (3h windows) — delta = mean(inside window) - mean(outside window), same day, all symbols, taker fees:");
  for (const dir of ["long", "short"]) {
    const rows = pairedOut[dir].filter((r) => r.mean != null).sort((a, b) => b.mean - a.mean);
    if (rows.length === 0) {
      console.log(`  ${dir.padEnd(5)} no window had enough paired days to report`);
      continue;
    }
    const best = rows[0];
    const worst = rows[rows.length - 1];
    const sig = rows.filter((r) => r.ci95Low > 0);
    console.log(
      `  ${dir.padEnd(5)} best window h${String(best.window).padStart(2, "0")} delta=${f(best.mean)} CI95[${f(best.ci95Low)}, ${f(best.ci95High)}] P(<=0)=${f(best.pMeanNotGreaterThanZero, 3)} (${best.days}d) | ` +
        `worst h${String(worst.window).padStart(2, "0")} ${f(worst.mean)} | windows with CI strictly > 0: ${sig.length}/24`,
    );
    for (const s of sig) {
      const t150 = pairedOut[`${dir}Top150`].find((x) => x.window === s.window);
      const t50 = pairedOut[`${dir}Top50`].find((x) => x.window === s.window);
      const ps = s.perSymbol ?? [];
      const posSym = ps.filter((p) => p.delta > 0).length;
      console.log(
        `      h${String(s.window).padStart(2, "0")} delta=${f(s.mean)} CI95[${f(s.ci95Low)}, ${f(s.ci95High)}] P(<=0)=${f(s.pMeanNotGreaterThanZero, 3)} | ` +
          `T150 delta=${t150 ? f(t150.mean) : "—"} T50 delta=${t50 ? f(t50.mean) : "—"} | symbols positive ${posSym}/${ps.length}`,
      );
    }
  }

  out.pairedSession = pairedOut;
  writeOut();

  // ---- liquidity slices ----
  console.log("");
  console.log("LIQUIDITY SLICES — side expectancy at taker fees (ALL / LIQ_TOP150 / LIQ_TOP50):");
  console.log(
    pad("id", 20) +
      pad("ALL long", 24) +
      pad("ALL short", 24) +
      pad("T150 long", 24) +
      pad("T150 short", 24) +
      pad("T50 long", 24) +
      pad("T50 short", 24),
  );
  console.log("-".repeat(164));
  for (const cand of candidates) {
    const sAll = slices.ALL[cand.id];
    const s150 = slices.LIQ_TOP150[cand.id];
    const s50 = slices.LIQ_TOP50[cand.id];
    const cell = (x) => `${f(x.expTakerPct)} (n=${x.n})`;
    console.log(
      pad(cand.id, 20) +
        pad(cell(sAll.long), 24) +
        pad(cell(sAll.short), 24) +
        pad(cell(s150.long), 24) +
        pad(cell(s150.short), 24) +
        pad(cell(s50.long), 24) +
        pad(cell(s50.short), 24),
    );
  }

  // ---- exit-type mix + block detail for the top candidates ----
  console.log("");
  console.log("TOP CANDIDATES — exit mix, blocks, and clustered CI:");
  for (const a of sorted.slice(0, 6)) {
    const ex = a.exits;
    console.log(
      `  ${a.id}: exits tp=${ex.tp ?? 0} kill=${ex.kill ?? 0} tie=${ex.tie ?? 0} timeout=${ex.timeout ?? 0} | ` +
        `blocks ${a.blocks.map((b) => `${f(b.expTakerPct, 3)}(n=${b.n})`).join(" ")}`,
    );
    for (const side of ["long", "short"]) {
      const s = a.bySide[side];
      const bt = s.bootTaker;
      console.log(
        `    ${side.padEnd(5)} n=${String(s.n).padEnd(6)} WR=${f(s.wr, 1)}%  expT=${f(s.expTakerPct)}  expM=${f(s.expMakerPct)}  ` +
          `blocks+=${s.blocksPositive}/3  ` +
          (bt ? `CI95[${f(bt.ci95Low)}, ${f(bt.ci95High)}] P(<=0)=${f(bt.pMeanNotGreaterThanZero, 3)} (${bt.days}d)` : "CI n/a"),
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
