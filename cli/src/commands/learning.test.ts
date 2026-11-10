/**
 * `jw3 learning` tests — the closed-trade → model-scoring loop.
 *
 * Pure core over injected log text and injected store objects: no
 * network, no venue, no trades. The two command wrappers are exercised
 * against a temp sandbox so the file layout (append + compaction) and the
 * vote.json feedback are pinned end to end.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL_VERSIONS,
  DISSENT_WRONG_RATE,
  GATE_MIN_HIT_RATE,
  GATE_MIN_SAMPLES,
  GATE_SEAT_WEIGHT,
  LEARNING_COMPACT_AT,
  LEARNING_COMPACT_KEEP,
  LEARNING_MODELS,
  LEARNING_WINDOW_BARS,
  LEARNING_WINDOW_MINUTES,
  MIN_DISSENT_SAMPLES,
  MIN_SPLIT_SAMPLES,
  applyPromotionGate,
  appendRecordToLog,
  buildLearningRecord,
  cmdLearningRecord,
  cmdLearningStats,
  compactLearningLog,
  formatLearningReport,
  gateVerdict,
  jevSignal,
  kronosSignal,
  kronosVersion,
  learningLogPath,
  layaSignal,
  normalizeLearningPair,
  parseLearningLog,
  preEntryWindow,
  rfdetrLearningSignal,
  scoreDirection,
  summarizeLearningLog,
  syncVoteStore,
  trackOutcome,
  trackOutcomeSource,
  validateLearningInput,
  type LearningRecord,
  type LearningRecordInput,
} from "./learning.js";
import { defaultStore, loadStore, saveStore, voteStorePath, type VoteStore } from "./track-store.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const now = (): number => NOW;

const input = (over: Partial<LearningRecordInput> = {}): LearningRecordInput => ({
  pair: "SOL/USDT",
  side: "long",
  entry: 100,
  exit: 101,
  exitReason: "tp",
  pnlUsd: 1.2,
  feesUsd: 0.2,
  holdingMs: 22 * 60 * 1000,
  ...over,
});

/** A trade where JEV + Laya vote long, Kronos votes short, RF-DETR abstains. */
const splitTrade = (over: Partial<LearningRecordInput> = {}): LearningRecord =>
  buildLearningRecord(
    input({
      signals: {
        jev: jevSignal("long", 0.8),
        laya: layaSignal("long", 0.7),
        kronos: kronosSignal("down", 0.4),
      },
      tape: { atrPct: 0.9, vratio: 0.6, bookImb: 0.21, offHighPct: 3, offLowPct: 18 },
      entryAtMs: NOW - 5 * 60 * 1000,
      ...over,
    }),
    { now },
  );

let logs: string[];
let errs: string[];
let logFn: typeof console.log;
let errFn: typeof console.error;
let sandbox: string;

beforeEach(() => {
  logs = [];
  errs = [];
  logFn = console.log;
  errFn = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  process.exitCode = undefined;
  sandbox = mkdtempSync(join(tmpdir(), "jw3-learning-"));
});

afterEach(() => {
  console.log = logFn;
  console.error = errFn;
  process.exitCode = undefined;
});

/* ------------------------------------------------------------------ */
/* Input validation + construction                                    */
/* ------------------------------------------------------------------ */

describe("validateLearningInput", () => {
  it("accepts a complete closed trade", () => {
    assert.equal(validateLearningInput(input()), null);
  });
  it("rejects garbage without inventing", () => {
    assert.match(String(validateLearningInput(input({ pair: "SOL" }))), /pair/);
    assert.match(String(validateLearningInput(input({ side: "flat" as never }))), /side/);
    assert.match(String(validateLearningInput(input({ entry: 0 }))), /entry/);
    assert.match(String(validateLearningInput(input({ exit: NaN }))), /exit/);
    assert.match(String(validateLearningInput(input({ pnlUsd: NaN }))), /pnl/);
    assert.match(String(validateLearningInput(input({ feesUsd: -1 }))), /fees/);
    assert.match(String(validateLearningInput(input({ exitReason: "  " }))), /exit reason/);
  });
});

describe("buildLearningRecord", () => {
  it("banks the full context with a stable schema and a UTC stamp", () => {
    const rec = splitTrade();
    assert.equal(rec.v, 1);
    assert.equal(rec.kind, "learning.trade");
    assert.equal(rec.at, "2026-10-21T12:00:00.000Z");
    assert.equal(rec.pair, "SOL/USDT");
    assert.equal(rec.side, "long");
    assert.deepEqual(rec.trade, {
      entry: 100,
      exit: 101,
      exitReason: "tp",
      pnlUsd: 1.2,
      feesUsd: 0.2,
      netPnlUsd: 1,
      holdingMs: 22 * 60 * 1000,
    });
    // Tape features are captured; unmeasured ones stay null (never a fake 0).
    assert.deepEqual(rec.tape, {
      atrPct: 0.9,
      vratio: 0.6,
      bookImb: 0.21,
      offHighPct: 3,
      offLowPct: 18,
    });
    const bare = buildLearningRecord(input(), { now });
    assert.deepEqual(bare.tape, {
      atrPct: null,
      vratio: null,
      bookImb: null,
      offHighPct: null,
      offLowPct: null,
    });
    // Every model is present so the shape stays stable across records.
    assert.deepEqual(Object.keys(rec.signals).sort(), [...LEARNING_MODELS].sort());
  });

  it("records the model version that produced each signal", () => {
    const rec = splitTrade();
    assert.equal(rec.signals.jev?.version, DEFAULT_MODEL_VERSIONS.jev);
    assert.equal(rec.signals.laya?.version, DEFAULT_MODEL_VERSIONS.laya);
    assert.equal(rec.signals.kronos?.version, DEFAULT_MODEL_VERSIONS.kronos);
    // The model-specific raw fields survive into the dataset.
    assert.equal(rec.signals.jev?.agreement, 0.8);
    assert.equal(rec.signals.laya?.choice, "long");
    assert.equal(rec.signals.kronos?.direction, "down");
    assert.equal(rec.signals.kronos?.conviction, 0.4);
    const finetuned = buildLearningRecord(
      input({ signals: { kronos: kronosSignal("up", 0.3, { version: kronosVersion(true) }) } }),
      { now },
    );
    assert.equal(finetuned.signals.kronos?.version, "kronos-small:finetuned");
  });

  it("carries the pre-entry 400x15m window pointer for the finetune loop", () => {
    const rec = splitTrade();
    assert.ok(rec.window);
    assert.equal(rec.window.lookback, LEARNING_WINDOW_BARS);
    assert.equal(rec.window.granularityMin, LEARNING_WINDOW_MINUTES);
    assert.equal(rec.window.bars, 400);
    assert.equal(rec.window.to, new Date(NOW - 5 * 60 * 1000).toISOString());
    const spanMs = Date.parse(rec.window.from as string) !== 0 ? Date.parse(rec.window.to as string) - Date.parse(rec.window.from as string) : 0;
    assert.equal(spanMs, 400 * 15 * 60 * 1000);
  });

  it("scores only the models that voted; abstentions are not scored", () => {
    const rec = splitTrade();
    // Net P&L +1 on a long → JEV and Laya (long) are hits, Kronos (short) a miss.
    assert.deepEqual(rec.outcome.scored, { jev: true, laya: true, kronos: false });
    // RF-DETR abstained → recorded as abstained, never scored.
    assert.deepEqual(rec.outcome.abstained, ["rfdetr"]);
    assert.equal("rfdetr" in rec.outcome.scored, false);
  });

  it("a short is right when the net P&L is negative", () => {
    const rec = buildLearningRecord(
      input({
        side: "short",
        pnlUsd: -1.5,
        feesUsd: 0.1,
        exit: 99,
        exitReason: "sl",
        signals: { jev: jevSignal("short", 0.6), kronos: kronosSignal("down", 0.3) },
      }),
      { now },
    );
    assert.equal(rec.trade.netPnlUsd, -1.6);
    assert.deepEqual(rec.outcome.scored, { jev: true, kronos: true });
  });

  it("net P&L is gross minus fees unless the venue figure overrides it", () => {
    const rec = buildLearningRecord(input({ pnlUsd: 1.2, feesUsd: 0.2, netPnlUsd: 0.9 }), { now });
    assert.equal(rec.trade.netPnlUsd, 0.9);
  });

  it("normalizes the pair the way the ballot does", () => {
    const rec = buildLearningRecord(input({ pair: "sol/usdt" }), { now });
    assert.equal(rec.pair, "SOL/USDT");
    assert.equal(normalizeLearningPair("eth/usdt"), "ETH/USDT");
  });
});

describe("scoreDirection", () => {
  it("long needs net P&L > 0, short needs net P&L < 0", () => {
    assert.equal(scoreDirection("long", 0.01), true);
    assert.equal(scoreDirection("long", 0), false);
    assert.equal(scoreDirection("short", -0.01), true);
    assert.equal(scoreDirection("short", 0), false);
  });
  it("never scores a non-finite net", () => {
    assert.throws(() => scoreDirection("long", NaN), /finite/);
  });
});

describe("parseLearningLog", () => {
  it("splits trade records from compaction snapshots and ignores junk", () => {
    let text = appendRecordToLog("", splitTrade());
    text = `${text}not json\n${JSON.stringify({ kind: "something-else" })}\n`;
    const parsed = parseLearningLog(text);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0]!.kind, "learning.trade");
    assert.equal(parsed.snapshots.length, 0);
  });

  it("reads a compaction snapshot back as a ledger", () => {
    let text = "";
    for (let i = 0; i < 5; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 1, feesUsd: 0 }));
    const c = compactLearningLog(text, 2, { now });
    const parsed = parseLearningLog(c.text);
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.records.length, 2);
  });
});

describe("rfdetrLearningSignal", () => {
  it("abstains until the chart-vision model is wired", () => {
    const s = rfdetrLearningSignal();
    assert.equal(s.abstained, true);
    assert.equal(s.side, "flat");
    assert.equal(s.confidence, 0);
    assert.equal(s.version, DEFAULT_MODEL_VERSIONS.rfdetr);
  });
});

describe("compaction thresholds", () => {
  it("the log is bounded: compaction past the documented size keeps the tail", () => {
    assert.equal(LEARNING_COMPACT_AT, 500);
    assert.equal(LEARNING_COMPACT_KEEP, 200);
  });
});

/* ------------------------------------------------------------------ */
/* Log format + stats                                                  */
/* ------------------------------------------------------------------ */

describe("appendRecordToLog", () => {
  it("appends exactly one JSON line", () => {
    const rec = splitTrade();
    const text = appendRecordToLog("", rec);
    assert.equal(text.split("\n").filter((l) => l.trim()).length, 1);
    assert.ok(text.endsWith("\n"));
    const parsed = JSON.parse(text.trim()) as LearningRecord;
    assert.equal(parsed.kind, "learning.trade");
    const two = appendRecordToLog(text, rec);
    assert.equal(two.split("\n").filter((l) => l.trim()).length, 2);
  });
});

describe("summarizeLearningLog", () => {
  it("is empty on an empty log and ignores malformed lines", () => {
    const s = summarizeLearningLog("");
    assert.equal(s.records, 0);
    assert.equal(s.total, 0);
    assert.equal(s.models.length, LEARNING_MODELS.length);
    const junk = summarizeLearningLog("not json\n{}\n{\"kind\":\"learning.trade\"}\n");
    assert.equal(junk.records, 0);
  });

  it("accumulates per-model hit rates over the scored outcomes only", () => {
    const rec = splitTrade();
    const text = appendRecordToLog("", rec);
    const s = summarizeLearningLog(text);
    const jev = s.models.find((m) => m.model === "jev")!;
    const kronos = s.models.find((m) => m.model === "kronos")!;
    const rfdetr = s.models.find((m) => m.model === "rfdetr")!;
    assert.equal(jev.scored, 1);
    assert.equal(jev.hits, 1);
    assert.equal(jev.hitRate, 1);
    assert.equal(kronos.scored, 1);
    assert.equal(kronos.hits, 0);
    assert.equal(kronos.hitRate, 0);
    // An abstention is not scored — it must not dilute the denominator.
    assert.equal(rfdetr.scored, 0);
    assert.equal(rfdetr.hitRate, null);
  });

  it("the rolling window is bounded at HISTORY_WINDOW", () => {
    let text = "";
    for (let i = 0; i < 25; i++) text = appendRecordToLog(text, splitTrade());
    const s = summarizeLearningLog(text);
    assert.equal(s.models.find((m) => m.model === "jev")!.window.length, 20);
  });

  it("counts net P&L, wins and losses", () => {
    let text = "";
    text = appendRecordToLog(text, splitTrade({ pnlUsd: 1.2, feesUsd: 0.2 }));
    text = appendRecordToLog(
      text,
      splitTrade({ pnlUsd: -1.2, feesUsd: 0.2, side: "long", exit: 99, exitReason: "kill" }),
    );
    const s = summarizeLearningLog(text);
    assert.equal(s.records, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    // +1.0 net on the winner, -1.4 net on the loser.
    assert.ok(Math.abs(s.netPnlUsd - -0.4) < 1e-9, `net ${String(s.netPnlUsd)}`);
  });
});

/* ------------------------------------------------------------------ */
/* Model-pair + dissent analysis                                       */
/* ------------------------------------------------------------------ */

describe("model-pair analysis", () => {
  it("records agreement quality and the systematic winner when a pair splits", () => {
    // 8 trades: JEV and Laya vote long every time; Kronos dissents short
    // every time and is wrong on 7 of 8 (only the trade that lost net was
    // the one where the short was right).
    let text = "";
    for (let i = 0; i < 8; i++) {
      const kronosRight = i === 0;
      text = appendRecordToLog(
        text,
        splitTrade({
          pnlUsd: kronosRight ? -1 : 2,
          feesUsd: 0,
          side: "long",
          exit: kronosRight ? 99 : 102,
          exitReason: kronosRight ? "kill" : "tp",
        }),
      );
    }
    const s = summarizeLearningLog(text);
    const pair = s.pairs.find((p) => p.a === "jev" && p.b === "kronos");
    assert.ok(pair, "jev/kronos pair is recorded");
    assert.equal(pair.bothVoted, 8);
    assert.equal(pair.disagreed, 8);
    assert.equal(pair.aRight, 7);
    assert.equal(pair.bRight, 1);
    assert.equal(pair.systematic, "jev");
    assert.ok(pair.edge !== null && pair.edge > 0.5);
    assert.match(pair.note, /systematically right/);
  });

  it("does not claim a systematic winner below the split sample floor", () => {
    let text = "";
    for (let i = 0; i < MIN_SPLIT_SAMPLES - 1; i++) {
      text = appendRecordToLog(text, splitTrade({ pnlUsd: 2, feesUsd: 0 }));
    }
    const s = summarizeLearningLog(text);
    const pair = s.pairs.find((p) => p.a === "jev" && p.b === "kronos")!;
    assert.equal(pair.disagreed, MIN_SPLIT_SAMPLES - 1);
    assert.equal(pair.systematic, null);
    assert.match(pair.note, /no systematic winner/);
  });

  it("scores the agreement itself (how good their shared call was)", () => {
    let text = "";
    // Laya and JEV agree long on 3 of 3 winning trades.
    for (let i = 0; i < 3; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 2, feesUsd: 0 }));
    const s = summarizeLearningLog(text);
    const pair = s.pairs.find((p) => p.a === "jev" && p.b === "laya")!;
    assert.equal(pair.agreed, 3);
    assert.equal(pair.agreedRight, 3);
    assert.equal(pair.agreementHitRate, 1);
  });
});

describe("dissent analysis", () => {
  it("a dissenting third model is information: its own hit rate is measured", () => {
    let text = "";
    // Kronos dissents (short) against a long JEV/Laya consensus on 6 trades
    // and is right on 1 (the one that lost net).
    for (let i = 0; i < 6; i++) {
      const kronosRight = i === 0;
      text = appendRecordToLog(
        text,
        splitTrade({
          pnlUsd: kronosRight ? -1 : 2,
          feesUsd: 0,
          signals: {
            jev: jevSignal("long", 0.8),
            laya: layaSignal("long", 0.7),
            kronos: kronosSignal("down", 0.4),
          },
        }),
      );
    }
    const s = summarizeLearningLog(text);
    const d = s.dissents.find((x) => x.model === "kronos");
    assert.ok(d, "kronos dissent is recorded");
    assert.equal(d.dissents, 6);
    assert.equal(d.right, 1);
    assert.equal(d.wrong, 5);
    assert.equal(d.consensusRight, 5);
    assert.equal(d.consensusWrong, 1);
    assert.ok(d.hitRate !== null && d.hitRate < 1 - DISSENT_WRONG_RATE);
    assert.match(d.note, /systematically wrong/);
  });

  it("a dissent with too few samples is not read", () => {
    const s = summarizeLearningLog(appendRecordToLog("", splitTrade()));
    const d = s.dissents.find((x) => x.model === "kronos")!;
    assert.equal(d.dissents, 1);
    assert.ok(d.dissents < MIN_DISSENT_SAMPLES);
    assert.match(d.note, /not enough to read/);
  });

  it("a dissent that carries information is reported as such", () => {
    let text = "";
    for (let i = 0; i < 6; i++) {
      // The trade loses net on a long → the short dissenter is right.
      text = appendRecordToLog(
        text,
        splitTrade({
          pnlUsd: -2,
          feesUsd: 0,
          signals: {
            jev: jevSignal("long", 0.8),
            laya: layaSignal("long", 0.7),
            kronos: kronosSignal("down", 0.4),
          },
        }),
      );
    }
    const s = summarizeLearningLog(text);
    const d = s.dissents.find((x) => x.model === "kronos")!;
    assert.equal(d.right, 6);
    assert.equal(d.consensusWrong, 6);
    assert.match(d.note, /carries information/);
  });
});

/* ------------------------------------------------------------------ */
/* Promotion gate                                                      */
/* ------------------------------------------------------------------ */

describe("gateVerdict", () => {
  it("needs BOTH a minimum sample and the hit-rate bar", () => {
    assert.equal(gateVerdict(0, null).eligible, false);
    assert.match(gateVerdict(GATE_MIN_SAMPLES - 1, 1).reason, /minimum/);
    assert.equal(gateVerdict(GATE_MIN_SAMPLES, 0.5).eligible, false);
    assert.match(gateVerdict(GATE_MIN_SAMPLES, 0.5).reason, /hit-rate/);
    assert.equal(gateVerdict(GATE_MIN_SAMPLES, GATE_MIN_HIT_RATE).eligible, true);
  });
  it("the thresholds are the documented ones", () => {
    assert.equal(GATE_MIN_SAMPLES, 30);
    assert.equal(GATE_MIN_HIT_RATE, 0.55);
  });
});

describe("applyPromotionGate", () => {
  const statsWith = (over: Partial<ReturnType<typeof summarizeLearningLog>> = {}) => {
    const base = summarizeLearningLog("");
    return {
      ...base,
      tracks: base.tracks.map((t) => ({ ...t, ...(over.tracks ? {} : {}) })),
      ...over,
    };
  };

  it("excludes a below-the-bar slot with weight 0 and logs the reason", () => {
    const store = defaultStore();
    store.weights = { jev: 1, kronos: 0.5, rfdetr: 0 };
    const s = summarizeLearningLog("");
    const changes = applyPromotionGate(store, s);
    const kronos = changes.find((c) => c.track === "kronos")!;
    assert.equal(kronos.weightBefore, 0.5);
    assert.equal(kronos.weightAfter, 0);
    assert.equal(kronos.eligible, false);
    assert.match(kronos.reason, /excluded/);
    assert.equal(store.weights.kronos, 0);
    // The Kronos demotion shape the repo already applied at 37.5%.
    assert.ok(statsWith().tracks.every((t) => t.eligible === false));
  });

  it("a slot that clears the bar keeps a non-zero seat weight", () => {
    const store = defaultStore();
    store.weights = { jev: 0.8, kronos: 0, rfdetr: 0 };
    const s = summarizeLearningLog("");
    // Force one slot over the bar.
    const tracks = s.tracks.map((t) =>
      t.track === "jev" ? { ...t, eligible: true, reason: "30 scored @ 60%", scored: 30, hits: 18, hitRate: 0.6 } : t,
    );
    const changes = applyPromotionGate(store, { ...s, tracks });
    const jev = changes.find((c) => c.track === "jev")!;
    assert.equal(jev.eligible, true);
    assert.equal(jev.weightAfter, 0.8);
    assert.equal(store.weights.jev, 0.8);
    // A slot with no evidence stays out.
    assert.equal(store.weights.kronos, 0);
  });

  it("an eligible slot with a zero weight is lifted to the seat weight", () => {
    const store = defaultStore();
    store.weights = { jev: 0, kronos: 0, rfdetr: 0 };
    const s = summarizeLearningLog("");
    const tracks = s.tracks.map((t) =>
      t.track === "kronos" ? { ...t, eligible: true, reason: "30 scored @ 70%", scored: 30, hitRate: 0.7 } : t,
    );
    applyPromotionGate(store, { ...s, tracks });
    assert.equal(store.weights.kronos, GATE_SEAT_WEIGHT);
  });

  it("never writes a weight outside the track-store bounds", () => {
    const store = defaultStore();
    store.weights = { jev: 5, kronos: 0.5, rfdetr: 0 };
    const s = summarizeLearningLog("");
    const tracks = s.tracks.map((t) => ({ ...t, eligible: true, reason: "ok" }));
    applyPromotionGate(store, { ...s, tracks });
    assert.ok(store.weights.jev! <= 2.0);
    assert.ok(store.weights.jev! >= 0);
  });
});

/* ------------------------------------------------------------------ */
/* Feedback into vote.json                                             */
/* ------------------------------------------------------------------ */

describe("syncVoteStore", () => {
  it("scores one outcome per slot into the rolling window the auto-tune reads", () => {
    const store: VoteStore = defaultStore();
    const rec = splitTrade();
    const applied = syncVoteStore(store, rec);
    // jev slot ← laya (priority), kronos slot ← kronos, rfdetr ← abstained (no score).
    assert.deepEqual(
      applied.map((a) => a.track).sort(),
      ["jev", "kronos"],
    );
    assert.equal(store.skills.jev!.results.length, 1);
    assert.equal(store.skills.kronos!.results.length, 1);
    assert.equal(store.skills.rfdetr!.results.length, 0);
    assert.equal(store.skills.jev!.total, 1);
  });

  it("the jev slot takes Laya first and falls back to the raw JEV trend", () => {
    const layaWins = buildLearningRecord(
      input({
        signals: { jev: jevSignal("long", 0.9), laya: layaSignal("long", 0.6) },
      }),
      { now },
    );
    assert.deepEqual(trackOutcomeSource(layaWins, "jev"), { model: "laya", hit: true });
    const jevOnly = buildLearningRecord(input({ signals: { jev: jevSignal("long", 0.9) } }), { now });
    assert.deepEqual(trackOutcomeSource(jevOnly, "jev"), { model: "jev", hit: true });
    assert.equal(trackOutcome(jevOnly, "rfdetr"), null);
  });

  it("the scored outcome matches the track-store recordOutcome auto-tune", () => {
    const store = defaultStore();
    const rec = splitTrade();
    syncVoteStore(store, rec);
    // the track-store auto-tune needs MIN_SAMPLES (5) before it touches a weight,
    // so one outcome only moves the rolling window + the lifetime counters.
    assert.deepEqual(store.skills.kronos!.results, [false]);
    assert.equal(store.skills.kronos!.total, 1);
    assert.equal(store.skills.kronos!.hits, 0);
    assert.deepEqual(store.skills.jev!.results, [true]);
    assert.equal(store.weights.kronos, 0.5);
    assert.equal(store.weights.jev, 1.0);
  });

  it("five misses demote the slot exactly as the track-store auto-tune does", () => {
    const store = defaultStore();
    // A WINNING long: JEV/Laya (long) are hits, Kronos (short) is a miss.
    const win = splitTrade({
      pnlUsd: 2,
      feesUsd: 0,
      exit: 102,
      exitReason: "tp",
      signals: { jev: jevSignal("long", 0.8), laya: layaSignal("long", 0.7), kronos: kronosSignal("down", 0.4) },
    });
    for (let i = 0; i < 5; i++) syncVoteStore(store, win);
    // the track store: the tune only fires once MIN_SAMPLES (5) is reached, and a
    // rate <= 40% demotes -0.1 (floor 0) → 0.5 - 0.1 = 0.4.
    assert.equal(store.weights.kronos, 0.4);
    assert.equal(store.skills.kronos!.hits, 0);
    assert.equal(store.skills.kronos!.total, 5);
    // The jev slot is fed by Laya (long) → 5/5 hits → rate >= 60% promotes +0.1.
    assert.equal(store.weights.jev, 1.1);
  });

  it("an abstained model never touches the store", () => {
    const store = defaultStore();
    const rec = buildLearningRecord(input({ signals: { jev: jevSignal("flat", 0) } }), { now });
    syncVoteStore(store, rec);
    assert.equal(store.skills.jev!.total, 0);
    assert.equal(store.skills.kronos!.total, 0);
    assert.equal(store.skills.rfdetr!.total, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Compaction                                                          */
/* ------------------------------------------------------------------ */

describe("compactLearningLog", () => {
  it("is a no-op below the keep floor", () => {
    const text = appendRecordToLog("", splitTrade());
    const c = compactLearningLog(text, 10);
    assert.equal(c.removed, 0);
    assert.equal(c.text, text);
  });

  it("folds the head into one snapshot and keeps the tail verbatim", () => {
    let text = "";
    for (let i = 0; i < 10; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 1, feesUsd: 0 }));
    const c = compactLearningLog(text, 3, { now });
    assert.equal(c.removed, 7);
    assert.equal(c.kept, 3);
    const lines = c.text.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 4);
    const snap = JSON.parse(lines[0] as string) as { kind: string; folded: number };
    assert.equal(snap.kind, "learning.ledger");
    assert.equal(snap.folded, 7);
    for (const l of lines.slice(1)) {
      assert.equal((JSON.parse(l) as { kind: string }).kind, "learning.trade");
    }
  });

  it("the lifetime counters survive compaction", () => {
    let text = "";
    for (let i = 0; i < 10; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 1, feesUsd: 0 }));
    const c = compactLearningLog(text, 3, { now });
    const before = summarizeLearningLog(text);
    const after = summarizeLearningLog(c.text);
    assert.equal(after.folded, 7);
    assert.equal(after.total, before.total);
    assert.equal(after.models.find((m) => m.model === "jev")!.scored, before.models.find((m) => m.model === "jev")!.scored);
    assert.equal(after.models.find((m) => m.model === "jev")!.hits, before.models.find((m) => m.model === "jev")!.hits);
  });

  it("compaction keeps the rolling window bounded", () => {
    let text = "";
    for (let i = 0; i < 30; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 1, feesUsd: 0 }));
    const c = compactLearningLog(text, 2, { now });
    const s = summarizeLearningLog(c.text);
    assert.ok(s.models.find((m) => m.model === "jev")!.window.length <= 20);
  });

  it("compacts twice without double-counting", () => {
    let text = "";
    for (let i = 0; i < 10; i++) text = appendRecordToLog(text, splitTrade({ pnlUsd: 1, feesUsd: 0 }));
    const first = compactLearningLog(text, 3, { now });
    const second = compactLearningLog(first.text, 1, { now });
    const s = summarizeLearningLog(second.text);
    assert.equal(s.total, 10);
  });
});

/* ------------------------------------------------------------------ */
/* Paths + report                                                      */
/* ------------------------------------------------------------------ */

describe("learningLogPath", () => {
  it("mirrors the degen-learning.jsonl convention under the config dir", () => {
    const p = learningLogPath("/tmp/jw3cfg");
    assert.equal(p, "/tmp/jw3cfg/learning.jsonl");
    // The no-arg form reads the ambient config dir — isolate it from any
    // JW3_CONFIG_HOME / XDG_CONFIG_HOME the runner exports.
    const savedHome = process.env.JW3_CONFIG_HOME;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.JW3_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      assert.match(learningLogPath(), /jw3[\\/]learning\.jsonl$/);
    } finally {
      if (savedHome === undefined) delete process.env.JW3_CONFIG_HOME;
      else process.env.JW3_CONFIG_HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});

describe("formatLearningReport", () => {
  it("reports the gate, the models and the live weights", () => {
    const s = summarizeLearningLog(appendRecordToLog("", splitTrade()));
    const out = formatLearningReport(s, { jev: 1, kronos: 0, rfdetr: 0 }).join("\n");
    assert.match(out, /LEARNING/);
    assert.match(out, /GATE — voting rights need ≥30 scored outcomes AND ≥55%/);
    assert.match(out, /jev/);
    assert.match(out, /excluded/);
    assert.match(out, /live w 0\.00/);
  });
});

describe("preEntryWindow", () => {
  it("spans 400 x 15m ending at the entry", () => {
    const w = preEntryWindow(NOW);
    assert.equal(w.bars, 400);
    assert.equal(w.granularityMin, 15);
    assert.equal(w.to, new Date(NOW).toISOString());
    assert.equal(Date.parse(w.to) - Date.parse(w.from), 400 * 15 * 60 * 1000);
  });
});

describe("preEntryWindow pointer is optional", () => {
  it("a record without an entry timestamp has no window rather than a fake one", () => {
    const rec = buildLearningRecord(input(), { now });
    assert.equal(rec.window, null);
  });
});

/* ------------------------------------------------------------------ */
/* Command wrappers                                                    */
/* ------------------------------------------------------------------ */

describe("cmdLearningRecord", () => {
  const paths = () => ({
    logPath: join(sandbox, "learning.jsonl"),
    storePath: voteStorePath(sandbox),
  });

  it("appends one line, scores the models and updates the vote store", async () => {
    const p = paths();
    await cmdLearningRecord(
      {
        pair: "SOL/USDT",
        side: "long",
        entry: 100,
        exit: 101,
        exitReason: "tp",
        pnlUsd: 1.2,
        feesUsd: 0.2,
        holdingMs: 60000,
        signals: { jev: jevSignal("long", 0.8), laya: layaSignal("long", 0.7), kronos: kronosSignal("down", 0.4) },
        tape: { atrPct: 0.9, vratio: 0.6 },
        entryAtMs: NOW,
        json: false,
        ...p,
        now,
      },
    );
    assert.equal(process.exitCode, undefined);
    const lines = readFileSync(p.logPath, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0] as string) as LearningRecord;
    assert.equal(rec.kind, "learning.trade");
    assert.equal(rec.outcome.netPnlUsd, 1);
    assert.deepEqual(rec.outcome.scored, { jev: true, laya: true, kronos: false });
    assert.match(logs.join("\n"), /RECORDED SOL\/USDT LONG/);
    assert.match(logs.join("\n"), /jev=hit \(laya\)/);
    // The vote.json store the live ballot reads is updated.
    const store = loadStore(p.storePath);
    assert.equal(store.skills.jev!.total, 1);
    assert.equal(store.skills.kronos!.total, 1);
    assert.equal(store.skills.rfdetr!.total, 0);
    // A slot with no evidence is excluded from live voting.
    assert.equal(store.weights.kronos, 0);
  });

  it("rejects a bad record with exit 2 and writes nothing", async () => {
    const p = paths();
    await cmdLearningRecord(
      {
        pair: "SOL",
        side: "long",
        entry: 100,
        exit: 101,
        exitReason: "tp",
        pnlUsd: 1,
        feesUsd: 0,
        json: false,
        ...p,
        now,
      },
    );
    assert.equal(process.exitCode, 2);
    assert.equal(existsSync(p.logPath), false);
  });

  it("--json emits the record, the scoring and the gate changes", async () => {
    const p = paths();
    await cmdLearningRecord(
      {
        pair: "SOL/USDT",
        side: "long",
        entry: 100,
        exit: 101,
        exitReason: "tp",
        pnlUsd: 1,
        feesUsd: 0,
        signals: { jev: jevSignal("long", 0.8) },
        json: true,
        ...p,
        now,
      },
    );
    const out = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    assert.equal((out["record"] as LearningRecord).kind, "learning.trade");
    assert.deepEqual(out["scored"], ["jev hit"]);
    const gate = out["gate"] as { track: string; weightAfter: number }[];
    assert.equal(gate.find((g) => g.track === "jev")!.weightAfter, 0);
  });

  it("applyGate false scores and logs without touching the live weights", async () => {
    const p = paths();
    await cmdLearningRecord(
      {
        pair: "SOL/USDT",
        side: "long",
        entry: 100,
        exit: 101,
        exitReason: "tp",
        pnlUsd: 1,
        feesUsd: 0,
        signals: { jev: jevSignal("long", 0.8) },
        json: false,
        applyGate: false,
        ...p,
        now,
      },
    );
    const store = loadStore(p.storePath);
    assert.equal(store.weights.jev, 1);
    assert.equal(store.skills.jev!.total, 1);
  });
});

describe("cmdLearningStats", () => {
  const paths = () => ({
    logPath: join(sandbox, "learning.jsonl"),
    storePath: voteStorePath(sandbox),
  });

  it("reports an empty log without inventing numbers", async () => {
    const p = paths();
    await cmdLearningStats({ json: false, ...p });
    assert.match(logs.join("\n"), /0 closed trade\(s\) scored/);
    assert.match(logs.join("\n"), /—/);
  });

  it("reports the ledger over the log", async () => {
    const p = paths();
    writeFileSync(
      p.logPath,
      appendRecordToLog("", splitTrade({ pnlUsd: 2, feesUsd: 0 })),
    );
    await cmdLearningStats({ json: true, ...p });
    const out = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    const models = out["models"] as { model: string; scored: number; hits: number }[];
    assert.equal(models.find((m) => m.model === "jev")!.scored, 1);
    assert.equal(models.find((m) => m.model === "jev")!.hits, 1);
    assert.equal(out["liveWeights"] !== null, true);
  });
});

/* ------------------------------------------------------------------ */
/* Store round-trip                                                    */
/* ------------------------------------------------------------------ */

describe("vote.json round-trip", () => {
  it("the gated store survives a save/load cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "jw3-learning-store-"));
    const path = voteStorePath(dir);
    const store = defaultStore();
    store.weights = { jev: 1, kronos: 0.5, rfdetr: 0 };
    syncVoteStore(store, splitTrade());
    const changes = applyPromotionGate(store, summarizeLearningLog(appendRecordToLog("", splitTrade())));
    assert.equal(changes.find((c) => c.track === "kronos")!.weightAfter, 0);
    saveStore(path, store);
    const back = loadStore(path);
    assert.equal(back.weights.kronos, 0);
    assert.equal(back.skills.jev!.total, 1);
  });
});
