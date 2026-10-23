/**
 * KuCoin futures public WS ticker client (no auth) — tickerV2 push.
 *
 * Wire facts (official docs + live probe 2026-10-14, XBTUSDTM):
 *   Bootstrap (public, no auth):
 *     POST https://api-futures.kucoin.com/api/v1/bullet-public
 *       → { code, data: { token, instanceServers: [{ endpoint, pingInterval,
 *           pingTimeout }] } }
 *       → connect `wss://<endpoint>?token=<token>`.
 *     The socket URL is minted per session — there is NO static URL.
 *     Token TTL 24h; this client mints fresh per connection.
 *     Docs: kucoin.com/docs-new/websocket-api/base-info/get-public-token-futures
 *     (api-channel Public, permission NULL, weight 10).
 *
 *   Subscription (one topic per frame, sent after open):
 *     {"id":…,"type":"subscribe","topic":"/contractMarket/tickerV2:<SYM>",
 *      "response":true}
 *     Contract shape is `<BASE>USDTM` (BTC is `XBTUSDTM`).
 *     Docs: kucoin.com/docs-new/3470080w0 (tickerV2 recommended;
 *     tickerV1 3470081w0 is deprecated and trade-triggered — live probe
 *     showed V1 acked but pushed ZERO frames while V2 pushed ~5 in 2s).
 *
 *   Live wire (tickerV2 `subject: "tickerV2"`):
 *     {topic, type:"message", subject:"tickerV2", sn,
 *      data:{symbol, sequence, bestBidSize, bestBidPrice, bestAskPrice,
 *            bestAskSize, ts}}
 *     `ts` is NANOSECONDS (venue-epoch) — divide by 1e6 for ms. Prices and
 *     sizes arrive as STRINGS/numbers mixed; coerced once here, unparseable
 *     rows are DROPPED (never 0 — 0 size would mean "delete this level").
 *     sn/sequence are NOT guaranteed continuous (shared with the level2
 *     topic; gaps are normal) — so this client never gap-detects, it just
 *     takes the latest touch as the mark.
 *
 *   Keepalive is client-driven: the server NEVER pings. Send
 *   `{"id":…,"type":"ping"}` inside the bullet `pingInterval` (18s) and
 *   expect `{"type":"pong"}`. `welcome`/`ack`/`pong`/`error` control frames
 *   prove life but carry no market data.
 *
 * NON-CUSTODIAL: public market data only. No key, no signature, no order
 * operation — nothing here may ever carry credentials.
 */
import { fetchJson } from "./http.js";

export const FUTURES_BULLET_URL = "https://api-futures.kucoin.com/api/v1/bullet-public";

/** Bullet tokens expire after 24h — long feeds re-bootstrap before then. */
export const FUTURES_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

/** Re-bootstrap an hour before expiry so rotation never races the deadline. */
export const FUTURES_REBOOTSTRAP_MS = 23 * 60 * 60 * 1_000;

/** Default keepalive when the bullet omits the cadence (venue sends 18s). */
export const FUTURES_PING_INTERVAL_MS = 18_000;

/** A tick is stale for trail purposes after twice the 3s REST poll cadence. */
export const FUTURES_TICK_STALE_MS = 6_000;

/**
 * Intra-poll live gap slice (ms): while the trail loop waits out its 3s
 * REST cadence, a live feed is checked on this slice so an armed stop
 * trips on the first WS touch past it instead of the next poll boundary.
 */
export const TRAIL_LIVE_GAP_MS = 250;

/** The slice of a futures bullet-public reply the client actually needs. */
export type FuturesBullet = {
  token: string;
  endpoint: string;
  /** Server's keepalive cadence in ms (18s). Absent when the venue omits it. */
  pingInterval?: number;
  /** Pong deadline in ms (10s). Absent when the venue omits it. */
  pingTimeout?: number;
};

/**
 * Parse a futures bullet-public reply
 * (`{code, data: {token, instanceServers: […]}}`). Null when there is no
 * usable token + endpoint — a half-parsed bootstrap must never produce a
 * plausible-looking dead URL.
 */
export function parseFuturesBullet(payload: unknown): FuturesBullet | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const token = typeof d.token === "string" ? d.token : "";
  const servers = Array.isArray(d.instanceServers) ? d.instanceServers : [];
  const first = servers[0] as Record<string, unknown> | undefined;
  const endpoint = first && typeof first.endpoint === "string" ? first.endpoint : "";
  if (!token || !endpoint) return null;
  const out: FuturesBullet = { token, endpoint };
  if (typeof first?.pingInterval === "number") out.pingInterval = first.pingInterval;
  if (typeof first?.pingTimeout === "number") out.pingTimeout = first.pingTimeout;
  return out;
}

/**
 * The session socket URL: `<endpoint>?token=<token>`.
 * Endpoints arrive as `wss://…` without a query string; the token is
 * appended unless the endpoint already carries one.
 */
export function futuresConnectUrl(bullet: FuturesBullet): string {
  const endpoint = bullet.endpoint.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const sep = endpoint.includes("?") ? (endpoint.endsWith("?") || endpoint.endsWith("&") ? "" : "&") : "?";
  if (/([?&])token=/.test(endpoint)) return endpoint;
  return `${endpoint}${sep}token=${encodeURIComponent(bullet.token)}`;
}

/**
 * Pair/base/contract → futures contract (`<BASE>USDTM`).
 * Accepts "SOL/USDT", "SOL-USDT", "SOLUSDT", "SOL", "SOLUSDTM" (any case);
 * BTC is an alias of XBT (the venue lists `XBTUSDTM`). Null when the input
 * carries no usable base — never guess a contract.
 */
export function futuresContract(input: string): string | null {
  const s = String(input ?? "").toUpperCase().replace(/[-_\s/]/g, "");
  if (!s) return null;
  let base = s;
  if (base.endsWith("USDTM")) base = base.slice(0, -5);
  else if (base.endsWith("USDT")) base = base.slice(0, -4);
  else if (base.endsWith("USDM")) base = base.slice(0, -4);
  if (!base || /[^A-Z0-9]/.test(base)) return null;
  if (base === "BTC") base = "XBT";
  return `${base}USDTM`;
}

/** The tickerV2 topic for a contract. */
export function futuresTickerV2Topic(contract: string): string {
  return `/contractMarket/tickerV2:${contract}`;
}

/** The SUBSCRIBE frame for a contract's tickerV2 push. */
export function futuresSubscribeFrame(contract: string, id = `jw3-tick-${contract}`): string {
  return JSON.stringify({
    id,
    type: "subscribe",
    topic: futuresTickerV2Topic(contract),
    response: true,
  });
}

/** Client keepalive: the server never pings, so WE ping and expect a pong. */
export function futuresPingFrame(id = "jw3-ping"): string {
  return JSON.stringify({ id, type: "ping" });
}

/**
 * True when a decoded text frame is socket housekeeping, not market data:
 * `welcome` (greeting), `ack` (subscribe confirmed), `pong` (keepalive
 * reply), `error` (rejected request). Data frames always carry a `topic`;
 * control frames never do.
 */
export function futuresIsControlFrame(text: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return false;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.topic === "string") return false;
  return m.type === "welcome" || m.type === "ack" || m.type === "pong" || m.type === "error";
}

/** One parsed tickerV2 touch: NUMERIC touch, mid derived, times in ms. */
export type FuturesTick = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  /** (bid + ask) / 2 — the mark the trail engine polls. */
  mid: number;
  bidSize: number;
  askSize: number;
  /** Venue sequence (NOT guaranteed continuous — never gap-detect on it). */
  seq: number;
  /** Venue event time in ms (ns `ts` / 1e6). */
  tsMs: number;
  /** Local arrival time in ms (Date.now at parse). */
  recvMs: number;
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Parse one tickerV2 message frame (object or JSON text). Null for control
 * frames, foreign topics, or touches whose bid/ask will not coerce — a
 * malformed touch is dropped, never zeroed into a fake mark.
 */
export function parseFuturesTickerV2(msg: unknown, recvMs = Date.now()): FuturesTick | null {
  let m: unknown = msg;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.topic !== "string" || !o.topic.startsWith("/contractMarket/tickerV2:")) return null;
  const data = o.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const bestBid = num(d.bestBidPrice);
  const bestAsk = num(d.bestAskPrice);
  if (!(bestBid > 0) || !(bestAsk > 0)) return null;
  const symbol = typeof d.symbol === "string" && d.symbol ? d.symbol : String(o.topic).split(":")[1] ?? "";
  const rawTs = num((d as Record<string, unknown>).ts);
  return {
    symbol,
    bestBid,
    bestAsk,
    mid: (bestBid + bestAsk) / 2,
    bidSize: num(d.bestBidSize),
    askSize: num(d.bestAskSize),
    seq: num(d.sequence ?? o.sn),
    tsMs: Number.isFinite(rawTs) ? Math.round(rawTs / 1_000_000) : recvMs,
    recvMs,
  };
}

/** Minimal fetch surface so tests inject a stub instead of the network. */
export type BulletFetch = (url: string, init: { method: string }) => Promise<{ json: () => Promise<unknown> }>;

/** Minimal socket surface (global WebSocket satisfies it). */
export type WsLike = {
  send: (data: string) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
};

/**
 * Mint a session socket URL via the futures bullet-public bootstrap
 * (POST, no auth). Null when the reply has no usable token + endpoint —
 * the caller retries with backoff rather than opening a dead socket.
 */
export async function resolveFuturesUrl(fetchFn: BulletFetch): Promise<string | null> {
  try {
    const res = await fetchFn(FUTURES_BULLET_URL, { method: "POST" });
    const parsed = parseFuturesBullet(await res.json());
    return parsed ? futuresConnectUrl(parsed) : null;
  } catch {
    return null;
  }
}

/** A running tickerV2 push: latest touch, count, age, close. */
export type LiveMarkFeed = {
  contract: string;
  /** Latest parsed touch, or null before the first tick. */
  latest: () => FuturesTick | null;
  /** Ticks parsed so far (proves the feed is live, not just open). */
  count: () => number;
  /** ms since the last tick (Infinity before the first). */
  ageMs: () => number;
  close: () => void;
};

/**
 * Open one tickerV2 push for a contract and keep the latest touch.
 * Resolves once the socket is OPEN + subscribed (ticks arrive after);
 * rejects when the bootstrap yields no URL or the socket fails to open.
 * The caller MUST close() the feed (no dangling sockets past the run).
 */
export async function openLiveMarkFeed(
  contract: string,
  deps?: {
    fetchFn?: BulletFetch;
    wsCtor?: (url: string) => WsLike;
    openTimeoutMs?: number;
    pingIntervalMs?: number;
  },
): Promise<LiveMarkFeed> {
  const fetchFn: BulletFetch =
    deps?.fetchFn ??
    ((url: string, init: { method: string }) =>
      fetchJson(url, { method: init.method }, {}).then((json: unknown) => ({ json: () => Promise.resolve(json) })));
  const url = await resolveFuturesUrl(fetchFn);
  if (!url) throw new Error(`no futures bullet for ${contract} — bootstrap empty, retry`);
  const ctor =
    deps?.wsCtor ??
    ((u: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(u));
  const openTimeoutMs = deps?.openTimeoutMs ?? 15_000;
  const pingMs = deps?.pingIntervalMs ?? FUTURES_PING_INTERVAL_MS;

  return await new Promise<LiveMarkFeed>((resolve, reject) => {
    let settled = false;
    let latest: FuturesTick | null = null;
    let n = 0;
    let ws: WsLike;
    try {
      ws = ctor(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          // Already dead — the timeout is the verdict.
        }
        reject(new Error(`futures WS for ${contract} did not open in ${openTimeoutMs}ms`));
      }
    }, openTimeoutMs);
    let pinger: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.send(futuresSubscribeFrame(contract));
      } catch {
        // Send failure surfaces as ticks never arriving (age grows).
      }
      pinger = setInterval(() => {
        try {
          ws.send(futuresPingFrame());
        } catch {
          // A dead socket stops ticking; the age check reports it.
        }
      }, pingMs);
      // Unref the keepalive so a forgotten feed never pins the process.
      const unref = (pinger as unknown as { unref?: () => void }).unref;
      if (typeof unref === "function") unref.call(pinger);
      resolve({
        contract,
        latest: () => latest,
        count: () => n,
        ageMs: () => (latest ? Date.now() - latest.recvMs : Number.POSITIVE_INFINITY),
        close: () => {
          clearInterval(pinger);
          try {
            ws.close();
          } catch {
            // Close is best-effort; the socket is gone either way.
          }
        },
      });
    };
    ws.onmessage = (ev: { data: unknown }) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
      if (!text || futuresIsControlFrame(text)) return;
      const t = parseFuturesTickerV2(text);
      if (!t) return;
      // One contract per socket — a foreign symbol is never our mark.
      if (t.symbol && t.symbol !== contract) return;
      latest = t;
      n++;
    };
    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`futures WS for ${contract} failed to open`));
      }
      // Post-open errors: ticks stop, age grows, callers fall back to REST.
    };
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`futures WS for ${contract} closed before open`));
      }
    };
    void pingMs;
  });
}

export type TickSample = {
  n: number;
  /** Ticks parsed inside the window. */
  firstMs: number | null;
  lastMs: number | null;
  /** Mean inter-arrival ms between consecutive ticks (null when < 2). */
  meanGapMs: number | null;
  mids: number[];
};

/**
 * Stream a contract's tickerV2 push for `seconds` and collect touches.
 * Returns the samples plus the REST baseline read so the caller can print
 * push-rate vs one REST round trip from the same process. Read-only.
 */
export async function streamFuturesTicks(
  contract: string,
  seconds: number,
  onTick: (t: FuturesTick, i: number) => void,
  deps?: {
    fetchFn?: BulletFetch;
    wsCtor?: (url: string) => WsLike;
    restMark?: (contract: string) => Promise<{ mid: number; ms: number }>;
    sleepMs?: (ms: number) => Promise<void>;
  },
): Promise<{ ticks: TickSample; restMs: number | null; restMid: number | null }> {
  const feed = await openLiveMarkFeed(contract, deps);
  const sleep = deps?.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const arrivals: number[] = [];
  const mids: number[] = [];
  let last: FuturesTick | null = null;
  const stopAt = Date.now() + Math.max(1, seconds) * 1000;
  try {
    let i = 0;
    while (Date.now() < stopAt) {
      const cur = feed.latest();
      if (cur && cur !== last) {
        last = cur;
        i++;
        arrivals.push(cur.recvMs);
        mids.push(cur.mid);
        onTick(cur, i);
      }
      await sleep(50);
    }
  } finally {
    feed.close();
  }
  const gaps: number[] = [];
  for (let k = 1; k < arrivals.length; k++) {
    gaps.push((arrivals[k] as number) - (arrivals[k - 1] as number));
  }
  const ticks: TickSample = {
    n: arrivals.length,
    firstMs: arrivals.length > 0 ? (arrivals[0] as number) : null,
    lastMs: arrivals.length > 0 ? (arrivals[arrivals.length - 1] as number) : null,
    meanGapMs: gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    mids,
  };
  let restMs: number | null = null;
  let restMid: number | null = null;
  if (deps?.restMark) {
    try {
      const r = await deps.restMark(contract);
      restMs = r.ms;
      restMid = r.mid;
    } catch {
      // REST baseline is advisory — a failed baseline never fails the stream.
    }
  }
  return { ticks, restMs, restMid };
}
