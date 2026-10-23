#!/usr/bin/env python3
"""RF-DETR pattern bridge (stdin JSON -> stdout JSON).

Chart-vision pattern reader for the jw3 oracle: a 640x640 candlestick PNG
in, pattern boxes out. Runs the RF-DETR Nano checkpoint on CPU — read-only
inference, no finetuning, no network, no trades.

Stdin:  {"image_path": "/abs/path.png"} | {"image_base64": "<png bytes b64>"},
        optional "threshold" (default 0.5, 0..1)
Stdout: {"detections": [{"label": str, "score": f, "class_id": n,
         "box": [x, y, w, h]}], "width": n, "height": n,
         "model": "rf-detr-nano", "checkpoint": str, "threshold": f, "ms": n}
        box is pixels, top-left origin (COCO xywh), clamped to the frame.

Pattern labels (kronos/data/render_pattern_charts.py):
  bull_exhaustion -> preceded a short entry; bear_exhaustion -> long entry.
Any other label (e.g. COCO classes from the stock Nano weights) is passed
through verbatim — the TS caller only votes on the two pattern labels, so
a non-finetuned checkpoint abstains instead of fabricating a direction.

Env: RFDETR_CHECKPOINT (default ~/.roboflow/models/rf-detr-nano.pth),
     RFDETR_PYTHON is honoured by the TS caller, not here.
Exit: 2 = bad stdin/input image; 3 = missing deps or checkpoint load failure.
"""
import base64
import binascii
import contextlib
import io
import json
import os
import sys
import time

t0 = time.perf_counter()


@contextlib.contextmanager
def stdout_to_stderr():
    """fd-level redirect: rfdetr INFO logs go to stdout and would corrupt
    the single-JSON-line contract the TS caller parses."""
    try:
        fd_out = sys.stdout.fileno()
    except (OSError, AttributeError):
        yield
        return
    saved = os.dup(fd_out)
    try:
        os.dup2(sys.stderr.fileno(), fd_out)
        yield
    finally:
        os.dup2(saved, fd_out)
        os.close(saved)

DEFAULT_CHECKPOINT = os.path.expanduser("~/.roboflow/models/rf-detr-nano.pth")
DEFAULT_THRESHOLD = 0.5
MAX_IMAGE_BYTES = 32 * 1024 * 1024


def fail(code, msg):
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(code)


try:
    payload = json.load(sys.stdin)
except Exception as e:
    fail(2, "bad stdin json: %s" % e)

if not isinstance(payload, dict):
    fail(2, "stdin must be an object")

image_path = payload.get("image_path")
image_b64 = payload.get("image_base64")
threshold = payload.get("threshold", DEFAULT_THRESHOLD)

try:
    threshold = float(threshold)
except (TypeError, ValueError):
    fail(2, "threshold must be a number in 0..1")
if not 0.0 <= threshold <= 1.0:
    fail(2, "threshold must be a number in 0..1")

if image_path is not None and image_b64 is not None:
    fail(2, "pass exactly one of image_path / image_base64")

raw = None
if isinstance(image_path, str) and image_path:
    try:
        size = os.path.getsize(image_path)
    except OSError as e:
        fail(2, "cannot read image_path: %s" % e)
    if size <= 0 or size > MAX_IMAGE_BYTES:
        fail(2, "image_path size out of range")
    try:
        with open(image_path, "rb") as f:
            raw = f.read()
    except OSError as e:
        fail(2, "cannot read image_path: %s" % e)
elif isinstance(image_b64, str) and image_b64:
    if len(image_b64) > (MAX_IMAGE_BYTES * 4) // 3 + 64:
        fail(2, "image_base64 too large")
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        fail(2, "image_base64 is not valid base64: %s" % e)
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        fail(2, "image_base64 size out of range")
else:
    fail(2, "pass exactly one of image_path / image_base64")

try:
    from PIL import Image
except ImportError:
    fail(3, "pillow missing in rfdetr python")

try:
    img = Image.open(io.BytesIO(raw))
    img.load()
except Exception as e:
    fail(2, "unreadable image bytes: %s" % e)
if img.width <= 0 or img.height <= 0 or max(img.width, img.height) > 8192:
    fail(2, "image dimensions out of range")
if img.mode != "RGB":
    img = img.convert("RGB")
width, height = img.width, img.height

checkpoint = os.environ.get("RFDETR_CHECKPOINT", DEFAULT_CHECKPOINT)
if not os.path.isfile(checkpoint):
    fail(3, "checkpoint not found: %s (set RFDETR_CHECKPOINT)" % checkpoint)

try:
    import torch  # noqa: F401 -- pinned CPU path below
    from rfdetr import RFDETRNano
except ImportError as e:
    fail(3, "rfdetr/torch missing in rfdetr python: %s" % e)

try:
    with stdout_to_stderr():
        model = RFDETRNano.from_checkpoint(checkpoint, trust_checkpoint=True)
except Exception as e:
    fail(3, "checkpoint load failed: %s" % e)

try:
    import numpy as np

    with stdout_to_stderr():
        detections = model.predict(np.asarray(img).copy(), threshold=threshold)
except Exception as e:
    fail(3, "predict failed: %s" % e)

names = list(getattr(model, "class_names", []) or [])

out = []
try:
    boxes = detections.xyxy
    scores = detections.confidence
    classes = detections.class_id
except AttributeError as e:
    fail(3, "unexpected detection shape: %s" % e)

for i in range(len(boxes)):
    try:
        x0, y0, x1, y1 = (float(v) for v in boxes[i])
        score = float(scores[i])
        cid = int(classes[i])
    except (TypeError, ValueError, IndexError):
        continue
    x0 = min(max(x0, 0.0), float(width))
    y0 = min(max(y0, 0.0), float(height))
    x1 = min(max(x1, 0.0), float(width))
    y1 = min(max(y1, 0.0), float(height))
    if x1 <= x0 or y1 <= y0:
        continue
    label = names[cid] if 0 <= cid < len(names) else "class_%d" % cid
    out.append(
        {
            "label": label,
            "score": round(score, 4),
            "class_id": cid,
            "box": [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)],
        }
    )
out.sort(key=lambda d: d["score"], reverse=True)

ms = int((time.perf_counter() - t0) * 1000)
print(
    json.dumps(
        {
            "detections": out,
            "width": width,
            "height": height,
            "model": "rf-detr-nano",
            "checkpoint": checkpoint,
            "threshold": threshold,
            "ms": ms,
        }
    )
)
