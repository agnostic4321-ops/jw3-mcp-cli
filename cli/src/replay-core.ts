/**
 * THE REPLAY CORE (OQ-10) — candles in, fills/outcome out. Every
 * backtest / farm / replay engine in the CLI runs on it:
 *
 *   walkTape       the loop. One position at a time: a bar opens nothing
 *                  (read the next bar) or opens a position whose outcome
 *                  says which bar to read next — no overlapping fills.
 *                  `backtest live` drives it with its execution plugin
 *                  (maker / chase / taker entries, the two-step plan), so
 *                  entry mode is a parameter of the same walk.
 *   ladder*        the single-entry TP / kill / timeout ladder: geometry
 *                  from ATR, bar-by-bar resolution (TP wins an intra-bar
 *                  tie and the fill is flagged `ambiguous`), fee + net math,
 *                  and the per-trade statistics.
 *   replayLadder   the fade-window replay: trailing-24-bar fadeMetrics →
 *                  a STRATEGY PLUGIN → the ladder. Farm strategies are
 *                  plugins (commands/farm.ts); `backtest scalp` is a PRESET
 *                  (`backtestScalp`: the fade/dip plugin + its conservative
 *                  and conditional reads).
 *
 * Pure: no network, no clock, no files.
 */
import {
  SCALP_GO_WIN_RATE,
  SCALP_TAKER_FEE_PCT,
  dipSignal,
  fadeMetrics,
  fadeSignal,
  type FadeRow,
  type ScalpBacktest,
  type ScalpBacktestTrade,
  type ScalpKline,
} from "./kucoin.js";

export type ReplayDirection = "long" | "short";

/* ------------------------------------------------------------------ */
/* the walk                                                            */
/* ------------------------------------------------------------------ */

/**
 * The loop every engine shares. `step(i)` reads bar `i` and returns the
 * next bar to read (past the position it opened), or null to read `i + 1`.
 */
export function walkTape(start: number, end: number, step: (i: number) => number | null): void {
  let i = start;
  while (i < end) {
    const next = step(i);
    i = next === null ? i + 1 : next;
  }
}

/* ------------------------------------------------------------------ */
/* the single-entry ladder                                             */
/* ------------------------------------------------------------------ */

export type LadderGeometry = { tpPct: number; killPct: number };

/** Pure: TP / kill distances (percent) from ATR% — a fixed TP overrides the ATR one. */
export function ladderGeometry(atrPct: number | null | undefined, fixedTpPct: number | null = null): LadderGeometry {
  const atr = atrPct != null && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  return {
    tpPct: fixedTpPct ?? Math.min(0.5, Math.max(0.3, atr * 0.4)),
    killPct: Math.min(1.5, Math.max(0.6, atr * 0.9)),
  };
}

/** One resolved fill: the trade, plus the exit bar the walk resumes after. */
export type LadderFill = { trade: Required<ScalpBacktestTrade>; end: number };

/**
 * Pure: enter at bar `i`'s close in `direction`, then walk forward until the
 * TP, the kill or `maxHold` bars. A bar that touches BOTH levels cannot say
 * which came first: it resolves as the TP (live watch semantics) and the
 * fill is flagged `ambiguous` so a conservative read can charge it.
 */
export function resolveLadder(
  klines: ScalpKline[],
  i: number,
  direction: ReplayDirection,
  g: LadderGeometry,
  maxHold: number,
  feePerSidePct: number,
): LadderFill {
  const n = klines.length;
  const last = (klines[i] as ScalpKline).close;
  const tpDir = direction === "long" ? 1 : -1;
  const tpPrice = last * (1 + (tpDir * g.tpPct) / 100);
  const killPrice = last * (1 - (tpDir * g.killPct) / 100);
  let exit: "tp" | "kill" | "timeout" = "timeout";
  let exitPrice = klines[Math.min(i + maxHold, n - 1)]?.close ?? last;
  let end = Math.min(i + maxHold, n - 1);
  let ambiguous = false;
  for (let j = i + 1; j <= Math.min(i + maxHold, n - 1); j++) {
    const bar = klines[j] as ScalpKline;
    const tpHit = direction === "long" ? bar.high >= tpPrice : bar.low <= tpPrice;
    const killHit = direction === "long" ? bar.low <= killPrice : bar.high >= killPrice;
    if (tpHit && killHit) {
      ambiguous = true;
      exit = "tp";
      exitPrice = tpPrice;
      end = j;
      break;
    }
    if (tpHit || killHit) {
      exit = tpHit ? "tp" : "kill";
      exitPrice = exit === "tp" ? tpPrice : killPrice;
      end = j;
      break;
    }
    exitPrice = bar.close;
    end = j;
  }
  const grossPct = ((exitPrice - last) / last) * 100 * tpDir;
  const netPct = grossPct - 2 * feePerSidePct;
  return {
    trade: {
      signalIndex: i, direction, entry: last, tpPrice, killPrice,
      exit, exitPrice, grossPct, netPct, win: netPct > 0, ambiguous,
    },
    end,
  };
}

export type LadderStats = {
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

/** Pure: the per-trade statistics every ladder replay reports. */
export function ladderStats(trades: { grossPct: number; netPct: number; win: boolean }[]): LadderStats {
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
  return { wins, losses, winRate, totalGrossPct, totalNetPct, avgWinPct, avgLossPct, expectancyPct, breakevenWr };
}

/* ------------------------------------------------------------------ */
/* the fade-window replay + its strategy plugins                       */
/* ------------------------------------------------------------------ */

/** What a strategy plugin sees at bar `i`. */
export type ReplayCtx = {
  /** fadeMetrics over closes[i-23..i] (null when the window is thin). */
  m: Omit<FadeRow, "fundingPct" | "last" | "symbol"> | null;
  last: number;
  closes: number[];
  highs: number[];
  lows: number[];
  vols: number[];
  i: number;
};

/**
 * A strategy plugin. `signal`: the direction to trade at this bar, or null.
 * `sideTrack` (optional): the direction a REAL trade would take wherever
 * the setup fired — recorded on a side track even where `signal` declines;
 * when only the side track fires, the walk resumes after ITS exit (so the
 * side sample never overlaps itself).
 */
export type ReplayStrategy = {
  signal: (ctx: ReplayCtx) => ReplayDirection | null;
  sideTrack?: (ctx: ReplayCtx) => ReplayDirection | null;
};

export type LadderReplay = {
  candles: number;
  signals: number;
  trades: Required<ScalpBacktestTrade>[];
  sideSignals: number;
  sideTrades: Required<ScalpBacktestTrade>[];
};

/**
 * Pure: replay a strategy plugin over the tape through the ladder.
 * Trailing-24-bar windows, one position at a time.
 */
export function replayLadder(
  klines: ScalpKline[],
  strategy: ReplayStrategy,
  opts: { feePerSidePct: number; maxHold: number; fixedTpPct: number | null },
): LadderReplay {
  const n = klines.length;
  const closes = klines.map((k) => k.close);
  const vols = klines.map((k) => k.volume);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const trades: Required<ScalpBacktestTrade>[] = [];
  const sideTrades: Required<ScalpBacktestTrade>[] = [];
  let signals = 0;
  let sideSignals = 0;
  walkTape(23, n - 1, (i) => {
    const m = fadeMetrics(closes.slice(i - 23, i + 1), vols.slice(i - 23, i + 1), highs.slice(i - 23, i + 1), lows.slice(i - 23, i + 1));
    if (!m) return null;
    const last = closes[i] as number;
    if (!(last > 0)) return null;
    const ctx: ReplayCtx = { m, last, closes, highs, lows, vols, i };
    const direction = strategy.signal(ctx);
    const g = ladderGeometry(m.atrPct, opts.fixedTpPct);
    const side = strategy.sideTrack?.(ctx) ?? null;
    if (side) {
      sideSignals++;
      const f = resolveLadder(klines, i, side, g, opts.maxHold, opts.feePerSidePct);
      sideTrades.push(f.trade);
      if (!direction) return f.end + 1;
    }
    if (!direction) return null;
    signals++;
    const f = resolveLadder(klines, i, direction, g, opts.maxHold, opts.feePerSidePct);
    trades.push(f.trade);
    return f.end + 1;
  });
  return { candles: n, signals, trades, sideSignals, sideTrades };
}

/* ------------------------------------------------------------------ */
/* the `backtest scalp` preset                                         */
/* ------------------------------------------------------------------ */

const fadeDipRow = (ctx: ReplayCtx): FadeRow => ({ ...(ctx.m as NonNullable<ReplayCtx["m"]>), fundingPct: null, last: ctx.last, symbol: "" });

/**
 * The fade/dip plugin. `signal` trades only the UNAMBIGUOUS side —
 * fade-short (short) or dip-long (long), never a bar where both fire.
 *
 * HONEST-CONDITIONAL side track: `fadeSignal` and `dipSignal` fire on the
 * SAME faded-volume condition (vratio < 0.85), so they are ambiguous on
 * ~91% of all triggered bars (measured: 17,835 of 19,545 pooled across 32
 * contracts; 88.6-92.5% per the independent review in
 * docs/research/edge-review.md). Skipping them selects a tiny, favourable
 * sample and inflates the edge. A REAL trade fires whenever the signal
 * fires, so the side track measures exactly that: every bar where
 * fade-short fires (traded SHORT) and every bar where dip-long fires
 * (traded LONG); a bar where both fired is charged as a loss in the
 * conservative conditional.
 */
export const SCALP_FADE_DIP: ReplayStrategy = {
  signal: (ctx) => {
    const row = fadeDipRow(ctx);
    const sSig = fadeSignal(row);
    const lSig = dipSignal(row);
    return sSig === "fade-short" && lSig !== "dip-long" ? "short" : lSig === "dip-long" && sSig !== "fade-short" ? "long" : null;
  },
  sideTrack: (ctx) => {
    const row = fadeDipRow(ctx);
    const sSig = fadeSignal(row);
    const lSig = dipSignal(row);
    return sSig === "fade-short" ? "short" : lSig === "dip-long" ? "long" : null;
  },
};

/**
 * Pure: the `backtest scalp` preset — the fade/dip plugin through the
 * ladder, plus the GO bar, the conservative (ties-as-losses) read and the
 * honest conditional. Ambiguous bars (both signals) are skipped by the
 * main series — no invented edge. Returns null on thin history (< 25 bars).
 */
export function backtestScalp(
  klines: ScalpKline[],
  opts: { tpPct?: number; feePerSidePct?: number; maxHold?: number } = {},
): ScalpBacktest | null {
  const n = klines.length;
  if (n < 25) return null;
  const fee = opts.feePerSidePct ?? SCALP_TAKER_FEE_PCT;
  const maxHold = Math.min(Math.max(Math.round(opts.maxHold ?? 24), 1), 240);
  const fixedTp = opts.tpPct != null && Number.isFinite(opts.tpPct) && opts.tpPct > 0 ? opts.tpPct : null;
  const r = replayLadder(klines, SCALP_FADE_DIP, { feePerSidePct: fee, maxHold, fixedTpPct: fixedTp });
  const trades: ScalpBacktestTrade[] = r.trades;
  const { wins, losses, winRate, totalGrossPct, totalNetPct, avgWinPct, avgLossPct, expectancyPct, breakevenWr } = ladderStats(trades);
  // The GO bar is the break-even win rate implied by this run's ACTUAL
  // TP/kill/fee geometry — not a hardcoded number. With a 0.3% TP against
  // a 0.6% kill, break-even is ~80% (taker), so a 62% win rate is a
  // bleed dressed as a "GO". The floor still applies; the bar binds.
  const goBarWr = Math.max(SCALP_GO_WIN_RATE, breakevenWr);
  const verdict: "GO" | "NO-GO" = trades.length > 0 && winRate >= goBarWr && totalNetPct > 0 ? "GO" : "NO-GO";
  // Conservative series: every intra-bar TP/kill tie is charged as the
  // LOSS it might have been. A tie is unknowable from OHLC, and for a
  // fade the bar that spans both levels usually did the damage first.
  const ambiguousTrades = trades.filter((t) => t.ambiguous).length;
  const consNetOf = (t: ScalpBacktestTrade): number =>
    t.ambiguous ? -(Math.abs(t.netPct) + 2 * fee) : t.netPct;
  const totalNetPctConservative = trades.reduce((a, t) => a + consNetOf(t), 0);
  const consWins = trades.filter((t) => !t.ambiguous && t.win).length;
  const winRateConservative = trades.length > 0 ? (consWins / trades.length) * 100 : 0;
  const expectancyPctConservative = trades.length > 0 ? totalNetPctConservative / trades.length : 0;
  const verdictConservative: "GO" | "NO-GO" =
    trades.length > 0 && winRateConservative >= goBarWr && totalNetPctConservative > 0 ? "GO" : "NO-GO";
  // HONEST CONDITIONAL summary: every bar where the signal fired, traded in
  // the signal's own direction, with ambiguous ties charged as losses.
  const condTrades = r.sideTrades;
  const condNetOf = (t: { netPct: number; ambiguous?: boolean }): number =>
    t.ambiguous ? -(Math.abs(t.netPct) + 2 * fee) : t.netPct;
  const condNets = condTrades.map(condNetOf);
  const conditionalTrades = condTrades.length;
  const totalNetPctConditional = condNets.reduce((a, b) => a + b, 0);
  const expectancyPctConditional = conditionalTrades > 0 ? totalNetPctConditional / conditionalTrades : 0;
  const winRateConditional =
    conditionalTrades > 0 ? (condNets.filter((x) => x > 0).length / conditionalTrades) * 100 : 0;
  const sideStats = (dir: ReplayDirection): { trades: number; winRate: number; expectancyPct: number } => {
    const sel = condTrades.filter((t) => t.direction === dir);
    if (sel.length === 0) return { trades: 0, winRate: 0, expectancyPct: 0 };
    const nets = sel.map(condNetOf);
    const net = nets.reduce((a, b) => a + b, 0);
    return {
      trades: sel.length,
      winRate: (nets.filter((x) => x > 0).length / sel.length) * 100,
      expectancyPct: net / sel.length,
    };
  };
  return {
    candles: n, signals: r.signals, trades, wins, losses, winRate,
    tpPct: fixedTp, feePerSidePct: fee,
    totalGrossPct, totalNetPct, avgWinPct, avgLossPct,
    expectancyPct, breakevenWr, goBarWr, verdict,
    verdictConservative, ambiguousTrades,
    totalNetPctConservative, expectancyPctConservative, winRateConservative,
    conditionalSignals: r.sideSignals,
    conditionalTrades,
    expectancyPctConditional,
    totalNetPctConditional,
    winRateConditional,
    conditionalBySide: { long: sideStats("long"), short: sideStats("short") },
  };
}
