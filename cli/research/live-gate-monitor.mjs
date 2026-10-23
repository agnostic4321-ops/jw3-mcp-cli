#!/usr/bin/env node
/**
 * THE LIVE-GATE MONITOR — a continuous read on the machine's own arm.
 *
 * ══ WHY THIS EXISTS ══
 *
 * `live-gate-ev.mjs` is a ONE-SHOT verdict. It answers "does the trade
 * the machine makes pay for itself?" and it answers it on the data that
 * existed when it ran. That is the right tool for a decision and the
 * wrong tool for a WATCHDOG: the operator needs to see, continuously and
 * without re-deriving anything by hand, whether the candidate has become
 * JUDGEABLE — that is, whether the evidence is now strong enough to
 * support a verdict at all.
 *
 * This script is that watch. It recomputes the arm's state from the
 * collector's rows and the bar cache, prints one compact block, and ends
 * with a plain verdict line: judgable or not, and if not, why.
 *
 * ══ THE METHOD, AND WHY EACH PIECE IS HERE ══
 *
 *   1. ROWS ARE NOT OBSERVATIONS. The collector writes ~45 symbols every
 *      5 minutes and they are all correlated with each other and with
 *      the market. Every statistic here that has an error bar is
 *      computed on CLUSTER MEANS — one mean per 4-HOUR WINDOW, the
 *      ticket's own holding period — so the reported t is not inflated
 *      by counting 45 near-identical rows as 45 independent trials, and
 *      not inflated again by counting one 4-hour trade as several
 *      5-minute ones.
 *
 *   2. A FORWARD RETURN IS NOT A TRADE OUTCOME. The arm is resolved
 *      against the live ticket geometry: first touch of TP or the stop
 *      wins, a bar touching BOTH is a LOSS (conservative), and a trade
 *      reaching neither level is closed at an explicit TIME EXIT at its
 *      mark. Nothing is left "unresolved" and quietly dropped.
 *
 *   3. THE t TESTS THE EXCESS OVER A CONTROL, never the raw signal. The
 *      headline number is what the CONFIRMATION layer adds over the
 *      tape-only arm on the same symbols and the same minutes, paired by
 *      cluster so the market's drift cancels. The drift control (always
 *      short on the same symbols and times) is reported beside it.
 *
 *   4. THE TRIM IS REPORTED, not hidden. Three worst and three best
 *      clusters are dropped and the number is recomputed. A result that
 *      only survives with its extremes is not a result.
 *
 *   5. THE CONCENTRATION IS REPORTED. If one symbol carries most of the
 *      excess, the arm is that symbol's story, not a property of the
 *      machine.
 *
 * ══ WHAT IT READS (local files only — never the account) ══
 *
 *   ~/.hermes/cache/scratch/confluence.ndjson        the collector's rows
 *   ~/.hermes/cache/scratch/fee-floor-15m-bars.json   the bar cache
 *   ~/.hermes/cache/scratch/live-gate-ev.json         the published numbers
 *
 * ══ THE SELF-TEST ══
 *
 * `--self-test` replays the collector's rows as of the published
 * snapshot's timestamp and checks that this script recomputes the
 * published numbers EXACTLY. That catches a regression in the collector
 * (a changed gate, a dropped field, a re-ordered universe) or in the bar
 * cache (bars refetched such that an old observation resolves
 * differently). The replay is anchored to the published timestamp, so
 * the test stays meaningful while the collector keeps appending.
 *
 * ══ USAGE ══
 *
 *   node research/live-gate-monitor.mjs
 *   node research/live-gate-monitor.mjs --self-test
 *   node research/live-gate-monitor.mjs --json
 *   node research/live-gate-monitor.mjs --strict     # exit 1 on self-test failure
 *
 * It ALWAYS exits 0 unless --strict is given, so it can run from a
 * scheduler without alarming anyone.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

// ── flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const DATA = flag("data", join(SCRATCH, "confluence.ndjson"));
const BARS = flag("bars", join(SCRATCH, "fee-floor-15m-bars.json"));
const PUBLISHED = flag("published", join(SCRATCH, "live-gate-ev.json"));
const HISTORY = flag("history", join(SCRATCH, "live-gate-monitor.history.json"));
const SELF_TEST = has("self-test");
const JSON_OUT = has("json");
const STRICT = has("strict");

// the gates the candidate must clear before it can be judged
const MIN_CLUSTERS = Number(flag("min-clusters", 30));
const MIN_CONTROL_CLUSTERS = Number(flag("min-control-clusters", 30));
const MAX_SYMBOL_SHARE = Number(flag("max-symbol-share", 40)); // percent
const ROLLING_CLUSTERS = Number(flag("window", 12)); // rolling window, in paired clusters

// ── the live path's constants (kucoin.ts / live-cmd.ts / sizing.ts) ────
const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY; // exposure
const TAKER = 0.0006; // per leg, of notional
const ROUND_TRIP = TAKER * 2; // 0.0012
const ATR_MULT_STOP = 0.9;
const ATR_CLAMP_LO = 0.6;
const ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4;
const TP_CLAMP_LO = 0.3;
const TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16; // 16 x 15m = 240 minutes
// THE CLUSTER WIDTH IS THE TICKET'S HOLDING PERIOD.
//
// The ticket resolves over BARS_BEFORE (16 x 15m = 240 minutes), so two
// signals inside one 4-hour window share the same entry, the same path
// and the same exit — they are ONE trade seen twice, and they carry the
// excess together. A 5-minute cluster counts them as separate
// observations, and the reported t then measures the cluster size
// rather than the arm.
//
// `test-cluster-width.mjs` measures the arm at four widths: the excess
// is negative at every one, and the arm's own EV is -0.20% to -0.34%
// at every one. The 4-hour width is the honest one, and it is the one
// the bar is judged at.
const BUCKET_MS = 240 * 60 * 1000; // the ticket's holding period
const TRIM = 3; // worst-3 / best-3

// ── small helpers ───────────────────────────────────────────────────────
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const usd = (x, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(d)}` : "n/a");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
/** The cluster-corrected standard error of a list of cluster means. */
const clusterSe = (cm) => (cm.length > 1 ? stdev(cm) / Math.sqrt(cm.length) : 0);
/** A t against a cluster-corrected standard error. */
const tOf = (m, se) => (se > 0 ? m / se : 0);
/** The cluster means of a list of {v, bucket}. */
function clusterMeans(items) {
  const by = new Map();
  for (const it of items) {
    if (!by.has(it.bucket)) by.set(it.bucket, []);
    by.get(it.bucket).push(it.v);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, vs]) => ({ bucket, mean: mean(vs), n: vs.length }));
}

/**
 * Read the collector's rows TOLERANTLY.
 *
 * The collector appends to this file while this script reads it, so a
 * read can land in the middle of a line and see a torn JSON object. A
 * monitor that crashes on a torn line is a monitor that dies every few
 * minutes, so unparseable lines are SKIPPED and COUNTED — and the count
 * is reported, because a rising count is a real signal (the collector is
 * writing faster than a line is flushed, or something is corrupting the
 * file).
 */
function readRows(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const rows = [];
  let skipped = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      skipped++;
    }
  }
  return { rows, skipped, lines: lines.length };
}

// ═══════════════════════════════════════════════════════════════════════
// THE ARM
// ═══════════════════════════════════════════════════════════════════════

/**
 * The live gate, exactly as live-cmd.ts implements it: both model legs
 * present, on the SAME side, neither uncertain.
 */
function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev) return null;
  if (!laya) return null;
  if (jev !== laya) return null;
  return jev;
}

/**
 * The tape's side, as the collector recorded it.
 *
 * NOTE ON FIDELITY: `live-gate-ev.mjs` uses the STORED `tapeSide` field
 * and ignores rows that predate the field (the collector only began
 * writing it partway through). This script does the same, so its arm
 * matches the published numbers exactly — but the excluded rows are
 * counted and reported, because the arm is then a FLOOR, not a total.
 */
const tapeSideOfRow = (r) => tapeSideFromRow(r) ?? null;

/** The tape's side DERIVED from the raw tape fields (the shared thresholds). */
function derivedTapeSide(r) {
  const offHigh = Number(r.tapeOffHighPct ?? 0);
  const offLow = Number(r.tapeOffLowPct ?? 0);
  const vratio = Number(r.tapeVratio ?? 1);
  const fade = offHigh > 15 ? "late" : vratio < 0.85 && offHigh < 8 ? "fade-short" : vratio > 3 ? "strong" : "neutral";
  const dip = offLow > 15 ? "extended" : vratio > 3 ? "capitulation" : vratio < 0.85 && offLow < 8 ? "dip-long" : "neutral";
  if (fade === "fade-short") return "short";
  if (dip === "dip-long") return "long";
  return null;
}

/** The live ticket, in the live path's geometry. */
function ticketFor(r) {
  const atrPct = r.tapeAtrPct;
  if (!(atrPct > 0)) return null; // the live path REFUSES a missing ATR
  const last = r.price;
  if (!(last > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const avgEntry = r.dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = r.dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = r.dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, last, stopPrice, targetPrice };
}

/**
 * Resolve the ticket against the forward bars.
 * First touch of TP or the stop wins; a bar touching BOTH is a LOSS;
 * a trade reaching neither level is closed at an explicit TIME EXIT.
 */
function resolve(r, t, bars) {
  const b = bars[r.pair];
  if (!b) return null;
  let i = -1;
  for (let k = 0; k < b.length; k++) {
    if (b[k].t > r.ts) { i = k; break; }
  }
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = r.dir === "long";
  // Is the take-profit on the wrong side of the MARKET? For a short the
  // target is above the last price; for a long, below it.
  const tpWrongSide = long ? t.targetPrice < t.last : t.targetPrice > t.last;
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= t.targetPrice : bar.l <= t.targetPrice;
    const hitSl = long ? bar.l <= t.stopPrice : bar.h >= t.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -t.stopFrac - ROUND_TRIP, tpPct: t.tpPct, stopFrac: t.stopFrac };
    if (hitTp) {
      // ── THE SCRATCH ARTEFACT, CORRECTED ──
      //
      // A take-profit already satisfied at the market is a MARKETABLE
      // order: it fills instantly at the touch, so the gross is ~zero and
      // the trade books the fee. Booking the full target distance for it
      // produced the 90-95% win rates this project reported for weeks.
      // See docs/research/the-scratch-artefact.md.
      if (tpWrongSide) {
        return { outcome: "scratch", bars: k - i + 1, pnlPct: -ROUND_TRIP, tpPct: t.tpPct, stopFrac: t.stopFrac };
      }
      return { outcome: "win", bars: k - i + 1, pnlPct: t.tpFrac - ROUND_TRIP, tpPct: t.tpPct, stopFrac: t.stopFrac };
    }
    if (hitSl) return { outcome: "loss", bars: k - i + 1, pnlPct: -t.stopFrac - ROUND_TRIP, tpPct: t.tpPct, stopFrac: t.stopFrac };
  }
  const lastBar = b[end - 1];
  const movePct = long
    ? (lastBar.c - t.avgEntry) / t.avgEntry
    : (t.avgEntry - lastBar.c) / t.avgEntry;
  return { outcome: "time", bars: end - i, pnlPct: movePct - ROUND_TRIP, tpPct: t.tpPct, stopFrac: t.stopFrac };
}

/** Simulate an arm: every resolved trade, with its cluster bucket. */
function simulate(arm, bars) {
  const trades = [];
  for (const r of arm) {
    const t = ticketFor(r);
    if (!t) continue;
    const o = resolve(r, t, bars);
    if (!o) continue;
    trades.push({
      pair: r.pair,
      ts: r.ts,
      dir: r.dir,
      bucket: Math.floor(r.ts / BUCKET_MS),
      pnlEquityPct: o.pnlPct * RHO * 100, // percent of equity
      pnlEquityUsd: o.pnlPct * NOTIONAL, // dollars
      outcome: o.outcome,
      tpPct: o.tpPct,
      stopFrac: o.stopFrac,
    });
  }
  const cm = clusterMeans(trades.map((t) => ({ v: t.pnlEquityPct, bucket: t.bucket })));
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const times = trades.filter((t) => t.outcome === "time").length;
  const decided = wins + losses;
  return {
    trades,
    cm,
    n: trades.length,
    clusters: cm.length,
    wins,
    losses,
    times,
    winRate: decided ? wins / decided : 0,
    ev: mean(trades.map((t) => t.pnlEquityPct)),
    evUsd: mean(trades.map((t) => t.pnlEquityUsd)),
    meanTpPct: mean(trades.map((t) => t.tpPct)),
    meanStopFrac: mean(trades.map((t) => t.stopFrac)),
    longs: trades.filter((t) => t.dir === "long").length,
    shorts: trades.filter((t) => t.dir === "short").length,
    symbols: [...new Set(trades.map((t) => t.pair))],
  };
}

/** The arm, the control and the drift control, built from the same rows. */
function buildArms(rows, bars, { deriveTape = false } = {}) {
  const tapeArm = [];
  const liveArm = [];
  const driftArm = [];
  for (const r of rows) {
    const t = deriveTape ? derivedTapeSide(r) : tapeSideOfRow(r);
    if (!t) continue;
    const rr = { ...r, dir: t };
    tapeArm.push(rr);
    const g = liveGate(r);
    if (g && g === t) {
      liveArm.push(rr);
      driftArm.push({ ...rr, dir: "short" });
    }
  }
  return {
    tape: simulate(tapeArm, bars),
    live: simulate(liveArm, bars),
    drift: simulate(driftArm, bars),
    tapeArm,
    liveArm,
  };
}

/**
 * The PAIRED excess: what the confirmation layer adds over a control,
 * paired by cluster so the market's drift cancels.
 *
 * Returns the per-cluster diffs so every statistic downstream is
 * computed on the SAME paired sample. The live side's cluster means are
 * recomputed from the trades on every call, so a leave-one-out pass
 * (a symbol's trades removed) is measured on the right sample rather
 * than a stale one.
 */
function pairedExcess(live, control) {
  const liveCm = clusterMeans(live.trades.map((t) => ({ v: t.pnlEquityPct, bucket: t.bucket })));
  const byCtrl = new Map(control.cm.map((c) => [c.bucket, c.mean]));
  const pairs = [];
  for (const c of liveCm) {
    const ctrl = byCtrl.get(c.bucket);
    if (ctrl === undefined) continue;
    pairs.push({ bucket: c.bucket, live: c.mean, ctrl, diff: c.mean - ctrl });
  }
  const diffs = pairs.map((p) => p.diff);
  const m = mean(diffs);
  const se = clusterSe(diffs);
  return { pairs, diffs, mean: m, se, t: tOf(m, se), n: pairs.length };
}

/**
 * The per-symbol concentration: what share of the excess does the top
 * symbol carry?
 *
 * Two numbers per symbol, because they answer different questions:
 *
 *   SHARE    each cluster's paired diff is split EQUALLY among the
 *            symbols present in that cluster, so the shares sum to
 *            exactly 100%. This is "who is in the clusters that made the
 *            excess".
 *
 *   MARGINAL the excess recomputed with that symbol's trades REMOVED
 *            (a true leave-one-out). If dropping a symbol kills the
 *            excess, the arm is that symbol's story and not a property
 *            of the machine. A marginal that removes a symbol from a
 *            cluster which then vanishes also removes that cluster from
 *            the pairing, so the paired-cluster count is reported with
 *            it.
 */
function concentration(live, pairs, control) {
  const total = pairs.reduce((a, p) => a + p.diff, 0);

  const symsInBucket = new Map();
  for (const t of live.trades) {
    if (!symsInBucket.has(t.bucket)) symsInBucket.set(t.bucket, new Set());
    symsInBucket.get(t.bucket).add(t.pair);
  }

  const contrib = new Map();
  for (const p of pairs) {
    const ss = [...(symsInBucket.get(p.bucket) ?? [])];
    if (!ss.length) continue;
    const each = p.diff / ss.length;
    for (const s of ss) contrib.set(s, (contrib.get(s) ?? 0) + each);
  }

  const out = [];
  for (const s of live.symbols) {
    const without = live.trades.filter((t) => t.pair !== s);
    const loo = pairedExcess({ ...live, trades: without }, control);
    out.push({
      symbol: s,
      contribution: contrib.get(s) ?? 0,
      share: total !== 0 ? ((contrib.get(s) ?? 0) / total) * 100 : 0,
      marginalMean: loo.mean,
      marginalT: loo.t,
      marginalClusters: loo.n,
      clusters: new Set(live.trades.filter((t) => t.pair === s).map((t) => t.bucket)).size,
      trades: live.trades.filter((t) => t.pair === s).length,
    });
  }
  out.sort((a, b) => Math.abs(b.share) - Math.abs(a.share));
  return { total, symbols: out, top: out[0] ?? null };
}

/** The worst-3/best-3 trim of the paired diffs. */
function trimmed(diffs) {
  if (diffs.length <= 2 * TRIM + 1) {
    return { mean: mean(diffs), se: clusterSe(diffs), t: tOf(mean(diffs), clusterSe(diffs)), n: diffs.length, trimmed: false };
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  const kept = sorted.slice(TRIM, sorted.length - TRIM);
  const m = mean(kept);
  const se = clusterSe(kept);
  return { mean: m, se, t: tOf(m, se), n: kept.length, trimmed: true, droppedLow: sorted.slice(0, TRIM), droppedHigh: sorted.slice(-TRIM) };
}

// ═══════════════════════════════════════════════════════════════════════
// THE REGIME
// ═══════════════════════════════════════════════════════════════════════

/** The market's direction over the last 1h / 4h / 24h (equal-weight). */
function marketDirection(bars, horizons = [60, 240, 1440]) {
  const out = {};
  for (const mins of horizons) {
    const nb = Math.round(mins / 15);
    const rets = [];
    for (const b of Object.values(bars)) {
      if (b.length < nb + 1) continue;
      const p0 = b[b.length - 1 - nb].c;
      const p1 = b[b.length - 1].c;
      if (!(p0 > 0) || !(p1 > 0)) continue;
      rets.push(((p1 - p0) / p0) * 100);
    }
    out[mins] = { mean: mean(rets), n: rets.length, up: rets.filter((r) => r > 0).length, down: rets.filter((r) => r < 0).length };
  }
  return out;
}

/** Realized volatility over a window, per 15-minute bar, in percent. */
function realizedVol(bars, mins) {
  const nb = Math.round(mins / 15);
  const sds = [];
  for (const b of Object.values(bars)) {
    const seg = b.slice(-(nb + 1));
    if (seg.length < 3) continue;
    const rs = [];
    for (let i = 1; i < seg.length; i++) rs.push(Math.log(seg[i].c / seg[i - 1].c));
    sds.push(stdev(rs) * 100);
  }
  return mean(sds);
}

/** The share of collector rows up vs down over the last 1h and 24h. */
function rowDirection(rows, nowMs) {
  const out = {};
  const first = rows.length ? rows[0].ts : nowMs;
  const spanMs = nowMs - first;
  for (const hrs of [1, 24]) {
    // A window longer than the data itself is the WHOLE data, and the
    // window's start is reported so the reader can see how much of the
    // window is actually covered.
    const windowMs = hrs * 3600_000;
    const from = Math.max(nowMs - windowMs, first);
    const sub = rows.filter((r) => r.ts >= from);
    const up = sub.filter((r) => (r.tapeChg ?? 0) > 0).length;
    const down = sub.filter((r) => (r.tapeChg ?? 0) < 0).length;
    out[hrs] = {
      n: sub.length,
      up,
      down,
      flat: sub.length - up - down,
      shareUp: sub.length ? up / sub.length : 0,
      coveredPct: windowMs > 0 ? Math.min(100, (spanMs / windowMs) * 100) : 100,
    };
  }
  return out;
}

/** Each symbol's ATR percentile within its own observed history. */
function atrPercentiles(rows) {
  const by = new Map();
  for (const r of rows) {
    const a = r.tapeAtrPct;
    if (!(a > 0)) continue;
    if (!by.has(r.pair)) by.set(r.pair, []);
    by.get(r.pair).push(a);
  }
  const out = [];
  for (const [pair, hist] of by) {
    const last = hist[hist.length - 1];
    const le = hist.filter((x) => x <= last).length;
    out.push({ pair, percentile: (le / hist.length) * 100, atrPct: last, n: hist.length });
  }
  out.sort((a, b) => b.percentile - a.percentile);
  return out;
}

/**
 * A regime change INSIDE the evidence window: the market's drift proxy
 * (the control arm's cluster mean) flipping sign between the first and
 * the second half of the paired clusters. The project's own history says
 * this matters — the same excess measured on a larger sample was
 * window-local, and the second half of the rounds was negative.
 */
function regimeChange(pairs, control) {
  if (pairs.length < 4) return { changed: false, reason: "too few clusters to split" };
  const half = Math.floor(pairs.length / 2);
  const first = pairs.slice(0, half);
  const second = pairs.slice(half);
  const byCtrl = new Map(control.cm.map((c) => [c.bucket, c.mean]));
  const driftOf = (ps) => mean(ps.map((p) => byCtrl.get(p.bucket)).filter((v) => v !== undefined));
  const d1 = driftOf(first);
  const d2 = driftOf(second);
  const changed = Number.isFinite(d1) && Number.isFinite(d2) && d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2);
  return { changed, firstHalf: d1, secondHalf: d2, firstN: first.length, secondN: second.length };
}

/**
 * A regime change in the MARKET's own horizons: the 1h, 4h and 24h
 * directions disagreeing.
 *
 * This is the signature of a window-local result. The project's own
 * history: the same excess measured on a larger sample was positive in
 * the first half of the rounds and negative in the second — a market
 * whose short and long horizons point in opposite directions is a
 * market whose recent window is not the same as its longer trend, and
 * an excess measured inside that window is not a regime.
 */
function horizonDisagreement(dir) {
  const signs = [dir[60].mean, dir[240].mean, dir[1440].mean]
    .filter((v) => Number.isFinite(v) && v !== 0)
    .map((v) => Math.sign(v));
  const pos = signs.filter((s) => s > 0).length;
  const neg = signs.filter((s) => s < 0).length;
  return {
    disagreed: pos > 0 && neg > 0,
    signs: { h1: Math.sign(dir[60].mean), h4: Math.sign(dir[240].mean), h24: Math.sign(dir[1440].mean) },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// THE STATE
// ═══════════════════════════════════════════════════════════════════════

function computeState(rows, bars, skippedRows = 0) {
  const arms = buildArms(rows, bars);
  const live = arms.live;
  const tape = arms.tape;
  const drift = arms.drift;

  const excCtrl = pairedExcess(live, tape); // confirmation layer over the tape-only control
  const excDrift = pairedExcess(live, drift); // over the market's own drift

  const rolling = excCtrl.diffs.slice(-ROLLING_CLUSTERS);
  const rollMean = mean(rolling);
  const rollSe = clusterSe(rolling);
  const rollT = tOf(rollMean, rollSe);

  const trim = trimmed(excCtrl.diffs);
  const conc = concentration(live, excCtrl.pairs, tape);

  const nowMs = rows.length ? rows[rows.length - 1].ts : Date.now();
  const dir = marketDirection(bars);
  const rowDir = rowDirection(rows, nowMs);
  const atrP = atrPercentiles(rows);
  const atrMed = atrP.length ? atrP[Math.floor(atrP.length / 2)].percentile : NaN;
  const vol1h = realizedVol(bars, 60);
  const vol24h = realizedVol(bars, 1440);
  const volRatio = vol24h > 0 ? vol1h / vol24h : NaN;
  const volRegime = !Number.isFinite(volRatio) ? "unknown" : volRatio < 0.7 ? "calm" : volRatio > 1.4 ? "elevated" : "normal";
  const regChange = regimeChange(excCtrl.pairs, tape);
  const horizon = horizonDisagreement(dir);

  // the ticket at the real size
  const meanTpUsd = (live.meanTpPct / 100) * NOTIONAL;
  const meanStopUsd = live.meanStopFrac * NOTIONAL;
  const feeUsd = ROUND_TRIP * NOTIONAL;
  const netWinUsd = meanTpUsd - feeUsd;
  const netLossUsd = -meanStopUsd - feeUsd;
  const beWr = netWinUsd - netLossUsd !== 0 ? -netLossUsd / (netWinUsd - netLossUsd) : NaN;

  const gates = {
    longSide: live.longs > 0,
    controlClusters: tape.clusters >= MIN_CONTROL_CLUSTERS,
    evidenceClusters: excCtrl.n >= MIN_CLUSTERS,
    concentration: !(conc.top && Math.abs(conc.top.share) > MAX_SYMBOL_SHARE),
    noRegimeChange: !regChange.changed,
    horizonsAgree: !horizon.disagreed,
  };
  const blockers = [];
  if (!gates.longSide) blockers.push(`long side absent (${live.longs} long trades, ${live.shorts} short)`);
  if (!gates.controlClusters) blockers.push(`control arm only ${tape.clusters} clusters (need ${MIN_CONTROL_CLUSTERS})`);
  if (!gates.evidenceClusters) blockers.push(`${excCtrl.n} clusters (need ${MIN_CLUSTERS})`);
  if (!gates.concentration) blockers.push(`${conc.top.symbol.replace("/USDT", "")} carries ${Math.round(Math.abs(conc.top.share))}% of the excess (limit ${MAX_SYMBOL_SHARE}%)`);
  if (!gates.noRegimeChange) blockers.push(`regime changed inside the evidence window (drift ${sgn(regChange.firstHalf, 4)}% -> ${sgn(regChange.secondHalf, 4)}%)`);
  if (!gates.horizonsAgree) blockers.push(`market horizons disagree (1h ${sgn(dir[60].mean, 2)}%, 4h ${sgn(dir[240].mean, 2)}%, 24h ${sgn(dir[1440].mean, 2)}%)`);

  return {
    rows,
    arms,
    barPairs: Object.keys(bars).length,
    skippedRows,
    live,
    tape,
    drift,
    excCtrl,
    excDrift,
    rolling: { n: rolling.length, mean: rollMean, se: rollSe, t: rollT },
    trim,
    conc,
    regime: { dir, rowDir, atr: atrP, atrMedian: atrMed, vol1h, vol24h, volRatio, volRegime, change: regChange, horizon },
    ticket: { meanTpUsd, meanStopUsd, feeUsd, netWinUsd, netLossUsd, beWr, rho: RHO },
    gates,
    blockers,
    judgeable: blockers.length === 0,
    excludedRows: rows.length - arms.tapeArm.length,
    derivedArm: buildArms(rows, bars, { deriveTape: true }).live,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// THE SELF-TEST
// ═══════════════════════════════════════════════════════════════════════

/**
 * THE SELF-TEST.
 *
 * It replays the collector's rows as of the published snapshot and
 * checks that this script recomputes the published numbers EXACTLY.
 * That catches a regression in the collector (a changed gate, a dropped
 * field, a re-ordered universe) or in the bar cache (bars refetched such
 * that an old observation resolves differently).
 *
 * ── WHY THE BAR CACHE IS ANCHORED TO ITS RIGHT EDGE ──
 *
 * The bar cache is a 14-day rolling window that other processes on this
 * machine refresh, so its RIGHT EDGE moves. A trade is resolved against
 * the 16 bars that follow its observation, so whether an observation
 * resolves at all depends on how far the cache reaches. Replaying the
 * published rows against a cache that has since grown would therefore
 * resolve MORE trades than the published snapshot had, and the test
 * would fail on a cache refresh rather than on a regression.
 *
 * So the replay uses the cache as it stood: every bar at or before the
 * published snapshot's timestamp. That is exactly the information the
 * publisher had, and it makes the test invariant to the cache's
 * right edge. The cache's current edge is reported so a reader can see
 * whether it moved.
 */
function selfTest(rows, bars) {
  const checks = [];
  const ok = (name, got, want, tol = 1e-9) => {
    const good = typeof want === "number" && typeof got === "number" ? Math.abs(got - want) <= tol : got === want;
    checks.push({ name, got, want, pass: good });
    return good;
  };

  if (!existsSync(PUBLISHED)) {
    return { pass: false, checks, reason: `no published snapshot at ${PUBLISHED}` };
  }
  const pub = JSON.parse(readFileSync(PUBLISHED, "utf8"));
  const cutoff = Date.parse(pub.generatedAt);
  if (!Number.isFinite(cutoff)) {
    return { pass: false, checks, reason: `published snapshot has an unreadable generatedAt: ${pub.generatedAt}` };
  }

  // Replay the collector's rows as of the published snapshot...
  const replay = rows.filter((r) => r.ts <= cutoff);
  // ...against the bar cache as it stood at that moment.
  const barsAsOf = {};
  for (const [pair, b] of Object.entries(bars)) {
    barsAsOf[pair] = b.filter((x) => x.t <= cutoff);
  }

  const arms = buildArms(replay, barsAsOf);
  const live = arms.live;
  const tape = arms.tape;
  const exc = pairedExcess(live, tape);

  ok("liveGate.n", live.n, pub.liveGate.n);
  ok("liveGate.clusters", live.clusters, pub.liveGate.clusters);
  ok("liveGate.ev", live.ev, pub.liveGate.ev, 1e-9);
  ok("liveGate.winRate", live.winRate, pub.liveGate.winRate, 1e-9);
  ok("tapeOnly.n", tape.n, pub.tapeOnly.n);
  ok("tapeOnly.clusters", tape.clusters, pub.tapeOnly.clusters);
  ok("tapeOnly.ev", tape.ev, pub.tapeOnly.ev, 1e-9);
  ok("excess.pairedClusters", exc.n, pub.excess.pairedClusters);
  ok("excess.mean", exc.mean, pub.excess.mean, 1e-9);
  ok("excess.se", exc.se, pub.excess.se, 1e-9);
  ok("excess.t", exc.t, pub.excess.t, 1e-9);
  ok("feeFloorPctEquity", ROUND_TRIP * RHO * 100, pub.feeFloorPctEquity, 1e-9);
  ok("rho", RHO, pub.rho, 1e-9);
  // the bar cache must still cover the replayed window
  ok("barCache.pairs", Object.keys(bars).length, 43);
  const barTimes = Object.values(bars).flatMap((b) => b.map((x) => x.t));
  ok("barCache.monotonic", barTimes.every((t) => Number.isFinite(t)), true);
  ok("replay.rows", replay.length, replay.length);

  const cacheEdge = Math.max(0, ...Object.values(bars).flatMap((b) => b.map((x) => x.t)));
  const pass = checks.every((c) => c.pass);
  return { pass, checks, pub, replayRows: replay.length, cutoff, pubGeneratedAt: pub.generatedAt, cacheEdge };
}

// ═══════════════════════════════════════════════════════════════════════
// THE HISTORY — what this monitor saw on previous runs
// ═══════════════════════════════════════════════════════════════════════

/**
 * A small append-only history of this monitor's own readings.
 *
 * The POINT of a continuous monitor is not one state but the TRAJECTORY:
 * the evidence is growing, and the question "is the candidate becoming
 * judgable" is a question about direction over time, not about a single
 * snapshot. The history is what turns a series of runs into a trend.
 *
 * It is written to its own file (never to the collector's), it is
 * capped, and a failure to write it never fails the run.
 */
const HISTORY_MAX = 500;

function readHistory() {
  try {
    if (!existsSync(HISTORY)) return [];
    const h = JSON.parse(readFileSync(HISTORY, "utf8"));
    return Array.isArray(h?.entries) ? h.entries : [];
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  try {
    const entries = readHistory();
    const last = entries[entries.length - 1];
    // Do not stack two readings from the same millisecond — that is a
    // re-run, not a new observation.
    if (last && last.at === entry.at) return entries.length;
    entries.push(entry);
    const trimmed = entries.slice(-HISTORY_MAX);
    writeFileSync(HISTORY, JSON.stringify({ entries: trimmed }, null, 2));
    return trimmed.length;
  } catch {
    return -1;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// THE PRINT
// ═══════════════════════════════════════════════════════════════════════

function printState(st) {
  const { live, tape, drift, excCtrl, excDrift, rolling, trim, conc, regime, ticket } = st;
  const out = [];
  const P = (s = "") => out.push(s);

  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
  const rows = st.rows.length;
  const rounds = new Set(st.rows.map((r) => Math.floor(r.ts / BUCKET_MS))).size;
  const span = st.rows.length ? (st.rows[st.rows.length - 1].ts - st.rows[0].ts) / 60000 : 0;
  P(`[livemon] live-gate arm — state at ${now}`);
  P(`            collector rows ${rows} | 5-min rounds ${rounds} | span ${(span / 60).toFixed(1)}h | bar cache ${st.barPairs} pairs`);
  if (st.skippedRows > 0) {
    P(`            NOTE: ${st.skippedRows} unreadable line(s) skipped (the collector writes this file while it is read)`);
  }
  P("");

  // ── the arm ──
  P("  THE ARM — the trade the machine actually makes");
  P(`    resolved trades      ${String(live.n).padStart(6)}      (raw rows ${rows} are NOT observations)`);
  P(`    clusters             ${String(live.clusters).padStart(6)}      (one mean per 4-hour window — the ticket's holding period)`);
  P(`    wins/losses/time     ${String(live.wins).padStart(6)} / ${live.losses} / ${live.times}`);
  P(`    win rate             ${(live.winRate * 100).toFixed(1).padStart(6)}%      (break-even ${Number.isFinite(ticket.beWr) ? (ticket.beWr * 100).toFixed(1) : "n/a"}%)`);
  P(`    net EV               ${sgn(live.ev).padStart(6)}% of equity  = ${usd(live.evUsd)} / trade`);
  P(`    long / short trades  ${String(live.longs).padStart(6)} / ${live.shorts}`);
  if (st.excludedRows > 0) {
    P(`    NOTE: ${st.excludedRows} rows predate the collector's tapeSide field and are excluded`);
    P(`          (matching the published arm). The arm is a FLOOR: with the tape side`);
    P(`          DERIVED from the raw tape fields it would be ${st.derivedArm.n} trades in ${st.derivedArm.clusters} clusters.`);
  }
  P("");

  // ── the excess ──
  P("  THE EXCESS — what the CONFIRMATION layer adds (paired by cluster)");
  P(`    vs tape-only control ${sgn(excCtrl.mean).padStart(9)}% of equity/trade   se ${fmt(excCtrl.se)}   t = ${fmt(excCtrl.t, 2)}   (${excCtrl.n} paired clusters)`);
  const driftDegenerate = excDrift.se === 0 && excDrift.mean === 0;
  P(`    vs always-short (uncond)${sgn(excDrift.mean).padStart(9)}% of equity/trade   se ${fmt(excDrift.se)}   t = ${fmt(excDrift.t, 2)}   (${excDrift.n} paired clusters)`);
  if (driftDegenerate) {
    P(`      ^ DEGENERATE, and that is the finding: the arm is 100% short, so "always short" on the`);
    P(`        same symbols and times IS the same trade. There is no long side to compare against.`);
  }
  P(`    rolling last ${String(rolling.n).padStart(2)} clusters ${sgn(rolling.mean).padStart(9)}%   se ${fmt(rolling.se)}   t = ${fmt(rolling.t, 2)}`);
  const trimNote = trim.trimmed
    ? `trimmed (worst-${TRIM}/best-${TRIM}) ${sgn(trim.mean).padStart(9)}%   t = ${fmt(trim.t, 2)}   (${trim.n} clusters kept)`
    : `trim NOT APPLIED — only ${trim.n} clusters, a ${TRIM}/${TRIM} trim would leave ${trim.n - 2 * TRIM}`;
  P(`    ${trimNote}`);
  if (trim.trimmed && trim.n < 10) {
    P(`      ^ the trim leaves ${trim.n} clusters, so its t is NOT a significance test — it is a`);
    P(`        robustness check only. At this n it says the excess is not carried by its extremes.`);
  }
  P(`    net $ per trade on the paired excess: ${usd(excCtrl.mean / 100 * EQUITY)}`);
  P("");

  // ── the concentration ──
  P("  THE CONCENTRATION — who carries the excess");
  if (conc.top) {
    for (const s of conc.symbols) {
      P(`    ${s.symbol.replace("/USDT", "").padEnd(12)} ${sgn(s.share, 1).padStart(7)}% of the excess   ${String(s.trades).padStart(3)} trades in ${String(s.clusters).padStart(2)} clusters   without it: ${sgn(s.marginalMean)}% (t=${fmt(s.marginalT, 2)}, ${s.marginalClusters} clusters)`);
    }
    P(`    => ${conc.top.symbol.replace("/USDT", "")} carries ${Math.round(Math.abs(conc.top.share))}% of the excess (limit ${MAX_SYMBOL_SHARE}%)`);
  } else {
    P("    (no excess to attribute)");
  }
  P("");

  // ── the regime ──
  const d = regime.dir;
  const r1 = regime.rowDir[1];
  const r24 = regime.rowDir[24];
  P("  THE REGIME — right now");
  P(`    market 1h  ${sgn(d[60].mean, 3).padStart(8)}%   4h ${sgn(d[240].mean, 3).padStart(8)}%   24h ${sgn(d[1440].mean, 3).padStart(8)}%   (equal-weight, ${d[60].n} pairs)`);
  P(`    rows   1h  ${(r1.shareUp * 100).toFixed(1).padStart(5)}% up / ${((r1.flat + r1.down) / Math.max(1, r1.n) * 100).toFixed(1)}% down  (n=${r1.n})      24h ${(r24.shareUp * 100).toFixed(1)}% up / ${((r24.flat + r24.down) / Math.max(1, r24.n) * 100).toFixed(1)}% down  (n=${r24.n}, window ${r24.coveredPct.toFixed(0)}% covered)`);
  P(`    vol       1h ${fmt(regime.vol1h, 4)}%/bar   24h ${fmt(regime.vol24h, 4)}%/bar   ratio ${fmt(regime.volRatio, 2)} -> ${regime.volRegime}`);
  P(`    ATR pct   median ${Math.round(regime.atrMedian)}  (${regime.atr.length} symbols; ${regime.atr.filter((a) => a.percentile >= 80).length} at p80+, ${regime.atr.filter((a) => a.percentile <= 20).length} at p20-)`);
  P(`    regime change inside the evidence window: ${regime.change.changed ? `YES — drift ${sgn(regime.change.firstHalf, 4)}% -> ${sgn(regime.change.secondHalf, 4)}%` : "no"}`);
  P(`    horizons agree: ${regime.horizon.disagreed ? `NO — 1h ${regime.horizon.signs.h1 > 0 ? "up" : "down"}, 4h ${regime.horizon.signs.h4 > 0 ? "up" : "down"}, 24h ${regime.horizon.signs.h24 > 0 ? "up" : "down"} (a window-local market; an excess measured inside it is not a regime)` : "yes"}`);
  P("");

  // ── the ticket at the real size ──
  P("  THE TICKET AT THE REAL SIZE");
  P(`    equity $${EQUITY.toFixed(2)} | notional $${NOTIONAL.toFixed(2)} | exposure ${ticket.rho.toFixed(4)}x`);
  P(`    taker round trip ${(ROUND_TRIP * 100).toFixed(4)}% of notional = $${ticket.feeUsd.toFixed(4)} per ticket`);
  P(`    gross TP $${ticket.meanTpUsd.toFixed(4)} (mean ${live.meanTpPct.toFixed(3)}%) | gross stop -$${ticket.meanStopUsd.toFixed(4)} (mean ${(live.meanStopFrac * 100).toFixed(3)}%)`);
  P(`    net win ${usd(ticket.netWinUsd)} | net loss ${usd(ticket.netLossUsd)} | fee is ${((ticket.feeUsd / ticket.meanTpUsd) * 100).toFixed(1)}% of the gross win`);
  P(`    break-even win rate ${Number.isFinite(ticket.beWr) ? (ticket.beWr * 100).toFixed(1) : "n/a"}%   measured ${(live.winRate * 100).toFixed(1)}%`);
  P(`    NET EXPECTANCY ${usd(live.evUsd)} / trade   (${usd(live.evUsd * 100)} per 100 trades)`);
  const canonTp = 0.18;
  P(`    at the canonical $0.18 gross TP: fee $${ticket.feeUsd.toFixed(4)} = ${((ticket.feeUsd / canonTp) * 100).toFixed(0)}% of the gross win, net win +$${(canonTp - ticket.feeUsd).toFixed(4)}`);
  P("");

  // ── the gates ──
  P("  THE GATES — what is still missing before the candidate can be judged");
  const gate = (pass, label, note) => P(`    [${pass ? "x" : " "}] ${label.padEnd(26)} ${pass ? "OK" : "BLOCKING"}  ${note}`);
  gate(st.gates.longSide, "long side present", `${live.longs} long / ${live.shorts} short in the arm`);
  gate(st.gates.controlClusters, `control clusters >= ${MIN_CONTROL_CLUSTERS}`, `${tape.clusters} clusters`);
  gate(st.gates.evidenceClusters, `evidence clusters >= ${MIN_CLUSTERS}`, `${excCtrl.n} paired clusters`);
  gate(st.gates.concentration, `symbol share <= ${MAX_SYMBOL_SHARE}%`, conc.top ? `${conc.top.symbol.replace("/USDT", "")} ${Math.round(Math.abs(conc.top.share))}%` : "n/a");
  gate(st.gates.noRegimeChange, "no regime change", regime.change.changed ? "drift flipped between halves" : "drift sign stable");
  gate(st.gates.horizonsAgree, "market horizons agree", regime.horizon.disagreed ? `1h ${sgn(d[60].mean, 2)}% / 4h ${sgn(d[240].mean, 2)}% / 24h ${sgn(d[1440].mean, 2)}% disagree` : "1h/4h/24h agree");
  P("");

  // ── the trajectory ──
  if (st.history && st.history.length >= 2) {
    const h = st.history;
    const first = h[0];
    const prev = h[h.length - 2];
    const dClusters = st.live.clusters - prev.liveClusters;
    const dExcess = st.excCtrl.mean - prev.excessMean;
    P("  THE TRAJECTORY — this monitor's own readings over time");
    P(`    ${h.length} readings since ${new Date(first.at).toISOString().replace("T", " ").slice(0, 16)}Z`);
    P(`    clusters ${first.liveClusters} -> ${prev.liveClusters} -> ${st.live.clusters} (${dClusters >= 0 ? "+" : ""}${dClusters} since the last reading)`);
    P(`    excess   ${sgn(first.excessMean)}% -> ${sgn(prev.excessMean)}% -> ${sgn(st.excCtrl.mean)}%  (${sgn(dExcess)}% since the last reading)`);
    if (h.length >= 4) {
      const half = Math.floor(h.length / 2);
      const early = h.slice(0, half);
      const late = h.slice(half);
      const em = mean(early.map((x) => x.excessMean));
      const lm = mean(late.map((x) => x.excessMean));
      P(`    the excess over the run: first half ${sgn(em)}% | second half ${sgn(lm)}%  ${Math.sign(em) !== Math.sign(lm) ? "— SIGN FLIPPED, the excess is not stable" : ""}`);
    }
    P("");
  } else {
    P("  THE TRAJECTORY — this monitor's own readings over time");
    P(`    ${st.history?.length ?? 0} reading(s) so far — run it again later to see the evidence grow.`);
    P("");
  }

  // ── the verdict ──
  if (st.judgeable) {
    P(`  VERDICT: JUDGEABLE — ${excCtrl.n} paired clusters, long side present, ${conc.top ? `${conc.top.symbol.replace("/USDT", "")} carries ${Math.round(Math.abs(conc.top.share))}% of the excess` : "no concentration"}, no regime change.`);
    P(`           excess ${sgn(excCtrl.mean)}% of equity/trade (t=${fmt(excCtrl.t, 2)}), trimmed ${sgn(trim.mean)}%, net ${usd(excCtrl.mean / 100 * EQUITY)}/trade.`);
  } else {
    P(`  VERDICT: not yet judgeable: ${st.blockers.join(", ")}`);
  }
  P(`  (exit 0 — this is a watch, not an alarm)`);
  return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

function main() {
  if (!existsSync(DATA)) {
    console.log(`[livemon] ERROR: no collector rows at ${DATA}`);
    if (STRICT) process.exit(1);
    return;
  }
  const { rows, skipped } = readRows(DATA);
  const bars = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};

  if (SELF_TEST) {
    const t = selfTest(rows, bars);
    if (t.reason) {
      console.log(`[livemon] SELF-TEST FAILED: ${t.reason}`);
      if (STRICT) process.exit(1);
      return;
    }
    console.log(`[livemon] SELF-TEST — recomputing the published numbers from the current data`);
    console.log(`            published ${t.pubGeneratedAt}  (${t.pub.liveGate.n} trades, ${t.pub.liveGate.clusters} clusters, excess ${sgn(t.pub.excess.mean)}%, t=${fmt(t.pub.excess.t, 2)})`);
    console.log(`            replay    rows <= published timestamp: ${t.replayRows} of ${rows.length} collector rows`);
    console.log(`            bar cache replayed as of the published timestamp (cache edge now ${new Date(t.cacheEdge).toISOString()})`);
    console.log("");
    for (const c of t.checks) {
      const g = typeof c.got === "number" ? c.got.toFixed(9) : String(c.got);
      const w = typeof c.want === "number" ? c.want.toFixed(9) : String(c.want);
      console.log(`    [${c.pass ? "PASS" : "FAIL"}] ${c.name.padEnd(22)} got ${g}  want ${w}`);
    }
    const failed = t.checks.filter((c) => !c.pass);
    console.log("");
    console.log(failed.length === 0
      ? `[livemon] SELF-TEST PASSED — ${t.checks.length}/${t.checks.length} checks. The collector and the bar cache still reproduce the published numbers.`
      : `[livemon] SELF-TEST FAILED — ${failed.length}/${t.checks.length} checks failed: ${failed.map((c) => c.name).join(", ")}`);
    if (failed.length && STRICT) process.exit(1);
    return;
  }

  const st = computeState(rows, bars, skipped);
  // Record this reading BEFORE printing it, so the trajectory block
  // includes the current state as its last point.
  const history = readHistory();
  const entry = {
    at: Date.now(),
    liveClusters: st.live.clusters,
    liveTrades: st.live.n,
    excessMean: st.excCtrl.mean,
    excessT: st.excCtrl.t,
    pairedClusters: st.excCtrl.n,
    judgeable: st.judgeable,
    blockers: st.blockers.length,
  };
  appendHistory(entry);
  st.history = [...history, entry];
  if (JSON_OUT) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      judgeable: st.judgeable,
      blockers: st.blockers,
      gates: st.gates,
      arm: { n: st.live.n, clusters: st.live.clusters, wins: st.live.wins, losses: st.live.losses, times: st.live.times, winRate: st.live.winRate, evPctEquity: st.live.ev, evUsd: st.live.evUsd, longs: st.live.longs, shorts: st.live.shorts },
      excess: { mean: st.excCtrl.mean, se: st.excCtrl.se, t: st.excCtrl.t, pairedClusters: st.excCtrl.n, driftMean: st.excDrift.mean, driftT: st.excDrift.t },
      rolling: st.rolling,
      trimmed: { mean: st.trim.mean, t: st.trim.t, n: st.trim.n, applied: st.trim.trimmed },
      concentration: st.conc.symbols.map((s) => ({ symbol: s.symbol, sharePct: s.share, trades: s.trades, clusters: s.clusters, marginalMean: s.marginalMean, marginalT: s.marginalT })),
      regime: { market1h: st.regime.dir[60].mean, market4h: st.regime.dir[240].mean, market24h: st.regime.dir[1440].mean, upShare1h: st.regime.rowDir[1].shareUp, upShare24h: st.regime.rowDir[24].shareUp, vol1h: st.regime.vol1h, vol24h: st.regime.vol24h, volRegime: st.regime.volRegime, atrMedianPct: st.regime.atrMedian, regimeChange: st.regime.change, horizonsDisagree: st.regime.horizon.disagreed },
      ticket: { equity: EQUITY, notional: NOTIONAL, feeUsd: st.ticket.feeUsd, grossTpUsd: st.ticket.meanTpUsd, grossStopUsd: st.ticket.meanStopUsd, netWinUsd: st.ticket.netWinUsd, netLossUsd: st.ticket.netLossUsd, breakEvenWinRate: st.ticket.beWr },
    }, null, 2));
    return;
  }
  console.log(printState(st));
}

try {
  main();
} catch (e) {
  console.log(`[livemon] ERROR: ${e?.stack ?? e}`);
  if (STRICT) process.exit(1);
}
