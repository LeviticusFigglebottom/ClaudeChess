import type { EngineInfo } from "@/lib/engine/types";

export type Color = "w" | "b";

/**
 * THE sign boundary (spec §3.2, "Critical").
 *
 * Stockfish reports scores from the SIDE TO MOVE's point of view. This module
 * is the single place that converts to White-POV; everything downstream
 * (win probability, classification, eval graphs, the DB) speaks White-POV
 * centipawns or explicit mover-POV win probability. If a sign bug appears
 * anywhere in this project, the fix belongs here or at a call site that
 * bypassed this module — never a compensating negation elsewhere.
 */

/** A score normalized to White's point of view. */
export interface WhitePovEval {
  /** Centipawns, White-POV; null when the position is a forced mate. */
  cp: number | null;
  /** Signed mate distance, White-POV (positive = White mates); null otherwise. */
  mateIn: number | null;
}

export function toWhitePovCp(scoreCp: number, sideToMove: Color): number {
  return sideToMove === "w" ? scoreCp : -scoreCp;
}

export function toWhitePovMate(mateIn: number, sideToMove: Color): number {
  return sideToMove === "w" ? mateIn : -mateIn;
}

/**
 * Normalizes a raw EngineInfo (side-to-move POV, straight off the wire) to
 * White-POV. `sideToMove` is the mover in the position that was analyzed —
 * i.e. the FEN handed to `setPosition`.
 */
export function normalizeInfo(info: EngineInfo, sideToMove: Color): WhitePovEval {
  if (info.mateIn !== null) {
    return { cp: null, mateIn: toWhitePovMate(info.mateIn, sideToMove) };
  }
  if (info.scoreCp !== null) {
    return { cp: toWhitePovCp(info.scoreCp, sideToMove), mateIn: null };
  }
  throw new Error("EngineInfo carries neither cp nor mate score");
}

/** Flips a White-POV eval to the given color's POV. */
export function forColor(evaluation: WhitePovEval, color: Color): WhitePovEval {
  if (color === "w") return evaluation;
  return {
    cp: evaluation.cp === null ? null : -evaluation.cp,
    mateIn: evaluation.mateIn === null ? null : -evaluation.mateIn,
  };
}
