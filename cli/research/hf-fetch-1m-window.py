#!/usr/bin/env python3
"""
TARGETED 1-MINUTE FETCH — the collector's own window, all 43 pairs.

WHY THIS EXISTS
---------------
`confluence.ndjson` covers only ~5.7 hours of TODAY (2026-10-21
07:37-13:20 UTC). Test 2 resolves the collector's rows against the
1-minute bars, so the bars must cover THAT window on ALL 43 pairs. That
is ~340 one-minute bars per pair = 2 pages per pair = ~86 calls total.

The deep 14-day backfill (hf-fetch-1m.py) is for Test 1 and Test 3, which
need history. This script is for Test 2, and it is cheap.

It MERGES into the same hf-1m-bars.json cache, so it never re-fetches what
is already there and never overwrites a longer series with a shorter one.

READ-ONLY AND KEYLESS. Public kline endpoint only. Never authenticates,
never reads the account, never places an order, never calls `jw3`.
"""
import http.client
import json
import os
import threading
import time
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
OUT = SCRATCH / "hf-1m-bars.json"
CONFLUENCE = SCRATCH / "confluence.ndjson"

BAR_MIN = 1
PAGE_BARS = 200
PAGE_MS = PAGE_BARS * BAR_MIN * 60_000
PACE_MS = float(os.environ.get("PACE_MS", "1200"))
SHARDS = int(os.environ.get("SHARDS", "2"))
HOST = "api-futures.kucoin.com"
GW_HEADROOM = 200


def load_pairs_and_window():
    rows = [json.loads(l) for l in CONFLUENCE.read_text().splitlines() if l.strip()]
    pairs = sorted({r["pair"] for r in rows})
    lo = min(r["ts"] for r in rows) - 10 * 60_000
    hi = max(r["ts"] for r in rows) + 10 * 60_000
    return pairs, lo, hi


def load_cache():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text())
        except Exception:
            return {}
    return {}


def fetch_page(conn, sym, lo, hi):
    conn.request(
        "GET",
        f"/api/v1/kline/query?symbol={sym}&granularity={BAR_MIN}&from={int(lo)}&to={int(hi)}",
        headers={"Content-Type": "application/json"},
    )
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


def worker(pairs, cache, lock, stats, win):
    conn = http.client.HTTPSConnection(HOST, timeout=60)
    lo_win, hi_win = win
    for pair in pairs:
        base = pair.split("/")[0]
        sym = f"{base}USDTM"
        with lock:
            have = cache.get(pair) or []
        ts_have = {b[0] for b in have}
        need_pages = []
        # walk the window backwards in 200-minute pages
        cursor = hi_win
        while cursor > lo_win:
            hi = min(cursor, hi_win)
            lo = max(lo_win, hi - PAGE_MS)
            if hi - lo < BAR_MIN * 60_000:
                break
            need_pages.append((lo, hi))
            cursor = lo - 1
        merged = {b[0]: b for b in have}
        added = 0
        for lo, hi in need_pages:
            data, hdr = fetch_page(conn, sym, lo, hi)
            rem = hdr.get("gw-ratelimit-remaining")
            if rem is not None:
                try:
                    if int(rem) < GW_HEADROOM:
                        reset = hdr.get("gw-ratelimit-reset", "5000")
                        time.sleep(max(2.0, int(reset) / 1000.0 + 1.0))
                except ValueError:
                    pass
            if not data:
                continue
            for row in data:
                key = int(row[0])
                if key not in ts_have:
                    merged[key] = [key, float(row[1]), float(row[2]), float(row[3]),
                                   float(row[4]), float(row[5])]
                    added += 1
            time.sleep(PACE_MS / 1000.0)
        with lock:
            cache[pair] = sorted(merged.values())
            stats["done"] += 1
            print(f"[1m-win] {pair}: +{added} bars -> {len(cache[pair])} total "
                  f"({stats['done']}/{len(pairs)})", flush=True)
            OUT.write_text(json.dumps(cache))
    conn.close()


def main():
    pairs, lo, hi = load_pairs_and_window()
    cache = load_cache()
    lock = threading.Lock()
    stats = {"done": 0}
    print(f"[1m-win] window {lo} .. {hi} "
          f"({(hi - lo) / 3.6e6:.1f}h), {len(pairs)} pairs", flush=True)
    shards = [pairs[i::SHARDS] for i in range(SHARDS)]
    threads = [
        threading.Thread(target=worker, args=(s, cache, lock, stats, (lo, hi)), daemon=True)
        for s in shards
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    OUT.write_text(json.dumps(cache))
    print(f"[1m-win] done: {len(cache)} pairs -> {OUT}")


if __name__ == "__main__":
    main()
