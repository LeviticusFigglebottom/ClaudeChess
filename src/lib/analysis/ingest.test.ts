import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { games, plies } from "@/db/schema";
import { ensureUser, type AuthShape } from "@/lib/account";
import { createTestDb, type TestDb } from "@/lib/account/test-db";
import { GamePosition } from "@/lib/chess/position";
import { createTablebaseClient } from "./tablebase";
import { ingestPositionEvals, precacheFromEvalCache, type IngestPosition } from "./ingest";

/**
 * Client-batch ingest semantics (the §3.3 revision): raw client lines run
 * through the SAME derivation as the server-search path. Pinned here:
 * progressive tiers only move a row UP (12 → 18 → 24-verify), provisional
 * rows are invisible to the verify pass, the verify tier applies §4.2 band
 * semantics with neighbour refresh, and garbage lines never land.
 *
 * The test game is chess960-flagged (standard start): BOOK never fires
 * outside variant === "standard", so band classifications stay assertable.
 */

let t: TestDb;
let gameId: string;
let userId: string;

// 1.a3 a6 2.h3 h6 — no tactics, evals fully controlled by the test.
const MOVES = ["a2a3", "a7a6", "h2h3", "h7h6"];
const fens: string[] = [];

const tb = () => createTablebaseClient(t.db, { enabled: false });

/**
 * Three engine lines for a position (full review MultiPV — the eval cache
 * only serves full-quality rows): cp is SIDE-TO-MOVE POV, as UCI speaks.
 * The pvs deliberately differ from the move actually played — a pv1 equal
 * to the played move classifies BEST and would bypass the loss bands the
 * tests pin — and the cp gaps stay small so GREAT never fires.
 */
function line(fen: string, cp: number, depth: number, excludeUci?: string) {
  const position = GamePosition.fromFen(fen, "chess960");
  const moves = position
    .legalMovesUci()
    .filter((uci) => uci !== excludeUci)
    .slice(0, 3);
  return moves.map((uci, i) => ({
    multipv: i + 1,
    depth,
    scoreCp: cp - i * 20,
    mateIn: null,
    pv: [uci],
  }));
}

function position(index: number, cp: number, depth: number): IngestPosition {
  return { index, depth, lines: line(fens[index]!, cp, depth, MOVES[index]) };
}

async function rowsNow() {
  return t.db.select().from(plies).where(eq(plies.gameId, gameId)).orderBy(asc(plies.ply));
}

// Side-to-move POV cps per position for the base passes: ply 2 (a7a6) is
// engineered to lose ≈9.1 wp (INACCURACY, inside the §4.2 window).
const BASE_CPS = [0, 0, 100, -100, 100];

beforeAll(async () => {
  t = await createTestDb();
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: false,
    email: `${randomUUID()}@example.com`,
    emailConfirmedAt: new Date().toISOString(),
  };
  const { user } = await ensureUser(t.db, auth);
  userId = user.id;

  const replay = GamePosition.initial("standard");
  fens.push(replay.fen());
  const plyRows = MOVES.map((uci, index) => {
    const fenBefore = replay.fen();
    const move = replay.moveUci(uci);
    if (!move) throw new Error(`illegal test move ${uci}`);
    fens.push(replay.fen());
    return {
      ply: index + 1,
      moveNumber: Math.floor(index / 2) + 1,
      color: (index % 2 === 0 ? "white" : "black") as "white" | "black",
      san: move.san,
      uci,
      fenBefore,
      fenAfter: replay.fen(),
      clockMsRemaining: null,
      timeSpentMs: null,
    };
  });

  const inserted = await t.db
    .insert(games)
    .values({
      userId,
      variant: "chess960",
      startFen: null,
      source: "local",
      pgn: "",
      whiteName: "w",
      blackName: "b",
      userColor: "white",
      result: "1-0",
      playedAt: new Date(),
      importedAt: new Date(),
    })
    .returning();
  gameId = inserted[0]!.id;
  await t.db.insert(plies).values(plyRows.map((row) => ({ ...row, gameId })));
});

afterAll(async () => {
  await t.close();
});

describe("client-batch ingest", () => {
  it("pass 1 (d12) writes provisional classifications the verify pass cannot see", async () => {
    const result = await ingestPositionEvals(
      t.db,
      gameId,
      userId,
      tb(),
      BASE_CPS.map((cp, index) => position(index, cp, 12))
    );
    expect(result.written).toBe(4);
    expect(result.provisionalRemaining).toBe(4);
    // Ply 2's loss (≈9.1) is inside the §4.2 window — but a d12 row is
    // provisional and MUST NOT be selected for verification.
    expect(result.verifyRemaining).toBe(0);
    const rows = await rowsNow();
    expect(rows.every((row) => row.classification !== null)).toBe(true);
    expect(rows.every((row) => row.analyzedAtDepth === 12)).toBe(true);
    expect(rows[1]!.classification).toBe("INACCURACY");
    expect(rows[1]!.wpLoss).toBeGreaterThan(8);
    expect(rows[1]!.wpLoss).toBeLessThan(10);
  });

  it("pass 2 (d18) refines in place and clears the provisional state", async () => {
    const result = await ingestPositionEvals(
      t.db,
      gameId,
      userId,
      tb(),
      BASE_CPS.map((cp, index) => position(index, cp, 18))
    );
    expect(result.written).toBe(4);
    expect(result.provisionalRemaining).toBe(0);
    // Now at review depth, the borderline ply becomes a verify target.
    expect(result.verifyRemaining).toBe(1);
    const rows = await rowsNow();
    expect(rows.every((row) => row.analyzedAtDepth === 18)).toBe(true);
  });

  it("a stale d12 replay never downgrades a refined row", async () => {
    const result = await ingestPositionEvals(t.db, gameId, userId, tb(), [
      position(0, 0, 12),
      position(1, 0, 12),
    ]);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    const rows = await rowsNow();
    expect(rows[0]!.analyzedAtDepth).toBe(18);
  });

  it("the d24 tier applies §4.2 verify semantics to borderline plies only", async () => {
    const result = await ingestPositionEvals(t.db, gameId, userId, tb(), [
      // Borderline ply 2's pair, deeper eval decisive → BLUNDER band.
      position(1, 0, 24),
      { index: 2, depth: 24, lines: line(fens[2]!, 250, 24, MOVES[2]) },
      // Non-borderline pair (ply 4, loss ≈ 0) — must be refused.
      position(3, -100, 24),
      position(4, 100, 24),
    ]);
    expect(result.verified).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const rows = await rowsNow();
    expect(rows[1]!.classification).toBe("BLUNDER");
    expect(rows[1]!.analyzedAtDepth).toBe(24);
    expect(rows[1]!.wpLoss).toBeGreaterThan(20);
    // Neighbour refresh: ply 3 rides the one-eval-per-position chain — its
    // refreshed loss (71.5 − 59.1 ≈ 12.4) crosses the 10-wp boundary.
    expect(rows[2]!.wpBefore).toBeCloseTo(71.5, 0);
    expect(rows[2]!.classification).toBe("MISTAKE");
    // Ply 4 untouched by the refused pair.
    expect(rows[3]!.analyzedAtDepth).toBe(18);
  });

  it("rejects garbage lines instead of storing them", async () => {
    const result = await ingestPositionEvals(t.db, gameId, userId, tb(), [
      { index: 0, depth: 18, lines: [{ multipv: 1, depth: 18, scoreCp: 0, mateIn: null, pv: ["e2e5"] }] },
      { index: 5, depth: 18, lines: [] },
      { index: 1, depth: 44 as never, lines: [] },
    ]);
    expect(result.written).toBe(0);
    expect(result.invalid).toBe(3);
  });

  it("refuses another user's game", async () => {
    await expect(
      ingestPositionEvals(t.db, gameId, randomUUID(), tb(), [position(0, 0, 18)])
    ).rejects.toThrow("game_missing");
  });

  it("precache serves a second game's shared opening from the eval cache", async () => {
    // Same user, same moves — the write-through from the earlier passes
    // must cover this game with ZERO lines supplied.
    const replay = GamePosition.initial("standard");
    const plyRows = MOVES.map((uci, index) => {
      const fenBefore = replay.fen();
      const move = replay.moveUci(uci)!;
      return {
        ply: index + 1,
        moveNumber: Math.floor(index / 2) + 1,
        color: (index % 2 === 0 ? "white" : "black") as "white" | "black",
        san: move.san,
        uci,
        fenBefore,
        fenAfter: replay.fen(),
        clockMsRemaining: null,
        timeSpentMs: null,
      };
    });
    const inserted = await t.db
      .insert(games)
      .values({
        userId,
        variant: "chess960",
        startFen: null,
        source: "local",
        pgn: "",
        whiteName: "w",
        blackName: "b",
        userColor: "white",
        result: "0-1",
        playedAt: new Date(),
        importedAt: new Date(),
      })
      .returning();
    const secondGameId = inserted[0]!.id;
    await t.db.insert(plies).values(plyRows.map((row) => ({ ...row, gameId: secondGameId })));

    const result = await precacheFromEvalCache(t.db, secondGameId, userId, tb(), 18);
    expect(result.covered).toBe(4);
    const rows = await t.db
      .select()
      .from(plies)
      .where(eq(plies.gameId, secondGameId))
      .orderBy(asc(plies.ply));
    expect(rows.every((row) => row.classification !== null)).toBe(true);
    expect(rows.every((row) => (row.analyzedAtDepth ?? 0) >= 18)).toBe(true);
    // A different user gets no coverage from this cache.
    await expect(
      precacheFromEvalCache(t.db, secondGameId, randomUUID(), tb(), 18)
    ).rejects.toThrow("game_missing");
  });
});
