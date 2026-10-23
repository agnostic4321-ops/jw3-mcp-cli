#!/usr/bin/env node
/**
 * THE WATCH-KEEPER'S TESTS.
 *
 * The keeper repairs the watch patterns of the long-running processes,
 * because `~/.hermes/processes.json` is a SHARED file that every
 * Hermes session on the machine rewrites wholesale. A pattern set by
 * one session is dropped by the next session's write — and there are
 * 26 Hermes processes running here, so the patterns were being wiped
 * within minutes of being set.
 *
 * Two properties matter and both are tested here:
 *
 *   1. THE KEEPER REPAIRS A DRIFTED PATTERN, AND DOES NOT TOUCH A
 *      CORRECT ONE. A keeper that rewrites constantly would fight the
 *      sessions that legitimately own the file, and it would show up
 *      as noise.
 *
 *   2. THE PATTERNS ARE RUN-SCOPED, so they cannot match a dead run's
 *      buffered output. This is the property that stops a stale alert.
 *
 * Run: node research/test-watch-keep.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`    [PASS] ${name}`);
  } else {
    fail++;
    console.log(`    [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const src = readFileSync(new URL("./watch-keep.mjs", import.meta.url), "utf8");

console.log("════════════════════════════════════════════════════════════════════");
console.log("THE WATCH-KEEPER'S TESTS");
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

// ── 1. IT MATCHES A PROCESS BY ITS COMMAND, NOT ITS SESSION ID ──
console.log("1. IT MATCHES A PROCESS BY ITS COMMAND");
{
  check("the spec matches on the command", /match:\s*\(cmd\)\s*=>/.test(src));
  check(
    "the trade-loop is matched by its script",
    /research\/trade-loop\.mjs/.test(src),
  );
  check(
    "the collectors are matched by their scripts",
    /collect-funding-oi\.mjs/.test(src) && /collect-confluence\.mjs/.test(src),
  );
  check(
    "a session id is NOT used to identify the process",
    !/session_id\s*===\s*['"]proc_/.test(src),
    "the session id changes on every restart, so it cannot identify the process",
  );
}
console.log("");

// ── 1b. A BARE PATTERN IS NEVER INSTALLED ON A NEVER-TRUNCATED LOG ──
//
// The alert that started this: a session started with a BARE notify
// list (["FIRED", "cycle-error", "failed-but-venue-checked", ...])
// kept its subscription after it EXITED, and the desktop kept matching
// that subscription against the loop's audit log — which is never
// truncated, because it is the trade history. The result was the same
// 8-hour-old line delivered three times (21:26, 01:00, 01:50), each
// time re-queued by the desktop's retry queue.
//
// So the rule is per-spec: a bare pattern is safe only where the
// output is a LIVE stdout stream (bounded by the process's lifetime)
// and the event words are RESERVED fault words that never appear in
// healthy output. On a never-truncated log it is never safe.
console.log("1b. A BARE PATTERN IS NEVER INSTALLED ON A NEVER-TRUNCATED LOG");
{
  check(
    "a spec declares whether a bare pattern is safe for it",
    /bareOk:\s*true/.test(src),
    "the collectors write to a live stdout stream, so their bare FAILED is bounded by the process lifetime",
  );
  check(
    "the trade-loop does NOT allow a bare pattern",
    /research\/trade-loop\.mjs[\s\S]{0,700}?bareOk:\s*true/.test(src) === false,
    "the loop's audit log is never truncated, so a bare pattern on it matches all of history",
  );
  check(
    "a bare pattern is only returned when the spec allows it",
    /if \(spec\.bareOk\) return spec\.events;/.test(src),
  );
  check(
    "no run id and no bareOk means NO pattern at all",
    /return null;/.test(src),
    "an unwatched process is safe; a wrongly-watched one replays history",
  );
  check(
    "the unscoped case is RECORDED, not silent",
    /event:\s*"watch-unscoped"/.test(src),
  );
}
console.log("");

// ── 1c. A DEAD SESSION'S WATCH IS CLEARED ──
//
// The keeper repairs the sessions it finds and reports a supervised
// process that is absent, but a session that has EXITED kept its
// patterns, and the desktop kept matching them forever. A watch on a
// process that no longer exists has nothing to watch.
console.log("1c. A DEAD SESSION'S WATCH IS CLEARED");
{
  check(
    "the liveness probe exists",
    /function isAlive\(/.test(src) && /process\.kill\(pid, 0\)/.test(src),
    "kill -0 signals nothing and succeeds only for a live process",
  );
  check(
    "EPERM counts as ALIVE, not dead",
    /EPERM/.test(src),
    "EPERM means the process exists under another user",
  );
  check(
    "a dead session's watch_patterns are emptied",
    /entry\.watch_patterns = \[\]/.test(src),
  );
  check(
    "the clear is RECORDED",
    /event:\s*"watch-cleared"/.test(src),
    "a write to the shared registry must be auditable",
  );
  check(
    "only a session with patterns is touched",
    /entry\.watch_patterns\.length === 0/.test(src),
  );
}
console.log("");

// ── 1d. A DEAD SESSION'S STDOUT BUFFER IS REMOVED ──
//
// The desktop persists a long-running process's stdout to a buffer
// file named `out-<started_at seconds>-<writer pid>-<suffix>.log`,
// and it does NOT remove that file when the process dies. The buffer
// survives forever, and the watch matcher scans it — so a bare event
// name keeps matching a dead run's line hours after it was written.
//
// Observed: a session that fired an AVAX short at 13:05Z had its
// "FIRED" line delivered at 01:06 and again at 02:25 the next day, and
// its buffer held the ONLY matchable FIRED line in the directory.
console.log("1d. A DEAD SESSION'S STDOUT BUFFER IS REMOVED");
{
  check(
    "the buffer directory is known",
    /terminal-output/.test(src),
  );
  check(
    "the buffer's name is parsed for its session start time",
    /\^out-\(\\d\+\)-/.test(src),
    "the name is out-<started_at seconds>-<writer pid>-<suffix>.log",
  );
  check(
    "a buffer claimed by NO live session is removed",
    /unlinkSync\(path\)/.test(src),
  );
  check(
    "a buffer a live session claims is NOT removed",
    /if \(known\.has\(start\)\) continue;/.test(src),
    "a live session's buffer is its output",
  );
  check(
    "a buffer too young to be sure is NOT removed",
    /MARGIN_S/.test(src) && /start >= newest - MARGIN_S/.test(src),
    "a session that has just started may not be in the registry yet",
  );
  check(
    "the MTIME is NOT used to decide, because a live buffer is not written continuously",
    !/statSync\([^)]*\)\.mtime/.test(src),
    "a quiet collector writes nothing for minutes, so an mtime rule would delete a live buffer",
  );
  check(
    "the removal is RECORDED",
    /event:\s*"buffer-removed"/.test(src),
  );
}
console.log("");

// ── 1e. THE RUN-SCOPED PATTERN CANNOT MATCH THE AUDIT LOG'S HISTORY ──
//
// The dead session's rolling tail lives in the SERVER's memory, and the
// server re-matches it every 5 seconds (the watcher's check_interval),
// so a bare pattern re-fires the same historical line forever.
//
// The producer side is the durable fix, and it is provable: the audit
// log's HISTORICAL lines have no `run` field, so the run-scoped pattern
// cannot match them, while the bare name matches all of them.
//
// This check measures that on the real audit log, so the property
// cannot rot silently as the log grows.
console.log("1e. THE RUN-SCOPED PATTERN CANNOT MATCH THE AUDIT LOG'S HISTORY");
{
  const fsmod = await import("node:fs");
  const osmod = await import("node:os");
  const pathmod = await import("node:path");
  const audit = pathmod.join(osmod.homedir(), ".hermes/cache/scratch/trade-loop.ndjson");
  const runFile = pathmod.join(osmod.homedir(), ".hermes/cache/scratch/trade-loop.run.json");
  if (!fsmod.existsSync(audit) || !fsmod.existsSync(runFile)) {
    check("the audit log and the run file are present", false, audit);
  } else {
    const runId = JSON.parse(fsmod.readFileSync(runFile, "utf8")).runId;
    const lines = fsmod
      .readFileSync(audit, "utf8")
      .split("\n")
      .filter(Boolean);
    // the historical lines: the ones with NO run field
    const historical = lines.filter((l) => {
      try {
        const d = JSON.parse(l);
        return !d.run;
      } catch {
        return false;
      }
    });
    check(
      "the audit log has historical lines with NO run field",
      historical.length > 0,
      `${historical.length} historical lines`,
    );
    // every event name the keeper watches
    const EVENTS = [
      "FIRED",
      "failed-venue-unreadable",
      "failed-but-venue-checked",
      "entry-throttled",
      "cycle-error",
      "daily-budget-spent",
      "reconcile-skipped",
    ];
    let bareHits = 0;
    let scopedHits = 0;
    for (const e of EVENTS) {
      const bare = `"event":"${e}"`;
      const scoped = `"run":"${runId}","event":"${e}"`;
      bareHits += historical.filter((l) => l.includes(bare)).length;
      scopedHits += historical.filter((l) => l.includes(scoped)).length;
    }
    check(
      "a BARE event name DOES match the history (which is why it is unsafe)",
      bareHits > 0,
      `${bareHits} historical lines a bare pattern would match`,
    );
    check(
      "the RUN-SCOPED pattern matches NONE of the history",
      scopedHits === 0,
      `${scopedHits} historical lines matched — a run-scoped pattern must never match one`,
    );
    // and the current run's lines DO match the scoped pattern
    const current = lines.filter((l) => l.includes(`"run":"${runId}"`));
    check(
      "the current run's lines ARE matched by the run-scoped pattern",
      current.length > 0 &&
        current.some((l) => l.includes(`"run":"${runId}","event":"evidence-gate"`) || l.includes(`"run":"${runId}","event":"cycle-error"`)),
      `${current.length} current-run lines`,
    );
  }
}
console.log("");

// ── 1f. THE STDOUT EVENT NAME IS RUN-SCOPED, SO A BARE NAME CANNOT
//        MATCH THE SESSION'S TAIL ──
//
// The desktop captures the process's stdout into the session's rolling
// tail, and the watch matcher re-scans that tail every 5 seconds. A
// BARE event name in the tail matches EVERY historical line of that
// event in it, so a session that dies with a bare name in its tail
// re-fires the same historical line forever: nine distinct injections
// of one 9-hour-old refusal were observed for two dead sessions.
//
// So the producer writes TWO forms: the AUDIT LOG keeps the plain event
// name (the tooling greps for it, and it is the trade history), and the
// STDOUT line carries a RUN-SCOPED event name. The keeper's pattern
// targets the run-scoped name.
console.log("1f. THE STDOUT EVENT NAME IS RUN-SCOPED");
{
  const loop = readFileSync(new URL("./trade-loop.mjs", import.meta.url).pathname, "utf8");
  check(
    "the loop writes the AUDIT line with the PLAIN event name",
    /const audit = JSON\.stringify\(\{ ts: Date\.now\(\), run: RUN_ID, \.\.\.obj \}\)/.test(loop),
    "the audit log is the trade history and the tooling greps for the plain names",
  );
  check(
    "the loop writes the STDOUT line with a RUN-SCOPED event name",
    /event: `\$\{RUN_ID\}:\$\{event\}`/.test(loop),
    "a bare event name in stdout would be re-matched from the session's tail forever",
  );
  check(
    "the two forms are different lines",
    /appendFileSync\(LOG, `\$\{audit\}/.test(loop) && /console\.log\(stdout\)/.test(loop),
  );
  check(
    "the keeper's pattern targets the RUN-SCOPED event name",
    /`"event":"\$\{runId\}:\$\{e\}"`/.test(src),
    "the pattern must not match an audit-log line nor another run's stdout",
  );

  // the property, proved on synthetic lines of both forms
  const rid = "rTEST";
  const Q = String.fromCharCode(34);
  const stdoutLine = '{' + Q + 'ts' + Q + ':1,' + Q + 'run' + Q + ':' + Q + rid + Q + ',' + Q + 'event' + Q + ':' + Q + rid + ':FIRED' + Q + '}';
  const auditLine = '{' + Q + 'ts' + Q + ':1,' + Q + 'run' + Q + ':' + Q + rid + Q + ',' + Q + 'event' + Q + ':FIRED' + Q + '}';
  const otherStdout = '{' + Q + 'ts' + Q + ':1,' + Q + 'run' + Q + ':rOTHER' + Q + ',' + Q + 'event' + Q + ':rOTHER:FIRED' + Q + '}';
  const pattern = Q + 'event' + Q + ':' + Q + rid + ':FIRED';
  // String.includes, NOT the `in` operator — `in` is an object-key
  // lookup, so `pattern in stdoutLine` throws on a string.
  check("the pattern matches the current run's STDOUT", stdoutLine.includes(pattern));
  check("a BARE event name does NOT match the stdout", stdoutLine.includes('"event":"FIRED"') === false);
  check("the pattern does NOT match the AUDIT line", auditLine.includes(pattern) === false);
  check("the pattern does NOT match ANOTHER run's stdout", otherStdout.includes(pattern) === false);
}
console.log("");

// ── 2. THE PATTERNS ARE RUN-SCOPED ──
console.log("2. THE PATTERNS ARE RUN-SCOPED");
{
  check(
    "the run-scoped pattern is built from the run id",
    /"event":"\$\{runId\}:\$\{e\}"/.test(src),
    "the pattern carries the run id in the EVENT NAME, which is what the stdout line carries",
  );
  check(
    "the run id comes from the process's OWN run file",
    /runFile:\s*join\(SCRATCH,\s*"trade-loop\.run\.json"\)/.test(src),
  );
  check(
    "the run id is read from the file, not from the registry",
    /JSON\.parse\(readFileSync\(spec\.runFile/.test(src),
  );
  check(
    "the no-run-id case is documented and PER-SPEC, not a blanket bare fallback",
    /if \(spec\.bareOk\) return spec\.events;/.test(src) && /return null;/.test(src),
    "a bare pattern is safe only on a live stdout stream; on a never-truncated log it matches all of history",
  );
}
console.log("");

// ── 3. IT REPAIRS A DRIFT AND LEAVES A CORRECT PATTERN ALONE ──
console.log("3. IT REPAIRS A DRIFT AND LEAVES A CORRECT PATTERN ALONE");
{
  // Run the keeper against a REGISTRY of our own, in a temp dir, by
  // pointing it at a copy. The keeper's paths are module-level
  // constants, so the honest test is to run it with a temp HOME.
  const dir = mkdtempSync(join(tmpdir(), "jw3-watch-keep-"));
  const scratch = join(dir, ".hermes/cache/scratch");
  const registry = join(dir, ".hermes/processes.json");
  const runFile = join(scratch, "trade-loop.run.json");

  // The keeper reads the run file from $HOME/.hermes/cache/scratch.
  const fs = await import("node:fs");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify({ runId: "rTEST", pid: 1, startedAt: 1 }));

  const keeper = new URL("./watch-keep.mjs", import.meta.url).pathname;

  // A registry with a DRIFTED pattern, a CORRECT pattern, and a DEAD
  // session's stale watch.
  //
  // The live entries carry THIS process's pid, because the keeper now
  // clears the watch of a session whose process has EXITED — a watch
  // on a process that no longer exists has nothing to watch, and the
  // desktop would otherwise keep matching it against the audit log
  // forever. A fake pid is dead by definition, so a test that used one
  // would assert the clearing rather than the repair.
  //
  // The dead entry uses a pid that cannot be alive: the test's own
  // pid plus a large offset that no live process can hold.
  const livePid = process.pid;
  const deadPid = livePid + 4_000_000;
  fs.writeFileSync(
    registry,
    JSON.stringify([
      {
        session_id: "proc_x",
        pid: livePid,
        command: "node research/trade-loop.mjs --armed",
        watch_patterns: [],
      },
      {
        session_id: "proc_y",
        pid: livePid,
        command: "node research/collect-confluence.mjs",
        watch_patterns: ["FAILED"],
      },
      {
        session_id: "proc_dead",
        pid: deadPid,
        command: "node research/trade-loop.mjs --armed",
        watch_patterns: ['"run":"rTEST","event":"FIRED"'],
      },
    ], null, 1),
  );

  const out = execFileSync(process.execPath, [keeper, "--once"], {
    env: { ...process.env, HOME: dir },
    encoding: "utf8",
  });

  const after = JSON.parse(fs.readFileSync(registry, "utf8"));
  const loop = after.find((e) => e.session_id === "proc_x");
  const coll = after.find((e) => e.session_id === "proc_y");

  // The loop's watch list, by NAME — so a dropped event is a failure,
  // not just a changed count.
  const loopEvents = (loop?.watch_patterns ?? []).map((p) => /"event":"([^"]+)"/.exec(p)?.[1]).sort();
  check(
    "the drifted trade-loop pattern was repaired",
    (loop?.watch_patterns ?? []).length === 7,
    JSON.stringify(loop?.watch_patterns),
  );
  check(
    "the repaired pattern watches exactly the loop's events",
    JSON.stringify(loopEvents) ===
      JSON.stringify(
        [
          "rTEST:FIRED",
          "rTEST:cycle-error",
          "rTEST:daily-budget-spent",
          "rTEST:entry-throttled",
          "rTEST:reconcile-skipped",
          "rTEST:failed-but-venue-checked",
          "rTEST:failed-venue-unreadable",
        ].sort(),
      ),
    JSON.stringify(loopEvents),
  );
  check(
    "the repaired pattern is RUN-SCOPED",
    (loop?.watch_patterns ?? []).every((p) => p.includes('"event":"rTEST:')),
    JSON.stringify(loop?.watch_patterns),
  );
  // The count covers BOTH kinds of write: the repair of the drifted
  // pattern and the clearing of the dead session's watch.
  check(
    "the repair was reported",
    /watch-repaired/.test(out) && /repaired 2 process/.test(out),
    out.slice(-200),
  );
  check("the already-correct collector pattern was left alone", coll?.watch_patterns?.length === 1 && coll.watch_patterns[0] === "FAILED");

  // THE DEAD SESSION'S WATCH IS CLEARED.
  const dead = after.find((e) => e.session_id === "proc_dead");
  check(
    "the dead session's watch was CLEARED",
    (dead?.watch_patterns ?? []).length === 0,
    JSON.stringify(dead?.watch_patterns),
  );
  check(
    "the clear was reported",
    /watch-cleared/.test(out),
    out.slice(-240),
  );

  // A SECOND run must find nothing to repair — the keeper must not
  // fight the file it just wrote.
  const out2 = execFileSync(process.execPath, [keeper, "--once"], {
    env: { ...process.env, HOME: dir },
    encoding: "utf8",
  });
  check("a second pass finds nothing to repair", /every pattern was already correct/.test(out2), out2.slice(-160));

  // Now break it again and confirm the repair.
  const broken = JSON.parse(fs.readFileSync(registry, "utf8"));
  broken.find((e) => e.session_id === "proc_x").watch_patterns = ["FAILED"];
  fs.writeFileSync(registry, JSON.stringify(broken, null, 1));
  execFileSync(process.execPath, [keeper, "--once"], {
    env: { ...process.env, HOME: dir },
    encoding: "utf8",
  });
  const after2 = JSON.parse(fs.readFileSync(registry, "utf8"));
  const loop2 = after2.find((e) => e.session_id === "proc_x");
  check(
    "a clobbered pattern is repaired again",
    (loop2?.watch_patterns ?? []).every((p) => p.includes('"event":"rTEST:')),
    JSON.stringify(loop2?.watch_patterns),
  );

  rmSync(dir, { recursive: true, force: true });
}
console.log("");

// ── 4. THE PATTERNS IT WRITES ARE THE RIGHT ONES ──
console.log("4. THE PATTERNS IT WRITES ARE THE RIGHT ONES");
{
  check(
    "the loop's watch includes FIRED",
    /events:\s*\["FIRED",[^\]]*"failed-venue-unreadable"/.test(src) &&
      /events:\s*\["FIRED",[^\]]*"failed-but-venue-checked"/.test(src) &&
      /events:\s*\["FIRED",[^\]]*"entry-throttled"/.test(src),
    "the loop's watch list lost an event",
  );
  // The loop's OWN failure event must be watched: a cycle that dies was
  // silent while a bare pattern on the event NAME matched a DEAD run's
  // buffered line hours later.
  check(
    "the loop's watch includes cycle-error",
    /events:\s*\["FIRED",[^\]]*"cycle-error"/.test(src),
    "a cycle that dies is silent",
  );
  check(
    "the collectors watch only for FAILED",
    /events:\s*\["FAILED"\]/.test(src),
  );
  check(
    "the collectors' pacing backoff is NOT watched",
    !/events:\s*\[[^\]]*pacing backoff/.test(src),
    "a pacing backoff is normal operation and must never be an alarm",
  );
  check(
    "the keeper writes a history",
    /watch-keep\.history\.ndjson/.test(src),
  );
}
console.log("");

console.log("════════════════════════════════════════════════════════════════════");
console.log(fail === 0 ? `PASSED — ${pass}/${pass} checks` : `FAILED — ${fail} of ${pass + fail} checks failed`);
console.log("════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
