/**
 * The live command's gates.
 *
 * The gates are the whole point of the live path: a machine that trades
 * on a single-model read, or into a flush, or past a cap, will bleed the
 * account. These are pure functions so every refusal is testable.
 */
import { planScalp } from "../kucoin.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { bounceGate, confluenceGate, cmdLive } from "./live-cmd.js";
import { fadeSignal, dipSignal, type FadeRow } from "../kucoin.js";

describe("the tape signal decides whether there is a setup at all", () => {
  const row = (over: Partial<FadeRow> = {}): FadeRow => ({
    symbol: "SOLUSDTM",
    chg: 0,
    vratio: 0.5,
    vslope: "down",
    offHighPct: 2,
    offLowPct: 2,
    atrPct: 1,
    fundingPct: 0,
    last: 100,
    n: 24,
    ...over,
  });

  it("a faded bar near the high is a fade-short", () => {
    // Near the high means offHighPct small AND offLowPct large.
    const r = row({ vratio: 0.5, offHighPct: 2, offLowPct: 12 });
    assert.equal(fadeSignal(r), "fade-short");
    assert.equal(dipSignal(r), "neutral");
  });

  it("a faded bar near the low is a dip-long", () => {
    const r = row({ vratio: 0.5, offLowPct: 2, offHighPct: 12 });
    assert.equal(dipSignal(r), "dip-long");
    assert.equal(fadeSignal(r), "neutral");
  });

  it("a bar with no fade is neutral on both sides", () => {
    // The live path must NOT fire on a pair whose signal is neutral. The
    // old code inferred the side from off-high/off-low geometry, which
    // would have produced a "short" for a pair that has no setup at all.
    const r = row({ vratio: 1.2, offHighPct: 2, offLowPct: 2 });
    assert.equal(fadeSignal(r), "neutral");
    assert.equal(dipSignal(r), "neutral");
  });

  it("an extended move is 'late'/'extended', not a fade", () => {
    assert.equal(fadeSignal(row({ offHighPct: 20 })), "late");
    assert.equal(dipSignal(row({ offLowPct: 20 })), "extended");
  });

  it("an expanding bar is 'strong'/'capitulation', not a fade", () => {
    assert.equal(fadeSignal(row({ vratio: 4 })), "strong");
    assert.equal(dipSignal(row({ vratio: 4 })), "capitulation");
  });
});

describe("confluenceGate — BOTH legs must agree", () => {
  it("passes when JEV and Laya agree", () => {
    const g = confluenceGate({
      jev: { side: "short", confidence: 0.73 },
      laya: { side: "short", confidence: 0.79 },
    });
    assert.equal(g.ok, true);
    assert.equal(g.side, "short");
  });

  it("refuses when the models disagree", () => {
    const g = confluenceGate({
      jev: { side: "short", confidence: 0.8 },
      laya: { side: "long", confidence: 0.7 },
    });
    assert.equal(g.ok, false);
    assert.equal(g.side, null);
    assert.match(g.reason, /disagree/);
  });

  it("refuses on a SINGLE model read — a watch, not a trigger", () => {
    const noLaya = confluenceGate({ jev: { side: "long", confidence: 0.9 }, laya: null });
    assert.equal(noLaya.ok, false);
    assert.match(noLaya.reason, /Laya/);
    const noJev = confluenceGate({ jev: null, laya: { side: "long", confidence: 0.9 } });
    assert.equal(noJev.ok, false);
    assert.match(noJev.reason, /JEV/);
  });

  it("refuses when NEITHER model answered", () => {
    const g = confluenceGate({ jev: null, laya: null });
    assert.equal(g.ok, false);
    assert.equal(g.side, null);
  });
});

describe("bounceGate — never sell into the flush", () => {
  it("a long needs no bounce", () => {
    const g = bounceGate({ side: "long", bounceOffLowPct: 0.01, requiredPct: 0.4 });
    assert.equal(g.ok, true);
  });

  it("a short is refused below the required bounce", () => {
    const g = bounceGate({ side: "short", bounceOffLowPct: 0.19, requiredPct: 0.4 });
    assert.equal(g.ok, false);
    assert.match(g.reason, /still in the flush/);
  });

  it("a short is allowed at or above the required bounce", () => {
    const g = bounceGate({ side: "short", bounceOffLowPct: 0.45, requiredPct: 0.4 });
    assert.equal(g.ok, true);
    assert.match(g.reason, /clears/);
  });

  it("a short with no session low is refused, not assumed", () => {
    const g = bounceGate({ side: "short", bounceOffLowPct: null, requiredPct: 0.4 });
    assert.equal(g.ok, false);
    assert.match(g.reason, /cannot confirm/);
  });
});

// ── The short geometry (the target must be beyond the MARKET) ───────────
//
// THE INVARIANT, AND WHY IT CHANGED
// ---------------------------------
// This block used to require the target to sit BELOW the ladder's
// average entry. That was correct while the target was derived from
// that average — and it was the bug.
//
// For a short the average entry sits ABOVE the last price
// (`last x (1 + d/200)`), so a target derived from it sat ABOVE the
// MARKET. A buy limit above the market is MARKETABLE: it fills
// instantly at the ask. So every short's "take-profit" was a scratch.
//
// Measured live on 2026-10-21: 6 of the 8 real round trips were
// scratches that closed in 4-7 seconds, net -$0.5708 on $0.5672 of
// fees. And every simulation booked them as full take-profits, which
// is where the 90-95% win rates came from.
//
// The target is now measured from the MARKET, so the market has to
// MOVE to reach it. The live path places a MARKET order, so the
// market IS the entry — one anchor for the entry and the target.

describe("the short plan's target is beyond the market", () => {
  it("a short's target sits BELOW the market and its stop ABOVE", () => {
    for (const atr of [0.5, 1.0, 1.6, 3.0]) {
      for (const last of [0.199, 0.0006164, 153.77]) {
        const plan = planScalp(last, atr, "short", 15, 2);
        assert.ok(plan, "the plan could not be derived");
        assert.ok(
          plan.tpPrice < last,
          `a short's target (${plan.tpPrice}) must sit BELOW the market (${last}) — above it, the order is marketable and fills at the ask`,
        );
        assert.ok(
          plan.killPrice > last,
          `a short's stop (${plan.killPrice}) must sit ABOVE the market (${last})`,
        );
        // The target is derived from the MARKET.
        const derivedFromMarket = last * (1 - plan.tpPct / 100);
        assert.ok(
          Math.abs(derivedFromMarket - plan.tpPrice) < 1e-9,
          "the target was not derived from the market",
        );
      }
    }
  });

  it("a long's target sits ABOVE the market and its stop BELOW", () => {
    for (const atr of [0.5, 1.0, 1.6, 3.0]) {
      for (const last of [0.199, 153.77]) {
        const plan = planScalp(last, atr, "long", 15, 2);
        assert.ok(plan);
        assert.ok(plan.tpPrice > last, `a long's target must sit ABOVE the market (${last})`);
        assert.ok(plan.killPrice < last, `a long's stop must sit BELOW the market (${last})`);
      }
    }
  });
});

describe("the CPI blackout veto is on the LIVE path, and it is first", () => {
  // The oracle refuses the CPI blackout (11:30-13:30Z, half-open)
  // because post-CPI chop kills both directions. The live path did NOT:
  // `blocking-rules.ts` was imported by the oracle alone, so the
  // machine's own entry path could fire inside the very window the
  // oracle calls untradeable. A veto that only the screener honours is
  // not a veto.
  //
  // The clock is INJECTED, so the test does not depend on the wall
  // clock, and the veto is FIRST so it costs NOTHING: no tape read, no
  // model call, no venue call.
  //
  // Hermetic: cmdLive resolves a PAT before the veto, so these rows used
  // to pass only on a machine with real credentials in ~/.config/jw3. A
  // dummy PAT scoped to this block makes them independent of the host —
  // and the veto still returns before any network call could use it.
  let savedPat: string | undefined;
  before(() => {
    savedPat = process.env.JW3_MCP_PAT;
    process.env.JW3_MCP_PAT = "test-pat-hermetic";
  });
  after(() => {
    if (savedPat === undefined) delete process.env.JW3_MCP_PAT;
    else process.env.JW3_MCP_PAT = savedPat;
  });
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 21, h, m, 0);

  const spy = () => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        jev: async () => {
          calls.push("jev");
          return { side: "short" as const, confidence: 0.8 };
        },
        laya: async () => {
          calls.push("laya");
          return { side: "short" as const, confidence: 0.8 };
        },
        bounceOffLowPct: async () => {
          calls.push("bounce");
          return 1.5;
        },
        now: () => calls.push("now") as unknown as number,
      },
    };
  };

  it("refuses inside the blackout, and calls NOTHING", async () => {
    // 12:00Z is inside 11:30-13:30Z.
    const s2 = spy();
    const out = await cmdLive(
      {
        pair: "SOL/USDT",
        exchange: "kucoin",
        side: "short",
        riskPct: 2,
        sizeUsd: 60,
        json: true,
        yes: true,
        session: "s",
        turn: "t",
      },
      { ...s2.deps, now: () => at(12, 0) },
    );
    assert.equal(out?.status, "no-trade");
    assert.match(String(out?.reason), /CPI blackout/);
    // the only call allowed is reading the clock
    assert.deepEqual(s2.calls, []);
  });

  it("refuses at the START of the blackout (11:30Z is inside it)", async () => {
    const s2 = spy();
    const out = await cmdLive(
      {
        pair: "SOL/USDT",
        exchange: "kucoin",
        side: "short",
        riskPct: 2,
        sizeUsd: 60,
        json: true,
        yes: true,
        session: "s",
        turn: "t",
      },
      { ...s2.deps, now: () => at(11, 30) },
    );
    assert.equal(out?.status, "no-trade");
    assert.match(String(out?.reason), /CPI blackout/);
  });

  it("does NOT refuse at the END (13:30Z is outside the half-open window)", async () => {
    // The oracle's window is half-open: 13:30Z is already out.
    const s2 = spy();
    const out = await cmdLive(
      {
        pair: "SOL/USDT",
        exchange: "kucoin",
        side: "short",
        riskPct: 2,
        sizeUsd: 60,
        json: true,
        yes: true,
        session: "s",
        turn: "t",
      },
      { ...s2.deps, now: () => at(13, 30) },
    );
    // it gets PAST the veto (and may refuse later for another reason)
    assert.doesNotMatch(String(out?.reason), /CPI blackout/);
  });

  it("does NOT refuse outside the window", async () => {
    const s2 = spy();
    const out = await cmdLive(
      {
        pair: "SOL/USDT",
        exchange: "kucoin",
        side: "short",
        riskPct: 2,
        sizeUsd: 60,
        json: true,
        yes: true,
        session: "s",
        turn: "t",
      },
      { ...s2.deps, now: () => at(9, 0) },
    );
    assert.doesNotMatch(String(out?.reason), /CPI blackout/);
  });
});
