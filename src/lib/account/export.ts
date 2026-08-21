import { desc, eq, inArray } from "drizzle-orm";
import {
  blunderTags,
  calibrationAttempts,
  games,
  plies,
  postmortemResponses,
  puzzleAttempts,
  ratings,
} from "@/db/schema";
import { AccountError, type Db } from "./types";
import { getUser } from "./users";

/**
 * Data export (A2.4): the full PGN archive plus JSON of every analysis row.
 * We import from chess.com and Lichess; the bar is to be at least as open as
 * they are about giving the data back.
 */
export interface AccountExport {
  exportedAt: string;
  user: {
    id: string;
    handle: string;
    email: string | null;
    displayName: string | null;
    countryCode: string | null;
    bio: string | null;
    title: string | null;
    tier: string;
    createdAt: string;
  };
  prefs: Record<string, unknown> | null;
  ratings: unknown[];
  games: unknown[];
  /** Every game's PGN concatenated — a valid multi-game .pgn file. */
  pgnArchive: string;
  puzzleAttempts: unknown[];
  calibrationAttempts: unknown[];
  postmortemResponses: unknown[];
}

export async function exportAccount(db: Db, userId: string): Promise<AccountExport> {
  const user = await getUser(db, userId);
  if (!user) throw new AccountError("user_missing", "No such account.", 404);

  const userGames = await db
    .select()
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.playedAt));
  const gameIds = userGames.map((game) => game.id);

  const gamePlies = gameIds.length
    ? await db.select().from(plies).where(inArray(plies.gameId, gameIds))
    : [];
  const plyIds = gamePlies.map((ply) => ply.id);
  const tags = plyIds.length
    ? await db.select().from(blunderTags).where(inArray(blunderTags.plyId, plyIds))
    : [];

  const pliesByGame = new Map<string, typeof gamePlies>();
  for (const ply of gamePlies) {
    const list = pliesByGame.get(ply.gameId) ?? [];
    list.push(ply);
    pliesByGame.set(ply.gameId, list);
  }
  const tagsByPly = new Map<number, typeof tags>();
  for (const tag of tags) {
    const list = tagsByPly.get(tag.plyId) ?? [];
    list.push(tag);
    tagsByPly.set(tag.plyId, list);
  }

  const [ratingRows, attempts, calibration, postmortems] = await Promise.all([
    db.select().from(ratings).where(eq(ratings.userId, userId)),
    db.select().from(puzzleAttempts).where(eq(puzzleAttempts.userId, userId)),
    db.select().from(calibrationAttempts).where(eq(calibrationAttempts.userId, userId)),
    db.select().from(postmortemResponses).where(eq(postmortemResponses.userId, userId)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      handle: user.handle,
      email: user.email,
      displayName: user.displayName,
      countryCode: user.countryCode,
      bio: user.bio,
      title: user.title,
      tier: user.tier,
      createdAt: user.createdAt.toISOString(),
    },
    prefs: user.prefs ?? null,
    ratings: ratingRows,
    games: userGames.map((game) => ({
      ...game,
      plies: (pliesByGame.get(game.id) ?? [])
        .sort((a, b) => a.ply - b.ply)
        .map((ply) => ({
          ...ply,
          blunderTags: tagsByPly.get(ply.id) ?? [],
        })),
    })),
    pgnArchive: userGames
      .map((game) => game.pgn.trim())
      .filter(Boolean)
      .join("\n\n"),
    puzzleAttempts: attempts,
    calibrationAttempts: calibration,
    postmortemResponses: postmortems,
  };
}
