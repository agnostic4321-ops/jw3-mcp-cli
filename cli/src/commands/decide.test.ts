import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DECIDE_JEVLESS_CONF_CAP,
  buildMarketState,
  decideSymbolForPair,
  fetchLayaVerdict,
  jevSideForBridge,
  jevToFeatures,
  marketStateForBridge,
  parseLayaOutput,
  validateDecidePair,
  type MarketState,
} from "./decide.js";

/** 60 rising hourly bars: [ts,open,high,low,close,vol,turnover]. */
function mockKlines(n = 60): number[][] {
  const rows: number[][] = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const c = 100 + i * 0.1;
    rows.push([t0 + i * 3_600_000, c - 0.05, c + 0.1, c - 0.1, c, 1000 + (i % 12) * 10, c * 1000]);
  }
  return rows;
}

const mockTicker = {
  price: 106,
  bestBid: 105.99,
  bestAsk: 106.01,
  bestBidSize: 10,
  bestAskSize: 10,
};

const mockDepth = {
  bids: [["105.99", "5"], ["105.98", "3"], ["105.97", "2"], ["105.96", "1"], ["105.95", "1"]] as [string, string][],
  asks: [["106.01", "4"], ["106.02", "2"], ["106.03", "2"], ["106.04", "1"], ["106.05", "1"]] as [string, string][],
};

const mockJevBull = async () => ({
  model: "JEV",
  verdict: { trend: { verdict: "bullish", agreement: 0.7, uncertain: false } },
});

const mockDeps = {
  klinesRaw: async () => mockKlines(),
  tickerFull: async () => mockTicker,
  depth20: async () => mockDepth,
  contractSpec: async () => ({ multiplier: 1, tick: 0.01 }),
  jevTrend: mockJevBull,
  now: () => 1_700_000_000_000 + 61 * 3_600_000,
};

/** Run with no resolvable PAT: JEV leg must abstain without a network call. */
function withoutPat<T>(fn: () => Promise<T>): Promise<T> {
  const keepPat = process.env["JW3_MCP_PAT"];
  const keepHome = process.env["JW3_CONFIG_HOME"];
  process.env["JW3_MCP_PAT"] = "";
  process.env["JW3_CONFIG_HOME"] = "/nonexistent-jw3-test-config";
  return fn().finally(() => {
    if (keepPat === undefined) delete process.env["JW3_MCP_PAT"];
    else process.env["JW3_MCP_PAT"] = keepPat;
    if (keepHome === undefined) delete process.env["JW3_CONFIG_HOME"];
    else process.env["JW3_CONFIG_HOME"] = keepHome;
  });
}

const goodBridge = {
  choice: "long",
  confidence: 0.72,
  score: 0.55,
  reasons: ["jev long (agreement 0.70)"],
  ms: 1,
};

describe("decideSymbolForPair", () => {
  it("maps pairs to futures symbols, BTC aliases XBT", () => {
    assert.equal(decideSymbolForPair("SOL/USDT"), "SOLUSDTM");
    assert.equal(decideSymbolForPair("btc/usdt"), "XBTUSDTM");
  });
  it("rejects non-USDT quotes and malformed pairs", () => {
    assert.equal(decideSymbolForPair("ETH/USD"), null);
    assert.equal(decideSymbolForPair("ETH"), null);
  });
});

describe("validateDecidePair", () => {
  it("accepts BASE/USDT and rejects the rest", () => {
    assert.equal(validateDecidePair("SOL/USDT"), null);
    assert.notEqual(validateDecidePair("SOL"), null);
    assert.notEqual(validateDecidePair("SOL/USD"), null);
  });
});

describe("jevToFeatures (pure JEV leg)", () => {
  it("takes a side only on certain directional verdicts", () => {
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "Strong Bullish", agreement: 0.7, uncertain: false } } })?.side, "long");
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "bearish", agreement: 0.6, uncertain: false } } })?.side, "short");
  });
  it("collapses uncertain and neutral verdicts to flat", () => {
    const u = jevToFeatures({ verdict: { trend: { verdict: "Strong Bullish", agreement: 0.9, uncertain: true } } })!;
    assert.equal(u.side, "flat");
    assert.equal(u.uncertain, true);
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "neutral", agreement: 0.4, uncertain: false } } })?.side, "flat");
  });
  it("returns null when there is no trend to read", () => {
    assert.equal(jevToFeatures(null), null);
    assert.equal(jevToFeatures({}), null);
  });
  it("clamps agreement into 0..1", () => {
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "bullish", agreement: 9, uncertain: false } } })?.agreement, 1);
  });
  it("takes a side on the server's long/short verdict vocabulary", () => {
    // combineTrendVerdict (edge _shared/jev.ts) emits long/short/
    // strong_long/strong_short — the JEV leg used to report FLAT on all of
    // them, so Laya never received the model's direction.
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "long", agreement: 0.73, uncertain: false } } })?.side, "long");
    assert.equal(
      jevToFeatures({ verdict: { trend: { verdict: "strong_long", agreement: 0.91, uncertain: false } } })?.side,
      "long",
    );
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "short", agreement: 0.67, uncertain: false } } })?.side, "short");
    assert.equal(
      jevToFeatures({ verdict: { trend: { verdict: "strong_short", agreement: 0.88, uncertain: false } } })?.side,
      "short",
    );
    assert.equal(jevToFeatures({ verdict: { trend: { verdict: "mixed", agreement: 0.4, uncertain: false } } })?.side, "flat");
  });
});

describe("jevSideForBridge", () => {
  it("folds flat/uncertain/missing JEV to none", () => {
    assert.equal(jevSideForBridge({ side: "long", agreement: 0.7, uncertain: false, verdict: "bullish" }), "long");
    assert.equal(jevSideForBridge({ side: "long", agreement: 0.9, uncertain: true, verdict: "bullish" }), "none");
    assert.equal(jevSideForBridge({ side: "flat", agreement: 0.4, uncertain: false, verdict: "neutral" }), "none");
    assert.equal(jevSideForBridge(null), "none");
  });
});

describe("parseLayaOutput (mocked bridge shape)", () => {
  it("accepts a well-formed verdict", () => {
    assert.deepEqual(parseLayaOutput(goodBridge), goodBridge);
  });
  it("clamps confidence into 0..1 instead of rejecting", () => {
    assert.equal(parseLayaOutput({ ...goodBridge, confidence: 1.5 })?.confidence, 1);
    assert.equal(parseLayaOutput({ ...goodBridge, confidence: -2 })?.confidence, 0);
  });
  it("rejects bad choices, non-numeric scores, dirty reasons, non-objects", () => {
    assert.equal(parseLayaOutput({ ...goodBridge, choice: "moon" }), null);
    assert.equal(parseLayaOutput({ ...goodBridge, score: NaN }), null);
    assert.equal(parseLayaOutput({ ...goodBridge, reasons: ["ok", 7] }), null);
    assert.equal(parseLayaOutput({ ...goodBridge, ms: -1 }), null);
    assert.equal(parseLayaOutput(null), null);
    assert.equal(parseLayaOutput("long"), null);
  });
});

describe("buildMarketState (mocked reads, no network)", () => {
  it("assembles tape, book, and JEV legs", async () => {
    const s = await buildMarketState("SOL/USDT", "kucoin", { pat: "test-pat" }, mockDeps as never);
    assert.equal(s.pair, "SOL/USDT");
    assert.equal(s.symbol, "SOLUSDTM");
    assert.equal(s.last, 106);
    assert.ok(s.tape.chg > 0, "rising mock tape reads positive");
    assert.equal(s.tape.vslope, "up");
    assert.equal(s.tape.n, 60);
    assert.ok(s.book !== null && s.book.imb > 0, "heavier mock bids read bid-skewed");
    assert.equal(s.jev?.side, "long");
    assert.equal(s.jevNote, undefined);
  });
  it("abstains the JEV leg without a PAT and keeps tape+book", async () => {
    const s = await withoutPat(() => buildMarketState("SOL/USDT", "kucoin", {}, mockDeps as never));
    assert.equal(s.jev, null);
    assert.ok(s.jevNote?.includes("not authenticated"));
    assert.ok(s.tape.n >= 24 && s.book !== null);
  });
  it("nulls the book leg when the depth read fails, never invents one", async () => {
    const s = await buildMarketState(
      "SOL/USDT",
      "kucoin",
      { pat: "x" },
      { ...mockDeps, depth20: async () => { throw new Error("book down"); } } as never,
    );
    assert.equal(s.book, null);
    assert.ok(s.tape.n >= 24);
  });
  it("throws on a thin tape instead of inventing a state", async () => {
    await assert.rejects(
      buildMarketState("SOL/USDT", "kucoin", { pat: "x" }, { ...mockDeps, klinesRaw: async () => [] } as never),
      /thin tape/,
    );
  });
});

describe("marketStateForBridge", () => {
  it("sends a compact state with the JEV side folded", async () => {
    const s = await buildMarketState("SOL/USDT", "kucoin", { pat: "x" }, mockDeps as never);
    const wire = marketStateForBridge(s) as Record<string, unknown>;
    assert.equal((wire["jev"] as { side: string }).side, "long");
    const flat = marketStateForBridge({ ...s, jev: { side: "long", agreement: 0.9, uncertain: true, verdict: "bullish" } });
    assert.equal((flat["jev"] as { side: string }).side, "none");
    const none = marketStateForBridge({ ...s, jev: null });
    assert.equal(none["jev"], null);
  });
});

describe("fetchLayaVerdict (mocked bridge, no python)", () => {
  const state = {
    pair: "SOL/USDT",
    symbol: "SOLUSDTM",
    last: 106,
    tape: { chg: 1.2, vratio: 1.3, vslope: "up", offHighPct: 0.5, offLowPct: 2.1, atrPct: 0.8, n: 60 },
    book: { mid: 106, sprBps: 2, bid5Usd: 60000, ask5Usd: 40000, imb: 0.2 },
    jev: { side: "long", agreement: 0.7, uncertain: false, verdict: "bullish" },
  } as MarketState;

  it("returns the bridge verdict and sends valid market-state stdin", async () => {
    let seen = "";
    const v = await fetchLayaVerdict(state, (stdin) => {
      seen = stdin;
      return { status: 0, stdout: JSON.stringify(goodBridge), stderr: "" };
    });
    assert.equal(v.choice, "long");
    assert.equal(v.confidence, 0.72);
    const wire = JSON.parse(seen) as Record<string, unknown>;
    assert.equal(wire["pair"], "SOL/USDT");
    assert.equal((wire["jev"] as { side: string }).side, "long");
    assert.equal(typeof (wire["tape"] as { chg: number }).chg, "number");
  });
  it("caps confidence when the JEV leg is missing", async () => {
    const v = await fetchLayaVerdict(
      { ...state, jev: null },
      () => ({ status: 0, stdout: JSON.stringify({ ...goodBridge, confidence: 0.9 }), stderr: "" }),
    );
    assert.ok(v.confidence <= DECIDE_JEVLESS_CONF_CAP);
  });
  it("throws on bridge exit failure, bad JSON, and bad shapes", async () => {
    await assert.rejects(fetchLayaVerdict(state, () => ({ status: 1, stdout: "", stderr: "boom" })), /exit 1/);
    await assert.rejects(fetchLayaVerdict(state, () => ({ status: 0, stdout: "not json", stderr: "" })), /non-JSON/);
    await assert.rejects(
      fetchLayaVerdict(state, () => ({ status: 0, stdout: JSON.stringify({ choice: "moon" }), stderr: "" })),
      /unexpected shape/,
    );
  });
});
