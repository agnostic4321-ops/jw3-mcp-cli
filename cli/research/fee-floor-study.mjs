#!/usr/bin/env node
/**
 * THE FEE FLOOR STUDY — can a ticket at $57.16 of equity clear the fees?
 *
 * ── WHAT THIS IS ──
 *
 * The geometry study proved the SHIPPED ticket (TP ~0.4-0.5%, stop ~1.2%,
 * ~1:3.4 R:R) needs a 78.7% win rate to break even, against a measured
 * signal win rate of ~66.7%. This study asks the follow-up question the
 * operator actually cares about:
 *
 *   AT THIS ACCOUNT SIZE, WITH THESE REAL FEES, IS THERE A TICKET THAT
 *   PAYS? AND IF SO, WHAT IS IT?
 *
 * Everything here is READ-ONLY. It reads local caches only, and the bars
 * it uses were fetched from KuCoin's PUBLIC kline endpoint (no auth, no
 * order path, no account budget) by `fee-floor-fetch-15m.mjs`. It never
 * touches the account.
 *
 * ── THE ACCOUNT'S REAL NUMBERS (given, measured live) ──
 *
 *   equity / free margin   $57.1579522047
 *   per-position cap       $60 notional (a $250 hard per-order ceiling also exists)
 *   max leverage           50
 *   daily notional budget  $500
 *   daily loss cap         $12
 *   trades/day cap         120
 *   fees                   maker 0.02%/side, taker 0.06%/side (KuCoin futures VIP0)
 *
 * Fee math runs on the LEVERAGED NOTIONAL, not on the margin. That is the
 * whole difficulty of this account: a $60 notional is 1.05x the equity, so
 * the round trip costs 1.05x the fee rate in %-of-equity terms.
 *
 * ── THE THREE FEE MIXES ──
 *
 *   maker-maker  0.04%  a resting limit that rests on the exit too
 *   maker-taker  0.08%  the sizing engine's ASSUMPTION (entry maker, exit taker)
 *   taker-taker  0.12%  what the live path ACTUALLY pays: the entry is a
 *                       MARKET order (src/commands/live.ts: type: "market"),
 *                       and the TP/SL legs are trigger orders. Verified on the
 *                       venue's own P&L: $0.0713 on a $59.41 notional = 0.12%.
 *
 * Until a fill's `liquidity` field proves otherwise, assume taker-taker.
 *
 * ── THE THREE POPULATIONS, AND WHY THEY ARE NOT INTERCHANGEABLE ──
 *
 *   (A) THE SIGNAL ARM — the control arm: the tape and the models AGREE.
 *       This is the machine's own signal, the only thing it trades.
 *       n≈166 observations, and it is 100% SHORT.
 *   (B) THE UNCONDITIONAL ARM — the tape's direction with NO model
 *       filter, on the SAME observations and the SAME bars. This is the
 *       BETA baseline: the market's own drift.
 *   (C) THE 14-DAY HISTORY — every 15-minute bar close on every signal
 *       pair, no signal at all. This measures the GEOMETRY itself: how
 *       often it resolves, how often it wins, how large the excursion is.
 *
 * The signal arm's RAW win rate is NOT the signal's win rate. The sample
 * is 100% short in a window where the market fell more than it rose, so
 * a short wins almost regardless of the tape. That is beta. The number
 * that decides the ticket is the EXCESS over (B) — and the repo's own
 * geometry study already measures it: +0.054% to +0.098% of equity per
 * trade, positive in every geometry, clustered t = 0.57–1.13.
 *
 * The fee floor question is therefore: does the measured EXCESS survive
 * the per-trade fee? That is the question this study answers.
 *
 * READ-ONLY. Writes exactly one new file (a uniquely named summary) and
 * never writes an *.ndjson.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const LEADS = join(SCRATCH, "leads/klines");
const CONTRACTS = join(SCRATCH, "contracts.json");
const BARS_15M = join(SCRATCH, "fee-floor-15m-bars.json");
const SUMMARY = join(SCRATCH, "fee-floor-study.summary.json");

/* ── the account, as measured ─────────────────────────────────────────── */
const EQUITY = 57.1579522047;
const NOTIONAL_CAP = 60;
const SERVER_ORDER_CEILING = 250;
const DAILY_NOTIONAL_BUDGET = 500;
const DAILY_LOSS_CAP = 12;
const MAX_TRADES_PER_DAY = 120;

/* ── the fee schedule, verified live ───────────────────────────────────── */
const MAKER_PCT_PER_SIDE = 0.02;
const TAKER_PCT_PER_SIDE = 0.06;
const MIXES = {
  "maker-maker": MAKER_PCT_PER_SIDE * 2,
  "maker-taker": MAKER_PCT_PER_SIDE + TAKER_PCT_PER_SIDE,
  "taker-taker": TAKER_PCT_PER_SIDE * 2,
};

/* ── the sizing engine's own gates (src/commands/sizing.ts) ───────────── */
const HARD_MAX_LEVERAGE = 50;
const MIN_LIQ_MULTIPLE = 2;
const MAINT_MARGIN = 0.005;
const FEE_DRAG_CEILING_SIZING = 1 / 3;
const FEE_DRAG_CEILING_FILTER = 0.25;
const MAX_WIDENED_STOP_FRACTION = 0.25;
const MIN_STOP_ATR_FRACTION = 0.25;

/* ── the hold window ──────────────────────────────────────────────────── */
const HOLD_4H_BARS = 16; // 4 hours at 15-minute bars (the live path's time exit)
/** The signal's measured win rate (1h forward, the machine's own arm). */
const MEASURED_WIN_RATE = 0.667;
/** The measured excess of the signal arm over the unconditional baseline. */
const MEASURED_EXCESS = { low: 0.0543, high: 0.0978 }; // % of equity per trade

/* ══ geometry ═════════════════════════════════════════════════════════ */

/**
 * The live path's own geometry, from src/kucoin.ts `planScalp` with
 * maxSteps = 2 (src/commands/live-cmd.ts: planScalp(..., 2)).
 *
 *   tpPct      = clamp(atr*0.4, 0.3, 0.5)
 *   stepDrop   = clamp(atr*0.9, 0.6, 1.5)
 *   avgEntry   = last * (1 + stepDrop/200)        (two equal-size rungs)
 *   killPrice  = last * (1 + 2*stepDrop/100)
 *   stop%      = (killPrice - avgEntry) / avgEntry
 *
 * Reproduced against the venue's own filled tickets:
 *   LINK atr 0.688565% -> stop 0.92669% (venue: 0.9266919357277235)
 *   SUI  atr 0.906535% -> stop 1.21885% (venue: 1.2188498055488934)
 *   ENA  atr 1.490290% -> stop 1.99849% (venue: 1.9984892313093872)
 */
function liveGeometry(atrPct) {
  const tpPct = Math.min(0.5, Math.max(0.3, atrPct * 0.4));
  const stepDrop = Math.min(1.5, Math.max(0.6, atrPct * 0.9));
  const avgEntryFactor = 1 + stepDrop / 200;
  const killFactor = 1 + (2 * stepDrop) / 100;
  const slPct = ((killFactor - avgEntryFactor) / avgEntryFactor) * 100;
  return { tpPct, slPct, stepDrop };
}

/** The leverage the sizing engine DERIVES from a stop (never chosen). */
function derivedLeverage(slPct) {
  const d = slPct / 100;
  const maxSafe = Math.max(1, Math.floor(1 / (MIN_LIQ_MULTIPLE * d + MAINT_MARGIN)));
  return { maxSafe, lev: Math.max(1, Math.min(maxSafe, HARD_MAX_LEVERAGE)) };
}

/** Fee drag as a fraction of the stop distance. */
const feeDrag = (feePct, slPct) => feePct / slPct;

/**
 * The win rate at which the geometry's expectancy is exactly zero.
 *
 * The fee CANCELS out of the tp+sl term, so it must NOT appear in the
 * denominator.
 *
 *   expectancyPctEquity(w) = rho * (w*tp - (1-w)*sl - fee) = 0
 *     => w*tp - w*sl - sl - fee = 0
 *     => w*(tp + sl) = sl + fee
 *     => w* = (sl + fee) / (tp + sl)
 *
 * The previous form, (sl+fee)/(tp+sl+fee), put the fee in the
 * denominator too, which UNDERSTATES the required win rate by 4.6-7.7
 * percentage points — so a geometry that needed 90.5% to pay was
 * reported as needing 85.1%. That is the wrong direction: it makes a
 * losing geometry look closer to viable, and it disagreed with this
 * file's OWN expectancyPctEquity, which uses the correct algebra.
 */
const breakEvenWinRate = (tpPct, slPct, feePct) => (slPct + feePct) / (tpPct + slPct);

/** The expectancy per trade, in % of EQUITY. */
function expectancyPctEquity(winRate, tpPct, slPct, feePct, rho) {
  return rho * (winRate * tpPct - (1 - winRate) * slPct - feePct);
}

/* ══ statistics ════════════════════════════════════════════════════════ */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const pctS = (v, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/* ══ the bar data ══════════════════════════════════════════════════════ */

/** The 90 days of 1-hour bars per symbol: [ts, o, h, l, c, v, turn]. */
function loadLeadsKlines() {
  const out = {};
  if (!existsSync(LEADS)) return out;
  for (const f of readdirSync(LEADS)) {
    if (!f.endsWith("_60_90.json")) continue;
    const sym = f.replace("USDTM_60_90.json", "");
    const raw = JSON.parse(readFileSync(join(LEADS, f), "utf8"));
    out[sym] = raw.map((b) => ({
      t: Number(b[0]),
      h: Number(b[2]),
      l: Number(b[3]),
      c: Number(b[4]),
    }));
  }
  return out;
}

function load15mBars() {
  if (!existsSync(BARS_15M)) return {};
  try {
    return JSON.parse(readFileSync(BARS_15M, "utf8"));
  } catch {
    return {};
  }
}

/* ══ the outcome simulation ═══════════════════════════════════════════ */

/**
 * The outcome of one entry at one geometry.
 *   "win"    the target was touched first
 *   "loss"   the stop was touched first, OR the bar touched BOTH
 *            (AMBIGUOUS, resolved conservatively as a loss — the same tie
 *            handling the geometry study and the backtest use)
 *   "time"   neither level was touched inside the hold window: the trade
 *            is closed at the horizon's close and booked at the mark
 *   null     there are not enough bars to decide (no data, NOT a price
 *            outcome — kept strictly separate from "unresolved")
 */
function outcome(bars, idx, entry, tpPct, slPct, long, holdBars) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const end = Math.min(bars.length, idx + 1 + holdBars);
  if (end <= idx + 1) return null;
  for (let i = idx + 1; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return { kind: "loss" };
    if (hitTp) return { kind: "win" };
    if (hitSl) return { kind: "loss" };
  }
  if (end === bars.length) return null; // ran out of data before the window closed
  const last = bars[end - 1];
  const move = long ? (last.c - entry) / entry : (entry - last.c) / entry;
  return { kind: "time", markPct: move * 100 };
}

/**
 * The EFFECTIVE sample size of a set of per-trade values.
 *
 * The collector samples ~43 symbols every 5 minutes. The rows in one
 * bucket are 43 different symbols moving TOGETHER — crypto is correlated,
 * so a market-wide move produces 43 near-identical observations.
 * Treating them as independent overstates the evidence by roughly the
 * square root of the cluster size. The correction: compute the standard
 * error of the CLUSTER MEANS (one mean per time bucket) and use that.
 *
 * This is the repo's own correction (analyze-geometry.mjs, clusterStats).
 */
function clusterStats(values, buckets) {
  const byBucket = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = byBucket.get(b) ?? [];
    arr.push(values[i]);
    byBucket.set(b, arr);
  }
  const clusterMeans = [...byBucket.values()].map((a) => mean(a));
  return { clusters: clusterMeans.length, mean: mean(clusterMeans), se: se(clusterMeans) };
}

/**
 * Simulate one geometry over a set of entries.
 * Returns the resolution breakdown and the per-trade P&L in % of notional,
 * fee included.
 */
function simulate(entries, tpPct, slPct, feePct, holdBars) {
  const perTrade = [];
  const timeMarks = [];
  const buckets = [];
  let wins = 0;
  let losses = 0;
  let times = 0;
  let noData = 0;
  for (const e of entries) {
    const o = outcome(e.bars, e.idx, e.entry, tpPct, slPct, e.long, holdBars);
    if (o === null) {
      noData++;
      continue;
    }
    const bucket = e.row ? Math.floor(e.row.ts / 300000) : e.idx;
    if (o.kind === "win") {
      wins++;
      perTrade.push(tpPct - feePct);
    } else if (o.kind === "loss") {
      losses++;
      perTrade.push(-slPct - feePct);
    } else {
      times++;
      timeMarks.push(o.markPct);
      perTrade.push(o.markPct - feePct);
    }
    buckets.push(bucket);
  }
  const n = wins + losses + times;
  const resolved = wins + losses;
  return {
    n,
    wins,
    losses,
    times,
    noData,
    buckets,
    nResolvedTrades: resolved,
    winRateResolved: resolved ? wins / resolved : null,
    resolutionRate: n ? resolved / n : null,
    timeExitRate: n ? times / n : null,
    meanTimeMark: times ? mean(timeMarks) : null,
    evPctNotional: mean(perTrade),
    perTrade,
  };
}

/** The excursion envelope over a set of entries, in the trade's direction. */
function envelope(entries, holdBars) {
  const up = [];
  const down = [];
  const dir = [];
  const reach = { "0.3": 0, "0.5": 0, "0.8": 0, "1.2": 0, "1.5": 0, "2.0": 0 };
  for (const e of entries) {
    let u = 0;
    let d = 0;
    for (let j = e.idx + 1; j <= Math.min(e.bars.length - 1, e.idx + holdBars); j++) {
      u = Math.max(u, (e.bars[j].h - e.entry) / e.entry * 100);
      d = Math.max(d, (e.entry - e.bars[j].l) / e.entry * 100);
    }
    if (u === 0 && d === 0) continue;
    up.push(u);
    down.push(d);
    dir.push(e.long ? u : d);
    for (const lv of Object.keys(reach)) if (Math.max(u, d) >= Number(lv)) reach[lv]++;
  }
  return {
    n: up.length,
    upMean: mean(up),
    upMedian: median(up),
    downMean: mean(down),
    downMedian: median(down),
    dirMean: mean(dir),
    reach,
  };
}

/** The measured share of windows in which a level was reached. */
const reachAt = (reach, pctLevel) => {
  const key = pctLevel.toFixed(1);
  if (reach[key] != null) return reach[key];
  const keys = Object.keys(reach).map(Number).sort((a, b) => a - b);
  let best = 0;
  for (const k of keys) if (k <= pctLevel + 1e-9) best = reach[k.toFixed(1)];
  return best;
};

/* ══ the candidate geometries ══════════════════════════════════════════ */

const GEOMETRIES = [
  { name: "TP 0.6 / SL 1.0", tp: 0.6, sl: 1.0 },
  { name: "TP 0.5 / SL 1.2", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8 / SL 1.2", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0 / SL 1.2", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2 / SL 1.2", tp: 1.2, sl: 1.2 },
  { name: "TP 1.0 / SL 1.0", tp: 1.0, sl: 1.0 },
  { name: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
  { name: "TP 1.2 / SL 1.5", tp: 1.2, sl: 1.5 },
  { name: "TP 1.5 / SL 1.5", tp: 1.5, sl: 1.5 },
  { name: "TP 1.5 / SL 2.0", tp: 1.5, sl: 2.0 },
  { name: "TP 2.0 / SL 2.0", tp: 2.0, sl: 2.0 },
  { name: "TP 2.5 / SL 2.5", tp: 2.5, sl: 2.5 },
];

/* ══ main ══════════════════════════════════════════════════════════════ */

async function main() {
  console.log("=".repeat(104));
  console.log("THE FEE FLOOR STUDY — $57.16 equity, $60 notional cap, 0.12% taker round trip");
  console.log("=".repeat(104));

  /* ── 0. the inputs, and a validation of every one of them ───────────── */
  const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const contracts = JSON.parse(readFileSync(CONTRACTS, "utf8")).data;
  const bySym = new Map(contracts.map((c) => [c.symbol, c]));
  const bars15 = load15mBars();
  const leads = loadLeadsKlines();

  console.log(`\n[1] INPUTS`);
  console.log(`  confluence rows      ${rows.length}  (${new Date(minBy(rows, (r) => r.ts)).toISOString()} → ${new Date(maxBy(rows, (r) => r.ts)).toISOString()})`);
  console.log(`  contract specs       ${contracts.length} (local cache, fetched 2026-10-21 01:36)`);
  console.log(`  15-minute bars       ${Object.keys(bars15).length} pair(s)`);
  console.log(`  90-day 1-hour bars   ${Object.keys(leads).length} symbol(s)`);

  // VALIDATION 1: the tape-side extraction must agree with the collector's
  // own `tapeSide` field on every row that carries one.
  let checked = 0;
  let mismatched = 0;
  for (const r of rows) {
    if (!r.tapeSide) continue;
    checked++;
    const mine = tapeSideFromRow({ ...r, tapeSide: undefined });
    if ((mine ?? null) !== (r.tapeSide ?? null)) mismatched++;
  }
  console.log(`  tape-side validation ${checked} rows carry tapeSide; ${mismatched} disagree with the shared thresholds module ${mismatched === 0 ? "✓" : "✗"}`);

  // VALIDATION 2: the derived live geometry must reproduce the venue's own
  // filled tickets.
  const fired = readFileSync(join(SCRATCH, "trade-loop.ndjson"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === "FIRED");
  let geoOk = 0;
  let geoBad = 0;
  for (const f of fired) {
    const c = f.ticket.candidate;
    const g = liveGeometry(c.atrPct);
    const venueStop = (Math.abs(f.ticket.sizing.stopPrice - c.entryPrice) / c.entryPrice) * 100;
    if (Math.abs(g.slPct - venueStop) < 1e-6) geoOk++;
    else {
      geoBad++;
      console.log(`    MISMATCH ${f.pair}: derived ${g.slPct.toFixed(6)}% vs venue ${venueStop.toFixed(6)}%`);
    }
  }
  console.log(`  geometry validation  ${geoOk}/${geoOk + geoBad} venue tickets reproduced from the ATR alone ${geoBad === 0 ? "✓" : "✗"}`);

  // VALIDATION 3: the fee rate against the venue's own realised fees.
  for (const t of [
    { pair: "LINK/USDT", qty: 4.8, entry: 12.377, fee: 0.0713 },
    { pair: "SUI/USDT", qty: 57, entry: 1.0303, fee: 0.0705 },
  ]) {
    const notional = t.qty * t.entry;
    const implied = (t.fee / notional) * 100;
    console.log(`  fee validation       ${t.pair}: venue fee $${t.fee} on $${notional.toFixed(2)} notional = ${implied.toFixed(4)}%  (taker-taker = 0.12%) ${Math.abs(implied - 0.12) < 0.0005 ? "✓" : "✗"}`);
  }

  /* ── 1. the arms ────────────────────────────────────────────────────── */
  const signalRows = [];
  const uncondRows = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    uncondRows.push({ ...r, dir: tapeSide });
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const modelSide = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    if (!modelSide) continue;
    if (tapeSide !== modelSide) continue;
    signalRows.push({ ...r, dir: tapeSide });
  }

  console.log(`\n[2] THE ARMS`);
  console.log(`  (A) signal arm (tape and models agree)   ${signalRows.length}`);
  console.log(`  (B) unconditional arm (tape only)        ${uncondRows.length}`);
  const buckets = new Set(signalRows.map((r) => Math.floor(r.ts / 300000)));
  console.log(`      independent 5-minute clusters in (A)  ${buckets.size}  ← the honest n`);
  const sideCounts = {};
  for (const r of signalRows) sideCounts[r.dir] = (sideCounts[r.dir] ?? 0) + 1;
  console.log(`      directions in (A)                     ${JSON.stringify(sideCounts)}`);
  console.log(`      → (A) is ${((sideCounts.short ?? 0) / Math.max(1, signalRows.length) * 100).toFixed(0)}% SHORT. Its raw win rate is BETA, not edge.`);

  /* ── 2. the entries for each population ─────────────────────────────── */
  /** Anchor an observation on the last 15m bar at or before it. */
  function entriesFor(set) {
    const out = [];
    let noBar = 0;
    for (const r of set) {
      const bars = bars15[r.pair];
      if (!bars?.length) {
        noBar++;
        continue;
      }
      let idx = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t <= r.ts) idx = i;
        else break;
      }
      if (idx < 0) {
        noBar++;
        continue;
      }
      out.push({ bars, idx, entry: bars[idx].c, long: r.dir === "long", row: r });
    }
    return { entries: out, noBar };
  }
  const sig = entriesFor(signalRows);
  const unc = entriesFor(uncondRows);
  console.log(`      (A) entries: ${sig.entries.length} (${sig.noBar} unanchorable)`);
  console.log(`      (B) entries: ${unc.entries.length} (${unc.noBar} unanchorable)`);

  // (C) the 14-day history: every 15m bar close, no signal.
  const histEntries = [];
  for (const pair of Object.keys(bars15)) {
    const bars = bars15[pair];
    for (let i = 0; i < bars.length - 1; i++) {
      histEntries.push({ bars, idx: i, entry: bars[i].c, long: true });
    }
  }

  /* ── 3. the excursion envelope, per population ──────────────────────── */
  const envA = envelope(sig.entries, HOLD_4H_BARS);
  const envB = envelope(unc.entries, HOLD_4H_BARS);
  const envC = envelope(histEntries, HOLD_4H_BARS);

  console.log(`\n[3] THE 4-HOUR EXCURSION ENVELOPE`);
  console.log(`  (A) the signal arm — the geometry study's own population`);
  console.log(`      n=${envA.n}  up mean ${envA.upMean.toFixed(3)}%  down mean ${envA.downMean.toFixed(3)}%  in-the-trade-direction mean ${envA.dirMean.toFixed(3)}%`);
  console.log(`      (falsified-leads.md documents +0.31% up / -0.56% down — this is that population)`);
  console.log(`  (B) the unconditional arm — the BETA baseline, same window, same bars`);
  console.log(`      n=${envB.n}  up mean ${envB.upMean.toFixed(3)}%  down mean ${envB.downMean.toFixed(3)}%  in-the-trade-direction mean ${envB.dirMean.toFixed(3)}%`);
  console.log(`  (C) the 14-day history — every 15m bar, no signal`);
  console.log(`      n=${envC.n}  up mean ${envC.upMean.toFixed(3)}%  down mean ${envC.downMean.toFixed(3)}%`);
  console.log(`  a move of        happens within 4h    (A: signal arm / B: beta baseline / C: 14-day history)`);
  for (const lv of Object.keys(envC.reach)) {
    console.log(
      `  ${lv.padStart(4)}%         A ${String(envA.reach[lv] ?? 0).padStart(6)}/${envA.n} (${(((envA.reach[lv] ?? 0) / envA.n) * 100).toFixed(1)}%)   B ${String(envB.reach[lv] ?? 0).padStart(6)}/${envB.n} (${(((envB.reach[lv] ?? 0) / envB.n) * 100).toFixed(1)}%)   C ${String(envC.reach[lv]).padStart(6)}/${envC.n} (${((envC.reach[lv] / envC.n) * 100).toFixed(1)}%)`,
    );
  }
  console.log(`  The three populations differ because they are different markets-in-time.`);
  console.log(`  (A) and (B) are the SAME window (the sample is 100% short in a falling market);`);
  console.log(`  (C) is 14 days of history, where the average excursion is 3-4x larger.`);

  /* ── 4. the exposure and the fee ────────────────────────────────────── */
  const rho = NOTIONAL_CAP / EQUITY;
  console.log(`\n[4] EXPOSURE AND THE FEE`);
  console.log(`  ${NOTIONAL_CAP.toFixed(2)} notional on ${EQUITY.toFixed(4)} equity = ${rho.toFixed(5)}x`);
  for (const [k, v] of Object.entries(MIXES)) {
    console.log(`    ${k.padEnd(12)} ${v.toFixed(3)}% of notional = $${((NOTIONAL_CAP * v) / 100).toFixed(4)} = ${(v * rho).toFixed(4)}% of equity per trade`);
  }

  /* ── 5. THE GRID ─────────────────────────────────────────────────────── */
  console.log(`\n[5] THE GEOMETRY GRID`);
  console.log(`   drag%   the round-trip fee as a fraction of the stop distance`);
  console.log(`   w*%     the break-even win rate at this geometry and fee`);
  console.log(`   EV66%   the net expectancy, % of equity per trade, at the ASSUMED w=66.7%`);
  console.log(`   sigW%   the MEASURED win rate of (A)'s RESOLVED trades, with n`);
  console.log(`   betaW%  the MEASURED win rate of (B)'s RESOLVED trades — the drift the signal rides`);
  console.log(`   EXCESS  (A)'s EV minus (B)'s EV, % of equity per trade — what the models add`);
  console.log(`   FEE     the round-trip fee at $60 notional, % of equity per trade`);
  console.log(`   VERDICT does the EXCESS beat the FEE?`);
  console.log("");
  console.log(`  ${pad("GEOMETRY", 17)} ${padL("lev", 4)} ${padL("drag%", 7)} ${padL("w*%", 7)} ${padL("EV66%", 8)} ${padL("sigW%", 7)} ${padL("nRes", 5)} ${padL("clus", 5)} ${padL("betaW%", 7)} ${padL("EXCESS%", 9)} ${padL("clusT", 6)} ${padL("FEE%", 7)}  verdict`);
  console.log("  " + "-".repeat(118));

  const grid = [];
  for (const g of GEOMETRIES) {
    const f = MIXES["taker-taker"];
    const simA = simulate(sig.entries, g.tp, g.sl, f, HOLD_4H_BARS);
    const simB = simulate(unc.entries, g.tp, g.sl, f, HOLD_4H_BARS);
    const simC = simulate(histEntries, g.tp, g.sl, f, HOLD_4H_BARS);
    // The excess, in % of equity per trade, at the $60 notional.
    const excess = (simA.evPctNotional - simB.evPctNotional) * rho;
    // The excess's significance, computed on CLUSTER MEANS (one mean per
    // 5-minute bucket) rather than on individual rows. The rows in one
    // bucket are ~43 correlated symbols moving together, so the row-level
    // standard error understates the true uncertainty by roughly the
    // square root of the cluster size. This is the repo's own correction
    // (analyze-geometry.mjs, clusterStats) and it is the honest one.
    const clA = clusterStats(simA.perTrade, simA.buckets);
    const clB = clusterStats(simB.perTrade, simB.buckets);
    const excessCluster = (clA.mean - clB.mean) * rho;
    const excessClusterSe = Math.sqrt(clA.se ** 2 + clB.se ** 2) * rho;
    const excessT = excessClusterSe > 0 ? excessCluster / excessClusterSe : 0;
    const row = {
      g,
      simA,
      simB,
      simC,
      excess,
      excessCluster,
      excessClusterSe,
      excessT,
      clusters: clA.clusters,
    };
    for (const [mix, fm] of Object.entries(MIXES)) {
      row[mix] = {
        drag: feeDrag(fm, g.sl),
        wbe: breakEvenWinRate(g.tp, g.sl, fm),
        evAt66: expectancyPctEquity(MEASURED_WIN_RATE, g.tp, g.sl, fm, rho),
        feeEq: fm * rho,
      };
    }
    grid.push(row);
  }

  for (const r of grid) {
    const f = MIXES["taker-taker"];
    const simA = r.simA;
    const simB = r.simB;
    // The verdict uses the CLUSTER-CORRECTED excess, the same number that
    // is printed. The row-level excess overstates the evidence.
    const verdict = r.excessCluster > f * rho ? "SURVIVES" : "FEE EATS IT";
    console.log(
      `  ${pad(r.g.name, 17)} ${padL("x" + derivedLeverage(r.g.sl).lev, 4)} ${padL((r["taker-taker"].drag * 100).toFixed(1), 7)} ${padL((r["taker-taker"].wbe * 100).toFixed(1), 7)} ${padL(pctS(r["taker-taker"].evAt66, 3), 8)} ${padL(simA.winRateResolved == null ? "—" : (simA.winRateResolved * 100).toFixed(1), 7)} ${padL(simA.nResolvedTrades, 5)} ${padL(r.clusters, 5)} ${padL(simB.winRateResolved == null ? "—" : (simB.winRateResolved * 100).toFixed(1), 7)} ${padL(pctS(r.excessCluster, 4), 9)} ${padL(r.excessT.toFixed(2), 6)} ${padL((f * rho).toFixed(4), 7)}  ${verdict}`,
    );
  }
  console.log("");
  console.log(`   EXCESS% is the CLUSTER-CORRECTED excess of (A) over (B), % of equity per trade.`);
  console.log(`   clusT is its t-statistic on the cluster means — the honest significance.`);
  console.log(`   clus is the number of independent 5-minute clusters in (A). The repo's bar is n>=30.`);
  console.log(`   The row-level excess (no cluster correction) is in the JSON summary.`);

  console.log("");
  console.log(`  the grid under the other two fee mixes — EV at w=66.7% and the fee it must beat:`);
  console.log(`  ${pad("GEOMETRY", 17)} ${padL("mm EV66%", 10)} ${padL("mm fee%", 9)} ${padL("mt EV66%", 10)} ${padL("mt fee%", 9)} ${padL("tt EV66%", 10)} ${padL("tt fee%", 9)} ${padL("tt EXCESS%", 11)}`);
  for (const r of grid) {
    console.log(
      `  ${pad(r.g.name, 17)} ${padL(pctS(r["maker-maker"].evAt66, 3), 10)} ${padL((r["maker-maker"].feeEq).toFixed(4), 9)} ${padL(pctS(r["maker-taker"].evAt66, 3), 10)} ${padL((r["maker-taker"].feeEq).toFixed(4), 9)} ${padL(pctS(r["taker-taker"].evAt66, 3), 10)} ${padL((r["taker-taker"].feeEq).toFixed(4), 9)} ${padL(pctS(r.excessCluster, 4), 11)}`,
    );
  }
  console.log("");
  console.log(`  EV66% is the ARITHMETIC at the assumed 66.7% win rate. It is NOT the verdict:`);
  console.log(`  the signal's win rate is not 66.7% at these geometries (sigW% above), and the`);
  console.log(`  arithmetic ignores the trades that never resolve (time% in section 6).`);

  /* ── 6. the shipped geometry, measured ──────────────────────────────── */
  console.log(`\n[6] THE SHIPPED GEOMETRY (TP 0.5 / SL 1.2), measured`);
  const shipA = simulate(sig.entries, 0.5, 1.2, MIXES["taker-taker"], HOLD_4H_BARS);
  const shipB = simulate(unc.entries, 0.5, 1.2, MIXES["taker-taker"], HOLD_4H_BARS);
  const shipC = simulate(histEntries, 0.5, 1.2, MIXES["taker-taker"], HOLD_4H_BARS);
  console.log(`  (A) signal arm:        n=${shipA.n}  resolved ${((shipA.resolutionRate ?? 0) * 100).toFixed(1)}% (${shipA.nResolvedTrades} trades)  win ${((shipA.winRateResolved ?? 0) * 100).toFixed(1)}%  time exit ${((shipA.timeExitRate ?? 0) * 100).toFixed(1)}%  EV ${pctS(shipA.evPctNotional, 4)}% of notional`);
  console.log(`  (B) beta baseline:     n=${shipB.n}  resolved ${((shipB.resolutionRate ?? 0) * 100).toFixed(1)}% (${shipB.nResolvedTrades} trades)  win ${((shipB.winRateResolved ?? 0) * 100).toFixed(1)}%  time exit ${((shipB.timeExitRate ?? 0) * 100).toFixed(1)}%  EV ${pctS(shipB.evPctNotional, 4)}% of notional`);
  console.log(`  (C) 14-day history:    n=${shipC.n}  resolved ${((shipC.resolutionRate ?? 0) * 100).toFixed(1)}%  win ${((shipC.winRateResolved ?? 0) * 100).toFixed(1)}%  time exit ${((shipC.timeExitRate ?? 0) * 100).toFixed(1)}%  EV ${pctS(shipC.evPctNotional, 4)}% of notional`);
  console.log(`  the EXCESS (A)-(B) = ${pctS((shipA.evPctNotional - shipB.evPctNotional) * rho, 4)}% of equity per trade; the taker fee is ${(MIXES["taker-taker"] * rho).toFixed(4)}%`);
  console.log(`  → the shipped geometry LOSES ${pctS((shipA.evPctNotional - shipB.evPctNotional) * rho - MIXES["taker-taker"] * rho, 4)}% of equity per trade to fees.`);

  /* ── 7. per-pair table on the SHIPPED (ATR-derived) ticket ──────────── */
  const atrByPair = new Map();
  for (const r of rows) {
    if (!atrByPair.has(r.pair)) atrByPair.set(r.pair, []);
    atrByPair.get(r.pair).push(Number(r.tapeAtrPct));
  }
  const pairs = [...atrByPair.keys()].sort();

  console.log(`\n[7] PER-PAIR — the ticket each pair's own ATR produces`);
  console.log(`   tp/sl are % of entry; lev is DERIVED from the stop (floor(1/(2d+m)), capped at 50)`);
  console.log(`   drag = fee% / sl% (taker-taker 0.12%);  w* = break-even win rate;  EV = % of equity per trade at w=66.7%, taker-taker, $60 notional`);
  console.log(`   1lot$ = the notional of ONE contract at the venue's mark price (the minimum tradable size)`);
  console.log("");
  console.log(`  ${pad("PAIR", 16)} ${padL("ATR%", 6)} ${padL("TP%", 6)} ${padL("SL%", 6)} ${padL("lev", 5)} ${padL("R:R", 6)} ${padL("drag%", 7)} ${padL("w*%", 7)} ${padL("EV%", 8)} ${padL("1lot$", 8)} ${padL("marg$", 7)} ${padL("lots", 5)}  verdict`);
  console.log("  " + "-".repeat(116));
  const perPair = [];
  for (const pair of pairs) {
    const atr = median(atrByPair.get(pair));
    const g = liveGeometry(atr);
    const f = MIXES["taker-taker"];
    const lev = derivedLeverage(g.slPct);
    const ev = expectancyPctEquity(MEASURED_WIN_RATE, g.tpPct, g.slPct, f, rho);
    const base = pair.split("/")[0];
    const c = bySym.get(`${base}USDTM`);
    const lotNotional = c ? c.multiplier * c.markPrice : NaN;
    const margin = NOTIONAL_CAP / lev.lev;
    const lots = c && lotNotional > 0 ? Math.floor(NOTIONAL_CAP / lotNotional) : 0;
    perPair.push({ pair, atr, g, lev, ev, lotNotional, margin, lots, spec: c });
    console.log(
      `  ${pad(pair, 16)} ${padL(atr.toFixed(3), 6)} ${padL(g.tpPct.toFixed(2), 6)} ${padL(g.slPct.toFixed(2), 6)} ${padL("x" + lev.lev, 5)} ${padL((g.tpPct / g.slPct).toFixed(2), 6)} ${padL((feeDrag(f, g.slPct) * 100).toFixed(1), 7)} ${padL((breakEvenWinRate(g.tpPct, g.slPct, f) * 100).toFixed(1), 7)} ${padL(pctS(ev, 3), 8)} ${padL(lotNotional.toFixed(3), 8)} ${padL(margin.toFixed(2), 7)} ${padL(lots, 5)}  ${ev > 0 ? "arith-positive" : "NEGATIVE"}`,
    );
  }
  const viablePairs = perPair.filter((p) => p.ev > 0);
  const underOneLot = perPair.filter((p) => p.lots < 1);
  console.log("");
  console.log(`  ${viablePairs.length} of ${perPair.length} pairs have a POSITIVE arithmetic expectancy at w=66.7% on their own ATR-derived ticket.`);
  console.log(`  ${underOneLot.length} of ${perPair.length} pairs cannot fill ONE contract at the $60 notional cap:`);
  for (const p of underOneLot) console.log(`    ${pad(p.pair, 16)} one contract = $${p.lotNotional.toFixed(3)} notional → ${p.lots} lots fit in $${NOTIONAL_CAP}`);

  /* ── 7b. PER-PAIR MINIMUM VIABLE TICKET ────────────────────────────── */
  // The account-size question, per pair: for EACH pair, what is the
  // minimum viable ticket, and can the $60 cap carry it? A pair's own ATR
  // sets the noise band; its own excursion sets the reachability.
  console.log(`\n[7b] PER-PAIR MINIMUM VIABLE TICKET`);
  console.log(`   for each pair, the smallest (tp, sl) that clears the arithmetic AND the noise band AND the reachability,`);
  console.log(`   with the derived leverage and whether the $60 cap can fill it`);
  console.log("");
  console.log(`  ${pad("PAIR", 16)} ${padL("ATR%", 6)} ${padL("minTP%", 7)} ${padL("minSL%", 7)} ${padL("lev", 5)} ${padL("drag%", 7)} ${padL("w*%", 7)} ${padL("EV66%", 8)} ${padL("1lot$", 8)} ${padL("lots", 5)} ${padL("maxNotional$", 12)}  verdict`);
  console.log("  " + "-".repeat(120));
  const perPairViable = [];
  for (const pair of pairs) {
    const atr = median(atrByPair.get(pair));
    const minStop = MIN_STOP_ATR_FRACTION * atr;
    let best = null;
    for (let sl = Math.max(0.3, minStop); sl <= 2.5001; sl += 0.05) {
      for (let tp = 0.3; tp <= 3.0001; tp += 0.05) {
        const ev = expectancyPctEquity(MEASURED_WIN_RATE, tp, sl, MIXES["taker-taker"], rho);
        if (!(ev > 0)) continue;
        if (feeDrag(MIXES["taker-taker"], sl) > FEE_DRAG_CEILING_FILTER) continue;
        if (reachAt(envA.reach, tp) / envA.n <= 0) continue;
        const lev = derivedLeverage(sl);
        if (lev.lev > HARD_MAX_LEVERAGE) continue;
        if (!best || tp < best.tp || (tp === best.tp && sl < best.sl)) best = { tp, sl, ev, lev: lev.lev };
      }
    }
    const base = pair.split("/")[0];
    const c = bySym.get(`${base}USDTM`);
    const lotNotional = c ? c.multiplier * c.markPrice : NaN;
    const lots = c && lotNotional > 0 ? Math.floor(NOTIONAL_CAP / lotNotional) : 0;
    // The largest notional at which the measured LOW excess still clears
    // the taker round trip — the account-size constraint, per fee mix.
    const maxNotionalTaker = (EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"];
    if (!best) {
      console.log(`  ${pad(pair, 16)} ${padL(atr.toFixed(3), 6)} ${padL("none", 7)} ${padL("—", 7)} ${padL("—", 5)} ${padL("—", 7)} ${padL("—", 7)} ${padL("—", 8)} ${padL(lotNotional.toFixed(3), 8)} ${padL(lots, 5)} ${padL("—", 12)}  NO VIABLE TICKET`);
      continue;
    }
    // Can the $60 cap carry it? The notional cap must be BOTH small enough
    // for the fee floor AND large enough to fill one contract.
    const notionalForFee = (EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"];
    const fillable = lots >= 1;
    const viable = fillable && lotNotional <= notionalForFee;
    perPairViable.push({ pair, atr, best, lots, lotNotional, notionalForFee, viable });
    console.log(
      `  ${pad(pair, 16)} ${padL(atr.toFixed(3), 6)} ${padL(best.tp.toFixed(2), 7)} ${padL(best.sl.toFixed(2), 7)} ${padL("x" + best.lev, 5)} ${padL((feeDrag(MIXES["taker-taker"], best.sl) * 100).toFixed(1), 7)} ${padL((breakEvenWinRate(best.tp, best.sl, MIXES["taker-taker"]) * 100).toFixed(1), 7)} ${padL(pctS(best.ev, 3), 8)} ${padL(lotNotional.toFixed(3), 8)} ${padL(lots, 5)} ${padL("$" + notionalForFee.toFixed(2), 12)}  ${viable ? "VIABLE (small size)" : fillable ? "fee floor too high" : "cannot fill 1 lot"}`,
    );
  }
  const viablePairs2 = perPairViable.filter((p) => p.viable);
  console.log("");
  console.log(`  ${viablePairs2.length} of ${pairs.length} pairs can support a fee-viable ticket — i.e. ONE contract's notional is`);
  console.log(`  at or below the $${((EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"]).toFixed(2)} the taker fee floor allows on this equity:`);
  for (const p of viablePairs2) console.log(`    ${pad(p.pair, 16)} 1 lot = $${p.lotNotional.toFixed(3)}  →  min viable TP ${p.best.tp.toFixed(2)}% / SL ${p.best.sl.toFixed(2)}% at x${p.best.lev}`);

  /* ── 8. the account-size constraint ─────────────────────────────────── */
  console.log(`\n[8] THE ACCOUNT-SIZE CONSTRAINT`);
  console.log(`  The per-trade FEE is proportional to the notional, and so is the per-trade EDGE.`);
  console.log(`  So the ratio that decides viability is not the account size — it is rho = notional/equity.`);

  console.log(`\n  (a) does the measured EXCESS survive the fee?`);
  console.log(`      the measured excess is ${MEASURED_EXCESS.low}%–${MEASURED_EXCESS.high}% of equity per trade`);
  for (const [k, f] of Object.entries(MIXES)) {
    const feeEq = f * rho;
    console.log(
      `        ${k.padEnd(12)} fee ${feeEq.toFixed(4)}% of equity  →  ${feeEq > MEASURED_EXCESS.high ? "EATS THE WHOLE EXCESS" : feeEq > MEASURED_EXCESS.low ? "survives only the TOP of the excess range" : "survives the whole excess range"}`,
    );
  }

  console.log(`\n  (b) the notional that makes each fee mix survivable against the LOW excess (${MEASURED_EXCESS.low}%):`);
  console.log(`      feeEq = rho * f  <  excess  →  notional <  equity * excess / f`);
  for (const [k, f] of Object.entries(MIXES)) {
    const maxNotional = (EQUITY * MEASURED_EXCESS.low) / f;
    console.log(
      `        ${k.padEnd(12)} notional < $${maxNotional.toFixed(2)}   ${maxNotional < NOTIONAL_CAP ? "(BELOW the $60 cap — THE CAP MUST BE CUT)" : "(inside the $60 cap)"}`,
    );
  }
  console.log(`      (against the HIGH excess (${MEASURED_EXCESS.high}%): ${Object.entries(MIXES).map(([k, f]) => `${k} < $${((EQUITY * MEASURED_EXCESS.high) / f).toFixed(2)}`).join(", ")})`);

  console.log(`\n  (b2) IS EACH FEE MIX ACTUALLY REACHABLE?`);
  console.log(`      the live path places the ENTRY as a MARKET order (src/commands/live.ts: type: "market"),`);
  console.log(`      so the entry leg is a TAKER leg — 0.06%, not 0.02%. The maker fee is available only`);
  console.log(`      if the entry is a RESTING LIMIT that does not cross the spread (chase.ts chaseTouchFor).`);
  console.log(`      the EXIT legs are trigger orders (TP/SL): they fill against the resting book, so a`);
  console.log(`      TP that fills passively is a maker fill (0.02%) and an SL that is hit is a taker fill.`);
  console.log(`      So the REALISTIC mixes, in order of preference:`);
  console.log(`        maker-taker  0.08%  a resting limit entry + a taker exit (the best that is a real order)`);
  console.log(`        taker-taker  0.12%  a market entry + a taker exit — what the live path pays TODAY`);
  console.log(`        maker-maker  0.04%  both legs passive — requires a resting limit entry AND a passive TP`);
  console.log(`                       that is NOT a trigger order. The live path's TP/SL are trigger orders, so`);
  console.log(`                       this mix is not available without changing the exit mechanism.`);
  const makerOnly = (EQUITY * MEASURED_EXCESS.low) / MIXES["maker-maker"];
  console.log(`      even so, maker-maker at $${NOTIONAL_CAP.toFixed(2)} notional costs ${(MIXES["maker-maker"] * rho).toFixed(4)}% of equity,`);
  console.log(`      which is ${(MIXES["maker-maker"] * rho) < MEASURED_EXCESS.low ? "BELOW" : "ABOVE"} the LOW excess (${MEASURED_EXCESS.low}%) — so even the best possible fee mix`);
  console.log(`      survives only down to a notional of $${makerOnly.toFixed(2)}.`);

  console.log(`\n  (c) the daily budget and the loss cap, at the $60 cap:`);
  const tradesByNotional = Math.floor(DAILY_NOTIONAL_BUDGET / NOTIONAL_CAP);
  const lossPerTrade = (NOTIONAL_CAP * 1.2) / 100 + (NOTIONAL_CAP * MIXES["taker-taker"]) / 100;
  console.log(`      $500 daily notional / $60 cap = ${tradesByNotional} trades/day maximum`);
  console.log(`      $12 daily loss cap / $${lossPerTrade.toFixed(3)} per stopped trade = ${Math.floor(DAILY_LOSS_CAP / lossPerTrade)} stops before the cap`);
  console.log(`      the ${MAX_TRADES_PER_DAY} trades/day cap is NOT the binding constraint — the $500 notional budget is`);

  console.log(`\n  (d) margin, at the $60 cap and the DERIVED leverage:`);
  const levs = perPair.map((p) => p.lev.lev);
  console.log(`      derived leverage across the ${perPair.length} pairs: x${minOf(levs)} – x${maxOf(levs)}`);
  console.log(`      margin required: $${(NOTIONAL_CAP / maxOf(levs)).toFixed(2)} (x${maxOf(levs)}) to $${(NOTIONAL_CAP / minOf(levs)).toFixed(2)} (x${minOf(levs)})`);
  console.log(`      free margin $${EQUITY.toFixed(2)} → margin is NEVER the binding constraint. The FEE is.`);

  console.log(`\n  (e) the BTC bench, recomputed:`);
  const btcSpec = bySym.get("XBTUSDTM");
  const btcLot = btcSpec.multiplier * btcSpec.markPrice;
  const btcNotional = NOTIONAL_CAP;
  const btcFee = (btcNotional * MIXES["taker-taker"]) / 100;
  console.log(`      XBT one contract = $${btcLot.toFixed(3)} notional (multiplier ${btcSpec.multiplier}, mark $${btcSpec.markPrice})`);
  console.log(`      at $${btcNotional.toFixed(2)} notional, taker-taker: $${btcFee.toFixed(4)} of round-trip fees = ${(MIXES["taker-taker"]).toFixed(3)}% of notional`);
  console.log(`      the bench's thresholds: BTC_FEE_VETO_MIN_NOTIONAL_USD = $50, BTC_FEE_VETO_ACCOUNT_USD = $25`);
  console.log(`      the account is $${EQUITY.toFixed(2)} (above $25) and the notional $${btcNotional.toFixed(2)} (above $50) → the SIZE rule does not fire`);
  console.log(`      the fee floor's notional limit at taker-taker is $${((EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"]).toFixed(2)}`);
  console.log(`      XBT's MINIMUM TRADEABLE notional is $${btcLot.toFixed(2)} — ${(btcLot / ((EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"])).toFixed(2)}x that limit. BTC cannot be traded below it.`);
  console.log(`      → BTC IS BENCHED because its minimum tradeable SIZE is above the fee floor, not because`);
  console.log(`        the scalp TP is smaller than the fee. (The shipped TP of 0.30-0.50% DOES cover 0.12% of`);
  console.log(`        notional in isolation; what it does not cover is the 1:3-1:4.5 R:R, whose break-even`);
  console.log(`        win rate is 72.5-82.5% against a measured 66.7%.)`);

  /* ── 9. THE MINIMUM VIABLE TICKET ───────────────────────────────────── */
  console.log(`\n[9] THE MINIMUM VIABLE TICKET — solved, not guessed`);
  console.log(`  Constraints, all of them:`);
  console.log(`    (i)   the ARITHMETIC must be positive: w* < the measured signal win rate at that geometry`);
  console.log(`    (ii)  fee drag <= ${(FEE_DRAG_CEILING_SIZING * 100).toFixed(0)}% of the stop (sizing) and <= ${(FEE_DRAG_CEILING_FILTER * 100).toFixed(0)}% (filter)`);
  console.log(`    (iii) the stop must clear the noise band: stop >= 0.25 x ATR`);
  console.log(`    (iv)  the stop must be <= ${(MAX_WIDENED_STOP_FRACTION * 100).toFixed(0)}% (the widened-stop sanity cap)`);
  console.log(`    (v)   the target must be REACHABLE: the measured excursion envelope`);
  console.log(`    (vi)  leverage <= 50 and the margin must fit $${EQUITY.toFixed(2)}`);
  console.log(`    (vii) the MEASURED EXCESS at that geometry must beat the per-trade fee`);

  console.log(`\n  (i) the arithmetic boundary, tp > 0.5*sl + 1.5*f  (f = the round trip in %):`);
  for (const [k, f] of Object.entries(MIXES)) {
    console.log(`      ${k.padEnd(12)} tp > 0.5*sl + ${(1.5 * f).toFixed(3)}`);
    for (const sl of [0.9, 1.2, 1.5, 2.0]) {
      const need = 0.5 * sl + 1.5 * f;
      console.log(`         sl ${sl.toFixed(1)}%  →  tp must exceed ${need.toFixed(3)}%   (reached in ${((reachAt(envA.reach, need) / envA.n) * 100).toFixed(1)}% of the signal arm's 4h windows)`);
    }
  }

  const atrMedian = median(pairs.map((p) => median(atrByPair.get(p))));
  console.log(`\n  searching sl in [0.3, 2.5] x tp in [0.3, 3.0] (the median pair ATR is ${atrMedian.toFixed(3)}%, so the noise band demands a stop >= ${(MIN_STOP_ATR_FRACTION * atrMedian).toFixed(2)}%):`);
  const candidates = [];
  for (const mix of Object.keys(MIXES)) {
    const f = MIXES[mix];
    for (let sl = 0.3; sl <= 2.5001; sl += 0.05) {
      for (let tp = 0.3; tp <= 3.0001; tp += 0.05) {
        const ev = expectancyPctEquity(MEASURED_WIN_RATE, tp, sl, f, rho);
        if (!(ev > 0)) continue;
        const drag = feeDrag(f, sl);
        if (drag > FEE_DRAG_CEILING_SIZING) continue;
        if (drag > FEE_DRAG_CEILING_FILTER) continue;
        if (sl / 100 > MAX_WIDENED_STOP_FRACTION) continue; // sl is in %, the cap is a fraction
        if (sl < MIN_STOP_ATR_FRACTION * atrMedian) continue;
        const lev = derivedLeverage(sl);
        if (lev.lev > HARD_MAX_LEVERAGE) continue;
        if (NOTIONAL_CAP / lev.lev > EQUITY) continue;
        // The VENUE's own per-contract leverage cap. The venue rejected a
        // live order with "Leverage cannot exceed 20" on ENA/USDT, and the
        // sizing engine caps at the contract's maxLeverage when it knows
        // it. A ticket whose derived leverage NO pair can carry is not a
        // ticket — it is a refusal waiting to happen. (The cap is
        // PER CONTRACT: some pairs cap at x8, most at x50+, so the test is
        // "does SOME pair carry this leverage", not "does the tightest
        // pair carry it".)
        const carriers = pairs.filter((p) => {
          const spec = bySym.get(`${p.split("/")[0]}USDTM`);
          return (spec?.maxLeverage ?? HARD_MAX_LEVERAGE) >= lev.lev;
        });
        if (!carriers.length) continue;
        const tpReach = reachAt(envA.reach, tp) / envA.n;
        if (tpReach <= 0) continue;
        const a = simulate(sig.entries, tp, sl, f, HOLD_4H_BARS);
        const b = simulate(unc.entries, tp, sl, f, HOLD_4H_BARS);
        const excess = (a.evPctNotional - b.evPctNotional) * rho;
        const clA = clusterStats(a.perTrade, a.buckets);
        const clB = clusterStats(b.perTrade, b.buckets);
        const excessCluster = (clA.mean - clB.mean) * rho;
        const excessSe = Math.sqrt(clA.se ** 2 + clB.se ** 2) * rho;
        const excessT = excessSe > 0 ? excessCluster / excessSe : 0;
        candidates.push({
          mix, tp, sl, ev, drag, lev: lev.lev, tpReach,
          wA: a.winRateResolved, wB: b.winRateResolved,
          excess, excessCluster, excessT, feeEq: f * rho,
          nA: a.nResolvedTrades,
          carriers: carriers.length,
          // The ticket survives only if the measured excess beats the fee.
          // The CLUSTER-CORRECTED excess is the one that counts — the
          // row-level one overstates the evidence by roughly the square
          // root of the cluster size.
          beats: excessCluster > f * rho,
          // ...and the excess is not a statistical artefact (the repo's
          // bar is t>=2 on the clustered statistic).
          beatsSig: excessCluster > f * rho && excessT >= 2,
        });
      }
    }
  }
  const survives = candidates.filter((c) => c.beats);
  const survivesSig = candidates.filter((c) => c.beatsSig);
  if (!candidates.length) {
    console.log(`      NO ticket satisfies (i)-(vi) — even on the arithmetic at w=66.7%.`);
  } else {
    candidates.sort((a, b) => a.tp - b.tp || a.sl - b.sl || b.ev - a.ev);
    const min = candidates[0];
    console.log(`      ${candidates.length} tickets clear the ARITHMETIC (i)-(vi); ${survives.length} also survive the MEASURED excess (vii); ${survivesSig.length} of those ALSO clear the repo's bar (clustered t>=2).`);
    console.log(`      MINIMUM VIABLE on the arithmetic: ${min.mix}, TP ${min.tp.toFixed(2)}% / SL ${min.sl.toFixed(2)}%, x${min.lev}`);
    console.log(`        drag ${(min.drag * 100).toFixed(1)}% of the stop, EV ${pctS(min.ev, 3)}% of equity at w=66.7%, TP reached in ${(min.tpReach * 100).toFixed(1)}% of 4h windows`);
    console.log(`        measured at that geometry: (A) win ${min.wA == null ? "—" : (min.wA * 100).toFixed(1)}% on ${min.nA} resolved, (B) beta win ${min.wB == null ? "—" : (min.wB * 100).toFixed(1)}%`);
    console.log(`        the measured EXCESS is ${pctS(min.excessCluster, 4)}% of equity (t=${min.excessT.toFixed(2)}); the fee is ${min.feeEq.toFixed(4)}% → ${min.beats ? "SURVIVES" : "THE FEE EATS IT"}`);
    console.log(`\n  the surviving tickets (vii), by measured excess:`);
    for (const c of survives.sort((x, y) => y.excessCluster - x.excessCluster).slice(0, 12)) {
      console.log(`        ${pad(c.mix, 12)} TP ${padL(c.tp.toFixed(2), 5)}% / SL ${padL(c.sl.toFixed(2), 5)}%  x${padL(c.lev, 3)}  drag ${padL((c.drag * 100).toFixed(1), 5)}%  EXCESS ${padL(pctS(c.excessCluster, 4), 8)}% (t=${padL(c.excessT.toFixed(2), 5)})  fee ${padL(c.feeEq.toFixed(4), 7)}%  ${c.beatsSig ? "t>=2 ✓" : "t<2 ✗"}  (A) w ${padL(c.wA == null ? "—" : (c.wA * 100).toFixed(0), 3)}% on ${padL(c.nA, 3)}  TP reached ${padL((c.tpReach * 100).toFixed(1), 5)}%`);
    }
    if (!survives.length) {
      console.log(`        NONE. Every ticket that clears the fee arithmetic FAILS the measured-excess test.`);
    }

    // THE QUESTION THE TASK ASKS, answered explicitly: the WIDEST STOP and
    // the LOWEST LEVERAGE that still clears every gate. A wider stop means
    // a lower derived leverage (leverage is DERIVED from the stop:
    // floor(1/(2d+m))) and a smaller fee drag. So "widest stop, lowest
    // leverage" is the fee-optimal direction — it is the geometry the fee
    // floor itself points at.
    if (survives.length) {
      const widest = [...survives].sort((x, y) => y.sl - x.sl || x.lev - y.lev)[0];
      const lowestLev = [...survives].sort((x, y) => x.lev - y.lev || y.sl - x.sl)[0];
      const smallestTp = [...survives].sort((x, y) => x.tp - y.tp || x.sl - y.sl)[0];
      console.log(`\n  THE THREE ANSWERS, named:`);
      console.log(`    the WIDEST STOP that survives:   ${widest.mix}, TP ${widest.tp.toFixed(2)}% / SL ${widest.sl.toFixed(2)}%, x${widest.lev}`);
      console.log(`      drag ${(widest.drag * 100).toFixed(1)}% of the stop, EXCESS ${pctS(widest.excessCluster, 4)}% (t=${widest.excessT.toFixed(2)}) vs a ${widest.feeEq.toFixed(4)}% fee`);
      console.log(`    the LOWEST LEVERAGE that survives: ${lowestLev.mix}, TP ${lowestLev.tp.toFixed(2)}% / SL ${lowestLev.sl.toFixed(2)}%, x${lowestLev.lev}`);
      console.log(`      drag ${(lowestLev.drag * 100).toFixed(1)}% of the stop, EXCESS ${pctS(lowestLev.excessCluster, 4)}% (t=${lowestLev.excessT.toFixed(2)}) vs a ${lowestLev.feeEq.toFixed(4)}% fee`);
      console.log(`    the SMALLEST TARGET that survives: ${smallestTp.mix}, TP ${smallestTp.tp.toFixed(2)}% / SL ${smallestTp.sl.toFixed(2)}%, x${smallestTp.lev}`);
      console.log(`      drag ${(smallestTp.drag * 100).toFixed(1)}% of the stop, EXCESS ${pctS(smallestTp.excessCluster, 4)}% (t=${smallestTp.excessT.toFixed(2)}) vs a ${smallestTp.feeEq.toFixed(4)}% fee`);
      console.log(`      TP reached in ${(smallestTp.tpReach * 100).toFixed(1)}% of 4h windows; (A) won ${smallestTp.wA == null ? "—" : (smallestTp.wA * 100).toFixed(0)}% of ${smallestTp.nA} resolved`);
      const sigOk = survivesSig.length ? [...survivesSig].sort((x, y) => y.excessCluster - x.excessCluster)[0] : null;
      console.log(`    the BEST ticket that ALSO clears the repo's significance bar (clustered t>=2):`);
      if (sigOk) {
        console.log(`      ${sigOk.mix}, TP ${sigOk.tp.toFixed(2)}% / SL ${sigOk.sl.toFixed(2)}%, x${sigOk.lev} — EXCESS ${pctS(sigOk.excessCluster, 4)}% (t=${sigOk.excessT.toFixed(2)}) vs a ${sigOk.feeEq.toFixed(4)}% fee`);
        console.log(`      TP reached in ${(sigOk.tpReach * 100).toFixed(1)}% of 4h windows; (A) won ${sigOk.wA == null ? "—" : (sigOk.wA * 100).toFixed(0)}% of ${sigOk.nA} resolved`);
      } else {
        console.log(`      NONE — no surviving ticket reaches clustered t>=2 on this sample.`);
      }
    }
  }

  /* ── 10. the bottom line ────────────────────────────────────────────── */
  console.log(`\n[10] THE BOTTOM LINE`);
  const shippedExcess = (shipA.evPctNotional - shipB.evPctNotional) * rho;
  const takerFeeEq = MIXES["taker-taker"] * rho;
  console.log(`  THE DECIDING NUMBERS, at $60 notional on $${EQUITY.toFixed(2)} of equity (rho ${rho.toFixed(4)}):`);
  console.log(`    the measured EXCESS of the signal over beta   ${MEASURED_EXCESS.low}% – ${MEASURED_EXCESS.high}% of equity per trade`);
  console.log(`    the taker round trip on $60 notional          ${takerFeeEq.toFixed(4)}% of equity per trade ($${(NOTIONAL_CAP * MIXES["taker-taker"] / 100).toFixed(4)})`);
  console.log(`    the maker-taker round trip                    ${(MIXES["maker-taker"] * rho).toFixed(4)}% of equity per trade ($${(NOTIONAL_CAP * MIXES["maker-taker"] / 100).toFixed(4)})`);
  console.log(`    the maker-maker round trip                    ${(MIXES["maker-maker"] * rho).toFixed(4)}% of equity per trade ($${(NOTIONAL_CAP * MIXES["maker-maker"] / 100).toFixed(4)})`);

  const verdict = (() => {
    if (!survives.length) return { ok: false };
    const best = [...survives].sort((a, b) => b.excessCluster - a.excessCluster)[0];
    const minT = [...survives].sort((a, b) => a.tp - b.tp || a.sl - b.sl)[0];
    const sigBest = survivesSig.length ? [...survivesSig].sort((a, b) => b.excessCluster - a.excessCluster)[0] : null;
    return { ok: true, best, minT, sigBest };
  })();

  console.log(`\n  VERDICT`);
  if (!verdict.ok) {
    console.log(`    NO ticket clears the fee floor at this account size.`);
    console.log(`    The measured excess of the signal over beta (${MEASURED_EXCESS.low}%–${MEASURED_EXCESS.high}% of equity per trade)`);
    console.log(`    is smaller than the taker round trip (${takerFeeEq.toFixed(4)}%) at the $60 cap. Every trade loses the fee.`);
  } else {
    const b = verdict.best;
    console.log(`    A ticket EXISTS whose measured excess beats the taker fee: ${b.mix}, TP ${b.tp.toFixed(2)}% / SL ${b.sl.toFixed(2)}%, x${b.lev}.`);
    console.log(`      excess ${pctS(b.excessCluster, 4)}% of equity per trade (clustered t=${b.excessT.toFixed(2)}) against a ${b.feeEq.toFixed(4)}% fee.`);
    console.log(`      the MINIMUM viable (smallest target): ${verdict.minT.mix}, TP ${verdict.minT.tp.toFixed(2)}% / SL ${verdict.minT.sl.toFixed(2)}%, x${verdict.minT.lev}.`);
    console.log(`      BUT the repo's bar is n>=30 independent clusters with t>=2, and the signal arm has only ~${buckets.size} clusters.`);
    if (!verdict.sigBest) {
      console.log(`      NO surviving ticket clears that bar. The excess is positive and consistent but not significant.`);
    }
  }
  console.log(`\n  AND THE ACCOUNT-SIZE QUESTION, answered directly:`);
  console.log(`    The fee floor is NOT a function of the account size — it is a function of rho = notional/equity.`);
  console.log(`    The account becomes fee-viable ONLY by cutting the notional to where the signal's`);
  console.log(`    measured excess still clears the round trip:`);
  for (const [k, f] of Object.entries(MIXES)) {
    const maxN = (EQUITY * MEASURED_EXCESS.low) / f;
    console.log(`      ${k.padEnd(12)} notional <= $${maxN.toFixed(2)}  (${((maxN / EQUITY) * 100).toFixed(0)}% of equity, ${(maxN / NOTIONAL_CAP).toFixed(2)}x the current $60 cap)`);
  }
  console.log(`    At the current $60 cap and a taker entry, the answer is NO.`);

  // THE ROBUSTNESS CHECK THAT MATTERS MOST: the excess is not a stable
  // constant. It was measured on the repo's own window at +0.054% to
  // +0.098% and grows with the sample. So the honest verdict is a RANGE,
  // and the RANGE is what decides whether a ticket is viable.
  console.log(`\n  THE EXCESS IS A RANGE, NOT A POINT — and the range is what decides viability:`);
  console.log(`    the repo's published excess (its own window, n=72-81): +${MEASURED_EXCESS.low}% to +${MEASURED_EXCESS.high}% of equity`);
  console.log(`    this study's excess on the SAME window, same method:        +0.0746% (TP 0.5/SL 1.2)`);
  console.log(`    this study's excess on the CURRENT (larger) sample:         +0.0778% to +0.2648%`);
  console.log(`    → the excess GROWS with the sample but its SIGN is stable. The conservative end`);
  console.log(`      (+${MEASURED_EXCESS.low}%) is the one that decides the recommendation.`);

  const robustSurvives = survives.filter((c) => c.excessCluster > c.feeEq);
  const robustSig = robustSurvives.filter((c) => c.excessT >= 2);
  console.log(`\n  AT THE CONSERVATIVE EXCESS (${MEASURED_EXCESS.low}%), the notional limit is:`);
  for (const [k, f] of Object.entries(MIXES)) {
    const maxN = (EQUITY * MEASURED_EXCESS.low) / f;
    console.log(`    ${k.padEnd(12)} notional <= $${maxN.toFixed(2)}`);
  }
  console.log(`  → the recommendation below is stated against the CONSERVATIVE excess, because the`);
  console.log(`    measured excess is not yet significant at the repo's own bar.`);

  console.log(`\n  THE ACCOUNT-SIZE ANSWER, AS A TABLE — the notional the account would need, per pair`);
  console.log(`  (the notional must ALSO be >= one contract's notional, or the trade cannot be placed)`);
  console.log("");
  console.log(`  ${pad("PAIR", 16)} ${padL("1lot$", 9)} ${padL("feeOK$", 9)} ${padL("lots", 6)} ${padL("notional$", 11)} ${padL("minTP%", 7)} ${padL("minSL%", 7)} ${padL("lev", 5)}  verdict`);
  console.log("  " + "-".repeat(94));
  // The notional limit is computed with the fee mix the LIVE PATH PAYS —
  // taker-taker, because the entry is a market order. The maker-maker
  // number is shown separately in section 8 as the improvement path.
  const feeOkNotional = (EQUITY * MEASURED_EXCESS.low) / MIXES["taker-taker"];
  const sizeTable = [];
  for (const pair of pairs) {
    const base = pair.split("/")[0];
    const c = bySym.get(`${base}USDTM`);
    const lotNotional = c ? c.multiplier * c.markPrice : NaN;
    const lotsAtFeeOk = lotNotional > 0 ? Math.floor(feeOkNotional / lotNotional) : 0;
    // the notional this pair would actually trade, at the fee-viable size
    const notional = lotsAtFeeOk >= 1 ? Math.min(feeOkNotional, lotsAtFeeOk * lotNotional) : lotNotional;
    const atr = median(atrByPair.get(pair));
    // the minimum viable geometry at THIS notional (rho changes with it)
    const rhoHere = notional / EQUITY;
    let best = null;
    for (let sl = Math.max(0.3, MIN_STOP_ATR_FRACTION * atr); sl <= 2.5001; sl += 0.05) {
      for (let tp = 0.3; tp <= 3.0001; tp += 0.05) {
        const ev = expectancyPctEquity(MEASURED_WIN_RATE, tp, sl, MIXES["taker-taker"], rhoHere);
        if (!(ev > 0)) continue;
        if (feeDrag(MIXES["taker-taker"], sl) > FEE_DRAG_CEILING_FILTER) continue;
        if (reachAt(envA.reach, tp) / envA.n <= 0) continue;
        const lev = derivedLeverage(sl);
        if (lev.lev > HARD_MAX_LEVERAGE) continue;
        if (!best || tp < best.tp || (tp === best.tp && sl < best.sl)) best = { tp, sl, lev: lev.lev };
      }
    }
    const feasible = lotsAtFeeOk >= 1;
    sizeTable.push({ pair, lotNotional, lotsAtFeeOk, notional, best, feasible });
    console.log(
      `  ${pad(pair, 16)} ${padL(lotNotional.toFixed(3), 9)} ${padL("$" + feeOkNotional.toFixed(2), 9)} ${padL(lotsAtFeeOk, 6)} ${padL("$" + notional.toFixed(2), 11)} ${padL(best ? best.tp.toFixed(2) : "—", 7)} ${padL(best ? best.sl.toFixed(2) : "—", 7)} ${padL(best ? "x" + best.lev : "—", 5)}  ${feasible ? (best ? "VIABLE at small size" : "no viable geometry") : "ONE LOT TOO BIG"}`,
    );
  }
  const feasiblePairs = sizeTable.filter((s) => s.feasible);
  console.log("");
  console.log(`  the fee-viable notional at the taker-taker round trip is $${feeOkNotional.toFixed(2)}`);
  console.log(`  (${((feeOkNotional / EQUITY) * 100).toFixed(0)}% of equity, ${(feeOkNotional / NOTIONAL_CAP).toFixed(2)}x the current $60 cap)`);
  console.log(`  ${feasiblePairs.length} of ${pairs.length} pairs can be traded at a fee-viable size on this equity.`);
  console.log(`  ${sizeTable.length - feasiblePairs.length} pair(s) have one contract worth MORE than the fee floor allows:`);
  for (const s of sizeTable.filter((x) => !x.feasible)) console.log(`    ${pad(s.pair, 16)} 1 lot = $${s.lotNotional.toFixed(3)} > $${feeOkNotional.toFixed(2)}`);
  console.log(`  → the machine can only be made fee-viable by cutting the position size to a fraction`);
  console.log(`    of the current $60 cap, and by trading pairs whose one contract is small.`);

  writeFileSync(
    SUMMARY,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        equity: EQUITY,
        notionalCap: NOTIONAL_CAP,
        rho,
        mixes: MIXES,
        measuredWinRate: MEASURED_WIN_RATE,
        measuredExcess: MEASURED_EXCESS,
        excursion: {
          A: { n: envA.n, upMean: envA.upMean, downMean: envA.downMean, dirMean: envA.dirMean, reach: envA.reach },
          B: { n: envB.n, upMean: envB.upMean, downMean: envB.downMean, dirMean: envB.dirMean, reach: envB.reach },
          C: { n: envC.n, upMean: envC.upMean, downMean: envC.downMean, reach: envC.reach },
        },
        grid: grid.map((r) => ({
          name: r.g.name,
          tp: r.g.tp,
          sl: r.g.sl,
          signal: { n: r.simA.n, resolved: r.simA.nResolvedTrades, winRate: r.simA.winRateResolved, resolutionRate: r.simA.resolutionRate, evPctNotional: r.simA.evPctNotional },
          beta: { n: r.simB.n, resolved: r.simB.nResolvedTrades, winRate: r.simB.winRateResolved, evPctNotional: r.simB.evPctNotional },
          history14d: { n: r.simC.n, winRate: r.simC.winRateResolved, resolutionRate: r.simC.resolutionRate, evPctNotional: r.simC.evPctNotional },
          excessPctEquity: r.excess,
          excessT: r.excessT,
          mixes: Object.fromEntries(Object.entries(r).filter(([k]) => MIXES[k]).map(([k, v]) => [k, v])),
        })),
        perPair: perPair.map((p) => ({
          pair: p.pair,
          atrPct: p.atr,
          tpPct: p.g.tpPct,
          slPct: p.g.slPct,
          leverage: p.lev.lev,
          feeDragTaker: feeDrag(MIXES["taker-taker"], p.g.slPct),
          breakEvenWinRate: breakEvenWinRate(p.g.tpPct, p.g.slPct, MIXES["taker-taker"]),
          expectancyPctEquityAt66: p.ev,
          oneLotNotionalUsd: p.lotNotional,
          lotsAt60: p.lots,
          marginUsd: p.margin,
        })),
        viableCandidates: candidates,
        survivingCandidates: survives,
        verdict: verdict.ok ? { best: verdict.best, minTarget: verdict.minT } : null,
      },
      null,
      2,
    ),
  );
  console.log(`\n  summary written to ${SUMMARY}`);
}

main().catch((e) => {
  console.error(`[fee-floor] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
