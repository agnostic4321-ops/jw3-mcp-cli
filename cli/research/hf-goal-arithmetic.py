#!/usr/bin/env python3
"""
THE GOAL ARITHMETIC — what per-trade edge does $10,000 actually require?

THE ACCOUNT, AS MEASURED
------------------------
  equity / free margin       $57.1579522047
  per-position notional cap   $60 (FIXED — a constant, not equity-proportional)
  daily notional budget       $500 (FIXED — a constant, not equity-proportional)
  daily loss cap              $12
  trades/day cap              120
  fees                       taker 0.06%/side, maker 0.02%/side (VIP0)
  taker round trip            0.12% of notional = $0.0720 on a $60 ticket
  measured spread             10.7 bps median across the 43 pairs
  ALL-IN round trip           0.12% + 0.107% = 22.7 bps = $0.1361 on $60

THE CENTRAL FACT
----------------
The two caps that bound throughput are ABSOLUTE DOLLAR amounts. They do
not scale with equity. So the account's trade COUNT per day is fixed at
floor($500 / $60) = 8, whether equity is $57 or $10,000.

The goal, however, is a DOLLAR amount: $10,000 of equity from $57.16.

That is the whole problem, and it is arithmetic, not market structure:
the machine's throughput is capped in dollars while its target is a dollar
target. Compounding cannot rescue it, because the per-day trade count —
and therefore the per-day maximum profit — does not grow with equity.

THE LADDER
----------
Both cases are computed:
  (A) THE FIXED CAP — the caps stay at $60 and $500 forever. This is what
      the account's configuration actually does today.
  (B) A SCALING CAP — the notional cap becomes a fraction of equity, and
      the daily budget scales with it. This is the ONLY configuration in
      which the goal is arithmetically reachable at a sane win rate.

The question each answers: what NET dollars per trade does the $10,000
goal require, and what win rate does that imply after the 0.12% taker
round trip?

READ-ONLY. Writes one JSON. Never writes an *.ndjson. Never calls `jw3`.
"""
import json
import math
from pathlib import Path

SCRATCH = Path.home() / ".hermes/cache/scratch"
OUT = SCRATCH / "hf-goal-arithmetic.json"

EQUITY = 57.1579522047
GOAL = 10000.0
NOTIONAL = 60.0
DAILY_BUDGET = 500.0
FEE = 0.0012
SPREAD = 0.0010685
NOTIONAL_MULT = 1.0  # the live path's notional/equity ratio: $60 on $57.16
DAILY_MULT = 8.7442  # $500 / $57.16 — the daily budget in units of equity


def net_per_trade_equity(win_rate, tp, sl, fee=FEE):
    """net fraction of notional per trade."""
    return win_rate * tp - (1 - win_rate) * sl - fee


def breakeven_win_rate(tp, sl, fee=FEE):
    return (sl + fee) / (tp + sl)


def days_to_goal(net_per_trade, trades_per_day, start=EQUITY, goal=GOAL, cap=365000):
    eq = start
    d = 0
    while eq < goal and d < cap:
        eq += trades_per_day * net_per_trade
        d += 1
    return d if eq >= goal else None


def main():
    gap = GOAL - EQUITY
    out = {
        "account": {
            "equity_usd": EQUITY,
            "goal_usd": GOAL,
            "gap_usd": gap,
            "notional_cap_usd": NOTIONAL,
            "daily_notional_budget_usd": DAILY_BUDGET,
            "trades_per_day_floor": int(DAILY_BUDGET // NOTIONAL),
            "trades_per_day_exact": DAILY_BUDGET / NOTIONAL,
            "fee_round_trip_pct": FEE * 100,
            "fee_round_trip_usd": NOTIONAL * FEE,
            "median_spread_bps": SPREAD * 10000,
            "all_in_round_trip_bps": (FEE + SPREAD) * 10000,
            "all_in_round_trip_usd": NOTIONAL * (FEE + SPREAD),
        },
        "the_central_fact": (
            "The $60 per-position cap and the $500 daily notional budget are "
            "ABSOLUTE DOLLAR CONSTANTS, not equity-proportional. The trade "
            "count per day is therefore fixed at 8 whether equity is $57.16 "
            "or $10,000. Throughput is capped in dollars; the target is a "
            "dollar target. Compounding cannot fix this, because the "
            "per-day maximum profit does not grow with equity."
        ),
    }

    # ── CASE A: the FIXED caps (what the account does today) ─────────────
    tpd = int(DAILY_BUDGET // NOTIONAL)
    out["case_A_fixed_caps"] = {
        "trades_per_day": tpd,
        "max_daily_profit_at_100pct_win_and_1_to_1": tpd * NOTIONAL * 0.01,
        "required_net_per_trade_usd": {},
        "required_net_pct_of_notional": {},
        "required_net_pct_of_equity": {},
        "days_to_goal_at_various_net": [],
    }
    for days in (1, 7, 30, 90, 180, 365, 730, 1095, 3650):
        need = gap / (tpd * days)
        out["case_A_fixed_caps"]["required_net_per_trade_usd"][f"{days}d"] = need
        out["case_A_fixed_caps"]["required_net_pct_of_notional"][f"{days}d"] = need / NOTIONAL * 100
        out["case_A_fixed_caps"]["required_net_pct_of_equity"][f"{days}d"] = need / EQUITY * 100

    for net in (0.01, 0.05, 0.10, 0.25, 0.50, 1.00, 2.00, 5.00, 10.00, 50.00):
        d = days_to_goal(net, tpd)
        out["case_A_fixed_caps"]["days_to_goal_at_various_net"].append({
            "net_per_trade_usd": net,
            "days": d,
            "years": (d / 365.0) if d else None,
        })

    # ── CASE B: a SCALING cap (notional and budget grow with equity) ────
    # If the cap were, say, 1x equity and the budget 8.74x equity (the
    # current RATIOS), then both the notional and the trade count grow, so
    # the per-day profit is proportional to equity and compounding works.
    out["case_B_scaling_caps"] = {
        "model": "notional = 1x equity, daily budget = 8.7442x equity",
        "trades_per_day_at_start": DAILY_BUDGET / NOTIONAL,
        "note": (
            "The ratios are held at the account's CURRENT values. The trade "
            "COUNT stays 8/day; what changes is the DOLLAR SIZE of each "
            "trade, so the per-day profit scales with equity and "
            "compounding works."
        ),
        "days_to_goal_by_net_pct_of_notional": [],
    }
    for net_pct in (0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20):
        eq = EQUITY
        d = 0
        while eq < GOAL and d < 365000:
            notional = eq * NOTIONAL_MULT
            budget = eq * DAILY_MULT
            t = budget / notional
            eq += t * notional * net_pct
            d += 1
        out["case_B_scaling_caps"]["days_to_goal_by_net_pct_of_notional"].append({
            "net_pct_of_notional": net_pct * 100,
            "days": d if eq >= GOAL else None,
            "years": (d / 365.0) if eq >= GOAL else None,
        })

    # ── THE WIN-RATE LADDER for the 365-day goal ─────────────────────────
    # net needed per trade in the FIXED case = gap / (8 * 365)
    need_365 = gap / (tpd * 365)
    need_frac_365 = need_365 / NOTIONAL
    out["win_rate_for_goal"] = {
        "horizon_days": 365,
        "trades_per_day": tpd,
        "trades_in_year": tpd * 365,
        "required_net_per_trade_usd": need_365,
        "required_net_pct_of_notional": need_frac_365 * 100,
        "required_net_pct_of_equity": need_365 / EQUITY * 100,
        "ladder": [],
    }
    for tp in (0.0012, 0.0024, 0.0036, 0.0048, 0.0072, 0.0096, 0.0120):
        for sl in (0.0012, 0.0024, 0.0036, 0.0048):
            w = (sl + FEE + need_frac_365) / (tp + sl)
            be = breakeven_win_rate(tp, sl)
            out["win_rate_for_goal"]["ladder"].append({
                "target_pct": tp * 100,
                "stop_pct": sl * 100,
                "R": tp / sl,
                "break_even_win_rate_pct": be * 100,
                "win_rate_required_for_365d_goal_pct": w * 100,
                "feasible": w <= 1.0,
            })

    # ── THE MAXIMUM POSSIBLE: what is the best case the fixed cap allows?
    # Even a PERFECT trade (win every time, capture 1%) yields:
    perfect_daily = tpd * NOTIONAL * 0.01
    out["best_case_fixed_cap"] = {
        "perfect_win_rate_1pct_move_daily_usd": perfect_daily,
        "days_to_goal": days_to_goal(NOTIONAL * 0.01, tpd),
        "years_to_goal": (days_to_goal(NOTIONAL * 0.01, tpd) or 0) / 365.0,
        "note": (
            "This is the CEILING: 8 trades/day, every one a winner capturing "
            "a full 1% move. No signal, no win rate, and no execution "
            "quality can beat it under the fixed caps."
        ),
    }

    # ── what the caps would have to be for a sane horizon ────────────────
    out["what_the_caps_would_have_to_be"] = {
        "for_365_days_at_net_1pct_of_notional": {
            "required_daily_budget_usd": gap / 365 / 0.01,
            "required_notional_usd": gap / 365 / 0.01 / 8,
            "multiple_of_current_budget": (gap / 365 / 0.01) / DAILY_BUDGET,
        },
        "for_365_days_at_net_2pct_of_notional": {
            "required_daily_budget_usd": gap / 365 / 0.02,
            "required_notional_usd": gap / 365 / 0.02 / 8,
            "multiple_of_current_budget": (gap / 365 / 0.02) / DAILY_BUDGET,
        },
        "for_90_days_at_net_1pct_of_notional": {
            "required_daily_budget_usd": gap / 90 / 0.01,
            "multiple_of_current_budget": (gap / 90 / 0.01) / DAILY_BUDGET,
        },
    }

    # ── the LATENCY arithmetic ───────────────────────────────────────────
    out["latency"] = {
        "measured_round_trip_s": [4, 7],
        "seconds_in_24h": 86400,
        "round_trips_clock_allows_at_4s": 86400 // 4,
        "round_trips_clock_allows_at_7s": 86400 // 7,
        "notional_needed_at_21600_round_trips_usd": 21600 * NOTIONAL,
        "daily_notional_budget_usd": DAILY_BUDGET,
        "verdict": (
            "The CLOCK IS NOT THE BINDING CONSTRAINT. At 4-7 seconds per "
            "round trip the clock allows 12,343-21,600 round trips a day, "
            "which would need $740,000-$1,296,000 of daily notional. The "
            "budget is $500. The machine is limited by MONEY, not by "
            "latency — which means a faster machine trades no faster."
        ),
        "trades_per_day_needed_to_burn_the_budget": DAILY_BUDGET / NOTIONAL,
        "seconds_of_trading_needed_to_burn_the_budget": (
            (DAILY_BUDGET / NOTIONAL) * 5.5
        ),
        "note": (
            "8 trades at a 5.5-second average round trip is 44 seconds of "
            "actual trading per day. The other 23 hours 56 minutes are "
            "spent WAITING for the next signal — so the latency budget is "
            "not a constraint on throughput and there is no throughput "
            "argument for a faster engine."
        ),
    }

    # ── the FEASIBILITY verdict per win rate, at the shipped ticket ───────
    # the live ticket: TP ~0.3-0.5% of notional, stop ~0.9-2.0%
    out["shipped_ticket"] = {
        "note": (
            "The live path's ticket: TP = clamp(0.4*ATR, 0.3%, 0.5%), "
            "stop = 3*d/(200+d) with d = clamp(0.9*ATR, 0.6%, 1.5%). On a "
            "$60 ticket with a 0.12% taker round trip."
        ),
        "ladder": [],
    }
    for tp, sl in ((0.003, 0.0093), (0.003, 0.0122), (0.004, 0.0093),
                   (0.004, 0.0117), (0.004, 0.0122), (0.005, 0.0117),
                   (0.005, 0.0122), (0.0048, 0.0093)):
        be = breakeven_win_rate(tp, sl)
        be_all = breakeven_win_rate(tp, sl, FEE + SPREAD)
        out["shipped_ticket"]["ladder"].append({
            "target_pct": tp * 100,
            "stop_pct": sl * 100,
            "R": tp / sl,
            "break_even_win_rate_fee_only_pct": be * 100,
            "break_even_win_rate_all_in_pct": be_all * 100,
            "win_usd": NOTIONAL * tp,
            "loss_usd": NOTIONAL * sl,
            "fee_usd": NOTIONAL * FEE,
            "net_at_90pct_win_fee_only": NOTIONAL * net_per_trade_equity(0.90, tp, sl),
            "net_at_90pct_win_all_in": NOTIONAL * net_per_trade_equity(0.90, tp, sl, FEE + SPREAD),
            "net_at_95pct_win_fee_only": NOTIONAL * net_per_trade_equity(0.95, tp, sl),
            "net_at_95pct_win_all_in": NOTIONAL * net_per_trade_equity(0.95, tp, sl, FEE + SPREAD),
            "net_at_100pct_win_fee_only": NOTIONAL * net_per_trade_equity(1.0, tp, sl),
            "net_at_100pct_win_all_in": NOTIONAL * net_per_trade_equity(1.0, tp, sl, FEE + SPREAD),
        })

    OUT.write_text(json.dumps(out, indent=2, default=str))
    print(f"[goal] written -> {OUT}")
    print(f"[goal] gap ${gap:.2f}, {tpd} trades/day at the fixed cap")
    print(f"[goal] 365d goal needs ${need_365:.4f}/trade "
          f"= {need_frac_365*100:.4f}% of notional")


if __name__ == "__main__":
    main()
