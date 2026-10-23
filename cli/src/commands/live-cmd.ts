/**
 * `jw3 live` — the single live execution path.
 *
 * This is the ONLY command in the CLI that may place an order. Everything
 * upstream produces a DECISION; this command turns an approved decision
 * into exactly one ticket, fires it, and verifies what the venue did.
 *
 * The flow, in order — a trade that fails ANY of these never fires:
 *
 *   1. CANDIDATE   — a live exhaustion signal on the pair (`scan fade`).
 *   2. CONFIRM     — BOTH model legs must agree (fresh JEV + Laya). A
 *                    single-model read is a watch, not a trigger.
 *   3. BOUNCE      — a short requires the +0.4% bounce off the session
 *                    low. Shorting into the flush catches the
 *                    mean-reversion bounce the wrong way.
 *   4. SIZING      — dollar risk is the constraint; leverage is DERIVED
 *                    from stop distance. The cap clamps the size.
 *   5. PRE-FLIGHT  — live venue reads: no position, no working orders,
 *                    free margin, kill switch, daily caps.
 *   6. FIRE        — one limit order + both exit legs.
 *   7. VERIFY      — re-read the venue. A submitted order is NOT a fill.
 *
 * WITHOUT `--yes` this prints the full ticket and sends zero bytes. That
 * is the default, and it is the only safe way to inspect a live plan.
 */
import { planScalp, futuresFade, fadeSignal, dipSignal, type FadeRow } from "../kucoin.js";
import { cpiBlackout } from "../blocking-rules.js";
import { runLive, type LiveCandidate, type LiveResult } from "./live.js";
import { fail, needPat } from "./market.js";
import { resolvePat } from "../config.js";
import { fetchJevTrend } from "./analyze.js";
import { buildMarketState, fetchLayaVerdict } from "./decide.js";

export type LiveCmdArgs = {
  pair: string;
  exchange: string;
  side: "long" | "short" | "auto";
  /** Risk budget as a percent of equity. Default 3. */
  riskPct: number;
  /** Base size in USD for the plan's step ladder. */
  sizeUsd: number;
  json: boolean;
  yes: boolean;
  session: string;
  turn: string;
};

export type LiveCmdDeps = {
  /** Fresh JEV verdict for the pair: side + confidence, or null. */
  jev: (pair: string) => Promise<{ side: "long" | "short"; confidence: number } | null>;
  /** Fresh Laya verdict for the pair: side + confidence, or null. */
  laya: (pair: string) => Promise<{ side: "long" | "short"; confidence: number } | null>;
  /** The bounce off the session low, as a percent. */
  bounceOffLowPct: (pair: string) => Promise<number | null>;
  now: () => number;
};

const normalizeSide = (s: string): "long" | "short" =>
  s === "long" || s === "strong_long" ? "long" : s === "short" || s === "strong_short" ? "short" : "long";

/**
 * The REAL model readers, wired to the actual oracles. Kept here (not in
 * the pure gate) so the gate stays unit-testable and the wiring stays in
 * one obvious place.
 *
 * A JEV or Laya read that FAILS is a null verdict, not a bullish one —
 * the gate treats a missing leg as "no trade".
 */
export function liveModelDeps(exchange: string, pat: string, url?: string): LiveCmdDeps {
  return {
    jev: async (pair) => {
      try {
        const v = await fetchJevTrend(exchange, pair, pat, url);
        const trend = v?.verdict?.trend;
        const raw = String(trend?.verdict ?? "").toLowerCase();
        // `uncertain` is an explicit abstain — it is NOT a weak long.
        if (!raw || raw === "uncertain" || raw === "mixed" || raw === "flat" || trend?.uncertain === true) {
          return null;
        }
        const conf = Number(trend?.agreement ?? 0);
        if (!Number.isFinite(conf) || conf <= 0) return null;
        return { side: normalizeSide(raw), confidence: conf };
      } catch {
        return null;
      }
    },
    laya: async (pair) => {
      try {
        const state = await buildMarketState(pair, exchange, { url, pat });
        const v = await fetchLayaVerdict(state);
        const choice = String(v?.choice ?? "").toLowerCase();
        if (choice !== "long" && choice !== "short") return null;
        return { side: choice as "long" | "short", confidence: Number(v?.confidence ?? 0) };
      } catch {
        return null;
      }
    },
    bounceOffLowPct: async (pair) => {
      const base = pair.split("/")[0] ?? "";
      if (!base) return null;
      return sessionBounce(base, 60);
    },
    now: () => Date.now(),
  };
}

/**
 * Pure: the confluence gate. BOTH legs must agree on direction, and
 * neither may be missing. A single-model read is a watch, not a trigger —
 * this is the rule the repo has measured (16-3 over one live session).
 */
export function confluenceGate(input: {
  jev: { side: "long" | "short"; confidence: number } | null;
  laya: { side: "long" | "short"; confidence: number } | null;
}): { ok: boolean; side: "long" | "short" | null; reason: string } {
  if (!input.jev) return { ok: false, side: null, reason: "no fresh JEV read — a watch, not a trigger" };
  if (!input.laya) return { ok: false, side: null, reason: "no fresh Laya read — a watch, not a trigger" };
  if (input.jev.side !== input.laya.side) {
    return {
      ok: false,
      side: null,
      reason: `models disagree (JEV ${input.jev.side} ${(input.jev.confidence * 100).toFixed(0)}% vs Laya ${input.laya.side} ${(input.laya.confidence * 100).toFixed(0)}%)`,
    };
  }
  return {
    ok: true,
    side: input.jev.side,
    reason: `JEV ${input.jev.side} ${(input.jev.confidence * 100).toFixed(0)}% + Laya ${input.laya.side} ${(input.laya.confidence * 100).toFixed(0)}% agree`,
  };
}

/**
 * Pure: the bounce gate for a short. The owner-ordered rule is +0.4% off
 * the session low — never sell into the flush.
 */
export function bounceGate(input: {
  side: "long" | "short";
  bounceOffLowPct: number | null;
  requiredPct: number;
}): { ok: boolean; reason: string } {
  if (input.side !== "short") return { ok: true, reason: "long — no bounce requirement" };
  if (input.bounceOffLowPct == null) {
    return { ok: false, reason: "no session low available — cannot confirm the bounce" };
  }
  if (input.bounceOffLowPct < input.requiredPct) {
    return {
      ok: false,
      reason: `bounce off the session low is ${input.bounceOffLowPct.toFixed(2)}%, needs ${input.requiredPct.toFixed(2)}% — still in the flush`,
    };
  }
  return { ok: true, reason: `bounce ${input.bounceOffLowPct.toFixed(2)}% off the session low clears the ${input.requiredPct.toFixed(2)}% gate` };
}

/** The session low over the lookback window, and the bounce off it. */
/**
 * The bounce off the session low, in %, over the last `lookbackMin`
 * one-minute bars.
 *
 * EXPORTED so every gate that needs it uses this one implementation —
 * a copy in another module could drift, and the bounce gate is the
 * rule that stops a short being sold into the flush.
 */
export async function sessionBounce(base: string, lookbackMin: number): Promise<number | null> {
  const { futuresKlinesRaw } = await import("../kucoin.js");
  const sym = `${base}USDTM`;
  const now = Date.now();
  // The lookback must span ENOUGH 1h BARS to have a low in it. Asking for
  // a 60-minute window of 1-hour bars returns exactly ONE bar — which
  // failed the `length < 2` guard and made the bounce gate unsatisfiable,
  // so EVERY short was blocked by a data bug rather than by the signal.
  //
  // The request therefore asks for `lookbackMin` PLUS one full bar of
  // headroom, so the window always contains at least two bars.
  const lookbackMs = lookbackMin * 60_000;
  const barMs = 60 * 60_000;
  const kl = await futuresKlinesRaw(sym, 60, now - lookbackMs - barMs, now);
  if (!kl || kl.length < 2) return null;
  const lows = kl.map((k) => Number(k[3])).filter((n) => Number.isFinite(n) && n > 0);
  const closes = kl.map((k) => Number(k[4])).filter((n) => Number.isFinite(n) && n > 0);
  if (lows.length === 0 || closes.length === 0) return null;
  const low = Math.min(...lows);
  const last = closes[closes.length - 1] ?? 0;
  if (!(low > 0) || !(last > 0)) return null;
  return ((last - low) / low) * 100;
}

export async function cmdLive(a: LiveCmdArgs, deps: LiveCmdDeps): Promise<LiveResult | null> {
  const base = a.pair.split("/")[0] ?? "";
  if (!base) {
    fail("live needs --pair BASE/USDT (e.g. --pair SOL/USDT)");
    return null;
  }
  const pat = resolvePat();
  if (!pat) {
    fail("not authenticated — run `jw3 auth login --browser`");
    return null;
  }
  needPat(pat);

    // ── 0. THE TIME-WINDOW VETO, before anything else ──
    //
    // The oracle refuses the CPI blackout (11:30-13:30Z, half-open),
    // because post-CPI chop kills both directions. The live path did
    // NOT: `blocking-rules.ts` was imported by the oracle alone, so the
    // machine's own entry path could fire inside the very window the
    // oracle calls untradeable.
    //
    // The veto is FIRST so it costs nothing: no tape read, no model
    // call, no venue call. The clock is INJECTED (`deps.now`) so the
    // rule is testable and the tests do not depend on the wall clock —
    // the same discipline the oracle's own veto uses.
    const nowMs = deps.now();
    if (cpiBlackout(nowMs)) {
      const msg = "no trade: CPI blackout 11:30-13:30Z — post-CPI chop kills both directions";
      if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg, rule: "cpi_blackout" }, null, 2));
      else console.log(msg);
      return { status: "no-trade", reason: msg, ticket: null, preflight: null };
    }

  // ── 1. CANDIDATE: the live exhaustion signal ──
  let fade: FadeRow;
  try {
    fade = await futuresFade(base);
  } catch (e) {
    fail(`no tape for ${base}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const atrPct = fade.atrPct ?? 0.8;
  // The tape's own signal decides whether there IS a setup and which
  // direction it points. Inferring the side from off-high/off-low geometry
  // instead would fire on pairs whose signal is "neutral" — the live
  // screen accepts states the backtest skipped, and that mismatch is the
  // trap this whole machine exists to avoid.
  const fadeSig = fadeSignal(fade);
  const dipSig = dipSignal(fade);
  const tapeSide: "long" | "short" | null =
    fadeSig === "fade-short" ? "short" : dipSig === "dip-long" ? "long" : null;
  if (tapeSide === null) {
    const why = fadeSig === "late" || dipSig === "extended"
      ? `the tape is extended (${fadeSig}/${dipSig}) — no exhaustion setup`
      : fadeSig === "strong" || dipSig === "capitulation"
        ? `the tape is expanding (${fadeSig}/${dipSig}) — not a fade`
        : `the tape shows no exhaustion signal (${fadeSig}/${dipSig})`;
    const msg = `no trade: ${why}`;
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }

  // ── 2. CONFIRM: both model legs must agree ──
  const [jev, laya] = await Promise.all([deps.jev(a.pair), deps.laya(a.pair)]);
  const conf = confluenceGate({ jev, laya });
  if (!conf.ok || !conf.side) {
    const msg = `no trade: ${conf.reason}`;
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }

  const side = a.side === "auto" ? conf.side : a.side;
  if (a.side !== "auto" && a.side !== conf.side) {
    const msg = `no trade: --side ${a.side} contradicts the models (${conf.side})`;
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }
  // The tape and the models must not contradict each other.
  if (tapeSide !== side) {
    const msg = `no trade: the tape shows a ${tapeSide} exhaustion but the models say ${side}`;
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }

  // ── 3. BOUNCE (shorts only) ──
  const bounce = await deps.bounceOffLowPct(a.pair);
  const bg = bounceGate({ side, bounceOffLowPct: bounce, requiredPct: 0.4 });
  if (!bg.ok) {
    const msg = `no trade: ${bg.reason}`;
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }

  // ── 4. GEOMETRY: TP and stop from the measured plan ──
  // The contract spec (multiplier, tick) is read inside the live path by
  // the sizing engine — reading it here too would be a second network
  // call for the same facts.
  const plan = planScalp(fade.last, atrPct, side, a.sizeUsd, 2);
  if (!plan) {
    const msg = "no trade: could not derive a plan from the tape";
    if (a.json) console.log(JSON.stringify({ status: "no-trade", reason: msg }, null, 2));
    else console.log(msg);
    return { status: "no-trade", reason: msg, ticket: null, preflight: null };
  }

  const candidate: LiveCandidate = {
    pair: a.pair,
    side,
    // ONE ANCHOR PER PRICE.
    //
    // The entry and the target are now BOTH measured from the market
    // (`fade.last`): the live path places a MARKET order, so the entry
    // IS the market, and the take-profit is measured from it so that it
    // is a target the market has to MOVE to reach.
    //
    // It used to be the plan's weighted average entry, because the
    // target was computed from that average. But for a short that
    // average sits ABOVE the last price, so the target sat above the
    // market — and a buy limit above the market fills instantly at the
    // ask. Measured live: 6 of the 8 real round trips were scratches
    // that closed in 4-7 seconds, net -$0.5708 on $0.5672 of fees.
    entryPrice: fade.last,
    stopPrice: plan.killPrice,
    targetPrice: plan.tpPrice,
    atrPct,
    score: 0,
    reason: conf.reason,
  };

  const result = await runLive(
    {
      exchange: a.exchange,
      candidate,
      riskPctOfEquity: a.riskPct,
      venueMaxLeverage: null,
      maintenanceMarginRate: 0.005,
      makerFeePct: 0.02,
      takerFeePct: 0.06,
      session: a.session,
      turn: a.turn,
      nowMs: deps.now(),
    },
    { yes: a.yes, json: a.json, pat },
  );

  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`live ${a.pair} ${side} — ${result.status}: ${result.reason}`);
    if (result.ticket) {
      const t = result.ticket;
      console.log(
        `  size ${t.sizing.contracts} contracts = ${t.sizing.amountBaseUnits} base units  ` +
          `notional $${t.sizing.notionalUsd.toFixed(2)}  x${t.sizing.leverage}  ` +
          `margin $${t.sizing.marginRequiredUsd.toFixed(2)}  risk $${t.sizing.dollarRiskAtStopUsd.toFixed(2)}`,
      );
      console.log(
        `  entry ${t.order.price}  stop ${t.exits.slPrice}  target ${t.exits.tpPrice}  ` +
          `liquidation ${t.sizing.liquidationPrice}  (${t.sizing.liquidationDistancePct.toFixed(2)}% away)`,
      );
      console.log(`  tag ${t.clientOid}`);
    }
    if (result.preflight) {
      for (const g of result.preflight.gates) {
        console.log(`  ${g.ok ? "ok " : "NO "} ${g.id}: ${g.reason}`);
      }
    }
  }
  return result;
}
