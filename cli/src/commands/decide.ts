/**
 * `jw3 decide --pair X` — market-state → Laya choice (READ-ONLY, no trades).
 *
 * Builds one market-state JSON per pair and hands it to the Laya decide
 * bridge (`python/laya_decide.py`, pure stdlib, v0 rule weights documented
 * in its header and ~/laya/CALIBRATION.md):
 *   tape — trailing-24h stats off 60x1h KuCoin futures klines (chg, volume
 *            ratio/slope, distance from high/low, ATR%) via fadeMetrics
 *   jev  — JEV 7-timeframe trend features (side/agreement/uncertain) via
 *            analyze_market; null when unauthenticated or on failure
 *   book — top-5 notional imbalance + spread off ticker + depth20
 *            (public reads); null when the book read fails
 * Laya returns long/short/flat with a calibrated confidence; the command
 * only prints the verdict. Nothing here proposes, executes, or closes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePat } from "../config.js";
import {
  fadeMetrics,
  futuresContractSpec,
  futuresDepth20,
  futuresKlines,
  futuresKlinesRaw,
  futuresTickerFull,
  spikeImbalance,
  spikeNotionals,
  spikeSpreadBps,
} from "../kucoin.js";
import { fetchJevTrend, type TrendVerdict } from "./analyze.js";
import { forecastSymbolForPair } from "./forecast.js";
import { klinesSymbolForPair, parseKlineRows } from "./klines.js";
import type { PrefilterCtx } from "../blocking-rules.js";

/** Pure: `SOL/USDT` usable, uppercase-normalized. Null = reject with usage. */
export function validateVotePair(pair: string): string | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return "pair required (e.g. SOL/USDT)";
  const base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(base) || quote !== "USDT") return "pair required (e.g. SOL/USDT)";
  return null;
}

export function normalizeVotePair(pair: string): string {
  const [b, q] = pair.split("/");
  return `${(b ?? "").trim().toUpperCase()}/${(q ?? "").trim().toUpperCase()}`;
}

export type DecideChoice = "long" | "short" | "flat";

export type TapeStats = {
  chg: number;
  vratio: number;
  vslope: "up" | "down";
  offHighPct: number;
  offLowPct: number;
  atrPct: number | null;
  n: number;
};

export type BookStats = {
  mid: number;
  sprBps: number;
  bid5Usd: number;
  ask5Usd: number;
  imb: number;
};

export type JevFeatures = {
  side: DecideChoice;
  agreement: number;
  uncertain: boolean;
  verdict: string;
};

export type MarketState = {
  pair: string;
  symbol: string;
  last: number;
  tape: TapeStats;
  book: BookStats | null;
  jev: JevFeatures | null;
  jevNote?: string;
};

export type LayaVerdict = {
  choice: DecideChoice;
  confidence: number;
  score: number;
  reasons: string[];
  ms: number;
};

/** 60x1h trailing window, same tape `scan fade` reads. */
export const DECIDE_KLINES = 60;
export const DECIDE_GRANULARITY_MIN = 60;
/** JEV missing/uncertain caps confidence — a verdict without its lead leg is a guess. */
export const DECIDE_JEVLESS_CONF_CAP = 0.65;

const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: pair → futures symbol (BTC aliases XBT, USDT only). Null = reject with usage. */
export function decideSymbolForPair(pair: string): string | null {
  return forecastSymbolForPair(pair);
}

export function validateDecidePair(pair: string): string | null {
  return validateVotePair(pair);
}

/**
 * Pure: JEV trend → decide features. Only certain directional verdicts
 * take a side — uncertain/neutral/unknown collapse to side "none" with the
 * uncertainty flagged so the bridge down-weights them.
 *
 * The server's verdict vocabulary is long/short/strong_long/strong_short
 * (combineTrendVerdict in edge _shared/jev.ts). Matching only "bull"/"bear"
 * made the JEV leg report FLAT on every directional verdict, so the Laya
 * bridge never got the model's direction. Accept both vocabularies.
 */
export function jevToFeatures(t: TrendVerdict | null): JevFeatures | null {
  if (!t) return null;
  const trend = t.verdict?.trend;
  if (!trend) return null;
  const v = trend.verdict.toLowerCase();
  const dir: DecideChoice =
    v.includes("bull") || v.includes("long") ? "long" : v.includes("bear") || v.includes("short") ? "short" : "flat";
  return {
    side: trend.uncertain ? "flat" : dir,
    agreement: isFin(trend.agreement) ? Math.min(Math.max(trend.agreement, 0), 1) : 0,
    uncertain: trend.uncertain,
    verdict: trend.verdict,
  };
}

/** Bridge side for the state JSON: a flat/neutral JEV call is "none", not a direction. */
export function jevSideForBridge(f: JevFeatures | null): "long" | "short" | "none" {
  if (!f || f.uncertain) return "none";
  return f.side === "long" || f.side === "short" ? f.side : "none";
}

/**
 * One cheap data fetch (single 5m klines window, ~1s) for the
 * data-dependent short vetoes: trailing-24h change (extended-drop) +
 * 60-min session low and last price (bounce-required). Data only — never
 * model inference. On fetch failure returns {} (fail-open for the advisor
 * oracle, noted in output; the side-aware fast loop fails closed instead).
 */
export async function fetchSessionCtx(pair: string): Promise<PrefilterCtx> {
  const symbol = klinesSymbolForPair(pair);
  if (!symbol) return {};
  try {
    const now = Date.now();
    const rows = await futuresKlines(symbol, 5, now - 288 * 5 * 60 * 1000, now);
    const candles = parseKlineRows(rows);
    if (candles.length < 13) return {};
    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1]!;
    const first = closes[0]!;
    const dayChgPct = ((last - first) / first) * 100;
    const session = candles.slice(-12); // last 60min mirrors bounce default lookback
    const sessionLow = Math.min(...session.map((c) => c.low));
    return { dayChgPct, price: last, sessionLow };
  } catch {
    return {};
  }
}

export type DecideDeps = {
  klinesRaw?: typeof futuresKlinesRaw;
  tickerFull?: typeof futuresTickerFull;
  depth20?: typeof futuresDepth20;
  contractSpec?: typeof futuresContractSpec;
  jevTrend?: typeof fetchJevTrend;
  now?: () => number;
};

/**
 * Build the market-state JSON for `pair`. Public tape+book reads always run;
 * JEV features attach only when a PAT resolves (else jev is null with a note).
 * Throws when the tape itself is too thin — never invents a state.
 */
export async function buildMarketState(
  pair: string,
  exchange: string,
  opts: { url?: string; pat?: string },
  deps: DecideDeps = {},
): Promise<MarketState> {
  const norm = normalizeVotePair(pair);
  const sym = decideSymbolForPair(norm);
  if (!sym) throw new Error(`bad pair ${pair} (want BASE/USDT)`);
  const klinesRaw = deps.klinesRaw ?? futuresKlinesRaw;
  const tickerFull = deps.tickerFull ?? futuresTickerFull;
  const depth20 = deps.depth20 ?? futuresDepth20;
  const contractSpec = deps.contractSpec ?? futuresContractSpec;
  const jevTrend = deps.jevTrend ?? fetchJevTrend;
  const now = (deps.now ?? Date.now)();

  const spanMs = DECIDE_KLINES * DECIDE_GRANULARITY_MIN * 60 * 1000;
  const [klines, tick] = await Promise.all([
    klinesRaw(sym, DECIDE_GRANULARITY_MIN, now - spanMs, now),
    tickerFull(sym),
  ]);
  // kline columns: [ts,open,high,low,close,vol,turnover] — close is k[4].
  const closes = klines.map((k) => Number(k[4])).filter(Number.isFinite);
  const vols = klines.map((k) => Number(k[5])).filter(Number.isFinite);
  const highs = klines.map((k) => Number(k[2])).filter(Number.isFinite);
  const lows = klines.map((k) => Number(k[3])).filter(Number.isFinite);
  const m = fadeMetrics(closes, vols, highs, lows);
  if (!m || !(tick.price > 0)) throw new Error(`thin tape for ${sym}`);
  const tape: TapeStats = {
    chg: m.chg,
    vratio: m.vratio,
    vslope: m.vslope,
    offHighPct: m.offHighPct,
    offLowPct: m.offLowPct,
    atrPct: m.atrPct,
    n: closes.length,
  };

  let book: BookStats | null = null;
  try {
    const base = norm.split("/")[0] as string;
    const venueBase = base === "BTC" ? "XBT" : base;
    const [ob, spec] = await Promise.all([depth20(sym), contractSpec(venueBase)]);
    const mult = isFin(spec?.multiplier) && (spec?.multiplier as number) > 0 ? (spec.multiplier as number) : 1;
    const bn = spikeNotionals(ob.bids.slice(0, 5) as [unknown, unknown][], mult);
    const an = spikeNotionals(ob.asks.slice(0, 5) as [unknown, unknown][], mult);
    const bid5 = bn.reduce((a, l) => a + l.notional, 0);
    const ask5 = an.reduce((a, l) => a + l.notional, 0);
    const mid = (tick.bestBid + tick.bestAsk) / 2;
    book = {
      mid,
      sprBps: spikeSpreadBps(tick.bestBid, tick.bestAsk),
      bid5Usd: Math.round(bid5 * 10) / 10,
      ask5Usd: Math.round(ask5 * 10) / 10,
      imb: Math.round(spikeImbalance(bid5, ask5) * 1000) / 1000,
    };
  } catch {
    book = null;
  }

  let jev: JevFeatures | null = null;
  let jevNote: string | undefined;
  const pat = resolvePat(opts.pat);
  if (!pat) {
    jevNote = "not authenticated — JEV leg abstains (run `jw3 auth login --browser` for the full state)";
  } else {
    try {
      jev = jevToFeatures(await jevTrend(exchange, norm, pat, opts.url));
      if (!jev) jevNote = "no trend verdict returned — JEV leg abstains";
    } catch (e) {
      jevNote = `JEV failed — JEV leg abstains (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return { pair: norm, symbol: sym, last: tick.price, tape, book, jev, jevNote };
}

/** Bridge stdin shape: JEV flat/uncertain folds to side "none". */
export function marketStateForBridge(s: MarketState): Record<string, unknown> {
  return {
    pair: s.pair,
    symbol: s.symbol,
    last: s.last,
    tape: s.tape,
    book: s.book,
    jev: s.jev ? { side: jevSideForBridge(s.jev), agreement: s.jev.agreement, uncertain: s.jev.uncertain } : null,
  };
}

/** Pure: validate the bridge's stdout shape. Anything else → null (never trust). */
export function parseLayaOutput(raw: unknown): LayaVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["choice"] !== "long" && o["choice"] !== "short" && o["choice"] !== "flat") return null;
  if (!isFin(o["confidence"])) return null;
  if (!isFin(o["score"])) return null;
  if (!Array.isArray(o["reasons"]) || !(o["reasons"] as unknown[]).every((r) => typeof r === "string")) return null;
  if (!isFin(o["ms"]) || (o["ms"] as number) < 0) return null;
  return {
    choice: o["choice"] as DecideChoice,
    confidence: Math.min(Math.max(o["confidence"] as number, 0), 1),
    score: o["score"] as number,
    reasons: o["reasons"] as string[],
    ms: o["ms"] as number,
  };
}

/** python3 unless $LAYA_PYTHON points at a venv interpreter. The bridge is pure stdlib. */
export function resolveLayaPython(): string {
  const env = (process.env["LAYA_PYTHON"] ?? "").trim();
  return env || "python3";
}

function layaBridgePath(): string {
  return fileURLToPath(new URL("../../python/laya_decide.py", import.meta.url));
}

export type BridgeRunner = (stdin: string, python: string, script: string) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const defaultRunner: BridgeRunner = (stdin, python, script) => {
  const out = spawnSync(python, [script], {
    input: stdin,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return { status: out.status, stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? "") };
};

/**
 * Run the Laya bridge over a market state. Throws on spawn/exit/shape
 * failure — callers decide how to report. The runner is injectable so
 * tests pin the contract with a mocked bridge (no python needed).
 */
export async function fetchLayaVerdict(state: MarketState, runner: BridgeRunner = defaultRunner): Promise<LayaVerdict> {
  const stdin = JSON.stringify(marketStateForBridge(state));
  const python = resolveLayaPython();
  let res: ReturnType<BridgeRunner>;
  try {
    res = runner(stdin, python, layaBridgePath());
  } catch (e) {
    throw new Error(`laya bridge spawn: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status !== 0) {
    const err = res.stderr.trim().split("\n").slice(-3).join("\n");
    throw new Error(`laya bridge exit ${res.status}${err ? `: ${err}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("laya bridge returned non-JSON stdout.");
  }
  const verdict = parseLayaOutput(parsed);
  if (!verdict) throw new Error("laya bridge returned an unexpected shape.");
  // Calibrated-confidence guard: without a certain JEV leg the bridge's
  // confidence is capped — a tape+book-only verdict is never high conviction.
  if (!state.jev || state.jev.uncertain) {
    verdict.confidence = Math.min(verdict.confidence, DECIDE_JEVLESS_CONF_CAP);
  }
  return verdict;
}

export async function cmdDecide(opts: {
  pair: string;
  exchange: string;
  json: boolean;
  url?: string;
  pat?: string;
  deps?: DecideDeps;
  runner?: BridgeRunner;
}): Promise<void> {
  const pairErr = validateDecidePair(opts.pair);
  if (pairErr || !opts.exchange) {
    console.error("Usage: jw3 decide --pair SOL/USDT [--exchange kucoin] [--json]");
    process.exitCode = 2;
    return;
  }
  let state: MarketState;
  try {
    state = await buildMarketState(opts.pair, opts.exchange, { url: opts.url, pat: opts.pat }, opts.deps);
  } catch (e) {
    console.error(`No market state — no verdict returned: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  let verdict: LayaVerdict;
  try {
    verdict = await fetchLayaVerdict(state, opts.runner);
  } catch (e) {
    console.error(`Laya failed — no verdict returned: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ state, verdict }, null, 2));
    return;
  }
  const arrow = verdict.choice === "long" ? "LONG ▲" : verdict.choice === "short" ? "SHORT ▼" : "FLAT ■";
  console.log(`DECIDE ${state.pair} (${opts.exchange}) — ${arrow}  conf ${(verdict.confidence * 100).toFixed(0)}%`);
  console.log(
    `tape ${state.tape.chg >= 0 ? "+" : ""}${state.tape.chg.toFixed(2)}%/24h · vol x${state.tape.vratio.toFixed(2)} ${state.tape.vslope}` +
      `${state.tape.atrPct !== null ? ` · ATR ${state.tape.atrPct.toFixed(2)}%` : ""}` +
      `${state.book ? ` · book ${state.book.imb >= 0 ? "+" : ""}${state.book.imb.toFixed(3)} / ${state.book.sprBps.toFixed(1)}bps` : " · book n/a"}` +
      `${state.jev && !state.jev.uncertain ? ` · JEV ${state.jev.side.toUpperCase()} ${(state.jev.agreement * 100).toFixed(0)}%` : " · JEV abstains"}`,
  );
  for (const r of verdict.reasons) console.log(`  · ${r}`);
  if (state.jevNote) console.log(`note: ${state.jevNote}`);
  console.log(`Laya v0 (rules, uncalibrated on live outcomes) · score ${verdict.score.toFixed(2)} · read-only, nothing traded`);
}
