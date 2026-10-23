/**
 * RF-DETR chart-vision pattern reader (READ-ONLY, no trades).
 *
 * A candlestick PNG in, pattern boxes out. Inference lives in the local
 * python bridge (python/rfdetr_pattern.py, RF-DETR Nano on CPU) so the
 * shape is mockable — same stdio convention as the Kronos and Laya
 * bridges (stdin JSON → single-line stdout JSON, exit 2 bad input,
 * exit 3 missing deps).
 *
 * Pattern labels (kronos/data/render_pattern_charts.py):
 *   bull_exhaustion → the topping pattern that preceded a short entry
 *   bear_exhaustion → the bottoming pattern that preceded a long entry
 * Any other label (e.g. COCO classes from the stock Nano weights) is not
 * a pattern vote — the signal abstains so an unfine-tuned checkpoint can
 * never fabricate a direction. The vote.json auto-tune promotes the
 * RF-DETR weight off 0 on scored merit once a finetuned checkpoint lands.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Pattern label → oracle side. Matches the render category mapping. */
export const PATTERN_SIDE: Record<string, "long" | "short"> = {
  bull_exhaustion: "short",
  bear_exhaustion: "long",
};

export const RFDETR_DEFAULT_THRESHOLD = 0.5;

export type RfdetrBox = [number, number, number, number];

export type RfdetrDetection = {
  label: string;
  score: number;
  class_id: number;
  /** Pixels, top-left origin (COCO xywh), clamped to the frame. */
  box: RfdetrBox;
};

export type RfdetrVerdict = {
  detections: RfdetrDetection[];
  width: number;
  height: number;
  model: string;
  threshold: number;
  ms: number;
};

export type RfdetrChart =
  | { imagePath: string; imageBase64?: never; threshold?: number }
  | { imageBase64: string; imagePath?: never; threshold?: number };

const isFin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: validate the bridge's stdout shape. Anything else → null (never trust). */
export function parseRfdetrOutput(raw: unknown): RfdetrVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o["detections"])) return null;
  const detections: RfdetrDetection[] = [];
  for (const d of o["detections"] as unknown[]) {
    if (typeof d !== "object" || d === null) return null;
    const r = d as Record<string, unknown>;
    if (typeof r["label"] !== "string" || !r["label"]) return null;
    if (!isFin(r["score"])) return null;
    if (!Number.isInteger(r["class_id"])) return null;
    if (
      !Array.isArray(r["box"]) ||
      (r["box"] as unknown[]).length !== 4 ||
      !(r["box"] as unknown[]).every((v) => isFin(v))
    ) {
      return null;
    }
    const [x, y, w, h] = r["box"] as [number, number, number, number];
    if (w <= 0 || h <= 0) return null;
    detections.push({ label: r["label"] as string, score: r["score"] as number, class_id: r["class_id"] as number, box: [x, y, w, h] });
  }
  if (!Number.isInteger(o["width"]) || (o["width"] as number) <= 0) return null;
  if (!Number.isInteger(o["height"]) || (o["height"] as number) <= 0) return null;
  if (typeof o["model"] !== "string" || !o["model"]) return null;
  if (!isFin(o["threshold"])) return null;
  if (!isFin(o["ms"]) || (o["ms"] as number) < 0) return null;
  return {
    detections,
    width: o["width"] as number,
    height: o["height"] as number,
    model: o["model"] as string,
    threshold: o["threshold"] as number,
    ms: o["ms"] as number,
  };
}

/** python with torch + rfdetr: $RFDETR_PYTHON, else ~/kronos/.venv. */
export function resolveRfdetrPython(): string {
  const env = (process.env["RFDETR_PYTHON"] ?? "").trim();
  if (env) return env;
  const home = (process.env["HOME"] ?? "").trim();
  if (home) return `${home}/kronos/.venv/bin/python`;
  return "python3";
}

function rfdetrBridgePath(): string {
  return fileURLToPath(new URL("../../python/rfdetr_pattern.py", import.meta.url));
}

export type RfdetrBridgeRunner = (stdin: string, python: string, script: string) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const defaultRunner: RfdetrBridgeRunner = (stdin, python, script) => {
  const out = spawnSync(python, [script], {
    input: stdin,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return { status: out.status, stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? "") };
};

/**
 * Run the RF-DETR bridge over one chart PNG. Throws on spawn/exit/shape
 * failure — callers abstain on error (a failed model sits out, never
 * blocks the verdict). The runner is injectable so tests pin the contract
 * with a mocked bridge (no python needed).
 */
export async function fetchRfdetrBoxes(
  chart: RfdetrChart,
  runner: RfdetrBridgeRunner = defaultRunner,
): Promise<RfdetrVerdict> {
  const threshold = chart.threshold ?? RFDETR_DEFAULT_THRESHOLD;
  if (!(threshold >= 0 && threshold <= 1)) throw new Error(`rfdetr threshold ${threshold} outside 0..1`);
  const stdin = JSON.stringify(
    "imagePath" in chart && chart.imagePath
      ? { image_path: chart.imagePath, threshold }
      : "imageBase64" in chart && chart.imageBase64
        ? { image_base64: chart.imageBase64, threshold }
        : null,
  );
  if (stdin === "null") throw new Error("rfdetr needs imagePath or imageBase64");
  const python = resolveRfdetrPython();
  let res: ReturnType<RfdetrBridgeRunner>;
  try {
    res = runner(stdin, python, rfdetrBridgePath());
  } catch (e) {
    throw new Error(`rfdetr bridge spawn: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status !== 0) {
    const err = res.stderr.trim().split("\n").slice(-3).join("\n");
    throw new Error(`rfdetr bridge exit ${res.status}${err ? `: ${err}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("rfdetr bridge returned non-JSON stdout.");
  }
  const verdict = parseRfdetrOutput(parsed);
  if (!verdict) throw new Error("rfdetr bridge returned an unexpected shape.");
  return verdict;
}

export type RfdetrBallot = {
  side: "long" | "short" | "flat";
  /** 0..1 directional conviction. 0 when abstained. */
  confidence: number;
  abstained: boolean;
  detail: string;
};

/**
 * Pure: pattern boxes → ballot. The top-scoring pattern box votes with
 * its score as confidence; no pattern box (or only non-pattern labels
 * from stock COCO weights) abstains — never a fabricated direction.
 */
export function rfdetrBoxesToSignal(v: RfdetrVerdict | null): RfdetrBallot {
  const abstain = (detail: string): RfdetrBallot => ({ side: "flat", confidence: 0, abstained: true, detail });
  if (!v) return abstain("no rfdetr verdict");
  const patterns = v.detections
    .filter((d) => PATTERN_SIDE[d.label])
    .sort((a, b) => b.score - a.score);
  if (patterns.length === 0) {
    return abstain(
      v.detections.length === 0 ? "no boxes above threshold — no pattern" : "no pattern label among boxes — no vote",
    );
  }
  const top = patterns[0] as RfdetrDetection;
  const side = PATTERN_SIDE[top.label] as "long" | "short";
  const conf = Math.min(Math.max(top.score, 0), 1);
  return {
    side,
    confidence: conf,
    abstained: false,
    detail: `${top.label} ${side} conf ${conf.toFixed(2)} box [${top.box.map((n) => Math.round(n)).join(",")}]`,
  };
}
