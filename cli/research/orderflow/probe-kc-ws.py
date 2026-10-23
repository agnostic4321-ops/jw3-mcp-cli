#!/usr/bin/env python3
"""
PROBE — KuCoin futures PUBLIC websocket (keyless). What do the topics look
like, and how fast do they fire?

READ-ONLY. Never touches the account. No account call is made: the only
REST call is the keyless `bullet-public` token endpoint, which is on the
public tier, not the authenticated one.
"""
import asyncio
import json
import sys
import time
import urllib.request

TOKEN_URL = "https://api-futures.kucoin.com/api/v1/bullet-public"


def bullet():
    req = urllib.request.Request(TOKEN_URL, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["data"]


async def main():
    syms = sys.argv[1].split(",") if len(sys.argv) > 1 else ["LINKUSDTM", "AVAXUSDTM"]
    d = bullet()
    url = d["instanceServers"][0]["endpoint"]
    token = d["token"]
    ping_interval = d["instanceServers"][0].get("pingInterval", 18000)
    import websockets

    print(f"[probe] endpoint={url} pingInterval={ping_interval}")
    counts = {}
    samples = {}
    t0 = time.time()
    async with websockets.connect(url, max_size=None, ping_interval=None) as ws:
        await ws.send(json.dumps({"id": "1", "type": "ping"}))
        for s in syms:
            for topic in (f"/market/level2Depth5:{s}", f"/market/match:{s}", f"/market/tickerV2:{s}"):
                await ws.send(json.dumps({"id": f"sub-{topic}", "type": "subscribe", "topic": topic, "privateChannel": False, "response": True}))
        deadline = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 20)
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("type") == "ping":
                await ws.send(json.dumps({"id": msg.get("id"), "type": "pong"}))
                continue
            if msg.get("type") == "pong":
                continue
            topic = msg.get("topic", "?")
            counts[topic] = counts.get(topic, 0) + 1
            if topic not in samples:
                samples[topic] = json.dumps(msg)[:900]
        for t, c in sorted(counts.items()):
            print(f"\n=== {t}  ({c} msgs in {time.time()-t0:.1f}s) ===")
            print(samples[t])


asyncio.run(main())
