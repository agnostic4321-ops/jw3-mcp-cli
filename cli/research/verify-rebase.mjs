#!/usr/bin/env node
/**
 * Verify the REBASE on the next live trade.
 *
 * The rebase (7b810964) keeps the exit legs' DISTANCE from the
 * reference and re-applies it to the ACTUAL fill. The first trade
 * after it (14:45) still closed one tick below its entry, because the
 * fill price could not be read the instant the order id came back —
 * so the rebase did not run and the take-profit sat at its
 * reference-derived price, which was on the wrong side of the fill.
 *
 * The fix (d2688425) polls for the fill, and drops the take-profit
 * (keeping the stop) when the fill still cannot be read.
 *
 * So the next live trade is the test. This watcher waits for it and
 * checks the geometry:
 *
 *   the exit must be on the CORRECT side of the fill
 *     - a short's take-profit BELOW its entry
 *     - a long's take-profit ABOVE its entry
 *
 * and, when the fill is known, the exit must be AT the rebased target
 * (the reference's distance re-applied to the fill), not at the
 * reference-derived price.
 *
 * Run: node research/verify-rebase.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LOG = join(HOME, ".hermes/cache/scratch/trade-loop.ndjson");
const FIX_DEPLOYED_MS = 1792579803000; // the polling fill-read fix

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readRows = () =>
  readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const fired = readRows().filter((d) => d.event === "FIRED");
const after = fired.filter((d) => (d.ts ?? 0) > FIX_DEPLOYED_MS);
if (after.length === 0) {
  console.log("[rebase] no trade yet since the fix was deployed — waiting");
  process.exit(2);
}

const d = after[after.length - 1];
const tk = d.ticket ?? {};
const sz = tk.sizing ?? {};
const ref = Number(sz.entryPrice);
const sl = Number(sz.stopPrice);
const tp = Number(sz.targetPrice);
const side = d.side;
const isLong = side === "long";

console.log(`[rebase] trade at ${new Date(d.ts).toISOString()} — ${d.pair} ${side}`);
console.log(`[rebase]   reference entry ${ref}  stop ${sl}  target ${tp}`);
console.log(`[rebase]   orderId ${d.orderId}`);

const stopDist = isLong ? ref - sl : sl - ref;
const targetDist = isLong ? tp - ref : ref - tp;
console.log(`[rebase]   stop distance ${stopDist.toFixed(6)}  target distance ${targetDist.toFixed(6)}`);

// The venue's fill and exit come from the fills the CLI reads. The
// loop's log does not carry them, so read the venue.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const run = promisify(execFile);
const readVenue = async (args) => {
  const { stdout } = await run("env", ["-u", "JW3_CONFIG_HOME", "jw3", ...args], { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
};

let fills = [];
try {
  fills = (await readVenue(["fills", "--exchange", "kucoin", "--market", "futures", "--days", "1", "--limit", "50", "--json"])).fills ?? [];
} catch (e) {
  console.log(`[rebase] the venue fills could not be read: ${e.message}`);
  process.exit(3);
}

const mine = fills.filter((f) => f.orderId === d.orderId);
if (mine.length === 0) {
  console.log("[rebase] the entry order has no fills in the venue's recent history — it may be too old to be in the window");
  process.exit(4);
}
const entryFill = mine[0];
const fill = Number(entryFill.price);
const qty = Number(entryFill.qty);
console.log(`[rebase]   ACTUAL fill ${fill} (qty ${qty})`);

// The rebased target and stop.
const rebasedTp = isLong ? fill + targetDist : fill - targetDist;
const rebasedSl = isLong ? fill - stopDist : fill + stopDist;
console.log(`[rebase]   rebased target ${rebasedTp.toFixed(6)}  rebased stop ${rebasedSl.toFixed(6)}`);

// The exit leg's fills.
const exitOrder = fills.find((f) => f.orderId && f.orderId !== d.orderId && f.symbol === d.pair && Number(f.execTime) > entryFill.execTime);
if (!exitOrder) {
  console.log("[rebase] no exit fill found — the position may still be open");
  process.exit(5);
}
const exit = Number(exitOrder.price);
const exitSide = exitOrder.side;
console.log(`[rebase]   exit ${exit} (${exitSide})`);

// ── THE CHECKS ──
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// 1. The exit must be on the correct side of the fill for the side.
if (isLong) {
  check("the exit is ABOVE the fill (a long's take-profit)", exit > fill, `exit ${exit} vs fill ${fill}`);
} else {
  check("the exit is BELOW the fill (a short's take-profit)", exit < fill, `exit ${exit} vs fill ${fill}`);
}

// 2. The exit must be at the REBASED target, not the reference-derived
//    one. (The reference-derived target is the wrong side of the fill
//    when the fill came in better — which is the bug.)
const refTarget = tp;
const distToRebased = Math.abs(exit - rebasedTp);
const distToReference = Math.abs(exit - refTarget);
check(
  "the exit is at the REBASED target, not the reference-derived one",
  distToRebased < distToReference,
  `rebased ${rebasedTp.toFixed(6)} (${distToRebased.toFixed(6)}) vs reference ${refTarget.toFixed(6)} (${distToReference.toFixed(6)})`,
);

// 3. The exit must NOT be at the reference-derived target when that
//    price is on the wrong side of the fill.
const refTargetWrongSide = isLong ? refTarget < fill : refTarget > fill;
check(
  "the reference-derived target was NOT used (it is on the wrong side of the fill)",
  !refTargetWrongSide || distToRebased < distToReference,
  `the reference target ${refTarget} is on the wrong side of the fill ${fill}`,
);

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed — the rebase did not take effect.`);
  process.exit(1);
}
console.log("The rebase took effect: the exit is on the correct side of the fill and at the rebased target.");
