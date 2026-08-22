import { posFromFen, kingZoneAttackers, SEE_VALUES, type Pos } from "@/lib/motifs/primitives";

/**
 * §9.1 positionTags, computed at generation time from the FEN alone —
 * deterministic chess geometry (C0: deciding belongs in code). These feed
 * the directional-bias report ("you overestimate by 14 WP when you're the
 * one attacking"), so each tag is a small closed vocabulary.
 */

export interface PositionTags {
  phase: "opening" | "middlegame" | "endgame";
  openness: "open" | "semi-open" | "closed";
  /** White-POV material balance in centipawns. */
  materialBalance: number;
  sideAttacking: "white" | "black" | "none";
  /** Attackers on the black king's zone minus attackers on white's (White-POV danger delta). */
  kingSafetyDelta: number;
  hasImbalance: boolean;
  [key: string]: string | number | boolean;
}

interface Counts {
  pawns: number;
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
}

function countPieces(pos: Pos, color: "white" | "black"): Counts {
  const side = pos.board[color];
  return {
    pawns: pos.board.pawn.intersect(side).size(),
    knights: pos.board.knight.intersect(side).size(),
    bishops: pos.board.bishop.intersect(side).size(),
    rooks: pos.board.rook.intersect(side).size(),
    queens: pos.board.queen.intersect(side).size(),
  };
}

function materialCp(counts: Counts): number {
  return (
    counts.pawns * SEE_VALUES.pawn +
    counts.knights * SEE_VALUES.knight +
    counts.bishops * SEE_VALUES.bishop +
    counts.rooks * SEE_VALUES.rook +
    counts.queens * SEE_VALUES.queen
  );
}

export function computePositionTags(fen: string): PositionTags {
  const pos = posFromFen(fen);
  const white = countPieces(pos, "white");
  const black = countPieces(pos, "black");
  const materialBalance = materialCp(white) - materialCp(black);

  // Phase: by non-pawn material and back-rank development.
  const minorMajorTotal =
    white.knights + white.bishops + white.rooks + white.queens +
    black.knights + black.bishops + black.rooks + black.queens;
  const fullmove = Number(fen.split(" ")[5] ?? "1");
  const phase: PositionTags["phase"] =
    minorMajorTotal <= 6 || (white.queens === 0 && black.queens === 0 && minorMajorTotal <= 8)
      ? "endgame"
      : fullmove <= 10
        ? "opening"
        : "middlegame";

  // Openness: locked pawn pairs (white pawn directly facing a black pawn)
  // versus fully open files (no pawns of either color).
  let locked = 0;
  for (const square of pos.board.pawn.intersect(pos.board.white)) {
    if (square + 8 <= 63 && pos.board.pawn.intersect(pos.board.black).has(square + 8)) locked++;
  }
  let openFiles = 0;
  for (let file = 0; file < 8; file++) {
    let pawnsOnFile = 0;
    for (const square of pos.board.pawn) if (square % 8 === file) pawnsOnFile++;
    if (pawnsOnFile === 0) openFiles++;
  }
  const openness: PositionTags["openness"] =
    locked >= 3 && openFiles === 0 ? "closed" : openFiles >= 2 || locked === 0 ? "open" : "semi-open";

  // Attacking side via king-zone pressure differential (§9.1's
  // sideAttacking = king-zone attacker count).
  const onBlackKing = kingZoneAttackers(pos, "black");
  const onWhiteKing = kingZoneAttackers(pos, "white");
  const kingSafetyDelta = onBlackKing - onWhiteKing;
  const sideAttacking: PositionTags["sideAttacking"] =
    kingSafetyDelta >= 2 ? "white" : kingSafetyDelta <= -2 ? "black" : "none";

  // Imbalance: bishop pair on exactly one side, exchange-style asymmetry,
  // or pawn-count asymmetry with roughly level material.
  const bishopPairOneSide = (white.bishops >= 2) !== (black.bishops >= 2);
  const exchangeAsymmetry =
    white.rooks !== black.rooks && white.knights + white.bishops !== black.knights + black.bishops;
  const pawnAsymmetry = white.pawns !== black.pawns && Math.abs(materialBalance) < 150;
  const hasImbalance = bishopPairOneSide || exchangeAsymmetry || pawnAsymmetry;

  return { phase, openness, materialBalance, sideAttacking, kingSafetyDelta, hasImbalance };
}
