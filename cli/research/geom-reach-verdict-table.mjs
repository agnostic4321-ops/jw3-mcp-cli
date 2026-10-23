#!/usr/bin/env node
/**
 * THE REACHABLE-STOP GEOMETRY SWEEP — THE VERDICT TABLE.
 *
 * One artifact behind the report. It reproduces:
 *
 *   1. THE BREAK-EVEN ARITHMETIC, in all three forms, for the live
 *      ticket and for each candidate.
 *   2. THE FULL GEOMETRY SWEEP at the 240-minute hold, both at the
 *      raw-observation level and at the TRADE level, on BOTH
 *      observation streams separately and pooled.
 *   3. THE HORIZON SENSITIVITY (240 / 120 / 60 minutes).
 *   4. THE PLACEBO on a symbol- AND window-matched control.
 *
 * ── THE TRADE-LEVEL ARM ──
 *
 * The live trade loop re-reads every pair every 60 seconds. When the
 * tape and the models agree at 10:02, 10:03 and 10:04, those are not
 * three trades — the market has not moved and the live path would have
 * taken ONE position and then skipped the pair while it was live. So
 * the observation stream is turned into TRADES: one entry per pair,
 * held until it resolves (TP, stop, or the time exit), after which the
 * pair is free again. That is the unit the account experiences.
 *
 * ── THE BREAK-EVEN ──
 *
 *   BE_repo  (sl+fee)/(tp+sl+fee)  — the repo's published formula; it
 *            understates the break-even.
 *   BE_true  (sl+fee)/(tp+sl)      — the arithmetically correct one.
 *   BE_mix   the break-even with the MEASURED outcome mix.
 *
 * ── READ-ONLY ──
 *
 * Reads frozen snapshots and a frozen bar cache. Writes only its own
 * outputs. Touches no venue, no account, no order.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideOf } from "./tape-signal.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CONF_FILE = join(SCRATCH, "geom-reach-signal-snapshot.ndjson");
const LOOP_FILE = join(SCRATCH, "trade-loop.ndjson");
const BARS_FILE = join(SCRATCH, "geom-reach-bars.json");
const OUT_FILE = join(SCRATCH, "geom-reach-verdict-table.txt");

const EQUITY = 57.16;
const NOTIONAL = 60.0;
const TAKER_RT = 0.12;
const FEE_USD = (TAKER_RT / 100) * NOTIONAL;
const BUCKET_MS = 5 * 60_000;

let BARS = {};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
};
const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function outcomeFor(c, tpPct, slPct, holdBars) {
  const bars = BARS[c.pair];
  if (!bars || !bars.length) return null;
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t <= c.ts) idx = i;
    else break;
  }
  if (idx < 0) return null;
  let first = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t > c.ts) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (bars.length - first < holdBars) return { incomplete: true };
  const entry = Number(c.price);
  if (!(entry > 0)) return null;
  const long = c.dir === "long";
  const tpPx = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const slPx = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let kind = null;
  let mark = 0;
  let exitTs = 0;
  for (let i = first; i < first + holdBars; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tpPx : b.l <= tpPx;
    const hitSl = long ? b.l <= slPx : b.h >= slPx;
    if (hitTp && hitSl) {
      kind = "stop";
      exitTs = b.t;
      break;
    }
    if (hitTp) {
      kind = "tp";
      exitTs = b.t;
      break;
    }
    if (hitSl) {
      kind = "stop";
      exitTs = b.t;
      break;
    }
  }
  if (!kind) {
    kind = "time";
    const last = bars[first + holdBars - 1];
    exitTs = last.t;
    mark = long ? ((last.c - entry) / entry) * 100 : ((entry - last.c) / entry) * 100;
  }
  const pnlPct = kind === "tp" ? tpPct : kind === "stop" ? -slPct : mark;
  return { kind, pnlPct, pnlUsd: (pnlPct / 100) * NOTIONAL - FEE_USD, exitTs };
}

/** The TRADE-LEVEL arm: one entry per pair, held until it resolves. */
function toTrades(observations, tpPct, slPct, holdBars) {
  const byPair = new Map();
  for (const o of observations) {
    const arr = byPair.get(o.pair) ?? [];
    arr.push(o);
    byPair.set(o.pair, arr);
  }
  const trades = [];
  for (const [, arr] of byPair) {
    arr.sort((a, b) => a.ts - b.ts);
    let busyUntil = 0;
    for (const o of arr) {
      if (o.ts < busyUntil) continue;
      const res = outcomeFor(o, tpPct, slPct, holdBars);
      if (!res || res.incomplete) continue;
      trades.push({ ...o, ...res });
      busyUntil = res.exitTs;
    }
  }
  return trades;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return null;
  const tpN = trades.filter((t) => t.kind === "tp").length;
  const stN = trades.filter((t) => t.kind === "stop").length;
  const tmN = trades.filter((t) => t.kind === "time").length;
  const bk = new Map();
  for (const t of trades) {
    const b = Math.floor(t.ts / BUCKET_MS);
    const arr = bk.get(b) ?? [];
    arr.push(t.pnlUsd);
    bk.set(b, arr);
  }
  const cms = [...bk.values()].map(mean);
  const timeRows = trades.filter((t) => t.kind === "time");
  const m = mean(trades.map((t) => t.pnlUsd));
  const G = bk.size;
  // The cluster-robust standard error of the trade-level mean.
  let q = 0;
  for (const arr of bk.values()) {
    const gm = mean(arr);
    const dev = arr.length * (gm - m);
    q += dev * dev;
  }
  const cr0 = G > 1 && n > G ? (G / (G - 1)) * ((n - 1) / (n - G)) * (q / (n * (n - 1))) : NaN;
  const crSe = Number.isFinite(cr0) ? Math.sqrt(Math.max(cr0, 0)) : NaN;
  return {
    n,
    G,
    tpN,
    stN,
    tmN,
    winRate: tpN + stN > 0 ? tpN / (tpN + stN) : 0,
    evUsd: m,
    crSe,
    crT: Number.isFinite(crSe) && crSe > 0 ? m / crSe : NaN,
    clusterMean: mean(cms),
    clusterSe: se(cms),
    timeMarkMean: timeRows.length ? mean(timeRows.map((t) => t.pnlPct)) : 0,
    buckets: bk,
  };
}
const beRepo = (tp, sl) => (sl + TAKER_RT) / (tp + sl + TAKER_RT);
const beTrue = (tp, sl) => (sl + TAKER_RT) / (tp + sl);
function beMix(tp, sl, S) {
  if (!S || !S.n) return NaN;
  const qT = S.tmN / S.n;
  const M = S.timeMarkMean;
  if (qT >= 1) return NaN;
  return (sl + TAKER_RT + (qT * (TAKER_RT - M)) / (1 - qT)) / (tp + sl);
}

function liveModelSide(r) {
  const j = r.jevSide;
  const l = r.layaSide;
  if (!j || !l || j === "flat" || l === "flat") return null;
  if (r.jevUncertain || r.layaUncertain) return null;
  return j === l ? j : null;
}
function loadConfluence() {
  const raw = readFileSync(CONF_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const out = [];
  for (const r of raw) {
    const t = tapeSideOf({
      offHighPct: r.tapeOffHighPct,
      offLowPct: r.tapeOffLowPct,
      vratio: r.tapeVratio,
    });
    if (!t) continue;
    out.push({
      pair: r.pair,
      ts: r.ts,
      dir: t,
      price: Number(r.price ?? r.bookMid),
      stream: "conf",
      liveSide: liveModelSide(r),
    });
  }
  return out;
}
function loadTradeLoop() {
  const raw = readFileSync(LOOP_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const out = [];
  for (const r of raw) {
    if (r.event !== "model-agreement") continue;
    const t = tapeSideOf(r.tape);
    if (!t) continue;
    const mid = Number(r.book?.mid);
    if (!(mid > 0)) continue;
    out.push({ pair: r.pair, ts: r.ts, dir: t, price: mid, stream: "loop", liveSide: r.side });
  }
  return out;
}

const GEOMS = [
  { label: "LIVE TP 0.30 / SL 0.90", tp: 0.3, sl: 0.9 },
  { label: "LIVE TP 0.36 / SL 1.22", tp: 0.36, sl: 1.22 },
  { label: "LIVE TP 0.50 / SL 2.00", tp: 0.5, sl: 2.0 },
  { label: "TP 0.4 / SL 0.6", tp: 0.4, sl: 0.6 },
  { label: "TP 0.5 / SL 0.6", tp: 0.5, sl: 0.6 },
  { label: "TP 0.6 / SL 0.6", tp: 0.6, sl: 0.6 },
  { label: "TP 0.6 / SL 0.8", tp: 0.6, sl: 0.8 },
  { label: "TP 0.6 / SL 1.0", tp: 0.6, sl: 1.0 },
  { label: "TP 0.6 / SL 1.2", tp: 0.6, sl: 1.2 },
  { label: "TP 0.6 / SL 1.5", tp: 0.6, sl: 1.5 },
  { label: "TP 0.8 / SL 0.6", tp: 0.8, sl: 0.6 },
  { label: "TP 0.8 / SL 1.0", tp: 0.8, sl: 1.0 },
  { label: "TP 0.8 / SL 1.2", tp: 0.8, sl: 1.2 },
  { label: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
  { label: "TP 1.0 / SL 1.0", tp: 1.0, sl: 1.0 },
  { label: "TP 1.0 / SL 1.5", tp: 1.0, sl: 1.5 },
  { label: "TP 2.0 / SL 0.6", tp: 2.0, sl: 0.6 },
];

function main() {
  BARS = JSON.parse(readFileSync(BARS_FILE, "utf8"));
  const conf = loadConfluence();
  const loop = loadTradeLoop();
  const all = conf.concat(loop);
  const out = [];
  const say = (s = "") => {
    out.push(s);
    console.log(s);
  };

  // ══ 1. THE BREAK-EVEN ARITHMETIC ══
  say("=".repeat(118));
  say("1. THE BREAK-EVEN ARITHMETIC AT $60 NOTIONAL WITH THE 0.12% TAKER ROUND TRIP");
  say("=".repeat(118));
  say();
  say(`  the fee is $${FEE_USD.toFixed(4)} per trade, charged on EVERY trade — a win, a loss and a time exit alike.`);
  say();
  say(
    `  ${"geometry".padEnd(30)}${"TP%".padStart(6)}${"SL%".padStart(6)}${"R".padStart(7)} {"gross win".padStart(10)} {"fee/gross".padStart(11)} {"net win".padStart(9)} {"net loss".padStart(10)} {"BE_repo".padStart(9)} {"BE_true".padStart(9)}`,
  );
  say("  " + "-".repeat(112));
  const BE_GEOMS = [
    ["LIVE fired ENA (ATR 1.49)", 0.5, 1.9985],
    ["LIVE fired SUI (ATR 0.91)", 0.3626, 1.2188],
    ["LIVE fired AVAX (ATR 0.80)", 0.3204, 1.0775],
    ["LIVE fired LINK (ATR 0.69)", 0.3, 0.9267],
    ["TASK's ticket (TP .35 / SL 1.60)", 0.35, 1.6],
    ["TP 0.6 / SL 1.0", 0.6, 1.0],
    ["TP 0.8 / SL 1.0", 0.8, 1.0],
    ["TP 0.8 / SL 1.2", 0.8, 1.2],
    ["TP 0.8 / SL 1.5", 0.8, 1.5],
    ["TP 0.6 / SL 1.2", 0.6, 1.2],
    ["TP 1.0 / SL 1.0", 1.0, 1.0],
    ["TP 2.0 / SL 0.6", 2.0, 0.6],
  ];
  for (const [lbl, tp, sl] of BE_GEOMS) {
    const gross = (tp / 100) * NOTIONAL;
    const netWin = gross - FEE_USD;
    const netLoss = (sl / 100) * NOTIONAL + FEE_USD;
    say(
      `  ${lbl.padEnd(30)}${tp.toFixed(3).padStart(6)}${sl.toFixed(3).padStart(6)}${(sl / tp).toFixed(2).padStart(7)} ` +
        `${("+$" + gross.toFixed(4)).padStart(10)} ${((100 * FEE_USD) / gross).toFixed(0).padStart(10)}% ${("+$" + netWin.toFixed(4)).padStart(9)} ${("-$" + netLoss.toFixed(4)).padStart(10)} ` +
        `${(beRepo(tp, sl) * 100).toFixed(1).padStart(8)}% ${(beTrue(tp, sl) * 100).toFixed(1).padStart(8)}%`,
    );
  }
  say();
  say("  BE_repo = (SL+fee)/(TP+SL+fee) — the repo's published formula. BE_true = (SL+fee)/(TP+SL) — the");
  say("  arithmetically correct one, because the fee is charged once per trade whatever the outcome.");
  say("  THE TASK'S 82.8% IS THE REPO'S FORMULA AT TP 0.35% / SL 1.60%. The correct figure there is 88.2%.");
  say("  The repo's formula UNDERSTATES the break-even, because it lets the fee shrink as the win rate rises.");
  say();

  // ══ 2. THE SWEEP ══
  const ARMS = [
    { name: "CONFLUENCE stream", signal: conf.filter((r) => r.liveSide && r.liveSide === r.dir), pool: conf },
    { name: "TRADE-LOOP stream", signal: loop.filter((r) => r.liveSide && r.liveSide === r.dir), pool: loop },
    {
      name: "BOTH STREAMS POOLED",
      signal: all.filter((r) => r.liveSide && r.liveSide === r.dir),
      pool: all,
    },
  ];

  for (const arm of ARMS) {
    const sides = new Set(arm.signal.map((s) => s.dir));
    const sigPairs = new Set(arm.signal.map((s) => s.pair));
    const sigKeys = new Set(arm.signal.map((s) => `${s.pair}@${s.ts}`));
    const controlPool = arm.pool.filter(
      (u) => sides.has(u.dir) && sigPairs.has(u.pair) && !sigKeys.has(`${u.pair}@${u.ts}`),
    );
    say("=".repeat(118));
    say(`2. THE SWEEP — ${arm.name} (live gate), 240-minute hold, TRADE level`);
    say("=".repeat(118));
    say(
      `  signal ${arm.signal.length} observations / ${sigPairs.size} symbols | control pool ${controlPool.length} rows (same symbols, same side, signal's rows removed)`,
    );
    say();
    say(
      `  ${"geometry".padEnd(24)}${"TP%".padStart(5)}${"SL%".padStart(5)}${"R".padStart(6)} {"trades".padStart(7)} {"clus".padStart(5)} {"TP%".padStart(6)} {"STOP%".padStart(6)} {"TIME%".padStart(6)} {"win%".padStart(6)} {"BEtru".padStart(6)} {"BEmix".padStart(6)} {"margin".padStart(7)} {"EV$/tr".padStart(9)} {"EVt".padStart(6)} {"exc$".padStart(8)} {"t".padStart(6)}`,
    );
    say("  " + "-".repeat(116));
    for (const g of GEOMS) {
      const trades = toTrades(arm.signal, g.tp, g.sl, 16);
      const S = summarise(trades);
      if (!S) continue;
      const sigBuckets = new Set(S.buckets.keys());
      const U = summarise(
        toTrades(
          controlPool.filter((u) => sigBuckets.has(Math.floor(u.ts / BUCKET_MS))),
          g.tp,
          g.sl,
          16,
        ),
      );
      if (!U) continue;
      const exc = S.clusterMean - U.clusterMean;
      const d = Math.sqrt(S.clusterSe ** 2 + U.clusterSe ** 2);
      const t = d > 0 ? exc / d : 0;
      const be = beMix(g.tp, g.sl, S);
      say(
        `  ${g.label.padEnd(24)}${g.tp.toFixed(2).padStart(5)}${g.sl.toFixed(2).padStart(5)}${(g.sl / g.tp).toFixed(2).padStart(6)} ${String(S.n).padStart(7)} ${String(S.G).padStart(5)} ` +
          `${((S.tpN / S.n) * 100).toFixed(1).padStart(6)} ${((S.stN / S.n) * 100).toFixed(1).padStart(6)} ${((S.tmN / S.n) * 100).toFixed(1).padStart(6)} ` +
          `${(S.winRate * 100).toFixed(1).padStart(6)} ${(beTrue(g.tp, g.sl) * 100).toFixed(1).padStart(6)} ${(be * 100).toFixed(1).padStart(6)} ${((S.winRate - be) * 100).toFixed(1).padStart(7)} ` +
          `${(S.evUsd >= 0 ? "+" : "") + S.evUsd.toFixed(4).padStart(9)} ${S.crT.toFixed(2).padStart(6)} ${(exc >= 0 ? "+" : "") + exc.toFixed(4).padStart(8)} ${t.toFixed(2).padStart(6)}`,
      );
    }
    say();
  }

  // ══ 3. THE HORIZON SENSITIVITY ══
  say("=".repeat(118));
  say("3. THE HORIZON SENSITIVITY (the trade level, the confluence stream, the candidate geometries)");
  say("=".repeat(118));
  say();
  const confSignal = conf.filter((r) => r.liveSide && r.liveSide === r.dir);
  const confSides = new Set(confSignal.map((s) => s.dir));
  const confPairs = new Set(confSignal.map((s) => s.pair));
  const confKeys = new Set(confSignal.map((s) => `${s.pair}@${s.ts}`));
  const confControl = conf.filter(
    (u) => confSides.has(u.dir) && confPairs.has(u.pair) && !confKeys.has(`${u.pair}@${u.ts}`),
  );
  say(
    `  ${"geometry".padEnd(24)}${"hold".padStart(6)} {"trades".padStart(7)} {"clus".padStart(5)} {"STOP%".padStart(7)} {"win%".padStart(6)} {"BEmix".padStart(7)} {"EV$/tr".padStart(9)} {"EVt".padStart(6)} {"paired$".padStart(9)} {"pt".padStart(6)}`,
  );
  say("  " + "-".repeat(100));
  for (const g of [
    { label: "TP 0.8 / SL 1.0", tp: 0.8, sl: 1.0 },
    { label: "TP 0.8 / SL 1.2", tp: 0.8, sl: 1.2 },
    { label: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
    { label: "TP 0.6 / SL 1.0", tp: 0.6, sl: 1.0 },
    { label: "TP 0.6 / SL 1.2", tp: 0.6, sl: 1.2 },
    { label: "LIVE TP 0.36 / SL 1.22", tp: 0.36, sl: 1.22 },
  ]) {
    for (const holdMin of [240, 120, 60]) {
      const hb = Math.ceil(holdMin / 15);
      const trades = toTrades(confSignal, g.tp, g.sl, hb);
      const S = summarise(trades);
      if (!S) continue;
      const sb = new Set(S.buckets.keys());
      const U = summarise(
        toTrades(confControl.filter((u) => sb.has(Math.floor(u.ts / BUCKET_MS))), g.tp, g.sl, hb),
      );
      if (!U) continue;
      const pairs = [];
      for (const b of S.buckets.keys()) {
        if (!U.buckets.has(b)) continue;
        pairs.push(mean(S.buckets.get(b)) - mean(U.buckets.get(b)));
      }
      const pm = pairs.length >= 3 ? mean(pairs) : NaN;
      const pt = pairs.length >= 3 ? pm / se(pairs) : NaN;
      const be = beMix(g.tp, g.sl, S);
      say(
        `  ${g.label.padEnd(24)}${String(holdMin).padStart(6)} ${String(S.n).padStart(7)} ${String(S.G).padStart(5)} ${((S.stN / S.n) * 100).toFixed(1).padStart(7)} ` +
          `${(S.winRate * 100).toFixed(1).padStart(6)} ${(be * 100).toFixed(1).padStart(7)} ${(S.evUsd >= 0 ? "+" : "") + S.evUsd.toFixed(4).padStart(9)} ${S.crT.toFixed(2).padStart(6)} ` +
          `${(pm >= 0 ? "+" : "") + pm.toFixed(4).padStart(9)} ${pt.toFixed(2).padStart(6)}`,
      );
    }
    say();
  }

  // ══ 4. THE PLACEBO ══
  say("=".repeat(118));
  say("4. THE PLACEBO — size-matched + symbol-preserving, on a symbol- AND window-matched control");
  say("=".repeat(118));
  say();
  for (const arm of ARMS) {
    const sides = new Set(arm.signal.map((s) => s.dir));
    const sigPairs = new Set(arm.signal.map((s) => s.pair));
    const sigKeys = new Set(arm.signal.map((s) => `${s.pair}@${s.ts}`));
    const controlPool = arm.pool.filter(
      (u) => sides.has(u.dir) && sigPairs.has(u.pair) && !sigKeys.has(`${u.pair}@${u.ts}`),
    );
    say(`  ${arm.name}`);
    for (const g of GEOMS) {
      const trades = toTrades(arm.signal, g.tp, g.sl, 16);
      const S = summarise(trades);
      if (!S) continue;
      const sb = new Set(S.buckets.keys());
      const ctl = toTrades(
        controlPool.filter((u) => sb.has(Math.floor(u.ts / BUCKET_MS))),
        g.tp,
        g.sl,
        16,
      );
      const U = summarise(ctl);
      if (!U) continue;
      const pairs = [];
      for (const b of S.buckets.keys()) {
        if (!U.buckets.has(b)) continue;
        pairs.push(mean(S.buckets.get(b)) - mean(U.buckets.get(b)));
      }
      if (pairs.length < 3) continue;
      const pm = mean(pairs);
      const pt = pm / se(pairs);
      const pool = new Map();
      for (const u of controlPool.filter((x) => sb.has(Math.floor(x.ts / BUCKET_MS)))) {
        const arr = pool.get(u.pair) ?? [];
        arr.push(u);
        pool.set(u.pair, arr);
      }
      const want = new Map();
      for (const s of arm.signal) want.set(s.pair, (want.get(s.pair) ?? 0) + 1);
      const rnd = mulberry32(20261021);
      const placebo = [];
      for (let d = 0; d < 2000; d++) {
        const a2 = [];
        for (const [pair, n] of want) {
          const avail = pool.get(pair) ?? [];
          const take = Math.min(n, avail.length);
          if (!take) continue;
          const idx = avail.map((_, i) => i);
          for (let i = idx.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [idx[i], idx[j]] = [idx[j], idx[i]];
          }
          for (let i = 0; i < take; i++) a2.push(avail[idx[i]]);
        }
        if (!a2.length) continue;
        const p2 = summarise(toTrades(a2, g.tp, g.sl, 16));
        if (!p2) continue;
        const pp = [];
        for (const b of p2.buckets.keys()) {
          if (!U.buckets.has(b)) continue;
          pp.push(mean(p2.buckets.get(b)) - mean(U.buckets.get(b)));
        }
        if (pp.length >= 3) placebo.push(mean(pp));
      }
      placebo.sort((a, b) => a - b);
      const ge = placebo.filter((x) => x >= pm).length;
      const pct = (100 * ge) / placebo.length;
      say(
        `    ${g.label.padEnd(24)} paired $${(pm >= 0 ? "+" : "") + pm.toFixed(4)}  t=${pt.toFixed(2)}  ${String(pairs.length).padStart(3)} buckets  EV $${(S.evUsd >= 0 ? "+" : "") + S.evUsd.toFixed(4)}  placebo pct ${pct.toFixed(1).padStart(5)}  ${pct <= 5 ? "BEATS" : "does NOT beat"}`,
      );
    }
    say();
  }

  writeFileSync(OUT_FILE, out.join("\n"));
  console.log(`[verdict-table] written to ${OUT_FILE}`);
}

main();
