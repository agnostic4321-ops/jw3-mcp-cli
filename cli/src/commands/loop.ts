/**
 * `jw3 loop` — full sense cycle in one parallel fan-out (READ-ONLY).
 *
 * One command runs the five reads an operator otherwise runs by hand:
 * market (spot/futures last), positions (open + exits), screener
 * (top-by-volume), analyze (JEV cex trend, server-built snapshot) and
 * plan (public futures tape → ATR-derived scalp mechanic). All five fire
 * concurrently via Promise.all; the loop prints per-leg timings against
 * a sub-5s budget. Never proposes, never executes — sense only.
 */
import { callTool } from "../mcp.js";
import { futuresFade, planScalp } from "../kucoin.js";
import { fail, listConnections, needPat, pickConnection } from "./market.js";

/** Total sense-cycle budget (ms) — the loop must stay under this. */
export const LOOP_BUDGET_MS = 5000;

export const LOOP_LEGS = ["market", "positions", "screener", "analyze", "plan"] as const;
export type LoopLegName = (typeof LOOP_LEGS)[number];

export type LoopLegResult = {
  name: LoopLegName;
  ok: boolean;
  ms: number;
  data?: unknown;
  error?: string;
};

export type LoopSense = {
  legs: LoopLegResult[];
  totalMs: number;
  withinBudget: boolean;
};

/** Thunks for the five reads — injected in tests, network-backed by default. */
export type LoopThunks = Record<LoopLegName, () => Promise<unknown>>;

/** Pure: arg check. Null = usable. */
export function validateLoopArgs(a: { exchange: string; pair: string }): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  return null;
}

/** Pure: true when the cycle finished inside the budget. */
export function withinBudget(totalMs: number, budgetMs: number = LOOP_BUDGET_MS): boolean {
  return Number.isFinite(totalMs) && totalMs <= budgetMs;
}

/** Pure: one budget line, e.g. `2.31s / 5.00s budget — WITHIN`. */
export function budgetLine(totalMs: number, budgetMs: number = LOOP_BUDGET_MS): string {
  const s = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;
  return `${s(totalMs)} / ${s(budgetMs)} budget — ${withinBudget(totalMs, budgetMs) ? "WITHIN" : "OVER"}`;
}

/**
 * Core fan-out: all five thunks run concurrently (Promise.all), each leg
 * timed on its own; a rejected leg records error and never fails siblings.
 */
export async function runLoopSense(thunks: LoopThunks): Promise<LoopSense> {
  const t0 = Date.now();
  const legs = await Promise.all(
    LOOP_LEGS.map(async (name): Promise<LoopLegResult> => {
      const s = Date.now();
      try {
        const data = await thunks[name]();
        return { name, ok: true, ms: Date.now() - s, data };
      } catch (e) {
        return { name, ok: false, ms: Date.now() - s, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const totalMs = Date.now() - t0;
  return { legs, totalMs, withinBudget: withinBudget(totalMs) };
}

export type LoopOpts = {
  exchange: string;
  pair: string;
  direction?: "long" | "short";
  sizeUsd?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

function short(v: unknown, n = 120): string {
  try {
    const s = JSON.stringify(v);
    if (s == null) return "—";
    return s.length > n ? `${s.slice(0, n)}…` : s;
  } catch {
    return "—";
  }
}

/** Best-effort one-line summaries per leg — defensive over unknown shapes. */
export function summarizeLeg(leg: LoopLegResult): string {
  if (!leg.ok) return `${leg.name}: FAIL ${leg.error ?? "unknown error"}`;
  const d = leg.data as Record<string, unknown> | null;
  if (leg.name === "market" && d && typeof d === "object") {
    const px = (d.price ?? d.last ?? (d.data as Record<string, unknown> | undefined)?.price) as unknown;
    return `market: ${Number.isFinite(Number(px)) ? px : short(d)}`;
  }
  if (leg.name === "positions" && d && typeof d === "object") {
    const arr = Array.isArray(d) ? d : (d.positions as unknown[] | undefined);
    return `positions: ${Array.isArray(arr) ? `${arr.length} open` : short(d)}`;
  }
  if (leg.name === "screener" && d && typeof d === "object") {
    const top = (d.topByVolume as { s?: string }[] | undefined)?.[0]?.s;
    return `screener: ${top ? `top ${top}` : short(d)}`;
  }
  if (leg.name === "analyze" && d && typeof d === "object") {
    const t = ((d.verdict as Record<string, unknown> | undefined)?.trend as { verdict?: string } | undefined)?.verdict;
    return `analyze: ${typeof t === "string" ? t.replace(/_/g, " ") : short(d)}`;
  }
  if (leg.name === "plan" && d && typeof d === "object") {
    const p = (d.plan as { direction?: string; tpPct?: number } | undefined) ?? (d as { direction?: string; tpPct?: number });
    return typeof p?.direction === "string"
      ? `plan: ${p.direction}${typeof p.tpPct === "number" ? ` TP +${p.tpPct.toFixed(2)}%` : ""}`
      : `plan: ${short(d)}`;
  }
  return `${leg.name}: ${short(leg.data)}`;
}

export async function cmdLoop(opts: LoopOpts, deps?: { thunks?: LoopThunks }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateLoopArgs(opts);
  if (err) {
    console.error(`Usage: jw3 loop --exchange kucoin --pair SOL/USDT [--json] — ${err}. Nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const exchange = opts.exchange.toLowerCase();
  const pair = opts.pair.toUpperCase();
  const direction = opts.direction === "short" ? "short" : "long";
  const sizeUsd = opts.sizeUsd ?? 15;

  // Positions need a connectionId — resolve once, then fan all five out.
  let connectionId: string | null = null;
  try {
    const rows = await listConnections(pat, opts.url);
    const conn = pickConnection(rows, opts.exchange, true);
    if (!conn) {
      console.error(
        opts.exchange ? `No connection for ${opts.exchange} — connect it in-app first.` : "No CEX connections — connect one in-app first.",
      );
      process.exitCode = 1;
      return;
    }
    connectionId = conn.id;
  } catch (e) {
    fail(e);
    return;
  }

  const live: LoopThunks = deps?.thunks ?? {
    market: () => callTool("read_live_datum", { kind: "market", exchange, symbol: pair }, pat, opts.url),
    positions: () =>
      callTool("read_live_datum", { kind: "positions", connectionId, withExits: true }, pat, opts.url),
    screener: () => callTool("read_live_datum", { kind: "screener", exchange }, pat, opts.url),
    analyze: () => callTool("analyze_market", { family: "cex", venue: exchange, symbol: pair }, pat, opts.url),
    plan: async () => {
      const base = (pair.split("/")[0] ?? "").toUpperCase();
      const row = await futuresFade(base);
      const plan = planScalp(row.last, row.atrPct, direction, sizeUsd, 3);
      if (!plan) throw new Error("could not derive a plan from this tape — no numbers invented");
      return { symbol: row.symbol, tape: row, plan };
    },
  };

  const sense = await runLoopSense(live);

  if (opts.json) {
    const data: Record<string, unknown> = {};
    for (const l of sense.legs) data[l.name] = l.ok ? l.data : { error: l.error };
    console.log(
      JSON.stringify({
        event: "loop",
        exchange,
        pair,
        totalMs: sense.totalMs,
        budgetMs: LOOP_BUDGET_MS,
        withinBudget: sense.withinBudget,
        legs: sense.legs.map((l) => ({ name: l.name, ok: l.ok, ms: l.ms, ...(l.ok ? {} : { error: l.error }) })),
        data,
      }),
    );
    if (sense.legs.every((l) => !l.ok)) process.exitCode = 1;
    return;
  }

  console.log(`LOOP ${pair} (${exchange}) — 5 reads, one fan-out (read-only, nothing sent)`);
  for (const l of sense.legs) {
    const status = l.ok ? "ok" : "FAIL";
    console.log(`  ${l.name.padEnd(9)} ${status.padEnd(4)} ${String(l.ms).padStart(5)}ms  ${summarizeLeg(l)}`);
  }
  console.log(`BUDGET ${budgetLine(sense.totalMs)}`);
  if (sense.legs.every((l) => !l.ok)) process.exitCode = 1;
}
