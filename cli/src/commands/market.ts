/**
 * Authenticated market/account reads (MCP read_live_datum family).
 * CEX position/balance/order reads need a connectionId — resolved here
 * from list_connections so the user names an exchange, not an id.
 */
import { resolvePat } from "../config.js";
import { McpError, callTool } from "../mcp.js";
import { clearConnSession, connSessionKey, getConnSession, setConnSession } from "../cache.js";
import { listConnections, pickConnection, resolveReadTargets, noTargetsError, needPat, fail } from "./market-conn.js";
import type { Conn } from "./market-conn.js";
import { validateWatchSec, validatePolls, collectRows, filterPositions, formatPositionLine, normalizeVenueFlag, printVenueBalances } from "./market-format.js";
import type {  } from "./market-format.js";

export * from "./market-conn.js";
export * from "./market-format.js";

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
  list?: (pat: string, url?: string) => Promise<Conn[]>;
  call?: (tool: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown>;
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
  const pat = needPat(opts.pat);
  if (!pat) return;
  // Friendly pre-check only — the fan-out itself is one server call (the
  // server answers the {kind, observedAt, venues:[...]} envelope with a
  // per-connection status). Never narrow to pool[0] client-side.
  try {
    const rows = await (deps?.list ?? listConnections)(pat, opts.url);
    if (resolveReadTargets(rows, opts.exchange).length === 0) {
      console.error(noTargetsError(opts.exchange));
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    fail(e);
    return;
  }
  const readArgs: Record<string, unknown> = {
    kind: "positions",
    withExits: true,
    ...(opts.exchange ? { exchange: opts.exchange } : {}),
  };
  const pollOnce = () =>
    (deps?.call ?? callTool)("read_live_datum", { ...readArgs }, pat, opts.url);
  const where = opts.exchange ?? "all connections";
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const jsonLine = Boolean(opts.json || opts.jsonLines);
  const printOneShot = (out: unknown): void => {
    const { filtered } = filterPositions(out, pairFilter);
    if (jsonLine) console.log(JSON.stringify(filtered));
    else console.log(JSON.stringify(filtered, null, 2));
  };
  try {
    if (opts.watchSec === undefined) {
      const out = await pollOnce();
      printOneShot(out);
      return;
    }
    const intervalMs = Math.round(opts.watchSec * 1000);
    const total = opts.polls ?? Number.POSITIVE_INFINITY;
    const totalLabel = Number.isFinite(total) ? String(total) : "∞";
    if (!jsonLine) {
      console.log(
        `WATCH positions${pairFilter ? ` ${pairFilter}` : ""} on ${where} every ${opts.watchSec}s (${totalLabel} polls) — Ctrl-C to stop`,
      );
    } else {
      console.log(
        JSON.stringify({
          event: "start",
          kind: "positions-watch",
          ...(opts.exchange ? { exchange: opts.exchange } : { scope: "all" }),
          ...(pairFilter ? { pair: pairFilter } : {}),
          intervalSec: opts.watchSec,
          polls: Number.isFinite(total) ? total : null,
        }),
      );
    }
    for (let i = 1; i <= total; i++) {
      let out: unknown;
      try {
        out = await pollOnce();
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


export async function cmdBalances(opts: {
  exchange?: string;
  venue?: string;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: {
  list?: (pat: string, url?: string) => Promise<Conn[]>;
  call?: (tool: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown>;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  // Venue-held funds (read_venue_balances): --venue <slug|all> reads the
  // venue legs. `all` prints the CEX fan-out AND the venue rows side by
  // side, NOT merged. Omit --venue for the CEX-only read (unchanged).
  if (opts.venue !== undefined) {
    const venue = normalizeVenueFlag(opts.venue === "" ? "all" : opts.venue);
    if (!venue) {
      console.error(`Unknown venue '${String(opts.venue).slice(0, 32)}' — use dydx|hyperliquid|polymarket|aster|pacifica|all. Nothing was called.`);
      process.exitCode = 2;
      return;
    }
    try {
      const call = deps?.call ?? callTool;
      if (venue !== "all") {
        const out = await call("read_venue_balances", { venue }, pat, opts.url);
        printVenueBalances(out, opts.json);
        return;
      }
      const rows = await (deps?.list ?? listConnections)(pat, opts.url);
      const targets = resolveReadTargets(rows, opts.exchange);
      const cexOut = targets.length > 0
        ? await call(
          "read_live_datum",
          { kind: "balances", ...(opts.exchange ? { exchange: opts.exchange } : {}) },
          pat,
          opts.url,
        )
        : null;
      if (targets.length === 0) console.error("CEX: no connections — venue rows only.");
      const venuesOut = await call("read_venue_balances", { venue: "all" }, pat, opts.url);
      if (opts.json) {
        console.log(JSON.stringify({ cex: cexOut, venues: venuesOut }));
        return;
      }
      printVenueBalances(venuesOut, false);
    } catch (e) {
      fail(e);
    }
    return;
  }
  try {
    const rows = await (deps?.list ?? listConnections)(pat, opts.url);
    if (resolveReadTargets(rows, opts.exchange).length === 0) {
      console.error(noTargetsError(opts.exchange));
      process.exitCode = 1;
      return;
    }
    // One server call — the server fans out across every active connection
    // (or every same-slug connection with --exchange) and answers the
    // {kind, observedAt, venues:[...]} envelope with a per-connection
    // status. Never narrow to pool[0] client-side.
    const out = await (deps?.call ?? callTool)(
      "read_live_datum",
      { kind: "balances", ...(opts.exchange ? { exchange: opts.exchange } : {}) },
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}

export async function cmdOrders(opts: {
  exchange?: string;
  pair?: string;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: {
  call?: (tool: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown>;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  // --exchange is optional: omit it and the server fans out across every
  // active connection (same per-venue envelope as agent-chat open_orders).
  try {
    const out = await (deps?.call ?? callTool)(
      "list_open_orders",
      {
        ...(opts.exchange ? { exchange: opts.exchange } : {}),
        ...(opts.pair ? { pair: opts.pair } : {}),
      },
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
}, deps?: {
  list?: (pat: string, url?: string) => Promise<Conn[]>;
}): Promise<void> {
  const ctx = await withConnection({ exchange: opts.exchange, json: opts.json, url: opts.url, pat: opts.pat }, false, deps);
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
}, deps?: {
  call?: (tool: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown>;
}): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  try {
    // read_onchain_balances now carries a per-wallet `reads` array (ok |
    // empty | invalid-address | no-wallet) next to balances + aggregate —
    // every linked wallet and every requested chain is accounted for.
    const out = await (deps?.call ?? callTool)(
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