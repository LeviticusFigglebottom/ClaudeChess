import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  blunderTags,
  calibrationAttempts,
  challenges,
  fairplayFlags,
  games,
  plies,
  postmortemResponses,
  puzzleAttempts,
  puzzles,
  ratings,
  relationships,
  sessions,
  usageCounters,
  users,
} from "@/db/schema";
import { grantTitle } from "./admin";
import { exportAccount } from "./export";
import { saveBotGame } from "./games";
import { generateGuestHandle, validateHandle } from "./handles";
import { createTestDb, type TestDb } from "./test-db";
import { AccountError, type AuthShape } from "./types";
import {
  ensureUser,
  hardDeleteUser,
  purgeDeletedUsers,
  recoverUser,
  softDeleteUser,
  updatePrefs,
  updateProfile,
  upsertSession,
} from "./users";

/**
 * Phase 1.5 gate tests: the anonymous→permanent conversion preserves every
 * linked row and the preferences (linking, never copying — same primary
 * keys, no duplicates), and the hard-delete cascade actually clears the FK
 * graph while audit history survives.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});

function anonAuth(id = randomUUID()): AuthShape {
  return { id, isAnonymous: true, email: null, emailConfirmedAt: null };
}

function permanentAuth(id: string, email: string): AuthShape {
  return { id, isAnonymous: false, email, emailConfirmedAt: new Date().toISOString() };
}

const SAMPLE_PGN = '[Event "GAMBIT casual game"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0\n';

function gamePayload(rated = false) {
  return {
    variant: "standard",
    pgn: SAMPLE_PGN,
    whiteName: "You",
    blackName: "Willow (1400)",
    userColor: "white" as const,
    result: "1-0" as const,
    termination: "checkmate",
    timeControl: "300+3",
    rated: rated
      ? { bucket: "blitz" as const, opponentRating: 1400, opponentRd: 30, score: 1 as const }
      : null,
  };
}

describe("handles", () => {
  it("accepts sane handles and rejects the reserved list, bad charsets, bad lengths", () => {
    expect(() => validateHandle("magnus_c")).not.toThrow();
    expect(() => validateHandle("a-1")).not.toThrow();
    expect(() => validateHandle("ab")).toThrow(AccountError);
    expect(() => validateHandle("x".repeat(21))).toThrow(AccountError);
    expect(() => validateHandle("has space")).toThrow(AccountError);
    expect(() => validateHandle("-lead")).toThrow(AccountError);
    expect(() => validateHandle("admin")).toThrow(AccountError);
    expect(() => validateHandle("Admin")).toThrow(AccountError);
    expect(() => validateHandle("guest-abc")).toThrow(AccountError);
  });

  it("generates guest-prefixed handles users cannot self-claim", () => {
    const handle = generateGuestHandle(() => 0.42);
    expect(handle).toMatch(/^guest-[a-z2-9]{6}$/);
    expect(() => validateHandle(handle)).toThrow(AccountError);
  });
});

describe("ensureUser (anonymous-first)", () => {
  it("creates an anonymous row on first visit and is idempotent", async () => {
    const auth = anonAuth();
    const first = await ensureUser(t.db, auth);
    expect(first.created).toBe(true);
    expect(first.user.isAnonymous).toBe(true);
    expect(first.user.email).toBeNull();
    expect(first.user.handle).toMatch(/^guest-/);

    const second = await ensureUser(t.db, auth);
    expect(second.created).toBe(false);
    expect(second.converted).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("honors a valid desired handle and falls back on a taken one", async () => {
    const a = await ensureUser(t.db, anonAuth(), { desiredHandle: "wanted-handle" });
    expect(a.user.handle).toBe("wanted-handle");
    const b = await ensureUser(t.db, anonAuth(), { desiredHandle: "Wanted-Handle" });
    expect(b.user.handle).not.toBe("Wanted-Handle"); // citext collision → generated fallback
    expect(b.created).toBe(true);
  });

  it("GoTrue empty-string emails: multiple anonymous users all provision (deployed finding)", async () => {
    // The live auth service reports anonymous users with email "" — a VALUE
    // under the users.email unique constraint ('' collides with '', NULLs
    // coexist). Every anonymous visitor after the first failed to provision
    // on the first real deployment; pinned here against the real schema.
    const a = await ensureUser(t.db, { ...anonAuth(), email: "" });
    const b = await ensureUser(t.db, { ...anonAuth(), email: "" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.user.email).toBeNull();
    expect(b.user.email).toBeNull();
    expect(a.user.id).not.toBe(b.user.id);
  });
});

describe("GATE: anonymous→permanent conversion preserves history and preferences", () => {
  it("links, never copies: same primary keys, no duplicate rows, prefs intact", async () => {
    const auth = anonAuth();
    const { user } = await ensureUser(t.db, auth);

    // History while anonymous: two games (one rated), a puzzle attempt, prefs.
    const g1 = await saveBotGame(t.db, user, gamePayload(false));
    const g2 = await saveBotGame(t.db, user, gamePayload(true));
    expect(g2.rating?.state.pending).toHaveLength(1);

    await t.db.insert(puzzles).values({
      id: "test-puzzle-1",
      fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
      movesUci: ["d1d8"],
      rating: 1200,
      ratingDeviation: 80,
      themes: ["backRankMate"],
      popularity: 95,
    });
    const attempt = await t.db
      .insert(puzzleAttempts)
      .values({ userId: user.id, puzzleId: "test-puzzle-1", solved: true, timeMs: 4200 })
      .returning();

    const prefs = {
      boardTheme: "walnut",
      pieceSet: "cburnett",
      coordinates: "on",
      sound: { master: 0.5, muted: false, perEventMuted: { capture: true } },
      animation: "fast",
      moveList: "figurine",
      evalBar: { show: true, format: "both" },
      accessibility: { shapeOnlyClassifications: true, highContrastBoard: false, reduceMotion: false },
    };
    await updatePrefs(t.db, user.id, prefs);

    const gamesBefore = await t.db.select().from(games).where(eq(games.userId, user.id));
    const ratingsBefore = await t.db.select().from(ratings).where(eq(ratings.userId, user.id));
    expect(gamesBefore).toHaveLength(2);
    expect(ratingsBefore).toHaveLength(1);

    // Convert: same auth id arrives with a permanent identity.
    const converted = await ensureUser(t.db, permanentAuth(auth.id, "player@example.com"));
    expect(converted.converted).toBe(true);
    expect(converted.user.isAnonymous).toBe(false);
    expect(converted.user.email).toBe("player@example.com");
    expect(converted.user.emailVerifiedAt).not.toBeNull();
    expect(converted.user.id).toBe(user.id);

    // Same rows, same primary keys, same counts — nothing copied, nothing lost.
    const gamesAfter = await t.db.select().from(games).where(eq(games.userId, user.id));
    expect(gamesAfter.map((g) => g.id).sort()).toEqual(gamesBefore.map((g) => g.id).sort());
    expect(gamesAfter.map((g) => g.id)).toContain(g1.gameId);
    expect(gamesAfter.map((g) => g.id)).toContain(g2.gameId);

    const ratingsAfter = await t.db.select().from(ratings).where(eq(ratings.userId, user.id));
    expect(ratingsAfter).toHaveLength(1);
    expect(ratingsAfter[0]?.rating).toBe(ratingsBefore[0]?.rating);
    expect(ratingsAfter[0]?.period).toEqual(ratingsBefore[0]?.period);

    const attemptsAfter = await t.db
      .select()
      .from(puzzleAttempts)
      .where(eq(puzzleAttempts.userId, user.id));
    expect(attemptsAfter.map((a) => a.id)).toEqual(attempt.map((a) => a.id));

    expect(converted.user.prefs).toEqual(prefs);
    expect(converted.user.prefersBoardTheme).toBe("walnut");
    expect(converted.user.prefersPieceSet).toBe("cburnett");

    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, user.id));
    expect(audit.some((row) => row.action === "account.convert")).toBe(true);

    // Conversion is one-way: a later anonymous-shaped sync must not flip back…
    // (defensive: Supabase never reports a converted user anonymous again, but
    // reconciliation shouldn't trust that.)
    const resync = await ensureUser(t.db, permanentAuth(auth.id, "player@example.com"));
    expect(resync.converted).toBe(false);
    expect(resync.user.isAnonymous).toBe(false);
  });
});

describe("profile and prefs", () => {
  it("updates handle (citext-unique), display name, country; rejects bad input", async () => {
    const { user } = await ensureUser(t.db, anonAuth());
    const renamed = await updateProfile(t.db, user.id, {
      handle: "fischer-fan",
      displayName: "  Bobby  ",
      countryCode: "us",
    });
    expect(renamed.handle).toBe("fischer-fan");
    expect(renamed.displayName).toBe("Bobby");
    expect(renamed.countryCode).toBe("US");

    const { user: other } = await ensureUser(t.db, anonAuth());
    await expect(updateProfile(t.db, other.id, { handle: "FISCHER-FAN" })).rejects.toMatchObject({
      code: "handle_taken",
    });
    await expect(updateProfile(t.db, other.id, { handle: "moderator" })).rejects.toMatchObject({
      code: "handle_reserved",
    });
    await expect(
      updateProfile(t.db, other.id, { countryCode: "USA" })
    ).rejects.toMatchObject({ code: "country_code" });
  });

  it("rejects non-object prefs and oversized prefs", async () => {
    const { user } = await ensureUser(t.db, anonAuth());
    await expect(updatePrefs(t.db, user.id, "nope")).rejects.toMatchObject({
      code: "prefs_shape",
    });
    await expect(updatePrefs(t.db, user.id, [1, 2])).rejects.toMatchObject({
      code: "prefs_shape",
    });
    await expect(
      updatePrefs(t.db, user.id, { blob: "x".repeat(20_000) })
    ).rejects.toMatchObject({ code: "prefs_size" });
  });
});

describe("GATE: delete cascade", () => {
  it("hard delete clears the entire FK graph; audit and shared rows survive", async () => {
    const authA = anonAuth();
    const { user: userA } = await ensureUser(t.db, permanentAuth(authA.id, "a@example.com"), {
      desiredHandle: "cascade-a",
    });
    const { user: userB } = await ensureUser(t.db, anonAuth(), { desiredHandle: "cascade-b" });

    // Build the full graph under userA.
    const { gameId } = await saveBotGame(t.db, userA, gamePayload(true));
    const ply = await t.db
      .insert(plies)
      .values({
        gameId,
        ply: 1,
        moveNumber: 1,
        color: "white",
        san: "e4",
        uci: "e2e4",
        fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      })
      .returning();
    const plyId = ply[0]!.id;
    await t.db.insert(blunderTags).values({
      plyId,
      motif: "HANGING_PIECE",
      confidence: 0.9,
      explanation: "test",
      model: "test-model",
    });
    await t.db.insert(puzzles).values({
      id: "cascade-puzzle",
      fen: "8/8/8/8/8/8/8/K1k5 w - - 0 1",
      movesUci: ["a1a2"],
      rating: 800,
      ratingDeviation: 90,
      themes: ["endgame"],
      popularity: 50,
    });
    await t.db
      .insert(puzzleAttempts)
      .values({ userId: userA.id, puzzleId: "cascade-puzzle", solved: false });
    await t.db.insert(calibrationAttempts).values({
      userId: userA.id,
      fen: "8/8/8/8/8/8/8/K1k5 w - - 0 1",
      predictedWp: 60,
      actualWp: 50,
      squaredError: 0.01,
    });
    await t.db.insert(postmortemResponses).values({
      plyId,
      userId: userA.id,
      userReasoning: "I was worried about the fork",
      verdict: "CORRECT",
      critique: "test",
    });
    await t.db.insert(relationships).values({
      userId: userA.id,
      targetUserId: userB.id,
      kind: "friend",
      status: "accepted",
    });
    await t.db.insert(challenges).values({
      fromUserId: userA.id,
      toUserId: userB.id,
      variant: "standard",
      timeControl: "300+3",
      rated: false,
      color: "random",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await t.db.insert(usageCounters).values({ userId: userA.id, month: "2026-08-01" });
    await t.db
      .insert(fairplayFlags)
      .values({ userId: userA.id, gameId, signal: "tab_blur", score: 0.1 });
    await upsertSession(t.db, userA.id, { id: randomUUID(), label: "test device" });
    const { gameId: bGame } = await saveBotGame(t.db, userB, gamePayload(false));

    await hardDeleteUser(t.db, userA.id);

    const remaining = {
      users: await t.db.select().from(users).where(eq(users.id, userA.id)),
      games: await t.db.select().from(games).where(eq(games.userId, userA.id)),
      plies: await t.db.select().from(plies).where(eq(plies.gameId, gameId)),
      blunderTags: await t.db.select().from(blunderTags).where(eq(blunderTags.plyId, plyId)),
      ratings: await t.db.select().from(ratings).where(eq(ratings.userId, userA.id)),
      puzzleAttempts: await t.db
        .select()
        .from(puzzleAttempts)
        .where(eq(puzzleAttempts.userId, userA.id)),
      calibration: await t.db
        .select()
        .from(calibrationAttempts)
        .where(eq(calibrationAttempts.userId, userA.id)),
      postmortems: await t.db
        .select()
        .from(postmortemResponses)
        .where(eq(postmortemResponses.userId, userA.id)),
      relationships: await t.db
        .select()
        .from(relationships)
        .where(eq(relationships.userId, userA.id)),
      challenges: await t.db
        .select()
        .from(challenges)
        .where(eq(challenges.fromUserId, userA.id)),
      usage: await t.db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, userA.id)),
      fairplay: await t.db
        .select()
        .from(fairplayFlags)
        .where(eq(fairplayFlags.userId, userA.id)),
      sessions: await t.db.select().from(sessions).where(eq(sessions.userId, userA.id)),
    };
    for (const [name, rows] of Object.entries(remaining)) {
      expect(rows, `${name} should cascade`).toHaveLength(0);
    }

    // Shared and sibling data survives.
    const puzzleRows = await t.db.select().from(puzzles).where(eq(puzzles.id, "cascade-puzzle"));
    expect(puzzleRows).toHaveLength(1);
    const bGames = await t.db.select().from(games).where(eq(games.id, bGame));
    expect(bGames).toHaveLength(1);

    // Audit history survives with the user id nulled.
    const orphanedAudit = await t.db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.userId));
    expect(orphanedAudit.some((row) => row.action === "account.hardDelete")).toBe(true);
  });
});

describe("soft delete, recovery, purge", () => {
  it("soft delete revokes sessions and blocks reconciliation; recovery restores", async () => {
    const auth = anonAuth();
    const { user } = await ensureUser(t.db, auth);
    const deviceId = randomUUID();
    await upsertSession(t.db, user.id, { id: deviceId, label: "laptop" });

    await softDeleteUser(t.db, user.id);
    const after = await ensureUser(t.db, auth);
    expect(after.softDeleted).toBe(true);
    const deviceRows = await t.db.select().from(sessions).where(eq(sessions.id, deviceId));
    expect(deviceRows[0]?.revokedAt).not.toBeNull();

    const recovered = await recoverUser(t.db, user.id);
    expect(recovered.deletedAt).toBeNull();
  });

  it("purge hard-deletes only accounts past the 30-day window; recovery past it fails", async () => {
    const { user: fresh } = await ensureUser(t.db, anonAuth());
    const { user: stale } = await ensureUser(t.db, anonAuth());
    const now = new Date("2026-08-21T12:00:00Z");
    await softDeleteUser(t.db, fresh.id, new Date("2026-08-01T00:00:00Z")); // 20 days ago
    await softDeleteUser(t.db, stale.id, new Date("2026-07-01T00:00:00Z")); // 51 days ago

    await expect(recoverUser(t.db, stale.id, now)).rejects.toMatchObject({
      code: "recovery_expired",
    });

    const purged = await purgeDeletedUsers(t.db, now);
    expect(purged).toContain(stale.id);
    expect(purged).not.toContain(fresh.id);
    expect(await t.db.select().from(users).where(eq(users.id, stale.id))).toHaveLength(0);
    expect(await t.db.select().from(users).where(eq(users.id, fresh.id))).toHaveLength(1);
  });
});

describe("B1.3: admin title grant path", () => {
  it("grants and revokes titles for admins only, audit-logged", async () => {
    const { user: admin } = await ensureUser(t.db, anonAuth(), { desiredHandle: "the-arbiter" });
    const { user: target } = await ensureUser(t.db, anonAuth(), { desiredHandle: "strong-player" });
    const adminIds = new Set([admin.id]);

    const titled = await grantTitle(t.db, admin, "strong-player", "IM", adminIds);
    expect(titled.title).toBe("IM");

    await expect(
      grantTitle(t.db, target, "the-arbiter", "GM", adminIds)
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(
      grantTitle(t.db, admin, "strong-player", "WIZARD", adminIds)
    ).rejects.toMatchObject({ code: "title_invalid" });

    const revoked = await grantTitle(t.db, admin, "strong-player", null, adminIds);
    expect(revoked.title).toBeNull();

    const audit = await t.db.select().from(auditLog).where(eq(auditLog.userId, admin.id));
    expect(audit.filter((row) => row.action === "admin.grantTitle")).toHaveLength(2);
  });
});

describe("A2.4: export", () => {
  it("exports games with plies, a multi-game PGN archive, prefs, and ratings", async () => {
    const { user } = await ensureUser(t.db, anonAuth(), { desiredHandle: "exporter" });
    await updatePrefs(t.db, user.id, { boardTheme: "slate", pieceSet: "classic" });
    const a = await saveBotGame(t.db, user, gamePayload(true));
    await saveBotGame(t.db, user, gamePayload(false));
    await t.db.insert(plies).values({
      gameId: a.gameId,
      ply: 1,
      moveNumber: 1,
      color: "white",
      san: "e4",
      uci: "e2e4",
      fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    });

    const dump = await exportAccount(t.db, user.id);
    expect(dump.user.handle).toBe("exporter");
    expect(dump.prefs).toEqual({ boardTheme: "slate", pieceSet: "classic" });
    expect(dump.games).toHaveLength(2);
    expect(dump.ratings).toHaveLength(1);
    const withPlies = dump.games.find(
      (game) => (game as { id: string }).id === a.gameId
    ) as { plies: unknown[] };
    expect(withPlies.plies).toHaveLength(1);
    // Two games → the archive contains two Event headers.
    expect(dump.pgnArchive.match(/\[Event /g)).toHaveLength(2);
  });
});

describe("schema sanity for the new columns", () => {
  it("challenge lifecycle columns default open and accept status transitions", async () => {
    const { user: a } = await ensureUser(t.db, anonAuth());
    const inserted = await t.db
      .insert(challenges)
      .values({
        fromUserId: a.id,
        variant: "standard",
        timeControl: "180+2",
        rated: false,
        color: "random",
        token: "tok-schema-test",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    expect(inserted[0]?.status).toBe("open");
    await t.db.execute(sql`update challenges set status = 'accepted' where token = 'tok-schema-test'`);
  });
});
