import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  KLINES_MAX_LIMIT,
  cmdKlines,
  klinesSymbolForPair,
  klinesTfToMinutes,
  parseKlineRows,
  rsiWilder,
  vwapCumulative,
} from "./commands/klines.js";

/** Rising hourly rows: [ts,o,h,l,c,vol,turnover]. */
function mockRows(n: number, t0 = 1_700_000_000_000, stepMs = 900_000, c0 = 100): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const c = c0 + i * 0.5;
    rows.push([t0 + i * stepMs, c - 0.1, c + 0.2, c - 0.2, c, 1000 + i * 10, c * 1000]);
  }
  return rows;
}

let logs: string[] = [];
let errors: string[] = [];
let exitBefore: number | undefined;
const realLog = console.log;
const realErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  exitBefore = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realErr;
  process.exitCode = exitBefore;
});

describe("klinesTfToMinutes", () => {
  it("maps 5m/15m/1h/1d, case-insensitive", () => {
    assert.equal(klinesTfToMinutes("5m"), 5);
    assert.equal(klinesTfToMinutes("15m"), 15);
    assert.equal(klinesTfToMinutes("1H"), 60);
    assert.equal(klinesTfToMinutes("1d"), 1440);
  });
  it("rejects anything else", () => {
    assert.equal(klinesTfToMinutes("4h"), null);
    assert.equal(klinesTfToMinutes("1w"), null);
    assert.equal(klinesTfToMinutes(""), null);
  });
});

describe("klinesSymbolForPair", () => {
  it("maps pairs to futures symbols, BTC aliases XBT", () => {
    assert.equal(klinesSymbolForPair("SOL/USDT"), "SOLUSDTM");
    assert.equal(klinesSymbolForPair("btc/usdt"), "XBTUSDTM");
  });
  it("rejects non-USDT quotes and malformed pairs", () => {
    assert.equal(klinesSymbolForPair("ETH/USD"), null);
    assert.equal(klinesSymbolForPair("ETH"), null);
    assert.equal(klinesSymbolForPair(""), null);
  });
});

describe("parseKlineRows", () => {
  it("drops malformed rows and sorts by time", () => {
    const rows = [...mockRows(3)].reverse();
    rows.push([1_700_000_009_000, 1, 2, 0.5, 0, 10, 10]); // zero close
    rows.push([1_700_000_010_000]); // short row
    const out = parseKlineRows(rows);
    assert.equal(out.length, 3);
    assert.ok(out[0]!.tsMs < out[1]!.tsMs && out[1]!.tsMs < out[2]!.tsMs);
  });
});

describe("rsiWilder", () => {
  it("all gains saturate at 100", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const r = rsiWilder(closes);
    assert.deepEqual(r.slice(0, 14), new Array(14).fill(null));
    assert.ok(r.slice(14).every((v) => v === 100));
  });
  it("flat history reads neutral 50", () => {
    const r = rsiWilder(new Array(20).fill(42));
    assert.ok(r.slice(14).every((v) => v === 50));
  });
  it("thin history is all null", () => {
    assert.deepEqual(rsiWilder([1, 2, 3]), [null, null, null]);
  });
});

describe("vwapCumulative", () => {
  it("matches a hand-computed cumulative average", () => {
    const candles = [
      { tsMs: 1, open: 9, high: 12, low: 9, close: 10, volume: 100, turnover: 0 },
      { tsMs: 2, open: 10, high: 11, low: 10, close: 11, volume: 300, turnover: 0 },
    ];
    // tp1 = (12+9+10)/3 = 31/3; tp2 = (11+10+11)/3 = 32/3
    const tp1 = 31 / 3;
    const tp2 = 32 / 3;
    const [v0, v1] = vwapCumulative(candles);
    assert.ok(Math.abs(v0! - tp1) < 1e-9);
    assert.ok(Math.abs(v1! - (tp1 * 100 + tp2 * 300) / 400) < 1e-9);
  });
  it("zero-volume prefix reads null", () => {
    const candles = [{ tsMs: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, turnover: 0 }];
    assert.deepEqual(vwapCumulative(candles), [null]);
  });
});

describe("cmdKlines", () => {
  it("pretty-prints candles with RSI/VWAP columns", async () => {
    let seen: { symbol: string; gran: number } | null = null;
    await cmdKlines(
      { pair: "SOL/USDT", tf: "15m", limit: 20, rsi: true, vwap: true, json: false },
      {
        now: () => 1_700_000_000_000 + 21 * 900_000,
        fetch: async (symbol, gran) => {
          seen = { symbol, gran };
          return mockRows(20);
        },
      },
    );
    assert.deepEqual(seen, { symbol: "SOLUSDTM", gran: 15 });
    assert.equal(process.exitCode, undefined);
    assert.match(logs[0]!, /KLINES SOL\/USDT 15m — 20 candles/);
    assert.equal(logs.length, 21);
    assert.match(logs[20]!, /RSI \d+\.\d/);
    assert.match(logs[20]!, /VWAP/);
  });
  it("emits one JSON object with per-candle indicators", async () => {
    await cmdKlines(
      { pair: "BTC/USDT", tf: "1h", limit: 20, rsi: true, vwap: false, json: true },
      { now: () => 1_700_000_000_000 + 21 * 3_600_000, fetch: async () => mockRows(20, 1_700_000_000_000, 3_600_000) },
    );
    assert.equal(logs.length, 1);
    const out = JSON.parse(logs[0]!) as {
      symbol: string;
      granularityMin: number;
      candles: { rsi: number | null; vwap?: unknown }[];
    };
    assert.equal(out.symbol, "XBTUSDTM");
    assert.equal(out.granularityMin, 60);
    assert.equal(out.candles.length, 20);
    assert.ok(!("vwap" in out.candles[19]!));
    assert.equal(out.candles[19]!.rsi, 100);
  });
  it("rejects a bad timeframe without calling the venue (exit 2)", async () => {
    let called = false;
    await cmdKlines(
      { pair: "SOL/USDT", tf: "4h", limit: 50, rsi: false, vwap: false, json: false },
      { fetch: async () => ((called = true), []) },
    );
    assert.equal(called, false);
    assert.equal(process.exitCode, 2);
    assert.match(errors[0]!, /Usage: jw3 klines/);
  });
  it("rejects an out-of-range limit without calling the venue (exit 2)", async () => {
    let called = false;
    await cmdKlines(
      { pair: "SOL/USDT", tf: "15m", limit: KLINES_MAX_LIMIT + 1, rsi: false, vwap: false, json: false },
      { fetch: async () => ((called = true), []) },
    );
    assert.equal(called, false);
    assert.equal(process.exitCode, 2);
  });
  it("empty venue rows are an error (exit 1)", async () => {
    await cmdKlines(
      { pair: "SOL/USDT", tf: "15m", limit: 50, rsi: false, vwap: false, json: false },
      { fetch: async () => [] },
    );
    assert.equal(process.exitCode, 1);
    assert.match(errors[0]!, /no rows/);
  });
});
