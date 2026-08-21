import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ratings } from "@/db/schema";
import { newPlayerRating } from "@/lib/rating/glicko2";
import { addResult, createPeriodState, RATING_PERIOD_GAMES } from "@/lib/rating/period";
import {
  getRatingStates,
  recordRatedResult,
  saveBotGame,
  seedRatings,
  listGames,
} from "./games";
import { createTestDb, type TestDb } from "./test-db";
import type { AuthShape, UserRow } from "./types";
import { ensureUser } from "./users";

/**
 * Server-side game persistence + ratings (Phase 1.5). The critical claim:
 * the server's Glicko-2 state is bit-identical to what the client's
 * localStorage store would compute, because both run the SAME period module
 * with the same inputs (spec §7 — batched period closes, never per game).
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});

async function makeUser(): Promise<UserRow> {
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: true,
    email: null,
    emailConfirmedAt: null,
  };
  return (await ensureUser(t.db, auth)).user;
}

const PGN = '[Event "GAMBIT rated game"]\n[Result "0-1"]\n\n1. e4 e5 0-1\n';

describe("saveBotGame", () => {
  it("persists a standard game with metadata", async () => {
    const user = await makeUser();
    const saved = await saveBotGame(t.db, user, {
      variant: "standard",
      pgn: PGN,
      whiteName: "Willow (1400)",
      blackName: "You",
      userColor: "black",
      result: "0-1",
      termination: "resignation",
      timeControl: "300+3",
      eco: "C20",
      opening: "King's Pawn Game",
    });
    expect(saved.gameId).toBeTruthy();
    expect(saved.rating).toBeNull();
    const listed = await listGames(t.db, user.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.eco).toBe("C20");
    expect(listed[0]?.source).toBe("local");
  });

  it("requires a start FEN for chess960 and rejects junk", async () => {
    const user = await makeUser();
    await expect(
      saveBotGame(t.db, user, {
        variant: "chess960",
        pgn: PGN,
        whiteName: "a",
        blackName: "b",
        userColor: "white",
        result: "*",
      })
    ).rejects.toMatchObject({ code: "start_fen" });
    await expect(
      saveBotGame(t.db, user, {
        variant: "klingon-chess",
        pgn: PGN,
        whiteName: "a",
        blackName: "b",
        userColor: "white",
        result: "*",
      })
    ).rejects.toMatchObject({ code: "variant" });
    await expect(
      saveBotGame(t.db, user, {
        variant: "standard",
        pgn: "",
        whiteName: "a",
        blackName: "b",
        userColor: "white",
        result: "*",
      })
    ).rejects.toMatchObject({ code: "pgn" });
  });
});

describe("server ratings match the client period module exactly", () => {
  it("a sequence of rated results produces bit-identical state", async () => {
    const user = await makeUser();
    const results = [
      { opponentRating: 1400, opponentRd: 30, score: 1 },
      { opponentRating: 1500, opponentRd: 30, score: 0 },
      { opponentRating: 1600, opponentRd: 30, score: 0.5 },
    ];
    const t0 = new Date("2026-08-10T10:00:00Z").getTime();

    // Reference: the client-side store's computation.
    let reference = createPeriodState(newPlayerRating());
    results.forEach((result, index) => {
      reference = addResult(reference, result, t0 + index * 60_000);
    });

    // Server: same inputs through recordRatedResult.
    let server = createPeriodState(newPlayerRating());
    for (const [index, result] of results.entries()) {
      server = await recordRatedResult(
        t.db,
        user.id,
        "standard",
        "blitz",
        result,
        new Date(t0 + index * 60_000)
      );
    }
    expect(server).toEqual(reference);

    const row = await t.db
      .select()
      .from(ratings)
      .where(eq(ratings.userId, user.id));
    expect(row[0]?.rating).toBe(reference.rating.rating);
    expect(row[0]?.period).toEqual({ pending: reference.pending });
  });

  it("the 12th game closes the period (pending drains, rating moves)", async () => {
    const user = await makeUser();
    const t0 = new Date("2026-08-10T10:00:00Z").getTime();
    let state = createPeriodState(newPlayerRating());
    for (let i = 0; i < RATING_PERIOD_GAMES; i++) {
      state = await recordRatedResult(
        t.db,
        user.id,
        "standard",
        "rapid",
        { opponentRating: 1450, opponentRd: 30, score: 1 },
        new Date(t0 + i * 60_000)
      );
    }
    expect(state.pending).toHaveLength(0);
    expect(state.rating.rating).toBeGreaterThan(1500);
    expect(state.rating.rd).toBeLessThan(350);
  });

  it("variant pools stay separate (A1.4): chess960 blitz ≠ standard blitz", async () => {
    const user = await makeUser();
    await recordRatedResult(t.db, user.id, "standard", "blitz", {
      opponentRating: 1400,
      opponentRd: 30,
      score: 1,
    });
    await recordRatedResult(t.db, user.id, "chess960", "blitz", {
      opponentRating: 1400,
      opponentRd: 30,
      score: 0,
    });
    const rows = await t.db.select().from(ratings).where(eq(ratings.userId, user.id));
    expect(rows).toHaveLength(2);
    const states = await getRatingStates(t.db, user.id);
    const standard = states.find((s) => s.variant === "standard");
    const fischer = states.find((s) => s.variant === "chess960");
    expect(standard?.state.pending).toHaveLength(1);
    expect(fischer?.state.pending).toHaveLength(1);
    expect(standard?.state.pending[0]?.score).toBe(1);
    expect(fischer?.state.pending[0]?.score).toBe(0);
  });

  it("getRatingStates settles a 7-day-due period and persists the close", async () => {
    const user = await makeUser();
    const played = new Date("2026-08-01T10:00:00Z");
    await recordRatedResult(
      t.db,
      user.id,
      "standard",
      "classical",
      { opponentRating: 1300, opponentRd: 30, score: 1 },
      played
    );
    const eightDaysLater = new Date("2026-08-09T11:00:00Z");
    const states = await getRatingStates(t.db, user.id, eightDaysLater);
    const classical = states.find((s) => s.bucket === "classical");
    expect(classical?.state.pending).toHaveLength(0);
    expect(classical?.state.rating.rating).toBeGreaterThan(1500);
    // Persisted, not just computed.
    const rows = await t.db
      .select()
      .from(ratings)
      .where(eq(ratings.userId, user.id));
    const row = rows.find((r) => r.timeControl === "classical");
    expect(row?.period).toEqual({ pending: [] });
    expect(row?.rating).toBe(classical?.state.rating.rating);
  });

  it("rated saveBotGame books the result and returns the new state", async () => {
    const user = await makeUser();
    const saved = await saveBotGame(t.db, user, {
      variant: "standard",
      pgn: PGN,
      whiteName: "You",
      blackName: "Willow (1400)",
      userColor: "white",
      result: "1-0",
      timeControl: "300+3",
      rated: { bucket: "blitz", opponentRating: 1400, opponentRd: 30, score: 1 },
    });
    expect(saved.rating?.state.pending).toHaveLength(1);
    expect(saved.rating?.variant).toBe("standard");
    expect(saved.rating?.bucket).toBe("blitz");
  });
});

describe("seedRatings (bootstrap: local cache → server, fill-only)", () => {
  it("fills missing keys and never overwrites server rows", async () => {
    const user = await makeUser();
    await recordRatedResult(t.db, user.id, "standard", "blitz", {
      opponentRating: 1400,
      opponentRd: 30,
      score: 1,
    });
    const serverRow = (
      await t.db.select().from(ratings).where(eq(ratings.userId, user.id))
    )[0];

    const seeded = await seedRatings(t.db, user.id, [
      {
        variant: "standard",
        bucket: "blitz", // exists — must not overwrite
        state: createPeriodState({ rating: 999, rd: 200, volatility: 0.06 }),
      },
      {
        variant: "chess960",
        bucket: "rapid", // missing — seeds
        state: {
          rating: { rating: 1622, rd: 180, volatility: 0.06 },
          pending: [{ opponentRating: 1600, opponentRd: 30, score: 1, at: Date.now() }],
        },
      },
      {
        variant: "not-a-variant",
        bucket: "blitz",
        state: createPeriodState(newPlayerRating()),
      },
      {
        variant: "standard",
        bucket: "bullet",
        state: createPeriodState({ rating: 99_999, rd: 200, volatility: 0.06 }), // junk — skipped
      },
    ]);
    expect(seeded).toBe(1);

    const rows = await t.db.select().from(ratings).where(eq(ratings.userId, user.id));
    expect(rows).toHaveLength(2);
    const blitz = rows.find((r) => r.variant === "standard" && r.timeControl === "blitz");
    expect(blitz?.rating).toBe(serverRow?.rating); // untouched
    const seededRow = rows.find((r) => r.variant === "chess960" && r.timeControl === "rapid");
    expect(seededRow?.rating).toBe(1622);
  });
});
