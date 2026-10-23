/**
 * `jw3 analyze prediction <slug|conditionId|id>` — assembles the same
 * market+brief snapshot the in-app JevPolymarketSection posts, then calls
 * MCP analyze_market (family prediction). Auth required; fail-closed:
 * no PAT means no call and no invented verdict.
 */
import { fetchBook, fetchHistoryTail, fetchMarketDetail, type EndingMarket } from "../gamma.js";
import { McpError, callTool } from "../mcp.js";
import { jevVerdictKey, loadJevVerdict, saveJevVerdict } from "../cache.js";
import { needPat } from "./market.js";

type Verdict = {
  family: string;
  venue: string;
  symbol: string;
  model: string;
  analyzedAt: string;
  verdict: { prediction?: { decision: string; yesP: number | null; noP: number | null; confidence?: number } } | null;
  usage: { cost?: number } | null;
  cached?: boolean;
  cliCached?: boolean;
};

export async function cmdAnalyze(opts: { id: string; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let market: EndingMarket;
  try {
    market = await fetchMarketDetail(opts.id);
  } catch (e) {
    console.error(`Market lookup failed — no signal returned: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const yes = { name: market.outcomes[0] ?? "Yes", price: market.prices[0] ?? null, token: market.tokenIds[0] ?? null };
  const no = { name: market.outcomes[1] ?? "No", price: market.prices[1] ?? null, token: market.tokenIds[1] ?? null };
  // JEV verdict TTL (15 min per market): a fresh-window repeat serves the
  // stored verdict with no book/history fetch and no analyze_market call.
  const cacheKey = jevVerdictKey("prediction", "polymarket", market.conditionId || market.slug);
  const cachedHit = loadJevVerdict<Verdict>(cacheKey);
  let out: Verdict;
  if (cachedHit) {
    out = { ...cachedHit, cliCached: true };
  } else {
  const [book, historyTail] = await Promise.all([
    yes.token ? fetchBook(yes.token) : Promise.resolve({ bids: [], asks: [] }),
    yes.token ? fetchHistoryTail(yes.token) : Promise.resolve([]),
  ]);
  const url = `https://polymarket.com/event/${market.slug}`;
  const at = new Date().toISOString();
  const snapshot = {
    market: {
      question: market.question,
      url,
      description: null,
      category: null,
      endDate: market.endDate,
      active: market.active,
      closed: market.closed,
      outcomes: [
        { name: yes.name, price: yes.price, token_id: yes.token },
        { name: no.name, price: no.price, token_id: no.token },
      ],
      volume: market.volume,
      volume24hr: market.volume24h,
      liquidity: market.liquidity,
      book,
      historyTail,
      tape: null,
    },
    brief: [{ title: market.question, snippet: "CLI brief: resolution rules not fetched — open the event URL.", url, at }],
  };
  let live: Verdict;
  try {
    live = (await callTool(
      "analyze_market",
      { family: "prediction", venue: "polymarket", symbol: market.conditionId || market.slug, snapshot },
      pat,
      opts.url,
    )) as Verdict;
  } catch (e) {
    const code = e instanceof McpError ? ` [${e.code}]` : "";
    console.error(`Analysis failed${code} — no signal returned: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  saveJevVerdict(cacheKey, live);
  out = live;
  }
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const p = out.verdict?.prediction;
  if (!p) {
    console.log("No prediction verdict returned — provider left the question unanswered.");
    return;
  }
  const label = p.decision === "yes" ? "YES" : p.decision === "no" ? "NO" : "TOSS-UP";
  const detail =
    p.decision === "toss_up"
      ? "evidence thin or contradictory — no edge either way"
      : `YES ${pct1(p.yesP)} / NO ${pct1(p.noP)}${p.confidence != null ? ` · conf ${(p.confidence * 100).toFixed(0)}%` : ""}`;
  console.log(`${label} — ${market.question}`);
  console.log(detail);
  console.log(`${out.model ?? "JEV"} · analyzed ${out.analyzedAt ?? "—"}${out.cliCached ? " · cached (<15m, no provider call)" : ""} · not financial advice`);
}

function pct1(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export type TrendVerdict = {
  model?: string;
  analyzedAt?: string;
  verdict?: {
    trend?: {
      verdict: string;
      agreement: number;
      uncertain: boolean;
    };
  } | null;
  cached?: boolean;
  cliCached?: boolean;
};

/**
 * JEV 7-timeframe trend for a CEX pair via MCP analyze_market
 * (server-built candle snapshot, family cex). Throws on transport or
 * provider failure — callers decide how to report. Shared by
 * `analyze trend` and `vote` so both read the same verdict.
 *
 * CLI verdict TTL (15 min per market): a fresh-window repeat serves the
 * stored verdict with no network call.
 */
export async function fetchJevTrend(
  exchange: string,
  pair: string,
  pat: string,
  url?: string,
): Promise<TrendVerdict> {
  const key = jevVerdictKey("cex", exchange, pair);
  const hit = loadJevVerdict<TrendVerdict>(key);
  if (hit) return { ...hit, cliCached: true };
  const out = (await callTool(
    "analyze_market",
    { family: "cex", venue: exchange.toLowerCase(), symbol: pair.toUpperCase() },
    pat,
    url,
  )) as TrendVerdict;
  saveJevVerdict(key, out);
  return out;
}

/**
 * `analyze trend` — JEV 7-timeframe trend via MCP analyze_market with a
 * server-built candle snapshot (family cex). Read-only; nothing is traded.
 */
export async function cmdAnalyzeTrend(opts: {
  exchange: string;
  pair: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange || !opts.pair) {
    console.error("Usage: jw3 analyze trend --exchange kucoin --pair BTC/USDT [--json]");
    process.exitCode = 2;
    return;
  }
  let out: TrendVerdict;
  try {
    out = await fetchJevTrend(opts.exchange, opts.pair, pat, opts.url);
  } catch (e) {
    console.error(`Analysis failed — no signal returned: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const t = out.verdict?.trend;
  if (!t) {
    console.log("No trend verdict returned — provider left the question unanswered.");
    return;
  }
  const label = t.verdict.replace(/_/g, " ").toUpperCase();
  console.log(`${label} — ${opts.pair} (${opts.exchange})`);
  if (!t.uncertain) console.log(`timeframe weight ${Math.round(t.agreement * 100)}%`);
  else console.log("timeframes conflict or confidence too low — no signal, not a call");
  console.log(`${out.model ?? "JEV"} · analyzed ${out.analyzedAt ?? "—"}${out.cliCached ? " · cached (<15m, no provider call)" : ""} · not financial advice`);
}
