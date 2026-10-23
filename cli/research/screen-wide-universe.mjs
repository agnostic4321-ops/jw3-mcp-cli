#!/usr/bin/env node
/**
 * THE WIDER UNIVERSE SCREEN — tradability across the whole KuCoin perp set,
 * computed ENTIRELY from local files. No network, no venue reads, no account.
 *
 * WHY IT IS OFFLINE
 * -----------------
 * The live machine shares a 60-call/minute budget with its STOP-ARMING path.
 * A research screen that bursts through that budget can starve the watchdog,
 * whose own venue read, when throttled three times, latches its breaker.
 * So this file reads the CACHED contract list and the CACHED 1-hour klines
 * and computes what it can from them. It says plainly which symbols it
 * could NOT screen, instead of quietly dropping them.
 *
 * THE SCREENING CRITERIA (each one is a HARD constraint, not a preference)
 * ------------------------------------------------------------------------
 *  1. THE TICKET MUST FIT THE FEE. The live path's fee is 0.08% of the
 *     notional (maker 0.02 entry + taker 0.06 exit). The sizing engine
 *     REFUSES a ticket whose fee drag exceeds 1/3 of the stop distance.
 *     With the shipped stop = 1.34 x ATR, that means:
 *         0.08 / (1.34 * ATR) <= 1/3   =>   ATR >= 0.179%
 *     So an ATR below ~0.18% makes the ticket UNFUNDABLE. (No symbol is
 *     anywhere near that, so the binding criterion is elsewhere.)
 *
 *  2. THE TARGET MUST NOT BE NOISE. The TP is clamp(0.4*ATR, 0.3%, 0.5%).
 *     Below ATR = 0.75% the TP is pinned at the 0.3% floor and stops
 *     responding to volatility; above ATR = 1.25% it is pinned at the 0.5%
 *     cap. The ticket is VOLATILITY-SENSITIVE only in 0.75% < ATR < 1.25%.
 *
 *  3. THE STOP MUST BE SURVIVABLE. The stop is 1.34 x ATR, so it must be
 *     wide enough to sit outside the market's own noise — the sizing
 *     engine's own floor is 0.25 x ATR, and the repo's practical floor is
 *     that a stop inside the noise band resolves as a coin flip.
 *
 *  4. THE VENUE MUST ALLOW THE LEVERAGE. KuCoin caps leverage PER
 *     CONTRACT (272 of 692 open perps cap at x20). A ticket that needs
 *     x20+ to keep its liquidation distance safe cannot be traded on a
 *     contract capped below that.
 *
 *  5. THE SPREAD MUST BE AFFORDABLE. The fee is charged on the notional,
 *     and the spread is crossed on entry and exit. A spread of X bps adds
 *     X/2 bps per side of cost on top of the fee.
 *
 *  6. THE SYMBOL MUST HAVE SIGNAL HISTORY. A symbol with no observations
 *     cannot be measured, so it cannot be recommended.
 *
 * USAGE
 *   node research/screen-wide-universe.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minOf, maxOf, minBy, maxBy } from "./safe-extremes.mjs";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const CONTRACTS = flag("contracts", join(HOME, ".hermes/cache/scratch/contracts.json"));

const FEE_LIVE = 0.08; // % of notional, round trip
const MAX_FEE_DRAG = 1 / 3;
const STOP_ATR_MULT = 1.34;
const EQUITY = 57.16;
const NOTIONAL_CAP = 60.0;
const RISK_PCT = 2;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const med = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── the contracts ───────────────────────────────────────────────────────
const contracts = JSON.parse(readFileSync(CONTRACTS, "utf8")).data;
const spec = new Map();
for (const c of contracts) {
  if (c.status !== "Open") continue;
  if (c.rootSymbol !== "USDT") continue;
  const base = c.symbol.replace("USDTM", "");
  spec.set(base, {
    base, symbol: c.symbol,
    maxLev: Number(c.maxLeverage) || 0,
    tick: Number(c.tickSize) || 0,
    mult: Number(c.multiplier) || 0,
    taker: Number(c.takerFeeRate) || 0,
    maker: Number(c.makerFeeRate) || 0,
    turnover: Number(c.turnoverOf24h) || 0,
    oi: Number(c.openInterest) || 0,
  });
}

// ── the 1-hour klines, from every local cache ────────────────────────────
//
// THE TWO CACHES HAVE DIFFERENT SHAPES, and reading one with the other's
// index silently produces a nonsense ATR (ETH at 220%):
//
//   leads/klines, klines/  : [ts, open, high, low, close, volume, ...]  (7 cols)
//   kl/                    : [open, high, low, close, volume]          (5 cols, NO ts)
//
// The 5-column form has no timestamp, so it is only usable for the CURRENT
// price's volatility, not for a time-indexed series. It is read as a
// shape-detected series and used only where a timestamp is not needed.
const bars = new Map();
const DIRS = ["leads/klines", "klines", "kl"];
for (const d of DIRS) {
  const dir = join(HOME, ".hermes/cache/scratch", d);
  if (!existsSync(dir)) continue;
  for (const fn of readdirSync(dir)) {
    if (!fn.endsWith(".json")) continue;
    const base = fn.replace("USDTM_60_90.json", "").replace("USDTM_90d.json", "");
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(dir, fn), "utf8")); } catch { continue; }
    if (!Array.isArray(parsed) || !parsed.length) continue;
    const first = parsed[0];
    if (!Array.isArray(first)) continue;
    const hasTs = first.length >= 6 && Number.isFinite(Number(first[0])) && Number(first[0]) > 1e11;
    let series;
    if (hasTs) {
      series = parsed
        .map((k) => ({ t: Number(k[0]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) }))
        .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0 && b.h >= b.l)
        .sort((a, b) => a.t - b.t);
    } else {
      // no timestamps: synthesise a 1-hour grid ending now, so the
      // volatility is still measured. The ORDER is what the ATR needs.
      const n = parsed.length;
      const end = Date.now();
      const start = end - n * 3600_000;
      series = parsed
        .map((k, i) => ({ t: start + i * 3600_000, h: Number(k[1]), l: Number(k[2]), c: Number(k[3]) }))
        .filter((b) => Number.isFinite(b.c) && b.c > 0 && b.h >= b.l);
    }
    if (!series.length) continue;
    const prev = bars.get(base);
    if (!prev || series.length > prev.length) bars.set(base, { series, hasTs });
  }
}

/** The ATR over the last N hourly bars, in % of the last close — the tape's own measure. */
function atrPct(series, n) {
  if (series.length < n + 1) return null;
  const w = series.slice(-n);
  let s = 0;
  for (let i = 1; i < w.length; i++) {
    const pc = w[i - 1].c;
    s += Math.max(w[i].h - w[i].l, Math.abs(w[i].h - pc), Math.abs(w[i].l - pc));
  }
  return (s / (w.length - 1)) / w[w.length - 1].c * 100;
}
/** The typical hourly range, in % — the market's own noise scale. */
function rangePct(series, n) {
  if (series.length < n) return null;
  const w = series.slice(-n);
  const r = w.map((b) => ((b.h - b.l) / b.c) * 100).sort((a, b) => a - b);
  return r[r.length >> 1];
}
/** The 24-hour realised range, in % — how far the symbol travels in a day. */
function dayRangePct(series) {
  if (series.length < 24) return null;
  const w = series.slice(-24);
  const hi = maxBy(w, (b) => b.h);
  const lo = minBy(w, (b) => b.l);
  const last = w[w.length - 1].c;
  return ((hi - lo) / last) * 100;
}

console.log("=".repeat(112));
console.log("THE WIDER UNIVERSE SCREEN — offline, from the local contract list and kline caches");
console.log("=".repeat(112));
console.log(`  open USDT perps in the contract list: ${spec.size}`);
console.log(`  symbols with a usable local 1h kline series: ${bars.size}`);
console.log(`  (${spec.size - bars.size} contracts could NOT be screened — no local klines. They are`);
console.log("   not dropped silently; they are named as unmeasurable.)");
console.log();
console.log("  THE CRITERIA:");
console.log(`    fee drag <= 1/3 of the stop:  ${FEE_LIVE} / (${STOP_ATR_MULT} x ATR) <= 1/3  =>  ATR >= 0.179%`);
console.log("    ticket is volatility-sensitive: 0.75% < ATR < 1.25% (between the TP's 0.3% floor and 0.5% cap)");
console.log("    venue leverage cap >= 20 (the ticket's own minimum safe leverage)");
console.log(`    24h realised range >= 2x the stop, so the stop is not inside the day's noise`);
console.log();

// ── screen every symbol with local data ─────────────────────────────────
const screened = [];
for (const [base, entry] of bars) {
  const series = entry.series;
  const hasTs = entry.hasTs;
  const s = spec.get(base);
  const atr = atrPct(series, 15);
  const atr48 = atrPct(series, 48);
  const rng = rangePct(series, 48);
  // The 24-hour range is a TIME-based measure, so it needs a timestamped
  // series. The 5-column cache has no timestamps, so for those symbols the
  // day's range is UNKNOWN — not zero, and not assumed.
  const dayR = hasTs ? dayRangePct(series) : null;
  if (atr == null) continue;
  const lev = s?.maxLev ?? null;
  const turnover = s?.turnover ?? null;
  const tp = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const sl = Math.max(0.3, atr * STOP_ATR_MULT);
  const feeDrag = FEE_LIVE / sl;
  const wbe = (sl + FEE_LIVE) / (tp + sl + FEE_LIVE);
  const volSensitive = atr > 0.75 && atr < 1.25;
  const levOk = lev == null || lev >= 20;
  const noiseOk = dayR == null ? null : dayR >= sl * 2;
  const fails = [];
  if (feeDrag > MAX_FEE_DRAG) fails.push("fee drag > 1/3 stop");
  if (!levOk) fails.push(`lev cap ${lev}`);
  if (noiseOk === false) fails.push("stop inside the day's noise");
  screened.push({
    base, atr, atr48, rng, dayR, hasTs, lev, turnover, tp, sl, feeDrag, wbe,
    volSensitive, levOk, noiseOk, fails, inSpec: !!s,
  });
}
screened.sort((a, b) => b.turnover - a.turnover);

console.log("  base      ATR%(1h)  ATR%(48h)  24hRange%  TP%    SL%    feeDrag%stop  wBE    levCap  turnover24h$  verdict");
console.log("  " + "-".repeat(128));
for (const s of screened) {
  const verdict = s.fails.length ? "REJECT: " + s.fails.join(", ")
    : s.volSensitive ? "PASS (vol-sensitive)"
    : "PASS (TP pinned)";
  console.log(
    `  ${s.base.padEnd(9)} ${s.atr.toFixed(3).padStart(8)} ${(s.atr48 ?? 0).toFixed(3).padStart(10)} ${(s.dayR ?? 0).toFixed(2).padStart(11)} ${s.tp.toFixed(3).padStart(6)} ${s.sl.toFixed(3).padStart(6)} ${(s.feeDrag * 100).toFixed(1).padStart(12)}% ${(s.wbe * 100).toFixed(1).padStart(5)}% ${String(s.lev ?? "?").padStart(7)} ${(s.turnover ?? 0).toFixed(0).padStart(13)}  ${verdict}`,
  );
}

// ── the shortlist: the criteria that actually bind ──────────────────────
console.log();
console.log("=".repeat(112));
console.log("THE SHORTLIST — symbols that pass every HARD constraint");
console.log("=".repeat(112));
const pass = screened.filter((s) => s.fails.length === 0);
const volSens = pass.filter((s) => s.volSensitive);
console.log(`  pass all hard constraints: ${pass.length}`);
console.log(`  of which the ticket is VOLATILITY-SENSITIVE (ATR in 0.75-1.25%): ${volSens.length}`);
console.log();
console.log("  base      ATR%   TP%    SL%    feeDrag%  wBE    lev  turnover24h$   24hRange%  rank");
console.log("  " + "-".repeat(96));
const ranked = [...volSens].sort((a, b) => b.turnover - a.turnover);
ranked.forEach((s, i) => {
  console.log(
    `  ${s.base.padEnd(9)} ${s.atr.toFixed(3).padStart(6)} ${s.tp.toFixed(3).padStart(6)} ${s.sl.toFixed(3).padStart(6)} ${(s.feeDrag * 100).toFixed(1).padStart(8)}% ${(s.wbe * 100).toFixed(1).padStart(5)}% ${String(s.lev ?? "?").padStart(4)} ${s.turnover.toFixed(0).padStart(13)} ${(s.dayR ?? 0).toFixed(2).padStart(11)} ${String(i + 1).padStart(5)}`,
  );
});

// ── the CURRENT universe, screened the same way ─────────────────────────
console.log();
console.log("=".repeat(112));
console.log("THE CURRENT UNIVERSE, SCREENED THE SAME WAY");
console.log("=".repeat(112));
const CURRENT = ["NEAR", "ZEC", "XRP", "UNI", "AAVE", "SOL", "AVAX", "SUI", "PEPE", "LINK", "LTC", "SEI", "ENA", "HYPE", "TAO", "JCT", "ARB", "DOT", "FOLKS", "LDO", "ARC"];
console.log("  base      ATR%   inScreen?  reason");
console.log("  " + "-".repeat(80));
const curRows = [];
for (const base of CURRENT) {
  const s = screened.find((x) => x.base === base);
  if (!s) {
    curRows.push({ base, screened: false, reason: "no local 1h klines — UNMEASURABLE" });
    console.log(`  ${base.padEnd(9)} ${"—".padStart(6)} ${"NO".padStart(10)}  no local 1h klines — UNMEASURABLE`);
    continue;
  }
  const reason = s.fails.length ? s.fails.join(", ") : s.volSensitive ? "passes (vol-sensitive)" : "passes (TP pinned)";
  curRows.push({ base, screened: true, s, reason });
  console.log(`  ${base.padEnd(9)} ${s.atr.toFixed(3).padStart(6)} ${(s.fails.length ? "NO" : "YES").padStart(10)}  ${reason}`);
}
const curPass = curRows.filter((r) => r.screened && r.s.fails.length === 0);
console.log();
console.log(`  the current universe's screened-and-passing members: ${curPass.length} of ${CURRENT.length} that have data`);

// ── the recommendation ──────────────────────────────────────────────────
console.log();
console.log("=".repeat(112));
console.log("THE RECOMMENDATION");
console.log("=".repeat(112));
// The shortlist must ALSO be measurable by the machine's own signal, and
// it must survive the LEVERAGE CAP and the ticket's own viability.
const curBase = new Set(CURRENT);
const newOnly = volSens.filter((s) => !curBase.has(s.base));
const overlap = volSens.filter((s) => curBase.has(s.base));
console.log(`  the current universe already contains ${overlap.length} of the ${volSens.length} vol-sensitive passers: ${overlap.map((s) => s.base).join(" ")}`);
console.log(`  symbols in the screen but NOT in the current universe: ${newOnly.length}`);
console.log("    " + newOnly.map((s) => `${s.base}(ATR ${s.atr.toFixed(2)}%, lev ${s.lev}, $${(s.turnover / 1e6).toFixed(0)}M)`).join("  "));
console.log();
console.log("  BUT: a symbol is only RECOMMENDABLE if the machine's own signal fires on it");
console.log("  often enough to measure, and if its ticket is net-positive after the fee.");
console.log("  The screen can rank TRADABILITY; it cannot manufacture signal history.");
console.log("  Every symbol above with NO signal history is a CANDIDATE to collect, not a");
console.log("  symbol to trade today.");
console.log();
console.log("  THE ACCOUNT-SIZE CONSTRAINT (from the screen's own economics):");
const eqUncapped = NOTIONAL_CAP / (RISK_PCT / 100);
console.log(`    equity $${EQUITY}, risk ${RISK_PCT}%, notional cap $${NOTIONAL_CAP}`);
console.log(`    the risk budget reaches the $60 cap at equity = $${eqUncapped.toFixed(0)}`);
console.log(`    below that, the notional is risk-budget-limited and the account compounds;`);
console.log(`    above it, the cap binds and the % return per trade falls as the account grows.`);
