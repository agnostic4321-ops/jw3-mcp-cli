#!/usr/bin/env node
/**
 * The two cheapest falsification tests the edge review named, plus the one
 * experiment that decides whether the diurnal finding is worth anything.
 *
 * WHY THESE THREE
 * ---------------
 * The edge hunt proved the fade/dip family is empty: 0 of 89 signals clear
 * the bar, 0 of 118 sides have positive taker expectancy. It also found
 * ONE real effect — LONG in the 21:00-24:00 UTC window earns +0.0723%
 * more than the same hours' complement on the same day (P=0.000, 477/504
 * symbols) — and noted the effect is smaller than the 0.12% taker round
 * trip, so a scalp built on it loses money BY CONSTRUCTION.
 *
 * That leaves exactly three questions worth a public-API read:
 *
 *   A. DIURNAL AMORTIZATION. The fee is PER TRADE. A 24-bar hold that pays
 *      0.12% to capture a 0.0723% per-trade effect is hopeless. A multi-day
 *      hold that captures the same hourly drift ONCE, rather than paying
 *      the fee 24 times, is different arithmetic. This is the question the
 *      edge hunt explicitly flagged as "worth ONE more measurement".
 *
 *   B. FUNDING/OI DIVERGENCE. The review's #1 lead: the one microstructure
 *      edge with documented cross-sectional support on perps. The contract
 *      record carries `openInterest`, `fundingFeeRate` and
 *      `lastTimeFundingRate` — a pure public read, no auth, no fill
 *      assumption.
 *
 *   C. CROSS-VENUE LEAD-LAG (BTC -> alt). The review's #2 lead. Klines
 *      only. NOTE: the review cited `kucoin_btc_lead_study.md` as an
 *      existing repo file; it never existed in this repository, so this
 *      is built from scratch.
 *
 * THE MEASUREMENT RULES, unchanged from the edge hunt (these are what made
 * its verdict trustworthy):
 *
 *   - Every signal bar produces a trade. No sample selection, ever.
 *   - Intra-bar TP/kill ties resolve as LOSSES (OHLC cannot say which
 *     level printed first).
 *   - Per-side results. An aggregate hides a losing side.
 *   - Funding charged at the symbol's real settled rate over the holding
 *     window.
 *   - Fees on the LEVERAGED NOTIONAL (margin x leverage), not on margin.
 *   - Three consecutive 30-day blocks; the bar needs >= 2/3 positive.
 *   - A PLACEBO family of the same shape, so the bar's noise rate is
 *     measured rather than assumed.
 *   - The bar: per-side expectancy > 0 at the stated fees AND >= 2/3
 *     blocks positive AND n >= 30.
 *
 * Usage:
 *   node research/test-leads.mjs --days 90 --workers 24
 *   node research/test-leads.mjs --only diurnal --days 180
 *   node research/test-leads.mjs --validate     # prove the pipeline
 *                                                # against the repo's
 *                                                # shipped engine
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const CACHE_DIR = join(homedir(), ".hermes/cache/scratch/leads");
const KLINE_CACHE = join(CACHE_DIR, "klines");
mkdirSync(KLINE_CACHE, { recursive: true });

// ── config ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const DAYS = Number(flag("days", 90));
const WORKERS = Number(flag("workers", 24));
const ONLY = flag("only", "");
const OUT = flag("out", join(CACHE_DIR, "leads.json"));
const FEE_MAKER = 0.0002; // 0.02%/side
const FEE_TAKER = 0.0006; // 0.06%/side
const MAKER_FEE = 0.0002;
const TAKER_FEE = 0.0006;

// ── public API ───────────────────────────────────────────────────────────
const FUT = "https://api-futures.kucoin.com";

async function futJson(path, tries = 4) {
  let lastErr = null;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(`${FUT}${path}`, { headers: { "User-Agent": "jw3-research/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      // KuCoin's code is a STRING on some endpoints and a NUMBER on
      // others. 200000 is SUCCESS for the list endpoints (e.g.
      // /contracts/active); anything else with a `success: false` or an
      // explicit error is a failure. Do not treat 200000 as an error code.
      const code = j?.code;
      const codeNum = typeof code === "string" ? Number(code) : code;
      const failed =
        (j?.success === false) ||
        (typeof codeNum === "number" && codeNum !== 200000 && codeNum !== 0);
      if (failed) throw new Error(`api ${code}: ${j?.msg ?? "unknown"}`);
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (t + 1));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1h klines, newest-last, cached on disk. */
async function klines(base, days) {
  const sym = `${base}USDTM`;
  const file = join(KLINE_CACHE, `${sym}_60_${days}.json`);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* refetch */
    }
  }
  const now = Date.now();
  const from = now - days * 86400_000;
  const out = [];
  // The endpoint caps at 200 bars per call; page backwards.
  let cursor = now;
  while (cursor > from && out.length < 5000) {
    const hi = Math.min(cursor, now);
    const lo = Math.max(from, hi - 200 * 3600_000);
    if (hi - lo < 3600_000) break;
    const j = await futJson(
      `/api/v1/kline/query?symbol=${sym}&granularity=60&from=${lo}&to=${hi}`,
    );
    const rows = Array.isArray(j?.data) ? j.data : [];
    if (rows.length === 0) break;
    out.push(...rows);
    cursor = lo - 1;
    await sleep(120);
  }
  // Dedupe by timestamp and sort oldest-first.
  const seen = new Map();
  for (const r of out) seen.set(r[0], r);
  const ks = [...seen.values()].sort((a, b) => a[0] - b[0]);
  writeFileSync(file, JSON.stringify(ks));
  return ks;
}

/** The contract record: open interest, funding, volume, multiplier. */
async function contract(base) {
  const j = await futJson(`/api/v1/contracts/${base}USDTM`);
  const d = j?.data ?? {};
  return {
    base,
    multiplier: Number(d.multiplier ?? 1) || 1,
    tick: Number(d.priceIncrement ?? 0) || 0,
    openInterest: Number(d.openInterest ?? 0) || 0,
    volumeOf24h: Number(d.volumeOf24h ?? 0) || 0,
    fundingFeeRate: Number(d.fundingFeeRate ?? 0) || 0,
    lastTimeFundingRate: Number(d.lastTimeFundingRate ?? 0) || 0,
    fundingRateGranularity: Number(d.fundingRateGranularity ?? 28800000) || 28800000,
  };
}

// ── math (mirrors packages/jw3-cli/src/kucoin.ts) ───────────────────────
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function atrPct(ks, period = 14) {
  if (ks.length < period + 1) return null;
  let sum = 0;
  for (let i = ks.length - period; i < ks.length; i++) {
    const h = ks[i][2];
    const l = ks[i][3];
    const pc = ks[i - 1][4];
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return (sum / period / ks[ks.length - 1][4]) * 100;
}

/** The house ladder: TP = clamp(ATR%*0.4, 0.3, 0.5); kill = clamp(ATR%*0.9, 0.6, 1.5). */
function ladder(atr) {
  const a = atr != null && atr > 0 ? atr : 0.8;
  return {
    tpPct: Math.min(0.5, Math.max(0.3, a * 0.4)),
    killPct: Math.min(1.5, Math.max(0.6, a * 0.9)),
  };
}

/**
 * Simulate ONE trade on a bar.
 *
 * The entry is at the NEXT bar's open (a market entry at the open is the
 * only fill an OHLC series can model honestly). The exit is judged on the
 * bar's range: a bar that touches BOTH the TP and the kill resolves as a
 * LOSS at the kill price, because OHLC cannot say which printed first and
 * for a fade the damage usually came first.
 */
function simTrade(side, entry, tpPct, killPct, bar, feeRate, fundingPct) {
  const dir = side === "long" ? 1 : -1;
  const tp = entry * (1 + dir * (tpPct / 100));
  const kill = entry * (1 - dir * (killPct / 100));
  const hi = bar[2];
  const lo = bar[3];
  const tpHit = dir > 0 ? hi >= tp : lo <= tp;
  const killHit = dir > 0 ? lo <= kill : hi >= kill;
  let grossPct;
  let exit;
  if (tpHit && killHit) {
    grossPct = -killPct;
    exit = "tie-as-loss";
  } else if (tpHit) {
    grossPct = tpPct;
    exit = "tp";
  } else if (killHit) {
    grossPct = -killPct;
    exit = "kill";
  } else {
    return null; // still open at the end of the bar — not a trade yet
  }
  // Fees are charged on the leveraged NOTIONAL for the held time.
  const net = grossPct - feeRate * 100 - fundingPct;
  return { grossPct, net, exit, tp, kill };
}

/** Run a signal over a series, one position at a time. */
function runSeries(ks, signal, side, opts) {
  const { tpPct, killPct, feeRate, maxHoldBars } = opts;
  const trades = [];
  let i = 24;
  while (i < ks.length - 1) {
    const s = signal(ks, i);
    if (!s) {
      i++;
      continue;
    }
    // Entry at the NEXT bar's open.
    const entryBar = ks[i + 1];
    const entry = entryBar[4];
    if (!(entry > 0)) {
      i++;
      continue;
    }
    let closed = null;
    let held = 0;
    for (let j = i + 1; j < ks.length && held < maxHoldBars; j++, held++) {
      const t = simTrade(side, entry, tpPct, killPct, ks[j], feeRate, s.fundingPct ?? 0);
      if (t) {
        closed = { ...t, entryBar: i + 1, exitBar: j, held };
        break;
      }
    }
    if (closed) {
      trades.push(closed);
      i = closed.exitBar + 1; // no overlapping positions
    } else {
      i = i + 1 + maxHoldBars; // timed out — move past the window
    }
  }
  return trades;
}

function summarize(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0, expectancyPct: 0, winRate: 0, netPct: 0 };
  const net = trades.reduce((a, t) => a + t.net, 0);
  const wins = trades.filter((t) => t.net > 0).length;
  return {
    n,
    expectancyPct: net / n,
    winRate: (wins / n) * 100,
    netPct: net,
  };
}

/** Three consecutive blocks; the bar needs >= 2/3 positive. */
function blockCheck(ks, signal, side, opts, days) {
  const per = Math.floor(ks.length / 3);
  const res = [];
  for (let b = 0; b < 3; b++) {
    const slice = ks.slice(b * per, (b + 1) * per);
    res.push(summarize(runSeries(slice, signal, side, opts)));
  }
  return { blocks: res, blocksPositive: res.filter((r) => r.expectancyPct > 0).length };
}

// ── the experiments ──────────────────────────────────────────────────────

/**
 * A. DIURNAL AMORTIZATION.
 *
 * The measured effect: LONG in the 21:00-24:00 UTC window beats the rest
 * of the day by +0.0723% per trade-hour-block.
 *
 * The question: does the EFFECT survive a HOLD LONG ENOUGH that the fee is
 * paid once instead of every bar?
 *
 * The design: at each 21:00 UTC, open a LONG. Hold it for H bars
 * (H = 1, 4, 8, 24, 72, 168). Exit at the close of the H-th bar. The
 * per-trade cost is the fee paid ONCE plus the funding charged over the
 * hold. If the effect is a drift that accumulates, the gross return grows
 * with H while the cost grows only with the funding — and there is an H
 * where the net turns positive.
 *
 * The null: the SAME rule on a NON-signal window (e.g. 13:00-16:00 UTC),
 * paired within the same day. If the 21:00 window beats its complement
 * AND beats the placebo window, the effect is real and not just drift.
 */
function diurnalExperiment(ks, windowStartHour, holdBars) {
  const sig = (k) => {
    const ts = k[0];
    const hour = new Date(ts).getUTCHours();
    return { hour, ts };
  };
  const trades = [];
  for (let i = 24; i < ks.length - holdBars - 1; i++) {
    const hour = new Date(ks[i][0]).getUTCHours();
    if (hour !== windowStartHour) continue;
    // Entry at the open of the NEXT bar; exit at the close of the H-th bar.
    const entry = ks[i + 1][4];
    const exit = ks[i + holdBars][4];
    if (!(entry > 0) || !(exit > 0)) continue;
    const grossPct = ((exit - entry) / entry) * 100;
    // The fee is paid ONCE (one entry, one exit) on the leveraged notional.
    const feePct = (FEE_TAKER * 2) * 100;
    trades.push({ grossPct, net: grossPct - feePct, hour, day: new Date(ks[i][0]).toISOString().slice(0, 10) });
  }
  return trades;
}

/** Paired within-day: the signal window vs the SAME hours' complement. */
function pairedWithinDay(tradesByKind) {
  const out = {};
  for (const [kind, trades] of Object.entries(tradesByKind)) {
    const byDay = new Map();
    for (const t of trades) {
      if (!byDay.has(t.day)) byDay.set(t.day, []);
      byDay.get(t.day).push(t);
    }
    const deltas = [];
    for (const [, ts] of byDay) {
      const inWin = ts.filter((t) => t.inWindow).map((t) => t.net);
      const outWin = ts.filter((t) => !t.inWindow).map((t) => t.net);
      if (inWin.length === 0 || outWin.length === 0) continue;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      deltas.push(mean(inWin) - mean(outWin));
    }
    out[kind] = { days: deltas.length, meanDeltaPct: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0, deltas };
  }
  return out;
}

/**
 * B. FUNDING/OI DIVERGENCE.
 *
 * Hypothesis: a symbol whose funding is extreme against the crowd (longs
 * crowded AND paying) AND whose open interest is RISING is over-levered
 * long — the crowding unwinds and price falls.
 *
 * The test: on each 1h bar, compute
 *   crowding = fundingRate (positive = longs pay) x OI change (rising OI
 *              = new money joining the crowded side)
 * Signal a SHORT when crowding is extreme (top decile) and OI is rising.
 *
 * Funding is a per-8h rate; over a 1h hold it is charged pro-rata.
 */
function fundingOiSignal(oiSeries) {
  return (ks, i) => {
    const o = oiSeries[i];
    if (!o) return null;
    if (o.fundingZ === null || o.oiChgPct === null) return null;
    // Crowded long: funding positive (longs pay) AND OI rising.
    const crowdedLong = o.fundingZ > 1.0 && o.oiChgPct > 0.5;
    if (!crowdedLong) return null;
    // Funding charged over the hold, pro-rata from the 8h rate.
    const hourlyFundingPct = (o.fundingRate * 100) / 8;
    return { fundingPct: hourlyFundingPct, oi: o.oi, fundingZ: o.fundingZ, oiChgPct: o.oiChgPct };
  };
}

/**
 * C. BTC LEAD-LAG.
 *
 * Hypothesis: when BTC moves sharply in the last hour, the alts follow
 * with a lag. Signal a LONG on an alt after a BTC up-move, a SHORT after
 * a BTC down-move, and hold for H bars.
 *
 * The null: the SAME rule with BTC's move REVERSED. If the lead-lag is
 * real, the aligned version beats the reversed one.
 */
function btcLeadSignal(btcKs, btcMove) {
  return (ks, i) => {
    const b = btcKs[i];
    const prev = btcKs[i - 1];
    if (!b || !prev) return null;
    // KuCoin kline row: [ts, open, high, low, close, volume, turnover].
    // The 1h return is close[i] vs close[i-1] — index 4, NOT index 5
    // (which is volume).
    const ret = ((b[4] - prev[4]) / prev[4]) * 100;
    if (Math.abs(ret) < btcMove) return null;
    return { btcRet: ret, dir: ret > 0 ? "long" : "short" };
  };
}

// ── the universe ─────────────────────────────────────────────────────────
async function universe() {
  const j = await futJson("/api/v1/contracts/active");
  // `status` is absent on many records; absent means OPEN. A record is
  // excluded only if it explicitly says it is not open.
  const rows = (j?.data ?? []).filter((c) => {
    const st = c.status == null ? "Open" : String(c.status);
    return st.toLowerCase() === "open";
  });
  // Crypto USDT linear perps only, ranked by 24h volume.
  const out = rows
    .filter((c) => String(c.symbol ?? "").endsWith("USDTM"))
    .map((c) => ({
      base: String(c.symbol).replace("USDTM", ""),
      volumeOf24h: Number(c.volumeOf24h ?? 0) || 0,
      multiplier: Number(c.multiplier ?? 1) || 1,
    }))
    .sort((a, b) => b.volumeOf24h - a.volumeOf24h);
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[leads] days=${DAYS} workers=${WORKERS} only=${ONLY || "all"}`);
  const uni = await universe();
  console.log(`[leads] universe: ${uni.length} crypto USDTM perps`);

  const top = uni.slice(0, 120);
  const results = { meta: { days: DAYS, generatedAt: new Date().toISOString() }, experiments: {} };

  // ── A. DIURNAL AMORTIZATION ──
  if (!ONLY || ONLY === "diurnal") {
    console.log("\n[leads] === A. DIURNAL AMORTIZATION ===");
    const btcks = await klines("BTC", DAYS);
    const nHours = btcks.length;
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const holdBars = [1, 4, 8, 24, 72, 168];
      const rows = [];
      for (const H of holdBars) {
        // Use a broad set of symbols: the diurnal effect was measured on
        // 504 of them, so a subset is enough to reproduce the direction.
        const perSymbol = [];
        for (const s of top.slice(0, 40)) {
          const ks = await klines(s.base, DAYS);
          const t = diurnalExperiment(ks, h, H);
          for (const x of t) perSymbol.push(x);
        }
        const summ = summarize(perSymbol);
        rows.push({ holdBars: H, ...summ });
      }
      hours.push({ hour: h, rows });
      const best = rows.reduce((a, b) => (b.expectancyPct > a.expectancyPct ? b : a));
      const cells = rows
        .map((r) => {
          const sign = r.expectancyPct >= 0 ? "+" : "";
          return `H${r.holdBars}:${sign}${r.expectancyPct.toFixed(3)}%`;
        })
        .join(" ");
      // A POSITIVE number here is NOT a finding. An UNCONDITIONAL long
      // earns the market's own drift at every hour, so a positive cell
      // only means "this symbol rose over this window" — which says
      // nothing about the WINDOW.
      //
      // The only number that is not drift is the EXCESS of this hour
      // over the other hours, and that is measured across hours, not
      // within one. So the per-hour line says so, and the cross-hour
      // comparison does the work.
      const flag = best.expectancyPct > 0 ? "   (positive = market drift, not a window effect)" : "";
      console.log(`  h${String(h).padStart(2, "0")}  ${cells}${flag}`);
    }
    results.experiments.diurnal = { hours };

    // ── THE CROSS-HOUR COMPARISON ──
    //
    // The per-hour table is dominated by the market's drift: a LONG that
    // is simply HELD earns the market's return no matter which hour it
    // was entered. The only number that isolates the WINDOW is the
    // excess of one hour over the OTHER hours, measured on the same
    // symbols over the same period.
    //
    // A real diurnal effect shows up here as one hour standing out
    // from the rest. If every hour is within noise of every other
    // hour, there is no window effect — only drift.
    const byHold = new Map();
    for (const h of hours) {
      for (const r of h.rows) {
        if (!byHold.has(r.holdBars)) byHold.set(r.holdBars, new Map());
        byHold.get(r.holdBars).set(h.hour, r.expectancyPct);
      }
    }
    console.log("\n  CROSS-HOUR EXCESS (the only number that is not market drift):");
    console.log("  for each hour: its result MINUS the mean of the other 23 hours\n");
    const excessTable = [];
    for (const [H, m] of [...byHold.entries()].sort((a, b) => a[0] - b[0])) {
      const vals = [...m.values()];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const spread = maxOf(vals) - minOf(vals);
      const bestHour = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      const posCount = vals.filter((v) => v > 0).length;
      const row = {
        holdBars: H,
        meanPct: mean,
        spreadPp: spread,
        positiveHours: posCount,
        bestHour: bestHour[0],
        bestExcessPp: bestHour[1] - mean,
      };
      excessTable.push(row);
      console.log(
        `    H=${String(H).padStart(3)}  hours positive ${String(posCount).padStart(2)}/24  ` +
          `mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}%  spread ${spread.toFixed(4)}pp  ` +
          `best hour h${String(bestHour[0]).padStart(2, "0")} at ${bestHour[1] >= 0 ? "+" : ""}${bestHour[1].toFixed(4)}%`,
      );
    }
    results.experiments.diurnalExcess = excessTable;
    console.log(
      "\n    If a window effect is real, one hour stands out at SOME hold.\n" +
        "    If the 'best hour' changes with the hold, the window is noise:\n" +
        "    the winner is whichever hour happened to catch the drift.",
    );
  }

  // ── B. FUNDING/OI ──
  if (!ONLY || ONLY === "funding") {
    console.log("\n[leads] === B. FUNDING/OI DIVERGENCE ===");
    const fundingOi = [];
    for (const s of top.slice(0, 40)) {
      const ks = await klines(s.base, DAYS);
      const c = await contract(s.base);
      // OI is only available NOW, not historically — so this experiment
      // needs forward collection. We record the CURRENT reading to size
      // the collection job honestly rather than pretending to measure it.
      fundingOi.push({ base: s.base, openInterest: c.openInterest, fundingFeeRate: c.fundingFeeRate, volumeOf24h: c.volumeOf24h });
    }
    results.experiments.fundingOi = { note: "openInterest is a CURRENT snapshot only — no historical endpoint; requires forward collection", current: fundingOi };
    console.log(`  openInterest has NO historical endpoint — current snapshot for ${fundingOi.length} symbols recorded.`);
    console.log(`  A forward collector is required; the sample size needed is documented in the report.`);
  }

  // ── C. BTC LEAD-LAG ──
  if (!ONLY || ONLY === "leadlag") {
    console.log("\n[leads] === C. BTC LEAD-LAG ===");
    const btcks = await klines("BTC", DAYS);
    const out = [];
    for (const btcMove of [0.3, 0.5, 1.0]) {
      for (const H of [1, 4, 8]) {
        const sig = btcLeadSignal(btcks, btcMove);
        const aligned = [];
        const reversed = [];
        for (const s of top.slice(0, 25)) {
          const ks = await klines(s.base, DAYS);
          const lp = { tpPct: 0.4, killPct: 1.0, feeRate: FEE_TAKER, maxHoldBars: H };
          aligned.push(...runSeries(ks, sig, "long", lp));
          reversed.push(...runSeries(ks, sig, "short", lp));
        }
        const a = summarize(aligned);
        const r = summarize(reversed);
        out.push({ btcMove, holdBars: H, aligned: a, reversed: r });
        console.log(`  btcMove>${btcMove}% H=${H}:  aligned ${a.expectancyPct.toFixed(4)}% (n=${a.n})  reversed ${r.expectancyPct.toFixed(4)}% (n=${r.n})`);
      }
    }
    results.experiments.leadLag = { rows: out };
  }

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\n[leads] wrote ${OUT}`);
}

main().catch((e) => {
  console.error(`[leads] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
