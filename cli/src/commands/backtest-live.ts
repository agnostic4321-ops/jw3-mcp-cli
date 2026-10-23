/**
 * `backtest live` — replay the LIVE execution path over historical candles.
 *
 * `backtest scalp` (see kucoin.ts) answers "does the signal have an edge".
 * THIS module answers the harder question: "does the edge survive what the
 * live path actually does when we trade it?" It replays the same objects the
 * live path uses — `planScalp` (TP + 1/1/2 step ladder + kill line),
 * `averagedEntry`/`averagedTpPrice` (the step-2 averaging math from degen.ts),
 * the blocking pre-filters (blocking-rules.ts) — over a candle series, and
 * charges the fees the venue charges.
 *
 * Model, per trade:
 *   ENTRY   three execution modes, because the fill is the edge:
 *            • maker — a limit rests at the touch and fills ONLY if the
 *              price trades THROUGH it inside the entry window.
 *            • chase — the resting limit re-prices to the new touch up to K
 *              times (chase.ts semantics: any touch move is a replace); when
 *              the budget is spent it crosses (cancel + market take).
 *            • taker — fills at the OPEN of the next bar.
 *   LADDER  step 1 at the touch, step 2 at the plan's averaging level
 *            (ATR*0.9 away), sizes per `planScalp`.
 *   TP      a venue-native take-profit that fills when the bar's range
 *            reaches it; the price is recomputed on the AVERAGED entry once
 *            step 2 fills.
 *   KILL    a stop that fills when the bar's range reaches it; the loss is
 *            sized on the AVERAGED entry, not on step 1.
 *   FEES    maker 0.02%/side on resting limits, taker 0.06%/side on market
 *            takes, charged on the LEVERAGED notional.
 *   FILTERS the live blocking rules (cpi_blackout → extended_drop →
 *            bounce_required → btc_fee) with a session context derived from
 *            the candles themselves.
 *   BOOK    one position at a time — no overlapping trades.
 *
 * Output: a per-trade ledger (entry time/price, fill type, exit time/price,
 * exit reason, fees, net P&L) plus aggregates (trades, WR, net%, expectancy
 * per trade, max drawdown) and the expectancy split by fill type — because a
 * strategy that only works when it fills as maker is not tradeable on a
 * chase.
 *
 * Every function here is PURE except `cmdBacktestLive`, the one that
 * fetches candles. Read-only: no auth, no PAT, no orders.
 */
import {
  SCALP_MAKER_FEE_PCT,
  SCALP_TAKER_FEE_PCT,
  dipSignal,
  fadeMetrics,
  fadeSignal,
  futuresKlines,
  planScalp,
  type FadeRow,
  type ScalpPlan,
} from "../kucoin.js";
import { averagedEntry, averagedTpPrice } from "./degen.js";
import { klinesSymbolForPair, klinesTfToMinutes, parseKlineRows } from "./klines.js";
import { precheck, type PrefilterRule, type PrefilterVerdict } from "../blocking-rules.js";
import { fail } from "./market.js";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** One OHLCV bar. `tsMs` is the bar OPEN time (venue kline column 0). */
export type LiveCandle = {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LiveEntryMode = "maker" | "chase" | "taker";
export type LiveFillType = "maker-fill" | "taker-fill";
export type LiveExitReason = "tp" | "kill" | "timeout";
export type LiveDirection = "long" | "short";

/** A signal the candidate edge produced on bar `index`. */
export type LiveSignal = LiveDirection | null;

/** Per-trade ledger row — one line of the backtest's story. */
export type LiveTradeRow = {
  index: number;
  mode: LiveEntryMode;
  direction: LiveDirection;
  signalIndex: number;
  signalTime: string;
  entryIndex: number;
  entryTime: string;
  entryPrice: number;
  /** How the ENTRY resolved — the fee tier it paid. */
  fillType: LiveFillType;
  /** Chase re-prices used before the entry filled (0 for maker/taker). */
  repices: number;
  /** Entry price vs the original touch, % (0 for an unfilled touch fill). */
  entrySlippagePct: number;
  stepsFilled: number;
  /** Size-weighted entry of the FILLED steps (the averaged entry). */
  avgEntry: number;
  /** TP in force at exit (recomputed on the averaged entry after step 2). */
  tpPrice: number;
  killPrice: number;
  /** The kill's dollar cost on the AVERAGED entry (null before any fill). */
  killLossUsd: number | null;
  exitIndex: number;
  exitTime: string;
  exitPrice: number;
  exitReason: LiveExitReason;
  /** The same bar touched the TP AND the kill — the order is unknowable. */
  ambiguousTie: boolean;
  /** Leveraged notional at risk (entry). */
  notionalUsd: number;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  /** netUsd as % of the leveraged notional at risk. */
  netPct: number;
  win: boolean;
};

/** A signal the blocking rules refused. */
export type LiveVeto = {
  index: number;
  time: string;
  side: LiveDirection;
  rule: PrefilterRule;
  detail: string;
};

/** Aggregate over a set of trades. */
export type LiveFillStats = {
  trades: number;
  wins: number;
  losses: number;
  /** % of trades with net P&L > 0. */
  winRate: number;
  /** Sum of the per-trade net % (each relative to its leveraged notional). */
  netPct: number;
  netUsd: number;
  /** Mean net P&L per trade (USD). */
  expectancyUsd: number;
  /** Mean net % per trade. */
  expectancyPctPerTrade: number;
};

/** Aggregate + risk + the tie-aware conservative read. */
export type LiveStats = LiveFillStats & {
  /** Peak-to-trough on the cumulative net-USD curve. */
  maxDrawdownUsd: number;
  /** Peak-to-trough on the cumulative net-% curve (sum of trade returns). */
  maxDrawdownPct: number;
  /** Trades whose bar touched both the TP and the kill. */
  ambiguousTies: number;
  /** Expectancy with every ambiguous tie charged as a loss. */
  conservativeExpectancyPct: number;
};

export type LiveBacktestOpts = {
  /** Which execution path to replay. "all" runs the three books side by side. */
  mode?: LiveEntryMode | "all";
  /** USD per unit step (planScalp's base size). */
  sizeUsd?: number;
  /** Account leverage — fees and P&L are charged on the leveraged notional. */
  leverage?: number;
  /** Venue symbol for the btc_fee veto (e.g. "SOLUSDTM"). */
  symbol?: string;
  /** Account size for the btc_fee veto (live reads JW3_ACCOUNT_USD). */
  accountUsd?: number;
  /** Better fee tier → the btc_fee veto is lifted (live: JW3_FEE_TIER_OK). */
  feeTierOk?: boolean;
  /** Bars the entry order may rest before it expires. */
  entryBars?: number;
  /** Chase re-prices allowed before the entry crosses (chase.ts --chase-max). */
  chaseMax?: number;
  /** Bars the position may hold before it is closed at the close. */
  maxHoldBars?: number;
  /** Lookback for the day-change leg (live oracle: 24h). */
  dayLookbackMs?: number;
  /** Lookback for the session-low leg (live oracle: 60min). */
  sessionLookbackMs?: number;
  /** The candidate edge. Default: the live exhaustion screen (fade/dip). */
  signal?: (candles: LiveCandle[], index: number, row: FadeRow | null) => LiveSignal;
};

export type LiveBacktest = {
  mode: LiveEntryMode | "all";
  candles: number;
  /** Signal opportunities that reached the gate. */
  signals: number;
  vetoes: LiveVeto[];
  /** Rules the session context could not evaluate (missing data → skipped). */
  unevaluated: Record<string, number>;
  trades: LiveTradeRow[];
  stats: LiveStats;
  /** Expectancy split by how the entry filled. */
  byFillType: Record<LiveFillType, LiveFillStats>;
  /**
   * Per-mode books — "all" runs three, one per execution path, each an
   * independent one-position-at-a-time book over the SAME signals. These
   * are the comparison: the same edge, filled as maker / as a chase / as
   * a taker. Their stats are NEVER summed (that would count one signal
   * three times).
   */
  books: Record<
    LiveEntryMode,
    { trades: number; signals: number; stats: LiveStats; byFillType: Record<LiveFillType, LiveFillStats> }
  >;
  /**
   * Which book's rows the top-level `trades`/`stats`/`byFillType` show.
   * In "all" mode this is the CHASE book — the live path's real entry
   * behaviour (chase.ts exists because a resting maker limit sits stale
   * while the touch runs away), and the one book that contains BOTH
   * maker-fills and taker-fills, which is what the fill split measures.
   */
  primaryMode: LiveEntryMode;
};

/* ------------------------------------------------------------------ */
/* defaults + session context                                         */
/* ------------------------------------------------------------------ */

/** Bars the entry order rests before it expires (no expiry in the live path). */
export const LIVE_DEFAULT_ENTRY_BARS = 2;
/** Chase re-prices before the entry crosses the spread. */
export const LIVE_DEFAULT_CHASE_MAX = 3;
/** Bars the position may hold before it is closed at the close. */
export const LIVE_DEFAULT_MAX_HOLD_BARS = 24;
/** Day-change lookback (mirrors the live oracle's 24h window). */
export const LIVE_DEFAULT_DAY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Session-low lookback (mirrors the live oracle's 60min window). */
export const LIVE_DEFAULT_SESSION_LOOKBACK_MS = 60 * 60 * 1000;
export const LIVE_DEFAULT_SIZE_USD = 60;
export const LIVE_DEFAULT_LEVERAGE = 2;

/**
 * Pure: the live exhaustion screen — the same classifiers `scan fade` and
 * the degen loop use (fadeSignal/dipSignal over the trailing 24 bars).
 *
 * Both classifiers fire on the SAME faded-volume condition (vratio < 0.85),
 * so most exhaustion bars are AMBIGUOUS — there is no decidable direction
 * and the bar is skipped. The live path resolves the direction with the
 * oracle (Kronos + Laya); the backtest cannot invent that vote, so the
 * ambiguous bars are left to the caller's own signal function.
 */
export function liveExhaustionSignal(row: FadeRow | null): LiveSignal {
  if (!row) return null;
  const s = fadeSignal(row);
  const d = dipSignal(row);
  if (s === "fade-short" && d !== "dip-long") return "short";
  if (d === "dip-long" && s !== "fade-short") return "long";
  return null;
}

/**
 * Pure: the fade/dip row at bar `index` (trailing 24 bars) — the same
 * window fadeMetrics uses live. Null when there is not enough history.
 */
export function liveRowAt(candles: LiveCandle[], index: number): FadeRow | null {
  if (index < 0 || index >= candles.length) return null;
  const from = Math.max(0, index - 23);
  const win = candles.slice(from, index + 1);
  if (win.length < 24) return null;
  const m = fadeMetrics(
    win.map((c) => c.close),
    win.map((c) => c.volume),
    win.map((c) => c.high),
    win.map((c) => c.low),
  );
  if (!m) return null;
  const last = win[win.length - 1]?.close ?? 0;
  if (!(last > 0)) return null;
  return { ...m, symbol: "", fundingPct: null, last };
}

/**
 * Pure: the ATR% at bar `index`, measured over the trailing bars with the
 * SAME true-range math `fadeMetrics` uses (so the backtest's step ladder
 * sits exactly where the live path would put it). Null when there is not
 * enough history to measure.
 */
export function liveAtrPctAt(candles: LiveCandle[], index: number, window = 15): number | null {
  if (index < 1 || index >= candles.length) return null;
  const from = Math.max(0, index - (window - 1));
  const win = candles.slice(from, index + 1);
  if (win.length < 3) return null;
  const trs: number[] = [];
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1]?.close ?? 0;
    trs.push(
      Math.max(
        (win[i]?.high ?? 0) - (win[i]?.low ?? 0),
        Math.abs((win[i]?.high ?? 0) - prev),
        Math.abs((win[i]?.low ?? 0) - prev),
      ),
    );
  }
  const last = win[win.length - 1]?.close ?? 0;
  if (!(last > 0) || trs.length === 0) return null;
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  if (!(atr > 0)) return null;
  return (atr / last) * 100;
}

/**
 * Pure: the session context the blocking rules need, derived from the
 * candles (same legs the live oracle fetches: a trailing day change and a
 * recent session low). Missing legs stay `undefined` so `precheck` marks
 * the data-dependent rules unevaluated instead of guessing.
 */
export function sessionContextAt(
  candles: LiveCandle[],
  index: number,
  opts: { dayLookbackMs?: number; sessionLookbackMs?: number } = {},
): { dayChgPct?: number; price?: number; sessionLow?: number } {
  const bar = candles[index];
  if (!bar) return {};
  const dayMs = opts.dayLookbackMs ?? LIVE_DEFAULT_DAY_LOOKBACK_MS;
  const sessMs = opts.sessionLookbackMs ?? LIVE_DEFAULT_SESSION_LOOKBACK_MS;
  const out: { dayChgPct?: number; price?: number; sessionLow?: number } = {};
  if (bar.close > 0) out.price = bar.close;
  const dayBars = candles.filter((c) => c.tsMs <= bar.tsMs && c.tsMs > bar.tsMs - dayMs);
  const first = dayBars[0];
  const lastDay = dayBars[dayBars.length - 1];
  if (first && lastDay && first.close > 0) {
    out.dayChgPct = ((lastDay.close - first.close) / first.close) * 100;
  }
  const sessBars = candles.filter((c) => c.tsMs <= bar.tsMs && c.tsMs > bar.tsMs - sessMs);
  const lows = sessBars.map((c) => c.low).filter((v) => Number.isFinite(v) && v > 0);
  if (lows.length > 0) out.sessionLow = Math.min(...lows);
  return out;
}

/**
 * Pure: the live gate. Runs the blocking pre-filters (cpi blackout,
 * extended-drop veto for shorts, bounce-required veto for shorts, btc fee
 * veto) with the candle-derived session context. Returns the live verdict —
 * `vetoed` + `rule` + `detail` + the rules that could not be evaluated.
 */
export function liveGate(
  symbol: string | undefined,
  side: LiveDirection,
  ctx: { dayChgPct?: number; price?: number; sessionLow?: number },
  opts: { nowMs: number; accountUsd?: number; feeTierOk?: boolean; notionalUsd?: number },
): PrefilterVerdict {
  return precheck({
    symbol,
    side,
    dayChgPct: ctx.dayChgPct,
    price: ctx.price,
    sessionLow: ctx.sessionLow,
    accountUsd: opts.accountUsd,
    feeTierOk: opts.feeTierOk,
    notionalUsd: opts.notionalUsd,
    nowMs: opts.nowMs,
  });
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

/** Pure: the price a maker limit rests at — the plan's step-1 (the touch). */
export function entryTouchFor(plan: ScalpPlan): number {
  const s1 = plan.steps[0];
  return s1 && s1.price > 0 ? s1.price : plan.last;
}

/** Pure: did the bar trade THROUGH the resting price? */
export function tradedThrough(direction: LiveDirection, bar: LiveCandle, price: number): boolean {
  if (!(price > 0)) return false;
  return direction === "long" ? bar.low <= price : bar.high >= price;
}

export type LiveEntryResult = {
  filled: boolean;
  entryIndex: number;
  entryPrice: number;
  fillType: LiveFillType;
  repices: number;
  /** True when the fill happened at the bar's OPEN (a market take). */
  fillAtOpen: boolean;
  reason: "filled" | "expired" | "no-next-bar";
};

/**
 * Pure: replay the ENTRY leg for one signal bar.
 *
 *  • maker — the limit rests at the touch; it fills only if the price
 *    trades THROUGH it inside the entry window (a resting order is never
 *    filled by a price that never came to it). When the window closes the
 *    order is still working and simply never filled.
 *  • chase — the same resting order, but every bar it does NOT fill, the
 *    touch is re-read at that bar's close and the order is re-priced to it
 *    (chase.ts replaces on ANY touch move), up to `chaseMax` re-prices.
 *    Once the re-price budget is spent the order RESTS (chase.ts keeps it
 *    working when `chases >= maxChases`). At the end of the window the
 *    chase budget is spent: the order is cancelled and either LEFT FLAT
 *    (chase.ts default) or TAKEN at the last close (chase.ts
 *    `--chase-take`) — a taker fill.
 *  • taker — fills at the OPEN of the next bar.
 */
export function simulateLiveEntry(
  candles: LiveCandle[],
  signalIndex: number,
  plan: ScalpPlan,
  mode: LiveEntryMode,
  opts: { entryBars?: number; chaseMax?: number; chaseTakes?: boolean } = {},
): LiveEntryResult {
  const n = candles.length;
  const dir = plan.direction;
  const entryBars = Math.max(1, Math.round(opts.entryBars ?? LIVE_DEFAULT_ENTRY_BARS));
  const chaseMax = Math.max(0, Math.round(opts.chaseMax ?? LIVE_DEFAULT_CHASE_MAX));
  const chaseTakes = opts.chaseTakes ?? true;
  const touch = entryTouchFor(plan);
  if (mode === "taker") {
    const j = signalIndex + 1;
    const open = candles[j]?.open ?? 0;
    if (j >= n || !(open > 0)) {
      return { filled: false, entryIndex: -1, entryPrice: 0, fillType: "taker-fill", repices: 0, fillAtOpen: false, reason: "no-next-bar" };
    }
    return { filled: true, entryIndex: j, entryPrice: open, fillType: "taker-fill", repices: 0, fillAtOpen: true, reason: "filled" };
  }
  let working = touch;
  let repices = 0;
  const last = Math.min(signalIndex + entryBars, n - 1);
  for (let j = signalIndex + 1; j <= last; j++) {
    const bar = candles[j];
    if (!bar) break;
    if (tradedThrough(dir, bar, working)) {
      return { filled: true, entryIndex: j, entryPrice: working, fillType: "maker-fill", repices, fillAtOpen: false, reason: "filled" };
    }
    if (mode !== "chase") continue;
    // The order did not fill — the touch moved to this bar's close.
    const newTouch = bar.close;
    if (!(newTouch > 0) || newTouch === working) continue;
    if (repices >= chaseMax) continue; // re-price budget spent — keep resting
    working = newTouch;
    repices++;
  }
  if (mode === "chase" && chaseTakes) {
    // The chase budget is spent: cancel the resting order and take the
    // market at the last close (chase.ts `--chase-take`).
    const close = candles[last]?.close ?? 0;
    if (last > signalIndex && close > 0) {
      return { filled: true, entryIndex: last, entryPrice: close, fillType: "taker-fill", repices, fillAtOpen: false, reason: "filled" };
    }
  }
  return { filled: false, entryIndex: -1, entryPrice: 0, fillType: "maker-fill", repices, fillAtOpen: false, reason: "expired" };
}

/* ------------------------------------------------------------------ */
/* position (step 2, TP, kill)                                        */
/* ------------------------------------------------------------------ */

export type LivePositionResult = {
  exitIndex: number;
  exitPrice: number;
  exitReason: LiveExitReason;
  stepsFilled: number;
  avgEntry: number;
  tpPrice: number;
  ambiguousTie: boolean;
};

/**
 * Pure: replay the POSITION leg — the step-2 averaging order, the
 * venue-native TP, and the kill stop.
 *
 * Bar order inside one bar (documented, because OHLC cannot say more):
 *   1. the step-2 resting order fills if the bar traded through it,
 *   2. the TP is recomputed on the new averaged entry — but the NEW TP is
 *      armed only from the NEXT bar: the re-arm is an action that lands
 *      after the fill, and a bar that reaches both the old and the new TP
 *      cannot say which came first. This bar is judged on the TP that was
 *      in force when it opened (the conservative read),
 *   3. the TP and the kill are checked; a bar that reaches BOTH resolves as
 *      a TP (live watch semantics: `classifyScalpMark` checks the TP first)
 *      and is FLAGGED ambiguous. An exit on the ENTRY bar is flagged too —
 *      the intra-bar order between the fill and the exit is unknowable.
 */
export function simulateLivePosition(
  candles: LiveCandle[],
  entryIndex: number,
  entryPrice: number,
  plan: ScalpPlan,
  opts: { maxHoldBars?: number } = {},
): LivePositionResult {
  const n = candles.length;
  const dir = plan.direction;
  const maxHold = Math.max(1, Math.round(opts.maxHoldBars ?? LIVE_DEFAULT_MAX_HOLD_BARS));
  const s1 = plan.steps[0];
  const s2 = plan.steps[1];
  const fills: { price: number; sizeUsd: number }[] = [
    { price: entryPrice, sizeUsd: s1?.sizeUsd ?? 0 },
  ];
  let step2Filled = false;
  let avg = averagedEntry(fills) ?? entryPrice;
  let tp = averagedTpPrice(avg, dir, plan.tpPct) ?? plan.tpPrice;
  const kill = plan.killPrice;
  const last = Math.min(entryIndex + maxHold, n - 1);
  for (let j = entryIndex; j <= last; j++) {
    const bar = candles[j];
    if (!bar) break;
    // The TP in force for THIS bar (the re-arm lands after the next fill).
    const tpInForce = tp;
    // The step-2 order is a RESTING LIMIT: if the bar's range reaches it,
    // it fills. The price has to pass through it on the way to the kill
    // line, so it fills BEFORE the stop can fire.
    if (!step2Filled && s2 && s2.price > 0) {
      if (tradedThrough(dir, bar, s2.price)) {
        step2Filled = true;
        fills.push({ price: s2.price, sizeUsd: s2.sizeUsd });
        avg = averagedEntry(fills) ?? avg;
        tp = averagedTpPrice(avg, dir, plan.tpPct) ?? tp;
      }
    }
    // The TP and the kill are both live orders. A bar whose range reaches
    // BOTH cannot say which came first → the TP wins (live watch
    // semantics) and the trade is FLAGGED ambiguous.
    const tpHit = dir === "long" ? bar.high >= tpInForce : bar.low <= tpInForce;
    const killHit = dir === "long" ? bar.low <= kill : bar.high >= kill;
    if (tpHit || killHit) {
      return {
        exitIndex: j,
        exitPrice: tpHit ? tpInForce : kill,
        exitReason: tpHit ? "tp" : "kill",
        stepsFilled: fills.length,
        avgEntry: avg,
        tpPrice: tpInForce,
        // Both lines reached → the intra-bar order is unknowable. An exit
        // on the entry bar is unknowable too: the fill and the exit share
        // one bar.
        ambiguousTie: (tpHit && killHit) || j === entryIndex,
      };
    }
  }
  const endBar = candles[last];
  return {
    exitIndex: last,
    exitPrice: endBar?.close ?? entryPrice,
    exitReason: "timeout",
    stepsFilled: fills.length,
    avgEntry: avg,
    tpPrice: tp,
    ambiguousTie: false,
  };
}

/* ------------------------------------------------------------------ */
/* pnl + fees                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pure: the position's cost basis over the FILLED steps.
 *
 * `avgEntry` is the LIVE path's averaged entry (the same `averagedEntry`
 * degen.ts uses to re-arm the TP), so the backtest and the live loop
 * average the same way. `qty` is the base-unit size the money is settled
 * on (quantity-weighted — the P&L and the fees are settled in units).
 */
export function livePositionBasis(fills: { price: number; sizeUsd: number }[]): {
  qty: number;
  avgEntry: number;
  sizeUsd: number;
} {
  let qty = 0;
  let sizeUsd = 0;
  for (const f of fills) {
    if (!(f.price > 0) || !(f.sizeUsd > 0)) continue;
    qty += f.sizeUsd / f.price;
    sizeUsd += f.sizeUsd;
  }
  const avgEntry = averagedEntry(fills) ?? 0;
  return { qty, avgEntry, sizeUsd };
}

/**
 * Pure: the dollar loss when a stop fills at `killPrice`, sized on the
 * AVERAGED position — every FILLED step is closed at the kill price, so
 * the loss covers the whole averaged book and never just step 1.
 * Null when the position is empty.
 */
export function liveKillLossUsd(
  fills: { price: number; sizeUsd: number }[],
  killPrice: number,
  direction: LiveDirection,
  leverage: number,
): number | null {
  if (!(killPrice > 0)) return null;
  const basis = livePositionBasis(fills);
  if (!(basis.qty > 0)) return null;
  const sign = direction === "long" ? 1 : -1;
  let loss = 0;
  for (const f of fills) {
    if (!(f.price > 0) || !(f.sizeUsd > 0)) continue;
    loss += (f.sizeUsd / f.price) * (killPrice - f.price) * sign * leverage;
  }
  return loss;
}

/**
 * Pure: the money. Fees are charged on the LEVERAGED notional
 * (maker 0.02%/side on resting limits, taker 0.06%/side on market takes);
 * P&L is the levered mark-to-market of the filled steps.
 */
export function liveTradeMoney(
  fills: { price: number; sizeUsd: number }[],
  exitPrice: number,
  direction: LiveDirection,
  leverage: number,
  entryFeePct: number,
  exitFeePct: number,
): { grossUsd: number; feesUsd: number; netUsd: number; notionalUsd: number } {
  const sign = direction === "long" ? 1 : -1;
  let gross = 0;
  let fees = 0;
  let notional = 0;
  for (const f of fills) {
    if (!(f.price > 0) || !(f.sizeUsd > 0)) continue;
    const qty = f.sizeUsd / f.price; // base units at the plan's USD size
    const entryNotional = qty * f.price * leverage;
    const exitNotional = qty * exitPrice * leverage;
    notional += entryNotional;
    fees += (entryNotional * entryFeePct) / 100;
    fees += (exitNotional * exitFeePct) / 100;
    gross += qty * (exitPrice - f.price) * sign * leverage;
  }
  return { grossUsd: gross, feesUsd: fees, netUsd: gross - fees, notionalUsd: notional };
}

/** Pure: the fee tier an entry paid. */
export function entryFeePctFor(fillType: LiveFillType): number {
  return fillType === "maker-fill" ? SCALP_MAKER_FEE_PCT : SCALP_TAKER_FEE_PCT;
}

/** Pure: the fee tier an exit paid — a resting TP is maker, a stop/close is taker. */
export function exitFeePctFor(reason: LiveExitReason): number {
  return reason === "tp" ? SCALP_MAKER_FEE_PCT : SCALP_TAKER_FEE_PCT;
}

/* ------------------------------------------------------------------ */
/* aggregates                                                          */
/* ------------------------------------------------------------------ */

/** Pure: aggregate a set of trades (the ledger's summary block). */
export function liveStatsFromTrades(trades: LiveTradeRow[]): LiveStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const netPct = trades.reduce((a, t) => a + t.netPct, 0);
  const netUsd = trades.reduce((a, t) => a + t.netUsd, 0);
  let eqUsd = 0;
  let peakUsd = 0;
  let ddUsd = 0;
  let eqPct = 0;
  let peakPct = 0;
  let ddPct = 0;
  for (const t of trades) {
    eqUsd += t.netUsd;
    if (eqUsd > peakUsd) peakUsd = eqUsd;
    ddUsd = Math.max(ddUsd, peakUsd - eqUsd);
    eqPct += t.netPct;
    if (eqPct > peakPct) peakPct = eqPct;
    ddPct = Math.max(ddPct, peakPct - eqPct);
  }
  const conservative = trades.reduce((a, t) => a + (t.ambiguousTie ? -Math.abs(t.netPct) : t.netPct), 0);
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    netPct,
    netUsd,
    expectancyUsd: n > 0 ? netUsd / n : 0,
    expectancyPctPerTrade: n > 0 ? netPct / n : 0,
    maxDrawdownUsd: ddUsd,
    maxDrawdownPct: ddPct,
    ambiguousTies: trades.filter((t) => t.ambiguousTie).length,
    conservativeExpectancyPct: n > 0 ? conservative / n : 0,
  };
}

/** Pure: the expectancy split by fill type — maker-fill vs taker-fill. */
export function liveByFillType(trades: LiveTradeRow[]): Record<LiveFillType, LiveFillStats> {
  const pick = (rows: LiveTradeRow[]): LiveFillStats => {
    const s = liveStatsFromTrades(rows);
    return {
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      winRate: s.winRate,
      netPct: s.netPct,
      netUsd: s.netUsd,
      expectancyUsd: s.expectancyUsd,
      expectancyPctPerTrade: s.expectancyPctPerTrade,
    };
  };
  return {
    "maker-fill": pick(trades.filter((t) => t.fillType === "maker-fill")),
    "taker-fill": pick(trades.filter((t) => t.fillType === "taker-fill")),
  };
}

/* ------------------------------------------------------------------ */
/* the book                                                            */
/* ------------------------------------------------------------------ */

type ResolvedOpts = {
  sizeUsd: number;
  leverage: number;
  symbol?: string;
  accountUsd?: number;
  feeTierOk?: boolean;
  entryBars: number;
  chaseMax: number;
  maxHoldBars: number;
  dayLookbackMs: number;
  sessionLookbackMs: number;
  signal: (candles: LiveCandle[], index: number, row: FadeRow | null) => LiveSignal;
};

function resolveOpts(opts: LiveBacktestOpts): ResolvedOpts {
  return {
    sizeUsd: opts.sizeUsd && opts.sizeUsd > 0 ? opts.sizeUsd : LIVE_DEFAULT_SIZE_USD,
    leverage: opts.leverage && opts.leverage > 0 ? opts.leverage : LIVE_DEFAULT_LEVERAGE,
    symbol: opts.symbol,
    accountUsd: opts.accountUsd,
    feeTierOk: opts.feeTierOk,
    entryBars: opts.entryBars != null ? Math.max(1, Math.round(opts.entryBars)) : LIVE_DEFAULT_ENTRY_BARS,
    chaseMax: opts.chaseMax != null ? Math.max(0, Math.round(opts.chaseMax)) : LIVE_DEFAULT_CHASE_MAX,
    maxHoldBars: opts.maxHoldBars != null ? Math.max(1, Math.round(opts.maxHoldBars)) : LIVE_DEFAULT_MAX_HOLD_BARS,
    dayLookbackMs: opts.dayLookbackMs ?? LIVE_DEFAULT_DAY_LOOKBACK_MS,
    sessionLookbackMs: opts.sessionLookbackMs ?? LIVE_DEFAULT_SESSION_LOOKBACK_MS,
    signal: opts.signal ?? ((_candles, _index, row) => liveExhaustionSignal(row)),
  };
}

type BookResult = {
  trades: LiveTradeRow[];
  signals: number;
  vetoes: LiveVeto[];
  unevaluated: Record<string, number>;
};

/** Pure: replay one book (one execution path) over the candles. */
export function runLiveBook(candles: LiveCandle[], mode: LiveEntryMode, opts: ResolvedOpts): BookResult {
  const trades: LiveTradeRow[] = [];
  const vetoes: LiveVeto[] = [];
  const unevaluated: Record<string, number> = {};
  let signals = 0;
  let i = 0;
  while (i < candles.length) {
    const row = liveRowAt(candles, i);
    // The candidate edge decides whether there IS a signal. It may look at
    // the whole tape, not only at the fade row — so it is called even when
    // the 24-bar fade window is too short to read a row.
    const side = opts.signal(candles, i, row);
    if (!side) {
      i++;
      continue;
    }
    signals++;
    // The plan comes from the tape: the mark is the signal bar's close and
    // the ATR% is measured over the trailing bars (the same fadeMetrics ATR
    // the live path feeds planScalp).
    const last = candles[i]?.close ?? 0;
    const atrPct = row?.atrPct ?? liveAtrPctAt(candles, i);
    const plan = planScalp(last, atrPct, side, opts.sizeUsd, 2);
    if (!plan) {
      i++;
      continue;
    }
    const bar = candles[i];
    const ctx = sessionContextAt(candles, i, opts);
    const gate = liveGate(opts.symbol, side, ctx, {
      nowMs: bar?.tsMs ?? Date.now(),
      accountUsd: opts.accountUsd,
      feeTierOk: opts.feeTierOk,
      notionalUsd: plan.maxCapitalUsd * opts.leverage,
    });
    for (const r of gate.unevaluated) unevaluated[r] = (unevaluated[r] ?? 0) + 1;
    if (gate.vetoed) {
      vetoes.push({
        index: i,
        time: new Date(bar?.tsMs ?? 0).toISOString(),
        side,
        rule: gate.rule ?? "cpi_blackout",
        detail: gate.detail,
      });
      i++;
      continue;
    }
    const entry = simulateLiveEntry(candles, i, plan, mode, opts);
    if (!entry.filled) {
      // The order expired unfilled — no trade, and the setup is stale now.
      i = Math.min(candles.length, i + opts.entryBars + 1);
      continue;
    }
    const pos = simulateLivePosition(candles, entry.entryIndex, entry.entryPrice, plan, opts);
    const fills = [{ price: entry.entryPrice, sizeUsd: plan.steps[0]?.sizeUsd ?? 0 }];
    if (pos.stepsFilled >= 2 && plan.steps[1]) fills.push({ price: plan.steps[1].price, sizeUsd: plan.steps[1].sizeUsd });
    const entryFee = entryFeePctFor(entry.fillType);
    const exitFee = exitFeePctFor(pos.exitReason);
    const money = liveTradeMoney(fills, pos.exitPrice, side, opts.leverage, entryFee, exitFee);
    const netPct = money.notionalUsd > 0 ? (money.netUsd / money.notionalUsd) * 100 : 0;
    const touch = entryTouchFor(plan);
    trades.push({
      index: trades.length,
      mode,
      direction: side,
      signalIndex: i,
      signalTime: new Date(bar?.tsMs ?? 0).toISOString(),
      entryIndex: entry.entryIndex,
      entryTime: new Date(candles[entry.entryIndex]?.tsMs ?? 0).toISOString(),
      entryPrice: entry.entryPrice,
      fillType: entry.fillType,
      repices: entry.repices,
      entrySlippagePct: touch > 0 ? ((entry.entryPrice - touch) / touch) * 100 : 0,
      stepsFilled: pos.stepsFilled,
      avgEntry: pos.avgEntry,
      tpPrice: pos.tpPrice,
      killPrice: plan.killPrice,
      /** The kill's dollar cost on the AVERAGED entry (null before any fill). */
      killLossUsd: liveKillLossUsd(fills, plan.killPrice, side, opts.leverage),
      exitIndex: pos.exitIndex,
      exitTime: new Date(candles[pos.exitIndex]?.tsMs ?? 0).toISOString(),
      exitPrice: pos.exitPrice,
      exitReason: pos.exitReason,
      ambiguousTie: pos.ambiguousTie,
      notionalUsd: money.notionalUsd,
      grossUsd: money.grossUsd,
      feesUsd: money.feesUsd,
      netUsd: money.netUsd,
      netPct,
      win: money.netUsd > 0,
    });
    i = pos.exitIndex + 1; // one position at a time — no overlapping trades
  }
  return { trades, signals, vetoes, unevaluated };
}

/**
 * Pure: the backtest. Replays the live execution path over the candles and
 * returns the per-trade ledger + the aggregates.
 *
 * `mode: "all"` runs the three execution paths as three separate books over
 * the SAME signals — that is the comparison that matters: the same edge,
 * filled as maker (resting at the touch), as a chase (re-priced, then
 * crossing), and as a taker (paying the spread). The combined
 * `byFillType` split answers "is this tradeable when it does not fill as
 * maker?".
 */
export function runLiveBacktest(candles: LiveCandle[], opts: LiveBacktestOpts = {}): LiveBacktest {
  const o = resolveOpts(opts);
  const modes: LiveEntryMode[] =
    opts.mode === "all" ? ["maker", "chase", "taker"] : [opts.mode ?? "maker"];
  const emptyBook = (): LiveBacktest["books"][LiveEntryMode] => ({
    trades: 0,
    signals: 0,
    stats: liveStatsFromTrades([]),
    byFillType: liveByFillType([]),
  });
  const books: LiveBacktest["books"] = { maker: emptyBook(), chase: emptyBook(), taker: emptyBook() };
  // The chase book is the live path's real entry behaviour and the one book
  // that holds both maker-fills and taker-fills — the fill split measures it.
  const primaryMode: LiveEntryMode = opts.mode === "all" ? "chase" : (opts.mode ?? "maker");
  const primaryTrades: LiveTradeRow[] = [];
  const vetoes: LiveVeto[] = [];
  const unevaluated: Record<string, number> = {};
  let signals = 0;
  for (const mode of modes) {
    const book = runLiveBook(candles, mode, o);
    books[mode] = {
      trades: book.trades.length,
      signals: book.signals,
      stats: liveStatsFromTrades(book.trades),
      byFillType: liveByFillType(book.trades),
    };
    if (mode === primaryMode) {
      primaryTrades.push(...book.trades);
      // The vetoes are a property of the SIGNAL, not of the execution path:
      // count them once, from the primary book.
      vetoes.push(...book.vetoes);
      for (const [k, v] of Object.entries(book.unevaluated)) unevaluated[k] = v;
    }
    signals = Math.max(signals, book.signals);
  }
  primaryTrades.forEach((t, i) => {
    t.index = i;
  });
  return {
    mode: opts.mode ?? "maker",
    primaryMode,
    candles: candles.length,
    signals,
    vetoes,
    unevaluated,
    trades: primaryTrades,
    stats: liveStatsFromTrades(primaryTrades),
    byFillType: liveByFillType(primaryTrades),
    books,
  };
}

/* ------------------------------------------------------------------ */
/* the command (the only impure function)                              */
/* ------------------------------------------------------------------ */

export type BacktestLiveArgs = {
  pair: string;
  days: number;
  tf: string;
  sizeUsd: number;
  leverage: number;
  mode: LiveEntryMode | "all";
  json: boolean;
};

export type BacktestLiveDeps = {
  /** Candle fetch (defaults to the venue's public klines). */
  fetch?: (symbol: string, granularityMin: number, fromMs: number, toMs: number) => Promise<number[][]>;
  now?: () => number;
};

/** Pure validation for the backtest ticket. Null = usable. */
export function validateBacktestLiveArgs(a: BacktestLiveArgs): string | null {
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  if (!klinesSymbolForPair(a.pair)) return `pair must be BASE/USDT (got ${JSON.stringify(a.pair)})`;
  if (!Number.isFinite(a.days) || !(a.days > 0)) return "days must be > 0";
  if (klinesTfToMinutes(a.tf) == null) return `tf must be one of 5m|15m|1h|1d (got ${JSON.stringify(a.tf)})`;
  if (!Number.isFinite(a.sizeUsd) || !(a.sizeUsd > 0)) return "size must be > 0 (USD per step)";
  if (!Number.isFinite(a.leverage) || !(a.leverage > 0)) return "leverage must be > 0";
  if (!["maker", "chase", "taker", "all"].includes(a.mode)) return "mode must be maker|chase|taker|all";
  return null;
}

/** Pure: venue kline rows → the candles the backtest replays. */
export function liveCandlesFromRows(rows: number[][]): LiveCandle[] {
  return parseKlineRows(rows).map((k) => ({
    tsMs: k.tsMs,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
  }));
}

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(6))));

/**
 * `jw3 backtest live` — READ-ONLY. Fetches candles, replays the live
 * execution path, prints the ledger and the aggregates. No PAT, no orders.
 */
export async function cmdBacktestLive(a: BacktestLiveArgs, deps?: BacktestLiveDeps): Promise<void> {
  const err = validateBacktestLiveArgs(a);
  if (err) {
    console.error(
      `Bad ticket: ${err}\nUsage: jw3 backtest live --pair SOL/USDT [--days 30] [--tf 15m] [--size 60] [--lev 2] [--mode maker|chase|taker|all] [--json]`,
    );
    process.exitCode = 2;
    return;
  }
  const symbol = klinesSymbolForPair(a.pair) as string;
  const granMin = klinesTfToMinutes(a.tf) as number;
  const now = deps?.now?.() ?? Date.now();
  const days = Math.min(Math.round(a.days), 90);
  const fromMs = now - days * 86400 * 1000;
  let rows: number[][];
  try {
    rows = await (deps?.fetch ?? futuresKlines)(symbol, granMin, fromMs, now);
  } catch (e) {
    fail(e);
    return;
  }
  const candles = liveCandlesFromRows(rows);
  if (candles.length < 30) {
    console.error(`Only ${candles.length} candles for ${symbol} — no backtest on thin history.`);
    process.exitCode = 1;
    return;
  }
  const r = runLiveBacktest(candles, {
    mode: a.mode,
    sizeUsd: a.sizeUsd,
    leverage: a.leverage,
    symbol,
  });
  if (a.json) {
    console.log(
      JSON.stringify(
        {
          pair: a.pair.toUpperCase(),
          symbol,
          tf: a.tf.toLowerCase(),
          granularityMin: granMin,
          days,
          candles: r.candles,
          mode: r.mode,
          primaryMode: r.primaryMode,
          sizeUsd: a.sizeUsd,
          leverage: a.leverage,
          fees: { makerPct: SCALP_MAKER_FEE_PCT, takerPct: SCALP_TAKER_FEE_PCT, chargedOn: "leveraged notional" },
          signals: r.signals,
          vetoes: r.vetoes,
          unevaluated: r.unevaluated,
          stats: r.stats,
          byFillType: r.byFillType,
          books: r.books,
          trades: r.trades,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `BACKTEST LIVE ${a.pair.toUpperCase()} — ${r.candles}×${a.tf} candles (${symbol}), $${a.sizeUsd}/step x${a.leverage} lev, fees ${SCALP_MAKER_FEE_PCT}% maker / ${SCALP_TAKER_FEE_PCT}% taker on leveraged notional`,
  );
  console.log(`  signals ${r.signals} · vetoed ${r.vetoes.length}${r.vetoes.length > 0 ? ` (${[...new Set(r.vetoes.map((v) => v.rule))].join(", ")})` : ""} · one position at a time`);
  const line = (label: string, s: LiveStats): void =>
    console.log(
      `  ${label.padEnd(11)} ${String(s.trades).padStart(3)} trades  WR ${s.winRate.toFixed(1)}%  net ${s.netPct.toFixed(3)}%  expectancy ${s.expectancyPctPerTrade.toFixed(4)}%/tr  maxDD ${s.maxDrawdownPct.toFixed(3)}%  ($${s.netUsd.toFixed(2)})`,
    );
  for (const mode of ["maker", "chase", "taker"] as LiveEntryMode[]) {
    const b = r.books[mode];
    if (b.trades === 0 && r.mode !== "all") continue;
    line(mode, b.stats);
  }
  console.log(
    `  fill split (${r.primaryMode} book) — maker-fill ${r.byFillType["maker-fill"].trades} trades WR ${r.byFillType["maker-fill"].winRate.toFixed(1)}% expectancy ${r.byFillType["maker-fill"].expectancyPctPerTrade.toFixed(4)}%/tr  |  taker-fill ${r.byFillType["taker-fill"].trades} trades WR ${r.byFillType["taker-fill"].winRate.toFixed(1)}% expectancy ${r.byFillType["taker-fill"].expectancyPctPerTrade.toFixed(4)}%/tr`,
  );
  console.log("  ledger:");
  for (const t of r.trades) {
    console.log(
      `    ${t.mode.padEnd(5)} ${t.direction.padEnd(5)} ${t.entryTime.slice(0, 16).replace("T", " ")} @ ${px(t.entryPrice)} [${t.fillType}${t.repices > 0 ? ` ×${t.repices}` : ""}] → ${t.exitTime.slice(0, 16).replace("T", " ")} @ ${px(t.exitPrice)} (${t.exitReason}${t.ambiguousTie ? ", tie" : ""})  fees $${t.feesUsd.toFixed(3)}  net $${t.netUsd.toFixed(3)} (${t.netPct.toFixed(3)}%)`,
    );
  }
  console.log(
    "Model: OHLC bars, maker fill only on a trade THROUGH the touch, chase re-prices to the new touch then crosses, taker at the next open; step-2 averaging at the plan level; TP on the averaged entry; kill on the averaged entry; one position at a time; no spread, slippage or funding beyond the fees.",
  );
}
