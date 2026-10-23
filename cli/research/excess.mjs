
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
function run(ks,H,thresh,lo,hi,mode){
  const v=[];
  for(let i=1;i+H<ks.length;i++){ const ts=ks[i][0]; if(ts<lo||ts>=hi) continue;
    const m=btcByTs.get(ts-3600000);
    let long;
    if(mode==="uncond") long=true;
    else { if(m===undefined||Math.abs(m)<thresh) continue; long = (mode==="aligned") ? m>0 : m<0; }
    const entry=ks[i][4],exit=ks[i+H][4]; if(!(entry>0)||!(exit>0)) continue;
    v.push((long?(exit-entry)/entry:(entry-exit)/entry)*100);
  } return v; }
function stat(v){ if(v.length<30) return null; const m=v.reduce((a,b)=>a+b,0)/v.length;
  const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length-1));
  return {n:v.length,mean:m,lo:m-1.96*sd/Math.sqrt(v.length),hi:m+1.96*sd/Math.sqrt(v.length)}; }

console.log("THE ONLY QUESTION THAT MATTERS: is the signal's edge EXCESS over beta?");
console.log("For each block: signal net vs UNCONDITIONAL-long net, same symbols, same H, same window.\n");
for (const [thresh,H] of [[0.5,4],[0.5,6],[0.5,12],[0.4,12],[0.7,12]]) {
  console.log(`  thresh ${thresh}  H=${H}`);
  let excessAll=[];
  for (let b=0;b<3;b++) {
    const A=[],U=[];
    for(const s of alts){const ks=cache[s]; if(ks){A.push(...run(ks,H,thresh,B[b][0],B[b][1],"aligned")); U.push(...run(ks,H,thresh,B[b][0],B[b][1],"uncond"));}}
    const sa=stat(A), su=stat(U); if(!sa||!su){console.log("    (too few)");continue;}
    const excess=sa.mean-su.mean; excessAll.push(excess);
    const sNet=sa.mean-MAKER, uNet=su.mean-MAKER;
    console.log(`    block ${b+1}: signal ${sNet>=0?"+":""}${sNet.toFixed(4)}%  uncond ${uNet>=0?"+":""}${uNet.toFixed(4)}%  EXCESS ${excess>=0?"+":""}${excess.toFixed(4)}pp  (signal n=${sa.n})`);
  }
  if (excessAll.length===3) {
    const pos=excessAll.filter(x=>x>0).length;
    const avg=excessAll.reduce((a,b)=>a+b,0)/3;
    console.log(`    => excess: ${excessAll.map(x=>(x>=0?"+":"")+x.toFixed(4)+"pp").join(" ")}  ${pos}/3 positive  avg ${avg>=0?"+":""}${avg.toFixed(4)}pp  ${pos>=2?"*** EXCESS EDGE ***":"NO EXCESS (beta)"}`);
  }
  console.log("");
}
