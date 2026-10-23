// mcp-server/tools.ts — MCP tool surface + transport helpers.
//
// TOOLS (moved verbatim out of index.ts) is the harness-visible contract:
// read_live_datum carries the SAME 15-param schema as agent-chat (the chat
// shape wins — see read-tools.ts), analyze_market documents the ONE shared
// JEV contract (see agent-chat/jev-gate.ts), and list_connections shares its
// copy + implementation with the chat loop. Tool names, titles, and route
// behavior are unchanged — only the home moved.
import { ok } from "../_shared/respond.ts";
import { fetchWithTimeout } from "../_shared/http.ts";
import type { AnyClient } from "../_shared/clients.ts";
import { JEV_CONSULT_CONTRACT } from "../agent-chat/jev-gate.ts";
import {
  LIST_CONNECTIONS_DESCRIPTION,
  LIST_CONNECTIONS_PARAMETERS,
  READ_DEFI_DESCRIPTION,
  READ_DEFI_PARAMETERS,
  READ_DIARY_DAY_DESCRIPTION,
  READ_DIARY_DAY_PARAMETERS,
  READ_LIVE_DATUM_DESCRIPTION,
  READ_LIVE_DATUM_PARAMETERS,
  READ_RISK_LIMITS_DESCRIPTION,
  READ_RISK_LIMITS_PARAMETERS,
  TOOL_MESSAGE_BUDGET_CHARS,
  TOOL_MESSAGE_HARD_CAP,
} from "../agent-chat/read-tools.ts";

/** Shared analyze_market parameters — the same JEV verdict as chat
 *  consult_jev (see agent-chat/jev-gate.ts + agent-chat/tools.ts).
 *  required stays ["family"]: CEX calls ride server-built candles from
 *  venue+symbol (or a caller snapshot that already carries timeframes);
 *  prediction needs snapshot.market+brief. venue/symbol also accept the
 *  chat aliases exchange/pair at the handler. */
export const ANALYZE_MARKET_PARAMETERS = {
  type: "object",
  properties: {
    family: { type: "string", enum: ["cex", "dex_perps", "prediction"], description: "Market family matching the planned trade." },
    venue: { type: "string", description: "Venue slug (e.g. binance, kucoin, polymarket). Required for cex unless the snapshot already carries timeframes; prediction defaults to polymarket." },
    symbol: { type: "string", description: "Pair, ticker, or condition id (e.g. BTC/USDT). Required for cex unless the snapshot already carries timeframes; prediction takes the Polymarket conditionId/slug or Opinion market id." },
    snapshot: { type: "object", description: "Optional override: { timeframes: [{tf, candles: [{o,h,l,c,v?}]}] } for cex/dex_perps, { market, brief: [{title, snippet, url, at}] } for prediction. Omit for CEX — the server builds candles itself; dex_perps/prediction need the snapshot shapes above." },
  },
  required: ["family"], additionalProperties: false,
};

/** Shared list_fills copy — execution fills (spot + futures) via cex-proxy.
 *  Activity history, NOT Diary rows: one closed position already yields one
 *  NET-pnl row via read_closed_pnl, so fills must never be written as trades. */
export const LIST_FILLS_DESCRIPTION =
  "READ-ONLY: list recent execution fills on a CEX connection (individual order executions with price/qty/fee, spot + futures). Never moves funds, never writes Diary rows — fills are Activity history (see read_closed_pnl for realized PnL). Unimplemented venues return an empty list; a venue walk that exceeds its time budget fails loud, never truncated-as-empty.";
export const LIST_FILLS_PARAMETERS = {
  type: "object",
  properties: {
    exchange: { type: "string", description: "CEX slug, e.g. kucoin (resolved to an active connection; connectionId wins when both are given)" },
    connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
    pair: { type: "string", description: "Optional filter, e.g. BTC/USDT" },
    market: { type: "string", enum: ["spot", "futures", "all"], description: "Which fills to read (default all)" },
    days: { type: "number", description: "Lookback in days, 1..90 (default 30)" },
    limit: { type: "number", description: "Max rows, newest-first, 1..500 (default 100)" },
  },
  additionalProperties: false,
};

/** Shared read_closed_pnl copy — realized/closed-PnL rows via cex-proxy. */
export const READ_CLOSED_PNL_DESCRIPTION =
  "READ-ONLY: realized/closed-PnL history on a CEX connection (one row per closed position carrying net pnl + fees, for diary sync). Never moves funds. Rows whose venue reports no side stay null — side is never inferred from the PnL sign; Binance rows carry entryPrice 0 = unknown (the income feed has no entry price) and exitPrice is the paired closing fill when one was found.";
export const READ_CLOSED_PNL_PARAMETERS = {
  type: "object",
  properties: {
    exchange: { type: "string", description: "CEX slug, e.g. kucoin (resolved to an active connection; connectionId wins when both are given)" },
    connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
    pair: { type: "string", description: "Optional filter, e.g. BTC/USDT" },
    days: { type: "number", description: "Lookback in days, 1..90 (default 30)" },
    limit: { type: "number", description: "Max rows, newest-first, 1..500 (default 100)" },
  },
  additionalProperties: false,
};

/** Shared reconcile_realized_pnl copy — count the venue's realized LOSSES
 *  against the daily risk counters. */
export const RECONCILE_REALIZED_PNL_DESCRIPTION =
  "Counts the venue's realized LOSSES against the daily risk counters. A trade closed by the VENUE's own stop never goes through the close path, so without this the daily loss cap can never fire on it. Idempotent: each venue trade is counted exactly once, tracked in the realized-PnL ledger. Never moves funds, never places an order. Returns how many trades were counted, the loss recorded, and what was skipped and why.";
export const RECONCILE_REALIZED_PNL_PARAMETERS = {
  type: "object",
  properties: {
    exchange: { type: "string", description: "CEX slug, e.g. kucoin (resolved to an active connection; connectionId wins when both are given)" },
    connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
    days: { type: "number", description: "How far back to reconcile, in days, 1..30 (default 2)" },
  },
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: "read_live_datum",
    title: "Read live CEX datum",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: READ_LIVE_DATUM_DESCRIPTION,
    inputSchema: READ_LIVE_DATUM_PARAMETERS,
  },
  {
    name: "analyze_market",
    title: "JEV market verdict",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: JEV_CONSULT_CONTRACT,
    inputSchema: ANALYZE_MARKET_PARAMETERS,
  },
  {
    name: "read_diary_day",
    title: "Read diary day",
    annotations: { readOnlyHint: true },
    description: READ_DIARY_DAY_DESCRIPTION,
    inputSchema: READ_DIARY_DAY_PARAMETERS,
  },
  {
    name: "list_connections",
    title: "List CEX connections",
    annotations: { readOnlyHint: true },
    description: LIST_CONNECTIONS_DESCRIPTION,
    inputSchema: LIST_CONNECTIONS_PARAMETERS,
  },
  {
    name: "propose_trade",
    title: "Propose trade setup",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Propose a trade setup for the user to approve in-app (Diary → Send to ticket). Never executes. Needs the trade:propose scope.",
    inputSchema: { type: "object", properties: {
      asset: { type: "string", description: "Base symbol, e.g. BTC" },
      pair: { type: "string", description: "e.g. BTC/USDT" },
      venue: { type: "string", description: "CEX slug or perps venue" },
      side: { type: "string", enum: ["buy", "sell", "long", "short"] },
      entry: { type: "number", description: "Entry price, must be > 0" },
      stop: { type: "number", description: "Stop-loss price, must be > 0" },
      size_usd: { type: "number", description: "Suggested size in USD, must be > 0" },
      thesis: { type: "string", description: "One-paragraph rationale" },
      timeframe: { type: "string", description: "e.g. 4h" },
    }, required: ["pair", "side", "entry", "stop"], additionalProperties: false },
  },
  {
    name: "read_onchain_balances",
    title: "Read onchain balances",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Read-only onchain wallet balances across EVM/Solana/TON/Tron/BTC via the balance cache + public RPCs. Server resolves the user's wallet addresses itself (addresses only, never keys). The chains filter uses canonical slugs and matches non-EVM chains exactly — `sol` never matches `solana`, `bitcoin` reads as `btc`; one linked EVM address is readable on any requested EVM chain. TON matches by chain slug, not address form — raw (0:…), bounceable (EQ…) and non-bounceable (UQ…) versions of one wallet resolve to the same balance.",
    inputSchema: { type: "object", properties: {
      chains: { type: "string", description: "Optional comma list of canonical chain slugs, e.g. ethereum,solana. Non-EVM slugs (solana, ton, tron, btc) match exactly — no aliases or substrings; ton covers every TON address version. EVM slugs expand: one linked EVM address reads on any requested EVM chain." },
    }, additionalProperties: false },
  },
  {
    name: "close_position",
    title: "Close CEX position",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Close an open CEX futures position (or reduce it) with a reduce-only market order. Real money. Needs the trade:execute scope AND user YOLO eligibility; per-call kill-switch/autonomy check. NEVER touch positions the user marked manual unless explicitly asked.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. kucoin" },
      pair: { type: "string", description: "e.g. BTC/USDT" },
      side: { type: "string", enum: ["long", "short"], description: "Side of the OPEN position" },
      size: { type: "string", description: "Base units to close; omit or full size for entire position" },
    }, required: ["exchange", "pair", "side"], additionalProperties: false },
  },
  {
    name: "set_exits",
    title: "Arm position exits",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Arm or replace venue-native SL and/or TP on an open CEX position (spot or futures across binance, bybit, okx, kucoin, gateio, mexc, bitget, bingx, coinbase, kraken). Clears existing stops on the pair and arms the new legs sized against the live position. Needs trade:execute + YOLO eligibility.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. binance, bybit, okx, kucoin, gateio, mexc, bitget, bingx, coinbase, kraken" },
      pair: { type: "string", description: "e.g. BTC/USDT" },
      slPrice: { type: "number", description: "Stop-loss trigger, must be on the correct side of mark" },
      tpPrice: { type: "number", description: "Take-profit trigger" },
      market: { type: "string", enum: ["spot", "futures"], description: "Which market the open position is on (default futures). Spot needs quantity." },
      referencePrice: { type: "number", description: "The price the stop and take-profit were DERIVED FROM. The server rebases both legs onto the position's ACTUAL entry price, keeping their distances, so a fill that came in better than the reference cannot leave a take-profit on the wrong side of the entry (where its trigger is already satisfied and it would close the position instantly for a fee)." },
      quantity: { type: "number", description: "Spot only: position size in base units (the venue reports no spot position to size against)" },
    }, required: ["exchange", "pair"], additionalProperties: false },
  },
  {
    name: "cancel_order",
    title: "Cancel CEX order",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: "Cancel an open CEX order by order id. Needs trade:execute + YOLO eligibility; per-call kill-switch/autonomy check.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. kucoin" },
      orderId: { type: "string", description: "Venue order id to cancel" },
      pair: { type: "string", description: "e.g. BTC/USDT (helps venue routing)" },
      market: { type: "string", enum: ["spot", "futures"] },
    }, required: ["exchange", "orderId"], additionalProperties: false },
  },
  {
    name: "list_open_orders",
    title: "List open CEX orders",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "List open orders on a CEX connection (spot + futures). Read-only.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. kucoin" },
      pair: { type: "string", description: "Optional filter, e.g. BTC/USDT" },
    }, required: ["exchange"], additionalProperties: false },
  },
  {
    name: "list_fills",
    title: "List CEX execution fills",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: LIST_FILLS_DESCRIPTION,
    inputSchema: LIST_FILLS_PARAMETERS,
  },
  {
    name: "read_closed_pnl",
    title: "Read closed CEX PnL",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: READ_CLOSED_PNL_DESCRIPTION,
    inputSchema: READ_CLOSED_PNL_PARAMETERS,
  },
  {
    name: "reconcile_realized_pnl",
    title: "Reconcile realized PnL against the daily loss cap",
    // NOT read-only: it writes the daily risk counters. It never places
    // an order and never moves funds.
    annotations: { readOnlyHint: false, openWorldHint: true },
    description: RECONCILE_REALIZED_PNL_DESCRIPTION,
    inputSchema: RECONCILE_REALIZED_PNL_PARAMETERS,
  },
  {
    name: "read_risk_limits",
    title: "Read risk limits",
    annotations: { readOnlyHint: true },
    description: READ_RISK_LIMITS_DESCRIPTION,
    inputSchema: READ_RISK_LIMITS_PARAMETERS,
  },
  {
    name: "daily_prep",
    title: "Daily pre-trading brief",
    annotations: { readOnlyHint: false },
    description: "Build the morning brief (risk header, positions, 5-venue funding/OI, liquidation proxy, macro 24h, regime, JEV bias per name) and record it as the day's 'Daily analysis' in the diary. Reads need mcp:read; the diary write needs trade:propose (or pass write:false for a dry run). Sections carry [DATA]/[PROXY]/[UNAVAILABLE] tags — gaps are never synthesized.",
    inputSchema: { type: "object", properties: {
      write: { type: "boolean", description: "Record into diary_day_notes (default true)" },
      day: { type: "string", description: "YYYY-MM-DD (default today UTC)" },
    }, additionalProperties: false },
  },
  {
    name: "execute_trade",
    title: "Execute live CEX order",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Execute a live CEX order immediately (real money) via stored exchange keys. Needs the trade:execute scope AND user YOLO eligibility (kill switch off, autonomy != propose_only); caps enforced per order. Fee-aware: pass stop to refuse stops that cannot survive round-trip fees (min-move gate), or risk_usd to size from risk (needs stop, else an ATR stop from venue klines). Returns the fee estimate + min-move in the result. CEX spot/futures only — never on-chain.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. kucoin" },
      pair: { type: "string", description: "e.g. BTC/USDT" },
      side: { type: "string", enum: ["buy", "sell"] },
      actor: { type: "string", enum: ["machine", "owner"], description: "WHO is placing the order. 'machine' for the trading machine; 'owner' for the account owner's own manual trading. The account is SHARED, so this is what tells the machine's trades from the owner's when a closed trade is reconciled against the machine's daily loss cap. Defaults to 'owner'." },
      amount: { type: "string", description: "Base units, e.g. 0.05 (omit when risk_usd sizes the order)" },
      price: { type: "string", description: "Limit price. OMIT for a market order. When the order type is 'market' the price is only a reference for sizing and is NOT sent to the venue — a resting limit has no position to protect, so the exit legs cannot attach to it." },
      referencePrice: { type: "string", description: "For a MARKET order only: the price the exit legs were derived from. The venue may fill the entry at a different price, and the server REBASES the stop and target onto the actual fill (each keeps its distance from this reference). Omit it and the legs are placed at their original absolute prices, which can land on the wrong side of the fill." },
      market: { type: "string", enum: ["spot", "futures"] },
      leverage: { type: "number", description: "Futures only; rides the order (KuCoin has no venue-level setting)" },
      marginMode: { type: "string", enum: ["cross", "isolated"], description: "Futures only; isolated bounds max loss to position margin (default cross)" },
      stop: { type: "number", description: "Protective stop price (> 0). Gated server-side: stops inside round-trip fees x factor are refused with the shortfall spelled out, and armed as a venue-native SL exit leg after the entry across all CEX venues." },
      tp: { type: "number", description: "Take-profit price (> 0) armed with the entry as a single 100%-share venue-native TP exit leg across all CEX venues. Must sit on the profit side of the entry (long: above, short: below)." },
      tpLegs: { type: "array", description: "Optional 1-3 split take-profit legs ({ price, share }, where share is 1..100 percent of entry size) armed as venue-native TP orders after the entry.", items: { type: "object", properties: { price: { type: "number" }, share: { type: "number" } }, required: ["price", "share"], additionalProperties: false } },
      risk_usd: { type: "number", description: "Max USD loss at the stop — sizes the order as risk_usd / stop distance (needs stop, else ATR stop from venue klines; capped by max_position_usd + lot step)." },
      clientOid: { type: "string", description: "Optional caller-supplied identity tag for the order (max 36 chars, [A-Za-z0-9_-]). A later session uses it to attribute the order to its owner instead of classifying it as foreign/unknown-origin. Omit it and the server generates a random UUID." },
      idempotency_key: { type: "string", description: "Optional per-INTENT key. Two submits with the same key are the same intent: the second is deduped and never dispatched again. Use it when a submission may be retried (a timeout, a reconnect) so a retry cannot double-fill." },
      type: { type: "string", enum: ["market", "limit"], description: "Order type. Defaults to 'limit' when a price is given, else 'market'. Use 'market' for a live entry: the exit legs are venue-native conditionals that attach to a POSITION, so a RESTING LIMIT has no position to protect and rests on the book unprotected until it fills." },
    }, required: ["exchange", "pair", "side"], additionalProperties: false },
  },
  {
    name: "reserve_sweep",
    title: "Sweep KuCoin futures reserve to trade",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "KuCoin reserve sweep (real money on live fire): keeps `keep` units of `currency` in the futures wallet and moves the excess futures -> main -> trade in two legs carrying the same amount. Dry-run by default (plan only, zero bytes to the venue, no YOLO gate). Live fire (dryRun:false) needs the trade:execute scope AND user YOLO eligibility (kill switch off, autonomy != propose_only). KuCoin only.",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug — kucoin only (resolved to an active connection; connectionId wins when both are given)" },
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
      keep: { type: "number", description: "Units of currency to leave in futures (default 10)" },
      currency: { type: "string", description: "Settlement asset to sweep: USDT, USDC, BTC or ETH (XBT accepted as BTC; default USDT)" },
      dryRun: { type: "boolean", description: "Plan only, moves nothing (default true). Pass false to fire both transfer legs." },
    }, required: ["exchange"], additionalProperties: false },
  },
  {
    name: "read_defi",
    title: "Read Binance Web3 DeFi data",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: READ_DEFI_DESCRIPTION,
    inputSchema: READ_DEFI_PARAMETERS,
  },
  {
    name: "build_defi_tx",
    title: "Build or quote unsigned DeFi transaction",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "READ-ONLY / UNSIGNED: build an unsigned DeFi transaction payload (supply, redeem, borrow, repay, claim) or quote LP amounts (quote_lp) via the official Binance Web3 DeFi API. Never signs, never broadcasts, never touches private keys — returns unsigned contract calldata (and optional simulation result) for wallet signing or CLI inspection.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["supply", "redeem", "borrow", "repay", "claim", "quote_lp"], description: "DeFi transaction builder action: supply|redeem|borrow|repay|claim|quote_lp." },
      investmentId: { type: "string", description: "Binance Web3 DeFi investmentId (from read_defi scope=investments)." },
      walletAddress: { type: "string", description: "User wallet address (0x... for EVM or base58 for Solana). Required for supply|redeem|borrow|repay|claim." },
      amount: { type: "string", description: "Token amount in human units or base units (required for supply|redeem|borrow|repay|quote_lp)." },
      tokenAddress: { type: "string", description: "Optional input/output token contract address (defaults to investment primary token)." },
      chainId: { type: "string", description: "Optional chain slug or chainId (e.g. ethereum, bnb, arbitrum, base, polygon, optimism, avalanche, linea, sonic, solana)." },
      slippageBps: { type: "number", description: "Optional slippage tolerance in basis points (default 50 = 0.5%)." },
      simulate: { type: "boolean", description: "When true (default), also runs Binance Web3 DeFi transaction simulation on the unsigned payload." },
    }, required: ["action", "investmentId"], additionalProperties: false },
  },
];

type RpcReq = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
export type { RpcReq };

export function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return ok({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}
export function rpcOk(id: unknown, result: unknown) {
  return ok({ jsonrpc: "2.0", id: id ?? null, result });
}
// Tool-level failures MUST return HTTP 200 result with isError:true (MCP spec:
// JSON-RPC error is for protocol-level failures only). Validation + downstream
// errors inside tools/call use this; auth/rate-limit/method errors keep rpcError.
export function toolError(id: unknown, message: string, data?: unknown) {
  return rpcOk(id, {
    content: [{ type: "text", text: data !== undefined ? `${message} ${JSON.stringify(data).slice(0, 500)}` : message }],
    isError: true,
  });
}
export function toolOk(id: unknown, payload: unknown) {
  return rpcOk(id, { content: [{ type: "text", text: toolText(payload) }] });
}

/** Serialize a tool payload for the MCP transport. Builders keep every
 *  payload under TOOL_MESSAGE_BUDGET_CHARS; this guard enforces
 *  TOOL_MESSAGE_HARD_CAP with a valid-JSON truncation envelope (parseable,
 *  with a narrow-and-page-again hint) instead of the old mid-JSON
 *  `.slice(0, 12000)` cut that hid tonight's trades from `jw3 diary`.
 *  NEVER slice serialized JSON here — a cut string is unparseable. */
export function toolText(payload: unknown) {
  const text = JSON.stringify(payload ?? null);
  if (text.length <= TOOL_MESSAGE_HARD_CAP) return text;
  return JSON.stringify({
    truncated: true,
    actual_chars: text.length,
    budget_chars: TOOL_MESSAGE_BUDGET_CHARS,
    hint: "payload exceeded the tool-message cap; narrow with limit/days/pair/day and page again",
  });
}

export async function callEdge(
  baseUrl: string, authHeader: string, slug: string, body: Record<string, unknown>, ms = 25000,
): Promise<unknown> {
  const r = await fetchWithTimeout(`${baseUrl}/functions/v1/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": authHeader },
    body: JSON.stringify(body),
    timeoutMs: ms,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${slug} ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Request-scoped context the split tool handlers close over in index.ts. */
export type ToolCtx = {
  admin: AnyClient;
  userId: string;
  supaUrl: string;
  authHeader: string;
  viaPat: boolean;
  scopes: string[];
  callEdge: (
    baseUrl: string, authHeader: string, slug: string, body: Record<string, unknown>, ms?: number,
  ) => Promise<unknown>;
};

