#!/usr/bin/env node
/**
 * THE DECISIVE TEST — does the confirmation layer's excess survive a
 * longer sample, a corrected cluster, and a per-symbol check?
 *
 * ══ THE ARMS ══
 *
 *   LIVE-GATE   both models present, agreeing, neither uncertain, and the
 *               tape agreeing with them. THIS IS WHAT THE MACHINE TRADES.
 *   LOOSE       one model leg is enough (the study's rule:
 *               (jev && laya) ? (jev === laya ? jev : null) : (jev || laya))
 *               and the tape agreeing. The replicable arm: the Laya leg
 *               is a deterministic rule bridge, so this can be rebuilt on
 *               an independent venue.
 *   TAPE-ONLY   the control: every tape signal, no model filter.
 *   REJECTED    the DISJOINT control: the tape signals the models did
 *               NOT confirm. The excess over THIS is the confirmation
 *               layer's contribution with no overlapping-sample problem.
 *
 * ══ THE ESTIMATOR ══
 *
 * PAIRED BY ROUND. The cluster is the ROUND — the collector reads 43
 * symbols sequentially, so a round is 43 rows spanning 3-5 minutes that
 * all share one market state. A row is not an observation. The paired
 * difference per round is (signal arm's round mean) - (control arm's
 * round mean), over rounds where both arms traded. The market's own
 * drift in that round cancels, because both arms were traded in it.
 *
 * ══ THE TICKET ══
 *
 * The live path's own geometry and the live path's own fee. First-touch
 * TP/kill at 15-minute granularity, a bar touching BOTH levels is a LOSS,
 * and an explicit 240-minute TIME EXIT books the trade at its mark.
 *
 * READ-ONLY. No venue calls, no account calls.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mean, se, tPval, tCrit, roundAssign, simulate, armStats, pairedExcess, roundMeans,
} from "./core.mjs";
import { leaveOneSymbolOut, crossSectional } from "./per-symbol.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const OUT = join(SCRATCH, "decisive");

const EQUITY = 57.1579522047;
const NOTIONAL = 60.0;
const RHO = NOTIONAL / EQUITY;
const TAKER_RT_PCT = 0.12; // % of notional, both legs

const fmt = (x, d = 4) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
/** thousands-separated integer, so a 6-digit count does not run into its neighbour */
const int = (n) => Number(n).toLocaleString("en-US");

// ── the tape's side, from the shared module's logic (verbatim thresholds) ──
function tapeSideOfRow(r) {
  if (r.tapeSide) return r.tapeSide;
  const oh = Number(r.tapeOffHighPct ?? 0);
  const ol = Number(r.tapeOffLowPct ?? 0);
  const v = Number(r.tapeVratio ?? 1);
  if (oh > 15) return null;
  if (v < 0.85 && oh < 8) return "short";
  if (v > 3) return null;
  if (ol > 15) return null;
  if (v > 3) return null;
  if (v < 0.85 && ol < 8) return "long";
  return null;
}

/** the LIVE GATE, exactly as live-cmd.ts implements it */
function liveGate(r) {
  const jev = r.jevSide && r.jevSide !== "flat" && r.jevUncertain !== true ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  if (!jev) return null;
  if (!laya) return null;
  if (jev !== laya) return null;
  return jev;
}

/** the LOOSE arm — the study's rule: one model leg is enough */
function looseArm(r) {
  const jev = r.jevSide && r.jevSide !== "flat" ? r.jevSide : null;
  const laya = r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
  return jev && laya ? (jev === laya ? jev : null) : (jev || laya);
}

/** the LAYA-ONLY arm — the deterministic bridge, replicable anywhere */
function layaOnly(r) {
  return r.layaSide && r.layaSide !== "flat" ? r.layaSide : null;
}

// ══════════════════════════════════════════════════════════════════════
const which = process.argv[2] ?? "ku";
console.log("=".repeat(118));
if (which === "ku") {
  console.log("RUN A — THE MACHINE'S OWN ARM ON THE COLLECTOR'S OWN SAMPLE (KuCoin, the venue the machine trades)");
} else {
  console.log("RUN B — THE DEEP SAMPLE: 90 DAYS on an independent venue, tape rebuilt from that venue's own bars");
}
console.log("=".repeat(118));

let rows, bars, label, feePct, tsKey;
const DEEP_ROUNDS = which !== "ku";

if (which === "ku") {
  // The PINNED snapshot and the PINNED bar cache. The live files are
  // being written by the running machine, so a run against them is not
  // reproducible — and a result that changes when the collector appends
  // a row is not a result.
  const snap = join(OUT, "collector-snapshot-full.ndjson");
  rows = readFileSync(snap, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  bars = JSON.parse(readFileSync(join(OUT, "kucoin-15m-bars.pinned.json"), "utf8"));
  label = "KUCOIN collector (the machine's own sample), pinned snapshot";
  feePct = TAKER_RT_PCT;
} else {
  // The deep sample: the tape is REBUILT from Binance's own 1h bars.
  const deep = JSON.parse(readFileSync(join(OUT, "deep-observations.json"), "utf8"));
  rows = deep.rows;
  bars = JSON.parse(readFileSync(join(OUT, "binance-90d-15m.json"), "utf8"));
  label = "BINANCE 90d (tape rebuilt from Binance's own 1h bars)";
  feePct = 0.10; // Binance USDⓈ-M VIP-0 taker: 0.05% per side
}

// the round key
//
// On the COLLECTOR's sample a round is a maximal run of consecutive rows
// whose inter-row gap is <= 60s: the collector reads 43 symbols
// sequentially, so a round is 43 rows spanning 3-5 minutes that all share
// one market state.
//
// On the DEEP sample the observations are on the collector's own 5-minute
// grid, so a round IS the 5-minute bucket — every symbol's read in that
// bucket shares one market state. The bucket is the round.
//
// The bucket is ALSO the right unit for the TAPE, which is computed from
// 1-hour bars: the tape can only change once an hour, so five reads of
// the same symbol inside one hour are the SAME observation repeated.
const roundOf = roundAssign(rows);
const rowKey = (r) => `${r.pair}|${r.ts}`;
const roundIdx = new Map();
rows.forEach((r, i) => {
  roundIdx.set(rowKey(r), DEEP_ROUNDS ? Math.floor(r.ts / 300_000) : roundOf.get(i));
});

// Math.min(...arr) overflows the call stack on a large array, so the
// extent is computed with a loop.
let tsLo = rows[0].ts, tsHi = rows[0].ts;
for (const r of rows) { if (r.ts < tsLo) tsLo = r.ts; if (r.ts > tsHi) tsHi = r.ts; }
const spanH = (tsHi - tsLo) / 3_600_000;
console.log(`\n  sample: ${label}`);
console.log(`  rows ${rows.length} | rounds ${new Set(roundIdx.values()).size} | symbols ${new Set(rows.map((r) => r.pair)).size}`);
console.log(`  span ${new Date(tsLo).toISOString()} -> ${new Date(tsHi).toISOString()}  (${spanH.toFixed(2)} h)`);
console.log(`  fee: ${feePct}% of notional round trip = ${(feePct / 100 * RHO * 100).toFixed(4)}% of equity per trade`);

// ══ the arms ══
const tapeArm = [], liveArm = [], looseArmRows = [], layaArm = [];
const liveKeys = new Set();
for (const r of rows) {
  const t = tapeSideOfRow(r);
  if (!t) continue;
  tapeArm.push({ ...r, dir: t });
  const g = liveGate(r);
  if (g && g === t) { liveArm.push({ ...r, dir: g }); liveKeys.add(rowKey(r)); }
  const l = looseArm(r);
  if (l && l === t) looseArmRows.push({ ...r, dir: l });
  const ly = layaOnly(r);
  if (ly && ly === t) layaArm.push({ ...r, dir: ly });
}
// On the DEEP sample there is no JEV leg (it is an LLM and cannot be
// backfilled), so the confirmation arm is the LAYA bridge alone. The
// LOOSE arm on the deep sample is therefore IDENTICAL to the LAYA arm,
// and only ONE confirmation arm is measured.
const DEEP = which !== "ku";
if (DEEP) {
  looseArmRows.length = 0;
  for (const r of layaArm) looseArmRows.push(r);
}

// The DISJOINT control: the tape signals the confirmation layer did NOT
// take. On the collector's sample that is the LIVE-GATE complement; on
// the deep sample it is the LAYA complement.
const ctlKeys = new Set((DEEP ? layaArm : liveArm).map(rowKey));
const rejectedArm = tapeArm.filter((r) => !ctlKeys.has(rowKey(r)));

console.log(`\n  arms: TAPE-ONLY ${tapeArm.length} | LIVE-GATE ${liveArm.length} | LOOSE ${looseArmRows.length} | LAYA-ONLY ${layaArm.length} | REJECTED ${rejectedArm.length}`);

// ══ simulate each arm ══
const S = {
  tape: simulate(tapeArm, bars, roundIdx, rowKey),
  live: simulate(liveArm, bars, roundIdx, rowKey),
  loose: simulate(looseArmRows, bars, roundIdx, rowKey),
  laya: simulate(layaArm, bars, roundIdx, rowKey),
  rejected: simulate(rejectedArm, bars, roundIdx, rowKey),
};
const A = {
  tape: armStats(S.tape), live: armStats(S.live), loose: armStats(S.loose),
  laya: armStats(S.laya), rejected: armStats(S.rejected),
};

console.log(`\n  ${"arm".padEnd(14)}${"n".padStart(9)}${"wins".padStart(8)}${"loss".padStart(8)}${"time".padStart(8)}${"amb".padStart(5)}${"unres".padStart(8)}${"win%".padStart(8)}${"rounds".padStart(9)}${"EV %eq".padStart(12)}${"EV se".padStart(10)}`);
for (const [k, lab] of [["tape", "TAPE-ONLY"], ["live", "LIVE-GATE"], ["loose", "LOOSE"], ["laya", "LAYA-ONLY"], ["rejected", "REJECTED"]]) {
  const a = A[k];
  if (!a.n) continue;
  console.log(`  ${pad(lab, 14)}${rpad(int(a.n), 9)}${rpad(int(a.wins), 8)}${rpad(int(a.losses), 8)}${rpad(int(a.times), 8)}${rpad(int(a.ambiguous), 5)}${rpad(int(a.unresolved), 8)}${rpad((a.winRate * 100).toFixed(1), 8)}${rpad(int(a.rounds), 9)}${rpad(fmt(a.ev), 12)}${rpad(fmt(a.evSe), 10)}`);
}

// ══ THE EXCESS: paired by round ══
console.log(`\n${"=".repeat(118)}`);
console.log("  THE EXCESS OF THE CONFIRMATION LAYER — PAIRED BY ROUND");
console.log("  (the signal arm's round mean minus the control arm's round mean, over rounds where BOTH traded)");
console.log("=".repeat(118));
console.log(`\n  ${"comparison".padEnd(34)}${"rounds".padStart(8)}${"excess %eq".padStart(12)}${"se".padStart(10)}${"t".padStart(8)}${"p".padStart(10)}${"|t|crit5%".padStart(11)}   verdict`);

const EX = {};
function reportExcess(key, sigTrades, ctlTrades, lab) {
  const e = pairedExcess(sigTrades, ctlTrades);
  EX[key] = e;
  const verdict = e.t >= 2 ? "SIGNIFICANT" : e.t <= -2 ? "SIGNIFICANTLY NEGATIVE" : "a PATTERN, not a finding";
  console.log(`  ${pad(lab, 34)}${rpad(e.rounds, 8)}${rpad(fmt(e.excess), 12)}${rpad(fmt(e.se), 10)}${rpad(fmt(e.t, 2), 8)}${rpad(e.p.toFixed(4), 10)}${rpad(e.crit05.toFixed(2), 11)}   ${verdict}`);
  return e;
}

reportExcess("live_vs_tape", S.live.trades, S.tape.trades, "LIVE-GATE  vs TAPE-ONLY");
reportExcess("live_vs_rejected", S.live.trades, S.rejected.trades, "LIVE-GATE  vs REJECTED (disjoint)");
if (!DEEP) {
  reportExcess("loose_vs_tape", S.loose.trades, S.tape.trades, "LOOSE      vs TAPE-ONLY");
  reportExcess("loose_vs_rejected", S.loose.trades, S.rejected.trades, "LOOSE      vs REJECTED (disjoint)");
}
reportExcess("laya_vs_tape", S.laya.trades, S.tape.trades, "LAYA-ONLY  vs TAPE-ONLY");
reportExcess("laya_vs_rejected", S.laya.trades, S.rejected.trades, "LAYA-ONLY  vs REJECTED (disjoint)");

// ══ WINDOW STABILITY: the halves and the thirds ══
console.log(`\n${"=".repeat(118)}`);
console.log("  WINDOW STABILITY — the excess in each chronological half and third of the rounds");
console.log("=".repeat(118));

function windowSplit(sigTrades, ctlTrades, label, nParts) {
  const rounds = [...new Set([...roundMeans(sigTrades), ...roundMeans(ctlTrades)].map((c) => c.round))].sort((a, b) => a - b);
  const per = Math.ceil(rounds.length / nParts);
  console.log(`\n  ${label}`);
  console.log(`  ${"part".padEnd(10)}${"rounds".padStart(8)}${"paired".padStart(9)}${"excess %eq".padStart(12)}${"t".padStart(8)}${"p".padStart(10)}`);
  for (let i = 0; i < nParts; i++) {
    const lo = rounds[i * per], hi = rounds[Math.min(rounds.length, (i + 1) * per) - 1];
    const s = sigTrades.filter((t) => t.round >= lo && t.round <= hi);
    const c = ctlTrades.filter((t) => t.round >= lo && t.round <= hi);
    const e = pairedExcess(s, c);
    console.log(`  ${pad(`part ${i + 1}`, 10)}${rpad(hi - lo + 1, 8)}${rpad(e.rounds, 9)}${rpad(fmt(e.excess), 12)}${rpad(fmt(e.t, 2), 8)}${rpad(e.p.toFixed(4), 10)}`);
  }
}

windowSplit(S.live.trades, S.tape.trades, "LIVE-GATE vs TAPE-ONLY, by half", 2);
windowSplit(S.live.trades, S.tape.trades, "LIVE-GATE vs TAPE-ONLY, by third", 3);
if (!DEEP) {
  windowSplit(S.loose.trades, S.tape.trades, "LOOSE vs TAPE-ONLY, by half", 2);
  windowSplit(S.loose.trades, S.tape.trades, "LOOSE vs TAPE-ONLY, by third", 3);
}
windowSplit(S.laya.trades, S.tape.trades, "LAYA-ONLY vs TAPE-ONLY, by half", 2);
windowSplit(S.laya.trades, S.tape.trades, "LAYA-ONLY vs TAPE-ONLY, by third", 3);

// ══ PER-SYMBOL ══
/**
 * PER-SYMBOL — which symbols carry the excess?
 *
 * The TAPE-ONLY control CONTAINS the signal arm (every confirmed signal is
 * also a tape signal), so the naive paired difference against it is
 * identically zero within a symbol — a degenerate statistic, not a
 * finding. The DISJOINT design (the symbol's CONFIRMED trades vs the
 * symbol's REJECTED trades, paired by round) is the one that carries
 * information, so that is what is reported.
 */
console.log(`\n${"=".repeat(118)}`);
console.log("  PER-SYMBOL — which symbols carry the excess?");
console.log("  (LEAVE-ONE-SYMBOL-OUT on the arm-level paired-by-round excess)");
console.log("=".repeat(118));
const loso = {};
if (DEEP) {
  // On the deep sample there is no JEV leg, so the only confirmation arm
  // is the Laya bridge. The LIVE-GATE arm is empty and is not reported.
  loso.laya = leaveOneSymbolOut(S.laya.trades, S.tape.trades, pairedExcess, "LAYA-ONLY vs TAPE-ONLY");
  loso.layaRej = leaveOneSymbolOut(S.laya.trades, S.rejected.trades, pairedExcess, "LAYA-ONLY vs REJECTED (disjoint)");
} else {
  loso.live = leaveOneSymbolOut(S.live.trades, S.tape.trades, pairedExcess, "LIVE-GATE vs TAPE-ONLY");
  loso.laya = leaveOneSymbolOut(S.laya.trades, S.tape.trades, pairedExcess, "LAYA-ONLY vs TAPE-ONLY");
  loso.loose = leaveOneSymbolOut(S.loose.trades, S.tape.trades, pairedExcess, "LOOSE vs TAPE-ONLY");
  loso.liveRej = leaveOneSymbolOut(S.live.trades, S.rejected.trades, pairedExcess, "LIVE-GATE vs REJECTED (disjoint)");
}

console.log(`\n${"=".repeat(118)}`);
console.log("  THE CROSS-SECTIONAL STRUCTURE — does the excess live where the layer confirmed MANY or FEW symbols?");
console.log("=".repeat(118));
crossSectional(S.live.trades, S.tape.trades, pairedExcess, "LIVE-GATE vs TAPE-ONLY");
crossSectional(S.laya.trades, S.tape.trades, pairedExcess, "LAYA-ONLY vs TAPE-ONLY");

/**
 * THE DAY-BY-DAY STABILITY TEST — the strongest window-artefact detector.
 *
 * A real effect is in most days. An effect carried by two or three days
 * out of ninety is a market event, not a signal. So the excess is
 * measured on each DAY separately, and the question is: in how many of
 * them is it positive? In how many is it significantly positive? In how
 * many is it significantly NEGATIVE?
 */
function dayStability(sigTrades, ctlTrades, label) {
  const DAY = 86_400_000;
  const dayOf = (t) => Math.floor(t / DAY);
  const sigDays = new Map(), ctlDays = new Map();
  for (const t of sigTrades) {
    const d = dayOf(t.ts); const a = sigDays.get(d) ?? []; a.push(t); sigDays.set(d, a);
  }
  for (const t of ctlTrades) {
    const d = dayOf(t.ts); const a = ctlDays.get(d) ?? []; a.push(t); ctlDays.set(d, a);
  }
  const days = [...new Set([...sigDays.keys(), ...ctlDays.keys()])].sort();
  const per = [];
  for (const d of days) {
    const e = pairedExcess(sigDays.get(d) ?? [], ctlDays.get(d) ?? []);
    if (e.rounds < 2) continue;
    per.push({ d, ...e });
  }
  if (!per.length) { console.log(`\n  ${label}: no day with 2+ paired rounds`); return null; }
  const pos = per.filter((x) => x.excess > 0).length;
  const sigPos = per.filter((x) => x.excess > 0 && x.t >= 2).length;
  const sigNeg = per.filter((x) => x.excess < 0 && x.t <= -2).length;
  // A sign test on the days with a usable estimate.
  // TWO-SIDED EXACT BINOMIAL under H0: p = 0.5.
  //   p = 2 x P(X <= min(k, n-k)),  X ~ Bin(n, 0.5)
  // The SMALLER tail is used; using the larger one (as an earlier version
  // of this script did) returns a p-value near 1 for every result and is
  // wrong.
  const binomP = (() => {
    const n = per.length, k = Math.min(pos, n - pos);
    let cum = 0;
    for (let i = 0; i <= k; i++) cum += binomCoef(n, i) / (2 ** n);
    return Math.min(1, 2 * cum);
  })();
  console.log(`\n  ${label}`);
  console.log(`    ${per.length} days with 2+ paired rounds | positive ${pos} (${((pos / per.length) * 100).toFixed(1)}%) | significantly positive (t>=2) ${sigPos} | significantly NEGATIVE (t<=-2) ${sigNeg}`);
  console.log(`    two-sided SIGN TEST on the days: p = ${binomP.toExponential(2)}  (${binomP < 0.05 ? "the sign is not random" : "the sign IS consistent with random"})`);
  const pooled = mean(per.map((x) => x.excess));
  const ps = se(per.map((x) => x.excess));
  console.log(`    mean of the daily excesses ${fmt(pooled)}%  (se across days ${fmt(ps)})`);
  // the daily detail, sorted by date, compact
  const detail = per.map((x) => {
    const dt = new Date(x.d * DAY).toISOString().slice(5, 10);
    return `${dt}:${x.rounds}(${(x.excess >= 0 ? "+" : "") + x.excess.toFixed(4)},t${x.t.toFixed(1)})`;
  });
  console.log(`    ${detail.join(" ")}`);
  return { days: per.length, pos, sigPos, sigNeg, binomP, per };
}
function binomCoef(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

console.log(`\n${"=".repeat(118)}`);
console.log("  THE DAY-BY-DAY STABILITY TEST — in how many days is the excess positive?");
console.log("=".repeat(118));
const days = {};
days.laya = dayStability(S.laya.trades, S.tape.trades, "LAYA-ONLY vs TAPE-ONLY");
if (!DEEP) {
  days.live = dayStability(S.live.trades, S.tape.trades, "LIVE-GATE vs TAPE-ONLY");
  days.loose = dayStability(S.loose.trades, S.tape.trades, "LOOSE vs TAPE-ONLY");
}

// ══ DIRECTION SPLIT ══
console.log(`\n${"=".repeat(118)}`);
console.log("  THE DIRECTION SPLIT — the arm is 100% short, so there is no long side to compare against");
console.log("=".repeat(118));
for (const [k, lab] of [["live", "LIVE-GATE"], ["loose", "LOOSE"], ["laya", "LAYA-ONLY"], ["tape", "TAPE-ONLY"]]) {
  const tr = S[k].trades;
  const lo = tr.filter((t) => t.dir === "long");
  const sh = tr.filter((t) => t.dir === "short");
  console.log(`  ${pad(lab, 12)} long ${rpad(lo.length, 5)}  short ${rpad(sh.length, 5)}   long share ${((lo.length / Math.max(1, tr.length)) * 100).toFixed(1)}%`);
}

// ══ the DOLLARS ══
console.log(`\n${"=".repeat(118)}`);
console.log("  THE NET EXPECTANCY IN DOLLARS AT THE REAL SIZE");
console.log("=".repeat(118));
const liveEv = A.live.ev;
const netDollars = (liveEv / 100) * EQUITY;
console.log(`  equity $${EQUITY.toFixed(2)} | notional $${NOTIONAL.toFixed(2)} | exposure ${RHO.toFixed(4)}x`);
console.log(`  LIVE-GATE gross EV: ${fmt(liveEv)}% of equity per trade  =>  $${netDollars.toFixed(4)} per trade`);
console.log(`  the confirmation layer's excess: ${fmt(EX["live_vs_tape"].excess)}%  =>  $${((EX["live_vs_tape"].excess / 100) * EQUITY).toFixed(4)} per trade`);
console.log(`  the fee is ${(feePct / 100 * RHO * 100).toFixed(4)}% of equity = $${((feePct / 100) * NOTIONAL).toFixed(4)} per trade`);

// write the machine-readable result
writeFileSync(join(OUT, `result-${which}.json`), JSON.stringify({
  label, feePct, rows: rows.length, rounds: new Set(roundIdx.values()).size,
  spanH,
  arms: Object.fromEntries(Object.entries(A).map(([k, a]) => [k, {
    n: a.n, wins: a.wins, losses: a.losses, times: a.times, ambiguous: a.ambiguous,
    unresolved: a.unresolved, winRate: a.winRate, rounds: a.rounds, ev: a.ev, evSe: a.evSe,
  }])),
  excess: Object.fromEntries(Object.entries(EX).map(([k, e]) => [k, {
    rounds: e.rounds, excess: e.excess, se: e.se, t: e.t, df: e.df, p: e.p, crit05: e.crit05,
    diffs: e.diffs,
  }])),
  leaveOneSymbolOut: Object.fromEntries(Object.entries(loso).map(([k, v]) => [k, {
    full: { rounds: v.full.rounds, excess: v.full.excess, se: v.full.se, t: v.full.t, p: v.full.p },
    per: v.out,
    sorted: v.sorted.map((r) => ({ p: r.p, sigN: r.sigN, ctlN: r.ctlN, excessWithout: r.excessWithout, t: r.t, contribution: r.contribution })),
  }])),
  dayStability: Object.fromEntries(Object.entries(days).map(([k, v]) => [k, v ? {
    days: v.days, positive: v.pos, sigPositive: v.sigPos, sigNegative: v.sigNeg, signTestP: v.binomP,
    per: v.per.map((x) => ({ day: new Date(x.d * 86400000).toISOString().slice(0, 10), rounds: x.rounds, excess: x.excess, t: x.t })),
  } : null])),
  liveEv, netDollars,
}, null, 2));
console.log(`\n  wrote ${join(OUT, `result-${which}.json`)}`);
