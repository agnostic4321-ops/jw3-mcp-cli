#!/usr/bin/env node
/**
 * BAR FETCHER for the hero geometry sweep.
 *
 * Pulls 5-minute bars from KuCoin's PUBLIC kline endpoint for every pair
 * in the confluence file, caching them under a unique name.
 *
 * ── WHY 5-MINUTE BARS ──
 *
 * The 15-minute bars the earlier study used have two problems:
 *   - a 0.30% target is 1/50th of a 15-minute bar's typical range, so
 *     the "which level was touched first" question is answered by the
 *     bar's range, not by the path;
 *   - the 1-minute bars have gaps (KuCoin drops minutes with no trade),
 *     which silently truncates a hold window.
 *
 * The 5-minute bars had ZERO gaps over an 8-hour check, so a hold window
 * is contiguous and every level-touch is measured on a real 5-minute
 * range.
 *
 * ── READ-ONLY ──
 *
 * Public market data only. No account read, no order, no private API.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const IN = join(SCRATCH, "confluence.ndjson");
const CACHE = join(SCRATCH, "geom-hero-bars.json");
const INTERVAL_MIN = 5;
const INTERVAL_MS = INTERVAL_MIN * 60_000;

async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

const existing = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pairs = [...new Set(rows.map((r) => r.pair))];
const tsAll = rows.map((r) => r.ts);
const nowMs = Date.now();
// The window: the earliest observation back to now, plus a small margin.
const fromMs = minOf(tsAll) - 30 * 60_000;

console.log(`[bars] ${pairs.length} pairs, window ${new Date(fromMs).toISOString()} -> ${new Date(nowMs).toISOString()}`);

let fetched = 0;
for (const pair of pairs) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const merged = new Map();
  for (const b of existing[pair] ?? []) merged.set(b.t, b);
  const PAGE_MS = 200 * INTERVAL_MS;
  let cursor = nowMs;
  let guard = 0;
  while (cursor > fromMs && guard++ < 20) {
    const hi = Math.min(cursor, nowMs);
    const lo = Math.max(fromMs, hi - PAGE_MS);
    if (hi - lo < INTERVAL_MS) break;
    let d;
    try {
      d = await futJson(`/api/v1/kline/query?symbol=${sym}&granularity=${INTERVAL_MIN}&from=${lo}&to=${hi}`);
    } catch (e) {
      console.error(`[bars] ${pair}: ${e.message}`);
      break;
    }
    const rowsOut = Array.isArray(d) ? d : [];
    if (!rowsOut.length) break;
    for (const row of rowsOut) {
      merged.set(Number(row[0]), { t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
    }
    cursor = lo - 1;
    await new Promise((r) => setTimeout(r, 130));
  }
  const all = [...merged.values()].sort((a, b) => a.t - b.t);
  existing[pair] = all;
  fetched++;
  process.stdout.write(`\r[bars] ${fetched}/${pairs.length}`);
}
console.log();
writeFileSync(CACHE, JSON.stringify(existing));

// The coverage report.
let covered = 0;
const gaps = [];
for (const p of pairs) {
  const b = existing[p] ?? [];
  if (!b.length) { console.log(`[bars] NO BARS for ${p}`); continue; }
  covered++;
  let g = 0;
  for (let i = 1; i < b.length; i++) if (b[i].t - b[i - 1].t !== INTERVAL_MS) g++;
  gaps.push({ p, n: b.length, g, from: b[0].t, to: b[b.length - 1].t });
}
console.log(`[bars] ${covered}/${pairs.length} symbols have bars`);
const totalGaps = gaps.reduce((s, x) => s + x.g, 0);
const withGaps = gaps.filter((x) => x.g > 0);
console.log(`[bars] total gaps across all symbols: ${totalGaps} (${withGaps.length} symbols have any)`);
if (withGaps.length) {
  console.log("[bars] the symbols with gaps:");
  for (const x of withGaps.slice(0, 12)) console.log(`    ${x.p}: ${x.g} gaps, n=${x.n}`);
}
const sample = gaps[0];
console.log(`[bars] example coverage: ${sample.p} ${new Date(sample.from).toISOString()} -> ${new Date(sample.to).toISOString()} n=${sample.n}`);
