import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const CACHE = join(homedir(), ".hermes/cache/scratch/leads/klines");
const load = (s) => {
  const f = join(CACHE, `${s}USDTM_60_90.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

const r = await fetch("https://api-futures.kucoin.com/api/v1/contracts/active");
const j = await r.json();
const all = (j.data || [])
  .filter((c) => String(c.symbol).endsWith("USDTM"))
  .map((c) => ({ sym: String(c.symbol), v: Number(c.volumeOf24h || 0) }))
  .sort((a, b) => b.v - a.v);
// EXACTLY leadlag3's universe: the top 30 by volume, XBT excluded.
const alts = all.filter((c) => c.sym !== "XBTUSDTM").slice(0, 30).map((c) => c.sym);

const btc = load("XBT");
const btcByTs = new Map(btc.map((b, i) => [b[0], i === 0 ? 0 : ((b[4] - btc[i - 1][4]) / btc[i - 1][4]) * 100]));
const cache = {};
for (const s of alts) cache[s] = load(s.replace("USDTM", ""));

const allTs = [];
for (const s of alts) {
  const ks = cache[s];
  if (ks) allTs.push(ks[0][0], ks[ks.length - 1][0]);
}
const minTs = minOf(allTs);
const maxTs = maxOf(allTs);
const span = maxTs - minTs;
const B = [
  [minTs, minTs + span / 3],
  [minTs + span / 3, minTs + (2 * span) / 3],
  [minTs + (2 * span) / 3, maxTs],
];

// PAIRED: follow-BTC vs always-long, SAME bar, SAME symbol, SAME window.
// This removes ALL market beta, so what is left is directional skill.
function paired(thresh, H, lo, hi) {
  const d = [];
  for (const s of alts) {
    const ks = cache[s];
    if (!ks) continue;
    for (let i = 1; i + H < ks.length; i++) {
      const ts = ks[i][0];
      if (ts < lo || ts >= hi) continue;
      const m = btcByTs.get(ts - 3600000);
      if (m === undefined || Math.abs(m) < thresh) continue;
      const e = ks[i][4];
      const x = ks[i + H][4];
      if (!(e > 0) || !(x > 0)) continue;
      const sig = (m > 0 ? (x - e) / e : (e - x) / e) * 100;
      const beta = ((x - e) / e) * 100;
      d.push(sig - beta);
    }
  }
  return d;
}

function stat(v) {
  if (v.length < 30) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  return {
    n: v.length,
    mean: m,
    lo: m - (1.96 * sd) / Math.sqrt(v.length),
    hi: m + (1.96 * sd) / Math.sqrt(v.length),
    pos: (v.filter((x) => x > 0).length / v.length) * 100,
  };
}

console.log("THE GAP: the beta control for thresh 0.4 / H=4, the one row whose GROSS CI sat above zero.");
console.log("Paired: follow-BTC vs always-long, same bar, same symbol, same window.\n");
console.log("  thresh  H  block       n   paired delta            CI95                 verdict");
for (const [thresh, H] of [
  [0.4, 1],
  [0.4, 2],
  [0.4, 4],
  [0.4, 8],
  [0.25, 1],
  [0.25, 4],
  [0.5, 4],
  // THE GAP: the "best" raw lead-lag combos. thresh=1 / H=6 was the
  // single best result in the whole project (gross +0.4128%, CI
  // [0.212, 0.614], n=2287) and it was NEVER paired-controlled. A large
  // gross with a small n is exactly where beta hides best.
  [0.5, 6],
  [0.5, 8],
  [0.5, 12],
  [0.5, 24],
  [0.7, 12],
  [1.0, 2],
  [1.0, 3],
  [1.0, 4],
  [1.0, 6],
  [1.0, 8],
  [1.0, 12],
  [1.0, 24],
]) {
  const per = [];
  for (let b = 0; b < 3; b++) {
    const d = paired(thresh, H, B[b][0], B[b][1]);
    const st = stat(d);
    if (!st) {
      console.log(`  ${String(thresh).padStart(5)}  ${String(H).padStart(2)}  ${b + 1}  too few`);
      continue;
    }
    per.push(st);
    const v = st.lo > 0 ? "SIGNIFICANT" : st.mean > 0 ? "positive" : "negative";
    console.log(
      `  ${String(thresh).padStart(5)}  ${String(H).padStart(2)}  ${b + 1}  ${String(st.n).padStart(6)}  ${st.mean >= 0 ? "+" : ""}${st.mean.toFixed(4)}pp  [${st.lo.toFixed(4)}, ${st.hi.toFixed(4)}]  ${v}`,
    );
  }
  if (per.length === 3) {
    const pos = per.filter((s) => s.mean > 0).length;
    const sig = per.filter((s) => s.lo > 0).length;
    const avg = per.reduce((a, s) => a + s.mean, 0) / 3;
    console.log(
      `        => ${pos}/3 positive, ${sig}/3 significant. avg excess ${avg >= 0 ? "+" : ""}${avg.toFixed(4)}pp  ${sig === 3 ? "*** REAL EDGE ***" : pos >= 2 ? "majority only" : "NO EDGE"}\n`,
    );
  }
}
