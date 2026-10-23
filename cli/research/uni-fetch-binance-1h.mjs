#!/usr/bin/env node
/**
 * THE INDEPENDENT-VENUE 1-HOUR FETCHER — Binance USDⓈ-M.
 *
 * WHY
 * ---
 * KuCoin's public kline endpoint rate-limited the first pass
 * (api 429000: Too many requests. User-level rate limit exceeded.) and
 * 17 of the 43 symbols came back incomplete or empty. The shared egress
 * already carries the machine's own 60-call/minute budget, so the
 * research fetcher must live well under it.
 *
 * Binance's public market-data endpoints are keyless and have their own
 * generous IP budget, entirely separate from the account's — which is
 * exactly why the repo's own replication uses them. This fetcher is the
 * FALLBACK SOURCE for the symbols KuCoin could not deliver, and the
 * CROSS-CHECK for the symbols it did.
 *
 * The tape is computed on 24 x 1-HOUR bars, so the granularity here is
 * the same as the live path's. Prices differ by a scale factor on the
 * 1000-multiplied contracts (e.g. 1000BONK vs BONK), but every quantity
 * measured here is a PERCENTAGE or a NOTIONAL, and both are
 * scale-invariant.
 *
 * USAGE
 *   node research/uni-fetch-binance-1h.mjs [--days 14] [--out <path>]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const BIN = "https://fapi.binance.com";
const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DAYS = Number(flag("days", 14));
const OUT = flag("out", join(SCRATCH, "uni-binance-1h-bars.json"));
const PACE_MS = 120;   // Binance's public budget is generous; stay polite
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`non-JSON (${r.status}): ${txt.slice(0, 160)}`); }
  if (j && j.code && String(j.code) !== "200" && /invalid|unknown/i.test(j.msg ?? "")) {
    throw new Error(`api error ${j.code}: ${j.msg}`);
  }
  return j;
}

async function klines(symbol, interval, fromMs, toMs) {
  const out = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard++ < 40) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}`
      + `&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    let rows;
    try {
      rows = await getJson(url);
    } catch (e) {
      console.error(`  [binance-1h] ${symbol} ${interval}: ${e.message}`);
      break;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      out.push({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
                 l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) });
    }
    const last = Number(rows[rows.length - 1][0]);
    const next = last + 1;
    if (next <= cursor) break;
    cursor = next;
    await sleep(PACE_MS);
  }
  const m = new Map();
  for (const b of out) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

const bases = JSON.parse(readFileSync(join(SCRATCH, "rep-bases.json"), "utf8"));
const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set(
  (info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map((s) => s.symbol),
);
const map = {}; const unmapped = [];
for (const b of bases) {
  const cands = [];
  if (b === "XBT") cands.push("BTCUSDT");
  else {
    cands.push(`${b}USDT`);
    if (b.startsWith("1000")) cands.push(`${b.slice(4)}USDT`);
    if (b.startsWith("10000")) cands.push(`${b.slice(5)}USDT`);
    cands.push(`1000${b}USDT`);
  }
  const hit = cands.find((c) => perps.has(c));
  if (hit) map[b] = hit; else unmapped.push(b);
}
console.log(`[binance-1h] ${Object.keys(map).length} of ${bases.length} map; unmapped: ${unmapped.join(", ") || "none"}`);

let cache = {};
if (existsSync(OUT)) { try { cache = JSON.parse(readFileSync(OUT, "utf8")); } catch { cache = {}; } }

const now = Date.now();
const from = now - DAYS * 24 * 3600_000;
for (const [base, sym] of Object.entries(map)) {
  const key = `${base}/USDT`;
  const have = cache[key] ?? [];
  const merged = new Map();
  for (const b of have) merged.set(b.t, b);
  if (merged.size && minOf(merged.keys()) <= from + 3600_000
      && maxOf(merged.keys()) >= now - 3600_000) {
    console.log(`[binance-1h] ${key}: cached and complete (${merged.size} bars)`);
    continue;
  }
  const one = await klines(sym, "1h", from - 72 * 3600_000, now);
  if (!one.length) { console.error(`[binance-1h] ${sym}: no 1h klines`); continue; }
  cache[key] = one;
  console.log(`[binance-1h] ${key}: ${one.length} 1h bars  ${new Date(one[0].t).toISOString()} -> ${new Date(one[one.length-1].t).toISOString()}`);
  writeFileSync(OUT, JSON.stringify(cache));
}
console.log(`[binance-1h] wrote ${OUT}`);
