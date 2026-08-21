import type { WhitePovEval } from "./pov";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Centipawns → win probability, 0..100, for the same POV as the input
 * (spec §4.1, Lichess-derived logistic). Never classify on raw centipawns:
 * a 200cp swing at +50 is catastrophic; at +900 it is noise.
 */
export function winProb(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1000, 1000))) - 1);
}

/**
 * Win probability for a full eval (handles mate scores): mate for the POV
 * side → 100, mate against → 0.
 */
export function winProbFromEval(evaluation: WhitePovEval): number {
  if (evaluation.mateIn !== null) return evaluation.mateIn > 0 ? 100 : 0;
  if (evaluation.cp !== null) return winProb(evaluation.cp);
  throw new Error("eval carries neither cp nor mate score");
}
