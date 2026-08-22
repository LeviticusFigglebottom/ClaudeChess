import { and, desc, eq, isNotNull, sql, notInArray } from "drizzle-orm";
import { games, plies, tempoAttempts } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { AccountError } from "@/lib/account/types";
import type { VariantId } from "@/lib/chess/variant";

/**
 * §9.3 Time Allocation. Everything derives from timeSpentMs (%clk deltas,
 * stored at import/game end) and wpLoss, split by the stored isCritical
 * flag. Variant-filtered per A1.4.
 *
 *  - personal response curve: mean wpLoss per log2(seconds) bucket, fitted
 *    separately for critical and non-critical plies;
 *  - flat point: the first bucket past which more time stops buying
 *    accuracy on NON-critical moves (improvement < 0.5 wp per doubling);
 *  - misallocation: seconds/game spent beyond the flat point on
 *    non-critical moves — the number that changes behavior;
 *  - recognition trainer: 3-second critical/routine calls scored against
 *    the computed flag.
 */

export interface TempoCurvePoint {
  /** Bucket lower bound in seconds (log2 scale: 1,2,4,8,…). */
  fromSeconds: number;
  n: number;
  meanWpLoss: number;
}

export interface TempoReport {
  n: number;
  gamesCovered: number;
  curveCritical: TempoCurvePoint[];
  curveRoutine: TempoCurvePoint[];
  /** Seconds beyond which extra think time stopped helping on routine moves. */
  flatPointSeconds: number | null;
  /** §9.3 headline: wasted seconds per game past the flat point. */
  misallocationSecondsPerGame: number | null;
  /** Recognition-trainer accuracy over time (last 200 rounds). */
  recognition: { n: number; accuracy: number | null; meanAnswerMs: number | null };
}

function bucketOf(seconds: number): number {
  if (seconds < 1) return 0;
  return 2 ** Math.floor(Math.log2(seconds));
}

function curveFrom(rows: { timeSpentMs: number; wpLoss: number }[]): TempoCurvePoint[] {
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const row of rows) {
    const bucket = bucketOf(row.timeSpentMs / 1000);
    const entry = buckets.get(bucket) ?? { sum: 0, n: 0 };
    entry.sum += row.wpLoss;
    entry.n += 1;
    buckets.set(bucket, entry);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fromSeconds, { sum, n }]) => ({ fromSeconds, n, meanWpLoss: sum / n }));
}

/** First bucket where a doubling of time buys < 0.5 wp on routine moves. */
export function flatPointOf(curve: TempoCurvePoint[]): number | null {
  const solid = curve.filter((point) => point.n >= 20);
  for (let i = 1; i < solid.length; i++) {
    const gain = solid[i - 1]!.meanWpLoss - solid[i]!.meanWpLoss;
    if (gain < 0.5) return solid[i - 1]!.fromSeconds;
  }
  return null;
}

export async function tempoReport(
  db: Db,
  userId: string,
  variant: VariantId = "standard"
): Promise<TempoReport> {
  const rows = await db
    .select({
      timeSpentMs: plies.timeSpentMs,
      wpLoss: plies.wpLoss,
      isCritical: plies.isCritical,
      gameId: plies.gameId,
      color: plies.color,
      userColor: games.userColor,
    })
    .from(plies)
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(
      and(
        eq(games.userId, userId),
        eq(games.variant, variant),
        isNotNull(plies.timeSpentMs),
        isNotNull(plies.wpLoss)
      )
    );
  // Only the user's OWN moves — the opponent's clock habits are noise.
  const own = rows.filter((row) => row.userColor === null || row.color === row.userColor);
  const critical = own.filter((row) => row.isCritical);
  const routine = own.filter((row) => !row.isCritical);
  const curveCritical = curveFrom(
    critical.map((row) => ({ timeSpentMs: row.timeSpentMs!, wpLoss: row.wpLoss! }))
  );
  const curveRoutine = curveFrom(
    routine.map((row) => ({ timeSpentMs: row.timeSpentMs!, wpLoss: row.wpLoss! }))
  );
  const flatPointSeconds = flatPointOf(curveRoutine);

  let misallocationSecondsPerGame: number | null = null;
  const gamesCovered = new Set(own.map((row) => row.gameId)).size;
  if (flatPointSeconds !== null && gamesCovered > 0) {
    const wasted = routine.reduce((sum, row) => {
      const seconds = row.timeSpentMs! / 1000;
      return sum + Math.max(0, seconds - flatPointSeconds);
    }, 0);
    misallocationSecondsPerGame = wasted / gamesCovered;
  }

  const attempts = await db
    .select()
    .from(tempoAttempts)
    .where(eq(tempoAttempts.userId, userId))
    .orderBy(desc(tempoAttempts.respondedAt))
    .limit(200);
  const recognition = {
    n: attempts.length,
    accuracy:
      attempts.length > 0
        ? attempts.filter((a) => a.guessedCritical === a.actualCritical).length / attempts.length
        : null,
    meanAnswerMs:
      attempts.length > 0
        ? attempts.reduce((sum, a) => sum + a.answeredInMs, 0) / attempts.length
        : null,
  };

  return {
    n: own.length,
    gamesCovered,
    curveCritical,
    curveRoutine,
    flatPointSeconds,
    misallocationSecondsPerGame,
    recognition,
  };
}

/** A position for the recognition round — the flag stays server-side. */
export async function nextRecognitionPosition(
  db: Db,
  userId: string,
  variant: VariantId = "standard"
): Promise<{ plyId: number; fen: string } | null> {
  const recent = await db
    .select({ plyId: tempoAttempts.plyId })
    .from(tempoAttempts)
    .where(eq(tempoAttempts.userId, userId))
    .orderBy(desc(tempoAttempts.respondedAt))
    .limit(300);
  const excluded = recent.map((row) => row.plyId);
  // Half critical, half routine, so "always routine" scores 50%.
  const wantCritical = Math.random() < 0.5;
  const rows = await db
    .select({ plyId: plies.id, fen: plies.fenBefore })
    .from(plies)
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(
      and(
        eq(games.userId, userId),
        eq(games.variant, variant),
        isNotNull(plies.wpBefore),
        eq(plies.isCritical, wantCritical),
        sql`${plies.ply} > 8`,
        excluded.length > 0 ? notInArray(plies.id, excluded) : undefined
      )
    )
    .orderBy(sql`random()`)
    .limit(1);
  return rows[0] ?? null;
}

export async function recordRecognitionAttempt(
  db: Db,
  userId: string,
  input: { plyId: number; guessedCritical: boolean; answeredInMs: number }
): Promise<{ actualCritical: boolean; correct: boolean }> {
  const row = (
    await db
      .select({ id: plies.id, isCritical: plies.isCritical, gameUserId: games.userId })
      .from(plies)
      .innerJoin(games, eq(plies.gameId, games.id))
      .where(eq(plies.id, input.plyId))
  )[0];
  if (!row || row.gameUserId !== userId) throw new AccountError("not_found", "No such position.", 404);
  const actualCritical = row.isCritical ?? false;
  await db.insert(tempoAttempts).values({
    userId,
    plyId: input.plyId,
    guessedCritical: input.guessedCritical,
    actualCritical,
    answeredInMs: Math.max(0, Math.min(60_000, Math.round(input.answeredInMs))),
  });
  return { actualCritical, correct: input.guessedCritical === actualCritical };
}
