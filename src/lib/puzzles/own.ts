import { and, desc, eq, inArray } from "drizzle-orm";
import { blunderTags, games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { GamePosition } from "@/lib/chess/position";
import type { VariantId } from "@/lib/chess/variant";
import { ANALYSIS_SETTINGS } from "@/lib/eval";

/**
 * Puzzles FROM THE USER'S OWN GAMES: every full-depth BLUNDER whose stored
 * refutation line survives replay becomes a drill — the position before the
 * blunder, the blunder animating in as the setup move (the standard puzzle
 * contract), and the punishment as the solution. Themes come from the
 * deterministic motif tags. These are deliberately UNRATED: a homemade
 * puzzle has no calibrated rating, and self-derived attempts must never
 * touch the labeled puzzle Glicko pool (rating pools never blend).
 *
 * Variant-filtered like every trainer query (a 960 blunder is a different
 * population), and degraded/provisional plies are excluded as everywhere.
 */

export interface OwnPuzzle {
  id: string;
  fen: string;
  /** [blunderUci, ...refutation] — index 0 is the animated setup move. */
  movesUci: string[];
  theme: string | null;
  wpLoss: number;
  source: {
    gameId: string;
    ply: number;
    opponent: string;
    playedAt: string | null;
  };
}

const MAX_SOLUTION_PLIES = 5;

export async function ownPuzzles(
  db: Db,
  userId: string,
  variant: VariantId = "standard",
  limit = 40
): Promise<OwnPuzzle[]> {
  const rows = await db
    .select({
      plyId: plies.id,
      gameId: plies.gameId,
      ply: plies.ply,
      fenBefore: plies.fenBefore,
      uci: plies.uci,
      wpLoss: plies.wpLoss,
      analyzedAtDepth: plies.analyzedAtDepth,
      whiteName: games.whiteName,
      blackName: games.blackName,
      userColor: games.userColor,
      color: plies.color,
      playedAt: games.playedAt,
    })
    .from(plies)
    .innerJoin(games, eq(games.id, plies.gameId))
    .where(
      and(
        eq(games.userId, userId),
        eq(games.variant, variant),
        eq(plies.classification, "BLUNDER"),
        eq(plies.degraded, false)
      )
    )
    .orderBy(desc(games.playedAt))
    .limit(limit * 3);

  const fullDepth = rows.filter(
    (row) => (row.analyzedAtDepth ?? 0) >= ANALYSIS_SETTINGS.review.depth
  );
  if (fullDepth.length === 0) return [];

  // The refutation of ply k is ply k+1's stored pv1 (one search per position).
  const nextPlies = await db
    .select({ gameId: plies.gameId, ply: plies.ply, pv1: plies.pv1 })
    .from(plies)
    .where(
      inArray(
        plies.gameId,
        [...new Set(fullDepth.map((row) => row.gameId))]
      )
    );
  const refutationOf = new Map<string, string[]>();
  for (const next of nextPlies) {
    refutationOf.set(`${next.gameId}:${next.ply}`, (next.pv1 as string[] | null) ?? []);
  }

  const tagRows = await db
    .select({ plyId: blunderTags.plyId, motif: blunderTags.motif })
    .from(blunderTags)
    .where(
      and(
        inArray(blunderTags.plyId, fullDepth.map((row) => row.plyId)),
        eq(blunderTags.rank, 1)
      )
    );
  const themeOf = new Map(tagRows.map((row) => [row.plyId, row.motif]));

  const puzzles: OwnPuzzle[] = [];
  for (const row of fullDepth) {
    if (puzzles.length >= limit) break;
    const refutation = refutationOf.get(`${row.gameId}:${row.ply + 1}`) ?? [];
    if (refutation.length === 0) continue;
    // Replay-validate the full line from the pre-blunder position; trim at
    // the first illegal move (stored lines are engine output, but the replay
    // is the proof).
    const line = [row.uci, ...refutation.slice(0, MAX_SOLUTION_PLIES)];
    let replay: GamePosition;
    try {
      replay = GamePosition.fromFen(row.fenBefore, variant);
    } catch {
      continue;
    }
    const legal: string[] = [];
    for (const uci of line) {
      if (!replay.moveUci(uci)) break;
      legal.push(uci);
    }
    // Need the setup move plus at least one solver move.
    if (legal.length < 2) continue;
    // Solver moves are the odd indices; end the line on a solver move so the
    // puzzle never finishes with an unanswered opponent reply.
    const trimmed = legal.length % 2 === 0 ? legal : legal.slice(0, legal.length - 1);
    if (trimmed.length < 2) continue;
    const opponent = row.userColor === "black" ? row.whiteName : row.blackName;
    puzzles.push({
      id: `own:${row.plyId}`,
      fen: row.fenBefore,
      movesUci: trimmed,
      theme: themeOf.get(row.plyId) ?? null,
      wpLoss: row.wpLoss ?? 0,
      source: {
        gameId: row.gameId,
        ply: row.ply,
        opponent,
        playedAt: row.playedAt?.toISOString() ?? null,
      },
    });
  }
  return puzzles;
}
