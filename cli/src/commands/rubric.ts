/**
 * Committee rubric — the formal scoring rubric that governs the committee's
 * debate. Pure: no I/O, no clock, no randomness, no network.
 *
 * The committee engine produces per-seat scores and reasons; this module
 * turns those into a decision. It never asks a model anything and never
 * picks the direction — it only decides whether the debate is tradable, how
 * big it may be, and why. The committee owns the scores; the rubric owns
 * the rules.
 *
 * RULES (each overridable via `RubricOverrides`, each returns a reason so
 * the alert can explain the decision):
 *
 *  1. VETO       — any seat's hard veto blocks the trade outright. A veto is
 *                  NEVER outvoted by the aggregate score, however unanimous
 *                  the rest of the committee is.
 *  2. FLOOR      — a committee that never says no is useless: below
 *                  `floor.minConsensus` consensus (or with fewer than
 *                  `floor.minSeats` agreeing seats) the verdict is FLAT.
 *  3. COST       — expected gross edge (target distance x hit probability)
 *                  must cover the round-trip fee charged on the LEVERAGED
 *                  notional, plus a margin. Otherwise REJECT.
 *  4. VOLATILITY — ATR outside [minAtrPct, maxAtrPct] is downgraded (tier
 *                  cap + confidence factor) or rejected. The band is
 *                  configurable.
 *  5. QUALITY    — the final confidence is scaled by venue/setup quality:
 *                  spread, fee drag vs stop distance, liquidity, and
 *                  distance-from-extreme. A strong signal on a bad venue is
 *                  a bad trade.
 *  6. DISSENT    — a dissenting seat is information, not a veto: it reduces
 *                  confidence proportionally. A dissenter that has
 *                  historically been MORE right than the agreeing side is
 *                  treated more harshly (per-model hit rates are an input).
 *  7. TIER       — the final confidence maps to an execution tier
 *                  (FULL / HALF / PROBE / REJECT) with a documented size
 *                  multiplier, so the sizing engine never hard-codes a
 *                  threshold.
 *
 * VERDICT PRECEDENCE (first match wins):
 *   veto -> floor (FLAT) -> cost -> volatility -> tier
 * A FLAT verdict means "the committee has no opinion"; a REJECT verdict
 * means "there was an opinion and a rule blocked it". Both size to zero.
 *
 * UNITS — every "pct" field is PERCENT (1.5 = 1.5%). `feeRatePerSide` is a
 * FRACTION (0.0006 = 0.06%/side, the verified KuCoin taker rate; maker is
 * 0.0002). Leverage appears in the cost check for the dollar report only:
 * the edge and the fee both scale with the traded notional, so the ratio is
 * leverage-invariant — the fee is charged on margin x leverage, never on
 * margin (a margin-denominated fee understates the real cost at 20x).
 *
 * FAIL-CLOSED — a metric the rubric cannot measure scores 0 (see
 * `quality.unknownScore`), not "unknown but fine". Venue microstructure you
 * cannot read is not a venue you should trade.
 *
 * THE CONTRACT (what the committee engine produces):
 *   in : RubricInput  = { seats, setup?, modelStats? }
 *   out: RubricDecision = { verdict, tier, sizeMultiplier, side, confidence,
 *                           reasons, ... }
 */

export type RubricVerdict = "APPROVE" | "FLAT" | "REJECT";
export type ExecutionTier = "FULL" | "HALF" | "PROBE" | "REJECT";
export type TradeSide = "long" | "short" | "flat";
export type SeatStance = "agree" | "dissent" | "abstain" | "veto";
export type VolatilityAction = "downgrade" | "reject";

/* ------------------------------------------------------------------ */
/* Input contract (produced by the committee engine)                   */
/* ------------------------------------------------------------------ */

/** One committee seat's ballot. The committee produces this; the rubric reads it. */
export type CommitteeSeat = {
  /** Stable model id — "jev", "kronos", "rfdetr", ... */
  seat: string;
  /** The seat's own call. "flat" = no call (abstain). */
  side: TradeSide;
  /** The seat's conviction in its own call, 0..1. */
  confidence: number;
  /** Hard veto — blocks the trade outright, never outvoted. */
  veto?: boolean;
  /** Why the seat vetoed (surfaced in the alert). */
  vetoReason?: string;
  /** The seat's reasoning (surfaced in the alert). */
  reason: string;
};

/** Setup + venue metrics the quality / cost / volatility rules need. */
export type SetupMetrics = {
  /** TP distance in percent of price. */
  targetDistancePct?: number | null;
  /** Stop distance in percent of price — the fee-drag denominator. */
  stopDistancePct?: number | null;
  /** Probability the target is hit before the stop, 0..1. */
  hitProbability?: number | null;
  /** ATR in percent of price. */
  atrPct?: number | null;
  /** Bid/ask spread in basis points. */
  spreadBps?: number | null;
  /** Top-of-book notional (both sides) in USD — the liquidity proxy. */
  liquidityUsd?: number | null;
  /** Distance from the NEAREST range extreme, percent (min(offHigh, offLow)). */
  distanceFromExtremePct?: number | null;
  /** Margin committed, USD (dollar report only). */
  marginUsd?: number | null;
  /** Leverage multiplier (dollar report only). */
  leverage?: number | null;
  /** Fee rate per side as a fraction (0.0006 = taker). Overrides the config default. */
  feeRatePerSide?: number | null;
};

/** Per-model track record. `samples` gates the credibility boost. */
export type ModelTrack = { hitRate: number; samples: number };

/** Per-model historical hit rates, keyed by seat id. */
export type ModelStats = Record<string, ModelTrack>;

export type RubricInput = {
  /** Every seat that voted (or abstained). */
  seats: readonly CommitteeSeat[];
  /** Setup + venue metrics. Missing legs fail closed. */
  setup?: SetupMetrics | null;
  /** Per-model historical hit rates (used by the dissent rule). */
  modelStats?: ModelStats;
};

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export type RubricConfig = {
  floor: {
    /** Master switch for the confidence floor. */
    enabled: boolean;
    /** Minimum consensus score (0..1) for a tradable verdict. */
    minConsensus: number;
    /** Minimum number of agreeing (non-abstaining, non-vetoing) seats. */
    minSeats: number;
  };
  veto: {
    /** Master switch for the hard-veto rule. */
    enabled: boolean;
  };
  quality: {
    /** Master switch for the quality multiplier (off => multiplier 1). */
    enabled: boolean;
    /** Relative weight of each quality component. */
    weights: { spread: number; feeDrag: number; liquidity: number; distanceFromExtreme: number };
    /** Spread score: 1 at or below `idealBps`, 0 at or above `maxBps`. */
    spread: { idealBps: number; maxBps: number };
    /** Fee-drag score: 1 at or below `idealRatio`, 0 at or above `maxRatio`. */
    feeDrag: { idealRatio: number; maxRatio: number };
    /** Liquidity score: 1 at or above `idealUsd`, 0 at or below `minUsd`. */
    liquidity: { idealUsd: number; minUsd: number };
    /** Distance-from-extreme score: 1 at or above `idealPct`, 0 at 0. */
    distanceFromExtreme: { idealPct: number };
    /** Score given to a component whose metric is unknown. 0 = fail closed. */
    unknownScore: number;
  };
  dissent: {
    /** Scale of the dissent penalty (0 disables it). */
    penalty: number;
    /** Extra harshness for a dissenter whose hit rate beats the agreeing side. */
    credibilityBoost: number;
    /** Minimum scored samples before a model's hit rate may boost credibility. */
    minSamples: number;
    /** Hit rate assumed for a side with no usable track record. */
    neutralHitRate: number;
  };
  volatility: {
    enabled: boolean;
    /** ATR% below this is "too dead to pay". */
    minAtrPct: number;
    /** ATR% above this is "too wild to survive fees". */
    maxAtrPct: number;
    /** What to do when ATR is too dead. */
    deadAction: VolatilityAction;
    /** What to do when ATR is too wild. */
    wildAction: VolatilityAction;
    /** Confidence factor applied on a downgrade. */
    downgradeFactor: number;
    /** Tier ceiling applied on a downgrade. */
    downgradeTier: ExecutionTier;
  };
  cost: {
    enabled: boolean;
    /** Fee rate per side as a fraction (0.0006 = KuCoin taker, 0.06%). */
    feeRatePerSide: number;
    /** Extra margin the edge must clear on top of the fee, in percent of notional. */
    edgeMarginPct: number;
  };
  /** Minimum final confidence for each tradable tier. */
  tiers: { FULL: number; HALF: number; PROBE: number };
  /** Size multiplier per tier — what the sizing engine consumes. */
  tierMultipliers: Record<ExecutionTier, number>;
};

export const DEFAULT_RUBRIC_CONFIG: RubricConfig = {
  floor: { enabled: true, minConsensus: 0.45, minSeats: 2 },
  veto: { enabled: true },
  quality: {
    enabled: true,
    weights: { spread: 0.2, feeDrag: 0.3, liquidity: 0.25, distanceFromExtreme: 0.25 },
    spread: { idealBps: 2, maxBps: 20 },
    feeDrag: { idealRatio: 0.15, maxRatio: 0.8 },
    liquidity: { idealUsd: 50_000, minUsd: 2_500 },
    distanceFromExtreme: { idealPct: 3 },
    unknownScore: 0,
  },
  dissent: { penalty: 0.5, credibilityBoost: 1, minSamples: 20, neutralHitRate: 0.5 },
  volatility: {
    enabled: true,
    minAtrPct: 0.2,
    maxAtrPct: 8,
    deadAction: "downgrade",
    wildAction: "reject",
    downgradeFactor: 0.5,
    downgradeTier: "PROBE",
  },
  cost: { enabled: true, feeRatePerSide: 0.0006, edgeMarginPct: 0.1 },
  tiers: { FULL: 0.75, HALF: 0.6, PROBE: 0.45 },
  tierMultipliers: { FULL: 1, HALF: 0.5, PROBE: 0.25, REJECT: 0 },
};

/** The documented tier table (defaults). The sizing engine reads `sizeMultiplier`. */
export const DEFAULT_TIER_TABLE: readonly {
  tier: ExecutionTier;
  minConfidence: number;
  sizeMultiplier: number;
}[] = [
  { tier: "FULL", minConfidence: DEFAULT_RUBRIC_CONFIG.tiers.FULL, sizeMultiplier: DEFAULT_RUBRIC_CONFIG.tierMultipliers.FULL },
  { tier: "HALF", minConfidence: DEFAULT_RUBRIC_CONFIG.tiers.HALF, sizeMultiplier: DEFAULT_RUBRIC_CONFIG.tierMultipliers.HALF },
  { tier: "PROBE", minConfidence: DEFAULT_RUBRIC_CONFIG.tiers.PROBE, sizeMultiplier: DEFAULT_RUBRIC_CONFIG.tierMultipliers.PROBE },
  { tier: "REJECT", minConfidence: 0, sizeMultiplier: DEFAULT_RUBRIC_CONFIG.tierMultipliers.REJECT },
];

const TIER_RANK: Record<ExecutionTier, number> = { REJECT: 0, PROBE: 1, HALF: 2, FULL: 3 };

/** Partial config — every rule is overridable, one section at a time. */
export type RubricOverrides = {
  floor?: Partial<RubricConfig["floor"]>;
  veto?: Partial<RubricConfig["veto"]>;
  quality?: Partial<Omit<RubricConfig["quality"], "weights" | "spread" | "feeDrag" | "liquidity" | "distanceFromExtreme">> & {
    weights?: Partial<RubricConfig["quality"]["weights"]>;
    spread?: Partial<RubricConfig["quality"]["spread"]>;
    feeDrag?: Partial<RubricConfig["quality"]["feeDrag"]>;
    liquidity?: Partial<RubricConfig["quality"]["liquidity"]>;
    distanceFromExtreme?: Partial<RubricConfig["quality"]["distanceFromExtreme"]>;
  };
  dissent?: Partial<RubricConfig["dissent"]>;
  volatility?: Partial<RubricConfig["volatility"]>;
  cost?: Partial<RubricConfig["cost"]>;
  tiers?: Partial<RubricConfig["tiers"]>;
  tierMultipliers?: Partial<RubricConfig["tierMultipliers"]>;
};

/* ------------------------------------------------------------------ */
/* Verdict-stack tuning (OQ-09): THE single tuning surface             */
/* ------------------------------------------------------------------ */

/**
 * Every weight and every threshold the verdict seats read — the vote and
 * oracle ballots, the committee's seats, the scorer's evidence bar and the
 * learning loop's seat gate — is defined here and nowhere else.
 * `weighting.ts` (the one weighting module), `track-store.ts` (the one
 * track store) and the seat modules import these values; they never
 * restate one. The rubric's own rules (`DEFAULT_RUBRIC_CONFIG` above) are
 * the other half of the surface. OQ-09 phase 1 moved every value here
 * unchanged (pinned byte-identical by verdict-golden.test.ts).
 *
 * The per-call overrides that already existed keep working unchanged:
 * `RubricOverrides`, `CommitteeParamsOverride`, the committee's per-seat
 * `weights`, and the learning gate options.
 */
export const VERDICT_TUNING = {
  /** The confidence-weighted ballot (`jw3 vote`, `jw3 oracle`, the committee's model legs, degen's oracle). */
  ballot: {
    /** Ballot-open weight per vote.json track: JEV leads, Kronos halves, RF-DETR silent until wired. */
    defaultWeights: { jev: 1.0, kronos: 0.5, rfdetr: 0 },
    /** |weighted score| at or above this decides long/short; below is flat (no consensus). */
    consensusThreshold: 0.15,
    /** Kronos conviction: an expected move of this many % (or more) is full conviction. */
    kronosFullMovePct: 1,
    /** Kronos conviction floor while the model makes a directional call. */
    kronosMinConviction: 0.1,
  },
  /** The rolling hit-rate auto-tune every vote.json / score.json track runs. */
  autoTune: {
    /** Rolling window of scored outcomes per track. */
    window: 20,
    /** Samples needed before the auto-tune touches a weight. */
    minSamples: 5,
    /** Rolling hit-rate at or above which the weight steps up. */
    promoteAt: 0.6,
    /** Rolling hit-rate at or below which the weight steps down. */
    demoteAt: 0.4,
    step: 0.1,
    cap: 2.0,
    floor: 0,
  },
  /** Earn-the-seat gate: a model votes on real money only past both bars. */
  seatGate: {
    minSamples: 30,
    hitFloor: 0.55,
    /** Weight a model that earned the seat starts from (one auto-tune step). */
    seatWeight: 0.1,
  },
  /** The scorer's evidence bar for any reported rate. */
  evidence: {
    /** Minimum samples before a rate is reported as measured (per side, per window). */
    rateFloorSamples: 5,
    /** Default holdout window (the Kronos precedent: 64 windows). */
    holdoutSize: 64,
    /** Confidence level of the reported Wilson interval, and its two-sided normal quantile. */
    confidenceLevel: 0.95,
    confidenceZ: 1.959963984540054,
  },
  /** The learning report's pair-split and dissent reads. */
  learning: {
    /** A pair must split this many times before "systematically right" is claimed. */
    minSplitSamples: 5,
    /** A dissenter needs this many dissents before its dissent rate means anything. */
    minDissentSamples: 5,
    /** A dissenter is "systematically wrong" above this share of wrong dissents. */
    dissentWrongRate: 0.6,
  },
  /** The committee (`jw3 committee`, the harness). */
  committee: {
    /** The committee's default params (`CommitteeParams`; per-call overrides merge onto these). */
    params: {
      consensusThreshold: 0.2,
      minAgreement: 0.5,
      minVoters: 1,
      sizeStep: 0,
      structure: { swingWindow: 12, atrRefPct: 1.0 },
      momentum: {
        emaPeriod: 20,
        tfWeights: { "1h": 0.2, "4h": 0.3, "1d": 0.5 },
        slopeRefPct: 0.5,
        legWeights: { mtf: 1.0, vote: 0.8, oracle: 0.8 },
      },
      flow: { imbalanceFull: 0.25, volRatioCap: 2, minVolRatio: 0.7 },
      meanReversion: { vwapRefPct: 0.5, rsiBand: 20, zRef: 2 },
      eventRisk: { fundingVetoPct: 0.1, avoidUtcMinutes: [] as number[], thinUtcMinutes: [] as number[] },
      execution: {
        roundTripFeePct: 0.12,
        feeDragVeto: 1 / 3,
        maxSpreadBps: 15,
        edgeCostCap: 0.6,
        minBookNotionalUsd: 5000,
      },
    },
    /** Default seat weights (per-call `weights` override them). */
    seatWeights: {
      structure: 1.0,
      momentum: 1.2,
      flow: 0.9,
      mean_reversion: 0.6,
      event_risk: 1.0,
      execution: 1.0,
    },
    /** The weights and thresholds inside each seat's read. */
    seats: {
      /** A directional seat whose |score| is under this abstains (no edge). */
      abstainBand: 0.05,
      structure: {
        swingWeight: 0.45,
        rangeWeight: 0.25,
        jevWeight: 0.3,
        /** ATR factor when the ATR is unknown. */
        atrFactorUnknown: 0.5,
        /** A dead tape keeps this share of the read; the rest scales with the ATR factor. */
        deadTapeBase: 0.5,
        deadTapeSpan: 0.5,
      },
      momentum: {
        /** EMA slope is read over this many bars back. */
        slopeLookbackBars: 6,
        /** Timeframe agreement factor when no timeframe can be read. */
        agreeFactorUnknown: 0.5,
      },
      flow: {
        /** Volume factor when the volume ratio is unknown. */
        volFactorUnknown: 0.5,
        volBase: 0.4,
        volSpan: 0.6,
        /** Damp on the read when volume is fading. */
        fadingVolDamp: 0.7,
      },
      meanReversion: {
        vwapWeight: 0.3,
        emaWeight: 0.2,
        rsiWeight: 0.25,
        zWeight: 0.25,
        zPeriod: 20,
        /** Stretch measures needed (of vwap/ema/rsi/z) before the seat reads. */
        minMeasures: 2,
      },
      eventRisk: {
        /** Support lost when the proposal pays funding. */
        fundingPayPenalty: 0.5,
        /** Support lost in a thin-liquidity minute. */
        thinPenalty: 0.3,
      },
      /** Conviction → size: base share plus the conviction-scaled span (never 0, never above 1). */
      conviction: { base: 0.5, span: 0.5 },
      /** The proposal the CLI debates when no levels are given. */
      proposal: { atrFallbackPct: 0.5, targetR: 1.5 },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

/**
 * The committee engine's raw ballot, in the shape most committees emit:
 * a SIGNED score (-1 argues short, +1 argues long) plus an optional veto.
 * The rubric's own `CommitteeSeat` is the canonical form; this adapter maps
 * the signed form onto it so the committee never has to reshape its output.
 */
export type SignedSeatBallot = {
  seat: string;
  /** Signed conviction in [-1, 1]. */
  score: number;
  /** Hard veto (rule + detail) or null. */
  veto?: { rule?: string; detail?: string } | null;
  /** The seat's reasoning. */
  reason?: string;
  /** True when the seat abstained. */
  abstain?: boolean;
};

/**
 * Map signed ballots onto the rubric's canonical seat shape. A score of 0
 * (or an abstention) becomes an abstaining seat; the sign picks the side.
 * A vetoing seat is kept even at score 0 — its veto still blocks.
 */
export function seatsFromSignedBallots(ballots: readonly SignedSeatBallot[]): CommitteeSeat[] {
  if (!Array.isArray(ballots)) return [];
  const out: CommitteeSeat[] = [];
  for (const b of ballots) {
    if (!b || typeof b !== "object") continue;
    const score = typeof b.score === "number" && Number.isFinite(b.score) ? Math.min(Math.max(b.score, -1), 1) : 0;
    const vetoed = !!b.veto;
    const detail = typeof b.veto?.detail === "string" && b.veto.detail !== "" ? b.veto.detail : undefined;
    const rule = typeof b.veto?.rule === "string" && b.veto.rule !== "" ? b.veto.rule : undefined;
    const confidence = Math.abs(score);
    // An abstaining seat with no veto carries no information: drop it.
    if (b.abstain === true && !vetoed) continue;
    if (confidence === 0 && !vetoed) continue;
    const side: TradeSide = score > 0 ? "long" : score < 0 ? "short" : "flat";
    out.push({
      seat: typeof b.seat === "string" && b.seat.trim() !== "" ? b.seat.trim() : "seat",
      side,
      confidence,
      veto: vetoed,
      vetoReason: vetoed ? ([rule, detail].filter(Boolean).join(": ") || "veto") : undefined,
      reason: typeof b.reason === "string" ? b.reason : "",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Output contract (consumed by the sizing engine + the alert)         */
/* ------------------------------------------------------------------ */
export type SeatBreakdown = {
  seat: string;
  side: TradeSide;
  confidence: number;
  stance: SeatStance;
  veto: boolean;
  /** Credibility multiplier applied to this seat's dissent (1 = no boost). */
  dissentBoost: number;
  /** The seat's own reason, carried through untouched. */
  reason: string;
};

export type RubricDecision = {
  /** APPROVE = trade at `sizeMultiplier`; FLAT = no opinion; REJECT = blocked. */
  verdict: RubricVerdict;
  /** Execution tier. REJECT whenever the verdict is not APPROVE. */
  tier: ExecutionTier;
  /** What the sizing engine consumes: fraction of the planned size to use. */
  sizeMultiplier: number;
  /** The committee's majority side (the rubric never picks a direction). */
  side: TradeSide;
  /** Final confidence after every rule, 0..1. */
  confidence: number;
  /** Consensus before quality/dissent scaling, 0..1. */
  consensusScore: number;
  /** Venue/setup quality multiplier, 0..1. */
  qualityMultiplier: number;
  /** Dissent penalty actually applied, 0..1. */
  dissentPenalty: number;
  /** Volatility factor actually applied, 0..1. */
  volatilityFactor: number;
  /** Expected gross edge in percent of notional (null when not computable). */
  expectedEdgePct: number | null;
  /** Fee + margin the edge had to clear, in percent of notional. */
  requiredEdgePct: number | null;
  /** Leveraged notional the fee was charged on (null when unknown). */
  notionalUsd: number | null;
  /** True when a hard veto blocked the trade. */
  vetoed: boolean;
  /** Seats that cast a hard veto. */
  vetoSeats: string[];
  /** The one-line decision, for the alert headline. */
  reason: string;
  /** Every rule's reason, in rule order. */
  reasons: string[];
  /** Per-seat breakdown with the stance the rubric assigned. */
  breakdown: SeatBreakdown[];
  agreeSeats: string[];
  dissentSeats: string[];
  abstainSeats: string[];
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const clamp01 = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), 1);
};

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

const fmt = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : "n/a");

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Sanitise a config override. A value that is missing, non-finite, or OUT OF
 * RANGE falls back to the default — an out-of-range override is ignored
 * entirely rather than clamped, so a typo can never make a rule unreachable
 * (e.g. a negative FULL threshold would silently disable the FULL tier).
 */
const numOr = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < lo || v > hi) return fallback;
  return v;
};

const boolOr = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

const actionOr = (v: unknown, fallback: VolatilityAction): VolatilityAction =>
  v === "downgrade" || v === "reject" ? v : fallback;

const tierOr = (v: unknown, fallback: ExecutionTier): ExecutionTier =>
  v === "FULL" || v === "HALF" || v === "PROBE" || v === "REJECT" ? v : fallback;

/**
 * Merge overrides onto the defaults, sanitising every field. A bad override
 * (NaN, wrong type, negative multiplier) falls back to the default instead
 * of poisoning the decision.
 */
export function resolveRubricConfig(overrides?: RubricOverrides | null): RubricConfig {
  const d = DEFAULT_RUBRIC_CONFIG;
  const o = overrides ?? {};
  const f = o.floor ?? {};
  const v = o.veto ?? {};
  const q = o.quality ?? {};
  const qw = q.weights ?? {};
  const qs = q.spread ?? {};
  const qf = q.feeDrag ?? {};
  const ql = q.liquidity ?? {};
  const qd = q.distanceFromExtreme ?? {};
  const di = o.dissent ?? {};
  const vo = o.volatility ?? {};
  const co = o.cost ?? {};
  const ti = o.tiers ?? {};
  const tm = o.tierMultipliers ?? {};
  // Tier thresholds must descend (FULL >= HALF >= PROBE). A broken order
  // (a typo in one threshold) would make a tier unreachable, so the whole
  // tier block falls back to the defaults rather than shipping a ladder
  // that can never be walked.
  const tFull = numOr(ti.FULL, d.tiers.FULL, 0, 1);
  const tHalf = numOr(ti.HALF, d.tiers.HALF, 0, 1);
  const tProbe = numOr(ti.PROBE, d.tiers.PROBE, 0, 1);
  const tiers =
    tFull >= tHalf && tHalf >= tProbe
      ? { FULL: tFull, HALF: tHalf, PROBE: tProbe }
      : { ...d.tiers };
  return {
    floor: {
      enabled: boolOr(f.enabled, d.floor.enabled),
      minConsensus: numOr(f.minConsensus, d.floor.minConsensus, 0, 1),
      minSeats: Math.round(numOr(f.minSeats, d.floor.minSeats, 0, 1e6)),
    },
    veto: { enabled: boolOr(v.enabled, d.veto.enabled) },
    quality: {
      enabled: boolOr(q.enabled, d.quality.enabled),
      weights: {
        spread: numOr(qw.spread, d.quality.weights.spread, 0, 1e6),
        feeDrag: numOr(qw.feeDrag, d.quality.weights.feeDrag, 0, 1e6),
        liquidity: numOr(qw.liquidity, d.quality.weights.liquidity, 0, 1e6),
        distanceFromExtreme: numOr(qw.distanceFromExtreme, d.quality.weights.distanceFromExtreme, 0, 1e6),
      },
      spread: {
        idealBps: numOr(qs.idealBps, d.quality.spread.idealBps, 0, 1e6),
        maxBps: numOr(qs.maxBps, d.quality.spread.maxBps, 0, 1e6),
      },
      feeDrag: {
        idealRatio: numOr(qf.idealRatio, d.quality.feeDrag.idealRatio, 0, 1e6),
        maxRatio: numOr(qf.maxRatio, d.quality.feeDrag.maxRatio, 0, 1e6),
      },
      liquidity: {
        idealUsd: numOr(ql.idealUsd, d.quality.liquidity.idealUsd, 0, 1e12),
        minUsd: numOr(ql.minUsd, d.quality.liquidity.minUsd, 0, 1e12),
      },
      distanceFromExtreme: { idealPct: numOr(qd.idealPct, d.quality.distanceFromExtreme.idealPct, 0, 1e6) },
      unknownScore: numOr(q.unknownScore, d.quality.unknownScore, 0, 1),
    },
    dissent: {
      penalty: numOr(di.penalty, d.dissent.penalty, 0, 1),
      credibilityBoost: numOr(di.credibilityBoost, d.dissent.credibilityBoost, 0, 100),
      minSamples: Math.round(numOr(di.minSamples, d.dissent.minSamples, 0, 1e7)),
      neutralHitRate: numOr(di.neutralHitRate, d.dissent.neutralHitRate, 0, 1),
    },
    volatility: {
      enabled: boolOr(vo.enabled, d.volatility.enabled),
      minAtrPct: numOr(vo.minAtrPct, d.volatility.minAtrPct, 0, 1e6),
      maxAtrPct: numOr(vo.maxAtrPct, d.volatility.maxAtrPct, 0, 1e6),
      deadAction: actionOr(vo.deadAction, d.volatility.deadAction),
      wildAction: actionOr(vo.wildAction, d.volatility.wildAction),
      downgradeFactor: numOr(vo.downgradeFactor, d.volatility.downgradeFactor, 0, 1),
      downgradeTier: tierOr(vo.downgradeTier, d.volatility.downgradeTier),
    },
    cost: {
      enabled: boolOr(co.enabled, d.cost.enabled),
      feeRatePerSide: numOr(co.feeRatePerSide, d.cost.feeRatePerSide, 0, 1),
      edgeMarginPct: numOr(co.edgeMarginPct, d.cost.edgeMarginPct, 0, 1e6),
    },
    tiers,
    tierMultipliers: {
      FULL: numOr(tm.FULL, d.tierMultipliers.FULL, 0, 1e6),
      HALF: numOr(tm.HALF, d.tierMultipliers.HALF, 0, 1e6),
      PROBE: numOr(tm.PROBE, d.tierMultipliers.PROBE, 0, 1e6),
      REJECT: numOr(tm.REJECT, d.tierMultipliers.REJECT, 0, 1e6),
    },
  };
}

/** Tier for a final confidence (0..1). The sizing engine never hard-codes this. */
export function tierForConfidence(confidence: number, config: RubricConfig = DEFAULT_RUBRIC_CONFIG): ExecutionTier {
  const c = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0;
  if (c >= config.tiers.FULL) return "FULL";
  if (c >= config.tiers.HALF) return "HALF";
  if (c >= config.tiers.PROBE) return "PROBE";
  return "REJECT";
}

/* ------------------------------------------------------------------ */
/* Rule implementations                                                 */
/* ------------------------------------------------------------------ */

type NormalizedSeat = {
  seat: string;
  side: TradeSide;
  confidence: number;
  veto: boolean;
  vetoReason: string;
  reason: string;
};

function normalizeSeats(raw: readonly CommitteeSeat[]): NormalizedSeat[] {
  const out: NormalizedSeat[] = [];
  if (!Array.isArray(raw)) return out;
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const name = typeof s.seat === "string" && s.seat.trim() !== "" ? s.seat.trim() : "seat";
    const side: TradeSide = s.side === "long" || s.side === "short" ? s.side : "flat";
    out.push({
      seat: name,
      side,
      confidence: clamp01(s.confidence),
      veto: s.veto === true,
      vetoReason:
        typeof s.vetoReason === "string" && s.vetoReason.trim() !== "" ? s.vetoReason.trim() : "no reason given",
      reason: typeof s.reason === "string" ? s.reason : "",
    });
  }
  return out;
}

/**
 * Quality multiplier: the weighted blend of four 0..1 component scores.
 * Each component is piecewise-linear between an "ideal" and a "broken" bound;
 * an unknown metric scores `quality.unknownScore` (0 = fail closed).
 */
function evaluateQuality(
  setup: SetupMetrics,
  cfg: RubricConfig,
): { multiplier: number; components: { spread: number; feeDrag: number; liquidity: number; distanceFromExtreme: number }; reason: string } {
  const q = cfg.quality;
  const unknown = clamp01(q.unknownScore);

  if (!q.enabled) {
    return {
      multiplier: 1,
      components: { spread: 1, feeDrag: 1, liquidity: 1, distanceFromExtreme: 1 },
      reason: "quality: rule disabled by config — multiplier 1.00",
    };
  }

  // spread: 1 at/below idealBps, 0 at/above maxBps.
  const spreadBps = setup.spreadBps;
  let spread: number;
  if (typeof spreadBps === "number" && Number.isFinite(spreadBps)) {
    spread = spreadBps <= q.spread.idealBps ? 1 : q.spread.maxBps <= q.spread.idealBps ? 1 : clamp01((q.spread.maxBps - spreadBps) / (q.spread.maxBps - q.spread.idealBps));
  } else {
    spread = unknown;
  }

  // fee drag: round-trip fee as a fraction of the stop distance.
  const stopFraction = typeof setup.stopDistancePct === "number" && Number.isFinite(setup.stopDistancePct) ? setup.stopDistancePct / 100 : null;
  const feeRate = typeof setup.feeRatePerSide === "number" && Number.isFinite(setup.feeRatePerSide) ? setup.feeRatePerSide : cfg.cost.feeRatePerSide;
  const roundTripFraction = feeRate * 2;
  let feeDrag: number;
  if (stopFraction !== null && stopFraction > 0) {
    const ratio = roundTripFraction / stopFraction;
    feeDrag = ratio <= q.feeDrag.idealRatio ? 1 : q.feeDrag.maxRatio <= q.feeDrag.idealRatio ? 1 : clamp01((q.feeDrag.maxRatio - ratio) / (q.feeDrag.maxRatio - q.feeDrag.idealRatio));
  } else {
    feeDrag = unknown;
  }

  // liquidity: 1 at/above idealUsd, 0 at/below minUsd.
  const liq = setup.liquidityUsd;
  let liquidity: number;
  if (typeof liq === "number" && Number.isFinite(liq)) {
    liquidity =
      liq >= q.liquidity.idealUsd ? 1 : q.liquidity.idealUsd <= q.liquidity.minUsd ? 1 : clamp01((liq - q.liquidity.minUsd) / (q.liquidity.idealUsd - q.liquidity.minUsd));
  } else {
    liquidity = unknown;
  }

  // distance from the nearest extreme: 1 at/above idealPct, 0 at 0.
  const dist = setup.distanceFromExtremePct;
  let distanceFromExtreme: number;
  if (typeof dist === "number" && Number.isFinite(dist)) {
    distanceFromExtreme = q.distanceFromExtreme.idealPct <= 0 ? 1 : clamp01(dist / q.distanceFromExtreme.idealPct);
  } else {
    distanceFromExtreme = unknown;
  }

  const components = { spread, feeDrag, liquidity, distanceFromExtreme };
  const w = q.weights;
  const weightSum = w.spread + w.feeDrag + w.liquidity + w.distanceFromExtreme;
  if (!(weightSum > 0)) {
    return {
      multiplier: 0,
      components,
      reason: "quality: weights sum to 0 — quality 0.00 (fail closed)",
    };
  }
  const multiplier = clamp01(
    (w.spread * spread + w.feeDrag * feeDrag + w.liquidity * liquidity + w.distanceFromExtreme * distanceFromExtreme) / weightSum,
  );
  const missing: string[] = [];
  if (typeof setup.spreadBps !== "number" || !Number.isFinite(setup.spreadBps)) missing.push("spread");
  if (!(typeof setup.stopDistancePct === "number" && Number.isFinite(setup.stopDistancePct))) missing.push("feeDrag");
  if (!(typeof setup.liquidityUsd === "number" && Number.isFinite(setup.liquidityUsd))) missing.push("liquidity");
  if (!(typeof setup.distanceFromExtremePct === "number" && Number.isFinite(setup.distanceFromExtremePct))) missing.push("distance");
  const reason =
    `quality: ${fmt(multiplier)} ` +
    `(spread ${fmt(spread)}, feeDrag ${fmt(feeDrag)}, liquidity ${fmt(liquidity)}, distance ${fmt(distanceFromExtreme)})` +
    (missing.length > 0 ? ` — unknown: ${missing.join(", ")} scored ${fmt(unknown)}` : "");
  return { multiplier: round4(multiplier), components, reason };
}

/**
 * Dissent penalty. A dissenting seat is information, not a veto: it reduces
 * confidence proportionally to its share of the committee's conviction.
 * A dissenter whose historical hit rate beats the agreeing side gets its
 * conviction weighted up (`credibilityBoost`), so its dissent bites harder.
 */
function evaluateDissent(
  agree: NormalizedSeat[],
  dissent: NormalizedSeat[],
  stats: ModelStats,
  cfg: RubricConfig,
): { penalty: number; boosts: Map<string, number>; reason: string } {
  const boosts = new Map<string, number>();
  for (const s of agree) boosts.set(s.seat, 1);
  for (const s of dissent) boosts.set(s.seat, 1);

  if (dissent.length === 0) {
    return { penalty: 0, boosts, reason: "dissent: none — no dissent penalty" };
  }
  if (cfg.dissent.penalty <= 0) {
    return { penalty: 0, boosts, reason: "dissent: rule disabled (penalty 0) — no dissent penalty" };
  }

  // Usable hit rate for a seat, or null when the track record is unusable
  // (no data, or fewer than `minSamples` scored outcomes).
  const usableRate = (seat: string): number | null => {
    const t = stats[seat];
    if (!t || typeof t.hitRate !== "number" || !Number.isFinite(t.hitRate)) return null;
    if (typeof t.samples !== "number" || !Number.isFinite(t.samples) || t.samples < cfg.dissent.minSamples) return null;
    return clamp01(t.hitRate);
  };
  // The bar a dissenter has to clear: the mean hit rate of the agreeing
  // seats that have a usable track record (neutral when none do).
  const agreeRates = agree.map((s) => usableRate(s.seat)).filter((r): r is number => r !== null);
  const baseline = agreeRates.length > 0 ? sum(agreeRates) / agreeRates.length : cfg.dissent.neutralHitRate;

  let effectiveDissent = 0;
  const parts: string[] = [];
  for (const s of dissent) {
    const rate = usableRate(s.seat);
    // rel > 0: the dissenter has historically been MORE right than the
    // agreeing side -> its dissent is weighted up (harsher).
    // rel < 0: the dissenter has historically been WRONG -> weighted down
    // (softer), but never to zero — a wrong dissenter is still information.
    const rel = rate === null ? 0 : Math.min(Math.max(rate - baseline, -1), 1);
    const boost = Math.min(Math.max(1 + cfg.dissent.credibilityBoost * rel, 0.5), 2);
    boosts.set(s.seat, round4(boost));
    effectiveDissent += s.confidence * boost;
    const rateTxt =
      rate === null
        ? `no usable track record (needs ${cfg.dissent.minSamples} samples)`
        : `hit ${Math.round(rate * 100)}% vs agreeing ${Math.round(baseline * 100)}%`;
    parts.push(`'${s.seat}' conf ${fmt(s.confidence)} (${rateTxt}) -> weight x${fmt(boost)}`);
  }

  const agreeConf = sum(agree.map((s) => s.confidence));
  const total = agreeConf + effectiveDissent;
  const share = total > 0 ? effectiveDissent / total : 0;
  const penalty = round4(clamp01(cfg.dissent.penalty * share));
  const reason = `dissent: ${parts.join("; ")} — confidence x${fmt(1 - penalty)}`;
  return { penalty, boosts, reason };
}

/**
 * Cost check: expected gross edge (target distance x hit probability) must
 * cover the round-trip fee charged on the leveraged notional, plus a margin.
 * The edge and the fee are both fractions of the traded notional, so the
 * ratio is leverage-invariant; leverage only drives the dollar report.
 */
function evaluateCost(
  setup: SetupMetrics,
  cfg: RubricConfig,
): { ok: boolean; expectedEdgePct: number | null; requiredPct: number | null; notionalUsd: number | null; reason: string } {
  const feeRate = typeof setup.feeRatePerSide === "number" && Number.isFinite(setup.feeRatePerSide) ? setup.feeRatePerSide : cfg.cost.feeRatePerSide;
  const roundTripPct = feeRate * 2 * 100;
  const requiredPct = roundTripPct + cfg.cost.edgeMarginPct;

  const margin = typeof setup.marginUsd === "number" && Number.isFinite(setup.marginUsd) ? setup.marginUsd : null;
  const leverage = typeof setup.leverage === "number" && Number.isFinite(setup.leverage) ? setup.leverage : null;
  const notionalUsd = margin !== null && leverage !== null && margin > 0 && leverage > 0 ? margin * leverage : null;

  if (!cfg.cost.enabled) {
    return {
      ok: true,
      expectedEdgePct: null,
      requiredPct: null,
      notionalUsd,
      reason: "cost: rule disabled by config",
    };
  }

  const target = typeof setup.targetDistancePct === "number" && Number.isFinite(setup.targetDistancePct) ? setup.targetDistancePct : null;
  const hitProb = typeof setup.hitProbability === "number" && Number.isFinite(setup.hitProbability) ? clamp01(setup.hitProbability) : null;

  if (target === null || hitProb === null || target <= 0) {
    return {
      ok: false,
      expectedEdgePct: null,
      requiredPct: round4(requiredPct),
      notionalUsd,
      reason: `cost: cannot evaluate — ${target === null ? "target distance unknown" : "hit probability unknown"} — REJECT (fail closed)`,
    };
  }

  const expectedEdgePct = target * hitProb;
  const ok = expectedEdgePct >= requiredPct;
  const notionalTxt =
    notionalUsd !== null
      ? ` on $${notionalUsd.toFixed(0)} notional${margin !== null && leverage !== null ? ` (${leverage}x on $${margin.toFixed(0)} margin)` : ""}`
      : " per $1 of notional";
  const reason =
    `cost: expected edge ${fmt(expectedEdgePct)}% vs round-trip fee ${fmt(roundTripPct)}%${notionalTxt}` +
    ` + margin ${fmt(cfg.cost.edgeMarginPct)}% = ${fmt(requiredPct)}% — ${ok ? "PASS" : "REJECT"}`;
  return { ok, expectedEdgePct: round4(expectedEdgePct), requiredPct: round4(requiredPct), notionalUsd, reason };
}

/** Volatility guard: ATR outside a sane band is downgraded or rejected. */
function evaluateVolatility(
  atrPct: number | null,
  cfg: RubricConfig,
): { action: "pass" | "downgrade" | "reject"; factor: number; reason: string } {
  if (!cfg.volatility.enabled) {
    return { action: "pass", factor: 1, reason: "volatility: rule disabled by config" };
  }
  if (atrPct === null || !Number.isFinite(atrPct)) {
    return { action: "pass", factor: 1, reason: "volatility: ATR unknown — band not evaluated" };
  }
  const band = `[${fmt(cfg.volatility.minAtrPct)}%, ${fmt(cfg.volatility.maxAtrPct)}%]`;
  if (atrPct < cfg.volatility.minAtrPct) {
    const action = cfg.volatility.deadAction;
    return {
      action,
      factor: action === "downgrade" ? clamp01(cfg.volatility.downgradeFactor) : 0,
      reason:
        action === "reject"
          ? `volatility: ATR ${fmt(atrPct)}% below band ${band} — too dead to pay — REJECT`
          : `volatility: ATR ${fmt(atrPct)}% below band ${band} — too dead to pay — downgraded (tier cap ${cfg.volatility.downgradeTier}, confidence x${fmt(cfg.volatility.downgradeFactor)})`,
    };
  }
  if (atrPct > cfg.volatility.maxAtrPct) {
    const action = cfg.volatility.wildAction;
    return {
      action,
      factor: action === "downgrade" ? clamp01(cfg.volatility.downgradeFactor) : 0,
      reason:
        action === "reject"
          ? `volatility: ATR ${fmt(atrPct)}% above band ${band} — too wild to survive fees — REJECT`
          : `volatility: ATR ${fmt(atrPct)}% above band ${band} — too wild — downgraded (tier cap ${cfg.volatility.downgradeTier}, confidence x${fmt(cfg.volatility.downgradeFactor)})`,
    };
  }
  return { action: "pass", factor: 1, reason: `volatility: ATR ${fmt(atrPct)}% within band ${band}` };
}

/* ------------------------------------------------------------------ */
/* The rubric                                                          */
/* ------------------------------------------------------------------ */

/**
 * Apply the rubric to a committee's ballots. Pure — the input is never
 * mutated and the same input always yields the same decision.
 *
 * Order of work: seats -> consensus -> dissent -> quality -> cost ->
 * volatility -> final confidence -> tier -> verdict.
 */
export function applyRubric(input: RubricInput, overrides?: RubricOverrides | null): RubricDecision {
  const cfg = resolveRubricConfig(overrides);
  const reasons: string[] = [];

  const seats = normalizeSeats(input?.seats ?? []);
  const setup: SetupMetrics = input?.setup ?? {};
  const stats: ModelStats = input?.modelStats ?? {};

  /* RULE 1 — hard veto: blocks outright, never outvoted. */
  const vetoing = seats.filter((s) => s.veto);
  const vetoed = vetoing.length > 0 && cfg.veto.enabled;
  if (vetoing.length > 0) {
    reasons.push(
      cfg.veto.enabled
        ? `veto: ${vetoing.map((v) => `'${v.seat}' vetoed — ${v.vetoReason}`).join("; ")} — trade blocked, a veto is never outvoted`
        : `veto: ${vetoing.map((v) => `'${v.seat}'`).join(", ")} ignored (veto rule disabled by config)`,
    );
  } else {
    reasons.push("veto: no seat vetoed");
  }

  /* Consensus — the committee's own aggregate, before any rubric rule. */
  const directional = seats.filter((s) => !s.veto && s.side !== "flat" && s.confidence > 0);
  const longConf = sum(directional.filter((s) => s.side === "long").map((s) => s.confidence));
  const shortConf = sum(directional.filter((s) => s.side === "short").map((s) => s.confidence));
  const majority: TradeSide = longConf > shortConf ? "long" : shortConf > longConf ? "short" : "flat";
  const agree = majority === "flat" ? [] : directional.filter((s) => s.side === majority);
  const dissent = majority === "flat" ? [] : directional.filter((s) => s.side !== majority);
  const abstainSeats = seats.filter((s) => s.veto || s.side === "flat" || s.confidence <= 0).map((s) => s.seat);

  const agreeConf = sum(agree.map((s) => s.confidence));
  const dissentConf = sum(dissent.map((s) => s.confidence));
  const totalConf = agreeConf + dissentConf;
  const agreementRatio = totalConf > 0 ? agreeConf / totalConf : 0;
  const conviction = agree.length > 0 ? agreeConf / agree.length : 0;
  const consensusScore = round4(agreementRatio * conviction);

  /* RULE 6 — dissent (information, not a veto). */
  const dissentEval = evaluateDissent(agree, dissent, stats, cfg);
  reasons.push(dissentEval.reason);

  /* RULE 5 — quality multiplier. */
  const qualityEval = evaluateQuality(setup, cfg);
  reasons.push(qualityEval.reason);

  /* RULE 3 — cost check. */
  const costEval = evaluateCost(setup, cfg);
  reasons.push(costEval.reason);

  /* RULE 4 — volatility guard. */
  const volEval = evaluateVolatility(
    typeof setup.atrPct === "number" && Number.isFinite(setup.atrPct) ? setup.atrPct : null,
    cfg,
  );
  reasons.push(volEval.reason);

  /* RULE 2 — confidence floor. */
  const floorOk =
    !cfg.floor.enabled || (consensusScore >= cfg.floor.minConsensus && agree.length >= cfg.floor.minSeats);
  reasons.push(
    cfg.floor.enabled
      ? `floor: consensus ${fmt(consensusScore)} vs floor ${fmt(cfg.floor.minConsensus)}, ${agree.length} agreeing seat(s) vs min ${cfg.floor.minSeats}`
      : "floor: rule disabled by config",
  );

  /* Final confidence: consensus x (1 - dissent) x quality x volatility. */
  const confidence = round4(consensusScore * (1 - dissentEval.penalty) * qualityEval.multiplier * volEval.factor);

  /* RULE 7 — tier + size multiplier. */
  let tier = tierForConfidence(confidence, cfg);
  if (volEval.action === "downgrade" && TIER_RANK[tier] > TIER_RANK[cfg.volatility.downgradeTier]) {
    tier = cfg.volatility.downgradeTier;
  }
  const sizeMultiplier = tier === "REJECT" ? 0 : cfg.tierMultipliers[tier];
  reasons.push(
    `tier: ${tier} (final confidence ${fmt(confidence)}) — size x${fmt(sizeMultiplier, 2)}`,
  );

  /* Verdict precedence: veto -> floor -> cost -> volatility -> tier. */
  let verdict: RubricVerdict;
  let reason: string;
  if (vetoed) {
    verdict = "REJECT";
    reason = `VETO — ${vetoing.map((v) => `'${v.seat}': ${v.vetoReason}`).join("; ")}`;
  } else if (!floorOk) {
    verdict = "FLAT";
    const why =
      consensusScore < cfg.floor.minConsensus
        ? `consensus ${fmt(consensusScore)} below floor ${fmt(cfg.floor.minConsensus)}`
        : `only ${agree.length} agreeing seat(s), need ${cfg.floor.minSeats}`;
    reason = `FLAT — ${why}`;
  } else if (!costEval.ok) {
    verdict = "REJECT";
    reason = `REJECT — expected edge does not cover the round-trip fee plus margin`;
  } else if (volEval.action === "reject") {
    verdict = "REJECT";
    reason = `REJECT — ATR outside the sane band`;
  } else if (tier === "REJECT") {
    verdict = "REJECT";
    reason = `REJECT — final confidence ${fmt(confidence)} below the PROBE floor ${fmt(cfg.tiers.PROBE)}`;
  } else {
    verdict = "APPROVE";
    reason = `APPROVE — ${tier} at final confidence ${fmt(confidence)}, size x${fmt(sizeMultiplier, 2)}`;
  }

  if (verdict !== "APPROVE") {
    tier = "REJECT";
  }

  const breakdown: SeatBreakdown[] = seats.map((s) => {
    const stance: SeatStance = s.veto
      ? "veto"
      : s.side === "flat" || s.confidence <= 0
        ? "abstain"
        : majority === "flat"
          ? "abstain"
          : s.side === majority
            ? "agree"
            : "dissent";
    return {
      seat: s.seat,
      side: s.side,
      confidence: s.confidence,
      stance,
      veto: s.veto,
      dissentBoost: dissentEval.boosts.get(s.seat) ?? 1,
      reason: s.reason,
    };
  });

  return {
    verdict,
    tier,
    sizeMultiplier: verdict === "APPROVE" ? sizeMultiplier : 0,
    side: majority,
    confidence,
    consensusScore,
    qualityMultiplier: qualityEval.multiplier,
    dissentPenalty: dissentEval.penalty,
    volatilityFactor: volEval.factor,
    expectedEdgePct: costEval.expectedEdgePct,
    requiredEdgePct: costEval.requiredPct,
    notionalUsd: costEval.notionalUsd,
    vetoed,
    vetoSeats: vetoing.map((s) => s.seat),
    reason,
    reasons,
    breakdown,
    agreeSeats: agree.map((s) => s.seat),
    dissentSeats: dissent.map((s) => s.seat),
    abstainSeats,
  };
}
