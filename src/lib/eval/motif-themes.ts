/**
 * §9.2 motif taxonomy → Lichess puzzle `themes` vocabulary (B1.2).
 *
 * The drill deck pulls Lichess puzzles matching a user's top blunder motifs,
 * but the two vocabularies are different languages. This map is the explicit
 * bridge; motifs with no puzzle-drillable equivalent are marked
 * `drillable: false` and the UI says so instead of silently returning
 * nothing. Blocks Phase 3; written now while the enum is fresh.
 *
 * Theme names follow lichess/lila's puzzle theme keys (the CSV dump's
 * `Themes` column). Mappings for structural/psychological motifs are
 * approximations by design — noted inline.
 */

import type { blunderMotifEnum } from "@/db/schema";

export type BlunderMotif = (typeof blunderMotifEnum.enumValues)[number];

export interface MotifDrillMapping {
  /** Lichess puzzle themes that train this motif; empty when not drillable. */
  themes: string[];
  drillable: boolean;
  note?: string;
}

export const MOTIF_TO_PUZZLE_THEMES: Record<BlunderMotif, MotifDrillMapping> = {
  HANGING_PIECE: { themes: ["hangingPiece"], drillable: true },
  OVERLOADED_DEFENDER: {
    themes: ["deflection", "capturingDefender"],
    drillable: true,
    note: "Lichess has no 'overloading' theme; deflection/capturing-the-defender exercises the same recognition.",
  },
  PINNED_PIECE_MOVED: { themes: ["pin"], drillable: true },
  BACK_RANK: { themes: ["backRankMate"], drillable: true },
  FORK_ALLOWED: { themes: ["fork"], drillable: true },
  SKEWER_ALLOWED: { themes: ["skewer"], drillable: true },
  DISCOVERED_ATTACK_MISSED: { themes: ["discoveredAttack"], drillable: true },
  TRAPPED_PIECE: { themes: ["trappedPiece"], drillable: true },
  REMOVING_THE_DEFENDER: { themes: ["capturingDefender", "deflection"], drillable: true },
  ZWISCHENZUG_MISSED: { themes: ["intermezzo"], drillable: true },
  KING_SAFETY_COLLAPSE: {
    themes: ["exposedKing", "kingsideAttack", "attackingF2F7"],
    drillable: true,
  },
  PAWN_STRUCTURE_COLLAPSE: {
    themes: ["advancedPawn", "pawnEndgame"],
    drillable: true,
    note: "Approximate — Lichess has no pawn-structure theme; drills reward structural pawn awareness.",
  },
  MATERIALISM: {
    themes: ["sacrifice", "attraction"],
    drillable: true,
    note: "Trains taking/declining material for position — the inverse of the error.",
  },
  PREMATURE_ATTACK: {
    themes: ["defensiveMove", "quietMove"],
    drillable: true,
    note: "Approximate — drills patience: the strong move that is not a threat.",
  },
  PASSIVITY: {
    themes: [],
    drillable: false,
    note: "Passivity is a plan-level error; puzzle positions always contain a concrete shot, which is the opposite lesson.",
  },
  ENDGAME_TECHNIQUE: { themes: ["endgame", "rookEndgame", "pawnEndgame"], drillable: true },
  PAWN_RACE_MISCOUNT: { themes: ["pawnEndgame", "promotion"], drillable: true },
  OPPOSITION_LOST: {
    themes: ["pawnEndgame", "zugzwang"],
    drillable: true,
    note: "Lichess has no 'opposition' theme; king-and-pawn/zugzwang drills cover the skill.",
  },
  TIME_PRESSURE: {
    themes: [],
    drillable: false,
    note: "A clock condition, not a board pattern — §9.3 (tempo trainer) owns this, not the drill deck.",
  },
  TUNNEL_VISION_POST_FORCING: {
    themes: [],
    drillable: false,
    note: "A search-habit error defined by the preceding move sequence; no puzzle set encodes it.",
  },
  // Structural class — mostly plan-level: puzzle sets encode tactics, so
  // several are honestly drill-unavailable rather than mapped by force.
  HOLE_CREATED: {
    themes: [],
    drillable: false,
    note: "A square-weakness commitment; puzzles always contain a shot, which teaches the opposite habit.",
  },
  OUTPOST_CONCEDED: {
    themes: [],
    drillable: false,
    note: "No outpost theme exists; marked unavailable rather than stretched.",
  },
  BISHOP_PAIR_SURRENDERED: {
    themes: [],
    drillable: false,
    note: "A long-horizon material-quality judgment; no puzzle equivalent.",
  },
  STRUCTURE_DAMAGED: {
    themes: ["advancedPawn", "pawnEndgame"],
    drillable: true,
    note: "Approximate, same basis as PAWN_STRUCTURE_COLLAPSE.",
  },
  BAD_PIECE_PLACEMENT: {
    themes: ["trappedPiece"],
    drillable: true,
    note: "Trapped-piece drills train the entombment radar even when the piece survives.",
  },
  FILE_OPENED_TOWARD_OWN_KING: {
    themes: ["exposedKing", "kingsideAttack"],
    drillable: true,
  },
  SPACE_CONCEDED: {
    themes: [],
    drillable: false,
    note: "Plan-level; no puzzle set encodes space counts.",
  },
  GOOD_PIECE_TRADED: {
    themes: [],
    drillable: false,
    note: "Exchange-quality judgment; puzzles cannot pose it without an engine bar.",
  },
  PAWN_BREAK_MISSED: {
    themes: ["quietMove"],
    drillable: true,
    note: "Approximate — quiet-move puzzles reward the non-forcing committal move.",
  },
  KING_WALK: {
    themes: ["exposedKing"],
    drillable: true,
  },
  // Forgone class (Task 3) — the tactic bestPv would have cashed. Missed
  // tactics are the MOST drillable motifs: finding the shot is exactly what
  // puzzles pose.
  MISSED_FORK: { themes: ["fork"], drillable: true },
  MISSED_PIN: { themes: ["pin"], drillable: true },
  MISSED_SKEWER: { themes: ["skewer"], drillable: true },
  MISSED_DISCOVERED_ATTACK: { themes: ["discoveredAttack"], drillable: true },
  MISSED_BACK_RANK: { themes: ["backRankMate"], drillable: true },
  MISSED_OVERLOAD: {
    themes: ["deflection", "capturingDefender"],
    drillable: true,
    note: "Same mapping basis as OVERLOADED_DEFENDER.",
  },
  MISSED_REMOVING_THE_DEFENDER: { themes: ["capturingDefender", "deflection"], drillable: true },
  MISSED_TRAPPED_PIECE: { themes: ["trappedPiece"], drillable: true },
  MISSED_ZWISCHENZUG: { themes: ["intermezzo"], drillable: true },
  UNCLEAR: {
    themes: [],
    drillable: false,
    note: "Catch-all bucket — nothing specific to drill by definition.",
  },
};

export function drillThemesForMotifs(motifs: BlunderMotif[]): string[] {
  const themes = new Set<string>();
  for (const motif of motifs) {
    for (const theme of MOTIF_TO_PUZZLE_THEMES[motif].themes) themes.add(theme);
  }
  return [...themes];
}
