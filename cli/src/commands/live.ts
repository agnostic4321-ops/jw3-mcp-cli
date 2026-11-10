/**
 * `jw3 live` — the single live execution path for the trading machine.
 *
 * ONE owner of the margin pool. This command (and only this command) may
 * place orders. Everything upstream of it — filters, committee, rubric,
 * sizing — produces a DECISION; this file turns an approved decision into
 * exactly one ticket and fires it, then verifies what the venue did.
 *
 * THE ORDER OF GATES (a trade that fails any one of them is not fired):
 *
 *   1. FILTERS      — cheap deterministic gates (session, spread, fee
 *                     drag, liquidity, funding, day-change, duplicate,
 *                     model quorum, and the repo's own blocking rules).
 *                     A reject here NEVER reaches the sizing engine.
 *   2. COMMITTEE   — the model seats debate. A hard veto ends it.
 *   3. RUBRIC      — turns the committee's scores into a tier
 *                     (FULL / HALF / PROBE / REJECT) with a size
 *                     multiplier and a reason.
 *   4. SIZING      — dollar risk is the constraint; leverage is DERIVED
 *                     from stop distance (never chosen). The decision
 *                     carries `amountBaseUnits` — the unit `execute_trade`
 *                     actually speaks.
 *   5. PRE-FLIGHT  — read-only venue checks: no position on the pair, no
 *                     working orders, free margin sufficient, kill switch
 *                     off. ALL of these are re-checked against the live
 *                     venue, never trusted from the plan.
 *   6. FIRE        — one limit order, TP armed, stop armed. The order
 *                     carries a clientOid so a later session attributes it
 *                     instead of treating it as rogue.
 *   7. VERIFY      — re-read positions and orders. The venue is the
 *                     book of record; a submitted order is NOT a fill.
 *
 * Every fund-moving call is behind `--yes`. A dry run prints the full
 * ticket and sends zero bytes.
 *
 * The kill switch is checked IMMEDIATELY before the fire, not only at
 * the start: a plan can sit for minutes while the operator changes their
 * mind server-side.
 */
import { callOrderTool, callTool, ORDER_TOOLS } from "../mcp.js";
import { resolvePat } from "../config.js";
import { futuresContractSpec } from "../kucoin.js";
import { sizeTrade, type SizingDecision, type SizingProposal, liquidationPriceFor } from "./sizing.js";
import { extractOpenOrders, type TradeCall } from "./trade.js";
import { loadWatchdogState, watchdogEntryBlock, watchdogStatePath } from "./watchdog-state.js";

export type LiveSide = "long" | "short";

/** A candidate the machine wants to trade, before any gate has spoken. */
export type LiveCandidate = {
  pair: string;
  side: LiveSide;
  /** Reference entry price (the touch). */
  entryPrice: number;
  /** Reference stop price. */
  stopPrice: number;
  /** Reference target price. */
  targetPrice: number;
  /** Measured ATR in percent. */
  atrPct: number;
  /** Model consensus score in [-1,1] (positive = long). */
  score: number;
  /** Why the committee/rule layer proposed this. */
  reason: string;
};

export type LiveTicket = {
  candidate: LiveCandidate;
  sizing: SizingDecision;
  /** The exact execute_trade arguments (amount is in BASE units). */
  order: {
    exchange: string;
    pair: string;
    side: "buy" | "sell";
    amount: string;
    /**
     * The order type. "market" for a live entry.
     *
     * WHY A MARKET ENTRY AND NOT A RESTING LIMIT
     * --------------------------------------------
     * The exit legs are venue-native conditionals that attach to a
     * POSITION. With a resting limit entry the position does not exist
     * until the order fills, so there is nothing for a stop to attach
     * to — and the order rests on the book with NO PROTECTION, waiting
     * to become a leveraged naked position the moment price reaches it.
     *
     * That is not hypothetical: a DOT/USDT sell limit was found
     * resting at +1.02% above the market with no stop and no position.
     * A market entry fills immediately, the position exists, and the
     * stop arms in the same breath.
     */
    type: "market" | "limit";
    /**
     * For a MARKET entry: the price the exit legs were derived from.
     * The venue may fill at a different price, and the server rebases
     * the legs onto the actual fill (each keeps its distance from this
     * reference) so a leg can never land on the wrong side of the fill.
     */
    referencePrice?: string;
    /**
     * The reference price — the entry estimate the geometry was derived
     * from, and the price the exit legs are computed against. NOT sent
     * as a limit price; see `type`.
     */
    price: string;
    market: "futures";
    leverage: number;
    marginMode: "isolated";
    /**
     * The identity tag, ON THE ORDER. It is not decoration: without it the
     * venue carries a random UUID and a later session cannot tell this
     * order from another actor's — it classifies the order as
     * foreign/unknown-origin, which is exactly the failure the tagging
     * convention exists to prevent.
     */
    clientOid: string;
    /**
     * The per-INTENT idempotency key. A retry of the same intent carries
     * the same key, so the server dedupes it and never double-fills.
     * Derived from the intent (session+turn+pair+side+size+price), NOT
     * from a timestamp — a timestamp would be different on every retry,
     * which is precisely when the key matters.
     */
    idempotency_key: string;
  };
  /** The venue-native exit legs armed with the entry. */
  exits: { exchange: string; pair: string; slPrice: number; tpPrice: number; market: "futures" };
  /** Identity tag so a later session attributes this order. */
  clientOid: string;
};

export type LiveGate = {
  id: string;
  ok: boolean;
  reason: string;
};

export type LivePreflight = {
  gates: LiveGate[];
  ok: boolean;
  failed: string | null;
};

/**
 * Pure: the pre-flight gates against a live venue read. Kept separate from
 * the network so every gate is unit-testable with fabricated state.
 */
export function preflightGates(input: {
  pair: string;
  hasOpenPosition: boolean;
  openOrderCount: number;
  freeMarginUsd: number;
  requiredMarginUsd: number;
  killSwitchEnabled: boolean;
  dailyLossUsd: number;
  maxDailyLossUsd: number | null;
  dailyTradeCount: number;
  maxTradesPerDay: number | null;
  /** The day's notional already traded — the server's counter. */
  dailyNotionalUsd: number;
  /** The day's notional cap. A NULL cap is the server's FLOOR of $500. */
  maxDailyNotionalUsd: number | null;
  /** The notional this ticket would add to the day. */
  ticketNotionalUsd: number;
  positionNotionalUsd: number;
  maxPositionUsd: number | null;
  /** A target is required — without one the position has no TP leg. */
  hasTarget: boolean;
  /** A stop is required — without one the position has no stop leg. */
  hasStop: boolean;
}): LiveGate[] {
  const g: LiveGate[] = [];
  g.push({
    id: "kill_switch",
    ok: !input.killSwitchEnabled,
    reason: input.killSwitchEnabled ? "kill switch is on — refusing to fire" : "kill switch off",
  });
  g.push({
    id: "has_exit_legs",
    ok: input.hasTarget && input.hasStop,
    reason:
      input.hasTarget && input.hasStop
        ? "take-profit and stop both defined"
        : `missing exit leg: ${!input.hasStop ? "no stop" : ""}${!input.hasStop && !input.hasTarget ? " + " : ""}${!input.hasTarget ? "no take-profit" : ""}`,
  });
  g.push({
    id: "no_open_position",
    ok: !input.hasOpenPosition,
    reason: input.hasOpenPosition ? "a position is already open on this pair" : "no position on this pair",
  });
  g.push({
    id: "no_working_orders",
    ok: input.openOrderCount === 0,
    reason:
      input.openOrderCount === 0
        ? "no working orders"
        : `${input.openOrderCount} working order(s) on this pair — a stale TP/SL keeps working and will fill against the next position`,
  });
  g.push({
    id: "margin_sufficient",
    ok: input.freeMarginUsd >= input.requiredMarginUsd,
    reason: `free $${input.freeMarginUsd.toFixed(2)} vs required $${input.requiredMarginUsd.toFixed(2)}`,
  });
  // THE DAY'S NOTIONAL BUDGET.
  //
  // The server enforces this cap and the client could not see it, so
  // the machine discovered an exhausted budget the expensive way — one
  // live call per candidate. Measured: 19 "Daily notional cap would
  // exceed $500" refusals in 20 minutes, each a full MCP round trip
  // against the shared budget the stop-arming path also needs.
  //
  // A NULL cap is the server's FLOOR of $500, not "unlimited" — the
  // same rule every other null column follows (risk-gate.ts).
  const DAILY_NOTIONAL_FLOOR_USD = 500;
  const dailyNotionalCap = input.maxDailyNotionalUsd ?? DAILY_NOTIONAL_FLOOR_USD;
  g.push({
    id: "daily_notional",
    ok: input.dailyNotionalUsd + input.ticketNotionalUsd <= dailyNotionalCap,
    reason:
      `notional today $${input.dailyNotionalUsd.toFixed(2)} + $${input.ticketNotionalUsd.toFixed(2)}` +
      ` / cap $${dailyNotionalCap.toFixed(2)}`,
  });
  g.push({
    id: "daily_loss",
    ok: input.maxDailyLossUsd == null || input.dailyLossUsd < input.maxDailyLossUsd,
    reason:
      input.maxDailyLossUsd == null
        ? "no daily loss cap"
        : `daily loss $${input.dailyLossUsd.toFixed(2)} / cap $${input.maxDailyLossUsd.toFixed(2)}`,
  });
  g.push({
    id: "daily_trade_count",
    ok: input.maxTradesPerDay == null || input.dailyTradeCount < input.maxTradesPerDay,
    reason:
      input.maxTradesPerDay == null
        ? "no daily trade cap"
        : `trades ${input.dailyTradeCount} / cap ${input.maxTradesPerDay}`,
  });
  g.push({
    id: "position_notional",
    ok: input.maxPositionUsd == null || input.positionNotionalUsd <= input.maxPositionUsd,
    reason:
      input.maxPositionUsd == null
        ? "no position cap"
        : `notional $${input.positionNotionalUsd.toFixed(2)} / cap $${input.maxPositionUsd.toFixed(2)}`,
  });
  return g;
}

/** Pure: fold the gates into one verdict. */
export function foldPreflight(gates: LiveGate[]): LivePreflight {
  const failed = gates.find((g) => !g.ok);
  return { gates, ok: !failed, failed: failed ? `${failed.id}: ${failed.reason}` : null };
}

/**
 * Pure: build the order + exit tickets from a sizing decision. The
 * `amount` here is BASE units — one contract is `contractMultiplier` base
 * units. Getting this wrong is a 100x oversize on a mult-100 contract.
 */
export function buildTicket(
  candidate: LiveCandidate,
  sizing: SizingDecision,
  exchange: string,
  clientOid: string,
  idempotencyKey?: string,
): LiveTicket {
  const side = sizing.side === "long" ? "buy" : "sell";
  const amount = String(sizing.amountBaseUnits);
  const price = String(sizing.entryPrice);
  return {
    candidate,
    sizing,
    order: {
      exchange,
      pair: candidate.pair,
      side,
      amount,
      price,
      // The entry is a MARKET order. The price is the reference the
      // geometry came from, not a resting limit.
      type: "market",
      // The same reference, under the name the server rebases the exit
      // legs from. The venue may fill the entry at a different price, and
      // the legs must follow the ACTUAL fill — otherwise a short whose
      // fill comes in better than the reference ends up with its
      // take-profit ABOVE its own entry, which fires instantly.
      referencePrice: price,
      market: "futures",
      leverage: sizing.leverage,
      marginMode: "isolated",
      clientOid,
      // The key is derived from the intent, so the SAME ticket always
      // produces the SAME key — a retry dedupes instead of double-filling.
      idempotency_key:
        idempotencyKey ??
        makeIdempotencyKey("", "", { pair: candidate.pair, side, amount, price }),
    },
    exits: {
      exchange,
      pair: candidate.pair,
      slPrice: sizing.stopPrice,
      // A target is REQUIRED: without one the position has no take-profit
      // leg and the machine would be running an unbounded hold. The caller
      // refuses such a candidate before it reaches here (the ticket builder
      // asserts it), but the type keeps the requirement explicit.
      tpPrice: sizing.targetPrice ?? sizing.entryPrice,
      market: "futures",
    },
    clientOid,
  };
}

/**
 * Pure: the identity tag on every live order. A later session must be
 * able to attribute an order rather than treat it as unknown-origin —
 * the repo's rule is that an untagged fill looks rogue to the next
 * session even when it was ours.
 */
export function makeClientOid(session: string, turn: string, pair: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  return `jw3-${clean(session)}-${clean(turn)}-${clean(pair.replace("/", ""))}`.slice(0, 36);
}

/**
 * The per-INTENT idempotency key.
 *
 * Derived from the INTENT, never from a timestamp: a retry after a
 * timeout or a reconnect must produce the SAME key, or the server has
 * no way to tell a retry from a new order and a double-fill becomes
 * possible. Two DIFFERENT intents must produce different keys.
 *
 * The key mixes the session/turn (which intent this is) with the
 * trade's own shape (pair, side, size, price) so that a re-plan of the
 * same pair in the same turn is still distinguishable if its size or
 * price changed.
 */
/** The leverage a sized ticket carries, for the idempotency key. */
function ticket0Leverage(sizing: { leverage?: number }): number {
  return Number(sizing.leverage ?? 0);
}

export function makeIdempotencyKey(
  session: string,
  turn: string,
  o: { pair: string; side: "buy" | "sell"; amount: string; price: string; leverage?: number },
): string {
  // ── THE LEVERAGE IS PART OF THE INTENT ──
  //
  // The key mixes the trade's shape so that a RE-PLAN of the same pair
  // in the same turn is distinguishable if anything material changed.
  // The leverage is material: a venue that caps a position at x20
  // instead of the derived x38 changes the margin committed, the
  // liquidation distance, and the risk — it is a DIFFERENT order, not
  // a retry of the same one.
  //
  // Observed live: a candidate that passed every gate and had its
  // leverage reduced 38 -> 20 by the venue's position tier was then
  // DEDUPED by the server's arbiter, because the retry carried the
  // original key (pair/side/amount/price were unchanged). The trade
  // was lost with no order placed — a fully-qualified setup thrown
  // away by the retry machinery itself.
  //
  // A plain retry — same intent, same parameters — still produces the
  // SAME key, which is the whole point of the arbiter.
  const shape = `${o.pair}|${o.side}|${o.amount}|${o.price}|${o.leverage ?? ""}`;
  // FNV-1a: short, stable, and dependency-free. This is a dedupe tag,
  // not a security primitive — it only has to be unique per intent.
  let h = 0x811c9dc5;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const sess = session.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  const trn = turn.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return `jw3-${sess}-${trn}-${h.toString(16).padStart(8, "0")}`.slice(0, 64);
}

/* ------------------------------------------------------------------ */
/* Live reads                                                          */
/* ------------------------------------------------------------------ */

export type LiveAccountState = {
  freeMarginUsd: number;
  equityUsd: number;
  hasOpenPosition: boolean;
  openOrderCount: number;
  killSwitchEnabled: boolean;
  dailyLossUsd: number;
  maxDailyLossUsd: number | null;
  dailyTradeCount: number;
  maxTradesPerDay: number | null;
  /** The day's notional already traded — the server's counter. */
  dailyNotionalUsd: number;
  /** The day's notional cap. A NULL cap is the server's FLOOR of $500. */
  maxDailyNotionalUsd: number | null;
  maxPositionUsd: number | null;
};

/** Read the live account state. READ-ONLY — never places an order. */
export async function readLiveAccountState(
  exchange: string,
  pair: string,
  call: TradeCall,
  pat: string,
  url?: string,
): Promise<LiveAccountState> {
  const [balances, positions, orders, risk] = await Promise.all([
    call("read_live_datum", { exchange, kind: "balances" }, pat, url) as Promise<unknown>,
    call("read_live_datum", { exchange, kind: "positions" }, pat, url) as Promise<unknown>,
    call("list_open_orders", { exchange, pair }, pat, url) as Promise<unknown>,
    call("read_risk_limits", {}, pat, url) as Promise<unknown>,
  ]);

  const b = balances as {
    data?: { accounts?: { futures?: { free?: number; total?: number }[] }; merged?: { free?: number; total?: number }[] };
    venues?: {
      exchange?: string;
      ok?: boolean;
      data?: { accounts?: { futures?: { free?: number; total?: number }[] }; merged?: { free?: number; total?: number }[] };
    }[];
  };
  // The `futures` pocket is the one to read — `merged` mixes spot assets in
  // and is not spendable margin.
  //
  // The shape depends on the caller: the raw MCP tool returns
  // `{kind, venues:[{data:{accounts:{futures:[...]}}}]}` while some
  // callers pass the already-unwrapped `{data:{accounts:{futures:[]}}}`.
  // Reading only ONE of them made equity and free margin silently ZERO —
  // and a zero equity makes the sizing engine refuse every trade, so the
  // whole live path was unreachable for a reason that looked like a
  // risk decision.
  const futures =
    b?.data?.accounts?.futures ??
    b?.venues?.find((v) => v?.ok !== false)?.data?.accounts?.futures ??
    [];
  const freeMarginUsd = futures.reduce((a, x) => a + (Number(x?.free ?? 0) || 0), 0);
  const equityUsd = futures.reduce((a, x) => a + (Number(x?.total ?? 0) || 0), 0);

  // The positions payload arrives as `{kind, venues:[{data:[...]}]}`.
  // Reading only `p.data` saw an ARRAY-LESS object every time, so
  // `rows` was empty and `hasOpenPosition` was ALWAYS false — the live
  // path believed the account was flat even with a position open, and
  // would have stacked a second position on top of the first.
  const p = positions as { data?: unknown; venues?: { ok?: boolean; data?: unknown }[] };
  const rows = Array.isArray(p?.data)
    ? (p.data as unknown[])
    : Array.isArray(p?.venues?.find((v) => v?.ok !== false)?.data)
      ? (p.venues.find((v) => v?.ok !== false)?.data as unknown[])
      : [];
  const hasOpenPosition = rows.some((r) => {
    const sym = String((r as { symbol?: string; pair?: string })?.symbol ?? (r as { pair?: string })?.pair ?? "");
    return sym.toUpperCase().replace(/[^A-Z0-9]/g, "").startsWith(candidateBase(pair));
  });

  const o = orders as unknown;
  const openOrderCount = extractOpenOrders(o).length;

  return {
    freeMarginUsd,
    equityUsd,
    hasOpenPosition,
    openOrderCount,
    ...riskSnapshotFrom(risk),
  };
}

/** The server's risk counters + caps, as every live gate reads them. */
export type RiskSnapshot = Pick<
  LiveAccountState,
  | "killSwitchEnabled"
  | "dailyLossUsd"
  | "maxDailyLossUsd"
  | "dailyTradeCount"
  | "maxTradesPerDay"
  | "dailyNotionalUsd"
  | "maxDailyNotionalUsd"
  | "maxPositionUsd"
>;

/** Pure: a `read_risk_limits` payload → the snapshot the gates read. */
export function riskSnapshotFrom(risk: unknown): RiskSnapshot {
  const r = (risk as { risk_limits?: Record<string, unknown> })?.risk_limits ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    killSwitchEnabled: r.kill_switch_enabled === true,
    dailyLossUsd: num(r.daily_realized_loss_usd) ?? 0,
    maxDailyLossUsd: num(r.max_daily_loss_usd),
    dailyTradeCount: num(r.daily_trade_count) ?? 0,
    maxTradesPerDay: num(r.max_trades_per_day),
    // The day's notional budget, so the gate can refuse an entry the
    // server would refuse — locally, before the call.
    dailyNotionalUsd: num(r.daily_notional_usd) ?? 0,
    maxDailyNotionalUsd: num(r.max_daily_notional_usd),
    maxPositionUsd: num(r.max_position_usd),
  };
}

function candidateBase(pair: string): string {
  return (pair.split("/")[0] ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* ------------------------------------------------------------------ */
/* THE ORDER GATEWAY (OQ-12)                                           */
/* ------------------------------------------------------------------ */
//
// `runLive` is the ONLY code path that places, modifies or cancels a live
// order. Every producer — the live candidate path below, degen, the
// harness, the trade commands, chase, bounce, grid, scalp kill, trail, the
// daemon drain and the watchdog unwind — hands an `OrderDecision` to
// `runLive`, and `sendOrder` is the one function that sends a venue order
// tool. It applies, in this order, for EVERY producer:
//
//   1. paper      — a paper decision never reaches the venue client.
//   2. --yes      — an unconfirmed decision is a preview: nothing is sent.
//   3. kill switch + caps — OPENING orders only (a non-reduce-only
//                   execute_trade): the watchdog's local breaker file, then
//                   the server's kill switch and daily caps through the SAME
//                   `preflightGates` rules the candidate path uses. Risk-
//                   reducing orders (exits, close, cancel) are never
//                   blocked — the unwind must always reach the venue.
//   4. ONE venue call — never retried here. A timeout is ambiguous (the
//                   order may be live), so it surfaces to the producer; any
//                   follow-up is a NEW decision the producer makes
//                   explicitly. The transport never retries order tools
//                   either (mcp.ts NO_RETRY_TOOLS).
//
// Idempotency is the producer's ticket: clientOid / idempotency_key / the
// harness intent ledger travel in `args` byte-for-byte (pinned by
// order-paths-pin.test.ts), so the venue and the server's arbiter see
// exactly what they saw before OQ-12.

/** The venue order tools. */
export type OrderTool = "execute_trade" | "set_exits" | "close_position" | "cancel_order";

/** Who made the decision. */
export type OrderProducer =
  | "live"
  | "degen"
  | "harness"
  | "execute"
  | "close"
  | "exits"
  | "cancel"
  | "cancel-all"
  | "chase"
  | "bounce"
  | "grid"
  | "scalp-kill"
  | "trail"
  | "daemon-drain"
  | "watchdog";

/** One decision = exactly one venue order call (or none, if refused). */
export type OrderDecision = {
  kind: "order";
  producer: OrderProducer;
  tool: OrderTool;
  args: Record<string, unknown>;
  /**
   * The producer's confirmation: `--yes`, or for the autonomous unwinds
   * (watchdog, daemon drain) the arming the operator already gave. False →
   * a preview; nothing is sent.
   */
  yes: boolean;
  /** Paper decisions never reach the venue client. */
  paper?: boolean;
  /**
   * The order's USD notional when the producer SIZED it (the live
   * candidate). Feeds the per-order position + daily-notional caps; absent,
   * those two stay with the server (the only party that computes the venue
   * notional the way it counts it), and the gate checks only that the day's
   * notional budget is not already spent.
   */
  notionalUsd?: number;
};

/**
 * One producer run's gate memo. A producer that sends several opening
 * orders in one run (grid levels, degen's two steps, chase replaces)
 * shares one session, so the server's risk limits are read ONCE per run,
 * not once per order. The watchdog breaker file is re-read on EVERY
 * opening decision, so a trip mid-run blocks the rest of the run.
 */
export type LiveSession = { risk?: RiskSnapshot };

export function liveSession(risk?: RiskSnapshot): LiveSession {
  return risk ? { risk } : {};
}

export type DecisionOpts = {
  pat: string;
  url?: string;
  /** Injected venue client (tests, the offline harness). Default: the order transport. */
  call?: TradeCall;
  session?: LiveSession;
  /** Dir holding watchdog-state.json. Default: the config dir — where the watchdog writes it. */
  watchdogDir?: string;
};

/** Why a decision was not sent. Thrown, so producers treat it as a failed send. */
export class LiveRefusal extends Error {
  readonly status: "paper" | "preview" | "blocked";
  readonly producer: OrderProducer;
  constructor(status: "paper" | "preview" | "blocked", producer: OrderProducer, reason: string) {
    super(reason);
    this.name = "LiveRefusal";
    this.status = status;
    this.producer = producer;
  }
}

/** Observability tap: one record per decision runLive handles. */
export type DecisionRecord = {
  producer: OrderProducer;
  tool: OrderTool;
  status: "sent" | "paper" | "preview" | "blocked";
  reason?: string;
};
let decisionTap: ((d: DecisionRecord) => void) | null = null;

/** Install (or clear, with null) the decision tap. Used by the pin tests. */
export function tapLiveDecisions(fn: ((d: DecisionRecord) => void) | null): void {
  decisionTap = fn;
}

/** Pure: an OPENING order — one that can add exposure. */
export function isOpeningDecision(d: Pick<OrderDecision, "tool" | "args">): boolean {
  return d.tool === "execute_trade" && d.args.reduceOnly !== true && d.args.reduce_only !== true;
}

/** The preflight gates that are account-wide risk caps (not ticket shape). */
const CAP_GATE_IDS = new Set(["kill_switch", "daily_loss", "daily_trade_count", "daily_notional", "position_notional"]);

/**
 * Pure: the kill-switch + caps verdict for one opening order — the SAME
 * `preflightGates` rules the candidate path folds, restricted to the
 * account-wide caps. Null = clear.
 */
export function capsBlock(risk: RiskSnapshot, notionalUsd?: number): string | null {
  const n = notionalUsd != null && Number.isFinite(notionalUsd) && notionalUsd > 0 ? notionalUsd : 0;
  const gates = preflightGates({
    pair: "",
    hasOpenPosition: false,
    openOrderCount: 0,
    freeMarginUsd: 0,
    requiredMarginUsd: 0,
    killSwitchEnabled: risk.killSwitchEnabled,
    dailyLossUsd: risk.dailyLossUsd,
    maxDailyLossUsd: risk.maxDailyLossUsd,
    dailyTradeCount: risk.dailyTradeCount,
    maxTradesPerDay: risk.maxTradesPerDay,
    dailyNotionalUsd: risk.dailyNotionalUsd,
    maxDailyNotionalUsd: risk.maxDailyNotionalUsd,
    maxPositionUsd: risk.maxPositionUsd,
    ticketNotionalUsd: n,
    positionNotionalUsd: n,
    hasTarget: true,
    hasStop: true,
  }).filter((g) => CAP_GATE_IDS.has(g.id));
  const folded = foldPreflight(gates);
  return folded.ok ? null : `risk gate: ${folded.failed}`;
}

/** The kill switch + caps for an opening decision. Null = clear. */
async function entryGate(d: OrderDecision, opts: DecisionOpts, send: TradeCall): Promise<string | null> {
  const breaker = watchdogEntryBlock(loadWatchdogState(watchdogStatePath(opts.watchdogDir)));
  if (breaker) return breaker;
  let risk = opts.session?.risk;
  if (!risk) {
    try {
      risk = riskSnapshotFrom(await send("read_risk_limits", {}, opts.pat, opts.url));
    } catch (e) {
      // A check that cannot run is not a pass: the server refuses to trade
      // on unreadable limits, and so does this gate.
      return `risk limits unreadable (${e instanceof Error ? e.message : String(e)}) — refusing to open blind`;
    }
    if (opts.session) opts.session.risk = risk;
  }
  return capsBlock(risk, d.notionalUsd);
}

/** THE sender: the only function that sends a venue order tool. */
async function sendOrder(d: OrderDecision, opts: DecisionOpts): Promise<unknown> {
  const refuse = (status: "paper" | "preview" | "blocked", reason: string): never => {
    decisionTap?.({ producer: d.producer, tool: d.tool, status, reason });
    throw new LiveRefusal(status, d.producer, reason);
  };
  if (!ORDER_TOOLS.has(d.tool)) refuse("blocked", `${String(d.tool)} is not a venue order tool`);
  if (d.paper === true) refuse("paper", "paper decision — never sent to the venue");
  if (d.yes !== true) refuse("preview", "not confirmed (--yes) — nothing sent");
  // Reads for the gate go through the injected client when there is one
  // (tests, the harness), else the generic (read) transport.
  const read: TradeCall = opts.call ?? (callTool as unknown as TradeCall);
  if (isOpeningDecision(d)) {
    const block = await entryGate(d, opts, read);
    if (block) refuse("blocked", block);
  }
  decisionTap?.({ producer: d.producer, tool: d.tool, status: "sent" });
  const send: TradeCall = opts.call ?? (callOrderTool as unknown as TradeCall);
  return send(d.tool, d.args, opts.pat, opts.url);
}

const isOrderDecision = (x: LiveArgs | OrderDecision): x is OrderDecision =>
  (x as { kind?: unknown }).kind === "order";

/* ------------------------------------------------------------------ */
/* The live path                                                       */
/* ------------------------------------------------------------------ */

export type LiveArgs = {
  exchange: string;
  candidate: LiveCandidate;
  /** Risk budget as a percent of equity. Default 3. */
  riskPctOfEquity?: number;
  /** Venue max leverage for the contract (null = unknown → hard cap). */
  venueMaxLeverage?: number | null;
  /** Maintenance margin rate (decimal). */
  maintenanceMarginRate?: number;
  /** Fee schedule. */
  makerFeePct?: number;
  takerFeePct?: number;
  session: string;
  turn: string;
  nowMs?: number;
};

export type LiveResult = {
  status: "no-trade" | "preview" | "fired" | "failed";
  reason: string;
  ticket: LiveTicket | null;
  preflight: LivePreflight | null;
  orderId?: string;
  tpArmed?: boolean;
  stopArmed?: boolean;
  /**
   * True when the entry could not be protected and the position was
   * closed rather than left naked. A failure that ends FLAT is a
   * different outcome from one that leaves a leveraged position with no
   * stop, and the caller must be able to tell them apart.
   */
  flattened?: boolean;
  /**
   * True when the failure was a RATE LIMIT — a refusal that happened
   * BEFORE dispatch, so no order was placed and the trade can be
   * retried once the window passes. Distinct from a venue rejection,
   * which may or may not have dispatched.
   */
  retryable?: boolean;
  /**
   * What the venue actually shows after the fire. `null` means the
   * verification read itself failed (typically throttled) — the trade is
   * live but the state is UNCONFIRMED, which is a different thing from
   * "no position and no orders".
   */
  verified?: { positionRows: number; openOrderRows: number } | null;
  /**
   * The outcome of the realized-P&L reconciliation that runs after the
   * fire. A trade closed by the VENUE's own stop never goes through the
   * close path, so without this the daily loss cap can never fire on it.
   */
  reconciled?: { counted: number; lossRecordedUsd: number; alreadyCounted: number } | null;
};

/**
 * The live path. Gates in order, then fire, then VERIFY against the venue.
 *
 * `call` is injected so the whole path is testable without a network and
 * without money.
 */

/**
 * Count the venue's realized LOSSES against the daily risk counters.
 *
 * The daily loss cap is enforced from the server's realized-loss counter,
 * which the CLOSE path increments. A trade closed by the VENUE's own stop
 * — the normal way a losing trade closes — never goes through it, so the
 * loss has to be counted from the venue, which is the book of record.
 *
 * The server's reconciler is idempotent (each venue trade is counted
 * exactly once, tracked in a ledger), so this can run as often as it
 * likes.
 *
 * A failed reconcile is reported, never thrown: the trade is already
 * done, and a failure to COUNT a loss must not be reported as a failure
 * to TRADE.
 */

/**
 * The tool's payload, from either the unwrapped object or the raw MCP
 * envelope (`{content:[{type:"text",text:"{...}"}]}`).
 */
function unwrapToolPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const text = ((raw as { content: Array<{ text?: unknown }> }).content ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through to the generic path
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as unknown;
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }
  return {};
}

async function reconcileRealizedPnl(
  exchange: string,
  call: TradeCall,
  pat: string,
  url?: string,
): Promise<{ counted: number; lossRecordedUsd: number; alreadyCounted: number } | null> {
  try {
    const raw = await call("reconcile_realized_pnl", { exchange, days: 2 }, pat, url);
    // callTool already unwraps the MCP envelope into the parsed payload,
    // but a caller may hand back the raw envelope. Accept both.
    const parsed = unwrapToolPayload(raw);
    return {
      counted: Number(parsed.counted ?? 0),
      lossRecordedUsd: Number(parsed.lossRecordedUsd ?? 0),
      alreadyCounted: Number(parsed.alreadyCounted ?? 0),
    };
  } catch {
    // A reconcile that cannot run leaves the counter as it was. The next
    // fire reconciles again, and the server's ledger keeps it idempotent.
    return null;
  }
}

export type LiveOpts = {
  yes: boolean;
  json: boolean;
  pat?: string;
  url?: string;
  call?: TradeCall;
  /**
   * The contract spec reader. Injected so the live path is testable
   * offline and DETERMINISTIC — a live fetch in a test makes the suite
   * flaky and, worse, a flaky test on a fund-moving path is a test
   * nobody trusts.
   */
  contractSpec?: (base: string) => Promise<{ multiplier: number; tick: number }>;
  /** Dir holding watchdog-state.json (default: the config dir). */
  watchdogDir?: string;
};

/**
 * THE live order path (OQ-12). Two kinds of input:
 *   - a scalp CANDIDATE (`LiveArgs`): size → preflight → fire → protect →
 *     verify, every venue order of it a decision through `sendOrder`;
 *   - an `OrderDecision` from any other producer: gated and sent as exactly
 *     one venue call. Resolves to the venue's answer; a refusal (paper,
 *     preview, kill switch, caps) throws `LiveRefusal` with nothing sent,
 *     and a venue error propagates untouched (never retried here).
 */
// The candidate overload is LAST on purpose: `Parameters<typeof runLive>`
// resolves to the last signature, and callers type candidate args with it.
export async function runLive(d: OrderDecision, opts: DecisionOpts): Promise<unknown>;
export async function runLive(a: LiveArgs, opts: LiveOpts): Promise<LiveResult>;
export async function runLive(a: LiveArgs | OrderDecision, opts: LiveOpts | DecisionOpts): Promise<unknown> {
  if (isOrderDecision(a)) return sendOrder(a, opts as DecisionOpts);
  return runCandidate(a, opts as LiveOpts);
}

async function runCandidate(a: LiveArgs, opts: LiveOpts): Promise<LiveResult> {
  const call = opts.call ?? (callTool as unknown as TradeCall);
  const pat = resolvePat(opts.pat);
  if (!pat) return { status: "no-trade", reason: "not authenticated — no PAT", ticket: null, preflight: null };

  const base = candidateBase(a.candidate.pair);
  if (!base) return { status: "no-trade", reason: "pair required (e.g. SOL/USDT)", ticket: null, preflight: null };

  // ── 4. SIZING ──
  let spec: { multiplier: number; tick: number };
  try {
    spec = await (opts.contractSpec ?? futuresContractSpec)(base);
  } catch (e) {
    return { status: "no-trade", reason: `contract spec unreadable: ${e instanceof Error ? e.message : String(e)}`, ticket: null, preflight: null };
  }

  const state = await readLiveAccountState(a.exchange, a.candidate.pair, call, pat, opts.url);

  // ── THE TAKE-PROFIT MUST BE BEYOND THE MARKET ──
  //
  // A take-profit that is ALREADY SATISFIED at the market is a
  // MARKETABLE order: it fills instantly at the touch, so the trade
  // closes in seconds and books a fee instead of a target.
  //
  // This is not hypothetical. The live path used to derive the target
  // from the ladder's offset average entry, which for a short sits
  // ABOVE the market, so the target sat above the market and every
  // short's "take-profit" was a marketable buy at the ask. Measured
  // live on 2026-10-21: 6 of the 8 real round trips were scratches,
  // closing in 4-7 seconds, net -$0.5708 on $0.5672 of fees.
  //
  // The server cannot catch this: it only sees the ticket's prices, and
  // by the time the entry has filled the position is real and the
  // target's relation to the MARKET is already decided. So the guard
  // belongs here, at planning time, where the market price is known.
  //
  // The stop is on the ADVERSE side, so it can never be on the wrong
  // side of the market — a stop that is wrong-sided is a different
  // defect (and the server refuses it).
  {
    const { entryPrice, targetPrice, stopPrice, side } = a.candidate;
    const isLong = side === "long";
    if (Number.isFinite(targetPrice) && Number.isFinite(entryPrice) && entryPrice > 0) {
      const tpSatisfiedAtMarket = isLong ? targetPrice <= entryPrice : targetPrice >= entryPrice;
      if (tpSatisfiedAtMarket) {
        const msg =
          `no trade: the take-profit ${targetPrice} is already satisfied at the market ${entryPrice} for a ${side} — ` +
          `it would fill instantly at the touch and close the position for a fee. ` +
          `The target must be ${isLong ? "ABOVE" : "BELOW"} the market.`;
        return { status: "no-trade", reason: msg, ticket: null, preflight: null };
      }
    }
    if (Number.isFinite(stopPrice) && Number.isFinite(entryPrice) && entryPrice > 0) {
      const stopSatisfiedAtMarket = isLong ? stopPrice >= entryPrice : stopPrice <= entryPrice;
      if (stopSatisfiedAtMarket) {
        const msg =
          `no trade: the stop ${stopPrice} is on the wrong side of the market ${entryPrice} for a ${side} — ` +
          `it would trigger instantly. The stop must be ${isLong ? "BELOW" : "ABOVE"} the market.`;
        return { status: "no-trade", reason: msg, ticket: null, preflight: null };
      }
    }
  }

  const proposal: SizingProposal = {
    pair: a.candidate.pair,
    side: a.candidate.side,
    entryPrice: a.candidate.entryPrice,
    stopPrice: a.candidate.stopPrice,
    targetPrice: a.candidate.targetPrice,
    contractMultiplier: spec.multiplier,
    tickSize: spec.tick,
    maintenanceMarginRate: a.maintenanceMarginRate,
    venueMaxLeverage: a.venueMaxLeverage ?? null,
    atrPct: a.candidate.atrPct,
    equityUsd: state.equityUsd,
    freeMarginUsd: state.freeMarginUsd,
    riskPctOfEquity: a.riskPctOfEquity,
    // The server's position cap is fed INTO the sizing engine so the size
    // is clamped to fit it. Sizing blind to the cap produces a ticket the
    // preflight then rejects — the trade dies for a reason the operator
    // never sees. The cap is an exposure ceiling, not a veto.
    maxNotionalUsd: state.maxPositionUsd,
    feeSchedule: {
      makerRate: (a.makerFeePct ?? 0.02) / 100,
      takerRate: (a.takerFeePct ?? 0.06) / 100,
      // ── THE ENTRY IS A MARKET ORDER, SO THE ENTRY LEG IS A TAKER ──
      //
      // The old comment here said "a resting limit is a maker entry" —
      // but the live path places a MARKET order (the exit legs are
      // venue-native conditionals that need a POSITION to attach to,
      // so a resting entry could never be protected). The comment
      // outlived the code.
      //
      // The venue settled the question: every fill in the live account
      // charged EXACTLY 0.0600% — the taker rate — on BOTH legs,
      // including the exits (a take-profit trigger becomes a market
      // order when it fires). So the true round trip is 0.12%, not
      // the 0.08% this schedule told the sizing engine.
      //
      // That is a THIRD too little fee in the fee-floor gate, so the
      // engine under-widened the stop and under-reported the drag on
      // every ticket it sized.
      entryLeg: "taker",
      exitLeg: "taker",
    },
  };
  const sizing = sizeTrade(proposal);
  if (!sizing || sizing.status !== "ok") {
    return {
      status: "no-trade",
      reason: sizing?.reason ?? "sizing produced no decision",
      ticket: null,
      preflight: null,
    };
  }

  const clientOid = makeClientOid(a.session, a.turn, a.candidate.pair);
  // The key is a FUNCTION of the ticket's parameters, so a change to
  // any of them produces a new key — and the leverage retry below
  // recomputes it, because a different leverage is a DIFFERENT intent.
  const idemKeyFor = (lev: number): string =>
    makeIdempotencyKey(a.session, a.turn, {
      pair: a.candidate.pair,
      side: sizing.side === "long" ? "buy" : "sell",
      amount: String(sizing.amountBaseUnits),
      price: String(sizing.entryPrice),
      leverage: lev,
    });
  const idemKey = idemKeyFor(ticket0Leverage(sizing));
  const ticket = buildTicket(a.candidate, sizing, a.exchange, clientOid, idemKey);

  // ── 5. PRE-FLIGHT (live venue reads) ──
  const pre = foldPreflight(
    preflightGates({
      pair: a.candidate.pair,
      hasOpenPosition: state.hasOpenPosition,
      openOrderCount: state.openOrderCount,
      freeMarginUsd: state.freeMarginUsd,
      requiredMarginUsd: sizing.marginRequiredUsd,
      killSwitchEnabled: state.killSwitchEnabled,
      dailyLossUsd: state.dailyLossUsd,
      maxDailyLossUsd: state.maxDailyLossUsd,
      dailyTradeCount: state.dailyTradeCount,
      maxTradesPerDay: state.maxTradesPerDay,
      dailyNotionalUsd: state.dailyNotionalUsd,
      maxDailyNotionalUsd: state.maxDailyNotionalUsd,
      ticketNotionalUsd: sizing.notionalUsd,
      positionNotionalUsd: sizing.notionalUsd,
      maxPositionUsd: state.maxPositionUsd,
      hasTarget: sizing.targetPrice != null,
      hasStop: sizing.stopPrice > 0,
    }),
  );
  if (!pre.ok) {
    return { status: "no-trade", reason: `preflight: ${pre.failed}`, ticket, preflight: pre };
  }

  if (!opts.yes) {
    return {
      status: "preview",
      reason: "dry run — nothing sent",
      ticket,
      preflight: pre,
    };
  }

  // ── 6. FIRE ──
  //
  // Every venue order below is a decision through `sendOrder` — the same
  // gate every producer passes. The session carries the risk snapshot the
  // preflight just read, so the gate re-checks the same caps without a
  // second read, and adds the watchdog's breaker.
  const orders: DecisionOpts = { pat, url: opts.url, call: opts.call, session: liveSession(state), watchdogDir: opts.watchdogDir };
  const decide = (tool: OrderTool, args: Record<string, unknown>, notionalUsd?: number): OrderDecision => ({
    kind: "order",
    producer: "live",
    tool,
    args,
    yes: opts.yes,
    ...(notionalUsd != null ? { notionalUsd } : {}),
  });
  let orderId = "";
  let deduped = false;
  const placeOrder = async (): Promise<void> => {
    // THE ACTOR: this command is the MACHINE's live path, so the order
    // is the machine's. The account is shared — the owner trades the same
    // account through the app — and without the actor the reconciler
    // cannot tell the machine's trades from the owner's, so the owner's
    // losses are booked against the machine's daily loss cap.
    const out = (await sendOrder(
      decide("execute_trade", { ...(ticket.order as unknown as Record<string, unknown>), actor: "machine" }, ticket.sizing.notionalUsd),
      orders,
    )) as {
      orderId?: string;
      status?: string;
      deduped?: boolean;
    };
    orderId = String(out?.orderId ?? "");
    // A DEDUPED submit is NOT a fire. The server's arbiter matched the
    // intent's idempotency key to an EARLIER submit and deliberately
    // did NOT dispatch again. It answers with an empty orderId.
    //
    // Treating that empty orderId as a success is how a caller ends up
    // reporting "fired + exits armed" for a trade that never happened.
    deduped = out?.deduped === true || (out?.status === "deduped" && !orderId);
  };
  try {
    await placeOrder();
    if (deduped) {
      // The same intent was already submitted. Verify what the venue
      // actually holds before saying anything about it.
      const after = await readLiveAccountState(a.exchange, a.candidate.pair, call, pat, opts.url);
      return {
        status: "no-trade",
        reason: `the server DEDUPED this intent (the same idempotency key was already submitted) — nothing was dispatched this time. The venue currently shows ${after.openOrderCount} open order(s) and ${after.hasOpenPosition ? "a position" : "no position"} on this pair.`,
        ticket,
        preflight: pre,
        orderId,
      };
    }
  } catch (e) {
    // Refused by the gate (watchdog breaker): nothing was sent.
    if (e instanceof LiveRefusal) return { status: "no-trade", reason: e.message, ticket, preflight: pre };
    const why = e instanceof Error ? e.message : String(e);
    // The venue's leverage limit is PER POSITION TIER, not a property of
    // the contract: a $56 position on KuCoin can carry at most x20 even
    // though the contract record advertises 75. The sizing engine derives
    // the leverage it wants from the stop distance; the venue may want
    // less. "Less" is safe — it means more margin, not more risk — so the
    // path takes the venue's number and tries again rather than dying.
    const m = /leverage cannot exceed (\d+)/i.exec(why);
    if (m) {
      const venueMax = Number(m[1]);
      if (Number.isFinite(venueMax) && venueMax > 0 && venueMax < ticket.order.leverage) {
        const before = ticket.order.leverage;
        ticket.order.leverage = venueMax;
        ticket.sizing.leverage = venueMax;
        // A DIFFERENT leverage is a DIFFERENT intent — different margin,
        // different liquidation distance, different risk. The retry
        // must carry a NEW idempotency key, or the server's arbiter
        // dedupes it against the attempt that was just rejected and the
        // trade is lost with no order placed.
        ticket.order.idempotency_key = idemKeyFor(venueMax);
        // The margin a lower leverage needs is more: margin = notional /
        // leverage. The account has it; if it does not, the next
        // preflight will say so.
        ticket.sizing.marginRequiredUsd = ticket.sizing.notionalUsd / venueMax;
        // A lower leverage pushes the liquidation price FURTHER away, so
        // the ticket must say so — a stale liquidation price would
        // understate the distance and the preflight would be reading a
        // number the venue never accepted.
        const liq = liquidationPriceFor(ticket.sizing.entryPrice, ticket.sizing.side, venueMax, 0.005);
        ticket.sizing.liquidationPrice = liq;
        ticket.sizing.liquidationDistancePct =
          Math.abs((liq - ticket.sizing.entryPrice) / ticket.sizing.entryPrice) * 100;
        ticket.sizing.warnings = [
          ...(ticket.sizing.warnings ?? []),
          `the venue caps this position at x${venueMax} (position tier) — leverage reduced from x${before}`,
        ];
        try {
          await placeOrder();
          if (deduped) {
            const after = await readLiveAccountState(a.exchange, a.candidate.pair, call, pat, opts.url);
            return {
              status: "no-trade",
              reason: `the server DEDUPED this intent at the venue's leverage cap — nothing was dispatched. The venue shows ${after.openOrderCount} open order(s) and ${after.hasOpenPosition ? "a position" : "no position"} on this pair.`,
              ticket,
              preflight: pre,
              orderId,
            };
          }
        } catch (e2) {
          // ── THE CAUSE MUST BE NAMED, NOT ASSUMED ──
          //
          // This branch is reached after a LEVERAGE-CAP adjustment, so
          // the old code assumed every error here was the leverage cap.
          // Observed live: a `rate_limited` refusal was reported as
          // "entry failed at the venue's own leverage cap (x20)" — a
          // throttle dressed up as a venue cap, which points the
          // operator at the wrong thing entirely (the leverage was
          // never the problem, and no order was placed).
          //
          // The throttle is not merely mislabelled: it is a
          // DEFINITIVELY-BEFORE-DISPATCH refusal, so nothing was
          // placed and the trade can be retried after the window.
          const msg = e2 instanceof Error ? e2.message : String(e2);
          const throttled = /rate[_ ]?limit|too many requests/i.test(msg);
          return {
            status: "failed",
            reason: throttled
              ? `entry was REFUSED before dispatch by the server's rate limit — no order was placed and the trade can be retried: ${msg}`
              : `entry failed at the venue's own leverage cap (x${venueMax}): ${msg}`,
            retryable: throttled,
            ticket,
            preflight: pre,
          };
        }
      } else {
        return {
          status: "failed",
          reason: `entry failed: ${why}`,
          // A throttle is a DEFINITIVELY-BEFORE-DISPATCH refusal, so
          // nothing was placed and the trade can be retried. Say so
          // in the same shape the leverage-cap path uses.
          retryable: /rate[_ ]?limit|too many requests/i.test(why),
          ticket,
          preflight: pre,
        };
      }
    } else {
      // A throttle is a refusal BEFORE dispatch: nothing was placed
      // and the trade can be retried once the window passes. It is
      // not a venue fault, and it must not be recorded as one.
      const throttled = /rate[_ ]?limit|too many requests/i.test(why);
      return {
        status: "failed",
        reason: throttled
          ? `entry was REFUSED before dispatch by the server's rate limit — no order was placed and the trade can be retried: ${why}`
          : `entry failed: ${why}`,
        retryable: throttled,
        ticket,
        preflight: pre,
      };
    }
  }

  // The exit legs ride the entry as venue-native orders. If the TP arm
  // fails the position is live UNPROTECTED — say so loudly rather than
  // reporting a success.
  let tpArmed = false;
  let stopArmed = false;
  try {
    // The referencePrice is the price the legs were DERIVED FROM. The
    // server rebases them onto the position's ACTUAL entry, so a fill
    // that came in better than the reference cannot leave the
    // take-profit on the wrong side of the entry — where its trigger is
    // already satisfied and it closes the position instantly for a fee.
    //
    // Observed live on 2026-10-21: an AVAX short whose reference was
    // 9.7895 filled at 9.754, so the take-profit (0.32% below the
    // reference) sat 0.04% ABOVE the fill and the st-order filled
    // instantly, closing the position 7 seconds after opening.
    await sendOrder(
      decide("set_exits", { ...(ticket.exits as unknown as Record<string, unknown>), referencePrice: ticket.sizing.entryPrice }),
      orders,
    );
    tpArmed = true;
    stopArmed = true;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A throttled exit is the worst case: the position is live with no
    // stop. The FIRST thing to try is to arm the exit again — the
    // throttle is transient and the position is on the clock. Only if
    // that also fails do we flatten.
    let retried = false;
    let retryWhy = "";
    try {
      await sendOrder(
        decide("set_exits", { ...(ticket.exits as unknown as Record<string, unknown>), referencePrice: ticket.sizing.entryPrice }),
        orders,
      );
      tpArmed = true;
      stopArmed = true;
      retried = true;
    } catch (e2) {
      retryWhy = e2 instanceof Error ? e2.message : String(e2);
    }
    if (!retried) {
      // The exit cannot be armed. A naked leveraged position is not an
      // acceptable end state, so the position is closed — the plan
      // (entry + stop + target) was never completed, and an unstopped
      // position is a bigger risk than the missed trade.
      let flattened = false;
      let flatWhy = "";
      try {
        await sendOrder(
          decide("close_position", { exchange: a.exchange, pair: a.candidate.pair, side: a.candidate.side }),
          orders,
        );
        flattened = true;
      } catch (e3) {
        flatWhy = e3 instanceof Error ? e3.message : String(e3);
      }
      return {
        status: "failed",
        reason: `exit legs failed (position live UNPROTECTED): ${why}. Retry: ${retryWhy}. Flatten attempt: ${flattened ? "OK — the position was closed" : `FAILED — ${flatWhy}`}.`,
        ticket,
        preflight: pre,
        orderId,
        tpArmed,
        stopArmed,
        flattened,
      };
    }
  }

  // ── 7. VERIFY (the venue is the book of record) ──
  //
  // A throttled VERIFY must not turn a successful fire into a failure.
  // The trade is already done at this point: the entry is filled and the
  // exits are armed. If the read that confirms it is rate limited, the
  // right answer is "fired, verification incomplete" — not "failed",
  // which would tell the operator the opposite of the truth about a
  // leveraged position.
  try {
    const after = await readLiveAccountState(a.exchange, a.candidate.pair, call, pat, opts.url);
    // ── 7b. RECONCILE THE REALIZED P&L ──
    //
    // The daily loss cap is enforced from the server's realized-loss
    // counter, which the CLOSE path increments. A trade closed by the
    // VENUE's own stop — the normal way a losing trade closes — never
    // goes through it. So the loss has to be counted from the venue,
    // which is the book of record.
    //
    // This MUST NOT turn a fired trade into a failure: the trade is
    // already done. A failed reconcile is reported, not thrown.
    const reconciled = await reconcileRealizedPnl(a.exchange, call, pat, opts.url);
    return {
      status: "fired",
      reason: "fired + exits armed",
      ticket,
      preflight: pre,
      orderId,
      tpArmed,
      stopArmed,
      verified: { positionRows: after.hasOpenPosition ? 1 : 0, openOrderRows: after.openOrderCount },
      reconciled,
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      status: "fired",
      reason: `fired + exits armed — the VERIFICATION read was throttled (${why}), so the venue state is unconfirmed. The trade IS live and protected; reconcile with the venue before drawing a conclusion.`,
      ticket,
      preflight: pre,
      orderId,
      tpArmed,
      stopArmed,
      verified: null,
    };
  }
}
