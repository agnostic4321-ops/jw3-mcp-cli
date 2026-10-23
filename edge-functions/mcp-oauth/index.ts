// mcp-oauth — backward-compat entry point.
// Canonical logic lives in `mcp-auth/` (merged OAuth + token router; shared
// secret/scope/YOLO plumbing in `_shared/mcp-auth.ts`, YOLO eligibility via
// the execute-guard). This shim preserves the function name, public routes,
// and response shapes for existing clients.
import { withHandler } from "../_shared/respond.ts";
import { handleOAuth } from "../mcp-auth/oauth.ts";

Deno.serve(withHandler("mcp-oauth", (req) => handleOAuth(req), { allowGet: true }));
