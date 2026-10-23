/**
 * `spikes` — KuCoin futures spike monitor (READ-ONLY, no trades).
 * Promoted from the /tmp spike-monitor spike into the CLI.
 * Public REST only (ticker + depth20 + kline/query); never touches
 * the MCP surface, keys, or trading. Rules mirror the spike monitor:
 * VOL_SPIKE (1m lots ≥ max(3×med, p90, floor)), PRICE_THRUST (|1m ret|
 * ≥ per-symbol %), BOOK_IMBALANCE (|I| ≥ 0.40 top-5), SPREAD_WIDE
 * (≥ 5bps majors / 10bps GRAM), WALL (level ≥ 6× side median + min).
 *
 * Perf: 120-bar baselines are file-cached for 5 minutes (see ../cache.js)
 * and per-symbol ticker/depth + kline checks fan out with Promise.all —
 * one cycle costs ~max(symbol latency), not Σ(symbol latencies).
 */
import {
  SPIKE_DEFAULT_SYMS,
  SPIKE_IMB_T,
  SPIKE_SYMS,
  futuresDepth20,
  futuresKlinesRaw,
  futuresTickerFull,
  spikeBaselineStats,
  spikeImbalance,
  spikeNotionals,
  spikeSpreadBps,
  spikeSymbolForBase,
  spikeThrust,
  spikeVolTrigger,
  spikeWall,
} from "../kucoin.js";
import { loadSpikeBaseline, saveSpikeBaseline } from "../cache.js";
import { mapPool } from "../http.js";

/**
 * Max in-flight venue requests in one fan-out wave. 9 symbols ×
 * (ticker + depth) as one unbounded Promise.all is a 429 magnet —
 * 3-wide keeps a cycle near max(symbol latency) without the burst.
 */
export const SPIKE_POOL = 3;

const CYCLE_GAP_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type SpikeEvent = { ts: string; sym: string; type: string; detail: string };
export type SpikeSnapshot = {
  cycle: number;
  sym: string;
  mid: number;
  sprBps: number;
  bid5Usd: number;
  ask5Usd: number;
  imb: number;
};

export type SpikeBaseline = {
  n: number;
  volMed: number;
  volP90: number;
  volMax: number;
  trigger: number;
  lastTs: number;
};

type SpikesDeps = {
  klinesRaw?: typeof futuresKlinesRaw;
  tickerFull?: typeof futuresTickerFull;
  depth20?: typeof futuresDepth20;
  now?: () => number;
};

const utc = (): string => new Date().toISOString().slice(11, 19);

/**
 * `--pairs GRAM,SOL,ETH,XBT` (bases) → futures symbols. Also SUI,DOT,DOGE,PEPE,UNI.
 * Empty/blank → all four defaults. BTC is accepted as XBT.
 */
export function parseSpikePairs(raw?: string): string[] | null {
  if (raw === undefined || raw.trim() === "") return [...SPIKE_DEFAULT_SYMS];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const sym = spikeSymbolForBase(part);
    if (!sym) return null;
    if (!out.includes(sym)) out.push(sym);
  }
  return out.length > 0 ? out : null;
}

/** One symbol baseline: fresh 5-min file cache hit, else one 120-bar pull. */
async function loadOneBaseline(
  sym: string,
  klinesRaw: typeof futuresKlinesRaw,
  nowMs: number,
): Promise<{ sym: string; baseline: SpikeBaseline }> {
  const cfg = SPIKE_SYMS[sym] as (typeof SPIKE_SYMS)[string];
  const cached = loadSpikeBaseline(sym, nowMs);
  if (cached) {
    const { fetchedAt: _dropped, ...rest } = cached;
    return { sym, baseline: rest };
  }
  try {
    const rows = await klinesRaw(sym, 1, nowMs - 120 * 60 * 1000, nowMs);
    const vols = rows.map((k) => Number(k[5])).filter((v) => Number.isFinite(v) && v >= 0);
    const st = spikeBaselineStats(vols);
    const lastTs = rows.length > 0 ? Number(rows[rows.length - 1]?.[0] ?? 0) : 0;
    const baseline: SpikeBaseline = { ...st, trigger: spikeVolTrigger(vols, cfg.volFloor), lastTs };
    saveSpikeBaseline(sym, baseline, nowMs);
    return { sym, baseline };
  } catch {
    return { sym, baseline: { n: 0, volMed: 0, volP90: 0, volMax: 0, trigger: cfg.volFloor, lastTs: 0 } };
  }
}

/** One symbol snapshot: ticker + depth20 concurrently, pure math after. */
async function snapshotOne(
  sym: string,
  cycle: number,
  tickerFull: typeof futuresTickerFull,
  depth20: typeof futuresDepth20,
): Promise<{ snap: SpikeSnapshot | null; events: SpikeEvent[] }> {
  const cfg = SPIKE_SYMS[sym] as (typeof SPIKE_SYMS)[string];
  const events: SpikeEvent[] = [];
  try {
    const [tk, ob] = await Promise.all([tickerFull(sym), depth20(sym)]);
    const bn = spikeNotionals(ob.bids.slice(0, 5) as [unknown, unknown][], cfg.mult);
    const an = spikeNotionals(ob.asks.slice(0, 5) as [unknown, unknown][], cfg.mult);
    const tb = bn.reduce((a, l) => a + l.notional, 0);
    const ta = an.reduce((a, l) => a + l.notional, 0);
    const imb = spikeImbalance(tb, ta);
    const mid = (tk.bestBid + tk.bestAsk) / 2;
    const spr = spikeSpreadBps(tk.bestBid, tk.bestAsk);
    const snap: SpikeSnapshot = {
      cycle, sym,
      mid: Number(mid.toFixed(6)),
      sprBps: Number(spr.toFixed(2)),
      bid5Usd: Math.round(tb * 10) / 10,
      ask5Usd: Math.round(ta * 10) / 10,
      imb: Math.round(imb * 1000) / 1000,
    };
    const ts = utc();
    if (Math.abs(imb) >= SPIKE_IMB_T) {
      events.push({ ts, sym, type: "BOOK_IMBALANCE", detail: `I=${imb >= 0 ? "+" : ""}${imb.toFixed(2)} bid5=$${Math.round(tb).toLocaleString()} ask5=$${Math.round(ta).toLocaleString()} mid=${mid}` });
    }
    if (spr >= cfg.spreadBps) {
      events.push({ ts, sym, type: "SPREAD_WIDE", detail: `spread ${spr.toFixed(1)}bps >= ${cfg.spreadBps}bps, bid=${tk.bestBid} ask=${tk.bestAsk}` });
    }
    const side = imb > 0 ? bn : an;
    const wall = spikeWall(side, cfg.wallMin);
    if (wall) {
      events.push({ ts, sym, type: "WALL", detail: `${imb > 0 ? "bid" : "ask"} level ${wall.price} $${Math.round(wall.notional).toLocaleString()} >= 6x median $${Math.round(wall.median).toLocaleString()} (min $${cfg.wallMin.toLocaleString()})` });
    }
    return { snap, events };
  } catch {
    return { snap: null, events: [{ ts: utc(), sym, type: "GAP", detail: "snapshot dropped (429/err), recorded as gap, not interpolated" }] };
  }
}

/** One symbol fresh-bar check: last CLOSED 1m bar vs the stored baseline. */
async function checkOneKline(
  sym: string,
  st: SpikeBaseline,
  klinesRaw: typeof futuresKlinesRaw,
  nowMs: number,
): Promise<SpikeEvent[]> {
  const cfg = SPIKE_SYMS[sym] as (typeof SPIKE_SYMS)[string];
  try {
    const rows = await klinesRaw(sym, 1, nowMs - 5 * 60 * 1000, nowMs);
    if (rows.length < 2) return [];
    const bar = rows[rows.length - 2] as number[];
    const tsMs = Number(bar[0]);
    if (!(tsMs > st.lastTs)) return [];
    st.lastTs = tsMs;
    const o = Number(bar[1]);
    const cl = Number(bar[4]);
    const v = Number(bar[5]);
    const turn = Number(bar[6] ?? 0);
    const ts = utc();
    const out: SpikeEvent[] = [];
    // Recompute trigger inputs from the stored baseline stats is
    // equivalent to max(3×med, p90, floor) — recompute cheaply:
    const trig = Math.max(3 * st.volMed, st.volP90, cfg.volFloor);
    if (Number.isFinite(v) && v >= trig) {
      out.push({ ts, sym, type: "VOL_SPIKE", detail: `1m vol ${Math.round(v).toLocaleString()} lots (${Number.isFinite(turn) ? `$${Math.round(turn).toLocaleString()}` : "n/a"}) >= trigger ${Math.round(trig).toLocaleString()} (=max(3xmed ${Math.round(3 * st.volMed).toLocaleString()}, p90 ${Math.round(st.volP90).toLocaleString()}, floor ${cfg.volFloor.toLocaleString()}))` });
    }
    const th = spikeThrust(o, cl, cfg.thrustPct);
    if (th.fired) {
      out.push({ ts, sym, type: "PRICE_THRUST", detail: `1m ${th.retPct >= 0 ? "+" : ""}${th.retPct.toFixed(3)}% >= ${cfg.thrustPct}% (o=${o} c=${cl} vol=${Number.isFinite(v) ? Math.round(v).toLocaleString() : "?"})` });
    }
    return out;
  } catch {
    return [{ ts: utc(), sym, type: "GAP", detail: "kline check dropped (429/err), recorded as gap" }];
  }
}

export async function cmdSpikes(
  opts: {
    exchange: string;
    pairs?: string;
    cycles: number;
    json: boolean;
  },
  deps: SpikesDeps = {},
): Promise<void> {
  if ((opts.exchange || "kucoin").toLowerCase() !== "kucoin") {
    console.error(`Unsupported --exchange ${JSON.stringify(opts.exchange)} for spikes — only kucoin (public REST). Nothing was called.`);
    process.exitCode = 2;
    return;
  }
  const syms = parseSpikePairs(opts.pairs);
  if (!syms) {
    console.error("Bad --pairs: use comma bases from GRAM,SOL,ETH,XBT,SUI,DOT,DOGE,PEPE,UNI (BTC accepted as XBT). Nothing was called.");
    process.exitCode = 2;
    return;
  }
  const cycles = Math.min(Math.max(Math.round(opts.cycles), 1), 30);
  const t0 = Date.now();
  const klinesRaw = deps.klinesRaw ?? futuresKlinesRaw;
  const tickerFull = deps.tickerFull ?? futuresTickerFull;
  const depth20 = deps.depth20 ?? futuresDepth20;
  const nowFn = deps.now ?? Date.now;

  // 1) Baselines: 120× 1m bars per symbol (lots at k[5]) — 5-min file
  // cache hit skips the pull; misses fan out bounded (SPIKE_POOL-wide,
  // never one unbounded burst — 429 discipline).
  const base = new Map<string, SpikeBaseline>();
  const baselineRows = await mapPool(syms, (sym) => loadOneBaseline(sym, klinesRaw, nowFn()), SPIKE_POOL);
  for (const { sym, baseline } of baselineRows) base.set(sym, baseline);

  const events: SpikeEvent[] = [];
  const snaps: SpikeSnapshot[] = [];
  for (let c = 0; c < cycles; c++) {
    // 2) Snapshots: per-symbol ticker+depth concurrently (fan-out over
    // symbols too, same bound). Results merge back in `syms` order.
    const perSym = await mapPool(syms, (sym) => snapshotOne(sym, c, tickerFull, depth20), SPIKE_POOL);
    for (const { snap, events: evs } of perSym) {
      if (snap) snaps.push(snap);
      events.push(...evs);
    }
    // 3) Fresh closed 1m bar per symbol (cheap: 5m window, take last CLOSED bar).
    const klineEvs = await mapPool(
      syms,
      (sym) => {
        const st = base.get(sym);
        if (!st) return Promise.resolve([] as SpikeEvent[]);
        return checkOneKline(sym, st, klinesRaw, nowFn());
      },
      SPIKE_POOL,
    );
    for (const evs of klineEvs) events.push(...evs);
    if (c < cycles - 1) await sleep(CYCLE_GAP_MS);
  }

  const wall_s = (Date.now() - t0) / 1000;
  if (opts.json) {
    console.log(JSON.stringify({
      startedUtc: new Date(t0).toISOString(),
      cycles,
      targetCadenceS: CYCLE_GAP_MS / 1000,
      achievedSecPerCycle: Math.round((wall_s / cycles) * 10) / 10,
      baselines: Object.fromEntries(base),
      snapshots: snaps,
      events,
      readonly: true,
    }, null, 2));
    return;
  }
  console.log(`Spikes (kucoin public REST, read-only — no trades): ${syms.map((s) => s.replace("USDTM", "")).join(", ")} × ${cycles} cycle(s) in ${wall_s.toFixed(0)}s`);
  console.log("baselines (120× 1m lots): sym n med p90 max trigger");
  for (const sym of syms) {
    const st = base.get(sym);
    if (!st) continue;
    console.log(`  ${sym.replace("USDTM", "").padEnd(4)} n=${st.n} med=${Math.round(st.volMed).toLocaleString()} p90=${Math.round(st.volP90).toLocaleString()} max=${Math.round(st.volMax).toLocaleString()} trigger=${Math.round(st.trigger).toLocaleString()}`);
  }
  const last = new Map<string, SpikeSnapshot>();
  for (const s of snaps) last.set(s.sym, s);
  if (last.size > 0) {
    console.log("latest: sym mid spread bid5 ask5 imb");
    for (const sym of syms) {
      const d = last.get(sym);
      if (!d) { console.log(`  ${sym.replace("USDTM", "").padEnd(4)} no snapshot (gaps)`); continue; }
      console.log(`  ${sym.replace("USDTM", "").padEnd(4)} ${d.mid} ${d.sprBps}bps $${Math.round(d.bid5Usd).toLocaleString()} $${Math.round(d.ask5Usd).toLocaleString()} ${d.imb >= 0 ? "+" : ""}${d.imb.toFixed(2)}`);
    }
  }
  console.log(`events (${events.length}):`);
  for (const e of events) console.log(`  [${e.ts}] ${e.sym} ${e.type}: ${e.detail}`);
  if (events.length === 0) console.log("  none fired (quiet book — also a valid observation)");
}
