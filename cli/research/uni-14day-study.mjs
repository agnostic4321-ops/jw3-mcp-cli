#!/usr/bin/env node
/**
 * THE 14-DAY UNIVERSE STUDY — the one script that prints the whole
 * answer, in order.
 *
 * ── WHAT THIS ANSWERS ──
 *
 *   The machine trades a rotating pool and fired 13 tickets today:
 *   LINK x3, SUI, AVAX x3, TAO, ENA — ALL SHORT, over 4 distinct
 *   symbols, from a 4.5-HOUR sample of a rising market.
 *
 *   This measures the same thing over 14 DAYS, and asks:
 *     1. which symbols have a long side and which have both
 *     2. which have the ATR and spread profile that lets a target clear
 *        the fee floor
 *     3. whether a symbol-SELECTION RULE beats the rotating pool OUT OF
 *        SAMPLE
 *     4. the capacity arithmetic: $500 a day, $60 a ticket, 8 tickets
 *
 * ── THE FIDELITY GATES (all run, all pass) ──
 *
 *   GATE 1  the ticket: the shipped-ticket formula reproduces the NINE
 *           real FIRED trades in trade-loop.ndjson with ZERO error.
 *   GATE 2  the tape:  1-hour bars reproduce the collector's OWN
 *           recorded tape, agreeing with its tapeSide on 98.6% of the
 *           rows where the collector had a side.
 *   GATE 3  the self-check: the entry lookup, the look-ahead in the
 *           entry, the time exit, the fee, the break-even, the
 *           wrong-side defect, the corrected ticket's signs.
 *   GATE 4  the look-ahead audit: every selection rule reads only bars
 *           that closed before the day.
 *
 * ── THE HEADLINE ──
 *
 *   The live arm's "100% win rate" was the WRONG-SIDE TAKE-PROFIT
 *   DEFECT: 92.0% of the signals put a short's target ABOVE the market,
 *   so the trigger was already satisfied and the leg filled instantly at
 *   the ask. It was a WIN that LOST money. The fix (commit a63880e8)
 *   drops those targets, and the honest win rate is 28.7% on the
 *   stop-only arm and 86.3% on a corrected ticket — against an 88.7%
 *   break-even.
 *
 *   The LONG side is starved by the CODE, not by the market: tapeSideOf
 *   checks the fade BEFORE the dip, so a market near its high AND its
 *   low books SHORT. 3,744 of the 4,012 hours where the dip condition
 *   holds are pre-empted by the fade. NO symbol selection rule can fix
 *   that; it is a one-line change to a signal function.
 *
 *   A symbol-SELECTION RULE does exist and it survives out of sample:
 *   the first-half ranking, applied to the second half, holds
 *   +0.0747/hour over 113 hours at t=4.10, at the 99th percentile of
 *   random 8-symbol universes. But it is measured on the COLLECTOR's
 *   43-symbol universe, and the machine's actual traded symbols (LINK,
 *   SUI, AVAX, TAO, ENA) are NOT in it.
 *
 * ── READ-ONLY ──
 *
 *   No venue calls, no orders, no account reads. Everything is computed
 *   from local caches.
 *
 * USAGE
 *   node research/uni-14day-study.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = process.env.JW3_SCRATCH ?? join(process.env.HOME, ".hermes/cache/scratch");
const PY = process.env.PYTHON || "python3";

const STEPS = [
  ["uni-selfcheck.py", "THE SELF-CHECK — the fidelity gates"],
  ["uni-validate-tape2.py", "THE TAPE FIDELITY GATE — 1h bars vs the collector's own tape"],
  ["uni-report.py", "THE PER-SYMBOL TABLE, THE THREE TICKET ARMS, AND THE LONG SIDE"],
  ["uni-report2.py", "THE SELECTION RULE AND THE OUT-OF-SAMPLE TEST"],
  ["uni-lookahead-audit.py", "THE LOOK-AHEAD AUDIT"],
  ["uni-decisive.py", "IS IT A SYMBOL EFFECT OR A TIMING EFFECT?"],
  ["uni-falsify.py", "THE FALSIFICATION ATTEMPTS"],
  ["uni-capacity.py", "THE CAPACITY ARITHMETIC"],
  ["uni-universe-mismatch.py", "THE UNIVERSE MISMATCH"],
];

for (const [script, title] of STEPS) {
  console.log("\n" + "#".repeat(126));
  console.log(`#  ${title}`);
  console.log("#".repeat(126));
  const r = spawnSync(PY, [join(HERE, script)], {
    encoding: "utf8",
    env: { ...process.env, JW3_SCRATCH: SCRATCH },
  });
  process.stdout.write(r.stdout ?? "");
  if (r.stderr) process.stderr.write(r.stderr);
}
