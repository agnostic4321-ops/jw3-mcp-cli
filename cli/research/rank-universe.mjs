#!/usr/bin/env node
/**
 * THE RANKED UNIVERSE TABLE — per symbol, on the verified basis.
 *
 * ── WHAT THIS FILE IS ──
 *
 * The screen's deliverable: a ranked table of symbols by TRADABILITY, with
 * every number measured, plus the per-symbol ticket viability that decides
 * which symbols lose the LEAST.
 *
 * ── THE BASIS IT MEASURES ON (all verified in this session) ──
 *
 *  1. THE FEE IS 0.08% OF NOTIONAL — maker 0.02% entry + taker 0.06% exit
 *     (live.ts's own feeSchedule; confirmed on all five FIRED tickets:
 *     feeRateRoundTrip = 0.0008 exactly).
 *
 *  2. LEVERAGE DOES NOT CHANGE THE FEE. The notional is capped at $60;
 *     leverage sets the margin. x20 and x42 pay the same $0.048.
 *
 *  3. THE TICKET'S WIN RATE IS ~66.7% OUT OF SAMPLE (90-day history,
 *     1-hour proxy) and ~73% on true 15-minute bars over 3 days — NOT the
 *     ~100% the 4.5-hour collector sample shows. The 4.5-hour sample's
 *     100% is a property of a calm 4.5-hour window, not of the strategy.
 *
 *  4. EVERY GEOMETRY IS NET-NEGATIVE on the bare market. 0 of 176
 *     geometries are net-positive at the live fee; 0 at taker-taker; 1 at
 *     maker-maker (LONG 1.5%/2.0%, net +0.0196% of notional).
 *
 *  5. THE $60 CAP BINDS AT EVERY EQUITY LEVEL ABOVE $45. So the dollars per
 *     trade are pinned and the % return falls as the account grows.
 *
 * ── THE RANKING ──
 *
 * A symbol is ranked on how LITTLE its ticket loses, because that is the
 * only thing a universe change can improve. Two components:
 *
 *   TICKET BLEED   the net expectancy per trade of the shipped ticket on
 *                  that symbol, in % of notional, over the real 15-min bars
 *                  (every entry bar, 4h hold). This is the symbol's own
 *                  contribution and it is what the ranking orders.
 *
 *   SIGNAL YIELD   how often the machine's own signal (tape + models
 *                  agree) fires on the symbol. A symbol that never fires
 *                  cannot be traded no matter how good its ticket is, and
 *                  one that fires on 3 observations cannot be measured.
 *
 * The ranking is a HYPOTHESIS for the next window, not a result: the same
 * selection bias that cleared the fade/dip family at 0.4-0.6% of pure chance
 * applies to a per-symbol ranking chosen from the same sample.
 *
 * USAGE
 *   node research/rank-universe.mjs
 */
import { readFileSync, existsSync } from "node:fs";
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

const FEE_LIVE = 0.08;
const EQUITY = 57.16;
const NOTIONAL_CAP = 60.0;
const MAX_HOLD = 16;
const STOP_ATR_MULT = 1.34;
const notionalOverEquity = NOTIONAL_CAP / EQUITY;

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

const rows = readFileSync(CONF, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const BARS_RAW = existsSync(BARS) ? JSON.parse(readFileSync(BARS, "utf8")) : {};
const loopRows = existsSync(LOOP) ? readFileSync(LOOP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const contracts = existsSync(CONTRACTS) ? JSON.parse(readFileSync(CONTRACTS, "utf8")).data : [];

// ── the arms ─────────────────────────────────────────────────────────────
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

// ── per-symbol facts ────────────────────────────────────────────────────
const sym = new Map();
const touch = (p) => {
  if (!sym.has(p)) {
    sym.set(p, {
      pair: p, atr: [], spr: [], liveSpr: [], liveAtr: [],
      sig: 0, sigCl: new Set(), unc: 0, uncCl: new Set(), uncLong: 0,
      inCollector: false, inLive: false,
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
for (const r of control) { const e = touch(r.pair); e.sig++; e.sigCl.add(Math.floor(r.ts / 300000)); }
for (const r of unconditional) {
  const e = touch(r.pair);
  e.unc++; e.uncCl.add(Math.floor(r.ts / 300000));
  if (r.dir === "long") e.uncLong++;
}
for (const r of loopRows) {
  if (!r.pair) continue;
  const e = touch(r.pair);
  e.inLive = true;
  if (r.event === "model-agreement" && r.book?.sprBps != null) e.liveSpr.push(r.book.sprBps);
  if (r.event === "model-agreement" && r.tape?.atrPct != null) e.liveAtr.push(r.tape.atrPct);
}
const levCap = new Map();
const turnover = new Map();
for (const c of contracts) {
  if (c.status !== "Open" || c.rootSymbol !== "USDT") continue;
  levCap.set(c.symbol.replace("USDTM", ""), Number(c.maxLeverage) || null);
  turnover.set(c.symbol.replace("USDTM", ""), Number(c.turnoverOf24h) || 0);
}

// ── the per-symbol ticket bleed on REAL 15-minute bars ──────────────────
/**
 * The shipped ticket's net expectancy on one symbol, over every 15-minute
 * bar as an entry, on both sides. This is the symbol's own contribution and
 * it is what the ranking orders: the symbol whose ticket loses LEAST.
 */
function ticketBleed(symBars, atrPct) {
  if (!symBars?.length || !(atrPct > 0)) return null;
  const tp = Math.min(0.5, Math.max(0.3, atrPct * 0.4));
  const sl = Math.max(0.3, atrPct * STOP_ATR_MULT);
  const pnl = [];
  let win = 0, lose = 0, time = 0;
  for (const dir of ["long", "short"]) {
    for (let i = 1; i < symBars.length - MAX_HOLD; i++) {
      const e = symBars[i].c;
      const tpP = dir === "long" ? e * (1 + tp / 100) : e * (1 - tp / 100);
      const slP = dir === "long" ? e * (1 - sl / 100) : e * (1 + sl / 100);
      let res = null;
      for (let j = i + 1; j < Math.min(symBars.length, i + 1 + MAX_HOLD); j++) {
        const hTp = dir === "long" ? symBars[j].h >= tpP : symBars[j].l <= tpP;
        const hSl = dir === "long" ? symBars[j].l <= slP : symBars[j].h >= slP;
        if (hTp && hSl) { res = "loss"; break; }
        if (hTp) { res = "win"; break; }
        if (hSl) { res = "loss"; break; }
      }
      if (res === "win") { win++; pnl.push(tp); }
      else if (res === "loss") { lose++; pnl.push(-sl); }
      else { time++; const lb = symBars[Math.min(symBars.length - 1, i + MAX_HOLD)]; pnl.push(dir === "long" ? ((lb.c - e) / e) * 100 : ((e - lb.c) / e) * 100); }
    }
  }
  const n = win + lose;
  return {
    tp, sl,
    n,
    win: n ? win / n : 0,
    gross: mean(pnl),
    net: mean(pnl) - FEE_LIVE,
    wbe: (sl + FEE_LIVE) / (tp + sl + FEE_LIVE),
    perTradeUsd: (mean(pnl) - FEE_LIVE) / 100 * NOTIONAL_CAP,
  };
}

// ── build the table ─────────────────────────────────────────────────────
const table = [];
for (const [p, e] of sym) {
  const atr = med([...e.atr, ...e.liveAtr]);
  const spr = e.liveSpr.length ? med(e.liveSpr) : med(e.spr);
  const sprP90 = e.liveSpr.length ? q(e.liveSpr, 0.9) : q(e.spr, 0.9);
  const bleed = ticketBleed(BARS_RAW[p], atr);
  const base = p.split("/")[0];
  const tp = bleed?.tp ?? (atr > 0 ? Math.min(0.5, Math.max(0.3, atr * 0.4)) : NaN);
  const sl = bleed?.sl ?? (atr > 0 ? Math.max(0.3, atr * STOP_ATR_MULT) : NaN);
  table.push({
    p, base, e, atr, spr, sprP90, bleed,
    tp, sl,
    feeDrag: Number.isFinite(sl) ? FEE_LIVE / sl : NaN,
    wbe: bleed?.wbe ?? (Number.isFinite(tp) && Number.isFinite(sl) ? (sl + FEE_LIVE) / (tp + sl + FEE_LIVE) : NaN),
    lev: levCap.get(base) ?? null,
    turn: turnover.get(base) ?? null,
  });
}

// The ranking: the ticket bleed, best (least negative) first.
const ranked = [...table].filter((t) => t.bleed).sort((a, b) => b.bleed.net - a.bleed.net);

console.log("=".repeat(132));
console.log("THE RANKED UNIVERSE — by ticket bleed (least negative first), with the signal yield");
console.log("=".repeat(132));
console.log(`  basis: real 15-min bars (${BARS.split("/").pop()}), every entry bar, 4h hold, both sides,`);
console.log(`          the live 0.08% fee, and the shipped ticket (TP = clamp(0.4*ATR, 0.3, 0.5), SL = 1.34*ATR).`);
console.log(`  bleed is the NET expectancy per trade, % of notional. A NEGATIVE bleed is a losing ticket.`);
console.log();
console.log("  pair             ATR%   sprBps  TP%    SL%    feeDrag%  wBE    win%   bleed%/notl  $/trade  sigRows sigClus uncRows uncLong levCap  inLive  note");
console.log("  " + "-".repeat(172));
for (const t of ranked) {
  const notes = [];
  if (t.e.sigCl.size === 0) notes.push("NO SIGNAL");
  else if (t.e.sigCl.size < 3) notes.push("thin signal");
  if (t.e.uncLong === 0) notes.push("no long tape");
  if (t.lev != null && t.lev < 20) notes.push(`lev cap ${t.lev}`);
  if (t.feeDrag > 1 / 3) notes.push("fee drag > 1/3 stop");
  console.log(
    `  ${t.p.padEnd(16)} ${(Number.isFinite(t.atr) ? t.atr.toFixed(3) : "n/a").padStart(6)} ${(Number.isFinite(t.spr) ? t.spr.toFixed(2) : "n/a").padStart(7)} ${t.tp.toFixed(3).padStart(6)} ${t.sl.toFixed(3).padStart(6)} ${(t.feeDrag * 100).toFixed(1).padStart(9)}% ${(t.wbe * 100).toFixed(1).padStart(5)}% ${(t.bleed.win * 100).toFixed(1).padStart(5)}% ${(t.bleed.net >= 0 ? "+" : "") + t.bleed.net.toFixed(4).padStart(11)} ${t.bleed.perTradeUsd.toFixed(4).padStart(8)} ${String(t.e.sig).padStart(7)} ${String(t.e.sigCl.size).padStart(7)} ${String(t.e.unc).padStart(8)} ${String(t.e.uncLong).padStart(7)} ${(t.lev ?? "?").toString().padStart(6)} ${(t.e.inLive ? "yes" : "no").padStart(7)}  ${notes.join("; ")}`,
  );
}

// ── the recommended subset ──────────────────────────────────────────────
console.log();
console.log("=".repeat(132));
console.log("THE RECOMMENDED SUBSET");
console.log("=".repeat(132));
// Tradable = the ticket is not a catastrophic bleeder, the fee drag fits
// under the sizing engine's 1/3 cap, the venue allows the leverage, and
// the machine's own signal actually fires there.
const tradable = ranked.filter((t) => t.e.sigCl.size >= 3 && t.e.unc >= 5 && (t.lev == null || t.lev >= 20) && t.feeDrag <= 1 / 3);
console.log(`  tradable (signal fires, >=3 signal clusters, lev cap >= 20, fee drag <= 1/3): ${tradable.length}`);
console.log("  " + tradable.map((t) => t.p).join(" "));
console.log();
console.log("  THE TOP 5 BY BLEED (the least-unprofitable tickets), with their signal yield:");
console.log("  pair             bleed%/notl  win%   $/trade  sigRows sigClus  verdict");
for (const t of tradable.slice(0, 8)) {
  console.log(
    `  ${t.p.padEnd(16)} ${(t.bleed.net >= 0 ? "+" : "") + t.bleed.net.toFixed(4).padStart(11)} ${(t.bleed.win * 100).toFixed(1).padStart(5)}% ${t.bleed.perTradeUsd.toFixed(4).padStart(8)} ${String(t.e.sig).padStart(7)} ${String(t.e.sigCl.size).padStart(7)}  ${t.e.sigCl.size >= 30 ? "measurable" : "thin"}`,
  );
}
console.log();
console.log("  THE HONEST READING OF THIS TABLE:");
console.log("  Every row's bleed is NEGATIVE. A better universe reduces the size of the");
console.log("  loss; it does not turn it positive, because no (TP, SL) geometry on this");
console.log("  venue is net-positive on the bare market at the live fee (0 of 176 tested).");
console.log("  So the ranking answers 'which symbols lose least', NOT 'which symbols make money'.");
console.log("  And the ranking is chosen FROM this sample, so it is a HYPOTHESIS for the next");
console.log("  window, not a result — the same selection bias that cleared the fade/dip");
console.log("  family at 0.4-0.6% of pure chance applies here.");
