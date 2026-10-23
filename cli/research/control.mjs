
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CACHE = join(homedir(), ".hermes/cache/scratch/leads/klines");
const load=(b)=>{const f=join(CACHE,`${b}USDTM_60_90.json`);return existsSync(f)?JSON.parse(readFileSync(f,"utf8")):null;};
const FUT="https://api-futures.kucoin.com";
const r=await fetch(`${FUT}/api/v1/contracts/active`); const j=await r.json();
const all=(j.data||[]).filter(c=>String(c.symbol).endsWith("USDTM")).map(c=>({sym:String(c.symbol),v:Number(c.volumeOf24h||0)})).sort((a,b)=>b.v-a.v);
const alts=all.filter(c=>c.sym!=="XBTUSDTM").slice(0,60).map(c=>c.sym);
const btc=load("XBT")??load("BTC");
const btcByTs=new Map(btc.map((b,i)=>[b[0], i===0?0:((b[4]-btc[i-1][4])/btc[i-1][4])*100]));
const cache={}; for(const s of alts) cache[s]=load(s.replace("USDTM",""));

function series(ks,H,filterFn,dirMode) {
  const v=[];
  for(let i=1;i+H<ks.length;i++){
    const keep=filterFn?filterFn(ks,i):true; if(!keep) continue;
    const entry=ks[i][4],exit=ks[i+H][4]; if(!(entry>0)||!(exit>0)) continue;
    const m = dirMode==="aligned" ? (btcByTs.get(ks[i][0]-3600000)??0) : (dirMode==="reversed" ? -1 : 1);
    const long = dirMode==="uncond" ? true : (dirMode==="reversed" ? (m<0) : (m>0));
    v.push((long?(exit-entry)/entry:(entry-exit)/entry)*100);
  }
  return v;
}
function stats(v){ if(v.length<50) return null; const m=v.reduce((a,b)=>a+b,0)/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));
  return {n:v.length,mean:m,lo:m-1.96*sd/Math.sqrt(v.length),hi:m+1.96*sd/Math.sqrt(v.length)}; }

console.log("THE CONTROL: aligned signal vs an UNCONDITIONAL long (no signal at all).");
console.log("Same symbols, same H, same period. If they match, the 'edge' is beta.\n");
console.log("  thresh   H   strategy        n      mean%    CI95              vs-uncond");
for (const thresh of [0.4,0.5,0.7]) {
  for (const H of [4,6,12,24]) {
    const A=[],U=[];
    for(const s of alts){ const ks=cache[s]; if(!ks) continue;
      const f=(k,i)=>{const m=btcByTs.get(k[i][0]-3600000); return m!==undefined && Math.abs(m)>=thresh;};
      A.push(...series(ks,H,f,"aligned")); U.push(...series(ks,H,null,"uncond"));
    }
    const sa=stats(A), su=stats(U); if(!sa||!su) continue;
    const d=sa.mean-su.mean;
    const verdict = d>0 ? `EDGE +${d.toFixed(4)}pp` : `NO EDGE (${d.toFixed(4)}pp)`;
    console.log(`  ${String(thresh).padStart(5)}  ${String(H).padStart(2)}  aligned     ${String(sa.n).padStart(6)}  ${sa.mean>=0?"+":""}${sa.mean.toFixed(4)}%  [${sa.lo.toFixed(3)}, ${sa.hi.toFixed(3)}]`);
    console.log(`  ${String(thresh).padStart(5)}  ${String(H).padStart(2)}  UNCOND long ${String(su.n).padStart(6)}  ${su.mean>=0?"+":""}${su.mean.toFixed(4)}%  [${su.lo.toFixed(3)}, ${su.hi.toFixed(3)}]   ${verdict}`);
  }
}
