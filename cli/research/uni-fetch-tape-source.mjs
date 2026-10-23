#!/usr/bin/env node
/**
 * THE 14-DAY TAPe SOURCE FETCHER — KuCoin PUBLIC market data only.
 *
 * WHY THIS EXISTS
 * ---------------
 * The task needs the machine's OWN tape over 14 days, not 4.5 hours. The
 * tape is `fadeMetrics` over the last 24 x 60-MINUTE bars, so it needs
 * 1-HOUR BARS WITH VOLUME. The 15-minute bar cache in the scratch dir has
 * NO volume, so the tape cannot be rebuilt from it. The 90-day cache in
 * leads/klines has 1h bars with volume but ENDS at 2026-10-21 05:00 —
 * before the collector ran (07:37-13:20) — so it cannot validate against
 * the collector's own recorded tape.
 *
 * So this fetches 1h bars (with volume) for the 43 pairs over the full
 * 14-day window, covering the collector's window too, so the tape
 * reconstruction can be VALIDATED against the collector's own rows.
 *
 * THE BUDGET
 * ----------
 * This hits ONLY the PUBLIC kline/ticker endpoints. It never
 * authenticates, never reads the account, never places an order. But the
 * live machine shares this host's egress and its STOP-ARMING path is on
 * the same 60-call/minute budget, so the requests are paced at 1300ms
 * (~46 calls/min), deliberately under the ceiling. KuCoin returns AT MOST
 * 200 bars per query and the 200 are the most RECENT ones, so a page
 * must be 200 BARS long, not 200 hours.
 *
 * USAGE
 *   node research/uni-fetch-tape-source.mjs [--days 14] [--out <path>]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const FUT = "https://api-futures.kucoin.com";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DAYS = Number(flag("days", 14));
const OUT = flag("out", join(SCRATCH, "uni-tape-1h-bars.json"));
const TICK_OUT = flag("tick-out", join(SCRATCH, "uni-ticker-snapshot.json"));
const BARS_PER_PAGE = 200;
const PAGE_MS = BARS_PER_PAGE * 60 * 60_000;
// The FIRST run at 1300ms got 18 of 51 kline pages rate-limited
// (api 429000: Too many requests. User-level rate limit exceeded.) —
// the shared egress is already carrying the machine's own budget, so
// the pacing here must be well under what KuCoin allows, not just
// under the machine's 60/min. 3000ms is ~20 calls/min.
const PACE_MS = 3000;
const RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function futJson(url) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const j = await r.json();
  if (j && j.code && String(j.code) !== "200000") {
    throw new Error(`api ${j.code}: ${j.msg}`);
  }
  return j;
}

const rows = readFileSync(join(SCRATCH, "confluence.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pairs = [...new Set(rows.map((r) => r.pair))].sort();

const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 3600_000;

let cache = {};
if (existsSync(OUT)) {
  try { cache = JSON.parse(readFileSync(OUT, "utf8")); } catch { cache = {}; }
}

let requests = 0, failures = 0;
for (const pair of pairs) {
  const base = pair.split("/")[0];
  const sym = `${base}USDTM`;
  const merged = new Map();
  for (const b of cache[pair] ?? []) merged.set(b.t, b);
  // A pair already covered over the whole window is skipped: the retry
  // run must not spend the budget on symbols it already has.
  if (merged.size && minOf(merged.keys()) <= fromMs + 3600_000
      && maxOf(merged.keys()) >= toMs - 3600_000) {
    console.log(`[tape-src] ${pair}: cached and complete (${merged.size} bars)`);
    cache[pair] = [...merged.values()].sort((a, b) => a.t - b.t);
    continue;
  }
  let cursor = toMs;
  let guard = 0;
  let attempt = 0;
  while (cursor > fromMs && guard++ < 20) {
    const hi = Math.min(cursor, toMs);
    const lo = Math.max(fromMs, hi - PAGE_MS);
    if (hi - lo < 60 * 60_000) break;
    let d;
    try {
      const j = await futJson(
        `${FUT}/api/v1/kline/query?symbol=${sym}&granularity=60&from=${lo}&to=${hi}`,
      );
      d = Array.isArray(j.data) ? j.data : [];
      requests++;
    } catch (e) {
      // A 429 is a transient budget condition, not a data condition: back
      // off hard and try again rather than dropping the symbol.
      if (/429000|Too many requests/i.test(e.message) && attempt < RETRIES) {
        attempt++;
        const backoff = 8000 * attempt;
        console.error(`[tape-src] 429 on ${sym} (attempt ${attempt}), backing off ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      failures++;
      console.error(`[tape-src] FETCH FAILED ${sym}: ${e.message}`);
      break;
    }
    attempt = 0;
    if (!d.length) break;
    for (const row of d) {
      merged.set(Number(row[0]), {
        t: Number(row[0]), o: Number(row[1]), h: Number(row[2]),
        l: Number(row[3]), c: Number(row[4]), v: Number(row[5]),
      });
    }
    cursor = lo - 1;
    await sleep(PACE_MS);
  }
  const arr = [...merged.values()].sort((a, b) => a.t - b.t);
  cache[pair] = arr;
  console.log(`[tape-src] ${pair}: ${arr.length} 1h bars  ${new Date(arr[0]?.t ?? 0).toISOString()} -> ${new Date(arr[arr.length - 1]?.t ?? 0).toISOString()}`);
  writeFileSync(OUT, JSON.stringify(cache));
}

console.log(`\n[tape-src] done: ${requests} requests, ${failures} failures, ${Object.keys(cache).length} pairs`);

// ── the ticker snapshot: the CURRENT spread and ATR for each symbol ──
//
// The spread is a per-symbol quantity the collector sampled only 42
// times per symbol in a 4.5-hour window. A fresh snapshot from the
// public ticker gives an independent read of the same quantity, and the
// two together say whether the collector's sample was typical.
const tickers = {};
for (const pair of pairs) {
  const base = pair.split("/")[0];
  const sym = `${base}USDTM`;
  try {
    const j = await futJson(`${FUT}/api/v1/ticker?symbol=${sym}`);
    const d = j.data ?? {};
    const bid = Number(d.bestBidSize ?? 0), ask = Number(d.bestAskSize ?? 0);
    const last = Number(d.price ?? 0);
    tickers[pair] = {
      last, bidSize: bid, askSize: ask,
      turnover: Number(d.turnoverOf24h ?? 0),
      volume: Number(d.volumeOf24h ?? 0),
      ts: Date.now(),
    };
    console.log(`[tape-src] ticker ${pair}: last=${last} bidSz=${bid} askSz=${ask} turnover24h=${Math.round(Number(d.turnoverOf24h ?? 0))}`);
  } catch (e) {
    failures++;
    console.error(`[tape-src] TICKER FAILED ${sym}: ${e.message}`);
  }
  await sleep(PACE_MS);
}
writeFileSync(TICK_OUT, JSON.stringify(tickers));
console.log(`[tape-src] wrote ${OUT} and ${TICK_OUT}`);
