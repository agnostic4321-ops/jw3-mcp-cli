/**
 * jw3 defi — CLI wrapper for the Binance Web3 DeFi API surface via mcp-server
 * (`read_defi` and `build_defi_tx`).
 *
 * Non-custodial & read-only / unsigned-calldata-only:
 *  - `jw3 defi protocols`  -> `read_defi` scope=protocols
 *  - `jw3 defi markets`    -> `read_defi` scope=investments (alias: `investments`)
 *  - `jw3 defi positions`  -> `read_defi` scope=positions
 *  - `jw3 defi quote-lp`   -> `build_defi_tx` action=quote_lp
 *  - `jw3 defi build`      -> `build_defi_tx` action=supply|redeem|borrow|repay|claim
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

export const DEFI_USAGE = `Usage:
  jw3 defi protocols [--chain ethereum] [--category lending|staking|liquidity|yield|restaking|derivatives|rwa] [--limit 20] [--json]
  jw3 defi markets [--chain ethereum] [--protocol aave-v3] [--token USDC] [--category lending] [--min-apy 3] [--limit 20] [--json]
  jw3 defi positions [--wallet 0x...] [--chain ethereum] [--protocol aave-v3] [--json]
  jw3 defi quote-lp --investment-id <id> --amount <amount> [--token-address 0x...] [--chain ethereum] [--json]
  jw3 defi build --action supply|redeem|borrow|repay|claim --investment-id <id> --wallet <addr> [--amount <amount>] [--token-address 0x...] [--chain ethereum] [--slippage-bps 50] [--no-simulate] [--json]`;

export type DefiProtocolsArgs = {
  chain?: string;
  category?: string;
  limit?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

export type DefiMarketsArgs = {
  chain?: string;
  protocol?: string;
  token?: string;
  category?: string;
  minApy?: number;
  limit?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

export type DefiPositionsArgs = {
  wallet?: string;
  chain?: string;
  protocol?: string;
  json: boolean;
  url?: string;
  pat?: string;
};

export type DefiBuildArgs = {
  action: string;
  investmentId: string;
  walletAddress?: string;
  amount?: string;
  tokenAddress?: string;
  chain?: string;
  slippageBps?: number;
  simulate?: boolean;
  json: boolean;
  url?: string;
  pat?: string;
};

const VALID_BUILD_ACTIONS = new Set(["supply", "redeem", "borrow", "repay", "claim", "quote_lp"]);

export function validateDefiBuildArgs(a: DefiBuildArgs): string | null {
  const act = (a.action || "").toLowerCase().trim();
  if (!VALID_BUILD_ACTIONS.has(act)) {
    return "action must be supply|redeem|borrow|repay|claim|quote_lp";
  }
  if (!a.investmentId || !a.investmentId.trim()) {
    return "--investment-id is required";
  }
  if (act !== "quote_lp" && (!a.walletAddress || !a.walletAddress.trim())) {
    return `--wallet is required for action=${act}`;
  }
  if (act !== "claim" && (!a.amount || !a.amount.trim() || !(Number(a.amount) > 0))) {
    return `--amount (> 0) is required for action=${act}`;
  }
  if (a.slippageBps !== undefined && (!Number.isFinite(a.slippageBps) || a.slippageBps < 1 || a.slippageBps > 5000)) {
    return "--slippage-bps must be between 1 and 5000";
  }
  return null;
}

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export async function cmdDefiProtocols(opts: DefiProtocolsArgs): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const toolArgs: Record<string, unknown> = { scope: "protocols" };
  if (opts.chain) toolArgs.chain = opts.chain;
  if (opts.category) toolArgs.category = opts.category;
  if (opts.limit !== undefined) toolArgs.limit = opts.limit;
  let out: Record<string, unknown>;
  try {
    out = (await callTool("read_defi", toolArgs, pat, opts.url)) as Record<string, unknown>;
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const rows = Array.isArray(out.protocols) ? (out.protocols as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) {
    console.log("No matching DeFi protocols found.");
    return;
  }
  console.log(`DeFi Protocols (${rows.length}, mode=${String(out.mode ?? "catalog")}):`);
  for (const p of rows) {
    const chainList = Array.isArray(p.supportedChainIds)
      ? (p.supportedChainIds as string[]).join(",")
      : Array.isArray(p.chains)
      ? (p.chains as string[]).join(",")
      : "";
    const id = String(p.defiProtocolId ?? p.slug ?? p.id ?? "");
    const name = String(p.protocolName ?? p.name ?? "");
    console.log(
      `  ${id.padEnd(16)}  ${name.padEnd(22)}  [${String(p.category ?? "")}]  TVL ${fmtUsd(p.tvlUsd).padEnd(9)}  chains=${chainList}`,
    );
  }
}

export async function cmdDefiMarkets(opts: DefiMarketsArgs): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const toolArgs: Record<string, unknown> = { scope: "investments" };
  if (opts.chain) toolArgs.chain = opts.chain;
  if (opts.protocol) toolArgs.protocol = opts.protocol;
  if (opts.token) toolArgs.token = opts.token;
  if (opts.category) toolArgs.category = opts.category;
  if (opts.limit !== undefined) toolArgs.limit = opts.limit;
  let out: Record<string, unknown>;
  try {
    out = (await callTool("read_defi", toolArgs, pat, opts.url)) as Record<string, unknown>;
  } catch (e) {
    fail(e);
    return;
  }
  const rawRows = Array.isArray(out.investments) ? (out.investments as Array<Record<string, unknown>>) : [];
  const rows = opts.minApy !== undefined
    ? rawRows.filter((m) => Number(m.apy ?? 0) >= Number(opts.minApy))
    : rawRows;
  if (opts.json) {
    console.log(JSON.stringify({ ...out, count: rows.length, investments: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No matching DeFi yield markets found.");
    return;
  }
  console.log(`DeFi Yield Markets (${rows.length}, observedAt=${String(out.observedAt ?? "")}):`);
  for (const m of rows) {
    const apy = Number(m.apy ?? 0).toFixed(2);
    const proto = String(m.protocolName ?? m.defiProtocolId ?? m.protocolId ?? "");
    const chain = String(m.chainName ?? m.binanceChainId ?? m.chainSlug ?? m.chainId ?? "");
    const title = String(m.investmentName ?? m.title ?? "");
    console.log(
      `  ${String(m.investmentId ?? "").padEnd(26)}  ${proto.padEnd(18)}  ${chain.padEnd(12)}  APY ${apy.padStart(6)}%  TVL ${fmtUsd(m.tvlUsd).padEnd(9)}  ${title}`,
    );
  }
}

export async function cmdDefiPositions(opts: DefiPositionsArgs): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const toolArgs: Record<string, unknown> = { scope: "positions" };
  if (opts.wallet) toolArgs.address = opts.wallet;
  if (opts.chain) toolArgs.chain = opts.chain;
  if (opts.protocol) toolArgs.protocol = opts.protocol;
  let out: Record<string, unknown>;
  try {
    out = (await callTool("read_defi", toolArgs, pat, opts.url)) as Record<string, unknown>;
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const rows = Array.isArray(out.positions) ? (out.positions as Array<Record<string, unknown>>) : [];
  const totalUsd = out.totalUsdValue ?? out.totalSuppliedUsd ?? out.netValueUsd ?? "0";
  console.log(
    `DeFi Positions (${rows.length}, totalUsdValue=${fmtUsd(totalUsd)}):`,
  );
  if (rows.length === 0) {
    console.log(`  ${String(out.note ?? "No active DeFi positions found for the connected wallet(s).")}`);
    return;
  }
  for (const pos of rows) {
    const proto = String(pos.protocolName ?? pos.defiProtocolId ?? pos.protocolId ?? "");
    const chain = String(pos.binanceChainId ?? pos.chainSlug ?? pos.chainId ?? "");
    const name = String(pos.investmentName ?? pos.symbol ?? "");
    const usd = pos.totalUsdValue ?? pos.suppliedUsd ?? "0";
    const apy = Number(pos.netApy ?? pos.apy ?? 0).toFixed(2);
    console.log(
      `  ${proto.padEnd(16)}  chain=${chain.padEnd(8)}  ${name.padEnd(22)}  value=${fmtUsd(usd)}  APY=${apy}%`,
    );
  }
}

export async function cmdDefiBuild(opts: DefiBuildArgs): Promise<void> {
  const err = validateDefiBuildArgs(opts);
  if (err) {
    console.error(`Bad defi build args: ${err} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const pat = needPat(opts.pat);
  if (!pat) return;
  const toolArgs: Record<string, unknown> = {
    action: opts.action.toLowerCase().trim(),
    investmentId: opts.investmentId.trim(),
  };
  if (opts.walletAddress) toolArgs.walletAddress = opts.walletAddress.trim();
  if (opts.amount) toolArgs.amount = opts.amount.trim();
  if (opts.tokenAddress) toolArgs.tokenAddress = opts.tokenAddress.trim();
  if (opts.chain) toolArgs.chainId = opts.chain.trim();
  if (opts.slippageBps !== undefined) toolArgs.slippageBps = opts.slippageBps;
  if (opts.simulate !== undefined) toolArgs.simulate = opts.simulate;
  let out: Record<string, unknown>;
  try {
    out = (await callTool("build_defi_tx", toolArgs, pat, opts.url)) as Record<string, unknown>;
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(
    `DeFi ${opts.action.toUpperCase()} payload built for ${opts.investmentId} (observedAt=${String(out.observedAt ?? "")}):`,
  );
  console.log(JSON.stringify(out, null, 2));
}
