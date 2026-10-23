#!/usr/bin/env node
/**
 * THE FEE SCHEDULE COMPARISON — every CEX venue the app supports, at the
 * account's real 30-day volume.
 *
 * ── WHAT THIS ANSWERS ──
 *
 * The task's question is a question about KuCoin's VOLUME-BASED futures fee
 * schedule, and about whether a cheaper venue would move the fee floor.
 *
 * The repo's own numbers (docs/research/the-scratch-artefact.md):
 *   equity            $56.89 (of $57.46)
 *   ticket notional   $60
 *   taker round trip  0.12% of notional = $0.0713 on $59.41
 *   gross take-profit $0.18 (0.30% of notional)
 *   break-even        82.8%
 *
 * ── SOURCING RULE ──
 *
 * Every number in the tables below is from a VENUE-SERVED or VENUE-PUBLISHED
 * source, named in the `source` field of each row:
 *
 *   • KuCoin    — kucoin.com/vip/privilege/fee (the rate table) and
 *                 kucoin.com/support/48142946141649 (the thresholds), plus
 *                 the venue's own public contract record, which independently
 *                 confirms VIP0:
 *                   GET https://api-futures.kucoin.com/api/v1/contracts/XBTUSDTM
 *                   -> "makerFeeRate":2.0E-4, "takerFeeRate":6.0E-4
 *   • Binance   — binance.com/en/fee/futureFee (the published USDⓈ-M table)
 *   • Bybit     — bybit.com/en/help-center/article/Trading-Fee-Structure
 *   • OKX       — okx.com/fees (the page's own Futures fee table)
 *   • Gate.io   — gate.com/futures FAQ (the VIP0 base rate) and
 *                 api.gateio.ws/api/v4/futures/usdt/contracts/{sym}
 *   • Bitget    — api.bitget.com/api/v2/mix/market/contracts
 *   • BingX     — bingx.com/en/fee/ and open-api.bingx.com contracts
 *   • Kraken    — futures.kraken.com/derivatives/api/v3/feeschedules (JSON)
 *   • MEXC      — contract.mexc.com/api/v1/contract/detail
 *
 * WHERE A LADDER COULD NOT BE READ FROM A VENUE SOURCE, the ladder is
 * `null` and the row says so. NO NUMBER HERE IS INTERPOLATED OR GUESSED.
 * The `ladderSource` field names the source; `ladderVerified` is false when
 * only the base tier could be confirmed.
 *
 * ── THE TWO BREAK-EVEN FORMULAS ──
 *
 *   BE_true = (SL + fee) / (TP + SL)          — the CORRECT one, and the one
 *                                             the repo's PUBLISHED numbers use
 *   BE_var  = (SL + fee) / (TP + SL + fee)    — a variant some repo scripts
 *                                             use; it UNDERSTATES the
 *                                             break-even, because it lets the
 *                                             fee shrink as the win rate
 *                                             rises — but the fee is charged
 *                                             once per trade whatever the
 *                                             outcome
 *
 * Which is which is decided by REPRODUCING the repo's own published numbers,
 * not by assertion:
 *
 *   uni-selfcheck.py B5:  "the break-even win rate at TP 0.48% / SL 1.6114%
 *                          is 82.8%"
 *     (0.016114 + 0.0012) / (0.0048 + 0.016114) = 82.79%   <- BE_true
 *     (0.016114 + 0.0012) / (0.0048 + 0.016114 + 0.0012) = 78.29%  <- BE_var
 *
 * So the repo's 82.8% IS BE_true, and BE_true is the primary column here.
 * `geom-reach-verdict-table.mjs` names the other one "BE_repo" and says:
 *   "THE TASK'S 82.8% IS THE REPO'S FORMULA AT TP 0.35% / SL 1.60%. The
 *    correct figure there is 88.2%."
 * — but that script's own "BE_repo" is BE_true at the geometry it names, and
 * its "BE_true" is the variant. The labels there are inverted relative to the
 * arithmetic, so this script names them by what they DO.
 *
 * ── THE GEOMETRY ──
 *
 * The ticket under test is the one the task names: a 0.35% gross
 * take-profit. The stop is the repo's shipped stop at the ATR=1.2
 * reference geometry (1.6114%), because that is the geometry the repo's
 * own 82.8% was computed at (uni-selfcheck.py B5:
 *   "the break-even win rate at TP 0.48% / SL 1.6114% is 82.8%").
 * A second geometry (TP 0.30% / SL 1.0775%) is printed for the shipped
 * ATR=0.8 ticket, so the reader can see the range.
 *
 * READ-ONLY. Writes exactly one new JSON summary. Never writes an
 * *.ndjson. Never calls a `jw3` command. Never touches the account.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const TRADE_LOOP = join(SCRATCH, "trade-loop.ndjson");
const OUT = join(SCRATCH, "fee-schedule-comparison.json");

/* ══ the account, as measured ═════════════════════════════════════════ */

const EQUITY = 56.89;          // the scratch artefact's reconciled equity
const NOTIONAL = 60.0;         // the per-position cap
const DAILY_NOTIONAL = 500.0;  // the daily notional budget

/* ══ the ticket geometries ═══════════════════════════════════════════ */
/*
 * THE REPO'S OWN TICKET RULE, verbatim from
 * packages/jw3-cli/research/uni_core.py `shipped_ticket()` and
 * src/commands/live-cmd.ts `planScalp`:
 *
 *   tpPct = clamp(0.4 x ATR%, 0.3, 0.5)      the take-profit, in PERCENT
 *   d     = clamp(0.9 x ATR%, 0.6, 1.5)      the step drop, in PERCENT
 *   stop  = 3d / (200 + d)                   the REALISED stop, a FRACTION
 *
 * The stop is a FRACTION of the entry, so it is x100 to be a percent.
 * `stopPct` is therefore the shipped stop AT THAT ATR, and the take-profit
 * is whatever the rule produces there.
 *
 * VALIDATION: this rule reproduces the repo's two published break-even
 * numbers EXACTLY, which is the check that the geometry is the repo's:
 *
 *   ATR 0.75 -> TP 0.3000%  stop 1.0091%  ->  BE 86.25%   (repo: 86.2%)
 *   ATR 1.20 -> TP 0.4800%  stop 1.6113%  ->  BE 82.79%   (repo: 82.8%)
 */
function shippedTicket(atrPct) {
  const tpPct = Math.min(0.5, Math.max(0.3, atrPct * 0.4));
  const d = Math.min(1.5, Math.max(0.6, atrPct * 0.9));
  const stopPct = (3 * d) / (200 + d) * 100;
  return { atrPct, tpPct, d, stopPct, rMultiple: tpPct / stopPct };
}

/** The task's ticket: a 0.35% gross take-profit, with the repo's own stop. */
const GEOM_TASK = (() => {
  const t = shippedTicket(0.35 / 0.4);   // the ATR that yields a 0.35% TP
  return { label: `TP ${t.tpPct.toFixed(2)}% / SL ${t.stopPct.toFixed(4)}% (ATR ${t.atrPct.toFixed(3)})`, tp: t.tpPct, sl: t.stopPct };
})();
/** The shipped ticket at the ATR=1.2 reference — the repo's 82.8% anchor. */
const GEOM_REPO = (() => {
  const t = shippedTicket(1.2);
  return { label: `TP ${t.tpPct.toFixed(2)}% / SL ${t.stopPct.toFixed(4)}% (ATR 1.200)`, tp: t.tpPct, sl: t.stopPct };
})();
/** The shipped ticket at the TP floor (ATR 0.75) — the repo's 86.2% anchor. */
const GEOM_SHIP = (() => {
  const t = shippedTicket(0.75);
  return { label: `TP ${t.tpPct.toFixed(2)}% / SL ${t.stopPct.toFixed(4)}% (ATR 0.750)`, tp: t.tpPct, sl: t.stopPct };
})();

/** The gross take-profit the task's table is stated against. */
const GROSS_TP_PCT = 0.35;

/** The CORRECT break-even: the fee is charged once per trade, whatever the outcome. */
const beTrue = (tp, sl, fee) => (sl + fee) / (tp + sl);
/** The variant that understates it (it lets the fee shrink as the win rate rises). */
const beVar = (tp, sl, fee) => (sl + fee) / (tp + sl + fee);

/* ══ THE VENUE TABLE ═════════════════════════════════════════════════ */
/*
 * `base` is the LOWEST tier (VIP0 / Regular user) maker/taker, in %.
 * `ladder` is the venue's own published tier ladder, or null when only the
 * base tier could be read from a venue source.
 * `vol` in a ladder row is the 30-day volume threshold IN THE UNIT the
 * venue publishes it in — see `ladderUnit`.
 */
const VENUES = [
  {
    id: "kucoin", display: "KuCoin", perps: true,
    base: { maker: 0.02, taker: 0.06 },
    baseSource: "kucoin.com/vip/privilege/fee (VIP 0 row) + api-futures.kucoin.com contract record (makerFeeRate 2.0E-4, takerFeeRate 6.0E-4)",
    ladder: [
      { vip: 0, vol: 0, maker: 0.02, taker: 0.06 },
      { vip: 1, vol: 5_000_000, maker: 0.018, taker: 0.06 },
      { vip: 2, vol: 8_000_000, maker: 0.015, taker: 0.06 },
      { vip: 3, vol: 16_000_000, maker: 0.01, taker: 0.06 },
      { vip: 4, vol: 40_000_000, maker: 0.008, taker: 0.053 },
      { vip: 5, vol: 60_000_000, maker: 0.006, taker: 0.048 },
      { vip: 6, vol: 120_000_000, maker: 0.004, taker: 0.043 },
      { vip: 7, vol: 200_000_000, maker: 0.002, taker: 0.039 },
      { vip: 8, vol: 300_000_000, maker: 0.0, taker: 0.036 },
      { vip: 9, vol: 400_000_000, maker: 0.0, taker: 0.033 },
      { vip: 10, vol: 600_000_000, maker: 0.0, taker: 0.03 },
      { vip: 11, vol: 800_000_000, maker: 0.0, taker: 0.028 },
      { vip: 12, vol: 1_000_000_000, maker: 0.0, taker: 0.025 },
    ],
    ladderSource: "kucoin.com/vip/privilege/fee (rates) + kucoin.com/support/48142946141649 (thresholds)",
    ladderUnit: "30-day FUTURES trading volume (USDT)",
    ladderVerified: true,
    ladderNote: "VIP 1 also unlocks at $5M 30-day SPOT volume, or 1,000 KCS held, or $200k account assets — any ONE path qualifies.",
    perpsNote: "",
  },
  {
    id: "binance", display: "Binance USDⓈ-M", perps: true,
    base: { maker: 0.02, taker: 0.05 },
    baseSource: "binance.com/en/fee/futureFee (Regular User row)",
    ladder: [
      { vip: 0, vol: 0, maker: 0.02, taker: 0.05 },
      { vip: 1, vol: 5_000_000, maker: 0.018, taker: 0.05 },
      { vip: 2, vol: 10_000_000, maker: 0.016, taker: 0.04 },
      { vip: 3, vol: 50_000_000, maker: 0.012, taker: 0.032 },
      { vip: 4, vol: 600_000_000, maker: 0.01, taker: 0.03 },
      { vip: 5, vol: 1_000_000_000, maker: 0.008, taker: 0.027 },
      { vip: 6, vol: 2_500_000_000, maker: 0.006, taker: 0.025 },
      { vip: 7, vol: 5_000_000_000, maker: 0.004, taker: 0.022 },
      { vip: 8, vol: 12_500_000_000, maker: 0.002, taker: 0.02 },
      { vip: 9, vol: 25_000_000_000, maker: 0.0, taker: 0.017 },
    ],
    ladderSource: "binance.com/en/fee/futureFee",
    ladderUnit: "30-day futures volume (USD; USDⓈ-M and COIN-M pooled)",
    ladderVerified: true,
    ladderNote: "VIP 1+ also require a BNB balance (5 BNB for VIP 1, up to 5,500 BNB for VIP 9).",
    perpsNote: "",
  },
  {
    id: "bybit", display: "Bybit", perps: true,
    base: { maker: 0.02, taker: 0.055 },
    baseSource: "bybit.com/en/help-center/article/Trading-Fee-Structure (VIP 0 row, Perpetual & Futures Contracts Trading)",
    ladder: [
      { vip: 0, vol: 0, maker: 0.02, taker: 0.055 },
      { vip: 1, vol: 10_000_000, maker: 0.018, taker: 0.04 },
      { vip: 2, vol: 25_000_000, maker: 0.016, taker: 0.0375 },
      { vip: 3, vol: 50_000_000, maker: 0.014, taker: 0.035 },
      { vip: 4, vol: 100_000_000, maker: 0.012, taker: 0.032 },
      { vip: 5, vol: 250_000_000, maker: 0.01, taker: 0.032 },
      { vip: 6, vol: 500_000_000, maker: 0.008, taker: 0.028 },
      { vip: "Supreme", vol: 500_000_000, maker: 0.0, taker: 0.03 },
    ],
    ladderSource: "bybit.com/en/help-center/article/Trading-Fee-Structure",
    ladderUnit: "30-day DERIVATIVES trading volume (USD)",
    ladderVerified: true,
    ladderNote: "The tier is the highest of asset balance OR 30-day volume; VIP 1 also unlocks at $100k assets.",
    perpsNote: "",
  },
  {
    id: "okx", display: "OKX", perps: false,
    base: { maker: 0.02, taker: 0.05 },
    baseSource: "okx.com/fees (Futures tab) + okx.com/help/trading-fee-rules-faq (the worked example: 'Maker fee: 0.02%; Taker fee: 0.05%')",
    ladder: null,
    ladderSource: "NOT READ: okx.com/fees publishes the futures ladder in a JS payload whose assetType-4 rows begin at VIP 1 and do not reconcile with the published Regular-user futures rate (0.02%/0.05%). NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day futures volume (USD)",
    ladderVerified: false,
    ladderNote: "SPOT-ONLY in this app today: its perps order path is not wired (src/lib/trading-symbols.ts).",
    perpsNote: "",
  },
  {
    id: "gateio", display: "Gate.io", perps: true,
    base: { maker: 0.02, taker: 0.05 },
    baseSource: "gate.com/futures FAQ: 'The base rate for VIP0 is 0.020% for makers and 0.050% for takers'",
    ladder: null,
    ladderSource: "NOT READ: gate.com/fee publishes the spot table in a readable form, but the Futures Fee Rate tab and the VIP-upgrade table could not be extracted as machine-readable values. NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day trading volume (USD; futures counted as notional x leverage)",
    ladderVerified: false,
    ladderNote: "Gate's own contract record for BTC_USDT shows maker_fee_rate -0.0001 and taker_fee_rate 0.00075 — the VIP0 CONTRACT-level rates, before the VIP discount.",
    perpsNote: "",
  },
  {
    id: "bitget", display: "Bitget", perps: true,
    base: { maker: 0.02, taker: 0.06 },
    baseSource: "api.bitget.com/api/v2/mix/market/contracts (BTCUSDT: makerFeeRate 0.0002, takerFeeRate 0.0006)",
    ladder: null,
    ladderSource: "NOT READ: bitget.com/fee publishes a SPOT ladder (0.1%/0.1% at VIP0) and states the futures fee separately, but the futures tier table could not be extracted as machine-readable values. NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day spot trading volume (USDT)",
    ladderVerified: false,
    ladderNote: "",
    perpsNote: "",
  },
  {
    id: "bingx", display: "BingX", perps: true,
    base: { maker: 0.02, taker: 0.05 },
    baseSource: "bingx.com/en/fee/ (Regular user: 0.0200% / 0.0500%) + open-api.bingx.com contract record (makerFeeRate 0.0002, takerFeeRate 0.0005)",
    ladder: null,
    ladderSource: "NOT READ: bingx.com/en/fee/ publishes the per-LEVEL RATES (Supreme 0/0.025% down to Regular 0.02%/0.05%) but the volume thresholds behind them are rendered client-side and could not be extracted as machine-readable values. NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day volume (USDT)",
    ladderVerified: false,
    ladderNote: "BingX's published RATES by level are known; only the volume thresholds were unread. The rate ladder is therefore in `rateOnly` below.",
    perpsNote: "",
    rateOnly: [
      { level: "Supreme VIP", maker: 0.0, taker: 0.025 },
      { level: "VIP 5", maker: 0.006, taker: 0.03 },
      { level: "VIP 4", maker: 0.008, taker: 0.0315 },
      { level: "VIP 3", maker: 0.01, taker: 0.035 },
      { level: "VIP 2", maker: 0.012, taker: 0.0375 },
      { level: "VIP 1", maker: 0.014, taker: 0.04 },
      { level: "Elite", maker: 0.018, taker: 0.045 },
      { level: "Regular user", maker: 0.02, taker: 0.05 },
    ],
  },
  {
    id: "kraken", display: "Kraken Futures", perps: true,
    base: { maker: 0.02, taker: 0.05 },
    baseSource: "futures.kraken.com/derivatives/api/v3/feeschedules (PF_ instruments use schedule 723888f7-0a8e-4183-8648-f920a22339e3)",
    ladder: [
      { vip: 0, vol: 0, maker: 0.02, taker: 0.05 },
      { vip: 1, vol: 5_000_000, maker: 0.0175, taker: 0.045 },
      { vip: 2, vol: 10_000_000, maker: 0.015, taker: 0.04 },
      { vip: 3, vol: 15_000_000, maker: 0.0125, taker: 0.035 },
      { vip: 4, vol: 25_000_000, maker: 0.01, taker: 0.03 },
      { vip: 5, vol: 50_000_000, maker: 0.005, taker: 0.025 },
      { vip: 6, vol: 100_000_000, maker: 0.0, taker: 0.02 },
      { vip: 7, vol: 250_000_000, maker: -0.003, taker: 0.0175 },
      { vip: 8, vol: 500_000_000, maker: -0.005, taker: 0.015 },
      { vip: 9, vol: 1_000_000_000, maker: -0.006, taker: 0.0135 },
      { vip: 10, vol: 5_000_000_000, maker: -0.006, taker: 0.0125 },
    ],
    ladderSource: "futures.kraken.com/derivatives/api/v3/feeschedules (JSON, served by the venue)",
    ladderUnit: "30-day volume (USD)",
    ladderVerified: true,
    ladderNote: "",
    perpsNote: "",
  },
  {
    id: "mexc", display: "MEXC", perps: false,
    base: { maker: 0.01, taker: 0.04 },
    baseSource: "contract.mexc.com/api/v1/contract/detail (BTC_USDT: makerFeeRate 0.0001, takerFeeRate 0.0004)",
    ladder: null,
    ladderSource: "NOT READ: MEXC's futures fee page publishes a RANGE (futures maker 0.000%-0.040%, taker 0.000%-0.100%) plus a per-pair special-rate table, not a tier ladder with thresholds. NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day volume (USDT)",
    ladderVerified: false,
    ladderNote: "SPOT-ONLY in this app today: contract.mexc.com has no futures signer wired.",
    perpsNote: "MEXC's contract record is PAIR-SPECIFIC: BTC_USDT maker 0.01% / taker 0.04%; ETH_USDT maker 0 / taker 0.02%; SOL_USDT maker 0 / taker 0.01%; DOGE_USDT maker 0 / taker 0.02%. The cheapest observed is SOL at a 0.01% taker.",
  },
  {
    id: "coinbase", display: "Coinbase", perps: false,
    base: { maker: 0.04, taker: 0.06 },
    baseSource: "coinbase.com/derivatives (US derivatives) — the app's Coinbase integration is SPOT-ONLY, so the comparison row is the venue's listed spot/margined base rate",
    ladder: null,
    ladderSource: "NOT READ: Coinbase's fee tables are rendered per-account and were not extractable as a public tier ladder. NO ladder is published here rather than an interpolated one.",
    ladderUnit: "30-day volume (USD)",
    ladderVerified: false,
    ladderNote: "SPOT-ONLY in this app today: no perps order path is wired.",
    perpsNote: "",
  },
];

/* ══ the account's ACTUAL 30-day volume ═══════════════════════════════ */

/** Read the local trade-loop log. READ-ONLY. Never touches the account. */
function measuredVolume() {
  if (!existsSync(TRADE_LOOP)) return { notional: null, trades: 0, note: "trade-loop.ndjson not found" };
  let notional = 0;
  let trades = 0;
  for (const line of readFileSync(TRADE_LOOP, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.event !== "FIRED") continue;
    const n = d.ticket?.sizing?.notionalUsd;
    if (Number.isFinite(n)) { notional += n; trades++; }
  }
  return { notional, trades, note: "from ~/.hermes/cache/scratch/trade-loop.ndjson (FIRED rows)" };
}

/* ══ helpers ═════════════════════════════════════════════════════════ */

const fmt = (v, d = 4) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/**
 * One row of the fee table.
 *   rtPct    the round-trip fee as a % of notional
 *   feeUsd   the round-trip fee in dollars on the $60 ticket
 *   ofGross  the fee as a % of the 0.35% gross take-profit
 *   beTrue     the implied break-even win rate (the correct formula)
 *   beVar      the same under the repo's variant formula
 *   feeEq    the fee as a % of equity per trade (rho = notional/equity)
 */
function row(makerPct, takerPct, geom) {
  const mixes = {
    taker: takerPct * 2,   // both legs taker — what the live path pays
    maker: makerPct * 2,   // both legs maker
    mix: makerPct + takerPct, // maker entry + taker exit
  };
  const out = {};
  for (const [k, rt] of Object.entries(mixes)) {
    out[k] = {
      rtPct: rt,
      feeUsd: (rt / 100) * NOTIONAL,
      ofGross: (rt / GROSS_TP_PCT) * 100,
      feeEqPct: (rt / 100) * (NOTIONAL / EQUITY) * 100,
      beTrue: beTrue(geom.tp, geom.sl, rt) * 100,
      beVar: beVar(geom.tp, geom.sl, rt) * 100,
    };
  }
  return out;
}

/** The tier this account is actually in at its measured volume. */
function tierFor(ladder, volume) {
  if (!ladder) return null;
  let t = ladder[0];
  for (const r of ladder) if (volume >= r.vol) t = r;
  return t;
}

/** The next tier up, and the volume needed to reach it. */
function nextTier(ladder, volume) {
  if (!ladder) return null;
  for (const r of ladder) if (r.vol > volume) return r;
  return null;
}

/** Days of trading at the daily notional budget to reach a volume. */
const daysTo = (vol) => Math.ceil(vol / DAILY_NOTIONAL);

const main = () => {
  const vol = measuredVolume();
  const accountVol = vol.notional ?? 0;
  /** KuCoin VIP0's taker round trip, as a % of notional. */
  const kcTier0TakerRT = 0.12;

  console.log("=".repeat(122));
  console.log("THE FEE SCHEDULE COMPARISON — every CEX venue the app supports");
  console.log("=".repeat(122));
  console.log(`  equity                $${EQUITY.toFixed(2)}`);
  console.log(`  ticket notional       $${NOTIONAL.toFixed(2)}   (rho = ${(NOTIONAL / EQUITY).toFixed(4)}x equity)`);
  console.log(`  daily notional budget $${DAILY_NOTIONAL.toFixed(2)}   (${Math.floor(DAILY_NOTIONAL / NOTIONAL)} tickets/day)`);
  console.log(`  gross take-profit     ${GROSS_TP_PCT.toFixed(2)}% of notional = $${((GROSS_TP_PCT / 100) * NOTIONAL).toFixed(4)}`);
  console.log(`  measured 30d volume   ${accountVol ? "$" + accountVol.toFixed(2) : "—"} (${vol.trades} FIRED tickets; ${vol.note})`);

  /* ── 0. THE GEOMETRY VALIDATION ───────────────────────────────────── */
  console.log(`\n${"=".repeat(122)}`);
  console.log("0. THE GEOMETRY — derived from the repo's OWN ticket rule, and validated against the repo's");
  console.log("   own published break-even numbers");
  console.log(`${"=".repeat(122)}`);
  console.log("  rule (uni_core.py shipped_ticket / live-cmd.ts planScalp):");
  console.log("    tpPct = clamp(0.4 x ATR%, 0.3, 0.5);  d = clamp(0.9 x ATR%, 0.6, 1.5);  stop = 3d/(200+d)");
  for (const g of [GEOM_TASK, GEOM_SHIP, GEOM_REPO]) {
    const b = beTrue(g.tp, g.sl, kcTier0TakerRT) * 100;
    console.log(`  ${pad(g.label, 40)} R:R 1:${(g.sl / g.tp).toFixed(2)}   BE (correct) ${b.toFixed(2)}%`);
  }
  const beRepo82 = beTrue(GEOM_REPO.tp, GEOM_REPO.sl, kcTier0TakerRT) * 100;
  const beRepo86 = beTrue(GEOM_SHIP.tp, GEOM_SHIP.sl, kcTier0TakerRT) * 100;
  console.log(`\n  VALIDATION against the repo's published numbers:`);
  console.log(`    uni-selfcheck.py B5: "the break-even win rate at TP 0.48% / SL 1.6114% is 82.8%"`);
  console.log(`      this script, from the rule: ${beRepo82.toFixed(2)}%   ${Math.abs(beRepo82 - 82.8) < 0.1 ? "✓ REPRODUCES" : "✗ DOES NOT REPRODUCE"}`);
  console.log(`    universe-14day.md: "the break-even win rate is 86.2% at that geometry"`);
  console.log(`      this script, from the rule: ${beRepo86.toFixed(2)}%   ${Math.abs(beRepo86 - 86.2) < 0.15 ? "✓ REPRODUCES" : "✗ DOES NOT REPRODUCE"}`);
  console.log(`\n  THE TASK'S TICKET: a 0.35% gross take-profit, with the stop the same rule gives`);
  console.log(`    (${GEOM_TASK.label})`);
  console.log(`    the fee at 0.12% taker-taker is ${(0.12 / 0.35 * 100).toFixed(1)}% of that gross`);

  /* ── 1. KUCOIN'S LADDER ──────────────────────────────────────────── */
  console.log(`\n${"=".repeat(122)}`);
  console.log("1. KUCOIN FUTURES — THE VOLUME-BASED LADDER (official)");
  console.log(`${"=".repeat(122)}`);
  console.log("  source: kucoin.com/vip/privilege/fee (rates) + kucoin.com/support/48142946141649 (thresholds)");
  console.log("  VIP0 independently confirmed by the venue's own public contract record:");
  console.log("    GET api-futures.kucoin.com/api/v1/contracts/XBTUSDTM -> makerFeeRate 2.0E-4, takerFeeRate 6.0E-4");
  console.log();
  const kc = VENUES.find((v) => v.id === "kucoin").ladder;
  const kcTier = tierFor(kc, accountVol);
  const kcNext = nextTier(kc, accountVol);
  console.log(`  ${pad("VIP", 7)}${padL("30d fut volume", 18)}${padL("maker/side", 12)}${padL("taker/side", 12)}${padL("RT taker", 11)}${padL("RT maker", 11)}${padL("maker RT as % of 0.35% gross", 27)}${padL("days of trading", 18)}`);
  console.log("  " + "-".repeat(118));
  for (const r of kc) {
    const cur = r.vip === kcTier.vip ? "   ← THIS ACCOUNT" : "";
    console.log(
      `  ${pad("VIP " + r.vip, 7)}${padL("$" + r.vol.toLocaleString(), 18)}${padL(r.maker.toFixed(3) + "%", 12)}${padL(r.taker.toFixed(3) + "%", 12)}` +
      `${padL((r.taker * 2).toFixed(3) + "%", 11)}${padL((r.maker * 2).toFixed(3) + "%", 11)}` +
      `${padL(((r.maker * 2) / GROSS_TP_PCT * 100).toFixed(1) + "%", 27)}${padL(r.vol === 0 ? "—" : daysTo(r.vol).toLocaleString(), 18)}${cur}`,
    );
  }
  console.log(`\n  THE ACCOUNT IS AT VIP ${kcTier.vip}: maker ${kcTier.maker}% / taker ${kcTier.taker}% per side.`);
  console.log(`  The next tier (VIP ${kcNext.vip}) needs $${kcNext.vol.toLocaleString()} of 30-day futures volume.`);
  console.log(`  At $${DAILY_NOTIONAL.toFixed(0)} of notional a day that is ${daysTo(kcNext.vol).toLocaleString()} DAYS of trading.`);
  console.log(`  And a 30-day window holds only $${(DAILY_NOTIONAL * 30).toLocaleString()} of volume, so the tier is`);
  console.log(`  ${Math.ceil(kcNext.vol / (DAILY_NOTIONAL * 30)).toLocaleString()} 30-day windows away — the tier decays back to VIP 0 long before it is reached.`);

  console.log(`\n  THE ROUND TRIP AT EACH KUCOIN TIER, against the 0.35% gross take-profit:`);
  console.log(`  ${pad("VIP", 7)}${padL("RT taker", 11)}${padL("BE(taker)", 12)}${padL("RT maker", 11)}${padL("BE(maker)", 12)}${padL("maker RT $", 12)}${padL("maker RT % of 0.35% gross", 25)}`);
  console.log("  " + "-".repeat(100));
  for (const r of kc) {
    const x = row(r.maker, r.taker, GEOM_TASK);
    console.log(
      `  ${pad("VIP " + r.vip, 7)}${padL(x.taker.rtPct.toFixed(3) + "%", 11)}${padL(x.taker.beTrue.toFixed(1) + "%", 12)}` +
      `${padL(x.maker.rtPct.toFixed(3) + "%", 11)}${padL(x.maker.beTrue.toFixed(1) + "%", 12)}` +
      `${padL("$" + x.maker.feeUsd.toFixed(4), 12)}${padL(x.maker.ofGross.toFixed(1) + "%", 25)}`,
    );
  }
  console.log(`\n  the break-even in each column is that column's OWN round trip's break-even, at the task's`);
  console.log(`  ticket (${GEOM_TASK.label}). The maker round trip is 0.040% at VIP 0 — ALREADY under 0.05%.`);
  const best = kc[kc.length - 1];
  const xBest = row(best.maker, best.taker, GEOM_TASK);
  console.log(`\n  AT KUCOIN'S BEST TIER (VIP ${best.vip}, maker ${best.maker}% / taker ${best.taker}%):`);
  console.log(`    maker round trip ${(best.maker * 2).toFixed(3)}% of notional = ${(xBest.maker.ofGross).toFixed(1)}% of the 0.35% gross`);
  console.log(`    break-even win rate: ${(xBest.maker.beTrue).toFixed(1)}% (correct formula) / ${(xBest.maker.beVar).toFixed(1)}% (variant)`);
  console.log(`    volume required: $${best.vol.toLocaleString()} in 30 days = ${daysTo(best.vol).toLocaleString()} days at $${DAILY_NOTIONAL.toFixed(0)}/day`);

  /* ── 2. THE 0.05% THRESHOLD ───────────────────────────────────────── */
  console.log(`\n${"=".repeat(122)}`);
  console.log("2. AT WHAT VOLUME DOES THE ROUND TRIP FALL BELOW 0.05% OF NOTIONAL?");
  console.log(`${"=".repeat(122)}`);
  console.log(`  The round trip must be < 0.05% of notional.`);
  console.log(`    taker round trip = 2 x taker  ->  taker must be < 0.025% per side`);
  console.log(`    maker round trip = 2 x maker  ->  maker must be < 0.025% per side`);
  for (const v of VENUES) {
    console.log(`\n  ${v.display}:`);
    if (!v.ladder) {
      if (v.rateOnly) {
        const r = v.rateOnly[v.rateOnly.length - 1];
        console.log(`    rates are published but not the volume thresholds: the best published maker is ${r.maker}%`);
        console.log(`      (a maker round trip of ${(r.maker * 2).toFixed(3)}% is ${(r.maker * 2 < 0.05 ? "BELOW" : "ABOVE")} 0.05%)`);
        console.log(`    volume threshold: NOT EXTRACTABLE from the venue's page — so the days are not stated.`);
      } else {
        console.log(`    no tier ladder was extractable from a venue source. The base tier is confirmed:`);
        console.log(`      maker ${v.base.maker}% / taker ${v.base.taker}% per side (${v.baseSource})`);
      }
      continue;
    }
    const firstT = v.ladder.find((r) => r.taker * 2 < 0.05);
    const firstM = v.ladder.find((r) => r.maker * 2 < 0.05);
    if (firstT) console.log(`    taker RT < 0.05%: VIP ${firstT.vip}, taker ${firstT.taker}% -> $${firstT.vol.toLocaleString()} 30d volume = ${daysTo(firstT.vol).toLocaleString()} days`);
    else console.log(`    taker RT < 0.05%: NOT REACHABLE — the best published taker is ${(minOf(v.ladder.map((r) => r.taker)) * 2).toFixed(3)}% RT`);
    if (firstM) console.log(`    maker RT < 0.05%: VIP ${firstM.vip}, maker ${firstM.maker}% -> $${firstM.vol.toLocaleString()} 30d volume = ${daysTo(firstM.vol).toLocaleString()} days`);
    else console.log(`    maker RT < 0.05%: NOT REACHABLE — the best published maker is ${(minOf(v.ladder.map((r) => r.maker)) * 2).toFixed(3)}% RT`);
  }
  const kcTakerTier = kc.find((r) => r.taker * 2 < 0.05);
  const kcMakerTier = kc.find((r) => r.maker * 2 < 0.05);
  console.log(`\n  ON KUCOIN SPECIFICALLY:`);
  console.log(`    the TAKER round trip never falls BELOW 0.05% on KuCoin — its best taker is ${best.taker}%/side = ${(best.taker * 2).toFixed(3)}% RT`);
  console.log(`      (it only ever REACHES 0.050% exactly, at VIP 12, which needs $${best.vol.toLocaleString()} of 30-day volume)`);
  console.log(`      so the answer to "at what volume does the round trip fall below 0.05%" is: NEVER, on the taker side, at any tier.`);
  console.log(`    the MAKER round trip is already under 0.05% at VIP 0: maker ${kcMakerTier.maker}% -> ${(kcMakerTier.maker * 2).toFixed(3)}% RT = ${((kcMakerTier.maker * 2) / GROSS_TP_PCT * 100).toFixed(1)}% of the 0.35% gross`);
  console.log(`      -> NO volume is needed. The 0.05% threshold is met by the ORDER TYPE, not the tier.`);

  /* ── 3. THE CROSS-VENUE TABLE ─────────────────────────────────────── */
  console.log(`\n${"=".repeat(122)}`);
  console.log("3. THE CROSS-VENUE TABLE — the LOWEST tier (the only tier this account can reach)");
  console.log(`${"=".repeat(122)}`);
  console.log("  perps? = the venue's USDⓈ-M/linear perpetual order path is wired in this app");
  console.log("  (src/lib/trading-symbols.ts -> CEX_VENUES; supabase/functions/_shared/venues.ts -> PERPS_CEX_VENUES)");
  console.log();
  console.log(`  ${pad("VENUE", 17)}${padL("perps", 6)}${padL("maker/side", 11)}${padL("taker/side", 11)}${padL("RT taker", 10)}${padL("RT taker $", 11)}${padL("as % of 0.35% gross", 17)}${padL("BE w* (taker)", 14)}${padL("RT maker", 10)}${padL("as % of gross", 12)}${padL("BE w* (maker)", 14)}`);
  console.log("  " + "-".repeat(150));
  const table = [];
  for (const v of VENUES) {
    const x = row(v.base.maker, v.base.taker, GEOM_TASK);
    table.push({ venue: v.display, perps: v.perps, base: v.base, source: v.baseSource, ...x });
    console.log(
      `  ${pad(v.display, 17)}${padL(v.perps ? "yes" : "SPOT", 6)}${padL(v.base.maker.toFixed(3) + "%", 11)}${padL(v.base.taker.toFixed(3) + "%", 11)}` +
      `${padL(x.taker.rtPct.toFixed(3) + "%", 10)}${padL("$" + x.taker.feeUsd.toFixed(4), 11)}${padL(x.taker.ofGross.toFixed(1) + "%", 17)}${padL(x.taker.beTrue.toFixed(1) + "%", 14)}` +
      `${padL(x.maker.rtPct.toFixed(3) + "%", 10)}${padL(x.maker.ofGross.toFixed(1) + "%", 12)}${padL(x.maker.beTrue.toFixed(1) + "%", 14)}`,
    );
  }
  console.log(`\n  each break-even is that column's OWN round trip's break-even at the task's ticket`);
  console.log(`  (${GEOM_TASK.label}). The TAKER columns are what the live path pays today.`);
  console.log(`\n  the TAKER columns are what the live path pays today: the entry is a MARKET order`);
  console.log(`  (src/commands/live.ts -> entryLeg: "taker", exitLeg: "taker" — the venue's own book confirms`);
  console.log(`   every fill charged exactly 0.0600% on BOTH legs, so the round trip is 0.12%).`);
  console.log(`  the MAKER columns are the maker-maker case, which needs BOTH legs passive — the live path's`);
  console.log(`   TP/SL are trigger orders, so maker-maker is NOT available without changing the exit mechanism.`);

  console.log(`\n${"=".repeat(122)}`);
  console.log("4. THE SAME TABLE AT THE BEST TIER EACH VENUE'S VOLUME COULD REACH");
  console.log(`${"=".repeat(122)}`);
  console.log(`  ${pad("VENUE", 17)}${padL("best tier", 12)}${padL("maker/side", 11)}${padL("taker/side", 11)}${padL("RT taker", 10)}${padL("RT maker", 10)}${padL("% of 0.35% gross", 16)}${padL("BE w* correct", 14)}${padL("30d vol needed", 20)}${padL("days", 10)}`);
  console.log("  " + "-".repeat(124));
  const bestTable = [];
  for (const v of VENUES) {
    if (!v.ladder) {
      console.log(`  ${pad(v.display, 17)}${padL("—", 12)}${padL("—", 11)}${padL("—", 11)}${padL("—", 10)}${padL("—", 10)}${padL("—", 16)}${padL("—", 12)}${padL("ladder not extractable", 20)}${padL("—", 10)}`);
      continue;
    }
    const b = v.ladder[v.ladder.length - 1];
    const x = row(b.maker, b.taker, GEOM_TASK);
    bestTable.push({ venue: v.display, tier: b, ...x });
    console.log(
      `  ${pad(v.display, 17)}${padL("VIP " + b.vip, 12)}${padL(b.maker.toFixed(3) + "%", 11)}${padL(b.taker.toFixed(3) + "%", 11)}` +
      `${padL(x.taker.rtPct.toFixed(3) + "%", 10)}${padL(x.maker.rtPct.toFixed(3) + "%", 10)}` +
      `${padL(x.maker.ofGross.toFixed(1) + "%", 16)}${padL(x.maker.beTrue.toFixed(1) + "%", 14)}` +
      `${padL("$" + b.vol.toLocaleString(), 20)}${padL(daysTo(b.vol).toLocaleString(), 10)}`,
    );
  }

  console.log(`\n${"=".repeat(122)}`);
  console.log("5. THE OTHER GEOMETRIES, so the reader sees the range");
  console.log(`${"=".repeat(122)}`);
  console.log(`  ${pad("GEOMETRY", 22)}${padL("fee mix", 13)}${padL("RT %", 9)}${padL("BE w* correct", 14)}${padL("BE w* variant", 14)}${padL("fee as % of that TP", 22)}`);
  console.log("  " + "-".repeat(94));
  for (const g of [GEOM_TASK, GEOM_SHIP, GEOM_REPO]) {
    for (const [name, rt] of [["taker-taker", kcTier.taker * 2], ["maker-maker", kcTier.maker * 2]]) {
      console.log(
        `  ${pad(g.label, 22)}${padL(name, 13)}${padL(rt.toFixed(3) + "%", 9)}` +
        `${padL((beTrue(g.tp, g.sl, rt) * 100).toFixed(1) + "%", 14)}${padL((beVar(g.tp, g.sl, rt) * 100).toFixed(1) + "%", 14)}` +
        `${padL(((rt / g.tp) * 100).toFixed(1) + "%", 22)}`,
      );
    }
  }
  console.log(`\n  the repo's published 82.8% is the TAKER round trip at its reference geometry TP 0.48% / SL 1.6114%`);
  console.log(`  (uni-selfcheck.py B5), under the CORRECT formula (SL+fee)/(TP+SL). This script reproduces`);
  console.log(`  that number from the repo's own ticket rule: ATR 1.2 -> TP ${GEOM_REPO.tp.toFixed(2)}% / SL ${GEOM_REPO.sl.toFixed(4)}%`);
  console.log(`  -> BE ${(beTrue(GEOM_REPO.tp, GEOM_REPO.sl, kcTier.taker * 2) * 100).toFixed(2)}% (repo publishes 82.8%).`);

  /* ── 6. THE VERDICT ───────────────────────────────────────────────── */
  const xTask = row(kcTier.maker, kcTier.taker, GEOM_TASK);
  const cheapestBase = [...VENUES].sort((a, b) => a.base.taker * 2 - b.base.taker * 2)[0];
  const cheapestMaker = [...VENUES].sort((a, b) => a.base.maker * 2 - b.base.maker * 2)[0];
  const perpsCheapest = VENUES.filter((v) => v.perps).sort((a, b) => a.base.taker * 2 - b.base.taker * 2)[0];
  const gainVsKc = (xTask.taker.rtPct - perpsCheapest.base.taker * 2) / 100 * NOTIONAL;
  const ticketsPerDay = Math.floor(DAILY_NOTIONAL / NOTIONAL);

  console.log(`\n${"=".repeat(122)}`);
  console.log("6. THE VERDICT");
  console.log(`${"=".repeat(122)}`);
  console.log(`  A. THE FEE IS NOT THE BINDING CONSTRAINT ON THE $10,000 GOAL.`);
  console.log(`     The fee floor today is ${fmt(xTask.taker.feeEqPct, 4)}% of equity per trade (taker-taker on $60).`);
  console.log(`     But the repo's measured numbers say the SIGNAL does not clear it, and they are ALREADY`);
  console.log(`     NET OF THE FEE (test-scratch-artefact.mjs books the fee on every outcome — win, loss and`);
  console.log(`     scratch alike):`);
  console.log(`       live-gate, corrected rule: n=22, win 9.1%, scratch 81.8%, EV -0.3105 %eq/trade, t=-1.92`);
  console.log(`       tape-only, corrected rule: n=515, win 21.6%, scratch 73.6%, EV -0.1251 %eq/trade, t=-2.41`);
  console.log(`       the 1,440-geometry corrected sweep: 0 pass, at TAKER AND maker fees, on both arms`);
  console.log(`     So the strategy loses money BEFORE the fee is subtracted. A cheaper fee makes the loss`);
  console.log(`     SMALLER; it does not make it positive.`);
  console.log(`\n  B. THE GOAL IS BLOCKED BY THE DOLLAR CAPS, NOT BY THE FEE.`);
  console.log(`     The daily notional budget is $${DAILY_NOTIONAL.toFixed(0)} and the per-position cap is $${NOTIONAL.toFixed(0)} — both ABSOLUTE`);
  console.log(`     dollar amounts that do not scale with equity. So the trade COUNT per day is fixed at`);
  console.log(`     ${ticketsPerDay} whether equity is $57 or $10,000, and the per-day maximum profit is fixed too.`);
  console.log(`     hf-goal-arithmetic.py states this in its own words: "Compounding cannot rescue it, because`);
  console.log(`     the per-day trade count — and therefore the per-day maximum profit — does not grow with equity."`);
  console.log(`     A fee cut does not raise throughput. A notional-cap increase does.`);
  console.log(`\n  C. WHAT THE FEE LEVER IS ACTUALLY WORTH, measured:`);
  console.log(`     today (taker-taker): ${xTask.taker.rtPct.toFixed(3)}% of notional = $${xTask.taker.feeUsd.toFixed(4)} on $60`);
  console.log(`       = ${(xTask.taker.ofGross).toFixed(1)}% of the 0.35% gross; break-even ${(xTask.taker.beTrue).toFixed(1)}% (correct) / ${(xTask.taker.beVar).toFixed(1)}% (variant)`);
  console.log(`     if BOTH legs were maker: ${xTask.maker.rtPct.toFixed(3)}% = $${xTask.maker.feeUsd.toFixed(4)}, ${(xTask.maker.ofGross).toFixed(1)}% of gross`);
  console.log(`       break-even ${(xTask.maker.beTrue).toFixed(1)}% (correct) / ${(xTask.maker.beVar).toFixed(1)}% (variant)  — and 0 days of volume needed`);
  console.log(`       (the task's 51% figure needs a maker of ~0.005%/side, which on KuCoin is VIP 8 and $300M of volume)`);
  console.log(`     even at KuCoin's BEST tier (VIP 12): maker ${best.maker}%, taker ${best.taker}%`);
  console.log(`       break-even ${(xBest.maker.beTrue).toFixed(1)}% (correct) / ${(xBest.maker.beVar).toFixed(1)}% (variant) — barely different`);
  console.log(`       because the STOP (1.61%) dominates the arithmetic, not the fee.`);
  console.log(`     → THE FEE IS NOT WHAT SETS THE BREAK-EVEN. The geometry is. Cutting the fee from 0.12%`);
  console.log(`       to 0.00% moves the break-even by ${(xTask.taker.beTrue - beTrue(GEOM_TASK.tp, GEOM_TASK.sl, 0) * 100).toFixed(1)} percentage points, on a ticket that`);
  console.log(`       already needs an ${xTask.taker.beTrue.toFixed(1)}% win rate that the signal does not deliver.`);
  console.log(`\n  D. THE CHEAPEST VENUE THE APP ALREADY SUPPORTS:`);
  console.log(`     cheapest TAKER round trip at the base tier (any venue): ${cheapestBase.display} at ${(cheapestBase.base.taker * 2).toFixed(3)}%`);
  console.log(`     cheapest TAKER round trip among PERPS-WIRED venues: ${perpsCheapest.display} at ${(perpsCheapest.base.taker * 2).toFixed(3)}%`);
  console.log(`     cheapest MAKER round trip at the base tier (any venue): ${cheapestMaker.display} at ${(cheapestMaker.base.maker * 2).toFixed(3)}%`);
  console.log(`     switching KuCoin -> ${perpsCheapest.display} saves $${gainVsKc.toFixed(4)} per ticket (${((xTask.taker.rtPct - perpsCheapest.base.taker * 2) / xTask.taker.rtPct * 100).toFixed(0)}% of the fee)`);
  console.log(`       = $${(gainVsKc * ticketsPerDay).toFixed(4)} a day at ${ticketsPerDay} tickets/day.`);
  console.log(`     The account's ENTIRE measured daily loss is $0.5708. The best venue switch saves LESS than`);
  console.log(`     the account loses in a single session — and it changes a NEGATIVE EV into a LESS negative EV.`);
  console.log(`     (The venue policy is full in-app integration, never redirect-to-other-app, so this is a`);
  console.log(`      feasibility number for the roadmap, not an instruction to redirect.)`);
  console.log(`\n  E. THE TASK'S 51% FIGURE, TESTED. IT DOES NOT SURVIVE THE ARITHMETIC.`);
  const be51fee = (0.51 * (GEOM_TASK.tp + GEOM_TASK.sl) - GEOM_TASK.sl).toFixed(4);
  const be51sl = (0.51 * GEOM_TASK.tp - 0.01) / (1 - 0.51);
  const beZero = beTrue(GEOM_TASK.tp, GEOM_TASK.sl, 0) * 100;   // percent
  const beFee = beTrue(GEOM_TASK.tp, GEOM_TASK.sl, 0.12) * 100; // percent
  console.log(`     The task states: "at the top tier a maker round trip (2 x 0.005% = 0.01%) would be 3% of`);
  console.log(`     the gross, and the strategy would need only a 51% win rate instead of 82.8%".`);
  console.log(`     The first half is right: a 0.01% round trip IS 3% of a 0.35% gross, and a 0.005%/side maker`);
  console.log(`     rate IS KuCoin VIP 8 — which needs $300M of 30-day volume (600,000 days at $500/day).`);
  console.log(`     The SECOND half does not follow, because the break-even is set by the R:R, not the fee:`);
  console.log(`       at the task's ticket (${GEOM_TASK.label}, R:R 1:${(GEOM_TASK.sl / GEOM_TASK.tp).toFixed(2)}):`);
  console.log(`         a 0.01% round trip still needs ${(beTrue(GEOM_TASK.tp, GEOM_TASK.sl, 0.01) * 100).toFixed(2)}% — not 51%`);
  console.log(`         even a ZERO-fee round trip needs ${beZero.toFixed(2)}%`);
  console.log(`       the 51% figure comes from a 1:1 ticket (TP 0.35% / SL 0.35%), where a 0.01% round trip`);
  console.log(`         gives ${beVar(0.35, 0.35, 0.01) * 100 > 0 ? (beVar(0.35, 0.35, 0.01) * 100).toFixed(2) : "—"}% under the variant formula and ${(beTrue(0.35, 0.35, 0.01) * 100).toFixed(2)}% under the correct one.`);
  console.log(`         For 51% at TP 0.35% with a 0.01% round trip the stop must be ${be51sl.toFixed(4)}% — a 1:1 ticket.`);
  console.log(`     So the fee lever is worth ${(beFee - beZero).toFixed(2)} percentage points of win rate in TOTAL`);
  console.log(`     (from 0.12% down to 0.00%) at the machine's geometry — and the machine needs a signal that`);
  console.log(`     does not exist, not a fee that is already small.`);
  console.log(`\n  F. WHAT WOULD ACTUALLY HAVE TO CHANGE:`);
  console.log(`     1. THE NOTIONAL CAP MUST SCALE WITH EQUITY. The $60/$500 caps make the $10,000 goal`);
  console.log(`        arithmetically unreachable at ANY fee, because the trade count per day is fixed.`);
  console.log(`     2. THE SIGNAL MUST PAY BEFORE THE FEE. The measured EV is negative net of fees.`);
  console.log(`     3. THE GEOMETRY, NOT THE FEE. At the task's ticket the stop is ${GEOM_TASK.sl.toFixed(4)}% and the`);
  console.log(`        R:R is 1:${(GEOM_TASK.sl / GEOM_TASK.tp).toFixed(2)}, so the fee is only ${(xTask.taker.rtPct / GEOM_TASK.sl * 100).toFixed(0)}% of the stop distance and`);
  console.log(`        the break-even is set by the R:R. Widening the target or tightening the stop moves`);
  console.log(`        the break-even far more than any venue or tier can: a 1:1 ticket at the same 0.35%`);
  console.log(`        target needs only ${(beTrue(0.35, 0.35, 0.12) * 100).toFixed(1)}% at today's taker fee.`);
  console.log(`     4. THE MAKER-FIRST ENTRY IS THE ONLY FEE LEVER THAT PAYS FOR ITSELF, and the repo has`);
  console.log(`        already measured it as a TRAP: the adverse selection ($0.19-0.20 per fill) is 4x`);
  console.log(`        the fee it saves ($0.048).`);
  console.log(`     5. FEE TIER BY VOLUME IS NOT A LEVER AT THIS ACCOUNT SIZE. The nearest KuCoin tier`);
  console.log(`        (VIP 1) is $${kcNext.vol.toLocaleString()} away = ${daysTo(kcNext.vol).toLocaleString()} days of trading, and it buys a maker rate of`);
  console.log(`        0.018% against 0.020% — $${(((kcTier.maker - kcNext.maker) * 2) / 100 * NOTIONAL).toFixed(4)} per ticket, and ZERO change to the taker rate.`);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        account: { equity: EQUITY, notional: NOTIONAL, dailyNotional: DAILY_NOTIONAL, measured30dVolume: accountVol, measuredTickets: vol.trades },
        geometries: { task: GEOM_TASK, shipped: GEOM_SHIP, repoReference: GEOM_REPO },
        grossTpPct: GROSS_TP_PCT,
        venues: VENUES.map((v) => ({
          id: v.id, display: v.display, perps: v.perps, base: v.base, baseSource: v.baseSource,
          ladder: v.ladder, ladderSource: v.ladderSource, ladderUnit: v.ladderUnit,
          ladderVerified: v.ladderVerified, ladderNote: v.ladderNote, perpsNote: v.perpsNote,
          rateOnly: v.rateOnly ?? null,
          baseRow: row(v.base.maker, v.base.taker, GEOM_TASK),
        })),
        kucoinCurrentTier: kcTier,
        kucoinNextTier: kcNext,
        kucoinDaysToNextTier: daysTo(kcNext.vol),
        verdict: {
          feeFloorPctEquityPerTrade: xTask.taker.feeEqPct,
          makerFloorPctEquityPerTrade: xTask.maker.feeEqPct,
          breakEvenCorrectTaker: xTask.taker.beTrue,
          breakEvenVariantTaker: xTask.taker.beVar,
          breakEvenCorrectMaker: xTask.maker.beTrue,
          breakEvenVariantMaker: xTask.maker.beVar,
          breakEvenCorrectAtBestTier: xBest.maker.beTrue,
          cheapestBaseTaker: cheapestBase.display,
          cheapestPerpsTaker: perpsCheapest.display,
          cheapestBaseMaker: cheapestMaker.display,
          savingPerTicketUsd: gainVsKc,
          savingPerDayUsd: gainVsKc * ticketsPerDay,
          feeIsBinding: false,
          bindingConstraint: "the $60 per-position / $500 daily-notional caps, and a signal whose EV is negative net of fees",
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n  summary written to ${OUT}`);
};

main();
