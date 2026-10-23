#!/usr/bin/env node
/**
 * THE REPLICATION HARNESS'S OWN TESTS.
 *
 * A replication is only worth its result if the harness is correct. So
 * the harness is tested against cases with KNOWN answers, and against
 * the machine's own recorded output.
 *
 * 1. THE PORTS reproduce the machine's own rows (the Laya bridge on
 *    100% of the collector's recorded rows).
 * 2. THE TICKET SIMULATION resolves a known geometry correctly: a bar
 *    that touches only the target is a win, only the stop is a loss, and
 *    a bar that touches BOTH is a loss (the conservative tie).
 * 3. THE TIME EXIT fires when neither level is reached.
 * 4. THE CLUSTER STATISTICS collapse correlated rows: a set of rows
 *    that are all identical in one bucket must produce ONE cluster and
 *    a zero standard error, and a set spread over many buckets must
 *    produce a t-statistic that reflects the buckets, not the rows.
 * 5. THE DIRECTION-MATCHED EXCESS equals the weighted sum of its
 *    per-direction parts, and it is NOT the pooled excess when the arms
 *    have different direction mixes.
 * 6. THE BARS-LOOKUP GUARD catches a mismatched key, so a broken
 *    harness can never be reported as a null.
 *
 * Run: node research/rep-test-harness.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { layaVerdict, outcome, clusterStats, fadeMetrics } from "./rep-venue-common.mjs";
import { measure, measureDirectionMatched, auditBarLookup, GEOMETRIES } from "./rep-measure.mjs";
import { buildArms } from "./rep-arms.mjs";

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SCRATCH = join(homedir(), ".hermes/cache/scratch");

// ── 1. THE PORTS against the machine's own recorded output ────────────
console.log("\n  1. THE PORTS vs the machine's own recorded rows");
{
  const rows = readFileSync(join(SCRATCH, "rep-confluence.parent-snap.ndjson"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let ok = 0, bad = 0;
  for (const r of rows) {
    if (r.tapeChg == null) continue;
    const v = layaVerdict({
      chg: r.tapeChg, atrPct: r.tapeAtrPct,
      jevSide: r.jevSide && r.jevSide !== "flat" ? r.jevSide : null,
      jevAgreement: r.jevAgreement, jevUncertain: r.jevUncertain,
      imb: r.bookImbalance, sprBps: r.spreadBps,
    });
    if (v.choice === r.layaSide) ok++; else bad++;
  }
  check(`the Laya port reproduces all ${ok + bad} recorded rows`, bad === 0, `${bad} mismatches`);
}

// ── 2 & 3. THE TICKET SIMULATION ───────────────────────────────────────
console.log("\n  2. THE TICKET SIMULATION");
{
  const T = 1_000_000;
  // A bar that rises to +1% (touches a 0.5% target) and never falls to
  // -1% (never touches a 1.2% stop) -> a WIN.
  const winBars = [
    { t: T, h: 1010, l: 999, c: 1005 },
    { t: T + 1, h: 1005, l: 998, c: 1000 },
  ];
  check("a bar that touches only the target is a win",
    outcome(winBars, T - 1, 1000, 0.5, 1.2, true, 16) === "win");
  // A bar that falls to -2% (touches the stop) and never rises to +1%.
  const lossBars = [
    { t: T, h: 1001, l: 980, c: 985 },
    { t: T + 1, h: 990, l: 984, c: 986 },
  ];
  check("a bar that touches only the stop is a loss",
    outcome(lossBars, T - 1, 1000, 0.5, 1.2, true, 16) === "loss");
  // A bar that touches BOTH -> a LOSS (the conservative tie).
  const ambBars = [
    { t: T, h: 1010, l: 980, c: 995 },
    { t: T + 1, h: 1000, l: 995, c: 998 },
  ];
  check("a bar that touches BOTH is a loss (the conservative tie)",
    outcome(ambBars, T - 1, 1000, 0.5, 1.2, true, 16) === "loss");
  // Neither level reached -> a TIME EXIT at the horizon's close.
  const flatBars = [
    { t: T, h: 1002, l: 998, c: 1000 },
    { t: T + 1, h: 1001, l: 999, c: 1000 },
  ];
  const te = outcome(flatBars, T - 1, 1000, 0.5, 1.2, true, 16);
  check("neither level reached is a TIME EXIT at the mark",
    te && typeof te === "object" && te.kind === "time" && Math.abs(te.movePct) < 1e-9,
    JSON.stringify(te));
  // A SHORT is the mirror: the target is BELOW.
  check("a short's target is below the entry",
    outcome([{ t: T, h: 1001, l: 990, c: 995 }], T - 1, 1000, 0.5, 1.2, false, 16) === "win");
  // The hold window is respected: a target touched AFTER the window is
  // a time exit, not a win.
  const lateBars = [
    { t: T, h: 1001, l: 999, c: 1000 },
    { t: T + 1, h: 1001, l: 999, c: 1000 },
    { t: T + 2, h: 1100, l: 999, c: 1090 },
  ];
  const late = outcome(lateBars, T - 1, 1000, 0.5, 1.2, true, 2);
  check("a target touched after the hold window is a time exit, not a win",
    late && typeof late === "object" && late.kind === "time", JSON.stringify(late));
}

// ── 4. THE CLUSTER STATISTICS ──────────────────────────────────────────
console.log("\n  4. THE CLUSTER STATISTICS");
{
  // Ten identical rows in ONE bucket: one cluster, zero variance.
  const vals = Array(10).fill(0.5);
  const buckets = Array(10).fill(0);
  const c = clusterStats(vals, buckets);
  check("ten rows in one bucket are ONE cluster", c.clusters === 1, `got ${c.clusters}`);
  check("ten identical rows have a zero standard error", c.se === 0, `got ${c.se}`);
  // The SAME ten rows spread over ten buckets: ten clusters, and the
  // standard error is the row-level one divided by sqrt(10).
  const c2 = clusterStats(vals, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  check("the same ten rows in ten buckets are TEN clusters", c2.clusters === 10, `got ${c2.clusters}`);
  check("ten buckets of identical rows have a zero standard error", c2.se === 0, `got ${c2.se}`);
  // Different values in ten buckets -> a real standard error.
  const spread = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const c3 = clusterStats(spread, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  check("spread values in ten buckets have a positive standard error", c3.se > 0, `got ${c3.se}`);
  // THE POINT OF THE CLUSTER CORRECTION: when the rows inside a bucket
  // are IDENTICAL (perfect within-bucket correlation), the row-level
  // standard error treats 100 rows as 100 INDEPENDENT samples and
  // therefore UNDERSTATES the uncertainty by sqrt(cluster size). The
  // clustered standard error is the honest one, and it is LARGER.
  const correlated = [];
  const cBuckets = [];
  for (let b = 0; b < 10; b++) {
    for (let i = 0; i < 10; i++) { correlated.push(b); cBuckets.push(b); }
  }
  const m = correlated.reduce((a, b) => a + b, 0) / correlated.length;
  const rowSe = Math.sqrt(correlated.reduce((s, x) => s + (x - m) ** 2, 0) / (correlated.length - 1) / correlated.length);
  const clSe = clusterStats(correlated, cBuckets).se;
  check("the clustered standard error is LARGER than the row-level one when rows within a bucket are identical",
    clSe > rowSe, `clustered ${clSe} vs row ${rowSe}`);
  check("the inflation is about sqrt(cluster size)",
    Math.abs(clSe / rowSe - Math.sqrt(10)) / Math.sqrt(10) < 0.2,
    `ratio ${(clSe / rowSe).toFixed(3)} vs sqrt(10) ${Math.sqrt(10).toFixed(3)}`);
}

// ── 5. THE DIRECTION-MATCHED EXCESS ────────────────────────────────────
console.log("\n  5. THE DIRECTION-MATCHED EXCESS");
{
  // A synthetic cache: a flat price with a stop hit immediately, so the
  // arms have a known outcome.
  const T = 1_700_000_000_000;
  const CACHE = {
    "A/USDT": Array.from({ length: 40 }, (_, i) => ({ t: T + i * 900_000, h: 100, l: 99, c: 99.5 })),
    "B/USDT": Array.from({ length: 40 }, (_, i) => ({ t: T + i * 900_000, h: 100, l: 99, c: 99.5 })),
  };
  const mk = (pair, dir, ts, chg) => ({
    pair, dir, ts, tapeChg: chg, tapeAtrPct: 1, tapeOffHighPct: 2, tapeOffLowPct: 2,
  });
  // The signal arm: 3 longs and 1 short. The unconditional arm: 3 longs
  // and 9 shorts. DIFFERENT MIXES on purpose.
  const signal = [
    mk("A/USDT", "long", T + 1_000_000, 1),
    mk("A/USDT", "long", T + 301_000_000, 1),
    mk("A/USDT", "long", T + 601_000_000, 1),
    mk("B/USDT", "short", T + 901_000_000, -1),
  ];
  const uncond = [
    ...signal,
    ...Array.from({ length: 8 }, (_, i) => mk("B/USDT", "short", T + (1_000_000 + i * 300_000_000), -1)),
  ];
  const g = GEOMETRIES[1];
  const pooled = measure(signal, uncond, g, CACHE, { takerRt: 0.12 });
  const dm = measureDirectionMatched(signal, uncond, g, CACHE, { takerRt: 0.12 });
  const weighted = dm.parts.reduce((s, p) => s + p.weight * p.excess, 0);
  check("the direction-matched excess is the weighted sum of its parts",
    Math.abs(weighted - dm.excess) < 1e-12, `${weighted} vs ${dm.excess}`);
  const L = dm.parts.find((p) => p.dir === "long");
  const S = dm.parts.find((p) => p.dir === "short");
  check("the long part's weight is the signal arm's long share", Math.abs(L.weight - 0.75) < 1e-12, `${L.weight}`);
  check("the short part's weight is the signal arm's short share", Math.abs(S.weight - 0.25) < 1e-12, `${S.weight}`);
  check("the direction-matched excess DIFFERS from the pooled excess here",
    Math.abs(dm.excess - pooled.excess) > 1e-12,
    `dir-matched ${dm.excess} pooled ${pooled.excess}`);
}

// ── 6. THE BARS-LOOKUP GUARD ───────────────────────────────────────────
console.log("\n  6. THE BARS-LOOKUP GUARD");
{
  const obs = [{ pair: "A/USDT", ts: 1000 }];
  const good = { "A/USDT": [{ t: 0, h: 1, l: 1, c: 1 }, { t: 2000, h: 1, l: 1, c: 1 }] };
  const bad = { A: [{ t: 0, h: 1, l: 1, c: 1 }, { t: 2000, h: 1, l: 1, c: 1 }] };
  check("the guard passes a matching, covering cache", auditBarLookup(obs, good).ok);
  const a = auditBarLookup(obs, bad);
  check("the guard FAILS a mismatched key", !a.ok, JSON.stringify(a.problems));
  const noForward = { "A/USDT": [{ t: 0, h: 1, l: 1, c: 1 }] };
  const b = auditBarLookup(obs, noForward);
  check("the guard FAILS a cache with no forward bar", !b.ok, JSON.stringify(b.problems));
}

// ── 7. THE TAPE PORT is scale-invariant ───────────────────────────────
console.log("\n  7. THE TAPE PORT");
{
  const closes = [], vols = [], highs = [], lows = [];
  for (let i = 0; i < 40; i++) { const c = 100 + Math.sin(i / 3) * 5; closes.push(c); vols.push(100 + i * 3); highs.push(c + 0.5); lows.push(c - 0.5); }
  const a = fadeMetrics(closes, vols, highs, lows);
  const S = 1000;
  const b = fadeMetrics(closes.map((c) => c * S), vols, highs.map((h) => h * S), lows.map((l) => l * S));
  const close = (x, y) => Math.abs(x - y) < 1e-9;
  check("the tape is invariant to the 1000x contract's price scale",
    close(a.chg, b.chg) && close(a.vratio, b.vratio) && close(a.offHighPct, b.offHighPct) && close(a.offLowPct, b.offLowPct) && close(a.atrPct, b.atrPct),
    `chg ${a.chg}/${b.chg} vratio ${a.vratio}/${b.vratio}`);
}

console.log();
if (failures > 0) {
  console.log(`FAILED: ${failures} check(s) failed — the harness is not trustworthy, and no result from it may be reported.`);
  process.exit(1);
}
console.log("All harness checks passed — the replication's instrument is sound.");
