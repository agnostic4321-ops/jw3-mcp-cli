/**
 * Pre-trade filter stack — the cheap, deterministic gates every candidate
 * must pass BEFORE the committee (the model seats) and the sizing engine.
 *
 * Two jobs in one file:
 *
 *  1. COMPOSE the blocking rules that already exist (blocking-rules.ts) —
 *     cpiBlackout, extendedDropVeto, bounceRequiredVeto, btcFeeVeto — so a
 *     candidate that dies there dies here with the SAME rule id and the SAME
 *     reason string. Nothing is reimplemented: every composed verdict comes
 *     from the imported primitive, in precheck()'s precedence order
 *     (cpi_blackout > extended_drop > bounce_required > btc_fee).
 *
 *  2. ADD the gates that were missing: session window, spread, fee drag,
 *     liquidity, funding, day change, duplicate exposure, model quorum.
 *
 * Pure functions over plain data — no network, no clock reads (nowMs is an
 * input), no I/O, no venue calls. The chain is ordered cheapest-first: the
 * composed clock rules and the in-memory rules run before anything that
 * needs market data. The chain short-circuits on the first reject and
 * reports which rule fired.
 *
 * Data discipline: a rule whose data leg is missing does not silently pass.
 * `onMissing: "reject"` (the default) fails closed — a gate that cannot be
 * measured is a gate that cannot be cleared. `"skip"` opts into fail-open.
 * The composed rules keep the published semantics of precheck() exactly
 * (a short with no day-change leg is "unevaluated", not a veto).
 */
import {
  BOUNCE_REQUIRED_PCT,
  EXTENDED_DROP_PCT,
  bounceOffLowPct,
  bounceRequiredVeto,
  btcFeeVeto,
  cpiBlackout,
  extendedDropVeto,
  utcMinutes,
} from "./blocking-rules.js";

/* ------------------------------------------------------------------ types */

export type FilterRuleId =
  | "cpi_blackout"
  | "extended_drop"
  | "bounce_required"
  | "btc_fee"
  | "duplicate"
  | "model_quorum"
  | "session"
  | "day_change"
  | "spread"
  | "fee_drag"
  | "funding"
  | "liquidity";

export type FilterVerdict =
  | { status: "pass"; rule: null; reason: string }
  | { status: "reject"; rule: FilterRuleId; reason: string };

export type FilterChainResult = {
  status: "pass" | "reject";
  /** The rule that fired (null on pass). */
  rule: FilterRuleId | null;
  /** Human reason for the verdict. */
  reason: string;
  /** Rule ids evaluated, in chain order, up to and including the reject. */
  evaluated: FilterRuleId[];
  /** Rule ids skipped because a data leg was missing (fail-open mode). */
  unevaluated: FilterRuleId[];
};

/** Order book tier — the spread cap follows the contract's liquidity class. */
export type FilterTier = "t1" | "t2" | "t3";

export const FILTER_TIERS: FilterTier[] = ["t1", "t2", "t3"];
/** Tier used when the caller does not name one. */
export const DEFAULT_TIER: FilterTier = "t2";

export const SESSION_KEYS = ["asia", "europe", "us"] as const;
export type SessionKey = (typeof SESSION_KEYS)[number];

export type SessionCfg = {
  /** Per-session enable flag — a disabled session rejects the whole window. */
  enabled: boolean;
  /** UTC window start, minutes since UTC midnight (inclusive). */
  startMin: number;
  /** UTC window end, minutes since UTC midnight (exclusive). */
  endMin: number;
  /** Minimum 24h turnover (USD) for this session. */
  minTurnoverUsd: number;
};

export type ModelSeatVote = {
  /** Seat name — must match a configured seat to count. */
  model: string;
  /** True when the seat sat out (a flat/no-call seat abstains). */
  abstained: boolean;
  side?: "long" | "short" | "flat";
};

export type OpenPositionLite = {
  /** Pair or symbol of the open position. */
  symbol: string;
};

export type FiredSignalLite = {
  /** Pair or symbol the signal fired on. */
  symbol: string;
  /** Signal identity — the same id on the same pair is a repeat fire. */
  signalId: string;
  /** Epoch ms the signal fired. */
  firedAtMs: number;
};

export type FilterCandidate = {
  /** Pair or symbol, e.g. "SOL/USDT" or "SOLUSDTM". */
  symbol: string;
  side: "long" | "short";
  /** Epoch ms. The clock is an input, never read from the host. */
  nowMs: number;
  /** Identity of the signal that produced this candidate (for the cooldown). */
  signalId?: string;
  /** Contract tier — picks the spread cap. Defaults to t2. */
  tier?: FilterTier;
  /** 24h turnover in USD. */
  turnoverUsd24h?: number;
  /** Best bid / best ask of the book. */
  bestBid?: number;
  bestAsk?: number;
  /** Notional available at the top 5 book levels on the side we would hit. */
  top5DepthUsd?: number;
  /** Leveraged notional of the planned order (USD). */
  notionalUsd?: number;
  /** Per-side fee as a percent (0.06 = 0.06% — the KuCoin taker rate). */
  feePctPerSide?: number;
  /** Stop distance as a percent (0.5 = 0.5%). */
  stopDistancePct?: number;
  /** Funding rate as a percent per interval (+ = longs pay shorts). */
  fundingPct?: number;
  /** Day change in percent (+ = up). */
  dayChgPct?: number;
  /** Last price and the session low (the composed bounce rule). */
  price?: number;
  sessionLow?: number;
  /** Currently open positions (duplicate/exposure). */
  openPositions?: OpenPositionLite[];
  /** Signals that already fired (cooldown). */
  recentSignals?: FiredSignalLite[];
  /** The committee's model seats. */
  modelSeats?: ModelSeatVote[];
  /** Account size, lot size and fee-tier flag (the composed BTC fee rule). */
  accountUsd?: number;
  sizeLots?: number;
  feeTierOk?: boolean;
};

export type FilterConfig = {
  sessions: Record<SessionKey, SessionCfg>;
  /** Max bid-ask spread in basis points, per tier. */
  spreadBps: Record<FilterTier, number>;
  /** Round-trip fees must stay under this fraction of the stop distance. */
  maxFeeDragFraction: number;
  /** Floor on 24h turnover (USD). */
  minTurnoverUsd24h: number;
  /** Top-5 book depth must cover the order notional by this multiple. */
  minDepthMultiple: number;
  /** Max funding against a LONG, in percent per interval. */
  maxLongFundingPct: number;
  /** Max funding against a SHORT, in percent per interval. */
  maxShortFundingPct: number;
  /** Hours the position is expected to be held — scales the funding carry. */
  fundingHoldHours: number;
  /** A LONG is rejected when the day is already up this much (late chase). */
  longChasePct: number;
  /** A SHORT is rejected when the day is already down this much. */
  shortDropPct: number;
  /** Cooldown for the same (signal, pair) firing again. */
  duplicateCooldownMs: number;
  /** Model seats that count, and how many must be non-abstained. */
  quorum: { seats: string[]; minNonAbstained: number };
  /** What a rule does when its data leg is missing. */
  onMissing: "reject" | "skip";
};

/* --------------------------------------------------------------- defaults */

/** Funding accrues on an 8h interval — the carry scales from that base. */
export const FUNDING_INTERVAL_HOURS = 8;

/** Default per-session windows (UTC) and liquidity floors. */
export const DEFAULT_SESSIONS: Record<SessionKey, SessionCfg> = {
  asia: { enabled: true, startMin: 0, endMin: 8 * 60, minTurnoverUsd: 500_000 },
  europe: { enabled: true, startMin: 8 * 60, endMin: 13 * 60, minTurnoverUsd: 1_000_000 },
  us: { enabled: true, startMin: 14 * 60, endMin: 21 * 60, minTurnoverUsd: 2_000_000 },
};

/** A fresh config every call — callers mutate their copy, nobody mutates ours. */
export function defaultFilterConfig(): FilterConfig {
  return {
    sessions: {
      asia: { ...DEFAULT_SESSIONS.asia },
      europe: { ...DEFAULT_SESSIONS.europe },
      us: { ...DEFAULT_SESSIONS.us },
    },
    spreadBps: { t1: 5, t2: 10, t3: 15 },
    maxFeeDragFraction: 0.25,
    minTurnoverUsd24h: 500_000,
    minDepthMultiple: 1,
    maxLongFundingPct: 0.05,
    maxShortFundingPct: 0.05,
    fundingHoldHours: 8,
    longChasePct: 2,
    // Mirrors the composed extended_drop rule so the two can never disagree.
    shortDropPct: EXTENDED_DROP_PCT,
    duplicateCooldownMs: 3_600_000,
    quorum: { seats: ["kronos", "laya", "rfdetr"], minNonAbstained: 2 },
    onMissing: "reject",
  };
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = defaultFilterConfig();

/**
 * The chain, cheapest first. The composed block keeps precheck()'s internal
 * precedence so a rule id never changes meaning; the new filters follow,
 * in-memory (no market data) before market-data rules.
 */
export const FILTER_CHAIN: readonly FilterRuleId[] = [
  "cpi_blackout",
  "extended_drop",
  "bounce_required",
  "btc_fee",
  "duplicate",
  "model_quorum",
  "session",
  "day_change",
  "spread",
  "fee_drag",
  "funding",
  "liquidity",
];

/* --------------------------------------------------------------- helpers */

function passVerdict(reason: string): FilterVerdict {
  return { status: "pass", rule: null, reason };
}

function rejectVerdict(rule: FilterRuleId, reason: string): FilterVerdict {
  return { status: "reject", rule, reason };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** $1,234,567 — deterministic grouping, no locale dependency. */
function fmtUsd(n: number): string {
  const neg = n < 0;
  const s = Math.abs(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${s}`;
}

/** $12.34 — money to the cent. */
function fmtUsd2(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** 08:00 — minutes since UTC midnight → HH:MM. */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 08:00-13:00Z — a session window as a readable string. */
function windowText(s: SessionCfg): string {
  return `${hhmm(s.startMin)}-${hhmm(s.endMin)}Z`;
}

function sessionLabel(k: SessionKey): string {
  return k === "asia" ? "Asia" : k === "europe" ? "Europe" : "US";
}

/** Base symbol for pair comparison: strips the quote, aliases BTC→XBT. */
function filterBaseOf(symbol: string | null | undefined): string {
  let s = String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const suffix of ["USDTM", "USDT", "USDC", "USD", "PERP"]) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return s === "BTC" ? "XBT" : s;
}

function sideOf(c: FilterCandidate): "long" | "short" {
  return String(c.side ?? "").toLowerCase() === "short" ? "short" : "long";
}

/** Internal rule outcome — `verdict: null` means "not applicable". */
type RuleOutcome = { verdict: FilterVerdict | null; skipped: boolean };

const NA: RuleOutcome = { verdict: null, skipped: false };

/** Missing data leg → fail closed (reject) or fail open (skip), per config. */
function missingOutcome(cfg: FilterConfig, rule: FilterRuleId, what: string): RuleOutcome {
  if (cfg.onMissing === "reject") {
    return { verdict: rejectVerdict(rule, `${what} unavailable — cannot verify this gate`), skipped: false };
  }
  return { verdict: passVerdict(`${what} unavailable — gate skipped`), skipped: true };
}

/* --------------------------------------------------- composed blocking rules */

function cpiBlackoutOutcome(c: FilterCandidate): RuleOutcome {
  if (!cpiBlackout(c.nowMs)) return { verdict: passVerdict("outside the CPI blackout"), skipped: false };
  return {
    verdict: rejectVerdict(
      "cpi_blackout",
      "CPI blackout 11:30-13:30Z: post-CPI chop kills both directions",
    ),
    skipped: false,
  };
}

function extendedDropOutcome(c: FilterCandidate): RuleOutcome {
  if (sideOf(c) !== "short") return NA; // shorts-only rule, exactly like precheck()
  const d = c.dayChgPct;
  if (!isNum(d)) return { verdict: null, skipped: true }; // unevaluated, not a veto
  if (!extendedDropVeto(d)) return { verdict: passVerdict("day drop inside the extended-drop limit"), skipped: false };
  return {
    verdict: rejectVerdict(
      "extended_drop",
      `day down ${d}% past -${EXTENDED_DROP_PCT}%: no shorts into extended drops`,
    ),
    skipped: false,
  };
}

function bounceRequiredOutcome(c: FilterCandidate): RuleOutcome {
  if (sideOf(c) !== "short") return NA; // shorts-only rule, exactly like precheck()
  const price = c.price;
  const low = c.sessionLow;
  if (!isNum(price) || !isNum(low)) return { verdict: null, skipped: true }; // unevaluated
  if (!bounceRequiredVeto("short", price, low)) {
    return { verdict: passVerdict("short has the required bounce off the session low"), skipped: false };
  }
  const b = bounceOffLowPct(price, low);
  const seen = b === null ? "unknown" : `${b.toFixed(2)}%`;
  return {
    verdict: rejectVerdict(
      "bounce_required",
      `short needs +${BOUNCE_REQUIRED_PCT}% off session low (at ${seen}): never short into the flush`,
    ),
    skipped: false,
  };
}

function btcFeeOutcome(c: FilterCandidate): RuleOutcome {
  const vetoed = btcFeeVeto(c.symbol, {
    sizeLots: c.sizeLots,
    accountUsd: c.accountUsd,
    notionalUsd: c.notionalUsd,
    feeTierOk: c.feeTierOk,
  });
  if (!vetoed) return { verdict: passVerdict("fee-unprofitable BTC bench not triggered"), skipped: false };
  return {
    verdict: rejectVerdict(
      "btc_fee",
      "BTC fee-unprofitable at minimum size on small account: taker fees consume the edge (bench; re-enable on size/fee-tier change)",
    ),
    skipped: false,
  };
}

/* ------------------------------------------------------------ new filters */

function sessionOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const min = utcMinutes(c.nowMs);
  const covering = SESSION_KEYS.filter((k) => {
    const s = cfg.sessions[k];
    return min >= s.startMin && min < s.endMin;
  });
  if (covering.length === 0) {
    const all = SESSION_KEYS.map((k) => `${k} ${windowText(cfg.sessions[k])}`).join(", ");
    return {
      verdict: rejectVerdict("session", `no trading session open at ${hhmm(min)}Z (${all})`),
      skipped: false,
    };
  }
  const enabled = covering.filter((k) => cfg.sessions[k].enabled);
  if (enabled.length === 0) {
    const k = covering[0] as SessionKey;
    return {
      verdict: rejectVerdict(
        "session",
        `${sessionLabel(k)} session disabled (${windowText(cfg.sessions[k])})`,
      ),
      skipped: false,
    };
  }
  const key = enabled[0] as SessionKey;
  const s = cfg.sessions[key];
  const turnover = c.turnoverUsd24h;
  if (!isNum(turnover)) return missingOutcome(cfg, "session", "24h turnover");
  if (turnover < s.minTurnoverUsd) {
    return {
      verdict: rejectVerdict(
        "session",
        `24h turnover ${fmtUsd(turnover)} below the ${sessionLabel(key)} session floor ${fmtUsd(s.minTurnoverUsd)}`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(
      `${sessionLabel(key)} session (${windowText(s)}) — turnover ${fmtUsd(turnover)} clears the ${fmtUsd(s.minTurnoverUsd)} floor`,
    ),
    skipped: false,
  };
}

function dayChangeOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const d = c.dayChgPct;
  if (!isNum(d)) return missingOutcome(cfg, "day_change", "day change");
  if (sideOf(c) === "long" && d > cfg.longChasePct) {
    return {
      verdict: rejectVerdict(
        "day_change",
        `LONG into a +${d.toFixed(2)}% day (cap +${cfg.longChasePct.toFixed(2)}%) — late-entry chase: the move is already extended`,
      ),
      skipped: false,
    };
  }
  if (sideOf(c) === "short" && d < -cfg.shortDropPct) {
    return {
      verdict: rejectVerdict(
        "day_change",
        `SHORT into a ${d.toFixed(2)}% day (cap -${cfg.shortDropPct.toFixed(2)}%) — extended drop: the flush usually continues`,
      ),
      skipped: false,
    };
  }
  return { verdict: passVerdict(`day change ${d.toFixed(2)}% inside the chase/extension limits`), skipped: false };
}

function spreadOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const bid = c.bestBid;
  const ask = c.bestAsk;
  if (!isNum(bid) || !isNum(ask) || !(bid > 0) || !(ask > 0)) {
    return missingOutcome(cfg, "spread", "best bid/ask");
  }
  if (ask < bid) {
    return {
      verdict: rejectVerdict("spread", `crossed book (bid ${bid} above ask ${ask}) — refusing to price a spread`),
      skipped: false,
    };
  }
  const tier = c.tier ?? DEFAULT_TIER;
  const cap = cfg.spreadBps[tier];
  const mid = (bid + ask) / 2;
  const bps = ((ask - bid) / mid) * 1e4;
  if (bps > cap) {
    return {
      verdict: rejectVerdict(
        "spread",
        `spread ${bps.toFixed(1)}bps (${(bps / 100).toFixed(3)}%) over the ${tier} cap ${cap.toFixed(1)}bps (${(cap / 100).toFixed(3)}%) — the spread is the edge`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(`spread ${bps.toFixed(1)}bps within the ${tier} cap ${cap.toFixed(1)}bps`),
    skipped: false,
  };
}

function feeDragOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const notional = c.notionalUsd;
  const fee = c.feePctPerSide;
  const stop = c.stopDistancePct;
  if (!isNum(notional) || !(notional > 0)) return missingOutcome(cfg, "fee_drag", "order notional");
  if (!isNum(fee) || fee < 0) return missingOutcome(cfg, "fee_drag", "fee rate");
  if (!isNum(stop) || !(stop > 0)) return missingOutcome(cfg, "fee_drag", "stop distance");
  const feePct = fee * 2; // round trip
  const feeUsd = notional * (feePct / 100);
  const stopUsd = notional * (stop / 100);
  const fraction = feePct / stop;
  if (fraction > cfg.maxFeeDragFraction) {
    return {
      verdict: rejectVerdict(
        "fee_drag",
        `round-trip fees ${fmtUsd2(feeUsd)} (${feePct.toFixed(3)}% of notional) are ${(fraction * 100).toFixed(0)}% of the ${fmtUsd2(stopUsd)} stop — fees eat the edge`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(
      `round-trip fees ${(fraction * 100).toFixed(0)}% of the stop (cap ${(cfg.maxFeeDragFraction * 100).toFixed(0)}%)`,
    ),
    skipped: false,
  };
}

function fundingOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const f = c.fundingPct;
  if (!isNum(f)) return missingOutcome(cfg, "funding", "funding rate");
  const carry = Math.abs(f) * (cfg.fundingHoldHours / FUNDING_INTERVAL_HOURS);
  if (sideOf(c) === "long" && f > 0 && carry > cfg.maxLongFundingPct) {
    return {
      verdict: rejectVerdict(
        "funding",
        `funding +${f.toFixed(3)}%/8h against a LONG (${carry.toFixed(3)}% carry over the ${cfg.fundingHoldHours}h hold) — extreme funding, the position pays to hold`,
      ),
      skipped: false,
    };
  }
  if (sideOf(c) === "short" && f < 0 && carry > cfg.maxShortFundingPct) {
    return {
      verdict: rejectVerdict(
        "funding",
        `funding ${f.toFixed(3)}%/8h against a SHORT (${carry.toFixed(3)}% carry over the ${cfg.fundingHoldHours}h hold) — extreme funding, the position pays to hold`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(
      `funding ${f.toFixed(3)}%/8h ${sideOf(c) === "long" ? (f > 0 ? "against" : "in favour of") : f < 0 ? "against" : "in favour of"} the ${sideOf(c).toUpperCase()}`,
    ),
    skipped: false,
  };
}

function liquidityOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const turnover = c.turnoverUsd24h;
  if (!isNum(turnover)) return missingOutcome(cfg, "liquidity", "24h turnover");
  if (turnover < cfg.minTurnoverUsd24h) {
    return {
      verdict: rejectVerdict(
        "liquidity",
        `24h turnover ${fmtUsd(turnover)} below the ${fmtUsd(cfg.minTurnoverUsd24h)} floor`,
      ),
      skipped: false,
    };
  }
  const depth = c.top5DepthUsd;
  if (!isNum(depth)) return missingOutcome(cfg, "liquidity", "top-5 book depth");
  const notional = c.notionalUsd;
  if (!isNum(notional) || !(notional > 0)) return missingOutcome(cfg, "liquidity", "order notional");
  const need = notional * cfg.minDepthMultiple;
  if (depth < need) {
    return {
      verdict: rejectVerdict(
        "liquidity",
        `top-5 book depth ${fmtUsd(depth)} thinner than the ${fmtUsd(need)} order notional`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(
      `turnover ${fmtUsd(turnover)} over the ${fmtUsd(cfg.minTurnoverUsd24h)} floor · top-5 depth ${fmtUsd(depth)} covers the ${fmtUsd(need)} notional`,
    ),
    skipped: false,
  };
}

function duplicateOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const base = filterBaseOf(c.symbol);
  const open = c.openPositions;
  if (!Array.isArray(open)) return missingOutcome(cfg, "duplicate", "open positions");
  for (const p of open) {
    if (!p || typeof p.symbol !== "string") continue;
    if (filterBaseOf(p.symbol) === base) {
      return {
        verdict: rejectVerdict("duplicate", `${p.symbol} already open — no double-fire on the same pair`),
        skipped: false,
      };
    }
  }
  if (typeof c.signalId !== "string" || c.signalId === "") {
    return { verdict: passVerdict("no signal id — cooldown not applicable"), skipped: false };
  }
  const signals = c.recentSignals;
  if (!Array.isArray(signals)) return missingOutcome(cfg, "duplicate", "fired-signal history");
  for (const s of signals) {
    if (!s || s.signalId !== c.signalId) continue;
    if (filterBaseOf(s.symbol) !== base) continue;
    const since = c.nowMs - s.firedAtMs;
    if (!Number.isFinite(since) || since < 0) continue;
    if (since >= cfg.duplicateCooldownMs) continue;
    const minsAgo = Math.floor(since / 60000);
    const minsLeft = Math.ceil((cfg.duplicateCooldownMs - since) / 60000);
    return {
      verdict: rejectVerdict(
        "duplicate",
        `signal ${s.signalId} already fired on ${s.symbol} ${minsAgo}m ago — ${Math.round(cfg.duplicateCooldownMs / 60000)}m cooldown, ${minsLeft}m left`,
      ),
      skipped: false,
    };
  }
  return { verdict: passVerdict("no open position and no recent fire on this pair"), skipped: false };
}

function quorumOutcome(c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  const seats = c.modelSeats;
  if (!Array.isArray(seats)) return missingOutcome(cfg, "model_quorum", "model seats");
  const configured = cfg.quorum.seats;
  const active = seats.filter((s) => !!s && configured.includes(s.model) && !s.abstained).length;
  if (active < cfg.quorum.minNonAbstained) {
    return {
      verdict: rejectVerdict(
        "model_quorum",
        `only ${active} of ${configured.length} model seats non-abstained (need ${cfg.quorum.minNonAbstained}) — one weak model cannot carry a trade`,
      ),
      skipped: false,
    };
  }
  return {
    verdict: passVerdict(`${active} of ${configured.length} model seats non-abstained (need ${cfg.quorum.minNonAbstained})`),
    skipped: false,
  };
}

/* ----------------------------------------------------------------- chain */

function evaluateRule(rule: FilterRuleId, c: FilterCandidate, cfg: FilterConfig): RuleOutcome {
  switch (rule) {
    case "cpi_blackout":
      return cpiBlackoutOutcome(c);
    case "extended_drop":
      return extendedDropOutcome(c);
    case "bounce_required":
      return bounceRequiredOutcome(c);
    case "btc_fee":
      return btcFeeOutcome(c);
    case "duplicate":
      return duplicateOutcome(c, cfg);
    case "model_quorum":
      return quorumOutcome(c, cfg);
    case "session":
      return sessionOutcome(c, cfg);
    case "day_change":
      return dayChangeOutcome(c, cfg);
    case "spread":
      return spreadOutcome(c, cfg);
    case "fee_drag":
      return feeDragOutcome(c, cfg);
    case "funding":
      return fundingOutcome(c, cfg);
    case "liquidity":
      return liquidityOutcome(c, cfg);
  }
}

/**
 * Run the whole stack. Short-circuits on the first reject and reports the
 * rule that fired. Pure — the candidate carries its own clock and data.
 */
export function runFilters(
  candidate: FilterCandidate,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): FilterChainResult {
  const evaluated: FilterRuleId[] = [];
  const unevaluated: FilterRuleId[] = [];
  for (const rule of FILTER_CHAIN) {
    const out = evaluateRule(rule, candidate, config);
    if (out.skipped) {
      // The rule's data leg was missing — it was reached but never decided.
      unevaluated.push(rule);
      continue;
    }
    if (out.verdict === null) continue; // not applicable to this candidate
    evaluated.push(rule);
    if (out.verdict.status === "reject") {
      return {
        status: "reject",
        rule: out.verdict.rule,
        reason: out.verdict.reason,
        evaluated,
        unevaluated,
      };
    }
  }
  return {
    status: "pass",
    rule: null,
    reason: "all pre-trade filters pass",
    evaluated,
    unevaluated,
  };
}

/* --------------------------------------------- the individual public filters */

export function sessionFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return sessionOutcome(candidate, config).verdict ?? passVerdict("session not applicable");
}

export function dayChangeFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return dayChangeOutcome(candidate, config).verdict ?? passVerdict("day change not applicable");
}

export function spreadFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return spreadOutcome(candidate, config).verdict ?? passVerdict("spread not applicable");
}

export function feeDragFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return feeDragOutcome(candidate, config).verdict ?? passVerdict("fee drag not applicable");
}

export function fundingFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return fundingOutcome(candidate, config).verdict ?? passVerdict("funding not applicable");
}

export function liquidityFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return liquidityOutcome(candidate, config).verdict ?? passVerdict("liquidity not applicable");
}

export function duplicateFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return duplicateOutcome(candidate, config).verdict ?? passVerdict("duplicate not applicable");
}

export function quorumFilter(candidate: FilterCandidate, config: FilterConfig = DEFAULT_FILTER_CONFIG): FilterVerdict {
  return quorumOutcome(candidate, config).verdict ?? passVerdict("model quorum not applicable");
}

/* -------------------------------------------------------------- catalogue */

export type FilterCatalogEntry = {
  id: FilterRuleId;
  /** One line: what the gate does. */
  what: string;
  /** The default thresholds, in one readable line. */
  defaults: string;
  /** The reject-reason wording (template). */
  reason: string;
  /** True when the rule is composed from blocking-rules.ts. */
  composed: boolean;
};

export const FILTER_CATALOG: FilterCatalogEntry[] = [
  {
    id: "cpi_blackout",
    what: "No trade in the CPI release window (both directions).",
    defaults: "11:30-13:30Z blackout",
    reason: "CPI blackout 11:30-13:30Z: post-CPI chop kills both directions",
    composed: true,
  },
  {
    id: "extended_drop",
    what: "No short when the day session is down past the extended-drop limit.",
    defaults: `-${EXTENDED_DROP_PCT}% day change (shorts only)`,
    reason: "day down {x}% past -2%: no shorts into extended drops",
    composed: true,
  },
  {
    id: "bounce_required",
    what: "A short needs a bounce off the session low before it may enter.",
    defaults: `+${BOUNCE_REQUIRED_PCT}% off the session low (shorts only)`,
    reason: "short needs +0.4% off session low (at {b}%): never short into the flush",
    composed: true,
  },
  {
    id: "btc_fee",
    what: "BTC is benched while the size is too small to beat the taker fee.",
    defaults: `notional < $50 and account < $25 (fee tier overrides)`,
    reason:
      "BTC fee-unprofitable at minimum size on small account: taker fees consume the edge (bench; re-enable on size/fee-tier change)",
    composed: true,
  },
  {
    id: "duplicate",
    what: "No second position on the same pair; no repeat fire inside the cooldown.",
    defaults: "60m cooldown per (signal, pair)",
    reason: "{pair} already open — no double-fire on the same pair",
    composed: false,
  },
  {
    id: "model_quorum",
    what: "At least K model seats must be non-abstained to carry the trade.",
    defaults: "2 of 3 seats (kronos, laya, rfdetr)",
    reason: "only {n} of {m} model seats non-abstained (need {k}) — one weak model cannot carry a trade",
    composed: false,
  },
  {
    id: "session",
    what: "Only trade inside an enabled UTC session that clears its liquidity floor.",
    defaults: "asia 00:00-08:00Z $500k · europe 08:00-13:00Z $1M · us 14:00-21:00Z $2M turnover",
    reason: "24h turnover {t} below the {session} session floor {floor}",
    composed: false,
  },
  {
    id: "day_change",
    what: "No long into an already-extended day; no short into an extended drop.",
    defaults: "long +2.00% · short -2.00% day change",
    reason: "LONG into a +{x}% day (cap +2.00%) — late-entry chase: the move is already extended",
    composed: false,
  },
  {
    id: "spread",
    what: "The bid-ask spread must fit inside the tier cap.",
    defaults: "t1 5bps · t2 10bps · t3 15bps",
    reason: "spread {bps}bps ({pct}%) over the {tier} cap {cap}bps — the spread is the edge",
    composed: false,
  },
  {
    id: "fee_drag",
    what: "Round-trip fees must stay a small fraction of the stop distance.",
    defaults: "fees <= 25% of the stop distance",
    reason: "round-trip fees {feeUsd} ({feePct}% of notional) are {pct}% of the {stopUsd} stop — fees eat the edge",
    composed: false,
  },
  {
    id: "funding",
    what: "Funding must not be extreme against the position direction.",
    defaults: "0.05% per 8h interval, scaled by the 8h hold",
    reason: "funding {f}%/8h against a {side} ({carry}% carry over the 8h hold) — extreme funding, the position pays to hold",
    composed: false,
  },
  {
    id: "liquidity",
    what: "24h turnover must clear the floor and the top-5 book must hold the order.",
    defaults: "$500k 24h turnover · top-5 depth >= 1.0x the order notional",
    reason: "top-5 book depth {depth} thinner than the {notional} order notional",
    composed: false,
  },
];
