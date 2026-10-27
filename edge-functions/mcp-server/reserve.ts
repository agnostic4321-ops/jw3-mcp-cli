// mcp-server/reserve.ts — the reserve_sweep tool handler.
//
// Dry-run by default (plan only, zero bytes to the venue, no YOLO gate):
// reads balancesAll, computes the excess over keep, returns the two-leg
// plan. Live fire (dryRun:false, gated by writeGate in index.ts) chains
// cex-proxy transferReserve futures-to-main then main-to-trade for the
// SAME amount and audits the sweep. Leg 1 failing aborts before leg 2.
import { resolveOrderTarget } from "../_shared/order-resolve.ts";
import type { ConnectionAdmin } from "../_shared/order-resolve.ts";
import {
  normalizeReserveCurrency,
  planReserveSweep,
  validateReserveSweepArgs,
} from "../_shared/reserve.ts";
import { toolError, toolOk, type ToolCtx } from "./tools.ts";
import { logServer, newCorrelationId, upstreamErrorText } from "./tools.ts";

type BalancesAll = {
  accounts?: Record<string, Array<{ asset?: unknown; free?: unknown; total?: unknown }>>;
};

export async function handleReserveSweep(
  ctx: ToolCtx,
  id: unknown,
  args: Record<string, unknown>,
): Promise<Response> {
  const corr = newCorrelationId();
  const { admin, userId, supaUrl, authHeader, callEdge } = ctx;
  const keepRaw = args.keep === undefined ? 10 : Number(args.keep);
  const vErr = validateReserveSweepArgs({ keep: args.keep ?? 10, currency: args.currency ?? "USDT" });
  const currency = normalizeReserveCurrency(args.currency ?? "USDT");
  if (!currency || vErr) {
    return toolError(id, `validation: reserve_sweep ${vErr ?? "needs a supported currency (USDT, USDC, BTC, ETH)"}`);
  }
  if (!Number.isFinite(keepRaw) || keepRaw < 0) {
    return toolError(id, "validation: reserve_sweep keep must be a non-negative number");
  }
  const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, {
    exchange: args.exchange,
    connectionId: args.connectionId,
  });
  if (!target.ok) return toolError(id, `not_found: order target failed: ${target.error}`);
  if (target.exchange !== "kucoin") {
    return toolError(id, `validation: reserve_sweep is KuCoin-only (got ${target.exchange})`);
  }
  let all: BalancesAll;
  try {
    all = (await callEdge(supaUrl, authHeader, "cex-proxy", {
      action: "balancesAll",
      connectionId: target.connectionId,
    }, 45000)) as BalancesAll;
  } catch (e) {
    logServer(corr, "reserve_sweep balances read failed:", e instanceof Error ? e.message : e);
    return toolError(id, upstreamErrorText(corr));
  }
  const rows = all?.accounts?.futures ?? [];
  let free = 0;
  for (const r of rows) {
    const asset = String(r?.asset ?? "").trim().toUpperCase();
    const canon = asset === "XBT" ? "BTC" : asset;
    if (canon === currency) free += Number(r?.free) || 0;
  }
  const plan = planReserveSweep(free, keepRaw, currency);
  const base = { connectionId: target.connectionId, exchange: target.exchange };
  if (args.dryRun !== false || plan.noop) {
    return toolOk(id, { dryRun: true, ...base, ...plan });
  }
  const legs: unknown[] = [];
  try {
    legs.push(await callEdge(supaUrl, authHeader, "cex-proxy", {
      action: "transferReserve",
      connectionId: target.connectionId,
      leg: "futures-to-main",
      currency,
      amount: plan.sweepAmount,
      dryRun: false,
    }, 45000));
  } catch (e) {
    logServer(corr, "reserve_sweep leg futures-to-main rejected:", e instanceof Error ? e.message : e);
    return toolError(id, upstreamErrorText(corr));
  }
  try {
    legs.push(await callEdge(supaUrl, authHeader, "cex-proxy", {
      action: "transferReserve",
      connectionId: target.connectionId,
      leg: "main-to-trade",
      currency,
      amount: plan.sweepAmount,
      dryRun: false,
    }, 45000));
  } catch (e) {
    logServer(corr, "reserve_sweep leg main-to-trade rejected (futures-to-main already moved):", e instanceof Error ? e.message : e);
    return toolError(
      id,
      upstreamErrorText(corr),
    );
  }
  // Audit trail: agent_action_log rides the enum-safe trade_cex type;
  // the sweeps table carries the reserve-sweep fact (trigger manual).
  // Both best-effort — the transfers already executed.
  try {
    await admin.from("agent_action_log").insert({
      user_id: userId,
      action_type: "trade_cex",
      status: "executed",
      params: {
        mcp_reserve_sweep: true,
        ticket: args,
        resolved: base,
        plan,
      },
      result: { legs },
      decided_via: "mcp-yolo",
    });
  } catch { /* audit is best-effort; execution already recorded */ }
  try {
    await admin.from("sweeps").insert({
      user_id: userId,
      venue: target.exchange,
      asset: currency,
      amount: plan.sweepAmount,
      from_loc: "futures",
      to_loc: "trade",
      trigger: "manual",
      tx_refs: { legs },
    });
  } catch { /* audit is best-effort; execution already recorded */ }
  return toolOk(id, { dryRun: false, ...base, ...plan, legs });
}
