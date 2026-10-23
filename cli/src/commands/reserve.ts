/**
 * Reserve sweep (KuCoin). Read-only plan by default; NOTHING moves without
 * --yes. Server re-checks (kill switch, YOLO eligibility) on live fire —
 * a CLI yes never overrides a server no.
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

export type ReserveSweepArgs = {
  exchange: string;
  keep: number;
  currency: string;
};

const SWEEP_CURRENCIES = ["USDT", "USDC", "BTC", "ETH"];

export function normalizeSweepCurrency(raw: string): string {
  const v = raw.trim().toUpperCase();
  return v === "XBT" ? "BTC" : v;
}

export function validateReserveSweep(a: ReserveSweepArgs): string | null {
  if (!a.exchange) return "exchange required (e.g. kucoin)";
  if (a.exchange.toLowerCase() !== "kucoin") return `reserve sweep is KuCoin-only (got ${a.exchange})`;
  if (!Number.isFinite(a.keep) || a.keep < 0) return "keep must be a non-negative number";
  if (!SWEEP_CURRENCIES.includes(normalizeSweepCurrency(a.currency))) {
    return `currency must be one of ${SWEEP_CURRENCIES.join(", ")}`;
  }
  return null;
}

export async function cmdReserveSweep(
  args: ReserveSweepArgs,
  opts: { yes: boolean; json: boolean; url?: string; pat?: string },
): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const err = validateReserveSweep(args);
  if (err) {
    console.error(`Bad sweep: ${err}`);
    process.exitCode = 2;
    return;
  }
  const currency = normalizeSweepCurrency(args.currency);
  const toolArgs: Record<string, unknown> = {
    exchange: args.exchange.toLowerCase(),
    keep: args.keep,
    currency,
    dryRun: !opts.yes,
  };
  if (!opts.yes) {
    try {
      const out = await callTool("reserve_sweep", toolArgs, pat, opts.url);
      console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
      console.log("Dry run — nothing sent. Re-run with --yes to fire (real money).");
    } catch (e) {
      fail(e);
    }
    return;
  }
  console.log(`RESERVE SWEEP (real money): keep ${args.keep} ${currency} in futures on ${args.exchange.toLowerCase()}, sweep the excess futures -> main -> trade.`);
  try {
    const out = await callTool("reserve_sweep", toolArgs, pat, opts.url);
    console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  } catch (e) {
    fail(e);
  }
}
