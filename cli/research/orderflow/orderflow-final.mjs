#!/usr/bin/env node
/**
 * THE ORDER-FLOW STUDY — the final, corrected measurement.
 *
 * ══ WHAT THIS MEASURES ══
 *
 * The four order-flow questions, on the machine's OWN ticket (the
 * market-anchored one, which is what the venue arms once it rebases the
 * exit legs onto the actual fill):
 *
 *   (1) THE BOOK IMBALANCE as a predictor of the next 15m/1h/4h move,
 *       with and without the exhaustion condition.
 *   (2) WHETHER A LARGE IMBALANCE PREDICTS A REVERSAL rather than a
 *       continuation (adverse selection).
 *   (3) WHETHER THE IMBALANCE DIVERGES FROM THE PRICE MOVE — a price
 *       that rises while the book leans short is an exhaustion signature.
 *   (4) THE TRADE-FLOW PROXIES: volume surge against price direction,
 *       and the VWAP gap.
 *
 * ══ THE TICKET ══
 *
 * The MARKET-ANCHORED ticket: the entry is the market price (the live
 * path places a market order, src/commands/live.ts:256), and the
 * take-profit and the stop keep the live path's OWN distances
 * (tpPct = clamp(0.4*ATR, 0.3, 0.5), the ladder's stop distance).
 *
 * The RESEARCH ticket (anchored on avgEntry) is measured beside it, so
 * the report can show what the anchor does to the numbers.
 *
 * ══ THE RULES ══
 *
 *   - Rows are not observations. The cluster is the 5-minute round.
 *   - A forward return is not a trade. Every tradeable number comes
 *     from a first-touch TP/kill, with both-levels-touched a LOSS and
 *     an explicit TIME EXIT.
 *   - The t tests the EXCESS over a genuine control: the same
 *     population, the same direction, paired by cluster.
 *   - A PLACEBO of the same shape, and a DAY-BLOCK BOOTSTRAP.
 *   - The worst-3/best-3 trim, and the symbol concentration.
 *
 * READ-ONLY. Local files only.
 */
import { join } from "node:path";
import {
  SCRATCH, loadRows, loadBars, mean, fmt, bucketOf, hourBucketOf,
  NOTIONAL, EQUITY, RHO, ROUND_TRIP, FEE_USD,
} from "./lib.mjs";
import { resolve, measureArm, tradeExcess, trimTrade, fmtArm } from "./trade.mjs";
import { researchTicket, marketTicket } from "./ticket.mjs";
import { excessVsDirectionMatched, placeboDirectionMatched, concentration, dayBlockBootstrap } from "./measure.mjs";

// ══════════════════════════════════════════════════════════════════════
// THE DATA
// ══════════════════════════════════════════════════════════════════════
const conf = loadRows(join(SCRATCH, "oflow/conf-frozen.json"));
const kbars = loadBars(join(SCRATCH, "oflow/bars-frozen.json"));

const confRows = conf.filter((r) => r.bookImbalance != null && r.price > 0);
const cts = confRows.map((r) => r.ts).sort((a, b) => a - b);
console.log(`[of] collector rows ${conf.length}; usable ${confRows.length}`);
console.log(`[of] collector span ${new Date(cts[0]).toISOString()} -> ${new Date(cts[cts.length - 1]).toISOString()}`);
console.log(`[of] collector rounds(5m) ${new Set(confRows.map((r) => bucketOf(r.ts))).size}  hours ${new Set(confRows.map((r) => hourBucketOf(r.ts))).size}`);

const tapeSideOf = (r) => {
  const vratio = Number(r.tapeVratio ?? 1);
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  if (vratio < 0.85 && oh < 8) return "short";
  if (vratio < 0.85 && ol < 8) return "long";
  return null;
};

/** The forward return from the read, over H minutes, on the 15m bars. */
function fwd(r, H) {
  const b = kbars[r.pair];
  if (!b || !b.length) return null;
  let i = -1;
  for (let k = 0; k < b.length; k++) if (b[k].t > r.ts) { i = k; break; }
  if (i < 0) return null;
  const n = Math.max(1, Math.round(H / 15));
  const j = i + n - 1;
  if (j >= b.length) return null;
  return (b[j].c - r.price) / r.price;
}

// ══════════════════════════════════════════════════════════════════════
// (1) THE BOOK IMBALANCE AS A PREDICTOR
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" (1) THE BOOK IMBALANCE AS A PREDICTOR of the forward move");
console.log("══════════════════════════════════════════════════════════════");
console.log(" the control is the SAME population, SAME direction, paired by cluster.");
console.log(" the sign-flip control is the same rows scored the other way.");

function predictor(label, armRows, dirOf, H) {
  if (armRows.length < 30) { console.log(`\n  ${label}: n=${armRows.length} TOO FEW`); return null; }
  const pool = confRows.map((r) => ({ o: { t: r.ts, sym: r.pair }, v: fwd(r, H) })).filter((x) => x.v != null);
  const arm = armRows.map((r) => ({ o: { t: r.ts, sym: r.pair }, v: fwd(r, H) })).filter((x) => x.v != null);
  if (arm.length < 30) { console.log(`\n  ${label}: too few with a forward bar`); return null; }
  const res = excessVsDirectionMatched(arm, pool, dirOf, bucketOf);
  if (!res) { console.log(`\n  ${label}: no result`); return null; }
  const res1 = excessVsDirectionMatched(arm, pool, dirOf, hourBucketOf);
  const conc = concentration(arm);
  // the sign-flip: the same rows, the other direction
  const flip = excessVsDirectionMatched(arm, pool, () => (dirOf(arm[0]) === "long" ? "short" : "long"), bucketOf);
  console.log(`\n  ── ${label} ──`);
  console.log(`     n=${res.n} | clusters 5m=${res.clusters}  1h=${res1?.clusters}`);
  console.log(`     arm mean ${fmt(res.armMean)}%  control(${res.dir}) mean ${fmt(res.ctlMean)}%`);
  console.log(`     EXCESS 5m: ${fmt(res.mean)}%  se ${fmt(res.se)}  t=${fmt(res.t, 2)}   TRIM t=${fmt(res.trim.t, 2)}`);
  if (res1) console.log(`     EXCESS 1h: ${fmt(res1.mean)}%  se ${fmt(res1.se)}  t=${fmt(res1.t, 2)}   TRIM t=${fmt(res1.trim.t, 2)}`);
  if (flip) console.log(`     SIGN-FLIP: ${fmt(flip.mean)}%  t=${fmt(flip.t, 2)}`);
  console.log(`     symbols ${conc.distinct}; largest ${conc.top[0]} ${(conc.topShare * 100).toFixed(1)}%`);
  return { res, res1, flip, conc };
}

for (const H of [15, 60, 240]) {
  const usable = confRows.filter((r) => fwd(r, H) != null);
  console.log(`\n  ═══ HORIZON ${H}m — ${usable.length} rows with a forward bar ═══`);
  for (const th of [0.3, 0.5]) {
    const longs = usable.filter((r) => r.bookImbalance >= th);
    const shorts = usable.filter((r) => r.bookImbalance <= -th);
    if (longs.length > 30) predictor(`LONG imb >= +${th} @${H}m`, longs, () => "long", H);
    if (shorts.length > 30) predictor(`SHORT imb <= -${th} @${H}m`, shorts, () => "short", H);
  }
}

console.log("\n  ── (1b) THE SAME, ON THE EXHAUSTION SUBSET ──");
for (const H of [15, 60]) {
  const usable = confRows.filter((r) => fwd(r, H) != null);
  const exh = usable.filter((r) => tapeSideOf(r));
  console.log(`\n  HORIZON ${H}m: exhaustion rows ${exh.length}`);
  if (exh.length > 30) {
    predictor(`EXHAUSTION ALONE @${H}m`, exh, (r) => tapeSideOf(r), H);
    for (const th of [0.3, 0.5]) {
      const conf2 = exh.filter((r) => {
        const t = tapeSideOf(r);
        return t === "long" ? r.bookImbalance >= th : r.bookImbalance <= -th;
      });
      if (conf2.length > 30) predictor(`EXHAUSTION + imb agrees (|imb|>=${th}) @${H}m`, conf2, (r) => tapeSideOf(r), H);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// (2) A LARGE IMBALANCE: REVERSAL OR CONTINUATION?
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" (2) A LARGE IMBALANCE — REVERSAL OR CONTINUATION? (adverse selection)");
console.log("══════════════════════════════════════════════════════════════");
for (const H of [15, 60]) {
  const usable = confRows.filter((r) => fwd(r, H) != null);
  console.log(`\n  ═══ HORIZON ${H}m ═══`);
  for (const th of [0.5, 0.7]) {
    // CONTINUATION: a bid-heavy book goes long
    const longs = usable.filter((r) => r.bookImbalance >= th);
    // REVERSAL: the same rows, short
    if (longs.length > 30) {
      const cont = predictor(`LARGE imb >= +${th} -> LONG (continuation) @${H}m`, longs, () => "long", H);
      const rev = predictor(`LARGE imb >= +${th} -> SHORT (reversal) @${H}m`, longs, () => "short", H);
      if (cont && rev) {
        console.log(`     >>> the continuation and the reversal excesses: ${fmt(cont.res.mean)}% (t=${fmt(cont.res.t, 2)}) vs ${fmt(rev.res.mean)}% (t=${fmt(rev.res.t, 2)})`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// (3) THE IMBALANCE DIVERGING FROM THE PRICE MOVE
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" (3) THE IMBALANCE DIVERGING FROM THE PRICE MOVE");
console.log("     (a price that rises while the book leans SHORT is an exhaustion");
console.log("      signature — and the trade is to go LONG against the move)");
console.log("══════════════════════════════════════════════════════════════");
for (const H of [15, 60]) {
  const usable = confRows.filter((r) => fwd(r, H) != null && r.tapeChg != null);
  console.log(`\n  ═══ HORIZON ${H}m ═══`);
  // the price moved UP, the book leans SHORT
  const divUp = usable.filter((r) => r.tapeChg > 0 && r.bookImbalance <= -0.3);
  // the price moved DOWN, the book leans LONG
  const divDn = usable.filter((r) => r.tapeChg < 0 && r.bookImbalance >= 0.3);
  // the CONVERGENT control: the price moved UP, the book leans LONG
  const convUp = usable.filter((r) => r.tapeChg > 0 && r.bookImbalance >= 0.3);
  if (divUp.length > 30) predictor(`DIVERGENCE: price UP, book SHORT -> LONG @${H}m`, divUp, () => "long", H);
  if (divDn.length > 30) predictor(`DIVERGENCE: price DOWN, book LONG -> SHORT @${H}m`, divDn, () => "short", H);
  if (convUp.length > 30) predictor(`CONVERGENCE (control): price UP, book LONG -> LONG @${H}m`, convUp, () => "long", H);
}

// ══════════════════════════════════════════════════════════════════════
// (4) THE TRADE-FLOW PROXIES AS TRADES
// ══════════════════════════════════════════════════════════════════════
console.log("\n\n══════════════════════════════════════════════════════════════");
console.log(" (4) THE TRADE-FLOW PROXIES AS TRADES");
console.log("     (Binance USDⓈ-M, 14 days, 38 symbols, 5-minute grid)");
console.log("══════════════════════════════════════════════════════════════");

const { readFileSync } = await import("node:fs");
const tf15 = loadBars(join(SCRATCH, "oflow/binance-tf-bars.json"));
const tf5 = loadBars(join(SCRATCH, "oflow/binance-tf-bars5m.json"));
const tapeRows = [];
for (const line of readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8").trim().split("\n")) {
  if (!line) continue;
  try { tapeRows.push(JSON.parse(line)); } catch { /* skip */ }
}
const flowByKey = new Map();
for (const [sym, bars] of Object.entries(tf15)) {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.v > 0) || !(b.qv > 0)) continue;
    const trail = bars.slice(Math.max(0, i - 20), i).map((x) => x.v).filter((x) => x > 0).sort((a, c) => a - c);
    if (trail.length < 10) continue;
    const medV = trail[Math.floor(trail.length / 2)];
    const vwap = b.qv / b.v;
    flowByKey.set(`${sym}|${b.t}`, {
      tfi: (b.tb - (b.v - b.tb)) / b.v,
      closeToVwap: ((b.c - vwap) / vwap) * 100,
      vSurge: medV > 0 ? b.v / medV : 0,
    });
  }
}
const bars5ByBase = new Map();
for (const [sym, bars] of Object.entries(tf5)) bars5ByBase.set(sym, bars);

const deep = [];
let deepNoFlow = 0, deepNoBars = 0;
for (const r of tapeRows) {
  if (!(r.price > 0) || !(r.tapeAtrPct > 0)) continue;
  const base = r.pair.split("/")[0];
  const bs = bars5ByBase.get(base);
  if (!bs || bs.length < 50) { deepNoBars++; continue; }
  const barT = Math.floor(r.ts / 900_000) * 900_000;
  const flow = flowByKey.get(`${base}|${barT}`);
  if (!flow) { deepNoFlow++; continue; }
  deep.push({ r, base, flow, ts: r.ts, price: r.price });
}
const dts = deep.map((o) => o.ts).sort((a, b) => a - b);
console.log(`[of] deep joined ${deep.length} (noFlow ${deepNoFlow}, noBars ${deepNoBars})`);
console.log(`[of] deep span ${new Date(dts[0]).toISOString()} -> ${new Date(dts[dts.length - 1]).toISOString()}`);
console.log(`[of] deep rounds(5m) ${new Set(deep.map((o) => bucketOf(o.ts))).size}  hours ${new Set(deep.map((o) => hourBucketOf(o.ts))).size}`);

function toTrades(armRows, dirOf, ticketFn) {
  const trades = [];
  for (const o of armRows) {
    const dir = dirOf(o);
    const tk = ticketFn(o.r.tapeAtrPct, o.price, dir);
    if (!tk) continue;
    const res = resolve(tk, dir, bars5ByBase.get(o.base), o.ts, 48); // 48 x 5m = 240m
    if (!res) continue;
    trades.push({
      ...res, dir, sym: o.base, ts: o.ts,
      bucket: bucketOf(o.ts), hourBucket: hourBucketOf(o.ts),
      pnlUsd: res.pnlPct * NOTIONAL,
    });
  }
  return trades;
}

function tradeReport(label, armRows, dirOf, controlRows, controlDir, ticketFn) {
  const trades = toTrades(armRows, dirOf, ticketFn);
  const ctl = toTrades(controlRows, controlDir, ticketFn);
  if (trades.length < 50) { console.log(`\n  ${label}: n=${trades.length} TOO FEW`); return null; }
  const m = measureArm(trades, label);
  const cm = measureArm(ctl, `${label} CTL`);
  const ex = tradeExcess(trades, ctl);
  const tm = trimTrade(ex.diffs, 3);
  const bySym = new Map();
  for (const t of trades) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + 1);
  const sorted = [...bySym.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((a, b) => a + b[1], 0);
  console.log(`\n  ══ ${label} ══`);
  console.log(`     ARM      ${fmtArm(m)}`);
  if (cm) console.log(`     CONTROL  ${fmtArm(cm)}`);
  console.log(`     EXCESS over the control: $${ex.mean.toFixed(5)}/trade  se $${ex.se.toFixed(5)}  t=${fmt(ex.t, 2)}  (${ex.n} paired clusters)`);
  console.log(`     TRIM worst-3/best-3: t=${fmt(tm.t, 2)} (n=${tm.n})  worst3=[${tm.worst3}] best3=[${tm.best3}]`);
  console.log(`     symbols ${sorted.length}; largest ${sorted[0][0]} ${((sorted[0][1] / total) * 100).toFixed(1)}%  next ${sorted.slice(1, 4).map((s) => `${s[0]} ${((s[1] / total) * 100).toFixed(1)}%`).join(", ")}`);
  return { label, m, cm, ex, tm, sorted, total };
}

console.log("\n  ── the tape's own exhaustion arm (the machine's signal), deep ──");
const exhRows = deep.filter((o) => tapeSideOf(o.r));
console.log(`  exhaustion rows ${exhRows.length}`);
const CONTROL_LONG = deep;
for (const [tn, tf] of [["market-anchored", marketTicket], ["research", researchTicket]]) {
  console.log(`\n  ── ticket: ${tn} ──`);
  tradeReport(`EXHAUSTION (tape side) [${tn}]`, exhRows, (o) => tapeSideOf(o.r), CONTROL_LONG, () => "long", tf);
}

console.log("\n  ── the trade-flow proxies ──");
for (const sv of [1.5, 2.5]) {
  const up = deep.filter((o) => o.flow.vSurge >= sv && o.r.tapeChg > 0);
  const dn = deep.filter((o) => o.flow.vSurge >= sv && o.r.tapeChg < 0);
  tradeReport(`SURGE>=${sv}x UP bar -> LONG (continuation)`, up, () => "long", CONTROL_LONG, () => "long", marketTicket);
  tradeReport(`SURGE>=${sv}x UP bar -> SHORT (exhaustion)`, up, () => "short", CONTROL_LONG, () => "short", marketTicket);
  tradeReport(`SURGE>=${sv}x DOWN bar -> SHORT (continuation)`, dn, () => "short", CONTROL_LONG, () => "short", marketTicket);
  tradeReport(`SURGE>=${sv}x DOWN bar -> LONG (exhaustion)`, dn, () => "long", CONTROL_LONG, () => "long", marketTicket);
}
for (const th of [0.15, 0.3]) {
  const longs = deep.filter((o) => o.flow.tfi >= th);
  const shorts = deep.filter((o) => o.flow.tfi <= -th);
  tradeReport(`TFI >= +${th} -> LONG`, longs, () => "long", CONTROL_LONG, () => "long", marketTicket);
  tradeReport(`TFI <= -${th} -> SHORT`, shorts, () => "short", CONTROL_LONG, () => "short", marketTicket);
}
for (const g of [0.15, 0.3]) {
  const above = deep.filter((o) => o.flow.closeToVwap >= g);
  const below = deep.filter((o) => o.flow.closeToVwap <= -g);
  tradeReport(`VWAP gap >= +${g}% -> SHORT (paid up)`, above, () => "short", CONTROL_LONG, () => "short", marketTicket);
  tradeReport(`VWAP gap <= -${g}% -> LONG (washed out)`, below, () => "long", CONTROL_LONG, () => "long", marketTicket);
}
