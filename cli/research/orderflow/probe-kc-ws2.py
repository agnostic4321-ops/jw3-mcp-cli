#!/usr/bin/env python3
"""
PROBE v2 — KuCoin futures PUBLIC websocket, keyless. Robust: capture the
close frame, try a minimal subscribe, and report exactly what the server
says.

READ-ONLY. Public token endpoint only. Never touches the account.
"""
import asyncio
import json
import sys
import time
import urllib.request

import websockets

TOKEN_URL = "https://api-futures.kucoin.com/api/v1/bullet-public"


def bullet():
    req = urllib.request.Request(TOKEN_URL, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["data"]


async def main():
    sym = sys.argv[1] if len(sys.argv) > 1 else "LINKUSDTM"
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 20
    d = bullet()
    srv = d["instanceServers"][0]
    url, token = srv["endpoint"], d["token"]
    print(f"[probe] endpoint={url} encrypt={srv.get('encrypt')} pingInterval={srv.get('pingInterval')}")

    counts = {}
    samples = {}
    t0 = time.time()
    try:
        async with websockets.connect(url, max_size=None, ping_interval=None, open_timeout=20) as ws:
            topics = [f"/market/level2Depth5:{sym}", f"/market/match:{sym}"]
            for i, topic in enumerate(topics):
                await ws.send(json.dumps({
                    "id": str(1000 + i), "type": "subscribe", "topic": topic,
                    "privateChannel": False, "response": True,
                }))
                print(f"[probe] subscribed {topic}")
            deadline = time.time() + secs
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                except asyncio.TimeoutError:
                    continue
                except websockets.exceptions.ConnectionClosed as e:
                    print(f"[probe] CLOSED: {e} rcv={getattr(e,'rcvd',None)} sent={getattr(e,'sent',None)}")
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    print(f"[probe] non-json: {raw[:200]}")
                    continue
                if msg.get("type") == "ping":
                    await ws.send(json.dumps({"id": msg.get("id"), "type": "pong"}))
                    print("[probe] ping->pong")
                    continue
                topic = msg.get("topic", msg.get("type", "?"))
                counts[topic] = counts.get(topic, 0) + 1
                if topic not in samples:
                    samples[topic] = json.dumps(msg)[:1200]
    except Exception as e:
        print(f"[probe] FAILED: {type(e).__name__}: {e}")

    for t, c in sorted(counts.items()):
        print(f"\n=== {t}  ({c} msgs in {time.time()-t0:.1f}s) ===")
        print(samples[t])
    print("\n[probe] counts:", counts)


asyncio.run(main())
