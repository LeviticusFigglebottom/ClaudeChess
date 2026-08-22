import { GamePosition } from "@/lib/chess/position";
import { posFromFen, see } from "./primitives";
import { seeReference } from "./see-reference";

/**
 * C4 SEE cross-check harness: seeded random legal playouts, every capture
 * evaluated by both the production swap algorithm and the exhaustive
 * reference. Used by the CI test (250 samples) and the gate script (1000).
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeeCheck {
  fen: string;
  uci: string;
  fast: number;
  reference: number;
}

export function collectCaptureChecks(sampleTarget: number, seed: number): SeeCheck[] {
  const random = mulberry32(seed);
  const results: SeeCheck[] = [];
  while (results.length < sampleTarget) {
    const game = GamePosition.initial();
    const plies = 8 + Math.floor(random() * 60);
    for (let i = 0; i < plies && !game.isGameOver(); i++) {
      const moves = game.legalMovesUci();
      if (moves.length === 0) break;
      game.moveUci(moves[Math.floor(random() * moves.length)]!);
    }
    if (game.isGameOver()) continue;
    const fen = game.fen();
    const pos = posFromFen(fen);
    for (const uci of game.legalMovesUci()) {
      const to = uci.slice(2, 4);
      const victim = game.pieceAt(to);
      if (!victim) continue; // sample captures (the load-bearing case)
      results.push({ fen, uci, fast: see(pos, uci), reference: seeReference(pos, uci) });
      if (results.length >= sampleTarget) break;
    }
  }
  return results;
}
