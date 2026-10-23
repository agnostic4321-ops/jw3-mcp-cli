import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchRfdetrBoxes,
  parseRfdetrOutput,
  resolveRfdetrPython,
  rfdetrBoxesToSignal,
  RFDETR_DEFAULT_THRESHOLD,
  type RfdetrBridgeRunner,
} from "./rfdetr.js";

const good = {
  detections: [
    { label: "bull_exhaustion", score: 0.82, class_id: 0, box: [573.4, 76.9, 51.8, 147.0] },
    { label: "person", score: 0.91, class_id: 1, box: [10, 10, 20, 20] },
  ],
  width: 640,
  height: 640,
  model: "rf-detr-nano",
  checkpoint: "/home/u/.roboflow/models/rf-detr-nano.pth",
  threshold: 0.5,
  ms: 6822,
};

const okRunner: RfdetrBridgeRunner = () => ({ status: 0, stdout: JSON.stringify(good), stderr: "" });

describe("parseRfdetrOutput (mocked bridge shape)", () => {
  it("accepts a well-formed bridge verdict", () => {
    assert.deepEqual(parseRfdetrOutput(good), {
      detections: good.detections,
      width: 640,
      height: 640,
      model: "rf-detr-nano",
      threshold: 0.5,
      ms: 6822,
    });
  });
  it("accepts an empty detection list", () => {
    const v = parseRfdetrOutput({ ...good, detections: [] });
    assert.equal(v?.detections.length, 0);
  });
  it("rejects label/box/shape violations", () => {
    assert.equal(parseRfdetrOutput({ ...good, detections: [{ ...good.detections[0], label: "" }] }), null);
    assert.equal(parseRfdetrOutput({ ...good, detections: [{ ...good.detections[0], box: [1, 2, 3] }] }), null);
    assert.equal(parseRfdetrOutput({ ...good, detections: [{ ...good.detections[0], box: [1, 2, 0, 4] }] }), null);
    assert.equal(parseRfdetrOutput({ ...good, detections: [{ ...good.detections[0], score: NaN }] }), null);
    assert.equal(parseRfdetrOutput({ ...good, detections: "boxes" }), null);
  });
  it("rejects missing or bad counters", () => {
    const noW: Record<string, unknown> = { ...good };
    delete noW["width"];
    assert.equal(parseRfdetrOutput(noW), null);
    assert.equal(parseRfdetrOutput({ ...good, height: 0 }), null);
    assert.equal(parseRfdetrOutput({ ...good, model: "" }), null);
    assert.equal(parseRfdetrOutput({ ...good, ms: -1 }), null);
  });
  it("rejects non-objects", () => {
    assert.equal(parseRfdetrOutput(null), null);
    assert.equal(parseRfdetrOutput("boxes"), null);
    assert.equal(parseRfdetrOutput(42), null);
  });
});

describe("resolveRfdetrPython", () => {
  it("prefers $RFDETR_PYTHON, falls back to the kronos venv", () => {
    const keep = process.env["RFDETR_PYTHON"];
    process.env["RFDETR_PYTHON"] = "/tmp/venv/bin/python";
    assert.equal(resolveRfdetrPython(), "/tmp/venv/bin/python");
    delete process.env["RFDETR_PYTHON"];
    assert.match(resolveRfdetrPython(), /kronos\/.venv\/bin\/python|python3/);
    if (keep === undefined) delete process.env["RFDETR_PYTHON"];
    else process.env["RFDETR_PYTHON"] = keep;
  });
});

describe("fetchRfdetrBoxes (mocked bridge runner)", () => {
  it("returns the parsed verdict for a chart path", async () => {
    let seen = "";
    const v = await fetchRfdetrBoxes({ imagePath: "/tmp/chart.png" }, (stdin, _py, _script) => {
      seen = stdin;
      return okRunner(stdin, _py, _script);
    });
    assert.equal(v.detections.length, 2);
    assert.deepEqual(JSON.parse(seen), { image_path: "/tmp/chart.png", threshold: RFDETR_DEFAULT_THRESHOLD });
  });
  it("sends base64 charts and custom thresholds", async () => {
    let seen = "";
    await fetchRfdetrBoxes({ imageBase64: "aGVsbG8=", threshold: 0.3 }, (stdin, _py, _script) => {
      seen = stdin;
      return okRunner(stdin, _py, _script);
    });
    assert.deepEqual(JSON.parse(seen), { image_base64: "aGVsbG8=", threshold: 0.3 });
  });
  it("rejects out-of-range thresholds before spawning", async () => {
    await assert.rejects(fetchRfdetrBoxes({ imagePath: "x.png", threshold: 9 }, okRunner), /threshold/);
  });
  it("throws on bridge exit, spawn, and bad shape", async () => {
    const failing: RfdetrBridgeRunner = () => ({ status: 2, stdout: "", stderr: "boom" });
    await assert.rejects(fetchRfdetrBoxes({ imagePath: "x.png" }, failing), /exit 2.*boom/);
    await assert.rejects(
      fetchRfdetrBoxes({ imagePath: "x.png" }, () => {
        throw new Error("noexec");
      }),
      /spawn.*noexec/,
    );
    await assert.rejects(
      fetchRfdetrBoxes({ imagePath: "x.png" }, () => ({ status: 0, stdout: "not json", stderr: "" })),
      /non-JSON/,
    );
    await assert.rejects(
      fetchRfdetrBoxes({ imagePath: "x.png" }, () => ({ status: 0, stdout: "{}", stderr: "" })),
      /unexpected shape/,
    );
  });
});

describe("rfdetrBoxesToSignal (pattern ballot)", () => {
  it("top pattern box votes: bull_exhaustion shorts, bear_exhaustion longs", () => {
    const v = parseRfdetrOutput(good)!;
    const s = rfdetrBoxesToSignal(v);
    assert.equal(s.abstained, false);
    assert.equal(s.side, "short");
    assert.ok(Math.abs(s.confidence - 0.82) < 1e-9);
    const bear = parseRfdetrOutput({
      ...good,
      detections: [{ label: "bear_exhaustion", score: 0.6, class_id: 1, box: [1, 2, 30, 40] }],
    })!;
    assert.equal(rfdetrBoxesToSignal(bear).side, "long");
  });
  it("non-pattern labels abstain — stock COCO weights never vote", () => {
    const v = parseRfdetrOutput({
      ...good,
      detections: [{ label: "couch", score: 0.99, class_id: 57, box: [1, 2, 30, 40] }],
    })!;
    const s = rfdetrBoxesToSignal(v);
    assert.equal(s.abstained, true);
    assert.equal(s.confidence, 0);
  });
  it("empty boxes and null verdicts abstain", () => {
    const empty = parseRfdetrOutput({ ...good, detections: [] });
    assert.equal(rfdetrBoxesToSignal(empty).abstained, true);
    assert.equal(rfdetrBoxesToSignal(null).abstained, true);
  });
});
