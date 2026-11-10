/**
 * The watchdog's breaker STATE FILE (`watchdog-state.json`) — moved verbatim
 * out of watchdog.ts (OQ-12) so the single live order path (`runLive`) can
 * read the breaker on every opening order WITHOUT importing the watchdog:
 * the watchdog stays an independent process that never imports the
 * executor, and the executor never imports the watchdog's decision code.
 *
 * Writers: the watchdog (trip / block entries / resume). Readers: the
 * watchdog itself and `runLive` (`watchdogEntryBlock`). watchdog.ts
 * re-exports everything here, so existing import paths are unchanged.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../config.js";
import type { WatchdogTrip } from "./watchdog.js";

/** State file schema version. */
export const WATCHDOG_STATE_VERSION = 1;

/** The local breaker. */
export type WatchdogBreakerState = {
  tripped: boolean;
  trippedAt: string | null;
  /** Reason strings of the trips that set it. */
  reasons: string[];
  clearedAt: string | null;
  /** Always a human actor — never an automatic path. */
  clearedBy: string | null;
};

/** The watchdog's persisted state. */
export type WatchdogState = {
  version: number;
  breaker: WatchdogBreakerState;
  /** New entries are blocked while true. */
  entriesBlocked: boolean;
  blockReason: string | null;
  policy: { flattenArmed: boolean };
  consecutiveVenueErrors: number;
  lastHeartbeatAt: string | null;
  lastDecisionAt: string | null;
  lastTrips: WatchdogTrip[];
  /** clientOid prefixes this machine owns (the session + turn id tags). */
  ownedClientOidPrefixes: string[];
};

export function watchdogStatePath(dir?: string): string {
  return join(dir ?? configDir(), "watchdog-state.json");
}

export function defaultWatchdogState(): WatchdogState {
  return {
    version: WATCHDOG_STATE_VERSION,
    breaker: { tripped: false, trippedAt: null, reasons: [], clearedAt: null, clearedBy: null },
    entriesBlocked: false,
    blockReason: null,
    policy: { flattenArmed: false },
    consecutiveVenueErrors: 0,
    lastHeartbeatAt: null,
    lastDecisionAt: null,
    lastTrips: [],
    ownedClientOidPrefixes: [],
  };
}

export function loadWatchdogState(path: string): WatchdogState {
  const base = defaultWatchdogState();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return base;
  }
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") return base;
    const breakerRaw = (doc.breaker ?? {}) as Record<string, unknown>;
    return {
      version: typeof doc.version === "number" ? doc.version : WATCHDOG_STATE_VERSION,
      breaker: {
        tripped: breakerRaw.tripped === true,
        trippedAt: typeof breakerRaw.trippedAt === "string" ? breakerRaw.trippedAt : null,
        reasons: Array.isArray(breakerRaw.reasons) ? (breakerRaw.reasons as string[]).map(String) : [],
        clearedAt: typeof breakerRaw.clearedAt === "string" ? breakerRaw.clearedAt : null,
        clearedBy: typeof breakerRaw.clearedBy === "string" ? breakerRaw.clearedBy : null,
      },
      entriesBlocked: doc.entriesBlocked === true,
      blockReason: typeof doc.blockReason === "string" ? doc.blockReason : null,
      policy: {
        flattenArmed: (doc.policy as Record<string, unknown> | undefined)?.flattenArmed === true,
      },
      consecutiveVenueErrors:
        typeof doc.consecutiveVenueErrors === "number" && Number.isFinite(doc.consecutiveVenueErrors)
          ? Math.max(0, Math.floor(doc.consecutiveVenueErrors))
          : 0,
      lastHeartbeatAt: typeof doc.lastHeartbeatAt === "string" ? doc.lastHeartbeatAt : null,
      lastDecisionAt: typeof doc.lastDecisionAt === "string" ? doc.lastDecisionAt : null,
      lastTrips: Array.isArray(doc.lastTrips) ? (doc.lastTrips as WatchdogTrip[]) : [],
      ownedClientOidPrefixes: Array.isArray(doc.ownedClientOidPrefixes)
        ? (doc.ownedClientOidPrefixes as string[]).map(String)
        : [],
    };
  } catch {
    // Unreadable state must never read as "nothing running" — fail closed
    // with the breaker tripped (same rule as the reconcile module).
    return {
      ...base,
      breaker: {
        tripped: true,
        trippedAt: new Date(0).toISOString(),
        reasons: [`watchdog state at ${path} is unreadable — refusing to assume "nothing running"`],
        clearedAt: null,
        clearedBy: null,
      },
    };
  }
}

export function saveWatchdogState(path: string, state: WatchdogState): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Persisting the breaker is best-effort; the venue action still runs.
  }
}

/**
 * Pure: the ENTRY block a breaker state imposes — the reason string, or
 * null when entries may open. A tripped breaker OR `entriesBlocked` blocks
 * every opening order (the watchdog's step 1 promises "entries blocked even
 * if we die next"; `runLive` is where that promise is kept). A corrupt
 * state file reads as tripped (fail closed, see `loadWatchdogState`).
 * Risk-REDUCING orders (cancel, reduce-only close, protective exits) are
 * never blocked here — the unwind must still reach the venue.
 */
export function watchdogEntryBlock(state: WatchdogState): string | null {
  if (state.breaker.tripped) {
    const why = state.breaker.reasons.length > 0 ? state.breaker.reasons.join("; ") : "no reason recorded";
    return `watchdog kill switch is TRIPPED (${why}) — entries are blocked until a human runs \`jw3 watchdog resume --actor <who>\``;
  }
  if (state.entriesBlocked) {
    return `watchdog has BLOCKED entries (${state.blockReason ?? "no reason recorded"}) — entries stay blocked until a human runs \`jw3 watchdog resume --actor <who>\``;
  }
  return null;
}
