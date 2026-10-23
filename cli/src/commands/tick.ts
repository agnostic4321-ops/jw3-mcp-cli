/**
 * `jw3 tick` — read-only KuCoin futures tickerV2 push for one contract.
 *
 * Streams the public WS touch (no auth) for N seconds, prints each tick,
 * then reports push-rate vs one REST ticker round trip measured from the
 * same process. Proves the sub-second mark source the trail engine polls
 * before trusting it. Never trades, never needs a PAT.
 */
import { futuresContract, streamFuturesTicks, type FuturesTick } from "../kucoin-ws.js";
import { futuresTickerFull } from "../kucoin.js";

export type TickArgs = {
  pair: string;
  seconds: number;
  json: boolean;
};

const px = (v: number): string => (v >= 100 ? v.toFixed(2) : String(Number(v.toPrecision(5))));

export async function cmdTick(a: TickArgs): Promise<void> {
  const contract = futuresContract(a.pair);
  if (!contract) {
    console.error("Usage: jw3 tick --pair SOL/USDT [--seconds 15] [--json]");
    process.exitCode = 2;
    return;
  }
  const seconds = Math.min(Math.max(Math.round(a.seconds) || 15, 1), 300);
  if (!a.json) {
    console.log(`TICK ${contract} — public tickerV2 push, ${seconds}s (read-only, no auth)`);
  } else {
    console.log(JSON.stringify({ event: "start", contract, seconds, source: "tickerV2" }));
  }
  const feed: { close: () => void } | null = null;
  void feed;
  try {
    const { ticks, restMs, restMid } = await streamFuturesTicks(
      contract,
      seconds,
      (t: FuturesTick, i: number) => {
        if (a.json) {
          console.log(
            JSON.stringify({
              tick: i,
              price: t.mid,
              bestBid: t.bestBid,
              bestAsk: t.bestAsk,
              seq: t.seq,
              tsMs: t.tsMs,
            }),
          );
        } else {
          console.log(`TICK n=${i} mid=${px(t.mid)} bid=${px(t.bestBid)} ask=${px(t.bestAsk)} seq=${t.seq}`);
        }
      },
      {
        restMark: async (c: string) => {
          const t0 = Date.now();
          const r = await futuresTickerFull(c);
          const mid = (r.bestBid + r.bestAsk) / 2;
          return { mid, ms: Date.now() - t0 };
        },
      },
    );
    const rate = ticks.n > 0 && ticks.firstMs !== null && ticks.lastMs !== null && ticks.lastMs > ticks.firstMs
      ? ticks.n / ((ticks.lastMs - ticks.firstMs) / 1000)
      : ticks.n;
    if (a.json) {
      console.log(
        JSON.stringify({
          event: "summary",
          contract,
          wsTicks: ticks.n,
          wsRatePerSec: Number(rate.toFixed(2)),
          wsMeanGapMs: ticks.meanGapMs !== null ? Number(ticks.meanGapMs.toFixed(1)) : null,
          restMs,
          restMid,
        }),
      );
    } else {
      console.log(
        `DONE ${contract} — WS ${ticks.n} ticks in ~${seconds}s` +
          (ticks.meanGapMs !== null ? ` (mean gap ${ticks.meanGapMs.toFixed(0)}ms)` : " (no inter-tick gap)") +
          (restMs !== null ? ` vs REST ${restMs}ms round trip @ ${restMid !== null ? px(restMid) : "—"}` : " vs REST unreachable") +
          `. Push is the faster mark; REST stays the fallback.`,
      );
    }
    if (ticks.n === 0) process.exitCode = 1;
  } catch (e) {
    console.error(`TICK FAILED: ${e instanceof Error ? e.message : String(e)} — nothing streamed, REST path untouched.`);
    process.exitCode = 1;
  }
}
