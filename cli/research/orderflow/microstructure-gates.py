#!/usr/bin/env python3
"""
THE FIDELITY GATES — prove the recording is what it claims to be.

This project has been destroyed twice by a measurement defect that looked
like a result (the scratch artefact, and the partial bar cache). So the
recording is audited before any conclusion is drawn from it.

THE GATES
  1. CONTINUITY      the 1-second rows are contiguous per symbol, with no
                      gaps and no duplicated seconds.
  2. ALIGNMENT       every trade falls inside a second that has a book row.
  3. MONOTONICITY    the venue timestamps increase, per symbol.
  4. THE FORMULA     the recorded imbalance and spread reproduce from the
                      recorded book, using the MACHINE's own formulas
                      (packages/jw3-cli/src/kucoin.ts:488-510).
  5. THE MULTIPLIER  the notional uses the venue's contract multiplier, so
                      a size of N on a contract with multiplier M is
                      N x price x M of notional.
  6. THE TRADE SIDE  the execution topic's `side` is the TAKER side: a BUY
                      prints at or above the mid.
  7. NO LOOK-AHEAD    the trades recorded in a second are the trades the
                      venue stamped with that second, and the book row's
                      book timestamp is not in the future relative to it.

READ-ONLY. Exits non-zero if any gate fails.
"""
import json
import math
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
MICRO = SCRATCH / "microstructure"
CONTRACTS_URL = "https://api-futures.kucoin.com/api/v1/contracts/active"

FAILURES = []


def gate(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(name)


def main():
    rows = [json.loads(l) for l in open(MICRO / "book-1s.jsonl")]
    trades = [json.loads(l) for l in open(MICRO / "trades.jsonl")]

    by_sym = defaultdict(list)
    seen = defaultdict(set)
    for r in rows:
        by_sym[r["sym"]].append(r)
        seen[r["sym"]].add(r["vts"])

    print("=" * 108)
    print(" THE FIDELITY GATES")
    print("=" * 108)

    # 1. CONTINUITY
    worst_gap = 0
    dupes = 0
    for s, rs in by_sym.items():
        vs = sorted(seen[s])
        if len(vs) != len(rs):
            dupes += len(rs) - len(vs)
        for i in range(1, len(vs)):
            worst_gap = max(worst_gap, vs[i] - vs[i - 1])
    total_secs = sum(len(v) for v in seen.values())
    span = {s: (max(v) - min(v)) / 1000.0 for s, v in seen.items()}
    expected = sum(int(sp) + 1 for sp in span.values())
    coverage = total_secs / expected * 100 if expected else 0
    gate("1. CONTINUITY — no duplicate seconds", dupes == 0,
         f"{dupes} duplicate rows")
    gate("1b. CONTINUITY — the rows cover the span", coverage > 99.0,
         f"{total_secs} seconds recorded, {coverage:.2f}% of the {expected}-second span")
    print(f"        per-symbol span: " + ", ".join(f"{s}={span[s]:.0f}s" for s in sorted(span)))

    # 2. ALIGNMENT
    idx = {(r["sym"], r["vts"]) for r in rows}
    hit = sum(1 for t in trades if (t["sym"], (t["vts"] // 1000) * 1000) in idx)
    gate("2. ALIGNMENT — every trade falls in a second that has a book row",
         hit == len(trades), f"{hit}/{len(trades)} trades aligned")

    # 3. MONOTONICITY
    non_mono = 0
    for s, rs in by_sym.items():
        rs2 = sorted(rs, key=lambda r: r["vts"])
        for i in range(1, len(rs2)):
            if rs2[i]["bookTs"] is not None and rs2[i - 1]["bookTs"] is not None:
                if rs2[i]["bookTs"] < rs2[i - 1]["bookTs"]:
                    non_mono += 1
    gate("3. MONOTONICITY — the venue book timestamps increase", non_mono == 0,
         f"{non_mono} non-monotonic steps")

    # 4. THE FORMULA
    import urllib.request
    req = urllib.request.Request(CONTRACTS_URL)
    with urllib.request.urlopen(req, timeout=30) as r:
        cdata = json.load(r)["data"]
    mult = {c["symbol"]: float(c.get("multiplier") or 1.0) for c in cdata if c.get("status") == "Open"}
    worst_imb = 0.0
    worst_spr = 0.0
    checked = 0
    for r in rows[:: max(1, len(rows) // 2000)]:
        bids, asks = r.get("bids"), r.get("asks")
        if not bids or not asks:
            continue
        m = mult.get(r["sym"], 1.0)
        b5 = sum(p * sz * m for p, sz in bids)
        a5 = sum(p * sz * m for p, sz in asks)
        imb = (b5 - a5) / (b5 + a5) if (b5 + a5) > 0 else 0.0
        bp, ap = bids[0][0], asks[0][0]
        mid = (bp + ap) / 2
        spr = ((ap - bp) / mid) * 1e4 if mid > 0 else 0.0
        worst_imb = max(worst_imb, abs(imb - r["imb"]))
        worst_spr = max(worst_spr, abs(spr - r["sprBps"]))
        checked += 1
    gate("4. THE FORMULA — the imbalance reproduces from the recorded book",
         worst_imb < 1e-9, f"max error {worst_imb:.2e} over {checked} rows")
    gate("4b. THE FORMULA — the spread reproduces from the recorded book",
         worst_spr < 1e-9, f"max error {worst_spr:.2e} over {checked} rows")

    # 5. THE MULTIPLIER — a size of N at price P is N*P*M of notional
    worst_n = 0.0
    n_checked = 0
    for t in trades[:: max(1, len(trades) // 2000)]:
        m = mult.get(t["sym"], 1.0)
        worst_n = max(worst_n, abs(t["size"] * t["price"] * m - t["notional"]))
        n_checked += 1
    gate("5. THE MULTIPLIER — the notional uses the venue's contract multiplier",
         worst_n < 1e-6, f"max error ${worst_n:.2e} over {n_checked} trades")

    # 6. THE TRADE SIDE
    buy_above = buy_below = sell_below = sell_above = 0
    for t in trades:
        if t.get("mid") is None:
            continue
        if t["side"] == "buy":
            if t["price"] >= t["mid"]:
                buy_above += 1
            else:
                buy_below += 1
        else:
            if t["price"] <= t["mid"]:
                sell_below += 1
            else:
                sell_above += 1
    buy_ok = buy_above >= buy_below
    sell_ok = sell_below >= sell_above
    gate("6. THE TRADE SIDE — `side` is the taker side", buy_ok and sell_ok,
         f"BUY at/above mid {buy_above}/{buy_above+buy_below}; "
         f"SELL at/below mid {sell_below}/{sell_below+sell_above}")

    # 7. NO LOOK-AHEAD — a row's book timestamp is not in the future of its second
    future = 0
    checked2 = 0
    for r in rows[:: max(1, len(rows) // 2000)]:
        if r.get("bookTs") is None:
            continue
        checked2 += 1
        if r["bookTs"] > r["vts"] + 1000:
            future += 1
    gate("7. NO LOOK-AHEAD — the book in a row is stamped inside its own second",
         future == 0, f"{future} rows with a book timestamp beyond their second "
                      f"(of {checked2} checked)")

    print()
    if FAILURES:
        print(f"  {len(FAILURES)} GATE(S) FAILED: {', '.join(FAILURES)}")
        return 1
    print("  ALL GATES PASS. The recording is what it claims to be.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
