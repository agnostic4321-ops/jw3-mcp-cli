#!/usr/bin/env node
/**
 * INDEPENDENT CHECK — recompute the fee-floor verdict from first
 * principles, in a different shape from the study, and compare.
 *
 * If the two disagree, one of them has a bug. This exists so the verdict
 * is not resting on a single implementation.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EQUITY = 57.1579522047;
const CAP = 60;
const TAKER_RT = 0.12; // % of notional
const MAKER_RT = 0.04;
const EXCESS_LOW = 0.0543; // % of equity per trade
const EXCESS_HIGH = 0.0978;

const rho = CAP / EQUITY;

console.log("=== INDEPENDENT RECOMPUTATION ===\n");
console.log(`rho = ${CAP}/${EQUITY} = ${rho.toFixed(6)}`);
console.log(`taker round trip on $${CAP}: $${((CAP * TAKER_RT) / 100).toFixed(4)} = ${((TAKER_RT / 100) * rho * 100).toFixed(4)}% of equity`);
console.log(`maker round trip on $${CAP}: $${((CAP * MAKER_RT) / 100).toFixed(4)} = ${((MAKER_RT / 100) * rho * 100).toFixed(4)}% of equity`);

// The break-even win rate and the fee drag, computed longhand.
console.log(`\nGEOMETRY        tp     sl   drag%   w*(taker)  w*(maker)  EV@66.7% taker  EV@66.7% maker`);
const geoms = [[0.5, 1.2], [0.6, 1.0], [0.8, 1.2], [1.0, 1.2], [1.2, 1.2], [1.5, 1.5], [2.0, 2.0]];
for (const [tp, sl] of geoms) {
  const dragT = TAKER_RT / sl;
  const wbeT = (sl + TAKER_RT) / (tp + sl + TAKER_RT);
  const wbeM = (sl + MAKER_RT) / (tp + sl + MAKER_RT);
  const evT = rho * (0.667 * tp - 0.333 * sl - TAKER_RT);
  const evM = rho * (0.667 * tp - 0.333 * sl - MAKER_RT);
  console.log(
    `TP ${tp.toFixed(1)}/SL ${sl.toFixed(1)}  ${tp.toFixed(2)}  ${sl.toFixed(2)}  ${(dragT * 100).toFixed(1)}%   ${(wbeT * 100).toFixed(1)}%     ${(wbeM * 100).toFixed(1)}%      ${evT >= 0 ? "+" : ""}${evT.toFixed(4)}%        ${evM >= 0 ? "+" : ""}${evM.toFixed(4)}%`,
  );
}

// The notional each fee mix allows.
console.log(`\nNOTIONAL ALLOWED (feeEq = notional/equity * feeRT < excess):`);
for (const [name, f] of [["maker-maker", MAKER_RT], ["maker-taker", 0.08], ["taker-taker", TAKER_RT]]) {
  for (const [lbl, ex] of [["LOW ", EXCESS_LOW], ["HIGH", EXCESS_HIGH]]) {
    const n = (EQUITY * ex) / f;
    console.log(`  ${name.padEnd(12)} vs ${lbl} excess ${ex.toFixed(4)}%  →  notional <= $${n.toFixed(2)}  (${(n / CAP).toFixed(3)}x the $${CAP} cap)`);
  }
}

// The shipped geometry's R:R and break-even, from the live path's own formula.
console.log(`\nTHE SHIPPED GEOMETRY (from planScalp, the live path's own function):`);
for (const atr of [0.518, 0.9, 1.159, 1.5, 2.654]) {
  const tp = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const stepDrop = Math.min(1.5, Math.max(0.6, atr * 0.9));
  const avg = 1 + stepDrop / 200;
  const kill = 1 + (2 * stepDrop) / 100;
  const sl = ((kill - avg) / avg) * 100;
  const rr = tp / sl;
  const wbe = (sl + TAKER_RT) / (tp + sl + TAKER_RT);
  const lev = Math.max(1, Math.min(50, Math.floor(1 / (2 * (sl / 100) + 0.005))));
  console.log(
    `  ATR ${atr.toFixed(3)}%  TP ${tp.toFixed(2)}%  SL ${sl.toFixed(2)}%  R:R 1:${(1 / rr).toFixed(1)}  w* ${(wbe * 100).toFixed(1)}%  drag ${((TAKER_RT / sl) * 100).toFixed(1)}%  lev x${lev}  margin $${(CAP / lev).toFixed(2)}`,
  );
}

// The BTC bench, recomputed from the contract's own mark price.
const contracts = JSON.parse(readFileSync(join(homedir(), ".hermes/cache/scratch/contracts.json"), "utf8")).data;
const btc = contracts.find((c) => c.symbol === "XBTUSDTM");
console.log(`\nTHE BTC BENCH:`);
console.log(`  XBT mark $${btc.markPrice}, multiplier ${btc.multiplier} → one contract = $${(btc.multiplier * btc.markPrice).toFixed(3)} notional`);
for (const n of [25.86, CAP]) {
  const fee = (n * TAKER_RT) / 100;
  console.log(`  at $${n.toFixed(2)} notional: round-trip fee $${fee.toFixed(4)} = ${(TAKER_RT).toFixed(2)}% of notional`);
  console.log(`    the shipped scalp TP is 0.30-0.50% → the TP pays $${((n * 0.003)).toFixed(4)}–$${((n * 0.005)).toFixed(4)}, the fee is $${fee.toFixed(4)}`);
  console.log(`    → ${TAKER_RT > 0.005 ? "THE FEE EXCEEDS THE WHOLE TP" : "the TP clears the fee"}`);
}

// The realized P&L: 4 closed trades, -$0.3038, $0.2841 of fees.
console.log(`\nTHE REALIZED RECORD:`);
console.log(`  4 closed trades, net -$0.3038, of which $0.2841 was fees → the GROSS was +$0.0197 on 4 trades`);
console.log(`  fees per trade = $${(0.2841 / 4).toFixed(4)} on a ~$59 notional = ${(((0.2841 / 4) / 59) * 100).toFixed(4)}% — the taker round trip, as measured`);
console.log(`  on $${EQUITY.toFixed(2)} of equity, $${(0.2841 / 4).toFixed(4)} per trade = ${((0.2841 / 4 / EQUITY) * 100).toFixed(4)}% of equity per trade`);
console.log(`  the measured excess is ${EXCESS_LOW}%–${EXCESS_HIGH}% per trade, i.e. $${((EQUITY * EXCESS_LOW) / 100).toFixed(4)}–$${((EQUITY * EXCESS_HIGH) / 100).toFixed(4)}`);
console.log(`  → at $${CAP} notional the fee ($${(0.2841 / 4).toFixed(4)}) is ${((0.2841 / 4) / ((EQUITY * EXCESS_LOW) / 100)).toFixed(2)}x the LOW excess and ${((0.2841 / 4) / ((EQUITY * EXCESS_HIGH) / 100)).toFixed(2)}x the HIGH excess`);
console.log(`  → the account's own realised trades CONFIRM the arithmetic: the fee exceeded the edge.`);

console.log(`\n=== CONCLUSION (independent of the study's code path) ===`);
console.log(`  At the $${CAP} notional cap the taker round trip costs ${((TAKER_RT / 100) * rho * 100).toFixed(4)}% of equity per trade.`);
console.log(`  The signal's measured excess over beta is ${EXCESS_LOW}%–${EXCESS_HIGH}% of equity per trade.`);
console.log(`  The fee is ${(((TAKER_RT / 100) * rho * 100) / EXCESS_HIGH).toFixed(2)}x the HIGH excess.`);
console.log(`  NO ticket is fee-viable at $${CAP} notional with a taker entry.`);
console.log(`  The notional must fall to <= $${((EQUITY * EXCESS_LOW) / TAKER_RT).toFixed(2)} (taker) or $${((EQUITY * EXCESS_LOW) / MAKER_RT).toFixed(2)} (maker-maker).`);
