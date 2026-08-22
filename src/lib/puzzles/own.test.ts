import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blunderTags, games, plies } from "@/db/schema";
import { ensureUser, type AuthShape } from "@/lib/account";
import { createTestDb, type TestDb } from "@/lib/account/test-db";
import { GamePosition } from "@/lib/chess/position";
import { ownPuzzles } from "./own";

/**
 * Own-blunder drills: a full-depth BLUNDER with a replay-valid refutation
 * becomes a puzzle in the standard setup-move contract; degraded and
 * provisional plies never do, and solution lines always end on a solver move.
 */

let t: TestDb;
let userId: string;

beforeAll(async () => {
  t = await createTestDb();
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: false,
    email: `${randomUUID()}@example.com`,
    emailConfirmedAt: new Date().toISOString(),
  };
  userId = (await ensureUser(t.db, auth)).user.id;

  // 1.e4 e5 2.Qh5?? (the blunder) — refutation from the post-blunder
  // position: 2...Nc6 3.Bc4 g6 (an odd-length engine line; the builder must
  // trim it to end on a solver move).
  const replay = GamePosition.initial("standard");
  const moves = ["e2e4", "e7e5", "d1h5"];
  const rows: (typeof plies.$inferInsert)[] = [];
  for (const [index, uci] of moves.entries()) {
    const fenBefore = replay.fen();
    const move = replay.moveUci(uci);
    if (!move) throw new Error(`bad test move ${uci}`);
    rows.push({
      gameId: "", // filled after insert
      ply: index + 1,
      moveNumber: Math.floor(index / 2) + 1,
      color: index % 2 === 0 ? "white" : "black",
      san: move.san,
      uci,
      fenBefore,
      fenAfter: replay.fen(),
    });
  }
  const inserted = await t.db
    .insert(games)
    .values({
      userId,
      variant: "standard",
      source: "local",
      pgn: "",
      whiteName: "me",
      blackName: "them",
      userColor: "white",
      result: "0-1",
      playedAt: new Date(),
      importedAt: new Date(),
    })
    .returning();
  const gameId = inserted[0]!.id;
  const analyzed = rows.map((row, index) => ({
    ...row,
    gameId,
    wpBefore: 50,
    wpAfter: index === 2 ? 80 : 50,
    wpLoss: index === 2 ? 30 : 0,
    classification: (index === 2 ? "BLUNDER" : "GOOD") as "BLUNDER" | "GOOD",
    analyzedAtDepth: 18,
    degraded: false,
    // Ply 4 would hold the refutation; the game ended, so we attach it to a
    // synthetic 4th ply the way the pipeline stores it.
  }));
  await t.db.insert(plies).values(analyzed);
  // The refutation lives on ply 4's pv1 (the next position's best line).
  const post = GamePosition.fromFen(rows[2]!.fenAfter!, "standard");
  const nc6 = post.moveUci("b8c6")!;
  await t.db.insert(plies).values({
    gameId,
    ply: 4,
    moveNumber: 2,
    color: "black",
    san: nc6.san,
    uci: "b8c6",
    fenBefore: rows[2]!.fenAfter!,
    fenAfter: post.fen(),
    pv1: ["b8c6", "f1c4", "g7g6"],
    wpBefore: 80,
    wpAfter: 50,
    wpLoss: 0,
    classification: "GOOD",
    analyzedAtDepth: 18,
    degraded: false,
  });
  const blunderRow = (
    await t.db.select({ id: plies.id }).from(plies).where(eq(plies.gameId, gameId))
  ).at(2)!;
  await t.db.insert(blunderTags).values({
    plyId: blunderRow.id,
    motif: "HANGING_PIECE",
    rank: 1,
    confidence: 0.9,
    evidence: {},
    model: "gambit-detectors-v1",
  });
});

afterAll(async () => {
  await t.close();
});

describe("ownPuzzles", () => {
  it("builds the setup-move contract from a blunder and trims to a solver move", async () => {
    const list = await ownPuzzles(t.db, userId, "standard");
    expect(list.length).toBe(1);
    const puzzle = list[0]!;
    // Setup = the blunder; refutation [b8c6, f1c4, g7g6] is odd → trimmed so
    // the line ends on the solver's move: [d1h5, b8c6, f1c4, g7g6] = 4 ✓
    // (solver plays indices 1 and 3).
    expect(puzzle.movesUci).toEqual(["d1h5", "b8c6", "f1c4", "g7g6"]);
    expect(puzzle.theme).toBe("HANGING_PIECE");
    expect(puzzle.source.opponent).toBe("them");
  });

  it("never serves provisional or degraded blunders", async () => {
    await t.db
      .update(plies)
      .set({ analyzedAtDepth: 12 })
      .where(eq(plies.classification, "BLUNDER"));
    expect((await ownPuzzles(t.db, userId, "standard")).length).toBe(0);
    await t.db
      .update(plies)
      .set({ analyzedAtDepth: 18 })
      .where(eq(plies.classification, "BLUNDER"));
    expect((await ownPuzzles(t.db, userId, "standard")).length).toBe(1);
  });
});
