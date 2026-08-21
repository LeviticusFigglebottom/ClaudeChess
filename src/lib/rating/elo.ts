/**
 * Elo estimation from match scores — the calibration gate's measurement math
 * (spec §6 "Calibrate empirically", Phase 1 gate).
 */

/** Expected score for a player `diff` Elo above their opponent. */
export function expectedScore(diff: number): number {
  return 1 / (1 + Math.pow(10, -diff / 400));
}

/** Elo difference implied by an average score s ∈ (0, 1). */
export function eloDiffFromScore(s: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, s));
  return -400 * Math.log10(1 / clamped - 1);
}

export interface EloEstimate {
  /** Estimated rating of the measured player. */
  elo: number;
  /** Half-width of the 95% confidence interval (delta method on the score). */
  ci95: number;
  score: number;
  games: number;
}

/**
 * Estimate a player's Elo from a match against ONE opponent of known rating.
 * `points` = wins + draws/2.
 */
export function eloFromMatch(opponentElo: number, points: number, games: number): EloEstimate {
  const s = points / games;
  const diff = eloDiffFromScore(s);
  // Delta method: se(elo) = se(s) · dElo/ds, dElo/ds = 400 / (ln10 · s(1−s)).
  const sSafe = Math.min(0.999, Math.max(0.001, s));
  const seScore = Math.sqrt((sSafe * (1 - sSafe)) / games);
  const derivative = 400 / (Math.LN10 * sSafe * (1 - sSafe));
  return {
    elo: opponentElo + diff,
    ci95: 1.96 * seScore * derivative,
    score: s,
    games,
  };
}

/**
 * Combine estimates of the SAME player's Elo from matches against several
 * opponents (inverse-variance weighting). Opponent-anchor uncertainty, when
 * an opponent is itself a measured bot, is passed via `anchorCi95` and added
 * in quadrature per estimate before combining.
 */
export function combineEstimates(
  estimates: { elo: number; ci95: number; anchorCi95?: number }[]
): { elo: number; ci95: number } {
  const weighted = estimates.map((estimate) => {
    const ci = Math.sqrt(estimate.ci95 ** 2 + (estimate.anchorCi95 ?? 0) ** 2);
    return { elo: estimate.elo, variance: (ci / 1.96) ** 2 };
  });
  const invVarSum = weighted.reduce((a, b) => a + 1 / b.variance, 0);
  const elo = weighted.reduce((a, b) => a + b.elo / b.variance, 0) / invVarSum;
  return { elo, ci95: 1.96 * Math.sqrt(1 / invVarSum) };
}
