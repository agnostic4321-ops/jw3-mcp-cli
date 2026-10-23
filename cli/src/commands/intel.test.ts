import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTEL_TTL_MS,
  baseSymbolForTopic,
  buildIntelReport,
  classifyCatalyst,
  coingeckoIdForBase,
  intelCachePath,
  intelSlug,
  latestNews,
  loadIntelCache,
  normalizeIntelTopic,
  parseRssItems,
  rankNews,
  saveIntelCache,
  scoreSentiment,
  topicTokens,
  validateIntelTopic,
  type IntelGet,
  type IntelReport,
} from "./intel.js";

describe("validateIntelTopic + normalizeIntelTopic", () => {
  it("accepts a normal topic, collapses whitespace", () => {
    assert.equal(validateIntelTopic("SOL ETF"), null);
    assert.equal(normalizeIntelTopic("  SOL   ETF  "), "SOL ETF");
  });
  it("rejects empty and too-short topics", () => {
    assert.ok(validateIntelTopic(""));
    assert.ok(validateIntelTopic("   "));
    assert.ok(validateIntelTopic("!"));
    assert.ok(validateIntelTopic("a"));
  });
});

describe("topicTokens + intelSlug", () => {
  it("lowercases, dedupes, drops stopwords", () => {
    assert.deepEqual(topicTokens("SOL ETF news"), ["sol", "etf"]);
    assert.deepEqual(topicTokens("SOL sol SOL"), ["sol"]);
  });
  it("slugs topics for filenames", () => {
    assert.equal(intelSlug("SOL ETF"), "sol-etf");
    assert.equal(intelSlug("  BTC/USDT!! "), "btc-usdt");
  });
});

describe("baseSymbolForTopic + coingeckoIdForBase", () => {
  it("resolves pairs, tickers, and coin names", () => {
    assert.equal(baseSymbolForTopic("SOL/USDT"), "SOL");
    assert.equal(baseSymbolForTopic("BTC ETF"), "BTC");
    assert.equal(baseSymbolForTopic("solana upgrade"), "SOL");
    assert.equal(baseSymbolForTopic("ethereum merge"), "ETH");
  });
  it("returns null when no asset is named", () => {
    assert.equal(baseSymbolForTopic("etf approval odds"), null);
  });
  it("maps majors to CoinGecko ids", () => {
    assert.equal(coingeckoIdForBase("SOL"), "solana");
    assert.equal(coingeckoIdForBase("btc"), "bitcoin");
    assert.equal(coingeckoIdForBase("NOPE"), null);
  });
});

const RSS = `<?xml version="1.0"?>
<rss><channel>
<item><title><![CDATA[Solana ETF inflows hit record]]></title><link>https://ex.com/a</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><description>Funds &amp; flows &lt;b&gt;bold&lt;/b&gt;</description></item>
<item><title>Bitcoin steady</title><link>https://ex.com/b</link><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate><description>Nothing much</description></item>
<item><title></title><link></link></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("parses items, CDATA, entities; skips empties; rejects garbage", () => {
    const items = parseRssItems(RSS, "cointelegraph");
    assert.equal(items.length, 2);
    assert.equal(items[0]?.title, "Solana ETF inflows hit record");
    assert.equal(items[0]?.description, "Funds & flows bold");
    assert.equal(parseRssItems("not xml", "x").length, 0);
    assert.equal(parseRssItems("", "x").length, 0);
  });
});

describe("rankNews + latestNews", () => {
  const items = parseRssItems(RSS, "cointelegraph");
  it("keeps topic matches, title-weighted, newest on ties", () => {
    const ranked = rankNews(items, ["solana"], 10);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.source, "cointelegraph");
    assert.ok(ranked[0]?.url.includes("ex.com/a"));
  });
  it("empty when nothing matches", () => {
    assert.equal(rankNews(items, ["pepe"], 10).length, 0);
  });
  it("latestNews falls back newest-first", () => {
    const latest = latestNews(items, 1);
    assert.equal(latest.length, 1);
    assert.ok(latest[0]?.title.includes("Solana"));
  });
});

describe("scoreSentiment", () => {
  it("bullish on rallies, bearish on hacks, neutral on mix", () => {
    assert.equal(scoreSentiment(["Solana rally surges to record high"]).label, "bullish");
    assert.equal(scoreSentiment(["Exchange hack triggers sell-off fear"]).label, "bearish");
    assert.equal(scoreSentiment(["Bitcoin steady"]).label, "neutral");
    assert.equal(scoreSentiment([]).score, 0);
  });
});

describe("classifyCatalyst", () => {
  it("classifies funding, listing, upgrade, macro; null otherwise", () => {
    assert.equal(
      classifyCatalyst({ title: "Startup raised $50M led by Paradigm", description: "" })?.kind,
      "funding",
    );
    assert.equal(
      classifyCatalyst({ title: "Coinbase lists TOKEN", description: "" })?.kind,
      "listing",
    );
    assert.equal(
      classifyCatalyst({ title: "Mainnet upgrade goes live", description: "" })?.kind,
      "upgrade",
    );
    assert.equal(
      classifyCatalyst({ title: "SEC approves ETF options", description: "" })?.kind,
      "macro",
    );
    assert.equal(classifyCatalyst({ title: "Bitcoin steady near highs", description: "" }), null);
  });
});

describe("intel file cache", () => {
  let dir: string;
  let prev: string | undefined;
  const report = (topic: string): IntelReport => ({
    topic,
    fetchedAt: 1_000_000,
    news: [],
    newsFallbackToLatest: false,
    social: {
      symbol: null,
      stocktwits: { attempted: false, bullish: 0, bearish: 0, total: 0, score: null, sample: [] },
      headlineSentiment: { bull: 0, bear: 0, score: 0, label: "neutral" },
      note: "t",
    },
    catalysts: [],
    market: null,
    fearGreed: null,
    warnings: [],
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jw3-intel-"));
    prev = process.env.JW3_CONFIG_HOME;
    process.env.JW3_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.JW3_CONFIG_HOME;
    else process.env.JW3_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("misses empty, round-trips fresh, expires past TTL", () => {
    assert.equal(loadIntelCache("sol", 1_000_000), null);
    saveIntelCache("sol", report("SOL"), 1_000_000);
    assert.equal(loadIntelCache("sol", 1_000_000 + 60_000)?.topic, "SOL");
    assert.equal(loadIntelCache("sol", 1_000_000 + INTEL_TTL_MS), null);
    assert.equal(loadIntelCache("sol", 1_000_000 + INTEL_TTL_MS + 1), null);
  });
  it("treats corrupt files as miss", () => {
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(intelCachePath("bad"), "not json{{{");
    assert.equal(loadIntelCache("bad", 1_000_000), null);
  });
});

const stubGet: IntelGet = {
  text: async (url) => {
    if (url.includes("cointelegraph")) return RSS;
    throw new Error("feed down");
  },
  json: async (url) => {
    if (url.includes("stocktwits"))
      return {
        messages: [
          { body: "SOL to the moon", entities: { sentiment: { basic: "Bullish" } } },
          { body: "taking profit here", entities: { sentiment: { basic: "Bearish" } } },
        ],
      };
    if (url.includes("coingecko"))
      return {
        market_data: {
          current_price: { usd: 123.45 },
          price_change_percentage_24h: 2.5,
          price_change_percentage_7d: -1.2,
          market_cap_rank: 6,
        },
        community_data: { twitter_followers: 3000000 },
      };
    if (url.includes("alternative.me")) return { data: [{ value: "62", value_classification: "Greed" }] };
    throw new Error("unknown url");
  },
};

describe("buildIntelReport", () => {
  it("assembles news + social + catalysts + market with stub fetch", async () => {
    const r = await buildIntelReport("Solana", { limit: 5, get: stubGet, nowMs: 2_000_000 });
    assert.equal(r.topic, "Solana");
    assert.equal(r.news.length, 1);
    assert.equal(r.social.symbol, "SOL");
    assert.equal(r.social.stocktwits.attempted, true);
    assert.equal(r.social.stocktwits.bullish, 1);
    assert.equal(r.social.stocktwits.bearish, 1);
    assert.ok(r.market && r.market.priceUsd === 123.45);
    assert.equal(r.fearGreed?.value, 62);
    // two feeds failed → warnings recorded, nothing thrown
    assert.ok(r.warnings.length >= 2);
  });
  it("degrades gracefully when every source fails", async () => {
    const dead: IntelGet = {
      text: async () => {
        throw new Error("down");
      },
      json: async () => {
        throw new Error("down");
      },
    };
    const r = await buildIntelReport("SOL", { limit: 5, get: dead, nowMs: 2_000_000 });
    assert.equal(r.news.length, 0);
    assert.equal(r.market, null);
    assert.ok(r.warnings.length > 0);
  });
});
