#!/usr/bin/env node
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";
/**
 * PROBE 5 — can I widen the per-call row cap? (the fetch's cost driver)
 *
 * The skill says klines cap at 200 rows and funding-rates at 100. If either
 * accepts a wider window, the fetch gets proportionally cheaper.
 */
const FUT = "https://api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path) {
  const res = await fetch(FUT + path, { headers: UA });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: res.status, j, body: txt.slice(0, 200),
           rem: res.headers.get("gw-ratelimit-remaining") };
}
const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

console.log("[klines] row cap vs requested window width (ETHUSDTM, 1h)");
for (const hours of [200, 400, 1000, 2000, 8760]) {
  const from = Date.parse("2025-08-01T00:00:00Z");
  const to = from + hours * HOUR;
  const r = await getJson(
    `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${to}`,
  );
  const rows = Array.isArray(r.j?.data) ? r.j.data : [];
  console.log(
    `  window=${String(hours).padStart(5)}h -> status=${r.status} rows=${String(rows.length).padStart(4)}` +
      (rows.length ? ` [${fmt(Number(rows[0][0]))} .. ${fmt(Number(rows[rows.length-1][0]))}]` : "") +
      (r.status !== 200 ? ` body=${r.body}` : ""),
  );
  await sleep(300);
}

console.log("\n[funding] row cap vs requested window width (ETHUSDTM)");
for (const days of [30, 100, 365]) {
  const from = Date.parse("2025-08-01T00:00:00Z");
  const to = from + days * 86400_000;
  const r = await getJson(
    `/api/v1/contract/funding-rates?symbol=ETHUSDTM&from=${from}&to=${to}`,
  );
  const rows = Array.isArray(r.j?.data) ? r.j.data : [];
  const tp = rows.map((x) => Number(x.timepoint));
  console.log(
    `  window=${String(days).padStart(4)}d -> status=${r.status} rows=${String(rows.length).padStart(4)}` +
      (tp.length ? ` [${fmt(minOf(tp))} .. ${fmt(maxOf(tp))}]` : "") +
      (r.status !== 200 ? ` body=${r.body}` : ""),
  );
  await sleep(300);
}

console.log("\n[granularity] is a 4h bar available directly? (for MTF confluence)");
for (const g of [60, 240, 1440]) {
  const from = Date.parse("2025-08-01T00:00:00Z");
  const to = from + 10 * 86400_000;
  const r = await getJson(
    `/api/v1/kline/query?symbol=ETHUSDTM&granularity=${g}&from=${from}&to=${to}`,
  );
  const rows = Array.isArray(r.j?.data) ? r.j.data : [];
  console.log(
    `  granularity=${String(g).padStart(4)}m -> status=${r.status} rows=${String(rows.length).padStart(4)}` +
      (rows.length ? ` first=${fmt(Number(rows[0][0]))} last=${fmt(Number(rows[rows.length-1][0]))}` : ""),
  );
  await sleep(300);
}
console.log("\n[probe5] done");
