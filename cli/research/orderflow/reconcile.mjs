/**
 * THE RECONCILIATION — why the cited baseline says 11 trades / 11 wins
 * and this harness sees a different number.
 *
 * The cited baseline (live-gate-ev.json, generated 2026-10-21T13:06:45Z)
 * reported: 11 resolved, 11 wins, EV +0.3249% of equity, 9 clusters.
 *
 * The live-gate arm's rows at that moment: 18 (with 17 short, 1 long).
 * So 7 of the 18 could not resolve — the bar cache at 13:06Z ended at
 * 12:30Z, so a trade at 12:44 had only 4 forward 15m bars of the 16
 * the resolution needs, and the script requires at least 2 and ends
 * early.
 *
 * This script reproduces the cited run exactly, from the frozen inputs,
 * and then explains every difference.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH, loadBars, mean, fmt, bucketOf, RHO, ROUND_TRIP } from "./lib.mjs";

const rows = JSON.parse(readFileSync(join(SCRATCH, "oflow/conf-at-baseline.json"), "utf8"));
const bars = loadBars(join(SCRATCH, "oflow/bars-at-baseline.json"));

function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev || !laya || jev !== laya) return null;
  return jev;
}
function ticketFor(r, dir) {
  const atr = r.tapeAtrPct;
  if (!(atr > 0)) return null;
  const d = Math.min(Math.max(0.9 * atr, 0.6), 1.5);
  const tpPct = Math.min(Math.max(0.4 * atr, 0.3), 0.5);
  const last = r.price;
  if (!(last > 0)) return null;
  const avgEntry = dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  return {
    avgEntry, stopFrac, tpFrac, d, tpPct,
    targetPrice: dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac),
    stopPrice: dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac),
  };
}
function resolve(r, t) {
  const b = bars[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + 16);
  if (end - i < 2) return null;
  const long = r.dir === "long";
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= t.targetPrice : bar.l <= t.targetPrice;
    const hitSl = long ? bar.l <= t.stopPrice : bar.h >= t.stopPrice;
    if (hitTp && hitSl) return { o: "loss", p: -t.stopFrac - ROUND_TRIP };
    if (hitTp) return { o: "win", p: t.tpFrac - ROUND_TRIP };
    if (hitSl) return { o: "loss", p: -t.stopFrac - ROUND_TRIP };
  }
  const lb = b[end - 1];
  const mv = long ? (lb.c - t.avgEntry) / t.avgEntry : (t.avgEntry - lb.c) / t.avgEntry;
  return { o: "time", p: mv - ROUND_TRIP };
}

const arm = rows.filter((r) => {
  const t = r.tapeSide;
  if (!t) return false;
  const g = liveGate(r);
  return g && g === t;
}).map((r) => ({ ...r, dir: r.tapeSide }));

console.log(`[rec] conf rows ${rows.length} | live-gate arm ${arm.length}`);
const dist = {};
for (const r of arm) dist[r.dir] = (dist[r.dir] ?? 0) + 1;
console.log(`[rec] arm direction: ${JSON.stringify(dist)}`);

let w = 0, l = 0, tt = 0, ev = [], dropped = [];
for (const r of arm) {
  const tk = ticketFor(r, r.dir);
  if (!tk) { dropped.push([r, "no ticket"]); continue; }
  const o = resolve(r, tk);
  if (!o) {
    const b = bars[r.pair];
    const i = b.findIndex((x) => x.t > r.ts);
    dropped.push([r, `no forward bars (${b.length - i} available)`]);
    continue;
  }
  ev.push(o.p * RHO * 100);
  if (o.o === "win") w++; else if (o.o === "loss") l++; else tt++;
}
console.log(`[rec] resolved ${ev.length} | DROPPED ${dropped.length}`);
for (const [r, why] of dropped) console.log(`       dropped ${new Date(r.ts).toISOString()} ${r.pair} ${r.dir} — ${why}`);
console.log(`[rec] wins ${w} losses ${l} times ${tt} | win ${(w / Math.max(1, w + l) * 100).toFixed(1)}% | EV ${fmt(mean(ev))}% of equity`);
console.log(`[rec] CITED: 11 resolved, 11 wins, EV +0.3249% of equity, 9 clusters`);
console.log();
console.log("[rec] The arm's SYMBOLS:");
const bySym = new Map();
for (const r of arm) bySym.set(r.pair, (bySym.get(r.pair) ?? 0) + 1);
console.log(`       ${JSON.stringify([...bySym.entries()].sort((a, b) => b[1] - a[1]))}`);
