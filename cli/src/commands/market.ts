/**
 * Authenticated market/account reads (MCP read_live_datum family).
 * CEX position/balance/order reads need a connectionId — resolved here
 * from list_connections so the user names an exchange, not an id.
 */
import { resolvePat } from "../config.js";
import { McpError, callTool } from "../mcp.js";
import { clearConnSession, connSessionKey, getConnSession, setConnSession } from "../cache.js";

export type Conn = {
  id: string;
  exchange: string;
  label?: string;
  status?: string;
  markets?: string;
};

export async function listConnections(pat: string, url?: string): Promise<Conn[]> {
  const out = (await callTool("list_connections", {}, pat, url)) as { connections?: Conn[] };
  return out?.connections ?? [];
}

/** Pure pick: match exchange, prefer a row covering futures when asked. */
export function pickConnection(rows: Conn[], exchange?: string, wantFutures = false): Conn | null {
  const pool = exchange
    ? rows.filter((c) => c.exchange.toLowerCase() === exchange.toLowerCase())
    : rows;
  if (pool.length === 0) return null;
  if (wantFutures) {
    const fut = pool.find((c) => c.markets === "both" || c.markets === "futures");
    if (fut) return fut;
  }
  return pool[0] ?? null;
}

export function needPat(flag?: string): string | null {
  const pat = resolvePat(flag);
  if (!pat) {
    console.error("Not authenticated — run `jw3 auth login --browser` first; nothing was called.");
    process.exitCode = 1;
    return null;
  }
  return pat;
}

export function fail(e: unknown): void {
  const code = e instanceof McpError ? ` [${e.code}]` : "";
  console.error(`Failed${code}: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}

export async function cmdMarket(opts: {
  exchange: string;
  pair: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange || !opts.pair) {
    console.error("Usage: jw3 market --exchange binance --pair BTC/USDT [--json]");
    process.exitCode = 2;
    return;
  }
  try {
    const out = await callTool(
      "read_live_datum",
      { kind: "market", exchange: opts.exchange, symbol: opts.pair },
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}

export async function cmdScreener(opts: {
  exchange: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  try {
    const out = (await callTool(
      "read_live_datum",
      { kind: "screener", exchange: opts.exchange || "binance" },
      pat,
      opts.url,
    )) as { exchange?: string; topByVolume?: { s: string; p: number; chg: number; vol: number }[] };
    if (opts.json) {
      console.log(JSON.stringify(out));
      return;
    }
    for (const t of out.topByVolume ?? []) {
      const chg = t.chg == null ? "—" : `${t.chg > 0 ? "+" : ""}${t.chg.toFixed(2)}%`;
      console.log(`${t.s}  ${t.p}  ${chg}`);
    }
  } catch (e) {
    fail(e);
  }
}

async function withConnection(
  opts: { exchange?: string; json: boolean; url?: string; pat?: string },
  wantFutures: boolean,
  deps?: { list?: typeof listConnections },
): Promise<{ pat: string; conn: Conn; url?: string } | null> {
  const pat = needPat(opts.pat);
  if (!pat) return null;
  // Session cache: one CLI process resolves list_connections once per
  // exchange+url instead of once per poll/read. In-memory only — the
  // connectionId never hits disk.
  const key = connSessionKey(opts.exchange, opts.url, wantFutures);
  const hit = getConnSession(key);
  if (hit) return { pat, conn: { ...hit, label: undefined }, url: opts.url };
  try {
    const rows = await (deps?.list ?? listConnections)(pat, opts.url);
    const conn = pickConnection(rows, opts.exchange, wantFutures);
    if (!conn) {
      console.error(
        opts.exchange
          ? `No connection for ${opts.exchange} — connect it in-app first.`
          : "No CEX connections — connect one in-app first.",
      );
      process.exitCode = 1;
      return null;
    }
    setConnSession(key, { id: conn.id, exchange: conn.exchange });
    return { pat, conn, url: opts.url };
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Test hook: session-cache-aware resolution over an injected row list. */
export async function resolveConnectionCached(
  rows: Conn[],
  opts: { exchange?: string; url?: string },
  wantFutures: boolean,
  deps?: { list?: (pat: string, url?: string) => Promise<Conn[]>; pat?: string },
): Promise<Conn | null> {
  const key = connSessionKey(opts.exchange, opts.url, wantFutures);
  const hit = getConnSession(key);
  if (hit) return { ...hit };
  const list = deps?.list ?? (async () => rows);
  const fetched = await list(deps?.pat ?? "", opts.url);
  const conn = pickConnection(fetched, opts.exchange, wantFutures);
  if (conn) setConnSession(key, { id: conn.id, exchange: conn.exchange });
  return conn;
}

export function clearConnectionSessionCache(): void {
  clearConnSession();
}

export async function cmdPositions(opts: {
  exchange?: string;
  pair?: string;
  watchSec?: number;
  polls?: number;
  json: boolean;
  jsonLines?: boolean;
  url?: string;
  pat?: string;
}, deps?: {
  fetchOnce?: (connectionId: string, pat: string, url?: string) => Promise<unknown>;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<void> {
  const pairFilter = opts.pair?.trim() ? opts.pair.trim() : undefined;
  if (opts.pair !== undefined && !pairFilter) {
    console.error("Usage: jw3 positions [--exchange kucoin] [--pair BTC/USDT] [--watch SEC] [--polls N] [--json] [--json-lines]");
    process.exitCode = 2;
    return;
  }
  if (opts.watchSec !== undefined) {
    const bad = validateWatchSec(opts.watchSec);
    if (bad) {
      console.error(`Bad --watch: ${bad} — nothing was called.`);
      process.exitCode = 2;
      return;
    }
  }
  if (opts.polls !== undefined) {
    const bad = validatePolls(opts.polls);
    if (bad) {
      console.error(`Bad --polls: ${bad} — nothing was called.`);
      process.exitCode = 2;
      return;
    }
  }
  const ctx = await withConnection(opts, true);
  if (!ctx) return;
  const fetchOnce =
    deps?.fetchOnce ??
    ((connectionId: string, pat: string, url?: string) =>
      callTool(
        "read_live_datum",
        { kind: "positions", connectionId, withExits: true },
        pat,
        url,
      ));
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const jsonLine = Boolean(opts.json || opts.jsonLines);
  const printOneShot = (out: unknown): void => {
    const { filtered } = filterPositions(out, pairFilter);
    if (jsonLine) console.log(JSON.stringify(filtered));
    else console.log(JSON.stringify(filtered, null, 2));
  };
  try {
    if (opts.watchSec === undefined) {
      const out = await fetchOnce(ctx.conn.id, ctx.pat, ctx.url);
      printOneShot(out);
      return;
    }
    const intervalMs = Math.round(opts.watchSec * 1000);
    const total = opts.polls ?? Number.POSITIVE_INFINITY;
    const totalLabel = Number.isFinite(total) ? String(total) : "∞";
    if (!jsonLine) {
      console.log(
        `WATCH positions${pairFilter ? ` ${pairFilter}` : ""} on ${ctx.conn.exchange} every ${opts.watchSec}s (${totalLabel} polls) — Ctrl-C to stop`,
      );
    } else {
      console.log(
        JSON.stringify({
          event: "start",
          kind: "positions-watch",
          exchange: ctx.conn.exchange,
          ...(pairFilter ? { pair: pairFilter } : {}),
          intervalSec: opts.watchSec,
          polls: Number.isFinite(total) ? total : null,
        }),
      );
    }
    for (let i = 1; i <= total; i++) {
      let out: unknown;
      try {
        out = await fetchOnce(ctx.conn.id, ctx.pat, ctx.url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (jsonLine) console.log(JSON.stringify({ poll: i, status: "error", error: msg }));
        else console.log(`POLL ${i}/${totalLabel}: fetch failed: ${msg}`);
        if (i < total) await sleep(intervalMs);
        continue;
      }
      const { filtered, kept, total: seen } = filterPositions(out, pairFilter);
      if (jsonLine) {
        if (filtered && typeof filtered === "object" && !Array.isArray(filtered)) {
          console.log(JSON.stringify({ poll: i, ...(filtered as Record<string, unknown>) }));
        } else {
          console.log(JSON.stringify({ poll: i, snapshot: filtered }));
        }
      } else {
        console.log(`POLL ${i}/${totalLabel} @ ${new Date().toISOString()} — ${kept}/${seen} position(s)${pairFilter ? ` for ${pairFilter}` : ""}`);
        for (const row of collectRows(filtered)) console.log(`  ${formatPositionLine(row)}`);
        if (kept === 0) console.log("  (empty — no open positions match)");
      }
      if (i < total) await sleep(intervalMs);
    }
    if (Number.isFinite(total)) {
      if (jsonLine) {
        console.log(
          JSON.stringify({ event: "done", kind: "positions-watch", polls: total, status: "complete" }),
        );
      } else {
        console.log(`WATCH DONE — ${total} poll(s) complete. Re-run to keep watching.`);
      }
    }
  } catch (e) {
    fail(e);
  }
}

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

export async function cmdBalances(opts: {
  exchange?: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const ctx = await withConnection(opts, false);
  if (!ctx) return;
  try {
    const out = await callTool(
      "read_live_datum",
      { kind: "balances", connectionId: ctx.conn.id },
      ctx.pat,
      ctx.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}

export async function cmdOrders(opts: {
  exchange: string;
  pair?: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange) {
    console.error("Usage: jw3 orders --exchange kucoin [--pair BTC/USDT] [--json]");
    process.exitCode = 2;
    return;
  }
  try {
    const out = await callTool(
      "list_open_orders",
      { exchange: opts.exchange, ...(opts.pair ? { pair: opts.pair } : {}) },
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}

export async function cmdOrderStatus(opts: {
  exchange: string;
  orderId: string;
  pair?: string;
  market?: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const ctx = await withConnection({ exchange: opts.exchange, json: opts.json, url: opts.url, pat: opts.pat }, false);
  if (!ctx) return;
  if (!opts.orderId) {
    console.error("Usage: jw3 order --exchange kucoin --order-id … [--pair …] [--market spot|futures]");
    process.exitCode = 2;
    return;
  }
  try {
    const out = await callTool(
      "read_live_datum",
      {
        kind: "order",
        connectionId: ctx.conn.id,
        orderId: opts.orderId,
        ...(opts.pair ? { symbol: opts.pair } : {}),
        ...(opts.market ? { category: opts.market } : {}),
      },
      ctx.pat,
      ctx.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}

export async function cmdOnchain(opts: {
  chains?: string;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  try {
    const out = await callTool(
      "read_onchain_balances",
      opts.chains ? { chains: opts.chains } : {},
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}
