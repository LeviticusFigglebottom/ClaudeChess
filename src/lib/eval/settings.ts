/** Analysis presets (spec §4.6). */
export const ANALYSIS_SETTINGS = {
  /** Batch review pass over every ply of a game. */
  review: { depth: 18, multipv: 3 },
  /**
   * Progressive pass 1 (client-side batch): a fast sweep that gives
   * PROVISIONAL classifications immediately, refined in place by the
   * review-depth pass 2. A ply whose analyzedAtDepth is below
   * `review.depth` is provisional: visibly marked in review and excluded
   * from every §9 statistic — a depth-12 number never silently stands in
   * for an 18.
   */
  provisional: { depth: 12, multipv: 3 },
  /** User-triggered deep dive on a single position. */
  deep: { depth: 24, multipv: 5 },
  /** Shallow pass for the bot blunder-plausibility trick (spec §6 Tier A). */
  shallow: { depth: 6, multipv: 5 },
} as const;
