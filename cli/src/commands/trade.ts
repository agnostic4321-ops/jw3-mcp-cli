/**
 * Fund-moving commands. Real money. Every one of these:
 *  - prints a preview first and sends NOTHING without --yes,
 *  - re-checks server-side (YOLO eligibility, kill switch, caps,
 *    fee-aware stop gate) — a CLI yes never overrides a server no,
 *  - needs a PAT with the trade:execute scope (re-login with
 *    --scope "mcp:read trade:propose trade:execute").
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

export type ExecuteTpLeg = { price: number; share: number };

export type ExecuteArgs = {
  /**
   * The per-INTENT idempotency key. A retry of the same intent carries
   * the same key, so the server dedupes it instead of double-filling.
   * Omit it and the server has no way to tell a retry from a new order.
   */
  idempotencyKey?: string;

  exchange: string;
  pair: string;
  side: string;
  amount?: number;
  price?: number;
  market?: string;
  leverage?: number;
  marginMode?: string;
  stop?: number;
  tp?: number;
  tpLegs?: ExecuteTpLeg[];
  riskUsd?: number;
};

export function parseTpLegsFlag(raw: string | undefined): { legs?: ExecuteTpLeg[]; error?: string } {
  if (raw === undefined) return {};
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) {
    return { error: "tp-legs expects 1..3 comma-separated price:share pairs (e.g. 75000:50,80000:50)" };
  }
  const legs: ExecuteTpLeg[] = [];
  for (const part of parts) {
    const [pxRaw, shRaw] = part.split(":");
    const price = Number(pxRaw);
    const share = shRaw === undefined || shRaw === "" ? Math.floor(100 / parts.length) : Number(shRaw);
    if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(share) || !(share > 0) || share > 100) {
      return { error: `invalid tp-legs entry "${part}" — expected price:share with price > 0 and share in (0, 100]` };
    }
    legs.push({ price, share });
  }
  return { legs };
}

export function validateExecute(a: ExecuteArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair) return "pair required (e.g. BTC/USDT)";
  if (!["buy", "sell"].includes(a.side.toLowerCase())) return "side must be buy|sell";
  const hasAmount = a.amount !== undefined;
  const hasRisk = a.riskUsd !== undefined;
  if (hasAmount && hasRisk) return "pass --amount or --risk-usd, not both";
  if (!hasAmount && !hasRisk) return "pass --amount (base units) or --risk-usd (sizes from stop)";
  if (hasAmount && (!Number.isFinite(a.amount) || (a.amount as number) <= 0)) return "amount must be > 0";
  if (hasRisk && (!Number.isFinite(a.riskUsd) || (a.riskUsd as number) <= 0)) return "risk-usd must be > 0";
  if (a.price !== undefined && (!Number.isFinite(a.price) || a.price <= 0)) return "price must be > 0 (omit for market)";
  if (a.market !== undefined && !["spot", "futures"].includes(a.market.toLowerCase())) {
    return "market must be spot|futures";
  }
  if (a.leverage !== undefined && (!Number.isFinite(a.leverage) || a.leverage <= 0)) return "leverage must be > 0";
  if (a.marginMode !== undefined && !["cross", "isolated"].includes(a.marginMode.toLowerCase())) {
    return "margin-mode must be cross|isolated";
  }
  if (a.stop !== undefined && (!Number.isFinite(a.stop) || a.stop <= 0)) return "stop must be > 0";
  if (a.tp !== undefined && (!Number.isFinite(a.tp) || a.tp <= 0)) return "tp must be > 0";
  if (a.tp !== undefined && a.tpLegs && a.tpLegs.length > 0) return "pass --tp or --tp-legs, not both";
  if (a.tpLegs !== undefined) {
    if (a.tpLegs.length === 0 || a.tpLegs.length > 3) return "tp-legs must have 1..3 legs";
    for (const l of a.tpLegs) {
      if (!Number.isFinite(l.price) || l.price <= 0) return "tp-legs price must be > 0";
      if (!Number.isFinite(l.share) || l.share <= 0 || l.share > 100) return "tp-legs share must be in (0, 100]";
    }
  }
  return null;
}

/** Injectable MCP call (tests spy on it; prod passes callTool). */
export type TradeCall = (
  name: string,
  args: Record<string, unknown>,
  pat: string,
  url?: string,
) => Promise<unknown>;

export type TradeDeps = { call?: TradeCall };

/**
 * Pure ticket builders — the SINGLE construction site for every fund-moving
 * ticket. Preview (dry run) and fire (--yes) both go through these, so the
 * dry run literally cannot diverge from what --yes would send. Covered by
 * dry-run parity tests: same input → same toolArgs, zero calls without --yes.
 */
export function executeToolArgs(a: ExecuteArgs): Record<string, unknown> {
  const toolArgs: Record<string, unknown> = {
    exchange: a.exchange,
    pair: a.pair,
    side: a.side.toLowerCase(),
  };
  if (a.amount !== undefined) toolArgs.amount = String(a.amount);
  if (a.price !== undefined) toolArgs.price = String(a.price);
  if (a.market) toolArgs.market = a.market.toLowerCase();
  if (a.leverage !== undefined) toolArgs.leverage = a.leverage;
  if (a.marginMode) toolArgs.marginMode = a.marginMode.toLowerCase();
  if (a.stop !== undefined) toolArgs.stop = a.stop;
  if (a.tp !== undefined) toolArgs.tp = a.tp;
  if (a.tpLegs !== undefined && a.tpLegs.length > 0) toolArgs.tpLegs = a.tpLegs;
  if (a.riskUsd !== undefined) toolArgs.risk_usd = a.riskUsd;
  // The per-INTENT idempotency key. A retry of the SAME intent carries
  // the SAME key, so the server dedupes it and never double-fills. The
  // client owns the key's uniqueness; the server owns the dedupe.
  if (a.idempotencyKey !== undefined && a.idempotencyKey.trim() !== "") {
    toolArgs.idempotency_key = a.idempotencyKey.trim();
  }
  return toolArgs;
}

export function closeToolArgs(o: { exchange: string; pair: string; side: string; size?: number }): Record<string, unknown> {
  return {
    exchange: o.exchange,
    pair: o.pair,
    side: o.side.toLowerCase(),
    ...(o.size !== undefined ? { size: String(o.size) } : {}),
  };
}

export function exitsToolArgs(o: {
  exchange: string;
  pair: string;
  sl?: number;
  tp?: number;
  market?: string;
  quantity?: number;
}): Record<string, unknown> {
  return {
    exchange: o.exchange,
    pair: o.pair,
    ...(o.sl != null ? { slPrice: o.sl } : {}),
    ...(o.tp != null ? { tpPrice: o.tp } : {}),
    ...(o.market ? { market: o.market.toLowerCase() } : {}),
    ...(o.quantity != null ? { quantity: o.quantity } : {}),
  };
}

export function cancelToolArgs(o: {
  exchange: string;
  orderId: string;
  pair?: string;
  market?: string;
}): Record<string, unknown> {
  return {
    exchange: o.exchange,
    orderId: o.orderId,
    ...(o.pair ? { pair: o.pair } : {}),
    ...(o.market ? { market: o.market.toLowerCase() } : {}),
  };
}

/** list_open_orders args for cancel-all scoping + post-run verification. */
export function cancelAllListArgs(o: { exchange: string; pair: string }): Record<string, unknown> {
  return { exchange: o.exchange, pair: o.pair };
}

function previewLines(title: string, rows: [string, string][]): string[] {
  const out = [title, "—".repeat(Math.min(title.length, 48))];
  for (const [k, v] of rows) out.push(`${k}: ${v}`);
  return out;
}

/** False = dry run printed, nothing sent. True = caller may fire. */
function gate(yes: boolean, lines: string[]): boolean {
  if (yes) return true;
  for (const l of lines) console.log(l);
  console.log("Dry run — nothing sent. Re-run with --yes to fire (real money).");
  return false;
}

function scopeHint(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/trade:execute/.test(msg)) {
    console.error(
      `Refused: ${msg}\nRe-login with the execute scope: jw3 auth login --browser --scope "mcp:read trade:propose trade:execute" (needs YOLO eligibility: kill switch off, autonomy != propose_only).`,
    );
    process.exitCode = 1;
    return true;
  }
  return false;
}

export async function cmdExecute(
  args: ExecuteArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
  deps?: TradeDeps,
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateExecute(args);
  if (err) {
    console.error(`Bad ticket: ${err}`);
    process.exitCode = 2;
    return;
  }
  const call = deps?.call ?? callTool;
  const toolArgs = executeToolArgs(args);
  const lines = previewLines("LIVE ORDER (real money)", [
    ["exchange", args.exchange],
    ["pair", args.pair],
    ["side", args.side.toUpperCase()],
    ["size", args.amount !== undefined ? `${args.amount}` : `risk $${args.riskUsd}`],
    ["price", args.price !== undefined ? `${args.price}` : "market"],
    ["market", args.market ?? "—"],
    ["leverage", args.leverage !== undefined ? `${args.leverage}x` : "—"],
    ["stop", args.stop !== undefined ? `${args.stop}` : "—"],
    ["take-profit", args.tpLegs?.length ? args.tpLegs.map((l) => `${l.price} (${l.share}%)`).join(", ") : args.tp !== undefined ? `${args.tp}` : "—"],
  ]);
  if (!gate(opts.yes, lines)) return;
  try {
    const out = await call("execute_trade", toolArgs, pat, opts.url);
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    if (!scopeHint(e)) fail(e);
  }
}

export async function cmdClose(opts: {
  exchange: string;
  pair: string;
  side: string;
  size?: number;
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: TradeDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const side = opts.side.toLowerCase();
  if (!opts.exchange || !opts.pair || (side !== "long" && side !== "short")) {
    console.error("Usage: jw3 close --exchange kucoin --pair BTC/USDT --side long|short [--size …] --yes");
    process.exitCode = 2;
    return;
  }
  if (opts.size !== undefined && (!Number.isFinite(opts.size) || opts.size <= 0)) {
    console.error("Bad ticket: size must be > 0 in base units (omit for full size).");
    process.exitCode = 2;
    return;
  }
  if (
    !gate(
      opts.yes,
      previewLines("CLOSE POSITION (real money)", [
        ["exchange", opts.exchange],
        ["pair", opts.pair],
        ["open side", side.toUpperCase()],
        ["size", opts.size !== undefined ? `${opts.size}` : "full"],
      ]),
    )
  ) {
    return;
  }
  try {
    const call = deps?.call ?? callTool;
    const out = await call(
      "close_position",
      closeToolArgs({ exchange: opts.exchange, pair: opts.pair, side, size: opts.size }),
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    if (!scopeHint(e)) fail(e);
  }
}

export async function cmdExits(opts: {
  exchange: string;
  pair: string;
  sl?: number;
  tp?: number;
  market?: string;
  quantity?: number;
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: TradeDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange || !opts.pair || (!(opts.sl != null && opts.sl > 0) && !(opts.tp != null && opts.tp > 0))) {
    console.error("Usage: jw3 exits --exchange kucoin --pair BTC/USDT [--sl …] [--tp …] [--market spot|futures] [--quantity …] --yes");
    process.exitCode = 2;
    return;
  }
  if (opts.market !== undefined && !["spot", "futures"].includes(opts.market.toLowerCase())) {
    console.error("Bad ticket: market must be spot|futures.");
    process.exitCode = 2;
    return;
  }
  if (
    !gate(
      opts.yes,
      previewLines("ARM EXITS (real money)", [
        ["exchange", opts.exchange],
        ["pair", opts.pair],
        ["stop-loss", opts.sl != null ? `${opts.sl}` : "—"],
        ["take-profit", opts.tp != null ? `${opts.tp}` : "—"],
        ["market", opts.market ?? "futures"],
      ]),
    )
  ) {
    return;
  }
  try {
    const call = deps?.call ?? callTool;
    const out = await call(
      "set_exits",
      exitsToolArgs({ exchange: opts.exchange, pair: opts.pair, sl: opts.sl, tp: opts.tp, market: opts.market, quantity: opts.quantity }),
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    if (!scopeHint(e)) fail(e);
  }
}

export async function cmdCancel(opts: {
  exchange: string;
  orderId: string;
  pair?: string;
  market?: string;
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: TradeDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (!opts.exchange || !opts.orderId) {
    console.error("Usage: jw3 cancel --exchange kucoin --order-id … [--pair …] [--market spot|futures] --yes");
    process.exitCode = 2;
    return;
  }
  if (
    !gate(
      opts.yes,
      previewLines("CANCEL ORDER", [
        ["exchange", opts.exchange],
        ["order", opts.orderId],
      ]),
    )
  ) {
    return;
  }
  try {
    const call = deps?.call ?? callTool;
    const out = await call(
      "cancel_order",
      cancelToolArgs({ exchange: opts.exchange, orderId: opts.orderId, pair: opts.pair, market: opts.market }),
      pat,
      opts.url,
    );
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    if (!scopeHint(e)) fail(e);
  }
}

export type CancelAllArgs = {
  exchange: string;
  pair: string;
  market?: string;
};

/** Pair is required (never book-wide) and must look like BASE/QUOTE. */
export function validateCancelAll(a: CancelAllArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. BTC/USDT) — cancel-all never runs book-wide";
  if (a.market !== undefined && !["spot", "futures"].includes(a.market.toLowerCase())) {
    return "market must be spot|futures";
  }
  return null;
}

/**
 * Canonical pair key: BTC/USDT ≡ btcusdt. Same normalization the
 * server's fills/PnL filters use, so client and server agree on identity.
 */
export function pairKey(pair: unknown): string {
  return String(pair ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type OpenOrderRow = Record<string, unknown>;

/** Order id out of a venue-shaped row (orderId, id, ordId variants). */
export function cancelOrderIdOf(row: OpenOrderRow): string | null {
  const id = row.orderId ?? row.id ?? row.ordId;
  const s = String(id ?? "").trim();
  return s ? s : null;
}

/**
 * list_open_orders payload → rows. The cex-proxy returns a bare array;
 * wrapped shapes ({orders}, {openOrders}) are accepted so a future
 * envelope change degrades to working, not to cancelling nothing.
 */
export function extractOpenOrders(out: unknown): OpenOrderRow[] {
  const isRow = (r: unknown): r is OpenOrderRow => !!r && typeof r === "object";
  if (Array.isArray(out)) return out.filter(isRow);
  if (out && typeof out === "object") {
    for (const k of ["orders", "openOrders", "result", "data"] as const) {
      const v = (out as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.filter(isRow);
    }
  }
  return [];
}

/**
 * Rows of this pair only. The list call is already pair-scoped server-side;
 * this re-checks client-side so a mistyped --pair can never wipe the wrong
 * book when a venue ignores the filter. Rows without a symbol carry no pair
 * evidence and are kept (the server scoped them); rows with a *different*
 * pair are dropped.
 */
export function selectCancelTargets(out: unknown, pair: string): { orderId: string; symbol: string }[] {
  const want = pairKey(pair);
  const targets: { orderId: string; symbol: string }[] = [];
  for (const row of extractOpenOrders(out)) {
    const id = cancelOrderIdOf(row);
    if (!id) continue;
    const sym = String(row.symbol ?? "");
    if (want && pairKey(sym) && pairKey(sym) !== want) continue;
    targets.push({ orderId: id, symbol: sym });
  }
  return targets;
}

export type LoopRisk = {
  killSwitch: boolean | null;
  breakerTripped: boolean | null;
  autonomy: string | null;
  dailyLoss: number | null;
  maxDailyLoss: number | null;
  tradesToday: number | null;
  maxTrades: number | null;
};

function numOrNull(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * read_risk_limits payload ({risk_limits:{…}} or the bare row, snake or
 * camel keys) → one shape. Unknown stays null, never a guessed zero — a
 * missing cap must not read as "no cap" nor as "cap hit".
 */
export function normalizeRiskLimits(out: unknown): LoopRisk {
  const o = out && typeof out === "object" ? (out as Record<string, unknown>) : {};
  const inner = o.risk_limits && typeof o.risk_limits === "object" ? (o.risk_limits as Record<string, unknown>) : o;
  const boolOrNull = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
  const breakerRaw = inner.circuit_breaker_tripped_at ?? inner.circuitBreakerTripped;
  return {
    killSwitch: boolOrNull(inner.kill_switch_enabled ?? inner.killSwitchEnabled),
    breakerTripped:
      "circuit_breaker_tripped_at" in inner || "circuitBreakerTripped" in inner
        ? breakerRaw === true || (typeof breakerRaw === "string" && breakerRaw.length > 0)
        : null,
    autonomy:
      typeof (inner.autonomy_level ?? inner.autonomyLevel) === "string"
        ? (inner.autonomy_level ?? inner.autonomyLevel) as string
        : null,
    dailyLoss: numOrNull(inner.daily_realized_loss_usd ?? inner.dailyRealizedLossUsd),
    maxDailyLoss: numOrNull(inner.max_daily_loss_usd ?? inner.maxDailyLossUsd),
    tradesToday: numOrNull(inner.daily_trade_count ?? inner.dailyTradeCount),
    maxTrades: numOrNull(inner.max_trades_per_day ?? inner.maxTradesPerDay),
  };
}

/**
 * Loop kill-check against risk limits. String = halt now with this reason
 * (priority: kill switch → breaker → daily-loss cap → max trades);
 * null = clear. Autonomy level is exposed on LoopRisk but is NOT a halt:
 * propose_only blocks opening, never risk-reducing loops like cancel-all.
 */
export function loopKillReason(r: LoopRisk): string | null {
  if (r.killSwitch === true) return "kill switch engaged";
  if (r.breakerTripped === true) return "circuit breaker tripped";
  if (r.maxDailyLoss != null && r.maxDailyLoss > 0 && r.dailyLoss != null && r.dailyLoss >= r.maxDailyLoss) {
    return `daily loss cap reached ($${r.dailyLoss} ≥ $${r.maxDailyLoss})`;
  }
  if (r.maxTrades != null && r.maxTrades > 0 && r.tradesToday != null && r.tradesToday >= r.maxTrades) {
    return `max trades reached (${r.tradesToday} ≥ ${r.maxTrades})`;
  }
  return null;
}

/**
 * Live kill-check for long-running loops: reads risk limits, returns the
 * halt reason (null = clear). Never throws — an unreadable row is reported
 * via readError, not hidden. Cancels may proceed under a halt (they reduce
 * risk); loops that OPEN risk should treat a halt — or an unreadable row —
 * as stop.
 */
export async function checkLoopKill(
  pat: string,
  url?: string,
  call: TradeCall = callTool,
): Promise<{ reason: string | null; risk: LoopRisk | null; readError?: string }> {
  let out: unknown;
  try {
    out = await call("read_risk_limits", {}, pat, url);
  } catch (e) {
    return { reason: null, risk: null, readError: e instanceof Error ? e.message : String(e) };
  }
  const risk = normalizeRiskLimits(out);
  return { reason: loopKillReason(risk), risk };
}

/**
 * `cancel-all` — list this pair's open orders, fan out one cancel_order per
 * id (sequential: venue rate limits + a clean per-order error story), then
 * VERIFY by re-listing: the run only reports success when the venue shows
 * zero working orders for the pair afterwards. Preview without --yes, act
 * with it. A risk-limits kill-check runs first and is disclosed on stderr;
 * it never blocks — cancels reduce risk. Scope refusal stops the fan-out
 * (the rest would fail identically).
 */
export async function cmdCancelAll(opts: {
  exchange: string;
  pair: string;
  market?: string;
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
}, deps?: TradeDeps): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateCancelAll({ exchange: opts.exchange, pair: opts.pair, market: opts.market });
  if (err) {
    console.error(`Bad ticket: ${err}`);
    process.exitCode = 2;
    return;
  }
  const call = deps?.call ?? callTool;
  const market = opts.market?.toLowerCase();
  let riskHalt: string | null = null;
  const kill = await checkLoopKill(pat, opts.url, call);
  if (kill.readError) {
    console.error(`Risk check unreadable (${kill.readError}) — proceeding with cancels only.`);
  } else if (kill.reason) {
    riskHalt = kill.reason;
    console.error(`RISK HALT: ${kill.reason} — cancels are risk-reducing, proceeding.`);
  }
  let listed: unknown;
  try {
    listed = await call("list_open_orders", cancelAllListArgs({ exchange: opts.exchange, pair: opts.pair }), pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  const targets = selectCancelTargets(listed, opts.pair);
  const ids = targets.map((t) => t.orderId);
  if (targets.length === 0) {
    if (opts.json) {
      console.log(
        JSON.stringify({
          mode: opts.yes ? "cancel-all" : "preview",
          exchange: opts.exchange,
          pair: opts.pair,
          orders: [],
          cancelled: [],
          failed: [],
          ...(riskHalt ? { riskHalt } : {}),
        }),
      );
    } else {
      console.log(`No open orders for ${opts.pair} on ${opts.exchange} — nothing to cancel.`);
    }
    return;
  }
  if (opts.json && !opts.yes) {
    console.log(
      JSON.stringify({
        mode: "preview",
        exchange: opts.exchange,
        pair: opts.pair,
        ...(market ? { market } : {}),
        orders: ids,
        ...(riskHalt ? { riskHalt } : {}),
      }),
    );
    return;
  }
  if (
    !gate(
      opts.yes,
      previewLines("CANCEL ALL (real money)", [
        ["exchange", opts.exchange],
        ["pair", opts.pair],
        ["orders", `${targets.length}`],
        ...targets.map((t): [string, string] => [" −", `${t.orderId}${t.symbol ? `  ${t.symbol}` : ""}`]),
      ]),
    )
  ) {
    return;
  }
  const cancelled: string[] = [];
  const failed: { orderId: string; error: string }[] = [];
  let scopeRefused = false;
  for (const t of targets) {
    try {
      await call(
        "cancel_order",
        {
          exchange: opts.exchange,
          orderId: t.orderId,
          pair: opts.pair,
          ...(market ? { market } : {}),
        },
        pat,
        opts.url,
      );
      cancelled.push(t.orderId);
      if (!opts.json) console.log(`CANCELLED ${t.orderId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ orderId: t.orderId, error: msg });
      if (!scopeRefused && /trade:execute/.test(msg)) {
        scopeRefused = true;
        console.error(
          `Refused: ${msg}\nRe-login with the execute scope: jw3 auth login --browser --scope "mcp:read trade:propose trade:execute" (needs YOLO eligibility: kill switch off, autonomy != propose_only). Stopping the fan-out — the rest would fail the same way.`,
        );
        break;
      }
      console.error(`CANCEL ${t.orderId} FAILED: ${msg}`);
    }
  }
  const skipped = targets.length - cancelled.length - failed.length;
  // Verification: re-list the pair — the run only claims success when the
  // venue shows zero working orders afterwards. A failed re-list is
  // reported as unverified (never as clean).
  let remaining: { orderId: string; symbol: string }[] = [];
  let verifyError: string | null = null;
  try {
    const relisted = await call("list_open_orders", cancelAllListArgs({ exchange: opts.exchange, pair: opts.pair }), pat, opts.url);
    remaining = selectCancelTargets(relisted, opts.pair);
  } catch (e) {
    verifyError = e instanceof Error ? e.message : String(e);
  }
  const verified = verifyError === null && remaining.length === 0;
  const remainingIds = remaining.map((t) => t.orderId);
  if (!verified && !opts.json) {
    if (verifyError) console.error(`VERIFY FAILED: re-list errored (${verifyError}) — cancel state unknown, re-run reconcile.`);
    else console.error(`UNVERIFIED: ${remaining.length} order(s) still working: ${remainingIds.join(", ")} — re-run cancel-all or reconcile.`);
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        mode: "cancel-all",
        exchange: opts.exchange,
        pair: opts.pair,
        ...(market ? { market } : {}),
        orders: ids,
        cancelled,
        failed,
        ...(skipped > 0 ? { skipped } : {}),
        ...(riskHalt ? { riskHalt } : {}),
        verified,
        remaining: remainingIds,
        ...(verifyError ? { verifyError } : {}),
      }),
    );
  } else {
    console.log(
      `cancel-all: ${cancelled.length} cancelled, ${failed.length} failed of ${targets.length}${skipped > 0 ? ` (${skipped} skipped after scope refusal)` : ""} — ${verified ? "verified flat (0 working orders)" : "NOT verified"}.`,
    );
  }
  if (failed.length > 0 || !verified) process.exitCode = 1;
}
