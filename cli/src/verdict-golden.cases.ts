/**
 * OQ-09 golden cases — what the verdict stack decides on fixture inputs
 * (run by verdict-golden.test.ts; kept apart so a sandboxed ablation can
 * replay the same cases).
 *
 * Recorded byte-identical and required byte-identical after every change
 * that is not owner-approved. OQ-09 phase 2 (owner-approved 2026-11-10)
 * retired the `vote`, `oracle`, `committee` and `score` commands, the
 * committee seat and the `harness` chain: their cases are gone with them.
 *
 * Covered:
 *   - every kept verdict command: learning record/stats, decide
 *     (stdout, stderr, exit code, and every store file it writes);
 *   - the kept decision producer: degen (oracle weights from vote.json →
 *     runLive, plus --paper), with the decision runLive receives
 *     (decision tap) and the exact venue calls it sends;
 *   - the pure functions the producer calls (ballot combine, auto-tune,
 *     the track store, learning) over a fixed input matrix.
 *
 * Wall-clock ISO timestamps are scrubbed to "<ts>" (they are not decisions).
 * Re-record ONLY for an owner-approved change: JW3_VERDICT_GOLDEN_RECORD=1.
 * No network: every fetcher, clock, venue client and store path is injected.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox } from "./test-fixtures.js";
import {
  DEFAULT_WEIGHTS,
  combineBallot,
  oracleWeights,
  type Ballot,
  type OracleSkill,
  type SkillId,
} from "./commands/weighting.js";
import {
  defaultStore,
  loadStore,
  recordOutcome,
  type VoteStore,
} from "./commands/track-store.js";
import {
  applyPromotionGate,
  cmdLearningRecord,
  cmdLearningStats,
  jevSignal,
  kronosSignal,
  layaSignal,
  rfdetrLearningSignal,
  summarizeLearningLog,
  type LearningSignal,
} from "./commands/learning.js";
import { cmdDecide, type BridgeRunner, type LayaVerdict, type MarketState } from "./commands/decide.js";
import { cmdDegen, type DegenArgs, type DegenDeps } from "./commands/degen.js";
import { tapLiveDecisions, type DecisionRecord } from "./commands/live.js";
import type { TrendVerdict } from "./commands/analyze.js";
import type { ForecastVerdict } from "./commands/forecast.js";
import type { FadeRow, SpikeDepth, SpikeTicker } from "./kucoin.js";

/** The retired ballot skills, kept as the fixture shape (vote.json tracks). */
type SkillSignal = Ballot<SkillId>;
type OracleSignal = Ballot<OracleSkill>;

const here = dirname(fileURLToPath(import.meta.url));
/** The recorded goldens (src/, also found from the compiled dist/). */
export const GOLDEN_FILE = (() => {
  const candidates = [join(here, "verdict.golden.json"), join(here, "..", "src", "verdict.golden.json")];
  return candidates.find((p) => existsSync(p)) ?? (candidates[1] as string);
})();

/* ------------------------------------------------------------------ */
/* clocks, ids, capture                                                */
/* ------------------------------------------------------------------ */

/** 08:00Z — outside the CPI blackout (11:30-13:30Z). */
const NOW = Date.UTC(2026, 10, 10, 8, 0, 0);
const PAT = "golden-pat";

export type Golden = {
  out: string[];
  err: string[];
  exitCode: number | null;
  files?: Record<string, string>;
  decisions?: DecisionRecord[];
  calls?: { name: string; args: Record<string, unknown> }[];
  value?: unknown;
};

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
const scrub = (s: string): string => s.replace(TS, "<ts>");

async function capture(fn: () => Promise<unknown>): Promise<Golden> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => {
    out.push(scrub(a.map(String).join(" ")));
  };
  console.error = (...a: unknown[]) => {
    err.push(scrub(a.map(String).join(" ")));
  };
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : null;
  process.exitCode = undefined;
  return { out, err, exitCode };
}

/** Every file under `dir` (relative path → scrubbed text), sorted. */
function filesOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p)] = scrub(readFileSync(p, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const seed = (dir: string, name: string, value: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return p;
};

/** Decision tap + venue recorder around one producer run. */
async function withDecisions(
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>,
  answer: (name: string, args: Record<string, unknown>, nth: number) => unknown,
): Promise<Golden> {
  const decisions: DecisionRecord[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const seen = new Map<string, number>();
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return answer(name, args, nth);
  };
  tapLiveDecisions((d) => decisions.push(d));
  try {
    const g = await capture(() => fn(call));
    return { ...g, decisions, calls };
  } finally {
    tapLiveDecisions(null);
  }
}

/* ------------------------------------------------------------------ */
/* model fixtures                                                      */
/* ------------------------------------------------------------------ */

const trend = (verdict: string, agreement: number, uncertain = false): TrendVerdict => ({
  model: "JEV",
  verdict: { trend: { verdict, agreement, uncertain } },
});

const kronos = (direction: "up" | "down" | "flat", move: number): ForecastVerdict => ({
  direction,
  expected_move_pct: move,
  last_close: 150,
  pred_last_close: Number((150 * (1 + move / 100)).toFixed(4)),
  pred_closes: [],
  horizon: 12,
  lookback: 400,
  ms: 3,
});

const laya = (choice: "long" | "short" | "flat", confidence: number, reason = "golden laya"): LayaVerdict => ({
  choice,
  confidence,
  score: choice === "long" ? confidence : choice === "short" ? -confidence : 0,
  reasons: [reason],
  ms: 1,
});

const STATE: MarketState = {
  pair: "SOL/USDT",
  symbol: "SOLUSDTM",
  last: 150,
  tape: { chg: 1.2, vratio: 0.8, vslope: "down", offHighPct: 1.5, offLowPct: 3.2, atrPct: 0.9, n: 60 },
  book: { mid: 150, sprBps: 1.3, bid5Usd: 42000, ask5Usd: 30000, imb: 0.167 },
  jev: { side: "long", agreement: 0.8, uncertain: false, verdict: "strong_long" },
};

/* vote.json — a tuned live store with history and one open ballot. */
const ballotSignals = (jevSide: "long" | "short", jevConf: number, kSide: "long" | "short", kConf: number): SkillSignal[] => [
  { skill: "jev", side: jevSide, confidence: jevConf, abstained: false, detail: `strong_${jevSide}` },
  { skill: "kronos", side: kSide, confidence: kConf, abstained: false, detail: `${kSide === "long" ? "up" : "down"} ${kConf.toFixed(2)}% over 12x15m` },
  { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: "chart-vision model not wired (weight 0)" },
];

const TUNED_VOTE_STORE = {
  version: 1,
  weights: { jev: 0.7, kronos: 1.3, rfdetr: 0.4 },
  skills: {
    jev: { results: [true, false, true, true, false, true], hits: 14, total: 25 },
    kronos: { results: [true, true, true, false, true], hits: 9, total: 12 },
    rfdetr: { results: [], hits: 0, total: 0 },
  },
  votes: [
    {
      at: "2026-11-09T07:00:00.000Z",
      pair: "ETH/USDT",
      side: "short",
      score: -0.41,
      signals: ballotSignals("short", 0.7, "short", 0.4),
      weights: { jev: 0.7, kronos: 1.2, rfdetr: 0.4 },
      resolved: { outcome: "short", at: "2026-11-09T09:00:00.000Z" },
    },
    {
      at: "2026-11-10T07:30:00.000Z",
      pair: "SOL/USDT",
      side: "long",
      score: 0.52,
      signals: ballotSignals("long", 0.8, "long", 0.6),
      weights: { jev: 0.7, kronos: 1.3, rfdetr: 0.4 },
    },
  ],
};

/** An old-format vote.json (no rfdetr slot, junk entries) — must load the same way. */
const OLD_VOTE_STORE = {
  version: 1,
  weights: { jev: 1.1, kronos: 9, rfdetr: "x" },
  skills: { jev: { results: [true, true, "x", false], hits: 3, total: -1 }, kronos: "bad" },
  votes: [{ pair: "SOL/USDT", side: "long", score: 0.3, signals: ballotSignals("long", 0.6, "short", 0.3), weights: { jev: 1.1, kronos: 0.5, rfdetr: 0 } }, null, { nope: 1 }],
};

/* ------------------------------------------------------------------ */
/* tape fixtures (degen, decide)                                       */

/* ------------------------------------------------------------------ */
/* tape fixtures (committee, degen)                                    */
/* ------------------------------------------------------------------ */

function mulberry32(seedN: number): () => number {
  let a = seedN >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r6 = (x: number): number => Number(x.toFixed(6));

/** Venue kline rows [ts, open, high, low, close, volume, turnover] with a drift. */
function klineRows(seedN: number, n: number, stepMin: number, p0: number, driftPct: number, volPct: number): number[][] {
  const r = mulberry32(seedN);
  const t0 = NOW - n * stepMin * 60_000;
  const rows: number[][] = [];
  let p = p0;
  for (let k = 0; k < n; k++) {
    const o = p;
    const c = o * (1 + (driftPct + volPct * (r() - 0.5) * 2) / 100);
    const hi = Math.max(o, c) * (1 + (volPct * r() * 0.5) / 100);
    const lo = Math.min(o, c) * (1 - (volPct * r() * 0.5) / 100);
    const v = 800 + r() * 800;
    rows.push([t0 + k * stepMin * 60_000, r6(o), r6(hi), r6(lo), r6(c), r6(v), r6(v * c)]);
    p = c;
  }
  return rows;
}

type Tape = {
  rows: Record<number, number[][]>;
  fade: FadeRow;
  ticker: SpikeTicker;
  depth: SpikeDepth;
};

function tape(symbol: string, seedN: number, p0: number, driftPct: number, over: Partial<FadeRow> = {}, bidHeavy = true): Tape {
  const rows: Record<number, number[][]> = {
    60: klineRows(seedN, 60, 60, p0, driftPct, 0.6),
    240: klineRows(seedN + 1, 60, 240, p0 * 0.97, driftPct * 2, 1.1),
    1440: klineRows(seedN + 2, 60, 1440, p0 * 0.9, driftPct * 4, 2.2),
  };
  const last = rows[60]![59]![4]!;
  const bid = (i: number): [string, string] => [String(r6(last * (1 - 0.0002 * (i + 1)))), String(bidHeavy ? 900 - i * 20 : 300 - i * 5)];
  const ask = (i: number): [string, string] => [String(r6(last * (1 + 0.0002 * (i + 1)))), String(bidHeavy ? 300 - i * 5 : 900 - i * 20)];
  return {
    rows,
    fade: { symbol, last, chg: 2.1, vratio: 1.2, vslope: "up", offHighPct: 1.4, offLowPct: 4.4, atrPct: 0.9, fundingPct: 0.01, n: 60, ...over },
    ticker: { price: last, bestBid: r6(last * 0.9999), bestAsk: r6(last * 1.0001), bestBidSize: 10, bestAskSize: 12 },
    depth: { bids: Array.from({ length: 20 }, (_, i) => bid(i)), asks: Array.from({ length: 20 }, (_, i) => ask(i)) },
  };
}

const UP = tape("SOLUSDTM", 101, 140, 0.12);
/* ------------------------------------------------------------------ */
/* venue answers for the decision producers                            */
/* ------------------------------------------------------------------ */

const LIVE_RISK = {
  risk_limits: {
    kill_switch_enabled: false,
    daily_realized_loss_usd: 0,
    max_daily_loss_usd: 50,
    daily_trade_count: 0,
    max_trades_per_day: 10,
    daily_notional_usd: 0,
    max_daily_notional_usd: 5000,
    max_position_usd: 1000,
  },
};

const degenVenue = (name: string, _args: Record<string, unknown>, nth: number): unknown => {
  if (name === "list_open_orders") return [];
  if (name === "read_risk_limits") return LIVE_RISK;
  if (name === "execute_trade") return { orderId: `degen-${nth}` };
  if (name === "set_exits") return { ok: true };
  if (name === "propose_trade") return { setup_id: `setup-${nth}` };
  return {};
};

const DEGEN_ROW: FadeRow = {
  symbol: "SOLUSDTM",
  last: 100,
  chg: 4,
  vratio: 0.5,
  vslope: "down",
  offHighPct: 2,
  offLowPct: 20,
  atrPct: 0.8,
  fundingPct: null,
  n: 60,
};

const DEGEN_ARGS: DegenArgs = {
  pair: "SOL/USDT",
  exchange: "kucoin",
  sizeUsd: 15,
  leverage: 2,
  maxHeatUsd: 6,
  maxConcurrent: 2,
  activationPct: 0.25,
  bouncebackPct: 0.08,
  polls: 600,
  horizon: 12,
  trail: false,
  live: false,
  paper: false,
};

function degenDeps(dir: string, models: { k: ForecastVerdict | Error; l: LayaVerdict | Error }, extra: Partial<DegenDeps> = {}): DegenDeps {
  return {
    fade: async () => DEGEN_ROW,
    spec: async () => ({ multiplier: 1, tick: 0.01 }),
    heatPath: join(dir, "degen-heat.json"),
    logPath: join(dir, "degen-learning.jsonl"),
    runDir: join(dir, "runs"),
    storePath: join(dir, "vote.json"),
    paperPath: join(dir, "paper-accounts.json"),
    now: () => NOW,
    sessionCtx: async () => ({ dayChgPct: 0.5, price: 100, sessionLow: 99 }),
    kronos: async () => {
      if (models.k instanceof Error) throw models.k;
      return models.k;
    },
    marketState: async () => STATE,
    laya: async () => {
      if (models.l instanceof Error) throw models.l;
      return models.l;
    },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* the cases                                                           */
/* ------------------------------------------------------------------ */

export type Case = (dir: string) => Promise<Golden>;

const withFiles = async (dir: string, g: Promise<Golden>): Promise<Golden> => {
  const got = await g;
  return { ...got, files: filesOf(dir) };
};

const learningSignals = (
  jev: ["long" | "short" | "flat", number],
  lay: ["long" | "short" | "flat", number],
  kr: ["up" | "down" | "flat", number],
): Partial<Record<"jev" | "laya" | "kronos" | "rfdetr", LearningSignal>> => ({
  jev: jevSignal(jev[0], jev[1]),
  laya: layaSignal(lay[0], lay[1]),
  kronos: kronosSignal(kr[0], kr[1]),
  rfdetr: rfdetrLearningSignal(),
});

const LEARNING_TRADES = [
  { side: "long", entry: 150, exit: 151.2, reason: "tp", pnl: 0.9, fees: 0.12, sig: learningSignals(["long", 0.8], ["long", 0.7], ["up", 0.5]) },
  { side: "short", entry: 2600, exit: 2590, reason: "tp", pnl: 0.6, fees: 0.1, sig: learningSignals(["short", 0.7], ["flat", 0], ["up", 0.4]) },
  { side: "long", entry: 151, exit: 150.1, reason: "sl", pnl: -0.7, fees: 0.12, sig: learningSignals(["long", 0.6], ["long", 0.66], ["down", 0.3]) },
  { side: "short", entry: 2610, exit: 2611, reason: "scratch", pnl: 0.05, fees: 0.1, sig: learningSignals(["flat", 0], ["short", 0.6], ["down", 0.7]) },
  { side: "long", entry: 149, exit: 150.4, reason: "trail", pnl: 1.1, fees: 0.12, sig: learningSignals(["long", 0.9], ["long", 0.8], ["up", 0.9]) },
] as const;

async function learningRun(dir: string, json: boolean, gate?: { minSamples?: number; minHitRate?: number; seatWeight?: number }, applyGate?: boolean): Promise<Golden> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  for (let i = 0; i < LEARNING_TRADES.length; i++) {
    const t = LEARNING_TRADES[i]!;
    const g = await capture(() =>
      cmdLearningRecord({
        pair: t.side === "long" ? "SOL/USDT" : "ETH/USDT",
        side: t.side,
        entry: t.entry,
        exit: t.exit,
        exitReason: t.reason,
        pnlUsd: t.pnl,
        feesUsd: t.fees,
        holdingMs: 1_800_000,
        exchange: "kucoin",
        signals: t.sig,
        tape: { atrPct: 0.9, vratio: 0.8 },
        entryAtMs: NOW - 3_600_000 + i * 60_000,
        json,
        logPath: join(dir, "learning.jsonl"),
        storePath: join(dir, "vote.json"),
        gate,
        applyGate,
        now: () => NOW + i * 60_000,
      }),
    );
    out.push(`--- record ${i + 1}`, ...g.out);
    err.push(...g.err);
    exitCode = g.exitCode ?? exitCode;
  }
  return { out, err, exitCode, files: filesOf(dir) };
}

/** The kept pure functions (what degen + learning call) over a fixed matrix. */
function pureMatrix(): unknown {
  const sides: SkillSignal["side"][] = ["long", "short", "flat"];
  const confs = [0.15, 0.5, 0.9];
  const weightSets = [DEFAULT_WEIGHTS, { jev: 0.7, kronos: 1.3, rfdetr: 0.4 }, { jev: 0, kronos: 2, rfdetr: 1 }];
  const ballots: unknown[] = [];
  for (const js of sides)
    for (const ks of sides)
      for (const jc of confs)
        for (const w of weightSets) {
          const signals: SkillSignal[] = [
            { skill: "jev", side: js, confidence: jc, abstained: js === "flat", detail: "j" },
            { skill: "kronos", side: ks, confidence: 1 - jc, abstained: ks === "flat", detail: "k" },
            { skill: "rfdetr", side: "long", confidence: 0.5, abstained: false, detail: "r" },
          ];
          ballots.push(combineBallot(signals, w, "skill"));
          const os: OracleSignal[] = [
            { skill: "kronos", side: ks, confidence: 1 - jc, abstained: ks === "flat", detail: "k" },
            { skill: "laya", side: js, confidence: jc, abstained: js === "flat", detail: "l" },
            { skill: "rfdetr", side: "short", confidence: 0.4, abstained: false, detail: "r" },
          ];
          ballots.push(combineBallot(os, oracleWeights(w), "model"));
        }
  const tune: unknown[] = [];
  for (const start of [0, 0.5, 1.95]) {
    const store = defaultStore();
    store.weights.kronos = start;
    const steps: unknown[] = [];
    for (let i = 0; i < 26; i++) steps.push(recordOutcome(store, "kronos", i % 5 !== 3 && i < 14));
    tune.push({ start, steps, final: store });
  }
  const ledgerText = [0, 1, 2].map((i) => JSON.stringify({ v: 1, kind: "learning.trade", at: "2026-11-10T08:00:00.000Z", pair: "SOL/USDT", side: "long", trade: { entry: 1, exit: 2, netPnlUsd: i === 1 ? -1 : 1 }, signals: { jev: { side: "long" }, laya: { side: "long" }, kronos: { side: "short" }, rfdetr: { side: "flat" } }, outcome: { netPnlUsd: i === 1 ? -1 : 1, scored: { jev: i !== 1, laya: i !== 1, kronos: i === 1 }, abstained: ["rfdetr"] } })).join("\n");
  const stats = summarizeLearningLog(ledgerText, { minSamples: 2, minHitRate: 0.5 });
  const gated: VoteStore = defaultStore();
  const gateChanges = applyPromotionGate(gated, stats, { minSamples: 2, minHitRate: 0.5 });
  return {
    ballots,
    tune,
    learning: { stats, gateChanges, weights: gated.weights },
    oldStore: (() => {
      const sb = makeSandbox("jw3-oq09-old-");
      try {
        return loadStore(seed(sb.dir, "vote.json", OLD_VOTE_STORE));
      } finally {
        sb.cleanup();
      }
    })(),
  };
}

export const CASES: [string, Case][] = [
  /* ── learning ─────────────────────────────────────────────────────── */
  ["learning record x5, default gate, text (+files)", (d) => learningRun(d, false)],
  ["learning record x5, default gate, json (+files)", (d) => learningRun(d, true)],
  ["learning record x5, low gate (seats earned), text (+files)", (d) => learningRun(d, false, { minSamples: 2, minHitRate: 0.5 })],
  ["learning record x5, applyGate off, json (+files)", (d) => learningRun(d, true, undefined, false)],
  ["learning record x5 on the tuned store, low gate, json (+files)", async (d) => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return learningRun(d, true, { minSamples: 3, minHitRate: 0.6, seatWeight: 0.25 });
  }],
  ["learning stats after x5, text", async (d) => {
    await learningRun(d, true, { minSamples: 2, minHitRate: 0.5 });
    return withFiles(d, capture(() => cmdLearningStats({ json: false, logPath: join(d, "learning.jsonl"), storePath: join(d, "vote.json") })));
  }],
  ["learning stats after x5, json", async (d) => {
    await learningRun(d, true);
    return capture(() => cmdLearningStats({ json: true, logPath: join(d, "learning.jsonl"), storePath: join(d, "vote.json"), gate: { minSamples: 2 } }));
  }],
  ["learning stats empty, text", (d) => capture(() => cmdLearningStats({ json: false, logPath: join(d, "learning.jsonl"), storePath: join(d, "vote.json") }))],
  ["learning record bad input", (d) => capture(() => cmdLearningRecord({ pair: "SOL/USDT", side: "up", entry: 1, exit: 2, exitReason: "tp", pnlUsd: 1, feesUsd: 0, json: false, logPath: join(d, "learning.jsonl"), storePath: join(d, "vote.json") }))],

  /* ── decide (Laya fetcher; pair validation lives in decide.ts) ─────── */
  ["decide SOL, json", () => capture(() => cmdDecide({
    pair: "sol/usdt",
    exchange: "kucoin",
    json: true,
    pat: PAT,
    deps: {
      klinesRaw: async () => UP.rows[60]!,
      tickerFull: async () => UP.ticker,
      depth20: async () => UP.depth,
      contractSpec: async () => ({ multiplier: 0.1, tick: 0.01 }),
      jevTrend: async () => trend("strong_long", 0.8),
      now: () => NOW,
    },
    runner: ((stdin: string) => ({ status: 0, stdout: JSON.stringify({ choice: "long", confidence: 0.74, score: 0.61, reasons: [`state ${stdin.length} bytes`], ms: 2 }), stderr: "" })) as BridgeRunner,
  }))],
  ["decide bad pair", () => capture(() => cmdDecide({ pair: "SOLUSDT", exchange: "kucoin", json: false }))],

  /* ── degen (decision producer: vote.json weights → oracle → runLive) ── */
  ["degen preview, default weights, kronos+laya long, text", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: false, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("long", 0.8) }))))],
  ["degen preview, default weights, json", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: true, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("long", 0.8) }))))],
  ["degen fire, default weights (decisions + venue calls)", (d) => withDecisions(
    (call) => cmdDegen(DEGEN_ARGS, { yes: true, json: true, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("long", 0.8) }, { call: call as never })),
    degenVenue,
  ).then((g) => ({ ...g, files: filesOf(d) }))],
  ["degen fire, text (decisions + venue calls)", (d) => withDecisions(
    (call) => cmdDegen(DEGEN_ARGS, { yes: true, json: false, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("long", 0.8) }, { call: call as never })),
    degenVenue,
  ).then((g) => ({ ...g, files: filesOf(d) }))],
  ["degen split models, default weights → oracle flat no-trade, text", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: true, json: false, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("short", 0.5) }))))],
  ["degen split models, tuned store → long fire (decisions + venue calls)", (d) => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return withDecisions(
      (call) => cmdDegen(DEGEN_ARGS, { yes: true, json: true, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("short", 0.5) }, { call: call as never })),
      degenVenue,
    ).then((g) => ({ ...g, files: filesOf(d) }));
  }],
  ["degen short passes the bounce gate, preview json", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: true, pat: PAT }, degenDeps(d, { k: kronos("down", -0.9), l: laya("short", 0.8) }))))],
  ["degen short into the flush (bounce veto), text", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: false, pat: PAT }, degenDeps(d, { k: kronos("down", -0.9), l: laya("short", 0.8) }, { sessionCtx: async () => ({ dayChgPct: -0.3, price: 100, sessionLow: 99.9 }) }))))],
  ["degen both models fail (all abstain → flat), json", (d) => withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: true, pat: PAT }, degenDeps(d, { k: new Error("no torch"), l: new Error("laya down") }))))],
  ["degen old-format store, preview text", (d) => {
    seed(d, "vote.json", OLD_VOTE_STORE);
    return withFiles(d, capture(() => cmdDegen(DEGEN_ARGS, { yes: false, json: false, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("short", 0.5) }))));
  }],
  ["degen paper, tuned store (paper ledger + diary card)", (d) => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return withDecisions(
      (call) => cmdDegen({ ...DEGEN_ARGS, paper: true }, { yes: false, json: true, pat: PAT }, degenDeps(d, { k: kronos("up", 0.6), l: laya("short", 0.5) }, { call: call as never })),
      degenVenue,
    ).then((g) => ({ ...g, files: filesOf(d) }));
  }],

  /* ── the kept pure functions ────────────────────────────────────────── */
  ["pure seat matrix (ballots, auto-tune, learning)", async () => ({ out: [], err: [], exitCode: null, value: JSON.parse(JSON.stringify(pureMatrix())) })],
];


/** Run one case in a fresh sandbox dir; the result is JSON-normalized (what the golden stores). */
export async function runCase(run: Case): Promise<Golden> {
  const sb = makeSandbox("jw3-oq09-case-");
  try {
    return JSON.parse(JSON.stringify(await run(sb.dir))) as Golden;
  } finally {
    sb.cleanup();
  }
}

export function loadGoldens(): Record<string, Golden> {
  return JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, Golden>;
}

export function writeGoldens(goldens: Record<string, Golden>): void {
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(goldens, null, 2)}\n`);
}
