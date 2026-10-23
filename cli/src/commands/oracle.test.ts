import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  combineOracleVote,
  layaToSignal,
  oracleWeightsFromStore,
  rfdetrOracleSignal,
  cmdOracle,
  oraclePrefilter,
  type OracleSignal,
} from "./oracle.js";

const sig = (skill: "kronos" | "laya" | "rfdetr", side: "long" | "short" | "flat" = "long", confidence = 0.8): OracleSignal =>
  side === "flat"
    ? { skill, side, confidence: 0, abstained: true, detail: "abstain" }
    : { skill, side, confidence, abstained: false, detail: "vote" };

const W = { kronos: 0.5, laya: 1.0, rfdetr: 0 };

describe("layaToSignal", () => {
  it("maps long/short with bridge confidence, flat abstains", () => {
    assert.equal(layaToSignal({ choice: "long", confidence: 0.72, score: 0.5, reasons: ["r"], ms: 1 }).side, "long");
    assert.equal(layaToSignal({ choice: "short", confidence: 0.6, score: -0.4, reasons: ["r"], ms: 1 }).side, "short");
    const flat = layaToSignal({ choice: "flat", confidence: 0.5, score: 0, reasons: [], ms: 1 });
    assert.equal(flat.abstained, true);
    assert.equal(layaToSignal(null).abstained, true);
  });
});

describe("rfdetrOracleSignal", () => {
  it("abstains until the pattern server lands", () => {
    const s = rfdetrOracleSignal();
    assert.equal(s.skill, "rfdetr");
    assert.equal(s.abstained, true);
  });
});

describe("combineOracleVote", () => {
  it("empty ballot is flat, never fabricated", () => {
    const v = combineOracleVote([sig("kronos", "flat"), sig("laya", "flat"), sig("rfdetr", "flat")], W);
    assert.equal(v.side, "flat");
    assert.equal(v.voters, 0);
  });
  it("zero-weight and abstained skills sit out", () => {
    const v = combineOracleVote([sig("kronos", "long", 1), sig("rfdetr", "short", 1)], W);
    assert.equal(v.voters, 1);
    assert.equal(v.side, "long");
  });
  it("weak agreement is flat (no consensus)", () => {
    const v = combineOracleVote([sig("kronos", "long", 0.1), sig("laya", "short", 0.1)], W);
    assert.equal(v.side, "flat");
  });
  it("laya weight decides ties (inherits the jev track)", () => {
    const v = combineOracleVote([sig("kronos", "short", 0.9), sig("laya", "long", 0.9)], W);
    assert.equal(v.side, "long");
  });
});

describe("oracleWeightsFromStore", () => {
  it("laya inherits the jev track, others map straight across", () => {
    assert.deepEqual(oracleWeightsFromStore({ jev: 1.2, kronos: 0.4, rfdetr: 0.1 }), {
      kronos: 0.4,
      laya: 1.2,
      rfdetr: 0.1,
    });
  });
});

describe("cmdOracle", () => {
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

  // ── THE CLOCK MUST BE PINNED ──
  //
  // The CPI blackout is a WINDOW (11:30-13:30Z), not a calendar day.
  // A test that reads the wall clock therefore passes for 22 hours and
  // fails for 2 — a flaky test by construction. It failed live today
  // at 11:50Z with "ORACLE SOL/USDT — FLAT (prefilter:cpi_blackout)".
  //
  // 2026-01-01T00:00:00Z — comfortably outside every time-based
  // pre-filter window.
  const OUTSIDE_BLACKOUT = Date.UTC(2026, 0, 1, 0, 0, 0);
  const deps = {
    kronos: async () => ({ direction: "up", expected_move_pct: 0.8, last_close: 100, pred_last_close: 100.8, pred_closes: [100.8], horizon: 12, lookback: 400, ms: 1 }) as never,
    marketState: async () => ({}) as never,
    laya: async () => ({ choice: "long", confidence: 0.7, score: 0.5, reasons: ["jev long"], ms: 1 }) as never,
    nowMs: OUTSIDE_BLACKOUT,
  };

  it("bad pair prints usage with exit 2", async () => {
    await cmdOracle({ pair: "SOL", exchange: "kucoin", horizon: 12, json: false, deps });
    assert.equal(process.exitCode, 2);
    assert.match(errs.join("\n"), /Usage: jw3 oracle/);
  });

  it("mocked fan-out prints one LONG verdict, read-only", async () => {
    await cmdOracle({ pair: "SOL/USDT", exchange: "kucoin", horizon: 12, json: false, storePath: "/nonexistent-jw3-oracle-test/vote.json", deps });
    assert.equal(process.exitCode, undefined);
    assert.match(logs[0] ?? "", /ORACLE SOL\/USDT — LONG/);
    assert.match(logs.join("\n"), /nothing proposed, nothing traded/);
  });

  it("all-abstain exits 1 with no verdict", async () => {
    const dead = {
      kronos: async () => { throw new Error("tape short"); },
      marketState: async () => { throw new Error("thin tape"); },
      laya: async () => { throw new Error("unreachable"); },
      nowMs: OUTSIDE_BLACKOUT,
    };
    await cmdOracle({ pair: "SOL/USDT", exchange: "kucoin", horizon: 12, json: false, storePath: "/nonexistent-jw3-oracle-test/vote.json", deps: dead as never });
    assert.equal(process.exitCode, 1);
    assert.match(errs.join("\n"), /every model abstained/);
  });
});

// ── THE CPI BLACKOUT MUST STILL VETO WHEN THE CLOCK SAYS SO ──────────
//
// The clock is injectable so the tests are not flaky. An injectable
// veto that nobody exercises is a veto that can be broken silently —
// so this pins that the window still bites.
describe("the CPI blackout is a WINDOW, and the clock is pinned", () => {
  const OUTSIDE = Date.UTC(2026, 0, 1, 0, 0, 0);
  const INSIDE = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("outside the window, the prefilter passes", () => {
    const r = oraclePrefilter("SOL/USDT", OUTSIDE);
    assert.equal(r.vetoed, false, `the prefilter vetoed outside the blackout: ${r.detail}`);
  });

  it("inside the window, the command returns FLAT and calls NO model", async () => {
    // The veto is supposed to answer FLAT WITHOUT consulting a model.
    // A veto that still ran the fan-out would cost the account a call
    // and produce a verdict the veto meant to suppress.
    const logs: string[] = [];
    const logFn = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let kronosCalls = 0;
    try {
      await cmdOracle({
        pair: "SOL/USDT", exchange: "kucoin", horizon: 12, json: false,
        storePath: "/nonexistent-jw3-oracle-test/vote.json",
        deps: {
          kronos: async () => { kronosCalls++; return { direction: "up" } as never; },
          marketState: async () => ({}) as never,
          laya: async () => ({ choice: "long", confidence: 0.7, score: 0.5, reasons: [], ms: 1 }) as never,
          nowMs: INSIDE,
        },
      });
    } finally {
      console.log = logFn;
    }
    assert.equal(kronosCalls, 0, "the veto must answer before any model inference");
    assert.match(logs.join("\n"), /cpi_blackout/);
  });

  it("inside the window, the prefilter vetoes", () => {
    const r = oraclePrefilter("SOL/USDT", INSIDE);
    assert.equal(r.vetoed, true);
    assert.equal(r.rule, "cpi_blackout");
  });

  it("the window is 11:30-13:30Z, half-open on the end", () => {
    // The end bound is EXCLUSIVE (`m < END_MIN`), so 13:30 is already
    // outside the window.
    assert.equal(oraclePrefilter("SOL/USDT", Date.UTC(2026, 0, 1, 11, 29, 0)).vetoed, false);
    assert.equal(oraclePrefilter("SOL/USDT", Date.UTC(2026, 0, 1, 11, 30, 0)).vetoed, true);
    assert.equal(oraclePrefilter("SOL/USDT", Date.UTC(2026, 0, 1, 13, 29, 0)).vetoed, true);
    assert.equal(oraclePrefilter("SOL/USDT", Date.UTC(2026, 0, 1, 13, 30, 0)).vetoed, false);
  });
});
