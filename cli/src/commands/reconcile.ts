/**
 * `reconcile` — order-state audit for one pair (READ-ONLY, never trades).
 *
 * Compares local supervisor state (scalp/grid/trail files) against venue
 * truth (open positions + working orders) and reports strays:
 * unmanaged positions, unowned working orders, stale state files, or
 * unreadable states. Exit 1 on error-level strays, 0 when clean (warns
 * print but pass). Without a PAT only the local side is reported and the
 * venue is marked unchecked.
 */
import { callTool } from "../mcp.js";
import {
  classifyStrays,
  readLocalStates,
  rowMatchesPair,
  type VenueRow,
} from "../reconcile.js";
import { collectRows, listConnections, pickConnection } from "./market.js";
import { resolvePat } from "../config.js";
import { extractOpenOrders } from "./trade.js";

export type ReconcileDeps = {
  call?: typeof callTool;
  listConns?: typeof listConnections;
  stateDir?: string;
};

export async function cmdReconcile(
  opts: { exchange: string; pair: string; json: boolean; url?: string; pat?: string },
  deps?: ReconcileDeps,
): Promise<void> {
  if (!opts.exchange || !opts.pair || !opts.pair.includes("/")) {
    console.error("Usage: jw3 reconcile --exchange kucoin --pair BTC/USDT [--json]");
    process.exitCode = 2;
    return;
  }
  const base = (opts.pair.split("/")[0] ?? "").toUpperCase();
  if (!base) {
    console.error("Usage: jw3 reconcile --exchange kucoin --pair BTC/USDT [--json]");
    process.exitCode = 2;
    return;
  }
  const call = deps?.call ?? callTool;
  const { states, unreadable } = readLocalStates(base, deps?.stateDir);
  const pat = resolvePat(opts.pat);
  let positions: VenueRow[] | null = null;
  let orders: VenueRow[] | null = null;
  let venueError: string | null = null;
  if (pat) {
    try {
      const rows = await (deps?.listConns ?? listConnections)(pat, opts.url);
      const conn = pickConnection(rows, opts.exchange, true);
      if (!conn) throw new Error(`no ${opts.exchange} connection — connect it in-app first`);
      const [posOut, ordOut] = await Promise.all([
        call("read_live_datum", { kind: "positions", connectionId: conn.id }, pat, opts.url),
        call("list_open_orders", { exchange: opts.exchange, pair: opts.pair }, pat, opts.url),
      ]);
      positions = collectRows(posOut).filter((r) => rowMatchesPair(r, opts.pair)) as VenueRow[];
      orders = extractOpenOrders(ordOut).filter((r) => rowMatchesPair(r, opts.pair)) as VenueRow[];
    } catch (e) {
      venueError = e instanceof Error ? e.message : String(e);
      positions = null;
      orders = null;
    }
  }
  const strays = classifyStrays({ pair: opts.pair, local: states, unreadable, positions, orders });
  if (venueError) {
    strays.unshift({ level: "warn", code: "venue-read-failed", detail: `venue read failed (${venueError}) — local states listed but strays unverified` });
  }
  const errors = strays.filter((s) => s.level === "error");
  const report = {
    mode: "reconcile",
    exchange: opts.exchange,
    pair: opts.pair,
    local: states.map((s) => ({ kind: s.kind, pair: s.pair, summary: s.summary, orderIds: s.orderIds })),
    positions: positions === null ? null : positions.length,
    orders: orders === null ? null : orders.length,
    strays,
    clean: errors.length === 0 && venueError === null,
  };
  if (opts.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`RECONCILE ${opts.pair} on ${opts.exchange} — ${states.length} local state(s), ${positions === null ? "venue unchecked" : `${positions.length} position(s)`}, ${orders === null ? "orders unchecked" : `${orders.length} working order(s)`}`);
    for (const s of states) console.log(`  local ${s.kind}: ${s.summary}`);
    if (strays.length === 0) console.log("CLEAN — every venue row has an owner, every state has a venue row.");
    for (const s of strays) console.log(`  ${s.level.toUpperCase()} [${s.code}] ${s.detail}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}
