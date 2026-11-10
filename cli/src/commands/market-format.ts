/**
 * Market read formatting (split from market.ts). Pure functions only:
 * pair canonicalisation, position-envelope filtering, human lines and
 * venue-balance views. No network, no disk.
 */

/** Canonical pair key: separators unified, XBT→BTC, missing slash inserted. */
export function normalizePair(pair: string): string {
  const s = String(pair ?? "").toUpperCase().replace(/[-_]/g, "/").replace(/\s+/g, "");
  const keyed = s.includes("/") ? s : s.replace(/^(.*?)(USDT|USDC|USD|BTC|ETH)$/, "$1/$2");
  return keyed.replace(/^XBT\//, "BTC/");
}

/** True when a venue symbol matches the --pair filter (both canonicalised). */
export function matchesPair(symbol: unknown, filter: string): boolean {
  if (!filter) return true;
  return normalizePair(String(symbol ?? "")) === normalizePair(filter);
}

/** Validate a `--watch SEC` interval. Null = usable. */
export function validateWatchSec(v: number): string | null {
  if (!Number.isFinite(v)) return "--watch SEC must be a number of seconds (≥ 1)";
  if (v < 1 || v > 3600) return "--watch SEC must be 1..3600";
  return null;
}

/** Validate an optional `--polls N` bound. Null = usable. */
export function validatePolls(v: number): string | null {
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 100000) {
    return "--polls must be an integer 1..100000";
  }
  return null;
}

export type PositionRow = { symbol?: unknown; side?: unknown; [k: string]: unknown };

/** All position rows inside a filtered/unfiltered envelope (venue fan-out aware). */
export function collectRows(out: unknown): PositionRow[] {
  if (Array.isArray(out)) {
    return out.filter((r): r is PositionRow => !!r && typeof r === "object") as PositionRow[];
  }
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (Array.isArray(o.positions)) {
      return (o.positions as unknown[]).filter(
        (r): r is PositionRow => !!r && typeof r === "object",
      ) as PositionRow[];
    }
    if (Array.isArray(o.venues)) {
      const rows: PositionRow[] = [];
      for (const v of o.venues as unknown[]) {
        if (!v || typeof v !== "object") continue;
        const data = (v as Record<string, unknown>).data;
        if (Array.isArray(data)) {
          for (const r of data) if (r && typeof r === "object") rows.push(r as PositionRow);
        } else if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).positions)) {
          for (const r of (data as Record<string, unknown>).positions as unknown[]) {
            if (r && typeof r === "object") rows.push(r as PositionRow);
          }
        }
      }
      return rows;
    }
  }
  return [];
}

function filterRows(rows: PositionRow[], pair?: string): PositionRow[] {
  if (!pair) return rows;
  return rows.filter((r) => matchesPair(r.symbol, pair));
}

/**
 * Client-side `--pair` filter over a positions envelope. Never mutates the
 * input: venues whose rows all miss the filter come back with an empty data
 * array (empty stays a real, distinguishable answer). Returns the filtered
 * envelope plus seen/kept counts.
 */
export function filterPositions(
  out: unknown,
  pair?: string,
): { filtered: unknown; total: number; kept: number } {
  const rows = collectRows(out);
  const total = rows.length;
  if (!pair) return { filtered: out, total, kept: total };
  const keptRows = filterRows(rows, pair);
  const kept = keptRows.length;
  if (Array.isArray(out)) return { filtered: keptRows, total, kept };
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if (Array.isArray(o.positions)) {
      return { filtered: { ...o, positions: keptRows }, total, kept };
    }
    if (Array.isArray(o.venues)) {
      const keepSet = new Set(keptRows);
      const venues = (o.venues as unknown[]).map((v) => {
        if (!v || typeof v !== "object") return v;
        const vv = v as Record<string, unknown>;
        const data = vv.data;
        if (Array.isArray(data)) {
          return { ...vv, data: (data as unknown[]).filter((r) => keepSet.has(r as PositionRow)) };
        }
        if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).positions)) {
          const d = data as Record<string, unknown>;
          return {
            ...vv,
            data: {
              ...d,
              positions: ((d.positions as unknown[]) as PositionRow[]).filter((r) => keepSet.has(r)),
            },
          };
        }
        return v;
      });
      return { filtered: { ...o, venues }, total, kept };
    }
  }
  return { filtered: out, total, kept };
}

function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}

/** One human line per position row (watch mode + tests). */
export function formatPositionLine(r: PositionRow): string {
  const symbol = String(r.symbol ?? "—");
  const side = String(r.side ?? "—").toUpperCase();
  const size = Number(r.size);
  const entry = Number((r.entryPrice ?? r.entry) as unknown);
  const mark = Number((r.markPrice ?? r.mark) as unknown);
  const sizeS = Number.isFinite(size) ? String(size) : "—";
  const entryS = Number.isFinite(entry) ? String(entry) : "—";
  const markS = Number.isFinite(mark) ? String(mark) : "—";
  const pnl = fmtMoney(r.unrealizedPnl ?? r.unrealisedPnl ?? r.pnl);
  const lev = Number(r.leverage);
  return `${symbol} ${side} ${sizeS} @ ${entryS} → ${markS}  uPnL ${pnl}${Number.isFinite(lev) && lev > 0 ? `  x${lev}` : ""}`;
}

/** Venue slugs for --venue (same registry as read_venue_balances). */
export const VENUE_BALANCE_SLUGS = [
  "hyperliquid",
  "aster",
  "dydx",
  "pacifica",
  "polymarket",
  "all",
] as const;

/** Normalize a --venue value (`hl` alias accepted). Null = unknown venue. */
export function normalizeVenueFlag(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "hl") return "hyperliquid";
  return (VENUE_BALANCE_SLUGS as readonly string[]).includes(s) ? s : null;
}

export type VenueBalanceRowView = {
  venue?: unknown;
  address?: unknown;
  ok?: unknown;
  equityUsd?: unknown;
  state?: unknown;
  detail?: unknown;
};

/** Short address form (0x581A…0868); non-EVM addresses print whole. */
export function shortVenueAddress(a: unknown): string {
  const s = String(a ?? "");
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  return s || "—";
}

/** One human line per venue-balance row (never $0 for an unknown value). */
export function formatVenueRow(r: VenueBalanceRowView): string {
  const venue = String(r.venue ?? "—");
  const addr = r.address ? shortVenueAddress(r.address) : "—";
  const state = String(r.state ?? "—");
  if (state === "ok" || state === "zero") {
    const money = typeof r.equityUsd === "string" ? fmtMoney(Number(r.equityUsd)) : "—";
    const tail = r.detail ? `  (${String(r.detail)})` : "";
    return `${venue}  ${addr}  ${money}${tail}`;
  }
  const tail = r.detail ? `  ${String(r.detail)}` : "";
  return `${venue}  ${addr}  ${state}${tail}`;
}

/** Print a read_venue_balances result: one line per row, total, partial reasons. */
export function printVenueBalances(out: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(out));
    return;
  }
  const o = (out ?? {}) as {
    venues?: VenueBalanceRowView[];
    totalUsd?: unknown;
    partial?: unknown;
    partialReasons?: unknown;
    observedAt?: unknown;
  };
  const at = typeof o.observedAt === "string" ? ` @ ${o.observedAt}` : "";
  console.log(`venue-held funds${at}:`);
  for (const r of o.venues ?? []) console.log(`  ${formatVenueRow(r)}`);
  const total = typeof o.totalUsd === "string" ? fmtMoney(Number(o.totalUsd)) : "—";
  console.log(`total ${total}${o.partial ? "  (partial)" : ""}`);
  if (Array.isArray(o.partialReasons)) {
    for (const reason of o.partialReasons) console.log(`  ! ${String(reason)}`);
  }
}
