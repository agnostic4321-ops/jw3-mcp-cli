import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffMs,
  bootReconcile,
  buildLoopArgv,
  buildTrailArgv,
  collectBases,
  heartbeatPayload,
  loadManifest,
  parseLoopSpec,
  parseTrailSpec,
  runSuperviseOnce,
  shouldRotate,
  validateSuperviseArgs,
  SUPERVISE_BACKOFF_BASE_MS,
  SUPERVISE_BACKOFF_CAP_MS,
} from "./supervise.js";

describe("parseTrailSpec", () => {
  it("parses PAIR:SIDE:SIZE", () => {
    const t = parseTrailSpec("SOL/USDT:long:1");
    assert.equal(t.pair, "SOL/USDT");
    assert.equal(t.side, "long");
    assert.equal(t.size, 1);
    assert.equal(t.exchange, "kucoin");
  });
  it("parses an explicit exchange", () => {
    assert.equal(parseTrailSpec("SOL/USDT:short:2:binance").exchange, "binance");
  });
  it("rejects bad specs", () => {
    assert.throws(() => parseTrailSpec("SOLUSDT:long:1"), /PAIR/);
    assert.throws(() => parseTrailSpec("SOL/USDT:up:1"), /side/);
    assert.throws(() => parseTrailSpec("SOL/USDT:long:0"), /size/);
  });
});

describe("parseLoopSpec", () => {
  it("parses EXCHANGE:PAIR with a default long", () => {
    const l = parseLoopSpec("kucoin:SOL/USDT");
    assert.equal(l.exchange, "kucoin");
    assert.equal(l.pair, "SOL/USDT");
    assert.equal(l.direction, "long");
  });
  it("parses an explicit direction", () => {
    assert.equal(parseLoopSpec("kucoin:SOL/USDT:short").direction, "short");
  });
  it("rejects bad specs", () => {
    assert.throws(() => parseLoopSpec("kucoin"), /EXCHANGE/);
    assert.throws(() => parseLoopSpec("kucoin:SOLUSDT"), /pair/);
  });
});

describe("validateSuperviseArgs", () => {
  const base = { heartbeatSec: 15, maxRestarts: 10 };
  it("needs at least one child", () => {
    assert.ok(validateSuperviseArgs({ ...base, trails: [], loops: [] }));
  });
  it("accepts a trail-only setup", () => {
    assert.equal(
      validateSuperviseArgs({ ...base, trails: [{ pair: "SOL/USDT", side: "long", size: 1 }], loops: [] }),
      null,
    );
  });
  it("bounds heartbeat and restarts", () => {
    const t = [{ pair: "SOL/USDT", side: "long" as const, size: 1 }];
    assert.ok(validateSuperviseArgs({ trails: t, loops: [], heartbeatSec: 1, maxRestarts: 10 }));
    assert.ok(validateSuperviseArgs({ trails: t, loops: [], heartbeatSec: 15, maxRestarts: 101 }));
  });
});

describe("no-trades gate", () => {
  it("trail children spawn WITHOUT --yes by default", () => {
    const argv = buildTrailArgv({ pair: "SOL/USDT", side: "long", size: 1, yes: true }, false);
    assert.ok(!argv.includes("--yes"), `default must stay dry-run, got: ${argv.join(" ")}`);
  });
  it("--allow-live honors an explicit manifest yes:true", () => {
    const argv = buildTrailArgv({ pair: "SOL/USDT", side: "long", size: 1, yes: true }, true);
    assert.ok(argv.includes("--yes"));
  });
  it("--live (WS transport) is safe and always passed through", () => {
    const argv = buildTrailArgv({ pair: "SOL/USDT", side: "long", size: 1, live: true }, false);
    assert.ok(argv.includes("--live"));
    assert.ok(!argv.includes("--yes"));
  });
  it("loop children never carry --yes", () => {
    const argv = buildLoopArgv({ exchange: "kucoin", pair: "SOL/USDT" });
    assert.ok(!argv.includes("--yes"));
  });
});

describe("backoffMs", () => {
  it("doubles from the base and caps at 30s", () => {
    assert.equal(backoffMs(0), SUPERVISE_BACKOFF_BASE_MS);
    assert.equal(backoffMs(1), SUPERVISE_BACKOFF_BASE_MS * 2);
    assert.equal(backoffMs(4), SUPERVISE_BACKOFF_BASE_MS * 16);
    assert.equal(backoffMs(99), SUPERVISE_BACKOFF_CAP_MS);
  });
  it("treats garbage attempts as zero", () => {
    assert.equal(backoffMs(-3), SUPERVISE_BACKOFF_BASE_MS);
  });
});

describe("shouldRotate", () => {
  it("rotates at the limit, not below", () => {
    assert.equal(shouldRotate(5 * 1024 * 1024, 5 * 1024 * 1024), true);
    assert.equal(shouldRotate(1024, 5 * 1024 * 1024), false);
    assert.equal(shouldRotate(1024, 0), false);
  });
});

describe("heartbeatPayload", () => {
  it("carries pid, children, and dry-run", () => {
    const hb = heartbeatPayload({
      pid: 7,
      startedAt: "2026-10-14T00:00:00.000Z",
      at: "2026-10-14T00:00:15.000Z",
      uptimeSec: 15.4,
      children: [],
      boot: { states: [], unreadable: [] },
      dryRun: true,
    });
    assert.equal(hb.pid, 7);
    assert.equal(hb.dryRun, true);
    assert.equal((hb as { event: string }).event, "supervise-heartbeat");
  });
});

describe("manifest + boot reconcile", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supervise-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a manifest file", () => {
    const p = join(dir, "manifest.json");
    writeFileSync(p, JSON.stringify({ trails: [{ pair: "SOL/USDT", side: "long", size: 1 }], loops: [] }));
    const m = loadManifest(p);
    assert.equal(m.trails?.length, 1);
  });
  it("refuses invalid manifests instead of supervising blind", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{nope");
    assert.throws(() => loadManifest(p), /JSON/);
    assert.throws(() => loadManifest(join(dir, "missing.json")), /no supervise manifest/);
  });
  it("boot reconcile is read-only and offline-safe (venue unchecked, no trades)", () => {
    writeFileSync(
      join(dir, "trail_sol.json"),
      JSON.stringify({ kind: "trail", base: "SOL", pair: "SOL/USDT", side: "long", entry: 100, closed: false }),
    );
    const report = bootReconcile([{ pair: "SOL/USDT", side: "long", size: 1 }], dir);
    assert.ok(report.bases.includes("SOL"));
    assert.equal(report.states.length, 1);
    // Boot never reports clean-venue truth — offline-safe start.
    assert.ok(report.strays.every((s) => s.code !== "unmanaged-position"));
  });
  it("collects bases from trails plus stray files on disk", () => {
    writeFileSync(join(dir, "scalp_btc.json"), JSON.stringify({ kind: "x", pair: "BTC/USDT" }));
    const bases = collectBases([{ pair: "SOL/USDT", side: "long", size: 1 }], dir);
    assert.ok(bases.includes("SOL"));
    assert.ok(bases.includes("BTC"));
  });
});

describe("runSuperviseOnce", () => {
  it("builds child specs + heartbeat with no processes spawned", () => {
    const dir = mkdtempSync(join(tmpdir(), "supervise-once-"));
    try {
      const report = runSuperviseOnce(
        {
          trails: [{ pair: "SOL/USDT", side: "long", size: 1 }],
          loops: [{ exchange: "kucoin", pair: "SOL/USDT" }],
          heartbeatSec: 15,
          maxRestarts: 3,
          maxLogBytes: 1024,
          maxLogFiles: 2,
          stateDir: dir,
          once: true,
          allowLive: false,
          json: true,
        },
        Date.parse("2026-10-14T00:00:00.000Z"),
      );
      assert.equal(report.children.length, 2);
      assert.equal(report.dryRun, true);
      assert.ok(report.children.every((c) => !c.argv.includes("--yes")), "once report must stay dry-run");
      assert.equal((report.heartbeat as { event: string }).event, "supervise-heartbeat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
