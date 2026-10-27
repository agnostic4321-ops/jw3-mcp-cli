// mcp-server/execute.ts — the execute_trade tool handler (moved out of index.ts).
//
// Live CEX order via stored exchange keys (real money): same resolution as
// chat YOLO (model speaks {exchange, pair, amount}; cex-proxy needs
// {connectionId, symbol, quantity, type}), fee-aware sizing from risk_usd,
// and a full diary trail. Behavior identical to the inline block.
import { resolveOrderTarget, toProxyOrder } from "../_shared/order-resolve.ts";
import type { ConnectionAdmin } from "../_shared/order-resolve.ts";
import { atr, checkMinMove, estimateRoundTrip, sizeFromRisk, stopFromAtr } from "../_shared/trade-economics.ts";
import {
  logServer,
  newCorrelationId,
  normalizeIdempotencyKey,
  upstreamErrorText,
  validateActor,
  validateClientOid,
  validateLeverage,
  validateMarginMode,
  validateOrderType,
  validatePairSymbol,
  validateTradeSide,
  validateVenueSlug,
  toolError,
  toolOk,
  type ToolCtx,
} from "./tools.ts";

/** Idempotency window: replays within 10 minutes of the first attempt. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

export type ValidatedExecuteFields = {
  side: string;
  pair: string;
  exchange: string | null;
  actor: "machine" | "owner" | null;
  leverage: number | null;
  marginMode: string | null;
  clientOid: string | null;
  orderType: string | null;
  idempotencyKey: string | null;
};

/**
 * Validate every declared execute_trade field up front. Unknown enum
 * values are REJECTED here: toProxyOrder silently drops values it does
 * not recognize, so without this an invalid actor or marginMode would
 * vanish instead of failing loudly.
 */
export function validateExecuteTradeFields(
  args: Record<string, unknown>,
): { ok: true; fields: ValidatedExecuteFields } | { ok: false; error: string } {
  const side = validateTradeSide(args.side);
  if (!side.ok) return { ok: false, error: side.error };
  const pair = validatePairSymbol(args.pair);
  if (!pair.ok) return { ok: false, error: pair.error };
  let exchange: string | null = null;
  if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
    const v = validateVenueSlug(args.exchange);
    if (!v.ok) return { ok: false, error: v.error };
    exchange = v.venue;
  }
  const actor = validateActor(args.actor);
  if (!actor.ok) return { ok: false, error: actor.error };
  const leverage = validateLeverage(args.leverage);
  if (!leverage.ok) return { ok: false, error: leverage.error };
  const marginMode = validateMarginMode(args.marginMode);
  if (!marginMode.ok) return { ok: false, error: marginMode.error };
  const clientOid = validateClientOid(args.clientOid);
  if (!clientOid.ok) return { ok: false, error: clientOid.error };
  const orderType = validateOrderType(args.type);
  if (!orderType.ok) return { ok: false, error: orderType.error };
  let idempotencyKey: string | null = null;
  if (args.idempotency_key !== undefined && args.idempotency_key !== null && String(args.idempotency_key).trim() !== "") {
    const norm = normalizeIdempotencyKey(args.idempotency_key);
    if (!norm) return { ok: false, error: "idempotency_key must be 1..160 chars of [A-Za-z0-9_:.=-]" };
    idempotencyKey = norm;
  }
  return {
    ok: true,
    fields: {
      side: side.side, pair: pair.value, exchange,
      actor: actor.actor, leverage: leverage.leverage,
      marginMode: marginMode.marginMode, clientOid: clientOid.clientOid,
      orderType: orderType.type, idempotencyKey,
    },
  };
}

type PriorOutcome =
  | { status: string; result: unknown }
  | null
  | "unreadable";

/**
 * Look up a (user, idempotency_key) pair in the execute log. The log
 * insert below stores the key at params top level so this lookup
 * (params->>idempotency_key) actually matches. FAIL-CLOSED: an
 * unreadable read returns "unreadable" so callers refuse rather than
 * risk a double-fill. Never throws.
 */
export async function findPriorExecuteOutcome(
  admin: ToolCtx["admin"],
  userId: string,
  key: string,
): Promise<PriorOutcome> {
  try {
    const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
    const res = await (admin.from("agent_action_log")
      .select("status,result,created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .filter("params->>idempotency_key", "eq", key)
      .order("created_at", { ascending: false })
      .limit(1) as unknown as Promise<{
        data: Array<{ status?: unknown; result?: unknown }> | null;
        error: { message?: string } | null;
      }>);
    if (res.error) return "unreadable";
    const row = (res.data ?? [])[0];
    if (!row) return null;
    return { status: String(row.status ?? ""), result: row.result ?? null };
  } catch {
    return "unreadable";
  }
}

export async function handleExecuteTrade(
  ctx: ToolCtx, id: unknown, args: Record<string, unknown>,
): Promise<Response> {
  const corr = newCorrelationId();
  const { admin, userId, supaUrl, authHeader, viaPat, callEdge } = ctx;
  // writeGate lives in index.ts (shared by all write tools) — the caller
  // re-checks trade:execute + YOLO eligibility before delegating here.
  // Every declared field is validated AND forwarded here (or rejected):
  // toProxyOrder drops what it does not recognize, so validation is the
  // only place an unknown actor, marginMode, or key can fail loudly.
  const fv = validateExecuteTradeFields(args);
  if (!fv.ok) return toolError(id, `validation: execute_trade ${fv.error}`);
  const { side: validSide, pair: validPair, exchange: validExchange } = fv.fields;
  const { actor, leverage, marginMode, clientOid } = fv.fields;
  const { orderType: explicitType, idempotencyKey } = fv.fields;
  // Per-INTENT dedupe: a retry under the same key replays the recorded
  // fill instead of dispatching again. Unknown prior outcomes fail
  // closed so a retry can never double-fill after an ambiguous attempt.
  if (idempotencyKey) {
    const prior = await findPriorExecuteOutcome(admin, userId, idempotencyKey);
    if (prior === "unreadable") {
      logServer(corr, "idempotency lookup unreadable; failing closed");
      return toolError(id, `blocked: execute_trade idempotency unavailable (ref ${corr})`);
    }
    if (prior && prior.status === "executed") {
      const prev = (prior.result && typeof prior.result === "object" ? prior.result as Record<string, unknown> : { result: prior.result });
      return toolOk(id, { ...prev, deduped: true, idempotency_key: idempotencyKey });
    }
    if (prior && prior.status === "unknown") {
      logServer(corr, `idempotency key ${idempotencyKey} has an ambiguous prior attempt; failing closed`);
      return toolError(id, `blocked: execute_trade already attempted under this idempotency key (ref ${corr})`);
    }
  }
  // Same resolution as chat YOLO: model speaks {exchange, pair,
  // amount}; cex-proxy needs {connectionId, symbol, quantity, type}.
  const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, {
    exchange: validExchange ?? args.exchange,
    connectionId: args.connectionId,
  });
  if (!target.ok) return toolError(id, `not_found: order target failed: ${target.error}`);
  const pairStr = validPair;
  const marketKind = typeof args.market === "string" && args.market === "futures" ? "futures" : "spot";
  const stopArg = typeof args.stop === "number" && args.stop > 0 ? args.stop : null;
  const riskArg = typeof args.risk_usd === "number" && args.risk_usd > 0 ? args.risk_usd : null;
  if (typeof args.stop === "number" && !(args.stop > 0)) {
    return toolError(id, "validation: execute_trade stop must be > 0 when provided");
  }
  const tpArg = typeof args.tp === "number" ? args.tp
    : typeof args.tpPrice === "number" ? args.tpPrice : null;
  if (args.tp != null && !(tpArg != null && tpArg > 0)) {
    return toolError(id, "validation: execute_trade tp must be > 0 when provided");
  }
  if (args.tpPrice != null && !(tpArg != null && tpArg > 0)) {
    return toolError(id, "validation: execute_trade tp must be > 0 when provided");
  }
  if (args.risk_usd != null && !(riskArg != null)) {
    return toolError(id, "validation: execute_trade risk_usd must be > 0 when provided");
  }
  let amount = typeof args.amount === "string" ? args.amount : "";
  // Fee-aware sizing: risk_usd sizes the order from the stop distance
  // instead of trusting a hand-picked amount. Needs a reference price
  // (limit price or live ticker) and a stop (explicit, else ATR from
  // venue klines with the fee floor on top). Fail-closed: every
  // unverifiable leg refuses with the cause named — never a guess.
  let sizing: Record<string, unknown> | null = null;
  let entryPx: number | null = null;
  const priceArg = typeof args.price === "string" && args.price.trim() !== "" ? Number(args.price) : NaN;
  if (Number.isFinite(priceArg) && priceArg > 0) entryPx = priceArg;
  if (riskArg != null || stopArg != null) {
    // Reference price for economics math (limit price preferred).
    if (entryPx == null) {
      try {
        const tk = await callEdge(supaUrl, authHeader, "cex-proxy", {
          action: "ticker", exchange: target.exchange, symbol: pairStr,
          category: marketKind === "futures" ? "linear" : "spot",
        }, 20000) as { price?: unknown };
        const live = Number((tk as { price?: unknown })?.price);
        if (Number.isFinite(live) && live > 0) entryPx = live;
      } catch { /* fall through to fail-closed below */ }
    }
    if (entryPx == null) {
      return toolError(id, "upstream: execute_trade cannot price fee economics — live ticker unreadable and no limit price given");
    }
  }
  let gateStop: number | null = stopArg;
  if (riskArg != null && gateStop == null) {
    // No explicit stop: derive one from recent volatility (1h ATR ×
    // 1.5, fee floor on top) via the venue klines cex-proxy serves.
    const px = entryPx;
    if (px == null) {
      return toolError(id, "upstream: execute_trade cannot price fee economics — live ticker unreadable and no limit price given");
    }
    try {
      const kl = await callEdge(supaUrl, authHeader, "cex-proxy", {
        action: "ohlcv", exchange: target.exchange, symbol: pairStr,
        interval: "1h", limit: 30, category: marketKind === "futures" ? "linear" : "spot",
      }, 25000) as { candles?: Array<{ high?: unknown; low?: unknown; close?: unknown }> };
      const rows = ((kl as { candles?: unknown })?.candles ?? []) as Array<Record<string, unknown>>;
      const feeProbe = estimateRoundTrip({
        venue: target.exchange, market: marketKind, notionalUsd: px, price: px,
      });
      const a = atr(rows.map((c) => ({
        h: Number(c.high), l: Number(c.low), c: Number(c.close),
      })));
      const s = a != null && feeProbe
        ? stopFromAtr({
          entryPrice: px, side: validSide === "sell" ? "sell" : "buy",
          atrValue: a, feeRateRoundTrip: feeProbe.roundTripRate,
        })
        : null;
      if (s) {
        gateStop = s.stopPrice;
        sizing = { atrStop: true, atrValue: a, stopPrice: s.stopPrice, feeFloored: s.floored };
      }
    } catch { /* fall through to fail-closed below */ }
    if (gateStop == null) {
      return toolError(id, "upstream: execute_trade risk_usd needs a stop — pass stop explicitly (venue klines for an ATR stop were unreadable)");
    }
  }
  if (riskArg != null) {
    // Existing cap + lot discipline bound the risk-sized quantity.
    let maxNotional: number | null = null;
    try {
      const { data: rl } = await admin.from("risk_limits").select("max_position_usd")
        .eq("user_id", userId).maybeSingle() as { data: { max_position_usd?: unknown } | null };
      const cap = Number(rl?.max_position_usd);
      if (Number.isFinite(cap) && cap > 0) maxNotional = cap;
    } catch { /* uncapped — sizeFromRisk handles null */ }
    let lot: { qtyStep: number; minQty: number } | null = null;
    try {
      const sf = await callEdge(supaUrl, authHeader, "cex-proxy", {
        action: "symbolFilters", exchange: target.exchange,
        category: marketKind === "futures" ? "linear" : "spot",
      }, 20000) as { filters?: Array<{ symbol?: unknown; qtyStep?: unknown; minQty?: unknown }> };
      const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const want = norm(pairStr);
      const hit = (((sf as { filters?: unknown })?.filters ?? []) as Array<Record<string, unknown>>)
        .find((f) => { const n = norm(String(f.symbol ?? "")); return n === want || (marketKind === "futures" && n === `${want}M`); });
      const step = Number(hit?.qtyStep), min = Number(hit?.minQty);
      if (Number.isFinite(step) && step > 0) {
        lot = { qtyStep: step, minQty: Number.isFinite(min) && min > 0 ? min : 0 };
      }
    } catch { /* unknown lot — no snapping, venue enforces */ }
    const sized = sizeFromRisk({
      riskUsd: riskArg, entryPrice: entryPx as number, stopPrice: gateStop as number,
      ...(maxNotional != null ? { maxNotionalUsd: maxNotional } : {}),
      ...(lot ? { lot } : {}),
    });
    if (!sized.ok) return toolError(id, `validation: execute_trade sizing refused: ${sized.message}`);
    amount = String(sized.quantityBase);
    sizing = {
      ...(sizing ?? {}), riskUsd: riskArg, quantityBase: sized.quantityBase,
      notionalUsd: sized.notionalUsd, stopDistPct: sized.stopDistPct,
      capped: sized.capped, ...(sized.note ? { note: sized.note } : {}),
    };
  }
  if (!amount || !Number.isFinite(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return toolError(id, "validation: execute_trade needs amount > 0 in base units (or risk_usd to size from risk)");
  }
  // TP side check (fail-closed when the entry price is known): a TP on the
  // wrong side of the entry would trigger instantly as a market st-order.
  // When entryPx is unknown here, cex-proxy re-checks against its own
  // pricing before anything is placed.
  if (tpArg != null && entryPx != null) {
    const isBuy = validSide !== "sell";
    if ((isBuy && !(tpArg > entryPx)) || (!isBuy && !(tpArg < entryPx))) {
      return toolError(id, `validation: execute_trade tp ${tpArg} sits on the wrong side of the entry ${entryPx} for a ${isBuy ? "buy" : "sell"} — arm it on the profit side instead`);
    }
  }
  if (Array.isArray(args.tpLegs) && entryPx != null) {
    const isBuy = validSide !== "sell";
    for (const rawLeg of args.tpLegs) {
      const lpx = Number((rawLeg as { price?: unknown } | null)?.price);
      if (Number.isFinite(lpx) && lpx > 0) {
        if ((isBuy && !(lpx > entryPx)) || (!isBuy && !(lpx < entryPx))) {
          return toolError(id, `validation: execute_trade tpLeg ${lpx} sits on the wrong side of the entry ${entryPx} for a ${isBuy ? "buy" : "sell"} — arm it on the profit side instead`);
        }
      }
    }
  }
  const shaped = toProxyOrder({
    ...args,
    pair: pairStr,
    side: validSide,
    ...(validExchange ? { exchange: validExchange } : {}),
    amount,
    // Every declared field rides explicitly: actor, leverage, marginMode,
    // clientOid, idempotency_key, and type are validated above and win
    // over the raw spread (which may carry untrimmed case variants).
    ...(actor ? { actor } : {}),
    ...(leverage != null ? { leverage } : {}),
    ...(marginMode ? { marginMode } : {}),
    ...(clientOid ? { clientOid } : {}),
    ...(explicitType ? { type: explicitType } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(gateStop != null ? { stop: gateStop } : {}),
    ...(tpArg != null ? { tp: tpArg } : {}),
    ...(Array.isArray(args.tpLegs) ? { tpLegs: args.tpLegs } : {}),
  });
  if (!shaped.ok) return toolError(id, `validation: order shape failed: ${shaped.error}`);
  let out: unknown;
  try {
    out = await callEdge(supaUrl, authHeader, "cex-proxy", {
      ...shaped.body, connectionId: target.connectionId,
    }, 45000);
  } catch (e) {
    logServer(corr, "execute_trade order rejected:", e instanceof Error ? e.message : e);
    return toolError(id, upstreamErrorText(corr));
  }
  // Fee estimate + min-move ride the result: the proxy attaches
  // feeEconomics on placeOrder; recompute locally only when it did
  // not (older deploy) and the reference price is known.
  let feeEconomics: unknown = (out as { feeEconomics?: unknown })?.feeEconomics ?? null;
  if (feeEconomics == null && entryPx != null) {
    const qtyNum = parseFloat(amount);
    if (Number.isFinite(qtyNum) && qtyNum > 0) {
      const est = estimateRoundTrip({
        venue: target.exchange, market: marketKind,
        notionalUsd: qtyNum * entryPx, price: entryPx,
      });
      if (est) {
        const mm = gateStop != null
          ? checkMinMove({ entryPrice: entryPx, stopPrice: gateStop, feeRateRoundTrip: est.roundTripRate })
          : null;
        feeEconomics = {
          venue: est.venue, market: est.market, roundTripRate: est.roundTripRate,
          roundTripPct: est.roundTripRate * 100, feeQuote: est.feeQuote, feeBase: est.feeBase,
          minMovePct: est.roundTripRate * 200, minMoveFactor: 2,
          ...(est.fallback ? { feeFallback: true } : {}),
          // A local min-move failure here is reported as FAILED-LOCAL, never
          // "passed": this branch only runs when the proxy attached no
          // feeEconomics, so no proxy gate can be claimed — the note carries
          // the shortfall wording.
          ...(mm ? (mm.ok ? { stopGate: "passed" } : { stopGate: "failed-local", note: mm.message }) : { stopGate: "skipped-no-stop" }),
        };
      }
    }
  }
  // callEdge throws on HTTP non-OK, so reaching here means the venue
  // accepted the order — but still honor an in-payload error flag.
  const execStatus = (out as { error?: unknown }).error == null ? "executed" : "failed";
  await admin.from("agent_action_log").insert({
    user_id: userId, action_type: "trade_cex", status: execStatus,
    params: {
      mcp_execute: true, ticket: args,
      resolved: { connectionId: target.connectionId, exchange: target.exchange },
      // Top level on purpose: the idempotency lookup keys on
      // params->>idempotency_key, and a key nested under ticket would
      // never match: the second submit would dispatch again.
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }, result: out, decided_via: "mcp-yolo",
  });
  // Diary trail: active setup + linked analysis so the trade enters the
  // setups queue, close-scoring, and the learning-history block.
  try {
    const sideStr = validSide;
    const { data: setupRow } = await admin.from("trade_setups").insert({
      user_id: userId, mode: "live",
      venue: validExchange,
      exchange: validExchange,
      asset: pairStr.split("/")[0] ?? pairStr, pair: pairStr, side: sideStr,
      entry: null, stop: null, timeframe: null,
      thesis: `MCP execute_trade ${sideStr ?? ""} ${pairStr} amount ${amount}`,
      indicators: {
        source: viaPat ? "mcp-harness" : "mcp-jwt", mcp_execute: true,
        result: JSON.stringify(out).slice(0, 1000),
        jev_verdict: null, invalidation: null,
        kronos_direction: null, kronos_expected_move_pct: null,
        kronos_horizon: null, kronos_captured_at: null,
      },
      status: execStatus === "executed" ? "active" : "proposed",
    }).select("id").single();
    const setupId = (setupRow as { id: string } | null)?.id ?? null;
    await admin.from("agent_analyses").insert({
      user_id: userId, asset: pairStr, sentiment: null, confidence: null,
      setup_id: setupId, score: null,
    });
  } catch { /* trail is best-effort; execution already recorded */ }
  // Fee estimate + min-move (+ risk sizing when used) ride the
  // result — the agent sees what the trade costs without a re-read.
  return toolOk(id, {
    ...(typeof out === "object" && out !== null ? out as Record<string, unknown> : { result: out }),
    ...(feeEconomics != null ? { feeEconomics } : {}),
    ...(sizing ? { sizing } : {}),
  });
}
