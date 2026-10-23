#!/usr/bin/env node
/**
 * THE ORDER-BOOK IMBALANCE COLLECTOR — Binance USDⓈ-M, keyless, public.
 *
 * WHY
 *   The KuCoin collector's book imbalance exists for only ~6 hours, so
 *   the imbalance study cannot reach 30 independent clusters at a 1h or
 *   4h horizon. Binance's DEPTH endpoint is keyless and public, on a
 *   separate IP budget from the account's venue, so it can be sampled
 *   at a HIGH cadence for as long as this session runs.
 *
 *   The imbalance formula is the machine's own:
 *       imb = (bid5Usd − ask5Usd) / (bid5Usd + ask5Usd)
 *   over the top-5 levels' NOTIONAL, exactly as decide.ts builds it
 *   (packages/jw3-cli/src/commands/decide.ts:186-194).
 *
 * WHAT IT RECORDS, PER OBSERVATION
 *   ts, pair, imb, mid, sprBps, bid5Usd, ask5Usd
 *
 * THE BUDGET
 *   Binance only. Never the account, never KuCoin. The account's
 *   STOP-ARMING path shares a 60-call/min budget on the account's
 *   venue — this script never touches that venue at all.
 *
 * USAGE: node collect-depth.mjs [--out <file>] [--cadence 15]
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = "https://fapi.binance.com";
const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const flag = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const OUT = String(flag("out", join(SCRATCH, "oflow/binance-depth.ndjson")));
const CADENCE_S = Number(flag("cadence", 15));
const LEVELS = 5;

const bases = JSON.parse(readFileSync(join(SCRATCH, "rep-bases.json"), "utf8"));

async function getJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON (${r.status}): ${t.slice(0, 120)}`); }
}

const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
const map = [];
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
  if (hit) map.push({ base: b, sym: hit });
}
console.log(`[depth] ${map.length} symbols mapped`);

if (!existsSync(OUT)) writeFileSync(OUT, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0, fails = 0;
let round = 0;

for (;;) {
  const ts = Date.now();
  for (const { base, sym } of map) {
    try {
      const d = await getJson(`${BIN}/fapi/v1/depth?symbol=${encodeURIComponent(sym)}&limit=${LEVELS}`);
      const bids = d.bids ?? [], asks = d.asks ?? [];
      if (!bids.length || !asks.length) continue;
      let bid5 = 0, ask5 = 0;
      for (const [p, q] of bids) bid5 += Number(p) * Number(q);
      for (const [p, q] of asks) ask5 += Number(p) * Number(q);
      const mid = (Number(bids[0][0]) + Number(asks[0][0])) / 2;
      const imb = bid5 + ask5 > 0 ? (bid5 - ask5) / (bid5 + ask5) : 0;
      const sprBps = mid > 0 ? ((Number(asks[0][0]) - Number(bids[0][0])) / mid) * 10_000 : 0;
      appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), pair: `${base}/USDT`, imb, mid, sprBps, bid5Usd: bid5, ask5Usd: ask5 })}\n`);
      n++;
    } catch (e) {
      fails++;
      if (fails % 50 === 1) console.error(`[depth] ${sym}: ${e.message}`);
    }
  }
  round++;
  console.log(`[depth] round ${round}  ts=${new Date(ts).toISOString()}  total=${n}  fails=${fails}`);
  const elapsed = Date.now() - ts;
  await sleep(Math.max(1000, CADENCE_S * 1000 - elapsed));
}
