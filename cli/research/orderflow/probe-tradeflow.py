#!/usr/bin/env python3
"""
PROBE — trade-flow rate per symbol, so the 2.5-hour recorder records the
LIQUID names (the large-print and trade-flow-imbalance signals need a
trade flow; an illiquid name has none).

READ-ONLY. Public keyless websocket only. Never touches the account.
"""
import asyncio
import json
import time
import urllib.request
from collections import Counter
from urllib.parse import quote

import websockets

BULLET_URL = "https://api-futures.kucoin.com/api/v1/bullet-public"


def bullet():
    req = urllib.request.Request(BULLET_URL, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["data"]


async def main():
    syms = sys.argv[1].split(",")
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 60
    d = bullet()
    srv = d["instanceServers"][0]
    url = f"{srv['endpoint']}?token={quote(d['token'])}"
    counts = Counter()
    notional = Counter()
    sides = Counter()
    async with websockets.connect(url, max_size=None, ping_interval=None) as ws:
        for i, s in enumerate(syms):
            await ws.send(json.dumps({
                "id": str(i), "type": "subscribe",
                "topic": f"/contractMarket/execution:{s}",
                "privateChannel": False, "response": True,
            }))
        t0 = time.time()
        last_ping = t0
        while time.time() - t0 < secs:
            if time.time() - last_ping > 15:
                await ws.send(json.dumps({"id": "p", "type": "ping"}))
                last_ping = time.time()
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
            except asyncio.TimeoutError:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("type") in ("welcome", "ack", "pong"):
                continue
            if msg.get("type") == "ping":
                await ws.send(json.dumps({"id": msg.get("id"), "type": "pong"}))
                continue
            if msg.get("type") != "message":
                continue
            topic = msg.get("topic", "")
            if not topic.startswith("/contractMarket/execution:"):
                continue
            sym = topic.split(":")[-1]
            data = msg.get("data") or {}
            counts[sym] += 1
            sides[(sym, data.get("side"))] += 1
            try:
                notional[sym] += float(data.get("size")) * float(data.get("price"))
            except (TypeError, ValueError):
                pass
    el = time.time() - t0
    print(f"{'symbol':14s} {'trades':>7s} {'perSec':>7s} {'notional$':>12s} {'buy%':>6s}")
    for s in sorted(syms, key=lambda x: -counts[x]):
        b = sides[(s, "buy")]
        sl = sides[(s, "sell")]
        tot = b + sl
        print(f"{s:14s} {counts[s]:7d} {counts[s]/el:7.2f} {notional[s]:12.0f} "
              f"{(b/tot*100 if tot else 0):6.1f}")


import sys
asyncio.run(main())
