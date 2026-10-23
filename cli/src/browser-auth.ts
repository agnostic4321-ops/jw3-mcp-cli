/**
 * `jw3 auth login --browser` — OAuth 2.1 + PKCE against the existing
 * mcp-oauth server. No paste: the browser carries the user approval,
 * localhost receives only the single-use code, and the PAT arrives via
 * the PKCE-bound token exchange.
 *
 * Server + approve screen already exist (mcp-oauth, McpApprove page);
 * this file is the missing public-client half. Zero dependencies —
 * node:crypto / node:http / node:child_process only.
 */
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const OAUTH_HOST = "https://www.jw3.ai";

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scope,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
    state: args.state,
  });
  return `${OAUTH_HOST}/mcp/authorize?${q}`;
}

export type CallbackResult = { code: string } | { oauthError: string };

/** Pure parse + state check of the localhost callback query. */
export function parseCallback(
  query: Record<string, string | string[] | undefined>,
  expectedState: string,
): CallbackResult | { invalid: string } {
  const state = Array.isArray(query.state) ? query.state[0] : query.state;
  if (state !== expectedState) return { invalid: "state mismatch — possible CSRF, aborting" };
  const err = Array.isArray(query.error) ? query.error[0] : query.error;
  if (err) return { oauthError: err };
  const code = Array.isArray(query.code) ? query.code[0] : query.code;
  if (!code) return { invalid: "no code in callback" };
  return { code };
}

async function register(redirectUri: string): Promise<string> {
  const res = await fetch(`${OAUTH_HOST}/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "jw3-cli" }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => null)) as { client_id?: string; error?: unknown } | null;
  if (!res.ok || !json?.client_id) throw new Error("client registration failed");
  return json.client_id;
}

async function exchange(args: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.verifier,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
  });
  const res = await fetch(`${OAUTH_HOST}/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    error?: { message?: string } | string;
  } | null;
  if (!res.ok || !json?.access_token) {
    const msg = typeof json?.error === "string" ? json.error : (json?.error?.message ?? `token exchange refused (http ${res.status})`);
    throw new Error(msg);
  }
  return json.access_token;
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function listenCallback(state: string, timeoutMs: number): {
  redirectUri: Promise<string>;
  done: Promise<string>;
} {
  const redirectUri = new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
          return;
        }
        const q: Record<string, string | string[] | undefined> = {};
        u.searchParams.forEach((v, k) => {
          const cur = q[k];
          q[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
        });
        const parsed = parseCallback(q, state);
        clearTimeout(timer);
        if ("code" in parsed) {
          res.writeHead(200, { "Content-Type": "text/html" }).end(
            "<p>Approved — back to your terminal.</p>",
          );
          srv.close();
          serveDone(parsed.code);
        } else if ("oauthError" in parsed) {
          res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Denied — back to your terminal.</p>");
          srv.close();
          serveFail(new Error(`authorization refused (${parsed.oauthError}) — nothing was stored`));
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" }).end("invalid callback");
          srv.close();
          serveFail(new Error(`${parsed.invalid} — nothing was stored`));
        }
      } catch (e) {
        clearTimeout(timer);
        srv.close();
        serveFail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}/callback`);
      else reject(new Error("could not bind localhost callback"));
    });
  });
  let serveDone!: (code: string) => void;
  let serveFail!: (e: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    serveDone = resolve;
    serveFail = reject;
  });
  const timer = setTimeout(() => {
    serveFail(new Error(`timed out — no approval arrived; nothing was stored`));
  }, timeoutMs);
  void timer.unref?.();
  return { redirectUri, done: done.finally(() => clearTimeout(timer)) };
}

export async function cmdBrowserLogin(opts: { scope: string; timeoutSec: number }): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const cb = listenCallback(state, opts.timeoutSec * 1000);
  const redirectUri = await cb.redirectUri;
  const clientId = await register(redirectUri);
  const url = authorizeUrl({ clientId, redirectUri, challenge, state, scope: opts.scope });
  console.log("Opening your browser — sign in (SIWX) if asked, then Approve.");
  console.log("If nothing opens, visit:\n" + url);
  openBrowser(url);
  const code = await cb.done;
  return exchange({ code, verifier, redirectUri, clientId });
}
