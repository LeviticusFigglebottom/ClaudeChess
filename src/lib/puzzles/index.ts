import { and, desc, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { puzzleAttempts, puzzles, ratings } from "@/db/schema";
import { AccountError, type Db, type UserRow } from "@/lib/account/types";
import {
  newPlayerRating,
  updateRating,
  type Glicko2Rating,
} from "@/lib/rating/glicko2";

/**
 * Rated puzzle mode (Phase 3). Puzzle rating is its own Glicko-2 pool,
 * stored as ratings(variant='standard', timeControl='puzzle') and NEVER
 * blended or compared with game ratings (standing requirement: every pool
 * labeled). Updates apply per attempt — each puzzle is a one-game rating
 * period. That is a deliberate, documented departure from §7's 12-game
 * batching, which models games arriving over days: a puzzle session is
 * dozens of independent results in minutes, per-attempt is the established
 * convention for puzzle pools (it is what the source ratings themselves
 * were fitted with), and the convergence gate below depends on it.
 * Puzzle ratings themselves stay fixed (the dump's values are authoritative).
 */

export interface PuzzleView {
  id: string;
  fen: string;
  movesUci: string[];
  rating: number;
  themes: string[];
}

export interface PuzzleRatingView {
  rating: number;
  rd: number;
  volatility: number;
  attempts: number;
}

export async function getPuzzleRating(db: Db, userId: string): Promise<PuzzleRatingView> {
  const row = (
    await db
      .select()
      .from(ratings)
      .where(
        and(
          eq(ratings.userId, userId),
          eq(ratings.variant, "standard"),
          eq(ratings.timeControl, "puzzle")
        )
      )
  )[0];
  const attempts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(puzzleAttempts)
    .where(eq(puzzleAttempts.userId, userId));
  const base = row
    ? { rating: row.rating, rd: row.rd, volatility: row.volatility }
    : newPlayerRating();
  return { ...base, attempts: attempts[0]?.n ?? 0 };
}

/**
 * Serves the next puzzle near the user's rating: ±100 window expanding by
 * 100 until something unseen (last 300 attempts) matches. Optional theme
 * filter (the §9.2 drill deck reuses this with MOTIF_TO_PUZZLE_THEMES).
 */
export async function nextPuzzle(
  db: Db,
  userId: string,
  opts: { themes?: string[] } = {}
): Promise<PuzzleView> {
  const { rating } = await getPuzzleRating(db, userId);
  const recent = await db
    .select({ puzzleId: puzzleAttempts.puzzleId })
    .from(puzzleAttempts)
    .where(eq(puzzleAttempts.userId, userId))
    .orderBy(desc(puzzleAttempts.attemptedAt))
    .limit(300);
  const seen = recent.map((row) => row.puzzleId);

  for (let window = 100; window <= 1200; window += 100) {
    const conditions = [
      gte(puzzles.rating, Math.round(rating - window)),
      lte(puzzles.rating, Math.round(rating + window)),
    ];
    if (seen.length) conditions.push(notInArray(puzzles.id, seen));
    if (opts.themes && opts.themes.length > 0) {
      conditions.push(
        sql`${puzzles.themes} ?| array[${sql.join(
          opts.themes.map((theme) => sql`${theme}`),
          sql`, `
        )}]`
      );
    }
    const candidates = await db
      .select()
      .from(puzzles)
      .where(and(...conditions))
      .orderBy(sql`random()`)
      .limit(1);
    const puzzle = candidates[0];
    if (puzzle) {
      return {
        id: puzzle.id,
        fen: puzzle.fen,
        movesUci: puzzle.movesUci as string[],
        rating: puzzle.rating,
        themes: (puzzle.themes as string[]) ?? [],
      };
    }
  }
  throw new AccountError("no_puzzles", "No puzzles available — seed the puzzle set.", 503);
}

export interface AttemptResult {
  solved: boolean;
  rating: PuzzleRatingView;
  delta: number;
}

/** Records an attempt and applies the per-attempt Glicko-2 update. */
export async function recordPuzzleAttempt(
  db: Db,
  user: UserRow,
  input: { puzzleId: string; solved: boolean; timeMs?: number | null },
  now = new Date()
): Promise<AttemptResult> {
  const puzzle = (await db.select().from(puzzles).where(eq(puzzles.id, input.puzzleId)))[0];
  if (!puzzle) throw new AccountError("puzzle_missing", "No such puzzle.", 404);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`puzzle-rating:${user.id}`}))`);
    const existing = (
      await tx
        .select()
        .from(ratings)
        .where(
          and(
            eq(ratings.userId, user.id),
            eq(ratings.variant, "standard"),
            eq(ratings.timeControl, "puzzle")
          )
        )
    )[0];
    const current: Glicko2Rating = existing
      ? { rating: existing.rating, rd: existing.rd, volatility: existing.volatility }
      : newPlayerRating();
    const next = updateRating(current, [
      {
        opponentRating: puzzle.rating,
        opponentRd: Math.min(puzzle.ratingDeviation, 350),
        score: input.solved ? 1 : 0,
      },
    ]);
    await tx
      .insert(ratings)
      .values({
        userId: user.id,
        variant: "standard",
        timeControl: "puzzle",
        rating: next.rating,
        rd: next.rd,
        volatility: next.volatility,
        period: { pending: [] },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.variant, ratings.timeControl],
        set: {
          rating: next.rating,
          rd: next.rd,
          volatility: next.volatility,
          updatedAt: now,
        },
      });
    await tx.insert(puzzleAttempts).values({
      userId: user.id,
      puzzleId: input.puzzleId,
      solved: input.solved,
      timeMs: input.timeMs ?? null,
    });
    const attempts = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(puzzleAttempts)
      .where(eq(puzzleAttempts.userId, user.id));
    return {
      solved: input.solved,
      rating: {
        rating: next.rating,
        rd: next.rd,
        volatility: next.volatility,
        attempts: attempts[0]?.n ?? 0,
      },
      delta: next.rating - current.rating,
    };
  });
}
