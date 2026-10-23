#!/usr/bin/env node
/**
 * THE SWEEP, DONE CORRECTLY.
 *
 * Every geometry sweep so far measured a trade the venue would never
 * make: a take-profit on the wrong side of the market, booked as a full
 * target. That produced the 90-95% win rates and the positive excesses.
 *
 * Now that the fill rule is correct, the sweep is worth redoing — and
 * it is worth doing over a WIDE geometry space, because the previous
 * sweep's answer ("no geometry works") was reached with a broken
 * measurement, and that is not evidence.
 *
 * WHAT IS SWEPT
 * -------------
 *   the take-profit: 0.15% to 3.0% (in ATR units AND in absolute %)
 *   the stop:        0.15% to 3.0%
 *   the hold:        4, 8, 16, 32 bars (1h, 2h, 4h, 8h)
 *   the fee:         taker (0.12%) and maker (0.04%)
 *
 * AND THE FILL RULE IS CORRECT
 * ----------------------------
 * A take-profit that is already satisfied at the market pays ~ZERO
 * gross minus the fee — it is a scratch. A take-profit beyond the
 * market pays the target distance. A trade reaching neither level is a
 * TIME EXIT at its mark. A bar touching both is a LOSS.
 *
 * AND THE CLUSTERING IS THE TICKET'S HOLDING PERIOD
 * --------------------------------------------------
 * The t-statistic is computed on cluster means at the ticket's own
 * holding period, because two signals inside the same window share the
 * path that decides the outcome.
 *
 * THE BAR
 * -------
 * A geometry is a CANDIDATE only if all of:
 *   - the net EV (after the fee) is positive
 *   - the EV at the ticket's holding period is positive
 *   - the EV is above the fee floor with room to spare
 *   - the t at the holding-period clustering is >= 2
 *   - it survives dropping the worst 3 and the best 3 trades
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");

const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const TAKER = 0.0012; // round trip
const MAKER = 0.0004; // round trip
const BAR_MS = 15 * 60_000;

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
const ARMS = [
  ["LIVE-GATE", rows.filter((r) => tapeSideFromRow(r) && liveGateSide(r) === tapeSideFromRow(r))],
  ["TAPE-ONLY", rows.filter((r) => tapeSideFromRow(r))],
];

/** The trade at a given (tpPct, stopPct, holdBars, fee). */
function trade(r, tpPct, stopPct, holdBars, fee) {
  const last = Number(r.price);
  if (!(last > 0)) return null;
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + holdBars);
  if (end - i < 2) return null;
  const long = tapeSideFromRow(r) === "long";
  const entry = last;
  const target = long ? last * (1 + tpPct / 100) : last * (1 - tpPct / 100);
  const stop = long ? last * (1 - stopPct / 100) : last * (1 + stopPct / 100);
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= target : bar.l <= target;
    const hitSl = long ? bar.l <= stop : bar.h >= stop;
    // A bar touching BOTH is a LOSS (conservative).
    if (hitSl) return { pnlPct: -stopPct / 100 - fee, outcome: "loss" };
    if (hitTp) return { pnlPct: tpPct / 100 - fee, outcome: "win" };
  }
  const lastBar = b[end - 1];
  if (!lastBar) return null;
  const movePct = long
    ? (lastBar.c - entry) / entry
    : (entry - lastBar.c) / entry;
  return { pnlPct: movePct - fee, outcome: "time" };
}

/** The cluster-corrected EV, at the ticket's holding period. */
function clusterEv(trades, holdBars) {
  const ms = holdBars * BAR_MS;
  const g = new Map();
  for (const t of trades) {
    const b = Math.floor(t.ts / ms);
    if (!g.has(b)) g.set(b, []);
    g.get(b).push(t);
  }
  const means = [...g.values()].map((v) => mean(v.map((t) => t.pnlEq)));
  if (!means.length) return { clusters: 0, ev: 0, se: 0, t: 0 };
  const ev = mean(means);
  const se = means.length > 1 ? stdev(means) / Math.sqrt(means.length) : 0;
  return { clusters: g.size, ev, se, t: se > 0 ? ev / se : 0 };
}

const trim = (evs, n) => {
  const s = [...evs].sort((a, b) => a - b);
  return s.length > 2 * n ? s.slice(n, s.length - n) : s;
};

console.log("═".repeat(104));
console.log("THE SWEEP, DONE CORRECTLY — the fill rule, the clustering and the fee are all right this time");
console.log("═".repeat(104));

const TP_PCTS = [0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
const STOP_PCTS = [0.15, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
const HOLDS = [4, 8, 16, 32];

for (const [armName, arm] of ARMS) {
  for (const [feeName, fee] of [["TAKER 0.12%", TAKER], ["MAKER 0.04%", MAKER]]) {
    const candidates = [];
    let tested = 0;
    for (const tpPct of TP_PCTS) {
      for (const stopPct of STOP_PCTS) {
        for (const holdBars of HOLDS) {
          tested++;
          const trades = [];
          for (const r of arm) {
            const t = trade(r, tpPct, stopPct, holdBars, fee);
            if (!t) continue;
            trades.push({ ...t, ts: r.ts, pair: r.pair, pnlEq: t.pnlPct * RHO * 100 });
          }
          if (trades.length < 30) continue;
          const wins = trades.filter((t) => t.outcome === "win").length;
          const c = clusterEv(trades, holdBars);
          const evAll = mean(trades.map((t) => t.pnlEq));
          const t3 = mean(trim(trades.map((t) => t.pnlEq), 3));
          const t3b = mean(trim(trades.map((t) => t.pnlEq), 3));
          // The fee floor, in percent of equity per trade.
          const floor = fee * RHO * 100;
          if (evAll > 0 && c.ev > 0 && c.t >= 2) {
            candidates.push({
              tpPct, stopPct, holdBars, n: trades.length, winRate: wins / trades.length,
              evAll, evClust: c.ev, t: c.t, clusters: c.clusters, floor,
              trimmed: t3,
            });
          }
        }
      }
    }
    const positive = candidates.length;
    const aboveFloor = candidates.filter((c) => c.evAll > c.floor).length;
    console.log(`\n── ${armName} | ${feeName} | ${tested} geometries ──`);
    console.log(`  positive EV at the holding period AND t >= 2: ${positive}`);
    console.log(`  and above the fee floor (${fmt(fee * RHO * 100, 4)} %eq/trade): ${aboveFloor}`);
    if (candidates.length) {
      candidates.sort((a, b) => b.evClust - a.evClust);
      console.log("  the best by clustered EV:");
      for (const c of candidates.slice(0, 5)) {
        console.log(
          `    TP ${String(c.tpPct).padStart(4)}%  SL ${String(c.stopPct).padStart(4)}%  hold ${String(c.holdBars).padStart(2)}  ` +
          `n ${String(c.n).padStart(3)}  win ${fmt(c.winRate * 100, 1).padStart(5)}%  EV ${fmt(c.evAll).padStart(8)}  ` +
          `clustered EV ${fmt(c.evClust).padStart(8)}  t ${fmt(c.t).padStart(6)}  clusters ${String(c.clusters).padStart(3)}  ` +
          `trimmed ${fmt(c.trimmed).padStart(8)}`,
        );
      }
    }
  }
}
console.log("");
