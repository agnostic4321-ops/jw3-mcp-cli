"""
THE COVERAGE CUT — a regression test for the window defect.

THE DEFECT. The geometry studies took their window as the
INTERSECTION of every symbol's history. Inside a 45-day set, one symbol
with 5.2 days of history (PYBOBO/USDT) collapsed that intersection to
3.21 days — throwing away 92% of the sample, and reducing the
121,329-signal study to 13,845.

THE CONSEQUENCE, AND WHY IT WAS NOT A COSMETIC BUG. The cluster count
is calendar-bucketed at the ticket's own holding period, so a 3.21-day
signal span can produce at most 4 clusters at a 24h hold and 7 at 12h,
against a bar of 30. Every long-hold row failed its own bar for a
reason that had nothing to do with the geometry. The study was
underpowered BY CONSTRUCTION.

THE FIX. The union of what the bars cover is what the data supports;
the intersection is what one bad symbol decides. So the symbols that
cannot cover the window are dropped, and the coverage that survived is
stated — because a reader cannot otherwise tell a narrow window from a
wide one.

This test checks the THREE things that matter:
  1. The cut keeps the long-history symbols and drops the short one.
  2. The window it produces is materially WIDER than the intersection.
  3. The cluster ceiling at each hold width is derived from the window
     the study actually used — so the bar of 30 is reachable at some
     hold width, or the study says so.
"""
import os
import sys
import datetime
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from core import (load_venue, coverage_cut, DAY_MS, HOUR_MS,  # noqa: E402
                  MIN_COVERAGE_DAYS)

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("      [PASS] %s" % name)
    else:
        FAIL += 1
        print("      [FAIL] %s%s" % (name, (" — " + detail) if detail else ""))


def utc(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)


print("=" * 78)
print("THE COVERAGE CUT — the window regression")
print("=" * 78)
print("")

bars1h, bars15 = load_venue("kc")
common = sorted(set(bars1h) & set(bars15))

print("1. THE CUT KEEPS THE LONG HISTORY AND DROPS THE SHORT")
print("")
if not common:
    print("      [FAIL] no bar data — the test cannot run")
    sys.exit(1)

kept, dropped, union_lo, union_hi = coverage_cut(bars1h, bars15, common,
                                                  MIN_COVERAGE_DAYS)
check("the cut keeps most of the symbols", len(kept) >= len(common) - 3,
      "it kept %d of %d" % (len(kept), len(common)))
check("the cut drops the short-history symbols", len(dropped) >= 1,
      "it dropped none")

# the intersection — what the study USED to do
inter_lo = max(int(bars1h[p].t[0]) for p in common)
inter_hi = min(int(bars15[p].t[-1]) for p in common)
inter_days = (inter_hi - inter_lo) / DAY_MS

# the window the cut produces
cut_lo = max(int(bars1h[p].t[0]) for p in kept)
cut_hi = min(int(bars15[p].t[-1]) for p in kept)
cut_days = (cut_hi - cut_lo) / DAY_MS

print("      the intersection was: %.2f days" % inter_days)
print("      the cut window is:     %.2f days" % cut_days)
print("")

check("the cut window is materially wider than the intersection",
      cut_days > inter_days * 1.5,
      "%.2f days vs %.2f days" % (cut_days, inter_days))
check("the cut window covers at least 14 days",
      cut_days >= 14.0, "it covers %.2f days" % cut_days)

print("")
print("2. THE CLUSTER CEILING FOLLOWS THE WINDOW USED")
print("")
# The cluster count is calendar-bucketed at the ticket's own holding
# period, so the number of independent clusters a window can produce is
# bounded. A study must not claim to be powered if the window makes the
# bar unreachable.
for hold_h in (4, 12, 24):
    width_ms = hold_h * HOUR_MS
    ceiling = int((cut_hi - cut_lo) // width_ms) + 1
    print("      a %2dh hold -> at most %3d clusters from the cut window"
          % (hold_h, ceiling))
    check("a %2dh hold can reach the bar of 30" % hold_h,
          ceiling >= 30,
          "the ceiling is %d, so the bar of 30 is unreachable and every "
          "row would fail for a reason unrelated to the geometry" % ceiling)

print("")
print("3. THE OLD WINDOW COULD NOT REACH THE BAR AT THE LONG HOLDS")
print("")
for hold_h in (12, 24):
    width_ms = hold_h * HOUR_MS
    old_ceiling = int((inter_hi - inter_lo) // width_ms) + 1
    print("      a %2dh hold -> at most %3d clusters from the intersection"
          % (hold_h, old_ceiling))
    check("the old window was structurally underpowered at %2dh" % hold_h,
          old_ceiling < 30,
          "the old ceiling was %d, which is already enough" % old_ceiling)

print("")
print("=" * 78)
if FAIL == 0:
    print("PASSED — %d/%d checks" % (PASS, PASS))
else:
    print("FAILED — %d of %d checks failed" % (FAIL, PASS + FAIL))
print("=" * 78)
sys.exit(0 if FAIL == 0 else 1)
