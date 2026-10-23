/**
 * Offline decision-cycle harness for the trading machine.
 *
 * A deterministic, offline QA rig. One synthetic scenario — a crafted
 * candle series, fabricated model verdicts, a fake account snapshot — runs
 * through the WHOLE decision path:
 *
 *   FILTERS → COMMITTEE → RUBRIC → SIZING → TICKET → (submit)
 *
 * and the resulting ticket is handed to an INJECTED exchange boundary that
 * only records what WOULD have been sent. No network, no money, no wall
 * clock, no randomness — the same inputs always produce the same ticket.
 *
 * This module owns NO gate of its own. Every stage is the production
 * module:
 *
 *   - `filters.ts`        → runFilters()          (pre-trade gates)
 *   - `committee.ts`      → runCommittee()        (weighted seat ballot)
 *   - `rubric.ts`         → applyRubric()         (quality/size tier)
 *   - `sizing.ts`         → sizeTrade()           (contracts, leverage, risk)
 *   - `live.ts`           → buildTicket()         (the wire payload)
 *
 * A harness that re-implemented those gates would only prove that the
 * harness agrees with itself. Driving the real modules means a regression
 * in ANY of them fails THIS suite.
 *
 * Two hard rules shape the file:
 *
 *   1. The clock is INJECTED (`nowMs`). Nothing in the decision path may
 *      read the wall clock — otherwise a run is not reproducible and a
 *      retry cannot be compared against the original.
 *   2. `deps.placeOrder` is the ONLY exit. The test injects a recorder, so
 *      a decision-path bug can never reach a venue from here. Every
 *      outbound payload is captured and asserted on.
 */
import { defaultFilterConfig, runFilters, type FilterCandidate, type FilterChainResult, type FilterConfig } from "../filters.js";
import {
  DEFAULT_COMMITTEE_PARAMS,
  DEFAULT_SEATS,
  atrPercent,
  committeeModelLegs,
  mergeCommitteeParams,
  runCommittee,
  type CommitteeContext,
  type CommitteeMarket,
  type CommitteeModelLegs,
  type CommitteeParams,
  type CommitteePosition,
  type CommitteeRawVerdicts,
  type CommitteeResult,
  type CommitteeSeat,
} from "./committee.js";
import { applyRubric, seatsFromSignedBallots, type RubricDecision } from "./rubric.js";
import { sizeTrade, type SizingDecision, type SizingProposal } from "./sizing.js";
import { buildTicket, makeClientOid } from "./live.js";
import type { KlineCandle } from "./klines.js";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** The hard leverage ceiling. No ticket may exceed it, whatever else says. */
export const HARNESS_MAX_LEVERAGE = 50;

/** The order tool the ticket goes out as. */
export const HARNESS_ORDER_TOOL = "execute_trade";

/** The exit-leg tool that arms the TP/SL beside the entry. */
export const HARNESS_EXIT_TOOL = "set_exits";

/** Bars in the bounce window (12 × 5m = 60min — the standing bounce lookback). */
export const HARNESS_BOUNCE_BARS = 12;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type HarnessSide = "long" | "short";

/** long/short = a ticket was produced · flat = nothing to trade · veto = a hard safety veto. */
export type HarnessVerdict = "long" | "short" | "flat" | "veto";

/** Where the pipeline stopped. */
export type HarnessStage = "filters" | "committee" | "rubric" | "sizing" | "ticket" | "submit";

export type ModelId = "jev" | "laya" | "kronos" | "rfdetr";

/**
 * One fabricated model verdict — a stand-in for a real oracle read.
 *
 * The verdict is expressed in the SAME shape the production helpers
 * consume (`TrendVerdict` for JEV, `ForecastVerdict` for Kronos,
 * `LayaVerdict` for Laya), so the committee sees it through
 * `committeeModelLegs()` — the very mapping `jw3 vote` and `jw3 oracle`
 * use. A model that abstains here abstains in production too, and the
 * harness can never disagree with the CLI about what a model said.
 */
export type ModelVerdict = {
  id: ModelId;
  side: HarnessSide | "flat";
  /** 0..1 directional conviction. */
  confidence: number;
  detail?: string;
  /** A hard veto from this member kills the whole committee — no ticket. */
  veto?: boolean;
  vetoReason?: string;
};

export type AccountSnapshot = {
  /** Free (unlocked) margin in USD — the pool a new ticket may draw on. */
  freeMarginUsd: number;
  /** Total account equity in USD. */
  equityUsd: number;
  /** Venue per-contract max leverage (null = unknown → the hard cap applies). */
  venueMaxLeverage?: number | null;
  /** Maintenance margin rate as a decimal (0.007 = 0.7%). */
  maintenanceMarginRate?: number;
  /** The server's per-position notional cap (null = no cap). */
  maxPositionUsd?: number | null;
  /**
   * The notional the signal PLANS to trade (USD). The filters read it
   * before sizing exists — it is the plan, not a number the harness
   * invented after the fact.
   */
  plannedNotionalUsd?: number;
  /** Open positions already on the book. */
  openPositions?: { symbol: string }[];
  /** Signals that already fired (the duplicate/cooldown filter). */
  recentSignals?: { symbol: string; signalId: string; firedAtMs: number }[];
};

export type ContractSpec = {
  /** One contract IS this many base units. */
  multiplier: number;
  /** Price increment. */
  tick: number;
};

/** The market snapshot the committee seats read. */
export type MarketSnapshot = {
  pair: string;
  last: number;
  candles1h: KlineCandle[];
  candles4h: KlineCandle[];
  candles1d: KlineCandle[];
  /** The last hour in 5m bars — the bounce window (the session low). */
  candles5m: KlineCandle[];
  high24: number;
  low24: number;
  atrPct: number;
  vwap: number;
  ema20: number;
  rsi: number;
  volRatio: number;
  volSlope: "up" | "down";
  /** Top-5 bid/ask notional and the imbalance. */
  book: { bidUsd: number; askUsd: number; imbalance: number; spreadBps: number };
  /** Funding rate in % per 8h settlement. */
  fundingPct: number;
  /** Trailing-24h change in %. */
  dayChgPct: number;
  /** 24h turnover in USD (the session/liquidity floors). */
  turnoverUsd24h: number;
  /** Best bid/ask (the spread gate). */
  bestBid: number;
  bestAsk: number;
  /** Calendar-verified blackout windows (UTC minutes). */
  blackouts?: { name: string; startMin: number; endMin: number }[];
  /** True when today is a real macro-release day. */
  macroEventToday?: boolean;
};

export type HarnessConfig = {
  exchange: string;
  pair: string;
  contract: ContractSpec;
  /** Risk budget as a percent of equity (the sizing engine's constraint). */
  riskPctOfEquity: number;
  /** Stop distance as a multiple of ATR%. */
  stopAtrMultiple: number;
  /** Target distance as a multiple of ATR%. */
  targetAtrMultiple: number;
  /** Fee schedule (decimals per side). */
  fees: { makerRate: number; takerRate: number };
  /** Filter chain overrides. */
  filterConfig: FilterConfig;
  /** Committee params overrides. */
  committeeParams: Partial<CommitteeParams>;
  /** Extra seats (a fabricated model leg can be injected as a seat). */
  committeeSeats?: CommitteeSeat[];
};

export type ExchangeCall = {
  tool: string;
  args: Record<string, unknown>;
  /** The idempotency key for this intent. */
  intentId: string;
};

export type IntentLedgerEntry = {
  ticket: Record<string, unknown>;
  call: ExchangeCall;
  status: "reserved" | "sent";
};

export type IntentLedger = { entries: Map<string, IntentLedgerEntry> };

export type HarnessDeps = {
  /** Injected clock (epoch ms). Never Date.now(). */
  nowMs: number;
  /** The ONLY exit from the decision path — the test injects a recorder. */
  placeOrder: (call: ExchangeCall) => unknown | Promise<unknown>;
  /** Idempotency ledger; a fresh one is created when omitted. */
  ledger?: IntentLedger;
};

export type HarnessResult = {
  scenario: string;
  verdict: HarnessVerdict;
  stage: HarnessStage;
  /** The stages the pipeline actually entered, in order. */
  stages: HarnessStage[];
  side: HarnessSide | null;
  /** The filter rule / veto rule / sizing code that explains a stop. */
  rule: string | null;
  reason: string;
  filters: FilterChainResult | null;
  committee: CommitteeResult | null;
  rubric: RubricDecision | null;
  sizing: SizingDecision | null;
  /** The wire payload (base-unit amount, leverage, stop). */
  ticket: Record<string, unknown> | null;
  /** The exit legs that ride the entry. */
  exits: Record<string, unknown> | null;
  submitted: {
    intentId: string | null;
    sent: boolean;
    duplicate: boolean;
    /** Same intent, different ticket — a bug, refused rather than sent. */
    conflict: boolean;
    error?: string;
  };
};

export type ScenarioGiven = {
  name: string;
  /** Session identity — part of the intent key. */
  sessionId: string;
  /** The turn id (part of the client order id). */
  turnId: string;
  /** Injected clock for this scenario (epoch ms). */
  nowMs: number;
  market: MarketSnapshot;
  models: ModelVerdict[];
  account: AccountSnapshot;
  /** The signal id (the duplicate/cooldown filter's key). */
  signalId?: string;
};

export type ExpectedTicket = {
  direction: HarnessSide;
  /** BASE UNITS — the value that must reach the wire. */
  amountBaseUnits: number;
  contracts: number;
  multiplier: number;
  leverage: number;
  /** Dollar risk at the stop. */
  riskUsd: number;
  marginRequiredUsd: number;
  notionalUsd: number;
  stopPrice: number;
  entryPrice: number;
  /** Adverse move to the liquidation price, in percent. */
  liqDistancePct: number;
};

export type ScenarioRow = {
  name: string;
  given: ScenarioGiven;
  /** Per-scenario config overrides. */
  config?: Partial<HarnessConfig>;
  expected: {
    verdict: HarnessVerdict;
    stage: HarnessStage;
    /** Filter rule id / veto rule / sizing rejection reason. */
    rule?: string;
    /** Expected ticket fields (null = no ticket expected). */
    ticket?: ExpectedTicket | null;
  };
  /** Why this scenario exists — the reason it is in the table. */
  reason: string;
};

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export function defaultHarnessConfig(filterConfig: FilterConfig): HarnessConfig {
  return {
    exchange: "kucoin",
    pair: "SOL/USDT",
    // 100 on purpose: a base-unit / contract mix-up shows up as a 100x error.
    contract: { multiplier: 100, tick: 0.001 },
    riskPctOfEquity: 3,
    stopAtrMultiple: 1,
    targetAtrMultiple: 1.5,
    fees: { makerRate: 0.0002, takerRate: 0.0006 },
    filterConfig,
    committeeParams: {},
  };
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build candles from an explicit close path. `halfRange` is half the
 * high-low band; the open of a bar is the previous close.
 */
export function craftCandles(
  closes: number[],
  halfRange: number,
  opts: { startTs?: number; stepMs?: number; volume?: number } = {},
): KlineCandle[] {
  const startTs = opts.startTs ?? 1_700_000_000_000;
  const stepMs = opts.stepMs ?? 3_600_000;
  const volume = opts.volume ?? 1000;
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1] as number);
    return {
      tsMs: startTs + i * stepMs,
      open,
      high: Math.max(open, close) + halfRange,
      low: Math.min(open, close) - halfRange,
      close,
      volume,
      turnover: volume * close,
    };
  });
}

/** A close path that ENDS exactly on `lastClose` (computed backwards). */
export function closePath(lastClose: number, count: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(lastClose - (count - 1 - i) * step);
  return out;
}

/** The lowest low over the bounce window (the standing 60min lookback). */
export function sessionLowOf(candles: KlineCandle[], bars: number = HARNESS_BOUNCE_BARS): number | null {
  if (candles.length === 0) return null;
  const window = candles.slice(-Math.max(1, bars));
  let low = Infinity;
  for (const c of window) if (c.low < low) low = c.low;
  return Number.isFinite(low) ? low : null;
}

/** The bounce off the session low, in percent. */
export function bounceOffLowPct(price: number, sessionLow: number): number | null {
  if (!(sessionLow > 0) || !(price > 0)) return null;
  return ((price - sessionLow) / sessionLow) * 100;
}

/** Deterministic intent key: the same decision in the same session is one intent. */
export function intentIdFor(pair: string, direction: HarnessSide, sessionId: string): string {
  return `${pair}|${direction}|${sessionId}`;
}

/** Round to 6 decimals — the comparison the scenario table uses. */
export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function createIntentLedger(): IntentLedger {
  return { entries: new Map<string, IntentLedgerEntry>() };
}

/* ------------------------------------------------------------------ */
/* Stage wiring                                                         */
/* ------------------------------------------------------------------ */

/**
 * The direction the scenario intends: the first non-flat model's call.
 * The filters need it up front (the bounce and extended-drop rules are
 * side-aware), and the committee debates it.
 */
export function intendedSide(given: ScenarioGiven): HarnessSide {
  const first = given.models.find((v) => v.side !== "flat");
  return first && first.side !== "flat" ? first.side : "long";
}

/** The filter candidate the scenario implies. */
export function filterCandidateFor(given: ScenarioGiven, config: HarnessConfig): FilterCandidate {
  const m = given.market;
  // The filters run BEFORE the committee, but the side-aware rules
  // (extended drop, the bounce) still need the INTENDED direction — the
  // one the signal proposed. That is the scenario's model side.
  const side = intendedSide(given);
  return {
    symbol: config.pair,
    side,
    nowMs: given.nowMs,
    signalId: given.signalId,
    tier: "t2",
    turnoverUsd24h: m.turnoverUsd24h,
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    top5DepthUsd: m.book.bidUsd + m.book.askUsd,
    notionalUsd: given.account.plannedNotionalUsd ?? 1000,
    feePctPerSide: config.fees.takerRate * 100,
    stopDistancePct: m.atrPct * config.stopAtrMultiple,
    fundingPct: m.fundingPct,
    dayChgPct: m.dayChgPct,
    price: m.last,
    sessionLow: sessionLowOf(m.candles5m) ?? undefined,
    openPositions: given.account.openPositions ?? [],
    recentSignals: given.account.recentSignals ?? [],
    modelSeats: given.models.map((v) => ({
      // The quorum rule counts the production model seats (kronos/laya/
      // rfdetr). JEV is the structure leg — it votes through the
      // committee, not through the filter's quorum, so it is not counted
      // here (same as `jw3 vote`'s weight table).
      model: v.id === "jev" ? "structure" : v.id,
      abstained: v.side === "flat",
      side: v.side,
    })),
    accountUsd: given.account.equityUsd,
    feeTierOk: false,
  };
}

/**
 * The fabricated model verdicts → the RAW verdict shapes the production
 * mapping consumes. This is the seam where a fake model becomes a real
 * ballot: `committeeModelLegs()` then runs `jevToSignal` /
 * `kronosToSignal` / `layaToSignal` — the same helpers `jw3 vote` and
 * `jw3 oracle` use — so the committee's read of a model can never drift
 * from the CLI's.
 */
export function rawVerdictsFor(given: ScenarioGiven): CommitteeRawVerdicts {
  const by = (id: ModelId): ModelVerdict | undefined => given.models.find((v) => v.id === id);
  const jev = by("jev");
  const kronos = by("kronos");
  const laya = by("laya");
  return {
    jev:
      jev && jev.side !== "flat"
        ? {
            model: "JEV",
            verdict: {
              trend: {
                verdict: jev.side === "long" ? "strong_long" : "strong_short",
                agreement: jev.confidence,
                uncertain: false,
              },
            },
          }
        : null,
    kronos:
      kronos && kronos.side !== "flat"
        ? {
            direction: kronos.side === "long" ? "up" : "down",
            expected_move_pct: kronos.side === "long" ? kronos.confidence : -kronos.confidence,
            last_close: given.market.last,
            pred_last_close: given.market.last,
            pred_closes: [],
            horizon: 12,
            lookback: 12,
            ms: 1,
          }
        : null,
    laya:
      laya && laya.side !== "flat"
        ? {
            choice: laya.side,
            confidence: laya.confidence,
            score: laya.side === "long" ? laya.confidence : -laya.confidence,
            reasons: [laya.detail ?? `${laya.side} conf ${laya.confidence}`],
            ms: 1,
          }
        : null,
  };
}

/**
 * The committee's seats for a scenario: the production default seats,
 * plus a MODEL RISK seat that carries a fabricated model veto into the
 * committee as a real veto. A model's safety flag must be able to stop
 * the chain, and the committee is where vetoes live.
 */
export function committeeSeatsFor(given: ScenarioGiven): CommitteeSeat[] {
  const vetoing = given.models.find((v) => v.veto === true);
  if (!vetoing) return DEFAULT_SEATS;
  const modelRisk: CommitteeSeat = {
    id: "event_risk",
    role: "gate",
    weight: 1,
    evaluate: () => ({
      score: 0,
      position: null,
      abstain: false,
      reason: `veto ${vetoing.id}: ${vetoing.vetoReason ?? "model veto"}`,
      veto: { rule: "model_veto", detail: `${vetoing.id} vetoed: ${vetoing.vetoReason ?? "model veto"}` },
      support: 0,
    }),
  };
  // Replace the default event_risk seat with the vetoing model risk seat —
  // the seat id stays stable so the breakdown still names it.
  return DEFAULT_SEATS.map((s) => (s.id === "event_risk" ? modelRisk : s));
}

/**
 * The committee's model legs. Built by the PRODUCTION mapping, so the
 * harness sees exactly what the CLI sees.
 */
export function modelLegsFor(given: ScenarioGiven): CommitteeModelLegs {
  return committeeModelLegs(rawVerdictsFor(given));
}

/** The committee market snapshot the seats read. */
export function committeeMarketFor(given: ScenarioGiven, config: HarnessConfig): CommitteeMarket {
  const m = given.market;
  return {
    pair: config.pair,
    last: m.last,
    timeframes: [
      { tf: "1h", candles: m.candles1h },
      { tf: "4h", candles: m.candles4h },
      { tf: "1d", candles: m.candles1d },
    ],
    high24: m.high24,
    low24: m.low24,
    atrPct: m.atrPct,
    vwap: m.vwap,
    ema20: m.ema20,
    rsi: m.rsi,
    volRatio: m.volRatio,
    volSlope: m.volSlope,
    book: { bidUsd: m.book.bidUsd, askUsd: m.book.askUsd, imbalance: m.book.imbalance, spreadBps: m.book.spreadBps },
    fundingPct: m.fundingPct,
    dayChgPct: m.dayChgPct,
    sessionLow: sessionLowOf(m.candles5m) ?? undefined,
    blackouts: m.blackouts ?? [],
    macroEventToday: m.macroEventToday ?? false,
    nowMs: given.nowMs,
    accountUsd: given.account.equityUsd,
    notionalUsd: given.account.plannedNotionalUsd,
    feeTierOk: false,
    models: modelLegsFor(given),
    // The structure seat reads the JEV 7-timeframe verdict directly.
    jev: rawVerdictsFor(given).jev ?? null,
  };
}

/**
 * The committee proposal — the geometry under debate. The entry is the
 * last close; the stop is one ATR away on the losing side.
 */
export function proposalFor(given: ScenarioGiven, config: HarnessConfig, side: HarnessSide): CommitteePosition {
  const m = given.market;
  const stopDist = m.atrPct * config.stopAtrMultiple;
  const targetDist = m.atrPct * config.targetAtrMultiple;
  return {
    pair: config.pair,
    side,
    entry: m.last,
    stop: side === "long" ? m.last * (1 - stopDist / 100) : m.last * (1 + stopDist / 100),
    target: side === "long" ? m.last * (1 + targetDist / 100) : m.last * (1 - targetDist / 100),
    size: 1,
  };
}

/**
 * The rubric's seat ballots — the committee's SIGNED seat scores, mapped
 * onto the rubric's canonical seat shape. This is the production
 * contract: `seatsFromSignedBallots` is the adapter the rubric documents
 * for exactly this hand-off.
 */
export function rubricSeatsFor(committee: CommitteeResult): ReturnType<typeof seatsFromSignedBallots> {
  return seatsFromSignedBallots(
    committee.seats.map((s) => ({
      seat: s.seat,
      score: s.score,
      abstain: s.abstain,
      reason: s.reason,
      veto: s.veto ? { rule: s.veto.rule, detail: s.veto.detail } : null,
    })),
  );
}

/** The setup metrics the rubric's quality/cost/volatility rules read. */
export function setupMetricsFor(given: ScenarioGiven, config: HarnessConfig): {
  targetDistancePct: number;
  stopDistancePct: number;
  hitProbability: number;
  atrPct: number;
  spreadBps: number;
  liquidityUsd: number;
  distanceFromExtremePct: number;
  feeRatePerSide: number;
} {
  const m = given.market;
  const offHigh = ((m.high24 - m.last) / m.high24) * 100;
  const offLow = ((m.last - m.low24) / m.low24) * 100;
  return {
    targetDistancePct: m.atrPct * config.targetAtrMultiple,
    stopDistancePct: m.atrPct * config.stopAtrMultiple,
    hitProbability: 0.6,
    atrPct: m.atrPct,
    spreadBps: m.book.spreadBps,
    liquidityUsd: m.book.bidUsd + m.book.askUsd,
    distanceFromExtremePct: Math.min(offHigh, offLow),
    feeRatePerSide: config.fees.takerRate,
  };
}

/* ------------------------------------------------------------------ */
/* The cycle                                                            */
/* ------------------------------------------------------------------ */

/**
 * Run one full decision cycle.
 *
 * Deterministic: the clock is injected, the market/models/account are
 * given, and nothing here reads the wall clock or rolls a die. The only
 * outbound effect is `deps.placeOrder`.
 */
export async function runDecisionCycle(
  given: ScenarioGiven,
  config: HarnessConfig,
  deps: HarnessDeps,
): Promise<HarnessResult> {
  const ledger = deps.ledger ?? createIntentLedger();
  const stages: HarnessStage[] = [];
  const m = given.market;

  const base = (over: Partial<HarnessResult>): HarnessResult => ({
    scenario: given.name,
    verdict: "flat",
    stage: "filters",
    stages,
    side: null,
    rule: null,
    reason: "",
    filters: null,
    committee: null,
    rubric: null,
    sizing: null,
    ticket: null,
    exits: null,
    submitted: { intentId: null, sent: false, duplicate: false, conflict: false },
    ...over,
  });

  // ── 1. FILTERS ────────────────────────────────────────────────────
  // A reject here stops the cycle before any model is consulted and long
  // before the sizing engine.
  stages.push("filters");
  const candidate = filterCandidateFor(given, config);
  const filters = runFilters(candidate, config.filterConfig);
  if (filters.status === "reject") {
    return base({
      verdict: "veto",
      stage: "filters",
      rule: filters.rule ?? "filter_reject",
      reason: filters.reason,
      filters,
    });
  }

  // ── 2. COMMITTEE ─────────────────────────────────────────────────
  stages.push("committee");
  const params = mergeCommitteeParams(DEFAULT_COMMITTEE_PARAMS, config.committeeParams);
  const market = committeeMarketFor(given, config);
  // The proposal's side is decided by the FABRICATED MODEL LEG: the
  // scenario says what the models think, and the committee debates it.
  const firstModel = given.models.find((v) => v.side !== "flat");
  const sideHint: HarnessSide = firstModel && firstModel.side !== "flat" ? firstModel.side : "long";
  const ctx: CommitteeContext = {
    proposal: proposalFor(given, config, sideHint),
    market,
    params,
  };
  const seats = config.committeeSeats ?? committeeSeatsFor(given);
  const committee = runCommittee(ctx, { seats });
  if (committee.verdict === "VETO") {
    return base({
      verdict: "veto",
      stage: "committee",
      rule: committee.vetoes[0]?.rule ?? "committee_veto",
      reason: committee.reason,
      filters,
      committee,
    });
  }
  if (committee.verdict === "FLAT") {
    return base({
      verdict: "flat",
      stage: "committee",
      rule: "no_consensus",
      reason: committee.reason,
      filters,
      committee,
    });
  }
  const side: HarnessSide = committee.verdict === "LONG" ? "long" : "short";

  // ── 3. RUBRIC ────────────────────────────────────────────────────
  stages.push("rubric");
  const rubric = applyRubric({
    seats: rubricSeatsFor(committee),
    setup: setupMetricsFor(given, config),
  });
  if (rubric.verdict !== "APPROVE") {
    return base({
      verdict: rubric.verdict === "REJECT" ? "veto" : "flat",
      stage: "rubric",
      rule: rubric.vetoed ? "rubric_veto" : `rubric_${rubric.verdict.toLowerCase()}`,
      reason: rubric.reason,
      side,
      filters,
      committee,
      rubric,
    });
  }

  // ── 4. SIZING ────────────────────────────────────────────────────
  stages.push("sizing");
  const proposal = proposalFor(given, config, side);
  const sizingProposal: SizingProposal = {
    pair: config.pair,
    side,
    entryPrice: proposal.entry,
    stopPrice: proposal.stop,
    targetPrice: proposal.target,
    contractMultiplier: config.contract.multiplier,
    tickSize: config.contract.tick,
    maintenanceMarginRate: given.account.maintenanceMarginRate ?? 0.007,
    venueMaxLeverage: given.account.venueMaxLeverage ?? null,
    atrPct: m.atrPct,
    equityUsd: given.account.equityUsd,
    freeMarginUsd: given.account.freeMarginUsd,
    riskPctOfEquity: config.riskPctOfEquity * rubric.sizeMultiplier,
    maxNotionalUsd: given.account.maxPositionUsd ?? null,
    tierMultiplier: rubric.sizeMultiplier,
    feeSchedule: {
      makerRate: config.fees.makerRate,
      takerRate: config.fees.takerRate,
      entryLeg: "maker",
      exitLeg: "taker",
    },
    maxLeverage: HARNESS_MAX_LEVERAGE,
  };
  const sizing = sizeTrade(sizingProposal);
  if (!sizing) {
    return base({
      verdict: "flat",
      stage: "sizing",
      rule: "invalid_proposal",
      reason: "the sizing engine refused the proposal outright",
      side,
      filters,
      committee,
      rubric,
    });
  }
  if (sizing.status !== "ok") {
    return base({
      verdict: "flat",
      stage: "sizing",
      rule: "unfundable",
      reason: sizing.reason ?? "unfundable",
      side,
      filters,
      committee,
      rubric,
      sizing,
    });
  }

  // ── 5. TICKET ────────────────────────────────────────────────────
  stages.push("ticket");
  const clientOid = makeClientOid(given.sessionId, given.turnId, config.pair);
  const live = buildTicket(
    {
      pair: config.pair,
      side,
      entryPrice: sizing.entryPrice,
      stopPrice: sizing.stopPrice,
      targetPrice: sizing.targetPrice ?? proposal.target,
      atrPct: m.atrPct,
      score: committee.score,
      reason: `${committee.verdict} / ${rubric.tier} — ${rubric.reason}`,
    },
    sizing,
    config.exchange,
    clientOid,
  );
  const intentId = intentIdFor(config.pair, side, given.sessionId);

  // ── 6. SUBMIT (idempotent) ──────────────────────────────────────
  // The intent is reserved BEFORE the send, so a retry after an ambiguous
  // failure never fires the same order twice.
  stages.push("submit");
  const prior = ledger.entries.get(intentId);
  if (prior) {
    const conflict = JSON.stringify(prior.ticket) !== JSON.stringify(live.order);
    return base({
      verdict: side,
      stage: "submit",
      side,
      rule: conflict ? "intent_conflict" : "duplicate_intent",
      reason: conflict
        ? `intent ${intentId} already sent with a different ticket — refused`
        : `intent ${intentId} already sent — not sending it again`,
      filters,
      committee,
      rubric,
      sizing,
      ticket: live.order as unknown as Record<string, unknown>,
      exits: live.exits as unknown as Record<string, unknown>,
      submitted: { intentId, sent: false, duplicate: true, conflict },
    });
  }
  const call: ExchangeCall = { tool: HARNESS_ORDER_TOOL, args: live.order as unknown as Record<string, unknown>, intentId };
  ledger.entries.set(intentId, { ticket: live.order as unknown as Record<string, unknown>, call, status: "reserved" });
  let error: string | undefined;
  try {
    await deps.placeOrder(call);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const entry = ledger.entries.get(intentId);
  if (entry && !error) entry.status = "sent";
  return base({
    verdict: side,
    stage: "submit",
    side,
    reason: error ? `order send failed: ${error}` : `sent ${sizing.amountBaseUnits} base units`,
    filters,
    committee,
    rubric,
    sizing,
    ticket: live.order as unknown as Record<string, unknown>,
    exits: live.exits as unknown as Record<string, unknown>,
    submitted: { intentId, sent: !error, duplicate: false, conflict: false, ...(error ? { error } : {}) },
  });
}

/* ------------------------------------------------------------------ */
/* Scenario table                                                      */
/* ------------------------------------------------------------------ */

const SESSION_TS = Date.UTC(2026, 2, 11, 8, 0, 0);
/** 08:00Z — inside the Europe session, outside the CPI blackout. */
const CLOCK_OK = SESSION_TS;
/** 12:00Z — inside the CPI blackout. */
const CLOCK_CPI = Date.UTC(2026, 2, 11, 12, 0, 0);

const ACCOUNT: AccountSnapshot = {
  freeMarginUsd: 1000,
  equityUsd: 1000,
  venueMaxLeverage: null,
  maintenanceMarginRate: 0.007,
  maxPositionUsd: null,
  openPositions: [],
  recentSignals: [],
};

/**
 * The LONG tape: 60 bars — a rise, a pullback, then a rise into the
 * close. The last 13 bars all rise, so the structure seat reads clean
 * higher-highs, and the price sits mid-range (at least 3% off both 24h
 * extremes) so the quality rule sees no late-entry chase.
 */
function upTape(halfRange: number): KlineCandle[] {
  const closes: number[] = [];
  const phases: [number, number, number][] = [
    [1.255, 1.34, 20], // rise
    [1.34, 1.275, 18], // pullback
    [1.275, 1.3, 22], // rise into the close
  ];
  for (const [from, to, n] of phases) {
    for (let i = 0; i < n; i++) closes.push(from + ((to - from) * i) / (n - 1));
  }
  return craftCandles(closes, halfRange, { startTs: SESSION_TS, stepMs: 5 * 60 * 1000 });
}

/** The SHORT tape — the mirror image of the long one. */
function downTape(halfRange: number): KlineCandle[] {
  const closes: number[] = [];
  const phases: [number, number, number][] = [
    [2.745, 2.66, 20], // fall
    [2.66, 2.725, 18], // bounce back
    [2.725, 2.7, 22], // fall into the close
  ];
  for (const [from, to, n] of phases) {
    for (let i = 0; i < n; i++) closes.push(from + ((to - from) * i) / (n - 1));
  }
  return craftCandles(closes, halfRange, { startTs: SESSION_TS, stepMs: 5 * 60 * 1000 });
}

/**
 * The bounce window: 12 five-minute bars ending at `last`, whose lowest
 * low sits `bouncePct` under `last`. This is what the +0.4% bounce rule
 * reads — the price must stand off the session low before a short may
 * enter. A `bouncePct` near zero puts the price ON the low (the flush).
 */
function bounceWindow(last: number, bouncePct: number): KlineCandle[] {
  const low = last / (1 + bouncePct / 100);
  const closes: number[] = [];
  for (let i = 0; i < 12; i++) {
    closes.push(low + ((last - low) * i) / 11);
  }
  const out = craftCandles(closes, (last - low) / 2, { startTs: SESSION_TS, stepMs: 5 * 60 * 1000 });
  // The first bar's low IS the session low — pin it exactly.
  const first = out[0];
  if (first) first.low = low;
  return out;
}

/**
 * The ATR% of a tape, read with the committee's OWN Wilder ATR helper —
 * the same number the production code computes for this series.
 */
function atrOf(tape: KlineCandle[]): number {
  return atrPercent(tape, 14) ?? 1;
}

/** Half-range that gives the long/short tapes a ~1% ATR. */
const HALF_RANGE = 0.0055;

const UP_TAPE = upTape(HALF_RANGE);
const DOWN_TAPE = downTape(HALF_RANGE);

/**
 * The LONG market: a rising tape, a bid-heavy book, JEV long, and a
 * price that is NOT stretched off its own range (the mean-reversion seat
 * must not out-vote the trend seats).
 */
const LONG_MARKET: MarketSnapshot = {
  pair: "SOL/USDT",
  last: 1.3,
  candles1h: UP_TAPE,
  candles4h: UP_TAPE,
  candles1d: UP_TAPE,
  candles5m: bounceWindow(1.3, 1),
  // The 24h range brackets the price with 3%+ room on both sides.
  high24: 1.3455,
  low24: 1.2495,
  atrPct: atrOf(UP_TAPE),
  // The price sits ON its own means — no mean-reversion stretch to argue
  // against the trend.
  vwap: 1.3,
  ema20: 1.3,
  rsi: 50,
  volRatio: 1.4,
  volSlope: "up",
  book: { bidUsd: 30000, askUsd: 30000, imbalance: 0.2, spreadBps: 2 },
  fundingPct: 0.01,
  dayChgPct: 1.2,
  turnoverUsd24h: 5_000_000,
  bestBid: 1.2995,
  bestAsk: 1.3005,
  blackouts: [],
  macroEventToday: false,
};

/**
 * The SHORT market: a falling tape, an ask-heavy book, JEV short. The
 * session low sits 1% under the last price, so the +0.4% bounce clears.
 */
const SHORT_MARKET: MarketSnapshot = {
  ...LONG_MARKET,
  last: 2.7,
  candles1h: DOWN_TAPE,
  candles4h: DOWN_TAPE,
  candles1d: DOWN_TAPE,
  candles5m: bounceWindow(2.7, 1),
  high24: 2.7505,
  low24: 2.6495,
  atrPct: atrOf(DOWN_TAPE),
  vwap: 2.7,
  ema20: 2.7,
  rsi: 50,
  volSlope: "down",
  book: { bidUsd: 10000, askUsd: 30000, imbalance: -0.5, spreadBps: 2 },
  dayChgPct: -0.8,
  bestBid: 2.6995,
  bestAsk: 2.7005,
};

const MODELS_LONG: ModelVerdict[] = [
  { id: "jev", side: "long", confidence: 0.9, detail: "strong_long 90%" },
  { id: "laya", side: "long", confidence: 0.8, detail: "long conf 0.80" },
  { id: "kronos", side: "long", confidence: 0.6, detail: "up 0.60% over 12x15m" },
  { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
];

const MODELS_SHORT: ModelVerdict[] = [
  { id: "jev", side: "short", confidence: 0.9, detail: "strong_short 90%" },
  { id: "laya", side: "short", confidence: 0.8, detail: "short conf 0.80" },
  { id: "kronos", side: "short", confidence: 0.6, detail: "down 0.60% over 12x15m" },
  { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
];

/**
 * The scenario table. One row = one scenario: the given inputs, the
 * expected verdict, the expected ticket fields, and why it exists.
 *
 * A new scenario is a new ROW — the table drives both `cmdHarness` and
 * the test suite, so a row that stops matching is a visible failure
 * rather than a silent drift.
 */
export const SCENARIO_TABLE: ScenarioRow[] = [
  {
    name: "long-confluence-clean",
    given: {
      name: "long-confluence-clean",
      sessionId: "s1",
      turnId: "t1",
      nowMs: CLOCK_OK,
      signalId: "sig-long",
      market: LONG_MARKET,
      models: MODELS_LONG,
      account: ACCOUNT,
    },
    expected: {
      verdict: "long",
      stage: "submit",
      ticket: {
        direction: "long",
        amountBaseUnits: 900,
        contracts: 9,
        multiplier: 100,
        leverage: 31,
        riskUsd: 14.4,
        marginRequiredUsd: 37.741935,
        notionalUsd: 1170,
        stopPrice: 1.284,
        entryPrice: 1.3,
        liqDistancePct: 2.525806,
      },
    },
    reason:
      "The happy path: the models agree long, every gate clears, and the ticket carries the full field set — base-unit amount, leverage, dollar risk at the stop, and margin. Every other row is a deviation from this one.",
  },
  {
    name: "short-bounce-confirmed",
    given: {
      name: "short-bounce-confirmed",
      sessionId: "s1",
      turnId: "t2",
      nowMs: CLOCK_OK,
      signalId: "sig-short",
      market: SHORT_MARKET,
      models: MODELS_SHORT,
      account: ACCOUNT,
    },
    expected: {
      verdict: "short",
      stage: "submit",
      ticket: {
        direction: "short",
        amountBaseUnits: 400,
        contracts: 4,
        multiplier: 100,
        leverage: 50,
        riskUsd: 6.4,
        marginRequiredUsd: 21.6,
        notionalUsd: 1080,
        stopPrice: 2.716,
        entryPrice: 2.7,
        liqDistancePct: 1.3,
      },
    },
    reason:
      "A short is only tradable ON the bounce — the price is +1.00% off the session low here. This row proves the bounce rule does not kill every short, and that the stop sits on the correct side of the entry.",
  },
  {
    name: "short-no-bounce-rejected",
    given: {
      name: "short-no-bounce-rejected",
      sessionId: "s1",
      turnId: "t3",
      nowMs: CLOCK_OK,
      signalId: "sig-nobounce",
      market: { ...SHORT_MARKET, candles5m: bounceWindow(SHORT_MARKET.last, 0.05) },
      models: MODELS_SHORT,
      account: ACCOUNT,
    },
    expected: {
      verdict: "veto",
      stage: "filters",
      rule: "bounce_required",
      ticket: null,
    },
    reason:
      "The price is sitting on the session low (+0.05% — under the +0.4% requirement). Shorting here is shorting into the flush, so the veto must fire and no ticket may be produced.",
  },
  {
    name: "cpi-blackout-rejected",
    given: {
      name: "cpi-blackout-rejected",
      sessionId: "s1",
      turnId: "t4",
      nowMs: CLOCK_CPI,
      signalId: "sig-cpi",
      market: LONG_MARKET,
      models: MODELS_LONG,
      account: ACCOUNT,
    },
    expected: {
      verdict: "veto",
      stage: "filters",
      rule: "cpi_blackout",
      ticket: null,
    },
    reason:
      "Inside the 11:30–13:30Z CPI blackout every direction dies. This row proves the filter runs BEFORE the models (no committee is ever consulted) and long before the sizing engine.",
  },
  {
    name: "extended-drop-short-rejected",
    given: {
      name: "extended-drop-short-rejected",
      sessionId: "s1",
      turnId: "t5",
      nowMs: CLOCK_OK,
      signalId: "sig-drop",
      market: { ...SHORT_MARKET, dayChgPct: -3.5 },
      models: MODELS_SHORT,
      account: ACCOUNT,
    },
    expected: {
      verdict: "veto",
      stage: "filters",
      rule: "extended_drop",
      ticket: null,
    },
    reason:
      "The day is down more than 2%: no shorts into an extended drop. The bounce on this tape is fine, so the rule that fires is unambiguously the extended drop.",
  },
  {
    name: "btc-fee-bench-rejected",
    given: {
      name: "btc-fee-bench-rejected",
      sessionId: "s1",
      turnId: "t6",
      nowMs: CLOCK_OK,
      signalId: "sig-btc",
      market: LONG_MARKET,
      models: MODELS_LONG,
      account: { ...ACCOUNT, freeMarginUsd: 10, equityUsd: 10, plannedNotionalUsd: 10 },
    },
    config: { pair: "BTC/USDT" },
    expected: {
      verdict: "veto",
      stage: "filters",
      rule: "btc_fee",
      ticket: null,
    },
    reason:
      "BTC at minimum size on a $10 account cannot clear the round-trip fees. The bench is a filter veto, not a model call — same shape as the CPI row.",
  },
  {
    name: "committee-veto-no-ticket",
    given: {
      name: "committee-veto-no-ticket",
      sessionId: "s1",
      turnId: "t7",
      nowMs: CLOCK_OK,
      signalId: "sig-veto",
      market: LONG_MARKET,
      models: [
        { id: "jev", side: "long", confidence: 0.9, detail: "strong_long 90%" },
        { id: "laya", side: "long", confidence: 0.8, veto: true, vetoReason: "confluence broken", detail: "long conf 0.80" },
        { id: "kronos", side: "long", confidence: 0.6, detail: "up 0.60%" },
        { id: "rfdetr", side: "flat", confidence: 0, detail: "not wired" },
      ],
      account: ACCOUNT,
    },
    expected: {
      verdict: "veto",
      stage: "committee",
      rule: "model_veto",
      ticket: null,
    },
    reason:
      "A committee veto outranks every vote in the ballot — three bullish models do NOT outvote a safety flag. The veto must produce no ticket at all.",
  },
  {
    name: "insufficient-margin-no-ticket",
    given: {
      name: "insufficient-margin-no-ticket",
      sessionId: "s1",
      turnId: "t8",
      nowMs: CLOCK_OK,
      signalId: "sig-margin",
      market: LONG_MARKET,
      models: MODELS_LONG,
      account: { ...ACCOUNT, freeMarginUsd: 0.5, equityUsd: 1000 },
    },
    expected: {
      verdict: "flat",
      stage: "sizing",
      rule: "unfundable",
      ticket: null,
    },
    reason:
      "The risk budget says nine contracts, but the account cannot carry one. This is the row that catches the `risk_usd` oversize: sizing must check the free margin, not just the stop distance.",
  },
  {
    name: "leverage-capped-at-hard-limit",
    given: {
      name: "leverage-capped-at-hard-limit",
      sessionId: "s1",
      turnId: "t9",
      nowMs: CLOCK_OK,
      signalId: "sig-lev",
      market: LONG_MARKET,
      models: MODELS_LONG,
      account: ACCOUNT,
    },
    config: { riskPctOfEquity: 30 },
    expected: {
      verdict: "long",
      stage: "submit",
      ticket: {
        direction: "long",
        amountBaseUnits: 9300,
        contracts: 93,
        multiplier: 100,
        leverage: 31,
        riskUsd: 148.8,
        marginRequiredUsd: 390,
        notionalUsd: 12090,
        stopPrice: 1.284,
        entryPrice: 1.3,
        liqDistancePct: 2.525806,
      },
    },
    reason:
      "A 30%-of-equity risk request still lands on a leverage the stop can carry and never above the hard cap of 50. This is the row that proves the ceiling is a CEILING, not a suggestion.",
  },
  {
    name: "wide-stop-leverage-reduced",
    given: {
      name: "wide-stop-leverage-reduced",
      sessionId: "s1",
      turnId: "t10",
      nowMs: CLOCK_OK,
      signalId: "sig-wide",
      market: { ...LONG_MARKET, atrPct: 3 },
      models: MODELS_LONG,
      account: ACCOUNT,
    },
    expected: {
      verdict: "long",
      stage: "submit",
      ticket: {
        direction: "long",
        amountBaseUnits: 300,
        contracts: 3,
        multiplier: 100,
        leverage: 14,
        riskUsd: 11.7,
        marginRequiredUsd: 27.857143,
        notionalUsd: 390,
        stopPrice: 1.261,
        entryPrice: 1.3,
        liqDistancePct: 6.442857,
      },
    },
    reason:
      "A 3% stop cannot live at 31x — the liquidation distance would sit inside the stop. The engine derives a lower leverage so the venue cannot liquidate before the stop fills.",
  },
];

/* ------------------------------------------------------------------ */
/* Expectations + reporting                                            */
/* ------------------------------------------------------------------ */

/** Compare one scenario's result against its row. Returns the mismatches. */
export function checkScenarioExpectations(row: ScenarioRow, result: HarnessResult): string[] {
  const errs: string[] = [];
  const e = row.expected;
  if (result.verdict !== e.verdict) errs.push(`verdict ${result.verdict} ≠ ${e.verdict}`);
  if (result.stage !== e.stage) errs.push(`stage ${result.stage} ≠ ${e.stage}`);
  if (e.rule !== undefined && result.rule !== e.rule) errs.push(`rule ${result.rule} ≠ ${e.rule}`);
  if (!e.ticket) {
    if (result.ticket) errs.push("expected no ticket, got one");
    return errs;
  }
  const t = result.ticket;
  if (!t) {
    errs.push("expected a ticket, got none");
    return errs;
  }
  const sizing = result.sizing;
  if (!sizing) {
    errs.push("expected a sizing decision, got none");
    return errs;
  }
  const num = (label: string, actual: number, expected: number): void => {
    if (round6(actual) !== round6(expected)) errs.push(`${label} ${round6(actual)} ≠ ${round6(expected)}`);
  };
  if (result.side !== e.ticket.direction) errs.push(`direction ${result.side} ≠ ${e.ticket.direction}`);
  num("amountBaseUnits", sizing.amountBaseUnits, e.ticket.amountBaseUnits);
  num("contracts", sizing.contracts, e.ticket.contracts);
  num("multiplier", sizing.contractMultiplier, e.ticket.multiplier);
  num("leverage", sizing.leverage, e.ticket.leverage);
  num("riskUsd", sizing.dollarRiskAtStopUsd, e.ticket.riskUsd);
  num("marginRequiredUsd", sizing.marginRequiredUsd, e.ticket.marginRequiredUsd);
  num("notionalUsd", sizing.notionalUsd, e.ticket.notionalUsd);
  num("stopPrice", sizing.stopPrice, e.ticket.stopPrice);
  num("entryPrice", sizing.entryPrice, e.ticket.entryPrice);
  num("liqDistancePct", sizing.liquidationDistancePct, e.ticket.liqDistancePct);
  // The wire payload must carry the BASE-UNIT amount, not the contract count.
  if (String(t["amount"]) !== String(e.ticket.amountBaseUnits)) {
    errs.push(`wire amount ${String(t["amount"])} ≠ ${e.ticket.amountBaseUnits} base units`);
  }
  return errs;
}

export type RowOutcome = {
  row: ScenarioRow;
  result: HarnessResult;
  errors: string[];
  /** The payloads the fake exchange was handed (empty when nothing was sent). */
  calls: ExchangeCall[];
};

/** Run one scenario row against a fresh recorder and a fresh ledger. */
export async function runScenarioRow(
  row: ScenarioRow,
  config: HarnessConfig,
): Promise<RowOutcome> {
  const calls: ExchangeCall[] = [];
  const cfg = { ...config, ...(row.config ?? {}) };
  const result = await runDecisionCycle(row.given, cfg, {
    nowMs: row.given.nowMs,
    placeOrder: (call) => {
      calls.push(call);
      return { orderId: "harness-order" };
    },
  });
  return { row, result, errors: checkScenarioExpectations(row, result), calls };
}

/** Run every row in the table. */
export async function runScenarioTable(
  rows: ScenarioRow[] = SCENARIO_TABLE,
  config?: HarnessConfig,
): Promise<RowOutcome[]> {
  const cfg = config ?? defaultHarnessConfig(defaultFilterConfig());
  const out: RowOutcome[] = [];
  for (const row of rows) out.push(await runScenarioRow(row, cfg));
  return out;
}

/**
 * `jw3 harness` — run the whole scenario table offline and report. Exits
 * non-zero when a row does not match its expectations.
 */
export async function cmdHarness(opts: { json?: boolean } = {}): Promise<void> {
  const outcomes = await runScenarioTable();
  const failed = outcomes.filter((o) => o.errors.length > 0);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          scenarios: outcomes.length,
          failed: failed.length,
          rows: outcomes.map((o) => ({
            name: o.row.name,
            verdict: o.result.verdict,
            stage: o.result.stage,
            rule: o.result.rule,
            ticket: o.result.sizing
              ? {
                  amountBaseUnits: o.result.sizing.amountBaseUnits,
                  contracts: o.result.sizing.contracts,
                  multiplier: o.result.sizing.contractMultiplier,
                  leverage: o.result.sizing.leverage,
                  riskUsd: round6(o.result.sizing.dollarRiskAtStopUsd),
                  marginRequiredUsd: round6(o.result.sizing.marginRequiredUsd),
                }
              : null,
            calls: o.calls.length,
            errors: o.errors,
            reason: o.row.reason,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    for (const o of outcomes) {
      const mark = o.errors.length === 0 ? "PASS" : "FAIL";
      const s = o.result.sizing;
      // A sizing decision that says "unfundable" is a REFUSAL, not a
      // ticket — showing "0 contracts" would hide the reason.
      const detail =
        s && s.status === "ok"
          ? `→ ${o.result.side?.toUpperCase()} ${s.amountBaseUnits} base units (${s.contracts} contracts × ${s.contractMultiplier}) · ${s.leverage}x · risk $${round6(s.dollarRiskAtStopUsd)} · margin $${round6(s.marginRequiredUsd)}`
          : `→ ${o.result.verdict} at ${o.result.stage}${o.result.rule ? ` (${o.result.rule})` : ""} — ${o.result.reason}`;
      console.log(`${mark} ${o.row.name.padEnd(32)} ${detail}`);
      for (const e of o.errors) console.log(`     ↳ ${e}`);
    }
    console.log(`HARNESS ${outcomes.length - failed.length}/${outcomes.length} scenarios match · offline, nothing sent`);
  }
  if (failed.length > 0) process.exitCode = 1;
}
