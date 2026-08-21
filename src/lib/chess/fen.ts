import { validateFen } from "chess.js";
import type { Color } from "@/lib/eval/pov";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function sideToMove(fen: string): Color {
  const field = fen.split(" ")[1];
  if (field !== "w" && field !== "b") throw new Error(`invalid FEN (side to move): ${fen}`);
  return field;
}

export function isValidFen(fen: string): boolean {
  return validateFen(fen).ok;
}
