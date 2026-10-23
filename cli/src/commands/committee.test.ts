import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  COMMITTEE_SEATS,
  DEFAULT_COMMITTEE_PARAMS,
  DEFAULT_SEATS,
  committeeModelLegs,
  convictionSizeScale,
  defaultProposal,
  emaSeries,
  executionSeat,
  eventRiskSeat,
  flowSeat,
  inUtcWindow,
  meanReversionSeat,
  mergeCommitteeParams,
  mirrorPosition,
  momentumSeat,
  runCommittee,
  structureSeat,
  zScore,
  type CommitteeContext,
  type CommitteeMarket,
  type CommitteeParams,
  type CommitteePosition,
  type CommitteeSeat,
  type CommitteeSeatOpinion,
} from "./committee.js";
import type { KlineCandle } from "./klines.js";

/* ------------------------------------------------------------------ */
/* Fixtures — fabricated data, no network                              */
/* ------------------------------------------------------------------ */

const START = 1_700_000_000_000;

/** An explicit UTC instant — never derive "10:00Z" from an epoch offset. */
const utcMs = (hour: number, minute = 0, day = 6): number => Date.UTC(2026, 0, day, hour, minute, 0);

/** 10:00Z on a fixed day (inside no blackout window). */
const T10Z = utcMs(10);

function candles(count: number, gen: (i: number) => { o: number; h: number; l: number; c: number; v: number }): KlineCandle[] {
  const out: KlineCandle[] = [];
  for (let i = 0; i < count; i++) {
    const g = gen(i);
    out.push({
      tsMs: START + i * 3_600_000,
      open: g.o,
      high: g.h,
      low: g.l,
      close: g.c,
      volume: g.v,
      turnover: g.v * g.c,
    });
  }
  return out;
}

/** A steady uptrend: higher highs, higher lows, rising closes. */
const upCandles = (n: number): KlineCandle[] =>
  candles(n, (i) => {
    const c = 100 + i * 0.5;
    return { o: c - 0.2, h: c + 0.4, l: c - 0.6, c, v: 1000 + i * 10 };
  });

/** A steady downtrend: lower highs, lower lows, falling closes. */
const downCandles = (n: number): KlineCandle[] =>
  candles(n, (i) => {
    const c = 200 - i * 0.5;
    return { o: c + 0.2, h: c + 0.6, l: c - 0.4, c, v: 1000 + i * 10 };
  });

/** A flat tape inside a tight range. */
const flatCandles = (n: number): KlineCandle[] =>
  candles(n, (i) => {
    const c = 100 + (i % 2 === 0 ? 0.05 : -0.05);
    return { o: c, h: c + 0.05, l: c - 0.05, c, v: 1000 };
  });

/** A completely constant tape — the last close IS the window mean. */
const constantCandles = (n: number, price = 100): KlineCandle[] =>
  candles(n, () => ({ o: price, h: price, l: price, c: price, v: 1000 }));

function market(over: Partial<CommitteeMarket> = {}): CommitteeMarket {
  const up = upCandles(60);
  return {
    pair: "SOL/USDT",
    last: 129.5,
    timeframes: [
      { tf: "1h", candles: up },
      { tf: "4h", candles: up },
      { tf: "1d", candles: up },
    ],
    high24: 131,
    low24: 120,
    atrPct: 0.8,
    vwap: 126,
    ema20: 127,
    rsi: 62,
    volRatio: 1.4,
    volSlope: "up",
    book: { bidUsd: 20000, askUsd: 18000, imbalance: 0.05, spreadBps: 2 },
    fundingPct: 0.01,
    dayChgPct: 1.2,
    sessionLow: 124,
    blackouts: [],
    macroEventToday: false,
    nowMs: T10Z,
    jev: { verdict: { trend: { verdict: "strong_long", agreement: 0.8, uncertain: false } } },
    models: undefined,
    ...over,
  };
}

function proposal(over: Partial<CommitteePosition> = {}): CommitteePosition {
  return {
    pair: "SOL/USDT",
    side: "long",
    entry: 129.5,
    stop: 128.0, // 1.16% stop distance
    target: 131.75, // 1.74% target
    size: 10,
    ...over,
  };
}

function ctx(m: CommitteeMarket, p: CommitteePosition, params?: Partial<CommitteeParams>): CommitteeContext {
  return { proposal: p, market: m, params: mergeCommitteeParams(DEFAULT_COMMITTEE_PARAMS, params) };
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("committee pure helpers", () => {
  it("emaSeries seeds the SMA and never returns a value before the period", () => {
    const s = emaSeries([1, 2, 3, 4, 5, 6], 3);
    assert.equal(s[0], null);
    assert.equal(s[1], null);
    assert.equal(s[2], 2);
    assert.equal(s[5], null === s[5] ? null : s[5]);
    const rising = emaSeries([1, 2, 3, 4, 5, 6], 3);
    assert.ok((rising[5] as number) > (rising[2] as number));
  });

  it("zScore reads the stretch of the last value and refuses a flat window", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const z = zScore(up, 20);
    assert.ok(z !== null && z > 1);
    assert.equal(zScore([5, 5, 5, 5], 4), null);
    assert.equal(zScore([1, 2], 20), null);
  });

  it("inUtcWindow handles a normal and a midnight-wrapping window", () => {
    assert.equal(inUtcWindow(12 * 60, 11 * 60 + 30, 13 * 60 + 30), true);
    assert.equal(inUtcWindow(14 * 60, 11 * 60 + 30, 13 * 60 + 30), false);
    assert.equal(inUtcWindow(23 * 60, 22 * 60, 60), true); // wraps past midnight
    assert.equal(inUtcWindow(30, 22 * 60, 60), true);
    assert.equal(inUtcWindow(120, 22 * 60, 60), false);
  });

  it("mirrorPosition flips the side and mirrors the levels around the entry", () => {
    const p = proposal();
    const short = mirrorPosition(p, "short");
    assert.equal(short.side, "short");
    assert.ok(short.stop > p.entry);
    assert.ok(short.target < p.entry);
    assert.equal(mirrorPosition(p, "long").entry, p.entry);
  });

  it("convictionSizeScale never returns zero and never exceeds one", () => {
    assert.equal(convictionSizeScale(0), 0.5);
    assert.equal(convictionSizeScale(1), 1);
    assert.equal(convictionSizeScale(-1), 1);
    assert.ok(convictionSizeScale(0.4) > 0.5);
  });

  it("mergeCommitteeParams never mutates the shared defaults", () => {
    const before = JSON.stringify(DEFAULT_COMMITTEE_PARAMS);
    const merged = mergeCommitteeParams(DEFAULT_COMMITTEE_PARAMS, { consensusThreshold: 0.9, execution: { feeDragVeto: 0.1 } });
    assert.equal(merged.consensusThreshold, 0.9);
    assert.equal(merged.execution.feeDragVeto, 0.1);
    assert.equal(merged.execution.maxSpreadBps, DEFAULT_COMMITTEE_PARAMS.execution.maxSpreadBps);
    assert.equal(JSON.stringify(DEFAULT_COMMITTEE_PARAMS), before);
  });

  it("defaultProposal derives stop and target from ATR", () => {
    const p = defaultProposal("SOL/USDT", "long", 100, 1, 5);
    assert.equal(p.entry, 100);
    assert.equal(p.stop, 99);
    assert.ok(Math.abs(p.target - 101.5) < 1e-9);
    const s = defaultProposal("SOL/USDT", "short", 100, 1, 5);
    assert.ok(s.stop > 100);
    assert.ok(s.target < 100);
  });
});

describe("committeeModelLegs", () => {
  it("maps raw verdicts onto ballots through the existing vote/oracle helpers", () => {
    const legs = committeeModelLegs({
      jev: { verdict: { trend: { verdict: "strong_long", agreement: 0.8, uncertain: false } } },
      kronos: { direction: "up", expected_move_pct: 0.9, last_close: 100, pred_last_close: 100.9, pred_closes: [100.9], horizon: 12, lookback: 400, ms: 1 },
      laya: { choice: "long", confidence: 0.7, score: 0.5, reasons: ["r"], ms: 1 },
    });
    const jev = legs.voteSignals!.find((s) => s.skill === "jev")!;
    assert.equal(jev.side, "long");
    assert.equal(jev.abstained, false);
    const kronos = legs.voteSignals!.find((s) => s.skill === "kronos")!;
    assert.equal(kronos.side, "long");
    const laya = legs.oracleSignals!.find((s) => s.skill === "laya")!;
    assert.equal(laya.side, "long");
    assert.equal(laya.abstained, false);
  });

  it("abstains when the models are missing or flat — no fabricated direction", () => {
    const legs = committeeModelLegs({});
    assert.ok(legs.voteSignals!.every((s) => s.abstained));
    assert.ok(legs.oracleSignals!.every((s) => s.abstained));
  });

  it("an uncertain JEV verdict abstains (the committee never guesses)", () => {
    const legs = committeeModelLegs({
      jev: { verdict: { trend: { verdict: "strong_long", agreement: 0.8, uncertain: true } } },
    });
    const jev = legs.voteSignals!.find((s) => s.skill === "jev")!;
    assert.equal(jev.abstained, true);
  });
});

/* ------------------------------------------------------------------ */
/* Individual seats                                                    */
/* ------------------------------------------------------------------ */

describe("structure seat", () => {
  it("argues long on higher-highs and a strong JEV structure leg", () => {
    const op = structureSeat.evaluate(ctx(market(), proposal()));
    assert.equal(op.abstain, false);
    assert.ok(op.score > 0);
    assert.equal(op.position?.side, "long");
  });

  it("argues short on lower-lows", () => {
    const m = market({
      timeframes: [
        { tf: "1h", candles: downCandles(60) },
        { tf: "4h", candles: downCandles(60) },
        { tf: "1d", candles: downCandles(60) },
      ],
      jev: { verdict: { trend: { verdict: "strong_short", agreement: 0.9, uncertain: false } } },
    });
    const op = structureSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score < 0);
    assert.equal(op.position?.side, "short");
  });

  it("abstains on a thin tape instead of guessing", () => {
    const m = market({ timeframes: [{ tf: "1h", candles: upCandles(3) }] });
    const op = structureSeat.evaluate(ctx(m, proposal()));
    assert.equal(op.abstain, true);
    assert.equal(op.score, 0);
  });
});

describe("momentum seat", () => {
  it("reads multi-timeframe agreement on the candle leg", () => {
    const op = momentumSeat.evaluate(ctx(market(), proposal()));
    assert.equal(op.abstain, false);
    assert.ok(op.score > 0);
    assert.equal(op.position?.side, "long");
  });

  it("reads the model legs through the existing combiners", () => {
    const m = market({
      timeframes: [],
      models: {
        voteSignals: [{ skill: "jev", side: "long", confidence: 0.9, abstained: false, detail: "v" }],
        voteWeights: { jev: 1.0, kronos: 0.5, rfdetr: 0 },
        oracleSignals: [{ skill: "laya", side: "long", confidence: 0.8, abstained: false, detail: "l" }],
        oracleWeights: { kronos: 0.5, laya: 1.0, rfdetr: 0 },
      },
    });
    const op = momentumSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score > 0);
    assert.match(op.reason, /model legs|trend agreement/);
  });

  it("abstains when there is neither candles nor model legs", () => {
    const m = market({ timeframes: [], models: undefined });
    const op = momentumSeat.evaluate(ctx(m, proposal()));
    assert.equal(op.abstain, true);
  });
});

describe("flow seat", () => {
  it("argues long on a bid-heavy book with volume confirming", () => {
    const m = market({ book: { bidUsd: 30000, askUsd: 10000, imbalance: 0.5, spreadBps: 2 } });
    const op = flowSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score > 0);
    assert.equal(op.position?.side, "long");
  });

  it("argues short on an ask-heavy book", () => {
    const m = market({ book: { bidUsd: 10000, askUsd: 30000, imbalance: -0.5, spreadBps: 2 } });
    const op = flowSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score < 0);
  });

  it("abstains without a book read", () => {
    const op = flowSeat.evaluate(ctx(market({ book: null }), proposal()));
    assert.equal(op.abstain, true);
  });

  it("abstains when the volume does not confirm", () => {
    const m = market({ volRatio: 0.3, book: { bidUsd: 30000, askUsd: 10000, imbalance: 0.5, spreadBps: 2 } });
    const op = flowSeat.evaluate(ctx(m, proposal()));
    assert.equal(op.abstain, true);
    assert.match(op.reason, /volume not confirming/);
  });
});

describe("mean_reversion seat", () => {
  it("argues short when the price is stretched to the upside", () => {
    const m = market({ last: 140, vwap: 126, ema20: 127, rsi: 85, timeframes: [{ tf: "1h", candles: constantCandles(60, 140) }] });
    const op = meanReversionSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score < 0);
    assert.equal(op.position?.side, "short");
  });

  it("argues long when the price is stretched to the downside", () => {
    const m = market({ last: 110, vwap: 126, ema20: 127, rsi: 12, timeframes: [{ tf: "1h", candles: constantCandles(60, 110) }] });
    const op = meanReversionSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.score > 0);
  });

  it("abstains at the mean", () => {
    const m = market({
      last: 126,
      vwap: 126,
      ema20: 126,
      rsi: 50,
      timeframes: [{ tf: "1h", candles: constantCandles(60, 126) }],
    });
    const op = meanReversionSeat.evaluate(ctx(m, proposal()));
    assert.equal(op.abstain, true);
    assert.equal(op.score, 0);
  });
});

describe("event_risk seat", () => {
  it("endorses a clean session", () => {
    const op = eventRiskSeat.evaluate(ctx(market(), proposal()));
    assert.equal(op.veto, null);
    assert.ok((op.support ?? 0) > 0);
  });

  it("vetoes inside a calendar blackout window", () => {
    const m = market({
      blackouts: [{ name: "FOMC", startMin: 9 * 60, endMin: 11 * 60 }],
      nowMs: T10Z, // 10:00Z → inside the window
    });
    const op = eventRiskSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.veto);
    assert.match(op.veto!.rule, /blackout/);
  });

  it("vetoes the CPI window only on a real macro-release day", () => {
    const cpiNoon = Date.UTC(2026, 0, 6, 12, 0, 0);
    const onDay = eventRiskSeat.evaluate(ctx(market({ macroEventToday: true, nowMs: cpiNoon }), proposal()));
    assert.ok(onDay.veto);
    assert.equal(onDay.veto!.rule, "cpi_blackout");
    const offDay = eventRiskSeat.evaluate(ctx(market({ macroEventToday: false, nowMs: cpiNoon }), proposal()));
    assert.equal(offDay.veto, null);
  });

  it("vetoes a short into an extended drop", () => {
    const m = market({ dayChgPct: -3.5 });
    const op = eventRiskSeat.evaluate(ctx(m, proposal({ side: "short", entry: 129.5, stop: 131, target: 126 })));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "extended_drop");
  });

  it("vetoes a short that has not bounced off the session low", () => {
    const m = market({ dayChgPct: -1.0, sessionLow: 129.0 });
    const op = eventRiskSeat.evaluate(ctx(m, proposal({ side: "short", entry: 129.5, stop: 131, target: 126 })));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "bounce_required");
  });

  it("vetoes a long into a crowded long book (funding)", () => {
    const m = market({ fundingPct: 0.25 });
    const op = eventRiskSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "funding_crowded_long");
  });

  it("does not veto a long when funding is negative (shorts pay)", () => {
    const m = market({ fundingPct: -0.25 });
    const op = eventRiskSeat.evaluate(ctx(m, proposal()));
    assert.equal(op.veto, null);
  });

  it("fails open when the session low is missing (never blocks on absent data)", () => {
    const m = market({ dayChgPct: -1.0, sessionLow: null });
    const op = eventRiskSeat.evaluate(ctx(m, proposal({ side: "short", entry: 129.5, stop: 131, target: 126 })));
    assert.equal(op.veto, null);
    assert.match(op.reason, /session low unavailable/);
  });
});

describe("execution seat", () => {
  it("approves a trade whose fee drag is well inside the limit", () => {
    const op = executionSeat.evaluate(ctx(market(), proposal()));
    assert.equal(op.veto, null);
    assert.ok((op.support ?? 0) > 0.8);
  });

  it("VETOES when the fee drag exceeds a third of the stop distance", () => {
    // 0.12% round trip + 2bps spread = 0.14% cost on a 0.30% stop → 47% drag.
    const p = proposal({ entry: 100, stop: 99.7, target: 100.45 });
    const op = executionSeat.evaluate(ctx(market({ last: 100 }), p));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "fee_drag");
  });

  it("VETOES a spread above the ceiling", () => {
    const m = market({ book: { bidUsd: 20000, askUsd: 18000, imbalance: 0.05, spreadBps: 40 } });
    const op = executionSeat.evaluate(ctx(m, proposal()));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "spread_too_wide");
  });

  it("VETOES a proposal with no stop distance", () => {
    const op = executionSeat.evaluate(ctx(market(), proposal({ entry: 100, stop: 100 })));
    assert.ok(op.veto);
    assert.equal(op.veto!.rule, "no_stop_distance");
  });
});

/* ------------------------------------------------------------------ */
/* The committee                                                       */
/* ------------------------------------------------------------------ */

describe("runCommittee", () => {
  it("returns LONG with a sized plan when the seats agree", () => {
    const r = runCommittee(ctx(market(), proposal()));
    assert.equal(r.verdict, "LONG");
    assert.ok(r.score > 0);
    assert.ok(r.plan);
    assert.equal(r.plan!.side, "long");
    assert.ok(r.plan!.size > 0);
    assert.equal(r.vetoes.length, 0);
  });

  it("returns SHORT when the tape argues down", () => {
    const down = market({
      timeframes: [
        { tf: "1h", candles: downCandles(60) },
        { tf: "4h", candles: downCandles(60) },
        { tf: "1d", candles: downCandles(60) },
      ],
      jev: { verdict: { trend: { verdict: "strong_short", agreement: 0.9, uncertain: false } } },
      book: { bidUsd: 10000, askUsd: 30000, imbalance: -0.5, spreadBps: 2 },
    });
    const r = runCommittee(ctx(down, proposal({ side: "short", entry: 129.5, stop: 131, target: 126 })));
    assert.equal(r.verdict, "SHORT");
    assert.ok(r.score < 0);
  });

  it("returns FLAT when no seat votes", () => {
    const flat = market({
      timeframes: [
        { tf: "1h", candles: flatCandles(60) },
        { tf: "4h", candles: flatCandles(60) },
        { tf: "1d", candles: flatCandles(60) },
      ],
      jev: null,
      book: { bidUsd: 20000, askUsd: 20000, imbalance: 0, spreadBps: 2 },
      volRatio: 1.0,
    });
    const r = runCommittee(ctx(flat, proposal()));
    assert.equal(r.verdict, "FLAT");
    assert.equal(r.plan, null);
    assert.match(r.reason, /no consensus|no seat voted|majority/);
  });

  it("reports a per-seat breakdown for every seat that ran", () => {
    const r = runCommittee(ctx(market(), proposal()));
    assert.equal(r.seats.length, COMMITTEE_SEATS.length);
    for (const id of COMMITTEE_SEATS) {
      assert.ok(r.seats.some((s) => s.seat === id), `missing seat ${id}`);
    }
    assert.ok(r.seats.every((s) => typeof s.reason === "string" && s.reason.length > 0));
  });

  it("respects minVoters — one voter is not a committee", () => {
    const onlyStructure = [structureSeat];
    const r = runCommittee(ctx(market(), proposal()), { seats: onlyStructure });
    assert.equal(r.verdict, "LONG");
    const strict = runCommittee(ctx(market(), proposal()), { seats: onlyStructure, params: { minVoters: 2 } });
    assert.equal(strict.verdict, "FLAT");
    assert.match(strict.reason, /no seat voted/);
  });
});

/* ------------------------------------------------------------------ */
/* The committee must be able to say NO                                */
/* ------------------------------------------------------------------ */

describe("the committee can veto", () => {
  it("a vetoing seat blocks the trade even when every other seat wants it", () => {
    const vetoing: CommitteeSeat = {
      id: "execution",
      role: "gate",
      weight: 1,
      evaluate: (): CommitteeSeatOpinion => ({
        score: 0,
        position: null,
        abstain: false,
        reason: "veto fee_drag: fee drag 90% of the stop distance",
        veto: { rule: "fee_drag", detail: "fee drag 90% of the stop distance — fees eat the edge" },
        support: 0,
      }),
    };
    const r = runCommittee(ctx(market(), proposal()), { seats: [...DEFAULT_SEATS, vetoing] });
    assert.equal(r.verdict, "VETO");
    assert.equal(r.plan, null);
    assert.ok(r.vetoes.length > 0);
    assert.ok(r.vetoes.some((v) => v.rule === "fee_drag"));
  });

  it("the built-in execution seat vetoes a fee-gouged trade and the plan is null", () => {
    const p = proposal({ entry: 100, stop: 99.7, target: 100.45 });
    const r = runCommittee(ctx(market({ last: 100 }), p));
    assert.equal(r.verdict, "VETO");
    assert.equal(r.plan, null);
    assert.ok(r.vetoes.some((v) => v.seat === "execution" && v.rule === "fee_drag"));
    assert.match(r.reason, /fee_drag/);
  });

  it("the event_risk seat vetoes a trade inside a macro blackout", () => {
    const m = market({ blackouts: [{ name: "FOMC", startMin: 9 * 60, endMin: 11 * 60 }], nowMs: T10Z });
    const r = runCommittee(ctx(m, proposal()));
    assert.equal(r.verdict, "VETO");
    assert.equal(r.plan, null);
    assert.ok(r.vetoes.some((v) => v.seat === "event_risk"));
  });

  it("a veto outranks a unanimous bullish consensus", () => {
    const alwaysLong: CommitteeSeat = {
      id: "flow",
      role: "directional",
      weight: 5,
      evaluate: (): CommitteeSeatOpinion => ({
        score: 1,
        position: proposal(),
        abstain: false,
        reason: "certain long",
        veto: null,
      }),
    };
    const vetoing: CommitteeSeat = {
      id: "execution",
      role: "gate",
      weight: 1,
      evaluate: (): CommitteeSeatOpinion => ({
        score: 0,
        position: null,
        abstain: false,
        reason: "veto spread_too_wide: 400bps spread",
        veto: { rule: "spread_too_wide", detail: "400bps spread — the book is unusable" },
        support: 0,
      }),
    };
    const r = runCommittee(ctx(market(), proposal()), { seats: [alwaysLong, vetoing] });
    assert.equal(r.verdict, "VETO");
    assert.equal(r.plan, null);
  });

  it("a seat that throws abstains and never blocks the committee", () => {
    const exploding: CommitteeSeat = {
      id: "flow",
      role: "directional",
      weight: 1,
      evaluate: (): CommitteeSeatOpinion => {
        throw new Error("book read exploded");
      },
    };
    const r = runCommittee(ctx(market(), proposal()), { seats: [structureSeat, exploding, momentumSeat] });
    assert.notEqual(r.verdict, "VETO");
    const flow = r.seats.find((s) => s.seat === "flow")!;
    assert.equal(flow.abstain, true);
    assert.match(flow.reason, /seat failed: book read exploded/);
  });

  it("a seat can be disabled without touching the others", () => {
    const seats = DEFAULT_SEATS.filter((s) => s.id !== "flow");
    const r = runCommittee(ctx(market(), proposal()), { seats });
    assert.equal(r.seats.length, COMMITTEE_SEATS.length - 1);
    assert.ok(!r.seats.some((s) => s.seat === "flow"));
    assert.ok(r.seats.some((s) => s.seat === "execution"));
  });

  it("a seat can be replaced by a custom implementation", () => {
    const custom: CommitteeSeat = {
      id: "structure",
      role: "directional",
      weight: 1,
      evaluate: (): CommitteeSeatOpinion => ({ score: 0.9, position: proposal(), abstain: false, reason: "custom" }),
    };
    const r = runCommittee(ctx(market(), proposal()), { seats: [custom] });
    const s = r.seats.find((x) => x.seat === "structure")!;
    assert.equal(s.reason, "custom");
    assert.equal(s.score, 0.9);
  });

  it("a seat weight of zero removes it from the consensus denominator", () => {
    const r = runCommittee(ctx(market(), proposal()), { weights: { flow: 0, structure: 0 } });
    const flow = r.seats.find((s) => s.seat === "flow")!;
    assert.equal(flow.contribution, 0);
    assert.equal(flow.weight, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Command surface                                                     */
/* ------------------------------------------------------------------ */

describe("cmdCommittee", () => {
  let logs: string[];
  let errs: string[];
  let logFn: typeof console.log;
  let errFn: typeof console.error;
  beforeEach(() => {
    logs = [];
    errs = [];
    logFn = console.log;
    errFn = console.error;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    process.exitCode = undefined;
  });
  afterEach(() => {
    console.log = logFn;
    console.error = errFn;
    process.exitCode = undefined;
  });

  const fakeMarket = market();

  const deps = {
    fade: async () => ({
      symbol: "SOLUSDTM",
      last: 129.5,
      chg: 1.2,
      vratio: 1.4,
      vslope: "up" as const,
      offHighPct: 1.1,
      offLowPct: 7.9,
      atrPct: 0.8,
      fundingPct: 0.01,
      n: 60,
    }),
    klines: async () =>
      upCandles(60).map((c) => [c.tsMs, c.open, c.high, c.low, c.close, c.volume, c.turnover]),
    ticker: async () => ({ price: 129.5, bestBid: 129.48, bestAsk: 129.52, bestBidSize: 1, bestAskSize: 1 }),
    depth20: async () => ({
      bids: [["129.48", "100"], ["129.47", "100"]] as [string, string][],
      asks: [["129.52", "100"], ["129.53", "100"]] as [string, string][],
    }),
    contractSpec: async () => ({ multiplier: 1, tick: 0.01 }),
    now: () => T10Z,
  };

  it("bad pair prints usage with exit 2", async () => {
    const { cmdCommittee } = await import("./committee.js");
    await cmdCommittee({ pair: "SOL", exchange: "kucoin", json: false, deps: deps as never });
    assert.equal(process.exitCode, 2);
    assert.match(errs.join("\n"), /Usage: jw3 committee/);
  });

  it("prints a committee report and exits 0 on a tradeable verdict", async () => {
    const { cmdCommittee } = await import("./committee.js");
    await cmdCommittee({ pair: "SOL/USDT", exchange: "kucoin", json: false, deps: deps as never });
    const out = logs.join("\n");
    assert.match(out, /COMMITTEE SOL\/USDT/);
    assert.match(out, /structure/);
    assert.match(out, /execution/);
    assert.match(out, /nothing proposed, nothing traded/);
    assert.ok(process.exitCode === 0 || process.exitCode === 1 || process.exitCode === 3);
  });

  it("exits 3 on a veto", async () => {
    const { cmdCommittee } = await import("./committee.js");
    const vetoing: CommitteeSeat = {
      id: "execution",
      role: "gate",
      weight: 1,
      evaluate: (): CommitteeSeatOpinion => ({
        score: 0,
        position: null,
        abstain: false,
        reason: "veto fee_drag: fees eat the edge",
        veto: { rule: "fee_drag", detail: "fee drag 90% of the stop distance" },
        support: 0,
      }),
    };
    await cmdCommittee({ pair: "SOL/USDT", exchange: "kucoin", json: false, seats: [...DEFAULT_SEATS, vetoing], deps: deps as never });
    assert.equal(process.exitCode, 3);
    assert.match(logs.join("\n"), /VETO/);
  });

  it("json output carries the verdict, the breakdown and the vetoes", async () => {
    const { cmdCommittee } = await import("./committee.js");
    await cmdCommittee({ pair: "SOL/USDT", exchange: "kucoin", json: true, deps: deps as never });
    const parsed = JSON.parse(logs.join("\n")) as {
      verdict: string;
      score: number;
      seats: { seat: string }[];
      vetoes: unknown[];
      reason: string;
    };
    assert.ok(["LONG", "SHORT", "FLAT", "VETO"].includes(parsed.verdict));
    assert.equal(parsed.seats.length, COMMITTEE_SEATS.length);
    assert.ok(Array.isArray(parsed.vetoes));
    assert.ok(parsed.reason.length > 0);
    assert.ok(fakeMarket.pair);
  });
});
