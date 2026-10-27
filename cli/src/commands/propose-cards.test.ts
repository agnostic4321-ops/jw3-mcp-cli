// `jw3 propose-*` CLI validation — pure arg checks, no network.
// Approval cards only: every validator must fail closed on placeholders
// (0/null prices, missing venue, invented addresses) before a tool call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROPOSE_CARDS_USAGE,
  parseIdeaTargets,
  validateProposeBracket,
  validateProposeCloseAll,
  validateProposeIdea,
  validateProposePredict,
  validateProposeWithdraw,
} from "./propose-cards.js";

describe("jw3 propose-* CLI validation", () => {
  it("documents all five proposal-card subcommands", () => {
    assert.ok(PROPOSE_CARDS_USAGE.includes("jw3 propose-idea"), "usage must document `jw3 propose-idea`");
    assert.ok(PROPOSE_CARDS_USAGE.includes("jw3 propose-bracket"), "usage must document `jw3 propose-bracket`");
    assert.ok(PROPOSE_CARDS_USAGE.includes("jw3 propose-predict"), "usage must document `jw3 propose-predict`");
    assert.ok(PROPOSE_CARDS_USAGE.includes("jw3 propose-close-all"), "usage must document `jw3 propose-close-all`");
    assert.ok(PROPOSE_CARDS_USAGE.includes("jw3 propose-withdraw"), "usage must document `jw3 propose-withdraw`");
  });

  it("parses --target legs and refuses bad shapes", () => {
    const ok = parseIdeaTargets("70000:0.5,75000");
    assert.deepEqual(ok.targets, [{ price: 70000, weight: 0.5 }, { price: 75000, weight: null }]);
    assert.ok(parseIdeaTargets("70000,71000,72000,73000").error, "4 legs must be refused");
    assert.ok(parseIdeaTargets("0").error, "a zero price must be refused");
    assert.ok(parseIdeaTargets("70000:2").error, "a weight above 1 must be refused");
  });

  it("validates idea cards: orientation, thesis, and targets", () => {
    const base = { pair: "BTC/USDT", side: "buy", entry: 65000, stop: 63000, thesis: "breakout retest" };
    assert.equal(validateProposeIdea({ ...base, targets: [{ price: 68000, weight: null }] }), null);
    assert.ok(
      validateProposeIdea({ ...base, stop: 66000 }),
      "a long stop above entry must be refused",
    );
    assert.ok(
      validateProposeIdea({ ...base, targets: [{ price: 64000, weight: null }] }),
      "a long target below entry must be refused",
    );
    assert.ok(validateProposeIdea({ ...base, thesis: "" }), "a missing thesis must be refused");
    assert.ok(
      validateProposeIdea({ ...base, entry: 0, targets: [{ price: 68000, weight: null }] }),
      "a zero entry placeholder must be refused",
    );
    assert.equal(
      validateProposeIdea({ ...base, side: "long", targets: [{ price: 68000, weight: null }] }),
      null,
      "long must be accepted as a buy alias",
    );
  });

  it("validates bracket cards: limit needs a price, tp is required", () => {
    const base = {
      exchange: "kucoin", pair: "BTC/USDT", side: "sell", entryType: "market",
      amount: "0.05", stop: 66000, tpRaw: "64000:50,63000:50", rationale: "range breakdown",
    };
    assert.equal(validateProposeBracket(base), null);
    assert.ok(
      validateProposeBracket({ ...base, entryType: "limit" }),
      "a limit entry without entry-price must be refused",
    );
    assert.equal(
      validateProposeBracket({ ...base, entryType: "limit", entryPrice: 65500 }),
      null,
    );
    assert.ok(validateProposeBracket({ ...base, tpRaw: undefined }), "a missing tp must be refused");
    assert.ok(validateProposeBracket({ ...base, rationale: "" }), "a missing rationale must be refused");
  });

  it("validates prediction cards: JEV verdict is required", () => {
    const base = { marketId: "0xabc", side: "yes", jevVerdict: "long BTC", rationale: "orderflow divergence" };
    assert.equal(validateProposePredict(base), null);
    assert.ok(
      validateProposePredict({ ...base, jevVerdict: "" }),
      "a prediction without a JEV verdict must be refused — analyze first",
    );
    assert.ok(validateProposePredict({ ...base, side: "maybe" }), "side must be yes|no");
    assert.ok(validateProposePredict({ ...base, venue: "kalshi" }), "venue must be polymarket|opinion");
    assert.ok(validateProposePredict({ ...base, confidence: 2 }), "confidence must be 0..1");
  });

  it("validates close-all cards: limit legs need a price", () => {
    assert.equal(validateProposeCloseAll({ rationale: "risk off" }), null);
    assert.equal(
      validateProposeCloseAll({ rationale: "risk off", exchange: "kucoin", orderType: "limit", limitPrice: "65000" }),
      null,
    );
    assert.ok(
      validateProposeCloseAll({ rationale: "risk off", orderType: "limit" }),
      "a limit flatten without limit-price must be refused",
    );
    assert.ok(
      validateProposeCloseAll({ rationale: "risk off", limitPrice: "65000" }),
      "a market flatten with a price must be refused",
    );
    assert.ok(validateProposeCloseAll({ rationale: "" }), "a missing rationale must be refused");
  });

  it("validates withdrawal cards: full user-confirmed address required", () => {
    const base = {
      sourceExchange: "kucoin", asset: "USDT", network: "ETH",
      amount: "500", destAddress: "0x1111111111111111111111111111111111111111",
      rationale: "cold storage",
    };
    assert.equal(validateProposeWithdraw(base), null);
    assert.ok(
      validateProposeWithdraw({ ...base, destAddress: "" }),
      "a missing destination must be refused — never invented",
    );
    assert.ok(
      validateProposeWithdraw({ ...base, destAddress: "0x123" }),
      "a truncated destination must be refused",
    );
    assert.ok(validateProposeWithdraw({ ...base, amount: "0" }), "a zero amount must be refused");
  });
});
