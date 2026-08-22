import { and, eq, ne, sql } from "drizzle-orm";
import { matchmakingQueue, ratings } from "@/db/schema";
import { canPair } from "@/lib/account/relationships";
import { AccountError, isVerified, type Db, type UserRow } from "@/lib/account/types";
import { PLAYABLE_VARIANTS, type VariantId } from "@/lib/chess/variant";
import { bucketOf, createLiveGame, validateClockSpec, type LiveClockSpec } from "./live";

/**
 * Matchmaking (§8): pool keyed by (variant, clock, rated); the rating window
 * starts at ±100 and widens 50 points per 10 seconds queued (capped ±800).
 * Every candidate pairing MUST pass the Phase 1.5 canPair guard — blocked
 * pairs never match. Rated queues require verified accounts (A2.1).
 */

function windowFor(enqueuedAt: Date, now: number): number {
  const waited = Math.max(0, now - enqueuedAt.getTime());
  return Math.min(800, 100 + 50 * Math.floor(waited / 10_000));
}

export interface QueueSpec {
  variant: VariantId;
  clock: LiveClockSpec;
  rated: boolean;
}

export async function joinQueue(
  db: Db,
  user: UserRow,
  spec: QueueSpec
): Promise<{ queued: boolean; gameId: string | null }> {
  if (!PLAYABLE_VARIANTS.includes(spec.variant)) {
    // Crazyhouse has no drop UI yet (B1.1) — refusing beats a broken board.
    throw new AccountError("variant", "That variant is not playable yet.");
  }
  const clock = validateClockSpec(spec.clock);
  if (spec.rated && !isVerified(user)) {
    throw new AccountError(
      "verified_required",
      "Rated multiplayer requires a verified account (A2.1).",
      403
    );
  }
  const bucket = bucketOf({
    clockMode: clock.mode,
    clockInitialMs: clock.initialMs,
    clockIncrementMs: clock.incrementMs,
  });
  const ratingRow = (
    await db
      .select()
      .from(ratings)
      .where(
        and(
          eq(ratings.userId, user.id),
          eq(ratings.variant, spec.variant),
          eq(ratings.timeControl, bucket)
        )
      )
  )[0];
  await db
    .insert(matchmakingQueue)
    .values({
      userId: user.id,
      variant: spec.variant,
      clockMode: clock.mode,
      clockInitialMs: clock.initialMs,
      clockIncrementMs: clock.incrementMs,
      rated: spec.rated,
      bucket,
      rating: ratingRow?.rating ?? 1500,
    })
    .onConflictDoUpdate({
      target: matchmakingQueue.userId,
      set: {
        variant: spec.variant,
        clockMode: clock.mode,
        clockInitialMs: clock.initialMs,
        clockIncrementMs: clock.incrementMs,
        rated: spec.rated,
        bucket,
        rating: ratingRow?.rating ?? 1500,
        enqueuedAt: new Date(),
      },
    });
  const gameId = await tryPair(db, user.id);
  return { queued: gameId === null, gameId };
}

export async function leaveQueue(db: Db, userId: string): Promise<void> {
  await db.delete(matchmakingQueue).where(eq(matchmakingQueue.userId, userId));
}

export async function queueStatus(db: Db, userId: string): Promise<{ queued: boolean }> {
  const rows = await db
    .select({ userId: matchmakingQueue.userId })
    .from(matchmakingQueue)
    .where(eq(matchmakingQueue.userId, userId));
  return { queued: rows.length > 0 };
}

/**
 * Attempts to pair `userId` with the longest-waiting compatible candidate.
 * Serialized with an advisory lock per pool so two concurrent joiners cannot
 * double-match. Returns the created game id, or null.
 */
export async function tryPair(db: Db, userId: string, now = Date.now()): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('matchmaking'))`);
    const me = (
      await tx.select().from(matchmakingQueue).where(eq(matchmakingQueue.userId, userId))
    )[0];
    if (!me) return null;
    const candidates = await tx
      .select()
      .from(matchmakingQueue)
      .where(
        and(
          ne(matchmakingQueue.userId, userId),
          eq(matchmakingQueue.variant, me.variant),
          eq(matchmakingQueue.clockMode, me.clockMode),
          eq(matchmakingQueue.clockInitialMs, me.clockInitialMs),
          eq(matchmakingQueue.clockIncrementMs, me.clockIncrementMs),
          eq(matchmakingQueue.rated, me.rated)
        )
      )
      .orderBy(matchmakingQueue.enqueuedAt);
    for (const candidate of candidates) {
      const gap = Math.abs(candidate.rating - me.rating);
      if (gap > windowFor(me.enqueuedAt, now) || gap > windowFor(candidate.enqueuedAt, now)) {
        continue;
      }
      // The Phase 1.5 block guard — matchmaking MUST call it.
      if (!(await canPair(tx, me.userId, candidate.userId))) continue;

      const removed = await tx
        .delete(matchmakingQueue)
        .where(
          sql`${matchmakingQueue.userId} in (${me.userId}, ${candidate.userId})`
        )
        .returning({ userId: matchmakingQueue.userId });
      if (removed.length !== 2) return null; // raced — bail, next poll retries
      const whiteFirst = Math.random() < 0.5;
      const game = await createLiveGame(tx, {
        whiteUserId: whiteFirst ? me.userId : candidate.userId,
        blackUserId: whiteFirst ? candidate.userId : me.userId,
        variant: me.variant as VariantId,
        clock: {
          mode: me.clockMode as LiveClockSpec["mode"],
          initialMs: me.clockInitialMs,
          incrementMs: me.clockIncrementMs,
        },
        rated: me.rated,
      });
      return game.id;
    }
    return null;
  });
}
