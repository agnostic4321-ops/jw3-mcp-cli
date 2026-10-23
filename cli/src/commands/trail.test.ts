import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import {
  TRAIL_MAX_POLLS,
  drawdownPct,
  favorablePct,
  ratchetPeak,
  readTrailState,
  stopForPeak,
  trailStatePath,
  trailTick,
  validateTrailArgs,
  type TrailArgs,
  type TrailState,
} from "./trail.js";

const good: TrailArgs = {
  exchange: "kucoin",
  pair: "SOL/USDT",
  side: "long",
  size: 1,
  activationPct: 0.25,
  bouncebackPct: 0.08,
  polls: 600,
};

describe("validateTrailArgs", () => {
  it("accepts a usable ticket", () => {
    assert.equal(validateTrailArgs(good), null);
  });
  it("rejects garbage without inventing", () => {
    assert.ok(validateTrailArgs({ ...good, pair: "" }));
    assert.ok(validateTrailArgs({ ...good, pair: "SOL" }));
    assert.ok(validateTrailArgs({ ...good, side: "sideways" as never }));
    assert.ok(validateTrailArgs({ ...good, size: 0 }));
    assert.ok(validateTrailArgs({ ...good, size: -1 }));
    assert.ok(validateTrailArgs({ ...good, activationPct: 0 }));
    assert.ok(validateTrailArgs({ ...good, activationPct: 99 }));
    assert.ok(validateTrailArgs({ ...good, bouncebackPct: 0 }));
    assert.ok(validateTrailArgs({ ...good, bouncebackPct: NaN }));
    assert.ok(validateTrailArgs({ ...good, polls: 0 }));
    assert.ok(validateTrailArgs({ ...good, polls: TRAIL_MAX_POLLS + 1 }));
    assert.ok(validateTrailArgs({ ...good, exchange: "" }));
  });
});

describe("favorablePct", () => {
  it("long up is positive, short mirrors", () => {
    assert.equal(favorablePct(100, 100.25, "long"), 0.25);
    assert.equal(favorablePct(100, 99.75, "long"), -0.25);
    assert.equal(favorablePct(100, 99.75, "short"), 0.25);
    assert.equal(favorablePct(100, 100.25, "short"), -0.25);
  });
  it("bad legs are NaN, never a fake zero", () => {
    assert.ok(Number.isNaN(favorablePct(0, 100, "long")));
    assert.ok(Number.isNaN(favorablePct(100, 0, "short")));
  });
});

describe("ratchetPeak + stopForPeak + drawdownPct", () => {
  it("peak only moves favorably", () => {
    assert.equal(ratchetPeak(100, 101, "long"), 101);
    assert.equal(ratchetPeak(100, 99, "long"), 100);
    assert.equal(ratchetPeak(100, 99, "short"), 99);
    assert.equal(ratchetPeak(100, 101, "short"), 100);
  });
  it("stop sits bounceback off the peak on the right side", () => {
    assert.equal(stopForPeak(100, 0.08, "long"), 100 * (1 - 0.0008));
    assert.equal(stopForPeak(100, 0.08, "short"), 100 * (1 + 0.0008));
  });
  it("drawdown measures the adverse bounce", () => {
    assert.equal(drawdownPct(100.25, 100.17, "long").toFixed(4), (((100.25 - 100.17) / 100.25) * 100).toFixed(4));
    assert.equal(drawdownPct(99.75, 99.83, "short").toFixed(4), (((99.83 - 99.75) / 99.75) * 100).toFixed(4));
  });
});

describe("trailTick", () => {
  it("stays unarmed below activation and never closes", () => {
    const t = trailTick(100, 100, false, 100.1, "long", 0.25, 0.08);
    assert.equal(t.armed, false);
    assert.equal(t.stop, null);
    assert.equal(t.close, false);
  });
  it("arms exactly at +0.25% favorable", () => {
    const t = trailTick(100, 100, false, 100.25, "long", 0.25, 0.08);
    assert.equal(t.armed, true);
    assert.equal(t.close, false);
    assert.ok(t.stop !== null && t.stop < 100.25);
  });
  it("closes on 0.08% bounceback off the peak (long)", () => {
    // Entry 100, peak 100.30 (armed), now 100.21 = 0.0897% off peak → trigger.
    const t = trailTick(100, 100.3, true, 100.21, "long", 0.25, 0.08);
    assert.equal(t.armed, true);
    assert.equal(t.close, true);
  });
  it("holds inside the bounceback band (long)", () => {
    // 100.30 peak → 100.25 is 0.0499% off → no close.
    const t = trailTick(100, 100.3, true, 100.25, "long", 0.25, 0.08);
    assert.equal(t.close, false);
  });
  it("mirrors for shorts", () => {
    const arm = trailTick(100, 100, false, 99.75, "short", 0.25, 0.08);
    assert.equal(arm.armed, true);
    const shut = trailTick(100, 99.7, true, 99.79, "short", 0.25, 0.08);
    assert.equal(shut.close, true);
    const hold = trailTick(100, 99.7, true, 99.75, "short", 0.25, 0.08);
    assert.equal(hold.close, false);
  });
  it("ratchets: peak never slides back", () => {
    const up = trailTick(100, 100.3, true, 100.4, "long", 0.25, 0.08);
    assert.equal(up.peak, 100.4);
    const down = trailTick(100, 100.4, true, 100.35, "long", 0.25, 0.08);
    assert.equal(down.peak, 100.4);
  });
});

describe("trailStatePath + readTrailState", () => {
  it("names per-base files like scalp/grid", () => {
    assert.equal(trailStatePath("SOL"), join(tmpdir(), "trail_sol.json"));
    assert.equal(trailStatePath("sol"), join(tmpdir(), "trail_sol.json"));
  });
  it("reads a valid state, refuses missing/malformed", () => {
    const p = join(tmpdir(), `trail_test_${process.pid}.json`);
    const st: TrailState = {
      kind: "trail", exchange: "kucoin", pair: "SOL/USDT", base: "SOL",
      side: "long", size: 1, activationPct: 0.25, bouncebackPct: 0.08,
      entry: 100, peak: 100.3, armed: true, stop: 100.2198,
      pollsDone: 10, maxPolls: 600, mode: "dry",
      triggered: false, closed: false, closePrice: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(st));
    assert.equal(readTrailState(p).pair, "SOL/USDT");
    writeFileSync(p, "{not json");
    assert.throws(() => readTrailState(p), /not valid JSON/);
    writeFileSync(p, JSON.stringify({ kind: "grid" }));
    assert.throws(() => readTrailState(p), /malformed/);
    rmSync(p, { force: true });
    assert.throws(() => readTrailState(p), /no trail state/);
  });
});
