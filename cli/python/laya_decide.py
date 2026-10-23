#!/usr/bin/env python3
"""Laya decide bridge v0 (stdin JSON -> stdout JSON).

Pure-stdlib, rule-based directional choice over the market-state JSON the
`jw3 decide` command builds. No model weights, no network, no trades —
deterministic so the CLI's mocked-bridge tests pin it exactly.

Stdin:  {"pair": str, "symbol": str, "last": f,
         "tape": {"chg": f, "vratio": f, "vslope": "up|down",
                  "offHighPct": f, "offLowPct": f, "atrPct": f|null, "n": n},
         "book": {"mid": f, "sprBps": f, "bid5Usd": f, "ask5Usd": f,
                  "imb": f} | null,
         "jev": {"side": "long|short|none", "agreement": f,
                 "uncertain": bool} | null}
Stdout: {"choice": "long|short|flat", "confidence": f,
         "score": f, "reasons": [str...], "ms": n}

Scoring v0 (see ~/laya/CALIBRATION.md — refit on scored outcomes):
  jev   = side x agreement x 1.0            (absent/uncertain -> 0)
  tape  = sign(chg) x min(|chg| / max(2xATR, 0.5), 1) x 0.6
  book  = imb x 0.5                        (absent -> 0)
  score = jev + tape + book
  |score| >= 0.35 decides long/short, else flat.
  confidence = 0.5 + 0.4 x min(|score|, 1), capped 0.9; x0.7 when JEV
  is missing/uncertain, x0.8 when the spread is wide (>10bps).
"""
import json
import sys
import time

t0 = time.perf_counter()

DECIDE_THRESHOLD = 0.35
WIDE_SPREAD_BPS = 10.0


def num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return f


try:
    state = json.load(sys.stdin)
except Exception as e:
    print(json.dumps({"error": "bad stdin json: %s" % e}), file=sys.stderr)
    sys.exit(2)

if not isinstance(state, dict):
    print(json.dumps({"error": "market state must be an object"}), file=sys.stderr)
    sys.exit(2)

tape = state.get("tape")
if not isinstance(tape, dict):
    print(json.dumps({"error": "market state needs a tape block"}), file=sys.stderr)
    sys.exit(2)

chg = num(tape.get("chg"))
atr = num(tape.get("atrPct"))
vratio = num(tape.get("vratio"), 1.0)
vslope = tape.get("vslope")
if chg is None:
    print(json.dumps({"error": "tape.chg must be a finite number"}), file=sys.stderr)
    sys.exit(2)

reasons = []

# JEV leg (1.0 weight): only a certain directional call counts.
jev = state.get("jev")
jev_side = (jev or {}).get("side") if isinstance(jev, dict) else None
jev_agree = num((jev or {}).get("agreement"), 0.0) if isinstance(jev, dict) else 0.0
jev_uncertain = bool((jev or {}).get("uncertain", True)) if isinstance(jev, dict) else True
jev_term = 0.0
if isinstance(jev, dict) and not jev_uncertain and jev_side in ("long", "short"):
    jev_term = (1.0 if jev_side == "long" else -1.0) * max(0.0, min(jev_agree, 1.0))
    reasons.append("jev %s (agreement %.2f)" % (jev_side, jev_agree))
else:
    reasons.append("jev absent or uncertain — no vote")

# Tape leg (0.6 weight): momentum in ATR units, capped at 1.
denom = max(2.0 * atr, 0.5) if atr is not None and atr > 0 else 0.5
tape_unit = max(-1.0, min(chg / denom, 1.0))
tape_term = (1.0 if tape_unit >= 0 else -1.0) * abs(tape_unit) * 0.6
if abs(tape_unit) < 1e-9:
    reasons.append("tape flat (%.2f%% over window)" % chg)
else:
    reasons.append("tape %s %.2f%% (~%.2f ATR units)" % (
        "up" if tape_unit > 0 else "down", chg, tape_unit))
if vratio is not None and vratio >= 1.2 and (
        (vslope == "up" and tape_unit > 0) or (vslope == "down" and tape_unit < 0)):
    reasons.append("volume confirms (ratio %.2f, slope %s)" % (vratio, vslope))

# Book leg (0.5 weight): top-5 notional imbalance.
book = state.get("book")
imb = num((book or {}).get("imb")) if isinstance(book, dict) else None
spr = num((book or {}).get("sprBps")) if isinstance(book, dict) else None
book_term = 0.0
if imb is not None:
    book_term = max(-1.0, min(imb, 1.0)) * 0.5
    reasons.append("book imbalance %+.3f" % imb)
else:
    reasons.append("book absent — no vote")

score = jev_term + tape_term + book_term
choice = "long" if score >= DECIDE_THRESHOLD else "short" if score <= -DECIDE_THRESHOLD else "flat"

conf = 0.5 + 0.4 * min(abs(score), 1.0)
if jev is None or jev_uncertain:
    conf *= 0.7
if spr is not None and spr > WIDE_SPREAD_BPS:
    conf *= 0.8
    reasons.append("wide spread (%.1fbps) — confidence haircut" % spr)
conf = max(0.0, min(round(conf, 4), 0.9))

ms = int((time.perf_counter() - t0) * 1000)
print(json.dumps({
    "choice": choice,
    "confidence": conf,
    "score": round(score, 4),
    "reasons": reasons,
    "ms": ms,
}))
