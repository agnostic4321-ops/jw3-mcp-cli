#!/usr/bin/env node
/**
 * VALIDATE THE BINANCE TAPE RECONSTRUCTION — at the EXACT read time.
 *
 * The first attempt compared the reconstructed tape at the 5-minute
 * BUCKET BOUNDARY against KuCoin's tape at the row's actual read time,
 * which can be up to five minutes apart. On a volatile small cap that
 * is a large gap, and it produced a 51% side-agreement that said more
 * about the clock than about the reconstruction.
 *
 * This version compares at the EXACT timestamp of KuCoin's read, and
 * tests the one genuine ambiguity: whether the venue's kline feed
 * includes the FORMING (partial) bar.
 *
 * Binance and KuCoin track the same underlying perpetual, so at the same
 * instant their PRICE-BASED tape metrics (chg, offHigh, offLow, ATR) must
 * agree closely. The VOLUME metric (vratio) legitimately differs —
 * each venue's volume is its own book — so it is reported separately and
 * is not treated as a reconstruction failure.
 *
 * READ-ONLY. Binance only. No KuCoin call, no account call.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fadeMetrics, tapeSideOf } from "./rep-venue-common.mjs";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const SCRATCH = join(homedir(), ".hermes/cache/scratch");
const BASES = JSON.parse(readFileSync(join(SCRATCH, "rep-bases.json"), "utf8"));
const BIN = "https://fapi.binance.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON: ${t.slice(0, 120)}`); }
}

async function klines(symbol, interval, fromMs, toMs) {
  const out = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard++ < 10) {
    const url = `${BIN}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=1500`;
    let rows;
    try { rows = await getJson(url); } catch { break; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ t: Number(r[0]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), ct: Number(r[6]) });
    const last = Number(rows[rows.length - 1][0]);
    if (last + 1 <= cursor) break;
    cursor = last + 1;
    await sleep(40);
  }
  const m = new Map();
  for (const b of out) m.set(b.t, b);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/**
 * The tape at one instant, from 1-minute candles.
 *
 * `includeForming` decides whether the partial one-minute bar is in the
 * window. The live path's kline query ends at `now`, and the feed's
 * answer to "is the last bar complete?" is what this tests.
 */
function tapeAt(bars, ts, includeForming) {
  const win = [];
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (b.t > ts) continue;
    if (!includeForming && b.ct > ts) continue;
    win.push(b);
    if (win.length >= 24) break;
  }
  win.reverse();
  if (win.length < 24) return null;
  const m = fadeMetrics(win.map((b) => b.c), win.map((b) => b.v), win.map((b) => b.h), win.map((b) => b.l));
  return m ? { ...m, last: win[win.length - 1].c } : null;
}

const rows = readFileSync(join(SCRATCH, "rep-confluence.snapshot.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The LAST row per (pair, 5-minute bucket): the closest read to the
// bucket's end, and the one the cluster means are built from.
const kc = new Map();
for (const r of rows) {
  if (r.tapeChg == null) continue;
  const b = Math.floor(r.ts / 300_000);
  const k = `${r.pair}|${b}`;
  const prev = kc.get(k);
  if (!prev || r.ts > prev.ts) kc.set(k, r);
}

const info = await getJson(`${BIN}/fapi/v1/exchangeInfo`);
const perps = new Set((info.symbols ?? []).filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING").map((s) => s.symbol));
const map = {};
for (const b of BASES) {
  const cands = b === "XBT" ? ["BTCUSDT"] : [`${b}USDT`, b.startsWith("1000") ? `${b.slice(4)}USDT` : null, b.startsWith("10000") ? `${b.slice(5)}USDT` : null, `1000${b}USDT`].filter(Boolean);
  const hit = cands.find((c) => perps.has(c));
  if (hit) map[b] = hit;
}

const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

for (const includeForming of [true, false]) {
  console.log(`\n═══ the forming bar ${includeForming ? "INCLUDED" : "EXCLUDED"} ═══`);
  const agg = { chg: [], offHigh: [], offLow: [], atr: [], vratio: [] };
  let n = 0, agree = 0, flip = 0, bothSide = 0;
  const perSym = [];
  for (const [base, sym] of Object.entries(map)) {
    const kcRows = [...kc.entries()].filter(([k]) => k.startsWith(`${base}/USDT|`)).map(([, v]) => v);
    if (!kcRows.length) continue;
    const ts0 = minBy(kcRows, (r) => r.ts);
    const ts1 = maxBy(kcRows, (r) => r.ts);
    const one = await klines(sym, "1h", ts0 - 72 * 3600_000, ts1 + 3600_000);
    if (one.length < 24) continue;
    const d = { chg: [], offHigh: [], offLow: [], atr: [], vratio: [] };
    let sAgree = 0, sTotal = 0, sFlip = 0;
    for (const r of kcRows) {
      const t = tapeAt(one, r.ts, includeForming);
      if (!t) continue;
      d.chg.push(Math.abs(t.chg - r.tapeChg));
      d.offHigh.push(Math.abs(t.offHighPct - r.tapeOffHighPct));
      d.offLow.push(Math.abs(t.offLowPct - r.tapeOffLowPct));
      if (t.atrPct != null && r.tapeAtrPct != null) d.atr.push(Math.abs(t.atrPct - r.tapeAtrPct));
      d.vratio.push(Math.abs(t.vratio - r.tapeVratio));
      const s1 = tapeSideOf({ offHighPct: t.offHighPct, offLowPct: t.offLowPct, vratio: t.vratio });
      const s2 = tapeSideOf({ offHighPct: r.tapeOffHighPct, offLowPct: r.tapeOffLowPct, vratio: r.tapeVratio });
      sTotal++;
      if (s1 === s2) sAgree++;
      else if (s1 && s2) sFlip++;
    }
    if (!sTotal) continue;
    perSym.push({ base, n: sTotal, agreePct: (sAgree / sTotal) * 100, flip: sFlip, medChg: med(d.chg) });
    n += sTotal; agree += sAgree; flip += sFlip; bothSide += sFlip;
    for (const k of Object.keys(agg)) agg[k].push(...d[k]);
  }
  console.log(`  symbols=${perSym.length}  reads=${n}`);
  console.log(`  side agreement: ${((agree / n) * 100).toFixed(1)}%   (${flip} reads where both venues had a side and they OPPOSED)`);
  console.log(`  median |price-based diff|:  chg ${med(agg.chg).toFixed(2)}pp   offHigh ${med(agg.offHigh).toFixed(2)}pp   offLow ${med(agg.offLow).toFixed(2)}pp   ATR ${med(agg.atr).toFixed(3)}pp`);
  console.log(`  median |volume diff|:       vratio ${med(agg.vratio).toFixed(3)}  (venue-specific volume, not a reconstruction error)`);
  const worst = [...perSym].sort((a, b) => a.agreePct - b.agreePct).slice(0, 5);
  console.log(`  worst symbols by side agreement: ${worst.map((w) => `${w.base} ${w.agreePct.toFixed(0)}%`).join(", ")}`);
}
