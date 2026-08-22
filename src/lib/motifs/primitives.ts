import {
  attacks,
  between,
  bishopAttacks,
  kingAttacks,
  knightAttacks,
  pawnAttacks,

  ray,
  rookAttacks,
} from "chessops/attacks";
import type { Board } from "chessops/board";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { SquareSet } from "chessops/squareSet";
import type { Color, Role, Square } from "chessops";
import { opposite, parseSquare, parseUci, squareFile, squareRank } from "chessops/util";

/**
 * C2.2 motif primitives, built on chessops' bitboard geometry. This module
 * (with detect.ts) is the second sanctioned home of chessops alongside the
 * position facade — its PUBLIC surface still speaks FEN/UCI strings and
 * plain numbers; chessops types never escape src/lib/motifs.
 *
 * `see` is the single most load-bearing primitive: the standard swap-off
 * algorithm (least valuable attacker first, x-rays included, pins ignored,
 * promotions ignored — conventional SEE semantics, and the reference
 * implementation used by the C4 cross-check applies the same conventions).
 */

export const SEE_VALUES: Record<Role, number> = {
  pawn: 100,
  knight: 300,
  bishop: 300,
  rook: 500,
  queen: 900,
  king: 20_000,
};

export interface Pos {
  board: Board;
  turn: Color;
  epSquare: Square | undefined;
}

export function posFromFen(fen: string): Pos {
  const setup = parseFen(fen).unwrap();
  // Motif geometry is variant-agnostic (all supported variants share
  // movement); Chess.fromSetup validates structure.
  const chess = Chess.fromSetup(setup).unwrap();
  return { board: chess.board, turn: chess.turn, epSquare: chess.epSquare };
}

export function sq(name: string): Square {
  const parsed = parseSquare(name);
  if (parsed === undefined) throw new Error(`bad square "${name}"`);
  return parsed;
}

export function uciSquares(uci: string): { from: Square; to: Square; promotion: boolean } {
  const move = parseUci(uci);
  if (!move || !("from" in move)) throw new Error(`bad uci "${uci}"`);
  return { from: move.from, to: move.to, promotion: uci.length === 5 };
}

/** All `color` pieces attacking `square` under the given occupancy. */
export function attackersOf(
  board: Board,
  square: Square,
  color: Color,
  occupied: SquareSet = board.occupied
): SquareSet {
  const colorPieces = board[color];
  return rookAttacks(square, occupied)
    .intersect(board.rook.union(board.queen))
    .union(bishopAttacks(square, occupied).intersect(board.bishop.union(board.queen)))
    .union(knightAttacks(square).intersect(board.knight))
    .union(kingAttacks(square).intersect(board.king))
    .union(pawnAttacks(opposite(color), square).intersect(board.pawn))
    .intersect(colorPieces)
    .intersect(occupied);
}

/** attackersOf for the owning side (C2.2) — pieces defending `square`. */
export function defendersOf(
  board: Board,
  square: Square,
  ownerColor: Color,
  occupied: SquareSet = board.occupied
): SquareSet {
  return attackersOf(board, square, ownerColor, occupied);
}

function leastValuableAttacker(
  board: Board,
  attackers: SquareSet
): { square: Square; role: Role } | null {
  let best: { square: Square; role: Role } | null = null;
  for (const square of attackers) {
    const piece = board.get(square);
    if (!piece) continue;
    if (!best || SEE_VALUES[piece.role] < SEE_VALUES[best.role]) {
      best = { square, role: piece.role };
    }
  }
  return best;
}

/**
 * Static exchange evaluation of `move` (UCI), centipawns for the mover.
 * Handles empty-target moves ("can the opponent win this piece where it
 * lands?") — the safeSquares/trap primitives rely on that.
 */
export function see(pos: Pos, uci: string): number {
  const { from, to } = uciSquares(uci);
  const board = pos.board;
  const moving = board.get(from);
  if (!moving) return 0;
  const mover = moving.color;

  let victimValue = 0;
  let occupied = board.occupied.without(from);
  const victim = board.get(to);
  if (victim) {
    victimValue = SEE_VALUES[victim.role];
  } else if (moving.role === "pawn" && pos.epSquare === to) {
    victimValue = SEE_VALUES.pawn;
    const capturedPawn = to + (mover === "white" ? -8 : 8);
    occupied = occupied.without(capturedPawn);
  }

  const gain: number[] = [victimValue];
  let attackerValue = SEE_VALUES[moving.role];
  let side = opposite(mover);
  // The moving piece now occupies `to` (kept out of `occupied` so x-rays
  // through the target square resolve; its value rides in attackerValue).

  // No early pruning: the negamax unwind below handles every declination
  // decision, and exchanges are ≤ 32 plies. (A mis-placed stand-pat prune
  // was caught by the C4 cross-check truncating guarded recaptures.)
  for (let depth = 1; depth < 32; depth++) {
    const attackers = attackersOf(board, to, side, occupied);
    const next = leastValuableAttacker(board, attackers.intersect(occupied));
    if (!next) break;
    gain[depth] = attackerValue - (gain[depth - 1] as number);
    occupied = occupied.without(next.square);
    attackerValue = SEE_VALUES[next.role];
    side = opposite(side);
  }
  for (let depth = gain.length - 1; depth > 0; depth--) {
    gain[depth - 1] = -Math.max(-(gain[depth - 1] as number), gain[depth] as number);
  }
  return (gain[0] as number) + 0; // normalize -0
}

export interface PinInfo {
  pinned: boolean;
  /** The piece the pin protects (behind the pinned piece on the ray). */
  behind: Square | null;
  pinner: Square | null;
}

/**
 * C2.2 pin test: remove the piece at `square`; if an enemy slider then
 * attacks a higher-value friendly piece (or the king) along the ray through
 * `square`, the piece was pinned to it.
 */
export function pinInfo(pos: Pos, square: Square): PinInfo {
  const piece = pos.board.get(square);
  if (!piece) return { pinned: false, behind: null, pinner: null };
  const without = pos.board.occupied.without(square);
  const enemy = opposite(piece.color);
  const sliders = pos.board[enemy].intersect(
    pos.board.bishop.union(pos.board.rook).union(pos.board.queen)
  );
  for (const pinner of sliders) {
    const pinnerPiece = pos.board.get(pinner);
    if (!pinnerPiece) continue;
    if (!attacks(pinnerPiece, pinner, pos.board.occupied).has(square)) continue;
    const lineOfSight = attacks(pinnerPiece, pinner, without);
    // First friendly piece BEHIND `square` on the pinner→square ray.
    const rayThrough = ray(pinner, square);
    for (const behind of lineOfSight.intersect(rayThrough).intersect(pos.board[piece.color])) {
      if (behind === square) continue;
      // `square` must sit between pinner and behind.
      if (!between(pinner, behind).has(square)) continue;
      const behindPiece = pos.board.get(behind);
      if (!behindPiece) continue;
      if (
        behindPiece.role === "king" ||
        SEE_VALUES[behindPiece.role] > SEE_VALUES[piece.role]
      ) {
        return { pinned: true, behind, pinner };
      }
    }
  }
  return { pinned: false, behind: null, pinner: null };
}

export interface Discovered {
  attacker: Square;
  target: Square;
}

/**
 * C2.2 discovered-attack test for a move in `pos`: does vacating `from`
 * reveal a friendly slider's attack on an enemy piece (that was previously
 * blocked only by the moving piece, and the destination doesn't re-block)?
 */
export function discoveredBy(pos: Pos, uci: string): Discovered | null {
  const { from, to } = uciSquares(uci);
  const moving = pos.board.get(from);
  if (!moving) return null;
  const sliders = pos.board[moving.color].intersect(
    pos.board.bishop.union(pos.board.rook).union(pos.board.queen)
  );
  const occupiedAfter = pos.board.occupied.without(from).with(to);
  for (const slider of sliders) {
    if (slider === from) continue;
    const sliderPiece = pos.board.get(slider);
    if (!sliderPiece) continue;
    if (!ray(slider, from).nonEmpty() || !ray(slider, from).has(from)) continue;
    const beforeSight = attacks(sliderPiece, slider, pos.board.occupied);
    const afterSight = attacks(sliderPiece, slider, occupiedAfter);
    const revealed = afterSight.diff(beforeSight).intersect(pos.board[opposite(moving.color)]);
    for (const target of revealed) {
      // The reveal must be along the ray the mover vacated.
      if (!ray(slider, target).has(from)) continue;
      const targetPiece = pos.board.get(target);
      if (!targetPiece) continue;
      return { attacker: slider, target };
    }
  }
  return null;
}

/** Attack-mobility for `color`: number of pseudo-legal destination squares. */
export function mobility(pos: Pos, color: Color): number {
  let count = 0;
  const own = pos.board[color];
  for (const from of own) {
    const piece = pos.board.get(from);
    if (!piece) continue;
    if (piece.role === "pawn") {
      // Pushes + captures; promotion under-counting is fine for deltas.
      const dir = color === "white" ? 8 : -8;
      const one = from + dir;
      if (one >= 0 && one < 64 && !pos.board.occupied.has(one)) {
        count++;
        const startRank = color === "white" ? 1 : 6;
        const two = from + 2 * dir;
        if (squareRank(from) === startRank && !pos.board.occupied.has(two)) count++;
      }
      count += pawnAttacks(color, from).intersect(pos.board[opposite(color)]).size();
    } else {
      count += attacks(piece, from, pos.board.occupied).diff(own).size();
    }
  }
  return count;
}

const KING_ZONE_WEIGHTS: Record<Role, number> = {
  pawn: 1,
  knight: 2,
  bishop: 2,
  rook: 3,
  queen: 5,
  king: 0,
};

/** The 3×3 zone around `color`'s king plus three advance squares (C2.2). */
export function kingZone(pos: Pos, color: Color): SquareSet {
  const king = pos.board.kingOf(color);
  if (king === undefined) return SquareSet.empty();
  let zone = kingAttacks(king).with(king);
  const forward = color === "white" ? 16 : -16;
  const file = squareFile(king);
  for (const df of [-1, 0, 1]) {
    const advance = king + forward + df;
    if (advance >= 0 && advance < 64 && Math.abs(squareFile(advance) - file) <= 1) {
      zone = zone.with(advance);
    }
  }
  return zone;
}

/**
 * Weighted count of enemy pieces attacking `color`'s king zone (C2.2):
 * each attacking piece counts once at its weight.
 */
export function kingZoneAttackers(pos: Pos, color: Color): number {
  const zone = kingZone(pos, color);
  const enemy = opposite(color);
  let total = 0;
  for (const from of pos.board[enemy]) {
    const piece = pos.board.get(from);
    if (!piece || piece.role === "king") continue;
    const reach =
      piece.role === "pawn"
        ? pawnAttacks(enemy, from)
        : attacks(piece, from, pos.board.occupied);
    if (reach.intersects(zone)) total += KING_ZONE_WEIGHTS[piece.role];
  }
  return total;
}

/**
 * Destinations for the piece on `square` where it is not lost on arrival:
 * pseudo-legal piece moves with see ≥ 0 (C2.2). Empty set = candidate trap.
 */
export function safeSquares(pos: Pos, square: Square): SquareSet {
  const piece = pos.board.get(square);
  if (!piece) return SquareSet.empty();
  let destinations: SquareSet;
  if (piece.role === "pawn") {
    const dir = piece.color === "white" ? 8 : -8;
    destinations = SquareSet.empty();
    const one = square + dir;
    if (one >= 0 && one < 64 && !pos.board.occupied.has(one)) destinations = destinations.with(one);
    destinations = destinations.union(
      pawnAttacks(piece.color, square).intersect(pos.board[opposite(piece.color)])
    );
  } else {
    destinations = attacks(piece, square, pos.board.occupied).diff(pos.board[piece.color]);
  }
  let safe = SquareSet.empty();
  for (const to of destinations) {
    if (see(pos, `${squareName(square)}${squareName(to)}`) >= 0) safe = safe.with(to);
  }
  return safe;
}

/** Check, capture, or promotion (C2.2). Checked against `pos` (pre-move). */
export function isForcing(pos: Pos, uci: string): boolean {
  const { from, to, promotion } = uciSquares(uci);
  if (promotion) return true;
  const moving = pos.board.get(from);
  if (!moving) return false;
  const target = pos.board.get(to);
  if (target && target.color !== moving.color) return true;
  if (moving.role === "pawn" && pos.epSquare === to) return true;
  // Check detection: does the piece attack the enemy king from `to`, or is
  // a discovered check revealed?
  const enemyKing = pos.board.kingOf(opposite(moving.color));
  if (enemyKing === undefined) return false;
  const occupiedAfter = pos.board.occupied.without(from).with(to);
  if (attacks(moving, to, occupiedAfter).has(enemyKing)) return true;
  const discovered = discoveredBy(pos, uci);
  return discovered !== null && discovered.target === enemyKing;
}

export function squareName(square: Square): string {
  return `${"abcdefgh"[squareFile(square)]}${squareRank(square) + 1}`;
}
