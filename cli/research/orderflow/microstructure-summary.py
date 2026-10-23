#!/usr/bin/env python3
"""
THE SUMMARY — one command, one answer.

Prints the answer to the question the microstructure study asks:
  * does any of the six signals have a 90th-percentile forward move that
    exceeds the 0.12% taker round trip?
  * what does the arithmetic require?

It reads the analyzer's JSON (written by analyze-microstructure.py) and
the cost JSON (microstructure-cost.py). It computes nothing new.

READ-ONLY.
"""
import json
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
SIG = SCRATCH / "microstructure-signals.json"
COST = SCRATCH / "microstructure-cost.json"


def main():
    if not SIG.exists():
        print(f"FATAL: {SIG} not found — run analyze-microstructure.py first")
        return 2
    R = json.loads(SIG.read_text())
    A = R["arithmetic"]
    C = R.get("controls", {})
    SIGS = R.get("signals", {})
    PL = R.get("placebo", {})

    print("=" * 108)
    print(" THE MICROSTRUCTURE STUDY — THE ANSWER")
    print("=" * 108)
    m = R.get("meta", {})
    print(f"  recording        {m.get('minutes_run', '?')} minutes, "
          f"{len(R.get('symbols', []))} symbols: {', '.join(R.get('symbols', []))}")
    print(f"  the fee          {A['taker_round_trip']*100:.2f}% of notional = ${A['fee_usd']:.4f} "
          f"on a ${A['notional']:.0f} ticket")
    print()

    # ── the ORACLE CEILING ───────────────────────────────────────────────
    print("  THE CEILING — the best any signal on this data could possibly be:")
    for h in (1, 5, 15):
        o = C.get(f"oracle_{h}s")
        ol = C.get(f"oracle_lag1_{h}s")
        if not o:
            continue
        p90 = o["p90_pct"]
        extra = ""
        if ol:
            extra = (f"   |  lagged-1s (tradeable): p90 {ol['p90_pct']:.4f}%, "
                     f"MEAN {ol['mean_pct']:.4f}% -> net ${ol['net_ev_usd']:+.4f}")
        print(f"    H={h:>2d}s  perfect picker p90 = {p90:.4f}%  "
              f"(fee {A['taker_round_trip']*100:.2f}%) -> "
              f"{'CLEARS' if p90 > A['taker_round_trip']*100 else 'BELOW'} the fee{extra}")
    print()
    print("    READ THIS CAREFULLY. The p90 is the TAIL — one trade in ten. The MEAN is")
    print("    what a ticket earns, and the oracle's MEAN is what a PERFECT picker")
    print("    makes. A p90 above the fee does NOT mean a trade pays; it means one")
    print("    trade in ten could. The mean net is the number that decides the ticket.")
    print()

    # ── the six signals ──────────────────────────────────────────────────
    print("  THE SIX SIGNALS — best reportable arm per signal:")
    print(f"    {'signal':<22s} {'arm':<28s} {'H':>3s} {'nNO':>6s} {'p90%':>8s} {'mean%':>8s} "
          f"{'net$/tr':>9s} {'8/day$':>8s} {'p90>fee':>8s}")
    for grp, arms in SIGS.items():
        cands = [(k, b) for k, b in arms.items() if b.get("reportable")]
        if not cands:
            nmax = max((b.get("n_nonoverlap", 0) for b in arms.values()), default=0)
            print(f"    {grp:<22s} {'(no reportable arm)':<28s} {'-':>3s} {nmax:>6d} "
                  f"{'-':>8s} {'-':>8s} {'-':>9s} {'-':>8s} {'-':>8s}")
            continue
        # prefer the lagged (tradeable) arm at the longest horizon
        cands.sort(key=lambda kv: (("LAG" not in kv[0], -kv[1]["horizon_sec"],
                                    -(kv[1]["p90_nonoverlap_pct"] or -9e9))))
        k, b = cands[0]
        p90 = b["p90_nonoverlap_pct"]
        print(f"    {grp:<22s} {k:<28s} {b['horizon_sec']:>3d} {b['n_nonoverlap']:>6d} "
              f"{p90:>8.4f} {b['mean_pct']:>8.4f} {b['net_ev_usd']:>+9.4f} "
              f"{b['ev_per_8_trades_usd']:>+8.3f} "
              f"{('YES' if b['p90_nonoverlap_exceeds_fee'] else 'no'):>8s}")
    print()
    print("    -> the 'p90>fee' column is the QUESTION ASKED. The 'net$/tr' and '8/day$'")
    print("       columns are the TRADE. A p90 above the fee with a negative net means")
    print("       the tail can pay but the ticket cannot: the other nine trades in ten")
    print("       do not cover their own fee.")
    print()

    # ── the placebo ──────────────────────────────────────────────────────
    if PL:
        print("  THE PLACEBO (is the best arm better than a random pick of the same shape?)")
        for label, p in PL.items():
            print(f"    {label}: {p['signal']} / {p['arm']}")
            print(f"      arm p90 {p['arm_p90']:.4f}%  vs  random p90 median "
                  f"{p['placebo_p90_median']:.4f}%, max {p['placebo_p90_max']:.4f}%")
            print(f"      random runs at or above the arm: {p['placebo_runs_at_or_above_arm']}"
                  f"/{p['n_draws']}  -> {p['verdict']}")
        print()

    # ── the arithmetic ───────────────────────────────────────────────────
    print("  THE ARITHMETIC")
    print(f"    round trips/day by latency (7s):  {A['round_trips_per_day_by_latency']:,}")
    print(f"    round trips/day by the $500 cap:  {A['max_tickets_per_day']}")
    print(f"    -> THE NOTIONAL CAP BINDS. Latency is not close to binding.")
    print(f"    fees at {A['max_tickets_per_day']} tickets/day: "
          f"${A['max_tickets_per_day']*A['fee_usd']:.4f}/day, "
          f"${A['max_tickets_per_day']*A['fee_usd']*365:.2f}/year")
    print(f"    the $10,000 goal needs ${A['required_net_per_trade_usd']:,.2f} NET per ticket "
          f"= {A['required_net_per_trade_usd']/A['notional']*100:.1f}% of notional")
    print(f"    -> the gross move required per trade is "
          f"{A['required_gross_pct_of_notional']:.1f}% of notional")
    print()

    if COST.exists():
        K = json.loads(COST.read_text())
        print("  THE COST OF THE RECORDING")
        print(f"    {K['messages_per_sec']:.1f} websocket pushes/s, "
              f"{K['bytes_per_sec']/1e3:.1f} KB/s on disk")
        print(f"    {K['total_bytes']/1e6:.1f} MB for the run; "
              f"{K['projected_bytes_per_day']/1e6:.1f} MB/day for 5 symbols")
        print(f"    the machine's 43-symbol universe would be "
              f"{K['universe43_bytes_per_day']/1e6:.1f} MB/day")
        print(f"    REST calls made: {K['rest_calls_made']} (public tier). "
              f"ACCOUNT calls: {K['account_calls_made']}.")
        print()

    print("  VERDICT")
    oracle15 = C.get("oracle_lag1_15s") or C.get("oracle_15s")
    if oracle15 and oracle15["p90_pct"] <= A["taker_round_trip"] * 100:
        print(f"    At 15 seconds the HONEST CEILING — a perfect direction picker that enters")
        print(f"    when the signal is knowable — has a p90 of {oracle15['p90_pct']:.4f}%, which is")
        print(f"    {A['taker_round_trip']*100/oracle15['p90_pct']:.1f}x BELOW the "
              f"{A['taker_round_trip']*100:.2f}% fee.")
        print(f"    No signal can beat a perfect picker. So no signal on this recording pays,")
        print(f"    and the microstructure surface is closed for THIS account size.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
