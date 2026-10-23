import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { cmdTrail, type TrailArgs } from "./trail.js";
import type { LiveMarkFeed } from "../kucoin-ws.js";

const base: TrailArgs = {
  exchange: "kucoin",
  pair: "SOL/USDT",
  side: "long",
  size: 1,
  activationPct: 0.25,
  bouncebackPct: 0.08,
  polls: 5,
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  process.exitCode = 0;
});

const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "trail-live-"));
  dirs.push(d);
  return d;
};

/** Feed whose latest() walks `mids` one step per read (deterministic tape). */
function scriptedFeed(mids: number[]): { feed: LiveMarkFeed; closed: () => boolean } {
  let calls = -1;
  let isClosed = false;
  const now = Date.now();
  const feed: LiveMarkFeed = {
    contract: "SOLUSDTM",
    latest: () => {
      calls++;
      const mid = mids[Math.min(Math.max(calls, 0), mids.length - 1)] ?? 0;
      return {
        symbol: "SOLUSDTM", bestBid: mid * 0.9999, bestAsk: mid * 1.0001, mid,
        bidSize: 1, askSize: 1, seq: calls, tsMs: now, recvMs: Date.now(),
      };
    },
    count: () => Math.max(0, calls + 1),
    ageMs: () => 0,
    close: () => {
      isClosed = true;
    },
  };
  return { feed, closed: () => isClosed };
}

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

describe("trail --live", () => {
  it("trips the stop on an intra-poll WS touch and closes the feed", async () => {
    // poll1: entry 100 · poll2: 100.30 arms (peak) · gap touch 100.20
    // = 0.0997% off peak ≥ 0.08 → trigger before poll3.
    const { feed, closed } = scriptedFeed([100, 100.3, 100.3, 100.2, 100.2]);
    const lines = await capture(() =>
      cmdTrail({ ...base, live: true }, { yes: false, json: false }, {
        markFn: async () => {
          throw new Error("REST must not be read while the feed is fresh");
        },
        openLiveFeed: async () => feed,
        sleepMs: async () => {},
        stateDir: freshDir(),
      }),
    );
    const text = lines.join("\n");
    assert.match(text, /LIVE FEED SOLUSDTM/);
    assert.match(text, /intra-poll price=.* status=trigger/);
    assert.match(text, /WOULD-CLOSE LONG SOL\/USDT/);
    assert.equal(closed(), true);
  });

  it("falls back to REST when the feed fails to open", async () => {
    const marks = [100, 100.3, 100.2];
    let i = 0;
    const lines = await capture(() =>
      cmdTrail({ ...base, polls: 3, live: true }, { yes: false, json: false }, {
        markFn: async () => marks[Math.min(i++, marks.length - 1)] as number,
        openLiveFeed: async () => {
          throw new Error("boom");
        },
        sleepMs: async () => {},
        stateDir: freshDir(),
      }),
    );
    const text = lines.join("\n");
    assert.match(text, /LIVE FEED UNAVAILABLE \(boom\) — REST fallback/);
    assert.match(text, /WOULD-CLOSE LONG SOL\/USDT/);
  });

  it("stays REST-only without --live (no feed opened)", async () => {
    let opened = 0;
    const lines = await capture(() =>
      cmdTrail({ ...base, polls: 2 }, { yes: false, json: true }, {
        markFn: async () => 100,
        openLiveFeed: async () => {
          opened++;
          throw new Error("must not open");
        },
        sleepMs: async () => {},
        stateDir: freshDir(),
      }),
    );
    assert.equal(opened, 0);
    assert.ok(lines.some((l) => l.includes('"status":"open"')));
  });
});
