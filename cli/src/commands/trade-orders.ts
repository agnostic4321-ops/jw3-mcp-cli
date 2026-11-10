/**
 * Open-order reads + loop risk guards (split from trade.ts). Shared by the
 * cancel-all handler and the live/watchdog/monitor/degen loops: venue
 * payloads in, typed rows and halt reasons out. checkLoopKill never throws.
 */
import { callTool } from "../mcp.js";
import type { TradeCall } from "./trade-ticket.js";

/**
 * Canonical pair key: BTC/USDT ≡ btcusdt. Same normalization the
 * server's fills/PnL filters use, so client and server agree on identity.
 */
export function pairKey(pair: unknown): string {
  return String(pair ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type OpenOrderRow = Record<string, unknown>;

/** Order id out of a venue-shaped row (orderId, id, ordId variants). */
export function cancelOrderIdOf(row: OpenOrderRow): string | null {
  const id = row.orderId ?? row.id ?? row.ordId;
  const s = String(id ?? "").trim();
  return s ? s : null;
}

/**
 * list_open_orders payload → rows. The cex-proxy returns a bare array;
 * wrapped shapes ({orders}, {openOrders}) are accepted so a future
 * envelope change degrades to working, not to cancelling nothing.
 */
export function extractOpenOrders(out: unknown): OpenOrderRow[] {
  const isRow = (r: unknown): r is OpenOrderRow => !!r && typeof r === "object";
  if (Array.isArray(out)) return out.filter(isRow);
  if (out && typeof out === "object") {
    for (const k of ["orders", "openOrders", "result", "data"] as const) {
      const v = (out as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.filter(isRow);
    }
  }
  return [];
}

/**
 * Rows of this pair only. The list call is already pair-scoped server-side;
 * this re-checks client-side so a mistyped --pair can never wipe the wrong
 * book when a venue ignores the filter. Rows without a symbol carry no pair
 * evidence and are kept (the server scoped them); rows with a *different*
 * pair are dropped.
 */
export function selectCancelTargets(out: unknown, pair: string): { orderId: string; symbol: string }[] {
  const want = pairKey(pair);
  const targets: { orderId: string; symbol: string }[] = [];
  for (const row of extractOpenOrders(out)) {
    const id = cancelOrderIdOf(row);
    if (!id) continue;
    const sym = String(row.symbol ?? "");
    if (want && pairKey(sym) && pairKey(sym) !== want) continue;
    targets.push({ orderId: id, symbol: sym });
  }
  return targets;
}

export type LoopRisk = {
  killSwitch: boolean | null;
  breakerTripped: boolean | null;
  autonomy: string | null;
  dailyLoss: number | null;
  maxDailyLoss: number | null;
  tradesToday: number | null;
  maxTrades: number | null;
};

function numOrNull(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * read_risk_limits payload ({risk_limits:{…}} or the bare row, snake or
 * camel keys) → one shape. Unknown stays null, never a guessed zero — a
 * missing cap must not read as "no cap" nor as "cap hit".
 */
export function normalizeRiskLimits(out: unknown): LoopRisk {
  const o = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
  const inner = o.risk_limits && typeof o.risk_limits === "object" ? (o.risk_limits as Record<string, unknown>) : o;
  const boolOrNull = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  const breakerRaw = inner.circuit_breaker_tripped_at ?? inner.circuitBreakerTripped;
  return {
    killSwitch: boolOrNull(inner.kill_switch_enabled ?? inner.killSwitchEnabled),
    breakerTripped:
      "circuit_breaker_tripped_at" in inner || "circuitBreakerTripped" in inner
        ? breakerRaw === true || (typeof breakerRaw === "string" && breakerRaw.length > 0)
        : null,
    autonomy:
      typeof (inner.autonomy_level ?? inner.autonomyLevel) === "string"
        ? (inner.autonomy_level ?? inner.autonomyLevel) as string
        : null,
    dailyLoss: numOrNull(inner.daily_realized_loss_usd ?? inner.dailyRealizedLossUsd),
    maxDailyLoss: numOrNull(inner.max_daily_loss_usd ?? inner.maxDailyLossUsd),
    tradesToday: numOrNull(inner.daily_trade_count ?? inner.dailyTradeCount),
    maxTrades: numOrNull(inner.max_trades_per_day ?? inner.maxTradesPerDay),
  };
}

/**
 * Loop kill-check against risk limits. String = halt now with this reason
 * (priority: kill switch → breaker → daily-loss cap → max trades);
 * null = clear. Autonomy level is exposed on LoopRisk but is NOT a halt:
 * propose_only blocks opening, never risk-reducing loops like cancel-all.
 */
export function loopKillReason(r: LoopRisk): string | null {
  if (r.killSwitch === true) return "kill switch engaged";
  if (r.breakerTripped === true) return "circuit breaker tripped";
  if (r.maxDailyLoss != null && r.maxDailyLoss > 0 && r.dailyLoss != null && r.dailyLoss >= r.maxDailyLoss) {
    return `daily loss cap reached ($${r.dailyLoss} ≥ $${r.maxDailyLoss})`;
  }
  if (r.maxTrades != null && r.maxTrades > 0 && r.tradesToday != null && r.tradesToday >= r.maxTrades) {
    return `max trades reached (${r.tradesToday} ≥ ${r.maxTrades})`;
  }
  return null;
}

/**
 * Live kill-check for long-running loops: reads risk limits, returns the
 * halt reason (null = clear). Never throws — an unreadable row is reported
 * via readError, not hidden. Cancels may proceed under a halt (they reduce
 * risk); loops that OPEN risk should treat a halt — or an unreadable row —
 * as stop.
 */
export async function checkLoopKill(
  pat: string,
  url?: string,
  call: TradeCall = callTool,
): Promise<{ reason: string | null; risk: LoopRisk | null; readError?: string }> {
  let out: unknown;
  try {
    out = await call("read_risk_limits", {}, pat, url);
  } catch (e) {
    return { reason: null, risk: null, readError: e instanceof Error ? e.message : String(e) };
  }
  const risk = normalizeRiskLimits(out);
  return { reason: loopKillReason(risk), risk };
}
