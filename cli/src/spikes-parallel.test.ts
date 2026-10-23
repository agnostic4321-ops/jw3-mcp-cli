import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSpikes } from "./commands/spikes.js";
import { clearConnectionSessionCache, resolveConnectionCached } from "./commands/market.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function makeStubs() {
  let inFlight = 0;
  let maxInFlight = 0;
  let baselineCalls = 0;
  let freshCalls = 0;
  const tickerSymbols: string[] = [];
  const depthSymbols: string[] = [];
  const track = async <T>(fn: () => T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await tick();
      return fn();
    } finally {
      inFlight--;
    }
  };
  return {
    stats: () => ({ maxInFlight, baselineCalls, freshCalls, tickerSymbols, depthSymbols }),
    klinesRaw: async (sym: string, _g: number, fromMs: number, toMs: number): Promise<number[][]> => {
      const wide = toMs - fromMs > 10 * 60 * 1000;
      if (wide) {
        baselineCalls++;
        const rows: number[][] = [];
        for (let i = 0; i < 120; i++) rows.push([fromMs + i * 60_000, 100, 101, 99, 100, 500, 50_000]);
        return rows;
      }
      freshCalls++;
      // two bars: last CLOSED bar carries a new timestamp each call
      void sym;
      return [
        [toMs - 120_000, 100, 100.01, 99.99, 100, 10, 1_000],
        [toMs - 60_000, 100, 100.01, 99.99, 100, 10, 1_000],
        [toMs, 100, 100.01, 99.99, 100, 10, 1_000],
      ];
    },
    tickerFull: (sym: string) =>
      track(() => {
        tickerSymbols.push(sym);
        return { price: 100, bestBid: 99.99, bestAsk: 100.01, bestBidSize: 1, bestAskSize: 1 };
      }),
    depth20: (sym: string) =>
      track(() => {
        depthSymbols.push(sym);
        return { bids: [["99.99", "10"]] as [string, string][], asks: [["100.01", "10"]] as [string, string][] };
      }),
  };
}

describe("spikes parallel snapshots + baseline cache", () => {
  let dir: string;
  let prev: string | undefined;
  let logs: string[];
  let origLog: typeof console.log;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jw3-spikes-"));
    prev = process.env.JW3_CONFIG_HOME;
    process.env.JW3_CONFIG_HOME = dir;
    clearConnectionSessionCache();
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    if (prev === undefined) delete process.env.JW3_CONFIG_HOME;
    else process.env.JW3_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
    clearConnectionSessionCache();
  });

  it("fans out per-symbol ticker/depth and caches the 120-bar baseline", async () => {
    const stubs = makeStubs();
    const nowMs = Date.now();
    await cmdSpikes(
      { exchange: "kucoin", pairs: "SOL,ETH", cycles: 1, json: true },
      { klinesRaw: stubs.klinesRaw, tickerFull: stubs.tickerFull, depth20: stubs.depth20, now: () => nowMs },
    );
    const s1 = stubs.stats();
    assert.deepEqual([...s1.tickerSymbols].sort(), ["ETHUSDTM", "SOLUSDTM"]);
    assert.deepEqual([...s1.depthSymbols].sort(), ["ETHUSDTM", "SOLUSDTM"]);
    assert.ok(s1.maxInFlight > 1, `expected parallel fan-out, maxInFlight=${s1.maxInFlight}`);
    assert.equal(s1.baselineCalls, 2);
    const out = JSON.parse(logs.join("\n")) as {
      snapshots: { sym: string }[];
      baselines: Record<string, { n: number }>;
      readonly: boolean;
    };
    assert.equal(out.readonly, true);
    assert.deepEqual(out.snapshots.map((s) => s.sym).sort(), ["ETHUSDTM", "SOLUSDTM"]);
    assert.equal(out.baselines.SOLUSDTM?.n, 120);

    // Second run inside the 5-min TTL: no repeat 120-bar pull, snapshots still fan out.
    logs = [];
    await cmdSpikes(
      { exchange: "kucoin", pairs: "SOL,ETH", cycles: 1, json: true },
      { klinesRaw: stubs.klinesRaw, tickerFull: stubs.tickerFull, depth20: stubs.depth20, now: () => nowMs + 60_000 },
    );
    const s2 = stubs.stats();
    assert.equal(s2.baselineCalls, 2, "baseline file cache should skip the 120-bar re-pull");
    assert.ok(s2.freshCalls >= 2, "fresh 1m checks still run per cycle");
    assert.deepEqual(JSON.parse(logs.join("\n")).snapshots.map((s: { sym: string }) => s.sym).sort(), [
      "ETHUSDTM",
      "SOLUSDTM",
    ]);
  });
});

describe("resolveConnectionCached", () => {
  beforeEach(() => clearConnectionSessionCache());
  afterEach(() => clearConnectionSessionCache());

  it("resolves list_connections once per session key", async () => {
    let calls = 0;
    const rows = [{ id: "c1", exchange: "kucoin" }];
    const list = async () => {
      calls++;
      return rows;
    };
    const a = await resolveConnectionCached(rows, { exchange: "kucoin" }, true, { list });
    const b = await resolveConnectionCached(rows, { exchange: "kucoin" }, true, { list });
    assert.equal(a?.id, "c1");
    assert.equal(b?.id, "c1");
    assert.equal(calls, 1);
    // a different exchange is a different session key
    await resolveConnectionCached(rows, { exchange: "binance" }, true, {
      list: async () => [{ id: "c9", exchange: "binance" }],
    });
    assert.equal(calls, 1, "other-exchange lookup uses its own key");
  });
});
