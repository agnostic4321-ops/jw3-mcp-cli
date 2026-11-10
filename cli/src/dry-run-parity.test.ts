/**
 * Dry-run parity: the preview (no --yes) must send ZERO fund-moving calls,
 * and --yes must send EXACTLY the ticket the builders produce (the same
 * builders the preview path uses — single construction site).
 * No network: every test injects a scripted `call` spy. No trades.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cancelAllListArgs,
  cancelToolArgs,
  closeToolArgs,
  cmdCancel,
  cmdCancelAll,
  cmdClose,
  cmdExecute,
  cmdExits,
  executeToolArgs,
  exitsToolArgs,
  makeIntentKey,
  type TradeCall,
} from "./commands/trade.js";

type Call = { name: string; args: Record<string, unknown> };

function spy(calls: Call[], script: (c: Call) => unknown): TradeCall {
  return async (name: string, args: Record<string, unknown>) => {
    const c = { name, args };
    calls.push(c);
    return script(c);
  };
}

const writes = (c: Call): boolean =>
  c.name === "execute_trade" || c.name === "close_position" || c.name === "set_exits" || c.name === "cancel_order";

let logSink: string[];
let errSink: string[];
const realLog = console.log;
const realErr = console.error;

beforeEach(() => {
  process.exitCode = 0;
  logSink = [];
  errSink = [];
  console.log = (...a: unknown[]) => { logSink.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errSink.push(a.map(String).join(" ")); };
});

afterEach(() => {
  console.log = realLog;
  console.error = realErr;
  process.exitCode = 0;
});

describe("ticket builders (single construction site)", () => {
  it("execute builds the exact venue ticket", () => {
    const t1 = executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "BUY", amount: 2, market: "Futures", leverage: 2, marginMode: "Isolated", stop: 1, tp: 2 });
    assert.deepEqual(
      { ...t1, idempotency_key: undefined },
      { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: "2", market: "futures", leverage: 2, marginMode: "isolated", stop: 1, tp: 2, idempotency_key: undefined },
    );
    // The key is auto-derived from the intent (never a timestamp): the same
    // ticket reproduces the same key, a different ticket a different one.
    assert.match(String(t1.idempotency_key), /^jw3-ex-[0-9a-f]{8}$/);
    assert.equal(executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 2, market: "futures", leverage: 2, marginMode: "isolated", stop: 1, tp: 2 }).idempotency_key, t1.idempotency_key);
    assert.notEqual(
      executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 3, market: "futures", leverage: 2, marginMode: "isolated", stop: 1, tp: 2 }).idempotency_key,
      t1.idempotency_key,
    );
    // An explicit key always wins; an explicit actor rides the ticket.
    assert.equal(
      executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 2, idempotencyKey: "op-key-1", actor: "owner" }).idempotency_key,
      "op-key-1",
    );
    assert.equal(
      executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 2, actor: "owner" }).actor,
      "owner",
    );
    // No actor claim means no actor field: the server attributes the call to
    // the authenticated subject (never a silent client-side default).
    assert.equal("actor" in t1, false);
    const t2 = executeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "sell", riskUsd: 50 });
    assert.deepEqual(
      { ...t2, idempotency_key: undefined },
      { exchange: "kucoin", pair: "BTC/USDT", side: "sell", risk_usd: 50, idempotency_key: undefined },
    );
    assert.match(String(t2.idempotency_key), /^jw3-ex-[0-9a-f]{8}$/);
    assert.notEqual(t2.idempotency_key, t1.idempotency_key);
  });
  it("close/exits/cancel build exact tickets", () => {
    assert.deepEqual(
      closeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "LONG", size: 3 }),
      { exchange: "kucoin", pair: "BTC/USDT", side: "long", size: "3" },
    );
    assert.deepEqual(
      closeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "short" }),
      { exchange: "kucoin", pair: "BTC/USDT", side: "short" },
    );
    assert.deepEqual(
      exitsToolArgs({ exchange: "kucoin", pair: "BTC/USDT", tp: 99, market: "FUTURES" }),
      { exchange: "kucoin", pair: "BTC/USDT", tpPrice: 99, market: "futures" },
    );
    assert.deepEqual(
      cancelToolArgs({ exchange: "kucoin", orderId: "o1", pair: "BTC/USDT", market: "Spot" }),
      { exchange: "kucoin", orderId: "o1", pair: "BTC/USDT", market: "spot" },
    );
    assert.deepEqual(cancelAllListArgs({ exchange: "kucoin", pair: "BTC/USDT" }), { exchange: "kucoin", pair: "BTC/USDT" });
  });
});

describe("dry run sends nothing", () => {
  it("execute/close/exits/cancel make zero calls without --yes", async () => {
    const calls: Call[] = [];
    const boom = spy(calls, () => { throw new Error("must not be called"); });
    await cmdExecute({ exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 1 }, { yes: false, json: true, pat: "p" }, { call: boom });
    await cmdClose({ exchange: "kucoin", pair: "BTC/USDT", side: "long", yes: false, json: true, pat: "p" }, { call: boom });
    await cmdExits({ exchange: "kucoin", pair: "BTC/USDT", tp: 99, yes: false, json: true, pat: "p" }, { call: boom });
    await cmdCancel({ exchange: "kucoin", orderId: "o1", yes: false, json: true, pat: "p" }, { call: boom });
    assert.equal(calls.length, 0);
    assert.equal(process.exitCode, 0);
  });
  it("cancel-all dry run sends no cancel_order", async () => {
    const calls: Call[] = [];
    const s = spy(calls, (c) => {
      if (c.name === "list_open_orders") return [{ orderId: "a", symbol: "BTC/USDT" }];
      if (c.name === "read_risk_limits") return {};
      throw new Error(`must not call ${c.name}`);
    });
    await cmdCancelAll({ exchange: "kucoin", pair: "BTC/USDT", yes: false, json: true, pat: "p" }, { call: s });
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => !writes(c)), "dry run placed a fund-moving call");
    assert.equal(process.exitCode, 0);
  });
});

describe("live fire matches the preview ticket", () => {
  it("execute --yes sends exactly the builder ticket, once", async () => {
    const calls: Call[] = [];
    const s = spy(calls, () => ({ orderId: "x" }));
    const inTicket = { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 1, market: "futures" };
    await cmdExecute(inTicket, { yes: true, json: true, pat: "p" }, { call: s });
    // OQ-12: runLive's kill-switch + caps gate reads the risk limits once,
    // then the ONE order goes out with the builder ticket byte-for-byte.
    assert.deepEqual(calls.map((c) => c.name), ["read_risk_limits", "execute_trade"]);
    assert.deepEqual(calls[1]?.args, executeToolArgs(inTicket));
    assert.equal(process.exitCode, 0);
  });
  it("close/exits/cancel --yes send exactly their builder tickets", async () => {
    const calls: Call[] = [];
    const s = spy(calls, () => ({}));
    await cmdClose({ exchange: "kucoin", pair: "BTC/USDT", side: "short", size: 2, yes: true, json: true, pat: "p" }, { call: s });
    await cmdExits({ exchange: "kucoin", pair: "BTC/USDT", sl: 1, tp: 2, yes: true, json: true, pat: "p" }, { call: s });
    await cmdCancel({ exchange: "kucoin", orderId: "o9", pair: "BTC/USDT", yes: true, json: true, pat: "p" }, { call: s });
    assert.deepEqual(calls[0], { name: "close_position", args: closeToolArgs({ exchange: "kucoin", pair: "BTC/USDT", side: "short", size: 2 }) });
    assert.deepEqual(calls[1], { name: "set_exits", args: exitsToolArgs({ exchange: "kucoin", pair: "BTC/USDT", sl: 1, tp: 2 }) });
    assert.deepEqual(calls[2], { name: "cancel_order", args: cancelToolArgs({ exchange: "kucoin", orderId: "o9", pair: "BTC/USDT" }) });
    assert.equal(process.exitCode, 0);
  });
});

describe("makeIntentKey: per-intent, per-namespace, no timestamps", () => {
  it("is stable for the same intent and distinct across namespaces and shapes", () => {
    assert.equal(makeIntentKey("ex", "a|b"), makeIntentKey("ex", "a|b"));
    assert.notEqual(makeIntentKey("ex", "a|b"), makeIntentKey("degen", "a|b"));
    assert.notEqual(makeIntentKey("ex", "a|b"), makeIntentKey("ex", "a|c"));
    assert.match(makeIntentKey("ex", "a|b"), /^jw3-ex-[0-9a-f]{8}$/);
  });
});

describe("cancel-all verification", () => {
  const book = [{ orderId: "a", symbol: "BTC/USDT" }, { orderId: "b", symbol: "BTC/USDT" }];
  it("re-lists after the fan-out and passes when flat", async () => {
    const calls: Call[] = [];
    let lists = 0;
    const s = spy(calls, (c) => {
      if (c.name === "read_risk_limits") return {};
      if (c.name === "list_open_orders") return ++lists === 1 ? book : [];
      if (c.name === "cancel_order") return {};
      throw new Error(`unexpected ${c.name}`);
    });
    await cmdCancelAll({ exchange: "kucoin", pair: "BTC/USDT", yes: true, json: true, pat: "p" }, { call: s });
    assert.deepEqual(calls.map((c) => c.name), ["read_risk_limits", "list_open_orders", "cancel_order", "cancel_order", "list_open_orders"]);
    assert.equal(process.exitCode, 0);
  });
  it("fails when orders remain after the fan-out", async () => {
    const calls: Call[] = [];
    const s = spy(calls, (c) => {
      if (c.name === "read_risk_limits") return {};
      if (c.name === "list_open_orders") return book;
      if (c.name === "cancel_order") throw new Error("venue refused");
      throw new Error(`unexpected ${c.name}`);
    });
    await cmdCancelAll({ exchange: "kucoin", pair: "BTC/USDT", yes: true, json: true, pat: "p" }, { call: s });
    assert.equal(calls.filter((c) => c.name === "list_open_orders").length, 2);
    assert.equal(process.exitCode, 1);
  });
});
