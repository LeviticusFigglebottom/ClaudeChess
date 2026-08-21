import type { Move, Position, Role, SquareName } from "chessops";
import { castlingSide, normalizeMove } from "chessops/chess";
import { perft as chessopsPerft } from "chessops/debug";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import {
  charToRole,
  kingCastlesTo,
  makeSquare,
  makeUci,
  parseSquare,
  parseUci,
  squareFile,
  squareRank,
} from "chessops/util";
import { chessgroundDests } from "chessops/compat";
import { setupPosition } from "chessops/variant";
import type { SquareSet } from "chessops/squareSet";
import type { Color } from "@/lib/eval/pov";
import { rulesForVariant, type VariantId } from "./variant";
import { chess960StartFen } from "./chess960";
import { START_FEN } from "./fen";

/**
 * The rules facade (addendum A1.1, resolved to chessops). This module is the
 * ONLY place chessops' Result handling and Move/Square encodings live; the
 * rest of the app sees plain strings and booleans.
 *
 * Castling encodings, fixed here once:
 * - Internally (and for chess960 UCI) castling is king-takes-own-rook — the
 *   chessops / Lichess / UCI_Chess960 convention.
 * - For standard games the facade EMITS classic castling UCI (e1g1), the
 *   universal standard-chess convention, and ACCEPTS both encodings.
 * - FENs for chess960 always serialize castling rights as X-FEN file letters
 *   ("HAha"), never KQkq (A1.2); standard keeps KQkq.
 */

export interface FacadeMove {
  san: string;
  uci: string;
  from: string;
  to: string;
}

const FILE_CHARS = "abcdefgh";

/** X-FEN castling field from castling-rights squares: "HAha"-style, kingside file first. */
function xfenCastling(rights: SquareSet): string {
  let out = "";
  for (const color of ["white", "black"] as const) {
    const backRank = color === "white" ? 0 : 7;
    const files = [...rights]
      .filter((sq) => squareRank(sq) === backRank)
      .map((sq) => squareFile(sq))
      .sort((a, b) => b - a); // kingside (higher file) first
    for (const file of files) {
      const letter = FILE_CHARS[file] as string;
      out += color === "white" ? letter.toUpperCase() : letter;
    }
  }
  return out === "" ? "-" : out;
}

function replaceCastlingField(fen: string, castling: string): string {
  const fields = fen.split(" ");
  fields[2] = castling;
  return fields.join(" ");
}

export class GamePosition {
  private pos: Position;
  /** Snapshots taken BEFORE each move, so undo() is a pop. */
  private stack: { pos: Position; record: FacadeMove }[] = [];
  /** Repetition keys (epd) for every position seen, including the current one. */
  private keys: string[];

  readonly variant: VariantId;
  readonly startFen: string;

  private constructor(pos: Position, variant: VariantId, startFen: string) {
    this.pos = pos;
    this.variant = variant;
    this.startFen = startFen;
    this.keys = [this.epd()];
  }

  static fromFen(fen: string, variant: VariantId = "standard"): GamePosition {
    const setup = parseFen(fen);
    if (setup.isErr) throw new Error(`invalid FEN "${fen}": ${setup.error.message}`);
    const pos = setupPosition(rulesForVariant(variant), setup.value);
    if (pos.isErr) throw new Error(`illegal position "${fen}": ${pos.error.message}`);
    return new GamePosition(pos.value, variant, fen);
  }

  static initial(variant: VariantId = "standard"): GamePosition {
    if (variant === "chess960") {
      throw new Error("chess960 has no single initial position — use fromChess960(index)");
    }
    return GamePosition.fromFen(START_FEN, variant);
  }

  static fromChess960(index: number): GamePosition {
    return GamePosition.fromFen(chess960StartFen(index), "chess960");
  }

  get turn(): Color {
    return this.pos.turn === "white" ? "w" : "b";
  }

  /** Current FEN. chess960 always uses X-FEN castling letters. */
  fen(): string {
    const setup = this.pos.toSetup();
    const fen = makeFen(setup);
    if (this.variant !== "chess960") return fen;
    return replaceCastlingField(fen, xfenCastling(setup.castlingRights));
  }

  /** Position key without move counters — the opening-book / repetition key. */
  epd(): string {
    return makeFen(this.pos.toSetup(), { epd: true });
  }

  pieceAt(square: string): { color: Color; role: Role } | null {
    const sq = parseSquare(square);
    if (sq === undefined) return null;
    const piece = this.pos.board.get(sq);
    if (!piece) return null;
    return { color: piece.color === "white" ? "w" : "b", role: piece.role };
  }

  /**
   * Legal destination squares for the UI. Standard offers castling under
   * both encodings (king→g1 and king→rook); chess960 offers king-takes-rook
   * only, since one-step castling is ambiguous with a normal king move
   * (A1.2: tap king, then tap rook).
   */
  destsFrom(square: string): string[] {
    const dests: Map<string, string[]> = chessgroundDests(this.pos, {
      chess960: this.variant === "chess960",
    });
    return dests.get(square) ?? [];
  }

  /** Number of legal moves, castling counted once per side. */
  legalMoveCount(): number {
    let count = 0;
    for (const [, dests] of this.pos.allDests()) count += dests.size();
    return count;
  }

  move(input: { from: string; to: string; promotion?: string }): FacadeMove | null {
    const from = parseSquare(input.from);
    const to = parseSquare(input.to);
    if (from === undefined || to === undefined) return null;

    let promotion: Role | undefined = input.promotion ? charToRole(input.promotion) : undefined;
    if (promotion === undefined && this.isPromotionMove(from, to)) promotion = "queen";

    return this.applyMove({ from, to, promotion });
  }

  /** Applies a UCI move (accepts both castling encodings). */
  moveUci(uci: string): FacadeMove | null {
    const move = parseUci(uci);
    if (!move || !("from" in move)) return null;
    return this.applyMove(move);
  }

  undo(): boolean {
    const previous = this.stack.pop();
    if (!previous) return false;
    this.pos = previous.pos;
    this.keys.pop();
    return true;
  }

  reset(): void {
    const fresh = GamePosition.fromFen(this.startFen, this.variant);
    this.pos = fresh.pos;
    this.stack = [];
    this.keys = [this.epd()];
  }

  history(): FacadeMove[] {
    return this.stack.map((entry) => entry.record);
  }

  historySan(): string[] {
    return this.stack.map((entry) => entry.record.san);
  }

  lastMove(): FacadeMove | null {
    return this.stack.at(-1)?.record ?? null;
  }

  isCheck(): boolean {
    return this.pos.isCheck();
  }

  isCheckmate(): boolean {
    return this.pos.isCheckmate();
  }

  isStalemate(): boolean {
    return this.pos.isStalemate();
  }

  isInsufficientMaterial(): boolean {
    return this.pos.isInsufficientMaterial();
  }

  isFiftyMoves(): boolean {
    return this.pos.halfmoves >= 100;
  }

  isThreefold(): boolean {
    const current = this.keys.at(-1);
    return this.keys.filter((key) => key === current).length >= 3;
  }

  /** Checkmate/stalemate/variant end, or a claimable draw (threefold, fifty moves). */
  isGameOver(): boolean {
    return this.pos.isEnd() || this.isThreefold() || this.isFiftyMoves();
  }

  /** 'white' | 'black' | 'draw' | null (game still running). */
  outcome(): "white" | "black" | "draw" | null {
    if (this.pos.isEnd()) {
      const outcome = this.pos.outcome();
      if (!outcome) return null;
      return outcome.winner ?? "draw";
    }
    if (this.isThreefold() || this.isFiftyMoves()) return "draw";
    return null;
  }

  perft(depth: number): number {
    return chessopsPerft(this.pos, depth);
  }

  private isPromotionMove(from: number, to: number): boolean {
    const piece = this.pos.board.get(from);
    if (piece?.role !== "pawn") return false;
    const lastRank = this.pos.turn === "white" ? 7 : 0;
    return squareRank(to) === lastRank;
  }

  private applyMove(candidate: { from: number; to: number; promotion?: Role }): FacadeMove | null {
    const move: Move = normalizeMove(this.pos, candidate);
    if (!this.pos.isLegal(move)) return null;

    const san = makeSan(this.pos, move);
    const uci = this.uciFor(move);
    const record: FacadeMove = {
      san,
      uci,
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
    };

    this.stack.push({ pos: this.pos.clone(), record });
    this.pos.play(move);
    this.keys.push(this.epd());
    return record;
  }

  /** Standard emits classic castling UCI (e1g1); chess960 emits king-takes-rook. */
  private uciFor(move: Move): string {
    if (this.variant !== "chess960" && "from" in move) {
      const side = castlingSide(this.pos, move);
      if (side) {
        return makeSquare(move.from) + makeSquare(kingCastlesTo(this.pos.turn, side));
      }
    }
    return makeUci(move);
  }
}

/** True when the FEN parses to a legal position under the given variant. */
export function isValidFen(fen: string, variant: VariantId = "standard"): boolean {
  try {
    GamePosition.fromFen(fen, variant);
    return true;
  } catch {
    return false;
  }
}

/** The castling field the facade would serialize for this FEN (test/tool helper). */
export function castlingFieldOf(fen: string, variant: VariantId = "standard"): string {
  return GamePosition.fromFen(fen, variant).fen().split(" ")[2] ?? "-";
}

export type { SquareName };
