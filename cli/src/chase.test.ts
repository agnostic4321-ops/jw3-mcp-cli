import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chaseTouchFor,
  cmdExecuteChase,
  isChaseWorking,
  parseChaseFlags,
  runChase,
  shouldReprice,
  validateChase,
  type ChaseConfig,
  type ChaseDeps,
  type ChaseEvent,
  type Touch,
} from "./chase.js";

const CFG: ChaseConfig = { enabled: true, secs: 10, pollSecs: 2, take: false };

type Script = {
  touches: Touch[];
  /** working rows per order id; absent id = filled */
  working: Set<string>;
  placed: { price: number | undefined }[];
  cancelled: string[];
  cancelFails: Set<string>;
  events: ChaseEvent[];
  now: number;
};

function script(touches: Touch[], opts?: { cancelFails?: string[] }): { deps: ChaseDeps; s: Script } {
  const s: Script = {
    touches: [...touches],
    working: new Set(),
    placed: [],
    cancelled: [],
    cancelFails: new Set(opts?.cancelFails ?? []),
    events: [],
    now: 0,
  };
  let n = 0;
  const deps: ChaseDeps = {
    touchFn: async () => s.touches.shift() ?? { bestBid: 100, bestAsk: 100.1 },
    placeFn: async (price) => {
      const id = `o${++n}`;
      s.placed.push({ price });
      s.working.add(id);
      return id;
    },
    cancelFn: async (id) => {
      s.cancelled.push(id);
      if (s.cancelFails.has(id)) throw new Error(`cancel refused for ${id}`);
      s.working.delete(id);
    },
    workingFn: async (id) => s.working.has(id),
    sleepMs: async (ms) => {
      s.now += ms;
    },
    nowMs: () => s.now,
    onEvent: (e) => {
      s.events.push(e);
    },
  };
  return { deps, s };
}

const T = (bid: number, ask: number): Touch => ({ bestBid: bid, bestAsk: ask });

describe("parseChaseFlags", () => {
  it("stays off without --chase", () => {
    const r = parseChaseFlags(["--exchange", "kucoin"]);
    assert.ok("cfg" in r && r.cfg.enabled === false);
  });
  it("parses the full flag set", () => {
    const r = parseChaseFlags(["--chase", "30", "--chase-poll", "1", "--chase-max", "3", "--chase-take"]);
    assert.ok("cfg" in r);
    if ("cfg" in r) assert.deepEqual(r.cfg, { enabled: true, secs: 30, pollSecs: 1, maxChases: 3, take: true });
  });
  it("accepts --chase=60 form with defaults", () => {
    const r = parseChaseFlags(["--chase=60"]);
    assert.ok("cfg" in r);
    if ("cfg" in r) {
      assert.equal(r.cfg.secs, 60);
      assert.equal(r.cfg.pollSecs, 2);
      assert.equal(r.cfg.maxChases, undefined);
      assert.equal(r.cfg.take, false);
    }
  });
  it("rejects garbage without inventing", () => {
    for (const rest of [["--chase", "0"], ["--chase", "-5"], ["--chase", "9999"], ["--chase", "soon"], ["--chase", "10", "--chase-poll", "0"], ["--chase", "10", "--chase-max", "-1"], ["--chase", "10", "--chase-max", "1.5"]]) {
      const r = parseChaseFlags(rest);
      assert.ok("error" in r, JSON.stringify(rest));
    }
  });
});

describe("validateChase", () => {
  it("passes a usable ticket, rejects futures-only violation", () => {
    assert.equal(validateChase(CFG, "futures"), null);
    assert.equal(validateChase(CFG), null);
    assert.match(validateChase(CFG, "spot") as string, /futures-only/);
    assert.match(validateChase(CFG, "SPOT") as string, /futures-only/);
  });
  it("rejects out-of-range budgets", () => {
    assert.ok(validateChase({ ...CFG, secs: 0 }));
    assert.ok(validateChase({ ...CFG, secs: 601 }));
    assert.ok(validateChase({ ...CFG, maxChases: -1 }));
  });
});

describe("chaseTouchFor + shouldReprice", () => {
  it("buy joins the bid, sell joins the ask", () => {
    assert.equal(chaseTouchFor("buy", T(100, 100.1)), 100);
    assert.equal(chaseTouchFor("sell", T(100, 100.1)), 100.1);
    assert.equal(chaseTouchFor("BUY", T(100, 100.1)), 100);
  });
  it("bad touches are NaN, never a fake zero", () => {
    assert.ok(Number.isNaN(chaseTouchFor("buy", T(0, 100.1))));
    assert.ok(Number.isNaN(chaseTouchFor("sell", T(100, 0))));
  });
  it("reprice only on a real move", () => {
    assert.equal(shouldReprice(100, 100.1), true);
    assert.equal(shouldReprice(100, 100), false);
    assert.equal(shouldReprice(100, NaN), false);
    assert.equal(shouldReprice(0, 100), false);
  });
});

describe("isChaseWorking", () => {
  it("finds the id in bare and wrapped payloads", () => {
    assert.equal(isChaseWorking([{ orderId: "a" }], "a"), true);
    assert.equal(isChaseWorking([{ orderId: "a" }], "b"), false);
    assert.equal(isChaseWorking({ orders: [{ id: "a" }] }, "a"), true);
    assert.equal(isChaseWorking([], "a"), false);
    assert.equal(isChaseWorking(null, "a"), false);
  });
});

describe("runChase", () => {
  it("fills without a chase when the first poll shows it gone", async () => {
    const { deps, s } = script([T(100, 100.1)]);
    // venue fills between place and first poll: drop it from working on first check
    let checks = 0;
    const inner = deps.workingFn;
    deps.workingFn = async (id) => (++checks === 1 ? false : inner(id));
    const r = await runChase("buy", CFG, deps);
    assert.equal(r.outcome, "filled");
    assert.equal(r.chases, 0);
    assert.deepEqual(s.placed, [{ price: 100 }]);
    assert.deepEqual(s.cancelled, []);
  });
  it("cancel-replaces onto a moved touch, then fills", async () => {
    const { deps, s } = script([T(100, 100.1), T(100.5, 100.6), T(100.5, 100.6)]);
    let polls = 0;
    const inner = deps.workingFn;
    deps.workingFn = async (id) => (++polls <= 2 ? true : (s.working.delete(id), inner(id)));
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "filled");
    assert.equal(r.chases, 1);
    assert.deepEqual(s.placed.map((p) => p.price), [100, 100.5]);
    assert.deepEqual(s.cancelled, ["o1"]);
  });
  it("a resting touch never triggers a replace", async () => {
    const { deps, s } = script([T(100, 100.1)]);
    const r = await runChase("buy", { ...CFG, secs: 4 }, deps);
    assert.equal(r.outcome, "aborted");
    assert.equal(r.chases, 0);
    assert.equal(s.placed.length, 1);
    assert.deepEqual(s.cancelled, ["o1"]);
  });
  it("--chase-max 0 rests through moves, then aborts by default", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1), T(102, 102.1)]);
    const r = await runChase("buy", { ...CFG, secs: 6, maxChases: 0 }, deps);
    assert.equal(r.outcome, "aborted");
    assert.equal(r.chases, 0);
    assert.equal(s.placed.length, 1);
    assert.deepEqual(s.cancelled, ["o1"]);
  });
  it("--chase-take cancels then fires one market take", async () => {
    const { deps, s } = script([T(100, 100.1)]);
    const r = await runChase("sell", { ...CFG, secs: 4, take: true }, deps);
    assert.equal(r.outcome, "taken");
    assert.deepEqual(s.placed, [{ price: 100.1 }, { price: undefined }]);
    assert.deepEqual(s.cancelled, ["o1"]);
  });
  it("mid-loop cancel failure reports stuck and places NOTHING more", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1)], { cancelFails: ["o1"] });
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "stuck");
    assert.equal(r.orderId, "o1");
    assert.ok(r.cancelError);
    assert.equal(s.placed.length, 1);
  });
  it("take-path cancel failure reports stuck and fires NO market take", async () => {
    const { deps, s: _s } = script([T(100, 100.1)], { cancelFails: ["o1"] });
    const r = await runChase("buy", { ...CFG, secs: 2, take: true }, deps);
    assert.equal(r.outcome, "stuck");
    assert.equal(_s.placed.length, 1);
  });
  it("abort-path cancel failure reports stuck with the surviving id", async () => {
    const { deps, s: _s } = script([T(100, 100.1)], { cancelFails: ["o1"] });
    const r = await runChase("buy", { ...CFG, secs: 2 }, deps);
    assert.equal(r.outcome, "stuck");
    assert.equal(r.orderId, "o1");
  });
  it("throws when the opening touch is unusable — nothing placed", async () => {
    const { deps, s } = script([T(0, 0)]);
    await assert.rejects(runChase("buy", CFG, deps), /no usable touch/);
    assert.equal(s.placed.length, 0);
  });
  it("pair gate: a foreign working order aborts flat instead of stacking", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1)]);
    deps.pairOrdersFn = async () => [...s.working, "stale-tp"];
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "aborted");
    assert.match(String(r.note), /foreign/);
    assert.equal(s.placed.length, 1, "no replace stacked beside the foreign order");
    assert.deepEqual(s.cancelled, ["o1"], "ours cancelled on the way out");
  });
  it("pair gate: our order already gone reads as filled, nothing cancelled", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1)]);
    deps.pairOrdersFn = async () => [];
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "filled");
    assert.match(String(r.note), /filled/);
    assert.equal(s.placed.length, 1);
    assert.deepEqual(s.cancelled, []);
  });
  it("pair gate: an unreadable pair book aborts flat, never stacks blind", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1)]);
    deps.pairOrdersFn = async () => { throw new Error("venue down"); };
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "aborted");
    assert.match(String(r.note), /pair working-order read failed/);
    assert.equal(s.placed.length, 1);
  });
  it("pair gate failure to cancel still reports stuck, never masks it", async () => {
    const { deps, s } = script([T(100, 100.1), T(101, 101.1)], { cancelFails: ["o1"] });
    deps.pairOrdersFn = async () => [...s.working, "stale-tp"];
    const r = await runChase("buy", { ...CFG, secs: 60 }, deps);
    assert.equal(r.outcome, "stuck");
    assert.equal(r.orderId, "o1");
    assert.ok(r.cancelError);
    assert.equal(s.placed.length, 1);
  });
});

describe("cmdExecuteChase dry run", () => {
  it("prints the plan and sends nothing without --yes", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const origLog = console.log;
    const exitBefore = process.exitCode;
    console.log = (...a: unknown[]): void => {
      lines.push(a.map(String).join(" "));
    };
    try {
      await cmdExecuteChase(
        { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 },
        CFG,
        { yes: false, json: false, pat: "test-pat" },
        { call: (async (name: string) => { calls.push(name); return {}; }) as never },
      );
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(calls, []);
    assert.ok(lines.some((l) => /CHASE PLAN/.test(l)));
    assert.equal(process.exitCode, exitBefore);
  });
});

describe("cmdExecuteChase fire", () => {
  const liveBook = (): {
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    seen: Record<string, unknown>[];
    live: Set<string>;
  } => {
    const seen: Record<string, unknown>[] = [];
    const live = new Set<string>();
    let n = 0;
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === "execute_trade") {
        const id = `o${++n}`;
        seen.push(args);
        live.add(id);
        return { orderId: id };
      }
      if (name === "cancel_order") {
        live.delete(String(args.orderId));
        return {};
      }
      if (name === "list_open_orders") {
        return [...live].map((orderId) => ({ orderId, symbol: "BTC/USDT" }));
      }
      return {};
    };
    return { call, seen, live };
  };

  it("every place and replace carries its own idempotency key", async () => {
    const { call, seen } = liveBook();
    const touches: Touch[] = [T(100, 100.1), T(100.5, 100.6), T(100.5, 100.6), T(100.5, 100.6)];
    let now = 0;
    const origLog = console.log;
    console.log = () => {};
    try {
      await cmdExecuteChase(
        { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01 },
        { enabled: true, secs: 60, pollSecs: 2, take: false },
        { yes: true, json: true, pat: "p" },
        {
          call: call as never,
          touchFn: async () => touches.shift() ?? { bestBid: 100.5, bestAsk: 100.6 },
          sleepMs: async (ms: number) => { now += ms; },
          nowMs: () => now,
          onEvent: () => {},
        },
      );
    } finally {
      console.log = origLog;
    }
    assert.ok(seen.length >= 2, `expected a place plus a replace, got ${seen.length}`);
    const keys = seen.map((a) => String(a.idempotency_key));
    for (const k of keys) assert.match(k, /^jw3-chase-[0-9a-f]{8}$/);
    assert.equal(new Set(keys).size, keys.length, "no two places share a key");
    // Interactive path with no --actor: no actor field, the server resolves
    // the authenticated subject.
    for (const a of seen) assert.equal("actor" in a, false);
  });

  it("forwards the operator actor when given", async () => {
    const { call, seen } = liveBook();
    let now = 0;
    const origLog = console.log;
    console.log = () => {};
    try {
      await cmdExecuteChase(
        { exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: 0.01, actor: "op" },
        { enabled: true, secs: 4, pollSecs: 2, take: false },
        { yes: true, json: true, pat: "p" },
        {
          call: call as never,
          touchFn: async () => ({ bestBid: 100, bestAsk: 100.1 }),
          sleepMs: async (ms: number) => { now += ms; },
          nowMs: () => now,
          onEvent: () => {},
        },
      );
    } finally {
      console.log = origLog;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.actor, "op");
    assert.match(String(seen[0]?.idempotency_key), /^jw3-chase-[0-9a-f]{8}$/);
  });
});
