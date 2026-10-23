#!/usr/bin/env node
/**
 * EXTENDED HISTORY FETCHER — Binance USDⓈ-M, keyless public market data.
 *
 * WHY: the long-hold geometries (4h/12h/24h) need >= 30 days of bars so
 * that the cluster count at a 24-hour holding period reaches the bar's
 * 30 independent clusters. The local caches hold 14 days (1h) and 14 days
 * (15m), which yields 13 day-clusters at a 24h hold -- short of the bar.
 *
 * Binance is used for the bulk because its public market-data budget is
 * separate from the account's egress (the repo's own replication already
 * uses it as the independent venue). KuCoin is used for the native
 * cross-check and for the symbols Binance does not list.
 *
 * USAGE: node fetch-binance.mjs --days 45
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = "https://fapi.binance.com";
const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT_DIR = join(SCRATCH, "geo2");
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DAYS = Number(flag("days", 45));
const PACE_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`non-JSON (${r.status}): ${txt.slice(0, 160)}`); }
  if (j && j.code && String(j.code) !== "200") throw new Error(`api ${j.code}: ${j.msg}`);
  return j;
}

async function klines(symbol, interval, fromMs, toMs) {
  const out = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard++ < 60) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}`
      + `&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    let rows;
    try { rows = await getJson(url); }
    catch (e) { console.error(`  [bin] ${symbol} ${interval}: ${e.message}`); break; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) });
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
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
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
console.log(`[bin] ${Object.keys(map).length} of ${bases.length} map; unmapped: ${unmapped.join(", ") || "none"}`);
writeFileSync(join(OUT_DIR, "unmapped.json"), JSON.stringify(unmapped));

const now = Date.now();
const from = now - DAYS * 24 * 3600_000;
for (const [base, sym] of Object.entries(map)) {
  const key = `${base}/USDT`;
  for (const [interval, outName] of [["1h", "geo-binance-1h.json"], ["15m", "geo-binance-15m.json"]]) {
    const out = join(OUT_DIR, outName);
    const cache = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
    const have = cache[key] ?? [];
    const merged = new Map();
    for (const b of have) merged.set(b.t, b);
    if (merged.size && Math.min(...merged.keys()) <= from + 3600_000 && Math.max(...merged.keys()) >= now - 3600_000) {
      console.log(`[bin] ${key} ${interval}: cached (${merged.size})`);
      continue;
    }
    const one = await klines(sym, interval, from - 72 * 3600_000, now);
    if (!one.length) { console.error(`[bin] ${sym} ${interval}: no klines`); continue; }
    for (const b of one) merged.set(b.t, b);
    cache[key] = [...merged.values()].sort((a, b) => a.t - b.t);
    writeFileSync(out, JSON.stringify(cache));
    const arr = cache[key];
    console.log(`[bin] ${key} ${interval}: ${arr.length} bars ${new Date(arr[0].t).toISOString()} -> ${new Date(arr[arr.length-1].t).toISOString()}`);
  }
}
console.log("[bin] done");
