/**
 * `jw3 insights` — READ-ONLY one-shot summary of the user's Insights page
 * (MCP `get_insights`). One call rolls up market regime (BTC/ETH, Fear &
 * Greed), cross-venue funding extremes, the fee-aware carry board, venue
 * volume share, the caller's own fee drag, headlines and a deterministic
 * brief.
 *
 * READ-ONLY means exactly that: no orders, no Diary writes, no signing. The
 * server lists every block it could not fill in `gaps`; this command renders
 * those as unknown rather than zero, and never derives a number the payload
 * did not carry. Formatting lives in pure helpers so it is testable without
 * a network or a PAT.
 */
import { callTool } from "../mcp.js";
import { fail, needPat } from "./market.js";

/** Documented default window when neither the flag nor the payload names one. */
const DEFAULT_DAYS = 30;

export type InsightsOpts = {
  days?: number;
  notionalUsd?: number;
  feeBps?: number;
  json: boolean;
  url?: string;
  pat?: string;
};

/** Null = usable; otherwise the human reason (caller exits 2, nothing called). */
export function validateInsightsArgs(o: {
  days?: number;
  notionalUsd?: number;
  feeBps?: number;
}): string | null {
  if (o.days !== undefined) {
    // The server rejects non-integers, so refuse them here — a bad day count
    // must cost no upstream fan-out.
    if (!Number.isFinite(o.days) || !Number.isInteger(o.days) || o.days < 1 || o.days > 90) {
      return "days must be an integer 1..90";
    }
  }
  if (o.notionalUsd !== undefined) {
    if (!Number.isFinite(o.notionalUsd) || o.notionalUsd <= 0) {
      return "notional-usd must be > 0";
    }
  }
  if (o.feeBps !== undefined) {
    if (!Number.isFinite(o.feeBps) || o.feeBps < 0 || o.feeBps > 100) {
      return "fee-bps must be 0..100";
    }
  }
  return null;
}

export type InsightsReport = {
  windowDays: number;
  observedAt: string | null;
  gaps: string[];
  btc: string;
  eth: string;
  fearGreed: string;
  fundingTop: string[];
  carryTop: string[];
  venueTop: string[];
  feesLine: string | null;
  newsTop: string[];
  brief: string;
};

/* ------------------------------------------------------------------ */
/* defensive payload readers (pure — unknown never becomes a number)    */
/* ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

/** First present (non-null, non-undefined) key. Missing reads as undefined. */
function pick(r: Rec, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** JSON numbers can arrive as numeric strings; nothing else passes. */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** Array payloads, or the usual `{ rows: [...] }` envelope. */
function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const r = asRec(v);
  if (!r) return [];
  const inner = pick(r, "rows", "items", "top", "extremes", "entries");
  return Array.isArray(inner) ? inner : [];
}

/**
 * Unwrap the common transport envelopes (`{ insights: … }`, `{ data: … }`)
 * one level at a time, stopping as soon as the object looks like the report.
 * A bare report with none of the known keys is returned as-is.
 */
function unwrapInsights(v: unknown): Rec | null {
  const known = [
    "windowDays", "window_days", "observedAt", "observed_at", "gaps", "btc", "eth",
    "market", "funding", "fundingTop", "funding_top", "carry", "carryTop", "carry_top",
    "venues", "venueTop", "venue_top", "fees", "feesLine", "fees_line",
    "news", "newsTop", "news_top", "brief",
  ];
  let cur = asRec(v);
  for (let depth = 0; depth < 3 && cur; depth++) {
    if (known.some((k) => cur !== null && cur[k] !== undefined)) return cur;
    const inner = asRec(pick(cur, "insights", "snapshot", "report", "data", "result"));
    if (!inner) return cur;
    cur = inner;
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* compact formatters (match the app's brief style)                    */
/* ------------------------------------------------------------------ */

/** $2.71T / $1.20B / $80.6K / $8.42 — compact, never a long decimal. */
function fmtUsd(v: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(v);
  const body =
    abs >= 1e12
      ? `${(abs / 1e12).toFixed(2)}T`
      : abs >= 1e9
        ? `${(abs / 1e9).toFixed(2)}B`
        : abs >= 1e6
          ? `${(abs / 1e6).toFixed(2)}M`
          : abs >= 1e3
            ? `${(abs / 1e3).toFixed(1)}K`
            : abs >= 1
              ? abs.toFixed(2)
              : abs.toPrecision(3);
  const sign = v < 0 ? "-" : opts.sign && v > 0 ? "+" : "";
  return `${sign}$${body}`;
}

/** Signed percent at readable width: +2.3%, -0.8%, +1.3k%. */
function fmtPct(v: number): string {
  const abs = Math.abs(v);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${body}%`;
}

/** A volume share is a level, not a delta — no leading plus. */
function fmtShare(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** `$80.6K (+2.3% 24h)`; a lone change renders honestly without a price. */
function assetValue(raw: unknown, sources: Rec[], prefix: string): string {
  const direct = asText(raw);
  if (direct) return direct;
  const own = asRec(raw);
  const cands = own ? [own, ...sources] : sources;
  let price: number | null = null;
  let change: number | null = null;
  for (const src of cands) {
    if (price == null) {
      price = asNum(pick(src, "price", "priceUsd", "price_usd", "last", "mark", "close"));
    }
    if (change == null) {
      change = asNum(
        pick(src, "change24hPct", "change_24h_pct", "change24h", "change_24h", "chg24h", "chg_24h_pct", "pct24h", "pct_24h"),
      );
    }
    if (price == null) {
      price = asNum(pick(src, `${prefix}Price`, `${prefix}_price`, `${prefix}PriceUsd`, `${prefix}_price_usd`));
    }
    if (change == null) {
      change = asNum(pick(src, `${prefix}Change24hPct`, `${prefix}_change_24h_pct`, `${prefix}Change24h`, `${prefix}_change_24h`));
    }
    if (price != null && change != null) break;
  }
  if (price == null && change == null) return "unknown";
  if (price == null) return `${fmtPct(change as number)} 24h`;
  return `${fmtUsd(price)}${change != null ? ` (${fmtPct(change)} 24h)` : ""}`;
}

/** `72 (greed)` from `{ value, classification }`, or a preformatted string. */
function fearGreedValue(raw: unknown): string {
  const direct = asText(raw);
  if (direct) return direct;
  const n = asNum(raw);
  if (n != null) return String(n);
  const r = asRec(raw);
  if (!r) return "unknown";
  const value = asNum(pick(r, "value", "score", "index"));
  const label = asText(pick(r, "classification", "label", "sentiment", "rating"));
  if (value != null && label) return `${value} (${label})`;
  if (value != null) return String(value);
  return label ?? "unknown";
}

/** Rows the server may already have formatted: use them verbatim. */
function preformattedRow(v: unknown): string | null {
  const direct = asText(v);
  if (direct) return direct;
  const r = asRec(v);
  if (!r) return null;
  return asText(pick(r, "line", "text", "summary"));
}

function formatFundingRow(v: unknown): string | null {
  const pre = preformattedRow(v);
  if (pre) return pre;
  const r = asRec(v);
  if (!r) return null;
  const asset = asText(pick(r, "asset", "symbol", "base", "pair"));
  const bestVenue = asText(pick(r, "bestVenue", "best_venue", "longVenue", "long_venue", "venue", "exchange"));
  const bestApr = asNum(
    pick(r, "bestAprPct", "best_apr_pct", "bestApr", "best_apr", "longAprPct", "long_apr_pct", "aprPct", "apr_pct", "apr"),
  );
  const worstVenue = asText(pick(r, "worstVenue", "worst_venue", "shortVenue", "short_venue"));
  const worstApr = asNum(pick(r, "worstAprPct", "worst_apr_pct", "worstApr", "worst_apr", "shortAprPct", "short_apr_pct"));
  const spread = asNum(pick(r, "spreadPct", "spread_pct", "spread"));
  const bestBit =
    bestVenue != null || bestApr != null
      ? `${bestVenue ?? "unknown venue"}${bestApr != null ? ` ${fmtPct(bestApr)} APR` : " APR unknown"}`
      : null;
  const worstBit =
    worstVenue != null || worstApr != null
      ? `${worstVenue ?? "unknown venue"}${worstApr != null ? ` ${fmtPct(worstApr)} APR` : " APR unknown"}`
      : null;
  const legs = bestBit && worstBit ? `${bestBit} vs ${worstBit}` : (bestBit ?? worstBit);
  if (!legs) return asset ? `${asset}: details unknown` : null;
  return `${asset ? `${asset}: ` : ""}${legs}${spread != null ? ` (spread ${fmtPct(spread)})` : ""}`;
}

function formatCarryRow(v: unknown): string | null {
  const pre = preformattedRow(v);
  if (pre) return pre;
  const r = asRec(v);
  if (!r) return null;
  const asset = asText(pick(r, "asset", "symbol", "base", "pair"));
  const longVenue = asText(pick(r, "longVenue", "long_venue", "longExchange", "long_exchange", "long"));
  const longApr = asNum(pick(r, "longAprPct", "long_apr_pct", "longApr", "long_apr"));
  const shortVenue = asText(pick(r, "shortVenue", "short_venue", "shortExchange", "short_exchange", "short"));
  const shortApr = asNum(pick(r, "shortAprPct", "short_apr_pct", "shortApr", "short_apr"));
  const gross = asNum(pick(r, "grossAprPct", "gross_apr_pct", "grossApr", "gross_apr"));
  const netApr = asNum(pick(r, "netAprPct", "net_apr_pct", "netApr", "net_apr"));
  const net30 = asNum(pick(r, "net30dUsd", "net_30d_usd", "netUsd", "net_usd", "net30d"));
  const breakeven = asNum(pick(r, "breakevenDays", "breakeven_days", "breakEvenDays", "break_even_days"));
  const bits: string[] = [];
  if (longVenue != null || longApr != null) {
    bits.push(`long ${longVenue ?? "unknown venue"}${longApr != null ? ` ${fmtPct(longApr)}` : ""}`);
  }
  if (shortVenue != null || shortApr != null) {
    bits.push(`short ${shortVenue ?? "unknown venue"}${shortApr != null ? ` ${fmtPct(shortApr)}` : ""}`);
  }
  let line = bits.join(" / ");
  if (netApr != null) line += `${line ? " → " : ""}net ${fmtPct(netApr)} APR`;
  else if (gross != null) line += `${line ? " → " : ""}gross ${fmtPct(gross)} APR`;
  if (net30 != null) line += `${line ? ", " : ""}${fmtUsd(net30, { sign: true })} per 30d`;
  if (breakeven != null) line += `${line ? ", " : ""}fees back in ${breakeven}d`;
  if (!line) return asset ? `${asset}: details unknown` : null;
  return asset ? `${asset}: ${line}` : line;
}

function formatVenueRow(v: unknown): string | null {
  const pre = preformattedRow(v);
  if (pre) return pre;
  const r = asRec(v);
  if (!r) return null;
  const venue = asText(pick(r, "venue", "exchange", "name", "label", "source"));
  const share = asNum(pick(r, "sharePct", "share_pct", "share", "pct"));
  const volume = asNum(
    pick(r, "volume24hUsd", "volume_24h_usd", "volumeUsd", "volume_usd", "volume24h", "volume"),
  );
  if (!venue && share == null && volume == null) return null;
  const parts: string[] = [];
  if (share != null) parts.push(fmtShare(share));
  if (volume != null) parts.push(`${fmtUsd(volume)} 24h vol`);
  const head = venue ?? "unknown venue";
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

/** Diary fee drag. A string/`line` is used as-is; missing fees stay unknown. */
function formatFeesLine(v: unknown, windowDays: number): string | null {
  if (v === undefined || v === null) return null;
  const direct = asText(v);
  if (direct) return direct;
  const r = asRec(v);
  if (!r) return null;
  const inline = asText(pick(r, "line", "text", "summary"));
  if (inline) return inline;
  const fees = asNum(pick(r, "totalFeesUsd", "total_fees_usd", "feesUsd", "fees_usd", "totalFees", "total_fees", "fees"));
  const gross = asNum(pick(r, "grossPnlUsd", "gross_pnl_usd", "grossPnl", "gross_pnl"));
  const net = asNum(pick(r, "netPnlUsd", "net_pnl_usd", "netPnl", "net_pnl"));
  const ratio = asNum(pick(r, "feeRatioPct", "fee_ratio_pct", "feeRatio", "fee_ratio"));
  const count = asNum(pick(r, "count", "trades", "closedTrades", "closed_trades", "closes"));
  const days = asNum(pick(r, "windowDays", "window_days", "days")) ?? windowDays;
  const dayText = Number.isFinite(days) && days > 0 ? `${Math.trunc(days)}d` : `${windowDays}d`;
  if (count === 0) return `no closed trades in the ${dayText} window`;
  const bits: string[] = [];
  if (fees != null) bits.push(`${fmtUsd(fees)} fees`);
  if (gross != null) bits.push(`${fmtUsd(gross, { sign: true })} gross`);
  if (net != null) bits.push(`${fmtUsd(net, { sign: true })} net`);
  if (bits.length === 0) return null;
  const tail: string[] = [];
  if (count != null && count > 0) tail.push(`${Math.trunc(count)} closes`);
  if (ratio != null) tail.push(`fees ${ratio.toFixed(1)}% of gross`);
  return `${bits.join(", ")} over ${dayText}${tail.length > 0 ? ` (${tail.join(", ")})` : ""}`;
}

function formatNewsRow(v: unknown): string | null {
  const direct = asText(v);
  if (direct) return direct;
  const r = asRec(v);
  if (!r) return null;
  const title = asText(pick(r, "title", "headline", "name", "text"));
  if (!title) return null;
  const source = asText(pick(r, "source", "publisher", "venue", "origin"));
  return source ? `${title} — ${source}` : title;
}

/** Strings, or `{ block|field, reason|detail }` objects the server may emit. */
function gapLines(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asText(item);
    if (s) {
      out.push(s);
      continue;
    }
    const r = asRec(item);
    if (!r) continue;
    const what = asText(pick(r, "block", "field", "name", "gap", "source"));
    const why = asText(pick(r, "reason", "detail", "message", "note", "error"));
    const line = what && why ? `${what}: ${why}` : (what ?? why);
    if (line) out.push(line);
  }
  return out;
}

function mapRows(v: unknown, format: (row: unknown) => string | null): string[] {
  const out: string[] = [];
  for (const row of asList(v)) {
    const line = format(row);
    if (line) out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* report assembly + rendering (pure)                                  */
/* ------------------------------------------------------------------ */

/**
 * Pure: shape the get_insights payload into a display report. Every reader is
 * defensive — a missing block is `unknown`/empty, never a made-up zero — and
 * `brief` is carried verbatim (the server's deterministic fallback already
 * states only real numbers).
 */
export function summarizeInsights(payload: unknown, fallbackDays: number): InsightsReport {
  const fallback =
    Number.isFinite(fallbackDays) && fallbackDays > 0 ? Math.trunc(fallbackDays) : DEFAULT_DAYS;

  let raw: unknown = payload;
  // callTool normally parses once; a string payload can still arrive if the
  // server answered with plain text. Parse it, never treat it as data.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      raw = null;
    }
  }
  const root = unwrapInsights(raw);
  if (!root) {
    return {
      windowDays: fallback,
      observedAt: null,
      gaps: [],
      btc: "unknown",
      eth: "unknown",
      fearGreed: "unknown",
      fundingTop: [],
      carryTop: [],
      venueTop: [],
      feesLine: null,
      newsTop: [],
      brief: "",
    };
  }

  const payloadDays = asNum(pick(root, "windowDays", "window_days", "days", "lookbackDays", "lookback_days"));
  const windowDays = payloadDays != null && payloadDays > 0 ? Math.trunc(payloadDays) : fallback;

  const market = asRec(pick(root, "market", "regime", "macro"));
  const marketSrc = market ?? root;
  const sources = market ? [market, root] : [root];
  // The market block nests the per-asset objects (`market.btc`), while the
  // flat shape puts them on the root — accept either without inventing one.
  const btcMarket = asRec(pick(marketSrc, "btc", "BTC"));
  const ethMarket = asRec(pick(marketSrc, "eth", "ETH"));

  const briefRaw = pick(root, "brief", "briefText", "brief_text", "deterministicBrief", "deterministic_brief");

  // Prefer the first candidate that actually yielded a value: an empty flat
  // block must not shadow a populated nested one.
  const firstKnown = (...values: string[]): string => values.find((v) => v !== "unknown" && v.trim() !== "") ?? "unknown";
  const btc = firstKnown(
    assetValue(pick(root, "btc", "BTC"), sources, "btc"),
    assetValue(btcMarket, sources, "btc"),
  );
  const eth = firstKnown(
    assetValue(pick(root, "eth", "ETH"), sources, "eth"),
    assetValue(ethMarket, sources, "eth"),
  );
  const fearGreed = firstKnown(
    fearGreedValue(pick(root, "fearGreed", "fear_greed")),
    fearGreedValue(pick(marketSrc, "fear_greed", "fearGreed")),
  );

  return {
    windowDays,
    observedAt: asText(pick(root, "observedAt", "observed_at", "asOf", "as_of", "generatedAt", "generated_at")),
    gaps: gapLines(pick(root, "gaps", "coverageGaps", "coverage_gaps")),
    btc,
    eth,
    fearGreed,
    fundingTop: mapRows(pick(root, "fundingTop", "funding_top", "funding", "fundingExtremes", "funding_extremes"), formatFundingRow),
    carryTop: mapRows(pick(root, "carryTop", "carry_top", "carry", "carryBoard", "carry_board"), formatCarryRow),
    venueTop: mapRows(pick(root, "venueTop", "venue_top", "venues", "venueShare", "venue_share"), formatVenueRow),
    feesLine: formatFeesLine(
      pick(root, "feesLine", "fees_line", "feeLine", "fee_line") ?? pick(root, "fees", "feeSummary", "fee_summary"),
      windowDays,
    ),
    newsTop: mapRows(pick(root, "newsTop", "news_top", "news", "headlines"), formatNewsRow),
    brief: typeof briefRaw === "string" ? briefRaw : "",
  };
}

/** Avoid `BTC: BTC $80.6K` when the payload already labelled its value. */
function labelled(label: string, value: string): string {
  const v = value.trim();
  if (!v) return `${label}: unknown`;
  return v.toLowerCase().startsWith(label.toLowerCase()) ? v : `${label}: ${v}`;
}

function pushSection(lines: string[], title: string, rows: string[]): void {
  lines.push(`${title}:`);
  if (rows.length === 0) {
    lines.push("  unknown");
    return;
  }
  rows.forEach((row, i) => lines.push(`  ${i + 1}. ${row}`));
}

/** Multi-line plain text, no tables — reads well in a terminal. */
export function formatInsights(r: InsightsReport): string {
  const lines: string[] = [];
  lines.push(
    `Insights — ${r.windowDays}d window, ${
      r.observedAt ? `observed ${r.observedAt}` : "observed time unknown"
    }`,
  );
  lines.push(labelled("BTC", r.btc));
  lines.push(labelled("ETH", r.eth));
  lines.push(labelled("Fear & Greed", r.fearGreed));
  pushSection(lines, "Funding extremes", r.fundingTop);
  pushSection(lines, "Carry board", r.carryTop);
  pushSection(lines, "Venue share", r.venueTop);
  lines.push(`Fees: ${r.feesLine ?? "unknown"}`);
  pushSection(lines, "Headlines", r.newsTop);
  lines.push(`Gaps: ${r.gaps.length > 0 ? r.gaps.join("; ") : "none reported"}`);
  if (r.brief.trim()) {
    lines.push("Brief:");
    lines.push(r.brief);
  } else {
    lines.push("Brief: unknown");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* command entry                                                       */
/* ------------------------------------------------------------------ */

export async function cmdInsights(opts: InsightsOpts): Promise<void> {
  const pat = needPat(opts.pat);
  if (!pat) return;
  const bad = validateInsightsArgs({
    days: opts.days,
    notionalUsd: opts.notionalUsd,
    feeBps: opts.feeBps,
  });
  if (bad) {
    console.error(`Bad insights read: ${bad} — nothing was called.`);
    process.exitCode = 2;
    return;
  }
  // Send ONLY the narrower values the caller set; the server owns the
  // documented defaults (30 days / $10,000 / 5 bps).
  const args: Record<string, unknown> = {};
  if (opts.days !== undefined) args.days = opts.days;
  if (opts.notionalUsd !== undefined) args.notional_usd = opts.notionalUsd;
  if (opts.feeBps !== undefined) args.fee_bps = opts.feeBps;
  try {
    const payload = await callTool("get_insights", args, pat, opts.url);
    if (opts.json) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log(formatInsights(summarizeInsights(payload, opts.days ?? DEFAULT_DAYS)));
  } catch (e) {
    fail(e);
  }
}
