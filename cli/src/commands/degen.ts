/**
 * `jw3 degen` — the unified degen loop (DRY-RUN DEFAULT, no trades).
 *
 * One command for the whole aggressive-scalp doctrine:
 *   volatility-screen → oracle confirm → heat-cap governor →
 *   scalp-plan entry → step-2 averaging → trail entry → learning-log.
 *
 * Stages:
 *   1. Screen — futures tape per pair (`futuresFade`): only
 *      `fade-short` / `dip-long` exhaustion rows with measured ATR%
 *      pass. `--pair X` screens that pair; no pair = auto-screen the
 *      default watchlist and take the most exhausted row.
 *   2. Oracle — Kronos + Laya fan-out combined by the vote-calibrated
 *      ballot (weighting.ts `combineBallot`, the one `jw3 oracle` runs,
 *      weights from vote.json). `flat` = NO TRADE (never a
 *      smaller trade). RF-DETR abstains (no chart in the loop).
 *   3. Heat governor — owner-ordered 30%-risk math: $3 risk steps,
 *      halve size after one full stop, flat for the day after two,
 *      max 2 concurrent, $6 heat cap, 1h cooldown after a stop.
 *   4. Plan — `planScalp` derives TP/steps/kill from measured ATR%
 *      (2 steps: touch entry + step-2 averaging level, 1/1 sizes).
 *   5. Step-2 averaging — losers are averaged ONLY at the plan's
 *      step-2 level (resting limit, never blind-add), TP recalculated
 *      on the averaged entry. Thesis-break kill line still scratches
 *      the whole position.
 *   6. Trail entry — entry is protected by a ratcheting close-stop
 *      ticket (activation/bounceback). `--trail` runs the trail
 *      supervisor inline; otherwise the exact follow-up is printed.
 *   7. Learning-log — every run (preview AND live) appends one JSON
 *      line with the pre-entry window pointer + oracle + outcome
 *      (`pending` until `degen record` closes it). FINETUNE-READY at
 *      100/200 entries feeds the oracle dataset.
 *
 * Real money: NOTHING sends without --yes (dry run prints the full
 * ticket and sends zero bytes). `--yes` needs a PAT with the
 * trade:execute scope; the server re-checks YOLO/kill-switch/caps.
 * Success needs a guarded position: the fire arms a venue-native stop
 * (the plan kill line) together with the TP, or `--trail` runs the trail
 * supervisor inline as the guard. A TP-only arm never counts as success.
 *
 * Paper mode (`--paper`, see PAPER_MODE.md): the same screen → oracle →
 * heat → plan pipeline against the paper.ts ledger (the "degen" account
 * in paper-accounts.json — positions/fills, same heat doctrine), then a
 * paper position at plan prices with zero venue contact. The only network
 * write is `propose_trade` ([PAPER] Diary setup, propose scope — never
 * execute). `--paper` refuses `--yes`/`--live`/`--trail`: paper never fires.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../mcp.js";
import { liveSession, runLive, type DecisionOpts, type OrderDecision, type OrderTool } from "./live.js";
import { configDir, resolvePat } from "../config.js";
import {
  closePaperPosition,
  createPaperAccount,
  getAccount,
  loadPaperStore,
  openPaperPosition,
  paperStorePath,
  savePaperStore,
  type PaperAccount,
  type PaperFillKind,
  type PaperStore,
} from "../paper-store.js";
import { grossPnlUsd, paperFeeUsd } from "../paper-marks.js";
import {
  SPIKE_DEFAULT_SYMS,
  dipSignal,
  fadeSignal,
  futuresContractSpec,
  futuresFade,
  planScalp,
  type FadeRow,
  type ScalpPlan,
} from "../kucoin.js";
import { roundToTick, scalpContracts, contractsToAmountBaseUnits } from "./scalp.js";
import { buildMarketState, fetchLayaVerdict } from "./decide.js";
import { fetchKronosVerdict } from "./forecast.js";
import { fetchSessionCtx, type OracleSide, type OracleSignal } from "./oracle.js";
import { combineBallot, kronosToSignal, layaToSignal, oracleWeights, rfdetrOracleSignal } from "./weighting.js";
import {
  BOUNCE_REQUIRED_PCT,
  bounceOffLowPct,
  bounceRequiredVeto,
  type PrefilterCtx,
} from "../blocking-rules.js";
import { extractOpenOrders, makeIntentKey, ACTOR_MACHINE, type TradeCall } from "./trade.js";
import {
  checkHeat,
  degenHeatPath,
  degenToday,
  effectiveSize,
  loadHeat,
  saveHeat,
  DEGEN_COOLDOWN_MS,
  DEGEN_MAX_STOPS_PER_DAY,
  type DegenHeat,
  type HeatCaps,
} from "./heat.js";
import { normalizeVotePair, validateVotePair } from "./vote.js";
import { loadStore, voteStorePath } from "./track-store.js";
import { fail, needPat } from "./market.js";
import { cmdTrail } from "./trail.js";

export type DegenSide = "long" | "short";

export type DegenOracle = {
  side: OracleSide;
  score: number;
  detail: string;
};

export type DegenOutcome = "win" | "loss" | "stop" | "scratch";

/** Watchlist for auto-screen (the spike monitor's curated defaults). */
export const DEGEN_AUTO_BASES: string[] = SPIKE_DEFAULT_SYMS.map((s) =>
  s.replace(/USDTM$/, ""),
);
/** Owner-ordered risk doctrine (see skill lessons: 30%-risk math). */
export const DEGEN_FINETUNE_AT = [100, 200];
/** Trail follow-up defaults (same grid as `trail`). */
export const DEGEN_DEFAULT_POLLS = 600;
export const DEGEN_DEFAULT_LEVERAGE = 2;

export function degenLogPath(dir?: string): string {
  return join(dir ?? configDir(), "degen-learning.jsonl");
}

/**
 * Legacy paper paths (deprecated): read-only defaults for the one-time
 * migration shim. Nothing writes these paths after OQ-13 — the paper
 * ledger (paper-accounts.json) is the book.
 */
export function degenPaperHeatPath(dir?: string): string {
  return join(dir ?? configDir(), "degen-paper-heat.json");
}

export function degenPaperLogPath(dir?: string): string {
  return join(dir ?? configDir(), "degen-paper-learning.jsonl");
}

/** Run-state file (no-double-fire gate, scalp/trail convention). */
export function degenRunPath(base: string, dir?: string, paper = false): string {
  const stem = paper ? `degen_paper_${base.toLowerCase()}` : `degen_${base.toLowerCase()}`;
  return join(dir ?? tmpdir(), `${stem}.json`);
}

/**
 * Pure tape signals for one row (same classifiers `scan fade` ranks).
 */
export function rowSignals(row: FadeRow): { sSig: string; lSig: string } {
  return { sSig: fadeSignal(row), lSig: dipSignal(row) };
}

/**
 * Pure volatility screen: exhaustion rows with MEASURED volatility pass.
 * Direction is NOT decided here — the oracle confirms it. Null = reject
 * with the reason (thin tape, no exhaustion, unmeasured ATR).
 */
export function screenRow(row: FadeRow | null): string | null {
  if (!row || !(row.last > 0)) return "thin tape — no usable mark";
  if (!(Number.isFinite(row.atrPct) && (row.atrPct as number) > 0)) {
    return "unmeasured volatility (ATR%) — no numbers invented";
  }
  const { sSig, lSig } = rowSignals(row);
  if (sSig !== "fade-short" && lSig !== "dip-long") {
    return `no exhaustion (${sSig}/${lSig}) — standing by`;
  }
  return null;
}

/** Pure: size-weighted averaged entry over filled steps. Null when unusable. */
export function averagedEntry(fills: { price: number; sizeUsd: number }[]): number | null {
  const good = fills.filter((f) => f.price > 0 && f.sizeUsd > 0);
  if (good.length === 0) return null;
  const total = good.reduce((a, f) => a + f.sizeUsd, 0);
  if (!(total > 0)) return null;
  return good.reduce((a, f) => a + f.price * f.sizeUsd, 0) / total;
}

/** Pure: TP off an averaged entry at the plan's TP% (moving-TP target). */
export function averagedTpPrice(avgEntry: number, side: DegenSide, tpPct: number): number | null {
  if (!(avgEntry > 0) || !(tpPct > 0)) return null;
  return avgEntry * (1 + ((side === "long" ? 1 : -1) * tpPct) / 100);
}

/** SINGLE construction site for degen fire tickets (dry-run parity). */
export function degenExecuteArgs(o: {
  exchange: string;
  pair: string;
  side: DegenSide;
  contracts: number;
  price: number;
  leverage: number;
  /** Contract multiplier — one contract IS `multiplier` base units. */
  multiplier?: number;
  /** Explicit per-intent idempotency key (manual override; auto-derived when omitted). */
  idempotencyKey?: string;
  /** Explicit actor (machine strategy path; defaults to "machine"). */
  actor?: string;
}): Record<string, unknown> {
  const amount = String(contractsToAmountBaseUnits(o.contracts, o.multiplier ?? 1));
  const price = String(o.price);
  const side = o.side === "long" ? "buy" : "sell";
  return {
    exchange: o.exchange,
    pair: o.pair,
    side,
    // BASE units, not contracts. `execute_trade` divides by the contract
    // multiplier server-side; sending the contract count oversizes the
    // position by that multiplier (12 contracts on IRYS, mult 100, became
    // 1200 base units = 12 lots — a 100x oversize).
    amount,
    price,
    market: "futures",
    leverage: o.leverage,
    marginMode: "isolated",
    // Per-INTENT key (mirror live.ts): the same fire retried carries the
    // same key, so the server dedupes instead of double-filling. Derived
    // from the intent shape, never a timestamp.
    idempotency_key: o.idempotencyKey?.trim() ? o.idempotencyKey.trim() : makeIntentKey(
      "degen",
      [o.exchange, o.pair, side, amount, price, o.leverage].join("|"),
    ),
    // Machine strategy path (see ACTOR MAP in trade.ts).
    actor: o.actor?.trim() ? o.actor.trim() : ACTOR_MACHINE,
  };
}

/** SINGLE construction site for the degen exit arm (stop + TP, venue-native). */
export function degenExitsArgs(o: {
  exchange: string;
  pair: string;
  tpPrice: number;
  /** Venue-native stop (the plan kill line). Omit only for TP-only callers. */
  slPrice?: number;
}): Record<string, unknown> {
  return {
    exchange: o.exchange,
    pair: o.pair,
    tpPrice: o.tpPrice,
    ...(o.slPrice !== undefined ? { slPrice: o.slPrice } : {}),
    market: "futures",
  };
}

export type DegenArgs = {
  pair?: string;
  exchange: string;
  sizeUsd: number;
  leverage: number;
  maxHeatUsd: number;
  maxConcurrent: number;
  activationPct: number;
  bouncebackPct: number;
  polls: number;
  horizon: number;
  trail: boolean;
  live: boolean;
  paper: boolean;
};

/** Pure validation. Null = usable. */
export function validateDegenArgs(a: DegenArgs): string | null {
  if (a.pair) {
    const pairErr = validateVotePair(a.pair);
    if (pairErr) return pairErr;
  }
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!(a.sizeUsd > 0) || !Number.isFinite(a.sizeUsd)) return "size must be > 0 (USD per unit step)";
  if (!(a.leverage > 0) || !Number.isFinite(a.leverage)) return "lev must be > 0";
  if (!(a.maxHeatUsd > 0) || !Number.isFinite(a.maxHeatUsd)) return "max-heat must be > 0";
  if (!Number.isInteger(a.maxConcurrent) || a.maxConcurrent < 1 || a.maxConcurrent > 8) {
    return "max-concurrent must be an integer 1..8";
  }
  if (!(a.activationPct > 0) || !Number.isFinite(a.activationPct) || a.activationPct > 10) {
    return "activation-pct must be 0 < pct <= 10";
  }
  if (!(a.bouncebackPct > 0) || !Number.isFinite(a.bouncebackPct) || a.bouncebackPct > 10) {
    return "bounceback-pct must be 0 < pct <= 10";
  }
  if (!Number.isInteger(a.polls) || a.polls < 1 || a.polls > 3600) {
    return "--polls must be an integer 1..3600";
  }
  if (!Number.isInteger(a.horizon) || a.horizon < 1 || a.horizon > 120) {
    return "--horizon must be an integer 1..120";
  }
  if (a.paper && a.live) return "--paper is never live — drop --live (paper simulates, it never arms venue state)";
  if (a.paper && a.trail) return "--paper never trails — drop --trail (no venue position to guard)";
  return null;
}

export type DegenOracleFetcher = (pair: string) => Promise<DegenOracle>;

export type DegenDeps = {
  fade?: (base: string) => Promise<FadeRow>;
  oracle?: DegenOracleFetcher;
  spec?: (base: string) => Promise<{ multiplier: number; tick: number }>;
  call?: TradeCall;
  runTrail?: (ticket: {
    exchange: string;
    pair: string;
    side: DegenSide;
    size: number;
    activationPct: number;
    bouncebackPct: number;
    polls: number;
    live: boolean;
  }) => Promise<void>;
  heatPath?: string;
  logPath?: string;
  runDir?: string;
  storePath?: string;
  /** Paper ledger path (`paper-accounts.json`); the degen paper loop owns the "degen" account inside it. */
  paperPath?: string;
  now?: () => number;
  /** Session context for the short bounce gate (price + 60min session low). */
  sessionCtx?: (pair: string) => Promise<PrefilterCtx>;
  /** The production oracle's model fetchers (tests pin the real combine offline; defaults are the real fetchers). */
  kronos?: typeof fetchKronosVerdict;
  marketState?: typeof buildMarketState;
  laya?: typeof fetchLayaVerdict;
};

export type DegenRunOpts = {
  yes: boolean;
  json: boolean;
  url?: string;
  pat?: string;
};

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

/** Prod oracle: Kronos + Laya fan-out, vote-calibrated combine (read-only). */
async function prodOracle(
  pair: string,
  exchange: string,
  horizon: number,
  url: string | undefined,
  pat: string | undefined,
  storePath: string | undefined,
  deps: Pick<DegenDeps, "kronos" | "marketState" | "laya"> = {},
): Promise<DegenOracle> {
  // The one track store (vote.json) and the one weighting module: the
  // same ballot, mappings and weights `jw3 oracle` uses.
  const store = loadStore(storePath ?? voteStorePath());
  const weights = oracleWeights(store.weights);
  const [kSettled, lSettled] = await Promise.allSettled([
    (async () => {
      const k = kronosToSignal(await (deps.kronos ?? fetchKronosVerdict)(pair, horizon));
      return k.abstained ? null : k;
    })(),
    (async () => {
      const state = await (deps.marketState ?? buildMarketState)(pair, exchange, { url, pat });
      return layaToSignal(await (deps.laya ?? fetchLayaVerdict)(state));
    })(),
  ]);
  const signals: OracleSignal[] = [];
  if (kSettled.status === "fulfilled" && kSettled.value) {
    signals.push(kSettled.value);
  } else {
    signals.push({ skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: "kronos failed/abstained" });
  }
  if (lSettled.status === "fulfilled") {
    signals.push(lSettled.value);
  } else {
    signals.push({ skill: "laya", side: "flat", confidence: 0, abstained: true, detail: "laya failed" });
  }
  signals.push(rfdetrOracleSignal());
  const verdict = combineBallot(signals, weights, "model");
  return { side: verdict.side, score: verdict.score, detail: verdict.reason };
}

export type DegenTicket = {
  pair: string;
  base: string;
  side: DegenSide;
  sizeEff: number;
  plan: ScalpPlan;
  step1: { contracts: number; price: number; sizeUsd: number };
  step2: { contracts: number; price: number; sizeUsd: number };
  avg2: number;
  tp1Price: number;
  tp2Price: number;
  trail: { size: number; activationPct: number; bouncebackPct: number; polls: number; live: boolean };
};

/**
 * `jw3 degen` — run the unified loop once. Dry run (no --yes) prints the
 * full ticket and appends a `preview` learning line; NOTHING sends.
 */
export async function cmdDegen(
  a: DegenArgs,
  opts: DegenRunOpts,
  deps?: DegenDeps,
): Promise<void> {
  const argErr = validateDegenArgs(a);
  if (argErr) {
    console.error(`Bad ticket: ${argErr} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  if (a.paper && opts.yes) {
    console.error("Bad ticket: --paper never fires — drop --yes (paper records simulated fills, it never touches the venue) — nothing was called.");
    process.exitCode = 2;
    return;
  }
  const nowMs = deps?.now ? deps.now() : Date.now();
  // Paper mode rides the paper.ts ledger (OQ-13): legacy degen-paper files
  // are migrated once (then never written again) and the heat governor
  // derives from the degen paper account — proving never consumes live
  // heat or blocks live fire.
  let paper: { store: PaperStore; path: string } | null = null;
  if (a.paper) {
    const paperPath = deps?.paperPath ?? paperStorePath();
    const mig = migrateDegenPaperOnce({
      paperPath,
      heatPath: deps?.heatPath,
      logPath: deps?.logPath,
      runDir: deps?.runDir,
      nowMs,
    });
    if (mig.migrated && !opts.json) {
      console.log(
        `MIGRATED legacy paper book → ${paperPath}: ${mig.positions} open, ${mig.closed} closed, ${mig.skipped} skipped${mig.warnings.length > 0 ? ` (${mig.warnings.join("; ")})` : ""}.`,
      );
    }
    const store = loadPaperStore(paperPath);
    if (!ensureDegenPaperAccount(store, paperPath)) return;
    paper = { store, path: paperPath };
  }
  if (a.paper && !paper) return; // setup above either sets paper or returns
  const heatPath = deps?.heatPath ?? (a.paper ? degenPaperHeatPath() : degenHeatPath());
  // Paper mode no longer writes the learning log — the paper ledger is the book.
  const logPath: string | null = a.paper ? null : (deps?.logPath ?? degenLogPath());
  const heat = paper
    ? paperHeatOf(getAccount(paper.store, DEGEN_PAPER_ACCOUNT) as PaperAccount, nowMs)
    : loadHeat(heatPath, nowMs);
  const sizeEff = effectiveSize(a.sizeUsd, heat.stopsToday);
  const fade = deps?.fade ?? futuresFade;
  const oracleFetch = deps?.oracle ?? ((pair: string) => prodOracle(pair, a.exchange, a.horizon, opts.url, opts.pat, deps?.storePath, deps));

  // ── 1. volatility screen ──
  let row: FadeRow;
  let screened: string | null = null;
  if (a.pair) {
    const base = (normalizeVotePair(a.pair).split("/")[0] ?? "").toUpperCase();
    try {
      row = await fade(base);
    } catch (e) {
      fail(e);
      return;
    }
    screened = screenRow(row);
  } else {
    const settled = await Promise.allSettled(DEGEN_AUTO_BASES.map((b) => fade(b)));
    const cands = settled
      .flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      .filter((r) => screenRow(r) === null);
    if (cands.length === 0) {
      await noTrade(opts, logPath, heat, null, null, "auto-screen: no exhaustion setup on the watchlist — standing by");
      return;
    }
    cands.sort((x, y) => x.vratio - y.vratio || (y.atrPct ?? 0) - (x.atrPct ?? 0));
    row = cands[0] as FadeRow;
  }
  if (screened) {
    await noTrade(opts, logPath, heat, a.pair ?? row!.symbol, row!, `screen reject: ${screened}`);
    return;
  }

  const pair = a.pair ? normalizeVotePair(a.pair) : `${(row!.symbol.replace(/USDTM$/, ""))}/USDT`;

  // ── 2. oracle confirm (flat = no trade, never a smaller trade) ──
  let oracle: DegenOracle;
  try {
    oracle = await oracleFetch(pair);
  } catch (e) {
    fail(e);
    return;
  }
  if (oracle.side === "flat") {
    await noTrade(opts, logPath, heat, pair, row!, `oracle FLAT (score ${oracle.score.toFixed(2)}) — ${oracle.detail}`);
    return;
  }
  const side = oracle.side as DegenSide;

  // ── 2b. side-aware pre-filter: a SHORT needs a bounce off the session low ──
  // The owner doctrine is "short the failed bounce, never the hole" — the
  // oracle applies this (clampShortVerdict), but the degen LIVE path did
  // not, so a short could fire straight into the flush. Reuse the oracle's
  // own session-context fetch so both read the same legs.
  if (side === "short") {
    const ctx = await (deps?.sessionCtx ?? fetchSessionCtx)(pair).catch(() => ({}) as PrefilterCtx);
    if (bounceRequiredVeto("short", ctx.price, ctx.sessionLow)) {
      const b = bounceOffLowPct(ctx.price, ctx.sessionLow);
      const seen = b === null ? "unknown" : `${b.toFixed(2)}%`;
      await noTrade(
        opts, logPath, heat, pair, row!,
        `prefilter:bounce_required — short needs +${BOUNCE_REQUIRED_PCT}% off session low (at ${seen}): never short into the flush`,
        oracle,
      );
      return;
    }
  }

  // ── 3+4. heat governor over the ATR-derived plan ──
  const plan = planScalp(row!.last, row!.atrPct, side, sizeEff, 2);
  if (!plan) {
    console.error("Could not derive a plan from this tape — no numbers invented.");
    process.exitCode = 1;
    return;
  }
  const caps: HeatCaps = { maxHeatUsd: a.maxHeatUsd, maxConcurrent: a.maxConcurrent, cooldownMs: DEGEN_COOLDOWN_MS, maxStops: DEGEN_MAX_STOPS_PER_DAY };
  const heatBlock = checkHeat(heat, plan.killLossUsd, pair, nowMs, caps);
  if (heatBlock) {
    await noTrade(opts, logPath, heat, pair, row!, `governor STOP: ${heatBlock}`, oracle, plan);
    return;
  }

  // ── 5. step-2 averaging math ──
  const base = (pair.split("/")[0] ?? "").toUpperCase();
  const spec = await (deps?.spec ?? futuresContractSpec)(base).catch((e) => {
    fail(e);
    return null;
  });
  if (!spec) return;
  const [s1, s2] = plan.steps;
  if (!s1 || !s2) {
    console.error("Plan came back without two steps — refusing to fire half a ladder.");
    process.exitCode = 1;
    return;
  }
  const step1 = { contracts: scalpContracts(s1.sizeUsd, s1.price, spec.multiplier), price: roundToTick(s1.price, spec.tick), sizeUsd: s1.sizeUsd };
  const step2 = { contracts: scalpContracts(s2.sizeUsd, s2.price, spec.multiplier), price: roundToTick(s2.price, spec.tick), sizeUsd: s2.sizeUsd };
  const avg2 = averagedEntry([
    { price: step1.price, sizeUsd: step1.sizeUsd },
    { price: step2.price, sizeUsd: step2.sizeUsd },
  ]);
  const tp1Price = roundToTick(plan.steps[0]!.price * (1 + ((side === "long" ? 1 : -1) * plan.tpPct) / 100), spec.tick);
  const tp2Price = roundToTick((avg2 ?? plan.avgEntry) * (1 + ((side === "long" ? 1 : -1) * plan.tpPct) / 100), spec.tick);

  const ticket: DegenTicket = {
    pair, base, side, sizeEff, plan, step1, step2,
    avg2: avg2 ?? plan.avgEntry,
    tp1Price, tp2Price,
    trail: { size: step1.contracts, activationPct: a.activationPct, bouncebackPct: a.bouncebackPct, polls: a.polls, live: a.live },
  };

  // ── paper: simulated fills to the paper ledger, zero venue contact ──
  if (paper) {
    await runPaper(a, opts, deps ?? {}, { ticket, row: row!, oracle, heat, paper });
    return;
  }

  if (!opts.yes) {
    const finetune = appendLearning(logPath, learningEntry(a, ticket, row!, oracle, heat, "preview", "screen+oracle pass"));
    if (opts.json) {
      console.log(JSON.stringify({ mode: "preview", ticket, screen: row, oracle, heat, ...(finetune ? { finetune } : {}) }, null, 2));
    } else {
      printTicket(a, ticket, row!, oracle, heat, false);
      console.log("Dry run — nothing sent. Re-run with --yes to fire step-1 + stage step-2 + arm TP (real money).");
      if (finetune) console.log(`FINETUNE-READY: ${finetune} learning windows banked — re-score the oracle holdout.`);
    }
    return;
  }

  // ── 6. fire (real money) ──
  const pat = needPat(opts.pat);
  if (!pat) return;
  const call = deps?.call ?? callTool;
  const runPath = degenRunPath(base, deps?.runDir);
  if (existsSync(runPath)) {
    console.error(`degen state exists at ${runPath} — a previous run may own this pair. Record its outcome (\`degen record --pair ${pair} --outcome …\`) or remove the state by hand; refusing to double-fire.`);
    process.exitCode = 1;
    return;
  }
  try {
    const listed = await call("list_open_orders", { exchange: a.exchange, pair }, pat, opts.url);
    if (extractOpenOrders(listed).length > 0) {
      console.error(`Open orders on ${pair} — a stale TP/SL from a closed trade keeps working and will fill against the next position. Clear them (\`cancel-all --pair ${pair} --yes\`) first; refusing to fire.`);
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    fail(e);
    return;
  }

  const execSide = side === "long" ? "buy" : "sell";
  // OQ-12: degen PRODUCES decisions; runLive gates and sends each one
  // (one session: the server's risk limits are read once for the run).
  const orders: DecisionOpts = { pat, url: opts.url, call: deps?.call, session: liveSession() };
  const decide = (tool: OrderTool, args: Record<string, unknown>): OrderDecision => ({
    kind: "order",
    producer: "degen",
    tool,
    args,
    yes: opts.yes,
    paper: a.paper,
  });
  let failed = 0;
  let step1Id: string | null = null;
  let step2Id: string | null = null;
  try {
    const out1 = (await runLive(decide("execute_trade", degenExecuteArgs({ exchange: a.exchange, pair, side, contracts: step1.contracts, price: step1.price, leverage: a.leverage, multiplier: spec.multiplier })), orders)) as { orderId?: string };
    step1Id = String(out1.orderId ?? "?");
    if (!opts.json) console.log(`PLACED step-1: ${execSide.toUpperCase()} ${step1.contracts} @ ${px(step1.price)} → ${step1Id}`);
  } catch (e) {
    failed++;
    console.error(`STEP-1 FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (step1Id) {
    try {
      const out2 = (await runLive(decide("execute_trade", degenExecuteArgs({ exchange: a.exchange, pair, side, contracts: step2.contracts, price: step2.price, leverage: a.leverage, multiplier: spec.multiplier })), orders)) as { orderId?: string };
      step2Id = String(out2.orderId ?? "?");
      if (!opts.json) console.log(`STAGED step-2 (resting average level): ${execSide.toUpperCase()} ${step2.contracts} @ ${px(step2.price)} → ${step2Id}`);
    } catch (e) {
      failed++;
      console.error(`STEP-2 STAGE FAILED (step-1 is live WITHOUT its averaging level): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!step1Id) {
    console.error("No entry placed — TP not armed, no state written.");
    process.exitCode = 1;
    return;
  }
  let tpArmed = false;
  let stopArmed = false;
  try {
    // Venue-native stop + TP in one arm: the stop is the plan kill line,
    // so a filled entry is protected even when nobody watches the tape.
    await runLive(decide("set_exits", degenExitsArgs({ exchange: a.exchange, pair, tpPrice: tp1Price, slPrice: plan.killPrice })), orders);
    tpArmed = true;
    stopArmed = true;
    if (!opts.json) console.log(`TP ARMED @ ${px(tp1Price)} (step-1 TP; move to averaged ${px(tp2Price)} via exits once step-2 fills) + STOP ARMED @ kill ${px(plan.killPrice)}`);
  } catch (e) {
    // The combined arm failed: fall back to the TP-only arm (the old
    // doctrine) so the take-profit is not lost with the stop. A TP-only
    // arm is NOT a success on its own (see the gate below).
    console.error(`Stop+TP arm failed, falling back to TP-only: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await runLive(decide("set_exits", degenExitsArgs({ exchange: a.exchange, pair, tpPrice: tp1Price })), orders);
      tpArmed = true;
      if (!opts.json) console.log(`TP ARMED @ ${px(tp1Price)} (step-1 TP; move to averaged ${px(tp2Price)} via exits once step-2 fills)`);
    } catch (e2) {
      console.error(`TP arm failed: entry is live WITHOUT a take-profit: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }
  if (!stopArmed && !a.trail) {
    // No venue-native stop and no inline trail guard: the entry is live
    // without automatic protection. Report it honestly instead of as a
    // success with a TP-only arm.
    console.error(`NO-STOP: entry is live WITHOUT a venue-native stop (kill ${px(plan.killPrice)}) and no --trail guard runs inline. Refusing to report success. Arm the stop by hand or re-run with --trail.`);
  }
  const runState = {
    kind: "degen", exchange: a.exchange, pair, base, side, leverage: a.leverage,
    step1: { ...step1, orderId: step1Id }, step2: { ...step2, orderId: step2Id },
    avg2: ticket.avg2, tp1Price, tp2Price, tpArmed, stopArmed,
    killPrice: plan.killPrice, killLossUsd: plan.killLossUsd,
    trail: ticket.trail, createdAt: new Date(nowMs).toISOString(),
  };
  try {
    mkdirSync(runPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(runPath, JSON.stringify(runState, null, 2));
  } catch {
    // State is a convenience trail — the venue truth already fired.
  }
  heat.open.push({ pair, riskUsd: plan.killLossUsd });
  heat.heatUsd += plan.killLossUsd;
  saveHeat(heatPath, heat);
  const finetune = appendLearning(logPath, learningEntry(a, ticket, row!, oracle, heat, "live", "fired"));
  if (opts.json) {
    console.log(JSON.stringify({
      mode: "fired", ticket, pair, side,
      step1Id, step2Id, failed, tpArmed, stopArmed, trail: a.trail,
      tp1Price, tp2Price, killPrice: plan.killPrice, killLossUsd: plan.killLossUsd,
      heat, ...(finetune ? { finetune } : {}),
    }, null, 2));
  } else {
    printTicket(a, ticket, row!, oracle, heat, true);
  }
  if (a.trail) {
    const runTrail = deps?.runTrail ?? (async (t) => {
      await cmdTrail(
        { exchange: t.exchange, pair: t.pair, side: t.side, size: t.size, activationPct: t.activationPct, bouncebackPct: t.bouncebackPct, polls: t.polls, live: t.live },
        { yes: true, json: opts.json, url: opts.url, pat: opts.pat },
      );
    });
    await runTrail({ exchange: a.exchange, pair, side, size: step1.contracts, activationPct: a.activationPct, bouncebackPct: a.bouncebackPct, polls: a.polls, live: a.live });
  } else if (!opts.json) {
    console.log(`Trail guard: jw3 trail --pair ${pair} --side ${side} --size ${step1.contracts} --exchange ${a.exchange} --activation-pct ${a.activationPct} --bounceback-pct ${a.bouncebackPct} --polls ${a.polls}${a.live ? " --live" : ""} --yes`);
  }
  if (!opts.json) {
    console.log(`Kill line ${px(plan.killPrice)} (≈ -$${plan.killLossUsd.toFixed(2)}) — thesis break scratches everything; close the loop with \`degen record --pair ${pair} --outcome win|loss|stop|scratch\`.`);
    if (finetune) console.log(`FINETUNE-READY: ${finetune} learning windows banked — re-score the oracle holdout.`);
  }
  // Success needs a guarded position: a venue-native stop, or the trail
  // supervisor running inline. A TP-only arm never counts.
  if (failed > 0 || !tpArmed || (!stopArmed && !a.trail)) process.exitCode = 1;
}

/**
 * Paper ledger ownership (OQ-13): the degen paper loop owns the "degen"
 * account inside paper-accounts.json (paper.ts accounts/positions/fills).
 * Fills carry strategy "degen" so `paper-stats` scores only this loop's
 * book even if the operator reuses the account by hand.
 */
export const DEGEN_PAPER_ACCOUNT = "degen";
export const DEGEN_PAPER_STRATEGY = "degen";
/** Equity of a freshly auto-created degen paper account (fake money). */
export const DEGEN_PAPER_DEFAULT_EQUITY_USD = 1000;

/** Ensure the degen paper account exists (creates + persists it). False = usage error, already reported. */
export function ensureDegenPaperAccount(store: PaperStore, paperPath: string): boolean {
  if (getAccount(store, DEGEN_PAPER_ACCOUNT)) return true;
  const bad = createPaperAccount(store, DEGEN_PAPER_ACCOUNT, DEGEN_PAPER_DEFAULT_EQUITY_USD);
  if (bad) {
    console.error(`Bad paper ledger: ${bad} — nothing was written.`);
    process.exitCode = 1;
    return false;
  }
  try {
    savePaperStore(paperPath, store);
  } catch (e) {
    console.error(`Could not persist the paper ledger: ${e instanceof Error ? e.message : String(e)} — nothing was written.`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Pure: kill-line risk of one open paper position (entry → paper stop).
 * A position without a paper stop risks nothing on paper — the stop is
 * always armed by the degen loop, so a missing sl reads as zero risk,
 * never as unbounded.
 */
export function paperPositionRiskUsd(p: {
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  sl: number | null;
}): number {
  if (!(p.entryPrice > 0) || !(p.qty > 0)) return 0;
  const stop = typeof p.sl === "number" && Number.isFinite(p.sl) && p.sl > 0 ? p.sl : p.entryPrice;
  const perUnit = p.side === "long" ? p.entryPrice - stop : stop - p.entryPrice;
  return Math.max(0, perUnit * p.qty);
}

/**
 * Pure: derive the degen heat-cap state from the degen paper account
 * (OQ-13 + OQ-14). Proving never consumes live heat: stops count the
 * day's sl fills (a loss recorded with negative pnl counts too — same
 * halve-then-flat doctrine as the file book), open risk sums the paper
 * stops, and the cooldown keys off the latest stop fill.
 */
export function paperHeatOf(acct: PaperAccount, nowMs: number): DegenHeat {
  const day = degenToday(nowMs);
  const mine = (strategy: string | null): boolean => (strategy ?? "") === DEGEN_PAPER_STRATEGY;
  const open = acct.positions
    .filter((p) => mine(p.strategy))
    .map((p) => ({ pair: p.pair, riskUsd: paperPositionRiskUsd(p) }));
  const heatUsd = open.reduce((a, o) => a + o.riskUsd, 0);
  const dayStart = `${day}T00:00:00.000Z`;
  const stops = acct.fills.filter(
    (f) =>
      mine(f.strategy) &&
      (f.kind === "sl" || (f.kind === "close" && (f.pnlUsd ?? 0) < 0)) &&
      typeof f.ts === "string" &&
      f.ts >= dayStart,
  );
  const lastStopAt = stops.map((f) => f.ts).sort().pop() ?? null;
  return { day, stopsToday: stops.length, heatUsd, open, lastStopAt };
}

export type PaperMigration = {
  migrated: boolean;
  positions: number;
  closed: number;
  skipped: number;
  renamed: string[];
  warnings: string[];
};

/**
 * One-time read-and-migrate shim (OQ-13): imports the legacy degen-paper
 * book (degen-paper-heat.json + degen_paper_*.json run states + the paper
 * learning log) into the degen paper account, then renames the legacy
 * files with a `.migrated` suffix so the shim never runs twice. Nothing
 * writes the legacy paths after this — the paper ledger is the book.
 *
 * Fidelity: run states carry full tickets (pair/side/prices/leverage) and
 * become paper positions; `record` log lines matched to an open position
 * close it (exit derived from the recorded pnl, or the entry when no pnl
 * was recorded). Anything without a reconstructable position (heat-only
 * opens, orphan outcomes) is counted in `skipped` and reported — never
 * silently dropped.
 */
export function migrateDegenPaperOnce(opts: {
  paperPath: string;
  heatPath?: string;
  logPath?: string;
  runDir?: string;
  nowMs?: number;
}): PaperMigration {
  const empty: PaperMigration = { migrated: false, positions: 0, closed: 0, skipped: 0, renamed: [], warnings: [] };
  const heatPath = opts.heatPath ?? degenPaperHeatPath();
  const logPath = opts.logPath ?? degenPaperLogPath();
  const runDir = opts.runDir ?? tmpdir();
  const haveHeat = existsSync(heatPath);
  const haveLog = existsSync(logPath);
  let runFiles: string[] = [];
  try {
    runFiles = readdirSync(runDir)
      .filter((f) => f.startsWith("degen_paper_") && f.endsWith(".json"))
      .map((f) => join(runDir, f));
  } catch {
    runFiles = [];
  }
  if (!haveHeat && !haveLog && runFiles.length === 0) return empty;
  const nowMs = opts.nowMs ?? Date.now();

  // Legacy heat: tolerant read (same sanitizer as the live book had).
  let legacyHeat: DegenHeat | null = null;
  if (haveHeat) {
    try {
      legacyHeat = loadHeat(heatPath, nowMs);
    } catch {
      legacyHeat = null;
    }
  }

  // Legacy run states: one open position per reconstructable ticket.
  type LegacyRun = {
    pair: string;
    side: "long" | "short";
    leverage: number;
    step1: { price: number; sizeUsd: number };
    tp1Price?: number;
    killPrice?: number;
  };
  const runs: { file: string; run: LegacyRun }[] = [];
  for (const file of runFiles) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object" || doc.kind !== "degen-paper") continue;
    const s1 = doc.step1 as Record<string, unknown> | undefined;
    const pair = typeof doc.pair === "string" ? doc.pair : "";
    const side = doc.side === "long" || doc.side === "short" ? doc.side : null;
    const price = typeof s1?.price === "number" ? s1.price : NaN;
    const sizeUsd = typeof s1?.sizeUsd === "number" ? s1.sizeUsd : NaN;
    const leverage = typeof doc.leverage === "number" ? doc.leverage : NaN;
    if (!pair.includes("/") || !side || !(price > 0) || !(sizeUsd > 0) || !(leverage >= 1)) continue;
    const tp = typeof doc.tp1Price === "number" && Number.isFinite(doc.tp1Price) ? (doc.tp1Price as number) : undefined;
    const kill = typeof doc.killPrice === "number" && Number.isFinite(doc.killPrice) ? (doc.killPrice as number) : undefined;
    runs.push({ file, run: { pair, side, leverage, step1: { price, sizeUsd }, ...(tp !== undefined ? { tp1Price: tp } : {}), ...(kill !== undefined ? { killPrice: kill } : {}) } });
  }

  // Legacy `record` lines (paper:true) with an optional recorded pnl.
  type LegacyOutcome = { pair: string; outcome: DegenOutcome; pnlUsd?: number; at: string };
  const outcomes: LegacyOutcome[] = [];
  if (haveLog) {
    let text = "";
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      text = "";
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e.mode !== "record" || e.paper !== true) continue;
      const outcome = typeof e.outcome === "string" ? e.outcome.toLowerCase() : "";
      if (outcome !== "win" && outcome !== "loss" && outcome !== "stop" && outcome !== "scratch") continue;
      if (typeof e.pair !== "string" || !e.pair.includes("/")) continue;
      const pnl = typeof e.pnlUsd === "number" && Number.isFinite(e.pnlUsd) ? (e.pnlUsd as number) : undefined;
      outcomes.push({
        pair: e.pair as string,
        outcome: outcome as DegenOutcome,
        ...(pnl !== undefined ? { pnlUsd: pnl } : {}),
        at: typeof e.at === "string" ? (e.at as string) : new Date(nowMs).toISOString(),
      });
    }
  }

  if (!legacyHeat && runs.length === 0 && outcomes.length === 0) return empty;

  const out: PaperMigration = { migrated: true, positions: 0, closed: 0, skipped: 0, renamed: [], warnings: [] };
  const store = loadPaperStore(opts.paperPath);
  if (!ensureDegenPaperAccount(store, opts.paperPath)) {
    out.warnings.push("paper account unavailable — migration aborted");
    return out;
  }
  const openFor = (pair: string) =>
    (getAccount(store, DEGEN_PAPER_ACCOUNT)?.positions ?? []).find(
      (p) => (p.strategy ?? "") === DEGEN_PAPER_STRATEGY && p.pair.toUpperCase() === pair.toUpperCase(),
    );

  for (const { run } of runs) {
    if (openFor(run.pair)) {
      out.skipped += 1;
      out.warnings.push(`${run.pair} already tracked in the paper ledger — legacy run state ignored`);
      continue;
    }
    const qty = run.step1.sizeUsd / run.step1.price;
    const res = openPaperPosition(store, DEGEN_PAPER_ACCOUNT, {
      pair: run.pair,
      side: run.side,
      qty,
      price: run.step1.price,
      leverage: run.leverage,
      feeUsd: 0,
      feeTier: "taker",
      ...(run.tp1Price !== undefined ? { tp: run.tp1Price } : {}),
      ...(run.killPrice !== undefined ? { sl: run.killPrice } : {}),
      strategy: DEGEN_PAPER_STRATEGY,
    });
    if (res.error || !res.position) {
      out.skipped += 1;
      out.warnings.push(`${run.pair} not imported: ${res.error ?? "unknown"}`);
      continue;
    }
    out.positions += 1;
  }

  for (const o of outcomes) {
    const pos = openFor(o.pair);
    if (!pos) {
      out.skipped += 1;
      out.warnings.push(`${o.outcome} on ${o.pair} has no open paper position — already recorded, not re-imported`);
      continue;
    }
    // Exit derived from the recorded net pnl (fee-free closes); without a
    // recorded pnl the position closes at its entry (scratch economics).
    const res = closePaperPosition(store, DEGEN_PAPER_ACCOUNT, pos.id, {
      price: paperExitForRecord(pos, o.pnlUsd),
      feeUsd: 0,
      feeTier: "taker",
      kind: paperKindForRecord(o.outcome),
      note: `migrated ${o.outcome}${o.pnlUsd !== undefined ? ` pnl ${o.pnlUsd}` : ""}`,
    }, grossPnlUsd);
    if (res.error || !res.fill) {
      out.skipped += 1;
      out.warnings.push(`${o.outcome} on ${o.pair} not closed: ${res.error ?? "unknown"}`);
      continue;
    }
    out.closed += 1;
  }

  // Heat-only opens (no run state behind them) have no fills to import.
  if (legacyHeat) {
    for (const o of legacyHeat.open) {
      if (!openFor(o.pair) && !runs.some((r) => r.run.pair.toUpperCase() === o.pair.toUpperCase())) {
        out.skipped += 1;
        out.warnings.push(`${o.pair} was open in the legacy paper heat with no ticket behind it — not imported`);
      }
    }
  }

  savePaperStore(opts.paperPath, store);

  // The legacy paths leave the write path: rename (never delete) so the
  // shim stays one-time without destroying anything the import skipped.
  const renameOne = (path: string): void => {
    try {
      renameSync(path, `${path}.migrated`);
      out.renamed.push(path);
    } catch {
      out.warnings.push(`could not rename ${path} — remove it by hand or the next paper run migrates it again`);
    }
  };
  if (haveHeat) renameOne(heatPath);
  if (haveLog) renameOne(logPath);
  for (const { file } of runs) renameOne(file);
  return out;
}

/**
 * Pure: the Diary setup args a paper fill records. Propose scope only —
 * entry/stop/size/thesis, never an execution ticket.
 */
export function paperProposeArgs(
  a: DegenArgs,
  t: DegenTicket,
  fills: { step1Id: string; step2Id: string },
): Record<string, unknown> {
  const execSide = t.side === "long" ? "BUY" : "SELL";
  return {
    pair: t.pair,
    side: t.side,
    entry: t.step1.price,
    stop: t.plan.killPrice,
    asset: t.base,
    venue: a.exchange,
    size_usd: t.step1.sizeUsd + t.step2.sizeUsd,
    timeframe: "paper",
    thesis:
      `[PAPER] degen ${t.side.toUpperCase()} ${t.pair} x${a.leverage} isolated (${a.exchange}). ` +
      `${execSide} ${t.step1.contracts} @ ${t.step1.price} [${fills.step1Id}], ` +
      `avg-level ${t.step2.contracts} @ ${t.step2.price} [${fills.step2Id}], ` +
      `TP ${t.tp1Price} → averaged ${t.tp2Price}, kill ${t.plan.killPrice} (≈ -$${t.plan.killLossUsd.toFixed(2)}). ` +
      `Simulated fills — no venue contact, no real money.`,
  };
}

/**
 * Paper fill: same ticket the live loop would fire, recorded as a paper
 * position (paper.ts accounts/positions/fills) at plan prices. Zero venue
 * contact — no list_open_orders, no execute_trade, no set_exits. The only
 * network write is `propose_trade` (Diary visibility, propose scope); the
 * paper ledger is the backtest source of truth and a diary failure warns
 * without losing the fill.
 */
async function runPaper(
  a: DegenArgs,
  opts: DegenRunOpts,
  deps: DegenDeps,
  ctx: {
    ticket: DegenTicket;
    row: FadeRow;
    oracle: DegenOracle;
    heat: DegenHeat;
    paper: { store: PaperStore; path: string };
  },
): Promise<void> {
  const { ticket, row, oracle, heat, paper } = ctx;
  const acct = getAccount(paper.store, DEGEN_PAPER_ACCOUNT);
  if (!acct) {
    console.error(`No ${JSON.stringify(DEGEN_PAPER_ACCOUNT)} paper account — refusing to invent one mid-run. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  if (acct.positions.some((p) => (p.strategy ?? "") === DEGEN_PAPER_STRATEGY && p.pair.toUpperCase() === ticket.pair.toUpperCase())) {
    console.error(`degen paper position already open for ${ticket.pair} — record its outcome (\`degen record --paper --pair ${ticket.pair} --outcome …\`) or close it by hand; refusing to double-fire.`);
    process.exitCode = 1;
    return;
  }
  const qty = ticket.step1.sizeUsd / ticket.step1.price;
  const feeUsd = paperFeeUsd(ticket.step1.sizeUsd, "taker");
  const opened = openPaperPosition(paper.store, DEGEN_PAPER_ACCOUNT, {
    pair: ticket.pair,
    side: ticket.side,
    qty,
    price: ticket.step1.price,
    leverage: a.leverage,
    feeUsd,
    feeTier: "taker",
    tp: ticket.tp1Price,
    sl: ticket.plan.killPrice,
    strategy: DEGEN_PAPER_STRATEGY,
  });
  if (opened.error || !opened.position) {
    console.error(`Paper fill refused: ${opened.error ?? "unknown"} — nothing was written.`);
    process.exitCode = 1;
    return;
  }
  const position = opened.position;
  const openFill = paper.store.accounts[DEGEN_PAPER_ACCOUNT]?.fills.filter(
    (f) => f.positionId === position.id && f.kind === "open",
  ).pop();
  const fills = { step1Id: openFill?.id ?? position.id, step2Id: position.id };
  const call = deps.call ?? callTool;
  let setupId: string | null = null;
  let diarySkipped: string | null = null;
  const pat = resolvePat(opts.pat);
  if (!pat) {
    diarySkipped = "no PAT — paper kept locally (log in to also mirror it to the Diary)";
  } else {
    try {
      const out = (await call("propose_trade", paperProposeArgs(a, ticket, fills), pat, opts.url)) as {
        setup_id?: unknown;
      };
      setupId = typeof out?.setup_id === "string" ? out.setup_id : "?";
    } catch (e) {
      diarySkipped = `diary write failed (${e instanceof Error ? e.message : String(e)}) — paper kept locally`;
    }
  }
  try {
    savePaperStore(paper.path, paper.store);
  } catch (e) {
    console.error(`Could not persist the paper ledger: ${e instanceof Error ? e.message : String(e)} — the fill above is in memory only.`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper", ticket, screen: row, oracle, heat, fills, account: DEGEN_PAPER_ACCOUNT, position, diary: { setupId, skipped: diarySkipped } }, null, 2));
  } else {
  printTicket(a, ticket, row, oracle, heat, false);
  console.log(`  paper fills: step-1 [${fills.step1Id}] position [${position.id}] TP ${px(ticket.tp1Price)} (virtual, TP-only doctrine)`);
  if (setupId) console.log(`  diary: PAPER setup ${setupId} (propose scope — approve nothing, it never executes)`);
  else console.log(`  diary: ${diarySkipped}`);
    console.log("PAPER — simulated fills, zero venue contact. Nothing can execute from this ticket.");
  }
  if (!opts.json) {
  console.log(`Kill line ${px(ticket.plan.killPrice)} (≈ -$${ticket.plan.killLossUsd.toFixed(2)}) — close the loop with \`degen record --paper --pair ${ticket.pair} --outcome win|loss|stop|scratch [--pnl …]\`.`);
  }
}

function learningEntry(
  a: DegenArgs,
  ticket: DegenTicket,
  row: FadeRow,
  oracle: DegenOracle,
  heat: DegenHeat,
  mode: "preview" | "live",
  reason: string,
): Record<string, unknown> {
  const { sSig, lSig } = rowSignals(row);
  return {
    at: new Date().toISOString(),
    pair: ticket.pair,
    side: ticket.side,
    mode,
    exchange: a.exchange,
    last: row.last,
    atrPct: row.atrPct,
    vratio: row.vratio,
    sSig,
    lSig,
    oracle: { side: oracle.side, score: oracle.score, detail: oracle.detail },
    plan: {
      tpPct: ticket.plan.tpPct,
      stepDropPct: ticket.plan.stepDropPct,
      steps: ticket.plan.steps,
      avgEntry: ticket.plan.avgEntry,
      tpPrice: ticket.plan.tpPrice,
      killPrice: ticket.plan.killPrice,
      killLossUsd: ticket.plan.killLossUsd,
      maxCapitalUsd: ticket.plan.maxCapitalUsd,
    },
    sizeEff: ticket.sizeEff,
    step2: ticket.step2,
    averaged: { avg2: ticket.avg2, tp2Price: ticket.tp2Price },
    heat: { stopsToday: heat.stopsToday, heatUsd: heat.heatUsd, open: heat.open.map((o) => o.pair) },
    outcome: "pending",
    reason,
  };
}

/** Append one learning line; returns the banked total when a threshold hits. Null path = no book (paper mode rides the paper ledger). */
export function appendLearning(logPath: string | null, entry: Record<string, unknown>): number | null {
  if (!logPath) return null;
  try {
    mkdirSync(logPath.split("/").slice(0, -1).join("/") || ".", { recursive: true, mode: 0o700 });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const total = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "").length;
    return (DEGEN_FINETUNE_AT as number[]).includes(total) ? total : null;
  } catch {
    return null;
  }
}

async function noTrade(
  opts: DegenRunOpts,
  logPath: string | null,
  heat: DegenHeat,
  pair: string | null,
  row: FadeRow | null,
  reason: string,
  oracle?: DegenOracle,
  plan?: ScalpPlan,
): Promise<void> {
  try {
    appendLearning(logPath, {
      at: new Date().toISOString(), pair, side: oracle?.side ?? "flat", mode: "preview",
      screen: row ? { last: row.last, atrPct: row.atrPct, vratio: row.vratio, ...rowSignals(row) } : null,
      oracle: oracle ? { side: oracle.side, score: oracle.score, detail: oracle.detail } : null,
      plan: plan ? { tpPct: plan.tpPct, killLossUsd: plan.killLossUsd, maxCapitalUsd: plan.maxCapitalUsd } : null,
      outcome: "no-trade", reason,
    });
  } catch {
    // Learning log is best-effort — a no-trade is never an error.
  }
  if (opts.json) {
    console.log(JSON.stringify({ mode: "no-trade", pair, reason, oracle: oracle ?? null }, null, 2));
    return;
  }
  console.log(`NO-TRADE — ${reason}.`);
}

function printTicket(
  a: DegenArgs,
  t: DegenTicket,
  row: FadeRow,
  oracle: DegenOracle,
  heat: DegenHeat,
  fired: boolean,
): void {
  const execSide = t.side === "long" ? "BUY" : "SELL";
  const { sSig, lSig } = rowSignals(row);
  console.log(`DEGEN ${t.side.toUpperCase()} ${t.pair} @ ${px(t.plan.last)} (x${a.leverage} isolated, ${a.exchange})${fired ? "" : " — PREVIEW"}`);
  console.log(`  screen: ${sSig}/${lSig} ATR ${row.atrPct?.toFixed(2) ?? "—"}% vol x${Number.isFinite(row.vratio) ? row.vratio.toFixed(2) : "—"} · oracle ${oracle.side} (${oracle.score.toFixed(2)}) — ${oracle.detail}`);
  console.log(`  step-1 entry: ${execSide} ${t.step1.contracts} ≈ $${t.step1.sizeUsd.toFixed(0)} @ ${px(t.step1.price)} (limit, touch) → TP ${px(t.tp1Price)}`);
  console.log(`  step-2 average level: ${execSide} ${t.step2.contracts} ≈ $${t.step2.sizeUsd.toFixed(0)} @ ${px(t.step2.price)} (resting limit ONLY — never blind-add)`);
  console.log(`  averaged entry ${px(t.avg2)} → moving TP ${px(t.tp2Price)} · kill line ${px(t.plan.killPrice)} = -$${t.plan.killLossUsd.toFixed(2)} · max capital $${t.plan.maxCapitalUsd.toFixed(0)}`);
  console.log(`  heat: $${heat.heatUsd.toFixed(2)}/$${a.maxHeatUsd} open [${heat.open.map((o) => o.pair).join(", ") || "—"}] stops today ${heat.stopsToday} (size ${t.sizeEff === a.sizeUsd ? "full" : "HALVED"})`);
  console.log(`  trail: arm +${a.activationPct}% → close ${a.bouncebackPct}% off peak (${a.polls} polls × 3s)`);
}

/**
 * `jw3 degen record` — close the loop. Live mode scores the outcome into
 * heat + learning-log (`stop`/`loss` increments the day's stop count, halve
 * rule then flat, cooldown; every outcome frees the pair's heat). Paper
 * mode closes the paper position in the degen paper account (exit derived
 * from the recorded pnl, entry when none); stops derive from the ledger,
 * same halve-then-flat doctrine.
 */
export async function cmdDegenRecord(
  opts: { pair: string; outcome: string; pnl?: number; json: boolean; paper?: boolean; heatPath?: string; logPath?: string; paperPath?: string },
  deps?: { now?: () => number },
): Promise<void> {
  const pairErr = validateVotePair(opts.pair);
  const outcome = opts.outcome.toLowerCase() as DegenOutcome;
  if (pairErr || !["win", "loss", "stop", "scratch"].includes(outcome)) {
    console.error("Usage: jw3 degen record --pair SOL/USDT --outcome win|loss|stop|scratch [--pnl …] [--paper] [--json]");
    process.exitCode = 2;
    return;
  }
  const pair = normalizeVotePair(opts.pair);
  const nowMs = deps?.now ? deps.now() : Date.now();
  if (opts.paper) {
    await cmdDegenRecordPaper(pair, outcome, opts.pnl, opts.json, opts.paperPath, nowMs);
    return;
  }
  const heatPath = opts.heatPath ?? degenHeatPath();
  const logPath = opts.logPath ?? degenLogPath();
  const heat = loadHeat(heatPath, nowMs);
  const idx = heat.open.findIndex((o) => o.pair.toUpperCase() === pair.toUpperCase());
  if (idx >= 0) {
    const [freed] = heat.open.splice(idx, 1);
    heat.heatUsd = Math.max(0, heat.heatUsd - (freed?.riskUsd ?? 0));
  }
  if (outcome === "loss" || outcome === "stop") {
    heat.stopsToday += 1;
    heat.lastStopAt = new Date(nowMs).toISOString();
  }
  saveHeat(heatPath, heat);
  const finetune = appendLearning(logPath, {
    at: new Date(nowMs).toISOString(), pair, mode: "record", outcome,
    ...(opts.pnl !== undefined ? { pnlUsd: opts.pnl } : {}),
    heat: { stopsToday: heat.stopsToday, heatUsd: heat.heatUsd, open: heat.open.map((o) => o.pair) },
  });
  if (opts.json) {
    console.log(JSON.stringify({ pair, outcome, heat, ...(finetune ? { finetune } : {}) }, null, 2));
  } else {
    console.log(`RECORDED ${outcome.toUpperCase()} ${pair} — stops today ${heat.stopsToday}, heat $${heat.heatUsd.toFixed(2)}, open [${heat.open.map((o) => o.pair).join(", ") || "—"}]`);
    if (heat.stopsToday === 1) console.log("Halve rule live: next size is HALF until the day rolls.");
    if (heat.stopsToday >= DEGEN_MAX_STOPS_PER_DAY) console.log("Flat for the day — the book reopens tomorrow.");
    if (finetune) console.log(`FINETUNE-READY: ${finetune} learning windows banked — re-score the oracle holdout.`);
  }
}

/** Exit price for a paper close from the recorded net pnl (fee-free closes). */
function paperExitForRecord(
  pos: { side: "long" | "short"; entryPrice: number; qty: number },
  pnlUsd: number | undefined,
): number {
  if (pnlUsd === undefined || !(pos.qty > 0)) return pos.entryPrice;
  const dir = pos.side === "long" ? 1 : -1;
  const exit = pos.entryPrice + (dir * pnlUsd) / pos.qty;
  return exit > 0 && Number.isFinite(exit) ? exit : pos.entryPrice;
}

/** Close-kind for a recorded outcome (losses close out red, stops arm the ledger's stop count). */
function paperKindForRecord(outcome: DegenOutcome): PaperFillKind {
  return outcome === "win" ? "tp" : outcome === "scratch" ? "close" : "sl";
}

/**
 * `jw3 degen record --paper` — close the paper position in the degen paper
 * account. The exit derives from the recorded `--pnl` (fee-free, same math
 * as the migration shim); without a pnl the position closes at its entry.
 * Stops derive from the ledger afterward, same halve-then-flat doctrine as
 * live (loss closes recorded red count as stops).
 */
export async function cmdDegenRecordPaper(
  pair: string,
  outcome: DegenOutcome,
  pnlUsd: number | undefined,
  json: boolean,
  paperPathOpt: string | undefined,
  nowMs: number,
): Promise<void> {
  const paperPath = paperPathOpt ?? paperStorePath();
  const mig = migrateDegenPaperOnce({ paperPath, nowMs });
  if (mig.migrated && !json) {
    console.log(
      `MIGRATED legacy paper book → ${paperPath}: ${mig.positions} open, ${mig.closed} closed, ${mig.skipped} skipped${mig.warnings.length > 0 ? ` (${mig.warnings.join("; ")})` : ""}.`,
    );
  }
  const store = loadPaperStore(paperPath);
  if (!ensureDegenPaperAccount(store, paperPath)) return;
  const acct = getAccount(store, DEGEN_PAPER_ACCOUNT) as PaperAccount;
  const pos = acct.positions.find(
    (p) => (p.strategy ?? "") === DEGEN_PAPER_STRATEGY && p.pair.toUpperCase() === pair.toUpperCase(),
  );
  if (!pos) {
    console.error(`No open degen paper position for ${pair} — nothing to record. Fire one first (\`jw3 degen --paper --pair ${pair}\`).`);
    process.exitCode = 1;
    return;
  }
  const res = closePaperPosition(store, DEGEN_PAPER_ACCOUNT, pos.id, {
    price: paperExitForRecord(pos, pnlUsd),
    feeUsd: 0,
    feeTier: "taker",
    kind: paperKindForRecord(outcome),
  }, grossPnlUsd);
  if (res.error || !res.fill) {
    console.error(`Could not close the paper position: ${res.error ?? "unknown"} — nothing was written.`);
    process.exitCode = 1;
    return;
  }
  try {
    savePaperStore(paperPath, store);
  } catch (e) {
    console.error(`Could not persist the paper ledger: ${e instanceof Error ? e.message : String(e)} — the close above is in memory only.`);
    process.exitCode = 1;
    return;
  }
  const heat = paperHeatOf(getAccount(store, DEGEN_PAPER_ACCOUNT) as PaperAccount, nowMs);
  if (json) {
    console.log(JSON.stringify({ pair, outcome, paper: true, heat, fill: res.fill }, null, 2));
  } else {
    console.log(`PAPER RECORDED ${outcome.toUpperCase()} ${pair} — stops today ${heat.stopsToday}, heat $${heat.heatUsd.toFixed(2)}, open [${heat.open.map((o) => o.pair).join(", ") || "—"}]`);
    if (heat.stopsToday === 1) console.log("Halve rule live: next size is HALF until the day rolls.");
    if (heat.stopsToday >= DEGEN_MAX_STOPS_PER_DAY) console.log("Flat for the day — the book reopens tomorrow.");
  }
}

/** Scored view of the paper book: fills opened vs outcomes recorded. */
export type PaperStats = {
  fills: number;
  wins: number;
  losses: number;
  stops: number;
  scratches: number;
  pending: number;
  netUsd: number;
  open: string[];
};

/** Pure scorer over the degen paper account (fills with strategy "degen"). */
export function summarizePaperAccount(acct: PaperAccount): PaperStats {
  const s: PaperStats = { fills: 0, wins: 0, losses: 0, stops: 0, scratches: 0, pending: 0, netUsd: 0, open: [] };
  for (const f of acct.fills) {
    if ((f.strategy ?? "") !== DEGEN_PAPER_STRATEGY) continue;
    if (f.kind === "open") {
      s.fills += 1;
      continue;
    }
    if (typeof f.pnlUsd === "number" && Number.isFinite(f.pnlUsd)) s.netUsd += f.pnlUsd;
    if (f.kind === "tp") s.wins += 1;
    else if (f.kind === "sl") s.stops += 1;
    else if (f.kind === "close" && (f.pnlUsd ?? 0) < 0) s.losses += 1;
    else s.scratches += 1;
  }
  s.pending = Math.max(0, s.fills - (s.wins + s.losses + s.stops + s.scratches));
  s.open = acct.positions.filter((p) => (p.strategy ?? "") === DEGEN_PAPER_STRATEGY).map((p) => p.pair);
  return s;
}

/** `jw3 degen paper-stats` — score the paper book. Reports, never fires. */
export async function cmdPaperStats(opts: { json: boolean; paperPath?: string }): Promise<void> {
  const paperPath = opts.paperPath ?? paperStorePath();
  const mig = migrateDegenPaperOnce({ paperPath });
  if (mig.migrated && !opts.json) {
    console.log(
      `MIGRATED legacy paper book → ${paperPath}: ${mig.positions} open, ${mig.closed} closed, ${mig.skipped} skipped${mig.warnings.length > 0 ? ` (${mig.warnings.join("; ")})` : ""}.`,
    );
  }
  const store = loadPaperStore(paperPath);
  const acct = getAccount(store, DEGEN_PAPER_ACCOUNT);
  const s = acct ? summarizePaperAccount(acct) : null;
  if (opts.json) {
    console.log(JSON.stringify({ book: "paper", ...(s ?? { fills: 0, wins: 0, losses: 0, stops: 0, scratches: 0, pending: 0, netUsd: 0, open: [] }) }, null, 2));
    return;
  }
  if (!s || s.fills === 0) {
    console.log("PAPER BOOK — no paper fills yet. Prove one: `jw3 degen --paper --pair SOL/USDT`.");
    return;
  }
  const closed = s.wins + s.losses + s.stops + s.scratches;
  console.log(`PAPER BOOK — ${s.fills} fills (${closed} closed: ${s.wins}W/${s.losses}L/${s.stops}S/${s.scratches}X, ${s.pending} pending)  net ${s.netUsd >= 0 ? "+" : ""}$${s.netUsd.toFixed(2)}  open [${s.open.join(", ") || "—"}]`);
}
