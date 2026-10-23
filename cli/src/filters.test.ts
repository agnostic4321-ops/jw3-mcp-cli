import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTER_CONFIG,
  FILTER_CATALOG,
  FILTER_CHAIN,
  FILTER_TIERS,
  SESSION_KEYS,
  dayChangeFilter,
  defaultFilterConfig,
  duplicateFilter,
  feeDragFilter,
  fundingFilter,
  liquidityFilter,
  quorumFilter,
  runFilters,
  sessionFilter,
  spreadFilter,
  type FilterCandidate,
  type FilterConfig,
  type FilterRuleId,
} from "./filters.js";
import { precheck, type PrefilterCtx } from "./blocking-rules.js";

const utc = (h: number, m: number): number => Date.UTC(2026, 9, 15, h, m, 0);

/** 09:00Z — inside the Europe session, outside the CPI blackout. */
const T = utc(9, 0);

/** A candidate that clears every gate. Individual tests break one leg. */
function good(over: Partial<FilterCandidate> = {}): FilterCandidate {
  return {
    symbol: "SOL/USDT",
    side: "long",
    nowMs: T,
    signalId: "sig-1",
    tier: "t2",
    turnoverUsd24h: 5_000_000,
    bestBid: 99.99,
    bestAsk: 100.01,
    top5DepthUsd: 5_000,
    notionalUsd: 1_000,
    feePctPerSide: 0.06,
    stopDistancePct: 0.5,
    fundingPct: 0.01,
    dayChgPct: 0.5,
    price: 100,
    sessionLow: 99.5,
    openPositions: [],
    recentSignals: [],
    modelSeats: [
      { model: "kronos", abstained: false, side: "long" },
      { model: "laya", abstained: false, side: "long" },
      { model: "rfdetr", abstained: true, side: "flat" },
    ],
    accountUsd: 1_000,
    ...over,
  };
}

function cfg(over: Partial<FilterConfig> = {}): FilterConfig {
  return { ...defaultFilterConfig(), ...over };
}

/* ------------------------------------------------- composed-rule consistency */

describe("composed rules match blocking-rules precheck()", () => {
  const cases: { name: string; ctx: PrefilterCtx; rule: FilterRuleId; reason: string }[] = [
    {
      name: "cpi blackout",
      ctx: { symbol: "SOL", side: "long", dayChgPct: 0.5, nowMs: utc(12, 0) },
      rule: "cpi_blackout",
      reason: "CPI blackout 11:30-13:30Z: post-CPI chop kills both directions",
    },
    {
      name: "extended drop",
      ctx: { symbol: "SOL", side: "short", dayChgPct: -2.5, price: 100, sessionLow: 100, nowMs: utc(9, 0) },
      rule: "extended_drop",
      reason: "day down -2.5% past -2%: no shorts into extended drops",
    },
    {
      name: "bounce required",
      ctx: { symbol: "SOL", side: "short", dayChgPct: -0.5, price: 100, sessionLow: 100, nowMs: utc(9, 0) },
      rule: "bounce_required",
      reason: "short needs +0.4% off session low (at 0.00%): never short into the flush",
    },
    {
      name: "btc fee",
      ctx: { symbol: "BTC/USDT", side: "long", dayChgPct: 0.5, accountUsd: 10, nowMs: utc(9, 0) },
      rule: "btc_fee",
      reason:
        "BTC fee-unprofitable at minimum size on small account: taker fees consume the edge (bench; re-enable on size/fee-tier change)",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: same rule id and same reason as precheck()`, () => {
      const pre = precheck(c.ctx);
      assert.equal(pre.rule, c.rule);
      const res = runFilters(
        good({
          symbol: c.ctx.symbol ?? "SOL/USDT",
          side: c.ctx.side ?? "long",
          nowMs: c.ctx.nowMs ?? T,
          dayChgPct: c.ctx.dayChgPct,
          price: c.ctx.price,
          sessionLow: c.ctx.sessionLow,
          accountUsd: c.ctx.accountUsd,
          sizeLots: c.ctx.sizeLots,
          notionalUsd: c.ctx.notionalUsd,
          feeTierOk: c.ctx.feeTierOk,
        }),
      );
      assert.equal(res.status, "reject");
      assert.equal(res.rule, c.rule);
      assert.equal(res.reason, c.reason);
      assert.equal(res.reason, pre.detail);
    });
  }

  it("a candidate precheck() passes also passes the composed block", () => {
    const ctx: PrefilterCtx = { symbol: "SOL", side: "short", dayChgPct: -0.5, price: 100.5, sessionLow: 100, accountUsd: 100, nowMs: utc(9, 0) };
    assert.equal(precheck(ctx).vetoed, false);
    const res = runFilters(
      good({ side: "short", dayChgPct: -0.5, price: 100.5, sessionLow: 100, accountUsd: 100, nowMs: utc(9, 0) }),
    );
    assert.equal(res.status, "pass");
  });

  it("a short with no day-change leg is unevaluated, not vetoed (precheck semantics)", () => {
    const res = runFilters(
      good({ side: "short", dayChgPct: undefined, price: undefined, sessionLow: undefined }),
    );
    // The composed block leaves the two short-only rules unevaluated.
    assert.ok(res.unevaluated.includes("extended_drop"));
    assert.ok(res.unevaluated.includes("bounce_required"));
    assert.ok(!res.evaluated.includes("extended_drop"));
  });
});

/* ------------------------------------------------------------- the chain */

describe("chain order and short-circuit", () => {
  it("runs the composed block first, then the new gates cheapest-first", () => {
    assert.deepEqual(FILTER_CHAIN.slice(0, 4), ["cpi_blackout", "extended_drop", "bounce_required", "btc_fee"]);
    assert.equal(FILTER_CHAIN.length, 12);
    assert.equal(new Set(FILTER_CHAIN).size, FILTER_CHAIN.length);
  });

  it("short-circuits on the first reject and names the rule", () => {
    // CPI blackout AND a broken spread AND no quorum — the first rule wins.
    const res = runFilters(good({ nowMs: utc(12, 0), bestBid: 99.94, bestAsk: 100.06, modelSeats: [] }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "cpi_blackout");
    assert.deepEqual(res.evaluated, ["cpi_blackout"]);
  });

  it("a clean candidate passes the whole stack", () => {
    const res = runFilters(good());
    assert.equal(res.status, "pass");
    assert.equal(res.rule, null);
    assert.equal(res.reason, "all pre-trade filters pass");
  });

  it("a later rule is reached only when the earlier ones pass", () => {
    const res = runFilters(good({ bestBid: 99.94, bestAsk: 100.06 }));
    assert.equal(res.rule, "spread");
    assert.ok(res.evaluated.indexOf("spread") > res.evaluated.indexOf("session"));
  });
});

/* --------------------------------------------------------------- session */

describe("session filter", () => {
  it("rejects outside every session window", () => {
    const res = sessionFilter(good({ nowMs: utc(22, 0) }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "session");
    assert.match(res.reason, /no trading session open at 22:00Z/);
  });

  it("rejects a disabled session", () => {
    const c = cfg();
    c.sessions.europe.enabled = false;
    const res = sessionFilter(good({ nowMs: utc(9, 0) }), c);
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "session");
    assert.match(res.reason, /Europe session disabled/);
  });

  it("enforces the per-session liquidity floor", () => {
    const res = sessionFilter(good({ nowMs: utc(9, 0), turnoverUsd24h: 400_000 }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /24h turnover \$400,000 below the Europe session floor \$1,000,000/);
  });

  it("opens the asia, europe and us windows", () => {
    const asia = sessionFilter(good({ nowMs: utc(3, 0), turnoverUsd24h: 600_000 }));
    assert.equal(asia.status, "pass");
    assert.match(asia.reason, /Asia session/);
    const europe = sessionFilter(good({ nowMs: utc(9, 0) }));
    assert.equal(europe.status, "pass");
    assert.match(europe.reason, /Europe session/);
    const us = sessionFilter(good({ nowMs: utc(15, 0) }));
    assert.equal(us.status, "pass");
    assert.match(us.reason, /US session/);
  });

  it("the 13:00-14:00Z handover gap is closed", () => {
    assert.equal(sessionFilter(good({ nowMs: utc(13, 30) })).status, "reject");
    assert.equal(sessionFilter(good({ nowMs: utc(14, 0) })).status, "pass");
  });

  it("every session carries a window and a liquidity floor", () => {
    for (const k of SESSION_KEYS) {
      const s = DEFAULT_FILTER_CONFIG.sessions[k];
      assert.ok(s.endMin > s.startMin, `${k} window`);
      assert.ok(s.minTurnoverUsd > 0, `${k} floor`);
    }
  });
});

/* --------------------------------------------------------------- spread */

describe("spread filter", () => {
  it("rejects a spread over the tier cap", () => {
    const res = spreadFilter(good({ bestBid: 99.94, bestAsk: 100.06 }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "spread");
    assert.match(res.reason, /spread 12\.0bps \(0\.120%\) over the t2 cap 10\.0bps/);
  });

  it("scales the cap per tier", () => {
    const wide = good({ tier: "t3", bestBid: 99.94, bestAsk: 100.06 });
    assert.equal(spreadFilter(wide).status, "pass");
    const tight = good({ tier: "t1", bestBid: 99.94, bestAsk: 100.06 });
    assert.equal(spreadFilter(tight).status, "reject");
    assert.deepEqual(FILTER_TIERS, ["t1", "t2", "t3"]);
  });

  it("passes a tight spread", () => {
    const res = spreadFilter(good({ bestBid: 99.96, bestAsk: 100.04 }));
    assert.equal(res.status, "pass");
    assert.match(res.reason, /spread 8\.0bps within the t2 cap 10\.0bps/);
  });

  it("rejects a crossed book", () => {
    const res = spreadFilter(good({ bestBid: 100.02, bestAsk: 100 }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /crossed book/);
  });
});

/* ------------------------------------------------------------- fee drag */

describe("fee drag filter", () => {
  it("rejects when round-trip fees eat the stop", () => {
    const res = feeDragFilter(good({ stopDistancePct: 0.4 }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "fee_drag");
    assert.match(res.reason, /round-trip fees \$1\.20 \(0\.120% of notional\) are 30% of the \$4\.00 stop/);
  });

  it("passes when fees stay a small fraction of the stop", () => {
    const res = feeDragFilter(good());
    assert.equal(res.status, "pass");
    assert.match(res.reason, /round-trip fees 24% of the stop \(cap 25%\)/);
  });

  it("the 18bps-spread-on-a-0.5%-TP case is a fee drag, not a spread case", () => {
    // 0.18% of notional lost to the spread against a 0.5% target: fees+spread
    // cannot fit, so a 0.25% stop (0.06% round trip) is 48% of the edge.
    const res = feeDragFilter(good({ stopDistancePct: 0.25 }));
    assert.equal(res.status, "reject");
  });
});

/* ------------------------------------------------------------- funding */

describe("funding filter", () => {
  it("rejects a long paying extreme funding", () => {
    const res = fundingFilter(good({ side: "long", fundingPct: 0.06 }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "funding");
    assert.match(res.reason, /funding \+0\.060%\/8h against a LONG/);
  });

  it("rejects a short paying extreme funding", () => {
    const res = fundingFilter(good({ side: "short", fundingPct: -0.06, dayChgPct: -0.5, price: 100.5, sessionLow: 100 }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /funding -0\.060%\/8h against a SHORT/);
  });

  it("funding in favour of the position passes", () => {
    assert.equal(fundingFilter(good({ side: "long", fundingPct: -0.06 })).status, "pass");
    assert.equal(fundingFilter(good({ side: "short", fundingPct: 0.06, dayChgPct: -0.5, price: 100.5, sessionLow: 100 })).status, "pass");
  });

  it("scales the carry with the hold length", () => {
    const c = cfg({ fundingHoldHours: 4 });
    const res = fundingFilter(good({ side: "long", fundingPct: 0.06 }), c);
    assert.equal(res.status, "pass");
  });
});

/* ----------------------------------------------------------- day change */

describe("day change filter", () => {
  it("rejects a long into an extended day (late-entry chase)", () => {
    const res = dayChangeFilter(good({ side: "long", dayChgPct: 2.5 }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "day_change");
    assert.match(res.reason, /LONG into a \+2\.50% day \(cap \+2\.00%\) — late-entry chase/);
  });

  it("rejects a short into an extended drop", () => {
    const res = dayChangeFilter(good({ side: "short", dayChgPct: -2.5, price: 100.5, sessionLow: 100 }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /SHORT into a -2\.50% day \(cap -2\.00%\) — extended drop/);
  });

  it("passes a long into a flat day", () => {
    assert.equal(dayChangeFilter(good({ side: "long", dayChgPct: 1.5 })).status, "pass");
  });

  it("thresholds are configurable", () => {
    const c = cfg({ longChasePct: 0.5 });
    assert.equal(dayChangeFilter(good({ side: "long", dayChgPct: 1.0 }), c).status, "reject");
  });

  it("a short extended drop is caught by the composed rule first in the chain", () => {
    const res = runFilters(good({ side: "short", dayChgPct: -2.5, price: 100.5, sessionLow: 100 }));
    assert.equal(res.rule, "extended_drop");
  });

  it("a tighter configured short cap catches the drop before the composed rule", () => {
    const c = cfg({ shortDropPct: 1.0 });
    const res = runFilters(good({ side: "short", dayChgPct: -1.5, price: 100.5, sessionLow: 100 }), c);
    assert.equal(res.rule, "day_change");
  });
});

/* ------------------------------------------------------------ liquidity */

describe("liquidity filter", () => {
  it("rejects turnover below the floor", () => {
    const res = liquidityFilter(good({ turnoverUsd24h: 100_000 }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "liquidity");
    assert.match(res.reason, /24h turnover \$100,000 below the \$500,000 floor/);
  });

  it("rejects a book too thin for the order notional", () => {
    const res = liquidityFilter(good({ top5DepthUsd: 500, notionalUsd: 1_000 }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /top-5 book depth \$500 thinner than the \$1,000 order notional/);
  });

  it("passes a deep book and a liquid contract", () => {
    const res = liquidityFilter(good());
    assert.equal(res.status, "pass");
    assert.match(res.reason, /turnover \$5,000,000 over the \$500,000 floor/);
  });

  it("honours a configurable depth multiple", () => {
    const c = cfg({ minDepthMultiple: 10 });
    assert.equal(liquidityFilter(good(), c).status, "reject");
  });
});

/* ------------------------------------------------------------ duplicate */

describe("duplicate / exposure filter", () => {
  it("rejects a pair that is already open", () => {
    const res = duplicateFilter(good({ openPositions: [{ symbol: "SOL/USDT" }] }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "duplicate");
    assert.match(res.reason, /SOL\/USDT already open — no double-fire on the same pair/);
  });

  it("matches the pair across quote conventions", () => {
    const res = duplicateFilter(good({ symbol: "SOLUSDTM", openPositions: [{ symbol: "SOL/USDT" }] }));
    assert.equal(res.status, "reject");
  });

  it("allows a different pair", () => {
    assert.equal(duplicateFilter(good({ openPositions: [{ symbol: "ETH/USDT" }] })).status, "pass");
  });

  it("rejects the same signal re-firing inside the cooldown", () => {
    const res = duplicateFilter(good({ recentSignals: [{ symbol: "SOL/USDT", signalId: "sig-1", firedAtMs: T - 30 * 60_000 }] }));
    assert.equal(res.status, "reject");
    assert.match(res.reason, /signal sig-1 already fired on SOL\/USDT 30m ago — 60m cooldown, 30m left/);
  });

  it("allows the same signal after the cooldown", () => {
    const res = duplicateFilter(good({ recentSignals: [{ symbol: "SOL/USDT", signalId: "sig-1", firedAtMs: T - 61 * 60_000 }] }));
    assert.equal(res.status, "pass");
  });

  it("allows a different signal on the same pair", () => {
    const res = duplicateFilter(good({ recentSignals: [{ symbol: "SOL/USDT", signalId: "sig-2", firedAtMs: T - 60_000 }] }));
    assert.equal(res.status, "pass");
  });

  it("allows the same signal on a different pair", () => {
    const res = duplicateFilter(good({ recentSignals: [{ symbol: "ETH/USDT", signalId: "sig-1", firedAtMs: T - 60_000 }] }));
    assert.equal(res.status, "pass");
  });
});

/* ------------------------------------------------------------- quorum */

describe("model quorum filter", () => {
  it("rejects when fewer than K seats are non-abstained", () => {
    const res = quorumFilter(good({ modelSeats: [{ model: "kronos", abstained: false, side: "long" }] }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "model_quorum");
    assert.match(res.reason, /only 1 of 3 model seats non-abstained \(need 2\)/);
  });

  it("passes with K seats non-abstained", () => {
    const res = quorumFilter(good());
    assert.equal(res.status, "pass");
    assert.match(res.reason, /2 of 3 model seats non-abstained \(need 2\)/);
  });

  it("ignores seats that are not configured", () => {
    const res = quorumFilter(
      good({
        modelSeats: [
          { model: "kronos", abstained: false, side: "long" },
          { model: "laya", abstained: false, side: "long" },
          { model: "gpt", abstained: false, side: "long" },
        ],
      }),
    );
    assert.equal(res.status, "pass");
  });

  it("the quorum is configurable", () => {
    const c = cfg({ quorum: { seats: ["kronos", "laya", "rfdetr"], minNonAbstained: 3 } });
    const res = quorumFilter(good(), c);
    assert.equal(res.status, "reject");
  });

  it("a single weak model cannot carry the trade", () => {
    const res = runFilters(
      good({
        modelSeats: [
          { model: "kronos", abstained: false, side: "long" },
          { model: "laya", abstained: true, side: "flat" },
          { model: "rfdetr", abstained: true, side: "flat" },
        ],
      }),
    );
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "model_quorum");
  });
});

/* -------------------------------------------------------- missing data */

describe("missing data policy", () => {
  it("fails closed by default", () => {
    const res = runFilters(good({ bestBid: undefined, bestAsk: undefined }));
    assert.equal(res.status, "reject");
    assert.equal(res.rule, "spread");
    assert.match(res.reason, /best bid\/ask unavailable — cannot verify this gate/);
  });

  it("fails open when configured to skip", () => {
    const c = cfg({ onMissing: "skip" });
    const res = runFilters(good({ bestBid: undefined, bestAsk: undefined }), c);
    assert.equal(res.status, "pass");
    assert.ok(res.unevaluated.includes("spread"));
  });
});

/* -------------------------------------------------------------- purity */

describe("purity", () => {
  it("the same candidate gives the same verdict twice", () => {
    const c = good();
    assert.deepEqual(runFilters(c), runFilters(c));
  });

  it("defaultFilterConfig() hands out a fresh copy each call", () => {
    const a = defaultFilterConfig();
    const b = defaultFilterConfig();
    a.sessions.us.enabled = false;
    a.spreadBps.t1 = 999;
    assert.equal(b.sessions.us.enabled, true);
    assert.equal(b.spreadBps.t1, 5);
  });

  it("the shared default config is never mutated by a run", () => {
    const before = JSON.stringify(DEFAULT_FILTER_CONFIG);
    runFilters(good());
    assert.equal(JSON.stringify(DEFAULT_FILTER_CONFIG), before);
  });
});

/* ----------------------------------------------------------- catalogue */

describe("filter catalogue", () => {
  it("documents every rule in the chain", () => {
    assert.deepEqual(
      FILTER_CATALOG.map((c) => c.id),
      [...FILTER_CHAIN],
    );
  });

  it("every entry carries a default, a reason and a flag", () => {
    for (const c of FILTER_CATALOG) {
      assert.ok(c.defaults.length > 0, `${c.id} defaults`);
      assert.ok(c.reason.length > 0, `${c.id} reason`);
      assert.ok(c.what.length > 0, `${c.id} what`);
      assert.equal(typeof c.composed, "boolean");
    }
  });

  it("marks the four composed rules", () => {
    const composed = FILTER_CATALOG.filter((c) => c.composed).map((c) => c.id);
    assert.deepEqual(composed, ["cpi_blackout", "extended_drop", "bounce_required", "btc_fee"]);
  });
});
