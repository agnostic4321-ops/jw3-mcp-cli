#!/usr/bin/env node
/**
 * REFRESH the 15-minute bar cache for the symbols the live-gate arm
 * actually uses.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live-gate measurement is bounded by the bar cache: a signal needs
 * a FORWARD window (16 x 15-minute bars = 4 hours) to be resolved, and
 * any signal whose forward window extends past the cache's newest bar
 * is unresolvable. Measured: 29 live-gate observations, of which 18
 * were unresolvable because the cache was 56 minutes stale.
 *
 * The cache refreshes only when someone runs a study, so the newest
 * signal is always the least measurable one. That is the wrong
 * direction: the freshest evidence is the most valuable evidence, and
 * it is the evidence the cache drops.
 *
 * So this script tops the cache up: it finds the pairs the live-gate
 * arm needs, fetches the bars they are missing, and MERGES them into
 * the existing cache (never overwriting a bar that is already there).
 *
 * USAGE
 *   node research/refresh-bars.mjs                 # refresh what the arm needs
 *   node research/refresh-bars.mjs --pairs A/B,C/D # refresh named pairs
 *   node research/refresh-bars.mjs --hours 48      # look back this far
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const CACHE = join(SCRATCH, "fee-floor-15m-bars.json");
const BAR_MIN = 15;
const PAGE_MS = 200 * BAR_MIN * 60_000; // KuCoin returns at most 200 bars

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const KUCOIN_BASE = "https://api-futures.kucoin.com";
const CONTRACT_OF = (pair) => `${pair.replace("/", "")}M`;

/** The pair contract's exchange symbol: BTC is XBT venue-side. */
function contractFor(pair) {
  const [base, quote] = pair.split("/");
  const b = base === "BTC" ? "XBT" : base;
  return `${b}${quote}M`;
}

/** Fetch 15-minute klines, paging backwards. */
async function fetchBars(pair, needUntilMs) {
  const symbol = contractFor(pair);
  const end = needUntilMs;
  const out = [];
  let hi = end;
  for (let page = 0; page < 6; page++) {
    const lo = Math.max(0, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    const url = `${KUCOIN_BASE}/api/v1/kline/query?symbol=${symbol}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`;
    let rows = null;
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
      const j = await res.json();
      if (j.code === "200000" && Array.isArray(j.data)) rows = j.data;
      else if (j.code) throw new Error(`KuCoin ${j.code}: ${j.msg ?? ""}`);
    } catch (e) {
      console.error(`[bars] ${pair} page ${page}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      // KuCoin's columns: [ts, open, high, low, close, vol, turnover]
      out.push({ t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) });
    }
    hi = lo;
  }
  return out;
}

// ── which pairs does the live-gate arm need? ──
const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const liveGate = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
};
const arm = rows.filter((r) => tapeSideFromRow(r) && liveGate(r) === tapeSideFromRow(r));
const named = argOf("pairs", "");
const pairs = named
  ? named.split(",").map((p) => p.trim()).filter(Boolean)
  : [...new Set(arm.map((r) => r.pair))];
const hours = Number(argOf("hours", "24"));
const needUntil = Date.now() + 16 * BAR_MIN * 60_000; // 16 bars of forward room
const lookback = Date.now() - hours * 3600_000;

console.log(`[bars] ${arm.length} live-gate observations over ${pairs.length} pairs`);
console.log(`[bars] cache: ${CACHE}`);

// ── load and merge ──
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
let added = 0;
let fetched = 0;
for (const pair of pairs) {
  const have = new Set((cache[pair] ?? []).map((b) => b.t));
  const want = arm
    .filter((r) => r.pair === pair)
    .map((r) => r.ts + 16 * BAR_MIN * 60_000);
  if (!want.length) continue;
  const from = minOf(want);
  const to = maxOf(want);
  // Only fetch what is missing. The window starts just BEFORE the
  // cache's newest bar (so a gap is not left behind) and runs to the
  // PRESENT — the cache must reach the newest signal, or the freshest
  // evidence is the least measurable evidence.
  //
  // The first attempt ended at `to` (the newest signal's need), which
  // left the cache at 13:30 while the collector was at 17:26 — the
  // freshest signals still had no forward window.
  const haveMax = have.size ? maxOf(have) : 0;
  const startFrom = haveMax
    ? Math.min(haveMax - BAR_MIN * 60_000, lookback)
    : Math.min(from - 24 * 3600_000, lookback);
  const endAt = Date.now();
  if (endAt - startFrom < BAR_MIN * 60_000) continue;
  const got = await fetchBars(pair, endAt);
  fetched++;
  const list = cache[pair] ?? (cache[pair] = []);
  const seen = new Set(list.map((b) => b.t));
  for (const b of got) {
    if (b.t < startFrom || b.t > endAt) continue;
    if (seen.has(b.t)) continue;
    if (!Number.isFinite(b.t) || !Number.isFinite(b.h) || !Number.isFinite(b.l) || !Number.isFinite(b.c)) continue;
    list.push(b);
    seen.add(b.t);
    added++;
  }
  list.sort((a, b) => a.t - b.t);
  const newest = list.length ? new Date(list[list.length - 1].t).toISOString().slice(11, 16) : "-";
  console.log(`[bars] ${pair}: ${list.length} bars, newest ${newest}`);
  // Be gentle with the public API.
  await new Promise((r) => setTimeout(r, 250));
}
writeFileSync(CACHE, JSON.stringify(cache));
console.log(`[bars] fetched ${fetched} pair-window(s), added ${added} bars`);
console.log(`[bars] wrote ${CACHE}`);
