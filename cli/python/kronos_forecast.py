#!/usr/bin/env python3
"""Kronos forecast bridge (stdin JSON -> stdout JSON).

Reads KuCoin 15m klines fetched by the jw3 CLI, runs the pretrained
Kronos-small foundation model (CPU, no finetuning), and prints a single
JSON verdict line: direction + expected move % over the horizon.

Stdin:  {"klines": [[ts_ms, open, high, low, close, volume], ...], "horizon": 12,
         "granularity_min": 15}
Stdout: {"direction": "up|down|flat", "expected_move_pct": f,
         "last_close": f, "pred_last_close": f, "pred_closes": [f...],
         "horizon": n, "lookback": n, "ms": n}

Env: KRONOS_HOME (default ~/kronos), KRONOS_MODEL
(default NeoQuasar/Kronos-small), KRONOS_TOKENIZER
(default NeoQuasar/Kronos-Tokenizer-base).
"""
import json
import os
import sys
import time

t0 = time.perf_counter()

try:
    payload = json.load(sys.stdin)
except Exception as e:
    print(json.dumps({"error": f"bad stdin json: {e}"}), file=sys.stderr)
    sys.exit(2)

klines = payload.get("klines")
horizon = payload.get("horizon", 12)
gran = payload.get("granularity_min", 15)

if not isinstance(klines, list) or len(klines) < 50:
    print(
        json.dumps({"error": f"need >= 50 klines, got {len(klines) if isinstance(klines, list) else 'none'}"}),
        file=sys.stderr,
    )
    sys.exit(2)
try:
    horizon = int(horizon)
except (TypeError, ValueError):
    print(json.dumps({"error": "horizon must be an integer"}), file=sys.stderr)
    sys.exit(2)
if not 1 <= horizon <= 120:
    print(json.dumps({"error": "horizon must be 1..120"}), file=sys.stderr)
    sys.exit(2)

try:
    import pandas as pd
except ImportError:
    print(json.dumps({"error": "pandas missing in kronos venv"}), file=sys.stderr)
    sys.exit(3)

kronos_home = os.environ.get("KRONOS_HOME", os.path.expanduser("~/kronos"))
if kronos_home not in sys.path:
    sys.path.insert(0, kronos_home)

try:
    from model import Kronos, KronosTokenizer, KronosPredictor
except ImportError as e:
    print(json.dumps({"error": f"kronos import failed: {e}"}), file=sys.stderr)
    sys.exit(3)

rows = []
for k in klines:
    try:
        ts, o, h, l, c, v = k[0], float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])
    except (IndexError, TypeError, ValueError):
        continue
    if not (c > 0 and o > 0 and h > 0 and l > 0) or v < 0:
        continue
    rows.append((int(ts), o, h, l, c, v))
if len(rows) < 50:
    print(json.dumps({"error": f"only {len(rows)} valid klines after filtering"}), file=sys.stderr)
    sys.exit(2)

rows.sort(key=lambda r: r[0])
df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
df["timestamps"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
df["amount"] = df["volume"] * df["close"]

lookback = min(len(df), 512)
tail = df.iloc[-lookback:].reset_index(drop=True)
x_df = tail[["open", "high", "low", "close", "volume", "amount"]]
x_timestamp = tail["timestamps"]
last_ts = tail["timestamps"].iloc[-1]
y_timestamp = pd.Series(
    [last_ts + pd.Timedelta(minutes=gran * i) for i in range(1, horizon + 1)]
)

model_name = os.environ.get("KRONOS_MODEL", "NeoQuasar/Kronos-small")
tok_name = os.environ.get("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base")

try:
    tokenizer = KronosTokenizer.from_pretrained(tok_name)
    model = Kronos.from_pretrained(model_name)
except Exception as e:
    print(json.dumps({"error": f"model load failed: {e}"}), file=sys.stderr)
    sys.exit(3)

# Finetuned weights (parameter-efficient head checkpoint from
# kronos/data/finetune_jw3.py). Unset = frozen baseline (prior behaviour).
finetuned_path = os.environ.get("KRONOS_FINETUNED_PATH", "").strip()
finetuned_loaded = False
if finetuned_path:
    try:
        import torch

        state = torch.load(finetuned_path, map_location="cpu")
        model.load_state_dict(state, strict=False)
        model.eval()
        finetuned_loaded = True
    except Exception as e:
        print(json.dumps({"error": f"finetuned load failed: {e}"}), file=sys.stderr)
        sys.exit(3)

predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=512)
try:
    pred_df = predictor.predict(
        df=x_df,
        x_timestamp=x_timestamp,
        y_timestamp=y_timestamp,
        pred_len=horizon,
        T=1.0,
        top_p=0.9,
        sample_count=1,
        verbose=False,
    )
except Exception as e:
    print(json.dumps({"error": f"predict failed: {e}"}), file=sys.stderr)
    sys.exit(3)

try:
    pred_closes = [float(v) for v in pred_df["close"].tolist()]
except (KeyError, TypeError, ValueError) as e:
    print(json.dumps({"error": f"bad prediction frame: {e}"}), file=sys.stderr)
    sys.exit(3)
if len(pred_closes) != horizon or not all(c > 0 for c in pred_closes):
    print(json.dumps({"error": "prediction returned no usable closes"}), file=sys.stderr)
    sys.exit(3)

last_close = float(tail["close"].iloc[-1])
pred_last = pred_closes[-1]
move_pct = (pred_last - last_close) / last_close * 100.0
direction = "up" if move_pct > 0.1 else ("down" if move_pct < -0.1 else "flat")

ms = int((time.perf_counter() - t0) * 1000)
print(
    json.dumps(
        {
            "direction": direction,
            "expected_move_pct": move_pct,
            "last_close": last_close,
            "pred_last_close": pred_last,
            "pred_closes": pred_closes,
            "horizon": horizon,
            "lookback": lookback,
            "ms": ms,
            "finetuned": finetuned_loaded,
        }
    )
)
