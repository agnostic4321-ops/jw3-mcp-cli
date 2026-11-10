/**
 * OQ-10 goldens — the stdout, stderr, exit code (and written files) of every
 * backtest / farm / replay command on deterministic fixture candles.
 * Recorded from the pre-OQ-10 engines (commit "w8(L11c): OQ-10 goldens")
 * and required BYTE-IDENTICAL after the replay-core merge. C10-04 documents
 * no engine bug, so no difference is allowed.
 *
 * Re-record ONLY for an owner-approved change: JW3_GOLDEN_RECORD=1.
 * No network: every candle fetch, clock and contract spec is injected.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdBacktestScalp } from "./commands/backtest-scalp.js";
import { cmdFarmLeaderboard, cmdFarmRun } from "./commands/farm.js";
import { cmdBacktestLive } from "./commands/backtest-live.js";
import { cmdGridBacktest } from "./commands/grid.js";

const RECORD = process.env.JW3_GOLDEN_RECORD === "1";
const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = (() => {
  const candidates = [join(here, "replay.golden.json"), join(here, "..", "src", "replay.golden.json")];
  return candidates.find((p) => existsSync(p)) ?? (candidates[1] as string);
})();

/* ------------------------------------------------------------------ */
/* fixture candles — seeded, regime-switching random walks             */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r6 = (x: number): number => Number(x.toFixed(6));

/**
 * Venue kline rows [tsMs, open, high, low, close, volume, turnover].
 * Regimes: calm chop, up-run, down-run (volume FADES on the runs — the
 * fade/dip trigger) and volatility spikes (wide bars: TP/kill ties).
 */
export function fixtureRows(
  seed: number,
  n: number,
  stepMin: number,
  p0: number,
  volPct: number,
  shape: { wick?: number; reverse?: boolean; gap?: number } = {},
): number[][] {
  const wick = shape.wick ?? 0.4;
  const r = mulberry32(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const rows: number[][] = [];
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  let p = p0;
  let regime = 0;
  let left = 0;
  let v = 1000;
  for (let k = 0; k < n; k++) {
    if (left <= 0) {
      // `reverse`: a run is followed by the OPPOSITE run — the setup fires
      // at the exhausted extension, then the tape runs AWAY from a resting
      // entry (maker expiry, chase re-price → taker).
      const prev = regime;
      regime = shape.reverse && (prev === 1 || prev === 2) && r() < 0.7 ? 3 - prev : Math.floor(r() * 4);
      left = 6 + Math.floor(r() * 30);
    }
    left--;
    const drift = regime === 1 ? volPct * 0.35 : regime === 2 ? -volPct * 0.35 : 0;
    const sig = regime === 3 ? volPct * 2.5 : volPct;
    // `gap`: runs open AWAY from the last close (a resting touch is skipped).
    const o = shape.gap ? p * (1 + (Math.sign(drift) * shape.gap) / 100) : p;
    const c = Math.max(p0 * 0.05, o * (1 + (drift + sig * gauss()) / 100));
    const hi = Math.max(o, c) * (1 + (Math.abs(gauss()) * sig * wick) / 100);
    const lo = Math.min(o, c) * (1 - (Math.abs(gauss()) * sig * wick) / 100);
    v = regime === 1 || regime === 2 ? v * (0.9 + r() * 0.12) : 600 + r() * 1400;
    rows.push([t0 + k * stepMin * 60_000, r6(o), r6(hi), r6(lo), r6(c), r6(v), r6(v * c)]);
    p = c;
  }
  return rows;
}

const NOW = Date.UTC(2026, 9, 1, 0, 0, 0);
const SERIES: Record<string, number[][]> = {
  "SOLUSDTM:60": fixtureRows(11, 720, 60, 150, 0.9),
  "XBTUSDTM:60": fixtureRows(23, 720, 60, 60000, 0.6),
  "BTCUSDTM:60": fixtureRows(23, 720, 60, 60000, 0.6),
  "ETHUSDTM:60": fixtureRows(37, 720, 60, 2500, 0.8),
  "SOLUSDTM:15": fixtureRows(41, 2880, 15, 150, 0.45),
  "SOLUSDTM:1h-live": fixtureRows(53, 720, 60, 150, 0.9),
  "SEIUSDTM:15": fixtureRows(67, 2880, 15, 0.5, 0.5),
  "THIN:60": fixtureRows(79, 40, 60, 150, 0.9),
  "SOLUSDTM:15-runaway": fixtureRows(89, 2880, 15, 150, 0.6, { wick: 0.02, reverse: true, gap: 0.25 }),
};

let thin = false;
const fetchRows = async (symbol: string, gran: number): Promise<number[][]> => {
  if (thin) return SERIES["THIN:60"]!;
  const rows = SERIES[`${symbol}:${gran}`];
  if (!rows) throw new Error(`no fixture for ${symbol}:${gran}`);
  return rows;
};
const now = (): number => NOW;

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

type Golden = { out: string[]; err: string[]; exitCode: number | null; files?: Record<string, string> };

async function capture(fn: () => Promise<void>): Promise<Golden> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  };
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : null;
  process.exitCode = undefined;
  return { out, err, exitCode };
}

const ENV_HOME = process.env.JW3_CONFIG_HOME;
let home = "";
before(() => {
  home = mkdtempSync(join(tmpdir(), "jw3-oq10-home-"));
  process.env.JW3_CONFIG_HOME = home;
});
after(() => {
  if (ENV_HOME === undefined) delete process.env.JW3_CONFIG_HOME;
  else process.env.JW3_CONFIG_HOME = ENV_HOME;
  rmSync(home, { recursive: true, force: true });
});

const farmFiles = (): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const f of ["farm-latest.json", "farm-candidates.json"]) {
    const p = join(home, f);
    files[f] = existsSync(p) ? readFileSync(p, "utf8") : "<absent>";
  }
  return files;
};

/* ------------------------------------------------------------------ */
/* every backtest / farm / replay command                              */
/* ------------------------------------------------------------------ */

const scalp = (o: { pair?: string; tpPct?: number; fee?: string; json: boolean }) => () =>
  cmdBacktestScalp({ pair: o.pair ?? "SOL/USDT", days: 30, tpPct: o.tpPct, fee: o.fee ?? "taker", sizeUsd: 60, json: o.json }, { fetch: fetchRows, now });

const live = (mode: "maker" | "chase" | "taker" | "all", json: boolean, tf = "15m", series?: string) => () =>
  cmdBacktestLive(
    { pair: "SOL/USDT", days: 30, tf, sizeUsd: 60, leverage: 2, mode, json },
    {
      fetch: async (symbol, gran) =>
        series ? SERIES[series]! : tf === "1h" ? SERIES["SOLUSDTM:1h-live"]! : fetchRows(symbol, gran),
      now,
    },
  );

const grid = (json: boolean) => () =>
  cmdGridBacktest(
    { pair: "SEI/USDT", stepPct: 0.25, levelsPerSide: 25, contracts: 19, leverage: 2, days: 30, json },
    {
      closes: async (symbol, gran) => (await fetchRows(symbol, gran)).map((k) => k[4] as number),
      spec: async () => ({ multiplier: 1, tick: 0.0001 }),
      now,
    },
  );

export const COMMANDS: [string, () => Promise<Golden>][] = [
  ["backtest scalp SOL taker text", () => capture(scalp({ json: false }))],
  ["backtest scalp SOL taker json", () => capture(scalp({ json: true }))],
  ["backtest scalp SOL maker json", () => capture(scalp({ fee: "maker", json: true }))],
  ["backtest scalp SOL maker text", () => capture(scalp({ fee: "maker", json: false }))],
  ["backtest scalp SOL --tp 0.4 text", () => capture(scalp({ tpPct: 0.4, json: false }))],
  ["backtest scalp SOL --tp 0.4 json", () => capture(scalp({ tpPct: 0.4, json: true }))],
  ["backtest scalp BTC taker text", () => capture(scalp({ pair: "BTC/USDT", json: false }))],
  ["backtest scalp BTC taker json", () => capture(scalp({ pair: "BTC/USDT", json: true }))],
  ["backtest scalp ETH taker json", () => capture(scalp({ pair: "ETH/USDT", json: true }))],
  ["backtest scalp bad --tp", () => capture(scalp({ tpPct: 5, json: false }))],
  [
    "backtest scalp thin history",
    async () => {
      thin = true;
      try {
        return await capture(scalp({ json: false }));
      } finally {
        thin = false;
      }
    },
  ],
  ["farm leaderboard before any run", () => capture(() => cmdFarmLeaderboard({ json: false }))],
  [
    "farm run taker text (+files)",
    async () => {
      const g = await capture(() => cmdFarmRun({ pairsRaw: "SOL/USDT,BTC/USDT,ETH/USDT", days: 30, fee: "taker", sizeUsd: 60, json: false }, { fetch: fetchRows, now }));
      return { ...g, files: farmFiles() };
    },
  ],
  ["farm leaderboard text", () => capture(() => cmdFarmLeaderboard({ json: false }))],
  ["farm leaderboard json", () => capture(() => cmdFarmLeaderboard({ json: true }))],
  [
    "farm run maker json (+files)",
    async () => {
      const g = await capture(() => cmdFarmRun({ pairsRaw: "SOL/USDT,ETH/USDT", days: 30, fee: "maker", sizeUsd: 60, json: true }, { fetch: fetchRows, now }));
      return { ...g, files: farmFiles() };
    },
  ],
  [
    "farm run thin history",
    async () => {
      thin = true;
      try {
        return await capture(() => cmdFarmRun({ pairsRaw: "SOL/USDT", days: 30, fee: "taker", sizeUsd: 60, json: false }, { fetch: fetchRows, now }));
      } finally {
        thin = false;
      }
    },
  ],
  ["farm run bad pairs", () => capture(() => cmdFarmRun({ pairsRaw: "SOLUSDT", days: 30, fee: "taker", sizeUsd: 60, json: false }, { fetch: fetchRows, now }))],
  ["backtest live maker text", () => capture(live("maker", false))],
  ["backtest live maker json", () => capture(live("maker", true))],
  ["backtest live chase text", () => capture(live("chase", false))],
  ["backtest live chase json", () => capture(live("chase", true))],
  ["backtest live taker json", () => capture(live("taker", true))],
  ["backtest live all text", () => capture(live("all", false))],
  ["backtest live all json", () => capture(live("all", true))],
  ["backtest live all 1h json", () => capture(live("all", true, "1h"))],
  ["backtest live all json (runaway tape)", () => capture(live("all", true, "15m", "SOLUSDTM:15-runaway"))],
  ["backtest live all text (runaway tape)", () => capture(live("all", false, "15m", "SOLUSDTM:15-runaway"))],
  ["backtest live maker json (runaway tape)", () => capture(live("maker", true, "15m", "SOLUSDTM:15-runaway"))],
  ["grid backtest text", () => capture(grid(false))],
  ["grid backtest json", () => capture(grid(true))],
];

const goldens: Record<string, Golden> = RECORD ? {} : (JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Record<string, Golden>);

describe("OQ-10 goldens: every backtest/farm/replay command, byte-identical", () => {
  for (const [name, run] of COMMANDS) {
    it(name, async () => {
      const got = await run();
      if (RECORD) {
        goldens[name] = got;
        return;
      }
      const want = goldens[name];
      assert.ok(want, `no golden recorded for ${name}`);
      assert.deepEqual(got, want);
    });
  }
  after(() => {
    if (RECORD) writeFileSync(GOLDEN_FILE, `${JSON.stringify(goldens, null, 2)}\n`);
  });
});
