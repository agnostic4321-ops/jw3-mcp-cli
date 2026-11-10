/**
 * OQ-12 pins — the exact venue calls every order-placing entry point makes
 * for a representative decision. Recorded from the pre-OQ-12 code (commit
 * "w8(L11c): OQ-12 pin venue calls") and enforced on every change after.
 * Stubbed venue client, no network, no money.
 *
 * Two views per scenario:
 *   orders — the fund-moving calls (execute_trade / set_exits /
 *            close_position / cancel_order) in order, byte-for-byte. These
 *            are what the venue sees and must never drift.
 *   all    — every call, reads included. The only allowed delta is a gate
 *            read runLive adds in front of an OPENING decision, declared
 *            per scenario in GATE_READS (owner-approved OQ-12(c): the
 *            kill switch + risk caps are checked inside runLive).
 *
 * Re-record ONLY for an intended, owner-approved change to what reaches the
 * venue: JW3_PIN_RECORD=1 rewrites order-paths.pins.json.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, ensureDir, writeJson } from "./test-fixtures.js";
import { runLive, type LiveCandidate } from "./commands/live.js";
import { SCENARIO_TABLE, defaultHarnessConfig, runScenarioRow } from "./commands/harness.js";
import { defaultFilterConfig } from "./filters.js";
import { cmdDegen } from "./commands/degen.js";
import { cmdCancel, cmdCancelAll, cmdClose, cmdExecute, cmdExits } from "./commands/trade.js";
import { cmdExecuteChase } from "./chase.js";
import { cmdBounce } from "./bounce.js";
import { cmdGrid } from "./commands/grid.js";
import { cmdScalpKill } from "./commands/scalp.js";
import { cmdTrail } from "./commands/trail.js";
import type { FadeRow } from "./kucoin.js";

export type PinCall = { name: string; args: Record<string, unknown> };
type Script = (c: PinCall, nth: number) => unknown;

const ORDER_TOOLS = new Set(["execute_trade", "set_exits", "close_position", "cancel_order"]);
const NOW = Date.UTC(2026, 10, 10, 8, 0, 0);
const PAT = "pin-pat";
const RECORD = process.env.JW3_PIN_RECORD === "1";

const here = dirname(fileURLToPath(import.meta.url));
const PIN_FILE = (() => {
  const candidates = [join(here, "order-paths.pins.json"), join(here, "..", "src", "order-paths.pins.json")];
  return candidates.find((p) => existsSync(p)) ?? (candidates[1] as string);
})();

/** A recording venue client: every call is logged, the script answers it. */
function recorder(script: Script): { calls: PinCall[]; call: (name: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown> } {
  const calls: PinCall[] = [];
  const seen = new Map<string, number>();
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    return script({ name, args }, nth);
  };
  return { calls, call };
}

/** Run a command with console + exitCode captured (and restored). */
async function quiet(fn: () => Promise<unknown>): Promise<void> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    process.exitCode = undefined;
  }
}

const norm = (calls: PinCall[]): PinCall[] => JSON.parse(JSON.stringify(calls)) as PinCall[];
export const orderCalls = (calls: PinCall[]): PinCall[] => calls.filter((c) => ORDER_TOOLS.has(c.name));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
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

/** The venue as runLive reads it: flat, funded, caps clear. */
const liveVenue = (override?: Script): Script => (c, nth) => {
  const o = override?.(c, nth);
  if (o !== undefined) return o;
  if (c.name === "read_live_datum" && c.args.kind === "balances") return { data: { accounts: { futures: [{ free: 500, total: 1000 }] } } };
  if (c.name === "read_live_datum" && c.args.kind === "positions") return { data: [] };
  if (c.name === "list_open_orders") return [];
  if (c.name === "read_risk_limits") return LIVE_RISK;
  if (c.name === "execute_trade") return { orderId: `live-${nth}` };
  if (c.name === "set_exits") return { ok: true };
  if (c.name === "reconcile_realized_pnl") return { counted: 0, lossRecordedUsd: 0, alreadyCounted: 0 };
  return {};
};

const LIVE_CANDIDATE: LiveCandidate = {
  pair: "SOL/USDT",
  side: "long",
  entryPrice: 150,
  stopPrice: 148.8,
  targetPrice: 150.6,
  atrPct: 0.8,
  score: 0,
  reason: "pin",
};

async function liveRun(script: Script, yes = true): Promise<PinCall[]> {
  const { calls, call } = recorder(script);
  await runLive(
    {
      exchange: "kucoin",
      candidate: LIVE_CANDIDATE,
      riskPctOfEquity: 3,
      venueMaxLeverage: null,
      maintenanceMarginRate: 0.005,
      makerFeePct: 0.02,
      takerFeePct: 0.06,
      session: "pin",
      turn: "t1",
      nowMs: NOW,
    },
    { yes, json: true, pat: PAT, call, contractSpec: async () => ({ multiplier: 0.1, tick: 0.01 }) },
  );
  return calls;
}

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

const degenVenue = (override?: Script): Script => (c, nth) => {
  const o = override?.(c, nth);
  if (o !== undefined) return o;
  if (c.name === "list_open_orders") return [];
  if (c.name === "execute_trade") return { orderId: `degen-${nth}` };
  return {};
};

async function degenRun(script: Script): Promise<PinCall[]> {
  const sb = makeSandbox("pin-degen-");
  try {
    const { calls, call } = recorder(script);
    await quiet(() =>
      cmdDegen(
        {
          pair: "SOL/USDT", exchange: "kucoin", sizeUsd: 15, leverage: 2, maxHeatUsd: 6, maxConcurrent: 2,
          activationPct: 0.25, bouncebackPct: 0.08, polls: 600, horizon: 12, trail: false, live: false, paper: false,
        },
        { yes: true, json: true, pat: PAT },
        {
          fade: async () => DEGEN_ROW,
          oracle: async () => ({ side: "long", score: 0.7, detail: "pin long" }),
          spec: async () => ({ multiplier: 1, tick: 0.01 }),
          call,
          heatPath: join(sb.dir, "degen-heat.json"),
          logPath: join(sb.dir, "degen-learning.jsonl"),
          runDir: join(sb.dir, "runs"),
          storePath: join(sb.dir, "vote.json"),
          now: () => NOW,
        },
      ),
    );
    return calls;
  } finally {
    sb.cleanup();
  }
}

const EXECUTE_ARGS = { exchange: "kucoin", pair: "SOL/USDT", side: "buy", amount: 0.5, price: 150, market: "futures", leverage: 5, stop: 148 };

const timeout = (): never => {
  throw new Error("timeout after 25000ms (no response)");
};

/* ------------------------------------------------------------------ */
/* scenarios — one representative decision per entry point             */
/* ------------------------------------------------------------------ */

export const SCENARIOS: Record<string, () => Promise<PinCall[]>> = {
  // ── live (runLive's own candidate path) ──
  "live:fire": () => liveRun(liveVenue()),
  "live:preview": () => liveRun(liveVenue(), false),
  "live:entry-timeout": () => liveRun(liveVenue((c) => (c.name === "execute_trade" ? timeout() : undefined))),
  "live:leverage-cap-retry": () =>
    liveRun(
      liveVenue((c, nth) => {
        if (c.name === "execute_trade" && nth === 1) throw new Error("leverage cannot exceed 5 for this position tier");
        return undefined;
      }),
    ),
  "live:exits-fail-flatten": () =>
    liveRun(liveVenue((c) => (c.name === "set_exits" ? (() => { throw new Error("rate_limited"); })() : undefined))),

  // ── harness (offline rig — its recorder IS the venue boundary) ──
  "harness:long-confluence-clean": async () => {
    const out = await runScenarioRow(SCENARIO_TABLE[0]!, defaultHarnessConfig(defaultFilterConfig()));
    return out.calls.map((c) => ({ name: c.tool, args: { ...c.args, __intentId: c.intentId } }));
  },

  // ── degen (step-1 + resting step-2 + stop/TP arm) ──
  "degen:fire": () => degenRun(degenVenue()),
  "degen:exits-fallback-tp-only": () =>
    degenRun(degenVenue((c) => (c.name === "set_exits" && c.args.slPrice !== undefined ? (() => { throw new Error("330005 margin mode"); })() : undefined))),
  "degen:step1-timeout": () => degenRun(degenVenue((c) => (c.name === "execute_trade" ? timeout() : undefined))),

  // ── trade commands ──
  "execute:fire": async () => {
    const { calls, call } = recorder(() => ({ orderId: "ex-1" }));
    await quiet(() => cmdExecute({ ...EXECUTE_ARGS }, { yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },
  "execute:timeout": async () => {
    const { calls, call } = recorder(() => timeout());
    await quiet(() => cmdExecute({ ...EXECUTE_ARGS }, { yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },
  "execute:preview": async () => {
    const { calls, call } = recorder(() => ({ orderId: "ex-1" }));
    await quiet(() => cmdExecute({ ...EXECUTE_ARGS }, { yes: false, json: true, pat: PAT }, { call }));
    return calls;
  },
  "close:fire": async () => {
    const { calls, call } = recorder(() => ({ ok: true }));
    await quiet(() => cmdClose({ exchange: "kucoin", pair: "SOL/USDT", side: "long", size: 0.5, yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },
  "exits:fire": async () => {
    const { calls, call } = recorder(() => ({ ok: true }));
    await quiet(() => cmdExits({ exchange: "kucoin", pair: "SOL/USDT", sl: 148, tp: 152, market: "futures", yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },
  "cancel:fire": async () => {
    const { calls, call } = recorder(() => ({ ok: true }));
    await quiet(() => cmdCancel({ exchange: "kucoin", orderId: "o-1", pair: "SOL/USDT", market: "futures", yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },
  "cancel-all:fire": async () => {
    const { calls, call } = recorder((c, nth) => {
      if (c.name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (c.name === "list_open_orders") return nth === 1 ? [{ orderId: "a-1", symbol: "SOL/USDT" }, { orderId: "a-2", symbol: "SOL/USDT" }] : [];
      return { ok: true };
    });
    await quiet(() => cmdCancelAll({ exchange: "kucoin", pair: "SOL/USDT", market: "futures", yes: true, json: true, pat: PAT }, { call }));
    return calls;
  },

  // ── execute --chase (cancel-replace loop) ──
  "chase:replace-then-fill": async () => {
    let clock = NOW;
    const touches = [
      { bestBid: 150, bestAsk: 150.1 },
      { bestBid: 150.2, bestAsk: 150.3 },
    ];
    let t = 0;
    const { calls, call } = recorder((c, nth) => {
      if (c.name === "execute_trade") return { orderId: `c-${nth}` };
      if (c.name === "list_open_orders") return nth <= 2 ? [{ orderId: "c-1", symbol: "SOLUSDTM" }] : [];
      return { ok: true };
    });
    await quiet(() =>
      cmdExecuteChase(
        { exchange: "kucoin", pair: "SOL/USDT", side: "buy", amount: 0.5, market: "futures", leverage: 5 },
        { enabled: true, secs: 10, pollSecs: 2, maxChases: 1, take: false },
        { yes: true, json: true, pat: PAT },
        {
          call,
          touchFn: async () => touches[Math.min(t++, touches.length - 1)]!,
          sleepMs: async (ms: number) => {
            clock += ms;
          },
          nowMs: () => clock,
        },
      ),
    );
    return calls;
  },

  // ── bounce (fires once on the +0.4% bounce) ──
  "bounce:fire": async () => {
    const marks = [100, 99.5, 99.9];
    let i = 0;
    const { calls, call } = recorder(() => ({ orderId: "b-1" }));
    await quiet(() =>
      cmdBounce(
        { exchange: "kucoin", pair: "SOL/USDT", side: "short", bouncePct: 0.4, lookbackMin: 1, size: 0.5 },
        { yes: true, json: true, pat: PAT },
        { markFn: async () => marks[Math.min(i++, marks.length - 1)]!, sleepMs: async () => {}, call },
      ),
    );
    return calls;
  },

  // ── grid start (seed + every level) ──
  "grid:start-long": async () => {
    const sb = makeSandbox("pin-grid-");
    try {
      const { calls, call } = recorder((c, nth) => (c.name === "execute_trade" ? { orderId: `g-${nth}` } : {}));
      await quiet(() =>
        cmdGrid(
          "start",
          { exchange: "kucoin", pair: "SEI/USDT", stepPct: 0.5, levelsPerSide: 2, stepUsd: 15, leverage: 2, bias: "long" },
          { yes: true, json: true, pat: PAT },
          {
            center: async () => 0.5,
            spec: async () => ({ multiplier: 1, tick: 0.0001 }),
            freeUsd: async () => 1000,
            call,
            startupGate: () => ({ ok: true }),
            statePath: join(sb.dir, "grid_sei.json"),
          },
        ),
      );
      return calls;
    } finally {
      sb.cleanup();
    }
  },

  // ── scalp kill (cancel every working step, close the position) ──
  "scalp-kill:fire": async () => {
    const sb = makeSandbox("pin-scalp-");
    try {
      const statePath = writeJson(sb.dir, "scalp_sol.json", {
        kind: "scalp", exchange: "kucoin", pair: "SOL/USDT", base: "SOL", direction: "long", leverage: 2,
        last: 150, avgEntry: 149.25, tpPrice: 150.6, tpProfitUsd: 0.1, killPrice: 147, killLossUsd: 0.5, maxCapitalUsd: 30,
        placed: [
          { step: 1, side: "buy", price: 150, contracts: 1, sizeUsd: 15, orderId: "sk-1" },
          { step: 2, side: "buy", price: 148.5, contracts: 1, sizeUsd: 15, orderId: "sk-2" },
        ],
        failed: 0, tpArmed: true, createdAt: "2026-11-10T00:00:00.000Z",
      });
      const { calls, call } = recorder(() => ({ ok: true }));
      await quiet(() => cmdScalpKill({ pair: "SOL/USDT", yes: true, json: true, pat: PAT }, { call, statePath }));
      return calls;
    } finally {
      sb.cleanup();
    }
  },

  // ── trail (ratcheting close-stop fires one reduce-only close) ──
  "trail:close": async () => {
    const sb = makeSandbox("pin-trail-");
    try {
      ensureDir(sb.dir);
      const marks = [100, 100.5, 100.3];
      let i = 0;
      const { calls, call } = recorder(() => ({ ok: true }));
      await quiet(() =>
        cmdTrail(
          { exchange: "kucoin", pair: "SOL/USDT", side: "long", size: 0.5, activationPct: 0.25, bouncebackPct: 0.08, polls: 10, live: false },
          { yes: true, json: true, pat: PAT },
          { markFn: async () => marks[Math.min(i++, marks.length - 1)]!, sleepMs: async () => {}, call, stateDir: sb.dir },
        ),
      );
      return calls;
    } finally {
      sb.cleanup();
    }
  },
};

/**
 * Reads runLive adds in front of an OPENING decision (owner-approved
 * OQ-12(c)). Each entry inserts one call at `at` into the recorded `all`
 * sequence. Empty in the pin commit: the pins are today's behavior.
 */
export const GATE_READS: Record<string, { at: number; call: PinCall }[]> = {};

function withGateReads(pinned: PinCall[], inserts: { at: number; call: PinCall }[] | undefined): PinCall[] {
  const out = [...pinned];
  for (const ins of [...(inserts ?? [])].sort((a, b) => a.at - b.at)) out.splice(ins.at, 0, ins.call);
  return out;
}

const pins: Record<string, PinCall[]> = RECORD ? {} : (JSON.parse(readFileSync(PIN_FILE, "utf8")) as Record<string, PinCall[]>);

describe("OQ-12 pins: exact venue calls per entry point", () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const got = norm(await run());
      if (RECORD) {
        pins[name] = got;
        return;
      }
      const pinned = pins[name];
      assert.ok(pinned, `no pin recorded for ${name}`);
      // What the venue sees: byte-identical, in order.
      assert.deepEqual(orderCalls(got), orderCalls(pinned), `${name}: the fund-moving calls drifted`);
      // Everything else: identical except the declared gate reads.
      assert.deepEqual(got, withGateReads(pinned, GATE_READS[name]), `${name}: the call sequence drifted`);
    });
  }
  after(() => {
    if (RECORD) writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  });
});
