/**
 * CLI-local caches (read-only paths stay read-only — these only avoid
 * repeat network calls, never touch keys or trading).
 *
 * - Spike 120-bar baselines: file cache under the user config dir with a
 *   5-minute TTL, so repeat `spikes` runs don't re-pull 120× 1m bars per
 *   symbol. Best-effort: corrupt/missing cache reads as miss, writes never
 *   throw.
 * - connectionId: in-process session cache, so `--watch` loops and repeat
 *   reads in one CLI session resolve `list_connections` once per
 *   exchange+url instead of once per poll.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const SPIKE_BASELINE_TTL_MS = 5 * 60 * 1000;
export const CONN_SESSION_TTL_MS = 5 * 60 * 1000;

export type SpikeBaselineEntry = {
  n: number;
  volMed: number;
  volP90: number;
  volMax: number;
  trigger: number;
  lastTs: number;
  fetchedAt: number;
};

export function isFresh(fetchedAt: number, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(nowMs)) return false;
  if (fetchedAt <= 0 || nowMs < fetchedAt) return false;
  return nowMs - fetchedAt < ttlMs;
}

function configDir(): string {
  if (process.env.JW3_CONFIG_HOME) return process.env.JW3_CONFIG_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

export function cacheDir(): string {
  return join(configDir(), "cache");
}

export function spikeBaselineCachePath(): string {
  return join(cacheDir(), "spike-baselines.json");
}

type BaselineFile = Record<string, SpikeBaselineEntry>;

function readBaselineFile(): BaselineFile {
  try {
    if (!existsSync(spikeBaselineCachePath())) return {};
    const raw = JSON.parse(readFileSync(spikeBaselineCachePath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as BaselineFile;
  } catch {
    return {};
  }
}

/** Fresh cached baseline for `sym`, or null on miss/stale/corrupt. */
export function loadSpikeBaseline(sym: string, nowMs: number = Date.now()): SpikeBaselineEntry | null {
  const entry = readBaselineFile()[sym];
  if (!entry || typeof entry !== "object") return null;
  if (!isFresh(entry.fetchedAt, nowMs, SPIKE_BASELINE_TTL_MS)) return null;
  if (!Number.isFinite(entry.volMed) || !Number.isFinite(entry.trigger)) return null;
  return entry;
}

/** Best-effort store of one symbol baseline (never throws). */
export function saveSpikeBaseline(sym: string, entry: Omit<SpikeBaselineEntry, "fetchedAt">, nowMs: number = Date.now()): void {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const file = readBaselineFile();
    file[sym] = { ...entry, fetchedAt: nowMs };
    writeFileSync(spikeBaselineCachePath(), JSON.stringify(file), { mode: 0o600 });
  } catch {
    // cache is optional — a failed write must never break the command
  }
}

/* ------------------------------------------------------------------ */
/* connectionId session cache (in-process only, never persisted).       */
/* ------------------------------------------------------------------ */

export type ConnRef = { id: string; exchange: string };

type ConnSessionRow = { conn: ConnRef; at: number };

const connSession = new Map<string, ConnSessionRow>();

export function connSessionKey(exchange: string | undefined, url: string | undefined, wantFutures: boolean): string {
  return `${(exchange ?? "").toLowerCase()}|${url ?? ""}|${wantFutures ? "fut" : "any"}`;
}

export function getConnSession(key: string, nowMs: number = Date.now()): ConnRef | null {
  const row = connSession.get(key);
  if (!row) return null;
  if (!isFresh(row.at, nowMs, CONN_SESSION_TTL_MS)) {
    connSession.delete(key);
    return null;
  }
  return row.conn;
}

export function setConnSession(key: string, conn: ConnRef, nowMs: number = Date.now()): void {
  connSession.set(key, { conn, at: nowMs });
}

export function clearConnSession(): void {
  connSession.clear();
}

/* ------------------------------------------------------------------ */
/* JEV verdict file cache (15-minute TTL per market, mirrors the edge   */
/* JEV_TTL_MS in supabase/functions/_shared/jev-cache.ts). Repeat      */
/* `jw3 analyze` inside the window serves the stored verdict with no   */
/* network call. Best-effort: corrupt/missing cache reads as miss,     */
/* writes never throw. Snapshot bytes are NOT part of the key — a      */
/* verdict is a 15-minute market view, not a pure function of one      */
/* candle array (same rule as the mcp-server analyze_market entry).    */
/* ------------------------------------------------------------------ */

/** Verdict freshness window — must match edge JEV_TTL_MS. */
export const JEV_TTL_MS = 15 * 60 * 1000;

/** Max verdicts kept on disk (per-market keys, tiny JSON each). */
const JEV_MAX_ENTRIES = 100;

/** Per-market verdict key. Normalization mirrors edge jevCacheKey. */
export function jevVerdictKey(family: string, venue: string, symbol: string): string {
  return `jev:${family.trim().toLowerCase()}|${venue.trim().toLowerCase()}|${symbol.trim().toUpperCase()}`;
}

export function jevVerdictCachePath(): string {
  return join(cacheDir(), "jev-verdicts.json");
}

type JevVerdictRow = { value: unknown; fetchedAt: number };

type JevVerdictFile = Record<string, JevVerdictRow>;

function readJevVerdictFile(): JevVerdictFile {
  try {
    if (!existsSync(jevVerdictCachePath())) return {};
    const raw = JSON.parse(readFileSync(jevVerdictCachePath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as JevVerdictFile;
  } catch {
    return {};
  }
}

/** Fresh cached verdict for `key`, or null on miss/stale/corrupt. */
export function loadJevVerdict<T>(key: string, nowMs: number = Date.now()): T | null {
  const row = readJevVerdictFile()[key];
  if (!row || typeof row !== "object") return null;
  if (!isFresh(row.fetchedAt, nowMs, JEV_TTL_MS)) return null;
  if (row.value == null || typeof row.value !== "object") return null;
  return row.value as T;
}

/** Best-effort store of one market verdict (never throws). */
export function saveJevVerdict(key: string, value: unknown, nowMs: number = Date.now()): void {
  try {
    if (value == null || typeof value !== "object") return;
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const file = readJevVerdictFile();
    file[key] = { value, fetchedAt: nowMs };
    // Cheap cap: drop oldest ~10% once over budget.
    const keys = Object.keys(file);
    if (keys.length > JEV_MAX_ENTRIES) {
      keys
        .sort((a, b) => (file[a]?.fetchedAt ?? 0) - (file[b]?.fetchedAt ?? 0))
        .slice(0, Math.ceil(JEV_MAX_ENTRIES * 0.1))
        .forEach((k) => delete file[k]);
    }
    writeFileSync(jevVerdictCachePath(), JSON.stringify(file), { mode: 0o600 });
  } catch {
    // cache is optional — a failed write must never break the command
  }
}
