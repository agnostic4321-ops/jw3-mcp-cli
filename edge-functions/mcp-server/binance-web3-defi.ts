/**
 * Binance Web3 DeFi Open API — Core SDK, Signing, Error Catalog & Fallback Engine
 * ===============================================================================
 * Official specifications:
 * - Introduction: https://web3.binance.com/en/dev-docs/products/defi-api/introduction
 * - Supported Chains & Protocols: https://web3.binance.com/en/dev-docs/products/defi-api/supported-chains
 * - Integration Flow: https://web3.binance.com/en/dev-docs/products/defi-api/integration-flow
 * - Error Codes: https://web3.binance.com/en/dev-docs/products/defi-api/error-codes
 * - DeFi Data API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/defi-data
 * - DeFi Transaction API: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/defi-transaction
 * - Authentication: https://web3.binance.com/en/dev-docs/authentication
 */

import { DEFI_PROTOCOLS } from "./defi-protocols.ts";

export const BINANCE_WEB3_BASE_URL = "https://web3.binance.com/build";
export const BINANCE_WEB3_SIGN_PREFIX = "/build";

export type BinanceDefiChainId =
  | "1"
  | "10"
  | "56"
  | "137"
  | "4663"
  | "5042"
  | "8453"
  | "42161"
  | "43114"
  | "747474";

export const BINANCE_DEFI_SUPPORTED_CHAIN_IDS: readonly BinanceDefiChainId[] = [
  "56",     // BNB Smart Chain
  "1",      // Ethereum
  "8453",   // Base
  "4663",   // Robinhood Chain
  "42161",  // Arbitrum One
  "137",    // Polygon
  "10",     // Optimism
  "43114",  // Avalanche C-Chain
  "747474", // Katana
  "5042",   // Arc
] as const;

export type BinanceDefiInvestmentType =
  | "LENDING"
  | "STAKING"
  | "LIQUID_STAKING"
  | "RESTAKING"
  | "YIELD"
  | "LIQUIDITY_POOL"
  | "RWA"
  | "VAULT";

export type BinanceDefiClaimType =
  | "REWARD_PROTOCOL"
  | "REWARD_INVESTMENT"
  | "LP_FEE"
  | "REDEMPTION";

export type BinanceDefiCallDataType =
  | "APPROVE"
  | "DEPOSIT"
  | "REDEEM"
  | "LP_ADD"
  | "LP_REMOVE"
  | "CLAIM";

export interface BinanceDefiCallDataItem {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  gasPrice: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  callDataType: BinanceDefiCallDataType;
}

export interface BinanceDefiTokenRef {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenDecimals: number;
  logoUrl?: string;
  amount?: string;
  usdValue?: string;
}

export interface BinanceDefiProtocolSummary {
  defiProtocolId: string;
  protocolName: string;
  logoUrl: string;
  websiteUrl: string;
  description: string;
  category: BinanceDefiInvestmentType;
  supportedChainIds: BinanceDefiChainId[];
  tvlUsd: string;
  maxApy: string;
  investmentCount: number;
  auditStatus: "AUDITED" | "MULTI_AUDITED" | "VERIFIED";
  auditors: string[];
  securityScore: number;
  sourceProvider: "binance-web3";
}

export interface BinanceDefiInvestmentItem {
  investmentId: string;
  defiProtocolId: string;
  protocolName: string;
  protocolLogoUrl: string;
  binanceChainId: BinanceDefiChainId;
  chainName: string;
  investmentName: string;
  investmentType: BinanceDefiInvestmentType;
  investmentSubType: "SINGLE_TOKEN" | "DUAL_TOKEN" | "CONCENTRATED_LP" | "VAULT";
  apy: string;
  baseApy: string;
  rewardApy: string;
  tvlUsd: string;
  underlyingTokens: BinanceDefiTokenRef[];
  rewardTokens: BinanceDefiTokenRef[];
  feeTierBps?: number;
  minDepositUsd?: string;
  redeemDelayDays: number[];
  supportsConcentratedLp: boolean;
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  contractAddress: string;
  sourceProvider: "binance-web3";
}

export interface BinanceDefiErrorSpec {
  code: number;
  httpStatus: number;
  category: "SUCCESS" | "PARAM" | "AUTH" | "COMPLIANCE" | "KYT" | "NOT_FOUND" | "TX_BUILD" | "RATE_LIMIT" | "SERVER";
  title: string;
  description: string;
  userAction: string;
  retryable: boolean;
  requiresUserConfirmation?: boolean;
}

/**
 * Official Binance Web3 DeFi API Error Code Catalog
 * Source: https://web3.binance.com/en/dev-docs/products/defi-api/error-codes
 */
export const BINANCE_DEFI_ERROR_CATALOG: Record<number, BinanceDefiErrorSpec> = {
  0: {
    code: 0,
    httpStatus: 200,
    category: "SUCCESS",
    title: "Success",
    description: "Request completed successfully.",
    userAction: "No action required.",
    retryable: false,
  },
  40001: {
    code: 40001,
    httpStatus: 400,
    category: "PARAM",
    title: "Parameter Error",
    description: "Invalid parameter value, format, or mutually exclusive fields (e.g. ratio and token in redeem).",
    userAction: "Check token amounts, wallet address format, and mutually exclusive fields.",
    retryable: false,
  },
  40101: {
    code: 40101,
    httpStatus: 401,
    category: "AUTH",
    title: "Invalid API Key",
    description: "Missing or unrecognized X-OC-APIKEY header.",
    userAction: "Verify BINANCE_WEB3_API_KEY configuration.",
    retryable: false,
  },
  40102: {
    code: 40102,
    httpStatus: 401,
    category: "AUTH",
    title: "Invalid Signature",
    description: "HMAC-SHA256 X-OC-SIGN verification failed (ensure /build prefix is included in signed path).",
    userAction: "Verify BINANCE_WEB3_SECRET_KEY and signature payload alignment.",
    retryable: false,
  },
  40103: {
    code: 40103,
    httpStatus: 401,
    category: "AUTH",
    title: "Invalid Timestamp",
    description: "X-OC-TIMESTAMP is outside the allowed X-OC-RECV-WINDOW tolerance.",
    userAction: "Sync system clock and retry.",
    retryable: true,
  },
  40104: {
    code: 40104,
    httpStatus: 403,
    category: "AUTH",
    title: "Insufficient API Permission",
    description: "API key does not have DeFi API access enabled.",
    userAction: "Enable DeFi API permissions in Binance Web3 Developer Portal.",
    retryable: false,
  },
  40301: {
    code: 40301,
    httpStatus: 403,
    category: "COMPLIANCE",
    title: "IP Not Whitelisted",
    description: "Caller IP address is not in the API key whitelist.",
    userAction: "Add the server egress IP to the Binance Web3 API whitelist.",
    retryable: false,
  },
  40302: {
    code: 40302,
    httpStatus: 403,
    category: "COMPLIANCE",
    title: "Region Restricted",
    description: "Service is restricted in the current jurisdiction.",
    userAction: "Check regional availability for this protocol.",
    retryable: false,
  },
  40303: {
    code: 40303,
    httpStatus: 403,
    category: "COMPLIANCE",
    title: "Compliance Check Failed",
    description: "Request blocked by protocol compliance rules.",
    userAction: "Use a compliant wallet address.",
    retryable: false,
  },
  40311: {
    code: 40311,
    httpStatus: 403,
    category: "KYT",
    title: "KYT High-Risk Address",
    description: "Wallet address flagged by KYT risk screening (high risk).",
    userAction: "Transaction blocked for security compliance.",
    retryable: false,
  },
  40312: {
    code: 40312,
    httpStatus: 403,
    category: "KYT",
    title: "KYT Sanctioned Entity",
    description: "Address or target contract is associated with a sanctioned entity.",
    userAction: "Transaction blocked by sanctions screening.",
    retryable: false,
  },
  40313: {
    code: 40313,
    httpStatus: 403,
    category: "KYT",
    title: "KYT Protocol Blocked",
    description: "Interaction with this contract is currently restricted by KYT policy.",
    userAction: "Select another verified DeFi market.",
    retryable: false,
  },
  40314: {
    code: 40314,
    httpStatus: 403,
    category: "KYT",
    title: "KYT Medium-Risk Warning",
    description: "Address or pool has a medium-risk KYT flag; user confirmation is required before proceeding.",
    userAction: "Review the risk warning and explicitly confirm if you wish to proceed.",
    retryable: true,
    requiresUserConfirmation: true,
  },
  40411: {
    code: 40411,
    httpStatus: 400,
    category: "NOT_FOUND",
    title: "Unsupported Chain",
    description: "The requested binanceChainId is not supported by the Binance Web3 DeFi API.",
    userAction: "Switch to one of the 10 supported EVM chains (BNB, ETH, Base, Arbitrum, Polygon, Optimism, Avalanche, Robinhood, Katana, or Arc).",
    retryable: false,
  },
  40457: {
    code: 40457,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "No Liquidity Available to Remove",
    description: "The specified LP position or NFT ID has zero removable liquidity.",
    userAction: "Refresh your positions and verify the LP NFT ID and ratio.",
    retryable: false,
  },
  40459: {
    code: 40459,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "Failed to Build Transaction",
    description: "Protocol adapter could not construct calldata for the given parameters.",
    userAction: "Try adjusting slippageBps or token amount and rebuild.",
    retryable: true,
  },
  40460: {
    code: 40460,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "Transaction Simulation Failed",
    description: "On-chain simulation reverted during pre-execution check.",
    userAction: "Verify token allowance, native gas balance, and slippage tolerance.",
    retryable: true,
  },
  40480: {
    code: 40480,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "Insufficient Token Balance",
    description: "Wallet balance is insufficient for the requested deposit or LP amount.",
    userAction: "Reduce the deposit amount or top up your wallet balance.",
    retryable: false,
  },
  40482: {
    code: 40482,
    httpStatus: 502,
    category: "TX_BUILD",
    title: "Upstream RPC Node Error",
    description: "Chain RPC failed to respond during state read or gas estimation.",
    userAction: "Transient RPC node failure — retry the request.",
    retryable: true,
  },
  40484: {
    code: 40484,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "Contract Preview Reverted",
    description: "Smart contract preview call reverted with a protocol-specific message.",
    userAction: "Inspect the contract revert reason and adjust parameters.",
    retryable: false,
  },
  40485: {
    code: 40485,
    httpStatus: 400,
    category: "TX_BUILD",
    title: "Redeem Amount Exceeds Position",
    description: "Requested redemption amount or ratio exceeds the user's staked/supplied balance.",
    userAction: "Enter an amount up to your available position balance (or ratio <= 1).",
    retryable: false,
  },
  42900: {
    code: 42900,
    httpStatus: 429,
    category: "RATE_LIMIT",
    title: "Rate Limit Exceeded",
    description: "Too many DeFi API requests within the current window.",
    userAction: "Wait a few seconds and retry.",
    retryable: true,
  },
  50000: {
    code: 50000,
    httpStatus: 500,
    category: "SERVER",
    title: "Internal Server Error",
    description: "Binance Web3 DeFi service encountered an internal error.",
    userAction: "Retry shortly.",
    retryable: true,
  },
  50001: {
    code: 50001,
    httpStatus: 502,
    category: "SERVER",
    title: "Upstream Protocol Error",
    description: "Upstream DeFi protocol indexer timed out or returned invalid data.",
    userAction: "Retry shortly.",
    retryable: true,
  },
};

export function translateBinanceDefiError(code: number, upstreamMsg?: string): BinanceDefiErrorSpec & { upstreamMsg?: string } {
  const base = BINANCE_DEFI_ERROR_CATALOG[code] ?? {
    code,
    httpStatus: 400,
    category: "TX_BUILD" as const,
    title: `DeFi API Error (${code})`,
    description: upstreamMsg || "Unexpected error from Binance Web3 DeFi API.",
    userAction: "Verify request parameters and try again.",
    retryable: false,
  };
  return {
    ...base,
    // Per official docs: for 40484 (Contract Preview Reverted), always surface upstream `msg` directly.
    description: code === 40484 && upstreamMsg ? upstreamMsg : base.description,
    upstreamMsg,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Signs a Binance Web3 Open API request per official Authentication specification:
 *Payload = timestamp + METHOD.toUpperCase() + requestPathWithBuildPrefix + rawBody
 * Signature = Base64(HMAC-SHA256(Payload, secretKey))
 *
 * CRITICAL: `apiPath` is e.g. `/api/v1/defi/data/protocol/list`, and the signed
 * `requestPath` MUST start with `/build` (`/build/api/v1/defi/data/protocol/list`).
 */
export async function signBinanceWeb3Request(params: {
  timestamp: string;
  method: string;
  apiPath: string;
  body: string;
  secretKey: string;
}): Promise<{
  signature: string;
  signedPath: string;
  payloadToSign: string;
}> {
  const normalizedApiPath = params.apiPath.startsWith("/") ? params.apiPath : `/${params.apiPath}`;
  const signedPath = normalizedApiPath.startsWith("/build/")
    ? normalizedApiPath
    : `${BINANCE_WEB3_SIGN_PREFIX}${normalizedApiPath}`;
  const methodUpper = params.method.toUpperCase();
  const payloadToSign = `${params.timestamp}${methodUpper}${signedPath}${params.body}`;

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(params.secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(payloadToSign));
  const signature = bytesToBase64(new Uint8Array(sigBuf));

  return { signature, signedPath, payloadToSign };
}

/**
 * Validates transaction parameters according to the official Integration Flow & REST API docs
 * before hitting the upstream gateway or fallback builder.
 */
export function validateBinanceDefiRequest(
  action: string,
  payload: Record<string, unknown>,
): { valid: true } | { valid: false; code: number; msg: string } {
  const chainId = payload.binanceChainId != null ? String(payload.binanceChainId) : undefined;
  if (
    chainId &&
    !(BINANCE_DEFI_SUPPORTED_CHAIN_IDS as readonly string[]).includes(chainId)
  ) {
    return {
      valid: false,
      code: 40411,
      msg: `Chain ID ${chainId} is not supported by Binance Web3 DeFi API.`,
    };
  }

  if (action === "transaction/redeem") {
    const hasRatio = payload.ratio !== undefined && payload.ratio !== null && payload.ratio !== "";
    const hasToken = payload.token !== undefined && payload.token !== null;
    if ((hasRatio && hasToken) || (!hasRatio && !hasToken)) {
      return {
        valid: false,
        code: 40001,
        msg: "Redeem requires either 'ratio' in (0, 1] OR 'token' { tokenAddress, amount }, and they are mutually exclusive.",
      };
    }
    if (hasRatio) {
      const r = Number(payload.ratio);
      if (!Number.isFinite(r) || r <= 0 || r > 1) {
        return {
          valid: false,
          code: 40001,
          msg: "Redeem 'ratio' must be a number in the range (0, 1].",
        };
      }
    }
  }

  if (action === "transaction/claim") {
    const claimType = String(payload.claimType ?? "");
    const validClaimTypes: BinanceDefiClaimType[] = [
      "REWARD_PROTOCOL",
      "REWARD_INVESTMENT",
      "LP_FEE",
      "REDEMPTION",
    ];
    if (!validClaimTypes.includes(claimType as BinanceDefiClaimType)) {
      return {
        valid: false,
        code: 40001,
        msg: `Invalid claimType '${claimType}'. Expected one of: ${validClaimTypes.join(", ")}.`,
      };
    }
    if (claimType === "REWARD_PROTOCOL" && !payload.investmentId && !payload.binanceChainId) {
      return {
        valid: false,
        code: 40001,
        msg: "binanceChainId is required when claimType is REWARD_PROTOCOL without investmentId.",
      };
    }
  }

  if (action === "transaction/lp-remove") {
    const r = Number(payload.ratio);
    if (!payload.nftId || !Number.isFinite(r) || r <= 0 || r > 1) {
      return {
        valid: false,
        code: 40001,
        msg: "lp-remove requires a valid 'nftId' and 'ratio' in (0, 1].",
      };
    }
  }

  return { valid: true };
}

/**
 * Canonical Protocol Catalog across all 10 Binance Web3 DeFi Supported Chains
 * (BNB Chain 56, Ethereum 1, Base 8453, Robinhood 4663, Arbitrum 42161,
 * Polygon 137, Optimism 10, Avalanche 43114, Katana 747474, Arc 5042).
 */
/**
 * Agent-facing descriptions for the protocols whose edge copy is deliberately
 * shorter than the SPA's. The TABLE is single-sourced; this PROSE is not.
 */
const EDGE_DESCRIPTIONS: Record<string, string> = {
  aave4: "Unified cross-chain liquidity layer with dynamic risk premiums and automated spoke vaults.",
  helio: "Liquid staking (slisBNB) and CDP stablecoin (lisUSD) protocol on BNB Smart Chain. Note: 7–8 day unbonding delay on standard BNB redemptions.",
  lido: "Industry-standard Ethereum liquid staking protocol issuing stETH and wstETH.",
  morphoblue: "Permissionless lending primitive and curated MetaMorpho vaults with isolated risk parameters.",
  pancakeswap3: "Leading multichain concentrated liquidity DEX on BNB Chain, Ethereum, Base, and Arbitrum.",
  pancakeswap4: "Next-gen modular DEX supporting both CLAMM and LBAMM hooks with gas-optimized vault accounting.",
  quickswap3: "Flagship Algebra-powered concentrated liquidity DEX on Polygon and Katana.",
  rocketpool: "Decentralized, trustless Ethereum proof-of-stake pool with permissionless node operators (rETH).",
  uniswap4: "Singleton pool architecture with customizable hooks, native ETH support, and flash accounting.",
  usdai: "Synthetic compute-collateralized stablecoin yield vaults across Arbitrum, Base, and Arc.",
};

/** The catalog the edge resolves `defiProtocolId` against — same array as the SPA. */
export const CANONICAL_BINANCE_DEFI_PROTOCOLS: BinanceDefiProtocolSummary[] = DEFI_PROTOCOLS.map(
  (p): BinanceDefiProtocolSummary => ({
    ...p,
    description: EDGE_DESCRIPTIONS[p.defiProtocolId] ?? p.description,
    category: p.category as BinanceDefiInvestmentType,
    supportedChainIds: p.supportedChainIds as BinanceDefiChainId[],
  }),
);

export const CANONICAL_BINANCE_DEFI_INVESTMENTS: BinanceDefiInvestmentItem[] = [
  {
    investmentId: "bn-aave3-56-usdt",
    defiProtocolId: "aave3",
    protocolName: "Aave V3",
    protocolLogoUrl: "/venues/defi-aave.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "USDT Lending Supply",
    investmentType: "LENDING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "8.42",
    baseApy: "7.12",
    rewardApy: "1.30",
    tvlUsd: "642000000",
    underlyingTokens: [
      {
        tokenName: "Tether USD",
        tokenSymbol: "USDT",
        tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Wrapped BNB",
        tokenSymbol: "WBNB",
        tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-helio-56-bnb",
    defiProtocolId: "helio",
    protocolName: "Lista DAO",
    protocolLogoUrl: "/venues/defi-lista.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "BNB Liquid Staking (slisBNB)",
    investmentType: "LIQUID_STAKING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "19.65",
    baseApy: "3.85",
    rewardApy: "15.80",
    tvlUsd: "915000000",
    underlyingTokens: [
      {
        tokenName: "BNB",
        tokenSymbol: "BNB",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Lista DAO",
        tokenSymbol: "LISTA",
        tokenAddress: "0xFceB31A79F71AC9CBDCF853519c1b12D379EdC46",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [7, 8],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x1adB950d8bB3dA4bE104211D5AB038628e477fE6",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-astherus-56-usdf",
    defiProtocolId: "astherus",
    protocolName: "Aster (Astherus)",
    protocolLogoUrl: "/venues/aster.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "asUSDF Delta-Neutral Yield Vault",
    investmentType: "YIELD",
    investmentSubType: "VAULT",
    apy: "24.80",
    baseApy: "18.40",
    rewardApy: "6.40",
    tvlUsd: "530000000",
    underlyingTokens: [
      {
        tokenName: "Tether USD",
        tokenSymbol: "USDT",
        tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Aster Token",
        tokenSymbol: "AST",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [1, 3],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xdB57a53C428a9faFcbFefFB6dd80d0f427543695",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-venus-56-usdc",
    defiProtocolId: "venus",
    protocolName: "Venus Core Pool",
    protocolLogoUrl: "/venues/defi-venus.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "vUSDC Core Money Market",
    investmentType: "LENDING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "9.85",
    baseApy: "7.65",
    rewardApy: "2.20",
    tvlUsd: "412000000",
    underlyingTokens: [
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Venus",
        tokenSymbol: "XVS",
        tokenAddress: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-pancakeswap3-56-bnb-usdt",
    defiProtocolId: "pancakeswap3",
    protocolName: "PancakeSwap V3",
    protocolLogoUrl: "/venues/defi-pancakeswap.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "WBNB / USDT Concentrated LP (0.05%)",
    investmentType: "LIQUIDITY_POOL",
    investmentSubType: "CONCENTRATED_LP",
    apy: "46.20",
    baseApy: "34.10",
    rewardApy: "12.10",
    tvlUsd: "184000000",
    underlyingTokens: [
      {
        tokenName: "Wrapped BNB",
        tokenSymbol: "WBNB",
        tokenAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        tokenDecimals: 18,
      },
      {
        tokenName: "Tether USD",
        tokenSymbol: "USDT",
        tokenAddress: "0x55d398326f99059fF775485246999027B3197955",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "PancakeSwap Token",
        tokenSymbol: "CAKE",
        tokenAddress: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
        tokenDecimals: 18,
      },
    ],
    feeTierBps: 5,
    redeemDelayDays: [],
    supportsConcentratedLp: true,
    status: "ACTIVE",
    contractAddress: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-aave3-1-usdc",
    defiProtocolId: "aave3",
    protocolName: "Aave V3",
    protocolLogoUrl: "/venues/defi-aave.svg",
    binanceChainId: "1",
    chainName: "Ethereum",
    investmentName: "USDC Core Market Supply",
    investmentType: "LENDING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "6.94",
    baseApy: "6.40",
    rewardApy: "0.54",
    tvlUsd: "2890000000",
    underlyingTokens: [
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-lido-1-steth",
    defiProtocolId: "lido",
    protocolName: "Lido",
    protocolLogoUrl: "/venues/defi-lido.svg",
    binanceChainId: "1",
    chainName: "Ethereum",
    investmentName: "ETH Liquid Staking (stETH)",
    investmentType: "LIQUID_STAKING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "3.45",
    baseApy: "3.45",
    rewardApy: "0.00",
    tvlUsd: "24900000000",
    underlyingTokens: [
      {
        tokenName: "Ether",
        tokenSymbol: "ETH",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-pendle2-1-susde",
    defiProtocolId: "pendle2",
    protocolName: "Pendle V2",
    protocolLogoUrl: "/venues/defi-pendle.svg",
    binanceChainId: "1",
    chainName: "Ethereum",
    investmentName: "PT-sUSDe Fixed Yield Pool",
    investmentType: "YIELD",
    investmentSubType: "SINGLE_TOKEN",
    apy: "22.40",
    baseApy: "19.80",
    rewardApy: "2.60",
    tvlUsd: "840000000",
    underlyingTokens: [
      {
        tokenName: "Staked USDe",
        tokenSymbol: "sUSDe",
        tokenAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Pendle",
        tokenSymbol: "PENDLE",
        tokenAddress: "0x808507121B80c02388fAd14726482e061B8da827",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x888888888889758F76e7103c6CbF23ABbF58F946",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-morphoblue-8453-usdc",
    defiProtocolId: "morphoblue",
    protocolName: "Morpho Blue",
    protocolLogoUrl: "/venues/defi-morpho.svg",
    binanceChainId: "8453",
    chainName: "Base",
    investmentName: "Steakhouse MetaMorpho USDC Vault",
    investmentType: "LENDING",
    investmentSubType: "VAULT",
    apy: "11.92",
    baseApy: "9.82",
    rewardApy: "2.10",
    tvlUsd: "710000000",
    underlyingTokens: [
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Morpho Token",
        tokenSymbol: "MORPHO",
        tokenAddress: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-uniswap4-8453-eth-usdc",
    defiProtocolId: "uniswap4",
    protocolName: "Uniswap V4",
    protocolLogoUrl: "/venues/defi-uniswap.svg",
    binanceChainId: "8453",
    chainName: "Base",
    investmentName: "ETH / USDC Dynamic Hook Pool",
    investmentType: "LIQUIDITY_POOL",
    investmentSubType: "CONCENTRATED_LP",
    apy: "58.40",
    baseApy: "49.10",
    rewardApy: "9.30",
    tvlUsd: "420000000",
    underlyingTokens: [
      {
        tokenName: "Wrapped Ether",
        tokenSymbol: "WETH",
        tokenAddress: "0x4200000000000000000000000000000000000006",
        tokenDecimals: 18,
      },
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [],
    feeTierBps: 5,
    redeemDelayDays: [],
    supportsConcentratedLp: true,
    status: "ACTIVE",
    contractAddress: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-uniswap3-42161-weth-usdc",
    defiProtocolId: "uniswap3",
    protocolName: "Uniswap V3",
    protocolLogoUrl: "/venues/defi-uniswap.svg",
    binanceChainId: "42161",
    chainName: "Arbitrum One",
    investmentName: "WETH / USDC Concentrated LP (0.05%)",
    investmentType: "LIQUIDITY_POOL",
    investmentSubType: "CONCENTRATED_LP",
    apy: "42.75",
    baseApy: "38.50",
    rewardApy: "4.25",
    tvlUsd: "310000000",
    underlyingTokens: [
      {
        tokenName: "Wrapped Ether",
        tokenSymbol: "WETH",
        tokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        tokenDecimals: 18,
      },
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Arbitrum",
        tokenSymbol: "ARB",
        tokenAddress: "0x912CE59144191C1204E64559FE8253a0e49E6548",
        tokenDecimals: 18,
      },
    ],
    feeTierBps: 5,
    redeemDelayDays: [],
    supportsConcentratedLp: true,
    status: "ACTIVE",
    contractAddress: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-solv-56-solvbtc",
    defiProtocolId: "solv",
    protocolName: "Solv Protocol",
    protocolLogoUrl: "/venues/defi-solv.svg",
    binanceChainId: "56",
    chainName: "BNB Smart Chain",
    investmentName: "SolvBTC.BBN Liquid Staking Vault",
    investmentType: "STAKING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "11.80",
    baseApy: "6.40",
    rewardApy: "5.40",
    tvlUsd: "540000000",
    underlyingTokens: [
      {
        tokenName: "BTCB Token",
        tokenSymbol: "BTCB",
        tokenAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Solv",
        tokenSymbol: "SOLV",
        tokenAddress: "0xabe8E5CabE24Cb36df9540088fD7cE1175b9bc52",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x4aae823a6a0b376De6A78e74eCC5b079d38cBCf7",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-quickswap3-137-wpol-usdc",
    defiProtocolId: "quickswap3",
    protocolName: "QuickSwap V3",
    protocolLogoUrl: "/venues/defi-quickswap.svg",
    binanceChainId: "137",
    chainName: "Polygon",
    investmentName: "WPOL / USDC Concentrated LP",
    investmentType: "LIQUIDITY_POOL",
    investmentSubType: "CONCENTRATED_LP",
    apy: "38.90",
    baseApy: "29.40",
    rewardApy: "9.50",
    tvlUsd: "92000000",
    underlyingTokens: [
      {
        tokenName: "Wrapped Polygon",
        tokenSymbol: "WPOL",
        tokenAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        tokenDecimals: 18,
      },
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Quickswap",
        tokenSymbol: "QUICK",
        tokenAddress: "0xB5C064F955D8e7F38fE0460C556a72987494eE17",
        tokenDecimals: 18,
      },
    ],
    feeTierBps: 5,
    redeemDelayDays: [],
    supportsConcentratedLp: true,
    status: "ACTIVE",
    contractAddress: "0x55CAaBB0d2b704FD0eF8192A7E35D8837e678207",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-aave3-10-usdc",
    defiProtocolId: "aave3",
    protocolName: "Aave V3",
    protocolLogoUrl: "/venues/defi-aave.svg",
    binanceChainId: "10",
    chainName: "Optimism",
    investmentName: "USDC Optimism Supply Market",
    investmentType: "LENDING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "7.35",
    baseApy: "5.95",
    rewardApy: "1.40",
    tvlUsd: "285000000",
    underlyingTokens: [
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Optimism",
        tokenSymbol: "OP",
        tokenAddress: "0x4200000000000000000000000000000000000042",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-benqi-43114-savax",
    defiProtocolId: "benqi",
    protocolName: "BENQI",
    protocolLogoUrl: "/venues/defi-benqi.svg",
    binanceChainId: "43114",
    chainName: "Avalanche C-Chain",
    investmentName: "AVAX Liquid Staking (sAVAX)",
    investmentType: "LIQUID_STAKING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "6.45",
    baseApy: "5.80",
    rewardApy: "0.65",
    tvlUsd: "410000000",
    underlyingTokens: [
      {
        tokenName: "Avalanche",
        tokenSymbol: "AVAX",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "BENQI",
        tokenSymbol: "QI",
        tokenAddress: "0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-maple-5042-syrupusdc",
    defiProtocolId: "maple",
    protocolName: "Maple Finance (Syrup)",
    protocolLogoUrl: "/venues/defi-maple.svg",
    binanceChainId: "5042",
    chainName: "Arc",
    investmentName: "Syrup Institutional USDC Vault (Arc Mainnet)",
    investmentType: "RWA",
    investmentSubType: "VAULT",
    apy: "11.60",
    baseApy: "10.10",
    rewardApy: "1.50",
    tvlUsd: "165000000",
    underlyingTokens: [
      {
        tokenName: "Arc Native USDC",
        tokenSymbol: "USDC",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [
      {
        tokenName: "Syrup Token",
        tokenSymbol: "SYRUP",
        tokenAddress: "0x643C4E15d7d62Ad0aBeC4a9BD4b001aA3Ef52d66",
        tokenDecimals: 18,
      },
    ],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-aave4-5042-usdc",
    defiProtocolId: "aave4",
    protocolName: "Aave V4",
    protocolLogoUrl: "/venues/defi-aave.svg",
    binanceChainId: "5042",
    chainName: "Arc",
    investmentName: "Arc Unified USDC Liquidity Hub",
    investmentType: "LENDING",
    investmentSubType: "SINGLE_TOKEN",
    apy: "13.45",
    baseApy: "11.25",
    rewardApy: "2.20",
    tvlUsd: "240000000",
    underlyingTokens: [
      {
        tokenName: "Arc Native USDC",
        tokenSymbol: "USDC",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xA400000000000000000000000000000000005042",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-frax-4663-sfrxeth",
    defiProtocolId: "frax",
    protocolName: "Frax Finance",
    protocolLogoUrl: "/venues/defi-frax.svg",
    binanceChainId: "4663",
    chainName: "Robinhood Chain",
    investmentName: "sfrxETH Robinhood Yield Vault",
    investmentType: "LIQUID_STAKING",
    investmentSubType: "VAULT",
    apy: "9.40",
    baseApy: "7.80",
    rewardApy: "1.60",
    tvlUsd: "128000000",
    underlyingTokens: [
      {
        tokenName: "Ether",
        tokenSymbol: "ETH",
        tokenAddress: "0x0000000000000000000000000000000000000000",
        tokenDecimals: 18,
      },
    ],
    rewardTokens: [],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xac3E018457B222d93114458476f3E3416Abbe38F",
    sourceProvider: "binance-web3",
  },
  {
    investmentId: "bn-morphoblue-747474-usdc",
    defiProtocolId: "morphoblue",
    protocolName: "Morpho Blue",
    protocolLogoUrl: "/venues/defi-morpho.svg",
    binanceChainId: "747474",
    chainName: "Katana",
    investmentName: "Katana Institutional USDC Vault",
    investmentType: "LENDING",
    investmentSubType: "VAULT",
    apy: "15.10",
    baseApy: "12.90",
    rewardApy: "2.20",
    tvlUsd: "145000000",
    underlyingTokens: [
      {
        tokenName: "USD Coin",
        tokenSymbol: "USDC",
        tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        tokenDecimals: 6,
      },
    ],
    rewardTokens: [],
    redeemDelayDays: [],
    supportsConcentratedLp: false,
    status: "ACTIVE",
    contractAddress: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    sourceProvider: "binance-web3",
  },
];

/**
 * Generates deterministic, specification-compliant calldata items (`APPROVE` + main action)
 * when operating in local/preview fallback mode (no `BINANCE_WEB3_API_KEY` set).
 */
export function buildFallbackTransactionResponse(
  action: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const investmentId = String(payload.investmentId ?? "bn-aave3-56-usdt");
  const inv =
    CANONICAL_BINANCE_DEFI_INVESTMENTS.find((x) => x.investmentId === investmentId) ??
    CANONICAL_BINANCE_DEFI_INVESTMENTS[0];

  const primaryToken = inv.underlyingTokens[0];
  const isNative =
    !primaryToken ||
    primaryToken.tokenAddress === "0x0000000000000000000000000000000000000000";

  const callDataList: BinanceDefiCallDataItem[] = [];

  if (action === "transaction/deposit" || action === "transaction/lp-add") {
    if (!isNative && primaryToken) {
      // ERC-20 approve(address spender, uint256 amount) selector 0x095ea7b3
      const spenderPadded = inv.contractAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const maxUint256 = "f".repeat(64);
      callDataList.push({
        to: primaryToken.tokenAddress,
        data: `0x095ea7b3${spenderPadded}${maxUint256}`,
        value: "0x0",
        gasLimit: "65000",
        gasPrice: "1000000000",
        maxFeePerGas: "1500000000",
        maxPriorityFeePerGas: "100000000",
        callDataType: "APPROVE",
      });
    }
    callDataList.push({
      to: inv.contractAddress,
      data: "0xe8eda9df0000000000000000000000000000000000000000000000000000000000000001",
      value: isNative ? "0xde0b6b3a7640000" : "0x0",
      gasLimit: action === "transaction/lp-add" ? "380000" : "220000",
      gasPrice: "1000000000",
      maxFeePerGas: "1500000000",
      maxPriorityFeePerGas: "100000000",
      callDataType: action === "transaction/lp-add" ? "LP_ADD" : "DEPOSIT",
    });

    return {
      investmentId: inv.investmentId,
      binanceChainId: inv.binanceChainId,
      defiProtocolId: inv.defiProtocolId,
      callDataList,
      validityWindowSec: action === "transaction/lp-add" ? 1200 : 300,
      simulated: Boolean(payload.simulate),
      simulationPassed: true,
      estimatedGasUsd: action === "transaction/lp-add" ? "0.42" : "0.18",
    };
  }

  if (action === "transaction/redeem") {
    callDataList.push({
      to: inv.contractAddress,
      data: "0xdb006a750000000000000000000000000000000000000000000000000000000000000001",
      value: "0x0",
      gasLimit: "240000",
      gasPrice: "1000000000",
      maxFeePerGas: "1500000000",
      maxPriorityFeePerGas: "100000000",
      callDataType: "REDEEM",
    });
    return {
      investmentId: inv.investmentId,
      binanceChainId: inv.binanceChainId,
      defiProtocolId: inv.defiProtocolId,
      redeemDelayDays: inv.redeemDelayDays,
      callDataList,
      simulated: Boolean(payload.simulate),
      simulationPassed: true,
      estimatedGasUsd: "0.21",
    };
  }

  if (action === "transaction/lp-add/calculate") {
    const inputAmount = Number(payload.amount || "1");
    const safeAmount = Number.isFinite(inputAmount) && inputAmount > 0 ? inputAmount : 1;
    const token0 = inv.underlyingTokens[0];
    const token1 = inv.underlyingTokens[1] ?? inv.underlyingTokens[0];
    const isToken0Input =
      !payload.tokenAddress ||
      String(payload.tokenAddress).toLowerCase() === token0.tokenAddress.toLowerCase();
    const pairRatio = token0.tokenSymbol.includes("ETH")
      ? 2680
      : token0.tokenSymbol.includes("BNB")
      ? 610
      : 1;
    const pairedAmount = isToken0Input
      ? (safeAmount * pairRatio).toFixed(4)
      : (safeAmount / pairRatio).toFixed(6);

    return {
      investmentId: inv.investmentId,
      inputTokenAddress: payload.tokenAddress ?? token0.tokenAddress,
      inputAmount: String(safeAmount),
      pairedToken: isToken0Input ? token1 : token0,
      pairedAmount,
      tickLower: payload.tickLower ?? -887220,
      tickUpper: payload.tickUpper ?? 887220,
      priceRange: payload.priceRange ?? ["0.85", "1.15"],
      shareOfPoolPct: "0.012",
    };
  }

  if (action === "transaction/lp-remove") {
    callDataList.push({
      to: inv.contractAddress,
      data: "0x0c49ccbe0000000000000000000000000000000000000000000000000000000000000001",
      value: "0x0",
      gasLimit: "310000",
      gasPrice: "1000000000",
      maxFeePerGas: "1500000000",
      maxPriorityFeePerGas: "100000000",
      callDataType: "LP_REMOVE",
    });
    return {
      investmentId: inv.investmentId,
      binanceChainId: inv.binanceChainId,
      nftId: String(payload.nftId),
      ratio: String(payload.ratio),
      validityWindowSec: 1200,
      callDataList,
      simulated: Boolean(payload.simulate),
      simulationPassed: true,
      estimatedGasUsd: "0.34",
    };
  }

  if (action === "transaction/claim") {
    callDataList.push({
      to: inv.contractAddress,
      data: "0x4e71d92d0000000000000000000000000000000000000000000000000000000000000001",
      value: "0x0",
      gasLimit: "165000",
      gasPrice: "1000000000",
      maxFeePerGas: "1500000000",
      maxPriorityFeePerGas: "100000000",
      callDataType: "CLAIM",
    });
    return {
      claimType: payload.claimType,
      binanceChainId: payload.binanceChainId ?? inv.binanceChainId,
      defiProtocolId: payload.defiProtocolId ?? inv.defiProtocolId,
      investmentId: payload.investmentId ?? inv.investmentId,
      callDataList,
      simulated: Boolean(payload.simulate),
      simulationPassed: true,
      estimatedGasUsd: "0.14",
    };
  }

  return { callDataList: [] };
}

export const DEFI_PROTOCOL_ALIASES: Readonly<Record<string, string>> = {
  "aave-v3": "aave3",
  aave: "aave3",
  "aave-v4": "aave4",
  "uniswap-v3": "uniswap3",
  uniswap: "uniswap3",
  "uniswap-v4": "uniswap4",
  "pancake-v3": "pancakeswap3",
  "pancakeswap-v3": "pancakeswap3",
  pancakeswap: "pancakeswap3",
  "pancake-v4": "pancakeswap4",
  "pancakeswap-v4": "pancakeswap4",
  morpho: "morphoblue",
  "morpho-blue": "morphoblue",
  pendle: "pendle2",
  "pendle-v2": "pendle2",
  lista: "helio",
  "lista-dao": "helio",
  aster: "astherus",
  quickswap: "quickswap3",
  "quickswap-v3": "quickswap3",
  ember: "emberso",
  re: "rexyz",
  "re.xyz": "rexyz",
  "usd.ai": "usdai",
  "usd-ai": "usdai",
};

/**
 * Normalize any user or AI-agent protocol slug/name (e.g. `"aave-v3"`,
 * `"Morpho Blue"`, `"Lista DAO"`, `"re.xyz"`) to its canonical Binance Web3
 * DeFi `defiProtocolId` (`"aave3"`, `"morphoblue"`, `"helio"`, `"rexyz"`).
 */
export function resolveDefiProtocolId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return undefined;
  const aliased = DEFI_PROTOCOL_ALIASES[cleaned] ?? cleaned;
  const matched = CANONICAL_BINANCE_DEFI_PROTOCOLS.find(
    (p) =>
      p.defiProtocolId.toLowerCase() === aliased ||
      p.protocolName.toLowerCase() === cleaned ||
      p.protocolName.toLowerCase().includes(cleaned),
  );
  return matched?.defiProtocolId ?? aliased;
}

