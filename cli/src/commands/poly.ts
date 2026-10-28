/**
 * `poly scan` — read-only. Live short-horizon Polymarket windows
 * (BTC 15m, ETH/SOL hourly + daily): nearest-future events per series
 * with volume + outcome prices. The 5m series (10684/10683/10686) are
 * dead shells (vol 0) — this scans what actually trades.
 * Public Gamma API, no auth.
 */
import { fetchJson as httpJson } from "../http.js";

const GAMMA = "https://gamma-api.polymarket.com";

const SERIES: { label: string; id: string }[] = [
  { label: "BTC 15m", id: "10192" },
  { label: "ETH hourly", id: "10117" },
  { label: "SOL hourly", id: "10122" },
  { label: "ETH daily", id: "40" },
];

type ScanRow = {
  series: string;
  endDate: string;
  minsLeft: number;
  slug: string;
  volume: number;
  upPx: number | null;
  downPx: number | null;
};

async function seriesOpen(id: string): Promise<ScanRow[]> {
  // Shared HTTP discipline (same as gamma.ts): one UA, 20s timeout, bounded
  // retry on 429/5xx with backoff — not a one-shot raw fetch.
  const ev = (await httpJson(
    `${GAMMA}/events?series_id=${id}&closed=false&limit=30&order=endDate&ascending=true`,
    {},
    { timeoutMs: 20_000 },
  )) as {
    slug: string;
    endDate: string;
    markets?: { volume?: string | number; outcomePrices?: string[] | string }[];
  }[];
  const now = Date.now();
  const rows: ScanRow[] = [];
  for (const e of ev) {
    const end = Date.parse(e.endDate);
    if (!Number.isFinite(end) || end <= now) continue;
    const m = e.markets?.[0];
    const raw = m?.outcomePrices;
    let arr: unknown[] = [];
    if (Array.isArray(raw)) arr = raw;
    else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = [];
      }
    }
    const px = arr.map(Number);
    rows.push({
      series: id,
      endDate: e.endDate,
      minsLeft: Math.round((end - now) / 60000),
      slug: e.slug,
      volume: Number(m?.volume ?? 0) || 0,
      upPx: Number.isFinite(px[0]) ? px[0] as number : null,
      downPx: Number.isFinite(px[1]) ? px[1] as number : null,
    });
    if (rows.length >= 3) break;
  }
  return rows;
}

export async function cmdPolyScan(opts: { json: boolean }): Promise<void> {
  const labelOf = (id: string): string => SERIES.find((s) => s.id === id)?.label ?? id;
  const all: ScanRow[] = [];
  for (const s of SERIES) {
    try {
      all.push(...(await seriesOpen(s.id)));
    } catch (e) {
      console.error(`scan ${s.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  all.sort((a, b) => a.minsLeft - b.minsLeft);
  if (opts.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  if (all.length === 0) {
    console.log("No live short-horizon windows — the 5m series are dead shells and nothing else is open.");
    return;
  }
  console.log("SERIES       END(Z)              LEFT    VOL$    UP    DOWN  SLUG");
  for (const r of all) {
    const f = (v: number | null): string => (v == null ? "—" : v.toFixed(3));
    console.log(
      [
        labelOf(r.series).padEnd(11),
        r.endDate.slice(11, 16).padEnd(19),
        `${r.minsLeft}m`.padStart(6),
        (r.volume >= 1000 ? `${(r.volume / 1000).toFixed(1)}k` : r.volume.toFixed(0)).padStart(7),
        f(r.upPx).padStart(6),
        f(r.downPx).padStart(6),
        r.slug,
      ].join("  "),
    );
  }
  console.log("Read-only. Paper-test a window with `analyze prediction <slug>` (JEV verdict, no money).");
}
