/**
 * Shared JSON file-store helper (C10-03): one module for every 0600 JSON
 * store in the CLI (vote.json, score.json, degen heat/learning, and the
 * monitor/alert/daemon state files in the later OQ-11 lane). Stores keep
 * their own shapes and sanitizers; this module owns only the mechanics:
 * path resolution, tolerant loads (missing/corrupt → caller defaults,
 * never throws) and best-effort saves (mkdir -p 0700, write 0600).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * Load a JSON store, returning null when the file is missing, unreadable
 * or corrupt (never throws). The sanitizer validates the raw payload and
 * returns the store, or null to reject it. For stores whose callers
 * distinguish "no state" (null) from "empty state" — the daemon state and
 * owner lock: a missing/corrupt state file means "unattributed, verify
 * against the venue", which the tolerant default-fallback would erase.
 */
export function loadJsonStoreNullable<T>(path: string, sanitize: (raw: unknown) => T | null): T | null {
  try {
    if (!existsSync(path)) return null;
    return sanitize(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * Persist a store atomically (tmp file + rename; dir 0700, file 0600).
 * For the daemon state and owner lock: a crash between write and rename
 * leaves the previous state intact instead of a half-written file the
 * boot reconcile would read as "no attribution".
 */
export function saveJsonStoreAtomic(path: string, store: unknown): void {
  const dir = path.split("/").slice(0, -1).join("/") || ".";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
