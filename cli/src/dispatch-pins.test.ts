/**
 * Dispatch characterization pins (C10-09): the ROUTES table must keep the
 * exact user-visible surface — same flags, output shape and exit codes.
 * Every case fails before any network call (auth guard or pure
 * validation) or prints static text, so this suite is hermetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "./test-fixtures.js";

describe("dispatch pins (table-driven index.ts)", () => {
  it("--help exits 0 and prints the command list", () => {
    const r = runCli(["--help"]);
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /jw3 — JW3\.ai command line/);
    assert.match(r.stdout, /jw3 execute --exchange/);
  });

  it("unknown command exits 2 with the help text", () => {
    const r = runCli(["frobnicate", "xyz"]);
    assert.equal(r.exit, 2);
    assert.match(r.stderr, /Unknown command: frobnicate xyz/);
    assert.match(r.stderr, /jw3 — JW3\.ai command line/);
  });

  it("fund-moving commands fail closed without auth (exit 1, nothing sent)", () => {
    for (const args of [
      ["execute", "--exchange", "kucoin", "--pair", "BTC/USDT", "--side", "buy", "--amount", "1", "--yes"],
      ["close", "--exchange", "kucoin", "--pair", "BTC/USDT", "--side", "long", "--yes"],
      ["exits", "--exchange", "kucoin", "--pair", "BTC/USDT", "--sl", "1", "--yes"],
      ["cancel", "--exchange", "kucoin", "--order-id", "abc", "--yes"],
      ["cancel-all", "--exchange", "kucoin", "--pair", "BTC/USDT", "--yes"],
    ]) {
      const r = runCli(args);
      assert.equal(r.exit, 1, args.join(" "));
      assert.match(r.stderr, /Not authenticated/, args.join(" "));
    }
  });

  it("market reads fail closed without auth (exit 1)", () => {
    for (const args of [
      ["market", "--exchange", "binance", "--pair", "BTC/USDT"],
      ["screener"],
      ["balances"],
      ["orders", "--exchange", "kucoin"],
      ["onchain"],
      ["connections"],
      ["diary", "--day", "2026-01-01"],
      ["risk"],
      ["news", "--pair", "BTC"],
      ["propose", "--pair", "BTC/USDT", "--side", "long", "--entry", "1", "--stop", "2"],
      ["fills", "--exchange", "kucoin"],
      ["pnl", "--exchange", "kucoin"],
    ]) {
      const r = runCli(args);
      assert.equal(r.exit, 1, args.join(" "));
      assert.match(r.stderr, /Not authenticated/, args.join(" "));
    }
  });

  it("pure validation fails before auth (exit 2)", () => {
    const r = runCli(["positions", "--pair", "   "]);
    assert.equal(r.exit, 2);
    assert.match(r.stderr, /Usage: jw3 positions/);
  });

  it("space forms route to the same handlers", () => {
    const hyphen = runCli(["cancel-all", "--exchange", "kucoin", "--pair", "BTC/USDT", "--yes"]);
    const spaced = runCli(["cancel", "all", "--exchange", "kucoin", "--pair", "BTC/USDT", "--yes"]);
    assert.equal(hyphen.exit, spaced.exit);
    assert.equal(hyphen.stderr, spaced.stderr);
  });

  it("HELP version is single-sourced from cli/package.json (cannot drift)", () => {
    const r = runCli(["--help"]);
    assert.equal(r.exit, 0);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.match(r.stdout, new RegExp(`jw3 — JW3\\.ai command line \\(v${pkg.version.replace(/\./g, "\\.")}\\)`));
  });

  it("removed supervise falls through to the normal unknown-command help", () => {
    const r = runCli(["supervise", "--trail", "SOL/USDT:long:1"]);
    assert.equal(r.exit, 2);
    assert.match(r.stderr, /Unknown command: supervise/);
    assert.match(r.stderr, /jw3 — JW3\.ai command line/);
    assert.ok(!r.stderr.includes("jw3 supervise --trail"), "help must not advertise the deleted command");
  });

  it("retired OQ-09 commands fall through to the normal unknown-command help", () => {
    const retired: [string[], string][] = [
      [["vote", "--pair", "SOL/USDT"], "Unknown command: vote"],
      [["vote", "stats"], "Unknown command: vote stats"],
      [["vote", "record", "--pair", "SOL/USDT", "--outcome", "long"], "Unknown command: vote record"],
      [["oracle", "--pair", "SOL/USDT"], "Unknown command: oracle"],
      [["committee", "--pair", "SOL/USDT"], "Unknown command: committee"],
      [["score", "stats"], "Unknown command: score stats"],
      [["score", "report"], "Unknown command: score report"],
      [["score", "record", "--pair", "SOL/USDT"], "Unknown command: score record"],
      [["harness"], "Unknown command: harness"],
    ];
    for (const [args, want] of retired) {
      const r = runCli(args);
      assert.equal(r.exit, 2, args.join(" "));
      assert.ok(r.stderr.includes(want), `${args.join(" ")}: want ${JSON.stringify(want)}`);
      assert.match(r.stderr, /jw3 — JW3\.ai command line/, args.join(" "));
    }
    const help = runCli(["--help"]).stdout;
    for (const line of ["jw3 vote ", "jw3 vote stats", "jw3 oracle ", "jw3 committee ", "jw3 score ", "jw3 harness"]) {
      assert.ok(!help.includes(line), `help must not advertise the retired command: ${line}`);
    }
  });
});
