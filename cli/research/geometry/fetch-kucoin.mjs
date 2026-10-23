#!/usr/bin/env node
/**
 * EXTENDED VENUE-NATIVE HISTORY — KuCoin FUTURES public klines.
 *
 * WHY KuCoin and not Binance for the primary: the account trades KuCoin,
 * the fee schedule (0.06% taker / 0.02% maker per leg) is KuCoin's, and
 * the ticket's mark is a KuCoin mark. Binance is used as the independent
 * cross-check (fetched separately).
 *
 * THE BUDGET: this hits ONLY the public kline endpoint. It never
 * authenticates and never reads the account. But the live machine shares
 * this host's egress and its STOP-ARMING path is on the same 60-call/min
 * budget, so the pacing here is 3000ms (~20 calls/min), well under both
 * the machine's ceiling and KuCoin's user-level limit (which the repo has
 * already hit at 1300ms).
 *
 * USAGE: node fetch-kucoin.mjs --days 45
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const OUT_DIR = join(SCRATCH, "geo2");
const FUT = "https://api-futures.kucoin.com";
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DAYS = Number(flag("days", 45));
const PACE_MS = 3000;
const RETRIES = 4;
const BARS_PER_PAGE = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function futJson(url) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const j = await r.json();
  if (j && j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j;
}

const rows = readFileSync(join(SCRATCH, "confluence.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pairs = [...new Set(rows.map((r) => r.pair))].sort();
const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 3600_000;

// interval -> {minutes, outName}
const JOBS = [[60, "geo-kc-1h.json"], [15, "geo-kc-15m.json"]];

for (const [gran, outName] of JOBS) {
  const pageMs = BARS_PER_PAGE * gran * 60_000;
  const out = join(OUT_DIR, outName);
  const cache = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  for (const pair of pairs) {
    const base = pair.split("/")[0];
    const b = base === "BTC" ? "XBT" : base;
    const sym = `${b}USDTM`;
    const merged = new Map();
    for (const x of cache[pair] ?? []) merged.set(x.t, x);
    if (merged.size && Math.min(...merged.keys()) <= fromMs + gran * 60_000
        && Math.max(...merged.keys()) >= toMs - gran * 60_000) {
      console.log(`[kc] ${outName} ${pair}: cached (${merged.size})`);
      cache[pair] = [...merged.values()].sort((a, b) => a.t - b.t);
      continue;
    }
    let cursor = toMs, guard = 0, attempt = 0, fail = 0;
    while (cursor > fromMs && guard++ < 60) {
      const hi = Math.min(cursor, toMs);
      const lo = Math.max(fromMs, hi - pageMs);
      if (hi - lo < gran * 60_000) break;
      let d;
      try {
        const j = await futJson(`${FUT}/api/v1/kline/query?symbol=${sym}&granularity=${gran}&from=${lo}&to=${hi}`);
        d = Array.isArray(j.data) ? j.data : [];
      } catch (e) {
        if (/429000|Too many requests/i.test(e.message) && attempt < RETRIES) {
          attempt++; const backoff = 8000 * attempt;
          console.error(`[kc] 429 on ${sym} (attempt ${attempt}), backoff ${backoff}ms`);
          await sleep(backoff); continue;
        }
        console.error(`[kc] FETCH FAILED ${sym} gran=${gran}: ${e.message}`);
        fail = 1; break;
      }
      attempt = 0;
      if (!d.length) break;
      for (const row of d) merged.set(Number(row[0]), { t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
      cursor = lo - 1;
      await sleep(PACE_MS);
    }
    const arr = [...merged.values()].sort((a, b) => a.t - b.t);
    cache[pair] = arr;
    writeFileSync(out, JSON.stringify(cache));
    console.log(`[kc] ${outName} ${pair}: ${arr.length} bars ${arr[0] ? new Date(arr[0].t).toISOString() : "-"} -> ${arr.length ? new Date(arr[arr.length-1].t).toISOString() : "-"}${fail ? "  [INCOMPLETE]" : ""}`);
  }
}
console.log("[kc] done");
