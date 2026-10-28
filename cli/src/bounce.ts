/**
 * Bounce-entry trigger: `jw3 bounce --pair X --side short
 * [--bounce-pct 0.4] [--lookback-min 60] [--size …] [--yes]`.
 *
 * Standing rule: shorts only on a +bounce-pct bounce off the flush low,
 * never into the flush itself. The loop tracks the session low (ratcheting
 * min over a bounded 3s mark poll) and fires when the tape prints
 * bouncePct% above that low. A fresh flush low on the same tick can never
 * fire — the bounce is always measured off the ratcheted low.
 *
 * Transport is public KuCoin futures data only (no auth reads): one REST
 * ticker GET per poll (fixed 3s cadence, poll budget derived from
 * --lookback-min, capped at 180min = 3600 polls so the loop terminates).
 * Dry-run default: without --yes a trigger logs WOULD-SHORT and never
 * calls anything. With --yes *and* --size the trigger fires a real market
 * entry (PAT with trade:execute, server re-checks gates). --yes without
 * --size stays ticket-only: there is nothing to size the order with.
 */
import { callTool } from "./mcp.js";
import { futuresCenter } from "./kucoin.js";
import { needPat } from "./commands/market.js";
import { makeIntentKey, ACTOR_MACHINE } from "./commands/trade.js";

export type BounceSide = "long" | "short";

/** Fixed poll cadence (ms) — the spec's 3s mark poll. */
export const BOUNCE_INTERVAL_MS = 3000;
/** Standing default: short the +0.4% bounce off the flush low. */
export const BOUNCE_DEFAULT_PCT = 0.4;
/** Default session window (min). */
export const BOUNCE_DEFAULT_LOOKBACK_MIN = 60;
/** Hard window ceiling: 180min × 20 polls/min = 3600 — the loop terminates. */
export const BOUNCE_MAX_LOOKBACK_MIN = 180;

export type BounceArgs = {
  exchange: string;
  pair: string;
  side: BounceSide;
  /** Bounce above the session low that fires the entry (percent). */
  bouncePct: number;
  /** Session window to track the low over (minutes, 1..180). */
  lookbackMin: number;
  /**
   * Entry size in base/contract units (passed as `amount` to execute_trade).
   * Omit for ticket-only: triggers print but never send, even with --yes.
   */
  size?: number;
};

/** Pure: poll budget for a lookback window (NaN when the window is unusable). */
export function pollsForLookback(lookbackMin: number): number {
  if (!Number.isFinite(lookbackMin) || lookbackMin <= 0) return NaN;
  return Math.round((lookbackMin * 60 * 1000) / BOUNCE_INTERVAL_MS);
}

/** Pure validation for bounce args. Null = usable. */
export function validateBounceArgs(a: BounceArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  if (a.side !== "long" && a.side !== "short") return "side must be long|short";
  if (!(a.bouncePct > 0) || !Number.isFinite(a.bouncePct) || a.bouncePct > 10) {
    return "bounce-pct must be 0 < pct <= 10";
  }
  if (
    !Number.isFinite(a.lookbackMin) ||
    a.lookbackMin < 1 ||
    a.lookbackMin > BOUNCE_MAX_LOOKBACK_MIN
  ) {
    return `--lookback-min must be 1..${BOUNCE_MAX_LOOKBACK_MIN}`;
  }
  if (a.size !== undefined && (!(a.size > 0) || !Number.isFinite(a.size))) {
    return "size must be > 0 (omit for ticket-only)";
  }
  return null;
}

/** Pure: ratchet the session low (min). Bad prints never move it. */
export function trackLow(prevLow: number, price: number): number {
  if (!(price > 0)) return prevLow;
  if (!(prevLow > 0)) return price;
  return Math.min(prevLow, price);
}

/**
 * Pure: bounce above the session low in percent.
 * NaN when either leg is unusable — callers treat it as no-update.
 */
export function bouncePctOffLow(low: number, price: number): number {
  if (!(low > 0) || !(price > 0)) return NaN;
  return ((price - low) / low) * 100;
}

/** Pure: trigger price for a low (low + bouncePct%). NaN when unusable. */
export function triggerPriceForLow(low: number, bouncePct: number): number {
  if (!(low > 0) || !(bouncePct > 0) || !Number.isFinite(bouncePct)) return NaN;
  return low * (1 + bouncePct / 100);
}

/** Pure: fired once the bounce off the low reaches bouncePct. Never on bad legs. */
export function bounceTriggered(low: number, price: number, bouncePct: number): boolean {
  const b = bouncePctOffLow(low, price);
  return Number.isFinite(b) && (b as number) >= bouncePct;
}

export type BounceTick = {
  /** Ratcheted session low after this tick. */
  low: number;
  /** Bounce off the ratcheted low in percent (NaN when unusable). */
  bouncePctOff: number;
  /** Trigger price for the ratcheted low (null when unusable). */
  trigger: number | null;
  /** True once the bounce reaches bouncePct. */
  fired: boolean;
};

/**
 * Pure single-tick transition: ratchet the low, then measure the bounce off
 * the ratcheted low. A fresh flush low on the same tick yields off = 0, so
 * the trigger never fires into the flush itself.
 */
export function bounceTick(low: number, price: number, bouncePct: number): BounceTick {
  const nextLow = trackLow(low, price);
  const off = bouncePctOffLow(nextLow, price);
  const tp = triggerPriceForLow(nextLow, bouncePct);
  const fired = Number.isFinite(off) && (off as number) >= bouncePct;
  return { low: nextLow, bouncePctOff: off, trigger: Number.isFinite(tp) ? tp : null, fired };
}

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

/**
 * SINGLE construction site for the bounce trigger ticket. Machine strategy
 * path: actor "machine" (see ACTOR MAP in trade.ts), and a per-INTENT
 * idempotency key derived from the trigger's own shape (mirror live.ts),
 * so a retried trigger reproduces the same key instead of double-firing.
 */
export function bounceOrderArgs(o: {
  exchange: string;
  pair: string;
  side: BounceSide;
  /** Entry size in base units. */
  size: number;
  /** Explicit per-intent idempotency key (manual override; auto-derived when omitted). */
  idempotencyKey?: string;
  /** Explicit actor (machine strategy path; defaults to "machine"). */
  actor?: string;
}): Record<string, unknown> {
  const entrySide = o.side === "short" ? "sell" : "buy";
  const amount = String(o.size);
  return {
    exchange: o.exchange,
    pair: o.pair,
    side: entrySide,
    // BASE units: `execute_trade` divides by the contract multiplier
    // server-side. `--size` is therefore base units (e.g. IRYS, multiplier
    // 100: `--size 1200` = 12 contracts). A size below one lot is refused
    // by the caller rather than by the venue after the fact.
    amount,
    market: "futures",
    idempotency_key: o.idempotencyKey?.trim() ? o.idempotencyKey.trim() : makeIntentKey(
      "bounce",
      [o.exchange, o.pair, entrySide, amount].join("|"),
    ),
    actor: o.actor?.trim() ? o.actor.trim() : ACTOR_MACHINE,
  };
}

export type BounceDeps = {
  markFn?: (base: string) => Promise<number>;
  sleepMs?: (ms: number) => Promise<void>;
  /**
   * Fund-moving call for `--yes --size` (default: the real execute_trade).
   * Tests inject a spy and assert dry runs never touch it.
   */
  call?: (
    name: string,
    args: Record<string, unknown>,
    pat: string,
    url?: string,
  ) => Promise<unknown>;
};

/**
 * `jw3 bounce` — bounded 3s mark poll, track the session low, fire the
 * entry ticket on a +bouncePct% bounce off the low. Dry-run default
 * (no --yes: WOULD ticket, nothing sent).
 */
export async function cmdBounce(
  a: BounceArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
  deps?: BounceDeps,
): Promise<void> {
  const err = validateBounceArgs(a);
  if (err) {
    console.error(`Bad ticket: ${err}`);
    process.exitCode = 2;
    return;
  }
  const base = (a.pair.split("/")[0] ?? "").toUpperCase();
  if (!base) {
    console.error("Usage: jw3 bounce --pair SOL/USDT --side short [--bounce-pct 0.4] [--lookback-min 60] [--size …] [--yes]");
    process.exitCode = 2;
    return;
  }
  const polls = pollsForLookback(a.lookbackMin);
  const markFn = deps?.markFn ?? ((b: string) => futuresCenter(b));
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const mode = opts.yes ? "live" : "dry";
  const sized = a.size !== undefined;

  if (opts.yes && sized) {
    const pat = needPat(opts.pat);
    if (!pat) return;
  }

  if (!opts.json) {
    console.log(
      `BOUNCE ${a.side.toUpperCase()} ${a.pair} on ${a.exchange} — fire +${a.bouncePct}% off session low (${a.lookbackMin}min window, ${polls} polls × 3s, ${mode}${sized ? `, size ${a.size}` : ", ticket-only"})`,
    );
  } else {
    console.log(
      JSON.stringify({
        event: "start", pair: a.pair, exchange: a.exchange, side: a.side,
        bouncePct: a.bouncePct, lookbackMin: a.lookbackMin,
        polls, intervalSec: 3, mode, size: a.size ?? null,
      }),
    );
  }

  /** Fire the trigger path for `price` off `low` (dry WOULD or real entry). */
  const fireTrigger = async (price: number, low: number): Promise<void> => {
    const off = bouncePctOffLow(low, price);
    const offS = Number.isFinite(off) ? `${off.toFixed(3)}%` : "—";
    if (!opts.yes) {
      if (opts.json) {
        console.log(
          JSON.stringify({
            event: "would-fire", pair: a.pair, exchange: a.exchange, side: a.side,
            price, low, bouncePctOff: off, triggerPct: a.bouncePct, mode: "dry", size: a.size ?? null,
          }),
        );
      } else {
        console.log(
          `WOULD-${a.side.toUpperCase()} ${a.pair} @ ${px(price)} (+${offS} off low ${px(low)}, trigger +${a.bouncePct}%) — dry run, nothing sent. Re-run with --yes${sized ? "" : " --size …"} to fire (real money).`,
        );
      }
      return;
    }
    if (!sized) {
      if (opts.json) {
        console.log(
          JSON.stringify({
            event: "ticket-only", pair: a.pair, exchange: a.exchange, side: a.side,
            price, low, bouncePctOff: off, triggerPct: a.bouncePct, mode: "dry", reason: "no-size",
          }),
        );
      } else {
        console.log(
          `BOUNCE ${a.side.toUpperCase()} ${a.pair} @ ${px(price)} (+${offS} off low ${px(low)}, trigger +${a.bouncePct}%) — no --size: ticket only, nothing sent.`,
        );
      }
      return;
    }
    const pat = needPat(opts.pat);
    if (!pat) return;
    // `sized` was checked above (unsized returns ticket-only), so a.size is
    // set here; the builder takes a plain number.
    const size = a.size as number;
    const toolArgs: Record<string, unknown> = bounceOrderArgs({
      exchange: a.exchange,
      pair: a.pair,
      side: a.side,
      size,
    });
    try {
      const call = deps?.call ?? callTool;
      const out = await call("execute_trade", toolArgs, pat, opts.url);
      if (opts.json) {
        console.log(
          JSON.stringify({
            event: "fired", pair: a.pair, exchange: a.exchange, side: a.side,
            price, low, bouncePctOff: off, order: out,
          }),
        );
      } else {
        console.log(`FIRED ${a.side.toUpperCase()} ${a.pair} @ ${px(price)} (+${offS} off low ${px(low)}): ${JSON.stringify(out)}`);
      }
    } catch (e) {
      console.error(`ENTRY FAILED: ${e instanceof Error ? e.message : String(e)} — nothing filled, ticket kept above.`);
      process.exitCode = 1;
    }
  };

  let low = 0;
  for (let i = 1; i <= polls; i++) {
    let mark: number;
    try {
      mark = await markFn(base);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) console.log(JSON.stringify({ poll: i, status: "tape-error", error: msg }));
      else console.log(`EVENT poll=${i} status=tape-error error=${JSON.stringify(msg)}`);
      if (i < polls) await sleep(BOUNCE_INTERVAL_MS);
      continue;
    }
    if (!(mark > 0) || !Number.isFinite(mark)) {
      if (opts.json) console.log(JSON.stringify({ poll: i, status: "tape-error", error: "bad mark" }));
      else console.log(`EVENT poll=${i} status=tape-error error="bad mark"`);
      if (i < polls) await sleep(BOUNCE_INTERVAL_MS);
      continue;
    }
    if (!(low > 0)) {
      low = mark;
      const trigger = triggerPriceForLow(low, a.bouncePct);
      if (opts.json) {
        console.log(JSON.stringify({ poll: i, price: mark, low, trigger, status: "tracking" }));
      } else {
        console.log(`EVENT poll=${i} price=${px(mark)} low=${px(low)} trigger=${px(trigger)} status=tracking — reference set`);
      }
      if (i < polls) await sleep(BOUNCE_INTERVAL_MS);
      continue;
    }
    const t = bounceTick(low, mark, a.bouncePct);
    low = t.low;
    const status = t.fired ? "trigger" : "tracking";
    const offS = Number.isFinite(t.bouncePctOff) ? `+${t.bouncePctOff.toFixed(3)}%` : "—";
    if (opts.json) {
      console.log(
        JSON.stringify({
          poll: i, price: mark, low, bouncePctOff: t.bouncePctOff,
          trigger: t.trigger, status,
        }),
      );
    } else {
      console.log(
        `EVENT poll=${i} price=${px(mark)} low=${px(low)} off=${offS} trigger=${t.trigger === null ? "—" : px(t.trigger)} status=${status}`,
      );
    }
    if (t.fired) {
      await fireTrigger(mark, low);
      return;
    }
    if (i < polls) await sleep(BOUNCE_INTERVAL_MS);
  }
  if (!(low > 0)) {
    console.error("No usable mark inside the poll budget — no low tracked, nothing fired.");
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        event: "done", pair: a.pair, exchange: a.exchange, side: a.side,
        low, polls, status: "no-trigger",
      }),
    );
  } else {
    console.log(
      `BOUNCE DONE — no +${a.bouncePct}% bounce off low ${px(low)} inside ${polls} polls × 3s. Re-run to keep watching.`,
    );
  }
}
