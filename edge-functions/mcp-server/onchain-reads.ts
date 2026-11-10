// mcp-server/onchain-reads.ts — per-wallet status for onchain reads.
//
// Canonical implementation lives in `../_shared/wallet-reads.ts` (synced
// from the jw3_ai checkout — the same module the agent-chat kind=onchain
// `reads` array is built from). This file re-exports it so the harness keeps
// its import path while both transports share one vocabulary:
//
//   ok | empty | invalid-address | no-wallet
export {
  buildWalletReads,
  needsRelink,
  type BalanceRow,
  type WalletPair,
  type WalletRead,
  type WalletReadStatus,
} from "../_shared/wallet-reads.ts";
