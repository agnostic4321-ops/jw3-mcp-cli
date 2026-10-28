/**
 * Trail engine: `jw3 trail --pair X --side long|short --size LOT
 * [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--yes]`.
 *
 * Protects an open futures position with a ratcheting close-stop:
 * entry = first good mark, arms when the tape moves activationPct%
 * favorable (long: up / short: down), then tracks the peak and
 * market-closes when price bounces bouncebackPct% off the peak.
 *
 * Transport is public KuCoin futures data only (no auth reads): default
 * one REST ticker GET per poll (fixed 3s cadence, bounded poll budget —
 * ~20 req/min); `--live` opens one tickerV2 WS push for sub-second marks
 * (intra-poll stop trips, REST fallback when the feed goes stale).
 * Dry-run default: without --yes a trigger logs WOULD-CLOSE
 * and never calls close_position. With --yes the trigger fires a
 * real market close (PAT with trade:execute, server re-checks gates).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { callTool } from "../mcp.js";
import { futuresCenter } from "../kucoin.js";
import {
  FUTURES_TICK_STALE_MS,
  TRAIL_LIVE_GAP_MS,
  futuresContract,
  openLiveMarkFeed,
  type LiveMarkFeed,
} from "../kucoin-ws.js";
import { needPat } from "./market.js";
import { startupGate } from "../reconcile.js";

export type TrailSide = "long" | "short";

/** Fixed poll cadence (ms) — the spec's 3s mark poll. */
export const TRAIL_INTERVAL_MS = 3000;
/** Default poll budget: 600 × 3s = 30 min on the tape. */
export const TRAIL_DEFAULT_POLLS = 600;
/** Hard poll ceiling: 3600 × 3s = 3h — the loop always terminates. */
export const TRAIL_MAX_POLLS = 3600;

export type TrailArgs = {
  exchange: string;
  pair: string;
  side: TrailSide;
  /** Close size in base/contract units (passed as `size` to close_position). */
  size: number;
  /** Favorable move vs entry that arms the trailing stop (percent). */
  activationPct: number;
  /** Adverse bounce off the peak that triggers the close (percent). */
  bouncebackPct: number;
  /** Bounded poll budget (1..3600). */
  polls: number;
  /**
   * Sub-second WS marks: open one tickerV2 push and evaluate every touch
   * against the stop (REST stays the per-poll fallback when the feed is
   * stale). Default false — plain 3s REST polls.
   */
  live?: boolean;
};

/** On-disk state — written at entry, updated on arm/ratchet/trigger. */
export type TrailState = {
  kind: "trail";
  exchange: string;
  pair: string;
  base: string;
  side: TrailSide;
  size: number;
  activationPct: number;
  bouncebackPct: number;
  /** Reference price: first good mark of the run. */
  entry: number;
  /** Best favorable price seen (long: max / short: min). */
  peak: number;
  armed: boolean;
  /** Current ratcheted stop (present once armed). */
  stop: number | null;
  pollsDone: number;
  maxPolls: number;
  mode: "dry" | "live";
  triggered: boolean;
  closed: boolean;
  closePrice: number | null;
  createdAt: string;
  updatedAt: string;
};

/** State file path (scalp/grid convention: tmpdir, per-base file). */
export function trailStatePath(base: string, dir?: string): string {
  return join(dir ?? tmpdir(), `trail_${base.toLowerCase()}.json`);
}

/** Pure validation for trail args. Null = usable. */
export function validateTrailArgs(a: TrailArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (!a.pair || !a.pair.includes("/")) return "pair required (e.g. SOL/USDT)";
  if (a.side !== "long" && a.side !== "short") return "side must be long|short";
  if (!(a.size > 0) || !Number.isFinite(a.size)) return "size must be > 0 (LOT to close)";
  if (!(a.activationPct > 0) || !Number.isFinite(a.activationPct) || a.activationPct > 10) {
    return "activation-pct must be 0 < pct <= 10";
  }
  if (!(a.bouncebackPct > 0) || !Number.isFinite(a.bouncebackPct) || a.bouncebackPct > 10) {
    return "bounceback-pct must be 0 < pct <= 10";
  }
  if (!Number.isInteger(a.polls) || a.polls < 1 || a.polls > TRAIL_MAX_POLLS) {
    return `--polls must be an integer 1..${TRAIL_MAX_POLLS}`;
  }
  return null;
}

/**
 * Pure: favorable excursion vs entry in percent.
 * Long: (price - entry) / entry. Short: mirrored.
 * NaN when either leg is unusable — callers treat it as no-update.
 */
export function favorablePct(entry: number, price: number, side: TrailSide): number {
  if (!(entry > 0) || !(price > 0)) return NaN;
  return side === "long" ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
}

/** Pure: ratchet the peak favorably (long: max / short: min). */
export function ratchetPeak(prevPeak: number, price: number, side: TrailSide): number {
  if (!(price > 0)) return prevPeak;
  if (!(prevPeak > 0)) return price;
  return side === "long" ? Math.max(prevPeak, price) : Math.min(prevPeak, price);
}

/** Pure: close-stop for a peak (long: below / short: above). */
export function stopForPeak(peak: number, bouncebackPct: number, side: TrailSide): number {
  return side === "long" ? peak * (1 - bouncebackPct / 100) : peak * (1 + bouncebackPct / 100);
}

/** Pure: adverse drawdown off the peak in percent (NaN when unusable). */
export function drawdownPct(peak: number, price: number, side: TrailSide): number {
  if (!(peak > 0) || !(price > 0)) return NaN;
  return side === "long" ? ((peak - price) / peak) * 100 : ((price - peak) / peak) * 100;
}

export type TrailTick = {
  favPct: number;
  peak: number;
  armed: boolean;
  stop: number | null;
  drawdownPct: number;
  close: boolean;
};

/**
 * Pure single-tick transition: ratchet the peak, arm on activation,
 * trigger the close on bounceback off the peak. Unarmed ticks never
 * close, no matter how far the tape falls.
 */
export function trailTick(
  entry: number,
  prevPeak: number,
  prevArmed: boolean,
  price: number,
  side: TrailSide,
  activationPct: number,
  bouncebackPct: number,
): TrailTick {
  const favPct = favorablePct(entry, price, side);
  const peak = ratchetPeak(prevPeak, price, side);
  const armed = prevArmed || (Number.isFinite(favPct) && favPct >= activationPct);
  const stop = armed ? stopForPeak(peak, bouncebackPct, side) : null;
  const dd = drawdownPct(peak, price, side);
  const close = armed && Number.isFinite(dd) && (dd as number) >= bouncebackPct;
  return { favPct, peak, armed, stop, drawdownPct: dd, close };
}

/** Read + parse a trail state file. Throws with a human message. */
export function readTrailState(path: string): TrailState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no trail state at ${path} — nothing running (start one with \`trail --yes\`)`);
  }
  let st: unknown;
  try {
    st = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`trail state at ${path} is not valid JSON — refusing to act on it`);
  }
  const s = st as Partial<TrailState>;
  if (
    s?.kind !== "trail" ||
    !s.base ||
    !s.pair ||
    (s.side !== "long" && s.side !== "short") ||
    !(Number(s.entry) > 0)
  ) {
    throw new Error(`trail state at ${path} is malformed — refusing to act on it`);
  }
  return s as TrailState;
}

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

export type TrailDeps = {
  markFn?: (base: string) => Promise<number>;
  sleepMs?: (ms: number) => Promise<void>;
  closeFn?: (args: Record<string, unknown>) => Promise<unknown>;
  stateDir?: string;
  /**
   * Live-feed opener for `--live` (default: the real tickerV2 push).
   * Tests inject a fake that replays scripted touches with no network.
   */
  openLiveFeed?: (contract: string) => Promise<LiveMarkFeed>;
};

/**
 * `jw3 trail` — bounded 3s mark poll, arm on activationPct% favorable,
 * ratchet the close-stop off the peak, market-close on bouncebackPct%
 * adverse. Dry-run default (no --yes: WOULD-CLOSE, nothing sent).
 */
export async function cmdTrail(
  a: TrailArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
  deps?: TrailDeps,
): Promise<void> {
  const err = validateTrailArgs(a);
  if (err) {
    console.error(`Bad ticket: ${err}`);
    process.exitCode = 2;
    return;
  }
  const base = (a.pair.split("/")[0] ?? "").toUpperCase();
  if (!base) {
    console.error("Usage: jw3 trail --pair SOL/USDT --side long|short --size LOT [--activation-pct 0.25] [--bounceback-pct 0.08] [--polls 600] [--yes]");
    process.exitCode = 2;
    return;
  }
  if (opts.yes) {
    const pat = needPat(opts.pat);
    if (!pat) return;
  }
  // No-strays gate: a fresh unfinished trail state may have a live
  // supervisor behind it (concurrent trails double-close). Closed/stale
  // states are superseded with a notice.
  const gate0 = startupGate("trail", base, deps?.stateDir);
  if (!gate0.ok) {
    console.error(gate0.reason);
    process.exitCode = 1;
    return;
  }
  if (gate0.notice) {
    if (opts.json) console.log(JSON.stringify({ event: "supersede", notice: gate0.notice }));
    else console.log(gate0.notice);
  }
  const markFn = deps?.markFn ?? ((b: string) => futuresCenter(b));
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const mode = opts.yes ? "live" : "dry";
  const statePath = trailStatePath(base, deps?.stateDir);
  const now = new Date().toISOString();

  if (!opts.json) {
    console.log(
      `TRAIL ${a.side.toUpperCase()} ${a.pair} ×${a.size} on ${a.exchange} — arm +${a.activationPct}% → close ${a.bouncebackPct}% off peak (${a.polls} polls × 3s, ${mode}${a.live ? ", live WS" : ""})`,
    );
  } else {
    console.log(
      JSON.stringify({
        event: "start", pair: a.pair, exchange: a.exchange, side: a.side, size: a.size,
        activationPct: a.activationPct, bouncebackPct: a.bouncebackPct,
        polls: a.polls, intervalSec: 3, mode, live: Boolean(a.live),
      }),
    );
  }

  let entry = 0;
  let peak = 0;
  let armed = false;
  let stop: number | null = null;
  let pollsDone = 0;
  const createdAt = now;

  const persist = (triggered: boolean, closed: boolean, closePrice: number | null): void => {
    const st: TrailState = {
      kind: "trail", exchange: a.exchange, pair: a.pair, base, side: a.side, size: a.size,
      activationPct: a.activationPct, bouncebackPct: a.bouncebackPct,
      entry, peak, armed, stop, pollsDone, maxPolls: a.polls, mode,
      triggered, closed, closePrice, createdAt, updatedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(statePath, JSON.stringify(st, null, 2));
    } catch {
      // State is a convenience trail — a failed write never stops the loop.
    }
  };

  // ── Live WS marks (`--live`): one tickerV2 push, REST fallback ──
  const contract = futuresContract(a.pair) ?? `${base}USDTM`;
  let feed: LiveMarkFeed | null = null;
  let lastSrc: "ws" | "rest" = "rest";
  let restFallbacks = 0;
  if (a.live) {
    try {
      feed = await (deps?.openLiveFeed ?? openLiveMarkFeed)(contract);
      if (!opts.json) {
        console.log(
          `LIVE FEED ${contract} — sub-second tickerV2 marks (REST fallback when stale >${FUTURES_TICK_STALE_MS}ms)`,
        );
      } else {
        console.log(JSON.stringify({ event: "live-feed", contract, staleMs: FUTURES_TICK_STALE_MS }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) console.log(JSON.stringify({ event: "live-feed-unavailable", error: msg, fallback: "rest" }));
      else console.log(`LIVE FEED UNAVAILABLE (${msg}) — REST fallback, nothing lost`);
      feed = null;
    }
  }
  const closeFeed = (): void => {
    try {
      feed?.close();
    } catch {
      // Close is best-effort; the socket is gone either way.
    }
    feed = null;
  };
  /** One poll mark: fresh WS touch first, REST when the feed is stale/absent. */
  const readMark = async (): Promise<number> => {
    if (feed) {
      const t = feed.latest();
      if (t && feed.ageMs() <= FUTURES_TICK_STALE_MS && t.mid > 0 && Number.isFinite(t.mid)) {
        lastSrc = "ws";
        return t.mid;
      }
      restFallbacks++;
    }
    lastSrc = "rest";
    return markFn(base);
  };
  /** Fire the trigger path for `price` (dry WOULD-CLOSE or real close). */
  const fireTrigger = async (price: number): Promise<void> => {
    if (!opts.yes) {
      persist(true, false, price);
      if (opts.json) {
        console.log(
          JSON.stringify({
            event: "would-close", pair: a.pair, exchange: a.exchange, side: a.side, size: a.size,
            price, peak, bouncebackPct: a.bouncebackPct, mode: "dry", statePath,
          }),
        );
      } else {
        console.log(
          `WOULD-CLOSE ${a.side.toUpperCase()} ${a.pair} ×${a.size} @ ${px(price)} (${a.bouncebackPct}% off peak ${px(peak)}) — dry run, nothing sent. Re-run with --yes to market-close (real money). State → ${statePath}`,
        );
      }
      return;
    }
    const pat = needPat(opts.pat);
    if (!pat) {
      persist(true, false, price);
      return;
    }
    const closeArgs: Record<string, unknown> = {
      exchange: a.exchange, pair: a.pair, side: a.side, size: String(a.size),
    };
    try {
      const closeFn =
        deps?.closeFn ??
        ((args: Record<string, unknown>) => callTool("close_position", args, pat, opts.url));
      const out = await closeFn(closeArgs);
      persist(true, true, price);
      try {
        unlinkSync(statePath);
      } catch {
        // State already gone — the close itself succeeded.
      }
      if (opts.json) {
        console.log(
          JSON.stringify({
            event: "closed", pair: a.pair, exchange: a.exchange, side: a.side, size: a.size,
            price, peak, order: out, stateCleared: true,
          }),
        );
      } else {
        console.log(`CLOSED ${a.side.toUpperCase()} ${a.pair} ×${a.size} @ ${px(price)}: ${JSON.stringify(out)}`);
        console.log(`Trail cleared — state removed (${statePath}).`);
      }
    } catch (e) {
      persist(true, false, price);
      console.error(`CLOSE FAILED: ${e instanceof Error ? e.message : String(e)} — state KEPT at ${statePath} so nothing is lost.`);
      process.exitCode = 1;
    }
  };
  /**
   * Wait out the 3s cadence. When armed with a live feed, every WS touch
   * ratchets the peak and the first touch past the stop returns early —
   * the stop trips intra-poll instead of at the next boundary.
   */
  const watchLiveGap = async (): Promise<number | null> => {
    if (!feed || !armed) {
      await sleep(TRAIL_INTERVAL_MS);
      return null;
    }
    const slices = Math.max(1, Math.round(TRAIL_INTERVAL_MS / TRAIL_LIVE_GAP_MS));
    for (let s = 0; s < slices; s++) {
      await sleep(TRAIL_INTERVAL_MS / slices);
      const t = feed.latest();
      if (!t || feed.ageMs() > FUTURES_TICK_STALE_MS || !(t.mid > 0) || !Number.isFinite(t.mid)) continue;
      const pv = trailTick(entry, peak, armed, t.mid, a.side, a.activationPct, a.bouncebackPct);
      if (pv.peak !== peak || pv.armed !== armed) {
        peak = pv.peak;
        armed = pv.armed;
        stop = pv.stop;
        persist(false, false, null);
      }
      if (pv.close) return t.mid;
    }
    return null;
  };
  const liveTag = (): string => (feed ? ` src=${lastSrc}` : "");

  for (let i = 1; i <= a.polls; i++) {
    let mark: number;
    try {
      mark = await readMark();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.json) console.log(JSON.stringify({ poll: i, status: "tape-error", error: msg }));
      else console.log(`EVENT poll=${i} status=tape-error error=${JSON.stringify(msg)}`);
      pollsDone = i;
      if (i < a.polls) await sleep(TRAIL_INTERVAL_MS);
      continue;
    }
    if (!(mark > 0) || !Number.isFinite(mark)) {
      if (opts.json) console.log(JSON.stringify({ poll: i, status: "tape-error", error: "bad mark" }));
      else console.log(`EVENT poll=${i} status=tape-error error="bad mark"`);
      pollsDone = i;
      if (i < a.polls) await sleep(TRAIL_INTERVAL_MS);
      continue;
    }
    if (!(entry > 0)) {
      entry = mark;
      peak = mark;
      armed = favorablePct(entry, mark, a.side) >= a.activationPct;
      stop = armed ? stopForPeak(peak, a.bouncebackPct, a.side) : null;
      pollsDone = i;
      persist(false, false, null);
      if (opts.json) {
        console.log(JSON.stringify({ poll: i, price: mark, entry, status: armed ? "armed" : "open", armed, peak, stop, src: lastSrc }));
      } else {
        console.log(`EVENT poll=${i} price=${px(mark)} entry=${px(entry)} status=${armed ? "armed" : "open"} — reference set${liveTag()}`);
      }
      if (i < a.polls) await sleep(TRAIL_INTERVAL_MS);
      continue;
    }
    const t = trailTick(entry, peak, armed, mark, a.side, a.activationPct, a.bouncebackPct);
    const prevPeak: number = peak;
    const prevArmed: boolean = armed;
    peak = t.peak;
    armed = t.armed;
    stop = t.stop;
    pollsDone = i;
    if (armed !== prevArmed || peak !== prevPeak) persist(false, false, null);
    const status = t.close ? "trigger" : armed ? "armed" : "open";
    const favS = Number.isFinite(t.favPct) ? `${t.favPct >= 0 ? "+" : ""}${t.favPct.toFixed(3)}%` : "—";
    const ddS = Number.isFinite(t.drawdownPct) ? `${t.drawdownPct.toFixed(3)}%` : "—";
    if (opts.json) {
      console.log(
        JSON.stringify({
          poll: i, price: mark, entry, favPct: t.favPct, peak,
          stop, armed, drawdownPct: t.drawdownPct, status, src: lastSrc,
        }),
      );
    } else {
      console.log(
        `EVENT poll=${i} price=${px(mark)} fav=${favS} peak=${px(peak)} stop=${stop === null ? "—" : px(stop)} dd=${ddS} status=${status}${liveTag()}`,
      );
    }
    if (t.close) {
      await fireTrigger(mark);
      closeFeed();
      return;
    }
    if (i < a.polls) {
      const early = await watchLiveGap();
      if (early !== null) {
        if (opts.json) console.log(JSON.stringify({ poll: i, price: early, status: "trigger", src: "ws-intra" }));
        else console.log(`EVENT intra-poll price=${px(early)} status=trigger (live touch past the stop)`);
        await fireTrigger(early);
        closeFeed();
        return;
      }
    }
  }
  if (!(entry > 0)) {
    console.error("No usable mark inside the poll budget — nothing armed, no state written.");
    process.exitCode = 1;
    closeFeed();
    return;
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        event: "done", pair: a.pair, exchange: a.exchange, side: a.side,
        polls: a.polls, armed, peak, stop, status: "no-trigger", statePath,
      }),
    );
  } else {
    console.log(
      `TRAIL DONE — no trigger inside ${a.polls} polls × 3s. ${armed ? `Armed, stop ${stop === null ? "—" : px(stop)}.` : "Never armed."}${a.live ? ` Live: ${feed ? feed.count() : 0} WS ticks, ${restFallbacks} REST fallbacks.` : ""} Re-run to keep trailing. State → ${statePath}`,
    );
  }
  closeFeed();
}
