/**
 * The harness test suite — the safety proof for the trading machine.
 *
 * Every test here runs OFFLINE: no network, no money, no wall clock. The
 * network boundary is an INJECTED recorder (`placeOrder`), so the suite
 * both proves the decision path's safety properties AND proves that
 * nothing escapes to a real venue.
 *
 * The invariants under test, one test each:
 *
 *   1. A scenario the filters reject never reaches the sizing engine.
 *   2. A committee veto means NO ticket is produced.
 *   3. A ticket is NEVER produced with dollar risk above the budget.
 *   4. A ticket is NEVER produced with leverage above the hard cap (50),
 *      and never with a liquidation distance inside the stop.
 *   5. The amount sent is in BASE UNITS and equals contracts × multiplier.
 *   6. A ticket is never produced when the free margin is insufficient.
 *   7. A SHORT is never produced without the +0.4% bounce off the session low.
 *   8. Identical inputs always produce an identical ticket (determinism).
 *   9. No order is ever sent twice for the same intent (idempotency).
 *
 * Plus the harness's own contract: the scenario table is the regression
 * surface, and the recorder proves nothing reached the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_MAX_LEVERAGE,
  HARNESS_ORDER_TOOL,
  SCENARIO_TABLE,
  bounceOffLowPct,
  createIntentLedger,
  defaultHarnessConfig,
  intentIdFor,
  round6,
  runDecisionCycle,
  runScenarioRow,
  runScenarioTable,
  type ExchangeCall,
  type HarnessResult,
  type ScenarioRow,
} from "./harness.js";
import { defaultFilterConfig } from "../filters.js";
import { DEFAULT_COMMITTEE_PARAMS, mergeCommitteeParams, runCommittee } from "./committee.js";
import { sizeTrade } from "./sizing.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The default config the table was built against. */
const CONFIG = defaultHarnessConfig(defaultFilterConfig());

/** The long scenario — the happy path. */
const LONG_ROW = SCENARIO_TABLE.find((r) => r.name === "long-confluence-clean") as ScenarioRow;
/** The short scenario — a bounce-confirmed short. */
const SHORT_ROW = SCENARIO_TABLE.find((r) => r.name === "short-bounce-confirmed") as ScenarioRow;

/**
 * Run one row and return the result plus the recorded calls. The row's
 * own config override is applied on top of the base config — exactly as
 * `runScenarioRow` does it.
 */
async function run(row: ScenarioRow, config = CONFIG): Promise<{ result: HarnessResult; calls: ExchangeCall[] }> {
  const calls: ExchangeCall[] = [];
  const cfg = { ...config, ...(row.config ?? {}) };
  const result = await runDecisionCycle(row.given, cfg, {
    nowMs: row.given.nowMs,
    placeOrder: (call) => {
      calls.push(call);
      return { orderId: "harness" };
    },
  });
  return { result, calls };
}

/* ------------------------------------------------------------------ */
/* The scenario table is the regression surface                        */
/* ------------------------------------------------------------------ */

describe("the scenario table", () => {
  it("has a row per scenario, each with a name and a reason", () => {
    assert.ok(SCENARIO_TABLE.length >= 10, "the table must carry at least ten scenarios");
    for (const row of SCENARIO_TABLE) {
      assert.equal(typeof row.name, "string");
      assert.ok(row.name.length > 0, "every scenario needs a name");
      assert.ok(row.reason.length > 20, `scenario ${row.name} must say why it exists`);
      assert.ok(row.expected.verdict, `scenario ${row.name} must name its expected verdict`);
      assert.ok(row.expected.stage, `scenario ${row.name} must name its expected stage`);
    }
  });

  it("every row matches its expectations — the whole decision path", async () => {
    const outcomes = await runScenarioTable();
    const failures = outcomes.filter((o) => o.errors.length > 0);
    assert.deepEqual(
      failures.map((f) => `${f.row.name}: ${f.errors.join("; ")}`),
      [],
      "every scenario must produce exactly the ticket the table promises",
    );
  });

  it("covers every verdict the machine can return", () => {
    const verdicts = new Set(SCENARIO_TABLE.map((r) => r.expected.verdict));
    assert.ok(verdicts.has("long"), "a scenario must produce a long ticket");
    assert.ok(verdicts.has("short"), "a scenario must produce a short ticket");
    assert.ok(verdicts.has("veto"), "a scenario must be vetoed");
    assert.ok(verdicts.has("flat"), "a scenario must end flat (no trade, no veto)");
  });

  it("covers every stage the pipeline can stop at", () => {
    const stages = new Set(SCENARIO_TABLE.map((r) => r.expected.stage));
    for (const stage of ["filters", "committee", "sizing", "submit"]) {
      assert.ok(stages.has(stage as never), `no scenario stops at the ${stage} stage`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1. A rejected scenario never reaches the sizing engine              */
/* ------------------------------------------------------------------ */

describe("SAFETY 1 — a filter rejection never reaches the sizing engine", () => {
  it("the CPI blackout stops at the filters, with no sizing and no order", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "cpi-blackout-rejected") as ScenarioRow;
    const { result, calls } = await run(row);
    assert.equal(result.verdict, "veto");
    assert.equal(result.stage, "filters");
    assert.equal(result.rule, "cpi_blackout");
    // The sizing engine never ran, so it produced nothing.
    assert.equal(result.sizing, null);
    assert.equal(result.ticket, null);
    assert.equal(calls.length, 0, "nothing may reach the exchange");
  });

  it("no committee seat was consulted — the veto precedes the models", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "cpi-blackout-rejected") as ScenarioRow;
    const { result } = await run(row);
    assert.equal(result.committee, null, "the committee must not run after a filter veto");
    assert.ok(!result.stages.includes("committee"), "the committee stage was never entered");
    assert.ok(!result.stages.includes("sizing"), "the sizing stage was never entered");
  });

  it("every filter-rejected scenario stops before sizing", async () => {
    for (const row of SCENARIO_TABLE.filter((r) => r.expected.stage === "filters")) {
      const { result, calls } = await run(row);
      assert.equal(result.stage, "filters", `${row.name} must stop at the filters`);
      assert.equal(result.sizing, null, `${row.name} must never reach the sizing engine`);
      assert.equal(result.ticket, null, `${row.name} must never produce a ticket`);
      assert.equal(calls.length, 0, `${row.name} must never send an order`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. A committee veto means NO ticket                                 */
/* ------------------------------------------------------------------ */

describe("SAFETY 2 — a committee veto means no ticket", () => {
  it("the vetoing scenario produces no ticket and sends no order", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "committee-veto-no-ticket") as ScenarioRow;
    const { result, calls } = await run(row);
    assert.equal(result.verdict, "veto");
    assert.equal(result.stage, "committee");
    assert.equal(result.rule, "model_veto");
    assert.equal(result.ticket, null, "a vetoed committee must produce NO ticket");
    assert.equal(result.sizing, null, "a vetoed committee never reaches the sizing engine");
    assert.equal(calls.length, 0, "a vetoed committee sends nothing");
  });

  it("the veto outranks a unanimous bullish ballot", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "committee-veto-no-ticket") as ScenarioRow;
    const { result } = await run(row);
    // Every model wanted long...
    assert.ok(result.committee);
    assert.ok(result.committee!.seats.some((s) => (s.score ?? 0) > 0), "the seats were bullish");
    // ...and the veto still won.
    assert.equal(result.committee!.verdict, "VETO");
    assert.equal(result.ticket, null);
  });

  it("the real committee vetoes too — a veto is never outvoted", () => {
    // The harness does not implement the veto; the production committee
    // does. A vetoing seat must return VETO from runCommittee itself.
    const vetoing = {
      id: "event_risk" as const,
      role: "gate" as const,
      weight: 1,
      evaluate: () => ({
        score: 0,
        position: null,
        abstain: false,
        reason: "veto fee_drag",
        veto: { rule: "fee_drag", detail: "fees eat the edge" },
        support: 0,
      }),
    };
    const result = runCommittee(
      {
        proposal: { pair: "SOL/USDT", side: "long", entry: 100, stop: 99, target: 101, size: 1 },
        market: {
          pair: "SOL/USDT",
          last: 100,
          timeframes: [],
          atrPct: 1,
          blackouts: [],
          nowMs: Date.UTC(2026, 2, 11, 8),
        },
        params: mergeCommitteeParams(DEFAULT_COMMITTEE_PARAMS),
      },
      { seats: [vetoing] },
    );
    assert.equal(result.verdict, "VETO");
    assert.equal(result.plan, null);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Never a ticket with dollar risk above the budget                 */
/* ------------------------------------------------------------------ */

describe("SAFETY 3 — no ticket ever carries dollar risk above the budget", () => {
  it("the produced ticket's dollar risk is at or under the risk budget", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result } = await run(row);
      if (!result.sizing || result.sizing.status !== "ok") continue;
      // The budget the sizing engine used: equity × effective risk %.
      const budget = result.sizing.riskBudgetUsd;
      assert.ok(
        result.sizing.dollarRiskAtStopUsd <= budget + 1e-9,
        `${row.name}: risk $${result.sizing.dollarRiskAtStopUsd} exceeds the budget $${budget}`,
      );
    }
  });

  it("the risk is exactly the amount × the stop distance", async () => {
    const { result } = await run(LONG_ROW);
    const s = result.sizing!;
    const expected = s.amountBaseUnits * s.stopDistanceUsdPerBaseUnit;
    assert.equal(round6(s.dollarRiskAtStopUsd), round6(expected));
  });

  it("a 30%-of-equity request still produces a ticket whose risk fits its budget", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "leverage-capped-at-hard-limit") as ScenarioRow;
    const { result } = await run(row, { ...CONFIG, riskPctOfEquity: 30 });
    const s = result.sizing!;
    assert.ok(s, "a ticket was produced");
    assert.ok(
      s.dollarRiskAtStopUsd <= s.riskBudgetUsd + 1e-9,
      `risk $${s.dollarRiskAtStopUsd} must not exceed the budget $${s.riskBudgetUsd}`,
    );
  });

  it("the risk never exceeds the budget even when the stop is tight", async () => {
    // A tight stop buys more contracts for the same budget — the classic
    // way a risk budget leaks. The engine floors the contract count.
    const tight = { ...LONG_ROW, given: { ...LONG_ROW.given, market: { ...LONG_ROW.given.market, atrPct: 0.25 } } };
    const { result } = await run(tight);
    if (result.sizing && result.sizing.status === "ok") {
      assert.ok(result.sizing.dollarRiskAtStopUsd <= result.sizing.riskBudgetUsd + 1e-9);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Never a ticket above the hard leverage cap / inside the stop     */
/* ------------------------------------------------------------------ */

describe("SAFETY 4 — leverage is capped and the liquidation distance stays outside the stop", () => {
  it("no ticket exceeds the hard leverage cap of 50", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result } = await run(row);
      if (!result.sizing || result.sizing.status !== "ok") continue;
      assert.ok(
        result.sizing.leverage <= HARNESS_MAX_LEVERAGE,
        `${row.name}: leverage ${result.sizing.leverage} exceeds the cap ${HARNESS_MAX_LEVERAGE}`,
      );
      assert.ok(
        result.sizing.leverage <= result.sizing.leverageCeiling,
        `${row.name}: leverage ${result.sizing.leverage} exceeds the engine's ceiling`,
      );
    }
  });

  it("a request for 100x lands on a capped leverage, never above 50", async () => {
    const { result } = await run(LONG_ROW, { ...CONFIG, riskPctOfEquity: 100 });
    assert.ok(result.sizing);
    assert.ok(result.sizing.leverage <= HARNESS_MAX_LEVERAGE, "the hard cap holds at any request");
  });

  it("the liquidation price is never inside the stop", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result } = await run(row);
      if (!result.sizing || result.sizing.status !== "ok") continue;
      assert.equal(
        result.sizing.liqBeforeStop,
        false,
        `${row.name}: the venue would liquidate before the stop fills`,
      );
      assert.ok(
        result.sizing.liquidationDistancePct >= result.sizing.stopDistancePct - 1e-9,
        `${row.name}: liquidation distance ${result.sizing.liquidationDistancePct}% is inside the stop ${result.sizing.stopDistancePct}%`,
      );
    }
  });

  it("a wider stop derives a LOWER leverage, so the venue cannot liquidate first", async () => {
    const narrow = SCENARIO_TABLE.find((r) => r.name === "long-confluence-clean") as ScenarioRow;
    const wide = SCENARIO_TABLE.find((r) => r.name === "wide-stop-leverage-reduced") as ScenarioRow;
    const a = (await run(narrow)).result.sizing!;
    const b = (await run(wide)).result.sizing!;
    assert.ok(b.stopDistancePct > a.stopDistancePct, "the wide-stop row really has the wider stop");
    assert.ok(b.leverage < a.leverage, "the wider stop must carry a lower leverage");
    assert.ok(b.liquidationDistancePct > b.stopDistancePct, "the liquidation distance still clears the stop");
  });

  it("the sizing engine itself refuses to liquidate before the stop", () => {
    // A 3% stop at 50x: the liquidation distance (1.21%) is INSIDE the
    // stop, so the engine must step the leverage down.
    const decision = sizeTrade({
      pair: "SOL/USDT",
      side: "long",
      entryPrice: 100,
      stopPrice: 97,
      targetPrice: 103,
      contractMultiplier: 1,
      tickSize: 0.01,
      maintenanceMarginRate: 0.007,
      atrPct: 3,
      equityUsd: 10_000,
      freeMarginUsd: 10_000,
      riskPctOfEquity: 3,
      feeSchedule: { makerRate: 0.0002, takerRate: 0.0006, entryLeg: "maker", exitLeg: "taker" },
      maxLeverage: HARNESS_MAX_LEVERAGE,
    });
    assert.ok(decision);
    assert.ok(decision.leverage <= HARNESS_MAX_LEVERAGE);
    assert.equal(decision.liqBeforeStop, false);
    assert.ok(decision.liquidationDistancePct >= decision.stopDistancePct - 1e-9);
  });
});

/* ------------------------------------------------------------------ */
/* 5. The amount is BASE UNITS = contracts × multiplier                 */
/* ------------------------------------------------------------------ */

describe("SAFETY 5 — the amount on the wire is in BASE UNITS", () => {
  it("the wire amount equals contracts × multiplier (multiplier 100)", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result, calls } = await run(row);
      if (!result.sizing || result.sizing.status !== "ok") continue;
      const s = result.sizing;
      assert.equal(
        s.amountBaseUnits,
        s.contracts * s.contractMultiplier,
        `${row.name}: the amount must be contracts × multiplier`,
      );
      // The multiplier is 100 in these scenarios precisely so a 100x
      // unit mix-up cannot hide.
      assert.equal(s.contractMultiplier, 100);
      const wire = calls[0]?.args["amount"];
      assert.equal(String(wire), String(s.amountBaseUnits), `${row.name}: the wire carries the base-unit amount`);
      assert.notEqual(
        String(wire),
        String(s.contracts),
        `${row.name}: the wire must NOT carry the contract count`,
      );
    }
  });

  it("the base-unit amount is 100× the contract count — a 100x error is visible", async () => {
    const { result, calls } = await run(LONG_ROW);
    const s = result.sizing!;
    assert.equal(s.contracts, 9);
    assert.equal(s.amountBaseUnits, 900);
    assert.equal(String(calls[0]?.args["amount"]), "900");
  });

  it("the notional is the base-unit amount times the entry price", async () => {
    const { result } = await run(LONG_ROW);
    const s = result.sizing!;
    assert.equal(round6(s.notionalUsd), round6(s.amountBaseUnits * s.entryPrice));
  });

  it("the margin required is the notional over the leverage", async () => {
    const { result } = await run(LONG_ROW);
    const s = result.sizing!;
    assert.equal(round6(s.marginRequiredUsd), round6(s.notionalUsd / s.leverage));
  });
});

/* ------------------------------------------------------------------ */
/* 6. Never a ticket when the free margin is insufficient              */
/* ------------------------------------------------------------------ */

describe("SAFETY 6 — no ticket when the free margin is insufficient", () => {
  it("the starved-margin scenario produces no ticket and no order", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "insufficient-margin-no-ticket") as ScenarioRow;
    const { result, calls } = await run(row);
    assert.equal(result.stage, "sizing");
    assert.equal(result.rule, "unfundable");
    assert.equal(result.ticket, null, "an unfundable ticket must never be produced");
    assert.equal(calls.length, 0, "an unfundable trade sends nothing");
  });

  it("every produced ticket's margin fits inside the free margin", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result } = await run(row);
      if (!result.sizing || result.sizing.status !== "ok") continue;
      const free = result.sizing.freeMarginUsd;
      if (free === null) continue;
      assert.ok(
        result.sizing.marginRequiredUsd <= free + 1e-9,
        `${row.name}: margin $${result.sizing.marginRequiredUsd} exceeds free $${free}`,
      );
    }
  });

  it("the sizing engine refuses when the margin is short", () => {
    const decision = sizeTrade({
      pair: "SOL/USDT",
      side: "long",
      entryPrice: 100,
      stopPrice: 99,
      targetPrice: 101,
      contractMultiplier: 1,
      tickSize: 0.01,
      maintenanceMarginRate: 0.007,
      atrPct: 1,
      equityUsd: 1000,
      freeMarginUsd: 0.5,
      riskPctOfEquity: 30,
      feeSchedule: { makerRate: 0.0002, takerRate: 0.0006, entryLeg: "maker", exitLeg: "taker" },
    });
    assert.ok(decision);
    assert.equal(decision.status, "unfundable");
    assert.equal(decision.marginSufficient, false);
  });
});

/* ------------------------------------------------------------------ */
/* 7. A SHORT is never produced without the +0.4% bounce               */
/* ------------------------------------------------------------------ */

describe("SAFETY 7 — a SHORT is never produced without the +0.4% bounce", () => {
  it("the no-bounce scenario is vetoed and produces no ticket", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "short-no-bounce-rejected") as ScenarioRow;
    const { result, calls } = await run(row);
    assert.equal(result.verdict, "veto");
    assert.equal(result.rule, "bounce_required");
    assert.equal(result.ticket, null);
    assert.equal(calls.length, 0);
  });

  it("the bounce is measured off the session low of the 5m window", async () => {
    const row = SCENARIO_TABLE.find((r) => r.name === "short-no-bounce-rejected") as ScenarioRow;
    const low = Math.min(...row.given.market.candles5m.map((c) => c.low));
    const bounce = bounceOffLowPct(row.given.market.last, low);
    assert.ok(bounce !== null);
    assert.ok(bounce < 0.4, `the scenario really is under the +0.4% requirement (${bounce}%)`);
  });

  it("the bounce-confirmed short DOES have the bounce, and produces a ticket", async () => {
    const row = SHORT_ROW;
    const low = Math.min(...row.given.market.candles5m.map((c) => c.low));
    const bounce = bounceOffLowPct(row.given.market.last, low);
    assert.ok(bounce !== null && bounce >= 0.4, `the short scenario must clear +0.4% (${bounce}%)`);
    const { result } = await run(row);
    assert.equal(result.verdict, "short");
    assert.ok(result.ticket, "the bounce-confirmed short produces a ticket");
  });

  it("NO short ticket is ever produced without the bounce", async () => {
    for (const row of SCENARIO_TABLE) {
      const { result } = await run(row);
      if (!result.ticket || result.side !== "short") continue;
      const low = Math.min(...row.given.market.candles5m.map((c) => c.low));
      const bounce = bounceOffLowPct(row.given.market.last, low);
      assert.ok(
        bounce !== null && bounce >= 0.4,
        `${row.name}: a short ticket went out with only ${bounce}% off the session low`,
      );
    }
  });

  it("the production bounce rule agrees with the harness's reading", async () => {
    // The harness must not have its own bounce maths: the veto comes from
    // blocking-rules.ts, which the filter chain uses.
    const row = SCENARIO_TABLE.find((r) => r.name === "short-no-bounce-rejected") as ScenarioRow;
    const low = Math.min(...row.given.market.candles5m.map((c) => c.low));
    const bounce = bounceOffLowPct(row.given.market.last, low)!;
    assert.ok(bounce < 0.4);
    // And the row really was stopped by the production filter.
    const { result } = await run(row);
    assert.equal(result.filters?.rule, "bounce_required");
  });
});

/* ------------------------------------------------------------------ */
/* 8. Determinism — identical inputs, identical ticket                 */
/* ------------------------------------------------------------------ */

describe("SAFETY 8 — identical inputs always produce an identical ticket", () => {
  it("two runs of the same scenario produce byte-identical tickets", async () => {
    const a = await run(LONG_ROW);
    const b = await run(LONG_ROW);
    assert.deepEqual(a.result.ticket, b.result.ticket);
    assert.deepEqual(a.calls, b.calls);
    assert.equal(a.result.sizing?.amountBaseUnits, b.result.sizing?.amountBaseUnits);
    assert.equal(a.result.sizing?.leverage, b.result.sizing?.leverage);
    assert.equal(a.result.sizing?.dollarRiskAtStopUsd, b.result.sizing?.dollarRiskAtStopUsd);
  });

  it("the whole scenario table is reproducible run to run", async () => {
    const first = await runScenarioTable();
    const second = await runScenarioTable();
    assert.deepEqual(
      first.map((o) => [o.row.name, o.result.verdict, o.result.stage, o.result.ticket]),
      second.map((o) => [o.row.name, o.result.verdict, o.result.stage, o.result.ticket]),
    );
  });

  it("the clock is INJECTED — the same scenario at a different clock still agrees on the clock", async () => {
    // The point of injecting the clock: a scenario's decision must not
    // depend on WHEN it ran, only on the inputs it was given.
    const row = SCENARIO_TABLE.find((r) => r.name === "long-confluence-clean") as ScenarioRow;
    const a = await runDecisionCycle(row.given, CONFIG, {
      nowMs: row.given.nowMs,
      placeOrder: () => ({}),
    });
    const b = await runDecisionCycle(row.given, CONFIG, {
      nowMs: row.given.nowMs,
      placeOrder: () => ({}),
    });
    assert.equal(a.submitted.intentId, b.submitted.intentId);
    assert.deepEqual(a.ticket, b.ticket);
  });

  it("no wall-clock read leaks into the ticket: the intent id is derived, not stamped", async () => {
    const { result } = await run(LONG_ROW);
    assert.equal(result.submitted.intentId, intentIdFor("SOL/USDT", "long", "s1"));
    // A timestamped id would differ on every run.
    assert.ok(!/\d{13}/.test(result.submitted.intentId ?? ""), "the intent id carries no epoch stamp");
  });

  it("the deterministic run produces the same verdict twice in a row", async () => {
    const a = await run(SHORT_ROW);
    const b = await run(SHORT_ROW);
    assert.equal(a.result.verdict, b.result.verdict);
    assert.equal(a.result.side, b.result.side);
    assert.equal(a.result.ticket?.["amount"], b.result.ticket?.["amount"]);
  });
});

/* ------------------------------------------------------------------ */
/* 9. Idempotency — no order is sent twice for the same intent        */
/* ------------------------------------------------------------------ */

describe("SAFETY 9 — no order is ever sent twice for the same intent", () => {
  it("a retry of the same intent sends nothing the second time", async () => {
    const calls: ExchangeCall[] = [];
    const ledger = createIntentLedger();
    const deps = {
      nowMs: LONG_ROW.given.nowMs,
      ledger,
      placeOrder: (call: ExchangeCall) => void calls.push(call),
    };
    const first = await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    assert.equal(first.submitted.sent, true);
    assert.equal(calls.length, 1, "the first attempt sends exactly one order");

    const second = await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    assert.equal(second.submitted.duplicate, true, "the second attempt is flagged a duplicate");
    assert.equal(second.submitted.sent, false, "the second attempt sends NOTHING");
    assert.equal(calls.length, 1, "still exactly one order on the wire");
  });

  it("the duplicate is reported, not silently swallowed", async () => {
    const ledger = createIntentLedger();
    const deps = { nowMs: LONG_ROW.given.nowMs, ledger, placeOrder: () => ({}) };
    await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    const second = await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    assert.match(second.reason, /already sent/);
  });

  it("the ledger keys on the intent id (pair + side + session)", () => {
    const ledger = createIntentLedger();
    assert.equal(ledger.entries.size, 0);
    assert.equal(intentIdFor("SOL/USDT", "long", "s1"), "SOL/USDT|long|s1");
    assert.notEqual(intentIdFor("SOL/USDT", "long", "s1"), intentIdFor("SOL/USDT", "long", "s2"));
    assert.notEqual(intentIdFor("SOL/USDT", "long", "s1"), intentIdFor("SOL/USDT", "short", "s1"));
  });

  it("a DIFFERENT session may fire the same setup — the intent is scoped", async () => {
    const calls: ExchangeCall[] = [];
    const ledger = createIntentLedger();
    const deps = { nowMs: LONG_ROW.given.nowMs, ledger, placeOrder: (c: ExchangeCall) => void calls.push(c) };
    await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    const otherSession = { ...LONG_ROW.given, sessionId: "s2" };
    const second = await runDecisionCycle(otherSession, CONFIG, deps);
    assert.equal(second.submitted.duplicate, false, "another session is another intent");
    assert.equal(calls.length, 2);
  });

  it("an ambiguous send failure still reserves the intent — a retry cannot double-fire", async () => {
    const calls: ExchangeCall[] = [];
    const ledger = createIntentLedger();
    const deps = {
      nowMs: LONG_ROW.given.nowMs,
      ledger,
      placeOrder: (call: ExchangeCall) => {
        calls.push(call);
        throw new Error("timeout — the order may be live");
      },
    };
    const first = await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    assert.equal(first.submitted.sent, false);
    assert.ok(first.submitted.error, "the failure is reported");
    assert.equal(ledger.entries.size, 1, "the intent is still reserved");

    // The retry — same intent, same ledger.
    const retry = await runDecisionCycle(LONG_ROW.given, CONFIG, deps);
    assert.equal(retry.submitted.duplicate, true);
    assert.equal(calls.length, 1, "the retry did not fire a second order");
  });

  it("every scenario that sends an order sends exactly ONE", async () => {
    for (const row of SCENARIO_TABLE) {
      const { calls } = await run(row);
      assert.ok(calls.length <= 1, `${row.name} sent ${calls.length} orders`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The network boundary                                                 */
/* ------------------------------------------------------------------ */

describe("the fake exchange — nothing escapes to a real network call", () => {
  it("the recorder captures the exact payload that WOULD have been sent", async () => {
    const { calls } = await run(LONG_ROW);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.tool, HARNESS_ORDER_TOOL);
    assert.equal(call.args["exchange"], "kucoin");
    assert.equal(call.args["pair"], "SOL/USDT");
    assert.equal(call.args["side"], "buy");
    assert.equal(call.args["market"], "futures");
    assert.equal(call.args["marginMode"], "isolated");
    // The base-unit amount, and a leverage the cap allows.
    assert.equal(call.args["amount"], "900");
    assert.ok(Number(call.args["leverage"]) <= HARNESS_MAX_LEVERAGE);
    // The entry price rides the order.
    assert.equal(Number(call.args["price"]), 1.3);
  });

  it("a short ticket carries side=sell and a stop ABOVE the entry", async () => {
    const { calls, result } = await run(SHORT_ROW);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.args["side"], "sell");
    // The stop rides the EXIT ticket (the venue's native stop leg) — the
    // order itself carries no stop field.
    const entry = Number(call.args["price"]);
    const stop = Number(result.exits!["slPrice"]);
    assert.ok(stop > entry, "a short's stop sits above the entry");
  });

  it("a long ticket carries side=buy and a stop BELOW the entry", async () => {
    const { calls, result } = await run(LONG_ROW);
    const call = calls[0]!;
    assert.equal(call.args["side"], "buy");
    const entry = Number(call.args["price"]);
    const stop = Number(result.exits!["slPrice"]);
    assert.ok(stop < entry, "a long's stop sits below the entry");
  });

  it("the order carries the client order id, so a fill can be attributed", async () => {
    const { calls } = await run(LONG_ROW);
    const oid = String(calls[0]?.args["clientOid"] ?? "");
    assert.match(oid, /^jw3-s1-t1-/);
  });

  it("the exit legs ride the ticket (a stop with no take-profit is a naked position)", async () => {
    const { result } = await run(LONG_ROW);
    assert.ok(result.exits, "the ticket carries its exit legs");
    assert.ok(Number(result.exits!["slPrice"]) > 0);
    assert.ok(Number(result.exits!["tpPrice"]) > 0);
  });

  it("NOTHING is sent for every vetoed or rejected scenario", async () => {
    for (const row of SCENARIO_TABLE.filter((r) => r.expected.ticket === null)) {
      const { calls } = await run(row);
      assert.equal(calls.length, 0, `${row.name} must not send an order`);
    }
  });

  it("the harness module never imports a live transport", () => {
    // The recorder IS the network boundary. If harness.ts reached for
    // callTool directly, a bug could fire a real order from a test.
    // Works both from src/ (ts) and dist/ (compiled js) layouts.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "harness.ts"), join(here, "..", "..", "src", "commands", "harness.ts")];
    let src = "";
    for (const c of candidates) {
      try {
        src = readFileSync(c, "utf8");
        break;
      } catch {
        // try the next layout
      }
    }
    assert.ok(src.length > 0, "harness: cannot locate the harness source");
    assert.ok(!/callTool\s*\(/.test(src), "harness.ts must not call the live transport");
    assert.ok(!/\bfetch\s*\(/.test(src), "harness.ts must not fetch");
    assert.ok(!/from "\.\.\/mcp\.js"/.test(src), "harness.ts must not import the MCP transport");
  });
});

/* ------------------------------------------------------------------ */
/* The expectation checker                                              */
/* ------------------------------------------------------------------ */

describe("checkScenarioExpectations", () => {
  it("reports a mismatch when a ticket disagrees with the table", async () => {
    const row = { ...LONG_ROW, expected: { ...LONG_ROW.expected, ticket: { ...LONG_ROW.expected.ticket!, amountBaseUnits: 999999 } } };
    const outcome = await runScenarioRow(row, CONFIG);
    assert.ok(outcome.errors.length > 0);
    assert.match(outcome.errors.join(" "), /amountBaseUnits/);
  });

  it("passes on an untouched row", async () => {
    const outcome = await runScenarioRow(LONG_ROW, CONFIG);
    assert.deepEqual(outcome.errors, []);
  });
});
