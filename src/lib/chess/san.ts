import { Chess } from "chess.js";

/**
 * Renders a UCI principal variation as SAN, starting from `fen`. Stops at the
 * first move that does not apply (defensive against truncated PVs).
 */
export function pvToSan(fen: string, uciMoves: string[]): string[] {
  const chess = new Chess(fen);
  const san: string[] = [];
  for (const uci of uciMoves) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4) : undefined,
      });
      san.push(move.san);
    } catch {
      break;
    }
  }
  return san;
}
