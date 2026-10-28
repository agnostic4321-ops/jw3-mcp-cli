import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampInt, flagAny, flagOf, needNum, needNumAny, numAny, numOf, posAny, posOf } from "./args.js";

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

describe("flagAny / numAny / posAny (spelling aliases)", () => {
  it("prefers the primary spelling, falls back to the alias", () => {
    assert.equal(flagAny(["--lev", "2"], "--lev", "--leverage"), "2");
    assert.equal(flagAny(["--leverage", "3"], "--lev", "--leverage"), "3");
    assert.equal(flagAny(["--lev", "2", "--leverage", "3"], "--lev", "--leverage"), "2");
    assert.equal(flagAny([], "--lev", "--leverage"), undefined);
    assert.equal(flagAny(["--tf=15m"], "--tf", "--timeframe"), "15m");
  });
  it("numAny/posAny read either spelling, default when absent", () => {
    assert.equal(numAny([], 20, "--leverage", "--lev"), 20);
    assert.equal(numAny(["--lev", "5"], 20, "--leverage", "--lev"), 5);
    assert.equal(numAny(["--leverage", "7"], 20, "--leverage", "--lev"), 7);
    assert.equal(posAny(["--backoff-pct", "0.1"], 0.08, "--bounceback-pct", "--backoff-pct"), 0.1);
    assert.ok(Number.isNaN(numAny(["--lev", "abc"], 2, "--lev", "--leverage")));
    assert.ok(Number.isNaN(posAny(["--leverage", "0"], 2, "--lev", "--leverage")));
  });
});

describe("needNumAny", () => {
  it("accepts finite values and names the typed spelling on reject", () => {
    const prev = process.exitCode;
    process.exitCode = undefined;
    assert.equal(needNumAny(2, ["--lev", "2"], "--lev", "--leverage"), true);
    assert.equal(process.exitCode, undefined);
    process.exitCode = undefined;
    assert.equal(needNumAny(NaN, ["--leverage", "abc"], "--lev", "--leverage"), false);
    assert.equal(process.exitCode, 2);
    process.exitCode = prev;
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
