/**
 * THE TAPE'S OWN SIGNAL — the one place it is defined.
 *
 * ── WHY A SHARED MODULE ──
 *
 * The collector records what the tape says, and the analyzer measures
 * it. If the two computed it separately, they could drift, and the
 * study would then measure a state the live path never acts on — the
 * exact trap this whole machine exists to avoid.
 *
 * So both import THIS. The thresholds are copied from the CLI's
 * src/kucoin.ts (`fadeSignal` / `dipSignal`):
 *
 *   fadeSignal:  offHighPct > 15            -> "late"
 *                vratio < 0.85 && offHighPct < 8 -> "fade-short"
 *                vratio > 3                 -> "strong"
 *   dipSignal:   offLowPct > 15             -> "extended"
 *                vratio > 3                 -> "capitulation"
 *                vratio < 0.85 && offLowPct < 8 -> "dip-long"
 *
 * If the CLI's thresholds change, THIS must change with them.
 *
 * ── WHAT "THE TAPE'S SIDE" MEANS ──
 *
 * "fade-short" means the tape points SHORT (a rally that ran out of
 * volume and failed, near the high) — and the trade is to go short.
 * "dip-long" means the tape points LONG (a sell-off that bounced, near
 * the low) — and the trade is to go long.
 *
 * So the tape's side IS the trade direction. The live path compares it
 * against the models' side and refuses when they contradict.
 */

/** Exhaustion-short read: faded volume while still near the high. */
export function fadeSignal(r) {
  if (r.offHighPct > 15) return "late";
  if (r.vratio < 0.85 && r.offHighPct < 8) return "fade-short";
  if (r.vratio > 3) return "strong";
  return "neutral";
}

/** Dip-long mirror: sell volume faded while still near the low. */
export function dipSignal(r) {
  if (r.offLowPct > 15) return "extended";
  if (r.vratio > 3) return "capitulation";
  if (r.vratio < 0.85 && r.offLowPct < 8) return "dip-long";
  return "neutral";
}

/** The normalised tape row, from whatever shape the caller has. */
export function tapeRow(tape) {
  return {
    offHighPct: Number(tape?.offHighPct ?? 0),
    offLowPct: Number(tape?.offLowPct ?? 0),
    vratio: Number(tape?.vratio ?? 1),
  };
}

/**
 * The tape's side: "short" for a fade-short, "long" for a dip-long,
 * null when there is no exhaustion setup. This is what the live path
 * compares against the models' side.
 */
export function tapeSideOf(tape) {
  if (!tape) return null;
  const row = tapeRow(tape);
  if (fadeSignal(row) === "fade-short") return "short";
  if (dipSignal(row) === "dip-long") return "long";
  return null;
}

/**
 * The tape's side from a collected row, which may or may not carry the
 * pre-computed `tapeSide`. Rows collected before the field existed are
 * derived from the tape fields — the same thresholds, so the answer is
 * identical to what the collector would have written.
 */
export function tapeSideFromRow(row) {
  if (row?.tapeSide) return row.tapeSide;
  return tapeSideOf({
    offHighPct: row?.tapeOffHighPct,
    offLowPct: row?.tapeOffLowPct,
    vratio: row?.tapeVratio,
  });
}
