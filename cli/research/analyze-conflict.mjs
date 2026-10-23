/**
 * THE CONFLICT STATE — the one the live machine hits most.
 *
 * ── WHY THIS STUDY EXISTS ──
 *
 * The armed trade loop's own audit trail is the clearest statement of
 * where this machine actually stands. Over 206 candidate evaluations it
 * refused 206, and the refusals were NOT spread evenly:
 *
 *   156  "the tape shows a short exhaustion but the models say long"
 *    14  "no fresh Laya read — a watch, not a trigger"
 *    10  "bounce off the session low is N%, needs 0.40% — still in the flush"
 *     6  "the tape shows no exhaustion signal (neutral/neutral)"
 *
 * So 76% of every candidate the machine evaluated was a CONFLICT: the
 * tape (the trigger the machine acts on) said one thing and the models
 * (the confirmation the machine requires) said the opposite. Only 4
 * candidates ever passed and fired.
 *
 * The conflict state is therefore not a corner case. It is the
 * machine's MODAL OUTCOME. And it is untested: the confluence study
 * measures the AGREEING state (both models on the same side), which
 * fires rarely and has produced no significant excess.
 *
 * The conflict is also the state with a genuine prior. A short
 * exhaustion — a sharp move down, then a bounce off the low — is what
 * the fade/dip family is BUILT on, and that family was measured and
 * found empty. But it was measured as a STANDALONE signal. Here the
 * question is different and specific: when the tape says "short
 * exhaustion" and the models say "long", is the tape right, the models
 * right, or neither?
 *
 * ── THE THREE ARMS ──
 *
 * For each conflict observation, the forward return is measured three
 * ways:
 *
 *   TAPE     the fade direction (short an exhaustion) — the machine's
 *            trigger taken at face value
 *   MODELS   the models' direction (long) — the confirmation taken at
 *            face value
 *   REVERSE  the opposite of the tape — the control
 *
 * Plus the UNCONDITIONAL baseline: the market's own drift over the
 * same window, which is what any of these must beat. A signal that
 * merely tracks beta is not an edge.
 *
 * The verdict is per-ARM, with the excess over the baseline and a t
 * statistic. The bar is the same one the other studies use: n>=30, a
 * positive excess, and t>=2. A positive excess at a small n is the
 * selection artefact the edge hunt found, not a finding.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const IN = join(HOME, ".hermes/cache/scratch/confluence.ndjson");
const CACHE_FILE = join(HOME, ".hermes/cache/scratch/confluence-bars.json");

/** The per-symbol hourly-bar cache. Module-level so barsFor can reach it. */
const CACHE = {};
/**
 * The oldest observation that needs a bar. The fetch window is anchored
 * to it, so an observation from 3 hours ago is not left without an
 * entry price just because the cache was built recently.
 */
let CACHE_OLDEST = 0;
if (existsSync(CACHE_FILE)) {
  try {
    Object.assign(CACHE, JSON.parse(readFileSync(CACHE_FILE, "utf8")));
  } catch {
    // a corrupt cache is rebuilt from scratch
  }
}

/** The taker round trip, in %, charged against every arm. */
const TAKER_RT = 0.12;
/** The horizon, in hours. */
const HORIZON_H = 1;
/** The bar interval, in minutes. KuCoin's granularity is in MINUTES. */
const BAR_MIN = 60;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const CACHE_MIN = Number(flag("cache-min", 4320)); // 3 days, like the confluence analyzer
const PAIRS = String(flag("pairs", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

// ── the klines ──────────────────────────────────────────────────────────
async function futJson(path) {
  const r = await fetch(`https://api-futures.kucoin.com${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.code && String(j.code) !== "200000") throw new Error(`api ${j.code}: ${j.msg}`);
  return j.data;
}

/**
 * The hourly bars for a pair, covering the whole observation window AND
 * the forward window after it.
 *
 * Two things this must get right, and both bit the first run:
 *
 *   1. THE CACHE MUST BE REFRESHED. A cache written once and never
 *      refreshed cannot contain the forward bar of an observation that
 *      was recorded after the cache was built — so every recent
 *      observation was unmeasurable. The cache is refetched whenever its
 *      newest bar is more than an hour old.
 *   2. EVERY SYMBOL MUST BE FETCHED. A cache built for only some of the
 *      symbols left the rest with no forward bar at all.
 *
 * KuCoin's granularity is in MINUTES and the query returns a bounded
 * number of bars, so the window is PAGINATED backwards.
 */
async function barsFor(pair, needUntilMs) {
  const base = pair.split("/")[0].toUpperCase();
  const sym = `${base}USDTM`;
  const now = Date.now();
  const cached = CACHE[pair] ?? [];
  const newest = cached.length ? cached[cached.length - 1].t : 0;
  // The cache is good enough only if it covers the forward window.
  if (cached.length && newest >= needUntilMs) return cached;

  // The window must start before the OLDEST observation, or the earlier
  // ones have no entry price.
  const from = Math.min(now - CACHE_MIN * 60_000, (CACHE_OLDEST ?? now) - 3600_000);
  const out = [];
  let cursor = now;
  let guard = 0;
  // KuCoin's kline query returns AT MOST 200 bars — and it returns the
  // MOST RECENT 200 in the range, silently discarding the rest. So a
  // single wide query does not fail; it returns the wrong window. The
  // window must be PAGINATED BACKWARDS from now, one 200-bar page at a
  // time, and the pages merged.
  while (cursor > from && guard++ < 20) {
    const hi = Math.min(cursor, now);
    // KuCoin returns AT MOST 200 bars per query — the most recent 200
    // in the range — so the page is 200 BARS, not 200 hours. At one
    // hour per bar those coincide, which is why this only surfaced
    // when the geometry study moved to 15-minute bars.
    const lo = Math.max(from, hi - 200 * BAR_MIN * 60_000);
    if (hi - lo < BAR_MIN * 60_000) break;
    let d;
    try {
      d = await futJson(
        `/api/v1/kline/query?symbol=${sym}&granularity=${BAR_MIN}&from=${lo}&to=${hi}`,
      );
    } catch {
      break;
    }
    const rows = Array.isArray(d) ? d : [];
    if (!rows.length) break;
    for (const row of rows) {
      // KuCoin kline: [time, open, high, low, close, volume]
      out.push({ t: Number(row[0]), c: Number(row[4]) });
    }
    cursor = lo - 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  const merged = new Map();
  for (const b of cached) merged.set(b.t, b);
  for (const b of out) merged.set(b.t, b);
  const all = [...merged.values()].sort((a, b) => a.t - b.t);
  CACHE[pair] = all;
  return all;
}

/**
 * The price HORIZON_H hours after ts, and the return from the price at ts.
 *
 * INDEX-BASED, not time-based. The bars sit on the hour grid, so an
 * observation at 08:05 has its price on the 08:00 bar and its
 * one-hour-forward price on the 09:00 bar. A time-based lookup asking
 * for a bar at or after 09:05 rejects the 09:00 bar and reports "no
 * forward bar" — which silently discarded 62 of 106 conflict
 * observations. The confluence analyzer's index-based lookup is the
 * correct shape; this now matches it.
 */
function forward(bars, ts) {
  const barsAhead = Math.round((HORIZON_H * 60) / BAR_MIN);
  // The last bar at or before ts.
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t <= ts) idx = i;
    else break;
  }
  if (idx < 0 || idx + barsAhead >= bars.length) return null;
  const p0 = bars[idx].c;
  const p1 = bars[idx + barsAhead].c;
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return { ret: ((p1 - p0) / p0) * 100, bars: barsAhead };
}

// ── the statistics ──────────────────────────────────────────────────────
function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function se(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
}
function tstat(d) {
  const s = se(d);
  return s > 0 ? mean(d) / s : 0;
}

// ── the arms ────────────────────────────────────────────────────────────
/**
 * Build the arms for one conflict observation.
 *
 * ── WHY THESE ARMS ARE NOT SYMMETRIC ──
 *
 * The first version of this study had three arms: TAPE, MODELS and
 * REVERSE. Two of them were algebraically DEGENERATE, and the numbers
 * said so plainly: the MODELS arm and the REVERSE arm came out
 * EXACTLY equal (-0.1200pp each), and the TAPE arm's excess matched
 * `-2 * baseline - fee` to four decimals.
 *
 * The reason is that a conflict is BINARY. The tape says short, the
 * models say long (or vice versa), so the models' direction IS the
 * reverse of the tape's. Both arms are then just the raw market return
 * minus the fee, and their "excess over the baseline" is exactly
 * -fee, every time. They carry no information about the conflict at
 * all — they are the baseline re-labelled.
 *
 * So the study is reduced to the ONE thing that actually varies: the
 * market's return CONDITIONED ON THE TAPE'S DIRECTION.
 *
 *   tape      the fade direction, net of fees — the arm that can win
 *   reverse   the opposite direction, net of fees — the control
 *   base      the market's own drift over the same windows — the
 *             baseline every arm must beat
 *
 * And the decisive comparison is SIGNED: the tape's net return minus
 * the reverse's net return, per observation. That difference is
 * independent of the market's drift, so it isolates the tape's
 * conditioning from beta. If the tape's direction carries no
 * information, the difference averages zero even on a strongly rising
 * market.
 */
async function main() {
  if (!existsSync(IN)) {
    console.error(`[conflict] no confluence file at ${IN}`);
    process.exitCode = 1;
    return;
  }
  const rows = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`[conflict] ${rows.length} confluence observations`);

  // The CONFLICT state: the tape says one thing, the models say another.
  // The machine refuses these. They are the modal outcome, so they are
  // what this study measures.
  // ── THE MATCHED DESIGN ──
  //
  // Every observation is classified into one of three states:
  //
  //   CONFLICT  the tape says one thing, the models say the other.
  //             This is the machine's modal outcome — 81% of every
  //             candidate it evaluates.
  //   CONTROL   the tape says the SAME thing, and the models AGREED
  //             with it. Same symbol, same tape direction, but no
  //             conflict.
  //   neither   no tape side, or no model side.
  //
  // The CONTROL is what makes the measurement possible. Every earlier
  // attempt at a baseline was CIRCULAR: the per-observation baseline
  // was the same window (a tautology — the difference is identically
  // zero) and the per-symbol baseline was built from the conflict
  // observations themselves (also identically zero). The control rows
  // are the same symbols, the same tape direction, and a DIFFERENT
  // market state — the only difference is whether the models
  // confirmed.
  //
  // So the question becomes exact: on symbol X, with the tape pointing
  // the same way, is the forward return different when the models
  // CONTRADICTED the tape than when they AGREED with it? That is a
  // matched, within-symbol comparison, and it is the one the machine
  // faces on every evaluation.
  const conflicts = [];
  const controls = [];
  for (const r of rows) {
    const tapeSide = tapeSideFromRow(r);
    if (!tapeSide) continue;
    // The models' side: JEV and Laya must agree with each other, or
    // one abstains while the other is directional. (The live path
    // requires both to agree; a conflict means the tape disagrees with
    // a confirmed confluence.)
    const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
    const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
    const modelSide = jev && laya ? (jev === laya ? jev : null) : (jev || laya);
    if (!modelSide) continue;
    if (tapeSide === modelSide) {
      controls.push({ ...r, fadeDir: tapeSide, modelSide });
    } else {
      conflicts.push({ ...r, fadeDir: tapeSide, modelSide });
    }
  }
  console.log(`[conflict] ${conflicts.length} CONFLICT observations (the machine's modal state)`);
  console.log(`[conflict] ${controls.length} CONTROL observations (same tape direction, the models agreed)`);
  if (conflicts.length || controls.length) {
    CACHE_OLDEST = minOf([...conflicts, ...controls].map((c) => c.ts));
  }

  // The bars.
  // EVERY symbol that appears in a conflict is fetched, and each is
  // asked for enough bars to cover its forward window.
  // EVERY symbol in the DATA is fetched, not only those in a conflict:
  // the unconditional baselines need the same symbols, and a symbol
  // that only appears in the agreeing state still contributes to the
  // comparison.
  // Every symbol in EITHER set is fetched: the controls are what the
  // matched comparison needs, and a control symbol with no bars makes
  // its cell unusable.
  const wanted = new Set([...conflicts.map((c) => c.pair), ...controls.map((c) => c.pair)]);
  const pairs = PAIRS.length ? PAIRS : [...wanted];
  const noBars = [];
  for (const p of pairs) {
    const need = Math.max(
      ...[...conflicts, ...controls]
        .filter((c) => c.pair === p)
        .map((c) => c.ts + HORIZON_H * 3_600_000),
    );
    try {
      const got = await barsFor(p, need);
      if (!got.length) noBars.push(p);
    } catch (e) {
      noBars.push(p);
      console.error(`[conflict] bars for ${p} failed: ${e.message}`);
    }
  }
  if (noBars.length) {
    console.log(`[conflict] ${noBars.length} symbol(s) returned NO bars: ${noBars.slice(0, 6).join(", ")}${noBars.length > 6 ? " …" : ""}`);
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  } catch {
    /* the cache is an optimisation, never a correctness dependency */
  }

  // Measure BOTH sets: the conflicts and the controls.
  const measure = (list) => {
    const out = { rows: [], tape: [], reverse: [], base: [], pair: [], dir: [], bucket: [] };
    for (const c of list) {
      const bars = CACHE[c.pair];
      if (!bars?.length) continue;
      const fw = forward(bars, c.ts);
      if (!fw) continue;
      const gross = c.fadeDir === "long" ? fw.ret : -fw.ret;
      out.rows.push(c);
      out.tape.push(gross - TAKER_RT);
      out.reverse.push(-gross - TAKER_RT);
      out.base.push(fw.ret);
      out.pair.push(c.pair);
      out.dir.push(c.fadeDir);
      // The 5-minute cluster: the rows in one bucket are ~43 symbols
      // moving together.
      out.bucket.push(Math.floor(c.ts / (5 * 60_000)));
    }
    return out;
  };
  const C = measure(conflicts);
  const K = measure(controls);

  // ── THE MATCHED COMPARISON ──
  //
  // For each (symbol, tape direction) cell, the conflict mean minus the
  // control mean, over the SAME symbol and the SAME tape direction.
  // That is the tape's contribution, isolated from the symbol's drift
  // and from the market's drift, because both sides are measured on
  // the same symbol in the same direction.
  //
  // The POOLED version (all conflicts versus all controls) is also
  // reported, but it is the weaker measurement: it assumes the two sets
  // are exchangeable, which they are not (the conflict set is
  // concentrated in a few symbols).
  const cells = new Map();
  const cellKey = (pair, dir) => `${pair}|${dir}`;
  for (let i = 0; i < C.rows.length; i++) {
    const k = cellKey(C.pair[i], C.dir[i]);
    const cell = cells.get(k) ?? { conflict: [], control: [], bucket: C.bucket[i] };
    cell.conflict.push(C.tape[i]);
    cells.set(k, cell);
  }
  for (let i = 0; i < K.rows.length; i++) {
    const k = cellKey(K.pair[i], K.dir[i]);
    const cell = cells.get(k) ?? { conflict: [], control: [], bucket: K.bucket[i] };
    cell.control.push(K.tape[i]);
    cells.set(k, cell);
  }

  const matchedExcess = [];
  const matchedCells = [];
  for (const [k, cell] of cells) {
    // Only cells with BOTH sides are usable: a conflict mean with no
    // control mean is not a matched comparison.
    if (!cell.conflict.length || !cell.control.length) continue;
    const diff = mean(cell.conflict) - mean(cell.control);
    matchedExcess.push(diff);
    matchedCells.push({ k, ...cell, diff, bucket: cell.bucket });
  }

  const n = C.rows.length;
  const noForward = conflicts.length - n;
  console.log(`[conflict] ${n} conflict observations measurable (${noForward} without a forward bar)`);
  console.log(`[conflict] ${K.rows.length} control observations measurable`);
  console.log(`[conflict] matched cells (symbol x direction, with both sides): ${matchedCells.length}`);
  const cs = C.dir.filter((d) => d === "short").length;
  const cl = C.dir.filter((d) => d === "long").length;
  console.log(`[conflict] tape directions in the conflict sample: short=${cs} long=${cl}`);
  if (cs > 0 && cl === 0) {
    console.log("[conflict] NOTE: every conflict has the same shape (the tape says short, the models say long). The taper's dip-long state almost never fires, so the reverse conflict is not observable yet.");
  }
  console.log();

  if (n < 5) {
    console.log("[conflict] NOT ENOUGH HISTORY YET — the collector keeps running.");
    return;
  }
  // ── THE REPORT ──
  const baseMean = mean(C.base);
  console.log(`  BASELINE (the market's own drift over the conflict windows): ${baseMean >= 0 ? "+" : ""}${baseMean.toFixed(4)}%`);
  console.log();

  const show = (label, arr) => {
    const m = mean(arr);
    const t = tstat(arr);
    const win = arr.length ? arr.filter((x) => x > 0).length / arr.length : 0;
    console.log(`  ${label}`);
    console.log(`    n=${String(arr.length).padStart(5)}  net ${m >= 0 ? "+" : ""}${m.toFixed(4)}%  win ${(win * 100).toFixed(1)}%  se ${se(arr).toFixed(4)}  t=${t.toFixed(2)}`);
    console.log();
  };
  show("CONFLICT: the tape's direction, when the models CONTRADICTED it", C.tape);
  show("CONTROL:  the tape's direction, when the models AGREED with it", K.tape);

  // ── THE DECISIVE TEST ──
  //
  // The matched, within-symbol comparison: on the same symbol, with the
  // tape pointing the same way, is the forward return different when
  // the models contradicted the tape than when they agreed with it?
  //
  // That is the exact question the machine faces on 81% of its
  // evaluations, and it is measured with the symbol's own drift
  // cancelled out.
  {
    // The CLUSTER correction: the cells in one 5-minute bucket share a
    // market state, so the row-level t reads the cluster size, not the
    // signal. The honest t is computed on the per-bucket means.
    const buckets = matchedCells.map((c) => c.bucket);
    const byBucket = new Map();
    for (let i = 0; i < matchedExcess.length; i++) {
      const b = buckets[i] ?? i;
      const arr = byBucket.get(b) ?? [];
      arr.push(matchedExcess[i]);
      byBucket.set(b, arr);
    }
    const clusterMeans = [...byBucket.values()].map((a) => mean(a));
    const m = mean(clusterMeans);
    const t = tstat(clusterMeans);
    const clusterCount = clusterMeans.length;
    const win = matchedExcess.length ? matchedExcess.filter((x) => x > 0).length / matchedExcess.length : 0;
    // The bar: 30 INDEPENDENT CLUSTERS, not 30 rows.
    const clears = clusterCount >= 30 && m > 0 && t >= 2;
    console.log("  DECISIVE: conflict minus control, per (symbol x tape direction) cell");
    console.log(`    n=${String(matchedExcess.length).padStart(5)} cells in ${String(clusterCount).padStart(3)} independent 5-minute clusters  mean ${m >= 0 ? "+" : ""}${m.toFixed(4)}pp  positive ${(win * 100).toFixed(1)}%  se ${se(clusterMeans).toFixed(4)}  t=${t.toFixed(2)}`);
    console.log(`    ${clears ? "CLEAR THE BAR — the conflict state is measurably worse (or better) than the control" : "does not clear the bar"}`);
    console.log();
  }

  // ── THE ROBUSTNESS CHECK ──
  //
  // A mean is not a finding if a handful of observations carry it. The
  // decisive number is reported with the worst 3 and the best 3 cells
  // dropped. If it survives both trims it is a property of the sample.
  if (matchedExcess.length >= 6) {
    const sorted = [...matchedExcess].sort((a, b) => a - b);
    const trimWorst = sorted.slice(3);
    const trimBest = sorted.slice(0, sorted.length - 3);
    const mw = mean(trimWorst);
    const tw = tstat(trimWorst);
    const mb = mean(trimBest);
    const tb = tstat(trimBest);
    console.log("  ROBUSTNESS (the decisive number, trimmed)");
    console.log(`    worst 3 cells dropped: n=${trimWorst.length}  mean ${mw >= 0 ? "+" : ""}${mw.toFixed(4)}pp  t=${tw.toFixed(2)}`);
    console.log(`    best  3 cells dropped: n=${trimBest.length}  mean ${mb >= 0 ? "+" : ""}${mb.toFixed(4)}pp  t=${tb.toFixed(2)}`);
    const stable = (mw > 0 && tw >= 2) || (mb > 0 && tb >= 2);
    console.log(`    ${stable ? "STABLE across both trims — a property of the sample" : "NOT STABLE — the result depends on a handful of cells"}`);
    console.log();
  }

  // The per-cell view.
  if (matchedCells.length) {
    const sorted = [...matchedCells].sort((a, b) => b.diff - a.diff);
    const pos = sorted.filter((c) => c.diff > 0).length;
    console.log(`  PER-CELL: ${pos}/${sorted.length} cells had the conflict BEAT the control`);
    console.log("  best: ", sorted.slice(0, 4).map((c) => `${c.k} ${c.diff.toFixed(3)}pp (c=${c.conflict.length} k=${c.control.length})`).join(", "));
    console.log("  worst:", sorted.slice(-4).map((c) => `${c.k} ${c.diff.toFixed(3)}pp (c=${c.conflict.length} k=${c.control.length})`).join(", "));
    console.log();
  }
}


main().catch((e) => {
  console.error(`[conflict] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
