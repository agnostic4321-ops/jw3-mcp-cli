/**
 * The live execution path's safety invariants.
 *
 * These are the properties that must hold BEFORE any real order leaves:
 * a rejected candidate never becomes a ticket, a fired order carries the
 * right unit, and every gate can say no. A fake exchange records what
 * WOULD have been sent so no test can touch the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTicket,
  foldPreflight,
  makeClientOid,
  makeIdempotencyKey,
  preflightGates,
  readLiveAccountState,
  runLive,
  type LiveAccountState,
  type LiveCandidate,
} from "./live.js";
import { sizeTrade, type SizingProposal } from "./sizing.js";
import type { TradeCall } from "./trade.js";

type Call = { name: string; args: Record<string, unknown> };

/**
 * A FIXED contract spec. The live path must never touch the network in a
 * test — a live fetch makes the suite flaky, and a flaky test on a
 * fund-moving path is a test nobody trusts.
 * SOL's real facts: multiplier 0.1, tick 0.001.
 */
const FAKE_SPEC = async (): Promise<{ multiplier: number; tick: number }> => ({
  multiplier: 0.1,
  tick: 0.001,
});
const isFundMoving = (c: Call): boolean =>
  c.name === "execute_trade" || c.name === "close_position" || c.name === "set_exits" || c.name === "cancel_order";

/** A fake exchange: records every call, never touches the network. */
function fakeExchange(over: Partial<LiveAccountState> = {}): { calls: Call[]; call: TradeCall } {
  const calls: Call[] = [];
  const state: LiveAccountState = {
    freeMarginUsd: 57.46,
    equityUsd: 57.46,
    hasOpenPosition: false,
    openOrderCount: 0,
    killSwitchEnabled: false,
    dailyLossUsd: 0,
    maxDailyLossUsd: 12,
    dailyTradeCount: 0,
    maxTradesPerDay: 120,
    // The day's notional budget: the counter and the cap the server
    // enforces, which the client could not see until now.
    dailyNotionalUsd: 0,
    maxDailyNotionalUsd: 500,
    maxPositionUsd: 60,
    ...over,
  };
  const call = (async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "read_live_datum") {
      const kind = String(args.kind ?? "");
      if (kind === "balances") {
        return { data: { accounts: { futures: [{ free: state.freeMarginUsd, total: state.equityUsd }] } } };
      }
      if (kind === "positions") {
        return { data: state.hasOpenPosition ? [{ symbol: "SOLUSDTM" }] : [] };
      }
      return { data: [] };
    }
    if (name === "list_open_orders") {
      return state.openOrderCount > 0 ? [{ orderId: "stale-1", symbol: "SOLUSDTM" }] : [];
    }
    if (name === "read_risk_limits") {
      return {
        risk_limits: {
          kill_switch_enabled: state.killSwitchEnabled,
          daily_realized_loss_usd: state.dailyLossUsd,
          max_daily_loss_usd: state.maxDailyLossUsd,
          daily_trade_count: state.dailyTradeCount,
          max_trades_per_day: state.maxTradesPerDay,
          max_position_usd: state.maxPositionUsd,
        },
      };
    }
    if (name === "execute_trade") return { orderId: "oid-1" };
    return {};
  }) as TradeCall;
  return { calls, call };
}

const candidate = (over: Partial<LiveCandidate> = {}): LiveCandidate => ({
  pair: "SOL/USDT",
  side: "long",
  entryPrice: 100,
  stopPrice: 99,
  targetPrice: 101,
  atrPct: 1.0,
  score: 0.6,
  reason: "test",
  ...over,
});

const liveArgs = (over: Partial<Parameters<typeof runLive>[0]> = {}) => ({
  exchange: "kucoin",
  candidate: candidate(),
  riskPctOfEquity: 3,
  venueMaxLeverage: 50,
  maintenanceMarginRate: 0.005,
  session: "test-session",
  turn: "t1",
  ...over,
});

describe("preflightGates", () => {
  const base = {
    pair: "SOL/USDT",
    hasOpenPosition: false,
    openOrderCount: 0,
    freeMarginUsd: 57,
    requiredMarginUsd: 3,
    killSwitchEnabled: false,
    dailyLossUsd: 0,
    maxDailyLossUsd: 12,
    dailyTradeCount: 0,
    maxTradesPerDay: 120,
    // The day's notional budget: the counter and the cap the server
    // enforces, which the client could not see until now.
    dailyNotionalUsd: 0,
    maxDailyNotionalUsd: 500,
    ticketNotionalUsd: 40,
    positionNotionalUsd: 40,
    maxPositionUsd: 60,
    hasTarget: true,
    hasStop: true,
  };

  it("passes when everything is clear", () => {
    const pre = foldPreflight(preflightGates(base));
    assert.equal(pre.ok, true);
    assert.equal(pre.failed, null);
  });

  // THE DAY'S NOTIONAL BUDGET.
  //
  // The server enforces this cap and the client could not see it, so
  // the machine discovered an exhausted budget one live call at a
  // time: 19 "Daily notional cap would exceed $500" refusals in 20
  // minutes, each burning the shared per-minute budget the
  // stop-arming path also needs. The gate now refuses locally.
  it("refuses when the day's notional budget is spent", () => {
    const pre = foldPreflight(
      preflightGates({ ...base, dailyNotionalUsd: 480, ticketNotionalUsd: 40 }),
    );
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /daily_notional/);
  });
  it("matches the server's boundary EXACTLY: at the cap is allowed, over it is not", () => {
    // The server refuses on `>` (risk-gate.ts: `daily_notional_usd +
    // notionalUsd > cap`), so a ticket that lands EXACTLY on the cap
    // is ALLOWED. A client that refused there would refuse a trade
    // the server would take; a client that allowed above it would
    // spend a live call to learn the same thing.
    const atCap = foldPreflight(
      preflightGates({ ...base, dailyNotionalUsd: 460, ticketNotionalUsd: 40 }),
    );
    assert.equal(atCap.ok, true, "460 + 40 = 500, exactly the cap — the server allows it");
    const overCap = foldPreflight(
      preflightGates({ ...base, dailyNotionalUsd: 461, ticketNotionalUsd: 40 }),
    );
    assert.equal(overCap.ok, false, "461 + 40 = 501, over the cap — the server refuses it");
    assert.match(String(overCap.failed), /daily_notional/);
  });
  it("allows a ticket that fits inside the budget", () => {
    const pre = foldPreflight(
      preflightGates({ ...base, dailyNotionalUsd: 400, ticketNotionalUsd: 40 }),
    );
    assert.equal(pre.ok, true);
  });
  it("treats a NULL cap as the server's $500 FLOOR, not as unlimited", () => {
    // A null cap must be the floor. If it were "unlimited" the gate
    // would allow a ticket the server would refuse.
    const pre = foldPreflight(
      preflightGates({
        ...base,
        maxDailyNotionalUsd: null,
        dailyNotionalUsd: 480,
        ticketNotionalUsd: 40,
      }),
    );
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /daily_notional/);
  });

  it("blocks on the kill switch", () => {
    const pre = foldPreflight(preflightGates({ ...base, killSwitchEnabled: true }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /kill_switch/);
  });

  it("blocks when a position is already open on the pair", () => {
    const pre = foldPreflight(preflightGates({ ...base, hasOpenPosition: true }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /no_open_position/);
  });

  it("blocks on stale working orders (they would fill against the next position)", () => {
    const pre = foldPreflight(preflightGates({ ...base, openOrderCount: 1 }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /no_working_orders/);
  });

  it("blocks when free margin is short", () => {
    const pre = foldPreflight(preflightGates({ ...base, freeMarginUsd: 1, requiredMarginUsd: 3 }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /margin_sufficient/);
  });

  it("blocks when the daily loss cap is reached", () => {
    const pre = foldPreflight(preflightGates({ ...base, dailyLossUsd: 12, maxDailyLossUsd: 12 }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /daily_loss/);
  });

  it("blocks when the daily trade cap is reached", () => {
    const pre = foldPreflight(preflightGates({ ...base, dailyTradeCount: 120, maxTradesPerDay: 120 }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /daily_trade_count/);
  });

  it("blocks when the position notional exceeds the cap", () => {
    const pre = foldPreflight(preflightGates({ ...base, positionNotionalUsd: 61, maxPositionUsd: 60 }));
    assert.equal(pre.ok, false);
    assert.match(String(pre.failed), /position_notional/);
  });

  it("a null cap means no cap (not a silent pass-by-accident)", () => {
    const pre = foldPreflight(
      preflightGates({ ...base, maxDailyLossUsd: null, maxTradesPerDay: null, maxPositionUsd: null }),
    );
    assert.equal(pre.ok, true);
  });

  it("blocks a candidate with no take-profit or no stop", () => {
    const noTp = foldPreflight(preflightGates({ ...base, hasTarget: false }));
    assert.equal(noTp.ok, false);
    assert.match(String(noTp.failed), /has_exit_legs/);
    assert.match(String(noTp.failed), /no take-profit/);
    const noStop = foldPreflight(preflightGates({ ...base, hasStop: false }));
    assert.equal(noStop.ok, false);
    assert.match(String(noStop.failed), /no stop/);
  });
});

describe("makeClientOid", () => {
  it("tags every order so a later session can attribute it", () => {
    const oid = makeClientOid("session-1", "turn-7", "SOL/USDT");
    assert.match(oid, /jw3-/);
    assert.match(oid, /session-1/);
    assert.match(oid, /turn-7/);
    assert.match(oid, /SOLUSDT/);
  });
  it("strips characters the venue would reject and stays short", () => {
    const oid = makeClientOid("a b/c!d", "t#1", "SOL/USDT");
    assert.match(oid, /^[A-Za-z0-9_-]+$/);
    assert.ok(oid.length <= 36);
  });
});

describe("buildTicket", () => {
  const proposal: SizingProposal = {
    pair: "IRYS/USDT",
    side: "short",
    entryPrice: 0.0129,
    stopPrice: 0.0131,
    targetPrice: 0.0127,
    contractMultiplier: 100,
    tickSize: 0.000001,
    maintenanceMarginRate: 0.005,
    venueMaxLeverage: 50,
    atrPct: 1.0,
    equityUsd: 57,
    freeMarginUsd: 57,
    riskPctOfEquity: 3,
    feeSchedule: { makerRate: 0.0002, takerRate: 0.0006, entryLeg: "maker", exitLeg: "taker" },
  };

  it("sends `amount` in BASE units (the multiplier trap)", () => {
    const sizing = sizeTrade(proposal);
    assert.ok(sizing);
    assert.equal(sizing.status, "ok");
    const t = buildTicket(candidate({ pair: "IRYS/USDT", side: "short" }), sizing!, "kucoin", "oid-1");
    // contracts x multiplier, NOT the contract count.
    assert.equal(Number(t.order.amount), sizing!.contracts * 100);
    assert.equal(t.order.side, "sell");
    assert.equal(t.order.market, "futures");
    assert.equal(t.order.marginMode, "isolated");
  });

  it("arms both exit legs on the entry", () => {
    const sizing = sizeTrade(proposal);
    const t = buildTicket(candidate({ pair: "IRYS/USDT", side: "short" }), sizing!, "kucoin", "oid-1");
    assert.equal(t.exits.slPrice, sizing!.stopPrice);
    assert.equal(t.exits.tpPrice, sizing!.targetPrice);
  });
});

describe("readLiveAccountState", () => {
  it("reads the FUTURES pocket, not the merged one", async () => {
    const { call } = fakeExchange({ freeMarginUsd: 12.5, equityUsd: 20 });
    const s = await readLiveAccountState("kucoin", "SOL/USDT", call, "pat");
    assert.equal(s.freeMarginUsd, 12.5);
    assert.equal(s.equityUsd, 20);
  });
});

describe("runLive — the safety invariants", () => {
  it("a dry run sends NOTHING", async () => {
    const { calls, call } = fakeExchange();
    const r = await runLive(liveArgs(), { yes: false, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "preview");
    assert.equal(calls.filter(isFundMoving).length, 0);
    assert.ok(r.ticket);
  });

  it("a take-profit ALREADY SATISFIED at the market stops the fire", async () => {
    // A take-profit on the wrong side of the market is a MARKETABLE
    // order: it fills instantly at the touch, so the trade closes in
    // seconds and books a fee instead of a target.
    //
    // This is the defect that made every real round trip a scratch: the
    // ticket's target was derived from the ladder's offset average
    // entry, which for a short sits ABOVE the market. Measured live on
    // 2026-10-21: 6 of the 8 real round trips were scratches, net
    // -$0.5708 on $0.5672 of fees.
    const { calls, call } = fakeExchange();
    const r = await runLive(
      liveArgs({ candidate: candidate({ side: "short", entryPrice: 100, stopPrice: 101, targetPrice: 100.4 }) }),
      { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC },
    );
    assert.equal(r.status, "no-trade");
    assert.match(r.reason, /take-profit.*already satisfied/i);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("a take-profit beyond the market is ALLOWED (the real target)", async () => {
    // A PREVIEW (`yes: false`) so the test exercises the guard without
    // placing anything: the point is that the ticket is NOT refused for
    // the target's side.
    const { calls, call } = fakeExchange();
    const r = await runLive(
      liveArgs({ candidate: candidate({ side: "short", entryPrice: 100, stopPrice: 101, targetPrice: 99.6 }) }),
      { yes: false, json: false, pat: "pat", call, contractSpec: FAKE_SPEC },
    );
    assert.equal(r.status, "preview");
    assert.ok(r.ticket, "a valid ticket must be produced");
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("a stop on the wrong side of the market stops the fire", async () => {
    const { calls, call } = fakeExchange();
    const r = await runLive(
      liveArgs({ candidate: candidate({ side: "short", entryPrice: 100, stopPrice: 99, targetPrice: 99.6 }) }),
      { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC },
    );
    assert.equal(r.status, "no-trade");
    assert.match(r.reason, /stop.*wrong side/i);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("the kill switch stops the fire even with a valid candidate", async () => {
    const { calls, call } = fakeExchange({ killSwitchEnabled: true });
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "no-trade");
    assert.match(r.reason, /kill_switch/);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("stale working orders stop the fire", async () => {
    const { calls, call } = fakeExchange({ openOrderCount: 1 });
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "no-trade");
    assert.match(r.reason, /no_working_orders/);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("insufficient free margin stops the fire", async () => {
    const { calls, call } = fakeExchange({ freeMarginUsd: 0.5 });
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "no-trade");
    // The margin gate can fire in either layer: the sizing engine refuses
    // to produce a ticket it cannot fund, and the preflight refuses a
    // ticket whose margin exceeds free balance. Both must stop the fire.
    assert.match(r.reason, /margin/i);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });

  it("a fired trade places ONE order and arms the exits", async () => {
    const { calls, call } = fakeExchange();
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired");
    const fires = calls.filter((c) => c.name === "execute_trade");
    assert.equal(fires.length, 1);
    assert.equal(r.tpArmed, true);
    assert.equal(r.stopArmed, true);
    const exits = calls.filter((c) => c.name === "set_exits");
    assert.equal(exits.length, 1);
    assert.equal(Number(exits[0]?.args.slPrice) > 0, true);
  });

  it("if the exit legs fail, the position is reported UNPROTECTED", async () => {
    const { calls } = fakeExchange();
    const call = (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "read_live_datum") {
        const kind = String(args.kind ?? "");
        if (kind === "balances") return { data: { accounts: { futures: [{ free: 57.46, total: 57.46 }] } } };
        if (kind === "positions") return { data: [] };
        return { data: [] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") {
        return { risk_limits: { kill_switch_enabled: false, daily_realized_loss_usd: 0, max_daily_loss_usd: 12, daily_trade_count: 0, max_trades_per_day: 120, max_position_usd: 60 } };
      }
      if (name === "execute_trade") return { orderId: "oid-1" };
      if (name === "set_exits") throw new Error("venue rejected the TP leg");
      return {};
    }) as TradeCall;
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "failed");
    assert.match(r.reason, /UNPROTECTED/);
  });

  it("identical inputs produce identical tickets (determinism)", async () => {
    const { call } = fakeExchange();
    const a = await runLive(liveArgs(), { yes: false, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    const b = await runLive(liveArgs(), { yes: false, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.deepEqual(a.ticket?.order, b.ticket?.order);
    assert.deepEqual(a.ticket?.exits, b.ticket?.exits);
  });

  it("the identity tag goes ON THE ORDER, not just onto the ticket", async () => {
    // The tag is not decoration. Without it on the wire the venue carries
    // a random UUID, and a later session cannot tell this order from
    // another actor's — it calls the order foreign/unknown-origin, which
    // is the exact failure the convention exists to prevent.
    const { calls, call } = fakeExchange();
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired");
    const fire = calls.find((c) => c.name === "execute_trade");
    assert.ok(fire);
    const sent = String(fire?.args.clientOid ?? "");
    assert.ok(sent.length > 0, "the fired order carried no clientOid");
    assert.equal(sent, r.ticket?.clientOid);
    // The venue's charset: no spaces, no punctuation beyond - and _.
    assert.match(sent, /^[A-Za-z0-9_-]{1,36}$/);
  });
});

describe("makeIdempotencyKey — the same intent, the same key", () => {
  const o = { pair: "SOL/USDT", side: "buy" as const, amount: "0.5", price: "106.96" };

  it("the SAME intent produces the SAME key (a retry dedupes)", () => {
    const a = makeIdempotencyKey("sess", "t1", o);
    const b = makeIdempotencyKey("sess", "t1", { ...o });
    assert.equal(a, b);
  });

  it("a DIFFERENT intent produces a DIFFERENT key", () => {
    const base = makeIdempotencyKey("sess", "t1", o);
    assert.notEqual(base, makeIdempotencyKey("sess", "t2", o));
    assert.notEqual(base, makeIdempotencyKey("other", "t1", o));
    assert.notEqual(base, makeIdempotencyKey("sess", "t1", { ...o, amount: "0.6" }));
    assert.notEqual(base, makeIdempotencyKey("sess", "t1", { ...o, price: "107.00" }));
    assert.notEqual(base, makeIdempotencyKey("sess", "t1", { ...o, side: "sell" }));
  });

  it("the key carries no timestamp — a retry must not change it", () => {
    // A key built from Date.now() would be different on every retry,
    // which is exactly when the key matters most.
    const k1 = makeIdempotencyKey("sess", "t1", o);
    const k2 = makeIdempotencyKey("sess", "t1", o);
    assert.equal(k1, k2);
    assert.match(k1, /^jw3-[A-Za-z0-9_-]+$/);
    assert.ok(k1.length <= 64);
  });

  it("the fired order carries the key", async () => {
    const { calls, call } = fakeExchange();
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired");
    const fire = calls.find((c) => c.name === "execute_trade");
    const key = String(fire?.args.idempotency_key ?? "");
    assert.ok(key.length > 0, "the fired order carried no idempotency key");
    assert.equal(key, r.ticket?.order.idempotency_key);
  });
});

// ── The account-state shape (the live path was silently ZERO) ─────────────
//
// The MCP returns balances as `{kind, venues:[{data:{accounts:{futures:[...]}}}]}`.
// Reading only `b.data.accounts.futures` saw nothing, so equity and free
// margin were ZERO and the sizing engine refused every trade with "equity
// must be > 0" — a refusal that looked like a risk decision and was
// actually a shape bug.

describe("readLiveAccountState — the shapes the server actually returns", () => {
  const acct = { free: 57.4617807047, total: 57.4617807047 };

  it("reads equity and free margin from the VENUES-wrapped shape", async () => {
    const fakeCall = (name: string, args: { kind?: string }): Promise<unknown> => {
      if (name === "read_live_datum" && args.kind === "balances") {
        return Promise.resolve({
          kind: "balances",
          venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", ...acct }] } } }],
        });
      }
      if (name === "read_live_datum" && args.kind === "positions") {
        return Promise.resolve({ kind: "positions", venues: [{ ok: true, data: [] }] });
      }
      if (name === "list_open_orders") return Promise.resolve([]);
      if (name === "read_risk_limits") return Promise.resolve({ risk_limits: { kill_switch_enabled: false } });
      return Promise.resolve(null);
    };
    const st = await readLiveAccountState("kucoin", "SOL/USDT", fakeCall as never, "pat");
    assert.equal(st.equityUsd, acct.total);
    assert.equal(st.freeMarginUsd, acct.free);
    assert.ok(st.equityUsd > 0, "equity read as zero — the live path is unreachable");
  });

  it("reads equity and free margin from the ALREADY-UNWRAPPED shape", async () => {
    const fakeCall = (name: string, args: { kind?: string }): Promise<unknown> => {
      if (name === "read_live_datum" && args.kind === "balances") {
        return Promise.resolve({ data: { accounts: { futures: [{ asset: "USDT", ...acct }] } } });
      }
      if (name === "read_live_datum" && args.kind === "positions") {
        return Promise.resolve({ data: [] });
      }
      if (name === "list_open_orders") return Promise.resolve([]);
      if (name === "read_risk_limits") return Promise.resolve({ risk_limits: {} });
      return Promise.resolve(null);
    };
    const st = await readLiveAccountState("kucoin", "SOL/USDT", fakeCall as never, "pat");
    assert.equal(st.equityUsd, acct.total);
  });

  it("SEES an open position — the venues-wrapped shape must not read as flat", async () => {
    // The dangerous direction of this bug: an account WITH a position
    // reading as flat would let a second position stack on the first.
    const fakeCall = (name: string, args: { kind?: string }): Promise<unknown> => {
      if (name === "read_live_datum" && args.kind === "balances") {
        return Promise.resolve({ venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", ...acct }] } } }] });
      }
      if (name === "read_live_datum" && args.kind === "positions") {
        return Promise.resolve({ venues: [{ ok: true, data: [{ symbol: "SOLUSDT", size: 1 }] }] });
      }
      if (name === "list_open_orders") return Promise.resolve([]);
      if (name === "read_risk_limits") return Promise.resolve({ risk_limits: {} });
      return Promise.resolve(null);
    };
    const st = await readLiveAccountState("kucoin", "SOL/USDT", fakeCall as never, "pat");
    assert.equal(st.hasOpenPosition, true, "an open position read as FLAT");
  });
});

describe("a position that cannot be protected must not be left naked", () => {
  it("a failed exit arm is retried, and if that fails the position is CLOSED", async () => {
    // The entry filled and the stop could not be armed. A leveraged
    // position with no stop is the worst state this system can be in.
    // The path must not simply report the failure and walk away.
    const calls: string[] = [];
    const call = async (name: string): Promise<unknown> => {
      calls.push(name);
      if (name === "read_live_datum") {
        return {
          venues: [{
            ok: true,
            data: {
              accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] },
            },
          }],
        };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "ord-1" };
      if (name === "set_exits") throw new Error("rate_limited: Rate limit exceeded");
      if (name === "close_position") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "failed");
    assert.equal(r.stopArmed, false);
    assert.equal(r.flattened, true, "the naked position was NOT closed");
    // The exit was tried twice, then the position was flattened.
    const exitTries = calls.filter((c) => c === "set_exits").length;
    assert.equal(exitTries, 2, `the exit arm was tried ${exitTries} time(s)`);
    assert.ok(calls.includes("close_position"), "the position was left open and unprotected");
  });

  it("a transient exit failure that succeeds on the retry is NOT a failure", async () => {
    let exits = 0;
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return {
          venues: [{
            ok: true,
            data: {
              accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] },
            },
          }],
        };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "ord-2" };
      if (name === "set_exits") {
        exits++;
        if (exits === 1) throw new Error("rate_limited: Rate limit exceeded");
        return { ok: true };
      }
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", `a retried exit arm should still fire: ${r.reason}`);
    assert.equal(r.stopArmed, true);
    assert.equal(r.flattened, undefined);
  });
});

describe("the venue's own leverage cap is a LOWER bound, not a failure", () => {
  it("a venue that caps leverage below the derived value is retried at the venue's number", async () => {
    // KuCoin's cap is PER POSITION TIER: a $56 position can carry at
    // most x20 even though the contract record advertises 75. Less
    // leverage is SAFE (more margin, not more risk), so the path takes
    // the venue's number and tries again rather than dying.
    const seen: number[] = [];
    let calls = 0;
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") {
        calls++;
        if (calls === 1) {
          seen.push(-1);
          throw new Error("upstream: execute_trade order rejected: cex-proxy 400: KuCoin 300016: Leverage cannot exceed 20.");
        }
        return { orderId: "ord-lev" };
      }
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", `the venue cap should not end the attempt: ${r.reason}`);
    assert.equal(calls, 2, "the entry was not retried at the venue's leverage");
    // The ticket now carries the venue's number, and says so.
    const lev = (r.ticket?.order as { leverage?: number })?.leverage;
    assert.equal(lev, 20, `the ticket still carries the rejected leverage: ${lev}`);
    const warn = (r.ticket?.sizing.warnings ?? []).join(" ");
    assert.match(warn, /venue caps this position at x20/);
  });

  it("a venue error that is NOT a leverage cap is not retried", async () => {
    let calls = 0;
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") { calls++; throw new Error("insufficient margin"); }
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "failed");
    assert.equal(calls, 1, "a non-leverage error was retried");
    assert.match(r.reason, /insufficient margin/);
  });
});

describe("a DEDUPED submit is not a fire", () => {
  it("reports no-trade and checks the venue, instead of claiming a fire", async () => {
    // The server's dedupe arbiter answers a repeated intent with an
    // EMPTY orderId and `deduped: true` — it deliberately did not
    // dispatch. Treating that as a success is how a caller reports
    // "fired + exits armed" for a trade that never happened.
    const calls: string[] = [];
    const call = async (name: string): Promise<unknown> => {
      calls.push(name);
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "", status: "deduped", deduped: true };
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "no-trade", `a deduped submit was reported as ${r.status}`);
    assert.match(r.reason, /DEDUPED/);
    assert.ok(!calls.includes("set_exits"), "the exits were armed for a trade that was never dispatched");
  });
});

describe("the live entry is a MARKET order, so the stop can attach", () => {
  it("the ticket's order type is market, and the price is reference-only", async () => {
    // The exit legs are venue-native conditionals that attach to a
    // POSITION. A resting limit entry has no position until it fills, so
    // the stop cannot attach — and the order rests unprotected. A DOT
    // sell limit was found on the book at +1.02% above the market with
    // no stop and no position.
    const { calls, call } = fakeExchange();
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", `the live path did not fire: ${r.reason}`);
    const fire = calls.find((c) => c.name === "execute_trade");
    const args = fire?.args as { type?: string; price?: string };
    assert.equal(args.type, "market", `the entry was not a market order: ${JSON.stringify(args)}`);
  });

  it("the exits are armed with the entry", async () => {
    const { calls, call } = fakeExchange();
    await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    const fire = calls.find((c) => c.name === "execute_trade");
    const exits = calls.find((c) => c.name === "set_exits");
    assert.ok(fire, "no entry was placed");
    assert.ok(exits, "the exits were never armed");
    const e = exits?.args as { slPrice?: number; tpPrice?: number };
    assert.ok((e?.slPrice ?? 0) > 0, "the exit legs carried no stop price");
  });
});

describe("a throttled VERIFY must not turn a successful fire into a failure", () => {
  it("a rate-limited verification still reports fired, and says the state is unconfirmed", async () => {
    // The trade is already done at the verify step: the entry is filled
    // and the exits are armed. A throttled confirm-read must not report
    // a failure — that would tell the operator the opposite of the truth
    // about a live leveraged position.
    let n = 0;
    const call = async (name: string): Promise<unknown> => {
      n++;
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "read_live_datum") {
        // The FIRST account read (preflight) succeeds; the SECOND (verify)
        // is throttled.
        if (n < 8) return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
        throw new Error("rate_limited: Rate limit exceeded — try again in 60s");
      }
      if (name === "list_open_orders") return [];
      if (name === "execute_trade") return { orderId: "ord-v" };
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", `a throttled verify was reported as ${r.status}: ${r.reason}`);
    assert.equal(r.stopArmed, true);
    assert.equal(r.verified, null, "the venue state was reported as verified when it was not");
    assert.match(r.reason, /VERIFICATION read was throttled/);
  });
});

describe("the realized-P&L reconcile after a fire", () => {
  // The daily loss cap is enforced from the server's realized-loss
  // counter, which the CLOSE path increments. A trade closed by the
  // VENUE's own stop never goes through it — so the loss has to be
  // counted from the venue, which is the book of record.
  it("runs the reconcile after a fire and reports what it counted", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const state = { freeMarginUsd: 57.46, equityUsd: 57.46 };
    const call = (async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "read_live_datum") {
        const kind = String(args.kind ?? "");
        if (kind === "balances") return { data: { accounts: { futures: [{ free: state.freeMarginUsd, total: state.equityUsd }] } } };
        if (kind === "positions") return { data: [] };
        return { data: [] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") {
        return { risk_limits: { kill_switch_enabled: false, daily_realized_loss_usd: 0, max_daily_loss_usd: 12, daily_trade_count: 0, max_trades_per_day: 120, max_position_usd: 60 } };
      }
      if (name === "execute_trade") return { orderId: "oid-1" };
      if (name === "set_exits") return { ok: true };
      if (name === "reconcile_realized_pnl") {
        return { content: [{ type: "text", text: JSON.stringify({ counted: 1, lossRecordedUsd: 0.0761, alreadyCounted: 2 }) }] };
      }
      return {};
    }) as TradeCall;

    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired");
    assert.ok(calls.some((c) => c.name === "reconcile_realized_pnl"), "the reconcile must run after a fire");
    assert.deepEqual(r.reconciled, { counted: 1, lossRecordedUsd: 0.0761, alreadyCounted: 2 });
  });

  it("a FAILED reconcile does not turn a fired trade into a failure", async () => {
    // The trade is already done. A failure to COUNT a loss must never be
    // reported as a failure to TRADE.
    const call = (async (name: string, args: Record<string, unknown>) => {
      if (name === "read_live_datum") {
        const kind = String(args.kind ?? "");
        if (kind === "balances") return { data: { accounts: { futures: [{ free: 57.46, total: 57.46 }] } } };
        if (kind === "positions") return { data: [] };
        return { data: [] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") {
        return { risk_limits: { kill_switch_enabled: false, daily_realized_loss_usd: 0, max_daily_loss_usd: 12, daily_trade_count: 0, max_trades_per_day: 120, max_position_usd: 60 } };
      }
      if (name === "execute_trade") return { orderId: "oid-1" };
      if (name === "set_exits") return { ok: true };
      if (name === "reconcile_realized_pnl") throw new Error("rate limited");
      return {};
    }) as TradeCall;

    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", "a failed reconcile must not fail the trade");
    assert.equal(r.reconciled, null);
  });
});

// ── A THROTTLE MUST NOT BE REPORTED AS A VENUE LEVERAGE CAP ──────────
//
// The leverage-cap branch is reached AFTER a cap adjustment, so the old
// code assumed every error there was the cap. Observed live: a
// `rate_limited` refusal was reported as "entry failed at the venue's
// own leverage cap (x20): rate_limited" — a throttle dressed up as a
// venue cap, which sends the operator looking for a leverage problem
// that never existed.
//
// And the throttle is not merely mislabelled: it is a
// DEFINITIVELY-BEFORE-DISPATCH refusal, so nothing was placed and the
// trade can be retried.

describe("a rate limit is named as a rate limit, not as a venue cap", () => {
  const throttledCall = (name: string): unknown => {
    if (name === "read_live_datum") {
      return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
    }
    if (name === "list_open_orders") return [];
    if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
    if (name === "execute_trade") {
      throw new Error("rate_limited: Rate limit exceeded \u2014 try again in 60s");
    }
    if (name === "set_exits") return { ok: true };
    return null;
  };

  it("a throttle is reported as a throttle, not as the venue's leverage cap", async () => {
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: throttledCall as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "failed");
    assert.doesNotMatch(
      r.reason,
      /leverage cap/,
      `a rate limit must not be reported as a leverage cap: ${r.reason}`,
    );
    assert.match(r.reason, /rate limit/i);
  });

  it("a throttle is marked RETRYABLE, because nothing was placed", async () => {
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: throttledCall as never, contractSpec: FAKE_SPEC });
    assert.equal(r.retryable, true, "a throttle happens before dispatch, so the trade can be retried");
  });

  it("a GENUINE venue failure is NOT marked retryable", async () => {
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") throw new Error("insufficient margin");
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "failed");
    assert.notEqual(r.retryable, true, "a venue rejection may or may not have dispatched");
  });
});

// ── A LEVERAGE RETRY IS A DIFFERENT INTENT, NOT A RETRY ───────────────
//
// The idempotency key is derived from the intent so that a retry
// dedupes instead of double-filling. But a venue that caps a position
// at x20 instead of the derived x38 changes the margin committed, the
// liquidation distance, and the risk — it is a DIFFERENT order.
//
// Observed live: a candidate that passed every gate, had its leverage
// reduced 38 -> 20 by the venue's position tier, and was then DEDUPED
// by the server's arbiter because the retry carried the original key
// (pair/side/amount/price were unchanged). The trade was lost with no
// order placed.

describe("a leverage adjustment is a new intent, so it needs a new key", () => {
  const base = { pair: "AVAX/USDT", side: "sell" as const, amount: "6.1", price: "9.748" };

  it("the same intent with the same leverage produces the same key", () => {
    const a = makeIdempotencyKey("sess", "turn", { ...base, leverage: 38 });
    const b = makeIdempotencyKey("sess", "turn", { ...base, leverage: 38 });
    assert.equal(a, b, "a retry of the same intent must dedupe, not double-fill");
  });

  it("a DIFFERENT leverage produces a DIFFERENT key", () => {
    const a = makeIdempotencyKey("sess", "turn", { ...base, leverage: 38 });
    const b = makeIdempotencyKey("sess", "turn", { ...base, leverage: 20 });
    assert.notEqual(a, b, "a leverage adjustment is a different intent, so the arbiter must not dedupe it");
  });

  it("a different size or price still produces a different key", () => {
    const a = makeIdempotencyKey("sess", "turn", { ...base, leverage: 20 });
    assert.notEqual(a, makeIdempotencyKey("sess", "turn", { ...base, amount: "6.2", leverage: 20 }));
    assert.notEqual(a, makeIdempotencyKey("sess", "turn", { ...base, price: "9.7", leverage: 20 }));
  });

  it("the leverage-adjusted retry REACHES THE VENUE with a new key", async () => {
    const keys: string[] = [];
    let calls = 0;
    const call = async (name: string, args?: unknown): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") {
        calls++;
        keys.push(String((args as { idempotency_key?: string } | undefined)?.idempotency_key ?? ""));
        if (calls === 1) {
          throw new Error("upstream: execute_trade order rejected: cex-proxy 400: KuCoin 300016: Leverage cannot exceed 20.");
        }
        return { orderId: "ord-lev-2" };
      }
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", `the venue cap should not end the attempt: ${r.reason}`);
    assert.equal(calls, 2, "the entry was not retried at the venue's leverage");
    assert.equal(keys.length, 2);
    assert.notEqual(
      keys[0],
      keys[1],
      `the retry must carry a NEW idempotency key, or the arbiter dedupes it and the trade is lost: ${keys[0]} vs ${keys[1]}`,
    );
  });
});

// ── THE FEE SCHEDULE MUST MATCH WHAT THE VENUE ACTUALLY CHARGES ─────
//
// The live path sizes a ticket, and the sizing engine's fee-floor gate
// decides whether the stop is wide enough to survive the fees. That
// gate reads the round-trip rate from the schedule.
//
// The schedule said "a resting limit is a maker entry" — but the live
// path places a MARKET order, because the exit legs are venue-native
// conditionals that need a POSITION to attach to. So the entry is a
// taker, and the take-profit trigger becomes a market order when it
// fires, so the exit is a taker too.
//
// The venue settled it: every fill in the live account charged EXACTLY
// 0.0600% — the taker rate — on BOTH legs. The old schedule told the
// sizing engine 0.08%, a THIRD too little, so every ticket was sized
// against a fee floor that was too low.

describe("the fee schedule matches the venue's actual fills", () => {
  it("the round-trip rate is the TAKER rate, because both legs are takers", async () => {
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "ord-fee" };
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.status, "fired", r.reason);
    const rate = r.ticket?.sizing.feeRateRoundTrip;
    // 0.06% + 0.06% = 0.0012. The venue charged 0.0600% on every leg.
    assert.equal(rate, 0.0012, `the fee floor must use the venue's real round trip: ${rate}`);
  });

  it("the ticket's order type is a MARKET order, so the entry cannot be a maker", async () => {
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "ord-type" };
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    assert.equal(r.ticket?.order.type, "market", "a resting entry cannot be protected, so the entry is a market order");
  });

  it("the fee drag is reported against the real rate", async () => {
    const call = async (name: string): Promise<unknown> => {
      if (name === "read_live_datum") {
        return { venues: [{ ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 57.46, total: 57.46 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      if (name === "read_risk_limits") return { risk_limits: { kill_switch_enabled: false } };
      if (name === "execute_trade") return { orderId: "ord-drag" };
      if (name === "set_exits") return { ok: true };
      return null;
    };
    const r = await runLive(liveArgs(), { yes: true, json: false, pat: "pat", call: call as never, contractSpec: FAKE_SPEC });
    const drag = r.ticket?.sizing.feeDragFracOfStop;
    const stopFrac = r.ticket?.sizing.stopDistanceFrac;
    assert.ok(stopFrac && stopFrac > 0, "the ticket must carry a stop distance");
    assert.ok(
      Math.abs((drag ?? 0) - 0.0012 / stopFrac) < 1e-9,
      `the fee drag must be the real rate over the stop distance: ${drag} vs ${0.0012 / stopFrac}`,
    );
  });
});
