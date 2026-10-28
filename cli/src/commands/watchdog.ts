/**
 * `watchdog` — the INDEPENDENT kill-switch watchdog (daemon Phase 1).
 *
 * The watchdog is NOT part of the executor. It runs in its own process, on
 * its own timer, and reads its inputs from the SERVER (risk limits, live
 * account, venue orders) and from FILES (the executor's heartbeat). It never
 * imports the executor, never shares its event loop, and never asks the
 * executor whether it is alive — the heartbeat file IS the liveness
 * contract, and a stale heartbeat is treated as death. A hung executor
 * cannot suppress it, and a hung watchdog is caught by its own dead-man.
 *
 * The decision is a PURE function:
 *
 *   decideWatchdog({ riskState, account, executorHeartbeat, now }) → decision
 *
 * so every trip path is unit-testable with fabricated inputs and zero
 * network. The impure cycle (read → decide → act → heartbeat) lives in
 * `runWatchdogCycle`; the pure core has no I/O at all.
 *
 * TRIP ACTION ORDER is fixed and never varies:
 *   1. set the local breaker           (entries blocked even if we die next)
 *   2. cancel the machine's OWN orders (never a foreign order — see below)
 *   3. block new entries
 *   4. flatten positions               (ONLY when armed AND opted in)
 *   5. alert
 *
 * RESUME IS HUMAN-ONLY. The breaker stays tripped until an explicit resume
 * call that ALSO verifies the trip condition has cleared. There is no
 * automatic path that clears it — `watchdog.test.ts` guards the source to
 * prove it.
 *
 * FLATTEN is a separately-armed policy, default OFF, and additionally
 * opt-in per invocation. Even when armed it prefers a reduce-only close
 * (`close_position`); it never sends an opposing order that could open new
 * exposure. The watchdog never trades directionally.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../config.js";
import { fetchJson } from "../http.js";
import { callTool } from "../mcp.js";
import { isOpenPosition, readLocalStates, rowMatchesPair, rowPairOf } from "../reconcile.js";
import { accountFromBalances, positionNotional } from "./heat.js";
import { collectRows, listConnections, needPat, pickConnection } from "./market.js";
import { extractOpenOrders, normalizeRiskLimits, type TradeCall } from "./trade.js";
import { isTransientReadFailure } from "./daemon.js";

/* ------------------------------------------------------------------ */
/* doctrine + defaults (owner vocabulary)                               */
/* ------------------------------------------------------------------ */

/**
 * Owner doctrine (the 30%-risk math, mirrored in `jw3 degen`'s caps and the
 * TTM account floor). The watchdog does NOT size trades — it only refuses to
 * let risk open. The mapping:
 *   - heat cap $6 / max 2 concurrent → the open-notional + free-margin floor
 *   - halve after one stop, flat for the day after two → the server's daily
 *     loss + trade-count caps the watchdog watches
 *   - hourly cooldown after a full stop → executor-side; the watchdog's
 *     contribution is that a tripped breaker blocks the next entry too
 *   - account floor (TTM: $3) → the free-margin floor, per policy
 */
export const WATCHDOG_DOCTRINE = {
  /** Open risk cap, USD (`DEGEN_HEAT_CAP_USD`). */
  heatCapUsd: 6,
  /** Max concurrent positions (`DEGEN_MAX_CONCURRENT`). */
  maxConcurrent: 2,
  /** Flat for the day after this many full stops (`DEGEN_MAX_STOPS_PER_DAY`). */
  maxStopsPerDay: 2,
  /** Hourly cooldown after a full stop (`DEGEN_COOLDOWN_MS`). */
  cooldownMs: 3600_000,
  /** Smallest-account halt floor, USD (TTM doctrine). */
  accountFloorUsd: 3,
} as const;

/** Free-margin floor — same default as `jw3 heat --min-free 50`. */
export const WATCHDOG_DEFAULT_MIN_FREE_USD = 50;
/**
 * Aggregate open-notional cap, USD. Anchored on the server's per-order
 * autonomy ceiling (AUTONOMY_MAX_ORDER_NOTIONAL_USD = 250): holding more
 * open notional than a single max-sized order is over-exposed for this
 * account profile. The policy row overrides it.
 */
export const WATCHDOG_DEFAULT_MAX_OPEN_NOTIONAL_USD = 250;
/** Consecutive venue errors that trip the breaker. */
export const WATCHDOG_DEFAULT_MAX_VENUE_ERRORS = 3;
/** Executor dead-man: heartbeat older than this = executor dead. */
export const WATCHDOG_DEFAULT_EXECUTOR_STALE_MS = 90_000;
/** Watchdog's own dead-man: own heartbeat older than this = we were blind. */
export const WATCHDOG_DEFAULT_SELF_STALE_MS = 90_000;
/** |funding rate| per settlement (percent) that counts as a blowout. */
export const WATCHDOG_DEFAULT_FUNDING_BLOWOUT_PCT = 1;
/** Watchdog poll cadence (seconds) — same order as the supervisor heartbeat. */
export const WATCHDOG_DEFAULT_POLL_SEC = 15;
/** State file schema version. */
export const WATCHDOG_STATE_VERSION = 1;

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** Server-side risk state (read_risk_limits) — the control plane. */
export type WatchdogRiskState = {
  /** Server kill switch ON (operator/engineered stop). */
  killSwitch: boolean | null;
  /** Server circuit breaker tripped. */
  circuitBreakerTripped: boolean | null;
  /** Realized loss today, USD. */
  dailyRealizedLossUsd: number | null;
  /** Daily loss cap, USD (null = uncapped). */
  maxDailyLossUsd: number | null;
  /** Trades executed today. */
  dailyTradeCount: number | null;
  /** Daily trade cap (null = uncapped). */
  maxTradesPerDay: number | null;
  /** Daily notional used, USD. */
  dailyNotionalUsd: number | null;
  /** Daily notional cap, USD (null = uncapped). */
  maxDailyNotionalUsd: number | null;
  /** False when the risk row could not be read at all (fail closed). */
  readable: boolean;
  /**
   * True when the read failed for a TRANSIENT reason (a rate limit, a
   * timeout, a 5xx). A transient failure is not evidence that the kill
   * switch is on — it is evidence that we could not ask. The two are
   * different states and they must not share a verdict.
   */
  transient?: boolean;
  /** Why the read failed (only when readable = false). */
  readError?: string | null;
};

/** One armed venue-native exit leg (TP/SL/OCO). */
export type WatchdogExitLeg = { orderId?: string | null; kind?: string | null };

/** One open position (venue truth). */
export type WatchdogPosition = {
  pair: string;
  /** "long" | "short" | null when the venue side is unusable. */
  side: "long" | "short" | null;
  /** Base-unit size (abs). */
  size: number | null;
  /** USD notional (null when unmeasurable — never 0-filled). */
  notionalUsd: number | null;
  /** Armed exit legs. null = the venue never reported legs for this row. */
  exits: WatchdogExitLeg[] | null;
  /** The exits read FAILED — protection is unproven, not absent. */
  exitsUnknown: boolean;
  /** A local scalp/grid/trail state owns this pair → machine-owned. */
  machineOwned: boolean;
};

/** One working order (venue truth). */
export type WatchdogOrder = {
  orderId: string;
  pair: string;
  /** Client order id, when the venue reports one. */
  clientOid: string | null;
  /** Machine-owned (claimed by a local state id or the machine's oid tag). */
  machineOwned: boolean;
  /** Spot or futures (the cancel path needs the category). */
  market: "spot" | "futures";
  /** Why it was (not) claimed — carried into the cancel reason string. */
  ownershipReason: string;
};

/** Live account snapshot (what the watchdog sees, not what it computes). */
export type WatchdogAccountSnapshot = {
  /** Free margin, USD (null = unknown — never 0-filled). */
  freeMarginUsd: number | null;
  /** Total equity, USD (null = unknown). */
  totalEquityUsd: number | null;
  positions: WatchdogPosition[];
  orders: WatchdogOrder[];
  /** Consecutive failed venue reads. */
  consecutiveVenueErrors: number;
  /** Worst |funding rate| across open positions, percent per settlement. */
  fundingRatePct: number | null;
};

/** Liveness of one component (executor, or the watchdog itself). */
export type WatchdogHeartbeat = {
  /** Epoch ms of the last beat (null = never beat / unreadable). */
  atMs: number | null;
  /** Where it came from — carried into the reason string. */
  source: string;
};

/** What this machine owns (local scalp/grid/trail state claims). */
export type WatchdogOwnership = {
  /** Order ids claimed by a local state file. */
  ownedOrderIds: string[];
  /** Pairs claimed by a local state file (positions on these are ours). */
  ownedPairs: string[];
  /** clientOid prefixes tagged as ours (session + turn id convention). */
  ownedClientOidPrefixes: string[];
};

/** Standing policy (the armed policy, not the per-invocation opts). */
export type WatchdogPolicy = {
  /** Free-margin floor, USD. */
  minFreeUsd: number;
  /** Aggregate open-notional cap, USD (null = uncapped). */
  maxOpenNotionalUsd: number | null;
  /** Consecutive venue errors that trip. */
  maxConsecutiveVenueErrors: number;
  /** Executor dead-man limit, ms. */
  executorStaleMs: number;
  /** Watchdog self dead-man limit, ms. */
  watchdogStaleMs: number;
  /** |funding| blowout bound, percent per settlement. */
  fundingBlowoutPct: number;
  /** Standing flatten arm — DEFAULT FALSE. Flattening is separately armed. */
  flattenArmed: boolean;
  /** clientOid prefixes owned by this machine. */
  ownedClientOidPrefixes: string[];
};
export const defaultWatchdogPolicy = (over: Partial<WatchdogPolicy> = {}): WatchdogPolicy => ({
  minFreeUsd: WATCHDOG_DEFAULT_MIN_FREE_USD,
  maxOpenNotionalUsd: WATCHDOG_DEFAULT_MAX_OPEN_NOTIONAL_USD,
  maxConsecutiveVenueErrors: WATCHDOG_DEFAULT_MAX_VENUE_ERRORS,
  executorStaleMs: WATCHDOG_DEFAULT_EXECUTOR_STALE_MS,
  watchdogStaleMs: WATCHDOG_DEFAULT_SELF_STALE_MS,
  fundingBlowoutPct: WATCHDOG_DEFAULT_FUNDING_BLOWOUT_PCT,
  flattenArmed: false,
  ownedClientOidPrefixes: [],
  ...over,
});

/** Every trip condition the watchdog knows. */
export type WatchdogTripCode =
  | "watchdog_heartbeat_stale"
  | "kill_switch"
  | "server_breaker_tripped"
  | "risk_state_unreadable"
  | "daily_loss_cap"
  | "daily_trade_cap"
  | "free_margin_floor"
  | "executor_heartbeat_stale"
  | "venue_error_streak"
  | "position_without_exit"
  | "funding_blowout"
  | "open_notional_cap";

/** One tripped condition, with its reason string. */
export type WatchdogTrip = {
  code: WatchdogTripCode;
  /** Human reason — the string an operator reads in the alert. */
  reason: string;
  /** The numbers behind the reason. */
  detail?: Record<string, unknown>;
};

/** The ordered action list the runner applies. */
export type WatchdogActionType =
  | "set_breaker"
  | "cancel_orders"
  | "block_entries"
  | "flatten"
  | "alert";

export type WatchdogAction = {
  type: WatchdogActionType;
  /** Why this action, in the operator's words. */
  reason: string;
  /** Action payload (cancel targets, flatten targets). */
  detail?: Record<string, unknown>;
};

/** The pure decision. */
export type WatchdogDecision = {
  /** A live trip condition is active right now. */
  tripped: boolean;
  /** Live trips, most severe first. */
  trips: WatchdogTrip[];
  /** The breaker was tripped before and has not been human-resumed. */
  latched: boolean;
  /**
   * Server write gate: "open" = the venue write paths will accept a call,
   * "blocked" = the server's own kill-switch/YOLO gate will REFUSE
   * cancel_order and close_position (the mcp-server write gate requires
   * kill switch off + autonomy != propose_only). The watchdog still
   * ATTEMPTS the unwind — the gate can be lifted mid-incident — but it
   * reports the refusal honestly instead of claiming a cancel it did not
   * get.
   */
  serverWriteGate: "open" | "blocked";
  /** Ordered actions. Empty when nothing tripped and nothing is latched. */
  actions: WatchdogAction[];
  /** True when the runner must act (tripped or latched). */
  shouldAct: boolean;
  /** Informational notes — things we could not prove either way. */
  notes: string[];
};

/** Inputs to the pure decision. */
export type WatchdogDecisionInput = {
  riskState: WatchdogRiskState;
  account: WatchdogAccountSnapshot;
  executorHeartbeat: WatchdogHeartbeat;
  /** The watchdog's OWN heartbeat (its dead-man). */
  watchdogHeartbeat?: WatchdogHeartbeat | null;
  ownership?: WatchdogOwnership;
  policy: WatchdogPolicy;
  now: number;
  /** Per-invocation options (the flatten opt-in lives here, not in policy). */
  invocation?: { flatten?: boolean };
  /** Current breaker state (for the latch). */
  breaker?: WatchdogBreakerState | null;
  /**
   * Ignore the watchdog's OWN dead-man. Set only by the interactive resume
   * command: the human running `jw3 watchdog resume` IS the watchdog for
   * that invocation, and its heartbeat file may be stale because the
   * supervised daemon is down — which is exactly why a human is here. The
   * executor's dead-man still applies.
   */
  ignoreSelfHeartbeat?: boolean;
};

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

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Server risk limits → the watchdog's risk state. Reuses the repo's
 * `normalizeRiskLimits` for the kill/breaker/daily-loss/trade-count fields
 * (one vocabulary, no drift) and adds the notional pair.
 */
export function normalizeWatchdogRiskState(out: unknown, readError?: string | null): WatchdogRiskState {
  if (readError) {
    return {
      killSwitch: null,
      circuitBreakerTripped: null,
      dailyRealizedLossUsd: null,
      maxDailyLossUsd: null,
      dailyTradeCount: null,
      maxTradesPerDay: null,
      dailyNotionalUsd: null,
      maxDailyNotionalUsd: null,
      readable: false,
      transient: isTransientReadFailure(readError),
      readError,
    };
  }
  const base = normalizeRiskLimits(out);
  const o = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
  const inner =
    o.risk_limits && typeof o.risk_limits === "object" ? (o.risk_limits as Record<string, unknown>) : o;
  return {
    killSwitch: base.killSwitch,
    circuitBreakerTripped: base.breakerTripped,
    dailyRealizedLossUsd: base.dailyLoss,
    maxDailyLossUsd: base.maxDailyLoss,
    dailyTradeCount: base.tradesToday,
    maxTradesPerDay: base.maxTrades,
    dailyNotionalUsd: numOrNull(inner.daily_notional_usd ?? inner.dailyNotionalUsd),
    maxDailyNotionalUsd: numOrNull(inner.max_daily_notional_usd ?? inner.maxDailyNotionalUsd),
    readable: true,
    readError: null,
  };
}

/** Venue side → "long" | "short" | null. */
export function normalizeSide(raw: unknown): "long" | "short" | null {
  const s = String(raw ?? "").toLowerCase();
  if (s === "long" || s === "buy" || s === "b") return "long";
  if (s === "short" || s === "sell" || s === "s") return "short";
  return null;
}

/**
 * Order ownership. A working order is the MACHINE'S when a local
 * scalp/grid/trail state claims its id, or when its clientOid carries one
 * of the machine's own tags (clientOid = session + turn id). EVERYTHING
 * ELSE IS FOREIGN and is never cancelled by the watchdog — another lane's
 * or the operator's order must survive our panic.
 */
export function classifyOrderOwnership(
  orders: { orderId: string; pair?: string; clientOid?: string | null }[],
  ownership: WatchdogOwnership,
): WatchdogOrder[] {
  const owned = new Set(ownership.ownedOrderIds);
  const prefixes = ownership.ownedClientOidPrefixes ?? [];
  return orders.map((o) => {
    const clientOid = o.clientOid ?? null;
    let machineOwned = false;
    let ownershipReason: string;
    if (owned.has(o.orderId)) {
      machineOwned = true;
      ownershipReason = "claimed by a local state file";
    } else if (clientOid && prefixes.some((p) => p && clientOid.startsWith(p))) {
      machineOwned = true;
      ownershipReason = "clientOid carries the machine's tag";
    } else {
      machineOwned = false;
      ownershipReason = clientOid
        ? `clientOid ${clientOid} is not the machine's tag`
        : "no local state claims it and it carries no clientOid tag";
    }
    return {
      orderId: o.orderId,
      pair: o.pair ?? "",
      clientOid,
      machineOwned,
      market: "futures" as const,
      ownershipReason,
    };
  });
}

/** Venue rows → the watchdog's account snapshot (pure). */
export function accountSnapshotFromVenue(args: {
  positionsOut: unknown;
  balancesOut: unknown;
  ordersOut: unknown;
  ownership: WatchdogOwnership;
  consecutiveVenueErrors: number;
  fundingRatePct: number | null;
}): WatchdogAccountSnapshot {
  const account = accountFromBalances(args.balancesOut);
  const openRows = collectRows(args.positionsOut).filter((r) => isOpenPosition(r as Record<string, unknown>));
  const positions: WatchdogPosition[] = openRows.map((row) => {
    const r = row as Record<string, unknown>;
    const exitsRaw = r.exits;
    const exits = Array.isArray(exitsRaw)
      ? (exitsRaw as Record<string, unknown>[]).map((leg) => ({
          orderId: typeof leg.orderId === "string" ? leg.orderId : null,
          kind: typeof leg.kind === "string" ? leg.kind : null,
        }))
      : null;
    const size = numOrNull(r.size ?? r.qty ?? r.quantity ?? r.contracts ?? r.currentQty ?? r.positionAmt);
    return {
      pair: rowPairOf(r),
      side: normalizeSide(r.side),
      size: size === null ? null : Math.abs(size),
      notionalUsd: positionNotional(r),
      exits,
      exitsUnknown: r.exitsUnknown === true,
      machineOwned: args.ownership.ownedPairs.some((p) => rowMatchesPair(r, p)),
    };
  });
  const orders = classifyOrderOwnership(
    extractOpenOrders(args.ordersOut).map((r) => ({
      orderId: String(r.orderId ?? r.id ?? r.ordId ?? ""),
      pair: String(r.symbol ?? r.pair ?? ""),
      clientOid: typeof r.clientOid === "string" ? r.clientOid : null,
    })),
    args.ownership,
  );
  return {
    freeMarginUsd: account.unknown ? null : account.freeUsd,
    totalEquityUsd: account.unknown ? null : account.totalUsd,
    positions,
    orders,
    consecutiveVenueErrors: args.consecutiveVenueErrors,
    fundingRatePct: args.fundingRatePct,
  };
}

/** Age of a heartbeat in ms (null when there is no beat). */
export function heartbeatAgeMs(hb: WatchdogHeartbeat | null | undefined, now: number): number | null {
  if (!hb || hb.atMs === null || !Number.isFinite(hb.atMs)) return null;
  // A tiny negative age means clock skew, not a beat from the future —
  // clamp to 0 so a fresh beat never reads as stale (same rule as the
  // trail startup gate in reconcile.ts).
  const age = now - hb.atMs;
  return age < 0 ? 0 : age;
}

/* ------------------------------------------------------------------ */
/* the pure decision                                                   */
/* ------------------------------------------------------------------ */

function tripsFor(input: WatchdogDecisionInput): { trips: WatchdogTrip[]; notes: string[] } {
  const { riskState, account, policy } = input;
  const trips: WatchdogTrip[] = [];
  const notes: string[] = [];

  // 1. The watchdog's own dead-man. Our own silence outranks every market
  //    condition: if we were blind, nothing else can be trusted.
  const selfAge = heartbeatAgeMs(input.watchdogHeartbeat ?? null, input.now);
  if (selfAge !== null && selfAge > policy.watchdogStaleMs && input.ignoreSelfHeartbeat !== true) {
    trips.push({
      code: "watchdog_heartbeat_stale",
      reason: `watchdog heartbeat is ${Math.round(selfAge / 1000)}s stale (limit ${Math.round(
        policy.watchdogStaleMs / 1000,
      )}s) — the supervisor was blind; assuming the worst`,
      detail: { ageMs: selfAge, limitMs: policy.watchdogStaleMs },
    });
  }

  // 2. Server kill switch — the operator's own stop.
  if (riskState.killSwitch === true) {
    trips.push({
      code: "kill_switch",
      reason: "server kill switch is ON — the operator halted trading",
      detail: { source: "risk_limits.kill_switch_enabled" },
    });
  }

  // 3. Server circuit breaker.
  if (riskState.circuitBreakerTripped === true) {
    trips.push({
      code: "server_breaker_tripped",
      reason: "server circuit breaker is tripped — the server refuses new trades",
      detail: { source: "risk_limits.circuit_breaker_tripped_at" },
    });
  }

  // 4. Risk state unreadable — fail closed (the unreadable row may hold a
  //    kill switch we cannot see).
  //
  //    BUT a TRANSIENT failure is a different state: we were throttled,
  //    which says nothing about the switch. Treating a throttle as "the
  //    switch may be on" trips the breaker on a rate limit — and the
  //    breaker is human-only to clear, so a busy minute could stop the
  //    machine. A transient read is reported as a NOTE, not a trip.
  if (!riskState.readable) {
    if (riskState.transient === true) {
      notes.push(
        `server risk state unreadable (TRANSIENT — ${riskState.readError ?? "unknown error"}): the last known state is kept and no trip is raised`,
      );
    } else {
      trips.push({
        code: "risk_state_unreadable",
        reason: `server risk state is unreadable (${riskState.readError ?? "unknown error"}) — assuming the worst`,
        detail: { readError: riskState.readError ?? null },
      });
    }
  }

  // 5. Daily realized loss at/over the cap.
  if (
    riskState.maxDailyLossUsd !== null &&
    riskState.dailyRealizedLossUsd !== null &&
    riskState.dailyRealizedLossUsd >= riskState.maxDailyLossUsd
  ) {
    trips.push({
      code: "daily_loss_cap",
      reason: `daily realized loss ${usd(riskState.dailyRealizedLossUsd)} is at/over the ${usd(
        riskState.maxDailyLossUsd,
      )} cap`,
      detail: {
        dailyRealizedLossUsd: riskState.dailyRealizedLossUsd,
        maxDailyLossUsd: riskState.maxDailyLossUsd,
      },
    });
  }

  // 6. Daily trade count at/over the cap.
  if (
    riskState.maxTradesPerDay !== null &&
    riskState.dailyTradeCount !== null &&
    riskState.dailyTradeCount >= riskState.maxTradesPerDay
  ) {
    trips.push({
      code: "daily_trade_cap",
      reason: `daily trade count ${riskState.dailyTradeCount} is at/over the ${riskState.maxTradesPerDay} cap`,
      detail: {
        dailyTradeCount: riskState.dailyTradeCount,
        maxTradesPerDay: riskState.maxTradesPerDay,
      },
    });
  }

  // 7. Free margin below the floor.
  if (account.freeMarginUsd !== null && account.freeMarginUsd < policy.minFreeUsd) {
    trips.push({
      code: "free_margin_floor",
      reason: `free margin ${usd(account.freeMarginUsd)} is below the ${usd(policy.minFreeUsd)} floor — margin nearly exhausted`,
      detail: { freeMarginUsd: account.freeMarginUsd, minFreeUsd: policy.minFreeUsd },
    });
  } else if (account.freeMarginUsd === null) {
    notes.push("free margin is unknown (no quote-fund balance rows) — the margin floor is unverified");
  }

  // 8. Executor dead-man: no heartbeat beyond the limit = executor dead.
  const execAge = heartbeatAgeMs(input.executorHeartbeat, input.now);
  if (execAge === null) {
    if (input.executorHeartbeat?.atMs === null) {
      notes.push(
        `executor heartbeat unreadable (${input.executorHeartbeat.source}) — no beat recorded, dead-man not armed`,
      );
    }
  } else if (execAge > policy.executorStaleMs) {
    trips.push({
      code: "executor_heartbeat_stale",
      reason: `executor heartbeat is ${Math.round(execAge / 1000)}s stale (limit ${Math.round(
        policy.executorStaleMs / 1000,
      )}s) — dead-man switch: the executor is not running`,
      detail: { ageMs: execAge, limitMs: policy.executorStaleMs, source: input.executorHeartbeat.source },
    });
  }

  // 9. Consecutive venue errors.
  if (account.consecutiveVenueErrors >= policy.maxConsecutiveVenueErrors) {
    trips.push({
      code: "venue_error_streak",
      reason: `${account.consecutiveVenueErrors} consecutive venue errors (limit ${policy.maxConsecutiveVenueErrors}) — the venue path is not trustworthy`,
      detail: {
        consecutiveVenueErrors: account.consecutiveVenueErrors,
        limit: policy.maxConsecutiveVenueErrors,
      },
    });
  }

  // 10. A position with no armed exit.
  for (const p of account.positions) {
    if (p.exitsUnknown) {
      trips.push({
        code: "position_without_exit",
        reason: `${p.pair || "position"} ${p.side ?? ""} has UNKNOWN exit legs — protection is unproven`.replace(
          /\s+/g,
          " ",
        ),
        detail: { pair: p.pair, side: p.side, exitsUnknown: true },
      });
      continue;
    }
    if (p.exits !== null && p.exits.length === 0) {
      trips.push({
        code: "position_without_exit",
        reason: `${p.pair || "position"} ${p.side ?? ""} has no armed exit — an unprotected position`.replace(
          /\s+/g,
          " ",
        ),
        detail: { pair: p.pair, side: p.side },
      });
    } else if (p.exits === null) {
      notes.push(`${p.pair || "position"} reports no exit-leg evidence — protection unverified`);
    }
  }

  // 11. Funding blowout.
  if (
    account.fundingRatePct !== null &&
    Number.isFinite(account.fundingRatePct) &&
    Math.abs(account.fundingRatePct) >= policy.fundingBlowoutPct
  ) {
    trips.push({
      code: "funding_blowout",
      reason: `funding rate ${account.fundingRatePct.toFixed(4)}%/settlement is beyond the ±${policy.fundingBlowoutPct}% bound — the carry has blown out`,
      detail: { fundingRatePct: account.fundingRatePct, boundPct: policy.fundingBlowoutPct },
    });
  }

  // 12. Aggregate open notional over the cap.
  if (policy.maxOpenNotionalUsd !== null) {
    let total = 0;
    let unknown = 0;
    for (const p of account.positions) {
      if (p.notionalUsd === null) unknown += 1;
      else total += p.notionalUsd;
    }
    if (unknown === 0 && total > policy.maxOpenNotionalUsd) {
      trips.push({
        code: "open_notional_cap",
        reason: `aggregate open notional ${usd(total)} is over the ${usd(policy.maxOpenNotionalUsd)} cap`,
        detail: { openNotionalUsd: total, capUsd: policy.maxOpenNotionalUsd },
      });
    } else if (unknown > 0) {
      notes.push(`${unknown} position(s) have unmeasurable notional — the open-notional cap is unverified`);
    }
  }

  return { trips, notes };
}

/**
 * PURE. (riskState, account, executorHeartbeat, now) → ordered action list.
 * No I/O, no clock, no network — every trip path is unit-testable.
 */
export function decideWatchdog(input: WatchdogDecisionInput): WatchdogDecision {
  const { trips, notes } = tripsFor(input);
  const latched = input.breaker?.tripped === true;
  // The ownership set is resolved by the CALLER (it needs the venue's open
  // orders plus the local state files) and reaches the trip logic through
  // `tripsFor` — see `classifyOrderOwnership` / `classifyPositionOwnership`.
  // There is nothing to resolve here.
  const decision: WatchdogDecision = {
    tripped: trips.length > 0,
    trips,
    latched,
    // The server's own gate refuses venue writes while the kill switch is
    // ON (mcp-server writeGate → requireYoloEligible). The watchdog is not
    // fooled by that: it still attempts the unwind and reports the refusal.
    serverWriteGate: input.riskState.killSwitch === true ? "blocked" : "open",
    actions: [],
    shouldAct: trips.length > 0 || latched,
    notes,
  };
  if (!decision.shouldAct) return decision;

  const primary = trips[0];
  const primaryReason = primary ? primary.reason : "breaker latched — awaiting a human resume";
  const allReasons = trips.map((t) => t.reason);

  const ownedOrders = input.account.orders.filter((o) => o.machineOwned);
  const foreignOrders = input.account.orders.filter((o) => !o.machineOwned);

  // 1. Set the breaker FIRST — even if the process dies on the next line,
  //    entries stay blocked.
  decision.actions.push({
    type: "set_breaker",
    reason: primaryReason,
    detail: { trips: allReasons, latched },
  });

  // 2. Cancel the machine's OWN working orders. Foreign orders are never
  //    touched — another lane's order is not ours to kill.
  decision.actions.push({
    type: "cancel_orders",
    reason:
      ownedOrders.length > 0
        ? `cancelling ${ownedOrders.length} working order(s) this machine placed`
        : "no working order of this machine's to cancel",
    detail: {
      targets: ownedOrders.map((o) => ({ orderId: o.orderId, pair: o.pair, market: o.market, ownershipReason: o.ownershipReason, clientOid: o.clientOid })),
      foreignKept: foreignOrders.map((o) => ({ orderId: o.orderId, pair: o.pair })),
    },
  });

  // 3. Block new entries.
  decision.actions.push({
    type: "block_entries",
    reason: primaryReason,
    detail: { blockReason: primaryReason },
  });

  // 4. Flatten — ONLY when the policy is armed AND this invocation opted in.
  const flattenArmed = input.policy.flattenArmed === true;
  const flattenRequested = input.invocation?.flatten === true;
  const ownedPositions = input.account.positions.filter((p) => p.machineOwned);
  // Ownership proof for the diary: a machine-owned position is claimed by a
  // local state file on its pair (the only way positions become ours).
  const positionProof = (pair: string): string =>
    input.ownership?.ownedPairs.some((claimed) => claimed.toUpperCase() === pair.toUpperCase())
      ? `pair ${pair} claimed by a local state file`
      : "machine-owned position on a claimed pair";
  if (flattenArmed && flattenRequested && ownedPositions.length > 0) {
    decision.actions.push({
      type: "flatten",
      reason: `flattening ${ownedPositions.length} machine-owned position(s) with a reduce-only close`,
      detail: {
        mode: "reduce_only_close",
        tool: "close_position",
        positions: ownedPositions.map((p) => ({
          pair: p.pair,
          side: p.side,
          size: p.size,
          notionalUsd: p.notionalUsd,
          ownershipProof: positionProof(p.pair),
        })),
      },
    });
  } else if (flattenArmed && flattenRequested && ownedPositions.length === 0) {
    // Armed and asked, but nothing of ours is open — nothing to close.
    decision.actions.push({
      type: "flatten",
      reason: "flatten armed but no machine-owned position is open — nothing to close",
      detail: { mode: "reduce_only_close", tool: "close_position", positions: [] },
    });
  }

  // 5. Alert — last, so it can carry the outcome of everything above.
  decision.actions.push({
    type: "alert",
    reason: primaryReason,
    detail: { trips: allReasons, latched },
  });

  return decision;
}

/* ------------------------------------------------------------------ */
/* resume — human only                                                  */
/* ------------------------------------------------------------------ */

export type WatchdogResumeVerdict = {
  /** True when the resume may proceed. */
  ok: boolean;
  /** True when the resume actually clears the breaker. */
  changed: boolean;
  /** Operator-facing explanation. */
  reason: string;
  /** Live trips that blocked the resume. */
  liveTrips: WatchdogTrip[];
};

/**
 * PURE. A resume is allowed ONLY when a human asked for it AND the trip
 * condition has cleared. There is no automatic variant of this function and
 * no other caller of `applyResume` — the test file guards the source.
 */
export function evaluateResume(args: {
  breaker: WatchdogBreakerState;
  decision: WatchdogDecision;
  actor: string;
}): WatchdogResumeVerdict {
  const actor = String(args.actor ?? "").trim();
  if (!actor) {
    return {
      ok: false,
      changed: false,
      reason: "resume requires an explicit human actor — refusing to clear the breaker",
      liveTrips: args.decision.trips,
    };
  }
  if (!args.breaker.tripped) {
    return { ok: true, changed: false, reason: "breaker was not tripped — nothing cleared", liveTrips: [] };
  }
  if (args.decision.tripped) {
    const first = args.decision.trips[0];
    return {
      ok: false,
      changed: false,
      reason: `trip condition has NOT cleared: ${first?.reason ?? "unknown"} — refusing to resume`,
      liveTrips: args.decision.trips,
    };
  }
  return {
    ok: true,
    changed: true,
    reason: `trip condition cleared — resuming on the human request of ${actor}`,
    liveTrips: [],
  };
}

/**
 * The ONLY place in this file that clears the breaker. Reached only from
 * the explicit resume command, and only after `evaluateResume` said yes.
 */
export function applyResume(
  state: WatchdogState,
  verdict: WatchdogResumeVerdict,
  actor: string,
  now: number,
): WatchdogState {
  if (!verdict.ok || !verdict.changed) return state;
  return {
    ...state,
    breaker: {
      ...state.breaker,
      tripped: false,
      trippedAt: null,
      reasons: [],
      clearedAt: new Date(now).toISOString(),
      clearedBy: String(actor ?? "").trim() || "human",
    },
    entriesBlocked: false,
    blockReason: null,
  };
}

/* ------------------------------------------------------------------ */
/* state + heartbeat files                                             */
/* ------------------------------------------------------------------ */

export function watchdogStatePath(dir?: string): string {
  return join(dir ?? configDir(), "watchdog-state.json");
}

export function watchdogHeartbeatPath(dir?: string): string {
  return join(dir ?? configDir(), "watchdog-heartbeat.json");
}

/** Default executor heartbeat source — the supervisor's heartbeat file. */
export function executorHeartbeatPath(dir?: string): string {
  return join(dir ?? configDir(), "supervise-heartbeat.json");
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

/** Parse a heartbeat payload (ISO `at`, or epoch ms fields). */
export function parseHeartbeat(raw: unknown, source: string): WatchdogHeartbeat {
  if (!raw || typeof raw !== "object") return { atMs: null, source };
  const o = raw as Record<string, unknown>;
  const ms = numOrNull(o.atMs ?? o.lastHeartbeatMs ?? o.updatedAtMs ?? o.lastHeartbeatAtMs);
  if (ms !== null) return { atMs: ms, source };
  const iso = o.at ?? o.updatedAt ?? o.lastHeartbeatAt;
  if (typeof iso === "string") {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return { atMs: t, source };
  }
  return { atMs: null, source };
}

/** Read a heartbeat file (missing/unreadable = no beat). */
export function readHeartbeatFile(path: string, source: string): WatchdogHeartbeat {
  try {
    return parseHeartbeat(JSON.parse(readFileSync(path, "utf8")) as unknown, source);
  } catch {
    return { atMs: null, source };
  }
}

export function writeHeartbeatFile(path: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/* ------------------------------------------------------------------ */
/* diary: append-only record of every automatic unwind                */
/* ------------------------------------------------------------------ */

/**
 * The watchdog's diary: one JSON line per automatic cancel/close, appended
 * (never overwritten). Each line carries the trip codes that caused the
 * unwind plus the ownership proof that made the order/position ours to
 * touch, so a later audit can answer why the watchdog killed this order
 * and how it knew the order was the machine's, without trusting memory.
 */
export function watchdogDiaryPath(dir?: string): string {
  return join(dir ?? configDir(), "watchdog-diary.jsonl");
}

export type WatchdogDiaryEntry = {
  /** ISO timestamp of the unwind attempt. */
  at: string;
  /** What the watchdog did on its own. */
  action: "auto-cancel" | "auto-close";
  /** Exchange the call went to. */
  exchange: string;
  pair: string;
  /** Cancel target (auto-cancel only). */
  orderId?: string;
  /** Close target side/size (auto-close only). */
  side?: string | null;
  size?: number | null;
  /** Trip codes live when the unwind ran. */
  tripCodes: WatchdogTripCode[];
  /** Why this order/position was ours to touch. */
  ownershipProof: {
    reason: string;
    clientOid?: string | null;
  };
  result: "ok" | "failed";
  /** Venue refusal, when the attempt failed. */
  error?: string;
};

/**
 * Pure: one diary line for an automatic cancel/close attempt. Logged for
 * EVERY attempt, ok or failed: a failed unwind is the line that matters
 * most.
 */
export function makeWatchdogDiaryEntry(o: {
  at: string;
  action: "auto-cancel" | "auto-close";
  exchange: string;
  pair: string;
  orderId?: string;
  side?: string | null;
  size?: number | null;
  tripCodes: WatchdogTripCode[];
  ownershipReason: string;
  clientOid?: string | null;
  result: "ok" | "failed";
  error?: string;
}): WatchdogDiaryEntry {
  return {
    at: o.at,
    action: o.action,
    exchange: o.exchange,
    pair: o.pair,
    ...(o.orderId !== undefined ? { orderId: o.orderId } : {}),
    ...(o.side !== undefined ? { side: o.side } : {}),
    ...(o.size !== undefined ? { size: o.size } : {}),
    tripCodes: [...o.tripCodes],
    ownershipProof: {
      reason: o.ownershipReason,
      ...(o.clientOid !== undefined ? { clientOid: o.clientOid } : {}),
    },
    result: o.result,
    ...(o.error !== undefined ? { error: o.error } : {}),
  };
}

/**
 * Append one line to the diary. Returns null on success, the error message
 * when the append failed (the caller surfaces it; the unwind itself is
 * never retried or rolled back for a logging failure).
 */
export function appendWatchdogDiary(path: string, entry: WatchdogDiaryEntry): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: "a", mode: 0o600 });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Local state files (scalp/grid/trail) → what this machine owns. */
const STATE_FILE_RE = /^(?:scalp|grid|trail)_([a-z0-9]+)\.json$/i;

export function scanStateBases(dir?: string): string[] {
  const d = dir ?? tmpdir();
  try {
    const out = new Set<string>();
    for (const f of readdirSync(d)) {
      const m = STATE_FILE_RE.exec(f);
      if (m?.[1]) out.add(m[1].toUpperCase());
    }
    return [...out].sort();
  } catch {
    return [];
  }
}

export function collectOwnership(bases: string[], dir?: string): WatchdogOwnership {
  const ownedOrderIds = new Set<string>();
  const ownedPairs = new Set<string>();
  for (const b of bases) {
    const { states } = readLocalStates(b, dir);
    for (const s of states) {
      for (const id of s.orderIds) ownedOrderIds.add(id);
      if (s.pair) ownedPairs.add(s.pair);
    }
  }
  return { ownedOrderIds: [...ownedOrderIds], ownedPairs: [...ownedPairs], ownedClientOidPrefixes: [] };
}

/* ------------------------------------------------------------------ */
/* funding (public, keyless — never a gate on the money path)          */
/* ------------------------------------------------------------------ */

/** KuCoin futures funding rate, percent per settlement (null = unknown). */
export async function readKucoinFundingPct(base: string): Promise<number | null> {
  const b = base.toUpperCase() === "BTC" ? "XBT" : base.toUpperCase();
  try {
    const sym = `${b}USDTM`;
    const out = (await fetchJson(
      `https://api-futures.kucoin.com/api/v1/funding-rate/${encodeURIComponent(sym)}/current`,
      {},
      { timeoutMs: 10_000, attempts: 2 },
    )) as { data?: { value?: string } };
    const v = Number(out?.data?.value);
    return Number.isFinite(v) ? v * 100 : null;
  } catch {
    return null;
  }
}

function baseOfPair(pair: string): string {
  return (pair.split("/")[0] ?? "").toUpperCase();
}

/* ------------------------------------------------------------------ */
/* the impure cycle                                                    */
/* ------------------------------------------------------------------ */

export type WatchdogAlert = (message: string, meta: Record<string, unknown>) => void | Promise<void>;

export type WatchdogDeps = {
  /** MCP call (injected in tests). */
  call?: TradeCall;
  /** Connection list (injected in tests). */
  listConns?: typeof listConnections;
  /** Local state dir (scalp/grid/trail state files). */
  stateDir?: string;
  /** Config dir (state + heartbeat files). */
  cfgDir?: string;
  /** Diary file (defaults to the config dir; injected in tests). */
  diaryPath?: string;
  /** Executor heartbeat file (the dead-man source). */
  executorHeartbeatFile?: string;
  /** Alert sink (Telegram paging in production). */
  alert?: WatchdogAlert;
  /** Clock. */
  now?: () => number;
  /** Funding reader (injected in tests). */
  funding?: (base: string) => Promise<number | null>;
};
export type WatchdogEvaluation = {
  decision: WatchdogDecision;
  state: WatchdogState;
  account: WatchdogAccountSnapshot;
  riskState: WatchdogRiskState;
  ownership: WatchdogOwnership;
  executorHeartbeat: WatchdogHeartbeat;
  errors: string[];
};

export type WatchdogCycleResult = {
  decision: WatchdogDecision;
  state: WatchdogState;
  executed: { type: WatchdogActionType; ok: boolean; detail?: Record<string, unknown> }[];
  errors: string[];
  readOnly: boolean;
};

/**
 * Read the world (server risk state + live account + heartbeats) and decide.
 * No venue writes happen here — only reads. The runner applies the actions.
 */
export async function evaluateWatchdog(
  opts: {
    exchange?: string;
    url?: string;
    pat?: string;
    flatten?: boolean;
    ignoreSelfHeartbeat?: boolean;
    /** Which sub-command this is. A one-shot `check` ignores its own heartbeat. */
    sub?: string;
  },
  deps?: WatchdogDeps,
): Promise<WatchdogEvaluation> {
  const call = deps?.call ?? callTool;
  const listConns = deps?.listConns ?? listConnections;
  const now = deps?.now?.() ?? Date.now();
  const cfgDir = deps?.cfgDir ?? configDir();
  const statePath = watchdogStatePath(cfgDir);
  const state = loadWatchdogState(statePath);
  const errors: string[] = [];

  // Server risk state.
  let riskState: WatchdogRiskState;
  try {
    riskState = normalizeWatchdogRiskState(await call("read_risk_limits", {}, opts.pat ?? "", opts.url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`risk limits unreadable: ${msg}`);
    riskState = normalizeWatchdogRiskState(null, msg);
  }

  // Ownership (what this machine owns) — read BEFORE the venue reads so the
  // order classification can use it. The clientOid tags come from the
  // persisted state (the session + turn id convention); the local state
  // files claim order ids and pairs.
  const ownership = collectOwnership(scanStateBases(deps?.stateDir), deps?.stateDir);
  ownership.ownedClientOidPrefixes = state.ownedClientOidPrefixes ?? [];

  // Venue reads.
  let account: WatchdogAccountSnapshot = {
    freeMarginUsd: null,
    totalEquityUsd: null,
    positions: [],
    orders: [],
    consecutiveVenueErrors: state.consecutiveVenueErrors,
    fundingRatePct: null,
  };
  let conn: { id: string; exchange: string } | null = null;
  try {
    const rows = await listConns(opts.pat ?? "", opts.url);
    conn = pickConnection(rows, opts.exchange, true);
    if (!conn) {
      errors.push(
        opts.exchange
          ? `no ${opts.exchange} connection — connect it in-app first`
          : "no CEX connections — connect one in-app first",
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A throttled connection list is not a missing connection, and it is
    // not evidence the venue path is broken. It is the same transient
    // condition as above.
    if (isTransientReadFailure(msg)) {
      errors.push(`connection list failed (TRANSIENT): ${msg}`);
    } else {
      errors.push(`connection list failed: ${msg}`);
    }
  }

  let venueOk = false;
  // A TRANSIENT venue failure is not evidence that the venue path is
  // untrustworthy. A rate limit, a timeout or a 5xx means "try again",
  // and it is exactly what happens when a scanner and the watchdog
  // share one per-minute budget — the watchdog's own read gets
  // starved by the thing it is supposed to be watching over.
  //
  // Counting a throttle toward "3 consecutive venue errors" latched
  // the breaker for a THROTTLE, and the breaker is human-only to
  // clear. A transient failure must not be able to stop the machine.
  let venueErrorTransient = false;
  if (conn) {
    try {
      const [positionsOut, balancesOut, ordersOut] = await Promise.all([
        call("read_live_datum", { kind: "positions", connectionId: conn.id, withExits: true }, opts.pat ?? "", opts.url),
        call("read_live_datum", { kind: "balances", connectionId: conn.id }, opts.pat ?? "", opts.url),
        call("list_open_orders", { exchange: conn.exchange }, opts.pat ?? "", opts.url),
      ]);
      account = accountSnapshotFromVenue({
        positionsOut,
        balancesOut,
        ordersOut,
        ownership,
        consecutiveVenueErrors: state.consecutiveVenueErrors,
        fundingRatePct: null,
      });
      venueOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      venueErrorTransient = isTransientReadFailure(msg);
      errors.push(
        venueErrorTransient
          ? `venue read failed (TRANSIENT — not counted against the venue-error streak): ${msg}`
          : `venue read failed: ${msg}`,
      );
    }
  }

  // Funding — worst |rate| across the machine's open positions (bounded).
  const bases = [...new Set(account.positions.map((p) => baseOfPair(p.pair)).filter(Boolean))].slice(0, 5);
  if (bases.length > 0) {
    const funding = deps?.funding ?? readKucoinFundingPct;
    const rates: number[] = [];
    for (const b of bases) {
      const r = await funding(b);
      if (r !== null && Number.isFinite(r)) rates.push(Math.abs(r));
    }
    account.fundingRatePct = rates.length > 0 ? Math.max(...rates) : null;
  }

  // The error streak is a live counter: a successful venue read resets it,
  // a GENUINE failure advances it.
  //
  // A TRANSIENT failure (a throttle, a timeout, a 5xx) does NOT advance
  // it. The streak measures "the venue path is broken", and a throttle
  // says the opposite: the venue path is fine, we are being rate
  // limited. Counting it latched the breaker — and the breaker is
  // human-only to clear, so a throttle could stop the machine entirely.
  const consecutiveVenueErrors =
    venueOk || venueErrorTransient ? 0 : state.consecutiveVenueErrors + 1;
  account.consecutiveVenueErrors = consecutiveVenueErrors;

  const executorHeartbeat = readHeartbeatFile(
    deps?.executorHeartbeatFile ?? executorHeartbeatPath(cfgDir),
    "executor",
  );
  const ownHeartbeat = readHeartbeatFile(watchdogHeartbeatPath(cfgDir), "watchdog");

  // The dead-man must judge the PREVIOUS run's silence, not this run's
  // age. A one-shot watchdog is RESPAWNED by its supervisor on a cadence;
  // at the moment it starts, its heartbeat file is by definition from the
  // last run, so judging that file's age trips on the supervisor's own
  // restart schedule. The breaker then latches awaiting a human resume —
  // for a condition the machine caused itself.
  //
  // So: a one-shot run (`check`, and the `run` command's first cycle)
  // ignores its own heartbeat — it is alive by definition, it is running.
  // The DEAD-MAN switch is the supervisor's job: the daemon holds the
  // heartbeat that proves a watchdog is being restarted. A long-running
  // watchdog keeps the check, because there the silence really is a
  // fault.
  const ignoreSelf = opts.ignoreSelfHeartbeat === true || opts.sub === "check";

  const policy = defaultWatchdogPolicy({
    flattenArmed: state.policy.flattenArmed,
    ownedClientOidPrefixes: ownership.ownedClientOidPrefixes,
  });

  const decision = decideWatchdog({
    riskState,
    account,
    executorHeartbeat,
    watchdogHeartbeat: ownHeartbeat,
    ownership,
    policy,
    now,
    invocation: { flatten: opts.flatten === true },
    breaker: state.breaker,
    ignoreSelfHeartbeat: ignoreSelf,
  });

  return {
    decision,
    state: { ...state, consecutiveVenueErrors },
    account,
    riskState,
    ownership,
    executorHeartbeat,
    errors,
  };
}

function tripBreaker(state: WatchdogState, trips: WatchdogTrip[], now: number): WatchdogState {
  const reasons = [...new Set([...state.breaker.reasons, ...trips.map((t) => t.reason)])];
  if (state.breaker.tripped) {
    return { ...state, breaker: { ...state.breaker, reasons } };
  }
  return {
    ...state,
    breaker: {
      tripped: true,
      trippedAt: new Date(now).toISOString(),
      reasons,
      clearedAt: null,
      clearedBy: null,
    },
  };
}

/**
 * One watchdog cycle: read → decide → act → heartbeat.
 *
 * The actions run in the fixed order (set breaker → cancel own orders →
 * block entries → flatten → alert). The heartbeat is written LAST, so a
 * cycle that dies mid-way leaves a stale beat and the next run trips its own
 * dead-man instead of silently continuing.
 */
export async function runWatchdogCycle(
  opts: { exchange?: string; url?: string; pat?: string; flatten?: boolean },
  deps?: WatchdogDeps,
): Promise<WatchdogCycleResult> {
  const call = deps?.call ?? callTool;
  const now = deps?.now?.() ?? Date.now();
  const cfgDir = deps?.cfgDir ?? configDir();
  const statePath = watchdogStatePath(cfgDir);
  const hbPath = watchdogHeartbeatPath(cfgDir);
  const evalResult = await evaluateWatchdog(opts, deps);
  const { decision } = evalResult;
  let state = evalResult.state;
  const executed: WatchdogCycleResult["executed"] = [];
  // diary: every automatic cancel/close is appended with the live trip
  // codes and the ownership proof, for later audit. Append-only, best
  // effort: a logging failure is surfaced, never acted on.
  const diaryPath = deps?.diaryPath ?? watchdogDiaryPath(cfgDir);
  const diaryAt = new Date(now).toISOString();
  const tripCodes = decision.trips.map((t) => t.code);
  const diaryFail = (err: string | null): void => {
    if (err) evalResult.errors.push(`watchdog diary append failed: ${err}`);
  };

  if (decision.shouldAct) {
    for (const action of decision.actions) {
      if (action.type === "set_breaker") {
        state = tripBreaker(state, decision.trips, now);
        saveWatchdogState(statePath, state);
        executed.push({ type: "set_breaker", ok: true, detail: { reasons: state.breaker.reasons } });
        continue;
      }
      if (action.type === "cancel_orders") {
        const targets = (action.detail?.targets ?? []) as {
          orderId: string; pair: string; market: string;
          ownershipReason?: string; clientOid?: string | null;
        }[];
        const ok: string[] = [];
        const failed: { orderId: string; error: string }[] = [];
        for (const t of targets) {
          try {
            await call(
              "cancel_order",
              { exchange: opts.exchange ?? "", orderId: t.orderId, pair: t.pair, market: t.market },
              opts.pat ?? "",
              opts.url,
            );
            ok.push(t.orderId);
          } catch (e) {
            failed.push({ orderId: t.orderId, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const failedById = new Map(failed.map((f) => [f.orderId, f.error]));
        for (const t of targets) {
          const error = failedById.get(t.orderId);
          diaryFail(appendWatchdogDiary(diaryPath, makeWatchdogDiaryEntry({
            at: diaryAt,
            action: "auto-cancel",
            exchange: opts.exchange ?? "",
            pair: t.pair,
            orderId: t.orderId,
            tripCodes,
            ownershipReason: t.ownershipReason ?? "machine-owned working order",
            ...(t.clientOid !== undefined ? { clientOid: t.clientOid } : {}),
            result: error === undefined ? "ok" : "failed",
            ...(error !== undefined ? { error } : {}),
          })));
        }
        const detail: Record<string, unknown> = { cancelled: ok, failed };
        if (decision.serverWriteGate === "blocked" && failed.length > 0) {
          // The server's kill-switch gate refused the cancel. Say so — a
          // "cancelled" claim would be a lie, and a silent failure would
          // leave the operator thinking the book is clean.
          detail.serverWriteGateBlocked = true;
          detail.note =
            "the server's kill-switch gate refused the cancel — the orders are still working; a human must lift the server kill switch or cancel them directly";
        }
        executed.push({ type: "cancel_orders", ok: failed.length === 0, detail });
        continue;
      }
      if (action.type === "block_entries") {
        state = {
          ...state,
          entriesBlocked: true,
          blockReason: action.reason,
        };
        saveWatchdogState(statePath, state);
        executed.push({ type: "block_entries", ok: true, detail: { blockReason: state.blockReason } });
        continue;
      }
      if (action.type === "flatten") {
        const positions = (action.detail?.positions ?? []) as {
          pair: string;
          side: string | null;
          size: number | null;
          ownershipProof?: string;
        }[];
        const closed: string[] = [];
        const failed: { pair: string; error: string }[] = [];
        for (const p of positions) {
          if (!p.pair || !p.side) {
            failed.push({ pair: p.pair ?? "", error: "position side is unusable — refusing to guess a close direction" });
            continue;
          }
          try {
            // Reduce-only close. The watchdog NEVER sends an opposing order.
            await call(
              "close_position",
              {
                exchange: opts.exchange ?? "",
                pair: p.pair,
                side: p.side,
                ...(p.size !== null && p.size > 0 ? { size: String(p.size) } : {}),
              },
              opts.pat ?? "",
              opts.url,
            );
            closed.push(p.pair);
          } catch (e) {
            failed.push({ pair: p.pair, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const failedByPair = new Map(failed.map((f) => [f.pair, f.error]));
        for (const p of positions) {
          const error = failedByPair.get(p.pair ?? "");
          diaryFail(appendWatchdogDiary(diaryPath, makeWatchdogDiaryEntry({
            at: diaryAt,
            action: "auto-close",
            exchange: opts.exchange ?? "",
            pair: p.pair ?? "",
            side: p.side,
            size: p.size,
            tripCodes,
            ownershipReason: p.ownershipProof ?? "machine-owned position",
            result: error === undefined ? "ok" : "failed",
            ...(error !== undefined ? { error } : {}),
          })));
        }
        executed.push({ type: "flatten", ok: failed.length === 0, detail: { closed, failed } });
        continue;
      }
      if (action.type === "alert") {
        // The headline must match the state. A LATCHED breaker with no
        // new trip condition is not "TRIPPED" — calling it tripped
        // contradicts the very next line that reports the trip list as
        // empty, and an operator reading both cannot tell what happened.
        const headline = decision.trips.length > 0 ? "WATCHDOG TRIPPED" : "WATCHDOG LATCHED";
        const detail =
          decision.trips.map((t) => t.reason).join("; ") ||
          "breaker latched — awaiting a human resume (no new trip condition)";
        const message = `${headline} — ${detail}`;
        try {
          if (deps?.alert) await deps.alert(message, { trips: decision.trips, actions: decision.actions });
          else console.error(message);
        } catch {
          // An alert sink that fails never stops the breaker.
        }
        executed.push({ type: "alert", ok: true });
      }
    }
  }

  state = {
    ...state,
    lastDecisionAt: new Date(now).toISOString(),
    lastTrips: decision.trips,
  };
  saveWatchdogState(statePath, state);
  writeHeartbeatFile(hbPath, {
    at: new Date(now).toISOString(),
    atMs: now,
    pid: process.pid,
    breakerTripped: state.breaker.tripped,
    entriesBlocked: state.entriesBlocked,
    trips: decision.trips.map((t) => t.code),
  });

  return { decision, state, executed, errors: evalResult.errors, readOnly: false };
}

/* ------------------------------------------------------------------ */
/* CLI surface (the parent wires this into index.ts)                   */
/* ------------------------------------------------------------------ */

export type WatchdogCmdOptions = {
  sub?: string;
  exchange?: string;
  pollSec?: number;
  flatten?: boolean;
  /** Human actor for the resume command — REQUIRED for a resume. */
  actor?: string;
  json?: boolean;
  url?: string;
  pat?: string;
  once?: boolean;
};

function printDecision(decision: WatchdogDecision, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(decision));
    return;
  }
  if (!decision.shouldAct) {
    console.log("WATCHDOG — no trip condition active; breaker clear.");
    for (const n of decision.notes) console.log(`  note: ${n}`);
    return;
  }
  console.log("WATCHDOG — TRIPPED");
  for (const t of decision.trips) console.log(`  [${t.code}] ${t.reason}`);
  if (decision.latched && decision.trips.length === 0) console.log("  [latched] breaker is latched — a human must resume");
  for (const a of decision.actions) console.log(`  action: ${a.type} — ${a.reason}`);
  for (const n of decision.notes) console.log(`  note: ${n}`);
}

/** `jw3 watchdog check` — read-only evaluation, no writes, no venue calls. */
export async function cmdWatchdogCheck(opts: WatchdogCmdOptions, deps?: WatchdogDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const result = await evaluateWatchdog({ exchange: opts.exchange, url: opts.url, pat, sub: "check" }, deps);
  printDecision(result.decision, opts.json === true);
  for (const e of result.errors) console.error(`  error: ${e}`);
  if (result.decision.shouldAct) process.exitCode = 1;
}

/** `jw3 watchdog run` — the supervision loop (own process, own timer). */
export async function cmdWatchdogRun(opts: WatchdogCmdOptions, deps?: WatchdogDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const pollSec = Math.max(5, opts.pollSec ?? WATCHDOG_DEFAULT_POLL_SEC);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let first = true;
  while (true) {
    const result = await runWatchdogCycle(
      { exchange: opts.exchange, url: opts.url, pat, flatten: opts.flatten === true },
      deps,
    );
    if (opts.json !== true) {
      console.log(
        `${new Date().toISOString()} WATCHDOG ${
          result.decision.shouldAct ? "TRIPPED" : "clear"
        } — ${result.decision.trips.map((t) => t.reason).join("; ") || "no trip condition"}`,
      );
      for (const e of result.errors) console.error(`  error: ${e}`);
    } else {
      console.log(JSON.stringify(result));
    }
    if (opts.once === true) {
      if (result.decision.shouldAct) process.exitCode = 1;
      return;
    }
    if (first) {
      first = false;
      // The loop owns the state dir it was given.
    }
    await sleep(pollSec * 1000);
  }
}

/**
 * `jw3 watchdog resume` — HUMAN ONLY. Verifies the trip condition has
 * cleared, then clears the breaker. No automatic path reaches this.
 */
export async function cmdWatchdogResume(opts: WatchdogCmdOptions, deps?: WatchdogDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const actor = String(opts.actor ?? "").trim();
  if (!actor) {
    console.error(
      "Resume needs an explicit human actor: `jw3 watchdog resume --actor \"<name>\"` — the breaker is never cleared automatically.",
    );
    process.exitCode = 2;
    return;
  }
  const now = deps?.now?.() ?? Date.now();
  const cfgDir = deps?.cfgDir ?? configDir();
  const statePath = watchdogStatePath(cfgDir);
  const state = loadWatchdogState(statePath);
  if (!state.breaker.tripped) {
    console.log("WATCHDOG — breaker was not tripped; nothing cleared.");
    return;
  }
  // Re-evaluate the trip condition against CURRENT state before clearing.
  // `ignoreSelfHeartbeat` — the human running this command IS the watchdog
  // for this invocation; the supervised daemon's stale heartbeat is exactly
  // why a human is here. The executor's dead-man still applies.
  const current = await evaluateWatchdog(
    { exchange: opts.exchange, url: opts.url, pat, ignoreSelfHeartbeat: true },
    deps,
  );
  const verdict = evaluateResume({ breaker: current.state.breaker, decision: current.decision, actor });
  if (!verdict.ok) {
    console.error(`Resume REFUSED: ${verdict.reason}`);
    for (const t of verdict.liveTrips) console.error(`  [${t.code}] ${t.reason}`);
    process.exitCode = 1;
    return;
  }
  const next = applyResume(state, verdict, actor, now);
  saveWatchdogState(statePath, next);
  console.log(`WATCHDOG — resumed by ${actor}: ${verdict.reason}`);
  if (opts.json === true) console.log(JSON.stringify({ resumed: true, actor, reason: verdict.reason }));
}
