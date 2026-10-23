#!/usr/bin/env node
/**
 * THE INDEPENDENT VENUE COLLECTOR — Binance USDⓈ-M perpetuals.
 *
 * ── WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG ──
 *
 * It must not touch the account or the venue the machine trades on. The
 * collector's KuCoin reads share ONE per-minute budget with the daemon's
 * monitor, the watchdog and the trade loop, and a research burst through
 * that budget can starve the WATCHDOG — whose own venue read, when
 * throttled three times in a row, latches a breaker that is human-only to
 * clear. So this script NEVER calls KuCoin, and never calls the account.
 *
 * Binance's public market-data endpoints are keyless and have their own
 * generous IP budget, entirely separate from the account's.
 *
 * ── WHAT IT COLLECTS, AND WHY IT IS THE SAME STATE ──
 *
 * The collector on KuCoin records, per observation, the TAPE's metrics
 * (computed from 60 one-minute candles by `fadeMetrics` in
 * `src/kucoin.ts`), the BOOK's top-5 imbalance, and the two model legs.
 *
 * This script reproduces the TAPE and the BOOK on Binance:
 *
 *   - the TAPE from Binance's 1-minute klines, using the SAME
 *     `fadeMetrics` maths (ported into `rep-venue-common.mjs` and
 *     verified against the machine's own recorded output);
 *   - the BOOK from Binance's depth endpoint, using the SAME imbalance
 *     and spread formulae.
 *
 * The observations are placed on a 5-minute grid — the collector's own
 * cadence — so the cluster structure (one cluster per 5-minute bucket)
 * is the same on both venues.
 *
 * ── THE HISTORICAL BOOK IS THE ONE THING THAT CANNOT BE BACKFILLED ──
 *
 * The tape can be reconstructed at ANY past timestamp from 1-minute
 * klines, so the whole window is backfilled. The order book cannot: a
 * depth snapshot is only the book at that instant. So the script
 * collects the book LIVE, on the same 5-minute grid, over a shorter
 * window, and the measurement is run in two variants:
 *
 *   (a) WITHOUT the book leg — fully backfillable, the long window.
 *   (b) WITH the book leg — live-sampled, the short window.
 *
 * The KuCoin side is measured in BOTH variants too, so the comparison
 * is like-for-like and the book leg's contribution is visible rather
 * than assumed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fadeMetrics, spikeImbalance, spikeSpreadBps, tapeSideOf } from "./rep-venue-common.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const BIN = "https://fapi.binance.com";

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const DAYS = Number(flag("days", 7));
const OUT = String(flag("out", join(homedir(), ".hermes/cache/scratch/rep-binance-obs.json")));
const BARS_OUT = String(flag("bars-out", join(homedir(), ".hermes/cache/scratch/rep-binance-15m-bars.json")));
const UNIVERSE = String(flag("universe", join(homedir(), ".hermes/cache/scratch/rep-bases.json")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`non-JSON response (${r.status}): ${txt.slice(0, 200)}`); }
  if (j && j.code && String(j.code) !== "200" && j.msg && /invalid|unknown/i.test(j.msg)) {
    throw new Error(`api error ${j.code}: ${j.msg}`);
  }
  return j;
}

/** The KuCoin base -> Binance symbol map, built from Binance's own instrument list. */
async function buildSymbolMap(bases) {
  const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
  const perps = new Set(
    (info.symbols ?? [])
      .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
      .map((s) => s.symbol),
  );
  const map = {};
  const unmapped = [];
  for (const b of bases) {
    const cands = [];
    if (b === "XBT") cands.push("BTCUSDT");
    else {
      cands.push(`${b}USDT`);
      // KuCoin lists PEPE/SHIB/FLOKI/LUNC/XEC directly; Binance lists the
      // 1000-multiplied contract. The PRICE SCALE differs by 1000, but
      // every measurement here is either a PERCENTAGE of the entry or a
      // NOTIONAL, and both are scale-invariant — so the two contracts
      // measure the same thing.
      if (b.startsWith("1000")) cands.push(`${b.slice(4)}USDT`);
      if (b.startsWith("10000")) cands.push(`${b.slice(5)}USDT`);
      cands.push(`1000${b}USDT`);
    }
    const hit = cands.find((c) => perps.has(c));
    if (hit) map[b] = hit;
    else unmapped.push(b);
  }
  return { map, unmapped };
}

/** All klines of one symbol/interval over a window, paginated. */
async function klines(symbol, interval, fromMs, toMs) {
  const out = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard++ < 40) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    let rows;
    try {
      rows = await getJson(url);
    } catch (e) {
      console.error(`  [binance] ${symbol} ${interval}: ${e.message}`);
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      // [openTime, open, high, low, close, volume, closeTime, ...]
      out.push({ t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), ct: Number(r[6]) });
    }
    const last = Number(rows[rows.length - 1][0]);
    const next = last + 1;
    if (next <= cursor) break;
    cursor = next;
    await sleep(60);
  }
  const m = new Map();
  for (const b of out) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/**
 * The tape at one instant, from candles of the live path's granularity.
 *
 * ── THE GRANULARITY, AND WHY IT IS 60 MINUTES ──
 *
 * The live path's tape is `jw3 decide`'s market state, and it reads
 * `DECIDE_KLINES = 60` klines of `DECIDE_GRANULARITY_MIN = 60` — that
 * is SIXTY 60-MINUTE candles, a 60-HOUR window. `fadeMetrics` then
 * takes the last 24 of them, so the tape's window is 24 HOURS of
 * 60-minute bars.
 *
 * (The `futuresFade` helper in `src/kucoin.ts` uses 1-minute candles,
 * but the COLLECTOR and the LIVE PATH both go through `jw3 decide`, so
 * the granularity that matters is 60 minutes. Getting this wrong makes
 * the reconstruction measure a different state — and it did: a 1-minute
 * reconstruction showed a 5.33pp median difference in the tape's own
 * change against KuCoin, which is the size of the whole effect.)
 *
 * So the independent venue reads 60-minute klines and takes the last
 * 24, exactly as the live path does. The FORMING bar is included,
 * because the live path's query ends at `now` and the feed's last bar
 * is the one in progress.
 */
function tapeAt(bars, ts) {
  const win = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.t > ts) continue;
    win.push(b);
    if (win.length >= 24) break;
  }
  win.reverse();
  if (win.length < 24) return null;
  const closes = win.map((b) => b.c);
  const vols = win.map((b) => b.v);
  const highs = win.map((b) => b.h);
  const lows = win.map((b) => b.l);
  const m = fadeMetrics(closes, vols, highs, lows);
  if (!m) return null;
  return { ...m, last: closes[closes.length - 1] };
}

async function main() {
  const bases = JSON.parse(readFileSync(UNIVERSE, "utf8"));
  const { map, unmapped } = await buildSymbolMap(bases);
  console.log(`[binance] ${Object.keys(map).length} of ${bases.length} symbols map to Binance USDⓈ-M perps`);
  if (unmapped.length) console.log(`[binance] not on Binance USDⓈ-M: ${unmapped.join(", ")}`);

  const now = Date.now();
  const from = now - DAYS * 24 * 3600_000;
  // The ticket simulation needs 4 hours of FORWARD bars past the last
  // observation, so the 15-minute bars run past the observation window.
  const barsTo = now + 4 * 3600_000;

  const observations = [];
  const bars15 = {};
  let n = 0;

  for (const [base, sym] of Object.entries(map)) {
    // The tape's candles: the live path's 60-minute granularity, with
    // enough history that the FIRST observation still has its full
    // 24-bar window.
    const one = await klines(sym, "1h", from - 72 * 3600_000, now);
    const fifteen = await klines(sym, "15m", from, barsTo);
    if (!one.length || !fifteen.length) {
      console.log(`[binance] ${sym}: no klines (1h=${one.length} 15m=${fifteen.length})`);
      continue;
    }
    bars15[`${base}/USDT`] = fifteen;

    // The 5-minute grid, aligned to the epoch like the collector's
    // buckets, over the window the tape history covers.
    const tapeFrom = Math.max(from, one[0].t + 24 * 3600_000);
    const start = Math.ceil(tapeFrom / 300_000) * 300_000;
    for (let ts = start; ts <= now; ts += 300_000) {
      const t = tapeAt(one, ts);
      if (!t) continue;
      const side = tapeSideOf({ offHighPct: t.offHighPct, offLowPct: t.offLowPct, vratio: t.vratio });
      observations.push({
        ts, pair: `${base}/USDT`, binance: sym,
        tapeChg: t.chg, tapeVratio: t.vratio, tapeVslope: t.vslope,
        tapeOffHighPct: t.offHighPct, tapeOffLowPct: t.offLowPct,
        tapeAtrPct: t.atrPct, tapeSide: side,
        price: t.last,
      });
      n++;
    }
    console.log(`[binance] ${sym}: ${one.length} 1h bars, ${fifteen.length} 15m bars`);
  }

  mkdirSync(join(homedir(), ".hermes/cache/scratch"), { recursive: true });
  // The observations are written as NDJSON: a JSON array of 150k objects
  // overflows the serializer's stack. The bars are written as one JSON
  // object keyed by pair, which is small enough.
  writeFileSync(OUT, observations.map((o) => JSON.stringify(o)).join("\n"));
  writeFileSync(BARS_OUT, JSON.stringify(bars15));
  const ts = observations.map((o) => o.ts);
  console.log(`\n[binance] ${observations.length} observations over ${new Set(ts.map((t) => Math.floor(t / 300_000))).size} five-minute clusters`);
  if (ts.length) {
    // minOf(ts) with 150k arguments overflows the call stack, so
    // the min/max are computed by a loop.
    let lo = ts[0];
    let hi = ts[0];
    for (const t of ts) { if (t < lo) lo = t; if (t > hi) hi = t; }
    console.log(`[binance] span ${new Date(lo).toISOString()} -> ${new Date(hi).toISOString()}`);
    const up = observations.filter((o) => o.tapeChg > 0).length;
    const dn = observations.filter((o) => o.tapeChg < 0).length;
    console.log(`[binance] the tape's own regime: up=${up} down=${dn} flat=${observations.length - up - dn}  (${((up / observations.length) * 100).toFixed(1)}% up)`);
  }
  console.log(`[binance] wrote ${OUT} and ${BARS_OUT}`);
}

main().catch((e) => {
  console.error(`[binance] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
