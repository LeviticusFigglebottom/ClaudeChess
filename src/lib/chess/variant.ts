import type { Rules } from "chessops";

/**
 * Variant identifiers (addendum A1.4). This is the closed set the DB enum,
 * the rules facade, and the engine layer all share. Atomic/horde/racing
 * kings/antichess are deferred indefinitely (A1.3) and deliberately absent.
 */
export const VARIANTS = ["standard", "chess960", "threecheck", "koth", "crazyhouse"] as const;

export type VariantId = (typeof VARIANTS)[number];

export function isVariantId(value: string): value is VariantId {
  return (VARIANTS as readonly string[]).includes(value);
}

/**
 * Variants vanilla Stockfish can evaluate — it is stronger for these and
 * its NNUE is tuned for exactly them, so they never route to Fairy (A1.3).
 */
export const VANILLA_ENGINE_VARIANTS: readonly VariantId[] = ["standard", "chess960"];

/**
 * Variants served by the vendored Fairy-Stockfish build (Phase 4.5,
 * FF_VARIANTS). Crazyhouse stays out until a drop UI exists (B1.1).
 */
export const FAIRY_ENGINE_VARIANTS: readonly VariantId[] = ["threecheck", "koth"];

/**
 * Everything an engine can evaluate. Anything else must be REFUSED —
 * a meaningless eval silently corrupts every downstream trainer (A1.3).
 */
export const ENGINE_SUPPORTED_VARIANTS: readonly VariantId[] = [
  ...VANILLA_ENGINE_VARIANTS,
  ...FAIRY_ENGINE_VARIANTS,
];

/** Variants playable against humans (rules exist and the board can render them). */
export const PLAYABLE_VARIANTS: readonly VariantId[] = [
  "standard",
  "chess960",
  "threecheck",
  "koth",
];

/** chessops rules key for each variant. chess960 is rules-identical to chess. */
export function rulesForVariant(variant: VariantId): Rules {
  switch (variant) {
    case "standard":
    case "chess960":
      return "chess";
    case "threecheck":
      return "3check";
    case "koth":
      return "kingofthehill";
    case "crazyhouse":
      return "crazyhouse";
  }
}
