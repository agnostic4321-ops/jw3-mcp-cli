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

/**
 * Pure: replay fade-short (short) / dip-long (long) signals from
 * trailing-24-bar windows through the TP/kill ladder with fee math.
 * Ambiguous bars (both signals) are skipped — no invented edge.
 * Returns null on thin history (< 25 bars).
 */
export function backtestScalp(
  klines: ScalpKline[],
  opts: { tpPct?: number; feePerSidePct?: number; maxHold?: number } = {},
): ScalpBacktest | null {
  const n = klines.length;
  if (n < 25) return null;
  const fee = opts.feePerSidePct ?? SCALP_TAKER_FEE_PCT;
  const maxHold = Math.min(Math.max(Math.round(opts.maxHold ?? 24), 1), 240);
  const fixedTp = opts.tpPct != null && Number.isFinite(opts.tpPct) && opts.tpPct > 0 ? opts.tpPct : null;
  const closes = klines.map((k) => k.close);
  const vols = klines.map((k) => k.volume);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const trades: ScalpBacktestTrade[] = [];
  let signals = 0;
  let i = 23;
  // HONEST-CONDITIONAL TRACK: `fadeSignal` and `dipSignal` fire on the
  // SAME faded-volume condition (vratio < 0.85), so they are ambiguous on
  // ~91% of all triggered bars (measured: 17,835 of 19,545 pooled across
  // 32 contracts; 88.6-92.5% per the independent review in
  // docs/research/edge-review.md). The main loop below skips ambiguous bars
  // (direction undecidable) — that selects a tiny, favourable sample and
  // inflates the edge. A REAL trade fires whenever the signal fires, so the
  // conditional track measures exactly that: every bar where fade-short
  // fires (traded SHORT) and every bar where dip-long fires (traded LONG).
  const condTrades: { direction: "long" | "short"; netPct: number; win: boolean; ambiguous?: boolean }[] = [];
  let condSignals = 0;
  while (i < n - 1) {
    const m = fadeMetrics(closes.slice(i - 23, i + 1), vols.slice(i - 23, i + 1), highs.slice(i - 23, i + 1), lows.slice(i - 23, i + 1));
    if (!m) {
      i++;
      continue;
    }
    const last = closes[i] as number;
    if (!(last > 0)) {
      i++;
      continue;
    }
    const row: FadeRow = { ...m, fundingPct: null, last, symbol: "" };
    const sSig = fadeSignal(row);
    const lSig = dipSignal(row);
    const direction =
      sSig === "fade-short" && lSig !== "dip-long" ? ("short" as const)
      : lSig === "dip-long" && sSig !== "fade-short" ? ("long" as const)
      : null;
    // Conditional track: the signal fired, so a real trade would be here.
    // Direction follows the signal that fired (fade-short → short,
    // dip-long → long); when BOTH fired the row is ambiguous and the
    // trade is charged as a loss in the conservative conditional.
    if (sSig === "fade-short" || lSig === "dip-long") {
      condSignals++;
      const condDir: "long" | "short" = sSig === "fade-short" ? "short" : "long";
      const atr0 = m.atrPct != null && Number.isFinite(m.atrPct) && m.atrPct > 0 ? m.atrPct : 0.8;
      const tpPct0 = fixedTp ?? Math.min(0.5, Math.max(0.3, atr0 * 0.4));
      const killPct0 = Math.min(1.5, Math.max(0.6, atr0 * 0.9));
      const tpDir0 = condDir === "long" ? 1 : -1;
      const tpPrice0 = last * (1 + (tpDir0 * tpPct0) / 100);
      const killPrice0 = last * (1 - (tpDir0 * killPct0) / 100);
      let xp0 = klines[Math.min(i + maxHold, n - 1)]?.close ?? last;
      let end0 = Math.min(i + maxHold, n - 1);
      let amb0 = false;
      for (let j = i + 1; j <= Math.min(i + maxHold, n - 1); j++) {
        const bar = klines[j] as ScalpKline;
        const tpHit = condDir === "long" ? bar.high >= tpPrice0 : bar.low <= tpPrice0;
        const killHit = condDir === "long" ? bar.low <= killPrice0 : bar.high >= killPrice0;
        if (tpHit && killHit) {
          amb0 = true;
          xp0 = tpPrice0;
          end0 = j;
          break;
        }
        if (tpHit || killHit) {
          xp0 = tpHit ? tpPrice0 : killPrice0;
          end0 = j;
          break;
        }
        xp0 = bar.close;
        end0 = j;
      }
      const g0 = ((xp0 - last) / last) * 100 * tpDir0;
      const net0 = g0 - 2 * fee;
      condTrades.push({ direction: condDir, netPct: net0, win: net0 > 0, ambiguous: amb0 });
      // An AMBIGUOUS bar (both signals fired) has no decidable direction for
      // the main series, so the main series skips it — but the conditional
      // track has already recorded it. Advance past the conditional trade
      // so the conditional sample does not overlap itself.
      if (!direction) {
        i = end0 + 1;
        continue;
      }
    }
    if (!direction) {
      i++;
      continue;
    }
    signals++;
    const atr = m.atrPct != null && Number.isFinite(m.atrPct) && m.atrPct > 0 ? m.atrPct : 0.8;
    const tpPct = fixedTp ?? Math.min(0.5, Math.max(0.3, atr * 0.4));
    const killPct = Math.min(1.5, Math.max(0.6, atr * 0.9));
    const tpDir = direction === "long" ? 1 : -1;
    const tpPrice = last * (1 + (tpDir * tpPct) / 100);
    const killPrice = last * (1 - (tpDir * killPct) / 100);
    let exit: "tp" | "kill" | "timeout" = "timeout";
    let exitPrice = klines[Math.min(i + maxHold, n - 1)]?.close ?? last;
    let end = Math.min(i + maxHold, n - 1);
    let ambiguous = false;
    for (let j = i + 1; j <= Math.min(i + maxHold, n - 1); j++) {
      const bar = klines[j] as ScalpKline;
      const tpHit = direction === "long" ? bar.high >= tpPrice : bar.low <= tpPrice;
      const killHit = direction === "long" ? bar.low <= killPrice : bar.high >= killPrice;
      if (tpHit && killHit) {
        // The SAME bar touched both levels — the intra-bar order is
        // unknowable from OHLC. Keep the historical TP-wins resolution for
        // the optimistic series, but FLAG the trade so the conservative
        // verdict can charge it as a loss.
        ambiguous = true;
        exit = "tp";
        exitPrice = tpPrice;
        end = j;
        break;
      }
      if (tpHit || killHit) {
        exit = tpHit ? "tp" : "kill";
        exitPrice = exit === "tp" ? tpPrice : killPrice;
        end = j;
        break;
      }
      exitPrice = bar.close;
      end = j;
    }
    const grossPct = ((exitPrice - last) / last) * 100 * tpDir;
    const netPct = grossPct - 2 * fee;
    trades.push({
      signalIndex: i, direction, entry: last, tpPrice, killPrice,
      exit, exitPrice, grossPct, netPct, win: netPct > 0, ambiguous,
    });
    i = end + 1; // one position at a time — no overlapping fills
  }
  const wins = trades.filter((t) => t.win).length;
  const losses = trades.length - wins;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  const totalGrossPct = trades.reduce((a, t) => a + t.grossPct, 0);
  const totalNetPct = trades.reduce((a, t) => a + t.netPct, 0);
  const winNets = trades.filter((t) => t.win).map((t) => t.netPct);
  const lossNets = trades.filter((t) => !t.win).map((t) => t.netPct);
  const avgWinPct = winNets.length > 0 ? winNets.reduce((a, b) => a + b, 0) / winNets.length : 0;
  const avgLossPct = lossNets.length > 0 ? lossNets.reduce((a, b) => a + b, 0) / lossNets.length : 0;
  const expectancyPct = trades.length > 0 ? totalNetPct / trades.length : 0;
  const breakevenWr =
    avgWinPct > 0 && avgLossPct < 0 ? (Math.abs(avgLossPct) / (avgWinPct + Math.abs(avgLossPct))) * 100 : winRate;
  // The GO bar is the break-even win rate implied by this run's ACTUAL
  // TP/kill/fee geometry — not a hardcoded number. With a 0.3% TP against
  // a 0.6% kill, break-even is ~80% (taker), so a 62% win rate is a
  // bleed dressed as a "GO". The floor still applies; the bar binds.
  const goBarWr = Math.max(SCALP_GO_WIN_RATE, breakevenWr);
  const verdict: "GO" | "NO-GO" = trades.length > 0 && winRate >= goBarWr && totalNetPct > 0 ? "GO" : "NO-GO";
  // Conservative series: every intra-bar TP/kill tie is charged as the
  // LOSS it might have been. A tie is unknowable from OHLC, and for a
  // fade the bar that spans both levels usually did the damage first.
  const ambiguousTrades = trades.filter((t) => t.ambiguous).length;
  const consNetOf = (t: ScalpBacktestTrade): number =>
    t.ambiguous ? -(Math.abs(t.netPct) + 2 * fee) : t.netPct;
  const totalNetPctConservative = trades.reduce((a, t) => a + consNetOf(t), 0);
  const consWins = trades.filter((t) => !t.ambiguous && t.win).length;
  const winRateConservative = trades.length > 0 ? (consWins / trades.length) * 100 : 0;
  const expectancyPctConservative = trades.length > 0 ? totalNetPctConservative / trades.length : 0;
  const verdictConservative: "GO" | "NO-GO" =
    trades.length > 0 && winRateConservative >= goBarWr && totalNetPctConservative > 0 ? "GO" : "NO-GO";
  // HONEST CONDITIONAL summary: every bar where the signal fired, traded in
  // the signal's own direction, with ambiguous ties charged as losses.
  const condNetOf = (t: { netPct: number; ambiguous?: boolean }): number =>
    t.ambiguous ? -(Math.abs(t.netPct) + 2 * fee) : t.netPct;
  const condNets = condTrades.map(condNetOf);
  const conditionalTrades = condTrades.length;
  const totalNetPctConditional = condNets.reduce((a, b) => a + b, 0);
  const expectancyPctConditional = conditionalTrades > 0 ? totalNetPctConditional / conditionalTrades : 0;
  const winRateConditional =
    conditionalTrades > 0 ? (condNets.filter((n) => n > 0).length / conditionalTrades) * 100 : 0;
  const sideStats = (dir: "long" | "short"): { trades: number; winRate: number; expectancyPct: number } => {
    const sel = condTrades.filter((t) => t.direction === dir);
    if (sel.length === 0) return { trades: 0, winRate: 0, expectancyPct: 0 };
    const nets = sel.map(condNetOf);
    const net = nets.reduce((a, b) => a + b, 0);
    return {
      trades: sel.length,
      winRate: (nets.filter((n) => n > 0).length / sel.length) * 100,
      expectancyPct: net / sel.length,
    };
  };
  return {
    candles: n, signals, trades, wins, losses, winRate,
    tpPct: fixedTp, feePerSidePct: fee,
    totalGrossPct, totalNetPct, avgWinPct, avgLossPct,
    expectancyPct, breakevenWr, goBarWr, verdict,
    verdictConservative, ambiguousTrades,
    totalNetPctConservative, expectancyPctConservative, winRateConservative,
    conditionalSignals: condSignals,
    conditionalTrades,
    expectancyPctConditional,
    totalNetPctConditional,
    winRateConditional,
    conditionalBySide: { long: sideStats("long"), short: sideStats("short") },
  };
}
