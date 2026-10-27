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
  NEWS_BRIEF_DESCRIPTION,
  NEWS_BRIEF_PARAMETERS,
} from "../agent-chat/news-brief.ts";
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
    exchange: { type: "string", description: "Alias of venue (chat compat)." },
    pair: { type: "string", description: "Alias of symbol (chat compat)." },
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
      jev_verdict: { type: "string", description: "Optional caller-supplied JEV verdict captured alongside the proposal" },
      invalidation: { type: "string", description: "Optional invalidation note captured alongside the proposal" },
      kronos_direction: { type: "string", enum: ["up", "down", "flat"], description: "Optional Kronos oracle vote direction" },
      kronos_expected_move_pct: { type: "number", description: "Optional Kronos expected move in percent" },
      kronos_horizon: { type: "number", description: "Optional Kronos horizon (positive integer)" },
      kronos_captured_at: { type: "string", description: "Optional ISO timestamp of the Kronos vote" },
    }, required: ["pair", "side", "entry", "stop"], additionalProperties: false },
  },
  {
    name: "propose_diary_note",
    title: "Propose diary note",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Append (default) or replace a markdown note on one diary day (diary_day_notes upsert — the same append/replace write the agent-chat approval path and daily_prep perform). Diary-only: never executes a trade, never moves funds. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      day: { type: "string", description: "Day in YYYY-MM-DD format (default today UTC)" },
      body_md: { type: "string", description: "Markdown note content, 1..4000 chars (longer bodies are cut)" },
      mode: { type: "string", enum: ["append", "replace"], description: "append (default) or replace the day's note" },
    }, required: ["body_md"], additionalProperties: false },
  },
  {
    name: "propose_trade_ideas",
    title: "Propose trade ideas",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "APPROVAL CARD ONLY — NEVER auto-executed: propose 1–3 personalized trade opportunities (best-first) for in-app approval. Each idea is recorded as a proposed setup row (Diary → setups → Send to ticket) plus one batch trail row. Never executes, never moves funds. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      ideas: { type: "array", description: "1–3 trade ideas, best-first. Each: pair (e.g. BTC/USDT), side buy|sell, entry > 0, stop > 0 (long: stop<entry, short: stop>entry), targets 1–3x {price>0}, thesis (required)." },
      rationale: { type: "string", description: "One-sentence why-now for the batch" },
      jev_verdict: { type: "string", description: "Optional caller-supplied JEV verdict captured alongside the batch (run analyze_market first for a fresh one)" },
    }, required: ["ideas", "rationale"], additionalProperties: false },
  },
  {
    name: "propose_bracket",
    title: "Propose bracket order",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "APPROVAL CARD ONLY — NEVER auto-executed: propose one atomic bracket (entry + protective stop + 1–3 OCO take-profits) for in-app approval. Recorded as a proposed setup row (Diary → setups → Send to ticket). Never executes, never moves funds. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "CEX slug, e.g. kucoin" },
      pair: { type: "string", description: "e.g. BTC/USDT" },
      side: { type: "string", enum: ["buy", "sell", "long", "short"], description: "buy = long, sell = short" },
      entry_type: { type: "string", enum: ["market", "limit"], description: "market = fill now; limit = resting entry at entry_price" },
      entry_price: { type: "number", description: "Required when entry_type=limit. Must be > 0." },
      amount: { type: "string", description: "Base amount, e.g. 0.05. Must be > 0." },
      stop_price: { type: "number", description: "Protective stop. Long: below entry; short: above. Must be > 0." },
      fee_usd: { type: "number", description: "All-in fee in USD. Omit or null if unknown — never 0-substituted." },
      take_profits: { type: "array", description: "1–3 take-profit legs {price > 0, fraction 0..1 of position}. Weights should sum to ~1." },
      rationale: { type: "string", description: "One-sentence why-now" },
    }, required: ["exchange", "pair", "side", "entry_type", "amount", "stop_price", "take_profits", "rationale"], additionalProperties: false },
  },
  {
    name: "propose_predict_market",
    title: "Propose prediction trade",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "APPROVAL CARD ONLY — NEVER auto-executed: propose a prediction-market trade for in-app approval. JEV-gated: pass the consult_jev family=prediction verdict (run analyze_market first) — a call without one is refused. Recorded as a proposal trail row. Never executes, never moves funds. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      market_id: { type: "string", description: "Polymarket conditionId or slug, or Opinion market id" },
      question: { type: "string", description: "Human-readable question, for UI display" },
      side: { type: "string", enum: ["yes", "no"], description: "Outcome to buy" },
      amount: { type: "number", description: "pUSD amount to spend" },
      venue: { type: "string", enum: ["polymarket", "opinion"], description: "Default polymarket (executable). opinion is proposal-only." },
      jev_verdict: { type: "string", description: "The consult_jev family=prediction verdict (run analyze_market first) — required" },
      confidence: { type: "number", description: "Agreement-weighted conviction 0–1" },
      rationale: { type: "string", description: "Why this market and side now" },
    }, required: ["market_id", "side", "rationale", "jev_verdict"], additionalProperties: false },
  },
  {
    name: "propose_close_all_positions",
    title: "Propose close-all",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "APPROVAL CARD ONLY — NEVER auto-executed: propose flattening EVERY open position at once (or one venue/pair scope) for in-app approval. Records the proposal only — no order is placed, nothing is cancelled. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      exchange: { type: "string", description: "Optional CEX slug to flatten one venue only. Omit for every connected venue." },
      pair: { type: "string", description: "Optional pair filter (e.g. BTC/USDT) — flatten only this market. Omit for everything." },
      order_type: { type: "string", enum: ["market", "limit"], description: "Default market." },
      limit_price: { type: "string", description: "Required for order_type=limit." },
      rationale: { type: "string", description: "Why flatten now" },
    }, required: ["rationale"], additionalProperties: false },
  },
  {
    name: "propose_withdraw",
    title: "Propose CEX withdrawal",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "APPROVAL CARD ONLY — NEVER auto-executed: propose a CEX withdrawal (exchange → on-chain wallet) for in-app approval. JW3 holds trade-only keys (withdrawals disabled), so approving pre-fills the exchange withdrawal form and the user completes it inside their exchange account. Records the proposal only — no funds move. Needs the trade:propose scope (PAT).",
    inputSchema: { type: "object", properties: {
      source_exchange: { type: "string", description: "Source CEX slug, e.g. kucoin" },
      asset: { type: "string", description: "Asset symbol, e.g. USDT, USDC, ETH, SOL" },
      network: { type: "string", description: "Network the CEX withdraws on (e.g. ETH, ARBITRUM, BSC, SOL, TON, MATIC, TRX)" },
      amount: { type: "string", description: "Amount in human units" },
      dest_address: { type: "string", description: "Destination on-chain wallet address (user-confirmed, never invented)" },
      dest_chain: { type: "string", description: "Optional destination chain slug (ethereum, base, arbitrum, polygon, bnb, avalanche, solana, ton)" },
      rationale: { type: "string", description: "Why withdraw now" },
    }, required: ["source_exchange", "asset", "network", "amount", "dest_address", "rationale"], additionalProperties: false },
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
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
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
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
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
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
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
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
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
      connectionId: { type: "string", description: "CEX connection id (see list_connections). Takes precedence over exchange." },
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
      tpPrice: { type: "number", description: "Deprecated alias of tp." },
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
    name: "read_news_brief",
    title: "Read crypto news brief",
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: NEWS_BRIEF_DESCRIPTION,
    inputSchema: NEWS_BRIEF_PARAMETERS,
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

/* ── Hardening: budgets, registries, validators, error hygiene ──
 *
 * Central home for the pre-dispatch checks in index.ts and the field
 * validators in execute.ts, so every path enforces one contract. Pure:
 * no fetch, no clock (except correlation ids), no DB. Small allowlists
 * here mirror the edge registries by value (venues, defi chains); the
 * large modules behind them are not copied.
 */

/** Pre-auth gateway bucket: per-IP, before requireUser. Fail closed. */
export const GATEWAY_RATE_LIMIT = { limit: 120, windowSec: 60, bucket: "mcp-server:gateway" };
/** Default per-user bucket for cheap reads. */
export const DEFAULT_TOOL_RATE_LIMIT = { limit: 60, windowSec: 60, bucket: "mcp-server" };
/** Exit-arming bucket: a position must always be able to arm its stop. */
export const PROTECTION_TOOL_RATE_LIMIT = { limit: 120, windowSec: 60, bucket: "mcp-server:protection" };
/**
 * Heavy-tool budgets: each gets its own bucket with a lower limit (and a
 * longer window for daily_prep) so scanners cannot starve protection and
 * one expensive fan-out cannot eat the whole minute.
 */
export const TOOL_RATE_LIMITS: Record<string, { limit: number; windowSec: number; bucket: string }> = {
  daily_prep: { limit: 5, windowSec: 300, bucket: "mcp-server:daily_prep" },
  analyze_market: { limit: 20, windowSec: 60, bucket: "mcp-server:analyze_market" },
  list_fills: { limit: 20, windowSec: 60, bucket: "mcp-server:list_fills" },
  read_closed_pnl: { limit: 20, windowSec: 60, bucket: "mcp-server:read_closed_pnl" },
  reconcile_realized_pnl: { limit: 10, windowSec: 60, bucket: "mcp-server:reconcile_realized_pnl" },
};

export function toolRateLimitFor(
  toolName: string,
  isProtection: boolean,
): { limit: number; windowSec: number; bucket: string } {
  if (isProtection) return PROTECTION_TOOL_RATE_LIMIT;
  return TOOL_RATE_LIMITS[toolName] ?? DEFAULT_TOOL_RATE_LIMIT;
}

/**
 * CEX venue allowlist, mirrored from _shared/venues.ts CEX_VENUES (same
 * ten, same order). Unknown slugs are rejected before any fan-out.
 */
export const MCP_CEX_VENUES: readonly string[] = [
  "binance",
  "bybit",
  "okx",
  "kucoin",
  "gateio",
  "mexc",
  "bitget",
  "bingx",
  "coinbase",
  "kraken",
];

export function validateVenueSlug(raw: unknown): { ok: true; venue: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return { ok: false, error: "venue is required" };
  if (!(MCP_CEX_VENUES as readonly string[]).includes(v)) {
    return { ok: false, error: `unknown venue: ${v.slice(0, 32)}` };
  }
  return { ok: true, venue: v };
}

/**
 * Onchain chain allowlist for the chains csv filter. Canonical slugs only;
 * "bitcoin" is accepted as an alias for "btc". Non-EVM slugs match exactly.
 */
export const MCP_ONCHAIN_CHAINS: readonly string[] = [
  "ethereum", "arbitrum", "optimism", "polygon", "base", "bnb",
  "avalanche", "scroll", "unichain", "ink", "linea", "sonic",
  "hyperevm", "arc", "robinhood", "solana", "ton", "tron", "btc",
];
export const MAX_CHAINS_PER_READ = 10;
export const MAX_CHAINS_RAW_CHARS = 256;

export function validateChainsCsv(raw: unknown): { ok: true; chains: string } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, chains: "" };
  if (text.length > MAX_CHAINS_RAW_CHARS) {
    return { ok: false, error: `chains filter too long (max ${MAX_CHAINS_RAW_CHARS} chars)` };
  }
  const parts = text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => (s === "bitcoin" ? "btc" : s));
  if (parts.length > MAX_CHAINS_PER_READ) {
    return { ok: false, error: `too many chains (max ${MAX_CHAINS_PER_READ})` };
  }
  for (const c of parts) {
    if (c.length > 32 || !(MCP_ONCHAIN_CHAINS as readonly string[]).includes(c)) {
      return { ok: false, error: `unknown chain: ${c.slice(0, 32)}` };
    }
  }
  return { ok: true, chains: [...new Set(parts)].join(",") };
}

/** Length cap + charset for CEX pair/symbol selectors. */
export const MAX_PAIR_CHARS = 32;
const PAIR_RE = /^[A-Za-z0-9/._:-]{1,32}$/;

export function validatePairSymbol(raw: unknown, field = "pair"): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: `${field} is required` };
  if (v.length > MAX_PAIR_CHARS || !PAIR_RE.test(v)) {
    return { ok: false, error: `${field} has bad shape (1..32 chars, [A-Za-z0-9/._:-])` };
  }
  return { ok: true, value: v };
}

/** Length cap + charset for prediction market selectors. */
export const MAX_MARKET_ID_CHARS = 256;
const MARKET_ID_RE = /^[A-Za-z0-9_./:@-]{1,256}$/;
export const MAX_TOKEN_ID_CHARS = 128;
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function validateMarketId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: "market_id is required" };
  if (v.length > MAX_MARKET_ID_CHARS || !MARKET_ID_RE.test(v)) {
    return { ok: false, error: "market_id has bad shape (1..256 chars, [A-Za-z0-9_./:@-])" };
  }
  return { ok: true, value: v };
}

export function validateTokenId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: "token_id is required" };
  if (v.length > MAX_TOKEN_ID_CHARS || !TOKEN_ID_RE.test(v)) {
    return { ok: false, error: "token_id has bad shape (1..128 chars, [A-Za-z0-9_-])" };
  }
  return { ok: true, value: v };
}

/** Optional wallets csv for predictions scope=positions: capped at 10, 0x only. */
export const MAX_PREDICTION_WALLETS = 10;
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function validateWalletsCsv(raw: unknown): { ok: true; wallets: string[] } | { ok: false; error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, wallets: [] };
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > MAX_PREDICTION_WALLETS) {
    return { ok: false, error: `too many wallets (max ${MAX_PREDICTION_WALLETS})` };
  }
  for (const w of parts) {
    if (!EVM_ADDR_RE.test(w)) return { ok: false, error: "wallets must be 0x addresses (40 hex)" };
  }
  return { ok: true, wallets: parts };
}

/* ── build_defi_tx validators ── */

export const DEFI_BUILD_ACTIONS: readonly string[] = [
  "supply", "redeem", "borrow", "repay", "claim", "quote_lp",
];
export const DEFI_SUPPORTED_CHAIN_IDS: readonly string[] = [
  "1", "10", "56", "137", "4663", "5042", "8453", "42161", "43114", "747474",
];
export const DEFI_CHAIN_SLUGS: Record<string, string> = {
  ethereum: "1", bnb: "56", arbitrum: "42161", base: "8453", polygon: "137",
  optimism: "10", avalanche: "43114", linea: "59144", sonic: "146", solana: "solana",
};
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Upper bound for a human-unit defi amount: refuses fat-finger fortunes. */
export const MAX_DEFI_AMOUNT = 1e12;
export const DEFI_SLIPPAGE_DEFAULT_BPS = 50;
export const DEFI_SLIPPAGE_MAX_BPS = 1000;

export function normalizeDefiChainId(raw: unknown): { ok: true; chainId: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return { ok: true, chainId: "1" };
  if (/^\d+$/.test(v) && (DEFI_SUPPORTED_CHAIN_IDS as readonly string[]).includes(v)) {
    return { ok: true, chainId: v };
  }
  const mapped = DEFI_CHAIN_SLUGS[v];
  if (mapped) return { ok: true, chainId: mapped };
  return { ok: false, error: `unknown chainId: ${v.slice(0, 32)}` };
}

export function isWalletAddress(raw: string): boolean {
  const v = String(raw ?? "").trim();
  return EVM_ADDR_RE.test(v) || SOL_ADDR_RE.test(v);
}

export function isEvmTokenAddress(raw: string): boolean {
  const v = String(raw ?? "").trim();
  return EVM_ADDR_RE.test(v) || v.toLowerCase() === ZERO_ADDRESS;
}

export function parseDefiAmount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DEFI_AMOUNT) return null;
  return n;
}

export function clampSlippageBps(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFI_SLIPPAGE_DEFAULT_BPS;
  return Math.min(Math.floor(n), DEFI_SLIPPAGE_MAX_BPS);
}

/* ── Central inputSchema validation ──
 *
 * Shallow structural check (type, required, enum, additionalProperties)
 * run before dispatch so malformed calls fail with -32602 Invalid params.
 * Deep semantic checks (ranges, cross-field rules) stay in the handlers.
 */

export type MiniSchema = {
  type?: string;
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
  required?: string[];
  additionalProperties?: boolean;
};

function schemaTypeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

export function validateArgsAgainstSchema(
  schema:
    | MiniSchema
    | { type?: unknown; properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown }
    | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!schema || typeof schema !== "object") return null;
  const loose = schema as { type?: unknown; properties?: unknown; required?: unknown; additionalProperties?: unknown };
  if (loose.type !== undefined && loose.type !== "object") return "schema mismatch";
  const props = (loose.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(loose.required) ? loose.required : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (args[key] === undefined || args[key] === null) return `missing required field: ${key}`;
  }
  if (loose.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) return `unknown field: ${key}`;
    }
  }
  for (const [key, rawRule] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const rule = (rawRule ?? {}) as Record<string, unknown>;
    if (rule.type !== undefined) {
      const want = String(rule.type);
      const got = schemaTypeOf(v);
      const match = want === got || (want === "number" && got === "integer") ||
        (want === "integer" && got === "integer");
      if (!match) return `${key} must be a ${want}`;
    }
    if (Array.isArray(rule.enum) && !(rule.enum as unknown[]).includes(v as unknown)) {
      return `${key} has an unsupported value`;
    }
  }
  return null;
}

/* ── execute_trade declared-field validators ──
 *
 * Every field the schema declares is validated here and forwarded by
 * toProxyOrder; unknown values are rejected, never silently dropped.
 */

export function validateActor(raw: unknown): { ok: true; actor: "machine" | "owner" | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, actor: null };
  const v = String(raw).trim().toLowerCase();
  if (v === "machine" || v === "owner") return { ok: true, actor: v };
  return { ok: false, error: "actor must be machine|owner" };
}

export const MAX_LEVERAGE = 125;

export function validateLeverage(raw: unknown): { ok: true; leverage: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, leverage: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_LEVERAGE) {
    return { ok: false, error: `leverage must be 1..${MAX_LEVERAGE}` };
  }
  return { ok: true, leverage: n };
}

export function validateMarginMode(raw: unknown): { ok: true; marginMode: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, marginMode: null };
  const v = String(raw).trim().toLowerCase();
  if (v === "cross" || v === "isolated") return { ok: true, marginMode: v };
  return { ok: false, error: "marginMode must be cross|isolated" };
}

const CLIENT_OID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export function validateClientOid(raw: unknown): { ok: true; clientOid: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, clientOid: null };
  const v = String(raw).trim();
  if (!CLIENT_OID_RE.test(v)) {
    return { ok: false, error: "clientOid must be 1..36 chars of [A-Za-z0-9_-]" };
  }
  return { ok: true, clientOid: v };
}

/** Longest idempotency key the log lookup indexes (matches execute-guard). */
export const IDEMPOTENCY_KEY_MAX_LEN = 160;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:.=-]{1,160}$/;

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Normalize a caller-supplied idempotency key; overlong keys truncate
 *  with a hash suffix so distinct intents never share a lookup key. */
export function normalizeIdempotencyKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const t = key.trim();
  if (!t) return null;
  if (t.length > 512) return null;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  if (t.length <= IDEMPOTENCY_KEY_MAX_LEN) {
    return IDEMPOTENCY_KEY_RE.test(t) ? t : null;
  }
  const head = t.slice(0, IDEMPOTENCY_KEY_MAX_LEN - 9);
  if (!/^[A-Za-z0-9_:.=-]+$/.test(head)) return null;
  return `${head}-${shortHash(t)}`;
}

export function validateOrderType(raw: unknown): { ok: true; type: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, type: null };
  const v = String(raw).trim().toLowerCase();
  if (v === "market" || v === "limit") return { ok: true, type: v };
  return { ok: false, error: "type must be market|limit" };
}

export function validateTradeSide(raw: unknown): { ok: true; side: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "buy" || v === "sell") return { ok: true, side: v };
  return { ok: false, error: "side must be buy|sell" };
}

/* ── propose_* card validators ──
 *
 * The five Cycle-05 proposal tools (trade_ideas, bracket, predict_market,
 * close_all_positions, withdraw) are approval cards: they record proposal
 * rows and never execute. These pure validators keep malformed cards from
 * reaching the DB — same discipline as the execute_trade field validators
 * above. All caps mirror the agent-chat slice widths (thesis 2000,
 * jev_verdict 1000, invalidation/rationale 500) so harness rows read
 * identically to chat rows in the Diary.
 */

/** Caps for free-text proposal fields (slice widths, never silent truncation). */
export const MAX_PROPOSAL_RATIONALE_CHARS = 1000;
export const MAX_PROPOSAL_THESIS_CHARS = 2000;
export const MAX_PROPOSAL_JEV_CHARS = 1000;
export const MAX_PROPOSAL_QUESTION_CHARS = 500;
export const MAX_PROPOSAL_ADDRESS_CHARS = 128;

/** Proposal side: buy|sell plus the long|short aliases the desk sends. */
export function validateProposeSide(raw: unknown): { ok: true; side: "buy" | "sell" } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "buy" || v === "long") return { ok: true, side: "buy" };
  if (v === "sell" || v === "short") return { ok: true, side: "sell" };
  return { ok: false, error: "side must be buy|sell (long|short accepted as aliases)" };
}

/** Required non-empty text with a length cap. */
export function validateProposalText(
  raw: unknown, field: string, maxLen: number,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { ok: false, error: `${field} is required` };
  if (v.length > maxLen) return { ok: false, error: `${field} too long (max ${maxLen} chars)` };
  return { ok: true, value: v };
}

/** Positive number (prices, amounts, sizes). Rejects 0/null/NaN placeholders. */
export function validatePositiveNumber(
  raw: unknown, field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${field} must be > 0 — never 0/null placeholders` };
  return { ok: true, value: n };
}

/** Optional positive number (fee_usd, amount, confidence extras). */
export function validateOptionalPositiveNumber(
  raw: unknown, field: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  return validatePositiveNumber(raw, field);
}

/**
 * 1–3 price targets. Accepts the chat shapes ({price, weight?} on ideas,
 * {price, fraction?} on brackets) and normalizes to [{price, weight}].
 */
export function validatePriceTargets(
  raw: unknown, field: string,
): { ok: true; targets: Array<{ price: number; weight: number | null }> } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) {
    return { ok: false, error: `${field} needs 1–3 legs` };
  }
  const out: Array<{ price: number; weight: number | null }> = [];
  for (let i = 0; i < raw.length; i++) {
    const leg = (raw[i] ?? {}) as Record<string, unknown>;
    const px = validatePositiveNumber(leg.price, `${field}[${i}].price`);
    if (!px.ok) return px;
    const wRaw = leg.weight ?? leg.fraction;
    let weight: number | null = null;
    if (wRaw !== undefined && wRaw !== null) {
      const w = typeof wRaw === "number" ? wRaw : Number(wRaw);
      if (!Number.isFinite(w) || w < 0 || w > 1) {
        return { ok: false, error: `${field}[${i}].weight must be 0..1` };
      }
      weight = w;
    }
    out.push({ price: px.value, weight });
  }
  return { ok: true, targets: out };
}

/* ── daily_prep caps: one brief run stays bounded ── */
export const MAX_DAILY_PREP_NAMES = 5;
export const MAX_DAILY_PREP_CONNECTIONS = 10;

/* ── Error hygiene: generic wire text + correlation id ──
 *
 * Wire responses carry only a label and a ref; the full server-side
 * detail goes to the log under the same ref. Raw DB/downstream text
 * never reaches the client.
 */

export function newCorrelationId(): string {
  try {
    const id = crypto.randomUUID();
    return id.slice(0, 8);
  } catch {
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  }
}

export function internalErrorText(corr: string): string {
  return `internal: request failed (ref ${corr})`;
}

export function upstreamErrorText(corr: string): string {
  return `upstream: dependency failed (ref ${corr})`;
}

export function logServer(corr: string, ...parts: unknown[]): void {
  console.error(`[mcp-server][${corr}]`, ...parts);
}

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

