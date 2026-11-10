/**
 * OQ-09 phase 2: one weighting module, one track store, the rubric as the
 * single tuning surface. The byte-identical decision pins live in
 * verdict-golden.test.ts; this file pins the parts the goldens cannot see.
 *
 *   1. The on-disk track store keeps its path and shape: a vote.json
 *      WRITTEN BY THE KEPT CODE (captured in the goldens) loads and
 *      re-saves byte-identical through the one track store. score.json is
 *      simply no longer read (the `score` command is retired).
 *   2. Every kept reader takes its weights and thresholds from the rubric:
 *      the constants are the rubric's values, and a rubric change reaches
 *      the ballot and the auto-tune (no module keeps its own copy).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "../test-fixtures.js";
import { loadGoldens } from "../verdict-golden.cases.js";
import { VERDICT_TUNING } from "./rubric.js";
import { DEFAULT_ORACLE_WEIGHTS, DEFAULT_WEIGHTS, TRACK_FEED_PRIORITY, TRACK_MODELS, combineBallot, oracleWeights, tuneWeight, type Ballot } from "./weighting.js";
import { defaultStore, loadStore, recordOutcome, saveStore, voteStorePath } from "./track-store.js";
import * as learning from "./learning.js";

const sb = makeSandbox("jw3-oq09-weighting-");
after(() => sb.cleanup());

describe("track store: vote.json keeps its path and shape", () => {
  const goldens = loadGoldens();
  const written = (name: string, file: string): string => {
    const text = goldens[name]?.files?.[file];
    assert.ok(text, `golden ${name} carries no ${file}`);
    return text;
  };

  it("paths are unchanged (beside credentials.json, explicit dir wins)", () => {
    assert.equal(voteStorePath("/x"), join("/x", "vote.json"));
  });

  it("a vote.json written by the kept code loads and re-saves byte-identical", () => {
    for (const name of ["learning record x5 on the tuned store, low gate, json (+files)", "degen split models, tuned store → long fire (decisions + venue calls)", "degen old-format store, preview text"]) {
      const before = written(name, "vote.json");
      const path = join(sb.dir, "vote.json");
      writeFileSync(path, before);
      saveStore(path, loadStore(path));
      assert.equal(readFileSync(path, "utf8"), before, name);
    }
  });
});

describe("the rubric is the single tuning surface", () => {
  it("the kept constants are the rubric's values", () => {
    const t = VERDICT_TUNING;
    assert.equal(DEFAULT_WEIGHTS, t.ballot.defaultWeights);
    assert.deepEqual(
      [learning.GATE_MIN_SAMPLES, learning.GATE_MIN_HIT_RATE, learning.GATE_SEAT_WEIGHT, learning.MIN_SPLIT_SAMPLES, learning.MIN_DISSENT_SAMPLES, learning.DISSENT_WRONG_RATE],
      [t.seatGate.minSamples, t.seatGate.hitFloor, t.seatGate.seatWeight, t.learning.minSplitSamples, t.learning.minDissentSamples, t.learning.dissentWrongRate],
    );
  });

  it("one track mapping: Laya votes and scores on the JEV track everywhere", () => {
    assert.deepEqual(TRACK_MODELS, { jev: ["jev", "laya"], kronos: ["kronos"], rfdetr: ["rfdetr"] });
    assert.equal(learning.TRACK_MODELS, TRACK_FEED_PRIORITY);
    assert.deepEqual(TRACK_FEED_PRIORITY, { jev: ["laya", "jev"], kronos: ["kronos"], rfdetr: ["rfdetr"] });
    assert.deepEqual(oracleWeights({ jev: 0.7, kronos: 1.3, rfdetr: 0.4 }), { kronos: 1.3, laya: 0.7, rfdetr: 0.4 });
    assert.deepEqual(DEFAULT_ORACLE_WEIGHTS, { kronos: 0.5, laya: 1.0, rfdetr: 0 });
  });

  it("a rubric change reaches the ballot and the auto-tune", () => {
    const t = VERDICT_TUNING;
    const saved = { thr: t.ballot.consensusThreshold, step: t.autoTune.step };
    try {
      t.ballot.consensusThreshold = 0.5;
      t.autoTune.step = 0.25;
      const signals: Ballot<"jev" | "kronos" | "rfdetr">[] = [
        { skill: "jev", side: "long", confidence: 0.4, abstained: false, detail: "j" },
        { skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: "k" },
      ];
      // 0.4 clears the stock 0.15 but not the tuned 0.5 — in both ballots.
      assert.equal(combineBallot(signals, DEFAULT_WEIGHTS, "skill").side, "flat");
      assert.equal(
        combineBallot([{ skill: "laya", side: "long", confidence: 0.4, abstained: false, detail: "l" }], DEFAULT_ORACLE_WEIGHTS, "model").side,
        "flat",
      );
      // The auto-tune steps by the tuned step in vote.json and the bare rule.
      const store = defaultStore();
      for (let i = 0; i < t.autoTune.minSamples; i++) recordOutcome(store, "kronos", true);
      assert.equal(store.weights.kronos, 0.75);
      assert.equal(tuneWeight(0.5, [true, true, true, true, true]), 0.75);
    } finally {
      t.ballot.consensusThreshold = saved.thr;
      t.autoTune.step = saved.step;
    }
    assert.equal(combineBallot([{ skill: "jev", side: "long", confidence: 0.4, abstained: false, detail: "j" }], DEFAULT_WEIGHTS, "skill").side, "long");
  });
});
