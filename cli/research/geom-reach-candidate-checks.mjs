#!/usr/bin/env node
/**
 * THE REACHABLE-STOP SWEEP — THE FINAL CHECKS ON THE LEADING CANDIDATE.
 *
 * TP 0.8% / SL 1.0% is the only geometry in the sweep that has all
 * three of:
 *   - a REACHABLE STOP (the stop fires on a meaningful share of the
 *     trades, so the loss rate is real and measured);
 *   - a break-even BELOW the measured win rate; and
 *   - a POSITIVE net expectancy in dollars at the real size.
 *
 * This script asks the last three questions about it:
 *   1. THE TRIM TEST (worst-3 / best-3 dropped).
 *   2. THE PER-SYMBOL SHARE (which symbol carries the result).
 *   3. THE TWO STREAMS SEPARATELY (the confluence collector and the
 *      live trade loop are independent instruments; if they disagree
 *      in SIGN, the result is not a property of the signal).
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
const OUT_FILE = join(SCRATCH, "geom-reach-candidate-checks.txt");

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
    trades,
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

const CANDIDATES = [
  { label: "TP 0.8 / SL 1.0", tp: 0.8, sl: 1.0 },
  { label: "TP 0.8 / SL 1.5", tp: 0.8, sl: 1.5 },
  { label: "TP 1.0 / SL 1.0", tp: 1.0, sl: 1.0 },
  { label: "LIVE TP 0.36 / SL 1.22", tp: 0.36, sl: 1.22 },
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

  say("=".repeat(112));
  say("THE FINAL CHECKS ON THE LEADING CANDIDATES");
  say("=".repeat(112));
  say();

  const ARMS = [
    { name: "CONFLUENCE stream (43 pairs, 5-minute sampling)", signal: conf.filter((r) => r.liveSide && r.liveSide === r.dir), pool: conf },
    { name: "TRADE-LOOP stream (9 pairs, 60-second sampling)", signal: loop.filter((r) => r.liveSide && r.liveSide === r.dir), pool: loop },
    { name: "BOTH STREAMS POOLED", signal: all.filter((r) => r.liveSide && r.liveSide === r.dir), pool: all },
  ];

  for (const arm of ARMS) {
    const sides = new Set(arm.signal.map((s) => s.dir));
    const sigPairs = new Set(arm.signal.map((s) => s.pair));
    const sigKeys = new Set(arm.signal.map((s) => `${s.pair}@${s.ts}`));
    const controlPool = arm.pool.filter(
      (u) => sides.has(u.dir) && sigPairs.has(u.pair) && !sigKeys.has(`${u.pair}@${u.ts}`),
    );
    say("─".repeat(112));
    say(`ARM: ${arm.name}`);
    say();
    for (const g of CANDIDATES) {
      const trades = toTrades(arm.signal, g.tp, g.sl, 16);
      const S = stats(trades);
      if (!S) continue;
      const sb = new Set(S.buckets.keys());
      const U = stats(
        toTrades(controlPool.filter((u) => sb.has(Math.floor(u.ts / BUCKET_MS))), g.tp, g.sl, 16),
      );
      say(`  ${g.label}  (TP ${g.tp}%, SL ${g.sl}%, R = 1:${(g.sl / g.tp).toFixed(2)})`);
      say(
        `    ${S.n} trades / ${S.G} clusters | TP ${((S.tpN / S.n) * 100).toFixed(1)}%  STOP ${((S.stN / S.n) * 100).toFixed(1)}%  TIME ${((S.tmN / S.n) * 100).toFixed(1)}%  win ${(S.winRate * 100).toFixed(1)}%`,
      );
      say(`    EV $${S.evUsd.toFixed(4)}/trade  (${((S.evUsd / EQUITY) * 100).toFixed(3)}% of equity)  cluster-robust SE $${S.crSe.toFixed(4)}  t vs zero ${S.crT.toFixed(2)}`);
      // The trim test.
      const pnls = S.trades.map((t) => t.pnlUsd).sort((a, b) => a - b);
      const tw = mean(pnls.slice(3));
      const tb = mean(pnls.slice(0, pnls.length - 3));
      say(`    TRIM: worst-3 dropped -> EV $${tw.toFixed(4)}   best-3 dropped -> EV $${tb.toFixed(4)}   ${tw > 0 && tb > 0 ? "TRIM-STABLE" : "NOT trim-stable"}`);
      // The per-symbol share.
      const per = new Map();
      for (const t of S.trades) {
        const e = per.get(t.pair) ?? { n: 0, pnl: 0 };
        e.n++;
        e.pnl += t.pnlUsd;
        per.set(t.pair, e);
      }
      const rows = [...per.entries()]
        .map(([pair, e]) => ({ pair, ...e, share: e.n / S.n }))
        .sort((a, b) => b.share - a.share);
      const top = rows[0];
      say(
        `    LARGEST SHARE: ${top.pair} — ${top.n}/${S.n} trades (${(top.share * 100).toFixed(1)}%), net $${top.pnl.toFixed(3)}   [all: ${rows.map((r) => `${r.pair.replace("/USDT", "")} ${r.n}`).join(", ")}]`,
      );
      if (U && U.n) {
        const exc = S.clusterMean - U.clusterMean;
        const d = Math.sqrt(S.clusterSe ** 2 + U.clusterSe ** 2);
        say(
          `    EXCESS over the symbol- AND window-matched control: $${exc >= 0 ? "+" : ""}${exc.toFixed(4)}/trade  t = ${(d > 0 ? exc / d : 0).toFixed(2)}  (control ${U.n} trades / ${U.G} clusters, EV $${U.evUsd.toFixed(4)})`,
        );
      }
      say();
    }
  }

  // The sign agreement between the two independent instruments.
  say("─".repeat(112));
  say("THE SIGN AGREEMENT BETWEEN THE TWO INDEPENDENT INSTRUMENTS");
  say("  (the confluence collector samples 43 pairs every 5 minutes; the live trade loop samples");
  say("   9 different pairs every 60 seconds — they share no symbol, so they are independent)");
  say();
  say(
    `  ${"geometry".padEnd(24)}${"confluence EV".padStart(14)}${"n/cl".padStart(10)}${"loop EV".padStart(12)}${"n/cl".padStart(10)}  agreement`,
  );
  say("  " + "-".repeat(84));
  for (const g of CANDIDATES) {
    const cS = stats(toTrades(conf.filter((r) => r.liveSide && r.liveSide === r.dir), g.tp, g.sl, 16));
    const lS = stats(toTrades(loop.filter((r) => r.liveSide && r.liveSide === r.dir), g.tp, g.sl, 16));
    if (!cS || !lS) continue;
    const same = Math.sign(cS.evUsd) === Math.sign(lS.evUsd);
    say(
      `  ${g.label.padEnd(24)}${(cS.evUsd >= 0 ? "+$" : "-$") + Math.abs(cS.evUsd).toFixed(4).padStart(10)}${`${cS.n}/${cS.G}`.padStart(10)}${(lS.evUsd >= 0 ? "+$" : "-$") + Math.abs(lS.evUsd).toFixed(4).padStart(10)}${`${lS.n}/${lS.G}`.padStart(10)}  ${same ? "same sign" : "*** OPPOSITE SIGNS ***"}`,
    );
  }
  say();
  say("  Two instruments that disagree in sign have not measured an edge; they have measured the");
  say("  market's drift on one side and its anti-drift on the other.");
  say();

  writeFileSync(OUT_FILE, out.join("\n"));
  console.log(`[candchecks] written to ${OUT_FILE}`);
}

main();
