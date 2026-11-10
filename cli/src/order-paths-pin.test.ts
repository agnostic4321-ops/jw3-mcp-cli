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
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, ensureDir, writeJson } from "./test-fixtures.js";
import { LiveRefusal, runLive, tapLiveDecisions, type DecisionRecord, type LiveCandidate } from "./commands/live.js";
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

/**
 * The server's `read_risk_limits` answer for the gate tests (null = each
 * scenario's own script answers). A function is called (e.g. to throw).
 */
let riskOverride: unknown = null;

/** A recording venue client: every call is logged, the script answers it. */
function recorder(script: Script): { calls: PinCall[]; call: (name: string, args: Record<string, unknown>, pat: string, url?: string) => Promise<unknown> } {
  const calls: PinCall[] = [];
  const seen = new Map<string, number>();
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
    const nth = (seen.get(name) ?? 0) + 1;
    seen.set(name, nth);
    if (name === "read_risk_limits" && riskOverride !== null) {
      return typeof riskOverride === "function" ? (riskOverride as () => unknown)() : riskOverride;
    }
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
    // Only the ORDER times out (the pre-OQ-12 code made no other call, so
    // the pin is unchanged; the gate's risk read must answer).
    const { calls, call } = recorder((c) => (c.name === "execute_trade" ? timeout() : {}));
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
 * The ONE read OQ-12 adds (owner-approved OQ-12(c): the kill switch + caps
 * are checked inside runLive for every producer): for these producers,
 * runLive reads the server's risk limits once per run, immediately before
 * the run's first OPENING order. The live candidate (its preflight already
 * read them) and the harness (its simulated account is the snapshot) add
 * nothing; risk-reducing producers are never gated, so they add nothing.
 */
export const GATE_READ_SCENARIOS = new Set([
  "degen:fire",
  "degen:exits-fallback-tp-only",
  "degen:step1-timeout",
  "execute:fire",
  "execute:timeout",
  "chase:replace-then-fill",
  "bounce:fire",
  "grid:start-long",
]);

const isOpeningCall = (c: PinCall): boolean => c.name === "execute_trade" && c.args.reduceOnly !== true && c.args.reduce_only !== true;

function withGateReads(name: string, pinned: PinCall[]): PinCall[] {
  if (!GATE_READ_SCENARIOS.has(name)) return pinned;
  const i = pinned.findIndex(isOpeningCall);
  if (i < 0) return pinned;
  return [...pinned.slice(0, i), { name: "read_risk_limits", args: {} }, ...pinned.slice(i)];
}

/** Run one scenario with the decision tap installed. */
async function tapped(run: () => Promise<PinCall[]>): Promise<{ calls: PinCall[]; decisions: DecisionRecord[] }> {
  const decisions: DecisionRecord[] = [];
  tapLiveDecisions((d) => decisions.push(d));
  try {
    return { calls: norm(await run()), decisions };
  } finally {
    tapLiveDecisions(null);
  }
}

/* Every test in this file reads the watchdog breaker from a sandboxed config home. */
const ENV_HOME = process.env.JW3_CONFIG_HOME;
let home = "";
before(() => {
  home = mkdtempSync(join(tmpdir(), "jw3-oq12-home-"));
  process.env.JW3_CONFIG_HOME = home;
});
after(() => {
  if (ENV_HOME === undefined) delete process.env.JW3_CONFIG_HOME;
  else process.env.JW3_CONFIG_HOME = ENV_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** Write (or clear, with null) the watchdog's breaker file in the sandboxed config home. */
function setBreaker(doc: Record<string, unknown> | string | null): void {
  const p = join(home, "watchdog-state.json");
  if (doc === null) rmSync(p, { force: true });
  else writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
}
const TRIPPED = { version: 1, breaker: { tripped: true, trippedAt: "2026-11-10T07:59:00.000Z", reasons: ["pin: executor heartbeat stale"] }, entriesBlocked: true, blockReason: "pin" };

const pins: Record<string, PinCall[]> = RECORD ? {} : (JSON.parse(readFileSync(PIN_FILE, "utf8")) as Record<string, PinCall[]>);

describe("OQ-12 pins: exact venue calls per entry point", () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const { calls: got, decisions } = await tapped(run);
      if (RECORD) {
        pins[name] = got;
        return;
      }
      const pinned = pins[name];
      assert.ok(pinned, `no pin recorded for ${name}`);
      // What the venue sees: byte-identical, in order.
      assert.deepEqual(orderCalls(got), orderCalls(pinned), `${name}: the fund-moving calls drifted`);
      // Everything else: identical except the declared gate read.
      assert.deepEqual(got, withGateReads(name, pinned), `${name}: the call sequence drifted`);
      // OQ-12(b): every venue order call is exactly one runLive decision —
      // timeouts and retries included (a retry is a NEW decision).
      assert.equal(decisions.filter((d) => d.status === "sent").length, orderCalls(got).length, `${name}: decisions != venue order calls`);
      assert.equal(decisions.filter((d) => d.status !== "sent").length, 0, `${name}: a decision was refused`);
    });
  }
  after(() => {
    if (RECORD) writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  });
});

/* ------------------------------------------------------------------ */
/* OQ-12(c)(d): one gate, inside runLive, for every producer            */
/* ------------------------------------------------------------------ */

/** Producers that OPEN exposure, one representative fire each. */
const OPENING = ["live:fire", "harness:long-confluence-clean", "degen:fire", "execute:fire", "chase:replace-then-fill", "bounce:fire", "grid:start-long"];
/** Producers that only REDUCE exposure. */
const REDUCING = ["close:fire", "exits:fire", "cancel:fire", "cancel-all:fire", "scalp-kill:fire", "trail:close"];

describe("OQ-12(c): a tripped watchdog kill switch blocks EVERY opening producer — inside runLive", () => {
  after(() => setBreaker(null));
  for (const name of OPENING) {
    it(`${name}: tripped breaker → zero opening venue calls`, async () => {
      setBreaker(TRIPPED);
      const { calls, decisions } = await tapped(SCENARIOS[name]!);
      assert.deepEqual(calls.filter(isOpeningCall), [], `${name} reached the venue with the kill switch tripped`);
      assert.ok(decisions.some((d) => d.status === "blocked" && /kill switch is TRIPPED/.test(d.reason ?? "")), `${name}: no blocked decision recorded`);
      assert.equal(decisions.filter((d) => d.status === "sent" && d.tool === "execute_trade").length, 0);
    });
    it(`${name}: entries-blocked (breaker not tripped) → zero opening venue calls`, async () => {
      setBreaker({ version: 1, breaker: { tripped: false, reasons: [] }, entriesBlocked: true, blockReason: "pin: unprotected position" });
      const { calls } = await tapped(SCENARIOS[name]!);
      assert.deepEqual(calls.filter(isOpeningCall), []);
    });
    it(`${name}: an unreadable breaker file fails CLOSED`, async () => {
      setBreaker("{not json");
      const { calls } = await tapped(SCENARIOS[name]!);
      assert.deepEqual(calls.filter(isOpeningCall), []);
    });
  }
  for (const name of REDUCING) {
    it(`${name}: risk-REDUCING orders still reach the venue with the breaker tripped (byte-identical)`, async () => {
      setBreaker(TRIPPED);
      const { calls } = await tapped(SCENARIOS[name]!);
      assert.deepEqual(orderCalls(calls), orderCalls(pins[name] ?? []));
      assert.ok(orderCalls(calls).length > 0);
    });
  }
});

describe("OQ-12(c): the server kill switch + daily caps block every opening producer — inside runLive", () => {
  after(() => {
    riskOverride = null;
  });
  const cases: [string, unknown][] = [
    ["server kill switch on", { risk_limits: { kill_switch_enabled: true } }],
    ["daily loss cap reached", { risk_limits: { kill_switch_enabled: false, daily_realized_loss_usd: 50, max_daily_loss_usd: 50 } }],
    ["daily trade cap reached", { risk_limits: { kill_switch_enabled: false, daily_trade_count: 10, max_trades_per_day: 10 } }],
    ["daily notional budget spent", { risk_limits: { kill_switch_enabled: false, daily_notional_usd: 501, max_daily_notional_usd: 500 } }],
    ["risk limits unreadable", () => { throw new Error("rate_limited"); }],
  ];
  // The harness reads no server (its simulated account is the snapshot);
  // live:fire's own preflight reads the same limits first.
  for (const name of OPENING.filter((n) => n !== "harness:long-confluence-clean")) {
    for (const [label, risk] of cases) {
      if (name === "live:fire" && label === "risk limits unreadable") continue; // the candidate's preflight read throws before any decision (unchanged)
      it(`${name}: ${label} → zero opening venue calls`, async () => {
        riskOverride = risk;
        try {
          const { calls } = await tapped(SCENARIOS[name]!);
          assert.deepEqual(calls.filter(isOpeningCall), [], `${name} fired with ${label}`);
        } finally {
          riskOverride = null;
        }
      });
    }
  }
});

describe("OQ-12(c): --yes is checked inside runLive for every decision", () => {
  const tools = ["execute_trade", "set_exits", "close_position", "cancel_order"] as const;
  for (const tool of tools) {
    it(`${tool} without --yes: a preview, zero venue calls (not even the gate read)`, async () => {
      const { calls, call } = recorder(() => ({ orderId: "x" }));
      await assert.rejects(
        runLive({ kind: "order", producer: "execute", tool, args: { exchange: "kucoin", pair: "SOL/USDT" }, yes: false }, { pat: PAT, call }),
        (e: unknown) => e instanceof LiveRefusal && e.status === "preview",
      );
      assert.deepEqual(calls, []);
    });
  }
  it("degen without --yes previews: zero order calls", async () => {
    const sb = makeSandbox("pin-degen-preview-");
    try {
      const { calls, call } = recorder(degenVenue());
      await quiet(() =>
        cmdDegen(
          { pair: "SOL/USDT", exchange: "kucoin", sizeUsd: 15, leverage: 2, maxHeatUsd: 6, maxConcurrent: 2, activationPct: 0.25, bouncebackPct: 0.08, polls: 600, horizon: 12, trail: false, live: false, paper: false },
          { yes: false, json: true, pat: PAT },
          { fade: async () => DEGEN_ROW, oracle: async () => ({ side: "long", score: 0.7, detail: "pin" }), spec: async () => ({ multiplier: 1, tick: 0.01 }), call, heatPath: join(sb.dir, "h.json"), logPath: join(sb.dir, "l.jsonl"), runDir: join(sb.dir, "runs"), storePath: join(sb.dir, "v.json"), now: () => NOW },
        ),
      );
      assert.deepEqual(orderCalls(calls), []);
    } finally {
      sb.cleanup();
    }
  });
});

describe("OQ-12(d): paper never reaches the live venue client", () => {
  it("a paper decision is refused before ANY venue contact", async () => {
    const { calls, call } = recorder(() => ({ orderId: "x" }));
    await assert.rejects(
      runLive({ kind: "order", producer: "degen", tool: "execute_trade", args: { pair: "SOL/USDT" }, yes: true, paper: true }, { pat: PAT, call }),
      (e: unknown) => e instanceof LiveRefusal && e.status === "paper",
    );
    assert.deepEqual(calls, []);
  });
  it("degen --paper: zero venue order calls — the only call is its [PAPER] Diary card", async () => {
    const sb = makeSandbox("pin-degen-paper-");
    try {
      const { calls, call } = recorder(degenVenue());
      await quiet(() =>
        cmdDegen(
          { pair: "SOL/USDT", exchange: "kucoin", sizeUsd: 15, leverage: 2, maxHeatUsd: 6, maxConcurrent: 2, activationPct: 0.25, bouncebackPct: 0.08, polls: 600, horizon: 12, trail: false, live: false, paper: true },
          { yes: false, json: true, pat: PAT },
          { fade: async () => DEGEN_ROW, oracle: async () => ({ side: "long", score: 0.7, detail: "pin" }), spec: async () => ({ multiplier: 1, tick: 0.01 }), call, heatPath: join(sb.dir, "h.json"), logPath: join(sb.dir, "l.jsonl"), runDir: join(sb.dir, "runs"), storePath: join(sb.dir, "v.json"), paperPath: join(sb.dir, "paper-accounts.json"), now: () => NOW },
        ),
      );
      assert.deepEqual(orderCalls(calls), [], "degen --paper sent a venue order");
      // Today's paper design (PAPER_MODE.md): one JW3 Diary card, never an
      // exchange order and never through runLive.
      assert.deepEqual(calls.map((c) => c.name), ["propose_trade"]);
      assert.equal(calls[0]?.args.timeframe, "paper");
    } finally {
      sb.cleanup();
    }
  });
});

describe("OQ-12(b): one venue call per decision — never retried inside runLive", () => {
  it("a timed-out order is sent ONCE and the ambiguity surfaces to the producer", async () => {
    const { calls, call } = recorder((c) => (c.name === "execute_trade" ? timeout() : {}));
    await assert.rejects(
      runLive({ kind: "order", producer: "execute", tool: "execute_trade", args: { pair: "SOL/USDT", side: "buy", amount: 1 }, yes: true }, { pat: PAT, call }),
      /timeout/,
    );
    assert.equal(calls.filter((c) => c.name === "execute_trade").length, 1);
  });
  it("a rejected cancel is sent ONCE", async () => {
    const { calls, call } = recorder(() => { throw new Error("order not found"); });
    await assert.rejects(
      runLive({ kind: "order", producer: "cancel", tool: "cancel_order", args: { orderId: "o-1" }, yes: true }, { pat: PAT, call }),
      /order not found/,
    );
    assert.equal(calls.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* OQ-12(a): the source guard — runLive's chain is the only order path  */
/* ------------------------------------------------------------------ */

function srcRoot(): string {
  for (const d of [join(here, "..", "src"), here]) if (existsSync(join(d, "commands", "live.ts"))) return d;
  throw new Error("order-path guard: cannot locate cli/src");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("OQ-12(a): no module other than runLive's chain sends a venue order", () => {
  const root = srcRoot();
  const files = sourceFiles(root).map((p) => ({ rel: p.slice(root.length + 1), src: readFileSync(p, "utf8") }));
  // An order-tool NAME as the first argument of any call — except
  // `decide(...)`, live.ts/degen.ts's OrderDecision constructor.
  const ORDER_LITERAL_CALL = /(?<!\bdecide)\(\s*["'](execute_trade|set_exits|close_position|cancel_order)["']/;

  it("finds the source tree", () => {
    assert.ok(files.length > 50, `only ${files.length} source files found under ${root}`);
  });
  it("no source file passes an order tool NAME straight to a call — anywhere (live.ts included)", () => {
    const hits = files.filter((f) => ORDER_LITERAL_CALL.test(f.src)).map((f) => f.rel);
    assert.deepEqual(hits, [], `direct order-tool calls outside runLive: ${hits.join(", ")}`);
  });
  it("the order transport (callOrderTool) is imported by commands/live.ts ONLY", () => {
    const users = files.filter((f) => f.rel !== "mcp.ts" && /\bcallOrderTool\b/.test(f.src)).map((f) => f.rel);
    assert.deepEqual(users, ["commands/live.ts"]);
  });
  it("nothing but mcp.ts speaks tools/call (no side door to the transport)", () => {
    const users = files.filter((f) => f.rel !== "mcp.ts" && /["']tools\/call["']/.test(f.src)).map((f) => f.rel);
    assert.deepEqual(users, []);
  });
  it("the generic transport REFUSES every order tool at runtime (nothing is sent)", async () => {
    const { callTool } = await import("./mcp.js");
    for (const tool of ["execute_trade", "set_exits", "close_position", "cancel_order"]) {
      await assert.rejects(callTool(tool, {}, "pat-never-used", "http://127.0.0.1:9/never"), /only runLive/);
    }
  });
  it("sendOrder makes exactly one venue call and has no loop or retry", () => {
    const live = files.find((f) => f.rel === "commands/live.ts")!.src;
    const start = live.indexOf("async function sendOrder(");
    assert.ok(start > 0, "sendOrder not found");
    const body = live.slice(start, live.indexOf("\n}\n", start));
    assert.equal((body.match(/\bsend\(/g) ?? []).length, 1, "sendOrder must call the venue exactly once");
    assert.equal(/\bfor\s*\(|\bwhile\s*\(|retry/i.test(body), false, "sendOrder must not loop or retry");
  });
  it("every order-placing module hands its orders to runLive", () => {
    const producers = ["commands/degen.ts", "commands/harness.ts", "commands/trade.ts", "chase.ts", "bounce.ts", "commands/grid.ts", "commands/scalp.ts", "commands/trail.ts", "commands/daemon.ts", "commands/watchdog.ts"];
    for (const rel of producers) {
      const f = files.find((x) => x.rel === rel);
      assert.ok(f, `${rel} missing`);
      assert.ok(/\brunLive\(/.test(f.src) && /kind: "order"/.test(f.src), `${rel} does not hand decisions to runLive`);
    }
  });
});
