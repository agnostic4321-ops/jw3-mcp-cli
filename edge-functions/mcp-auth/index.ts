// mcp-auth — merged MCP credential function.
// OAuth 2.1 authorization-server flows (public client registration,
// authorize/approve/PKCE token exchange with their own gates) and personal
// access token management (list/create/revoke) behind one router. Shared
// secret/scope/YOLO plumbing stays in `_shared/mcp-auth.ts`.
// Token management keeps the legacy wrapper's gate: requireUser (JWT or
// harness PAT) plus POST-only, populated into the handler ctx before
// delegating. (Shared secret/scope plumbing stays in `_shared/mcp-auth.ts`;
// YOLO eligibility itself is enforced inside the handler via the
// execute-guard.)
// The legacy `mcp-oauth` / `mcp-token` entry points are thin shims over the
// same handlers; `mcp-server` (the resource server) is intentionally NOT
// merged here.
import { withHandler, fail, type RequestCtx } from "../_shared/respond.ts";
import { requireUser } from "../_shared/auth.ts";
import { handleOAuth } from "./oauth.ts";
import { handleToken } from "./token.ts";
import { routeMcpAuth } from "./router.ts";

Deno.serve(withHandler("mcp-auth", async (req, ctx) => {
  if (routeMcpAuth(req) === "oauth") return handleOAuth(req, "/mcp-auth");

  // Token management: same gate as the legacy wrapper — requireUser (JWT or
  // harness PAT) plus the method whitelist, populated into the handler ctx.
  // (Shared secret/scope/YOLO plumbing stays in `_shared/mcp-auth.ts`;
  // YOLO eligibility itself is enforced inside the handler via the
  // execute-guard.)
  if (req.method !== "POST") {
    return fail(405, "validation", `Method ${req.method} not allowed`);
  }
  const auth = await requireUser(req);
  if (!auth.ok) {
    return fail(
      auth.status === 401 ? 401 : 500,
      auth.status === 401 ? "unauthorized" : "internal",
      auth.error,
    );
  }
  const authed: RequestCtx = {
    ...ctx,
    userId: auth.userId,
    authHeader: auth.authHeader,
    via: auth.via,
    scopes: auth.scopes,
  };
  return handleToken(req, authed);
}, { allowGet: true }));
