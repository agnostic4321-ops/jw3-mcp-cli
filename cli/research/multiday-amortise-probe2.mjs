#!/usr/bin/env node
/**
 * PROBE 2 — two exact questions the design depends on.
 *
 *  A) HOW DEEP does 1h kline history actually go? (the previous probe's
 *     pageTo clamp could not distinguish "venue has no older data" from
 *     "my query was malformed"). Measured by asking for one specific
 *     day-long window and counting the rows returned.
 *
 *  B) WHAT IS the rolling-window budget? (2000 requests per ??? seconds)
 *     Measured by watching gw-ratelimit-remaining decay against a known
 *     clock, then re-measuring after the reset elapses.
 */
const FUT = "https://api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const HOUR = 3_600_000;
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const t0 = Date.now();
  const res = await fetch(FUT + path, { headers: UA });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  return {
    status: res.status,
    ms: Date.now() - t0,
    h: {
      limit: res.headers.get("gw-ratelimit-limit"),
      remaining: res.headers.get("gw-ratelimit-remaining"),
      reset: res.headers.get("gw-ratelimit-reset"),
      date: res.headers.get("date"),
    },
    j,
    body: txt.slice(0, 160),
  };
}
const fmt = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/* ── A) history depth ─────────────────────────────────────────────────── */
console.log("[A] 1h history depth — one day-long window, rows returned");
const probes = [
  ["2025-01-15", "2025-01-16"],
  ["2025-06-15", "2025-06-16"],
  ["2026-01-15", "2026-01-16"],
  ["2026-03-15", "2026-03-16"],
  ["2026-04-15", "2026-04-16"],
  ["2026-04-25", "2026-04-26"],
  ["2026-05-01", "2026-05-02"],
  ["2026-05-05", "2026-05-06"],
  ["2026-07-01", "2026-07-02"],
  ["2026-10-15", "2026-10-16"],
];
for (const [a, b] of probes) {
  const from = Date.parse(a + "T00:00:00Z");
  const to = Date.parse(b + "T00:00:00Z");
  const r = await getJson(
    `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${to}`,
  );
  const rows = Array.isArray(r.j?.data) ? r.j.data : [];
  const oldest = rows.length ? fmt(Number(rows[0][0])) : "-";
  const newest = rows.length ? fmt(Number(rows[rows.length - 1][0])) : "-";
  console.log(
    `  ${a} -> ${b}: status=${r.status} rows=${String(rows.length).padStart(3)} ` +
      `[${oldest} .. ${newest}]` +
      (r.status !== 200 ? ` body=${r.body}` : ""),
  );
}

/* How far back, walking backward one page at a time from now. */
console.log("\n[A] backward walk from now (200 rows/page) — where does it stop?");
{
  let cursor = Date.now();
  let oldest = null;
  let pages = 0;
  const t0 = Date.now();
  while (pages < 30) {
    const r = await getJson(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${cursor - 200 * HOUR}&to=${cursor}`,
    );
    pages++;
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    if (rows.length === 0) break;
    oldest = Number(rows[0][0]);
    const last = Number(rows[rows.length - 1][0]);
    if (last <= cursor - 200 * HOUR) break;
    cursor = last + 1;
    if (rows.length < 200) break;
  }
  console.log(
    `  oldest bar: ${fmt(oldest)}  (${pages} pages, ${Date.now() - t0}ms)  ` +
      `=> ${Math.round((Date.now() - oldest) / DAY)} days of 1h history`,
  );
}

/* ── B) rate-limit window ─────────────────────────────────────────────── */
console.log("\n[B] rate-limit budget decay");
{
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const from = Date.parse("2026-06-01T00:00:00Z") + i * 200 * HOUR;
    const r = await getJson(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${from + 199 * HOUR}`,
    );
    seen.push({
      t: Date.now(),
      rem: Number(r.h.remaining),
      reset: Number(r.h.reset),
      date: r.h.date,
      status: r.status,
    });
    await sleep(50);
  }
  const f = seen[0], l = seen[seen.length - 1];
  console.log(`  first: ${JSON.stringify(f)}`);
  console.log(`  last:  ${JSON.stringify(l)}`);
  console.log(`  decay over ${l.t - f.t}ms = ${l.rem - f.rem} requests`);
  // reset as an absolute epoch?
  const rEpochMs = l.reset > 1e9 ? l.reset * 1000 : l.reset;
  console.log(
    `  reset=${l.reset} -> as epoch ${fmt(rEpochMs)} (now ${fmt(Date.now())})`,
  );
  const serverNow = Date.parse(l.date ?? "");
  console.log(
    `  server date=${l.date} skew=${serverNow ? Math.round((serverNow - Date.now()) / 1000) : "?"}s`,
  );
  console.log(
    `  if reset is an absolute epoch, the window ends in ${Math.round((rEpochMs - Date.now()) / 1000)}s`,
  );
}

console.log("\n[B] one more check: does /contracts/active include delisted history?");
{
  const r = await getJson("/api/v1/contracts/active");
  const d = r.j?.data ?? [];
  const crypto = d.filter(
    (c) => c.assetClass === "CRYPTO" && c.quoteCurrency === "USDT" && String(c.symbol).endsWith("USDTM"),
  );
  const oldest = crypto
    .map((c) => Number(c.firstOpenDate))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)[0];
  console.log(`  oldest firstOpenDate among ${crypto.length} crypto USDTM: ${fmt(oldest)}`);
}
console.log("\n[probe2] done");
