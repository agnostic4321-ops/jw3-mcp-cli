/**
 * WHY DOES THE ARM'S OWN SIMULATION DISAGREE WITH THE SHARED RESOLVER
 * ON THE SAME 181 ROWS?
 *
 * The live-gate publisher reported:
 *   the arm's own NET EV:            -0.2390% of equity
 *   the SHIPPED geometry in the sweep: +0.0892% of equity
 * on the same rows, with the same ticket, the same anchor and the same
 * 16-bar hold. One of them is wrong.
 *
 * This reproduces both paths side by side and finds the first
 * disagreement.
 */
import { readFileSync } from "node:fs";
import { resolveTicket } from "/Users/phoenix/Desktop/jw3_ai/packages/jw3-cli/research/ticket-fill.mjs";

const SCRATCH = "/Users/phoenix/.hermes/cache/scratch";
const BARS = JSON.parse(readFileSync(SCRATCH + "/fee-floor-15m-bars.json", "utf8"));
const rows = readFileSync(SCRATCH + "/confluence.ndjson", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const RHO = 60 / 56.7042;
const ROUND_TRIP = 0.0012;
const ATR_MULT_STOP = 0.9, ATR_CLAMP_LO = 0.6, ATR_CLAMP_HI = 1.5;
const TP_ATR_MULT = 0.4, TP_CLAMP_LO = 0.3, TP_CLAMP_HI = 0.5;
const BARS_BEFORE = 16;

function liveGateSide(r) {
  const j = r.jevSide, l = r.layaSide;
  if (!j || j === "flat" || r.jevUncertain === true) return null;
  if (!l || l === "flat") return null;
  if (j !== l) return null;
  return j;
}

function ticketFor(r) {
  const atrPct = r.tapeAtrPct;
  if (!(atrPct > 0)) return null;
  const d = Math.min(Math.max(ATR_MULT_STOP * atrPct, ATR_CLAMP_LO), ATR_CLAMP_HI);
  const tpPct = Math.min(Math.max(TP_ATR_MULT * atrPct, TP_CLAMP_LO), TP_CLAMP_HI);
  const last = r.price;
  if (!(last > 0)) return null;
  const avgEntry = r.dir === "short" ? last * (1 + d / 200) : last * (1 - d / 200);
  const stopFrac = (3 * d) / (200 + d);
  const tpFrac = tpPct / 100;
  const stopPrice = r.dir === "short" ? avgEntry * (1 + stopFrac) : avgEntry * (1 - stopFrac);
  const targetPrice = r.dir === "short" ? avgEntry * (1 - tpFrac) : avgEntry * (1 + tpFrac);
  return { atrPct, d, tpPct, stopFrac, tpFrac, avgEntry, last, stopPrice, targetPrice };
}

// THE ARM's own resolve — copied verbatim from live-gate-ev.mjs.
function armResolve(r, t) {
  const b = BARS[r.pair];
  if (!b) return null;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) return null;
  const end = Math.min(b.length, i + BARS_BEFORE);
  if (end - i < 2) return null;
  const long = r.dir === "long";
  const tpWrongSide = long ? t.targetPrice < t.last : t.targetPrice > t.last;
  for (let k = i; k < end; k++) {
    const bar = b[k];
    const hitTp = long ? bar.h >= t.targetPrice : bar.l <= t.targetPrice;
    const hitSl = long ? bar.l <= t.stopPrice : bar.h >= t.stopPrice;
    if (hitTp && hitSl) return { outcome: "loss", pnlPct: -t.stopFrac - ROUND_TRIP };
    if (hitTp) {
      if (tpWrongSide) return { outcome: "scratch", pnlPct: -ROUND_TRIP };
      return { outcome: "win", pnlPct: t.tpFrac - ROUND_TRIP };
    }
    if (hitSl) return { outcome: "loss", pnlPct: -t.stopFrac - ROUND_TRIP };
  }
  const lastBar = b[end - 1];
  const movePct = long ? (lastBar.c - t.avgEntry) / t.avgEntry : (t.avgEntry - lastBar.c) / t.avgEntry;
  return { outcome: "time", pnlPct: movePct - ROUND_TRIP };
}

const arm = [];
for (const r of rows) {
  if (!r.tapeSide) continue;
  const g = liveGateSide(r);
  if (!g) continue;
  if (g !== r.tapeSide) continue;
  const rr = { ...r, dir: g };
  const t = ticketFor(rr);
  if (!t) continue;
  const o = armResolve(rr, t);
  if (!o) continue;
  arm.push({ pair: r.pair, ts: r.ts, dir: g, ...o });
}

const ev = arm.map((a) => a.pnlPct * RHO * 100);
const m = ev.reduce((a, b) => a + b, 0) / ev.length;
const c = {};
arm.forEach((a) => (c[a.outcome] = (c[a.outcome] || 0) + 1));
console.log("  the ARM:             n=" + arm.length, JSON.stringify(c), "the mean EV=" + m.toFixed(4) + "% of equity");

// THE SHARED RESOLVER on the same rows and the same ticket.
const sw = [];
for (const r of rows) {
  if (!r.tapeSide) continue;
  const g = liveGateSide(r);
  if (!g) continue;
  if (g !== r.tapeSide) continue;
  const rr = { ...r, dir: g };
  const t = ticketFor(rr);
  if (!t) continue;
  const b = BARS[r.pair];
  if (!b) continue;
  const i = b.findIndex((x) => x.t > r.ts);
  if (i < 0) continue;
  const end = Math.min(b.length, i + 16);
  if (end - i < 2) continue;
  const o = resolveTicket(b, i, 16, rr.dir, {
    targetPrice: t.targetPrice,
    stopPrice: t.stopPrice,
    tpFrac: t.tpFrac,
    stopFrac: t.stopFrac,
    last: t.avgEntry,
    avgEntry: t.avgEntry,
  });
  if (!o) continue;
  sw.push({ pair: r.pair, ts: r.ts, dir: g, ...o });
}
const ev2 = sw.map((a) => a.pnlPct * RHO * 100);
const m2 = ev2.reduce((a, b) => a + b, 0) / ev2.length;
const c2 = {};
sw.forEach((a) => (c2[a.outcome] = (c2[a.outcome] || 0) + 1));
console.log("  the SHARED RESOLVER: n=" + sw.length, JSON.stringify(c2), "the mean EV=" + m2.toFixed(4) + "% of equity");

// THE FIRST DIFFERENCE.
let shown = 0;
for (let i = 0; i < Math.min(arm.length, sw.length); i++) {
  if (arm[i].outcome !== sw[i].outcome || Math.abs(arm[i].pnlPct - sw[i].pnlPct) > 1e-9) {
    const t = ticketFor({ ...rows.find((r) => r.ts === arm[i].ts), dir: arm[i].dir });
    console.log("  the first difference at row " + i + ":", arm[i].pair, arm[i].ts);
    console.log("     the arm:", arm[i].outcome, arm[i].pnlPct.toFixed(6), "| the resolver:", sw[i].outcome, sw[i].pnlPct.toFixed(6));
    if (t) {
      console.log("     the last:", t.last.toFixed(8), "the avgEntry:", t.avgEntry.toFixed(8));
      console.log("     the targetPrice:", t.targetPrice.toFixed(8), "the stopPrice:", t.stopPrice.toFixed(8));
      console.log("     the target is on the WRONG side of the market?", t.targetPrice > t.last ? "YES (short)" : "no");
    }
    shown++;
    if (shown >= 3) break;
  }
}
if (!shown) console.log("  NO DIFFERENCE in the per-trade outcomes — the difference is in the AGGREGATION");
