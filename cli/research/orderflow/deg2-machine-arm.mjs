#!/usr/bin/env node
/**
 * THE DEGENERACY AUDIT, ON THE MACHINE'S OWN ARM — the KuCoin
 * confluence data, the cited 11-trade baseline, and the ticket's
 * anchor.
 *
 * ══ THE FINDING UNDER TEST ══
 *
 * The live path places a MARKET entry (src/commands/live.ts:256,
 * `type: "market"`), so the fill is at the MARKET price — not at
 * `avgEntry`. But the ticket's take-profit is computed from
 * `avgEntry` (src/kucoin.ts:222), and for a SHORT `avgEntry` sits
 * ABOVE the market (the ladder buys back lower). So the TP is
 * computed from a price the market never traded at.
 *
 * The research script `live-gate-ev.mjs` reproduces this: it resolves
 * the ticket from `avgEntry` and books a win when the FIRST forward
 * bar's high/low touches the TP.
 *
 * The consequence: if the TP sits within the FIRST bar's range (which
 * it does when the TP distance from the market is smaller than the
 * bar's noise), the trade wins on the first bar REGARDLESS of the
 * market's direction. On a dataset where 29 of 38 symbols fell, a
 * ticket that wins 98% of the time in BOTH directions is not
 * measuring an edge.
 *
 * ══ WHAT THIS SCRIPT MEASURES, ON THE MACHINE'S OWN ARM ══
 *
 *   (1) the TP's distance from the market price, for the research
 *       ticket and for a market-anchored ticket;
 *   (2) the win rate of the research ticket vs the market-anchored
 *       ticket, on the SAME rows;
 *   (3) the net expectancy in DOLLARS for both;
 *   (4) the excess over the unconditional control for both.
 *
 * THE MARKET-ANCHORED TICKET (the corrected one):
 *   entry   = the market price (a market order fills at the market)
 *   TP      = entry x (1 ± tpPct/100)     with the live path's tpPct
 *   stop    = entry x (1 ± stopFrac)      with the live path's stop
 *
 * READ-ONLY. Local files only.
 */
import { join } from "node:path";
import {
  SCRATCH, loadRows, loadBars, mean, fmt, bucketOf, hourBucketOf,
  NOTIONAL, EQUITY, ROUND_TRIP, FEE_USD, RHO,
} from "./lib.mjs";
import { ticket, resolve, measureArm, tradeExcess, trimTrade, fmtArm } from "./trade.mjs";

const rows = loadRows(join(SCRATCH, "oflow/conf-frozen.json"));
const bars = loadBars(join(SCRATCH, "fee-floor-15m-bars.json"));

console.log(`[deg2] confluence rows ${rows.length}`);

/** The research script's ticket (live-gate-ev.mjs) — anchored on avgEntry. */
function researchTicket(atr, price, dir) {
  const d = Math.min(Math.max(0.9 * atr, 0.6), 1.5);
  const tpPct = Math.min(Math.max(0.4 * atr, 0.3), 0.5);
  const avgEntry = dir === "short" ? price * (1 + d / 200) : price * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  return {
    avgEntry,
    targetPrice: dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac),
    stopPrice: dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac),
    tpFrac, stopFrac, d, tpPct,
  };
}

/**
 * THE MARKET-ANCHORED TICKET — the corrected one.
 * The entry is the market price (a market order), so the TP and the
 * stop are measured FROM THE MARKET PRICE. The distances are the live
 * path's: tpPct = clamp(0.4*ATR, 0.3, 0.5) and the stop is the live
 * path's ladder distance 2 x clamp(0.9*ATR, 0.6, 1.5).
 */
function marketTicket(atr, price, dir) {
  const a = atr > 0 ? atr : 0.8;
  const tpPct = Math.min(0.5, Math.max(0.3, a * 0.4));
  const stepDropPct = Math.min(1.5, Math.max(0.6, a * 0.9));
  const stopFrac = (2 * stepDropPct) / 100;
  const tpFrac = tpPct / 100;
  const sign = dir === "short" ? -1 : 1;
  return {
    avgEntry: price,
    targetPrice: price * (1 + (sign * tpFrac)),
    stopPrice: price * (1 - (sign * stopFrac)),
    tpFrac, stopFrac, tpPct, stepDropPct,
  };
}

/** The live gate, exactly as live-gate-ev.mjs implements it. */
function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev || !laya || jev !== laya) return null;
  return jev;
}

const liveArm = [], tapeArm = [];
for (const r of rows) {
  const t = r.tapeSide ?? null;
  if (!t) continue;
  tapeArm.push({ ...r, dir: t });
  const g = liveGate(r);
  if (g && g === t) liveArm.push({ ...r, dir: g });
}
console.log(`[deg2] live-gate arm ${liveArm.length} rows | tape arm ${tapeArm.length} rows`);

// ══ (1) the TP's distance from the market price ══
console.log("\n══ (1) TP DISTANCE FROM THE MARKET PRICE (the machine's own arm) ══");
console.log("  ticket      dir   n    median%    p10     p90   |  TP on the wrong side of the price?");
for (const [name, fn] of [["research", researchTicket], ["market-anchored", marketTicket]]) {
  for (const dir of ["long", "short"]) {
    const d = [], wrong = [];
    let n = 0;
    for (const r of liveArm) {
      if (!(r.tapeAtrPct > 0) || !(r.price > 0)) continue;
      const t = fn(r.tapeAtrPct, r.price, dir);
      n++;
      const gap = dir === "short" ? (r.price - t.targetPrice) / r.price : (t.targetPrice - r.price) / r.price;
      d.push(gap * 100);
      const wrongSide = dir === "short" ? t.targetPrice > r.price : t.targetPrice < r.price;
      if (wrongSide) wrong.push(1);
    }
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    console.log(`  ${name.padEnd(15)} ${dir.padEnd(5)} ${String(n).padStart(3)}  ${med.toFixed(4).padStart(8)} ${d[Math.floor(d.length * 0.1)].toFixed(3).padStart(7)} ${d[Math.floor(d.length * 0.9)].toFixed(3).padStart(7)}   |  ${(wrong.length / Math.max(1, n) * 100).toFixed(1)}%`);
  }
}

// ══ (2)+(3)+(4) the arms, resolved ══
function buildTrades(arm, dirOf, ticketFn) {
  const trades = [];
  for (const r of arm) {
    const dir = dirOf(r);
    const tk = ticketFn(r.tapeAtrPct, r.price, dir);
    if (!tk) continue;
    const res = resolve(tk, dir, bars[r.pair], r.ts, 16);
    if (!res) continue;
    trades.push({
      ...res, dir, sym: r.pair, ts: r.ts,
      bucket: bucketOf(r.ts), hourBucket: hourBucketOf(r.ts),
      pnlUsd: res.pnlPct * NOTIONAL,
    });
  }
  return trades;
}

console.log("\n══ (2)(3)(4) THE ARMS: win rate, net expectancy in dollars, excess ══");
console.log("  (the machine's own live-gate arm — the 11 trades of the cited baseline)");
console.log();
console.log("  ticket            n  win%   time%  EV $      %equity  BE-WR   | excess vs tape-only: $      t     clusters");
const results = {};
for (const [name, fn] of [["research", researchTicket], ["market-anchored", marketTicket]]) {
  for (const label of ["LIVE-GATE", "TAPE-ONLY"]) {
    const arm = label === "LIVE-GATE" ? liveArm : tapeArm;
    const dirOf = label === "LIVE-GATE" ? (r) => r.dir : (r) => r.dir;
    const trades = buildTrades(arm, dirOf, fn);
    const ctlTrades = buildTrades(tapeArm, (r) => r.dir, fn);
    const m = measureArm(trades, `${name} ${label}`);
    const ex = tradeExcess(trades, ctlTrades);
    const tm = trimTrade(ex.diffs, 3);
    results[`${name} ${label}`] = { m, ex, tm };
    console.log(`  ${(`${name} ${label}`).padEnd(22)}${String(m.n).padStart(3)} ${(m.winRate * 100).toFixed(1).padStart(6)} ${(m.timesShare * 100).toFixed(1).padStart(6)}  ${m.evUsd.toFixed(4).padStart(8)} ${m.evPctEquity.toFixed(4).padStart(8)} ${(m.be * 100).toFixed(1).padStart(6)}%  | ${ex.mean.toFixed(5).padStart(9)} ${fmt(ex.t, 2).padStart(6)} ${String(ex.n).padStart(8)}`);
  }
}

console.log();
console.log("══ THE CITED BASELINE vs THE MARKET-ANCHORED TICKET ══");
const r1 = results["research LIVE-GATE"], r2 = results["market-anchored LIVE-GATE"];
console.log(`  CITED (research ticket): ${r1.m.n} trades, ${r1.m.wins} wins (${(r1.m.winRate * 100).toFixed(1)}%), EV ${r1.m.evUsd.toFixed(4)} (${r1.m.evPctEquity.toFixed(4)}% of equity)`);
console.log(`     excess over tape-only ${r1.ex.mean.toFixed(5)}  t=${fmt(r1.ex.t, 2)}  ${r1.ex.n} paired clusters  (CITED: +0.0752, t=3.15, 9 clusters)`);
console.log(`  MARKET-ANCHORED ticket:   ${r2.m.n} trades, ${r2.m.wins} wins (${(r2.m.winRate * 100).toFixed(1)}%), EV ${r2.m.evUsd.toFixed(4)} (${r2.m.evPctEquity.toFixed(4)}% of equity)`);
console.log(`     excess over tape-only ${r2.ex.mean.toFixed(5)}  t=${fmt(r2.ex.t, 2)}  ${r2.ex.n} paired clusters`);

console.log();
console.log("══ THE DOLLARS ══");
console.log(`  equity $${EQUITY.toFixed(2)} | notional $${NOTIONAL.toFixed(2)} | exposure ${RHO.toFixed(4)}x`);
console.log(`  taker round trip ${(ROUND_TRIP * 100).toFixed(4)}% of notional = $${FEE_USD.toFixed(4)} per ticket`);
for (const k of ["research LIVE-GATE", "market-anchored LIVE-GATE", "market-anchored TAPE-ONLY"]) {
  const m = results[k].m;
  console.log(`  ${k.padEnd(24)} EV $${m.evUsd.toFixed(5)}/trade   win $${m.avgWinUsd.toFixed(4)}  loss $${m.avgLossUsd.toFixed(4)}  BE-WR ${(m.be * 100).toFixed(1)}%  fee ${(m.feeShareOfGrossWin * 100).toFixed(1)}% of the gross win`);
}
