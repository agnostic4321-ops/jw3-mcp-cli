// mcp-auth merged-router tests: OAuth tails stay on the OAuth handler,
// everything else is token management (JWT-only at the index) — no network,
// no secrets.
import { assertEquals } from "jsr:@std/assert@0.224.0";
import { routeMcpAuth, mcpAuthTail } from "./router.ts";

const req = (url: string, method = "GET") => new Request(url, { method });

Deno.test("routeMcpAuth: OAuth flows route to oauth", () => {
  const base = "https://x.supabase.co/functions/v1/mcp-auth";
  for (const tail of [
    "",
    "/register",
    "/authorize",
    "/approve",
    "/token",
    "/validate",
    "/well-known/protected-resource",
    "/well-known/authorization-server",
  ]) {
    assertEquals(routeMcpAuth(req(base + tail)), "oauth", tail || "(root)");
  }
});

Deno.test("routeMcpAuth: anything else is token management", () => {
  const base = "https://x.supabase.co/functions/v1/mcp-auth";
  // Both legacy functions served their own root: GET root stays OAuth (its
  // 404), POST root is token management (POST-only).
  assertEquals(routeMcpAuth(req(base, "POST")), "token");
  assertEquals(routeMcpAuth(req(base, "GET")), "oauth");
  assertEquals(routeMcpAuth(req(`${base}/revoke`, "POST")), "token");
});

Deno.test("mcpAuthTail: mirrors the oauth tail computation", () => {
  assertEquals(mcpAuthTail("https://x/functions/v1/mcp-auth/register", "/mcp-auth"), "/register");
  assertEquals(mcpAuthTail("https://x/functions/v1/mcp-auth", "/mcp-auth"), "/");
  assertEquals(mcpAuthTail("https://x/functions/v1/mcp-oauth/register", "/mcp-oauth"), "/register");
});

Deno.test("handleToken: refuses harness PAT callers (prevents mcp:read -> trade:execute escalation)", async () => {
  const { handleToken } = await import("./token.ts");
  for (const action of ["list", "create", "rotate", "revoke"]) {
    const res = await handleToken(
      new Request("https://x.supabase.co/functions/v1/mcp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, scopes: ["trade:execute"] }),
      }),
      {
        fn: "mcp-token",
        userId: "00000000-0000-0000-0000-000000000001",
        authHeader: "Bearer jw3_mcp_test",
        via: "pat",
        scopes: ["mcp:read"],
        startedAt: Date.now(),
      },
    );
    assertEquals(res.status, 403, `PAT must be refused on action=${action}`);
  }
});
