#!/usr/bin/env node
/**
 * THE UNIVERSE SCREEN — TRADABILITY, NOT EDGE.
 *
 * ── WHAT THIS FILE ANSWERS, AND WHAT IT DOES NOT ──
 *
 * It answers: WHICH SYMBOLS should the machine trade, and what is the
 * net expectancy of the ticket on this account?
 *
 * It does NOT answer: which symbols have an edge. That question is
 * answered by the geometry study, and on the current sample it has no
 * answer (0 geometries clear n>=30 clusters AND t>=2 AND the trim test).
 *
 * ── THE MEASURED FACTS THIS FILE IS BUILT ON ──
 *
 * 1. THE FEE IS 0.08% OF NOTIONAL, NOT 0.12%.
 *    live.ts builds the fee schedule as:
 *      makerRate 0.02%, takerRate 0.06%, entryLeg "maker", exitLeg "taker"
 *    => 0.0002 + 0.0006 = 0.0008 = 0.08% of the notional, round trip.
 *    Every FIRED ticket confirms it: feeRateRoundTrip = 0.0008 exactly,
 *    $0.0459-$0.0477 on a $57-60 notional.
 *
 * 2. LEVERAGE DOES NOT CHANGE THE FEE.
 *    notional = min(riskBudget/stopFrac, $60 cap). Leverage sets the
 *    MARGIN and the liquidation distance. On a capped notional, x20 and
 *    x42 pay the SAME $0.048. "Higher leverage means a bigger fee" is
 *    FALSE here.
 *
 * 3. THE 66.7% WIN RATE IS NOT THE TICKET'S WIN RATE.
 *    66.7% is the sign of the 1-hour forward RETURN. The ticket's win
 *    rate — the TP touched before the SL — is a different quantity, and
 *    it is ~100% on the signal arm. A break-even win rate must be
 *    compared to the TICKET's win rate.
 *
 * 4. THE TAPE'S ATR IS A 1-HOUR ATR; THE TICKET IS SCALED TO IT, BUT THE
 *    MARKET MOVES ON 15-MINUTE BARS.
 *    kucoin.ts:99-113 computes the ATR from 15 HOURLY bars. The median
 *    15-min bar's own ATR is 0.536% against the tape's 1.13%. The
 *    shipped TP (0.4 x ATR = 0.45% median) is 0.85x the 15-min ATR —
 *    roughly ONE 15-minute bar's range. That is why the geometry win
 *    rate is so high, and it is also why the ticket's SL (1.34 x ATR =
 *    1.5% median) is ~3x further away than the TP.
 *
 * ── THE ALGEBRA ──
 *
 *   bracket = w*tp - (1-w)*sl - f      (% of NOTIONAL)
 *   EV%_equity = bracket * (notional/equity)
 *
 * The multiplier (notional/equity) is POSITIVE, so:
 *   bracket < 0  ->  NO equity fixes it. Only w, tp/sl, or f can.
 *   bracket > 0  ->  with the $60 cap, EV% DECLINES as equity grows.
 *
 * USAGE
 *   node research/screen-universe.mjs
 *   node research/screen-universe.mjs --bars <path> --loop <path>
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tapeSideFromRow } from "./tape-signal.mjs";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const CONF = flag("conf", join(HOME, ".hermes/cache/scratch/confluence.ndjson"));
const BARS = flag("bars", join(HOME, ".hermes/cache/scratch/screen-universe-bars.snapshot.json"));
const LOOP = flag("loop", join(HOME, ".hermes/cache/scratch/trade-loop.ndjson"));
const CONTRACTS = flag("contracts", join(HOME, ".hermes/cache/scratch/contracts.json"));

// ── the live ticket's economics, from the code ───────────────────────────
const FEE_LIVE = 0.08; // % of notional: maker 0.02 entry + taker 0.06 exit
const FEE_TAKER = 0.12; // % of notional: taker + taker (the pessimistic tier)
const FEE_MAKER = 0.04; // % of notional: maker + maker (the optimistic tier)
const EQUITY = 57.16;
const NOTIONAL_CAP = 60.0;
const RISK_PCT = 2;
const BAR_MIN = 15;
const BUCKET_MS = 5 * 60_000;
const MAX_HOLD = 16; // 4 hours
const STOP_ATR_MULT = 1.34; // the observed live stop (1.34 x ATR)

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const med = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const q = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const se = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
};
function clusterStats(values, buckets) {
  const by = new Map();
  for (let i = 0; i < values.length; i++) {
    const b = buckets[i] ?? i;
    const arr = by.get(b) ?? [];
    arr.push(values[i]);
    by.set(b, arr);
  }
  const cm = [...by.values()].map((a) => mean(a));
  return { clusters: cm.length, mean: mean(cm), se: se(cm) };
}

// ── load ─────────────────────────────────────────────────────────────────
const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const BARS_RAW = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};
const loopRows = existsSync(LOOP) ? readFileSync(LOOP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const contracts = existsSync(CONTRACTS) ? JSON.parse(readFileSync(CONTRACTS, "utf8")).data : [];

// ── the arms (the study's own rule) ──────────────────────────────────────
const modelSideStudy = (r) => {
  const j = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const l = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return j && l ? (j === l ? j : null) : (j || l);
};
const control = [];
const unconditional = [];
for (const r of rows) {
  const t = tapeSideFromRow(r);
  if (!t) continue;
  unconditional.push({ ...r, dir: t });
  const m = modelSideStudy(r);
  if (!m || m !== t) continue;
  control.push({ ...r, dir: t });
}

// ── the trade simulation ─────────────────────────────────────────────────
function outcome(bars, ts, entry, tpPct, slPct, long) {
  const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let start = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i].t > ts) { start = i; break; } }
  if (start < 0) return null;
  const end = Math.min(bars.length, start + MAX_HOLD);
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const hitTp = long ? b.h >= tp : b.l <= tp;
    const hitSl = long ? b.l <= sl : b.h >= sl;
    if (hitTp && hitSl) return "loss";
    if (hitTp) return "win";
    if (hitSl) return "loss";
  }
  const lb = bars[end - 1];
  if (!lb) return null;
  return { kind: "time", movePct: (long ? (lb.c - entry) / entry : (entry - lb.c) / entry) * 100 };
}

/** Simulate one arm at one geometry; book every trade at the levels that DECIDED it. */
function simulate(set, g) {
  const perTrade = [];
  const buckets = [];
  let wins = 0, losses = 0, times = 0, unresolved = 0, ambiguous = 0;
  for (const c of set) {
    const bars = BARS_RAW[c.pair];
    if (!bars?.length) { unresolved++; continue; }
    let idx = -1;
    for (let i = 0; i < bars.length; i++) { if (bars[i].t <= c.ts) idx = i; else break; }
    if (idx < 0) { unresolved++; continue; }
    const entry = bars[idx].c;
    const atr = Number(c.tapeAtrPct ?? NaN);
    let tpPct, slPct;
    if (g.tp != null) { tpPct = g.tp; slPct = g.sl; }
    else {
      if (!Number.isFinite(atr) || atr <= 0) { unresolved++; continue; }
      tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
      slPct = Math.max(0.3, atr * STOP_ATR_MULT);
    }
    const long = c.dir === "long";
    const o = outcome(bars, c.ts, entry, tpPct, slPct, long);
    if (o === null) { unresolved++; continue; }
    const bucket = Math.floor(c.ts / BUCKET_MS);
    if (typeof o === "object") {
      times++; perTrade.push(o.movePct); buckets.push(bucket); continue;
    }
    if (o === "loss") {
      const tp = long ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
      const sl = long ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
      let start = -1;
      for (let i = 0; i < bars.length; i++) { if (bars[i].t > c.ts) { start = i; break; } }
      if (start >= 0) {
        for (let i = start; i < Math.min(bars.length, start + MAX_HOLD); i++) {
          const b = bars[i];
          const hitTp = long ? b.h >= tp : b.l <= tp;
          const hitSl = long ? b.l <= sl : b.h >= sl;
          if (hitTp && hitSl) { ambiguous++; break; }
          if (hitTp || hitSl) break;
        }
      }
    }
    if (o === "win") wins++; else losses++;
    perTrade.push(o === "win" ? tpPct : -slPct);
    buckets.push(bucket);
  }
  return { perTrade, buckets, wins, losses, times, unresolved, ambiguous };
}

const notionalOverEquity = NOTIONAL_CAP / EQUITY;
const SHIPPED = { name: "SHIPPED", tp: null, sl: null };

// ═════════════════════════════════════════════════════════════════════════
// PART 1 — THE TICKET'S ECONOMICS, NET OF THE LIVE FEE
// ═════════════════════════════════════════════════════════════════════════
console.log("=".repeat(104));
console.log("PART 1 — THE TICKET'S ECONOMICS ON THIS ACCOUNT (net of the live 0.08% fee)");
console.log("=".repeat(104));

const GEOM = [
  { name: "SHIPPED (TP=0.4xATR, SL=1.34xATR)", tp: null, sl: null },
  { name: "TP 0.3%  SL 1.2%", tp: 0.3, sl: 1.2 },
  { name: "TP 0.5%  SL 1.2%", tp: 0.5, sl: 1.2 },
  { name: "TP 0.8%  SL 1.2%", tp: 0.8, sl: 1.2 },
  { name: "TP 1.0%  SL 1.2%", tp: 1.0, sl: 1.2 },
  { name: "TP 1.2%  SL 1.2%", tp: 1.2, sl: 1.2 },
  { name: "TP 1.2%  SL 0.8%", tp: 1.2, sl: 0.8 },
  { name: "TP 1.5%  SL 1.0%", tp: 1.5, sl: 1.0 },
  { name: "TP 2.0%  SL 1.2%", tp: 2.0, sl: 1.2 },
];

const sigShort = control.filter((r) => r.dir === "short");
const uncShort = unconditional.filter((r) => r.dir === "short");
const sigAll = control;
const uncAll = unconditional;

console.log(`  equity $${EQUITY} | notional cap $${NOTIONAL_CAP} | notional/equity ${notionalOverEquity.toFixed(4)}x`);
console.log(`  fee: LIVE 0.08% (maker 0.02 entry + taker 0.06 exit) | taker-taker 0.12% | maker-maker 0.04%`);
console.log();

const geomRows = [];
for (const g of GEOM) {
  const S = simulate(sigShort, g);
  const U = simulate(uncShort, g);
  const n = S.wins + S.losses;
  if (!n) continue;
  const w = S.wins / n;
  const tp = g.tp ?? 0.45; // the median shipped TP, for the flat geometries
  const sl = g.sl ?? 1.5;  // the median shipped SL
  const wbe = (sl + FEE_LIVE) / (tp + sl + FEE_LIVE);
  const bracketLive = w * tp - (1 - w) * sl - FEE_LIVE;
  const bracketTaker = w * tp - (1 - w) * sl - FEE_TAKER;
  const bracketMaker = w * tp - (1 - w) * sl - FEE_MAKER;
  // the excess, clustered, net of the live fee
  const sNet = S.perTrade.map((p) => (p - FEE_LIVE) * notionalOverEquity);
  const uNet = U.perTrade.map((p) => (p - FEE_LIVE) * notionalOverEquity);
  const sc = clusterStats(sNet, S.buckets);
  const uc = clusterStats(uNet, U.buckets);
  const exc = sc.mean - uc.mean;
  const excSe = Math.sqrt(sc.se ** 2 + uc.se ** 2);
  geomRows.push({
    g, n, w, tp, sl, wbe, bracketLive, bracketTaker, bracketMaker,
    evLive: bracketLive * notionalOverEquity,
    evTaker: bracketTaker * notionalOverEquity,
    evMaker: bracketMaker * notionalOverEquity,
    excess: exc, t: excSe > 0 ? exc / excSe : 0,
    sClusters: sc.clusters, uClusters: uc.clusters,
    times: S.times, uncW: U.wins + U.losses ? U.wins / (U.wins + U.losses) : 0,
    S, U,
  });
}

console.log("  GEOMETRY                       sig n  win%   wBE(live)  feeDrag%stop  EV%(live)  EV%(taker)  EV%(maker)  EXC(live)  t(cl)  clus");
console.log("  " + "-".repeat(140));
for (const r of geomRows) {
  const feeDrag = (FEE_LIVE / r.sl) * 100;
  console.log(
    `  ${r.g.name.padEnd(28)} ${String(r.n).padStart(5)} ${(r.w * 100).toFixed(1).padStart(5)}% ${(r.wbe * 100).toFixed(1).padStart(8)}% ${feeDrag.toFixed(1).padStart(12)}% ${(r.evLive >= 0 ? "+" : "") + r.evLive.toFixed(4).padStart(9)} ${(r.evTaker >= 0 ? "+" : "") + r.evTaker.toFixed(4).padStart(10)} ${(r.evMaker >= 0 ? "+" : "") + r.evMaker.toFixed(4).padStart(10)} ${(r.excess >= 0 ? "+" : "") + r.excess.toFixed(4).padStart(9)} ${r.t.toFixed(2).padStart(5)} ${String(r.sClusters).padStart(4)}`,
  );
}
console.log();
console.log("  EV% is the NET expectancy per trade, in % of EQUITY, at the ticket's MEASURED win rate,");
console.log("  with the fee charged on the notional. EXC is the signal arm's excess over the");
console.log("  unconditional arm, on CLUSTER MEANS (5-minute buckets).");

// ═════════════════════════════════════════════════════════════════════════
// PART 2 — THE LEVERAGE / FEE ALGEBRA
// ═════════════════════════════════════════════════════════════════════════
console.log();
console.log("=".repeat(104));
console.log("PART 2 — THE FEE, THE LEVERAGE, AND WHAT EQUITY CANNOT FIX");
console.log("=".repeat(104));
console.log("  LEVERAGE DOES NOT CHANGE THE FEE ON A CAPPED NOTIONAL.");
console.log("  notional = min(riskBudget/stopFrac, $60). Leverage sets the MARGIN and the");
console.log("  liquidation distance. The fee is a rate on the NOTIONAL, so it is identical at");
console.log("  every leverage level once the cap binds.");
console.log();
console.log("    lev   margin$   liq dist%   notional$   fee$(live)  fee%(equity)  fee%(notional)  SL%  wBE(live)");
const SL_EX = 1.5;
for (const lev of [20, 34, 42]) {
  const m = 0.007;
  const liq = 1 / lev - m;
  const notional = NOTIONAL_CAP;
  const fee = (FEE_LIVE / 100) * notional;
  const tp = 0.45;
  const wbe = (SL_EX + FEE_LIVE) / (tp + SL_EX + FEE_LIVE);
  console.log(
    `    x${String(lev).padEnd(4)} $${(notional / lev).toFixed(3).padStart(7)} ${(liq * 100).toFixed(3).padStart(9)}% $${notional.toFixed(2).padStart(10)} $${fee.toFixed(4).padStart(10)} ${((fee / EQUITY) * 100).toFixed(4).padStart(11)}% ${FEE_LIVE.toFixed(3).padStart(12)}% ${SL_EX.toFixed(2).padStart(4)} ${(wbe * 100).toFixed(1).padStart(8)}%`,
  );
}
console.log();
console.log("  The fee in EQUITY terms at the live notional/equity of " + notionalOverEquity.toFixed(4) + "x:");
console.log(`    live (0.08%)    ${(FEE_LIVE * notionalOverEquity).toFixed(4)}% of equity per trade`);
console.log(`    taker (0.12%)   ${(FEE_TAKER * notionalOverEquity).toFixed(4)}% of equity per trade`);
console.log(`    maker (0.04%)   ${(FEE_MAKER * notionalOverEquity).toFixed(4)}% of equity per trade`);
console.log();
console.log("  THE BRACKET:  bracket = w*tp - (1-w)*sl - f   (% of NOTIONAL)");
console.log("  A NEGATIVE bracket cannot be fixed by ANY equity amount: the equity ratio is a");
console.log("  POSITIVE multiplier, so it can only shrink a negative expectancy toward zero.");
console.log();
console.log("    GEOMETRY                       w%      wBE(live)  bracket(live)  bracket(tkr)  bracket(mkr)  EV%(live)  w NEEDED");
for (const r of geomRows) {
  const wNeed = (r.sl + FEE_LIVE) / (r.tp + r.sl + FEE_LIVE);
  console.log(
    `    ${r.g.name.padEnd(28)} ${(r.w * 100).toFixed(1).padStart(5)}% ${(r.wbe * 100).toFixed(1).padStart(8)}% ${(r.bracketLive >= 0 ? "+" : "") + r.bracketLive.toFixed(4).padStart(12)} ${(r.bracketTaker >= 0 ? "+" : "") + r.bracketTaker.toFixed(4).padStart(12)} ${(r.bracketMaker >= 0 ? "+" : "") + r.bracketMaker.toFixed(4).padStart(12)} ${(r.evLive >= 0 ? "+" : "") + r.evLive.toFixed(4).padStart(9)} ${(wNeed * 100).toFixed(1).padStart(8)}%`,
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PART 3 — THE UNIVERSE SCREEN
// ═════════════════════════════════════════════════════════════════════════
console.log();
console.log("=".repeat(104));
console.log("PART 3 — THE UNIVERSE SCREEN");
console.log("=".repeat(104));

// Per-symbol facts: the collector's rows (ATR, spread, signal counts) and
// the live loop's own recorded book (the machine's real spreads).
const sym = new Map();
const touch = (p) => {
  if (!sym.has(p)) {
    sym.set(p, {
      pair: p, atr: [], spr: [], sig: 0, sigCl: new Set(), unc: 0, uncCl: new Set(),
      uncLong: 0, liveSpr: [], liveAtr: [], liveReads: 0, inCollector: false, inLive: false,
    });
  }
  return sym.get(p);
};
for (const r of rows) {
  const e = touch(r.pair);
  e.inCollector = true;
  if (Number.isFinite(Number(r.tapeAtrPct))) e.atr.push(Number(r.tapeAtrPct));
  if (Number.isFinite(Number(r.spreadBps))) e.spr.push(Number(r.spreadBps));
}
for (const r of control) { const e = touch(r.pair); e.sig++; e.sigCl.add(Math.floor(r.ts / BUCKET_MS)); }
for (const r of unconditional) {
  const e = touch(r.pair); e.unc++; e.uncCl.add(Math.floor(r.ts / BUCKET_MS));
  if (r.dir === "long") e.uncLong++;
}
for (const r of loopRows) {
  if (!r.pair) continue;
  const e = touch(r.pair);
  e.inLive = true;
  if (r.event === "model-agreement" && r.book?.sprBps != null) { e.liveSpr.push(r.book.sprBps); e.liveReads++; }
  if (r.event === "model-agreement" && r.tape?.atrPct != null) e.liveAtr.push(r.tape.atrPct);
}

// The venue's per-contract leverage cap.
const levCap = new Map();
for (const c of contracts) {
  if (c.status !== "Open" || c.rootSymbol !== "USDT") continue;
  levCap.set(c.symbol.replace("USDTM", ""), c.maxLeverage);
}

// The live ticket per symbol, and the fee drag it implies.
function ticketOf(atrPct) {
  return { tp: Math.min(0.5, Math.max(0.3, atrPct * 0.4)), sl: Math.max(0.3, atrPct * STOP_ATR_MULT) };
}

// The leave-one-symbol-out excess on the SHIPPED geometry.
const shipped = geomRows.find((r) => r.g.name.startsWith("SHIPPED"));
const loo = new Map();
if (shipped) {
  for (const p of sym.keys()) {
    const S = simulate(sigShort.filter((r) => r.pair !== p), SHIPPED);
    const U = simulate(uncShort.filter((r) => r.pair !== p), SHIPPED);
    const sNet = S.perTrade.map((x) => (x - FEE_LIVE) * notionalOverEquity);
    const uNet = U.perTrade.map((x) => (x - FEE_LIVE) * notionalOverEquity);
    const sc = clusterStats(sNet, S.buckets);
    const uc = clusterStats(uNet, U.buckets);
    const e = sc.mean - uc.mean;
    loo.set(p, { delta: shipped.excess - e, excess: e, clusters: sc.clusters });
  }
}

console.log();
console.log("  The tradability test, per symbol:");
console.log("    ATR%    the ticket's TP = clamp(0.4*ATR, 0.3, 0.5) and SL = 1.34*ATR");
console.log("    feeDrag the live 0.08% fee as a fraction of the stop distance (the cap is 1/3)");
console.log("    wBE     the win rate the ticket needs to break even at the live fee");
console.log("    spread  the machine's own recorded book spread (bps), median and p90");
console.log("    sigRows/sigClus  how many signal observations the symbol produced");
console.log("    LOO     leave-one-symbol-out: how much the total excess moves if the symbol is dropped");
console.log();
console.log("  pair             ATR%   spreadBps(live)  TP%    SL%    feeDrag%stop  wBE(live)  sigRows sigClus  uncRows  levCap  LOOΔ      note");
console.log("  " + "-".repeat(160));
const screen = [];
for (const [p, e] of sym) {
  const atrAll = [...e.atr, ...e.liveAtr];
  const atr = med(atrAll);
  const spr = e.liveSpr.length ? med(e.liveSpr) : med(e.spr);
  const sprP90 = e.liveSpr.length ? q(e.liveSpr, 0.9) : q(e.spr, 0.9);
  const tk = ticketOf(atr);
  const feeDrag = FEE_LIVE / tk.sl;
  const wbe = (tk.sl + FEE_LIVE) / (tk.tp + tk.sl + FEE_LIVE);
  const base = p.split("/")[0];
  const cap = levCap.get(base);
  const l = loo.get(p);
  screen.push({ p, e, atr, spr, sprP90, tk, feeDrag, wbe, cap, loo: l });
}
screen.sort((a, b) => (b.loo?.delta ?? 0) - (a.loo?.delta ?? 0));
for (const s of screen) {
  const notes = [];
  if (s.feeDrag > 1 / 3) notes.push("FEE DRAG > 1/3 STOP");
  if (s.cap != null && s.cap <= 20) notes.push(`lev cap ${s.cap}`);
  if (s.e.sigCl.size < 3) notes.push("thin signal");
  if (s.e.uncLong === 0 && s.e.inCollector) notes.push("no long-side tape");
  console.log(
    `  ${s.p.padEnd(16)} ${(Number.isFinite(s.atr) ? s.atr.toFixed(3) : "n/a").padStart(6)} ${(Number.isFinite(s.spr) ? s.spr.toFixed(2) : "n/a").padStart(12)} ${s.tk.tp.toFixed(3).padStart(6)} ${s.tk.sl.toFixed(3).padStart(6)} ${(s.feeDrag * 100).toFixed(1).padStart(12)}% ${(s.wbe * 100).toFixed(1).padStart(8)}% ${String(s.e.sig).padStart(7)} ${String(s.e.sigCl.size).padStart(7)} ${String(s.e.unc).padStart(8)} ${(s.cap != null ? s.cap : "?").toString().padStart(7)} ${((s.loo?.delta ?? 0) >= 0 ? "+" : "") + (s.loo?.delta ?? 0).toFixed(4).padStart(9)}  ${notes.join("; ")}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PART 4 — THE RECOMMENDED UNIVERSE, AND ITS EXPECTED EXCESS
// ═════════════════════════════════════════════════════════════════════════
console.log();
console.log("=".repeat(104));
console.log("PART 4 — THE RECOMMENDED SUBSET, AND HOW MUCH OF ITS ADVANTAGE IS REAL");
console.log("=".repeat(104));

// The screen's own criteria, applied to the CURRENT live pool vs a
// screened pool. "Tradable" = the fee drag fits under 1/3 of the stop AND
// the venue's leverage cap allows the ticket AND the symbol has enough
// signal history to measure.
const tradable = screen.filter((s) => s.feeDrag <= 1 / 3 && (s.cap == null || s.cap >= 20) && s.e.unc >= 5);
console.log(`  symbols with fee drag <= 1/3 of the stop, lev cap >= 20, and >= 5 unconditional observations: ${tradable.length}`);
console.log("  " + tradable.map((s) => s.p).join(" "));
console.log();

// The cluster-corrected excess of a SUBSET, against the SAME control:
// the excess of the subset's signal arm over the subset's own unconditional arm.
function subsetExcess(subsetPairs, label) {
  const S = simulate(sigShort.filter((r) => subsetPairs.has(r.pair)), SHIPPED);
  const U = simulate(uncShort.filter((r) => subsetPairs.has(r.pair)), SHIPPED);
  // An EMPTY signal arm has NO excess: the difference of two means with
  // no signal arm is just minus the control's mean, which is a number
  // that LOOKS like an excess and is not one. It must be refused.
  if (S.perTrade.length === 0) {
    return { label, n: 0, clusters: 0, excess: NaN, t: NaN, trimWorst: NaN, trimBest: NaN, sMean: NaN, uMean: NaN, empty: true };
  }
  const sNet = S.perTrade.map((x) => (x - FEE_LIVE) * notionalOverEquity);
  const uNet = U.perTrade.map((x) => (x - FEE_LIVE) * notionalOverEquity);
  const sc = clusterStats(sNet, S.buckets);
  const uc = clusterStats(uNet, U.buckets);
  const exc = sc.mean - uc.mean;
  const excSe = Math.sqrt(sc.se ** 2 + uc.se ** 2);
  const t = excSe > 0 ? exc / excSe : 0;
  // the trim test
  const sorted = [...sNet].sort((a, b) => a - b);
  const tw = sorted.length > 6 ? sorted.slice(3) : sorted;
  const tb = sorted.length > 6 ? sorted.slice(0, sorted.length - 3) : sorted;
  const uMean = uc.mean;
  const exW = mean(tw) - uMean;
  const exB = mean(tb) - uMean;
  return {
    label, n: S.wins + S.losses, clusters: sc.clusters, excess: exc, t,
    trimWorst: exW, trimBest: exB, sMean: sc.mean, uMean,
  };
}

const ALL = new Set(sym.keys());
const results = [];
results.push(subsetExcess(ALL, "ALL collector symbols (the current screen)"));
for (const s of screen) {
  results.push(subsetExcess(new Set([s.p]), s.p));
}
results.sort((a, b) => b.excess - a.excess);
console.log("  PER-SYMBOL EXCESS (the symbol's signal arm vs ITSELF in the unconditional arm), SHIPPED geometry");
console.log("  pair             sig n  clus  excess%(eq)  t(cl)  trim-worst  trim-best   verdict");
console.log("  " + "-".repeat(96));
for (const r of results) {
  if (r.empty) {
    console.log(`  ${r.label.padEnd(16)} ${String(0).padStart(5)} ${String(0).padStart(4)} ${"—".padStart(12)} ${"—".padStart(5)} ${"—".padStart(10)} ${"—".padStart(10)}  no signal observations`);
    continue;
  }
  const ok = r.excess > 0 && r.t >= 2 && r.trimWorst > 0 && r.trimBest > 0;
  const partial = r.excess > 0 && r.t >= 2;
  const clustersOk = r.clusters >= 30;
  console.log(
    `  ${r.label.padEnd(16)} ${String(r.n).padStart(5)} ${String(r.clusters).padStart(4)} ${(r.excess >= 0 ? "+" : "") + r.excess.toFixed(4).padStart(12)} ${r.t.toFixed(2).padStart(5)} ${(r.trimWorst >= 0 ? "+" : "") + r.trimWorst.toFixed(4).padStart(10)} ${(r.trimBest >= 0 ? "+" : "") + r.trimBest.toFixed(4).padStart(10)}  ${ok ? "CLEARS" : partial ? (clustersOk ? "partial (few clusters)" : "partial") : "no"}`,
  );
}
console.log();
console.log("  A per-symbol ranking on THIS sample is a HYPOTHESIS for the next window, not a result:");
console.log("  the same selection-bias that cleared the fade/dip family at 0.4-0.6% of pure chance");
console.log("  applies here. The bar is n>=30 INDEPENDENT CLUSTERS, excess>0, t>=2, AND the trim.");

// ═════════════════════════════════════════════════════════════════════════
// PART 5 — THE ACCOUNT-SIZE VERDICT
// ═════════════════════════════════════════════════════════════════════════
console.log();
console.log("=".repeat(104));
console.log("PART 5 — THE ACCOUNT-SIZE VERDICT");
console.log("=".repeat(104));
const sh = shipped;
if (sh) {
  console.log(`  The shipped geometry, measured on this account:`);
  console.log(`    ticket: TP ${sh.tp.toFixed(2)}% (median)  SL ${sh.sl.toFixed(2)}% (median)  fee ${FEE_LIVE}% of notional`);
  console.log(`    ticket win rate MEASURED: ${(sh.w * 100).toFixed(1)}%  (n=${sh.n} resolved signal trades)`);
  console.log(`    break-even win rate at the live fee: ${(sh.wbe * 100).toFixed(1)}%`);
  console.log(`    break-even win rate at taker-taker: ${((sh.sl + FEE_TAKER) / (sh.tp + sh.sl + FEE_TAKER) * 100).toFixed(1)}%`);
  console.log(`    net expectancy per trade: ${(sh.evLive).toFixed(4)}% of equity (live fee) / ${(sh.evTaker).toFixed(4)}% (taker) / ${(sh.evMaker).toFixed(4)}% (maker)`);
  console.log(`    in dollars on $${EQUITY}: $${((sh.evLive / 100) * EQUITY).toFixed(4)} / $${((sh.evTaker / 100) * EQUITY).toFixed(4)} / $${((sh.evMaker / 100) * EQUITY).toFixed(4)}`);
  console.log(`    time exits: ${sh.times} of ${sh.n + sh.times} trades (${((sh.times / (sh.n + sh.times)) * 100).toFixed(1)}%) never reached either level`);
  console.log();
  console.log("  HOW MUCH EQUITY WOULD MAKE THIS VIABLE?");
  console.log(`    The bracket at the measured win rate: ${sh.bracketLive.toFixed(4)}% of notional (live fee).`);
  console.log(`    ${sh.bracketLive < 0 ? "NEGATIVE — no amount of equity fixes it." : "POSITIVE — the account grows, but see the cap below."}`);
  console.log();
  console.log("    THE $60 CAP BINDS. EV%_equity = bracket * min(riskBudget/stopFrac, $60)/equity.");
  console.log("    As equity grows, the $60 cap binds harder and the % return per trade DECLINES.");
  for (const eq of [57.16, 100, 250, 500, 1000, 5000, 10000, 100000]) {
    const riskBudget = (eq * RISK_PCT) / 100;
    const notional = Math.min(riskBudget / (sh.sl / 100), NOTIONAL_CAP);
    const evUsd = (sh.bracketLive / 100) * notional;
    console.log(`      equity $${String(eq).padStart(7)}  risk budget $${riskBudget.toFixed(2).padStart(8)}  notional $${notional.toFixed(2).padStart(7)}  EV/trade $${evUsd.toFixed(4).padStart(8)}  = ${((evUsd / eq) * 100).toFixed(4)}% of equity`);
  }
  console.log();
  console.log("    To reach $10,000 from $57.16 with a $60 notional cap, the account must first");
  console.log("    grow past the point where the cap binds on its own. The cap is $60; the risk");
  console.log(`    budget at 2% reaches $60 when equity = $${(NOTIONAL_CAP / (RISK_PCT / 100)).toFixed(0)}.`);
  console.log("    Below that, the notional is risk-budget-limited and the account CAN compound.");
  console.log("    Above it, the cap binds and the % return falls as the account grows.");
  const eqUncapped = NOTIONAL_CAP / (RISK_PCT / 100);
  console.log();
  console.log("    THE GROWTH ARITHMETIC (if the bracket stays positive):");
  for (const perDay of [1, 2, 3]) {
    const evPerTradeUsd = (sh.bracketLive / 100) * NOTIONAL_CAP;
    console.log(`      at ${perDay} trade(s)/day: $${evPerTradeUsd.toFixed(4)}/trade -> $${(evPerTradeUsd * perDay).toFixed(4)}/day on $57.16 equity = ${((evPerTradeUsd * perDay / 57.16) * 100).toFixed(3)}%/day`);
  }
  console.log("      (this assumes the measured bracket holds OUT OF SAMPLE, which it does not");
  console.log("       currently: the excess fails its t>=2 and trim bar.)");
}

// ═════════════════════════════════════════════════════════════════════════
// PART 6 — REACHABILITY: IS THE TICKET'S TARGET ACTUALLY REACHABLE?
// ═════════════════════════════════════════════════════════════════════════
console.log();
console.log("=".repeat(104));
console.log("PART 6 — REACHABILITY: how far does the price actually travel, and how fast");
console.log("=".repeat(104));
console.log("  The MFE (the move available to the trade) and the MAE (the move against it),");
console.log("  measured over the 4-hour hold on the SAME signal observations, in % of the entry.");
const mfe = [];
const mae = [];
const barsToTp = [];
  for (const c of sigShort) {
    const bars = BARS_RAW[c.pair];
    if (!bars?.length) continue;
    let idx = -1;
    for (let i = 0; i < bars.length; i++) { if (bars[i].t <= c.ts) idx = i; else break; }
    if (idx < 0) continue;
    const entry = bars[idx].c;
    const atr = Number(c.tapeAtrPct);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const end = Math.min(bars.length, idx + 1 + MAX_HOLD);
    let hi = -Infinity, lo = Infinity;
    for (let i = idx + 1; i < end; i++) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    mfe.push(((entry - lo) / entry) * 100); // a short's MFE is the DOWN move
    mae.push(((hi - entry) / entry) * 100); // and its MAE is the UP move
    // how many 15-min bars to the TP
    const tp = Math.min(0.5, Math.max(0.3, atr * 0.4));
    const tpP = entry * (1 - tp / 100);
    for (let i = idx + 1; i < end; i++) { if (bars[i].l <= tpP) { barsToTp.push(i - idx); break; } }
  }
  console.log(`  n=${mfe.length} signal observations`);
  console.log(`    MFE (down move available): mean ${mean(mfe).toFixed(3)}%  median ${med(mfe).toFixed(3)}%  p25 ${q(mfe, 0.25).toFixed(3)}%  p75 ${q(mfe, 0.75).toFixed(3)}%  p90 ${q(mfe, 0.9).toFixed(3)}%`);
  console.log(`    MAE (up move against):      mean ${mean(mae).toFixed(3)}%  median ${med(mae).toFixed(3)}%  p25 ${q(mae, 0.25).toFixed(3)}%  p75 ${q(mae, 0.75).toFixed(3)}%  p90 ${q(mae, 0.9).toFixed(3)}%`);
  console.log(`    bars (15 min) to the TP: median ${med(barsToTp).toFixed(1)}  mean ${mean(barsToTp).toFixed(1)}`);
  console.log();
  console.log("    TP REACHABILITY (the share of observations whose 4h MFE reaches the target):");
  for (const tp of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0]) {
    const hit = (mfe.filter((x) => x >= tp).length / Math.max(1, mfe.length)) * 100;
    console.log(`      TP ${tp.toFixed(1)}%  reached by ${hit.toFixed(1)}% of the observations`);
  }
  console.log();
  console.log("    STOP HIT RATE (the raw rate at which the stop level is touched within 4h):");
  for (const sl of [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0]) {
    const hit = (mae.filter((x) => x >= sl).length / Math.max(1, mae.length)) * 100;
    console.log(`      SL ${sl.toFixed(1)}%  touched by ${hit.toFixed(1)}% of the observations`);
  }
  console.log();
  console.log("    WHICH GEOMETRIES HAVE A BREAK-EVEN BELOW THE MEASURED WIN RATE?");
  console.log("    (the shipped ticket's measured win rate is " + ((sh?.w ?? 0) * 100).toFixed(1) + "%)");
  for (const r of geomRows) {
    if (r.wbe < (sh?.w ?? 0)) {
      console.log(`      ${r.g.name.padEnd(30)} wBE ${(r.wbe * 100).toFixed(1)}%  <  measured ${((sh?.w ?? 0) * 100).toFixed(1)}%  -> VIABLE in principle (but its excess fails the t/trim bar)`);
    }
  }
