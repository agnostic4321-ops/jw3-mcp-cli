// mcp-token — personal access token management for harness access.
//
// SIWX-JWT authed (requireUser). Actions:
//   list   → active tokens (metadata only, never hashes)
//   create → { name, scopes?, expires_in_days? | expires_at? } → returns the
//            plaintext token ONCE (jw3_mcp_…). Expiry defaults to 90 days
//            (capped at 365); the plaintext leaves the server exactly once.
//   rotate → { id, expires_in_days? | expires_at? } → revokes the named token
//            and mints a same-name/same-scope replacement, returning its
//            plaintext ONCE. trade:execute replacements re-check YOLO.
//   revoke → { id, confirm:true } → soft-revoke. confirm:true is REQUIRED so
//            a stray call cannot kill a live harness; unknown/already-revoked
//            ids 404 instead of reporting success.
// Only the sha256 of the token is stored. Expired tokens never authenticate
// (see _shared/pat.ts). Rate-limited per user.
import { fail, ok, readJson, type RequestCtx } from "../_shared/respond.ts";
import { checkRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { requireYoloEligible } from "../_shared/execute-guard.ts";
import {
  filterScopes,
  MCP_TOKEN_PREFIX as PREFIX,
  randomSecret,
  sha256Hex,
} from "../_shared/mcp-auth.ts";

/** Default token lifetime (days) when the caller passes no expiry. */
const DEFAULT_EXPIRY_DAYS = 90;
/** Hard cap: no token outlives a year, however it is requested. */
const MAX_EXPIRY_DAYS = 365;

/**
 * Resolve the expires_at for a mint from { expires_in_days | expires_at }.
 * Defaults to 90 days; both forms are capped at 365 days out. Past or
 * unparseable dates are a 400, never a silent forever-token.
 */
function resolveExpiry(body: { expires_in_days?: unknown; expires_at?: unknown }):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  const now = Date.now();
  const cap = now + MAX_EXPIRY_DAYS * 86400_000;
  if (body.expires_in_days !== undefined) {
    const days = typeof body.expires_in_days === "string" ? Number(body.expires_in_days) : body.expires_in_days;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      return { ok: false, error: "expires_in_days must be a number > 0 (days)." };
    }
    return { ok: true, value: new Date(now + Math.min(days, MAX_EXPIRY_DAYS) * 86400_000).toISOString() };
  }
  if (body.expires_at !== undefined) {
    const t = new Date(String(body.expires_at)).getTime();
    if (!Number.isFinite(t)) return { ok: false, error: "expires_at must be an ISO date string." };
    if (t <= now) return { ok: false, error: "expires_at must be in the future." };
    return { ok: true, value: new Date(Math.min(t, cap)).toISOString() };
  }
  return { ok: true, value: new Date(now + DEFAULT_EXPIRY_DAYS * 86400_000).toISOString() };
}

export async function handleToken(req: Request, ctx: RequestCtx): Promise<Response> {
  try {
    // Token management (list/create/rotate/revoke) is strictly for interactive
    // SIWX-JWT sessions: a harness PAT (especially a read-only `mcp:read` PAT)
    // must NEVER be able to mint itself a `trade:execute` token, rotate tokens,
    // or revoke other tokens.
    if (ctx.via !== "jwt") {
      return fail(403, "forbidden", "Token management requires an interactive session (JWT) — harness PATs cannot mint, rotate, or revoke tokens.");
    }
    const userId = ctx.userId!;
    const admin = getServiceClient();
    const rl = await checkRateLimit(admin, { bucket: "mcp-token", subject: userId, limit: 20, windowSec: 60, failClosed: true });
    if (!rl.ok) return rateLimitedResponse(rl);

    const jr = await readJson<{
      action?: string; name?: string; id?: string; scopes?: unknown;
      confirm?: unknown; expires_in_days?: unknown; expires_at?: unknown;
    }>(req, undefined, { maxBytes: 16 * 1024 });
    if (!jr.ok && jr.response.status === 413) return jr.response;
    const body = jr.ok ? (jr.value ?? {}) : {};
    const action = body.action ?? "list";

    if (action === "list") {
      const { data, error } = await admin.from("mcp_tokens")
        .select("id,name,prefix,scopes,last_used_at,expires_at,created_at")
        .eq("user_id", userId).eq("revoked", false)
        .order("created_at", { ascending: false });
      if (error) return fail(500, "internal", "Could not list tokens.");
      return ok({ tokens: data ?? [] });
    }

    if (action === "create") {
      const name = (body.name ?? "").trim().slice(0, 60) || "harness";
      // Scopes: mcp:read (always) + opt-in trade:propose / trade:execute.
      // trade:execute mints ONLY while the user is YOLO-eligible (kill switch
      // off, autonomy != propose_only) — same gate the chat YOLO flow uses.
      const scopes = filterScopes(body.scopes);
      if (scopes.includes("trade:execute")) {
        const blocked = await requireYoloEligible(admin, userId);
        if (blocked) {
          return fail(403, "forbidden", `${blocked} Mint trade:propose instead, or adjust Risk first.`);
        }
      }
      const exp = resolveExpiry(body);
      if (!exp.ok) return fail(400, "validation", exp.error);
      const secret = PREFIX + randomSecret(32);
      const hash = await sha256Hex(secret);
      const { data, error } = await admin.from("mcp_tokens").insert({
        user_id: userId, name, token_hash: hash, prefix: secret.slice(0, 12), scopes,
        expires_at: exp.value,
      }).select("id,name,prefix,scopes,expires_at,created_at").single();
      if (error || !data) return fail(500, "internal", "Could not create token.");
      // Plaintext leaves the server exactly once, in this response.
      return ok({ token: secret, meta: data });
    }

    if (action === "rotate") {
      // Mint-first-then-revoke: the old secret stays live until the
      // replacement row exists, so a failed mint never destroys the only
      // credential (no outage window, unlike revoke-first). No cross-table
      // transaction/RPC exists for an atomic swap, so ordering plus
      // residual reporting is the safety net: if the revoke fails, the new
      // row is rolled back to revoked and the caller is told the old token
      // is unchanged; if even the rollback fails, both ids are reported,
      // never hidden.
      if (!body.id) return fail(400, "validation", "Token id required.");
      const { data: cur, error: curErr } = await admin.from("mcp_tokens")
        .select("id,name,scopes").eq("id", body.id).eq("user_id", userId).eq("revoked", false).maybeSingle();
      if (curErr) return fail(500, "internal", "Could not rotate token.");
      if (!cur) return fail(404, "not_found", "Token not found (or already revoked).");
      const row = cur as { id: string; name: string; scopes: string[] };
      const scopes = Array.isArray(row.scopes) ? row.scopes : filterScopes(row.scopes);
      if (scopes.includes("trade:execute")) {
        const blocked = await requireYoloEligible(admin, userId);
        if (blocked) {
          return fail(403, "forbidden", `${blocked} Mint trade:propose instead, or adjust Risk first.`);
        }
      }
      const exp = resolveExpiry(body);
      if (!exp.ok) return fail(400, "validation", exp.error);
      const secret = PREFIX + randomSecret(32);
      const hash = await sha256Hex(secret);
      const { data, error } = await admin.from("mcp_tokens").insert({
        user_id: userId, name: row.name, token_hash: hash, prefix: secret.slice(0, 12),
        scopes, expires_at: exp.value,
      }).select("id,name,prefix,scopes,expires_at,created_at").single();
      if (error || !data) {
        return fail(500, "internal", "Could not rotate token. The existing token is unchanged.");
      }
      const next = data as { id: string };
      const { error: revErr } = await admin.from("mcp_tokens")
        .update({ revoked: true }).eq("id", row.id).eq("user_id", userId).eq("revoked", false);
      if (revErr) {
        const { error: rbErr } = await admin.from("mcp_tokens")
          .update({ revoked: true }).eq("id", next.id).eq("user_id", userId);
        if (rbErr) {
          return fail(500, "internal", "Rotation incomplete: replacement minted but the old token could not be revoked. Two tokens are live - revoke one manually.", { residual: { old_token_id: row.id, new_token_id: next.id } });
        }
        return fail(500, "internal", "Could not rotate token. The existing token is unchanged.");
      }
      return ok({ token: secret, meta: data, rotated_from: row.id });
    }

    if (action === "revoke") {
      if (!body.id) return fail(400, "validation", "Token id required.");
      // Server-side second factor on top of the UI confirm dialog: a stray
      // or replayed call without explicit confirmation must not kill a live
      // harness. Unknown/already-revoked ids 404 — never a false success.
      if (body.confirm !== true) {
        return fail(400, "validation", "Pass {confirm:true} to confirm revocation — harnesses using this token lose access immediately.");
      }
      const { data: cur, error: curErr } = await admin.from("mcp_tokens")
        .select("id").eq("id", body.id).eq("user_id", userId).eq("revoked", false).maybeSingle();
      if (curErr) return fail(500, "internal", "Could not revoke token.");
      if (!cur) return fail(404, "not_found", "Token not found (or already revoked).");
      const { error } = await admin.from("mcp_tokens")
        .update({ revoked: true }).eq("id", body.id).eq("user_id", userId);
      if (error) return fail(500, "internal", "Could not revoke token.");
      return ok({ revoked: true, id: body.id });
    }

    return fail(400, "validation", `Unknown action: ${action}`);
  } catch (e) {
    return fail(500, "internal", e instanceof Error ? e.message : "mcp-token failed");
  }
}
