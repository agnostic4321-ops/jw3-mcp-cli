import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONN_SESSION_TTL_MS,
  JEV_TTL_MS,
  SPIKE_BASELINE_TTL_MS,
  clearConnSession,
  connSessionKey,
  getConnSession,
  isFresh,
  jevVerdictCachePath,
  jevVerdictKey,
  loadJevVerdict,
  loadSpikeBaseline,
  saveJevVerdict,
  saveSpikeBaseline,
  setConnSession,
} from "./cache.js";

describe("isFresh", () => {
  it("holds inside the TTL, expires at and past it", () => {
    assert.equal(isFresh(1000, 1000 + SPIKE_BASELINE_TTL_MS - 1, SPIKE_BASELINE_TTL_MS), true);
    assert.equal(isFresh(1000, 1000 + SPIKE_BASELINE_TTL_MS, SPIKE_BASELINE_TTL_MS), false);
    assert.equal(isFresh(1000, 1000 + SPIKE_BASELINE_TTL_MS + 1, SPIKE_BASELINE_TTL_MS), false);
  });
  it("rejects future timestamps and garbage", () => {
    assert.equal(isFresh(2000, 1000, 60_000), false);
    assert.equal(isFresh(NaN, 1000, 60_000), false);
    assert.equal(isFresh(0, 1000, 60_000), false);
  });
});

describe("spike baseline file cache", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jw3-cache-"));
    prev = process.env.JW3_CONFIG_HOME;
    process.env.JW3_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.JW3_CONFIG_HOME;
    else process.env.JW3_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("misses empty, round-trips a fresh entry", () => {
    assert.equal(loadSpikeBaseline("XBTUSDTM", 1_000_000), null);
    saveSpikeBaseline(
      "XBTUSDTM",
      { n: 120, volMed: 100, volP90: 200, volMax: 300, trigger: 400, lastTs: 9 },
      1_000_000,
    );
    const hit = loadSpikeBaseline("XBTUSDTM", 1_000_000 + 60_000);
    assert.equal(hit?.n, 120);
    assert.equal(hit?.trigger, 400);
  });
  it("expires after the 5-minute TTL", () => {
    assert.equal(SPIKE_BASELINE_TTL_MS, 5 * 60 * 1000);
    saveSpikeBaseline(
      "SOLUSDTM",
      { n: 120, volMed: 1, volP90: 2, volMax: 3, trigger: 4, lastTs: 0 },
      1_000_000,
    );
    assert.equal(loadSpikeBaseline("SOLUSDTM", 1_000_000 + SPIKE_BASELINE_TTL_MS + 1), null);
  });
  it("isolates symbols", () => {
    saveSpikeBaseline("ETHUSDTM", { n: 5, volMed: 1, volP90: 2, volMax: 3, trigger: 4, lastTs: 0 }, 100);
    assert.equal(loadSpikeBaseline("XBTUSDTM", 200), null);
    assert.equal(loadSpikeBaseline("ETHUSDTM", 200)?.n, 5);
  });
});

describe("connectionId session cache", () => {
  beforeEach(() => clearConnSession());
  afterEach(() => clearConnSession());

  it("keys differ by exchange/url/mode", () => {
    assert.notEqual(connSessionKey("kucoin", undefined, true), connSessionKey("binance", undefined, true));
    assert.notEqual(connSessionKey("kucoin", "a", true), connSessionKey("kucoin", "b", true));
    assert.notEqual(connSessionKey("kucoin", undefined, true), connSessionKey("kucoin", undefined, false));
    assert.equal(connSessionKey("KuCoin", undefined, true), connSessionKey("kucoin", undefined, true));
  });
  it("misses empty, hits inside the TTL, expires after", () => {
    const k = connSessionKey("kucoin", undefined, true);
    assert.equal(getConnSession(k, 1000), null);
    setConnSession(k, { id: "c1", exchange: "kucoin" }, 1000);
    assert.deepEqual(getConnSession(k, 1000 + CONN_SESSION_TTL_MS - 1), { id: "c1", exchange: "kucoin" });
    assert.equal(getConnSession(k, 1000 + CONN_SESSION_TTL_MS + 1), null);
  });
});

describe("JEV verdict file cache", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jw3-jev-"));
    prev = process.env.JW3_CONFIG_HOME;
    process.env.JW3_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.JW3_CONFIG_HOME;
    else process.env.JW3_CONFIG_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors the same 15-minute window as the edge", () => {
    assert.equal(JEV_TTL_MS, 15 * 60 * 1000);
  });
  it("keys are per-market and case-normalized like the edge", () => {
    assert.equal(jevVerdictKey("cex", "kucoin", "BTC/USDT"), "jev:cex|kucoin|BTC/USDT");
    assert.equal(jevVerdictKey("CEX", "KuCoin", "btc/usdt"), jevVerdictKey("cex", "kucoin", "BTC/USDT"));
  });
  it("misses empty, round-trips a fresh verdict, expires after the TTL", () => {
    const k = jevVerdictKey("cex", "kucoin", "BTC/USDT");
    assert.equal(loadJevVerdict(k, 1_000_000), null);
    saveJevVerdict(k, { model: "jev", analyzedAt: "2026-10-14T10:00:00.000Z" }, 1_000_000);
    assert.deepEqual(loadJevVerdict(k, 1_000_000 + JEV_TTL_MS - 1), {
      model: "jev",
      analyzedAt: "2026-10-14T10:00:00.000Z",
    });
    assert.equal(loadJevVerdict(k, 1_000_000 + JEV_TTL_MS + 1), null);
  });
  it("isolates markets", () => {
    saveJevVerdict(jevVerdictKey("cex", "kucoin", "ETH/USDT"), { v: 1 }, 100);
    assert.equal(loadJevVerdict(jevVerdictKey("cex", "kucoin", "BTC/USDT"), 200), null);
    assert.deepEqual(loadJevVerdict(jevVerdictKey("cex", "kucoin", "ETH/USDT"), 200), { v: 1 });
  });
  it("reads corrupt cache as miss and never throws on write", () => {
    const k = jevVerdictKey("prediction", "polymarket", "0xabc");
    saveJevVerdict(k, { ok: true }, 500);
    assert.deepEqual(loadJevVerdict(k, 600), { ok: true });
    writeFileSync(jevVerdictCachePath(), "{not json", "utf8");
    assert.equal(loadJevVerdict(k, 700), null);
    saveJevVerdict(k, null);
    assert.equal(loadJevVerdict(k, 800), null);
  });
});
