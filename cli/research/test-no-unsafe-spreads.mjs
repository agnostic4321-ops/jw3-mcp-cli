/**
 * NO RESEARCH SCRIPT MAY SPREAD A LARGE ARRAY INTO Math.min/Math.max.
 *
 * `Math.min(...arr)` passes every element as an ARGUMENT, and the
 * engine's argument limit is a few tens of thousands — so a spread
 * over a large array throws `RangeError: Maximum call stack size
 * exceeded`. Observed live: the deep conflict study has 987,620 rows
 * and `Math.min(...rows.map((r) => r.ts))` crashed it. The fix at the
 * time was a hand-written reduce at that ONE site, and the pattern
 * was left in ~100 places across the research scripts, where any
 * script that reads the collector's full history will crash the same
 * way.
 *
 * This test is a GUARD, not a report: it finds every spread site in
 * the research scripts, EXEMPTS the ones that are provably safe (a
 * literal array, or a spread of a short fixed list), and fails loudly
 * on the rest.
 *
 * WHY A GUARD AND NOT A LINT: a lint that says "don't spread" leaves
 * the reader to decide what is safe, and the reader has to know the
 * argument limit. The guard below is concrete: a spread of an
 * IDENTIFIER or a CALL RESULT is unsafe (the size is unknown at the
 * call site), and a spread of a LITERAL or a small constant list is
 * safe.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = HERE;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`      [PASS] ${name}`); }
  else { fail++; console.log(`      [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

console.log("════════════════════════════════════════════════════════════════════");
console.log("NO RESEARCH SCRIPT MAY SPREAD A LARGE ARRAY — the tests");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

// ── 1. THE SHARED HELPER EXISTS AND IS CORRECT ──
console.log("1. THE SHARED HELPER");
{
  const helperPath = join(RES, "safe-extremes.mjs");
  check("the shared helper exists", existsSync(helperPath), "research/safe-extremes.mjs is missing");
  if (existsSync(helperPath)) {
    const { minOf, maxOf, minBy, maxBy, timeSpan } = await import(helperPath);
    check("minOf finds the smallest", minOf([3, 1, 2]) === 1, "the min is wrong");
    check("maxOf finds the largest", maxOf([3, 1, 2]) === 3, "the max is wrong");
    check("minBy selects and minimises", minBy([{ v: 5 }, { v: 2 }], (r) => r.v) === 2, "the min is wrong");
    check("maxBy selects and maximises", maxBy([{ v: 5 }, { v: 2 }], (r) => r.v) === 5, "the max is wrong");
    check("an empty array gives Infinity", minOf([]) === Infinity && maxOf([]) === -Infinity, "the empty case is wrong");

    // THE PROOF THAT IT MATTERS: the same computation, spread and safe,
    // on an array past the argument limit.
    const big = new Array(200000).fill(0).map((_, i) => i);
    let spreadError = null;
    try {
      Math.min(...big);
    } catch (e) {
      spreadError = e;
    }
    check("the SPREAD really does throw on a large array", spreadError !== null, "the spread did not throw — the limit may be higher than assumed");
    check("the HELPER does not throw on the same array", minOf(big) === 0, "the helper failed on a large array");
    const span = timeSpan([{ ts: 5 }, { ts: 1 }, { ts: 9 }]);
    check("timeSpan finds the oldest and the newest", span.start === 1 && span.end === 9, "the span is wrong");
  }
}

// ── 2. NO RESEARCH SCRIPT SPREADS AN UNKNOWN-SIZE ARRAY ──
console.log("");
console.log("2. NO RESEARCH SCRIPT SPREADS AN UNKNOWN-SIZE ARRAY");
{
  // The guard's OWN file contains the patterns it forbids — as the
  // examples that prove the spread throws. It is exempt, like the
  // helper.
  const files = readdirSync(RES).filter(
    (f) => f.endsWith(".mjs") && !f.startsWith("safe-extremes") && !f.startsWith("test-no-unsafe-spreads"),
  );
  const offenders = [];

  for (const f of files) {
    const src = readFileSync(join(RES, f), "utf8");
    // strip the comments, so a spread QUOTED in a comment is not an
    // offence (a source-pattern test must find the code, not a word
    // near it)
    const code = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .join("\n");

    const re = /Math\.(min|max)\(\.\.\./g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const after = code.slice(m.index + m[0].length);
      // a LITERAL array is a fixed size and safe
      if (after.startsWith("[")) continue;
      // a spread of a NUMBER or a known-small constant is safe; the
      // unsafe case is a spread of an IDENTIFIER or a CALL RESULT, whose
      // size is not known at the call site.
      const ident = after.match(/^[A-Za-z_$][\w$.]*/);
      if (!ident) continue;
      const name = ident[0];
      // a small numeric range is safe
      if (/^(HOLDS|GRID|holds|grid)$/.test(name)) continue;
      const line = code.slice(0, m.index).split("\n").length;
      offenders.push(`${f}:${line}  Math.${m[1]}(...${name})`);
    }
  }

  check(
    "no research script spreads an unknown-size array",
    offenders.length === 0,
    `${offenders.length} site(s):\n        ` + offenders.slice(0, 12).join("\n        "),
  );
}

// ── 3. THE DEEP CONFLICT STUDY — THE SCRIPT THAT CRASHED ──
console.log("");
console.log("3. THE SCRIPT THAT CRASHED IS SPREAD-FREE");
{
  const p = join(RES, "test-conflict-deep.mjs");
  if (existsSync(p)) {
    const src = readFileSync(p, "utf8");
    const code = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""))
      .join("\n");
    const live = [...code.matchAll(/Math\.(min|max)\(\.\.\./g)];
    check(
      "the deep conflict study has no live spread",
      live.length === 0,
      `it has ${live.length} spread site(s)`,
    );
    check(
      "it computes the span with a reduce",
      /rows\.reduce\(\(m, r\) => \(r\.ts < m/.test(code),
      "the span is not a reduce",
    );
  }
}

console.log("");
console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
