import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marketVersionOf, normalizeGamma, versionedTokenIds } from "./gamma.js";

const NOW = new Date("2026-09-28T12:00:00Z").getTime();

function gammaMarket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "Eagles vs. Bears",
    slug: "nfl-phi-chi-2026-09-29",
    conditionId: "0xabc",
    endDate: "2026-09-29T00:15:00Z",
    outcomes: '["Eagles", "Bears"]',
    outcomePrices: '["0.645", "0.355"]',
    clobTokenIds: '["111", "222"]',
    liquidityNum: 870770,
    volumeNum: 1018840,
    volume24hr: 812986,
    active: true,
    closed: false,
    ...over,
  };
}

describe("normalizeGamma", () => {
  it("parses stringified arrays + days", () => {
    const r = normalizeGamma(gammaMarket(), NOW);
    assert.ok(r);
    assert.deepEqual(r?.outcomes, ["Eagles", "Bears"]);
    assert.deepEqual(r?.prices, [0.645, 0.355]);
    assert.ok((r?.days as number) > 0 && (r?.days as number) < 1);
  });
  it("drops markets without two legs", () => {
    assert.equal(normalizeGamma(gammaMarket({ outcomePrices: '["0.5"]' }), NOW), null);
  });
  it("drops markets without endDate", () => {
    assert.equal(normalizeGamma(gammaMarket({ endDate: undefined, endDateIso: undefined }), NOW), null);
  });
  it("defaults unversioned legacy to v1 (clobTokenIds)", () => {
    const r = normalizeGamma(gammaMarket(), NOW);
    assert.equal(r?.version, 1);
    assert.deepEqual(r?.tokenIds, ["111", "222"]);
  });
  it("v2 selects positionIds and ignores clobTokenIds", () => {
    const r = normalizeGamma(
      gammaMarket({ version: "v2", positionIds: ["333", "444"], clobTokenIds: '["111", "222"]' }),
      NOW,
    );
    assert.equal(r?.version, 2);
    assert.deepEqual(r?.tokenIds, ["333", "444"]);
  });
  it("v1 ignores positionIds even when present", () => {
    const r = normalizeGamma(
      gammaMarket({ version: "v1", positionIds: ["333", "444"] }),
      NOW,
    );
    assert.equal(r?.version, 1);
    assert.deepEqual(r?.tokenIds, ["111", "222"]);
  });
  it("drops unsupported versions and non-decimal ids", () => {
    assert.equal(normalizeGamma(gammaMarket({ version: "v3" }), NOW), null);
    assert.equal(normalizeGamma(gammaMarket({ version: "v2", positionIds: [] }), NOW), null);
    assert.equal(
      normalizeGamma(gammaMarket({ version: "v2", positionIds: ["0xabc", "444"] }), NOW),
      null,
    );
  });
  it("drops id/outcome mismatches", () => {
    assert.equal(
      normalizeGamma(gammaMarket({ version: "v2", positionIds: ["333"] }), NOW),
      null,
    );
  });
});

describe("marketVersionOf / versionedTokenIds", () => {
  it("parses string + numeric versions, defaults missing to 1", () => {
    assert.equal(marketVersionOf({ version: "v2" }), 2);
    assert.equal(marketVersionOf({ version: 2 }), 2);
    assert.equal(marketVersionOf({ version: "v1" }), 1);
    assert.equal(marketVersionOf({}), 1);
    assert.ok(Number.isNaN(marketVersionOf({ version: "v9" })));
  });
  it("selects the version field and ignores the other", () => {
    const m = { clobTokenIds: ["1"], positionIds: ["2"] };
    assert.deepEqual(versionedTokenIds(m, 1), ["1"]);
    assert.deepEqual(versionedTokenIds(m, 2), ["2"]);
  });
});
