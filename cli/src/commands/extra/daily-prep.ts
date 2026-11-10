/**
 * Daily-prep brief reads (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

export function dailyPrepParams(opts: { dry: boolean; day?: string }): { params: Record<string, unknown> } | { error: string } {
  if (opts.day && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) return { error: "Day must be YYYY-MM-DD." };
  const params: Record<string, unknown> = { ...(opts.dry ? { write: false } : {}) };
  if (opts.day) params.day = opts.day;
  return { params };
}

export async function cmdDailyPrep(opts: { dry: boolean; day?: string; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const built = dailyPrepParams(opts);
  if ("error" in built) {
    console.error(`Bad daily-prep: ${built.error} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  let out: unknown;
  try {
    out = await callTool("daily_prep", built.params, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  if (typeof out === "string") {
    try {
      out = JSON.parse(out) as unknown;
    } catch {
      console.log(out);
      return;
    }
  }
  const r = out as { wrote?: boolean; day?: string; brief_chars?: number; jev?: Array<{ name: string; jev: string; err: string | null }>; brief?: string; note?: string };
  if (!opts.json) {
    if (typeof r.brief === "string") {
      console.log(r.brief);
      return;
    }
    console.log(`Daily analysis ${r.day}: recorded in diary (${r.brief_chars} chars).`);
    for (const j of r.jev ?? []) console.log(`  ${j.name}: ${j.err ? `JEV failed (${j.err})` : j.jev}`);
    if (r.note) console.log(r.note);
    return;
  }
  console.log(JSON.stringify(out, null, 0));
}
