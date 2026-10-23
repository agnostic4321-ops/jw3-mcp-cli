#!/usr/bin/env node
/**
 * THE REACHABLE-STOP SWEEP — THE REPORT NUMBERS.
 *
 * One run that produces exactly the numbers the report quotes:
 * the raw-observation-level table for the three arms, the
 * trade-level table for the three arms, the leave-one-symbol-out on
 * the confluence arm's leading candidate, and the final verdict.
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
const OUT_FILE = join(SCRATCH, "geom-reach-report-numbers.txt");

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
function stats(items) {
  const n = items.length;
  if (!n) return null;
  const tpN = items.filter((t) => t.kind === "tp").length;
  const stN = items.filter((t) => t.kind === "stop").length;
  const tmN = items.filter((t) => t.kind === "time").length;
  const bk = new Map();
  for (const t of items) {
    const b = Math.floor(t.ts / BUCKET_MS);
    const arr = bk.get(b) ?? [];
    arr.push(t.pnlUsd);
    bk.set(b, arr);
  }
  const cms = [...bk.values()].map(mean);
  const m = mean(items.map((t) => t.pnlUsd));
  const G = bk.size;
  let q = 0;
  for (const arr of bk.values()) {
    const gm = mean(arr);
    const dev = arr.length * (gm - m);
    q += dev * dev;
  }
  const cr0 = G > 1 && n > G ? (G / (G - 1)) * ((n - 1) / (n - G)) * (q / (n * (n - 1))) : NaN;
  const crSe = Number.isFinite(cr0) ? Math.sqrt(Math.max(cr0, 0)) : NaN;
  const timeRows = items.filter((t) => t.kind === "time");
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
    items,
  };
}
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
    out.push({ pair: r.pair, ts: r.ts, dir: t, price: Number(r.price ?? r.bookMid), stream: "conf", liveSide: liveModelSide(r) });
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
  { label: "TP 0.5 / SL 0.6", tp: 0.5, sl: 0.6 },
  { label: "TP 0.6 / SL 0.8", tp: 0.6, sl: 0.8 },
  { label: "TP 0.6 / SL 1.0", tp: 0.6, sl: 1.0 },
  { label: "TP 0.6 / SL 1.2", tp: 0.6, sl: 1.2 },
  { label: "TP 0.8 / SL 0.8", tp: 0.8, sl: 0.8 },
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

  const ARMS = [
    { name: "CONFLUENCE", signal: conf.filter((r) => r.liveSide && r.liveSide === r.dir), pool: conf },
    { name: "TRADE-LOOP", signal: loop.filter((r) => r.liveSide && r.liveSide === r.dir), pool: loop },
    { name: "POOLED", signal: all.filter((r) => r.liveSide && r.liveSide === r.dir), pool: all },
  ];

  for (const arm of ARMS) {
    const sides = new Set(arm.signal.map((s) => s.dir));
    const sigPairs = new Set(arm.signal.map((s) => s.pair));
    const sigKeys = new Set(arm.signal.map((s) => `${s.pair}@${s.ts}`));
    const controlPool = arm.pool.filter(
      (u) => sides.has(u.dir) && sigPairs.has(u.pair) && !sigKeys.has(`${u.pair}@${u.ts}`),
    );
    say("=".repeat(124));
    say(`ARM ${arm.name} — 240-minute hold`);
    say("=".repeat(124));
    say();
    say("  A. RAW OBSERVATION LEVEL (the repo's convention; the cluster count applies here)");
    say(
      `  ${"geometry".padEnd(24)}${"TP%".padStart(5)}${"SL%".padStart(5)}${"R".padStart(6)} {"n".padStart(4)} {"TP%".padStart(6)} {"STOP%".padStart(6)} {"TIME%".padStart(6)} {"win%".padStart(6)} {"BEtru".padStart(6)} {"BEmix".padStart(6)} {"margin".padStart(7)} {"EV$/tr".padStart(9)} {"EVt".padStart(6)} {"exc$".padStart(8)} {"t".padStart(6)} {"clus".padStart(5)}`,
    );
    say("  " + "-".repeat(122));
    for (const g of GEOMS) {
      const obs = [];
      for (const c of arm.signal) {
        const r = outcomeFor(c, g.tp, g.sl, 16);
        if (!r || r.incomplete) continue;
        obs.push({ ...c, ...r });
      }
      const S = stats(obs);
      if (!S) continue;
      const sb = new Set(S.buckets.keys());
      const ctl = [];
      for (const c of controlPool) {
        if (!sb.has(Math.floor(c.ts / BUCKET_MS))) continue;
        const r = outcomeFor(c, g.tp, g.sl, 16);
        if (!r || r.incomplete) continue;
        ctl.push({ ...c, ...r });
      }
      const U = stats(ctl);
      if (!U) continue;
      const exc = S.clusterMean - U.clusterMean;
      const d = Math.sqrt(S.clusterSe ** 2 + U.clusterSe ** 2);
      const be = beMix(g.tp, g.sl, S);
      say(
        `  ${g.label.padEnd(24)}${g.tp.toFixed(2).padStart(5)}${g.sl.toFixed(2).padStart(5)}${(g.sl / g.tp).toFixed(2).padStart(6)} ${String(S.n).padStart(4)} ` +
          `${((S.tpN / S.n) * 100).toFixed(1).padStart(6)} ${((S.stN / S.n) * 100).toFixed(1).padStart(6)} ${((S.tmN / S.n) * 100).toFixed(1).padStart(6)} ` +
          `${(S.winRate * 100).toFixed(1).padStart(6)} ${(beTrue(g.tp, g.sl) * 100).toFixed(1).padStart(6)} ${(be * 100).toFixed(1).padStart(6)} ${((S.winRate - be) * 100).toFixed(1).padStart(7)} ` +
          `${(S.evUsd >= 0 ? "+" : "") + S.evUsd.toFixed(4).padStart(9)} ${S.crT.toFixed(2).padStart(6)} ${(exc >= 0 ? "+" : "") + exc.toFixed(4).padStart(8)} ${(d > 0 ? exc / d : 0).toFixed(2).padStart(6)} ${String(S.G).padStart(5)}`,
      );
    }
    say();
    say("  B. TRADE LEVEL (one entry per pair, held until it resolves)");
    say(
      `  ${"geometry".padEnd(24)}${"trades".padStart(7)} {"clus".padStart(5)} {"TP%".padStart(6)} {"STOP%".padStart(6)} {"TIME%".padStart(6)} {"win%".padStart(6)} {"BEtru".padStart(6)} {"BEmix".padStart(6)} {"margin".padStart(7)} {"EV$/tr".padStart(9)} {"EVt".padStart(6)} {"exc$".padStart(8)} {"t".padStart(6)}`,
    );
    say("  " + "-".repeat(116));
    for (const g of GEOMS) {
      const trades = toTrades(arm.signal, g.tp, g.sl, 16);
      const S = stats(trades);
      if (!S) continue;
      const sb = new Set(S.buckets.keys());
      const U = stats(
        toTrades(controlPool.filter((u) => sb.has(Math.floor(u.ts / BUCKET_MS))), g.tp, g.sl, 16),
      );
      if (!U) continue;
      const exc = S.clusterMean - U.clusterMean;
      const d = Math.sqrt(S.clusterSe ** 2 + U.clusterSe ** 2);
      const be = beMix(g.tp, g.sl, S);
      say(
        `  ${g.label.padEnd(24)}${String(S.n).padStart(7)} ${String(S.G).padStart(5)} ` +
          `${((S.tpN / S.n) * 100).toFixed(1).padStart(6)} ${((S.stN / S.n) * 100).toFixed(1).padStart(6)} ${((S.tmN / S.n) * 100).toFixed(1).padStart(6)} ` +
          `${(S.winRate * 100).toFixed(1).padStart(6)} ${(beTrue(g.tp, g.sl) * 100).toFixed(1).padStart(6)} ${(be * 100).toFixed(1).padStart(6)} ${((S.winRate - be) * 100).toFixed(1).padStart(7)} ` +
          `${(S.evUsd >= 0 ? "+" : "") + S.evUsd.toFixed(4).padStart(9)} ${S.crT.toFixed(2).padStart(6)} ${(exc >= 0 ? "+" : "") + exc.toFixed(4).padStart(8)} ${(d > 0 ? exc / d : 0).toFixed(2).padStart(6)}`,
      );
    }
    say();
  }

  // ── the leave-one-symbol-out on the confluence arm's leading candidate ──
  say("=".repeat(124));
  say("LEAVE-ONE-SYMBOL-OUT on the confluence arm, TP 0.8% / SL 1.0%, trade level");
  say("=".repeat(124));
  say();
  const confSig = conf.filter((r) => r.liveSide && r.liveSide === r.dir);
  const confSides = new Set(confSig.map((s) => s.dir));
  const confPairs = new Set(confSig.map((s) => s.pair));
  const confKeys = new Set(confSig.map((s) => `${s.pair}@${s.ts}`));
  const confCtl = conf.filter((u) => confSides.has(u.dir) && confPairs.has(u.pair) && !confKeys.has(`${u.pair}@${u.ts}`));
  for (const g of [
    { label: "TP 0.8 / SL 1.0", tp: 0.8, sl: 1.0 },
    { label: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
  ]) {
    const base = stats(toTrades(confSig, g.tp, g.sl, 16));
    const baseU = stats(
      toTrades(confCtl.filter((u) => base.buckets.has(Math.floor(u.ts / BUCKET_MS))), g.tp, g.sl, 16),
    );
    say(`  ${g.label}: pooled EV $${base.evUsd.toFixed(4)} (${base.n} trades / ${base.G} clusters), control EV $${baseU.evUsd.toFixed(4)}`);
    const syms = [...new Set(base.items.map((t) => t.pair))];
    const loo = [];
    for (const p of syms) {
      const sub = confSig.filter((c) => c.pair !== p);
      const S = stats(toTrades(sub, g.tp, g.sl, 16));
      if (!S) continue;
      const U = stats(
        toTrades(confCtl.filter((u) => Math.floor(u.ts / BUCKET_MS) !== undefined && S.buckets.has(Math.floor(u.ts / BUCKET_MS))), g.tp, g.sl, 16),
      );
      if (!U) continue;
      const exc = S.clusterMean - U.clusterMean;
      const d = Math.sqrt(S.clusterSe ** 2 + U.clusterSe ** 2);
      loo.push({ p, exc, t: d > 0 ? exc / d : 0, ev: S.evUsd, share: base.items.filter((t) => t.pair === p).length / base.n });
    }
    loo.sort((a, b) => a.exc - b.exc);
    for (const l of loo) {
      say(
        `    without ${l.p.padEnd(15)}: EV $${l.ev.toFixed(4)}  excess $${l.exc >= 0 ? "+" : ""}${l.exc.toFixed(4)}  t=${l.t.toFixed(2)}   (that symbol was ${(l.share * 100).toFixed(1)}% of the trades)`,
      );
    }
    say();
  }

  writeFileSync(OUT_FILE, out.join("\n"));
  console.log(`[reportnumbers] written to ${OUT_FILE}`);
}

main();
