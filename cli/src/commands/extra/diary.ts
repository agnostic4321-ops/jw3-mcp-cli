/**
 * Diary day/range reads (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

export async function cmdDiary(opts: { day?: string; startDay?: string; endDay?: string; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  if (opts.day && !dayRe.test(opts.day)) {
    console.error("Bad --day: must be YYYY-MM-DD — nothing was called.");
    process.exitCode = 2;
    return;
  }
  if ((opts.startDay ?? opts.endDay) && (!opts.startDay || !opts.endDay || !dayRe.test(opts.startDay) || !dayRe.test(opts.endDay))) {
    console.error("Bad range: needs both --start-day and --end-day in YYYY-MM-DD format — nothing was called.");
    process.exitCode = 2;
    return;
  }
  // A human typed this command, so an omitted day means today (local) —
  // the no-default rule binds the model, not the CLI.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const params: Record<string, unknown> = opts.startDay
    ? { start_day: opts.startDay, end_day: opts.endDay }
    : { day: opts.day ?? today };
  let out: unknown;
  try {
    out = await callTool("read_diary_day", params, pat, opts.url);
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
