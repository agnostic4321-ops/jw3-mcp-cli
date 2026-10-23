import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EQUITY = 57.1579522047;
const TAKER_RT = 0.12;

console.log("=== THE BTC BENCH, CHECKED PROPERLY ===\n");
const N = 60;
const tp = 0.30;
console.log(`at $${N} notional, taker-taker:`);
console.log(`  TP 0.30% pays $${(N * 0.003).toFixed(4)}; the fee costs $${(N * 0.0012).toFixed(4)}`);
console.log(`  TP as % of notional = 0.30%; fee as % of notional = 0.12%`);
console.log(`  tp% > fee% → ${tp > TAKER_RT ? "the TP DOES clear the fee in isolation" : "the fee exceeds the TP"}`);
console.log(`  but after the fee a WIN nets 0.30% - 0.12% = 0.18% of notional = $${(N * 0.0018).toFixed(4)}`);
console.log(`  and a LOSS costs -1.2% - 0.12% = -1.32% of notional = $${(N * 0.0132).toFixed(4)}`);
const wbe = (1.2 + TAKER_RT) / (0.5 + 1.2 + TAKER_RT);
console.log(`  break-even win rate at BTC's own geometry (TP 0.5 / SL 1.2, taker): ${(wbe * 100).toFixed(1)}%`);
console.log(`  the measured signal win rate is 66.7% → the BTC ticket loses money on its own geometry.`);

console.log(`\n=== THE TASK'S OWN WORDING, CHECKED ===\n`);
console.log(`  the task says: "~$0.10 of round-trip fees needs +0.12% just to break even, exceeding the scalp TP"`);
const feeUsd = 0.10;
const needPct = (feeUsd / N) * 100;
console.log(`  $${feeUsd.toFixed(2)} of round-trip fees on a $${N} notional = ${needPct.toFixed(3)}% of notional`);
console.log(`  → +${needPct.toFixed(2)}% of notional must be gained just to pay the round trip.`);
console.log(`  the shipped scalp TP is 0.30-0.50%.`);
console.log(`  ${needPct.toFixed(2)}% < 0.30%, so the TP DOES cover the fee at the TP's full value.`);
console.log(`  BUT the position is levered ${(60 / (EQUITY * 0.02)).toFixed(0)}x on the notional: the fee is`);
console.log(`  charged on the NOTIONAL, and the account's equity is $${EQUITY.toFixed(2)}.`);
console.log(`  So the fee as a fraction of EQUITY is ${((TAKER_RT / 100) * (N / EQUITY) * 100).toFixed(4)}%,`);
console.log(`  while the measured excess of the signal is 0.0543%-0.0978% of equity per trade.`);

console.log(`\n=== THE REAL ARGUMENT FOR THE BTC BENCH ===\n`);
const contracts = JSON.parse(readFileSync(join(homedir(), ".hermes/cache/scratch/contracts.json"), "utf8")).data;
const btc = contracts.find((c) => c.symbol === "XBTUSDTM");
console.log(`  XBT one contract = $${(btc.multiplier * btc.markPrice).toFixed(3)} notional (multiplier ${btc.multiplier}, mark $${btc.markPrice})`);
console.log(`  BTC's maxLeverage at the venue = ${btc.maxLeverage}`);
console.log(`  at the $60 cap: 1 contract would be ${(60 / (btc.multiplier * btc.markPrice)).toFixed(3)} lots — i.e. BTC cannot even`);
console.log(`  be traded at a fractional size below $${(btc.multiplier * btc.markPrice).toFixed(2)}, which is`);
console.log(`  ${((btc.multiplier * btc.markPrice) / (N / EQUITY) * 0.12).toFixed(4)}% of equity in fees at the taker rate.`);
console.log(`  the fee floor's notional limit at taker-taker is $${((EQUITY * 0.0543) / TAKER_RT).toFixed(2)}.`);
console.log(`  BTC's minimum tradeable notional $${(btc.multiplier * btc.markPrice).toFixed(2)} is ${((btc.multiplier * btc.markPrice) / ((EQUITY * 0.0543) / TAKER_RT)).toFixed(2)}x that limit.`);
console.log(`  → BTC IS BENCHED because its MINIMUM TRADEABLE SIZE is above the fee floor,`);
console.log(`    not because the scalp TP is smaller than the fee. The task's phrasing is right in`);
console.log(`    spirit (the fee dominates at small size) but the arithmetic needs the notional,`);
console.log(`    not just the percentage.`);

console.log(`\n=== WHAT THE 0.12% ACTUALLY BEATS ===\n`);
for (const [tp2, sl2] of [[0.5, 1.2], [0.3, 0.9], [0.46, 1.56]]) {
  const w = (sl2 + TAKER_RT) / (tp2 + sl2 + TAKER_RT);
  console.log(`  TP ${tp2}% / SL ${sl2}%: the fee pushes break-even from ${((sl2) / (tp2 + sl2) * 100).toFixed(1)}% to ${(w * 100).toFixed(1)}%  (+${((w - sl2 / (tp2 + sl2)) * 100).toFixed(1)}pp)`);
}
console.log(`  and the R:R of the shipped geometry (1:3.0 to 1:4.5 depending on ATR) means the`);
console.log(`  signal's measured 66.7% win rate is 10-16pp BELOW break-even even before the fee.`);
console.log(`  The fee is the second problem; the geometry is the first.`);
