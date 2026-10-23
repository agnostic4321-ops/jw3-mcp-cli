/**
 * `jw3 klines` — read-only. Prints recent KuCoin futures candles for one
 * contract via the existing public futuresKlines helper (no auth, no PAT).
 * Optional Wilder RSI(14) and session VWAP columns. Never trades.
 */
import { futuresKlines } from "../kucoin.js";
import { fail } from "./market.js";

/** Supported timeframe labels → KuCoin granularity minutes. */
export const KLINES_TF_MIN: Record<string, number> = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "1d": 1440,
};

export const KLINES_DEFAULT_TF = "15m";
export const KLINES_DEFAULT_LIMIT = 50;
export const KLINES_MAX_LIMIT = 500;
export const KLINES_RSI_PERIOD = 14;

/** Label like "15m" → granularity minutes, or null when unsupported. */
export function klinesTfToMinutes(tf: string): number | null {
  const v = KLINES_TF_MIN[String(tf ?? "").toLowerCase()];
  return v ?? null;
}

/** Pair like SOL/USDT → futures symbol; BTC aliases XBT (venue symbol). */
export function klinesSymbolForPair(pair: string): string | null {
  const parts = String(pair ?? "").split("/");
  if (parts.length !== 2) return null;
  const base = (parts[0] ?? "").trim().toUpperCase();
  const quote = (parts[1] ?? "").trim().toUpperCase();
  if (!base || quote !== "USDT" || /[^A-Z0-9]/.test(base)) return null;
  return `${base === "BTC" ? "XBT" : base}USDTM`;
}

export type KlineCandle = {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

/** Parse raw [ts,o,h,l,c,vol,turnover] rows; drops malformed/non-positive closes. */
export function parseKlineRows(rows: number[][]): KlineCandle[] {
  const out: KlineCandle[] = [];
  for (const k of rows ?? []) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const c: KlineCandle = {
      tsMs: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      turnover: k.length > 6 ? Number(k[6]) : NaN,
    };
    if (!(c.close > 0) || !Number.isFinite(c.tsMs)) continue;
    out.push(c);
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

/**
 * Wilder RSI over closes. First (period) entries are null (seed needs
 * period+1 closes); flat history (zero avg gain AND loss) reads 50.
 */
export function rsiWilder(closes: number[], period = KLINES_RSI_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (): number => {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/**
 * Cumulative session VWAP over the returned window: typical price (h+l+c)/3
 * weighted by volume. Entries at/after a zero cumulative volume read null.
 */
export function vwapCumulative(candles: KlineCandle[]): (number | null)[] {
  const out: (number | null)[] = [];
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    const tp = (c.high + c.low + c.close) / 3;
    if (Number.isFinite(tp) && vol > 0) {
      pv += tp * vol;
      v += vol;
    }
    out.push(v > 0 ? pv / v : null);
  }
  return out;
}

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

export type KlinesArgs = {
  pair: string;
  tf: string;
  limit: number;
  rsi: boolean;
  vwap: boolean;
  json: boolean;
};

export type KlinesDeps = {
  fetch?: (symbol: string, granMin: number, fromMs: number, toMs: number) => Promise<number[][]>;
  now?: () => number;
};

export async function cmdKlines(a: KlinesArgs, deps?: KlinesDeps): Promise<void> {
  const symbol = klinesSymbolForPair(a.pair);
  const granMin = klinesTfToMinutes(a.tf);
  const limit = Math.floor(a.limit);
  if (!symbol || granMin == null || !Number.isInteger(limit) || limit < 1 || limit > KLINES_MAX_LIMIT) {
    console.error(
      `Usage: jw3 klines --pair SOL/USDT [--tf 5m|15m|1h|1d] [--limit 1..${KLINES_MAX_LIMIT}] [--rsi] [--vwap] [--json]`,
    );
    process.exitCode = 2;
    return;
  }
  const now = deps?.now ?? Date.now;
  const toMs = now();
  const fromMs = toMs - limit * granMin * 60 * 1000;
  let rows: number[][];
  try {
    rows = await (deps?.fetch ?? futuresKlines)(symbol, granMin, fromMs, toMs);
  } catch (e) {
    fail(e);
    return;
  }
  const candles = parseKlineRows(rows).slice(-limit);
  if (candles.length === 0) {
    console.error(`No klines for ${symbol} (${a.tf}) — venue returned no rows.`);
    process.exitCode = 1;
    return;
  }
  const closes = candles.map((c) => c.close);
  const rsi = a.rsi ? rsiWilder(closes) : null;
  const vw = a.vwap ? vwapCumulative(candles) : null;
  if (a.json) {
    console.log(
      JSON.stringify({
        pair: a.pair.toUpperCase(),
        symbol,
        tf: a.tf.toLowerCase(),
        granularityMin: granMin,
        rsiPeriod: a.rsi ? KLINES_RSI_PERIOD : null,
        vwap: a.vwap,
        candles: candles.map((c, i) => ({
          tsMs: c.tsMs,
          time: new Date(c.tsMs).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          ...(a.rsi ? { rsi: rsi![i] === null ? null : Number(rsi![i]!.toFixed(2)) } : {}),
          ...(a.vwap ? { vwap: vw![i] === null ? null : vw![i] } : {}),
        })),
      }),
    );
    return;
  }
  console.log(`KLINES ${a.pair.toUpperCase()} ${a.tf.toLowerCase()} — ${candles.length} candles (${symbol}, read-only)`);
  candles.forEach((c, i) => {
    const t = new Date(c.tsMs).toISOString().replace("T", " ").slice(0, 19);
    let line = `${t}  O ${px(c.open)} H ${px(c.high)} L ${px(c.low)} C ${px(c.close)} V ${px(c.volume)}`;
    if (rsi && rsi[i] !== null && rsi[i] !== undefined) line += `  RSI ${rsi[i]!.toFixed(1)}`;
    if (vw && vw[i] !== null && vw[i] !== undefined) line += `  VWAP ${px(vw[i]!)}`;
    console.log(line);
  });
}
