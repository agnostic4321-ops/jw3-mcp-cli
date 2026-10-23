/**
 * THE GEOMETRY SWEEP MUST AGREE WITH THE ARM IT SWEEPS.
 *
 * The live-gate publisher prints the arm's own net EV and then a
 * geometry sweep on the SAME rows. The SHIPPED row of that sweep is
 * supposed to BE the arm's own geometry, so the two numbers must
 * agree. They did not, and the gap was invisible because the sweep
 * re-implemented the bar walk:
 *
 *   the arm's own NET EV:              -0.2390% of equity
 *   the sweep's SHIPPED geometry:        +0.0892% of equity
 *
 * FOUR defects, all in the sweep, all found by this test:
 *
 *   1. NO WRONG-SIDE CHECK. The sweep's own loop booked a target on
 *      the wrong side of the market as a FULL WIN. That is the scratch
 *      artefact: 73.5% of the arm's trades are scratches.
 *   2. THE WRONG `last`. The shared resolver reads `ticket.last` for
 *      the wrong-side check and `ticket.avgEntry` for the time exit's
 *      mark. The sweep passed `last: avgEntry`, so the check compared
 *      the target against the ENTRY ANCHOR instead of the MARKET — and
 *      since a short's anchor sits ABOVE the market, the comparison
 *      inverted and every scratch became a win. Two prices, two jobs:
 *      the MARKET decides the side, the ENTRY ANCHOR books the trade.
 *   3. THE REPORTED GEOMETRY WAS NOT THE TRADED GEOMETRY. The break-
 *      even and the printed tp%/stop% came from the FIRST row's ATR
 *      while every trade used its own ATR — so the table described a
 *      ticket that was never placed.
 *   4. DOUBLE COUNTING. A leftover from the old loop incremented the
 *      win/loss/time counters a second time, so the time share read
 *      101.1%.
 *
 * The rule this test pins: THE SWEEP'S SHIPPED ROW MUST EQUAL THE ARM'S
 * OWN EV, ON THE SAME ROWS. That is a property, not a formula, and it
 * holds whatever the geometry grows into.
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "research");
const SCRATCH = join(process.env.HOME ?? "/Users/phoenix", ".hermes/cache/scratch");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`      [PASS] ${name}`); }
  else { fail++; console.log(`      [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

const src = readFileSync(join(RES, "live-gate-ev.mjs"), "utf8");

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE GEOMETRY SWEEP MUST AGREE WITH THE ARM IT SWEEPS — the tests");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

// ── 1. THE SWEEP MUST USE THE SHARED RESOLVER, NOT ITS OWN WALK ──
console.log("1. THE SWEEP USES THE SHARED FILL RULE");
{
  check(
    "the sweep imports the shared resolver",
    /import\s*\{[^}]*resolveTicket[^}]*\}\s*from\s*"\.\/ticket-fill\.mjs"/.test(src),
    "the shared resolver is imported",
  );
  check(
    "the sweep calls the shared resolver",
    /resolveTicket\(/.test(src),
    "the shared resolver is called",
  );
  // A re-implementation of the walk is what let the rule drift.
  const ownWalk = /hitTp\s*=\s*(r\.dir|long)\s*==\s*"short"/.test(src);
  check(
    "the sweep has NO hand-rolled bar walk of its own",
    !ownWalk,
    "a hand-rolled walk can omit the wrong-side rule",
  );
  check(
    "the sweep passes BOTH anchors",
    /last:\s*t\.last/.test(src) && /avgEntry:\s*t\.avgEntry/.test(src),
    "the market price and the entry anchor are both passed",
  );
  // The check must look at the CODE, not at a word near it — and the
  // explanatory comment quotes the old broken call to document the
  // defect, so the pattern has to exclude comments.
  const codeOnly = src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").replace(/\*.*?\*\//g, ""))
    .join("\n");
  check(
    "the wrong-side check uses the MARKET price, not the entry anchor",
    !/last:\s*t\.avgEntry/.test(codeOnly),
    "passing the anchor as `last` inverts the check",
  );
  check(
    "the sweep reports the scratch share",
    /scr%/.test(src) && /scratches/.test(src),
    "a scratch is a resolved trade and it is shown",
  );
  check(
    "the sweep has no leftover double-counting",
    !/o\.k === "win"/.test(src),
    "the old loop's counters were left behind and double-counted",
  );
  check(
    "the reported geometry is the MEAN over the traded rows",
    /tpPctMean/.test(src) && /mean\(tpPcts\)/.test(src),
    "the first row's ATR is not the geometry that was traded",
  );
  check(
    "the reported geometry is not the FIRST row's ATR",
    !/liveArm\[0\]\?\.tapeAtrPct/.test(src),
    "the first row's ATR was used for every row",
  );
}

// ── 2. THE PROPERTY: THE SWIPPED ROW EQUALS THE ARM'S OWN EV ──
console.log("");
console.log("2. THE PROPERTY — the sweep's SHIPPED row equals the arm's own EV");
{
  // Run the publisher if the data is present, and compare the two
  // numbers it prints. This is the end-to-end proof; the checks above
  // are the reasons it can fail.
  const barsPath = join(SCRATCH, "fee-floor-15m-bars.json");
  const rowsPath = join(SCRATCH, "confluence.ndjson");
  if (!existsSync(barsPath) || !existsSync(rowsPath)) {
    console.log("      [SKIP] the collector data is not present — the end-to-end check needs it");
  } else {
    const { execFileSync } = await import("node:child_process");
    let out = "";
    try {
      out = execFileSync("node", [join(RES, "live-gate-ev.mjs")], { encoding: "utf8", cwd: RES });
    } catch (e) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    // the arm's own NET EV
    const armM = out.match(/the live-gate arm's NET EV:\s*(-?[\d.]+)%/);
    // the sweep's SHIPPED row: the EV column of the row tagged SHIPPED
    const shippedLine = out.split("\n").find((l) => l.includes("<- SHIPPED"));
    const sweepM = shippedLine?.match(/\|\s*(-?[\d.]+)\s*\|/);
    check("the arm's NET EV was printed", !!armM, "the arm's EV is on the output");
    check("the sweep's SHIPPED row was printed", !!shippedLine && !!sweepM, "the sweep row is on the output");
    if (armM && sweepM) {
      const arm = Number(armM[1]);
      const sweep = Number(sweepM[1]);
      check(
        "the sweep's SHIPPED EV EQUALS the arm's own EV",
        Math.abs(arm - sweep) < 0.0005,
        `the arm says ${arm}% and the sweep says ${sweep}%`,
      );
    }
    // the scratch share must be visible and non-zero — a hidden scratch
    // is how the 90-95% win rates survived for weeks.
    // the scratch share must be visible and non-zero — a hidden scratch
    // is how the 90-95% win rates survived for weeks.
    //
    // THE COLUMNS ARE POSITIONAL, AND THE SAMPLE SIZE IS NOT FIXED.
    //
    // These regexes used to hard-code `181` — the `n` of the sample
    // when the test was written. The collector keeps growing the
    // sample, so the SHIPPED row's `n` moved past 181 and the match
    // failed: the test reported "the scratch column is on the row" as
    // MISSING while the column was right there on the row.
    //
    // That is the defect class the skill records: "A TEST THAT READS
    // THE LIVE COLLECTOR ASSERTS A FACT ABOUT THE HOUR, NOT THE
    // CODE". The header declares the column order —
    //
    //     n  win%  scr%  time% |  EV %eq |  BE-WR | tp%   stop%
    //
    // so the `n` is captured DYNAMICALLY and the columns are read
    // after it. The check then holds whatever the sample size is, and
    // a real change to the COLUMN ORDER still fails it.
    const rowCols = shippedLine?.match(
      /\|\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\|/,
    );
    check("the sweep shows the scratch share", !!rowCols, "the scratch column is on the row");
    if (rowCols) {
      // the columns: 1 = n, 2 = win%, 3 = scr%, 4 = time%
      const scr = Number(rowCols[3]);
      check("the scratch share is non-zero", scr > 0, `the scratch share is ${scr}%`);
      // the time share can never exceed 100%
      const time = Number(rowCols[4]);
      check("the time share is not over 100%", time <= 100.001, `the time share is ${time}%`);
    }
  }
}

console.log("");
console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
