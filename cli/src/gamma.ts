/**
 * Polymarket public reads — same Gamma/CLOB upstream the
 * polymarket-proxy edge function fronts. Keyless; used for the
 * unauthenticated `markets ending` list and for assembling the
 * JEV prediction snapshot (prices, book, history tail, brief).
 */
import { isCompetitive, isDecided, rankCompare } from "./math.js";
import { fetchJson as httpJson } from "./http.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

export type GammaMarketVersion = 1 | 2;

export type EndingMarket = {
  question: string;
  slug: string;
  conditionId: string;
  endDate: string;
  days: number;
  outcomes: string[];
  prices: number[];
  /** Version-selected ids: v1 = clobTokenIds entry, v2 = positionIds entry. */
  tokenIds: string[];
  /** Approval/signing family: 1 = CTF/Neg-Risk, 2 = Exchange V3. */
  version: GammaMarketVersion;
  liquidity: number;
  volume: number;
  volume24h: number;
  active: boolean;
  closed: boolean;
};

export type Level = { price: number; size: number };
export type HistoryPoint = { t: string; p: number };

async function fetchJson(url: string, timeoutMs = 20000): Promise<unknown> {
  return httpJson(url, {}, { timeoutMs });
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown;
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function numArray(v: unknown): number[] {
  return strArray(v).map(Number).filter(Number.isFinite);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** CTF token / V2 position ids are decimal strings. */
const DECIMAL_ID = /^\d+$/;

/**
 * Gamma `version` → approval/signing family. Unversioned legacy defaults
 * to 1 (pre-migration markets); anything outside v1/v2 (string or
 * numeric) returns NaN so the caller drops the market.
 */
export function marketVersionOf(m: Record<string, unknown>): number {
  const v = m.version;
  if (v === "v2" || v === 2) return 2;
  if (v === "v1" || v === 1) return 1;
  if (v == null || v === "") return 1;
  return Number.NaN;
}

/**
 * Version-gated id selection: v2 reads `positionIds`, v1 reads
 * `clobTokenIds` (JSON string or array — the other field is ignored even
 * when present).
 */
export function versionedTokenIds(m: Record<string, unknown>, version: GammaMarketVersion): string[] {
  const field = version === 2 ? "positionIds" : "clobTokenIds";
  return strArray(m[field]);
}

export function normalizeGamma(m: Record<string, unknown>, nowMs: number): EndingMarket | null {
  const endRaw = m.endDate ?? m.endDateIso;
  if (!endRaw) return null;
  const end = new Date(String(endRaw));
  if (Number.isNaN(end.getTime())) return null;
  const outcomes = strArray(m.outcomes);
  const prices = numArray(m.outcomePrices);
  if (outcomes.length < 2 || prices.length < 2) return null;
  // Version-gated id selection (mirrors usePolymarket.ts marketVersionOf +
  // versionedTokenIds and poly-v2.ts selectMarketTokenIds): v2 reads
  // `positionIds`, v1 (and unversioned legacy) reads `clobTokenIds` — the
  // other field is ignored even when present. Anything outside v1/v2
  // rejects the market.
  const version = marketVersionOf(m);
  if (version !== 1 && version !== 2) return null;
  const tokenIds = versionedTokenIds(m, version as GammaMarketVersion);
  if (tokenIds.length === 0 || tokenIds.length !== outcomes.length) return null;
  if (tokenIds.some((t) => !DECIMAL_ID.test(t))) return null;
  return {
    question: String(m.question ?? m.title ?? ""),
    slug: String(m.slug ?? ""),
    conditionId: String(m.conditionId ?? ""),
    endDate: end.toISOString(),
    days: (end.getTime() - nowMs) / 86400000,
    outcomes,
    prices,
    tokenIds,
    version: version as GammaMarketVersion,
    liquidity: num(m.liquidityNum ?? m.liquidity),
    volume: num(m.volumeNum ?? m.volume),
    volume24h: num(m.volume24hr),
    active: m.active == null ? true : Boolean(m.active),
    closed: Boolean(m.closed),
  };
}

export type EndingFilter = { days: number; minLiq: number; limit: number };

export async function fetchEndingMarkets(filter: EndingFilter): Promise<EndingMarket[]> {
  const qs = new URLSearchParams({
    limit: "200",
    active: "true",
    closed: "false",
    order: "volume24hr",
    ascending: "false",
  });
  const raw = (await fetchJson(`${GAMMA}/markets?${qs}`)) as unknown;
  if (!Array.isArray(raw)) throw new Error("unexpected Gamma response");
  const now = Date.now();
  const rows: EndingMarket[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const r = normalizeGamma(m, now);
    if (!r) continue;
    if (r.days < 0 || r.days > filter.days) continue;
    if (r.liquidity < filter.minLiq) continue;
    if (!r.tokenIds.length || r.tokenIds.some((t) => !t)) continue;
    rows.push(r);
  }
  rows.sort((a, b) =>
    rankCompare(
      { liq: a.liquidity, days: a.days, competitive: isCompetitive(a.prices), decided: isDecided(a.prices) },
      { liq: b.liquidity, days: b.days, competitive: isCompetitive(b.prices), decided: isDecided(b.prices) },
    ),
  );
  return rows.slice(0, filter.limit);
}

export async function fetchMarketDetail(id: string): Promise<EndingMarket> {
  const now = Date.now();
  const tries: string[] = [];
  if (id.startsWith("0x")) tries.push(`${GAMMA}/markets?condition_ids=${encodeURIComponent(id)}&limit=1`);
  else if (/^\d+$/.test(id)) tries.push(`${GAMMA}/markets/${encodeURIComponent(id)}`);
  tries.push(`${GAMMA}/markets?slug=${encodeURIComponent(id)}&limit=1`);
  tries.push(`${GAMMA}/markets/${encodeURIComponent(id)}`);
  for (const url of tries) {
    try {
      const raw = await fetchJson(url);
      const m = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object") continue;
      const r = normalizeGamma(m, now);
      if (r) return r;
    } catch {
      // try next resolution path
    }
  }
  throw new Error(`market not found: ${id}`);
}

export async function fetchBook(tokenId: string): Promise<{ bids: Level[]; asks: Level[] }> {
  try {
    const raw = (await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`)) as {
      bids?: { price: string; size: string }[];
      asks?: { price: string; size: string }[];
    };
    const lvl = (rows: { price: string; size: string }[] | undefined): Level[] =>
      (rows ?? [])
        .map((r) => ({ price: Number(r.price), size: Number(r.size) }))
        .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.size))
        .slice(0, 8);
    return { bids: lvl(raw.bids), asks: lvl(raw.asks) };
  } catch {
    return { bids: [], asks: [] };
  }
}

export async function fetchHistoryTail(tokenId: string): Promise<HistoryPoint[]> {
  try {
    const raw = (await fetchJson(
      `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&interval=1d&fidelity=60`,
    )) as { history?: { t: number; p: number }[] } | { t: number; p: number }[];
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.history) ? raw.history : [];
    return arr.slice(-30).map((p) => ({
      t: new Date((p.t ?? 0) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      p: Number(p.p ?? 0),
    }));
  } catch {
    return [];
  }
}
