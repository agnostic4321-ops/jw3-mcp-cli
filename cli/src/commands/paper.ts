/**
 * `jw3 paper` — local paper-trading accounts (NO venue contact, NO trades).
 *
 * Simulated perps book in `~/.config/jw3/paper-accounts.json`
 * (`JW3_CONFIG_HOME` override): named accounts with isolated cash,
 * positions, and fills; virtual TP/SL legs settled by `paper tick`;
 * maker/taker fees on every fill; freeform strategy tags; `paper promote`
 * renders the live ticket for a proven position WITHOUT sending it.
 *
 * SAFETY: this module never imports fund-moving paths (the trade ticket
 * builders/senders, the MCP transport) and never performs network IO.
 * Paper code paths cannot move money by construction — the guard test
 * `paper-guard.test.ts` greps these sources for the fund-moving tool
 * names and fails the suite if any appear.
 */
import {
  closePaperPosition,
  createPaperAccount,
  fundPaperAccount,
  getAccount,
  loadPaperStore,
  normalizePaperPair,
  openPaperPosition,
  paperStorePath,
  resetPaperAccount,
  savePaperStore,
  validateAccountName,
  validatePaperPair,
  validateStrategyTag,
  type PaperAccount,
  type PaperPosition,
  type PaperStore,
} from "../paper-store.js";
import {
  feeTierForFlag,
  grossPnlUsd,
  legsForMark,
  paperFeeUsd,
  summarizePaperAccount,
  unrealizedPnlUsd,
} from "../paper-marks.js";

export type PaperGlobal = { json: boolean; storePath?: string };

function storePathOf(opts: PaperGlobal): string {
  return opts.storePath ?? paperStorePath();
}

function load(path: string): PaperStore {
  return loadPaperStore(path);
}

function save(path: string, store: PaperStore): void {
  savePaperStore(path, store);
}

function err(msg: string): void {
  console.error(msg);
  process.exitCode = 2;
}

function fmtUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
}

function accountsIn(store: PaperStore, account?: string): PaperAccount[] {
  if (account) {
    const a = getAccount(store, account);
    return a ? [a] : [];
  }
  return Object.values(store.accounts).sort((x, y) => x.name.localeCompare(y.name));
}

/* ------------------------------------------------------------------ */
/* accounts                                                            */
/* ------------------------------------------------------------------ */

export async function cmdPaperCreate(
  opts: { name: string; equityUsd: number } & PaperGlobal,
): Promise<void> {
  const path = storePathOf(opts);
  const store = load(path);
  const nameErr = validateAccountName(opts.name);
  if (nameErr) return err(`Bad paper account: ${nameErr} — nothing was written.`);
  if (!Number.isFinite(opts.equityUsd) || opts.equityUsd <= 0) {
    return err(`Bad --equity: ${JSON.stringify(opts.equityUsd)} is not a usable number — nothing was written.`);
  }
  const bad = createPaperAccount(store, opts.name, opts.equityUsd);
  if (bad) return err(`Bad paper account: ${bad} — nothing was written.`);
  save(path, store);
  const acct = getAccount(store, opts.name) as PaperAccount;
  if (opts.json) console.log(JSON.stringify({ mode: "paper-create", account: acct.name, equityUsd: acct.initialEquityUsd, cashUsd: acct.cashUsd }));
  else console.log(`PAPER account ${acct.name} created with ${fmtUsd(acct.initialEquityUsd)} virtual equity (local only — no venue contact).`);
}

export async function cmdPaperFund(
  opts: { name: string; amountUsd: number } & PaperGlobal,
): Promise<void> {
  const path = storePathOf(opts);
  const store = load(path);
  if (!Number.isFinite(opts.amountUsd) || opts.amountUsd <= 0) {
    return err(`Bad --amount: ${JSON.stringify(opts.amountUsd)} is not a usable number — nothing was written.`);
  }
  const bad = fundPaperAccount(store, opts.name, opts.amountUsd);
  if (bad) return err(`Bad paper fund: ${bad} — nothing was written.`);
  save(path, store);
  const acct = getAccount(store, opts.name) as PaperAccount;
  if (opts.json) console.log(JSON.stringify({ mode: "paper-fund", account: acct.name, fundedUsd: opts.amountUsd, cashUsd: acct.cashUsd }));
  else console.log(`PAPER account ${acct.name} funded +${fmtUsd(opts.amountUsd)} virtual → cash ${fmtUsd(acct.cashUsd)} (local only).`);
}

export async function cmdPaperReset(opts: { name: string } & PaperGlobal): Promise<void> {
  const path = storePathOf(opts);
  const store = load(path);
  const bad = resetPaperAccount(store, opts.name);
  if (bad) return err(`Bad paper reset: ${bad} — nothing was written.`);
  save(path, store);
  const acct = getAccount(store, opts.name) as PaperAccount;
  if (opts.json) console.log(JSON.stringify({ mode: "paper-reset", account: acct.name, cashUsd: acct.cashUsd }));
  else console.log(`PAPER account ${acct.name} reset to ${fmtUsd(acct.cashUsd)} virtual (positions + fills cleared, local only).`);
}

export async function cmdPaperList(opts: PaperGlobal): Promise<void> {
  const store = load(storePathOf(opts));
  const rows = accountsIn(store);
  if (opts.json) {
    console.log(
      JSON.stringify({
        mode: "paper-list",
        accounts: rows.map((a) => summarizePaperAccount(a.name, a.cashUsd, a.realizedPnlUsd, a.totalFeesUsd, a.positions)),
      }),
    );
    return;
  }
  if (rows.length === 0) {
    console.log("No paper accounts — create one: jw3 paper create --account NAME [--equity 10000].");
    return;
  }
  for (const a of rows) {
    const s = summarizePaperAccount(a.name, a.cashUsd, a.realizedPnlUsd, a.totalFeesUsd, a.positions);
    console.log(
      `${s.account}  equity ${fmtUsd(s.equityUsd)}  cash ${fmtUsd(s.cashUsd)}  locked ${fmtUsd(s.lockedMarginUsd)}  realized ${fmtUsd(s.realizedPnlUsd)}  fees ${fmtUsd(s.totalFeesUsd)}  open ${s.openPositions}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* execute (simulated open)                                            */
/* ------------------------------------------------------------------ */

export type PaperExecuteOpts = {
  account: string;
  pair: string;
  side: string;
  qty?: number;
  sizeUsd?: number;
  price: number;
  leverage: number;
  tp?: number;
  sl?: number;
  fee?: string;
  strategy?: string;
} & PaperGlobal;

/** Pure: buy|sell → long|short. Null = reject. */
export function paperSideOf(orderSide: string): "long" | "short" | null {
  const s = orderSide.toLowerCase();
  if (s === "buy") return "long";
  if (s === "sell") return "short";
  return null;
}

export async function cmdPaperExecute(opts: PaperExecuteOpts): Promise<void> {
  const path = storePathOf(opts);
  const store = load(path);
  const acct = getAccount(store, opts.account);
  if (!acct) return err(`Bad paper execute: unknown account ${JSON.stringify(opts.account)} — create it first. Nothing was written.`);
  const pairErr = validatePaperPair(opts.pair);
  if (pairErr) return err(`Bad paper execute: ${pairErr} — nothing was written.`);
  const side = paperSideOf(opts.side);
  if (!side) return err(`Bad paper execute: side must be buy|sell — nothing was written.`);
  const hasQty = opts.qty !== undefined;
  const hasSize = opts.sizeUsd !== undefined;
  if (hasQty && hasSize) return err("Bad paper execute: pass --qty or --size-usd, not both — nothing was written.");
  if (!hasQty && !hasSize) return err("Bad paper execute: pass --qty (base units) or --size-usd (notional) — nothing was written.");
  if (hasQty && (!Number.isFinite(opts.qty as number) || (opts.qty as number) <= 0)) {
    return err(`Bad --qty: ${JSON.stringify(opts.qty)} is not a usable number — nothing was written.`);
  }
  if (hasSize && (!Number.isFinite(opts.sizeUsd as number) || (opts.sizeUsd as number) <= 0)) {
    return err(`Bad --size-usd: ${JSON.stringify(opts.sizeUsd)} is not a usable number — nothing was written.`);
  }
  if (!Number.isFinite(opts.price) || opts.price <= 0) {
    return err(`Bad --price: ${JSON.stringify(opts.price)} is not a usable number — nothing was written.`);
  }
  if (!Number.isFinite(opts.leverage) || opts.leverage < 1) {
    return err(`Bad --lev: ${JSON.stringify(opts.leverage)} is not a usable number — nothing was written.`);
  }
  const feeTier = feeTierForFlag(opts.fee);
  if (!feeTier) return err(`Bad --fee: ${JSON.stringify(opts.fee)} — want maker|taker. Nothing was written.`);
  const tagErr = validateStrategyTag(opts.strategy);
  if (tagErr) return err(`Bad --strategy: ${tagErr} — nothing was written.`);
  const qty = hasQty ? (opts.qty as number) : (opts.sizeUsd as number) / opts.price;
  const notional = qty * opts.price;
  const feeUsd = paperFeeUsd(notional, feeTier);
  const res = openPaperPosition(store, opts.account, {
    pair: opts.pair,
    side,
    qty,
    price: opts.price,
    leverage: opts.leverage,
    feeUsd,
    feeTier,
    ...(opts.tp !== undefined ? { tp: opts.tp } : {}),
    ...(opts.sl !== undefined ? { sl: opts.sl } : {}),
    ...(opts.strategy !== undefined ? { strategy: opts.strategy } : {}),
  });
  if (res.error || !res.position) return err(`Bad paper execute: ${res.error} — nothing was written.`);
  save(path, store);
  const p = res.position;
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-execute", account: opts.account, position: p, feeUsd }));
  } else {
    console.log(
      `PAPER OPEN ${p.id} ${p.side.toUpperCase()} ${p.qty} ${p.pair} @ ${p.entryPrice} x${p.leverage} [${feeTier} fee $${feeUsd.toFixed(2)}]` +
        `${p.tp != null ? ` tp ${p.tp}` : ""}${p.sl != null ? ` sl ${p.sl}` : ""}${p.strategy ? ` strategy ${p.strategy}` : ""} (simulated — no venue contact).`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* positions / fills / pnl (local reads)                               */
/* ------------------------------------------------------------------ */

export type PaperFilter = { account?: string; pair?: string; strategy?: string };

function matchPair(p: PaperPosition | { pair: string }, pair?: string): boolean {
  if (!pair) return true;
  return normalizePaperPair(p.pair) === normalizePaperPair(pair);
}

function matchStrategy(p: PaperPosition | { strategy: string | null }, strategy?: string): boolean {
  if (!strategy) return true;
  return (p.strategy ?? "") === strategy.trim().toLowerCase();
}

export async function cmdPaperPositions(
  opts: PaperFilter & { mark?: number } & PaperGlobal,
): Promise<void> {
  const store = load(storePathOf(opts));
  if (opts.pair) {
    const pairErr = validatePaperPair(opts.pair);
    if (pairErr) return err(`Bad paper positions: ${pairErr} — nothing was read.`);
  }
  if (opts.mark !== undefined && (!Number.isFinite(opts.mark) || opts.mark <= 0)) {
    return err(`Bad --mark: ${JSON.stringify(opts.mark)} is not a usable number — nothing was read.`);
  }
  const strategy = opts.strategy?.trim().toLowerCase();
  // --mark values every listed position; only meaningful with --pair.
  if (opts.mark !== undefined && !opts.pair) {
    return err("Bad paper positions: --mark needs --pair (one price, one pair) — nothing was read.");
  }
  const rows: { account: string; position: PaperPosition; unrealized: number | null }[] = [];
  for (const a of accountsIn(store, opts.account)) {
    for (const p of a.positions) {
      if (!matchPair(p, opts.pair) || !matchStrategy(p, strategy)) continue;
      rows.push({ account: a.name, position: p, unrealized: opts.mark !== undefined ? unrealizedPnlUsd(p, opts.mark) : null });
    }
  }
  if (opts.account && getAccount(store, opts.account) === null) {
    return err(`Bad paper positions: unknown account ${JSON.stringify(opts.account)} — nothing was read.`);
  }
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-positions", positions: rows }));
    return;
  }
  if (rows.length === 0) {
    console.log("No open paper positions match — empty is a real answer (nothing simulated yet).");
    return;
  }
  for (const r of rows) {
    const p = r.position;
    const u = r.unrealized == null ? "—" : fmtUsd(r.unrealized);
    console.log(
      `${r.account}  ${p.id}  ${p.side.toUpperCase()} ${p.qty} ${p.pair} @ ${p.entryPrice} x${p.leverage}  uPnL ${u}` +
        `${p.tp != null ? `  tp ${p.tp}` : ""}${p.sl != null ? `  sl ${p.sl}` : ""}${p.strategy ? `  [${p.strategy}]` : ""}`,
    );
  }
}

export async function cmdPaperFills(
  opts: PaperFilter & { limit?: number } & PaperGlobal,
): Promise<void> {
  const store = load(storePathOf(opts));
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return err(`Bad --limit: ${JSON.stringify(opts.limit)} — want an integer 1..500. Nothing was read.`);
  }
  if (opts.account && getAccount(store, opts.account) === null) {
    return err(`Bad paper fills: unknown account ${JSON.stringify(opts.account)} — nothing was read.`);
  }
  if (opts.pair) {
    const pairErr = validatePaperPair(opts.pair);
    if (pairErr) return err(`Bad paper fills: ${pairErr} — nothing was read.`);
  }
  const strategy = opts.strategy?.trim().toLowerCase();
  const rows: { account: string; fill: (typeof store.accounts[string])["fills"][number] }[] = [];
  for (const a of accountsIn(store, opts.account)) {
    for (const f of a.fills) {
      if (!matchPair(f, opts.pair) || !matchStrategy(f, strategy)) continue;
      rows.push({ account: a.name, fill: f });
    }
  }
  rows.sort((x, y) => (x.fill.ts < y.fill.ts ? 1 : x.fill.ts > y.fill.ts ? -1 : 0));
  const kept = rows.slice(0, limit);
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-fills", fills: kept }));
    return;
  }
  if (kept.length === 0) {
    console.log("No paper fills match — empty is a real answer (nothing simulated yet).");
    return;
  }
  for (const r of kept) {
    const f = r.fill;
    const pnl = f.pnlUsd == null ? "" : `  pnl ${fmtUsd(f.pnlUsd)}`;
    console.log(
      `${r.account}  ${f.ts}  ${f.kind.toUpperCase()} ${f.side.toUpperCase()} ${f.qty} ${f.pair} @ ${f.price}  fee $${f.feeUsd.toFixed(2)} [${f.feeTier}]${f.strategy ? `  [${f.strategy}]` : ""}${pnl}`,
    );
  }
}

export async function cmdPaperPnl(opts: { account?: string } & PaperGlobal): Promise<void> {
  const store = load(storePathOf(opts));
  const accts = accountsIn(store, opts.account);
  if (opts.account && accts.length === 0) {
    return err(`Bad paper pnl: unknown account ${JSON.stringify(opts.account)} — nothing was read.`);
  }
  const out = accts.map((a) => {
    const s = summarizePaperAccount(a.name, a.cashUsd, a.realizedPnlUsd, a.totalFeesUsd, a.positions);
    // Realized per strategy from closing fills (open legs carry no pnl).
    const byStrategy: Record<string, { realizedPnlUsd: number; fills: number }> = {};
    for (const f of a.fills) {
      if (f.kind === "open" || f.pnlUsd == null) continue;
      const k = f.strategy ?? "(untagged)";
      const row = byStrategy[k] ?? { realizedPnlUsd: 0, fills: 0 };
      row.realizedPnlUsd += f.pnlUsd;
      row.fills += 1;
      byStrategy[k] = row;
    }
    return { ...s, initialEquityUsd: a.initialEquityUsd, byStrategy };
  });
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-pnl", accounts: out }));
    return;
  }
  if (out.length === 0) {
    console.log("No paper accounts — create one: jw3 paper create --account NAME [--equity 10000].");
    return;
  }
  for (const s of out) {
    console.log(
      `${s.account}  equity ${fmtUsd(s.equityUsd)} (cash ${fmtUsd(s.cashUsd)} + locked ${fmtUsd(s.lockedMarginUsd)})  realized ${fmtUsd(s.realizedPnlUsd)}  fees ${fmtUsd(s.totalFeesUsd)}  open ${s.openPositions}`,
    );
    for (const [k, v] of Object.entries(s.byStrategy).sort()) {
      console.log(`    [${k}] realized ${fmtUsd(v.realizedPnlUsd)} across ${v.fills} close${v.fills === 1 ? "" : "s"}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* tick — settle virtual TP/SL legs at an explicit mark                */
/* ------------------------------------------------------------------ */

export async function cmdPaperTick(
  opts: { account?: string; pair: string; price: number; fee?: string } & PaperGlobal,
): Promise<void> {
  const path = storePathOf(opts);
  const store = load(path);
  const pairErr = validatePaperPair(opts.pair);
  if (pairErr) return err(`Bad paper tick: ${pairErr} — nothing was written.`);
  if (!Number.isFinite(opts.price) || opts.price <= 0) {
    return err(`Bad --price: ${JSON.stringify(opts.price)} is not a usable number — nothing was written.`);
  }
  const feeTier = feeTierForFlag(opts.fee);
  if (!feeTier) return err(`Bad --fee: ${JSON.stringify(opts.fee)} — want maker|taker. Nothing was written.`);
  const pair = normalizePaperPair(opts.pair);
  const accts = accountsIn(store, opts.account);
  if (opts.account && accts.length === 0) {
    return err(`Bad paper tick: unknown account ${JSON.stringify(opts.account)} — nothing was written.`);
  }
  const settled: { account: string; positionId: string; kind: string; fillPrice: number; pnlUsd: number }[] = [];
  for (const a of accts) {
    const open = a.positions.filter((p) => p.pair === pair);
    const legs = legsForMark(open, opts.price);
    for (const leg of legs) {
      const feeUsd = paperFeeUsd(leg.fillPrice * (open.find((p) => p.id === leg.positionId) as PaperPosition).qty, feeTier);
      const res = closePaperPosition(
        store,
        a.name,
        leg.positionId,
        { price: leg.fillPrice, feeUsd, feeTier, kind: leg.kind, note: `settled by paper tick @ ${opts.price}` },
        grossPnlUsd,
      );
      if (res.fill) settled.push({ account: a.name, positionId: leg.positionId, kind: leg.kind, fillPrice: leg.fillPrice, pnlUsd: res.fill.pnlUsd ?? 0 });
    }
  }
  // Persist only when something settled — a no-touch tick writes nothing.
  if (settled.length > 0) save(path, store);
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-tick", pair, mark: opts.price, settled }));
    return;
  }
  if (settled.length === 0) {
    console.log(`PAPER tick ${pair} @ ${opts.price} — no virtual legs touched (nothing written).`);
    return;
  }
  for (const s of settled) {
    console.log(`PAPER ${s.kind.toUpperCase()} ${s.account} ${s.positionId} ${pair} @ ${s.fillPrice}  pnl ${fmtUsd(s.pnlUsd)} (simulated — no venue contact).`);
  }
}

/* ------------------------------------------------------------------ */
/* promote — render the live ticket for a paper position, never send   */
/* ------------------------------------------------------------------ */

export type LiveTicket = {
  exchange: string;
  pair: string;
  side: "buy" | "sell";
  amount: number;
  market: "futures";
  leverage: number;
  stop?: number;
  tp?: number;
  strategy?: string;
};

/** Pure: paper position → live `jw3 execute` ticket args. Sending is the operator's explicit act. */
export function promoteTicket(pos: PaperPosition, exchange: string): { argv: string; toolArgs: LiveTicket } {
  const toolArgs: LiveTicket = {
    exchange,
    pair: pos.pair,
    side: pos.side === "long" ? "buy" : "sell",
    amount: pos.qty,
    market: "futures",
    leverage: pos.leverage,
    ...(pos.sl != null ? { stop: pos.sl } : {}),
    ...(pos.tp != null ? { tp: pos.tp } : {}),
    ...(pos.strategy ? { strategy: pos.strategy } : {}),
  };
  const argv =
    `jw3 execute --exchange ${exchange} --pair ${pos.pair} --side ${toolArgs.side}` +
    ` --amount ${pos.qty} --market futures --leverage ${pos.leverage}` +
    `${pos.sl != null ? ` --stop ${pos.sl}` : ""}${pos.tp != null ? ` --tp ${pos.tp}` : ""} --yes`;
  return { argv, toolArgs };
}

function findPromoteTargets(store: PaperStore, account: string, positionId?: string, pair?: string): { acct: PaperAccount; pos: PaperPosition }[] {
  const acct = getAccount(store, account);
  if (!acct) return [];
  let positions = acct.positions;
  if (positionId) positions = positions.filter((p) => p.id === positionId);
  if (pair) positions = positions.filter((p) => p.pair === normalizePaperPair(pair));
  return positions.map((pos) => ({ acct, pos }));
}

export async function cmdPaperPromote(
  opts: { account: string; positionId?: string; pair?: string; exchange?: string } & PaperGlobal,
): Promise<void> {
  const store = load(storePathOf(opts));
  const acct = getAccount(store, opts.account);
  if (!acct) return err(`Bad paper promote: unknown account ${JSON.stringify(opts.account)} — nothing was read.`);
  if (opts.pair) {
    const pairErr = validatePaperPair(opts.pair);
    if (pairErr) return err(`Bad paper promote: ${pairErr} — nothing was read.`);
  }
  const exchange = (opts.exchange ?? "kucoin").toLowerCase();
  if (!/^[a-z0-9]{2,16}$/.test(exchange)) {
    return err(`Bad --exchange: ${JSON.stringify(opts.exchange)} — nothing was read.`);
  }
  const targets = findPromoteTargets(store, opts.account, opts.positionId, opts.pair);
  if (targets.length === 0) {
    return err("Bad paper promote: no open paper position matches — nothing was read, nothing was sent.");
  }
  const tickets = targets.map(({ pos }) => ({ positionId: pos.id, ...promoteTicket(pos, exchange) }));
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper-promote", sent: false, tickets }));
    return;
  }
  console.log("PAPER PROMOTE — live ticket preview. NOT SENT. Review, then run the command yourself (real money).");
  for (const t of tickets) {
    console.log(`  position ${t.positionId} → ${t.argv}`);
  }
  console.log(`  (${tickets.length} ticket${tickets.length === 1 ? "" : "s"} rendered, 0 sent — paper never fires.)`);
}

/* ------------------------------------------------------------------ */
/* usage                                                               */
/* ------------------------------------------------------------------ */

export const PAPER_USAGE = `jw3 paper — local paper-trading accounts (no venue contact, no trades).

  jw3 paper create --account NAME [--equity 10000] [--json]
  jw3 paper fund --account NAME --amount 500 [--json]
  jw3 paper reset --account NAME [--json]
  jw3 paper list [--json]
  jw3 paper execute --account NAME --pair SOL/USDT --side buy|sell (--qty … | --size-usd …) --price … [--lev 1] [--tp …] [--sl …] [--fee maker|taker] [--strategy TAG] [--json]
  jw3 paper positions [--account NAME] [--pair …] [--strategy TAG] [--mark … (needs --pair)] [--json]
  jw3 paper fills [--account NAME] [--pair …] [--strategy TAG] [--limit 50] [--json]
  jw3 paper pnl [--account NAME] [--json]
  jw3 paper tick --pair SOL/USDT --price … [--account NAME] [--fee maker|taker] [--json]
  jw3 paper promote --account NAME [--position-id …] [--pair …] [--exchange kucoin] [--json]

Simulated fills settle locally; promote renders the live ticket without sending it.`;
