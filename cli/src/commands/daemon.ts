/**
 * `jw3 daemon` (`jw3d daemon`) — the 24/7 trading supervisor, and the ONLY
 * owner of the margin pool.
 *
 * The deleted `jw3 supervise` command used to restart children, write a
 * heartbeat file and rotate logs — but it was deliberately NOT an order
 * owner: its children spawned WITHOUT `--yes` unless the operator opted
 * in and the supervisor never fired anything itself. OQ-08 folded those
 * mechanics (restart-with-backoff, heartbeat file, log rotation) into
 * this file verbatim and deleted the command. The daemon is the process
 * that actually owns the pool. It supervises the four loops of the 24/7
 * design (signal / executor / monitor / learning), gates every fire
 * through ONE health + kill-switch decision, reconciles the venue on
 * boot so it never inherits somebody else's order, and on the way down
 * it DRAINS instead of leaving orphan working orders behind.
 *
 * Everything here is built on the existing CLI primitives (no second venue
 * signing path, no second gate):
 *   this file             → backoffMs, appendLog, rotateLogsIfNeeded, log/heartbeat paths (folded in from supervise.ts, OQ-08)
 *   commands/trade.ts     → cancelToolArgs, closeToolArgs, cancelOrderIdOf, extractOpenOrders, normalizeRiskLimits
 *   commands/market.ts    → listConnections, pickConnection, collectRows
 *   commands/heat.ts      → accountFromBalances
 *   reconcile.ts          → readLocalStates, classifyStrays, rowPairOf, rowMatchesPair
 *
 * ── INVARIANTS (binding — read before changing anything in this file) ──────
 *
 * I1. ONE OWNER OF THE MARGIN POOL.
 *     The daemon tree is the only thing in the system permitted to place an
 *     order. Exactly ONE `executor` child may be alive at any moment, and it
 *     is the only child whose argv may ever carry `--yes`. A second daemon
 *     cannot start while one is alive (owner lock), so there is never a
 *     second writer against the same margin pool.
 *
 * I2. NEVER ADOPT A FOREIGN ORDER.
 *     On boot the daemon reconciles venue truth (READ-ONLY: open positions +
 *     working orders) against the order ids it can attribute to itself (its
 *     own state file + the local scalp/grid/trail state files). A working
 *     order it cannot attribute is a HARD STOP: the daemon refuses to start
 *     and leaves that order exactly where it is. Adoption is never implicit,
 *     and a foreign order is never cancelled by the daemon.
 *
 * I3. DRAIN IS NOT FLATTEN.
 *     On SIGINT/SIGTERM (or a kill-switch trip) the daemon stops firing,
 *     cancels ITS OWN working orders, and leaves every open position exactly
 *     as it is. Flattening open positions requires the explicit human flag
 *     `--flatten-on-shutdown`. No path flattens a position by itself.
 *
 * I4. THE KILL SWITCH IS IMMEDIATE.
 *     The daemon polls the server-side kill switch on its own timer
 *     (`readServerKillSwitch`) and enters DRAIN the moment it flips — it
 *     does NOT wait for the next child cycle, the next heartbeat, or for
 *     any child to report anything.
 *
 * I5. FAIL CLOSED.
 *     Health `ok` allows new fires; `degraded` and `tripped` do not.
 *     `tripped` also drains (cancels the daemon's own working orders).
 *     A venue read that fails is never read as "safe to fire".
 *
 * Pure logic (manifest validation, health state, boot ownership, drain
 * plan, restart plan, child argv, error rate) lives in this file beside the
 * process control and is unit-tested with zero processes (daemon.test.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configDir, resolvePat } from "../config.js";
import { callTool } from "../mcp.js";
import { runLive } from "./live.js";
import {
  classifyStrays,
  isOpenPosition,
  readLocalStates,
  rowMatchesPair,
  rowPairOf,
  type LocalState,
  type VenueRow,
} from "../reconcile.js";
import { accountFromBalances } from "./heat.js";
import { collectRows, listConnections, pickConnection } from "./market.js";
import {
  cancelOrderIdOf,
  cancelToolArgs,
  closeToolArgs,
  extractOpenOrders,
  normalizeRiskLimits,
  type TradeCall,
} from "./trade.js";
import {
  loadJsonStoreNullable,
  resolveStorePath,
  saveJsonStoreAtomic,
} from "./json-store.js";

/* ------------------------------------------------------------------ */
/* child-supervision mechanics (folded in from supervise.ts, OQ-08)    */
/*                                                                     */
/* The deleted `jw3 supervise` command supervised ad-hoc trail/loop    */
/* children; its restart-with-backoff, heartbeat-file and log-rotation */
/* mechanics move here verbatim — same names, same values, same file   */
/* layouts — so the daemon supervises the four 24/7 loops with the     */
/* identical discipline. `defaultHeartbeatPath` below is the legacy    */
/* supervisor path (kept for existing watchdog configs); the daemon    */
/* writes `defaultDaemonHeartbeatPath` and the watchdog watches that.  */
/* ------------------------------------------------------------------ */

/** Heartbeat cadence default (s). */
export const SUPERVISE_DEFAULT_HEARTBEAT_SEC = 15;
/** Per-child restart budget before the child is marked dead. */
export const SUPERVISE_DEFAULT_MAX_RESTARTS = 10;
/** Log rotation defaults: 5 MiB per file, 5 files kept. */
export const SUPERVISE_DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const SUPERVISE_DEFAULT_MAX_LOG_FILES = 5;
/** Restart backoff: 1s × 2^attempt, capped at 30s. */
export const SUPERVISE_BACKOFF_BASE_MS = 1000;
export const SUPERVISE_BACKOFF_CAP_MS = 30_000;

/** Pure: restart delay for the Nth restart (0-based): 1s×2^N capped 30s. */
export function backoffMs(attempt: number, baseMs: number = SUPERVISE_BACKOFF_BASE_MS, capMs: number = SUPERVISE_BACKOFF_CAP_MS): number {
  const n = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : SUPERVISE_BACKOFF_BASE_MS;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : SUPERVISE_BACKOFF_CAP_MS;
  return Math.min(cap, base * 2 ** Math.min(n, 20));
}

/** Pure: true when the active log file has reached the rotation limit. */
export function shouldRotate(sizeBytes: number, maxBytes: number): boolean {
  if (!Number.isFinite(sizeBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  return sizeBytes >= maxBytes;
}

export function defaultLogDir(): string {
  return join(configDir(), "logs");
}

export function defaultHeartbeatPath(): string {
  return join(configDir(), "supervise-heartbeat.json");
}

/** Rotate `logFile` when it reaches `maxBytes` (keeps `maxFiles`). */
export function rotateLogsIfNeeded(logFile: string, maxBytes: number, maxFiles: number): string | null {
  let size = 0;
  try {
    size = statSync(logFile).size;
  } catch {
    return null; // no file yet — nothing to rotate
  }
  if (!shouldRotate(size, maxBytes)) return null;
  const keep = Number.isInteger(maxFiles) && maxFiles >= 1 ? maxFiles : SUPERVISE_DEFAULT_MAX_LOG_FILES;
  // Drop the oldest, shift the rest up, active file becomes .1.
  try {
    rmSync(`${logFile}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`);
    }
    renameSync(logFile, `${logFile}.1`);
    return `${logFile}.1`;
  } catch {
    return null;
  }
}

export function appendLog(logFile: string, line: string, maxBytes: number, maxFiles: number): void {
  try {
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  } catch {
    // best-effort; the write below still tries
  }
  rotateLogsIfNeeded(logFile, maxBytes, maxFiles);
  try {
    appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
  } catch {
    // Logging never stops supervision.
  }
}

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

/** Daemon manifest schema version. */
export const DAEMON_MANIFEST_VERSION = 1;
/** The four supervised loops (design: docs/autonomous-24-7-daemon.md §2). */
export const DAEMON_ROLES = ["signal", "executor", "monitor", "learning"] as const;
export type DaemonRole = (typeof DAEMON_ROLES)[number];

export const DAEMON_DEFAULT_HEARTBEAT_SEC = 15;
/** Kill-switch poll cadence. Independent of every child cadence. */
export const DAEMON_DEFAULT_KILL_SWITCH_POLL_SEC = 15;
export const DAEMON_DEFAULT_MAX_RESTARTS = SUPERVISE_DEFAULT_MAX_RESTARTS;
export const DAEMON_DEFAULT_MAX_LOG_BYTES = SUPERVISE_DEFAULT_MAX_LOG_BYTES;
export const DAEMON_DEFAULT_MAX_LOG_FILES = SUPERVISE_DEFAULT_MAX_LOG_FILES;
/** How long the daemon waits for children to exit before SIGKILL. */
export const DAEMON_DEFAULT_DRAIN_TIMEOUT_SEC = 30;
/** Rolling window of supervised outcomes used for the error rate. */
export const DAEMON_DEFAULT_ERROR_WINDOW = 50;

export const DAEMON_DEFAULT_HEALTH: DaemonHealthThresholds = {
  heartbeatWarnSec: 30,
  heartbeatStaleSec: 90,
  failWarnCount: 2,
  failTripCount: 5,
  errorRateWarn: 0.2,
  errorRateTrip: 0.5,
  minFreeUsd: 25,
  maxOpenPositions: 3,
};

export const DAEMON_USAGE =
  "jw3 daemon --config daemon.json [--once] [--allow-live] [--flatten-on-shutdown] [--json]";

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

export type DaemonHealthThresholds = {
  /** Heartbeat older than this = degraded. */
  heartbeatWarnSec: number;
  /** Heartbeat older than this = tripped (dead-man). */
  heartbeatStaleSec: number;
  /** Consecutive failures at/above this = degraded. */
  failWarnCount: number;
  /** Consecutive failures at/above this = tripped. */
  failTripCount: number;
  /** Error rate at/above this = degraded. */
  errorRateWarn: number;
  /** Error rate at/above this = tripped. */
  errorRateTrip: number;
  /** Free margin below this = degraded. */
  minFreeUsd: number;
  /** More open positions than this = tripped. */
  maxOpenPositions: number;
};

export type DaemonChildSpec = {
  name: string;
  role: DaemonRole;
  /** `jw3` subcommand the child runs (e.g. "loop", "degen"). */
  command: string;
  args: string[];
  /** May carry `--yes`. Only the executor role may set this. */
  live: boolean;
  enabled: boolean;
};

export type DaemonManifest = {
  version: number;
  exchange: string;
  /** Pairs this daemon owns (the margin pool it is allowed to use). */
  pairs: string[];
  heartbeatSec: number;
  killSwitchPollSec: number;
  maxRestarts: number;
  maxLogBytes: number;
  maxLogFiles: number;
  drainTimeoutSec: number;
  errorWindow: number;
  health: DaemonHealthThresholds;
  children: DaemonChildSpec[];
};

export type HealthState = "ok" | "degraded" | "tripped";

export type HealthInput = {
  /** Age in seconds of the freshest heartbeat. `null` = unknown liveness. */
  heartbeatAgeSec: number | null;
  /** Consecutive failed supervised operations since the last success. */
  consecutiveFailures: number;
  /** Open venue positions. */
  openPositions: number;
  /** Free quote-fund margin. `null` = unverified (never guessed as 0). */
  freeMarginUsd: number | null;
  /** Failures / operations over the rolling window (0..1). */
  errorRate: number;
};

export type HealthVerdict = {
  state: HealthState;
  /** Human-readable reasons, in rule order. Empty when ok. */
  reasons: string[];
};

/* ------------------------------------------------------------------ */
/* manifest (pure validation)                                         */
/* ------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function intIn(v: unknown, min: number, max: number): number | null {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** A pair looks like BASE/QUOTE. */
function validPair(p: unknown): p is string {
  return typeof p === "string" && /^[A-Za-z0-9]{1,12}\/[A-Za-z0-9]{1,12}$/.test(p.trim());
}

/**
 * Pure: manifest → validated manifest or a list of human-readable errors.
 * EVERY error is collected (not just the first) so a broken manifest can be
 * fixed in one pass. Nothing spawns until this returns ok.
 */
export function validateDaemonManifest(raw: unknown): { ok: true; manifest: DaemonManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) {
    return { ok: false, errors: ["daemon manifest must be a JSON object"] };
  }

  const version = intIn(raw.version ?? DAEMON_MANIFEST_VERSION, 1, 1);
  if (version === null) errors.push(`version must be ${DAEMON_MANIFEST_VERSION}`);

  const exchange = typeof raw.exchange === "string" ? raw.exchange.trim().toLowerCase() : "";
  if (!exchange) errors.push("exchange required (e.g. kucoin)");

  const pairs: string[] = [];
  const rawPairs = raw.pairs;
  if (!Array.isArray(rawPairs) || rawPairs.length === 0) {
    errors.push("pairs required — at least one PAIR (e.g. \"SOL/USDT\")");
  } else {
    for (const p of rawPairs) {
      if (!validPair(p)) errors.push(`bad pair ${JSON.stringify(p)} — want BASE/QUOTE`);
      else pairs.push(String(p).trim().toUpperCase());
    }
  }

  const heartbeatSec = intIn(raw.heartbeatSec ?? DAEMON_DEFAULT_HEARTBEAT_SEC, 5, 300);
  if (heartbeatSec === null) errors.push("heartbeatSec must be an integer 5..300");

  const killSwitchPollSec = intIn(raw.killSwitchPollSec ?? DAEMON_DEFAULT_KILL_SWITCH_POLL_SEC, 1, 60);
  if (killSwitchPollSec === null) errors.push("killSwitchPollSec must be an integer 1..60");

  const maxRestarts = intIn(raw.maxRestarts ?? DAEMON_DEFAULT_MAX_RESTARTS, 0, 100);
  if (maxRestarts === null) errors.push("maxRestarts must be an integer 0..100");

  const maxLogBytes = intIn(raw.maxLogBytes ?? DAEMON_DEFAULT_MAX_LOG_BYTES, 1024, 512 * 1024 * 1024);
  if (maxLogBytes === null) errors.push("maxLogBytes must be an integer 1024..536870912");

  const maxLogFiles = intIn(raw.maxLogFiles ?? DAEMON_DEFAULT_MAX_LOG_FILES, 1, 50);
  if (maxLogFiles === null) errors.push("maxLogFiles must be an integer 1..50");

  const drainTimeoutSec = intIn(raw.drainTimeoutSec ?? DAEMON_DEFAULT_DRAIN_TIMEOUT_SEC, 1, 300);
  if (drainTimeoutSec === null) errors.push("drainTimeoutSec must be an integer 1..300");

  const errorWindow = intIn(raw.errorWindow ?? DAEMON_DEFAULT_ERROR_WINDOW, 1, 1000);
  if (errorWindow === null) errors.push("errorWindow must be an integer 1..1000");

  // ── health thresholds ──
  const h = isObj(raw.health) ? raw.health : {};
  const health: DaemonHealthThresholds = { ...DAEMON_DEFAULT_HEALTH };
  const healthFields: (keyof DaemonHealthThresholds)[] = [
    "heartbeatWarnSec",
    "heartbeatStaleSec",
    "failWarnCount",
    "failTripCount",
    "errorRateWarn",
    "errorRateTrip",
    "minFreeUsd",
    "maxOpenPositions",
  ];
  for (const f of healthFields) {
    const raw_v = h[f];
    if (raw_v === undefined) continue;
    const n = num(raw_v);
    if (n === null || n < 0) {
      errors.push(`health.${f} must be a number >= 0`);
      continue;
    }
    (health as Record<string, number>)[f] = n;
  }
  if (health.heartbeatWarnSec >= health.heartbeatStaleSec) {
    errors.push("health.heartbeatWarnSec must be < health.heartbeatStaleSec");
  }
  if (health.failWarnCount > health.failTripCount) {
    errors.push("health.failWarnCount must be <= health.failTripCount");
  }
  if (health.errorRateWarn > health.errorRateTrip) {
    errors.push("health.errorRateWarn must be <= health.errorRateTrip");
  }

  // ── children ──
  const children: DaemonChildSpec[] = [];
  const rawChildren = raw.children;
  if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
    errors.push("children required — at least one child spec");
  } else {
    const names = new Set<string>();
    let executors = 0;
    for (const [i, c] of rawChildren.entries()) {
      const label = `children[${i}]`;
      if (!isObj(c)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!name) errors.push(`${label}.name required`);
      else if (names.has(name)) errors.push(`${label}.name "${name}" is duplicated`);
      else names.add(name);

      const role = typeof c.role === "string" ? c.role.trim().toLowerCase() : "";
      if (!(DAEMON_ROLES as readonly string[]).includes(role)) {
        errors.push(`${label}.role must be one of ${DAEMON_ROLES.join("|")}`);
      } else if (role === "executor") {
        executors++;
      }

      const command = typeof c.command === "string" ? c.command.trim() : "";
      if (!command) errors.push(`${label}.command required (the jw3 subcommand to run)`);

      const args = c.args === undefined ? [] : c.args;
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
        errors.push(`${label}.args must be an array of strings`);
      }

      const live = c.live === undefined ? false : c.live;
      if (typeof live !== "boolean") {
        errors.push(`${label}.live must be a boolean`);
      } else if (live && role !== "executor") {
        // I1: only the executor may ever carry --yes.
        errors.push(`${label}.live is only allowed on the executor role (role=${role || "?"})`);
      }

      const enabled = c.enabled === undefined ? true : c.enabled;
      if (typeof enabled !== "boolean") errors.push(`${label}.enabled must be a boolean`);

      if (name && command && (DAEMON_ROLES as readonly string[]).includes(role)) {
        children.push({
          name,
          role: role as DaemonRole,
          command,
          args: Array.isArray(args) ? args.map(String) : [],
          live: live === true,
          enabled: enabled !== false,
        });
      }
    }
    if (executors > 1) {
      errors.push(`exactly one executor child is allowed (I1: one owner of the pool) — got ${executors}`);
    }
    const enabledExecutors = children.filter((c) => c.role === "executor" && c.enabled).length;
    if (executors > 0 && enabledExecutors === 0) {
      errors.push("the executor child is disabled — the daemon would never place an order");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      version: version as number,
      exchange,
      pairs,
      heartbeatSec: heartbeatSec as number,
      killSwitchPollSec: killSwitchPollSec as number,
      maxRestarts: maxRestarts as number,
      maxLogBytes: maxLogBytes as number,
      maxLogFiles: maxLogFiles as number,
      drainTimeoutSec: drainTimeoutSec as number,
      errorWindow: errorWindow as number,
      health,
      children,
    },
  };
}

/**
 * Read + validate a daemon manifest file. Throws with a human message.
 * Mirrors supervise.ts `loadManifest`, but validates every field.
 */
export function loadDaemonManifest(path: string): DaemonManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no daemon manifest at ${path} — create one (see packages/jw3-cli/daemon.json) or pass --config`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`daemon manifest at ${path} is not valid JSON — refusing to start on a manifest that cannot be read`);
  }
  const v = validateDaemonManifest(doc);
  if (!v.ok) {
    throw new Error(`daemon manifest at ${path} is invalid:\n  - ${v.errors.join("\n  - ")}`);
  }
  return v.manifest;
}

/* ------------------------------------------------------------------ */
/* health model (pure)                                                */
/* ------------------------------------------------------------------ */

/**
 * Pure: health state from the daemon's inputs.
 *
 *   TRIPPED  — dead-man (heartbeat unknown or stale), too many consecutive
 *              failures, error rate at/over the trip threshold, more open
 *              positions than allowed, or no free margin left while
 *              positions are open.
 *   DEGRADED — heartbeat aging out, failures building, error rate elevated,
 *              free margin under the floor, or free margin unverified.
 *   OK       — everything above is clear.
 *
 * Effects (see I5): ok allows new fires; degraded and tripped do not;
 * tripped also drains (cancel the daemon's own working orders).
 */
export function computeHealthState(input: HealthInput, thresholds: DaemonHealthThresholds = DAEMON_DEFAULT_HEALTH): HealthVerdict {
  const t = thresholds;
  const reasons: string[] = [];

  const age = input.heartbeatAgeSec;
  const ageUnknown = age === null || age === undefined || !Number.isFinite(age);
  const ageSec = ageUnknown ? Infinity : Math.max(0, Number(age));

  const failures = Number.isFinite(input.consecutiveFailures) ? Math.max(0, input.consecutiveFailures) : 0;
  const openPositions = Number.isFinite(input.openPositions) ? Math.max(0, input.openPositions) : 0;
  // A non-finite margin is UNKNOWN, not zero: it must read as "unverified"
  // (degraded), never as a free balance of NaN that slips every comparison.
  const freeMargin =
    input.freeMarginUsd === null || input.freeMarginUsd === undefined || !Number.isFinite(input.freeMarginUsd)
      ? null
      : Number(input.freeMarginUsd);
  const errorRate = Number.isFinite(input.errorRate) ? Math.min(1, Math.max(0, input.errorRate)) : 0;

  // ── trip rules ──
  if (ageUnknown) reasons.push("heartbeat age unknown — liveness unproven");
  else if (ageSec > t.heartbeatStaleSec) reasons.push(`heartbeat stale (${ageSec}s > ${t.heartbeatStaleSec}s)`);
  if (failures >= t.failTripCount) reasons.push(`${failures} consecutive failures (>= ${t.failTripCount})`);
  if (errorRate >= t.errorRateTrip) reasons.push(`error rate ${(errorRate * 100).toFixed(0)}% (>= ${(t.errorRateTrip * 100).toFixed(0)}%)`);
  if (openPositions > t.maxOpenPositions) reasons.push(`${openPositions} open positions (> ${t.maxOpenPositions})`);
  if (freeMargin !== null && freeMargin <= 0 && openPositions > 0) reasons.push("no free margin left while positions are open");

  if (reasons.length > 0) return { state: "tripped", reasons };

  // ── degrade rules ──
  if (!ageUnknown && ageSec > t.heartbeatWarnSec) reasons.push(`heartbeat aging (${ageSec}s > ${t.heartbeatWarnSec}s)`);
  if (failures >= t.failWarnCount) reasons.push(`${failures} consecutive failures (>= ${t.failWarnCount})`);
  if (errorRate >= t.errorRateWarn) reasons.push(`error rate ${(errorRate * 100).toFixed(0)}% (>= ${(t.errorRateWarn * 100).toFixed(0)}%)`);
  if (freeMargin === null) reasons.push("free margin unverified");
  else if (freeMargin < t.minFreeUsd) reasons.push(`free margin $${freeMargin.toFixed(2)} < $${t.minFreeUsd.toFixed(2)}`);

  if (reasons.length > 0) return { state: "degraded", reasons };
  return { state: "ok", reasons: [] };
}

/** Only `ok` may place a new order (I5, fail closed). */
export function healthAllowsFire(health: HealthState): boolean {
  return health === "ok";
}

/** `tripped` drains: cancel the daemon's own working orders, keep positions. */
export function healthShouldDrain(health: HealthState): boolean {
  return health === "tripped";
}

/**
 * Pure: rolling error rate over the last `window` supervised outcomes
 * (true = success). An empty window is 0 (nothing has failed yet) — never a
 * fabricated rate.
 */
export function computeErrorRate(outcomes: boolean[], window: number = DAEMON_DEFAULT_ERROR_WINDOW): number {
  const w = Number.isInteger(window) && window > 0 ? window : DAEMON_DEFAULT_ERROR_WINDOW;
  const slice = outcomes.length > w ? outcomes.slice(outcomes.length - w) : outcomes;
  if (slice.length === 0) return 0;
  const errors = slice.filter((o) => o === false).length;
  return errors / slice.length;
}

/* ------------------------------------------------------------------ */
/* boot ownership (pure)                                              */
/* ------------------------------------------------------------------ */

export type BootFacts = {
  exchange: string;
  /** Pairs the daemon is configured to own. */
  configuredPairs: string[];
  /** Order ids the daemon can attribute to itself (state file + local states). */
  ownedOrderIds: string[];
  /** Pairs the daemon has placed an intent for (position ownership). */
  ownedPairs: string[];
  /** Venue working orders (exchange-wide, read-only). */
  venueOrders: VenueRow[];
  /** Venue open positions (exchange-wide, read-only). */
  venuePositions: VenueRow[];
};

export type BootForeignOrder = { orderId: string; pair: string; reason: string };
export type BootForeignPosition = { pair: string; side: string; reason: string };

export type BootVerdict = {
  /** True when the daemon may start. False = refuse (I2). */
  ok: boolean;
  ownedOrderIds: string[];
  foreignOrders: BootForeignOrder[];
  foreignPositions: BootForeignPosition[];
  openPositionCount: number;
  errors: string[];
  warnings: string[];
};

/**
 * Pure: venue truth + what the daemon can attribute → boot verdict.
 *
 * A working order is OURS only when its venue order id is in the owned set.
 * Anything else is foreign and hard-stops the boot (I2 — never adopt).
 * An open position is OURS when the daemon has recorded an intent for that
 * pair; a position on any other pair is foreign — the margin pool has
 * another owner and the daemon refuses to add to it.
 */
export function classifyBootVenue(facts: BootFacts): BootVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const owned = new Set(facts.ownedOrderIds.filter(Boolean));
  const foreignOrders: BootForeignOrder[] = [];
  const ownedOrderIds: string[] = [];

  for (const row of facts.venueOrders) {
    const id = cancelOrderIdOf(row);
    const pair = rowPairOf(row) || "(unknown pair)";
    if (!id) {
      foreignOrders.push({ orderId: "", pair, reason: "working order carries no order id — cannot be attributed" });
      continue;
    }
    if (owned.has(id)) ownedOrderIds.push(id);
    else foreignOrders.push({ orderId: id, pair, reason: "working order has no owning daemon state" });
  }

  const foreignPositions: BootForeignPosition[] = [];
  let openPositionCount = 0;
  for (const row of facts.venuePositions) {
    if (!isOpenPosition(row)) continue;
    openPositionCount++;
    const pair = rowPairOf(row) || "(unknown pair)";
    const side = String(row.side ?? row.posSide ?? "?");
    const ours = facts.ownedPairs.some((p) => rowMatchesPair(row, p));
    if (!ours) {
      foreignPositions.push({ pair, side, reason: "open position on a pair the daemon does not own" });
    }
  }

  for (const f of foreignOrders) {
    errors.push(
      `foreign working order ${f.orderId || "(no id)"} on ${f.pair} — ${f.reason}. ` +
        `Refusing to start: the daemon will not adopt an order it did not place. ` +
        `Resolve it by hand (cancel it, or adopt it in your own client) then restart the daemon.`,
    );
  }
  for (const f of foreignPositions) {
    errors.push(
      `foreign open position ${f.side} ${f.pair} — ${f.reason}. ` +
        `Refusing to start: the daemon owns the margin pool alone. Close or take ownership of it first.`,
    );
  }
  if (openPositionCount > 0 && foreignPositions.length === 0) {
    warnings.push(`${openPositionCount} open position(s) carried over from a previous daemon run — the daemon adopts its OWN positions (it never flattens them)`);
  }

  return {
    ok: errors.length === 0,
    ownedOrderIds,
    foreignOrders,
    foreignPositions,
    openPositionCount,
    errors,
    warnings,
  };
}

/**
 * Pure: local state files → the order ids the daemon can attribute.
 * `readLocalStates` already knows the scalp/grid/trail conventions.
 */
export function harvestOwnedOrderIds(local: LocalState[], known: string[] = []): string[] {
  const out = new Set<string>(known.filter(Boolean));
  for (const s of local) for (const id of s.orderIds) if (id) out.add(id);
  return [...out];
}

/** Local state files for every configured pair (read-only). */
export function localStatesForPairs(pairs: string[], stateDir?: string): { states: LocalState[]; unreadable: string[] } {
  const states: LocalState[] = [];
  const unreadable: string[] = [];
  const bases = new Set<string>();
  for (const p of pairs) {
    const base = (p.split("/")[0] ?? "").toUpperCase();
    if (base) bases.add(base);
  }
  for (const base of bases) {
    const r = readLocalStates(base, stateDir);
    states.push(...r.states);
    unreadable.push(...r.unreadable);
  }
  return { states, unreadable };
}

/**
 * Pure: local-state sanity pass. Reuses the repo's classifier on the LOCAL
 * side only (unreadable state files are errors; a state with no venue row is
 * a warning). The venue verdict is `classifyBootVenue` — the daemon's own
 * ownership model is stricter than the local-state-file model, so the
 * foreign-order branch of `classifyStrays` is replaced by it.
 */
export function classifyLocalStates(pairs: string[], local: LocalState[], unreadable: string[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [i, p] of pairs.entries()) {
    const pair = p.split("/")[0] ? `${p.split("/")[0]!.toUpperCase()}/${(p.split("/")[1] ?? "USDT").toUpperCase()}` : p;
    const own = local.filter((s) => s.pair ? rowMatchesPair(s, pair) : true);
    const strays = classifyStrays({ pair, local: own, unreadable, positions: [], orders: [] });
    for (const s of strays) {
      if (s.code === "venue-unchecked") continue;
      if (s.level === "error") errors.push(`[${s.code}] ${s.detail}`);
      else warnings.push(`[${s.code}] ${s.detail}`);
    }
    void i;
  }
  return { errors, warnings };
}

/* ------------------------------------------------------------------ */
/* drain plan (pure)                                                  */
/* ------------------------------------------------------------------ */

export type DaemonMode = "booting" | "running" | "draining" | "stopped";
export type DrainReason = "sigint" | "sigterm" | "kill-switch" | "health-tripped";

export type DrainPlan = {
  mode: "draining";
  reason: DrainReason;
  /** Cancel the daemon's OWN working orders (never a foreign one). */
  cancelWorkingOrders: boolean;
  /** Close open positions. Only ever true with the explicit human flag. */
  flattenPositions: boolean;
  /** Stop every child. */
  stopChildren: boolean;
  /** Why flatten was refused (empty when flatten is allowed). */
  flattenRefusal: string | null;
};

/**
 * Pure: what a drain does.
 *
 * - cancelWorkingOrders: always true. Cancels are risk-reducing and only
 *   ever touch order ids the daemon owns.
 * - flattenPositions: true ONLY when the human passed the explicit flag.
 *   During a kill-switch trip it is refused: the server's own gate refuses
 *   closes while the kill switch is on, so attempting one would only log
 *   errors (I3).
 */
export function planDrain(args: {
  reason: DrainReason;
  killSwitchOn: boolean;
  flattenOnShutdown: boolean;
  mode: DaemonMode;
}): DrainPlan {
  const flattenRequested = args.flattenOnShutdown === true;
  let flattenPositions = flattenRequested;
  let flattenRefusal: string | null = null;
  if (flattenRequested && args.killSwitchOn) {
    flattenPositions = false;
    flattenRefusal = "kill switch is on — the server refuses closes while it is engaged; positions were left open on purpose";
  }
  return {
    mode: "draining",
    reason: args.reason,
    cancelWorkingOrders: true,
    flattenPositions,
    stopChildren: true,
    flattenRefusal,
  };
}

/* ------------------------------------------------------------------ */
/* child spec + restart plan (pure)                                   */
/* ------------------------------------------------------------------ */

export type ChildRuntime = {
  name: string;
  role: DaemonRole;
  /** Completed exits (restarts already spent). */
  restarts: number;
  alive: boolean;
  /** Earliest ms timestamp at which the next spawn may happen. */
  nextSpawnAtMs: number | null;
};

export type RestartPlan = {
  action: "spawn" | "wait" | "dead";
  delayMs: number;
  reason: string;
};

/**
 * Pure: what to do with a child right now.
 * Backoff is the shared `backoffMs` from supervise.ts (1s × 2^n, cap 30s).
 */
export function planRestart(rt: ChildRuntime, cfg: { maxRestarts: number }, nowMs: number): RestartPlan {
  if (rt.alive) return { action: "wait", delayMs: 0, reason: "alive" };
  if (rt.restarts > cfg.maxRestarts) {
    return { action: "dead", delayMs: 0, reason: `restart budget exhausted (${cfg.maxRestarts})` };
  }
  if (rt.nextSpawnAtMs !== null && nowMs < rt.nextSpawnAtMs) {
    return { action: "wait", delayMs: rt.nextSpawnAtMs - nowMs, reason: "backoff" };
  }
  const delayMs = rt.restarts === 0 ? 0 : backoffMs(rt.restarts - 1, SUPERVISE_BACKOFF_BASE_MS, SUPERVISE_BACKOFF_CAP_MS);
  return { action: "spawn", delayMs, reason: rt.restarts === 0 ? "first spawn" : `restart ${rt.restarts}/${cfg.maxRestarts}` };
}

/**
 * Pure: child argv.
 *
 * `--yes` (real money) appears ONLY for the executor role, and only when
 * the operator opted in (`allowLive`) AND the fire gate is open
 * (`livePermitted`: running mode, kill switch off, health ok). Every other
 * child — signal, monitor, learning — is structurally incapable of firing.
 */
export function buildChildArgv(spec: DaemonChildSpec, opts: { allowLive: boolean; livePermitted: boolean }): string[] {
  const argv = [spec.command, ...spec.args];
  if (spec.role === "executor" && spec.live && opts.allowLive && opts.livePermitted) argv.push("--yes");
  return argv;
}

/** True when this argv may place a real order. */
export function argvCanFire(argv: string[]): boolean {
  return argv.includes("--yes");
}

/* ------------------------------------------------------------------ */
/* kill switch (the single poll hook)                                 */
/* ------------------------------------------------------------------ */

export type KillSwitchPoll = {
  /** True = the server-side kill switch is ON (or unreadable → fail closed). */
  on: boolean;
  error: string | null;
  /** True when the read failed (the daemon treats that as "on"). */
  unreadable: boolean;
  /**
   * True when the read failed TRANSIENTLY (rate limit, timeout, 5xx).
   * A transient failure is not treated as "the switch is on" — the
   * machine must not stop trading because a READ was throttled. It is
   * logged and retried; only a genuine, persistent unreadability stops
   * the machine.
   */
  transient: boolean;
};

/**
 * The kill-switch poll, with the read error kept for logging.
 * A failed read is NOT "safe": `on` is true, so the daemon fails closed.
 */
export async function pollKillSwitch(pat: string, url?: string, call: TradeCall = callTool): Promise<KillSwitchPoll> {
  let out: unknown;
  try {
    out = await call("read_risk_limits", {}, pat, url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A TRANSIENT failure (rate limit, timeout, a 5xx) is not the same
    // thing as a switch nobody can read. Treating a rate limit as "the
    // kill switch is ON" drains the machine every time the MCP layer
    // throttles it — which, at a 5s poll, is every few minutes. The
    // machine must not stop trading because a READ failed.
    //
    // So: a transient failure keeps the switch in its LAST KNOWN state
    // (fail-safe for the read, not fail-stop for the machine), and the
    // caller is told the read was transient. A switch that is genuinely
    // unreadable — the server not reporting the field at all — still
    // reads as ON.
    // The POLL stays fail-closed: an unknown state reads as ON, so any
    // consumer of this function is safe by default. The judgment about
    // whether an unreadable state is worth STOPPING the machine lives in
    // the daemon, which can see how many consecutive reads have failed.
    return { on: true, error: msg, unreadable: true, transient: isTransientReadFailure(msg) };
  }
  const risk = normalizeRiskLimits(out);
  if (risk.killSwitch === null) {
    // The server did not report the switch at all — unreadable, fail closed.
    return { on: true, error: "risk limits did not report kill_switch_enabled", unreadable: true, transient: false };
  }
  return { on: risk.killSwitch === true, error: null, unreadable: false, transient: false };
}

/**
 * Pure: is this a TRANSIENT read failure (retry) or a genuine one?
 *
 * Transient: the request may succeed on the next attempt — a rate limit,
 * a timeout, a network blip, a 5xx from the edge.
 *
 * NOT transient: an authentication or scope refusal (401/403), which will
 * fail identically forever and must not be retried into a drain loop.
 */
export function isTransientReadFailure(msg: string): boolean {
  const m = msg.toLowerCase();
  if (/\b(401|403)\b/.test(m)) return false;
  if (m.includes("unauthor") || m.includes("forbidden") || m.includes("scope")) return false;
  if (m.includes("rate limit") || m.includes("rate_limited") || m.includes("too many requests")) return true;
  if (m.includes("timeout") || m.includes("timed out") || m.includes("etimedout")) return true;
  if (m.includes("fetch failed") || m.includes("econnreset") || m.includes("network")) return true;
  if (/\b50[0-9]\b/.test(m) || m.includes("internal server error") || m.includes("bad gateway")) return true;
  return false;
}

/**
 * THE KILL-SWITCH HOOK.
 *
 * The single function the daemon polls to learn whether the server-side kill
 * switch is on. Returns true when it is on. The daemon polls this on its own
 * timer (manifest `killSwitchPollSec`), independent of every child cadence,
 * so a flip stops new fires and starts the drain immediately (I4).
 *
 * An unreadable switch reads as ON (fail closed) — a switch nobody can read
 * is not a switch that is safe.
 */
export async function readServerKillSwitch(pat: string, url?: string, call: TradeCall = callTool): Promise<boolean> {
  return (await pollKillSwitch(pat, url, call)).on;
}

/* ------------------------------------------------------------------ */
/* venue truth (read-only)                                            */
/* ------------------------------------------------------------------ */

export type VenueTruth = {
  positions: VenueRow[];
  orders: VenueRow[];
  freeMarginUsd: number | null;
  error: string | null;
  checkedAt: string;
};

export type DaemonDeps = {
  call?: TradeCall;
  listConns?: typeof listConnections;
  now?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  spawnFn?: (argv: string[]) => ChildProcess;
  log?: (line: string) => void;
};

/**
 * READ-ONLY venue truth: open positions, working orders and free margin.
 * Never places, cancels or closes anything.
 */
export async function readVenueTruth(
  args: { exchange: string; pat: string; url?: string },
  deps: DaemonDeps = {},
): Promise<VenueTruth> {
  const call = deps.call ?? callTool;
  const listConns = deps.listConns ?? listConnections;
  const checkedAt = new Date().toISOString();
  try {
    const conns = await listConns(args.pat, args.url);
    const conn = pickConnection(conns, args.exchange, true);
    if (!conn) throw new Error(`no ${args.exchange} connection — connect it in-app first`);
    const [posOut, ordOut, balOut] = await Promise.all([
      call("read_live_datum", { kind: "positions", connectionId: conn.id, withExits: true }, args.pat, args.url),
      call("list_open_orders", { exchange: args.exchange }, args.pat, args.url),
      call("read_live_datum", { kind: "balances", connectionId: conn.id }, args.pat, args.url),
    ]);
    const positions = collectRows(posOut).filter((r) => isOpenPosition(r as Record<string, unknown>)) as VenueRow[];
    const orders = extractOpenOrders(ordOut) as VenueRow[];
    const account = accountFromBalances(balOut);
    return {
      positions,
      orders,
      freeMarginUsd: account.unknown ? null : account.freeUsd,
      error: null,
      checkedAt,
    };
  } catch (e) {
    return {
      positions: [],
      orders: [],
      freeMarginUsd: null,
      error: e instanceof Error ? e.message : String(e),
      checkedAt,
    };
  }
}

/** Raw size of a venue position row (null when unknown — never guessed). */
export function positionSizeOf(row: VenueRow): number | null {
  for (const k of ["size", "qty", "quantity", "contracts", "currentQty", "positionAmt", "holdVol"] as const) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Side of a venue position row ("long"/"short", null when unknown). */
export function positionSideOf(row: VenueRow): "long" | "short" | null {
  const raw = String(row.side ?? row.posSide ?? "").toLowerCase();
  if (raw === "long" || raw === "buy") return "long";
  if (raw === "short" || raw === "sell") return "short";
  const n = positionSizeOf(row);
  if (n === null || n === 0) return null;
  return n > 0 ? "long" : "short";
}

/* ------------------------------------------------------------------ */
/* paths + daemon state                                               */
/* ------------------------------------------------------------------ */

/** Daemon log file — lives beside the supervisor's log dir. */
export function defaultDaemonLogFile(): string {
  return join(defaultLogDir(), "daemon.log");
}

/** Daemon heartbeat file — beside the supervisor's heartbeat file. */
export function defaultDaemonHeartbeatPath(): string {
  return join(dirname(defaultHeartbeatPath()), "daemon-heartbeat.json");
}

/** Daemon state dir (its own state file + the owner lock). */
export function defaultDaemonStateDir(): string {
  return join(dirname(defaultHeartbeatPath()), "daemon");
}

export type DaemonState = {
  version: number;
  sessionId: string;
  pairs: string[];
  /** Order ids the daemon placed (its own attribution set). */
  ownedOrderIds: string[];
  /** Pairs the daemon placed an intent for (position attribution). */
  ownedPairs: string[];
  updatedAt: string;
};

export function defaultDaemonStatePath(dir?: string): string {
  return resolveStorePath(dir, "daemon-state.json", defaultDaemonStateDir());
}

export function defaultDaemonOwnerLockPath(dir?: string): string {
  return resolveStorePath(dir, "daemon-owner.json", defaultDaemonStateDir());
}

/**
 * The owner lock (I1). Records the pid of the live daemon so a SECOND
 * daemon cannot start against the same margin pool. Kept separate from the
 * state file: the state file survives a crash (it holds the order
 * attribution), the lock is only meaningful while its pid is alive.
 */
export type DaemonOwnerLock = {
  pid: number;
  sessionId: string;
  startedAt: string;
};

/** Sanitize a raw owner lock; null = reject (missing/corrupt reads as no lock). */
export function sanitizeDaemonOwnerLock(raw: unknown): DaemonOwnerLock | null {
  const doc = raw as Partial<DaemonOwnerLock>;
  if (!doc || typeof doc !== "object") return null;
  const pid = typeof doc.pid === "number" ? doc.pid : Number(doc.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    sessionId: typeof doc.sessionId === "string" ? doc.sessionId : "",
    startedAt: typeof doc.startedAt === "string" ? doc.startedAt : "",
  };
}

export function readDaemonOwnerLock(path: string): DaemonOwnerLock | null {
  return loadJsonStoreNullable(path, sanitizeDaemonOwnerLock);
}

/** Write the owner lock (atomically). */
export function writeDaemonOwnerLock(path: string, lock: DaemonOwnerLock): void {
  saveJsonStoreAtomic(path, lock);
}

/** Remove the owner lock (only if it is still ours). */
export function clearDaemonOwnerLock(path: string, sessionId: string): void {
  const current = readDaemonOwnerLock(path);
  if (current && current.sessionId && current.sessionId !== sessionId) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}

/** Sanitize a raw daemon state; null = reject (missing/corrupt reads as unattributed). */
export function sanitizeDaemonState(raw: unknown): DaemonState | null {
  const doc = raw as Partial<DaemonState>;
  if (!doc || typeof doc !== "object") return null;
  return {
    version: typeof doc.version === "number" ? doc.version : DAEMON_MANIFEST_VERSION,
    sessionId: typeof doc.sessionId === "string" ? doc.sessionId : "",
    pairs: Array.isArray(doc.pairs) ? doc.pairs.map(String) : [],
    ownedOrderIds: Array.isArray(doc.ownedOrderIds) ? doc.ownedOrderIds.map(String) : [],
    ownedPairs: Array.isArray(doc.ownedPairs) ? doc.ownedPairs.map(String) : [],
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : "",
  };
}

/** Read the daemon state file. Unreadable/absent → null (never throws). */
export function readDaemonState(path: string): DaemonState | null {
  return loadJsonStoreNullable(path, sanitizeDaemonState);
}

/** Write the daemon state file atomically (tmp + rename). */
export function writeDaemonState(path: string, state: DaemonState): void {
  saveJsonStoreAtomic(path, state);
}

/** True when a pid is still alive (EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/* ------------------------------------------------------------------ */
/* heartbeat payload (pure)                                           */
/* ------------------------------------------------------------------ */

export type DaemonChildHeartbeat = {
  name: string;
  role: DaemonRole;
  pid: number | null;
  alive: boolean;
  /** CRASH restarts. A one-shot child's clean exit does not spend this. */
  restarts: number;
  /** Clean one-shot polls. Drives the respawn backoff, not the crash budget. */
  polls: number;
  lastExitCode: number | null;
  lastExitAt: string | null;
  /** True when the argv could place a real order. */
  canFire: boolean;
};

export type DaemonHeartbeatArgs = {
  pid: number;
  sessionId: string;
  startedAt: string;
  at: string;
  uptimeSec: number;
  mode: DaemonMode;
  health: HealthVerdict;
  children: DaemonChildHeartbeat[];
  killSwitch: { on: boolean; checkedAt: string; error: string | null };
  openPositions: number;
  freeMarginUsd: number | null;
  errorRate: number;
  consecutiveFailures: number;
  dryRun: boolean;
  boot: { ok: boolean; foreignOrders: number; foreignPositions: number };
};

/** Pure: the daemon heartbeat file payload (the watchdog's liveness source). */
export function daemonHeartbeatPayload(args: DaemonHeartbeatArgs): Record<string, unknown> {
  return {
    event: "daemon-heartbeat",
    pid: args.pid,
    sessionId: args.sessionId,
    startedAt: args.startedAt,
    at: args.at,
    uptimeSec: Math.max(0, Math.round(args.uptimeSec)),
    mode: args.mode,
    health: { state: args.health.state, reasons: args.health.reasons },
    killSwitch: args.killSwitch,
    children: args.children,
    openPositions: args.openPositions,
    freeMarginUsd: args.freeMarginUsd,
    errorRate: args.errorRate,
    consecutiveFailures: args.consecutiveFailures,
    dryRun: args.dryRun,
    boot: args.boot,
    fireGate: healthAllowsFire(args.health.state) && !args.killSwitch.on && args.mode === "running",
  };
}

/* ------------------------------------------------------------------ */
/* the daemon                                                         */
/* ------------------------------------------------------------------ */

type LiveChild = {
  spec: DaemonChildSpec;
  argv: string[];
  proc: ChildProcess | null;
  pid: number | null;
  alive: boolean;
  /** CRASH restarts. A one-shot child's clean exit does not spend this. */
  restarts: number;
  /** Clean one-shot polls. Drives the respawn backoff, not the crash budget. */
  polls: number;
  lastExitCode: number | null;
  lastExitAt: string | null;
  nextSpawnAtMs: number | null;
  /** True when the last exit was caused by the daemon revoking the fire gate. */
  gateKilled: boolean;
};

export type DaemonOpts = {
  manifest: DaemonManifest;
  json: boolean;
  /** Operator opt-in for real money. Without it every child is dry-run. */
  allowLive: boolean;
  /** The ONLY way the daemon may flatten an open position (I3). */
  flattenOnShutdown: boolean;
  /** Boot check + report, no children spawned (cron-safe). */
  once: boolean;
  logDir?: string;
  heartbeatPath?: string;
  /** Where the daemon keeps its own state file + owner lock. */
  daemonStateDir?: string;
  /** Where the scalp/grid/trail local state files live. */
  localStateDir?: string;
  url?: string;
  pat?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function entryPoint(): string {
  return process.argv[1] ?? join("packages", "jw3-cli", "dist", "index.js");
}

function newSessionId(): string {
  return `jw3d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `jw3 daemon` — boot reconcile → spawn → supervise → drain.
 *
 * The state machine (what may fire, when to drain, what a restart costs) is
 * pure and lives above; this function is the process control around it.
 */
export async function cmdDaemon(opts: DaemonOpts, deps: DaemonDeps = {}): Promise<void> {
  const validated = validateDaemonManifest(opts.manifest);
  if (!validated.ok) {
    console.error(`Bad daemon manifest — nothing was started:\n  - ${validated.errors.join("\n  - ")}`);
    process.exitCode = 2;
    return;
  }
  const cfg = validated.manifest;

  const now = deps.now ?? (() => Date.now());
  const sleepMs = deps.sleepMs ?? sleep;
  const call = deps.call ?? callTool;
  const logFile = join(opts.logDir ?? defaultLogDir(), "daemon.log");
  const hbPath = opts.heartbeatPath ?? defaultDaemonHeartbeatPath();
  const stateDir = opts.daemonStateDir ?? defaultDaemonStateDir();
  const statePath = defaultDaemonStatePath(stateDir);
  const lockPath = defaultDaemonOwnerLockPath(stateDir);
  const localStateDir = opts.localStateDir ?? tmpdir();

  const startedAt = new Date(now()).toISOString();
  const t0 = now();
  const sessionId = newSessionId();

  const stamp = (): string => new Date(now()).toISOString();
  const log = (msg: string): void => {
    const line = `${stamp()} ${msg}`;
    if (!opts.json) console.log(line);
    appendLog(logFile, line, cfg.maxLogBytes, cfg.maxLogFiles);
    deps.log?.(line);
  };

  // ── owner lock (I1: one daemon per margin pool) ──
  const previousLock = readDaemonOwnerLock(lockPath);
  if (previousLock && pidAlive(previousLock.pid)) {
    console.error(
      `Another daemon owns this margin pool (pid ${previousLock.pid}, session ${previousLock.sessionId || "?"}) — ${lockPath}. ` +
        `Refusing to start a second writer.`,
    );
    process.exitCode = 3;
    return;
  }

  // ── PAT: the daemon cannot reconcile (or trade) without one ──
  const pat = resolvePat(opts.pat);
  if (!pat) {
    if (opts.once) {
      console.error("Not authenticated — cannot reconcile the venue. Run `jw3 auth login --browser` first; nothing was started.");
      process.exitCode = 2;
      return;
    }
    console.error("Not authenticated — the daemon owns order placement and cannot verify the venue without a PAT. Nothing was started.");
    process.exitCode = 2;
    return;
  }

  // ── boot: READ-ONLY reconcile against the venue (I2) ──
  const local = localStatesForPairs(cfg.pairs, localStateDir);
  const priorState = readDaemonState(statePath);
  const truth = await readVenueTruth({ exchange: cfg.exchange, pat, url: opts.url }, deps);

  const ownedOrderIds = harvestOwnedOrderIds(local.states, priorState?.ownedOrderIds ?? []);
  const ownedPairs = [...new Set([...(priorState?.ownedPairs ?? []), ...cfg.pairs])];
  const verdict = classifyBootVenue({
    exchange: cfg.exchange,
    configuredPairs: cfg.pairs,
    ownedOrderIds,
    ownedPairs,
    venueOrders: truth.orders,
    venuePositions: truth.positions,
  });
  const localVerdict = classifyLocalStates(cfg.pairs, local.states, local.unreadable);

  const bootOk = verdict.ok && truth.error === null && localVerdict.errors.length === 0;
  const bootSummary = {
    ok: bootOk,
    foreignOrders: verdict.foreignOrders.length,
    foreignPositions: verdict.foreignPositions.length,
  };

  if (opts.json) {
    // A healthy boot line must contain NO "error" substring at all — not
    // even as a KEY with a null value. A watcher that greps for "error"
    // would otherwise fire on `"venueError":null` on every healthy boot,
    // and an alarm that fires when nothing is wrong is an alarm the
    // operator learns to ignore.
    //
    // So: the null-valued error keys are OMITTED when there is no error,
    // and the status is carried by a positively-matchable `status` field.
    const bootErrors = [
      ...verdict.errors,
      ...localVerdict.errors,
      ...(truth.error ? [`venue read failed: ${truth.error}`] : []),
    ];
    console.log(
      JSON.stringify({
        event: "daemon-boot",
        status: bootOk ? "ok" : "problem",
        sessionId,
        exchange: cfg.exchange,
        pairs: cfg.pairs,
        venueChecked: truth.error === null,
        ...(truth.error ? { venueError: truth.error } : {}),
        openPositions: verdict.openPositionCount,
        freeMarginUsd: truth.freeMarginUsd,
        ownedOrderIds,
        foreignOrders: verdict.foreignOrders,
        foreignPositions: verdict.foreignPositions,
        ...(bootErrors.length > 0 ? { errors: bootErrors } : {}),
        warnings: [...verdict.warnings, ...localVerdict.warnings],
        dryRun: !opts.allowLive,
      }),
    );
  }

  if (!bootOk) {
    const errs = [...verdict.errors, ...localVerdict.errors];
    if (truth.error) errs.push(`venue read failed: ${truth.error} — the daemon will not start blind (I2)`);
    log(`BOOT REFUSED — ${errs.length} problem(s):`);
    for (const e of errs) log(`  ${e}`);
    console.error(
      `Refusing to start the daemon:\n  - ${errs.join("\n  - ")}\n` +
        `Nothing was spawned. Resolve the venue state by hand, then restart the daemon.`,
    );
    process.exitCode = 3;
    return;
  }

  log(
    `DAEMON boot — ${cfg.children.length} child(ren), ${cfg.pairs.length} pair(s) on ${cfg.exchange}, ` +
      `${verdict.openPositionCount} open position(s), ${ownedOrderIds.length} own working order(s)` +
      `${opts.allowLive ? " (LIVE allowed)" : " (dry-run: executor spawns WITHOUT --yes)"}`,
  );
  for (const w of [...verdict.warnings, ...localVerdict.warnings]) log(`  WARN ${w}`);

  if (opts.once) {
    log(`ONCE — boot reconciled, nothing spawned.`);
    return;
  }

  // ── take the owner lock (I1: one writer per margin pool) ──
  try {
    writeDaemonOwnerLock(lockPath, { pid: process.pid, sessionId, startedAt });
  } catch (e) {
    log(`LOCK-FAIL ${lockPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A crash leaves the lock behind; the pid check above makes it stale
  // automatically. Release it on a clean exit.
  const releaseLock = (): void => {
    try {
      clearDaemonOwnerLock(lockPath, sessionId);
    } catch {
      // best-effort
    }
  };
  process.once("exit", releaseLock);

  // ── runtime state ──
  let mode: DaemonMode = "running";
  let killSwitchOn = false;
  let killSwitchError: string | null = null;
  // Consecutive TRANSIENT kill-switch read failures. A single throttled
  // read must not stop the machine; three in a row (~45s at a 15s poll)
  // is a real outage.
  let transientReads = 0;
  let killSwitchCheckedAt = new Date(now()).toISOString();
  let consecutiveFailures = 0;
  const outcomes: boolean[] = [];
  let openPositions = verdict.openPositionCount;
  let freeMarginUsd = truth.freeMarginUsd;
  let drainReason: DrainReason | null = null;

  const children: LiveChild[] = cfg.children
    .filter((c) => c.enabled)
    .map((spec) => ({
      spec,
      argv: [],
      proc: null,
      pid: null,
      alive: false,
      restarts: 0,
      polls: 0,
      lastExitCode: null,
      lastExitAt: null,
      nextSpawnAtMs: null,
      gateKilled: false,
    }));

  const owned = new Set<string>(ownedOrderIds);

  /**
   * Heartbeat age = time since the daemon last PROVED liveness with a
   * successful supervised operation (a successful venue read). It is NOT
   * the daemon's uptime — uptime grows forever and would trip the
   * dead-man rule 90s after boot. The age only grows when progress stops.
   */
  let lastHealthyAtMs = t0;

  const healthNow = (): HealthVerdict =>
    computeHealthState(
      {
        heartbeatAgeSec: Math.max(0, Math.round((now() - lastHealthyAtMs) / 1000)),
        consecutiveFailures,
        openPositions,
        freeMarginUsd,
        errorRate: computeErrorRate(outcomes, cfg.errorWindow),
      },
      cfg.health,
    );

  /** I5: only `ok` may fire, and never while draining. */
  const fireGateOpen = (health: HealthVerdict): boolean =>
    mode === "running" && !killSwitchOn && healthAllowsFire(health.state);

  const writeHeartbeat = (health: HealthVerdict): void => {
    const payload = daemonHeartbeatPayload({
      pid: process.pid,
      sessionId,
      startedAt,
      at: new Date(now()).toISOString(),
      uptimeSec: (now() - t0) / 1000,
      mode,
      health,
      children: children.map((c) => ({
        name: c.spec.name,
        role: c.spec.role,
        pid: c.pid,
        alive: c.alive,
        restarts: c.restarts,
        polls: c.polls,
        lastExitCode: c.lastExitCode,
        lastExitAt: c.lastExitAt,
        canFire: argvCanFire(c.argv),
      })),
      killSwitch: { on: killSwitchOn, checkedAt: killSwitchCheckedAt, error: killSwitchError },
      openPositions,
      freeMarginUsd,
      errorRate: computeErrorRate(outcomes, cfg.errorWindow),
      consecutiveFailures,
      dryRun: !opts.allowLive,
      boot: bootSummary,
    });
    try {
      mkdirSync(dirname(hbPath), { recursive: true, mode: 0o700 });
      writeFileSync(hbPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      // best-effort — the loop keeps supervising
    }
  };

  const persistState = (): void => {
    try {
      writeDaemonState(statePath, {
        version: DAEMON_MANIFEST_VERSION,
        sessionId,
        pairs: cfg.pairs,
        ownedOrderIds: [...owned],
        ownedPairs,
        updatedAt: new Date(now()).toISOString(),
      });
    } catch {
      // best-effort
    }
  };

  const spawnChild = (c: LiveChild): void => {
    if (mode !== "running") return;
    const health = healthNow();
    c.argv = buildChildArgv(c.spec, { allowLive: opts.allowLive, livePermitted: fireGateOpen(health) });
    log(
      `START ${c.spec.name} (${c.spec.role}) attempt ${c.restarts + 1} — node ${c.argv.join(" ")}` +
        `${argvCanFire(c.argv) ? " [LIVE]" : " [dry-run]"}`,
    );
    let proc: ChildProcess;
    try {
      proc = (deps.spawnFn ?? ((argv: string[]) => spawn(process.execPath, [entryPoint(), ...argv], { stdio: ["ignore", "pipe", "pipe"] })))(c.argv);
    } catch (e) {
      log(`SPAWN-FAIL ${c.spec.name}: ${e instanceof Error ? e.message : String(e)}`);
      c.restarts++;
      outcomes.push(false);
      consecutiveFailures++;
      if (c.restarts <= cfg.maxRestarts) c.nextSpawnAtMs = now() + backoffMs(c.restarts - 1);
      return;
    }
    c.proc = proc;
    c.pid = proc.pid ?? null;
    c.alive = true;
    c.gateKilled = false;
    proc.stdout?.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        if (line.trim()) appendLog(logFile, `${stamp()} [${c.spec.name}] ${line}`, cfg.maxLogBytes, cfg.maxLogFiles);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        if (line.trim()) appendLog(logFile, `${stamp()} [${c.spec.name}:err] ${line}`, cfg.maxLogBytes, cfg.maxLogFiles);
      }
    });
    proc.on("exit", (code) => {
      c.alive = false;
      c.pid = null;
      c.proc = null;
      c.lastExitCode = code ?? 1;
      c.lastExitAt = new Date(now()).toISOString();
      if (c.gateKilled) {
        // The daemon revoked the fire gate — this is not a crash and does
        // not spend the restart budget.
        outcomes.push(true);
        consecutiveFailures = 0;
        return;
      }
      if (mode !== "running") {
        // A normal shutdown (SIGTERM during a drain). Not a failure.
        log(`STOP ${c.spec.name} exit=${c.lastExitCode}`);
        outcomes.push(true);
        return;
      }
      if (c.lastExitCode === 0) {
        // A child that exits 0 did its job. `monitor` and `watchdog
        // check` are ONE-SHOT commands by design — the daemon supervises
        // them and respawns them on a cadence, so a clean exit is the
        // normal case, not a failure. Counting it as a failure made the
        // error rate climb with each poll until the daemon drained itself
        // on a health trip it had caused itself.
        //
        // A clean exit must NOT spend the CRASH restart budget either:
        // that budget exists for a child that keeps CRASHING, and a
        // one-shot that has run its course 20 times is a healthy
        // supervisor, not a dead child.
        outcomes.push(true);
        consecutiveFailures = 0;
        const delay = backoffMs(c.polls ?? 0);
        c.polls = (c.polls ?? 0) + 1;
        c.nextSpawnAtMs = now() + delay;
        log(`RESPAWN ${c.spec.name} (one-shot, exit=0) in ${delay}ms (poll ${c.polls})`);
        return;
      }
      outcomes.push(false);
      consecutiveFailures++;
      c.restarts++;
      if (c.restarts > cfg.maxRestarts) {
        log(`DEAD ${c.spec.name} exit=${c.lastExitCode} — restart budget exhausted (${cfg.maxRestarts}). Left stopped.`);
        return;
      }
      const delay = backoffMs(c.restarts - 1);
      c.nextSpawnAtMs = now() + delay;
      log(`RESTART ${c.spec.name} exit=${c.lastExitCode} in ${delay}ms (restart ${c.restarts}/${cfg.maxRestarts})`);
    });
  };

  /** Revoke the fire gate: stop the executor NOW, do not respawn it. */
  const revokeFireGate = (why: string): void => {
    for (const c of children) {
      if (c.spec.role !== "executor" || !c.alive) continue;
      c.gateKilled = true;
      log(`FIRE GATE CLOSED — ${why}. Stopping executor ${c.spec.name} (pid ${c.pid ?? "?"}).`);
      try {
        c.proc?.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  };

  /** Cancel the daemon's OWN working orders. Never a foreign one. */
  const cancelOwnWorkingOrders = async (why: string): Promise<number> => {
    let cancelled = 0;
    try {
      // Re-harvest the local state files first: children place NEW orders
      // while the daemon runs, so the boot-time ownership set is stale by
      // drain time. The state files are the child's own record of what it
      // placed — the daemon reads them, it never guesses.
      const live = localStatesForPairs(cfg.pairs, localStateDir);
      for (const id of harvestOwnedOrderIds(live.states, [...owned])) owned.add(id);
      const fresh = await readVenueTruth({ exchange: cfg.exchange, pat, url: opts.url }, deps);
      for (const row of fresh.orders) {
        const id = cancelOrderIdOf(row);
        if (!id || !owned.has(id)) continue;
        try {
          // OQ-12: a decision runLive sends. Confirmed by construction:
          // the drain is the daemon's own risk-REDUCING unwind of orders
          // its children placed (never gated by the kill switch).
          await runLive(
            {
              kind: "order",
              producer: "daemon-drain",
              tool: "cancel_order",
              args: cancelToolArgs({ exchange: cfg.exchange, orderId: id, pair: rowPairOf(row) || undefined }),
              yes: true,
            },
            { pat, url: opts.url, call: deps.call },
          );
          cancelled++;
        } catch (e) {
          log(`CANCEL-FAIL ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      log(`DRAIN cancelled ${cancelled} own working order(s) (${why})`);
    } catch (e) {
      log(`CANCEL-ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    return cancelled;
  };

  /** Flatten ONLY with the explicit human flag (I3). */
  const flattenOwnPositions = async (): Promise<void> => {
    const fresh = await readVenueTruth({ exchange: cfg.exchange, pat, url: opts.url }, deps);
    for (const row of fresh.positions) {
      const pair = rowPairOf(row);
      if (!pair) continue;
      const ours = ownedPairs.some((p) => rowMatchesPair(row, p));
      if (!ours) {
        log(`FLATTEN skipped ${pair} — not owned by this daemon`);
        continue;
      }
      const side = positionSideOf(row);
      const size = positionSizeOf(row);
      if (!side || size === null) {
        log(`FLATTEN skipped ${pair} — side/size unknown (never guessed)`);
        continue;
      }
      try {
        // Confirmed by the explicit --flatten-on-shutdown flag (checked by
        // the drain plan before this runs).
        await runLive(
          {
            kind: "order",
            producer: "daemon-drain",
            tool: "close_position",
            args: closeToolArgs({ exchange: cfg.exchange, pair, side, size }),
            yes: true,
          },
          { pat, url: opts.url, call: deps.call },
        );
        log(`FLATTEN closed ${side} ${size} ${pair} (explicit --flatten-on-shutdown)`);
      } catch (e) {
        log(`FLATTEN-FAIL ${pair}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const waitForChildren = async (timeoutMs: number): Promise<void> => {
    const deadline = now() + timeoutMs;
    while (now() < deadline && children.some((c) => c.alive)) {
      await sleepMs(50);
    }
    for (const c of children) {
      if (!c.alive) continue;
      c.gateKilled = true;
      try {
        c.proc?.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  /** I3/I4: the drain. Stop firing, cancel our orders, keep positions. */
  let drainPromise: Promise<void> | null = null;
  /**
   * The drain. Every caller awaits the SAME promise: a SIGINT, a kill-switch
   * trip and a health trip can race, and the cancels must finish before the
   * process exits — a drain that is still in flight when the daemon returns
   * would leave the working orders behind.
   */
  const drain = (reason: DrainReason, health: HealthVerdict): Promise<void> => {
    if (drainPromise) return drainPromise;
    mode = "draining";
    drainReason = reason;
    drainPromise = (async () => {
      const plan = planDrain({
        reason,
        killSwitchOn,
        flattenOnShutdown: opts.flattenOnShutdown,
        mode,
      });
      log(
        `DRAIN (${reason}) — firing stopped, ${children.length} child(ren) stopping, ` +
          `own working orders will be cancelled, open positions left alone` +
          `${plan.flattenPositions ? ", FLATTEN requested by --flatten-on-shutdown" : ""}` +
          `${plan.flattenRefusal ? ` (flatten refused: ${plan.flattenRefusal})` : ""}` +
          // WHY it tripped. A drain without its reason is an unactionable
          // log line: the operator cannot tell a real fault from a
          // threshold that was simply set too tight.
          (health.reasons.length > 0 ? ` — ${health.state}: ${health.reasons.join("; ")}` : ""),
      );
      revokeFireGate(`drain (${reason})`);
      for (const c of children) {
        c.gateKilled = true;
        try {
          c.proc?.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      await waitForChildren(cfg.drainTimeoutSec * 1000);
      if (plan.cancelWorkingOrders) await cancelOwnWorkingOrders(`drain: ${reason}`);
      if (plan.flattenPositions) await flattenOwnPositions();
      mode = "stopped";
      writeHeartbeat(health);
      persistState();
      log(`DAEMON stopped (drain reason: ${reason}).`);
    })();
    return drainPromise;
  };

  // ── signals: SIGINT/SIGTERM start the drain (I3) ──
  //
  // `on`, NOT `once`: a second Ctrl-C during a slow drain must NOT fall
  // through to Node's default handler (which kills the process mid-cancel
  // and leaves the working orders behind). The drain is idempotent — a
  // repeated signal just re-enters the same promise.
  const onSignal = (sig: "SIGINT" | "SIGTERM"): void => {
    if (mode !== "running" && !drainPromise) return;
    void drain(sig === "SIGINT" ? "sigint" : "sigterm", healthNow());
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // ── children ──
  for (const c of children) spawnChild(c);

  // ── kill-switch loop (I4: its own timer, independent of every child) ──
  // The loop exits by `return` when the switch trips, so there is no
  // stop-flag to set.
  const killSwitchLoop = async (): Promise<void> => {
    while (mode === "running") {
      const poll = await pollKillSwitch(pat, opts.url, call);
      killSwitchCheckedAt = new Date(now()).toISOString();
      killSwitchError = poll.error;
      if (poll.transient) {
        // A throttled or timed-out READ is not a kill switch, but it is
        // also not proof that the switch is OFF. The poll stays fail-closed
        // (on=true) for any consumer; the DAEMON does not stop the machine
        // on the first blip — it requires the read to fail REPEATEDLY.
        //
        // At a 15s poll, three consecutive transient failures mean the
        // read has been broken for ~45s, which is a real outage rather
        // than a throttle. Draining on the first one stopped the machine
        // every time the MCP layer rate-limited it.
        transientReads++;
        log(
          `KILL-SWITCH READ TRANSIENT (${poll.error}) — ${transientReads} consecutive ` +
            `${transientReads >= 3 ? "— treating as ON, stopping" : "— keeping the last known state, retrying"}`,
        );
        if (transientReads >= 3) {
          killSwitchOn = true;
          log(`KILL SWITCH UNREADABLE x${transientReads} (${poll.error}) — treating as ON, firing stops NOW, draining.`);
          revokeFireGate("kill switch unreadable");
          void drain("kill-switch", healthNow());
          return;
        }
        await sleepMs(Math.max(1, cfg.killSwitchPollSec) * 1000);
        continue;
      }
      transientReads = 0;
      if (poll.on && !killSwitchOn) {
        killSwitchOn = true;
        log(`KILL SWITCH ${poll.error ? `UNREADABLE (${poll.error}) — treating as ON` : "ENGAGED"} — firing stops NOW, draining.`);
        // Stop firing immediately — do not wait for the next child cycle.
        revokeFireGate("kill switch engaged");
        void drain("kill-switch", healthNow());
        return;
      }
      await sleepMs(Math.max(1, cfg.killSwitchPollSec) * 1000);
    }
  };

  // ── main loop: heartbeats, health, restarts, venue telemetry ──
  const mainLoop = async (): Promise<void> => {
    let lastHeartbeat = 0;
    let lastVenue = 0;
    while (mode === "running") {
      const health = healthNow();
      const t = now();

      if (t - lastHeartbeat >= cfg.heartbeatSec * 1000) {
        lastHeartbeat = t;
        writeHeartbeat(health);
      }
      if (t - lastVenue >= cfg.heartbeatSec * 1000) {
        lastVenue = t;
        const v = await readVenueTruth({ exchange: cfg.exchange, pat, url: opts.url }, deps);
        if (v.error === null) {
          openPositions = v.positions.length;
          freeMarginUsd = v.freeMarginUsd;
          outcomes.push(true);
          consecutiveFailures = 0;
          // Proof of liveness — the heartbeat age resets here, not on a timer.
          lastHealthyAtMs = now();
        } else {
          outcomes.push(false);
          consecutiveFailures++;
          log(`VENUE-READ-FAIL: ${v.error}`);
        }
      }

      // Health gate: degraded/tripped closes the fire gate immediately.
      const h2 = healthNow();
      if (!fireGateOpen(h2)) revokeFireGate(`health ${h2.state}`);
      if (healthShouldDrain(h2.state) && drainReason === null) {
        await drain("health-tripped", h2);
        return;
      }
      // Restarts. A child whose fire gate was revoked stays DOWN while the
      // gate is shut — respawning it would hot-loop (kill → spawn → kill)
      // and burn the restart budget on a gate decision, not a crash.
      for (const c of children) {
        if (c.alive) continue;
        if (c.spec.role === "executor" && !fireGateOpen(h2)) {
          if (c.nextSpawnAtMs === null) {
            c.nextSpawnAtMs = now() + 1000;
            log(`HOLD ${c.spec.name} — fire gate is closed (health ${h2.state}); the executor stays down until it reopens.`);
          }
          continue;
        }
        const plan = planRestart(
          { name: c.spec.name, role: c.spec.role, restarts: c.restarts, alive: c.alive, nextSpawnAtMs: c.nextSpawnAtMs },
          { maxRestarts: cfg.maxRestarts },
          now(),
        );
        if (plan.action === "spawn") {
          c.nextSpawnAtMs = null;
          spawnChild(c);
        }
      }

      await sleepMs(200);
    }
  };

  void killSwitchLoop();
  await mainLoop();

  // The main loop returns once the mode leaves "running" — but the drain may
  // still be in flight (a kill-switch trip starts it without the loop
  // awaiting it). Await the SAME promise so the cancels finish before the
  // process exits; otherwise the daemon would leave its working orders
  // behind on the way out.
  if (drainPromise) await drainPromise;
  else if (mode === "running") await drain(drainReason ?? "sigterm", healthNow());
  writeHeartbeat(healthNow());
  persistState();
}
