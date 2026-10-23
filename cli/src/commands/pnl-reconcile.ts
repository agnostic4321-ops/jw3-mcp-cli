/**
 * `jw3 pnl-reconcile` — count the venue's realized LOSSES against the
 * daily risk counters.
 *
 * ── WHY THIS COMMAND EXISTS ──
 *
 * The daily loss cap is enforced from `risk_limits.daily_realized_loss_usd`.
 * That counter is incremented by the CLOSE path (`close_position`).
 *
 * But a trade closed by the VENUE's own stop — the normal way a losing
 * trade closes — never goes through the close path. The venue fills the
 * stop order and the position is simply gone. Nothing records the loss.
 *
 * Observed live on 2026-10-21: three stopped-out trades totalling
 * -$0.23, and `daily_realized_loss_usd` was still 0. The daily loss cap
 * could not have fired.
 *
 * So the loss has to be counted from the VENUE, which is the book of
 * record for realized P&L. The server's reconciler is idempotent — each
 * venue trade is counted exactly once, tracked in the realized-PnL
 * ledger — so this command is safe to run as often as you like.
 *
 * It never places an order and never moves funds. It only writes the
 * daily risk counters.
 *
 * (Distinct from `jw3 reconcile`, which audits order-state ownership.)
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

export type PnlReconcileOpts = {
  exchange: string;
  days?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

/** Null = usable; otherwise the human reason (caller exits 2, nothing called). */
export function validatePnlReconcileDays(days: number | undefined): string | null {
  const d = days ?? 2;
  if (!Number.isFinite(d) || d < 1 || d > 30) return "days must be 1..30";
  return null;
}

/** The payload, from either the unwrapped object or the raw MCP envelope. */
export function unwrapToolPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const text = ((raw as { content: Array<{ text?: unknown }> }).content ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through
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

export async function cmdPnlReconcile(o: PnlReconcileOpts): Promise<void> {
  const pat = needPat(o.pat);
  if (!pat) {
    fail("pnl-reconcile needs a PAT — run `jw3 auth login` first");
    return;
  }
  const daysErr = validatePnlReconcileDays(o.days);
  if (daysErr) {
    fail(daysErr);
    return;
  }
  if (!o.exchange) {
    fail("pnl-reconcile needs --exchange (e.g. --exchange kucoin)");
    return;
  }

  let raw: unknown;
  try {
    raw = await callTool(
      "reconcile_realized_pnl",
      { exchange: o.exchange, days: o.days ?? 2 },
      pat,
      o.url,
    );
  } catch (e) {
    fail(`pnl-reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const p = unwrapToolPayload(raw);
  const counted = Number(p.counted ?? 0);
  const lossRecordedUsd = Number(p.lossRecordedUsd ?? 0);
  const alreadyCounted = Number(p.alreadyCounted ?? 0);
  const notLosses = Number(p.notLosses ?? 0);
  const venueTrades = Number(p.venueTrades ?? 0);

  if (o.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  if (counted === 0) {
    console.log(
      `reconciled: ${venueTrades} venue trade(s), nothing new to count ` +
        `(${alreadyCounted} already counted, ${notLosses} were profits)`,
    );
    return;
  }
  console.log(
    `reconciled: counted ${counted} loss(es) totalling $${lossRecordedUsd.toFixed(4)} ` +
      `against the daily loss cap (${alreadyCounted} already counted, ${notLosses} were profits)`,
  );
  if (Array.isArray(p.skipped) && p.skipped.length > 0) {
    for (const s of p.skipped as Array<{ id?: string; reason?: string }>) {
      console.log(`  skipped ${s.id ?? "?"}: ${s.reason ?? "unknown"}`);
    }
  }
}
