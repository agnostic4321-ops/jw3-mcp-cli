/**
 * Shared JSON file-store helper (C10-03): one module for every 0600 JSON
 * store in the CLI (vote.json, score.json, degen heat/learning, and the
 * monitor/alert/daemon state files in the later OQ-11 lane). Stores keep
 * their own shapes and sanitizers; this module owns only the mechanics:
 * path resolution, tolerant loads (missing/corrupt → caller defaults,
 * never throws) and best-effort saves (mkdir -p 0700, write 0600).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Store file path: explicit dir wins, otherwise the config dir. */
export function resolveStorePath(dir: string | undefined, file: string, configDir: string): string {
  return join(dir ?? configDir, file);
}

/**
 * Load a JSON store. Missing/corrupt/unreadable files and sanitizer
 * failures all fall back to caller defaults — never throws, so a bad
 * store reads as "no history", never as a crash. The sanitizer merges
 * the raw payload into the default object in place.
 */
export function loadJsonStore<T>(path: string, defaults: () => T, sanitize: (raw: unknown, into: T) => void): T {
  const dflt = defaults();
  try {
    if (!existsSync(path)) return dflt;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const into = defaults();
    sanitize(raw, into);
    return into;
  } catch {
    return dflt;
  }
}

/** Persist a store (creates the dir 0700; file 0600). Best-effort — throws on IO failure. */
export function saveJsonStore(path: string, store: unknown): void {
  const dir = path.split("/").slice(0, -1).join("/") || ".";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}
