/**
 * The ONE track store of the verdict stack (OQ-09).
 *
 * A track is a seat's rolling record for one vote.json weight slot: the
 * last N scored outcomes (the auto-tune window), lifetime hits/total, and
 * the merit weight it earned. Every seat that keeps tracks keeps them
 * through this module instead of its own copy — same type, same roll, same
 * sanitizer, same auto-tune:
 *
 *   vote.json  — the LIVE book (`weights` + `skills` + the ballot log
 *                `votes`): written by `vote record` and `learning record`,
 *                read by `vote`, `oracle`, degen's oracle (live money) and
 *                `learning stats`. Owned here (load/save/path/record).
 *   score.json — the scorer's book (`weights` + `tracks` beside its model
 *                scorecards): score.ts keeps the file and the scorecards,
 *                and holds its tracks/weights through this module.
 *
 * Both files keep their paths and on-disk shapes unchanged; an old file
 * loads exactly as before (missing/corrupt → defaults, out-of-range or
 * junk fields → the default for that field, never a crash). Window size,
 * weight band and the auto-tune rule come from the rubric via
 * `weighting.ts`; nothing here restates a value.
 */
import { configDir } from "../config.js";
import { loadJsonStore, resolveStorePath, saveJsonStore } from "./json-store.js";
import { VERDICT_TUNING } from "./rubric.js";
import {
  DEFAULT_WEIGHTS,
  SKILLS,
  rollingHitRate,
  tuneWeight,
  type Ballot,
  type BallotSide,
  type SkillId,
} from "./weighting.js";

const TUNE = VERDICT_TUNING.autoTune;

/* ------------------------------------------------------------------ */
/* Tracks                                                              */
/* ------------------------------------------------------------------ */

export type SkillTrack = {
  /** Last `window` scored outcomes (true = hit), oldest first. */
  results: boolean[];
  hits: number;
  total: number;
};

export function emptyTrack(): SkillTrack {
  return { results: [], hits: 0, total: 0 };
}

/** One empty track per vote.json slot (slot order: jev, kronos, rfdetr). */
export function emptyTracks(): Record<SkillId, SkillTrack> {
  const tracks = {} as Record<SkillId, SkillTrack>;
  for (const s of SKILLS) tracks[s] = emptyTrack();
  return tracks;
}

export function cloneTrack(t: SkillTrack): SkillTrack {
  return { ...t, results: [...t.results] };
}

/** Trim a rolling window to the rubric's window size (oldest dropped). */
export function trimWindow(window: boolean[]): void {
  if (window.length > TUNE.window) window.splice(0, window.length - TUNE.window);
}

/** Push one outcome onto a rolling window and trim it. */
export function rollWindow(window: boolean[], hit: boolean): void {
  window.push(hit);
  trimWindow(window);
}

/** Score one outcome onto a track: roll the window, bump lifetime counters. */
export function pushTrackOutcome(track: SkillTrack, hit: boolean): void {
  rollWindow(track.results, hit);
  if (hit) track.hits += 1;
  track.total += 1;
}

/** Rolling hit-rate over a track's window, or null before the first scored outcome. */
export function hitRate(t: SkillTrack): number | null {
  return rollingHitRate(t.results);
}

/** Sanitize a stored window: booleans only, last `window` kept. */
export function sanitizeWindow(raw: unknown): boolean[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is boolean => typeof r === "boolean").slice(-TUNE.window);
}

/** Sanitize a stored counter: a non-negative integer, else 0. */
export function sanitizeCount(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) >= 0 ? (raw as number) : 0;
}

/** Merge a stored tracks section into `into` (unusable slots keep their defaults). */
export function sanitizeTracksInto(raw: unknown, into: Record<SkillId, SkillTrack>): void {
  if (!raw || typeof raw !== "object") return;
  for (const s of SKILLS) {
    const t = (raw as Record<string, unknown>)[s] as Partial<SkillTrack> | undefined;
    if (!t || typeof t !== "object") continue;
    into[s] = { results: sanitizeWindow(t.results), hits: sanitizeCount(t.hits), total: sanitizeCount(t.total) };
  }
}

/** Merge a stored weights section into `into` (a missing, junk or out-of-band weight keeps the default). */
export function sanitizeWeightsInto(raw: unknown, into: Record<SkillId, number>): void {
  if (!raw || typeof raw !== "object") return;
  for (const s of SKILLS) {
    const v = (raw as Record<string, unknown>)[s];
    if (typeof v === "number" && Number.isFinite(v) && v >= TUNE.floor && v <= TUNE.cap) into[s] = v;
  }
}

/* ------------------------------------------------------------------ */
/* The live book: vote.json                                            */
/* ------------------------------------------------------------------ */

/** Cap on stored ballots — the file stays small. */
export const MAX_VOTES = 100;

export type VoteRecord = {
  at: string;
  pair: string;
  side: BallotSide;
  score: number;
  signals: Ballot<SkillId>[];
  weights: Record<SkillId, number>;
  resolved?: { outcome: BallotSide; at: string };
};

export type VoteStore = {
  version: 1;
  weights: Record<SkillId, number>;
  skills: Record<SkillId, SkillTrack>;
  votes: VoteRecord[];
};

export function defaultStore(): VoteStore {
  return { version: 1, weights: { ...DEFAULT_WEIGHTS }, skills: emptyTracks(), votes: [] };
}

/** Store file path (vote.json beside credentials.json). */
export function voteStorePath(dir?: string): string {
  return resolveStorePath(dir, "vote.json", configDir());
}

/** Load the live book; missing/corrupt files fall back to defaults (never throws). */
export function loadStore(path: string): VoteStore {
  return loadJsonStore(path, defaultStore, (raw, store) => {
    const r = raw as Partial<VoteStore>;
    sanitizeWeightsInto(r.weights, store.weights);
    sanitizeTracksInto(r.skills, store.skills);
    if (Array.isArray(r.votes)) store.votes = (r.votes as VoteRecord[]).filter((v) => v && typeof v.pair === "string").slice(-MAX_VOTES);
  });
}

/** Persist the live book (creates the config dir; best-effort — callers warn, never fail the vote). */
export function saveStore(path: string, store: VoteStore): void {
  saveJsonStore(path, store);
}

/**
 * Score one outcome for a live track: roll the window, bump lifetime
 * counters, and auto-tune the weight (weighting.ts `tuneWeight`).
 */
export function recordOutcome(
  store: VoteStore,
  skill: SkillId,
  hit: boolean,
): { weightBefore: number; weightAfter: number; rate: number } {
  const track = store.skills[skill]!;
  pushTrackOutcome(track, hit);
  const rate = hitRate(track) ?? (hit ? 1 : 0);
  const before = store.weights[skill]!;
  const after = tuneWeight(before, track.results);
  store.weights[skill] = after;
  return { weightBefore: before, weightAfter: after, rate };
}
