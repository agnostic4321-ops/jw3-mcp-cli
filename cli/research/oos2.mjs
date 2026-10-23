
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
// The REAL calendar: split by actual date, newest block LAST.
const allTs=[]; for(const s of alts){const ks=cache[s]; if(ks) allTs.push(ks[0][0], ks[ks.length-1][0]);}
const minTs=minOf(allTs), maxTs=maxOf(allTs);
const span=(maxTs-minTs)/86400000;
console.log(`data span: ${span.toFixed(1)} days (${new Date(minTs).toISOString().slice(0,10)} -> ${new Date(maxTs).toISOString().slice(0,10)})`);
const B1=minTs+span*0/3*86400000, B2=minTs+span*1/3*86400000, B3=minTs+span*2/3*86400000, B4=maxTs;
console.log(`blocks: ${new Date(B1).toISOString().slice(0,10)} ${new Date(B2).toISOString().slice(0,10)} ${new Date(B3).toISOString().slice(0,10)} ${new Date(B4).toISOString().slice(0,10)}`);
function runIn(ks,H,thresh,lo,hi){ const v=[];
  for(let i=1;i+H<ks.length;i++){ const ts=ks[i][0]; if(ts<lo||ts>=hi) continue;
    const m=btcByTs.get(ts-3600000); if(m===undefined||Math.abs(m)<thresh) continue;
    const entry=ks[i][4],exit=ks[i+H][4]; if(!(entry>0)||!(exit>0)) continue;
    v.push((m>0?(exit-entry)/entry:(entry-exit)/entry)*100);
  } return v; }
function stat(v){ if(v.length<30) return null; const m=v.reduce((a,b)=>a+b,0)/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));
  return {n:v.length,mean:m,lo:m-1.96*sd/Math.sqrt(v.length),hi:m+1.96*sd/Math.sqrt(v.length)}; }
console.log("\nOUT-OF-SAMPLE STABILITY — 3 consecutive blocks, each independent. Net = gross - 0.04% maker.\n");
for (const thresh of [0.4,0.5,0.7]) {
  for (const H of [4,6,12,24]) {
    const blocks=[[B1,B2],[B2,B3],[B3,B4]].map(([a,b])=>{
      const v=[]; for(const s of alts){const ks=cache[s]; if(ks) v.push(...runIn(ks,H,thresh,a,b));}
      return stat(v);
    });
    if (blocks.some(o=>!o)) { console.log(`  thresh ${thresh} H=${String(H).padStart(2)}: a block had too few trades`); continue; }
    const nets=blocks.map(o=>o.mean-MAKER);
    const pos=nets.filter(n=>n>0).length;
    const verdict=(pos>=2)?"STABLE (>=2/3)":"FAILS";
    console.log(`  thresh ${thresh} H=${String(H).padStart(2)}  n=${blocks.map(b=>b.n).join("/")}  net: ${nets.map(n=>(n>=0?"+":"")+n.toFixed(4)+"%").join(" ")}  (${pos}/3+)  ${verdict}`);
  }
}
