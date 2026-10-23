#!/usr/bin/env node
/**
 * THE CONFLUENCE ANALYZER.
 *
 * Does the live path's actual trigger — the JEV leg and the Laya leg
 * agreeing on the same side — have an edge ON ITS OWN?
 *
 * WHY THIS MATTERS
 * ----------------
 * The live path gates on a tape exhaustion AND a model confluence. The
 * tape family has been measured and is EMPTY (0/89 candidates, 0/118
 * sides with positive taker expectancy). If the tape is a filter that
 * never fires profitably, then the part doing the work is the
 * CONFLUENCE — and the confluence has never been measured.
 *
 * The two are separable, and this measures the confluence alone.
 *
 * THE CONTROLS — unchanged, and the reason this file exists:
 *   1. THE REVERSED DIRECTION on the same signals. If reversing the
 *      signal does about as well, the signal carries no information.
 *   2. THE UNCONDITIONAL BASELINE over the same symbols and windows. If
 *      simply being long earns about as much, the signal is BETA. This
 *      is the control that killed the BTC lead-lag lead and the diurnal
 *      effect, and it is the one that matters most.
 *   3. THE FEE. 0.12% taker round trip on the notional.
 *   4. THE SAMPLE SIZE. Nothing is claimed below n = 30.
 *
 * USAGE
 *   node analyze-confluence.mjs --data ~/.hermes/cache/scratch/confluence.ndjson
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n.replace(/^-+/, "")}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const DATA = flag("data", join(homedir(), ".hermes/cache/scratch/confluence.ndjson"));
const TAKER_RT = 0.12;
const MIN_N = 30;

if (!existsSync(DATA)) {
  console.error(`[confluence] no data at ${DATA} — run the collector first`);
  process.exit(1);
}

const rows = readFileSync(DATA, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const agreed = rows.filter((r) => r.agree && r.price > 0);
const rounds = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
const spanMin = (rounds[rounds.length - 1] - rounds[0]) / 60000;
console.log(
  `[confluence] ${rows.length} reads | ${agreed.length} agreements | ${rounds.length} rounds | ${spanMin.toFixed(0)} min span`,
);
if (rounds.length < 2) {
  console.log("[confluence] not enough rounds yet");
  process.exit(0);
}

// ── the forward price, from the kline history ───────────────────────────
//
// The collector records the price at the moment of the read. The
// forward price is resolved here from the klines, so a horizon change
// needs no re-collection.
import { existsSync as ex } from "node:fs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";
const KLINE_CACHE = join(homedir(), ".hermes/cache/scratch/leads/klines");
const klineCache = new Map();
const FUT = "https://api-futures.kucoin.com";

/**
 * The 1h klines for a symbol, fetched if the cache does not cover the
 * observation window.
 *
 * The cache is built from "now minus N days", so it is ALWAYS current
 * at its right edge — but a fresh observation needs bars that come
 * AFTER it, and the cache ends at "now". So a symbol whose forward
 * window is not yet in the cache is refetched, and the fresh bars are
 * MERGED into the cache.
 */
async function klines(base, needUntilMs) {
  if (klineCache.has(base)) {
    const cached = klineCache.get(base);
    if (cached && cached.length && cached[cached.length - 1][0] >= needUntilMs) return cached;
  }
  const f = join(KLINE_CACHE, `${base}USDTM_60_90.json`);
  let ks = ex(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  const lastTs = ks.length ? ks[ks.length - 1][0] : 0;
  const now = Date.now();
  if (lastTs < now - 3600_000) {
    // Refetch the last 3 days, which covers any observation in the
    // cache plus the forward window.
    const from = now - 3 * 86400_000;
    const out = [];
    let cursor = now;
    while (cursor > from && out.length < 200) {
      const hi = Math.min(cursor, now);
      const lo = Math.max(from, hi - 200 * 3600_000);
      if (hi - lo < 3600_000) break;
      const r = await fetch(`${FUT}/api/v1/kline/query?symbol=${base}USDTM&granularity=60&from=${lo}&to=${hi}`);
      const j = await r.json();
      const rows = Array.isArray(j?.data) ? j.data : [];
      if (!rows.length) break;
      out.push(...rows);
      cursor = lo - 1;
    }
    const merged = new Map();
    for (const k of ks) merged.set(k[0], k);
    for (const k of out) merged.set(k[0], k);
    ks = [...merged.values()].sort((a, b) => a[0] - b[0]);
    klineCache.set(base, ks);
  }
  return ks;
}

/** The price `bars` bars after the last bar at or before `ts`. */
async function forwardPrice(pair, ts, bars) {
  const base = (pair.split("/")[0] ?? "");
  const ks = await klines(base, ts + bars * 3600_000);
  if (!ks || !ks.length) return null;
  let idx = -1;
  for (let i = 0; i < ks.length; i++) {
    if (ks[i][0] <= ts) idx = i;
    else break;
  }
  if (idx < 0 || idx + bars >= ks.length) return null;
  const p0 = ks[idx][4];
  const p1 = ks[idx + bars][4];
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return { ret: ((p1 - p0) / p0) * 100, bars };
}

// ── the measurement ─────────────────────────────────────────────────────
function stat(xs) {
  if (!xs.length) return { n: 0, mean: 0, se: 0, win: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return {
    n: xs.length,
    mean: m,
    se: sd / Math.sqrt(xs.length),
    win: (xs.filter((x) => x > 0).length / xs.length) * 100,
  };
}

async function measure(pick, label, rowsIn) {
  const arms = { signal: [], reversed: [], unconditional: [] };
  let counted = 0;
  for (const r of rowsIn) {
    if (!pick(r)) continue;
    counted++;
    for (const bars of [1, 4]) {
      const fw = await forwardPrice(r.pair, r.ts, bars);
      if (!fw) continue;
      const gross = (r.side === "long" ? fw.ret : -fw.ret) * 1; // the confluence's direction
      arms.signal.push(gross - TAKER_RT);
      arms.reversed.push(-gross - TAKER_RT);
      arms.unconditional.push(fw.ret - TAKER_RT);
    }
  }
  const s = stat(arms.signal);
  const rv = stat(arms.reversed);
  const u = stat(arms.unconditional);
  const excess = s.mean - u.mean;
  const t = s.se > 0 ? s.mean / s.se : 0;
  console.log(`\n  ${label}`);
  console.log(`    signal (the confluence's direction)  n=${String(s.n).padStart(5)}  net ${s.mean >= 0 ? "+" : ""}${s.mean.toFixed(4)}%/obs  win ${s.win.toFixed(1)}%  se ${s.se.toFixed(4)}`);
  console.log(`    REVERSED                             n=${String(rv.n).padStart(5)}  net ${rv.mean >= 0 ? "+" : ""}${rv.mean.toFixed(4)}%/obs  win ${rv.win.toFixed(1)}%`);
  console.log(`    UNCONDITIONAL long                   n=${String(u.n).padStart(5)}  net ${u.mean >= 0 ? "+" : ""}${u.mean.toFixed(4)}%/obs  win ${u.win.toFixed(1)}%`);
  console.log(`    EXCESS over the baseline: ${excess >= 0 ? "+" : ""}${excess.toFixed(4)}pp   (t=${t.toFixed(2)})`);
  const verdict =
    s.n < MIN_N ? `NOT ENOUGH DATA (n=${s.n} < ${MIN_N})`
    : excess <= 0 ? "NO EXCESS — the confluence is beta"
    : t < 2 ? "excess positive but not significant"
    : "*** EXCESS EDGE ***";
  console.log(`    => ${verdict}`);
  return { label, n: s.n, mean: s.mean, excess, t, obs: counted };
}

console.log("\n[confluence] THE TEST — trade the confluence's own direction");

const results = [];
results.push(await measure((r) => r.agree, "every agreement (JEV + Laya on the same side)", agreed));
results.push(
  measure(
    (r) => r.agree && r.jevAgreement >= 0.67,
    "agreement with JEV agreement >= 0.67",
    agreed,
  ),
);
results.push(
  measure(
    (r) => r.agree && r.layaConfidence >= 0.7,
    "agreement with Laya confidence >= 0.70",
    agreed,
  ),
);
results.push(
  measure(
    (r) => r.agree && Math.abs(r.bookImbalance ?? 0) >= 0.3,
    "agreement with |book imbalance| >= 0.30",
    agreed,
  ),
);
results.push(
  measure(
    (r) => r.agree && r.tapeChg >= 3,
    "agreement with the tape up >= 3% (the exhaustion filter)",
    agreed,
  ),
);

// The baseline: the SAME universe, WITHOUT the confluence filter. If the
// confluence adds nothing over simply trading the same symbols, it is
// not doing work.
results.push(
  measure(
    () => true,
    "BASELINE: every read, no confluence filter (the market alone)",
    rows.filter((r) => r.price > 0),
  ),
);

const viable = results.filter((r) => r.n >= MIN_N && r.excess > 0 && r.t >= 2);
console.log(`\n[confluence] VERDICT: ${viable.length} of ${results.length} variants clear the bar (n>=${MIN_N}, excess>0, t>=2)`);
if (viable.length === 0) {
  const best = results.filter((r) => r.n > 0).sort((a, b) => b.excess - a.excess)[0];
  if (best) console.log(`[confluence] Best excess: ${best.label} at ${best.excess.toFixed(4)}pp (t=${best.t.toFixed(2)}, n=${best.n}).`);
  // The most common reason for n=0 is not a bug: a FRESH observation has
  // no forward bar yet. The forward return IS the thing being measured,
  // so the newest hour of data is unmeasurable by construction.
  const newest = maxBy(rows, (r) => r.ts);
  const ageMin = (Date.now() - newest) / 60000;
  if (ageMin < 90) {
    console.log(
      `[confluence] The newest observation is ${ageMin.toFixed(0)} minutes old, so no forward bar exists for it yet.`,
    );
    console.log(`[confluence] This is not a failure: the forward return is what is being measured.`);
  }
  console.log(`[confluence] NOT ENOUGH HISTORY YET — ${rounds.length} rounds over ${spanMin.toFixed(0)} minutes.`);
  console.log(`[confluence] Re-run when there are hours (for a 1h horizon) or days (for stability) of history. The collector keeps running.`);
} else {
  for (const v of viable) console.log(`[confluence]   ${v.label}: excess ${v.excess.toFixed(4)}pp, t=${v.t.toFixed(2)}, n=${v.n}`);
}
