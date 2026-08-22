import { eq } from "drizzle-orm";
import { games, plies } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { openingForGame } from "@/lib/chess/openings";
import {
  parseTimeControlTag,
  timeSpentFromClocks,
  type ReplayedGame,
} from "@/lib/chess/pgn-read";
import { GamePosition } from "@/lib/chess/position";

/**
 * Import persistence (Phase 2, C1): one game row + one plies row per
 * half-move, deduplicated on (userId, source, externalId). Plies land with
 * their move/FEN/clock fields immediately — timeSpentMs is computed here at
 * import (§9.3 needs it non-null wherever %clk exists) — and the analysis
 * pass fills the eval/classification fields later.
 */

export interface StoreGameMeta {
  source: "chesscom" | "lichess";
  externalId: string;
  pgn: string;
  whiteName: string;
  blackName: string;
  userColor: "white" | "black";
  timeControl: string | null;
  termination: string | null;
  playedAt: Date | null;
  ratedByPlatform: boolean;
}

export interface StoredGame {
  gameId: string;
  plyCount: number;
  duplicate: boolean;
}

export async function storeImportedGame(
  db: Db,
  userId: string,
  replayed: ReplayedGame,
  meta: StoreGameMeta
): Promise<StoredGame> {
  const timeControl = parseTimeControlTag(meta.timeControl ?? replayed.headers.TimeControl);
  const spent = timeSpentFromClocks(
    replayed.plies,
    timeControl?.baseMs ?? null,
    timeControl?.daily ? 0 : (timeControl?.incrementMs ?? 0)
  );

  let eco = replayed.headers.ECO ?? null;
  let openingName = replayed.headers.Opening ?? null;
  if (!eco && replayed.variant === "standard" && replayed.isDefaultStart) {
    const epds: string[] = [];
    const replay = GamePosition.fromFen(replayed.startFen, replayed.variant);
    for (const ply of replayed.plies.slice(0, 40)) {
      replay.moveUci(ply.uci);
      epds.push(replay.epd());
    }
    const match = openingForGame(epds);
    if (match) {
      eco = match.eco;
      openingName = match.name;
    }
  }

  const startPositionId = replayed.headers.StartPosition?.match(/^SP(\d+)$/)?.[1];

  const inserted = await db
    .insert(games)
    .values({
      userId,
      variant: replayed.variant,
      startFen: replayed.isDefaultStart && replayed.variant === "standard" ? null : replayed.startFen,
      startPositionId: startPositionId ? Number(startPositionId) : null,
      source: meta.source,
      externalId: meta.externalId,
      pgn: meta.pgn,
      whiteName: meta.whiteName,
      blackName: meta.blackName,
      userColor: meta.userColor,
      result: replayed.result,
      termination: meta.termination,
      timeControl: meta.timeControl,
      eco,
      opening: openingName,
      playedAt: meta.playedAt,
    })
    .onConflictDoNothing({ target: [games.userId, games.source, games.externalId] })
    .returning({ id: games.id });

  const game = inserted[0];
  if (!game) {
    return { gameId: "", plyCount: replayed.plies.length, duplicate: true };
  }

  const rows = replayed.plies.map((ply, i) => ({
    gameId: game.id,
    ply: ply.ply,
    moveNumber: ply.moveNumber,
    color: (ply.color === "w" ? "white" : "black") as "white" | "black",
    san: ply.san,
    uci: ply.uci,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter,
    clockMsRemaining: ply.clockMs,
    timeSpentMs: spent[i] ?? null,
  }));
  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(plies).values(rows.slice(i, i + 400));
  }
  return { gameId: game.id, plyCount: rows.length, duplicate: false };
}

/** Deletes a game's analysis rows so a re-run starts clean (dev/tooling). */
export async function deleteGamePlies(db: Db, gameId: string): Promise<void> {
  await db.delete(plies).where(eq(plies.gameId, gameId));
}
