/**
 * Order-state reconcile: the "no strays" invariant.
 *
 * Every fund-moving loop (scalp / grid / trail) leaves two kinds of truth:
 * local state files (tmpdir, per-base) and venue truth (open positions +
 * working orders). A stray is any row on one side with no counterpart on
 * the other: an unmanaged position, working orders with no owning state
 * file, or a stale state file for a flat account.
 *
 * This module is pure (classifiers + guards) so the rules are unit-tested
 * with zero network. `commands/reconcile.ts` wires the venue reads.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StateKind = "scalp" | "grid" | "trail";

export type LocalState = {
  kind: StateKind;
  path: string;
  pair: string;
  /** Venue-side identifiers this state claims (step order ids, seed id). */
  orderIds: string[];
  updatedAtMs: number;
  summary: string;
};

/** State file paths for one base (scalp/grid/trail convention: tmpdir). */
export function statePathsFor(base: string, dir?: string): Record<StateKind, string> {
  const d = dir ?? tmpdir();
  const b = base.toLowerCase();
  return {
    scalp: join(d, `scalp_${b}.json`),
    grid: join(d, `grid_${b}.json`),
    trail: join(d, `trail_${b}.json`),
  };
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function pairOf(st: Record<string, unknown>): string {
  const p = st.pair ?? st.symbol;
  return typeof p === "string" ? p : "";
}

function orderIdsOf(kind: StateKind, st: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (kind === "scalp") {
    const placed = st.placed;
    if (Array.isArray(placed)) {
      for (const p of placed) {
        if (p && typeof p === "object" && typeof (p as Record<string, unknown>).orderId === "string") {
          out.push((p as Record<string, unknown>).orderId as string);
        }
      }
    }
  }
  if (kind === "grid") {
    if (typeof st.seedOrderId === "string" && st.seedOrderId !== "?") out.push(st.seedOrderId);
    const placed = st.placed;
    if (Array.isArray(placed)) {
      for (const p of placed) {
        if (p && typeof p === "object" && typeof (p as Record<string, unknown>).orderId === "string") {
          out.push((p as Record<string, unknown>).orderId as string);
        }
      }
    }
  }
  return out.filter((s) => s && s !== "?");
}

function summaryOf(kind: StateKind, st: Record<string, unknown>): string {
  if (kind === "scalp") {
    const placed = Array.isArray(st.placed) ? st.placed.length : 0;
    return `${String(st.direction ?? "?")} ${String(st.pair ?? "?")} steps=${placed} tpArmed=${String(Boolean(st.tpArmed))}`;
  }
  if (kind === "grid") {
    const placed = Array.isArray(st.placed) ? st.placed.length : 0;
    return `${String(st.bias ?? "?")} ${String(st.pair ?? "?")} levels=${placed}`;
  }
  return `${String(st.side ?? "?")} ${String(st.pair ?? "?")} armed=${String(Boolean(st.armed))} closed=${String(Boolean(st.closed))}`;
}

/**
 * Best-effort read of this base's local states. Corrupt/unparseable files
 * are reported as strays (code `unreadable-state`) rather than silently
 * skipped — an unreadable state must never read as "nothing running".
 */
export function readLocalStates(base: string, dir?: string): { states: LocalState[]; unreadable: string[] } {
  const paths = statePathsFor(base, dir);
  const states: LocalState[] = [];
  const unreadable: string[] = [];
  (Object.keys(paths) as StateKind[]).forEach((kind) => {
    const path = paths[kind];
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      unreadable.push(path);
      return;
    }
    let st: unknown;
    try {
      st = JSON.parse(raw) as unknown;
    } catch {
      unreadable.push(path);
      return;
    }
    if (!st || typeof st !== "object") {
      unreadable.push(path);
      return;
    }
    const row = st as Record<string, unknown>;
    states.push({
      kind,
      path,
      pair: pairOf(row),
      orderIds: orderIdsOf(kind, row),
      updatedAtMs: mtimeOf(path),
      summary: summaryOf(kind, row),
    });
  });
  return { states, unreadable };
}

/* ------------------------------------------------------------------ */
/* venue row normalization (loose shapes — venue envelopes vary).       */
/* ------------------------------------------------------------------ */

export type VenueRow = Record<string, unknown>;

/** Pair out of a position/order row (pair, symbol, instrument, contract). */
export function rowPairOf(row: VenueRow): string {
  for (const k of ["pair", "symbol", "instrument", "contract", "symbolName"] as const) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

function canonPair(p: string): string {
  const s = p.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Futures venue symbols carry an `M` suffix (XBTUSDTM vs BTC/USDT) —
  // fold it so venue rows match --pair keys (same norm as the server's
  // fills/PnL filters). BTC is an alias of XBT venue-side — canonicalize
  // to BTC, never XBT.
  return s.replace(/USDTM$/, "USDT").replace(/^XBT/, "BTC");
}

/** True when a venue row belongs to `pair` (canonical key compare). */
export function rowMatchesPair(row: VenueRow, pair: string): boolean {
  const rp = rowPairOf(row);
  if (!rp) return true; // no pair evidence — the server scoped it; keep
  return canonPair(rp) === canonPair(pair);
}

/** True when a position row is actually open (non-zero size). */
export function isOpenPosition(row: VenueRow): boolean {
  for (const k of ["size", "qty", "quantity", "contracts", "currentQty", "positionAmt"] as const) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n !== 0;
    }
  }
  // No size field at all: a listed position row IS an open position.
  // (A closed position would not be listed — guessing flat here would
  // hide an unmanaged position, the exact stray this module hunts.)
  return true;
}

export type Stray = { level: "error" | "warn"; code: string; detail: string };

/**
 * Pure: local states × venue truth → stray list for `pair`.
 * `positions`/`orders` null = venue unchecked (no PAT) — reported as a
 * warn, never as clean.
 */
export function classifyStrays(args: {
  pair: string;
  local: LocalState[];
  unreadable: string[];
  positions: VenueRow[] | null;
  orders: VenueRow[] | null;
}): Stray[] {
  const strays: Stray[] = [];
  for (const u of args.unreadable) {
    strays.push({ level: "error", code: "unreadable-state", detail: `${u} exists but cannot be parsed — refusing to treat it as "nothing running"; inspect or remove it by hand` });
  }
  const ownedIds = new Set<string>();
  for (const s of args.local) for (const id of s.orderIds) ownedIds.add(id);
  if (args.positions === null || args.orders === null) {
    strays.push({
      level: "warn",
      code: "venue-unchecked",
      detail: "no venue read (no PAT) — local states listed but strays cannot be verified; re-run authenticated",
    });
    return strays;
  }
  const pairPositions = args.positions.filter((r) => isOpenPosition(r) && rowMatchesPair(r, args.pair));
  const pairOrders = args.orders.filter((r) => rowMatchesPair(r, args.pair));
  const hasLocal = args.local.length > 0;
  if (pairPositions.length > 0 && !hasLocal) {
    strays.push({
      level: "error",
      code: "unmanaged-position",
      detail: `${pairPositions.length} open position(s) for ${args.pair} with no local state (scalp/grid/trail) — nothing owns them; close or adopt before starting anything new`,
    });
  }
  const strayOrders = pairOrders.filter((r) => {
    const id = String(r.orderId ?? r.id ?? r.ordId ?? "");
    return !id || !ownedIds.has(id);
  });
  if (strayOrders.length > 0 && !hasLocal) {
    strays.push({
      level: "error",
      code: "stray-orders",
      detail: `${strayOrders.length} working order(s) for ${args.pair} with no owning state — cancel-all + verify before starting anything new`,
    });
  }
  if (pairPositions.length === 0 && pairOrders.length === 0 && hasLocal) {
    strays.push({
      level: "warn",
      code: "stale-state",
      detail: `${args.local.map((s) => s.kind).join(",")} state exists for ${args.pair} but the venue shows no position and no working orders — likely a leftover from a filled/killed run; clear it (scalp kill / cancel-all verify) before re-starting`,
    });
  }
  return strays;
}

/* ------------------------------------------------------------------ */
/* startup guards — `start` refuses when a previous run may own the    */
/* pair, so two supervisors can never double-fire or double-close.     */
/* ------------------------------------------------------------------ */

/** A trail state fresher than this may have a live supervisor behind it. */
export const TRAIL_SUPERVISOR_GRACE_MS = 15 * 60 * 1000;

export type StartupVerdict = { ok: true; notice?: string } | { ok: false; reason: string };

/**
 * Pure startup gate for `scalp start` / `grid start` / `trail`.
 * - scalp/grid: their own state file must be gone (kill/clear first).
 * - trail: a fresh unfinished state may have a live supervisor — refuse;
 *   a closed or stale state is superseded with a logged notice.
 */
export function startupGate(
  kind: StateKind,
  base: string,
  dir?: string,
  nowMs: number = Date.now(),
): StartupVerdict {
  const path = statePathsFor(base, dir)[kind];
  if (!existsSync(path)) return { ok: true };
  if (kind === "scalp") {
    return {
      ok: false,
      reason: `scalp state exists at ${path} — a previous run may own this pair. Run \`scalp kill --pair <PAIR>\` (or \`reconcile --pair <PAIR>\`) first; refusing to double-fire.`,
    };
  }
  if (kind === "grid") {
    return {
      ok: false,
      reason: `grid state exists at ${path} — a previous run may own this pair. Run \`cancel-all --pair <PAIR> --yes\`, verify flat, then remove the state; refusing to double-fire.`,
    };
  }
  // trail: closed runs are safe to supersede; fresh unfinished runs are not.
  let st: Record<string, unknown> | null = null;
  try {
    st = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `trail state at ${path} is unreadable — refusing to overwrite what cannot be read; inspect or remove it by hand.` };
  }
  const rawAge = nowMs - mtimeOf(path);
  // APFS mtime carries sub-ms precision from a different clock source than
  // Date.now() and can read ~1ms in the future — clamp tiny negative ages
  // to 0 so a just-written state always counts as fresh. Large negative
  // ages (clock weirdness) stay negative, which still counts as fresh
  // below: fail closed, never supersede what may be live.
  const ageMs = rawAge < 0 && rawAge > -2000 ? 0 : rawAge;
  const closed = st?.closed === true;
  if (!closed && ageMs < TRAIL_SUPERVISOR_GRACE_MS) {
    return {
      ok: false,
      reason: `trail state at ${path} is ${Math.round(ageMs / 1000)}s old and not closed — a supervisor may be live (concurrent trails double-close). Wait for it to finish or remove the state by hand; refusing to start a second.`,
    };
  }
  return { ok: true, notice: `superseding prior trail state at ${path} (${closed ? "closed" : "stale"}).` };
}
