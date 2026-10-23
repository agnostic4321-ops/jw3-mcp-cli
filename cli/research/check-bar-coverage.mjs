#!/usr/bin/env node
/**
 * THE BAR-CACHE COVERAGE CHECK.
 *
 * A study's sample is the cache it reads, and a cache that stops short
 * of the newest signal DISCARDS THE MOST RECENT OBSERVATIONS — which
 * are the ones that decide whether the newest result holds. The
 * effect is not a missing number, it is a BIASED sample, and it
 * flatters the strategy: the omitted observations are the ones that
 * had not yet resolved, and the losers resolve later than the
 * winners.
 *
 * This has now happened in THREE different caches in one day:
 *
 *   fee-floor-15m-bars.json  the live-gate arm's cache. The threshold
 *                            study resolved only 15 of 45 trades
 *                            until it was refreshed, and the arm's
 *                            numbers moved from -0.2111% to -0.3362%
 *                            once it was — the fresh data made the arm
 *                            WORSE, which is the signature of the
 *                            missing observations being the losers.
 *   cont-1h-bars.json        stopped at 09:00 for most of the arm's
 *                            pairs while the signals ran to 17:08, so
 *                            only 5 of 83 rows resolved.
 *   cont-15m-bars.json       stopped at 17:30 against a collector
 *                            running to 21:54.
 *
 * So the check is not optional: a study must REPORT its cache's
 * coverage before its result, and a result computed on a stale cache
 * must not be quoted.
 *
 * WHAT IT CHECKS
 *   - each cache's newest bar, against the collector's newest row
 *   - the number of PAIRS that are stale (a cache can have a recent
 *     newest bar and still be stale for most of its pairs)
 *   - the number of the COLLECTOR'S ROWS that each cache can resolve
 *     at all, which is the number that actually matters
 *
 * Run: node research/check-bar-coverage.mjs
 *       node research/check-bar-coverage.mjs --json
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONF = join(SCRATCH, "confluence.ndjson");
const AS_JSON = process.argv.includes("--json");

/** A cache is stale for a pair if its newest bar is this far behind. */
const STALE_MS = 60 * 60 * 1000; // one hour

const CACHES = [
  { file: "fee-floor-15m-bars.json", note: "the live-gate arm's cache — the one the arm studies use" },
  { file: "cont-15m-bars.json", note: "the confluence study's 15-minute cache" },
  { file: "cont-1h-bars.json", note: "the confluence study's 1-hour cache" },
  { file: "confluence-bars.json", note: "an early confluence cache" },
  { file: "family-bars.vol.json", note: "the family study's volatility cache" },
  { file: "cont-15m-deep.json", note: "the deep confluence cache" },
];

function barList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.bars)) return v.bars;
  return null;
}

if (!existsSync(CONF)) {
  console.error(`missing the collector file: ${CONF}`);
  process.exit(1);
}
const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const newestRow = maxBy(rows, (r) => r.ts);
const oldestRow = minBy(rows, (r) => r.ts);

/** The rows a cache can resolve: those with at least one bar after them. */
function resolvableRows(cache) {
  let count = 0;
  const perPair = new Map();
  for (const r of rows) {
    const b = barList(cache[r.pair]);
    if (!b) continue;
    const i = b.findIndex((x) => x.t > r.ts);
    if (i < 0) continue;
    count++;
    perPair.set(r.pair, (perPair.get(r.pair) ?? 0) + 1);
  }
  return { count, perPair };
}

const report = [];
for (const spec of CACHES) {
  const p = join(SCRATCH, spec.file);
  if (!existsSync(p)) {
    report.push({ file: spec.file, note: spec.note, missing: true });
    continue;
  }
  let cache;
  try {
    cache = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    report.push({ file: spec.file, note: spec.note, unreadable: String(e.message) });
    continue;
  }
  // A pair can be present but carry NO bars, so the filter must check
  // the array is not empty — not just that it exists.
  const pairs = Object.keys(cache).filter((k) => {
    const b = barList(cache[k]);
    return Array.isArray(b) && b.length > 0;
  });
  let newest = 0;
  let stale = 0;
  for (const k of pairs) {
    const b = barList(cache[k]);
    newest = Math.max(newest, b[b.length - 1].t);
    if (b[b.length - 1].t < newestRow - STALE_MS) stale++;
  }
  const { count: resolvable, perPair } = resolvableRows(cache);
  const armPairs = new Set(
    rows
      .filter((r) => {
        const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
        const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
        return r.tapeSide && j && l && j === l && r.tapeSide === j;
      })
      .map((r) => r.pair),
  );
  const armResolvable = [...armPairs].reduce((s, k) => s + (perPair.get(k) ?? 0), 0);
  // The stale pairs SPLIT by whether a study reads them. The refresher
  // covers the ARM's pairs exactly, so the arm can be current while
  // the rest of the cache is months behind — and a verdict that says
  // "the cache is stale" without that split sends the operator
  // refreshing pairs nothing reads.
  const staleArm = [];
  const staleUnused = [];
  for (const k of pairs) {
    const b = barList(cache[k]);
    if (b[b.length - 1].t >= newestRow - STALE_MS) continue;
    (armPairs.has(k) ? staleArm : staleUnused).push(k);
  }
  report.push({
    file: spec.file,
    note: spec.note,
    pairs: pairs.length,
    stalePairs: stale,
    staleArmPairs: staleArm.length,
    staleUnusedPairs: staleUnused.length,
    newestBar: newest,
    lagMs: newestRow - newest,
    resolvableRows: resolvable,
    totalRows: rows.length,
    armPairs: armPairs.size,
    armResolvable,
  });
}

if (AS_JSON) {
  console.log(JSON.stringify({ newestRow, oldestRow, rows: rows.length, caches: report }, null, 1));
  process.exit(0);
}

const fmtT = (ms) => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fmtLag = (ms) => (ms <= 0 ? "AHEAD" : `${Math.round(ms / 60000)} min behind`);

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE BAR-CACHE COVERAGE CHECK");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the collector: ${rows.length} rows, ${fmtT(oldestRow)} to ${fmtT(newestRow)}`);
console.log(`a cache is stale for a pair when its newest bar is more than ${STALE_MS / 60000} min behind the collector`);
console.log("");
console.log("  cache                          the pairs  the stale  the newest  the lag      the rows it can resolve");
console.log("  " + "-".repeat(100));
for (const r of report) {
  if (r.missing) {
    console.log(`  ${r.file.padEnd(30)} MISSING`);
    continue;
  }
  if (r.unreadable) {
    console.log(`  ${r.file.padEnd(30)} UNREADABLE: ${r.unreadable}`);
    continue;
  }
  const flag = r.staleArmPairs > 0 ? "  <- THE ARM IS STALE" : r.stalePairs > 0 ? "  (the unused pairs are behind)" : "";
  console.log(
    `  ${r.file.padEnd(30)} ${String(r.pairs).padStart(6)}  ${String(r.stalePairs).padStart(7)}  ` +
      `${fmtT(r.newestBar).padStart(10)}  ${fmtLag(r.lagMs).padStart(10)}   ` +
      `${String(r.resolvableRows).padStart(5)} of ${r.totalRows}  (the arm: ${r.armResolvable})${flag}`,
  );
}
console.log("");

// THE VERDICT
const staleCaches = report.filter((r) => !r.missing && !r.unreadable && r.stalePairs > 0);
const armCaches = report.filter((r) => !r.missing && !r.unreadable && r.armPairs > 0);
console.log("════════════════════════════════════════════════════════════════════");
console.log("THE VERDICT");
console.log("════════════════════════════════════════════════════════════════════");
const staleArmCaches = report.filter((r) => !r.missing && !r.unreadable && r.staleArmPairs > 0);
if (!staleArmCaches.length) {
  console.log("  Every cache the STUDIES READ reaches the collector's newest row.");
  console.log("");
  const unused = report.filter((r) => !r.missing && !r.unreadable && r.staleUnusedPairs > 0);
  if (unused.length) {
    console.log("  The remaining pairs in these caches are behind, but NO STUDY READS");
    console.log("  THEM: the refresher covers the live-gate arm's pairs exactly, and");
    console.log("  those are current. The unused pairs are kept for the wider studies");
    console.log("  (the family study, the cross-sectional work) and can be refreshed on");
    console.log("  demand with:");
    console.log("    node research/refresh-bars.mjs --pairs <PAIR,PAIR,...>");
  }
} else {
  console.log(`  ${staleArmCaches.length} of ${report.length} caches are STALE FOR THE ARM:`);
  for (const r of staleArmCaches) {
    console.log(`    ${r.file.padEnd(30)} ${r.staleArmPairs} arm pairs are behind`);
  }
  console.log("");
  console.log("  A study that reads a stale cache measures a BIASED sample: the rows it");
  console.log("  cannot resolve are the most recent ones, and the losers resolve LATER");
  console.log("  than the winners. That flatters the strategy, and it is how a");
  console.log("  90-95% win rate and a 22-trade sample once looked like a finding.");
  console.log("");
  console.log("  FIX: node research/refresh-bars.mjs  (the 15-minute cache)");
  console.log("  and report the cache's coverage beside any result computed on it.");
}
console.log("");
for (const r of armCaches) {
  if (r.armResolvable < r.totalRows * 0.5) {
    console.log(`  NOTE: ${r.file} resolves only ${r.armResolvable} of the arm's rows.`);
  }
}
console.log("════════════════════════════════════════════════════════════════════");
