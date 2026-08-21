/** Analysis presets (spec §4.6). */
export const ANALYSIS_SETTINGS = {
  /** Batch review pass over every ply of a game. */
  review: { depth: 18, multipv: 3 },
  /** User-triggered deep dive on a single position. */
  deep: { depth: 24, multipv: 5 },
  /** Shallow pass for the bot blunder-plausibility trick (spec §6 Tier A). */
  shallow: { depth: 6, multipv: 5 },
} as const;
