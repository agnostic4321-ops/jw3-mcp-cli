/**
 * `jw3 committee --pair X` — the multi-model committee engine (READ-ONLY).
 *
 * A hedge-fund desk for one proposed trade: six seats each read the tape
 * from a different angle, argue a position, and the committee aggregates
 * their arguments into one verdict. The committee is allowed to say NO —
 * a seat can hard-veto, and a veto ends the debate (no trade, size 0).
 *
 * SEATS (all pure functions of `CommitteeContext` → `CommitteeSeatOpinion`):
 *   structure        tape shape: higher-highs vs lower-lows, distance from
 *                    the 24h high/low, ATR regime. Uses `jevToFeatures`
 *                    (decide.ts) for the JEV 7-timeframe structure leg.
 *   momentum         multi-timeframe trend agreement (1h/4h/1d) plus the
 *                    model legs: `combineWeightedVote` (vote.ts) over
 *                    `jevToSignal`/`kronosToSignal` ballots and
 *                    `combineOracleVote` (oracle.ts) over the oracle legs
 *                    (`layaToSignal`).
 *   flow             volume confirmation + top-5 book imbalance from the
 *                    public depth20 read (`spikeImbalance`).
 *   mean_reversion   stretch vs VWAP/EMA, Wilder RSI extreme, z-score vs
 *                    the recent range (rsiWilder/vwapCumulative).
 *   event_risk       macro blackout windows, funding rate, session
 *                    time-of-day, day-change vetoes (GATE).
 *   execution        spread/liquidity quality and fee drag as a fraction
 *                    of the stop distance (GATE).
 *
 * VERDICT ENUM: "LONG" | "SHORT" | "FLAT" | "VETO".
 *   LONG/SHORT — directional consensus cleared the threshold and no veto.
 *   FLAT       — no consensus, too few voters, or a gate softly blocked.
 *   VETO       — at least one seat hard-vetoed. No trade, size 0.
 *
 * SEAT ROLES: "directional" seats vote on the DIRECTION (their signed
 * score feeds the consensus); "gate" seats never pick a side — they
 * endorse or kill the proposal. A gate's score is signed along the
 * PROPOSED side (positive support = good), and its `support` (0..1)
 * scales the consensus and the final size. A gate that abstains never
 * blocks (fail-open); a gate that vetoes always blocks (fail-closed).
 *
 * A seat that throws abstains — it never blocks the committee. Seats are
 * injectable (`runCommittee(ctx, { seats })`), so a seat can be replaced,
 * disabled (drop it from the list), or unit-tested with fabricated data.
 *
 * Exit codes: 0 = actionable (LONG/SHORT), 1 = no trade (FLAT),
 * 2 = usage error, 3 = VETO (blocked by a seat).
 */
import { resolvePat } from "../config.js";
import {
  btcFeeVeto,
  bounceRequiredVeto,
  cpiBlackout,
  extendedDropVeto,
  utcMinutes,
  type PrefilterCtx,
} from "../blocking-rules.js";
import {
  futuresContractSpec,
  futuresDepth20,
  futuresFade,
  futuresKlinesRaw,
  futuresTickerFull,
  spikeImbalance,
  spikeNotionals,
  spikeSpreadBps,
} from "../kucoin.js";
import { fetchJevTrend, type TrendVerdict } from "./analyze.js";
import { fetchKronosVerdict, type ForecastVerdict } from "./forecast.js";
import { jevToFeatures, type LayaVerdict } from "./decide.js";
import { klinesSymbolForPair, parseKlineRows, rsiWilder, vwapCumulative, type KlineCandle } from "./klines.js";
import { combineOracleVote, layaToSignal, type OracleSignal, type OracleSkill } from "./oracle.js";
import {
  combineWeightedVote,
  jevToSignal,
  kronosToSignal,
  normalizeVotePair,
  validateVotePair,
  DEFAULT_WEIGHTS,
  type SkillId,
  type SkillSignal,
} from "./vote.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CommitteeSide = "long" | "short";

/** The final verdict enum. Exactly these four strings, nothing else. */
export type CommitteeVerdict = "LONG" | "SHORT" | "FLAT" | "VETO";

export type CommitteeSeatId = "structure" | "momentum" | "flow" | "mean_reversion" | "event_risk" | "execution";

export type CommitteeSeatRole = "directional" | "gate";

export type CommitteeTimeframe = "1h" | "4h" | "1d";

/** A position on the proposed trade — what a seat argues for. */
export type CommitteePosition = {
  pair: string;
  side: CommitteeSide;
  entry: number;
  stop: number;
  target: number;
  /** Base units. */
  size: number;
};

export type CommitteeBook = {
  /** Top-5 bid notional (USD). */
  bidUsd?: number | null;
  /** Top-5 ask notional (USD). */
  askUsd?: number | null;
  /** (bid − ask) / (bid + ask) ∈ [-1, 1]; positive = bid-heavy. */
  imbalance?: number | null;
  spreadBps?: number | null;
};

export type CommitteeBlackout = {
  name: string;
  /** Minutes since UTC midnight, inclusive. */
  startMin: number;
  /** Minutes since UTC midnight, exclusive. */
  endMin: number;
};

/** Model legs — assembled by the caller (or by `jw3 oracle` output). */
export type CommitteeModelLegs = {
  /** vote.ts ballots (jevToSignal / kronosToSignal / rfdetrSignal). */
  voteSignals?: SkillSignal[];
  voteWeights?: Record<SkillId, number>;
  /** oracle.ts legs (layaToSignal / rfdetrOracleSignal). */
  oracleSignals?: OracleSignal[];
  oracleWeights?: Record<OracleSkill, number>;
};

/**
 * RAW model verdicts — the committee maps them onto ballots through the
 * existing pure helpers (jevToSignal / kronosToSignal / layaToSignal) so
 * the committee and `jw3 vote` / `jw3 oracle` never disagree about what a
 * model said.
 */
export type CommitteeRawVerdicts = {
  jev?: TrendVerdict | null;
  kronos?: ForecastVerdict | null;
  laya?: LayaVerdict | null;
  voteWeights?: Record<SkillId, number>;
  oracleWeights?: Record<OracleSkill, number>;
};

/**
 * Pure: raw model verdicts → the ballots the momentum seat combines.
 * Uses the SAME helpers `jw3 vote` and `jw3 oracle` use, so a model that
 * abstains for the CLI abstains for the committee too.
 */
export function committeeModelLegs(raw: CommitteeRawVerdicts): CommitteeModelLegs {
  const voteSignals: SkillSignal[] = [
    jevToSignal(raw.jev ?? null),
    kronosToSignal(raw.kronos ?? null),
  ];
  const oracleSignals: OracleSignal[] = [layaToSignal(raw.laya ?? null)];
  return {
    voteSignals,
    voteWeights: raw.voteWeights ?? DEFAULT_WEIGHTS,
    oracleSignals,
    oracleWeights: raw.oracleWeights ?? { kronos: 0.5, laya: 1.0, rfdetr: 0 },
  };
}

export type CommitteeMarket = {
  pair: string;
  last: number;
  /** Candles per timeframe (1h/4h/1d). */
  timeframes: { tf: CommitteeTimeframe; candles: KlineCandle[] }[];
  high24?: number | null;
  low24?: number | null;
  /** ATR% on the 1h window. */
  atrPct?: number | null;
  vwap?: number | null;
  ema20?: number | null;
  /** Wilder RSI(14), 0..100. */
  rsi?: number | null;
  /** Recent/prior volume ratio. */
  volRatio?: number | null;
  volSlope?: "up" | "down" | null;
  book?: CommitteeBook | null;
  /** Funding rate in % per settlement. */
  fundingPct?: number | null;
  /** Trailing session change in %. */
  dayChgPct?: number | null;
  sessionLow?: number | null;
  /** Calendar-verified blackout windows (UTC minutes). */
  blackouts?: CommitteeBlackout[];
  /**
   * True when today is a real macro-release day. The built-in CPI window
   * only vetoes on a release day — a daily time-window veto mislabels
   * non-event days.
   */
  macroEventToday?: boolean;
  /** Epoch ms for the time-of-day rules. */
  nowMs?: number;
  /** Account context for the shared BTC fee rule (fail-closed without it). */
  accountUsd?: number;
  notionalUsd?: number;
  feeTierOk?: boolean;
  /** JEV 7-timeframe verdict (structure leg). */
  jev?: TrendVerdict | null;
  /** Model legs (momentum leg). */
  models?: CommitteeModelLegs;
};

export type CommitteeParams = {
  /** |consensus| at/above this decides LONG/SHORT. */
  consensusThreshold: number;
  /** Minimum share of directional weight that must agree with the consensus. */
  minAgreement: number;
  /** Minimum voting directional seats. */
  minVoters: number;
  /** Size rounding step (lot size); 0 = no rounding. */
  sizeStep: number;
  structure: {
    swingWindow: number;
    /** ATR% treated as a full-strength trend regime. */
    atrRefPct: number;
  };
  momentum: {
    emaPeriod: number;
    tfWeights: Record<CommitteeTimeframe, number>;
    /** % EMA move over the lookback that reads as a full-strength slope. */
    slopeRefPct: number;
    /** Leg weights: candles vs the model legs. */
    legWeights: { mtf: number; vote: number; oracle: number };
  };
  flow: {
    /** Imbalance that reads as full conviction. */
    imbalanceFull: number;
    volRatioCap: number;
    /** Below this volume ratio the flow read abstains. */
    minVolRatio: number;
  };
  meanReversion: {
    /** % distance from VWAP/EMA that reads as a full stretch. */
    vwapRefPct: number;
    /** RSI half-band (50 ± this = full stretch). */
    rsiBand: number;
    /** z-score that reads as a full stretch. */
    zRef: number;
  };
  eventRisk: {
    /** |funding %| that reads as crowded. */
    fundingVetoPct: number;
    /** UTC minutes of day where both directions are vetoed. */
    avoidUtcMinutes: number[];
    /** UTC minutes of day with thin liquidity (support penalty). */
    thinUtcMinutes: number[];
  };
  execution: {
    /** Round-trip taker fee in % (0.06%/side → 0.12%). */
    roundTripFeePct: number;
    /** Fee drag (cost ÷ stop distance) that hard-vetoes. */
    feeDragVeto: number;
    /** Maximum acceptable spread in bps. */
    maxSpreadBps: number;
    /** Round-trip cost may not exceed this share of the target move. */
    edgeCostCap: number;
    /** Top-5 book notional (USD) below which liquidity support decays. */
    minBookNotionalUsd: number;
  };
};

export type CommitteeParamsOverride = {
  consensusThreshold?: number;
  minAgreement?: number;
  minVoters?: number;
  sizeStep?: number;
  structure?: Partial<CommitteeParams["structure"]>;
  momentum?: Partial<Omit<CommitteeParams["momentum"], "tfWeights">> & {
    tfWeights?: Partial<Record<CommitteeTimeframe, number>>;
  };
  flow?: Partial<CommitteeParams["flow"]>;
  meanReversion?: Partial<CommitteeParams["meanReversion"]>;
  eventRisk?: Partial<CommitteeParams["eventRisk"]>;
  execution?: Partial<CommitteeParams["execution"]>;
};

export type CommitteeContext = {
  /** The trade under debate. */
  proposal: CommitteePosition;
  /** The market snapshot every seat reads. */
  market: CommitteeMarket;
  /** Thresholds/knobs (already merged with the defaults). */
  params: CommitteeParams;
};

export type CommitteeVeto = {
  seat: CommitteeSeatId;
  rule: string;
  detail: string;
};

/** What a seat returns. `score` is signed: + argues long, − argues short. */
export type CommitteeSeatOpinion = {
  /** Signed conviction in [-1,1]. */
  score: number;
  /** The position this seat argues for (null = no position). */
  position?: CommitteePosition | null;
  /** True when the seat has no usable read (it neither votes nor blocks). */
  abstain?: boolean;
  reason: string;
  /** Hard veto — the committee returns VETO when any seat vetoes. */
  veto?: { rule: string; detail: string } | null;
  /** Gate seats only: 0..1 endorsement of the proposal. */
  support?: number | null;
  /** Diagnostics surfaced in the breakdown. */
  metrics?: Record<string, number | string | null>;
};

export type CommitteeSeat = {
  id: CommitteeSeatId;
  role: CommitteeSeatRole;
  weight: number;
  evaluate: (ctx: CommitteeContext) => CommitteeSeatOpinion;
};

export type CommitteeSeatBreakdown = {
  seat: CommitteeSeatId;
  role: CommitteeSeatRole;
  weight: number;
  score: number;
  /** Weighted contribution to the directional consensus (0 for gates). */
  contribution: number;
  abstain: boolean;
  support: number | null;
  veto: { rule: string; detail: string } | null;
  reason: string;
  position: CommitteePosition | null;
  metrics: Record<string, number | string | null>;
};

export type CommitteeResult = {
  verdict: CommitteeVerdict;
  /** Final consensus in [-1,1] (directional score × gate support). */
  score: number;
  /** Directional consensus before the gate factor. */
  directionalScore: number;
  /** Share of directional weight agreeing with the consensus. */
  agreement: number;
  /** Weakest gate support (1 = every gate fully onside). */
  gateSupport: number;
  voters: number;
  seats: CommitteeSeatBreakdown[];
  vetoes: CommitteeVeto[];
  /** The sized trade (null for FLAT/VETO). */
  plan: CommitteePosition | null;
  reason: string;
};

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const COMMITTEE_SEATS: CommitteeSeatId[] = [
  "structure",
  "momentum",
  "flow",
  "mean_reversion",
  "event_risk",
  "execution",
];

export const DEFAULT_COMMITTEE_PARAMS: CommitteeParams = {
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
  eventRisk: { fundingVetoPct: 0.1, avoidUtcMinutes: [], thinUtcMinutes: [] },
  execution: {
    roundTripFeePct: 0.12,
    feeDragVeto: 1 / 3,
    maxSpreadBps: 15,
    edgeCostCap: 0.6,
    minBookNotionalUsd: 5000,
  },
};

export const DEFAULT_SEAT_WEIGHTS: Record<CommitteeSeatId, number> = {
  structure: 1.0,
  momentum: 1.2,
  flow: 0.9,
  mean_reversion: 0.6,
  event_risk: 1.0,
  execution: 1.0,
};

/* ------------------------------------------------------------------ */
/* Pure math helpers                                                   */
/* ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo;

const clampScore = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, -1), 1) : 0);

const signOf = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Pure: EMA series (null until the seed period is filled). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i] as number;
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Pure: Wilder ATR as % of the last close. Null when the window is short. */
export function atrPercent(candles: KlineCandle[], period = 14): number | null {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i <= period; i++) {
    const c = candles[i] as KlineCandle;
    const p = candles[i - 1] as KlineCandle;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  const last = (candles[candles.length - 1] as KlineCandle).close;
  if (!(atr > 0) || !(last > 0)) return null;
  return (atr / last) * 100;
}

/** Pure: z-score of the last value against the trailing window. */
export function zScore(values: number[], period = 20): number | null {
  if (!Array.isArray(values) || values.length < period) return null;
  const win = values.slice(-period);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length;
  const sd = Math.sqrt(variance);
  const last = values[values.length - 1] as number;
  if (!(sd > 0)) return null;
  return (last - mean) / sd;
}

/** Pure: true when `minutes` (UTC minutes-of-day) falls inside the window. */
export function inUtcWindow(minutes: number, startMin: number, endMin: number): boolean {
  if (!Number.isFinite(minutes) || !Number.isFinite(startMin) || !Number.isFinite(endMin)) return false;
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  // window wraps past midnight
  return minutes >= startMin || minutes < endMin;
}

/**
 * Pure: mirror a position onto the other side (levels mirrored around the
 * entry). Used when the committee flips the proposal's direction.
 */
export function mirrorPosition(p: CommitteePosition, side: CommitteeSide): CommitteePosition {
  if (p.side === side) return { ...p };
  const stop = 2 * p.entry - p.stop;
  const target = 2 * p.entry - p.target;
  return {
    ...p,
    side,
    stop: side === "long" ? Math.min(stop, p.entry) : Math.max(stop, p.entry),
    target: side === "long" ? Math.max(target, p.entry) : Math.min(target, p.entry),
  };
}

/** Pure: floor a size onto a lot step (0 = no rounding). */
export function floorToStep(size: number, step: number): number {
  if (!Number.isFinite(size)) return 0;
  if (!(step > 0)) return size;
  return Math.floor((size + 1e-9) / step) * step;
}

/** Pure: candles for one timeframe (empty when the leg is missing). */
export function candlesFor(market: CommitteeMarket, tf: CommitteeTimeframe): KlineCandle[] {
  const leg = (market.timeframes ?? []).find((t) => t.tf === tf);
  return leg?.candles ?? [];
}

const lastClose = (c: KlineCandle[]): number | null =>
  c.length > 0 ? (c[c.length - 1] as KlineCandle).close : null;

/* ------------------------------------------------------------------ */
/* Seats                                                               */
/* ------------------------------------------------------------------ */

const ABSTAIN = (reason: string): CommitteeSeatOpinion => ({
  score: 0,
  position: null,
  abstain: true,
  reason,
  veto: null,
  support: null,
  metrics: {},
});

/** Position mirroring the proposal onto the seat's argued side. */
const positionOn = (proposal: CommitteePosition, side: CommitteeSide): CommitteePosition =>
  mirrorPosition(proposal, side);

/**
 * STRUCTURE — does the tape support the direction?
 * Higher-highs vs lower-lows on the 1h window, distance from the 24h
 * high/low, and the ATR regime (a dead tape halves the read). The JEV
 * 7-timeframe verdict rides along as the structure leg (jevToFeatures).
 */
export const structureSeat: CommitteeSeat = {
  id: "structure",
  role: "directional",
  weight: DEFAULT_SEAT_WEIGHTS.structure,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const candles = candlesFor(market, "1h");
    const need = params.structure.swingWindow + 1;
    if (candles.length < need) {
      return ABSTAIN(`thin tape — ${candles.length} 1h candles, need ${need}`);
    }
    const win = candles.slice(-need);
    let higherHighs = 0;
    let lowerLows = 0;
    for (let i = 1; i < win.length; i++) {
      const c = win[i] as KlineCandle;
      const p = win[i - 1] as KlineCandle;
      if (c.high > p.high) higherHighs++;
      if (c.low < p.low) lowerLows++;
    }
    const swings = higherHighs + lowerLows;
    const swingBias = swings > 0 ? (higherHighs - lowerLows) / swings : 0;

    let rangeBias = 0;
    const hi = market.high24;
    const lo = market.low24;
    if (typeof hi === "number" && typeof lo === "number" && hi > lo && market.last > 0) {
      rangeBias = (clamp((market.last - lo) / (hi - lo), 0, 1) - 0.5) * 2;
    }

    const jevFeatures = jevToFeatures(market.jev ?? null);
    const jevScore =
      jevFeatures && !jevFeatures.uncertain && jevFeatures.side !== "flat"
        ? (jevFeatures.side === "long" ? 1 : -1) * jevFeatures.agreement
        : 0;

    const atrFactor =
      typeof market.atrPct === "number" && Number.isFinite(market.atrPct)
        ? clamp(market.atrPct / params.structure.atrRefPct, 0, 1)
        : 0.5;

    let score = 0.45 * swingBias + 0.25 * rangeBias + 0.3 * jevScore;
    score *= 0.5 + 0.5 * atrFactor;
    score = clampScore(score);

    if (Math.abs(score) < 0.05) {
      return {
        score: 0,
        position: null,
        abstain: true,
        reason: "no clean structure — swings and range position disagree",
        veto: null,
        support: null,
        metrics: { higherHighs, lowerLows, swingBias, rangeBias, jevScore, atrFactor },
      };
    }
    const side: CommitteeSide = score > 0 ? "long" : "short";
    return {
      score,
      position: positionOn(proposal, side),
      abstain: false,
      reason: `${higherHighs} higher-highs vs ${lowerLows} lower-lows · ${
        rangeBias >= 0 ? "near" : "off"
      } the 24h range${jevFeatures ? ` · JEV ${jevFeatures.side.toUpperCase()} ${(jevFeatures.agreement * 100).toFixed(0)}%` : ""}`,
      veto: null,
      support: null,
      metrics: { higherHighs, lowerLows, swingBias, rangeBias, jevScore, atrFactor, atrPct: market.atrPct ?? null },
    };
  },
};

/**
 * MOMENTUM — multi-timeframe trend agreement (1h/4h/1d) plus the model
 * legs. The candle leg scores each timeframe off its EMA slope and the
 * price's distance from that EMA (in ATRs); the model legs come straight
 * from the existing combiners (combineWeightedVote over the vote.ts
 * ballots, combineOracleVote over the oracle.ts legs).
 */
export const momentumSeat: CommitteeSeat = {
  id: "momentum",
  role: "directional",
  weight: DEFAULT_SEAT_WEIGHTS.momentum,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const legs: { name: string; score: number; weight: number }[] = [];
    const tfDetail: string[] = [];

    // --- candle leg: 1h / 4h / 1d agreement -------------------------
    let num = 0;
    let den = 0;
    for (const tf of ["1h", "4h", "1d"] as CommitteeTimeframe[]) {
      const w = params.momentum.tfWeights[tf] ?? 0;
      if (!(w > 0)) continue;
      const candles = candlesFor(market, tf);
      if (candles.length < params.momentum.emaPeriod + 6) continue;
      const closes = candles.map((c) => c.close);
      const emas = emaSeries(closes, params.momentum.emaPeriod);
      const emaNow = emas[emas.length - 1];
      const emaPast = emas[emas.length - 6];
      const close = lastClose(candles);
      if (emaNow === null || emaPast === null || close === null || !(emaPast > 0)) continue;
      const slopePct = ((emaNow - emaPast) / emaPast) * 100;
      const slopeScore = clamp(slopePct / params.momentum.slopeRefPct, -1, 1);
      const atrPct = atrPercent(candles);
      const atrDistance = atrPct !== null ? (atrPct / 100) * close : 0;
      const priceScore = atrDistance > 0 ? clamp((close - emaNow) / atrDistance, -1, 1) : 0;
      const bias = 0.5 * (slopeScore + priceScore);
      num += bias * w;
      den += w;
      tfDetail.push(`${tf} ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}`);
    }
    if (den > 0) {
      const raw = num / den;
      // Damp the leg when the timeframes disagree with each other.
      let agree = 0;
      let total = 0;
      for (const tf of ["1h", "4h", "1d"] as CommitteeTimeframe[]) {
        const w = params.momentum.tfWeights[tf] ?? 0;
        const candles = candlesFor(market, tf);
        if (!(w > 0) || candles.length < params.momentum.emaPeriod + 6) continue;
        const closes = candles.map((c) => c.close);
        const emas = emaSeries(closes, params.momentum.emaPeriod);
        const emaNow = emas[emas.length - 1];
        const emaPast = emas[emas.length - 6];
        if (emaNow === null || emaPast === null || !(emaPast > 0)) continue;
        const bias = clamp(((emaNow - emaPast) / emaPast) * 100 / params.momentum.slopeRefPct, -1, 1);
        total += w;
        if (signOf(bias) === signOf(raw)) agree += w;
      }
      const agreeFactor = total > 0 ? agree / total : 0.5;
      legs.push({ name: "mtf", score: raw * agreeFactor, weight: params.momentum.legWeights.mtf });
    }

    // --- model legs: vote.ts ballots + oracle.ts legs ---------------
    const models = market.models ?? {};
    if (models.voteSignals && models.voteSignals.length > 0) {
      const v = combineWeightedVote(models.voteSignals, models.voteWeights ?? DEFAULT_WEIGHTS);
      if (v.voters > 0) legs.push({ name: "vote", score: v.score, weight: params.momentum.legWeights.vote });
    }
    if (models.oracleSignals && models.oracleSignals.length > 0) {
      const o = combineOracleVote(models.oracleSignals, models.oracleWeights ?? { kronos: 0.5, laya: 1.0, rfdetr: 0 });
      if (o.voters > 0) legs.push({ name: "oracle", score: o.score, weight: params.momentum.legWeights.oracle });
    }

    if (legs.length === 0) {
      return ABSTAIN("no momentum read — no candles and no model legs");
    }
    const wsum = legs.reduce((a, l) => a + l.weight, 0);
    const score = clampScore(legs.reduce((a, l) => a + l.score * l.weight, 0) / (wsum > 0 ? wsum : 1));
    if (Math.abs(score) < 0.05) {
      return {
        score: 0,
        position: null,
        abstain: true,
        reason: "momentum legs disagree — no directional edge",
        veto: null,
        support: null,
        metrics: { legs: legs.map((l) => `${l.name}:${l.score.toFixed(2)}`).join(" ") },
      };
    }
    const side: CommitteeSide = score > 0 ? "long" : "short";
    return {
      score,
      position: positionOn(proposal, side),
      abstain: false,
      reason: tfDetail.length > 0 ? `trend agreement ${tfDetail.join(" · ")}` : "model legs agree on direction",
      veto: null,
      support: null,
      metrics: {
        legs: legs.map((l) => `${l.name}:${l.score.toFixed(2)}`).join(" "),
        timeframes: tfDetail.join(" · "),
      },
    };
  },
};

/**
 * FLOW — volume confirmation and book imbalance from the public depth20
 * read. A bid-heavy book (positive imbalance) is a long argument; fading
 * volume shrinks the read, and a dying tape makes the seat abstain.
 */
export const flowSeat: CommitteeSeat = {
  id: "flow",
  role: "directional",
  weight: DEFAULT_SEAT_WEIGHTS.flow,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const book = market.book ?? null;
    const imbalance = book?.imbalance;
    if (typeof imbalance !== "number" || !Number.isFinite(imbalance)) {
      return ABSTAIN("no book read — depth20 unavailable");
    }
    const volRatio = typeof market.volRatio === "number" && Number.isFinite(market.volRatio) ? market.volRatio : null;
    if (volRatio !== null && volRatio < params.flow.minVolRatio) {
      return ABSTAIN(`volume not confirming — ratio ${volRatio.toFixed(2)} below ${params.flow.minVolRatio}`);
    }
    const imbScore = clamp(imbalance / params.flow.imbalanceFull, -1, 1);
    const volFactor = volRatio === null ? 0.5 : clamp(volRatio, 0, params.flow.volRatioCap) / params.flow.volRatioCap;
    let score = imbScore * (0.4 + 0.6 * volFactor);
    if (market.volSlope === "down") score *= 0.7;
    score = clampScore(score);
    if (Math.abs(score) < 0.05) {
      return {
        score: 0,
        position: null,
        abstain: true,
        reason: "book is balanced — no flow edge",
        veto: null,
        support: null,
        metrics: { imbalance, volRatio, volFactor },
      };
    }
    const side: CommitteeSide = score > 0 ? "long" : "short";
    const top5 = (book?.bidUsd ?? 0) + (book?.askUsd ?? 0);
    return {
      score,
      position: positionOn(proposal, side),
      abstain: false,
      reason: `book ${imbalance >= 0 ? "bid" : "ask"}-heavy ${(imbalance * 100).toFixed(1)}%${volRatio !== null ? ` · vol x${volRatio.toFixed(2)}` : ""}`,
      veto: null,
      support: null,
      metrics: { imbalance, volRatio, volFactor, top5Usd: top5 },
    };
  },
};

/**
 * MEAN-REVERSION — stretch against VWAP/EMA, RSI extremes and the
 * z-score of the recent range. Contrarian by construction: a price
 * stretched to the upside argues for a short (negative score).
 */
export const meanReversionSeat: CommitteeSeat = {
  id: "mean_reversion",
  role: "directional",
  weight: DEFAULT_SEAT_WEIGHTS.mean_reversion,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const last = market.last;
    if (!(last > 0)) return ABSTAIN("no last price");
    const parts: { name: string; value: number; weight: number }[] = [];

    if (typeof market.vwap === "number" && market.vwap > 0) {
      const distPct = ((last - market.vwap) / market.vwap) * 100;
      parts.push({ name: "vwap", value: clamp(distPct / params.meanReversion.vwapRefPct, -1, 1), weight: 0.3 });
    }
    if (typeof market.ema20 === "number" && market.ema20 > 0) {
      const distPct = ((last - market.ema20) / market.ema20) * 100;
      parts.push({ name: "ema", value: clamp(distPct / params.meanReversion.vwapRefPct, -1, 1), weight: 0.2 });
    }
    if (typeof market.rsi === "number" && Number.isFinite(market.rsi)) {
      parts.push({ name: "rsi", value: clamp((market.rsi - 50) / params.meanReversion.rsiBand, -1, 1), weight: 0.25 });
    }
    const closes = candlesFor(market, "1h").map((c) => c.close);
    const z = zScore(closes, 20);
    if (z !== null) {
      parts.push({ name: "z", value: clamp(z / params.meanReversion.zRef, -1, 1), weight: 0.25 });
    }
    if (parts.length < 2) {
      return ABSTAIN("not enough stretch measures (need 2 of vwap/ema/rsi/z)");
    }
    const wsum = parts.reduce((a, p) => a + p.weight, 0);
    const stretch = parts.reduce((a, p) => a + p.value * p.weight, 0) / (wsum > 0 ? wsum : 1);
    const score = clampScore(-stretch);
    if (Math.abs(score) < 0.05) {
      return {
        score: 0,
        position: null,
        abstain: true,
        reason: "price sits at its mean — no reversion edge",
        veto: null,
        support: null,
        metrics: { stretch },
      };
    }
    const side: CommitteeSide = score > 0 ? "long" : "short";
    const detail = parts.map((p) => `${p.name} ${p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}`).join(" · ");
    return {
      score,
      position: positionOn(proposal, side),
      abstain: false,
      reason: `stretched ${score > 0 ? "down" : "up"} — ${detail}`,
      veto: null,
      support: null,
      metrics: { stretch, ...Object.fromEntries(parts.map((p) => [p.name, p.value])) },
    };
  },
};

/**
 * EVENT/RISK (gate) — macro blackout windows, funding rate, session
 * time-of-day and day-change vetoes. The seat never picks a side: it
 * endorses (support) or vetoes the proposal.
 *
 * Missing data never blocks (fail-open): an unpriced session low simply
 * skips the bounce rule. A hard blackout or a crowded funding rate does.
 */
export const eventRiskSeat: CommitteeSeat = {
  id: "event_risk",
  role: "gate",
  weight: DEFAULT_SEAT_WEIGHTS.event_risk,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const side = proposal.side;
    const dir = side === "long" ? 1 : -1;
    const nowMs = market.nowMs ?? Date.now();
    const minutes = utcMinutes(nowMs);
    const vetoes: { rule: string; detail: string }[] = [];
    const notes: string[] = [];

    // Calendar-verified blackout windows always apply.
    for (const bw of market.blackouts ?? []) {
      if (inUtcWindow(minutes, bw.startMin, bw.endMin)) {
        vetoes.push({
          rule: `blackout:${bw.name}`,
          detail: `${bw.name} blackout ${String(bw.startMin).padStart(4, "0")}-${String(bw.endMin).padStart(4, "0")}Z — no directional entries`,
        });
      }
    }
    // The built-in CPI window only vetoes on a real release day.
    if (market.macroEventToday && cpiBlackout(nowMs)) {
      vetoes.push({
        rule: "cpi_blackout",
        detail: "CPI blackout 11:30-13:30Z — post-CPI chop kills both directions",
      });
    }
    // Day-change vetoes (short side): no shorts into extended drops.
    if (side === "short") {
      if (extendedDropVeto(market.dayChgPct)) {
        vetoes.push({
          rule: "extended_drop",
          detail: `day down ${(market.dayChgPct as number).toFixed(2)}% — no shorts into extended drops`,
        });
      }
      if (typeof market.sessionLow === "number" && market.sessionLow > 0 && market.last > 0) {
        if (bounceRequiredVeto("short", market.last, market.sessionLow)) {
          const off = ((market.last - market.sessionLow) / market.sessionLow) * 100;
          vetoes.push({
            rule: "bounce_required",
            detail: `short needs +0.4% off the session low (at ${off.toFixed(2)}%) — never short into the flush`,
          });
        }
      } else {
        notes.push("session low unavailable — bounce rule unevaluated");
      }
    }
    // Funding: the crowded side pays. Veto a proposal into that crowd.
    const funding = market.fundingPct;
    if (typeof funding === "number" && Number.isFinite(funding)) {
      if (funding > params.eventRisk.fundingVetoPct && side === "long") {
        vetoes.push({
          rule: "funding_crowded_long",
          detail: `funding ${funding.toFixed(4)}% — longs pay into a crowded long book`,
        });
      }
      if (funding < -params.eventRisk.fundingVetoPct && side === "short") {
        vetoes.push({
          rule: "funding_crowded_short",
          detail: `funding ${funding.toFixed(4)}% — shorts pay into a crowded short book`,
        });
      }
    } else {
      notes.push("funding unavailable");
    }
    // BTC fee-unprofitable at minimum size on a small account (the shared
    // venue rule — the committee reuses it instead of re-deriving it).
    const feeCtx: PrefilterCtx = {
      symbol: market.pair,
      side,
      dayChgPct: market.dayChgPct ?? undefined,
      price: market.last > 0 ? market.last : undefined,
      sessionLow: market.sessionLow ?? undefined,
      accountUsd: market.accountUsd,
      notionalUsd: market.notionalUsd,
      feeTierOk: market.feeTierOk,
      nowMs,
    };
    if (btcFeeVeto(feeCtx.symbol, feeCtx)) {
      vetoes.push({
        rule: "btc_fee",
        detail: "BTC fee-unprofitable at minimum size on a small account — taker fees consume the edge",
      });
    }
    // Session time-of-day.
    if (params.eventRisk.avoidUtcMinutes.includes(minutes)) {
      vetoes.push({
        rule: "session_blackout",
        detail: `session blackout at ${String(minutes).padStart(4, "0")}Z — no directional entries`,
      });
    }
    const thin = params.eventRisk.thinUtcMinutes.includes(minutes);

    // Support: 1 minus the penalties (funding against us, thin liquidity).
    let support = 1;
    if (typeof funding === "number" && Number.isFinite(funding)) {
      const paying = (side === "long" && funding > 0) || (side === "short" && funding < 0);
      if (paying) support -= 0.5;
    }
    if (thin) support -= 0.3;
    support = clamp(support, 0, 1);

    const veto = vetoes.length > 0 ? (vetoes[0] as { rule: string; detail: string }) : null;
    return {
      score: dir * support,
      position: proposal,
      abstain: false,
      reason: veto
        ? `veto ${veto.rule}: ${veto.detail}`
        : `clear${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`,
      veto,
      support,
      metrics: {
        support,
        minutes,
        fundingPct: funding ?? null,
        dayChgPct: market.dayChgPct ?? null,
        vetoCount: vetoes.length,
      },
    };
  },
};

/**
 * EXECUTION (gate) — is the spread/liquidity good enough that fees do not
 * eat the edge? The hard rule is the fee drag: round-trip cost (taker fee
 * + the spread crossing) as a fraction of the stop distance. Above
 * FEE_DRAG_VETO (1/3) the trade is untradable and the seat vetoes.
 */
export const executionSeat: CommitteeSeat = {
  id: "execution",
  role: "gate",
  weight: DEFAULT_SEAT_WEIGHTS.execution,
  evaluate: (ctx: CommitteeContext): CommitteeSeatOpinion => {
    const { proposal, market, params } = ctx;
    const dir = proposal.side === "long" ? 1 : -1;
    const entry = proposal.entry;
    if (!(entry > 0)) return ABSTAIN("no entry price — proposal is malformed");
    const stopDist = Math.abs(entry - proposal.stop);
    const stopDistPct = (stopDist / entry) * 100;
    if (!(stopDistPct > 0)) {
      return {
        score: 0,
        position: null,
        abstain: false,
        reason: "veto: no_stop_distance — the proposal carries no stop",
        veto: { rule: "no_stop_distance", detail: "stop distance is zero — no defined risk to size against" },
        support: 0,
        metrics: { stopDistPct },
      };
    }
    const spreadBps = market.book?.spreadBps ?? null;
    const spreadPct = typeof spreadBps === "number" && Number.isFinite(spreadBps) ? spreadBps / 100 : 0;
    const costPct = params.execution.roundTripFeePct + spreadPct;
    const drag = costPct / stopDistPct;

    const vetoes: { rule: string; detail: string }[] = [];
    // The spread check comes FIRST: a too-wide spread is the root cause of
    // a fee drag, and naming the cause beats naming the symptom.
    if (typeof spreadBps === "number" && Number.isFinite(spreadBps) && spreadBps > params.execution.maxSpreadBps) {
      vetoes.push({
        rule: "spread_too_wide",
        detail: `spread ${spreadBps.toFixed(1)}bps above the ${params.execution.maxSpreadBps}bps ceiling`,
      });
    }
    if (drag > params.execution.feeDragVeto) {
      vetoes.push({
        rule: "fee_drag",
        detail: `fee drag ${(drag * 100).toFixed(0)}% of the stop distance (limit ${(params.execution.feeDragVeto * 100).toFixed(0)}%) — ${costPct.toFixed(3)}% cost vs a ${stopDistPct.toFixed(3)}% stop`,
      });
    }
    const targetMovePct = (Math.abs(proposal.target - entry) / entry) * 100;
    if (targetMovePct > 0 && costPct > targetMovePct * params.execution.edgeCostCap) {
      vetoes.push({
        rule: "fee_drag_edge",
        detail: `round-trip cost ${costPct.toFixed(3)}% eats ${((costPct / targetMovePct) * 100).toFixed(0)}% of the ${targetMovePct.toFixed(3)}% target`,
      });
    }
    const bookUsd = (market.book?.bidUsd ?? 0) + (market.book?.askUsd ?? 0);
    const liquidity =
      params.execution.minBookNotionalUsd > 0 && bookUsd > 0
        ? clamp(bookUsd / params.execution.minBookNotionalUsd, 0, 1)
        : 1;

    const veto = vetoes.length > 0 ? (vetoes[0] as { rule: string; detail: string }) : null;
    // Support stays full while the drag is inside the free zone (half the
    // veto limit), then decays linearly to 0 at the limit. A linear ramp
    // from zero would haircut the consensus for a drag that costs nothing.
    const halfLimit = params.execution.feeDragVeto / 2;
    const dragSupport =
      drag <= halfLimit ? 1 : clamp((params.execution.feeDragVeto - drag) / halfLimit, 0, 1);
    const support = clamp(dragSupport * liquidity, 0, 1);
    return {
      score: dir * support,
      position: proposal,
      abstain: false,
      reason: veto
        ? `veto ${veto.rule}: ${veto.detail}`
        : `cost ${costPct.toFixed(3)}% on a ${stopDistPct.toFixed(3)}% stop — drag ${(drag * 100).toFixed(0)}%`,
      veto,
      support,
      metrics: {
        support,
        feeDrag: drag,
        costPct,
        stopDistPct,
        targetMovePct,
        spreadBps: spreadBps ?? null,
        bookUsd,
        liquidity,
      },
    };
  },
};

/** The six seats, in debate order. */
export const DEFAULT_SEATS: CommitteeSeat[] = [
  structureSeat,
  momentumSeat,
  flowSeat,
  meanReversionSeat,
  eventRiskSeat,
  executionSeat,
];

/* ------------------------------------------------------------------ */
/* The committee                                                       */
/* ------------------------------------------------------------------ */

/**
 * Pure: deep-merge a params override onto the base. Always returns a FRESH
 * object — the defaults are module state and must never be mutated.
 */
export function mergeCommitteeParams(
  base: CommitteeParams = DEFAULT_COMMITTEE_PARAMS,
  over?: CommitteeParamsOverride,
): CommitteeParams {
  const momentum: CommitteeParams["momentum"] = {
    ...base.momentum,
    ...(over?.momentum ?? {}),
    tfWeights: { ...base.momentum.tfWeights, ...(over?.momentum?.tfWeights ?? {}) },
    legWeights: { ...base.momentum.legWeights, ...(over?.momentum?.legWeights ?? {}) },
  };
  return {
    consensusThreshold: over?.consensusThreshold ?? base.consensusThreshold,
    minAgreement: over?.minAgreement ?? base.minAgreement,
    minVoters: over?.minVoters ?? base.minVoters,
    sizeStep: over?.sizeStep ?? base.sizeStep,
    structure: { ...base.structure, ...(over?.structure ?? {}) },
    momentum,
    flow: { ...base.flow, ...(over?.flow ?? {}) },
    meanReversion: { ...base.meanReversion, ...(over?.meanReversion ?? {}) },
    eventRisk: { ...base.eventRisk, ...(over?.eventRisk ?? {}) },
    execution: { ...base.execution, ...(over?.execution ?? {}) },
  };
}

/**
 * Pure: conviction → size factor. Never reaches zero (a cleared vote
 * still trades) and never exceeds 1 (the proposal size is the cap).
 */
export function convictionSizeScale(score: number): number {
  return clamp(0.5 + 0.5 * Math.abs(clampScore(score)), 0, 1);
}

/**
 * Run the committee. Every seat is isolated: a seat that throws abstains
 * (with the error in its reason) and never blocks the committee. Any
 * hard veto ends the debate with a VETO verdict and no trade.
 */
export function runCommittee(
  ctx: CommitteeContext,
  opts: {
    seats?: CommitteeSeat[];
    weights?: Partial<Record<CommitteeSeatId, number>>;
    params?: CommitteeParamsOverride;
    /** Override the threshold without rebuilding the params object. */
    consensusThreshold?: number;
  } = {},
): CommitteeResult {
  const params = mergeCommitteeParams(ctx.params ?? DEFAULT_COMMITTEE_PARAMS, opts.params);
  if (typeof opts.consensusThreshold === "number") {
    params.consensusThreshold = opts.consensusThreshold;
  }
  const seats = opts.seats ?? DEFAULT_SEATS;

  const breakdown: CommitteeSeatBreakdown[] = [];
  const vetoes: CommitteeVeto[] = [];

  for (const seat of seats) {
    const weight = opts.weights?.[seat.id] ?? seat.weight;
    let opinion: CommitteeSeatOpinion;
    try {
      opinion = seat.evaluate({ ...ctx, params });
    } catch (e) {
      // A seat that throws abstains — it never blocks the committee.
      opinion = {
        score: 0,
        position: null,
        abstain: true,
        reason: `seat failed: ${e instanceof Error ? e.message : String(e)}`,
        veto: null,
        support: null,
      };
    }
    const score = clampScore(opinion.score ?? 0);
    const abstain = opinion.abstain === true;
    const support = seat.role === "gate" ? clamp(opinion.support ?? 0, 0, 1) : null;
    const veto = opinion.veto ?? null;
    if (veto) vetoes.push({ seat: seat.id, rule: veto.rule, detail: veto.detail });
    breakdown.push({
      seat: seat.id,
      role: seat.role,
      weight,
      score,
      contribution: seat.role === "directional" && !abstain ? score * weight : 0,
      abstain,
      support,
      veto,
      reason: opinion.reason,
      position: opinion.position ?? null,
      metrics: opinion.metrics ?? {},
    });
  }

  // --- directional consensus ----------------------------------------
  const voters = breakdown.filter((b) => b.role === "directional" && !b.abstain && b.weight > 0);
  const den = voters.reduce((a, b) => a + b.weight, 0);
  const num = voters.reduce((a, b) => a + b.score * b.weight, 0);
  const directionalScore = den > 0 ? clampScore(num / den) : 0;

  let agreement = 0;
  if (den > 0 && directionalScore !== 0) {
    const agree = voters
      .filter((b) => signOf(b.score) === signOf(directionalScore))
      .reduce((a, b) => a + b.weight, 0);
    agreement = agree / den;
  }

  // --- gate support (fail-open: an abstained gate never blocks) ------
  const gates = breakdown.filter((b) => b.role === "gate" && !b.abstain && b.support !== null);
  const gateSupport = gates.length > 0 ? Math.min(...gates.map((g) => g.support as number)) : 1;

  const score = clampScore(directionalScore * gateSupport);

  // --- verdict -------------------------------------------------------
  let verdict: CommitteeVerdict;
  let reason: string;
  if (vetoes.length > 0) {
    verdict = "VETO";
    reason = vetoes.map((v) => `${v.seat}:${v.rule} — ${v.detail}`).join("; ");
  } else if (voters.length < params.minVoters) {
    verdict = "FLAT";
    reason = "no seat voted — nothing to debate";
  } else if (gateSupport <= 0) {
    verdict = "FLAT";
    reason = "a gate seat blocked the proposal";
  } else if (Math.abs(directionalScore) < params.consensusThreshold) {
    verdict = "FLAT";
    reason = `consensus ${directionalScore.toFixed(2)} inside ±${params.consensusThreshold} — no consensus`;
  } else if (agreement < params.minAgreement) {
    verdict = "FLAT";
    reason = `only ${Math.round(agreement * 100)}% of the directional weight agrees — no clear majority`;
  } else if (directionalScore > 0) {
    verdict = "LONG";
    reason = `consensus ${score.toFixed(2)} decides LONG (${voters.length} seats, ${Math.round(agreement * 100)}% agreement)`;
  } else {
    verdict = "SHORT";
    reason = `consensus ${score.toFixed(2)} decides SHORT (${voters.length} seats, ${Math.round(agreement * 100)}% agreement)`;
  }

  // --- the sized plan ------------------------------------------------
  let plan: CommitteePosition | null = null;
  if (verdict === "LONG" || verdict === "SHORT") {
    const side: CommitteeSide = verdict === "LONG" ? "long" : "short";
    const base = mirrorPosition(ctx.proposal, side);
    const winner = breakdown
      .filter((b) => b.position && b.position.side === side && b.position.entry > 0)
      .sort((a, b) => b.weight - a.weight)[0];
    const levels = winner?.position
      ? { entry: winner.position.entry, stop: winner.position.stop, target: winner.position.target }
      : { entry: base.entry, stop: base.stop, target: base.target };
    const scale = convictionSizeScale(score);
    plan = {
      pair: ctx.proposal.pair,
      side,
      entry: levels.entry,
      stop: levels.stop,
      target: levels.target,
      size: floorToStep(base.size * scale, params.sizeStep),
    };
  }

  return {
    verdict,
    score,
    directionalScore,
    agreement,
    gateSupport,
    voters: voters.length,
    seats: breakdown,
    vetoes,
    plan,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* Data assembly + command                                             */
/* ------------------------------------------------------------------ */

export type CommitteeDeps = {
  /** 24h tape + funding read (kucoin.futuresFade). */
  fade?: typeof futuresFade;
  /** Raw kline rows (kucoin.futuresKlinesRaw). */
  klines?: typeof futuresKlinesRaw;
  ticker?: typeof futuresTickerFull;
  depth20?: typeof futuresDepth20;
  contractSpec?: typeof futuresContractSpec;
  jevTrend?: typeof fetchJevTrend;
  /** Kronos oracle (pair + horizon only — the committee fetches it). */
  kronos?: typeof fetchKronosVerdict;
  /** Raw model verdicts (JEV / Kronos / Laya) → mapped via committeeModelLegs. */
  rawVerdicts?: CommitteeRawVerdicts;
  /** Model legs for the momentum seat. */
  models?: () => Promise<CommitteeModelLegs>;
  now?: () => number;
};

const TF_MINUTES: Record<CommitteeTimeframe, number> = { "1h": 60, "4h": 240, "1d": 1440 };
const TF_BARS = 60;

function venueBase(pair: string): string {
  const base = (pair.split("/")[0] ?? "").trim().toUpperCase();
  return base === "BTC" ? "XBT" : base;
}

/**
 * Build the market snapshot the seats read. Public reads only (no PAT
 * needed for the tape/book); the JEV leg attaches when a PAT resolves.
 */
export async function fetchCommitteeMarket(
  pair: string,
  exchange: string,
  opts: { url?: string; pat?: string } = {},
  deps: CommitteeDeps = {},
): Promise<CommitteeMarket> {
  const norm = normalizeVotePair(pair);
  const symbol = klinesSymbolForPair(norm);
  if (!symbol) throw new Error(`bad pair ${pair} (want BASE/USDT)`);
  const fade = deps.fade ?? futuresFade;
  const klines = deps.klines ?? futuresKlinesRaw;
  const ticker = deps.ticker ?? futuresTickerFull;
  const depth20 = deps.depth20 ?? futuresDepth20;
  const contractSpec = deps.contractSpec ?? futuresContractSpec;
  const nowMs = (deps.now ?? Date.now)();

  const [row, tick] = await Promise.all([fade(venueBase(norm)), ticker(symbol)]);

  const timeframes: { tf: CommitteeTimeframe; candles: KlineCandle[] }[] = [];
  for (const tf of ["1h", "4h", "1d"] as CommitteeTimeframe[]) {
    const gran = TF_MINUTES[tf];
    const span = TF_BARS * gran * 60 * 1000;
    try {
      const rows = await klines(symbol, gran, nowMs - span, nowMs);
      timeframes.push({ tf, candles: parseKlineRows(rows) });
    } catch {
      timeframes.push({ tf, candles: [] });
    }
  }

  const hourCandles = timeframes.find((t) => t.tf === "1h")?.candles ?? [];
  const last24 = hourCandles.slice(-24);
  const high24 = last24.length > 0 ? Math.max(...last24.map((c) => c.high)) : null;
  const low24 = last24.length > 0 ? Math.min(...last24.map((c) => c.low)) : null;
  const sessionLow = hourCandles.length > 0 ? Math.min(...hourCandles.slice(-12).map((c) => c.low)) : null;
  const vw = vwapCumulative(hourCandles);
  const vwap = [...vw].reverse().find((v) => v !== null && v !== undefined) ?? null;
  const emas = emaSeries(hourCandles.map((c) => c.close), 20);
  const ema20 = [...emas].reverse().find((v) => v !== null && v !== undefined) ?? null;
  const rsis = rsiWilder(hourCandles.map((c) => c.close));
  const rsi = [...rsis].reverse().find((v) => v !== null && v !== undefined) ?? null;

  let book: CommitteeBook | null = null;
  try {
    const [ob, spec] = await Promise.all([depth20(symbol), contractSpec(venueBase(norm))]);
    const mult = typeof spec?.multiplier === "number" && spec.multiplier > 0 ? spec.multiplier : 1;
    const bn = spikeNotionals((ob.bids ?? []).slice(0, 5) as [unknown, unknown][], mult);
    const an = spikeNotionals((ob.asks ?? []).slice(0, 5) as [unknown, unknown][], mult);
    const bidUsd = bn.reduce((a, l) => a + l.notional, 0);
    const askUsd = an.reduce((a, l) => a + l.notional, 0);
    book = {
      bidUsd: Math.round(bidUsd * 10) / 10,
      askUsd: Math.round(askUsd * 10) / 10,
      imbalance: Math.round(spikeImbalance(bidUsd, askUsd) * 1000) / 1000,
      spreadBps: Math.round(spikeSpreadBps(tick.bestBid, tick.bestAsk) * 100) / 100,
    };
  } catch {
    book = null;
  }

  let jev: TrendVerdict | null = null;
  const pat = resolvePat(opts.pat);
  if (pat) {
    try {
      jev = await (deps.jevTrend ?? fetchJevTrend)(exchange, norm, pat, opts.url);
    } catch {
      jev = null;
    }
  }

  let models: CommitteeModelLegs | undefined;
  if (deps.models) {
    try {
      models = await deps.models();
    } catch {
      models = undefined;
    }
  } else if (deps.rawVerdicts || deps.kronos) {
    // The caller supplies the raw verdicts (or lets the committee fetch
    // Kronos, which needs only a pair + horizon). A model that fails
    // abstains — it never blocks the committee.
    const raw: CommitteeRawVerdicts = {
      ...(deps.rawVerdicts ?? {}),
      jev: deps.rawVerdicts?.jev ?? jev,
      voteWeights: deps.rawVerdicts?.voteWeights ?? DEFAULT_WEIGHTS,
    };
    if (deps.kronos) {
      try {
        raw.kronos = await deps.kronos(norm, 12);
      } catch {
        raw.kronos = null;
      }
    }
    models = committeeModelLegs(raw);
  }

  const rawAcct = Number(process.env["JW3_ACCOUNT_USD"] ?? NaN);
  const accountUsd = Number.isFinite(rawAcct) ? rawAcct : undefined;
  const feeTierOk = (process.env["JW3_FEE_TIER_OK"] ?? "").trim() === "1";

  return {
    pair: norm,
    last: tick.price,
    timeframes,
    high24,
    low24,
    atrPct: row.atrPct ?? atrPercent(hourCandles),
    vwap,
    ema20,
    rsi,
    volRatio: row.vratio,
    volSlope: row.vslope,
    book,
    fundingPct: row.fundingPct,
    dayChgPct: row.chg,
    sessionLow,
    blackouts: [],
    macroEventToday: false,
    nowMs,
    accountUsd,
    feeTierOk,
    jev,
    models,
  };
}

/**
 * Build the proposal under debate. Levels default off the tape (entry =
 * last, stop = 1× ATR, target = 1.5R) so the committee always debates a
 * concrete trade; the caller can override every level.
 */
export function defaultProposal(
  pair: string,
  side: CommitteeSide,
  last: number,
  atrPct: number | null,
  size: number,
): CommitteePosition {
  const atr = atrPct !== null && atrPct > 0 ? atrPct : 0.5;
  const stopDist = (atr / 100) * last;
  const targetDist = stopDist * 1.5;
  return {
    pair: normalizeVotePair(pair),
    side,
    entry: last,
    stop: side === "long" ? last - stopDist : last + stopDist,
    target: side === "long" ? last + targetDist : last - targetDist,
    size,
  };
}

export async function cmdCommittee(opts: {
  pair: string;
  exchange: string;
  json: boolean;
  side?: CommitteeSide;
  entry?: number;
  stop?: number;
  target?: number;
  size?: number;
  url?: string;
  pat?: string;
  /** Injectable seats (a disabled seat is simply left out). */
  seats?: CommitteeSeat[];
  weights?: Partial<Record<CommitteeSeatId, number>>;
  params?: CommitteeParamsOverride;
  deps?: CommitteeDeps;
}): Promise<void> {
  const pairErr = validateVotePair(opts.pair);
  if (pairErr || !opts.exchange) {
    console.error(
      "Usage: jw3 committee --pair SOL/USDT [--exchange kucoin] [--side long|short] [--size N] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  const pair = normalizeVotePair(opts.pair);
  const deps = opts.deps ?? {};
  let market: CommitteeMarket;
  try {
    market = await fetchCommitteeMarket(pair, opts.exchange, { url: opts.url, pat: opts.pat }, deps);
  } catch (e) {
    console.error(`No market state — the committee cannot convene: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const side: CommitteeSide = opts.side === "short" ? "short" : "long";
  const size = typeof opts.size === "number" && Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 1;
  const base = defaultProposal(pair, side, market.last, market.atrPct ?? null, size);
  const proposal: CommitteePosition = {
    ...base,
    entry: typeof opts.entry === "number" && opts.entry > 0 ? opts.entry : base.entry,
    stop: typeof opts.stop === "number" && opts.stop > 0 ? opts.stop : base.stop,
    target: typeof opts.target === "number" && opts.target > 0 ? opts.target : base.target,
  };

  const params = mergeCommitteeParams(DEFAULT_COMMITTEE_PARAMS, opts.params);
  const result = runCommittee({ proposal, market, params }, { seats: opts.seats, weights: opts.weights, params: opts.params });

  if (opts.json) {
    console.log(JSON.stringify({ pair, proposal, ...result }, null, 2));
  } else {
    console.log(`COMMITTEE ${pair} — ${result.verdict} (consensus ${result.score.toFixed(2)})`);
    console.log(
      `  proposal ${proposal.side.toUpperCase()} entry ${proposal.entry} stop ${proposal.stop} target ${proposal.target} size ${proposal.size}`,
    );
    for (const s of result.seats) {
      const tag = s.veto ? "VETO" : s.abstain ? "abstain" : s.score.toFixed(2);
      console.log(`  ${s.seat.padEnd(15)} ${s.role.padEnd(12)} ${tag.padEnd(8)} ${s.reason}`);
    }
    for (const v of result.vetoes) console.log(`  ! veto ${v.seat}:${v.rule} — ${v.detail}`);
    if (result.plan) {
      console.log(
        `  plan ${result.plan.side.toUpperCase()} entry ${result.plan.entry} stop ${result.plan.stop} target ${result.plan.target} size ${result.plan.size}`,
      );
    }
    console.log(`  ${result.reason}`);
    console.log("Read-only committee — nothing proposed, nothing traded");
  }
  process.exitCode = result.verdict === "VETO" ? 3 : result.verdict === "FLAT" ? 1 : 0;
}
