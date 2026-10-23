/**
 * Blocking pre-filters for the oracle scoring path (pure, no I/O, no trades).
 *
 * TypeScript mirror of ~/kronos/data/blocking_rules.py — thresholds must stay
 * in lockstep (drift is caught by blocking-rules.test.ts asserting the values).
 * Each check is arithmetic over already-known scalars (microseconds), so bad
 * trades die BEFORE any Kronos/Laya/RF-DETR inference call.
 *
 * Rules:
 *  1. CPI blackout 11:30-13:30Z auto-veto (both sides).
 *  2. No-shorts when the day session is down > 2% (extended-drop veto).
 *  3. Bounce-required for shorts: price >= +0.4% off the session low.
 *  4. BTC fee-veto at small size (fee-unprofitable at minimum size).
 */

export const CPI_BLACKOUT_START_MIN = 11 * 60 + 30; // 11:30Z inclusive
export const CPI_BLACKOUT_END_MIN = 13 * 60 + 30; // 13:30Z exclusive
export const EXTENDED_DROP_PCT = 2.0;
export const BOUNCE_REQUIRED_PCT = 0.4;
export const BTC_FEE_VETO_ACCOUNT_USD = 25.0;
export const BTC_FEE_VETO_MIN_NOTIONAL_USD = 50.0;

export type PrefilterRule = "cpi_blackout" | "extended_drop" | "bounce_required" | "btc_fee";

export type PrefilterVerdict = {
  vetoed: boolean;
  rule: PrefilterRule | null;
  detail: string;
  /** Data-dependent rules skipped for missing legs (caller must re-run post-fetch). */
  unevaluated: PrefilterRule[];
};

export type PrefilterCtx = {
  symbol?: string;
  /** Intended side. Undefined = direction-oracle mode (only side-agnostic rules apply pre-inference). */
  side?: "long" | "short";
  dayChgPct?: number;
  price?: number;
  sessionLow?: number;
  sizeLots?: number;
  accountUsd?: number;
  notionalUsd?: number;
  feeTierOk?: boolean;
  /** Epoch ms; defaults to now (UTC minutes). Tests inject fixed times. */
  nowMs?: number;
};

/** Minutes since UTC midnight for an epoch-ms timestamp. */
export function utcMinutes(nowMs?: number): number {
  const d = new Date(nowMs ?? Date.now());
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** True inside the CPI blackout window (veto both directions). */
export function cpiBlackout(nowMs?: number): boolean {
  const m = utcMinutes(nowMs);
  return CPI_BLACKOUT_START_MIN <= m && m < CPI_BLACKOUT_END_MIN;
}

/** True when the day session is down more than EXTENDED_DROP_PCT. */
export function extendedDropVeto(dayChgPct: number | undefined | null): boolean {
  return typeof dayChgPct === "number" && Number.isFinite(dayChgPct) && dayChgPct < -EXTENDED_DROP_PCT;
}

/** Bounce above the session low in percent; null when either leg is unusable. */
export function bounceOffLowPct(price: number | undefined | null, sessionLow: number | undefined | null): number | null {
  if (typeof price !== "number" || typeof sessionLow !== "number") return null;
  if (!(sessionLow > 0) || !(price > 0) || !Number.isFinite(price) || !Number.isFinite(sessionLow)) return null;
  return ((price - sessionLow) / sessionLow) * 100;
}

/**
 * True when a SHORT lacks the required bounce off the session low.
 * Longs never vetoed. Missing legs veto conservatively (fail closed).
 */
export function bounceRequiredVeto(
  side: string | undefined | null,
  price: number | undefined | null,
  sessionLow: number | undefined | null,
  requiredPct = BOUNCE_REQUIRED_PCT,
): boolean {
  if (String(side ?? "").toLowerCase() !== "short") return false;
  const b = bounceOffLowPct(price, sessionLow);
  if (b === null) return true;
  return b < requiredPct;
}

function baseOf(symbol: string | undefined | null): string {
  let s = String(symbol ?? "").toUpperCase().replace(/[/\-\s]/g, "");
  for (const suffix of ["USDTM", "USDT", "USD", "PERP"]) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return s;
}

/**
 * True when a BTC trade is fee-unprofitable at the given size.
 * Benched only at minimum size on a small account; re-enable with
 * feeTierOk or larger size/notional. Non-BTC never vetoed.
 */
export function btcFeeVeto(
  symbol: string | undefined | null,
  opts: { sizeLots?: number; accountUsd?: number; notionalUsd?: number; feeTierOk?: boolean } = {},
): boolean {
  const b = baseOf(symbol);
  if (b !== "BTC" && b !== "XBT") return false;
  if (opts.feeTierOk) return false;
  const acct = typeof opts.accountUsd === "number" && Number.isFinite(opts.accountUsd) ? opts.accountUsd : null;
  const notional = typeof opts.notionalUsd === "number" && Number.isFinite(opts.notionalUsd) ? opts.notionalUsd : null;
  if (notional !== null && notional >= BTC_FEE_VETO_MIN_NOTIONAL_USD) return false;
  if (acct !== null && acct >= BTC_FEE_VETO_ACCOUNT_USD) return false;
  return true; // unknown size on BTC, or small on both legs -> fail closed (bench)
}

/**
 * Run all applicable pre-filters. Veto precedence:
 * cpi_blackout > extended_drop > bounce_required > btc_fee.
 * Without a side, only side-agnostic rules (CPI, BTC) can veto pre-inference;
 * side-aware rules need `side` and are skipped (the direction oracle clamps
 * short verdicts post-combine via `shortAllowed` below instead).
 */
export function precheck(ctx: PrefilterCtx = {}): PrefilterVerdict {
  const pass: PrefilterVerdict = { vetoed: false, rule: null, detail: "all pre-filters pass", unevaluated: [] };
  if (cpiBlackout(ctx.nowMs)) {
    return { vetoed: true, rule: "cpi_blackout", detail: "CPI blackout 11:30-13:30Z: post-CPI chop kills both directions", unevaluated: [] };
  }
  const side = String(ctx.side ?? "").toLowerCase();
  const unevaluated: PrefilterRule[] = [];
  if (side === "short") {
    if (ctx.dayChgPct === undefined || ctx.dayChgPct === null) {
      unevaluated.push("extended_drop");
    } else if (extendedDropVeto(ctx.dayChgPct)) {
      return {
        vetoed: true, rule: "extended_drop",
        detail: `day down ${ctx.dayChgPct}% past -${EXTENDED_DROP_PCT}%: no shorts into extended drops`,
        unevaluated,
      };
    }
    if (ctx.price === undefined || ctx.price === null || ctx.sessionLow === undefined || ctx.sessionLow === null) {
      unevaluated.push("bounce_required");
    } else if (bounceRequiredVeto(ctx.side, ctx.price, ctx.sessionLow)) {
      const b = bounceOffLowPct(ctx.price, ctx.sessionLow);
      const seen = b === null ? "unknown" : `${b.toFixed(2)}%`;
      return {
        vetoed: true, rule: "bounce_required",
        detail: `short needs +${BOUNCE_REQUIRED_PCT}% off session low (at ${seen}): never short into the flush`,
        unevaluated,
      };
    }
  }
  if (btcFeeVeto(ctx.symbol, { sizeLots: ctx.sizeLots, accountUsd: ctx.accountUsd, notionalUsd: ctx.notionalUsd, feeTierOk: ctx.feeTierOk })) {
    return {
      vetoed: true, rule: "btc_fee",
      detail: "BTC fee-unprofitable at minimum size on small account: taker fees consume the edge (bench; re-enable on size/fee-tier change)",
      unevaluated,
    };
  }
  return { ...pass, unevaluated };
}

/**
 * Post-combine clamp for the side-agnostic direction oracle: when the session
 * context vetoes shorts but models vote short, the verdict becomes flat with
 * a prefilter reason instead of a short trade signal.
 */
export function clampShortVerdict(
  side: "long" | "short" | "flat",
  ctx: PrefilterCtx,
): { side: "long" | "short" | "flat"; clamped: boolean; rule: PrefilterRule | null; detail?: string } {
  if (side !== "short") return { side, clamped: false, rule: null };
  if (extendedDropVeto(ctx.dayChgPct)) {
    return { side: "flat", clamped: true, rule: "extended_drop", detail: `short clamped: day down ${ctx.dayChgPct}% past -${EXTENDED_DROP_PCT}%` };
  }
  if (bounceRequiredVeto("short", ctx.price, ctx.sessionLow)) {
    return { side: "flat", clamped: true, rule: "bounce_required", detail: "short clamped: +0.4% bounce off session low not present" };
  }
  return { side, clamped: false, rule: null };
}
