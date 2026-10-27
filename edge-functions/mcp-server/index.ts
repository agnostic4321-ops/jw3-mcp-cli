// mcp-server — MCP Streamable HTTP bridge to the JW3 core agent stack.
//
// The user's own harness connects here (not to website endpoints) and talks
// agent-to-agent: this server exposes the tool surface below, fanning out to
// the existing edge functions. Auth = the user's SIWX-minted Supabase JWT as
// Bearer, or a harness PAT (jw3_mcp_…); per-user isolation via requireUser +
// user client.
//
// Protocol: JSON-RPC 2.0 at POST / (methods: initialize, tools/list,
// tools/call). Stateless per request — no session ids, no sockets (edge
// runtime has no long-lived connections). Errors use the MCP error codes.
// PATs carry scopes: mcp:read (market/account/diary/analysis),
// trade:propose (Diary setup queue, never executes), trade:execute (live
// CEX orders, only with user YOLO eligibility re-checked every call).
// The user's own harness (SIWX JWT, not a PAT) carries trade:execute by
// default — it IS the user, so no PAT scoping is needed; the per-call
// YOLO re-check still applies to every write tool.
//
// Tools: read_live_datum (positions | balances | market | screener | onchain |
// order | predictions), analyze_market (typed verdict via jev-analyze, fail-closed),
// read_diary_day (trades/setups/recap), list_connections, plus the propose_*
// and trade-execution tools below. Proposals ride the agent_action_log
// propose→approve pattern, never direct execution.
import { withHandler, fail, readJson } from "../_shared/respond.ts";
import { planRealizedPnlReconcile, lossFromPnl } from "../_shared/realized-pnl-reconcile.ts";
import { recordRealizedLossOnly, rollDailyWindowIfExpired } from "../_shared/risk-gate.ts";
import { requireUser } from "../_shared/auth.ts";
import { checkRateLimit, ipFromRequest } from "../_shared/rate-limit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { resolveOrderTarget } from "../_shared/order-resolve.ts";
// Boundary cast at call sites: the untyped service client skips the deep
// generic check (TS2589); see agent-chat for the full note.
import type { ConnectionAdmin } from "../_shared/order-resolve.ts";
import { buildCexTimeframes } from "../_shared/snapshot.ts";
import { cacheGet, cacheSet } from "../_shared/cache.ts";
import { JEV_TTL_MS, jevCacheKey } from "../_shared/jev-cache.ts";
import { requireYoloEligible } from "../_shared/execute-guard.ts";
import { TOOLS, callEdge, rpcError, rpcOk, toolError, toolOk } from "./tools.ts";
import {
  DEFI_BUILD_ACTIONS,
  GATEWAY_RATE_LIMIT,
  MAX_DEFI_AMOUNT,
  clampSlippageBps,
  internalErrorText,
  isEvmTokenAddress,
  isWalletAddress,
  logServer,
  newCorrelationId,
  normalizeDefiChainId,
  parseDefiAmount,
  toolRateLimitFor,
  upstreamErrorText,
  validateArgsAgainstSchema,
  validateChainsCsv,
  validateMarketId,
  validatePairSymbol,
  validateTokenId,
  validateVenueSlug,
  validateWalletsCsv,
  type MiniSchema,
} from "./tools.ts";
import { handleDailyPrep } from "./daily-prep.ts";
import { handleExecuteTrade } from "./execute.ts";
import { handleReserveSweep } from "./reserve.ts";
import {
  buildMcpDiaryDayPayload,
  buildMcpFillsPayload,
  buildMcpPnlPayload,
  executeDefiRead,
  executeMarketRead,
  executeOrderRead,
  executePositionsBalancesRead,
  executePredictionsRead,
  executeRiskLimitsRead,
  executeScreenerRead,
  fetchConnectionMetadata,
  fetchOnchainSnapshot,
  normalizeDiaryDay,
  type DiaryDayOut,
  type ReadDeps,
  type ReadEdgeFn,
} from "../agent-chat/read-tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "jw3-agent", version: "1.0.0" };

type RpcReq = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

/* RPC + tool envelopes and callEdge live in ./tools.ts (imported above). */

/* TOOLS lives in ./tools.ts (imported above). */


Deno.serve(withHandler("mcp-server", async (req) => {
  const corr = newCorrelationId();
  try {
    if (req.method !== "POST") return fail(405, "validation", "MCP Streamable HTTP: POST JSON-RPC only.");
    const admin = getServiceClient();

    // ── PRE-AUTH GATEWAY BUCKET (per IP, before anything parses) ──
    // Unauthenticated callers share the user's budget otherwise: a blind
    // flood would eat the per-user minute before requireUser rejects it.
    // Fail closed: when the limiter itself is down, refuse rather than
    // hand out a free pass. No request id exists yet (nothing parsed),
    // so this is the one rate-limit path that answers id null.
    try {
      const gw = await checkRateLimit(admin, {
        bucket: GATEWAY_RATE_LIMIT.bucket,
        subject: `ip:${ipFromRequest(req)}`,
        limit: GATEWAY_RATE_LIMIT.limit,
        windowSec: GATEWAY_RATE_LIMIT.windowSec,
        failClosed: true,
      });
      if (!gw.ok) {
        logServer(corr, `gateway rate-limited: ${gw.error}`);
        return rpcError(null, -32002, `rate_limited: gateway busy (ref ${corr})`);
      }
    } catch (e) {
      logServer(corr, "gateway limiter failed:", e instanceof Error ? e.message : e);
      return rpcError(null, -32002, `rate_limited: limiter unavailable (ref ${corr})`);
    }

    // Capped read: unbounded req.json() burns isolate memory with zero
    // limiter cost. Invalid/over-cap bodies fall back to {} so the
    // JSON-RPC Invalid Request envelope below is preserved (id null:
    // nothing parseable to echo).
    const jr = await readJson<RpcReq>(req, undefined, { maxBytes: 256 * 1024 });
    const body = (jr.ok ? jr.value : {}) as RpcReq;
    // Echo the caller's id on auth/rate-limit errors whenever a body
    // parsed (null only when nothing parseable arrived).
    const reqId = (jr.ok && body && typeof body === "object" && "id" in body ? body.id : null) ?? null;
    if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") {
      return rpcError(reqId, -32600, "Invalid Request: expected JSON-RPC 2.0 with method.");
    }
    // Non-object params are a protocol error, not a tool error.
    if (body.params !== undefined && (typeof body.params !== "object" || body.params === null || Array.isArray(body.params))) {
      return rpcError(reqId, -32602, "Invalid params: params must be an object.");
    }
    const authResult = await requireUser(req);
    if (!authResult.ok) {
      logServer(corr, `auth rejected: status=${authResult.status}`);
      return rpcError(reqId, -32001, `unauthorized: bad credentials (ref ${corr})`);
    }
    const { userId, authHeader } = authResult;
    const scopes = authResult.scopes ?? [];
    const viaPat = authResult.via === "pat";
    const params = body.params ?? {};
    const supaUrl = Deno.env.get("SUPABASE_URL") || "";

    // ── RATE LIMIT, PER TOOL BUDGET ──
    //
    // The budget is NOT uniform, because the tools are not equal in kind.
    //
    // A read is cheap and replaceable: if it is throttled, the caller
    // simply tries again.
    //
    // A WRITE that PROTECTS a position is neither. `set_exits` is what
    // arms the stop and the take-profit. If it is throttled AFTER the
    // entry filled, the position is live and UNPROTECTED — leveraged,
    // with no stop. That is the worst state a trading system can be in,
    // and a uniform per-minute limit can produce it: a scanner makes
    // many reads, the entry goes through on the last call inside the
    // window, and the exit call lands on the first call outside it.
    //
    // So the exit-arming path gets its own bucket, sized so that a
    // position can ALWAYS be protected no matter how noisy the reads
    // were. The read budget stays tight, because reads are what a
    // scanner burns.
    //
    // Heavy fan-outs (daily_prep, analyze_market, list_fills,
    // read_closed_pnl, reconcile_realized_pnl) get their own LOWER
    // budgets via toolRateLimitFor: one expensive call must not eat the
    // minute the protection path may need.
    const toolName = typeof params?.name === "string" ? params.name : "";
    const isProtection = toolName === "set_exits" || toolName === "cancel_order";
    const budget = toolRateLimitFor(toolName, isProtection);
    try {
      const rl = await checkRateLimit(admin, {
        bucket: budget.bucket,
        subject: userId,
        limit: budget.limit,
        windowSec: budget.windowSec,
        failClosed: true,
      });
      if (!rl.ok) {
        logServer(corr, `per-user rate-limited: tool=${toolName || "?"} bucket=${budget.bucket}`);
        return rpcError(reqId, -32002, `rate_limited: slow down (ref ${corr})`);
      }
    } catch (e) {
      logServer(corr, "per-user limiter failed:", e instanceof Error ? e.message : e);
      return rpcError(reqId, -32002, `rate_limited: limiter unavailable (ref ${corr})`);
    }

    // Shared read execution (agent-chat/read-tools.ts is the ONE
    // implementation; this transport keeps only validation wording +
    // envelopes). The throwing callEdge adapts into the shared
    // result-envelope shape here.
    const readEdge: ReadEdgeFn = async (slug, body, ms) => {
      try {
        return { ok: true, status: 200, json: await callEdge(supaUrl, authHeader, slug, body, ms) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = /^(\S+) (\d+): ([\s\S]*)$/.exec(msg);
        if (m) {
          let json: unknown = { error: msg };
          try { json = JSON.parse(m[3]); } catch { /* keep the wrapped message */ }
          return { ok: false, status: Number(m[2]), json };
        }
        return { ok: false, status: 502, json: { error: msg } };
      }
    };
    const readDeps: ReadDeps = { admin, userId, supaUrl, authHeader, callEdge: readEdge };
    // Shared { error } payload → generic upstream envelope with a ref.
    // The full detail goes to the server log under the same ref; raw
    // downstream text never reaches the wire.
    const readResult = (id: unknown, label: string, payload: unknown) => {
      if (payload && typeof payload === "object" && "error" in payload) {
        logServer(corr, `${label || "read"} failed:`, JSON.stringify(payload).slice(0, 2000));
        return toolError(id, upstreamErrorText(corr));
      }
      return toolOk(id, payload);
    };

    if (body.method === "initialize") {
      return rpcOk(body.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    if (body.method === "ping") {
      return rpcOk(body.id, {});
    }
    if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      // No pagination needed at 13 tools, but accept cursor for conformance.
      return rpcOk(body.id, { tools: TOOLS });
    }
    if (body.method === "tools/call") {
      const name = params.name as string | undefined;
      // Arguments ride next to the method name: a non-object there is a
      // protocol error, rejected before any dispatch or validation wording.
      const rawArgs = params.arguments ?? {};
      if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
        return rpcError(reqId, -32602, "Invalid params: arguments must be an object.");
      }
      let args = { ...(rawArgs as Record<string, unknown>) };
      // Central inputSchema check at the same point: closed schemas stay
      // closed even when a handler branch forgets its own shape check.
      const toolDef = (TOOLS as Array<{ name: string; inputSchema?: MiniSchema }>).find((t) => t.name === name);
      if (!toolDef) return toolError(body.id, `validation: Unknown tool: ${name ?? "(missing)"}`);
      const schemaErr = validateArgsAgainstSchema(toolDef.inputSchema, args);
      if (schemaErr) return rpcError(reqId, -32602, `Invalid params: ${schemaErr}.`);
      // PATs without mcp:read get nothing — JWT callers keep legacy read access.
      if (viaPat && !scopes.includes("mcp:read") && !scopes.includes("trade:execute") && !scopes.includes("trade:propose")) {
        return toolError(body.id, "auth: PAT needs the mcp:read scope for reads (mint it in Settings → Harness Access)");
      }
      try {
        if (name === "read_live_datum") {
          const kind = String(args.kind || "");
          if (kind === "positions" || kind === "balances") {
            // Shared fan-out (same reader as agent-chat): one connectionId,
            // one venue slug, or every connection (capped) — merged with
            // per-venue provenance. Matches the shared schema text ("omit
            // to read every active connection").
            if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
              const venueCheck = validateVenueSlug(args.exchange);
              if (!venueCheck.ok) return toolError(body.id, `validation: read_live_datum ${kind}: ${venueCheck.error}`);
            }
            return readResult(body.id, `${kind} read`, await executePositionsBalancesRead(kind, args, readDeps));
          }
          if (kind === "market") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: read_live_datum market: ${venueCheck.error}`);
            const symCheck = validatePairSymbol(args.symbol, "symbol");
            if (!symCheck.ok) return toolError(body.id, `validation: read_live_datum market: ${symCheck.error}`);
            let marketOut: unknown;
            try {
              marketOut = await executeMarketRead(venueCheck.venue, symCheck.value, readDeps);
            } catch (e) {
              logServer(corr, "market read threw:", e instanceof Error ? e.message : e);
              return toolError(body.id, upstreamErrorText(corr));
            }
            return readResult(body.id, "market read", marketOut);
          }
          if (kind === "screener") {
            // Shared bulk-tickers reader (same slimming as agent-chat).
            if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
              const venueCheck = validateVenueSlug(args.exchange);
              if (!venueCheck.ok) return toolError(body.id, `validation: read_live_datum screener: ${venueCheck.error}`);
              args = { ...args, exchange: venueCheck.venue };
            }
            return readResult(body.id, "screener read", await executeScreenerRead(args, readDeps));
          }
          if (kind === "onchain") {
            // Shared wallet-scope reader (same fetch + aggregate as agent-chat).
            const chainsCheck = validateChainsCsv(args.chains);
            if (!chainsCheck.ok) return toolError(body.id, `validation: read_live_datum onchain: ${chainsCheck.error}`);
            const chainsArg = chainsCheck.chains || args.chains;
            return readResult(body.id, "onchain read", await fetchOnchainSnapshot(chainsArg, readDeps));
          }
          if (kind === "order") {
            // Single-order status ("did my order fill?"). connectionId is
            // REQUIRED — an order id is connection-scoped. Served by
            // cex-proxy `orderStatus`: live book, then bounded recent
            // fills, else honest unknown (never invented). Read-only: no
            // writeGate here (same as list_open_orders).
            const connectionId = typeof args.connectionId === "string" ? args.connectionId : "";
            const orderId = typeof args.orderId === "string" ? args.orderId : "";
            if (!connectionId) return toolError(body.id, "validation: read_live_datum order requires connectionId");
            if (!orderId) return toolError(body.id, "validation: read_live_datum order requires orderId");
            const symbol = typeof args.symbol === "string" ? args.symbol : "";
            const category = typeof args.category === "string" ? args.category : "";
            if (symbol.trim() !== "") {
              const symCheck = validatePairSymbol(symbol, "symbol");
              if (!symCheck.ok) return toolError(body.id, `validation: read_live_datum order: ${symCheck.error}`);
            }
            if (category.trim() !== "" && category.toLowerCase() !== "spot" && category.toLowerCase() !== "linear") {
              return toolError(body.id, "validation: read_live_datum order category must be spot|linear");
            }
            return readResult(body.id, "order read", await executeOrderRead({
              connectionId,
              orderId,
              ...(symbol ? { symbol } : {}),
              ...(category ? { category } : {}),
            }, readDeps));
          }
          if (kind === "predictions") {
            // Shared prediction reader (same scopes + proxy legs as
            // agent-chat). scope=quote needs a market or token selector —
            // validated here to keep the pinned wording.
            const venueRaw = typeof args.venue === "string" ? args.venue.trim().toLowerCase() : "";
            if (venueRaw !== "" && venueRaw !== "polymarket" && venueRaw !== "opinion" && venueRaw !== "all") {
              return toolError(body.id, "validation: predictions venue must be polymarket|opinion|all");
            }
            if (args.market_id !== undefined && args.market_id !== null && String(args.market_id).trim() !== "") {
              const mid = validateMarketId(args.market_id);
              if (!mid.ok) return toolError(body.id, `validation: predictions ${mid.error}`);
            }
            if (args.token_id !== undefined && args.token_id !== null && String(args.token_id).trim() !== "") {
              const tid = validateTokenId(args.token_id);
              if (!tid.ok) return toolError(body.id, `validation: predictions ${tid.error}`);
            }
            if (args.wallets !== undefined && args.wallets !== null && String(args.wallets).trim() !== "") {
              const wal = validateWalletsCsv(args.wallets);
              if (!wal.ok) return toolError(body.id, `validation: predictions ${wal.error}`);
            }
            const quoteScope = typeof args.scope === "string" ? args.scope.toLowerCase() : "markets";
            const quoteMarket = typeof args.market_id === "string" ? args.market_id
              : (typeof args.symbol === "string" ? args.symbol : "");
            const quoteToken = typeof args.token_id === "string" ? args.token_id : "";
            if (quoteScope === "quote" && !quoteMarket && !quoteToken) {
              return toolError(body.id, "validation: predictions scope=quote needs market_id (conditionId/slug/Opinion id) and/or token_id");
            }
            return toolOk(body.id, await executePredictionsRead(args, readDeps));
          }
          return toolError(body.id, "validation: read_live_datum kind must be positions|balances|market|screener|onchain|order|predictions");
        }
        if (name === "analyze_market") {
          // JEV verdict TTL (15 min per market): a fresh-window read is
          // served from the in-process entry — no candle rebuild, no
          // jev-analyze/Decisions call, no provider cost. Snapshot bytes
          // are NOT part of the key (see _shared/jev-cache.ts).
          if (String(args.family ?? "") === "cex") {
            const famVenue = args.venue ?? args.exchange;
            if (famVenue !== undefined && famVenue !== null && String(famVenue).trim() !== "") {
              const vc = validateVenueSlug(famVenue);
              if (!vc.ok) return toolError(body.id, `validation: analyze_market: ${vc.error}`);
            }
            const famSym = args.symbol ?? args.pair;
            if (famSym !== undefined && famSym !== null && String(famSym).trim() !== "") {
              const sc = validatePairSymbol(famSym, "symbol");
              if (!sc.ok) return toolError(body.id, `validation: analyze_market: ${sc.error}`);
            }
          }
          const family = String(args.family ?? "");
          const venueNorm = String(args.venue ?? args.exchange ?? (family === "prediction" ? "polymarket" : ""));
          const symbolNorm = String(args.symbol ?? args.pair ?? "");
          const cacheable = family !== "" && venueNorm !== "" && symbolNorm !== "";
          const cacheKey = cacheable ? jevCacheKey(family, venueNorm, symbolNorm) : "";
          if (cacheKey) {
            const hit = cacheGet<Record<string, unknown>>(cacheKey);
            if (hit !== undefined) return toolOk(body.id, { ...hit, cached: true });
          }
          // Cap the forwarded snapshot: JEV computes indicators in code and
          // the Decisions call bills input tokens — refuse dumps, not data.
          const snapIn = (args.snapshot ?? {}) as Record<string, unknown>;
          let snapshot: Record<string, unknown> = snapIn;
          if (!Array.isArray(snapIn.timeframes) || snapIn.timeframes.length === 0) {
            if (family === "prediction") {
              // No candles in this family: the caller posts a complete
              // market+brief (prediction) snapshot — forward it as-is instead
              // of forcing a CEX candle build.
              const hasMarket = snapIn.market != null && typeof snapIn.market === "object";
              if (!hasMarket) {
                return toolError(body.id, `validation: analyze_market family=${family} needs snapshot.market+brief (prediction)`);
              }
            } else {
              // Server-built candles: caller passes venue+symbol only
              // (chat aliases exchange/pair accepted, same as consult_jev).
              const venue = String(args.venue ?? args.exchange ?? "");
              const symbol = String(args.symbol ?? args.pair ?? "");
              if (!venue || !symbol) {
                return toolError(body.id, "validation: analyze_market needs venue+symbol (server builds candles) or a snapshot with timeframes");
              }
              const tfs = await buildCexTimeframes(async (body) => {
                return await callEdge(supaUrl, authHeader, "cex-proxy", body, 30000);
              }, venue, symbol);
              if (tfs.length === 0) return toolError(body.id, "upstream: could not build candle snapshot from venue");
              snapshot = { ...snapIn, timeframes: tfs, built_by: "server" };
            }
          }
          const snapLen = JSON.stringify(snapshot).length;
          if (snapLen > 40000) return toolError(body.id, "validation: snapshot too large (>40KB serialized); send compact feature vectors");
          let out: unknown;
          try {
            out = await callEdge(supaUrl, authHeader, "jev-analyze", {
              family: args.family, venue: args.venue ?? args.exchange, symbol: args.symbol ?? args.pair,
              snapshot, snapshotAt: new Date().toISOString(),
            });
          } catch (e) {
            logServer(corr, "jev-analyze failed:", e instanceof Error ? e.message : e);
            return toolError(body.id, upstreamErrorText(corr));
          }
          if (cacheKey && out && typeof out === "object") {
            cacheSet(cacheKey, { ...(out as Record<string, unknown>), cached: false }, JEV_TTL_MS);
          }
          return toolOk(body.id, out);
        }
        if (name === "read_diary_day") {
          // Cap-safe slim payload (never the raw day record): the full
          // setup/action rows serialize past the tool-message cap and get
          // sliced mid-JSON, hiding tonight's trades from `jw3 diary`.
          const day = normalizeDiaryDay(args.day);
          let out: DiaryDayOut;
          try {
            out = await callEdge(supaUrl, authHeader, "diary-day", { day }) as DiaryDayOut;
          } catch (e) {
            logServer(corr, "diary-day failed:", e instanceof Error ? e.message : e);
            return toolError(body.id, upstreamErrorText(corr));
          }
          return toolOk(body.id, buildMcpDiaryDayPayload(out, day));
        }
        if (name === "list_connections") {
          // Metadata only — the ONE shared implementation (see
          // agent-chat/read-tools.ts); never secrets.
          try {
            return toolOk(body.id, { connections: await fetchConnectionMetadata(admin, userId) });
          } catch (e) {
            logServer(corr, "list_connections failed:", e instanceof Error ? e.message : e);
            return toolError(body.id, upstreamErrorText(corr));
          }
        }
        if (name === "propose_trade") {
          // trade:execute is the default scope for the user's own harness
          // (JWT) — PAT callers need trade:propose or trade:execute minted.
          if (viaPat && !scopes.includes("trade:propose") && !scopes.includes("trade:execute")) {
            return toolError(body.id, "auth: propose_trade needs the trade:propose scope (mint it in Settings → Harness Access)");
          }
          const pair = typeof args.pair === "string" ? args.pair : "";
          const side = typeof args.side === "string" ? args.side.toLowerCase() : "";
          const entry = typeof args.entry === "number" ? args.entry : NaN;
          const stop = typeof args.stop === "number" ? args.stop : NaN;
          const sizeUsd = typeof args.size_usd === "number" ? args.size_usd : null;
          if (!pair || !["buy", "sell", "long", "short"].includes(side)) {
            return toolError(body.id, "validation: propose_trade needs pair + side buy|sell|long|short");
          }
          const pairCheck = validatePairSymbol(pair);
          if (!pairCheck.ok) return toolError(body.id, `validation: propose_trade: ${pairCheck.error}`);
          let venueNorm: string | null = null;
          if (typeof args.venue === "string" && args.venue.trim() !== "") {
            const venueCheck = validateVenueSlug(args.venue);
            if (!venueCheck.ok) return toolError(body.id, `validation: propose_trade: ${venueCheck.error}`);
            venueNorm = venueCheck.venue;
          }
          if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0) {
            return toolError(body.id, "validation: propose_trade needs entry > 0 and stop > 0 — never 0/null placeholders");
          }
          if (sizeUsd != null && (!Number.isFinite(sizeUsd) || sizeUsd <= 0)) {
            return toolError(body.id, "validation: size_usd must be > 0 when provided");
          }
          const sideNorm = side === "long" ? "buy" : side === "short" ? "sell" : side;
          // Vote capture matches agent-chat: a caller-supplied JEV verdict or
          // Kronos oracle vote rides indicators when present, explicit nulls
          // when absent so "no vote" stays visible, never invented.
          const mcpJev = typeof args.jev_verdict === "string" && args.jev_verdict
            ? (args.jev_verdict as string).slice(0, 1000)
            : null;
          const mcpInv = typeof args.invalidation === "string" && args.invalidation
            ? (args.invalidation as string).slice(0, 500)
            : null;
          const mcpKronDir = typeof args.kronos_direction === "string" &&
              ["up", "down", "flat"].includes((args.kronos_direction as string).toLowerCase())
            ? (args.kronos_direction as string).toLowerCase()
            : null;
          const mcpKronMove = typeof args.kronos_expected_move_pct === "number" &&
              Number.isFinite(args.kronos_expected_move_pct)
            ? args.kronos_expected_move_pct as number
            : null;
          const mcpKronHz = typeof args.kronos_horizon === "number" &&
              Number.isInteger(args.kronos_horizon) && (args.kronos_horizon as number) > 0
            ? args.kronos_horizon as number
            : null;
          const { data, error } = await admin.from("trade_setups").insert({
            user_id: userId, mode: "live",
            venue: venueNorm,
            asset: typeof args.asset === "string" ? args.asset : pair.split("/")[0] ?? null,
            pair, side: sideNorm, entry, stop,
            timeframe: typeof args.timeframe === "string" ? args.timeframe : null,
            thesis: typeof args.thesis === "string" ? args.thesis.slice(0, 2000) : null,
            size_usd: sizeUsd,
            indicators: {
              source: viaPat ? "mcp-harness" : "mcp-jwt",
              jev_verdict: mcpJev, invalidation: mcpInv,
              kronos_direction: mcpKronDir,
              kronos_expected_move_pct: mcpKronMove,
              kronos_horizon: mcpKronHz,
              kronos_captured_at: mcpKronDir != null && typeof args.kronos_captured_at === "string"
                ? args.kronos_captured_at
                : null,
            },
            status: "proposed",
          }).select("id").single();
          if (error || !data) return toolError(body.id, "upstream: could not record proposal");
          return toolOk(body.id, { setup_id: (data as { id: string }).id, status: "proposed", approve_in: "Diary → setups → Send to ticket" });
        }
        if (name === "read_onchain_balances") {
          // Alias of read_live_datum kind=onchain (same reader, same shape).
          // Read-only: mcp:read suffices. Addresses only, never keys.
          const chainsCheck = validateChainsCsv(args.chains);
          if (!chainsCheck.ok) return toolError(body.id, `validation: read_onchain_balances: ${chainsCheck.error}`);
          const chainsArg = chainsCheck.chains || args.chains;
          return readResult(body.id, "onchain read", await fetchOnchainSnapshot(chainsArg, readDeps));
        }
        // Write tools share one gate: trade:execute PAT + per-call YOLO
        // eligibility via the shared execute guard (same predicate as
        // trade:execute mints and chat YOLO). Capped again inside cex-proxy
        // per order.
        const writeGate = async (tool: string): Promise<{ ok: true } | { ok: false; response: Response }> => {
          // trade:execute is the default scope for the user's own harness
          // (JWT) — only PAT callers need it minted. YOLO eligibility is
          // re-checked on every call below regardless of caller.
          if (viaPat && !scopes.includes("trade:execute")) {
            return { ok: false, response: toolError(body.id, `auth: ${tool} needs a PAT with the trade:execute scope`) };
          }
          const blocked = await requireYoloEligible(admin, userId);
          if (blocked) {
            return { ok: false, response: toolError(body.id, `blocked: ${tool} blocked: ${blocked}`) };
          }
          return { ok: true };
        };
        if (name === "close_position") {
          const gate = await writeGate("close_position");
          if (!gate.ok) return gate.response;
          const side = typeof args.side === "string" ? args.side.toLowerCase() : "";
          if (side !== "long" && side !== "short") {
            return toolError(body.id, "validation: close_position needs side long|short (the OPEN position's side)");
          }
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: close_position: ${venueCheck.error}`);
          }
          if (typeof args.pair === "string" && args.pair.trim() !== "") {
            const pairCheck = validatePairSymbol(args.pair);
            if (!pairCheck.ok) return toolError(body.id, `validation: close_position: ${pairCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const size = typeof args.size === "string" && args.size.trim() !== "" ? args.size.trim() : undefined;
          if (size !== undefined && (!Number.isFinite(parseFloat(size)) || parseFloat(size) <= 0)) {
            return toolError(body.id, "validation: close_position size must be > 0 in base units when provided");
          }
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "closePosition", connectionId: target.connectionId,
            symbol: typeof args.pair === "string" ? args.pair : "",
            category: "linear", side, ...(size !== undefined ? { size: parseFloat(size) } : {}),
          }, 45000);
          const execStatus = (out as { error?: unknown }).error == null ? "executed" : "failed";
          await admin.from("agent_action_log").insert({
            user_id: userId, action_type: "trade_cex", status: execStatus,
            params: { mcp_close: true, ticket: args, resolved: { connectionId: target.connectionId, exchange: target.exchange } }, result: out, decided_via: "mcp-yolo",
          });
          // Diary trail: a venue close ends the setups opened for this pair —
          // stamp them expired (outcome unknown unless already scored) so
          // they leave the open set and feed the learning backfill, and add
          // a linked diary close row. Best-effort; execution is recorded.
          if (execStatus === "executed") {
            try {
              const pairStr = typeof args.pair === "string" ? args.pair : "";
              const { data: open } = await admin.from("trade_setups")
                .select("id,outcome").eq("user_id", userId).eq("pair", pairStr).eq("status", "active");
              const openRows = (open ?? []) as Array<{ id: string; outcome: string | null }>;
              const now = new Date().toISOString();
              await Promise.all([
                ...openRows.map((s) =>
                  admin.from("trade_setups").update({
                    status: "expired", closed_at: now,
                    ...(s.outcome == null ? { outcome: "unknown" } : {}),
                  }).eq("id", s.id).eq("user_id", userId)
                ),
                admin.from("diary_entries").insert({
                  user_id: userId, mode: "live", source: "agent",
                  exchange: target.exchange, pair: pairStr, side,
                  asset: pairStr.split("/")[0] || pairStr,
                  status: "closed", closed_at: now,
                  setup_id: openRows[0]?.id ?? null,
                  outcome: "unknown",
                  notes: `MCP close_position ${side} ${pairStr} on ${target.exchange} — venue close, outcome unscored`,
                }),
              ]);
            } catch { /* trail is best-effort; execution already recorded */ }
          }
          return toolOk(body.id, out);
        }
        if (name === "set_exits") {
          const gate = await writeGate("set_exits");
          if (!gate.ok) return gate.response;
          const sl = typeof args.slPrice === "number" ? args.slPrice : NaN;
          const tp = typeof args.tpPrice === "number" ? args.tpPrice : NaN;
          if (!(sl > 0) && !(tp > 0)) {
            return toolError(body.id, "validation: set_exits needs slPrice and/or tpPrice > 0");
          }
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: set_exits: ${venueCheck.error}`);
          }
          if (typeof args.pair === "string" && args.pair.trim() !== "") {
            const pairCheck = validatePairSymbol(args.pair);
            if (!pairCheck.ok) return toolError(body.id, `validation: set_exits: ${pairCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const market = typeof args.market === "string" ? args.market.toLowerCase() : "futures";
          if (market !== "spot" && market !== "futures") {
            return toolError(body.id, "validation: set_exits market must be spot|futures");
          }
          const qty = typeof args.quantity === "number" ? args.quantity : NaN;
          if (market === "spot" && !(qty > 0)) {
            return toolError(body.id, "validation: set_exits on spot needs quantity > 0 in base units (the venue reports no spot position to size against)");
          }
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "updatePositionExits", connectionId: target.connectionId,
            symbol: typeof args.pair === "string" ? args.pair : "",
            category: market === "spot" ? "spot" : "linear",
            ...(sl > 0 ? { slPrice: sl } : {}), ...(tp > 0 ? { tpPrice: tp } : {}),
            // The price the legs were DERIVED FROM. The server rebases
            // them onto the position's actual entry, so a fill that came
            // in better than the reference cannot leave the take-profit
            // on the wrong side of the entry — where its trigger is
            // already satisfied and it closes the position for a fee.
            ...(typeof args.referencePrice === "number" && args.referencePrice > 0
              ? { referencePrice: args.referencePrice }
              : {}),
            ...(market === "spot" ? { quantity: qty } : {}),
          }, 45000);
          const execStatus = (out as { error?: unknown }).error == null ? "executed" : "failed";
          await admin.from("agent_action_log").insert({
            user_id: userId, action_type: "trade_cex", status: execStatus,
            params: { mcp_exits: true, ticket: args, resolved: { connectionId: target.connectionId, exchange: target.exchange } }, result: out, decided_via: "mcp-yolo",
          });
          return toolOk(body.id, out);
        }
        if (name === "read_risk_limits") {
          // Shared reader (same superset columns as agent-chat).
          const payload = await executeRiskLimitsRead(readDeps);
          if ("error" in payload) return toolError(body.id, "upstream: could not read risk limits");
          return toolOk(body.id, { risk_limits: (payload as { risk_limits: unknown }).risk_limits });
        }
        if (name === "daily_prep") {
          return handleDailyPrep(
            { admin, userId, supaUrl, authHeader, viaPat, scopes, callEdge },
            body.id, args,
          );
        }
        if (name === "list_open_orders") {
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: list_open_orders: ${venueCheck.error}`);
          }
          if (typeof args.pair === "string" && args.pair.trim() !== "") {
            const pairCheck = validatePairSymbol(args.pair);
            if (!pairCheck.ok) return toolError(body.id, `validation: list_open_orders: ${pairCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "openOrders", connectionId: target.connectionId,
            ...(typeof args.pair === "string" && args.pair ? { symbol: args.pair } : {}),
          });
          return toolOk(body.id, out);
        }
        if (name === "list_fills") {
          // Read-only executions read (Activity history, never Diary rows:
          // one closed position already yields one NET-pnl row via
          // read_closed_pnl, so fills must not be written as trades).
          // No writeGate here (same as list_open_orders).
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: list_fills: ${venueCheck.error}`);
          }
          if (typeof args.pair === "string" && args.pair.trim() !== "") {
            const pairCheck = validatePairSymbol(args.pair);
            if (!pairCheck.ok) return toolError(body.id, `validation: list_fills: ${pairCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const market = typeof args.market === "string" ? args.market.toLowerCase() : "all";
          if (market !== "spot" && market !== "futures" && market !== "all") {
            return toolError(body.id, "validation: list_fills market must be spot|futures|all");
          }
          const days = args.days === undefined ? 30 : Number(args.days);
          if (!Number.isFinite(days) || days < 1 || days > 90) {
            return toolError(body.id, "validation: list_fills days must be 1..90 (default 30)");
          }
          const limit = args.limit === undefined ? 100 : Number(args.limit);
          if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
            return toolError(body.id, "validation: list_fills limit must be 1..500 (default 100)");
          }
          const sinceMs = Date.now() - Math.round(days * 86_400_000);
          const want = typeof args.pair === "string" ? args.pair.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
          const matchPair = (symbol: unknown) =>
            !want || String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") === want;
          const fills: Array<Record<string, unknown>> = [];
          // 60s each: the futures walk carries its own 30s budget and must
          // throw loud server-side rather than die to our client timeout.
          if (market === "spot" || market === "all") {
            const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
              action: "spotFills", connectionId: target.connectionId, sinceMs,
            }, 60000);
            for (const f of ((out as { fills?: unknown[] }).fills ?? [])) {
              if (f && typeof f === "object") fills.push({ ...(f as Record<string, unknown>), market: "spot" });
            }
          }
          if (market === "futures" || market === "all") {
            const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
              action: "futuresFills", connectionId: target.connectionId, sinceMs,
            }, 60000);
            for (const f of ((out as { fills?: unknown[] }).fills ?? [])) {
              if (f && typeof f === "object") fills.push({ ...(f as Record<string, unknown>), market: "futures" });
            }
          }
          const rows = fills.filter((f) => matchPair(f.symbol));
          // Cap-safe: slimmed display columns, most-recent-first page under
          // the tool-message budget with full totals + next_cursor — never
          // a raw dump for toolOk to cut mid-JSON.
          return toolOk(body.id, buildMcpFillsPayload({
            exchange: target.exchange, market, sinceMs,
            fills: rows, limit: Math.floor(limit),
          }));
        }
        if (name === "read_closed_pnl") {
          // Read-only realized-PnL read (the Diary-sync feed). No writeGate.
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: read_closed_pnl: ${venueCheck.error}`);
          }
          if (typeof args.pair === "string" && args.pair.trim() !== "") {
            const pairCheck = validatePairSymbol(args.pair);
            if (!pairCheck.ok) return toolError(body.id, `validation: read_closed_pnl: ${pairCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const days = args.days === undefined ? 30 : Number(args.days);
          if (!Number.isFinite(days) || days < 1 || days > 90) {
            return toolError(body.id, "validation: read_closed_pnl days must be 1..90 (default 30)");
          }
          const limit = args.limit === undefined ? 100 : Number(args.limit);
          if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
            return toolError(body.id, "validation: read_closed_pnl limit must be 1..500 (default 100)");
          }
          const sinceMs = Date.now() - Math.round(days * 86_400_000);
          const want = typeof args.pair === "string" ? args.pair.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "closedPnl", connectionId: target.connectionId, sinceMs,
          }, 60000);
          type PnlRow = { symbol?: unknown; pnl?: unknown; fees?: unknown; closedAt?: unknown };
          const filtered = (((out as { trades?: unknown[] }).trades ?? []) as PnlRow[])
            .filter((t) => !want || String(t.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") === want);
          // Cap-safe: totals over the FULL window, slimmed most-recent-first
          // page under the tool-message budget with next_cursor — never a
          // raw dump for toolOk to cut mid-JSON.
          return toolOk(body.id, buildMcpPnlPayload({
            exchange: target.exchange, sinceMs,
            rows: filtered as Array<Record<string, unknown>>,
            limit: Math.floor(limit),
          }));
        }
        if (name === "reconcile_realized_pnl") {
          // Count the venue's realized LOSSES against the daily risk
          // counters. A trade closed by the venue's own stop never goes
          // through the close path, so without this the daily loss cap
          // cannot fire on it.
          const gate = await writeGate("reconcile_realized_pnl");
          if (!gate.ok) return gate.response;
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: reconcile_realized_pnl: ${venueCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          // ── ROLL AN EXPIRED DAILY WINDOW ──
          //
          // THE RECONCILE IS THE MACHINE'S HEARTBEAT, AND THIS IS WHERE
          // THE WINDOW MUST ROLL.
          //
          // The window is rolled by `checkGate` on the ORDER path, and
          // `checkGate` is only reached when an order is placed. A machine
          // whose evidence gate refuses every cycle never places an order,
          // so it never reaches it — its window never rolls and its daily
          // caps stay consumed while nothing is exposed.
          //
          // Observed live: a window started 2026-10-21 06:27:24Z, and the
          // account still carried $177.48 of the $500 daily-notional budget
          // and 20 of 120 trades against a FLAT book.
          //
          // The trade loop reconciles EVERY cycle and BEFORE the evidence
          // gate, so this handler is the one server call an idle,
          // evidence-blocked machine still makes. Rolling here means the
          // machine recovers its own budget whether or not anyone is
          // watching, and whether or not there are losses to record.
          //
          // The roll is the SAME compare-and-set RPC the order path uses,
          // so it is exactly-once and cannot double-fire. A failure here
          // must NOT fail the reconcile: the counters are still correct to
          // reconcile against, and the order path rolls before it uses
          // them.
          try {
            const rolled = await rollDailyWindowIfExpired(admin, userId);
            if (rolled) {
              console.log("[reconcile] the expired daily window was rolled");
            }
          } catch (e) {
            logServer(corr, "the daily window roll failed:", (e as Error)?.message ?? e);
          }
          const days = args.days === undefined ? 2 : Number(args.days);
          if (!Number.isFinite(days) || days < 1 || days > 30) {
            return toolError(body.id, "validation: reconcile_realized_pnl days must be 1..30 (default 2)");
          }
          const sinceMs = Date.now() - Math.round(days * 86_400_000);
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "closedPnl", connectionId: target.connectionId, sinceMs,
          }, 60000);
          const rawTrades = ((out as { trades?: unknown[] }).trades ?? []) as Array<Record<string, unknown>>;

          // ── THE FILLS: THE DECISIVE OWNERSHIP SIGNAL ──
          //
          // The reservations are keyed on the VENUE'S OWN ORDER ID, and
          // a KuCoin futures fill carries that `orderId` on the fill
          // row. So the fills' order ids answer the ownership question
          // exactly, where the symbol-and-window rule can only suggest.
          //
          // Observed live: the account owner's own SOL/USDT scalps
          // (qty 0.5, ~$52.76) were booked as the MACHINE's losses
          // (-$0.0643 and -$0.0468, so $0.1111 against a $12 cap)
          // because a machine SOL/USDT reservation was still open, and
          // an OPEN reservation covers everything after it. The
          // window rule cannot tell that case apart.
          //
          // A fill read failure must NOT fail the reconcile: the
          // window rule still decides, which is the old behaviour.
          const fillOrderIdsByTrade = new Map<string, string[]>();
          let fillReadDiagnostic = "the fills read was not attempted";
          try {
            const fillsOut = await callEdge(supaUrl, authHeader, "cex-proxy", {
              action: "futuresFills", connectionId: target.connectionId, sinceMs,
            }, 60000);
            const rawFills = ((fillsOut as { fills?: unknown[] }).fills ?? []) as Array<Record<string, unknown>>;
            fillReadDiagnostic = `the venue returned ${rawFills.length} fills`;
            const fills = rawFills.map((f) => ({
              symbol: String(f.symbol ?? "").trim().toUpperCase(),
              orderId: String(f.orderId ?? "").trim(),
              execTime: Number(f.execTime ?? 0),
            })).filter((f) => f.symbol && f.orderId && Number.isFinite(f.execTime) && f.execTime > 0);
            if (fills.length > 0) {
              // A closed trade's fills are the ones on its symbol whose
              // exec time falls inside its holding window.
              for (const t of rawTrades) {
                const tradeId = String(t.id ?? "");
                if (!tradeId) continue;
                const sym = String(t.symbol ?? "").trim().toUpperCase();
                if (!sym) continue;
                const opened = Number(t.openedAt ?? 0);
                const closed = Number(t.closedAt ?? 0);
                if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed <= 0) continue;
                const ids = fills
                  .filter((f) => f.symbol === sym && f.execTime >= opened - 5_000 && f.execTime <= closed + 5_000)
                  .map((f) => f.orderId);
                if (ids.length > 0) fillOrderIdsByTrade.set(tradeId, ids);
              }
              fillReadDiagnostic += `; ${fillOrderIdsByTrade.size} of ${rawTrades.length} closed trades got their fill order ids`;
            }
          } catch (e) {
            logServer(corr, "the fills read failed; falling back to the window rule:", (e as Error)?.message ?? e);
            fillReadDiagnostic = `the fills read FAILED, the window rule decided instead (ref ${corr})`;
          }

          const venueTrades = rawTrades.map((t) => {
            const tradeId = String(t.id ?? "");
            const fillOrderIds = fillOrderIdsByTrade.get(tradeId);
            return {
              id: tradeId,
              symbol: String(t.symbol ?? ""),
              side: t.side == null ? null : String(t.side),
              pnl: Number(t.pnl ?? 0),
              fees: Number(t.fees ?? 0),
              closedAt: (t.closedAt ?? null) as number | string | null,
              // The OPEN time — the trade's holding window needs both
              // ends, and the ownership filter matches the trade's
              // window against the machine's reservation window.
              openedAt: (t.openedAt ?? null) as number | string | null,
              // The fill order ids, when the venue documented them.
              ...(fillOrderIds && fillOrderIds.length > 0 ? { fillOrderIds } : {}),
            };
          });

          // The ledger: which trades have already been counted.
          const { data: ledgerRows, error: ledgerErr } = await admin
            .from("realized_pnl_ledger")
            .select("venue_trade_id, pnl_usd, fees_usd")
            .eq("user_id", userId)
            .limit(2000);
          if (ledgerErr) {
            logServer(corr, "ledger read failed:", ledgerErr.message);
            return toolError(body.id, internalErrorText(corr));
          }
          const ledger = (ledgerRows ?? []).map((r) => ({
            venue_trade_id: String(r.venue_trade_id ?? ""),
            pnl_usd: Number(r.pnl_usd ?? 0),
            fees_usd: Number(r.fees_usd ?? 0),
          }));

          // THE MACHINE'S OWN TRADES. The reservations are the record
          // of the orders THIS machine placed, keyed on the venue's
          // order id. A venue closed trade with no matching reservation
          // is the account OWNER's own manual trading (or another
          // actor's) and must not count against the machine's daily
          // loss cap.
          //
          // Without this filter the reconciler booked every venue
          // trade on the account as the machine's loss: a 30-day
          // reconcile counted 55 of the owner's manual trades as
          // -$422.40 of the machine's losses, pushed the counter over
          // its $12 cap, and tripped the server's circuit breaker.
          const { data: reservationRows, error: reservationErr } = await admin
            .from("trade_reservations")
            .select("venue_order_id, symbol, notional_usd, reserved_at, released_at, actor")
            .eq("user_id", userId)
            // ONLY THE MACHINE'S RESERVATIONS COUNT.
            //
            // The account is SHARED: the owner trades it through the same
            // app live path, which creates the same reservations. Without
            // the actor filter, "is there a reservation covering this
            // trade" answers "yes" for the owner's own trades too, and
            // their losses are booked against the MACHINE's daily loss
            // cap.
            //
            // Observed live on 2026-10-22: two owner SOL/USDT scalps
            // were booked as the machine's losses ($0.114 against a $12
            // cap) while the machine had fired ZERO trades — and the
            // exact-fill-order-id rule could not separate them, because
            // the owner's own fills ARE in the reservation set.
            .eq("actor", "machine")
            .limit(2000);
          if (reservationErr) {
            logServer(corr, "the machine's reservation read failed:", reservationErr.message);
            return toolError(body.id, internalErrorText(corr));
          }
          const reservations = (reservationRows ?? []).map((r) => ({
            venue_order_id: String(r.venue_order_id ?? ""),
            symbol: String(r.symbol ?? ""),
            notional_usd: Number(r.notional_usd ?? 0),
            reserved_at: r.reserved_at ?? null,
            released_at: r.released_at ?? null,
            actor: String(r.actor ?? "owner"),
          }));

          const plan = planRealizedPnlReconcile(venueTrades, ledger, reservations);

          // Record the loss against the daily counters, then write the
          // ledger rows. The ledger write is what makes this idempotent,
          // so it goes FIRST: if the counter update then fails, the next
          // run sees the trade as already counted and does not
          // double-count it. The reverse order could double-count.
          // ── UN-BOOK THE MISBOOKED ROWS ──
          //
          // The ownership filter now comes BEFORE the ledger check, so
          // a row booked under the weaker symbol-and-window rule is
          // re-examined under the decisive fill-order-id rule. When it
          // is rejected, the row is deleted and its loss is returned to
          // the budget — otherwise a wrongly-booked trade would stay
          // charged to the machine forever.
          let unbooked = 0;
          let unbookedLossUsd = 0;
          if (plan.misbooked.length > 0) {
            const ids = plan.misbooked.map((m) => m.id);
            const { error: delErr } = await admin
              .from("realized_pnl_ledger")
              .delete()
              .eq("user_id", userId)
              .in("venue_trade_id", ids);
            if (delErr) {
              logServer(corr, `the misbooked ledger rows could not be deleted: ${delErr.message}`);
            } else {
              unbooked = ids.length;
              unbookedLossUsd = plan.misbooked.reduce((a, m) => a + Math.max(0, -Number(m.pnl ?? 0)), 0);
              // THE COUNTER IS DERIVED FROM THE LEDGER. The ledger is
              // the record of what was booked, so the counter is the
              // sum of the SURVIVING rows — recomputed in ONE write,
              // never set to zero on the way (a zero in between would
              // read as "no loss yet" and could let the breaker lapse).
              const { data: after } = await admin
                .from("realized_pnl_ledger")
                .select("pnl_usd")
                .eq("user_id", userId);
              const truth = (after ?? []).reduce((a, r) => a + Math.max(0, -Number(r.pnl_usd ?? 0)), 0);
              await admin
                .from("risk_limits")
                .update({ daily_realized_loss_usd: truth, updated_at: new Date().toISOString() })
                .eq("user_id", userId);
            }
          }

          let recorded = 0;
          let recordError: string | null = null;
          if (plan.toCount.length > 0) {
            const { error: insErr } = await admin.from("realized_pnl_ledger").upsert(
              plan.toCount.map((t) => ({
                user_id: userId,
                venue_trade_id: t.id,
                exchange: target.exchange,
                symbol: t.symbol,
                side: t.side ?? null,
                pnl_usd: t.pnl,
                fees_usd: Number(t.fees ?? 0),
                closed_at: t.closedAt == null ? null : new Date(Number(t.closedAt) || Date.parse(String(t.closedAt))).toISOString(),
              })),
              { onConflict: "user_id,venue_trade_id", ignoreDuplicates: true },
            );
            if (insErr) {
              logServer(corr, `ledger write failed: ${insErr.message}`);
              recordError = internalErrorText(corr);
            } else {
              recorded = plan.toCount.length;
              // The counter stores a POSITIVE loss; the venue reports a
              // NEGATIVE pnl. Only the LOSSES move the daily loss cap.
              const loss = lossFromPnl(plan.lossToRecordUsd > 0 ? -plan.lossToRecordUsd : 0);
              if (loss > 0) {
                // THE LOSS ONLY — NOT A TRADE.
                //
                // `recordTrade` increments daily_trade_count by 1
                // unconditionally, and this trade was ALREADY counted
                // when it was placed. Counting it again spends the
                // day's trade budget twice for one trade. The daily
                // trade count is TRADES PLACED; the reconciler books a
                // loss for a trade that was already placed.
                await recordRealizedLossOnly(admin, userId, -loss);
              }
            }
          }

          // ── RELEASE THE NOTIONAL THE VENUE'S OWN EXIT HELD ──
          //
          // A venue-native stop or take-profit fills on the venue's
          // SEPARATE stop-order book and closes the position. The app
          // never places a close and never cancels anything, so the
          // entry's reservation was never released and the daily
          // notional budget kept a position that no longer existed.
          //
          // Observed live on 2026-10-21: eight real round trips, all
          // closed by the venue's own legs, and five of seven
          // reservations still OPEN afterwards, holding $295.22 of the
          // $500 budget while the account was FLAT. The machine had
          // $27 of budget left and refused to trade.
          //
          // The release is by SYMBOL and is exactly-once (the RPC takes
          // the oldest open reservation and marks it released), so
          // running this repeatedly is safe. Only symbols with a
          // CLOSED trade are considered — a symbol with an open
          // position still needs its notional reserved.
          let releasedNotional = 0;
          const releasedSymbols: string[] = [];
          try {
            const { releaseTradeReservationForSymbol } = await import("../_shared/risk-gate.ts");
            // ── THE CLOSED SYMBOLS, NOT THE COUNTED ONES ──
            //
            // A reservation is released when the position behind it is
            // CLOSED, whoever placed it. The notional is a statement
            // about OCCUPIED CAPITAL, not about who earned the loss.
            //
            // Driving this from `plan.toCount` was wrong: the owner's
            // trades are deliberately NOT counted (that is what the
            // actor filter does), so their reservations were never
            // released and the machine's notional budget stayed held
            // by the owner's closed positions.
            //
            // Observed live on 2026-10-22: the account was FLAT and the
            // machine had fired ZERO trades, yet daily_notional_usd
            // read $208.68 of the $500 budget and daily_trade_count
            // read 4 of 120 — every dollar of it the owner's own.
            //
            // So the release uses EVERY symbol with a closed trade in
            // the window: the counted ones and the excluded ones alike.
            const closedSymbols = [...new Set(
              venueTrades.map((t) => String(t.symbol ?? "")).filter((s) => s),
            )];
            for (const sym of closedSymbols) {
              const released = await releaseTradeReservationForSymbol(
                admin as unknown as Parameters<typeof releaseTradeReservationForSymbol>[0],
                userId,
                sym,
              );
              if (released > 0) {
                releasedNotional += released;
                releasedSymbols.push(sym);
              }
            }
          } catch (e) {
            logServer(corr, `reservation release skipped: ${(e as Error).message.slice(0, 120)}`);
          }

          return toolOk(body.id, {
            exchange: target.exchange,
            sinceMs,
            venueTrades: venueTrades.length,
            counted: recorded,
            lossRecordedUsd: recordError ? 0 : Number(plan.lossToRecordUsd.toFixed(6)),
            alreadyCounted: plan.alreadyCounted.length,
            notLosses: plan.notLosses.length,
            // The trades skipped because they were NOT the machine's
            // — the account owner's own manual trading. Reported so
            // the skip is VISIBLE: a silent skip reads like a
            // reconcile that found nothing to do.
            notOurs: plan.notOurs.length,
            // The rows the ownership rule REJECTED and that were
            // un-booked, with the loss returned. Reported so the
            // correction is visible rather than silent.
            unbookedMisbooked: unbooked,
            unbookedLossUsd: Number(unbookedLossUsd.toFixed(6)),
            skipped: plan.skipped,
            notionalReleasedUsd: Number(releasedNotional.toFixed(6)),
            notionalReleasedFor: releasedSymbols,
            // HOW THE OWNERSHIP WAS DECIDED. The fill-order-id rule is
            // decisive; the symbol-and-window rule is the fallback for
            // venues that do not document an order id on the fill. A
            // silent fallback to the weaker rule must be VISIBLE — it is
            // the difference between "the owner's trades were excluded
            // because we PROVED they were not ours" and "we could not
            // tell, and guessed in the machine's favour".
            ownershipEvidence: fillReadDiagnostic,
            ...(recordError ? { error: recordError } : {}),
          });
        }
        if (name === "cancel_order") {
          const gate = await writeGate("cancel_order");
          if (!gate.ok) return gate.response;
          const orderId = typeof args.orderId === "string" ? args.orderId : "";
          if (!orderId) return toolError(body.id, "validation: cancel_order needs orderId");
          if (typeof args.exchange === "string" && args.exchange.trim() !== "") {
            const venueCheck = validateVenueSlug(args.exchange);
            if (!venueCheck.ok) return toolError(body.id, `validation: cancel_order: ${venueCheck.error}`);
          }
          const target = await resolveOrderTarget(admin as unknown as ConnectionAdmin, userId, { exchange: args.exchange, connectionId: args.connectionId });
          if (!target.ok) return toolError(body.id, `not_found: order target failed: ${target.error}`);
          const out = await callEdge(supaUrl, authHeader, "cex-proxy", {
            action: "cancelOrder", connectionId: target.connectionId, orderId,
            ...(typeof args.pair === "string" && args.pair ? { symbol: args.pair } : {}),
            ...(typeof args.market === "string" && args.market ? { category: args.market === "futures" ? "linear" : "spot" } : {}),
          }, 30000);
          const execStatus = (out as { error?: unknown }).error == null ? "executed" : "failed";
          await admin.from("agent_action_log").insert({
            user_id: userId, action_type: "trade_cex", status: execStatus,
            params: { mcp_cancel: true, ticket: args, resolved: { connectionId: target.connectionId, exchange: target.exchange } }, result: out, decided_via: "mcp-yolo",
          });
          return toolOk(body.id, out);
        }
        if (name === "reserve_sweep") {
          // Dry-run previews plan with zero venue writes (no YOLO gate —
          // planning moves nothing); live fire re-checks trade:execute +
          // YOLO eligibility per call via the shared write gate.
          if (args.dryRun !== false) {
            return handleReserveSweep(
              { admin, userId, supaUrl, authHeader, viaPat, scopes, callEdge },
              body.id,
              args,
            );
          }
          const reserveGate = await writeGate("reserve_sweep");
          if (!reserveGate.ok) return reserveGate.response;
          return handleReserveSweep(
            { admin, userId, supaUrl, authHeader, viaPat, scopes, callEdge },
            body.id,
            args,
          );
        }
        if (name === "execute_trade") {
          const gate = await writeGate("execute_trade");
          if (!gate.ok) return gate.response;
          return handleExecuteTrade(
            { admin, userId, supaUrl, authHeader, viaPat, scopes, callEdge },
            body.id, args,
          );
        }
        if (name === "read_defi") {
          const payload = await executeDefiRead(args, readDeps);
          return readResult(body.id, "upstream: defi read failed", payload);
        }
        if (name === "build_defi_tx") {
          const actionRaw = typeof args.action === "string" ? args.action.toLowerCase().trim() : "";
          if (!(DEFI_BUILD_ACTIONS as readonly string[]).includes(actionRaw)) {
            return toolError(body.id, `validation: build_defi_tx action must be ${(DEFI_BUILD_ACTIONS as readonly string[]).join("|")}`);
          }
          const investmentId = typeof args.investmentId === "string" ? args.investmentId.trim() : "";
          if (!investmentId) {
            return toolError(body.id, "validation: build_defi_tx requires investmentId");
          }
          if (investmentId.length > 128) {
            return toolError(body.id, "validation: build_defi_tx investmentId too long (max 128 chars)");
          }
          const actionMap: Record<string, string> = {
            supply: "transaction/deposit",
            redeem: "transaction/redeem",
            borrow: "transaction/deposit",
            repay: "transaction/redeem",
            claim: "transaction/claim",
            quote_lp: "transaction/lp-add/calculate",
          };
          const edgeAction = actionMap[actionRaw];
          if (!edgeAction) {
            return toolError(body.id, `validation: build_defi_tx action must be ${(DEFI_BUILD_ACTIONS as readonly string[]).join("|")}`);
          }
          const walletAddress = typeof args.walletAddress === "string" ? args.walletAddress.trim() : "";
          if (edgeAction !== "transaction/lp-add/calculate" && !walletAddress) {
            return toolError(body.id, `validation: build_defi_tx action=${actionRaw} requires walletAddress`);
          }
          if (walletAddress && !isWalletAddress(walletAddress)) {
            return toolError(body.id, "validation: build_defi_tx walletAddress must be a 0x address (40 hex) or a base58 Solana address");
          }
          const amountRaw = typeof args.amount === "string" ? args.amount.trim()
            : typeof args.amount === "number" ? args.amount : "";
          if (edgeAction !== "transaction/claim" && (amountRaw === "" || amountRaw == null)) {
            return toolError(body.id, `validation: build_defi_tx action=${actionRaw} requires amount`);
          }
          let amount: number | null = null;
          if (edgeAction !== "transaction/claim") {
            amount = parseDefiAmount(amountRaw);
            if (amount === null) {
              return toolError(body.id, `validation: build_defi_tx amount must be a positive number up to ${MAX_DEFI_AMOUNT}`);
            }
          }
          const tokenIn = typeof args.tokenAddress === "string" && args.tokenAddress.trim()
            ? args.tokenAddress.trim()
            : "0x0000000000000000000000000000000000000000";
          if (!isEvmTokenAddress(tokenIn)) {
            return toolError(body.id, "validation: build_defi_tx tokenAddress must be a 0x address (40 hex)");
          }
          const tokenAddress = tokenIn;
          const chainCheck = normalizeDefiChainId(args.chainId);
          if (!chainCheck.ok) {
            return toolError(body.id, `validation: build_defi_tx: ${chainCheck.error}`);
          }
          const binanceChainId = chainCheck.chainId;
          const slippageBps = clampSlippageBps(args.slippageBps);
          const simulate = args.simulate !== false;
          const amountStr = amount === null ? "" : String(amount);
          const params: Record<string, unknown> =
            edgeAction === "transaction/lp-add/calculate"
              ? {
                  investmentId,
                  tokenAddress,
                  amount: amountStr,
                  priceRange: ["0.85", "1.15"],
                }
              : edgeAction === "transaction/redeem"
              ? {
                  address: walletAddress,
                  investmentId,
                  binanceChainId,
                  token: { tokenAddress, amount: amountStr },
                  slippageBps,
                  simulate,
                }
              : edgeAction === "transaction/claim"
              ? {
                  address: walletAddress,
                  claimType: "REWARD_INVESTMENT",
                  investmentId,
                  binanceChainId,
                  simulate,
                }
              : {
                  address: walletAddress,
                  investmentId,
                  binanceChainId,
                  tokenList: [{ tokenAddress, amount: amountStr }],
                  slippageBps,
                  simulate,
                };
          const buildRes = await readEdge("binance-defi", {
            action: edgeAction,
            params,
          }, 25000);
          if (!buildRes.ok) {
            logServer(corr, `binance-defi ${edgeAction} failed:`, JSON.stringify(buildRes).slice(0, 2000));
            return toolError(body.id, upstreamErrorText(corr));
          }
          return toolOk(body.id, {
            action: actionRaw,
            edgeAction,
            investmentId,
            observedAt: new Date().toISOString(),
            result: buildRes.json,
          });
        }
        return toolError(body.id, `validation: Unknown tool: ${name ?? "(missing)"}`);
      } catch (e) {
        logServer(corr, "tool call failed:", e instanceof Error ? e.message : e);
        return toolError(body.id, internalErrorText(corr));
      }
    }
    return rpcError(body.id, -32601, `Method not found: ${body.method}`);
  } catch (e) {
    try {
      logServer(corr, "handler failed:", e instanceof Error ? e.message : e);
    } catch {
      // Logging must never fail the error path.
    }
    return fail(500, "internal", internalErrorText(corr));
  }
}));
