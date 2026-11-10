/**
 * `jw3 farm` — paper-trading strategy farm (READ-ONLY, no live trades).
 *
 * Runs N paper strategies (fade / momentum / breakout / funding-proxy)
 * over live public KuCoin futures klines through ONE shared TP/kill
 * replay harness (same semantics as `backtest scalp`: ATR-derived TP
 * 0.3–0.5%, kill 0.6–1.5%, timeout 24 bars, TP wins intra-bar ties,
 * one position at a time, flat %/side fees), prints a leaderboard
 * sorted by expectancy, and auto-promotes the winner to the live
 * candidate list when it clears the gate (expectancy > 0 AND n ≥ 15).
 *
 * No live trades by construction: the only network calls are public
 * kline GETs (`futuresKlines`). No PAT is read, no execute/set_exits/
 * close/cancel path is imported. `--live` / `--yes` are refused (exit 2)
 * so paper can never be one flag-flip away from real money.
 *
 * State (JW3_CONFIG_HOME override, else ~/.config/jw3):
 *   farm-latest.json          full leaderboard of the last run
 *   farm-live-candidates.json promoted winner (or empty + reason)
 */
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { configDir } from "../config.js";
import {
  SCALP_TAKER_FEE_PCT,
  dipSignal,
  fadeMetrics,
  fadeSignal,
  futuresKlines,
  type FadeRow,
  type ScalpBacktestTrade,
  type ScalpKline,
} from "../kucoin.js";
import { scalpFeeForFlag, scalpSymbolForPair, type ReplayFetchDeps } from "./backtest-scalp.js";
import { fail } from "./market.js";

export const FARM_STRATEGIES = ["fade", "momentum", "breakout", "funding"] as const;
export type FarmStrategy = (typeof FARM_STRATEGIES)[number];

/** Promotion gate: positive expectancy with a minimum sample. */
export const FARM_MIN_TRADES = 15;

export const FARM_DEFAULT_PAIRS = ["SOL/USDT", "BTC/USDT", "ETH/USDT"];

export function farmLatestPath(): string {
  return join(configDir(), "farm-latest.json");
}

export function farmCandidatesPath(): string {
  return join(configDir(), "farm-live-candidates.json");
}

/* ------------------------------------------------------------------ */
/* Signals — pure. Each answers direction at bar i (24-bar window).    */
/* ------------------------------------------------------------------ */

export type FarmSignalCtx = {
  /** fadeMetrics over closes[i-23..i] (null when the window is thin). */
  m: Omit<FadeRow, "fundingPct" | "last" | "symbol"> | null;
  last: number;
  closes: number[];
  highs: number[];
  lows: number[];
  vols: number[];
  i: number;
};

/** Exhaustion fade: short faded rallies, long faded selloffs (== backtest scalp). */
export function fadeFarmSignal(ctx: FarmSignalCtx): "long" | "short" | null {
  if (!ctx.m) return null;
  const row: FadeRow = { ...ctx.m, fundingPct: null, last: ctx.last, symbol: "" };
  const s = fadeSignal(row);
  const l = dipSignal(row);
  if (s === "fade-short" && l !== "dip-long") return "short";
  if (l === "dip-long" && s !== "fade-short") return "long";
  return null;
}

/** Trend continuation: 12h move > 1.5% with rising participation follows through. */
export function momentumFarmSignal(ctx: FarmSignalCtx): "long" | "short" | null {
  if (!ctx.m || ctx.i < 12) return null;
  const base = ctx.closes[ctx.i - 12];
  if (!(base! > 0) || !(ctx.last > 0)) return null;
  const chg12 = ((ctx.last - base!) / base!) * 100;
  if (chg12 > 1.5 && ctx.m.vratio > 1.2) return "long";
  if (chg12 < -1.5 && ctx.m.vratio > 1.2) return "short";
  return null;
}

/** Donchian breakout: close beyond the prior-24-bar extreme with participation. */
export function breakoutFarmSignal(ctx: FarmSignalCtx): "long" | "short" | null {
  if (!ctx.m || ctx.i < 24) return null;
  const priorHighs = ctx.highs.slice(ctx.i - 24, ctx.i);
  const priorLows = ctx.lows.slice(ctx.i - 24, ctx.i);
  if (priorHighs.length < 24 || priorLows.length < 24) return null;
  const hi = Math.max(...priorHighs);
  const lo = Math.min(...priorLows);
  if (!(hi > 0) || !(lo > 0) || !(ctx.last > 0)) return null;
  if (ctx.last > hi && ctx.m.vratio >= 1.0) return "long";
  if (ctx.last < lo && ctx.m.vratio >= 1.0) return "short";
  return null;
}

/**
 * Funding/crowding proxy: fade 24h overextensions beyond ±5% (the shape
 * crowded funding extremes precede). Stated limit: historical funding-rate
 * series are not on the public kline feed, so this backtests the price
 * proxy only — re-check the LIVE funding rate before sizing anything.
 */
export function fundingFarmSignal(ctx: FarmSignalCtx): "long" | "short" | null {
  if (!ctx.m) return null;
  if (ctx.m.chg > 5) return "short";
  if (ctx.m.chg < -5) return "long";
  return null;
}

export const FARM_SIGNALS: Record<FarmStrategy, (ctx: FarmSignalCtx) => "long" | "short" | null> = {
  fade: fadeFarmSignal,
  momentum: momentumFarmSignal,
  breakout: breakoutFarmSignal,
  funding: fundingFarmSignal,
};

/* ------------------------------------------------------------------ */
/* Shared replay — same TP/kill/timeout/fee model for every strategy.   */
/* ------------------------------------------------------------------ */

export type FarmReplay = {
  candles: number;
  signals: number;
  trades: ScalpBacktestTrade[];
  wins: number;
  losses: number;
  winRate: number;
  totalGrossPct: number;
  totalNetPct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  breakevenWr: number;
};

/** Pure: replay one signal fn through the TP/kill ladder. Null on thin history. */
export function replayFarmStrategy(
  klines: ScalpKline[],
  signal: (ctx: FarmSignalCtx) => "long" | "short" | null,
  opts: { feePerSidePct?: number; maxHold?: number } = {},
): FarmReplay | null {
  const n = klines.length;
  if (n < 25) return null;
  const fee = opts.feePerSidePct ?? SCALP_TAKER_FEE_PCT;
  const maxHold = Math.min(Math.max(Math.round(opts.maxHold ?? 24), 1), 240);
  const closes = klines.map((k) => k.close);
  const vols = klines.map((k) => k.volume);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const trades: ScalpBacktestTrade[] = [];
  let signals = 0;
  let i = 23;
  while (i < n - 1) {
    const m = fadeMetrics(
      closes.slice(i - 23, i + 1),
      vols.slice(i - 23, i + 1),
      highs.slice(i - 23, i + 1),
      lows.slice(i - 23, i + 1),
    );
    const last = closes[i]!;
    if (!m || !(last > 0)) {
      i++;
      continue;
    }
    const direction = signal({ m, last, closes, highs, lows, vols, i });
    if (!direction) {
      i++;
      continue;
    }
    signals++;
    const atr = m.atrPct != null && Number.isFinite(m.atrPct) && m.atrPct > 0 ? m.atrPct : 0.8;
    const tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
    const killPct = Math.min(1.5, Math.max(0.6, atr * 0.9));
    const tpDir = direction === "long" ? 1 : -1;
    const tpPrice = last * (1 + (tpDir * tpPct) / 100);
    const killPrice = last * (1 - (tpDir * killPct) / 100);
    let exit: "tp" | "kill" | "timeout" = "timeout";
    let exitPrice = klines[Math.min(i + maxHold, n - 1)]?.close ?? last;
    let end = Math.min(i + maxHold, n - 1);
    for (let j = i + 1; j <= Math.min(i + maxHold, n - 1); j++) {
      const bar = klines[j]!;
      const tpHit = direction === "long" ? bar.high >= tpPrice : bar.low <= tpPrice;
      const killHit = direction === "long" ? bar.low <= killPrice : bar.high >= killPrice;
      if (tpHit || killHit) {
        exit = tpHit ? "tp" : "kill"; // TP wins ties — live watch semantics
        exitPrice = exit === "tp" ? tpPrice : killPrice;
        end = j;
        break;
      }
      exitPrice = bar.close;
      end = j;
    }
    const grossPct = ((exitPrice - last) / last) * 100 * tpDir;
    const netPct = grossPct - 2 * fee;
    trades.push({ signalIndex: i, direction, entry: last, tpPrice, killPrice, exit, exitPrice, grossPct, netPct, win: netPct > 0 });
    i = end + 1; // one position at a time — no overlapping fills
  }
  const wins = trades.filter((t) => t.win).length;
  const losses = trades.length - wins;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const totalGrossPct = trades.reduce((a, t) => a + t.grossPct, 0);
  const totalNetPct = trades.reduce((a, t) => a + t.netPct, 0);
  const winNets = trades.filter((t) => t.win).map((t) => t.netPct);
  const lossNets = trades.filter((t) => !t.win).map((t) => t.netPct);
  const avgWinPct = winNets.length > 0 ? winNets.reduce((a, b) => a + b, 0) / winNets.length : 0;
  const avgLossPct = lossNets.length > 0 ? lossNets.reduce((a, b) => a + b, 0) / lossNets.length : 0;
  const expectancyPct = trades.length > 0 ? totalNetPct / trades.length : 0;
  const breakevenWr =
    avgWinPct > 0 && avgLossPct < 0 ? (Math.abs(avgLossPct) / (avgWinPct + Math.abs(avgLossPct))) * 100 : winRate;
  return { candles: n, signals, trades, wins, losses, winRate, totalGrossPct, totalNetPct, avgWinPct, avgLossPct, expectancyPct, breakevenWr };
}

/* ------------------------------------------------------------------ */
/* Leaderboard + promotion — pure.                                      */
/* ------------------------------------------------------------------ */

export type FarmRow = {
  strategy: FarmStrategy;
  pair: string;
  symbol: string;
  candles: number;
  signals: number;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  totalNetPct: number;
  expectancyPct: number;
  avgWinPct: number;
  avgLossPct: number;
  breakevenWr: number;
  meetsGate: boolean;
};

/** Sort key: expectancy desc. Pure. */
export function sortFarmLeaderboard(rows: FarmRow[]): FarmRow[] {
  return [...rows].sort((a, b) => b.expectancyPct - a.expectancyPct);
}

/** Winner = top-expectancy row clearing expectancy > 0 AND n ≥ 15. Null when none clears. */
export function pickFarmWinner(rows: FarmRow[]): FarmRow | null {
  const eligible = rows.filter((r) => r.expectancyPct > 0 && r.n >= FARM_MIN_TRADES);
  if (eligible.length === 0) return null;
  return sortFarmLeaderboard(eligible)[0] ?? null;
}

export function farmRowFor(
  strategy: FarmStrategy,
  pair: string,
  symbol: string,
  r: FarmReplay | null,
): FarmRow {
  if (!r) {
    return {
      strategy, pair, symbol, candles: 0, signals: 0, n: 0, wins: 0, losses: 0,
      winRate: 0, totalNetPct: 0, expectancyPct: 0, avgWinPct: 0, avgLossPct: 0,
      breakevenWr: 0, meetsGate: false,
    };
  }
  const n = r.trades.length;
  return {
    strategy, pair, symbol, candles: r.candles, signals: r.signals, n,
    wins: r.wins, losses: r.losses, winRate: r.winRate, totalNetPct: r.totalNetPct,
    expectancyPct: r.expectancyPct, avgWinPct: r.avgWinPct, avgLossPct: r.avgLossPct,
    breakevenWr: r.breakevenWr,
    meetsGate: r.expectancyPct > 0 && n >= FARM_MIN_TRADES,
  };
}

/* ------------------------------------------------------------------ */
/* Commands — network at the edges only (public klines).                */
/* ------------------------------------------------------------------ */

function parsePairs(raw: string | undefined): string[] | null {
  const list = (raw ?? FARM_DEFAULT_PAIRS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length > 10) return null;
  for (const p of list) {
    if (scalpSymbolForPair(p) == null) return null;
  }
  return list;
}

export async function cmdFarmRun(opts: {
  pairsRaw?: string;
  days: number;
  fee: string;
  sizeUsd: number;
  json: boolean;
}, deps?: ReplayFetchDeps): Promise<void> {
  const pairs = parsePairs(opts.pairsRaw);
  const feePerSide = scalpFeeForFlag(opts.fee);
  if (!pairs || !(opts.days > 0) || feePerSide == null || !(opts.sizeUsd > 0)) {
    console.error(
      "Usage: jw3 farm run [--pairs SOL/USDT,BTC/USDT,ETH/USDT] [--days 30] [--fee maker|taker] [--size 60] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  const days = Math.min(Math.round(opts.days), 90);
  const now = deps?.now?.() ?? Date.now();
  const rows: FarmRow[] = [];
  for (const pair of pairs) {
    const symbol = scalpSymbolForPair(pair)!;
    let raw: number[][];
    try {
      raw = await (deps?.fetch ?? futuresKlines)(symbol, 60, now - days * 86400 * 1000, now);
    } catch (e) {
      fail(e);
      return;
    }
    const klines: ScalpKline[] = raw
      .map((k) => ({ open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }))
      .filter((k) => k.close > 0 && k.high >= k.low && Number.isFinite(k.volume));
    if (klines.length < 100) {
      console.error(`Only ${klines.length} hourly candles for ${symbol} — skipped (thin history).`);
      continue;
    }
    for (const strategy of FARM_STRATEGIES) {
      const r = replayFarmStrategy(klines, FARM_SIGNALS[strategy], { feePerSidePct: feePerSide });
      rows.push(farmRowFor(strategy, pair, symbol, r));
    }
  }
  if (rows.length === 0) {
    console.error("No farm rows — all pairs skipped on thin history.");
    process.exitCode = 1;
    return;
  }
  const board = sortFarmLeaderboard(rows);
  const winner = pickFarmWinner(board);
  const backtestedAt = (deps?.now ? new Date(deps.now()) : new Date()).toISOString();
  const payload = {
    backtestedAt, days, feePerSidePct: feePerSide, sizeUsd: opts.sizeUsd,
    gate: { expectancyPctGt: 0, minTrades: FARM_MIN_TRADES },
    model: "1h closes/highs/lows, one position at a time, ATR TP 0.3-0.5% / kill 0.6-1.5%, TP wins ties, timeout 24h, no spread/slippage beyond fees. Funding leg is a price-overextension proxy, not a funding-rate series.",
    leaderboard: board,
    winner: winner ? { ...winner, netUsd: (winner.totalNetPct / 100) * opts.sizeUsd } : null,
  };
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(farmLatestPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
    const candidates = winner
      ? { updatedAt: backtestedAt, candidates: [{ ...winner, sizeUsd: opts.sizeUsd, note: "paper only — no live order. Re-check live funding + liquidity before sizing." }] }
      : { updatedAt: backtestedAt, candidates: [], reason: `no strategy cleared expectancy > 0 with n >= ${FARM_MIN_TRADES}` };
    writeFileSync(farmCandidatesPath(), JSON.stringify(candidates, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error(`Farm state write failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
  console.log(`FARM — ${pairs.join(", ")} — ${days}d ×1h, fee ${opts.fee} ${feePerSide}%/side, $${opts.sizeUsd}/trade`);
  for (const r of board) {
    const mark = r.meetsGate ? "✓" : " ";
    console.log(
      `  [${mark}] ${r.strategy.padEnd(8)} ${r.pair.padEnd(9)} n=${String(r.n).padStart(3)} WR ${r.winRate.toFixed(1).padStart(5)}% ` +
      `exp ${f2(r.expectancyPct)}%/t net ${f2(r.totalNetPct)}%`,
    );
  }
  if (winner) {
    console.log(
      `  Promoted to live candidates: ${winner.strategy} ${winner.pair} ` +
      `(exp ${f2(winner.expectancyPct)}%/t, n=${winner.n}, WR ${winner.winRate.toFixed(1)}%). Paper only — no live order.`,
    );
  } else {
    console.log(`  No promotion: nothing cleared expectancy > 0 with n >= ${FARM_MIN_TRADES}.`);
  }
}

export async function cmdFarmLeaderboard(opts: { json: boolean }): Promise<void> {
  let payload: {
    backtestedAt: string;
    leaderboard: FarmRow[];
    winner: (FarmRow & { netUsd: number }) | null;
  };
  try {
    if (!existsSync(farmLatestPath())) {
      console.error("No farm run yet — `jw3 farm run` first. Nothing was read.");
      process.exitCode = 1;
      return;
    }
    payload = JSON.parse(readFileSync(farmLatestPath(), "utf8")) as typeof payload;
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");
  console.log(`FARM LEADERBOARD — ran ${payload.backtestedAt}`);
  for (const r of payload.leaderboard) {
    const mark = r.meetsGate ? "✓" : " ";
    console.log(
      `  [${mark}] ${r.strategy.padEnd(8)} ${r.pair.padEnd(9)} n=${String(r.n).padStart(3)} WR ${r.winRate.toFixed(1).padStart(5)}% ` +
      `exp ${f2(r.expectancyPct)}%/t net ${f2(r.totalNetPct)}%`,
    );
  }
  if (payload.winner) {
    console.log(`  Live candidate: ${payload.winner.strategy} ${payload.winner.pair} (paper only — no live order).`);
  } else {
    console.log("  Live candidates: none.");
  }
}
