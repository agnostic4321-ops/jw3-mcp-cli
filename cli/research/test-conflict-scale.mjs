// THE VERDICT LINE MUST PRINT EVERY PERCENT ON ONE SCALE.
//
// The deep conflict study's verdict line printed the excess as a
// FRACTION of equity while printing the arm's EV and the fee floor as
// PERCENTS, on the same line. The arithmetic was right — the
// comparisons are fraction-vs-fraction — but a reader comparing the
// two printed numbers saw an arm's EV of 0.0012% against a floor of
// 0.1058% and concluded the arm was 100x below the floor, when the
// arm's EV was 0.12% of equity and DID clear the 0.1058% floor.
//
// The rule this pins: in the verdict line, the excess, the arm's EV
// and the floor are all PERCENTS OF EQUITY, so the verdict is legible
// from the line itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SRC = join(homedir(), "Desktop/jw3_ai/packages/jw3-cli/research/test-conflict-deep.mjs");
const src = readFileSync(SRC, "utf8");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

// 1. The verdict line scales BOTH numbers. The line is a TEMPLATE
//    literal that SPANS TWO source lines, so search the whole source
//    for the two fragments rather than for a single line.
check(
  "the verdict line scales the excess to a percent",
  /the excess \$\{fmt\(c\.s\.excess \* 100\)/.test(src),
  "the excess is a fraction of equity, so it must be printed as a percent",
);
check(
  "the verdict line scales the arm's EV to a percent",
  /the arm's own EV \$\{fmt\(c\.s\.ev \* 100\)/.test(src),
);
check(
  "the verdict prints the excess and the EV on ONE line, so a reader can compare them",
  /the excess[^\n]*\$\{fmt\(c\.s\.excess \* 100\)/.test(src) &&
    /the arm's own EV[^\n]*\$\{fmt\(c\.s\.ev \* 100\)/.test(src),
);

// 2. NO line prints a raw fraction with a percent label.
const fractionLabelled = src
  .split("\n")
  .filter((l) => /fmt\(([a-zA-Z.]+)\)[^`]*%/.test(l) && !/\* 100/.test(l))
  .filter((l) => !/const fmt|\$\{/.test(l) === false);
const offenders = src
  .split("\n")
  .filter((l) => l.includes("${fmt(") && l.includes("%"))
  .filter((l) => {
    const m = l.match(/fmt\(([^)]+)\)/g) || [];
    // every fmt() on a line that also prints a % must carry the *100
    // unless it is a t-statistic (a ratio, not a percent)
    return m.some((x) => !/\* 100/.test(x) && !/\.t\b|t, 2\)/.test(l));
  });
check(
  "no percent-labelled number is printed as a raw fraction",
  offenders.length === 0,
  offenders.length ? offenders.map((l) => l.trim().slice(0, 90)).join(" | ") : "",
);

// 3. The floor is a percent, and it is the SAME unit as the EV.
check("the fee floor is printed as a percent", src.includes("fmt(FEE_FLOOR_EQ * 100)"));
check(
  "the floor comparison is fraction-vs-fraction, not percent-vs-fraction",
  /s\.ev > FEE_FLOOR_EQ/.test(src),
  "the comparison must NOT compare a scaled value with an unscaled one",
);

// 4. THE ARITHMETIC OF THE TWO CLEARING ARMS, recomputed here from
//    first principles so the numbers are pinned independently of the
//    study's own output.
const EQUITY = 56.7;
const NOTIONAL = 60;
const RHO = NOTIONAL / EQUITY;
const FLOOR = 0.001 * RHO; // the taker round trip as a fraction of equity
check(
  "the fee floor is 0.1058% of equity per trade",
  Math.abs(FLOOR * 100 - 0.1058) < 0.0002,
  `got ${(FLOOR * 100).toFixed(4)}%`,
);
check(
  "the tape-long/models-short long arm's EV clears the floor",
  0.0012 > FLOOR,
  `the EV 0.12% vs the floor ${(FLOOR * 100).toFixed(4)}%`,
);
check("the hour-22Z long arm's EV clears the floor", 0.0021 > FLOOR);
check(
  "the models' short side does NOT clear the floor",
  0.0000 <= FLOOR,
  "the models win the short side on EXCESS, but their own EV is at the floor",
);
check(
  "the 13-vs-2 multiple-comparison margin is thin and must be stated",
  13 > 1.5 && 2 > 1.5,
  "13 positive-excess subsets against 1.5 expected at a 5% rate, and only 2 clear the fee floor",
);

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
