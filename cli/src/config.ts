/**
 * Auth + endpoint resolution. PAT lives in the OS user config dir
 * (0600) or JW3_MCP_PAT — never in the repo, never in logs.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export const DEFAULT_SUPABASE_URL = "https://nzhbfeahymmyqerzjgbt.supabase.co";

export function baseUrl(override?: string): string {
  const raw = (override ?? process.env.JW3_SUPABASE_URL ?? DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Supabase URL: ${raw}`);
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(`Refusing non-HTTPS endpoint ${parsed.origin} — bearer PATs require https:// (or localhost for local dev).`);
  }
  return raw;
}

export function mcpEndpoint(override?: string): string {
  return `${baseUrl(override)}/functions/v1/mcp-server`;
}

function configDir(): string {
  if (process.env.JW3_CONFIG_HOME) return process.env.JW3_CONFIG_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

export function credPath(): string {
  return join(configDir(), "credentials.json");
}

export function resolvePat(flag?: string): string | null {
  if (flag && flag.trim()) return flag.trim();
  const env = process.env.JW3_MCP_PAT;
  if (env && env.trim()) return env.trim();
  try {
    if (!existsSync(credPath())) return null;
    const raw = JSON.parse(readFileSync(credPath(), "utf8")) as { pat?: unknown };
    return typeof raw.pat === "string" && raw.pat.trim() ? raw.pat.trim() : null;
  } catch {
    return null;
  }
}

export function savePat(pat: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = credPath();
  writeFileSync(p, JSON.stringify({ pat }), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort; writeFileSync mode already applied on creation
  }
}

export function clearPat(): boolean {
  try {
    if (!existsSync(credPath())) return false;
    unlinkSync(credPath());
    return true;
  } catch {
    return false;
  }
}
