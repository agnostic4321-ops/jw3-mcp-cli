/**
 * `jw3 ttm` — Tony Trading Method scaffold (DRY-RUN ONLY, no trades).
 *
 * Doctrine: docs/TTM-DOCTRINE.md. $10 → $10k/24h attempt with 25–50x
 * isolated leverage, martingale ladder entries (1x/2x/4x notionals at ATR
 * steps), no fixed stops (averaging IS risk control), trail exits
 * (activation/bounceback), four parallel sleeves
 * (momentum/fade/funding/breakout), account floor $3 = halt all.
 *
 * This scaffold is a calculator with opinions: it sizes the ladder,
 * derives the ATR-step prices and the averaged entry, splits equity
 * across sleeves, and prints the exact trail follow-up. It imports no
 * venue client and sends zero bytes — `--live`/`--yes` are refused
 * because no live path exists yet.
 */

export const TTM_START_EQUITY_USD = 10;
export const TTM_FLOOR_EQUITY_USD = 3;
export const TTM_MIN_LEV = 25;
export const TTM_MAX_LEV = 50;
/** Ladder notional multiples: base 1x, add 2x at 1 ATR, add 4x at 2 ATR. */
export const TTM_LADDER_MULTS = [1, 2, 4] as const;
export const TTM_SLEEVES = ["momentum", "fade", "funding", "breakout"] as const;
export type TtmSleeve = (typeof TTM_SLEEVES)[number];
export type TtmSide = "long" | "short";

export type TtmArgs = {
  pair: string;
  side: TtmSide;
  /** Current account equity (USD). Floor check runs against this. */
  equityUsd: number;
  /** Base-leg notional (USD). Full ladder commits 7x this. */
  baseNotionalUsd: number;
  leverage: number;
  /** Signal-entry reference price (operator input — no signal gen here). */
  entryPrice: number;
  /** ATR as % of entry (e.g. 0.8 = 0.8%). */
  atrPct: number;
  sleeve?: TtmSleeve;
  activationPct?: number;
  bouncebackPct?: number;
  json: boolean;
};

export type TtmLeg = {
  leg: number;
  mult: number;
  notionalUsd: number;
  /** Margin locked by this leg at the plan leverage. */
  marginUsd: number;
  /** Adverse ATR steps from signal entry (0, 1, 2). */
  atrSteps: number;
  price: number;
};

export type TtmPlan = {
  pair: string;
  side: TtmSide;
  sleeve: TtmSleeve;
  leverage: number;
  equityUsd: number;
  legs: TtmLeg[];
  totalNotionalUsd: number;
  totalMarginUsd: number;
  averagedEntry: number;
  sleeveAllocationUsd: number;
  ladderFitsSleeve: boolean;
  activationPct: number;
  bouncebackPct: number;
};

/** Pure: arg check. Null = usable. */
export function validateTtmArgs(a: TtmArgs): string | null {
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  if (a.side !== "long" && a.side !== "short") return "side required (long|short)";
  if (!(a.equityUsd > 0)) return "equity must be > 0";
  if (!(a.baseNotionalUsd > 0)) return "base notional must be > 0";
  if (!(a.leverage >= TTM_MIN_LEV && a.leverage <= TTM_MAX_LEV))
    return `leverage must be ${TTM_MIN_LEV}-${TTM_MAX_LEV}x isolated (got ${a.leverage})`;
  if (!(a.entryPrice > 0)) return "entry price must be > 0";
  if (!(a.atrPct > 0 && a.atrPct <= 25)) return "atr-pct must be in (0, 25]";
  if (a.sleeve !== undefined && !(TTM_SLEEVES as readonly string[]).includes(a.sleeve))
    return `sleeve must be one of ${TTM_SLEEVES.join("|")}`;
  return null;
}

/** Pure: true when equity is at/below the $3 floor — halt everything. */
export function floorHalt(equityUsd: number, floor: number = TTM_FLOOR_EQUITY_USD): boolean {
  return !(equityUsd > floor);
}

/** Pure: margin locked by one leg (isolated: notional / leverage). */
export function legMargin(notionalUsd: number, leverage: number): number {
  return notionalUsd / leverage;
}

/**
 * Pure: the three ladder legs. Longs step DOWN (adverse = cheaper),
 * shorts step UP. Prices round to 6dp — display-grade, never tick-grade.
 */
export function buildLadder(a: TtmArgs): TtmLeg[] {
  const dir = a.side === "long" ? -1 : 1;
  return TTM_LADDER_MULTS.map((mult, i) => {
    const notionalUsd = a.baseNotionalUsd * mult;
    const price = a.entryPrice * (1 + (dir * i * a.atrPct) / 100);
    return {
      leg: i + 1,
      mult,
      notionalUsd,
      marginUsd: legMargin(notionalUsd, a.leverage),
      atrSteps: i,
      price: Math.round(price * 1e6) / 1e6,
    };
  });
}

/** Pure: notional-weighted average entry across filled legs. */
export function averagedEntry(legs: Pick<TtmLeg, "notionalUsd" | "price">[]): number {
  const n = legs.reduce((s, l) => s + l.notionalUsd, 0);
  if (!(n > 0)) return NaN;
  return legs.reduce((s, l) => s + l.notionalUsd * l.price, 0) / n;
}

/** Pure: equal-weight sleeve split (floor-halted sleeves take nothing). */
export function sleeveAllocation(equityUsd: number): number {
  return equityUsd / TTM_SLEEVES.length;
}

/** Pure: full plan from args. Null when invalid (see validateTtmArgs). */
export function planTtm(a: TtmArgs): TtmPlan | null {
  if (validateTtmArgs(a) !== null) return null;
  const legs = buildLadder(a);
  const totalNotionalUsd = legs.reduce((s, l) => s + l.notionalUsd, 0);
  const totalMarginUsd = legs.reduce((s, l) => s + l.marginUsd, 0);
  const allocation = sleeveAllocation(a.equityUsd);
  return {
    pair: a.pair,
    side: a.side,
    sleeve: a.sleeve ?? "momentum",
    leverage: a.leverage,
    equityUsd: a.equityUsd,
    legs,
    totalNotionalUsd,
    totalMarginUsd,
    averagedEntry: averagedEntry(legs),
    sleeveAllocationUsd: allocation,
    ladderFitsSleeve: totalMarginUsd <= allocation,
    activationPct: a.activationPct ?? 0.25,
    bouncebackPct: a.bouncebackPct ?? 0.08,
  };
}

function planLine(p: TtmPlan): string {
  const legs = p.legs
    .map(
      (l) =>
        `leg${l.leg} ${l.mult}x $${l.notionalUsd.toFixed(2)} @ ${l.price} (−${l.atrSteps} ATR, margin $${l.marginUsd.toFixed(2)})`,
    )
    .join("\n  ");
  return [
    `TTM plan (DRY-RUN — no orders sent): ${p.pair} ${p.side} ${p.leverage}x isolated [${p.sleeve}]`,
    `  equity $${p.equityUsd.toFixed(2)} | sleeve alloc $${p.sleeveAllocationUsd.toFixed(2)} | ladder margin $${p.totalMarginUsd.toFixed(2)} ${p.ladderFitsSleeve ? "FITS" : "EXCEEDS SLEEVE — shrink --base"}`,
    `  ${legs}`,
    `  total notional $${p.totalNotionalUsd.toFixed(2)} | averaged entry ${p.averagedEntry}`,
    `  exit: trail activation ${p.activationPct}% / bounceback ${p.bouncebackPct}% — follow-up: jw3 trail --pair ${p.pair} --side ${p.side} --size <LOT> --activation-pct ${p.activationPct} --bounceback-pct ${p.bouncebackPct}`,
    `  floor $${TTM_FLOOR_EQUITY_USD}: equity ≤ floor = halt all (close-only)`,
  ].join("\n");
}

/**
 * Dry-run entry point. Prints the ladder plan; sends zero bytes by
 * construction (no venue import). `--live`/`--yes` are refused: no live
 * path exists in this scaffold.
 */
export async function cmdTtm(
  a: TtmArgs,
  opts: { live?: boolean; yes?: boolean } = {},
): Promise<void> {
  if (opts.live || opts.yes) {
    console.error("TTM scaffold is dry-run only: no live path exists — nothing was called.");
    process.exitCode = 2;
    return;
  }
  const bad = validateTtmArgs(a);
  if (bad) {
    console.error(`Bad TTM args: ${bad} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  if (floorHalt(a.equityUsd)) {
    const msg = `FLOOR HALT: equity $${a.equityUsd.toFixed(2)} ≤ $${TTM_FLOOR_EQUITY_USD} — no new ladders (close-only).`;
    if (a.json) console.log(JSON.stringify({ halt: true, equityUsd: a.equityUsd, floorUsd: TTM_FLOOR_EQUITY_USD }));
    else console.log(msg);
    return;
  }
  const plan = planTtm(a);
  if (!plan) {
    console.error("Bad TTM args: plan failed validation — nothing was called.");
    process.exitCode = 2;
    return;
  }
  if (a.json) console.log(JSON.stringify({ halt: false, dryRun: true, plan }, null, 2));
  else console.log(planLine(plan));
}
