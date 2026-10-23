
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CACHE = join(homedir(), ".hermes/cache/scratch/leads/klines");
const DAYS = 90;
const load = (b) => { const f = join(CACHE, `${b}USDTM_60_${DAYS}.json`); return existsSync(f) ? JSON.parse(readFileSync(f,"utf8")) : null; };
const r = await fetch("https://api-futures.kucoin.com/api/v1/contracts/active");
const j = await r.json();
const uni = (j.data||[]).filter(c=>String(c.symbol).endsWith("USDTM"))
  .map(c=>({base:String(c.symbol).replace("USDTM",""), v:Number(c.volumeOf24h||0)}))
  .sort((a,b)=>b.v-a.v).slice(0,40);
const FEE_RT = 0.12; // taker round trip, percent of notional
console.log("PAIRED within-day, LONG at h21 vs the same day at other hours");
console.log("Net of the 0.12% taker round trip. H = hold in 1h bars.\n");
console.log("   H    hold   gross delta   net delta   CI95                     verdict");
for (const H of [1, 2, 4, 8, 12, 24, 48, 72, 168]) {
  const perSymbol = [];
  for (const s of uni) {
    const ks = load(s.base); if (!ks || ks.length < H+30) continue;
    const byHour = {};
    for (let i = 0; i + H < ks.length; i++) {
      const h = new Date(ks[i][0]).getUTCHours();
      const entry = ks[i+1][4], exit = ks[i+H][4];
      if (!(entry>0) || !(exit>0)) continue;
      const day = new Date(ks[i][0]).toISOString().slice(0,10);
      (byHour[h] ||= []).push({day, ret: ((exit-entry)/entry)*100});
    }
    perSymbol.push(byHour);
  }
  const deltas = [];
  for (const byHour of perSymbol) {
    const days = new Map();
    for (const [h, rows] of Object.entries(byHour)) {
      for (const rr of rows) {
        const d = days.get(rr.day) || {in:[],out:[]};
        if (Number(h)===21) d.in.push(rr.ret); else d.out.push(rr.ret);
        days.set(rr.day, d);
      }
    }
    for (const [,d] of days) {
      if (!d.in.length || !d.out.length) continue;
      const m = a => a.reduce((x,y)=>x+y,0)/a.length;
      deltas.push(m(d.in)-m(d.out));
    }
  }
  if (!deltas.length) { console.log(`  H=${H}: no data`); continue; }
  deltas.sort((a,b)=>a-b);
  const mean = deltas.reduce((a,b)=>a+b,0)/deltas.length;
  const ci = p => deltas[Math.min(Math.floor(deltas.length*p), deltas.length-1)];
  const lo = ci(0.025), hi = ci(0.975);
  const net = mean - FEE_RT;
  const verdict = (lo > FEE_RT) ? "SIGNIFICANT & NET+"
    : (lo > 0 ? "significant gross, NET NEGATIVE" : "not significant");
  const hrs = H < 24 ? `${H}h` : `${(H/24).toFixed(0)}d`;
  console.log(`  ${String(H).padStart(3)}  ${hrs.padStart(6)}   ${mean>=0?"+":""}${mean.toFixed(4)}%      ${net>=0?"+":""}${net.toFixed(4)}%    [${lo.toFixed(4)}, ${hi.toFixed(4)}]  ${verdict}`);
}
