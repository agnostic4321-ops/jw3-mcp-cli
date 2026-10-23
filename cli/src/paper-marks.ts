/**
 * Paper mark-to-market + settlement engine — pure math, no IO, no network.
 *
 * Fees reuse the backtest schedule (KuCoin futures: maker 0.02% / taker
 * 0.06% per side) so paper costs match the `backtest scalp --fee`
 * assumptions. Importing the fee CONSTANTS is safe: they are plain
 * numbers, not fund-moving paths.
 */
import { SCALP_MAKER_FEE_PCT, SCALP_TAKER_FEE_PCT } from "./kucoin.js";
import type { PaperFeeTier, PaperFillKind, PaperPosition, PaperSide } from "./paper-store.js";

export { SCALP_MAKER_FEE_PCT, SCALP_TAKER_FEE_PCT };

/** Fee tier → fraction (0.02% = 0.0002). String = reject, number = usable. */
export function feeRateFor(tier: string): number | null {
  const t = tier.toLowerCase();
  if (t === "maker") return SCALP_MAKER_FEE_PCT / 100;
  if (t === "taker") return SCALP_TAKER_FEE_PCT / 100;
  return null;
}

/** Parse a --fee flag. Null = reject with usage (caller exits 2). */
export function feeTierForFlag(flag: string | undefined): PaperFeeTier | null {
  const t = (flag ?? "taker").toLowerCase();
  return t === "maker" || t === "taker" ? t : null;
}

/** Flat % fee on a notional, rounded to cents (never negative dust). */
export function paperFeeUsd(notionalUsd: number, tier: PaperFeeTier): number {
  const rate = feeRateFor(tier) ?? SCALP_TAKER_FEE_PCT / 100;
  const fee = notionalUsd * rate;
  return Math.max(0, Math.round(fee * 100) / 100);
}

/** Gross USD pnl of a position between two prices (fees excluded). */
export function grossPnlUsd(side: PaperSide, entry: number, exit: number, qty: number): number {
  return side === "long" ? (exit - entry) * qty : (entry - exit) * qty;
}

/** Unrealized gross USD pnl of an open position at a mark. */
export function unrealizedPnlUsd(pos: PaperPosition, markPrice: number): number {
  return grossPnlUsd(pos.side, pos.entryPrice, markPrice, pos.qty);
}

export type SettledLeg = {
  positionId: string;
  kind: Extract<PaperFillKind, "tp" | "sl">;
  /** Fill price = the leg level, not the tick that crossed it. */
  fillPrice: number;
};

/**
 * Pure: which open positions does a mark settle? TP fills when the mark
 * reaches the profit leg, SL when it reaches the loss leg. A single tick
 * crossing BOTH legs (gap through the whole range) settles at SL — the
 * conservative read: the stop would have traded first on the way through.
 * Matches at most one leg per position per tick.
 */
export function legsForMark(positions: PaperPosition[], markPrice: number): SettledLeg[] {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return [];
  const legs: SettledLeg[] = [];
  for (const p of positions) {
    const tpHit = p.tp != null && (p.side === "long" ? markPrice >= p.tp : markPrice <= p.tp);
    const slHit = p.sl != null && (p.side === "long" ? markPrice <= p.sl : markPrice >= p.sl);
    if (tpHit && slHit) {
      legs.push({ positionId: p.id, kind: "sl", fillPrice: p.sl as number });
    } else if (slHit) {
      legs.push({ positionId: p.id, kind: "sl", fillPrice: p.sl as number });
    } else if (tpHit) {
      legs.push({ positionId: p.id, kind: "tp", fillPrice: p.tp as number });
    }
  }
  return legs;
}

export type AccountSummary = {
  account: string;
  cashUsd: number;
  lockedMarginUsd: number;
  realizedPnlUsd: number;
  totalFeesUsd: number;
  openPositions: number;
  /** Gross unrealized at the given marks (0 for unmarked pairs). */
  unrealizedPnlUsd: number;
  /** cash + locked margin + unrealized gross. */
  equityUsd: number;
};

/**
 * Pure: one account's money story. Marks map normalized pair → price;
 * positions without a mark value at entry (unrealized 0), never at a
 * guessed price.
 */
export function summarizePaperAccount(
  account: string,
  cashUsd: number,
  realizedPnlUsd: number,
  totalFeesUsd: number,
  positions: PaperPosition[],
  marks?: Record<string, number>,
): AccountSummary {
  let locked = 0;
  let unrealized = 0;
  for (const p of positions) {
    locked += p.marginLockedUsd;
    const mark = marks?.[p.pair];
    unrealized += mark != null && Number.isFinite(mark) && mark > 0 ? unrealizedPnlUsd(p, mark) : 0;
  }
  return {
    account,
    cashUsd,
    lockedMarginUsd: locked,
    realizedPnlUsd,
    totalFeesUsd,
    openPositions: positions.length,
    unrealizedPnlUsd: unrealized,
    equityUsd: cashUsd + locked + unrealized,
  };
}
