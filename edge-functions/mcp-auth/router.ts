/**
 * mcp-auth/router — pure dispatch for the merged `mcp-auth` edge function.
 * No I/O, no Deno.serve: unit-tested in mcp-auth_test.ts.
 *
 * OAuth flows (public metadata, client registration, authorize/approve/token
 * with their own PKCE + JWT gates) route by URL tail; everything else is
 * token management (list/create/revoke), which the index additionally
 * confines to Settings-issued JWTs — the legacy mcp-token gateway
 * guarantee, since requireUser itself also accepts harness PATs.
 */
export type McpAuthRoute = "oauth" | "token";

/**
 * PKCE shape check (RFC 7636 s4.1): code_verifier and the S256
 * code_challenge are 43-128 chars from the unreserved set
 * [A-Z a-z 0-9 - . _ ~]. Enforced at /authorize and /approve
 * (challenge) and /token (verifier) so malformed values fail fast
 * instead of reaching the DB or the hash compare.
 */
const PKCE_SHAPE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceShape(s: unknown): s is string {
  return typeof s === "string" && PKCE_SHAPE_RE.test(s);
}

/**
 * Length-flat string compare for allowlist checks (/validate): walks the
 * full width of the longer input so match and mismatch take the same path.
 * This flattens the early-exit oracle between "unknown client" and
 * "redirect mismatch", not a substitute for hashing secrets.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

const OAUTH_TAILS = new Set([
  "/",
  "/register",
  "/authorize",
  "/approve",
  "/token",
  "/validate",
  "/well-known/protected-resource",
  "/well-known/authorization-server",
]);

/** URL tail relative to the function path (mirrors the oauth handler). */
export function mcpAuthTail(url: string, fnPath: string): string {
  const path = new URL(url).pathname.replace(/\/$/, "") || "/";
  return path.endsWith(fnPath) ? "/" : path.slice(path.lastIndexOf(fnPath) + fnPath.length) || "/";
}

export function routeMcpAuth(req: Request, fnPath = "/mcp-auth"): McpAuthRoute {
  const tail = mcpAuthTail(req.url, fnPath);
  if (OAUTH_TAILS.has(tail) || tail.startsWith("/well-known/")) {
    // Both legacy functions served their own root: the OAuth root only ever
    // answers GET (anything else is its 404), while token management is
    // POST-only — so a POST to the merged root is token management.
    if (tail === "/" && req.method === "POST") return "token";
    return "oauth";
  }
  return "token";
}
