/**
 * The ONE weighting module of the verdict stack (OQ-09).
 *
 * Every seat that weighs model reads goes through here instead of its own
 * copy: the oracle ballot degen reads for its live direction, and the
 * learning loop (`learning.ts`) that tunes the vote.json tracks. This
 * module owns:
 *
 *   - the ballot: model read → signed, confidence-weighted signal
 *     (`jevToSignal`, `kronosToSignal`, `layaToSignal`, `rfdetrSignal`)
 *     and the ONE confidence-weighted combine (`combineBallot`);
 *   - the track mapping: which vote.json track each model votes with and
 *     is scored against (`MODEL_TRACK` — Laya inherits the JEV track);
 *   - the auto-tune rule (`tuneWeight`) and the rolling hit-rate
 *     (`rollingHitRate`) every track runs;
 *   - the vote.json weights → oracle-ballot weights mapping.
 *
 * Every weight and threshold comes from the rubric (`VERDICT_TUNING`,
 * the single tuning surface); nothing here restates a value. Pure: no
 * I/O, no clock. The per-track records live in `track-store.ts`.
 */
import { VERDICT_TUNING } from "./rubric.js";
import { rfdetrBoxesToSignal, type RfdetrVerdict } from "./rfdetr.js";
import type { TrendVerdict } from "./analyze.js";
import type { ForecastVerdict } from "./forecast.js";
import type { LayaVerdict } from "./decide.js";

const BALLOT = VERDICT_TUNING.ballot;
const TUNE = VERDICT_TUNING.autoTune;

/* ------------------------------------------------------------------ */
/* Ids and the track mapping                                           */
/* ------------------------------------------------------------------ */

export type BallotSide = "long" | "short" | "flat";

/** The vote.json weight slots (tracks). */
export type SkillId = "jev" | "kronos" | "rfdetr";
export const SKILLS: SkillId[] = ["jev", "kronos", "rfdetr"];

/** The oracle ballot's skills (Laya is the decision leg on the JEV track). */
export type OracleSkill = "kronos" | "laya" | "rfdetr";
export const ORACLE_SKILLS: OracleSkill[] = ["kronos", "laya", "rfdetr"];

/** Degen's live direction comes from this ballot (kept when the oracle command retired). */
export type OracleSide = BallotSide;
export type OracleSignal = Ballot<OracleSkill>;
export type OracleBreakdown = BallotBreakdown<OracleSkill>;
export type OracleVerdict = BallotVerdict<OracleSkill>;

/** Every model a seat hears from. */
export type ModelId = "jev" | "laya" | "kronos" | "rfdetr";
export const MODELS: ModelId[] = ["jev", "laya", "kronos", "rfdetr"];

/**
 * Model → the track it votes with and is scored against. Laya inherits the
 * JEV track: it is the decision leg that supersedes the raw JEV trend (it
 * fuses JEV + tape + book), so the two share one weight slot.
 */
export const MODEL_TRACK: Record<ModelId, SkillId> = {
  jev: "jev",
  laya: "jev",
  kronos: "kronos",
  rfdetr: "rfdetr",
};

/** Track → the models that score against it, in model order (the scorer's gate set). */
export const TRACK_MODELS: Record<SkillId, ModelId[]> = {
  jev: MODELS.filter((m) => MODEL_TRACK[m] === "jev"),
  kronos: MODELS.filter((m) => MODEL_TRACK[m] === "kronos"),
  rfdetr: MODELS.filter((m) => MODEL_TRACK[m] === "rfdetr"),
};

/**
 * Track → the models that feed its rolling window, in priority: a model
 * that INHERITS the track (Laya on the JEV track) feeds it first, the
 * track's own model is the fallback — one trade contributes at most one
 * outcome per track (the learning loop's rule).
 */
export const TRACK_FEED_PRIORITY: Record<SkillId, ModelId[]> = {
  jev: [...TRACK_MODELS.jev.filter((m) => m !== "jev"), ...TRACK_MODELS.jev.filter((m) => m === "jev")],
  kronos: [...TRACK_MODELS.kronos.filter((m) => m !== "kronos"), ...TRACK_MODELS.kronos.filter((m) => m === "kronos")],
  rfdetr: [...TRACK_MODELS.rfdetr.filter((m) => m !== "rfdetr"), ...TRACK_MODELS.rfdetr.filter((m) => m === "rfdetr")],
};

/* ------------------------------------------------------------------ */
/* The ballot                                                          */
/* ------------------------------------------------------------------ */

export type Ballot<S extends string> = {
  skill: S;
  side: BallotSide;
  /** 0..1 directional conviction. 0 when abstained. */
  confidence: number;
  abstained: boolean;
  detail: string;
};

export type BallotBreakdown<S extends string> = {
  skill: S;
  side: BallotSide;
  confidence: number;
  weight: number;
  contribution: number;
  abstained: boolean;
};

export type BallotVerdict<S extends string> = {
  side: BallotSide;
  /** Confidence-weighted mean in [-1, 1] (+long / −short). 0 when nobody votes. */
  score: number;
  voters: number;
  breakdown: BallotBreakdown<S>[];
  reason: string;
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

/**
 * Pure: THE confidence-weighted ballot. score = Σ(side·conf·w) / Σ(w) over
 * the voting skills; zero-weight and abstained skills sit out (they neither
 * push the score nor dilute the denominator); |score| at or above the
 * rubric's consensus threshold decides long/short, anything weaker is flat.
 * Empty ballot → flat with a reason (`every <noun> abstained`), never a
 * fabricated direction.
 */
export function combineBallot<S extends string>(
  signals: Ballot<S>[],
  weights: Record<S, number>,
  noun: "skill" | "model",
): BallotVerdict<S> {
  const breakdown: BallotBreakdown<S>[] = signals.map((s) => {
    const w = weights[s.skill] ?? 0;
    const voting = !s.abstained && w > 0;
    const dir = s.side === "long" ? 1 : s.side === "short" ? -1 : 0;
    return {
      skill: s.skill,
      side: s.side,
      confidence: s.confidence,
      weight: w,
      contribution: voting ? dir * s.confidence * w : 0,
      abstained: !voting,
    };
  });
  const voters = breakdown.filter((b) => !b.abstained);
  if (voters.length === 0) {
    return { side: "flat", score: 0, voters: 0, breakdown, reason: `no consensus — every ${noun} abstained` };
  }
  const num = voters.reduce((a, b) => a + b.contribution, 0);
  const den = voters.reduce((a, b) => a + b.weight, 0);
  const score = den > 0 ? num / den : 0;
  const threshold = BALLOT.consensusThreshold;
  const side: BallotSide = score >= threshold ? "long" : score <= -threshold ? "short" : "flat";
  const reason =
    side === "flat"
      ? `weighted score ${score.toFixed(2)} inside ±${threshold} — no consensus`
      : `weighted score ${score.toFixed(2)} decides ${side.toUpperCase()}`;
  return { side, score, voters: voters.length, breakdown, reason };
}

/**
 * Pure: JEV trend → ballot. Only directional verdicts vote — uncertain,
 * neutral, or unknown verdicts abstain (no directional edge to count).
 */
export function jevToSignal(t: TrendVerdict | null): Ballot<"jev"> {
  const abstain = (detail: string): Ballot<"jev"> => ({ skill: "jev", side: "flat", confidence: 0, abstained: true, detail });
  if (!t) return abstain("no trend verdict returned");
  const trend = t.verdict?.trend;
  if (!trend) return abstain("no trend verdict returned");
  if (trend.uncertain) return abstain("timeframes conflict — no signal, not a call");
  const v = trend.verdict.toLowerCase();
  const conf = clamp01(trend.agreement);
  // The server's verdict vocabulary is long/short/strong_long/strong_short
  // (combineTrendVerdict in edge _shared/jev.ts) — NOT bull/bear. Matching
  // only "bull"/"bear" made JEV abstain on every directional verdict, so the
  // primary oracle silently never voted. Accept both vocabularies.
  if (v.includes("bull") || v.includes("long")) {
    return { skill: "jev", side: "long", confidence: conf, abstained: false, detail: trend.verdict };
  }
  if (v.includes("bear") || v.includes("short")) {
    return { skill: "jev", side: "short", confidence: conf, abstained: false, detail: trend.verdict };
  }
  return abstain(`neutral verdict (${trend.verdict}) — no directional edge`);
}

/**
 * Pure: Kronos oracle → ballot. up/down vote with conviction scaled from
 * the expected move (the rubric's full-conviction move and conviction
 * floor); flat abstains — a no-move call is not a direction.
 */
export function kronosToSignal(v: ForecastVerdict | null): Ballot<"kronos"> {
  const abstain = (detail: string): Ballot<"kronos"> => ({ skill: "kronos", side: "flat", confidence: 0, abstained: true, detail });
  if (!v) return abstain("no kronos verdict");
  if (v.direction === "flat") return abstain(`flat (expected ${v.expected_move_pct.toFixed(2)}%) — no direction`);
  const conf = Math.min(Math.max(Math.abs(v.expected_move_pct) / BALLOT.kronosFullMovePct, BALLOT.kronosMinConviction), 1);
  return {
    skill: "kronos",
    side: v.direction === "up" ? "long" : "short",
    confidence: conf,
    abstained: false,
    detail: `${v.direction} ${v.expected_move_pct.toFixed(2)}% over ${v.horizon}x15m`,
  };
}

/**
 * Pure: Laya verdict → ballot. long/short vote with the bridge's
 * (JEV-capped) confidence; flat abstains — a no-call is not a direction.
 */
export function layaToSignal(v: LayaVerdict | null): Ballot<"laya"> {
  const abstain = (detail: string): Ballot<"laya"> => ({ skill: "laya", side: "flat", confidence: 0, abstained: true, detail });
  if (!v) return abstain("no laya verdict");
  if (v.choice === "flat") return abstain("flat — no direction");
  const conf = Number.isFinite(v.confidence) ? Math.min(Math.max(v.confidence, 0), 1) : 0;
  return { skill: "laya", side: v.choice, confidence: conf, abstained: false, detail: `${v.choice} conf ${conf.toFixed(2)} · ${v.reasons[0] ?? "no reason"}` };
}

/**
 * RF-DETR chart-vision ballot — abstains without a verdict. Wiring point:
 * pass the bridge verdict (see rfdetr.ts fetchRfdetrBoxes) and the top
 * pattern box votes with its score; the auto-tune promotes the weight off
 * 0 on scored merit.
 */
export function rfdetrSignal(verdict?: RfdetrVerdict | null): Ballot<"rfdetr"> {
  if (verdict === undefined) {
    return {
      skill: "rfdetr",
      side: "flat",
      confidence: 0,
      abstained: true,
      detail: "chart-vision model not wired (weight 0)",
    };
  }
  const b = rfdetrBoxesToSignal(verdict);
  return { skill: "rfdetr", side: b.side, confidence: b.confidence, abstained: b.abstained, detail: b.detail };
}

/**
 * RF-DETR oracle ballot without a chart — abstains with the vote ballot's
 * reason, so both ballots agree.
 */
export function rfdetrOracleSignal(): Ballot<"rfdetr"> {
  const s = rfdetrSignal();
  return { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: s.detail };
}

/* ------------------------------------------------------------------ */
/* Weights                                                             */
/* ------------------------------------------------------------------ */

/** The ballot-open weights (rubric), per vote.json track. */
export const DEFAULT_WEIGHTS: Record<SkillId, number> = BALLOT.defaultWeights;

/**
 * Pure: vote.json track weights → oracle-ballot weights. Laya votes with
 * the JEV track (MODEL_TRACK); Kronos and RF-DETR map straight across. A
 * missing slot falls back to the rubric's ballot-open weight.
 */
export function oracleWeights(weights: Record<SkillId, number>): Record<OracleSkill, number> {
  return {
    kronos: weights[MODEL_TRACK.kronos] ?? DEFAULT_WEIGHTS[MODEL_TRACK.kronos],
    laya: weights[MODEL_TRACK.laya] ?? DEFAULT_WEIGHTS[MODEL_TRACK.laya],
    rfdetr: weights[MODEL_TRACK.rfdetr] ?? DEFAULT_WEIGHTS[MODEL_TRACK.rfdetr],
  };
}

/** The oracle-ballot weights before any track is tuned. */
export const DEFAULT_ORACLE_WEIGHTS: Record<OracleSkill, number> = oracleWeights(DEFAULT_WEIGHTS);

/** Pure: clamp a weight into the rubric's [floor, cap] band (a NaN stays NaN). */
export function clampWeight(w: number): number {
  return Math.min(Math.max(w, TUNE.floor), TUNE.cap);
}

/**
 * Pure: rolling-window hit rate, or null when the window is empty.
 * A null is NOT 0% — an empty window means "not measured yet".
 */
export function rollingHitRate(results: readonly boolean[]): number | null {
  if (!results || results.length === 0) return null;
  return results.filter(Boolean).length / results.length;
}

/**
 * Pure: THE auto-tune rule. `results` is the track's window AFTER the new
 * outcome was pushed. With at least the rubric's minimum samples, a
 * rolling rate at/above `promoteAt` steps the weight up (capped), at/below
 * `demoteAt` steps it down (floored); the result is rounded to 2dp.
 */
export function tuneWeight(before: number, results: readonly boolean[]): number {
  const rate = rollingHitRate(results);
  let after = before;
  if (results.length >= TUNE.minSamples && rate !== null) {
    if (rate >= TUNE.promoteAt) after = Math.min(TUNE.cap, before + TUNE.step);
    else if (rate <= TUNE.demoteAt) after = Math.max(TUNE.floor, before - TUNE.step);
  }
  return Math.round(after * 100) / 100;
}
