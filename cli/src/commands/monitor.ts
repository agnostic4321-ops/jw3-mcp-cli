/**
 * `monitor` — live telemetry of the account AND the running machine.
 *
 * READ-ONLY: it reads the account through the MCP tool surface
 * (list_connections → read_live_datum balances/positions, list_open_orders)
 * and never places, cancels or closes anything. It never prints a PAT —
 * the token only ever rides into `callTool` as an argument.
 *
 * The module is split so the interesting half is testable with zero
 * network:
 *   - `MonitorSnapshot` is a plain value type (one moment of truth).
 *   - every rule lives in a PURE function over a snapshot: `detectFindings`
 *     and `diffSnapshots`.
 *   - the fetching is isolated behind `MonitorSource` (injectable), so the
 *     tests fabricate snapshots and never touch the network.
 *
 * The monitor is honest by construction: a value the venue did not report
 * stays `null` and is reported as unknown, never filled with a plausible
 * number. A missing read is a finding, not a silent zero.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../mcp.js";
import { collectRows, listConnections, needPat, normalizePair, pickConnection } from "./market.js";
import { extractOpenOrders } from "./trade.js";
import { rowMatchesPair, rowPairOf, statePathsFor, type VenueRow } from "../reconcile.js";

/* ------------------------------------------------------------------ */
/* snapshot type                                                       */
/* ------------------------------------------------------------------ */

/** Severity ladder used by every finding. */
export type Severity = "info" | "warn" | "critical";

/** One armed exit leg (TP / SL / stop / OCO). */
export type MonitorExit = {
  orderId: string;
  kind: "tp" | "sl" | "stop" | "oco" | "unknown";
  /** Trigger price (venue conditional) or the limit price. */
  price: number | null;
  side: string;
  /** "venue" = the venue classified it; "book" = derived from the order book. */
  source: "venue" | "book";
};

/**
 * One position as the monitor sees it. Every money field is `number | null`
 * and `null` means "the venue did not report it" — never zero.
 */
export type MonitorPosition = {
  /** Stable key: exchange + pair + side. */
  key: string;
  exchange: string;
  /** Canonical pair key ("SOL/USDT"). */
  pair: string;
  side: "long" | "short" | "unknown";
  /** Base-unit size. */
  size: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  /** Venue liquidation price. */
  liqPrice: number | null;
  leverage: number | null;
  /** USD notional at mark. */
  notionalUsd: number | null;
  /** Margin locked by this position. */
  marginLockedUsd: number | null;
  /** True when margin was estimated as notional / leverage. */
  marginEstimated: boolean;
  unrealizedPnl: number | null;
  /** Armed exit legs found for this position. */
  exits: MonitorExit[];
  /** True when the venue reported the exits book as unreadable. */
  exitsUnknown: boolean;
  /** True when a daemon state claims this position's SIZE. */
  owned: boolean;
  /** Which daemon state could claim it ("scalp", "grid", "trail", "degen"). */
  owner: string | null;
  /** True when a daemon exists for this pair but none of its sizes match. */
  sizeMismatch: boolean;
  /** The daemon's plausible size(s) in base units, when it declares any. */
  ownerSizes: number[];
  /** Distance from mark to liquidation as a % of mark. */
  liqDistancePct: number | null;
  /** Risk from mark to the protective stop as a % of the position notional. */
  riskToStopPct: number | null;
  /** The same risk in USD. */
  riskUsd: number | null;
};

/** One working (resting) order on the venue book. */
export type MonitorOrder = {
  orderId: string;
  exchange: string;
  pair: string;
  side: string;
  type: string;
  price: number | null;
  quantity: number | null;
  filled: number | null;
  /** Epoch ms the order was placed — null when the venue reports no timestamp. */
  placedAtMs: number | null;
  /** True when this order is an exit leg (stop / reduce-only / OCO). */
  isExit: boolean;
  /** True when a daemon state file claims this order id. */
  owned: boolean;
};

/**
 * One account pocket (one venue wallet). The futures pocket is the one that
 * carries derivatives margin — the `merged` aggregate mixes spot and futures
 * and must never be used to size a futures trade.
 */
export type MonitorPocket = {
  /** Pocket slug as the venue names it ("futures", "spot", "earn"). */
  pocket: string;
  quote: string;
  /** Total balance in the pocket. */
  totalUsd: number | null;
  /** Free (spendable) balance. */
  freeUsd: number | null;
  /** Locked = total − free. */
  lockedUsd: number | null;
  /** True when this is the pocket the monitor treats as the derivatives book. */
  isFutures: boolean;
};

/** Per-venue heat: how loaded one venue's book is. */
export type MonitorVenueHeat = {
  exchange: string;
  /** Read attempts made against this venue in this pass. */
  readCount: number;
  /** Read attempts that failed. */
  errorCount: number;
  /** Read error messages for this venue. */
  errors: string[];
  /** Failed reads ÷ attempted reads (0..1). */
  errorRate: number;
  positionCount: number;
  orderCount: number;
  openNotionalUsd: number | null;
  /** Open notional as a % of the venue's equity. */
  openNotionalPctOfEquity: number | null;
  /** Sum of per-position risk-to-stop as a % of equity. */
  riskPctOfEquity: number | null;
  /** A 0..100 heat score (higher = hotter). */
  heatScore: number;
};

/**
 * The status of an order that left the working book between two snapshots.
 */
export type MonitorResolvedOrder = {
  orderId: string;
  exchange: string;
  pair: string;
  side: string;
  /** "filled" = the venue reports a fill; "unknown" = neither open nor filled. */
  status: "filled" | "cancelled" | "open" | "unknown";
  /** True when the venue positively confirmed the fill. */
  confirmed: boolean;
};

/**
 * ONE moment of truth. The diff and every finding are computed from this
 * value and nothing else.
 */
export type MonitorSnapshot = {
  /** Epoch ms when the snapshot was taken. */
  observedAtMs: number;
  /** ISO timestamp of the observation. */
  observedAt: string;
  exchange: string;
  /** Account pockets, one per venue wallet. */
  pockets: MonitorPocket[];
  /** The futures pocket — the book the monitor judges. */
  futuresPocket: MonitorPocket | null;
  positions: MonitorPosition[];
  orders: MonitorOrder[];
  /** Total open notional across all positions (USD). */
  totalOpenNotionalUsd: number | null;
  /** Total open notional as a % of the futures-pocket equity. */
  openNotionalPctOfEquity: number | null;
  /** Per-venue heat rows. */
  venues: MonitorVenueHeat[];
  /** Read errors (venue unreachable, tool failed). */
  errors: string[];
  /** Orders that left the working book, with their resolved status. */
  resolvedOrders: MonitorResolvedOrder[];
  /** Local daemon state files that could not be parsed. */
  unreadableStates: string[];
  /** True when the positions read could not be completed. */
  positionsUnread: boolean;
  /** True when the balances read could not be completed. */
  balancesUnread: boolean;
  /** True when the orders read could not be completed. */
  ordersUnread: boolean;
};

/* ------------------------------------------------------------------ */
/* thresholds                                                          */
/* ------------------------------------------------------------------ */

/** Every rule the monitor applies, in one place. */
export type MonitorThresholds = {
  /** Free margin floor (USD). Below it → finding. */
  minFreeUsd: number;
  /** Maximum age of a working order (ms). Older → finding. */
  maxOrderAgeMs: number;
  /** Maximum aggregate open notional (USD). Above it → finding. */
  maxOpenNotionalUsd: number;
  /** Maximum open notional as a % of equity. Above it → finding. */
  maxOpenNotionalPct: number;
  /** Liquidation distance (%). Closer than this → finding. */
  minLiqDistancePct: number;
  /** Venue error rate (0..1). Above this → finding. */
  maxVenueErrorRate: number;
  /** Stale TP/SL tolerance (%). How far past the current price an exit may sit. */
  staleExitPct: number;
  /** Fraction of a position's notional allowed at risk to the stop. */
  maxRiskToStopPct: number;
  /** Free-margin drop between snapshots (USD) that counts as "margin dropped". */
  marginDropUsd: number;
  /** Relative tolerance when matching a venue size against a daemon size. */
  sizeTolerancePct: number;
};

/** Conservative defaults. Every one is overridable per-run. */
export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  minFreeUsd: 10,
  maxOrderAgeMs: 60 * 60 * 1000,
  maxOpenNotionalUsd: 500,
  maxOpenNotionalPct: 300,
  minLiqDistancePct: 5,
  maxVenueErrorRate: 0.2,
  staleExitPct: 2,
  maxRiskToStopPct: 50,
  marginDropUsd: 5,
  sizeTolerancePct: 2,
};

/* ------------------------------------------------------------------ */
/* findings                                                            */
/* ------------------------------------------------------------------ */

/** One named detection with a severity and a plain-English message. */
export type MonitorFinding = {
  /** Stable machine-readable code. */
  code: string;
  severity: Severity;
  /** Plain-English sentence — no jargon, numbers carry units. */
  message: string;
  /** Optional subject (pair, venue, order id). */
  subject?: string;
};

/** Named state changes between two snapshots. */
export type MonitorChange = {
  code: string;
  message: string;
};

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
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

const SIZE_KEYS = ["size", "qty", "quantity", "contracts", "currentQty", "positionAmt"] as const;
const PRICE_KEYS = ["markPrice", "mark", "lastPrice", "price"] as const;
const ENTRY_KEYS = ["entryPrice", "entry", "avgPrice", "openPrice", "avgEntryPrice"] as const;
const LIQ_KEYS = ["liqPrice", "liquidationPrice", "liq"] as const;
const NOTIONAL_KEYS = ["notional", "notionalUsd", "markValue", "positionValue", "value"] as const;
const MARGIN_KEYS = [
  "margin",
  "posMargin",
  "initialMargin",
  "marginLocked",
  "isolatedMargin",
  "positionIM",
  "imr",
  "frozenMargin",
] as const;
const LEVERAGE_KEYS = ["leverage", "realLeverage", "lev"] as const;
/** Venue order timestamps (epoch seconds or ms) — used for order age. */
const ORDER_TIME_KEYS = ["createdAt", "createdTime", "cTime", "updateTime", "orderTime", "timestamp", "time"] as const;

/** Quote assets that can back derivatives margin. */
const QUOTE_ASSETS = new Set(["USDT", "USDC", "USD"]);

/**
 * Canonical pair key: separators unified, XBT→BTC, futures `M` suffix
 * stripped. Built on the CLI's own `normalizePair` so a monitor key and a
 * `--pair` key are the same string (one normalizer, one truth).
 */
export function canonicalPair(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "";
  // Venue futures symbols carry an `M` suffix (BTCUSDTM, XBTUSDTM) — strip
  // it the same way the server's pair filters do, BEFORE normalizing, so
  // XBTUSDTM and BTC/USDT land on the same key.
  const stripped = s.replace(/USDTM$/, "USDT");
  return normalizePair(stripped);
}

/** Stable identity of a position across snapshots. */
export function positionKey(exchange: string, pair: string, side: string): string {
  return `${exchange}:${canonicalPair(pair)}:${side.toLowerCase()}`;
}

/** Stable identity of an order across snapshots. */
export function orderKey(exchange: string, orderId: string): string {
  return `${exchange}:${orderId}`;
}

/** USD notional of one venue position row (explicit venue value wins). */
export function positionNotional(row: Record<string, unknown>): number | null {
  const direct = firstNum(row, NOTIONAL_KEYS);
  if (direct !== null) return Math.abs(direct);
  const size = firstNum(row, SIZE_KEYS);
  const price = firstNum(row, [...PRICE_KEYS, ...ENTRY_KEYS]);
  if (size === null || price === null) return null;
  return Math.abs(size) * price;
}

/** Margin locked by one venue position row (never fabricated). */
export function positionMargin(
  row: Record<string, unknown>,
  notionalUsd: number | null,
): { locked: number | null; estimated: boolean } {
  const direct = firstNum(row, MARGIN_KEYS);
  if (direct !== null) return { locked: direct, estimated: false };
  const lev = firstNum(row, LEVERAGE_KEYS);
  if (notionalUsd !== null && lev !== null && lev > 0) {
    return { locked: notionalUsd / lev, estimated: true };
  }
  return { locked: null, estimated: false };
}

/** Venue order timestamp → epoch ms. Null when the venue reports none. */
export function orderPlacedAtMs(row: Record<string, unknown>): number | null {
  for (const k of ORDER_TIME_KEYS) {
    const raw = row[k];
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
      continue;
    }
    const n = numOrNull(raw);
    if (n === null) continue;
    // Heuristic: anything below ~1e12 is seconds, above is milliseconds.
    if (n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  return null;
}

/** True when the row is an exit leg (stop / reduce-only / OCO). */
export function isExitOrder(row: Record<string, unknown>): boolean {
  if (row.stop === true || row.reduceOnly === true || row.oco === true) return true;
  const type = String(row.type ?? "").toLowerCase();
  if (/stop|reduce|oco|take_profit|take-profit/.test(type)) return true;
  return false;
}

/**
 * One account pocket from a venue balance row.
 * `pocket` is the venue wallet slug ("futures", "spot", "earn", …).
 */
export function pocketFromRows(rows: Record<string, unknown>[], pocket: string, quote: string): MonitorPocket {
  let total = 0;
  let free = 0;
  let seen = false;
  for (const r of rows) {
    const asset = String(r.asset ?? r.coin ?? r.currency ?? "").trim().toUpperCase();
    if (asset && asset !== quote) continue;
    const t = firstNum(r, ["total", "totalBalance", "balance", "walletBalance", "equity"]);
    const f = firstNum(r, ["free", "available", "availableBalance", "freeBalance", "withdrawable", "transferBalance"]);
    if (t === null && f === null) continue;
    seen = true;
    total += t ?? 0;
    free += f ?? 0;
  }
  return {
    pocket,
    quote,
    totalUsd: seen ? total : null,
    freeUsd: seen ? free : null,
    lockedUsd: seen ? total - free : null,
    isFutures: pocket === "futures",
  };
}

/**
 * Split a balances payload into pockets. The `accounts` map (venue wallet
 * slugs) is the honest source — `merged` is the aggregate that mixes spot
 * and futures and must never be read as the derivatives book.
 */
export function pocketsFromBalances(out: unknown): MonitorPocket[] {
  const accounts =
    out && typeof out === "object" && (out as Record<string, unknown>).accounts && typeof (out as Record<string, unknown>).accounts === "object"
      ? (out as Record<string, unknown>).accounts as Record<string, unknown>
      : null;
  if (accounts) {
    const pockets: MonitorPocket[] = [];
    for (const [slug, rows] of Object.entries(accounts)) {
      if (!Array.isArray(rows)) continue;
      const quoteRows = rows.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object",
      );
      const quote =
        quoteRows.find((r) => QUOTE_ASSETS.has(String(r.asset ?? "").toUpperCase()))?.asset ??
        "USDT";
      pockets.push(pocketFromRows(quoteRows, slug, String(quote).toUpperCase()));
    }
    return pockets;
  }
  // No accounts map: the payload IS one flat book (already pocket-scoped by
  // the caller). It is named "flat", never "futures" — a flat merged book is
  // NOT the futures pocket and must never be judged as one.
  const rows = Array.isArray(out)
    ? out.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
  if (rows.length === 0) return [];
  const quote = rows.find((r) => QUOTE_ASSETS.has(String(r.asset ?? "").toUpperCase()))?.asset ?? "USDT";
  return [pocketFromRows(rows, "flat", String(quote).toUpperCase())];
}

/** The pocket the monitor judges: the `futures` pocket, never `merged`. */
export function pickFuturesPocket(pockets: MonitorPocket[]): MonitorPocket | null {
  return pockets.find((p) => p.pocket === "futures") ?? null;
}

/** Distance from mark to liquidation, as a % of mark. */
export function liqDistancePct(mark: number | null, liq: number | null): number | null {
  if (mark === null || liq === null || !(mark > 0)) return null;
  return (Math.abs(mark - liq) / mark) * 100;
}

/**
 * Risk from the current mark to the protective stop, as a % of the
 * position notional. A position with no stop has no bounded risk — the
 * caller reports that separately (no armed exit), so this returns null
 * rather than 0 (which would read as "no risk").
 */
export function riskToStopPct(
  side: "long" | "short" | "unknown",
  mark: number | null,
  stopPrice: number | null,
  notionalUsd: number | null,
): number | null {
  if (mark === null || stopPrice === null || notionalUsd === null) return null;
  if (!(mark > 0) || !(notionalUsd > 0)) return null;
  if (side === "unknown") return null;
  const adverse = side === "short" ? mark - stopPrice : stopPrice - mark;
  return (Math.abs(adverse) / mark) * 100;
}

/** The protective stop price among a position's exit legs (SL/stop kind). */
export function protectiveStopOf(exits: MonitorExit[]): number | null {
  for (const e of exits) {
    if (e.kind === "sl" || e.kind === "stop") {
      if (e.price !== null && e.price > 0) return e.price;
    }
  }
  return null;
}

/** The take-profit price among a position's exit legs. */
export function takeProfitOf(exits: MonitorExit[]): number | null {
  for (const e of exits) {
    if (e.kind === "tp" && e.price !== null && e.price > 0) return e.price;
  }
  return null;
}

/** True when the position has any armed exit at all (TP or stop). */
export function hasArmedExit(exits: MonitorExit[]): boolean {
  return takeProfitOf(exits) !== null || protectiveStopOf(exits) !== null;
}

/**
 * Heat score 0..100. Exposure dominates, then position/order count, then
 * read errors. Pure so it can be tested with fabricated numbers.
 */
export function heatScore(args: {
  openNotionalPctOfEquity: number | null;
  positions: number;
  orders: number;
  errorRate: number;
}): number {
  const exposure = args.openNotionalPctOfEquity === null ? 0 : Math.min(100, args.openNotionalPctOfEquity);
  const count = Math.min(100, (args.positions + args.orders) * 10);
  const errors = Math.min(100, args.errorRate * 100);
  return Math.round(Math.min(100, exposure * 0.6 + count * 0.3 + errors * 0.1));
}

/* ------------------------------------------------------------------ */
/* daemon ownership                                                    */
/* ------------------------------------------------------------------ */

/**
 * What the local daemon states claim. Ownership is SIZE-based: a position
 * belongs to a daemon only when the venue's size matches one of the sizes
 * that daemon's plan could have produced. A pair with no state is unknown
 * origin; a pair with a state whose sizes do not match is a size the
 * daemon does not own.
 */
export type MonitorOwnership = {
  /** Pair → the daemon that could own it + the sizes it could be at. */
  byPair: Map<string, { kind: string; sizes: number[] }>;
  /** Every order id the daemon has placed. */
  orderIds: Set<string>;
};

/** Empty ownership (no daemon states found). */
export function emptyOwnership(): MonitorOwnership {
  return { byPair: new Map(), orderIds: new Set() };
}

/** Base units implied by a step's sizeUsd / price (both are in the state). */
function baseUnitsOf(step: unknown): number | null {
  if (!step || typeof step !== "object") return null;
  const s = step as Record<string, unknown>;
  const sizeUsd = numOrNull(s.sizeUsd);
  const price = numOrNull(s.price);
  if (sizeUsd !== null && price !== null && price > 0) return sizeUsd / price;
  return null;
}

/**
 * Plausible base-unit sizes for one daemon state, plus the order ids it
 * claims. Pure over the parsed state document.
 */
export function ownershipFromState(
  kind: string,
  doc: Record<string, unknown>,
): { pair: string; sizes: number[]; orderIds: string[] } {
  const pair = canonicalPair(rowPairOf(doc as VenueRow));
  const sizes: number[] = [];
  const orderIds: string[] = [];
  const addId = (v: unknown): void => {
    const s = String(v ?? "").trim();
    if (s && s !== "?") orderIds.push(s);
  };
  if (kind === "scalp") {
    const placed = Array.isArray(doc.placed) ? (doc.placed as Record<string, unknown>[]) : [];
    const stepSizes = placed.map((p) => baseUnitsOf(p)).filter((n): n is number => n !== null);
    // A ladder is filled one step at a time: any prefix of the steps is a
    // size the plan can legitimately be at.
    let running = 0;
    for (const s of stepSizes) {
      running += s;
      sizes.push(running);
    }
    for (const p of placed) addId((p as Record<string, unknown>).orderId);
  } else if (kind === "grid") {
    const multiplier = numOrNull(doc.multiplier);
    const seed = numOrNull(doc.seedContracts);
    const perLevel = numOrNull(doc.contractsPerLevel);
    const center = numOrNull(doc.center);
    const totalNotional = numOrNull(doc.totalNotionalUsd);
    if (multiplier !== null && seed !== null) sizes.push(seed * multiplier);
    if (multiplier !== null && perLevel !== null) {
      const levels = numOrNull(doc.levels);
      const levelCount = levels === null ? 0 : levels;
      // The ladder adds a level at a time on top of the seed.
      for (let i = 1; i <= levelCount; i++) {
        sizes.push((seed ?? 0) * multiplier + i * perLevel * multiplier);
      }
    }
    if (sizes.length === 0 && totalNotional !== null && center !== null && center > 0) {
      sizes.push(totalNotional / center);
    }
    addId(doc.seedOrderId);
    const placed = Array.isArray(doc.placed) ? (doc.placed as Record<string, unknown>[]) : [];
    for (const p of placed) addId(p.orderId);
  } else if (kind === "trail") {
    const size = numOrNull(doc.size);
    if (size !== null) sizes.push(size);
  } else if (kind === "degen") {
    const step1 = baseUnitsOf(doc.step1);
    const step2 = baseUnitsOf(doc.step2);
    if (step1 !== null) sizes.push(step1);
    if (step1 !== null && step2 !== null) sizes.push(step1 + step2);
    const step1Doc = doc.step1 as Record<string, unknown> | undefined;
    const step2Doc = doc.step2 as Record<string, unknown> | undefined;
    addId(step1Doc?.orderId);
    addId(step2Doc?.orderId);
  }
  return { pair, sizes, orderIds };
}

/**
 * Read the daemon's state files for the given bases and index what they
 * claim. A state file that cannot be parsed is reported (via
 * `unreadable`) rather than skipped: an unreadable state must never read
 * as "nothing is running".
 */
export function readOwnership(
  bases: string[],
  stateDir?: string,
): { ownership: MonitorOwnership; unreadable: string[] } {
  const ownership = emptyOwnership();
  const unreadable: string[] = [];
  for (const base of bases) {
    const paths = statePathsFor(base, stateDir);
    const files: { kind: string; path: string }[] = [
      { kind: "scalp", path: paths.scalp },
      { kind: "grid", path: paths.grid },
      { kind: "trail", path: paths.trail },
      { kind: "degen", path: join(stateDir ?? tmpdir(), `degen_${base.toLowerCase()}.json`) },
    ];
    for (const f of files) {
      let raw: string;
      try {
        raw = readFileSync(f.path, "utf8");
      } catch {
        continue; // no state file — nothing claimed
      }
      let doc: unknown;
      try {
        doc = JSON.parse(raw) as unknown;
      } catch {
        unreadable.push(f.path);
        continue;
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        unreadable.push(f.path);
        continue;
      }
      const parsed = ownershipFromState(f.kind, doc as Record<string, unknown>);
      if (parsed.pair) {
        ownership.byPair.set(parsed.pair, { kind: f.kind, sizes: parsed.sizes });
      }
      for (const id of parsed.orderIds) ownership.orderIds.add(id);
    }
  }
  return { ownership, unreadable };
}

/** True when `size` matches one of the daemon's plausible sizes. */
export function sizeMatches(
  size: number | null,
  sizes: number[],
  tolerancePct: number,
): boolean {
  if (size === null) return false;
  for (const s of sizes) {
    const tol = Math.max(1e-9, Math.abs(s) * (tolerancePct / 100));
    if (Math.abs(size - s) <= tol) return true;
  }
  return false;
}

/**
 * The daemon that could own a venue position row.
 *
 * The match goes through the repo's canonical `rowMatchesPair`, so a venue
 * futures symbol (XBTUSDTM, BTCUSDT) and the daemon state's pair key
 * (BTC/USDT) resolve to the same pair. Comparing the two keys literally
 * would never match and would report every position as unknown-origin.
 */
export function findOwner(
  ownership: MonitorOwnership,
  row: VenueRow,
): { kind: string; sizes: number[] } | undefined {
  for (const [ownerPair, info] of ownership.byPair) {
    if (rowMatchesPair(row, ownerPair)) return info;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* detection — PURE over a snapshot                                   */
/* ------------------------------------------------------------------ */

/**
 * Every rule the monitor applies, in one pure function over a snapshot.
 *
 * Severity rules:
 *   critical — the account is unprotected or already breached:
 *     · a position with no armed exit (no TP and no stop)
 *     · a TP or stop that is stale / on the wrong side of the price
 *     · a position within the liquidation distance
 *     · free margin below the floor
 *     · aggregate open notional above the cap
 *     · a book that could not be read at all (positions / balances)
 *   warn     — needs attention but the account is not yet at risk:
 *     · a working order older than the max age
 *     · a position whose size the daemon does not own (unknown origin)
 *     · venue error rate above the threshold
 *     · a book that could not be read (orders / exit legs)
 *   info     — state worth knowing, no action implied:
 *     · a venue heat figure above the soft band
 *     · an exit so far away that it may never fill
 */
export function detectFindings(
  snap: MonitorSnapshot,
  thresholds: MonitorThresholds = DEFAULT_MONITOR_THRESHOLDS,
): MonitorFinding[] {
  const findings: MonitorFinding[] = [];
  const push = (code: string, severity: Severity, message: string, subject?: string): void => {
    findings.push(subject === undefined ? { code, severity, message } : { code, severity, message, subject });
  };

  // ── Free margin below the floor ───────────────────────────────────
  const pocket = snap.futuresPocket;
  if (pocket === null) {
    push(
      "futures-pocket-unread",
      "critical",
      "No futures account pocket was read, so free margin could not be checked. The merged balance mixes spot and futures money and cannot stand in for it.",
    );
  } else if (pocket.freeUsd === null) {
    push(
      "free-margin-unknown",
      "warn",
      "The futures pocket reports no free balance, so margin usage is unverified.",
      pocket.pocket,
    );
  } else if (pocket.freeUsd < thresholds.minFreeUsd) {
    push(
      "free-margin-below-floor",
      "critical",
      `Free margin is $${pocket.freeUsd.toFixed(2)}, below the $${thresholds.minFreeUsd.toFixed(2)} floor. Stop opening new positions until it recovers.`,
      pocket.pocket,
    );
  }

  // ── Positions ─────────────────────────────────────────────────────
  for (const p of snap.positions) {
    const hasTp = takeProfitOf(p.exits) !== null;
    const hasStop = protectiveStopOf(p.exits) !== null;

    if (p.exitsUnknown) {
      push(
        "exits-unread",
        "warn",
        `The exit book for ${p.pair} could not be read, so protection on this position is unknown. Check it by hand before trusting this report.`,
        p.key,
      );
    } else if (!hasTp && !hasStop) {
      // The most dangerous state there is: live exposure, nothing to exit it.
      push(
        "no-armed-exit",
        "critical",
        `${p.pair} ${p.side} has no take-profit and no stop armed. The position is live with no way out — arm an exit or close it now.`,
        p.key,
      );
    } else {
      // ── Stale / expired TP or SL relative to the current price ──────
      const mark = p.markPrice;
      const tp = takeProfitOf(p.exits);
      const stop = protectiveStopOf(p.exits);
      if (mark !== null && mark > 0 && p.side !== "unknown") {
        if (tp !== null) {
          const tpPct = (Math.abs(tp - mark) / mark) * 100;
          // A TP is stale when the price has already run past it: for a long
          // the mark is above the TP, so the TP can never trigger.
          const passed = p.side === "long" ? mark >= tp : mark <= tp;
          if (passed) {
            push(
              "stale-take-profit",
              "critical",
              `The take-profit on ${p.pair} is at ${tp} but the price is already at ${mark}. It can never trigger — re-arm it above the current price or close the position.`,
              p.key,
            );
          } else if (tpPct > thresholds.staleExitPct * 10 && tpPct < 100) {
            // Still reachable, but so far away that it will not fill in any
            // realistic horizon. Deliberately loose: a normal target a few
            // percent out must NOT raise a finding, or every healthy
            // position carries noise and the operator learns to ignore them.
            push(
              "stale-take-profit",
              "info",
              `The take-profit on ${p.pair} sits ${tpPct.toFixed(2)}% away from the current price, far enough that it may never fill.`,
              p.key,
            );
          }
        }
        if (stop !== null) {
          const stopPct = (Math.abs(stop - mark) / mark) * 100;
          // A stop on the wrong side of the price would trigger instantly
          // (or has already been passed).
          const wrongSide = p.side === "long" ? stop >= mark : stop <= mark;
          if (wrongSide) {
            push(
              "stale-stop",
              "critical",
              `The stop on ${p.pair} is at ${stop}, on the wrong side of the current price ${mark}. It is either already triggered or will fire at once — re-arm it.`,
              p.key,
            );
          } else if (stopPct > thresholds.staleExitPct * 10) {
            push(
              "stale-stop",
              "info",
              `The stop on ${p.pair} is ${stopPct.toFixed(2)}% away from the current price, so the risk it caps is large.`,
              p.key,
            );
          }
        }
      }
    }

    // ── Size the daemon does not own (unknown origin) ────────────────
    if (!p.owned) {
      const owns = p.owner !== null;
      push(
        "unknown-origin-position",
        "warn",
        owns
          ? `The daemon state for ${p.pair} (${p.owner}) does not claim a size of ${p.size ?? "?"} units, so the venue holds a size nobody owns. It may be another session or a manual trade — manage that risk before opening anything new.`
          : `Nothing on this machine owns the ${p.pair} ${p.side} position${p.notionalUsd !== null ? ` ($${p.notionalUsd.toFixed(2)} notional)` : ""}. It may be another session or a manual trade — manage that risk before opening anything new.`,
        p.key,
      );
    }

    // ── Close to liquidation ─────────────────────────────────────────
    if (p.liqDistancePct !== null && p.liqDistancePct < thresholds.minLiqDistancePct) {
      push(
        "near-liquidation",
        "critical",
        `${p.pair} ${p.side} is ${p.liqDistancePct.toFixed(2)}% from liquidation, inside the ${thresholds.minLiqDistancePct.toFixed(2)}% warning band. Reduce the position now.`,
        p.key,
      );
    }

    // ── Risk to the stop vs the notional ─────────────────────────────
    if (p.riskToStopPct !== null && p.riskToStopPct > thresholds.maxRiskToStopPct) {
      push(
        "risk-to-stop-too-large",
        "warn",
        `The stop on ${p.pair} allows ${p.riskToStopPct.toFixed(1)}% of the position to be lost${p.riskUsd !== null ? ` ($${p.riskUsd.toFixed(2)})` : ""}, above the ${thresholds.maxRiskToStopPct.toFixed(1)}% limit. Tighten the stop or cut the size.`,
        p.key,
      );
    }
  }

  // ── Working orders older than the max age ─────────────────────────
  for (const o of snap.orders) {
    if (o.placedAtMs === null) continue;
    const ageMs = snap.observedAtMs - o.placedAtMs;
    if (ageMs > thresholds.maxOrderAgeMs) {
      push(
        "stale-working-order",
        "warn",
        `A working ${o.side} order on ${o.pair} has been open for ${Math.round(ageMs / 60000)} minutes, past the ${Math.round(thresholds.maxOrderAgeMs / 60000)} minute limit. It is reserving margin and may fill at a stale price.`,
        orderKey(o.exchange, o.orderId),
      );
    }
  }

  // ── Aggregate open notional above the cap ──────────────────────────
  if (snap.totalOpenNotionalUsd !== null) {
    if (snap.totalOpenNotionalUsd > thresholds.maxOpenNotionalUsd) {
      push(
        "open-notional-above-cap",
        "critical",
        `Open positions total $${snap.totalOpenNotionalUsd.toFixed(2)}, above the $${thresholds.maxOpenNotionalUsd.toFixed(2)} cap. Flatten some before adding more.`,
      );
    }
    if (
      snap.openNotionalPctOfEquity !== null &&
      snap.openNotionalPctOfEquity > thresholds.maxOpenNotionalPct
    ) {
      push(
        "open-notional-pct-above-cap",
        "critical",
        `Open positions are ${snap.openNotionalPctOfEquity.toFixed(1)}% of account equity, above the ${thresholds.maxOpenNotionalPct.toFixed(1)}% cap.`,
      );
    }
  } else {
    push(
      "open-notional-unknown",
      "warn",
      "Total open notional could not be measured, so the exposure cap could not be checked.",
    );
  }

  // ── Venue error rate ───────────────────────────────────────────────
  for (const v of snap.venues) {
    if (v.readCount > 0 && v.errorRate > thresholds.maxVenueErrorRate) {
      push(
        "venue-error-rate",
        "warn",
        `${v.exchange} failed ${v.errorCount} of ${v.readCount} reads (${(v.errorRate * 100).toFixed(0)}%), above the ${(thresholds.maxVenueErrorRate * 100).toFixed(0)}% limit. The venue is flaky — treat its numbers as suspect.`,
        v.exchange,
      );
    }
    if (v.heatScore >= 70) {
      push(
        "venue-heat-high",
        "info",
        `${v.exchange} is running hot: heat score ${v.heatScore}/100 across ${v.positionCount} position(s) and ${v.orderCount} working order(s).`,
        v.exchange,
      );
    }
  }

  // ── Unreadable books and states ────────────────────────────────────
  if (snap.positionsUnread) {
    push("positions-unread", "critical", "The open positions could not be read, so the account state is unknown. Nothing here can be trusted until the read succeeds.");
  }
  if (snap.balancesUnread) {
    push("balances-unread", "critical", "The account balances could not be read, so free margin is unknown.");
  }
  if (snap.ordersUnread) {
    push("orders-unread", "warn", "The working orders could not be read, so open orders and their ages are unknown.");
  }
  for (const u of snap.unreadableStates) {
    push(
      "unreadable-state",
      "warn",
      `${u} exists but cannot be parsed — refusing to treat it as "nothing running"; inspect or remove it by hand.`,
      u,
    );
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* diff — PURE over two snapshots                                      */
/* ------------------------------------------------------------------ */

/**
 * Compare the current snapshot against the previous one and report the
 * state changes. A snapshot alone cannot say "a position opened"; only a
 * diff can.
 */
export function diffSnapshots(
  prev: MonitorSnapshot | null,
  cur: MonitorSnapshot,
  thresholds: MonitorThresholds = DEFAULT_MONITOR_THRESHOLDS,
): MonitorChange[] {
  const changes: MonitorChange[] = [];
  if (!prev) return changes;

  // ── Positions opened / closed ──────────────────────────────────────
  const prevPos = new Map(prev.positions.map((p) => [p.key, p]));
  const curPos = new Map(cur.positions.map((p) => [p.key, p]));
  for (const [key, p] of curPos) {
    if (!prevPos.has(key)) {
      changes.push({
        code: "position-opened",
        message: `Position opened: ${p.pair} ${p.side}${p.size !== null ? ` ×${p.size}` : ""}${p.notionalUsd !== null ? ` ($${p.notionalUsd.toFixed(2)} notional)` : ""}.`,
      });
    }
  }
  for (const [key, p] of prevPos) {
    if (!curPos.has(key)) {
      changes.push({
        code: "position-closed",
        message: `Position closed: ${p.pair} ${p.side}${p.notionalUsd !== null ? ` ($${p.notionalUsd.toFixed(2)} notional)` : ""}.`,
      });
    }
  }

  // ── Orders filled / cancelled ──────────────────────────────────────
  const prevOrd = new Map(prev.orders.map((o) => [orderKey(o.exchange, o.orderId), o]));
  const curOrd = new Map(cur.orders.map((o) => [orderKey(o.exchange, o.orderId), o]));
  for (const [key, o] of curOrd) {
    if (!prevOrd.has(key)) {
      changes.push({
        code: "order-placed",
        message: `Order placed: ${o.side} ${o.pair} (${o.orderId}).`,
      });
    }
  }
  for (const [key, o] of prevOrd) {
    if (curOrd.has(key)) continue;
    // The order left the working book. Whether it filled or was cancelled is
    // settled by the venue's own order-status read (carried on the current
    // snapshot as `resolvedOrders`), never guessed from the book alone.
    const resolved = cur.resolvedOrders.find(
      (r) => orderKey(r.exchange, r.orderId) === key,
    );
    if (!resolved) {
      changes.push({
        code: "order-left-book",
        message: `Order no longer working: ${o.side} ${o.pair} (${o.orderId}). It either filled or was cancelled — read the order status to confirm which.`,
      });
    } else if (resolved.status === "filled") {
      changes.push({
        code: "order-filled",
        message: `Order filled: ${o.side} ${o.pair} (${o.orderId}).`,
      });
    } else if (resolved.status === "cancelled") {
      changes.push({
        code: "order-cancelled",
        message: `Order cancelled: ${o.side} ${o.pair} (${o.orderId}).`,
      });
    } else {
      changes.push({
        code: "order-left-book",
        message: `Order no longer working: ${o.side} ${o.pair} (${o.orderId}). The venue reports it as neither open nor filled, so it was most likely cancelled — read the order status to confirm.`,
      });
    }
  }

  // ── Margin dropped ─────────────────────────────────────────────────
  const prevFree = prev.futuresPocket?.freeUsd ?? null;
  const curFree = cur.futuresPocket?.freeUsd ?? null;
  if (prevFree !== null && curFree !== null) {
    const drop = prevFree - curFree;
    if (drop >= thresholds.marginDropUsd) {
      changes.push({
        code: "margin-dropped",
        message: `Free margin dropped $${drop.toFixed(2)} (from $${prevFree.toFixed(2)} to $${curFree.toFixed(2)}).`,
      });
    }
  }

  // ── Risk breached / cleared ────────────────────────────────────────
  const prevFindings = detectFindings(prev, thresholds);
  const curFindings = detectFindings(cur, thresholds);
  const prevCodes = new Set(prevFindings.map((f) => f.code));
  const curCodes = new Set(curFindings.map((f) => f.code));
  for (const f of curFindings) {
    if (f.severity === "critical" && !prevCodes.has(f.code)) {
      changes.push({ code: "risk-breached", message: `Risk breached: ${f.message}` });
    }
  }
  for (const f of prevFindings) {
    if (f.severity === "critical" && !curCodes.has(f.code)) {
      changes.push({ code: "risk-cleared", message: `Risk cleared: ${f.message}` });
    }
  }

  return changes;
}

/* ------------------------------------------------------------------ */
/* fetching — isolated behind an injectable dependency                 */
/* ------------------------------------------------------------------ */

/** The venue-facing surface the monitor needs. Injectable for tests. */
export type MonitorSource = {
  /** List the user's exchange connections. */
  listConnections: (
    pat: string,
    url?: string,
  ) => Promise<{ id: string; exchange: string; markets?: string; status?: string }[]>;
  /** Call one MCP tool. */
  callTool: (name: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown>;
};

/** The default source: the live MCP surface. */
export const defaultMonitorSource: MonitorSource = { listConnections, callTool };

/**
 * Read the MCP venue envelope (`{kind, observedAt, venues:[{ok, data, error}]}`)
 * into rows plus the read failures it recorded. A venue entry with
 * `ok: false` is a failed read — it must never read as "no rows".
 */
export function readVenueEnvelope(out: unknown, connectionId?: string): { rows: Record<string, unknown>[]; errors: string[] } {
  const errors: string[] = [];
  if (Array.isArray(out)) {
    return { rows: out.filter((r): r is Record<string, unknown> => !!r && typeof r === "object"), errors };
  }
  if (!out || typeof out !== "object") return { rows: [], errors };
  const o = out as Record<string, unknown>;
  if (Array.isArray(o.venues)) {
    const rows: Record<string, unknown>[] = [];
    for (const v of o.venues) {
      if (!v || typeof v !== "object") continue;
      const vv = v as Record<string, unknown>;
      if (connectionId && typeof vv.connectionId === "string" && vv.connectionId !== connectionId) continue;
      if (vv.ok === false) {
        errors.push(String(vv.error ?? `${String(vv.exchange ?? "venue")}: read failed`));
        continue;
      }
      const data = vv.data;
      if (Array.isArray(data)) {
        for (const r of data) if (r && typeof r === "object") rows.push(r as Record<string, unknown>);
      } else if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).positions)) {
        for (const r of (data as Record<string, unknown>).positions as unknown[]) {
          if (r && typeof r === "object") rows.push(r as Record<string, unknown>);
        }
      }
    }
    return { rows, errors };
  }
  return { rows: collectRows(out) as Record<string, unknown>[], errors };
}

/**
 * Unwrap the MCP balances envelope. The server returns
 * `{kind, observedAt, venues:[{exchange, data:{accounts, merged}}]}` — the
 * `accounts` map (one entry per venue wallet) is the honest pocket map.
 */
export function unwrapBalances(out: unknown, connectionId?: string): unknown {
  if (!out || typeof out !== "object") return out;
  const o = out as Record<string, unknown>;
  if (!Array.isArray(o.venues)) return out;
  for (const v of o.venues) {
    if (!v || typeof v !== "object") continue;
    const vv = v as Record<string, unknown>;
    if (connectionId && typeof vv.connectionId === "string" && vv.connectionId !== connectionId) continue;
    if (vv.ok === false) continue;
    const data = vv.data;
    if (data && typeof data === "object") return data;
  }
  return out;
}

/** Positions + orders + balances → one snapshot. Pure over the raw rows. */
export function buildSnapshot(args: {
  observedAtMs: number;
  exchange: string;
  positionsOut: unknown;
  balancesOut: unknown;
  ordersOut: unknown;
  positionsUnread?: boolean;
  balancesUnread?: boolean;
  ordersUnread?: boolean;
  ownership?: MonitorOwnership;
  errors?: string[];
  resolvedOrders?: MonitorResolvedOrder[];
  unreadableStates?: string[];
  /** Reads attempted against the venue in this pass. */
  readCount?: number;
}): MonitorSnapshot {
  const { observedAtMs, exchange } = args;
  const ownership = args.ownership ?? emptyOwnership();
  const errors = [...(args.errors ?? [])];
  const thresholds = DEFAULT_MONITOR_THRESHOLDS;

  const pockets = pocketsFromBalances(args.balancesOut);
  const futuresPocket = pickFuturesPocket(pockets);
  const equity = futuresPocket?.totalUsd ?? futuresPocket?.freeUsd ?? null;

  const rawPositions = collectRows(args.positionsOut).filter(
    (r) => (r as Record<string, unknown>).size !== 0,
  ) as Record<string, unknown>[];

  // ── Working orders first: the exits of a position may live only on the
  //    book (a plain limit TP is a standalone open order, never a stop leg).
  const rawOrders = extractOpenOrders(args.ordersOut);

  const positions: MonitorPosition[] = rawPositions.map((row) => {
    const pair = canonicalPair(rowPairOf(row as VenueRow));
    const rawSide = String(row.side ?? "").toLowerCase();
    const side: "long" | "short" | "unknown" =
      rawSide === "long" || rawSide === "buy"
        ? "long"
        : rawSide === "short" || rawSide === "sell"
          ? "short"
          : "unknown";
    const size = firstNum(row, SIZE_KEYS);
    const entryPrice = firstNum(row, ENTRY_KEYS);
    const markPrice = firstNum(row, [...PRICE_KEYS]);
    const liqPrice = firstNum(row, LIQ_KEYS);
    const leverage = firstNum(row, LEVERAGE_KEYS);
    const notionalUsd = positionNotional(row);
    const { locked, estimated } = positionMargin(row, notionalUsd);
    const unrealizedPnl = firstNum(row, ["unrealizedPnl", "unrealisedPnl", "pnl"]);

    // Venue-classified exit legs (the stops book).
    const exits: MonitorExit[] = [];
    const rawExits = Array.isArray(row.exits) ? (row.exits as Record<string, unknown>[]) : [];
    for (const e of rawExits) {
      if (!e || typeof e !== "object") continue;
      const kindRaw = String(e.kind ?? "").toLowerCase();
      const kind: MonitorExit["kind"] =
        kindRaw === "tp" || kindRaw === "sl" || kindRaw === "stop" || kindRaw === "oco" ? kindRaw : "unknown";
      const price = firstNum(e, ["triggerPrice", "price", "stopPrice"]);
      exits.push({
        orderId: String(e.orderId ?? ""),
        kind,
        price: price !== null && price > 0 ? price : null,
        side: String(e.side ?? "").toLowerCase(),
        source: "venue",
      });
    }
    const exitsUnknown = row.exitsUnknown === true;

    // Book-derived exit legs: an opposite-side resting order on the same
    // pair is an exit, not a new position (one-way books cannot hold both
    // sides). A plain limit beyond the entry is the take-profit case.
    if (!exitsUnknown) {
      const wantSide = side === "long" ? "sell" : side === "short" ? "buy" : "";
      if (wantSide) {
        for (const o of rawOrders) {
          // The repo's canonical venue-row→pair matcher decides whether
          // this order belongs to this position's pair. A venue futures
          // symbol (XBTUSDTM) and the pair key (BTC/USDT) must land on the
          // same key — a hand-rolled compare here silently mismatched them
          // and every position lost its book-level exit leg.
          if (!rowMatchesPair(o as VenueRow, pair)) continue;
          if (String(o.side ?? "").toLowerCase() !== wantSide) continue;
          const oPrice = numOrNull(o.price);
          const oTrigger = numOrNull(o.triggerPrice);
          const ref = oTrigger !== null && oTrigger > 0 ? oTrigger : oPrice;
          if (ref === null || !(ref > 0)) continue;
          const flagged = isExitOrder(o);
          let kind: MonitorExit["kind"] | null = null;
          if (flagged && entryPrice !== null && entryPrice > 0) {
            kind = ref === entryPrice ? "stop" : (side === "long") === (ref > entryPrice) ? "tp" : "sl";
          } else if (!flagged && entryPrice !== null && entryPrice > 0) {
            // A plain opposite-side limit beyond the entry is a resting exit.
            if (side === "long" ? ref > entryPrice : ref < entryPrice) kind = "tp";
            else kind = "sl";
          }
          if (!kind) continue;
          const orderId = String(o.orderId ?? o.id ?? "");
          if (exits.some((e) => e.orderId && e.orderId === orderId)) continue;
          exits.push({
            orderId,
            kind,
            price: ref,
            side: wantSide,
            source: "book",
          });
        }
      }
    }

    const owner = findOwner(ownership, row as VenueRow);
    const ownerSizes = owner?.sizes ?? [];
    const owned = owner !== undefined && sizeMatches(size, ownerSizes, thresholds.sizeTolerancePct);
    const sizeMismatch = owner !== undefined && !owned && ownerSizes.length > 0;

    const liqPct = liqDistancePct(markPrice, liqPrice);
    const stop = protectiveStopOf(exits);
    const riskPct = riskToStopPct(side, markPrice, stop, notionalUsd);

    return {
      key: positionKey(exchange, pair, side),
      exchange,
      pair,
      side,
      size,
      entryPrice,
      markPrice,
      liqPrice,
      leverage,
      notionalUsd,
      marginLockedUsd: locked,
      marginEstimated: estimated,
      unrealizedPnl,
      exits,
      exitsUnknown,
      owned,
      owner: owner?.kind ?? null,
      sizeMismatch,
      ownerSizes,
      liqDistancePct: liqPct,
      riskToStopPct: riskPct,
      riskUsd:
        riskPct !== null && notionalUsd !== null ? (notionalUsd * riskPct) / 100 : null,
    };
  });

  const orders: MonitorOrder[] = rawOrders.map((row) => {
    const id = String(row.orderId ?? row.id ?? row.ordId ?? "");
    return {
      orderId: id,
      exchange,
      pair: canonicalPair(rowPairOf(row as VenueRow)),
      side: String(row.side ?? "").toLowerCase(),
      type: String(row.type ?? "").toLowerCase(),
      price: numOrNull(row.price),
      quantity: firstNum(row, ["quantity", "qty", "size", "origQty"]),
      filled: firstNum(row, ["filled", "dealSize", "executedQty", "cumExecQty"]),
      placedAtMs: orderPlacedAtMs(row),
      isExit: isExitOrder(row),
      owned: id !== "" && ownership.orderIds.has(id),
    };
  });

  const totalOpenNotionalUsd = positions.some((p) => p.notionalUsd === null)
    ? null
    : positions.reduce((sum, p) => sum + (p.notionalUsd ?? 0), 0);
  const openNotionalPctOfEquity =
    totalOpenNotionalUsd !== null && equity !== null && equity > 0
      ? (totalOpenNotionalUsd / equity) * 100
      : null;

  const readCount = args.readCount ?? 3;
  const errorCount = errors.length;
  const errorRate = readCount > 0 ? errorCount / readCount : 0;
  const venues: MonitorVenueHeat[] = [
    {
      exchange,
      readCount,
      errorCount,
      errors: [...errors],
      errorRate,
      positionCount: positions.length,
      orderCount: orders.length,
      openNotionalUsd: totalOpenNotionalUsd,
      openNotionalPctOfEquity,
      riskPctOfEquity:
        equity !== null && equity > 0
          ? positions.some((p) => p.riskToStopPct === null)
            ? null
            : positions.reduce((sum, p) => sum + (p.riskToStopPct ?? 0), 0) / equity
          : null,
      heatScore: 0,
    },
  ];
  venues[0]!.heatScore = heatScore({
    openNotionalPctOfEquity,
    positions: positions.length,
    orders: orders.length,
    errorRate,
  });

  return {
    observedAtMs,
    observedAt: new Date(observedAtMs).toISOString(),
    exchange,
    pockets,
    futuresPocket,
    positions,
    orders,
    totalOpenNotionalUsd,
    openNotionalPctOfEquity,
    venues,
    errors,
    resolvedOrders: args.resolvedOrders ?? [],
    unreadableStates: args.unreadableStates ?? [],
    positionsUnread: args.positionsUnread === true,
    balancesUnread: args.balancesUnread === true,
    ordersUnread: args.ordersUnread === true,
  };
}

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

export type MonitorOptions = {
  exchange?: string;
  thresholds: MonitorThresholds;
  json: boolean;
  url?: string;
  pat?: string;
};

export type MonitorDeps = {
  source?: MonitorSource;
  stateDir?: string;
  /** Injectable clock (tests). */
  now?: () => number;
};

/** The full report the command prints. */
export type MonitorReport = {
  mode: "monitor";
  exchange: string;
  snapshot: MonitorSnapshot;
  findings: MonitorFinding[];
  changes: MonitorChange[];
  thresholds: MonitorThresholds;
  /** True when nothing is above `info`. */
  ok: boolean;
};

/** One read attempt, with its outcome. */
type ReadResult = { out: unknown; unread: boolean; error: string | null };

async function readOne(
  source: MonitorSource,
  name: string,
  args: Record<string, unknown>,
  pat: string,
  url?: string,
): Promise<ReadResult> {
  try {
    const out = await source.callTool(name, args, pat, url);
    return { out, unread: false, error: null };
  } catch (e) {
    return { out: null, unread: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Read one snapshot from the live MCP surface.
 *
 * The PAT is only ever passed to the MCP client — it is never logged, never
 * put in the report and never printed.
 *
 * When `prev` is supplied, the orders that left the working book since the
 * previous snapshot are resolved through the venue's own order-status read,
 * so the diff can say "filled" vs "cancelled" honestly.
 */
export async function fetchSnapshot(
  opts: { exchange?: string; url?: string; pat: string },
  deps: MonitorDeps = {},
  prev?: MonitorSnapshot | null,
): Promise<MonitorSnapshot> {
  const source = deps.source ?? defaultMonitorSource;
  const now = deps.now ?? (() => Date.now());
  const errors: string[] = [];

  const conns = await source.listConnections(opts.pat, opts.url);
  const conn = pickConnection(conns as { id: string; exchange: string }[], opts.exchange, true);
  if (!conn) {
    throw new Error(
      opts.exchange
        ? `no ${opts.exchange} connection — connect it in-app first`
        : "no CEX connections — connect one in-app first",
    );
  }
  const exchange = conn.exchange;

  const [positionsRes, balancesRes, ordersRes] = await Promise.all([
    readOne(source, "read_live_datum", { kind: "positions", connectionId: conn.id, withExits: true }, opts.pat, opts.url),
    readOne(source, "read_live_datum", { kind: "balances", connectionId: conn.id }, opts.pat, opts.url),
    readOne(source, "list_open_orders", { exchange, connectionId: conn.id }, opts.pat, opts.url),
  ]);

  if (positionsRes.unread) errors.push(`positions: ${positionsRes.error ?? "read failed"}`);
  if (balancesRes.unread) errors.push(`balances: ${balancesRes.error ?? "read failed"}`);
  if (ordersRes.unread) errors.push(`orders: ${ordersRes.error ?? "read failed"}`);

  // A venue entry inside the envelope can carry its own read failure.
  const positionsEnvelope = readVenueEnvelope(positionsRes.out, conn.id);
  for (const e of positionsEnvelope.errors) errors.push(`positions: ${e}`);

  const balancesOut = unwrapBalances(balancesRes.out, conn.id);

  // Bases of the open positions — the daemon states that could own them.
  const bases = new Set<string>();
  for (const r of positionsEnvelope.rows) {
    const pair = canonicalPair(rowPairOf(r as VenueRow));
    const base = pair.split("/")[0];
    if (base) bases.add(base);
  }
  const { ownership, unreadable } = readOwnership([...bases], deps.stateDir);

  // ── Resolve orders that left the working book since the last pass ──
  const resolvedOrders: MonitorResolvedOrder[] = [];
  if (prev) {
    const curIds = new Set(extractOpenOrders(ordersRes.out).map((o) => String(o.orderId ?? o.id ?? "")));
    for (const o of prev.orders) {
      if (curIds.has(o.orderId)) continue;
      const statusRes = await readOne(
        source,
        "read_live_datum",
        { kind: "order", connectionId: conn.id, orderId: o.orderId },
        opts.pat,
        opts.url,
      );
      const payload = statusRes.out as { status?: unknown } | null;
      const status = String(payload?.status ?? "unknown").toLowerCase();
      resolvedOrders.push({
        orderId: o.orderId,
        exchange,
        pair: o.pair,
        side: o.side,
        status:
          status === "filled"
            ? "filled"
            : status === "open"
              ? "open"
              : status === "cancelled"
                ? "cancelled"
                : "unknown",
        confirmed: status === "filled" || status === "cancelled",
      });
    }
  }

  return buildSnapshot({
    observedAtMs: now(),
    exchange,
    positionsOut: positionsRes.out,
    balancesOut,
    ordersOut: ordersRes.out,
    positionsUnread: positionsRes.unread,
    balancesUnread: balancesRes.unread,
    ordersUnread: ordersRes.unread,
    ownership,
    errors,
    resolvedOrders,
    unreadableStates: unreadable,
    readCount: 3,
  });
}

/** Render the report for humans. */
export function formatMonitorReport(report: MonitorReport): string[] {
  const lines: string[] = [];
  const s = report.snapshot;
  const pocket = s.futuresPocket;
  lines.push(
    `MONITOR ${s.exchange} @ ${s.observedAt} — ${s.positions.length} open position(s), ${s.orders.length} working order(s)`,
  );
  if (pocket === null) {
    lines.push("  account: futures pocket NOT read (free margin unknown)");
  } else {
    const free = pocket.freeUsd === null ? "unknown" : `$${pocket.freeUsd.toFixed(2)}`;
    const locked = pocket.lockedUsd === null ? "unknown" : `$${pocket.lockedUsd.toFixed(2)}`;
    const total = pocket.totalUsd === null ? "unknown" : `$${pocket.totalUsd.toFixed(2)}`;
    lines.push(`  account (${pocket.pocket} pocket): free ${free} | locked ${locked} | total ${total}`);
  }
  const notional = s.totalOpenNotionalUsd === null ? "unknown" : `$${s.totalOpenNotionalUsd.toFixed(2)}`;
  const pct = s.openNotionalPctOfEquity === null ? "unknown" : `${s.openNotionalPctOfEquity.toFixed(1)}%`;
  lines.push(`  open notional: ${notional} (${pct} of equity)`);
  for (const p of s.positions) {
    const n = p.notionalUsd === null ? "notional unknown" : `$${p.notionalUsd.toFixed(2)}`;
    const exits = p.exitsUnknown
      ? "exits UNREAD"
      : p.exits.length === 0
        ? "NO ARMED EXIT"
        : p.exits.map((e) => `${e.kind}${e.price !== null ? `@${e.price}` : ""}`).join("+");
    const liq = p.liqDistancePct === null ? "liq unknown" : `${p.liqDistancePct.toFixed(2)}% from liq`;
    const risk = p.riskToStopPct === null ? "risk unknown" : `risk ${p.riskToStopPct.toFixed(1)}% to stop`;
    lines.push(
      `  ${p.pair} ${p.side} ${p.size ?? "?"} | ${n} | ${exits} | ${liq} | ${risk} | ${p.owned ? `owned:${p.owner}` : "SIZE NOT OWNED"}`,
    );
  }
  for (const v of s.venues) {
    lines.push(
      `  venue ${v.exchange}: heat ${v.heatScore}/100 | ${v.positionCount} pos | ${v.orderCount} orders | ${v.errorCount}/${v.readCount} reads failed`,
    );
  }
  if (report.changes.length > 0) {
    lines.push("  CHANGES:");
    for (const c of report.changes) lines.push(`    - ${c.message}`);
  }
  if (report.findings.length === 0) {
    lines.push("  CLEAN — no finding above the configured thresholds.");
  }
  for (const f of report.findings) {
    lines.push(`  ${f.severity.toUpperCase()} [${f.code}] ${f.message}`);
  }
  return lines;
}

/** Validate the thresholds. Returns a message, or null when usable. */
export function validateMonitorThresholds(t: MonitorThresholds): string | null {
  const checks: [keyof MonitorThresholds, string][] = [
    ["minFreeUsd", ">= 0"],
    ["maxOrderAgeMs", "> 0"],
    ["maxOpenNotionalUsd", "> 0"],
    ["maxOpenNotionalPct", "> 0"],
    ["minLiqDistancePct", "> 0"],
    ["maxVenueErrorRate", "0..1"],
    ["staleExitPct", "> 0"],
    ["maxRiskToStopPct", "> 0"],
    ["marginDropUsd", "> 0"],
    ["sizeTolerancePct", ">= 0"],
  ];
  for (const [key, range] of checks) {
    const v = t[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return `--${key} must be a number (${range})`;
    if (key === "minFreeUsd" || key === "sizeTolerancePct") {
      if (v < 0) return `--${key} must be ${range}`;
    } else if (key === "maxVenueErrorRate") {
      if (v < 0 || v > 1) return `--${key} must be ${range}`;
    } else if (v <= 0) {
      return `--${key} must be ${range}`;
    }
  }
  return null;
}

/**
 * `jw3 monitor` — one live telemetry pass.
 *
 * Read-only. Exit 1 when a critical finding fired (so a supervisor can
 * gate on it), 0 when clean, 2 on a usage error.
 */
export async function cmdMonitor(opts: MonitorOptions, deps: MonitorDeps = {}): Promise<void> {
  const bad = validateMonitorThresholds(opts.thresholds);
  if (bad) {
    console.error(
      `Usage: jw3 monitor [--exchange kucoin] [--min-free 10] [--max-order-age-min 60] [--max-notional 500] [--max-notional-pct 300] [--min-liq-pct 5] [--max-error-rate 0.2] [--stale-exit-pct 2] [--max-risk-pct 50] — ${bad}. Nothing was called.`,
    );
    process.exitCode = 2;
    return;
  }

  const pat = needPat(opts.pat);
  if (!pat) return;

  let snapshot: MonitorSnapshot;
  try {
    snapshot = await fetchSnapshot({ exchange: opts.exchange, url: opts.url, pat }, deps);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const findings = detectFindings(snapshot, opts.thresholds);
  const report: MonitorReport = {
    mode: "monitor",
    exchange: snapshot.exchange,
    snapshot,
    findings,
    changes: [],
    thresholds: opts.thresholds,
    ok: !findings.some((f) => f.severity === "critical"),
  };

  if (opts.json) {
    console.log(JSON.stringify(report));
  } else {
    for (const line of formatMonitorReport(report)) console.log(line);
  }
  if (!report.ok) process.exitCode = 1;
}
