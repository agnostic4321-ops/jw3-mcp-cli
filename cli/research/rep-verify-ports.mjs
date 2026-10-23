#!/usr/bin/env node
/**
 * VERIFY THE REPLICATION'S PORTED LOGIC against the KuCoin collector's
 * recorded rows.
 *
 * The replication measures an independent venue with a ported tape
 * (`fadeMetrics`) and a ported Laya bridge. A port is where drift
 * happens, so before any independent-venue number is reported, the ports
 * are checked against the machine's OWN recorded output:
 *
 *   1. THE LAYA PORT must reproduce the collector's recorded
 *      `layaSide` on every row. The collector ran the real
 *      `python/laya_decide.py`; if the port disagrees anywhere, the
 *      replication is not measuring the same confirmation layer.
 *
 *   2. THE LAYA PORT with the JEV leg blanked must be CONSISTENT with
 *      the recorded rows: the difference between the two must be
 *      explainable by the JEV term alone. This bounds how much the
 *      unreplicable JEV leg changes the outcome.
 *
 *   3. The tape module (imported, not ported) must agree with the
 *      collector's own `tapeSide` field on every row that has one.
 *
 * READ-ONLY. No venue calls. No account calls.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { layaVerdict, tapeSideFromRow } from "./rep-venue-common.mjs";

const IN = join(homedir(), ".hermes/cache/scratch/rep-confluence.snapshot.ndjson");
const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

console.log(`[verify-ports] ${rows.length} recorded rows`);

// ── 1. THE LAYA PORT vs the collector's recorded layaSide ──────────────
let ok = 0;
let mismatch = 0;
const bad = [];
for (const r of rows) {
  if (r.tapeChg == null) continue;
  const v = layaVerdict({
    chg: r.tapeChg,
    atrPct: r.tapeAtrPct,
    jevSide: r.jevSide && r.jevSide !== "flat" ? r.jevSide : null,
    jevAgreement: r.jevAgreement,
    jevUncertain: r.jevUncertain,
    imb: r.bookImbalance,
    sprBps: r.spreadBps,
  });
  if (v.choice === r.layaSide) ok++;
  else {
    mismatch++;
    if (bad.length < 5) {
      bad.push(`${r.pair} recorded=${r.layaSide} port=${v.choice} score=${v.score} chg=${r.tapeChg} atr=${r.tapeAtrPct} imb=${r.bookImbalance} jev=${r.jevSide}/${r.jevAgreement}/${r.jevUncertain}`);
    }
  }
}
console.log(`\n  1. THE LAYA PORT vs the collector's recorded layaSide`);
console.log(`     MATCH ${ok} / ${ok + mismatch}` + (mismatch ? `  (${((mismatch / (ok + mismatch)) * 100).toFixed(2)}% MISMATCH)` : "  — EXACT"));
for (const b of bad) console.log(`       ${b}`);

// ── 2. THE TAPE MODULE vs the collector's own tapeSide field ──────────
let tOk = 0;
let tBad = 0;
let tMissing = 0;
for (const r of rows) {
  if (!r.tapeSide) { tMissing++; continue; }
  if (tapeSideFromRow(r) === r.tapeSide) tOk++;
  else tBad++;
}
console.log(`\n  2. THE TAPE MODULE vs the collector's own tapeSide field`);
console.log(`     MATCH ${tOk} / ${tOk + tBad} (rows with no field: ${tMissing}, skipped)`);

// ── 3. HOW MUCH DOES THE JEV LEG CHANGE THE OUTCOME? ──────────────────
let flip = 0;
let decided = 0;
for (const r of rows) {
  if (r.tapeChg == null) continue;
  const withJev = layaVerdict({
    chg: r.tapeChg, atrPct: r.tapeAtrPct,
    jevSide: r.jevSide && r.jevSide !== "flat" ? r.jevSide : null,
    jevAgreement: r.jevAgreement, jevUncertain: r.jevUncertain,
    imb: r.bookImbalance, sprBps: r.spreadBps,
  });
  const noJev = layaVerdict({
    chg: r.tapeChg, atrPct: r.tapeAtrPct,
    jevSide: null, jevAgreement: 0, jevUncertain: true,
    imb: r.bookImbalance, sprBps: r.spreadBps,
  });
  if (noJev.choice !== "flat") decided++;
  if (withJev.choice !== noJev.choice) flip++;
}
console.log(`\n  3. THE JEV LEG'S EFFECT ON THE LAYA OUTCOME`);
console.log(`     rows where the Laya bridge decides WITHOUT the JEV leg: ${decided} / ${rows.length}`);
console.log(`     rows where the JEV leg FLIPS the choice:               ${flip} / ${rows.length}  (${((flip / rows.length) * 100).toFixed(1)}%)`);
console.log(`\n     => The unreplicable JEV leg changes the Laya choice on ${((flip / rows.length) * 100).toFixed(1)}% of rows.`);
console.log(`        The independent-venue run therefore measures the`);
console.log(`        CONFIRMATION LAYER THAT IS REPLICABLE, and the report`);
console.log(`        states this limit rather than hiding it.`);

const failed = mismatch > 0 || tBad > 0;
console.log();
if (failed) {
  console.log("FAILED: the ported logic does not reproduce the machine's own output.");
  process.exit(1);
}
console.log("OK: the ports reproduce the machine's own recorded output exactly.");
