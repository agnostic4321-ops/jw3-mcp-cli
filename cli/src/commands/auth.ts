/** `jw3 auth login|logout|status` — PAT is verified before it is stored. */
import { baseUrl, clearPat, mcpEndpoint, resolvePat, savePat } from "../config.js";
import { McpError, initialize } from "../mcp.js";
import { cmdBrowserLogin } from "../browser-auth.js";

function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data.trim() || null));
  });
}

/** No-echo TTY read for the interactive PAT prompt (never readline echo). */
function promptPat(): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return resolve(null);
    process.stdout.write("PAT (jw3_mcp_...): ");
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const finish = (v: string | null): void => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // best-effort; raw mode already applied above
      }
      stdin.pause();
      process.stdout.write("\n");
      resolve(v);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish(buf.trim() || null);
          return;
        }
        if (ch === "\u0003") {
          finish(null); // Ctrl+C aborts, nothing stored
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        if (ch < " ") continue; // ignore other control chars
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Best-effort server revocation of the current PAT. The mcp-auth token
 * endpoint (action=revoke, confirm required) exists, but token management
 * is SIWX-JWT-only server-side: harness PATs get 403 by design
 * (edge-functions/mcp-auth/token.ts) and the CLI never learns the token
 * id. So this attempt is opportunistic only; failure is expected and the
 * caller always prints the manual rotation path plus deletes locally.
 */
async function tryServerRevoke(pat: string, url?: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(url)}/functions/v1/mcp-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pat}` },
      body: JSON.stringify({ action: "revoke", confirm: true }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function cmdAuth(
  sub: string,
  opts: { pat?: string; url?: string; browser?: boolean; scope?: string; timeoutSec?: number },
): Promise<void> {
  if (sub === "logout") {
    // Best-effort server revocation first, local delete regardless. The
    // server cannot self-revoke a PAT (JWT-only token management), so the
    // manual rotation path prints whenever the attempt is not confirmed.
    const current = resolvePat(opts.pat);
    if (current) {
      if (await tryServerRevoke(current, opts.url)) {
        console.log("Server revocation confirmed.");
      } else {
        console.error("Server revocation not confirmed — rotate the PAT at Settings > Harness Access (PATs cannot self-revoke server-side).");
      }
    }
    console.log(clearPat() ? "Logged out - stored PAT removed." : "No stored PAT found.");
    return;
  }
  if (sub === "status") {
    const pat = resolvePat(opts.pat);
    if (!pat) {
      console.log("Not configured — run `jw3 auth login` (PAT never printed here).");
      return;
    }
    try {
      const info = await initialize(pat, opts.url);
      console.log(`ok — ${info.server.name} ${info.server.version} (protocol ${info.protocolVersion})`);
    } catch (e) {
      const code = e instanceof McpError ? ` [${e.code}]` : "";
      console.log(`Stored PAT rejected${code}: ${e instanceof Error ? e.message : String(e)} — re-run login.`);
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "login") {
    if (opts.browser) {
      try {
        const pat = await cmdBrowserLogin({
          scope: opts.scope?.trim() || "mcp:read trade:propose",
          timeoutSec: opts.timeoutSec ?? 300,
        });
        savePat(pat);
        console.log(`Approved in browser — PAT stored (0600). Endpoint: ${mcpEndpoint(opts.url)}`);
      } catch (e) {
        console.error(`Browser login failed — nothing stored: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
      return;
    }
    let pat = opts.pat?.trim() || (await readStdin()) || (process.stdin.isTTY ? await promptPat() : null);
    pat = pat?.trim() || null;
    if (!pat) {
      console.error("No PAT supplied. Pipe it (`echo $PAT | jw3 auth login`), use browser login, or type it at the prompt (--pat is debug-only).");
      process.exitCode = 1;
      return;
    }
    try {
      const info = await initialize(pat, opts.url);
      savePat(pat);
      console.log(`Verified (${info.server.name} ${info.server.version}) — PAT stored (0600). Endpoint: ${mcpEndpoint(opts.url)}`);
    } catch (e) {
      console.error(`Login refused — PAT not stored: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }
  console.error("Usage: jw3 auth login|logout|status [--pat …] [--url …] [--browser] [--scope …] [--timeout …]");
  process.exitCode = 2;
}
