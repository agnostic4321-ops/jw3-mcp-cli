// ── `jw3 defi` CLI VALIDATION ──────────────────────────────────────────
//
// This file was written for Vitest (`import { describe, expect, it }
// from "vitest"`) but the package runs its suite with `node --test`,
// and the package has NO vitest config. So the file could not run:
// Vitest's `expect` needs Vitest's runtime, and `node --test` does not
// provide it. The failure was the harness's, not the code's — every
// assertion in this file was sound and the code under test was
// correct.
//
// The port to `node:test` + `node:assert` is the house style here: 60
// of the 62 test files in this package use it, and this one was the
// only Vitest holdout.
//
// The assertions are UNCHANGED in substance. `expect(x).toBeNull()`
// becomes `assert.equal(x, null)`; `expect(x).toContain(s)` becomes
// `assert.ok(String(x).includes(s))` with the message preserved, so a
// failure still says which substring was missing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFI_USAGE, validateDefiBuildArgs } from "./defi.js";

describe("jw3 defi CLI validation", () => {
  it("documents protocols, markets, positions, quote-lp, and build subcommands", () => {
    assert.ok(DEFI_USAGE.includes("jw3 defi protocols"), "the usage must document `jw3 defi protocols`");
    assert.ok(DEFI_USAGE.includes("jw3 defi markets"), "the usage must document `jw3 defi markets`");
    assert.ok(DEFI_USAGE.includes("jw3 defi positions"), "the usage must document `jw3 defi positions`");
    assert.ok(DEFI_USAGE.includes("jw3 defi quote-lp"), "the usage must document `jw3 defi quote-lp`");
    assert.ok(DEFI_USAGE.includes("jw3 defi build"), "the usage must document `jw3 defi build`");
  });

  it("validates supply build arguments and rejects missing wallet or amount", () => {
    assert.equal(
      validateDefiBuildArgs({
        action: "supply",
        investmentId: "aave-v3-eth-usdc",
        walletAddress: "0x1111111111111111111111111111111111111111",
        amount: "250",
        json: true,
      }),
      null,
    );

    const noWallet = validateDefiBuildArgs({
      action: "supply",
      investmentId: "aave-v3-eth-usdc",
      amount: "250",
      json: true,
    });
    assert.ok(
      String(noWallet).includes("--wallet is required"),
      `a missing wallet must be refused, got: ${noWallet}`,
    );

    const noAmount = validateDefiBuildArgs({
      action: "supply",
      investmentId: "aave-v3-eth-usdc",
      walletAddress: "0x1111111111111111111111111111111111111111",
      amount: "0",
      json: true,
    });
    assert.ok(
      String(noAmount).includes("--amount (> 0) is required"),
      `a zero amount must be refused, got: ${noAmount}`,
    );
  });

  it("allows claim without amount and quote_lp without wallet", () => {
    assert.equal(
      validateDefiBuildArgs({
        action: "claim",
        investmentId: "aave-v3-eth-usdc",
        walletAddress: "0x1111111111111111111111111111111111111111",
        json: true,
      }),
      null,
    );
    assert.equal(
      validateDefiBuildArgs({
        action: "quote_lp",
        investmentId: "uniswap-v3-eth-usdc-weth",
        amount: "1000",
        json: true,
      }),
      null,
    );
  });
});
