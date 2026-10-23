/**
 * `jw3 degen` tests — pure governor/screen/averaging math plus dry-run
 * parity for the unified loop. No network: every venue/oracle call is
 * injected. No trades.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEGEN_FINETUNE_AT,
  appendLearning,
  averagedEntry,
  averagedTpPrice,
  checkHeat,
  cmdDegen,
  cmdDegenRecord,
  cmdPaperStats,
  degenExecuteArgs,
  degenExitsArgs,
  degenPaperHeatPath,
  degenPaperLogPath,
  degenHeatPath,
  degenLogPath,
  degenRunPath,
  defaultHeat,
  effectiveSize,
  loadHeat,
  paperFillIds,
  paperProposeArgs,
  rowSignals,
  screenRow,
  summarizePaperLog,
  validateDegenArgs,
  type DegenArgs,
  type DegenHeat,
} from "./degen.js";
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

beforeEach(() => {
  logs = [];
  errs = [];
  logFn = console.log;
  errFn = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  process.exitCode = undefined;
  sandbox = mkdtempSync(join(tmpdir(), "degen-test-"));
});

afterEach(() => {
  console.log = logFn;
  console.error = errFn;
  process.exitCode = undefined;
});

const paths = () => ({
  heatPath: join(sandbox, "degen-heat.json"),
  logPath: join(sandbox, "degen-learning.jsonl"),
  runDir: join(sandbox, "runs"),
  storePath: join(sandbox, "vote.json"),
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

describe("checkHeat", () => {
  const heat = (over: Partial<DegenHeat> = {}): DegenHeat => ({ ...defaultHeat("2026-10-14"), ...over });
  it("clears fresh books", () => {
    assert.equal(checkHeat(heat(), 1.5, "SOL/USDT", Date.parse("2026-10-14T10:00:00Z")), null);
  });
  it("flat after two stops, duplicates, caps, and cooldowns", () => {
    assert.match(String(checkHeat(heat({ stopsToday: 2 }), 1, "SOL/USDT", Date.now())), /flat for the day/);
    assert.match(String(checkHeat(heat({ open: [{ pair: "SOL/USDT", riskUsd: 1 }] }), 1, "sol/usdt", Date.now())), /already open/);
    assert.match(String(checkHeat(heat({ open: [{ pair: "A/USDT", riskUsd: 1 }, { pair: "B/USDT", riskUsd: 1 }] }), 1, "C/USDT", Date.now())), /concurrent/);
    assert.match(String(checkHeat(heat({ lastStopAt: new Date(Date.now() - 10 * 60000).toISOString() }), 1, "C/USDT", Date.now())), /cooldown/);
    assert.match(String(checkHeat(heat({ heatUsd: 5.5 }), 1, "C/USDT", Date.now())), /heat cap/);
    assert.match(String(checkHeat(heat(), NaN, "C/USDT", Date.now())), /unmeasurable/);
  });
  it("halves size after one stop", () => {
    assert.equal(effectiveSize(15, 0), 15);
    assert.equal(effectiveSize(15, 1), 7.5);
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
  it("degen entry is an isolated futures limit; TP is TP-only", () => {
    assert.deepEqual(
      degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "long", contracts: 2, price: 100, leverage: 2, multiplier: 1 }),
      { exchange: "kucoin", pair: "SOL/USDT", side: "buy", amount: "2", price: "100", market: "futures", leverage: 2, marginMode: "isolated" },
    );
    assert.deepEqual(
      degenExecuteArgs({ exchange: "kucoin", pair: "SOL/USDT", side: "short", contracts: 1, price: 50, leverage: 2, multiplier: 1 }).side,
      "sell",
    );
    assert.deepEqual(
      degenExitsArgs({ exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101 }),
      { exchange: "kucoin", pair: "SOL/USDT", tpPrice: 101, market: "futures" },
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
    mkdirSync(p.runDir, { recursive: true });
    writeFileSync(join(p.runDir, "degen_sol.json"), JSON.stringify({ kind: "degen" }));
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
  it("paper book never equals the live book", () => {
    assert.notEqual(degenPaperHeatPath(), degenHeatPath());
    assert.notEqual(degenPaperLogPath(), degenLogPath());
    assert.notEqual(degenRunPath("SOL", sandbox, true), degenRunPath("SOL", sandbox, false));
    assert.match(degenRunPath("SOL", sandbox, true), /degen_paper_sol\.json/);
  });
  it("rejects paper+live and paper+trail", () => {
    assert.match(String(validateDegenArgs(args({ paper: true, live: true }))), /never live/);
    assert.match(String(validateDegenArgs(args({ paper: true, trail: true }))), /never trails/);
    assert.equal(validateDegenArgs(args({ paper: true })), null);
  });
  it("pure paper builders: fill ids and Diary setup args", () => {
    assert.deepEqual(paperFillIds("SOL", 123), { step1Id: "paper-sol-123-s1", step2Id: "paper-sol-123-s2" });
    const fills = paperFillIds("SOL", 123);
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
    assert.match(String(pa.thesis), /paper-sol-123-s1/);
  });
});

describe("cmdDegen --paper", () => {
  const VENUE_CALLS = new Set(["execute_trade", "close_position", "set_exits", "cancel_order", "list_open_orders"]);
  it("simulates fills with zero venue contact, records Diary setup + paper ledger", async () => {
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
    const lines = readFileSync(p.logPath, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(e.mode, "paper");
    assert.equal(e.outcome, "pending");
    assert.match(String((e.fills as Record<string, string>).step1Id), /^paper-sol-/);
    const heat = loadHeat(p.heatPath);
    assert.deepEqual(heat.open.map((o) => o.pair), ["SOL/USDT"]);
    const run = JSON.parse(readFileSync(join(p.runDir, "degen_paper_sol.json"), "utf8")) as Record<string, unknown>;
    assert.equal(run.kind, "degen-paper");
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
    const lines = readFileSync(p.logPath, "utf8").split("\n").filter((l) => l.trim());
    assert.equal((JSON.parse(lines[0] as string) as { mode: string }).mode, "paper");
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
  });
  it("refuses a second paper fire on the same pair (governor, then run state)", async () => {
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
    // Heat cleared but run state still on disk → the paper run-state gate fires.
    const day = new Date(now()).toISOString().slice(0, 10);
    writeFileSync(p.heatPath, JSON.stringify({ day, stopsToday: 0, heatUsd: 0, open: [], lastStopAt: null }));
    process.exitCode = undefined;
    errs = [];
    await run();
    assert.equal(process.exitCode, 1);
    assert.equal(calls.length, first);
    assert.match(errs.join("\n"), /paper state exists/);
  });
});

describe("paper record + stats", () => {
  it("record --paper closes the paper book and leaves the live book alone", async () => {
    const p = paths();
    const liveHeat = join(sandbox, "live-heat.json");
    const liveLog = join(sandbox, "live-log.jsonl");
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    writeFileSync(p.heatPath, JSON.stringify({ day, stopsToday: 0, heatUsd: 1.5, open: [{ pair: "SOL/USDT", riskUsd: 1.5 }], lastStopAt: null }));
    await cmdDegenRecord({ pair: "SOL/USDT", outcome: "win", pnl: 2.25, paper: true, json: false, ...p }, { now: () => now });
    let heat = loadHeat(p.heatPath, now);
    assert.deepEqual(heat.open, []);
    assert.match(logs.join("\n"), /PAPER RECORDED WIN/);
    const rec = JSON.parse(readFileSync(p.logPath, "utf8").split("\n").filter((l) => l.trim()).pop() as string) as Record<string, unknown>;
    assert.equal(rec.paper, true);
    assert.equal(rec.pnlUsd, 2.25);
    // Live book paths untouched: nothing written where the live book lives.
    assert.equal(existsSync(liveHeat), false);
    assert.equal(existsSync(liveLog), false);
    heat = loadHeat(p.heatPath, now);
    assert.equal(heat.stopsToday, 0);
  });
  it("summarizePaperLog scores fills vs paper records only", () => {
    const text = [
      JSON.stringify({ mode: "paper", outcome: "pending", pair: "SOL/USDT" }),
      JSON.stringify({ mode: "paper", outcome: "pending", pair: "ETH/USDT" }),
      JSON.stringify({ mode: "record", paper: true, outcome: "win", pnlUsd: 2.5 }),
      JSON.stringify({ mode: "record", paper: true, outcome: "stop", pnlUsd: -1.5 }),
      JSON.stringify({ mode: "record", outcome: "win", pnlUsd: 999 }),
      JSON.stringify({ mode: "preview", outcome: "pending" }),
      "not json",
    ].join("\n");
    const s = summarizePaperLog(text, ["ETH/USDT"]);
    assert.deepEqual(s, { fills: 2, wins: 1, losses: 0, stops: 1, scratches: 0, pending: 0, netUsd: 1, open: ["ETH/USDT"] });
  });
  it("paper-stats reports the book and the empty book", async () => {
    const p = paths();
    await cmdPaperStats({ json: false, logPath: p.logPath, heatPath: p.heatPath });
    assert.match(logs.join("\n"), /no paper fills yet/);
    logs = [];
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    writeFileSync(p.logPath, [
      JSON.stringify({ mode: "paper", outcome: "pending", pair: "SOL/USDT" }),
      JSON.stringify({ mode: "record", paper: true, outcome: "win", pnlUsd: 2.5, pair: "SOL/USDT" }),
    ].join("\n") + "\n");
    writeFileSync(p.heatPath, JSON.stringify({ day, stopsToday: 0, heatUsd: 0, open: [], lastStopAt: null }));
    await cmdPaperStats({ json: true, logPath: p.logPath, heatPath: p.heatPath });
    const out = JSON.parse(logs[logs.length - 1] as string) as Record<string, unknown>;
    assert.equal(out.book, "paper");
    assert.equal(out.fills, 1);
    assert.equal(out.wins, 1);
    assert.equal(out.netUsd, 2.5);
  });
});
