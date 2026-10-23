/**
 * THE DEGENERACY AUDIT — is the 98% win rate a real edge, or an
 * artefact of the ticket geometry and the bar resolution?
 *
 * THE SUSPICION
 *   Every arm measured on the deep dataset showed a 94-99% win rate
 *   and a positive net EV. That is far above the 82.8% break-even the
 *   project computed for the live ticket. A win rate that high, on a
 *   market where 29 of 38 symbols FELL over the window, is not a
 *   signal. It is a geometric artefact.
 *
 * THE TWO CANDIDATE ARTEFACTS
 *   1. THE TP ANCHOR. The research script (live-gate-ev.mjs) anchors the
 *      take-profit on `avgEntry`, which for a short sits ABOVE the
 *      market. So the TP is only ~0.17% BELOW the market price for a
 *      short, and ~0.17% ABOVE it for a long. The first forward bar
 *      therefore touches the TP almost every time, whatever the market
 *      does. The trade wins on a NOISE MOVE.
 *   2. THE 5-MINUTE BAR. A 5-minute bar's high/low captures the whole
 *      bar's range, including transient wicks that a market order
 *      would not have filled at.
 *
 * WHAT THIS SCRIPT MEASURES
 *   (a) the distribution of the TP's distance from the market price,
 *       for the research ticket and for the LIVE PATH's real ticket;
 *   (b) the bar-index at which each trade resolves — a ticket that
 *       resolves on bar 0 is a ticket whose target is inside the
 *       noise;
 *   (c) the win rate when the TP is scaled to a REAL distance (a
 *       target that is NOT inside the first bar's range).
 *
 * READ-ONLY. Local files only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH, loadBars, mean, fmt } from "./lib.mjs";

const tf5 = loadBars(join(SCRATCH, "oflow/binance-tf-bars5m.json"));
const tapeRows = [];
{
  const txt = readFileSync(join(SCRATCH, "rep-binance-obs.json"), "utf8").trim();
  for (const line of txt.split("\n")) {
    if (!line) continue;
    try { tapeRows.push(JSON.parse(line)); } catch { /* skip */ }
  }
}
console.log(`[deg] tape rows ${tapeRows.length}`);

// ── the 5m bar index ──
const bm = new Map();
for (const [s, b] of Object.entries(tf5)) {
  const m = new Map();
  for (const x of b) m.set(x.t, x);
  bm.set(s, m);
}

/** The research script's ticket (live-gate-ev.mjs). */
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
    tpPct, stopFrac, d,
  };
}

/** The LIVE PATH's real ticket: planScalp(last, atr, dir, size, 2). */
function liveTicket(atr, price, dir) {
  const a = atr > 0 ? atr : 0.8;
  const tpPct = Math.min(0.5, Math.max(0.3, a * 0.4));
  const stepDropPct = Math.min(1.5, Math.max(0.6, a * 0.9));
  const steps = 2;
  const dirSign = dir === "long" ? -1 : 1;
  const avgEntry = (price + price * (1 + (dirSign * stepDropPct) / 100)) / 2;
  const tpDir = dir === "long" ? 1 : -1;
  return {
    avgEntry,
    targetPrice: avgEntry * (1 + (tpDir * tpPct) / 100),
    stopPrice: price * (1 + (dirSign * (steps * stepDropPct)) / 100),
    tpPct, stepDropPct,
  };
}

// ══ (a) THE TP DISTANCE FROM THE MARKET PRICE ══
console.log("\n══════════════════════════════════════════════════════════════");
console.log(" (a) HOW FAR IS THE TAKE-PROFIT FROM THE MARKET PRICE?");
console.log("     (the distance the market must move for the ticket to win)");
console.log("══════════════════════════════════════════════════════════════");
console.log("  ticket    dir   n     median dist%   p10     p90   |  within 0.1% of price?");
for (const [name, fn] of [["research", researchTicket], ["LIVE PATH", liveTicket]]) {
  for (const dir of ["long", "short"]) {
    const dists = [];
    for (const r of tapeRows) {
      if (!(r.tapeAtrPct > 0) || !(r.price > 0)) continue;
      const t = fn(r.tapeAtrPct, r.price, dir);
      // the distance the market must move, signed so that POSITIVE is
      // "in the trade's favour"
      const d = dir === "short" ? (r.price - t.targetPrice) / r.price : (t.targetPrice - r.price) / r.price;
      dists.push(d * 100);
    }
    dists.sort((a, b) => a - b);
    const med = dists[Math.floor(dists.length / 2)];
    const p10 = dists[Math.floor(dists.length * 0.1)];
    const p90 = dists[Math.floor(dists.length * 0.9)];
    const within = dists.filter((d) => Math.abs(d) < 0.1).length / dists.length;
    console.log(`  ${name.padEnd(9)} ${dir.padEnd(5)} ${String(dists.length).padStart(6)}   ${med.toFixed(4).padStart(8)}  ${p10.toFixed(3).padStart(7)} ${p90.toFixed(3).padStart(7)}   |  ${(within * 100).toFixed(1)}%`);
  }
}

// ══ (b) THE BAR AT WHICH THE TRADE RESOLVES ══
console.log("\n══════════════════════════════════════════════════════════════");
console.log(" (b) AT WHICH BAR DOES THE TRADE RESOLVE?");
console.log("     (bar 0 = the FIRST forward bar — the target was inside the noise)");
console.log("══════════════════════════════════════════════════════════════");

function resolveStats(fn, dir, scale = 1) {
  const hist = new Map();
  let wins = 0, losses = 0, times = 0;
  for (const r of tapeRows) {
    if (!(r.tapeAtrPct > 0) || !(r.price > 0)) continue;
    const base = r.pair.split("/")[0];
    const m = bm.get(base);
    if (!m) continue;
    const t = fn(r.tapeAtrPct, r.price, dir);
    // SCALE the TP distance: scale>1 pushes the target FURTHER away
    const target = dir === "short"
      ? t.targetPrice - (t.targetPrice - r.price) * (scale - 1)
      : t.targetPrice + (r.price - t.targetPrice) * (scale - 1);
    const stop = t.stopPrice;
    const start = Math.floor(r.ts / 300000) * 300000 + 300000;
    let done = false;
    for (let k = 0; k < 48; k++) {
      const bar = m.get(start + k * 300000);
      if (!bar) break;
      const hitTp = dir === "long" ? bar.h >= target : bar.l <= target;
      const hitSl = dir === "long" ? bar.l <= stop : bar.h >= stop;
      if (hitTp && hitSl) { losses++; hist.set(k, (hist.get(k) ?? 0) + 1); done = true; break; }
      if (hitTp) { wins++; hist.set(k, (hist.get(k) ?? 0) + 1); done = true; break; }
      if (hitSl) { losses++; hist.set(k, (hist.get(k) ?? 0) + 1); done = true; break; }
    }
    if (!done) times++;
  }
  const decided = wins + losses;
  return {
    wins, losses, times,
    winRate: decided ? wins / decided : 0,
    firstBar: hist.get(0) ?? 0,
    hist,
  };
}

for (const [name, fn] of [["research", researchTicket], ["LIVE PATH", liveTicket]]) {
  for (const dir of ["long", "short"]) {
    const s = resolveStats(fn, dir);
    const tot = s.wins + s.losses;
    console.log(`  ${name.padEnd(9)} ${dir.padEnd(5)} wins ${String(s.wins).padStart(6)} losses ${String(s.losses).padStart(6)} time ${String(s.times).padStart(5)} | win rate ${(s.winRate * 100).toFixed(2)}% | resolved on bar 0: ${s.firstBar} (${(s.firstBar / Math.max(1, tot) * 100).toFixed(1)}%)`);
  }
}

// ══ (c) THE SAME TICKET WITH THE TARGET PUSHED FURTHER AWAY ══
console.log("\n══════════════════════════════════════════════════════════════");
console.log(" (c) THE TARGET PUSHED FURTHER FROM THE PRICE (scale the TP distance)");
console.log("     scale=1 is the shipped ticket; scale=3 puts the target 3x further out");
console.log("══════════════════════════════════════════════════════════════");
console.log("  scale  dir   wins  losses  time   win rate   win$    loss$   EV$    BE-WR");
for (const scale of [1, 2, 3, 5]) {
  for (const dir of ["long", "short"]) {
    const s = resolveStats(researchTicket, dir, scale);
    const decided = s.wins + s.losses;
    if (!decided) continue;
    // the P&L: a win is the tp distance, a loss the stop distance
    const r0 = tapeRows.find((r) => r.tapeAtrPct > 0);
    const t = researchTicket(r0.tapeAtrPct, r0.price, dir);
    const tpFrac = Math.abs((t.targetPrice - t.avgEntry) / t.avgEntry);
    const slFrac = Math.abs((t.stopPrice - t.avgEntry) / t.avgEntry);
    const ROUND_TRIP = 0.0012, NOTIONAL = 60;
    const winUsd = (tpFrac - ROUND_TRIP) * NOTIONAL;
    const lossUsd = (-slFrac - ROUND_TRIP) * NOTIONAL;
    const ev = (s.winRate * winUsd + (1 - s.winRate) * lossUsd);
    const be = -lossUsd / (winUsd - lossUsd);
    console.log(`  ${String(scale).padEnd(6)} ${dir.padEnd(5)} ${String(s.wins).padStart(6)} ${String(s.losses).padStart(6)} ${String(s.times).padStart(6)}   ${(s.winRate * 100).toFixed(2).padStart(7)}%  ${winUsd.toFixed(4).padStart(7)} ${lossUsd.toFixed(4).padStart(7)} ${ev.toFixed(4).padStart(7)}  ${(be * 100).toFixed(1)}%`);
  }
}
