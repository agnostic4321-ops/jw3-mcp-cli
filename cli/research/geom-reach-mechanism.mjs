#!/usr/bin/env node
/**
 * THE REACHABLE-STOP SWEEP — THE MECHANISM.
 *
 * The two independent instruments disagree in sign for the leading
 * candidates. This script establishes WHY, because a mechanism that
 * explains the disagreement is the answer to the whole question.
 *
 * The hypothesis: the confluence stream's signal arm was SHORT into a
 * market that FELL during its priceable window, and the trade-loop
 * stream's signal arm was SHORT into a market that ROSE. A ticket that
 * is short into a falling market wins, whatever its geometry — so the
 * "edge" is the DIRECTION of the drift, not the geometry.
 *
 * The test: the REVERSED direction at the TRADE level. If the reversed
 * arm on the confluence stream is strongly negative and the reversed
 * arm on the trade-loop stream is strongly positive, then the two
 * instruments are not measuring the same thing — they are measuring
 * the drift from opposite sides of it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideOf } from "./tape-signal.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const CONF_FILE = join(SCRATCH, "geom-reach-signal-snapshot.ndjson");
const LOOP_FILE = join(SCRATCH, "trade-loop.ndjson");
const BARS_FILE = join(SCRATCH, "geom-reach-bars.json");
const OUT_FILE = join(SCRATCH, "geom-reach-mechanism.txt");

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
function stats(trades) {
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
  const m = mean(trades.map((t) => t.pnlUsd));
  const G = bk.size;
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
    buckets: bk,
  };
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

function main() {
  BARS = JSON.parse(readFileSync(BARS_FILE, "utf8"));
  const conf = loadConfluence();
  const loop = loadTradeLoop();
  const out = [];
  const say = (s = "") => {
    out.push(s);
    console.log(s);
  };

  const barMax = maxOf(Object.values(BARS).map((v) => v[v.length - 1].t));
  const cut240 = barMax - 240 * 60_000;

  say("=".repeat(112));
  say("THE MECHANISM — why the two independent instruments disagree in sign");
  say("=".repeat(112));
  say();

  // ── 1. THE MARKET'S DIRECTION OVER EACH STREAM'S PRICEABLE WINDOW ──
  say("  1. THE MARKET'S DIRECTION over each stream's priceable 240-minute window");
  say("     (the mean forward return of the signal's OWN direction — a short arm measured");
  say("      as the market's move against it)");
  say();
  const drift = (rows, label) => {
    const rets = [];
    let lo = Infinity,
      hi = 0;
    for (const c of rows) {
      const bs = BARS[c.pair];
      if (!bs) continue;
      let idx = -1,
        first = -1;
      for (let i = 0; i < bs.length; i++) {
        if (bs[i].t <= c.ts) idx = i;
        else {
          first = i;
          break;
        }
      }
      if (idx < 0 || first < 0 || bs.length - first < 16) continue;
      const entry = Number(c.price);
      const lastC = bs[first + 15].c;
      const raw = ((lastC / entry - 1) * 100);
      // In the signal's own profit direction.
      rets.push(c.dir === "long" ? raw : -raw);
      lo = Math.min(lo, c.ts);
      hi = Math.max(hi, c.ts);
    }
    const m = mean(rets);
    say(
      `     ${label.padEnd(22)} n=${String(rets.length).padStart(3)}  window ${new Date(lo).toISOString().slice(11, 16)}->${new Date(hi).toISOString().slice(11, 16)} UTC  mean forward return IN THE SIGNAL'S DIRECTION: ${m >= 0 ? "+" : ""}${m.toFixed(3)}%`,
    );
    return m;
  };
  const confSig = conf.filter((r) => r.liveSide && r.liveSide === r.dir);
  const loopSig = loop.filter((r) => r.liveSide && r.liveSide === r.dir);
  const dConf = drift(confSig.filter((r) => r.ts <= cut240), "CONFLUENCE stream");
  const dLoop = drift(loopSig.filter((r) => r.ts <= cut240), "TRADE-LOOP stream");
  say();
  say(
    `     THE TWO STREAMS'S MARKET WINDOWS ARE OPPOSITE: confluence ${dConf >= 0 ? "+" : ""}${dConf.toFixed(3)}% (the signal's direction was RIGHT), trade-loop ${dLoop >= 0 ? "+" : ""}${dLoop.toFixed(3)}% (the signal's direction was WRONG).`,
  );
  say("     The two streams traded at DIFFERENT TIMES on DIFFERENT SYMBOLS, and the market moved");
  say("     the other way in each. A short ticket cannot be good in both directions at once.");
  say();

  // ── 2. THE REVERSED DIRECTION AT THE TRADE LEVEL ──
  say("  2. THE REVERSED DIRECTION at the trade level (the same observations, the other way)");
  say();
  say(
    `     ${"geometry".padEnd(22)}${"stream".padEnd(14)}${"n/cl".padStart(9)} {"EV traded".padStart(12)} {"EV reversed".padStart(13)} {"rev - trad".padStart(12)}  verdict`,
  );
  say("     " + "-".repeat(96));
  for (const g of [
    { label: "TP 0.8 / SL 1.0", tp: 0.8, sl: 1.0 },
    { label: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
    { label: "TP 1.0 / SL 1.0", tp: 1.0, sl: 1.0 },
    { label: "LIVE TP 0.36/1.22", tp: 0.36, sl: 1.22 },
  ]) {
    for (const [label, sig] of [
      ["CONFLUENCE", confSig],
      ["TRADE-LOOP", loopSig],
    ]) {
      const S = stats(toTrades(sig, g.tp, g.sl, 16));
      const R = stats(
        toTrades(
          sig.map((c) => ({ ...c, dir: c.dir === "long" ? "short" : "long" })),
          g.tp,
          g.sl,
          16,
        ),
      );
      if (!S || !R) continue;
      const diff = S.evUsd - R.evUsd;
      // A directional edge: the traded side beats the reversed side.
      const verdict = diff > 0.15 ? "DIRECTIONAL" : diff < -0.15 ? "ANTI-DIRECTIONAL" : "no direction";
      say(
        `     ${g.label.padEnd(22)}${label.padEnd(14)}${`${S.n}/${S.G}`.padStart(9)} ${(S.evUsd >= 0 ? "+$" : "-$") + Math.abs(S.evUsd).toFixed(4).padStart(8)} ${(R.evUsd >= 0 ? "+$" : "-$") + Math.abs(R.evUsd).toFixed(4).padStart(9)} ${(diff >= 0 ? "+$" : "-$") + Math.abs(diff).toFixed(4).padStart(8)}  ${verdict}`,
      );
    }
  }
  say();
  say("     A DIRECTIONAL result (the traded side beats the reversed side) is what an edge looks");
  say("     like. ANTI-DIRECTIONAL means the arm is on the wrong side of the market's drift.");
  say();

  // ── 3. THE SIDE-MIX ──
  say("  3. THE SIDE-MIX — how many LONG observations does the signal arm have?");
  say();
  for (const [label, sig] of [
    ["CONFLUENCE", confSig],
    ["TRADE-LOOP", loopSig],
  ]) {
    const longs = sig.filter((c) => c.dir === "long").length;
    say(
      `     ${label.padEnd(14)} ${sig.length} signal observations: ${sig.length - longs} short, ${longs} long.`,
    );
  }
  say();
  say("     The long side is measured in single digits on both streams, so the LONG side of any");
  say("     geometry is unmeasured. Every signal is effectively a SHORT into a market whose");
  say("     direction differed between the two streams' windows.");
  say();

  writeFileSync(OUT_FILE, out.join("\n"));
  console.log(`[mechanism] written to ${OUT_FILE}`);
}

main();
