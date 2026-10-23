/** Pure payout math for prediction markets — no network, unit-tested. */

export function impliedRoi(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return (1 - price) / price;
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** A leg under 2c or over 99c is effectively decided — no edge, just noise. */
export function isDecided(prices: number[]): boolean {
  return prices.some((p) => Number.isFinite(p) && (p < 0.02 || p > 0.99));
}

/** Both featured legs inside 5c..95c — worth a JEV read. */
export function isCompetitive(prices: number[]): boolean {
  if (prices.length < 2) return false;
  const a = prices[0] as number;
  const b = prices[1] as number;
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a >= 0.05 &&
    a <= 0.95 &&
    b >= 0.05 &&
    b <= 0.95
  );
}

export type RankRow = {
  liq: number;
  days: number;
  competitive: boolean;
  decided: boolean;
};

/** Competitive first, undecided before decided, then deepest liquidity. */
export function rankCompare(a: RankRow, b: RankRow): number {
  if (a.competitive !== b.competitive) return a.competitive ? -1 : 1;
  if (a.decided !== b.decided) return a.decided ? 1 : -1;
  if (a.days !== b.days) return a.days - b.days;
  return b.liq - a.liq;
}
