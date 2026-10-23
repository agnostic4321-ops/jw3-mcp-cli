#!/usr/bin/env node
/**
 * THE 15-MINUTE BAR FETCHER for the fee-floor study.
 *
 * WHY 15-MINUTE BARS AND NOT THE 90-DAY 1-HOUR CACHE
 *
 * The geometry study measured the 4-hour excursion on 15-minute bars
 * (+0.31% up, -0.56% down) and that is the number the ticket has to be
 * judged against. The local 90-day cache is 1-HOUR bars, where a single
 * bar's high/low spans a whole hour of range: measuring a 4-hour hold on
 * 1-hour bars over-estimates the excursion by a wide margin (it measures
 * 1.96% up, not 0.31%). So the excursion envelope AND the geometry
 * simulation must both run on 15-minute bars, on the SAME 43 pairs the
 * confluence collector samples, or the two numbers cannot be compared.
 *
 * THE BUDGET
 *
 * This hits ONLY the PUBLIC kline endpoint (api-futures.kucoin.com). It
 * never authenticates, never reads the account, never places an order.
 * But the live machine shares this host's egress, and its STOP-ARMING
 * path is on the same 60-call/minute budget — so the requests are paced
 * at 1100ms (≈54 calls/min), deliberately under the ceiling.
 *
 * KuCoin returns AT MOST 200 bars per query, and the 200 are the most
 * RECENT ones in the range. So a page must be 200 BARS long, not 200
 * hours: with 15-minute bars a 200-hour page silently returns a
 * 2-day-stale window. The page length here is 200 * 15 minutes.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const OUT = join(SCRATCH, "fee-floor-15m-bars.json");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");

const BAR_MIN = 15;
const PAGE_MS = 200 * BAR_MIN * 60_000;
const PACE_MS = 1100; // ≈54 calls/min — under the shared 60/min ceiling
const DAYS = Number(process.env.DAYS ?? 14);

const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pairs = [...new Set(rows.map((r) => r.pair))].sort();

const fromMs = Date.now() - DAYS * 24 * 3600_000;
const toMs = Date.now();

let cache = {};
if (existsSync(OUT)) {
  try {
    cache = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    cache = {};
  }
}

const fut = "https://api-futures.kucoin.com";
let totalRequests = 0;
let failures = 0;

for (const pair of pairs) {
  const base = pair.split("/")[0];
  const sym = `${base}USDTM`;
  const have = cache[pair] ?? [];
  const oldest = have.length ? have[0].t : Infinity;
  const newest = have.length ? have[have.length - 1].t : 0;

  // The window we need: [fromMs, toMs]. Skip if already covered.
  if (oldest <= fromMs && newest >= toMs - BAR_MIN * 60_000) {
    console.log(`[15m] ${pair}: cached and complete (${have.length} bars)`);
    continue;
  }

  const merged = new Map();
  for (const b of have) merged.set(b.t, b);

  // Page BACKWARDS from now to fromMs.
  let cursor = toMs;
  let guard = 0;
  while (cursor > fromMs && guard++ < 200) {
    const hi = Math.min(cursor, toMs);
    const lo = Math.max(fromMs, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    let d;
    try {
      const r = await fetch(
        `${fut}/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`,
        { headers: { "Content-Type": "application/json" } },
      );
      const j = await r.json();
      if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
      d = Array.isArray(j.data) ? j.data : [];
      totalRequests++;
    } catch (e) {
      failures++;
      console.error(`[15m] FETCH FAILED ${sym} [${lo},${hi}]: ${e.message}`);
      break;
    }
    if (!d.length) break;
    for (const row of d) {
      merged.set(Number(row[0]), {
        t: Number(row[0]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
      });
    }
    cursor = lo - 1;
    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  cache[pair] = [...merged.values()].sort((a, b) => a.t - b.t);
  const n = cache[pair].length;
  console.log(
    `[15m] ${pair}: ${n} bars, ${new Date(cache[pair][0].t).toISOString()} → ${new Date(cache[pair][n - 1].t).toISOString()}`,
  );
  writeFileSync(OUT, JSON.stringify(cache));
}

console.log(`\n[15m] done: ${totalRequests} requests, ${failures} failures, ${Object.keys(cache).length} pairs cached`);
console.log(`[15m] written to ${OUT}`);
