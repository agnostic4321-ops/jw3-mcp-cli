#!/usr/bin/env node
/**
 * THE PER-SYMBOL DECOMPOSITION — which symbols carry the excess?
 *
 * ══ WHY THE OBVIOUS ESTIMATORS ARE DEGENERATE ══
 *
 * 1. "signal arm's mean minus tape arm's mean", per symbol: the TAPE arm
 *    is a SUPERSET of the signal arm (every confirmed trade is also a
 *    tape trade), so within a symbol the paired difference against it is
 *    a comparison of a subset with the set that contains it — and it is
 *    identically zero in every round where the symbol's confirmed trades
 *    are also in the tape arm's round, which is always. A CONSTANT ZERO.
 *
 * 2. "within symbol, within round, confirmed minus rejected": the
 *    confirmation layer's selection is CROSS-SECTIONAL — in a round it
 *    confirms the tape on some symbols and rejects it on others — so a
 *    symbol rarely has BOTH a confirmed and a rejected tape signal in the
 *    same round. Almost no observations. That is a fact about the
 *    mechanism, not a measurement.
 *
 * ══ THE ESTIMATOR THAT ANSWERS THE QUESTION ══
 *
 * "Does the excess survive dropping the top symbol?" is a question about
 * the ARM-LEVEL excess's SENSITIVITY to each symbol. So: recompute the
 * arm-level paired-by-round excess with symbol s removed from BOTH arms,
 * for every s, and see which s moves it.
 *
 *     contribution(s) = excess(full) - excess(without s)
 *
 * A symbol whose removal changes the excess a lot CARRIES it. If the
 * excess collapses when the top symbol is dropped, it was that symbol.
 * This is non-degenerate and it answers the question as asked.
 */
import { mean, se, tPval } from "./core.mjs";

const fmt = (x, d = 4) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/**
 * LEAVE-ONE-SYMBOL-OUT on the arm-level paired-by-round excess.
 *
 * @param sigTrades   the signal arm's trades
 * @param ctlTrades   the control arm's trades
 * @param pairedExcessFn  (sigTrades, ctlTrades) -> {excess, se, t, p, rounds}
 * @param label
 */
export function leaveOneSymbolOut(sigTrades, ctlTrades, pairedExcessFn, label) {
  const full = pairedExcessFn(sigTrades, ctlTrades);
  const pairs = [...new Set([...sigTrades.map((t) => t.pair), ...ctlTrades.map((t) => t.pair)])].sort();
  console.log(`\n  ${label}`);
  console.log(`  full: rounds ${full.rounds} | excess ${fmt(full.excess)}% | se ${fmt(full.se)} | t ${fmt(full.t, 2)} | p ${full.p.toFixed(4)}`);
  console.log(`\n  ${"symbol".padEnd(18)}${"sigN".padStart(6)}${"ctlN".padStart(6)}${"roundsAfter".padStart(12)}${"excess w/o".padStart(12)}${"se".padStart(10)}${"t".padStart(8)}${"contribution".padStart(14)}`);
  const out = [];
  for (const p of pairs) {
    const sn = sigTrades.filter((t) => t.pair === p).length;
    const cn = ctlTrades.filter((t) => t.pair === p).length;
    if (!sn && !cn) continue;
    const e = pairedExcessFn(sigTrades.filter((t) => t.pair !== p), ctlTrades.filter((t) => t.pair !== p));
    const contribution = full.excess - e.excess;
    out.push({ p, sigN: sn, ctlN: cn, rounds: e.rounds, excessWithout: e.excess, se: e.se, t: e.t, contribution });
    console.log(`  ${pad(p, 18)}${rpad(sn, 6)}${rpad(cn, 6)}${rpad(e.rounds, 12)}${rpad(fmt(e.excess), 12)}${rpad(fmt(e.se), 10)}${rpad(fmt(e.t, 2), 8)}${rpad(fmt(contribution), 14)}`);
  }
  const sorted = [...out].sort((a, b) => b.contribution - a.contribution);
  if (sorted.length > 1) {
    const top = sorted[0];
    const keep = new Set(sorted.slice(1).map((r) => r.p));
    const e2 = pairedExcessFn(sigTrades.filter((t) => keep.has(t.pair)), ctlTrades.filter((t) => keep.has(t.pair)));
    console.log(`\n    top contributor: ${top.p} (contributes ${fmt(top.contribution)}% of the excess, ${top.sigN} signal trades)`);
    console.log(`    DROPPING IT: rounds ${e2.rounds} | excess ${fmt(e2.excess)}% | se ${fmt(e2.se)} | t ${fmt(e2.t, 2)} | p ${e2.p.toFixed(4)}`);
  }
  return { full, out, sorted };
}

/**
 * THE CROSS-SECTIONAL TABLE — how many symbols does the confirmation
 * layer confirm vs reject in each round, and does the excess live in
 * the rounds where it confirmed many or few?
 */
export function crossSectional(sigTrades, ctlTrades, pairedExcessFn, label) {
  // per round: the signal arm's mean, the control arm's mean, and how
  // many symbols the confirmation layer took in that round
  const byRound = new Map();
  const push = (trades, side) => {
    for (const t of trades) {
      const e = byRound.get(t.round) ?? { sig: [], ctl: [], sigPairs: new Set() };
      e[side].push(t.pnl);
      if (side === "sig") e.sigPairs.add(t.pair);
      byRound.set(t.round, e);
    }
  };
  push(sigTrades, "sig");
  push(ctlTrades, "ctl");
  const rows = [...byRound.entries()]
    .filter(([, e]) => e.sig.length && e.ctl.length)
    .map(([round, e]) => ({
      round, nSig: e.sig.length, nCtl: e.ctl.length, nSym: e.sigPairs.size,
      diff: mean(e.sig) - mean(e.ctl),
    }))
    .sort((a, b) => a.round - b.round);
  console.log(`\n  ${label}`);
  if (!rows.length) { console.log("    (no rounds with both arms trading)"); return; }
  // split by the median number of symbols confirmed
  const ns = rows.map((r) => r.nSym).sort((a, b) => a - b);
  const med = ns[Math.floor(ns.length / 2)];
  const lo = rows.filter((r) => r.nSym <= med);
  const hi = rows.filter((r) => r.nSym > med);
  for (const [lab, sub] of [["<= median symbols confirmed", lo], ["> median symbols confirmed", hi]]) {
    if (!sub.length) continue;
    const m = mean(sub.map((r) => r.diff));
    const s = se(sub.map((r) => r.diff));
    const t = s > 0 ? m / s : 0;
    console.log(`    ${pad(lab, 30)} rounds ${rpad(sub.length, 4)} | excess ${fmt(m)}% | t ${fmt(t, 2)}`);
  }
  // correlation between the number of symbols confirmed and the excess
  const xs = rows.map((r) => r.nSym), ys = rows.map((r) => r.diff);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
  console.log(`    correlation(#symbols confirmed, per-round excess) = ${Number.isFinite(r) ? r.toFixed(3) : "n/a"} over ${rows.length} rounds`);
}
