import { clamp } from "./winprob";

/**
 * Accuracy scoring (spec §4.5).
 *
 * Per-move accuracy from win-prob loss, then a volatility-weighted aggregate.
 * The volatility weight stops a 60-move dead-drawn endgame (flat wp series,
 * near-zero losses) from inflating game accuracy to 99%.
 */

/** Per-move accuracy 0..100 from mover-POV win-prob loss. */
export function moveAccuracy(loss: number): number {
  return clamp(103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669, 0, 100);
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export const VOLATILITY_WEIGHT_FLOOR = 0.5;

/**
 * Position-volatility weight per ply: stdev of the White-POV win-prob series
 * over a ±2-ply window (clipped at the game edges), floored at 0.5.
 */
export function volatilityWeights(wpWhiteSeries: number[]): number[] {
  return wpWhiteSeries.map((_, i) => {
    const window = wpWhiteSeries.slice(Math.max(0, i - 2), Math.min(wpWhiteSeries.length, i + 3));
    return Math.max(stdev(window), VOLATILITY_WEIGHT_FLOOR);
  });
}

/**
 * Weighted mean of per-move accuracies. `weights` must be parallel to
 * `accuracies` (one entry per ply of the side being scored).
 */
export function gameAccuracy(accuracies: number[], weights: number[]): number {
  if (accuracies.length === 0) return 0;
  if (accuracies.length !== weights.length) {
    throw new Error("accuracies and weights must be parallel arrays");
  }
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < accuracies.length; i++) {
    const w = weights[i] as number;
    weightedSum += (accuracies[i] as number) * w;
    weightTotal += w;
  }
  return weightedSum / weightTotal;
}
