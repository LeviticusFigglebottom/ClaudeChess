import { and, desc, eq, sql } from "drizzle-orm";
import { games, ratings } from "@/db/schema";
import { isVariantId, type VariantId } from "@/lib/chess/variant";
import { newPlayerRating, type GameResult } from "@/lib/rating/glicko2";
import {
  addResult,
  createPeriodState,
  settleIfDue,
  type PendingResult,
  type RatingPeriodState,
} from "@/lib/rating/period";
import { AccountError, type Db, type UserRow } from "./types";

/**
 * Game persistence + server-side ratings (Phase 1.5). Bot games save to
 * `games` under the (possibly anonymous) user — which is exactly what makes
 * the anonymous→permanent conversion preserve history: the rows never move.
 *
 * Ratings: the server holds the authoritative Glicko-2 period state per
 * (variant, time-control bucket) using the SAME period module the client
 * uses (spec §7 — batched closes, never per game). The client's localStorage
 * copy is an offline cache that server responses overwrite.
 */

export type TimeControlBucket = "bullet" | "blitz" | "rapid" | "classical" | "daily";

const BUCKETS: readonly TimeControlBucket[] = ["bullet", "blitz", "rapid", "classical", "daily"];

export interface SaveGamePayload {
  variant: string;
  startFen?: string | null;
  startPositionId?: number | null;
  pgn: string;
  whiteName: string;
  blackName: string;
  userColor: "white" | "black";
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  termination?: string | null;
  /** Raw time control string, e.g. "300+3". */
  timeControl?: string | null;
  eco?: string | null;
  opening?: string | null;
  playedAt?: string | null;
  rated?: {
    bucket: TimeControlBucket;
    opponentRating: number;
    opponentRd: number;
    score: 0 | 0.5 | 1;
  } | null;
}

export interface RatingStateView {
  variant: VariantId;
  bucket: TimeControlBucket;
  state: RatingPeriodState;
  updatedAt: string;
}

function validatePayload(payload: SaveGamePayload): VariantId {
  if (!isVariantId(payload.variant)) throw new AccountError("variant", "Unknown variant.");
  if (payload.variant === "chess960" && !payload.startFen) {
    throw new AccountError("start_fen", "Chess960 games must carry their start FEN.");
  }
  if (typeof payload.pgn !== "string" || payload.pgn.length === 0 || payload.pgn.length > 100_000) {
    throw new AccountError("pgn", "PGN missing or too large.");
  }
  if (!["1-0", "0-1", "1/2-1/2", "*"].includes(payload.result)) {
    throw new AccountError("result", "Bad result.");
  }
  if (!["white", "black"].includes(payload.userColor)) {
    throw new AccountError("user_color", "Bad user color.");
  }
  for (const name of [payload.whiteName, payload.blackName]) {
    if (typeof name !== "string" || name.length === 0 || name.length > 80) {
      throw new AccountError("names", "Player names must be 1–80 characters.");
    }
  }
  if (payload.rated) {
    if (!BUCKETS.includes(payload.rated.bucket)) {
      throw new AccountError("bucket", "Bad time-control bucket.");
    }
    if (![0, 0.5, 1].includes(payload.rated.score)) {
      throw new AccountError("score", "Bad score.");
    }
    const { opponentRating, opponentRd } = payload.rated;
    if (
      !Number.isFinite(opponentRating) ||
      opponentRating < 100 ||
      opponentRating > 4000 ||
      !Number.isFinite(opponentRd) ||
      opponentRd < 10 ||
      opponentRd > 500
    ) {
      throw new AccountError("opponent", "Bad opponent rating parameters.");
    }
  }
  return payload.variant;
}

function rowToState(row: typeof ratings.$inferSelect): RatingPeriodState {
  return {
    rating: { rating: row.rating, rd: row.rd, volatility: row.volatility },
    pending: ((row.period?.pending ?? []) as PendingResult[]).filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Number.isFinite(entry.opponentRating) &&
        Number.isFinite(entry.at)
    ),
  };
}

/**
 * Records a rated result into the server period state. Serialized per rating
 * key with an advisory transaction lock; settle rules identical to the
 * client because it IS the client's module.
 */
export async function recordRatedResult(
  db: Db,
  userId: string,
  variant: VariantId,
  bucket: TimeControlBucket,
  result: GameResult,
  now: Date = new Date()
): Promise<RatingPeriodState> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`rating:${userId}:${variant}:${bucket}`}))`
    );
    const rows = await tx
      .select()
      .from(ratings)
      .where(
        and(
          eq(ratings.userId, userId),
          eq(ratings.variant, variant),
          eq(ratings.timeControl, bucket)
        )
      )
      .limit(1);
    const state = rows[0] ? rowToState(rows[0]) : createPeriodState(newPlayerRating());
    const next = addResult(state, result, now.getTime());
    await tx
      .insert(ratings)
      .values({
        userId,
        variant,
        timeControl: bucket,
        rating: next.rating.rating,
        rd: next.rating.rd,
        volatility: next.rating.volatility,
        period: { pending: next.pending },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [ratings.userId, ratings.variant, ratings.timeControl],
        set: {
          rating: next.rating.rating,
          rd: next.rating.rd,
          volatility: next.rating.volatility,
          period: { pending: next.pending },
          updatedAt: now,
        },
      });
    return next;
  });
}

/** Reads all rating states, settling any 7-day-due period on the way out. */
export async function getRatingStates(
  db: Db,
  userId: string,
  now: Date = new Date()
): Promise<RatingStateView[]> {
  const rows = await db.select().from(ratings).where(eq(ratings.userId, userId));
  const out: RatingStateView[] = [];
  for (const row of rows) {
    const state = rowToState(row);
    const settled = settleIfDue(state, now.getTime());
    if (settled !== state) {
      await db
        .update(ratings)
        .set({
          rating: settled.rating.rating,
          rd: settled.rating.rd,
          volatility: settled.rating.volatility,
          period: { pending: settled.pending },
          updatedAt: now,
        })
        .where(
          and(
            eq(ratings.userId, userId),
            eq(ratings.variant, row.variant),
            eq(ratings.timeControl, row.timeControl)
          )
        );
    }
    out.push({
      variant: row.variant,
      bucket: row.timeControl,
      state: settled,
      updatedAt: (settled !== state ? now : row.updatedAt).toISOString(),
    });
  }
  return out;
}

/**
 * Bootstrap seeding: fills rating keys the server has never seen from the
 * device's localStorage cache (an anonymous device's pre-account history).
 * Existing server rows always win — seeding never overwrites.
 */
export async function seedRatings(
  db: Db,
  userId: string,
  states: { variant: string; bucket: string; state: RatingPeriodState }[],
  now: Date = new Date()
): Promise<number> {
  let seeded = 0;
  for (const entry of states.slice(0, 40)) {
    if (!isVariantId(entry.variant)) continue;
    if (!BUCKETS.includes(entry.bucket as TimeControlBucket)) continue;
    const { rating } = entry.state;
    if (
      !rating ||
      !Number.isFinite(rating.rating) ||
      !Number.isFinite(rating.rd) ||
      !Number.isFinite(rating.volatility) ||
      rating.rating < 100 ||
      rating.rating > 4000
    ) {
      continue;
    }
    const pending = Array.isArray(entry.state.pending) ? entry.state.pending.slice(0, 24) : [];
    const inserted = await db
      .insert(ratings)
      .values({
        userId,
        variant: entry.variant,
        timeControl: entry.bucket as TimeControlBucket,
        rating: rating.rating,
        rd: rating.rd,
        volatility: rating.volatility,
        period: { pending },
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) seeded++;
  }
  return seeded;
}

export interface SaveGameResult {
  gameId: string;
  rating: RatingStateView | null;
}

export async function saveBotGame(
  db: Db,
  user: UserRow,
  payload: SaveGamePayload,
  now: Date = new Date()
): Promise<SaveGameResult> {
  const variant = validatePayload(payload);
  const inserted = await db
    .insert(games)
    .values({
      userId: user.id,
      variant,
      startFen: payload.startFen ?? null,
      startPositionId: payload.startPositionId ?? null,
      source: "local",
      pgn: payload.pgn,
      whiteName: payload.whiteName,
      blackName: payload.blackName,
      userColor: payload.userColor,
      result: payload.result,
      termination: payload.termination ?? null,
      timeControl: payload.timeControl ?? null,
      eco: payload.eco ?? null,
      opening: payload.opening ?? null,
      playedAt: payload.playedAt ? new Date(payload.playedAt) : now,
      importedAt: now,
    })
    .returning();
  const game = inserted[0];
  if (!game) throw new AccountError("game_insert", "Insert returned no row.", 500);

  let ratingView: RatingStateView | null = null;
  if (payload.rated) {
    const state = await recordRatedResult(
      db,
      user.id,
      variant,
      payload.rated.bucket,
      {
        opponentRating: payload.rated.opponentRating,
        opponentRd: payload.rated.opponentRd,
        score: payload.rated.score,
      },
      now
    );
    ratingView = {
      variant,
      bucket: payload.rated.bucket,
      state,
      updatedAt: now.toISOString(),
    };
  }
  return { gameId: game.id, rating: ratingView };
}

export async function listGames(
  db: Db,
  userId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  return db
    .select({
      id: games.id,
      variant: games.variant,
      source: games.source,
      whiteName: games.whiteName,
      blackName: games.blackName,
      userColor: games.userColor,
      result: games.result,
      termination: games.termination,
      timeControl: games.timeControl,
      eco: games.eco,
      opening: games.opening,
      isStudy: games.isStudy,
      playedAt: games.playedAt,
      plyCount: sql<number>`(select count(*)::int from plies p where p.game_id = games.id)`,
      analyzedCount: sql<number>`(select count(*)::int from plies p where p.game_id = games.id and p.wp_before is not null)`,
      errorCount: sql<number>`(select count(*)::int from plies p where p.game_id = games.id and p.classification in ('MISTAKE','BLUNDER','MISS') and p.color = games.user_color)`,
    })
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.playedAt))
    .limit(limit)
    .offset(offset);
}
