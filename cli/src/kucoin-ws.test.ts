import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FUTURES_BULLET_URL,
  futuresConnectUrl,
  futuresContract,
  futuresIsControlFrame,
  futuresPingFrame,
  futuresSubscribeFrame,
  futuresTickerV2Topic,
  openLiveMarkFeed,
  parseFuturesBullet,
  parseFuturesTickerV2,
  resolveFuturesUrl,
  streamFuturesTicks,
  type WsLike,
} from "./kucoin-ws.js";

/** Verbatim tickerV2 frame shape from the live-wire probe (XBTUSDTM). */
const V2_FRAME = {
  topic: "/contractMarket/tickerV2:XBTUSDTM",
  type: "message",
  subject: "tickerV2",
  sn: 1748403668536,
  data: {
    symbol: "XBTUSDTM",
    sequence: 1748403668536,
    bestBidSize: 878,
    bestBidPrice: "83392.5",
    bestAskPrice: "83392.6",
    bestAskSize: 63,
    ts: 1791958021295000000,
  },
};

describe("futuresContract", () => {
  it("maps pairs/bases to <BASE>USDTM, BTC aliased to XBT", () => {
    assert.equal(futuresContract("SOL/USDT"), "SOLUSDTM");
    assert.equal(futuresContract("sol-usdt"), "SOLUSDTM");
    assert.equal(futuresContract("SOLUSDT"), "SOLUSDTM");
    assert.equal(futuresContract("SOL"), "SOLUSDTM");
    assert.equal(futuresContract("SOLUSDTM"), "SOLUSDTM");
    assert.equal(futuresContract("BTC/USDT"), "XBTUSDTM");
    assert.equal(futuresContract("XBT"), "XBTUSDTM");
  });
  it("refuses garbage without inventing a contract", () => {
    assert.equal(futuresContract(""), null);
    assert.equal(futuresContract("  "), null);
    assert.equal(futuresContract("SOL!"), null);
  });
});

describe("parseFuturesBullet + futuresConnectUrl", () => {
  const ok = {
    code: "200000",
    data: {
      token: "tok-abc",
      instanceServers: [
        { endpoint: "wss://ws-api-futures.kucoin.com/", pingInterval: 18000, pingTimeout: 10000 },
      ],
    },
  };
  it("parses token + endpoint + keepalive", () => {
    const b = parseFuturesBullet(ok);
    assert.ok(b);
    assert.equal(b?.token, "tok-abc");
    assert.equal(b?.endpoint, "wss://ws-api-futures.kucoin.com/");
    assert.equal(b?.pingInterval, 18000);
    assert.equal(b?.pingTimeout, 10000);
  });
  it("returns null on half replies — never a dead URL", () => {
    assert.equal(parseFuturesBullet(null), null);
    assert.equal(parseFuturesBullet({}), null);
    assert.equal(parseFuturesBullet({ data: { token: "t", instanceServers: [] } }), null);
    assert.equal(parseFuturesBullet({ data: { token: "", instanceServers: [{ endpoint: "wss://x" }] } }), null);
  });
  it("appends the token, never doubles it", () => {
    assert.equal(
      futuresConnectUrl({ token: "tok-abc", endpoint: "wss://ws-api-futures.kucoin.com/" }),
      "wss://ws-api-futures.kucoin.com/?token=tok-abc",
    );
    assert.equal(
      futuresConnectUrl({ token: "tok-abc", endpoint: "wss://h/?token=old" }),
      "wss://h/?token=old",
    );
  });
  it("resolveFuturesUrl mints via the futures bullet endpoint", async () => {
    const seen: string[] = [];
    const url = await resolveFuturesUrl(async (u: string) => {
      seen.push(u);
      return { json: async () => ok };
    });
    assert.deepEqual(seen, [FUTURES_BULLET_URL]);
    assert.equal(url, "wss://ws-api-futures.kucoin.com/?token=tok-abc");
    assert.equal(await resolveFuturesUrl(async () => ({ json: async () => ({}) })), null);
  });
});

describe("subscribe/ping/control frames", () => {
  it("subscribes the tickerV2 topic the docs recommend", () => {
    assert.equal(futuresTickerV2Topic("XBTUSDTM"), "/contractMarket/tickerV2:XBTUSDTM");
    const f = JSON.parse(futuresSubscribeFrame("XBTUSDTM") as string) as Record<string, unknown>;
    assert.equal(f.topic, "/contractMarket/tickerV2:XBTUSDTM");
    assert.equal(f.type, "subscribe");
  });
  it("pings in the client-driven shape", () => {
    assert.deepEqual(JSON.parse(futuresPingFrame("p1") as string), { id: "p1", type: "ping" });
  });
  it("control frames never reach the parser", () => {
    for (const t of ["welcome", "ack", "pong", "error"]) {
      assert.equal(futuresIsControlFrame(JSON.stringify({ type: t, id: "1" })), true);
    }
    assert.equal(futuresIsControlFrame(JSON.stringify(V2_FRAME)), false);
    assert.equal(futuresIsControlFrame("not json"), false);
  });
});

describe("parseFuturesTickerV2", () => {
  it("parses the captured wire shape with a numeric mid", () => {
    const t = parseFuturesTickerV2(V2_FRAME, 1_700_000_000_000);
    assert.ok(t);
    assert.equal(t?.symbol, "XBTUSDTM");
    assert.equal(t?.bestBid, 83392.5);
    assert.equal(t?.bestAsk, 83392.6);
    assert.equal(t?.mid, (83392.5 + 83392.6) / 2);
    assert.equal(t?.tsMs, Math.round(1791958021295000000 / 1_000_000));
    assert.equal(t?.recvMs, 1_700_000_000_000);
  });
  it("accepts JSON text like a real socket delivers", () => {
    assert.ok(parseFuturesTickerV2(JSON.stringify(V2_FRAME)));
  });
  it("drops malformed touches instead of zeroing a fake mark", () => {
    const badBid = structuredClone(V2_FRAME) as typeof V2_FRAME;
    (badBid.data as Record<string, unknown>).bestBidPrice = "n/a";
    assert.equal(parseFuturesTickerV2(badBid), null);
    assert.equal(parseFuturesTickerV2({ topic: "/contractMarket/ticker:XBTUSDTM", data: {} }), null);
    assert.equal(parseFuturesTickerV2({ type: "welcome" }), null);
    assert.equal(parseFuturesTickerV2(null), null);
  });
});

/** Scripted socket: replays frames then stays open. */
function fakeSocket(frames: string[]): WsLike & { sent: string[] } {
  const sent: string[] = [];
  const ws = {
    sent,
    send: (d: string) => {
      sent.push(d);
    },
    close: () => {
      ws.onclose?.();
    },
    onopen: null as WsLike["onopen"],
    onmessage: null as WsLike["onmessage"],
    onerror: null as WsLike["onerror"],
    onclose: null as WsLike["onclose"],
  };
  setTimeout(() => {
    ws.onopen?.();
    for (const f of frames) ws.onmessage?.({ data: f });
  }, 0);
  return ws;
}

const bulletFetch = async () => ({
  json: async () => ({
    data: { token: "t", instanceServers: [{ endpoint: "wss://ws-api-futures.kucoin.com/" }] },
  }),
});

describe("openLiveMarkFeed", () => {
  it("subscribes tickerV2 and keeps the latest touch", async () => {
    const feed = await openLiveMarkFeed("XBTUSDTM", {
      fetchFn: bulletFetch,
      wsCtor: () => fakeSocket([JSON.stringify(V2_FRAME)]),
    });
    // Let the scripted open/message flush.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(feed.count(), 1);
    assert.ok(feed.latest());
    assert.equal(feed.latest()?.mid, (83392.5 + 83392.6) / 2);
    feed.close();
  });
  it("rejects an empty bootstrap instead of opening a dead socket", async () => {
    await assert.rejects(
      openLiveMarkFeed("XBTUSDTM", { fetchFn: async () => ({ json: async () => ({}) }) }),
      /bootstrap empty/,
    );
  });
});

describe("streamFuturesTicks", () => {
  it("collects touches with inter-arrival stats", async () => {
    const f2 = structuredClone(V2_FRAME) as typeof V2_FRAME;
    (f2.data as Record<string, unknown>).bestAskPrice = "83393.6";
    const seen: number[] = [];
    const { ticks, restMs, restMid } = await streamFuturesTicks("XBTUSDTM", 1, (t) => seen.push(t.mid), {
      fetchFn: bulletFetch,
      wsCtor: () => fakeSocket([JSON.stringify(V2_FRAME), JSON.stringify(f2)]),
      restMark: async () => ({ mid: 1, ms: 5 }),
    });
    assert.equal(ticks.n, seen.length);
    assert.ok(ticks.n >= 1);
    assert.equal(restMs, 5);
    assert.equal(restMid, 1);
  });
});
