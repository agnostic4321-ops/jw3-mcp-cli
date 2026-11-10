/**
 * Diary-note proposals (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

export type DiaryNoteArgs = {
  day?: string;
  body: string;
  mode?: string;
};

/** Pure validation so bad notes fail before any network call. */
export function validateDiaryNote(a: DiaryNoteArgs): string | null {
  if (a.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) return "day must be YYYY-MM-DD";
  if (!a.body || !a.body.trim()) return "body required (1..4000 chars)";
  if (a.body.length > 4000) return "body must be 1..4000 chars (the server cuts longer bodies)";
  if (a.mode !== undefined && a.mode !== "append" && a.mode !== "replace") {
    return "mode must be append|replace";
  }
  return null;
}

export async function cmdDiaryNote(
  args: DiaryNoteArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateDiaryNote(args);
  if (err) {
    console.error(`Bad diary note: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = { body_md: args.body };
  if (args.day) toolArgs.day = args.day;
  if (args.mode) toolArgs.mode = args.mode;
  let out: unknown;
  try {
    out = await callTool("propose_diary_note", toolArgs, pat, opts.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/trade:propose/.test(msg)) {
      console.error(`Refused: ${msg} (mint the scope in Settings → Harness Access).`);
    } else {
      fail(e);
    }
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out));
    return;
  }
  const r = out as { day?: string; mode?: string; chars?: number };
  console.log(`Diary note recorded for ${r.day ?? args.day ?? "today"} (${r.mode ?? args.mode ?? "append"}${typeof r.chars === "number" ? `, ${r.chars} chars` : ""}).`);
}
