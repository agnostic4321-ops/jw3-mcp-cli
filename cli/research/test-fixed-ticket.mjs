#!/usr/bin/env node
/**
 * THE FIXED TICKET — what is the real expectancy once the take-profit
 * is actually beyond the market?
 *
 * TWO DEFECTS, BOTH MEASURED
 * --------------------------
 * 1. THE SCRATCH ARTEFACT (test-scratch-artefact.mjs)
 *    For a SHORT the live path's take-profit is ABOVE the market,
 *    because tp = 0.4 x ATR and d = 0.9 x ATR, so tp > d/2 is false for
 *    every ATR. A buy limit above the market is MARKETABLE: it fills
 *    instantly at the ask. Every simulation booked those as full
 *    take-profits; the venue books them as a fee and nothing else.
 *    Measured: 18 of 22 live-gate trades and 379 of 515 tape-arm
 *    trades are scratches. The venue's own 8 trades: 6 scratches.
 *
 * 2. THE WRONG-SIDED TARGET (this script)
 *    The ticket's TP is derived from `avgEntry`, which is offset from
 *    the market by d/2 percent. Fixing the TP to be beyond the MARKET
 *    means deriving it from the market, and then the stop's distance
 *    from the entry must be preserved (so the risk, and therefore the
 *    sizing, does not change).
 *
 * WHAT THIS SCRIPT MEASURES
 * -------------------------
 * For each arm, the SHIPPED ticket and the FIXED ticket, under the
 * CORRECT fill rule:
 *
 *   SHIPPED: entry = avgEntry, TP = avgEntry x (1 -/+ tp), SL = the
 *            live path's killPrice. The TP is on the wrong side for
 *            most signals, so the trade scratches.
 *   FIXED:   entry = the market, TP = the market x (1 -/+ tp) — beyond
 *            the market in the profitable direction — and SL at the
 *            SAME distance from the entry as the shipped ticket, so the
 *            risk and the sizing are unchanged.
 *
 * And the decisive comparison: the FIXED ticket against the
 * unconditional drift control, at the ticket's own holding period.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const ATR_MULT_STOP = 0.9;
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16;
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const ROUND_TRIP = 0.0012;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

const rows = readFileSync(CONFLUENCE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bars = JSON.parse(readFileSync(BARS, "utf8"));

function liveGateSide(r) {
  const j = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!j || !l || j !== l) return null;
  return j;
}
const liveArm = rows.filter((r) => tapeSideFromRow(r) && liveGateSide(r) === tapeSideFromRow(r));
const tapeArm = rows.filter((r) => tapeSideFromRow(r));

/**
 * The two tickets.
 *
 * The live path's `planScalp` with 2 steps:
 *   stepDropPct = clamp(0.9 x ATR, 0.6, 1.5)          = d
 *   avgEntry    = last x (1 + dirSign x d/200)        (a short: ABOVE)
 *   tpPrice     = avgEntry x (1 + tpDir x tp/100)
 *   killPrice   = last x (1 + dirSign x 2d/100)
 *
 * The FIXED ticket:
 *   entry       = last (the market — the live path places a MARKET order)
 *   tpPrice     = last x (1 + tpDir x tp/100)         BEYOND the market
 *   stopPrice   = the market, at the SAME distance from the entry as the
 *                 shipped ticket's stop, so the risk and the sizing are
 *                 unchanged.
 */
function ticketFor(r, fixed) {
  const atrPct = Number(r.tapeAtrPct);
  const last = Number(r.price);
  if (!(atrPct > 0) || !(last > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const long = tapeSideFromRow(r) === "long";
  const dirSign = long ? -1 : 1;
  const tpDir = long ? 1 : -1;

  const avgEntry = last * (1 + (dirSign * d) / 200);
  const killPrice = last * (1 + (dirSign * 2 * d) / 100);
  const stopFracShipped = Math.abs(killPrice - avgEntry) / avgEntry;

  if (!fixed) {
    return {
      atrPct, d, tpPct, long, entry: avgEntry, market: last,
      targetPrice: avgEntry * (1 + (tpDir * tpPct) / 100),
      stopPrice: killPrice,
      stopFrac: stopFracShipped,
      tpFrac: tpPct / 100,
    };
  }
  // THE FIX: the entry is the market, the take-profit is beyond the
  // market in the profitable direction, and the stop keeps the same
  // distance from the entry.
  const stopFrac = stopFracShipped;
  return {
    atrPct, d, tpPct, long, entry: last, market: last,
    targetPrice: last * (1 + (tpDir * tpPct) / 100),
    stopPrice: long ? last * (1 - stopFrac) : last * (1 + stopFrac),
    stopFrac,
    tpFrac: tpPct / 100,
  };
}

/**
 * The CORRECT fill rule.
 *
 * A take-profit on the WRONG side of the market is marketable: it
 * fills instantly at the touch, so the gross is ~zero and the trade
 * books the fee. A take-profit on the RIGHT side pays the target
 * distance.
 */
function resolve(r, t) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = t.long;
  const tpWrongSide = long ? t.targetPrice < t.market : t.targetPrice > t.market;
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= t.targetPrice : bar.l <= t.targetPrice;
    const hitSl = long ? bar.l <= t.stopPrice : bar.h >= t.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", pnlPct: -t.stopFrac - ROUND_TRIP };
    if (hitSl) return { outcome: "loss", pnlPct: -t.stopFrac - ROUND_TRIP };
    if (hitTp) {
      if (tpWrongSide) {
        // A marketable limit: fills at the touch, seconds later, at
        // essentially the same price. The gross is ~zero.
        return { outcome: "scratch", pnlPct: -ROUND_TRIP };
      }
      return { outcome: "win", pnlPct: t.tpFrac - ROUND_TRIP };
    }
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - t.entry) / t.entry
    : (t.entry - lastBar.c) / t.entry;
  return { outcome: "time", pnlPct: movePct - ROUND_TRIP };
}

function measure(arm, fixed) {
  const trades = [];
  for (const r of arm) {
    const t = ticketFor(r, fixed);
    if (!t) continue;
    const o = resolve(r, t);
    if (!o) continue;
    trades.push({ ...o, ts: r.ts, pair: r.pair, pnlEq: o.pnlPct * RHO * 100 });
  }
  const wins = trades.filter((t) => t.outcome === "win").length;
  const scratches = trades.filter((t) => t.outcome === "scratch").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const times = trades.filter((t) => t.outcome === "time").length;
  return { trades, n: trades.length, wins, scratches, losses, times, evEq: trades.map((t) => t.pnlEq) };
}

/** The cluster-corrected EV at a given cluster width. */
function clustered(trades, ms) {
  const g = new Map();
  for (const t of trades) {
    const b = Math.floor(t.ts / ms);
    if (!g.has(b)) g.set(b, []);
    g.get(b).push(t);
  }
  const means = [...g.values()].map((v) => mean(v.map((t) => t.pnlEq)));
  const ev = mean(means);
  const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
  return { clusters: g.size, ev, se, t: se > 0 ? ev / se : 0 };
}

console.log("═".repeat(100));
console.log("THE FIXED TICKET — the take-profit beyond the market, and the real expectancy");
console.log("═".repeat(100));

for (const [name, arm] of [["LIVE-GATE (the machine's trade)", liveArm], ["TAPE-ONLY (the control)", tapeArm]]) {
  console.log(`\n── ${name} ──`);
  for (const fixed of [false, true]) {
    const m = measure(arm, fixed);
    const label = fixed ? "FIXED   (TP beyond the market)" : "SHIPPED (TP from the offset entry)";
    console.log(
      `  ${label}  n ${String(m.n).padStart(3)} | win ${String(m.wins).padStart(3)} | scratch ${String(m.scratches).padStart(3)} | loss ${String(m.losses).padStart(3)} | time ${String(m.times).padStart(3)}`,
    );
    for (const w of [{ ms: 300_000, l: "5 min" }, { ms: 3_600_000, l: "1 h" }, { ms: 14_400_000, l: "4 h" }]) {
      const c = clustered(m.trades, w.ms);
      console.log(
        `      at ${w.l.padEnd(5)} ${String(c.clusters).padStart(3)} clusters   EV ${fmt(c.ev).padStart(8)} %eq   se ${fmt(c.se).padStart(7)}   t ${fmt(c.t).padStart(6)}`,
      );
    }
  }
}

console.log("\n── THE FEES, AND WHAT THE ACCOUNT ACTUALLY BOOKS ──");
const mFixed = measure(liveArm, true);
const feeEq = ROUND_TRIP * RHO * 100;
console.log(`  the taker round trip: ${fmt(ROUND_TRIP * 100, 2)}% of notional = ${fmt(feeEq, 4)} % of equity per trade`);
console.log(`  the FIXED live-gate arm: EV ${fmt(clustered(mFixed.trades, 14_400_000).ev)} % of equity per trade`);
console.log(`  the venue's 8 live trades: 6 were scratches, net -$0.5708 on $0.5672 of fees`);
console.log("");
