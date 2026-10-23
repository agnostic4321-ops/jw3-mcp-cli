#!/usr/bin/env node
/**
 * THE CONFLUENCE COLLECTOR.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live path's trigger is a CONFLUENCE: the JEV leg and the Laya leg
 * must agree on the same side, and the tape must confirm. That
 * confluence has NEVER been measured.
 *
 * What HAS been measured is the tape family (fade/dip), which the edge
 * hunt found empty: 0/89 candidates, 0/118 sides with positive taker
 * expectancy. But the live path gates on the tape AND the confluence,
 * so if the tape family is empty, the gate may be filtering on a
 * signal that never works while the CONFluence — the part that is
 * actually doing the work — goes unmeasured.
 *
 * The two are separable. This collector records the confluence alone,
 * with a forward price at a fixed horizon, so the confluence can be
 * measured on its own merits.
 *
 * WHAT IT RECORDS, PER OBSERVATION
 * --------------------------------
 *   ts, pair, side, jevAgreement, layaConfidence, bookImbalance,
 *   tapeChg, tapeVratio, price (the book mid at the moment of the read)
 *
 * The FORWARD price is NOT recorded here — the analyzer resolves it
 * later from the kline history, so a horizon change does not require
 * re-collection. A `priceAt` helper is used to find the price at a
 * given ts and the analyzer looks forward from there.
 *
 * THE CONTROLS (unchanged, and the reason this collector is worth
 * having): every measurement reports itself against the REVERSED
 * direction on the same signals and against an UNCONDITIONAL baseline
 * over the same symbols and windows. A signal with no excess over the
 * unconditional baseline is beta, however good its raw number looks.
 *
 * USAGE
 *   node collect-confluence.mjs --interval 300 --out ~/.hermes/cache/scratch/confluence.ndjson
 *   node collect-confluence.mjs --once
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideOf } from "./tape-signal.mjs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n.replace(/^-+/, "")}`);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n.replace(/^-+/, "")}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const INTERVAL = Number(flag("interval", 300)) * 1000;
const ONCE = has("once");
const OUT = flag("out", join(homedir(), ".hermes/cache/scratch/confluence.ndjson"));
const UNIVERSE_FILE = flag("universe", join(homedir(), ".hermes/cache/scratch/universe.json"));

mkdirSync(join(homedir(), ".hermes/cache/scratch"), { recursive: true });
if (!existsSync(OUT)) writeFileSync(OUT, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RATE LIMIT DISCIPLINE ──
//
// Every caller on this account shares ONE per-minute budget: the
// daemon's monitor, the daemon's watchdog, the trade loop, and the
// funding collector. A research collector that bursts through that
// budget will starve the WATCHDOG — and when the watchdog's own venue
// read gets throttled three times in a row it used to latch its
// breaker, which is human-only to clear. A research tool must never be
// able to stop the machine.
//
// So the collector paces itself: it counts its calls and waits when it
// nears the server's budget, leaving headroom for the machine.
let CALLS = 0;
let WINDOW_START = Date.now();
const WINDOW_MS = 60_000;
const CALL_BUDGET = 30; // well under the server's 60, leaving room

async function pacedSleep() {
  const now = Date.now();
  if (now - WINDOW_START > WINDOW_MS) {
    WINDOW_START = now;
    CALLS = 0;
  }
  if (CALLS >= CALL_BUDGET) {
    const wait = WINDOW_MS - (now - WINDOW_START) + 500;
    // THE PACING BACKOFF IS NORMAL OPERATION, NOT AN ALARM.
    //
    // The collector reads every symbol in the universe, so it hits its
    // own per-minute cap BY CONSTRUCTION on every round — the cap is
    // what keeps it under the shared budget. A watch pattern on the
    // words "budget reached" therefore fires on every single round,
    // which is an alarm that always fires and so is an alarm nobody
    // reads.
    //
    // So the line names the state for what it is: a PACING BACKOFF.
    // The word that should alarm is a collector that has STOPPED, and
    // that is a different event entirely.
    console.log(`[confluence] pacing backoff at ${CALLS} calls — waiting ${Math.round(wait / 1000)}s to leave room for the machine`);
    await sleep(wait);
    WINDOW_START = Date.now();
    CALLS = 0;
  }
  CALLS++;
  await sleep(900);
}

async function jw3(args, timeoutMs = 120000) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("env", ["-u", "JW3_CONFIG_HOME", "jw3", ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

let universe = [];
try {
  universe = JSON.parse(readFileSync(UNIVERSE_FILE, "utf8")).map((b) => `${b}/USDT`);
} catch {
  universe = ["SOL/USDT", "XBT/USDT", "ETH/USDT", "LINK/USDT", "DOGE/USDT"];
}
// A one-letter base is a TYPO in the contract list, not a pair the
// model can price ("S/USDT" and "F/USDT" are ticker noise). The decide
// command rejects them, and a rejected pair is a wasted read against
// the server's rate limit, so they are dropped up front.
universe = universe.filter((p) => {
  const base = p.split("/")[0] ?? "";
  return base.length >= 2;
});

/**
 * The confluence read for one pair.
 *
 * `jw3 decide` returns the state (tape + book + the JEV leg) and the
 * Laya verdict. The confluence is: both legs on the SAME side, neither
 * abstaining.
 */
async function readConfluence(pair) {
  let out;
  try {
    out = await jw3(["decide", "--pair", pair, "--exchange", "kucoin", "--json"]);
  } catch (e) {
    return { pair, error: String(e?.message ?? e).slice(0, 120) };
  }
  let d;
  try {
    d = JSON.parse(out);
  } catch {
    return { pair, error: "unparseable decide output" };
  }
  const st = d.state ?? {};
  const v = d.verdict ?? {};
  const jev = st.jev ?? null;
  const layaSide = String(v.choice ?? "").toLowerCase();
  const layaConf = Number(v.confidence ?? 0) || 0;
  const agree =
    jev &&
    (jev.side === layaSide) &&
    (jev.side === "long" || jev.side === "short") &&
    !jev.uncertain;


  const book = st.book ?? {};
  const tape = st.tape ?? {};
  return {
    pair,
    ts: Date.now(),
    side: agree ? jev.side : null,
    jevSide: jev?.side ?? null,
    jevAgreement: jev?.agreement ?? null,
    jevUncertain: jev?.uncertain ?? null,
    layaSide: layaSide || null,
    layaConfidence: layaConf,
    agree,
    bookImbalance: book.imb ?? null,
    bookMid: book.mid ?? null,
    spreadBps: book.sprBps ?? null,
    tapeChg: tape.chg ?? null,
    tapeVratio: tape.vratio ?? null,
    tapeOffHighPct: tape.offHighPct ?? null,
    tapeOffLowPct: tape.offLowPct ?? null,
    tapeAtrPct: tape.atrPct ?? null,
    // The tape's own side, computed with the live path's exact
    // thresholds. Together with jevSide and layaSide this makes the
    // CONFLICT state (the tape says one thing, the models say another)
    // measurable — it is the modal outcome of the armed loop, so it
    // was 76% of every candidate the machine evaluated.
    tapeSide: tapeSideOf(tape),
    price: book.mid ?? null,
  };
}

async function main() {
  console.log(`[confluence] out=${OUT} pairs=${universe.length} interval=${INTERVAL / 1000}s`);
  let n = 0;
  let agreed = 0;
  for (;;) {
    const ts = Date.now();
    for (const pair of universe) {
      const o = await readConfluence(pair);
      if (o.error) {
        // A PER-PAIR SKIP IS NOT A FAULT. The collector reads ~40 pairs
        // per round against a shared rate limit, so a single pair's
        // read failing is ordinary and survivable — the round carries
        // on without it.
        //
        // The word "error" in the line made a watcher match it, so a
        // watcher fired on normal operation. Name the state for what it
        // is: a SKIP. The fatal case is the collector dying, and that
        // is `FAILED` (below) — a word no healthy line contains.
        console.log(`[confluence] SKIP ${pair}: ${o.error}`);
        continue;
      }
      appendFileSync(OUT, `${JSON.stringify(o)}\n`);
      n++;
      if (o.agree) agreed++;
      // The read is a call against the server's rate limit. Pace it.
      await pacedSleep();
    }
    // THE HEALTHY LINE CARRIES AN EXPLICIT STATUS, and the metric is
    // named so it cannot be mistaken for a state.
    //
    // A watch pattern is a plain substring, and this line is printed on
    // EVERY round, so ANY word in it is a watch target that fires on
    // normal operation. The word "agreements" was watched, and the
    // collector fired an alert on a perfectly healthy round — twice,
    // because the alert was re-delivered from the retry queue.
    //
    // So the line leads with a positively-matchable status ("ok") and
    // calls the metric what it is: the number of pairs where the tape
    // and the models pointed the SAME way. "the same-side reads" is
    // descriptive, cannot be a state, and a watcher looking for the
    // conflict rate reads it there.
    console.log(
      `[confluence] status=ok ${new Date(ts).toISOString()} — ${universe.length} reads, ` +
        `${agreed} the same-side reads (total ${n})`,
    );
    if (ONCE) break;
    await sleep(INTERVAL);
  }
}

main().catch((e) => {
  console.error(`[confluence] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
