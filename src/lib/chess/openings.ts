import openingsData from "@/db/seed/openings.json";
import type { VariantId } from "./variant";

/**
 * ECO/opening detection (addendum A3.4). The dataset is the Lichess
 * chess-openings TSVs compiled to epd-keyed entries at build time
 * (scripts/build-openings.mjs); matching walks a game's positions from the
 * deepest ply backwards and the first (deepest) hit wins.
 *
 * Standard chess only: chess960 and other variants have no opening book by
 * construction and always return null.
 */

export interface OpeningEntry {
  fenKey: string;
  eco: string;
  name: string;
  pgn: string;
  ply: number;
}

export interface OpeningMatch {
  eco: string;
  name: string;
  /** Ply depth of the matched book line. */
  ply: number;
}

let index: Map<string, OpeningEntry> | null = null;

function openingIndex(): Map<string, OpeningEntry> {
  index ??= new Map((openingsData as OpeningEntry[]).map((entry) => [entry.fenKey, entry]));
  return index;
}

/** Deepest book line in the dataset — positions beyond this never match. */
export const MAX_BOOK_PLY = Math.max(...(openingsData as OpeningEntry[]).map((e) => e.ply));

/**
 * Matches a single position key (epd from `GamePosition.epd()`).
 */
export function openingForEpd(epd: string, variant: VariantId = "standard"): OpeningMatch | null {
  if (variant !== "standard") return null;
  const entry = openingIndex().get(epd);
  return entry ? { eco: entry.eco, name: entry.name, ply: entry.ply } : null;
}

/**
 * Matches a whole game: pass the epd of every position AFTER each ply, in
 * game order (`GamePosition.epd()` collected during replay). The deepest
 * position that appears in the book decides `games.eco` / `games.opening`.
 */
export function openingForGame(
  epdsAfterEachPly: string[],
  variant: VariantId = "standard"
): OpeningMatch | null {
  if (variant !== "standard") return null;
  const map = openingIndex();
  const searchDepth = Math.min(epdsAfterEachPly.length, MAX_BOOK_PLY);
  for (let i = searchDepth - 1; i >= 0; i--) {
    const entry = map.get(epdsAfterEachPly[i] as string);
    if (entry) return { eco: entry.eco, name: entry.name, ply: entry.ply };
  }
  return null;
}

/** Number of book positions loaded (diagnostics/seeding). */
export function openingCount(): number {
  return (openingsData as OpeningEntry[]).length;
}
