/**
 * `heat` — margin-heat guard (READ-ONLY, never trades).
 *
 * Reports margin locked vs free, per-position notional/account ratios, and
 * flags unknown-origin positions (venue rows with no local scalp/grid/trail
 * state ref) plus free-margin below `--min-free`. Exit 1 on error-level
 * flags so supervisor hooks can gate on it; 0 when clean (warns print but
 * pass). Exit 2 on usage errors.
 *
 * Pure evaluators live here beside the venue wiring (same file, like
 * market.ts) so the rules are unit-tested with zero network.
 */
import { callTool } from "../mcp.js";
import { isOpenPosition, readLocalStates, rowMatchesPair, rowPairOf, type LocalState } from "../reconcile.js";
import { configDir } from "../config.js";
import { collectRows, listConnections, needPat, pickConnection } from "./market.js";
import { loadJsonStore, resolveStorePath, saveJsonStore } from "./json-store.js";

export type HeatFlag = { level: "error" | "warn"; code: string; detail: string };

export type HeatPosition = {
  symbol: string;
  side: string;
  notionalUsd: number | null;
  marginLockedUsd: number | null;
  marginEstimated: boolean;
  notionalAcctPct: number | null;
  marginAcctPct: number | null;
  known: boolean;
};

export type HeatAccount = {
  totalUsd: number | null;
  freeUsd: number | null;
  lockedUsd: number | null;
  quote: string;
  unknown: boolean;
};

export type HeatReport = {
  mode: "heat";
  exchange: string;
  account: HeatAccount;
  positions: HeatPosition[];
  flags: HeatFlag[];
  /** False when any error-level flag fired (or the venue could not be read). */
  clean: boolean;
};

/** Quote assets that count as futures-margin funds. Everything else (BTC, ETH…) needs a price to value — never guessed. */
const QUOTE_ASSETS = new Set(["USDT", "USDC", "USD"]);

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstNum(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const n = numOrNull(row[k]);
    if (n !== null) return n;
  }
  return null;
}

const SIZE_KEYS = ["size", "qty", "quantity", "contracts", "currentQty", "positionAmt", "holdVol"] as const;
const PRICE_KEYS = ["markPrice", "mark", "lastPrice", "price", "entryPrice", "entry", "avgPrice", "openPrice"] as const;
const NOTIONAL_KEYS = ["notional", "notionalUsd", "markValue", "positionValue", "value", "valueUsd"] as const;
const MARGIN_KEYS = [
  "margin",
  "posMargin",
  "initialMargin",
  "marginLocked",
  "isolatedMargin",
  "positionIM",
  "im",
  "frozenMargin",
] as const;

/** USD notional of one venue position row. Explicit venue notionals win; otherwise |size| × mark (entry fallback). Null when unmeasurable — never 0-filled. */
export function positionNotional(row: Record<string, unknown>): number | null {
  const direct = firstNum(row, NOTIONAL_KEYS);
  if (direct !== null) return Math.abs(direct);
  const size = firstNum(row, SIZE_KEYS);
  const price = firstNum(row, PRICE_KEYS);
  if (size === null || price === null) return null;
  return Math.abs(size) * price;
}

/**
 * Margin locked by one venue position row.
 * Explicit venue margin wins; otherwise notional / leverage (isolated-style
 * estimate, flagged via `estimated`). Null when neither exists — cross-margin
 * rows with no leverage report unknown rather than a fabricated number.
 */
export function positionMargin(
  row: Record<string, unknown>,
  notionalUsd: number | null,
): { locked: number | null; estimated: boolean } {
  const direct = firstNum(row, MARGIN_KEYS);
  if (direct !== null) return { locked: direct, estimated: false };
  const lev = firstNum(row, ["leverage", "lever", "realLeverage"]);
  if (notionalUsd !== null && lev !== null && lev > 0) {
    return { locked: notionalUsd / lev, estimated: true };
  }
  return { locked: null, estimated: false };
}

/** Pull flat balance rows out of a balances envelope (merged / balances / data / accounts-map / venues fan-out). */
function collectBalanceRows(out: unknown): Record<string, unknown>[] {
  if (Array.isArray(out)) return out.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    for (const k of ["merged", "balances", "data", "list"] as const) {
      if (Array.isArray(o[k])) {
        return (o[k] as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
      }
    }
    if (o.accounts && typeof o.accounts === "object") {
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(o.accounts as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const r of v) if (r && typeof r === "object") rows.push(r as Record<string, unknown>);
        }
      }
      if (rows.length > 0) return rows;
    }
    if (Array.isArray(o.venues)) {
      const rows: Record<string, unknown>[] = [];
      for (const v of o.venues as unknown[]) {
        if (!v || typeof v !== "object") continue;
        const data = (v as Record<string, unknown>).data;
        rows.push(...collectBalanceRows(data));
      }
      return rows;
    }
  }
  return [];
}

function assetOf(row: Record<string, unknown>): string {
  for (const k of ["asset", "coin", "currency", "code"] as const) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim().toUpperCase();
  }
  return "";
}

/**
 * Quote-fund account summary from a balances envelope. Sums USDT/USDC/USD
 * rows only (free + total → locked = total − free); anything else needs a
 * live price and is never invented. `unknown` when no quote row exists.
 */
export function accountFromBalances(out: unknown): HeatAccount {
  const rows = collectBalanceRows(out);
  let total = 0;
  let free = 0;
  let seen = false;
  for (const r of rows) {
    if (!QUOTE_ASSETS.has(assetOf(r))) continue;
    const t = firstNum(r, ["total", "totalBalance", "balance", "walletBalance", "equity"]);
    const f = firstNum(r, ["free", "available", "availableBalance", "freeBalance", "withdrawable", "transferBalance"]);
    if (t === null && f === null) continue;
    seen = true;
    total += t ?? 0;
    free += f ?? 0;
  }
  if (!seen) {
    return { totalUsd: null, freeUsd: null, lockedUsd: null, quote: "USDT", unknown: true };
  }
  return { totalUsd: total, freeUsd: free, lockedUsd: total - free, quote: "USDT", unknown: false };
}

/** True when a venue position row has a local owner: a state for its pair (server-scoped rows with no pair fall back to any-state-exists). */
export function isKnownPosition(row: Record<string, unknown>, states: LocalState[]): boolean {
  const pair = rowPairOf(row as Record<string, unknown>);
  if (!pair) return states.length > 0;
  return states.some((s) => s.pair && rowMatchesPair(row as Record<string, unknown>, s.pair));
}

/**
 * Pure: positions × local states × account → heat report.
 * Error flags (exit 1): unknown-origin positions, unreadable states,
 * unchecked balances, free < minFree. Warn-only: estimated margins.
 */
export function evaluateHeat(args: {
  exchange: string;
  positions: Record<string, unknown>[];
  local: LocalState[];
  unreadable: string[];
  account: HeatAccount;
  minFree: number;
}): HeatReport {
  const flags: HeatFlag[] = [];
  for (const u of args.unreadable) {
    flags.push({
      level: "error",
      code: "unreadable-state",
      detail: `${u} exists but cannot be parsed — refusing to treat it as "nothing running"; inspect or remove it by hand`,
    });
  }
  if (args.account.unknown) {
    flags.push({
      level: "error",
      code: "balances-unchecked",
      detail: "no quote-fund (USDT/USDC/USD) balance rows — locked-vs-free is unverified; re-run authenticated",
    });
  }
  const positions: HeatPosition[] = args.positions.map((row) => {
    const notionalUsd = positionNotional(row);
    const { locked: marginLockedUsd, estimated: marginEstimated } = positionMargin(row, notionalUsd);
    const known = isKnownPosition(row, args.local);
    const symbol = String(row.symbol ?? row.pair ?? "—");
    const side = String(row.side ?? "—");
    if (!known) {
      flags.push({
        level: "error",
        code: "unknown-origin",
        detail: `${symbol} ${side} notional ${notionalUsd === null ? "unknown" : `$${notionalUsd.toFixed(2)}`} has no local state (scalp/grid/trail) — nothing owns it; close or adopt before starting anything new`,
      });
    }
    const denom = args.account.totalUsd;
    return {
      symbol,
      side,
      notionalUsd,
      marginLockedUsd,
      marginEstimated,
      notionalAcctPct: notionalUsd !== null && denom !== null && denom > 0 ? (notionalUsd / denom) * 100 : null,
      marginAcctPct:
        marginLockedUsd !== null && denom !== null && denom > 0 ? (marginLockedUsd / denom) * 100 : null,
      known,
    };
  });
  if (positions.some((p) => p.marginEstimated)) {
    flags.push({
      level: "warn",
      code: "estimated-margin",
      detail: "some rows report no venue margin — locked estimated as notional / leverage; treat locked totals as approximate",
    });
  }
  if (!args.account.unknown && args.account.freeUsd !== null && args.account.freeUsd < args.minFree) {
    flags.push({
      level: "error",
      code: "low-free-margin",
      detail: `free $${args.account.freeUsd.toFixed(2)} < min-free $${args.minFree.toFixed(2)} — margin nearly exhausted; reduce or close before starting anything new`,
    });
  }
  const errors = flags.filter((f) => f.level === "error");
  return {
    mode: "heat",
    exchange: args.exchange,
    account: args.account,
    positions,
    flags,
    clean: errors.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Heat-cap governor — the ONE heat-cap store (OQ-14).                 */
/*                                                                     */
/* Moved verbatim from commands/degen.ts: same type, same file         */
/* (degen-heat.json), same sanitizer including the day roll; only the  */
/* mechanics (path/load/save) ride the shared json-store helper. The   */
/* degen command imports this module — there is one implementation.    */
/* ------------------------------------------------------------------ */

export type DegenHeatOpen = { pair: string; riskUsd: number };

export type DegenHeat = {
  day: string;
  stopsToday: number;
  heatUsd: number;
  open: DegenHeatOpen[];
  lastStopAt: string | null;
};

/** Owner-ordered risk doctrine (see skill lessons: 30%-risk math). */
export const DEGEN_HEAT_CAP_USD = 6;
export const DEGEN_MAX_CONCURRENT = 2;
export const DEGEN_MAX_STOPS_PER_DAY = 2;
export const DEGEN_COOLDOWN_MS = 3600 * 1000;

export type HeatCaps = {
  maxHeatUsd: number;
  maxConcurrent: number;
  cooldownMs: number;
  maxStops: number;
};

export const DEFAULT_HEAT_CAPS: HeatCaps = {
  maxHeatUsd: DEGEN_HEAT_CAP_USD,
  maxConcurrent: DEGEN_MAX_CONCURRENT,
  cooldownMs: DEGEN_COOLDOWN_MS,
  maxStops: DEGEN_MAX_STOPS_PER_DAY,
};

export function degenHeatPath(dir?: string): string {
  return resolveStorePath(dir, "degen-heat.json", configDir());
}

export function degenToday(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function defaultHeat(day: string): DegenHeat {
  return { day, stopsToday: 0, heatUsd: 0, open: [], lastStopAt: null };
}

/** Load heat; missing/corrupt → defaults. Day roll resets the counters. */
export function loadHeat(path: string, nowMs: number = Date.now()): DegenHeat {
  const day = degenToday(nowMs);
  return loadJsonStore(path, () => defaultHeat(day), (raw, into) => {
    const r = raw as Partial<DegenHeat>;
    const open = Array.isArray(r.open)
      ? r.open.filter(
          (o): o is DegenHeatOpen =>
            !!o && typeof o === "object" && typeof o.pair === "string" && Number.isFinite(o.riskUsd),
        )
      : [];
    if (typeof r.day === "string") into.day = r.day;
    if (Number.isInteger(r.stopsToday) && (r.stopsToday as number) >= 0) {
      into.stopsToday = r.stopsToday as number;
    }
    if (Number.isFinite(r.heatUsd) && (r.heatUsd as number) >= 0) {
      into.heatUsd = r.heatUsd as number;
    }
    into.open = open;
    if (typeof r.lastStopAt === "string") into.lastStopAt = r.lastStopAt;
    if (into.day !== day) {
      into.day = day;
      into.stopsToday = 0;
      into.heatUsd = 0;
    }
  });
}

export function saveHeat(path: string, heat: DegenHeat): void {
  saveJsonStore(path, heat);
}

/**
 * Pure heat-cap governor. Null = clear to open this risk.
 * Priority: day-flat → duplicate pair → concurrent cap → cooldown → heat cap.
 */
export function checkHeat(
  heat: DegenHeat,
  killLossUsd: number,
  pair: string,
  nowMs: number,
  caps: HeatCaps = DEFAULT_HEAT_CAPS,
): string | null {
  if (heat.stopsToday >= caps.maxStops) {
    return `flat for the day after ${heat.stopsToday} full stops — no new risk`;
  }
  if (heat.open.some((o) => o.pair.toUpperCase() === pair.toUpperCase())) {
    return `${pair} already open in the degen book — no double-fire`;
  }
  if (heat.open.length >= caps.maxConcurrent) {
    return `max ${caps.maxConcurrent} concurrent positions (${heat.open.map((o) => o.pair).join(", ")})`;
  }
  if (heat.lastStopAt) {
    const since = nowMs - Date.parse(heat.lastStopAt);
    if (Number.isFinite(since) && since >= 0 && since < caps.cooldownMs) {
      const mins = Math.ceil((caps.cooldownMs - since) / 60000);
      return `cooldown after full stop — ${mins}m left`;
    }
  }
  if (!(killLossUsd > 0) || !Number.isFinite(killLossUsd)) {
    return "unmeasurable kill-line cost — refusing unsized risk";
  }
  if (heat.heatUsd + killLossUsd > caps.maxHeatUsd) {
    return `heat cap $${caps.maxHeatUsd} would break ($${heat.heatUsd.toFixed(2)} open + $${killLossUsd.toFixed(2)} new)`;
  }
  return null;
}

/** Halve size after one full stop (the overbet brake); 2 stops = flat. */
export function effectiveSize(sizeUsd: number, stopsToday: number): number {
  return stopsToday >= 1 ? sizeUsd / 2 : sizeUsd;
}

/* ------------------------------------------------------------------ */
/* Blackout windows — the ONE window-matching implementation (OQ-14).  */
/*                                                                     */
/* Moved verbatim from commands/committee.ts: the committee's event-   */
/* risk seat consumes these instead of its own copy. One type, one     */
/* matcher, one set of veto strings.                                   */
/* ------------------------------------------------------------------ */

/** Calendar-verified blackout window (UTC minutes-of-day). */
export type HeatBlackoutWindow = {
  name: string;
  /** Minutes since UTC midnight, inclusive. */
  startMin: number;
  /** Minutes since UTC midnight, exclusive. */
  endMin: number;
};

/** Pure: true when `minutes` (UTC minutes-of-day) falls inside the window. */
export function inUtcWindow(minutes: number, startMin: number, endMin: number): boolean {
  if (!Number.isFinite(minutes) || !Number.isFinite(startMin) || !Number.isFinite(endMin)) return false;
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  // window wraps past midnight
  return minutes >= startMin || minutes < endMin;
}

/** Pure: blackout-window vetoes for one minute-of-day (rule + detail). */
export function blackoutWindowVetoes(
  windows: readonly HeatBlackoutWindow[] | undefined,
  minutes: number,
): { rule: string; detail: string }[] {
  const vetoes: { rule: string; detail: string }[] = [];
  for (const bw of windows ?? []) {
    if (inUtcWindow(minutes, bw.startMin, bw.endMin)) {
      vetoes.push({
        rule: `blackout:${bw.name}`,
        detail: `${bw.name} blackout ${String(bw.startMin).padStart(4, "0")}-${String(bw.endMin).padStart(4, "0")}Z — no directional entries`,
      });
    }
  }
  return vetoes;
}

export type HeatDeps = {
  call?: typeof callTool;
  listConns?: typeof listConnections;
  stateDir?: string;
};

function baseOfPair(pair: string): string {
  const m = /^([A-Za-z0-9]+)/.exec(pair.trim());
  return (m?.[1] ?? "").toUpperCase();
}

/** `jw3 heat` — margin-heat guard. Read-only: two venue reads, local state scan, report + exit code. */
export async function cmdHeat(
  opts: { exchange?: string; minFree: number; json: boolean; url?: string; pat?: string },
  deps?: HeatDeps,
): Promise<void> {
  if (!Number.isFinite(opts.minFree) || opts.minFree < 0) {
    console.error("Usage: jw3 heat [--exchange kucoin] [--min-free 50] [--json]");
    process.exitCode = 2;
    return;
  }
  const pat = needPat(opts.pat);
  if (!pat) return;
  const call = deps?.call ?? callTool;
  const listConns = deps?.listConns ?? listConnections;
  let conn;
  try {
    const rows = await listConns(pat, opts.url);
    conn = pickConnection(rows, opts.exchange, true);
    if (!conn) throw new Error(opts.exchange ? `no ${opts.exchange} connection — connect it in-app first` : "no CEX connections — connect one in-app first");
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  let positionsOut: unknown;
  let balancesOut: unknown;
  try {
    [positionsOut, balancesOut] = await Promise.all([
      call("read_live_datum", { kind: "positions", connectionId: conn.id, withExits: true }, pat, opts.url),
      call("read_live_datum", { kind: "balances", connectionId: conn.id }, pat, opts.url),
    ]);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const open = collectRows(positionsOut).filter((r) => isOpenPosition(r as Record<string, unknown>));
  const bases = new Set<string>();
  for (const r of open) {
    const b = baseOfPair(rowPairOf(r as Record<string, unknown>));
    if (b) bases.add(b);
  }
  const local: LocalState[] = [];
  const unreadable: string[] = [];
  for (const b of bases) {
    const { states, unreadable: bad } = readLocalStates(b, deps?.stateDir);
    local.push(...states);
    unreadable.push(...bad);
  }
  const account = accountFromBalances(balancesOut);
  const report = evaluateHeat({
    exchange: opts.exchange ?? conn.exchange,
    positions: open as Record<string, unknown>[],
    local,
    unreadable,
    account,
    minFree: opts.minFree,
  });
  if (opts.json) {
    console.log(JSON.stringify(report));
  } else {
    const a = report.account;
    const acct = a.unknown
      ? "account unknown (no quote-fund rows)"
      : `total $${a.totalUsd!.toFixed(2)} | locked $${a.lockedUsd!.toFixed(2)} | free $${a.freeUsd!.toFixed(2)}`;
    console.log(`HEAT on ${report.exchange} — ${acct} — ${report.positions.length} open position(s), min-free $${opts.minFree.toFixed(2)}`);
    for (const p of report.positions) {
      const n = p.notionalUsd === null ? "notional unknown" : `$${p.notionalUsd.toFixed(2)}${p.notionalAcctPct === null ? "" : ` (${p.notionalAcctPct.toFixed(1)}% of account)`}`;
      const m =
        p.marginLockedUsd === null
          ? "margin unknown"
          : `margin $${p.marginLockedUsd.toFixed(2)}${p.marginEstimated ? " (est.)" : ""}${p.marginAcctPct === null ? "" : ` (${p.marginAcctPct.toFixed(1)}%)`}`;
      console.log(`  ${p.symbol} ${p.side} ${n} | ${m} — ${p.known ? "KNOWN" : "UNKNOWN-ORIGIN"}`);
    }
    if (report.flags.length === 0) console.log("CLEAN — every position has an owner and free margin covers the floor.");
    for (const f of report.flags) console.log(`  ${f.level.toUpperCase()} [${f.code}] ${f.detail}`);
  }
  if (!report.clean) process.exitCode = 1;
}
