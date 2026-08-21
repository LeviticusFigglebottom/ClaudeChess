import type { Classification } from "./classify";

/**
 * Classification icons (B2.4): Informant notation — the annotation
 * vocabulary chess players have read in books for sixty years, shape-distinct
 * by construction, which is what makes the shape-only accessibility mode
 * lossless. EXCELLENT and GOOD are deliberately unmarked (as in print).
 * BLUNDER is one of --flag's two sanctioned uses; nothing else here may wear
 * that token.
 */
export const CLASSIFICATION_GLYPHS: Record<
  Classification,
  { glyph: string | null; colorClass: string; label: string }
> = {
  BRILLIANT: { glyph: "!!", colorClass: "text-brilliant", label: "Brilliant" },
  GREAT: { glyph: "!", colorClass: "text-lcd", label: "Great move" },
  BEST: { glyph: "⩲", colorClass: "text-lcd", label: "Best move" },
  EXCELLENT: { glyph: null, colorClass: "", label: "Excellent" },
  GOOD: { glyph: null, colorClass: "", label: "Good" },
  BOOK: { glyph: "⌸", colorClass: "text-text-faint", label: "Book move" },
  INACCURACY: { glyph: "?!", colorClass: "text-warn-1", label: "Inaccuracy" },
  MISTAKE: { glyph: "?", colorClass: "text-warn-2", label: "Mistake" },
  BLUNDER: { glyph: "??", colorClass: "text-flag", label: "Blunder" },
  MISS: { glyph: "⊘", colorClass: "text-warn-2", label: "Missed win" },
};
