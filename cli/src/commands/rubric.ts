/**
 * Verdict-stack tuning (OQ-09): THE single tuning surface. Pure data —
 * no I/O, no clock, no randomness, no network.
 *
 * Every weight and every threshold the live verdict path reads — the
 * oracle ballot degen trades on, the rolling auto-tune, the learning
 * loop's seat gate and its pair/dissent reads — is defined here and
 * nowhere else. `weighting.ts` (the one weighting module), `track-store.ts`
 * (the one track store) and `learning.ts` import these values; they never
 * restate one. The retired committee / scorer / harness chain used to read
 * its own sections here; those are gone with it.
 */
export const VERDICT_TUNING = {
  /** The confidence-weighted ballot (degen's oracle, tuned by `learning record`). */
  ballot: {
    /** Ballot-open weight per vote.json track: JEV leads, Kronos halves, RF-DETR silent until wired. */
    defaultWeights: { jev: 1.0, kronos: 0.5, rfdetr: 0 },
    /** |weighted score| at or above this decides long/short; below is flat (no consensus). */
    consensusThreshold: 0.15,
    /** Kronos conviction: an expected move of this many % (or more) is full conviction. */
    kronosFullMovePct: 1,
    /** Kronos conviction floor while the model makes a directional call. */
    kronosMinConviction: 0.1,
  },
  /** The rolling hit-rate auto-tune every vote.json track runs. */
  autoTune: {
    /** Rolling window of scored outcomes per track. */
    window: 20,
    /** Samples needed before the auto-tune touches a weight. */
    minSamples: 5,
    /** Rolling hit-rate at or above which the weight steps up. */
    promoteAt: 0.6,
    /** Rolling hit-rate at or below which the weight steps down. */
    demoteAt: 0.4,
    step: 0.1,
    cap: 2.0,
    floor: 0,
  },
  /** Earn-the-seat gate: a model votes on real money only past both bars. */
  seatGate: {
    minSamples: 30,
    hitFloor: 0.55,
    /** Weight a model that earned the seat starts from (one auto-tune step). */
    seatWeight: 0.1,
  },
  /** The learning report's pair-split and dissent reads. */
  learning: {
    /** A pair must split this many times before "systematically right" is claimed. */
    minSplitSamples: 5,
    /** A dissenter needs this many dissents before its dissent rate means anything. */
    minDissentSamples: 5,
    /** A dissenter is "systematically wrong" above this share of wrong dissents. */
    dissentWrongRate: 0.6,
  },
};
