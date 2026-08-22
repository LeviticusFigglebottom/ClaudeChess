import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { liveGames } from "@/db/schema";
import { createTestDb, type TestDb } from "@/lib/account/test-db";
import { ensureUser } from "@/lib/account/users";
import { createLiveGame, getLiveState, sweepDailyTimeouts } from "@/lib/play/live";

/**
 * A3.6 under the Hobby-tier cron consolidation: correspondence (daily)
 * timeouts finalize LAZILY on state read — the once-daily cron sweep is only
 * a backstop for games nobody loads. A daily sweep alone would leave an
 * expired game hanging for up to 24h.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

async function newDailyGame() {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await ensureUser(t.db, { id: a, isAnonymous: true, email: null, emailConfirmedAt: null });
  await ensureUser(t.db, { id: b, isAnonymous: true, email: null, emailConfirmedAt: null });
  return createLiveGame(t.db, {
    whiteUserId: a,
    blackUserId: b,
    variant: "standard",
    clock: { mode: "daily", initialMs: DAY_MS, incrementMs: 0 },
    rated: false,
  });
}

async function backdateTurnStart(gameId: string, ms: number) {
  await t.db
    .update(liveGames)
    .set({ turnStartedAt: new Date(Date.now() - ms) })
    .where(eq(liveGames.id, gameId));
}

describe("daily (correspondence) timeout finalization", () => {
  it("getLiveState lazily finalizes an expired daily game as a time forfeit", async () => {
    const game = await newDailyGame();
    await backdateTurnStart(game.id, DAY_MS + 60_000);

    const state = await getLiveState(t.db, game.id, null);
    expect(state.status).toBe("finished");
    expect(state.result).toBe("0-1"); // white to move, white flags
    expect(state.termination).toBe("time forfeit");
  });

  it("getLiveState leaves an in-budget daily game active", async () => {
    const game = await newDailyGame();
    await backdateTurnStart(game.id, DAY_MS - 60_000);

    const state = await getLiveState(t.db, game.id, null);
    expect(state.status).toBe("active");
  });

  it("sweepDailyTimeouts remains the backstop for unread games", async () => {
    const game = await newDailyGame();
    await backdateTurnStart(game.id, DAY_MS + 60_000);

    const flagged = await sweepDailyTimeouts(t.db);
    expect(flagged).toBeGreaterThanOrEqual(1);
    const row = (await t.db.select().from(liveGames).where(eq(liveGames.id, game.id)))[0]!;
    expect(row.status).toBe("finished");
  });
});
