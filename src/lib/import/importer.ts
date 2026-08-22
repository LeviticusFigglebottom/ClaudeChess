import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { linkedAccounts, users } from "@/db/schema";
import { AccountError, type Db, type UserRow } from "@/lib/account/types";
import { parseMultiPgn, replayPgnGame, variantFromHeader } from "@/lib/chess/pgn-read";
import {
  chesscomArchiveGames,
  chesscomArchives,
  chesscomPlayerExists,
  chesscomRulesToVariant,
  lichessExportPgn,
  lichessPlayerExists,
  type FetchLike,
} from "./platforms";
import { storeImportedGame } from "./store";

/**
 * Import orchestration (Phase 2, C1): per-user linked accounts, incremental
 * and resumable via linked_accounts.lastImportedAt, deduplicated on
 * (source, externalId). Each call imports a bounded chunk so route handlers
 * stay within serverless budgets; the client loops until `done`.
 */

export type ImportSource = "chesscom" | "lichess";

export interface LinkedAccountView {
  source: ImportSource;
  externalUsername: string;
  verified: boolean;
  lastImportedAt: string | null;
  autoImport: boolean;
}

function toView(row: typeof linkedAccounts.$inferSelect): LinkedAccountView {
  return {
    source: row.source as ImportSource,
    externalUsername: row.externalUsername,
    verified: row.verifiedAt !== null,
    lastImportedAt: row.lastImportedAt?.toISOString() ?? null,
    autoImport: row.autoImport,
  };
}

export async function listLinkedAccounts(db: Db, userId: string): Promise<LinkedAccountView[]> {
  const rows = await db.select().from(linkedAccounts).where(eq(linkedAccounts.userId, userId));
  return rows.map(toView);
}

const USERNAME_RE = /^[A-Za-z0-9_-]{2,40}$/;

/**
 * Connects a platform handle. Existence is checked against the platform;
 * ownership cannot be (neither platform offers a lightweight proof without
 * OAuth), so the link stays UNVERIFIED and the UI labels imported games so.
 */
export async function linkAccount(
  db: Db,
  userId: string,
  source: ImportSource,
  externalUsername: string,
  fetchFn: FetchLike = fetch
): Promise<LinkedAccountView> {
  if (!USERNAME_RE.test(externalUsername)) {
    throw new AccountError("bad_username", "That does not look like a platform username.");
  }
  const exists =
    source === "chesscom"
      ? await chesscomPlayerExists(externalUsername, fetchFn)
      : await lichessPlayerExists(externalUsername, fetchFn);
  if (!exists) {
    throw new AccountError(
      "player_not_found",
      `No ${source === "chesscom" ? "chess.com" : "Lichess"} player named "${externalUsername}".`,
      404
    );
  }
  const inserted = await db
    .insert(linkedAccounts)
    .values({ userId, source, externalUsername })
    .onConflictDoUpdate({
      target: [linkedAccounts.userId, linkedAccounts.source],
      set: { externalUsername, lastImportedAt: null, verifiedAt: null },
    })
    .returning();
  return toView(inserted[0]!);
}

/**
 * OAuth-backed verification (Lichess only — chess.com offers no OAuth, so
 * chess.com links can never be verified; the UI says so plainly). The OAuth
 * flow proved control of `externalUsername`, so it OVERRIDES any manually
 * typed handle for this source; the import cursor resets only when the
 * handle actually changed (a different player's games). `following` is the
 * user's Lichess follow list (follow:read), stored for friend matching —
 * matched exclusively against OTHER users' VERIFIED lichess handles, never
 * self-reported ones (impersonation guard, see the schema comment).
 */
export async function verifyLinkedAccount(
  db: Db,
  userId: string,
  source: ImportSource,
  externalUsername: string,
  following?: string[]
): Promise<LinkedAccountView> {
  if (!USERNAME_RE.test(externalUsername)) {
    throw new AccountError("bad_username", "That does not look like a platform username.");
  }
  const existing = (
    await db
      .select({ externalUsername: linkedAccounts.externalUsername })
      .from(linkedAccounts)
      .where(and(eq(linkedAccounts.userId, userId), eq(linkedAccounts.source, source)))
  )[0];
  const handleChanged =
    existing !== undefined &&
    existing.externalUsername.toLowerCase() !== externalUsername.toLowerCase();
  const normalizedFollowing = following?.map((name) => name.toLowerCase());
  const inserted = await db
    .insert(linkedAccounts)
    .values({
      userId,
      source,
      externalUsername,
      verifiedAt: new Date(),
      lichessFollowing: normalizedFollowing ?? null,
    })
    .onConflictDoUpdate({
      target: [linkedAccounts.userId, linkedAccounts.source],
      set: {
        externalUsername,
        verifiedAt: new Date(),
        ...(handleChanged ? { lastImportedAt: null } : {}),
        ...(normalizedFollowing ? { lichessFollowing: normalizedFollowing } : {}),
      },
    })
    .returning();
  return toView(inserted[0]!);
}

export interface LichessFriendMatch {
  userId: string;
  handle: string;
  displayName: string | null;
  lichessUsername: string;
}

/**
 * GAMBIT users this user follows on Lichess: my stored follow list (from my
 * own verified link) intersected with other users' VERIFIED lichess handles.
 * Verified↔verified only, by construction — an unverified link never appears
 * on either side, so nobody can plant a famous handle to harvest friends.
 */
export async function lichessFriendMatches(
  db: Db,
  userId: string
): Promise<LichessFriendMatch[]> {
  const mine = (
    await db
      .select({ following: linkedAccounts.lichessFollowing, verifiedAt: linkedAccounts.verifiedAt })
      .from(linkedAccounts)
      .where(and(eq(linkedAccounts.userId, userId), eq(linkedAccounts.source, "lichess")))
  )[0];
  if (!mine?.verifiedAt || !mine.following || mine.following.length === 0) return [];
  const followingSet = new Set(mine.following.map((name) => name.toLowerCase()));
  const rows = await db
    .select({
      userId: linkedAccounts.userId,
      lichessUsername: linkedAccounts.externalUsername,
      handle: users.handle,
      displayName: users.displayName,
      deletedAt: users.deletedAt,
    })
    .from(linkedAccounts)
    .innerJoin(users, eq(users.id, linkedAccounts.userId))
    .where(
      and(
        eq(linkedAccounts.source, "lichess"),
        isNotNull(linkedAccounts.verifiedAt),
        ne(linkedAccounts.userId, userId),
        inArray(sql`lower(${linkedAccounts.externalUsername})`, [...followingSet])
      )
    );
  return rows
    .filter((row) => row.deletedAt === null)
    .map((row) => ({
      userId: row.userId,
      handle: row.handle,
      displayName: row.displayName,
      lichessUsername: row.lichessUsername,
    }));
}

export async function unlinkAccount(db: Db, userId: string, source: ImportSource): Promise<void> {
  await db
    .delete(linkedAccounts)
    .where(and(eq(linkedAccounts.userId, userId), eq(linkedAccounts.source, source)));
}

export async function setAutoImport(
  db: Db,
  userId: string,
  source: ImportSource,
  autoImport: boolean
): Promise<void> {
  const updated = await db
    .update(linkedAccounts)
    .set({ autoImport })
    .where(and(eq(linkedAccounts.userId, userId), eq(linkedAccounts.source, source)))
    .returning();
  if (!updated[0]) throw new AccountError("not_linked", "No such linked account.", 404);
}

export interface ImportChunkResult {
  imported: number;
  duplicates: number;
  skipped: { externalId: string; reason: string }[];
  done: boolean;
  /** New incremental cursor (echo of linked_accounts.lastImportedAt). */
  lastImportedAt: string | null;
}

export interface ImportChunkOpts {
  maxGames?: number;
  fetchFn?: FetchLike;
  now?: Date;
}

/** Runs one bounded import chunk for the user's linked account on `source`. */
export async function runImportChunk(
  db: Db,
  user: UserRow,
  source: ImportSource,
  opts: ImportChunkOpts = {}
): Promise<ImportChunkResult> {
  const linked = (
    await db
      .select()
      .from(linkedAccounts)
      .where(and(eq(linkedAccounts.userId, user.id), eq(linkedAccounts.source, source)))
  )[0];
  if (!linked) {
    throw new AccountError("not_linked", "Connect a platform account first.", 404);
  }
  const maxGames = Math.min(Math.max(opts.maxGames ?? 25, 1), 100);
  const fetchFn = opts.fetchFn ?? fetch;

  const result =
    source === "chesscom"
      ? await chesscomChunk(db, user.id, linked, maxGames, fetchFn)
      : await lichessChunk(db, user.id, linked, maxGames, fetchFn);

  if (result.cursor) {
    await db
      .update(linkedAccounts)
      .set({ lastImportedAt: result.cursor })
      .where(
        and(eq(linkedAccounts.userId, user.id), eq(linkedAccounts.source, source))
      );
  }
  return {
    imported: result.imported,
    duplicates: result.duplicates,
    skipped: result.skipped,
    done: result.done,
    lastImportedAt: (result.cursor ?? linked.lastImportedAt)?.toISOString() ?? null,
  };
}

interface ChunkOutcome {
  imported: number;
  duplicates: number;
  skipped: { externalId: string; reason: string }[];
  done: boolean;
  cursor: Date | null;
}

function matchColor(
  white: string,
  black: string,
  username: string
): "white" | "black" | null {
  const u = username.toLowerCase();
  if (white.toLowerCase() === u) return "white";
  if (black.toLowerCase() === u) return "black";
  return null;
}

async function chesscomChunk(
  db: Db,
  userId: string,
  linked: typeof linkedAccounts.$inferSelect,
  maxGames: number,
  fetchFn: FetchLike
): Promise<ChunkOutcome> {
  const since = linked.lastImportedAt?.getTime() ?? 0;
  const archives = await chesscomArchives(linked.externalUsername, fetchFn);
  // Archive URLs end /YYYY/MM — only fetch months that can contain new games.
  const sinceMonth = new Date(since);
  const monthFloor = Date.UTC(sinceMonth.getUTCFullYear(), sinceMonth.getUTCMonth(), 1);
  const relevant = archives.filter((url) => {
    const match = url.match(/\/(\d{4})\/(\d{2})$/);
    if (!match) return false;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) >= monthFloor;
  });

  const outcome: ChunkOutcome = {
    imported: 0,
    duplicates: 0,
    skipped: [],
    done: true,
    cursor: null,
  };
  let budget = maxGames;

  for (const archiveUrl of relevant) {
    if (budget <= 0) {
      outcome.done = false;
      break;
    }
    const games = (await chesscomArchiveGames(archiveUrl, fetchFn))
      .filter((game) => game.end_time * 1000 > since)
      .sort((a, b) => a.end_time - b.end_time);
    for (const game of games) {
      if (budget <= 0) {
        outcome.done = false;
        return outcome;
      }
      budget--;
      const externalId = game.uuid ?? game.url;
      const playedAt = new Date(game.end_time * 1000);
      const advanceCursor = () => {
        if (!outcome.cursor || playedAt > outcome.cursor) outcome.cursor = playedAt;
      };
      const variant = chesscomRulesToVariant(game.rules);
      if (!variant || !game.pgn) {
        outcome.skipped.push({
          externalId,
          reason: variant ? "no PGN" : `unsupported rules "${game.rules}"`,
        });
        advanceCursor();
        continue;
      }
      const userColor = matchColor(game.white.username, game.black.username, linked.externalUsername);
      if (!userColor) {
        outcome.skipped.push({ externalId, reason: "username matches neither side" });
        advanceCursor();
        continue;
      }
      try {
        const raw = parseMultiPgn(game.pgn)[0];
        if (!raw) throw new Error("empty PGN");
        // chess.com omits the Variant header for chess960 in some exports —
        // trust the API's rules field.
        if (variant === "chess960" && !raw.headers.Variant) raw.headers.Variant = "Chess960";
        if (variantFromHeader(raw.headers.Variant) !== variant) raw.headers.Variant = variant;
        const replayed = replayPgnGame(raw);
        const stored = await storeImportedGame(db, userId, replayed, {
          source: "chesscom",
          externalId,
          pgn: game.pgn,
          whiteName: game.white.username,
          blackName: game.black.username,
          userColor,
          timeControl: game.time_control ?? raw.headers.TimeControl ?? null,
          termination: raw.headers.Termination ?? null,
          playedAt,
          ratedByPlatform: game.rated,
        });
        if (stored.duplicate) outcome.duplicates++;
        else outcome.imported++;
      } catch (error) {
        outcome.skipped.push({
          externalId,
          reason: error instanceof Error ? error.message : "parse failure",
        });
      }
      advanceCursor();
    }
  }
  return outcome;
}

async function lichessChunk(
  db: Db,
  userId: string,
  linked: typeof linkedAccounts.$inferSelect,
  maxGames: number,
  fetchFn: FetchLike
): Promise<ChunkOutcome> {
  const since = linked.lastImportedAt ? linked.lastImportedAt.getTime() + 1 : undefined;
  const text = await lichessExportPgn(linked.externalUsername, {
    since,
    max: maxGames,
    fetchFn,
  });
  const rawGames = parseMultiPgn(text);
  const outcome: ChunkOutcome = {
    imported: 0,
    duplicates: 0,
    skipped: [],
    done: rawGames.length < maxGames,
    cursor: null,
  };

  for (const raw of rawGames) {
    const site = raw.headers.Site ?? "";
    const externalId = site.match(/lichess\.org\/(\w{8})/)?.[1] ?? site;
    const playedAt = parseUtcHeader(raw.headers);
    if (playedAt && (!outcome.cursor || playedAt > outcome.cursor)) outcome.cursor = playedAt;

    const white = raw.headers.White ?? "?";
    const black = raw.headers.Black ?? "?";
    const userColor = matchColor(white, black, linked.externalUsername);
    if (!userColor) {
      outcome.skipped.push({ externalId, reason: "username matches neither side" });
      continue;
    }
    if (variantFromHeader(raw.headers.Variant) === null) {
      outcome.skipped.push({
        externalId,
        reason: `unsupported variant "${raw.headers.Variant}"`,
      });
      continue;
    }
    try {
      const replayed = replayPgnGame(raw);
      const stored = await storeImportedGame(db, userId, replayed, {
        source: "lichess",
        externalId,
        pgn: rebuildPgnSlice(raw.headers, text, externalId),
        whiteName: white,
        blackName: black,
        userColor,
        timeControl: raw.headers.TimeControl ?? null,
        termination: raw.headers.Termination ?? null,
        playedAt,
        ratedByPlatform: (raw.headers.Event ?? "").toLowerCase().includes("rated"),
      });
      if (stored.duplicate) outcome.duplicates++;
      else outcome.imported++;
    } catch (error) {
      outcome.skipped.push({
        externalId,
        reason: error instanceof Error ? error.message : "parse failure",
      });
    }
  }
  return outcome;
}

function parseUtcHeader(headers: Record<string, string>): Date | null {
  const date = headers.UTCDate ?? headers.Date;
  if (!date || date.includes("?")) return null;
  const time = headers.UTCTime ?? "12:00:00";
  const iso = `${date.replaceAll(".", "-")}T${time}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The stored PGN should be the single game, not the whole stream. Rebuild a
 * minimal-but-faithful slice by locating this game's header block.
 */
function rebuildPgnSlice(
  headers: Record<string, string>,
  streamText: string,
  externalId: string
): string {
  const marker = `[Site "https://lichess.org/${externalId}"]`;
  const start = streamText.indexOf(marker);
  if (start === -1) {
    // Fallback: serialize headers only (movetext lost) — should not happen.
    return Object.entries(headers)
      .map(([key, value]) => `[${key} "${value}"]`)
      .join("\n");
  }
  const headerStart = streamText.lastIndexOf("[Event", start);
  const nextGame = streamText.indexOf("[Event", start + marker.length);
  return streamText.slice(headerStart === -1 ? start : headerStart, nextGame === -1 ? undefined : nextGame).trim();
}
