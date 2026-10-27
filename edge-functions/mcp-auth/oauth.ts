// mcp-oauth — OAuth 2.1 authorization server for MCP harness access.
//
// The /mcp resource server (mcp-server) accepts harness PATs. This function
// is how third-party clients OBTAIN one with user consent:
//
//   POST /register   (RFC 7591 minimal, public clients): {redirect_uris,
//                      client_name} → {client_id}
//   GET  /authorize  ?response_type=code&client_id&redirect_uri&scope&
//                      code_challenge&code_challenge_method=S256&state
//                    → 302 to the in-app approve screen (user logs in there;
//                      login never touches this function)
//   POST /approve     (Supabase JWT): {request_id params} → {code, state}
//                    → the app redirects the browser to redirect_uri
//   POST /token       grant_type=authorization_code + code_verifier
//                    → {access_token: jw3_mcp_…, token_type: Bearer}
//                      (the access token IS a scoped PAT — verification,
//                      scopes and revocation reuse the PAT path)
//   GET  /validate    ?client_id&redirect_uri → {ok:true} (allowlist check
//                      for the in-app approve screen's client-side deny path)
//   GET  /well-known/protected-resource
//   GET  /well-known/authorization-server
//
// Site vercel.json maps the public URLs (/mcp/authorize, /mcp/token,
// /mcp/register, /.well-known/…) here. Gateway JWT check stays OFF:
// /authorize and metadata are public; /approve and /token enforce their
// own auth (JWT / PKCE-bound code) inside the handler.
import { fail, ok, readJson } from "../_shared/respond.ts";
import { requireUser } from "../_shared/auth.ts";
import { checkRateLimit, ipFromRequest, rateLimitedResponse } from "../_shared/rate-limit.ts";
import { getServiceClient } from "../_shared/clients.ts";
import { requireYoloEligible } from "../_shared/execute-guard.ts";
import {
  filterScopes as parseScopes,
  GRANTABLE_SCOPES as GRANTABLE,
  MCP_TOKEN_PREFIX as PREFIX,
  randomSecret as randomId,
  sha256Hex,
} from "../_shared/mcp-auth.ts";
import { isValidPkceShape, safeEqualStrings } from "./router.ts";
const ISSUER = "https://www.jw3.ai/mcp";
const APPROVE_URL = "https://www.jw3.ai/dashboard/mcp-approve";

export async function handleOAuth(req: Request, fnPath = "/mcp-oauth"): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const tail = path.endsWith(fnPath) ? "/" : path.slice(path.lastIndexOf(fnPath) + fnPath.length) || "/";
    const admin = getServiceClient();

    // ---- public metadata (RFC 8414 §3 + RFC 9728 §3) ----
    if (req.method === "GET" && tail === "/well-known/protected-resource") {
      return ok({
        resource: ISSUER,
        authorization_servers: [ISSUER],
        scopes_supported: [...GRANTABLE],
        bearer_methods_supported: ["header"],
      });
    }
    if (req.method === "GET" && tail === "/well-known/authorization-server") {
      return ok({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...GRANTABLE],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    // ---- dynamic client registration (RFC 7591, public clients) ----
    if (tail === "/register") {
      if (req.method !== "POST") return fail(405, "validation", "POST only.");
      const rl = await checkRateLimit(admin, { bucket: "mcp-oauth-reg", subject: ipFromRequest(req) || "global", limit: 20, windowSec: 3600, failClosed: true });
      if (!rl.ok) return rateLimitedResponse(rl);
      const jr = await readJson<{ redirect_uris?: unknown; client_name?: unknown }>(req, undefined, { maxBytes: 16 * 1024 });
      if (!jr.ok && jr.response.status === 413) return jr.response;
      const body = jr.ok ? (jr.value ?? {}) : {};
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
      const valid = uris.filter((u) => {
        try {
          const p = new URL(u);
          return (p.protocol === "https:" || p.hostname === "localhost" || p.hostname === "127.0.0.1") && !u.includes("#");
        } catch { return false; }
      }).slice(0, 10);
      if (valid.length === 0) return fail(400, "validation", "register needs redirect_uris (https or localhost, no fragments).");
      const client_id = `jw3cli_${randomId(16)}`;
      const { error } = await admin.from("mcp_oauth_clients").insert({
        client_id,
        client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "harness",
        redirect_uris: valid,
      });
      if (error) return fail(500, "internal", "Could not register client.");
      return ok({ client_id, redirect_uris: valid, token_endpoint_auth_method: "none" });
    }

    // ---- redirect validation for the in-app approve screen ----
    // The approve page's DENY path navigates client-side, so it must not
    // trust the redirect_uri query param blindly (open-redirect). This
    // endpoint answers whether (client_id, redirect_uri) matches the
    // registered allowlist — same check /authorize and /approve enforce.
    if (req.method === "GET" && tail === "/validate") {
      const client_id = url.searchParams.get("client_id") ?? "";
      const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
      // Limiter key is IP-led (composite with client_id): a bare client_id
      // subject lets anyone mint quota buckets per guessed id and probe the
      // allowlist without sharing quota.
      const rlSubject = `${ipFromRequest(req) || "unknown"}:${client_id || "unknown"}`;
      const rl = await checkRateLimit(admin, { bucket: "mcp-oauth-val", subject: rlSubject, limit: 60, windowSec: 3600, failClosed: true });
      if (!rl.ok) return rateLimitedResponse(rl);
      // Uniform work and shape on every outcome: one DB fetch, one flat
      // scan of the allowlist, one generic message. Missing params,
      // unknown client, and redirect mismatch are indistinguishable by
      // status, body, or timing (no allowlist oracle).
      const { data: client } = await admin.from("mcp_oauth_clients")
        .select("redirect_uris").eq("client_id", client_id).maybeSingle() as { data: { redirect_uris?: string[] } | null };
      const allowed = Array.isArray(client?.redirect_uris) ? client!.redirect_uris! : [];
      let found = false;
      for (const uri of allowed) {
        if (typeof uri === "string" && safeEqualStrings(uri, redirect_uri)) found = true;
      }
      if (!found || redirect_uri.length === 0) {
        return fail(400, "validation", "Unknown client or redirect_uri mismatch.");
      }
      return ok({ ok: true });
    }

    // ---- authorize: validate, then hand to the in-app approve screen ----
    if (tail === "/authorize") {
      if (req.method !== "GET") return fail(405, "validation", "GET only.");
      const q = url.searchParams;
      const client_id = q.get("client_id") ?? "";
      const redirect_uri = q.get("redirect_uri") ?? "";
      const state = q.get("state") ?? "";
      const challenge = q.get("code_challenge") ?? "";
      const method = q.get("code_challenge_method") ?? "";
      const scopes = parseScopes(q.get("scope"));
      if (q.get("response_type") !== "code") {
        return fail(400, "validation", "response_type=code only.");
      }
      if (!client_id || !redirect_uri || !challenge || method !== "S256" || !state) {
        return fail(400, "validation", "authorize needs client_id, redirect_uri, code_challenge (S256) and state.");
      }
      if (!isValidPkceShape(challenge)) {
        return fail(400, "validation", "code_challenge must be 43-128 chars ([A-Za-z0-9-._~], S256).");
      }
      const { data: client } = await admin.from("mcp_oauth_clients")
        .select("redirect_uris").eq("client_id", client_id).maybeSingle() as { data: { redirect_uris?: string[] } | null };
      const allowed = Array.isArray(client?.redirect_uris) ? client!.redirect_uris! : [];
      if (!allowed.includes(redirect_uri)) {
        return fail(400, "validation", "Unknown client or redirect_uri mismatch.");
      }
      // trade:execute grants need YOLO eligibility — checked again at /token
      // against the approving user, but fail fast here when requested blindly.
      const next = new URL(APPROVE_URL);
      next.searchParams.set("client_id", client_id);
      next.searchParams.set("redirect_uri", redirect_uri);
      next.searchParams.set("state", state);
      next.searchParams.set("code_challenge", challenge);
      next.searchParams.set("scope", scopes.join(" "));
      return Response.redirect(next.toString(), 302);
    }

    // ---- approve: logged-in user (JWT) consents → single-use code ----
    if (tail === "/approve") {
      if (req.method !== "POST") return fail(405, "validation", "POST only.");
      const auth = await requireUser(req);
      if (!auth.ok || auth.via !== "jwt") return fail(401, "unauthorized", "Sign in first.");
      const rl = await checkRateLimit(admin, { bucket: "mcp-oauth-appr", subject: auth.userId, limit: 20, windowSec: 3600, failClosed: true });
      if (!rl.ok) return rateLimitedResponse(rl);
      const jr = await readJson<Record<string, unknown>>(req, undefined, { maxBytes: 16 * 1024 });
      if (!jr.ok && jr.response.status === 413) return jr.response;
      const body = jr.ok ? (jr.value ?? {}) : {};
      const client_id = typeof body.client_id === "string" ? body.client_id : "";
      const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
      const challenge = typeof body.code_challenge === "string" ? body.code_challenge : "";
      const scopes = parseScopes(typeof body.scope === "string" ? body.scope : body.scopes);
      if (!client_id || !redirect_uri || !challenge) return fail(400, "validation", "client_id, redirect_uri and code_challenge required.");
      if (!isValidPkceShape(challenge)) {
        return fail(400, "validation", "code_challenge must be 43-128 chars ([A-Za-z0-9-._~], S256).");
      }
      const { data: client } = await admin.from("mcp_oauth_clients")
        .select("redirect_uris").eq("client_id", client_id).maybeSingle() as { data: { redirect_uris?: string[] } | null };
      if (!Array.isArray(client?.redirect_uris) || !client!.redirect_uris!.includes(redirect_uri)) {
        return fail(400, "validation", "Unknown client or redirect_uri mismatch.");
      }
      if (scopes.includes("trade:execute")) {
        const blocked = await requireYoloEligible(admin, auth.userId);
        if (blocked) {
          return fail(403, "forbidden", blocked);
        }
      }
      const code = `jw3code_${randomId(32)}`;
      const { error } = await admin.from("mcp_auth_codes").insert({
        code_hash: await sha256Hex(code),
        client_id, user_id: auth.userId, redirect_uri, scopes,
        code_challenge: challenge,
      });
      if (error) return fail(500, "internal", "Could not issue code.");
      // Echo the exact redirect_uri and granted scopes: the approve screen
      // must display both for user confirmation (server-side part; the
      // client display itself is a sibling concern).
      return ok({ code, state: typeof body.state === "string" ? body.state : "", client_id, redirect_uri, scopes });
    }

    // ---- token: PKCE-bound code → scoped PAT access token ----
    if (tail === "/token") {
      if (req.method !== "POST") return fail(405, "validation", "POST only.");
      const rl = await checkRateLimit(admin, { bucket: "mcp-oauth-tok", subject: ipFromRequest(req) || "anon", limit: 30, windowSec: 60, failClosed: true });
      if (!rl.ok) return rateLimitedResponse(rl);
      const ct = (req.headers.get("content-type") ?? "").toLowerCase();
      const g: Record<string, string> = {};
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const form = await req.formData().catch(() => null);
        if (form) form.forEach((v, k) => { g[k] = String(v); });
      } else {
        const jr = await readJson<Record<string, string>>(req, undefined, { maxBytes: 16 * 1024 });
        if (!jr.ok && jr.response.status === 413) return jr.response;
        if (jr.ok && jr.value && typeof jr.value === "object") Object.assign(g, jr.value);
      }
      if (g.grant_type !== "authorization_code" || !g.code || !g.code_verifier || !g.redirect_uri || !g.client_id) {
        return fail(400, "validation", "grant_type=authorization_code with code, code_verifier, redirect_uri, client_id required.", { oauth_error: "invalid_request" });
      }
      // Same invalid_grant message as a hash mismatch below: shape must not
      // be a distinguishable failure (no verifier oracle).
      if (!isValidPkceShape(g.code_verifier)) {
        return fail(400, "validation", "PKCE verification failed.", { oauth_error: "invalid_grant" });
      }
      const hash = await sha256Hex(g.code);
      const { data: row } = await admin.from("mcp_auth_codes").select(
        "client_id,user_id,redirect_uri,scopes,code_challenge,expires_at,used_at",
      ).eq("code_hash", hash).maybeSingle() as { data: {
        client_id: string; user_id: string; redirect_uri: string; scopes: string[];
        code_challenge: string; expires_at: string; used_at: string | null;
      } | null };
      if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
        return fail(400, "validation", "Code expired, used, or unknown.", { oauth_error: "invalid_grant" });
      }
      if (row.client_id !== g.client_id || row.redirect_uri !== g.redirect_uri) {
        return fail(400, "validation", "client_id/redirect_uri mismatch.", { oauth_error: "invalid_grant" });
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(g.code_verifier));
      const computed = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      if (computed !== row.code_challenge) {
        return fail(400, "validation", "PKCE verification failed.", { oauth_error: "invalid_grant" });
      }
      const { data: consumed } = await admin.from("mcp_auth_codes").update({ used_at: new Date().toISOString() }).eq("code_hash", hash).is("used_at", null).select("code_hash").maybeSingle();
      if (!consumed) {
        return fail(400, "validation", "Code expired, used, or unknown.", { oauth_error: "invalid_grant" });
      }
      // Re-check YOLO eligibility at mint time: stale approvals must not mint trade:execute.
      if (row.scopes.includes("trade:execute")) {
        if (await requireYoloEligible(admin, row.user_id)) {
          return fail(403, "forbidden", "trade:execute needs YOLO eligibility at mint time: kill switch off and autonomy != propose_only.", { oauth_error: "access_denied" });
        }
      }
      // The access token is a scoped PAT: same verification + revocation path,
      // and same 90-day default lifetime as mcp-token (never a forever-token).
      const secret = PREFIX + randomId(32);
      const expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString();
      const { error } = await admin.from("mcp_tokens").insert({
        user_id: row.user_id, name: `oauth:${row.client_id.slice(0, 24)}`,
        token_hash: await sha256Hex(secret), prefix: secret.slice(0, 12), scopes: row.scopes,
        expires_at: expiresAt,
      });
      if (error) return fail(500, "internal", "Could not mint token.");
      return ok({ access_token: secret, token_type: "Bearer", scope: row.scopes.join(" "), expires_at: expiresAt });
    }

    return fail(404, "not_found", "mcp-oauth: /register, /authorize, /approve, /token, /well-known/* only.");
}
