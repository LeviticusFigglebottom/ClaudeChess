import { asc, desc, eq } from "drizzle-orm";
import { fairplayFlags, games, liveGameEvents, liveGames, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";

/**
 * Fair-play signals (A2.3, B0.5): collected for RATED games only, written to
 * fairplay_flags, never auto-acted-on, and — the B0.5 differentiator —
 * visible to the user about THEMSELVES on their account page. Three sources:
 *
 *  - movetime entropy at game end (humans think in wildly variable time;
 *    near-constant per-move time with strong play is the loudest signal);
 *  - tab-blur counts during rated games (recorded, never blocking);
 *  - engine correlation + accuracy outlier, computed when a rated online
 *    game passes through the Phase 2 analysis pipeline (it is free there).
 */

type LiveRow = typeof liveGames.$inferSelect;

export interface OwnFairplaySignal {
  id: string;
  gameId: string | null;
  signal: string;
  score: number;
  createdAt: string;
}

/**
 * A user's own signals (B0.5 transparency): the flags are about them, so
 * they can see them. Nobody else's flags are ever readable this way.
 */
export async function listOwnFairplayFlags(db: Db, userId: string): Promise<OwnFairplaySignal[]> {
  const rows = await db
    .select()
    .from(fairplayFlags)
    .where(eq(fairplayFlags.userId, userId))
    .orderBy(desc(fairplayFlags.createdAt))
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    gameId: row.gameId,
    signal: row.signal,
    score: row.score,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Coefficient of variation of per-move think times, per player. */
export function movetimeCv(spentsMs: number[]): number | null {
  const spents = spentsMs.filter((ms) => ms >= 0);
  if (spents.length < 10) return null;
  const mean = spents.reduce((a, b) => a + b, 0) / spents.length;
  if (mean <= 0) return null;
  const variance = spents.reduce((a, b) => a + (b - mean) ** 2, 0) / spents.length;
  return Math.sqrt(variance) / mean;
}

export async function computeMovetimeEntropy(tx: Db, row: LiveRow): Promise<void> {
  if (!row.rated || row.clockMode === "daily") return;
  const trail = (row.clockTrailJson as number[]) ?? [];
  if (trail.length < 20) return;
  const increment = row.clockIncrementMs;
  // trail[i] = mover's remaining AFTER move i; alternating white/black.
  const perColor: Record<"white" | "black", number[]> = { white: [], black: [] };
  const last: Record<"white" | "black", number> = {
    white: row.clockInitialMs,
    black: row.clockInitialMs,
  };
  trail.forEach((after, index) => {
    const color = index % 2 === 0 ? "white" : "black";
    perColor[color].push(Math.max(0, last[color] - after + increment));
    last[color] = after;
  });
  // Tab-blur counts from the event log.
  const events = await tx
    .select()
    .from(liveGameEvents)
    .where(eq(liveGameEvents.gameId, row.id))
    .orderBy(asc(liveGameEvents.seq));
  const blurs: Record<"white" | "black", number> = { white: 0, black: 0 };
  for (const event of events) {
    if (event.type === "blur") {
      const by = (event.payload as { by?: string })?.by;
      if (by === "white" || by === "black") blurs[by]++;
    }
  }

  for (const [color, userId] of [
    ["white", row.whiteUserId],
    ["black", row.blackUserId],
  ] as const) {
    const cv = movetimeCv(perColor[color]);
    if (cv !== null) {
      await tx.insert(fairplayFlags).values({
        userId,
        gameId: null, // archived game ids are per-user; the live id is in meta
        signal: "movetime_entropy",
        score: Number(cv.toFixed(3)),
      });
    }
    if (blurs[color] > 0) {
      await tx.insert(fairplayFlags).values({
        userId,
        gameId: null,
        signal: "tab_blur",
        score: blurs[color],
      });
    }
  }
}

/**
 * Analysis-time signals for a rated ONLINE game: engine top-1 correlation
 * for the game's owner and their §4.5 accuracy, flagged as an outlier
 * against their trailing distribution. Called from the Phase 2 finalize
 * pass — the data is already there (A2.3: "you already compute this").
 */
export async function computeAnalysisSignals(db: Db, gameId: string): Promise<void> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game || game.source !== "online") return;
  if (!game.pgn.includes("GAMBIT rated game")) return; // rated-only (A2.3)
  const rows = await db
    .select()
    .from(plies)
    .where(eq(plies.gameId, gameId))
    .orderBy(asc(plies.ply));
  const own = rows.filter(
    (row) => row.color === game.userColor && row.wpBefore !== null && row.bestMoveUci
  );
  if (own.length < 15) return;
  const matches = own.filter((row) => row.uci === row.bestMoveUci).length;
  const correlation = matches / own.length;
  await db.insert(fairplayFlags).values({
    userId: game.userId,
    gameId,
    signal: "engine_correlation",
    score: Number(correlation.toFixed(3)),
  });

  const accuracy =
    own.reduce(
      (sum, row) =>
        sum + Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, row.wpLoss ?? 0)) - 3.1669)),
      0
    ) / own.length;
  // Trailing distribution: previous engine_correlation-accompanied accuracies
  // live in fairplay rows; keep it simple — store the accuracy signal and let
  // the account view mark >3σ outliers against the user's own history.
  await db.insert(fairplayFlags).values({
    userId: game.userId,
    gameId,
    signal: "accuracy",
    score: Number(accuracy.toFixed(2)),
  });
}
