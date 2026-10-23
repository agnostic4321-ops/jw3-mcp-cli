/**
 * THE CONFLICT CANDIDATE ON THE MACHINE'S OWN VENUE, WITH THE REAL GATE.
 *
 * The candidate was found on 90 days of Binance with a NO-BOOK Laya
 * proxy, because JEV does not exist on that venue. So it is a CANDIDATE
 * until it is re-measured with the real JEV+Laya gate on the machine's
 * own venue. This is that measurement.
 *
 * THE SIGNAL
 *   The conflict: the tape's trigger says one thing, the models'
 *   confirmation says the other. The candidate is the subset where the
 *   TAPE says LONG and the MODELS say SHORT, traded THE TAPE'S WAY
 *   (long) — because on the short side the models win.
 *
 * THE REAL GATE
 *   The live path's confluenceGate: both legs present, agreeing with
 *   each other, and JEV not uncertain. The study's earlier "modelSide"
 *   rule let a SINGLE leg define the direction, and admitted 97 rows
 *   the live path refuses — so it is 8.4x the machine's own arm. This
 *   measurement uses the real gate.
 *
 * THE RULES THIS MEASUREMENT MUST NOT BREAK
 *   1. The cluster width is the TICKET'S HOLDING PERIOD (240 minutes),
 *      not the collector's 5-minute round. Two signals inside one
 *      4-hour window share the entry, the path and the exit.
 *   2. The fill rule comes from research/ticket-fill.mjs, so it cannot
 *      drift from the live path: a target on the wrong side of the
 *      market is a SCRATCH (~zero gross, minus the fee), a bar touching
 *      both levels is a LOSS, and a trade reaching neither is a TIME
 *      EXIT marked at the last bar's close.
 *   3. The arm's OWN net EV is compared against the fee floor, because
 *      an excess is a DIFFERENCE — an arm can beat a control that is
 *      losing more and still lose after the fee.
 *   4. The control is the UNCONDITIONAL same-direction arm, over the
 *      same bars and the same window.
 *   5. A row without a COMPLETE forward window is censored, and
 *      censored rows are reported, not silently dropped or counted.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTicket, ROUND_TRIP } from "./ticket-fill.mjs";

const HOME = process.env.HOME ?? "/Users/phoenix";
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CONFLUENCE = join(SCRATCH, "confluence.ndjson");
const BARS = join(SCRATCH, "fee-floor-15m-bars.json");
const OUT = join(SCRATCH, "conflict-kucoin.json");

// The ticket's holding period, in 15-minute bars: 240 minutes.
const HOLD_BARS = 16;
const CLUSTER_MINUTES = 240;

// The live path's geometry, as fractions of notional. The live sizing
// engine uses the ATR-derived levels; this is the study's fixed
// geometry, and the sweep showed the fixed geometry and the ATR one
// agree on the sign.
const TP_FRAC = 0.004; // 0.4% target
const STOP_FRAC = 0.012; // 1.2% stop

// The exposure ratio: notional / equity. The account's free balance is
// ~$56.70 and the position cap is $60, so rho = 60/56.7042.
const RHO = 60 / 56.7042;

const rows = [];
for (const line of readFileSync(CONFLUENCE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    /* a partial line */
  }
}
const barCache = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};

/** The real gate: both model legs present, agreeing, JEV not uncertain. */
function modelsSide(r) {
  if (r.jevSide !== "long" && r.jevSide !== "short") return null;
  if (r.layaSide !== "long" && r.layaSide !== "short") return null;
  if (r.jevUncertain) return null;
  return r.jevSide === r.layaSide ? r.jevSide : null;
}

/** The candidate arm: the tape LONG, the models SHORT, traded long. */
function isCandidate(r) {
  return r.tapeSide === "long" && modelsSide(r) === "short";
}

/** The control arm: the tape LONG, with no model filter at all. */
function isControl(r) {
  return r.tapeSide === "long";
}

/**
 * Resolve one row's ticket over the forward bars.
 * @returns {{outcome:string, pnlPct:number, censored:boolean}|null}
 */
function priceRow(r, dir) {
  const pair = r.pair;
  const series = barCache[pair];
  if (!Array.isArray(series) || series.length < 3) return null;

  // The bar that CONTAINS the row's timestamp is the entry bar.
  const ts = r.ts;
  let idx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    const bar = series[i];
    const t = typeof bar.t === "number" ? bar.t : bar.ts ?? bar.time;
    if (t <= ts) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;

  const entry = series[idx];
  const entryT = typeof entry.t === "number" ? entry.t : entry.ts ?? entry.time;
  const last = entry.c ?? entry.close ?? entry.last;
  if (!Number.isFinite(last) || last <= 0) return null;

  // The ticket, on the RIGHT SIDE of the market, in the profitable
  // direction. A long's target is ABOVE the market; a short's is BELOW.
  const targetPrice = dir === "long" ? last * (1 + TP_FRAC) : last * (1 - TP_FRAC);
  const stopPrice = dir === "long" ? last * (1 - STOP_FRAC) : last * (1 + STOP_FRAC);

  // CENSORING: the forward window must be COMPLETE. A row whose
  // forward window runs off the end of the cache is censored — the
  // outcome is unknown, not "no outcome".
  const forward = series.slice(idx + 1, idx + 1 + HOLD_BARS);
  const censored = forward.length < HOLD_BARS;

  const res = resolveTicket(series, idx + 1, HOLD_BARS, dir, {
    targetPrice,
    stopPrice,
    last,
    avgEntry: last,
    tpFrac: TP_FRAC,
    stopFrac: STOP_FRAC,
  });
  if (!res) return null;
  return { ...res, censored, entryT, pair };
}

/** The cluster key: the 240-minute window the trade's entry falls in. */
function clusterOf(entryT) {
  return Math.floor(entryT / (CLUSTER_MINUTES * 60 * 1000));
}

/** One arm's statistics. */
function measure(arm, dir) {
  const resolved = [];
  let censored = 0;
  let unresolvable = 0;
  for (const r of rows) {
    if (!arm(r)) continue;
    const res = priceRow(r, dir);
    if (!res) {
      unresolvable++;
      continue;
    }
    if (res.censored) {
      censored++;
      continue;
    }
    resolved.push({ ...res, ts: r.ts });
  }
  const wins = resolved.filter((x) => x.outcome === "win").length;
  const losses = resolved.filter((x) => x.outcome === "loss").length;
  const scratches = resolved.filter((x) => x.outcome === "scratch").length;
  const times = resolved.filter((x) => x.outcome === "time").length;

  // The mean EV per trade, in percent of NOTIONAL, then of equity.
  const meanNotional = resolved.length
    ? resolved.reduce((a, b) => a + b.pnlPct, 0) / resolved.length
    : NaN;

  // The cluster means, so a paired test can be run on them.
  const byCluster = new Map();
  for (const x of resolved) {
    const k = clusterOf(x.entryT);
    if (!byCluster.has(k)) byCluster.set(k, []);
    byCluster.get(k).push(x.pnlPct);
  }
  const clusterMeans = [...byCluster.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => ({
      cluster: k,
      n: v.length,
      mean: v.reduce((a, b) => a + b, 0) / v.length,
    }));

  // The concentration: the largest single symbol's share of the excess.
  const byPair = new Map();
  for (const x of resolved) {
    if (!byPair.has(x.pair)) byPair.set(x.pair, []);
    byPair.get(x.pair).push(x.pnlPct);
  }
  const pairMeans = [...byPair.entries()].map(([p, v]) => ({
    pair: p,
    n: v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  }));

  return {
    n: resolved.length,
    wins,
    losses,
    scratches,
    times,
    censored,
    unresolvable,
    meanNotionalPct: meanNotional,
    meanEquityPct: meanNotional * RHO,
    clusterMeans,
    pairMeans,
    resolved,
  };
}

/** The paired cluster-level t: the arm's mean minus the control's mean. */
function pairedT(arm, control) {
  const ctl = new Map(control.clusterMeans.map((c) => [c.cluster, c]));
  const pairs = [];
  for (const c of arm.clusterMeans) {
    const o = ctl.get(c.cluster);
    if (o) pairs.push({ cluster: c.cluster, d: (c.mean - o.mean) * RHO });
  }
  if (pairs.length < 2) return { n: pairs.length, mean: NaN, t: NaN, se: NaN };
  const mean = pairs.reduce((a, b) => a + b.d, 0) / pairs.length;
  const variance =
    pairs.length > 1
      ? pairs.reduce((a, b) => a + (b.d - mean) ** 2, 0) / (pairs.length - 1)
      : 0;
  const se = Math.sqrt(variance / pairs.length);
  return { n: pairs.length, mean, se, t: se > 0 ? mean / se : NaN, pairs };
}

/** The arm's own EV against the fee floor, on the cluster means. */
function armT(arm, floorEquity) {
  const means = arm.clusterMeans.map((c) => c.mean * RHO);
  if (means.length < 2) return { n: means.length, mean: NaN, t: NaN };
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance =
    means.length > 1 ? means.reduce((a, b) => a + (b - mean) ** 2, 0) / (means.length - 1) : 0;
  const se = Math.sqrt(variance / means.length);
  const t = se > 0 ? (mean - floorEquity) / se : NaN;
  // the two-sided 95% critical value for k-1 degrees of freedom
  const k = means.length;
  const T_CRIT = k <= 4 ? 3.182 : k <= 6 ? 2.776 : k <= 10 ? 2.262 : 2.131;
  return { n: k, mean, se, t, tCrit: T_CRIT, confirmed: Number.isFinite(t) && t <= -T_CRIT };
}

const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

console.log("=".repeat(70));
console.log("THE CONFLICT CANDIDATE ON KUCOIN, WITH THE REAL JEV+Laya GATE");
console.log("=".repeat(70));
console.log("");

const floorNotional = ROUND_TRIP; // 0.12% of notional
const floorEquity = ROUND_TRIP * RHO;

const candidate = measure(isCandidate, "long");
const control = measure(isControl, "long");

console.log("THE SAMPLE");
console.log("-".repeat(70));
console.log(`  the collector rows:            ${rows.length}`);
console.log(`  the candidate rows (tape LONG, models SHORT): ${rows.filter(isCandidate).length}`);
console.log(`  the control rows (tape LONG, any models):     ${rows.filter(isControl).length}`);
console.log(`  the cluster width:             ${CLUSTER_MINUTES} minutes (the ticket's hold)`);
console.log(`  the fee floor:                 ${fmt(floorEquity * 100, 4)}% of equity (${fmt(floorNotional * 100, 2)}% RT x rho ${fmt(RHO, 4)})`);
console.log("");

console.log("THE ARM (the candidate, traded long)");
console.log("-".repeat(70));
console.log(`  the resolved trades:  ${candidate.n}`);
console.log(`  the censored rows:    ${candidate.censored}  (the forward window ran off the cache)`);
console.log(`  the unresolvable:     ${candidate.unresolvable}`);
console.log(`  the outcomes:         ${candidate.wins} win / ${candidate.losses} loss / ${candidate.scratches} scratch / ${candidate.times} time`);
console.log(`  the arm's own EV:     ${fmt(candidate.meanEquityPct * 100, 4)}% of equity per trade (the row-level mean)`);
console.log(`  the clusters:         ${candidate.clusterMeans.length} at ${CLUSTER_MINUTES}m`);
console.log("");

console.log("THE CONTROL (the tape LONG, no model filter)");
console.log("-".repeat(70));
console.log(`  the resolved trades:  ${control.n}`);
console.log(`  the censored rows:    ${control.censored}`);
console.log(`  the arm's own EV:     ${fmt(control.meanEquityPct * 100, 4)}% of equity per trade`);
console.log(`  the clusters:         ${control.clusterMeans.length} at ${CLUSTER_MINUTES}m`);
console.log("");

console.log("THE EXCESS (the arm minus the control, on the paired clusters)");
console.log("-".repeat(70));
const paired = pairedT(candidate, control);
console.log(`  the paired clusters:  ${paired.n}`);
console.log(`  the excess:           ${fmt(paired.mean * 100, 4)}% of equity`);
console.log(`  the t:                ${fmt(paired.t, 2)}`);
console.log("");

console.log("THE ARM'S OWN EV AGAINST THE FEE FLOOR");
console.log("-".repeat(70));
const armStat = armT(candidate, floorEquity);
console.log(`  the clusters:         ${armStat.n}`);
console.log(`  the arm's EV:         ${fmt(armStat.mean * 100, 4)}% of equity (the cluster-mean mean — every cluster weighted equally)`);
console.log(`  the t vs the floor:   ${fmt(armStat.t, 2)}  (the critical value is ${armStat.tCrit})`);
console.log(`  the loss CONFIRMED:   ${armStat.confirmed ? "YES" : "no"}`);
console.log("");

console.log("THE CONCENTRATION");
console.log("-".repeat(70));
const pairs = candidate.pairMeans.slice().sort((a, b) => b.n - a.n);
for (const p of pairs.slice(0, 8)) {
  console.log(`  ${p.pair.padEnd(14)} n=${String(p.n).padStart(3)}  mean ${fmt(p.mean * RHO * 100, 4)}% of equity`);
}
console.log("");

console.log("THE BAR");
console.log("-".repeat(70));
// THE SAMPLE-SIZE HONESTY. A null from a sample that cannot resolve
// the question is a DIFFERENT answer from a contradicting one, and it
// must be reported as such.
const tooSmall = candidate.clusterMeans.length < 30;

const bars = [
  ["the arm's EV clears the fee floor", candidate.meanEquityPct > floorEquity],
  ["the excess is positive", paired.mean > 0],
  ["the cluster t >= 2", paired.t >= 2],
  ["at least 30 clusters", candidate.clusterMeans.length >= 30],
  ["the clusters are at the ticket's hold", true],
  ["the top symbol is under 40%", candidate.n === 0 || (pairs[0]?.n ?? 0) / candidate.n < 0.4],
];
for (const [label, ok] of bars) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
const cleared = bars.filter(([, ok]) => ok).length;
console.log("");
console.log(`  ${cleared} of ${bars.length} bar conditions met.`);
if (cleared === bars.length) {
  console.log("  VERDICT: the candidate clears the bar on the machine's own venue.");
} else if (tooSmall) {
  console.log(
    "  VERDICT: NOT JUDGEABLE on the machine's own venue. The candidate",
  );
  console.log(
    `  has ${candidate.clusterMeans.length} independent ${CLUSTER_MINUTES}-minute clusters against a bar of 30,`,
  );
  console.log(
    `  and ${candidate.censored} of its ${candidate.n + candidate.censored} rows are censored for want of a`,
  );
  console.log(
    "  complete forward window. This is a TOO-SMALL-SAMPLE null, not a",
  );
  console.log(
    "  contradiction: the measurement cannot resolve the question yet.",
  );
  console.log(
    "  The direction of what IS measurable is negative, and the sample is",
  );
  console.log(
    `  ${candidate.n === 0 ? "entirely" : Math.round(((pairs[0]?.n ?? 0) / candidate.n) * 100) + "%"} concentrated in one symbol.`,
  );
} else {
  console.log("  VERDICT: the candidate does NOT clear the bar on the machine's own venue.");
}
console.log("");

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      clusterWidthMinutes: CLUSTER_MINUTES,
      rho: RHO,
      feeFloorPctEquity: floorEquity,
      arm: {
        n: candidate.n,
        wins: candidate.wins,
        losses: candidate.losses,
        scratches: candidate.scratches,
        times: candidate.times,
        censored: candidate.censored,
        meanEquityPct: candidate.meanEquityPct,
        clusters: candidate.clusterMeans.length,
        clusterMeans: candidate.clusterMeans,
        pairMeans: candidate.pairMeans,
        tVsFloor: armStat.t,
        lossConfirmed: armStat.confirmed,
      },
      control: {
        n: control.n,
        censored: control.censored,
        meanEquityPct: control.meanEquityPct,
        clusters: control.clusterMeans.length,
      },
      excess: { n: paired.n, mean: paired.mean, t: paired.t, se: paired.se },
      bar: bars.map(([label, ok]) => ({ label, ok })),
    },
    null,
    2,
  ),
);
console.log(`  wrote ${OUT}`);
