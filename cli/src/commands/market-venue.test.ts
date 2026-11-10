import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearConnectionSessionCache,
  cmdBalances,
  formatVenueRow,
  normalizeVenueFlag,
  shortVenueAddress,
  type Conn,
} from "./market.js";

const ROWS: Conn[] = [
  { id: "c-kucoin-a", exchange: "kucoin", label: "a" },
  { id: "c-kucoin-b", exchange: "kucoin", label: "b" },
];

const VENUE_OUT = {
  venues: [
    {
      venue: "hyperliquid",
      address: "0x581A23e78707f4a1da20710CCa275c67280E0868",
      ok: true,
      equityUsd: "206.896023",
      state: "ok",
      detail: null,
    },
    {
      venue: "dydx",
      address: null,
      ok: false,
      equityUsd: null,
      state: "not-linked",
      detail: "no linked dYdX address",
    },
  ],
  totalUsd: "206.896023",
  partial: true,
  partialReasons: ["dydx: not-linked — no linked dYdX address"],
  observedAt: "2026-11-10T00:00:00.000Z",
};

const CEX_OUT = { kind: "balances", observedAt: "2026-11-10T00:00:00.000Z", venues: [] };

let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  process.exitCode = undefined;
  clearConnectionSessionCache();
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = undefined;
  clearConnectionSessionCache();
});

describe("normalizeVenueFlag", () => {
  it("accepts every registry slug and the hl alias", () => {
    assert.equal(normalizeVenueFlag("hyperliquid"), "hyperliquid");
    assert.equal(normalizeVenueFlag("hl"), "hyperliquid");
    assert.equal(normalizeVenueFlag("all"), "all");
    assert.equal(normalizeVenueFlag("dydx"), "dydx");
  });
  it("rejects unknown venues", () => {
    assert.equal(normalizeVenueFlag("kraken"), null);
    assert.equal(normalizeVenueFlag(""), null);
    assert.equal(normalizeVenueFlag(undefined), null);
  });
});

describe("formatVenueRow", () => {
  it("names the address it read in short form with the money", () => {
    const line = formatVenueRow(VENUE_OUT.venues[0]!);
    assert.match(line, /hyperliquid/);
    assert.match(line, /0x581A…0868/);
    assert.match(line, /\$206\.90/);
  });
  it("states never read as money", () => {
    const line = formatVenueRow(VENUE_OUT.venues[1]!);
    assert.match(line, /not-linked/);
    assert.ok(!line.includes("$0"), "a not-linked row must never print $0");
  });
  it("zero prints as money, not unknown", () => {
    assert.match(formatVenueRow({ venue: "dydx", state: "zero", equityUsd: "0" }), /\$0\.00/);
  });
});

describe("shortVenueAddress", () => {
  it("shortens 0x addresses, passes the rest through", () => {
    assert.equal(shortVenueAddress("0x581A23e78707f4a1da20710CCa275c67280E0868"), "0x581A…0868");
    assert.equal(shortVenueAddress("dydx1abc"), "dydx1abc");
  });
});

describe("cmdBalances --venue", () => {
  it("--venue hl calls read_venue_balances (normalized), never the CEX read", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    await cmdBalances(
      { venue: "hl", json: true, pat: "p" },
      {
        list: async () => ROWS,
        call: async (tool, args) => {
          calls.push({ tool, args });
          return VENUE_OUT;
        },
      },
    );
    assert.deepEqual(
      calls.map((c) => c.tool),
      ["read_venue_balances"],
    );
    assert.deepEqual(calls[0]!.args, { venue: "hyperliquid" });
    assert.equal(JSON.parse(logs.join("\n")).totalUsd, "206.896023");
  });

  it("--venue all prints CEX and venue sides separately, never merged", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    await cmdBalances(
      { venue: "all", exchange: "kucoin", json: true, pat: "p" },
      {
        list: async () => ROWS,
        call: async (tool, args) => {
          calls.push({ tool, args });
          return tool === "read_live_datum" ? CEX_OUT : VENUE_OUT;
        },
      },
    );
    assert.deepEqual(
      calls.map((c) => c.tool),
      ["read_live_datum", "read_venue_balances"],
    );
    assert.deepEqual(calls[0]!.args, { kind: "balances", exchange: "kucoin" });
    const both = JSON.parse(logs.join("\n")) as { cex: unknown; venues: unknown };
    assert.deepEqual(both, { cex: CEX_OUT, venues: VENUE_OUT });
  });

  it("--venue all with no CEX connections still reads the venue legs", async () => {
    const calls: string[] = [];
    await cmdBalances(
      { venue: "all", json: true, pat: "p" },
      {
        list: async () => [],
        call: async (tool) => {
          calls.push(tool);
          return VENUE_OUT;
        },
      },
    );
    assert.deepEqual(calls, ["read_venue_balances"]);
    assert.ok(errors.some((e) => e.includes("no connections")));
    assert.equal(process.exitCode, undefined);
  });

  it("human mode prints one row per venue with the total and partial reasons", async () => {
    await cmdBalances(
      { venue: "hyperliquid", json: false, pat: "p" },
      {
        list: async () => ROWS,
        call: async () => VENUE_OUT,
      },
    );
    const text = logs.join("\n");
    assert.match(text, /venue-held funds/);
    assert.match(text, /hyperliquid/);
    assert.match(text, /total \$206\.90/);
    assert.match(text, /\(partial\)/);
    assert.match(text, /! dydx: not-linked/);
  });

  it("unknown venue fails closed before any call", async () => {
    let called = false;
    await cmdBalances(
      { venue: "kraken", json: true, pat: "p" },
      {
        list: async () => ROWS,
        call: async () => {
          called = true;
          return {};
        },
      },
    );
    assert.equal(called, false);
    assert.equal(process.exitCode, 2);
  });
});
