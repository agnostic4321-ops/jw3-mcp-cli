/**
 * mcp-server surface guard: tools vs agent-chat parity, no dead tools,
 * no duplicated schemas, labeled errors.
 *
 * - read_live_datum / list_connections / read_diary_day / read_risk_limits
 *   must reuse the shared read-tools.ts constants (parity by construction,
 *   not by duplicated literals).
 * - analyze_market must document the ONE shared JEV contract with a
 *   consult_jev-compatible schema (family + venue/symbol/snapshot).
 * - Every TOOLS entry must have a handler branch in index.ts (no dead tools).
 * - Every toolError call in this dir must carry a machine-readable label
 *   prefix (validation|upstream|not_found|auth|blocked|internal).
 */
import { strict as assert } from "node:assert";
import {
  ANALYZE_MARKET_PARAMETERS,
  TOOLS,
  rpcError,
  rpcOk,
  toolError,
  toolOk,
} from "./tools.ts";
import {
  LIST_CONNECTIONS_DESCRIPTION,
  READ_DIARY_DAY_DESCRIPTION,
  READ_DIARY_DAY_PARAMETERS,
  READ_LIVE_DATUM_PARAMETERS,
  READ_RISK_LIMITS_DESCRIPTION,
  READ_RISK_LIMITS_PARAMETERS,
} from "../agent-chat/read-tools.ts";
import { JEV_CONSULT_CONTRACT } from "../agent-chat/jev-gate.ts";

type ToolDef = {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
};

const tools = TOOLS as unknown as ToolDef[];
const byName = (name: string): ToolDef => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`mcp tool missing: ${name}`);
  return found;
};

async function handlerSource(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("mcp tools: names are unique and the surface stays complete", () => {
  const names = tools.map((t) => t.name);
  if (names.length < 12) throw new Error(`tool surface shrank unexpectedly (${names.length} tools)`);
  if (new Set(names).size !== names.length) {
    throw new Error(`duplicate mcp tool names: ${names.join(", ")}`);
  }
  for (const t of tools) {
    if (!t.description) throw new Error(`tool without a description: ${t.name}`);
    if (t.inputSchema?.additionalProperties !== false) {
      throw new Error(`tool schema not closed: ${t.name}`);
    }
  }
});

Deno.test("mcp tools: read transports reuse the shared chat schemas (no copies)", () => {
  assert.equal(byName("read_live_datum").inputSchema, READ_LIVE_DATUM_PARAMETERS);
  assert.equal(byName("read_diary_day").description, READ_DIARY_DAY_DESCRIPTION);
  assert.equal(byName("read_diary_day").inputSchema, READ_DIARY_DAY_PARAMETERS);
  assert.equal(byName("read_risk_limits").description, READ_RISK_LIMITS_DESCRIPTION);
  assert.equal(byName("read_risk_limits").inputSchema, READ_RISK_LIMITS_PARAMETERS);
  assert.equal(byName("list_connections").description, LIST_CONNECTIONS_DESCRIPTION);
});

Deno.test("mcp tools: analyze_market shares the JEV contract + consult_jev shape", () => {
  const analyze = byName("analyze_market");
  assert.equal(analyze.description, JEV_CONSULT_CONTRACT);
  assert.equal(analyze.inputSchema, ANALYZE_MARKET_PARAMETERS);
  const props = Object.keys(ANALYZE_MARKET_PARAMETERS.properties);
  for (const field of ["family", "venue", "symbol", "snapshot"]) {
    if (!props.includes(field)) throw new Error(`analyze_market lost field: ${field}`);
  }
  if (!ANALYZE_MARKET_PARAMETERS.required.includes("family")) {
    throw new Error("analyze_market lost required family");
  }
});

Deno.test("mcp tools: every tool has a handler branch (no dead tools)", async () => {
  const index = await handlerSource("./index.ts");
  for (const t of tools) {
    if (t.name === "execute_trade") {
      // Lives in ./execute.ts, delegated from index.ts.
      const exec = await handlerSource("./execute.ts");
      if (!exec.includes("handleExecuteTrade")) {
        throw new Error("execute_trade has no handler in execute.ts");
      }
    }
    if (t.name === "daily_prep") {
      // Lives in ./daily-prep.ts, delegated from index.ts.
      const dp = await handlerSource("./daily-prep.ts");
      if (!dp.includes("handleDailyPrep")) {
        throw new Error("daily_prep has no handler in daily-prep.ts");
      }
    }
    if (!index.includes(`name === "${t.name}"`)) {
      throw new Error(`mcp-server/index.ts has no branch for tool: ${t.name}`);
    }
  }
});

Deno.test("mcp tools: toolError envelope carries isError + labeled text", async () => {
  const res = toolError("1", "validation: demo failure") as Response;
  assert.equal(res.status, 200);
  const body = await res.json() as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]!.text, /^validation: /);
  const okRes = toolOk("1", { a: 1 }) as Response;
  const okBody = await okRes.json() as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(okBody.result.isError, undefined);
  const rpc = await (rpcError("1", -32001, "auth: nope") as Response).json();
  assert.equal((rpc as { error: { code: number } }).error.code, -32001);
  const rpcOkBody = await (rpcOk("1", {}) as Response).json();
  assert.equal((rpcOkBody as { id: string }).id, "1");
});

Deno.test("mcp tools: toolOk never cuts mid-JSON — oversize payloads get a parseable envelope", async () => {
  // Small payloads pass through byte-identical.
  const small = { a: 1, b: "x" };
  const smallRes = toolOk("1", small) as Response;
  const smallBody = await smallRes.json() as { result: { content: Array<{ text: string }> } };
  assert.equal(smallBody.result.content[0]!.text, JSON.stringify(small));
  JSON.parse(smallBody.result.content[0]!.text);
  // A busy-window payload (500 fills × venue-shaped rows) must NOT come back
  // as sliced JSON: the transport returns a valid-JSON truncation envelope
  // with a narrow-and-page-again hint instead.
  const big = { fills: Array.from({ length: 500 }, (_, i) => ({ execId: `e${i}`, symbol: "BTC/USDT", price: 1, blob: "y".repeat(500) })) };
  assert.ok(JSON.stringify(big).length > 12000, "fixture must exceed the old slice point");
  const bigRes = toolOk("2", big) as Response;
  const bigBody = await bigRes.json() as { result: { content: Array<{ text: string }> } };
  const text = bigBody.result.content[0]!.text;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.truncated, true);
  assert.ok(typeof parsed.hint === "string" && String(parsed.hint).includes("narrow"));
  assert.ok(text.length <= 12000, `guard envelope ${text.length} chars exceeds the hard cap`);
});

Deno.test("mcp tools: cap-safe fills/pnl builders stay under budget (pins the toolOk guard)", async () => {
  const { buildMcpFillsPayload, buildMcpPnlPayload, TOOL_MESSAGE_BUDGET_CHARS } =
    await import("../agent-chat/read-tools.ts");
  const fills = Array.from({ length: 500 }, (_, i) => ({
    execId: `e${i}`, symbol: "BTC/USDT", side: "buy", price: 67000 + i, qty: 0.01,
    fee: 0.05, execTime: 1_700_000_000_000 + i * 1000, market: "futures",
    raw: { blob: "y".repeat(500) },
  }));
  const fillsPayload = buildMcpFillsPayload({
    exchange: "kucoin", market: "all", sinceMs: 0,
    fills: fills as Array<Record<string, unknown>>, limit: 500,
  }) as Record<string, unknown>;
  const fillsText = JSON.stringify(fillsPayload);
  assert.ok(fillsText.length <= TOOL_MESSAGE_BUDGET_CHARS, `fills payload ${fillsText.length} exceeds budget`);
  JSON.parse(fillsText);
  assert.equal((fillsPayload.totals as { matched: number }).matched, 500);
  assert.equal(fillsPayload.truncated, true);
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: `t${i}`, symbol: "ETH/USDT", side: "long", pnl: i % 2 === 0 ? 1.5 : -0.5,
    fees: 0.1, closedAt: 1_700_000_000_000 + i * 1000, raw: { blob: "z".repeat(500) },
  }));
  const pnlPayload = buildMcpPnlPayload({
    exchange: "kucoin", sinceMs: 0,
    rows: rows as Array<Record<string, unknown>>, limit: 300,
  }) as Record<string, unknown>;
  const pnlText = JSON.stringify(pnlPayload);
  assert.ok(pnlText.length <= TOOL_MESSAGE_BUDGET_CHARS, `pnl payload ${pnlText.length} exceeds budget`);
  JSON.parse(pnlText);
  // Totals cover the FULL window even when the page is capped.
  assert.equal(pnlPayload.wins, 150);
  assert.equal(pnlPayload.losses, 150);
});

Deno.test("mcp tools: every toolError call site carries a label prefix", async () => {
  const labels = ["validation:", "upstream:", "not_found:", "auth:", "blocked:", "internal:"];
  for (const rel of ["./index.ts", "./execute.ts", "./daily-prep.ts"]) {
    const src = await handlerSource(rel);
    // Single-line call sites: the string literal opens right after the id.
    const re = /toolError\((?:body\.id|id),\s*(["'`])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const quote = m[1];
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const tagged = labels.some((l) => rest.startsWith(l));
      if (quote === "`" && rest.startsWith("${")) continue; // dynamic prefix — reviewed by hand
      if (!tagged) {
        throw new Error(`${rel} has an unlabeled toolError near: …${rest.slice(0, 60)}`);
      }
    }
  }
});
