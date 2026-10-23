#!/usr/bin/env python3
"""
PROBE v3 — KuCoin futures PUBLIC websocket, keyless.

Fixes from the repo's own client (packages/jw3-cli/src/kucoin-ws.ts):
  * the connect URL is `<endpoint>?token=<token>` — no token, no socket.
  * futures topics are under /contractMarket/, not /market/.

Tries a set of candidate topics and reports which actually push frames.

READ-ONLY. Public token endpoint only. Never touches the account.
"""
import asyncio
import json
import sys
import time
import urllib.request
from urllib.parse import quote

import websockets

TOKEN_URL = "https://api-futures.kucoin.com/api/v1/bullet-public"


def bullet():
    req = urllib.request.Request(TOKEN_URL, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["data"]


CANDIDATES = [
    "/contractMarket/tickerV2:{s}",
    "/contractMarket/level2Depth5:{s}",
    "/contractMarket/level2Depth20:{s}",
    "/contractMarket/execution:{s}",
    "/market/level2Depth5:{s}",
    "/market/match:{s}",
]


async def main():
    sym = sys.argv[1] if len(sys.argv) > 1 else "LINKUSDTM"
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 25
    d = bullet()
    srv = d["instanceServers"][0]
    url = f"{srv['endpoint']}?token={quote(d['token'])}"
    ping_ms = srv.get("pingInterval", 18000)
    print(f"[probe] {url.split('?')[0]} pingInterval={ping_ms} sym={sym}")

    counts, samples = {}, {}
    t0 = time.time()
    try:
        async with websockets.connect(url, max_size=None, ping_interval=None, open_timeout=20) as ws:
            for i, tpl in enumerate(CANDIDATES):
                topic = tpl.format(s=sym)
                await ws.send(json.dumps({
                    "id": str(2000 + i), "type": "subscribe", "topic": topic,
                    "privateChannel": False, "response": True,
                }))
            print(f"[probe] sent {len(CANDIDATES)} subscribes")
            deadline = time.time() + secs
            last_ping = time.time()
            while time.time() < deadline:
                if time.time() - last_ping > ping_ms / 1000:
                    await ws.send(json.dumps({"id": "ping-1", "type": "ping"}))
                    last_ping = time.time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=3)
                except asyncio.TimeoutError:
                    continue
                except websockets.exceptions.ConnectionClosed as e:
                    print(f"[probe] CLOSED: {e}")
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                mtype = msg.get("type")
                if mtype in ("welcome", "ack", "pong"):
                    if mtype == "ack":
                        print(f"[probe] ACK {msg.get('data',{}).get('code')} for {msg.get('data',{}).get('topic')} : {json.dumps(msg)[:220]}")
                    continue
                if mtype == "error":
                    print(f"[probe] ERROR frame: {json.dumps(msg)[:300]}")
                    continue
                if mtype == "ping":
                    await ws.send(json.dumps({"id": msg.get("id"), "type": "pong"}))
                    continue
                topic = msg.get("topic", "?")
                counts[topic] = counts.get(topic, 0) + 1
                if topic not in samples:
                    samples[topic] = json.dumps(msg)[:1400]
    except Exception as e:
        print(f"[probe] FAILED: {type(e).__name__}: {e}")

    for t, c in sorted(counts.items()):
        print(f"\n=== {t}  ({c} msgs in {time.time()-t0:.1f}s) ===")
        print(samples[t])
    print("\n[probe] counts:", counts)


asyncio.run(main())
