#!/usr/bin/env node
/**
 * PROBE 3 — throughput and far-past paging, for the 365-day fetch design.
 *
 * Decides:
 *   A) Does forward paging from a PAST `from` work? (the endpoint returns
 *      the first 200 rows at/after `from` — hunt-edge relies on this.)
 *   B) What sustained req/s can this IP actually carry WITHOUT 429?
 *   C) How long does the full fetch take at that rate?
 *
 * Public market data only. No account, no venue, no orders.
 */
import https from "node:https";

const FUT = "api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const HOUR = 3_600_000;
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A keep-alive agent per worker: a fresh TLS handshake per request is what
   makes a naive fetcher slow. */
function makeFetcher() {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  return function get(path) {
    return new Promise((resolve) => {
      const req = https.request(
        { host: FUT, path, method: "GET", agent, headers: UA },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            let j = null;
            try { j = JSON.parse(body); } catch {}
            resolve({
              status: res.statusCode,
              remaining: res.headers["gw-ratelimit-remaining"],
              limit: res.headers["gw-ratelimit-limit"],
              reset: res.headers["gw-ratelimit-reset"],
              j,
            });
          });
        },
      );
      req.on("error", (e) => resolve({ status: 0, err: String(e) }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, err: "timeout" }); });
      req.end();
    });
  };
}
const get = makeFetcher();
const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/* ── A) far-past forward paging ──────────────────────────────────────── */
console.log("[A] forward paging from a PAST `from` (365 days before 2026-07-22)");
{
  const target = Date.UTC(2026, 6, 22, 22, 0, 0);
  const start = target - 365 * DAY; // 2025-07-22 22:00 UTC
  let cursor = start;
  let n = 0;
  let first = null, last = null;
  const t0 = Date.now();
  for (let p = 0; p < 3; p++) {
    const to = cursor + 200 * HOUR;
    const r = await get(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${cursor}&to=${to}`,
    );
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    console.log(
      `  page ${p}: status=${r.status} rows=${rows.length} ` +
        `[${rows.length ? fmt(Number(rows[0][0])) : "-"} .. ${rows.length ? fmt(Number(rows[rows.length - 1][0])) : "-"}] ` +
        `remaining=${r.remaining}`,
    );
    if (!rows.length) break;
    if (first === null) first = Number(rows[0][0]);
    last = Number(rows[rows.length - 1][0]);
    n += rows.length;
    cursor = last + 1;
    if (rows.length < 200) break;
  }
  console.log(
    `  -> ${n} bars from ${fmt(first)} ; requested start ${fmt(start)} ` +
      `(delta ${Math.round((first - start) / HOUR)}h); ${Date.now() - t0}ms`,
  );
  console.log(`  contiguous? first>=start: ${first >= start - HOUR}`);
}

/* ── B) sustained throughput at a few concurrency levels ─────────────── */
console.log("\n[B] sustained throughput (each level: 24 requests, keep-alive)");
for (const conc of [4, 8, 12]) {
  const t0 = Date.now();
  let ok = 0, err429 = 0, other = 0, minRemain = Infinity;
  const reqs = [];
  for (let i = 0; i < 24; i++) {
    const from = Date.parse("2025-08-01T00:00:00Z") + i * 200 * HOUR;
    reqs.push(
      get(`/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${from + 199 * HOUR}`),
    );
    if (reqs.length >= conc) {
      const r = await reqs.shift();
      if (r.status === 200) { ok++; minRemain = Math.min(minRemain, Number(r.remaining)); }
      else if (r.status === 429) err429++;
      else other++;
    }
  }
  for (const r of await Promise.all(reqs)) {
    if (r.status === 200) { ok++; minRemain = Math.min(minRemain, Number(r.remaining)); }
    else if (r.status === 429) err429++;
    else other++;
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `  conc=${String(conc).padStart(2)}: ${ok} ok / ${err429} x429 / ${other} other ` +
      `in ${secs.toFixed(1)}s = ${(24 / secs).toFixed(1)} req/s  min_remaining=${minRemain}`,
  );
  await sleep(1500);
}

/* ── C) cost projection ───────────────────────────────────────────────── */
console.log("\n[C] cost projection for the full fetch");
{
  const symbols = 518;
  const days = 365;
  const barsPerSymbol = days * 24;
  const pagesPerSymbol = Math.ceil(barsPerSymbol / 200);
  const klineCalls = symbols * pagesPerSymbol;
  const fundPages = Math.ceil((days * 3) / 100); // ~3 settlements/day
  const fundingCalls = symbols * fundPages;
  console.log(`  1h klines: ${barsPerSymbol} bars/symbol = ${pagesPerSymbol} pages x ${symbols} = ${klineCalls} calls`);
  console.log(`  funding:   ${fundPages} pages x ${symbols} = ${fundingCalls} calls`);
  console.log(`  TOTAL      = ${klineCalls + fundingCalls} calls`);
  for (const rate of [2, 4, 6, 8, 10]) {
    console.log(`    at ${rate} req/s -> ${(((klineCalls + fundingCalls) / rate) / 60).toFixed(1)} min`);
  }
}
console.log("\n[probe3] done");
