#!/usr/bin/env node
/**
 * A PUBLIC-KLINE bar fetcher for the geometry stress test.
 *
 * It touches ONLY the public futures kline endpoint (no account, no order,
 * no position, no private endpoint) and it paces itself well below the
 * shared per-minute budget, because the live machine's STOP-ARMING path
 * reads the same server.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "stress-geometry-bars2.json");
const SEED_FILE = join(SCRATCH, "geometry-bars.json");
const PAIRS_FILE = join(SCRATCH, "stress-geometry-pairs.json");
const BAR_MIN = 15;
const PAGE_MS = 200 * BAR_MIN * 60_000;
const SLEEP_MS = 3200; // ~18 calls/min, leaving room for the collector

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

const pairs = JSON.parse(readFileSync(PAIRS_FILE, "utf8"));
const bars = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
if (existsSync(SEED_FILE)) {
  const seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  for (const [k, v] of Object.entries(seed)) {
    if (!bars[k]) bars[k] = v;
  }
}

const fromMs = Date.now() - 40 * 3600_000;
const toMs = Date.now();
let calls = 0;
for (const pair of pairs) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const map = new Map();
  for (const b of (bars[pair] ?? [])) map.set(b.t, b);
  let cursor = toMs;
  let guard = 0;
  let err = null;
  while (cursor > fromMs && guard++ < 4) {
    const hi = Math.min(cursor, toMs);
    const lo = Math.max(fromMs, hi - PAGE_MS);
    if (hi - lo < BAR_MIN * 60_000) break;
    try {
      const d = await futJson(`/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`);
      calls++;
      const rows = Array.isArray(d) ? d : [];
      if (!rows.length) break;
      for (const row of rows) {
        map.set(Number(row[0]), { t: Number(row[0]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
      }
    } catch (e) {
      err = String(e?.message ?? e);
      break;
    }
    cursor = lo - 1;
    await sleep(SLEEP_MS);
  }
  const all = [...map.values()].sort((a, b) => a.t - b.t);
  bars[pair] = all;
  const last = all.length ? new Date(all[all.length - 1].t).toISOString() : "-";
  console.log(`${pair}: ${all.length} bars -> ${last} ${err ? `ERR ${err}` : ""}`);
  writeFileSync(OUT, JSON.stringify(bars));
  await sleep(SLEEP_MS);
}
console.log(`[fetch] ${calls} kline calls, wrote ${OUT}`);
