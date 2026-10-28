/**
 * Scalp executor: `scalp start|watch|kill`.
 *
 * A scalp is the plan `scalp plan` derives (TP% + 1/1/2 step ladder +
 * kill line), actually fired: `start` places each step as a futures
 * limit order via execute_trade, arms TP via set_exits, and drops a
 * state file (like `grid start`). `watch` polls the public tape against
 * the kill line / TP in a bounded loop (EVENT lines). `kill` cancels
 * the working steps, closes the position, and removes the state file.
 *
 * Real money. `start` and `kill` send NOTHING without --yes and need a
 * PAT with the trade:execute scope (server re-checks YOLO eligibility,
 * kill switch, caps — a CLI yes never overrides a server no).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { callTool } from "../mcp.js";

import {
  futuresCenter,
  futuresContractSpec,
  futuresFade,
  planScalp,
  type ScalpPlan,
} from "../kucoin.js";
import { startupGate } from "../reconcile.js";
import { fail, needPat } from "./market.js";

export type ScalpDirection = "long" | "short";

export type ScalpStartArgs = {
  exchange: string;
  pair: string;
  direction: ScalpDirection;
  sizeUsd: number;
  steps: number;
  leverage: number;
};

/** Placed step order, as recorded in the state file. */
export type ScalpPlaced = {
  step: number;
  side: string;
  price: number;
  contracts: number;
  sizeUsd: number;
  orderId: string;
};

/** On-disk state — written by `start`, read by `watch`/`kill`. */
export type ScalpState = {
  kind: "scalp";
  exchange: string;
  pair: string;
  base: string;
  direction: ScalpDirection;
  leverage: number;
  last: number;
  avgEntry: number;
  tpPrice: number;
  tpProfitUsd: number;
  killPrice: number;
  killLossUsd: number;
  maxCapitalUsd: number;
  placed: ScalpPlaced[];
  failed: number;
  tpArmed: boolean;
  createdAt: string;
};

/** State file path (grid start convention: tmpdir, per-base file). */
export function scalpStatePath(base: string, dir?: string): string {
  return join(dir ?? tmpdir(), `scalp_${base.toLowerCase()}.json`);
}

/** Pure validation for `start` args. Null = usable. */
export function validateScalpStart(a: ScalpStartArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  if (a.direction !== "long" && a.direction !== "short") return "direction must be long|short";
  if (!(a.sizeUsd > 0)) return "size must be > 0 (USD per unit step)";
  if (!Number.isInteger(a.steps) || a.steps < 1 || a.steps > 3) return "steps must be 1..3";
  if (!(a.leverage > 0)) return "leverage must be > 0";
  return null;
}

/** Step USD size → futures contracts at a fill price. At least 1. */
export function scalpContracts(sizeUsd: number, price: number, multiplier: number): number {
  return Math.max(1, Math.round(sizeUsd / (multiplier * price)));
}

/**
 * Futures contracts → the `amount` field `execute_trade` expects.
 *
 * `execute_trade` speaks BASE units (the server divides by the contract
 * multiplier to get integer lots — `lotMultiplierFor` in cex-proxy). Sending
 * a contract COUNT as `amount` therefore multiplies the position by the
 * multiplier: on IRYS (multiplier 100) 12 contracts became 1200 base units
 * = 12 lots — a 100x oversize. One contract IS `multiplier` base units.
 */
export function contractsToAmountBaseUnits(contracts: number, multiplier: number): number {
  const mult = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return contracts * mult;
}

export function roundToTick(px: number, tick: number): number {
  if (tick > 0) return Math.round(px / tick) * tick;
  if (px >= 100) return Math.round(px * 100) / 100;
  if (px >= 1) return Math.round(px * 1000) / 1000;
  return Number(px.toPrecision(5));
}

/**
 * Pure mark classifier for `watch`: where is the tape vs the plan's
 * two lines? TP wins ties (a touch of both is a fill, not a stop).
 */
export function classifyScalpMark(
  price: number,
  plan: Pick<ScalpPlan, "direction" | "tpPrice" | "killPrice">,
): "tp" | "kill" | "open" {
  if (!(price > 0)) return "open";
  if (plan.direction === "long") {
    if (price >= plan.tpPrice) return "tp";
    if (price <= plan.killPrice) return "kill";
    return "open";
  }
  if (price <= plan.tpPrice) return "tp";
  if (price >= plan.killPrice) return "kill";
  return "open";
}

/** Read + parse a state file. Throws with a human message on any problem. */
export function readScalpState(path: string): ScalpState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no scalp state at ${path} — nothing running (start one with \`scalp start --yes\`)`);
  }
  let st: unknown;
  try {
    st = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`scalp state at ${path} is not valid JSON — refusing to act on it`);
  }
  const s = st as Partial<ScalpState>;
  if (s?.kind !== "scalp" || !s.base || !s.pair || (s.direction !== "long" && s.direction !== "short")) {
    throw new Error(`scalp state at ${path} is malformed — refusing to act on it`);
  }
  return s as ScalpState;
}

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

export async function cmdScalpStart(
  a: ScalpStartArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
): Promise<void> {
  const err = validateScalpStart(a);
  if (err) {
    console.error(`Bad ticket: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const base = (a.pair.split("/")[0] ?? "").toUpperCase();
  const side = a.direction === "long" ? "buy" : "sell";
  // No-strays gate: a leftover state means a previous run may still own
  // this pair (working orders / an armed TP). Kill/reconcile it first.
  const gate0 = startupGate("scalp", base);
  if (!gate0.ok) {
    console.error(gate0.reason);
    process.exitCode = 1;
    return;
  }
  let plan: ScalpPlan;
  let tick = 0;
  let multiplier = 1;
  try {
    const [row, spec] = await Promise.all([futuresFade(base), futuresContractSpec(base)]);
    plan = planScalp(row.last, row.atrPct, a.direction, a.sizeUsd, a.steps) ?? (() => { throw new Error("no plan from this tape"); })();
    tick = spec.tick;
    multiplier = spec.multiplier;
  } catch (e) {
    fail(e);
    return;
  }
  const legs = plan.steps.map((s) => {
    const contracts = scalpContracts(s.sizeUsd, s.price, multiplier);
    return {
      step: s.step,
      price: roundToTick(s.price, tick),
      contracts,
      // `execute_trade` speaks BASE units — one contract IS `multiplier`
      // base units. Sending the contract count oversizes by the multiplier.
      amountBaseUnits: contractsToAmountBaseUnits(contracts, multiplier),
      sizeUsd: s.sizeUsd,
    };
  });
  if (opts.json) {
    console.log(JSON.stringify({
      mode: opts.yes ? "start" : "preview",
      pair: a.pair, exchange: a.exchange, direction: a.direction,
      leverage: a.leverage, plan, legs,
      tpPrice: plan.tpPrice, killPrice: plan.killPrice,
    }));
    if (!opts.yes) return;
  } else {
    console.log(`SCALP START ${a.direction.toUpperCase()} — ${a.pair} @ ${px(plan.last)} (x${a.leverage} isolated, ${a.exchange})`);
    for (const l of legs) {
      console.log(`  step ${l.step}: ${side.toUpperCase()} ${l.contracts} contracts ≈ $${l.sizeUsd.toFixed(0)} @ ${px(l.price)} (limit)`);
    }
    console.log(`  avg entry ${px(plan.avgEntry)} → TP +${plan.tpPct.toFixed(2)}% @ ${px(plan.tpPrice)} = +$${plan.tpProfitUsd.toFixed(2)}`);
    console.log(`  kill line ${px(plan.killPrice)} = -$${plan.killLossUsd.toFixed(2)}  ·  max capital $${plan.maxCapitalUsd.toFixed(0)}`);
  }
  if (!opts.yes) {
    console.log("Dry run — nothing sent. Re-run with --yes to fire steps + arm TP (real money).");
    return;
  }

// ── A LADDER OF RESTING LIMITS CANNOT BE PROTECTED ──
  //
  // The exit legs are venue-native CONDITIONALS that attach to a
  // POSITION. A resting limit has no position until it fills, so
  // between placement and fill there is nothing for a stop to attach
  // to: the order rests on the book UNPROTECTED and becomes a
  // leveraged naked position the moment price reaches it.
  //
  // This was observed live on 2026-10-21: `scalp start --yes` placed
  // a PEPE/USDT buy limit at 0.00000456, it RESTED (filled: 0), so no
  // position existed, and the TP and stop could not attach. The order
  // was a $14.23 leveraged order with NO STOP, waiting to become a
  // naked leveraged position. It had to be cancelled by hand.
  //
  // A ladder makes this worse, not better: several resting orders, all
  // unprotected, any one of which can fill into a naked position.
  //
  // The live path solved this by using a MARKET entry: the position
  // exists immediately, so the legs attach at once. A ladder cannot
  // become a market entry without ceasing to be a ladder.
  //
  // So this path REFUSES to place, and points at the path that can.
  // The preview above still works — the plan is useful for sizing.
  console.error(
    "no trade: `scalp start` places RESTING LIMIT orders, and a resting limit has no position " +
    "for a stop to attach to — it would rest on the book UNPROTECTED and become a leveraged naked " +
    "position when price reached it. (Observed live: a $14.23 order with no stop.) A ladder cannot " +
    "be protected, so this path will not place one. Use `jw3 live --pair " + a.pair + " --exchange " +
    a.exchange + " --" + a.direction + " --yes`, which enters at the market so the position exists " +
    "immediately and the stop attaches at once.",
  );
  process.exitCode = 1;
  return;

}

/**
 * `scalp watch` — bounded poll of the public tape against the state's
 * TP / kill lines. Read-only (no PAT). EVENT lines for machines.
 */
export async function cmdScalpWatch(opts: {
  pair: string;
  polls: number;
  intervalSec: number;
  json: boolean;
}): Promise<void> {
  const base = (opts.pair.split("/")[0] ?? "").toUpperCase();
  if (!base) {
    console.error("Usage: jw3 scalp watch --pair SOL/USDT [--polls 30] [--interval 10] [--json]");
    process.exitCode = 2;
    return;
  }
  const polls = Math.min(Math.max(Math.round(opts.polls), 1), 360);
  const intervalMs = Math.min(Math.max(opts.intervalSec, 1), 300) * 1000;
  let state: ScalpState;
  try {
    state = readScalpState(scalpStatePath(base));
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const dir = state.direction.toUpperCase();
  if (opts.json) {
    console.log(JSON.stringify({ event: "start", pair: state.pair, direction: state.direction, tpPrice: state.tpPrice, killPrice: state.killPrice, polls, intervalSec: intervalMs / 1000 }));
  } else {
    console.log(`WATCH ${dir} ${state.pair} — TP ${px(state.tpPrice)} / kill ${px(state.killPrice)} (${polls} polls × ${intervalMs / 1000}s)`);
  }
  for (let i = 1; i <= polls; i++) {
    let mark: number;
    try {
      mark = await futuresCenter(state.base);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) console.log(JSON.stringify({ poll: i, status: "tape-error", error: msg }));
      else console.log(`EVENT poll=${i} status=tape-error error=${JSON.stringify(msg)}`);
      if (i < polls) await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const cls = classifyScalpMark(mark, state);
    if (opts.json) {
      console.log(JSON.stringify({ poll: i, price: mark, status: cls, tpPrice: state.tpPrice, killPrice: state.killPrice }));
    } else {
      console.log(`EVENT poll=${i} price=${px(mark)} status=${cls}`);
    }
    if (cls === "tp") {
      if (opts.json) console.log(JSON.stringify({ poll: i, price: mark, status: cls, tpPrice: state.tpPrice, killPrice: state.killPrice, event: "tp-hit" }));
      else console.log(`TP HIT @ ${px(mark)} — take-profit should have filled; clear state with \`scalp kill --pair ${state.pair}\` (no orders expected).`);
      return;
    }
    if (cls === "kill") {
      if (opts.json) console.log(JSON.stringify({ poll: i, price: mark, status: cls, tpPrice: state.tpPrice, killPrice: state.killPrice, event: "kill-breach" }));
      else console.log(`KILL LINE BREACHED @ ${px(mark)} (≈ -$${state.killLossUsd.toFixed(2)}) — run \`scalp kill --pair ${state.pair} --yes\` now.`);
      process.exitCode = 1;
      return;
    }
    if (i < polls) await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (opts.json) console.log(JSON.stringify({ event: "done", pair: state.pair, polls, status: "no-touch" }));
  else console.log("WATCH DONE — neither line touched inside the poll budget. Re-run to keep watching.");
}

/**
 * `scalp kill` — cancel the working step orders, close the position,
 * remove the state file. Preview without --yes, act with it.
 */
export async function cmdScalpKill(opts: {
  pair: string;
  exchange?: string;
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
}): Promise<void> {
  const base = (opts.pair.split("/")[0] ?? "").toUpperCase();
  if (!base) {
    console.error("Usage: jw3 scalp kill --pair SOL/USDT [--exchange kucoin] --yes [--json]");
    process.exitCode = 2;
    return;
  }
  const statePath = scalpStatePath(base);
  let state: ScalpState;
  try {
    state = readScalpState(statePath);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const exchange = opts.exchange ?? state.exchange;
  const orderIds = state.placed.map((p) => p.orderId);
  if (opts.json) {
    console.log(JSON.stringify({
      mode: opts.yes ? "kill" : "preview",
      pair: state.pair, exchange, direction: state.direction,
      orders: orderIds, killPrice: state.killPrice,
    }));
    if (!opts.yes) return;
  } else {
    console.log(`KILL ${state.direction.toUpperCase()} ${state.pair} — ${orderIds.length} working step(s), kill ${px(state.killPrice)} (≈ -$${state.killLossUsd.toFixed(2)})`);
    for (const p of state.placed) {
      console.log(`  cancel step ${p.step}: ${p.orderId} (${p.side.toUpperCase()} ${p.contracts} @ ${px(p.price)})`);
    }
    console.log(`  close ${state.direction} position on ${exchange} (futures)`);
  }
  if (!opts.yes) {
    console.log("Dry run — nothing sent. Re-run with --yes to cancel + close (real money).");
    return;
  }
  const pat = needPat(opts.pat);
  if (!pat) return;
  let errors = 0;
  for (const p of state.placed) {
    try {
      await callTool(
        "cancel_order",
        { exchange, orderId: p.orderId, pair: state.pair, market: "futures" },
        pat, opts.url,
      );
      console.log(`CANCELLED ${p.orderId}`);
    } catch (e) {
      errors++;
      console.error(`CANCEL ${p.orderId} FAILED (may already be filled): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const out = await callTool(
      "close_position",
      { exchange, pair: state.pair, side: state.direction },
      pat, opts.url,
    );
    console.log(`CLOSED ${state.direction} ${state.pair}: ${JSON.stringify(out)}`);
  } catch (e) {
    errors++;
    console.error(`CLOSE FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors === 0) {
    try {
      unlinkSync(statePath);
    } catch {
      // State already gone — the kill itself succeeded.
    }
    console.log(`Scalp cleared — state removed (${statePath}).`);
  } else {
    console.error(`Kill finished with ${errors} error(s) — state KEPT at ${statePath} so nothing is lost. Re-run to retry.`);
    process.exitCode = 1;
  }
}
