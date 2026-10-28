/**
 * Paper account store — local JSON only, zero venue contact.
 *
 * One file under the CLI config dir (`~/.config/jw3/paper-accounts.json`,
 * `JW3_CONFIG_HOME` override): named paper accounts, each with its own
 * cash balance, open positions, and fill history. There is deliberately
 * NO import of trade execution, MCP calls, or fund-moving paths — this
 * module cannot move money by construction (it has no transport).
 *
 * Accounting model (margin-locked, documented in PAPER_ACCOUNTS.md):
 *  - open:   lock margin = notional / leverage; cash -= margin + entry fee
 *  - close:  cash += margin + grossPnl - exit fee; realizedPnl += grossPnl - exit fee
 *  - equity (at marks) = cash + lockedMargin + sum(unrealizedGross)
 *  - entry fees sit in totalFeesUsd; they reduce cash but never realizedPnl
 *    (realizedPnl is net of EXIT fees only — see closePaperPosition).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { configDir } from "./config.js";

export type PaperSide = "long" | "short";
export type PaperFeeTier = "maker" | "taker";
export type PaperFillKind = "open" | "close" | "tp" | "sl";
export type PaperOrderSide = "buy" | "sell";

export type PaperPosition = {
  id: string;
  pair: string;
  side: PaperSide;
  qty: number;
  entryPrice: number;
  leverage: number;
  marginLockedUsd: number;
  tp: number | null;
  sl: number | null;
  strategy: string | null;
  feeTier: PaperFeeTier;
  openedAt: string;
};

export type PaperFill = {
  id: string;
  ts: string;
  pair: string;
  side: PaperOrderSide;
  qty: number;
  price: number;
  feeUsd: number;
  feeTier: PaperFeeTier;
  kind: PaperFillKind;
  positionId: string;
  strategy: string | null;
  /** Net USD of THIS closing fill (gross pnl minus the exit fee). Absent on opens. */
  pnlUsd?: number;
  note?: string;
};

export type PaperAccount = {
  name: string;
  initialEquityUsd: number;
  cashUsd: number;
  realizedPnlUsd: number;
  totalFeesUsd: number;
  seq: number;
  positions: PaperPosition[];
  fills: PaperFill[];
  createdAt: string;
  updatedAt: string;
};

export type PaperStore = { version: 1; accounts: Record<string, PaperAccount> };

export const PAPER_STORE_VERSION = 1 as const;
export const PAPER_STORE_FILE = "paper-accounts.json";
/** Cap on fills kept per account — the file stays small. */
export const PAPER_MAX_FILLS = 1000;

/** Canonical config dir — single copy lives in config.ts. Kept as a named
 * alias so existing importers don't churn. */
export function paperConfigDir(): string {
  return configDir();
}

export function paperStorePath(dir?: string): string {
  return join(dir ?? paperConfigDir(), PAPER_STORE_FILE);
}

export function emptyStore(): PaperStore {
  return { version: 1, accounts: {} };
}

/** Pure: `SOL/USDT` usable, uppercase-normalized. Null = reject with usage. */
export function validatePaperPair(pair: string): string | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return "pair required (e.g. SOL/USDT)";
  const base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(base) || quote !== "USDT") return "pair required (e.g. SOL/USDT)";
  return null;
}

export function normalizePaperPair(pair: string): string {
  const [b, q] = pair.split("/");
  return `${(b ?? "").trim().toUpperCase()}/${(q ?? "").trim().toUpperCase()}`;
}

/** Pure: account names are filesystem- and log-safe. */
export function validateAccountName(name: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name)) {
    return "account must match [a-zA-Z0-9_-]{1,32}, starting alphanumeric";
  }
  return null;
}

/** Pure: freeform strategy tag, bounded so logs stay greppable. */
export function validateStrategyTag(tag: string | undefined): string | null {
  if (tag === undefined) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,39}$/.test(tag)) {
    return "strategy tag must match [a-zA-Z0-9_.:-]{1,40}, starting alphanumeric";
  }
  return null;
}

export function normalizeStrategyTag(tag: string | undefined): string | null {
  if (tag === undefined) return null;
  return tag.trim().toLowerCase() || null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextId(acct: PaperAccount, prefix: string): string {
  acct.seq += 1;
  return `paper-${prefix}-${acct.seq}`;
}

/** Load the store; a missing or corrupt file falls back to empty (never throws). */
export function loadPaperStore(path: string): PaperStore {
  try {
    if (!existsSync(path)) return emptyStore();
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PaperStore>;
    if (!raw || typeof raw !== "object" || typeof raw.accounts !== "object" || !raw.accounts) {
      return emptyStore();
    }
    const accounts: Record<string, PaperAccount> = {};
    for (const [k, v] of Object.entries(raw.accounts as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const a = v as Partial<PaperAccount>;
        if (typeof a.name === "string" && Number.isFinite(a.cashUsd)) {
          accounts[k] = {
            name: a.name,
            initialEquityUsd: Number.isFinite(a.initialEquityUsd) ? (a.initialEquityUsd as number) : 0,
            cashUsd: a.cashUsd as number,
            realizedPnlUsd: Number.isFinite(a.realizedPnlUsd) ? (a.realizedPnlUsd as number) : 0,
            totalFeesUsd: Number.isFinite(a.totalFeesUsd) ? (a.totalFeesUsd as number) : 0,
            seq: Number.isInteger(a.seq) && (a.seq as number) >= 0 ? (a.seq as number) : 0,
            positions: Array.isArray(a.positions) ? (a.positions as PaperPosition[]) : [],
            fills: Array.isArray(a.fills) ? (a.fills as PaperFill[]) : [],
            createdAt: typeof a.createdAt === "string" ? a.createdAt : nowIso(),
            updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : nowIso(),
          };
        }
      }
    }
    return { version: 1, accounts };
  } catch {
    return emptyStore();
  }
}

export function savePaperStore(path: string, store: PaperStore): void {
  // Same 0700 dir / 0600 file discipline as config.ts credentials and
  // cache.ts verdict files: paper books live under the same config dir.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // best-effort; an existing dir keeps its current mode
  }
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort; writeFileSync mode already applied on creation
  }
}

export function getAccount(store: PaperStore, name: string): PaperAccount | null {
  return store.accounts[name] ?? null;
}

/** Pure: create an account in the store. String = reject, null = ok. */
export function createPaperAccount(
  store: PaperStore,
  name: string,
  equityUsd: number,
): string | null {
  const bad = validateAccountName(name);
  if (bad) return bad;
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return "equity must be > 0 USD";
  if (store.accounts[name]) return `account ${JSON.stringify(name)} already exists`;
  const t = nowIso();
  store.accounts[name] = {
    name,
    initialEquityUsd: equityUsd,
    cashUsd: equityUsd,
    realizedPnlUsd: 0,
    totalFeesUsd: 0,
    seq: 0,
    positions: [],
    fills: [],
    createdAt: t,
    updatedAt: t,
  };
  return null;
}

/** Pure: add cash to an account (simulated deposit — no venue contact). */
export function fundPaperAccount(
  store: PaperStore,
  name: string,
  amountUsd: number,
): string | null {
  const acct = getAccount(store, name);
  if (!acct) return `unknown account ${JSON.stringify(name)} — create it first`;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return "amount must be > 0 USD";
  acct.cashUsd += amountUsd;
  acct.updatedAt = nowIso();
  return null;
}

/**
 * Pure: reset an account to its initial equity, clearing positions and
 * fills. Closing fills are NOT synthesized — reset is a fresh book, and
 * inventing exit fills would corrupt the fill history.
 */
export function resetPaperAccount(store: PaperStore, name: string): string | null {
  const acct = getAccount(store, name);
  if (!acct) return `unknown account ${JSON.stringify(name)} — create it first`;
  const t = nowIso();
  store.accounts[name] = {
    name: acct.name,
    initialEquityUsd: acct.initialEquityUsd,
    cashUsd: acct.initialEquityUsd,
    realizedPnlUsd: 0,
    totalFeesUsd: 0,
    seq: acct.seq,
    positions: [],
    fills: [],
    createdAt: acct.createdAt,
    updatedAt: t,
  };
  return null;
}

export type OpenPaperPositionInput = {
  pair: string;
  side: PaperSide;
  qty: number;
  price: number;
  leverage: number;
  feeUsd: number;
  feeTier: PaperFeeTier;
  tp?: number;
  sl?: number;
  strategy?: string | null;
};

/**
 * Pure: open a position. Margin + entry fee leave cash; the position and
 * its open fill are appended. String = reject (nothing mutated), null = ok.
 */
export function openPaperPosition(
  store: PaperStore,
  account: string,
  input: OpenPaperPositionInput,
): { position?: PaperPosition; error?: string } {
  const acct = getAccount(store, account);
  if (!acct) return { error: `unknown account ${JSON.stringify(account)} — create it first` };
  const pairErr = validatePaperPair(input.pair);
  if (pairErr) return { error: pairErr };
  if (input.side !== "long" && input.side !== "short") return { error: "side must be long|short" };
  if (!Number.isFinite(input.qty) || input.qty <= 0) return { error: "qty must be > 0 base units" };
  if (!Number.isFinite(input.price) || input.price <= 0) return { error: "price must be > 0" };
  if (!Number.isFinite(input.leverage) || input.leverage < 1) return { error: "leverage must be >= 1" };
  if (!Number.isFinite(input.feeUsd) || input.feeUsd < 0) return { error: "fee must be >= 0" };
  if (input.tp !== undefined && (!Number.isFinite(input.tp) || input.tp <= 0)) {
    return { error: "tp must be > 0" };
  }
  if (input.sl !== undefined && (!Number.isFinite(input.sl) || input.sl <= 0)) {
    return { error: "sl must be > 0" };
  }
  const tagErr = validateStrategyTag(input.strategy ?? undefined);
  if (tagErr) return { error: tagErr };
  const notional = input.qty * input.price;
  const margin = notional / input.leverage;
  if (acct.cashUsd < margin + input.feeUsd) {
    return {
      error: `insufficient paper cash: need $${(margin + input.feeUsd).toFixed(2)} (margin $${margin.toFixed(2)} + fee $${input.feeUsd.toFixed(2)}), have $${acct.cashUsd.toFixed(2)}`,
    };
  }
  // TP/SL must sit on the profitable / loss side of entry — otherwise the
  // leg would fill instantly and the ticket is a typo, not a plan.
  if (input.tp !== undefined) {
    const tpOk = input.side === "long" ? input.tp > input.price : input.tp < input.price;
    if (!tpOk) return { error: `tp ${input.tp} is not on the profit side of entry ${input.price} for ${input.side}` };
  }
  if (input.sl !== undefined) {
    const slOk = input.side === "long" ? input.sl < input.price : input.sl > input.price;
    if (!slOk) return { error: `sl ${input.sl} is not on the loss side of entry ${input.price} for ${input.side}` };
  }
  const t = nowIso();
  const pair = normalizePaperPair(input.pair);
  const strategy = normalizeStrategyTag(input.strategy ?? undefined);
  const position: PaperPosition = {
    id: nextId(acct, "pos"),
    pair,
    side: input.side,
    qty: input.qty,
    entryPrice: input.price,
    leverage: input.leverage,
    marginLockedUsd: margin,
    tp: input.tp ?? null,
    sl: input.sl ?? null,
    strategy,
    feeTier: input.feeTier,
    openedAt: t,
  };
  acct.cashUsd -= margin + input.feeUsd;
  acct.totalFeesUsd += input.feeUsd;
  acct.positions.push(position);
  acct.fills.push({
    id: nextId(acct, "fill"),
    ts: t,
    pair,
    side: input.side === "long" ? "buy" : "sell",
    qty: input.qty,
    price: input.price,
    feeUsd: input.feeUsd,
    feeTier: input.feeTier,
    kind: "open",
    positionId: position.id,
    strategy,
  });
  trimFills(acct);
  acct.updatedAt = t;
  return { position };
}

export type ClosePaperPositionInput = {
  price: number;
  feeUsd: number;
  feeTier: PaperFeeTier;
  kind: PaperFillKind;
  note?: string;
};

/**
 * Pure: close a position by id. Margin unlocks back into cash plus the
 * gross pnl minus the exit fee; realizedPnl accrues net (exit-fee only).
 * String = reject (nothing mutated).
 */
export function closePaperPosition(
  store: PaperStore,
  account: string,
  positionId: string,
  input: ClosePaperPositionInput,
  grossPnlUsd: (side: PaperSide, entry: number, exit: number, qty: number) => number,
): { fill?: PaperFill; error?: string } {
  const acct = getAccount(store, account);
  if (!acct) return { error: `unknown account ${JSON.stringify(account)} — create it first` };
  const idx = acct.positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return { error: `unknown position ${JSON.stringify(positionId)}` };
  if (!Number.isFinite(input.price) || input.price <= 0) return { error: "price must be > 0" };
  if (!Number.isFinite(input.feeUsd) || input.feeUsd < 0) return { error: "fee must be >= 0" };
  if (input.kind !== "close" && input.kind !== "tp" && input.kind !== "sl") {
    return { error: "kind must be close|tp|sl" };
  }
  const pos = acct.positions[idx] as PaperPosition;
  const gross = grossPnlUsd(pos.side, pos.entryPrice, input.price, pos.qty);
  const net = gross - input.feeUsd;
  const t = nowIso();
  acct.positions.splice(idx, 1);
  acct.cashUsd += pos.marginLockedUsd + gross - input.feeUsd;
  acct.realizedPnlUsd += net;
  acct.totalFeesUsd += input.feeUsd;
  const fill: PaperFill = {
    id: nextId(acct, "fill"),
    ts: t,
    pair: pos.pair,
    side: pos.side === "long" ? "sell" : "buy",
    qty: pos.qty,
    price: input.price,
    feeUsd: input.feeUsd,
    feeTier: input.feeTier,
    kind: input.kind,
    positionId: pos.id,
    strategy: pos.strategy,
    pnlUsd: net,
    ...(input.note ? { note: input.note } : {}),
  };
  acct.fills.push(fill);
  trimFills(acct);
  acct.updatedAt = t;
  return { fill };
}

function trimFills(acct: PaperAccount): void {
  if (acct.fills.length > PAPER_MAX_FILLS) {
    acct.fills.splice(0, acct.fills.length - PAPER_MAX_FILLS);
  }
}

/** Margin currently locked across open positions. */
export function lockedMarginUsd(acct: PaperAccount): number {
  return acct.positions.reduce((s, p) => s + p.marginLockedUsd, 0);
}
