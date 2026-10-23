import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSENSUS_THRESHOLD,
  DEFAULT_WEIGHTS,
  HISTORY_WINDOW,
  combineWeightedVote,
  defaultStore,
  hitRate,
  jevToSignal,
  kronosToSignal,
  loadStore,
  normalizeVotePair,
  recordOutcome,
  resolveVote,
  rfdetrSignal,
  saveStore,
  validateVotePair,
  voteStorePath,
  type SkillSignal,
} from "./vote.js";

const sig = (over: Partial<SkillSignal> & { skill: SkillSignal["skill"] }): SkillSignal => ({
  side: "flat",
  confidence: 0,
  abstained: true,
  detail: "t",
  ...over,
});

describe("validateVotePair + normalizeVotePair", () => {
  it("accepts BASE/USDT, normalizes case", () => {
    assert.equal(validateVotePair("SOL/USDT"), null);
    assert.equal(validateVotePair("sol/usdt"), null);
    assert.equal(normalizeVotePair("sol/usdt"), "SOL/USDT");
  });
  it("rejects garbage without inventing", () => {
    assert.ok(validateVotePair(""));
    assert.ok(validateVotePair("SOL"));
    assert.ok(validateVotePair("SOL/USD"));
    assert.ok(validateVotePair("SOL/USDT/PERP"));
  });
});

describe("jevToSignal", () => {
  it("bull votes long, bear votes short with agreement as confidence", () => {
    const long = jevToSignal({ verdict: { trend: { verdict: "bullish", agreement: 0.72, uncertain: false } } });
    assert.equal(long.side, "long");
    assert.equal(long.abstained, false);
    assert.equal(long.confidence, 0.72);
    const short = jevToSignal({ verdict: { trend: { verdict: "bearish_strong", agreement: 0.9, uncertain: false } } });
    assert.equal(short.side, "short");
  });
  it("uncertain, neutral, missing, or null abstains", () => {
    assert.equal(jevToSignal(null).abstained, true);
    assert.equal(jevToSignal({}).abstained, true);
    assert.equal(jevToSignal({ verdict: null }).abstained, true);
    assert.equal(
      jevToSignal({ verdict: { trend: { verdict: "bullish", agreement: 0.8, uncertain: true } } }).abstained,
      true,
    );
    assert.equal(
      jevToSignal({ verdict: { trend: { verdict: "neutral", agreement: 0.5, uncertain: false } } }).abstained,
      true,
    );
  });
  it("votes the server's long/short verdict vocabulary (not just bull/bear)", () => {
    // combineTrendVerdict (edge _shared/jev.ts) emits long/short/
    // strong_long/strong_short — matching only "bull"/"bear" made the
    // primary oracle abstain on every real directional verdict.
    const long = jevToSignal({ verdict: { trend: { verdict: "long", agreement: 0.73, uncertain: false } } });
    assert.equal(long.side, "long");
    assert.equal(long.abstained, false);
    assert.equal(long.confidence, 0.73);
    const strongLong = jevToSignal({ verdict: { trend: { verdict: "strong_long", agreement: 0.91, uncertain: false } } });
    assert.equal(strongLong.side, "long");
    const short = jevToSignal({ verdict: { trend: { verdict: "short", agreement: 0.67, uncertain: false } } });
    assert.equal(short.side, "short");
    const strongShort = jevToSignal({ verdict: { trend: { verdict: "strong_short", agreement: 0.88, uncertain: false } } });
    assert.equal(strongShort.side, "short");
    assert.equal(jevToSignal({ verdict: { trend: { verdict: "mixed", agreement: 0.4, uncertain: false } } }).abstained, true);
  });
});

describe("kronosToSignal", () => {
  const base = { last_close: 100, pred_last_close: 101, pred_closes: [101], horizon: 12, lookback: 400, ms: 1 };
  it("up votes long, down votes short, conviction scales with move", () => {
    const up = kronosToSignal({ ...base, direction: "up", expected_move_pct: 0.42 });
    assert.equal(up.side, "long");
    assert.ok(Math.abs(up.confidence - 0.42) < 1e-9);
    const big = kronosToSignal({ ...base, direction: "down", expected_move_pct: -3 });
    assert.equal(big.side, "short");
    assert.equal(big.confidence, 1);
  });
  it("flat and null abstain", () => {
    assert.equal(kronosToSignal(null).abstained, true);
    assert.equal(kronosToSignal({ ...base, direction: "flat", expected_move_pct: 0 }).abstained, true);
  });
});

describe("rfdetrSignal", () => {
  it("abstains at weight 0 until the model is wired", () => {
    const s = rfdetrSignal();
    assert.equal(s.abstained, true);
    assert.equal(DEFAULT_WEIGHTS.rfdetr, 0);
  });
});

describe("combineWeightedVote", () => {
  it("default weights: JEV long beats Kronos short", () => {
    const c = combineWeightedVote(
      [
        sig({ skill: "jev", side: "long", confidence: 0.8, abstained: false }),
        sig({ skill: "kronos", side: "short", confidence: 0.6, abstained: false }),
        sig({ skill: "rfdetr" }),
      ],
      { ...DEFAULT_WEIGHTS },
    );
    // (0.8*1.0 - 0.6*0.5) / 1.5 = 1/3 → long
    assert.equal(c.side, "long");
    assert.equal(c.voters, 2);
    assert.ok(Math.abs(c.score - 1 / 3) < 1e-9);
  });
  it("zero-weight and abstained skills sit out of score and denominator", () => {
    const c = combineWeightedVote(
      [
        sig({ skill: "jev", side: "long", confidence: 1, abstained: false }),
        sig({ skill: "kronos", side: "short", confidence: 1, abstained: true }),
      ],
      { jev: 1, kronos: 0.5, rfdetr: 0 },
    );
    assert.equal(c.score, 1);
    assert.equal(c.voters, 1);
  });
  it("weak agreement inside the threshold is flat, never fabricated", () => {
    const c = combineWeightedVote(
      [
        sig({ skill: "jev", side: "long", confidence: CONSENSUS_THRESHOLD / 2, abstained: false }),
      ],
      { jev: 1, kronos: 0.5, rfdetr: 0 },
    );
    assert.equal(c.side, "flat");
  });
  it("empty ballot is flat with a reason", () => {
    const c = combineWeightedVote([sig({ skill: "jev" }), sig({ skill: "kronos" })], { ...DEFAULT_WEIGHTS });
    assert.equal(c.side, "flat");
    assert.equal(c.voters, 0);
  });
});

describe("recordOutcome auto-tune", () => {
  it("needs samples before touching weights", () => {
    const store = defaultStore();
    recordOutcome(store, "jev", true);
    assert.equal(store.weights["jev"], 1.0);
    assert.equal(hitRate(store.skills["jev"]!), 1);
  });
  it("promotes at ≥60% and demotes at ≤40%", () => {
    const up = defaultStore();
    for (let i = 0; i < 5; i++) recordOutcome(up, "kronos", i < 3);
    assert.equal(up.weights["kronos"], 0.6);
    const down = defaultStore();
    for (let i = 0; i < 5; i++) recordOutcome(down, "kronos", i < 2);
    assert.equal(down.weights["kronos"], 0.4);
  });
  it("rfdetr lifts off 0 on scored merit", () => {
    const store = defaultStore();
    for (let i = 0; i < 5; i++) recordOutcome(store, "rfdetr", true);
    assert.ok(store.weights["rfdetr"]! > 0);
  });
  it("window caps at HISTORY_WINDOW and weights clamp", () => {
    const store = defaultStore();
    for (let i = 0; i < HISTORY_WINDOW + 10; i++) recordOutcome(store, "jev", true);
    assert.equal(store.skills["jev"]!.results.length, HISTORY_WINDOW);
    assert.ok(store.weights["jev"]! <= 2.0);
    for (let i = 0; i < HISTORY_WINDOW * 3; i++) recordOutcome(store, "jev", false);
    assert.equal(store.weights["jev"], 0);
  });
});

describe("resolveVote", () => {
  it("scores the latest open ballot, skips abstains, marks resolved", () => {
    const store = defaultStore();
    store.votes.push({
      at: "t",
      pair: "SOL/USDT",
      side: "long",
      score: 0.5,
      signals: [
        sig({ skill: "jev", side: "long", confidence: 0.7, abstained: false }),
        sig({ skill: "kronos", side: "short", confidence: 0.4, abstained: false }),
        sig({ skill: "rfdetr" }),
      ],
      weights: { ...DEFAULT_WEIGHTS },
    });
    const res = resolveVote(store, "sol/usdt", "long");
    assert.ok(!("error" in res));
    if ("error" in res) return;
    assert.deepEqual(res.scored, { jev: true, kronos: false, rfdetr: null });
    assert.equal(res.record.resolved?.outcome, "long");
    const again = resolveVote(store, "SOL/USDT", "long");
    assert.ok("error" in again);
  });
  it("errors when no open ballot exists", () => {
    const res = resolveVote(defaultStore(), "SOL/USDT", "long");
    assert.ok("error" in res);
  });
});

describe("store persistence", () => {
  it("round-trips through disk; missing/corrupt falls back to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "jw3-vote-"));
    const path = voteStorePath(dir);
    const store = defaultStore();
    recordOutcome(store, "jev", true);
    saveStore(path, store);
    const back = loadStore(path);
    assert.equal(back.weights["jev"], 1.0);
    assert.equal(back.skills["jev"]!.total, 1);
    assert.equal(loadStore(join(dir, "nope.json")).weights["jev"], 1.0);
  });
});
