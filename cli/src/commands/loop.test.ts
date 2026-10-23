import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOOP_BUDGET_MS,
  budgetLine,
  runLoopSense,
  summarizeLeg,
  validateLoopArgs,
  withinBudget,
} from "./loop.js";

describe("validateLoopArgs", () => {
  it("accepts exchange + pair", () => {
    assert.equal(validateLoopArgs({ exchange: "kucoin", pair: "SOL/USDT" }), null);
  });
  it("rejects missing parts", () => {
    assert.ok(validateLoopArgs({ exchange: "", pair: "SOL/USDT" }));
    assert.ok(validateLoopArgs({ exchange: "kucoin", pair: "" }));
    assert.ok(validateLoopArgs({ exchange: "kucoin", pair: "SOLUSDT" }));
  });
});

describe("budget", () => {
  it("5s budget constant", () => {
    assert.equal(LOOP_BUDGET_MS, 5000);
  });
  it("withinBudget boundary", () => {
    assert.equal(withinBudget(4999), true);
    assert.equal(withinBudget(5000), true);
    assert.equal(withinBudget(5001), false);
  });
  it("budgetLine marks WITHIN vs OVER", () => {
    assert.match(budgetLine(1200), /WITHIN/);
    assert.match(budgetLine(6000), /OVER/);
  });
});

describe("runLoopSense", () => {
  it("fans all five legs out concurrently", async () => {
    // THE CONCURRENCY MUST BE PROVEN STRUCTURALLY, NOT BY A CLOCK.
    //
    // The first version of this test asserted `elapsed < 350` on five
    // 80ms legs. That measures the MACHINE's LOAD, not the code: under
    // concurrent load (the collectors, the trade-loop and the research
    // scripts all running) the timers fire late and the assertion
    // failed — a `fail 1` in the suite with nothing wrong in the code
    // under test.
    //
    // So the property is proved by ORDER instead of by TIME: give the
    // legs DELAYS THAT INVERT the invocation order, and assert the
    // COMPLETION order is the inverse. If the legs ran sequentially the
    // completion order would be the invocation order; if they run
    // concurrently the slowest leg finishes LAST. That is a property of
    // the implementation, and no wall clock is involved.
    const order: string[] = [];
    const delayed = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
      return name;
    };
    const sense = await runLoopSense({
      // the invocation order is market, positions, screener, analyze,
      // plan — and the delays are the REVERSE, so plan is the fastest
      // and market the slowest.
      market: delayed("market", 120),
      positions: delayed("positions", 100),
      screener: delayed("screener", 80),
      analyze: delayed("analyze", 60),
      plan: delayed("plan", 20),
    });
    assert.equal(sense.legs.length, 5);
    assert.ok(sense.legs.every((l) => l.ok));
    // The completion order is the reverse of the invocation order —
    // which is only possible if the legs ran at the same time.
    assert.deepEqual(
      order,
      ["plan", "analyze", "screener", "positions", "market"],
      `the legs did not run concurrently — the completion order was ${order.join(",")}`,
    );
    // The legs are reported in the CANONICAL order, not the completion
    // order, so a consumer can index them by position.
    assert.deepEqual(
      sense.legs.map((l) => l.name),
      ["market", "positions", "screener", "analyze", "plan"],
      "the legs must be reported in the canonical order",
    );
    assert.equal(sense.withinBudget, true);
  });
  it("isolates a failing leg without failing siblings", async () => {
    const sense = await runLoopSense({
      market: async () => ({ price: 1 }),
      positions: async () => {
        throw new Error("boom");
      },
      screener: async () => ({}),
      analyze: async () => ({}),
      plan: async () => ({}),
    });
    const pos = sense.legs.find((l) => l.name === "positions");
    assert.equal(pos?.ok, false);
    assert.match(pos?.error ?? "", /boom/);
    assert.ok(sense.legs.filter((l) => l.name !== "positions").every((l) => l.ok));
  });
});

describe("summarizeLeg", () => {
  it("summarizes ok legs, reports failures", () => {
    assert.match(summarizeLeg({ name: "market", ok: true, ms: 1, data: { price: 123 } }), /123/);
    assert.match(summarizeLeg({ name: "positions", ok: false, ms: 1, error: "nope" }), /FAIL/);
  });
});
