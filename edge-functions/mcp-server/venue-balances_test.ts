// mcp-server/venue-balances_test.ts — read_venue_balances surface + legs.
//
// Verifies the MATERIALIZED chain (synced _shared/venue-balances.ts +
// agent-chat/read-tools.ts): the TOOLS entry reuses the shared copy by
// construction, and the executor answers the recorded public fixtures
// through the MCP ReadDeps adaptation — no live calls (global fetch stub).
// Run (from edge-functions/mcp-server):
//   deno test --config <scratch deno.json outside both repos> venue-balances_test.ts
import { strict as assert } from "node:assert";
import {
  READ_VENUE_BALANCES_DESCRIPTION,
  READ_VENUE_BALANCES_PARAMETERS,
  VenueHttpError,
} from "../_shared/venue-balances.ts";
import { executeVenueBalancesRead, type ReadDeps } from "../agent-chat/read-tools.ts";
import { TOOLS } from "./tools.ts";

const UNIFIED = "0x581A23e78707f4a1da20710CCa275c67280E0868";

// Recorded 2026-11-10: the funded wallet's HL legs (values verbatim).
const UNIFIED_PERPS = {
  marginSummary: { accountValue: "202.901246", totalMarginUsed: "207.02" },
  crossMaintenanceMarginUsed: "103.51",
  withdrawable: "0.0",
  assetPositions: [],
};
const UNIFIED_SPOT = {
  balances: [{ coin: "USDC", token: 0, total: "206.896023", hold: "206.896023" }],
};

// Recorded 2026-11-10: the funded wallet's keyless Aster presence (values verbatim).
const ASTER_RPC_RESULT = {
  address: UNIFIED,
  accountPrivacy: "disabled",
  perpAssets: [{ asset: "ASTER", walletBalance: 106.49 }],
  spotAssets: [],
};

type Wallet = { chain: string; address: string };

function stubAdmin(wallets: Wallet[]): unknown {
  return {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: async (_k: string, _v: string) => ({
          data: table === "wallets" ? wallets : [],
          error: null,
        }),
      }),
    }),
  };
}

function stubFetch(handler: (url: string, body: unknown) => { status: number; json: unknown }): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch { /* non-JSON body */ }
    const { status, json } = handler(url, body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

function depsFor(wallets: Wallet[]): ReadDeps {
  return {
    admin: stubAdmin(wallets) as ReadDeps["admin"],
    userId: "u1",
    supaUrl: "https://x.invalid",
    authHeader: "Bearer t",
    callEdge: async () => {
      throw new Error("venue reads never ride callEdge");
    },
  };
}

Deno.test("venue: read_venue_balances is registered read-only with the shared copy", () => {
  const found = (TOOLS as Array<{ name: string }>).find((t) => t.name === "read_venue_balances");
  assert.ok(found, "TOOLS lost read_venue_balances");
  const tool = found as unknown as {
    annotations: { readOnlyHint?: boolean };
    description: string;
    inputSchema: unknown;
  };
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.description, READ_VENUE_BALANCES_DESCRIPTION);
  assert.equal(tool.inputSchema, READ_VENUE_BALANCES_PARAMETERS);
});

Deno.test("venue: HL unified fixture totals the spot leg only (no double count)", async () => {
  const restore = stubFetch((url, body) => {
    if (!url.includes("hyperliquid")) throw new Error(`unexpected venue call: ${url}`);
    const t = (body as { type?: string }).type;
    if (t === "clearinghouseState") return { status: 200, json: UNIFIED_PERPS };
    if (t === "spotClearinghouseState") return { status: 200, json: UNIFIED_SPOT };
    return { status: 200, json: "unifiedAccount" };
  });
  try {
    const out = await executeVenueBalancesRead(
      { venue: "hyperliquid" },
      depsFor([{ chain: "ethereum", address: UNIFIED }]),
    );
    assert.equal(out.totalUsd, "206.896023");
    assert.equal(out.partial, false);
  } finally {
    restore();
  }
});

Deno.test("venue: standard fixture sums perps + spot once", async () => {
  const restore = stubFetch((url, body) => {
    const t = (body as { type?: string }).type;
    if (t === "clearinghouseState") {
      return { status: 200, json: { marginSummary: { accountValue: "2.0" }, withdrawable: "2.0", assetPositions: [] } };
    }
    if (t === "spotClearinghouseState") {
      return { status: 200, json: { balances: [{ coin: "USDC", total: "7.67147473", hold: "0.0" }] } };
    }
    return { status: 200, json: "default" };
  });
  try {
    const out = await executeVenueBalancesRead(
      { venue: "hyperliquid" },
      depsFor([{ chain: "ethereum", address: UNIFIED }]),
    );
    assert.equal(out.totalUsd, "9.67147473");
  } finally {
    restore();
  }
});

Deno.test("venue: Aster fixture values 106.49 ASTER at the USDT mark", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("tapi.asterdex")) {
      return { status: 200, json: { jsonrpc: "2.0", id: 1, result: ASTER_RPC_RESULT } };
    }
    if (url.includes("premiumIndex")) return { status: 200, json: [{ symbol: "ASTERUSDT", markPrice: "0.6477" }] };
    if (url.includes("ticker/24hr")) return { status: 200, json: [] };
    throw new Error(`unexpected venue call: ${url}`);
  });
  try {
    const out = (await executeVenueBalancesRead(
      { venue: "aster" },
      depsFor([{ chain: "ethereum", address: UNIFIED }]),
    )) as { venues: Array<{ state: string; equityUsd: string | null }> };
    assert.equal(out.venues[0]?.state, "ok");
    assert.equal(out.venues[0]?.equityUsd, "68.9736");
  } finally {
    restore();
  }
});

Deno.test("venue: dYdX 404 is honest zero, never an error", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("indexer.dydx")) throw new VenueHttpError("Indexer 404", 404);
    throw new Error(`unexpected venue call: ${url}`);
  });
  try {
    const out = (await executeVenueBalancesRead(
      { venue: "dydx" },
      depsFor([{ chain: "dydx", address: "dydx1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqg9h5lq" }]),
    )) as { venues: Array<{ state: string; equityUsd: string | null }> };
    assert.equal(out.venues[0]?.state, "zero");
    assert.equal(out.venues[0]?.equityUsd, "0");
  } finally {
    restore();
  }
});

Deno.test("venue: one-venue failure keeps a partial total over the legs that answered", async () => {
  const restore = stubFetch((url, body) => {
    if (url.includes("tapi.asterdex")) {
      return { status: 200, json: { jsonrpc: "2.0", id: 1, result: ASTER_RPC_RESULT } };
    }
    if (url.includes("fapi.asterdex")) {
      return { status: 200, json: [{ symbol: "ASTERUSDT", markPrice: "0.6477" }] };
    }
    if (url.includes("hyperliquid")) {
      void body;
      throw new VenueHttpError("HL down", 502);
    }
    throw new Error(`unexpected venue call: ${url}`);
  });
  try {
    const out = (await executeVenueBalancesRead(
      { venue: "all" },
      depsFor([{ chain: "ethereum", address: UNIFIED }]),
    )) as {
      venues: Array<{ venue: string; state: string }>;
      totalUsd: string | null;
      partial: boolean;
      partialReasons: string[];
    };
    const byVenue = new Map(out.venues.map((r) => [r.venue, r.state]));
    assert.equal(byVenue.get("hyperliquid"), "error");
    assert.equal(byVenue.get("aster"), "ok");
    // Only the answered legs sum: 68.9736 (Aster); HL contributes nothing.
    assert.equal(out.totalUsd, "68.9736");
    assert.equal(out.partial, true);
    assert.ok(out.partialReasons.some((r) => r.startsWith("hyperliquid")));
  } finally {
    restore();
  }
});
