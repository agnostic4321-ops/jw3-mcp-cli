import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { impliedRoi, isCompetitive, isDecided, rankCompare } from "./math.js";

describe("impliedRoi", () => {
  it("pays (1-p)/p", () => {
    assert.equal(impliedRoi(0.5), 1);
    assert.ok(Math.abs((impliedRoi(0.645) as number) - 0.5504) < 0.001);
  });
  it("rejects non-prices", () => {
    assert.equal(impliedRoi(0), null);
    assert.equal(impliedRoi(1), null);
    assert.equal(impliedRoi(NaN), null);
  });
});

describe("filters", () => {
  it("flags decided legs", () => {
    assert.equal(isDecided([0.001, 1.0]), true);
    assert.equal(isDecided([0.645, 0.355]), false);
  });
  it("flags competitive books", () => {
    assert.equal(isCompetitive([0.515, 0.485]), true);
    assert.equal(isCompetitive([0.939, 0.061]), true);
    assert.equal(isCompetitive([0.001, 1.0]), false);
    assert.equal(isCompetitive([0.5]), false);
  });
});

describe("rankCompare", () => {
  it("orders competitive, undecided, liquid first", () => {
    const rows = [
      { liq: 900000, days: 0.1, competitive: false, decided: true },
      { liq: 100000, days: 0.3, competitive: true, decided: false },
      { liq: 800000, days: 0.3, competitive: true, decided: false },
    ];
    const sorted = [...rows].sort(rankCompare);
    assert.equal(sorted[0]?.liq, 800000);
    assert.equal(sorted[1]?.liq, 100000);
    assert.equal(sorted[2]?.liq, 900000);
  });
});
