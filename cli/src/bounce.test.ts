import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BOUNCE_MAX_LOOKBACK_MIN,
  bounceOrderArgs,
  bouncePctOffLow,
  bounceTick,
  bounceTriggered,
  cmdBounce,
  pollsForLookback,
  trackLow,
  triggerPriceForLow,
  validateBounceArgs,
  type BounceArgs,
} from "./bounce.js";

const good: BounceArgs = {
  exchange: "kucoin",
  pair: "SOL/USDT",
  side: "short",
  bouncePct: 0.4,
  lookbackMin: 60,
};

afterEach(() => {
  process.exitCode = 0;
});

describe("validateBounceArgs", () => {
  it("accepts a usable ticket", () => {
    assert.equal(validateBounceArgs(good), null);
  });
  it("accepts a ticket-only run (no size)", () => {
    assert.equal(validateBounceArgs({ ...good, size: undefined }), null);
  });
  it("rejects garbage without inventing", () => {
    assert.ok(validateBounceArgs({ ...good, exchange: "" }));
    assert.ok(validateBounceArgs({ ...good, pair: "" }));
    assert.ok(validateBounceArgs({ ...good, pair: "SOL" }));
    assert.ok(validateBounceArgs({ ...good, side: "sideways" as never }));
    assert.ok(validateBounceArgs({ ...good, bouncePct: 0 }));
    assert.ok(validateBounceArgs({ ...good, bouncePct: -1 }));
    assert.ok(validateBounceArgs({ ...good, bouncePct: NaN }));
    assert.ok(validateBounceArgs({ ...good, bouncePct: 99 }));
    assert.ok(validateBounceArgs({ ...good, lookbackMin: 0 }));
    assert.ok(validateBounceArgs({ ...good, lookbackMin: NaN }));
    assert.ok(validateBounceArgs({ ...good, lookbackMin: BOUNCE_MAX_LOOKBACK_MIN + 1 }));
    assert.ok(validateBounceArgs({ ...good, size: 0 }));
    assert.ok(validateBounceArgs({ ...good, size: -2 }));
  });
});

describe("pollsForLookback", () => {
  it("maps minutes to 3s polls (60min → 1200)", () => {
    assert.equal(pollsForLookback(60), 1200);
    assert.equal(pollsForLookback(1), 20);
  });
  it("bad windows are NaN, never a fake budget", () => {
    assert.ok(Number.isNaN(pollsForLookback(0)));
    assert.ok(Number.isNaN(pollsForLookback(NaN)));
    assert.ok(Number.isNaN(pollsForLookback(-5)));
  });
});

describe("trackLow + bouncePctOffLow + triggerPriceForLow", () => {
  it("low only ratchets down", () => {
    assert.equal(trackLow(0, 100), 100);
    assert.equal(trackLow(100, 99), 99);
    assert.equal(trackLow(99, 99.5), 99);
  });
  it("bad prints never move the low", () => {
    assert.equal(trackLow(99, 0), 99);
    assert.equal(trackLow(99, NaN), 99);
    assert.equal(trackLow(0, 0), 0);
  });
  it("bounce measures the rise off the low", () => {
    const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    assert.ok(approx(bouncePctOffLow(100, 100.4), 0.4));
    assert.ok(approx(bouncePctOffLow(100, 99), -1));
  });
  it("bad legs are NaN, never a fake zero", () => {
    assert.ok(Number.isNaN(bouncePctOffLow(0, 100)));
    assert.ok(Number.isNaN(bouncePctOffLow(100, 0)));
  });
  it("trigger sits bouncePct above the low", () => {
    assert.ok(Math.abs(triggerPriceForLow(100, 0.4) - 100.4) < 1e-9);
    assert.ok(Number.isNaN(triggerPriceForLow(0, 0.4)));
    assert.ok(Number.isNaN(triggerPriceForLow(100, 0)));
  });
});

describe("bounceTriggered boundary", () => {
  it("fires exactly at +0.4%, holds just below", () => {
    assert.equal(bounceTriggered(100, 100.4, 0.4), true);
    assert.equal(bounceTriggered(100, 100.39, 0.4), false);
    assert.equal(bounceTriggered(100, 101, 0.4), true);
  });
  it("never fires into the flush or on bad legs", () => {
    assert.equal(bounceTriggered(100, 99, 0.4), false);
    assert.equal(bounceTriggered(100, 100, 0.4), false);
    assert.equal(bounceTriggered(0, 100, 0.4), false);
    assert.equal(bounceTriggered(100, 0, 0.4), false);
  });
});

describe("bounceTick", () => {
  it("a fresh flush low on the same tick never fires", () => {
    const t = bounceTick(100, 98, 0.4);
    assert.equal(t.low, 98);
    assert.equal(t.bouncePctOff, 0);
    assert.equal(t.fired, false);
  });
  it("fires on the bounce after the low is set", () => {
    const low = bounceTick(100, 98, 0.4).low;
    const t = bounceTick(low, 98.5, 0.4);
    assert.equal(t.low, 98);
    assert.equal(t.fired, true);
  });
  it("ignores bad prints", () => {
    const t = bounceTick(98, 0, 0.4);
    assert.equal(t.low, 98);
    assert.equal(t.fired, false);
  });
});

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = 0;
  }
  return lines;
}

/** Deterministic tape: walks `mids` one step per mark, then holds the last. */
function scriptedMarks(mids: number[]): () => Promise<number> {
  let i = 0;
  return async () => {
    const m = mids[Math.min(i, mids.length - 1)] ?? 0;
    i++;
    return m;
  };
}

const noSleep = async (): Promise<void> => {};

describe("bounceOrderArgs: machine ticket with key", () => {
  it("builds a futures market ticket with key and machine actor", () => {
    const t = bounceOrderArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "short", size: 1200 });
    assert.equal(t.side, "sell");
    assert.equal(t.amount, "1200");
    assert.equal(t.market, "futures");
    assert.equal(t.actor, "machine");
    assert.match(String(t.idempotency_key), /^jw3-bounce-[0-9a-f]{8}$/);
    assert.equal(bounceOrderArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "short", size: 1200 }).idempotency_key, t.idempotency_key);
    assert.notEqual(bounceOrderArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", size: 1200 }).idempotency_key, t.idempotency_key);
    assert.equal(bounceOrderArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "short", size: 1200, idempotencyKey: "k", actor: "op" }).idempotency_key, "k");
  });
});

describe("cmdBounce", () => {
  it("dry run fires WOULD-SHORT on the bounce and never calls", async () => {
    const calls: unknown[] = [];
    const lines = await capture(() =>
      cmdBounce(
        { ...good, lookbackMin: 1 },
        { yes: false, json: false },
        {
          markFn: scriptedMarks([100, 99, 98, 98.5]),
          sleepMs: noSleep,
          call: (async (...a: unknown[]) => {
            calls.push(a);
            return {};
          }) as never,
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes("WOULD-SHORT")), lines.join("\n"));
    assert.equal(calls.length, 0);
  });
  it("never fires into a monotone flush (exhausts the window)", async () => {
    const calls: unknown[] = [];
    const lines = await capture(() =>
      cmdBounce(
        { ...good, lookbackMin: 1 },
        { yes: false, json: false },
        {
          markFn: scriptedMarks(Array.from({ length: 30 }, (_, i) => 100 - i)),
          sleepMs: noSleep,
          call: (async (...a: unknown[]) => {
            calls.push(a);
            return {};
          }) as never,
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes("BOUNCE DONE")), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("WOULD-SHORT")), lines.join("\n"));
    assert.equal(calls.length, 0);
  });
  it("skips tape errors and still fires on the later bounce", async () => {
    let n = 0;
    const lines = await capture(() =>
      cmdBounce(
        { ...good, lookbackMin: 1 },
        { yes: false, json: false },
        {
          markFn: async () => {
            n++;
            if (n === 2) throw new Error("tape down");
            if (n === 3) return 0;
            if (n <= 5) return 100 - n;
            return 98.5;
          },
          sleepMs: noSleep,
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes("tape-error")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("WOULD-SHORT")), lines.join("\n"));
  });
  it("--yes without --size stays ticket-only (nothing sent)", async () => {
    const calls: unknown[] = [];
    const lines = await capture(() =>
      cmdBounce(
        { ...good, lookbackMin: 1 },
        { yes: true, json: false, pat: "test-pat" },
        {
          markFn: scriptedMarks([100, 98, 98.5]),
          sleepMs: noSleep,
          call: (async (...a: unknown[]) => {
            calls.push(a);
            return {};
          }) as never,
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes("ticket only")), lines.join("\n"));
    assert.equal(calls.length, 0);
  });
  it("--yes --size fires a real market sell for the short", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const lines = await capture(() =>
      cmdBounce(
        { ...good, lookbackMin: 1, size: 2 },
        { yes: true, json: false, pat: "test-pat" },
        {
          markFn: scriptedMarks([100, 98, 98.5]),
          sleepMs: noSleep,
          call: (async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return { ok: true };
          }) as never,
        },
      ),
    );
    // OQ-12: runLive's kill-switch + caps gate reads the risk limits once,
    // then the ONE order goes out.
    assert.deepEqual(calls.map((c) => c.name), ["read_risk_limits", "execute_trade"]);
    assert.equal(calls[1]?.args.side, "sell");
    assert.equal(calls[1]?.args.market, "futures");
    assert.equal(calls[1]?.args.actor, "machine");
    assert.match(String(calls[1]?.args.idempotency_key), /^jw3-bounce-[0-9a-f]{8}$/);
    assert.ok(lines.some((l) => l.includes("FIRED SHORT")), lines.join("\n"));
  });
  it("rejects a bad ticket with exit 2 and never polls", async () => {
    let polled = false;
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    process.exitCode = 0;
    try {
      await cmdBounce(
        { ...good, bouncePct: 0 },
        { yes: false, json: false },
        {
          markFn: async () => {
            polled = true;
            return 100;
          },
          sleepMs: noSleep,
        },
      );
      assert.ok(lines.some((l) => l.includes("Bad ticket")), lines.join("\n"));
      assert.equal(polled, false);
      assert.equal(process.exitCode, 2);
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = 0;
    }
  });
});
