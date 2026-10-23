/** `jw3 markets ending` — unauthenticated Gamma read, same upstream as polymarket-proxy. */
import { fetchEndingMarkets } from "../gamma.js";
import { impliedRoi, isCompetitive, isDecided } from "../math.js";

export async function cmdMarketsEnding(opts: {
  days: number;
  minLiq: number;
  limit: number;
  json: boolean;
}): Promise<void> {
  const rows = await fetchEndingMarkets({ days: opts.days, minLiq: opts.minLiq, limit: opts.limit });
  if (opts.json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          question: r.question,
          slug: r.slug,
          conditionId: r.conditionId,
          endDate: r.endDate,
          days: Math.round(r.days * 100) / 100,
          outcomes: r.outcomes.slice(0, 2),
          prices: r.prices.slice(0, 2),
          roiYesPct: roiPct(r.prices[0]),
          roiNoPct: roiPct(r.prices[1]),
          liquidity: r.liquidity,
          volume24h: r.volume24h,
          competitive: isCompetitive(r.prices),
          decided: isDecided(r.prices),
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (rows.length === 0) {
    console.log("No markets match — nothing ending in that window at this liquidity. Not an error, just thin.");
    return;
  }
  const head = ["DAYS", "YES", "NO", "YES+", "NO+", "LIQ", "QUESTION"];
  console.log(head.join("  "));
  for (const r of rows) {
    const yes = r.prices[0] as number;
    const no = r.prices[1] as number;
    const flag = isDecided(r.prices) ? " · decided" : isCompetitive(r.prices) ? "" : " · wide";
    console.log(
      [
        r.days.toFixed(2).padStart(6),
        (yes * 100).toFixed(1).padStart(5),
        (no * 100).toFixed(1).padStart(5),
        fmtRoi(yes).padStart(7),
        fmtRoi(no).padStart(7),
        compact(r.liquidity).padStart(7),
        `${r.question.slice(0, 72)}${flag}  [${r.slug}]`,
      ].join("  "),
    );
  }
}

function roiPct(p: number | undefined): number | null {
  if (p === undefined) return null;
  const r = impliedRoi(p);
  return r == null ? null : Math.round(r * 1000) / 10;
}

function fmtRoi(p: number): string {
  const r = impliedRoi(p);
  return r == null ? "—" : `+${(r * 100).toFixed(0)}%`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}
