#!/usr/bin/env node
/**
 * The funding/OI collector — the ONE lead that cannot be tested on history.
 *
 * WHY THIS EXISTS
 * ---------------
 * KuCoin's public API exposes `openInterest` on the contract record, but
 * only as a CURRENT snapshot. There is no historical OI endpoint. So the
 * review's #1 lead — "funding-rate extremes + rising OI predicts a
 * downside move" — cannot be backtested. It can only be COLLECTED.
 *
 * The edge hunt already ruled out every kline-only family (0/89 signals,
 * 0/118 sides with positive taker expectancy). Funding/OI is the only
 * documented perp-microstructure edge that needs a non-kline input, so it
 * is the only one left worth collecting.
 *
 * WHAT IT COLLECTS
 * ----------------
 * Every poll, per symbol:
 *   - openInterest (the contract record's live value)
 *   - fundingFeeRate (the current settled rate) and lastTimeFundingRate
 *   - nextFundingRateDateTime (when the next funding settles)
 *   - price, from the ticker
 *
 * The collector writes NEWLINE-DELIMITED JSON to a file. It is
 * append-only and idempotent-per-poll: a restarted collector resumes
 * rather than truncating.
 *
 * The analysis (separate) then needs enough history to answer ONE
 * question: after a funding extreme with rising OI, does price fall more
 * than the fee costs?
 *
 * USAGE
 *   node collect-funding-oi.mjs --interval 900 --out ~/.hermes/cache/scratch/funding-oi.ndjson
 *   node collect-funding-oi.mjs --once        # a single sample
 *
 * The daemon already supervises one-shot children. This collector is
 * written to be run as a supervised child OR standalone.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const INTERVAL = Number(flag("interval", 900)) * 1000;
const ONCE = has("once");
const OUT = flag("out", join(homedir(), ".hermes/cache/scratch/funding-oi.ndjson"));
const UNIVERSE_FILE = flag("universe", join(homedir(), ".hermes/cache/scratch/universe.json"));

const FUT = "https://api-futures.kucoin.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── RATE LIMIT DISCIPLINE ──
//
// WHAT THIS COLLECTOR SPENDS, AND WHAT IT DOES NOT. This collector
// reads the venue DIRECTLY — its only network call is a fetch() to
// api-futures.kucoin.com, and it makes NO jw3() call at all. So it
// does NOT consume the MCP server's shared per-minute budget, and it
// cannot starve the daemon's monitor, the watchdog, the trade loop or
// the confluence collector.
//
// (An earlier version of this comment claimed the opposite — that this
// collector shared the server's budget. That was wrong, and it mattered
// twice: it described a dependency that does not exist, and it made a
// watch pattern on "budget reached" look like a warning about the
// machine's health when it is only this collector's own pacing. The
// collector that DOES spend the shared budget is collect-confluence.mjs,
// which calls `jw3 decide` per pair.)
//
// WHAT IT SPENDS INSTEAD: KuCoin's OWN public rate limit. Each symbol
// costs two calls (the contract record and the ticker), so a 45-symbol
// round is 90 calls — more than the server's entire per-minute budget.
//
// Bursting through a shared budget once starved the WATCHDOG, whose own
// venue read then failed with `rate_limited` three times in a row and
// latched its breaker — and the breaker is human-only to clear. A
// research collector must never be able to stop the machine.
//
// So the collector paces itself against its own cap, and the cap keeps
// the VENUE's rate limit from biting.
let CALLS = 0;
let WINDOW_START = Date.now();
const WINDOW_MS = 60_000;
const CALL_BUDGET = 30;

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
    console.log(`[collector] pacing backoff at ${CALLS} calls — waiting ${Math.round(wait / 1000)}s to leave room for the machine`);
    await sleep(wait);
    WINDOW_START = Date.now();
    CALLS = 0;
  }
  CALLS++;
  await sleep(250);
}

async function futJson(path, tries = 3) {
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(`${FUT}${path}`, { headers: { "User-Agent": "jw3-collector/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const code = typeof j?.code === "string" ? Number(j.code) : j?.code;
      if (j?.success === false || (typeof code === "number" && code !== 200000 && code !== 0)) {
        throw new Error(`api ${j?.code}: ${j?.msg ?? "?"}`);
      }
      return j;
    } catch (e) {
      last = e;
      await sleep(400 * (t + 1));
    }
  }
  throw last;
}

let universe = [];
try {
  const { readFileSync } = await import("node:fs");
  universe = JSON.parse(readFileSync(UNIVERSE_FILE, "utf8"));
} catch {
  const j = await futJson("/api/v1/contracts/active");
  universe = (j.data ?? [])
    .filter((c) => String(c.symbol).endsWith("USDTM"))
    .map((c) => String(c.symbol).replace("USDTM", ""))
    .sort();
}

// The ticker endpoint gives the mark price for the funding math.
async function markPrice(base) {
  try {
    const j = await futJson(`/api/v1/ticker?symbol=${base}USDTM`);
    const d = j?.data ?? {};
    return Number(d.price ?? d.last ?? 0) || null;
  } catch {
    return null;
  }
}

async function collectOnce() {
  const ts = Date.now();
  const rows = [];
  for (const base of universe) {
    let c;
    try {
      c = (await futJson(`/api/v1/contracts/${base}USDTM`))?.data ?? {};
    } catch {
      continue; // a symbol that is not listable right now — skip, do not fabricate
    }
    const oi = Number(c.openInterest ?? 0) || 0;
    const funding = Number(c.fundingFeeRate ?? 0) || 0;
    const lastFunding = Number(c.lastTimeFundingRate ?? 0) || 0;
    if (!oi && !funding && !lastFunding) continue;
    await pacedSleep();
    rows.push({
      ts,
      base,
      oi,
      funding,
      lastFunding,
      nextFundingAt: Number(c.nextFundingRateDateTime ?? 0) || null,
      price: await markPrice(base),
      // The OI notional is what actually matters — OI in CONTRACTS times
      // the multiplier times the price is the size of the crowd's position.
      oiNotionalHint: oi,
    });
  }
  return rows;
}

async function main() {
  if (!existsSync(OUT)) writeFileSync(OUT, "");
  console.log(`[collector] out=${OUT} symbols=${universe.length} interval=${INTERVAL / 1000}s`);
  let n = 0;
  for (;;) {
    const rows = await collectOnce();
    if (rows.length === 0) {
      // A ROUND THAT READ NO ROWS is a state, and it names itself
      // "status=empty" so a watcher can tell it from a fatal failure
      // ("FAILED") and from a healthy round ("status=ok").
      //
      // The line used to end with a phrase that sounded like a fault
      // even on a round where nothing was wrong, and a watcher on that
      // word fires on every such round. The status field is the
      // positively-matchable state, and the rest of the line is
      // descriptive only.
      console.log(`[collector] status=empty ${new Date().toISOString()} — no rows this round`);
    } else {
      for (const r of rows) appendFileSync(OUT, `${JSON.stringify(r)}\n`);
      n += rows.length;
      console.log(`[collector] status=ok ${new Date().toISOString()} — ${rows.length} rows (total ${n})`);
    }
    if (ONCE) break;
    await sleep(INTERVAL);
  }
}

main().catch((e) => {
  console.error(`[collector] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
