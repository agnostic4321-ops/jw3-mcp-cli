/**
 * `jw3 degen` tests — pure governor/screen/averaging math plus dry-run
 * parity for the unified loop. No network: every venue/oracle call is
 * injected. No trades.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEGEN_FINETUNE_AT,
  DEGEN_PAPER_ACCOUNT,
  appendLearning,
  averagedEntry,
  averagedTpPrice,
  cmdDegen,
  cmdDegenRecord,
  cmdDegenRecordPaper,
  cmdPaperStats,
  degenExecuteArgs,
  degenExitsArgs,
  degenLogPath,
  degenRunPath,
  ensureDegenPaperAccount,
  migrateDegenPaperOnce,
  paperHeatOf,
  paperProposeArgs,
  rowSignals,
  screenRow,
  summarizePaperAccount,
  validateDegenArgs,
  type DegenArgs,
  type PaperStats,
} from "./degen.js";
import {
  degenHeatPath,
  defaultHeat,
  effectiveSize,
  loadHeat,
  type DegenHeat,
} from "./heat.js";
import {
  getAccount,
  loadPaperStore,
  savePaperStore,
  type PaperAccount,
} from "../paper-store.js";
import { ensureDir, makeSandbox } from "../test-fixtures.js";
import type { FadeRow } from "../kucoin.js";
import type { TradeCall } from "./trade.js";

const row = (over: Partial<FadeRow> = {}): FadeRow => ({
  symbol: "SOLUSDTM",
  last: 100,
  chg: 4,
  vratio: 0.5,
  vslope: "down",
  offHighPct: 2,
  offLowPct: 20,
  atrPct: 0.8,
  fundingPct: null,
  n: 60,
  ...over,
});

const args = (over: Partial<DegenArgs> = {}): DegenArgs => ({
  exchange: "kucoin",
  sizeUsd: 15,
  leverage: 2,
  maxHeatUsd: 6,
  maxConcurrent: 2,
  activationPct: 0.25,
  bouncebackPct: 0.08,
  polls: 600,
  horizon: 12,
  trail: false,
  live: false,
  ...over,
  paper: over.paper ?? false,
});

type Call = { name: string; args: Record<string, unknown> };
const spyCall = (calls: Call[], script?: (c: Call) => unknown): TradeCall =>
  (async (name: string, a: Record<string, unknown>) => {
    const c = { name, args: a };
    calls.push(c);
    if (script) return script(c);
    if (name === "list_open_orders") return [];
    if (name === "execute_trade") return { orderId: `oid-${calls.length}` };
    return {};
  }) as TradeCall;

const isFundMoving = (c: Call): boolean =>
  c.name === "execute_trade" || c.name === "close_position" || c.name === "set_exits" || c.name === "cancel_order";

let logs: string[];
let errs: string[];
let logFn: typeof console.log;
let errFn: typeof console.error;
let sandbox: string;
let cleanupSandbox: () => void;

beforeEach(() => {
  logs = [];
  errs = [];
  logFn = console.log;
  errFn = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  process.exitCode = undefined;
  const sb = makeSandbox("degen-test-");
  sandbox = sb.dir;
  cleanupSandbox = sb.cleanup;
});

afterEach(() => {
  console.log = logFn;
  console.error = errFn;
  process.exitCode = undefined;
  cleanupSandbox();
});

const paths = () => ({
  heatPath: join(sandbox, "degen-heat.json"),
  logPath: join(sandbox, "degen-learning.jsonl"),
  runDir: join(sandbox, "runs"),
  storePath: join(sandbox, "vote.json"),
  paperPath: join(sandbox, "paper-accounts.json"),
});

const longOracle = async () => ({ side: "long" as const, score: 0.7, detail: "laya long" });
const shortOracle = async () => ({ side: "short" as const, score: -0.7, detail: "laya short" });
const flatOracle = async () => ({ side: "flat" as const, score: 0.02, detail: "no consensus" });
const spec = async () => ({ multiplier: 1, tick: 0.01 });

describe("validateDegenArgs", () => {
  it("rejects bad pair, size, and polls with exit-2-class reasons", () => {
    assert.match(String(validateDegenArgs(args({ pair: "SOL" }))), /pair/);
    assert.match(String(validateDegenArgs(args({ sizeUsd: 0 }))), /size/);
    assert.match(String(validateDegenArgs(args({ polls: 9999 }))), /polls/);
    assert.equal(validateDegenArgs(args({ pair: "SOL/USDT" })), null);
    assert.equal(validateDegenArgs(args()), null);
  });
});

describe("screenRow", () => {
  it("passes fade-short and dip-long rows with measured ATR", () => {
    assert.equal(screenRow(row()), null);
    assert.equal(screenRow(row({ vratio: 0.4, offHighPct: 25, offLowPct: 3 })), null);
  });
  it("rejects thin tape, null ATR, and non-exhaustion", () => {
    assert.match(String(screenRow(null)), /thin tape/);
    assert.match(String(screenRow(row({ last: 0 }))), /thin tape/);
    assert.match(String(screenRow(row({ atrPct: null }))), /ATR/);
    assert.match(String(screenRow(row({ vratio: 1.2, offHighPct: 10, offLowPct: 10 }))), /no exhaustion/);
    assert.match(String(screenRow(row({ vratio: 5, offHighPct: 2, offLowPct: 2 }))), /no exhaustion/);
  });
  it("rowSignals reuses the scan classifiers", () => {
    assert.deepEqual(rowSignals(row()), { sSig: "fade-short", lSig: "extended" });
  });
});

describe("averaging math", () => {
  it("size-weights the averaged entry and moves TP off it", () => {
    assert.equal(averagedEntry([]), null);
    const avg = averagedEntry([{ price: 100, sizeUsd: 15 }, { price: 98, sizeUsd: 15 }]);
    assert.equal(avg, 99);
    assert.equal(averagedTpPrice(99, "long", 0.5), 99 * 1.005);
    assert.equal(averagedTpPrice(99, "short", 0.5), 99 * 0.995);
    assert.equal(averagedTpPrice(0, "long", 0.5), null);
  });
});

describe("ticket builders (single construction site)", () => {
  it("degen entry is an isolated futures limit with key + machine actor; exits arm stop+TP", () => {
    const entry = degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", contracts: 2, price: 100, leverage: 2, multiplier: 1 });
    assert.deepEqual(
      { ...entry, idempotency_key: undefined },
      { exchange: "kucoin", pair: "SOL/USDT", side: "buy", amount: "2", price: "100", market: "futures", leverage: 2, marginMode: "isolated", idempotency_key: undefined, actor: "machine" },
    );
    assert.match(String(entry.idempotency_key), /^jw3-degen-[0-9a-f]{8}$/);
    // Same intent, same key (a retry dedupes); different price, different key.
    assert.equal(
      degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", contracts: 2, price: 100, leverage: 2, multiplier: 1 }).idempotency_key,
      entry.idempotency_key,
    );
    assert.notEqual(
      degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", contracts: 2, price: 101, leverage: 2, multiplier: 1 }).idempotency_key,
      entry.idempotency_key,
    );
    assert.equal(
      degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "short", contracts: 1, price: 50, leverage: 2, multiplier: 1 }).side,
      "sell",
    );
    // Explicit key/actor overrides win.
    const over = degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", contracts: 1, price: 50, leverage: 2, idempotencyKey: "k", actor: "owner" });
    assert.equal(over.idempotency_key, "k");
    assert.equal(over.actor, "owner");
    assert.deepEqual(
      degenExitsArgs({ exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101 }),
      { exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101, market: "futures" },
    );
    // The stop leg rides the same arm (venue-native stop, the kill line).
    assert.deepEqual(
      degenExitsArgs({ exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101, slPrice: 99 }),
      { exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101, slPrice: 99, market: "futures" },
    );
  });

  it("sends `amount` in BASE units, not contracts (the multiplier trap)", () => {
    // `execute_trade` divides the amount by the contract multiplier to get
    // integer lots. Sending the contract COUNT therefore multiplies the
    // position by the multiplier: 12 contracts on a mult-100 contract became
    // 1200 base units = 12 lots — a 100x oversize.
    const mult100 = degenExecuteArgs({
      exchange: "kucoin", pair: "IRYS/USDT", side: "short",
      contracts: 12, price: 0.0129, leverage: 20, multiplier: 100,
    });
    assert.equal(mult100.amount, "1200");

    const solMult01 = degenExecuteArgs({
      exchange: "kucoin", pair: "SOL/USDT", side: "long",
      contracts: 2, price: 100, leverage: 2, multiplier: 0.1,
    });
    assert.equal(solMult01.amount, "0.2");

    // No multiplier supplied (legacy call sites) stays 1:1.
    const noMult = degenExecuteArgs({
      exchange: "kucoin", pair: "SOL/USDT", side: "long",
      contracts: 2, price: 100, leverage: 2,
    });
    assert.equal(noMult.amount, "2");
  });
});

describe("cmdDegen dry run (default, no --yes)", () => {
  it("preview prints the full ticket, sends zero bytes, logs preview", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p },
    );
    assert.equal(process.exitCode, undefined);
    assert.equal(calls.filter(isFundMoving).length, 0);
    assert.match(logs.join("\n"), /DEGEN LONG SOL\/USDT/);
    assert.match(logs.join("\n"), /step-2 average level/);
    assert.match(logs.join("\n"), /Dry run — nothing sent/);
    const lines = readFileSync(p.logPath, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0] as string) as { mode: string }).mode, "preview");
  });
  it("oracle FLAT is no-trade, never a smaller trade", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: flatOracle, spec, call: spyCall(calls), ...p },
    );
    assert.equal(process.exitCode, undefined);
    assert.equal(calls.filter(isFundMoving).length, 0);
    assert.match(logs.join("\n"), /NO-TRADE — oracle FLAT/);
  });
  it("screen reject and governor stop send nothing", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row({ vratio: 1.2, offHighPct: 10, offLowPct: 10 }), oracle: longOracle, spec, call: spyCall(calls), ...p },
    );
    assert.match(logs.join("\n"), /NO-TRADE — screen reject/);
    logs = [];
    writeFileSync(p.heatPath, JSON.stringify({ ...defaultHeat("2026-10-14"), stopsToday: 2, day: new Date().toISOString().slice(0, 10) }));
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p, now: () => Date.now() },
    );
    assert.match(logs.join("\n"), /governor STOP/);
    assert.equal(calls.filter(isFundMoving).length, 0);
  });
  it("auto-screen picks the most exhausted row with no --pair", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args(),
      { yes: false, json: true, pat: "test-pat" },
      {
        fade: async (b: string) => (b === "SOL" ? row() : row({ symbol: `${b}USDTM`, vratio: 1.5, offHighPct: 9, offLowPct: 9 })),
        oracle: longOracle, spec, call: spyCall(calls), ...p,
      },
    );
    assert.equal(calls.filter(isFundMoving).length, 0);
    assert.match(logs.join("\n"), /"mode": "preview"/);
  });
});

describe("cmdDegen fire (--yes)", () => {
  it("fires step-1 + step-2 + TP exactly as the builders produce", async () => {
    const p = paths();
    const calls: Call[] = [];
    const trails: unknown[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), runTrail: async (t) => void trails.push(t), ...p },
    );
    assert.equal(process.exitCode, undefined);
    const fires = calls.filter((c) => c.name === "execute_trade");
    assert.equal(fires.length, 2);
    const close = (v: unknown, want: number): void =>
      assert.ok(Math.abs(Number(v) - want) < 1e-9, `want ~${want}, got ${String(v)}`);
    assert.equal(fires[0]?.args.side, "buy");
    assert.equal(fires[0]?.args.amount, "1");
    close(fires[0]?.args.price, 100);
    assert.equal(fires[0]?.args.market, "futures");
    assert.equal(fires[0]?.args.marginMode, "isolated");
    assert.equal(fires[1]?.args.side, "buy");
    assert.equal(fires[1]?.args.amount, "1");
    close(fires[1]?.args.price, 99.28);
    const tp = calls.filter((c) => c.name === "set_exits");
    assert.equal(tp.length, 1);
    close(tp[0]?.args.tpPrice, 100.32);
    assert.equal(tp[0]?.args.market, "futures");
    const heat = loadHeat(p.heatPath);
    assert.deepEqual(heat.open.map((o) => o.pair), ["SOL/USDT"]);
    assert.ok(heat.heatUsd > 0);
    assert.match(logs.join("\n"), /jw3 trail --pair SOL\/USDT/);
    assert.equal(trails.length, 0);
  });
  it("--trail runs the supervisor inline with the trail ticket", async () => {
    const p = paths();
    const calls: Call[] = [];
    const trails: { pair: string; side: string; size: number }[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT", trail: true }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), runTrail: async (t) => void trails.push(t), ...p },
    );
    assert.equal(trails.length, 1);
    assert.equal(trails[0]?.pair, "SOL/USDT");
    assert.equal(trails[0]?.side, "long");
  });
  it("arms a venue-native stop with the TP and reports success", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p },
    );
    assert.equal(process.exitCode, undefined);
    const arms = calls.filter((c) => c.name === "set_exits");
    assert.equal(arms.length, 1);
    assert.ok(Number(arms[0]?.args.slPrice) > 0, "the arm carries a venue-native stop (the kill line)");
    assert.ok(Number(arms[0]?.args.tpPrice) > 0, "the arm carries the take-profit");
    const fires = calls.filter((c) => c.name === "execute_trade");
    assert.equal(fires.length, 2);
    for (const f of fires) {
      assert.match(String(f.args.idempotency_key), /^jw3-degen-[0-9a-f]{8}$/);
      assert.equal(f.args.actor, "machine");
    }
    assert.notEqual(fires[0]?.args.idempotency_key, fires[1]?.args.idempotency_key);
  });
  it("refuses success when only TP arms and no --trail guards the position", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      {
        fade: async () => row(), oracle: longOracle, spec, ...p,
        call: spyCall(calls, (c) => {
          if (c.name === "set_exits" && c.args.slPrice !== undefined) throw new Error("venue rejects the stop leg");
          if (c.name === "list_open_orders") return [];
          if (c.name === "execute_trade") return { orderId: `oid-${calls.length}` };
          return {};
        }),
      },
    );
    // TP-only fallback armed (second call) but no stop and no trail: not success.
    assert.equal(calls.filter((c) => c.name === "set_exits").length, 2);
    assert.match(errs.join("\n"), /NO-STOP/);
    assert.equal(process.exitCode, 1);
  });
  it("--trail counts as the guard when the venue stop will not arm", async () => {
    const p = paths();
    const calls: Call[] = [];
    const trails: unknown[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT", trail: true }),
      { yes: true, json: false, pat: "test-pat" },
      {
        fade: async () => row(), oracle: longOracle, spec, runTrail: async (t) => void trails.push(t), ...p,
        call: spyCall(calls, (c) => {
          if (c.name === "set_exits" && c.args.slPrice !== undefined) throw new Error("venue rejects the stop leg");
          if (c.name === "list_open_orders") return [];
          if (c.name === "execute_trade") return { orderId: `oid-${calls.length}` };
          return {};
        }),
      },
    );
    assert.equal(trails.length, 1);
    assert.equal(process.exitCode, undefined);
  });

  it("refuses a SHORT without the +0.4% bounce off the session low", async () => {
    // The oracle applies this gate (clampShortVerdict) but the degen LIVE
    // path did not — a short could fire straight into the flush, which is
    // exactly what the owner doctrine forbids.
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      {
        fade: async () => row(),
        oracle: shortOracle,
        spec,
        call: spyCall(calls),
        // Price sitting ON the session low → no bounce → veto.
        sessionCtx: async () => ({ price: 100, sessionLow: 100 }),
        ...p,
      },
    );
    assert.equal(calls.filter(isFundMoving).length, 0);
    assert.match(logs.join("\n"), /bounce_required/);
    assert.match(logs.join("\n"), /never short into the flush/);
  });

  it("allows a SHORT once the tape has bounced off the session low", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      {
        fade: async () => row(),
        oracle: shortOracle,
        spec,
        call: spyCall(calls),
        // 0.5% off the low → clears the 0.4% requirement.
        sessionCtx: async () => ({ price: 100.5, sessionLow: 100 }),
        ...p,
      },
    );
    const fires = calls.filter((c) => c.name === "execute_trade");
    assert.equal(fires.length, 2);
    assert.equal(fires[0]?.args.side, "sell");
  });

  it("never applies the bounce gate to a LONG", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      {
        fade: async () => row(),
        oracle: longOracle,
        spec,
        call: spyCall(calls),
        // No bounce at all — irrelevant for a long.
        sessionCtx: async () => ({ price: 100, sessionLow: 100 }),
        ...p,
      },
    );
    assert.equal(calls.filter((c) => c.name === "execute_trade").length, 2);
  });
  it("refuses on stale open orders and on a live run state", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls, () => [{ orderId: "stale", symbol: "SOLUSDTM" }]), ...p },
    );
    assert.equal(process.exitCode, 1);
    assert.equal(calls.filter(isFundMoving).length, 0);
    process.exitCode = undefined;
    const calls2: Call[] = [];
    writeFileSync(join(ensureDir(p.runDir), "degen_sol.json"), JSON.stringify({ kind: "degen" }));
    await cmdDegen(
      args({ pair: "SOL/USDT" }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls2), ...p },
    );
    assert.equal(process.exitCode, 1);
    assert.equal(calls2.filter(isFundMoving).length, 0);
  });
});

describe("cmdDegenRecord", () => {
  it("win frees heat; stop counts, cools down, and halves next size", async () => {
    const p = paths();
    const now = Date.now();
    writeFileSync(p.heatPath, JSON.stringify({ day: new Date(now).toISOString().slice(0, 10), stopsToday: 0, heatUsd: 1.2, open: [{ pair: "SOL/USDT", riskUsd: 1.2 }], lastStopAt: null }));
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "win", json: false, ...p }, { now: () => now });
    let heat = loadHeat(p.heatPath, now);
    assert.deepEqual(heat.open, []);
    assert.equal(heat.heatUsd, 0);
    assert.equal(heat.stopsToday, 0);
    writeFileSync(p.heatPath, JSON.stringify({ day: new Date(now).toISOString().slice(0, 10), stopsToday: 0, heatUsd: 1.2, open: [{ pair: "SOL/USDT", riskUsd: 1.2 }], lastStopAt: null }));
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "stop", json: false, ...p }, { now: () => now });
    heat = loadHeat(p.heatPath, now);
    assert.equal(heat.stopsToday, 1);
    assert.ok(heat.lastStopAt !== null);
    assert.equal(effectiveSize(15, heat.stopsToday), 7.5);
    assert.match(logs.join("\n"), /Halve rule live/);
  });
  it("rejects bad outcomes with exit 2", async () => {
    const p = paths();
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "moon", json: false, ...p });
    assert.equal(process.exitCode, 2);
  });
});

describe("appendLearning", () => {
  it("flags FINETUNE-READY at the banked thresholds", () => {
    const log = join(sandbox, "learn.jsonl");
    let hit: number | null = null;
    for (let i = 0; i < (DEGEN_FINETUNE_AT[0] as number); i++) {
      hit = appendLearning(log, { i });
    }
    assert.equal(hit, DEGEN_FINETUNE_AT[0]);
  });
});

describe("paper mode paths", () => {
  it("paper rides paper-accounts.json, never the live heat/log/run files", () => {
    const p = paths();
    assert.match(p.paperPath, /paper-accounts\.json$/);
    assert.notEqual(p.paperPath, p.heatPath);
    assert.notEqual(p.paperPath, p.logPath);
    assert.notEqual(degenRunPath("SOL", sandbox, true), degenRunPath("SOL", sandbox, false));
  });
  it("rejects paper+live and paper+trail", () => {
    assert.match(String(validateDegenArgs(args({ paper: true, live: true }))), /never live/);
    assert.match(String(validateDegenArgs(args({ paper: true, trail: true }))), /never trails/);
    assert.equal(validateDegenArgs(args({ paper: true })), null);
  });
  it("Diary setup args carry the paper thesis with paper-ledger fill ids", () => {
    const fills = { step1Id: "paper-pos-3", step2Id: "paper-pos-3" };
    const pa = paperProposeArgs(args({ paper: true }), {
      pair: "SOL/USDT", base: "SOL", side: "long", sizeEff: 15,
      plan: { last: 100, atrPct: 0.8, tpPct: 0.32, stepDropPct: 0, steps: [], avgEntry: 100, tpPrice: 100.32, killPrice: 98, killLossUsd: 1.5, maxCapitalUsd: 30 } as never,
      step1: { contracts: 1, price: 100, sizeUsd: 15 },
      step2: { contracts: 1, price: 99.28, sizeUsd: 15 },
      avg2: 99.64, tp1Price: 100.32, tp2Price: 99.96,
      trail: { size: 1, activationPct: 0.25, bouncebackPct: 0.08, polls: 600, live: false },
    }, fills) as Record<string, unknown>;
    assert.equal(pa.side, "long");
    assert.equal(pa.entry, 100);
    assert.equal(pa.timeframe, "paper");
    assert.match(String(pa.thesis), /\[PAPER\]/);
    assert.match(String(pa.thesis), /paper-pos-3/);
  });
  it("derives heat from the paper ledger, never the live file", () => {
    const p = paths();
    const store = loadPaperStore(p.paperPath);
    assert.equal(ensureDegenPaperAccount(store, p.paperPath), true);
    const now = Date.parse("2026-10-14T10:00:00Z");
    const heat = paperHeatOf(getAccount(store, DEGEN_PAPER_ACCOUNT) as PaperAccount, now);
    assert.deepEqual(heat, { day: "2026-10-14", stopsToday: 0, heatUsd: 0, open: [], lastStopAt: null });
  });
});

describe("cmdDegen --paper", () => {
  const VENUE_CALLS = new Set(["execute_trade", "close_position", "set_exits", "cancel_order", "list_open_orders"]);
  it("opens a paper position with zero venue contact, Diary setup only", async () => {
    const p = paths();
    const calls: Call[] = [];
    const call = spyCall(calls, (c) => {
      if (c.name === "propose_trade") return { setup_id: "paper-setup-1" };
      return {};
    });
    await cmdDegen(
      args({ pair: "SOL/USDT", paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call, ...p, now: () => 1700000000000 },
    );
    assert.equal(process.exitCode, undefined);
    for (const c of calls) assert.ok(!VENUE_CALLS.has(c.name), `venue contact: ${c.name}`);
    assert.deepEqual(calls.map((c) => c.name), ["propose_trade"]);
    assert.match(logs.join("\n"), /PAPER — simulated fills/);
    assert.match(logs.join("\n"), /diary: PAPER setup paper-setup-1/);
    assert.match(logs.join("\n"), /degen record --paper --pair SOL\/USDT/);
    // The paper ledger owns the fill: a degen-strategy position with TP/SL armed.
    const acct = getAccount(loadPaperStore(p.paperPath), DEGEN_PAPER_ACCOUNT);
    assert.ok(acct);
    assert.equal(acct.positions.length, 1);
    const pos = acct.positions[0] as PaperAccount["positions"][number];
    assert.equal(pos.pair, "SOL/USDT");
    assert.equal(pos.side, "long");
    assert.equal(pos.strategy, "degen");
    assert.ok(pos.entryPrice > 0 && pos.qty > 0);
    assert.ok(pos.tp !== null && pos.tp > pos.entryPrice);
    assert.ok(pos.sl !== null && pos.sl < pos.entryPrice);
    const opens = acct.fills.filter((f) => f.kind === "open" && f.strategy === "degen");
    assert.equal(opens.length, 1);
    // The legacy paper paths are never written.
    assert.equal(existsSync(join(sandbox, "degen-paper-heat.json")), false);
    assert.equal(existsSync(join(sandbox, "degen-paper-learning.jsonl")), false);
  });
  it("paper without PAT still records locally and says so", async () => {
    const p = paths();
    const calls: Call[] = [];
    const savedPat = process.env.JW3_MCP_PAT;
    const savedHome = process.env.JW3_CONFIG_HOME;
    delete process.env.JW3_MCP_PAT;
    process.env.JW3_CONFIG_HOME = sandbox;
    try {
      await cmdDegen(
        args({ pair: "SOL/USDT", paper: true }),
        { yes: false, json: true },
        { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p, now: () => 1700000000000 },
      );
    } finally {
      if (savedPat === undefined) delete process.env.JW3_MCP_PAT;
      else process.env.JW3_MCP_PAT = savedPat;
      if (savedHome === undefined) delete process.env.JW3_CONFIG_HOME;
      else process.env.JW3_CONFIG_HOME = savedHome;
    }
    assert.equal(process.exitCode, undefined);
    assert.equal(calls.length, 0);
    assert.match(logs.join("\n"), /no PAT — paper kept locally/);
    assert.match(logs.join("\n"), /"mode": "paper"/);
    const acct = getAccount(loadPaperStore(p.paperPath), DEGEN_PAPER_ACCOUNT);
    assert.equal(acct?.positions.length, 1);
  });
  it("diary failure warns but never loses the paper fill", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT", paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      {
        fade: async () => row(), oracle: longOracle, spec,
        call: spyCall(calls, (c) => {
          if (c.name === "propose_trade") throw new Error("diary down");
          return {};
        }),
        ...p, now: () => 1700000000000,
      },
    );
    assert.equal(process.exitCode, undefined);
    assert.match(logs.join("\n"), /diary write failed/);
    const acct = getAccount(loadPaperStore(p.paperPath), DEGEN_PAPER_ACCOUNT);
    assert.equal(acct?.positions.length, 1);
  });
  it("refuses --paper --yes with exit 2 and writes nothing", async () => {
    const p = paths();
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "SOL/USDT", paper: true }),
      { yes: true, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p },
    );
    assert.equal(process.exitCode, 2);
    assert.equal(calls.length, 0);
    assert.match(errs.join("\n"), /never fires/);
    assert.equal(existsSync(p.paperPath), false);
  });
  it("refuses a second paper fire on the same pair (governor)", async () => {
    const p = paths();
    const calls: Call[] = [];
    const now = () => 1700000000000;
    const run = () => cmdDegen(
      args({ pair: "SOL/USDT", paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p, now },
    );
    await run();
    const first = calls.length;
    process.exitCode = undefined;
    logs = [];
    await run();
    assert.match(logs.join("\n"), /governor STOP.*already open/);
    assert.equal(calls.length, first);
    const acct = getAccount(loadPaperStore(p.paperPath), DEGEN_PAPER_ACCOUNT);
    assert.equal(acct?.positions.length, 1);
  });
  it("insufficient paper cash refuses the fill with exit 1", async () => {
    const p = paths();
    const store = loadPaperStore(p.paperPath);
    assert.equal(ensureDegenPaperAccount(store, p.paperPath), true);
    // Drain the account: size 15 x2 needs margin + fee, $1 cannot cover it.
    const acct = getAccount(store, DEGEN_PAPER_ACCOUNT) as PaperAccount;
    acct.cashUsd = 1;
    savePaperStore(p.paperPath, store);
    await cmdDegen(
      args({ pair: "SOL/USDT", sizeUsd: 15, leverage: 2, paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall([]), ...p, now: () => 1700000000000 },
    );
    assert.equal(process.exitCode, 1);
    assert.match(errs.join("\n"), /insufficient paper cash/);
  });
});

describe("paper record + stats", () => {
  const openViaLoop = (p: ReturnType<typeof paths>, pair = "SOL/USDT") =>
    cmdDegen(
      args({ pair, paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall([]), ...p, now: () => 1700000000000 },
    );
  it("record --paper closes the position; the exit derives from the recorded pnl", async () => {
    const p = paths();
    await openViaLoop(p);
    process.exitCode = undefined;
    logs = [];
    // Step-1 fills 15 USD at the plan price: exit = entry + pnl/qty.
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "win", pnl: 2.25, paper: true, json: false, paperPath: p.paperPath }, { now: () => 1700000000000 });
    assert.equal(process.exitCode, undefined);
    const acct = getAccount(loadPaperStore(p.paperPath), DEGEN_PAPER_ACCOUNT) as PaperAccount;
    assert.equal(acct.positions.length, 0);
    const wins = acct.fills.filter((f) => f.kind === "tp" && f.strategy === "degen");
    assert.equal(wins.length, 1);
    assert.ok(Math.abs((wins[0]?.pnlUsd ?? NaN) - 2.25) < 1e-9, `pnl round-trips through the derived exit: ${wins[0]?.pnlUsd}`);
    assert.match(logs.join("\n"), /PAPER RECORDED WIN/);
    assert.match(logs.join("\n"), /stops today 0/);
  });
  it("stops and red losses count; halving then flat follows the ledger", async () => {
    const p = paths();
    await openViaLoop(p, "SOL/USDT");
    await openViaLoop(p, "ETH/USDT");
    process.exitCode = undefined;
    logs = [];
    await cmdDegenRecordPaper("SOL/USDT", "stop", undefined, false, p.paperPath, 1700000000000);
    assert.match(logs.join("\n"), /stops today 1/);
    assert.match(logs.join("\n"), /Halve rule live/);
    logs = [];
    await cmdDegenRecordPaper("ETH/USDT", "loss", -1.5, false, p.paperPath, 1700000000000);
    assert.match(logs.join("\n"), /stops today 2/);
    assert.match(logs.join("\n"), /Flat for the day/);
    // The second fire is now governor-blocked (flat for the day).
    process.exitCode = undefined;
    logs = [];
    const calls: Call[] = [];
    await cmdDegen(
      args({ pair: "BTC/USDT", paper: true }),
      { yes: false, json: false, pat: "test-pat" },
      { fade: async () => row(), oracle: longOracle, spec, call: spyCall(calls), ...p, now: () => 1700000000000 },
    );
    assert.match(logs.join("\n"), /governor STOP.*flat for the day/);
  });
  it("record --paper with no open position errors and writes nothing", async () => {
    const p = paths();
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "win", paper: true, json: false, paperPath: p.paperPath }, { now: () => 1700000000000 });
    assert.equal(process.exitCode, 1);
    assert.match(errs.join("\n"), /No open degen paper position/);
  });
  it("record --paper leaves the live book alone", async () => {
    const p = paths();
    const liveHeat = join(sandbox, "live-heat.json");
    const liveLog = join(sandbox, "live-log.jsonl");
    await openViaLoop(p);
    process.exitCode = undefined;
    await cmdDegenRecord(
      { pair: "SOL/USDT", outcome: "win", paper: true, json: false, paperPath: p.paperPath, heatPath: liveHeat, logPath: liveLog },
      { now: () => 1700000000000 },
    );
    assert.equal(process.exitCode, undefined);
    assert.equal(existsSync(liveHeat), false);
    assert.equal(existsSync(liveLog), false);
  });
  it("summarizePaperAccount scores fills vs closes, strategy-scoped", () => {
    const acct = {
      positions: [
        { pair: "SOL/USDT", strategy: "degen" },
        { pair: "OTHER/USDT", strategy: "manual" },
      ],
      fills: [
        { kind: "open", strategy: "degen", pair: "SOL/USDT" },
        { kind: "tp", strategy: "degen", pair: "SOL/USDT", pnlUsd: 2.5 },
        { kind: "sl", strategy: "degen", pair: "SOL/USDT", pnlUsd: -1.5 },
        { kind: "close", strategy: "degen", pair: "SOL/USDT", pnlUsd: -0.5 },
        { kind: "close", strategy: "degen", pair: "SOL/USDT", pnlUsd: 0 },
        { kind: "tp", strategy: "manual", pair: "OTHER/USDT", pnlUsd: 999 },
      ],
    } as unknown as PaperAccount;
    const s = summarizePaperAccount(acct);
    assert.deepEqual(s, { fills: 1, wins: 1, losses: 1, stops: 1, scratches: 1, pending: 0, netUsd: 0.5, open: ["SOL/USDT"] } as PaperStats);
  });
  it("paper-stats reports the book and the empty book", async () => {
    const p = paths();
    await cmdPaperStats({ json: false, paperPath: p.paperPath });
    assert.match(logs.join("\n"), /no paper fills yet/);
    logs = [];
    await openViaLoop(p);
    process.exitCode = undefined;
    logs = [];
    await cmdDegenRecordPaper("SOL/USDT", "win", 2.5, true, p.paperPath, 1700000000000);
    const out = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    assert.equal(out.pair, "SOL/USDT");
    logs = [];
    await cmdPaperStats({ json: true, paperPath: p.paperPath });
    const stats = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    assert.equal(stats.book, "paper");
    assert.equal(stats.fills, 1);
    assert.equal(stats.wins, 1);
    assert.ok(Math.abs((stats.netUsd as number) - 2.5) < 1e-9, `net round-trips through the derived exit: ${stats.netUsd}`);
    assert.deepEqual(stats.open, []);
  });
});

describe("legacy paper migration", () => {
  it("imports run states + matched outcomes once, then renames the legacy files", () => {
    const dir = sandbox;
    const paperPath = join(dir, "paper-accounts.json");
    const heatPath = join(dir, "degen-paper-heat.json");
    const logPath = join(dir, "degen-paper-learning.jsonl");
    const runDir = join(dir, "runs");
    // OLD-format fixtures: exactly what the pre-OQ-13 code wrote.
    writeFileSync(heatPath, JSON.stringify({ day: "2026-10-14", stopsToday: 0, heatUsd: 1.5, open: [{ pair: "SOL/USDT", riskUsd: 1.5 }], lastStopAt: null }, null, 2));
    writeFileSync(
      join(ensureDir(runDir), "degen_paper_sol.json"),
      JSON.stringify({ kind: "degen-paper", exchange: "kucoin", pair: "SOL/USDT", base: "SOL", side: "long", leverage: 2, step1: { contracts: 1, price: 100, sizeUsd: 15 }, step2: { contracts: 1, price: 99, sizeUsd: 15 }, tp1Price: 100.32, killPrice: 98 }),
    );
    writeFileSync(
      logPath,
      [
        JSON.stringify({ at: "2026-10-14T09:00:00.000Z", pair: "SOL/USDT", side: "long", mode: "paper", outcome: "pending", reason: "paper fill (no venue)" }),
        JSON.stringify({ at: "2026-10-14T10:00:00.000Z", pair: "SOL/USDT", mode: "record", paper: true, outcome: "win", pnlUsd: 2.5 }),
      ].join("\n") + "\n",
    );
    const mig = migrateDegenPaperOnce({ paperPath, heatPath, logPath, runDir, nowMs: Date.parse("2026-10-14T11:00:00Z") });
    assert.equal(mig.migrated, true);
    assert.equal(mig.positions, 1);
    assert.equal(mig.closed, 1);
    assert.equal(mig.skipped, 0);
    assert.deepEqual(mig.warnings, []);
    const acct = getAccount(loadPaperStore(paperPath), DEGEN_PAPER_ACCOUNT) as PaperAccount;
    assert.equal(acct.positions.length, 0);
    const wins = acct.fills.filter((f) => f.kind === "tp" && f.strategy === "degen");
    assert.equal(wins.length, 1);
    assert.ok(Math.abs((wins[0]?.pnlUsd ?? NaN) - 2.5) < 1e-9, `migrated pnl round-trips through the derived exit: ${wins[0]?.pnlUsd}`);
    // Legacy paths renamed, never written again.
    assert.equal(existsSync(heatPath), false);
    assert.equal(existsSync(logPath), false);
    assert.equal(existsSync(join(runDir, "degen_paper_sol.json")), false);
    assert.equal(existsSync(`${heatPath}.migrated`), true);
    assert.equal(existsSync(`${logPath}.migrated`), true);
    // Second run is a no-op.
    const again = migrateDegenPaperOnce({ paperPath, heatPath, logPath, runDir });
    assert.equal(again.migrated, false);
  });
  it("skips heat-only opens and orphan outcomes loudly, without losing them silently", () => {
    const dir = sandbox;
    const paperPath = join(dir, "paper-accounts.json");
    const heatPath = join(dir, "degen-paper-heat.json");
    const logPath = join(dir, "degen-paper-learning.jsonl");
    writeFileSync(heatPath, JSON.stringify({ day: "2026-10-14", stopsToday: 1, heatUsd: 0.5, open: [{ pair: "GHOST/USDT", riskUsd: 0.5 }], lastStopAt: null }, null, 2));
    writeFileSync(logPath, JSON.stringify({ at: "2026-10-14T10:00:00.000Z", pair: "GHOST/USDT", mode: "record", paper: true, outcome: "stop", pnlUsd: -1 }) + "\n");
    const mig = migrateDegenPaperOnce({ paperPath, heatPath, logPath, runDir: join(dir, "empty-runs"), nowMs: Date.parse("2026-10-14T11:00:00Z") });
    assert.equal(mig.migrated, true);
    assert.equal(mig.positions, 0);
    assert.equal(mig.closed, 0);
    assert.equal(mig.skipped, 2);
    assert.equal(mig.warnings.length, 2);
    const acct = getAccount(loadPaperStore(paperPath), DEGEN_PAPER_ACCOUNT) as PaperAccount;
    assert.equal(acct.positions.length, 0);
  });
  it("does nothing when no legacy files exist", () => {
    const mig = migrateDegenPaperOnce({ paperPath: join(sandbox, "paper-accounts.json"), heatPath: join(sandbox, "no-heat.json"), logPath: join(sandbox, "no-log.jsonl"), runDir: join(sandbox, "no-runs") });
    assert.equal(mig.migrated, false);
  });
});
