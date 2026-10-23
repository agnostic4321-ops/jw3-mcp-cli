
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";
const CACHE=join(homedir(),".hermes/cache/scratch/leads/klines");
const load=(s)=>{const f=join(CACHE,`${s}USDTM_60_90.json`);return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):null;};
const FUT="https://api-futures.kucoin.com";
const r=await fetch(`${FUT}/api/v1/contracts/active`); const j=await r.json();
const all=(j.data||[]).filter(c=>String(c.symbol).endsWith("USDTM")).map(c=>({sym:String(c.symbol),v:Number(c.volumeOf24h||0)})).sort((a,b)=>b.v-a.v);
const alts=all.filter(c=>c.sym!=="XBTUSDTM").slice(0,60).map(c=>c.sym);
const btc=load("XBT");
const btcByTs=new Map(btc.map((b,i)=>[b[0], i===0?0:((b[4]-btc[i-1][4])/btc[i-1][4])*100]));
const cache={}; for(const s of alts) cache[s]=load(s.replace("USDTM",""));
const MAKER=0.04;
const allTs=[]; for(const s of alts){const ks=cache[s]; if(ks) allTs.push(ks[0][0], ks[ks.length-1][0]);}
const minTs=minOf(allTs), maxTs=maxOf(allTs), span=(maxTs-minTs);
const B=[[minTs,minTs+span/3],[minTs+span/3,minTs+2*span/3],[minTs+2*span/3,maxTs]];
// PAIRED: for the SAME symbol and the SAME entry bar, compare
//   (a) the signal's direction  vs  (b) always-long — on the SAME bar.
function paired(thresh,H,lo,hi){
  const deltas=[];
  for(const s of alts){ const ks=cache[s]; if(!ks) continue;
    for(let i=1;i+H<ks.length;i++){ const ts=ks[i][0]; if(ts<lo||ts>=hi) continue;
      const m=btcByTs.get(ts-3600000); if(m===undefined||Math.abs(m)<thresh) continue;
      const entry=ks[i][4],exit=ks[i+H][4]; if(!(entry>0)||!(exit>0)) continue;
      const sig=(m>0?(exit-entry)/entry:(entry-exit)/entry)*100;
      const beta=(exit-entry)/entry*100;      // always long, same bar
      deltas.push(sig-beta);
    } }
  return deltas;
}
function stat(v){ if(v.length<30) return null; const m=v.reduce((a,b)=>a+b,0)/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));
  return {n:v.length,mean:m,lo:m-1.96*sd/Math.sqrt(v.length),hi:m+1.96*sd/Math.sqrt(v.length),
          t:m/(sd/Math.sqrt(v.length)), pos:v.filter(x=>x>0).length/v.length*100}; }
console.log("PAIRED test: signal direction vs ALWAYS-LONG on the SAME bar, SAME symbol.");
console.log("This removes ALL market beta. The delta is pure directional skill.\n");
for (const [thresh,H] of [[0.4,12],[0.5,4],[0.5,6],[0.5,12],[0.5,24],[0.7,6],[0.7,12]]) {
  const per=[];
  for (let b=0;b<3;b++) per.push(stat(paired(thresh,H,B[b][0],B[b][1])));
  if (per.some(p=>!p)) { console.log(`  thresh ${thresh} H=${H}: too few`); continue; }
  const pos=per.filter(p=>p.mean>0).length;
  const tot=per.map(p=>p.n).reduce((a,b)=>a+b,0);
  const allD=per.map(p=>p);
  const avgMean=per.reduce((a,p)=>a+p.mean,0)/3;
  console.log(`  thresh ${thresh} H=${String(H).padStart(2)}  deltas: ${per.map(p=>(p.mean>=0?"+":"")+p.mean.toFixed(4)+"pp").join(" ")}  (${pos}/3+)  t=${per.map(p=>p.t.toFixed(1)).join(",")}  n=${tot}`);
  const sig = pos>=2 && per.every(p=>p.lo>0);
  console.log(`      => ${sig ? "*** SIGNIFICANT IN EVERY BLOCK (CI low > 0) ***" : (pos>=2 ? "majority positive, not significant per-block" : "FAILS")}`);
}
