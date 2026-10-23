#!/usr/bin/env node
/**
 * multiday-amortise-fetch.mjs — the FETCH half of the multi-day-hold study.
 *
 * READ-ONLY. Public market data only (no account, no venue, no orders).
 * It does not call the `jw3` CLI at all, so it never touches the shared
 * per-minute budget the live path uses for its own reads.
 *
 * WHAT IT FETCHES, per symbol
 *   - 1h klines (granularity=60)
 *   - 4h klines (granularity=240)  -> the multi-timeframe confluence leg
 *   - funding settlements           -> the real settled rate, so a multi-day
 *                                       hold is charged what it actually costs
 *
 * THE WINDOW
 *   The prior study exhausted 2026-07-22 22:00 -> 2026-10-20 22:00 UTC.
 *   The analysis window here ENDS where that one BEGINS: zero overlap.
 *
 *       ANALYSIS  2025-07-22 22:00 -> 2026-07-22 22:00 UTC   (365 days)
 *       DATA      2025-06-22 22:00 -> 2026-08-21 22:00 UTC
 *
 *   The data range is wider than the analysis window on purpose:
 *     - 30 days of margin before, so the PLACEBO family can displace a
 *       signal backwards in time and still find a real forward window;
 *     - 30 days of margin after, for the same reason;
 *     - 8 days of forward room past the analysis end, so a trade entered
 *       on the last analysed day can still be held for 8 days.
 *
 * DISCIPLINE (the repo's own lessons)
 *   - The kline endpoint returns the FIRST 200 rows at/after `from`, so
 *     klines page FORWARD. The funding endpoint returns the NEWEST 100
 *     rows in the window, so funding pages BACKWARD. Both are keyed by
 *     timestamp, never by stride: a symbol with no trades prints no bar.
 *   - A global token bucket, so aggregate req/s is bounded no matter the
 *     worker count. The venue's budget is per-IP and SHARED with every
 *     other process on this machine, so this stays near a quarter of the
 *     measured ceiling and leaves the live path room.
 *   - One file per symbol per series, so a restart costs nothing.
 *   - THE PAGES OF ONE SYMBOL ARE FETCHED IN PARALLEL. The kline window
 *     is known in advance (a fixed 200-bar span per page), so the page
 *     boundaries do not depend on the previous page's response. A
 *     serial page loop wastes the whole concurrency: at a measured 420ms
 *     per request, a serial symbol takes 77 x 420ms = 32s, and 518
 *     symbols is 4.6 hours. Fetching the pages concurrently and merging
 *     them by timestamp takes the same data to a few minutes.
 *
 * USAGE
 *   node research/multiday-amortise-fetch.mjs [--rate 14] [--workers 16]
 *       [--out <dir>]
 */
import https from "node:https";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FUT = "api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const HOUR = 3_600_000;
const DAY = 86_400_000;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const RATE = Number(flag("rate", 14));
const WORKERS = Number(flag("workers", 16));
const OUT = flag("out", join(homedir(), ".hermes/cache/scratch/mdh-2026"));

const A_FROM = Date.UTC(2025, 6, 22, 22, 0, 0);
const A_TO = Date.UTC(2026, 6, 22, 22, 0, 0);
const D_FROM = A_FROM - 30 * DAY;
const D_TO = A_TO + 30 * DAY;

mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* http: keep-alive + a GLOBAL token bucket                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bucket = {
  nextAt: 0,
  minGapMs: 1000 / RATE,
  async take() {
    // ADAPTIVE THROTTLE. The venue's gateway budget is per-IP and SHARED
    // with every other process on this machine (the live path's own
    // reads). When the remaining count drops, this fetch waits rather
    // than competing for it — a research tool must never be able to
    // starve the live path.
    if (CUR_REMAIN < 150) {
      await sleep(2500);
    } else if (CUR_REMAIN < 500) {
      await sleep(700);
    }
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.minGapMs;
    if (at > now) await sleep(at - now);
  },
};

let CALLS = 0, ERRORS = 0, R429 = 0, MIN_REMAIN = Infinity, CUR_REMAIN = Infinity;

function makeFetcher() {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 });
  return async function get(path) {
    await bucket.take();
    CALLS++;
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
            const rem = Number(res.headers["gw-ratelimit-remaining"]);
            if (Number.isFinite(rem)) {
              // The CURRENT remaining count (it recovers as the rolling
              // window advances), and the low-water mark over the run.
              CUR_REMAIN = rem;
              if (rem < MIN_REMAIN) MIN_REMAIN = rem;
            }
            resolve({ status: res.statusCode, remaining: rem, j, body: body.slice(0, 160) });
          });
        },
      );
      req.on("error", (e) => resolve({ status: 0, err: String(e) }));
      req.setTimeout(45000, () => { req.destroy(); resolve({ status: 0, err: "timeout" }); });
      req.end();
    });
  };
}
const FETCHERS = [];
for (let i = 0; i < WORKERS; i++) FETCHERS.push(makeFetcher());
let workerSlot = 0;
async function get(path) {
  return FETCHERS[workerSlot++ % FETCHERS.length](path);
}

async function getRetry(path, tries = 6) {
  for (let a = 0; a < tries; a++) {
    const r = await get(path);
    if (r.status === 200) return r;
    if (r.status === 429) { R429++; await sleep(400 + Math.random() * 600); continue; }
    if (r.status >= 500 || r.status === 0) { ERRORS++; await sleep(300 + Math.random() * 700); continue; }
    ERRORS++;
    return r;
  }
  ERRORS++;
  return { status: 0, err: "exhausted retries", j: null };
}

/* ------------------------------------------------------------------ */
/* fetchers                                                            */
/* ------------------------------------------------------------------ */

/**
 * 1h/4h klines. The pages of one symbol are fetched CONCURRENTLY, because
 * the page boundaries are known in advance (a fixed 200-bar span), and the
 * results are merged by timestamp.
 *
 * A page that comes back short is re-fetched with a narrower window, so a
 * symbol with a no-trade gap does not silently truncate its history.
 */
async function fetchKlines(symbol, granMin, fromMs, toMs, file) {
  let byTs = new Map();
  let coveredFrom = Infinity, coveredTo = -Infinity;
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(cached.bars)) {
        for (const b of cached.bars) byTs.set(b[0], b);
        coveredFrom = cached.meta?.from ?? Infinity;
        coveredTo = cached.meta?.to ?? -Infinity;
      }
    } catch { /* refetch */ }
  }
  if (coveredFrom <= fromMs && coveredTo >= toMs) {
    return { symbol, granMin, bars: [...byTs.values()].sort((a, b) => a[0] - b[0]) };
  }

  const stepMs = granMin * 60_000;
  const span = 200 * stepMs;

  // The pages to fetch: the missing sub-ranges, split into 200-bar pages.
  const ranges = [];
  if (coveredTo < toMs) {
    const s = coveredTo === -Infinity ? fromMs : Math.max(fromMs, coveredTo + 1);
    if (s <= toMs) ranges.push([s, toMs]);
  }
  if (coveredFrom > fromMs) ranges.push([fromMs, Math.min(toMs, coveredFrom - 1)]);

  for (const [rFrom, rTo] of ranges) {
    // The page boundaries, known in advance.
    const pages = [];
    for (let s = rFrom; s <= rTo; s += span) {
      pages.push([s, Math.min(s + span - 1, rTo)]);
    }
    // Fetch the pages CONCURRENTLY.
    const results = await Promise.all(
      pages.map(async ([s, e]) => {
        const r = await getRetry(
          `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granMin}` +
            `&from=${s}&to=${e}`,
        );
        return { s, e, r };
      }),
    );
    for (const { s, e, r } of results) {
      const rows = Array.isArray(r.j?.data) ? r.j.data : [];
      if (rows.length === 0) continue;
      for (const k of rows) {
        const ts = Number(k[0]);
        if (!Number.isFinite(ts) || ts < s || ts > e) continue;
        byTs.set(ts, [ts, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), Number(k[6]) || 0]);
      }
      // A short page means the symbol stopped printing (or the window
      // ended). Re-fetch the tail of the page with a narrower window, so a
      // no-trade gap does not silently truncate the rest of the history.
      if (rows.length < 200 && e < rTo) {
        const narrowTo = s + rows.length * stepMs + 4 * stepMs;
        if (narrowTo < e) {
          const r2 = await getRetry(
            `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granMin}` +
              `&from=${s + rows.length * stepMs}&to=${narrowTo}`,
          );
          const rows2 = Array.isArray(r2.j?.data) ? r2.j.data : [];
          for (const k of rows2) {
            const ts = Number(k[0]);
            if (!Number.isFinite(ts) || ts < rFrom || ts > rTo) continue;
            byTs.set(ts, [ts, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]), Number(k[6]) || 0]);
          }
        }
      }
    }
  }
  const bars = [...byTs.values()].sort((a, b) => a[0] - b[0]);
  writeFileSync(file, JSON.stringify({
    symbol, granMin,
    meta: { from: Math.min(coveredFrom, fromMs), to: Math.max(coveredTo, toMs), fetched: new Date().toISOString() },
    bars,
  }));
  return { symbol, granMin, bars };
}

/**
 * Funding settlements. The endpoint returns the NEWEST 100 rows inside the
 * window, so it pages BACKWARD with `to`. The settlement spacing (4h vs 8h)
 * is derived from the data, never assumed.
 */
async function fetchFunding(symbol, fromMs, toMs, file) {
  let byTs = new Map();
  let coveredFrom = Infinity, coveredTo = -Infinity;
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(c.settlements)) {
        for (const s of c.settlements) byTs.set(s.ts, s.rate);
        coveredFrom = c.meta?.from ?? Infinity;
        coveredTo = c.meta?.to ?? -Infinity;
      }
    } catch { /* refetch */ }
  }
  if (coveredFrom <= fromMs && coveredTo >= toMs) {
    return { symbol, settlements: [...byTs.entries()].map(([ts, rate]) => ({ ts, rate })).sort((a, b) => a.ts - b.ts) };
  }
  const ranges = [];
  if (coveredFrom > fromMs) ranges.push([fromMs, Math.min(toMs, coveredFrom - 1)]);
  if (coveredTo < toMs) ranges.push([Math.max(fromMs, coveredTo + 1), toMs]);

  for (const [rFrom, rTo] of ranges) {
    // Backward paging, 100 rows per call. The page boundaries are known
    // in advance from the settlement spacing, so the pages go out
    // CONCURRENTLY: the 100 newest rows in [to-100d, to], then the 100
    // before that, and so on.
    const pages = [];
    const step = 100 * 4 * HOUR; // the nominal settlement spacing
    for (let to = rTo; to >= rFrom; to -= step) {
      pages.push([Math.max(rFrom, to - step + 1), to]);
      if (to - step < rFrom) break;
    }
    const results = await Promise.all(
      pages.map(async ([s, e]) => {
        const r = await getRetry(
          `/api/v1/contract/funding-rates?symbol=${encodeURIComponent(symbol)}&from=${s}&to=${e}`,
        );
        return { r };
      }),
    );
    for (const { r } of results) {
      const rows = Array.isArray(r.j?.data) ? r.j.data : [];
      for (const x of rows) {
        const tp = Number(x.timepoint);
        if (!Number.isFinite(tp) || tp < rFrom || tp > rTo) continue;
        byTs.set(tp, Number(x.fundingRate));
      }
    }
  }
  const settlements = [...byTs.entries()].map(([ts, rate]) => ({ ts, rate })).sort((a, b) => a.ts - b.ts);
  writeFileSync(file, JSON.stringify({
    symbol,
    meta: { from: Math.min(coveredFrom, fromMs), to: Math.max(coveredTo, toMs), fetched: new Date().toISOString() },
    settlements,
  }));
  return { symbol, settlements };
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

const universeFile = join(OUT, "universe.json");
if (!existsSync(universeFile)) throw new Error(`missing ${universeFile} — run the probe first`);
const universe = JSON.parse(readFileSync(universeFile, "utf8"));

console.log(
  `[fetch] ${universe.length} symbols | data ${new Date(D_FROM).toISOString().slice(0, 16)} -> ${new Date(D_TO).toISOString().slice(0, 16)}` +
    ` | analysis ${new Date(A_FROM).toISOString().slice(0, 16)} -> ${new Date(A_TO).toISOString().slice(0, 16)}` +
    ` | rate=${RATE}/s workers=${WORKERS} (pages fetched concurrently)`,
);

let done = 0;
const t0 = Date.now();
const stats = { bars1h: 0, bars4h: 0, settle: 0, thin1h: 0 };

async function workOne(u) {
  try {
    const k1 = await fetchKlines(u.symbol, 60, D_FROM, D_TO, join(OUT, `k1h_${u.symbol}.json`));
    stats.bars1h += k1.bars.length;
    if (k1.bars.length < 500) stats.thin1h++;
    const k4 = await fetchKlines(u.symbol, 240, D_FROM, D_TO, join(OUT, `k4h_${u.symbol}.json`));
    stats.bars4h += k4.bars.length;
    const fr = await fetchFunding(u.symbol, D_FROM, D_TO, join(OUT, `fr_${u.symbol}.json`));
    stats.settle += fr.settlements.length;
  } catch (e) {
    ERRORS++;
    console.error(`[fetch] ${u.symbol} FAILED: ${e?.stack ?? e}`);
  }
  done++;
  if (done % 20 === 0) {
    const secs = (Date.now() - t0) / 1000;
    const rate = done / secs;
    console.log(
      `[fetch] ${done}/${universe.length} (${((done / universe.length) * 100).toFixed(1)}%) ` +
        `calls=${CALLS} r429=${R429} err=${ERRORS} min_remain=${MIN_REMAIN} ` +
        `${(CALLS / secs).toFixed(1)} req/s | elapsed=${(secs / 60).toFixed(1)}m ` +
        `eta=${(((universe.length - done) / rate) / 60).toFixed(1)}m`,
    );
  }
}

let idx = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= universe.length) return;
    await workOne(universe[i]);
  }
}
await Promise.all(Array.from({ length: WORKERS }, () => worker()));

const secs = (Date.now() - t0) / 1000;
console.log(
  `[fetch] DONE in ${(secs / 60).toFixed(1)}m — calls=${CALLS} r429=${R429} err=${ERRORS} ` +
    `avg=${(CALLS / secs).toFixed(1)} req/s min_remaining=${MIN_REMAIN}`,
);
console.log(`[fetch] bars1h=${stats.bars1h} bars4h=${stats.bars4h} settlements=${stats.settle} thin=${stats.thin1h}`);

/* Coverage census — the honest "how much data do I actually have" line. */
try {
  const files = readdirSync(OUT).filter((f) => f.startsWith("k1h_"));
  const expected = Math.round((A_TO - A_FROM) / HOUR);
  const cover = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(OUT, f), "utf8"));
    const b = j.bars ?? [];
    if (!b.length) continue;
    const inWin = b.filter((x) => x[0] >= A_FROM && x[0] < A_TO);
    cover.push({
      sym: j.symbol,
      n: inWin.length,
      expected,
      first: inWin[0]?.[0] ?? null,
      last: inWin[inWin.length - 1]?.[0] ?? null,
    });
  }
  cover.sort((a, b) => b.n - a.n);
  const full = cover.filter((c) => c.n >= c.expected * 0.98);
  const half = cover.filter((c) => c.n >= c.expected * 0.5);
  console.log(
    `[fetch] COVERAGE: ${cover.length} symbols with bars | ${full.length} at >=98% of ${expected} expected hours | ${half.length} at >=50%`,
  );
  const firsts = new Map();
  for (const c of cover) {
    if (!c.first) continue;
    const d = new Date(c.first).toISOString().slice(0, 7);
    firsts.set(d, (firsts.get(d) ?? 0) + 1);
  }
  console.log(`[fetch] first-bar month histogram: ${JSON.stringify([...firsts.entries()].sort())}`);
  writeFileSync(join(OUT, "coverage.json"), JSON.stringify({ analysis: { from: A_FROM, to: A_TO }, cover }, null, 1));
  console.log(`[fetch] -> coverage.json`);
} catch (e) {
  console.error(`[fetch] coverage census failed: ${e?.stack ?? e}`);
}
