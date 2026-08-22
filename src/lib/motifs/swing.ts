import { GamePosition } from "@/lib/chess/position";
import { SEE_VALUES, uciSquares } from "./primitives";

/**
 * Swing classification of one error ply — the natural subdivision of
 * UNCLEAR (§9.2 presentation): does the stored refutation mate, win
 * material, or stay quiet? Pure function over the stored record; the same
 * accounting the UNCLEAR characterization used throughout C4 (the mover's
 * own capture on the blunder move is netted out, so "captured a knight,
 * got recaptured" is not a material swing).
 */
export type SwingKind = "mate" | "material" | "quiet";

export function classifySwing(input: {
  fenBefore: string;
  fenAfter: string;
  movedUci: string;
  refutationPv: string[];
  variant?: string;
}): SwingKind {
  const variant = input.variant === "chess960" ? "chess960" : "standard";
  let net = 0; // positive = the opponent comes out ahead
  try {
    const before = GamePosition.fromFen(input.fenBefore, variant);
    const { to } = uciSquares(input.movedUci);
    const victim = before.pieceAt(`${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`);
    if (victim) net -= SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
  } catch {
    return "quiet";
  }
  let replay: GamePosition;
  try {
    replay = GamePosition.fromFen(input.fenAfter, variant);
  } catch {
    return "quiet";
  }
  const moverIsWhite = replay.turn === "b"; // fenAfter turn = the opponent
  for (const uci of input.refutationPv.slice(0, 6)) {
    let value = 0;
    try {
      const { to } = uciSquares(uci);
      const victim = replay.pieceAt(`${"abcdefgh"[to % 8]}${Math.floor(to / 8) + 1}`);
      if (victim) value = SEE_VALUES[victim.role === "knight" ? "knight" : victim.role] ?? 0;
    } catch {
      break;
    }
    const stepIsMover = (replay.turn === "w") === moverIsWhite;
    if (!replay.moveUci(uci)) break;
    if (value > 0) net += stepIsMover ? -value : value;
  }
  if (replay.isCheckmate()) return "mate";
  return net >= 300 ? "material" : "quiet";
}
