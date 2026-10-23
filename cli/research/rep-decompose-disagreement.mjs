#!/usr/bin/env node
/**
 * WHY DO THE RECONSTRUCTED SIDES DISAGREE WITH KUCOIN'S?
 *
 * The cross-venue check measures the reconstructed tape's side agreeing
 * with KuCoin's on ~64% of reads, with a median price-metric difference
 * of 0.23-0.32pp. The price half reconciles tightly; the SIDE does not
 * fully, and the reason must be established rather than assumed.
 *
 * THE TAPE'S SIDE NEEDS BOTH:
 *
 *   vratio < 0.85        — a VOLUME condition. Each venue's volume is
 *                          ITS OWN book. KuCoin's vratio and Binance's
 *                          vratio are different numbers about different
 *                          books, and BOTH are correct readings of
 *                          their own venue. The live path on Binance
 *                          would read Binance's vratio.
 *   offHighPct < 8  OR  offLowPct < 8
 *                       — a PRICE condition, which must agree.
 *
 * So the question this answers: are the disagreements CONCENTRATED in
 * the vratio threshold, i.e. rows where the price condition is met on
 * both venues but the volume condition is met on only one?
 *
 * If YES, the reconstruction is correct and the disagreement is the
 * venue's own volume, which is the right thing for a replication to
 * measure. If NO — if the disagreements persist even where BOTH
 * conditions agree — the reconstruction is broken.
 *
 * READ-ONLY. Binance only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fadeMetrics, tapeSideOf } from "./rep-venue-common.mjs";
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
function tapeAt(bars, ts) {
  const win = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.t > ts) continue;
    win.push(b);
    if (win.length >= 24) break;
  }
  win.reverse();
  if (win.length < 24) return null;
  const m = fadeMetrics(win.map((b) => b.c), win.map((b) => b.v), win.map((b) => b.h), win.map((b) => b.l));
  return m ? { ...m, last: win[win.length - 1].c } : null;
}

const rows = readFileSync(join(SCRATCH, "rep-confluence.snapshot.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const kc = new Map();
for (const r of rows) {
  if (r.tapeChg == null) continue;
  const b = Math.floor(r.ts / 300_000);
  const k = `${r.pair}|${b}`;
  const prev = kc.get(k);
  if (!prev || r.ts > prev.ts) kc.set(k, r);
}

const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
const map = {};
for (const b of BASES) {
  const cands = b === "XBT" ? ["BTCUSDT"] : [`${b}USDT`, b.startsWith("1000") ? `${b.slice(4)}USDT` : null, b.startsWith("10000") ? `${b.slice(5)}USDT` : null, `1000${b}USDT`].filter(Boolean);
  const hit = cands.find((c) => perps.has(c));
  if (hit) map[b] = hit;
}

// The decomposition.
let n = 0;
let bothSide = 0, bothSideAgree = 0, bothSideOppose = 0;
let volOnlyDiff = 0, priceOnlyDiff = 0, bothDiff = 0;
let kcSide = 0, bnSide = 0, kcNone = 0, bnNone = 0;
let vratioBothUnder = 0, vratioOneUnder = 0;
let priceCondAgree = 0, priceCondDisagree = 0;

for (const [base, sym] of Object.entries(map)) {
  const kcRows = [...kc.entries()].filter(([k]) => k.startsWith(`${base}/USDT|`)).map(([, v]) => v);
  if (!kcRows.length) continue;
  const ts0 = minBy(kcRows, (r) => r.ts);
  const ts1 = maxBy(kcRows, (r) => r.ts);
  const one = await klines(sym, "1h", ts0 - 72 * 3600_000, ts1 + 3600_000);
  if (one.length < 24) continue;
  for (const r of kcRows) {
    const t = tapeAt(one, r.ts);
    if (!t) continue;
    n++;
    const s1 = tapeSideOf({ offHighPct: t.offHighPct, offLowPct: t.offLowPct, vratio: t.vratio });
    const s2 = tapeSideOf({ offHighPct: r.tapeOffHighPct, offLowPct: r.tapeOffLowPct, vratio: r.tapeVratio });
    // The two conditions, separately, per venue.
    const vol1 = t.vratio < 0.85;           // Binance's own volume
    const vol2 = r.tapeVratio < 0.85;       // KuCoin's own volume
    const price1 = t.offHighPct < 8 || t.offLowPct < 8;
    const price2 = r.tapeOffHighPct < 8 || r.tapeOffLowPct < 8;
    if (price1 === price2) priceCondAgree++; else priceCondDisagree++;
    if (s1) bnSide++; else bnNone++;
    if (s2) kcSide++; else kcNone++;
    if (s1 && s2) {
      bothSide++;
      if (s1 === s2) bothSideAgree++; else bothSideOppose++;
    }
    if (vol1 !== vol2) vratioOneUnder++;
    else vratioBothUnder++;
    // Classify the disagreement.
    if (s1 !== s2) {
      if (price1 === price2 && vol1 !== vol2) volOnlyDiff++;
      else if (price1 !== price2 && vol1 === vol2) priceOnlyDiff++;
      else bothDiff++;
    }
  }
}

console.log(`[decompose] ${n} comparable reads\n`);
console.log(`  THE VOLUME CONDITION (vratio < 0.85)`);
console.log(`    rows where the two venues AGREE on it: ${vratioBothUnder}  (${((vratioBothUnder / n) * 100).toFixed(1)}%)`);
console.log(`    rows where they DISAGREE:              ${vratioOneUnder}  (${((vratioOneUnder / n) * 100).toFixed(1)}%)  <- each venue's OWN volume`);
console.log(`\n  THE PRICE CONDITION (offHighPct<8 OR offLowPct<8)`);
console.log(`    rows where the two venues AGREE:        ${priceCondAgree}  (${((priceCondAgree / n) * 100).toFixed(1)}%)`);
console.log(`    rows where they DISAGREE:               ${priceCondDisagree}  (${((priceCondDisagree / n) * 100).toFixed(1)}%)  <- must be small`);
console.log(`\n  THE SIDE`);
console.log(`    both venues produced a side:            ${bothSide}`);
console.log(`    of those, they AGREE:                  ${bothSideAgree}  (${bothSide ? ((bothSideAgree / bothSide) * 100).toFixed(1) : "n/a"}%)`);
console.log(`    of those, they OPPOSE:                 ${bothSideOppose}`);
console.log(`\n  THE DISAGREEMENTS, CLASSIFIED`);
console.log(`    volume condition only (price agrees):   ${volOnlyDiff}   <- the venue's own volume`);
console.log(`    price condition only (volume agrees):   ${priceOnlyDiff}   <- a reconstruction error`);
console.log(`    BOTH conditions differ:                ${bothDiff}`);
console.log(`\n  => ${priceOnlyDiff + bothDiff} of ${volOnlyDiff + priceOnlyDiff + bothDiff} disagreements are PRICE-side errors;`);
console.log(`     ${volOnlyDiff} are the venue's own volume, which is correct behaviour for a replication.`);
