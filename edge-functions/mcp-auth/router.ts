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
