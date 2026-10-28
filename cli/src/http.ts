/**
 * Shared HTTP layer for every outbound fetch in the CLI.
 *
 * Connection reuse audit (2026-10-14): Node 20+ `fetch` is Undici with a
 * global Agent that pools TCP+TLS and keeps sockets alive by default — so
 * the win is NOT a custom agent, it is routing EVERY request through this
 * one module (one UA, one timeout idiom, one retry discipline) instead of
 * N ad-hoc `fetch` calls with divergent headers/timeouts. kucoin.ts,
 * gamma.ts, mcp.ts and the kucoin-ws bullet bootstrap all call into here.
 *
 * Backoff discipline:
 * - 429 → honor `Retry-After` (seconds or HTTP-date), else exponential
 *   backoff with jitter. 429 means "not processed, slow down" — safe to
 *   retry reads AND the single bullet bootstrap.
 * - 5xx / network error → bounded retry (reads only; fund-moving MCP
 *   tools never auto-retry — see mcp.ts NO_RETRY_TOOLS; an ambiguous
 *   order is reconciled via list/query, never re-fired blind).
 * - Anything else (4xx, bad body) → throw immediately, no retry.
 * - Every attempt has its own timeout; total cost is bounded by
 *   `attempts × (timeoutMs + max backoff)`.
 */

export const JW3_UA = "jw3-cli/0.1";

/**
 * Pure: redact bearer-like substrings before logging/errors. Covers
 * `jw3_mcp_...` secrets, `Bearer <token>` header echoes, and JSON
 * `access_token` values. Structure-preserving (still valid JSON) so
 * envelope detection on scrubbed bodies keeps working.
 */
export function scrubBearer(s: string): string {
  return s
    .replace(/jw3_mcp_[A-Za-z0-9_-]+/g, "jw3_mcp_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_.~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/("access_token"\s*:\s*")[^"]*(")/g, "$1[REDACTED]$2");
}

/** Thrown for non-OK HTTP after retries are exhausted (or not applicable). */
export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, url: string) {
    super(`upstream ${status} on ${scrubBearer(url)}${body ? `: ${scrubBearer(body).slice(0, 160)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = scrubBearer(body);
  }
}

/** 429 and 5xx are transient; everything else fails fast. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Pure: exponential backoff with full jitter for attempt `n` (1-based).
 * base 500ms → waits ≈ 0–500ms, 0–1000ms, 0–2000ms … capped at 10s.
 * `rand` is injectable so tests assert bounds deterministically.
 */
export function backoffMs(n: number, baseMs = 500, rand: () => number = Math.random): number {
  const cap = Math.min(10_000, baseMs * 2 ** Math.max(0, n - 1));
  return Math.floor(rand() * cap);
}

/**
 * Pure: `Retry-After` value → ms to wait. Numeric = seconds; otherwise a
 * HTTP-date (past dates → 0). Null when the header is absent/unparseable —
 * the caller falls back to backoffMs.
 */
export function parseRetryAfterMs(v: string | null, nowMs: number = Date.now()): number | null {
  if (v == null || v.trim() === "") return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - nowMs);
}

export type FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; headers: { get: (k: string) => string | null }; text: () => Promise<string> }>;

const globalFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    status: r.status,
    ok: r.ok,
    headers: { get: (k: string) => r.headers.get(k) },
    text: () => r.text(),
  }));

export type RetryOpts = {
  attempts?: number;
  baseMs?: number;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  sleepMs?: (ms: number) => Promise<void>;
  rand?: () => number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * GET/POST with timeout + bounded retry. Returns the raw text on 2xx;
 * throws HttpError otherwise. POST callers with ambiguous-failure costs
 * (orders) must NOT use this — they go through mcp.ts, which retries
 * 429 only for reads and never for fund-moving tools.
 */
export async function fetchText(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  opts: RetryOpts = {},
): Promise<string> {
  const attempts = Math.min(Math.max(opts.attempts ?? 3, 1), 6);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const baseMs = opts.baseMs ?? 500;
  const doFetch = opts.fetchFn ?? globalFetch;
  const sleep = opts.sleepMs ?? defaultSleep;
  const rand = opts.rand ?? Math.random;
  let lastErr: unknown = null;
  for (let n = 1; n <= attempts; n++) {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e; // network error / timeout — transient
      if (n < attempts) await sleep(backoffMs(n, baseMs, rand));
      continue;
    }
    if (res.ok) return await res.text();
    if (isRetryableStatus(res.status) && n < attempts) {
      const wait =
        res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
      await sleep(wait ?? backoffMs(n, baseMs, rand));
      lastErr = new HttpError(res.status, await safeText(res), url);
      continue;
    }
    throw new HttpError(res.status, await safeText(res), url);
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(0, String(lastErr ?? ""), url);
}

async function safeText(res: Awaited<ReturnType<FetchLike>>): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** JSON GET/POST convenience over fetchText (same retry discipline). */
export async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  opts: RetryOpts = {},
): Promise<unknown> {
  const text = await fetchText(
    url,
    {
      ...init,
      headers: { "User-Agent": JW3_UA, Accept: "application/json", ...(init.headers ?? {}) },
    },
    opts,
  );
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new HttpError(200, "non-JSON response", hostOf(url));
  }
}

/**
 * Bounded-concurrency fan-out for read bursts (spikes snapshots, kline
 * pages). Promise.all over 9 symbols × 2 requests is a 429 magnet;
 * `concurrency` caps in-flight workers while keeping results ordered.
 * Pure scheduling — worker errors reject (callers decide catch vs fail).
 */
export async function mapPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 3,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(concurrency));
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => run()));
  return out;
}
