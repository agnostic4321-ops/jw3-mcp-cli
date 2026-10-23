#!/usr/bin/env node
/**
 * THE TRADE-FLOW BAR FETCHER — Binance USDⓈ-M, keyless, public.
 *
 * WHY IT IS NEEDED
 *   The collector's book imbalance exists only for ~60 five-minute
 *   rounds (the collector has been running ~6 hours). A study of the
 *   order flow at that depth cannot reach 30 independent clusters at a
 *   4-hour horizon. The TRADE FLOW is backfillable: Binance's klines
 *   carry taker-buy base volume and quote volume, which give the
 *   trade-flow imbalance and the VWAP for every bar over the whole
 *   window.
 *
 * WHAT IT FETCHES (public market data only)
 *   GET /fapi/v1/klines — 15m bars with:
 *     volume            — base volume
 *     quoteVolume       — quote volume   -> the bar's VWAP
 *     takerBuyBaseVol   — the taker-BUY side's base volume
 *     trades            — the trade count
 *
 * THE BUDGET
 *   Binance is a separate IP budget from the account's venue. This
 *   never touches the account, never touches KuCoin.
 *
 * USAGE: node fetch-tradeflow.mjs [--days 14] [--out <file>]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = "https://fapi.binance.com";
const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const flag = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const DAYS = Number(flag("days", 14));
const OUT = String(flag("out", join(SCRATCH, "oflow/binance-tf-bars.json")));
const UNIVERSE = join(SCRATCH, "rep-bases.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON (${r.status}): ${t.slice(0, 160)}`); }
}

const bases = JSON.parse(readFileSync(UNIVERSE, "utf8"));
const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
const map = {};
for (const b of bases) {
  const cands = [];
  if (b === "XBT") cands.push("BTCUSDT");
  else {
    cands.push(`${b}USDT`);
    if (b.startsWith("1000")) cands.push(b.slice(4) + "USDT");
    if (b.startsWith("10000")) cands.push(b.slice(5) + "USDT");
    cands.push(`1000${b}USDT`);
  }
  const hit = cands.find((c) => perps.has(c));
  if (hit) map[b] = hit;
}
console.log(`[tf] ${Object.keys(map).length} of ${bases.length} symbols map to Binance USDⓈ-M perps`);

const now = Date.now();
const from = now - DAYS * 24 * 3600_000;
const to = now + 4 * 3600_000; // forward bars past the last observation
let cache = {};
if (existsSync(OUT)) { try { cache = JSON.parse(readFileSync(OUT, "utf8")); } catch { cache = {}; } }

let reqs = 0, fails = 0;
for (const [base, sym] of Object.entries(map)) {
  const have = cache[base] ?? [];
  const oldest = have.length ? have[0].t : Infinity;
  const newest = have.length ? have[have.length - 1].t : 0;
  if (oldest <= from && newest >= to - 900_000) {
    console.log(`[tf] ${base}: cached (${have.length} bars)`);
    continue;
  }
  const merged = new Map();
  for (const b of have) merged.set(b.t, b);
  let cursor = from;
  let guard = 0;
  while (cursor < to && guard++ < 40) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=15m&startTime=${cursor}&endTime=${to}&limit=1500`;
    let rows;
    try { rows = await getJson(url); reqs++; }
    catch (e) { fails++; console.error(`[tf] ${sym}: ${e.message}`); break; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      merged.set(Number(r[0]), {
        t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]),
        v: Number(r[5]), qv: Number(r[7]), n: Number(r[8]), tb: Number(r[9]), tq: Number(r[10]),
      });
    }
    const last = Number(rows[rows.length - 1][0]);
    if (last + 1 <= cursor) break;
    cursor = last + 1;
    await sleep(60);
  }
  const arr = [...merged.values()].sort((a, b) => a.t - b.t);
  cache[base] = arr;
  const n = arr.length;
  console.log(`[tf] ${base}: ${n} bars ${n ? `${new Date(arr[0].t).toISOString()} -> ${new Date(arr[n - 1].t).toISOString()}` : ""}`);
  writeFileSync(OUT, JSON.stringify(cache));
}
console.log(`\n[tf] done: ${reqs} requests, ${fails} failures, ${Object.keys(cache).length} symbols -> ${OUT}`);
