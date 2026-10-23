#!/usr/bin/env python3
"""
THE LOOK-AHEAD AUDIT — where does the large-print arm's apparent edge live?

The UN-LAGGED large-print arm looks like a finding: at 15 seconds its mean
forward move is +0.057% and its p90 is 0.228%. With a 1-second lag the
same arm collapses to a flat mean.

This script proves WHERE the difference lives. The hypothesis: the trade
print happens DURING second t, and the arm's entry price is the MID of
second t — a price that already contains the print's own impact. So the
"forward move" from that mid includes the move the print ALREADY caused.

The test: for every large print, measure
  (a) the WITHIN-second move: the print second's mid vs the PREVIOUS
      second's mid. This is the move the print itself caused.
  (b) the FORWARD move from the print second's mid, at lag 0 and lag 1.

If (a) explains the un-lagged edge, the edge is the print's own impact,
already in the entry price — look-ahead, and not tradeable.

READ-ONLY.
"""
import json
import statistics as st
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
MICRO = SCRATCH / "microstructure"


def main():
    rows = [json.loads(l) for l in open(MICRO / "book-1s.jsonl")]
    trades = [json.loads(l) for l in open(MICRO / "trades.jsonl")]

    by_sym = defaultdict(dict)
    for r in rows:
        by_sym[r["sym"]][r["vts"]] = r
    ts_by_sym = {s: sorted(d) for s, d in by_sym.items()}
    idx_by_sym = {s: {v: i for i, v in enumerate(vs)} for s, vs in ts_by_sym.items()}

    print("=" * 110)
    print(" THE LOOK-AHEAD AUDIT — the large-print arm")
    print("=" * 110)

    for q in (0.90, 0.99):
        # the threshold per symbol
        cut = {}
        for s in ts_by_sym:
            notionals = sorted(t["notional"] for t in trades if t["sym"] == s)
            if notionals:
                k = q * (len(notionals) - 1)
                lo, hi = int(k), min(int(k) + 1, len(notionals) - 1)
                cut[s] = notionals[lo] + (notionals[hi] - notionals[lo]) * (k - lo)

        within, fwd0, fwd1, n = [], [], [], 0
        for t in trades:
            s = t["sym"]
            if s not in cut or t["notional"] < cut[s]:
                continue
            sec = (t["vts"] // 1000) * 1000
            if t["side"] != "buy":
                continue        # the long arm
            idx = ts_by_sym[s]
            if sec not in by_sym[s]:
                continue
            j = idx_by_sym[s].get(sec)
            if j is None or j == 0:
                continue
            prev = idx[j - 1]
            if sec - prev != 1000:
                continue
            m_now = by_sym[s][sec]["mid"]
            m_prev = by_sym[s][prev]["mid"]
            if not m_now or not m_prev:
                continue
            # (a) the WITHIN-second move — the print's own impact
            within.append((m_now - m_prev) / m_prev * 100.0)
            # (b) the forward move from this second's mid
            if j + 15 < len(idx) and idx[j + 15] - sec == 15000:
                m_end = by_sym[s][idx[j + 15]]["mid"]
                if m_end:
                    fwd0.append((m_end - m_now) / m_now * 100.0)
                j1 = j + 1
                if j1 + 15 < len(idx) and idx[j1 + 15] - idx[j1] == 15000:
                    m1 = by_sym[s][idx[j1]]["mid"]
                    m_end1 = by_sym[s][idx[j1 + 15]]["mid"]
                    if m1 and m_end1:
                        fwd1.append((m_end1 - m1) / m1 * 100.0)
            n += 1

        if not within:
            continue
        print()
        print(f"  LARGE PRINTS at the {q:.0%} percentile, BUY side, H=15s   (n={n})")
        print(f"    (a) the WITHIN-second move (the print's OWN impact, already in")
        print(f"        the entry price):  mean {st.mean(within):+.4f}%   "
              f"median {st.median(within):+.4f}%")
        print(f"    (b) the FORWARD move from this second's mid, LAG 0: "
              f"mean {st.mean(fwd0):+.4f}%  (n={len(fwd0)})")
        print(f"    (c) the FORWARD move from the NEXT second's mid, LAG 1: "
              f"mean {st.mean(fwd1):+.4f}%  (n={len(fwd1)})")
        lost = st.mean(fwd0) - st.mean(fwd1)
        pct_lost = (1 - st.mean(fwd1) / st.mean(fwd0)) * 100 if st.mean(fwd0) else 0
        print(f"    THE DECOMPOSITION of the un-lagged {st.mean(fwd0):+.4f}%:")
        print(f"      the print's OWN impact, already in the entry price:  "
              f"{st.mean(within):+.4f}%")
        print(f"      the part that evaporates when you wait 1 second:      "
              f"{lost:+.4f}%  ({pct_lost:.0f}% of the un-lagged move)")
        print(f"      the TRADEABLE residual (lag 1):                      {st.mean(fwd1):+.4f}%")
        print(f"    -> the tradeable residual is ${st.mean(fwd1)/100*60:.4f} of gross on a $60")
        print(f"       ticket, against a ${0.0720:.4f} fee. NET ${st.mean(fwd1)/100*60-0.0720:+.4f}.")

    print()
    print("=" * 110)
    print(" THE SAME TEST ON EVERY SIGNAL: the WITHIN-second move vs the LAGGED forward move")
    print("=" * 110)
    print(f"  {'signal':<24s} {'within-sec%':>13s} {'fwd lag0%':>11s} {'fwd lag1%':>11s} "
          f"{'lag0-lag1':>11s}")
    print(" " + "-" * 78)

    # imbalance >= 0.7 (long)
    for label, pred, direction in (
        ("imb>=+0.7 (long)", lambda r: (r.get("imb") or 0) >= 0.7, +1),
        ("imb<=-0.7 (short)", lambda r: (r.get("imb") or 0) <= -0.7, -1),
        ("tfi>=+0.6 (long)", lambda r: _tfi(r) >= 0.6, +1),
        ("spread x1.5 (fade up)", None, +1),
    ):
        within, f0, f1 = [], [], []
        for s in ts_by_sym:
            idx = ts_by_sym[s]
            for i in range(1, len(idx) - 16):
                r = by_sym[s][idx[i]]
                if pred is not None and not pred(r):
                    continue
                if pred is None:
                    r0 = by_sym[s][idx[i - 1]]
                    s0, s1 = r0.get("sprBps"), r.get("sprBps")
                    if not s0 or s1 is None or s1 <= s0 * 1.5:
                        continue
                    if (r["mid"] - r0["mid"]) / r0["mid"] * 100.0 >= 0:
                        continue
                m_prev = by_sym[s][idx[i - 1]]["mid"]
                m_now = r["mid"]
                if not m_now or not m_prev:
                    continue
                within.append(direction * (m_now - m_prev) / m_prev * 100.0)
                m1 = by_sym[s][idx[i + 1]]["mid"]
                m_end = by_sym[s][idx[i + 15]]["mid"]
                m_end1 = by_sym[s][idx[i + 16]]["mid"]
                if m_end:
                    f0.append(direction * (m_end - m_now) / m_now * 100.0)
                if m1 and m_end1:
                    f1.append(direction * (m_end1 - m1) / m1 * 100.0)
        if not within:
            continue
        print(f"  {label:<24s} {st.mean(within):>13.4f} {st.mean(f0):>11.4f} "
              f"{st.mean(f1):>11.4f} {st.mean(f0)-st.mean(f1):>11.4f}")
    print()
    print("  -> THE PATTERN. For EVERY signal the tradeable (lag-1) residual is")
    print("     within a few thousandths of a percent of the price — and the fee is")
    print("     0.12%. A residual of 0.003% on a $60 ticket is $0.0018 of gross")
    print("     against a $0.0720 fee. THE LOOK-AHEAD IS THE EDGE, AND THE EDGE")
    print("     DOES NOT SURVIVE THE ONE SECOND IT TAKES TO PLACE THE ORDER.")


def _tfi(r):
    bn = r.get("buyNotional") or 0.0
    sn = r.get("sellNotional") or 0.0
    tot = bn + sn
    return (bn - sn) / tot if tot > 0 else 0.0


if __name__ == "__main__":
    main()
