#!/usr/bin/env node
/**
 * NO HEALTHY LINE MAY CONTAIN A WORD A WATCHER WOULD TARGET.
 *
 * Observed live: a watch pattern on "agreements" fired an alert on a
 * perfectly healthy collector round:
 *
 *   [confluence] 2026-10-21T07:42:24.873Z — 43 reads, 18 agreements
 *   (total 43)
 *
 * Nothing was wrong. The collector read 43 pairs, 18 of them pointed
 * the same way, and the line was printed. The problem is that the
 * collector prints that line on EVERY round, so ANY word in it is a
 * watch target that fires on normal operation — and the operator
 * learns to ignore the alarm, and then the real one is ignored too.
 *
 * It fired TWICE: the second delivery came from
 * `~/.hermes/desktop/interrupted_turns.json`, the retry queue for
 * fired prompts that were never cleanly handled. So a healthy line
 * produces a repeated alarm, and the alert's own command
 * (`--interval 600`) did not even match the live collector
 * (`--interval 300`) — it was a DEAD process's buffered stdout.
 *
 * THE RULE. A collector's healthy line must:
 *
 * 1. carry a POSITIVELY-matchable status (`status=ok`), so a watcher
 *    can target the healthy state instead of guessing;
 * 2. contain NO fault-sounding word, so a pattern on a fault cannot
 *    match a healthy line; and
 * 3. name a metric with a word that cannot be mistaken for a state —
 *    "agreements" is a metric, but it reads like a state, and a
 *    watcher on it fires every round.
 *
 * The fault vocabulary is reserved: `SKIP` for a per-item skip that
 * is not a fault, and `FAILED` for the collector dying. Neither
 * appears in a healthy line.
 *
 * Run: node research/test-no-fault-word-in-healthy-lines.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

/**
 * The words a watcher would plausibly target, and which must never
 * appear in a healthy line. The list is the ones this project has
 * actually been bitten by, plus the obvious relatives.
 */
const FAULT_WORDS = [
  "error",
  "fail",
  "failed",
  "warning",
  "warn",
  "skip",
  "crash",
  "exception",
  "refused",
  "denied",
  "unreadable",
  "stale",
  "timeout",
  "throttl",
  "agreements",
  "agreement",
];

console.log("══════════════════════════════════════════════════════════════");
console.log("NO HEALTHY LINE MAY CONTAIN A WORD A WATCHER WOULD TARGET");
console.log("══════════════════════════════════════════════════════════════");
console.log("");

/**
 * Pull the HEALTHY output lines out of a collector's source.
 *
 * A line is healthy if it is a console.log of a round summary or a
 * metric — and NOT one of the reserved fault lines (SKIP / FAILED /
 * the per-item error path).
 */
function healthyLines(src) {
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/console\.log\(/.test(l)) continue;
    // The reserved fault lines are NOT healthy lines.
    const window = lines.slice(i, i + 6).join("\n");
    if (/SKIP|FAILED|catch \(/.test(window) && !/status=/.test(window)) continue;
    // A round summary or a metric line.
    if (!/reads|rows|symbols|pairs|backoff|out=|total/.test(window)) continue;
    out.push({ line: l, text: window });
  }
  return out;
}

for (const [name, file] of [
  ["the confluence collector", "collect-confluence.mjs"],
  ["the funding/OI collector", "collect-funding-oi.mjs"],
]) {
  console.log(`── ${name} (${file})`);
  const src = readFileSync(join(HERE, file), "utf8");
  const healthy = healthyLines(src);

  check("it has healthy output lines to check", healthy.length > 0, "none found");

  for (const h of healthy) {
    const lower = h.text.toLowerCase();
    for (const w of FAULT_WORDS) {
      if (!lower.includes(w)) continue;
      // A fault word is allowed if the line is the RESERVED fault
      // vocabulary — but then it must not also be a healthy summary.
      check(
        `a healthy line does not contain the watch target "${w}"`,
        false,
        h.line.trim().slice(0, 90),
      );
    }
  }
  console.log("");
}

// ── THE POSITIVE-MATCHABLE STATUS ───────────────────────────────────
console.log("── the healthy line carries a POSITIVELY-matchable status");
{
  for (const file of ["collect-confluence.mjs", "collect-funding-oi.mjs"]) {
    const src = readFileSync(join(HERE, file), "utf8");
    check(
      `${file} prints status=ok on a healthy round`,
      /status=ok/.test(src),
      "no status=ok",
    );
  }
  {
    const src = readFileSync(join(HERE, "collect-funding-oi.mjs"), "utf8");
    check(
      "the funding collector names its empty round status=empty, not a fault phrase",
      /status=empty/.test(src) && !/all symbols unreadable/.test(src),
      "the fault-sounding phrase is still there",
    );
  }
}
console.log("");

// ── THE RESERVED FAULT VOCABULARY ──────────────────────────────────
console.log("── the fault vocabulary is reserved and unchanged");
{
  for (const file of ["collect-confluence.mjs", "collect-funding-oi.mjs"]) {
    const src = readFileSync(join(HERE, file), "utf8");
    check(
      `${file} still prints FAILED for a fatal death`,
      /FAILED/.test(src),
      "the fatal label is gone",
    );
  }
  // The confluence collector reads through the shared server, so a
  // single pair's read can fail while the round carries on — and that
  // is a SKIP, not a fault. The funding collector reads the venue's
  // REST API directly and skips a symbol SILENTLY, so it has no
  // per-item line to mis-watch; the requirement is that it has no
  // per-item line with a fault word in it.
  {
    const src = readFileSync(join(HERE, "collect-confluence.mjs"), "utf8");
    check(
      "the confluence collector still prints SKIP for a per-item skip",
      /SKIP/.test(src),
      "the per-item skip label is gone",
    );
  }
  {
    const src = readFileSync(join(HERE, "collect-funding-oi.mjs"), "utf8");
    // A PER-ITEM line names the thing that failed, in the middle of
    // the line — a round summary has its count at the end.
    const perItem = src
      .split("\n")
      .filter((l) => /console\.(log|error)\(/.test(l))
      .filter((l) => /\$\{(base|symbol|pair|o\.error|e\?\.stack)/.test(l))
      // The RESERVED fatal line is not a per-item line — it is the
      // collector dying, and "FAILED" is exactly the word it must say.
      .filter((l) => !/FAILED/.test(l));
    check(
      "the funding collector prints no per-item line with a fault word",
      !perItem.some((l) => FAULT_WORDS.some((w) => l.toLowerCase().includes(w))),
      JSON.stringify(perItem.slice(0, 2)),
    );
  }
}
console.log("");

// ── THE KEEPER WATCHES THE RESERVED WORDS, NOT METRICS ────────────
console.log("── the keeper watches STATES, not metrics");
{
  const keeper = readFileSync(join(HERE, "watch-keep.mjs"), "utf8");
  check(
    "the keeper watches FAILED for the collectors",
    /events:\s*\["FAILED"\]/.test(keeper),
    "the collectors' watch list changed",
  );
  check(
    "the keeper does NOT watch a metric word",
    !/events:\s*\[[^\]]*agreement/i.test(keeper),
    "the keeper watches a metric",
  );
}
console.log("");

console.log("══════════════════════════════════════════════════════════════");
console.log(`  ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════════");
process.exit(fail ? 1 : 0);
