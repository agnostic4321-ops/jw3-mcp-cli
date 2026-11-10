/**
 * OQ-09 phase 1: one weighting module, one track store, the rubric as the
 * single tuning surface. The byte-identical decision pins live in
 * verdict-golden.test.ts; this file pins the parts the goldens cannot see.
 *
 *   1. The on-disk stores keep their paths and shapes: a vote.json and a
 *      score.json WRITTEN BY THE PRE-OQ-09 CODE (captured in the goldens)
 *      load and re-save byte-identical through the one track store.
 *   2. Every seat reads its weights and thresholds from the rubric: the
 *      seat constants are the rubric's values, and a rubric change reaches
 *      every seat's ballot and auto-tune (no seat keeps its own copy).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "../test-fixtures.js";
import { loadGoldens } from "../verdict-golden.cases.js";
import { VERDICT_TUNING } from "./rubric.js";
import { DEFAULT_ORACLE_WEIGHTS, DEFAULT_WEIGHTS, MODEL_TRACK, TRACK_FEED_PRIORITY, TRACK_MODELS, combineBallot, tuneWeight, type Ballot } from "./weighting.js";
import { defaultStore, loadStore, recordOutcome, saveStore, voteStorePath } from "./track-store.js";
import * as vote from "./vote.js";
import * as oracle from "./oracle.js";
import * as score from "./score.js";
import * as learning from "./learning.js";
import { DEFAULT_COMMITTEE_PARAMS, DEFAULT_SEAT_WEIGHTS, committeeModelLegs } from "./committee.js";

const sb = makeSandbox("jw3-oq09-weighting-");
after(() => sb.cleanup());

describe("track store: vote.json and score.json keep their paths and shapes", () => {
  const goldens = loadGoldens();
  const written = (name: string, file: string): string => {
    const text = goldens[name]?.files?.[file];
    assert.ok(text, `golden ${name} carries no ${file}`);
    return text;
  };

  it("paths are unchanged (beside credentials.json, explicit dir wins)", () => {
    assert.equal(voteStorePath("/x"), join("/x", "vote.json"));
    assert.equal(score.scoreStorePath("/x"), join("/x", "score.json"));
    assert.equal(vote.voteStorePath, voteStorePath);
  });

  it("a vote.json written by the pre-OQ-09 code loads and re-saves byte-identical", () => {
    for (const name of ["vote record long (hits promote), text", "vote then record then vote (the loop), text", "learning record x5 on the tuned store, low gate, json (+files)"]) {
      const before = written(name, "vote.json");
      const path = join(sb.dir, "vote.json");
      writeFileSync(path, before);
      saveStore(path, loadStore(path));
      assert.equal(readFileSync(path, "utf8"), before, name);
    }
  });

  it("a score.json written by the pre-OQ-09 code loads and re-saves byte-identical", () => {
    for (const name of ["score record from a vote ballot, text", "score record loss into an empty store, json"]) {
      const before = written(name, "score.json");
      const path = join(sb.dir, "score.json");
      writeFileSync(path, before);
      score.saveScoreStore(path, score.loadScoreStore(path));
      assert.equal(readFileSync(path, "utf8"), before, name);
    }
  });
});

describe("the rubric is the single tuning surface", () => {
  it("the seat constants are the rubric's values", () => {
    const t = VERDICT_TUNING;
    assert.equal(vote.DEFAULT_WEIGHTS, t.ballot.defaultWeights);
    assert.equal(DEFAULT_WEIGHTS, t.ballot.defaultWeights);
    assert.equal(vote.CONSENSUS_THRESHOLD, t.ballot.consensusThreshold);
    assert.deepEqual(
      [vote.HISTORY_WINDOW, vote.MIN_SAMPLES, vote.PROMOTE_AT, vote.DEMOTE_AT, vote.WEIGHT_STEP, vote.WEIGHT_CAP, vote.WEIGHT_FLOOR],
      [t.autoTune.window, t.autoTune.minSamples, t.autoTune.promoteAt, t.autoTune.demoteAt, t.autoTune.step, t.autoTune.cap, t.autoTune.floor],
    );
    assert.deepEqual(
      [score.GATE_MIN_SAMPLES, score.GATE_HIT_FLOOR, score.SCORE_WINDOW, score.RATE_FLOOR_SAMPLES, score.HOLDOUT_DEFAULT_SIZE, score.CONFIDENCE_Z, score.CONFIDENCE_LEVEL],
      [t.seatGate.minSamples, t.seatGate.hitFloor, t.autoTune.window, t.evidence.rateFloorSamples, t.evidence.holdoutSize, t.evidence.confidenceZ, t.evidence.confidenceLevel],
    );
    assert.deepEqual(
      [learning.GATE_MIN_SAMPLES, learning.GATE_MIN_HIT_RATE, learning.GATE_SEAT_WEIGHT, learning.MIN_SPLIT_SAMPLES, learning.MIN_DISSENT_SAMPLES, learning.DISSENT_WRONG_RATE],
      [t.seatGate.minSamples, t.seatGate.hitFloor, t.seatGate.seatWeight, t.learning.minSplitSamples, t.learning.minDissentSamples, t.learning.dissentWrongRate],
    );
    assert.equal(DEFAULT_COMMITTEE_PARAMS, t.committee.params);
    assert.equal(DEFAULT_SEAT_WEIGHTS, t.committee.seatWeights);
  });

  it("one track mapping: Laya votes and scores on the JEV track everywhere", () => {
    assert.equal(score.MODEL_TRACK, MODEL_TRACK);
    assert.equal(score.TRACK_MODELS, TRACK_MODELS);
    assert.deepEqual(TRACK_MODELS, { jev: ["jev", "laya"], kronos: ["kronos"], rfdetr: ["rfdetr"] });
    assert.equal(learning.TRACK_MODELS, TRACK_FEED_PRIORITY);
    assert.deepEqual(TRACK_FEED_PRIORITY, { jev: ["laya", "jev"], kronos: ["kronos"], rfdetr: ["rfdetr"] });
    assert.deepEqual(oracle.oracleWeightsFromStore({ jev: 0.7, kronos: 1.3, rfdetr: 0.4 }), { kronos: 1.3, laya: 0.7, rfdetr: 0.4 });
    assert.deepEqual(DEFAULT_ORACLE_WEIGHTS, { kronos: 0.5, laya: 1.0, rfdetr: 0 });
  });

  it("a rubric change reaches every seat's ballot and auto-tune", () => {
    const t = VERDICT_TUNING;
    const saved = { thr: t.ballot.consensusThreshold, step: t.autoTune.step };
    try {
      t.ballot.consensusThreshold = 0.5;
      t.autoTune.step = 0.25;
      const signals: Ballot<"jev" | "kronos" | "rfdetr">[] = [
        { skill: "jev", side: "long", confidence: 0.4, abstained: false, detail: "j" },
        { skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: "k" },
      ];
      // 0.4 clears the stock 0.15 but not the tuned 0.5 — in every ballot.
      assert.equal(vote.combineWeightedVote(signals, DEFAULT_WEIGHTS).side, "flat");
      assert.equal(combineBallot(signals, DEFAULT_WEIGHTS, "skill").side, "flat");
      assert.equal(
        oracle.combineOracleVote([{ skill: "laya", side: "long", confidence: 0.4, abstained: false, detail: "l" }], DEFAULT_ORACLE_WEIGHTS).side,
        "flat",
      );
      // The auto-tune steps by the tuned step in vote.json, score.json and the bare rule.
      const store = defaultStore();
      for (let i = 0; i < t.autoTune.minSamples; i++) recordOutcome(store, "kronos", true);
      assert.equal(store.weights.kronos, 0.75);
      assert.equal(score.autoTuneWeight([true, true, true, true, true], 0.5), 0.75);
      assert.equal(tuneWeight(0.5, [true, true, true, true, true]), 0.75);
      // The committee's model legs open on the rubric's weights.
      assert.equal(committeeModelLegs({}).voteWeights, t.ballot.defaultWeights);
    } finally {
      t.ballot.consensusThreshold = saved.thr;
      t.autoTune.step = saved.step;
    }
    assert.equal(vote.combineWeightedVote([{ skill: "jev", side: "long", confidence: 0.4, abstained: false, detail: "j" }], DEFAULT_WEIGHTS).side, "long");
  });
});
