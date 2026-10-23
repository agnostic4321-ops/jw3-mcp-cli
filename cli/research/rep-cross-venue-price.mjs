#!/usr/bin/env node
/**
 * CROSS-VENUE PRICE CHECK — is the same instrument the same market?
 *
 * The tape's SIDE is decided by two conditions:
 *
 *   vratio < 0.85        — a VOLUME condition. Each venue's volume is
 *                          its own book, so this legitimately differs
 *                          between venues. It is not a reconstruction
 *                          error: the replication computes it from the
 *                          independent venue's OWN volume, which is what
 *                          the live path would read on that venue.
 *   offHighPct < 8  OR  offLowPct < 8
 *                       — a PRICE condition. These must agree across
 *                          venues, because they describe the same
 *                          underlying market.
 *
 * So the price half is the part that must reconcile, and it is checked
 * here directly: Binance's 1-minute CLOSE at the exact read time against
 * the KuCoin book mid the collector recorded at that same read.
 *
 * A relative price difference of a few basis points is the venue's
 * spread and basis. A LARGE or systematic difference means the two
 * venues' contracts are not the same instrument, and the replication
 * would be measuring something else.
 *
 * READ-ONLY. Binance only. No KuCoin call, no account call.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const BASES = JSON.parse(readFileSync(join(SCRATCH, "rep-bases.json"), "utf8"));
const BIN = "https://fapi.binance.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON: ${t.slice(0, 120)}`); }
}
async function klines(symbol, interval, fromMs, toMs) {
  const out = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard++ < 10) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    let rows;
    try { rows = await getJson(url); } catch { break; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), ct: Number(r[6]) });
    const last = Number(rows[rows.length - 1][0]);
    if (last + 1 <= cursor) break;
    cursor = last + 1;
    await sleep(40);
  }
  const m = new Map();
  for (const b of out) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

const rows = readFileSync(join(SCRATCH, "rep-confluence.snapshot.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const withPrice = rows.filter((r) => r.price > 0);
console.log(`[price] ${withPrice.length} recorded reads with a price`);

const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
const map = {};
for (const b of BASES) {
  const cands = b === "XBT" ? ["BTCUSDT"] : [`${b}USDT`, b.startsWith("1000") ? `${b.slice(4)}USDT` : null, b.startsWith("10000") ? `${b.slice(5)}USDT` : null, `1000${b}USDT`].filter(Boolean);
  const hit = cands.find((c) => perps.has(c));
  if (hit) map[b] = hit;
}

const byPair = new Map();
for (const r of withPrice) {
  if (!byPair.has(r.pair)) byPair.set(r.pair, []);
  byPair.get(r.pair).push(r);
}

const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const allRel = [];
const perSym = [];

for (const [pair, rs] of byPair) {
  const base = pair.split("/")[0];
  const sym = map[base];
  if (!sym) continue;
  const ts0 = minBy(rs, (r) => r.ts);
  const ts1 = maxBy(rs, (r) => r.ts);
  const one = await klines(sym, "1m", ts0 - 120_000, ts1 + 60_000);
  if (!one.length) continue;
  const byT = new Map(one.map((b) => [b.t, b]));
  const rel = [];
  let scale = 1;
  // Detect the 1000x contract: the price ratio is either ~1 or ~1000.
  const first = rs[0];
  const b0 = byT.get(Math.floor(first.ts / 60000) * 60000);
  if (b0) {
    const ratio = first.price / b0.c;
    if (ratio > 100) scale = 1000;
    else if (ratio < 0.01) scale = 0.001;
  }
  for (const r of rs) {
    const b = byT.get(Math.floor(r.ts / 60000) * 60000);
    if (!b) continue;
    const relDiff = (r.price - b.c * scale) / (b.c * scale) * 100;
    rel.push(Math.abs(relDiff));
  }
  if (!rel.length) continue;
  const m = med(rel);
  allRel.push(...rel);
  perSym.push({ base, sym, n: rel.length, medBp: m * 100, scale });
  console.log(`  ${base.padEnd(12)} ${sym.padEnd(16)} n=${String(rel.length).padStart(3)}  scale=${scale}  median |price diff| = ${(m * 100).toFixed(1)} bps`);
}

console.log(`\n[price] ${perSym.length} symbols, ${allRel.length} matched reads`);
console.log(`[price] median |price difference| = ${(med(allRel) * 100).toFixed(1)} bps   (the venues' spread + basis)`);
const bad = perSym.filter((p) => p.medBp > 100);
console.log(`[price] symbols with a median difference over 100 bps: ${bad.length ? bad.map((b) => `${b.base}(${b.medBp.toFixed(0)}bps)`).join(", ") : "none"}`);
