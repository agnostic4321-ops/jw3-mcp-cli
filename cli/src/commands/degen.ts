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
 *      ballot (`combineOracleVote`). `flat` = NO TRADE (never a
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
 * heat → plan pipeline against a SEPARATE paper book, then simulated fills
 * at plan prices with zero venue contact. The only network write is
 * `propose_trade` ([PAPER] Diary setup, propose scope — never execute).
 * `--paper` refuses `--yes`/`--live`/`--trail`: paper never fires.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../mcp.js";
import { resolvePat } from "../config.js";
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
import {
  combineOracleVote,
  fetchSessionCtx,
  layaToSignal,
  oracleWeightsFromStore,
  rfdetrOracleSignal,
  type OracleSide,
  type OracleSignal,
} from "./oracle.js";
import {
  BOUNCE_REQUIRED_PCT,
  bounceOffLowPct,
  bounceRequiredVeto,
  type PrefilterCtx,
} from "../blocking-rules.js";
import { extractOpenOrders, makeIntentKey, ACTOR_MACHINE, type TradeCall } from "./trade.js";
import {
  loadStore,
  normalizeVotePair,
  validateVotePair,
  voteStorePath,
} from "./vote.js";
import { fail, needPat } from "./market.js";
import { cmdTrail } from "./trail.js";

export type DegenSide = "long" | "short";

export type DegenOracle = {
  side: OracleSide;
  score: number;
  detail: string;
};

export type DegenHeatOpen = { pair: string; riskUsd: number };

export type DegenHeat = {
  day: string;
  stopsToday: number;
  heatUsd: number;
  open: DegenHeatOpen[];
  lastStopAt: string | null;
};

export type DegenOutcome = "win" | "loss" | "stop" | "scratch";

/** Watchlist for auto-screen (the spike monitor's curated defaults). */
export const DEGEN_AUTO_BASES: string[] = SPIKE_DEFAULT_SYMS.map((s) =>
  s.replace(/USDTM$/, ""),
);
/** Owner-ordered risk doctrine (see skill lessons: 30%-risk math). */
export const DEGEN_HEAT_CAP_USD = 6;
export const DEGEN_MAX_CONCURRENT = 2;
export const DEGEN_MAX_STOPS_PER_DAY = 2;
export const DEGEN_COOLDOWN_MS = 3600 * 1000;
export const DEGEN_FINETUNE_AT = [100, 200];
/** Trail follow-up defaults (same grid as `trail`). */
export const DEGEN_DEFAULT_POLLS = 600;
export const DEGEN_DEFAULT_LEVERAGE = 2;

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

function configDir(): string {
  if (process.env["JW3_CONFIG_HOME"]) return process.env["JW3_CONFIG_HOME"];
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

export function degenHeatPath(dir?: string): string {
  return join(dir ?? configDir(), "degen-heat.json");
}

export function degenLogPath(dir?: string): string {
  return join(dir ?? configDir(), "degen-learning.jsonl");
}

/** Separate paper book: proving never consumes live heat or the live log. */
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

export function degenToday(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function defaultHeat(day: string): DegenHeat {
  return { day, stopsToday: 0, heatUsd: 0, open: [], lastStopAt: null };
}

/** Load heat; missing/corrupt → defaults. Day roll resets the counters. */
export function loadHeat(path: string, nowMs: number = Date.now()): DegenHeat {
  const day = degenToday(nowMs);
  try {
    if (!existsSync(path)) return defaultHeat(day);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DegenHeat>;
    const open = Array.isArray(raw.open)
      ? raw.open.filter(
          (o): o is DegenHeatOpen =>
            !!o && typeof o === "object" && typeof o.pair === "string" && Number.isFinite(o.riskUsd),
        )
      : [];
    const heat = defaultHeat(day);
    if (typeof raw.day === "string") heat.day = raw.day;
    if (Number.isInteger(raw.stopsToday) && (raw.stopsToday as number) >= 0) {
      heat.stopsToday = raw.stopsToday as number;
    }
    if (Number.isFinite(raw.heatUsd) && (raw.heatUsd as number) >= 0) {
      heat.heatUsd = raw.heatUsd as number;
    }
    heat.open = open;
    if (typeof raw.lastStopAt === "string") heat.lastStopAt = raw.lastStopAt;
    if (heat.day !== day) {
      heat.day = day;
      heat.stopsToday = 0;
      heat.heatUsd = 0;
    }
    return heat;
  } catch {
    return defaultHeat(day);
  }
}

export function saveHeat(path: string, heat: DegenHeat): void {
  mkdirSync(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(path, JSON.stringify(heat, null, 2));
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
  now?: () => number;
  /** Session context for the short bounce gate (price + 60min session low). */
  sessionCtx?: (pair: string) => Promise<PrefilterCtx>;
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
): Promise<DegenOracle> {
  const store = loadStore(storePath ?? voteStorePath());
  const weights = oracleWeightsFromStore(store.weights);
  const [kSettled, lSettled] = await Promise.allSettled([
    (async () => {
      const v = await fetchKronosVerdict(pair, horizon);
      if (!v || v.direction === "flat") return null;
      const conf = Math.min(Math.max(Math.abs(v.expected_move_pct) / 1, 0.1), 1);
      return {
        skill: "kronos" as const,
        side: (v.direction === "up" ? "long" : "short") as "long" | "short",
        confidence: conf,
        detail: `${v.direction} ${v.expected_move_pct.toFixed(2)}% over ${v.horizon}x15m`,
      };
    })(),
    (async () => {
      const state = await buildMarketState(pair, exchange, { url, pat });
      return layaToSignal(await fetchLayaVerdict(state));
    })(),
  ]);
  const signals: OracleSignal[] = [];
  if (kSettled.status === "fulfilled" && kSettled.value) {
    const k = kSettled.value;
    signals.push({ skill: k.skill, side: k.side, confidence: k.confidence, abstained: false, detail: k.detail });
  } else {
    signals.push({ skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: "kronos failed/abstained" });
  }
  if (lSettled.status === "fulfilled") {
    signals.push(lSettled.value);
  } else {
    signals.push({ skill: "laya", side: "flat", confidence: 0, abstained: true, detail: "laya failed" });
  }
  signals.push(rfdetrOracleSignal());
  const verdict = combineOracleVote(signals, weights);
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
  const heatPath = deps?.heatPath ?? (a.paper ? degenPaperHeatPath() : degenHeatPath());
  const logPath = deps?.logPath ?? (a.paper ? degenPaperLogPath() : degenLogPath());
  const heat = loadHeat(heatPath, nowMs);
  const sizeEff = effectiveSize(a.sizeUsd, heat.stopsToday);
  const fade = deps?.fade ?? futuresFade;
  const oracleFetch = deps?.oracle ?? ((pair: string) => prodOracle(pair, a.exchange, a.horizon, opts.url, opts.pat, deps?.storePath));

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

  // ── paper: simulated fills to the Diary, zero venue contact ──
  if (a.paper) {
    await runPaper(a, opts, deps ?? {}, { ticket, row: row!, oracle, heat, heatPath, logPath, nowMs });
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
  let failed = 0;
  let step1Id: string | null = null;
  let step2Id: string | null = null;
  try {
    const out1 = (await call("execute_trade", degenExecuteArgs({ exchange: a.exchange, pair, side, contracts: step1.contracts, price: step1.price, leverage: a.leverage, multiplier: spec.multiplier }), pat, opts.url)) as { orderId?: string };
    step1Id = String(out1.orderId ?? "?");
    if (!opts.json) console.log(`PLACED step-1: ${execSide.toUpperCase()} ${step1.contracts} @ ${px(step1.price)} → ${step1Id}`);
  } catch (e) {
    failed++;
    console.error(`STEP-1 FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (step1Id) {
    try {
      const out2 = (await call("execute_trade", degenExecuteArgs({ exchange: a.exchange, pair, side, contracts: step2.contracts, price: step2.price, leverage: a.leverage, multiplier: spec.multiplier }), pat, opts.url)) as { orderId?: string };
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
    await call("set_exits", degenExitsArgs({ exchange: a.exchange, pair, tpPrice: tp1Price, slPrice: plan.killPrice }), pat, opts.url);
    tpArmed = true;
    stopArmed = true;
    if (!opts.json) console.log(`TP ARMED @ ${px(tp1Price)} (step-1 TP; move to averaged ${px(tp2Price)} via exits once step-2 fills) + STOP ARMED @ kill ${px(plan.killPrice)}`);
  } catch (e) {
    // The combined arm failed: fall back to the TP-only arm (the old
    // doctrine) so the take-profit is not lost with the stop. A TP-only
    // arm is NOT a success on its own (see the gate below).
    console.error(`Stop+TP arm failed, falling back to TP-only: ${e instanceof Error ? e.message : String(e)}`);
    try {
      await call("set_exits", degenExitsArgs({ exchange: a.exchange, pair, tpPrice: tp1Price }), pat, opts.url);
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

/** Pure: simulated fill ids for a paper ticket (never venue order ids). */
export function paperFillIds(base: string, nowMs: number): { step1Id: string; step2Id: string } {
  const stem = `paper-${base.toLowerCase()}-${nowMs}`;
  return { step1Id: `${stem}-s1`, step2Id: `${stem}-s2` };
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
 * Paper fill: same ticket the live loop would fire, simulated at plan
 * prices. Zero venue contact — no list_open_orders, no execute_trade, no
 * set_exits. The only network write is `propose_trade` (Diary visibility,
 * propose scope); the local paper ledger is the backtest source of truth
 * and a diary failure warns without losing the fill.
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
    heatPath: string;
    logPath: string;
    nowMs: number;
  },
): Promise<void> {
  const { ticket, row, oracle, heat, heatPath, logPath, nowMs } = ctx;
  const runPath = degenRunPath(ticket.base, deps.runDir, true);
  if (existsSync(runPath)) {
    console.error(`paper state exists at ${runPath} — record its outcome (\`degen record --paper --pair ${ticket.pair} --outcome …\`) or remove it by hand; refusing to double-fire.`);
    process.exitCode = 1;
    return;
  }
  const fills = paperFillIds(ticket.base, nowMs);
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
  const runState = {
    kind: "degen-paper",
    exchange: a.exchange,
    pair: ticket.pair,
    base: ticket.base,
    side: ticket.side,
    leverage: a.leverage,
    step1: { ...ticket.step1, fillId: fills.step1Id },
    step2: { ...ticket.step2, fillId: fills.step2Id },
    avg2: ticket.avg2,
    tp1Price: ticket.tp1Price,
    tp2Price: ticket.tp2Price,
    tpArmed: "virtual",
    killPrice: ticket.plan.killPrice,
    killLossUsd: ticket.plan.killLossUsd,
    diary: { setupId, skipped: diarySkipped },
    createdAt: new Date(nowMs).toISOString(),
  };
  try {
    mkdirSync(runPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(runPath, JSON.stringify(runState, null, 2));
  } catch {
    // State is a convenience trail — the paper ledger below already recorded.
  }
  heat.open.push({ pair: ticket.pair, riskUsd: ticket.plan.killLossUsd });
  heat.heatUsd += ticket.plan.killLossUsd;
  saveHeat(heatPath, heat);
  const finetune = appendLearning(logPath, {
    ...learningEntry(a, ticket, row, oracle, heat, "paper", "paper fill (no venue)"),
    fills,
    diary: { setupId, skipped: diarySkipped },
  });
  if (opts.json) {
    console.log(JSON.stringify({ mode: "paper", ticket, screen: row, oracle, heat, fills, diary: { setupId, skipped: diarySkipped }, ...(finetune ? { finetune } : {}) }, null, 2));
  } else {
  printTicket(a, ticket, row, oracle, heat, false);
  console.log(`  paper fills: step-1 [${fills.step1Id}] step-2 [${fills.step2Id}] TP ${px(ticket.tp1Price)} (virtual, TP-only doctrine)`);
  if (setupId) console.log(`  diary: PAPER setup ${setupId} (propose scope — approve nothing, it never executes)`);
  else console.log(`  diary: ${diarySkipped}`);
    console.log("PAPER — simulated fills, zero venue contact. Nothing can execute from this ticket.");
  }
  if (!opts.json) {
  console.log(`Kill line ${px(ticket.plan.killPrice)} (≈ -$${ticket.plan.killLossUsd.toFixed(2)}) — close the loop with \`degen record --paper --pair ${ticket.pair} --outcome win|loss|stop|scratch [--pnl …]\`.`);
  if (finetune) console.log(`FINETUNE-READY: ${finetune} learning windows banked — re-score the oracle holdout.`);
  }
}

function learningEntry(
  a: DegenArgs,
  ticket: DegenTicket,
  row: FadeRow,
  oracle: DegenOracle,
  heat: DegenHeat,
  mode: "preview" | "live" | "paper",
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

/** Append one learning line; returns the banked total when a threshold hits. */
export function appendLearning(logPath: string, entry: Record<string, unknown>): number | null {
  try {
    mkdirSync(logPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    const total = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "").length;
    return (DEGEN_FINETUNE_AT as number[]).includes(total) ? total : null;
  } catch {
    return null;
  }
}

async function noTrade(
  opts: DegenRunOpts,
  logPath: string,
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
 * `jw3 degen record` — close the loop: score the outcome into heat +
 * learning-log. `stop`/`loss` increments the day's stop count (halve
 * rule, then flat) and starts the cooldown; every outcome frees the
 * pair's heat.
 */
export async function cmdDegenRecord(
  opts: { pair: string; outcome: string; pnl?: number; json: boolean; paper?: boolean; heatPath?: string; logPath?: string },
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
  const heatPath = opts.heatPath ?? (opts.paper ? degenPaperHeatPath() : degenHeatPath());
  const logPath = opts.logPath ?? (opts.paper ? degenPaperLogPath() : degenLogPath());
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
    ...(opts.paper ? { paper: true } : {}),
    ...(opts.pnl !== undefined ? { pnlUsd: opts.pnl } : {}),
    heat: { stopsToday: heat.stopsToday, heatUsd: heat.heatUsd, open: heat.open.map((o) => o.pair) },
  });
  if (opts.json) {
    console.log(JSON.stringify({ pair, outcome, ...(opts.paper ? { paper: true } : {}), heat, ...(finetune ? { finetune } : {}) }, null, 2));
  } else {
    console.log(`${opts.paper ? "PAPER " : ""}RECORDED ${outcome.toUpperCase()} ${pair} — stops today ${heat.stopsToday}, heat $${heat.heatUsd.toFixed(2)}, open [${heat.open.map((o) => o.pair).join(", ") || "—"}]`);
    if (heat.stopsToday === 1) console.log("Halve rule live: next size is HALF until the day rolls.");
    if (heat.stopsToday >= DEGEN_MAX_STOPS_PER_DAY) console.log("Flat for the day — the book reopens tomorrow.");
    if (finetune) console.log(`FINETUNE-READY: ${finetune} learning windows banked — re-score the oracle holdout.`);
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

/** Pure scorer over paper-learning.jsonl content (unknown lines ignored). */
export function summarizePaperLog(text: string, open: string[] = []): PaperStats {
  const s: PaperStats = { fills: 0, wins: 0, losses: 0, stops: 0, scratches: 0, pending: 0, netUsd: 0, open: [...open] };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.mode === "paper" && e.outcome === "pending") s.fills += 1;
    if (e.mode === "record" && e.paper === true && typeof e.outcome === "string") {
      if (e.outcome === "win") s.wins += 1;
      else if (e.outcome === "loss") s.losses += 1;
      else if (e.outcome === "stop") s.stops += 1;
      else if (e.outcome === "scratch") s.scratches += 1;
      if (typeof e.pnlUsd === "number" && Number.isFinite(e.pnlUsd)) s.netUsd += e.pnlUsd;
    }
  }
  s.pending = Math.max(0, s.fills - (s.wins + s.losses + s.stops + s.scratches));
  return s;
}

/** `jw3 degen paper-stats` — score the paper book. Reports, never fires. */
export async function cmdPaperStats(opts: { json: boolean; logPath?: string; heatPath?: string }): Promise<void> {
  const logPath = opts.logPath ?? degenPaperLogPath();
  const heatPath = opts.heatPath ?? degenPaperHeatPath();
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    // No paper fills yet — empty book is a real answer.
  }
  let open: string[] = [];
  try {
    const heat = loadHeat(heatPath);
    open = heat.open.map((o) => o.pair);
  } catch {
    // Heat unreadable — stats still report the ledger.
  }
  const s = summarizePaperLog(text, open);
  if (opts.json) {
    console.log(JSON.stringify({ book: "paper", ...s }, null, 2));
    return;
  }
  if (s.fills === 0) {
    console.log("PAPER BOOK — no paper fills yet. Prove one: `jw3 degen --paper --pair SOL/USDT`.");
    return;
  }
  const closed = s.wins + s.losses + s.stops + s.scratches;
  console.log(`PAPER BOOK — ${s.fills} fills (${closed} closed: ${s.wins}W/${s.losses}L/${s.stops}S/${s.scratches}X, ${s.pending} pending)  net ${s.netUsd >= 0 ? "+" : ""}$${s.netUsd.toFixed(2)}  open [${s.open.join(", ") || "—"}]`);
}
