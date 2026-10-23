/**
 * `forecast` — Kronos K-line foundation-model oracle (READ-ONLY, no trades).
 * KuCoin public 15m futures tape in, pretrained Kronos-small (CPU, no
 * finetuning) out: direction + expected move % over the horizon.
 * Network stays at the edge (futuresKlinesRaw); inference lives in the
 * local python bridge (python/kronos_forecast.py) so the shape is mockable.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { futuresKlinesRaw } from "../kucoin.js";

export const FORECAST_GRANULARITY_MIN = 15;
export const FORECAST_LOOKBACK = 400;
export const FORECAST_MIN_BARS = 50;

/**
 * Pure: `ETH/USDT` → `ETHUSDTM`. BTC aliases XBT (venue names it XBT);
 * quote must be USDT (the futures symbol is always USDT-margined).
 */
export function forecastSymbolForPair(pair: string): string | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return null;
  let base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (quote !== "USDT") return null;
  if (base === "BTC") base = "XBT";
  if (!/^[A-Z0-9]{2,12}$/.test(base)) return null;
  return `${base}USDTM`;
}

export type ForecastDirection = "up" | "down" | "flat";

export type ForecastVerdict = {
  direction: ForecastDirection;
  expected_move_pct: number;
  last_close: number;
  pred_last_close: number;
  pred_closes: number[];
  horizon: number;
  lookback: number;
  ms: number;
  /** True when KRONOS_FINETUNED_PATH weights were loaded (absent = frozen baseline). */
  finetuned?: boolean;
};

const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: validate the bridge's stdout shape. Anything else → null (never trust). */
export function parseForecastOutput(raw: unknown): ForecastVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["direction"] !== "up" && o["direction"] !== "down" && o["direction"] !== "flat") return null;
  if (!isFin(o["expected_move_pct"])) return null;
  if (!isFin(o["last_close"]) || (o["last_close"] as number) <= 0) return null;
  if (!isFin(o["pred_last_close"]) || (o["pred_last_close"] as number) <= 0) return null;
  if (!Array.isArray(o["pred_closes"]) || o["pred_closes"].length === 0) return null;
  const closes = o["pred_closes"] as unknown[];
  if (!closes.every((c) => isFin(c) && (c as number) > 0)) return null;
  if (!Number.isInteger(o["horizon"]) || (o["horizon"] as number) < 1) return null;
  if (!Number.isInteger(o["lookback"]) || (o["lookback"] as number) < 1) return null;
  if (!isFin(o["ms"]) || (o["ms"] as number) < 0) return null;
  const finetuned = o["finetuned"] === true ? true : undefined;
  return {
    direction: o["direction"] as ForecastDirection,
    expected_move_pct: o["expected_move_pct"] as number,
    last_close: o["last_close"] as number,
    pred_last_close: o["pred_last_close"] as number,
    pred_closes: closes as number[],
    horizon: o["horizon"] as number,
    lookback: o["lookback"] as number,
    ms: o["ms"] as number,
    ...(finetuned === true ? { finetuned: true as const } : {}),
  };
}

/** python with torch + Kronos: $KRONOS_PYTHON, else ~/kronos/.venv. */
export function resolveKronosPython(): string {
  const env = (process.env["KRONOS_PYTHON"] ?? "").trim();
  if (env) return env;
  const home = (process.env["HOME"] ?? "").trim();
  if (home) return `${home}/kronos/.venv/bin/python`;
  return "python3";
}

function bridgePath(): string {
  return fileURLToPath(new URL("../../python/kronos_forecast.py", import.meta.url));
}

/**
 * Fetch klines + run the Kronos bridge for `pair`. Throws on any failure
 * (tape short, bridge spawn/exit, bad shape) — callers decide how to
 * report. Shared by `forecast` and `vote` so both read the same oracle.
 */
export async function fetchKronosVerdict(pair: string, horizonRaw: number): Promise<ForecastVerdict> {
  const sym = forecastSymbolForPair(pair);
  if (!sym) throw new Error(`bad pair ${pair} (want BASE/USDT)`);
  const horizon = Math.min(Math.max(Math.round(horizonRaw), 1), 120);
  const now = Date.now();
  const spanMs = FORECAST_LOOKBACK * FORECAST_GRANULARITY_MIN * 60 * 1000;
  const mid = now - (spanMs >> 1);
  let rows: number[][];
  try {
    const [a, b] = await Promise.all([
      futuresKlinesRaw(sym, FORECAST_GRANULARITY_MIN, now - spanMs, mid),
      futuresKlinesRaw(sym, FORECAST_GRANULARITY_MIN, mid, now),
    ]);
    const byTs = new Map<number, number[]>();
    for (const k of [...a, ...b]) {
      const ts = Number(k[0]);
      if (Number.isFinite(ts) && !byTs.has(ts)) byTs.set(ts, k);
    }
    rows = [...byTs.values()].sort((x, y) => Number(x[0]) - Number(y[0]));
  } catch (e) {
    throw new Error(`kucoin klines for ${sym}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (rows.length < FORECAST_MIN_BARS) {
    throw new Error(`only ${rows.length} 15m bars for ${sym} (need ${FORECAST_MIN_BARS}).`);
  }
  const stdin = JSON.stringify({
    klines: rows.map((k) => [k[0], k[1], k[2], k[3], k[4], k[5]]),
    horizon,
    granularity_min: FORECAST_GRANULARITY_MIN,
  });
  const python = resolveKronosPython();
  let out: ReturnType<typeof spawnSync>;
  try {
    out = spawnSync(python, [bridgePath()], {
      input: stdin,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error(`kronos bridge spawn: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.error) {
    throw new Error(`kronos bridge: ${String(out.error.message ?? out.error)}`);
  }
  if (out.status !== 0) {
    const err = String(out.stderr ?? "").trim().split("\n").slice(-3).join("\n");
    throw new Error(`kronos bridge exit ${out.status}${err ? `: ${err}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(out.stdout));
  } catch {
    throw new Error("kronos bridge returned non-JSON stdout.");
  }
  const verdict = parseForecastOutput(parsed);
  if (!verdict) throw new Error("kronos bridge returned an unexpected shape.");
  return verdict;
}

export async function cmdForecast(opts: {
  pair: string;
  horizon: number;
  json: boolean;
}): Promise<void> {
  const sym = forecastSymbolForPair(opts.pair);
  if (!sym) {
    console.error("Usage: jw3 forecast --pair ETH/USDT [--horizon 12] [--json]");
    process.exitCode = 2;
    return;
  }
  let verdict: ForecastVerdict;
  try {
    verdict = await fetchKronosVerdict(opts.pair, opts.horizon);
  } catch (e) {
    console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ pair: opts.pair.toUpperCase(), symbol: sym, ...verdict }, null, 2));
    return;
  }
  const arrow = verdict.direction === "up" ? "UP ▲" : verdict.direction === "down" ? "DOWN ▼" : "FLAT ■";
  const sign = verdict.expected_move_pct > 0 ? "+" : "";
  const weights = verdict.finetuned === true ? "finetuned (KRONOS_FINETUNED_PATH)" : "pretrained";
  console.log(`Kronos-small (CPU, ${weights})  ${opts.pair.toUpperCase()}  ${verdict.horizon}x15m  lookback ${verdict.lookback}`);
  console.log(`direction: ${arrow}  expected ${sign}${verdict.expected_move_pct.toFixed(2)}%`);
  console.log(`last ${verdict.last_close} -> pred ${verdict.pred_last_close}  (inference ${(verdict.ms / 1000).toFixed(1)}s)`);
  console.log("Pretrained oracle, not advice; fade-signal edge is unproven without a JEV confirm.");
}
