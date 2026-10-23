import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizeUrl, base64url, parseCallback, pkcePair } from "./browser-auth.js";

describe("pkce", () => {
  it("matches the RFC 7636 vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("generates verifiers with 256 bits of entropy", () => {
    const a = pkcePair();
    const b = pkcePair();
    assert.notEqual(a.verifier, b.verifier);
    assert.equal(Buffer.from(a.verifier.replaceAll("-", "+").replaceAll("_", "/"), "base64").length, 32);
  });
});

describe("parseCallback", () => {
  it("accepts code with matching state", () => {
    assert.deepEqual(parseCallback({ code: "jw3code_x", state: "s1" }, "s1"), { code: "jw3code_x" });
  });
  it("rejects state mismatch (CSRF)", () => {
    const r = parseCallback({ code: "x", state: "evil" }, "s1") as { invalid: string };
    assert.match(r.invalid, /state mismatch/);
  });
  it("surfaces provider denial", () => {
    assert.deepEqual(parseCallback({ error: "access_denied", state: "s1" }, "s1"), {
      oauthError: "access_denied",
    });
  });
  it("rejects code-less callbacks", () => {
    const r = parseCallback({ state: "s1" }, "s1") as { invalid: string };
    assert.match(r.invalid, /no code/);
  });
});

describe("authorizeUrl", () => {
  it("carries PKCE + state to the public endpoint", () => {
    const u = authorizeUrl({
      clientId: "jw3cli_x",
      redirectUri: "http://127.0.0.1:9/callback",
      challenge: "ch",
      state: "st",
      scope: "mcp:read",
    });
    assert.ok(u.startsWith("https://www.jw3.ai/mcp/authorize?"));
    for (const part of ["client_id=jw3cli_x", "code_challenge=ch", "code_challenge_method=S256", "state=st"]) {
      assert.ok(u.includes(part), part);
    }
  });
});
