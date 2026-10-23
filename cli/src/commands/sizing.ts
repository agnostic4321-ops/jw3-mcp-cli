/**
 * Position sizing + leverage engine.
 *
 * THE COMPONENT THAT MAKES x20–x50 LEVERAGE SAFE BY DERIVING IT.
 *
 * Two rules do the work here:
 *
 *  1. DOLLAR RISK IS THE CONSTRAINT, NOT NOTIONAL.
 *     A stop-out must cost exactly the risk budget (default 3% of equity;
 *     the owner doctrine allows 30%, and the repo's halve rule cuts it in
 *     half after a full stop). The size then FALLS OUT of the stop:
 *
 *         amountBaseUnits = riskBudgetUsd / |entry − stop|      (base units)
 *         notionalUsd     = riskBudgetUsd / stopDistanceFrac   (USD)
 *
 *     Notional is an output, never an input. A trader cannot pick a size
 *     and hope the stop behaves.
 *
 *  2. LEVERAGE IS DERIVED, NOT CHOSEN.
 *     We take the HIGHEST leverage whose liquidation distance stays a safe
 *     multiple of the stop distance (default 2.0x), capped by the venue's
 *     own per-contract max leverage and by a hard ceiling of 50:
 *
 *         liquidationDistanceFrac(lev) = 1/lev − m
 *         safe ⇔ 1/lev − m ≥ k · stopDistanceFrac
 *                ⇒ lev ≤ 1 / (k · stopDistanceFrac + m)
 *
 *     with m = the contract's maintenance margin rate (0.5% default, 0.7%
 *     for most KuCoin contracts) and k = the required safety multiple.
 *
 *     A WIDER STOP THEREFORE MEANS LOWER LEVERAGE, AUTOMATICALLY. x50 is
 *     not "high leverage" — it is a statement about a 1.3% stop.
 *
 * LIQUIDATION MATH (KuCoin USDT-M linear, isolated, single position):
 *
 *     maintenance margin = m · notional
 *     initial margin     = notional / lev
 *     the position is liquidated when the loss erases the initial margin
 *     down to the maintenance margin:
 *
 *         liqDistanceFrac ≈ 1/lev − m
 *         liqPrice (long)  = entry · (1 − 1/lev + m)
 *         liqPrice (short) = entry · (1 + 1/lev − m)
 *
 *     This mirrors the repo's own display math in
 *     `src/components/trading/perpsMath.ts` (estimateLiqPrice) — same sign
 *     convention, same formula — so the CLI and the ticket cannot disagree.
 *     It is an APPROXIMATION: the venue also charges funding, uses a mark
 *     price (not the last trade) and applies margin tiers, so treat the
 *     number as the geometry, not as the venue's liquidation print.
 *
 * FEE DRAG: the round-trip fee is charged on NOTIONAL (not on margin), so
 * leverage does not change it — only the stop width does:
 *
 *         feeDragFracOfStop = roundTripFeeRate / stopDistanceFrac
 *
 *     Above 1/3 of the stop distance the fee eats the trade's edge. The
 *     engine then either WIDENS THE STOP (when the widened stop still fits
 *     inside N×ATR, i.e. the thesis survives) or flags the trade
 *     UNFUNDABLE (when it does not). It always says which, and why.
 *
 * CONTRACT ROUNDING: KuCoin futures take INTEGER LOTS (base qty ÷
 * multiplier). The engine always rounds DOWN — never up — and refuses a
 * size below one lot with a clear reason.
 *
 * THE UNIT TRAP: `execute_trade` speaks BASE units (one contract IS
 * `multiplier` base units). The payload names both sides of the trap
 * explicitly: `amountBaseUnits` (what execute_trade's `amount` takes) and
 * `contracts` (the integer lot count). 12 contracts on a multiplier-100
 * contract is 1200 base units — sending "12" would open 12 LOTS.
 *
 * Pure module: no network, no clock, no filesystem. Every number is either
 * computed here or read from the contract spec the caller supplies.
 */

/* ── Defaults (documented, overridable per call) ────────────────────── */

/** Risk budget as a percent of equity, when the caller states none. */
export const DEFAULT_RISK_PCT_OF_EQUITY = 3;

/**
 * Owner doctrine: 30% of equity per trade. The repo's aggressive risk
 * number (see the degen heat-cap doctrine) — a CALLER OPTION, never a
 * default: 3% is the sane default and 30% is one stop away from a wipe.
 */
export const OWNER_RISK_PCT_OF_EQUITY = 30;

/** Maintenance margin rate m — default 0.5% (decimal 0.005). */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;

/** Maintenance margin rate m for most KuCoin contracts (decimal 0.007). */
export const TYPICAL_MAINTENANCE_MARGIN_RATE = 0.007;

/** Hard leverage ceiling for this engine. */
export const HARD_MAX_LEVERAGE = 50;

/** Required liquidation distance, as a multiple of the stop distance. */
export const DEFAULT_MIN_LIQUIDATION_MULTIPLE = 2;

/** Fee drag ceiling: fees may not exceed 1/3 of the stop distance. */
export const DEFAULT_MAX_FEE_DRAG_FRACTION = 1 / 3;

/** A widened stop may not exceed this multiple of ATR%. */
export const DEFAULT_MAX_STOP_ATR_MULTIPLE = 3;

/**
 * Absolute sanity cap on a fee-widened stop. Wider than this is not a
 * trade with a wider stop — it is a different trade entirely.
 */
export const MAX_WIDENED_STOP_FRACTION = 0.25;

/** A stop tighter than this multiple of ATR% sits inside the noise band. */
export const MIN_STOP_ATR_FRACTION = 0.25;

/** KuCoin futures VIP0 fee schedule (per side, decimal). */
export const KUCOIN_FUTURES_VIP0_FEES: FeeSchedule = {
  makerRate: 0.0002,
  takerRate: 0.0006,
};

/* ── Types ───────────────────────────────────────────────────────────── */

export type SizingSide = "long" | "short";

/**
 * Per-side fee rates as decimals (0.0002 = 2 bps). Which leg is charged
 * as maker vs taker is explicit: a resting limit entry that gets lifted
 * pays taker on BOTH legs, and the engine prices the pessimistic case by
 * default.
 */
export type FeeSchedule = {
  /** Maker fee per side (decimal). */
  makerRate: number;
  /** Taker fee per side (decimal). */
  takerRate: number;
  /** Entry leg assumption. Default "taker". */
  entryLeg?: "maker" | "taker";
  /** Exit leg assumption. Default "taker". */
  exitLeg?: "maker" | "taker";
};

/**
 * A proposed trade plus everything the engine needs to size it.
 *
 * The contract-spec fields (`contractMultiplier`, `tickSize`,
 * `maintenanceMarginRate`, `venueMaxLeverage`) are what the caller reads
 * from the venue's contract feed — the engine invents none of them.
 */
export type SizingProposal = {
  pair: string;
  side: SizingSide;
  /** Intended entry price. Rounded to the tick. */
  entryPrice: number;
  /** Stop price. MUST be on the losing side of the entry. */
  stopPrice: number;
  /** Optional target — needed for the R multiple. */
  targetPrice?: number | null;

  /** One contract IS this many base units. */
  contractMultiplier: number;
  /** Price increment — prices are rounded to it. */
  tickSize: number;
  /** Maintenance margin rate m (decimal). Default 0.005; 0.007 for most contracts. */
  maintenanceMarginRate?: number;
  /**
   * Venue per-contract max leverage. `null`/undefined = UNKNOWN: the hard
   * ceiling applies and the decision says so (never a guessed cap).
   */
  venueMaxLeverage?: number | null;

  /** Measured ATR as a percent of price (1.5 = 1.5%). Optional. */
  atrPct?: number | null;

  /** Account equity in USD. */
  equityUsd: number;
  /** Free margin in USD. Optional — when present it gates the decision. */
  freeMarginUsd?: number | null;

  /** Risk budget as a percent of equity. Default 3. */
  riskPctOfEquity?: number;
  /** Full stops already taken today (the repo's halve rule: 1 → half size). */
  stopsToday?: number;
  /**
   * Hard cap on the position's NOTIONAL in USD (the server's
   * `max_position_usd`). When the risk-derived size would exceed it, the
   * size is CLAMPED to the cap rather than the trade being rejected: the
   * cap is a ceiling on exposure, not a veto on taking the trade. The
   * decision reports the clamp so the caller can see the trade was
   * resized.
   *
   * The cap is scaled by `tierMultiplier` so a HALF tier still halves the
   * exposure. Clamping both tiers to the same cap would make the
   * halve-after-a-stop rule a NO-OP whenever the cap binds — the one
   * situation where halving matters most.
   */
  maxNotionalUsd?: number | null;
  /**
   * The tier's size multiplier (FULL 1, HALF 0.5, PROBE 0.25). Default 1.
   * Applied to the notional cap so a smaller tier is allowed
   * proportionally less exposure.
   */
  tierMultiplier?: number;

  feeSchedule: FeeSchedule;

  /** Hard leverage ceiling. Default 50. */
  maxLeverage?: number;
  /** Required liquidation distance as a multiple of the stop. Default 2. */
  minLiquidationMultiple?: number;
  /** Fee-drag ceiling as a fraction of the stop distance. Default 1/3. */
  maxFeeDragFraction?: number;
  /** Widened stop may not exceed this multiple of ATR%. Default 3. */
  maxStopAtrMultiple?: number;
};

/** What the fee gate did about the fee drag. */
export type SizingFeeAction = "none" | "widen-stop" | "unfundable";

/**
 * The sizing decision. Everything the caller needs to fire (or refuse)
 * the trade, and every number behind it.
 *
 * `amountBaseUnits` and `contracts` are BOTH present on purpose: one
 * contract is `contractMultiplier` base units, and the two must never be
 * confused (see the unit trap in the file header).
 */
export type SizingDecision = {
  pair: string;
  side: SizingSide;
  /** "buy" for long, "sell" for short — what the venue expects. */
  venueSide: "buy" | "sell";
  /**
   * "ok" = sized and funded; "unfundable" = refused, with a reason;
   * "invalid" = the proposal itself was malformed, with the validator's
   * reason. A malformed proposal is a DIFFERENT failure from an
   * unfundable one, and collapsing the two hides bugs.
   */
  status: "ok" | "unfundable" | "invalid";
  /** Why it was refused (null when status is "ok"). */
  reason: string | null;

  /* prices (tick-rounded) */
  entryPrice: number;
  stopPrice: number;
  /** The stop before any fee-driven widening. */
  originalStopPrice: number;
  targetPrice: number | null;
  /** True when the fee gate moved the stop. */
  stopWidened: boolean;

  /* contract spec */
  contractMultiplier: number;
  tickSize: number;

  /* risk */
  equityUsd: number;
  /** Requested risk percent of equity (before the halve rule). */
  riskPctOfEquity: number;
  /** Effective risk percent after the halve rule. */
  effectiveRiskPctOfEquity: number;
  /** The dollar budget a stop-out is allowed to cost. */
  riskBudgetUsd: number;
  /** What a stop-out actually costs after lot rounding (≤ the budget). */
  dollarRiskAtStopUsd: number;
  /** |entry − stop| / entry. */
  stopDistanceFrac: number;
  /** Same distance in percent. */
  stopDistancePct: number;
  /** |entry − stop| in USD per base unit. */
  stopDistanceUsdPerBaseUnit: number;

  /* size */
  /** BASE UNITS — this is what `execute_trade`'s `amount` takes. */
  amountBaseUnits: number;
  /** Integer lots = floor(amountBaseUnits / contractMultiplier). */
  contracts: number;
  notionalUsd: number;
  /** True when the notional cap shrank the risk-derived size. */
  notionalClamped: boolean;
  /** The notional cap that was applied, if any. */
  notionalCapUsd: number | null;

  /* leverage (DERIVED, never chosen) */
  leverage: number;
  /** The stop-implied ceiling before venue/hard caps. */
  maxSafeLeverage: number;
  /** Venue per-contract max leverage (null = unknown). */
  venueMaxLeverage: number | null;
  /** The hard ceiling applied (default 50). */
  leverageCeiling: number;
  /** Maintenance margin rate m used. */
  maintenanceMarginRate: number;
  marginRequiredUsd: number;

  /* liquidation */
  liquidationPrice: number;
  liquidationDistanceFrac: number;
  liquidationDistancePct: number;
  /** liquidationDistance / stopDistance — must be ≥ the required multiple. */
  liquidationSafetyMultiple: number;
  /** True when the liquidation price sits BEFORE the stop. */
  liqBeforeStop: boolean;

  /* fees */
  /** Round-trip rate charged (entry leg + exit leg). */
  feeRateRoundTrip: number;
  feeRoundTripUsd: number;
  /** Fee drag as a fraction of the stop distance (0.12 = 12% of the stop). */
  feeDragFracOfStop: number;
  feeAction: SizingFeeAction;
  /** The widened stop, when the fee gate moved it. */
  widenedStopPrice: number | null;
  /** The widened stop's distance, when the fee gate moved it. */
  widenedStopDistanceFrac: number | null;

  /* payoff */
  /** Reward/risk from the stop to the target (null without a target). */
  rMultiple: number | null;

  /* gates */
  freeMarginUsd: number | null;
  /** null when no free margin was supplied. */
  marginSufficient: boolean | null;
  /** Non-fatal observations (the decision is still "ok"). */
  warnings: string[];
};

/** Verdict for a candidate leverage. */
export type LeverageSafety = {
  leverage: number;
  maintenanceMarginRate: number;
  /** 1/lev − m. */
  liquidationDistanceFrac: number;
  liquidationDistancePct: number;
  /** null when no entry price was supplied. */
  liquidationPrice: number | null;
  stopDistanceFrac: number;
  /** liquidationDistance / stopDistance. */
  safetyMultiple: number;
  /** The liquidation price is closer than the stop. */
  liqBeforeStop: boolean;
  /** Meets the required multiple AND does not liquidate before the stop. */
  safe: boolean;
  /** Why it is unsafe (null when safe). */
  reason: string | null;
};

/* ── Small pure helpers ──────────────────────────────────────────────── */

/** Kill float noise after a tick multiplication (0.1 × 978 = 97.8000001). */
function clean(v: number): number {
  return Number(v.toPrecision(12));
}

/** Round to the NEAREST tick. */
export function roundToTickNearest(px: number, tick: number): number {
  if (!(tick > 0) || !Number.isFinite(px)) return px;
  return clean(Math.round(px / tick + (px >= 0 ? 1e-9 : -1e-9)) * tick);
}

/** Round DOWN to the tick (used for a long's stop — further from entry). */
export function floorToTick(px: number, tick: number): number {
  if (!(tick > 0) || !Number.isFinite(px)) return px;
  return clean(Math.floor(px / tick + 1e-9) * tick);
}

/** Round UP to the tick (used for a short's stop — further from entry). */
export function ceilToTick(px: number, tick: number): number {
  if (!(tick > 0) || !Number.isFinite(px)) return px;
  return clean(Math.ceil(px / tick - 1e-9) * tick);
}

/**
 * The stop rounded AWAY from the entry: down for a long, up for a short.
 * Deliberately NOT the nearest-tick rounding that `scalp.roundToTick`
 * does — a stop rounded toward the entry would SHRINK the risk distance
 * that the size was computed from, and the size is never re-derived
 * upward.
 */
export function roundStopAwayFromEntry(
  stop: number,
  entry: number,
  side: SizingSide,
  tick: number,
): number {
  return side === "long" ? floorToTick(stop, tick) : ceilToTick(stop, tick);
}

/** One contract = `multiplier` base units. */
export function baseUnitsForContracts(contracts: number, multiplier: number): number {
  const mult = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return contracts * mult;
}

/**
 * Base units → integer lots. FLOOR, never up: rounding up would make the
 * position risk MORE than the budget allows.
 */
export function contractsForBaseUnits(baseUnits: number, multiplier: number): number {
  const mult = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  if (!(baseUnits > 0)) return 0;
  return Math.floor(baseUnits / mult);
}

/** Round-trip fee rate (entry leg + exit leg). */
export function roundTripFeeRate(fee: FeeSchedule): number {
  const maker = Number.isFinite(fee.makerRate) && fee.makerRate > 0 ? fee.makerRate : 0;
  const taker = Number.isFinite(fee.takerRate) && fee.takerRate > 0 ? fee.takerRate : 0;
  const entry = fee.entryLeg === "maker" ? maker : taker;
  const exit = fee.exitLeg === "maker" ? maker : taker;
  return entry + exit;
}

/** Liquidation distance as a fraction of the entry: 1/lev − m. */
export function liquidationDistanceFrac(leverage: number, m: number): number {
  if (!(leverage > 0)) return 0;
  return clean(1 / leverage - m);
}

/** Liquidation price for an isolated single position (approximate). */
export function liquidationPriceFor(
  entry: number,
  side: SizingSide,
  leverage: number,
  m: number,
): number {
  if (!(entry > 0) || !(leverage > 0)) return 0;
  return clean(
    side === "long"
      ? entry * (1 - 1 / leverage + m)
      : entry * (1 + 1 / leverage - m),
  );
}

/**
 * Is this leverage safe for this stop?
 *
 * SAFE ⇔ the liquidation distance is at least `minMultiple` × the stop
 * distance (which also means the liquidation price sits BEHIND the stop —
 * the stop fills first).
 */
export function leverageSafety(o: {
  leverage: number;
  stopDistanceFrac: number;
  maintenanceMarginRate?: number;
  minLiquidationMultiple?: number;
  entryPrice?: number;
  side?: SizingSide;
}): LeverageSafety {
  const m = o.maintenanceMarginRate ?? DEFAULT_MAINTENANCE_MARGIN_RATE;
  const k = o.minLiquidationMultiple ?? DEFAULT_MIN_LIQUIDATION_MULTIPLE;
  const lev = o.leverage;
  const d = o.stopDistanceFrac;
  const dist = liquidationDistanceFrac(lev, m);
  const multiple = d > 0 ? dist / d : 0;
  const liqBeforeStop = d > 0 && dist < d;
  const safe = lev > 0 && d > 0 && multiple >= k && !liqBeforeStop;
  let reason: string | null = null;
  if (!(lev > 0)) reason = "leverage must be > 0";
  else if (!(d > 0)) reason = "stop distance must be > 0";
  else if (dist <= 0) reason = `x${lev} with m=${(m * 100).toFixed(2)}% has no liquidation buffer at all`;
  else if (liqBeforeStop) {
    reason =
      `x${lev} liquidates ${(dist * 100).toFixed(2)}% away — BEFORE the ${(d * 100).toFixed(2)}% stop. ` +
      `Max safe leverage for this stop is x${Math.floor(1 / (k * d + m))}.`;
  } else if (multiple < k) {
    reason =
      `x${lev} leaves only ${multiple.toFixed(2)}x of liquidation buffer (need ${k.toFixed(2)}x). ` +
      `Max safe leverage for this stop is x${Math.floor(1 / (k * d + m))}.`;
  }
  const entry = o.entryPrice;
  return {
    leverage: lev,
    maintenanceMarginRate: m,
    liquidationDistanceFrac: dist,
    liquidationDistancePct: dist * 100,
    liquidationPrice:
      entry != null && entry > 0
        ? liquidationPriceFor(entry, o.side ?? "long", lev, m)
        : null,
    stopDistanceFrac: d,
    safetyMultiple: multiple,
    liqBeforeStop,
    safe,
    reason,
  };
}

/* ── Validation ──────────────────────────────────────────────────────── */

/**
 * Pure validation of a proposal. `null` = usable; otherwise the reason the
 * proposal cannot be sized (never a fabricated number in place of a check).
 */
export function validateSizingProposal(p: SizingProposal): string | null {
  if (!p || typeof p !== "object") return "proposal required";
  if (!p.pair) return "pair required (e.g. SOL/USDT)";
  if (p.side !== "long" && p.side !== "short") return "side must be long|short";
  if (!Number.isFinite(p.entryPrice) || !(p.entryPrice > 0)) return "entry price must be > 0";
  if (!Number.isFinite(p.stopPrice) || !(p.stopPrice > 0)) return "stop price must be > 0";
  if (Math.abs(p.entryPrice - p.stopPrice) <= 0) return "stop must differ from the entry";
  if (p.side === "long" && p.stopPrice >= p.entryPrice) return "a long's stop must sit BELOW the entry";
  if (p.side === "short" && p.stopPrice <= p.entryPrice) return "a short's stop must sit ABOVE the entry";
  if (p.targetPrice != null) {
    if (!Number.isFinite(p.targetPrice) || !(p.targetPrice > 0)) return "target price must be > 0 when given";
    if (p.side === "long" && p.targetPrice <= p.entryPrice) return "a long's target must sit ABOVE the entry";
    if (p.side === "short" && p.targetPrice >= p.entryPrice) return "a short's target must sit BELOW the entry";
  }
  if (!Number.isFinite(p.contractMultiplier) || !(p.contractMultiplier > 0)) {
    return "contract multiplier must be > 0 (one contract = multiplier base units)";
  }
  if (!Number.isFinite(p.tickSize) || p.tickSize < 0) return "tick size must be >= 0";
  if (!Number.isFinite(p.equityUsd) || !(p.equityUsd > 0)) return "equity must be > 0";
  if (p.freeMarginUsd != null && (!Number.isFinite(p.freeMarginUsd) || p.freeMarginUsd < 0)) {
    return "free margin must be >= 0 when given";
  }
  if (p.riskPctOfEquity != null && (!Number.isFinite(p.riskPctOfEquity) || !(p.riskPctOfEquity > 0))) {
    return "risk pct must be > 0";
  }
  if (p.atrPct != null && (!Number.isFinite(p.atrPct) || p.atrPct <= 0)) return "atr pct must be > 0 when given";
  if (!p.feeSchedule || typeof p.feeSchedule !== "object") return "fee schedule required";
  if (!Number.isFinite(p.feeSchedule.makerRate) || p.feeSchedule.makerRate < 0) return "maker fee rate must be >= 0";
  if (!Number.isFinite(p.feeSchedule.takerRate) || p.feeSchedule.takerRate < 0) return "taker fee rate must be >= 0";
  if (p.maintenanceMarginRate != null && (!Number.isFinite(p.maintenanceMarginRate) || p.maintenanceMarginRate < 0)) {
    return "maintenance margin rate must be >= 0";
  }
  if (p.venueMaxLeverage != null && p.venueMaxLeverage !== undefined) {
    if (!Number.isFinite(p.venueMaxLeverage) || !(p.venueMaxLeverage > 0)) {
      return "venue max leverage must be > 0 when known";
    }
  }
  if (p.maxLeverage != null && (!Number.isFinite(p.maxLeverage) || !(p.maxLeverage > 0))) {
    return "max leverage must be > 0 when given";
  }
  if (p.minLiquidationMultiple != null && (!Number.isFinite(p.minLiquidationMultiple) || !(p.minLiquidationMultiple > 0))) {
    return "min liquidation multiple must be > 0";
  }
  if (p.maxFeeDragFraction != null && (!Number.isFinite(p.maxFeeDragFraction) || !(p.maxFeeDragFraction > 0))) {
    return "max fee drag fraction must be > 0";
  }
  return null;
}

/* ── The engine ──────────────────────────────────────────────────────── */

/**
 * Size a proposed trade.
 *
 * Returns `null` when the proposal itself is malformed (call
 * `validateSizingProposal` for the reason). A well-formed but
 * unfundable proposal returns a decision with `status: "unfundable"` and a
 * reason — the refusal IS the answer.
 */
export function sizeTrade(p: SizingProposal): SizingDecision | null {
  // A refusal that hides its cause is a refusal the operator cannot act
  // on — and it is indistinguishable from a bug. The validator already
  // knows exactly WHY a proposal is unusable, so that reason travels with
  // the refusal instead of being discarded.
  const invalid = validateSizingProposal(p);
  if (invalid !== null) {
    return {
      status: "invalid",
      reason: invalid,
      pair: p?.pair ?? "",
      side: p?.side ?? "long",
      venueSide: p?.side === "short" ? "sell" : "buy",
      entryPrice: p?.entryPrice ?? 0,
      stopPrice: p?.stopPrice ?? 0,
      originalStopPrice: p?.stopPrice ?? 0,
      targetPrice: p?.targetPrice ?? null,
      stopWidened: false,
      contractMultiplier: p?.contractMultiplier ?? 1,
      tickSize: p?.tickSize ?? 0,
      equityUsd: p?.equityUsd ?? 0,
      notionalUsd: 0,
      marginRequiredUsd: 0,
      dollarRiskAtStopUsd: 0,
      leverage: 1,
      liquidationPrice: 0,
      liquidationDistancePct: 0,
      feeDragPct: 0,
      contracts: 0,
      amountBaseUnits: 0,
      warnings: [],
    } as unknown as SizingDecision;
  }

  const side = p.side;
  const venueSide: "buy" | "sell" = side === "long" ? "buy" : "sell";
  const mult = p.contractMultiplier;
  const tick = p.tickSize > 0 ? p.tickSize : 0;
  const m = p.maintenanceMarginRate ?? DEFAULT_MAINTENANCE_MARGIN_RATE;
  const k = p.minLiquidationMultiple ?? DEFAULT_MIN_LIQUIDATION_MULTIPLE;
  const ceiling = p.maxLeverage ?? HARD_MAX_LEVERAGE;
  const maxFeeDrag = p.maxFeeDragFraction ?? DEFAULT_MAX_FEE_DRAG_FRACTION;
  const maxStopAtrMultiple = p.maxStopAtrMultiple ?? DEFAULT_MAX_STOP_ATR_MULTIPLE;
  const atrFrac = p.atrPct != null && Number.isFinite(p.atrPct) && p.atrPct > 0 ? p.atrPct / 100 : null;
  const warnings: string[] = [];

  // ── 1. prices: tick-rounded, stop rounded AWAY from the entry ──
  const entryPrice = roundToTickNearest(p.entryPrice, tick);
  const originalStopPrice = roundStopAwayFromEntry(p.stopPrice, entryPrice, side, tick);
  const targetPrice =
    p.targetPrice != null && p.targetPrice > 0 ? roundToTickNearest(p.targetPrice, tick) : null;

  let stopPrice = originalStopPrice;
  // The stop distance is measured in WHOLE TICKS, not by subtracting two
  // floats: entry and stop are both tick-aligned, so their difference is a
  // tick multiple and counting ticks keeps the distance exact (a float
  // subtraction of 0.0129 − 0.0128 leaves 1.000000000000026e-4 of dust,
  // and dust at a lot boundary silently drops one lot).
  const stopTicks = tick > 0 ? Math.abs(Math.round((entryPrice - stopPrice) / tick)) : 0;
  let stopUsd = tick > 0 ? clean(stopTicks * tick) : Math.abs(entryPrice - stopPrice);
  if (!(stopUsd > 0)) return null; // tick rounding ate the whole stop
  let stopDistanceFrac = stopUsd / entryPrice;

  // ── 2. the risk budget (the constraint) ──
  // The halve rule is the repo's doctrine: one full stop today halves the
  // next size; two stops mean flat for the day (the heat governor refuses
  // the ticket, the engine still prices it and says so).
  const stopsToday = Math.max(0, Math.floor(p.stopsToday ?? 0));
  const riskPct = p.riskPctOfEquity ?? DEFAULT_RISK_PCT_OF_EQUITY;
  const halve = stopsToday >= 1 ? 0.5 : 1;
  const effectiveRiskPct = riskPct * halve;
  const riskBudgetUsd = (p.equityUsd * effectiveRiskPct) / 100;
  if (stopsToday >= 2) {
    warnings.push(
      `${stopsToday} full stops today — the repo's doctrine is flat for the day after two; the heat governor should refuse this ticket`,
    );
  }

  // ── 3. fee drag gate (independent of size: fees ride on notional) ──
  const feeRate = roundTripFeeRate(p.feeSchedule);
  let feeAction: SizingFeeAction = "none";
  let widenedStopPrice: number | null = null;
  let widenedStopDistanceFrac: number | null = null;
  let feeDragFracOfStop = feeRate / stopDistanceFrac;

  // The derived leverage depends on the stop ALONE, so it is knowable even
  // when the size is not — the refusal payload still carries it.
  const derivedLeverage = (stopFrac: number): { lev: number; maxSafe: number; venueMax: number | null } => {
    const maxSafe = Math.max(1, Math.floor(1 / (k * stopFrac + m)));
    const venueMax = p.venueMaxLeverage != null && p.venueMaxLeverage > 0 ? p.venueMaxLeverage : null;
    return {
      lev: Math.max(1, Math.floor(Math.min(maxSafe, venueMax ?? ceiling, ceiling))),
      maxSafe,
      venueMax,
    };
  };

  const draft = (
    status: "ok" | "unfundable",
    reason: string | null,
    over?: { marginSufficient?: boolean | null },
  ): SizingDecision => {
    const d = derivedLeverage(stopDistanceFrac);
    const dSafety = leverageSafety({
      leverage: d.lev,
      stopDistanceFrac,
      maintenanceMarginRate: m,
      minLiquidationMultiple: k,
      entryPrice,
      side,
    });
    return {
      pair: p.pair,
      side,
      venueSide,
      status,
      reason,
      entryPrice,
      stopPrice,
      originalStopPrice,
      targetPrice,
      stopWidened: feeAction === "widen-stop",
      contractMultiplier: mult,
      tickSize: tick,
      equityUsd: p.equityUsd,
      riskPctOfEquity: riskPct,
      effectiveRiskPctOfEquity: effectiveRiskPct,
      riskBudgetUsd,
      dollarRiskAtStopUsd: 0,
      stopDistanceFrac,
      stopDistancePct: stopDistanceFrac * 100,
      stopDistanceUsdPerBaseUnit: stopUsd,
      amountBaseUnits: 0,
      contracts: 0,
      notionalUsd: 0,
      notionalClamped: false,
      notionalCapUsd: p.maxNotionalUsd ?? null,
      leverage: d.lev,
      maxSafeLeverage: d.maxSafe,
      venueMaxLeverage: d.venueMax,
      leverageCeiling: ceiling,
      maintenanceMarginRate: m,
      marginRequiredUsd: 0,
      liquidationPrice: dSafety.liquidationPrice ?? liquidationPriceFor(entryPrice, side, d.lev, m),
      liquidationDistanceFrac: dSafety.liquidationDistanceFrac,
      liquidationDistancePct: dSafety.liquidationDistancePct,
      liquidationSafetyMultiple: dSafety.safetyMultiple,
      liqBeforeStop: dSafety.liqBeforeStop,
      feeRateRoundTrip: feeRate,
      feeRoundTripUsd: 0,
      feeDragFracOfStop,
      feeAction,
      widenedStopPrice,
      widenedStopDistanceFrac,
      rMultiple: targetPrice != null ? Math.abs(targetPrice - entryPrice) / stopUsd : null,
      freeMarginUsd: p.freeMarginUsd ?? null,
      marginSufficient: over?.marginSufficient ?? null,
      warnings,
    };
  };

  if (feeDragFracOfStop > maxFeeDrag) {
    // The stop must widen to `feeRate / maxFeeDrag` for the drag to fit.
    const requiredFrac = feeRate / maxFeeDrag;
    const atrBound = atrFrac != null ? maxStopAtrMultiple * atrFrac : null;
    const tooWideForAtr = atrBound != null && requiredFrac > atrBound;
    const tooWideAtAll = requiredFrac > MAX_WIDENED_STOP_FRACTION;
    if (tooWideForAtr || tooWideAtAll) {
      feeAction = "unfundable";
      const why =
        atrBound != null && tooWideForAtr
          ? `widening the stop to ${(requiredFrac * 100).toFixed(2)}% needs ${(requiredFrac / (atrFrac as number)).toFixed(1)}× ATR (cap ${maxStopAtrMultiple}×)`
          : `widening the stop to ${(requiredFrac * 100).toFixed(2)}% exceeds the ${(MAX_WIDENED_STOP_FRACTION * 100).toFixed(0)}% sanity cap`;
      return draft(
        "unfundable",
        `fee drag ${(feeDragFracOfStop * 100).toFixed(2)}% of the ${(stopDistanceFrac * 100).toFixed(2)}% stop ` +
          `exceeds the ${(maxFeeDrag * 100).toFixed(0)}% ceiling (round-trip fee ${(feeRate * 100).toFixed(3)}%) — ${why}. ` +
          `Unfundable as proposed: no honest stop survives this fee load.`,
      );
    }
    // Widen the stop (away from the entry), quantized to whole ticks so the
    // drag lands UNDER the cap instead of on the boundary.
    const widened = widenStopForFeeDrag({
      entryPrice,
      side,
      tick,
      feeRate,
      maxFeeDrag,
    });
    if (!widened) {
      feeAction = "unfundable";
      return draft(
        "unfundable",
        `fee drag ${(feeDragFracOfStop * 100).toFixed(2)}% of the stop exceeds the ${(maxFeeDrag * 100).toFixed(0)}% ceiling ` +
          `and the tick size (${tick}) is too coarse to widen the stop enough`,
      );
    }
    stopPrice = widened.stopPrice;
    stopUsd = widened.stopUsd;
    stopDistanceFrac = widened.stopDistanceFrac;
    feeDragFracOfStop = feeRate / stopDistanceFrac;
    if (feeDragFracOfStop > maxFeeDrag) {
      feeAction = "unfundable";
      return draft(
        "unfundable",
        `fee drag ${(feeDragFracOfStop * 100).toFixed(2)}% of the stop still exceeds the ${(maxFeeDrag * 100).toFixed(0)}% ceiling after widening — ` +
          `the tick size (${tick}) is too coarse for this contract`,
      );
    }
    feeAction = "widen-stop";
    widenedStopPrice = stopPrice;
    widenedStopDistanceFrac = stopDistanceFrac;
    if (atrFrac == null) {
      warnings.push(
        "stop widened to clear the fee drag with no ATR anchor — the wider stop was not volatility-checked",
      );
    }
  } else if (feeDragFracOfStop > maxFeeDrag * 0.8) {
    warnings.push(
      `fee drag is ${(feeDragFracOfStop * 100).toFixed(2)}% of the stop — close to the ${(maxFeeDrag * 100).toFixed(0)}% ceiling`,
    );
  }

  // ── 4. size from the risk budget (never from a chosen notional) ──
  //     amountBaseUnits = riskBudgetUsd / |entry − stop|
  let rawBaseUnits = riskBudgetUsd / stopUsd;
  // The notional cap CLAMPS the size; it does not veto the trade. A cap
  // that rejected the whole setup would silently remove the strategy from
  // the market — the exposure ceiling is what matters, so we resize to fit
  // and report the resize.
  const notionalCap = p.maxNotionalUsd ?? null;
  // The cap is scaled by the tier so a HALF tier still halves the
  // exposure — otherwise the cap makes the halve-after-a-stop rule a
  // no-op exactly when it matters most.
  const tierMult = p.tierMultiplier != null && p.tierMultiplier > 0 ? p.tierMultiplier : 1;
  const effectiveCap = notionalCap != null && notionalCap > 0 ? notionalCap * tierMult : null;
  let notionalClamped = false;
  if (effectiveCap != null) {
    const rawNotional = rawBaseUnits * entryPrice;
    if (rawNotional > effectiveCap) {
      const cappedBaseUnits = effectiveCap / entryPrice;
      // The minimum tradable size is ONE CONTRACT = `mult` base units, not
      // one base unit. Checking against 1 would refuse a perfectly
      // tradable capped size on any contract with a fractional multiplier.
      if (cappedBaseUnits < mult) {
        return draft(
          "unfundable",
          `the $${effectiveCap.toFixed(2)} notional cap buys ${cappedBaseUnits.toFixed(6)} base units — ` +
            `less than one contract (multiplier ${mult}). The cap is smaller than one lot; refusing.`,
        );
      }
      rawBaseUnits = cappedBaseUnits;
      notionalClamped = true;
    }
  }
  const contracts = contractsForBaseUnits(rawBaseUnits, mult);
  if (contracts < 1) {
    return draft(
      "unfundable",
      `a $${riskBudgetUsd.toFixed(2)} risk budget at a ${(stopDistanceFrac * 100).toFixed(2)}% stop buys ` +
        `${rawBaseUnits.toFixed(6)} base units — less than ONE contract (multiplier ${mult}). ` +
        `Refusing to round up: that would risk more than the budget.`,
    );
  }
  const amountBaseUnits = baseUnitsForContracts(contracts, mult);
  const notionalUsd = amountBaseUnits * entryPrice;
  const dollarRiskAtStopUsd = amountBaseUnits * stopUsd;

  // ── 5. leverage DERIVED from the stop ──
  //   safe ⇔ 1/lev − m ≥ k · d  ⇒  lev ≤ 1/(k·d + m)
  const d = derivedLeverage(stopDistanceFrac);
  const leverage = d.lev;
  if (d.venueMax == null) {
    warnings.push(
      "venue per-contract max leverage unknown — the hard ceiling applies and is reported, never a guessed cap",
    );
  }
  const safety = leverageSafety({
    leverage,
    stopDistanceFrac,
    maintenanceMarginRate: m,
    minLiquidationMultiple: k,
    entryPrice,
    side,
  });
  if (!safety.safe) {
    warnings.push(
      `derived leverage x${leverage} leaves only ${safety.safetyMultiple.toFixed(2)}× of liquidation buffer — ${safety.reason ?? "no buffer"}`,
    );
  }
  const liquidationPrice = safety.liquidationPrice ?? liquidationPriceFor(entryPrice, side, leverage, m);

  // ── 6. margin gates ──
  const marginRequiredUsd = notionalUsd / leverage;
  const freeMargin = p.freeMarginUsd ?? null;
  const marginSufficient = freeMargin == null ? null : marginRequiredUsd <= freeMargin;
  if (marginSufficient === false) {
    return draft(
      "unfundable",
      `margin required $${marginRequiredUsd.toFixed(2)} (x${leverage} on $${notionalUsd.toFixed(2)} notional) ` +
        `exceeds free margin $${(freeMargin as number).toFixed(2)}`,
      { marginSufficient: false },
    );
  }
  if (marginRequiredUsd > p.equityUsd) {
    return draft(
      "unfundable",
      `margin required $${marginRequiredUsd.toFixed(2)} exceeds equity $${p.equityUsd.toFixed(2)}`,
      { marginSufficient: false },
    );
  }

  // ── 7. payoff + noise warnings ──
  const rMultiple = targetPrice != null ? Math.abs(targetPrice - entryPrice) / stopUsd : null;
  if (atrFrac != null && stopDistanceFrac < MIN_STOP_ATR_FRACTION * atrFrac) {
    warnings.push(
      `stop is ${(stopDistanceFrac * 100).toFixed(2)}% — inside the noise band (${(MIN_STOP_ATR_FRACTION * 100).toFixed(0)}% of ATR ` +
        `${(atrFrac * 100).toFixed(2)}%); the venue's fee load is not the only thing that stops you out`,
    );
  }

  const feeRoundTripUsd = notionalUsd * feeRate;

  return {
    pair: p.pair,
    side,
    venueSide,
    status: "ok",
    reason: null,
    entryPrice,
    stopPrice,
    originalStopPrice,
    targetPrice,
    stopWidened: feeAction === "widen-stop",
    contractMultiplier: mult,
    tickSize: tick,
    equityUsd: p.equityUsd,
    riskPctOfEquity: riskPct,
    effectiveRiskPctOfEquity: effectiveRiskPct,
    riskBudgetUsd,
    dollarRiskAtStopUsd,
    stopDistanceFrac,
    stopDistancePct: stopDistanceFrac * 100,
    stopDistanceUsdPerBaseUnit: stopUsd,
    amountBaseUnits,
    contracts,
    notionalUsd,
    /** True when the notional cap shrank the risk-derived size. */
    notionalClamped,
    /** The notional cap that was applied, if any. */
    notionalCapUsd: notionalCap,
    leverage,
    maxSafeLeverage: d.maxSafe,
    venueMaxLeverage: d.venueMax,
    leverageCeiling: ceiling,
    maintenanceMarginRate: m,
    marginRequiredUsd,
    liquidationPrice,
    liquidationDistanceFrac: safety.liquidationDistanceFrac,
    liquidationDistancePct: safety.liquidationDistancePct,
    liquidationSafetyMultiple: safety.safetyMultiple,
    liqBeforeStop: safety.liqBeforeStop,
    feeRateRoundTrip: feeRate,
    feeRoundTripUsd,
    feeDragFracOfStop,
    feeAction,
    widenedStopPrice,
    widenedStopDistanceFrac,
    rMultiple,
    freeMarginUsd: freeMargin,
    marginSufficient,
    warnings,
  };
}

/**
 * Pure: the stop width (quantized to whole ticks) whose fee drag fits
 * under `maxFeeDrag`. Returns null when the tick is too coarse to get
 * there.
 *
 * Tick quantization matters: the continuous answer puts the drag exactly
 * ON the cap, and float noise can push it a hair over — which would then
 * read as "unfundable" for a trade that is actually fundable. Rounding the
 * distance UP to the next whole tick lands strictly under the cap.
 */
export function widenStopForFeeDrag(o: {
  entryPrice: number;
  side: SizingSide;
  tick: number;
  feeRate: number;
  maxFeeDrag: number;
}): { stopPrice: number; stopUsd: number; stopDistanceFrac: number } | null {
  const { entryPrice, side, tick, feeRate, maxFeeDrag } = o;
  if (!(entryPrice > 0) || !(feeRate > 0) || !(maxFeeDrag > 0)) return null;
  const neededFrac = feeRate / maxFeeDrag;
  let stopUsd: number;
  let stopPrice: number;
  if (tick > 0) {
    // Ticks needed so that feeRate / (ticks·tick/entry) ≤ maxFeeDrag.
    const ticksNeeded = Math.max(1, Math.ceil((feeRate * entryPrice) / (maxFeeDrag * tick) - 1e-9));
    stopUsd = ticksNeeded * tick;
    stopPrice = side === "long" ? entryPrice - stopUsd : entryPrice + stopUsd;
    // Guard: the quantized distance must actually clear the cap.
    if (feeRate / (stopUsd / entryPrice) > maxFeeDrag) {
      const extra = Math.ceil(
        (feeRate * entryPrice) / (maxFeeDrag * tick) - ticksNeeded + 1e-9,
      );
      stopUsd = (ticksNeeded + Math.max(1, extra)) * tick;
      stopPrice = side === "long" ? entryPrice - stopUsd : entryPrice + stopUsd;
    }
  } else {
    stopUsd = entryPrice * neededFrac;
    stopPrice = side === "long" ? entryPrice - stopUsd : entryPrice + stopUsd;
  }
  if (!(stopUsd > 0)) return null;
  const stopDistanceFrac = stopUsd / entryPrice;
  if (feeRate / stopDistanceFrac > maxFeeDrag) return null;
  return { stopPrice: clean(stopPrice), stopUsd: clean(stopUsd), stopDistanceFrac };
}
