/**
 * `jw3 supervise` (`jw3d supervise`) — 24/7 CLI supervisor for trails/loops.
 *
 * Long-running `trail` / `loop` processes die (deploys, reboots, tape
 * errors); the supervisor keeps them alive: boot-time stale-order
 * reconcile (read-only, never trades), per-child restart-with-backoff,
 * periodic heartbeat file, and size-capped log rotation.
 *
 * Safety: the supervisor itself NEVER trades. Children spawn WITHOUT
 * `--yes` (dry-run) unless `--allow-live` is passed AND the manifest
 * entry sets `yes: true`. `--live` (WS feed mode) is safe and always
 * allowed — it changes the mark transport, not the money.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { maskBearerArgs } from "../config.js";
import { classifyStrays, readLocalStates } from "../reconcile.js";

/** Heartbeat cadence default (s). */
export const SUPERVISE_DEFAULT_HEARTBEAT_SEC = 15;
/** Per-child restart budget before the child is marked dead. */
export const SUPERVISE_DEFAULT_MAX_RESTARTS = 10;
/** Log rotation defaults: 5 MiB per file, 5 files kept. */
export const SUPERVISE_DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const SUPERVISE_DEFAULT_MAX_LOG_FILES = 5;
/** Restart backoff: 1s × 2^attempt, capped at 30s. */
export const SUPERVISE_BACKOFF_BASE_MS = 1000;
export const SUPERVISE_BACKOFF_CAP_MS = 30_000;

export type SupervisedTrail = {
  pair: string;
  side: "long" | "short";
  size: number;
  exchange?: string;
  activationPct?: number;
  bouncebackPct?: number;
  polls?: number;
  /** WS mark feed (safe transport, still dry-run without `yes`). */
  live?: boolean;
  /** Fire real closes. Honored ONLY with --allow-live. Default false. */
  yes?: boolean;
};

export type SupervisedLoop = {
  exchange: string;
  pair: string;
  direction?: "long" | "short";
  sizeUsd?: number;
};

export type SuperviseArgs = {
  trails: SupervisedTrail[];
  loops: SupervisedLoop[];
  heartbeatSec: number;
  maxRestarts: number;
  maxLogBytes: number;
  maxLogFiles: number;
  logDir?: string;
  stateDir?: string;
  heartbeatPath?: string;
  once: boolean;
  allowLive: boolean;
  json: boolean;
};

/* ------------------------------------------------------------------ */
/* spec parsing (pure — `--trail PAIR:SIDE:SIZE[:EXCHANGE]`,           */
/* `--loop EXCHANGE:PAIR[:DIRECTION]`).                                */
/* ------------------------------------------------------------------ */

/** Pure: parse one `--trail SOL/USDT:long:1[:kucoin]` spec. Throws. */
export function parseTrailSpec(raw: string): SupervisedTrail {
  const parts = raw.split(":").map((s) => s.trim());
  const [pair = "", sideRaw = "", sizeRaw = "", exchange = ""] = parts;
  if (!pair.includes("/")) throw new Error(`bad --trail ${JSON.stringify(raw)} — want PAIR:SIDE:SIZE (e.g. SOL/USDT:long:1)`);
  const side = sideRaw.toLowerCase();
  if (side !== "long" && side !== "short") throw new Error(`bad --trail ${JSON.stringify(raw)} — side must be long|short`);
  const size = Number(sizeRaw);
  if (!(size > 0) || !Number.isFinite(size)) throw new Error(`bad --trail ${JSON.stringify(raw)} — size must be > 0`);
  return { pair: pair.toUpperCase(), side, size, exchange: exchange ? exchange.toLowerCase() : "kucoin" };
}

/** Pure: parse one `--loop kucoin:SOL/USDT[:long|short]` spec. Throws. */
export function parseLoopSpec(raw: string): SupervisedLoop {
  const parts = raw.split(":").map((s) => s.trim());
  // Pair itself contains no colon, so EXCHANGE:PAIR is 2 parts and
  // EXCHANGE:PAIR:DIR is 3 parts.
  if (parts.length < 2) throw new Error(`bad --loop ${JSON.stringify(raw)} — want EXCHANGE:PAIR (e.g. kucoin:SOL/USDT)`);
  const [exchange = "", ...rest] = parts;
  if (!exchange) throw new Error(`bad --loop ${JSON.stringify(raw)} — exchange required`);
  let direction: "long" | "short" = "long";
  let pairParts = rest;
  const last = (rest[rest.length - 1] ?? "").toLowerCase();
  if (last === "long" || last === "short") {
    direction = last;
    pairParts = rest.slice(0, -1);
  }
  const pair = pairParts.join(":").toUpperCase();
  if (!pair.includes("/")) throw new Error(`bad --loop ${JSON.stringify(raw)} — pair must look like SOL/USDT`);
  return { exchange: exchange.toLowerCase(), pair, direction };
}

/** Pure: arg check. Null = usable. */
export function validateSuperviseArgs(a: Pick<SuperviseArgs, "trails" | "loops" | "heartbeatSec" | "maxRestarts">): string | null {
  if (a.trails.length === 0 && a.loops.length === 0) return "nothing to supervise — pass --trail … and/or --loop … (or --config manifest.json)";
  if (!Number.isFinite(a.heartbeatSec) || a.heartbeatSec < 5 || a.heartbeatSec > 300) {
    return "--heartbeat-sec must be 5..300";
  }
  if (!Number.isInteger(a.maxRestarts) || a.maxRestarts < 0 || a.maxRestarts > 100) {
    return "--max-restarts must be an integer 0..100";
  }
  for (const t of a.trails) {
    if (!t.pair.includes("/")) return `trail pair required (got ${JSON.stringify(t.pair)})`;
    if (t.side !== "long" && t.side !== "short") return "trail side must be long|short";
    if (!(t.size > 0) || !Number.isFinite(t.size)) return "trail size must be > 0";
  }
  for (const l of a.loops) {
    if (!l.exchange) return "loop exchange required";
    if (!l.pair.includes("/")) return `loop pair required (got ${JSON.stringify(l.pair)})`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* child argv (pure — the no-trades gate lives here).                  */
/* ------------------------------------------------------------------ */

/**
 * Pure: CLI argv for a trail child. `--yes` (real money) appears ONLY
 * when `allowLive` is true AND the entry opts in with `yes: true`.
 * `--live` (WS transport) is safe and always honored.
 */
export function buildTrailArgv(t: SupervisedTrail, allowLive: boolean): string[] {
  const argv = [
    "trail",
    "--pair", t.pair,
    "--side", t.side,
    "--size", String(t.size),
    "--exchange", t.exchange ?? "kucoin",
    "--activation-pct", String(t.activationPct ?? 0.25),
    "--bounceback-pct", String(t.bouncebackPct ?? 0.08),
    "--polls", String(t.polls ?? 600),
  ];
  if (t.live) argv.push("--live");
  if (allowLive && t.yes) argv.push("--yes");
  return argv;
}

/** Pure: CLI argv for a loop child (read-only sense cycle — never trades). */
export function buildLoopArgv(l: SupervisedLoop): string[] {
  const argv = ["loop", "--exchange", l.exchange, "--pair", l.pair, `--${l.direction === "short" ? "short" : "long"}`];
  if (l.sizeUsd !== undefined) argv.push("--size", String(l.sizeUsd));
  return argv;
}

/* ------------------------------------------------------------------ */
/* backoff + log rotation (pure).                                      */
/* ------------------------------------------------------------------ */

/** Pure: restart delay for the Nth restart (0-based): 1s×2^N capped 30s. */
export function backoffMs(attempt: number, baseMs: number = SUPERVISE_BACKOFF_BASE_MS, capMs: number = SUPERVISE_BACKOFF_CAP_MS): number {
  const n = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : SUPERVISE_BACKOFF_BASE_MS;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : SUPERVISE_BACKOFF_CAP_MS;
  return Math.min(cap, base * 2 ** Math.min(n, 20));
}

/** Pure: true when the active log file has reached the rotation limit. */
export function shouldRotate(sizeBytes: number, maxBytes: number): boolean {
  if (!Number.isFinite(sizeBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  return sizeBytes >= maxBytes;
}

/* ------------------------------------------------------------------ */
/* paths.                                                              */
/* ------------------------------------------------------------------ */

function configHome(): string {
  if (process.env.JW3_CONFIG_HOME) return process.env.JW3_CONFIG_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "jw3") : join(homedir(), ".config", "jw3");
}

export function defaultLogDir(): string {
  return join(configHome(), "logs");
}

export function defaultHeartbeatPath(): string {
  return join(configHome(), "supervise-heartbeat.json");
}

/* ------------------------------------------------------------------ */
/* manifest (JSON file — trails/loops the supervisor owns).            */
/* ------------------------------------------------------------------ */

export type SuperviseManifest = {
  trails?: SupervisedTrail[];
  loops?: SupervisedLoop[];
  heartbeatSec?: number;
  maxRestarts?: number;
  maxLogBytes?: number;
  maxLogFiles?: number;
};

/** Read + shape-check a manifest file. Throws with a human message. */
export function loadManifest(path: string): SuperviseManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no supervise manifest at ${path} — pass --trail/--loop flags or create one (see README)`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`supervise manifest at ${path} is not valid JSON — refusing to supervise what cannot be read`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`supervise manifest at ${path} must be an object with trails[]/loops[] — refusing to supervise it`);
  }
  return doc as SuperviseManifest;
}

/* ------------------------------------------------------------------ */
/* boot reconcile (READ-ONLY — lists local states, never cancels,      */
/* never closes, never deletes).                                       */
/* ------------------------------------------------------------------ */

export type BootReport = {
  bases: string[];
  states: { kind: string; path: string; pair: string; summary: string }[];
  unreadable: string[];
  strays: { level: "error" | "warn"; code: string; detail: string }[];
};

/** Distinct bases from supervised trails plus any state files on disk. */
export function collectBases(trails: SupervisedTrail[], stateDir?: string): string[] {
  const bases = new Set<string>();
  for (const t of trails) {
    const base = (t.pair.split("/")[0] ?? "").toUpperCase();
    if (base) bases.add(base);
  }
  const dir = stateDir ?? tmpdir();
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(?:scalp|grid|trail)_([a-z0-9]+)\.json$/i.exec(f);
      if (m?.[1]) bases.add(m[1].toUpperCase());
    }
  } catch {
    // State dir unreadable — report the configured trails only.
  }
  return [...bases].sort();
}

/**
 * Boot-time stale-order reconcile: local states × venue-unchecked
 * (no PAT read at boot — the supervisor must start offline-safe).
 * Read-only: classifies, never cancels/closes/deletes.
 */
export function bootReconcile(trails: SupervisedTrail[], stateDir?: string): BootReport {
  const dir = stateDir ?? tmpdir();
  const bases = collectBases(trails, dir);
  const states: BootReport["states"] = [];
  const unreadable: string[] = [];
  const strays: BootReport["strays"] = [];
  for (const base of bases) {
    const pair = `${base}/USDT`;
    const { states: rows, unreadable: bad } = readLocalStates(base, dir);
    for (const r of rows) states.push({ kind: r.kind, path: r.path, pair: r.pair || pair, summary: r.summary });
    unreadable.push(...bad);
    // Venue unchecked at boot (offline-safe start): local states are
    // listed and stale/unreadable rows surface as warns/errors.
    // Pair-scoped strays use the owning pair when known.
    const scopePair = rows[0]?.pair || pair;
    for (const s of classifyStrays({ pair: scopePair, local: rows, unreadable: bad, positions: null, orders: null })) {
      if (s.code !== "venue-unchecked" || rows.length > 0 || bad.length > 0) {
        strays.push(s);
      }
    }
  }
  return { bases, states, unreadable, strays };
}

/* ------------------------------------------------------------------ */
/* heartbeat + logging.                                                */
/* ------------------------------------------------------------------ */

export type ChildHeartbeat = {
  name: string;
  kind: "trail" | "loop";
  pid: number | null;
  alive: boolean;
  restarts: number;
  lastExitCode: number | null;
  lastExitAt: string | null;
};

/** Pure: heartbeat file payload. */
export function heartbeatPayload(args: {
  pid: number;
  startedAt: string;
  at: string;
  uptimeSec: number;
  children: ChildHeartbeat[];
  boot: Pick<BootReport, "states" | "unreadable">;
  dryRun: boolean;
}): Record<string, unknown> {
  return {
    event: "supervise-heartbeat",
    pid: args.pid,
    startedAt: args.startedAt,
    at: args.at,
    uptimeSec: Math.max(0, Math.round(args.uptimeSec)),
    dryRun: args.dryRun,
    children: args.children,
    localStates: args.boot.states.length,
    unreadableStates: args.boot.unreadable.length,
  };
}

/** Rotate `logFile` when it reaches `maxBytes` (keeps `maxFiles`). */
export function rotateLogsIfNeeded(logFile: string, maxBytes: number, maxFiles: number): string | null {
  let size = 0;
  try {
    size = statSync(logFile).size;
  } catch {
    return null; // no file yet — nothing to rotate
  }
  if (!shouldRotate(size, maxBytes)) return null;
  const keep = Number.isInteger(maxFiles) && maxFiles >= 1 ? maxFiles : SUPERVISE_DEFAULT_MAX_LOG_FILES;
  // Drop the oldest, shift the rest up, active file becomes .1.
  try {
    rmSync(`${logFile}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (existsSync(src)) renameSync(src, `${logFile}.${i + 1}`);
    }
    renameSync(logFile, `${logFile}.1`);
    return `${logFile}.1`;
  } catch {
    return null;
  }
}

export function appendLog(logFile: string, line: string, maxBytes: number, maxFiles: number): void {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch {
    // best-effort; the write below still tries
  }
  rotateLogsIfNeeded(logFile, maxBytes, maxFiles);
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging never stops supervision.
  }
}

/* ------------------------------------------------------------------ */
/* --once report (used by the daemon boot AND by tests).               */
/* ------------------------------------------------------------------ */

export type SuperviseOnceReport = {
  boot: BootReport;
  children: { name: string; kind: "trail" | "loop"; argv: string[] }[];
  heartbeat: Record<string, unknown>;
  dryRun: boolean;
  errors: number;
};

/**
 * One supervised-health pass with no processes spawned: boot reconcile
 * + child-spec build + heartbeat payload. `--once` prints this and exits;
 * the daemon runs it first, then spawns.
 */
export function runSuperviseOnce(a: SuperviseArgs, nowMs: number = Date.now()): SuperviseOnceReport {
  const boot = bootReconcile(a.trails, a.stateDir);
  const children: SuperviseOnceReport["children"] = [
    ...a.trails.map((t) => ({
      name: `trail:${t.pair}:${t.side}`,
      kind: "trail" as const,
      argv: buildTrailArgv(t, a.allowLive),
    })),
    ...a.loops.map((l) => ({
      name: `loop:${l.exchange}:${l.pair}`,
      kind: "loop" as const,
      argv: buildLoopArgv(l),
    })),
  ];
  const dryRun = !a.allowLive || !a.trails.some((t) => t.yes);
  const at = new Date(nowMs).toISOString();
  const heartbeat = heartbeatPayload({
    pid: process.pid,
    startedAt: at,
    at,
    uptimeSec: 0,
    children: children.map((c) => ({
      name: c.name, kind: c.kind, pid: null, alive: false, restarts: 0, lastExitCode: null, lastExitAt: null,
    })),
    boot,
    dryRun,
  });
  const errors = boot.strays.filter((s) => s.level === "error").length;
  return { boot, children, heartbeat, dryRun, errors };
}

/* ------------------------------------------------------------------ */
/* daemon.                                                             */
/* ------------------------------------------------------------------ */

type LiveChild = {
  name: string;
  kind: "trail" | "loop";
  argv: string[];
  proc: ChildProcess | null;
  pid: number | null;
  alive: boolean;
  restarts: number;
  lastExitCode: number | null;
  lastExitAt: string | null;
};

function entryPoint(): string {
  // Children are the same CLI: `node <this-file> trail …`.
  return process.argv[1] ?? join("packages", "jw3-cli", "dist", "index.js");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `jw3 supervise` — boot reconcile, then supervise every trail/loop as a
 * restarted child with heartbeat + rotated logs. Never trades itself;
 * children trade only when `--allow-live` + manifest `yes: true`.
 */
export async function cmdSupervise(a: SuperviseArgs): Promise<void> {
  const err = validateSuperviseArgs(a);
  if (err) {
    console.error(`Usage: jw3 supervise --trail SOL/USDT:long:1 [--loop kucoin:SOL/USDT] [--once] — ${err}. Nothing was started.`);
    process.exitCode = 2;
    return;
  }
  const logDir = a.logDir ?? defaultLogDir();
  const hbPath = a.heartbeatPath ?? defaultHeartbeatPath();
  const logFile = join(logDir, "supervise.log");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // ── Boot: stale-order reconcile (read-only) ──
  const once = runSuperviseOnce(a);
  const stamp = (): string => new Date().toISOString();
  const log = (msg: string): void => {
    const line = `${stamp()} ${msg}`;
    if (!a.json) console.log(line);
    appendLog(logFile, line, a.maxLogBytes, a.maxLogFiles);
  };
  if (a.json) console.log(JSON.stringify({ event: "supervise-boot", ...once.heartbeat, boot: once.boot }));
  else {
    log(`SUPERVISE boot — ${once.children.length} child(ren), ${once.boot.states.length} local state(s), ${once.boot.unreadable.length} unreadable${once.dryRun ? " (dry-run: children spawn WITHOUT --yes)" : " (LIVE: manifest yes:true honored)"}`);
    for (const s of once.boot.states) log(`  local ${s.kind}: ${s.summary}`);
    for (const u of once.boot.unreadable) log(`  ERROR [unreadable-state] ${u}`);
    for (const s of once.boot.strays) {
      if (s.code === "venue-unchecked" && once.boot.states.length === 0) continue;
      log(`  ${s.level.toUpperCase()} [${s.code}] ${s.detail}`);
    }
    for (const c of once.children) log(`  child ${c.name}: node ${c.argv.join(" ")}`);
  }

  const writeHeartbeat = (kids: LiveChild[]): void => {
    const payload = heartbeatPayload({
      pid: process.pid,
      startedAt,
      at: new Date().toISOString(),
      uptimeSec: (Date.now() - t0) / 1000,
      children: kids.map((k) => ({
        name: k.name, kind: k.kind, pid: k.pid, alive: k.alive,
        restarts: k.restarts, lastExitCode: k.lastExitCode, lastExitAt: k.lastExitAt,
      })),
      boot: once.boot,
      dryRun: once.dryRun,
    });
    try {
      mkdirSync(dirname(hbPath), { recursive: true, mode: 0o700 });
      writeFileSync(hbPath, JSON.stringify(payload, null, 2));
    } catch {
      // Heartbeat is best-effort; the loop keeps supervising.
    }
  };

  if (a.once) {
    try {
      mkdirSync(dirname(hbPath), { recursive: true, mode: 0o700 });
      writeFileSync(hbPath, JSON.stringify(once.heartbeat, null, 2));
    } catch {
      // best-effort
    }
    if (!a.json) log(`ONCE — heartbeat → ${hbPath}. No processes spawned.`);
    if (once.errors > 0) process.exitCode = 1;
    return;
  }

  // ── Daemon: spawn + restart-with-backoff + heartbeat ──
  const kids: LiveChild[] = once.children.map((c) => ({
    ...c, proc: null, pid: null, alive: false, restarts: 0, lastExitCode: null, lastExitAt: null,
  }));
  let stopping = false;
  const onSignal = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log(`SUPERVISE ${sig} — stopping ${kids.length} child(ren), heartbeat stays for the watchdog`);
    for (const k of kids) {
      try {
        k.proc?.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  };
  process.once("SIGINT", () => void onSignal("SIGINT"));
  process.once("SIGTERM", () => void onSignal("SIGTERM"));

  const spawnChild = (k: LiveChild): void => {
    if (stopping) return;
    if (k.restarts > a.maxRestarts) {
      log(`DEAD ${k.name} — restart budget exhausted (${a.maxRestarts}). Leaving it stopped; fix + restart supervise.`);
      return;
    }
    const delay = k.restarts === 0 ? 0 : backoffMs(k.restarts - 1);
    const go = (): void => {
      if (stopping) return;
      log(`START ${k.name} (attempt ${k.restarts + 1}) — node ${maskBearerArgs(k.argv).join(" ")}`);
      let proc: ChildProcess;
      try {
        proc = spawn(process.execPath, [entryPoint(), ...k.argv], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        log(`SPAWN-FAIL ${k.name}: ${e instanceof Error ? e.message : String(e)}`);
        k.restarts++;
        if (!stopping && k.restarts <= a.maxRestarts) setTimeout(() => spawnChild(k), backoffMs(k.restarts - 1));
        return;
      }
      k.proc = proc;
      k.pid = proc.pid ?? null;
      k.alive = true;
      proc.stdout?.on("data", (d: Buffer) => {
        for (const line of String(d).split("\n")) {
          if (line.trim()) appendLog(logFile, `${stamp()} [${k.name}] ${line}`, a.maxLogBytes, a.maxLogFiles);
        }
      });
      proc.stderr?.on("data", (d: Buffer) => {
        for (const line of String(d).split("\n")) {
          if (line.trim()) appendLog(logFile, `${stamp()} [${k.name}:err] ${line}`, a.maxLogBytes, a.maxLogFiles);
        }
      });
      proc.on("exit", (code) => {
        k.alive = false;
        k.pid = null;
        k.proc = null;
        k.lastExitCode = code ?? 1;
        k.lastExitAt = new Date().toISOString();
        if (stopping) {
          log(`STOP ${k.name} exit=${k.lastExitCode}`);
          return;
        }
        k.restarts++;
        if (k.restarts > a.maxRestarts) {
          log(`DEAD ${k.name} exit=${k.lastExitCode} — restart budget exhausted (${a.maxRestarts}). Leaving it stopped.`);
          return;
        }
        log(`RESTART ${k.name} exit=${k.lastExitCode} in ${backoffMs(k.restarts - 1)}ms (restart ${k.restarts}/${a.maxRestarts})`);
        setTimeout(() => spawnChild(k), backoffMs(k.restarts - 1));
      });
    };
    if (delay > 0) setTimeout(go, delay);
    else go();
  };

  for (const k of kids) spawnChild(k);

  // Heartbeat loop — the watchdog's liveness source.
  while (!stopping) {
    writeHeartbeat(kids);
    await sleep(Math.max(5, a.heartbeatSec) * 1000);
  }
  writeHeartbeat(kids);
  log("SUPERVISE stopped.");
}
