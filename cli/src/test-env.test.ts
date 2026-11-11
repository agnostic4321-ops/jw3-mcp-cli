/**
 * The test-run network guard (test-env.ts): tests must never reach
 * production. Every probe here cannot reach the network even if the guard is
 * broken: each fetch carries an already-aborted signal (the real transport
 * rejects it with an AbortError before it opens anything) and the WebSocket
 * carries a duplicated subprotocol (the real constructor throws a
 * SyntaxError before it connects). Getting the guard's own error instead
 * proves the guard decided first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { allowTestNetwork, isLoopbackHost, NetworkGuardError } from "./test-env.js";

const KUCOIN = "https://api-futures.kucoin.com/api/v1/ticker?symbol=SOLUSDTM";
const PRODUCTION = [
  "https://www.jw3.ai/mcp/register",
  "https://nzhbfeahymmyqerzjgbt.supabase.co/functions/v1/mcp-server",
  KUCOIN,
  "https://gamma-api.polymarket.com/markets",
];

const aborted = (): RequestInit => ({ signal: AbortSignal.abort() });
const settle = (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved", (e: unknown) => e);

/** Run `fn` with the guard's stderr lines captured (and kept out of the log). */
async function withNotes(fn: () => unknown): Promise<{ value: unknown; notes: string[] }> {
  const notes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (s.startsWith("[jw3 test network guard]")) {
      notes.push(s.trimEnd());
      return true;
    }
    return (write as (...a: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), notes };
  } finally {
    process.stderr.write = write;
  }
}

function assertRefused(err: unknown, kind: string, url: string): asserts err is NetworkGuardError {
  assert.ok(err instanceof NetworkGuardError, `${url}: want the guard's refusal, got ${String(err)}`);
  assert.equal(err.code, "JW3_TEST_NETWORK_BLOCKED");
  const u = new URL(url);
  assert.ok(err.message.startsWith(`refused ${kind} ${u.protocol}//${u.host}${u.pathname} from `), err.message);
  assert.match(err.message, /test-env\.test\.js/);
  assert.match(err.message, /Nothing was sent/);
}

describe("the test network guard", () => {
  it("refuses jw3.ai, the supabase mcp-server and venue public APIs before anything is sent", async () => {
    for (const url of PRODUCTION) {
      const { value: err, notes } = await withNotes(() => settle(fetch(url, aborted())));
      assertRefused(err, "fetch", url);
      assert.deepEqual(notes, [`[jw3 test network guard] ${err.message}`], "one stderr line per refusal");
    }
    // the query string is where keys travel: never echoed
    const { value: err } = await withNotes(() => settle(fetch(KUCOIN, aborted())));
    assert.ok(err instanceof Error && !err.message.includes("symbol="), String(err));
  });

  it("refuses a URL object and a Request object the same way", async () => {
    for (const input of [new URL(KUCOIN), new Request(KUCOIN, aborted())]) {
      const { value: err } = await withNotes(() => settle(fetch(input, aborted())));
      assertRefused(err, "fetch", KUCOIN);
    }
  });

  it("an explicit opt-in reaches the transport, says why, and is revoked", async () => {
    const url = "https://api-futures.kucoin.com/api/v1/timestamp";
    const revoke = allowTestNetwork("guard self-test: opt-in passthrough", ["api-futures.kucoin.com"]);
    try {
      const passed = await withNotes(() => settle(fetch(url, aborted())));
      // the real transport got it, and aborted it before sending a byte
      assert.equal((passed.value as Error).name, "AbortError", String(passed.value));
      assert.equal(passed.notes.length, 1);
      assert.match(
        passed.notes[0] ?? "",
        /^\[jw3 test network guard\] allowed fetch https:\/\/api-futures\.kucoin\.com\/api\/v1\/timestamp from \S*test-env\.test\.js \(opt-in: guard self-test: opt-in passthrough\)$/,
      );
      // hosts are exact: a sibling host stays refused
      const sibling = "https://api.kucoin.com/api/v1/timestamp";
      assertRefused((await withNotes(() => settle(fetch(sibling, aborted())))).value, "fetch", sibling);
    } finally {
      revoke();
    }
    // revoked: refused again
    assertRefused((await withNotes(() => settle(fetch(url, aborted())))).value, "fetch", url);
  });

  it("an opt-in never carries a PAT", async () => {
    const revoke = allowTestNetwork("guard self-test: PAT check", ["api-futures.kucoin.com"]);
    try {
      for (const send of [
        () => fetch(KUCOIN, { ...aborted(), headers: { Authorization: "Bearer test-not-a-pat" } }),
        () => fetch(new Request(KUCOIN, { ...aborted(), headers: { authorization: "Bearer test-not-a-pat" } })),
      ]) {
        const { value: err } = await withNotes(() => settle(send()));
        assertRefused(err, "fetch", KUCOIN);
        assert.match(err.message, /Authorization header, and an opt-in never carries a PAT/);
      }
    } finally {
      revoke();
    }
  });

  it("an opt-in needs a reason and exact host names", () => {
    assert.throws(() => allowTestNetwork("", ["api-futures.kucoin.com"]), /a reason is required/);
    assert.throws(() => allowTestNetwork("   ", ["api-futures.kucoin.com"]), /a reason is required/);
    assert.throws(() => allowTestNetwork("why", []), /name every host exactly/);
    assert.throws(() => allowTestNetwork("why", [" "]), /name every host exactly/);
  });

  it("refuses a WebSocket to a venue before it connects", async () => {
    const url = "wss://ws-api-futures.kucoin.com/endpoint";
    const { value: err, notes } = await withNotes(() => {
      try {
        new WebSocket(url, ["dup", "dup"]);
        return "constructed";
      } catch (e) {
        return e;
      }
    });
    assertRefused(err, "WebSocket", url);
    assert.equal(notes.length, 1);
  });

  it("keeps loopback open for local servers", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.9.8.7", "[::1]", "::1"]) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ["www.jw3.ai", "nzhbfeahymmyqerzjgbt.supabase.co", "api-futures.kucoin.com", "localhost.jw3.ai", "128.0.0.1", "127.0.0.1.nip.io", "0.0.0.0"]) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });
});
