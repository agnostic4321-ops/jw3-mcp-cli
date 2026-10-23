#!/usr/bin/env node
/**
 * THE WATCH-PATTERN KEEPER.
 *
 * WHY THIS EXISTS
 * ---------------
 * A watch pattern is what turns a long-running process's output into
 * an alert. Two things break that on this machine:
 *
 * 1. A DEAD PROCESS'S BUFFERED OUTPUT IS RE-DELIVERED. The stdout of a
 *    long-running process is persisted to a buffer file, and when the
 *    process dies the buffer SURVIVES. A pattern on a bare event NAME
 *    can then match a line the process wrote hours earlier. Observed:
 *    the same "FIRED" line — an AVAX short that opened and scratched
 *    three hours before — delivered at 18:19 and again at 21:05.
 *
 * 2. THE REGISTRY IS A SHARED FILE, AND EVERY SESSION REWRITES IT.
 *    `~/.hermes/processes.json` is written wholesale by every Hermes
 *    session on the machine, each with its own view of the world. A
 *    pattern set by one session is dropped by the next session's
 *    write. There are 26 Hermes processes running here, so the
 *    patterns were being wiped within minutes of being set.
 *
 * So the patterns are set, and then they are set AGAIN, on a timer.
 * The keeper:
 *
 *   - reads the current run id of each supervised process from its OWN
 *     run file, so the pattern it writes is always the CURRENT run's
 *     and can never match a dead run's buffered line
 *   - writes the patterns into the registry
 *   - re-applies them whenever they drift, and reports the drift
 *   - keeps a small history so a repeated wipe is visible
 *
 * WHY THE PATTERNS ARE RUN-SCOPED
 * -------------------------------
 * A run-scoped pattern is the only pattern that cannot match a stale
 * line: the run id is the FIRST field of every event, and a dead
 * run's lines carry a DIFFERENT id (or none at all — the events
 * written before the run id existed have no `run` field and so cannot
 * match any run-scoped pattern).
 *
 * Run: node research/watch-keep.mjs --once
 *       node research/watch-keep.mjs            (the loop)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const SCRATCH = join(HOME, ".hermes/cache/scratch");
const REGISTRY = join(HOME, ".hermes/processes.json");
const BUFFERS = join(HOME, ".hermes/cache/terminal-output");
const HISTORY = join(SCRATCH, "watch-keep.history.ndjson");
const INTERVAL = Number(flag("interval", 60)) * 1000;
const ONCE = process.argv.includes("--once");

function flag(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
}

/**
 * What must be watched, and how each pattern is built.
 *
 * A process is identified by the COMMAND it runs, not by its session
 * id — because the session id changes on every restart, while the
 * command does not. The run id comes from the process's OWN run file,
 * so it is always the current run's.
 */
const SUPERVISED = [
  {
    name: "the trade-loop",
    match: (cmd) => cmd.includes("research/trade-loop.mjs"),
    runFile: join(SCRATCH, "trade-loop.run.json"),
    // The loop's own event names. Run-scoped, so a dead run's line
    // can never match.
    // `cycle-error` is the loop's OWN failure event, and it was NOT
    // watched: a cycle that died was silent, while a bare pattern on
    // the event NAME matched a DEAD run's buffered line two hours
    // later. So the pattern is run-scoped like the rest, and the event
    // is watched at all.
    // `daily-budget-spent` is the loop's LOCAL refusal when the day's
    // notional budget is gone. It is NOT a fault — it is the machine
    // deciding it will not spend a live call to learn what it already
    // knows — so it is watched as a STATE, not as an error. The
    // operator wants to know the day is over for trading.
    // `reconcile-skipped` is a NOTE, not a fault: a failed reconcile
    // can only make the loop refuse EARLIER (it reads the server's
    // own counter), never fire more. It is watched so the operator can
    // see that the release path is degraded, not so they panic.
    events: ["FIRED", "failed-venue-unreadable", "failed-but-venue-checked", "entry-throttled", "cycle-error", "daily-budget-spent", "reconcile-skipped"],
  },
  {
    name: "the funding/OI collector",
    match: (cmd) => cmd.includes("research/collect-funding-oi.mjs"),
    runFile: null,
    // The collector's FATAL state. Its pacing backoff is normal
    // operation and must never be an alarm.
    //
    // A BARE pattern is safe HERE, and only here: the collector writes
    // to a LIVE stdout stream that the desktop buffers per process,
    // so its history ends when the process dies. The loop writes to a
    // NEVER-TRUNCATED audit log, so a bare pattern on the loop would
    // match all of history forever. `bareOk` records that difference
    // per spec rather than pretending one rule fits both.
    //
    // `FAILED` is also the RESERVED fault word: it never appears in a
    // healthy collector line (that is what
    // test-no-fault-word-in-healthy-lines.mjs enforces), so it cannot
    // fire on normal operation.
    bareOk: true,
    events: ["FAILED"],
  },
  {
    name: "the confluence collector",
    match: (cmd) => cmd.includes("research/collect-confluence.mjs"),
    runFile: null,
    bareOk: true,
    events: ["FAILED"],
  },
];

/** The run id of a process, from its run file. */
function runIdOf(spec) {
  if (!spec.runFile) return null;
  if (!existsSync(spec.runFile)) return null;
  try {
    const r = JSON.parse(readFileSync(spec.runFile, "utf8"));
    return r?.runId ?? null;
  } catch {
    return null;
  }
}

/**
 * The patterns a spec's process should have.
 *
 * A BARE EVENT NAME IS NEVER INSTALLED. The audit log is never
 * truncated — it is the trade history — so a bare pattern matches
 * EVERY historical line with that event name, and a dead run's line
 * fires an alert hours later. Observed: a session started with a bare
 * notify list (["FIRED", "cycle-error", "failed-but-venue-checked",
 * ...]) kept its subscription after it exited, and delivered an
 * 8-hour-old daily-notional refusal for a DOT/USDT trade that never
 * happened in that run.
 *
 * So when the run id cannot be resolved, the keeper installs NOTHING
 * and says so. An unwatched process is SAFE; a wrongly-watched one
 * replays history as if it were news. The run id comes from the
 * process's OWN run file, which the loop writes at startup — so the
 * only way to miss it is a race or a cleared scratch dir, and both are
 * better handled by watching nothing for a cycle than by watching
 * everything forever.
 */
function wantedPatterns(spec) {
  const runId = runIdOf(spec);
  if (runId) {
    // RUN-SCOPED, TWICE OVER.
    //
    // The pattern carries the run id in BOTH places it can appear: the
    // `run` field (which every line has) AND the event name (which
    // the loop's STDOUT prefixes with the run id). So the pattern
    // cannot match an AUDIT-LOG line (whose event name is plain) nor
    // another run's stdout (whose event name carries a different id).
    //
    // The stdout form is what makes the pattern safe: the desktop
    // captures stdout into the session's rolling tail and the watch
    // matcher re-scans that tail every 5 seconds, so a BARE event name
    // in the tail matches every historical line of that event and
    // re-fires forever. Nine distinct injections of one 9-hour-old
    // refusal were observed for two dead sessions.
    //
    // So the pattern targets the run-scoped EVENT NAME, which appears
    // in no other run's stdout and in no audit-log line.
    return spec.events.map((e) => `"event":"${runId}:${e}"`);
  }
  // No run id. A bare pattern is permitted ONLY for a spec whose
  // output is a LIVE stdout stream (bounded by the process's
  // lifetime) and whose event words are RESERVED fault words that
  // never appear in healthy output.
  if (spec.bareOk) return spec.events;
  return null;
}

function log(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj });
  console.log(line);
  try {
    mkdirSync(SCRATCH, { recursive: true });
    appendFileSync(HISTORY, `${line}\n`);
  } catch {
    // The history is a nicety, never a hard requirement.
  }
}

function readRegistry() {
  if (!existsSync(REGISTRY)) return [];
  try {
    const d = JSON.parse(readFileSync(REGISTRY, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

function writeRegistry(list) {
  writeFileSync(REGISTRY, JSON.stringify(list, null, 1));
}

/**
 * Is a registry entry's process still alive?
 *
 * `kill -0 pid` signals nothing and succeeds for a live process, so it
 * is the right liveness probe. The pid can be REUSED after a process
 * dies, so the probe is strengthened by the entry's recorded start
 * time when it has one: if the pid now belongs to a process that
 * started LATER than the entry recorded, the entry is stale.
 */
function isAlive(entry) {
  const pid = Number(entry?.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM means the process exists but is owned by another user --
    // still alive. ESRCH means it is gone.
    return e?.code === "EPERM";
  }
  return true;
}

/** One pass. Returns how many processes it repaired. */
function sweep() {
  const registry = readRegistry();
  let repaired = 0;
  const seen = new Set();

  // A DEAD SESSION'S WATCH MUST BE CLEARED.
  //
  // The keeper repairs the patterns of the sessions it finds and
  // reports a supervised process that is ABSENT, but a session that has
  // EXITED keeps whatever patterns it had -- and the desktop keeps
  // matching that subscription against the audit log, which is never
  // truncated. Observed: a session started with a bare notify list
  // kept matching an 8-hour-old refusal line after it exited, and the
  // delivery was re-queued to the operator's chat.
  //
  // A watch on a process that no longer exists has nothing to watch,
  // so it is cleared. This is a WRITE to the shared registry, so it is
  // recorded in the history like every other repair.
  for (const entry of registry) {
    if (!entry || typeof entry !== "object") continue;
    if (!Array.isArray(entry.watch_patterns) || entry.watch_patterns.length === 0) continue;
    if (isAlive(entry)) continue;
    const before = entry.watch_patterns;
    entry.watch_patterns = [];
    repaired++;
    log({
      event: "watch-cleared",
      session: entry.session_id,
      before,
      after: [],
      reason: "the process has exited, so its watch has nothing to watch",
    });
  }

  for (const spec of SUPERVISED) {
    const wanted = wantedPatterns(spec);
    if (!wanted) {
      // No run id -> no safe pattern. Record it and watch nothing.
      log({
        event: "watch-unscoped",
        process: spec.name,
        note: "the run id could not be resolved, so NO watch was installed — a bare event name would match every historical line in the never-truncated audit log",
      });
      continue;
    }
    // The process is matched by its COMMAND, so a restart that changes
    // the session id does not lose the watch.
    for (const entry of registry) {
      if (!entry || typeof entry !== "object") continue;
      const cmd = String(entry.command ?? "");
      if (!spec.match(cmd)) continue;
      // A DEAD SESSION IS NOT REPAIRED. Its watch was just cleared,
      // and re-adding the patterns would resurrect the very
      // subscription the clear exists to remove — which is exactly how
      // the same dead session kept matching an 8-hour-old line three
      // times. A process that has exited has nothing to watch.
      if (!isAlive(entry)) continue;
      seen.add(spec.name);
      // THE COMPARISON IS ON THE PATTERNS THEMSELVES, not on the
      // event names they mention. Comparing the NAMES treated a bare
      // ["FAILED"] and a run-scoped ["\"run\":\"x\",\"event\":\"FAILED\""]
      // as identical, so the keeper could not tell a correctly-scoped
      // pattern from an unsafe bare one — and it rewrote the shared
      // registry on every sweep, fighting the sessions that own it.
      const current = entry.watch_patterns ?? [];
      const same =
        current.length === wanted.length &&
        current.every((p, i) => p === wanted[i]);
      if (!same) {
        const before = entry.watch_patterns ?? [];
        entry.watch_patterns = wanted;
        repaired++;
        log({
          event: "watch-repaired",
          process: spec.name,
          session: entry.session_id,
          before,
          after: wanted,
          reason: runIdOf(spec) ? "the patterns drifted (a session rewrote the registry)" : "the patterns drifted",
        });
      }
    }
  }

  // A DEAD SESSION'S STDOUT BUFFER MUST BE REMOVED.
  //
  // The desktop persists a long-running process's stdout to a buffer
  // file named `out-<started_at seconds>-<writer pid>-<suffix>.log`,
  // and it does NOT remove that file when the process dies. The buffer
  // therefore survives forever, and the watch matcher scans it — so a
  // bare event name keeps matching a dead run's line, hours after it
  // was written.
  //
  // Observed: a session that fired an AVAX short at 13:05Z had its
  // "FIRED" line delivered at 01:06 and again at 02:25 the next day,
  // from a buffer file last written at 17:23 the day before. The same
  // buffer held the only matchable FIRED line in the whole directory.
  //
  // The buffer's name carries the session's start time, which the
  // registry also carries, so a dead session's buffer is identifiable.
  // Only a buffer whose start time belongs to a registry entry that is
  // DEAD is removed — a buffer no registry entry claims is left alone,
  // because the mapping is not certain enough to delete on a guess.
  {
    // The start times of every session the registry still lists, and
    // the newest of them.
    const known = new Set();
    let newest = 0;
    for (const entry of registry) {
      if (!entry || typeof entry !== "object") continue;
      const st = Math.floor(Number(entry.started_at ?? 0));
      if (st > 0) {
        known.add(st);
        if (st > newest) newest = st;
      }
    }
    // A buffer is DEAD OUTPUT when its session's start time is claimed
    // by no registry entry — the session is gone — AND it is at least
    // the MARGIN older than the newest session the registry does list.
    //
    // The margin is what makes this safe: a session that has just
    // started may not be in the registry yet, so a buffer younger than
    // the newest known session is left alone. Only a buffer that is
    // unambiguously older than every live session, and claimed by
    // none of them, is removed.
    //
    // The file's MTIME cannot decide this: a live process's buffer is
    // not necessarily being written at the instant the keeper sweeps
    // (a quiet collector writes nothing for minutes), so an mtime rule
    // would delete a live buffer.
    const MARGIN_S = 300;
    if (existsSync(BUFFERS)) {
      for (const name of readdirSync(BUFFERS)) {
        const m = /^out-(\d+)-/.exec(name);
        if (!m) continue;
        const start = Number(m[1]);
        if (known.has(start)) continue;      // a session the registry lists
        if (start >= newest - MARGIN_S) continue;  // too young to be sure
        const path = join(BUFFERS, name);
        try {
          const size = statSync(path).size;
          unlinkSync(path);
          repaired++;
          log({
            event: "buffer-removed",
            file: name,
            bytes: size,
            startSeconds: start,
            reason: "no live session claims this buffer, so it is dead output that a bare watch pattern would keep matching",
          });
        } catch (e) {
          log({ event: "buffer-remove-failed", file: name, error: String(e?.message ?? e).slice(0, 120) });
        }
      }
    }
  }

  // Anything supervised but NOT in the registry is a process that has
  // exited; its watch is gone with it, which is correct.
  for (const spec of SUPERVISED) {
    if (!seen.has(spec.name)) {
      const runId = runIdOf(spec);
      if (runId) {
        log({
          event: "watch-absent",
          process: spec.name,
          runId,
          note: "the process is not in the registry — it has exited, so its watch went with it",
        });
      }
    }
  }

  if (repaired) {
    writeRegistry(registry);
  }
  return repaired;
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE WATCH-PATTERN KEEPER");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`the registry:  ${REGISTRY}`);
console.log(`the interval:  ${INTERVAL / 1000}s`);
console.log("");

if (ONCE) {
  const n = sweep();
  console.log(n ? `repaired ${n} process(es)` : "every pattern was already correct");
  process.exit(0);
}

log({ event: "watch-keeper-start", intervalMs: INTERVAL });
for (;;) {
  try {
    sweep();
  } catch (e) {
    log({ event: "watch-keeper-error", error: String(e?.message ?? e) });
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
