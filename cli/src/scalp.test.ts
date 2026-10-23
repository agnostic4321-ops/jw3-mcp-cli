import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import {
  classifyScalpMark,
  readScalpState,
  roundToTick,
  scalpContracts,
  scalpStatePath,
  validateScalpStart,
  type ScalpState,
} from "./commands/scalp.js";

describe("validateScalpStart", () => {
  const good = {
    exchange: "kucoin", pair: "SOL/USDT", direction: "long" as const,
    sizeUsd: 15, steps: 3, leverage: 2,
  };
  it("accepts a usable ticket", () => {
    assert.equal(validateScalpStart(good), null);
  });
  it("rejects garbage without inventing", () => {
    assert.ok(validateScalpStart({ ...good, pair: "" }));
    assert.ok(validateScalpStart({ ...good, pair: "SOL" }));
    assert.ok(validateScalpStart({ ...good, direction: "sideways" as never }));
    assert.ok(validateScalpStart({ ...good, sizeUsd: 0 }));
    assert.ok(validateScalpStart({ ...good, sizeUsd: -5 }));
    assert.ok(validateScalpStart({ ...good, steps: 0 }));
    assert.ok(validateScalpStart({ ...good, steps: 4 }));
    assert.ok(validateScalpStart({ ...good, leverage: 0 }));
    assert.ok(validateScalpStart({ ...good, exchange: "" }));
  });
});

describe("scalpContracts", () => {
  it("sizes contracts from notional, at least 1", () => {
    assert.equal(scalpContracts(15, 100, 1), 1); // 0.15 → 1
    assert.equal(scalpContracts(1500, 100, 1), 15);
    assert.equal(scalpContracts(150, 10, 1), 15);
  });
});

describe("roundToTick", () => {
  it("snaps to tick, falls back by magnitude", () => {
    assert.equal(roundToTick(100.37, 0.05), 100.35000000000001);
    assert.equal(roundToTick(100.376, 0), 100.38);
    assert.equal(roundToTick(0.54321, 0), Number((0.54321).toPrecision(5)));
  });
});

describe("classifyScalpMark", () => {
  const long = { direction: "long" as const, tpPrice: 101, killPrice: 98 };
  const short = { direction: "short" as const, tpPrice: 99, killPrice: 102 };
  it("long: TP above, kill below, TP wins ties", () => {
    assert.equal(classifyScalpMark(101.5, long), "tp");
    assert.equal(classifyScalpMark(97, long), "kill");
    assert.equal(classifyScalpMark(100, long), "open");
    assert.equal(classifyScalpMark(101, long), "tp");
    assert.equal(classifyScalpMark(98, long), "kill");
  });
  it("short: mirrored", () => {
    assert.equal(classifyScalpMark(98.5, short), "tp");
    assert.equal(classifyScalpMark(102.5, short), "kill");
    assert.equal(classifyScalpMark(100, short), "open");
  });
  it("bad price never fires", () => {
    assert.equal(classifyScalpMark(NaN, long), "open");
    assert.equal(classifyScalpMark(0, long), "open");
  });
});

describe("scalpStatePath + readScalpState", () => {
  it("names per-base files like grid start", () => {
    assert.equal(scalpStatePath("SOL"), join(tmpdir(), "scalp_sol.json"));
    assert.equal(scalpStatePath("sol"), join(tmpdir(), "scalp_sol.json"));
  });
  it("reads a valid state, refuses missing/malformed", () => {
    const dir = tmpdir();
    const p = join(dir, `scalp_test_${process.pid}.json`);
    const st: ScalpState = {
      kind: "scalp", exchange: "kucoin", pair: "SOL/USDT", base: "SOL",
      direction: "long", leverage: 2, last: 100, avgEntry: 99.5,
      tpPrice: 100, tpProfitUsd: 0.3, killPrice: 98, killLossUsd: 1.5,
      maxCapitalUsd: 60, placed: [], failed: 0, tpArmed: true,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(st));
    assert.equal(readScalpState(p).pair, "SOL/USDT");
    writeFileSync(p, "{not json");
    assert.throws(() => readScalpState(p), /not valid JSON/);
    writeFileSync(p, JSON.stringify({ kind: "grid" }));
    assert.throws(() => readScalpState(p), /malformed/);
    rmSync(p, { force: true });
    assert.throws(() => readScalpState(p), /no scalp state/);
  });
});
