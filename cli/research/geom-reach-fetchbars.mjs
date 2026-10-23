#!/usr/bin/env node
/**
 * THE REACHABLE-STOP STUDY — forward bar extension.
 *
 * ── WHAT THIS IS ──
 *
 * The reachable-stop sweep needs a 240-minute forward window after each
 * observation. The deep bar cache (fee-floor-15m-bars.json) ends at
 * 12:30 UTC, so every observation after 08:30 cannot be priced at the
 * ticket's real hold — which is exactly the sample the sweep needs.
 *
 * So this script extends the cache FORWARD, to "now", using ONLY the
 * PUBLIC kline endpoint. It never authenticates, never reads the
 * account, never places an order, and never touches the shared cache:
 * it writes its OWN copy (geom-reach-bars.json).
 *
 * ── THE BUDGET ──
 *
 * The live machine shares this host's egress with its STOP-ARMING path
 * on a 60-call/minute ceiling. This script paces at 1600ms
 * (≈37 calls/min), deliberately well under the ceiling.
 *
 * READ-ONLY ABSOLUTELY with respect to the venue and the account.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const BASE = join(SCRATCH, "fee-floor-15m-bars.json");
const OUT = join(SCRATCH, "geom-reach-bars.json");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const TRADE_LOOP = join(SCRATCH, "trade-loop.ndjson");

const BAR_MIN = 15;
const PACE_MS = 3000; // ≈20 calls/min — well under the shared 60/min ceiling
const fut = "https://api-futures.kucoin.com";

/**
 * The window to pull for a pair that has NO cache at all.
 *
 * The observations only exist from 2026-10-21 06:18 UTC, so anything
 * before 2026-10-20 is dead weight — and dead weight is API calls on a
 * budget shared with the live machine's STOP-ARMING path. 37 hours is
 * 150 bars, which fits in ONE page.
 */
const WINDOW_START = Date.parse("2026-10-20T00:00:00Z");

const rows = readFileSync(CONFLUENCE, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const pairs = [...new Set(rows.map((r) => r.pair))].sort();

// The live loop observes its OWN pairs, which are not the confluence
// collector's. They are a second, independent observation stream on
// disjoint symbols, so their bars are needed too.
let tlPairs = [];
try {
  const tl = readFileSync(TRADE_LOOP, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  tlPairs = [...new Set(tl.filter((r) => r.pair).map((r) => r.pair))].sort();
} catch {
  tlPairs = [];
}
const allPairs = [...new Set([...pairs, ...tlPairs])].sort();

const cache = existsSync(BASE) ? JSON.parse(readFileSync(BASE, "utf8")) : {};
const now = Date.now();
let requests = 0;
let failures = 0;

for (const pair of allPairs) {
  const base = pair.split("/")[0];
  const sym = `${base}USDTM`;
  const have = cache[pair] ?? [];
  const newest = have.length ? have[have.length - 1].t : 0;
  // A pair with NO cache needs its whole history; a pair with a cache
  // needs only the forward gap.
  const from = have.length ? newest - BAR_MIN * 60_000 : WINDOW_START;
  if (newest >= now - BAR_MIN * 60_000) {
    console.log(`[reach] ${pair}: already current (${new Date(newest).toISOString()})`);
    continue;
  }
  const merged = new Map();
  for (const b of have) merged.set(b.t, b);
  // KuCoin returns AT MOST 200 bars per query, and the 200 are the most
  // RECENT ones in the range — so a page must be 200 BARS long, not 200
  // hours, or the window silently comes back stale.
  const PAGE_MS = 200 * BAR_MIN * 60_000;
  let cursor = now;
  let guard = 0;
  let ok = true;
  while (cursor > from && guard++ < 200) {
    const hi = Math.min(cursor, now);
    const lo = Math.max(from, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    let d = null;
    // A 429 is the SHARED rate limit, so it is retried with a long
    // backoff rather than counted as a failure — and the whole fetch
    // for this pair is abandoned if the limit does not clear.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetch(
          `${fut}/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`,
          { headers: { "Content-Type": "application/json" } },
        );
        const j = await r.json();
        if (j.code && String(j.code) !== "200000") {
          if (String(j.code) === "429000") throw new Error("429 rate limited");
          throw new Error(`api ${j.code}: ${j.msg}`);
        }
        d = Array.isArray(j.data) ? j.data : [];
        requests++;
        break;
      } catch (e) {
        if (String(e.message).includes("429") && attempt < 5) {
          const wait = 15000 * (attempt + 1);
          console.error(`[reach] ${sym}: rate limited, backing off ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        failures++;
        console.error(`[reach] FETCH FAILED ${sym}: ${e.message}`);
        ok = false;
        break;
      }
    }
    if (!ok) break;
    if (d === null) break;
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
  const mergedArr = [...merged.values()].sort((a, b) => a.t - b.t);
  if (!mergedArr.length) {
    console.error(`[reach] ${pair}: NO BARS — skipping`);
    continue;
  }
  cache[pair] = mergedArr;
  const n = mergedArr.length;
  console.log(
    `[reach] ${pair}: ${n} bars, ${new Date(mergedArr[0].t).toISOString()} -> ${new Date(mergedArr[n - 1].t).toISOString()}`,
  );
}

writeFileSync(OUT, JSON.stringify(cache));
console.log(`\n[reach] done: ${requests} requests, ${failures} failures`);
console.log(`[reach] written to ${OUT}`);
