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
  ANONYMOUS_METHODS,
  DEFI_BUILD_ACTIONS,
  DEFI_SLIPPAGE_DEFAULT_BPS,
  DEFI_SLIPPAGE_MAX_BPS,
  DEFAULT_TOOL_RATE_LIMIT,
  IDEMPOTENCY_KEY_MAX_LEN,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MAX_PROPOSAL_JEV_CHARS,
  MAX_PROPOSAL_QUESTION_CHARS,
  MAX_PROPOSAL_RATIONALE_CHARS,
  MAX_PROPOSAL_THESIS_CHARS,
  PROTECTION_TOOL_RATE_LIMIT,
  TOOLS,
  anonymousDiscovery,
  clampSlippageBps,
  isEvmTokenAddress,
  isWalletAddress,
  normalizeDefiChainId,
  normalizeIdempotencyKey,
  parseDefiAmount,
  protectedResourceDoc,
  rpcAuthChallenge,
  rpcError,
  rpcOk,
  toolError,
  toolOk,
  toolRateLimitFor,
  validateArgsAgainstSchema,
  validateChainsCsv,
  validateMarketId,
  validateOptionalPositiveNumber,
  validatePairSymbol,
  validatePositiveNumber,
  validatePriceTargets,
  validateProposalText,
  validateProposeSide,
  validateTokenId,
  validateVenueSlug,
  validateWalletsCsv,
} from "./tools.ts";
import { validateExecuteTradeFields } from "./execute.ts";
import {
  LIST_CONNECTIONS_DESCRIPTION,
  READ_DIARY_DAY_DESCRIPTION,
  READ_DIARY_DAY_PARAMETERS,
  READ_LIVE_DATUM_PARAMETERS,
  READ_RISK_LIMITS_DESCRIPTION,
  READ_RISK_LIMITS_PARAMETERS,
} from "../agent-chat/read-tools.ts";
import { JEV_CONSULT_CONTRACT } from "../agent-chat/jev-gate.ts";
import {
  NEWS_BRIEF_DESCRIPTION,
  NEWS_BRIEF_PARAMETERS,
} from "../agent-chat/news-brief.ts";

type ToolDef = {
  name: string;
  title?: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
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

Deno.test("mcp tools: read_news_brief reuses the shared chat schema (no copy)", () => {
  const news = byName("read_news_brief");
  assert.equal(news.description, NEWS_BRIEF_DESCRIPTION);
  assert.equal(news.inputSchema, NEWS_BRIEF_PARAMETERS);
  // External RSS fetch: open-world read, same as the defi reader.
  assert.equal(news.annotations?.readOnlyHint, true);
  assert.equal(news.annotations?.openWorldHint, true);
  // Pair is optional — omit it for all three assets. Source, limit and
  // window_hrs are optional narrowers on top (feed filter, per-cluster
  // items, harvest window).
  assert.deepEqual(news.inputSchema.required ?? [], []);
  const props = Object.keys(news.inputSchema.properties ?? {});
  assert.deepEqual(props, ["pair", "source", "limit", "window_hrs"]);
});

Deno.test("mcp tools: get_insights is a read-only, closed-schema insight reader", () => {
  const insights = byName("get_insights");
  // Read-only + open-world: it reads journal/fill history, moves nothing.
  assert.equal(insights.annotations?.readOnlyHint, true);
  assert.equal(insights.annotations?.openWorldHint, true);
  assert.equal(insights.inputSchema.additionalProperties, false);
  // Every narrower is optional — bare call returns the full insight set.
  assert.deepEqual(insights.inputSchema.required ?? [], []);
  const props = Object.keys(insights.inputSchema.properties ?? {});
  assert.deepEqual(props, ["days", "notional_usd", "fee_bps"]);
  // The prefix and the "gaps" hook are the contract the agent prompt relies on.
  const description = insights.description;
  assert.ok(
    description.startsWith("READ-ONLY:"),
    `get_insights description must start with READ-ONLY: (got: ${description.slice(0, 40)})`,
  );
  assert.ok(
    description.toLowerCase().includes("gaps"),
    "get_insights description must mention gaps",
  );
  // First sentence must not read like an action tool.
  const firstSentence = description.split(/[.!?]/)[0] ?? "";
  const movingVerb = /\b(place|submit|swap|bridge|execute|sign|transfer|approve)\b/i;
  assert.ok(
    !movingVerb.test(firstSentence),
    `get_insights first sentence implies a fund-moving action: ${firstSentence}`,
  );
});

Deno.test("mcp tools: propose_diary_note mirrors the chat approval write (no new execution)", () => {
  const note = byName("propose_diary_note");
  assert.deepEqual(note.inputSchema.required ?? [], ["body_md"]);
  const props = Object.keys(note.inputSchema.properties ?? {});
  assert.deepEqual(props, ["day", "body_md", "mode"]);
  // A diary write is state-changing (append retries would duplicate text).
  assert.equal(note.annotations?.readOnlyHint, false);
  assert.equal(note.annotations?.idempotentHint, false);
});

Deno.test("mcp tools: cycle-05 proposal cards are approval-only (never auto-executed)", () => {
  const expected: Array<{ name: string; required: string[]; props: string[] }> = [
    { name: "propose_trade_ideas", required: ["ideas", "rationale"], props: ["ideas", "rationale", "jev_verdict"] },
    {
      name: "propose_bracket",
      required: ["exchange", "pair", "side", "entry_type", "amount", "stop_price", "take_profits", "rationale"],
      props: ["exchange", "pair", "side", "entry_type", "entry_price", "amount", "stop_price", "fee_usd", "take_profits", "rationale"],
    },
    {
      name: "propose_predict_market",
      required: ["market_id", "side", "rationale", "jev_verdict"],
      props: ["market_id", "question", "side", "amount", "venue", "jev_verdict", "confidence", "rationale"],
    },
    {
      name: "propose_close_all_positions",
      required: ["rationale"],
      props: ["exchange", "pair", "order_type", "limit_price", "rationale"],
    },
  ];
  for (const { name, required, props } of expected) {
    const tool = byName(name);
    assert.deepEqual(tool.inputSchema.required ?? [], required);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), props);
    // Proposal tools only write an approval card (additive: nothing moves
    // until the user approves in-app), so destructiveHint stays false; a
    // retry would duplicate the card, so idempotentHint is false too.
    assert.equal(tool.annotations?.readOnlyHint, false, `${name} must not claim readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name} moves nothing itself`);
    assert.equal(tool.annotations?.idempotentHint, false, `${name} is not idempotent`);
    if (!tool.description.includes("APPROVAL CARD ONLY")) {
      throw new Error(`${name} description lost the approval-card-only copy`);
    }
    if (!tool.description.includes("trade:propose")) {
      throw new Error(`${name} description lost the trade:propose scope pointer`);
    }
  }
});

Deno.test("mcp hardening: proposal-card validators reject placeholders and bad shapes", () => {
  // Sides: long|short aliases normalize, anything else refuses.
  assert.deepEqual(validateProposeSide("long"), { ok: true, side: "buy" });
  assert.deepEqual(validateProposeSide("SHORT"), { ok: true, side: "sell" });
  assert.equal(validateProposeSide("flat").ok, false);
  // Required text: empty refused, overlong refused.
  assert.equal(validateProposalText("", "rationale", MAX_PROPOSAL_RATIONALE_CHARS).ok, false);
  assert.equal(validateProposalText("x".repeat(MAX_PROPOSAL_RATIONALE_CHARS + 1), "rationale", MAX_PROPOSAL_RATIONALE_CHARS).ok, false);
  assert.equal(validateProposalText("ok", "rationale", MAX_PROPOSAL_RATIONALE_CHARS).ok, true);
  // Positive numbers: 0/null/NaN refused — never a placeholder price.
  assert.equal(validatePositiveNumber(0, "entry").ok, false);
  assert.equal(validatePositiveNumber("abc", "entry").ok, false);
  assert.equal(validatePositiveNumber("65000", "entry").ok, true);
  assert.deepEqual(validateOptionalPositiveNumber(undefined, "fee_usd"), { ok: true, value: null });
  // Targets: 1–3 legs, price > 0, weight/fraction 0..1, normalized to weight.
  const legs = validatePriceTargets([{ price: 65000, fraction: 0.5 }, { price: 66000 }], "take_profits");
  if (!legs.ok) throw new Error("valid legs refused");
  assert.deepEqual(legs.targets, [{ price: 65000, weight: 0.5 }, { price: 66000, weight: null }]);
  const weighted = validatePriceTargets([{ price: 65000, weight: 0.25 }], "targets");
  if (!weighted.ok) throw new Error("valid weighted leg refused");
  assert.equal(validatePriceTargets([], "take_profits").ok, false);
  assert.equal(validatePriceTargets([1, 2, 3, 4].map((price) => ({ price })), "take_profits").ok, false);
  assert.equal(validatePriceTargets([{ price: 0 }], "take_profits").ok, false);
  assert.equal(validatePriceTargets([{ price: 65000, weight: 2 }], "take_profits").ok, false);
  // Caps are the agent-chat slice widths so harness rows read identically.
  assert.equal(MAX_PROPOSAL_RATIONALE_CHARS, 1000);
  assert.equal(MAX_PROPOSAL_THESIS_CHARS, 2000);
  assert.equal(MAX_PROPOSAL_JEV_CHARS, 1000);
  assert.equal(MAX_PROPOSAL_QUESTION_CHARS, 500);
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

Deno.test("mcp hardening: heavy tools cost more than default reads", () => {
  for (const name of ["daily_prep", "analyze_market", "list_fills", "read_closed_pnl", "reconcile_realized_pnl"]) {
    const b = toolRateLimitFor(name, false);
    if (b.limit > DEFAULT_TOOL_RATE_LIMIT.limit) {
      throw new Error(`${name} budget (${b.limit}) is not lower than the default`);
    }
    if (b.bucket === DEFAULT_TOOL_RATE_LIMIT.bucket) {
      throw new Error(`${name} shares the default bucket: heavy fan-out must be isolated`);
    }
  }
  assert.equal(toolRateLimitFor("set_exits", true).bucket, PROTECTION_TOOL_RATE_LIMIT.bucket);
  assert.equal(toolRateLimitFor("cancel_order", true).bucket, PROTECTION_TOOL_RATE_LIMIT.bucket);
  assert.equal(toolRateLimitFor("read_live_datum", false).bucket, DEFAULT_TOOL_RATE_LIMIT.bucket);
});

Deno.test("mcp tools: list_open_orders fans out like chat open_orders (exchange optional)", async () => {
  const orders = byName("list_open_orders");
  // Chat open_orders shape wins: every narrower is optional, bare call reads
  // every active connection. required must NOT pin exchange.
  assert.deepEqual(orders.inputSchema.required ?? [], []);
  assert.deepEqual(Object.keys(orders.inputSchema.properties ?? {}), ["exchange", "connectionId", "pair"]);
  assert.equal(orders.annotations?.readOnlyHint, true);
  // Bare {} validates (no exchange key at all).
  assert.equal(validateArgsAgainstSchema(orders.inputSchema, {}), null);
  // The handler must ride the shared fan-out reader, not a single-target
  // resolve — parity with agent-chat by construction, not by copy.
  const index = await handlerSource("./index.ts");
  const rest = index.slice(index.indexOf('if (name === "list_open_orders")'));
  const nextBranch = rest.indexOf('if (name === "', 10);
  const branch = nextBranch > 0 ? rest.slice(0, nextBranch) : rest;
  if (!branch.includes("executeOpenOrdersRead")) {
    throw new Error("list_open_orders handler bypasses the shared executeOpenOrdersRead fan-out");
  }
  if (branch.includes("resolveOrderTarget")) {
    throw new Error("list_open_orders handler still single-targets via resolveOrderTarget");
  }
});

Deno.test("mcp hardening: selectors are allowlisted and bounded", () => {
  assert.equal(validateVenueSlug("KuCoin").ok, true);
  assert.equal(validateVenueSlug("nope").ok, false);
  const chains = validateChainsCsv("ethereum,bitcoin,solana");
  if (!chains.ok) throw new Error(`valid chains rejected: ${chains.error}`);
  assert.equal(chains.chains, "ethereum,btc,solana");
  assert.equal(validateChainsCsv("nope").ok, false);
  assert.equal(validateChainsCsv(new Array(11).fill("ethereum").join(",")).ok, false);
  assert.equal(validateMarketId("0xabc").ok, true);
  assert.equal(validateMarketId("bad id!").ok, false);
  assert.equal(validateTokenId("123").ok, true);
  assert.equal(validateTokenId("").ok, false);
  assert.equal(validatePairSymbol("BTC/USDT").ok, true);
  assert.equal(validatePairSymbol("BTC/USDT;DROP").ok, false);
  assert.equal(validateWalletsCsv(`0x${"ab".repeat(20)}`).ok, true);
  assert.equal(validateWalletsCsv("not-an-address").ok, false);
});

Deno.test("mcp hardening: defi builders are allowlisted and bounded", () => {
  assert.ok(!(DEFI_BUILD_ACTIONS as readonly string[]).includes("drain"));
  const eth = normalizeDefiChainId("ethereum");
  if (!eth.ok || eth.chainId !== "1") throw new Error("ethereum slug must map to chain 1");
  assert.equal(normalizeDefiChainId("999").ok, false);
  assert.equal(parseDefiAmount("1.5"), 1.5);
  assert.equal(parseDefiAmount("-1"), null);
  assert.equal(parseDefiAmount("1e13"), null);
  assert.equal(clampSlippageBps(5000), DEFI_SLIPPAGE_MAX_BPS);
  assert.equal(clampSlippageBps(-5), DEFI_SLIPPAGE_DEFAULT_BPS);
  assert.equal(isWalletAddress(`0x${"ab".repeat(20)}`), true);
  assert.equal(isWalletAddress("nope"), false);
  assert.equal(isEvmTokenAddress("0x0000000000000000000000000000000000000000"), true);
});

Deno.test("mcp hardening: central schema validation rejects bad shapes", () => {
  const exec = byName("execute_trade").inputSchema;
  assert.equal(validateArgsAgainstSchema(exec, { exchange: "kucoin", pair: "BTC/USDT", side: "buy" }), null);
  const missing = validateArgsAgainstSchema(exec, { pair: "BTC/USDT", side: "buy" }) ?? "";
  assert.match(missing, /exchange/);
  const unknown = validateArgsAgainstSchema(exec, { exchange: "kucoin", pair: "BTC/USDT", side: "buy", bogus: 1 }) ?? "";
  assert.match(unknown, /unknown field/);
  const side = validateArgsAgainstSchema(exec, { exchange: "kucoin", pair: "BTC/USDT", side: "hold" }) ?? "";
  assert.match(side, /side/);
  const lev = validateArgsAgainstSchema(exec, { exchange: "kucoin", pair: "BTC/USDT", side: "buy", leverage: "high" }) ?? "";
  assert.match(lev, /leverage/);
});

Deno.test("mcp hardening: read_live_datum accepts legacy withExits flag", () => {
  // Older CLI versions (daemon/loop/market/watchdog/heat/monitor) send
  // withExits:true on positions reads. The flag is accepted for backward
  // compatibility; exits enrichment is always on for positions.
  const schema = byName("read_live_datum").inputSchema;
  assert.equal(validateArgsAgainstSchema(schema, { kind: "positions", withExits: true }), null);
  assert.equal(validateArgsAgainstSchema(schema, { kind: "positions" }), null);
});

Deno.test("mcp auth discovery: protected-resource doc + 401 challenge shape", async () => {
  const doc = protectedResourceDoc("https://x.supabase.co/functions/v1/mcp-server");
  assert.equal(doc.resource, "https://x.supabase.co/functions/v1/mcp-server");
  assert.deepEqual(doc.authorization_servers, ["https://www.jw3.ai/mcp"]);
  for (const s of ["mcp:read", "trade:propose", "trade:execute"]) {
    if (!(doc.scopes_supported as string[]).includes(s)) throw new Error(`doc lost scope: ${s}`);
  }
  const res = rpcAuthChallenge(7, "https://x.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource", "unauthorized: bad credentials (ref test)");
  assert.equal(res.status, 401);
  const www = res.headers.get("www-authenticate") ?? "";
  if (!www.includes('resource_metadata="https://x.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource"')) {
    throw new Error(`challenge lost resource_metadata: ${www}`);
  }
  const body = await res.json() as { jsonrpc: string; id: number; error: { code: number } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 7);
  assert.equal(body.error.code, -32001);
});

Deno.test("mcp hardening: execute_trade declares every handled field", () => {
  const props = Object.keys(byName("execute_trade").inputSchema.properties ?? {});
  for (const f of ["actor", "leverage", "marginMode", "clientOid", "idempotency_key", "type"]) {
    if (!props.includes(f)) throw new Error(`execute_trade lost declared field: ${f}`);
  }
});

Deno.test("mcp hardening: execute_trade field validators reject unknowns", () => {
  const good = validateExecuteTradeFields({
    exchange: "kucoin", pair: "BTC/USDT", side: "buy", actor: "machine",
    leverage: 5, marginMode: "cross", clientOid: "abc-123", type: "market", idempotency_key: "k1",
  });
  if (!good.ok) throw new Error(`valid fields rejected: ${good.error}`);
  assert.equal(good.fields.actor, "machine");
  for (const bad of [
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", actor: "someone" },
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", leverage: 1000 },
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", marginMode: "wild" },
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", clientOid: "bad oid!" },
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", type: "stop" },
    { exchange: "kucoin", pair: "BTC/USDT", side: "buy", idempotency_key: "bad key!" },
    { exchange: "kucoin", pair: "BTC/USDT", side: "hold" },
    { exchange: "nope", pair: "BTC/USDT", side: "buy" },
  ]) {
    if (validateExecuteTradeFields(bad).ok) {
      throw new Error(`invalid fields accepted: ${JSON.stringify(bad)}`);
    }
  }
});

Deno.test("mcp hardening: idempotency keys normalize deterministically", () => {
  assert.equal(normalizeIdempotencyKey("  k1  "), "k1");
  assert.equal(normalizeIdempotencyKey(""), null);
  assert.equal(normalizeIdempotencyKey("   "), null);
  const long = "a".repeat(200);
  const norm = normalizeIdempotencyKey(long);
  assert.ok(norm !== null && norm.length === IDEMPOTENCY_KEY_MAX_LEN, "overlong keys truncate to the indexed length");
  assert.equal(normalizeIdempotencyKey(long), norm, "normalization is deterministic");
});

Deno.test("mcp hardening: idempotency is honored end to end", async () => {
  const { handleExecuteTrade } = await import("./execute.ts");
  const orderArgs = {
    exchange: "kucoin", pair: "BTC/USDT", side: "buy", amount: "0.01",
    type: "market", actor: "machine", leverage: 5, marginMode: "cross",
    clientOid: "abc-123", idempotency_key: "test-key-1",
  };
  const makeAdmin = (priorRows: Array<{ status: string; result: unknown }>) => {
    const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
    const chain = (data: unknown, error: unknown = null): Record<string, unknown> => {
      const self: Record<string, unknown> = { data, error };
      for (const m of ["select", "eq", "gte", "filter", "order", "limit", "single", "maybeSingle", "in"]) {
        self[m] = (..._a: unknown[]) => self;
      }
      return self;
    };
    const admin = {
      calls,
      from(table: string) {
        return {
          select: (..._a: unknown[]) => {
            if (table === "exchange_connections") {
              return chain([{ id: "c1", exchange: "kucoin", status: "active" }]);
            }
            if (table === "agent_action_log") return chain(priorRows);
            if (table === "risk_limits") return chain(null);
            return chain([]);
          },
          insert: (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return chain({ id: "setup-1" });
          },
          update: (payload: unknown) => {
            calls.push({ table, op: "update", payload });
            return chain([]);
          },
        };
      },
    };
    return admin;
  };
  // First submit dispatches once, forwards the key, logs it top level.
  const edgeCalls: Array<{ slug: string; body: unknown }> = [];
  const callEdge = (_base: string, _auth: string, slug: string, body: Record<string, unknown>, _ms?: number) => {
    edgeCalls.push({ slug, body });
    return Promise.resolve({ ok: true, orderId: "order-1" });
  };
  const admin1 = makeAdmin([]);
  const ctx1 = {
    admin: admin1 as never, userId: "u1", supaUrl: "https://x",
    authHeader: "Bearer t", viaPat: false, scopes: [], callEdge: callEdge as never,
  };
  const res1 = await handleExecuteTrade(ctx1, "id-1", { ...orderArgs }) as Response;
  assert.equal(res1.status, 200);
  const text1 = (await res1.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  JSON.parse(text1);
  assert.equal(edgeCalls.length, 1, "first submit must dispatch exactly once");
  const sent = edgeCalls[0]!.body as Record<string, unknown>;
  assert.equal(sent.idempotency_key, "test-key-1");
  assert.equal(sent.actor, "machine");
  assert.equal(sent.leverage, 5);
  assert.equal(sent.marginMode, "cross");
  assert.equal(sent.clientOid, "abc-123");
  assert.equal(sent.type, "market");
  const logInsert = admin1.calls.find((c) => c.table === "agent_action_log" && c.op === "insert");
  assert.ok(logInsert, "execution must be logged");
  assert.equal((logInsert!.payload as { params: Record<string, unknown> }).params.idempotency_key, "test-key-1");
  // Second submit under the same key replays without dispatching again.
  const edgeCalls2: Array<{ slug: string; body: unknown }> = [];
  const callEdge2 = (_base: string, _auth: string, slug: string, body: Record<string, unknown>, _ms?: number) => {
    edgeCalls2.push({ slug, body });
    return Promise.resolve({ ok: true, orderId: "order-1" });
  };
  const admin2 = makeAdmin([{ status: "executed", result: { orderId: "order-1" } }]);
  const ctx2 = {
    admin: admin2 as never, userId: "u1", supaUrl: "https://x",
    authHeader: "Bearer t", viaPat: false, scopes: [], callEdge: callEdge2 as never,
  };
  const res2 = await handleExecuteTrade(ctx2, "id-2", { ...orderArgs }) as Response;
  const text2 = (await res2.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  const replay = JSON.parse(text2) as Record<string, unknown>;
  assert.equal(replay.deduped, true);
  assert.equal(edgeCalls2.length, 0, "replay must not dispatch again");
});

Deno.test("mcp anonymous discovery: allowlist holds exactly the discovery methods", () => {
  assert.deepEqual([...ANONYMOUS_METHODS], ["initialize", "notifications/initialized", "ping", "tools/list"]);
});

Deno.test("mcp anonymous discovery: initialize returns 200 with protocolVersion and serverInfo", async () => {
  const res = anonymousDiscovery(null, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.ok(res instanceof Response, "anonymous initialize must dispatch without a token");
  assert.equal(res.status, 200);
  const body = await res.json() as { jsonrpc: string; id: number; result: { protocolVersion: string; serverInfo: unknown } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  // Same negotiation + server identity as the authenticated initialize
  // path (both read the one shared pair of consts).
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(body.result.serverInfo, MCP_SERVER_INFO);
});

Deno.test("mcp anonymous discovery: tools/list returns the full public catalog", async () => {
  const res = anonymousDiscovery(null, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(res instanceof Response, "anonymous tools/list must dispatch without a token");
  assert.equal(res.status, 200);
  const body = await res.json() as { jsonrpc: string; id: number; result: { tools: unknown[] } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 2);
  assert.equal(body.result.tools.length, (TOOLS as unknown[]).length);
  // Exactly the registry: every tool with name, description and inputSchema.
  assert.deepEqual(body.result.tools, TOOLS);
});

Deno.test("mcp anonymous discovery: ping returns 200", async () => {
  const res = anonymousDiscovery(null, { jsonrpc: "2.0", id: 3, method: "ping" });
  assert.ok(res instanceof Response, "anonymous ping must dispatch without a token");
  assert.equal(res.status, 200);
  const body = await res.json() as { jsonrpc: string; id: number; result: unknown };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 3);
  assert.deepEqual(body.result, {});
});

Deno.test("mcp anonymous discovery: notifications/initialized returns 202", () => {
  const res = anonymousDiscovery(null, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.ok(res instanceof Response, "anonymous notification must dispatch without a token");
  assert.equal(res.status, 202);
});

Deno.test("mcp anonymous discovery: tools/call stays behind sign-in", async () => {
  const gated = anonymousDiscovery(null, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "read_live_datum", arguments: { kind: "balances" } },
  });
  assert.equal(gated, null, "tools/call must fall through to the 401 challenge");
  // The fall-through challenge is byte-identical to today's: HTTP 401, a
  // WWW-Authenticate header carrying resource_metadata + invalid_token, and
  // the JSON-RPC error body preserved.
  const res = rpcAuthChallenge(
    4,
    "https://x.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource",
    "unauthorized: bad credentials (ref test)",
  );
  assert.equal(res.status, 401);
  const www = res.headers.get("www-authenticate") ?? "";
  assert.ok(
    www.includes('resource_metadata="https://x.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource"'),
    `challenge lost resource_metadata: ${www}`,
  );
  assert.ok(www.includes('error="invalid_token"'), `challenge lost error code: ${www}`);
  const body = await res.json() as { jsonrpc: string; id: number; error: { code: number } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 4);
  assert.equal(body.error.code, -32001);
});

Deno.test("mcp anonymous discovery: a batch containing tools/call stays behind sign-in", () => {
  const gated = anonymousDiscovery(null, [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_live_datum", arguments: {} } },
  ]);
  assert.equal(gated, null, "a batch containing tools/call must fall through to the 401 challenge");
});

Deno.test("mcp anonymous discovery: a pure discovery batch returns one envelope per call", async () => {
  const res = anonymousDiscovery(null, [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ]);
  assert.ok(res instanceof Response, "a pure discovery batch must dispatch without a token");
  assert.equal(res.status, 200);
  const arr = await res.json() as Array<{ jsonrpc: string; id: number; result: unknown }>;
  assert.equal(arr.length, 3);
  assert.deepEqual(arr.map((e) => e.id), [1, 2, 3]);
  assert.equal((arr[0]!.result as { protocolVersion: string }).protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(((arr[2]!.result as { tools: unknown[] }).tools as unknown[]).length, (TOOLS as unknown[]).length);
});

Deno.test("mcp anonymous discovery: a Bearer token keeps today's path even for discovery", () => {
  // An invalid or expired token must still get the 401 challenge (so OAuth
  // clients refresh): the gate only serves tokenless callers, so any
  // Authorization header falls through to requireUser.
  assert.equal(anonymousDiscovery("Bearer bogus", { jsonrpc: "2.0", id: 5, method: "tools/list" }), null);
  assert.equal(anonymousDiscovery("Bearer bogus", { jsonrpc: "2.0", id: 6, method: "initialize" }), null);
});

Deno.test("mcp anonymous discovery: gate answers with fetch stubbed to throw (no network I/O)", async () => {
  // The warm-ping budget (~110 ms OPTIONS baseline) leaves no room for a
  // PostgREST round trip: the gate must be pure. Supabase clients, callEdge
  // and requireUser all ride globalThis.fetch, so a throwing stub proves it.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network I/O attempted on the anonymous path");
  }) as typeof fetch;
  try {
    for (const [id, method, expect] of [[9, "ping", 200], [10, "initialize", 200], [11, "tools/list", 200]] as Array<[number, string, number]>) {
      const res = anonymousDiscovery(null, { jsonrpc: "2.0", id, method });
      assert.ok(res instanceof Response, `${method} must dispatch without a token`);
      assert.equal(res.status, expect);
      await res.json();
    }
    const notif = anonymousDiscovery(null, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.ok(notif instanceof Response);
    assert.equal(notif.status, 202);
    const batch = anonymousDiscovery(null, [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 9, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.ok(batch instanceof Response);
    assert.equal(batch.status, 200);
    await batch.json();
  } finally {
    globalThis.fetch = origFetch;
  }
});

Deno.test("mcp anonymous discovery: POST path gates before any network/database I/O", async () => {
  // Guards the warm-ping latency: index.ts must parse the body and run the
  // pure gate BEFORE getServiceClient / the gateway rate-limit RPC /
  // requireUser. Importing index.ts would Deno.serve-bind, so this asserts
  // ordering on the real source instead.
  const index = await handlerSource("./index.ts");
  const at = (needle: string): number => {
    const i = index.indexOf(needle);
    if (i < 0) throw new Error(`index.ts lost ${needle} — ordering guard cannot verify`);
    return i;
  };
  const read = at("await readJson");
  const gate = at("anonymousDiscovery(req.headers");
  const svc = at("getServiceClient()");
  const gw = at("await checkRateLimit");
  const auth = at("await requireUser(req)");
  if (!(read < gate)) throw new Error("anonymous gate must run on the parsed body (readJson before anonymousDiscovery)");
  if (!(gate < svc && gate < gw && gate < auth)) {
    throw new Error("anonymous discovery must answer before getServiceClient/checkRateLimit/requireUser (no network or DB I/O on the warm ping path)");
  }
});

Deno.test("mcp annotations: every tool has annotations and a non-empty description", () => {
  for (const t of tools) {
    assert.ok(typeof t.title === "string" && t.title.trim().length > 0, `${t.name} needs a title`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} needs readOnlyHint`);
    if (t.annotations?.readOnlyHint === false) {
      assert.equal(typeof t.annotations?.destructiveHint, "boolean", `${t.name} is state-changing: needs an explicit destructiveHint`);
    }
    assert.ok(
      typeof t.description === "string" && t.description.trim().length > 0,
      `${t.name} needs a non-empty description`,
    );
    assert.ok(t.description.length <= 4000, `${t.name} description exceeds 4000 chars`);
  }
});
