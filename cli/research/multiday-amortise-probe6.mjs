#!/usr/bin/env node
/**
 * PROBE 6 — find the highest SUSTAINED rate that does not 429.
 *
 * The live machine shares the venue's per-IP gateway budget with the
 * live path, so this wants a rate that is high enough to finish the
 * fetch in reasonable time and low enough to leave the machine room.
 * Measured over 30s per level (long enough to cross a full 2000/30s
 * window at least once).
 */
import https from "node:https";

const FUT = "api-futures.kucoin.com";
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JW3Research/1.0",
  Accept: "application/json",
};
const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFetcher() {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  return (path) =>
    new Promise((resolve) => {
      const req = https.request({ host: FUT, path, method: "GET", agent, headers: UA }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          resolve({ status: res.statusCode, rem: Number(res.headers["gw-ratelimit-remaining"]) });
        });
      });
      req.on("error", () => resolve({ status: 0, rem: NaN }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, rem: NaN }); });
      req.end();
    });
}
const get = makeFetcher();

for (const rate of [10, 16, 22]) {
  const dur = 20000;
  const t0 = Date.now();
  let n = 0, r429 = 0, err = 0, minRem = Infinity;
  let next = Date.now();
  const gap = 1000 / rate;
  const inflight = new Set();
  while (Date.now() - t0 < dur) {
    const now = Date.now();
    if (now < next) await sleep(Math.min(next - now, 50));
    next += gap;
    const from = Date.parse("2025-08-01T00:00:00Z") + (n % 400) * 200 * HOUR;
    const p = get(
      `/api/v1/kline/query?symbol=ETHUSDTM&granularity=60&from=${from}&to=${from + 199 * HOUR}`,
    );
    inflight.add(p);
    p.then((r) => {
      if (r.status === 200) { n++; minRem = Math.min(minRem, r.rem); }
      else if (r.status === 429) r429++;
      else err++;
      inflight.delete(p);
    });
  }
  await Promise.all([...inflight]);
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `  target=${String(rate).padStart(2)}/s -> achieved=${(n / secs).toFixed(1)}/s  ok=${n} 429=${r429} err=${err} min_remaining=${minRem}`,
  );
  await sleep(2000);
}
console.log("[probe6] done");
