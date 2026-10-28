/**
 * Shared CLI flag helpers — the single copy used by index.ts dispatch.
 * Pure + unit-tested: parsing never touches the network.
 */

/** Value of `--flag value` or `--flag=value`; undefined when absent. */
export function flagOf(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i >= 0 && rest[i + 1] !== undefined && !rest[i + 1]?.startsWith("--")) return rest[i + 1];
  const pref = rest.find((x) => x.startsWith(`${flag}=`));
  return pref ? pref.slice(flag.length + 1) : undefined;
}

/**
 * First defined value across spelling aliases (`--lev`/`--leverage`, …).
 * Primary spelling goes first (it also names error labels downstream).
 */
export function flagAny(rest: string[], ...flags: string[]): string | undefined {
  for (const f of flags) {
    const v = flagOf(rest, f);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** numOf across aliases; absent still yields the default. */
export function numAny(rest: string[], dflt: number, ...flags: string[]): number {
  const raw = flagAny(rest, ...flags);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** posOf across aliases. */
export function posAny(rest: string[], dflt: number, ...flags: string[]): number {
  const v = numAny(rest, dflt, ...flags);
  return v > 0 ? v : NaN;
}

/**
 * Number flag with a default. NaN when the flag is present but not a
 * number — callers reject it via needNum instead of silently running
 * on a default the user never asked for.
 */
export function numOf(rest: string[], flag: string, dflt: number): number {
  const raw = flagOf(rest, flag);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * numOf that also rejects non-positive input (sizes, levels, days…).
 * Absent flags still yield the default (all call-site defaults are > 0).
 */
export function posOf(rest: string[], flag: string, dflt: number): number {
  const v = numOf(rest, flag, dflt);
  return v > 0 ? v : NaN;
}

/** Round + clamp into [min, max]; NaN passes through for needNum to reject. */
export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return NaN;
  return Math.min(Math.max(Math.round(v), min), max);
}

/**
 * Loud reject for garbage numbers (exit 2, nothing called).
 * Returns true when the value is usable.
 */
export function needNum(v: number, flag: string, rest: string[]): boolean {
  if (Number.isFinite(v)) return true;
  const raw = flagOf(rest, flag);
  console.error(
    `Bad ${flag}: ${raw === undefined ? "not a usable number" : `${JSON.stringify(raw)} is not a usable number`} — nothing was called.`,
  );
  process.exitCode = 2;
  return false;
}

/**
 * needNum across spelling aliases: the label names the spelling the
 * user actually typed (falls back to the primary when neither parses).
 */
export function needNumAny(v: number, rest: string[], ...flags: string[]): boolean {
  if (Number.isFinite(v)) return true;
  const used = flags.find((f) => flagOf(rest, f) !== undefined) ?? flags[0] ?? "--flag";
  return needNum(v, used, rest);
}

/**
 * Refuse `--paper` on live-only routes (exit 2, nothing called).
 * Paper fills live in `jw3 paper ...` (simulated accounts), `jw3 degen
 * --paper` (strategy loop), and `jw3 farm` (paper-only by construction) —
 * a `--paper` flag on a live command must never silently mean live.
 * Returns true when refused (caller must return immediately).
 */
export function refusePaperFlag(rest: string[], route: string): boolean {
  if (!rest.includes("--paper")) return false;
  console.error(
    `${route} is live-only: --paper is refused — paper fills live in \`jw3 paper ...\`, \`jw3 degen --paper\`, \`jw3 farm\`. Nothing was called.`,
  );
  process.exitCode = 2;
  return true;
}
