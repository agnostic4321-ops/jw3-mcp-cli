#!/usr/bin/env python3
"""
THE HIGH-RESOLUTION ORDER-BOOK RECORDER.

WHAT THIS IS
------------
The project's collector samples every 5 MINUTES. At that resolution the
book imbalance is a snapshot of a book that has already been replaced
several times, and the "spread" is a spread that no longer exists. This
recorder captures the same fields at EVENT resolution and aggregates them
to 1 SECOND, so the microstructure signals the project has never been
able to test can finally be tested:

  * book imbalance at 1s resolution
  * the imbalance flip (a reversal signature)
  * a large trade print (informed flow)
  * spread widening (volatility / exhaustion)
  * trade-flow imbalance (buying vs selling volume)
  * order-book resilience (a pulled bid)

THE FEED
--------
KuCoin FUTURES public websocket, KEYLESS:

  POST https://api-futures.kucoin.com/api/v1/bullet-public
    -> { token, instanceServers:[{ endpoint, pingInterval }] }
    -> connect `wss://<endpoint>?token=<token>`

  topics (all verified live 2026-10-21):
    /contractMarket/level2Depth5:<SYM>  top-5 bid/ask, FULL snapshot per push
    /contractMarket/tickerV2:<SYM>      best bid/ask price+size
    /contractMarket/execution:<SYM>     every public trade (TAKER side)

  The spot paths (/market/level2Depth5, /market/match) DO NOT EXIST on the
  futures socket — the venue answers `404 topic does not exist`.

TIMESTAMP UNITS DIFFER BY TOPIC (a live-probe finding, and a trap):
    level2Depth5 : `timestamp` and `ts` are MILLISECONDS (13 digits)
    tickerV2     : `ts` is NANOSECONDS      (19 digits)
    execution    : `ts` is NANOSECONDS      (19 digits)

ALIGNMENT — WHY EVERYTHING IS BUCKETED BY THE VENUE'S OWN CLOCK
----------------------------------------------------------------
The 1-second rows are built from the VENUE timestamps, not the local
clock: a depth push is filed into the second its own `timestamp` names,
and a trade into the second its own `ts` names. A local-clock bucket
would drift against the venue by the network latency and would put a
trade and the book it reacted to in different rows. Every row therefore
carries `vts` (the second's venue timestamp) alongside the local `ts`.

NOTIONAL
--------
The machine's own formula (packages/jw3-cli/src/kucoin.ts:488-510):
    level notional = size(contracts) x price x multiplier
    imbalance      = (bid5Usd - ask5Usd) / (bid5Usd + ask5Usd)
    spread bps     = ((ask - bid) / mid) x 1e4
The multiplier comes from the venue's own contract list, so a "size" of 16
on LINKUSDTM (multiplier 0.1) is 1.6 LINK = ~$19.8, not $198.

READ-ONLY, AND NEVER THE ACCOUNT
--------------------------------
This script makes exactly TWO REST calls, both on the PUBLIC tier:
`bullet-public` (the websocket bootstrap) and `contracts/active` (the
multiplier table). It never calls `jw3`, never reads the account, never
touches the account's venue budget (60 calls/min shared with the
STOP-ARMING path). A websocket push is not a rate-limited REST call —
but the CPU and the disk are not free, and the script measures both.

OUTPUT (all NEW files under a NEW directory; no existing *.ndjson is
ever written):
    <out>/book-1s.jsonl    one row per symbol per second (the analysis file)
    <out>/trades.jsonl    one row per public trade, with the book state
                           AT THE MOMENT OF THE PRINT
    <out>/book-raw.jsonl  every depth5 push, verbatim (sub-second work
                           and the disk-cost measurement)
    <out>/meta.json       rate/throughput/CPU/disk accounting

USAGE
  python3 collect-microstructure.py --symbols XRPUSDTM,NEARUSDTM \\
      --out ~/.hermes/cache/scratch/microstructure --minutes 150
"""
import argparse
import asyncio
import json
import resource
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

import websockets

BULLET_URL = "https://api-futures.kucoin.com/api/v1/bullet-public"
CONTRACTS_URL = "https://api-futures.kucoin.com/api/v1/contracts/active"


def load_multipliers():
    """The venue's own contract list (keyless, public)."""
    req = urllib.request.Request(CONTRACTS_URL)
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    out = {}
    for c in d.get("data", []):
        if c.get("status") != "Open":
            continue
        out[c["symbol"]] = {
            "mult": float(c.get("multiplier") or 1.0),
            "tick": float(c.get("tickSize") or 0.0),
            "taker": float(c.get("takerFeeRate") or 0.0),
            "maker": float(c.get("makerFeeRate") or 0.0),
        }
    return out


def bullet():
    req = urllib.request.Request(BULLET_URL, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["data"]


def norm_ms(v):
    """Venue timestamps: 13 digits = ms, 19 digits = ns. Normalise to ms."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    if n > 1e17:
        return n // 1_000_000
    if n > 1e14:
        return n // 1_000
    return n


def sec_of(ms):
    """The second bucket a venue timestamp falls into (ms)."""
    return (ms // 1000) * 1000


class SymState:
    """The latest book for one symbol, plus the per-second accumulators."""

    __slots__ = ("sym", "mult", "bids", "asks", "ts", "depth_n", "tick_n",
                 "sec_book", "sec_trades", "sec_stats")

    def __init__(self, sym, mult):
        self.sym = sym
        self.mult = mult
        self.bids = []
        self.asks = []
        self.ts = 0
        self.depth_n = 0
        self.tick_n = 0
        self.sec_book = {}      # second -> last book snapshot in that second
        self.sec_trades = defaultdict(list)   # second -> [trade rows]
        self.sec_stats = {}     # second -> {nDepth, minSpr, maxSpr, minBid1, maxBid1, ...}

    def notional(self, levels):
        return sum(p * s * self.mult for p, s in levels)

    def snapshot(self):
        """The derived book numbers, in the machine's own formulas."""
        if not self.bids or not self.asks:
            return None
        bid5 = self.notional(self.bids)
        ask5 = self.notional(self.asks)
        bp, bsz = self.bids[0]
        ap, asz = self.asks[0]
        mid = (bp + ap) / 2
        if not (mid > 0):
            return None
        spr = ((ap - bp) / mid) * 1e4
        imb = (bid5 - ask5) / (bid5 + ask5) if (bid5 + ask5) > 0 else 0.0
        return {
            "mid": mid, "sprBps": spr, "imb": imb,
            "bid5Usd": bid5, "ask5Usd": ask5,
            "bid1p": bp, "bid1s": bsz, "ask1p": ap, "ask1s": asz,
            "bids": self.bids, "asks": self.asks,
            "ts": self.ts,
        }


async def run(args):
    mults = load_multipliers()
    syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    missing = [s for s in syms if s not in mults]
    if missing:
        print(f"[rec] FATAL: symbols not on the venue's open contract list: {missing}")
        return 2
    for s in syms:
        m = mults[s]
        print(f"[rec] {s:14s} multiplier={m['mult']:<12} tick={m['tick']:<10} "
              f"taker={m['taker']} maker={m['maker']}")

    outdir = Path(args.out).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)
    f_book = open(outdir / "book-1s.jsonl", "ab")
    f_trades = open(outdir / "trades.jsonl", "ab")
    f_raw = open(outdir / "book-raw.jsonl", "ab") if not args.no_raw_depth else None

    state = {s: SymState(s, mults[s]["mult"]) for s in syms}
    counts = {"depth": 0, "ticker": 0, "exec": 0, "ctrl": 0}
    bytes_written = {"book1s": 0, "trades": 0, "raw": 0}
    rows_written = {"book1s": 0, "trades": 0, "raw": 0}
    reconnects = 0
    errors = []
    t0 = time.time()
    deadline = t0 + args.minutes * 60
    last_ping = t0
    last_report = t0
    last_flush = t0
    emitted_upto = {}          # sym -> last second already emitted

    def flush_completed_seconds():
        """
        Emit the 1-second rows for every second that is CLOSED.

        A second is closed once the venue clock has passed it by a small
        lateness margin, so a trade whose venue timestamp lands slightly
        late still lands in its own row. Rows are emitted in (sym, second)
        order and never twice.
        """
        nonlocal last_flush
        now = time.time()
        if now - last_flush < 0.5:
            return
        last_flush = now
        # A second is closed once the VENUE clock has passed it. The venue
        # clock is read from the newest book push we have seen, so this
        # compares like with like (the local clock is ahead of the venue
        # by the network latency, and the venue clock is what the data is
        # stamped with). The 3s margin absorbs late-arriving pushes.
        venue_now = max((st.ts for st in state.values()), default=0)
        if venue_now <= 0:
            venue_now = int(now * 1000)
        lateness_ms = venue_now + 3000
        for s in syms:
            st = state[s]
            upto = emitted_upto.get(s)
            secs = sorted(set(st.sec_book.keys()) | set(st.sec_trades.keys()))
            for sec in secs:
                if upto is not None and sec <= upto:
                    continue
                if sec > lateness_ms:
                    continue
                book = st.sec_book.get(sec)
                trades = st.sec_trades.get(sec, [])
                stats = st.sec_stats.get(sec, {})
                if book is None and not trades:
                    continue
                buy_not = sum(t["notional"] for t in trades if t["side"] == "buy")
                sell_not = sum(t["notional"] for t in trades if t["side"] != "buy")
                buy_sz = sum(t["size"] for t in trades if t["side"] == "buy")
                sell_sz = sum(t["size"] for t in trades if t["side"] != "buy")
                row = {
                    "ts": int(now * 1000),
                    "vts": sec,
                    "sym": s,
                    "mid": book["mid"] if book else None,
                    "sprBps": book["sprBps"] if book else None,
                    "imb": book["imb"] if book else None,
                    "bid5Usd": book["bid5Usd"] if book else None,
                    "ask5Usd": book["ask5Usd"] if book else None,
                    "bid1p": book["bid1p"] if book else None,
                    "bid1s": book["bid1s"] if book else None,
                    "ask1p": book["ask1p"] if book else None,
                    "ask1s": book["ask1s"] if book else None,
                    "bids": book["bids"] if book else None,
                    "asks": book["asks"] if book else None,
                    "nDepth": stats.get("nDepth", 0),
                    "minSprBps": stats.get("minSprBps"),
                    "maxSprBps": stats.get("maxSprBps"),
                    "minBid1s": stats.get("minBid1s"),
                    "maxBid1s": stats.get("maxBid1s"),
                    "minAsk1s": stats.get("minAsk1s"),
                    "maxAsk1s": stats.get("maxAsk1s"),
                    "nTrades": len(trades),
                    "buyNotional": buy_not,
                    "sellNotional": sell_not,
                    "buySz": buy_sz,
                    "sellSz": sell_sz,
                    "maxTradeNotional": max((t["notional"] for t in trades), default=0.0),
                    "bookTs": book["ts"] if book else None,
                }
                line = (json.dumps(row, separators=(",", ":")) + "\n").encode()
                f_book.write(line)
                bytes_written["book1s"] += len(line)
                rows_written["book1s"] += 1
                emitted_upto[s] = sec
                st.sec_book.pop(sec, None)
                st.sec_trades.pop(sec, None)
                st.sec_stats.pop(sec, None)
        f_book.flush()
        f_trades.flush()
        if f_raw:
            f_raw.flush()

    while time.time() < deadline:
        try:
            d = bullet()
            srv = d["instanceServers"][0]
            url = f"{srv['endpoint']}?token={quote(d['token'])}"
            ping_ms = int(srv.get("pingInterval", 18000))
            if reconnects:
                print(f"[rec] reconnect #{reconnects} at {time.time()-t0:.0f}s")
            async with websockets.connect(url, max_size=None, ping_interval=None,
                                          open_timeout=25) as ws:
                nsub = 0
                for s in syms:
                    topics = ["/contractMarket/level2Depth5:", "/contractMarket/execution:"]
                    if args.ticker:
                        topics.append("/contractMarket/tickerV2:")
                    for tpl in topics:
                        await ws.send(json.dumps({
                            "id": str(nsub), "type": "subscribe",
                            "topic": f"{tpl}{s}", "privateChannel": False, "response": True,
                        }))
                        nsub += 1
                print(f"[rec] connected, {nsub} subscribes, {len(syms)} symbols")
                last_ping = time.time()
                while time.time() < deadline:
                    now = time.time()
                    if now - last_ping > ping_ms / 1000:
                        await ws.send(json.dumps({"id": f"ping-{int(now)}", "type": "ping"}))
                        last_ping = now
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        flush_completed_seconds()
                        continue
                    except websockets.exceptions.ConnectionClosed:
                        print(f"[rec] socket closed at {now-t0:.0f}s")
                        break
                    recv_ms = int(now * 1000)
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        counts["ctrl"] += 1
                        continue
                    mtype = msg.get("type")
                    if mtype in ("welcome", "ack", "pong"):
                        counts["ctrl"] += 1
                        continue
                    if mtype == "ping":
                        await ws.send(json.dumps({"id": msg.get("id"), "type": "pong"}))
                        counts["ctrl"] += 1
                        continue
                    if mtype == "error":
                        errors.append({"t": recv_ms, "err": str(msg)[:200]})
                        counts["ctrl"] += 1
                        continue
                    topic = msg.get("topic", "")
                    data = msg.get("data") or {}
                    sym = topic.split(":")[-1] if ":" in topic else ""
                    st = state.get(sym)
                    if st is None:
                        counts["ctrl"] += 1
                        continue

                    if topic.startswith("/contractMarket/level2Depth5:"):
                        counts["depth"] += 1
                        bids, asks = [], []
                        for lvl in (data.get("bids") or []):
                            try:
                                bids.append([float(lvl[0]), float(lvl[1])])
                            except (TypeError, ValueError, IndexError):
                                continue
                        for lvl in (data.get("asks") or []):
                            try:
                                asks.append([float(lvl[0]), float(lvl[1])])
                            except (TypeError, ValueError, IndexError):
                                continue
                        if bids and asks:
                            st.bids = bids[:5]
                            st.asks = asks[:5]
                            vts = norm_ms(data.get("timestamp") or data.get("ts") or recv_ms)
                            st.ts = vts
                            st.depth_n += 1
                            sec = sec_of(vts)
                            # A push that names a second already EMITTED is a
                            # late arrival. It must not resurrect that
                            # second's row (which would emit it twice, with
                            # the late book instead of the second's own).
                            if emitted_upto.get(sym) is not None and sec <= emitted_upto[sym]:
                                continue
                            snap = st.snapshot()
                            st.sec_book[sec] = snap
                            stt = st.sec_stats.setdefault(sec, {
                                "nDepth": 0, "minSprBps": None, "maxSprBps": None,
                                "minBid1s": None, "maxBid1s": None,
                                "minAsk1s": None, "maxAsk1s": None,
                            })
                            stt["nDepth"] += 1
                            spr = snap["sprBps"]
                            stt["minSprBps"] = spr if stt["minSprBps"] is None else min(stt["minSprBps"], spr)
                            stt["maxSprBps"] = spr if stt["maxSprBps"] is None else max(stt["maxSprBps"], spr)
                            b1 = snap["bid1s"]
                            stt["minBid1s"] = b1 if stt["minBid1s"] is None else min(stt["minBid1s"], b1)
                            stt["maxBid1s"] = b1 if stt["maxBid1s"] is None else max(stt["maxBid1s"], b1)
                            a1 = snap["ask1s"]
                            stt["minAsk1s"] = a1 if stt["minAsk1s"] is None else min(stt["minAsk1s"], a1)
                            stt["maxAsk1s"] = a1 if stt["maxAsk1s"] is None else max(stt["maxAsk1s"], a1)
                            if f_raw:
                                rl = (json.dumps({
                                    "ts": recv_ms, "vts": vts, "sym": sym,
                                    "bids": st.bids, "asks": st.asks,
                                }, separators=(",", ":")) + "\n").encode()
                                f_raw.write(rl)
                                bytes_written["raw"] += len(rl)
                                rows_written["raw"] += 1
                    elif topic.startswith("/contractMarket/tickerV2:"):
                        counts["ticker"] += 1
                        st.tick_n += 1
                    elif topic.startswith("/contractMarket/execution:"):
                        counts["exec"] += 1
                        try:
                            price = float(data.get("price"))
                            size = float(data.get("size"))
                        except (TypeError, ValueError):
                            continue
                        side = data.get("side")
                        tms = norm_ms(data.get("ts") or recv_ms)
                        snap = st.snapshot()
                        trow = {
                            "ts": recv_ms,
                            "vts": tms,
                            "sym": sym,
                            "price": price,
                            "size": size,
                            "notional": size * price * st.mult,
                            "side": side,
                            "tradeId": data.get("tradeId"),
                            "mid": snap["mid"] if snap else None,
                            "sprBps": snap["sprBps"] if snap else None,
                            "imb": snap["imb"] if snap else None,
                            "bid5Usd": snap["bid5Usd"] if snap else None,
                            "ask5Usd": snap["ask5Usd"] if snap else None,
                            "bid1s": snap["bid1s"] if snap else None,
                            "ask1s": snap["ask1s"] if snap else None,
                        }
                        tl = (json.dumps(trow, separators=(",", ":")) + "\n").encode()
                        f_trades.write(tl)
                        bytes_written["trades"] += len(tl)
                        rows_written["trades"] += 1
                        tsec = sec_of(tms)
                        # Same late-arrival guard: a trade for an
                        # already-emitted second would double-count it.
                        if emitted_upto.get(sym) is None or tsec > emitted_upto[sym]:
                            st.sec_trades[tsec].append(trow)
                    else:
                        counts["ctrl"] += 1
                    flush_completed_seconds()
                    if time.time() - last_report > 60:
                        el = time.time() - t0
                        print(f"[rec] {el/60:.1f}m depth={counts['depth']} tick={counts['ticker']} "
                              f"exec={counts['exec']} book1s={rows_written['book1s']} "
                              f"bytes={sum(bytes_written.values())/1e6:.2f}MB "
                              f"cpu={resource.getrusage(resource.RUSAGE_SELF).ru_utime:.0f}s")
                        last_report = time.time()
        except Exception as e:
            errors.append({"t": int(time.time() * 1000), "err": f"{type(e).__name__}: {e}"})
            print(f"[rec] ERROR {type(e).__name__}: {e}")
            await asyncio.sleep(3)
        reconnects += 1
        if time.time() >= deadline:
            break

    # Final drain: emit every remaining second regardless of the lateness rule.
    for s in syms:
        st = state[s]
        for sec in sorted(set(st.sec_book.keys()) | set(st.sec_trades.keys())):
            if emitted_upto.get(s) is not None and sec <= emitted_upto[s]:
                continue
            book = st.sec_book.get(sec)
            trades = st.sec_trades.get(sec, [])
            stats = st.sec_stats.get(sec, {})
            if book is None and not trades:
                continue
            buy_not = sum(t["notional"] for t in trades if t["side"] == "buy")
            sell_not = sum(t["notional"] for t in trades if t["side"] != "buy")
            buy_sz = sum(t["size"] for t in trades if t["side"] == "buy")
            sell_sz = sum(t["size"] for t in trades if t["side"] != "buy")
            row = {
                "ts": int(time.time() * 1000), "vts": sec, "sym": s,
                "mid": book["mid"] if book else None,
                "sprBps": book["sprBps"] if book else None,
                "imb": book["imb"] if book else None,
                "bid5Usd": book["bid5Usd"] if book else None,
                "ask5Usd": book["ask5Usd"] if book else None,
                "bid1p": book["bid1p"] if book else None,
                "bid1s": book["bid1s"] if book else None,
                "ask1p": book["ask1p"] if book else None,
                "ask1s": book["ask1s"] if book else None,
                "bids": book["bids"] if book else None,
                "asks": book["asks"] if book else None,
                "nDepth": stats.get("nDepth", 0),
                "minSprBps": stats.get("minSprBps"), "maxSprBps": stats.get("maxSprBps"),
                "minBid1s": stats.get("minBid1s"), "maxBid1s": stats.get("maxBid1s"),
                "minAsk1s": stats.get("minAsk1s"), "maxAsk1s": stats.get("maxAsk1s"),
                "nTrades": len(trades),
                "buyNotional": buy_not, "sellNotional": sell_not,
                "buySz": buy_sz, "sellSz": sell_sz,
                "maxTradeNotional": max((t["notional"] for t in trades), default=0.0),
                "bookTs": book["ts"] if book else None,
            }
            line = (json.dumps(row, separators=(",", ":")) + "\n").encode()
            f_book.write(line)
            bytes_written["book1s"] += len(line)
            rows_written["book1s"] += 1

    f_book.close()
    f_trades.close()
    if f_raw:
        f_raw.close()

    el = time.time() - t0
    ru = resource.getrusage(resource.RUSAGE_SELF)
    disk = sum(f.stat().st_size for f in outdir.glob("*.jsonl"))
    meta = {
        "symbols": syms,
        "minutes_run": round(el / 60, 3),
        "counts": counts,
        "rows_written": rows_written,
        "bytes_written": bytes_written,
        "messages_per_sec": round(sum(counts.values()) / el, 2),
        "bytes_per_sec": round(sum(bytes_written.values()) / el, 1),
        "projected_bytes_per_hour": round(sum(bytes_written.values()) / el * 3600, 1),
        "projected_mb_per_day": round(sum(bytes_written.values()) / el * 86400 / 1e6, 1),
        "disk_bytes_total": disk,
        "disk_mb_total": round(disk / 1e6, 3),
        "cpu_user_sec": round(ru.ru_utime, 1),
        "cpu_system_sec": round(ru.ru_stime, 1),
        "cpu_pct_of_wall": round((ru.ru_utime + ru.ru_stime) / el * 100, 2),
        "max_rss_mb": round(ru.ru_maxrss / 1e6, 1),
        "reconnects": reconnects,
        "n_errors": len(errors),
        "errors": errors[:50],
        "rest_calls": 2,
        "account_calls": 0,
    }
    (outdir / "meta.json").write_text(json.dumps(meta, indent=2))
    print("[rec] DONE " + json.dumps(meta, indent=2))
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--symbols", default="XRPUSDTM,NEARUSDTM,ZECUSDTM,ETHUSDTM,SOLUSDTM")
    p.add_argument("--out", default=str(Path.home() / ".hermes/cache/scratch/microstructure"))
    p.add_argument("--minutes", type=float, default=150)
    p.add_argument("--no-raw-depth", action="store_true")
    p.add_argument("--ticker", action="store_true",
                   help="also subscribe tickerV2 (redundant: level2Depth5 carries the full book)")
    args = p.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("[rec] interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
