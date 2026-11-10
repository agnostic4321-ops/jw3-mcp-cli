/**
 * Market connections + CLI auth guards (split from market.ts).
 * listConnections/pickConnection/resolveReadTargets resolve the CEX
 * connectionId behind --exchange; needPat/fail gate every command.
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

/** One CEX connection targeted by a fan-out read. */
export type CexReadTarget = { id: string; exchange: string; label: string | null };

/**
 * Resolve fan-out targets: every active connection bare, or EVERY
 * connection matching one venue slug with --exchange (never pool[0]).
 */
export function resolveReadTargets(rows: Conn[], exchange?: string): CexReadTarget[] {
  const pool = exchange
    ? rows.filter((c) => c.exchange.toLowerCase() === exchange.toLowerCase())
    : rows;
  return pool.map((c) => ({ id: c.id, exchange: c.exchange, label: c.label ?? null }));
}

export function noTargetsError(exchange?: string): string {
  return exchange
    ? `No connection for ${exchange} — connect it in-app first.`
    : "No CEX connections — connect one in-app first.";
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
