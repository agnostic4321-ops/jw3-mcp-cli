/**
 * `jw3 paper` command tests — full lifecycle through a temp store file.
 * No network: paper commands never leave the process (the guard test
 * enforces that statically too).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdPaperCreate,
  cmdPaperExecute,
  cmdPaperFills,
  cmdPaperFund,
  cmdPaperList,
  cmdPaperPnl,
  cmdPaperPositions,
  cmdPaperPromote,
  cmdPaperReset,
  cmdPaperTick,
  paperSideOf,
  promoteTicket,
} from "./paper.js";
import { loadPaperStore } from "../paper-store.js";

let dir = "";
let storePath = "";
let logs: string[] = [];
let errors: string[] = [];
let realLog: typeof console.log;
let realError: typeof console.error;
let realExitCode: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jw3-paper-cmd-"));
  storePath = join(dir, "paper-accounts.json");
  logs = [];
  errors = [];
  realLog = console.log;
  realError = console.error;
  realExitCode = process.exitCode;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = realExitCode;
});

const lastJson = (): unknown => JSON.parse(logs[logs.length - 1] as string);
const fileText = (): string | null => {
  try {
    return readFileSync(storePath, "utf8");
  } catch {
    return null;
  }
};

async function setupFunded(tag = "mom"): Promise<string> {
  await cmdPaperCreate({ name: "desk", equityUsd: 10000, json: true, storePath });
  logs.length = 0;
  await cmdPaperExecute({
    account: "desk", pair: "SOL/USDT", side: "buy", qty: 2, price: 100,
    leverage: 2, tp: 110, sl: 95, fee: "taker", strategy: tag, json: true, storePath,
  });
  logs.length = 0;
  const store = loadPaperStore(storePath);
  return store.accounts["desk"]!.positions[0]!.id;
}

describe("paperSideOf + promoteTicket (pure)", () => {
  it("buy→long, sell→short, garbage→null", () => {
    assert.equal(paperSideOf("buy"), "long");
    assert.equal(paperSideOf("SELL"), "short");
    assert.equal(paperSideOf("long"), null);
  });

  it("promote renders a live-shaped ticket that is explicitly unsent", () => {
    const t = promoteTicket(
      {
        id: "paper-pos-1", pair: "SOL/USDT", side: "short", qty: 3, entryPrice: 100,
        leverage: 2, marginLockedUsd: 150, tp: 90, sl: 105, strategy: "fade-a",
        feeTier: "taker", openedAt: new Date().toISOString(),
      },
      "kucoin",
    );
    assert.equal(t.toolArgs.side, "sell");
    assert.equal(t.toolArgs.amount, 3);
    assert.equal(t.toolArgs.market, "futures");
    assert.equal(t.toolArgs.stop, 105);
    assert.equal(t.toolArgs.tp, 90);
    assert.match(t.argv, /jw3 execute.*--yes/);
    assert.match(t.argv, /--side sell/);
  });
});

describe("account commands", () => {
  it("create → fund → list → reset lifecycle", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 1000, json: false, storePath });
    assert.match(logs.join("\n"), /created with \$1000\.00/);
    await cmdPaperFund({ name: "desk", amountUsd: 250, json: true, storePath });
    assert.equal((lastJson() as { cashUsd: number }).cashUsd, 1250);
    await cmdPaperList({ json: true, storePath });
    const listed = lastJson() as { accounts: { account: string; cashUsd: number }[] };
    assert.equal(listed.accounts[0]?.account, "desk");
    await cmdPaperReset({ name: "desk", json: true, storePath });
    assert.equal((lastJson() as { cashUsd: number }).cashUsd, 1000);
  });

  it("duplicate create exits 2 and leaves the book untouched", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 1000, json: true, storePath });
    const before = fileText();
    logs.length = 0;
    await cmdPaperCreate({ name: "desk", equityUsd: 1000, json: true, storePath });
    assert.equal(process.exitCode, 2);
    assert.match(errors.join("\n"), /already exists/);
    assert.equal(fileText(), before);
  });

  it("bad inputs exit 2 and write nothing", async () => {
    await cmdPaperCreate({ name: "bad name!", equityUsd: 100, json: true, storePath });
    assert.equal(process.exitCode, 2);
    assert.equal(fileText(), null);
    await cmdPaperCreate({ name: "desk", equityUsd: -5, json: true, storePath });
    assert.equal(process.exitCode, 2);
    assert.equal(fileText(), null);
  });

  it("list with no accounts says how to start", async () => {
    await cmdPaperList({ json: false, storePath });
    assert.match(logs.join("\n"), /create one/);
  });
});

describe("paper execute", () => {
  it("opens a simulated position with margin lock + fee", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 10000, json: true, storePath });
    logs.length = 0;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "buy", qty: 2, price: 100,
      leverage: 2, tp: 110, sl: 95, fee: "taker", strategy: "Mom", json: true, storePath,
    });
    const out = lastJson() as { position: { strategy: string | null; marginLockedUsd: number } };
    assert.equal(out.position.strategy, "mom");
    const store = loadPaperStore(storePath);
    const a = store.accounts["desk"]!;
    assert.equal(a.positions.length, 1);
    // margin 200/2=100 + taker fee 200*0.06%=0.12
    assert.equal(a.cashUsd, 10000 - 100 - 0.12);
  });

  it("maker and taker fees differ on identical fills", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 100000, json: true, storePath });
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "buy", qty: 10, price: 100,
      leverage: 1, fee: "maker", json: true, storePath,
    });
    const makerFee = (lastJson() as { feeUsd: number }).feeUsd;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "buy", qty: 10, price: 100,
      leverage: 1, fee: "taker", json: true, storePath,
    });
    const takerFee = (lastJson() as { feeUsd: number }).feeUsd;
    assert.equal(makerFee, 0.2);
    assert.equal(takerFee, 0.6);
  });

  it("--size-usd derives qty from price", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 10000, json: true, storePath });
    logs.length = 0;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "sell", sizeUsd: 200, price: 100,
      leverage: 1, fee: "taker", json: true, storePath,
    });
    assert.equal((lastJson() as { position: { qty: number } }).position.qty, 2);
  });

  it("bad tickets exit 2 and write nothing", async () => {
    await cmdPaperCreate({ name: "desk", equityUsd: 10000, json: true, storePath });
    const before = fileText();
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "hold", qty: 1, price: 100,
      leverage: 1, json: true, storePath,
    });
    assert.equal(process.exitCode, 2);
    process.exitCode = undefined;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "buy", qty: 1, price: 100,
      leverage: 1, fee: "free", json: true, storePath,
    });
    assert.equal(process.exitCode, 2);
    process.exitCode = undefined;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "buy", qty: 1, price: 100,
      leverage: 1, tp: 90, json: true, storePath,
    });
    assert.equal(process.exitCode, 2);
    assert.equal(fileText(), before);
    assert.equal(loadPaperStore(storePath).accounts["desk"]?.positions.length, 0);
  });
});

describe("paper tick settlement", () => {
  it("TP leg fills at the tp level with net pnl", async () => {
    const pid = await setupFunded();
    await cmdPaperTick({ pair: "SOL/USDT", price: 112, json: true, storePath });
    const out = lastJson() as { settled: { kind: string; fillPrice: number; pnlUsd: number }[] };
    assert.equal(out.settled.length, 1);
    assert.equal(out.settled[0]?.kind, "tp");
    assert.equal(out.settled[0]?.fillPrice, 110);
    // gross (110-100)*2=20 minus exit fee on 220 notional @0.06% = 0.13
    assert.equal(out.settled[0]?.pnlUsd, 20 - 0.13);
    const store = loadPaperStore(storePath);
    assert.equal(store.accounts["desk"]?.positions.length, 0);
    assert.equal(store.accounts["desk"]?.fills.at(-1)?.kind, "tp");
    void pid;
  });

  it("SL leg fills at the sl level", async () => {
    await setupFunded();
    await cmdPaperTick({ account: "desk", pair: "SOL/USDT", price: 90, json: true, storePath });
    const out = lastJson() as { settled: { kind: string; fillPrice: number }[] };
    assert.equal(out.settled[0]?.kind, "sl");
    assert.equal(out.settled[0]?.fillPrice, 95);
  });

  it("a no-touch tick writes nothing", async () => {
    await setupFunded();
    const before = fileText();
    await cmdPaperTick({ pair: "SOL/USDT", price: 100, json: false, storePath });
    assert.match(logs.join("\n"), /no virtual legs touched/);
    assert.equal(fileText(), before);
  });

  it("unknown account exits 2 without writing", async () => {
    await cmdPaperTick({ account: "ghost", pair: "SOL/USDT", price: 200, json: true, storePath });
    assert.equal(process.exitCode, 2);
    assert.equal(fileText(), null);
  });
});

describe("reads: positions / fills / pnl", () => {
  it("strategy filter scopes positions and fills", async () => {
    await setupFunded("mom");
    logs.length = 0;
    await cmdPaperExecute({
      account: "desk", pair: "SOL/USDT", side: "sell", qty: 1, price: 100,
      leverage: 1, fee: "taker", strategy: "fade", json: true, storePath,
    });
    await cmdPaperPositions({ account: "desk", strategy: "fade", json: true, storePath });
    const held = lastJson() as { positions: { position: { strategy: string } }[] };
    assert.equal(held.positions.length, 1);
    assert.equal(held.positions[0]?.position.strategy, "fade");
    await cmdPaperFills({ account: "desk", strategy: "mom", json: true, storePath });
    const fills = lastJson() as { fills: { fill: { strategy: string } }[] };
    assert.ok(fills.fills.length >= 1);
    assert.ok(fills.fills.every((r) => r.fill.strategy === "mom"));
  });

  it("--mark needs --pair", async () => {
    await setupFunded();
    await cmdPaperPositions({ account: "desk", mark: 105, json: true, storePath });
    assert.equal(process.exitCode, 2);
  });

  it("--mark values unrealized for the pair", async () => {
    await setupFunded();
    await cmdPaperPositions({ account: "desk", pair: "sol/usdt", mark: 105, json: true, storePath });
    const out = lastJson() as { positions: { unrealized: number }[] };
    assert.equal(out.positions[0]?.unrealized, 10);
  });

  it("pnl reports realized, fees, and per-strategy breakdown", async () => {
    await setupFunded("mom");
    await cmdPaperTick({ pair: "SOL/USDT", price: 112, json: true, storePath });
    logs.length = 0;
    await cmdPaperPnl({ account: "desk", json: true, storePath });
    const out = lastJson() as {
      accounts: { realizedPnlUsd: number; totalFeesUsd: number; openPositions: number; byStrategy: Record<string, { realizedPnlUsd: number; fills: number }> }[];
    };
    assert.equal(out.accounts[0]?.openPositions, 0);
    assert.equal(out.accounts[0]?.realizedPnlUsd, 20 - 0.13);
    // entry fee 0.12 + exit fee 0.13
    assert.equal(out.accounts[0]?.totalFeesUsd, 0.12 + 0.13);
    assert.equal(out.accounts[0]?.byStrategy["mom"]?.fills, 1);
  });
});

describe("paper promote", () => {
  it("renders the live ticket, sends nothing, writes nothing", async () => {
    const pid = await setupFunded();
    const before = fileText();
    await cmdPaperPromote({ account: "desk", positionId: pid, json: true, storePath });
    const out = lastJson() as { sent: boolean; tickets: { argv: string }[] };
    assert.equal(out.sent, false);
    assert.equal(out.tickets.length, 1);
    assert.match(out.tickets[0]?.argv ?? "", /--stop 95/);
    assert.match(out.tickets[0]?.argv ?? "", /--tp 110/);
    assert.equal(fileText(), before);
  });

  it("no match exits 2 with no ticket", async () => {
    await setupFunded();
    await cmdPaperPromote({ account: "desk", positionId: "paper-pos-999", json: true, storePath });
    assert.equal(process.exitCode, 2);
    assert.match(errors.join("\n"), /no open paper position matches/);
  });
});
