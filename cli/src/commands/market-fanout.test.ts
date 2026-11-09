import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearConnectionSessionCache,
  cmdBalances,
  cmdOnchain,
  cmdOrders,
  cmdPositions,
  filterPositions,
  noTargetsError,
  resolveReadTargets,
  type Conn,
} from "./market.js";

const ROWS: Conn[] = [
  { id: "c-kraken", exchange: "kraken", label: "main" },
  { id: "c-kucoin-a", exchange: "kucoin", label: "a" },
  { id: "c-kucoin-b", exchange: "kucoin", label: "b" },
  { id: "c-okx", exchange: "okx" },
];

// The server fans out and answers one {kind, observedAt, venues:[...]}
// envelope (resolveCexReadTargets, cap 5, per-venue ok/error rows).
const FOUR_VENUES = {
  kind: "balances",
  observedAt: "2026-01-01T00:00:00.000Z",
  venues: [
    { connectionId: "c-kraken", exchange: "kraken", label: "main", ok: true, data: { a: 1 }, error: null },
    { connectionId: "c-kucoin-a", exchange: "kucoin", label: "a", ok: true, data: { a: 2 }, error: null },
    { connectionId: "c-kucoin-b", exchange: "kucoin", label: "b", ok: true, data: { a: 3 }, error: null },
    { connectionId: "c-okx", exchange: "okx", label: null, ok: false, data: null, error: "cex-proxy 502" },
  ],
};

let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  clearConnectionSessionCache();
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = undefined;
  clearConnectionSessionCache();
});

describe("resolveReadTargets (friendly pre-check, not narrowing)", () => {
  it("bare matches every connection", () => {
    assert.deepEqual(resolveReadTargets(ROWS).map((x) => x.id), ["c-kraken", "c-kucoin-a", "c-kucoin-b", "c-okx"]);
  });
  it("--exchange matches ALL same-slug connections, never pool[0]", () => {
    assert.deepEqual(resolveReadTargets(ROWS, "kucoin").map((x) => x.id), ["c-kucoin-a", "c-kucoin-b"]);
  });
  it("unknown slug resolves to zero targets with a friendly error", () => {
    assert.equal(resolveReadTargets(ROWS, "binance").length, 0);
    assert.match(noTargetsError("binance"), /No connection for binance/);
    assert.match(noTargetsError(undefined), /No CEX connections/);
  });
});

describe("cmdBalances fan-out", () => {
  it("bare balances makes ONE server call and prints its venues envelope unchanged", async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    await cmdBalances(
      { json: true, pat: "test-pat" },
      {
        list: async () => ROWS,
        call: async (tool: string, args: unknown) => {
          seen.push({ tool, args });
          return FOUR_VENUES;
        },
      },
    );
    assert.deepEqual(seen, [{ tool: "read_live_datum", args: { kind: "balances" } }]);
    const printed = JSON.parse(logs.join("\n")) as typeof FOUR_VENUES;
    assert.equal(printed.venues.length, 4);
    // per-connection status rides through: ok rows intact, the failed row kept
    const bad = printed.venues.find((v) => v.exchange === "okx")!;
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "cex-proxy 502");
    assert.equal(process.exitCode, undefined);
  });
  it("--exchange narrows server-side to every same-slug connection", async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    await cmdBalances(
      { exchange: "kucoin", json: true, pat: "test-pat" },
      {
        list: async () => ROWS,
        call: async (tool: string, args: unknown) => {
          seen.push({ tool, args });
          return { ...FOUR_VENUES, venues: FOUR_VENUES.venues.slice(1, 3) };
        },
      },
    );
    assert.deepEqual(seen, [{ tool: "read_live_datum", args: { kind: "balances", exchange: "kucoin" } }]);
  });
  it("no matching connection prints the friendly error and calls nothing", async () => {
    let called = 0;
    await cmdBalances(
      { exchange: "binance", json: true, pat: "test-pat" },
      { list: async () => ROWS, call: async () => { called++; return {}; } },
    );
    assert.equal(called, 0);
    assert.match(errors.join("\n"), /No connection for binance/);
    assert.equal(process.exitCode, 1);
  });
});

describe("cmdPositions fan-out", () => {
  const POSITIONS = {
    kind: "positions",
    observedAt: "2026-01-01T00:00:00.000Z",
    venues: [
      { connectionId: "c-kraken", exchange: "kraken", label: null, ok: true, data: { positions: [{ symbol: "BTC/USDT", side: "long", size: 1 }] }, error: null },
      { connectionId: "c-kucoin-a", exchange: "kucoin", label: null, ok: true, data: { positions: [{ symbol: "ETH/USDT", side: "short", size: 2 }] }, error: null },
      { connectionId: "c-kucoin-b", exchange: "kucoin", label: null, ok: true, data: { positions: [] }, error: null },
      { connectionId: "c-okx", exchange: "okx", label: null, ok: false, data: null, error: "cex-proxy 502" },
    ],
  };
  it("bare positions prints the server envelope; --pair filters; empty venues stay empty", async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    await cmdPositions(
      { pair: "BTC/USDT", json: true, pat: "test-pat" },
      {
        list: async () => ROWS,
        call: async (tool: string, args: unknown) => {
          seen.push({ tool, args });
          return POSITIONS;
        },
      },
    );
    // one server call per poll — the server owns the fan-out
    assert.deepEqual(seen, [{ tool: "read_live_datum", args: { kind: "positions", withExits: true } }]);
    const printed = JSON.parse(logs.join("\n")) as typeof POSITIONS;
    assert.equal(printed.venues.length, 4);
    // printed envelope already carries only the BTC/USDT row
    const r = filterPositions(printed, undefined);
    assert.equal(r.total, 1);
    assert.equal(r.kept, 1);
    // the failed venue row survives the pair filter with its error
    const bad = printed.venues.find((v) => v.exchange === "okx")!;
    assert.equal(bad.ok, false);
    // the empty venue stays a real, distinguishable empty
    const emptyVenue = printed.venues.find((v) => v.connectionId === "c-kucoin-b")!;
    assert.deepEqual((emptyVenue.data as { positions: unknown[] }).positions, []);
  });
});

describe("tool-name alignment (CLI -> MCP)", () => {
  it("orders calls list_open_orders with no exchange key when bare", async () => {
    let got: unknown;
    await cmdOrders(
      { json: true, pat: "test-pat" },
      { call: async (tool: string, args: unknown) => { got = { tool, args }; return { venues: [] }; } },
    );
    assert.deepEqual(got, { tool: "list_open_orders", args: {} });
  });
  it("orders forwards --exchange/--pair narrowers when given", async () => {
    let got: unknown;
    await cmdOrders(
      { exchange: "kucoin", pair: "BTC/USDT", json: true, pat: "test-pat" },
      { call: async (tool: string, args: unknown) => { got = { tool, args }; return { venues: [] }; } },
    );
    assert.deepEqual(got, { tool: "list_open_orders", args: { exchange: "kucoin", pair: "BTC/USDT" } });
  });
  it("onchain calls read_onchain_balances (never kind=onchain)", async () => {
    let got: unknown;
    await cmdOnchain(
      { chains: "ethereum,solana", json: true, pat: "test-pat" },
      { call: async (tool: string, args: unknown) => { got = { tool, args }; return { balances: [], aggregate: null }; } },
    );
    assert.deepEqual(got, { tool: "read_onchain_balances", args: { chains: "ethereum,solana" } });
  });
});
