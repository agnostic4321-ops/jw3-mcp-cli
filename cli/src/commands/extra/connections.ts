/**
 * Authenticated connection reads (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

type Connection = { id: string; exchange: string; label: string; status: string; markets?: string };

export async function cmdConnections(opts: { json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let out: { connections?: Connection[] };
  try {
    out = (await callTool("list_connections", {}, pat, opts.url)) as { connections?: Connection[] };
  } catch (e) {
    fail(e);
    return;
  }
  const rows = out.connections ?? [];
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No CEX connections — connect one in-app first (metadata only here, never secrets).");
    return;
  }
  for (const c of rows) {
    console.log(`${c.exchange}  ${c.label ?? ""}  [${c.status}]${c.markets ? `  markets=${c.markets}` : ""}  id=${c.id}`);
  }
}
