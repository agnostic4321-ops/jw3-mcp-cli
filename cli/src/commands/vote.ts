/**
 * `jw3 vote` — skill-weighted directional vote (READ-ONLY, no trades).
 *
 * Three skills, one ballot:
 *   JEV     (analyze_market trend, 7 timeframes) — weight 1.0
 *   Kronos  (Kronos-small 15m oracle via forecast bridge) — weight 0.5
 *   RF-DETR (chart-vision pattern reader) — weight 0, abstains until wired
 *
 * The ballot is confidence-weighted: score = Σ(side·conf·w) / Σ(w) over
 * voting (non-abstained, w > 0) skills; |score| >= 0.15 decides long/short,
 * anything weaker is flat (no consensus). A vote never executes — it only
 * records the ballot so `vote record` can later score each skill against
 * the realized outcome and `vote stats` can show the rolling hit-rates.
 *
 * Rolling hit-rate auto-tune: each skill keeps its last 20 scored outcomes
 * (plus lifetime hits/total). With ≥5 samples a rolling rate ≥60% promotes
 * the weight +0.1 (cap 2.0) and ≤40% demotes −0.1 (floor 0) — so RF-DETR
 * lifts off 0 on merit once it starts voting, and a decayed skill fades
 * toward silence. State lives in one JSON file under the CLI config dir
 * (~/.config/jw3/vote.json, JW3_CONFIG_HOME override); a missing or
 * corrupt file falls back to defaults and is rewritten on the next vote.
 */
import { configDir, resolvePat } from "../config.js";
import { loadJsonStore, resolveStorePath, saveJsonStore } from "./json-store.js";
import { fetchJevTrend, type TrendVerdict } from "./analyze.js";
import { fetchKronosVerdict, type ForecastVerdict } from "./forecast.js";
import { rfdetrBoxesToSignal, type RfdetrVerdict } from "./rfdetr.js";

export type VoteSide = "long" | "short" | "flat";
export type SkillId = "jev" | "kronos" | "rfdetr";

export const SKILLS: SkillId[] = ["jev", "kronos", "rfdetr"];
/** Ballot-open weights: JEV leads, Kronos halves, RF-DETR silent until wired. */
export const DEFAULT_WEIGHTS: Record<SkillId, number> = { jev: 1.0, kronos: 0.5, rfdetr: 0 };
/** Rolling window for the auto-tune hit-rate. */
export const HISTORY_WINDOW = 20;
/** Samples needed before the auto-tune touches a weight. */
export const MIN_SAMPLES = 5;
export const PROMOTE_AT = 0.6;
export const DEMOTE_AT = 0.4;
export const WEIGHT_STEP = 0.1;
export const WEIGHT_CAP = 2.0;
export const WEIGHT_FLOOR = 0;
/** |score| at or above this decides long/short; below is flat. */
export const CONSENSUS_THRESHOLD = 0.15;
/** Cap on stored ballots — the file stays small. */
export const MAX_VOTES = 100;

export type SkillSignal = {
  skill: SkillId;
  side: VoteSide;
  /** 0..1 directional conviction. 0 when abstained. */
  confidence: number;
  abstained: boolean;
  detail: string;
};

export type VoteBreakdown = {
  skill: SkillId;
  side: VoteSide;
  confidence: number;
  weight: number;
  contribution: number;
  abstained: boolean;
};

export type CombinedVote = {
  side: VoteSide;
  /** Confidence-weighted mean in [-1, 1] (+long / −short). 0 when nobody votes. */
  score: number;
  voters: number;
  breakdown: VoteBreakdown[];
  reason: string;
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

/** Pure: `SOL/USDT` usable, uppercase-normalized. Null = reject with usage. */
export function validateVotePair(pair: string): string | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return "pair required (e.g. SOL/USDT)";
  const base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(base) || quote !== "USDT") return "pair required (e.g. SOL/USDT)";
  return null;
}

export function normalizeVotePair(pair: string): string {
  const [b, q] = pair.split("/");
  return `${(b ?? "").trim().toUpperCase()}/${(q ?? "").trim().toUpperCase()}`;
}

/**
 * Pure: JEV trend → ballot. Only bull/bear verdicts vote — uncertain,
 * neutral, or unknown verdicts abstain (no directional edge to count).
 */
export function jevToSignal(t: TrendVerdict | null): SkillSignal {
  const abstain = (detail: string): SkillSignal => ({ skill: "jev", side: "flat", confidence: 0, abstained: true, detail });
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
 * the expected move (|move| ≥1% is full conviction, floor 0.1); flat
 * abstains — a no-move call is not a direction.
 */
export function kronosToSignal(v: ForecastVerdict | null): SkillSignal {
  const abstain = (detail: string): SkillSignal => ({ skill: "kronos", side: "flat", confidence: 0, abstained: true, detail });
  if (!v) return abstain("no kronos verdict");
  if (v.direction === "flat") return abstain(`flat (expected ${v.expected_move_pct.toFixed(2)}%) — no direction`);
  const conf = Math.min(Math.max(Math.abs(v.expected_move_pct) / 1, 0.1), 1);
  return {
    skill: "kronos",
    side: v.direction === "up" ? "long" : "short",
    confidence: conf,
    abstained: false,
    detail: `${v.direction} ${v.expected_move_pct.toFixed(2)}% over ${v.horizon}x15m`,
  };
}

/**
 * RF-DETR chart-vision ballot — abstains without a verdict. Wiring point:
 * pass the bridge verdict (see rfdetr.ts fetchRfdetrBoxes) and the top
 * pattern box votes with its score; the auto-tune promotes the weight off
 * 0 on scored merit.
 */
export function rfdetrSignal(verdict?: RfdetrVerdict | null): SkillSignal {
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
 * Pure: confidence-weighted ballot. Zero-weight and abstained skills sit
 * out (they neither push the score nor dilute the denominator). Empty
 * ballot → flat with a reason, never a fabricated direction.
 */
export function combineWeightedVote(signals: SkillSignal[], weights: Record<SkillId, number>): CombinedVote {
  const breakdown: VoteBreakdown[] = signals.map((s) => {
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
    return { side: "flat", score: 0, voters: 0, breakdown, reason: "no consensus — every skill abstained" };
  }
  const num = voters.reduce((a, b) => a + b.contribution, 0);
  const den = voters.reduce((a, b) => a + b.weight, 0);
  const score = den > 0 ? num / den : 0;
  const side: VoteSide = score >= CONSENSUS_THRESHOLD ? "long" : score <= -CONSENSUS_THRESHOLD ? "short" : "flat";
  const reason =
    side === "flat"
      ? `weighted score ${score.toFixed(2)} inside ±${CONSENSUS_THRESHOLD} — no consensus`
      : `weighted score ${score.toFixed(2)} decides ${side.toUpperCase()}`;
  return { side, score, voters: voters.length, breakdown, reason };
}

/* ------------------------------------------------------------------ */
/* Rolling store (JSON): weights + per-skill tracks + ballot log.      */
/* ------------------------------------------------------------------ */

export type SkillTrack = {
  /** Last HISTORY_WINDOW scored outcomes (true = hit), oldest first. */
  results: boolean[];
  hits: number;
  total: number;
};

export type VoteRecord = {
  at: string;
  pair: string;
  side: VoteSide;
  score: number;
  signals: SkillSignal[];
  weights: Record<SkillId, number>;
  resolved?: { outcome: VoteSide; at: string };
};

export type VoteStore = {
  version: 1;
  weights: Record<SkillId, number>;
  skills: Record<SkillId, SkillTrack>;
  votes: VoteRecord[];
};

export function defaultStore(): VoteStore {
  const skills = {} as Record<SkillId, SkillTrack>;
  for (const s of SKILLS) skills[s] = { results: [], hits: 0, total: 0 };
  return { version: 1, weights: { ...DEFAULT_WEIGHTS }, skills, votes: [] };
}

/** Store file path (vote.json beside credentials.json). */
export function voteStorePath(dir?: string): string {
  return resolveStorePath(dir, "vote.json", configDir());
}

function saneWeight(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= WEIGHT_FLOOR && v <= WEIGHT_CAP ? v : fallback;
}

/** Load the store; missing/corrupt files fall back to defaults (never throws). */
export function loadStore(path: string): VoteStore {
  const dflt = defaultStore();
  return loadJsonStore(path, defaultStore, (raw, store) => {
    const r = raw as Partial<VoteStore>;
    if (r.weights && typeof r.weights === "object") {
      for (const s of SKILLS) store.weights[s] = saneWeight((r.weights as Record<string, unknown>)[s], dflt.weights[s]!);
    }
    if (r.skills && typeof r.skills === "object") {
      for (const s of SKILLS) {
        const t = (r.skills as Record<string, unknown>)[s] as Partial<SkillTrack> | undefined;
        if (t && typeof t === "object") {
          const results = Array.isArray(t.results) ? t.results.filter((x): x is boolean => typeof x === "boolean").slice(-HISTORY_WINDOW) : [];
          store.skills[s] = {
            results,
            hits: Number.isInteger(t.hits) && (t.hits as number) >= 0 ? (t.hits as number) : 0,
            total: Number.isInteger(t.total) && (t.total as number) >= 0 ? (t.total as number) : 0,
          };
        }
      }
    }
    if (Array.isArray(r.votes)) store.votes = (r.votes as VoteRecord[]).filter((v) => v && typeof v.pair === "string").slice(-MAX_VOTES);
  });
}

/** Persist the store (creates the config dir; best-effort — callers warn, never fail the vote). */
export function saveStore(path: string, store: VoteStore): void {
  saveJsonStore(path, store);
}

/** Rolling hit-rate over the window, or null before the first scored outcome. */
export function hitRate(t: SkillTrack): number | null {
  if (t.results.length === 0) return null;
  return t.results.filter(Boolean).length / t.results.length;
}

/**
 * Score one outcome for a skill: roll the window, bump lifetime counters,
 * and auto-tune the weight (needs MIN_SAMPLES; promote ≥60% +step,
 * demote ≤40% −step, clamped to [floor, cap]).
 */
export function recordOutcome(
  store: VoteStore,
  skill: SkillId,
  hit: boolean,
): { weightBefore: number; weightAfter: number; rate: number } {
  const track = store.skills[skill]!;
  track.results.push(hit);
  if (track.results.length > HISTORY_WINDOW) track.results.splice(0, track.results.length - HISTORY_WINDOW);
  if (hit) track.hits += 1;
  track.total += 1;
  const rate = hitRate(track) ?? (hit ? 1 : 0);
  const before = store.weights[skill]!;
  let after = before;
  if (track.results.length >= MIN_SAMPLES) {
    if (rate >= PROMOTE_AT) after = Math.min(WEIGHT_CAP, before + WEIGHT_STEP);
    else if (rate <= DEMOTE_AT) after = Math.max(WEIGHT_FLOOR, before - WEIGHT_STEP);
  }
  after = Math.round(after * 100) / 100;
  store.weights[skill] = after;
  return { weightBefore: before, weightAfter: after, rate };
}

/**
 * Resolve the latest unresolved ballot for `pair` against `outcome`.
 * Abstained skills are not scored (null). Mutates the store's tracks,
 * weights, and the ballot's resolved marker.
 */
export function resolveVote(
  store: VoteStore,
  pair: string,
  outcome: VoteSide,
): { record: VoteRecord; scored: Record<SkillId, boolean | null> } | { error: string } {
  const want = normalizeVotePair(pair);
  for (let i = store.votes.length - 1; i >= 0; i--) {
    const rec = store.votes[i]!;
    if (rec.pair === want && !rec.resolved) {
      const scored = {} as Record<SkillId, boolean | null>;
      for (const s of rec.signals) {
        if (s.abstained) {
          scored[s.skill] = null;
          continue;
        }
        const hit = s.side === outcome;
        recordOutcome(store, s.skill, hit);
        scored[s.skill] = hit;
      }
      rec.resolved = { outcome, at: new Date().toISOString() };
      return { record: rec, scored };
    }
  }
  return { error: `no unresolved vote for ${want} — cast one with \`jw3 vote --pair ${want}\` first` };
}

/* ------------------------------------------------------------------ */
/* Commands. Read-only vs the market: votes only read signals and write */
/* the local store file. Nothing here proposes, executes, or closes.    */
/* ------------------------------------------------------------------ */

const fmtW = (w: number): string => w.toFixed(2);

/** Injectable model fetchers (tests pin the ballot offline; defaults are the real fetchers). */
export type VoteDeps = {
  jevTrend?: typeof fetchJevTrend;
  kronos?: typeof fetchKronosVerdict;
};

export async function cmdVote(opts: {
  pair: string;
  exchange: string;
  horizon: number;
  json: boolean;
  url?: string;
  pat?: string;
  storePath?: string;
  deps?: VoteDeps;
}): Promise<void> {
  const pairErr = validateVotePair(opts.pair);
  if (pairErr || !opts.exchange) {
    console.error("Usage: jw3 vote --pair SOL/USDT [--exchange kucoin] [--horizon 12] [--json]");
    process.exitCode = 2;
    return;
  }
  const pair = normalizeVotePair(opts.pair);
  const path = opts.storePath ?? voteStorePath();
  const store = loadStore(path);

  const signals: SkillSignal[] = [];
  const pat = resolvePat(opts.pat);
  if (!pat) {
    signals.push({ skill: "jev", side: "flat", confidence: 0, abstained: true, detail: "not authenticated — run `jw3 auth login --browser` first" });
  } else {
    try {
      signals.push(jevToSignal(await (opts.deps?.jevTrend ?? fetchJevTrend)(opts.exchange, pair, pat, opts.url)));
    } catch (e) {
      signals.push({
        skill: "jev",
        side: "flat",
        confidence: 0,
        abstained: true,
        detail: `JEV failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  try {
    signals.push(kronosToSignal(await (opts.deps?.kronos ?? fetchKronosVerdict)(pair, opts.horizon)));
  } catch (e) {
    signals.push({
      skill: "kronos",
      side: "flat",
      confidence: 0,
      abstained: true,
      detail: `kronos failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  signals.push(rfdetrSignal());

  const combined = combineWeightedVote(signals, store.weights);
  if (combined.voters === 0) {
    console.error("No signal — every skill abstained, nothing to vote on.");
    process.exitCode = 1;
    return;
  }
  store.votes.push({
    at: new Date().toISOString(),
    pair,
    side: combined.side,
    score: Math.round(combined.score * 10000) / 10000,
    signals,
    weights: { ...store.weights },
  });
  if (store.votes.length > MAX_VOTES) store.votes.splice(0, store.votes.length - MAX_VOTES);
  try {
    saveStore(path, store);
  } catch (e) {
    console.error(`Warning: vote not persisted (${e instanceof Error ? e.message : String(e)}).`);
  }

  if (opts.json) {
    console.log(JSON.stringify({ pair, side: combined.side, score: combined.score, signals, weights: store.weights, reason: combined.reason }, null, 2));
    return;
  }
  console.log(`VOTE ${pair} — ${combined.side.toUpperCase()} (score ${combined.score.toFixed(2)})`);
  for (const s of signals) {
    const b = combined.breakdown.find((x) => x.skill === s.skill)!;
    console.log(
      s.abstained
        ? `  ${s.skill.padEnd(8)} abstain (${s.detail})`
        : `  ${s.skill.padEnd(8)} ${s.side.padEnd(5)} conf ${s.confidence.toFixed(2)}  w ${fmtW(b.weight)}  → ${s.detail}`,
    );
  }
  console.log(`weights jev=${fmtW(store.weights["jev"]!)} kronos=${fmtW(store.weights["kronos"]!)} rfdetr=${fmtW(store.weights["rfdetr"]!)} · ${combined.reason}`);
  console.log(`Resolve later: jw3 vote record --pair ${pair} --outcome long|short|flat · read-only, nothing traded`);
}

export async function cmdVoteStats(opts: { json: boolean; storePath?: string }): Promise<void> {
  const store = loadStore(opts.storePath ?? voteStorePath());
  const rows = SKILLS.map((s) => {
    const t = store.skills[s]!;
    const rate = hitRate(t);
    return { skill: s, weight: store.weights[s]!, window: t.results.length, hitRate: rate, hits: t.hits, total: t.total };
  });
  if (opts.json) {
    console.log(JSON.stringify({ weights: store.weights, skills: rows, openVotes: store.votes.filter((v) => !v.resolved).length }, null, 2));
    return;
  }
  console.log(`VOTE WEIGHTS (rolling ${HISTORY_WINDOW}, tune ≥${MIN_SAMPLES} samples: ≥${Math.round(PROMOTE_AT * 100)}% +${WEIGHT_STEP.toFixed(1)}, ≤${Math.round(DEMOTE_AT * 100)}% −${WEIGHT_STEP.toFixed(1)})`);
  for (const r of rows) {
    const rate = r.hitRate === null ? "—" : `${Math.round(r.hitRate * 100)}%`;
    console.log(`  ${r.skill.padEnd(8)} w ${fmtW(r.weight)}  hit ${rate} (${r.window}/${HISTORY_WINDOW} scored)  lifetime ${r.hits}/${r.total}`);
  }
  const open = store.votes.filter((v) => !v.resolved);
  if (open.length > 0) console.log(`open ballots: ${open.map((v) => `${v.pair}→${v.side.toUpperCase()}`).join(", ")}`);
  else console.log("no open ballots");
}

export async function cmdVoteRecord(opts: {
  pair: string;
  outcome: string;
  json: boolean;
  storePath?: string;
}): Promise<void> {
  const pairErr = validateVotePair(opts.pair);
  const outcome = opts.outcome.toLowerCase() as VoteSide;
  if (pairErr || (outcome !== "long" && outcome !== "short" && outcome !== "flat")) {
    console.error("Usage: jw3 vote record --pair SOL/USDT --outcome long|short|flat [--json]");
    process.exitCode = 2;
    return;
  }
  const path = opts.storePath ?? voteStorePath();
  const store = loadStore(path);
  const res = resolveVote(store, opts.pair, outcome);
  if ("error" in res) {
    console.error(`Failed: ${res.error} — nothing was recorded.`);
    process.exitCode = 1;
    return;
  }
  try {
    saveStore(path, store);
  } catch (e) {
    console.error(`Warning: resolution not persisted (${e instanceof Error ? e.message : String(e)}).`);
  }
  const verdict = (s: SkillId): string => {
    const v = res.scored[s];
    return v === null ? "abstained" : v ? "hit" : "miss";
  };
  if (opts.json) {
    console.log(JSON.stringify({ pair: res.record.pair, outcome, scored: res.scored, weights: store.weights }, null, 2));
    return;
  }
  console.log(
    `Recorded ${outcome.toUpperCase()} for ${res.record.pair} — ${SKILLS.map((s) => `${s} ${verdict(s)}`).join(", ")} · weights jev=${fmtW(store.weights["jev"]!)} kronos=${fmtW(store.weights["kronos"]!)} rfdetr=${fmtW(store.weights["rfdetr"]!)}`,
  );
}
