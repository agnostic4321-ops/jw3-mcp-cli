/**
 * Risk-limits reads (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

export async function cmdRisk(opts: { json: boolean; state?: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let out: unknown;
  try {
    out = await callTool("read_risk_limits", {}, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.state && !opts.json) {
    console.log(formatRiskState(out));
    return;
  }
  console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
}

/**
 * Pure one-screen risk-state summary (same posture the app's Risk settings
 * display reads: kill switch, autonomy, breaker, caps vs daily usage).
 * Tolerates both the `{ risk_limits }` envelope and a bare row — unknown
 * fields read as unknown, never as safe.
 */
export function formatRiskState(out: unknown): string {
  const row = (out && typeof out === "object" && "risk_limits" in (out as Record<string, unknown>)
    ? (out as { risk_limits?: unknown }).risk_limits
    : out) as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return "risk state unreadable (no row)";
  const str = (v: unknown): string =>
    v === null || v === undefined ? "?" : typeof v === "string" ? v : JSON.stringify(v);
  const num = (v: unknown): string =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
  const left = (cap: unknown, used: unknown): string => {
    if (typeof cap !== "number" || !Number.isFinite(cap)) return "uncapped";
    if (typeof used !== "number" || !Number.isFinite(used)) return `cap ${cap}`;
    return `${cap - used} left of ${cap}`;
  };
  return [
    `kill_switch=${str((row as Record<string, unknown>).kill_switch_enabled)} autonomy=${str((row as Record<string, unknown>).autonomy_level)}`,
    `breaker=${str(row.circuit_breaker_enabled)} tripped_at=${str(row.circuit_breaker_tripped_at)}`,
    `loss: ${str((row as Record<string, unknown>).daily_realized_loss_usd)}/${str((row as Record<string, unknown>).max_daily_loss_usd)} trades: ${str((row as Record<string, unknown>).daily_trade_count)}/${str((row as Record<string, unknown>).max_trades_per_day)}`,
    `notional: ${left((row as Record<string, unknown>).max_daily_notional_usd, (row as Record<string, unknown>).daily_notional_usd)} position_cap=${num((row as Record<string, unknown>).max_position_usd)} leverage_cap=${num((row as Record<string, unknown>).max_leverage)}`,
  ].join("\n");
}
