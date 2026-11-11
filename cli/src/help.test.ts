/**
 * Help is a read-only surface (W8-L11h). A help request must print usage and
 * stop BEFORE any command code runs: no MCP/tool call, no venue call, no file
 * write, no state migration. This file pins that contract for the WHOLE
 * registry, not one command at a time:
 *
 *  - the matrix below walks every registered command and subcommand, in both
 *    `--help` and `-h` forms, as a real child process, with a preload that
 *    fails (and records) any fetch/http/https/WebSocket call, the shared
 *    test network guard, an empty PAT and a throwaway JW3_CONFIG_HOME;
 *  - top-level help must equal the registry rendering exactly (nothing
 *    retired, nothing extra);
 *  - every help path must be matched by a dispatch route, and every route
 *    must own at least one help path (a retired command cannot be advertised,
 *    a new route cannot ship without help).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { COMMANDS, helpFor, renderHelp } from "./help.js";
import { CLI_VERSION, ROUTES } from "./index.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "index.js");
const guardPreload = pathToFileURL(join(here, "test-env.js")).href;

/**
 * Preload that turns ANY outbound call into a recorded failure. It is loaded
 * after the shared network guard, so it sees the call first: a help request
 * that reached for fetch, node:http(s) or a WebSocket fails here and leaves a
 * line in the call log instead of touching the network.
 */
const CALL_STUB = `
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
const log = process.env.JW3_TEST_CALL_LOG;
const record = (kind, what) => {
  if (log) appendFileSync(log, kind + " " + String(what) + "\\n");
};
const refuse = (kind, what) => {
  record(kind, what);
  throw new Error("JW3_TEST_FORBIDDEN_CALL: " + kind);
};
globalThis.fetch = async (input) =>
  refuse("fetch", typeof input === "string" ? input : (input && input.url) || String(input));
for (const mod of [http, https]) {
  mod.request = (...args) => refuse("http.request", args[0]);
  mod.get = (...args) => refuse("http.get", args[0]);
}
globalThis.WebSocket = class {
  constructor(url) {
    refuse("websocket", url);
  }
};
`;

const stubDir = mkdtempSync(join(tmpdir(), "jw3-help-stub-"));
const stubPath = join(stubDir, "forbid-calls.mjs");
writeFileSync(stubPath, CALL_STUB);
const stubPreload = pathToFileURL(stubPath).href;
process.on("exit", () => rmSync(stubDir, { recursive: true, force: true }));

type HelpRun = { exit: number; stdout: string; stderr: string; calls: string[]; files: string[] };

/** Every entry under dir, relative; a directory is listed as "name/". */
function listTree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...listTree(join(dir, ent.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** Run the built CLI with a throwaway config dir and the call stub loaded. */
async function runHelp(args: string[]): Promise<HelpRun> {
  const root = mkdtempSync(join(tmpdir(), "jw3-help-run-"));
  const configDir = join(root, "config");
  const callLog = join(root, "calls.log");
  mkdirSync(configDir);
  writeFileSync(callLog, "");
  const env: NodeJS.ProcessEnv = { ...process.env, JW3_CONFIG_HOME: configDir, JW3_MCP_PAT: "", JW3_TEST_CALL_LOG: callLog };
  // No production/runtime JW3_* knobs (PAT, URL, golden recording) may leak in.
  for (const key of Object.keys(env)) {
    if (key.startsWith("JW3_") && !["JW3_CONFIG_HOME", "JW3_MCP_PAT", "JW3_TEST_CALL_LOG"].includes(key)) delete env[key];
  }
  try {
    let exit = 0;
    let stdout = "";
    let stderr = "";
    try {
      const done = await execFileAsync(process.execPath, ["--import", guardPreload, "--import", stubPreload, bin, ...args], {
        encoding: "utf8",
        timeout: 20000,
        env,
      });
      stdout = done.stdout;
      stderr = done.stderr;
    } catch (e) {
      const err = e as { code?: unknown; stdout?: string; stderr?: string };
      exit = typeof err.code === "number" ? err.code : 1;
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
    }
    const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
    return { exit, stdout, stderr, calls, files: listTree(configDir) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every argv path in the registry, split into tokens. */
const registryPaths: string[][] = COMMANDS.flatMap((entry) => entry.paths.map((p) => p.split(" ")));

/** Command words (first token of any path), in registry order, deduped. */
const commandWords: string[] = [...new Set(registryPaths.map((parts) => parts[0] as string))];

/** The subcommand words registered under one command word. */
function subsOf(cmd: string): string[] {
  return [
    ...new Set(
      registryPaths.filter((parts) => parts[0] === cmd && parts.length > 1).map((parts) => parts[1] as string),
    ),
  ];
}

/** One case per help invocation: every command and sub, both help spellings. */
function helpCases(): { label: string; args: string[] }[] {
  const cases: { label: string; args: string[] }[] = [];
  for (const cmd of commandWords) {
    for (const form of ["--help", "-h"]) cases.push({ label: `jw3 ${cmd} ${form}`, args: [cmd, form] });
    for (const sub of subsOf(cmd)) {
      for (const form of ["--help", "-h"]) cases.push({ label: `jw3 ${cmd} ${sub} ${form}`, args: [cmd, sub, form] });
    }
  }
  for (const parts of registryPaths) {
    if (parts.length > 2) cases.push({ label: `jw3 ${parts.join(" ")} --help`, args: [...parts, "--help"] });
  }
  return cases;
}

describe("help runs no command code (registry-wide)", { concurrency: 8 }, () => {
  for (const { label, args } of helpCases()) {
    it(label, async () => {
      const r = await runHelp(args);
      assert.equal(r.exit, 0, `${label}: want exit 0, got ${r.exit}; stderr: ${r.stderr}`);
      assert.deepEqual(r.calls, [], `${label}: a help request must not call out`);
      assert.deepEqual(r.files, [], `${label}: a help request must not write in the config dir`);
      assert.equal(r.stderr, "", `${label}: a help request must not print diagnostics`);
      const tokens = args.filter((a) => !a.startsWith("-"));
      const expected = helpFor(tokens);
      assert.ok(expected, `${label}: the registry has no usage for this path`);
      assert.equal(r.stdout, `${expected}\n`, `${label}: must print exactly that command's usage`);
    });
  }
});

describe("top-level help is the command registry", () => {
  it("--help prints the registry rendering and nothing else", async () => {
    const r = await runHelp(["--help"]);
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, `${renderHelp(CLI_VERSION)}\n`);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.files, []);
  });

  it("lists every registered command word exactly once", async () => {
    const r = await runHelp(["--help"]);
    const printed = r.stdout
      .split("\n")
      .filter((line) => /^ {2}jw3 /.test(line))
      .map((line) => (line.trim().split(/\s+/)[1] as string));
    const registered = [...new Set(COMMANDS.flatMap((e) => e.usage).map((line) => line.split(" ")[1] as string))];
    assert.deepEqual([...new Set(printed)].sort(), registered.sort());
    assert.equal(printed.length, COMMANDS.flatMap((e) => e.usage).length, "one printed line per registered usage line");
  });

  it("advertises nothing retired", async () => {
    const r = await runHelp(["--help"]);
    for (const retired of ["harness", "vote", "oracle", "committee", "score", "supervise"]) {
      assert.ok(!new RegExp(`^ {2}jw3 ${retired}( |$)`, "m").test(r.stdout), `help must not advertise ${retired}`);
    }
  });
});

describe("help registry matches the dispatch table", () => {
  it("every advertised path is routed", () => {
    for (const parts of registryPaths) {
      const idx = ROUTES.findIndex((route) => route.match(parts[0] as string, parts[1]));
      assert.ok(idx >= 0, `help advertises "${parts.join(" ")}" but no route matches it`);
    }
  });

  it("every route owns at least one help path", () => {
    ROUTES.forEach((route, i) => {
      const owned = registryPaths.some(
        (parts) => ROUTES.findIndex((r) => r.match(parts[0] as string, parts[1])) === i,
      );
      assert.ok(owned, `route #${i} has no help path (a command shipped without usage text)`);
    });
  });
});

describe("help wins over a full ticket (the defect this lane fixes)", () => {
  it("`daily-prep --help` prints usage and writes nothing", async () => {
    const r = await runHelp(["daily-prep", "--help"]);
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /^jw3 daily-prep /m);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.files, []);
  });

  it("`execute … --yes --help` prints usage and calls nothing", async () => {
    const r = await runHelp([
      "execute",
      "--exchange",
      "kucoin",
      "--pair",
      "BTC/USDT",
      "--side",
      "buy",
      "--amount",
      "1",
      "--yes",
      "--help",
    ]);
    assert.equal(r.exit, 0);
    assert.match(r.stdout, /^jw3 execute /m);
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.files, []);
  });

  it("an unregistered command with --help is still unknown (exit 2, no usage)", async () => {
    for (const retired of ["harness", "vote", "oracle", "committee", "score"]) {
      const r = await runHelp([retired, "--help"]);
      assert.equal(r.exit, 2, `jw3 ${retired} --help`);
      assert.match(r.stderr, new RegExp(`Unknown command: ${retired}`));
      assert.ok(!r.stdout.includes(`jw3 ${retired} `), `must not invent usage for ${retired}`);
      assert.deepEqual(r.calls, []);
    }
  });
});
