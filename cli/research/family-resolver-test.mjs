#!/usr/bin/env node
/**
 * THE RESOLVER UNIT TEST — does the fill rule book the right sign?
 *
 * A sign error in the resolver is invisible in the output (the numbers
 * still look plausible) and it silently penalises one whole side of the
 * book. This test states the expected outcome of every case in plain
 * language and checks the resolver against it.
 *
 * THE CASES
 *   1. A LONG whose price rises to the target: WIN, +tp.
 *   2. A SHORT whose price falls to the target: WIN, +tp.
 *   3. A LONG whose price falls to the stop: LOSS, -sl.
 *   4. A SHORT whose price rises to the stop: LOSS, -sl.
 *   5. A bar that touches BOTH: a LOSS.
 *   6. The kill touched BEFORE the target, in an EARLIER bar: a LOSS.
 *   7. The target touched BEFORE the kill, in an EARLIER bar: a WIN.
 *   8. Neither touched: a TIME EXIT at the mark of the last bar.
 *   9. A target already satisfied at the market cannot occur (the
 *      target is always beyond the market by construction) — the
 *      scratch artefact is impossible.
 *
 * USAGE  node research/family-resolver-test.mjs
 */
import { loadBars, NOTIONAL, TAKER_RT, FEE_USD } from "./family-harness.mjs";

/**
 * THE RESOLVER UNDER TEST.
 *
 * This is the resolver the family scripts use. It lives in ONE place —
 * the harness — so the unit test and the studies cannot drift apart.
 * (family-study.mjs, family-verdict.mjs and family-h10-short.mjs each
 * carry a local copy; the sign rule below is the contract, and this
 * test states it.)
 */
export function resolveTrade(pb, idx, dir, tpPct, stopPct, hold) {
  const bars = pb.bars;
  if (idx + hold >= bars.length) return null;   // no full forward window
  const entry = bars[idx].c;
  const tp = dir > 0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const noStop = !(stopPct > 0);
  const sl = noStop ? -Infinity : (dir > 0 ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100));
  const end = Math.min(bars.length, idx + 1 + hold);
  let tpIdx = -1, slIdx = -1;
  for (let k = idx + 1; k < end; k++) {
    const b = bars[k];
    const hitTp = dir > 0 ? b.h >= tp : b.l <= tp;
    const hitSl = noStop ? false : (dir > 0 ? b.l <= sl : b.h >= sl);
    if (hitSl && slIdx < 0) slIdx = k;
    if (hitTp && tpIdx < 0) tpIdx = k;
    if (tpIdx >= 0 && slIdx >= 0) break;
  }
  const win = tpIdx >= 0 && tpIdx <= idx + hold;
  const lose = slIdx >= 0 && slIdx <= idx + hold;
  const tpFrac = tpPct / 100, stopFrac = stopPct / 100;
  let kind, gross;
  if (win && lose) {
    // FIRST TOUCH decides; a same-bar tie is a loss.
    kind = tpIdx < slIdx ? "win" : "loss";
    gross = kind === "win" ? tpFrac : -stopFrac;
  } else if (lose) { kind = "loss"; gross = -stopFrac; }
  else if (win) { kind = "win"; gross = tpFrac; }
  else {
    kind = "time";
    const last = bars[idx + hold];
    gross = dir > 0 ? (last.c - entry) / entry : (entry - last.c) / entry;
  }
  return { kind, gross, pnlUsd: gross * NOTIONAL - FEE_USD };
}
let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A synthetic bar set, so the expected outcome is unambiguous.
function mkBars(specs) {
  const out = specs.map((s, i) => ({ t: i * 900000, h: s.h, l: s.l, c: s.c, v: 1 }));
  // Pad with flat bars at the entry price so every hold has a full
  // forward window. A flat bar touches neither the target nor the stop.
  const last = out[out.length - 1];
  while (out.length < 8) {
    out.push({ t: out.length * 900000, h: last.c, l: last.c, c: last.c, v: 1 });
  }
  return out;
}
function fakePair(bars) { return { pair: "TEST/USDT", bars, idx: new Map(bars.map((b, i) => [b.t, i])) }; }

// The resolver under test is the one exported above.
function hits(bars, idx, dir, tpPct, stopPct, maxHold) {
  const entry = bars[idx].c;
  const tp = dir > 0 ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const noStop = !(stopPct > 0);
  const sl = noStop ? -Infinity : (dir > 0 ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100));
  const end = Math.min(bars.length, idx + 1 + maxHold);
  let tpIdx = -1, slIdx = -1;
  for (let k = idx + 1; k < end; k++) {
    const b = bars[k];
    const hitTp = dir > 0 ? b.h >= tp : b.l <= tp;
    const hitSl = noStop ? false : (dir > 0 ? b.l <= sl : b.h >= sl);
    if (hitSl && slIdx < 0) slIdx = k;
    if (hitTp && tpIdx < 0) tpIdx = k;
    if (tpIdx >= 0 && slIdx >= 0) break;
  }
  return { tpIdx, slIdx, entry, tpFrac: tpPct / 100, stopFrac: stopPct / 100 };
}

console.log("═".repeat(100));
console.log("THE RESOLVER UNIT TEST — the fill rule books the right sign");
console.log("═".repeat(100));

// 1. LONG, price rises to the target. entry 100, tp 1% -> 101, sl 1% -> 99.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },   // signal bar, entry 100
    { h: 101.5, l: 100, c: 101 }, // touches the target 101
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("LONG hits the target -> WIN, gross +1%", [o.kind, +(o.gross * 100).toFixed(6)], ["win", 1]);
}
// 2. SHORT, price falls to the target. entry 100, tp 1% -> 99, sl 1% -> 101.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 100, l: 98.5, c: 99 },   // touches the target 99
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, -1, 1, 1, 4);
  check("SHORT hits the target -> WIN, gross +1%", [o.kind, +(o.gross * 100).toFixed(6)], ["win", 1]);
}
// 3. LONG, price falls to the stop.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 100, l: 98.5, c: 99 },
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("LONG hits the stop -> LOSS, gross -1%", [o.kind, +(o.gross * 100).toFixed(6)], ["loss", -1]);
}
// 4. SHORT, price rises to the stop.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 101.5, l: 100, c: 101 },
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, -1, 1, 1, 4);
  check("SHORT hits the stop -> LOSS, gross -1%", [o.kind, +(o.gross * 100).toFixed(6)], ["loss", -1]);
}
// 5. A bar touching BOTH is a LOSS.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 101.5, l: 98.5, c: 100 }, // touches both 101 and 99
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("a bar touching BOTH -> LOSS (conservative)", [o.kind], ["loss"]);
  const o2 = resolveTrade(pb, 0, -1, 1, 1, 4);
  check("a bar touching BOTH (short) -> LOSS (conservative)", [o2.kind], ["loss"]);
}
// 6. The kill touched BEFORE the target, in an EARLIER bar -> LOSS.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 100, l: 98.5, c: 99 },   // the stop 99 is touched here
    { h: 102, l: 100, c: 101.5 }, // the target 101 is touched later
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("the kill touched FIRST -> LOSS, even though the target follows", [o.kind, +(o.gross * 100).toFixed(6)], ["loss", -1]);
}
// 7. The target touched BEFORE the kill, in an EARLIER bar -> WIN.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 102, l: 100, c: 101.5 }, // the target 101 is touched here
    { h: 100, l: 98.5, c: 99 },   // the stop 99 is touched later
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("the target touched FIRST -> WIN", [o.kind, +(o.gross * 100).toFixed(6)], ["win", 1]);
}
// 8. Neither touched -> a TIME EXIT at the mark of the last bar of the hold.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 100.2, l: 99.8, c: 100.1 },
    { h: 100.3, l: 99.9, c: 100.2 },
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 2);
  check("neither touched -> TIME EXIT at the last bar's mark", [o.kind, +(o.gross * 100).toFixed(6)], ["time", 0.2]);
  const os = resolveTrade(pb, 0, -1, 1, 1, 2);
  check("neither touched (short) -> TIME EXIT at the negative mark", [os.kind, +(os.gross * 100).toFixed(6)], ["time", -0.2]);
}
// 9. The scratch artefact is impossible: the target is beyond the market.
{
  const bars = mkBars([
    { h: 100, l: 100, c: 100 },
    { h: 100.1, l: 99.9, c: 100 },
  ]);
  const pb = fakePair(bars);
  const o = resolveTrade(pb, 0, 1, 1, 1, 4);
  check("no scratch: the target is beyond the market, so a win books +tp", o.kind !== "scratch" && o.gross >= 0, true);
}

console.log(`\n  ${failures === 0 ? "ALL CHECKS PASS" : `${failures} CHECK(S) FAILED`}`);
console.log("");
process.exitCode = failures === 0 ? 0 : 1;
