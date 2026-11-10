/**
 * Shared CLI test fixtures (C10-12): tmpdir sandboxes, JSON file helpers,
 * and a no-network CLI runner for dispatch pins. Suites that used to roll
 * their own mkdtempSync harnesses should use these (migrated so far:
 * dispatch-pins, json-store; the giant suites follow in the later lane).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fresh tmpdir sandbox; cleanup() removes it (force, recursive). */
export function makeSandbox(prefix = "jw3-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a JSON file inside a sandbox dir; returns the full path. */
export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

/** Read and parse a JSON file. */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export type CliRun = { exit: number; stdout: string; stderr: string };

/**
 * Run the built CLI as a child process and capture exit + output.
 * NEVER on the network: callers must only use invocations that fail
 * before any network call (auth guard, pure validation) or print static
 * text (--help, unknown command). The PAT env is blanked and the config
 * home is a fresh sandbox, so no stored credential can leak in.
 */
export function runCli(args: string[], opts?: { timeoutMs?: number }): CliRun {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "index.js");
  const sandbox = makeSandbox("jw3-cli-run-");
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 15000,
      env: { ...process.env, JW3_CONFIG_HOME: sandbox.dir, JW3_MCP_PAT: "" },
    }) as string;
    return { exit: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      exit: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : String(err.stdout ?? ""),
      stderr: typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? ""),
    };
  } finally {
    sandbox.cleanup();
  }
}
