"""The probe for `test-policy-units.mjs`.

It reproduces the DEFECT, not an idealised arm. The defect was: the
bootstrap resampled a PERCENT (`pnl_eq`) and fed it to a function that
expects a FRACTION, so every draw was `log1p(-3.29)` = NaN, and the
grid's `where(np.isfinite(g) & feas, g, -inf)` turned every NaN into
-inf. The maximiser then landed on the grid's floor in every draw, so
every arm printed the SAME confidence interval: the CI of an empty
sample.

So the probe measures the thing that matters: do the project's own
arms — which have DIFFERENT returns — get DIFFERENT CIs, and does each
CI bracket its own point estimate? With the unit bug present, every
arm gets the same floor.

The arms are the project's own live-gate and tape-only trades, so the
question is answerable on real data rather than on a synthetic shape
whose Kelly happens to sit at a grid boundary.
"""

import json
import os
from os.path import join

import policy_core as pc

SCRATCH = os.environ.get("JW3_SCRATCH", join(os.path.expanduser("~"), ".hermes/cache/scratch"))


def measure(rows, sel, geom):
    trades = pc.simulate([r for r in rows if r.get("tapeSide") and sel(r)], geom)
    rets = [t["pnl_frac"] * pc.RHO for t in trades]
    kg = pc.kelly_grid(rets, steps=pc.KELLY_GRID_STEPS)
    bs = pc.bootstrap_kelly(trades, pc.HOLD_MS, n_boot=300, steps=pc.KELLY_GRID_STEPS)
    return kg, bs, len(trades)


# THE INPUTS ARE OVERRIDABLE, so a TEST can pin a frozen snapshot.
#
# This probe used to read the LIVE collector file, which made its
# expectations statements about THE HOUR rather than about the code: it
# asserted that every bootstrap draw lands on zero, and that was true
# of the 5-hour sample it was written against and false of the 16-hour
# sample that had since accumulated (9% of draws now land above zero,
# so the CI opened from [0, 0] to [0, 1]).
#
# The arithmetic was never wrong — the negative edge was still detected
# and the Kelly point estimate was still exactly 0. The ASSERTION was
# pinned to a moving input. The same defect class as the wall-clock
# test: a test that reads live data asserts a fact about the world.
#
# So: the live file is still the default (the probe is a diagnostic
# over the current arm), but a test can pass a frozen snapshot and
# assert against it.
CONFLUENCE = os.environ.get("POLICY_CONFLUENCE") or join(SCRATCH, "confluence.ndjson")
BARS_FILE = os.environ.get("POLICY_BARS") or join(SCRATCH, "fee-floor-15m-bars.json")

rows = pc.read_rows(CONFLUENCE)
pc.BARS = pc.read_bars(BARS_FILE)

ka, ba, na = measure(rows, lambda r: pc.live_gate_side(r) == r["tapeSide"], pc.LIVE)
kb, bb, nb = measure(rows, lambda r: True, pc.LIVE)

print(
    "JSON:"
    + json.dumps(
        dict(
            a_n=na,
            a_f=ka["f_star"],
            a_at_boundary=ka.get("at_boundary"),
            a_neg=ka.get("negative_edge"),
            a_lo=(ba or {}).get("lo"),
            a_hi=(ba or {}).get("hi"),
            a_frac_zero=(ba or {}).get("frac_zero"),
            b_n=nb,
            b_f=kb["f_star"],
            b_at_boundary=kb.get("at_boundary"),
            b_lo=(bb or {}).get("lo"),
            b_hi=(bb or {}).get("hi"),
            b_frac_zero=(bb or {}).get("frac_zero"),
        )
    )
)
