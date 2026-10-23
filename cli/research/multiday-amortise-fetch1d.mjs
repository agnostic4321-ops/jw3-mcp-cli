#!/usr/bin/env node
/**
 * multiday-amortise-fetch1d.mjs — a SUPPLEMENTARY fetch for the 1d bars.
 *
 * The confluence arm needs a second, higher timeframe leg: the last
 * COMPLETED 1d bar's close must agree with the signal's side. The 1d
 * series is cheap (one row per day; the venue caps at 200 rows per call,
 * so the 425-day range is three calls per symbol).
 *
 * Same discipline as the main fetch: public data only, one file per
 * symbol, a global token bucket, keep-alive.
 */
import https from "node:https";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FUT = "api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const DAY = 86_400_000;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const RATE = Number(flag("rate", 10));
const WORKERS = Number(flag("workers", 8));
const OUT = flag("out", join(homedir(), ".hermes/cache/scratch/mdh-2026"));

const A_FROM = Date.UTC(2025, 6, 22, 22, 0, 0);
const A_TO = Date.UTC(2026, 6, 22, 22, 0, 0);
const D_FROM = A_FROM - 30 * DAY;
const D_TO = A_TO + 30 * DAY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = { nextAt: 0, minGapMs: 1000 / RATE, async take() {
  const now = Date.now(); const at = Math.max(now, this.nextAt);
  this.nextAt = at + this.minGapMs; if (at > now) await sleep(at - now);
} };
let CALLS = 0, ERRORS = 0, R429 = 0;

function makeFetcher() {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  return (path) => new Promise((resolve) => {
    bucket.take().then(() => {
      CALLS++;
      const req = https.request({ host: FUT, path, method: "GET", agent, headers: UA }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          let j = null; try { j = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, j });
        });
      });
      req.on("error", (e) => resolve({ status: 0, err: String(e) }));
      req.setTimeout(45000, () => { req.destroy(); resolve({ status: 0, err: "timeout" }); });
      req.end();
    });
  });
}
const get = makeFetcher();

async function getRetry(path, tries = 5) {
  for (let a = 0; a < tries; a++) {
    const r = await get(path);
    if (r.status === 200) return r;
    if (r.status === 429) { R429++; await sleep(400 + Math.random() * 600); continue; }
    if (r.status >= 500 || r.status === 0) { ERRORS++; await sleep(300 + Math.random() * 700); continue; }
    ERRORS++;
    return r;
  }
  ERRORS++;
  return { status: 0, j: null };
}

async function fetchDaily(symbol, file) {
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8"));
      if (c?.meta?.from <= D_FROM && c?.meta?.to >= D_TO) return c.bars?.length ?? 0;
    } catch { /* refetch */ }
  }
  const byTs = new Map();
  let cursor = D_FROM;
  let guard = 0;
  while (cursor <= D_TO && guard++ < 20) {
    const pageTo = Math.min(cursor + 200 * DAY - 1, D_TO);
    const r = await getRetry(
      `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=1440&from=${cursor}&to=${pageTo}`,
    );
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    if (rows.length === 0) { if (r.status !== 200) break; cursor = pageTo + 1; continue; }
    for (const k of rows) {
      const ts = Number(k[0]);
      if (!Number.isFinite(ts) || ts < D_FROM || ts > D_TO) continue;
      byTs.set(ts, [ts, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), Number(k[6]) || 0]);
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    if (rows.length < 200) cursor = Math.max(cursor, pageTo + 1);
  }
  const bars = [...byTs.values()].sort((a, b) => a[0] - b[0]);
  writeFileSync(file, JSON.stringify({
    symbol, granMin: 1440,
    meta: { from: D_FROM, to: D_TO, fetched: new Date().toISOString() },
    bars,
  }));
  return bars.length;
}

const universe = JSON.parse(readFileSync(join(OUT, "universe.json"), "utf8"));
console.log(`[fetch1d] ${universe.length} symbols | ${new Date(D_FROM).toISOString().slice(0, 10)} -> ${new Date(D_TO).toISOString().slice(0, 10)}`);

let done = 0, bars = 0;
const t0 = Date.now();
let idx = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= universe.length) return;
    try {
      bars += await fetchDaily(universe[i].symbol, join(OUT, `k1d_${universe[i].symbol}.json`));
    } catch (e) { ERRORS++; console.error(`[fetch1d] ${universe[i].symbol}: ${e?.message}`); }
    done++;
    if (done % 50 === 0) {
      const secs = (Date.now() - t0) / 1000;
      console.log(`[fetch1d] ${done}/${universe.length} calls=${CALLS} r429=${R429} err=${ERRORS} ${(CALLS / secs).toFixed(1)} req/s elapsed=${(secs / 60).toFixed(1)}m`);
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, () => worker()));
console.log(`[fetch1d] DONE in ${((Date.now() - t0) / 1000 / 60).toFixed(1)}m — calls=${CALLS} r429=${R429} err=${ERRORS} bars=${bars}`);
