/**
 * KuCoin futures public tape (no auth) + pure exhaustion math.
 * Same upstream the venue serves; used by `scan fade`. Unit-tested —
 * network stays at the edges, math stays pure.
 */
import { fetchJson as httpJson } from "./http.js";

const FUT = "https://api-futures.kucoin.com";

async function futJson(path: string, timeoutMs = 20000): Promise<unknown> {
  return httpJson(`${FUT}${path}`, {}, { timeoutMs });
}

/**
 * Shared KuCoin futures reads — one base URL + UA via futJson.
 * (grid.ts used to re-implement these against the same endpoints.)
 */

export type ContractSpec = { multiplier: number; tick: number };

/** Contract spec for `<BASE>USDTM` (level sizing + tick rounding). */
export async function futuresContractSpec(base: string): Promise<ContractSpec> {
  const d = (await futJson(`/api/v1/contracts/${encodeURIComponent(`${base}USDTM`)}`)) as {
    data: Record<string, number>;
  };
  // ── THE TICK IS `tickSize`, NOT `priceIncrement` ──
  //
  // KuCoin's contract endpoint returns `tickSize` (0.001 for AVAX,
  // 0.0001 for XBT). There is NO `priceIncrement` field, so reading it
  // always yielded undefined, and `Number(undefined ?? 0) || 0` made
  // the tick 0 on EVERY contract.
  //
  // A tick of 0 means the price grid is never applied: the entry, the
  // stop and the take-profit are placed at OFF-GRID prices. KuCoin
  // rejects off-grid prices, so the exit leg FAILS — and a failed exit
  // leg on a leveraged position is the "open position with no stop"
  // state, the worst state a trading system can be in.
  //
  // Observed live: every ticket carried "tickSize": 0.
  // There is deliberately NO fallback to another field name: the venue
  // has exactly one tick field, and a silent fallback to a field that
  // does not exist is how the tick became 0 on every contract.
  const tickRaw = d.data?.tickSize;
  const tick = Number(tickRaw);
  if (!(tick > 0)) {
    throw new Error(`contract spec for ${base} has no tick size (tickSize=${String(tickRaw)}) — prices cannot be placed on the venue's price grid`);
  }
  return {
    multiplier: Number(d.data?.multiplier ?? 1) || 1,
    tick,
  };
}

/** Last price for `<BASE>USDTM` (grid center). */
export async function futuresCenter(base: string): Promise<number> {
  const sym = `${base}USDTM`;
  const d = (await futJson(`/api/v1/ticker?symbol=${encodeURIComponent(sym)}`)) as {
    data: { price: string };
  };
  const p = Number(d.data?.price);
  if (!(p > 0)) throw new Error(`bad center price for ${sym}`);
  return p;
}

/** Paged kline closes — the venue caps at 200 candles per request. */
export async function futuresCloses(
  symbol: string,
  granularityMin: number,
  fromMs: number,
  toMs: number,
): Promise<number[]> {
  const closes: number[] = [];
  const chunk = 200 * granularityMin * 60 * 1000;
  for (let s = fromMs; s < toMs; s += chunk) {
    const e = Math.min(s + chunk, toMs);
    const kl = (await futJson(
      `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granularityMin}&from=${s}&to=${e}`,
    )) as { data: number[][] };
    for (const k of kl.data ?? []) {
      const c = Number(k[4]);
      if (c > 0) closes.push(c);
    }
  }
  return closes;
}

export type FadeMetrics = {
  chg: number;
  vratio: number;
  vslope: "up" | "down";
  offHighPct: number;
  offLowPct: number;
  atrPct: number | null;
  fundingPct: number | null;
  last: number;
  n: number;
};

/** Pure: recent-12h vs prior-12h volume, slope sign, distance from high/low, ATR%. */
export function fadeMetrics(
  closes: number[],
  vols: number[],
  highs?: number[],
  lows?: number[],
): Omit<FadeMetrics, "fundingPct" | "last"> | null {
  if (closes.length < 24 || vols.length < 24) return null;
  const recent = vols.slice(-12);
  const prior = vols.slice(-24, -12);
  const rmean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const pmean = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!(pmean > 0)) return null;
  const mean = 5.5;
  const slope = recent.reduce((acc, v, i) => acc + (i - mean) * (v - rmean), 0);
  const window = closes.slice(-24);
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const last = closes[closes.length - 1] as number;
  if (!(hi > 0) || !(lo > 0) || !Number.isFinite(last)) return null;
  const first = closes[closes.length - 24] as number;
  let atrPct: number | null = null;
  if (highs && lows && highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
    const h = highs.slice(-15);
    const l = lows.slice(-15);
    const c = closes.slice(-15);
    const trs: number[] = [];
    for (let i = 1; i < 15; i++) {
      const prev = c[i - 1] as number;
      trs.push(Math.max(
        (h[i] as number) - (l[i] as number),
        Math.abs((h[i] as number) - prev),
        Math.abs((l[i] as number) - prev),
      ));
    }
    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    if (atr > 0 && last > 0) atrPct = (atr / last) * 100;
  }
  return {
    chg: first !== 0 ? ((last - first) / first) * 100 : 0,
    vratio: rmean / pmean,
    vslope: slope < 0 ? "down" : "up",
    offHighPct: ((hi - last) / hi) * 100,
    offLowPct: ((last - lo) / lo) * 100,
    atrPct,
    n: closes.length,
  };
}

export type FadeRow = FadeMetrics & { symbol: string };

export async function futuresFade(base: string): Promise<FadeRow> {
  const sym = `${base}USDTM`;
  const now = Date.now();
  const [ticker, klines] = await Promise.all([
    futJson(`/api/v1/ticker?symbol=${encodeURIComponent(sym)}`) as Promise<{ data: { price: string } }>,
    futJson(
      `/api/v1/kline/query?symbol=${encodeURIComponent(sym)}&granularity=60&from=${now - 60 * 3600 * 1000}&to=${now}`,
    ) as Promise<{ data: [number, number, number, number, number, number][] }>,
  ]);
  const last = Number(ticker.data?.price ?? 0);
  const kl = Array.isArray(klines.data) ? klines.data : [];
  const closes = kl.map((k) => Number(k[4])).filter(Number.isFinite);
  const vols = kl.map((k) => Number(k[5])).filter(Number.isFinite);
  const highs = kl.map((k) => Number(k[2])).filter(Number.isFinite);
  const lows = kl.map((k) => Number(k[3])).filter(Number.isFinite);
  const m = fadeMetrics(closes, vols, highs, lows);
  if (!m || !(last > 0)) throw new Error(`thin tape for ${sym}`);
  let funding: number | null = null;
  try {
    const f = (await futJson(`/api/v1/funding-rate/${encodeURIComponent(sym)}/current`)) as {
      data: { value: string };
    };
    const v = Number(f.data?.value ?? NaN);
    if (Number.isFinite(v)) funding = v * 100;
  } catch {
    funding = null;
  }
  return { symbol: sym, last, fundingPct: funding, ...m };
}

/** Exhaustion-short read: faded volume while still near the high. */
export function fadeSignal(r: FadeRow): "fade-short" | "strong" | "late" | "neutral" {
  if (r.offHighPct > 15) return "late";
  if (r.vratio < 0.85 && r.offHighPct < 8) return "fade-short";
  if (r.vratio > 3) return "strong";
  return "neutral";
}

/** Dip-long mirror: sell volume faded while still near the low. */
export function dipSignal(r: FadeRow): "dip-long" | "capitulation" | "extended" | "neutral" {
  if (r.offLowPct > 15) return "extended";
  if (r.vratio > 3) return "capitulation";
  if (r.vratio < 0.85 && r.offLowPct < 8) return "dip-long";
  return "neutral";
}

export type ScalpStep = { step: number; price: number; sizeUsd: number; dropFromLastPct: number };
export type ScalpPlan = {
  direction: "long" | "short";
  last: number;
  atrPct: number | null;
  tpPct: number;
  stepDropPct: number;
  steps: ScalpStep[];
  avgEntry: number;
  tpPrice: number;
  tpProfitUsd: number;
  killPrice: number;
  killLossUsd: number;
  maxCapitalUsd: number;
};

/**
 * Pure: derive the whole scalp mechanic from measured volatility.
 * TP 0.3–0.5% scaled to ATR; steps spaced wider than TP so a step only
 * fills on a real adverse move; sizes 1/1/2; kill line one step-drop
 * past the last fill — the admit-defeat level with its dollar cost.
 */
export function planScalp(
  last: number,
  atrPct: number | null,
  direction: "long" | "short",
  baseSizeUsd: number,
  maxSteps = 3,
): ScalpPlan | null {
  if (!(last > 0) || !(baseSizeUsd > 0)) return null;
  const steps = Math.min(Math.max(Math.round(maxSteps), 1), 3);
  const atr = atrPct != null && Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0.8;
  const tpPct = Math.min(0.5, Math.max(0.3, atr * 0.4));
  const stepDropPct = Math.min(1.5, Math.max(0.6, atr * 0.9));
  const mults = [1, 1, 2].slice(0, steps);
  const dirSign = direction === "long" ? -1 : 1; // adverse excursion direction
  const planSteps: ScalpStep[] = mults.map((m, i) => {
    const drop = i * stepDropPct;
    return {
      step: i + 1,
      price: last * (1 + (dirSign * drop) / 100),
      sizeUsd: baseSizeUsd * m,
      dropFromLastPct: drop,
    };
  });
  const totalSize = planSteps.reduce((a, s) => a + s.sizeUsd, 0);
  const avgEntry = planSteps.reduce((a, s) => a + s.price * s.sizeUsd, 0) / totalSize;
  const tpDir = direction === "long" ? 1 : -1;
  // ── THE TAKE-PROFIT MUST BE BEYOND THE MARKET ──
  //
  // The take-profit is derived from the MARKET, not from the ladder's
  // offset average entry.
  //
  // The old construction derived it from `avgEntry`, which sits
  // `dirSign x d/200` away from the market — so for a SHORT the target
  // was ABOVE the last price (tp would have to exceed d/2 to clear it,
  // and tp = 0.4 x ATR while d = 0.9 x ATR, so it never does). A buy
  // limit above the market is MARKETABLE: it fills instantly at the ask.
  //
  // So the "take-profit" was a scratch that booked a full target in
  // every simulation and a fee in every real trade.
  //
  // Measured live on 2026-10-21: 6 of the 8 real round trips were
  // scratches, closing in 4-7 seconds, net -$0.5708 on $0.5672 of
  // fees. Measured on the collector's data: 302 of 386 first-bar
  // take-profits were already satisfied at the entry.
  //
  // The take-profit is now measured from the market, so it is a real
  // target that the market has to MOVE to reach. The stop keeps the
  // same distance from the entry as before, so the risk — and therefore
  // the sizing — is unchanged.
  const tpPrice = last * (1 + (tpDir * tpPct) / 100);
  const tpProfitUsd = (totalSize * tpPct) / 100;
  const killPrice = last * (1 + (dirSign * (steps * stepDropPct)) / 100);
  const killLossUsd = planSteps.reduce(
    (a, s) => a + s.sizeUsd * (Math.abs(killPrice - s.price) / s.price),
    0,
  );
  return {
    direction, last, atrPct, tpPct, stepDropPct,
    steps: planSteps, avgEntry, tpPrice, tpProfitUsd,
    killPrice, killLossUsd, maxCapitalUsd: totalSize,
  };
}

export type GridBias = "long" | "short" | "neutral";
export type GridLevel = { side: "buy" | "sell"; price: number; stepsFromCenter: number };
export type GridPlan = {
  center: number;
  stepPct: number;
  levelsPerSide: number;
  bias: GridBias;
  /** Opening inventory held from the start (covers the far side). */
  seedContracts: number;
  lower: number;
  upper: number;
  rangePct: number;
  levels: GridLevel[];
};

/**
 * Directional futures grid (geometric ladder, N levels each side):
 * - neutral: flat start, buys below + sells above, refill both ways.
 * - long: seeded LONG (covers every sell level), buys below accumulate
 *   and re-sell upward — up moves pay from inventory, down moves reload.
 * - short: mirror (seeded SHORT covering every buy level).
 */
export function gridLadder(
  center: number,
  stepPct: number,
  levelsPerSide: number,
  bias: GridBias = "neutral",
  contractsPerLevel = 1,
): GridPlan | null {
  if (!(center > 0) || !(stepPct > 0) || stepPct > 5) return null;
  const n = Math.min(Math.max(Math.round(levelsPerSide), 1), 100);
  const c = Math.max(1, Math.round(contractsPerLevel));
  const f = 1 + stepPct / 100;
  const levels: GridLevel[] = [];
  for (let i = 1; i <= n; i++) {
    levels.push({ side: "buy", price: center / Math.pow(f, i), stepsFromCenter: -i });
    levels.push({ side: "sell", price: center * Math.pow(f, i), stepsFromCenter: i });
  }
  levels.sort((a, b) => a.price - b.price);
  const lower = center / Math.pow(f, n);
  const upper = center * Math.pow(f, n);
  const seedContracts = bias === "neutral" ? 0 : n * c;
  return {
    center, stepPct, levelsPerSide: n, bias, seedContracts, lower, upper,
    rangePct: ((upper - lower) / center) * 100,
    levels,
  };
}

export type GridBacktest = {
  candles: number;
  fills: number;
  realizedUsd: number;
  endPosition: number;
  inventoryUpnlUsd: number;
  totalUsd: number;
  returnPct: number;
  rangeBreaks: number;
  maxAdversePct: number;
  capitalUsd: number;
};

/**
 * Pure event-driven grid replay on chronological closes.
 * Model (stated limits): fills trigger on close crossing a level, fees
 * flat % per fill, no spread/slippage beyond the fee, one refill step
 * per fill (buy fill re-arms the sell one step above and vice versa),
 * range breaks are held (no stop) and counted. Average-cost accounting.
 */
export function backtestGrid(
  closes: number[],
  center: number,
  stepPct: number,
  levelsPerSide: number,
  contracts: number,
  multiplier: number,
  bias: GridBias,
  leverage: number,
  feePerFillPct = 0.06,
  capitalUsd = 0,
): GridBacktest | null {
  const ladder = gridLadder(center, stepPct, levelsPerSide, bias, contracts);
  if (!ladder || closes.length < 2) return null;
  const f = 1 + stepPct / 100;
  const n = ladder.levelsPerSide;
  const feeFrac = feePerFillPct / 100;
  // Active one-shot rungs: buys at offsets -n..0, sells at 0..n.
  // Price is always derived from the rung — never from float keys.
  const priceOf = (o: number): number =>
    o < 0 ? center / Math.pow(f, -o) : o > 0 ? center * Math.pow(f, o) : center;
  const buys = new Set<number>();
  const sells = new Set<number>();
  for (let i = 1; i <= n; i++) {
    buys.add(-i);
    sells.add(i);
  }
  let pos = bias === "long" ? n * contracts : bias === "short" ? -n * contracts : 0;
  let avg = center;
  let realized = -Math.abs(pos) * multiplier * center * feeFrac; // seed fee
  let fills = 0;
  let breaks = 0;
  let maxAdv = 0;
  const unit = contracts * multiplier;
  const fillBuy = (o: number): void => {
    const px = priceOf(o);
    realized -= unit * px * feeFrac;
    if (pos < 0) {
      realized += Math.min(contracts, -pos) * multiplier * (avg - px); // cover short
      pos += contracts;
      if (pos > 0) avg = px;
      else if (pos === 0) avg = center;
    } else {
      avg = pos === 0 ? px : (avg * pos + px * contracts) / (pos + contracts);
      pos += contracts;
    }
    fills++;
    if (o + 1 <= n) sells.add(o + 1); // re-arm one rung up
  };
  const fillSell = (o: number): void => {
    const px = priceOf(o);
    realized -= unit * px * feeFrac;
    if (pos > 0) {
      realized += Math.min(contracts, pos) * multiplier * (px - avg); // sell long
      pos -= contracts;
      if (pos < 0) avg = px;
      else if (pos === 0) avg = center;
    } else {
      avg = pos === 0 ? px : (avg * -pos + px * contracts) / (-pos + contracts);
      pos -= contracts;
    }
    fills++;
    if (o - 1 >= -n) buys.add(o - 1); // re-arm one rung down
  };
  for (const px of closes) {
    if (!(px > 0)) continue;
    const adv = Math.abs(px - center) / center;
    if (adv > maxAdv) maxAdv = adv;
    if (px < ladder.lower || px > ladder.upper) breaks++;
    for (const o of [...buys]) {
      if (priceOf(o) >= px) {
        buys.delete(o);
        fillBuy(o);
      }
    }
    for (const o of [...sells]) {
      if (priceOf(o) <= px) {
        sells.delete(o);
        fillSell(o);
      }
    }
  }
  const last = closes[closes.length - 1] as number;
  const upnl = pos > 0
    ? pos * multiplier * (last - avg)
    : pos < 0 ? -pos * multiplier * (avg - last) : 0;
  const capital = capitalUsd > 0
    ? capitalUsd
    : (((bias === "neutral" ? 0 : n * contracts) + n * contracts) * multiplier * center) / Math.max(1, leverage);
  const total = realized + upnl;
  return {
    candles: closes.length, fills, realizedUsd: realized,
    endPosition: pos, inventoryUpnlUsd: upnl, totalUsd: total,
    returnPct: capital > 0 ? (total / capital) * 100 : 0,
    rangeBreaks: breaks, maxAdversePct: maxAdv * 100, capitalUsd: capital,
  };
}

const SKIP_BASES = new Set(["USDC", "USDT", "DAI", "TUSD", "USDP", "BTC", "ETH"]);

export function scanBase(s: string): string | null {
  const base = s.split("/")[0]?.toUpperCase() ?? "";
  if (!base || SKIP_BASES.has(base)) return null;
  if (/[^A-Z0-9]/.test(base)) return null;
  if (/(UP|DOWN|BULL|BEAR|3L|3S)$/.test(base) && base.length > 4) return null;
  return base;
}

/* ------------------------------------------------------------------ */
/* spikes — KuCoin futures spike monitor (READ-ONLY, no trades).        */
/* Promoted from /tmp/kucoin_spike_monitor.py into the CLI as         */
/* `jw3 spikes`. Network stays at the edges (futJson only); all       */
/* trigger rules below are pure + unit-tested. Kline columns follow   */
/* the venue: [ts, open, high, low, close, volume(lots), turnover].   */
/* ------------------------------------------------------------------ */

export const SPIKE_IMB_T = 0.4;

export type SpikeSymbolCfg = {
  symbol: string;
  base: string;
  mult: number;
  volFloor: number;
  thrustPct: number;
  spreadBps: number;
  wallMin: number;
};

export const SPIKE_SYMS: Record<string, SpikeSymbolCfg> = {
  XBTUSDTM: { symbol: "XBTUSDTM", base: "XBT", mult: 0.001, volFloor: 2500, thrustPct: 0.1, spreadBps: 5, wallMin: 10000 },
  ETHUSDTM: { symbol: "ETHUSDTM", base: "ETH", mult: 0.01, volFloor: 4000, thrustPct: 0.1, spreadBps: 5, wallMin: 10000 },
  SOLUSDTM: { symbol: "SOLUSDTM", base: "SOL", mult: 0.1, volFloor: 4000, thrustPct: 0.1, spreadBps: 5, wallMin: 10000 },
  GRAMUSDTM: { symbol: "GRAMUSDTM", base: "GRAM", mult: 1.0, volFloor: 5000, thrustPct: 0.25, spreadBps: 10, wallMin: 1000 },
  SUIUSDTM: { symbol: "SUIUSDTM", base: "SUI", mult: 1.0, volFloor: 5000, thrustPct: 0.15, spreadBps: 5, wallMin: 5000 },
  DOTUSDTM: { symbol: "DOTUSDTM", base: "DOT", mult: 1.0, volFloor: 5000, thrustPct: 0.15, spreadBps: 5, wallMin: 2000 },
  DOGEUSDTM: { symbol: "DOGEUSDTM", base: "DOGE", mult: 100.0, volFloor: 2000, thrustPct: 0.15, spreadBps: 5, wallMin: 2000 },
  PEPEUSDTM: { symbol: "PEPEUSDTM", base: "PEPE", mult: 520000.0, volFloor: 5000, thrustPct: 0.25, spreadBps: 10, wallMin: 1000 },
  UNIUSDTM: { symbol: "UNIUSDTM", base: "UNI", mult: 1.0, volFloor: 500, thrustPct: 0.15, spreadBps: 5, wallMin: 1000 },
};

export const SPIKE_DEFAULT_SYMS = ["XBTUSDTM", "ETHUSDTM", "SOLUSDTM", "GRAMUSDTM"];

/** Base (XBT/BTC/ETH/SOL/GRAM/SUI/DOT/DOGE/PEPE/UNI) → futures symbol. BTC is an alias of XBT. */
export function spikeSymbolForBase(base: string): string | null {
  const b = base.trim().toUpperCase();
  if (b === "XBT" || b === "BTC") return "XBTUSDTM";
  if (b === "ETH") return "ETHUSDTM";
  if (b === "SOL") return "SOLUSDTM";
  if (b === "GRAM") return "GRAMUSDTM";
  if (b === "SUI") return "SUIUSDTM";
  if (b === "DOT") return "DOTUSDTM";
  if (b === "DOGE") return "DOGEUSDTM";
  if (b === "PEPE") return "PEPEUSDTM";
  if (b === "UNI") return "UNIUSDTM";
  return null;
}

export type SpikeLevel = { price: number; notional: number };

/** Pure: lot sizes × price × multiplier → USD notionals. */
export function spikeNotionals(levels: [unknown, unknown][], mult: number): SpikeLevel[] {
  const out: SpikeLevel[] = [];
  for (const [pRaw, sRaw] of levels) {
    const p = Number(pRaw);
    const s = Number(sRaw);
    if (!(p > 0) || !Number.isFinite(s)) continue;
    out.push({ price: p, notional: s * p * mult });
  }
  return out;
}

/** Pure: (bid5 − ask5) / (bid5 + ask5), 0 on an empty book. */
export function spikeImbalance(bid5: number, ask5: number): number {
  if (!((bid5 + ask5) > 0)) return 0;
  return (bid5 - ask5) / (bid5 + ask5);
}

/** Pure: spread in basis points, 0 without a mid. */
export function spikeSpreadBps(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return 0;
  return ((ask - bid) / mid) * 1e4;
}

function sortedNums(xs: number[]): number[] {
  return [...xs].filter(Number.isFinite).sort((a, b) => a - b);
}

function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const m = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[m] as number) : (((sorted[m - 1] as number) + (sorted[m] as number)) / 2);
}

/**
 * Pure: volume trigger = max(3×median, p90, floor) over baseline lots.
 * Mirrors the spike-monitor rule so quiet books still need the floor.
 */
export function spikeVolTrigger(vols: number[], floor: number): number {
  const s = sortedNums(vols);
  if (s.length === 0) return floor;
  const med = medianOf(s);
  const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] as number;
  return Math.max(3 * med, p90, floor);
}

/** Pure: closed-bar stats for the baseline window. */
export function spikeBaselineStats(vols: number[]): { n: number; volMed: number; volP90: number; volMax: number } {
  const s = sortedNums(vols);
  if (s.length === 0) return { n: 0, volMed: 0, volP90: 0, volMax: 0 };
  return {
    n: s.length,
    volMed: medianOf(s),
    volP90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] as number,
    volMax: s[s.length - 1] as number,
  };
}

/** Pure: 1m thrust — |close/open − 1| in % vs the per-symbol threshold. */
export function spikeThrust(open: number, close: number, thrustPct: number): { retPct: number; fired: boolean } {
  if (!(open > 0) || !Number.isFinite(close)) return { retPct: 0, fired: false };
  const retPct = (close / open - 1) * 100;
  return { retPct, fired: Math.abs(retPct) >= thrustPct };
}

/**
 * Pure: spoof/absorption wall — first level ≥ 6× the side median AND
 * ≥ wallMin USD. Returns null on a flat book (never invents one).
 */
export function spikeWall(
  side: SpikeLevel[],
  wallMin: number,
): { price: number; notional: number; median: number } | null {
  if (side.length === 0) return null;
  const med = medianOf(sortedNums(side.map((l) => l.notional)));
  if (!(med > 0)) return null;
  for (const l of side) {
    if (l.notional >= 6 * med && l.notional >= wallMin) return { price: l.price, notional: l.notional, median: med };
  }
  return null;
}

export type SpikeTicker = {
  price: number;
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
};

/** Public ticker read (no auth): last + best bid/ask with sizes. */
export async function futuresTickerFull(symbol: string): Promise<SpikeTicker> {
  const d = (await futJson(`/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`)) as {
    data: Record<string, string>;
  };
  const t = {
    price: Number(d.data?.price),
    bestBid: Number(d.data?.bestBidPrice),
    bestAsk: Number(d.data?.bestAskPrice),
    bestBidSize: Number(d.data?.bestBidSize ?? 0),
    bestAskSize: Number(d.data?.bestAskSize ?? 0),
  };
  if (!(t.bestBid > 0) || !(t.bestAsk > 0)) throw new Error(`bad ticker for ${symbol}`);
  return t;
}

export type SpikeDepth = { bids: [string, string][]; asks: [string, string][] };

/** Public 20-level book read (no auth); sizes are in LOTS. */
export async function futuresDepth20(symbol: string): Promise<SpikeDepth> {
  const d = (await futJson(`/api/v1/level2/depth20?symbol=${encodeURIComponent(symbol)}`)) as {
    data: { bids: [string, string][]; asks: [string, string][] };
  };
  return { bids: d.data?.bids ?? [], asks: d.data?.asks ?? [] };
}

/** Raw kline rows: [ts, open, high, low, close, volume, turnover]. */
export async function futuresKlinesRaw(
  symbol: string,
  granularityMin: number,
  fromMs: number,
  toMs: number,
): Promise<number[][]> {
  const kl = (await futJson(
    `/api/v1/kline/query?symbol=${encodeURIComponent(symbol)}&granularity=${granularityMin}&from=${fromMs}&to=${toMs}`,
  )) as { data: number[][] };
  return Array.isArray(kl.data) ? kl.data : [];
};

/* ------------------------------------------------------------------ */
/* backtest scalp — fade-short/dip-long replay through TP/kill.        */
/* Pure math below; network stays in futuresKlines (paged raw rows).   */
/* Model (stated limits): signals from trailing-24h fadeMetrics on     */
/* hourly bars; single entry at the signal close; TP at tpPct           */
/* (explicit --tp or ATR-derived 0.3–0.5% like planScalp); kill one     */
/* adverse rung out (ATR-derived 0.6–1.5% like planScalp's stepDrop);   */
/* intra-bar TP+kill touch resolves to TP (watch semantics); one        */
/* position at a time; timeout exits at the close after maxHold bars.   */
/* Fees flat % per side (maker 0.02 / taker 0.06), no spread/slippage.  */
/* ------------------------------------------------------------------ */

/** Per-side fee assumptions (KuCoin futures schedule): limit = maker. */
export const SCALP_MAKER_FEE_PCT = 0.02;
export const SCALP_TAKER_FEE_PCT = 0.06;

/**
 * GO needs at least this win rate AND positive net.
 *
 * This is a FLOOR, not the bar. The real bar is the break-even win rate
 * implied by the ACTUAL TP/kill/fee geometry of the run, which the
 * backtest computes as `breakevenWr`. A fixed 62% admits trades whose
 * break-even is 65-81% — a "GO" that is arithmetically a bleed.
 *
 * The verdict therefore requires the win rate to clear BOTH this floor and
 * the computed break-even. See `verdictConservative` / `verdict` below.
 */
export const SCALP_GO_WIN_RATE = 62;

export type ScalpKline = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ScalpBacktestTrade = {
  signalIndex: number;
  direction: "long" | "short";
  entry: number;
  tpPrice: number;
  killPrice: number;
  exit: "tp" | "kill" | "timeout";
  exitPrice: number;
  grossPct: number;
  netPct: number;
  win: boolean;
  /**
   * True when the SAME bar touched both the TP and the kill level — the
   * intra-bar order is unknowable from OHLC. Such a trade is resolved
   * pessimistically (see `ambiguousTie` policy) and must not be counted
   * as a clean win when judging edge.
   */
  ambiguous?: boolean;
};

export type ScalpBacktest = {
  candles: number;
  signals: number;
  trades: ScalpBacktestTrade[];
  wins: number;
  losses: number;
  winRate: number;
  /** Explicit --tp override, or null when each trade used ATR-derived TP. */
  tpPct: number | null;
  feePerSidePct: number;
  totalGrossPct: number;
  totalNetPct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  breakevenWr: number;
  /**
   * The win rate a GO must clear: the higher of the 62% floor and the
   * break-even implied by this run's TP/kill/fee geometry. A verdict that
   * cleared only the floor is a bleed — read this, not the bare verdict.
   */
  goBarWr: number;
  verdict: "GO" | "NO-GO";
  /**
   * Verdict with intra-bar TP/kill ties resolved PESSIMISTICALLY (the
   * tie counts as a loss). The optimistic `verdict` resolves them as a TP,
   * which flatters every fade: an OHLC bar that touches both levels
   * cannot say which came first. `verdictConservative` is the number to
   * trust before sizing real money.
   */
  verdictConservative: "GO" | "NO-GO";
  /** Trades whose bar touched both TP and kill (order unknowable). */
  ambiguousTrades: number;
  /** Net %/expectancy with ties resolved as losses. */
  totalNetPctConservative: number;
  expectancyPctConservative: number;
  winRateConservative: number;
  /**
   * HONEST CONDITIONAL — what a REAL trade would have earned, measured on
   * EVERY bar where the signal fired (not the ambiguous-skipped subset the
   * main series uses). `signals` counts those bars; `trades` counts the
   * resolved ones. `expectancyPctConditional` is the number to trust: a
   * positive `expectancyPct` on the selected sample with a negative
   * `expectancyPctConditional` means the edge was selection, not signal.
   */
  conditionalSignals: number;
  conditionalTrades: number;
  expectancyPctConditional: number;
  totalNetPctConditional: number;
  winRateConditional: number;
  /** Per-side conditional expectancy — the aggregate hides a losing side. */
  conditionalBySide: {
    long: { trades: number; winRate: number; expectancyPct: number };
    short: { trades: number; winRate: number; expectancyPct: number };
  };
};

/** Paged raw kline rows — the venue caps at 200 candles per request. */
export async function futuresKlines(
  symbol: string,
  granularityMin: number,
  fromMs: number,
  toMs: number,
): Promise<number[][]> {
  const rows: number[][] = [];
  const chunk = 200 * granularityMin * 60 * 1000;
  for (let s = fromMs; s < toMs; s += chunk) {
    const e = Math.min(s + chunk, toMs);
    const kl = await futuresKlinesRaw(symbol, granularityMin, s, e);
    for (const k of kl) rows.push(k);
  }
  return rows;
}

// `backtestScalp` (the `backtest scalp` preset) lives in replay-core.ts —
// the one replay core every backtest / farm / replay engine runs on (OQ-10).
