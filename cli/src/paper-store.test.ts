/**
 * paper-store tests — pure account math + file round-trip. No network,
 * no trades (there is no transport to call).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePaperPosition,
  createPaperAccount,
  emptyStore,
  fundPaperAccount,
  getAccount,
  loadPaperStore,
  lockedMarginUsd,
  normalizePaperPair,
  openPaperPosition,
  resetPaperAccount,
  savePaperStore,
  validateAccountName,
  validatePaperPair,
  validateStrategyTag,
  type PaperStore,
} from "./paper-store.js";
import { grossPnlUsd } from "./paper-marks.js";

let dir = "";
let store: PaperStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jw3-paper-store-"));
  store = emptyStore();
});

afterEach(() => {
  // Store files live in the temp dir; nothing to clean beyond it.
});

const openLong = (s: PaperStore, account: string, over: Record<string, unknown> = {}) =>
  openPaperPosition(s, account, {
    pair: "SOL/USDT",
    side: "long",
    qty: 1,
    price: 100,
    leverage: 2,
    feeUsd: 0.06,
    feeTier: "taker",
    ...over,
  } as Parameters<typeof openPaperPosition>[2]);

describe("validators", () => {
  it("account names are bounded and filesystem-safe", () => {
    assert.equal(validateAccountName("desk-1"), null);
    assert.equal(validateAccountName("A"), null);
    assert.match(validateAccountName("") as string, /account must match/);
    assert.match(validateAccountName("../evil") as string, /account must match/);
    assert.match(validateAccountName("has space") as string, /account must match/);
  });

  it("pairs must be BASE/USDT", () => {
    assert.equal(validatePaperPair("SOL/USDT"), null);
    assert.equal(validatePaperPair("sol/usdt"), null);
    assert.match(validatePaperPair("SOL") as string, /pair required/);
    assert.match(validatePaperPair("SOL/ETH") as string, /pair required/);
  });

  it("strategy tags are bounded, lowercase-normalized on write", () => {
    assert.equal(validateStrategyTag(undefined), null);
    assert.equal(validateStrategyTag("Fade-A_1"), null);
    assert.match(validateStrategyTag("has space") as string, /strategy tag/);
    assert.match(validateStrategyTag("x".repeat(41)) as string, /strategy tag/);
  });

  it("normalizePaperPair uppercases", () => {
    assert.equal(normalizePaperPair("sol/usdt"), "SOL/USDT");
  });
});

describe("account lifecycle", () => {
  it("create → fund → reset round-trips cash", () => {
    assert.equal(createPaperAccount(store, "desk", 1000), null);
    assert.equal(store.accounts["desk"]?.cashUsd, 1000);
    assert.equal(fundPaperAccount(store, "desk", 250), null);
    assert.equal(store.accounts["desk"]?.cashUsd, 1250);
    assert.equal(resetPaperAccount(store, "desk"), null);
    const a = getAccount(store, "desk");
    assert.equal(a?.cashUsd, 1000);
    assert.equal(a?.realizedPnlUsd, 0);
    assert.deepEqual(a?.positions, []);
    assert.deepEqual(a?.fills, []);
  });

  it("create rejects duplicates and bad equity without mutating", () => {
    assert.equal(createPaperAccount(store, "desk", 1000), null);
    assert.match(createPaperAccount(store, "desk", 1000) as string, /already exists/);
    assert.match(createPaperAccount(store, "bad!", 1000) as string, /account must match/);
    assert.match(createPaperAccount(store, "zero", 0) as string, /equity must be/);
    assert.equal(Object.keys(store.accounts).length, 1);
  });

  it("fund/reset reject unknown accounts", () => {
    assert.match(fundPaperAccount(store, "nope", 10) as string, /unknown account/);
    assert.match(fundPaperAccount(store, "nope", -5) as string, /unknown account/);
    assert.match(resetPaperAccount(store, "nope") as string, /unknown account/);
  });

  it("reset keeps the id sequence (no id reuse across the fresh book)", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    const r1 = openLong(store, "desk");
    assert.ok(r1.position);
    const firstId = r1.position.id;
    assert.equal(resetPaperAccount(store, "desk"), null);
    const r2 = openLong(store, "desk");
    assert.ok(r2.position && r2.position.id !== firstId);
  });
});

describe("openPaperPosition", () => {
  it("locks margin + fee, appends position and open fill", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    const r = openPaperPosition(store, "desk", {
      pair: "sol/usdt",
      side: "long",
      qty: 2,
      price: 100,
      leverage: 2,
      feeUsd: 0.12,
      feeTier: "taker",
      tp: 110,
      sl: 95,
      strategy: "Fade-A",
    });
    assert.ok(r.position);
    assert.equal(r.position.pair, "SOL/USDT");
    assert.equal(r.position.strategy, "fade-a");
    const a = getAccount(store, "desk");
    // margin 200/2=100 + fee 0.12
    assert.equal(a?.cashUsd, 10000 - 100 - 0.12);
    assert.equal(a?.totalFeesUsd, 0.12);
    assert.equal(a?.positions.length, 1);
    assert.equal(a?.fills.length, 1);
    assert.equal(a?.fills[0]?.kind, "open");
    assert.equal(a?.fills[0]?.side, "buy");
    assert.equal(lockedMarginUsd(a!), 100);
  });

  it("insufficient cash rejects with no mutation", () => {
    assert.equal(createPaperAccount(store, "desk", 10), null);
    const before = JSON.stringify(store);
    const r = openLong(store, "desk");
    assert.match(r.error as string, /insufficient paper cash/);
    assert.equal(JSON.stringify(store), before);
  });

  it("TP/SL must sit on the correct side of entry", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    assert.match(openLong(store, "desk", { tp: 90 }).error as string, /profit side/);
    assert.match(openLong(store, "desk", { sl: 110 }).error as string, /loss side/);
    assert.match(
      openPaperPosition(store, "desk", {
        pair: "SOL/USDT", side: "short", qty: 1, price: 100, leverage: 2, feeUsd: 0, feeTier: "maker", tp: 110,
      }).error as string,
      /profit side/,
    );
    assert.match(
      openPaperPosition(store, "desk", {
        pair: "SOL/USDT", side: "short", qty: 1, price: 100, leverage: 2, feeUsd: 0, feeTier: "maker", sl: 90,
      }).error as string,
      /loss side/,
    );
    assert.equal(store.accounts["desk"]?.positions.length, 0);
  });
});

describe("closePaperPosition", () => {
  it("long winner: margin unlocks, realized nets the exit fee", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    const r = openLong(store, "desk", { qty: 2, price: 100, leverage: 2, feeUsd: 0.12 });
    const pid = r.position!.id;
    const c = closePaperPosition(store, "desk", pid, { price: 110, feeUsd: 0.13, feeTier: "taker", kind: "close" }, grossPnlUsd);
    assert.ok(c.fill);
    // gross (110-100)*2=20, net 19.87
    assert.equal(c.fill.pnlUsd, 20 - 0.13);
    assert.equal(c.fill.side, "sell");
    const a = getAccount(store, "desk");
    assert.equal(a?.positions.length, 0);
    assert.equal(a?.realizedPnlUsd, 20 - 0.13);
    assert.equal(a?.totalFeesUsd, 0.12 + 0.13);
    // cash: 10000 - 100 - 0.12 + 100 + 20 - 0.13
    assert.ok(Math.abs((a?.cashUsd as number) - (10000 - 0.12 + 20 - 0.13)) < 1e-9);
  });

  it("short loser books a negative fill", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    const r = openPaperPosition(store, "desk", {
      pair: "SOL/USDT", side: "short", qty: 1, price: 100, leverage: 1, feeUsd: 0.06, feeTier: "taker",
    });
    const c = closePaperPosition(store, "desk", r.position!.id, { price: 110, feeUsd: 0.07, feeTier: "taker", kind: "sl" }, grossPnlUsd);
    assert.equal(c.fill?.pnlUsd, -10 - 0.07);
    assert.equal(c.fill?.kind, "sl");
    assert.equal(getAccount(store, "desk")?.realizedPnlUsd, -10 - 0.07);
  });

  it("unknown position and bad price reject with no mutation", () => {
    assert.equal(createPaperAccount(store, "desk", 10000), null);
    openLong(store, "desk");
    const before = JSON.stringify(store);
    assert.match(closePaperPosition(store, "desk", "paper-pos-999", { price: 100, feeUsd: 0, feeTier: "taker", kind: "close" }, grossPnlUsd).error as string, /unknown position/);
    const pid = store.accounts["desk"]!.positions[0]!.id;
    assert.match(closePaperPosition(store, "desk", pid, { price: -1, feeUsd: 0, feeTier: "taker", kind: "close" }, grossPnlUsd).error as string, /price must be/);
    assert.equal(JSON.stringify(store), before);
  });
});

describe("persistence", () => {
  it("save → load round-trips the book", () => {
    assert.equal(createPaperAccount(store, "desk", 5000), null);
    openLong(store, "desk", { strategy: "mom" });
    const path = join(dir, "paper-accounts.json");
    savePaperStore(path, store);
    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"desk"/);
    const back = loadPaperStore(path);
    assert.equal(back.accounts["desk"]?.cashUsd, store.accounts["desk"]?.cashUsd);
    assert.equal(back.accounts["desk"]?.positions.length, 1);
    assert.equal(back.accounts["desk"]?.positions[0]?.strategy, "mom");
  });

  it("missing or corrupt files load empty (never throw)", () => {
    assert.deepEqual(loadPaperStore(join(dir, "does-not-exist.json")), emptyStore());
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(loadPaperStore(bad), emptyStore());
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ accounts: null }));
    assert.deepEqual(loadPaperStore(wrong), emptyStore());
  });

  it("writes the book 0600 under a 0700 dir", () => {
    assert.equal(createPaperAccount(store, "desk", 5000), null);
    const path = join(dir, "sub", "paper-accounts.json");
    savePaperStore(path, store);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
  });
});
