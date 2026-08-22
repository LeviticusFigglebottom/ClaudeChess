import type { VariantId } from "@/lib/chess/variant";

/**
 * Move classification (spec §4.2–4.4).
 *
 * All win probabilities in this module are MOVER-POV, 0..100:
 *   wpBefore = winProb for the player about to move, in the pre-move position
 *   wpAfter  = winProb for that same player after their move was made
 *   loss     = wpBefore - wpAfter
 *
 * Evaluation order matters (spec §4.2): BOOK → BRILLIANT → GREAT → MISS →
 * BEST → loss bands. GREAT and BRILLIANT are flavors of strong moves and must
 * win over plain BEST; MISS must win over the loss bands (a miss is often only
 * a "GOOD"-sized wp loss but a huge missed opportunity).
 */

export const CLASSIFICATIONS = [
  "BOOK",
  "BRILLIANT",
  "GREAT",
  "BEST",
  "EXCELLENT",
  "GOOD",
  "INACCURACY",
  "MISTAKE",
  "BLUNDER",
  "MISS",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * Loss bands on the 0–100 win-probability scale. CORRECTED at the Phase 2
 * agreement gate: the original spec numbers (10/20/30) transcribed
 * Lichess's published thresholds (0.1/0.2/0.3) onto the 0–100 scale
 * without halving — but those are deltas on Lichess's [−1,1]
 * winning-chances scale, i.e. 5/10/15 win-probability points. §4.2 states
 * the thresholds "derive from Lichess's", and the gate (blunder counts
 * within ±20% of Lichess's own judgments on the same games) is the
 * falsifiable that caught the doubling: at 10/20/30 GAMBIT reported ~4–5×
 * fewer blunders than Lichess on identical positions with near-identical
 * evals. Evidence in docs/gate-history and the Phase 2 gate report.
 */
export const LOSS_THRESHOLDS = {
  excellent: 2, // loss < 2 → EXCELLENT
  good: 5, // loss < 5 → GOOD
  inaccuracy: 10, // 5 ≤ loss < 10 → INACCURACY  (Lichess ?! ≥ 0.1)
  mistake: 15, // 10 ≤ loss < 15 → MISTAKE      (Lichess ?  ≥ 0.2); ≥ 15 → BLUNDER (?? ≥ 0.3)
} as const;

export const BRILLIANT_RULES = {
  /** Static material delta after opponent's best reply must be ≤ this (mover POV cp). */
  sacrificeMaxDeltaCp: -200,
  /** Move must still be sound: loss < this. */
  maxLoss: 5,
  /** Position must not already be trivially winning. */
  maxWpBefore: 85,
  /** Position must not be lost anyway. */
  minWpAfter: 40,
} as const;

export const GREAT_RULES = {
  /** winProb(pv1) - winProb(pv2) must be ≥ this, and the player found pv1. */
  minPv1Pv2Gap: 15,
} as const;

export const MISS_RULES = {
  /** Best move must have led to mate or at least this much advantage (mover POV cp). */
  minBestGainCp: 400,
} as const;

export interface ClassifyInput {
  /**
   * Rules variant of the game this ply belongs to (addendum A1.4). BOOK can
   * only ever fire for standard — chess960 has no book by construction, and
   * variant blunders are a separate population from standard blunders.
   */
  variant: VariantId;
  /** Mover-POV win probability before the move (0..100). */
  wpBefore: number;
  /** Mover-POV win probability after the move (0..100). */
  wpAfter: number;
  playedUci: string;
  /** MultiPV-1 move of the pre-move position. */
  bestUci: string;
  legalMoveCount: number;

  /** Explorer lookup: position has ≥ 1000 games at the user's rating band (Phase 3 feeds this). */
  isBook?: boolean;

  /** BRILLIANT inputs (§4.3); omit when not evaluating brilliance. */
  sacrifice?: {
    /** Static material delta (cp, mover POV) after the opponent's best reply. */
    materialDeltaAfterBestReplyCp: number;
    isRecapture: boolean;
  };

  /** GREAT inputs (§4.4): mover-POV win probs of the top two engine lines. */
  multipv?: {
    wpPv1: number;
    /** null when the engine had no second line (e.g. one legal move). */
    wpPv2: number | null;
  };

  /**
   * MISS inputs (§4.2): mover-POV evals of the best line and of the position
   * actually reached by the played move.
   * "Best move led to mate or ≥ +400cp gain, played move captured < half of
   * it" is operationalized as: opportunity = bestMateIn > 0 or bestEvalCp ≥
   * 400; captured-less-than-half = the played move neither still forces mate
   * nor keeps ≥ half of the best eval (mate opportunities count as captured
   * only if the played move still mates or stays ≥ +400).
   */
  miss?: {
    bestEvalCp: number | null;
    bestMateIn: number | null;
    playedEvalCp: number | null;
    playedMateIn: number | null;
  };
}

export function classifyMove(input: ClassifyInput): Classification {
  const loss = input.wpBefore - input.wpAfter;
  const playedBest = input.playedUci === input.bestUci;

  if (input.isBook && input.variant === "standard") return "BOOK";

  if (isBrilliant(input, loss)) return "BRILLIANT";

  if (isGreat(input, playedBest)) return "GREAT";

  if (!playedBest && isMiss(input)) return "MISS";

  if (playedBest) return "BEST";

  if (loss < LOSS_THRESHOLDS.excellent) return "EXCELLENT";
  if (loss < LOSS_THRESHOLDS.good) return "GOOD";
  if (loss < LOSS_THRESHOLDS.inaccuracy) return "INACCURACY";
  if (loss < LOSS_THRESHOLDS.mistake) return "MISTAKE";
  return "BLUNDER";
}

/** §4.3 — all five conditions must hold. */
function isBrilliant(input: ClassifyInput, loss: number): boolean {
  const s = input.sacrifice;
  if (!s) return false;
  return (
    s.materialDeltaAfterBestReplyCp <= BRILLIANT_RULES.sacrificeMaxDeltaCp &&
    loss < BRILLIANT_RULES.maxLoss &&
    input.wpBefore < BRILLIANT_RULES.maxWpBefore &&
    input.wpAfter > BRILLIANT_RULES.minWpAfter &&
    !s.isRecapture &&
    input.legalMoveCount > 1
  );
}

/** §4.4 — only-move: pv1 clearly better than pv2 and the player found it. */
function isGreat(input: ClassifyInput, playedBest: boolean): boolean {
  const m = input.multipv;
  if (!m || m.wpPv2 === null) return false;
  if (input.legalMoveCount <= 1) return false;
  return playedBest && m.wpPv1 - m.wpPv2 >= GREAT_RULES.minPv1Pv2Gap;
}

function isMiss(input: ClassifyInput): boolean {
  const m = input.miss;
  if (!m) return false;

  const bestMates = m.bestMateIn !== null && m.bestMateIn > 0;
  const bigGain = m.bestEvalCp !== null && m.bestEvalCp >= MISS_RULES.minBestGainCp;
  if (!bestMates && !bigGain) return false;

  const playedMates = m.playedMateIn !== null && m.playedMateIn > 0;
  if (playedMates) return false;

  if (bestMates) {
    // A mate opportunity counts as captured if the played move stays completely winning.
    return m.playedEvalCp === null || m.playedEvalCp < MISS_RULES.minBestGainCp;
  }
  const bestCp = m.bestEvalCp as number;
  return m.playedEvalCp === null || m.playedEvalCp < bestCp / 2;
}
