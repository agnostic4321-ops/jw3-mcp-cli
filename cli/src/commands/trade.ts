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
import {
  cancelAllListArgs,
  cancelToolArgs,
  closeToolArgs,
  executeToolArgs,
  exitsToolArgs,
  validateExecute,
} from "./trade-ticket.js";
import type { ExecuteArgs, TradeDeps } from "./trade-ticket.js";
import { checkLoopKill, selectCancelTargets } from "./trade-orders.js";

export * from "./trade-ticket.js";
export * from "./trade-orders.js";

function previewLines(title: string, rows: [string, string][]): string[] {
  const out = [title, "—".repeat(Math.min(title.length, 48))];
  for (const [k, v] of rows) out.push(`${k}: ${v}`);
  return out;
}

/** False = dry run printed, nothing sent. True = caller may fire. */
function gate(yes: boolean, lines: string[], jsonPreview?: { json: boolean; preview: unknown }): boolean {
  if (yes) return true;
  if (jsonPreview?.json) console.log(JSON.stringify(jsonPreview.preview));
  else {
    for (const l of lines) console.log(l);
    console.log("Dry run — nothing sent. Re-run with --yes to fire (real money).");
  }
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
    console.error(`Bad ticket: ${err} — nothing was called.`);
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
    ["idempotency-key", String(toolArgs.idempotency_key)],
    ...(toolArgs.actor !== undefined ? [["actor", String(toolArgs.actor)] as [string, string]] : []),
  ]);
  if (!gate(opts.yes, lines, { json: opts.json, preview: { mode: "preview", ticket: toolArgs } })) return;
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
    console.error("Usage: jw3 close --exchange kucoin --pair BTC/USDT --side long|short [--size …] --yes [--json]");
    process.exitCode = 2;
    return;
  }
  if (opts.size !== undefined && (!Number.isFinite(opts.size) || opts.size <= 0)) {
    console.error("Bad ticket: size must be > 0 in base units (omit for full size) — nothing was called.");
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
      { json: opts.json, preview: { mode: "preview", exchange: opts.exchange, pair: opts.pair, side, ...(opts.size !== undefined ? { size: opts.size } : { size: "full" }) } },
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
    console.error("Usage: jw3 exits --exchange kucoin --pair BTC/USDT [--sl …] [--tp …] [--market spot|futures] [--quantity …] --yes [--json]");
    process.exitCode = 2;
    return;
  }
  if (opts.market !== undefined && !["spot", "futures"].includes(opts.market.toLowerCase())) {
    console.error("Bad ticket: market must be spot|futures — nothing was called.");
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
      { json: opts.json, preview: { mode: "preview", exchange: opts.exchange, pair: opts.pair, stopLoss: opts.sl ?? null, takeProfit: opts.tp ?? null, market: opts.market ?? "futures", ...(opts.quantity !== undefined ? { quantity: opts.quantity } : {}) } },
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
    console.error("Usage: jw3 cancel --exchange kucoin --order-id … [--pair …] [--market spot|futures] --yes [--json]");
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
      { json: opts.json, preview: { mode: "preview", exchange: opts.exchange, orderId: opts.orderId, ...(opts.pair ? { pair: opts.pair } : {}), ...(opts.market ? { market: opts.market } : {}) } },
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
    console.error(`Bad ticket: ${err} — nothing was called.`);
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
