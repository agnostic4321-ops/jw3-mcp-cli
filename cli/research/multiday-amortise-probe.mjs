#!/usr/bin/env node
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";
/**
 * PROBE — read-only reconnaissance for the multi-day-hold study.
 *
 * Answers, with real numbers, the three questions that decide the design:
 *   1. How deep does 1h kline history go for a 2026-04..2026-07 window?
 *   2. What are the live rate-limit headers, and what throughput is safe?
 *   3. How many crypto USDTM perps existed in the FRESH window (and which
 *      of them have enough history)?
 *
 * No account or venue endpoints are touched. Public market data only.
 */
const FUT = "https://api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const DAY = 86_400_000;
const HOUR = 3_600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(FUT + path, { headers: UA });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* body below */ }
  return {
    status: res.status,
    headers: {
      limit: res.headers.get("gw-ratelimit-limit"),
      remaining: res.headers.get("gw-ratelimit-remaining"),
      reset: res.headers.get("gw-ratelimit-reset"),
    },
    j,
    body: txt.slice(0, 200),
  };
}

function fmt(ms) { return new Date(ms).toISOString().replace("T", " ").slice(0, 16); }

const NOW = Date.now();
// The exhausted window was 2026-07-22 22:00 -> 2026-10-20 22:00 UTC.
// The FRESH window is the 90 days immediately BEFORE it: no overlap.
const FRESH_TO = Date.UTC(2026, 6, 22, 22, 0, 0); // 2026-07-22 22:00 UTC
const FRESH_FROM = FRESH_TO - 90 * DAY; // 2026-04-23 22:00 UTC

console.log(`[probe] now=${fmt(NOW)}  fresh window ${fmt(FRESH_FROM)} -> ${fmt(FRESH_TO)}`);

console.log("\n[probe] 1. rate-limit headers on a single call");
{
  const r = await getJson("/api/v1/contracts/active");
  console.log(`  status=${r.status} headers=${JSON.stringify(r.headers)}`);
  const body = r.j?.data ?? [];
  console.log(`  contracts/active -> ${body.length} rows`);
  const crypto = body.filter(
    (c) =>
      c.assetClass === "CRYPTO" &&
      c.quoteCurrency === "USDT" &&
      String(c.symbol).endsWith("USDTM") &&
      c.status === "Open" &&
      !c.isInverse,
  );
  console.log(`  crypto USDTM linear perps: ${crypto.length}`);

  // Which of them were listed before the fresh window opened?
  const listedBefore = crypto.filter((c) => Number(c.firstOpenDate) < FRESH_FROM);
  const listedDuring = crypto.filter(
    (c) => Number(c.firstOpenDate) >= FRESH_FROM && Number(c.firstOpenDate) < FRESH_TO,
  );
  const listedAfter = crypto.filter((c) => Number(c.firstOpenDate) >= FRESH_TO);
  console.log(`  listed BEFORE the fresh window: ${listedBefore.length}`);
  console.log(`  listed DURING the fresh window: ${listedDuring.length}`);
  console.log(`  listed AFTER  the fresh window: ${listedAfter.length}`);

  const fees = crypto.map((c) => Number(c.takerFeeRate)).filter(Number.isFinite);
  const tmin = minOf(fees), tmax = maxOf(fees);
  console.log(`  takerFeeRate across universe: min=${tmin} max=${tmax} (n=${fees.length})`);
  const mk = crypto.map((c) => Number(c.makerFeeRate)).filter(Number.isFinite);
  console.log(`  makerFeeRate across universe: min=${minOf(mk)} max=${maxOf(mk)}`);

  // Persist the universe for the fetcher (so the fetch uses a FIXED list).
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const out = crypto.map((c) => ({
    symbol: c.symbol,
    multiplier: Number(c.multiplier) || 1,
    makerFeeRate: Number(c.makerFeeRate),
    takerFeeRate: Number(c.takerFeeRate),
    firstOpenDate: Number(c.firstOpenDate) || 0,
    turnover24h: Number(c.turnoverOf24h) || 0,
  }));
  mkdirSync(`${process.env.HOME}/.hermes/cache/scratch/mdh-2026`, { recursive: true });
  writeFileSync(
    `${process.env.HOME}/.hermes/cache/scratch/mdh-2026/universe.json`,
    JSON.stringify(out),
  );
  console.log(`  -> wrote universe.json (${out.length} symbols)`);
}

console.log("\n[probe] 2. kline history depth on a probe symbol");
for (const sym of ["XBTUSDTM", "ETHUSDTM", "SOLUSDTM", "DOGEUSDTM"]) {
  // Ask for a window that ends well before the fresh window and see how far
  // back the venue will actually page.
  let cursor = FRESH_FROM;
  let oldest = null;
  let calls = 0;
  const t0 = Date.now();
  while (calls < 4) {
    const pageTo = Math.min(cursor + 200 * HOUR, FRESH_FROM + 200 * HOUR);
    const r = await getJson(
      `/api/v1/kline/query?symbol=${sym}&granularity=60&from=${cursor}&to=${pageTo}`,
    );
    calls++;
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    if (rows.length === 0) { oldest = cursor; break; }
    oldest = Number(rows[0][0]);
    const last = Number(rows[rows.length - 1][0]);
    if (last <= cursor) break;
    cursor = last + 1;
    if (rows.length < 200) break;
  }
  const ms = Date.now() - t0;
  console.log(
    `  ${sym}: oldest returned ${fmt(oldest)} after ${calls} pages (${ms}ms) ` +
      `| delta_from_ask=${Math.round((FRESH_FROM - oldest) / DAY)}d`,
  );
}

console.log("\n[probe] 3. throughput test — 12 sequential pages, measuring achieved req/s");
{
  const t0 = Date.now();
  let ok = 0, err = 0, lastRemain = null, lastLimit = null;
  for (let i = 0; i < 12; i++) {
    const from = FRESH_FROM + i * 200 * HOUR;
    const to = from + 199 * HOUR;
    const r = await getJson(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${to}`,
    );
    if (r.status === 200) ok++; else { err++; console.log(`   err ${r.status} ${r.body}`); }
    lastRemain = r.headers.remaining ?? lastRemain;
    lastLimit = r.headers.limit ?? lastLimit;
    await sleep(0);
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`  ${ok} ok / ${err} err in ${secs.toFixed(1)}s = ${(ok / secs).toFixed(1)} req/s (no throttle)`);
  console.log(`  gw-ratelimit-remaining=${lastRemain} limit=${lastLimit}`);
}

console.log("\n[probe] 4. funding-rates depth (100 rows/call, pages backward)");
{
  let to = FRESH_TO;
  let oldest = null, calls = 0, n = 0;
  const t0 = Date.now();
  while (calls < 5) {
    const r = await getJson(
      `/api/v1/contract/funding-rates?symbol=ETHUSDTM&from=${FRESH_FROM}&to=${to}`,
    );
    calls++;
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    if (rows.length === 0) break;
    n += rows.length;
    const tp = rows.map((x) => Number(x.timepoint));
    oldest = minOf(tp);
    const o = minOf(tp);
    if (o <= FRESH_FROM) break;
    to = o - 1;
  }
  console.log(
    `  ETHUSDTM funding: ${n} settlements in ${calls} calls (${Date.now() - t0}ms), oldest ${fmt(oldest)}`,
  );
}

console.log("\n[probe] done");
