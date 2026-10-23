import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectRows,
  filterPositions,
  formatPositionLine,
  matchesPair,
  normalizePair,
  validatePolls,
  validateWatchSec,
} from "./commands/market.js";

describe("normalizePair", () => {
  it("unifies separators and flat forms", () => {
    assert.equal(normalizePair("BTC/USDT"), "BTC/USDT");
    assert.equal(normalizePair("btc-usdt"), "BTC/USDT");
    assert.equal(normalizePair("btc_usdt"), "BTC/USDT");
    assert.equal(normalizePair("BTCUSDT"), "BTC/USDT");
  });
  it("maps venue XBT to BTC", () => {
    assert.equal(normalizePair("XBT/USDT"), "BTC/USDT");
  });
});

describe("matchesPair", () => {
  it("matches across spellings, rejects others", () => {
    assert.equal(matchesPair("BTC/USDT", "BTC/USDT"), true);
    assert.equal(matchesPair("BTC/USDT", "btc-usdt"), true);
    assert.equal(matchesPair("BTC/USDT", "BTCUSDT"), true);
    assert.equal(matchesPair("ETH/USDT", "BTC/USDT"), false);
  });
  it("empty filter matches everything", () => {
    assert.equal(matchesPair("ETH/USDT", ""), true);
  });
});

describe("validateWatchSec", () => {
  it("accepts 1..3600", () => {
    assert.equal(validateWatchSec(1), null);
    assert.equal(validateWatchSec(10), null);
    assert.equal(validateWatchSec(3600), null);
  });
  it("rejects garbage and out-of-range", () => {
    assert.ok(validateWatchSec(NaN));
    assert.ok(validateWatchSec(0));
    assert.ok(validateWatchSec(0.5));
    assert.ok(validateWatchSec(3601));
  });
});

describe("validatePolls", () => {
  it("accepts integers 1..100000", () => {
    assert.equal(validatePolls(1), null);
    assert.equal(validatePolls(60), null);
  });
  it("rejects fractions, zero and overflow", () => {
    assert.ok(validatePolls(0));
    assert.ok(validatePolls(1.5));
    assert.ok(validatePolls(NaN));
    assert.ok(validatePolls(100001));
  });
});

const envelope = (rows: unknown[]) => ({
  kind: "positions",
  observedAt: "2026-01-01T00:00:00.000Z",
  venues: [{ connectionId: "c1", exchange: "kucoin", label: null, ok: true, data: rows, error: null }],
});

describe("collectRows + filterPositions", () => {
  const rows = [
    { symbol: "BTC/USDT", side: "long", size: 1 },
    { symbol: "ETH/USDT", side: "short", size: 2 },
  ];
  it("collects venue rows and passes through without a filter", () => {
    const out = envelope(rows);
    assert.equal(collectRows(out).length, 2);
    const r = filterPositions(out, undefined);
    assert.equal(r.total, 2);
    assert.equal(r.kept, 2);
    assert.equal(r.filtered, out);
  });
  it("filters to one pair without mutating the input", () => {
    const out = envelope(rows);
    const r = filterPositions(out, "BTC/USDT");
    assert.equal(r.total, 2);
    assert.equal(r.kept, 1);
    const venues = (r.filtered as { venues: { data: { symbol: string }[] }[] }).venues;
    assert.deepEqual(venues[0]?.data.map((x) => x.symbol), ["BTC/USDT"]);
    // input untouched
    assert.equal((out.venues[0]?.data as unknown[]).length, 2);
  });
  it("matches flat/dashed spellings and keeps empty venues", () => {
    const r = filterPositions(envelope(rows), "btc-usdt");
    assert.equal(r.kept, 1);
    const r2 = filterPositions(envelope(rows), "SOL/USDT");
    assert.equal(r2.kept, 0);
    const venues = (r2.filtered as { venues: { data: unknown[] }[] }).venues;
    assert.deepEqual(venues[0]?.data, []);
  });
  it("filters bare arrays too", () => {
    const r = filterPositions(rows, "ETH/USDT");
    assert.deepEqual(r.filtered, [{ symbol: "ETH/USDT", side: "short", size: 2 }]);
  });
});

describe("formatPositionLine", () => {
  it("renders one readable line", () => {
    const line = formatPositionLine({
      symbol: "BTC/USDT",
      side: "long",
      size: 0.5,
      entryPrice: 60000,
      markPrice: 61000,
      unrealizedPnl: 500,
      leverage: 2,
    });
    assert.match(line, /BTC\/USDT/);
    assert.match(line, /LONG/);
    assert.match(line, /uPnL \$500\.00/);
    assert.match(line, /x2/);
  });
  it("never throws on missing numbers", () => {
    assert.doesNotThrow(() => formatPositionLine({ symbol: "ETH/USDT" }));
  });
});
