// defi.ts — read_defi: DeFi Data reader owned by mcp-server.
//
// Vendored here from agent-chat when the app removed the DeFi Hub (commit
// f03d4b33) so the MCP tool surface keeps its read_defi/build_defi_tx pair;
// the sync script only refreshes _shared + agent-chat, so these copies are
// stable across syncs.
//
// READ-ONLY. Queries the Binance Web3 DeFi API (via `binance-defi` edge function
// or canonical fallback catalog) across all 10 supported EVM chains (BNB 56,
// Ethereum 1, Base 8453, Arbitrum 42161, Arc 5042, Polygon 137, Optimism 10,
// Avalanche 43114, Robinhood 4663, Katana 747474) and 21+ audited protocols.
//
// THE CONTRACT (same as read-tools.ts — do not weaken it):
// - READ-ONLY: never moves funds, never signs, never writes a row, and its
//   first sentence contains no fund-moving verbs so `assertReadToolsAreReadOnly`
//   passes at cold start.
// - Shared between `agent-chat` (via `readProxyTools` + `SERVER_TOOLS`) and
//   `mcp-server` (via `TOOLS` + `tools/call`).

import { resolveUserWallets } from "../_shared/wallet-scope.ts";
import {
  CANONICAL_BINANCE_DEFI_INVESTMENTS,
  CANONICAL_BINANCE_DEFI_PROTOCOLS,
  resolveDefiProtocolId,
} from "./binance-web3-defi.ts";
import type { ReadDeps } from "../agent-chat/read-tools.ts";

export const READ_DEFI_TOOL_NAME = "read_defi";

export const READ_DEFI_DESCRIPTION =
  "READ-ONLY: query DeFi protocols, yield/lending/liquid-staking/LP/RWA markets, or wallet positions across all 10 Binance Web3 DeFi chains (BNB 56, Ethereum 1, Base 8453, Arbitrum 42161, Arc 5042, Polygon 137, Optimism 10, Avalanche 43114, Robinhood 4663, Katana 747474). Returns APY, base/reward APY breakdown, TVL, redeemDelayDays, yieldAnalytics, and investmentId with a fetch timestamp. Use propose_defi when the user wants an action card.";

export const READ_DEFI_PARAMETERS = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["investments", "protocols", "positions", "protocol_detail", "investment_detail"],
      description:
        "What to read: investments (default, yield/lending/LP markets), protocols (21+ audited platforms), positions (wallet-scoped DeFi holdings & rewards), protocol_detail (single protocol + markets), or investment_detail (single pool by investment_id).",
    },
    chain: {
      type: "string",
      description:
        "Optional chain filter by slug or chainId: bnb (56), ethereum (1), base (8453), arbitrum (42161), arc (5042), polygon (137), optimism (10), avalanche (43114), robinhood (4663), katana (747474).",
    },
    protocol: {
      type: "string",
      description:
        "Optional defiProtocolId filter (e.g. aave3, aave4, uniswap3, uniswap4, pancakeswap3, pancakeswap4, morphoblue, venus, venusflux, helio, astherus, lido, pendle2, spark, solv, renzo, rocketpool, quickswap3, benqi, frax, maple, cian, emberso, rexyz, usdai).",
    },
    category: {
      type: "string",
      enum: [
        "LENDING",
        "STAKING",
        "LIQUID_STAKING",
        "RESTAKING",
        "YIELD",
        "LIQUIDITY_POOL",
        "RWA",
        "VAULT",
      ],
      description: "Optional DeFi category filter.",
    },
    token: {
      type: "string",
      description: "Optional underlying token symbol or contract address filter (e.g. USDC, USDT, BNB, ETH, sUSDe).",
    },
    investment_id: {
      type: "string",
      description: "Investment pool ID for scope=investment_detail (e.g. bn-aave4-5042-usdc).",
    },
    address: {
      type: "string",
      description: "Optional 0x EVM wallet address for scope=positions (auto-resolved from user's connected wallets when omitted).",
    },
    limit: {
      type: "number",
      description: "Max items to return, 1..50 (default 20).",
    },
  },
  required: [],
  additionalProperties: false,
};

export const readDefiTool = {
  type: "function",
  function: {
    name: READ_DEFI_TOOL_NAME,
    description: READ_DEFI_DESCRIPTION,
    parameters: READ_DEFI_PARAMETERS,
  },
};

const CHAIN_SLUG_TO_BINANCE_ID: Record<string, string> = {
  bnb: "56",
  bsc: "56",
  "56": "56",
  ethereum: "1",
  eth: "1",
  "1": "1",
  base: "8453",
  "8453": "8453",
  arbitrum: "42161",
  arb: "42161",
  "42161": "42161",
  arc: "5042",
  "5042": "5042",
  polygon: "137",
  pol: "137",
  matic: "137",
  "137": "137",
  optimism: "10",
  op: "10",
  "10": "10",
  avalanche: "43114",
  avax: "43114",
  "43114": "43114",
  robinhood: "4663",
  "4663": "4663",
  katana: "747474",
  "747474": "747474",
};

export function normalizeDefiChainId(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const key = String(raw).trim().toLowerCase();
  if (!key) return undefined;
  return CHAIN_SLUG_TO_BINANCE_ID[key] ?? key;
}

/**
 * Compute risk-adjusted yield summary across a pool set so the agent can rank
 * pools by sustainable base APY, TVL depth, and instant-redemption liquidity.
 */
function buildYieldAnalytics(pools: unknown[]): Record<string, unknown> {
  const parsed = pools
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => {
      const apy = Number(p.apy) || 0;
      const baseApy = Number(p.baseApy) || 0;
      const rewardApy = Number(p.rewardApy) || 0;
      const tvlUsd = Number(p.tvlUsd) || 0;
      const delays = Array.isArray(p.redeemDelayDays) ? p.redeemDelayDays : [];
      const instantRedeem = delays.length === 0 || delays.every((d) => Number(d) === 0);
      // Risk-adjusted yield score: baseApy weighted higher than emissions + log10(TVL) depth bonus
      const effectiveApy = baseApy > 0 ? baseApy + rewardApy * 0.65 : apy;
      const yieldScore = tvlUsd >= 100_000 && effectiveApy > 0
        ? +(effectiveApy * Math.log10(Math.max(tvlUsd, 100))).toFixed(2)
        : 0;
      return {
        investmentId: String(p.investmentId ?? ""),
        investmentName: String(p.investmentName ?? ""),
        defiProtocolId: String(p.defiProtocolId ?? ""),
        binanceChainId: String(p.binanceChainId ?? ""),
        apy,
        baseApy,
        rewardApy,
        tvlUsd,
        instantRedeem,
        yieldScore,
      };
    });

  if (parsed.length === 0) {
    return { maxApyPct: 0, medianApyPct: 0, totalTvlUsd: 0, topRiskAdjustedPools: [] };
  }

  const apys = parsed.map((p) => p.apy).sort((a, b) => a - b);
  const maxApyPct = +(apys[apys.length - 1] ?? 0).toFixed(2);
  const medianApyPct = +(apys[Math.floor(apys.length / 2)] ?? 0).toFixed(2);
  const totalTvlUsd = Math.round(parsed.reduce((s, p) => s + p.tvlUsd, 0));
  const topRiskAdjustedPools = [...parsed]
    .sort((a, b) => b.yieldScore - a.yieldScore)
    .slice(0, 5);

  return {
    maxApyPct,
    medianApyPct,
    totalTvlUsd,
    topRiskAdjustedPools,
  };
}

export async function executeDefiRead(
  args: Record<string, unknown>,
  deps: ReadDeps,
): Promise<Record<string, unknown>> {
  const scopeRaw = typeof args.scope === "string" ? args.scope.trim().toLowerCase() : "investments";
  const scope = [
    "investments",
    "protocols",
    "positions",
    "protocol_detail",
    "investment_detail",
  ].includes(scopeRaw)
    ? scopeRaw
    : "investments";

  const binanceChainId = normalizeDefiChainId(args.chain);
  const defiProtocolId = resolveDefiProtocolId(args.protocol);
  const investmentType = typeof args.category === "string" && args.category.trim()
    ? args.category.trim().toUpperCase()
    : undefined;
  const tokenAddress = typeof args.token === "string" && args.token.trim()
    ? args.token.trim()
    : undefined;
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
  const observedAt = new Date().toISOString();

  if (scope === "protocols") {
    const r = await deps.callEdge("binance-defi", {
      action: "data/protocol/list",
      params: {
        ...(binanceChainId ? { binanceChainId } : {}),
        ...(investmentType ? { investmentType } : {}),
      },
    });
    const payload = (r.json as { data?: { protocolList?: unknown[] }; mode?: string }) ?? {};
    const list = Array.isArray(payload.data?.protocolList)
      ? payload.data!.protocolList
      : CANONICAL_BINANCE_DEFI_PROTOCOLS.filter((p) => {
          if (binanceChainId && !p.supportedChainIds.includes(binanceChainId as never)) return false;
          if (investmentType && p.category !== investmentType) return false;
          return true;
        });
    return {
      scope: "protocols",
      observedAt,
      mode: payload.mode ?? "catalog",
      count: list.length,
      protocols: list.slice(0, limit),
    };
  }

  if (scope === "protocol_detail") {
    if (!defiProtocolId) {
      return { error: "protocol_detail requires protocol (e.g. aave3, morphoblue, maple)" };
    }
    const r = await deps.callEdge("binance-defi", {
      action: "data/protocol/detail",
      params: {
        defiProtocolId,
        ...(binanceChainId ? { binanceChainId } : {}),
      },
    });
    const payload = (r.json as { data?: unknown; mode?: string }) ?? {};
    return {
      scope: "protocol_detail",
      observedAt,
      mode: payload.mode ?? "catalog",
      protocol: payload.data ??
        CANONICAL_BINANCE_DEFI_PROTOCOLS.find((p) => p.defiProtocolId === defiProtocolId) ??
        null,
    };
  }

  if (scope === "investment_detail") {
    const investmentId = typeof args.investment_id === "string" ? args.investment_id.trim() : "";
    if (!investmentId) {
      return { error: "investment_detail requires investment_id (e.g. bn-aave4-5042-usdc)" };
    }
    const r = await deps.callEdge("binance-defi", {
      action: "data/investment/detail",
      params: { investmentId },
    });
    const payload = (r.json as { data?: { investment?: unknown }; mode?: string }) ?? {};
    return {
      scope: "investment_detail",
      observedAt,
      mode: payload.mode ?? "catalog",
      investment:
        payload.data?.investment ??
        CANONICAL_BINANCE_DEFI_INVESTMENTS.find((i) => i.investmentId === investmentId) ??
        null,
    };
  }

  if (scope === "positions") {
    let address = typeof args.address === "string" ? args.address.trim() : "";
    if (!address) {
      const wallets = await resolveUserWallets(deps.admin, deps.userId);
      const evm = wallets.find((w) => /^0x[0-9a-fA-F]{40}$/.test(w.address));
      address = evm?.address ?? "";
    }
    if (!address) {
      return {
        scope: "positions",
        observedAt,
        positions: [],
        note: "No EVM wallet connected — pass address=0x... or connect an EVM wallet via Reown.",
      };
    }
    const r = await deps.callEdge("binance-defi", {
      action: "data/position/list",
      params: {
        address,
        ...(binanceChainId ? { binanceChainId } : {}),
        ...(defiProtocolId ? { defiProtocolId } : {}),
      },
    });
    const payload = (r.json as { data?: { positionList?: unknown[]; totalUsdValue?: string }; mode?: string }) ?? {};
    return {
      scope: "positions",
      address,
      observedAt,
      mode: payload.mode ?? "catalog",
      totalUsdValue: payload.data?.totalUsdValue ?? "0.00",
      positions: Array.isArray(payload.data?.positionList) ? payload.data!.positionList : [],
    };
  }

  // Default: scope === "investments"
  const r = await deps.callEdge("binance-defi", {
    action: "data/investment/list",
    params: {
      page: 1,
      pageSize: limit,
      ...(binanceChainId ? { binanceChainId } : {}),
      ...(defiProtocolId ? { defiProtocolId } : {}),
      ...(investmentType ? { investmentType } : {}),
      ...(tokenAddress ? { tokenAddress } : {}),
    },
  });
  const payload = (r.json as { data?: { investmentList?: unknown[]; total?: number }; mode?: string }) ?? {};
  const list = Array.isArray(payload.data?.investmentList)
    ? payload.data!.investmentList
    : CANONICAL_BINANCE_DEFI_INVESTMENTS.filter((inv) => {
        if (binanceChainId && inv.binanceChainId !== binanceChainId) return false;
        if (defiProtocolId && inv.defiProtocolId !== defiProtocolId) return false;
        if (investmentType && inv.investmentType !== investmentType) return false;
        if (
          tokenAddress &&
          !inv.underlyingTokens.some(
            (t) =>
              t.tokenSymbol.toLowerCase().includes(tokenAddress.toLowerCase()) ||
              t.tokenAddress.toLowerCase() === tokenAddress.toLowerCase(),
          )
        ) {
          return false;
        }
        return true;
      });
  const sliced = list.slice(0, limit);
  return {
    scope: "investments",
    observedAt,
    mode: payload.mode ?? "catalog",
    count: list.length,
    yieldAnalytics: buildYieldAnalytics(sliced),
    investments: sliced,
  };
}
