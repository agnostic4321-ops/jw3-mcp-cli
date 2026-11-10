/**
 * `jw3 score` — model scoring, promotion gate, holdout evaluation.
 *
 * The vote store (vote.ts) answers "what did the ballot say". This module
 * answers the harder question: WHICH MODELS HAVE EARNED THE RIGHT TO VOTE
 * ON REAL MONEY, and how sure are we. Everything here is measured from
 * closed trades — no assumption, no fabricated rate.
 *
 * Three layers:
 *
 *   SCORER  — a closed trade's entry context (pair, side, the models'
 *             signals at entry with their sides and confidences, realized
 *             NET P&L) updates per-model statistics: lifetime scored/hits,
 *             a rolling-window hit rate (20, same window as vote.ts), and
 *             a per-model-per-side breakdown — a model can be good at
 *             longs and bad at shorts, and the key-short vs key-long
 *             split is where that bias shows.
 *
 *   GATE    — pure and explicit: a model may vote on real money only when
 *             it has >= GATE_MIN_SAMPLES (30) scored outcomes AND a
 *             rolling hit rate >= GATE_HIT_FLOOR (0.55). Below either bar
 *             it is EXCLUDED (weight 0) with a logged reason. The gate can
 *             both demote and re-promote: Kronos was demoted after a
 *             measured 37.5% direction rate on a 64-window holdout and
 *             later re-promoted on a rolling score.
 *
 *   HOLDOUT — scores a window the model was NOT tuned on and reports a
 *             WILSON SCORE INTERVAL, so a 60% hit rate on 10 samples
 *             cannot masquerade as a 60% edge.
 *
 * Honest degradation: a model with zero scored outcomes reports
 * "insufficient sample" — never 0% and never 100%.
 *
 * ------------------------------------------------------------------
 * STORE LAYOUT AND THE BRIDGE BACK INTO vote.json
 * ------------------------------------------------------------------
 * This module keeps its OWN file (score.json, beside vote.json) because
 * vote.ts's loader rebuilds the vote store from known fields only: any
 * extra key (a per-side split, a holdout window) would be DROPPED on the
 * next vote.ts save. The bridge is projectVotePatches() — the parent
 * writes exactly these fields and vote.ts picks the change up on its
 * next read (vote stats, oracle weights, combineWeightedVote):
 *
 *   store.weights[<track>]        <- patch.weight   (0 when excluded)
 *   store.skills[<track>].results <- patch.results  (rolling window, <=20)
 *   store.skills[<track>].hits    <- patch.hits
 *   store.skills[<track>].total   <- patch.total
 *
 * Track mapping mirrors oracle.ts (oracleWeightsFromStore): Laya inherits
 * the JEV track — it is the decision leg that supersedes the raw JEV
 * trend — so JEV and Laya score against the same vote-store track while
 * keeping SEPARATE per-model statistics (they are different signals).
 *
 * Two integration modes; pick ONE per trade (running both double-counts
 * the track):
 *   A. projection — applyVotePatches() writes the track and the weight
 *      from the scorer's state. The scorer is authoritative.
 *   B. vote.ts-fed — the parent calls vote.ts's recordOutcome() per
 *      scored signal (vote.ts keeps the window + auto-tune) and then
 *      applyGateMask() zeroes the weight while the gate excludes.
 *      The scorer keeps the richer stats in score.json.
 *
 * The auto-tune here (autoTuneWeight) is a faithful replica of vote.ts's
 * recordOutcome() rule — the test suite pins the two together so the
 * weights cannot drift apart.
 */
import { configDir } from "../config.js";
import { loadJsonStore, resolveStorePath, saveJsonStore } from "./json-store.js";
import {
  DEFAULT_WEIGHTS,
  DEMOTE_AT,
  HISTORY_WINDOW,
  MIN_SAMPLES as VOTE_MIN_SAMPLES,
  PROMOTE_AT,
  WEIGHT_CAP,
  WEIGHT_FLOOR,
  WEIGHT_STEP,
  type SkillId,
  type VoteRecord,
  type VoteStore,
} from "./vote.js";

/* ------------------------------------------------------------------ */
/* Constants — the promotion-gate contract                            */
/* ------------------------------------------------------------------ */

/** Models this component scores. Laya is the decision leg (JEV track). */
export type ModelId = "jev" | "laya" | "kronos" | "rfdetr";

export const MODELS: ModelId[] = ["jev", "laya", "kronos", "rfdetr"];
/** The live comparison set (JEV, Laya, Kronos). */
export const LIVE_MODELS: ModelId[] = ["jev", "laya", "kronos"];
/** Vote-store tracks (vote.ts SkillId set). */
export const TRACKS: SkillId[] = ["jev", "kronos", "rfdetr"];

/** Model -> vote-store track (Laya inherits the JEV track, oracle.ts). */
export const MODEL_TRACK: Record<ModelId, SkillId> = {
  jev: "jev",
  laya: "jev",
  kronos: "kronos",
  rfdetr: "rfdetr",
};
/** Track -> the models that score against it. */
export const TRACK_MODELS: Record<SkillId, ModelId[]> = {
  jev: ["jev", "laya"],
  kronos: ["kronos"],
  rfdetr: ["rfdetr"],
};

/**
 * PROMOTION GATE CONSTANTS.
 *
 * GATE_MIN_SAMPLES — scored outcomes a model needs before it may vote on
 *   real money. Distinct from vote.ts's own MIN_SAMPLES (5), which is the
 *   auto-tune's sample floor (how early the weight may start moving) and
 *   NOT a vote-eligibility bar.
 * GATE_HIT_FLOOR — the rolling hit rate (over the last 20 scored
 *   outcomes) a model must hold to be eligible.
 */
export const GATE_MIN_SAMPLES = 30;
export const GATE_HIT_FLOOR = 0.55;

/** Minimum-sample guard for ANY rate we report (per-side, per-window). */
export const RATE_FLOOR_SAMPLES = 5;
/** Rolling window for hit rates — same 20-outcome window as vote.ts. */
export const SCORE_WINDOW = HISTORY_WINDOW;
/** Default holdout window size (the Kronos precedent: 64 windows). */
export const HOLDOUT_DEFAULT_SIZE = 64;
/** Two-sided 95% normal quantile for the Wilson interval. */
export const CONFIDENCE_Z = 1.959963984540054;
/** Confidence level reported alongside the interval. */
export const CONFIDENCE_LEVEL = 0.95;
/** Cap on the per-model audit history kept in score.json. */
export const SCORE_MAX_HISTORY = 500;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type DirectionalSide = "long" | "short";
export type SignalSide = "long" | "short" | "flat";

/** One model's call at entry. */
export type ModelSignal = {
  model: ModelId;
  /** "flat" = the model made no directional call (not scorable). */
  side: SignalSide;
  /** 0..1 directional conviction. */
  confidence: number;
};

/** A closed trade: the entry context plus the realized net result. */
export type TradeContext = {
  pair: string;
  /** The direction that was actually taken. */
  side: DirectionalSide;
  /** The models' calls at entry. */
  signals: ModelSignal[];
  /** Realized NET P&L of the closed trade (after fees). */
  netPnlUsd: number;
  /** Optional close timestamp (ISO). */
  at?: string;
};

/** One scored outcome in the audit history. */
export type ScoredOutcome = {
  at: string;
  pair: string;
  tradeSide: DirectionalSide;
  signalSide: DirectionalSide;
  confidence: number;
  hit: boolean;
  netPnlUsd: number;
};

/** Per-model-per-side breakdown (longs vs shorts). */
export type SideScorecard = {
  total: number;
  hits: number;
  /** Rolling window for this side only (last SCORE_WINDOW). */
  results: boolean[];
  /** Net P&L of the trades this model called on this side. */
  pnlUsd: number;
  pnlWhenHitUsd: number;
  pnlWhenMissUsd: number;
};

/** Per-model statistics. */
export type ModelScorecard = {
  model: ModelId;
  /** Lifetime scored outcomes (abstains and flat closes are NOT scored). */
  total: number;
  hits: number;
  /** Rolling window of the last SCORE_WINDOW scored outcomes, oldest first. */
  results: boolean[];
  sides: Record<DirectionalSide, SideScorecard>;
  pnl: { netUsd: number; whenHitUsd: number; whenMissUsd: number };
  history: ScoredOutcome[];
};

/** Mirrors vote.ts's SkillTrack exactly (same three fields). */
export type TrackState = {
  results: boolean[];
  hits: number;
  total: number;
};

export type ScoreStore = {
  version: 1;
  models: Record<ModelId, ModelScorecard>;
  tracks: Record<SkillId, TrackState>;
  /** The auto-tuned merit weight per vote-store track. */
  weights: Record<SkillId, number>;
  updatedAt: string;
};

/* ------------------------------------------------------------------ */
/* Statistics helpers (pure)                                           */
/* ------------------------------------------------------------------ */

export type RateInterval = {
  hits: number;
  samples: number;
  /** Point estimate, or null when nothing was measured at all. */
  point: number | null;
  /** Wilson lower bound, or null when nothing was measured. */
  low: number | null;
  /** Wilson upper bound, or null when nothing was measured. */
  high: number | null;
  method: "wilson";
  confidence: number;
  minSamples: number;
  /** True when samples < minSamples — the rate is measured but not proven. */
  insufficient: boolean;
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Pure: rolling-window hit rate, or null when the window is empty.
 * A null is NOT 0% — an empty window means "not measured yet".
 */
export function rollingHitRate(results: readonly boolean[]): number | null {
  if (!results || results.length === 0) return null;
  return results.filter(Boolean).length / results.length;
}

/**
 * Pure: minimum-sample guard. Returns null when the sample is below the
 * floor — we refuse to report a rate the data cannot support. A model
 * with zero scored outcomes reports null (insufficient sample), never 0%
 * and never 100%.
 */
export function guardedHitRate(hits: number, samples: number, minSamples: number = RATE_FLOOR_SAMPLES): number | null {
  if (!Number.isFinite(hits) || !Number.isFinite(samples)) return null;
  if (!Number.isInteger(samples) || samples <= 0) return null;
  if (samples < minSamples) return null;
  return clamp01(hits / samples);
}

/**
 * Pure: Wilson score interval for a binomial proportion.
 *
 * Wilson (not Wald) because our samples are small — the normal
 * approximation breaks down below ~30 samples and produces a
 * zero-width interval at 0/10, which would read as "certainly wrong".
 * Wilson stays inside [0,1] and shrinks honestly with the sample size.
 *
 * Returns null when there is nothing to measure (n = 0).
 */
export function wilsonInterval(
  hits: number,
  samples: number,
  z: number = CONFIDENCE_Z,
): { low: number; high: number } | null {
  if (!Number.isFinite(hits) || !Number.isFinite(samples)) return null;
  if (!Number.isInteger(samples) || samples <= 0) return null;
  const h = Math.min(Math.max(hits, 0), samples);
  const n = samples;
  const p = h / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: clamp01(center - margin), high: clamp01(center + margin) };
}

/**
 * Pure: a rate with its Wilson interval. `point` is null only when
 * nothing was measured; `insufficient` flags a sample below the floor so
 * the caller can print "insufficient sample" instead of a bare number.
 */
export function rateInterval(
  hits: number,
  samples: number,
  opts: { z?: number; minSamples?: number } = {},
): RateInterval {
  const minSamples = opts.minSamples ?? RATE_FLOOR_SAMPLES;
  const z = opts.z ?? CONFIDENCE_Z;
  const safeSamples = Number.isFinite(samples) && Number.isInteger(samples) && samples > 0 ? samples : 0;
  const safeHits = Number.isFinite(hits) ? Math.min(Math.max(hits, 0), safeSamples) : 0;
  const interval = safeSamples > 0 ? wilsonInterval(safeHits, safeSamples, z) : null;
  return {
    hits: safeHits,
    samples: safeSamples,
    point: safeSamples > 0 ? safeHits / safeSamples : null,
    low: interval ? interval.low : null,
    high: interval ? interval.high : null,
    method: "wilson",
    confidence: CONFIDENCE_LEVEL,
    minSamples,
    insufficient: safeSamples < minSamples,
  };
}

/**
 * Pure: the vote.ts auto-tune rule, replica'd so the scorer can own the
 * merit weight without editing vote.ts. Identical to vote.ts's
 * recordOutcome(): promote +0.1 when the rolling rate >= 60% (and the
 * window holds >= 5 samples), demote -0.1 at <= 40%, clamped to
 * [0, 2.0] and rounded to 2dp.
 *
 * `results` is the window AFTER the new outcome was pushed.
 */
export function autoTuneWeight(results: readonly boolean[], weightBefore: number): number {
  const before = Number.isFinite(weightBefore) ? Math.min(Math.max(weightBefore, WEIGHT_FLOOR), WEIGHT_CAP) : 0;
  const rate = rollingHitRate(results);
  let after = before;
  if (results.length >= VOTE_MIN_SAMPLES && rate !== null) {
    if (rate >= PROMOTE_AT) after = Math.min(WEIGHT_CAP, before + WEIGHT_STEP);
    else if (rate <= DEMOTE_AT) after = Math.max(WEIGHT_FLOOR, before - WEIGHT_STEP);
  }
  return round2(after);
}

/* ------------------------------------------------------------------ */
/* Promotion gate (pure)                                               */
/* ------------------------------------------------------------------ */

export type GateBlocker =
  | "insufficient-sample"
  | "insufficient-rolling-sample"
  | "hit-rate-below-floor";

export type GateDecision = {
  model: ModelId;
  track: SkillId;
  /** True only when the model may vote on real money. */
  eligible: boolean;
  /** Effective voting weight: 0 when excluded, else the merit weight. */
  weight: number;
  /** The track's merit weight (what the model would vote with). */
  meritWeight: number;
  blockers: GateBlocker[];
  /** Logged reason — always says why. */
  reason: string;
  /** Lifetime scored outcomes. */
  samples: number;
  rollingSamples: number;
  rollingHitRate: number | null;
  minSamples: number;
  hitFloor: number;
};

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/**
 * Pure: the promotion gate. A model may vote on real money only when it
 * has >= minSamples scored outcomes AND a rolling hit rate >= hitFloor.
 * Below either bar it is EXCLUDED (weight 0) with a logged reason.
 *
 * The gate is symmetric: the same function demotes a model that decays
 * and re-promotes one that recovers (Kronos: demoted on a measured 37.5%
 * direction rate, later re-promoted on a rolling score).
 */
export function promotionGate(
  card: ModelScorecard,
  opts: { track: SkillId; meritWeight: number; minSamples?: number; hitFloor?: number },
): GateDecision {
  const minSamples = opts.minSamples ?? GATE_MIN_SAMPLES;
  const hitFloor = opts.hitFloor ?? GATE_HIT_FLOOR;
  const samples = card.total;
  const rollingSamples = card.results.length;
  const rate = rollingHitRate(card.results);
  const meritWeight = Number.isFinite(opts.meritWeight) ? opts.meritWeight : 0;

  const blockers: GateBlocker[] = [];
  if (samples < minSamples) blockers.push("insufficient-sample");
  if (rollingSamples < RATE_FLOOR_SAMPLES) blockers.push("insufficient-rolling-sample");
  if (rate === null || rate < hitFloor) blockers.push("hit-rate-below-floor");

  const eligible = blockers.length === 0;
  const facts: string[] = [`${samples}/${minSamples} scored outcomes`];
  facts.push(rollingSamples === 0 ? "no rolling sample" : `rolling ${pct(rate)} (need ${pct(hitFloor)})`);
  const reason = eligible
    ? `eligible — ${facts.join(" · ")}`
    : `excluded — ${facts.join(" · ")}`;

  return {
    model: card.model,
    track: opts.track,
    eligible,
    weight: eligible ? meritWeight : 0,
    meritWeight,
    blockers,
    reason,
    samples,
    rollingSamples,
    rollingHitRate: rate,
    minSamples,
    hitFloor,
  };
}

/** Pure: the gate decision for every model in a store. */
export function gatesFor(store: ScoreStore, opts: { minSamples?: number; hitFloor?: number } = {}): Record<ModelId, GateDecision> {
  const out = {} as Record<ModelId, GateDecision>;
  for (const m of MODELS) {
    const track = MODEL_TRACK[m];
    out[m] = promotionGate(store.models[m] ?? emptyModelCard(m), {
      track,
      meritWeight: store.weights[track] ?? 0,
      ...opts,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Side breakdown (pure)                                               */
/* ------------------------------------------------------------------ */

export type SideBreakdownRow = {
  side: DirectionalSide;
  samples: number;
  hits: number;
  /** null when below the sample floor (or empty) — never a fake 0%. */
  hitRate: number | null;
  sufficient: boolean;
  pnlUsd: number;
  pnlWhenHitUsd: number;
  pnlWhenMissUsd: number;
};

/** Pure: per-model-per-side breakdown — where side bias shows up. */
export function sideBreakdown(card: ModelScorecard): SideBreakdownRow[] {
  return (["long", "short"] as DirectionalSide[]).map((side) => {
    const s = card.sides[side];
    const samples = s.total;
    return {
      side,
      samples,
      hits: s.hits,
      hitRate: guardedHitRate(s.hits, samples),
      sufficient: samples >= RATE_FLOOR_SAMPLES,
      pnlUsd: round2(s.pnlUsd),
      pnlWhenHitUsd: round2(s.pnlWhenHitUsd),
      pnlWhenMissUsd: round2(s.pnlWhenMissUsd),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Scoring a closed trade                                              */
/* ------------------------------------------------------------------ */

export type ScoredSignal = {
  model: ModelId;
  track: SkillId;
  side: DirectionalSide;
  confidence: number;
  hit: boolean;
};

export type SkippedSignal = {
  model: ModelId;
  side: SignalSide;
  reason: string;
};

export type ScoreTradeResult = {
  ok: boolean;
  error?: string;
  /** The realized direction ("flat" = breakeven close, nothing scored). */
  outcome: SignalSide;
  store: ScoreStore;
  scored: ScoredSignal[];
  skipped: SkippedSignal[];
  gates: Record<ModelId, GateDecision>;
};

/** Pure: validate a trade context. Null = usable. */
export function validateTrade(trade: TradeContext): string | null {
  if (!trade || typeof trade !== "object") return "trade context missing";
  if (typeof trade.pair !== "string" || trade.pair.trim() === "") return "pair required (e.g. SOL/USDT)";
  if (trade.side !== "long" && trade.side !== "short") return "side required (long|short)";
  if (!Number.isFinite(trade.netPnlUsd)) {
    return "realized net P&L required — an outcome without a realized result is not scorable";
  }
  if (!Array.isArray(trade.signals)) return "entry signals required";
  return null;
}

/**
 * Pure: the realized direction of a closed trade, derived from the net
 * P&L. Positive P&L means the traded direction was right; negative means
 * the market went the other way; exactly zero (a breakeven close) means
 * NO directional outcome — a breakeven does not prove a direction, so
 * nothing is scored.
 */
export function realizedOutcome(trade: TradeContext): SignalSide {
  if (!Number.isFinite(trade.netPnlUsd)) return "flat";
  if (trade.netPnlUsd > 0) return trade.side;
  if (trade.netPnlUsd < 0) return trade.side === "long" ? "short" : "long";
  return "flat";
}

/** Pure: did this model's call match the realized direction? null = not scorable. */
export function scoreSignal(signal: ModelSignal, outcome: SignalSide): boolean | null {
  if (outcome === "flat" || signal.side === "flat") return null;
  return signal.side === outcome;
}

function skipReason(signal: ModelSignal, outcome: SignalSide): string {
  if (outcome === "flat") return "trade closed flat — no directional outcome to score";
  if (signal.side === "flat") return "model made no directional call";
  return "";
}

/**
 * Pure: score a closed trade. Updates per-model statistics (lifetime
 * counters, the rolling window, the per-side breakdown, the audit
 * history), the mirrored vote-store tracks, and the auto-tuned merit
 * weight. Returns a NEW store — the input is never mutated.
 */
export function scoreTrade(store: ScoreStore, trade: TradeContext): ScoreTradeResult {
  const error = validateTrade(trade);
  if (error) {
    return { ok: false, error, outcome: "flat", store, scored: [], skipped: [], gates: gatesFor(store) };
  }
  const next = cloneStore(store);
  const outcome = realizedOutcome(trade);
  const scored: ScoredSignal[] = [];
  const skipped: SkippedSignal[] = [];

  for (const signal of trade.signals) {
    const track = MODEL_TRACK[signal.model];
    if (!track) {
      skipped.push({ model: signal.model, side: signal.side, reason: `unknown model — not a scorable model` });
      continue;
    }
    const hit = scoreSignal(signal, outcome);
    if (hit === null) {
      skipped.push({ model: signal.model, side: signal.side, reason: skipReason(signal, outcome) });
      continue;
    }
    const card = next.models[signal.model]!;
    const trackState = next.tracks[track]!;
    const side = card.sides[signal.side as DirectionalSide];

    card.total += 1;
    if (hit) card.hits += 1;
    card.results.push(hit);
    trimWindow(card.results);

    side.total += 1;
    if (hit) side.hits += 1;
    side.results.push(hit);
    trimWindow(side.results);
    side.pnlUsd += trade.netPnlUsd;
    if (hit) side.pnlWhenHitUsd += trade.netPnlUsd;
    else side.pnlWhenMissUsd += trade.netPnlUsd;

    card.pnl.netUsd += trade.netPnlUsd;
    if (hit) card.pnl.whenHitUsd += trade.netPnlUsd;
    else card.pnl.whenMissUsd += trade.netPnlUsd;

    card.history.push({
      at: trade.at ?? "",
      pair: trade.pair,
      tradeSide: trade.side,
      signalSide: signal.side as DirectionalSide,
      confidence: signal.confidence,
      hit,
      netPnlUsd: trade.netPnlUsd,
    });
    if (card.history.length > SCORE_MAX_HISTORY) card.history.splice(0, card.history.length - SCORE_MAX_HISTORY);

    // The vote-store track mirrors vote.ts's SkillTrack, and the merit
    // weight follows vote.ts's auto-tune rule exactly.
    trackState.results.push(hit);
    trimWindow(trackState.results);
    if (hit) trackState.hits += 1;
    trackState.total += 1;
    next.weights[track] = autoTuneWeight(trackState.results, next.weights[track] ?? 0);

    scored.push({ model: signal.model, track, side: signal.side as DirectionalSide, confidence: signal.confidence, hit });
  }

  if (trade.at) next.updatedAt = trade.at;
  return { ok: true, outcome, store: next, scored, skipped, gates: gatesFor(next) };
}

/* ------------------------------------------------------------------ */
/* Holdout evaluation (pure)                                           */
/* ------------------------------------------------------------------ */

export type HoldoutWindow = {
  model: ModelId;
  label: string;
  /** The holdout outcomes — the window the model was NOT tuned on. */
  outcomes: ScoredOutcome[];
  /** The outcomes the model WAS tuned on (used for the overlap check). */
  tunedOn?: ScoredOutcome[];
};

export type HoldoutReport = {
  model: ModelId;
  label: string;
  samples: number;
  hits: number;
  /** null when nothing was measured — never 0% and never 100%. */
  hitRate: number | null;
  low: number | null;
  high: number | null;
  method: "wilson";
  confidence: number;
  minSamples: number;
  /** True when the sample is below the floor — the rate is not proven. */
  insufficient: boolean;
  /** True when the interval lies entirely above 50% (a proven edge). */
  beatsCoinFlip: boolean;
  /** True when the interval lies entirely below 50% (measured underperformance). */
  belowCoinFlip: boolean;
  /** True when the holdout overlaps the tuning window (the number is dirty). */
  contaminated: boolean;
  verdict: string;
};

/**
 * Pure: split a model's history into the tuning window (the live rolling
 * window — the most recent outcomes the auto-tune has already seen) and
 * a holdout block taken from IMMEDIATELY BEFORE it. The two slices are
 * disjoint by construction, so the holdout is genuinely untuned.
 */
export function splitTuneHoldout(
  history: readonly ScoredOutcome[],
  tuningSize: number = SCORE_WINDOW,
  holdoutSize: number = HOLDOUT_DEFAULT_SIZE,
): { tuned: ScoredOutcome[]; holdout: ScoredOutcome[] } {
  const tunedStart = Math.max(0, history.length - Math.max(0, tuningSize));
  const tuned = history.slice(tunedStart);
  const holdoutEnd = tunedStart;
  const holdoutStart = Math.max(0, holdoutEnd - Math.max(0, holdoutSize));
  return { tuned: [...tuned], holdout: [...history.slice(holdoutStart, holdoutEnd)] };
}

/**
 * Pure: score a model over a window it was NOT tuned on. Reports the hit
 * rate, the sample size and a Wilson interval — so a 60% hit rate on 10
 * samples cannot masquerade as a 60% edge (6/10 is 31%–83%, which spans
 * a coin flip and is reported as "no proven edge").
 */
export function evaluateHoldout(window: HoldoutWindow, opts: { minSamples?: number } = {}): HoldoutReport {
  const minSamples = opts.minSamples ?? RATE_FLOOR_SAMPLES;
  const outcomes = window.outcomes ?? [];
  const samples = outcomes.length;
  const hits = outcomes.filter((o) => o.hit).length;
  const interval = rateInterval(hits, samples, { minSamples });
  const rate = samples > 0 ? hits / samples : null;
  const contaminated = Boolean(
    window.tunedOn && window.tunedOn.some((t) => outcomes.includes(t)),
  );
  const beatsCoinFlip = interval.low !== null && interval.low > 0.5;
  const belowCoinFlip = interval.high !== null && interval.high < 0.5;

  let verdict: string;
  if (samples === 0) {
    verdict = "insufficient sample — no outcomes in the holdout window";
  } else if (contaminated) {
    verdict = "contaminated — the holdout window overlaps the tuning window";
  } else if (interval.insufficient) {
    verdict = `insufficient sample — ${samples} outcome${samples === 1 ? "" : "s"} (need ${minSamples}) · ${pct(rate)} is measured, not proven`;
  } else if (beatsCoinFlip) {
    verdict = `edge above 50% — ${pct(rate)} (95% CI ${pct(interval.low)}–${pct(interval.high)})`;
  } else if (belowCoinFlip) {
    // The whole interval sits under a coin flip: measured underperformance,
    // not merely "no edge proven".
    verdict = `below 50% — ${pct(rate)} (95% CI ${pct(interval.low)}–${pct(interval.high)} is under a coin flip)`;
  } else {
    verdict = `no proven edge — ${pct(rate)} (95% CI ${pct(interval.low)}–${pct(interval.high)} spans 50%)`;
  }

  return {
    model: window.model,
    label: window.label,
    samples,
    hits,
    hitRate: rate,
    low: interval.low,
    high: interval.high,
    method: "wilson",
    confidence: CONFIDENCE_LEVEL,
    minSamples,
    insufficient: interval.insufficient,
    beatsCoinFlip,
    belowCoinFlip,
    contaminated,
    verdict,
  };
}

/** Pure: the holdout report for a model in a store. */
export function holdoutForModel(
  store: ScoreStore,
  model: ModelId,
  opts: { tuningSize?: number; holdoutSize?: number; label?: string } = {},
): HoldoutReport {
  const card = store.models[model] ?? emptyModelCard(model);
  const tuningSize = opts.tuningSize ?? SCORE_WINDOW;
  const holdoutSize = opts.holdoutSize ?? HOLDOUT_DEFAULT_SIZE;
  const { tuned, holdout } = splitTuneHoldout(card.history, tuningSize, holdoutSize);
  return evaluateHoldout(
    { model, label: opts.label ?? `last ${holdoutSize} before the ${tuningSize}-outcome tuning window`, outcomes: holdout, tunedOn: tuned },
    {},
  );
}

/* ------------------------------------------------------------------ */
/* Comparison report (pure)                                            */
/* ------------------------------------------------------------------ */

export type ComparisonRow = {
  model: ModelId;
  track: SkillId;
  samples: number;
  hits: number;
  lifetimeHitRate: number | null;
  lifetimeInterval: RateInterval;
  rollingSamples: number;
  rollingHitRate: number | null;
  rollingInterval: RateInterval;
  sides: SideBreakdownRow[];
  eligible: boolean;
  weight: number;
  meritWeight: number;
  blockers: GateBlocker[];
  reason: string;
};

/** Pure: the operator-facing comparison across the live models. */
export function compareModels(
  store: ScoreStore,
  models: readonly ModelId[] = LIVE_MODELS,
  opts: { minSamples?: number; hitFloor?: number } = {},
): ComparisonRow[] {
  const gates = gatesFor(store, opts);
  return models.map((model) => {
    const card = store.models[model] ?? emptyModelCard(model);
    const gate = gates[model]!;
    const rolling = rateInterval(
      card.results.filter(Boolean).length,
      card.results.length,
      { minSamples: RATE_FLOOR_SAMPLES },
    );
    const lifetime = rateInterval(card.hits, card.total, { minSamples: RATE_FLOOR_SAMPLES });
    return {
      model,
      track: MODEL_TRACK[model],
      samples: card.total,
      hits: card.hits,
      lifetimeHitRate: lifetime.point,
      lifetimeInterval: lifetime,
      rollingSamples: card.results.length,
      rollingHitRate: rollingHitRate(card.results),
      rollingInterval: rolling,
      sides: sideBreakdown(card),
      eligible: gate.eligible,
      weight: gate.weight,
      meritWeight: gate.meritWeight,
      blockers: gate.blockers,
      reason: gate.reason,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Store: defaults, clone, persistence                                 */
/* ------------------------------------------------------------------ */

export function emptySideCard(): SideScorecard {
  return { total: 0, hits: 0, results: [], pnlUsd: 0, pnlWhenHitUsd: 0, pnlWhenMissUsd: 0 };
}

export function emptyModelCard(model: ModelId): ModelScorecard {
  return {
    model,
    total: 0,
    hits: 0,
    results: [],
    sides: { long: emptySideCard(), short: emptySideCard() },
    pnl: { netUsd: 0, whenHitUsd: 0, whenMissUsd: 0 },
    history: [],
  };
}

export function defaultScoreStore(): ScoreStore {
  const models = {} as Record<ModelId, ModelScorecard>;
  for (const m of MODELS) models[m] = emptyModelCard(m);
  const tracks = {} as Record<SkillId, TrackState>;
  for (const t of TRACKS) tracks[t] = { results: [], hits: 0, total: 0 };
  // The merit weights start where vote.ts starts them (JEV leads, Kronos
  // halves, RF-DETR silent until wired) so the scorer's auto-tune begins
  // from the same baseline the vote store uses.
  const weights = {} as Record<SkillId, number>;
  for (const t of TRACKS) weights[t] = DEFAULT_WEIGHTS[t];
  return { version: 1, models, tracks, weights, updatedAt: "" };
}

function cloneCard(c: ModelScorecard): ModelScorecard {
  return {
    ...c,
    results: [...c.results],
    sides: {
      long: { ...c.sides.long, results: [...c.sides.long.results] },
      short: { ...c.sides.short, results: [...c.sides.short.results] },
    },
    pnl: { ...c.pnl },
    history: [...c.history],
  };
}

function cloneTrack(t: TrackState): TrackState {
  return { ...t, results: [...t.results] };
}

export function cloneStore(store: ScoreStore): ScoreStore {
  const models = {} as Record<ModelId, ModelScorecard>;
  for (const m of MODELS) models[m] = cloneCard(store.models?.[m] ?? emptyModelCard(m));
  const tracks = {} as Record<SkillId, TrackState>;
  for (const t of TRACKS) tracks[t] = cloneTrack(store.tracks?.[t] ?? { results: [], hits: 0, total: 0 });
  const weights = {} as Record<SkillId, number>;
  for (const t of TRACKS) {
    const w = store.weights?.[t];
    weights[t] = Number.isFinite(w) ? Math.min(Math.max(w as number, WEIGHT_FLOOR), WEIGHT_CAP) : 0;
  }
  return { version: 1, models, tracks, weights, updatedAt: store.updatedAt ?? "" };
}

function trimWindow(arr: boolean[]): void {
  if (arr.length > SCORE_WINDOW) arr.splice(0, arr.length - SCORE_WINDOW);
}

/** Store file path (score.json beside vote.json). */
export function scoreStorePath(dir?: string): string {
  return resolveStorePath(dir, "score.json", configDir());
}

function saneInt(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;
}

function saneResults(v: unknown): boolean[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is boolean => typeof r === "boolean").slice(-SCORE_WINDOW);
}

/** Load the score store; missing/corrupt files fall back to defaults (never throws). */
export function loadScoreStore(path: string): ScoreStore {
  return loadJsonStore(path, defaultScoreStore, (raw, store) => {
    const r = raw as Partial<ScoreStore>;
    const rawModels = r.models as Record<string, Partial<ModelScorecard>> | undefined;
    if (rawModels && typeof rawModels === "object") {
      for (const m of MODELS) {
        const c = rawModels[m];
        if (!c || typeof c !== "object") continue;
        const card = store.models[m]!;
        card.total = saneInt(c.total);
        card.hits = saneInt(c.hits);
        card.results = saneResults(c.results);
        card.history = Array.isArray(c.history)
          ? (c.history as ScoredOutcome[]).filter((h) => h && typeof h.pair === "string").slice(-SCORE_MAX_HISTORY)
          : [];
        for (const side of ["long", "short"] as DirectionalSide[]) {
          const s = (c.sides as Record<string, Partial<SideScorecard>> | undefined)?.[side];
          if (!s || typeof s !== "object") continue;
          card.sides[side].total = saneInt(s.total);
          card.sides[side].hits = saneInt(s.hits);
          card.sides[side].results = saneResults(s.results);
          card.sides[side].pnlUsd = Number.isFinite(s.pnlUsd) ? (s.pnlUsd as number) : 0;
          card.sides[side].pnlWhenHitUsd = Number.isFinite(s.pnlWhenHitUsd) ? (s.pnlWhenHitUsd as number) : 0;
          card.sides[side].pnlWhenMissUsd = Number.isFinite(s.pnlWhenMissUsd) ? (s.pnlWhenMissUsd as number) : 0;
        }
        const pnl = c.pnl;
        if (pnl && typeof pnl === "object") {
          card.pnl.netUsd = Number.isFinite(pnl.netUsd) ? pnl.netUsd : 0;
          card.pnl.whenHitUsd = Number.isFinite(pnl.whenHitUsd) ? pnl.whenHitUsd : 0;
          card.pnl.whenMissUsd = Number.isFinite(pnl.whenMissUsd) ? pnl.whenMissUsd : 0;
        }
      }
    }
    const rawTracks = r.tracks as Record<string, Partial<TrackState>> | undefined;
    if (rawTracks && typeof rawTracks === "object") {
      for (const t of TRACKS) {
        const s = rawTracks[t];
        if (!s || typeof s !== "object") continue;
        store.tracks[t] = { results: saneResults(s.results), hits: saneInt(s.hits), total: saneInt(s.total) };
      }
    }
    const rawWeights = r.weights as Record<string, unknown> | undefined;
    if (rawWeights && typeof rawWeights === "object") {
      for (const t of TRACKS) {
        const w = rawWeights[t];
        store.weights[t] = Number.isFinite(w) && (w as number) >= WEIGHT_FLOOR && (w as number) <= WEIGHT_CAP
          ? (w as number)
          : store.weights[t]!;
      }
    }
    store.updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : "";
  });
}

/** Persist the score store (creates the config dir; best-effort). */
export function saveScoreStore(path: string, store: ScoreStore): void {
  saveJsonStore(path, store);
}

/* ------------------------------------------------------------------ */
/* The bridge back into the vote store                                 */
/* ------------------------------------------------------------------ */

export type VoteTrackPatch = {
  track: SkillId;
  /** Rolling window (vote.ts SkillTrack.results). */
  results: boolean[];
  hits: number;
  total: number;
  /** The weight to write into store.weights[track]. */
  weight: number;
  /** True when every model on this track is excluded by the gate. */
  excluded: boolean;
  reason: string;
  /** The models that score against this track. */
  models: ModelId[];
};

/**
 * Pure: the exact fields the parent must write into vote.json so
 * vote.ts picks the change up:
 *
 *   store.weights[<track>]        <- patch.weight
 *   store.skills[<track>].results <- patch.results
 *   store.skills[<track>].hits    <- patch.hits
 *   store.skills[<track>].total   <- patch.total
 *
 * A track is excluded only when EVERY model that scores against it is
 * excluded by the gate (JEV and Laya share the JEV track, so one healthy
 * model keeps the track alive and the per-model gate stays visible in the
 * report).
 */
export function projectVotePatches(store: ScoreStore, opts: { minSamples?: number; hitFloor?: number } = {}): VoteTrackPatch[] {
  const gates = gatesFor(store, opts);
  return TRACKS.map((track) => {
    const models = TRACK_MODELS[track];
    const trackState = store.tracks[track] ?? { results: [], hits: 0, total: 0 };
    const merit = store.weights[track] ?? 0;
    const excluded = models.every((m) => !gates[m]!.eligible);
    const blockedBy = models.filter((m) => !gates[m]!.eligible).map((m) => gates[m]!.reason);
    return {
      track,
      // vote.ts's loader truncates a track's window to HISTORY_WINDOW on
      // read, so the patch carries the same last-20 slice — the parent
      // writes exactly what vote.ts will read back.
      results: trackState.results.slice(-SCORE_WINDOW),
      hits: trackState.hits,
      total: trackState.total,
      weight: excluded ? 0 : merit,
      excluded,
      reason: excluded
        ? `excluded — ${blockedBy.join("; ")}`
        : `eligible — ${models.filter((m) => gates[m]!.eligible).map((m) => m).join(", ")}`,
      models: [...models],
    };
  });
}

/**
 * Write the projected patches into a vote store (mode A — the scorer is
 * authoritative for the track and the weight).
 */
export function applyVotePatches(store: VoteStore, patches: readonly VoteTrackPatch[]): VoteStore {
  for (const p of patches) {
    const track = store.skills[p.track];
    if (!track) continue;
    track.results = [...p.results];
    track.hits = p.hits;
    track.total = p.total;
    store.weights[p.track] = p.weight;
  }
  return store;
}

/**
 * Mode B — vote.ts owns the track and the auto-tune; this only applies
 * the gate mask: a track whose models are all excluded gets weight 0. An
 * eligible track is left alone so vote.ts's auto-tune keeps the weight.
 */
export function applyGateMask(
  store: VoteStore,
  gates: Record<ModelId, GateDecision>,
): { track: SkillId; weight: number; excluded: boolean; reason: string }[] {
  const out: { track: SkillId; weight: number; excluded: boolean; reason: string }[] = [];
  for (const track of TRACKS) {
    const models = TRACK_MODELS[track];
    const excluded = models.every((m) => !gates[m]!.eligible);
    if (excluded) {
      store.weights[track] = 0;
      out.push({
        track,
        weight: 0,
        excluded: true,
        reason: models.map((m) => gates[m]!.reason).join("; "),
      });
    } else {
      out.push({ track, weight: store.weights[track] ?? 0, excluded: false, reason: "eligible — vote.ts auto-tune owns the weight" });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ballot -> entry context                                             */
/* ------------------------------------------------------------------ */

/** Pure: a vote.ts ballot becomes the entry context of a closed trade. */
export function signalsFromBallot(ballot: VoteRecord): ModelSignal[] {
  return ballot.signals.map((s) => ({
    model: s.skill as ModelId,
    side: s.abstained ? "flat" : s.side,
    confidence: s.confidence,
  }));
}

/** Pure: the trade context of a closed trade from a recorded ballot. */
export function tradeContextFromBallot(
  ballot: VoteRecord,
  trade: { side: DirectionalSide; netPnlUsd: number; at?: string },
): TradeContext {
  return {
    pair: ballot.pair,
    side: trade.side,
    signals: signalsFromBallot(ballot),
    netPnlUsd: trade.netPnlUsd,
    at: trade.at,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

const fmtInterval = (i: RateInterval): string =>
  i.low === null || i.high === null ? "—" : `[${pct(i.low)}–${pct(i.high)}]`;

const fmtRate = (rate: number | null, samples: number): string => {
  if (rate === null || samples === 0) return "—";
  return pct(rate);
};

/** Pure: the comparison report as text lines. */
export function formatComparison(rows: readonly ComparisonRow[]): string[] {
  const lines: string[] = [];
  lines.push(
    `MODEL PROMOTION GATE — eligible at >=${GATE_MIN_SAMPLES} scored outcomes AND rolling >=${pct(GATE_HIT_FLOOR)} (rolling window ${SCORE_WINDOW})`,
  );
  for (const r of rows) {
    const status = r.eligible ? "ELIGIBLE" : "EXCLUDED ";
    const rolling = r.rollingSamples === 0 ? "—" : `${fmtRate(r.rollingHitRate, r.rollingSamples)} ${fmtInterval(r.rollingInterval)}`;
    const lifetime = r.samples === 0 ? "—" : `${fmtRate(r.lifetimeHitRate, r.samples)} ${fmtInterval(r.lifetimeInterval)}`;
    lines.push(
      `  ${r.model.padEnd(7)} ${status}  w ${r.weight.toFixed(2)}  ${String(r.samples).padStart(4)} scored  rolling ${rolling.padEnd(18)} lifetime ${lifetime}`,
    );
    lines.push(`           ${r.reason}`);
    for (const s of r.sides) {
      const rate = s.hitRate === null ? "insufficient sample" : `${pct(s.hitRate)} (${s.hits}/${s.samples})`;
      lines.push(`           ${s.side.padEnd(5)} ${rate.padEnd(24)} pnl ${s.pnlUsd.toFixed(2)}`);
    }
  }
  return lines;
}

/** Pure: a holdout report as a text line. */
export function formatHoldout(report: HoldoutReport): string {
  const rate = report.samples === 0 ? "—" : pct(report.hitRate);
  const ci = report.low === null || report.high === null ? "—" : `[${pct(report.low)}–${pct(report.high)}]`;
  return `  ${report.model.padEnd(7)} holdout ${String(report.samples).padStart(3)} outcomes  ${rate.padEnd(6)} ${ci.padEnd(18)} ${report.verdict}`;
}

/* ------------------------------------------------------------------ */
/* Commands (read-only vs the market)                                  */
/* ------------------------------------------------------------------ */

export async function cmdScoreStats(opts: { json: boolean; storePath?: string }): Promise<void> {
  const store = loadScoreStore(opts.storePath ?? scoreStorePath());
  const rows = compareModels(store);
  const gates = gatesFor(store);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          gate: { minSamples: GATE_MIN_SAMPLES, hitFloor: GATE_HIT_FLOOR, window: SCORE_WINDOW, method: "wilson" },
          models: rows,
          gates,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of formatComparison(rows)) console.log(line);
}

export async function cmdScoreReport(opts: { json: boolean; storePath?: string; holdoutSize?: number }): Promise<void> {
  const store = loadScoreStore(opts.storePath ?? scoreStorePath());
  const rows = compareModels(store);
  const holdouts = LIVE_MODELS.map((m) => holdoutForModel(store, m, { holdoutSize: opts.holdoutSize }));
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          gate: { minSamples: GATE_MIN_SAMPLES, hitFloor: GATE_HIT_FLOOR, window: SCORE_WINDOW, method: "wilson" },
          models: rows,
          holdouts,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of formatComparison(rows)) console.log(line);
  console.log(`HOLDOUT — untuned window (${opts.holdoutSize ?? HOLDOUT_DEFAULT_SIZE} outcomes before the tuning window)`);
  for (const h of holdouts) console.log(formatHoldout(h));
}

export async function cmdScoreRecord(opts: {
  pair: string;
  side?: string;
  pnl: number;
  json: boolean;
  storePath?: string;
  voteStorePath?: string;
  voteStore?: VoteStore;
}): Promise<void> {
  const voteStore = opts.voteStore;
  if (!voteStore) {
    console.error("A vote store is required to resolve the entry context — nothing was scored.");
    process.exitCode = 2;
    return;
  }
  const pair = opts.pair.trim().toUpperCase();
  const ballot = [...voteStore.votes].reverse().find((v) => v.pair === pair);
  if (!ballot) {
    console.error(`No recorded ballot for ${pair} — nothing to score (the entry context is unknown).`);
    process.exitCode = 1;
    return;
  }
  const side: DirectionalSide = opts.side === "short" ? "short" : opts.side === "long" ? "long" : ballot.side === "short" ? "short" : "long";
  const trade = tradeContextFromBallot(ballot, { side, netPnlUsd: opts.pnl, at: new Date().toISOString() });
  const store = loadScoreStore(opts.storePath ?? scoreStorePath());
  const result = scoreTrade(store, trade);
  if (!result.ok) {
    console.error(`Failed: ${result.error ?? "trade not scorable"} — nothing was scored.`);
    process.exitCode = 1;
    return;
  }
  result.store.updatedAt = new Date().toISOString();
  try {
    saveScoreStore(opts.storePath ?? scoreStorePath(), result.store);
  } catch (e) {
    console.error(`Warning: score not persisted (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (opts.json) {
    console.log(JSON.stringify({ pair, side, outcome: result.outcome, scored: result.scored, skipped: result.skipped, gates: result.gates }, null, 2));
    return;
  }
  console.log(`SCORED ${pair} — ${side.toUpperCase()} closed ${result.outcome.toUpperCase()} (net ${opts.pnl.toFixed(2)})`);
  for (const s of result.scored) console.log(`  ${s.model.padEnd(7)} ${s.side.padEnd(5)} conf ${s.confidence.toFixed(2)}  ${s.hit ? "hit" : "miss"}`);
  for (const s of result.skipped) console.log(`  ${s.model.padEnd(7)} skipped — ${s.reason}`);
  for (const line of formatComparison(compareModels(result.store))) console.log(line);
}
