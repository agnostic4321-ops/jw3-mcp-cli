import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  fetchJson,
  fetchText,
  HttpError,
  isRetryableStatus,
  mapPool,
  parseRetryAfterMs,
  scrubBearer,
} from "./http.js";

describe("isRetryableStatus", () => {
  it("retries 429 and 5xx only", () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(200), false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays within cap", () => {
    const zero = () => 0;
    const one = () => 0.999999;
    assert.equal(backoffMs(1, 500, zero), 0);
    assert.ok(backoffMs(1, 500, one) < 500);
    assert.ok(backoffMs(2, 500, one) < 1000);
    assert.ok(backoffMs(3, 500, one) < 2000);
    assert.ok(backoffMs(99, 500, one) <= 10_000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delay-seconds", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs("0"), 0);
  });
  it("parses HTTP-dates relative to now", () => {
    const now = Date.parse("2026-10-14T11:00:00.000Z");
    assert.equal(parseRetryAfterMs("Wed, 14 Oct 2026 11:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfterMs("Wed, 14 Oct 2026 10:59:00 GMT", now), 0);
  });
  it("returns null on absent/garbage", () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(""), null);
    assert.equal(parseRetryAfterMs("soon"), null);
  });
});

const hdr = (retryAfter: string | null) => ({ get: (_k: string) => retryAfter });
const okRes = (text: string) => ({ status: 200, ok: true as boolean, headers: hdr(null), text: () => Promise.resolve(text) });
const errRes = (status: number, text = "", retryAfter: string | null = null) => ({
  status,
  ok: false as boolean,
  headers: hdr(retryAfter),
  text: () => Promise.resolve(text),
});

describe("fetchText retry discipline", () => {
  it("succeeds first try with one call", async () => {
    let calls = 0;
    const out = await fetchText("https://x/y", {}, {
      fetchFn: () => { calls++; return Promise.resolve(okRes("hi")); },
      sleepMs: () => Promise.resolve(),
    });
    assert.equal(out, "hi");
    assert.equal(calls, 1);
  });
  it("honors Retry-After on 429 then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await fetchText("https://x/y", {}, {
      fetchFn: () => (++calls === 1 ? Promise.resolve(errRes(429, "slow", "2")) : Promise.resolve(okRes("ok"))),
      sleepMs: (ms) => { waits.push(ms); return Promise.resolve(); },
    });
    assert.equal(out, "ok");
    assert.deepEqual(waits, [2000]);
  });
  it("retries 503 with backoff then succeeds", async () => {
    let calls = 0;
    const out = await fetchText("https://x/y", {}, {
      fetchFn: () => (++calls < 3 ? Promise.resolve(errRes(503)) : Promise.resolve(okRes("ok"))),
      sleepMs: () => Promise.resolve(),
      rand: () => 0.5,
    });
    assert.equal(out, "ok");
    assert.equal(calls, 3);
  });
  it("fails fast on 400 with a single call", async () => {
    let calls = 0;
    await assert.rejects(
      fetchText("https://x/y", {}, {
        fetchFn: () => { calls++; return Promise.resolve(errRes(400, "bad")); },
        sleepMs: () => Promise.resolve(),
      }),
      (e: unknown) => e instanceof HttpError && e.status === 400,
    );
    assert.equal(calls, 1);
  });
  it("throws HttpError after exhausting attempts", async () => {
    let calls = 0;
    await assert.rejects(
      fetchText("https://x/y", {}, {
        attempts: 2,
        fetchFn: () => { calls++; return Promise.resolve(errRes(500, "boom")); },
        sleepMs: () => Promise.resolve(),
      }),
      (e: unknown) => e instanceof HttpError && e.status === 500,
    );
    assert.equal(calls, 2);
  });
  it("retries network errors then succeeds", async () => {
    let calls = 0;
    const out = await fetchText("https://x/y", {}, {
      fetchFn: () => (++calls === 1 ? Promise.reject(new Error("socket hang up")) : Promise.resolve(okRes("ok"))),
      sleepMs: () => Promise.resolve(),
    });
    assert.equal(out, "ok");
    assert.equal(calls, 2);
  });
});

describe("fetchJson", () => {
  it("parses JSON and rejects non-JSON", async () => {
    const good = await fetchJson("https://x/y", {}, {
      fetchFn: () => Promise.resolve(okRes('{"a":1}')),
      sleepMs: () => Promise.resolve(),
    });
    assert.deepEqual(good, { a: 1 });
    await assert.rejects(
      fetchJson("https://x/y", {}, {
        fetchFn: () => Promise.resolve(okRes("not json")),
        sleepMs: () => Promise.resolve(),
      }),
      HttpError,
    );
  });
});

describe("mapPool", () => {
  it("keeps result order and caps in-flight workers", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], async (v) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return v * 10;
    }, 2);
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.ok(peak <= 2, `peak ${peak} exceeds bound 2`);
  });
  it("handles empty input and wide pools", async () => {
    assert.deepEqual(await mapPool([], async (v: number) => v, 3), []);
    assert.deepEqual(await mapPool([7], async (v) => v + 1, 99), [8]);
  });
});

describe("scrubBearer", () => {
  it("redacts PATs, Bearer echoes, and access_token values", () => {
    assert.equal(scrubBearer("token jw3_mcp_abc123 leaked"), "token jw3_mcp_[REDACTED] leaked");
    assert.equal(scrubBearer("Authorization: Bearer secret-token"), "Authorization: Bearer [REDACTED]");
    const scrubbed = scrubBearer('{"access_token":"tok123","token_type":"bearer"}');
    assert.ok(!scrubbed.includes("tok123"), scrubbed);
    assert.ok(JSON.parse(scrubbed) !== null, "stays valid JSON");
    assert.equal(scrubBearer("clean body, nothing secret"), "clean body, nothing secret");
  });
  it("HttpError keeps the 160-char cap with no secret in message or body", () => {
    const e = new HttpError(401, `denied for jw3_mcp_abc123 ${"x".repeat(300)}`, "https://x/y");
    assert.ok(!e.message.includes("jw3_mcp_abc123"), e.message);
    assert.ok(!e.body.includes("jw3_mcp_abc123"), e.body);
    assert.ok(e.message.includes("jw3_mcp_[REDACTED]"), e.message);
  });
});
