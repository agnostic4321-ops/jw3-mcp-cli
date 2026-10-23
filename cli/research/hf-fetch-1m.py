#!/usr/bin/env python3
"""
HF-1M BAR FETCHER — 1-minute bars for the 43 confluence pairs.

WHY THIS EXISTS
---------------
The high-frequency question (1-5 minute horizon) cannot be answered on
the 15-minute cache: a 15-minute bar's high/low spans a quarter hour, so
a 1-5 minute move is invisible inside it. The round trip this project
actually runs is 4-7 SECONDS, so the microstructure that would have to
carry the edge lives at the 1-minute bar and below.

READ-ONLY AND KEYLESS
---------------------
It hits ONLY the PUBLIC kline endpoint (api-futures.kucoin.com). It never
authenticates, never reads the account, never places an order, and never
calls `jw3`. It writes ONE new file and never writes an *.ndjson.

THE BUDGET
----------
The live machine shares this host's egress and its STOP-ARMING path sits on
the same venue. So this fetcher paces itself at ~1090ms per request across
2 shards (~110 calls/min total), reads the gateway's own rate-limit headers
on every response, and yields hard when the gateway's remaining budget drops
below 200. The account's 60 calls/min authenticated budget is untouched —
this endpoint is keyless.

KuCoin returns AT MOST 200 bars per query, and the 200 are the most RECENT
ones in the range. So a page must be 200 BARS long, not 200 minutes of
wall-clock: at 1-minute granularity that is a 200-minute page.
"""
import http.client
import json
import os
import sys
import threading
import time
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
OUT = SCRATCH / "hf-1m-bars.json"
CONFLUENCE = SCRATCH / "confluence.ndjson"

DAYS = float(os.environ.get("DAYS", "14"))
BAR_MIN = 1
PAGE_BARS = 200
PAGE_MS = PAGE_BARS * BAR_MIN * 60_000
PACE_MS = float(os.environ.get("PACE_MS", "1090"))
SHARDS = int(os.environ.get("SHARDS", "2"))
HOST = "api-futures.kucoin.com"

# Gateway budget is shared per-IP with every other process on this host.
GW_HEADROOM = 200
GW_YIELD = 60


def load_pairs():
    rows = [json.loads(l) for l in CONFLUENCE.read_text().splitlines() if l.strip()]
    return sorted({r["pair"] for r in rows})


def load_cache():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text())
        except Exception:
            return {}
    return {}


def fetch_page(conn, sym, lo, hi):
    path = (
        f"/api/v1/kline/query?symbol={sym}&granularity={BAR_MIN}&from={int(lo)}&to={int(hi)}"
    )
    conn.request("GET", path, headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    body = resp.read()
    hdr = {k.lower(): v for k, v in resp.getheaders()}
    try:
        j = json.loads(body)
    except Exception:
        return [], hdr
    if str(j.get("code")) != "200000":
        return [], hdr
    return j.get("data") or [], hdr


def worker(pairs, cache, lock, stats):
    conn = http.client.HTTPSConnection(HOST, timeout=60)
    for pair in pairs:
        base = pair.split("/")[0]
        sym = f"{base}USDTM"
        with lock:
            have = cache.get(pair) or []
        oldest = have[0][0] if have else None
        newest = have[-1][0] if have else None
        now_ms = int(time.time() * 1000)
        from_ms = now_ms - int(DAYS * 24 * 3600_000)
        if oldest is not None and newest is not None:
            if oldest <= from_ms and newest >= now_ms - BAR_MIN * 60_000:
                continue
        merged = {b[0]: b for b in have}
        cursor = now_ms
        guard = 0
        while cursor > from_ms and guard < 400:
            guard += 1
            hi = min(cursor, now_ms)
            lo = max(from_ms, hi - PAGE_MS)
            if hi - lo < BAR_MIN * 60_000:
                break
            data, hdr = fetch_page(conn, sym, lo, hi)
            rem = hdr.get("gw-ratelimit-remaining")
            if rem is not None:
                try:
                    if int(rem) < GW_HEADROOM:
                        reset = hdr.get("gw-ratelimit-reset", "5000")
                        wait = max(2.0, int(reset) / 1000.0 + 1.0)
                        time.sleep(wait)
                except ValueError:
                    pass
            if not data:
                break
            for row in data:
                merged[int(row[0])] = [
                    int(row[0]),
                    float(row[1]),
                    float(row[2]),
                    float(row[3]),
                    float(row[4]),
                    float(row[5]),
                ]
            cursor = lo - 1
            time.sleep(PACE_MS / 1000.0)
        with lock:
            cache[pair] = sorted(merged.values())
            n = len(cache[pair])
            stats["done"] += 1
            print(
                f"[1m] {pair}: {n} bars  {time.strftime('%Y-%m-%d %H:%M', time.gmtime(cache[pair][0][0]/1000))}"
                f" -> {time.strftime('%Y-%m-%d %H:%M', time.gmtime(cache[pair][-1][0]/1000))}"
                f"  ({stats['done']}/{len(pairs)})",
                flush=True,
            )
            OUT.write_text(json.dumps(cache))
    conn.close()


def main():
    pairs = load_pairs()
    cache = load_cache()
    lock = threading.Lock()
    stats = {"done": 0}
    shards = [pairs[i::SHARDS] for i in range(SHARDS)]
    threads = [
        threading.Thread(target=worker, args=(s, cache, lock, stats), daemon=True)
        for s in shards
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    OUT.write_text(json.dumps(cache))
    print(f"[1m] done: {len(cache)} pairs -> {OUT}")


if __name__ == "__main__":
    main()
