import { GamePosition } from "./position";
import type { VariantId } from "./variant";

/**
 * Renders a UCI principal variation as SAN, starting from `fen`. Stops at the
 * first move that does not apply (defensive against truncated PVs). Accepts
 * both castling encodings — classic (e1g1) from a standard-mode engine and
 * king-takes-rook (e1h1) from a chess960-mode engine.
 */
export function pvToSan(fen: string, uciMoves: string[], variant: VariantId = "standard"): string[] {
  let position: GamePosition;
  try {
    position = GamePosition.fromFen(fen, variant);
  } catch {
    return [];
  }
  const san: string[] = [];
  for (const uci of uciMoves) {
    const move = position.moveUci(uci);
    if (!move) break;
    san.push(move.san);
  }
  return san;
}
