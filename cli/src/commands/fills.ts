/**
 * Read-only fills + realized-PnL commands (MCP list_fills / read_closed_pnl
 * over the cex-proxy spotFills/futuresFills/closedPnl reads).
 *
 * Execution fills are Activity history — never Diary rows: one closed
 * position already yields one NET-pnl row via read_closed_pnl, so a fill
 * row would double-count. Neither command moves funds, signs, or writes.
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

export type FillsOpts = {
  exchange: string;
  pair?: string;
  market?: string;
  days?: number;
  limit?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

export type PnlOpts = {
  exchange: string;
  pair?: string;
  days?: number;
  limit?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

/** Null = usable; otherwise the human reason (caller exits 2, nothing called). */
export function validateMarket(market: string | undefined): string | null {
  const m = (market ?? "all").toLowerCase();
  if (m !== "spot" && m !== "futures" && m !== "all") return "market must be spot|futures|all";
  return null;
}

export function validateDays(days: number | undefined): string | null {
  const d = days ?? 30;
  if (!Number.isFinite(d) || d < 1 || d > 90) return "days must be 1..90";
  return null;
}

export function validateLimit(limit: number | undefined): string | null {
  const l = limit ?? 100;
  if (!Number.isFinite(l) || l < 1 || l > 500) return "limit must be 1..500";
  return null;
}

export type ClosedTradeRow = {
  id: string;
  symbol: string;
  side: string | null;
  qty: number | null;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  closedAt: number;
};

/** Totals over the returned rows. Non-finite pnl/fees never move a total. */
export function summarizePnl(trades: ClosedTradeRow[]): {
  totalPnl: number;
  totalFees: number;
  wins: number;
  losses: number;
} {
  let totalPnl = 0;
  let totalFees = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (typeof t.pnl === "number" && Number.isFinite(t.pnl)) {
      totalPnl += t.pnl;
      if (t.pnl > 0) wins += 1;
      else if (t.pnl < 0) losses += 1;
    }
    if (typeof t.fees === "number" && Number.isFinite(t.fees)) totalFees += t.fees;
  }
  return { totalPnl, totalFees, wins, losses };
}

type FillRow = {
  execId?: unknown;
  symbol?: unknown;
  side?: unknown;
  price?: unknown;
  qty?: unknown;
  fee?: unknown;
  feeCurrency?: unknown;
  execTime?: unknown;
  market?: unknown;
};

function fmtTime(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtNum(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? String(v) : "—";
}

export async function cmdFills(opts: FillsOpts): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange) {
    console.error("Usage: jw3 fills --exchange kucoin [--pair BTC/USDT] [--market spot|futures|all] [--days 30] [--limit 50] [--json]");
    process.exitCode = 2;
    return;
  }
  const bad =
    validateMarket(opts.market) ?? validateDays(opts.days) ?? validateLimit(opts.limit);
  if (bad) {
    console.error(`Bad fills read: ${bad} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  try {
    const out = (await callTool(
      "list_fills",
      {
        exchange: opts.exchange,
        ...(opts.pair ? { pair: opts.pair } : {}),
        market: (opts.market ?? "all").toLowerCase(),
        days: opts.days ?? 30,
        limit: opts.limit ?? 50,
      },
      pat,
      opts.url,
    )) as { exchange?: string; fills?: FillRow[] };
    if (opts.json) {
      console.log(JSON.stringify(out));
      return;
    }
    const rows = out.fills ?? [];
    if (rows.length === 0) {
      console.log(`No fills on ${opts.exchange}${opts.pair ? ` for ${opts.pair}` : ""} — empty is a real answer (unimplemented venues return []).`);
      return;
    }
    for (const f of rows) {
      const fee = f.feeCurrency ? `${fmtNum(f.fee)} ${f.feeCurrency}` : fmtNum(f.fee);
      console.log(
        `${fmtTime(f.execTime)}  ${String(f.side ?? "—").toUpperCase()}  ${f.symbol ?? "—"}  ${fmtNum(f.qty)} @ ${fmtNum(f.price)}  fee ${fee}  [${f.market ?? "—"}]`,
      );
    }
    console.log(`${rows.length} fill${rows.length === 1 ? "" : "s"} on ${out.exchange ?? opts.exchange} (executions, not realized PnL — see jw3 pnl).`);
  } catch (e) {
    fail(e);
  }
}

export async function cmdPnl(opts: PnlOpts): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange) {
    console.error("Usage: jw3 pnl --exchange kucoin [--pair BTC/USDT] [--days 30] [--limit 100] [--json]");
    process.exitCode = 2;
    return;
  }
  const bad = validateDays(opts.days) ?? validateLimit(opts.limit);
  if (bad) {
    console.error(`Bad pnl read: ${bad} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  try {
    const out = (await callTool(
      "read_closed_pnl",
      {
        exchange: opts.exchange,
        ...(opts.pair ? { pair: opts.pair } : {}),
        days: opts.days ?? 30,
        limit: opts.limit ?? 100,
      },
      pat,
      opts.url,
    )) as { exchange?: string; trades?: ClosedTradeRow[] };
    if (opts.json) {
      console.log(JSON.stringify(out));
      return;
    }
    const rows = out.trades ?? [];
    if (rows.length === 0) {
      console.log(`No closed-PnL rows on ${opts.exchange}${opts.pair ? ` for ${opts.pair}` : ""} — empty is a real answer (venues without a closed-pnl feed return []).`);
      return;
    }
    for (const t of rows) {
      const entry = t.entryPrice === 0 ? "entry unknown" : `@ ${t.entryPrice}`;
      console.log(
        `${fmtTime(t.closedAt)}  ${t.side ?? "—"}  ${t.symbol}  ${t.qty ?? "—"}  ${entry} → ${t.exitPrice}  pnl ${t.pnl}  fees ${t.fees}`,
      );
    }
    const s = summarizePnl(rows);
    console.log(
      `Total PnL ${s.totalPnl}  Fees ${s.totalFees}  (${rows.length} closes: ${s.wins} wins / ${s.losses} losses) on ${out.exchange ?? opts.exchange}.`,
    );
  } catch (e) {
    fail(e);
  }
}
