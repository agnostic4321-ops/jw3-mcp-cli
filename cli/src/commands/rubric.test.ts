import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUBRIC_CONFIG,
  DEFAULT_TIER_TABLE,
  applyRubric,
  resolveRubricConfig,
  seatsFromSignedBallots,
  tierForConfidence,
  type CommitteeSeat,
  type RubricConfig,
  type RubricInput,
  type SetupMetrics,
} from "./rubric.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A clean, tradable venue + setup: tight spread, deep book, sane ATR. */
const goodSetup: SetupMetrics = {
  targetDistancePct: 1.2,
  stopDistancePct: 0.6,
  hitProbability: 0.6,
  atrPct: 1.5,
  spreadBps: 1,
  liquidityUsd: 120_000,
  distanceFromExtremePct: 6,
  marginUsd: 100,
  leverage: 10,
  feeRatePerSide: 0.0006,
};

const seat = (over: Partial<CommitteeSeat> & { seat: string }): CommitteeSeat => ({
  side: "long",
  confidence: 0.8,
  reason: "r",
  ...over,
});

/** Two agreeing seats — the minimum that clears the floor by default. */
const twoAgree: CommitteeSeat[] = [
  seat({ seat: "jev", side: "long", confidence: 0.9, reason: "7-TF trend up" }),
  seat({ seat: "kronos", side: "long", confidence: 0.7, reason: "up 1.4% next 4h" }),
];

const input = (over: Partial<RubricInput> = {}): RubricInput => ({
  seats: twoAgree,
  setup: goodSetup,
  ...over,
});

/* ------------------------------------------------------------------ */
/* Confidence floor                                                    */
/* ------------------------------------------------------------------ */

describe("confidence floor — a committee that never says no is useless", () => {
  it("rejects a weak consensus: FLAT with a reason, size 0", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.3 }),
          seat({ seat: "kronos", side: "long", confidence: 0.28 }),
        ],
      }),
    );
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.tier, "REJECT");
    assert.equal(d.sizeMultiplier, 0);
    assert.ok(d.consensusScore < DEFAULT_RUBRIC_CONFIG.floor.minConsensus);
    assert.match(d.reason, /FLAT/);
    assert.match(d.reason, /consensus .* below floor/);
    assert.ok(d.reasons.some((r) => r.startsWith("floor:")));
  });

  it("rejects a single-seat committee (not enough agreeing seats)", () => {
    const d = applyRubric(
      input({
        seats: [seat({ seat: "jev", side: "long", confidence: 0.95 })],
      }),
    );
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.sizeMultiplier, 0);
    assert.match(d.reason, /agreeing seat/);
  });

  it("rejects a split committee with no majority", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.8 }),
          seat({ seat: "kronos", side: "short", confidence: 0.8 }),
        ],
      }),
    );
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.side, "flat");
    assert.equal(d.sizeMultiplier, 0);
  });

  it("approves a strong consensus", () => {
    const d = applyRubric(input());
    assert.equal(d.verdict, "APPROVE");
    assert.equal(d.side, "long");
    assert.ok(d.sizeMultiplier > 0);
  });

  it("the floor is overridable (config wins over the default)", () => {
    const weak = input({
      seats: [
        seat({ seat: "jev", side: "long", confidence: 0.3 }),
        seat({ seat: "kronos", side: "long", confidence: 0.28 }),
      ],
    });
    assert.equal(applyRubric(weak).verdict, "FLAT");
    // The floor no longer blocks: the verdict is no longer FLAT...
    const relaxed = applyRubric(weak, { floor: { minConsensus: 0.1, minSeats: 1 } });
    assert.notEqual(relaxed.verdict, "FLAT");
    assert.match(relaxed.reasons.find((r) => r.startsWith("floor:")) ?? "", /consensus .* vs floor 0\.10/);
    // ...and with the tier ladder relaxed too, the weak trade is tradable.
    const tradable = applyRubric(weak, {
      floor: { minConsensus: 0.1, minSeats: 1 },
      tiers: { FULL: 0.3, HALF: 0.2, PROBE: 0.1 },
    });
    assert.equal(tradable.verdict, "APPROVE");
  });

  it("the floor can be switched off entirely", () => {
    const d = applyRubric(input({ seats: [seat({ seat: "jev", side: "long", confidence: 0.3 })] }), {
      floor: { enabled: false },
    });
    assert.notEqual(d.verdict, "FLAT");
  });
});

/* ------------------------------------------------------------------ */
/* Veto rule                                                           */
/* ------------------------------------------------------------------ */

describe("veto rule — a veto is never outvoted", () => {
  it("one vetoing seat blocks an otherwise unanimous committee", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.95, reason: "strong trend" }),
          seat({ seat: "kronos", side: "long", confidence: 0.9, reason: "up" }),
          seat({ seat: "laya", side: "long", confidence: 0.95, reason: "up" }),
          seat({
            seat: "risk",
            side: "long",
            confidence: 0.9,
            veto: true,
            vetoReason: "funding in the next 20 minutes",
            reason: "veto",
          }),
        ],
      }),
    );
    assert.equal(d.verdict, "REJECT");
    assert.equal(d.vetoed, true);
    assert.deepEqual(d.vetoSeats, ["risk"]);
    assert.equal(d.sizeMultiplier, 0);
    assert.match(d.reason, /VETO/);
    assert.match(d.reason, /funding/);
  });

  it("a veto beats a maximal consensus score", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "a", side: "long", confidence: 1, reason: "r" }),
      seat({ seat: "b", side: "long", confidence: 1, reason: "r" }),
      seat({ seat: "c", side: "long", confidence: 1, reason: "r" }),
      seat({ seat: "v", side: "long", confidence: 1, veto: true, vetoReason: "no", reason: "r" }),
    ];
    const d = applyRubric(input({ seats }));
    assert.equal(d.verdict, "REJECT");
    assert.equal(d.sizeMultiplier, 0);
  });

  it("a veto on a minority side still blocks the trade", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.9 }),
          seat({ seat: "kronos", side: "long", confidence: 0.9 }),
          seat({ seat: "rfdetr", side: "short", confidence: 0.9, veto: true, vetoReason: "chart pattern broken" }),
        ],
      }),
    );
    assert.equal(d.verdict, "REJECT");
    assert.equal(d.vetoed, true);
  });

  it("the veto rule can be disabled by config", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.9 }),
          seat({ seat: "kronos", side: "long", confidence: 0.9 }),
          seat({ seat: "risk", side: "long", confidence: 0.9, veto: true, vetoReason: "x" }),
        ],
      }),
      { veto: { enabled: false } },
    );
    assert.equal(d.vetoed, false);
    assert.equal(d.verdict, "APPROVE");
  });

  it("no veto means the vote stands", () => {
    const d = applyRubric(input());
    assert.equal(d.vetoed, false);
    assert.deepEqual(d.vetoSeats, []);
  });
});

/* ------------------------------------------------------------------ */
/* Quality multiplier                                                  */
/* ------------------------------------------------------------------ */

describe("quality multiplier — a strong signal on a bad venue is a bad trade", () => {
  it("penalises a wide spread, thin book and a bad fee drag", () => {
    const clean = applyRubric(input());
    const bad = applyRubric(
      input({
        setup: {
          ...goodSetup,
          spreadBps: 18,
          liquidityUsd: 900,
          stopDistancePct: 0.15,
          distanceFromExtremePct: 0.2,
        },
      }),
    );
    assert.ok(bad.qualityMultiplier < clean.qualityMultiplier);
    assert.ok(bad.confidence < clean.confidence);
    // A weak setup can be bad enough to sink the trade entirely.
    assert.equal(bad.verdict, "REJECT");
  });

  it("a strong signal on a bad venue is downgraded or rejected", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 1 }),
          seat({ seat: "kronos", side: "long", confidence: 1 }),
        ],
        setup: { ...goodSetup, spreadBps: 25, liquidityUsd: 500, stopDistancePct: 0.1, distanceFromExtremePct: 0 },
      }),
    );
    assert.notEqual(d.verdict, "APPROVE");
    assert.ok(d.qualityMultiplier < 0.5);
    assert.ok(d.reasons.some((r) => r.startsWith("quality:")));
  });

  it("unknown venue metrics fail closed (quality 0), not 'unknown but fine'", () => {
    const d = applyRubric(input({ setup: { targetDistancePct: 1.2, hitProbability: 0.6 } }));
    assert.equal(d.qualityMultiplier, 0);
    assert.equal(d.verdict, "REJECT");
    assert.match(d.reasons.find((r) => r.startsWith("quality:")) ?? "", /unknown/);
  });

  it("the quality rule can be switched off (multiplier 1)", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, spreadBps: 25, liquidityUsd: 500 } }), {
      quality: { enabled: false },
    });
    assert.equal(d.qualityMultiplier, 1);
  });

  it("the quality bands are overridable", () => {
    const wide = applyRubric(input({ setup: { ...goodSetup, spreadBps: 12 } }));
    const ok = applyRubric(input({ setup: { ...goodSetup, spreadBps: 12 } }), {
      quality: { spread: { idealBps: 15, maxBps: 30 } },
    });
    assert.ok(ok.qualityMultiplier > wide.qualityMultiplier);
  });
});

/* ------------------------------------------------------------------ */
/* Dissent rule                                                        */
/* ------------------------------------------------------------------ */

describe("dissent rule — a dissenting third model is information, not a veto", () => {
  it("a dissenter reduces confidence but never vetoes", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.9 }),
          seat({ seat: "kronos", side: "long", confidence: 0.8 }),
          seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
        ],
      }),
    );
    assert.notEqual(d.verdict, "REJECT");
    assert.deepEqual(d.dissentSeats, ["rfdetr"]);
    assert.deepEqual(d.agreeSeats, ["jev", "kronos"]);
    assert.ok(d.dissentPenalty > 0);
    assert.ok(d.consensusScore > d.confidence);
  });

  it("a dissenter that has historically been more right is treated more harshly", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.8 }),
      seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
    ];
    const neutral = applyRubric(input({ seats }));
    const withStats = applyRubric(
      input({
        seats,
        modelStats: {
          jev: { hitRate: 0.4, samples: 50 },
          kronos: { hitRate: 0.35, samples: 50 },
          rfdetr: { hitRate: 0.85, samples: 50 },
        },
      }),
    );
    assert.ok(
      withStats.dissentPenalty > neutral.dissentPenalty,
      `expected the better dissenter to bite harder: ${withStats.dissentPenalty} vs ${neutral.dissentPenalty}`,
    );
    assert.ok(withStats.confidence < neutral.confidence);
  });

  it("a dissenter that has historically been WORSE bites softer", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.8 }),
      seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
    ];
    const neutral = applyRubric(input({ seats }));
    const withStats = applyRubric(
      input({
        seats,
        modelStats: {
          jev: { hitRate: 0.8, samples: 50 },
          kronos: { hitRate: 0.75, samples: 50 },
          rfdetr: { hitRate: 0.2, samples: 50 },
        },
      }),
    );
    assert.ok(withStats.dissentPenalty < neutral.dissentPenalty);
    assert.ok(withStats.confidence > neutral.confidence);
  });

  it("a track record with too few samples does not earn credibility", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.8 }),
      seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
    ];
    const thin = applyRubric(
      input({
        seats,
        modelStats: {
          jev: { hitRate: 0.4, samples: 50 },
          kronos: { hitRate: 0.35, samples: 50 },
          rfdetr: { hitRate: 0.95, samples: 3 },
        },
      }),
    );
    const neutral = applyRubric(input({ seats }));
    assert.equal(thin.dissentPenalty, neutral.dissentPenalty);
  });

  it("the dissent penalty scale is overridable", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.8 }),
      seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
    ];
    const harsh = applyRubric(input({ seats }), { dissent: { penalty: 1 } });
    const mild = applyRubric(input({ seats }), { dissent: { penalty: 0 } });
    assert.ok(harsh.dissentPenalty >= mild.dissentPenalty);
    assert.equal(mild.dissentPenalty, 0);
  });

  it("the credibility boost is overridable", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.8 }),
      seat({ seat: "rfdetr", side: "short", confidence: 0.7 }),
    ];
    const stats = {
      jev: { hitRate: 0.4, samples: 50 },
      kronos: { hitRate: 0.35, samples: 50 },
      rfdetr: { hitRate: 0.85, samples: 50 },
    };
    const boosted = applyRubric(input({ seats, modelStats: stats }), { dissent: { credibilityBoost: 3 } });
    const normal = applyRubric(input({ seats, modelStats: stats }));
    assert.ok(boosted.dissentPenalty > normal.dissentPenalty);
  });
});

/* ------------------------------------------------------------------ */
/* Tier system                                                         */
/* ------------------------------------------------------------------ */

describe("tier system — the sizing engine never hard-codes a threshold", () => {
  it("maps confidence to tier and size multiplier", () => {
    assert.equal(tierForConfidence(0.9), "FULL");
    assert.equal(tierForConfidence(0.65), "HALF");
    assert.equal(tierForConfidence(0.5), "PROBE");
    assert.equal(tierForConfidence(0.1), "REJECT");
  });

  it("the tier thresholds are configurable", () => {
    const cfg = resolveRubricConfig({ tiers: { FULL: 0.95, HALF: 0.85, PROBE: 0.8 } });
    assert.equal(tierForConfidence(0.9, cfg), "HALF");
  });

  it("the size multipliers are configurable", () => {
    const d = applyRubric(input(), { tierMultipliers: { FULL: 0.8, HALF: 0.4, PROBE: 0.1, REJECT: 0 } });
    assert.equal(d.verdict, "APPROVE");
    assert.equal(d.tier, "FULL");
    assert.equal(d.sizeMultiplier, 0.8);
  });

  it("documents the tier table", () => {
    assert.deepEqual(DEFAULT_TIER_TABLE.map((t) => t.tier), ["FULL", "HALF", "PROBE", "REJECT"]);
    assert.deepEqual(DEFAULT_TIER_TABLE.map((t) => t.sizeMultiplier), [1, 0.5, 0.25, 0]);
    for (const row of DEFAULT_TIER_TABLE) {
      assert.equal(resolveRubricConfig().tierMultipliers[row.tier], row.sizeMultiplier);
    }
  });

  it("a non-APPROVE verdict always sizes to zero", () => {
    const d = applyRubric(input({ seats: [seat({ seat: "jev", side: "long", confidence: 0.1 })] }));
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.sizeMultiplier, 0);
    assert.equal(d.tier, "REJECT");
  });
});

/* ------------------------------------------------------------------ */
/* Volatility guard                                                    */
/* ------------------------------------------------------------------ */

describe("volatility guard — too dead to pay, too wild to survive fees", () => {
  it("rejects an ATR above the band", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, atrPct: 14 } }));
    assert.equal(d.verdict, "REJECT");
    assert.match(d.reason, /ATR/);
    assert.ok(d.reasons.some((r) => r.startsWith("volatility:") && r.includes("too wild")));
  });

  it("downgrades an ATR below the band (caps the tier, cuts confidence)", () => {
    const wild = applyRubric(input({ setup: { ...goodSetup, atrPct: 3 } }));
    const dead = applyRubric(input({ setup: { ...goodSetup, atrPct: 0.05 } }));
    assert.equal(dead.volatilityFactor, 0.5);
    assert.ok(dead.confidence < wild.confidence);
    assert.ok(dead.reasons.some((r) => r.startsWith("volatility:") && r.includes("too dead")));
  });

  it("the band is configurable", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, atrPct: 3 } }), {
      volatility: { minAtrPct: 0.1, maxAtrPct: 10 },
    });
    assert.equal(d.volatilityFactor, 1);
  });

  it("the dead/wild actions are configurable (downgrade instead of reject)", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 1 }),
          seat({ seat: "kronos", side: "long", confidence: 1 }),
        ],
        setup: { ...goodSetup, atrPct: 14 },
      }),
      { volatility: { wildAction: "downgrade" } },
    );
    assert.equal(d.volatilityFactor, 0.5);
    assert.equal(d.verdict, "APPROVE");
    assert.equal(d.tier, "PROBE");
    const volReason = d.reasons.find((r) => r.startsWith("volatility:")) ?? "";
    assert.match(volReason, /downgraded/);
    assert.doesNotMatch(volReason, /REJECT/);
  });

  it("the guard can be switched off", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, atrPct: 40 } }), { volatility: { enabled: false } });
    assert.equal(d.volatilityFactor, 1);
    assert.equal(d.verdict, "APPROVE");
  });
});

/* ------------------------------------------------------------------ */
/* Cost check                                                          */
/* ------------------------------------------------------------------ */

describe("cost check — the edge must beat the round-trip fee on leveraged notional", () => {
  it("rejects when the expected edge does not cover the fee", () => {
    const d = applyRubric(
      input({
        setup: { ...goodSetup, targetDistancePct: 0.1, hitProbability: 0.2 },
      }),
    );
    assert.equal(d.verdict, "REJECT");
    assert.ok((d.expectedEdgePct ?? 0) < (d.requiredEdgePct ?? Infinity));
    assert.ok(d.reasons.some((r) => r.startsWith("cost:") && r.includes("REJECT")));
  });

  it("charges the fee on the leveraged notional, not the margin", () => {
    const d = applyRubric(input());
    assert.equal(d.notionalUsd, 1000); // 100 margin x 10 leverage
    assert.ok((d.requiredEdgePct ?? 0) > 0);
    // 0.06%/side x2 = 0.12% round trip + 0.10% margin = 0.22%
    assert.equal(d.requiredEdgePct, 0.22);
  });

  it("the fee rate is overridable per setup and via config (setup wins — it is the venue's actual tier)", () => {
    const cheap = applyRubric(input({ setup: { ...goodSetup, feeRatePerSide: 0.0002 } }));
    assert.equal(cheap.requiredEdgePct, 0.14); // 0.04% + 0.10%
    // No setup fee -> the config default is used.
    const noSetupFee = applyRubric(input({ setup: { ...goodSetup, feeRatePerSide: null } }));
    assert.equal(noSetupFee.requiredEdgePct, 0.22);
    // The config fee is the DEFAULT; an explicit setup tier overrides it.
    // 0.001/side = 0.1%/side -> 0.2% round trip + 0.10% margin = 0.30%.
    const cfg = applyRubric(input({ setup: { ...goodSetup, feeRatePerSide: null } }), {
      cost: { feeRatePerSide: 0.001 },
    });
    assert.equal(cfg.requiredEdgePct, 0.3);
  });

  it("the edge margin is configurable", () => {
    const d = applyRubric(input(), { cost: { edgeMarginPct: 5 } });
    assert.equal(d.verdict, "REJECT");
  });

  it("fails closed when the edge cannot be computed", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, hitProbability: null } }));
    assert.equal(d.verdict, "REJECT");
    assert.ok(d.reasons.some((r) => r.startsWith("cost:") && r.includes("cannot evaluate")));
  });

  it("the cost rule can be switched off", () => {
    const d = applyRubric(input({ setup: { ...goodSetup, targetDistancePct: 0.01, hitProbability: 0.01 } }), {
      cost: { enabled: false },
    });
    assert.notEqual(d.verdict, "REJECT");
  });
});

/* ------------------------------------------------------------------ */
/* Contract, purity, reasons                                          */
/* ------------------------------------------------------------------ */

describe("contract + purity", () => {
  it("is pure: the same input gives the same decision and the input is not mutated", () => {
    const seats: CommitteeSeat[] = [
      seat({ seat: "jev", side: "long", confidence: 0.9 }),
      seat({ seat: "kronos", side: "long", confidence: 0.7 }),
    ];
    const snapshot = JSON.stringify({ seats, setup: goodSetup });
    const a = applyRubric({ seats, setup: goodSetup });
    const b = applyRubric({ seats, setup: goodSetup });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify({ seats, setup: goodSetup }), snapshot);
  });

  it("every rule contributes a reason string", () => {
    const d = applyRubric(input());
    for (const prefix of ["veto:", "floor:", "dissent:", "quality:", "cost:", "volatility:", "tier:"]) {
      assert.ok(
        d.reasons.some((r) => r.startsWith(prefix)),
        `missing reason for ${prefix}`,
      );
    }
    assert.ok(d.reason.length > 0);
  });

  it("reports the seat breakdown, the sides and the reason per seat", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.9, reason: "trend up" }),
          seat({ seat: "kronos", side: "long", confidence: 0.7, reason: "up 1.4%" }),
          seat({ seat: "rfdetr", side: "short", confidence: 0.6, reason: "bearish pattern" }),
        ],
      }),
    );
    assert.equal(d.breakdown.length, 3);
    assert.equal(d.breakdown.find((b) => b.seat === "jev")?.stance, "agree");
    assert.equal(d.breakdown.find((b) => b.seat === "rfdetr")?.stance, "dissent");
    assert.equal(d.breakdown.find((b) => b.seat === "jev")?.reason, "trend up");
  });

  it("a vetoing seat is reported as a veto, not an abstention", () => {
    const d = applyRubric(
      input({
        seats: [
          seat({ seat: "jev", side: "long", confidence: 0.9 }),
          seat({ seat: "kronos", side: "long", confidence: 0.8 }),
          seat({ seat: "risk", side: "long", confidence: 0.7, veto: true, vetoReason: "no" }),
        ],
      }),
    );
    assert.equal(d.breakdown.find((b) => b.seat === "risk")?.stance, "veto");
    assert.equal(d.vetoed, true);
  });

  it("handles an empty committee without inventing a trade", () => {
    const d = applyRubric({ seats: [] });
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.sizeMultiplier, 0);
    assert.equal(d.side, "flat");
  });

  it("tolerates junk input instead of throwing", () => {
    const d = applyRubric({
      seats: [
        { seat: "", side: "sideways", confidence: 5 } as unknown as CommitteeSeat,
        { seat: "x", side: "long", confidence: -1 } as unknown as CommitteeSeat,
      ],
      setup: { atrPct: NaN, spreadBps: "wide" } as unknown as SetupMetrics,
    });
    assert.equal(d.verdict, "FLAT");
    assert.equal(d.sizeMultiplier, 0);
  });

  it("the default config is the documented one", () => {
    const cfg: RubricConfig = resolveRubricConfig();
    assert.equal(cfg.floor.minConsensus, 0.45);
    assert.equal(cfg.floor.minSeats, 2);
    assert.equal(cfg.veto.enabled, true);
    assert.equal(cfg.quality.enabled, true);
    assert.equal(cfg.dissent.penalty, 0.5);
    assert.equal(cfg.volatility.minAtrPct, 0.2);
    assert.equal(cfg.volatility.maxAtrPct, 8);
    assert.equal(cfg.cost.feeRatePerSide, 0.0006);
    assert.equal(cfg.cost.edgeMarginPct, 0.1);
    assert.deepEqual(cfg.tierMultipliers, { FULL: 1, HALF: 0.5, PROBE: 0.25, REJECT: 0 });
    assert.deepEqual(resolveRubricConfig(), DEFAULT_RUBRIC_CONFIG);
  });

  it("bad overrides fall back to the defaults instead of poisoning the decision", () => {
    const cfg = resolveRubricConfig({
      floor: { minConsensus: Number.NaN },
      tiers: { FULL: -5 },
      tierMultipliers: { FULL: Number.NaN },
    });
    assert.equal(cfg.floor.minConsensus, DEFAULT_RUBRIC_CONFIG.floor.minConsensus);
    assert.equal(cfg.tiers.FULL, DEFAULT_RUBRIC_CONFIG.tiers.FULL);
    assert.equal(cfg.tierMultipliers.FULL, DEFAULT_RUBRIC_CONFIG.tierMultipliers.FULL);
  });

  it("a broken tier ladder falls back wholesale rather than shipping an unreachable tier", () => {
    const cfg = resolveRubricConfig({ tiers: { FULL: 0.5, HALF: 0.9, PROBE: 0.2 } });
    assert.deepEqual(cfg.tiers, DEFAULT_RUBRIC_CONFIG.tiers);
  });
});

/* ------------------------------------------------------------------ */
/* Adapter: signed ballots -> canonical seats                          */
/* ------------------------------------------------------------------ */

describe("seatsFromSignedBallots — the committee's signed output feeds the rubric", () => {
  it("maps the sign to a side and the magnitude to confidence", () => {
    const seats = seatsFromSignedBallots([
      { seat: "jev", score: 0.9, reason: "up" },
      { seat: "kronos", score: -0.6, reason: "down" },
    ]);
    assert.equal(seats.length, 2);
    assert.equal(seats[0]?.side, "long");
    assert.equal(seats[0]?.confidence, 0.9);
    assert.equal(seats[1]?.side, "short");
    assert.equal(seats[1]?.confidence, 0.6);
  });

  it("keeps a vetoing seat even at score 0, and carries its rule and detail", () => {
    const seats = seatsFromSignedBallots([
      { seat: "risk", score: 0, veto: { rule: "funding_window", detail: "CPI in 10m" } },
    ]);
    assert.equal(seats.length, 1);
    assert.equal(seats[0]?.veto, true);
    assert.match(seats[0]?.vetoReason ?? "", /funding_window/);
    assert.match(seats[0]?.vetoReason ?? "", /CPI in 10m/);
  });

  it("drops abstaining and zero-score seats (they carry no information)", () => {
    const seats = seatsFromSignedBallots([
      { seat: "a", score: 0.5 },
      { seat: "b", score: 0 },
      { seat: "c", score: 0.7, abstain: true },
    ]);
    assert.deepEqual(seats.map((s) => s.seat), ["a"]);
  });

  it("the adapter output feeds straight into the rubric", () => {
    const d = applyRubric({
      seats: seatsFromSignedBallots([
        { seat: "jev", score: 0.9, reason: "up" },
        { seat: "kronos", score: 0.7, reason: "up" },
      ]),
      setup: goodSetup,
    });
    assert.equal(d.verdict, "APPROVE");
    assert.equal(d.side, "long");
  });

  it("a veto delivered through the adapter still blocks the trade", () => {
    const d = applyRubric({
      seats: seatsFromSignedBallots([
        { seat: "jev", score: 0.9 },
        { seat: "kronos", score: 0.8 },
        { seat: "risk", score: 0, veto: { rule: "btc_fee", detail: "fee-unprofitable" } },
      ]),
      setup: goodSetup,
    });
    assert.equal(d.verdict, "REJECT");
    assert.deepEqual(d.vetoSeats, ["risk"]);
  });
});
