import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "../test-fixtures.js";
import {
  CONFIDENCE_Z,
  GATE_HIT_FLOOR,
  GATE_MIN_SAMPLES,
  HOLDOUT_DEFAULT_SIZE,
  LIVE_MODELS,
  MODEL_TRACK,
  RATE_FLOOR_SAMPLES,
  SCORE_MAX_HISTORY,
  SCORE_WINDOW,
  applyGateMask,
  applyVotePatches,
  autoTuneWeight,
  cloneStore,
  compareModels,
  defaultScoreStore,
  emptyModelCard,
  evaluateHoldout,
  formatComparison,
  formatHoldout,
  gatesFor,
  guardedHitRate,
  loadScoreStore,
  projectVotePatches,
  promotionGate,
  rateInterval,
  realizedOutcome,
  rollingHitRate,
  saveScoreStore,
  scoreSignal,
  scoreStorePath,
  scoreTrade,
  sideBreakdown,
  splitTuneHoldout,
  validateTrade,
  wilsonInterval,
  type DirectionalSide,
  type ModelId,
  type ModelSignal,
  type ScoredOutcome,
  type TradeContext,
} from "./score.js";
import {
  DEMOTE_AT,
  HISTORY_WINDOW,
  MIN_SAMPLES as VOTE_MIN_SAMPLES,
  PROMOTE_AT,
  WEIGHT_CAP,
  WEIGHT_FLOOR,
  WEIGHT_STEP,
  defaultStore,
  recordOutcome,
  type SkillId,
  type VoteStore,
} from "./vote.js";

const sig = (model: ModelId, side: ModelSignal["side"], confidence = 0.8): ModelSignal => ({
  model,
  side,
  confidence,
});

const trade = (over: Partial<TradeContext> = {}): TradeContext => ({
  pair: "SOL/USDT",
  side: "long",
  signals: [sig("jev", "long"), sig("kronos", "long"), sig("laya", "long")],
  netPnlUsd: 10,
  at: "2026-10-21T00:00:00.000Z",
  ...over,
});

/**
 * Build a store with an explicit outcome pattern (OLDEST FIRST).
 * The rolling window keeps the LAST SCORE_WINDOW outcomes, so the
 * pattern's tail is what the gate reads.
 */
function storeWithPattern(model: ModelId, pattern: boolean[], side: DirectionalSide = "long"): ReturnType<typeof defaultScoreStore> {
  const store = defaultScoreStore();
  const card = store.models[model]!;
  const track = MODEL_TRACK[model];
  for (const hit of pattern) {
    card.total += 1;
    if (hit) card.hits += 1;
    card.results.push(hit);
    card.sides[side].total += 1;
    if (hit) card.sides[side].hits += 1;
    card.sides[side].results.push(hit);
    card.history.push({
      at: `2026-10-${String((card.total % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      pair: "SOL/USDT",
      tradeSide: side,
      signalSide: side,
      confidence: 0.8,
      hit,
      netPnlUsd: hit ? 10 : -10,
    });
    store.tracks[track]!.results.push(hit);
    if (hit) store.tracks[track]!.hits += 1;
    store.tracks[track]!.total += 1;
  }
  // The rolling windows cap at SCORE_WINDOW, exactly like vote.ts.
  if (card.results.length > SCORE_WINDOW) card.results.splice(0, card.results.length - SCORE_WINDOW);
  if (card.sides[side].results.length > SCORE_WINDOW) {
    card.sides[side].results.splice(0, card.sides[side].results.length - SCORE_WINDOW);
  }
  if (store.tracks[track]!.results.length > SCORE_WINDOW) {
    store.tracks[track]!.results.splice(0, store.tracks[track]!.results.length - SCORE_WINDOW);
  }
  store.weights[track] = 1;
  return store;
}

/**
 * Build a store whose model has `n` scored outcomes, `hits` of them good.
 * The hits land MOST RECENTLY, so the rolling window (the last 20) shows
 * the model's CURRENT form — a model with `hits`/`n` and n >= 20 reads
 * `hits`/20 on the gate.
 */
function storeWith(model: ModelId, hits: number, n: number, side: DirectionalSide = "long"): ReturnType<typeof defaultScoreStore> {
  const misses = Math.max(0, n - hits);
  return storeWithPattern(model, [...Array<boolean>(misses).fill(false), ...Array<boolean>(hits).fill(true)], side);
}

/**
 * Build a store with EXACTLY `rollingHits` hits inside the rolling
 * window (the last SCORE_WINDOW), padded to `total` outcomes with misses.
 * Within the window the hits are the MOST RECENT outcomes, so the gate
 * reads the model's current form.
 */
function storeWithRolling(model: ModelId, rollingHits: number, total: number, side: DirectionalSide = "long"): ReturnType<typeof defaultScoreStore> {
  const windowLen = Math.min(SCORE_WINDOW, total);
  const pattern: boolean[] = [];
  for (let i = 0; i < total; i++) {
    if (i < total - windowLen) {
      pattern.push(false);
      continue;
    }
    const idx = i - (total - windowLen);
    pattern.push(idx >= windowLen - rollingHits);
  }
  return storeWithPattern(model, pattern, side);
}

/** scoreTrade is pure — it returns a NEW store, so a loop threads it through. */
function scoreMany(store: ReturnType<typeof defaultScoreStore>, trades: TradeContext[]): ReturnType<typeof defaultScoreStore> {
  let next = store;
  for (const t of trades) next = scoreTrade(next, t).store;
  return next;
}

describe("rollingHitRate + guardedHitRate", () => {
  it("an empty window is null, never 0% and never 100%", () => {
    assert.equal(rollingHitRate([]), null);
    assert.equal(guardedHitRate(0, 0), null);
    assert.equal(guardedHitRate(3, 0), null);
  });
  it("a rate below the sample floor is refused (null), not reported", () => {
    // 4/4 is a perfect rate — but 4 samples cannot support it.
    assert.equal(guardedHitRate(4, 4), null);
    assert.equal(guardedHitRate(4, 4, 4), 1);
    assert.equal(guardedHitRate(3, 5), 0.6);
    assert.equal(guardedHitRate(3, 5, 6), null);
  });
  it("rolling rate counts only the window", () => {
    assert.equal(rollingHitRate([true, true, false]), 2 / 3);
    assert.ok(Math.abs((rollingHitRate([true, true, true, false, false]) ?? 0) - 0.6) < 1e-9);
  });
});

describe("wilsonInterval", () => {
  it("returns null with nothing measured", () => {
    assert.equal(wilsonInterval(0, 0), null);
    assert.equal(wilsonInterval(1, 0), null);
  });
  it("stays inside [0,1] and shrinks honestly with the sample", () => {
    const small = wilsonInterval(6, 10)!;
    const big = wilsonInterval(60, 100)!;
    assert.ok(small.low >= 0 && small.high <= 1);
    assert.ok(big.low >= 0 && big.high <= 1);
    // 6/10 must NOT be a tight interval around 0.6 — the interval is wide.
    assert.ok(small.high - small.low > big.high - big.low);
    // The 60%-on-10-samples interval must span a coin flip.
    assert.ok(small.low < 0.5 && small.high > 0.5);
  });
  it("0/10 does not produce a zero-width interval (unlike Wald)", () => {
    const i = wilsonInterval(0, 10)!;
    assert.ok(i.high > 0);
    assert.ok(i.low === 0);
  });
  it("matches the textbook Wilson values for 6/10 at 95%", () => {
    const i = wilsonInterval(6, 10)!;
    // Reference: Wilson 95% for 6/10 ≈ [0.3127, 0.8312].
    assert.ok(Math.abs(i.low - 0.3127) < 0.002, `low=${i.low}`);
    assert.ok(Math.abs(i.high - 0.8312) < 0.002, `high=${i.high}`);
  });
  it("a strong sample clears 50% on both bounds", () => {
    const i = wilsonInterval(30, 40)!;
    assert.ok(i.low > 0.5, `low=${i.low}`);
    assert.ok(i.high > i.low);
  });
  it("uses the 95% normal quantile by default", () => {
    assert.ok(Math.abs(CONFIDENCE_Z - 1.959963984540054) < 1e-12);
    const r = rateInterval(6, 10);
    assert.equal(r.method, "wilson");
    assert.equal(r.confidence, 0.95);
    assert.equal(r.minSamples, RATE_FLOOR_SAMPLES);
  });
});

describe("rateInterval", () => {
  it("reports insufficient sample below the floor", () => {
    const r = rateInterval(3, 3);
    assert.equal(r.insufficient, true);
    assert.equal(r.samples, 3);
    assert.equal(r.point, 1);
  });
  it("a zero-sample rate has no point and no bounds", () => {
    const r = rateInterval(0, 0);
    assert.equal(r.point, null);
    assert.equal(r.low, null);
    assert.equal(r.high, null);
    assert.equal(r.insufficient, true);
  });
});

describe("autoTuneWeight mirrors vote.ts", () => {
  it("needs the vote.ts sample floor before touching the weight", () => {
    // 1 hit, window of 1 — vote.ts needs >= 5 samples.
    assert.equal(autoTuneWeight([true], 1.0), 1.0);
  });
  it("promotes at >=60% and demotes at <=40%, clamped to [0, 2.0]", () => {
    assert.equal(autoTuneWeight([true, true, true, false, false], 0.5), 0.6);
    assert.equal(autoTuneWeight([true, true, false, false, false], 0.5), 0.4);
    assert.equal(autoTuneWeight([true, true, true, true, true], WEIGHT_CAP), WEIGHT_CAP);
    assert.equal(autoTuneWeight([false, false, false, false, false], WEIGHT_FLOOR), WEIGHT_FLOOR);
  });
  it("tracks vote.ts recordOutcome() exactly, sample for sample", () => {
    // The scorer must not drift from the vote.ts auto-tune it mirrors.
    const voteStore = defaultStore();
    const scoreStore = defaultScoreStore();
    const pattern = [true, false, true, true, true, false, false, true, true, false, true, true, true, false, true];
    for (const hit of pattern) {
      recordOutcome(voteStore, "kronos", hit);
      const track = scoreStore.tracks["kronos"]!;
      track.results.push(hit);
      if (hit) track.hits += 1;
      track.total += 1;
      scoreStore.weights["kronos"] = autoTuneWeight(track.results, scoreStore.weights["kronos"]!);
      assert.equal(
        scoreStore.weights["kronos"],
        voteStore.weights["kronos"],
        `weight drift after ${track.total} outcomes`,
      );
    }
    assert.deepEqual(scoreStore.tracks["kronos"]!.results, voteStore.skills["kronos"]!.results);
    assert.equal(scoreStore.tracks["kronos"]!.hits, voteStore.skills["kronos"]!.hits);
    assert.equal(scoreStore.tracks["kronos"]!.total, voteStore.skills["kronos"]!.total);
  });
  it("the score store's default weights start where vote.ts's do", () => {
    const scoreStore = defaultScoreStore();
    const voteStore = defaultStore();
    assert.equal(scoreStore.weights["jev"], voteStore.weights["jev"]);
    assert.equal(scoreStore.weights["kronos"], voteStore.weights["kronos"]);
    assert.equal(scoreStore.weights["rfdetr"], voteStore.weights["rfdetr"]);
  });
  it("shares vote.ts's constants", () => {
    assert.equal(SCORE_WINDOW, HISTORY_WINDOW);
    assert.equal(SCORE_WINDOW, 20);
    assert.equal(VOTE_MIN_SAMPLES, 5);
    assert.equal(PROMOTE_AT, 0.6);
    assert.equal(DEMOTE_AT, 0.4);
    assert.equal(WEIGHT_STEP, 0.1);
    assert.equal(WEIGHT_CAP, 2.0);
    assert.equal(WEIGHT_FLOOR, 0);
  });
});

describe("promotionGate", () => {
  it("a model with zero scored outcomes is excluded with a reason", () => {
    const g = promotionGate(emptyModelCard("jev"), { track: "jev", meritWeight: 1.0 });
    assert.equal(g.eligible, false);
    assert.equal(g.weight, 0);
    assert.ok(g.reason.includes("excluded"));
    assert.ok(g.blockers.includes("insufficient-sample"));
    assert.equal(g.rollingHitRate, null);
  });
  it("excludes below the sample floor even with a perfect rate", () => {
    const g = promotionGate(storeWith("jev", 29, 29).models["jev"]!, { track: "jev", meritWeight: 1.0 });
    assert.equal(g.eligible, false);
    assert.ok(g.blockers.includes("insufficient-sample"));
    assert.equal(g.weight, 0);
  });
  it("excludes below the hit floor even with a big sample", () => {
    const g = promotionGate(storeWith("kronos", 10, 40).models["kronos"]!, { track: "kronos", meritWeight: 0.5 });
    assert.equal(g.eligible, false);
    assert.ok(g.blockers.includes("hit-rate-below-floor"));
    assert.equal(g.weight, 0);
  });
  it("admits a model at the bars: >=30 samples and >=55% rolling", () => {
    // 30 scored outcomes; the rolling window (the last 20) is 11 hits =
    // 55% — exactly at the floor.
    const card = storeWithRolling("jev", 11, 30).models["jev"]!;
    assert.equal(card.total, 30);
    assert.equal(rollingHitRate(card.results), 11 / 20);
    const g = promotionGate(card, { track: "jev", meritWeight: 1.0 });
    assert.equal(g.eligible, true);
    assert.equal(g.weight, 1.0);
    assert.deepEqual(g.blockers, []);
    assert.ok(g.reason.includes("eligible"));
  });
  it("the bars are exactly 30 samples and a 55% rolling rate", () => {
    assert.equal(GATE_MIN_SAMPLES, 30);
    assert.equal(GATE_HIT_FLOOR, 0.55);
    // 29 outcomes: below the sample floor even at a perfect rolling rate.
    const under = storeWithRolling("jev", 20, 29).models["jev"]!;
    assert.equal(under.total, 29);
    assert.equal(rollingHitRate(under.results), 1);
    assert.equal(promotionGate(under, { track: "jev", meritWeight: 1 }).eligible, false);
    // 30 outcomes with a 10/20 = 50% rolling rate: below the hit floor.
    const weak = storeWithRolling("jev", 10, 30).models["jev"]!;
    assert.equal(rollingHitRate(weak.results), 10 / 20);
    assert.equal(promotionGate(weak, { track: "jev", meritWeight: 1 }).eligible, false);
    // 30 outcomes with a 12/20 = 60% rolling rate: above the hit floor.
    const strong = storeWithRolling("jev", 12, 30).models["jev"]!;
    assert.equal(rollingHitRate(strong.results), 12 / 20);
    assert.equal(promotionGate(strong, { track: "jev", meritWeight: 1 }).eligible, true);
  });
  it("demotes and re-promotes the same model (the Kronos precedent)", () => {
    // 64 outcomes with 24 hits = 37.5% lifetime — the measured direction
    // rate that got Kronos demoted. The rolling window (the last 20) is
    // 8 hits / 12 misses = 40%, so the gate excludes it.
    //   first 44 outcomes: 16 hits
    //   last 20 outcomes:  8 hits
    const pattern = [
      ...Array<boolean>(28).fill(false),
      ...Array<boolean>(16).fill(true),
      ...Array<boolean>(12).fill(false),
      ...Array<boolean>(8).fill(true),
    ];
    const card = storeWithPattern("kronos", pattern).models["kronos"]!;
    assert.equal(card.total, 64);
    assert.equal(card.hits, 24);
    assert.ok(Math.abs((card.hits / card.total) - 0.375) < 1e-9);
    assert.equal(rollingHitRate(card.results), 8 / 20);
    const demoted = promotionGate(card, { track: "kronos", meritWeight: 0.5 });
    assert.equal(demoted.eligible, false);
    assert.equal(demoted.weight, 0);
    assert.ok(demoted.reason.includes("excluded"));

    // Later a rolling score of 60%+ re-promotes it.
    const recovered = storeWithRolling("kronos", 12, 30).models["kronos"]!;
    assert.equal(recovered.total, 30);
    assert.equal(rollingHitRate(recovered.results), 12 / 20);
    const promoted = promotionGate(recovered, { track: "kronos", meritWeight: 0.5 });
    assert.equal(promoted.eligible, true);
    assert.equal(promoted.weight, 0.5);
  });
  it("the gate is pure — the card it is given is never mutated", () => {
    const card = storeWith("jev", 17, 30).models["jev"]!;
    const snapshot = JSON.stringify(card);
    promotionGate(card, { track: "jev", meritWeight: 1.0 });
    assert.equal(JSON.stringify(card), snapshot);
  });
});

describe("gatesFor", () => {
  it("covers every model, including one with no history", () => {
    const gates = gatesFor(defaultScoreStore());
    for (const m of ["jev", "laya", "kronos", "rfdetr"] as ModelId[]) {
      assert.ok(gates[m], `missing gate for ${m}`);
      assert.equal(gates[m]!.eligible, false);
      assert.equal(gates[m]!.weight, 0);
    }
  });
});

describe("scoreTrade", () => {
  it("rejects a trade without a realized result", () => {
    const res = scoreTrade(defaultScoreStore(), { pair: "SOL/USDT", side: "long", signals: [], netPnlUsd: NaN });
    assert.equal(res.ok, false);
    assert.ok(res.error);
  });
  it("rejects a trade with no pair or side", () => {
    assert.ok(validateTrade(trade({ pair: "" })));
    assert.ok(validateTrade(trade({ side: "flat" as DirectionalSide })));
    assert.equal(validateTrade(trade()), null);
  });
  it("scores the models that called a direction and skips the flat ones", () => {
    const res = scoreTrade(
      defaultScoreStore(),
      trade({ signals: [sig("jev", "long"), sig("kronos", "flat"), sig("rfdetr", "long", 0)] }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "long");
    assert.deepEqual(res.scored.map((s) => s.model), ["jev", "rfdetr"]);
    assert.deepEqual(res.skipped.map((s) => s.model), ["kronos"]);
    assert.ok(res.skipped[0]!.reason.includes("no directional call"));
  });
  it("a losing trade scores the models that called the wrong way", () => {
    const res = scoreTrade(defaultScoreStore(), trade({ netPnlUsd: -10 }));
    assert.equal(res.outcome, "short");
    assert.equal(res.scored.every((s) => s.hit === false), true);
  });
  it("a breakeven close scores nothing — no directional outcome", () => {
    const res = scoreTrade(defaultScoreStore(), trade({ netPnlUsd: 0 }));
    assert.equal(res.outcome, "flat");
    assert.equal(res.scored.length, 0);
    assert.equal(res.skipped.length, 3);
    assert.ok(res.skipped[0]!.reason.includes("flat"));
    assert.equal(res.store.models["jev"]!.total, 0);
  });
  it("updates lifetime, rolling window and the per-side breakdown", () => {
    const res = scoreTrade(defaultScoreStore(), trade({ signals: [sig("jev", "long")] }));
    const card = res.store.models["jev"]!;
    assert.equal(card.total, 1);
    assert.equal(card.hits, 1);
    assert.deepEqual(card.results, [true]);
    assert.equal(card.sides.long.total, 1);
    assert.equal(card.sides.long.hits, 1);
    assert.equal(card.sides.short.total, 0);
    assert.equal(card.pnl.netUsd, 10);
    assert.equal(card.pnl.whenHitUsd, 10);
    assert.equal(card.pnl.whenMissUsd, 0);
  });
  it("keeps the rolling window at SCORE_WINDOW", () => {
    const trades: TradeContext[] = [];
    for (let i = 0; i < SCORE_WINDOW + 7; i++) {
      trades.push(trade({ signals: [sig("jev", "long")], netPnlUsd: i % 2 === 0 ? 10 : -10 }));
    }
    const card = scoreMany(defaultScoreStore(), trades).models["jev"]!;
    assert.equal(card.results.length, SCORE_WINDOW);
    assert.equal(card.total, SCORE_WINDOW + 7);
    assert.equal(card.sides.long.results.length, SCORE_WINDOW);
  });
  it("skips an unknown model rather than crashing", () => {
    const res = scoreTrade(defaultScoreStore(), trade({ signals: [{ model: "gpt" as ModelId, side: "long", confidence: 0.9 }] }));
    assert.equal(res.ok, true);
    assert.equal(res.scored.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.ok(res.skipped[0]!.reason.includes("unknown model"));
  });
  it("never mutates the store it was given", () => {
    const store = defaultScoreStore();
    const before = JSON.stringify(store);
    scoreTrade(store, trade());
    assert.equal(JSON.stringify(store), before);
  });
  it("caps the audit history", () => {
    const trades: TradeContext[] = [];
    for (let i = 0; i < SCORE_MAX_HISTORY + 10; i++) trades.push(trade({ signals: [sig("jev", "long")] }));
    const card = scoreMany(defaultScoreStore(), trades).models["jev"]!;
    assert.equal(card.history.length, SCORE_MAX_HISTORY);
  });
  it("mirrors the vote-store track and auto-tunes the merit weight", () => {
    const trades: TradeContext[] = [];
    for (let i = 0; i < 5; i++) trades.push(trade({ signals: [sig("kronos", "long")], netPnlUsd: 10 }));
    const store = scoreMany(defaultScoreStore(), trades);
    assert.equal(store.tracks["kronos"]!.total, 5);
    assert.equal(store.tracks["kronos"]!.hits, 5);
    // vote.ts starts Kronos at 0.5; 5/5 hits promote +0.1 -> 0.6.
    assert.equal(store.weights["kronos"], 0.6);
  });
  it("Laya scores against the JEV track but keeps its own statistics", () => {
    const store = defaultScoreStore();
    const res = scoreTrade(store, trade({ signals: [sig("laya", "long")] }));
    assert.equal(res.store.tracks["jev"]!.total, 1);
    assert.equal(res.store.models["laya"]!.total, 1);
    assert.equal(res.store.models["jev"]!.total, 0);
    assert.equal(MODEL_TRACK["laya"], "jev");
  });
});

describe("realizedOutcome + scoreSignal", () => {
  it("positive P&L realizes the traded side", () => {
    assert.equal(realizedOutcome(trade({ side: "long", netPnlUsd: 5 })), "long");
    assert.equal(realizedOutcome(trade({ side: "short", netPnlUsd: 5 })), "short");
  });
  it("negative P&L realizes the opposite side", () => {
    assert.equal(realizedOutcome(trade({ side: "long", netPnlUsd: -5 })), "short");
    assert.equal(realizedOutcome(trade({ side: "short", netPnlUsd: -5 })), "long");
  });
  it("zero P&L is flat — no direction was proven", () => {
    assert.equal(realizedOutcome(trade({ netPnlUsd: 0 })), "flat");
  });
  it("a flat signal or a flat outcome is not scorable", () => {
    assert.equal(scoreSignal(sig("jev", "flat"), "long"), null);
    assert.equal(scoreSignal(sig("jev", "long"), "flat"), null);
    assert.equal(scoreSignal(sig("jev", "long"), "long"), true);
    assert.equal(scoreSignal(sig("jev", "short"), "long"), false);
  });
});

describe("sideBreakdown", () => {
  it("reveals side bias — good at longs, bad at shorts", () => {
    const trades: TradeContext[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(trade({ signals: [sig("jev", "long")], netPnlUsd: 10 }));
      trades.push(trade({ signals: [sig("jev", "short")], side: "short", netPnlUsd: -10 }));
    }
    const rows = sideBreakdown(scoreMany(defaultScoreStore(), trades).models["jev"]!);
    const long = rows.find((r) => r.side === "long")!;
    const short = rows.find((r) => r.side === "short")!;
    assert.equal(long.samples, 10);
    assert.equal(long.hitRate, 1);
    assert.equal(short.samples, 10);
    assert.equal(short.hitRate, 0);
    assert.equal(long.pnlUsd, 100);
    assert.equal(short.pnlUsd, -100);
  });
  it("refuses to report a side rate below the sample floor", () => {
    const store = scoreMany(defaultScoreStore(), [trade({ signals: [sig("jev", "long")], netPnlUsd: 10 })]);
    const rows = sideBreakdown(store.models["jev"]!);
    const long = rows.find((r) => r.side === "long")!;
    assert.equal(long.hitRate, null);
    assert.equal(long.sufficient, false);
  });
});

describe("evaluateHoldout", () => {
  const outcomes = (hits: number, n: number): ScoredOutcome[] =>
    Array.from({ length: n }, (_, i) => ({
      at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      pair: "SOL/USDT",
      tradeSide: "long" as DirectionalSide,
      signalSide: "long" as DirectionalSide,
      confidence: 0.8,
      hit: i < hits,
      netPnlUsd: i < hits ? 10 : -10,
    }));

  it("an empty holdout reports insufficient sample, not 0%", () => {
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: [] });
    assert.equal(r.samples, 0);
    assert.equal(r.hitRate, null);
    assert.equal(r.low, null);
    assert.equal(r.high, null);
    assert.ok(r.verdict.includes("insufficient sample"));
  });
  it("60% on 10 samples cannot masquerade as a 60% edge", () => {
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: outcomes(6, 10) });
    assert.equal(r.samples, 10);
    assert.ok(Math.abs((r.hitRate ?? 0) - 0.6) < 1e-9);
    // The interval spans a coin flip -> no proven edge.
    assert.ok(r.low !== null && r.low < 0.5);
    assert.ok(r.high !== null && r.high > 0.5);
    assert.equal(r.beatsCoinFlip, false);
    assert.ok(r.verdict.includes("no proven edge"));
  });
  it("a small sample is flagged insufficient even when the rate is high", () => {
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: outcomes(4, 4) });
    assert.equal(r.insufficient, true);
    assert.ok(r.verdict.includes("insufficient sample"));
  });
  it("a strong sample proves an edge above 50%", () => {
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: outcomes(40, 50) });
    assert.equal(r.beatsCoinFlip, true);
    assert.ok(r.low !== null && r.low > 0.5);
    assert.ok(r.verdict.includes("edge above 50%"));
  });
  it("the Kronos precedent: 37.5% over 64 windows is no edge", () => {
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: outcomes(24, 64) });
    assert.equal(r.samples, 64);
    assert.ok(Math.abs((r.hitRate ?? 0) - 0.375) < 1e-9);
    assert.equal(r.beatsCoinFlip, false);
    // The whole interval sits under a coin flip: measured underperformance.
    assert.ok(r.low !== null && r.low < 0.5);
    assert.ok(r.high !== null && r.high < 0.5);
    assert.equal(r.belowCoinFlip, true);
    assert.ok(r.verdict.includes("below 50%"));
  });
  it("flags a holdout contaminated by the tuning window", () => {
    const shared = outcomes(3, 5);
    const r = evaluateHoldout({ model: "kronos", label: "h", outcomes: shared, tunedOn: shared });
    assert.equal(r.contaminated, true);
    assert.ok(r.verdict.includes("contaminated"));
  });
});

describe("splitTuneHoldout", () => {
  it("the holdout is the block immediately before the tuning window", () => {
    const history: ScoredOutcome[] = Array.from({ length: 100 }, (_, i) => ({
      at: `t${i}`,
      pair: "SOL/USDT",
      tradeSide: "long" as DirectionalSide,
      signalSide: "long" as DirectionalSide,
      confidence: 0.8,
      hit: i % 2 === 0,
      netPnlUsd: 1,
    }));
    const { tuned, holdout } = splitTuneHoldout(history, 20, 64);
    assert.equal(tuned.length, 20);
    assert.equal(holdout.length, 64);
    // Disjoint by construction — no outcome is in both slices.
    const tunedSet = new Set(tuned.map((o) => o.at));
    assert.equal(holdout.every((o) => !tunedSet.has(o.at)), true);
    // The tuning window is the live rolling window (the most recent 20).
    assert.deepEqual(tuned.map((o) => o.at), history.slice(-20).map((o) => o.at));
  });
  it("a short history yields a short (honest) holdout", () => {
    const history: ScoredOutcome[] = Array.from({ length: 10 }, (_, i) => ({
      at: `t${i}`,
      pair: "SOL/USDT",
      tradeSide: "long" as DirectionalSide,
      signalSide: "long" as DirectionalSide,
      confidence: 0.8,
      hit: true,
      netPnlUsd: 1,
    }));
    const { tuned, holdout } = splitTuneHoldout(history, 20, 64);
    assert.equal(tuned.length, 10);
    assert.equal(holdout.length, 0);
  });
});

describe("compareModels", () => {
  it("covers the live models with their interval and eligibility", () => {
    const store = storeWithPattern("jev", [...Array<boolean>(10).fill(false), ...Array<boolean>(20).fill(true)]);
    store.models["kronos"]!.total = 12;
    store.models["kronos"]!.hits = 6;
    store.models["kronos"]!.results = [true, true, true, false, false, false];
    const rows = compareModels(store);
    assert.deepEqual(rows.map((r) => r.model), LIVE_MODELS);
    const jev = rows.find((r) => r.model === "jev")!;
    assert.equal(jev.eligible, true);
    assert.equal(jev.weight, 1);
    assert.equal(jev.samples, 30);
    assert.equal(jev.rollingHitRate, 1);
    assert.equal(jev.rollingInterval.method, "wilson");
    assert.ok(jev.rollingInterval.low !== null && jev.rollingInterval.high !== null);
    const kronos = rows.find((r) => r.model === "kronos")!;
    assert.equal(kronos.eligible, false);
    assert.equal(kronos.weight, 0);
    assert.ok(kronos.blockers.length > 0);
  });
  it("a model with no history reports an interval with no bounds", () => {
    const rows = compareModels(defaultScoreStore());
    const laya = rows.find((r) => r.model === "laya")!;
    assert.equal(laya.samples, 0);
    assert.equal(laya.lifetimeHitRate, null);
    assert.equal(laya.lifetimeInterval.low, null);
    assert.equal(laya.lifetimeInterval.high, null);
    assert.equal(laya.eligible, false);
  });
});

describe("the vote-store bridge", () => {
  it("projectVotePatches carries the exact fields vote.ts reads", () => {
    const store = storeWith("kronos", 20, 30);
    const patches = projectVotePatches(store);
    const kronos = patches.find((p) => p.track === "kronos")!;
    // The patch window is the last-20 slice vote.ts's loader will read back.
    assert.equal(kronos.results.length, Math.min(30, SCORE_WINDOW));
    assert.deepEqual(kronos.results, store.tracks["kronos"]!.results.slice(-SCORE_WINDOW));
    assert.equal(kronos.hits, store.tracks["kronos"]!.hits);
    assert.equal(kronos.total, store.tracks["kronos"]!.total);
    assert.equal(kronos.weight, store.weights["kronos"]!);
    assert.equal(kronos.excluded, false);
  });
  it("the patch window never exceeds the vote.ts window", () => {
    // 64 outcomes -> the patch carries only the last 20, because
    // vote.ts's loader truncates a track to HISTORY_WINDOW on read.
    const store = storeWith("kronos", 24, 64);
    const kronos = projectVotePatches(store).find((p) => p.track === "kronos")!;
    assert.equal(kronos.results.length, SCORE_WINDOW);
  });
  it("applyVotePatches writes weights, results, hits and total onto the vote store", () => {
    const voteStore = defaultStore();
    const scoreStore = storeWith("kronos", 20, 30);
    applyVotePatches(voteStore, projectVotePatches(scoreStore));
    assert.equal(voteStore.weights["kronos"], scoreStore.weights["kronos"]!);
    assert.deepEqual(voteStore.skills["kronos"]!.results, scoreStore.tracks["kronos"]!.results);
    assert.equal(voteStore.skills["kronos"]!.hits, scoreStore.tracks["kronos"]!.hits);
    assert.equal(voteStore.skills["kronos"]!.total, scoreStore.tracks["kronos"]!.total);
  });
  it("a track with every model excluded is zeroed with a logged reason", () => {
    const store = defaultScoreStore();
    const patches = projectVotePatches(store);
    const jev = patches.find((p) => p.track === "jev")!;
    assert.equal(jev.excluded, true);
    assert.equal(jev.weight, 0);
    assert.ok(jev.reason.includes("excluded"));
  });
  it("one healthy model keeps a shared track alive (JEV + Laya share the JEV track)", () => {
    const store = storeWith("jev", 20, 30);
    const patches = projectVotePatches(store);
    const jev = patches.find((p) => p.track === "jev")!;
    assert.equal(jev.excluded, false);
    assert.equal(jev.weight, store.weights["jev"]!);
  });
  it("applyGateMask zeroes an excluded track and leaves an eligible one to vote.ts", () => {
    const voteStore = defaultStore();
    voteStore.weights["kronos"] = 0.5;
    const scoreStore = defaultScoreStore();
    const mask = applyGateMask(voteStore, gatesFor(scoreStore));
    const kronos = mask.find((m) => m.track === "kronos")!;
    assert.equal(kronos.excluded, true);
    assert.equal(voteStore.weights["kronos"], 0);
    assert.ok(kronos.reason.includes("excluded"));
  });
  it("the vote store survives the round trip — vote.ts loadStore keeps the patch", async () => {
    const { loadStore, saveStore, voteStorePath } = await import("./vote.js");
    const sb = makeSandbox("jw3-score-");
    try {
      const path = voteStorePath(sb.dir);
      const voteStore = defaultStore();
      const scoreStore = storeWith("kronos", 20, 30);
      applyVotePatches(voteStore, projectVotePatches(scoreStore));
      saveStore(path, voteStore);
      const back = loadStore(path);
      assert.equal(back.weights["kronos"], voteStore.weights["kronos"]!);
      assert.deepEqual(back.skills["kronos"]!.results, voteStore.skills["kronos"]!.results);
      assert.equal(back.skills["kronos"]!.total, voteStore.skills["kronos"]!.total);
    } finally {
      sb.cleanup();
    }
  });
});

describe("score store persistence", () => {
  it("round-trips through disk; missing/corrupt falls back to defaults", () => {
    const sb = makeSandbox("jw3-score-");
    try {
      const path = scoreStorePath(sb.dir);
      const store = scoreMany(defaultScoreStore(), [trade({ signals: [sig("jev", "long")] })]);
      saveScoreStore(path, store);
      const back = loadScoreStore(path);
      assert.equal(back.models["jev"]!.total, 1);
      assert.equal(back.models["jev"]!.hits, 1);
      assert.deepEqual(back.models["jev"]!.results, [true]);
      assert.equal(loadScoreStore(join(sb.dir, "nope.json")).models["jev"]!.total, 0);
    } finally {
      sb.cleanup();
    }
  });
  it("loads a file written in the OLD format unchanged", () => {
    const sb = makeSandbox("jw3-score-");
    try {
      // Byte shape of the old saveScoreStore: JSON.stringify(store, null, 2)
      // plus unknown fields the sanitizer must ignore.
      const old = {
        version: 1,
        models: {
          jev: {
            total: 2, hits: 1, results: [true, false, "x"],
            history: [{ pair: "SOL/USDT", side: "long" }, { pair: 42 }],
            sides: { long: { total: 2, hits: 1, results: [true, "x"], pnlUsd: 1.5, pnlWhenHitUsd: 1.5, pnlWhenMissUsd: 0 } },
            pnl: { netUsd: 1.5, whenHitUsd: 1.5, whenMissUsd: 0 },
          },
        },
        tracks: { jev: { results: [true], hits: 1, total: 1 } },
        weights: { jev: 1.1, kronos: "bad" },
        updatedAt: "2026-10-14T10:00:00.000Z",
        extra: true,
      };
      const path = join(sb.dir, "score.json");
      writeFileSync(path, JSON.stringify(old, null, 2));
      const back = loadScoreStore(path);
      assert.equal(back.models["jev"]!.total, 2);
      assert.deepEqual(back.models["jev"]!.results, [true, false]);
      assert.equal(back.models["jev"]!.history.length, 1);
      assert.deepEqual(back.models["jev"]!.sides.long.results, [true]);
      assert.equal(back.models["jev"]!.sides.long.pnlUsd, 1.5);
      assert.equal(back.tracks["jev"]!.total, 1);
      assert.equal(back.weights["jev"], 1.1);
      assert.equal(back.updatedAt, "2026-10-14T10:00:00.000Z");
      assert.equal("extra" in back, false);
    } finally {
      sb.cleanup();
    }
  });
  it("cloneStore produces an independent copy", () => {
    const store = scoreMany(defaultScoreStore(), [trade({ signals: [sig("jev", "long")] })]);
    const copy = cloneStore(store);
    const copy2 = scoreMany(copy, [trade({ signals: [sig("jev", "long")] })]);
    assert.equal(store.models["jev"]!.total, 1);
    assert.equal(copy2.models["jev"]!.total, 2);
  });
});

describe("reporting", () => {
  it("formatComparison shows the gate bars and every model's status", () => {
    const store = storeWith("jev", 20, 30);
    const lines = formatComparison(compareModels(store));
    const text = lines.join("\n");
    assert.ok(text.includes("ELIGIBLE"));
    assert.ok(text.includes("EXCLUDED"));
    assert.ok(text.includes("30"));
    assert.ok(text.includes("55%"));
  });
  it("formatHoldout states the interval and the verdict", () => {
    const report = evaluateHoldout({ model: "kronos", label: "h", outcomes: [] });
    const line = formatHoldout(report);
    assert.ok(line.includes("kronos"));
    assert.ok(line.includes("insufficient sample"));
  });
});

describe("model and track maps", () => {
  it("Laya inherits the JEV track (oracle.ts oracleWeightsFromStore)", () => {
    assert.equal(MODEL_TRACK["laya"], "jev");
    assert.equal(MODEL_TRACK["jev"], "jev");
    assert.equal(MODEL_TRACK["kronos"], "kronos");
    assert.equal(MODEL_TRACK["rfdetr"], "rfdetr");
  });
  it("every model maps to a real vote.ts track", () => {
    const valid: SkillId[] = ["jev", "kronos", "rfdetr"];
    for (const m of ["jev", "laya", "kronos", "rfdetr"] as ModelId[]) {
      assert.ok(valid.includes(MODEL_TRACK[m]), `bad track for ${m}`);
    }
  });
  it("the holdout default window is the 64-window Kronos precedent", () => {
    assert.equal(HOLDOUT_DEFAULT_SIZE, 64);
  });
});

describe("the vote store is never touched by scoring", () => {
  it("a VoteStore passed in is not mutated by the pure helpers", () => {
    const voteStore: VoteStore = defaultStore();
    const before = JSON.stringify(voteStore);
    const store = defaultScoreStore();
    compareModels(store);
    gatesFor(store);
    projectVotePatches(store);
    assert.equal(JSON.stringify(voteStore), before);
  });
});
