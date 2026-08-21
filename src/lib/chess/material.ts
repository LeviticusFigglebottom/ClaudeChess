import type { Color } from "@/lib/eval/pov";

/** Static piece values in centipawns (kings excluded). */
export const PIECE_VALUES_CP: Record<string, number> = {
  p: 100,
  n: 300,
  b: 300,
  r: 500,
  q: 900,
};

export interface MaterialCount {
  whiteCp: number;
  blackCp: number;
  /** White-POV difference in centipawns. */
  diffCp: number;
}

/** Counts static material from a FEN's board field. */
export function materialCount(fen: string): MaterialCount {
  const board = fen.split(" ")[0] ?? "";
  let whiteCp = 0;
  let blackCp = 0;
  for (const char of board) {
    const value = PIECE_VALUES_CP[char.toLowerCase()];
    if (value === undefined) continue;
    if (char === char.toUpperCase()) whiteCp += value;
    else blackCp += value;
  }
  return { whiteCp, blackCp, diffCp: whiteCp - blackCp };
}

/**
 * Static material change for `color` between two positions, in centipawns
 * from that color's POV. Negative = that side gave up material. Used by the
 * BRILLIANT sacrifice test (§4.3: delta after the opponent's best reply).
 */
export function materialDeltaCp(fenBefore: string, fenAfter: string, color: Color): number {
  const before = materialCount(fenBefore);
  const after = materialCount(fenAfter);
  const diffChange = after.diffCp - before.diffCp;
  return color === "w" ? diffChange : -diffChange;
}
