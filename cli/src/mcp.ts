/** Minimal JSON-RPC 2.0 client for the mcp-server Streamable HTTP surface. */
import { mcpEndpoint } from "./config.js";
import { fetchText, HttpError, scrubBearer } from "./http.js";

export class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(scrubBearer(message));
    this.name = "McpError";
    this.code = code;
  }
}

type RpcOk = { jsonrpc: string; id: unknown; result: unknown };
type RpcErr = { jsonrpc: string; id: unknown; error: { code: number; message: string; data?: unknown } };

async function post(
  url: string,
  pat: string | null,
  body: unknown,
  timeoutMs = 25000,
  attempts = 3,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  let text: string;
  try {
    text = await fetchText(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      { timeoutMs, attempts },
    );
  } catch (e) {
    // A non-2xx may still carry a JSON-RPC error envelope (readable
    // venue refusal) — surface that instead of a bare HTTP status.
    if (e instanceof HttpError && e.body) {
      try {
        const json = JSON.parse(e.body) as unknown;
        if (json && typeof json === "object" && "jsonrpc" in json) return json;
      } catch {
        // fall through to the HTTP error
      }
      throw new McpError(-32603, `http ${e.status} from mcp-server (no JSON-RPC envelope)`);
    }
    throw e;
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new McpError(-32603, `non-JSON response (http 200-class)`);
  }
  if (!json || typeof json !== "object" || !("jsonrpc" in json)) {
    throw new McpError(-32603, `malformed JSON-RPC envelope (no jsonrpc member)`);
  }
  return json;
}

export async function rpc(
  method: string,
  params: Record<string, unknown>,
  pat: string | null,
  urlOverride?: string,
  id = 1,
  timeoutMs = 25000,
  attempts = 3,
): Promise<unknown> {
  const json = (await post(mcpEndpoint(urlOverride), pat, { jsonrpc: "2.0", id, method, params }, timeoutMs, attempts)) as
    | RpcOk
    | RpcErr
    | null;
  if (!json || typeof json !== "object" || !("jsonrpc" in json)) {
    throw new McpError(-32603, "malformed JSON-RPC envelope");
  }
  if ("error" in json && json.error) {
    const e = (json as RpcErr).error;
    throw new McpError(e.code, e.message);
  }
  return (json as RpcOk).result;
}

export async function initialize(
  pat: string | null,
  urlOverride?: string,
): Promise<{ protocolVersion: string; server: { name: string; version: string } }> {
  const result = (await rpc("initialize", {}, pat, urlOverride)) as {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
  };
  return { protocolVersion: result.protocolVersion, server: result.serverInfo };
}

export type ToolContent = { type: string; text: string };

/**
 * Fund-moving / state-changing tools are NEVER auto-retried: a timeout is
 * ambiguous (the order may be live), so the failure surfaces immediately
 * and the operator reconciles via list_open_orders / order status before
 * doing anything — re-firing blind risks a double-fill with leverage.
 * Reads (read_*, list_*, analyze_*, daily_*) retry 429/5xx with backoff.
 */
const NO_RETRY_TOOLS = new Set([
  "execute_trade",
  "close_position",
  "set_exits",
  "cancel_order",
  "reserve_sweep",
  "propose_trade",
  "propose_diary_note",
]);

/**
 * tools/call result. Tool-level failures arrive as HTTP 200 + isError:true
 * per the MCP spec — surfaced here as McpError so the CLI never prints a
 * failure as if it were data.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  pat: string,
  urlOverride?: string,
  // daily_prep fans out to ~13 sources + sequential JEV — needs minutes.
  timeoutMs = name === "daily_prep" ? 600000 : 25000,
): Promise<unknown> {
  const attempts = NO_RETRY_TOOLS.has(name) ? 1 : 3;
  const result = (await rpc("tools/call", { name, arguments: args }, pat, urlOverride, 1, timeoutMs, attempts)) as {
    content?: ToolContent[];
    isError?: boolean;
  };
  const text = (result.content ?? []).map((c) => c.text).join("\n");
  if (result.isError) throw new McpError(-32000, text || `${name} failed`);
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return text;
  }
}
