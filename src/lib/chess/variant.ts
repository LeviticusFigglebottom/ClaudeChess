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
 * Variants vanilla Stockfish can evaluate. Everything else needs
 * Fairy-Stockfish (Phase 4.5) — a vanilla eval of e.g. a KotH position is
 * meaningless and silently corrupts every downstream trainer (A1.3).
 */
export const ENGINE_SUPPORTED_VARIANTS: readonly VariantId[] = ["standard", "chess960"];

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
