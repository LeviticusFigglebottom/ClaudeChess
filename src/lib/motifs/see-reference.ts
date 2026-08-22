import type { Color, Square } from "chessops";
import { opposite } from "chessops/util";
import { attackersOf, SEE_VALUES, uciSquares, type Pos } from "./primitives";
import { SquareSet } from "chessops/squareSet";

/**
 * Reference SEE for the C4 cross-check: an exhaustive minimax over EVERY
 * attacker choice on the exchange square (not least-valuable-first), sharing
 * the production function's conventions (pins ignored, promotions ignored,
 * x-rays via occupancy). The swap algorithm's LVA ordering is provably
 * optimal, so this slower, structurally different search must agree with it
 * exactly — a real cross-validation, not a re-implementation.
 */

function bestGain(
  pos: Pos,
  square: Square,
  side: Color,
  occupied: SquareSet,
  valueOnSquare: number
): number {
  const attackers = attackersOf(pos.board, square, side, occupied);
  let best = 0; // declining to capture is always an option
  for (const from of attackers) {
    const piece = pos.board.get(from);
    if (!piece) continue;
    const gain =
      valueOnSquare -
      bestGain(pos, square, opposite(side), occupied.without(from), SEE_VALUES[piece.role]);
    if (gain > best) best = gain;
  }
  return best;
}

/** Reference evaluation of `uci` (capture or quiet landing). */
export function seeReference(pos: Pos, uci: string): number {
  const { from, to } = uciSquares(uci);
  const moving = pos.board.get(from);
  if (!moving) return 0;
  let occupied = pos.board.occupied.without(from);
  let victimValue = 0;
  const victim = pos.board.get(to);
  if (victim) victimValue = SEE_VALUES[victim.role];
  else if (moving.role === "pawn" && pos.epSquare === to) {
    victimValue = SEE_VALUES.pawn;
    occupied = occupied.without(to + (moving.color === "white" ? -8 : 8));
  }
  return (
    victimValue -
    bestGain(pos, to, opposite(moving.color), occupied, SEE_VALUES[moving.role])
  );
}
