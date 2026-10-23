#!/usr/bin/env node
/**
 * THE TAPE THRESHOLDS MUST NOT DRIFT.
 *
 * The collector and the analyzer both read the tape's signal from
 * `research/tape-signal.mjs`, because the study is only meaningful if it
 * measures the state the LIVE PATH acts on.
 *
 * The live path's thresholds live in the CLI's TypeScript source
 * (`src/kucoin.ts`, `fadeSignal` / `dipSignal`). The .mjs module is a
 * PORT of that logic, and a port is where drift happens: someone
 * changes the CLI's threshold and the study keeps measuring the old
 * one, silently.
 *
 * So this test PARSES the TypeScript source and compares the literal
 * thresholds against the .mjs module's behaviour. It fails loudly when
 * they differ.
 *
 * Run: node research/test-tape-drift.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fadeSignal, dipSignal, tapeSideOf } from "./tape-signal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "kucoin.ts");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const src = readFileSync(CLI, "utf8");

// ── the thresholds, read out of the TypeScript source ────────────────────
const fade = src.match(/export function fadeSignal[\s\S]*?\n\}/)?.[0] ?? "";
const dip = src.match(/export function dipSignal[\s\S]*?\n\}/)?.[0] ?? "";
check("found fadeSignal in src/kucoin.ts", fade.length > 0);
check("found dipSignal in src/kucoin.ts", dip.length > 0);

const num = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : NaN;
};

// The vratio threshold, the off-high threshold and the off-low threshold.
const fadeVratio = num(fade, /vratio\s*<\s*([\d.]+)/);
const fadeOffHigh = num(fade, /offHighPct\s*<\s*([\d.]+)/);
const fadeOffHighLate = num(fade, /offHighPct\s*>\s*([\d.]+)/);
const dipVratio = num(dip, /vratio\s*<\s*([\d.]+)/);
const dipOffLow = num(dip, /offLowPct\s*<\s*([\d.]+)/);
const dipOffLowExt = num(dip, /offLowPct\s*>\s*([\d.]+)/);
const strongVratio = num(fade, /vratio\s*>\s*([\d.]+)/);

check("read the fade vratio threshold", Number.isFinite(fadeVratio), `${fadeVratio}`);
check("read the fade offHigh threshold", Number.isFinite(fadeOffHigh), `${fadeOffHigh}`);
check("read the dip vratio threshold", Number.isFinite(dipVratio), `${dipVratio}`);
check("read the dip offLow threshold", Number.isFinite(dipOffLow), `${dipOffLow}`);

// ── the .mjs module's behaviour must match those thresholds ─────────────
//
// Each case is built from the TypeScript's OWN numbers, so a change in
// the CLI moves the expected result and the .mjs module has to follow.

const probe = (vratio, offHighPct, offLowPct) => ({
  offHighPct,
  offLowPct,
  vratio,
});
/** A market far off its high and near its low: the dip geometry. */
const pureDipProbe = () => probe(dipVratio - 0.01, fadeOffHigh + 2, dipOffLow - 0.5);

// fade-short: vratio < fadeVratio AND offHighPct < fadeOffHigh
check(
  "a faded near-high tape is fade-short",
  fadeSignal(probe(fadeVratio - 0.01, fadeOffHigh - 0.5, 0)) === "fade-short",
  `got ${fadeSignal(probe(fadeVratio - 0.01, fadeOffHigh - 0.5, 0))}`,
);
check(
  "a faded tape far from the high is NOT fade-short",
  fadeSignal(probe(fadeVratio - 0.01, fadeOffHigh + 0.5, 0)) !== "fade-short",
);
check(
  "a live volume tape is NOT fade-short",
  fadeSignal(probe(fadeVratio + 0.01, fadeOffHigh - 0.5, 0)) !== "fade-short",
);
check(
  "a very extended tape is 'late'",
  fadeSignal(probe(fadeVratio - 0.01, fadeOffHighLate + 1, 0)) === "late",
);

// dip-long: vratio < dipVratio AND offLowPct < dipOffLow
check(
  "a faded near-low tape is dip-long",
  dipSignal(probe(dipVratio - 0.01, 0, dipOffLow - 0.5)) === "dip-long",
  `got ${dipSignal(probe(dipVratio - 0.01, 0, dipOffLow - 0.5))}`,
);
check(
  "a PURE dip is dip-long and not fade-short",
  dipSignal(pureDipProbe()) === "dip-long" && fadeSignal(pureDipProbe()) !== "fade-short",
);
check(
  "a faded tape far from the low is NOT dip-long",
  dipSignal(probe(dipVratio - 0.01, 0, dipOffLow + 0.5)) !== "dip-long",
);
check(
  "a very extended tape is 'extended'",
  dipSignal(probe(dipVratio - 0.01, 0, dipOffLowExt + 1)) === "extended",
);
check(
  "exploding volume is capitulation/strong, not a fade",
  dipSignal(probe(strongVratio + 0.1, 0, 0)) === "capitulation" &&
    fadeSignal(probe(strongVratio + 0.1, 0, 0)) === "strong",
);

// ── the side, which is what the study actually measures ─────────────────
check(
  "a fade-short tape's side is 'short'",
  tapeSideOf(probe(fadeVratio - 0.01, fadeOffHigh - 0.5, 0)) === "short",
);
// A PURE dip: far enough off the high that fade-short cannot fire
// (offHighPct >= fadeOffHigh) and within dipOffLow of the low. A row
// that satisfies BOTH signals resolves to "short", because the live
// path checks fade-short first — so a dip test must exclude that case.
const pureDip = probe(dipVratio - 0.01, fadeOffHigh + 2, dipOffLow - 0.5);
check(
  "a PURE dip tape's side is 'long'",
  tapeSideOf(pureDip) === "long",
  `got ${tapeSideOf(pureDip)} (fade=${fadeSignal(pureDip)} dip=${dipSignal(pureDip)})`,
);
check(
  "a row satisfying BOTH signals resolves to short, as the live path does",
  tapeSideOf(probe(dipVratio - 0.01, 0, dipOffLow - 0.5)) === "short",
);
check(
  "a neutral tape has no side",
  tapeSideOf(probe(1.2, 2, 2)) === null,
);

// ── the collector and the analyzer must agree on the side ───────────────
//
// The collector writes `tapeSide`; the analyzer derives it from the tape
// fields for older rows. Both go through the SAME module, so the two
// readings of the same row must be identical.
const row = {
  tapeOffHighPct: fadeOffHigh - 0.5,
  tapeOffLowPct: 1,
  tapeVratio: fadeVratio - 0.01,
};
const { tapeSideFromRow } = await import("./tape-signal.mjs");
check(
  "the derived side matches the written side for a fade-short row",
  tapeSideFromRow({ ...row, tapeSide: "short" }) === "short",
);
check(
  "the derived side matches for an older row with no tapeSide",
  tapeSideFromRow(row) === "short",
  `got ${tapeSideFromRow(row)}`,
);

console.log();
if (failures > 0) {
  console.log(`DRIFT: ${failures} check(s) failed — the .mjs tape thresholds no longer match src/kucoin.ts.`);
  process.exit(1);
}
console.log("No drift: research/tape-signal.mjs matches src/kucoin.ts.");
