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
 *
 * OQ-09: the numbers above live in the rubric (`VERDICT_TUNING`, the single
 * tuning surface); the ballot, the signal mappings and the auto-tune live in
 * `weighting.ts`; the vote.json book (tracks, weights, ballot log) lives in
 * `track-store.ts`. This module keeps the `vote` commands and re-exports
 * those names so its public API is unchanged.
 */
import { resolvePat } from "../config.js";
import { fetchJevTrend } from "./analyze.js";
import { fetchKronosVerdict } from "./forecast.js";
import { VERDICT_TUNING } from "./rubric.js";
import {
  combineBallot,
  jevToSignal,
  kronosToSignal,
  rfdetrSignal,
  SKILLS,
  type Ballot,
  type BallotBreakdown,
  type BallotSide,
  type BallotVerdict,
  type SkillId,
} from "./weighting.js";
import {
  hitRate,
  loadStore,
  MAX_VOTES,
  recordOutcome,
  saveStore,
  voteStorePath,
  type VoteRecord,
  type VoteStore,
} from "./track-store.js";

export { DEFAULT_WEIGHTS, SKILLS, jevToSignal, kronosToSignal, rfdetrSignal, type SkillId } from "./weighting.js";
export {
  MAX_VOTES,
  defaultStore,
  hitRate,
  loadStore,
  recordOutcome,
  saveStore,
  voteStorePath,
  type SkillTrack,
  type VoteRecord,
  type VoteStore,
} from "./track-store.js";

export type VoteSide = BallotSide;

/** Rolling window for the auto-tune hit-rate (rubric). */
export const HISTORY_WINDOW = VERDICT_TUNING.autoTune.window;
/** Samples needed before the auto-tune touches a weight (rubric). */
export const MIN_SAMPLES = VERDICT_TUNING.autoTune.minSamples;
export const PROMOTE_AT = VERDICT_TUNING.autoTune.promoteAt;
export const DEMOTE_AT = VERDICT_TUNING.autoTune.demoteAt;
export const WEIGHT_STEP = VERDICT_TUNING.autoTune.step;
export const WEIGHT_CAP = VERDICT_TUNING.autoTune.cap;
export const WEIGHT_FLOOR = VERDICT_TUNING.autoTune.floor;
/** |score| at or above this decides long/short; below is flat (rubric). */
export const CONSENSUS_THRESHOLD = VERDICT_TUNING.ballot.consensusThreshold;

export type SkillSignal = Ballot<SkillId>;
export type VoteBreakdown = BallotBreakdown<SkillId>;
export type CombinedVote = BallotVerdict<SkillId>;

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
 * Pure: the vote ballot — weighting.ts `combineBallot` over the vote
 * skills. Zero-weight and abstained skills sit out; an empty ballot is flat
 * with a reason, never a fabricated direction.
 */
export function combineWeightedVote(signals: SkillSignal[], weights: Record<SkillId, number>): CombinedVote {
  return combineBallot(signals, weights, "skill");
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
