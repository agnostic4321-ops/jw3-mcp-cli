/**
 * `jw3 insights` — pure-helper tests. No network: cmdInsights is exercised by
 * the live smoke check, never here (this repo mocks no fetch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInsights, summarizeInsights, validateInsightsArgs } from "./insights.js";

test("validateInsightsArgs: absent args are valid (server defaults apply)", () => {
  assert.equal(validateInsightsArgs({}), null);
});

test("validateInsightsArgs: days must be an integer in 1..90", () => {
  assert.equal(validateInsightsArgs({ days: 30 }), null);
  assert.equal(validateInsightsArgs({ days: 1 }), null);
  assert.equal(validateInsightsArgs({ days: 90 }), null);
  for (const bad of [0, 91, -1, 1.5, Number.NaN]) {
    const msg = validateInsightsArgs({ days: bad });
    assert.equal(typeof msg, "string", `days=${bad} must be rejected`);
    assert.match(msg as string, /days/i);
  }
});

test("validateInsightsArgs: notional must be finite and positive", () => {
  assert.equal(validateInsightsArgs({ notionalUsd: 10_000 }), null);
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(typeof validateInsightsArgs({ notionalUsd: bad }), "string");
  }
});

test("validateInsightsArgs: feeBps stays in 0..100", () => {
  assert.equal(validateInsightsArgs({ feeBps: 0 }), null);
  assert.equal(validateInsightsArgs({ feeBps: 5 }), null);
  assert.equal(validateInsightsArgs({ feeBps: 100 }), null);
  for (const bad of [-1, 101, Number.NaN]) {
    assert.equal(typeof validateInsightsArgs({ feeBps: bad }), "string");
  }
});

const PAYLOAD = {
  observedAt: "2026-11-06T12:00:00.000Z",
  windowDays: 30,
  market: {
    btc: { price: 104_231, change24hPct: 2.34 },
    eth: { price: 3_120, change24hPct: -1.1 },
    fearGreed: { value: 72, classification: "Greed" },
  },
  funding: [
    { asset: "BTC", bestVenue: "hyperliquid", bestAprPct: 18.4, worstVenue: "binance", worstAprPct: -3.2, spreadPct: 21.6 },
  ],
  carry: [{ asset: "BTC", longVenue: "binance", shortVenue: "hyperliquid", net30dUsd: 142.5 }],
  venues: [{ venue: "hyperliquid", volume24hUsd: 3_100_000_000, sharePct: 46.2 }],
  fees: { count: 12, totalFeesUsd: 8.4, grossPnlUsd: 40, netPnlUsd: 31.6, feeRatioPct: 21 },
  news: [{ title: "ETF inflows continue", publisher: "Wire", url: "https://example.test/a", publishedAt: "2026-11-06T10:00:00.000Z" }],
  brief: "BTC 104,231 (+2.3%). Not financial advice.",
  gaps: ["venues"],
};

test("summarizeInsights: maps a full payload without inventing values", () => {
  const r = summarizeInsights(PAYLOAD, 30);
  assert.equal(r.windowDays, 30);
  assert.equal(r.observedAt, PAYLOAD.observedAt);
  assert.match(r.btc, /\$104\.2K/);
  assert.match(r.btc, /\+2\.3%/);
  assert.match(r.eth, /\$3\.1K/);
  assert.match(r.fearGreed, /72/);
  assert.match(r.fearGreed, /Greed/i);
  assert.equal(r.fundingTop.length, 1);
  assert.match(r.fundingTop[0] as string, /BTC/);
  assert.equal(r.carryTop.length, 1);
  assert.equal(r.venueTop.length, 1);
  assert.match(r.feesLine as string, /8\.4/);
  assert.equal(r.newsTop.length, 1);
  assert.match(r.newsTop[0] as string, /ETF inflows/);
  assert.equal(r.brief, PAYLOAD.brief);
  assert.deepEqual(r.gaps, ["venues"]);
});

test("summarizeInsights: an empty payload is unknown, never zero", () => {
  const r = summarizeInsights({}, 30);
  assert.equal(r.windowDays, 30);
  assert.equal(r.observedAt, null);
  assert.equal(r.btc, "unknown");
  assert.equal(r.eth, "unknown");
  assert.equal(r.fearGreed, "unknown");
  assert.deepEqual(r.fundingTop, []);
  assert.deepEqual(r.carryTop, []);
  assert.deepEqual(r.venueTop, []);
  assert.equal(r.feesLine, null);
  assert.deepEqual(r.newsTop, []);
  assert.equal(r.brief, "");
  assert.deepEqual(r.gaps, []);
});

test("summarizeInsights: garbage and string payloads never throw", () => {
  for (const bad of [null, undefined, 42, "not json", [], { market: null }]) {
    const r = summarizeInsights(bad, 30);
    assert.equal(r.btc, "unknown");
    assert.equal(r.windowDays, 30);
  }
  const parsed = summarizeInsights(JSON.stringify(PAYLOAD), 30);
  assert.equal(parsed.brief, PAYLOAD.brief);
});

test("summarizeInsights: a bad fallback window still yields a sane number", () => {
  const r = summarizeInsights({}, Number.NaN);
  assert.ok(Number.isInteger(r.windowDays) && r.windowDays > 0);
});

test("formatInsights: renders the window, the gaps and the brief, with no ANSI", () => {
  const text = formatInsights(summarizeInsights(PAYLOAD, 30));
  assert.match(text, /Insights — 30d window/);
  assert.match(text, /Gaps: venues/);
  assert.match(text, /Brief:/);
  assert.ok(text.includes(PAYLOAD.brief));
  assert.equal(text.includes("\u001b"), false);
});

test("formatInsights: unknown blocks read as unknown, not blank", () => {
  const text = formatInsights(summarizeInsights({}, 30));
  assert.match(text, /BTC: unknown/);
  assert.match(text, /Fees: unknown/);
  assert.match(text, /Gaps: none reported/);
});
