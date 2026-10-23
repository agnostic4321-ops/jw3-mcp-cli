// mcp-token — backward-compat entry point.
// Canonical logic lives in `mcp-auth/` (merged OAuth + token router). This
// shim preserves the function name, wrapper auth gate, and response shapes
// for existing callers.
import { withHandler } from "../_shared/respond.ts";
import { handleToken } from "../mcp-auth/token.ts";

Deno.serve(withHandler("mcp-token", (req, ctx) => handleToken(req, ctx), { auth: true }));
