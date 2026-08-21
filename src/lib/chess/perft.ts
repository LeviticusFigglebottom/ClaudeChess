import { Chess } from "chess.js";

/**
 * perft: counts leaf nodes of the legal-move tree to the given depth.
 * Standard verification numbers from the start position:
 *   perft(1)=20, perft(2)=400, perft(3)=8_902, perft(4)=197_281
 * (Phase 0 gate: perft(4) must equal 197,281.)
 */
export function perft(chess: Chess, depth: number): number {
  if (depth === 0) return 1;
  const moves = chess.moves({ verbose: true });
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    chess.move(move);
    nodes += perft(chess, depth - 1);
    chess.undo();
  }
  return nodes;
}
