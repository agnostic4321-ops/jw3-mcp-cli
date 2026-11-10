/**
 * Ticket builders + validators (split from trade.ts). Pure functions only:
 * the SINGLE construction site for every fund-moving ticket. Preview and
 * fire both go through these, so a dry run cannot diverge from --yes.
 */
export type ExecuteTpLeg = { price: number; share: number };

/**
 * ACTOR MAP: every fund-moving `execute_trade` call claims its author.
 *
 * - Machine-originated strategy paths (live fire, degen fire, grid start,
 *   bounce trigger) send actor "machine". These orders are placed by an
 *   automated loop, and without the claim the reconciler books them
 *   against the owner's manual trading on the same shared account.
 * - Interactive one-shot paths (`execute`, including its `--chase` mode)
 *   send the operator's actor: the explicit `--actor` value when given,
 *   otherwise the field is omitted and the server attributes the call to
 *   the authenticated PAT subject (the human at the keyboard). The server
 *   default is unchanged; the client never assumes a value for it.
 * - Protective/unwind calls (`close_position`, `cancel_order`, `set_exits`)
 *   carry no actor claim: they reduce or arm existing exposure rather than
 *   opening a new attributed position, so the server-side caller
 *   attribution stands.
 */
export const ACTOR_MACHINE = "machine";

export type ExecuteArgs = {
  /**
   * Explicit actor for this ticket. Machine strategy paths pass "machine";
   * interactive paths pass the operator's `--actor`. Omit it and the field
   * stays off the wire (the server attributes the call to the
   * authenticated subject).
   */
  actor?: string;
  /**
   * The per-INTENT idempotency key. A retry of the same intent carries
   * the same key, so the server dedupes it instead of double-filling.
   * Omit it and the builder derives one from the intent (see
   * `makeIntentKey`); an explicit value always wins.
   */
  idempotencyKey?: string;

  exchange: string;
  pair: string;
  side: string;
  amount?: number;
  price?: number;
  market?: string;
  leverage?: number;
  marginMode?: string;
  stop?: number;
  tp?: number;
  tpLegs?: ExecuteTpLeg[];
  riskUsd?: number;
};

export function parseTpLegsFlag(raw: string | undefined): { legs?: ExecuteTpLeg[]; error?: string } {
  if (raw === undefined) return {};
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    return { error: "tp-legs expects 1..3 comma-separated price:share pairs (e.g. 75000:50,80000:50)" };
  }
  const legs: ExecuteTpLeg[] = [];
  for (const part of parts) {
    const [pxRaw, shRaw] = part.split(":");
    const price = Number(pxRaw);
    const share = shRaw === undefined || shRaw === "" ? Math.floor(100 / parts.length) : Number(shRaw);
    if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(share) || !(share > 0) || share > 100) {
      return { error: `invalid tp-legs entry "${part}" — expected price:share with price > 0 and share in (0, 100]` };
    }
    legs.push({ price, share });
  }
  return { legs };
}

export function validateExecute(a: ExecuteArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair) return "pair required (e.g. BTC/USDT)";
  if (!["buy", "sell"].includes(a.side.toLowerCase())) return "side must be buy|sell";
  const hasAmount = a.amount !== undefined;
  const hasRisk = a.riskUsd !== undefined;
  if (hasAmount && hasRisk) return "pass --amount or --risk-usd, not both";
  if (!hasAmount && !hasRisk) return "pass --amount (base units) or --risk-usd (sizes from stop)";
  if (hasAmount && (!Number.isFinite(a.amount) || (a.amount as number) <= 0)) return "amount must be > 0";
  if (hasRisk && (!Number.isFinite(a.riskUsd) || (a.riskUsd as number) <= 0)) return "risk-usd must be > 0";
  if (a.price !== undefined && (!Number.isFinite(a.price) || a.price <= 0)) return "price must be > 0 (omit for market)";
  if (a.market !== undefined && !["spot", "futures"].includes(a.market.toLowerCase())) {
    return "market must be spot|futures";
  }
  if (a.leverage !== undefined && (!Number.isFinite(a.leverage) || a.leverage <= 0)) return "leverage must be > 0";
  if (a.marginMode !== undefined && !["cross", "isolated"].includes(a.marginMode.toLowerCase())) {
    return "margin-mode must be cross|isolated";
  }
  if (a.actor !== undefined && a.actor.trim() !== "" && !["machine", "owner"].includes(a.actor.trim().toLowerCase())) {
    return "actor must be machine|owner";
  }
  if (a.stop !== undefined && (!Number.isFinite(a.stop) || a.stop <= 0)) return "stop must be > 0";
  if (a.tp !== undefined && (!Number.isFinite(a.tp) || a.tp <= 0)) return "tp must be > 0";
  if (a.tp !== undefined && a.tpLegs && a.tpLegs.length > 0) return "pass --tp or --tp-legs, not both";
  if (a.tpLegs !== undefined) {
    if (a.tpLegs.length === 0 || a.tpLegs.length > 3) return "tp-legs must have 1..3 legs";
    for (const l of a.tpLegs) {
      if (!Number.isFinite(l.price) || l.price <= 0) return "tp-legs price must be > 0";
      if (!Number.isFinite(l.share) || l.share <= 0 || l.share > 100) return "tp-legs share must be in (0, 100]";
    }
  }
  return null;
}

/** Injectable MCP call (tests spy on it; prod passes callTool). */
export type TradeCall = (
  name: string,
  args: Record<string, unknown>,
  pat: string,
  url?: string,
) => Promise<unknown>;

export type TradeDeps = { call?: TradeCall };

/**
 * Pure ticket builders — the SINGLE construction site for every fund-moving
 * ticket. Preview (dry run) and fire (--yes) both go through these, so the
 * dry run literally cannot diverge from what --yes would send. Covered by
 * dry-run parity tests: same input → same toolArgs, zero calls without --yes.
 */

/**
 * Per-INTENT idempotency key for builders that carry no session/turn
 * (the live path scopes its key by session+turn; see live.ts
 * `makeIdempotencyKey`). Derived from the intent's own shape, never from a
 * timestamp: a retry after a timeout reproduces the SAME key, so the
 * server dedupes instead of double-filling. Two DIFFERENT intents must
 * produce different keys, hence the per-builder namespace.
 */
export function makeIntentKey(namespace: string, shape: string): string {
  const clean = String(namespace ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 12);
  // FNV-1a: short, stable, dependency-free. A dedupe tag, not a security
  // primitive: it only has to be unique per intent.
  let h = 0x811c9dc5;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `jw3-${clean}-${h.toString(16).padStart(8, "0")}`.slice(0, 64);
}

export function executeToolArgs(a: ExecuteArgs): Record<string, unknown> {
  const toolArgs: Record<string, unknown> = {
    exchange: a.exchange,
    pair: a.pair,
    side: a.side.toLowerCase(),
  };
  if (a.amount !== undefined) toolArgs.amount = String(a.amount);
  if (a.price !== undefined) toolArgs.price = String(a.price);
  if (a.market) toolArgs.market = a.market.toLowerCase();
  if (a.leverage !== undefined) toolArgs.leverage = a.leverage;
  if (a.marginMode) toolArgs.marginMode = a.marginMode.toLowerCase();
  if (a.stop !== undefined) toolArgs.stop = a.stop;
  if (a.tp !== undefined) toolArgs.tp = a.tp;
  if (a.tpLegs !== undefined && a.tpLegs.length > 0) toolArgs.tpLegs = a.tpLegs;
  if (a.riskUsd !== undefined) toolArgs.risk_usd = a.riskUsd;
  // The per-INTENT idempotency key. A retry of the SAME intent carries
  // the SAME key, so the server dedupes it and never double-fills. The
  // client owns the key's uniqueness; the server owns the dedupe.
  //
  // An explicit key always wins (the manual `--idempotency-key` override).
  // Otherwise the builder derives one from the intent's own shape, so a
  // retried command reproduces the same key without the operator pasting
  // anything. Derived from intent fields only, never a timestamp.
  if (a.idempotencyKey !== undefined && a.idempotencyKey.trim() !== "") {
    toolArgs.idempotency_key = a.idempotencyKey.trim();
  } else {
    const legs = (a.tpLegs ?? []).map((l) => `${l.price}:${l.share}`).join(",");
    toolArgs.idempotency_key = makeIntentKey(
      "ex",
      [
        a.exchange, a.pair, a.side.toLowerCase(),
        a.amount ?? "", a.price ?? "", a.market?.toLowerCase() ?? "",
        a.leverage ?? "", a.marginMode?.toLowerCase() ?? "",
        a.stop ?? "", a.tp ?? "", legs, a.riskUsd ?? "",
      ].join("|"),
    );
  }
  // Explicit actor only (see ACTOR MAP above). Machine paths pass
  // "machine"; interactive paths pass the operator's --actor. Omitted here
  // means omitted on the wire: the server attributes the call to the
  // authenticated subject. Lowercased: the server enum is exact-match
  // machine|owner (see validateActor), so "Owner" rides as "owner".
  if (a.actor !== undefined && a.actor.trim() !== "") {
    toolArgs.actor = a.actor.trim().toLowerCase();
  }
  return toolArgs;
}

export function closeToolArgs(o: { exchange: string; pair: string; side: string; size?: number }): Record<string, unknown> {
  return {
    exchange: o.exchange,
    pair: o.pair,
    side: o.side.toLowerCase(),
    ...(o.size !== undefined ? { size: String(o.size) } : {}),
  };
}

export function exitsToolArgs(o: {
  exchange: string;
  pair: string;
  sl?: number;
  tp?: number;
  market?: string;
  quantity?: number;
}): Record<string, unknown> {
  return {
    exchange: o.exchange,
    pair: o.pair,
    ...(o.sl != null ? { slPrice: o.sl } : {}),
    ...(o.tp != null ? { tpPrice: o.tp } : {}),
    ...(o.market ? { market: o.market.toLowerCase() } : {}),
    ...(o.quantity != null ? { quantity: o.quantity } : {}),
  };
}

export function cancelToolArgs(o: {
  exchange: string;
  orderId: string;
  pair?: string;
  market?: string;
}): Record<string, unknown> {
  return {
    exchange: o.exchange,
    orderId: o.orderId,
    ...(o.pair ? { pair: o.pair } : {}),
    ...(o.market ? { market: o.market.toLowerCase() } : {}),
  };
}

/** list_open_orders args for cancel-all scoping + post-run verification. */
export function cancelAllListArgs(o: { exchange: string; pair: string }): Record<string, unknown> {
  return { exchange: o.exchange, pair: o.pair };
}
