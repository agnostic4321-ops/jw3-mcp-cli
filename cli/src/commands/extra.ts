/**
 * Authenticated MCP passthroughs: connections, diary, risk, propose.
 * Read-only except propose, which queues a Diary setup for in-app
 * approve-and-sign — never executes.
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

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

export async function cmdDiary(opts: { day?: string; startDay?: string; endDay?: string; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  if (opts.day && !dayRe.test(opts.day)) {
    console.error("Day must be YYYY-MM-DD.");
    process.exitCode = 2;
    return;
  }
  if ((opts.startDay ?? opts.endDay) && (!opts.startDay || !opts.endDay || !dayRe.test(opts.startDay) || !dayRe.test(opts.endDay))) {
    console.error("Range needs both --start-day and --end-day in YYYY-MM-DD format.");
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
    console.error(built.error);
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

export async function cmdRisk(opts: { json: boolean; state?: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let out: unknown;
  try {
    out = await callTool("read_risk_limits", {}, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.state && !opts.json) {
    console.log(formatRiskState(out));
    return;
  }
  console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
}

/**
 * Pure one-screen risk-state summary (same posture the app's Risk settings
 * display reads: kill switch, autonomy, breaker, caps vs daily usage).
 * Tolerates both the `{ risk_limits }` envelope and a bare row — unknown
 * fields read as unknown, never as safe.
 */
export function formatRiskState(out: unknown): string {
  const row = (out && typeof out === "object" && "risk_limits" in (out as Record<string, unknown>)
    ? (out as { risk_limits?: unknown }).risk_limits
    : out) as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return "risk state unreadable (no row)";
  const str = (v: unknown): string =>
    v === null || v === undefined ? "?" : typeof v === "string" ? v : JSON.stringify(v);
  const num = (v: unknown): string =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
  const left = (cap: unknown, used: unknown): string => {
    if (typeof cap !== "number" || !Number.isFinite(cap)) return "uncapped";
    if (typeof used !== "number" || !Number.isFinite(used)) return `cap ${cap}`;
    return `${cap - used} left of ${cap}`;
  };
  return [
    `kill_switch=${str((row as Record<string, unknown>).kill_switch_enabled)} autonomy=${str((row as Record<string, unknown>).autonomy_level)}`,
    `breaker=${str(row.circuit_breaker_enabled)} tripped_at=${str(row.circuit_breaker_tripped_at)}`,
    `loss: ${str((row as Record<string, unknown>).daily_realized_loss_usd)}/${str((row as Record<string, unknown>).max_daily_loss_usd)} trades: ${str((row as Record<string, unknown>).daily_trade_count)}/${str((row as Record<string, unknown>).max_trades_per_day)}`,
    `notional: ${left((row as Record<string, unknown>).max_daily_notional_usd, (row as Record<string, unknown>).daily_notional_usd)} position_cap=${num((row as Record<string, unknown>).max_position_usd)} leverage_cap=${num((row as Record<string, unknown>).max_leverage)}`,
  ].join("\n");
}

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

export type ProposeArgs = {
  pair: string;
  side: string;
  entry: number;
  stop: number;
  asset?: string;
  venue?: string;
  sizeUsd?: number;
  thesis?: string;
  timeframe?: string;
};

/** Pure validation so bad tickets fail before any network call. */
export function validatePropose(a: ProposeArgs): string | null {
  if (!a.pair) return "pair required (e.g. BTC/USDT)";
  if (!["buy", "sell", "long", "short"].includes(a.side.toLowerCase())) {
    return "side must be buy|sell|long|short";
  }
  if (!Number.isFinite(a.entry) || a.entry <= 0) return "entry must be > 0 — never 0/null placeholders";
  if (!Number.isFinite(a.stop) || a.stop <= 0) return "stop must be > 0 — never 0/null placeholders";
  if (a.sizeUsd !== undefined && (!Number.isFinite(a.sizeUsd) || a.sizeUsd <= 0)) {
    return "size_usd must be > 0 when provided";
  }
  return null;
}

export async function cmdPropose(
  args: ProposeArgs,
  opts: { json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validatePropose(args);
  if (err) {
    console.error(`Bad ticket: ${err}`);
    process.exitCode = 2;
    return;
  }
  const toolArgs: Record<string, unknown> = {
    pair: args.pair,
    side: args.side.toLowerCase(),
    entry: args.entry,
    stop: args.stop,
  };
  if (args.asset) toolArgs.asset = args.asset;
  if (args.venue) toolArgs.venue = args.venue;
  if (args.sizeUsd !== undefined) toolArgs.size_usd = args.sizeUsd;
  if (args.thesis) toolArgs.thesis = args.thesis;
  if (args.timeframe) toolArgs.timeframe = args.timeframe;
  let out: unknown;
  try {
    out = await callTool("propose_trade", toolArgs, pat, opts.url);
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
  const r = out as { setup_id?: string; status?: string; approve_in?: string };
  console.log(`Proposed — setup ${r.setup_id ?? "?"} (${r.status ?? "proposed"}). Approve in-app: ${r.approve_in ?? "Diary → setups → Send to ticket"}.`);
}
