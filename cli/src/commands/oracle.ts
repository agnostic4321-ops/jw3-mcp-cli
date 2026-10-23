/**
 * `jw3 oracle --pair X` — three-model single verdict (READ-ONLY, no trades).
 *
 * Parallel fan-out to all three oracles, then one calibrated combine:
 *   Kronos  (kronos_forecast.py 15m K-line oracle) → up/down vote, flat abstains
 *   Laya    (laya_decide.py over the decide market-state: tape + book + JEV)
 *           → long/short vote, flat abstains
 *   RF-DETR (chart-vision pattern reader via python/rfdetr_pattern.py,
 *           RF-DETR Nano on CPU) → pattern-box vote, abstains without
 *           --chart or when no pattern box clears the threshold.
 *
 * Calibrated combiner: weights come from the vote.json rolling store
 * (loadStore), so scored merit auto-tunes the oracle too. Laya inherits
 * the JEV track weight — it is the decision leg that supersedes the raw
 * JEV trend (it fuses JEV + tape + book), and the oracle keeps no
 * separate track until it accrues its own history. Same confidence-weighted
 * ballot as `vote` (|score| >= 0.15 decides, else flat) via
 * CONSENSUS_THRESHOLD; empty ballot → flat, never a fabricated direction.
 *
 * The oracle only READS vote.json (never records ballots — scoring stays
 * in `vote record`) and never proposes, executes, or closes. Nothing here
 * touches keys or the market.
 */
import { resolvePat } from "../config.js";
import {
  buildMarketState,
  fetchLayaVerdict,
  type LayaVerdict,
} from "./decide.js";
import { fetchKronosVerdict } from "./forecast.js";
import {
  fetchRfdetrBoxes,
  rfdetrBoxesToSignal,
  type RfdetrBridgeRunner,
  type RfdetrChart,
  type RfdetrVerdict,
} from "./rfdetr.js";
import {
  CONSENSUS_THRESHOLD,
  loadStore,
  normalizeVotePair,
  rfdetrSignal,
  validateVotePair,
  voteStorePath,
  type SkillId,
} from "./vote.js";
import {
  btcFeeVeto,
  clampShortVerdict,
  cpiBlackout,
  type PrefilterCtx,
} from "../blocking-rules.js";
import { klinesSymbolForPair, parseKlineRows } from "./klines.js";
import { futuresKlines } from "../kucoin.js";

export type OracleSkill = "kronos" | "laya" | "rfdetr";
export type OracleSide = "long" | "short" | "flat";

export const ORACLE_SKILLS: OracleSkill[] = ["kronos", "laya", "rfdetr"];

export type OracleSignal = {
  skill: OracleSkill;
  side: OracleSide;
  /** 0..1 directional conviction. 0 when abstained. */
  confidence: number;
  abstained: boolean;
  detail: string;
};

export type OracleBreakdown = {
  skill: OracleSkill;
  side: OracleSide;
  confidence: number;
  weight: number;
  contribution: number;
  abstained: boolean;
};

export type OracleVerdict = {
  side: OracleSide;
  /** Confidence-weighted mean in [-1, 1] (+long / −short). 0 when nobody votes. */
  score: number;
  voters: number;
  breakdown: OracleBreakdown[];
  reason: string;
};

/**
 * Pure: Laya verdict → oracle ballot. long/short vote with the bridge's
 * (JEV-capped) confidence; flat abstains — a no-call is not a direction.
 */
export function layaToSignal(v: LayaVerdict | null): OracleSignal {
  const abstain = (detail: string): OracleSignal => ({ skill: "laya", side: "flat", confidence: 0, abstained: true, detail });
  if (!v) return abstain("no laya verdict");
  if (v.choice === "flat") return abstain("flat — no direction");
  const conf = Number.isFinite(v.confidence) ? Math.min(Math.max(v.confidence, 0), 1) : 0;
  return { skill: "laya", side: v.choice, confidence: conf, abstained: false, detail: `${v.choice} conf ${conf.toFixed(2)} · ${v.reasons[0] ?? "no reason"}` };
}

/**
 * RF-DETR chart-vision ballot — abstains without a chart. Wiring point:
 * pass a chart PNG (see --chart) and the pattern-reader bridge votes off
 * the top pattern box; failures abstain so a down model never blocks the
 * verdict. Reuses vote's mapping so both ballots agree.
 */
export function rfdetrOracleSignal(): OracleSignal {
  const s = rfdetrSignal();
  return { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: s.detail };
}

/**
 * Run the RF-DETR bridge over one chart PNG and map its boxes to an
 * oracle signal. Any failure (spawn, exit, shape, no pattern box)
 * abstains with the reason — never a fabricated direction.
 */
export async function fetchRfdetrOracleSignal(
  chart: RfdetrChart,
  runner?: RfdetrBridgeRunner,
): Promise<OracleSignal> {
  let verdict: RfdetrVerdict;
  try {
    verdict = await fetchRfdetrBoxes(chart, runner);
  } catch (e) {
    return { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: `rfdetr failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const b = rfdetrBoxesToSignal(verdict);
  return { skill: "rfdetr", side: b.side, confidence: b.confidence, abstained: b.abstained, detail: b.detail };
}

/**
 * Pure: confidence-weighted ballot over oracle skills. Zero-weight and
 * abstained skills sit out (neither push the score nor dilute the
 * denominator). Empty ballot → flat with a reason, never fabricated.
 */
export function combineOracleVote(
  signals: OracleSignal[],
  weights: Record<OracleSkill, number>,
): OracleVerdict {
  const breakdown: OracleBreakdown[] = signals.map((s) => {
    const w = weights[s.skill] ?? 0;
    const voting = !s.abstained && w > 0;
    const dir = s.side === "long" ? 1 : s.side === "short" ? -1 : 0;
    return {
      skill: s.skill,
      side: s.side,
      confidence: s.confidence,
      weight: w,
      contribution: voting ? dir * s.confidence * w : 0,
      abstained: !voting,
    };
  });
  const voters = breakdown.filter((b) => !b.abstained);
  if (voters.length === 0) {
    return { side: "flat", score: 0, voters: 0, breakdown, reason: "no consensus — every model abstained" };
  }
  const num = voters.reduce((a, b) => a + b.contribution, 0);
  const den = voters.reduce((a, b) => a + b.weight, 0);
  const score = den > 0 ? num / den : 0;
  const side: OracleSide = score >= CONSENSUS_THRESHOLD ? "long" : score <= -CONSENSUS_THRESHOLD ? "short" : "flat";
  const reason =
    side === "flat"
      ? `weighted score ${score.toFixed(2)} inside ±${CONSENSUS_THRESHOLD} — no consensus`
      : `weighted score ${score.toFixed(2)} decides ${side.toUpperCase()}`;
  return { side, score, voters: voters.length, breakdown, reason };
}

/**
 * Pure: vote.json rolling weights → oracle weights. Laya inherits the
 * JEV track (the decision leg supersedes the raw trend leg); Kronos and
 * RF-DETR map straight across.
 */
export function oracleWeightsFromStore(weights: Record<SkillId, number>): Record<OracleSkill, number> {
  return { kronos: weights["kronos"] ?? 0.5, laya: weights["jev"] ?? 1.0, rfdetr: weights["rfdetr"] ?? 0 };
}

export type OracleDeps = {
  kronos?: typeof fetchKronosVerdict;
  marketState?: typeof buildMarketState;
  laya?: typeof fetchLayaVerdict;
  rfdetr?: typeof fetchRfdetrOracleSignal;
  /** Session-context fetch (day change / session low / last price for the short vetoes). Tests inject a stub. */
  sessionCtx?: (pair: string) => Promise<PrefilterCtx>;
  /**
   * The clock, in epoch ms, for the TIME-BASED pre-filters.
   *
   * The CPI blackout is a WINDOW (11:30-13:30Z), not a calendar day.
   * A test that does not pin the clock therefore passes for 22 hours
   * and fails for 2 — a flaky test by construction, and it failed
   * live today at 11:50Z.
   */
  nowMs?: number;
};

/**
 * Blocking pre-filters, evaluated BEFORE any model inference (all µs):
 * CPI blackout kills both directions, BTC fee-veto benches small-size BTC.
 * Re-enable BTC with JW3_FEE_TIER_OK=1 (better fee tier) or JW3_ACCOUNT_USD>=25.
 */
export function oraclePrefilter(
  pair: string,
  nowMs?: number,
): { vetoed: boolean; rule: string | null; detail: string } {
  if (cpiBlackout(nowMs)) {
    return { vetoed: true, rule: "cpi_blackout", detail: "CPI blackout 11:30-13:30Z: post-CPI chop kills both directions" };
  }
  const feeTierOk = (process.env["JW3_FEE_TIER_OK"] ?? "").trim() === "1";
  const rawAcct = Number(process.env["JW3_ACCOUNT_USD"] ?? NaN);
  const accountUsd = Number.isFinite(rawAcct) ? rawAcct : undefined;
  if (btcFeeVeto(pair, { accountUsd, feeTierOk })) {
    return {
      vetoed: true, rule: "btc_fee",
      detail: "BTC fee-unprofitable at minimum size on small account (bench; set JW3_ACCOUNT_USD>=25 or JW3_FEE_TIER_OK=1 to re-enable)",
    };
  }
  return { vetoed: false, rule: null, detail: "pre-filters pass" };
}

/**
 * One cheap data fetch (single 5m klines window, ~1s) for the data-dependent
 * short vetoes: trailing-24h change (extended-drop) + 60-min session low and
 * last price (bounce-required). Data only — never model inference. On fetch
 * failure returns {} (fail-open for the advisor oracle, noted in output;
 * the side-aware fast loop fails closed instead).
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

export async function cmdOracle(opts: {
  pair: string;
  exchange: string;
  horizon: number;
  json: boolean;
  url?: string;
  pat?: string;
  storePath?: string;
  /** Chart PNG for the RF-DETR leg (`--chart path/to.png`). Absent = abstains. */
  chartPath?: string;
  deps?: OracleDeps;
}): Promise<void> {
  const pairErr = validateVotePair(opts.pair);
  if (pairErr || !opts.exchange) {
    console.error("Usage: jw3 oracle --pair SOL/USDT [--exchange kucoin] [--horizon 12] [--chart chart.png] [--json]");
    process.exitCode = 2;
    return;
  }
  const pair = normalizeVotePair(opts.pair);
  const store = loadStore(opts.storePath ?? voteStorePath());
  const weights = oracleWeightsFromStore(store.weights);
  const deps = opts.deps ?? {};

  // Blocking pre-filters BEFORE any model inference (µs, zero I/O).
  // A veto returns flat immediately: no Kronos/Laya/RF-DETR call is made.
  const pre = oraclePrefilter(pair, deps.nowMs);
  if (pre.vetoed) {
    const flatVerdict = {
      side: "flat" as const, score: 0, voters: 0, breakdown: [],
      reason: `prefilter:${pre.rule} — ${pre.detail}`,
    };
    if (opts.json) {
      console.log(JSON.stringify({ pair, side: "flat", score: 0, prefilter: pre, signals: [], weights, reason: flatVerdict.reason }, null, 2));
      return;
    }
    console.log(`ORACLE ${pair} — FLAT ■ (prefilter:${pre.rule})`);
    console.log(`  ${pre.detail}`);
    console.log("Read-only oracle — nothing proposed, nothing traded");
    return;
  }

  const fetchKronos = deps.kronos ?? fetchKronosVerdict;
  const marketState = deps.marketState ?? buildMarketState;
  const fetchLaya = deps.laya ?? fetchLayaVerdict;

  // Parallel fan-out: Kronos oracle + Laya decide leg + RF-DETR chart leg.
  // Failures abstain (a failed model sits out — it never blocks the verdict).
  // The session-context fetch (one cheap 5m klines window, data only) rides
  // the same fan-out so the short vetoes cost zero added latency.
  const sessionCtxFn = deps.sessionCtx ?? fetchSessionCtx;
  const [kronosSettled, layaSettled, rfdetrSettled, sessionSettled] = await Promise.allSettled([
    (async (): Promise<OracleSignal> => {
      try {
        const v = await fetchKronos(pair, opts.horizon);
        if (!v || v.direction === "flat") {
          return { skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: v ? `flat (expected ${v.expected_move_pct.toFixed(2)}%) — no direction` : "no kronos verdict" };
        }
        const conf = Math.min(Math.max(Math.abs(v.expected_move_pct) / 1, 0.1), 1);
        return { skill: "kronos", side: v.direction === "up" ? "long" : "short", confidence: conf, abstained: false, detail: `${v.direction} ${v.expected_move_pct.toFixed(2)}% over ${v.horizon}x15m` };
      } catch (e) {
        return { skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: `kronos failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    })(),
    (async (): Promise<OracleSignal> => {
      try {
        const state = await marketState(pair, opts.exchange, { url: opts.url, pat: opts.pat });
        return layaToSignal(await fetchLaya(state));
      } catch (e) {
        return { skill: "laya", side: "flat", confidence: 0, abstained: true, detail: `laya failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    })(),
    (async (): Promise<OracleSignal> => {
      try {
        if (!opts.chartPath) return rfdetrOracleSignal();
        const fetchRfdetr = deps.rfdetr ?? fetchRfdetrOracleSignal;
        return await fetchRfdetr({ imagePath: opts.chartPath });
      } catch (e) {
        return { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: `rfdetr failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    })(),
    sessionCtxFn(pair),
  ]);
  const signals: OracleSignal[] = [
    kronosSettled.status === "fulfilled"
      ? kronosSettled.value
      : { skill: "kronos", side: "flat", confidence: 0, abstained: true, detail: "kronos fan-out failed" },
    layaSettled.status === "fulfilled"
      ? layaSettled.value
      : { skill: "laya", side: "flat", confidence: 0, abstained: true, detail: "laya fan-out failed" },
    rfdetrSettled.status === "fulfilled"
      ? rfdetrSettled.value
      : { skill: "rfdetr", side: "flat", confidence: 0, abstained: true, detail: "rfdetr fan-out failed" },
  ];
  // Laya without a PAT still runs (tape+book legs, JEV-capped confidence);
  // surface the auth note so the verdict's strength is honest.
  const pat = resolvePat(opts.pat);
  const authNote = pat ? undefined : "not authenticated — Laya runs tape+book only (run `jw3 auth login --browser` for the full state)";

  const verdict = combineOracleVote(signals, weights);
  // Side-aware short vetoes (data-dependent rules): the direction oracle has
  // no side, so a model-short verdict is clamped to flat when the session
  // context vetoes shorts. The side-aware fast loop kills these pre-inference.
  const sessionCtx: PrefilterCtx =
    sessionSettled.status === "fulfilled" ? (sessionSettled.value as PrefilterCtx) : {};
  const sessionNote =
    sessionSettled.status === "fulfilled" ? undefined : "session context unavailable — short vetoes unevaluated";
  const clamp = clampShortVerdict(verdict.side, sessionCtx);
  const side = clamp.clamped ? "flat" : verdict.side;
  const reason = clamp.clamped ? `prefilter:${clamp.rule} — ${clamp.detail}` : verdict.reason;
  if (verdict.voters === 0) {
    console.error("No signal — every model abstained, nothing to decide.");
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ pair, side, score: verdict.score, signals, weights, reason, prefilter: pre, sessionCtx, clamped: clamp.clamped ? { rule: clamp.rule, detail: clamp.detail } : null }, null, 2));
    return;
  }
  const arrow = side === "long" ? "LONG ▲" : side === "short" ? "SHORT ▼" : "FLAT ■";
  console.log(`ORACLE ${pair} — ${arrow} (score ${verdict.score.toFixed(2)})`);
  for (const s of signals) {
    const b = verdict.breakdown.find((x) => x.skill === s.skill)!;
    console.log(
      s.abstained
        ? `  ${s.skill.padEnd(8)} abstain (${s.detail})`
        : `  ${s.skill.padEnd(8)} ${s.side.padEnd(5)} conf ${s.confidence.toFixed(2)}  w ${b.weight.toFixed(2)}  → ${s.detail}`,
    );
  }
  console.log(`weights kronos=${weights.kronos.toFixed(2)} laya=${weights.laya.toFixed(2)}(jev track) rfdetr=${weights.rfdetr.toFixed(2)} · ${reason}`);
  if (clamp.clamped) console.log(`prefilter:${clamp.rule} — ${clamp.detail}`);
  if (sessionNote) console.log(`note: ${sessionNote}`);
  if (authNote) console.log(`note: ${authNote}`);
  console.log("Read-only oracle — nothing proposed, nothing traded");
}
