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

/**
 * Canonical user config dir for all CLI state.
 *
 * Resolution: $JW3_CONFIG_HOME, else $XDG_CONFIG_HOME/jw3, else
 * ~/.config/jw3. Blank values are ignored so `JW3_CONFIG_HOME=""`
 * falls back instead of resolving to the cwd. Exported so every
 * module shares one copy — do not reimplement it locally.
 */
export function configDir(): string {
  const home = process.env.JW3_CONFIG_HOME?.trim();
  if (home) return home;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

export function credPath(): string {
  return join(configDir(), "credentials.json");
}

export function resolvePat(flag?: string): string | null {
  if (flag && flag.trim()) {
    return flag.trim();
  }
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
  const clean = pat.trim();
  if (!clean) throw new Error("Refusing to store an empty PAT — nothing written.");
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort; an existing dir keeps its current mode
  }
  const p = credPath();
  writeFileSync(p, JSON.stringify({ pat: clean }), { mode: 0o600 });
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

/**
 * Pure: redact bearer-like args for log lines. Masks the value after
 * `--pat`/`--token`/secret-ish flags, `--flag=value` forms, and bare
 * `jw3_mcp_...` tokens. For supervise/daemon child-argv START lines:
 * log `maskBearerArgs(argv).join(" ")`, never the raw argv, whenever a
 * bearer flag may be present.
 */
const BEARER_FLAGS = new Set([
  "--pat",
  "--token",
  "--bearer",
  "--password",
  "--secret",
  "--api-key",
  "--apikey",
]);

const BEARER_EQ_FLAG = /^(--(?:pat|token|bearer|password|secret|api-key|apikey))=(.*)$/;
const BARE_PAT = /^jw3_mcp_[A-Za-z0-9_-]+$/;

export function maskBearerArgs(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    const a = out[i] as string;
    if (BEARER_FLAGS.has(a)) {
      if (i + 1 < out.length) out[i + 1] = "[REDACTED]";
      continue;
    }
    const eq = a.match(BEARER_EQ_FLAG);
    if (eq) {
      out[i] = `${eq[1]}=[REDACTED]`;
      continue;
    }
    if (BARE_PAT.test(a)) out[i] = "[REDACTED]";
  }
  return out;
}
