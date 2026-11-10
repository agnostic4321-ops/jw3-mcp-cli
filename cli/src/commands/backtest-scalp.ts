/**
 * `backtest scalp` — read-only. Replays fade-short/dip-long signals from
 * public KuCoin futures klines through the TP/kill ladder with fee math.
 * Prints win-rate, net, and a GO/NO-GO verdict. The GO bar is the
 * break-even win rate implied by the run's own TP/kill/fee geometry (the
 * higher of that and the 62% floor) — a fixed 62% threshold would admit
 * trades that are arithmetically a bleed. Never trades, needs no PAT.
 */
import {
  SCALP_MAKER_FEE_PCT,
  SCALP_TAKER_FEE_PCT,
  backtestScalp,
  futuresKlines,
  type ScalpBacktest,
} from "../kucoin.js";
import { fail } from "./market.js";

/** Pair like SOL/USDT → futures symbol; BTC aliases XBT (venue symbol). */
export function scalpSymbolForPair(pair: string): string | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return null;
  const base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (!base || quote !== "USDT" || /[^A-Z0-9]/.test(base)) return null;
  const venue = base === "BTC" ? "XBT" : base;
  return `${venue}USDTM`;
}

export function scalpFeeForFlag(flag: string | undefined): number | null {
  const f = (flag ?? "taker").toLowerCase();
  if (f === "maker") return SCALP_MAKER_FEE_PCT;
  if (f === "taker") return SCALP_TAKER_FEE_PCT;
  return null;
}

/** Injection seams (fixtures + golden tests; defaults are the venue + the wall clock). */
export type ReplayFetchDeps = {
  fetch?: (symbol: string, granularityMin: number, fromMs: number, toMs: number) => Promise<number[][]>;
  now?: () => number;
};

export async function cmdBacktestScalp(opts: {
  pair: string;
  days: number;
  tpPct?: number;
  fee: string;
  sizeUsd: number;
  json: boolean;
}, deps?: ReplayFetchDeps): Promise<void> {
  const symbol = scalpSymbolForPair(opts.pair);
  const feePerSide = scalpFeeForFlag(opts.fee);
  if (!symbol || !(opts.days > 0) || feePerSide == null || !(opts.sizeUsd > 0)) {
    console.error(
      "Usage: jw3 backtest scalp --pair SOL/USDT [--days 30] [--tp 0.3] [--fee maker|taker] [--size 60] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  if (opts.tpPct !== undefined && !(opts.tpPct > 0 && opts.tpPct <= 2)) {
    console.error(`Bad --tp: ${opts.tpPct} — want 0 < tp ≤ 2 (percent). Nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const days = Math.min(Math.round(opts.days), 90);
  const now = deps?.now?.() ?? Date.now();
  let rows: number[][];
  try {
    rows = await (deps?.fetch ?? futuresKlines)(symbol, 60, now - days * 86400 * 1000, now);
  } catch (e) {
    fail(e);
    return;
  }
  const klines = rows
    .map((k) => ({ open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }))
    .filter((k) => k.close > 0 && k.high >= k.low && Number.isFinite(k.volume));
  if (klines.length < 100) {
    console.error(`Only ${klines.length} hourly candles for ${symbol} — no backtest on thin history.`);
    process.exitCode = 1;
    return;
  }
  const r: ScalpBacktest | null = backtestScalp(klines, { tpPct: opts.tpPct, feePerSidePct: feePerSide });
  if (!r) {
    if (opts.json) {
      console.log(JSON.stringify({ pair: opts.pair, candles: klines.length, trades: 0, verdict: "NO-GO" }));
    } else {
      console.log(`BACKTEST SCALP ${opts.pair} — ${klines.length}×1h candles, no backtest on thin history. Verdict: NO-GO.`);
    }
    return;
  }
  if (r.trades.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({
        pair: opts.pair, symbol, candles: r.candles, hourly: true, days,
        signals: r.signals, trades: 0, verdict: "NO-GO",
        verdictConservative: r.verdictConservative,
        conditionalSignals: r.conditionalSignals, conditionalTrades: r.conditionalTrades,
        expectancyPctConditional: r.expectancyPctConditional,
        totalNetPctConditional: r.totalNetPctConditional,
        winRateConditional: r.winRateConditional,
        conditionalBySide: r.conditionalBySide,
      }));
      return;
    }
    // The unambiguous series can be empty while the conditional track has
    // trades — report the conditional, not a bare "no signals".
    const cb0 = r.conditionalBySide;
    console.log(
      `BACKTEST SCALP ${opts.pair} — ${klines.length}×1h candles, no UNAMBIGUOUS fade/dip bars. ` +
        `Verdict: NO-GO on the selected sample.`,
    );
    if (r.conditionalTrades > 0) {
      console.log(
        `  CONDITIONAL (every bar where the signal fired — ${r.conditionalTrades} trades from ${r.conditionalSignals} signals): ` +
          `WR ${r.winRateConditional.toFixed(1)}%  net ${r.totalNetPctConditional.toFixed(2)}%  ` +
          `expectancy ${r.expectancyPctConditional.toFixed(4)}%/trade`,
      );
      console.log(
        `    long  n=${cb0.long.trades} WR=${cb0.long.winRate.toFixed(1)}% expectancy ${cb0.long.expectancyPct.toFixed(4)}%/tr` +
          `   |   short n=${cb0.short.trades} WR=${cb0.short.winRate.toFixed(1)}% expectancy ${cb0.short.expectancyPct.toFixed(4)}%/tr`,
      );
    }
    return;
  }
  const netUsd = (r.totalNetPct / 100) * opts.sizeUsd;
  const tpLabel = r.tpPct != null ? `${r.tpPct.toFixed(2)}%` : "ATR 0.3–0.5%";
  if (opts.json) {
    console.log(JSON.stringify({
      pair: opts.pair, symbol, candles: r.candles, hourly: true, days,
      tpPct: r.tpPct, feePerSidePct: r.feePerSidePct, sizeUsd: opts.sizeUsd,
      signals: r.signals, trades: r.trades.length, wins: r.wins, losses: r.losses,
      winRate: r.winRate, totalGrossPct: r.totalGrossPct, totalNetPct: r.totalNetPct,
      netUsd, avgWinPct: r.avgWinPct, avgLossPct: r.avgLossPct,
      expectancyPct: r.expectancyPct, breakevenWr: r.breakevenWr,
      goThresholdWr: r.goBarWr, verdict: r.verdict,
      verdictConservative: r.verdictConservative, ambiguousTrades: r.ambiguousTrades,
      totalNetPctConservative: r.totalNetPctConservative,
      expectancyPctConservative: r.expectancyPctConservative,
      winRateConservative: r.winRateConservative,
      netUsdConservative: (r.totalNetPctConservative / 100) * opts.sizeUsd,
      conditionalSignals: r.conditionalSignals,
      conditionalTrades: r.conditionalTrades,
      expectancyPctConditional: r.expectancyPctConditional,
      totalNetPctConditional: r.totalNetPctConditional,
      winRateConditional: r.winRateConditional,
      conditionalBySide: r.conditionalBySide,
      netUsdConditional: (r.totalNetPctConditional / 100) * opts.sizeUsd,
      detail: r.trades,
    }));
    return;
  }
  const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
  console.log(`BACKTEST SCALP ${opts.pair} — ${r.candles}×1h candles, TP ${tpLabel}, kill ATR 0.6–1.5%, fee ${opts.fee} ${r.feePerSidePct}%/side, $${opts.sizeUsd}/trade`);
  console.log(`  signals ${r.signals} → trades ${r.trades.length} (${r.wins}W/${r.losses}L)  win-rate ${r.winRate.toFixed(1)}% (GO bar ${r.goBarWr.toFixed(1)}% = max(62% floor, break-even ${r.breakevenWr.toFixed(1)}%))`);
  console.log(`  gross ${f2(r.totalGrossPct)}%  net ${f2(r.totalNetPct)}% ≈ $${netUsd.toFixed(2)}  expectancy ${f2(r.expectancyPct)}%/trade`);
  console.log(`  avg win +${f2(r.avgWinPct)}%  avg loss ${f2(r.avgLossPct)}%  breakeven WR ${r.breakevenWr.toFixed(1)}%`);
  const longs = r.trades.filter((t) => t.direction === "long");
  const shorts = r.trades.filter((t) => t.direction === "short");
  const wr = (ts: { win: boolean }[]): string =>
    ts.length > 0 ? `${((ts.filter((t) => t.win).length / ts.length) * 100).toFixed(1)}% (${ts.length})` : "— (0)";
  console.log(`  dip-long ${wr(longs)}  fade-short ${wr(shorts)}`);
  console.log(`  Verdict: ${r.verdict}${r.verdict === "GO" ? " — edge clears fees at this size." : " — do not size this up."}`);
  if (r.ambiguousTrades > 0) {
    console.log(
      `  HONEST (intra-bar TP/kill ties charged as losses — ${r.ambiguousTrades} tie${r.ambiguousTrades === 1 ? "" : "s"}): ` +
        `WR ${r.winRateConservative.toFixed(1)}%  net ${f2(r.totalNetPctConservative)}% ≈ $${((r.totalNetPctConservative / 100) * opts.sizeUsd).toFixed(2)}  ` +
        `expectancy ${f2(r.expectancyPctConservative)}%/trade  → Verdict: ${r.verdictConservative}` +
        `${r.verdictConservative === "GO" ? "" : " — do not size this up."}`,
    );
  }
  // The HONEST CONDITIONAL is the number to size on: every bar where the
  // signal fired, traded in the signal's direction. The series above skips
  // the ambiguous bars (~91% of all triggered bars, because fadeSignal and
  // dipSignal both fire on the same faded-volume condition) — that is a
  // selected sample, and its edge does not transfer to live trading.
  const cb = r.conditionalBySide;
  console.log(
    `  CONDITIONAL (every bar where the signal fired — ${r.conditionalTrades} trades from ${r.conditionalSignals} signals): ` +
      `WR ${r.winRateConditional.toFixed(1)}%  net ${f2(r.totalNetPctConditional)}% ≈ $${((r.totalNetPctConditional / 100) * opts.sizeUsd).toFixed(2)}  ` +
      `expectancy ${f2(r.expectancyPctConditional)}%/trade`,
  );
  console.log(
    `    long  n=${cb.long.trades} WR=${cb.long.winRate.toFixed(1)}% expectancy ${f2(cb.long.expectancyPct)}%/tr` +
      `   |   short n=${cb.short.trades} WR=${cb.short.winRate.toFixed(1)}% expectancy ${f2(cb.short.expectancyPct)}%/tr`,
  );
  const sidePositive = cb.long.expectancyPct > 0 || cb.short.expectancyPct > 0;
  console.log(
    `  LIVE VERDICT: ${sidePositive && r.expectancyPctConditional > 0 ? "GO" : "NO-GO"}` +
      `${sidePositive && r.expectancyPctConditional > 0 ? "" : " — the signal does not clear fees when it actually fires; do not size this up."}`,
  );
  console.log("Model: 1h closes/highs/lows, one position at a time, TP wins intra-bar ties, timeout 24h, no spread/slippage beyond fees.");
}
