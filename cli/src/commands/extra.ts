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

export async function cmdDiary(opts: { day?: string; json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  if (opts.day && !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) {
    console.error("Day must be YYYY-MM-DD.");
    process.exitCode = 2;
    return;
  }
  let out: unknown;
  try {
    out = await callTool("read_diary_day", opts.day ? { day: opts.day } : {}, pat, opts.url);
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

export async function cmdRisk(opts: { json: boolean; url?: string; pat?: string }): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  let out: unknown;
  try {
    out = await callTool("read_risk_limits", {}, pat, opts.url);
  } catch (e) {
    fail(e);
    return;
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
