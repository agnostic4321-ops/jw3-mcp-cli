// mcp-server/onchain-reads.ts — per-wallet status for onchain reads.
//
// The shared fetchOnchainSnapshot returns balance rows + an aggregate whose
// `wallets` counts linked inputs: a wallet that errors contributes zero rows
// and nothing says which one vanished. This module joins the resolved pairs
// against the returned rows so EVERY linked wallet and EVERY requested chain
// gets an explicit row:
//
//   ok              — probed, ≥1 balance row for this chain+address
//   empty           — probed, no rows came back (honest empty, not $0)
//   invalid-address — stored solana/tron string is lowercased base58: the
//                     real address is unrecoverable, re-link with exact case
//   no-wallet       — a requested chain no linked wallet covers
//
// Pure: no fetch, no clock, no DB.

export type WalletReadStatus = "ok" | "empty" | "invalid-address" | "no-wallet";

export type WalletRead = {
  chain: string;
  address: string | null;
  status: WalletReadStatus;
  /** Machine-useful count (ok rows) or human reason (other states). */
  detail?: string;
  rows?: number;
};

export type WalletPair = { chain: string; address: string };
export type BalanceRow = { chain: string; address?: string };

/** Base58 is case-sensitive: solana/tron live here, EVM/btc do not. */
const CASE_SENSITIVE_CHAINS = new Set(["solana", "tron"]);

/**
 * True when a stored solana/tron address is all-lowercase and therefore
 * cannot be the real address (a real 25–44-char base58 string is mixed-case
 * with overwhelming probability — and a leading lowercase `t` on TRON, whose
 * real addresses start with uppercase `T`, is proof). Such rows can never be
 * probed; flag them for re-link instead of failing silently.
 */
export function needsRelink(chain: string, address: string): boolean {
  if (!CASE_SENSITIVE_CHAINS.has(String(chain ?? "").toLowerCase())) return false;
  const addr = String(address ?? "").trim();
  if (addr.length < 16) return false;
  if (!/[A-Za-z]/.test(addr)) return false;
  return addr === addr.toLowerCase();
}

function pairKey(chain: string, address: string): string {
  return `${String(chain ?? "").toLowerCase()}:${String(address ?? "").toLowerCase()}`;
}

/**
 * One WalletRead per linked pair (deduped), plus a no-wallet row for every
 * requested chain no pair covers. EVM expansion already ran upstream
 * (resolveOnchainPairs → expandEvmPairs), so a requested EVM chain is
 * covered whenever any EVM wallet is linked.
 */
export function buildWalletReads(
  pairs: WalletPair[],
  balances: BalanceRow[],
  requestedChains: string[] | null,
): WalletRead[] {
  const rowCounts = new Map<string, number>();
  for (const b of balances ?? []) {
    const k = pairKey(String(b?.chain ?? ""), String(b?.address ?? ""));
    rowCounts.set(k, (rowCounts.get(k) ?? 0) + 1);
  }
  const reads: WalletRead[] = [];
  const seen = new Set<string>();
  for (const p of pairs ?? []) {
    const chain = String(p?.chain ?? "").toLowerCase();
    const address = String(p?.address ?? "");
    if (!chain || !address) continue;
    const k = pairKey(chain, address);
    if (seen.has(k)) continue;
    seen.add(k);
    if (needsRelink(chain, address)) {
      reads.push({
        chain,
        address,
        status: "invalid-address",
        detail: "stored address is lowercased; Solana/Tron addresses are case-sensitive — re-link the wallet with its exact address",
      });
      continue;
    }
    const n = rowCounts.get(k) ?? 0;
    reads.push(
      n > 0
        ? { chain, address, status: "ok", rows: n }
        : { chain, address, status: "empty", detail: "probed, no balances returned" },
    );
  }
  if (requestedChains) {
    const covered = new Set(reads.map((r) => r.chain));
    for (const c of requestedChains) {
      const chain = String(c ?? "").toLowerCase();
      if (!chain || covered.has(chain)) continue;
      covered.add(chain);
      reads.push({ chain, address: null, status: "no-wallet", detail: "no linked wallet covers this chain" });
    }
  }
  reads.sort((a, b) =>
    a.chain.localeCompare(b.chain) || String(a.address ?? "").localeCompare(String(b.address ?? ""))
  );
  return reads;
}
