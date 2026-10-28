/**
 * `jw3 learning` — close the loop from a CLOSED trade back to the models
 * that produced it (local ledgers only: it never touches the venue).
 *
 * `vote.ts` casts a ballot and scores a RESOLVED BALLOT (model side vs
 * model side). That is not the same measurement: a ballot can be right
 * about direction and still lose money, and a trade can be closed by a
 * kill line that no model called. This module scores the CLOSED TRADE
 * (realized net P&L) and banks the full entry context, so oracle weights
 * are earned from measured outcomes instead of assumed.
 *
 * One closed trade → one JSON line in ~/.config/jw3/learning.jsonl (the
 * degen-learning.jsonl convention). The line carries:
 *   - the trade: pair, side, entry, exit, exit reason, gross P&L, fees,
 *     net P&L, holding time
 *   - the signals that fired at entry: JEV (side + agreement), Laya
 *     (choice + confidence), Kronos (direction + conviction), each with
 *     the version of the model that produced it
 *   - the tape at entry: ATR%, volume ratio, book imbalance, off-high %,
 *     off-low %
 *   - the pre-entry 400x15m window pointer (the repo's finetune-loop
 *     convention: every closed trade banks the window a finetune replays)
 *
 * SCORING: for every model that VOTED, was its direction right? A long is
 * right when the trade's NET P&L > 0, a short when it is < 0. A model that
 * abstained is NOT scored — an abstention is silence, not a miss, and
 * scoring it would dilute the very hit-rate it is measured on.
 *
 * PROMOTION GATE (earn the seat): a model keeps voting rights only with
 * >= GATE_MIN_SAMPLES scored outcomes AND a lifetime hit-rate >=
 * GATE_MIN_HIT_RATE. Below the bar its live weight is forced to 0 and the
 * reason is logged — this is how Kronos was demoted at a measured 37.5%.
 * The gate writes into the SAME vote.json store the live ballot reads
 * (`weights`), so an excluded model cannot vote on real money.
 *
 * MODEL-PAIRS: a dissenting third model is information, not a veto — so
 * the ledger scores every pair (how good their agreement was, who is
 * systematically right when the pair splits) and every dissenter (how
 * often the dissent itself was right).
 *
 * Compaction keeps the log bounded: the tail records are kept verbatim and
 * everything older folds into one ledger snapshot line, so the lifetime
 * counters survive the trim.
 *
 * Pure core: `buildLearningRecord`, `summarizeLearningLog`,
 * `appendRecordToLog`, `compactLearningLog`, `syncVoteStore` and
 * `applyPromotionGate` are pure over injected text/objects. The `cmd*`
 * wrappers are the thin filesystem shell around them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_WINDOW,
  WEIGHT_CAP,
  WEIGHT_FLOOR,
  loadStore,
  normalizeVotePair,
  recordOutcome,
  saveStore,
  validateVotePair,
  voteStorePath,
  type SkillId,
  type VoteStore,
} from "./vote.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** The models this loop measures. JEV/Laya/Kronos vote live; RF-DETR abstains until wired. */
export type LearningModelId = "jev" | "laya" | "kronos" | "rfdetr";
export const LEARNING_MODELS: LearningModelId[] = ["jev", "laya", "kronos", "rfdetr"];

/** The three weight slots vote.json carries. */
export const LEARNING_TRACKS: SkillId[] = ["jev", "kronos", "rfdetr"];

/**
 * Which learning models feed which vote.json weight slot, in priority.
 *
 * oracle.ts's `oracleWeightsFromStore` gives Laya the JEV slot (the
 * decision leg supersedes the raw trend leg), so the JEV slot is fed by
 * Laya first and falls back to the raw JEV trend when Laya abstained —
 * one trade contributes at most ONE outcome per slot, so a slot's rolling
 * window stays a window over trades, not over model-reads.
 */
export const TRACK_MODELS: Record<SkillId, LearningModelId[]> = {
  jev: ["laya", "jev"],
  kronos: ["kronos"],
  rfdetr: ["rfdetr"],
};

/** Model versions recorded per signal when the caller does not supply one. */
export const DEFAULT_MODEL_VERSIONS: Record<LearningModelId, string> = {
  jev: "jev-7tf",
  laya: "laya-v0",
  kronos: "kronos-small:pretrained",
  rfdetr: "rfdetr-nano",
};

/** Kronos reports whether finetuned weights were loaded — the version must say so. */
export function kronosVersion(finetuned: boolean): string {
  return finetuned ? "kronos-small:finetuned" : "kronos-small:pretrained";
}

/** Pre-entry window shape: 400 bars x 15m (forecast.ts FORECAST_LOOKBACK / FORECAST_GRANULARITY_MIN). */
export const LEARNING_WINDOW_BARS = 400;
export const LEARNING_WINDOW_MINUTES = 15;

/** Promotion gate: a model votes on real money only past both bars. */
export const GATE_MIN_SAMPLES = 30;
export const GATE_MIN_HIT_RATE = 0.55;
/** Weight a model that earned the seat starts from (one auto-tune step). */
export const GATE_SEAT_WEIGHT = 0.1;

/** A pair must split this many times before "systematically right" is claimed. */
export const MIN_SPLIT_SAMPLES = 5;
/** A dissenter needs this many dissents before its dissent rate means anything. */
export const MIN_DISSENT_SAMPLES = 5;
/** A dissenter is "systematically wrong" above this share of wrong dissents. */
export const DISSENT_WRONG_RATE = 0.6;

/** Compaction: fold the log into a snapshot past this many trade records, keeping the tail. */
export const LEARNING_COMPACT_AT = 500;
export const LEARNING_COMPACT_KEEP = 200;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type LearningSide = "long" | "short";

/**
 * One model's read at entry. `side`/`confidence`/`abstained` are the
 * normalized fields the scorer reads; the model-specific fields keep the
 * raw bridge output so the log stays a faithful dataset.
 */
export type LearningSignal = {
  model: LearningModelId;
  /** Normalized direction (flat = no direction = abstention). */
  side: "long" | "short" | "flat";
  /** 0..1 conviction. 0 when abstained. */
  confidence: number;
  abstained: boolean;
  /** The version of the model that produced this read. */
  version: string;
  detail?: string;
  /** JEV: 7-timeframe agreement 0..1. */
  agreement?: number;
  /** Laya: the bridge's raw choice. */
  choice?: "long" | "short" | "flat";
  /** Kronos: the bridge's raw direction (up/down/flat). */
  direction?: "up" | "down" | "flat";
  /** Kronos: conviction 0..1 (expected move magnitude). */
  conviction?: number;
};

/** Tape features measured at entry. Null = unmeasured, never a fabricated 0. */
export type LearningTape = {
  atrPct: number | null;
  vratio: number | null;
  bookImb: number | null;
  offHighPct: number | null;
  offLowPct: number | null;
};

/** Pointer to the pre-entry window a future finetune replays. */
export type LearningWindow = {
  lookback: number;
  granularityMin: number;
  bars: number;
  from: string;
  to: string;
  symbol?: string;
};

export type LearningTradeContext = {
  entry: number;
  exit: number;
  exitReason: string;
  /** Gross P&L as reported. */
  pnlUsd: number;
  /** Total fees paid (entry + exit). */
  feesUsd: number;
  /** Net P&L — pnlUsd - feesUsd unless the caller overrides with a venue figure. */
  netPnlUsd: number;
  holdingMs: number | null;
  openedAt?: string;
  closedAt?: string;
};

export type LearningRecord = {
  /** Schema version — bump on any breaking field change. */
  v: 1;
  kind: "learning.trade";
  /** UTC timestamp of the record. */
  at: string;
  pair: string;
  side: LearningSide;
  exchange?: string;
  trade: LearningTradeContext;
  /** Every model is present (abstentions included) so the shape is stable. */
  signals: Record<LearningModelId, LearningSignal>;
  tape: LearningTape;
  window: LearningWindow | null;
  outcome: {
    /** The trade's direction. */
    direction: LearningSide;
    netPnlUsd: number;
    /** Model → hit. Absent = abstained (NOT scored). */
    scored: Partial<Record<LearningModelId, boolean>>;
    /** Models that abstained — recorded so they are never scored later. */
    abstained: LearningModelId[];
  };
};

export type LearningRecordInput = {
  pair: string;
  side: LearningSide;
  entry: number;
  exit: number;
  exitReason: string;
  pnlUsd: number;
  feesUsd: number;
  /** Optional override when the venue reports P&L already net of fees. */
  netPnlUsd?: number;
  holdingMs?: number | null;
  openedAt?: string;
  closedAt?: string;
  exchange?: string;
  signals?: Partial<Record<LearningModelId, LearningSignal>>;
  tape?: Partial<LearningTape>;
  window?: LearningWindow | null;
  /** Entry timestamp (ms) used to derive the pre-entry window pointer. */
  entryAtMs?: number;
  at?: string;
};

/* ------------------------------------------------------------------ */
/* Signal builders (pure)                                              */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

function signal(model: LearningModelId, over: Partial<LearningSignal> = {}): LearningSignal {
  const side = over.side ?? "flat";
  const abstained = over.abstained === true || side === "flat";
  return {
    model,
    side,
    confidence: abstained ? 0 : clamp01(over.confidence ?? 0),
    abstained,
    version: over.version ?? DEFAULT_MODEL_VERSIONS[model],
    ...(over.detail !== undefined ? { detail: over.detail } : {}),
    ...(over.agreement !== undefined ? { agreement: clamp01(over.agreement) } : {}),
    ...(over.choice !== undefined ? { choice: over.choice } : {}),
    ...(over.direction !== undefined ? { direction: over.direction } : {}),
    ...(over.conviction !== undefined ? { conviction: clamp01(over.conviction) } : {}),
  };
}

/** JEV read: side + 7-timeframe agreement. */
export function jevSignal(
  side: "long" | "short" | "flat",
  agreement: number,
  over: Partial<LearningSignal> = {},
): LearningSignal {
  return signal("jev", { ...over, side, confidence: over.confidence ?? agreement, agreement });
}

/** Laya read: the bridge's choice + calibrated confidence. */
export function layaSignal(
  choice: "long" | "short" | "flat",
  confidence: number,
  over: Partial<LearningSignal> = {},
): LearningSignal {
  return signal("laya", { ...over, side: choice, confidence, choice });
}

/** Kronos read: the bridge's direction + conviction (|expected move|). */
export function kronosSignal(
  direction: "up" | "down" | "flat",
  conviction: number,
  over: Partial<LearningSignal> = {},
): LearningSignal {
  const side = direction === "up" ? "long" : direction === "down" ? "short" : "flat";
  return signal("kronos", { ...over, side, confidence: conviction, direction, conviction });
}

/** RF-DETR read (chart vision) — abstains until the model is wired. */
export function rfdetrLearningSignal(
  side: "long" | "short" | "flat" = "flat",
  over: Partial<LearningSignal> = {},
): LearningSignal {
  return signal("rfdetr", { ...over, side });
}

/* ------------------------------------------------------------------ */
/* Validation + construction (pure)                                    */
/* ------------------------------------------------------------------ */

/** Normalize a pair the way vote.ts does (BASE/USDT, uppercase). */
export function normalizeLearningPair(pair: string): string {
  return normalizeVotePair(pair);
}

/** Null = usable; otherwise the human reason (the caller exits 2, nothing recorded). */
export function validateLearningInput(input: LearningRecordInput): string | null {
  const pairErr = validateVotePair(input.pair);
  if (pairErr) return pairErr;
  if (input.side !== "long" && input.side !== "short") return "side must be long|short";
  if (!Number.isFinite(input.entry) || !(input.entry > 0)) return "entry must be a number > 0";
  if (!Number.isFinite(input.exit) || !(input.exit > 0)) return "exit must be a number > 0";
  if (!Number.isFinite(input.pnlUsd)) return "pnl must be a number";
  if (!Number.isFinite(input.feesUsd) || input.feesUsd < 0) return "fees must be a number >= 0";
  if (input.netPnlUsd !== undefined && !Number.isFinite(input.netPnlUsd)) return "net pnl must be a number";
  if (input.holdingMs !== undefined && input.holdingMs !== null && !Number.isFinite(input.holdingMs)) {
    return "holding time must be a number of milliseconds";
  }
  const reason = String(input.exitReason ?? "").trim().toLowerCase();
  if (!reason) return "exit reason required (tp|sl|kill|scratch|trail|manual|…)";
  return null;
}

/** Derive the pre-entry window pointer from the entry timestamp. */
export function preEntryWindow(
  entryAtMs: number,
  over: Partial<LearningWindow> = {},
): LearningWindow {
  const spanMs = LEARNING_WINDOW_BARS * LEARNING_WINDOW_MINUTES * 60 * 1000;
  return {
    lookback: LEARNING_WINDOW_BARS,
    granularityMin: LEARNING_WINDOW_MINUTES,
    bars: LEARNING_WINDOW_BARS,
    from: new Date(entryAtMs - spanMs).toISOString(),
    to: new Date(entryAtMs).toISOString(),
    ...over,
  };
}

/** Pure: was a model's direction right? A long needs net P&L > 0, a short net P&L < 0. */
export function scoreDirection(side: "long" | "short", netPnlUsd: number): boolean {
  if (!Number.isFinite(netPnlUsd)) throw new Error("net pnl must be finite to score a direction");
  return side === "long" ? netPnlUsd > 0 : netPnlUsd < 0;
}

/**
 * Pure: build the closed-trade learning record (stable schema + UTC stamp).
 * The scorer runs here: every model that voted gets a hit/miss, every
 * abstention is recorded as an abstention and NOT scored.
 */
export function buildLearningRecord(
  input: LearningRecordInput,
  opts: { now?: () => number } = {},
): LearningRecord {
  const err = validateLearningInput(input);
  if (err) throw new Error(`bad learning record: ${err}`);
  const nowMs = opts.now ? opts.now() : Date.now();
  const at = input.at ?? new Date(nowMs).toISOString();
  const netPnlUsd = input.netPnlUsd ?? input.pnlUsd - input.feesUsd;
  const exitReason = String(input.exitReason).trim().toLowerCase();

  const signals = {} as Record<LearningModelId, LearningSignal>;
  for (const m of LEARNING_MODELS) {
    signals[m] = input.signals?.[m] ?? signal(m);
  }

  const scored: Partial<Record<LearningModelId, boolean>> = {};
  const abstained: LearningModelId[] = [];
  for (const m of LEARNING_MODELS) {
    const s = signals[m]!;
    if (s.abstained || (s.side !== "long" && s.side !== "short")) {
      abstained.push(m);
      continue;
    }
    scored[m] = scoreDirection(s.side, netPnlUsd);
  }

  const window =
    input.window ??
    (input.entryAtMs !== undefined && Number.isFinite(input.entryAtMs)
      ? preEntryWindow(input.entryAtMs)
      : null);

  const tape: LearningTape = {
    atrPct: input.tape?.atrPct ?? null,
    vratio: input.tape?.vratio ?? null,
    bookImb: input.tape?.bookImb ?? null,
    offHighPct: input.tape?.offHighPct ?? null,
    offLowPct: input.tape?.offLowPct ?? null,
  };

  return {
    v: 1,
    kind: "learning.trade",
    at,
    pair: normalizeLearningPair(input.pair),
    side: input.side,
    ...(input.exchange ? { exchange: input.exchange } : {}),
    trade: {
      entry: input.entry,
      exit: input.exit,
      exitReason,
      pnlUsd: input.pnlUsd,
      feesUsd: input.feesUsd,
      netPnlUsd,
      holdingMs: input.holdingMs ?? null,
      ...(input.openedAt ? { openedAt: input.openedAt } : {}),
      ...(input.closedAt ? { closedAt: input.closedAt } : {}),
    },
    signals,
    tape,
    window,
    outcome: {
      direction: input.side,
      netPnlUsd,
      scored,
      abstained,
    },
  };
}

/** Which model supplies a vote.json slot's outcome for this trade. */
export function trackOutcomeSource(
  rec: LearningRecord,
  track: SkillId,
): { model: LearningModelId; hit: boolean } | null {
  for (const m of TRACK_MODELS[track]) {
    const hit = rec.outcome.scored[m];
    if (typeof hit === "boolean") return { model: m, hit };
  }
  return null;
}

/** One trade record → the outcome a vote.json slot records (first voting candidate wins). */
export function trackOutcome(rec: LearningRecord, track: SkillId): boolean | null {
  return trackOutcomeSource(rec, track)?.hit ?? null;
}

/* ------------------------------------------------------------------ */
/* Ledger accumulation (pure)                                          */
/* ------------------------------------------------------------------ */

type ModelAcc = { hits: number; total: number; window: boolean[] };
type TrackAcc = {
  hits: number;
  total: number;
  window: boolean[];
  /** How many outcomes each model supplied to this slot. */
  contrib: Record<LearningModelId, number>;
};
type SideCounters = {
  bothVoted: number;
  agreed: number;
  agreedRight: number;
  disagreed: number;
  aRight: number;
  bRight: number;
  neither: number;
};
type PairAcc = { total: SideCounters; bySide: Record<"long" | "short", SideCounters> };
type DissentAcc = {
  dissents: number;
  right: number;
  wrong: number;
  consensusRight: number;
  consensusWrong: number;
};
type LedgerAcc = {
  records: number;
  models: Record<LearningModelId, ModelAcc>;
  tracks: Record<SkillId, TrackAcc>;
  pairs: Record<string, PairAcc>;
  dissents: Record<LearningModelId, DissentAcc>;
};

const emptyCounters = (): SideCounters => ({
  bothVoted: 0,
  agreed: 0,
  agreedRight: 0,
  disagreed: 0,
  aRight: 0,
  bRight: 0,
  neither: 0,
});

const emptyLedger = (): LedgerAcc => {
  const models = {} as Record<LearningModelId, ModelAcc>;
  for (const m of LEARNING_MODELS) models[m] = { hits: 0, total: 0, window: [] };
  const tracks = {} as Record<SkillId, TrackAcc>;
  for (const t of LEARNING_TRACKS) {
    const contrib = {} as Record<LearningModelId, number>;
    for (const m of LEARNING_MODELS) contrib[m] = 0;
    tracks[t] = { hits: 0, total: 0, window: [], contrib };
  }
  const dissents = {} as Record<LearningModelId, DissentAcc>;
  for (const m of LEARNING_MODELS) {
    dissents[m] = { dissents: 0, right: 0, wrong: 0, consensusRight: 0, consensusWrong: 0 };
  }
  return { records: 0, models, tracks, pairs: {}, dissents };
};

const pairKey = (a: LearningModelId, b: LearningModelId): string => `${a}|${b}`;

function pairAccFor(acc: LedgerAcc, a: LearningModelId, b: LearningModelId): PairAcc {
  const key = pairKey(a, b);
  let p = acc.pairs[key];
  if (!p) {
    p = { total: emptyCounters(), bySide: { long: emptyCounters(), short: emptyCounters() } };
    acc.pairs[key] = p;
  }
  return p;
}

function rollWindow(window: boolean[], hit: boolean): void {
  window.push(hit);
  if (window.length > HISTORY_WINDOW) window.splice(0, window.length - HISTORY_WINDOW);
}

function updateCounters(
  c: SideCounters,
  sideA: string,
  sideB: string,
  hitA: boolean,
  hitB: boolean,
): void {
  c.bothVoted += 1;
  if (sideA === sideB) {
    c.agreed += 1;
    if (hitA) c.agreedRight += 1;
    return;
  }
  c.disagreed += 1;
  if (hitA) c.aRight += 1;
  else if (hitB) c.bRight += 1;
  else c.neither += 1;
}

/** The hit a side would have earned on this trade (used to score the consensus side). */
function sideHit(rec: LearningRecord, side: "long" | "short"): boolean {
  return scoreDirection(side, rec.outcome.netPnlUsd);
}

/** Fold one trade record into the ledger. */
export function applyRecordToLedger(acc: LedgerAcc, rec: LearningRecord): void {
  acc.records += 1;

  for (const m of LEARNING_MODELS) {
    const hit = rec.outcome.scored[m];
    if (typeof hit !== "boolean") continue;
    const a = acc.models[m]!;
    a.total += 1;
    if (hit) a.hits += 1;
    rollWindow(a.window, hit);
  }

  for (const track of LEARNING_TRACKS) {
    const src = trackOutcomeSource(rec, track);
    if (!src) continue;
    const a = acc.tracks[track]!;
    a.total += 1;
    if (src.hit) a.hits += 1;
    a.contrib[src.model] += 1;
    rollWindow(a.window, src.hit);
  }

  const voted = LEARNING_MODELS.filter((m) => typeof rec.outcome.scored[m] === "boolean");
  for (let i = 0; i < voted.length; i++) {
    for (let j = i + 1; j < voted.length; j++) {
      const a = voted[i]!;
      const b = voted[j]!;
      const sideA = rec.signals[a]!.side;
      const sideB = rec.signals[b]!.side;
      const hitA = rec.outcome.scored[a] === true;
      const hitB = rec.outcome.scored[b] === true;
      const p = pairAccFor(acc, a, b);
      updateCounters(p.total, sideA, sideB, hitA, hitB);
      updateCounters(p.bySide[rec.side], sideA, sideB, hitA, hitB);
    }
  }

  for (const m of voted) {
    const others = voted.filter((o) => o !== m);
    if (others.length === 0) continue;
    const longN = others.filter((o) => rec.signals[o]!.side === "long").length;
    const shortN = others.filter((o) => rec.signals[o]!.side === "short").length;
    const majSide = longN > shortN ? "long" : shortN > longN ? "short" : null;
    if (majSide === null) continue; // a 1-1 split has no majority to dissent from
    if (rec.signals[m]!.side === majSide) continue; // the majority is not dissenting
    const d = acc.dissents[m]!;
    const mHit = rec.outcome.scored[m] === true;
    d.dissents += 1;
    if (mHit) d.right += 1;
    else d.wrong += 1;
    const consensusHit = sideHit(rec, majSide);
    if (consensusHit) d.consensusRight += 1;
    else d.consensusWrong += 1;
  }
}

/* ------------------------------------------------------------------ */
/* Log parsing + stats (pure over the log text)                       */
/* ------------------------------------------------------------------ */

export type ModelLedger = {
  model: LearningModelId;
  scored: number;
  hits: number;
  /** Lifetime hit-rate (hits / scored). Null before the first scored outcome. */
  hitRate: number | null;
  /** Last HISTORY_WINDOW outcomes, oldest first. */
  window: boolean[];
  windowHitRate: number | null;
  /** Promotion gate verdict for this model. */
  eligible: boolean;
  reason: string;
};

export type TrackLedger = {
  track: SkillId;
  models: LearningModelId[];
  /** How many outcomes each model supplied to this slot. */
  contrib: Record<LearningModelId, number>;
  scored: number;
  hits: number;
  hitRate: number | null;
  window: boolean[];
  windowHitRate: number | null;
  eligible: boolean;
  reason: string;
};

export type PairLedger = {
  a: LearningModelId;
  b: LearningModelId;
  bothVoted: number;
  agreed: number;
  agreedRight: number;
  /** How often the shared call was right (the agreement quality). */
  agreementHitRate: number | null;
  disagreed: number;
  /** Split outcomes: a was right / b was right / neither (a scratch). */
  aRight: number;
  bRight: number;
  neither: number;
  /** Which side is systematically right when this pair splits. */
  systematic: LearningModelId | null;
  /** (aRight - bRight) / disagreed — the split edge. */
  edge: number | null;
  note: string;
};

export type DissentLedger = {
  model: LearningModelId;
  dissents: number;
  right: number;
  wrong: number;
  /** How often the dissenter was right — the dissenter's edge. */
  hitRate: number | null;
  consensusRight: number;
  consensusWrong: number;
  note: string;
};

export type LearningStats = {
  /** Trade records scored from the live tail of the log. */
  records: number;
  /** Trade records already folded into a compaction snapshot. */
  folded: number;
  /** records + folded. */
  total: number;
  models: ModelLedger[];
  tracks: TrackLedger[];
  pairs: PairLedger[];
  dissents: DissentLedger[];
  gate: { minSamples: number; minHitRate: number; seatWeight: number };
  netPnlUsd: number;
  wins: number;
  losses: number;
};

export type LearningGateOptions = {
  minSamples?: number;
  minHitRate?: number;
  seatWeight?: number;
};

const rate = (hits: number, total: number): number | null => (total > 0 ? hits / total : null);
const windowRate = (w: boolean[]): number | null =>
  w.length > 0 ? w.filter(Boolean).length / w.length : null;
const numOr = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

/** Pure: the promotion gate for one measured population. */
export function gateVerdict(
  scored: number,
  hitRate: number | null,
  opts: LearningGateOptions = {},
): { eligible: boolean; reason: string } {
  const minSamples = opts.minSamples ?? GATE_MIN_SAMPLES;
  const minHitRate = opts.minHitRate ?? GATE_MIN_HIT_RATE;
  if (scored < minSamples) {
    return { eligible: false, reason: `${scored} scored < ${minSamples} minimum` };
  }
  if (hitRate === null || hitRate < minHitRate) {
    const pct = hitRate === null ? "—" : `${Math.round(hitRate * 100)}%`;
    return { eligible: false, reason: `hit-rate ${pct} < ${Math.round(minHitRate * 100)}%` };
  }
  return { eligible: true, reason: `${scored} scored @ ${Math.round((hitRate ?? 0) * 100)}%` };
}

/** Pure: parse the log text into trade records (malformed lines are ignored). */
export function parseLearningLog(text: string): { records: LearningRecord[]; snapshots: LedgerAcc[] } {
  const records: LearningRecord[] = [];
  const snapshots: LedgerAcc[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const o = parsed as Record<string, unknown>;
    if (o["kind"] === "learning.trade" && isLearningRecord(o)) {
      records.push(o as unknown as LearningRecord);
      continue;
    }
    if (o["kind"] === "learning.ledger") {
      const ledger = (o as { ledger?: unknown }).ledger;
      if (ledger && typeof ledger === "object") snapshots.push(ledger as LedgerAcc);
    }
  }
  return { records, snapshots };
}

function isLearningRecord(o: Record<string, unknown>): boolean {
  if (o["v"] !== 1) return false;
  if (typeof o["pair"] !== "string" || !o["pair"].includes("/")) return false;
  if (o["side"] !== "long" && o["side"] !== "short") return false;
  const trade = o["trade"];
  if (!trade || typeof trade !== "object") return false;
  const t = trade as Record<string, unknown>;
  if (!Number.isFinite(t["entry"]) || !Number.isFinite(t["exit"])) return false;
  if (!Number.isFinite(t["netPnlUsd"])) return false;
  if (!o["signals"] || typeof o["signals"] !== "object") return false;
  if (!o["outcome"] || typeof o["outcome"] !== "object") return false;
  return true;
}

/** Pure: restore a ledger accumulator from a compaction snapshot. */
function restoreLedger(snapshot: LedgerAcc): LedgerAcc {
  const acc = emptyLedger();
  acc.records = numOr(snapshot.records, 0);
  for (const m of LEARNING_MODELS) {
    const src = snapshot.models?.[m];
    if (!src) continue;
    acc.models[m] = {
      hits: numOr(src.hits, 0),
      total: numOr(src.total, 0),
      window: Array.isArray(src.window)
        ? src.window.filter((r): r is boolean => typeof r === "boolean").slice(-HISTORY_WINDOW)
        : [],
    };
  }
  for (const t of LEARNING_TRACKS) {
    const src = snapshot.tracks?.[t];
    if (!src) continue;
    const contrib = {} as Record<LearningModelId, number>;
    for (const m of LEARNING_MODELS) contrib[m] = numOr(src.contrib?.[m], 0);
    acc.tracks[t] = {
      hits: numOr(src.hits, 0),
      total: numOr(src.total, 0),
      window: Array.isArray(src.window)
        ? src.window.filter((r): r is boolean => typeof r === "boolean").slice(-HISTORY_WINDOW)
        : [],
      contrib,
    };
  }
  for (const [key, p] of Object.entries(snapshot.pairs ?? {})) {
    if (!p || typeof p !== "object") continue;
    acc.pairs[key] = {
      total: countersFrom(p.total),
      bySide: {
        long: countersFrom((p.bySide as Record<string, unknown> | undefined)?.long),
        short: countersFrom((p.bySide as Record<string, unknown> | undefined)?.short),
      },
    };
  }
  for (const m of LEARNING_MODELS) {
    const src = snapshot.dissents?.[m];
    if (!src) continue;
    acc.dissents[m] = {
      dissents: numOr(src.dissents, 0),
      right: numOr(src.right, 0),
      wrong: numOr(src.wrong, 0),
      consensusRight: numOr(src.consensusRight, 0),
      consensusWrong: numOr(src.consensusWrong, 0),
    };
  }
  return acc;
}

function countersFrom(raw: unknown): SideCounters {
  const c = emptyCounters();
  if (!raw || typeof raw !== "object") return c;
  const o = raw as Record<string, unknown>;
  c.bothVoted = numOr(o["bothVoted"], 0);
  c.agreed = numOr(o["agreed"], 0);
  c.agreedRight = numOr(o["agreedRight"], 0);
  c.disagreed = numOr(o["disagreed"], 0);
  c.aRight = numOr(o["aRight"], 0);
  c.bRight = numOr(o["bRight"], 0);
  c.neither = numOr(o["neither"], 0);
  return c;
}

/** Pure: fold the whole log text into the stats report. */
export function summarizeLearningLog(text: string, opts: LearningGateOptions = {}): LearningStats {
  const { records, snapshots } = parseLearningLog(text);
  // A snapshot REPLACES the accumulator (it already carries everything folded).
  const acc = snapshots.length > 0 ? restoreLedger(snapshots[snapshots.length - 1]!) : emptyLedger();
  const folded = acc.records;
  let netPnlUsd = 0;
  let wins = 0;
  let losses = 0;
  for (const rec of records) {
    applyRecordToLedger(acc, rec);
    const net = rec.outcome?.netPnlUsd;
    if (typeof net === "number" && Number.isFinite(net)) {
      netPnlUsd += net;
      if (net > 0) wins += 1;
      else if (net < 0) losses += 1;
    }
  }

  const minSamples = opts.minSamples ?? GATE_MIN_SAMPLES;
  const minHitRate = opts.minHitRate ?? GATE_MIN_HIT_RATE;
  const seatWeight = opts.seatWeight ?? GATE_SEAT_WEIGHT;

  const models: ModelLedger[] = LEARNING_MODELS.map((m) => {
    const a = acc.models[m]!;
    const hr = rate(a.hits, a.total);
    const verdict = gateVerdict(a.total, hr, { minSamples, minHitRate });
    return {
      model: m,
      scored: a.total,
      hits: a.hits,
      hitRate: hr,
      window: [...a.window],
      windowHitRate: windowRate(a.window),
      eligible: verdict.eligible,
      reason: verdict.reason,
    };
  });

  const tracks: TrackLedger[] = LEARNING_TRACKS.map((track) => {
    const a = acc.tracks[track]!;
    const hr = rate(a.hits, a.total);
    const verdict = gateVerdict(a.total, hr, { minSamples, minHitRate });
    return {
      track,
      models: [...TRACK_MODELS[track]],
      contrib: { ...a.contrib },
      scored: a.total,
      hits: a.hits,
      hitRate: hr,
      window: [...a.window],
      windowHitRate: windowRate(a.window),
      eligible: verdict.eligible,
      reason: verdict.reason,
    };
  });

  const pairs: PairLedger[] = Object.entries(acc.pairs)
    .map(([key, p]) => {
      const [a, b] = key.split("|") as [LearningModelId, LearningModelId];
      const c = p.total;
      const agreedHitRate = rate(c.agreedRight, c.agreed);
      const systematic: LearningModelId | null =
        c.disagreed >= MIN_SPLIT_SAMPLES && c.aRight > c.bRight
          ? a
          : c.disagreed >= MIN_SPLIT_SAMPLES && c.bRight > c.aRight
            ? b
            : null;
      const edge = c.disagreed > 0 ? (c.aRight - c.bRight) / c.disagreed : null;
      const note = systematic
        ? `${systematic} is systematically right when ${a}/${b} split (${systematic === a ? c.aRight : c.bRight}/${c.disagreed})`
        : c.disagreed > 0
          ? `${a}/${b} split ${c.disagreed}× with no systematic winner`
          : `${a}/${b} never disagreed`;
      return {
        a,
        b,
        bothVoted: c.bothVoted,
        agreed: c.agreed,
        agreedRight: c.agreedRight,
        agreementHitRate: agreedHitRate,
        disagreed: c.disagreed,
        aRight: c.aRight,
        bRight: c.bRight,
        neither: c.neither,
        systematic,
        edge,
        note,
      };
    })
    .filter((p) => p.bothVoted > 0)
    .sort((x, y) => y.bothVoted - x.bothVoted);

  const dissents: DissentLedger[] = LEARNING_MODELS.map((m) => {
    const d = acc.dissents[m]!;
    const hr = rate(d.right, d.dissents);
    const note =
      d.dissents < MIN_DISSENT_SAMPLES
        ? `only ${d.dissents} dissent(s) — not enough to read`
        : hr !== null && hr <= 1 - DISSENT_WRONG_RATE
          ? `dissent is systematically wrong (${d.right}/${d.dissents} right) — carries no edge`
          : hr !== null && hr >= DISSENT_WRONG_RATE
            ? `dissent carries information (${d.right}/${d.dissents} right)`
            : `dissent is a coin flip (${d.right}/${d.dissents} right)`;
    return {
      model: m,
      dissents: d.dissents,
      right: d.right,
      wrong: d.wrong,
      hitRate: hr,
      consensusRight: d.consensusRight,
      consensusWrong: d.consensusWrong,
      note,
    };
  }).filter((d) => d.dissents > 0);

  return {
    records: records.length,
    folded,
    total: acc.records,
    models,
    tracks,
    pairs,
    dissents,
    gate: { minSamples, minHitRate, seatWeight },
    netPnlUsd,
    wins,
    losses,
  };
}

/* ------------------------------------------------------------------ */
/* Append + compaction (pure string transforms)                       */
/* ------------------------------------------------------------------ */

/** Pure: the log line for one record (one JSON object, newline terminated). */
export function learningLogLine(rec: LearningRecord): string {
  return `${JSON.stringify(rec)}\n`;
}

/** Pure: append a record to the log text. */
export function appendRecordToLog(text: string, rec: LearningRecord): string {
  return `${text}${learningLogLine(rec)}`;
}

/** Pure: fold the log into a snapshot + the last `keep` trade records. */
export function compactLearningLog(
  text: string,
  keep: number = LEARNING_COMPACT_KEEP,
  opts: { now?: () => number } = {},
): { text: string; removed: number; kept: number } {
  const { records, snapshots } = parseLearningLog(text);
  const keepN = Math.max(0, Math.floor(keep));
  if (records.length <= keepN) return { text, removed: 0, kept: records.length };

  const acc = snapshots.length > 0 ? restoreLedger(snapshots[snapshots.length - 1]!) : emptyLedger();
  const folded = records.slice(0, records.length - keepN);
  for (const rec of folded) applyRecordToLedger(acc, rec);

  const nowMs = opts.now ? opts.now() : Date.now();
  const snapshot = {
    v: 1,
    kind: "learning.ledger",
    at: new Date(nowMs).toISOString(),
    folded: folded.length,
    ledger: acc,
  };
  const kept = records.slice(records.length - keepN);
  const out = [JSON.stringify(snapshot), ...kept.map((r) => JSON.stringify(r))].join("\n");
  return { text: `${out}\n`, removed: folded.length, kept: kept.length };
}

/* ------------------------------------------------------------------ */
/* Feedback into the vote.json store                                   */
/* ------------------------------------------------------------------ */

export type GateChange = {
  track: SkillId;
  models: LearningModelId[];
  weightBefore: number;
  weightAfter: number;
  eligible: boolean;
  reason: string;
};

const clampWeight = (w: number): number =>
  Math.min(Math.max(Math.round(w * 100) / 100, WEIGHT_FLOOR), WEIGHT_CAP);

/**
 * Pure-ish: score the trade into the vote.json rolling windows the
 * auto-tune reads (`skills[track].results`) — one outcome per slot, taken
 * from the slot's first voting candidate. Abstentions score nothing.
 *
 * MUTATES `store.skills[track].results` and (via vote.ts's
 * `recordOutcome`) `store.weights[track]`.
 */
export function syncVoteStore(
  store: VoteStore,
  rec: LearningRecord,
): { track: SkillId; model: LearningModelId; hit: boolean }[] {
  const applied: { track: SkillId; model: LearningModelId; hit: boolean }[] = [];
  for (const track of LEARNING_TRACKS) {
    const src = trackOutcomeSource(rec, track);
    if (!src) continue;
    recordOutcome(store, track, src.hit);
    applied.push({ track, model: src.model, hit: src.hit });
  }
  return applied;
}

/**
 * Apply the promotion gate to the vote.json weights.
 *
 * The gate is the "earn the seat" rule: a slot whose measured evidence is
 * below the bar gets weight 0 — excluded from live voting — and the reason
 * is returned so the caller can log it. A slot that clears the bar keeps
 * the weight the auto-tune earned, floored at the seat weight so "has the
 * seat" actually means it can vote.
 *
 * MUTATES `store.weights` — the exact field `jw3 vote` / `jw3 oracle`
 * read for live voting. Persist with `saveStore(voteStorePath(), store)`.
 */
export function applyPromotionGate(
  store: VoteStore,
  stats: LearningStats,
  opts: LearningGateOptions = {},
): GateChange[] {
  const seatWeight = opts.seatWeight ?? stats.gate.seatWeight;
  const changes: GateChange[] = [];
  for (const track of LEARNING_TRACKS) {
    const ledger = stats.tracks.find((t) => t.track === track);
    const before = store.weights[track] ?? 0;
    const eligible = ledger?.eligible === true;
    const reason = ledger?.reason ?? "no scored outcomes";
    const after = eligible ? clampWeight(Math.max(before, seatWeight)) : 0;
    store.weights[track] = after;
    changes.push({
      track,
      models: ledger?.models ?? [...TRACK_MODELS[track]],
      weightBefore: before,
      weightAfter: after,
      eligible,
      reason: eligible ? `seat earned — ${reason}` : `excluded — ${reason}`,
    });
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Paths + commands                                                    */
/* ------------------------------------------------------------------ */

function configDir(): string {
  if (process.env["JW3_CONFIG_HOME"]) return process.env["JW3_CONFIG_HOME"];
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

/** The learning log (one JSON line per closed trade). */
export function learningLogPath(dir?: string): string {
  return join(dir ?? configDir(), "learning.jsonl");
}

/** Pure: the human report lines for the stats. */
export function formatLearningReport(stats: LearningStats, liveWeights?: Record<string, number>): string[] {
  const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const money = (v: number): string => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
  const lines: string[] = [];
  lines.push(
    `LEARNING — ${stats.total} closed trade(s) scored${stats.folded > 0 ? ` (${stats.records} live + ${stats.folded} folded)` : ""} · net ${money(stats.netPnlUsd)} · ${stats.wins}W/${stats.losses}L`,
  );
  lines.push(
    `GATE — voting rights need ≥${stats.gate.minSamples} scored outcomes AND ≥${Math.round(stats.gate.minHitRate * 100)}% lifetime hit-rate (seat weight ${stats.gate.seatWeight})`,
  );
  lines.push("");
  lines.push("MODEL      SCORED    HIT%  WINDOW    SEAT");
  for (const m of stats.models) {
    lines.push(
      `  ${m.model.padEnd(8)} ${String(m.scored).padStart(5)}  ${pct(m.hitRate).padStart(6)}  ${String(m.window.length).padStart(2)}/${HISTORY_WINDOW}  ${m.eligible ? `✓ earned — ${m.reason}` : `✗ ${m.reason}`}`,
    );
  }
  lines.push("");
  lines.push("LIVE WEIGHT SLOTS (vote.json weights)");
  for (const t of stats.tracks) {
    const live = liveWeights?.[t.track];
    const liveTxt = live === undefined ? "" : ` · live w ${live.toFixed(2)}`;
    lines.push(
      `  ${t.track.padEnd(8)} ${String(t.scored).padStart(5)}  ${pct(t.hitRate).padStart(6)}  ${t.eligible ? `✓ seat (${t.models.join("+")})` : `✗ excluded — ${t.reason}`}${liveTxt}`,
    );
  }
  if (stats.pairs.length > 0) {
    lines.push("");
    lines.push("MODEL PAIRS");
    for (const p of stats.pairs) {
      lines.push(
        `  ${p.a}/${p.b} — ${p.bothVoted} both voted · ${p.agreed} agreed (${pct(p.agreementHitRate)} right) · ${p.disagreed} split · ${p.note}`,
      );
    }
  }
  if (stats.dissents.length > 0) {
    lines.push("");
    lines.push("DISSENTS (a dissenting third model is information)");
    for (const d of stats.dissents) {
      lines.push(`  ${d.model.padEnd(8)} ${d.dissents} dissent(s) · ${d.right} right (${pct(d.hitRate)}) · consensus right ${d.consensusRight} — ${d.note}`);
    }
  }
  return lines;
}

/** `jw3 learning record` — bank a closed trade, score it, re-gate the store. */
export async function cmdLearningRecord(opts: {
  pair: string;
  side: string;
  entry: number;
  exit: number;
  exitReason: string;
  pnlUsd: number;
  feesUsd: number;
  netPnlUsd?: number;
  holdingMs?: number | null;
  exchange?: string;
  signals?: Partial<Record<LearningModelId, LearningSignal>>;
  tape?: Partial<LearningTape>;
  window?: LearningWindow | null;
  entryAtMs?: number;
  json: boolean;
  logPath?: string;
  storePath?: string;
  gate?: LearningGateOptions;
  /** Set false to score + log without touching the live vote.json weights. */
  applyGate?: boolean;
  now?: () => number;
}): Promise<void> {
  const side = String(opts.side).toLowerCase() as LearningSide;
  const input: LearningRecordInput = {
    pair: opts.pair,
    side,
    entry: opts.entry,
    exit: opts.exit,
    exitReason: opts.exitReason,
    pnlUsd: opts.pnlUsd,
    feesUsd: opts.feesUsd,
    ...(opts.netPnlUsd !== undefined ? { netPnlUsd: opts.netPnlUsd } : {}),
    ...(opts.holdingMs !== undefined ? { holdingMs: opts.holdingMs } : {}),
    ...(opts.exchange ? { exchange: opts.exchange } : {}),
    ...(opts.signals ? { signals: opts.signals } : {}),
    ...(opts.tape ? { tape: opts.tape } : {}),
    ...(opts.window !== undefined ? { window: opts.window } : {}),
    ...(opts.entryAtMs !== undefined ? { entryAtMs: opts.entryAtMs } : {}),
  };
  const err = validateLearningInput(input);
  if (err) {
    console.error(
      "Usage: jw3 learning record --pair SOL/USDT --side long|short --entry P --exit P --reason tp|sl|kill|scratch|trail|manual --pnl N --fees N [--holding-min N] [--json]",
    );
    console.error(`Bad record: ${err} — nothing recorded.`);
    process.exitCode = 2;
    return;
  }
  const nowMs = opts.now ? opts.now() : Date.now();
  const rec = buildLearningRecord(input, { now: () => nowMs });
  const logPath = opts.logPath ?? learningLogPath();
  const storePath = opts.storePath ?? voteStorePath();

  let text = "";
  try {
    if (existsSync(logPath)) text = readFileSync(logPath, "utf8");
  } catch {
    text = "";
  }
  const next = appendRecordToLog(text, rec);

  // Score into the vote.json rolling window the auto-tune reads.
  const store = loadStore(storePath);
  const applied = syncVoteStore(store, rec);
  const stats = summarizeLearningLog(next, opts.gate ?? {});
  const applyGate = opts.applyGate !== false;
  const changes = applyGate ? applyPromotionGate(store, stats, opts.gate ?? {}) : [];

  // Compact before writing so the log stays bounded.
  let outText = next;
  let compacted: { removed: number; kept: number } | null = null;
  if (stats.total > LEARNING_COMPACT_AT) {
    const c = compactLearningLog(next, LEARNING_COMPACT_KEEP, { now: () => nowMs });
    outText = c.text;
    compacted = { removed: c.removed, kept: c.kept };
  }
  try {
    mkdirSync(logPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(logPath, outText);
  } catch (e) {
    console.error(`Warning: learning record not persisted (${e instanceof Error ? e.message : String(e)}).`);
  }
  try {
    saveStore(storePath, store);
  } catch (e) {
    console.error(`Warning: vote store not updated (${e instanceof Error ? e.message : String(e)}).`);
  }

  const scored = Object.entries(rec.outcome.scored).map(([m, hit]) => `${m} ${hit ? "hit" : "miss"}`);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          record: rec,
          scored,
          tracks: applied,
          gate: changes,
          stats: { records: stats.records, total: stats.total, models: stats.models },
          compacted,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `RECORDED ${rec.pair} ${rec.side.toUpperCase()} — net ${rec.trade.netPnlUsd >= 0 ? "+" : ""}$${rec.trade.netPnlUsd.toFixed(2)} · ${scored.join(", ") || "no model voted"}`,
  );
  console.log(
    `  windows scored: ${applied.map((a) => `${a.track}=${a.hit ? "hit" : "miss"} (${a.model})`).join(", ") || "none"}`,
  );
  for (const c of changes) {
    console.log(`  ${c.track.padEnd(8)} weight ${c.weightBefore.toFixed(2)} → ${c.weightAfter.toFixed(2)} · ${c.reason}`);
  }
  if (compacted) console.log(`  compacted ${compacted.removed} old record(s), kept ${compacted.kept}`);
}

/** `jw3 learning stats` — report over the log (never writes the store). */
export async function cmdLearningStats(opts: {
  json: boolean;
  logPath?: string;
  storePath?: string;
  gate?: LearningGateOptions;
}): Promise<void> {
  const logPath = opts.logPath ?? learningLogPath();
  let text = "";
  try {
    if (existsSync(logPath)) text = readFileSync(logPath, "utf8");
  } catch {
    text = "";
  }
  const stats = summarizeLearningLog(text, opts.gate ?? {});
  let liveWeights: Record<string, number> | undefined;
  try {
    liveWeights = loadStore(opts.storePath ?? voteStorePath()).weights;
  } catch {
    liveWeights = undefined;
  }
  if (opts.json) {
    console.log(JSON.stringify({ ...stats, liveWeights: liveWeights ?? null }, null, 2));
    return;
  }
  for (const line of formatLearningReport(stats, liveWeights)) console.log(line);
}
