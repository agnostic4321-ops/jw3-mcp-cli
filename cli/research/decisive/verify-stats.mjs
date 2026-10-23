/**
 * VERIFY THE HARNESS'S STATISTICS AGAINST SCIPY.
 * The power analysis is only as good as the t-distribution implementation.
 */
import { tPval, tCrit } from "./core.mjs";
import { execFileSync } from "node:child_process";

const py = `
import scipy.stats as st, json
out=[]
for t,df in [(0.5,3),(1.0,8),(1.59,30),(2.0,8),(3.15,8),(4.56,13),(0.9,120),(2.5,5),(1.0,200)]:
    out.append([t,df,float(2*st.t.sf(abs(t),df))])
for df in [3,8,13,30,120]:
    out.append(["crit",df,float(st.t.ppf(0.975,df))])
print(json.dumps(out))
`;
const res = JSON.parse(execFileSync("python3", ["-c", py]).toString());
let worst = 0;
console.log("  case                js_p         scipy_p      |diff|     js_crit      scipy_crit   |diff|");
for (const [t, df, sp] of res) {
  if (t === "crit") {
    const jc = tCrit(0.05, df);
    const d = Math.abs(jc - sp);
    worst = Math.max(worst, d);
    console.log(`  crit df=${String(df).padEnd(10)} ${jc.toFixed(6).padStart(12)}  ${sp.toFixed(6).padStart(12)}  ${d.toExponential(2)}`);
  } else {
    const jp = tPval(t, df);
    const d = Math.abs(jp - sp);
    worst = Math.max(worst, d);
    console.log(`  t=${String(t).padEnd(5)} df=${String(df).padEnd(9)} ${jp.toFixed(8).padStart(12)}  ${sp.toFixed(8).padStart(12)}  ${d.toExponential(2)}`);
  }
}
console.log(`\n  worst absolute error: ${worst.toExponential(3)}`);
if (worst > 1e-8) { console.log("  *** FAIL: the JS t-distribution does not match scipy ***"); process.exit(1); }
console.log("  OK: the JS t-distribution matches scipy to <1e-8.");
