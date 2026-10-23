#!/usr/bin/env node
/**
 * PROBE 4 — two things the study design depends on:
 *
 *  A) SURVIVORSHIP: does the venue expose DELISTED contracts? The
 *     `kucoin-futures-data` skill says `/contracts/active` excludes them,
 *     and that this is the single biggest threat to a listing-era study.
 *     If a delisted endpoint exists, the fresh window's universe can be
 *     made survivorship-free.
 *
 *  B) RATE-LIMIT WINDOW: `gw-ratelimit-reset` moved 9288 -> 1130 in 8
 *     seconds, which is not a plain countdown. Figure out what the
 *     budget actually is before launching a 30k-call fetch.
 */
const FUT = "https://api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
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
    body: txt.slice(0, 200),
  };
}

console.log("[A] looking for a delisted/inactive contract endpoint");
for (const p of [
  "/api/v1/contracts/inactive",
  "/api/v1/contracts/delisted",
  "/api/v1/contracts/inactive?status=Closed",
  "/api/v1/contracts/active?status=Closed",
  "/api/v1/contracts/active?status=Delisted",
  "/api/v1/contracts/active?status=All",
]) {
  const r = await getJson(p);
  const rows = r.j?.data;
  const n = Array.isArray(rows) ? rows.length : "n/a";
  const status = Array.isArray(rows)
    ? [...new Set(rows.map((c) => c.status))].join(",")
    : "-";
  console.log(`  ${p.padEnd(48)} status=${r.status} rows=${n} statuses=${status}`);
  if (r.status !== 200) console.log(`      body: ${r.body}`);
}

console.log("\n[A2] do DELISTED-looking symbols still return klines? (spot check)");
{
  // A symbol that is certainly gone from /contracts/active today.
  for (const sym of ["SUNUSDTM", "LUNAUSDTM", "USTUSDTM", "ANCUSDTM", "GTOUSDTM", "TUSDBUSDTM"]) {
    const from = Date.parse("2026-01-01T00:00:00Z");
    const to = from + 24 * 3600_000;
    const r = await getJson(
      `/api/v1/kline/query?symbol=${sym}&granularity=60&from=${from}&to=${to}`,
    );
    const rows = Array.isArray(r.j?.data) ? r.j.data : [];
    let inActive = "not-in-active-list";
    const act = await getJson("/api/v1/contracts/active");
    const syms = new Set((act.j?.data ?? []).map((c) => c.symbol));
    if (syms.has(sym)) inActive = "IN active list";
    console.log(
      `  ${sym.padEnd(12)} ${inActive.padEnd(20)} klines status=${r.status} rows=${rows.length}`,
    );
  }
}

console.log("\n[B] rate-limit window: poll remaining/reset for 45s at a steady 3 req/s");
{
  const t0 = Date.now();
  const samples = [];
  let next = Date.now();
  const tick = async () => {
    const now = Date.now();
    if (now < next) { await sleep(next - now); }
    const r = await getJson(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${Date.parse("2025-09-01T00:00:00Z")}&to=${Date.parse("2025-09-08T00:00:00Z")}`,
    );
    samples.push({
      t: Math.round((Date.now() - t0) / 1000),
      rem: r.h.remaining,
      reset: r.h.reset,
      lim: r.h.limit,
    });
    next += 334;
  };
  while (Date.now() - t0 < 45000) await tick();
  // find the sawtooth: where remaining jumps back up
  let jumps = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].rem > samples[i - 1].rem) {
      jumps++;
      console.log(
        `  RESET at t=${samples[i].t}s: remaining ${samples[i - 1].rem} -> ${samples[i].rem} ` +
          `(reset header ${samples[i - 1].reset} -> ${samples[i].reset}, limit ${samples[i].lim})`,
      );
    }
  }
  const s = samples[0], e = samples[samples.length - 1];
  console.log(`  samples=${samples.length} over ${e.t}s; remaining ${s.rem} -> ${e.rem}; resets seen=${jumps}`);
  console.log(`  final: ${JSON.stringify(e)}`);
}

console.log("\n[probe4] done");
