/**
 * `monitor` — live telemetry: PURE-function tests over fabricated snapshots.
 *
 * Zero network: every test builds a `MonitorSnapshot` (or the raw venue
 * rows it is built from) by hand, so the rules can be exercised without a
 * PAT, a venue, or a clock.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "../test-fixtures.js";
import {
  buildSnapshot,
  canonicalPair,
  cmdMonitor,
  detectFindings,
  diffSnapshots,
  findOwner,
  formatMonitorReport,
  hasArmedExit,
  heatScore,
  liqDistancePct,
  orderPlacedAtMs,
  ownershipFromState,
  positionMargin,
  positionNotional,
  protectiveStopOf,
  pocketsFromBalances,
  readOwnership,
  readVenueEnvelope,
  riskToStopPct,
  sizeMatches,
  takeProfitOf,
  unwrapBalances,
  validateMonitorThresholds,
  DEFAULT_MONITOR_THRESHOLDS,
  type MonitorFinding,
  type MonitorOwnership,
  type MonitorSnapshot,
  type MonitorThresholds,
} from "./monitor.js";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = 1_700_000_000_000;

/** A clean snapshot: one owned long with a TP and a stop, nothing wrong. */
function cleanSnapshot(over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  const base: MonitorSnapshot = {
    observedAtMs: NOW,
    observedAt: new Date(NOW).toISOString(),
    exchange: "kucoin",
    pockets: [
      { pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 80, lockedUsd: 20, isFutures: true },
      { pocket: "spot", quote: "USDT", totalUsd: 40, freeUsd: 40, lockedUsd: 0, isFutures: false },
    ],
    futuresPocket: { pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 80, lockedUsd: 20, isFutures: true },
    positions: [
      {
        key: "kucoin:SOL/USDT:long",
        exchange: "kucoin",
        pair: "SOL/USDT",
        side: "long",
        size: 10,
        entryPrice: 100,
        markPrice: 101,
        liqPrice: 80,
        leverage: 5,
        notionalUsd: 1010,
        marginLockedUsd: 202,
        marginEstimated: false,
        unrealizedPnl: 10,
        exits: [
          { orderId: "tp1", kind: "tp", price: 105, side: "sell", source: "venue" },
          { orderId: "sl1", kind: "sl", price: 95, side: "sell", source: "venue" },
        ],
        exitsUnknown: false,
        owned: true,
        owner: "scalp",
        sizeMismatch: false,
        ownerSizes: [10],
        liqDistancePct: 20.79,
        riskToStopPct: 5.94,
        riskUsd: 60,
      },
    ],
    orders: [],
    totalOpenNotionalUsd: 1010,
    openNotionalPctOfEquity: 1010,
    venues: [
      {
        exchange: "kucoin",
        readCount: 3,
        errorCount: 0,
        errors: [],
        errorRate: 0,
        positionCount: 1,
        orderCount: 0,
        openNotionalUsd: 1010,
        openNotionalPctOfEquity: 1010,
        riskPctOfEquity: 5.94,
        heatScore: 61,
      },
    ],
    errors: [],
    resolvedOrders: [],
    unreadableStates: [],
    positionsUnread: false,
    balancesUnread: false,
    ordersUnread: false,
  };
  return { ...base, ...over };
}

/** Thresholds that keep a clean snapshot clean. */
const LOOSE: MonitorThresholds = {
  ...DEFAULT_MONITOR_THRESHOLDS,
  minFreeUsd: 10,
  maxOpenNotionalUsd: 100_000,
  maxOpenNotionalPct: 100_000,
  maxRiskToStopPct: 90,
};

const codes = (findings: MonitorFinding[]): string[] => findings.map((f) => f.code);
const has = (findings: MonitorFinding[], code: string): boolean => codes(findings).includes(code);

/* ------------------------------------------------------------------ */
/* pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe("canonicalPair", () => {
  it("folds a venue futures symbol onto the daemon's pair key", () => {
    // The venue says XBTUSDTM; the daemon state says BTC/USDT. These must
    // land on one key or every position reads as unknown-origin.
    assert.equal(canonicalPair("XBTUSDTM"), "BTC/USDT");
    assert.equal(canonicalPair("BTCUSDT"), "BTC/USDT");
    assert.equal(canonicalPair("BTC/USDTM"), "BTC/USDT");
    assert.equal(canonicalPair("SOL/USDT"), "SOL/USDT");
  });
  it("returns empty for empty input", () => {
    assert.equal(canonicalPair(undefined), "");
    assert.equal(canonicalPair(""), "");
  });
});

describe("positionNotional / positionMargin", () => {
  it("prefers the venue notional, else |size| x mark", () => {
    assert.equal(positionNotional({ size: 1, markPrice: 100, markValue: 250 }), 250);
    assert.equal(positionNotional({ size: 2, markPrice: 50 }), 100);
  });
  it("returns null when unmeasurable — never zero-filled", () => {
    assert.equal(positionNotional({ symbol: "SOL/USDT" }), null);
    assert.equal(positionNotional({ size: 2 }), null);
  });
  it("prefers the venue margin, else notional / leverage (estimated)", () => {
    assert.deepEqual(positionMargin({ margin: 60, leverage: 10 }, 600), { locked: 60, estimated: false });
    assert.deepEqual(positionMargin({ leverage: 10 }, 600), { locked: 60, estimated: true });
    assert.deepEqual(positionMargin({}, 600), { locked: null, estimated: false });
  });
});

describe("orderPlacedAtMs", () => {
  it("reads an ISO timestamp, epoch seconds and epoch ms", () => {
    assert.equal(orderPlacedAtMs({ createdAt: "2023-11-14T22:13:20.000Z" }), Date.parse("2023-11-14T22:13:20.000Z"));
    assert.equal(orderPlacedAtMs({ cTime: 1_700_000_000 }), 1_700_000_000_000);
    assert.equal(orderPlacedAtMs({ timestamp: 1_700_000_000_000 }), 1_700_000_000_000);
  });
  it("returns null when the venue reports no timestamp", () => {
    assert.equal(orderPlacedAtMs({ orderId: "x" }), null);
  });
});

describe("pocketsFromBalances", () => {
  it("splits the accounts map into pockets and marks the futures one", () => {
    const pockets = pocketsFromBalances({
      accounts: {
        futures: [{ asset: "USDT", free: 30, total: 100 }],
        spot: [{ asset: "USDT", free: 50, total: 50 }],
      },
      merged: [{ asset: "USDT", free: 80, total: 150 }],
    });
    const fut = pockets.find((p) => p.pocket === "futures");
    assert.equal(fut?.freeUsd, 30);
    assert.equal(fut?.totalUsd, 100);
    assert.equal(fut?.lockedUsd, 70);
    assert.equal(fut?.isFutures, true);
    assert.equal(pockets.find((p) => p.pocket === "spot")?.isFutures, false);
  });
  it("never names a flat merged book the futures pocket", () => {
    // The merged aggregate mixes spot and futures money — reading it as the
    // derivatives book would size a futures trade off the wrong number.
    const pockets = pocketsFromBalances([{ asset: "USDT", free: 80, total: 150 }]);
    assert.equal(pockets.length, 1);
    assert.equal(pockets[0]?.pocket, "flat");
    assert.equal(pockets[0]?.isFutures, false);
  });
  it("reports unknown when there are no quote rows", () => {
    const pockets = pocketsFromBalances({ accounts: { spot: [{ asset: "BTC", free: 1, total: 1 }] } });
    assert.equal(pockets[0]?.totalUsd, null);
    assert.equal(pockets[0]?.freeUsd, null);
  });
});

describe("liqDistancePct / riskToStopPct", () => {
  it("measures the distance from mark to liquidation", () => {
    assert.equal(liqDistancePct(100, 95), 5);
    assert.equal(liqDistancePct(100, null), null);
    assert.equal(liqDistancePct(null, 95), null);
  });
  it("measures the risk to the stop in both directions", () => {
    assert.equal(riskToStopPct("long", 100, 95, 1000), 5);
    assert.equal(riskToStopPct("short", 100, 105, 1000), 5);
  });
  it("returns null (not 0) when the stop or notional is unknown", () => {
    assert.equal(riskToStopPct("long", 100, null, 1000), null);
    assert.equal(riskToStopPct("long", 100, 95, null), null);
    assert.equal(riskToStopPct("unknown", 100, 95, 1000), null);
  });
});

describe("exit helpers", () => {
  it("finds the TP and the protective stop", () => {
    const exits = [
      { orderId: "a", kind: "tp" as const, price: 105, side: "sell", source: "venue" as const },
      { orderId: "b", kind: "sl" as const, price: 95, side: "sell", source: "venue" as const },
    ];
    assert.equal(takeProfitOf(exits), 105);
    assert.equal(protectiveStopOf(exits), 95);
    assert.equal(hasArmedExit(exits), true);
    assert.equal(hasArmedExit([]), false);
  });
});

describe("heatScore", () => {
  it("rises with exposure and orders, and is bounded at 100", () => {
    const cold = heatScore({ openNotionalPctOfEquity: 0, positions: 0, orders: 0, errorRate: 0 });
    const warm = heatScore({ openNotionalPctOfEquity: 100, positions: 2, orders: 2, errorRate: 0 });
    const boiling = heatScore({ openNotionalPctOfEquity: 1000, positions: 50, orders: 50, errorRate: 1 });
    assert.equal(cold, 0);
    assert.ok(warm > cold);
    assert.equal(boiling, 100);
  });
});

/* ------------------------------------------------------------------ */
/* snapshot construction                                               */
/* ------------------------------------------------------------------ */

describe("buildSnapshot", () => {
  it("reads the futures pocket, not merged", () => {
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [],
      balancesOut: {
        accounts: {
          futures: [{ asset: "USDT", free: 30, total: 100 }],
          spot: [{ asset: "USDT", free: 70, total: 70 }],
        },
        merged: [{ asset: "USDT", free: 100, total: 170 }],
      },
      ordersOut: [],
    });
    assert.equal(snap.futuresPocket?.pocket, "futures");
    assert.equal(snap.futuresPocket?.freeUsd, 30);
    assert.equal(snap.futuresPocket?.totalUsd, 100);
  });

  it("computes notional, equity % and per-venue heat", () => {
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 10, markPrice: 100, margin: 200, leverage: 5 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [],
    });
    assert.equal(snap.positions[0]?.notionalUsd, 1000);
    assert.equal(snap.totalOpenNotionalUsd, 1000);
    assert.equal(snap.openNotionalPctOfEquity, 1000);
    // heat = exposure(100) x 0.6 + count(1 pos) x 0.3 + errors 0 = 63
    assert.equal(snap.venues[0]?.heatScore, 63);
  });

  it("keeps an unmeasurable notional null instead of zero-filling it", () => {
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 10 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [],
    });
    assert.equal(snap.positions[0]?.notionalUsd, null);
    assert.equal(snap.totalOpenNotionalUsd, null);
    assert.equal(snap.openNotionalPctOfEquity, null);
  });

  it("picks up a book-level exit leg for a position with no venue stops", () => {
    // KuCoin reports a plain limit TP as a standalone open order, never as a
    // stop leg — the monitor must join it to the position or the position
    // reads as having no armed exit.
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 10, entryPrice: 100, markPrice: 101 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [{ orderId: "o1", symbol: "SOLUSDT", side: "sell", type: "limit", price: 105, quantity: 10 }],
    });
    const exits = snap.positions[0]?.exits ?? [];
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.kind, "tp");
    assert.equal(exits[0]?.source, "book");
  });

  it("does not attach another pair's order as an exit leg", () => {
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 10, entryPrice: 100, markPrice: 101 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [{ orderId: "o1", symbol: "ETH/USDT", side: "sell", type: "limit", price: 4000, quantity: 1 }],
    });
    assert.equal((snap.positions[0]?.exits ?? []).length, 0);
  });

  it("marks a position owned when a daemon state claims its size", () => {
    const ownership: MonitorOwnership = {
      byPair: new Map([["BTC/USDT", { kind: "scalp", sizes: [0.007] }]]),
      orderIds: new Set(),
    };
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      // The venue symbol and the daemon pair key differ in spelling.
      positionsOut: [{ symbol: "XBTUSDTM", side: "short", size: 0.007, markPrice: 90000, entryPrice: 90000 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [],
      ownership,
    });
    assert.equal(snap.positions[0]?.owned, true);
    assert.equal(snap.positions[0]?.owner, "scalp");
  });

  it("marks a position NOT owned when the daemon claims a different size", () => {
    const ownership: MonitorOwnership = {
      byPair: new Map([["BTC/USDT", { kind: "scalp", sizes: [0.007] }]]),
      orderIds: new Set(),
    };
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "BTC/USDT", side: "short", size: 0.5, markPrice: 90000, entryPrice: 90000 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [],
      ownership,
    });
    assert.equal(snap.positions[0]?.owned, false);
    assert.equal(snap.positions[0]?.sizeMismatch, true);
  });
});

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

describe("detectFindings", () => {
  it("is clean on a healthy snapshot", () => {
    const findings = detectFindings(cleanSnapshot(), LOOSE);
    assert.deepEqual(findings, []);
  });

  it("critical: a position with no armed exit", () => {
    const snap = cleanSnapshot({
      positions: [
        { ...cleanSnapshot().positions[0]!, exits: [], riskToStopPct: null, riskUsd: null },
      ],
    });
    const findings = detectFindings(snap, LOOSE);
    const f = findings.find((x) => x.code === "no-armed-exit");
    assert.ok(f, "expected a no-armed-exit finding");
    assert.equal(f?.severity, "critical");
    assert.match(f?.message ?? "", /no take-profit and no stop/);
  });

  it("warn (not critical) when the exit book could not be read", () => {
    const snap = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, exits: [], exitsUnknown: true }],
    });
    const findings = detectFindings(snap, LOOSE);
    assert.ok(has(findings, "exits-unread"));
    assert.equal(findings.find((f) => f.code === "exits-unread")?.severity, "warn");
    assert.equal(has(findings, "no-armed-exit"), false);
  });

  it("critical: free margin below the floor", () => {
    const snap = cleanSnapshot({
      futuresPocket: { pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 5, lockedUsd: 95, isFutures: true },
      pockets: [{ pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 5, lockedUsd: 95, isFutures: true }],
    });
    const f = detectFindings(snap, { ...LOOSE, minFreeUsd: 10 }).find((x) => x.code === "free-margin-below-floor");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("critical: no futures pocket read at all", () => {
    const snap = cleanSnapshot({ futuresPocket: null, pockets: [] });
    const f = detectFindings(snap, LOOSE).find((x) => x.code === "futures-pocket-unread");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("warn: a working order older than the max age", () => {
    const snap = cleanSnapshot({
      orders: [
        {
          orderId: "o1",
          exchange: "kucoin",
          pair: "SOL/USDT",
          side: "buy",
          type: "limit",
          price: 100,
          quantity: 10,
          filled: 0,
          placedAtMs: NOW - 2 * 60 * 60 * 1000,
          isExit: false,
          owned: false,
        },
      ],
    });
    const f = detectFindings(snap, { ...LOOSE, maxOrderAgeMs: 60 * 60 * 1000 }).find((x) => x.code === "stale-working-order");
    assert.ok(f);
    assert.equal(f?.severity, "warn");
    assert.match(f?.message ?? "", /120 minutes/);
  });

  it("warn: a position whose size the daemon does not own", () => {
    const snap = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, owned: false, owner: null }],
    });
    const f = detectFindings(snap, LOOSE).find((x) => x.code === "unknown-origin-position");
    assert.ok(f);
    assert.equal(f?.severity, "warn");
  });

  it("critical: aggregate open notional above the cap", () => {
    const findings = detectFindings(cleanSnapshot(), { ...LOOSE, maxOpenNotionalUsd: 500 });
    const f = findings.find((x) => x.code === "open-notional-above-cap");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("critical: open notional % above the cap", () => {
    const findings = detectFindings(cleanSnapshot(), { ...LOOSE, maxOpenNotionalPct: 300 });
    const f = findings.find((x) => x.code === "open-notional-pct-above-cap");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("critical: a position close to liquidation", () => {
    const snap = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, liqDistancePct: 1.5 }],
    });
    const f = detectFindings(snap, { ...LOOSE, minLiqDistancePct: 5 }).find((x) => x.code === "near-liquidation");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("critical: a take-profit the price has already run past", () => {
    const snap = cleanSnapshot({
      positions: [
        {
          ...cleanSnapshot().positions[0]!,
          markPrice: 110,
          exits: [
            { orderId: "tp1", kind: "tp", price: 105, side: "sell", source: "venue" },
            { orderId: "sl1", kind: "sl", price: 95, side: "sell", source: "venue" },
          ],
        },
      ],
    });
    const f = detectFindings(snap, LOOSE).find((x) => x.code === "stale-take-profit");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("critical: a stop on the wrong side of the price", () => {
    const snap = cleanSnapshot({
      positions: [
        {
          ...cleanSnapshot().positions[0]!,
          markPrice: 90,
          exits: [
            { orderId: "tp1", kind: "tp", price: 105, side: "sell", source: "venue" },
            { orderId: "sl1", kind: "sl", price: 95, side: "sell", source: "venue" },
          ],
        },
      ],
    });
    const f = detectFindings(snap, LOOSE).find((x) => x.code === "stale-stop");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("warn: the venue error rate is above the threshold", () => {
    const snap = cleanSnapshot({
      errors: ["positions: 500"],
      venues: [
        {
          exchange: "kucoin",
          readCount: 3,
          errorCount: 2,
          errors: ["positions: 500", "orders: 500"],
          errorRate: 2 / 3,
          positionCount: 1,
          orderCount: 0,
          openNotionalUsd: 1010,
          openNotionalPctOfEquity: 1010,
          riskPctOfEquity: 5.94,
          heatScore: 61,
        },
      ],
    });
    const f = detectFindings(snap, { ...LOOSE, maxVenueErrorRate: 0.2 }).find((x) => x.code === "venue-error-rate");
    assert.ok(f);
    assert.equal(f?.severity, "warn");
  });

  it("warn: the risk to the stop exceeds the limit", () => {
    const snap = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, riskToStopPct: 70, riskUsd: 707 }],
    });
    const f = detectFindings(snap, { ...LOOSE, maxRiskToStopPct: 50 }).find((x) => x.code === "risk-to-stop-too-large");
    assert.ok(f);
    assert.equal(f?.severity, "warn");
  });

  it("critical: the positions book could not be read", () => {
    const f = detectFindings(cleanSnapshot({ positionsUnread: true }), LOOSE).find((x) => x.code === "positions-unread");
    assert.ok(f);
    assert.equal(f?.severity, "critical");
  });

  it("warn: an unreadable daemon state file", () => {
    const f = detectFindings(cleanSnapshot({ unreadableStates: ["/tmp/scalp_btc.json"] }), LOOSE).find((x) => x.code === "unreadable-state");
    assert.ok(f);
    assert.equal(f?.severity, "warn");
  });
});

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

describe("diffSnapshots", () => {
  it("returns nothing when there is no previous snapshot", () => {
    assert.deepEqual(diffSnapshots(null, cleanSnapshot(), LOOSE), []);
  });

  it("reports a position opened", () => {
    const prev = cleanSnapshot({ positions: [] });
    const cur = cleanSnapshot();
    const changes = diffSnapshots(prev, cur, LOOSE);
    const c = changes.find((x) => x.code === "position-opened");
    assert.ok(c);
    assert.match(c?.message ?? "", /SOL\/USDT long/);
  });

  it("reports a position closed", () => {
    const prev = cleanSnapshot();
    const cur = cleanSnapshot({ positions: [] });
    const changes = diffSnapshots(prev, cur, LOOSE);
    assert.ok(changes.some((x) => x.code === "position-closed"));
  });

  it("reports an order that left the book, without guessing why", () => {
    const prev = cleanSnapshot({
      orders: [
        { orderId: "o1", exchange: "kucoin", pair: "SOL/USDT", side: "buy", type: "limit", price: 100, quantity: 10, filled: 0, placedAtMs: NOW, isExit: false, owned: false },
      ],
    });
    const cur = cleanSnapshot({ orders: [] });
    const changes = diffSnapshots(prev, cur, LOOSE);
    const c = changes.find((x) => x.code === "order-left-book");
    assert.ok(c, "expected an order-left-book change");
    assert.match(c?.message ?? "", /either filled or was cancelled/);
  });

  it("reports an order filled when the venue confirms it", () => {
    const prev = cleanSnapshot({
      orders: [
        { orderId: "o1", exchange: "kucoin", pair: "SOL/USDT", side: "buy", type: "limit", price: 100, quantity: 10, filled: 0, placedAtMs: NOW, isExit: false, owned: false },
      ],
    });
    const cur = cleanSnapshot({
      orders: [],
      resolvedOrders: [
        { orderId: "o1", exchange: "kucoin", pair: "SOL/USDT", side: "buy", status: "filled", confirmed: true },
      ],
    });
    const changes = diffSnapshots(prev, cur, LOOSE);
    assert.ok(changes.some((x) => x.code === "order-filled"));
  });

  it("reports an order cancelled when the venue confirms it", () => {
    const prev = cleanSnapshot({
      orders: [
        { orderId: "o1", exchange: "kucoin", pair: "SOL/USDT", side: "buy", type: "limit", price: 100, quantity: 10, filled: 0, placedAtMs: NOW, isExit: false, owned: false },
      ],
    });
    const cur = cleanSnapshot({
      orders: [],
      resolvedOrders: [
        { orderId: "o1", exchange: "kucoin", pair: "SOL/USDT", side: "buy", status: "cancelled", confirmed: true },
      ],
    });
    const changes = diffSnapshots(prev, cur, LOOSE);
    assert.ok(changes.some((x) => x.code === "order-cancelled"));
  });

  it("reports free margin dropping", () => {
    const prev = cleanSnapshot();
    const cur = cleanSnapshot({
      futuresPocket: { pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 60, lockedUsd: 40, isFutures: true },
      pockets: [{ pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 60, lockedUsd: 40, isFutures: true }],
    });
    const c = diffSnapshots(prev, cur, { ...LOOSE, marginDropUsd: 5 }).find((x) => x.code === "margin-dropped");
    assert.ok(c);
    assert.match(c?.message ?? "", /dropped \$20\.00/);
  });

  it("does not report a margin drop below the threshold", () => {
    const prev = cleanSnapshot();
    const cur = cleanSnapshot({
      futuresPocket: { pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 79, lockedUsd: 21, isFutures: true },
      pockets: [{ pocket: "futures", quote: "USDT", totalUsd: 100, freeUsd: 79, lockedUsd: 21, isFutures: true }],
    });
    assert.equal(diffSnapshots(prev, cur, { ...LOOSE, marginDropUsd: 5 }).some((x) => x.code === "margin-dropped"), false);
  });

  it("reports a risk breached when a critical finding appears", () => {
    const prev = cleanSnapshot();
    const cur = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, exits: [] }],
    });
    const changes = diffSnapshots(prev, cur, LOOSE);
    assert.ok(changes.some((x) => x.code === "risk-breached"));
  });

  it("reports a risk cleared when the critical finding goes away", () => {
    const prev = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, exits: [] }],
    });
    const cur = cleanSnapshot();
    const changes = diffSnapshots(prev, cur, LOOSE);
    assert.ok(changes.some((x) => x.code === "risk-cleared"));
  });
});

/* ------------------------------------------------------------------ */
/* ownership                                                           */
/* ------------------------------------------------------------------ */

describe("ownershipFromState", () => {
  it("reads a scalp ladder's cumulative sizes and order ids", () => {
    const parsed = ownershipFromState("scalp", {
      pair: "SOL/USDT",
      placed: [
        { step: 1, sizeUsd: 100, price: 100, orderId: "a" },
        { step: 2, sizeUsd: 100, price: 100, orderId: "b" },
      ],
    });
    assert.equal(parsed.pair, "SOL/USDT");
    // Each step's base units = sizeUsd / price; the ladder fills one step at
    // a time, so the plausible sizes are the cumulative prefixes.
    assert.deepEqual(parsed.sizes, [1, 2]);
    assert.deepEqual(parsed.orderIds, ["a", "b"]);
  });

  it("reads a trail state's size", () => {
    const parsed = ownershipFromState("trail", { pair: "SOL/USDT", size: 12 });
    assert.deepEqual(parsed.sizes, [12]);
  });

  it("reads a degen run's step sizes", () => {
    const parsed = ownershipFromState("degen", {
      pair: "SOL/USDT",
      step1: { sizeUsd: 100, price: 100, orderId: "s1" },
      step2: { sizeUsd: 100, price: 100, orderId: "s2" },
    });
    assert.deepEqual(parsed.sizes, [1, 2]);
    assert.deepEqual(parsed.orderIds, ["s1", "s2"]);
  });
});

describe("sizeMatches", () => {
  it("matches within tolerance and rejects a different size", () => {
    assert.equal(sizeMatches(10, [10], 2), true);
    assert.equal(sizeMatches(10.1, [10], 2), true);
    assert.equal(sizeMatches(11, [10], 2), false);
    assert.equal(sizeMatches(null, [10], 2), false);
  });
});

describe("findOwner", () => {
  it("matches a venue futures symbol against the daemon's pair key", () => {
    const ownership: MonitorOwnership = {
      byPair: new Map([["BTC/USDT", { kind: "scalp", sizes: [0.007] }]]),
      orderIds: new Set(),
    };
    assert.equal(findOwner(ownership, { symbol: "XBTUSDTM" })?.kind, "scalp");
    assert.equal(findOwner(ownership, { symbol: "BTCUSDT" })?.kind, "scalp");
    assert.equal(findOwner(ownership, { symbol: "ETHUSDT" }), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* envelopes                                                           */
/* ------------------------------------------------------------------ */

describe("readVenueEnvelope", () => {
  it("reads a bare array", () => {
    const { rows, errors } = readVenueEnvelope([{ symbol: "SOL/USDT" }]);
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 0);
  });

  it("reads the venues fan-out and records a failed venue", () => {
    const { rows, errors } = readVenueEnvelope({
      kind: "positions",
      venues: [
        { connectionId: "c1", exchange: "kucoin", ok: true, data: [{ symbol: "SOL/USDT" }] },
        { connectionId: "c2", exchange: "binance", ok: false, error: "cex-proxy 500" },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /cex-proxy 500/);
  });
});

describe("unwrapBalances", () => {
  it("unwraps the per-connection data payload", () => {
    const out = unwrapBalances({
      kind: "balances",
      venues: [{ connectionId: "c1", exchange: "kucoin", ok: true, data: { accounts: { futures: [] } } }],
    });
    assert.deepEqual(out, { accounts: { futures: [] } });
  });
  it("passes a plain payload through", () => {
    assert.deepEqual(unwrapBalances({ accounts: { spot: [] } }), { accounts: { spot: [] } });
  });
});

/* ------------------------------------------------------------------ */
/* thresholds                                                          */
/* ------------------------------------------------------------------ */

describe("validateMonitorThresholds", () => {
  it("accepts the defaults", () => {
    assert.equal(validateMonitorThresholds(DEFAULT_MONITOR_THRESHOLDS), null);
  });
  it("rejects out-of-range values", () => {
    assert.ok(validateMonitorThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, minFreeUsd: -1 }));
    assert.ok(validateMonitorThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, maxVenueErrorRate: 2 }));
    assert.ok(validateMonitorThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, maxOrderAgeMs: 0 }));
    assert.ok(validateMonitorThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, minLiqDistancePct: -5 }));
  });
});

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

describe("cmdMonitor", () => {
  let logged: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  beforeEach(() => {
    logged = [];
    origLog = console.log;
    origErr = console.error;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = undefined;
  });

  const conns = [{ id: "c1", exchange: "kucoin", markets: "futures" }];

  const source = () => ({
    listConnections: async () => conns,
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "read_live_datum" && args.kind === "positions") {
        return { kind: "positions", venues: [{ connectionId: "c1", ok: true, data: [{ symbol: "SOL/USDT", side: "long", size: 10, markPrice: 100, entryPrice: 100 }] }] };
      }
      if (name === "read_live_datum" && args.kind === "balances") {
        return { kind: "balances", venues: [{ connectionId: "c1", ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } } }] };
      }
      if (name === "list_open_orders") return [];
      return {};
    },
  });

  it("reads the account and prints a report", async () => {
    await cmdMonitor(
      { exchange: "kucoin", thresholds: { ...LOOSE, maxOpenNotionalUsd: 100_000 }, json: false, pat: "p" },
      { source: source() as never, stateDir: "/nonexistent-monitor-dir", now: () => NOW },
    );
    const out = logged.join("\n");
    assert.match(out, /MONITOR kucoin/);
    assert.match(out, /futures pocket/);
  });

  it("never prints the PAT", async () => {
    await cmdMonitor(
      { exchange: "kucoin", thresholds: LOOSE, json: true, pat: "SUPER-SECRET-PAT" },
      { source: source() as never, stateDir: "/nonexistent-monitor-dir", now: () => NOW },
    );
    assert.equal(logged.join("\n").includes("SUPER-SECRET-PAT"), false);
  });

  it("exits 1 when a critical finding fired", async () => {
    await cmdMonitor(
      { exchange: "kucoin", thresholds: { ...LOOSE, maxOpenNotionalUsd: 1 }, json: true, pat: "p" },
      { source: source() as never, stateDir: "/nonexistent-monitor-dir", now: () => NOW },
    );
    assert.equal(process.exitCode, 1);
  });

  it("exits 2 on a bad threshold and calls nothing", async () => {
    let called = false;
    await cmdMonitor(
      { exchange: "kucoin", thresholds: { ...LOOSE, minFreeUsd: -5 }, json: true, pat: "p" },
      {
        source: {
          listConnections: async () => { called = true; return conns; },
          callTool: async () => { called = true; return {}; },
        } as never,
      },
    );
    assert.equal(process.exitCode, 2);
    assert.equal(called, false);
  });

  it("reports an unreadable venue read as a critical finding", async () => {
    await cmdMonitor(
      { exchange: "kucoin", thresholds: LOOSE, json: true, pat: "p" },
      {
        source: {
          listConnections: async () => conns,
          callTool: async (name: string, args: Record<string, unknown>) => {
            if (name === "read_live_datum" && args.kind === "positions") throw new Error("cex-proxy 500");
            if (name === "read_live_datum" && args.kind === "balances") {
              return { kind: "balances", venues: [{ connectionId: "c1", ok: true, data: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } } }] };
            }
            return [];
          },
        } as never,
        stateDir: "/nonexistent-monitor-dir",
        now: () => NOW,
      },
    );
    assert.equal(process.exitCode, 1);
    const report = JSON.parse(logged.join("\n")) as { findings: { code: string }[] };
    assert.ok(report.findings.some((f) => f.code === "positions-unread"));
  });
});

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

describe("formatMonitorReport", () => {
  it("renders the account line, the positions and the findings", () => {
    const snap = cleanSnapshot({
      positions: [{ ...cleanSnapshot().positions[0]!, exits: [] }],
    });
    const lines = formatMonitorReport({
      mode: "monitor",
      exchange: "kucoin",
      snapshot: snap,
      findings: detectFindings(snap, LOOSE),
      changes: [],
      thresholds: LOOSE,
      ok: false,
    });
    const out = lines.join("\n");
    assert.match(out, /MONITOR kucoin/);
    assert.match(out, /NO ARMED EXIT/);
    assert.match(out, /CRITICAL \[no-armed-exit\]/);
  });
});

/* ------------------------------------------------------------------ */
/* live state files (on-disk ownership)                               */
/* ------------------------------------------------------------------ */

describe("readOwnership against real state files", () => {
  let sb: { dir: string; cleanup: () => void };
  let dir: string;
  beforeEach(() => {
    sb = makeSandbox("monitor-test-");
    dir = sb.dir;
  });
  afterEach(() => {
    sb.cleanup();
  });

  it("claims a position from a scalp state file", () => {
    writeFileSync(
      join(dir, "scalp_sol.json"),
      JSON.stringify({
        kind: "scalp",
        exchange: "kucoin",
        pair: "SOL/USDT",
        placed: [{ step: 1, sizeUsd: 100, price: 100, orderId: "o1" }],
      }),
    );
    const snap = buildSnapshot({
      observedAtMs: NOW,
      exchange: "kucoin",
      positionsOut: [{ symbol: "SOL/USDT", side: "long", size: 1, markPrice: 100, entryPrice: 100 }],
      balancesOut: { accounts: { futures: [{ asset: "USDT", free: 80, total: 100 }] } },
      ordersOut: [],
      ownership: readOwnership(["SOL"], dir).ownership,
    });
    assert.equal(snap.positions[0]?.owned, true);
    assert.equal(snap.positions[0]?.owner, "scalp");
  });

  it("reports an unreadable state file instead of treating it as nothing", () => {
    writeFileSync(join(dir, "scalp_sol.json"), "{ not json");
    const { unreadable } = readOwnership(["SOL"], dir);
    assert.equal(unreadable.length, 1);
    assert.match(unreadable[0] ?? "", /scalp_sol\.json/);
  });
});
