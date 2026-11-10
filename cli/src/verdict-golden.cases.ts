/**
 * OQ-09 golden cases — what the verdict stack decides on fixture inputs
 * (run by verdict-golden.test.ts; kept apart so a sandboxed ablation can
 * replay the same cases).
 *
 * Recorded on the pre-OQ-09 seats (commit "w8(L11d): OQ-09 goldens") and
 * required BYTE-IDENTICAL after the weighting module / track store /
 * rubric-tuning consolidation. Phase 1 changes no decision, so no
 * difference is allowed.
 *
 * Covered:
 *   - every verdict-stack command: vote, vote stats, vote record, oracle,
 *     committee, score stats/report/record, learning record/stats, decide,
 *     harness (stdout, stderr, exit code, and every store file it writes);
 *   - every decision producer that consumes the seats: the harness
 *     (committee + rubric + sizing → runLive) and degen (oracle weights from
 *     vote.json → runLive, plus --paper), with the decision runLive receives
 *     (decision tap) and the exact venue calls it sends;
 *   - the pure seat functions the producers call (ballot combine, auto-tune,
 *     promotion gates, rubric, committee) over a fixed input matrix.
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
  combineWeightedVote,
  cmdVote,
  cmdVoteRecord,
  cmdVoteStats,
  defaultStore,
  jevToSignal,
  kronosToSignal,
  loadStore,
  recordOutcome,
  type SkillSignal,
  type VoteStore,
} from "./commands/vote.js";
import { cmdOracle, combineOracleVote, layaToSignal, oracleWeightsFromStore, type OracleSignal } from "./commands/oracle.js";
import {
  DEFAULT_COMMITTEE_PARAMS,
  DEFAULT_SEATS,
  cmdCommittee,
  committeeModelLegs,
  runCommittee,
  type CommitteeModelLegs,
} from "./commands/committee.js";
import {
  autoTuneWeight,
  cmdScoreRecord,
  cmdScoreReport,
  cmdScoreStats,
  gatesFor,
  loadScoreStore,
  projectVotePatches,
  scoreTrade,
} from "./commands/score.js";
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
import { SCENARIO_TABLE, cmdHarness, defaultHarnessConfig, runScenarioRow, type ModelVerdict, type ScenarioRow } from "./commands/harness.js";
import { applyRubric } from "./commands/rubric.js";
import { cmdDegen, type DegenArgs, type DegenDeps } from "./commands/degen.js";
import { tapLiveDecisions, type DecisionRecord } from "./commands/live.js";
import { defaultFilterConfig } from "./filters.js";
import { parseKlineRows } from "./commands/klines.js";
import type { TrendVerdict } from "./commands/analyze.js";
import type { ForecastVerdict } from "./commands/forecast.js";
import type { FadeRow, SpikeDepth, SpikeTicker } from "./kucoin.js";

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
/** 12:00Z — inside the CPI blackout. */
const CPI_NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
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
/* score.json fixture — built as plain data, independent of score.ts   */
/* ------------------------------------------------------------------ */

type FixtureOutcome = { at: string; pair: string; tradeSide: "long" | "short"; signalSide: "long" | "short"; confidence: number; hit: boolean; netPnlUsd: number };

function scoreCardFixture(model: string, pattern: string, pnlWin: number, pnlLoss: number) {
  const history: FixtureOutcome[] = [];
  const sides = {
    long: { total: 0, hits: 0, results: [] as boolean[], pnlUsd: 0, pnlWhenHitUsd: 0, pnlWhenMissUsd: 0 },
    short: { total: 0, hits: 0, results: [] as boolean[], pnlUsd: 0, pnlWhenHitUsd: 0, pnlWhenMissUsd: 0 },
  };
  const pnl = { netUsd: 0, whenHitUsd: 0, whenMissUsd: 0 };
  let hits = 0;
  const results: boolean[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const hit = pattern[i] === "1";
    const side: "long" | "short" = i % 3 === 0 ? "short" : "long";
    const net = Math.round((hit ? pnlWin + i * 0.01 : -pnlLoss - i * 0.01) * 100) / 100;
    const at = new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString();
    history.push({ at, pair: i % 2 === 0 ? "SOL/USDT" : "ETH/USDT", tradeSide: side, signalSide: side, confidence: 0.6, hit, netPnlUsd: net });
    if (hit) hits++;
    results.push(hit);
    const s = sides[side];
    s.total++;
    if (hit) s.hits++;
    s.results.push(hit);
    s.pnlUsd += net;
    if (hit) s.pnlWhenHitUsd += net;
    else s.pnlWhenMissUsd += net;
    pnl.netUsd += net;
    if (hit) pnl.whenHitUsd += net;
    else pnl.whenMissUsd += net;
  }
  sides.long.results = sides.long.results.slice(-20);
  sides.short.results = sides.short.results.slice(-20);
  return { model, total: pattern.length, hits, results: results.slice(-20), sides, pnl, history };
}

const P_JEV = "1101101110110111011011101101110110111011"; // 40 outcomes, ~70%
const P_LAYA = "1011011010110110101101101101011011"; // 34 outcomes, ~62%
const P_KRONOS = "10010100110010100100"; // 20 outcomes, 40%

const SCORE_STORE = {
  version: 1,
  models: {
    jev: scoreCardFixture("jev", P_JEV, 1.4, 0.9),
    laya: scoreCardFixture("laya", P_LAYA, 1.1, 1.0),
    kronos: scoreCardFixture("kronos", P_KRONOS, 0.8, 1.2),
    rfdetr: scoreCardFixture("rfdetr", "", 0, 0),
  },
  tracks: {
    jev: { results: [true, true, false, true, true, true, false, true, true, false, true, true, false, true, true, true, false, true, true, true], hits: 52, total: 74 },
    kronos: { results: [true, false, false, true, false, true, false, false, true, true, false, false, true, false, true, false, false, true, false, false], hits: 8, total: 20 },
    rfdetr: { results: [], hits: 0, total: 0 },
  },
  weights: { jev: 1.2, kronos: 0.3, rfdetr: 0 },
  updatedAt: "2026-11-09T22:00:00.000Z",
};

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
const DOWN = tape("ETHUSDTM", 202, 2600, -0.1, { chg: -1.6, vslope: "down", offHighPct: 3.9, offLowPct: 0.9, fundingPct: -0.012 }, false);
const CROWDED = tape("SOLUSDTM", 101, 140, 0.12, { fundingPct: 0.25 });

function committeeDeps(t: Tape, extra: Record<string, unknown> = {}) {
  return {
    fade: async () => t.fade,
    klines: async (_s: string, gran: number) => {
      const rows = t.rows[gran];
      if (!rows) throw new Error(`no fixture for granularity ${gran}`);
      return rows;
    },
    ticker: async () => t.ticker,
    depth20: async () => t.depth,
    contractSpec: async () => ({ multiplier: 0.1, tick: 0.01 }),
    jevTrend: async () => trend("strong_long", 0.8),
    now: () => NOW,
    ...extra,
  };
}

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

const vote = (dir: string, o: { pair?: string; pat?: string | undefined; jev?: TrendVerdict | Error | null; k?: ForecastVerdict | Error | null; json: boolean; store?: unknown }) =>
  withFiles(
    dir,
    (async () => {
      if (o.store !== undefined) seed(dir, "vote.json", o.store);
      return capture(() =>
        cmdVote({
          pair: o.pair ?? "SOL/USDT",
          exchange: "kucoin",
          horizon: 12,
          json: o.json,
          pat: "pat" in o ? o.pat : PAT,
          storePath: join(dir, "vote.json"),
          deps: {
            jevTrend: async () => {
              if (o.jev instanceof Error) throw o.jev;
              // fetchJevTrend never resolves null by type; the ballot maps a null read to an abstain.
              return (o.jev ?? null) as TrendVerdict;
            },
            kronos: async () => {
              if (o.k instanceof Error) throw o.k;
              return o.k as ForecastVerdict;
            },
          },
        }),
      );
    })(),
  );

const oracle = (
  dir: string,
  o: {
    pair?: string;
    json: boolean;
    store?: unknown;
    k?: ForecastVerdict | Error | null;
    l?: LayaVerdict | Error | null;
    rf?: OracleSignal | Error;
    chart?: string;
    ctx?: Record<string, number> | Error;
    nowMs?: number;
    pat?: string | undefined;
  },
) =>
  withFiles(
    dir,
    (async () => {
      if (o.store !== undefined) seed(dir, "vote.json", o.store);
      return capture(() =>
        cmdOracle({
          pair: o.pair ?? "SOL/USDT",
          exchange: "kucoin",
          horizon: 12,
          json: o.json,
          pat: "pat" in o ? o.pat : PAT,
          storePath: join(dir, "vote.json"),
          chartPath: o.chart,
          deps: {
            nowMs: o.nowMs ?? NOW,
            kronos: async () => {
              if (o.k instanceof Error) throw o.k;
              return o.k as ForecastVerdict;
            },
            marketState: async () => STATE,
            laya: async () => {
              if (o.l instanceof Error) throw o.l;
              return o.l as LayaVerdict;
            },
            rfdetr: async () => {
              if (o.rf instanceof Error) throw o.rf;
              return o.rf ?? { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: "no chart" };
            },
            sessionCtx: async () => {
              if (o.ctx instanceof Error) throw o.ctx;
              return o.ctx ?? { dayChgPct: 0.5, price: 150, sessionLow: 148 };
            },
          },
        }),
      );
    })(),
  );

const RF_LONG_SIGNAL: OracleSignal = { skill: "rfdetr", side: "long", confidence: 0.82, abstained: false, detail: "double_bottom long conf 0.82" };

const TUNED_LEGS: CommitteeModelLegs = {
  voteSignals: [jevToSignal(trend("strong_long", 0.7)), kronosToSignal(kronos("down", -0.9))],
  voteWeights: { jev: 0.7, kronos: 1.3, rfdetr: 0.4 },
  oracleSignals: [layaToSignal(laya("short", 0.55)), { skill: "kronos", side: "short", confidence: 0.9, abstained: false, detail: "down 0.90%" }],
  oracleWeights: { kronos: 1.3, laya: 0.7, rfdetr: 0.4 },
};

const committee = (o: { pair?: string; side?: "long" | "short"; json: boolean; t?: Tape; deps?: Record<string, unknown>; size?: number; pat?: string | undefined }) =>
  capture(() =>
    cmdCommittee({
      pair: o.pair ?? "SOL/USDT",
      exchange: "kucoin",
      json: o.json,
      side: o.side,
      size: o.size,
      pat: "pat" in o ? o.pat : PAT,
      deps: committeeDeps(o.t ?? UP, o.deps ?? {}) as never,
    }),
  );

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

/** Harness rows whose models DISAGREE, so the ballot weights decide the momentum leg. */
function splitRow(base: ScenarioRow, name: string, models: ModelVerdict[]): ScenarioRow {
  return { ...base, name, given: { ...base.given, name, models } };
}

const HARNESS_EXTRA: ScenarioRow[] = [
  splitRow(SCENARIO_TABLE[0]!, "golden-long-kronos-dissents", [
    { id: "jev", side: "long", confidence: 0.9, detail: "strong_long 90%" },
    { id: "laya", side: "long", confidence: 0.55, detail: "long conf 0.55" },
    { id: "kronos", side: "short", confidence: 0.8, detail: "down 0.80%" },
    { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
  ]),
  splitRow(SCENARIO_TABLE[0]!, "golden-long-jev-only", [
    { id: "jev", side: "long", confidence: 0.6, detail: "long 60%" },
    { id: "laya", side: "flat", confidence: 0, detail: "flat" },
    { id: "kronos", side: "flat", confidence: 0, detail: "flat" },
    { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
  ]),
  splitRow(SCENARIO_TABLE[1]!, "golden-short-laya-dissents", [
    { id: "jev", side: "short", confidence: 0.7, detail: "strong_short 70%" },
    { id: "laya", side: "long", confidence: 0.75, detail: "long conf 0.75" },
    { id: "kronos", side: "short", confidence: 0.95, detail: "down 0.95%" },
    { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
  ]),
];

async function harnessRows(rows: ScenarioRow[]): Promise<Golden> {
  const decisions: DecisionRecord[] = [];
  tapLiveDecisions((d) => decisions.push(d));
  try {
    const cfg = defaultHarnessConfig(defaultFilterConfig());
    const value: unknown[] = [];
    const g = await capture(async () => {
      for (const row of rows) {
        const o = await runScenarioRow(row, cfg);
        value.push(JSON.parse(JSON.stringify({ name: row.name, result: o.result, errors: o.errors, calls: o.calls })));
      }
    });
    return { ...g, decisions, value };
  } finally {
    tapLiveDecisions(null);
  }
}

/** Pure seat functions over a fixed matrix (the producers call these). */
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
          ballots.push(combineWeightedVote(signals, w));
          const os: OracleSignal[] = [
            { skill: "kronos", side: ks, confidence: 1 - jc, abstained: ks === "flat", detail: "k" },
            { skill: "laya", side: js, confidence: jc, abstained: js === "flat", detail: "l" },
            { skill: "rfdetr", side: "short", confidence: 0.4, abstained: false, detail: "r" },
          ];
          ballots.push(combineOracleVote(os, oracleWeightsFromStore(w)));
        }
  const tune: unknown[] = [];
  for (const start of [0, 0.5, 1.95]) {
    const store = defaultStore();
    store.weights.kronos = start;
    const steps: unknown[] = [];
    for (let i = 0; i < 26; i++) steps.push(recordOutcome(store, "kronos", i % 5 !== 3 && i < 14));
    tune.push({ start, steps, final: store });
  }
  const tuneScore: unknown[] = [];
  for (const before0 of [-1, 0, 0.55, 2.4, Number.NaN]) {
    for (const window of [[true], [true, true, true, false, false], [true, true, false, false, false], [false, false, false, false, false, true]]) {
      tuneScore.push({ before: String(before0), window, after: autoTuneWeight(window, before0) });
    }
  }
  const store = loadScoreStore("/nonexistent/score.json");
  const traded = scoreTrade(store, {
    pair: "SOL/USDT",
    side: "long",
    signals: [
      { model: "jev", side: "long", confidence: 0.8 },
      { model: "laya", side: "short", confidence: 0.6 },
      { model: "kronos", side: "long", confidence: 0.5 },
      { model: "rfdetr", side: "flat", confidence: 0 },
    ],
    netPnlUsd: 1.5,
    at: "2026-11-10T08:00:00.000Z",
  });
  const legs = committeeModelLegs({ jev: trend("strong_long", 0.8), kronos: kronos("down", -0.7), laya: laya("long", 0.6) });
  const rubricInputs = [
    { seats: [{ seat: "a", side: "long", confidence: 0.8, reason: "a" }, { seat: "b", side: "long", confidence: 0.7, reason: "b" }] },
    {
      seats: [{ seat: "a", side: "long", confidence: 0.9, reason: "a" }, { seat: "b", side: "long", confidence: 0.8, reason: "b" }, { seat: "c", side: "short", confidence: 0.5, reason: "c" }],
      setup: { targetDistancePct: 1.2, stopDistancePct: 0.8, hitProbability: 0.6, atrPct: 0.9, spreadBps: 2, liquidityUsd: 60000, distanceFromExtremePct: 3.5, feeRatePerSide: 0.0006 },
      modelStats: { a: { hitRate: 0.6, samples: 30 }, c: { hitRate: 0.72, samples: 40 } },
    },
    {
      seats: [{ seat: "a", side: "short", confidence: 0.95, reason: "a" }, { seat: "b", side: "short", confidence: 0.9, reason: "b" }],
      setup: { targetDistancePct: 2, stopDistancePct: 1, hitProbability: 0.7, atrPct: 0.1, spreadBps: 1, liquidityUsd: 80000, distanceFromExtremePct: 4, feeRatePerSide: 0.0002 },
    },
    {
      seats: [{ seat: "a", side: "long", confidence: 0.9, reason: "a", veto: true, vetoReason: "event" }, { seat: "b", side: "long", confidence: 0.9, reason: "b" }],
      setup: { targetDistancePct: 2, stopDistancePct: 1, hitProbability: 0.7, atrPct: 1, spreadBps: 1, liquidityUsd: 80000, distanceFromExtremePct: 4 },
    },
  ] as const;
  const rubric = rubricInputs.map((input) => applyRubric(input as never));
  const committeeRuns = [UP, DOWN].map((t, i) => {
    const candles = parseKlineRows;
    const last = t.ticker.price;
    const side = i === 0 ? "long" : "short";
    return runCommittee({
      proposal: { pair: i === 0 ? "SOL/USDT" : "ETH/USDT", side, entry: last, stop: side === "long" ? last * 0.99 : last * 1.01, target: side === "long" ? last * 1.015 : last * 0.985, size: 1 },
      market: {
        pair: i === 0 ? "SOL/USDT" : "ETH/USDT",
        last,
        timeframes: [
          { tf: "1h", candles: candles(t.rows[60]!) },
          { tf: "4h", candles: candles(t.rows[240]!) },
          { tf: "1d", candles: candles(t.rows[1440]!) },
        ],
        high24: last * 1.014,
        low24: last * 0.956,
        atrPct: 0.9,
        vwap: last * 0.998,
        ema20: last * 0.997,
        rsi: i === 0 ? 61 : 38,
        volRatio: 1.2,
        volSlope: i === 0 ? "up" : "down",
        book: { bidUsd: i === 0 ? 40000 : 15000, askUsd: i === 0 ? 15000 : 40000, imbalance: i === 0 ? 0.45 : -0.45, spreadBps: 1.5 },
        fundingPct: 0.01,
        dayChgPct: i === 0 ? 2.1 : -1.6,
        sessionLow: last * 0.99,
        nowMs: NOW,
        accountUsd: 500,
        notionalUsd: 200,
        jev: trend(i === 0 ? "strong_long" : "strong_short", 0.8),
        models: i === 0 ? legs : TUNED_LEGS,
      },
      params: DEFAULT_COMMITTEE_PARAMS,
    }, { seats: DEFAULT_SEATS });
  });
  const ledgerText = [0, 1, 2].map((i) => JSON.stringify({ v: 1, kind: "learning.trade", at: "2026-11-10T08:00:00.000Z", pair: "SOL/USDT", side: "long", trade: { entry: 1, exit: 2, netPnlUsd: i === 1 ? -1 : 1 }, signals: { jev: { side: "long" }, laya: { side: "long" }, kronos: { side: "short" }, rfdetr: { side: "flat" } }, outcome: { netPnlUsd: i === 1 ? -1 : 1, scored: { jev: i !== 1, laya: i !== 1, kronos: i === 1 }, abstained: ["rfdetr"] } })).join("\n");
  const stats = summarizeLearningLog(ledgerText, { minSamples: 2, minHitRate: 0.5 });
  const gated: VoteStore = defaultStore();
  const gateChanges = applyPromotionGate(gated, stats, { minSamples: 2, minHitRate: 0.5 });
  const fixtureScore = loadScoreStore("/nonexistent/score.json");
  return {
    ballots,
    tune,
    tuneScore,
    scoreTrade: { outcome: traded.outcome, scored: traded.scored, skipped: traded.skipped, gates: traded.gates, store: traded.store },
    gates: gatesFor(fixtureScore),
    patches: projectVotePatches(traded.store, { minSamples: 1, hitFloor: 0.5 }),
    legs,
    rubric,
    committee: committeeRuns,
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
  /* ── vote ─────────────────────────────────────────────────────────── */
  ["vote SOL jev-long vs kronos-short, default store, text", (d) => vote(d, { jev: trend("strong_long", 0.8), k: kronos("down", -0.5), json: false })],
  ["vote SOL jev-long vs kronos-short, default store, json", (d) => vote(d, { jev: trend("strong_long", 0.8), k: kronos("down", -0.5), json: true })],
  ["vote SOL jev-long vs kronos-short, tuned store, text", (d) => vote(d, { jev: trend("strong_long", 0.8), k: kronos("down", -0.5), json: false, store: TUNED_VOTE_STORE })],
  ["vote SOL jev-long vs kronos-short, tuned store, json", (d) => vote(d, { jev: trend("strong_long", 0.8), k: kronos("down", -0.5), json: true, store: TUNED_VOTE_STORE })],
  ["vote ETH both short, tuned store, text", (d) => vote(d, { pair: "eth/usdt", jev: trend("short", 0.62), k: kronos("down", -1.7), json: false, store: TUNED_VOTE_STORE })],
  ["vote weak split inside the threshold (flat), text", (d) => vote(d, { jev: trend("long", 0.3), k: kronos("down", -0.55), json: false })],
  ["vote kronos throws (jev alone), json", (d) => vote(d, { jev: trend("bullish", 0.66), k: new Error("kronos bridge exit 1: no torch"), json: true })],
  ["vote jev throws + kronos up, text", (d) => vote(d, { jev: new Error("rate_limited"), k: kronos("up", 0.35), json: false })],
  ["vote jev uncertain + kronos flat (all abstain), text", (d) => vote(d, { jev: trend("uncertain", 0.4, true), k: kronos("flat", 0.02), json: false })],
  ["vote no PAT + kronos up, json", (d) => vote(d, { pat: undefined, k: kronos("up", 1.4), json: true })],
  ["vote old-format store, text", (d) => vote(d, { jev: trend("strong_short", 0.7), k: kronos("up", 0.2), json: false, store: OLD_VOTE_STORE })],
  ["vote corrupt store, json", (d) => vote(d, { jev: trend("strong_long", 0.7), k: kronos("up", 0.2), json: true, store: "{not json" })],
  ["vote bad pair", (d) => vote(d, { pair: "SOLUSDT", jev: trend("long", 0.8), k: kronos("up", 0.4), json: false })],
  ["vote stats tuned store, text", (d) => withFiles(d, (async () => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return capture(() => cmdVoteStats({ json: false, storePath: join(d, "vote.json") }));
  })())],
  ["vote stats tuned store, json", (d) => withFiles(d, (async () => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return capture(() => cmdVoteStats({ json: true, storePath: join(d, "vote.json") }));
  })())],
  ["vote stats empty store, text", (d) => capture(() => cmdVoteStats({ json: false, storePath: join(d, "vote.json") }))],
  ["vote record long (hits promote), text", (d) => withFiles(d, (async () => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return capture(() => cmdVoteRecord({ pair: "SOL/USDT", outcome: "long", json: false, storePath: join(d, "vote.json") }));
  })())],
  ["vote record short (misses), json", (d) => withFiles(d, (async () => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return capture(() => cmdVoteRecord({ pair: "sol/usdt", outcome: "SHORT", json: true, storePath: join(d, "vote.json") }));
  })())],
  ["vote record no open ballot", (d) => withFiles(d, (async () => {
    seed(d, "vote.json", TUNED_VOTE_STORE);
    return capture(() => cmdVoteRecord({ pair: "ETH/USDT", outcome: "long", json: false, storePath: join(d, "vote.json") }));
  })())],
  ["vote record bad outcome", (d) => capture(() => cmdVoteRecord({ pair: "SOL/USDT", outcome: "up", json: false, storePath: join(d, "vote.json") }))],
  ["vote then record then vote (the loop), text", (d) => withFiles(d, (async () => {
    const out: string[] = [];
    const err: string[] = [];
    for (let i = 0; i < 7; i++) {
      const v = await vote(d, { jev: trend(i % 3 === 2 ? "short" : "strong_long", 0.5 + i * 0.05), k: kronos(i % 2 === 0 ? "up" : "down", 0.4 + i * 0.1), json: false });
      out.push(`--- vote ${i + 1}`, ...v.out);
      err.push(...v.err);
      const r = await capture(() => cmdVoteRecord({ pair: "SOL/USDT", outcome: i % 4 === 3 ? "short" : "long", json: false, storePath: join(d, "vote.json") }));
      out.push(`--- record ${i + 1}`, ...r.out);
      err.push(...r.err);
    }
    const s = await capture(() => cmdVoteStats({ json: false, storePath: join(d, "vote.json") }));
    return { out: [...out, "--- stats", ...s.out], err: [...err, ...s.err], exitCode: s.exitCode };
  })())],

  /* ── oracle ───────────────────────────────────────────────────────── */
  ["oracle kronos-long vs laya-short, default store, text", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("short", 0.7), json: false })],
  ["oracle kronos-long vs laya-short, default store, json", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("short", 0.7), json: true })],
  ["oracle kronos-long vs laya-short, tuned store, text", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("short", 0.7), json: false, store: TUNED_VOTE_STORE })],
  ["oracle kronos-long vs laya-short, tuned store, json", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("short", 0.7), json: true, store: TUNED_VOTE_STORE })],
  ["oracle both long + rfdetr chart vote, tuned store, text", (d) => oracle(d, { k: kronos("up", 0.3), l: laya("long", 0.62), rf: RF_LONG_SIGNAL, chart: "/fixture/chart.png", json: false, store: TUNED_VOTE_STORE })],
  ["oracle rfdetr fails with chart, json", (d) => oracle(d, { k: kronos("up", 0.3), l: laya("long", 0.62), rf: new Error("rfdetr bridge exit 2"), chart: "/fixture/chart.png", json: true })],
  ["oracle short clamped by extended drop, text", (d) => oracle(d, { k: kronos("down", -0.8), l: laya("short", 0.8), ctx: { dayChgPct: -3.1, price: 150, sessionLow: 149.8 }, json: false })],
  ["oracle short clamped by no bounce, json", (d) => oracle(d, { k: kronos("down", -0.8), l: laya("short", 0.8), ctx: { dayChgPct: -0.5, price: 150, sessionLow: 149.9 }, json: true })],
  ["oracle short passes the bounce, text", (d) => oracle(d, { k: kronos("down", -0.8), l: laya("short", 0.8), ctx: { dayChgPct: -0.5, price: 150, sessionLow: 148.5 }, json: false })],
  ["oracle session ctx fails, text", (d) => oracle(d, { k: kronos("down", -0.8), l: laya("short", 0.8), ctx: new Error("klines down"), json: false })],
  ["oracle cpi blackout veto, text", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("long", 0.7), nowMs: CPI_NOW, json: false })],
  ["oracle cpi blackout veto, json", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("long", 0.7), nowMs: CPI_NOW, json: true })],
  ["oracle btc fee veto, text", (d) => oracle(d, { pair: "BTC/USDT", k: kronos("up", 0.6), l: laya("long", 0.7), json: false })],
  ["oracle kronos + laya fail (all abstain)", (d) => oracle(d, { k: new Error("spawn"), l: new Error("laya bridge exit 1"), json: false })],
  ["oracle no PAT note, text", (d) => oracle(d, { pat: undefined, k: kronos("up", 0.6), l: laya("long", 0.5), json: false })],
  ["oracle old-format store, json", (d) => oracle(d, { k: kronos("up", 0.6), l: laya("short", 0.7), json: true, store: OLD_VOTE_STORE })],
  ["oracle bad pair", (d) => oracle(d, { pair: "SOL-USDT", k: kronos("up", 0.6), l: laya("short", 0.7), json: false })],

  /* ── committee ────────────────────────────────────────────────────── */
  ["committee SOL long (CLI: no model legs), text", () => committee({ json: false })],
  ["committee SOL long (CLI: no model legs), json", () => committee({ json: true })],
  ["committee SOL short proposal, text", () => committee({ side: "short", json: false })],
  ["committee ETH down tape short, json", () => committee({ pair: "ETH/USDT", side: "short", json: true, t: DOWN, deps: { jevTrend: async () => trend("strong_short", 0.75) } })],
  ["committee SOL with raw model verdicts + kronos, json", () => committee({ json: true, size: 3, deps: { rawVerdicts: { laya: laya("long", 0.66) }, kronos: async () => kronos("down", -0.45) } })],
  ["committee SOL with raw model verdicts + kronos, text", () => committee({ json: false, size: 3, deps: { rawVerdicts: { laya: laya("long", 0.66) }, kronos: async () => kronos("down", -0.45) } })],
  ["committee SOL with tuned model legs, json", () => committee({ json: true, deps: { models: async () => TUNED_LEGS } })],
  ["committee ETH with tuned model legs, text", () => committee({ pair: "ETH/USDT", side: "short", json: false, t: DOWN, deps: { models: async () => TUNED_LEGS } })],
  ["committee crowded funding veto, text", () => committee({ json: false, t: CROWDED })],
  ["committee no PAT (no JEV leg), json", () => committee({ json: true, pat: undefined })],
  ["committee tape fails", () => committee({ json: false, deps: { fade: async () => { throw new Error("tape down"); } } })],
  ["committee bad pair", () => committee({ pair: "SOL", json: false })],

  /* ── score ────────────────────────────────────────────────────────── */
  ["score stats fixture store, text", (d) => withFiles(d, (async () => {
    seed(d, "score.json", SCORE_STORE);
    return capture(() => cmdScoreStats({ json: false, storePath: join(d, "score.json") }));
  })())],
  ["score stats fixture store, json", (d) => withFiles(d, (async () => {
    seed(d, "score.json", SCORE_STORE);
    return capture(() => cmdScoreStats({ json: true, storePath: join(d, "score.json") }));
  })())],
  ["score stats empty store, text", (d) => capture(() => cmdScoreStats({ json: false, storePath: join(d, "score.json") }))],
  ["score report fixture store, text", (d) => withFiles(d, (async () => {
    seed(d, "score.json", SCORE_STORE);
    return capture(() => cmdScoreReport({ json: false, storePath: join(d, "score.json") }));
  })())],
  ["score report fixture store holdout 10, json", (d) => withFiles(d, (async () => {
    seed(d, "score.json", SCORE_STORE);
    return capture(() => cmdScoreReport({ json: true, storePath: join(d, "score.json"), holdoutSize: 10 }));
  })())],
  ["score record from a vote ballot, text", (d) => withFiles(d, (async () => {
    seed(d, "score.json", SCORE_STORE);
    const voteStore = JSON.parse(JSON.stringify(TUNED_VOTE_STORE)) as VoteStore;
    return capture(() => cmdScoreRecord({ pair: "sol/usdt", side: "long", pnl: 2.4, json: false, storePath: join(d, "score.json"), voteStore }));
  })())],
  ["score record loss into an empty store, json", (d) => withFiles(d, (async () => {
    const voteStore = JSON.parse(JSON.stringify(TUNED_VOTE_STORE)) as VoteStore;
    return capture(() => cmdScoreRecord({ pair: "ETH/USDT", pnl: -1.1, json: true, storePath: join(d, "score.json"), voteStore }));
  })())],
  ["score record breakeven (nothing scored), text", (d) => withFiles(d, (async () => {
    const voteStore = JSON.parse(JSON.stringify(TUNED_VOTE_STORE)) as VoteStore;
    return capture(() => cmdScoreRecord({ pair: "SOL/USDT", side: "short", pnl: 0, json: false, storePath: join(d, "score.json"), voteStore }));
  })())],
  ["score record without a vote store (the CLI route)", (d) => capture(() => cmdScoreRecord({ pair: "SOL/USDT", side: "long", pnl: 1, json: false, storePath: join(d, "score.json") }))],
  ["score record no ballot for the pair", (d) => capture(() => cmdScoreRecord({ pair: "AVAX/USDT", pnl: 1, json: false, storePath: join(d, "score.json"), voteStore: JSON.parse(JSON.stringify(TUNED_VOTE_STORE)) as VoteStore }))],

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

  /* ── decide (Laya fetcher; pair validation lives in vote.ts) ───────── */
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

  /* ── harness (decision producer: committee + rubric + sizing → runLive) ── */
  ["harness command, text", async () => {
    const decisions: DecisionRecord[] = [];
    tapLiveDecisions((x) => decisions.push(x));
    try {
      return { ...(await capture(() => cmdHarness({ json: false }))), decisions };
    } finally {
      tapLiveDecisions(null);
    }
  }],
  ["harness command, json", () => capture(() => cmdHarness({ json: true }))],
  ["harness scenario table (full results + decisions)", () => harnessRows(SCENARIO_TABLE)],
  ["harness split-model rows (weights decide momentum)", () => harnessRows(HARNESS_EXTRA)],

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

  /* ── the pure seat functions ──────────────────────────────────────── */
  ["pure seat matrix (ballots, auto-tune, gates, rubric, committee, learning)", async () => ({ out: [], err: [], exitCode: null, value: JSON.parse(JSON.stringify(pureMatrix())) })],
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
