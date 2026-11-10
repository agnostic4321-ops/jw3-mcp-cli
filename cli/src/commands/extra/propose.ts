/**
 * Trade-setup proposals (split from extra.ts). Read-only except propose/diary-note, which queue Diary
 * approvals for in-app approve-and-sign — never execute.
 */
import { callTool } from "../../mcp.js";
import { fail, needPat } from "../market.js";

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
    console.error(`Bad ticket: ${err} — nothing was called.`);
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
