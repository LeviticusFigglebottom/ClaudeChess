import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { puzzles } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/account/test-db";
import type { AuthShape, UserRow } from "@/lib/account/types";
import { ensureUser } from "@/lib/account/users";
import { nextPuzzle } from "./index";

/**
 * Rated-puzzle serving, pinned on the THEME FILTER specifically: the
 * original seed stored jsonb string scalars, so `themes ?|` matched
 * nothing (migration 0020 repaired the data; the seed now writes real
 * arrays). These rows go in through drizzle — real arrays — and the filter
 * must actually restrict.
 */

let t: TestDb;
let user: UserRow;

beforeAll(async () => {
  t = await createTestDb();
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: false,
    email: "puzzler@example.com",
    emailConfirmedAt: new Date().toISOString(),
  };
  user = (await ensureUser(t.db, auth, { desiredHandle: "puzzler-1" })).user;

  await t.db.insert(puzzles).values([
    {
      id: "pz-fork-1",
      fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
      movesUci: ["h5f7"],
      rating: 1500,
      ratingDeviation: 80,
      themes: ["fork", "short"],
      popularity: 90,
    },
    {
      id: "pz-pin-1",
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      movesUci: ["g1f3"],
      rating: 1500,
      ratingDeviation: 80,
      themes: ["pin", "middlegame"],
      popularity: 90,
    },
  ]);
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe("nextPuzzle", () => {
  it("serves a puzzle with real arrays for moves and themes", async () => {
    const puzzle = await nextPuzzle(t.db, user.id);
    expect(Array.isArray(puzzle.movesUci)).toBe(true);
    expect(Array.isArray(puzzle.themes)).toBe(true);
    expect(puzzle.movesUci.length).toBeGreaterThan(0);
  });

  it("theme filter actually restricts (the ?| operator sees real arrays)", async () => {
    for (let i = 0; i < 6; i++) {
      const puzzle = await nextPuzzle(t.db, user.id, { themes: ["fork"] });
      expect(puzzle.id).toBe("pz-fork-1");
      expect(puzzle.themes).toContain("fork");
    }
  });

  it("no matching theme -> honest no_puzzles error, not a fallback", async () => {
    await expect(
      nextPuzzle(t.db, user.id, { themes: ["nonexistentTheme"] })
    ).rejects.toMatchObject({ code: "no_puzzles" });
  });
});
