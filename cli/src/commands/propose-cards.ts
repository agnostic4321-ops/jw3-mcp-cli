/**
 * jw3 propose-* — CLI wrappers for the Cycle-05 MCP proposal cards.
 *
 * APPROVAL CARDS ONLY, never executions. Every command records a proposal
 * row via mcp-server (trade:propose scope) and prints where to approve it
 * in-app. Nothing here places an order, cancels anything, or moves funds.
 *
 *  - `jw3 propose-idea`      -> `propose_trade_ideas` (1 idea per call; batch with repeat calls)
 *  - `jw3 propose-bracket`   -> `propose_bracket` (atomic entry + SL + 1–3 OCO TPs)
 *  - `jw3 propose-predict`   -> `propose_predict_market` (JEV-gated: needs analyze_market first)
 *  - `jw3 propose-close-all` -> `propose_close_all_positions` (records intent; reviews in-app)
 *  - `jw3 propose-withdraw`  -> `propose_withdraw` (trade-only keys: completed in the exchange account)
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";
import { parseTpLegsFlag } from "./trade.js";

export const PROPOSE_CARDS_USAGE = `Usage:
  jw3 propose-idea --pair BTC/USDT --side buy --entry … --stop … --target 70000[:0.5],75000 --thesis "…" [--asset BTC] [--venue kucoin] [--exchange kucoin] [--timeframe 4h] [--size-usd …] [--jev-verdict …] [--rationale "…"] [--json]
  jw3 propose-bracket --exchange kucoin --pair BTC/USDT --side buy --entry-type market|limit [--entry-price …] --amount … --stop … --tp 70000:50,75000:50 [--fee-usd …] --rationale "…" [--json]
  jw3 propose-predict --market-id <id> --side yes|no --jev-verdict "…" --rationale "…" [--question "…"] [--amount …] [--venue polymarket|opinion] [--confidence 0..1] [--json]
  jw3 propose-close-all --rationale "…" [--exchange kucoin] [--pair BTC/USDT] [--order-type market|limit] [--limit-price …] [--json]
  jw3 propose-withdraw --source-exchange kucoin --asset USDT --network ETH --amount … --dest-address 0x… --rationale "…" [--dest-chain ethereum] [--json]`;

/** One idea's target leg after CLI parsing (price + optional 0..1 weight). */
export type IdeaTarget = { price: number; weight: number | null };

/** Parse --target "P[:W],..." into 1–3 legs. Weight is a 0..1 fraction (default null). */
export function parseIdeaTargets(raw: string | undefined): { targets?: IdeaTarget[]; error?: string } {
  if (raw === undefined) return {};
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    return { error: "--target expects 1..3 comma-separated price[:weight] legs (e.g. 70000:0.5,75000)" };
  }
  const targets: IdeaTarget[] = [];
  for (const part of parts) {
    const [pxRaw, wRaw] = part.split(":");
    const price = Number(pxRaw);
    if (!Number.isFinite(price) || !(price > 0)) {
      return { error: `invalid --target entry "${part}" — expected price[:weight] with price > 0` };
    }
    let weight: number | null = null;
    if (wRaw !== undefined && wRaw !== "") {
      const w = Number(wRaw);
      if (!Number.isFinite(w) || w < 0 || w > 1) {
        return { error: `invalid --target entry "${part}" — weight must be 0..1` };
      }
      weight = w;
    }
    targets.push({ price, weight });
  }
  return { targets };
}

function posNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type ProposeIdeaArgs = {
  pair: string;
  side: string;
  entry: number;
  stop: number;
  thesis: string;
  targets?: IdeaTarget[];
  targetRaw?: string;
  asset?: string;
  venue?: string;
  exchange?: string;
  timeframe?: string;
  sizeUsd?: number;
  jevVerdict?: string;
  rationale?: string;
};

/** Pure validation so bad idea cards fail before any network call. */
export function validateProposeIdea(a: ProposeIdeaArgs): string | null {
  if (!a.pair) return "pair required (e.g. BTC/USDT)";
  if (!["buy", "sell", "long", "short"].includes(a.side.toLowerCase())) {
    return "side must be buy|sell (long|short accepted as aliases)";
  }
  if (!Number.isFinite(a.entry) || a.entry <= 0) return "entry must be > 0 — never 0/null placeholders";
  if (!Number.isFinite(a.stop) || a.stop <= 0) return "stop must be > 0 — never 0/null placeholders";
  const longSide = ["buy", "long"].includes(a.side.toLowerCase());
  if (longSide ? a.stop >= a.entry : a.stop <= a.entry) {
    return "stop must sit on the loss side of entry (long: stop<entry, short: stop>entry)";
  }
  if (!a.thesis) return "thesis required (one line on why now)";
  if (a.targets !== undefined) {
    if (a.targets.length === 0 || a.targets.length > 3) return "--target expects 1..3 legs";
    for (const t of a.targets) {
      if (!(t.price > 0)) return "--target prices must be > 0";
      if (longSide ? t.price <= a.entry : t.price >= a.entry) {
        return "every --target must sit on the profit side of entry";
      }
    }
  }
  if (a.sizeUsd !== undefined && (!Number.isFinite(a.sizeUsd) || a.sizeUsd <= 0)) {
    return "size-usd must be > 0 when provided";
  }
  return null;
}

export async function cmdProposeIdea(
  args: ProposeIdeaArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const parsed = args.targets === undefined ? parseIdeaTargets(args.targetRaw) : {};
  if (parsed.error) {
    console.error(`Bad targets: ${parsed.error} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const withTargets = { ...args, targets: args.targets ?? parsed.targets };
  if (!withTargets.targets) {
    console.error("Bad targets: --target is required (1..3 price[:weight] legs, e.g. 70000:0.5,75000) — nothing was called.");
    process.exitCode = 2;
    return;
  }
  const err = validateProposeIdea(withTargets as ProposeIdeaArgs);
  if (err) {
    console.error(`Bad idea: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const longSide = ["buy", "long"].includes(withTargets.side.toLowerCase());
  const toolArgs: Record<string, unknown> = {
    ideas: [{
      pair: withTargets.pair,
      side: longSide ? "buy" : "sell",
      entry: withTargets.entry,
      stop: withTargets.stop,
      targets: withTargets.targets.map((t) => ({ price: t.price, ...(t.weight !== null ? { weight: t.weight } : {}) })),
      thesis: withTargets.thesis,
      ...(withTargets.asset ? { asset: withTargets.asset } : {}),
      ...(withTargets.venue ? { venue: withTargets.venue } : {}),
      ...(withTargets.exchange ? { exchange: withTargets.exchange } : {}),
      ...(withTargets.timeframe ? { timeframe: withTargets.timeframe } : {}),
      ...(withTargets.sizeUsd !== undefined ? { size_hint_usd: withTargets.sizeUsd } : {}),
    }],
    rationale: withTargets.rationale ?? withTargets.thesis,
    ...(withTargets.jevVerdict ? { jev_verdict: withTargets.jevVerdict } : {}),
  };
  let out: unknown;
  try {
    out = await callTool("propose_trade_ideas", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { idea_ids?: string[]; batch_id?: string };
  console.log(`Idea proposed (${r.idea_ids?.length ?? 1} row${(r.idea_ids?.length ?? 1) === 1 ? "" : "s"}${r.batch_id ? `, batch ${r.batch_id}` : ""}). Approve in-app: Diary → setups → Send to ticket.`);
}

export type ProposeBracketArgs = {
  exchange: string;
  pair: string;
  side: string;
  entryType: string;
  entryPrice?: number;
  amount: string;
  stop: number;
  tpRaw?: string;
  feeUsd?: number;
  rationale: string;
};

/** Pure validation so bad bracket cards fail before any network call. */
export function validateProposeBracket(a: ProposeBracketArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair) return "pair required (e.g. BTC/USDT)";
  if (!["buy", "sell", "long", "short"].includes(a.side.toLowerCase())) {
    return "side must be buy|sell (long|short accepted as aliases)";
  }
  if (!["market", "limit"].includes(a.entryType.toLowerCase())) {
    return "entry-type must be market|limit";
  }
  if (a.entryType.toLowerCase() === "limit" && (a.entryPrice === undefined || !Number.isFinite(a.entryPrice) || a.entryPrice <= 0)) {
    return "entry-price > 0 is required for a limit entry";
  }
  if (!a.amount || !Number.isFinite(parseFloat(a.amount)) || parseFloat(a.amount) <= 0) {
    return "amount must be > 0 in base units";
  }
  if (!Number.isFinite(a.stop) || a.stop <= 0) return "stop must be > 0 — never 0/null placeholders";
  if (!a.tpRaw) return "tp is required (1..3 price:share legs, e.g. 70000:50,75000:50)";
  if (!a.rationale) return "rationale required (one line on why now)";
  if (a.feeUsd !== undefined && (!Number.isFinite(a.feeUsd) || a.feeUsd <= 0)) {
    return "fee-usd must be > 0 when provided";
  }
  return null;
}

export async function cmdProposeBracket(
  args: ProposeBracketArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateProposeBracket(args);
  if (err) {
    console.error(`Bad bracket: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const legs = parseTpLegsFlag(args.tpRaw);
  if (legs.error || !legs.legs) {
    console.error(`Bad tp legs: ${legs.error ?? "could not parse --tp"} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = {
    exchange: args.exchange.toLowerCase(),
    pair: args.pair,
    side: args.side.toLowerCase(),
    entry_type: args.entryType.toLowerCase(),
    ...(args.entryPrice !== undefined ? { entry_price: args.entryPrice } : {}),
    amount: args.amount,
    stop_price: args.stop,
    take_profits: legs.legs.map((l) => ({ price: l.price, fraction: l.share / 100 })),
    ...(args.feeUsd !== undefined ? { fee_usd: args.feeUsd } : {}),
    rationale: args.rationale,
  };
  let out: unknown;
  try {
    out = await callTool("propose_bracket", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { setup_id?: string };
  console.log(`Bracket proposed${r.setup_id ? ` — setup ${r.setup_id}` : ""}. Approve in-app: Diary → setups → Send to ticket.`);
}

export type ProposePredictArgs = {
  marketId: string;
  side: string;
  jevVerdict: string;
  rationale: string;
  question?: string;
  amount?: number;
  venue?: string;
  confidence?: number;
};

/** Pure validation so bad prediction cards fail before any network call. */
export function validateProposePredict(a: ProposePredictArgs): string | null {
  if (!a.marketId) return "market-id required (Polymarket conditionId/slug or Opinion market id)";
  if (!["yes", "no"].includes(a.side.toLowerCase())) return "side must be yes|no";
  if (!a.jevVerdict) {
    return "jev-verdict required — run `jw3 analyze prediction <id>` first and cite its verdict";
  }
  if (!a.rationale) return "rationale required (why this market and side now)";
  if (a.venue !== undefined && !["polymarket", "opinion"].includes(a.venue.toLowerCase())) {
    return "venue must be polymarket|opinion";
  }
  if (a.amount !== undefined && posNum(a.amount) === null) return "amount must be > 0 pUSD when provided";
  if (a.confidence !== undefined && (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)) {
    return "confidence must be 0..1 when provided";
  }
  return null;
}

export async function cmdProposePredict(
  args: ProposePredictArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateProposePredict(args);
  if (err) {
    console.error(`Bad prediction: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = {
    market_id: args.marketId,
    side: args.side.toLowerCase(),
    jev_verdict: args.jevVerdict,
    rationale: args.rationale,
    ...(args.question ? { question: args.question } : {}),
    ...(args.amount !== undefined ? { amount: args.amount } : {}),
    ...(args.venue ? { venue: args.venue.toLowerCase() } : {}),
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
  };
  let out: unknown;
  try {
    out = await callTool("propose_predict_market", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { analysis_id?: string };
  console.log(`Prediction proposed${r.analysis_id ? ` — analysis ${r.analysis_id}` : ""}. Review and place in-app: Predictions → ticket.`);
}

export type ProposeCloseAllArgs = {
  rationale: string;
  exchange?: string;
  pair?: string;
  orderType?: string;
  limitPrice?: string;
};

/** Pure validation so bad close-all cards fail before any network call. */
export function validateProposeCloseAll(a: ProposeCloseAllArgs): string | null {
  if (!a.rationale) return "rationale required (why flatten now — this proposes closing EVERYTHING in scope)";
  const orderType = (a.orderType ?? "market").toLowerCase();
  if (!["market", "limit"].includes(orderType)) return "order-type must be market|limit";
  if (orderType === "limit" && posNum(a.limitPrice) === null) {
    return "limit-price > 0 is required for order-type=limit";
  }
  if (orderType === "market" && a.limitPrice !== undefined) {
    return "limit-price needs order-type=limit (a market flatten takes no price)";
  }
  return null;
}

export async function cmdProposeCloseAll(
  args: ProposeCloseAllArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateProposeCloseAll(args);
  if (err) {
    console.error(`Bad close-all: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = {
    rationale: args.rationale,
    ...(args.exchange ? { exchange: args.exchange.toLowerCase() } : {}),
    ...(args.pair ? { pair: args.pair } : {}),
    ...(args.orderType ? { order_type: args.orderType.toLowerCase() } : {}),
    ...(args.limitPrice !== undefined ? { limit_price: args.limitPrice } : {}),
  };
  let out: unknown;
  try {
    out = await callTool("propose_close_all_positions", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { proposal_id?: string; scope?: { exchange?: string | null; pair?: string | null } };
  const scope = r.scope?.pair ?? r.scope?.exchange ?? "every position";
  console.log(`Close-all proposed for ${scope}${r.proposal_id ? ` (proposal ${r.proposal_id})` : ""} — nothing was closed. Review every leg in-app: Trading → Positions → Close all.`);
}

export type ProposeWithdrawArgs = {
  sourceExchange: string;
  asset: string;
  network: string;
  amount: string;
  destAddress: string;
  destChain?: string;
  rationale: string;
};

/** Pure validation so bad withdrawal cards fail before any network call. */
export function validateProposeWithdraw(a: ProposeWithdrawArgs): string | null {
  if (!a.sourceExchange) return "source-exchange required (e.g. kucoin)";
  if (!a.asset) return "asset required (e.g. USDT)";
  if (!a.network) return "network required (e.g. ETH)";
  if (!a.amount || posNum(a.amount) === null) return "amount must be > 0 in human units";
  if (!a.destAddress) return "dest-address required (the full user-confirmed wallet address — never invented)";
  if (a.destAddress.trim().length < 8) return "dest-address looks truncated — pass the full user-confirmed address";
  if (!a.rationale) return "rationale required (why withdraw now)";
  return null;
}

export async function cmdProposeWithdraw(
  args: ProposeWithdrawArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateProposeWithdraw(args);
  if (err) {
    console.error(`Bad withdrawal: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = {
    source_exchange: args.sourceExchange.toLowerCase(),
    asset: args.asset,
    network: args.network,
    amount: args.amount,
    dest_address: args.destAddress,
    ...(args.destChain ? { dest_chain: args.destChain.toLowerCase() } : {}),
    rationale: args.rationale,
  };
  let out: unknown;
  try {
    out = await callTool("propose_withdraw", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { proposal_id?: string };
  console.log(`Withdrawal proposed${r.proposal_id ? ` (proposal ${r.proposal_id})` : ""} — no funds moved. Approval pre-fills the exchange form; complete it inside your exchange account (trade-only keys).`);
}
