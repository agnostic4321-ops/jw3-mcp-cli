/**
 * Fill-or-chase execution: `jw3 execute … --chase <secs>`.
 *
 * Maker limits rest through fast moves (verified pain): a plain limit
 * sits stale while the touch runs away. Chase places the limit AT the
 * touch, polls, and auto cancel-replaces onto the new touch up to
 * `--chase-max` times inside a `--chase <secs>` budget. At expiry the
 * working order is cancelled and either left flat (default, safe) or
 * taken with one market order (`--chase-take`).
 *
 * This module owns the whole loop. trade.ts builders are reused by
 * import, never edited: executeToolArgs builds every place ticket,
 * cancelToolArgs every cancel, extractOpenOrders every fill read — so
 * the chase fires exactly the tickets a plain execute would.
 */
import { flagOf } from "./args.js";
import { futuresContract } from "./kucoin-ws.js";
import { futuresTickerFull } from "./kucoin.js";
import { callTool } from "./mcp.js";
import { fail, needPat } from "./commands/market.js";
import {
  cancelAllListArgs,
  cancelOrderIdOf,
  cancelToolArgs,
  executeToolArgs,
  extractOpenOrders,
  makeIntentKey,
  validateExecute,
  type ExecuteArgs,
  type TradeCall,
} from "./commands/trade.js";

/** Total chase budget: 1s..10min. The loop always terminates. */
export const CHASE_MAX_SECS = 600;
/** Poll cadence bounds: 0.5s..30s. */
export const CHASE_MIN_POLL_S = 0.5;
export const CHASE_MAX_POLL_S = 30;
/** Default poll cadence. */
export const CHASE_DEFAULT_POLL_S = 2;

export type ChaseConfig = {
  enabled: boolean;
  /** Total budget in seconds (the --chase value). */
  secs: number;
  /** Poll cadence in seconds. */
  pollSecs: number;
  /** Max cancel-replaces inside the budget (undefined = every touch move). */
  maxChases?: number;
  /** At expiry: cancel + one market take. Default false = cancel + abort. */
  take: boolean;
};

export const CHASE_OFF: ChaseConfig = { enabled: false, secs: 0, pollSecs: CHASE_DEFAULT_POLL_S, take: false };

/**
 * Pure: chase flags out of the execute tail. No --chase → CHASE_OFF
 * (plain execute path, zero behavior change).
 */
export function parseChaseFlags(rest: string[]): { cfg: ChaseConfig } | { error: string } {
  const raw = flagOf(rest, "--chase");
  if (raw === undefined) return { cfg: { ...CHASE_OFF } };
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs <= 0 || secs > CHASE_MAX_SECS) {
    return { error: `--chase must be 0 < secs <= ${CHASE_MAX_SECS} (got ${JSON.stringify(raw)})` };
  }
  const pollRaw = flagOf(rest, "--chase-poll");
  const pollSecs = pollRaw === undefined ? CHASE_DEFAULT_POLL_S : Number(pollRaw);
  if (!Number.isFinite(pollSecs) || pollSecs < CHASE_MIN_POLL_S || pollSecs > CHASE_MAX_POLL_S) {
    return { error: `--chase-poll must be ${CHASE_MIN_POLL_S}..${CHASE_MAX_POLL_S}s (got ${JSON.stringify(pollRaw)})` };
  }
  const maxRaw = flagOf(rest, "--chase-max");
  let maxChases: number | undefined;
  if (maxRaw !== undefined) {
    const n = Number(maxRaw);
    if (!Number.isInteger(n) || n < 0) return { error: `--chase-max must be an integer >= 0 (got ${JSON.stringify(maxRaw)})` };
    maxChases = n;
  }
  return { cfg: { enabled: true, secs, pollSecs, maxChases, take: rest.includes("--chase-take") } };
}

/** Pure validation for a chase config against the execute ticket. Null = usable. */
export function validateChase(cfg: ChaseConfig, market?: string): string | null {
  if (!cfg.enabled) return null;
  if (!(cfg.secs > 0) || cfg.secs > CHASE_MAX_SECS) return `--chase must be 0 < secs <= ${CHASE_MAX_SECS}`;
  if (!(cfg.pollSecs >= CHASE_MIN_POLL_S) || cfg.pollSecs > CHASE_MAX_POLL_S) {
    return `--chase-poll must be ${CHASE_MIN_POLL_S}..${CHASE_MAX_POLL_S}s`;
  }
  if (cfg.maxChases !== undefined && (!Number.isInteger(cfg.maxChases) || cfg.maxChases < 0)) {
    return "--chase-max must be an integer >= 0";
  }
  // The touch read is the futures public tape — no spot touch source exists.
  if (market !== undefined && market.toLowerCase() === "spot") {
    return "chase touch is futures-only: drop --chase or run without --market spot";
  }
  return null;
}

export type ChaseSide = "buy" | "sell";
export type Touch = { bestBid: number; bestAsk: number };

/**
 * Pure: resting-maker price for a side. Buy joins the bid, sell joins
 * the ask — never crosses the spread. NaN when the touch is unusable.
 */
export function chaseTouchFor(side: string, t: Touch): number {
  const px = side.toLowerCase() === "sell" ? t.bestAsk : t.bestBid;
  return px > 0 && Number.isFinite(px) ? px : NaN;
}

/** Pure: the touch moved off the working price — a replace is warranted. */
export function shouldReprice(workingPrice: number, touchPrice: number): boolean {
  return (
    Number.isFinite(workingPrice) &&
    workingPrice > 0 &&
    Number.isFinite(touchPrice) &&
    touchPrice > 0 &&
    touchPrice !== workingPrice
  );
}

/**
 * Pure: orderId still has a working row in a list_open_orders payload.
 * Absent (and not cancelled by us) = filled. Reuses the trade.ts row
 * shapes so venue/envelope drift degrades the same way cancel-all does.
 */
export function isChaseWorking(listOut: unknown, orderId: string): boolean {
  for (const row of extractOpenOrders(listOut)) {
    if (cancelOrderIdOf(row) === orderId) return true;
  }
  return false;
}

export type ChaseOutcome = "filled" | "taken" | "aborted" | "stuck";

export type ChaseResult = {
  outcome: ChaseOutcome;
  /** Filled/taken/aborted order id (taken = the market take id). */
  orderId: string;
  /** Cancel-replaces performed. */
  chases: number;
  /**
   * Set when a cancel failed: the order may still be live — NEVER stack
   * a replacement or take on top, reconcile by hand. Terminal take is
   * skipped when its cancel fails for the same reason.
   */
  cancelError?: string;
  /**
   * Why a replace was refused without a cancel failure (e.g. foreign
   * working orders on the pair, or our order already gone). Informational:
   * the run aborted flat rather than stacking blind.
   */
  note?: string;
};

export type ChaseEvent =
  | { kind: "placed"; orderId: string; price: number | null }
  | { kind: "replaced"; from: string; to: string; price: number }
  | { kind: "poll"; working: boolean; price: number }
  | { kind: "done"; result: ChaseResult };

export type ChaseDeps = {
  touchFn: () => Promise<Touch>;
  /** Place at price; undefined = market take. Resolves the venue orderId. */
  placeFn: (price: number | undefined) => Promise<string>;
  cancelFn: (orderId: string) => Promise<void>;
  workingFn: (orderId: string) => Promise<boolean>;
  /**
   * Pair-level working-order ids (a `list_open_orders` read for the pair).
   * When present, every cancel-replace is gated on it first (mirror live's
   * `no_working_orders` gate): our order must still be the working one,
   * and no foreign order may be working beside it. Absent = the gate is
   * skipped (the per-order `workingFn` read still applies).
   */
  pairOrdersFn?: () => Promise<string[]>;
  sleepMs?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  onEvent?: (e: ChaseEvent) => void;
};

/**
 * Fill-or-chase loop. Places one maker limit at the touch, polls; when
 * the touch moves, cancel-replaces (up to maxChases). At budget expiry
 * re-checks fill, then takes (cancel + market) or aborts (cancel).
 * A failed cancel NEVER continues into a second live order — the run
 * reports `stuck` with the surviving order id.
 */
export async function runChase(side: ChaseSide, cfg: ChaseConfig, deps: ChaseDeps): Promise<ChaseResult> {
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.nowMs ?? Date.now;
  const emit = deps.onEvent ?? ((): void => {});
  const maxChases = cfg.maxChases ?? Number.MAX_SAFE_INTEGER;
  const pollMs = cfg.pollSecs * 1000;

  const first = await deps.touchFn();
  const firstPx = chaseTouchFor(side, first);
  if (!Number.isFinite(firstPx)) throw new Error("no usable touch — nothing placed");
  let id = await deps.placeFn(firstPx);
  let workingPrice = firstPx;
  let chases = 0;
  emit({ kind: "placed", orderId: id, price: firstPx });
  const deadline = now() + cfg.secs * 1000;

  for (;;) {
    const wait = Math.min(pollMs, Math.max(0, deadline - now()));
    if (wait > 0) await sleep(wait);
    if (!(await deps.workingFn(id))) {
      const r: ChaseResult = { outcome: "filled", orderId: id, chases };
      emit({ kind: "done", result: r });
      return r;
    }
    if (now() >= deadline) break;
    let touch: Touch;
    try {
      touch = await deps.touchFn();
    } catch {
      continue; // tape error: keep resting, re-check fill next poll
    }
    const px = chaseTouchFor(side, touch);
    emit({ kind: "poll", working: true, price: Number.isFinite(px) ? px : workingPrice });
    if (!Number.isFinite(px) || !shouldReprice(workingPrice, px) || chases >= maxChases) continue;
    // PAIR-LEVEL WORKING-ORDER GATE (mirror live's `no_working_orders`).
    // The poll-top `workingFn` read is already stale here: our order may
    // have filled between that read and this replace, and a foreign order
    // (a stale TP/SL from a closed trade) may be working beside ours. A
    // replace that cancels blind stacks a second live order on top of the
    // first: re-read the pair and refuse unless our order is still the
    // only working one. A failed cancel still reports STUCK (never masked
    // by this gate).
    if (deps.pairOrdersFn) {
      let pairIds: string[] | null = null;
      let gateWhy = "";
      try {
        pairIds = await deps.pairOrdersFn();
      } catch (e) {
        gateWhy = `pair working-order read failed (${e instanceof Error ? e.message : String(e)}): refusing to stack a replace blind`;
      }
      const gone = pairIds !== null && !pairIds.includes(id);
      const foreign = pairIds === null ? [] : pairIds.filter((other) => other !== id);
      if (gateWhy === "" && gone) {
        const r: ChaseResult = { outcome: "filled", orderId: id, chases, note: "our order left the pair book before the replace: treating it as filled, nothing cancelled" };
        emit({ kind: "done", result: r });
        return r;
      }
      if (gateWhy === "" && foreign.length > 0) {
        gateWhy = `${foreign.length} foreign order(s) working on this pair (${foreign.join(", ")}): refusing to stack a replace beside them`;
      }
      if (gateWhy !== "") {
        try {
          await deps.cancelFn(id);
        } catch (e) {
          const r: ChaseResult = { outcome: "stuck", orderId: id, chases, cancelError: e instanceof Error ? e.message : String(e), note: gateWhy };
          emit({ kind: "done", result: r });
          return r;
        }
        const r: ChaseResult = { outcome: "aborted", orderId: id, chases, note: gateWhy };
        emit({ kind: "done", result: r });
        return r;
      }
    }
    try {
      await deps.cancelFn(id);
    } catch (e) {
      const r: ChaseResult = { outcome: "stuck", orderId: id, chases, cancelError: e instanceof Error ? e.message : String(e) };
      emit({ kind: "done", result: r });
      return r;
    }
    const prev = id;
    id = await deps.placeFn(px);
    workingPrice = px;
    chases++;
    emit({ kind: "replaced", from: prev, to: id, price: px });
  }

  // Budget spent — one last fill read before touching anything.
  if (!(await deps.workingFn(id))) {
    const r: ChaseResult = { outcome: "filled", orderId: id, chases };
    emit({ kind: "done", result: r });
    return r;
  }
  if (cfg.take) {
    try {
      await deps.cancelFn(id);
    } catch (e) {
      const r: ChaseResult = { outcome: "stuck", orderId: id, chases, cancelError: e instanceof Error ? e.message : String(e) };
      emit({ kind: "done", result: r });
      return r;
    }
    const takeId = await deps.placeFn(undefined);
    emit({ kind: "placed", orderId: takeId, price: null });
    const r: ChaseResult = { outcome: "taken", orderId: takeId, chases };
    emit({ kind: "done", result: r });
    return r;
  }
  try {
    await deps.cancelFn(id);
  } catch (e) {
    const r: ChaseResult = { outcome: "stuck", orderId: id, chases, cancelError: e instanceof Error ? e.message : String(e) };
    emit({ kind: "done", result: r });
    return r;
  }
  const r: ChaseResult = { outcome: "aborted", orderId: id, chases };
  emit({ kind: "done", result: r });
  return r;
}

export type ChaseCmdDeps = {
  call?: TradeCall;
} & Partial<Pick<ChaseDeps, "touchFn" | "sleepMs" | "nowMs" | "onEvent">>;

/**
 * `jw3 execute … --chase <secs>` — same ticket validation, same preview
 * gate, same --yes discipline as plain execute; the fire path runs the
 * chase loop instead of a single place. Dry run (no --yes) prints the
 * chase plan and sends NOTHING.
 */
export async function cmdExecuteChase(
  args: ExecuteArgs,
  cfg: ChaseConfig,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
  deps?: ChaseCmdDeps,
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateExecute(args) ?? validateChase(cfg, args.market);
  if (err) {
    console.error(`Bad ticket: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const call = deps?.call ?? callTool;
  const side = args.side.toLowerCase() as ChaseSide;
  const contract = futuresContract(args.pair);
  if (!contract) {
    console.error(`Bad ticket: no futures contract for pair ${JSON.stringify(args.pair)} — chase needs a touch to join; nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const plan: [string, string][] = [
    ["exchange", args.exchange],
    ["pair", args.pair],
    ["side", side.toUpperCase()],
    ["size", args.amount !== undefined ? `${args.amount}` : `risk $${args.riskUsd}`],
    ["mode", `fill-or-chase ${cfg.secs}s @ touch`],
    ["replace", cfg.maxChases === undefined ? "every touch move" : `up to ${cfg.maxChases}x`],
    ["expiry", cfg.take ? "cancel + market TAKE" : "cancel + abort"],
  ];
  if (!opts.yes) {
    if (opts.json) {
      console.log(
        JSON.stringify({
          mode: "preview", exchange: args.exchange, pair: args.pair, side,
          secs: cfg.secs, pollSecs: cfg.pollSecs,
          maxChases: cfg.maxChases ?? null, take: cfg.take,
        }),
      );
    } else {
      const title = "CHASE PLAN (real money)";
      console.log([title, "—".repeat(Math.min(title.length, 48)), ...plan.map(([k, v]) => `${k}: ${v}`)].join("\n"));
      console.log("Dry run — nothing sent. Re-run with --yes to fire (real money).");
    }
    return;
  }
  // Every place AND every replace is its own ticket: a fresh builder call
  // per fire, never a spread of the first ticket. Spreading would carry the
  // first place's price AND its idempotency key onto the replace, and the
  // server would dedupe the replace against the place, and the chase would
  // silently never move. The chase namespace keeps these keys distinct
  // from a manual execute of the same shape; the per-run sequence keeps
  // same-price revisits distinct within one run. An explicit operator
  // --idempotency-key scopes the family instead of replacing it.
  let placeSeq = 0;
  const placeTicket = (price: number | undefined): Record<string, unknown> =>
    executeToolArgs({
      ...args,
      ...(price === undefined ? {} : { price }),
      idempotencyKey: makeIntentKey(
        "chase",
        [
          args.idempotencyKey ?? "", args.exchange, args.pair, side,
          price === undefined ? "market" : String(price),
          args.amount ?? "", args.riskUsd ?? "", args.leverage ?? "",
          `place-${placeSeq++}`,
        ].join("|"),
      ),
    });
  const touchFn =
    deps?.touchFn ??
    (async (): Promise<Touch> => {
      const t = await futuresTickerFull(contract);
      return { bestBid: t.bestBid, bestAsk: t.bestAsk };
    });
  const placeFn = async (price: number | undefined): Promise<string> => {
    const out = (await call(
      "execute_trade",
      placeTicket(price),
      pat,
      opts.url,
    )) as { orderId?: string; id?: string };
    const idOut = String(out?.orderId ?? out?.id ?? "").trim();
    if (!idOut) throw new Error("execute_trade returned no order id — reconcile before doing anything");
    return idOut;
  };
  const fullDeps: ChaseDeps = {
    touchFn,
    placeFn,
    cancelFn: (orderId: string) =>
      call("cancel_order", cancelToolArgs({ exchange: args.exchange, orderId, pair: args.pair, market: args.market }), pat, opts.url).then(
        () => {},
      ),
    workingFn: async (orderId: string) => {
      const listed = await call("list_open_orders", cancelAllListArgs({ exchange: args.exchange, pair: args.pair }), pat, opts.url);
      return isChaseWorking(listed, orderId);
    },
    // Pair-level gate before every replace (mirror live's no_working_orders
    // gate). A separate read from workingFn: this one returns the whole
    // pair book so the loop can refuse to stack beside a foreign order.
    pairOrdersFn: async () => {
      const listed = await call("list_open_orders", cancelAllListArgs({ exchange: args.exchange, pair: args.pair }), pat, opts.url);
      const ids: string[] = [];
      for (const row of extractOpenOrders(listed)) {
        const id = cancelOrderIdOf(row);
        if (id) ids.push(id);
      }
      return ids;
    },
    ...(deps?.sleepMs ? { sleepMs: deps.sleepMs } : {}),
    ...(deps?.nowMs ? { nowMs: deps.nowMs } : {}),
    onEvent: (e) => {
      deps?.onEvent?.(e);
      if (opts.json) {
        console.log(JSON.stringify(e));
        return;
      }
      if (e.kind === "placed") console.log(e.price === null ? `PLACED take (market) → ${e.orderId}` : `PLACED limit @ ${e.price} → ${e.orderId}`);
      else if (e.kind === "replaced") console.log(`CHASED ${e.from} → ${e.to} @ ${e.price}`);
      else if (e.kind === "done")
        console.log(
          `CHASE ${e.result.outcome.toUpperCase()} ${e.result.orderId} (replaces: ${e.result.chases}${e.result.cancelError ? ` — CANCEL FAILED: ${e.result.cancelError}, reconcile by hand` : ""})`,
        );
    },
  };
  try {
    const result = await runChase(side, cfg, fullDeps);
    if (opts.json) console.log(JSON.stringify({ mode: "chase", exchange: args.exchange, pair: args.pair, side, ...result }));
    if (result.outcome === "stuck") {
      console.error(`STUCK: cancel failed (${result.cancelError}) — ${result.orderId} may still be live. Reconcile before doing anything.`);
      process.exitCode = 1;
    }
  } catch (e) {
    fail(e);
  }
}
