/**
 * onchain-reads: every linked wallet gets an explicit per-wallet status.
 * A lowercased solana/tron row is a corrupted base58 string (the real
 * address is unrecoverable) — it must surface as invalid-address with a
 * re-link hint, never vanish silently. Every requested chain appears even
 * when no wallet covers it (no-wallet).
 */
import { strict as assert } from "node:assert";
import { buildWalletReads, needsRelink } from "./onchain-reads.ts";

Deno.test("onchain reads: lowercased solana/tron rows need re-link", () => {
  // Funded-account fixtures (stored lowercased in the DB).
  assert.equal(needsRelink("solana", "gbpncw2afzfrodot5v5ymfanfup59u3wtqnubbcgrlmz"), true);
  assert.equal(needsRelink("tron", "terbahhwh13dqmfwtjvnmpxazsqkbjd8ft"), true);
  assert.equal(needsRelink("tron", "tybgb3m2vlgw93rnfa6qxcucbshd17wh"), true);
  // Real mixed-case addresses are probeable.
  assert.equal(needsRelink("solana", "GbpNCw2aFzFRoDoT5v5YmFANfUP59u3WTqnuBbCgrLMz"), false);
  assert.equal(needsRelink("tron", "TerbahhWH13dQmFWTjVNmPxAzSqKbJd8FT"), false);
  // EVM/btc are case-insensitive — never flagged.
  assert.equal(needsRelink("ethereum", "0xb6d49402a1bd678dea613cd5521e7d05996d1f18"), false);
  assert.equal(needsRelink("btc", "bc1pwjvy000000000000000000000000000000000000"), false);
});

Deno.test("onchain reads: funded-account wallet set is fully accounted", () => {
  const pairs = [
    { chain: "ethereum", address: "0xb6d49402a1bd678dea613cd5521e7d05996d1f18" },
    { chain: "solana", address: "gbpncw2afzfrodot5v5ymfanfup59u3wtqnubbcgrlmz" },
    { chain: "tron", address: "terbahhwh13dqmfwtjvnmpxazsqkbjd8ft" },
    { chain: "tron", address: "tybgb3m2vlgw93rnfa6qxcucbshd17wh" },
    { chain: "btc", address: "bc1pexample000000000000000000000000000000000001" },
  ];
  const balances = [
    { chain: "ethereum", address: "0xB6d49402A1BD678Dea613Cd5521e7D05996d1f18", symbol: "ETH", balance: 0 },
    { chain: "btc", address: "bc1pexample000000000000000000000000000000000001", symbol: "BTC", balance: 0 },
  ];
  const reads = buildWalletReads(pairs, balances, null);
  const byAddr = new Map(reads.map((r) => [String(r.address), r.status]));
  // EVM matching is case-insensitive: the checksummed row still counts.
  assert.equal(byAddr.get("0xb6d49402a1bd678dea613cd5521e7d05996d1f18"), "ok");
  assert.equal(byAddr.get("bc1pexample000000000000000000000000000000000001"), "ok");
  assert.equal(byAddr.get("gbpncw2afzfrodot5v5ymfanfup59u3wtqnubbcgrlmz"), "invalid-address");
  assert.equal(byAddr.get("terbahhwh13dqmfwtjvnmpxazsqkbjd8ft"), "invalid-address");
  assert.equal(byAddr.get("tybgb3m2vlgw93rnfa6qxcucbshd17wh"), "invalid-address");
  // 5 linked wallets in, 5 reads out — nothing silently skipped.
  assert.equal(reads.length, 5);
  const relink = reads.find((r) => r.status === "invalid-address")!;
  assert.ok(String(relink.detail).includes("re-link"));
});

Deno.test("onchain reads: every requested chain appears, even uncovered", () => {
  const pairs = [{ chain: "ethereum", address: "0xb6d49402a1bd678dea613cd5521e7d05996d1f18" }];
  const reads = buildWalletReads(pairs, [], ["ethereum", "solana", "ton"]);
  const byChain = new Map(reads.map((r) => [r.chain, r]));
  assert.equal(byChain.get("ethereum")!.status, "empty");
  assert.equal(byChain.get("solana")!.status, "no-wallet");
  assert.equal(byChain.get("ton")!.status, "no-wallet");
  assert.equal(byChain.get("ton")!.address, null);
});

Deno.test("onchain reads: expanded EVM chains need no no-wallet row", () => {
  // One linked EVM address expanded onto polygon (expandEvmPairs output).
  const pairs = [
    { chain: "ethereum", address: "0xb6d49402a1bd678dea613cd5521e7d05996d1f18" },
    { chain: "polygon", address: "0xb6d49402a1bd678dea613cd5521e7d05996d1f18" },
  ];
  const reads = buildWalletReads(pairs, [], ["ethereum", "polygon", "solana"]);
  const chains = reads.map((r) => r.chain).sort();
  assert.deepEqual(chains, ["ethereum", "polygon", "solana"]);
  assert.equal(reads.find((r) => r.chain === "solana")!.status, "no-wallet");
});

Deno.test("onchain reads: unfiltered calls list linked wallets only", () => {
  const pairs = [{ chain: "ethereum", address: "0xb6d49402a1bd678dea613cd5521e7d05996d1f18" }];
  const reads = buildWalletReads(pairs, [], null);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.status, "empty");
});
