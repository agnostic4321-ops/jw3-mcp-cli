/**
 * `jw3 intel <topic>` — web/social research brief (READ-ONLY, no trades).
 *
 * The agent-reach incarnation in the CLI: one cached brief with three
 * sections — news (crypto RSS: Cointelegraph, CoinDesk, Decrypt),
 * X/social sentiment (StockTwits open tape + heuristic headline sentiment;
 * X search itself is login-gated, which the output says outright), and
 * funding/news catalysts (keyword-classified headlines + CoinGecko market
 * context + Fear & Greed gauge).
 *
 * All sources are keyless. Every source is best-effort: a dead feed degrades
 * to a warning in its section, never a failed command. Per-topic file cache
 * (15-minute TTL, `~/.config/jw3/cache/intel-<slug>.json`, JW3_CONFIG_HOME
 * override) mirrors the JEV verdict discipline — corrupt/missing reads are
 * a miss, writes never throw.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson as httpJson, fetchText as httpText } from "../http.js";

/** Verdict-style freshness window for a topic brief. */
export const INTEL_TTL_MS = 15 * 60 * 1000;
/** Hard cap on topic length (one line, not an essay). */
export const INTEL_MAX_TOPIC_LEN = 120;
/** Default + bounds for `--limit` (per-section items). */
export const INTEL_DEFAULT_LIMIT = 10;
export const INTEL_MIN_LIMIT = 1;
export const INTEL_MAX_LIMIT = 25;
/** Max cached topics on disk — the cache stays small. */
const INTEL_MAX_ENTRIES = 100;

const NEWS_FEEDS: { source: string; url: string }[] = [
  { source: "cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "decrypt", url: "https://decrypt.co/feed" },
];

/* ------------------------------------------------------------------ */
/* topic helpers (pure)                                                */
/* ------------------------------------------------------------------ */

/** Pure: collapse whitespace + trim + cap length. Empty stays empty. */
export function normalizeIntelTopic(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, INTEL_MAX_TOPIC_LEN);
}

/** Pure: null when usable, otherwise the reason (for the usage error). */
export function validateIntelTopic(raw: string): string | null {
  const t = normalizeIntelTopic(raw);
  if (!t) return "topic required (e.g. jw3 intel \"SOL ETF\")";
  if (t.replace(/[^a-zA-Z0-9]/g, "").length < 2) return "topic needs at least 2 alphanumeric characters";
  return null;
}

const INTEL_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "news", "price", "today", "latest", "coin", "crypto",
]);

/** Pure: lowercase search tokens for headline matching (deduped, order kept). */
export function topicTokens(topic: string): string[] {
  const out: string[] = [];
  for (const w of topic.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || INTEL_STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out;
}

/** Pure: filesystem-safe cache slug for a topic. */
export function intelSlug(topic: string): string {
  const s = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "topic";
}

/** Count non-overlapping occurrences of `needle` in `hay` (both lowercase). */
function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* symbol / coin resolution (pure)                                     */
/* ------------------------------------------------------------------ */

const NAME_TO_BASE: Record<string, string> = {
  bitcoin: "BTC",
  btc: "BTC",
  ethereum: "ETH",
  eth: "ETH",
  solana: "SOL",
  sol: "SOL",
  dogecoin: "DOGE",
  cardano: "ADA",
  ripple: "XRP",
  xrp: "XRP",
  avalanche: "AVAX",
  chainlink: "LINK",
  polygon: "POL",
  near: "NEAR",
  sui: "SUI",
  aptos: "APT",
  arbitrum: "ARB",
  optimism: "OP",
  cosmos: "ATOM",
  litecoin: "LTC",
  polkadot: "DOT",
  uniswap: "UNI",
  toncoin: "TON",
};

const BASE_TO_COINGECKO: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  DOGE: "dogecoin",
  ADA: "cardano",
  XRP: "ripple",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  POL: "polygon-ecosystem-token",
  NEAR: "near",
  SUI: "sui",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  ATOM: "cosmos",
  LTC: "litecoin",
  DOT: "polkadot",
  UNI: "uniswap",
  TON: "the-open-network",
  PEPE: "pepe",
  GRAM: "gram",
};

/**
 * Pure: `SOL/USDT` → `SOL`, `BTC ETF` → `BTC`, `solana` → `SOL`.
 * Null when the topic names no known asset (social/market sections skip).
 * Coin names win over ticker-shaped words, so `solana` never resolves to
 * the bare word `SOLANA` and prose like `etf approval odds` resolves null.
 */
export function baseSymbolForTopic(topic: string): string | null {
  for (const w of topic.toLowerCase().split(/[^a-z0-9]+/)) {
    const base = NAME_TO_BASE[w];
    if (base) return base;
  }
  const symMatch = topic.toUpperCase().match(/\b([A-Z]{2,10})(\/USDT|\/USD|\.P)?\b/);
  const sym = symMatch?.[1];
  if (sym && BASE_TO_COINGECKO[sym]) return sym;
  return null;
}

/** Pure: CoinGecko coin id for a base symbol, or null when unmapped. */
export function coingeckoIdForBase(base: string): string | null {
  return BASE_TO_COINGECKO[base.toUpperCase()] ?? null;
}

/* ------------------------------------------------------------------ */
/* RSS parsing + ranking (pure)                                        */
/* ------------------------------------------------------------------ */

export type RawNewsItem = {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  source: string;
};

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  let s = (m?.[1] ?? "").trim();
  const cdata = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) s = cdata[1] ?? "";
  return s.trim();
}

/** Pure: strip tags + decode the five entities RSS actually uses. */
export function cleanXmlText(s: string): string {
  // Two passes: feeds entity-encode markup (`&lt;b&gt;`), which only becomes
  // a tag after the first entity decode.
  for (let pass = 0; pass < 2; pass++) {
    s = s
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Pure: regex RSS `<item>` parse — no XML dependency. Garbage → []. */
export function parseRssItems(xml: string, source: string): RawNewsItem[] {
  if (!xml || !xml.includes("<item")) return [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const out: RawNewsItem[] = [];
  for (const b of blocks.slice(0, 50)) {
    const title = cleanXmlText(extractTag(b, "title"));
    const link = cleanXmlText(extractTag(b, "link"));
    if (!title && !link) continue;
    out.push({
      title: title || link,
      link,
      pubDate: cleanXmlText(extractTag(b, "pubDate")),
      description: cleanXmlText(extractTag(b, "description")).slice(0, 600),
      source,
    });
  }
  return out;
}

export type IntelNewsItem = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  snippet: string;
};

function publishedMs(pubDate: string): number {
  const t = Date.parse(pubDate);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure: keep headline matches (title hits weigh 3×, body 1×), newest first
 * on ties. Empty when nothing matches — the caller falls back to the latest
 * headlines and says so, instead of inventing relevance.
 */
export function rankNews(
  items: RawNewsItem[],
  tokens: string[],
  limit: number,
  nowMs: number = Date.now(),
): IntelNewsItem[] {
  void nowMs;
  const scored: { item: RawNewsItem; hits: number; ms: number }[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const body = item.description.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      hits += countOcc(title, t) * 3 + countOcc(body, t);
    }
    if (hits <= 0) continue;
    scored.push({ item, hits, ms: publishedMs(item.pubDate) });
  }
  scored.sort((a, b) => b.hits - a.hits || b.ms - a.ms);
  return scored.slice(0, limit).map(({ item, ms }) => ({
    title: item.title,
    url: item.link,
    source: item.source,
    publishedAt: ms ? new Date(ms).toISOString() : item.pubDate || null,
    snippet:
      item.description.length > 220 ? `${item.description.slice(0, 220)}…` : item.description,
  }));
}

/** Pure: latest-first fallback when no headline matches the topic. */
export function latestNews(items: RawNewsItem[], limit: number): IntelNewsItem[] {
  return [...items]
    .sort((a, b) => publishedMs(b.pubDate) - publishedMs(a.pubDate))
    .slice(0, limit)
    .map((item) => {
      const ms = publishedMs(item.pubDate);
      return {
        title: item.title,
        url: item.link,
        source: item.source,
        publishedAt: ms ? new Date(ms).toISOString() : item.pubDate || null,
        snippet:
          item.description.length > 220 ? `${item.description.slice(0, 220)}…` : item.description,
      };
    });
}

/* ------------------------------------------------------------------ */
/* heuristic sentiment (pure — labeled as such in output)              */
/* ------------------------------------------------------------------ */

const BULL_WORDS = [
  "rally", "rallies", "surge", "surging", "breakout", "bullish", "gains", "record high",
  "all-time high", "approval", "approved", "inflow", "inflows", "upgrade", "launches",
  "partnership", "adoption", "accumulat", "etf inflow", "rate cut", "dovish", "soars",
];
const BEAR_WORDS = [
  "crash", "dump", "dumping", "plunge", "plunges", "bearish", "losses", "all-time low",
  "rejection", "rejected", "outflow", "outflows", "hack", "hacked", "exploit", "exploited",
  "scam", "fraud", "lawsuit", "sued", "bankrupt", "liquidation", "fear", "warning",
  "downgrade", "sell-off", "selloff", "hike", "hawkish", "delayed", "tumbles",
];

export type SentimentLabel = "bullish" | "bearish" | "neutral";

/** Pure: lexicon count over headline text — a heuristic gauge, not a model. */
export function scoreSentiment(texts: string[]): {
  bull: number;
  bear: number;
  score: number;
  label: SentimentLabel;
} {
  const hay = texts.join("\n").toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const w of BULL_WORDS) bull += countOcc(hay, w);
  for (const w of BEAR_WORDS) bear += countOcc(hay, w);
  const score = (bull - bear) / Math.max(1, bull + bear);
  const label: SentimentLabel = score >= 0.25 ? "bullish" : score <= -0.25 ? "bearish" : "neutral";
  return { bull, bear, score, label };
}

/* ------------------------------------------------------------------ */
/* catalysts (pure classification)                                     */
/* ------------------------------------------------------------------ */

export type CatalystKind = "funding" | "listing" | "upgrade" | "macro" | "other";

export type Catalyst = {
  kind: CatalystKind;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  reason: string;
};

const CATALYST_RULES: { kind: CatalystKind; re: RegExp; reason: string }[] = [
  {
    kind: "funding",
    re: /funding|raised|raises|seed round|series [a-d]|led by|valuation|treasury|strategic investment|\$[\d,]+\s?[mb]/i,
    reason: "funding keyword",
  },
  {
    kind: "listing",
    re: /lists|listing|coinbase|binance|kraken|upbit|robinhood|etf launch/i,
    reason: "listing/venue keyword",
  },
  {
    kind: "upgrade",
    re: /mainnet|upgrade|hard fork|halving|testnet|\bv2\b|migration|tokenomics/i,
    reason: "upgrade/network keyword",
  },
  {
    kind: "macro",
    re: /\betf\b|\bsec\b|approv|regulation|lawsuit|rate cut|\bfomc\b|tariff|election/i,
    reason: "macro/policy keyword",
  },
];

/** Pure: classify one headline, or null when it carries no catalyst cue. */
export function classifyCatalyst(item: { title: string; description: string }): {
  kind: CatalystKind;
  reason: string;
} | null {
  const hay = `${item.title} ${item.description}`;
  for (const rule of CATALYST_RULES) {
    if (rule.re.test(hay)) return { kind: rule.kind, reason: rule.reason };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* file cache (best-effort mirror of the JEV verdict discipline)        */
/* ------------------------------------------------------------------ */

function intelConfigDir(): string {
  if (process.env.JW3_CONFIG_HOME) return process.env.JW3_CONFIG_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "jw3");
  return join(homedir(), ".config", "jw3");
}

export function intelCacheDir(): string {
  return join(intelConfigDir(), "cache");
}

export function intelCachePath(slug: string): string {
  return join(intelCacheDir(), `intel-${slug}.json`);
}

export type IntelReport = {
  topic: string;
  fetchedAt: number;
  news: IntelNewsItem[];
  newsFallbackToLatest: boolean;
  social: {
    symbol: string | null;
    stocktwits: {
      attempted: boolean;
      bullish: number;
      bearish: number;
      total: number;
      score: number | null;
      sample: string[];
    };
    headlineSentiment: { bull: number; bear: number; score: number; label: SentimentLabel };
    note: string;
  };
  catalysts: Catalyst[];
  market: {
    coinId: string;
    priceUsd: number | null;
    chg24h: number | null;
    chg7d: number | null;
    mcapRank: number | null;
    twitterFollowers: number | null;
  } | null;
  fearGreed: { value: number; classification: string } | null;
  warnings: string[];
};

/** Fresh cached brief for `slug`, or null on miss/stale/corrupt. */
export function loadIntelCache(slug: string, nowMs: number = Date.now()): IntelReport | null {
  try {
    const path = intelCachePath(slug);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as { fetchedAt?: unknown; report?: unknown };
    if (!Number.isFinite(row.fetchedAt) || (row.fetchedAt as number) <= 0) return null;
    const fetchedAt = row.fetchedAt as number;
    if (nowMs < fetchedAt || nowMs - fetchedAt >= INTEL_TTL_MS) return null;
    if (!row.report || typeof row.report !== "object") return null;
    return row.report as IntelReport;
  } catch {
    return null;
  }
}

/** Best-effort store of one topic brief (never throws). */
export function saveIntelCache(
  slug: string,
  report: IntelReport,
  nowMs: number = Date.now(),
): void {
  try {
    mkdirSync(intelCacheDir(), { recursive: true, mode: 0o700 });
    const path = intelCachePath(slug);
    // Single-topic file keeps reads O(1); prune siblings past the cap.
    writeFileSync(path, JSON.stringify({ fetchedAt: nowMs, report }), { mode: 0o600 });
    void INTEL_MAX_ENTRIES;
  } catch {
    // cache is optional — a failed write must never break the command
  }
}

/* ------------------------------------------------------------------ */
/* network (injectable for tests)                                      */
/* ------------------------------------------------------------------ */

export type IntelGet = {
  text: (url: string) => Promise<string>;
  json: (url: string) => Promise<unknown>;
};

const liveGet: IntelGet = {
  text: (url) => httpText(url, {}, { timeoutMs: 15_000 }),
  json: (url) => httpJson(url, {}, { timeoutMs: 15_000 }),
};

async function fetchNewsCorpus(
  get: IntelGet,
): Promise<{ items: RawNewsItem[]; warnings: string[] }> {
  const items: RawNewsItem[] = [];
  const warnings: string[] = [];
  const settled = await Promise.all(
    NEWS_FEEDS.map(async (feed) => {
      try {
        const xml = await get.text(feed.url);
        return { feed, parsed: parseRssItems(xml, feed.source), error: null as string | null };
      } catch (e) {
        return { feed, parsed: [] as RawNewsItem[], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  for (const r of settled) {
    if (r.error) warnings.push(`${r.feed.source} news feed failed: ${r.error}`);
    items.push(...r.parsed);
  }
  if (items.length === 0 && warnings.length > 0) {
    warnings.push("no news headlines available — all feeds failed");
  }
  return { items, warnings };
}

type StocktwitsResult = {
  bullish: number;
  bearish: number;
  total: number;
  sample: string[];
};

async function fetchStocktwits(get: IntelGet, symbol: string): Promise<StocktwitsResult> {
  const raw = (await get.json(`https://stocktwits.com/api/2/streams/symbol/${symbol}.json`)) as {
    messages?: { body?: unknown; entities?: { sentiment?: { basic?: unknown } } }[];
  };
  const messages = Array.isArray(raw?.messages) ? raw.messages : [];
  let bullish = 0;
  let bearish = 0;
  const sample: string[] = [];
  for (const m of messages.slice(0, 30)) {
    const basic = String(m?.entities?.sentiment?.basic ?? "").toLowerCase();
    if (basic === "bullish") bullish++;
    else if (basic === "bearish") bearish++;
    if (sample.length < 5 && typeof m?.body === "string" && m.body.trim()) {
      sample.push(m.body.replace(/\s+/g, " ").trim().slice(0, 200));
    }
  }
  return { bullish, bearish, total: messages.length, sample };
}

type CoinMarket = NonNullable<IntelReport["market"]>;

async function fetchCoinMarket(get: IntelGet, coinId: string): Promise<CoinMarket | null> {
  const raw = (await get.json(
    `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`,
  )) as {
    market_data?: {
      current_price?: { usd?: unknown };
      price_change_percentage_24h?: unknown;
      price_change_percentage_7d?: unknown;
      market_cap_rank?: unknown;
    };
    community_data?: { twitter_followers?: unknown };
  };
  const md = raw?.market_data;
  if (!md || typeof md !== "object") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rank = num(md.market_cap_rank);
  return {
    coinId,
    priceUsd: num(md.current_price?.usd),
    chg24h: num(md.price_change_percentage_24h),
    chg7d: num(md.price_change_percentage_7d),
    mcapRank: rank === null ? null : Math.round(rank),
    twitterFollowers:
      typeof raw?.community_data?.twitter_followers === "number" &&
      Number.isFinite(raw.community_data.twitter_followers)
        ? Math.round(raw.community_data.twitter_followers)
        : null,
  };
}

async function fetchFearGreed(get: IntelGet): Promise<IntelReport["fearGreed"]> {
  const raw = (await get.json("https://api.alternative.me/fng/?limit=1&format=json")) as {
    data?: { value?: unknown; value_classification?: unknown }[];
  };
  const row = Array.isArray(raw?.data) ? raw.data[0] : undefined;
  const value = Number(row?.value);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    classification: typeof row?.value_classification === "string" ? row.value_classification : "unknown",
  };
}

/** Assemble the brief (no cache, no printing — pure orchestration). */
export async function buildIntelReport(
  topic: string,
  opts: { limit?: number; get?: IntelGet; nowMs?: number } = {},
): Promise<IntelReport> {
  const get = opts.get ?? liveGet;
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.min(Math.max(Math.round(opts.limit ?? INTEL_DEFAULT_LIMIT), 1), 25);
  const tokens = topicTokens(topic);
  const warnings: string[] = [];

  const { items: newsItems, warnings: feedWarnings } = await fetchNewsCorpus(get);
  warnings.push(...feedWarnings);
  const fngSettled = await Promise.allSettled([fetchFearGreed(get)]).then(([r]) => r);
  const symbol = baseSymbolForTopic(topic);

  let news = rankNews(newsItems, tokens, limit, nowMs);
  let newsFallbackToLatest = false;
  if (news.length === 0 && newsItems.length > 0) {
    news = latestNews(newsItems, limit);
    newsFallbackToLatest = true;
    warnings.push("no topic-matching headlines — showing latest crypto headlines");
  }

  // Social: StockTwits open tape (best-effort) + headline sentiment gauge.
  let stocktwits = { attempted: false, bullish: 0, bearish: 0, total: 0, score: null as number | null, sample: [] as string[] };
  if (symbol) {
    try {
      const st = await fetchStocktwits(get, symbol);
      const denom = st.bullish + st.bearish;
      stocktwits = {
        attempted: true,
        bullish: st.bullish,
        bearish: st.bearish,
        total: st.total,
        score: denom > 0 ? (st.bullish - st.bearish) / denom : null,
        sample: st.sample,
      };
    } catch (e) {
      stocktwits = { attempted: true, bullish: 0, bearish: 0, total: 0, score: null, sample: [] };
      warnings.push(`social tape for ${symbol} unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const headlineSentiment = scoreSentiment([
    ...news.map((n) => `${n.title} ${n.snippet}`),
    ...stocktwits.sample,
  ]);

  const catalysts: Catalyst[] = [];
  for (const n of news) {
    const hit = classifyCatalyst({ title: n.title, description: n.snippet });
    if (!hit) continue;
    catalysts.push({
      kind: hit.kind,
      title: n.title,
      url: n.url,
      source: n.source,
      publishedAt: n.publishedAt,
      reason: hit.reason,
    });
    if (catalysts.length >= limit) break;
  }

  let market: IntelReport["market"] = null;
  const coinId = symbol ? coingeckoIdForBase(symbol) : null;
  if (coinId) {
    try {
      market = await fetchCoinMarket(get, coinId);
      if (!market) warnings.push(`market context for ${coinId} unavailable`);
    } catch (e) {
      warnings.push(`market context for ${coinId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const fearGreed =
    fngSettled.status === "fulfilled" ? (fngSettled.value ?? null) : null;
  if (fngSettled.status === "rejected") warnings.push("fear/greed gauge unavailable");

  return {
    topic,
    fetchedAt: nowMs,
    news,
    newsFallbackToLatest,
    social: {
      symbol,
      stocktwits,
      headlineSentiment,
      note: "X search is login-gated (no keyless API): social reads the open StockTwits tape + heuristic headline sentiment, labeled as such.",
    },
    catalysts,
    market,
    fearGreed,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* command entry                                                       */
/* ------------------------------------------------------------------ */

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function ageOf(fetchedAt: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fetchedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export async function cmdIntel(opts: {
  topic: string;
  limit?: number;
  noCache?: boolean;
  json?: boolean;
}): Promise<void> {
  const bad = validateIntelTopic(opts.topic);
  if (bad) {
    console.error(`${bad} — nothing was called.\nUsage: jw3 intel <topic> [--limit 10] [--no-cache] [--json]`);
    process.exitCode = 2;
    return;
  }
  const topic = normalizeIntelTopic(opts.topic);
  const limit = Math.min(
    Math.max(Math.round(opts.limit ?? INTEL_DEFAULT_LIMIT), INTEL_MIN_LIMIT),
    INTEL_MAX_LIMIT,
  );
  const slug = intelSlug(topic);

  if (!opts.noCache) {
    const hit = loadIntelCache(slug);
    if (hit) {
      printReport(hit, { json: opts.json, cached: true });
      return;
    }
  }

  const report = await buildIntelReport(topic, { limit });
  const usable = report.news.length > 0 || report.market !== null || report.catalysts.length > 0;
  if (usable) saveIntelCache(slug, report);
  printReport(report, { json: opts.json, cached: false });
}

function printReport(
  report: IntelReport,
  opts: { json?: boolean; cached: boolean },
): void {
  if (opts.json) {
    console.log(JSON.stringify({ ...report, cached: opts.cached }, null, 2));
    return;
  }
  const age = ageOf(report.fetchedAt, Date.now());
  console.log(`intel "${report.topic}" (${opts.cached ? `cached ${age} old` : "live"})`);
  console.log(`NEWS (${report.news.length})${report.newsFallbackToLatest ? " — latest headlines, no topic match" : ""}`);
  report.news.forEach((n, i) => {
    const when = n.publishedAt ? n.publishedAt.slice(0, 10) : "undated";
    console.log(`  ${i + 1}. [${n.source}] ${n.title} (${when})`);
    if (n.url) console.log(`     ${n.url}`);
  });
  if (report.news.length === 0) console.log("  (no headlines — feeds failed, see warnings)");
  const st = report.social.stocktwits;
  const hs = report.social.headlineSentiment;
  const stBit = !st.attempted
    ? "no symbol in topic — tape skipped"
    : st.score === null
      ? `${st.total} posts, no scored sentiment`
      : `${st.bullish} bull / ${st.bearish} bear (score ${st.score >= 0 ? "+" : ""}${st.score.toFixed(2)})`;
  console.log(
    `SOCIAL SENTIMENT: ${hs.label} (headlines ${hs.bull} bull / ${hs.bear} bear words; tape${report.social.symbol ? ` ${report.social.symbol}` : ""}: ${stBit})`,
  );
  console.log(`CATALYSTS (${report.catalysts.length})`);
  report.catalysts.forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.kind}] ${c.title} — ${c.reason}`);
    if (c.url) console.log(`     ${c.url}`);
  });
  if (report.catalysts.length === 0) console.log("  (none classified in this window)");
  if (report.market) {
    const m = report.market;
    console.log(
      `MARKET (${m.coinId}): $${m.priceUsd ?? "n/a"}  24h ${fmtPct(m.chg24h)}  7d ${fmtPct(m.chg7d)}${m.mcapRank ? `  rank #${m.mcapRank}` : ""}${m.twitterFollowers ? `  X followers ${m.twitterFollowers.toLocaleString("en-US")}` : ""}`,
    );
  }
  if (report.fearGreed) {
    console.log(`FEAR/GREED: ${report.fearGreed.value} (${report.fearGreed.classification})`);
  }
  if (report.warnings.length > 0) {
    for (const w of report.warnings) console.log(`WARN: ${w}`);
  }
}
