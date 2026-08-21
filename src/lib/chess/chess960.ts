/**
 * Chess960 start-position generation (addendum A1.2).
 *
 * Scharnagl numbering, 0–959, so positions are reproducible and shareable;
 * SP518 is the standard array (RNBQKBNR). Castling rights are serialized as
 * X-FEN/Shredder file letters ("HAha" for SP518), never KQkq — KQkq-style
 * rights are exactly how 960 games lose the ability to castle across
 * serialization.
 */

const LIGHT_FILES = [1, 3, 5, 7] as const; // b, d, f, h
const DARK_FILES = [0, 2, 4, 6] as const; // a, c, e, g

/** The ten knight placements among the five free files, per Scharnagl. */
const KNIGHT_PAIRS = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 3],
  [2, 4],
  [3, 4],
] as const;

const FILE_CHARS = "abcdefgh";

/** Back-rank piece layout for a Scharnagl index, as 8 lowercase piece chars. */
export function chess960BackRank(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 959) {
    throw new Error(`chess960 index must be an integer in 0..959, got ${index}`);
  }

  const rank: (string | null)[] = Array(8).fill(null);

  const b1 = index % 4;
  const n2 = Math.floor(index / 4);
  rank[LIGHT_FILES[b1] as number] = "b";

  const b2 = n2 % 4;
  const n3 = Math.floor(n2 / 4);
  rank[DARK_FILES[b2] as number] = "b";

  const q = n3 % 6;
  const n4 = Math.floor(n3 / 6);
  const freeForQueen = rank.flatMap((piece, file) => (piece === null ? [file] : []));
  rank[freeForQueen[q] as number] = "q";

  const pair = KNIGHT_PAIRS[n4];
  if (!pair) throw new Error(`invalid knight table index ${n4} for chess960 index ${index}`);
  const freeForKnights = rank.flatMap((piece, file) => (piece === null ? [file] : []));
  rank[freeForKnights[pair[0]] as number] = "n";
  rank[freeForKnights[pair[1]] as number] = "n";

  const remaining = rank.flatMap((piece, file) => (piece === null ? [file] : []));
  rank[remaining[0] as number] = "r";
  rank[remaining[1] as number] = "k";
  rank[remaining[2] as number] = "r";

  return rank.join("");
}

/**
 * Full start FEN for a Scharnagl index, with X-FEN castling letters
 * (kingside file first, uppercase White then lowercase Black).
 */
export function chess960StartFen(index: number): string {
  const backRank = chess960BackRank(index);
  const rookFiles = [...backRank].flatMap((piece, file) => (piece === "r" ? [file] : []));
  const [queensideRook, kingsideRook] = rookFiles as [number, number];
  const castling =
    (FILE_CHARS[kingsideRook] as string).toUpperCase() +
    (FILE_CHARS[queensideRook] as string).toUpperCase() +
    (FILE_CHARS[kingsideRook] as string) +
    (FILE_CHARS[queensideRook] as string);

  return `${backRank}/pppppppp/8/8/8/8/PPPPPPPP/${backRank.toUpperCase()} w ${castling} - 0 1`;
}

/** SP518 — the standard array's Scharnagl index. */
export const STANDARD_SP_INDEX = 518;
