import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampInt, flagOf, needNum, numOf, posOf } from "./args.js";

describe("flagOf", () => {
  it("reads --flag value and --flag=value", () => {
    assert.equal(flagOf(["--pair", "BTC/USDT"], "--pair"), "BTC/USDT");
    assert.equal(flagOf(["--pair=ETH/USDT"], "--pair"), "ETH/USDT");
    assert.equal(flagOf(["--yes"], "--pair"), undefined);
  });
  it("ignores a following flag token", () => {
    assert.equal(flagOf(["--pair", "--yes"], "--pair"), undefined);
  });
});

describe("numOf / posOf", () => {
  it("defaults when absent, parses when present", () => {
    assert.equal(numOf([], "--size", 15), 15);
    assert.equal(numOf(["--size", "20"], "--size", 15), 20);
    assert.equal(posOf([], "--size", 15), 15);
  });
  it("returns NaN on garbage instead of a silent default", () => {
    assert.ok(Number.isNaN(numOf(["--size", "abc"], "--size", 15)));
    assert.ok(Number.isNaN(posOf(["--size", "abc"], "--size", 15)));
  });
  it("posOf rejects non-positive input", () => {
    assert.ok(Number.isNaN(posOf(["--size", "0"], "--size", 15)));
    assert.ok(Number.isNaN(posOf(["--size", "-5"], "--size", 15)));
  });
});

describe("clampInt", () => {
  it("rounds and clamps, passes NaN through for the caller to reject", () => {
    assert.equal(clampInt(200, 1, 100), 100);
    assert.equal(clampInt(0, 1, 100), 1);
    assert.equal(clampInt(2.7, 1, 3), 3);
    assert.ok(Number.isNaN(clampInt(NaN, 1, 100)));
  });
});

describe("needNum", () => {
  it("accepts finite values without touching the exit code", () => {
    const prev = process.exitCode;
    process.exitCode = undefined;
    assert.equal(needNum(15, "--size", []), true);
    assert.equal(process.exitCode, undefined);
    process.exitCode = prev;
  });
  it("rejects NaN loudly with exit code 2", () => {
    const prev = process.exitCode;
    process.exitCode = undefined;
    assert.equal(needNum(NaN, "--size", ["--size", "abc"]), false);
    assert.equal(process.exitCode, 2);
    process.exitCode = prev;
  });
});
