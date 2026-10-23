/**
 * THE ORDER-FLOW MEASUREMENT — the shared core for every order-flow arm.
 *
 * ══ THE ONE CONTROL THAT MATTERS ══
 *
 * A directional signal must be measured against the market's
 * unconditional drift IN THE SAME DIRECTION:
 *
 *   a LONG arm  scored +ret   vs  the control scored +ret   (always long)
 *   a SHORT arm scored −ret   vs  the control scored −ret   (always short)
 *
 * An arm that merely rides the market's drift has excess zero. An arm
 * that beats the same-direction control has an edge that is not beta.
 *
 * The control is restricted to the arm's CLUSTERS and paired with it
 * cluster by cluster, so the drift cancels row by row.
 *
 * ══ THE CLUSTER ══
 *
 * Rows are not observations. The cluster is one 5-minute round (the
 * collector's own cadence), and the HOURLY clustering is reported
 * alongside because consecutive rounds are not independent.
 *
 * ══ THE PLACEBO ══
 *
 * A random selection of the same SIZE and SHAPE, drawn from the same
 * population. If the real arm's t is inside the placebo's distribution,
 * the arm is nothing.
 *
 * ══ THE TRIM ══
 *
 * The worst-3 and best-3 clusters are dropped and the t is recomputed.
 */
import { mean, stdev, bucketOf, hourBucketOf, rng, trimmed } from "./lib.mjs";

/**
 * The arm-vs-control excess, paired by cluster, with the direction-
 * matched control.
 *
 * @param arm      [{o, dir, v}]  v = the forward return as a FRACTION
 * @param pool     [{o, v}]       the WHOLE population, same field
 * @param dirOf    (armRow) => "long"|"short"
 */
export function excessVsDirectionMatched(arm, pool, dirOf, clusterFn = bucketOf) {
  if (arm.length < 20) return null;
  // The CONTROL: the whole population's mean forward return in EACH
  // CLUSTER. The direction sign is applied PER ROW, so an arm that
  // mixes directions (the tape's exhaustion arm is mixed) is compared
  // against the control in each row's OWN direction.
  //
  //   excess_i = sign(d_i) * (v_i − clusterMean_i)
  //
  // and the cluster's excess is the mean of its rows' excesses. This is
  // the row-level version of "arm minus control, paired by cluster",
  // and it is the only version that is correct when the arm's
  // direction is not constant.
  const byCluster = new Map();
  for (const p of pool) {
    if (p.v == null) continue;
    const b = clusterFn(p.o.t);
    if (!byCluster.has(b)) byCluster.set(b, []);
    byCluster.get(b).push(p.v);
  }
  const ctlMeanByCluster = new Map();
  for (const [b, vs] of byCluster) ctlMeanByCluster.set(b, mean(vs));

  const armVals = [], armB = [], perRowExcess = [];
  for (const a of arm) {
    if (a.v == null) continue;
    const b = clusterFn(a.o.t);
    const ctl = ctlMeanByCluster.get(b);
    if (ctl == null) continue;
    const sign = dirOf(a) === "long" ? 1 : -1;
    armVals.push(sign * a.v * 100);
    perRowExcess.push(sign * (a.v - ctl) * 100);
    armB.push(b);
  }
  if (armVals.length < 20) return null;

  // the cluster means of the per-row excesses
  const ex = clusterOf(perRowExcess, armB);
  const tm = trimmed(ex.diffs, 3);
  // the control's own mean, for reporting
  const ctlVals = [];
  for (const p of pool) {
    if (p.v == null) continue;
    const b = clusterFn(p.o.t);
    const ctl = ctlMeanByCluster.get(b);
    if (ctl == null) continue;
    ctlVals.push((dirOf(arm[0]) === "long" ? 1 : -1) * ctl * 100);
  }
  return {
    ...ex, trim: tm, dir: dirOf(arm[0]), armVals, ctlVals, armB,
    ctlB: armB,
    armMean: mean(armVals), ctlMean: mean(ctlVals), n: armVals.length,
    clusters: ex.n,
  };
}

/** The cluster means of a set of values, and the t on them. */
function clusterOf(values, buckets) {
  const byB = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i];
    if (!byB.has(b)) byB.set(b, []);
    byB.get(b).push(values[i]);
  }
  const diffs = [...byB.values()].map(mean);
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  const m = mean(diffs);
  return { n: diffs.length, mean: m, se, t: se > 0 ? m / se : 0, diffs };
}

/** The paired excess, with the buckets supplied separately per arm. */
export function paired(signal, control, signalB, controlB) {
  const byS = new Map(), byC = new Map();
  for (let i = 0; i < signal.length; i++) {
    const b = signalB[i];
    if (!byS.has(b)) byS.set(b, []);
    byS.get(b).push(signal[i]);
  }
  for (let i = 0; i < control.length; i++) {
    const b = controlB[i];
    if (!byC.has(b)) byC.set(b, []);
    byC.get(b).push(control[i]);
  }
  const diffs = [];
  for (const [b, va] of byS) {
    const vb = byC.get(b);
    if (!vb || !vb.length) continue;
    diffs.push(mean(va) - mean(vb));
  }
  const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
  const m = mean(diffs);
  return { n: diffs.length, mean: m, se, t: se > 0 ? m / se : 0, diffs };
}

/**
 * THE PLACEBO: the same arm, with its ROWS drawn at random from the
 * control population within each cluster. The arm's size and the
 * control are unchanged; only the selection is randomised.
 */
export function placeboDirectionMatched(arm, pool, dirOf, clusterFn = bucketOf, trials = 1000, seed = 20261021) {
  const rand = rng(seed);
  const sign = dirOf(arm[0]) === "long" ? 1 : -1;
  // the control population, by cluster
  const byC = new Map();
  for (const p of pool) {
    if (p.v == null) continue;
    const b = clusterFn(p.o.t);
    if (!byC.has(b)) byC.set(b, []);
    byC.get(b).push(sign * p.v * 100);
  }
  // the arm's shape: how many rows per cluster
  const shape = new Map();
  for (const a of arm) {
    const b = clusterFn(a.o.t);
    shape.set(b, (shape.get(b) ?? 0) + 1);
  }
  const exs = [], ts = [];
  for (let t = 0; t < trials; t++) {
    const picked = [], pickedB = [];
    for (const [b, n] of shape) {
      const c = byC.get(b);
      if (!c || !c.length) continue;
      for (let k = 0; k < n; k++) {
        picked.push(c[Math.floor(rand() * c.length)]);
        pickedB.push(b);
      }
    }
    if (picked.length < 20) continue;
    const ex = paired(picked, picked, pickedB, pickedB); // self-paired -> 0 excess
    // the placebo's excess: the drawn rows vs the SAME cluster's mean
    const byB = new Map();
    for (let i = 0; i < picked.length; i++) {
      const b = pickedB[i];
      if (!byB.has(b)) byB.set(b, []);
      byB.get(b).push(picked[i]);
    }
    const diffs = [];
    for (const [b, va] of byB) {
      const c = byC.get(b);
      if (!c || !c.length) continue;
      diffs.push(mean(va) - mean(c));
    }
    const se = diffs.length > 1 ? stdev(diffs) / Math.sqrt(diffs.length) : 0;
    const m = mean(diffs);
    exs.push(m);
    ts.push(se > 0 ? m / se : 0);
  }
  const sortedEx = [...exs].sort((a, b) => a - b);
  const sortedT = [...ts].sort((a, b) => a - b);
  const real = mean(exs);
  return {
    trials: exs.length,
    exMean: real,
    exSd: stdev(exs),
    exP5: sortedEx[Math.floor(sortedEx.length * 0.05)],
    exP95: sortedEx[Math.floor(sortedEx.length * 0.95)],
    tMean: mean(ts),
    tP95: sortedT[Math.floor(sortedT.length * 0.95)],
    significant: ts.filter((t) => Math.abs(t) >= 2).length,
    percentile: (sortedEx.filter((x) => x < real).length / sortedEx.length) * 100,
  };
}

/** The symbol concentration of an arm. */
export function concentration(arm) {
  const bySym = new Map();
  for (const a of arm) bySym.set(a.o.sym ?? a.o.pair, (bySym.get(a.o.sym ?? a.o.pair) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  return { distinct: sorted.length, top: sorted[0], topShare: sorted[0][1] / total, sorted, total };
}

/**
 * A DAY-BLOCK bootstrap over the hourly clusters. The most conservative
 * t in this file: it resamples whole DAYS with replacement, so the
 * serial correlation inside a day cannot be broken.
 */
export function dayBlockBootstrap(excessResult, arm, pool, dirOf, clusterFn = bucketOf, trials = 2000, seed = 20261021) {
  const rand = rng(seed);
  const DAY = 24 * 3600_000;
  // the cluster means, indexed by their day
  const byDay = new Map();
  const byS = new Map(), byC = new Map();
  for (let i = 0; i < excessResult.armVals.length; i++) {
    const b = excessResult.armB[i];
    if (!byS.has(b)) byS.set(b, []);
    byS.get(b).push(excessResult.armVals[i]);
  }
  for (let i = 0; i < excessResult.ctlVals.length; i++) {
    const b = excessResult.ctlB[i];
    if (!byC.has(b)) byC.set(b, []);
    byC.get(b).push(excessResult.ctlVals[i]);
  }
  for (const [b, va] of byS) {
    const vb = byC.get(b);
    if (!vb || !vb.length) continue;
    const day = Math.floor((b * 300_000) / DAY);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(mean(va) - mean(vb));
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < 4) return null;
  const dayMeans = days.map((d) => mean(byDay.get(d)));
  // THE BLOCK IS THE DAY, so the STATISTIC is computed on the DAY MEANS.
  // Treating the resampled days' cluster-differences as independent
  // would understate the standard error, because the clusters inside a
  // day are serially correlated — which is exactly what the block
  // bootstrap exists to absorb.
  //
  // The bootstrap is CENTRED ON ZERO: the null hypothesis is that the
  // excess is zero, so the resampled statistic is the resampled MEAN
  // MINUS the observed mean. The reported p is then the fraction of
  // resamples whose |t| reaches the observed |t|.
  const ts = [];
  const grand = mean(dayMeans);
  for (let t = 0; t < trials; t++) {
    const draw = [];
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rand() * days.length)];
      draw.push(dayMeans[days.indexOf(d)]);
    }
    const se = stdev(draw) / Math.sqrt(draw.length);
    const m = mean(draw) - grand;
    ts.push(se > 0 ? m / se : 0);
  }
  const sortedT = [...ts].sort((a, b) => a - b);
  return {
    days: days.length,
    tMean: mean(ts),
    tP5: sortedT[Math.floor(sortedT.length * 0.05)],
    tP95: sortedT[Math.floor(sortedT.length * 0.95)],
    twoSidedP: (ts.filter((x) => Math.abs(x) >= Math.abs(excessResult.t)).length / ts.length),
    realT: excessResult.t,
    grandMean: grand,
  };
}
