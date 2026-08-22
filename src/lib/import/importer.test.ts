import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { games, plies } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/account/test-db";
import type { AuthShape, UserRow } from "@/lib/account/types";
import { ensureUser } from "@/lib/account/users";
import {
  linkAccount,
  listLinkedAccounts,
  runImportChunk,
  setAutoImport,
  unlinkAccount,
} from "./importer";
import type { FetchLike } from "./platforms";

/**
 * Import pipeline tests (Phase 2, C1): incremental, resumable, deduplicated,
 * clock-preserving — against the real schema in PGlite with a fake network.
 */

let t: TestDb;
let user: UserRow;

beforeAll(async () => {
  t = await createTestDb();
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: false,
    email: "imp@example.com",
    emailConfirmedAt: new Date().toISOString(),
  };
  user = (await ensureUser(t.db, auth, { desiredHandle: "importer-1" })).user;
}, 60_000);
afterAll(async () => {
  await t.close();
});

const CHESSCOM_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "TestUser"]
[Black "OtherGuy"]
[Result "1-0"]
[TimeControl "300+3"]
[Termination "TestUser won by checkmate"]

1. e4 {[%clk 0:05:00]} e5 {[%clk 0:04:58]} 2. Qh5 {[%clk 0:04:57]} Nc6 {[%clk 0:04:50]} 3. Bc4 {[%clk 0:04:55]} Nf6 {[%clk 0:04:44]} 4. Qxf7# {[%clk 0:04:52]} 1-0`;

function chesscomFetch(overrides: { archives?: string[]; games?: unknown[] } = {}): FetchLike {
  return async (url) => {
    if (url.endsWith("/games/archives")) {
      return Response.json({
        archives: overrides.archives ?? [
          "https://api.chess.com/pub/player/testuser/games/2026/07",
        ],
      });
    }
    if (url.includes("/games/2026/07")) {
      return Response.json({
        games:
          overrides.games ??
          [
            {
              url: "https://www.chess.com/game/live/1",
              uuid: "uuid-1",
              pgn: CHESSCOM_PGN,
              time_control: "300+3",
              end_time: 1_752_000_000,
              rated: true,
              rules: "chess",
              time_class: "blitz",
              white: { username: "TestUser", rating: 1200, result: "win" },
              black: { username: "OtherGuy", rating: 1180, result: "checkmated" },
            },
            {
              url: "https://www.chess.com/game/live/2",
              uuid: "uuid-2",
              pgn: CHESSCOM_PGN,
              time_control: "300",
              end_time: 1_752_000_500,
              rated: false,
              rules: "bughouse",
              time_class: "blitz",
              white: { username: "TestUser", rating: 1200, result: "win" },
              black: { username: "OtherGuy", rating: 1180, result: "resigned" },
            },
          ],
      });
    }
    if (url.endsWith("/pub/player/testuser")) return Response.json({ username: "testuser" });
    return new Response("not found", { status: 404 });
  };
}

const LICHESS_STREAM = `[Event "Rated blitz game"]
[Site "https://lichess.org/aaaa1111"]
[Date "2026.07.01"]
[White "liUser"]
[Black "Someone"]
[Result "0-1"]
[UTCDate "2026.07.01"]
[UTCTime "10:00:00"]
[Variant "Standard"]
[TimeControl "180+2"]
[ECO "B01"]
[Opening "Scandinavian Defense"]

1. e4 {[%clk 0:03:00]} d5 {[%clk 0:03:00]} 2. exd5 {[%clk 0:02:59]} Qxd5 {[%clk 0:03:00]} 0-1

[Event "Casual bullet game"]
[Site "https://lichess.org/bbbb2222"]
[White "Someone"]
[Black "liUser"]
[Result "1/2-1/2"]
[UTCDate "2026.07.02"]
[UTCTime "11:00:00"]
[Variant "Atomic"]
[TimeControl "60+0"]

1. e4 e5 1/2-1/2
`;

function lichessFetch(): FetchLike {
  return async (url) => {
    if (url.includes("/api/user/liuser") || url.includes("/api/user/liUser")) {
      return Response.json({ id: "liuser" });
    }
    if (url.includes("/api/games/user/")) {
      return new Response(LICHESS_STREAM, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("linked accounts", () => {
  it("links after existence check, lists, toggles auto-import, unlinks", async () => {
    const view = await linkAccount(t.db, user.id, "chesscom", "TestUser", chesscomFetch());
    expect(view.verified).toBe(false); // no ownership proof exists (kickoff)
    await setAutoImport(t.db, user.id, "chesscom", true);
    const listed = await listLinkedAccounts(t.db, user.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.autoImport).toBe(true);
    await unlinkAccount(t.db, user.id, "chesscom");
    expect(await listLinkedAccounts(t.db, user.id)).toHaveLength(0);
  });

  it("rejects unknown players and junk usernames", async () => {
    await expect(
      linkAccount(t.db, user.id, "chesscom", "NoSuchPlayer", async () =>
        new Response("nope", { status: 404 })
      )
    ).rejects.toMatchObject({ code: "player_not_found" });
    await expect(
      linkAccount(t.db, user.id, "lichess", "bad name!", lichessFetch())
    ).rejects.toMatchObject({ code: "bad_username" });
  });
});

describe("chess.com import", () => {
  it("imports supported games with clocks, skips unsupported rules, dedupes on re-run", async () => {
    await linkAccount(t.db, user.id, "chesscom", "TestUser", chesscomFetch());
    const first = await runImportChunk(t.db, user, "chesscom", { fetchFn: chesscomFetch() });
    expect(first.imported).toBe(1);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]?.reason).toContain("bughouse");
    expect(first.done).toBe(true);

    const gameRows = await t.db
      .select()
      .from(games)
      .where(eq(games.userId, user.id));
    const imported = gameRows.find((g) => g.externalId === "uuid-1")!;
    expect(imported.source).toBe("chesscom");
    expect(imported.userColor).toBe("white");
    expect(imported.result).toBe("1-0");
    expect(imported.eco).toBeTruthy(); // opening matched from the dataset

    const plyRows = await t.db
      .select()
      .from(plies)
      .where(eq(plies.gameId, imported.id));
    expect(plyRows).toHaveLength(7);
    // §9.3: every ply of a %clk game has non-null timeSpentMs.
    expect(plyRows.every((p) => p.timeSpentMs !== null)).toBe(true);
    expect(plyRows.every((p) => p.clockMsRemaining !== null)).toBe(true);
    // Analysis fields await Phase 2's batch pass.
    expect(plyRows.every((p) => p.evalBeforeCp === null)).toBe(true);

    // Re-run: same archive, everything already imported → duplicates, not rows.
    const second = await runImportChunk(t.db, user, "chesscom", {
      fetchFn: chesscomFetch(),
      // cursor moved past both games — chunk sees nothing newer
    });
    expect(second.imported).toBe(0);
    const countAfter = await t.db.select().from(games).where(eq(games.userId, user.id));
    expect(countAfter.length).toBe(gameRows.length);
  });
});

describe("lichess import", () => {
  it("imports the stream, skips unsupported variants, records the cursor", async () => {
    await linkAccount(t.db, user.id, "lichess", "liUser", lichessFetch());
    const result = await runImportChunk(t.db, user, "lichess", { fetchFn: lichessFetch() });
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("Atomic");
    expect(result.done).toBe(true);
    expect(result.lastImportedAt).toBe("2026-07-02T11:00:00.000Z");

    const row = (
      await t.db.select().from(games).where(eq(games.userId, user.id))
    ).find((g) => g.externalId === "aaaa1111")!;
    expect(row.userColor).toBe("white");
    expect(row.opening).toBe("Scandinavian Defense");
    expect(row.pgn).toContain('[Site "https://lichess.org/aaaa1111"]');
    expect(row.pgn).not.toContain("bbbb2222");
  });
});
