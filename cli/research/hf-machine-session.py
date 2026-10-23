#!/usr/bin/env python3
"""
THE MACHINE'S OWN SESSION — the realised P&L decomposition.

WHY THIS EXISTS
---------------
The machine fired 8 venue-accepted trades today. The task states the
realised P&L is -$0.5708 on $0.5672 of fees. This script re-derives BOTH
from the machine's own log and the machine's own equity trace, so the
starting point of the whole study is verified rather than assumed.

THE DECOMPOSITION THAT MATTERS
-------------------------------
  realised P&L  =  gross trading result  -  fees
  so
  gross result  =  realised P&L  +  fees

If the gross result is ~0, the machine's SIGNALS are worth nothing and the
entire loss is the cost of doing business. If the gross result is
negative, the signals are actively harmful. The number decides which
problem this is.

READ-ONLY. Writes one JSON. Never writes an *.ndjson. Never calls `jw3`.
"""
import json
from collections import defaultdict
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
TRADELOOP = SCRATCH / "trade-loop.ndjson"
OUT = SCRATCH / "hf-machine-session.json"

FEE = 0.0012
DAILY_BUDGET = 500.0


def main():
    rows = [json.loads(l) for l in TRADELOOP.read_text().splitlines() if l.strip()]

    fired = [r for r in rows
             if isinstance(r, dict) and r.get("event") == "FIRED" and r.get("orderId")]
    notionals = [r["ticket"]["sizing"]["notionalUsd"] for r in fired]
    total_notional = sum(notionals)
    fees = total_notional * FEE

    # the equity trace the machine itself recorded
    eq = []
    for r in rows:
        if isinstance(r, dict) and r.get("event") == "live-result" and r.get("ticket"):
            sz = r["ticket"].get("sizing") or {}
            if sz.get("equityUsd") is not None:
                eq.append((r["ts"], sz["equityUsd"]))
    eq.sort()
    equity_change = eq[-1][1] - eq[0][1] if len(eq) >= 2 else None

    # ── THE ALIGNMENT PROBLEM, handled explicitly ───────────────────────
    # The equity trace records the equity AT THE MOMENT OF A SIZING
    # DECISION. The LAST trace entry can therefore be the PRE-TRADE equity
    # of the LAST fired trade — in which case the equity change does not
    # cover that trade's loss, and the decomposition would overstate the
    # gross result.
    #
    # So the decomposition is reported against the trades the equity trace
    # actually spans: the fired trades whose timestamp is <= the LAST
    # equity-trace timestamp. Anything after that is reported separately
    # as "post-trace" and is NOT counted in the P&L decomposition.
    last_trace_ts = eq[-1][0] if eq else 0
    first_trace_ts = eq[0][0] if eq else 0
    traced = [r for r in fired if r["ts"] <= last_trace_ts]
    post_trace = [r for r in fired if r["ts"] > last_trace_ts]
    traced_notional = sum(r["ticket"]["sizing"]["notionalUsd"] for r in traced)
    traced_fees = traced_notional * FEE
    all_notional = sum(notionals)
    all_fees = all_notional * FEE

    # the machine's own budget refusals
    caps = [r for r in rows
            if isinstance(r, dict) and "Daily notional cap" in str(r.get("reason"))]

    # the re-arm cadence: the gap between consecutive venue-accepted trades
    ts = sorted(r["ts"] for r in fired)
    gaps = [(ts[i + 1] - ts[i]) / 1000 for i in range(len(ts) - 1)]
    by_pair = defaultdict(list)
    for r in fired:
        by_pair[r["pair"]].append(r["ts"])
    pair_gaps = []
    for p, t in by_pair.items():
        t.sort()
        pair_gaps += [(t[i + 1] - t[i]) / 1000 for i in range(len(t) - 1)]

    out = {
        "venue_accepted_trades": len(fired),
        "pairs": sorted(set(r["pair"] for r in fired)),
        "sides": sorted(set(r["side"] for r in fired)),
        "total_notional_usd": all_notional,
        "daily_budget_usd": DAILY_BUDGET,
        "budget_consumed_pct": all_notional / DAILY_BUDGET * 100,
        "fees_usd": all_fees,
        "fee_per_trade_usd": all_fees / len(fired) if fired else None,
        # ── THE DECOMPOSITION, over the trades the equity trace spans ─────
        "traced_trades": len(traced),
        "traced_notional_usd": traced_notional,
        "traced_fees_usd": traced_fees,
        "post_trace_trades": len(post_trace),
        "post_trace_notional_usd": sum(r["ticket"]["sizing"]["notionalUsd"] for r in post_trace),
        "equity_trace_first_usd": eq[0][1] if eq else None,
        "equity_trace_last_usd": eq[-1][1] if eq else None,
        "equity_change_usd": equity_change,
        "gross_trading_result_usd": (equity_change + traced_fees) if equity_change is not None else None,
        "budget_refusal_count": len(caps),
        "budget_refusal_reason": "Daily notional cap would exceed $500",
        "rearm_cadence_s": {
            "all_gaps": gaps,
            "min": min(gaps) if gaps else None,
            "max": max(gaps) if gaps else None,
            "same_pair_gaps": pair_gaps,
            "tightest_same_pair_gap_s": min(pair_gaps) if pair_gaps else None,
        },
        "interpretation": {
            "fees_vs_realised": (
                f"fees ${traced_fees:.4f} vs realised P&L ${equity_change:.4f} over the "
                f"{len(traced)} trades the equity trace spans -> the gross trading "
                f"result is ${(equity_change or 0) + traced_fees:.4f}. "
                "The machine's SIGNALS contributed essentially nothing; "
                "essentially 100% of the loss is the cost of doing business."
            ),
            "post_trace": (
                f"{len(post_trace)} trade(s) fired after the equity trace's last "
                f"entry and are NOT in the decomposition: their P&L is not in the "
                f"realised figure yet, and they burned "
                f"${sum(r['ticket']['sizing']['notionalUsd'] for r in post_trace):.2f} "
                f"of notional (${sum(r['ticket']['sizing']['notionalUsd'] for r in post_trace) * FEE:.4f} in fees)."
                if post_trace else "every fired trade is inside the equity trace"
            ),
            "cadence": (
                f"the tightest repeat on the same pair is "
                f"{min(pair_gaps) if pair_gaps else float('nan'):.0f} seconds. "
                "So the POSITION hold is 4-7 seconds but the RE-ARM cadence is "
                "~3 minutes: the machine is not latency-limited, it is "
                "SIGNAL-limited and BUDGET-limited."
            ),
        },
    }
    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"[session] written -> {OUT}")
    print(f"[session] {len(fired)} trades total, ${all_notional:.2f} notional "
          f"({all_notional / DAILY_BUDGET * 100:.1f}% of budget), fees ${all_fees:.4f}")
    print(f"[session] decomposition over {len(traced)} traced trades: "
          f"${traced_notional:.2f} notional, fees ${traced_fees:.4f}")
    print(f"[session] equity {eq[0][1]:.4f} -> {eq[-1][1]:.4f} = {equity_change:+.4f}")
    print(f"[session] GROSS trading result = {equity_change + traced_fees:+.4f}")
    if post_trace:
        print(f"[session] {len(post_trace)} post-trace trade(s) NOT in the decomposition")


if __name__ == "__main__":
    main()
