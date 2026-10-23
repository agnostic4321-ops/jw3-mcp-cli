/** `jw3 auth login|logout|status` — PAT is verified before it is stored. */
import { createInterface } from "node:readline";
import { clearPat, mcpEndpoint, resolvePat, savePat } from "../config.js";
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

function promptPat(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("PAT (jw3_mcp_…): ", (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

export async function cmdAuth(
  sub: string,
  opts: { pat?: string; url?: string; browser?: boolean; scope?: string; timeoutSec?: number },
): Promise<void> {
  if (sub === "logout") {
    console.log(clearPat() ? "Logged out — stored PAT removed." : "No stored PAT found.");
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
      console.error("No PAT supplied. Pipe it (`echo $PAT | jw3 auth login`), pass --pat, or type it at the prompt.");
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
