/**
 * News-brief reads (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

/** Pure pair passthrough so bad shapes fail before any network call. */
export function newsParams(opts: { pair?: string; source?: string; limit?: number; windowHrs?: number }): { params: Record<string, unknown> } | { error: string } {
  const params: Record<string, unknown> = {};
  if (opts.pair) params.pair = opts.pair;
  if (opts.source) params.source = opts.source;
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 12) {
      return { error: "limit must be an integer 1..12" };
    }
    params.limit = opts.limit;
  }
  if (opts.windowHrs !== undefined) {
    if (!Number.isFinite(opts.windowHrs) || opts.windowHrs < 1 || opts.windowHrs > 168) {
      return { error: "window-hrs must be 1..168" };
    }
    params.window_hrs = opts.windowHrs;
  }
  return { params };
}

export async function cmdNews(opts: { pair?: string; source?: string; limit?: number; windowHrs?: number; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const built = newsParams({ pair: opts.pair, source: opts.source, limit: opts.limit, windowHrs: opts.windowHrs });
  if ("error" in built) {
    console.error(`Bad news filter: ${built.error} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  let out: unknown;
  try {
    out = await callTool("read_news_brief", built.params, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  // MCP transports the payload as a JSON string — parse once so --json is real JSON.
  if (typeof out === "string") {
    try {
      out = JSON.parse(out) as unknown;
    } catch {
      console.log(out);
      return;
    }
  }
  console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
}
