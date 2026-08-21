import type { GamePosition } from "./position";

/**
 * perft: counts leaf nodes of the legal-move tree to the given depth
 * (delegates to chessops' move generator via the facade).
 * Standard verification numbers from the start position:
 *   perft(1)=20, perft(2)=400, perft(3)=8_902, perft(4)=197_281
 * (Phase 0 gate: perft(4) must equal 197,281. Phase 0.5 gate G2 extends this
 * to chess960 start positions, cross-checked against Stockfish's own
 * `go perft` — see perft960.test.ts.)
 */
export function perft(position: GamePosition, depth: number): number {
  return position.perft(depth);
}
