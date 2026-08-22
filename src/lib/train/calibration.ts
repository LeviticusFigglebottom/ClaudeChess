import { and, desc, eq, inArray, isNotNull, sql, notInArray } from "drizzle-orm";
import { calibrationAttempts, games, plies, ratings } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { AccountError } from "@/lib/account/types";
import type { VariantId } from "@/lib/chess/variant";
import { bandsForRating, empiricalWhiteWp, fetchExplorerPosition } from "@/lib/explorer";
import { fetchAggregatePosition } from "@/lib/explorer/local";
import { openingForEpd, MAX_BOOK_PLY } from "@/lib/chess/openings";
import { computePositionTags, type PositionTags } from "./position-tags";

/**
 * §9.1 Eval Calibration Trainer. Positions come from the user's own games,
 * biased toward isCritical; the user predicts White's win probability
 * 0–100; scoring is the Brier analog (pred − actual)²/10000 against the
 * engine's WP, with the honest caveat surfaced in the UI and a SECONDARY
 * score against empirical explorer outcomes where the position is in-book.
 *
 * Population discipline (A1.4): every attempt records its variant and every
 * report filters on one — a 960 misjudgment and a standard misjudgment are
 * different populations.
 */

export interface CalibrationPosition {
  plyId: number;
  fen: string;
  variant: VariantId;
  isCritical: boolean;
  tags: PositionTags;
}

export async function nextCalibrationPosition(
  db: Db,
  userId: string,
  variant: VariantId = "standard"
): Promise<CalibrationPosition | null> {
  const recent = await db
    .select({ plyId: calibrationAttempts.plyId })
    .from(calibrationAttempts)
    .where(eq(calibrationAttempts.userId, userId))
    .orderBy(desc(calibrationAttempts.respondedAt))
    .limit(300);
  const excluded = recent.map((row) => row.plyId).filter((id): id is number => id !== null);

  // Bias toward critical positions (70/30), settle for any analyzed ply.
  const preferCritical = Math.random() < 0.7;
  for (const criticalOnly of preferCritical ? [true, false] : [false, true]) {
    const rows = await db
      .select({
        id: plies.id,
        fen: plies.fenBefore,
        isCritical: plies.isCritical,
      })
      .from(plies)
      .innerJoin(games, eq(plies.gameId, games.id))
      .where(
        and(
          eq(games.userId, userId),
          eq(plies.degraded, false),
          eq(games.variant, variant),
          isNotNull(plies.wpBefore),
          criticalOnly ? eq(plies.isCritical, true) : undefined,
          sql`${plies.ply} > 8`,
          excluded.length > 0 ? notInArray(plies.id, excluded) : undefined
        )
      )
      .orderBy(sql`random()`)
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        plyId: row.id,
        fen: row.fen,
        variant,
        isCritical: row.isCritical ?? false,
        tags: computePositionTags(row.fen),
      };
    }
  }
  return null;
}

export interface CalibrationReveal {
  engineWp: number;
  empiricalWp: number | null;
  squaredError: number;
  tags: PositionTags;
}

export async function recordCalibrationAttempt(
  db: Db,
  userId: string,
  input: { plyId: number; predictedWp: number }
): Promise<CalibrationReveal> {
  if (!Number.isFinite(input.predictedWp) || input.predictedWp < 0 || input.predictedWp > 100) {
    throw new AccountError("bad_prediction", "Prediction must be 0..100.");
  }
  const row = (
    await db
      .select({
        id: plies.id,
        fen: plies.fenBefore,
        ply: plies.ply,
        color: plies.color,
        wpBefore: plies.wpBefore,
        isCritical: plies.isCritical,
        variant: games.variant,
        gameUserId: games.userId,
      })
      .from(plies)
      .innerJoin(games, eq(plies.gameId, games.id))
      .where(eq(plies.id, input.plyId))
  )[0];
  if (!row || row.gameUserId !== userId) {
    throw new AccountError("not_found", "No such position.", 404);
  }
  if (row.wpBefore === null) throw new AccountError("unanalyzed", "Position not analyzed.");
  // Server recomputes truth — never trust a client-sent engine WP.
  const engineWp = row.color === "white" ? row.wpBefore : 100 - row.wpBefore;
  const tags = computePositionTags(row.fen);

  // Secondary empirical score where the position is in-book (standard only).
  let empiricalWp: number | null = null;
  if (row.variant === "standard" && row.ply <= MAX_BOOK_PLY) {
    const epd = row.fen.split(" ").slice(0, 4).join(" ");
    if (openingForEpd(epd) !== null) {
      try {
        const rating = await userRatingHint(db, userId);
        const opts = {
          speeds: ["blitz", "rapid", "classical"],
          ratings: bandsForRating(rating),
        };
        // Local aggregate first (Task 2b) — the live explorer is enrichment.
        const position =
          (await fetchAggregatePosition(db, row.fen, opts)) ??
          (await fetchExplorerPosition(db, row.fen, opts)).position;
        empiricalWp = empiricalWhiteWp(position);
      } catch {
        empiricalWp = null; // upstream down — the primary score stands alone
      }
    }
  }

  const squaredError = (input.predictedWp - engineWp) ** 2 / 10_000;
  await db.insert(calibrationAttempts).values({
    userId,
    fen: row.fen,
    variant: row.variant as VariantId,
    plyId: row.id,
    positionTags: tags,
    predictedWp: input.predictedWp,
    actualWp: engineWp,
    empiricalWp,
    squaredError,
    isCritical: row.isCritical ?? false,
  });
  return { engineWp, empiricalWp, squaredError, tags };
}

export interface CalibrationReport {
  n: number;
  meanBrier: number | null;
  /** Mean Brier vs the empirical outcome, over attempts where it existed. */
  empirical: { n: number; meanBrier: number | null };
  /** Decile curve: mean prediction vs mean engine WP per prediction decile. */
  curve: { decile: number; n: number; meanPrediction: number; meanActual: number }[];
  /** Signed mean error (pred − actual) per tag value — the §9.1 headline. */
  biasByTag: { tag: string; value: string; n: number; signedError: number }[];
  /** Murphy decomposition of the Brier score over prediction deciles. */
  decomposition: { reliability: number; resolution: number; uncertainty: number } | null;
}

export async function calibrationReport(
  db: Db,
  userId: string,
  variant: VariantId = "standard"
): Promise<CalibrationReport> {
  const attempts = await db
    .select()
    .from(calibrationAttempts)
    .where(and(eq(calibrationAttempts.userId, userId), eq(calibrationAttempts.variant, variant)))
    .orderBy(desc(calibrationAttempts.respondedAt))
    .limit(2000);
  const n = attempts.length;
  if (n === 0) {
    return {
      n: 0,
      meanBrier: null,
      empirical: { n: 0, meanBrier: null },
      curve: [],
      biasByTag: [],
      decomposition: null,
    };
  }
  const meanBrier = attempts.reduce((sum, a) => sum + a.squaredError, 0) / n;

  const withEmpirical = attempts.filter((a) => a.empiricalWp !== null);
  const empirical = {
    n: withEmpirical.length,
    meanBrier:
      withEmpirical.length > 0
        ? withEmpirical.reduce(
            (sum, a) => sum + (a.predictedWp - (a.empiricalWp as number)) ** 2 / 10_000,
            0
          ) / withEmpirical.length
        : null,
  };

  // Decile curve + Murphy decomposition over the same bins (outcomes are
  // the engine WP scaled to 0..1 — continuous-outcome decomposition).
  const bins = new Map<number, { pred: number[]; actual: number[] }>();
  for (const attempt of attempts) {
    const decile = Math.min(9, Math.floor(attempt.predictedWp / 10));
    const bin = bins.get(decile) ?? { pred: [], actual: [] };
    bin.pred.push(attempt.predictedWp);
    bin.actual.push(attempt.actualWp);
    bins.set(decile, bin);
  }
  const curve = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decile, bin]) => ({
      decile,
      n: bin.pred.length,
      meanPrediction: mean(bin.pred),
      meanActual: mean(bin.actual),
    }));
  const overallActual = mean(attempts.map((a) => a.actualWp)) / 100;
  let reliability = 0;
  let resolution = 0;
  for (const bin of bins.values()) {
    const weight = bin.pred.length / n;
    const predMean = mean(bin.pred) / 100;
    const actualMean = mean(bin.actual) / 100;
    reliability += weight * (predMean - actualMean) ** 2;
    resolution += weight * (actualMean - overallActual) ** 2;
  }
  // Continuous-outcome Murphy: MSE = reliability − resolution + uncertainty,
  // uncertainty being the variance of the engine-WP outcomes themselves.
  const uncertainty = mean(attempts.map((a) => (a.actualWp / 100 - overallActual) ** 2));

  // Signed bias per tag value (only tags with categorical values).
  const biasBuckets = new Map<string, { sum: number; n: number }>();
  for (const attempt of attempts) {
    const tags = attempt.positionTags ?? {};
    for (const [tag, value] of Object.entries(tags)) {
      if (typeof value === "number") continue;
      const key = `${tag}:${String(value)}`;
      const bucket = biasBuckets.get(key) ?? { sum: 0, n: 0 };
      bucket.sum += attempt.predictedWp - attempt.actualWp;
      bucket.n += 1;
      biasBuckets.set(key, bucket);
    }
  }
  const biasByTag = [...biasBuckets.entries()]
    .map(([key, bucket]) => {
      const [tag, ...rest] = key.split(":");
      return {
        tag: tag!,
        value: rest.join(":"),
        n: bucket.n,
        signedError: bucket.sum / bucket.n,
      };
    })
    .filter((row) => row.n >= 5)
    .sort((a, b) => Math.abs(b.signedError) - Math.abs(a.signedError));

  return {
    n,
    meanBrier,
    empirical,
    curve,
    biasByTag,
    decomposition: { reliability, resolution, uncertainty },
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** The user's standard blitz/rapid rating, for explorer bands (1500 fallback). */
export async function userRatingHint(db: Db, userId: string): Promise<number> {
  const rows = await db
    .select({ rating: ratings.rating, updatedAt: ratings.updatedAt })
    .from(ratings)
    .where(
      and(
        eq(ratings.userId, userId),
        eq(ratings.variant, "standard"),
        inArray(ratings.timeControl, ["blitz", "rapid"])
      )
    )
    .orderBy(desc(ratings.updatedAt))
    .limit(1);
  const rating = rows[0]?.rating;
  return typeof rating === "number" && Number.isFinite(rating) ? Math.round(rating) : 1500;
}
