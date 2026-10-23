/**
 * `alert` — the trading machine's alerting component.
 *
 * Turns machine-state changes (the monitor's diff) into a short list of
 * actionable notifications. Quiet by default, loud only when it matters:
 * the same finding on consecutive polls does not re-alert, a finding that
 * persists escalates, a finding that clears produces an "all clear", and
 * several changes in one poll collapse into ONE message.
 *
 * Three layers, deliberately separated:
 *
 *  1. `diffMachineState(prev, next)` — pure: two machine snapshots → the
 *     changes between them (the monitor's diff).
 *  2. `evaluateAlerts(prevKeys, changes, now, opts)` — pure: changes + the
 *     retained policy state → the alerts to dispatch this poll. This is
 *     the ALERT POLICY; it has no I/O and no clock of its own.
 *  3. transports (`consoleTransport`, `fileTransport`) — pluggable
 *     `send(alert) => Promise<void>` channels. The policy never talks to
 *     a network; a transport does that.
 *
 * Safety: this module only READS. It places no orders, signs nothing,
 * and touches no venue. An alert recommends an action to a human; it
 * never takes one.
 *
 * ---------------------------------------------------------------------------
 * ALERT CATALOGUE (trigger → severity → message shape)
 * ---------------------------------------------------------------------------
 *
 *  trigger                          severity  tier        headline shape
 *  -------------------------------  --------  ----------  -----------------------------
 *  kill switch engaged              critical  critical    KILL SWITCH ENGAGED — trading halted
 *  circuit breaker tripped          critical  critical    CIRCUIT BREAKER TRIPPED — <reason>
 *  free margin below floor          critical  critical    FREE MARGIN BELOW FLOOR — $x vs $y
 *  daily loss limit reached         critical  critical    DAILY LOSS LIMIT REACHED — -$x of $y
 *  position opened, no exit armed   critical  critical    POSITION OPENED WITHOUT EXIT ARMED
 *  unknown-origin position          warning   warning     UNKNOWN-ORIGIN POSITION — <pair>
 *  stop hit                         warning   warning     STOP HIT — <pair> <side> @ px
 *  daemon restart                   warning   warning     DAEMON RESTARTED — pid N
 *  fill confirmed                   info      info        FILL CONFIRMED — <pair> @ px
 *  daily summary                    info      summary     DAILY SUMMARY — n trades, w/l, P&L, fees
 *  finding cleared (any condition)  info      resolution  ALL CLEAR — <subject>
 *
 *  Quiet by construction: a position that opens WITH its exit armed is
 *  not a finding (the fill confirmation already reports it), and nothing
 *  outside this table ever produces an alert.
 *
 * ---------------------------------------------------------------------------
 * DEDUP / COOLDOWN / ESCALATION / RATE-LIMIT RULES
 * ---------------------------------------------------------------------------
 *
 *  DEDUP (cooldown by finding key + window)
 *    Every finding has a stable key (`margin:free-below-floor`,
 *    `position:no-exit:SOL/USDT`, `fill:<venue fill id>`, …) and a
 *    fingerprint of its material numbers. A finding is suppressed when
 *    the previous poll reported the SAME key with the SAME fingerprint
 *    and less than `cooldownMs` has passed since it last fired.
 *      - same key, changed fingerprint (e.g. margin fell into a worse
 *        band) → NOT suppressed: the numbers changed, so it is news.
 *      - same key, same fingerprint, cooldown expired → fires again as a
 *        reminder with the current numbers.
 *    Default `cooldownMs` = 15 min. Configurable per deployment.
 *
 *  ESCALATION
 *    A condition reported on consecutive polls accumulates `occurrences`.
 *    Once it has been active for MORE than `escalateAfterPolls` polls
 *    (default 3), it escalates:
 *      - warning → critical (the same finding, louder).
 *      - already critical → an extra, separate `#escalated` alert
 *        ("still true after N polls — a human must act"), with its own
 *        longer `escalationCooldownMs` (default 30 min).
 *    Escalation bypasses the cooldown (it is new, louder information)
 *    but still respects the global rate limit unless it is critical.
 *
 *  RESOLUTION ("all clear")
 *    A condition that stops being true produces ONE resolution alert —
 *    "ALL CLEAR — <subject>" — so the human knows it was handled and
 *    does not go looking for a problem that is gone. The condition's key
 *    is dropped, so a fresh episode alerts again immediately.
 *
 *  GROUPING
 *    Findings are grouped by tier: all criticals in one poll become ONE
 *    critical message, all warnings one, all infos one. Resolutions and
 *    the daily summary each get their own message (a closure and a
 *    day-end summary must not hide inside routine noise). A group
 *    headline reads like "3× position opened without exit armed
 *    [SOL/USDT, ETH/USDT], 1× free margin below floor ($3.20 vs $50.00
 *    floor)" and the detail carries every number.
 *
 *  GLOBAL RATE LIMIT
 *    At most `maxAlertsPerWindow` messages per `rateWindowMs`
 *    (default 5 per 10 min). Routine alerts over the budget are NOT
 *    dropped — they queue and flush on later polls. CRITICAL alerts and
 *    ALL-CLEAR resolutions always dispatch immediately; a critical is
 *    never dropped, delayed or merged away.
 *
 * ---------------------------------------------------------------------------
 * ATTACHING A TELEGRAM / WEBHOOK TRANSPORT
 * ---------------------------------------------------------------------------
 *
 * The policy is transport-agnostic: it hands finished `Alert` objects to
 * an `AlertSender`. A Telegram transport is just another sender:
 *
 *   const telegram: AlertSender = async (a) => {
 *     await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
 *       method: "POST",
 *       headers: { "content-type": "application/json" },
 *       body: JSON.stringify({ chat_id: process.env.TG_CHAT, text: formatAlert(a) }),
 *     });
 *   };
 *   await dispatchAlerts(decision.alerts, telegram);
 *
 * A generic webhook is the same shape (POST the JSON alert to a URL).
 * Because the rules are pure and the transport is injected, adding a
 * channel never touches the alert rules — and the tests keep using a
 * fake sender.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ */
/* types                                                              */
/* ------------------------------------------------------------------ */

/** Ordered by urgency. `critical` is never rate-limited away. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Grouping bucket. One message per tier per poll. */
export type AlertTier = "critical" | "warning" | "info" | "resolution" | "summary";

/** One machine-state change — the unit the monitor's diff produces. */
export type StateChange =
  | { kind: "kill-switch"; engaged: boolean; reason?: string }
  | { kind: "circuit-breaker"; tripped: boolean; reason?: string }
  | { kind: "margin"; freeUsd: number; floorUsd: number; totalUsd?: number }
  | { kind: "daily-loss"; lossUsd: number; limitUsd: number }
  | {
      kind: "position-opened";
      pair: string;
      side: string;
      size: number;
      price: number;
      notionalUsd?: number;
      marginUsd?: number;
      exitArmed: boolean;
    }
  | { kind: "exit-armed"; pair: string; side?: string; size?: number; price?: number; why?: "armed" | "closed" }
  | {
      kind: "position-closed";
      pair: string;
      side: string;
      size: number;
      price: number;
      pnlUsd?: number;
      reason?: string;
      at?: number;
    }
  | {
      kind: "fill";
      pair: string;
      side: string;
      size: number;
      price: number;
      feeUsd?: number;
      fillId?: string;
      /** `tp`/`sl` become their own findings — never also a plain fill. */
      fillKind?: "open" | "close" | "tp" | "sl";
      at?: number;
    }
  | {
      kind: "unknown-origin";
      pair: string;
      side: string;
      size: number;
      price?: number;
      notionalUsd?: number;
      marginUsd?: number;
      /** True when the rogue position is gone — resolves the finding. */
      cleared?: boolean;
    }
  | { kind: "daemon"; event: "crash" | "restart"; pid?: number; exitCode?: number; since?: number; reason?: string; at?: number }
  | { kind: "daily-summary"; trades: number; wins: number; losses: number; netPnlUsd: number; feesUsd: number; day?: string };

/** One finding derived from a change, before grouping. */
export type AlertFinding = {
  /** Stable dedup key. */
  key: string;
  /** condition = persistent state (can clear), event = point in time, resolution = a clear. */
  kind: "condition" | "event" | "resolution";
  tier: AlertTier;
  severity: AlertSeverity;
  /** Short noun phrase used in grouped headlines ("position opened without exit armed"). */
  label: string;
  /** The thing the finding is about (pair, account, daemon) — for headlines. */
  subject: string;
  /** One line. */
  headline: string;
  /** The numbers, in words. */
  detail: string;
  /** What a human should DO. */
  action: string;
  /** The concrete numbers, structured. */
  numbers: Record<string, string | number>;
  /** Short numeric fragment for grouped headlines ("$3.20 vs $50.00 floor"). */
  stat: string;
  /** Material-number fingerprint — changes ⇒ the finding is news again. */
  fingerprint: string;
  /** Override the policy cooldown for this finding (used by escalations). */
  cooldownMs?: number;
  /** True when the policy escalated this finding. */
  escalated?: boolean;
};

/** A finished, grouped message. */
export type Alert = {
  id: string;
  severity: AlertSeverity;
  tier: AlertTier;
  headline: string;
  detail: string;
  action: string;
  numbers: Record<string, string | number>;
  findings: AlertFinding[];
  escalated: boolean;
  at: number;
};

/** Retained state for ONE finding key — the unit of dedup/cooldown. */
export type AlertKey = {
  key: string;
  fingerprint: string;
  /** Consecutive polls the condition has been reported. */
  occurrences: number;
  /** ms of the last dispatch (0 = never). */
  lastSentAt: number;
  lastSeenAt: number;
  /** A condition is active while it keeps being reported. */
  active: boolean;
  escalated: boolean;
};

/** Everything the policy retains between polls. */
export type AlertState = {
  keys: AlertKey[];
  /** Dispatch timestamps inside the current rate window. */
  sends: number[];
  /** Routine alerts held back by the rate limit — flushed later, never dropped. */
  pending: Alert[];
};

export type AlertPolicy = {
  /** Suppress a repeat of the same finding (same key + fingerprint) for this long. */
  cooldownMs: number;
  /** A condition active for MORE than this many consecutive polls escalates. */
  escalateAfterPolls: number;
  /** Cooldown for the repeat "escalated" alert of an already-critical finding. */
  escalationCooldownMs: number;
  /** Max routine messages per rate window. */
  maxAlertsPerWindow: number;
  /** Rate-limit window. */
  rateWindowMs: number;
  /** Max alerts held in the pending queue (oldest routine drop first; criticals never). */
  maxPending: number;
  /** Retained keys older than this are pruned from the state (bounded growth). */
  stateRetentionMs: number;
};

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  cooldownMs: 15 * 60_000,
  escalateAfterPolls: 3,
  escalationCooldownMs: 30 * 60_000,
  maxAlertsPerWindow: 5,
  rateWindowMs: 10 * 60_000,
  maxPending: 50,
  stateRetentionMs: 24 * 60 * 60_000,
};

/** Delivery channel — pluggable transport. */
export type AlertSender = (alert: Alert) => Promise<void>;

export type EvaluateOptions = {
  policy?: Partial<AlertPolicy>;
  /** Dispatch timestamps from the previous poll (global rate limit). */
  sends?: readonly number[];
  /** Alerts queued by the previous poll. */
  pending?: readonly Alert[];
};

export type AlertDecision = {
  /** Dispatch these now (already grouped, most severe first). */
  alerts: Alert[];
  /** Persist this as the next poll's `previousAlertKeys` + rate bookkeeping. */
  state: AlertState;
  /** Findings suppressed by dedup/cooldown — for observability. */
  suppressed: { key: string; reason: "cooldown" }[];
  /** Routine alerts held by the rate limit (they flush later). */
  queued: Alert[];
};

/* ------------------------------------------------------------------ */
/* formatting helpers                                                */
/* ------------------------------------------------------------------ */

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `$1,234.56` — "unknown" for anything not measurable (never a fake 0). */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "unknown";
  const neg = n < 0;
  const abs = Math.abs(n);
  const s = abs > 0 && abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2);
  const [i = "0", d] = s.split(".");
  return `${neg ? "-" : ""}$${groupThousands(i)}${d ? `.${d}` : ""}`;
}

/** Price with a precision that fits the magnitude. */
export function px(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "unknown";
  const abs = Math.abs(n);
  return n.toFixed(abs >= 100 ? 2 : abs >= 1 ? 4 : 6);
}

/** Size / count — trailing zeros dropped, never scientific notation. */
export function qty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "unknown";
  return String(Number(n.toFixed(8)));
}

function pctOf(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return "unknown";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Coarse band of a ratio (0..1+) used as a fingerprint component: a
 * breach that worsens into a worse band is news; noise inside a band is
 * not. Prevents "free margin fell by $0.01" from re-alerting every poll.
 */
function band(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "na";
  if (ratio <= 0.25) return "b25";
  if (ratio <= 0.5) return "b50";
  if (ratio <= 0.75) return "b75";
  return "b100";
}

function sevRank(s: AlertSeverity): number {
  return s === "critical" ? 3 : s === "warning" ? 2 : 1;
}

/** Severity implied by a tier. */
export const TIER_SEVERITY: Record<AlertTier, AlertSeverity> = {
  critical: "critical",
  warning: "warning",
  info: "info",
  resolution: "info",
  summary: "info",
};

const TIER_ORDER: AlertTier[] = ["critical", "warning", "info", "resolution", "summary"];

/* ------------------------------------------------------------------ */
/* finding derivation — one change → the findings it implies         */
/* ------------------------------------------------------------------ */

type Draft = Omit<AlertFinding, "kind" | "tier" | "severity" | "numbers"> & {
  kind: AlertFinding["kind"];
  tier: AlertTier;
  severity: AlertSeverity;
  numbers?: Record<string, string | number>;
};

function draft(d: Draft): AlertFinding {
  return { ...d, numbers: d.numbers ?? {} };
}

/**
 * Pure: one machine-state change → the findings it implies.
 *
 * A condition change carries the CURRENT truth, so it yields either the
 * active finding (condition true now) or a resolution (condition false
 * now). An event change yields exactly one point-in-time finding.
 */
export function deriveFindings(change: StateChange): AlertFinding[] {
  switch (change.kind) {
    case "kill-switch": {
      const key = "kill-switch:engaged";
      if (!change.engaged) {
        return [
          draft({
            key,
            kind: "resolution",
            tier: "resolution",
            severity: "info",
            label: "kill switch released",
            subject: "kill switch",
            headline: "ALL CLEAR — kill switch released",
            detail: `kill switch is no longer engaged${change.reason ? ` (${change.reason})` : ""} — entries and exits are allowed again.`,
            action: "Confirm the resume was deliberate (a human clears the kill switch) and that positions are as expected before firing.",
            stat: "released",
            fingerprint: "kill-switch:released",
          }),
        ];
      }
      return [
        draft({
          key,
          kind: "condition",
          tier: "critical",
          severity: "critical",
          label: "kill switch engaged",
          subject: "kill switch",
          headline: "KILL SWITCH ENGAGED — trading halted",
          detail: `kill switch engaged${change.reason ? ` (reason: ${change.reason})` : ""} — every new entry and exit is blocked until a human clears it.`,
          action: "Check the account is flat or protected (jw3 positions --exchange <venue>), then clear the kill switch by hand — resume is never automatic.",
          stat: change.reason ?? "engaged",
          fingerprint: "kill-switch:engaged",
        }),
      ];
    }

    case "circuit-breaker": {
      const key = "circuit-breaker:tripped";
      if (!change.tripped) {
        return [
          draft({
            key,
            kind: "resolution",
            tier: "resolution",
            severity: "info",
            label: "circuit breaker cleared",
            subject: "circuit breaker",
            headline: "ALL CLEAR — circuit breaker cleared",
            detail: "the circuit breaker is no longer tripped — new orders are allowed again.",
            action: "Confirm the breaker was cleared deliberately and read the trip reason before the next entry.",
            stat: "cleared",
            fingerprint: "breaker:cleared",
          }),
        ];
      }
      return [
        draft({
          key,
          kind: "condition",
          tier: "critical",
          severity: "critical",
          label: "circuit breaker tripped",
          subject: "circuit breaker",
          headline: `CIRCUIT BREAKER TRIPPED${change.reason ? ` — ${change.reason}` : ""}`,
          detail: `the circuit breaker tripped${change.reason ? ` (reason: ${change.reason})` : ""} — no new orders are accepted while it is set.`,
          action: "Read the breaker reason, flatten if the policy says so, then clear the breaker and resume manually — there is no auto-resume.",
          stat: change.reason ?? "tripped",
          fingerprint: "breaker:tripped",
        }),
      ];
    }

    case "margin": {
      const key = "margin:free-below-floor";
      const { freeUsd, floorUsd, totalUsd } = change;
      if (!Number.isFinite(freeUsd) || !Number.isFinite(floorUsd)) return [];
      if (freeUsd >= floorUsd) {
        return [
          draft({
            key,
            kind: "resolution",
            tier: "resolution",
            severity: "info",
            label: "free margin back above floor",
            subject: "free margin",
            headline: `ALL CLEAR — free margin ${usd(freeUsd)} back above the ${usd(floorUsd)} floor`,
            detail: `free margin is ${usd(freeUsd)} against a floor of ${usd(floorUsd)} — the margin floor is satisfied again.`,
            action: "Nothing to do; keep the floor in place for the next entry.",
            stat: `${usd(freeUsd)} free`,
            fingerprint: "margin:clear",
          }),
        ];
      }
      const ratio = floorUsd === 0 ? NaN : freeUsd / floorUsd;
      return [
        draft({
          key,
          kind: "condition",
          tier: "critical",
          severity: "critical",
          label: "free margin below floor",
          subject: "free margin",
          headline: `FREE MARGIN BELOW FLOOR — ${usd(freeUsd)} free vs ${usd(floorUsd)} floor`,
          detail: `free margin ${usd(freeUsd)} is below the floor ${usd(floorUsd)}${totalUsd !== undefined && Number.isFinite(totalUsd) ? ` (${pctOf(freeUsd, totalUsd)} of ${usd(totalUsd)} total)` : ""} — new entries are blocked and liquidation risk is up.`,
          action: `Stop opening positions. Close or reduce until free margin is above ${usd(floorUsd)} (jw3 close --pair <PAIR> --size <LOTS> --yes).`,
          numbers: { freeUsd, floorUsd, totalUsd: totalUsd ?? "unknown", ofFloorPct: pctOf(freeUsd, floorUsd) },
          stat: `${usd(freeUsd)} vs ${usd(floorUsd)} floor`,
          fingerprint: `margin:${band(ratio)}`,
        }),
      ];
    }

    case "daily-loss": {
      const key = "daily-loss:limit";
      const { lossUsd, limitUsd } = change;
      if (!Number.isFinite(lossUsd) || !Number.isFinite(limitUsd)) return [];
      if (lossUsd < limitUsd) {
        return [
          draft({
            key,
            kind: "resolution",
            tier: "resolution",
            severity: "info",
            label: "daily loss back under the limit",
            subject: "daily loss",
            headline: "ALL CLEAR — daily loss back under the limit",
            detail: `daily loss ${usd(lossUsd)} is under the ${usd(limitUsd)} limit.`,
            action: "Nothing to do; the loss cap still applies to today's next entries.",
            stat: usd(lossUsd),
            fingerprint: "daily-loss:clear",
          }),
        ];
      }
      const ratio = limitUsd === 0 ? NaN : lossUsd / limitUsd;
      return [
        draft({
          key,
          kind: "condition",
          tier: "critical",
          severity: "critical",
          label: "daily loss limit reached",
          subject: "daily loss",
          headline: `DAILY LOSS LIMIT REACHED — ${usd(lossUsd)} of ${usd(limitUsd)}`,
          detail: `daily loss ${usd(lossUsd)} reached the ${usd(limitUsd)} limit (${pctOf(lossUsd, limitUsd)} of the cap) — the day is over for new trades.`,
          action: "No more trades today. Flatten any open position per policy, then read the day's fills before tomorrow.",
          numbers: { lossUsd, limitUsd, ofLimitPct: pctOf(lossUsd, limitUsd) },
          stat: `${usd(lossUsd)} of ${usd(limitUsd)}`,
          fingerprint: `daily-loss:${band(ratio)}`,
        }),
      ];
    }

    case "position-opened": {
      const { pair, side, size, price, notionalUsd, marginUsd, exitArmed } = change;
      if (exitArmed) return []; // already protected — the fill confirmation reports it
      const key = `position:no-exit:${pair.toUpperCase()}`;
      return [
        draft({
          key,
          kind: "condition",
          tier: "critical",
          severity: "critical",
          label: "position opened without exit armed",
          subject: pair.toUpperCase(),
          headline: `POSITION OPENED WITHOUT EXIT ARMED — ${pair.toUpperCase()} ${side} ${qty(size)}`,
          detail: `${pair.toUpperCase()} ${side} ${qty(size)} @ ${px(price)}${Number.isFinite(notionalUsd ?? NaN) ? `, notional ${usd(notionalUsd)}` : ""}${Number.isFinite(marginUsd ?? NaN) ? `, margin locked ${usd(marginUsd)}` : ""} — no take-profit and no stop are armed.`,
          action: `Arm an exit now (jw3 exits --pair ${pair} --tp <px> / --sl <px> --yes) or close it (jw3 close --pair ${pair} --size <LOTS> --yes). An open position with no stop is the one state that must never wait for the next poll.`,
          numbers: { pair: pair.toUpperCase(), side, size, price, notionalUsd: notionalUsd ?? "unknown", marginUsd: marginUsd ?? "unknown" },
          stat: `${pair.toUpperCase()} ${qty(size)} @ ${px(price)}`,
          fingerprint: `no-exit:${pair.toUpperCase()}:${side}`,
        }),
      ];
    }

    case "exit-armed": {
      const key = `position:no-exit:${change.pair.toUpperCase()}`;
      const closed = change.why === "closed";
      return [
        draft({
          key,
          kind: "resolution",
          tier: "resolution",
          severity: "info",
          label: closed ? "unprotected position closed" : "exit armed",
          subject: change.pair.toUpperCase(),
          headline: closed
            ? `ALL CLEAR — unprotected ${change.pair.toUpperCase()} position is closed`
            : `ALL CLEAR — exit armed on ${change.pair.toUpperCase()}`,
          detail: closed
            ? `${change.pair.toUpperCase()}${change.side ? ` ${change.side}` : ""}${Number.isFinite(change.size ?? NaN) ? ` ${qty(change.size)}` : ""} was closed while it had no exit armed — the unprotected-position finding is closed.`
            : `${change.pair.toUpperCase()}${change.side ? ` ${change.side}` : ""}${Number.isFinite(change.size ?? NaN) ? ` ${qty(change.size)}` : ""} now has its exit armed${Number.isFinite(change.price ?? NaN) ? ` at ${px(change.price)}` : ""}.`,
          action: closed
            ? "Nothing to do; the margin pool is one position freer — re-check free margin before the next entry."
            : "Nothing to do; verify the armed leg is live on the venue (jw3 orders --pair <PAIR>).",
          stat: change.pair.toUpperCase(),
          fingerprint: closed ? `exit-armed:closed:${change.pair.toUpperCase()}` : `exit-armed:${change.pair.toUpperCase()}`,
        }),
      ];
    }

    case "position-closed": {
      const { pair, side, size, price, pnlUsd, at } = change;
      const p = pair.toUpperCase();
      return [
        draft({
          key: `position-closed:${p}:${at ?? 0}`,
          kind: "event",
          tier: "info",
          severity: "info",
          label: "position closed",
          subject: p,
          headline: `POSITION CLOSED — ${p} ${side} ${qty(size)} @ ${px(price)}`,
          detail: `closed ${qty(size)} ${side} on ${p} @ ${px(price)}${Number.isFinite(pnlUsd ?? NaN) ? `, realized P&L ${usd(pnlUsd)}` : ""}.`,
          action: `Reconcile the venue against the local state (jw3 reconcile --pair ${p}) so no stale order survives into the next trade.`,
          numbers: { pair: p, side, size, price, pnlUsd: pnlUsd ?? "unknown" },
          stat: `${p} ${qty(size)} @ ${px(price)}`,
          fingerprint: `closed:${p}:${at ?? 0}:${size}`,
        }),
      ];
    }

    case "fill": {
      const { pair, side, size, price, feeUsd, fillId, fillKind, at } = change;
      const p = pair.toUpperCase();
      const id = fillId ?? `${p}:${side}:${size}:${price}:${at ?? 0}`;
      const fee = Number.isFinite(feeUsd ?? NaN) ? `, fee ${usd(feeUsd)}` : "";
      if (fillKind === "tp") {
        return [
          draft({
            key: `tp-filled:${id}`,
            kind: "event",
            tier: "info",
            severity: "info",
            label: "take profit filled",
            subject: p,
            headline: `TP FILLED — ${p} ${side} ${qty(size)} @ ${px(price)}`,
            detail: `take profit filled: ${qty(size)} ${side} on ${p} @ ${px(price)}${fee}.`,
            action: `Confirm the position is flat and the state file is cleared (jw3 scalp kill --pair ${p}) so the next run starts clean.`,
            numbers: { pair: p, side, size, price, feeUsd: feeUsd ?? "unknown" },
            stat: `${p} ${qty(size)} @ ${px(price)}`,
            fingerprint: `tp:${id}`,
          }),
        ];
      }
      if (fillKind === "sl") {
        return [
          draft({
            key: `stop-hit:${id}`,
            kind: "event",
            tier: "warning",
            severity: "warning",
            label: "stop hit",
            subject: p,
            headline: `STOP HIT — ${p} ${side} ${qty(size)} @ ${px(price)}`,
            detail: `stop filled: ${qty(size)} ${side} on ${p} @ ${px(price)}${fee}.`,
            action: "Verify flat and clear the state file, then apply the post-loss rule (halve the size or stand down for the session) before the next entry.",
            numbers: { pair: p, side, size, price, feeUsd: feeUsd ?? "unknown" },
            stat: `${p} ${qty(size)} @ ${px(price)}`,
            fingerprint: `sl:${id}`,
          }),
        ];
      }
      return [
        draft({
          key: `fill:${id}`,
          kind: "event",
          tier: "info",
          severity: "info",
          label: "fill confirmed",
          subject: p,
          headline: `FILL CONFIRMED — ${p} ${side} ${qty(size)} @ ${px(price)}`,
          detail: `filled ${qty(size)} ${side} on ${p} @ ${px(price)}${fee}.`,
          action: `Verify the exit legs are armed on ${p} (jw3 orders --pair ${p}) — a fill without an armed exit is the risk this machine exists to catch.`,
          numbers: { pair: p, side, size, price, feeUsd: feeUsd ?? "unknown" },
          stat: `${p} ${qty(size)} @ ${px(price)}`,
          fingerprint: `fill:${id}`,
        }),
      ];
    }

    case "unknown-origin": {
      const { pair, side, size, price, notionalUsd, marginUsd, cleared } = change;
      const p = pair.toUpperCase();
      const key = `unknown-origin:${p}:${side}`;
      if (cleared) {
        return [
          draft({
            key,
            kind: "resolution",
            tier: "resolution",
            severity: "info",
            label: "unknown-origin position cleared",
            subject: p,
            headline: `ALL CLEAR — unknown-origin position on ${p} is gone`,
            detail: `${p} ${side} ${qty(size)} no longer sits unmanaged in the account.`,
            action: "Nothing to do; keep the position-ownership check on before every entry so the pool stays understood.",
            stat: p,
            fingerprint: `unknown-origin:cleared:${p}`,
          }),
        ];
      }
      return [
        draft({
          key,
          kind: "condition",
          tier: "warning",
          severity: "warning",
          label: "unknown-origin position",
          subject: p,
          headline: `UNKNOWN-ORIGIN POSITION — ${p} ${side} ${qty(size)}`,
          detail: `${p} ${side} ${qty(size)}${Number.isFinite(price ?? NaN) ? ` @ ${px(price)}` : ""}${Number.isFinite(notionalUsd ?? NaN) ? `, notional ${usd(notionalUsd)}` : ""}${Number.isFinite(marginUsd ?? NaN) ? `, margin ${usd(marginUsd)}` : ""} has no local state (scalp/grid/trail) — nothing owns it and it holds the shared margin pool.`,
          action: `Close it (jw3 close --pair ${p} --size <LOTS> --yes) or adopt it by writing its state file — and fire nothing new until the margin pool is understood.`,
          numbers: { pair: p, side, size, price: price ?? "unknown", notionalUsd: notionalUsd ?? "unknown", marginUsd: marginUsd ?? "unknown" },
          stat: `${p} ${qty(size)}`,
          fingerprint: `unknown-origin:${p}:${side}`,
        }),
      ];
    }

    case "daemon": {
      if (change.event === "crash") {
        return [
          draft({
            key: `daemon:crash:${change.pid ?? 0}:${change.exitCode ?? 0}:${change.at ?? 0}`,
            kind: "event",
            tier: "critical",
            severity: "critical",
            label: "daemon crashed",
            subject: "daemon",
            headline: `DAEMON CRASHED — pid ${change.pid ?? "?"} exit ${change.exitCode ?? "?"}`,
            detail: `the daemon process died (pid ${change.pid ?? "unknown"}, exit code ${change.exitCode ?? "unknown"})${change.reason ? `: ${change.reason}` : ""} — positions may be unguarded.`,
            action: "Check the daemon log, verify open positions are still protected, and let the supervisor restart it with backoff — never start a second daemon by hand while one may still be alive.",
            numbers: { pid: change.pid ?? "unknown", exitCode: change.exitCode ?? "unknown" },
            stat: `pid ${change.pid ?? "?"} exit ${change.exitCode ?? "?"}`,
            fingerprint: `daemon:crash:${change.pid ?? 0}:${change.exitCode ?? 0}`,
          }),
        ];
      }
      return [
        draft({
          key: `daemon:restart:${change.pid ?? 0}:${change.at ?? 0}`,
          kind: "event",
          tier: "warning",
          severity: "warning",
          label: "daemon restarted",
          subject: "daemon",
          headline: `DAEMON RESTARTED — pid ${change.pid ?? "?"}`,
          detail: `the daemon restarted (pid ${change.pid ?? "unknown"})${Number.isFinite(change.since ?? NaN) ? `, up since ${new Date(change.since as number).toISOString()}` : ""}.`,
          action: "Read the previous run's crash log — a restart loop means the guard was not holding.",
          numbers: { pid: change.pid ?? "unknown", since: change.since ?? "unknown" },
          stat: `pid ${change.pid ?? "?"}`,
          fingerprint: `daemon:restart:${change.pid ?? 0}`,
        }),
      ];
    }

    case "daily-summary": {
      const { trades, wins, losses, netPnlUsd, feesUsd, day } = change;
      const pnl = Number.isFinite(netPnlUsd) ? netPnlUsd : 0;
      return [
        draft({
          key: `daily-summary:${day ?? "today"}`,
          kind: "event",
          tier: "summary",
          severity: "info",
          label: "daily summary",
          subject: day ?? "today",
          headline: `DAILY SUMMARY — ${trades} trades, ${wins}W/${losses}L, net P&L ${usd(pnl)}`,
          detail: `${trades} trades, ${wins} wins, ${losses} losses, net P&L ${usd(pnl)}, fees paid ${usd(feesUsd)}.`,
          action:
            pnl < 0
              ? "Review the day's fills and fees, then apply the post-loss rule (halve the size or stand down) before the next entry."
              : "Review the day's fills and fees; one good day is not a reason to raise the size.",
          numbers: { trades, wins, losses, netPnlUsd: pnl, feesUsd },
          stat: `${trades} trades · ${usd(pnl)} net`,
          fingerprint: `daily-summary:${day ?? "today"}`,
        }),
      ];
    }

    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/* grouping                                                           */
/* ------------------------------------------------------------------ */

function groupHeadline(members: AlertFinding[]): string {
  if (members.length === 1) return members[0].headline;
  const byLabel = new Map<string, AlertFinding[]>();
  for (const m of members) {
    const arr = byLabel.get(m.label) ?? [];
    arr.push(m);
    byLabel.set(m.label, arr);
  }
  const parts: string[] = [];
  for (const [label, ms] of byLabel) {
    const subjects = [...new Set(ms.map((m) => m.subject).filter((s) => s && s !== "unknown"))];
    const sub = subjects.length ? ` [${subjects.slice(0, 3).join(", ")}${subjects.length > 3 ? ", …" : ""}]` : "";
    const stat = ms[0]?.stat ? ` (${ms[0].stat})` : "";
    parts.push(`${ms.length}× ${label}${sub}${stat}`);
  }
  const head = parts.join(", ");
  return head.length > 160 ? `${head.slice(0, 157)}…` : head;
}

function mergedNumbers(members: AlertFinding[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const m of members) {
    const prefix = members.length > 1 ? `${m.subject} ` : "";
    for (const [k, v] of Object.entries(m.numbers)) {
      const key = `${prefix}${k}`;
      out[key] = out[key] === undefined ? v : (out[key] as string | number);
    }
  }
  return out;
}

/** Pure: findings → one message per tier (most severe first). */
export function groupFindings(findings: AlertFinding[], now: number): Alert[] {
  const byTier = new Map<AlertTier, AlertFinding[]>();
  for (const f of findings) {
    const arr = byTier.get(f.tier) ?? [];
    arr.push(f);
    byTier.set(f.tier, arr);
  }
  const alerts: Alert[] = [];
  for (const tier of TIER_ORDER) {
    const members = byTier.get(tier);
    if (!members || members.length === 0) continue;
    const top = members.reduce((a, b) => (sevRank(b.severity) > sevRank(a.severity) ? b : a));
    alerts.push({
      id: `${tier}:${now}`,
      severity: TIER_SEVERITY[tier],
      tier,
      headline: groupHeadline(members),
      detail: members.map((m) => `• ${m.detail}\n  ACTION: ${m.action}`).join("\n"),
      action: members.length === 1 ? members[0].action : `${top.action} (+${members.length - 1} more — see detail)`,
      numbers: mergedNumbers(members),
      findings: members,
      escalated: members.some((m) => m.escalated === true),
      at: now,
    });
  }
  return alerts;
}

/* ------------------------------------------------------------------ */
/* THE POLICY                                                          */
/* ------------------------------------------------------------------ */

type Resolved = {
  finding: AlertFinding;
  prev: AlertKey | undefined;
  occurrences: number;
  selected: boolean;
  bypassCooldown: boolean;
  dropKey: boolean;
  escalated: boolean;
};

/**
 * THE ALERT POLICY — pure.
 *
 * `(previousAlertKeys, incomingChanges, now)` → the alerts to dispatch
 * this poll plus the state to retain for the next one.
 *
 * Quiet by default: the same finding on consecutive polls does not
 * re-alert (cooldown by key + window); a finding that persists escalates;
 * a finding that clears produces an "all clear"; several changes in one
 * poll collapse into one grouped message; routine messages are
 * rate-limited globally but never dropped (they queue) and a CRITICAL is
 * never delayed or lost.
 */
export function evaluateAlerts(
  previousAlertKeys: readonly AlertKey[],
  incomingChanges: readonly StateChange[],
  now: number,
  options: EvaluateOptions = {},
): AlertDecision {
  const policy: AlertPolicy = { ...DEFAULT_ALERT_POLICY, ...(options.policy ?? {}) };
  const prevByKey = new Map<string, AlertKey>();
  for (const k of previousAlertKeys) prevByKey.set(k.key, k);

  const resolved: Resolved[] = [];

  // 1. changes → findings → occurrence counts + escalation.
  for (const change of incomingChanges) {
    for (const finding of deriveFindings(change)) {
      const prev = prevByKey.get(finding.key);
      if (finding.kind === "resolution") {
        // Only a condition that was actually open can be "cleared".
        if (!prev || !prev.active) continue;
        resolved.push({ finding, prev, occurrences: prev.occurrences, selected: true, bypassCooldown: true, dropKey: true, escalated: false });
        // The escalation companion of a cleared condition goes with it —
        // otherwise a fresh episode of the same problem would inherit the
        // old episode's escalation cooldown.
        const escPrev = prevByKey.get(`${finding.key}#escalated`);
        if (escPrev) {
          resolved.push({
            finding: {
              ...finding,
              key: `${finding.key}#escalated`,
              kind: "resolution",
              tier: "resolution",
              severity: "info",
              headline: `ALL CLEAR — ${finding.headline.replace(/^ALL CLEAR — /, "")}`,
              detail: finding.detail,
              action: finding.action,
              fingerprint: `${finding.key}#escalated:cleared`,
            },
            prev: escPrev,
            occurrences: escPrev.occurrences,
            selected: false, // the companion resolution is bookkeeping only
            bypassCooldown: true,
            dropKey: true,
            escalated: false,
          });
        }
        continue;
      }
      const occurrences = finding.kind === "condition" && prev && prev.active ? prev.occurrences + 1 : 1;
      const entry: Resolved = { finding, prev, occurrences, selected: true, bypassCooldown: false, dropKey: false, escalated: false };

      if (finding.kind === "condition" && occurrences > policy.escalateAfterPolls) {
        // The condition has persisted past the threshold. The base
        // finding is SUPPRESSED (it is the same problem — reporting it
        // again would be a duplicate) and replaced by an escalated copy
        // that carries its own key and its own, longer cooldown. The
        // escalated copy therefore fires once when the condition crosses
        // the threshold and then stays quiet until its cooldown expires
        // — never on every poll.
        const escKey = `${finding.key}#escalated`;
        entry.selected = false;
        entry.escalated = true;

        const escFinding: AlertFinding =
          finding.severity === "critical"
            ? {
                ...finding,
                key: escKey,
                kind: "event",
                tier: "critical",
                severity: "critical",
                label: `${finding.label} — still true after ${occurrences} polls`,
                headline: `ESCALATED — ${finding.headline} (still true after ${occurrences} polls)`,
                detail: `${finding.detail} It has now been reported ${occurrences} polls in a row without clearing — a human must act.`,
                action: `${finding.action} This has persisted ${occurrences} polls — treat it as unattended.`,
                fingerprint: escKey,
                cooldownMs: policy.escalationCooldownMs,
                escalated: true,
              }
            : {
                ...finding,
                key: escKey,
                kind: "event",
                tier: "critical",
                severity: "critical",
                headline: `ESCALATED — ${finding.headline}`,
                detail: `${finding.detail} It has been reported ${occurrences} polls in a row without clearing — a human must act.`,
                action: `${finding.action} This has persisted ${occurrences} polls — treat it as unattended.`,
                fingerprint: escKey,
                cooldownMs: policy.escalationCooldownMs,
                escalated: true,
              };

        resolved.push({
          finding: escFinding,
          prev: prevByKey.get(escKey),
          occurrences: 1,
          selected: true,
          bypassCooldown: false,
          dropKey: false,
          escalated: true,
        });
      }
      resolved.push(entry);
    }
  }

  // 2. dedup / cooldown: suppress a repeat of the SAME finding.
  const suppressed: { key: string; reason: "cooldown" }[] = [];
  for (const entry of resolved) {
    if (!entry.selected) continue; // already deselected (e.g. escalated away)
    if (entry.bypassCooldown) continue;
    const prev = entry.prev;
    if (!prev) continue;
    if (prev.fingerprint !== entry.finding.fingerprint) continue; // material change → news
    if (entry.finding.kind === "resolution") continue;
    if (!Number.isFinite(prev.lastSentAt) || prev.lastSentAt <= 0) continue; // never sent
    const cooldown = entry.finding.cooldownMs ?? policy.cooldownMs;
    if (now - prev.lastSentAt < cooldown) {
      entry.selected = false;
      suppressed.push({ key: entry.finding.key, reason: "cooldown" });
    }
  }

  // 3. group the selected findings into messages.
  const selected = resolved.filter((r) => r.selected).map((r) => r.finding);
  const grouped = groupFindings(selected, now);

  // 4. global rate limit. Criticals and resolutions always dispatch and
  //    do NOT consume the routine budget (a burst of criticals must not
  //    silence the routine queue for the rest of the window); routine
  //    messages over the budget are NOT dropped — they queue and flush on
  //    a later poll.
  const sends = (options.sends ?? []).filter((t) => now - t < policy.rateWindowMs);
  const pending: Alert[] = [...(options.pending ?? [])];
  const dispatched: Alert[] = [];
  const queued: Alert[] = [];
  // The budget counts ROUTINE messages only.
  let used = sends.length;

  const exempt = (a: Alert): boolean => a.severity === "critical" || a.tier === "resolution";

  // flush what the previous poll held back (oldest first)
  for (const p of pending) {
    if (exempt(p) || used < policy.maxAlertsPerWindow) {
      dispatched.push(p);
      if (!exempt(p)) used++;
    } else {
      queued.push(p);
    }
  }

  for (const g of grouped) {
    if (exempt(g) || used < policy.maxAlertsPerWindow) {
      dispatched.push(g);
      if (!exempt(g)) used++;
    } else {
      queued.push(g);
    }
  }

  // Drop the oldest ROUTINE pending alerts if the queue overflows; a
  // critical or a resolution is never dropped.
  let kept = queued;
  if (kept.length > policy.maxPending) {
    const overflow = kept.length - policy.maxPending;
    const droppable = kept.filter((a) => !exempt(a)).slice(0, overflow);
    const drop = new Set(droppable);
    kept = kept.filter((a) => !drop.has(a));
  }

  // 5. build the next state.
  const written = new Set<string>();
  const nextKeys: AlertKey[] = [];
  for (const entry of resolved) {
    const f = entry.finding;
    if (written.has(f.key)) continue;
    written.add(f.key);
    if (entry.dropKey) continue; // the condition cleared — forget the key
    nextKeys.push({
      key: f.key,
      fingerprint: f.fingerprint,
      occurrences: entry.occurrences,
      // A queued alert counts as "fired" so the same finding is not queued twice.
      lastSentAt: entry.selected ? now : (entry.prev?.lastSentAt ?? 0),
      lastSeenAt: now,
      active: f.kind === "condition",
      escalated: entry.escalated || (entry.prev?.escalated ?? false),
    });
  }
  // Untouched keys carry over (conditions still open, event cooldowns).
  for (const [k, prev] of prevByKey) {
    if (written.has(k)) continue;
    nextKeys.push({ ...prev });
  }

  // Prune retained keys that have aged out (bounded state growth). An
  // OPEN condition is never pruned — dropping it would silently forget
  // a live risk and its "all clear".
  const retained = nextKeys.filter((k) => k.active || now - k.lastSeenAt < policy.stateRetentionMs);

  return {
    alerts: dispatched,
    state: {
      keys: retained,
      // Every ROUTINE message occupies one slot in the window; criticals
      // and resolutions are exempt and do not consume the budget. The
      // timestamps are the bookkeeping (one entry per routine message),
      // so the next poll's `sends.length` IS the number of routine
      // messages already spent in the window.
      sends: [...sends, ...dispatched.filter((a) => !exempt(a)).map((a) => a.at)].filter((t) => now - t < policy.rateWindowMs),
      pending: kept,
    },
    suppressed,
    queued: kept,
  };
}

/* ------------------------------------------------------------------ */
/* delivery                                                            */
/* ------------------------------------------------------------------ */

/** Format one alert for a text channel. */
export function formatAlert(a: Alert): string {
  return `[${a.severity.toUpperCase()}] ${a.headline}\n${a.detail}\nACTION: ${a.action}`;
}

/**
 * Dispatch alerts through an injectable channel. Sequential so the order
 * the policy produced (critical first) is the order delivered.
 */
export async function dispatchAlerts(alerts: readonly Alert[], send: AlertSender): Promise<number> {
  let n = 0;
  for (const a of alerts) {
    await send(a);
    n++;
  }
  return n;
}

/** Console transport — one formatted block per alert. */
export function consoleTransport(write: (line: string) => void = (l) => console.log(l)): AlertSender {
  return async (alert) => {
    write(formatAlert(alert));
  };
}

/** File transport — one JSON object per line (JSONL), appended. */
export function fileTransport(path: string): AlertSender {
  return async (alert) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // best-effort; the append below still tries
    }
    try {
      appendFileSync(path, `${JSON.stringify(alert)}\n`);
    } catch {
      // A transport failure must never take the machine down.
    }
  };
}

/* ------------------------------------------------------------------ */
/* machine snapshot + diff                                             */
/* ------------------------------------------------------------------ */

export type MachinePosition = {
  pair: string;
  side: string;
  size: number;
  price: number;
  entryPrice?: number;
  notionalUsd?: number;
  marginUsd?: number;
  exitArmed?: boolean;
  unknownOrigin?: boolean;
  pnlUsd?: number;
  openedAt?: number;
};

export type MachineFill = {
  id?: string;
  pair: string;
  side: string;
  size: number;
  price: number;
  feeUsd?: number;
  kind?: "open" | "close" | "tp" | "sl";
  at?: number;
};

export type MachineDaily = {
  day?: string;
  trades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  feesUsd: number;
};

export type MachineDaemon = {
  status: "up" | "crashed" | "restarted";
  pid?: number;
  exitCode?: number;
  since?: number;
  reason?: string;
  at?: number;
};

/** One poll's view of the machine. */
export type MachineSnapshot = {
  at?: number;
  killSwitchEngaged?: boolean;
  breakerTripped?: boolean;
  breakerReason?: string;
  freeMarginUsd?: number;
  marginFloorUsd?: number;
  totalMarginUsd?: number;
  dailyLossUsd?: number;
  dailyLossLimitUsd?: number;
  positions?: MachinePosition[];
  fills?: MachineFill[];
  daily?: MachineDaily;
  daemon?: MachineDaemon;
};

function posKey(p: MachinePosition): string {
  return `${p.pair.toUpperCase()}:${String(p.side).toLowerCase()}`;
}

function fillKey(f: MachineFill): string {
  return f.id ?? `${f.pair.toUpperCase()}:${f.side}:${f.size}:${f.price}:${f.at ?? 0}`;
}

/**
 * Pure: two machine snapshots → the changes between them.
 *
 * Conditions (kill switch, breaker, margin floor, daily loss, unknown
 * origin, no-exit) are reported while they are TRUE so the policy can
 * count polls and escalate; they are also reported once when they turn
 * false so the policy can emit the "all clear". Events (fills, closes,
 * daemon crash/restart, daily summary) are reported once.
 */
export function diffMachineState(prev: MachineSnapshot | null | undefined, next: MachineSnapshot): StateChange[] {
  const out: StateChange[] = [];
  const p = prev ?? {};

  if (typeof next.killSwitchEngaged === "boolean") {
    const was = p.killSwitchEngaged === true;
    if (next.killSwitchEngaged !== was) {
      out.push({ kind: "kill-switch", engaged: next.killSwitchEngaged });
    } else if (next.killSwitchEngaged) {
      out.push({ kind: "kill-switch", engaged: true });
    }
  }

  if (typeof next.breakerTripped === "boolean") {
    const was = p.breakerTripped === true;
    if (next.breakerTripped !== was) {
      out.push({ kind: "circuit-breaker", tripped: next.breakerTripped, reason: next.breakerReason });
    } else if (next.breakerTripped) {
      out.push({ kind: "circuit-breaker", tripped: true, reason: next.breakerReason });
    }
  }

  if (Number.isFinite(next.freeMarginUsd ?? NaN) && Number.isFinite(next.marginFloorUsd ?? NaN)) {
    const free = next.freeMarginUsd as number;
    const floor = next.marginFloorUsd as number;
    const wasBreach = Number.isFinite(p.freeMarginUsd ?? NaN) && Number.isFinite(p.marginFloorUsd ?? NaN) && (p.freeMarginUsd as number) < (p.marginFloorUsd as number);
    const isBreach = free < floor;
    if (isBreach || wasBreach) {
      out.push({ kind: "margin", freeUsd: free, floorUsd: floor, totalUsd: next.totalMarginUsd });
    }
  }

  if (Number.isFinite(next.dailyLossUsd ?? NaN) && Number.isFinite(next.dailyLossLimitUsd ?? NaN)) {
    const loss = next.dailyLossUsd as number;
    const limit = next.dailyLossLimitUsd as number;
    const wasBreach = Number.isFinite(p.dailyLossUsd ?? NaN) && Number.isFinite(p.dailyLossLimitUsd ?? NaN) && (p.dailyLossUsd as number) >= (p.dailyLossLimitUsd as number);
    const isBreach = loss >= limit;
    if (isBreach || wasBreach) {
      out.push({ kind: "daily-loss", lossUsd: loss, limitUsd: limit });
    }
  }

  const prevPositions = new Map((p.positions ?? []).map((x) => [posKey(x), x]));
  const nextPositions = new Map((next.positions ?? []).map((x) => [posKey(x), x]));

  for (const [k, pos] of nextPositions) {
    const before = prevPositions.get(k);
    if (!before) {
      out.push({
        kind: "position-opened",
        pair: pos.pair,
        side: pos.side,
        size: pos.size,
        price: pos.price,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
        exitArmed: pos.exitArmed === true,
      });
    } else if (before.exitArmed !== true && pos.exitArmed === true) {
      out.push({ kind: "exit-armed", pair: pos.pair, side: pos.side, size: pos.size, price: pos.price, why: "armed" });
    } else if (before.exitArmed !== true && pos.exitArmed !== true) {
      // The position is still unprotected: re-report it every poll so the
      // policy can count the polls and escalate. Without this a condition
      // would only ever be seen once and could never escalate.
      out.push({
        kind: "position-opened",
        pair: pos.pair,
        side: pos.side,
        size: pos.size,
        price: pos.price,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
        exitArmed: false,
      });
    }
    if (pos.unknownOrigin === true) {
      // Re-reported every poll while it persists (escalation + resolution).
      out.push({
        kind: "unknown-origin",
        pair: pos.pair,
        side: pos.side,
        size: pos.size,
        price: pos.price,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
      });
    } else if (before?.unknownOrigin === true) {
      out.push({ kind: "unknown-origin", pair: before.pair, side: before.side, size: before.size, cleared: true });
    }
  }

  for (const [k, pos] of prevPositions) {
    if (nextPositions.has(k)) continue;
    if (pos.exitArmed !== true) {
      // The unprotected position is gone — close the no-exit finding.
      out.push({ kind: "exit-armed", pair: pos.pair, side: pos.side, size: pos.size, why: "closed" });
    }
    out.push({
      kind: "position-closed",
      pair: pos.pair,
      side: pos.side,
      size: pos.size,
      price: pos.price,
      pnlUsd: pos.pnlUsd,
      at: next.at ?? pos.openedAt,
    });
  }

  const seenFills = new Set((p.fills ?? []).map(fillKey));
  for (const f of next.fills ?? []) {
    if (seenFills.has(fillKey(f))) continue;
    out.push({
      kind: "fill",
      pair: f.pair,
      side: f.side,
      size: f.size,
      price: f.price,
      feeUsd: f.feeUsd,
      fillId: f.id,
      fillKind: f.kind,
      at: f.at,
    });
  }

  if (next.daemon) {
    const was = p.daemon?.status;
    if (next.daemon.status === "crashed" && was !== "crashed") {
      out.push({ kind: "daemon", event: "crash", pid: next.daemon.pid, exitCode: next.daemon.exitCode, reason: next.daemon.reason, at: next.daemon.at });
    } else if (next.daemon.status === "restarted" && was !== "restarted") {
      out.push({ kind: "daemon", event: "restart", pid: next.daemon.pid, since: next.daemon.since, at: next.daemon.at });
    }
  }

  if (next.daily && p.daily?.day !== next.daily.day) {
    out.push({
      kind: "daily-summary",
      trades: next.daily.trades,
      wins: next.daily.wins,
      losses: next.daily.losses,
      netPnlUsd: next.daily.netPnlUsd,
      feesUsd: next.daily.feesUsd,
      day: next.daily.day,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* persistence + command                                               */
/* ------------------------------------------------------------------ */

function configHome(): string {
  if (process.env["JW3_CONFIG_HOME"]) return process.env["JW3_CONFIG_HOME"] as string;
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

/** Where the policy state (dedup keys, rate window, queue) lives. */
export function defaultAlertStatePath(): string {
  return join(configHome(), "alert-state.json");
}

/** Where the last machine snapshot lives (the diff's left-hand side). */
export function defaultAlertSnapshotPath(): string {
  return join(configHome(), "alert-snapshot.json");
}

export function emptyAlertState(): AlertState {
  return { keys: [], sends: [], pending: [] };
}

/**
 * Load the retained policy state. A missing file is an empty state; an
 * UNREADABLE file is refused — silently resetting the state would
 * re-alert everything the dedup window was suppressing.
 */
export function loadAlertState(path: string): AlertState {
  if (!existsSync(path)) return emptyAlertState();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read the alert state at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`the alert state at ${path} is not valid JSON — refusing to reset it (that would re-alert every suppressed finding); fix or remove it by hand`);
  }
  if (!doc || typeof doc !== "object") {
    throw new Error(`the alert state at ${path} is not an object — refusing to reset it; fix or remove it by hand`);
  }
  const o = doc as Partial<AlertState>;
  return {
    keys: Array.isArray(o.keys) ? o.keys : [],
    sends: Array.isArray(o.sends) ? o.sends.filter((n) => typeof n === "number" && Number.isFinite(n)) : [],
    pending: Array.isArray(o.pending) ? o.pending : [],
  };
}

/** Persist the retained policy state. */
export function saveAlertState(path: string, state: AlertState): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    // best-effort; the write below still tries
  }
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export type AlertOpts = {
  /** Path to the current machine snapshot (JSON). */
  snapshot: string;
  /** Path to the previous snapshot (defaults to the stored one). */
  prevSnapshot?: string;
  /** Where the policy state lives. */
  statePath?: string;
  /** JSON file with policy overrides. */
  policyPath?: string;
  transport?: "console" | "file";
  /** Target file for the file transport. */
  out?: string;
  json?: boolean;
  /** Injectable clock (tests). */
  now?: number;
  /** Injectable sender (tests). */
  send?: AlertSender;
};

function readSnapshot(path: string): MachineSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read the machine snapshot at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`the machine snapshot at ${path} is not valid JSON — refusing to alert on what cannot be read`);
  }
  if (!doc || typeof doc !== "object") {
    throw new Error(`the machine snapshot at ${path} must be a JSON object`);
  }
  return doc as MachineSnapshot;
}

function loadPolicyOverrides(path: string): Partial<AlertPolicy> {
  const doc = readSnapshot(path) as unknown as Partial<AlertPolicy>;
  const out: Partial<AlertPolicy> = {};
  for (const key of Object.keys(DEFAULT_ALERT_POLICY) as (keyof AlertPolicy)[]) {
    const v = (doc as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      (out as Record<string, number>)[key] = v;
    }
  }
  return out;
}

/**
 * `jw3 alert` — one alert pass over a machine snapshot.
 *
 * READ-ONLY: it reads snapshots and writes only the alert state, the
 * snapshot copy and (with the file transport) the alert log. It never
 * places, cancels or signs anything.
 */
export async function cmdAlert(opts: AlertOpts): Promise<void> {
  if (!opts.snapshot) {
    console.error("Usage: jw3 alert --snapshot state.json [--transport console|file] [--out alerts.jsonl] [--json]");
    process.exitCode = 2;
    return;
  }
  const statePath = opts.statePath ?? defaultAlertStatePath();
  const snapPath = opts.prevSnapshot ?? defaultAlertSnapshotPath();
  const now = opts.now ?? Date.now();

  let state: AlertState;
  let policy: Partial<AlertPolicy>;
  let current: MachineSnapshot;
  let previous: MachineSnapshot | null = null;
  try {
    state = loadAlertState(statePath);
    policy = opts.policyPath ? loadPolicyOverrides(opts.policyPath) : {};
    current = readSnapshot(opts.snapshot);
    if (existsSync(snapPath)) previous = readSnapshot(snapPath);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)} — nothing was alerted.`);
    process.exitCode = 1;
    return;
  }

  const changes = diffMachineState(previous, current);
  const decision = evaluateAlerts(state.keys, changes, now, { policy, sends: state.sends, pending: state.pending });

  const send: AlertSender =
    opts.send ??
    (opts.transport === "file"
      ? fileTransport(opts.out ?? join(configHome(), "alerts.jsonl"))
      : consoleTransport());

  let sent = 0;
  try {
    sent = await dispatchAlerts(decision.alerts, send);
  } catch (e) {
    console.error(`Alert delivery failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }

  try {
    saveAlertState(statePath, decision.state);
    writeFileSync(snapPath, `${JSON.stringify(current, null, 2)}\n`);
  } catch (e) {
    console.error(`Could not persist the alert state: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        sent,
        queued: decision.queued.length,
        suppressed: decision.suppressed,
        changes: changes.length,
        alerts: decision.alerts,
      }),
    );
  } else if (sent === 0 && decision.queued.length === 0) {
    console.log(`No alerts — ${changes.length} change(s) seen, all quiet (deduped or below the severity floor).`);
  }
}
