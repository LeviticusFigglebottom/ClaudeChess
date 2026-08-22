import { and, eq, lt, sql } from "drizzle-orm";
import { games, liveGameEvents, liveGames, ratings, users } from "@/db/schema";
import { AccountError, type Db } from "@/lib/account/types";
import { recordRatedResult, type TimeControlBucket } from "@/lib/account/games";
import { GamePosition } from "@/lib/chess/position";
import { writePgn } from "@/lib/chess/pgn";
import { openingForGame } from "@/lib/chess/openings";
import type { VariantId } from "@/lib/chess/variant";
import {
  applyMove as clockApplyMove,
  isFlagged,
  remainingMs,
  remainingRawMs,
  timeControlBucket,
  type ClockConfig,
  type ClockState,
} from "@/lib/clock/clock";

/**
 * Live multiplayer (Phase 4, §8): THE SERVER IS AUTHORITATIVE on clock and
 * legality. Every action runs in a transaction under a per-game advisory
 * lock; moves replay through the rules facade against the server's own
 * position; clocks are charged with the same clock module the UI renders
 * (A3.6 — fischer/bronstein/delay live, daily via per-move deadlines swept
 * by cron); flag claims are verified against server arithmetic and the
 * verified remaining time is recorded in the end event (the Phase 4 gate's
 * drift measurement reads it). Premoves (A3.5) are a client convenience
 * that arrive here as perfectly ordinary moves — validation is NEVER
 * skipped.
 */

export type LiveClockMode = "fischer" | "bronstein" | "delay" | "daily";

export interface LiveClockSpec {
  mode: LiveClockMode;
  initialMs: number;
  incrementMs: number;
}

const ABORT_WINDOW_MS = 30_000;

type LiveRow = typeof liveGames.$inferSelect;

function liveConfig(row: LiveRow): ClockConfig {
  return {
    mode: row.clockMode === "daily" ? "fischer" : (row.clockMode as ClockConfig["mode"]),
    initialMs: row.clockInitialMs,
    incrementMs: row.clockIncrementMs,
  };
}

function clockStateOf(row: LiveRow): ClockState {
  return {
    config: liveConfig(row),
    whiteMs: row.clockWhiteMs,
    blackMs: row.clockBlackMs,
    turn: row.turn === "white" ? "w" : "b",
    turnStartedAt: row.turnStartedAt?.getTime() ?? null,
    flagged: null,
  };
}

/** Server-side remaining ms per color at `now` (daily = per-move budget). */
export function serverClocks(row: LiveRow, now: number): { whiteMs: number; blackMs: number } {
  if (row.clockMode === "daily") {
    const elapsed = row.turnStartedAt ? now - row.turnStartedAt.getTime() : 0;
    const remaining = Math.max(0, row.clockInitialMs - elapsed);
    return {
      whiteMs: row.turn === "white" ? remaining : row.clockInitialMs,
      blackMs: row.turn === "black" ? remaining : row.clockInitialMs,
    };
  }
  const state = clockStateOf(row);
  return { whiteMs: remainingMs(state, "w", now), blackMs: remainingMs(state, "b", now) };
}

function positionOf(row: LiveRow): GamePosition {
  const position = GamePosition.fromFen(row.startFen, row.variant as VariantId);
  for (const uci of row.movesUci.split(" ").filter(Boolean)) {
    if (!position.moveUci(uci)) {
      throw new AccountError("state_corrupt", "Server game state failed to replay.", 500);
    }
  }
  return position;
}

async function appendEvent(
  tx: Db,
  gameId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  await tx.insert(liveGameEvents).values({ gameId, seq, type, payload });
}

export interface CreateLiveGameInput {
  whiteUserId: string;
  blackUserId: string;
  variant: VariantId;
  startFen?: string;
  startPositionId?: number | null;
  clock: LiveClockSpec;
  rated: boolean;
}

export async function createLiveGame(db: Db, input: CreateLiveGameInput): Promise<LiveRow> {
  const startFen =
    input.startFen ??
    (input.variant === "chess960"
      ? GamePosition.fromChess960(input.startPositionId ?? Math.floor(Math.random() * 960)).startFen
      : GamePosition.initial(input.variant === "standard" ? "standard" : input.variant).fen());
  const inserted = await db
    .insert(liveGames)
    .values({
      whiteUserId: input.whiteUserId,
      blackUserId: input.blackUserId,
      variant: input.variant,
      startFen,
      startPositionId: input.startPositionId ?? null,
      clockMode: input.clock.mode,
      clockInitialMs: input.clock.initialMs,
      clockIncrementMs: input.clock.incrementMs,
      rated: input.rated,
      fen: startFen,
      clockWhiteMs: input.clock.initialMs,
      clockBlackMs: input.clock.initialMs,
      turnStartedAt: new Date(),
      seq: 1,
    })
    .returning();
  const row = inserted[0]!;
  await appendEvent(db, row.id, 1, "start", { startFen });
  return row;
}

export interface LiveStateView {
  id: string;
  status: "active" | "finished" | "aborted";
  variant: string;
  startFen: string;
  white: { id: string; handle: string; rating: number | null };
  black: { id: string; handle: string; rating: number | null };
  movesUci: string[];
  movesSan: string[];
  fen: string;
  turn: "white" | "black";
  seq: number;
  rated: boolean;
  clockMode: LiveClockMode;
  clockInitialMs: number;
  clockIncrementMs: number;
  /** Server-computed remaining at `at` (epoch ms) — clients render offsets from this. */
  clocks: { whiteMs: number; blackMs: number; at: number };
  drawOfferBy: "white" | "black" | null;
  result: string | null;
  termination: string | null;
  yourColor: "white" | "black" | null;
  inCheck: boolean;
}

async function playerView(
  db: Db,
  userId: string,
  variant: string,
  bucket: TimeControlBucket
): Promise<{ id: string; handle: string; rating: number | null }> {
  const user = (await db.select().from(users).where(eq(users.id, userId)))[0];
  const rating = (
    await db
      .select()
      .from(ratings)
      .where(
        and(
          eq(ratings.userId, userId),
          eq(ratings.variant, variant as VariantId),
          eq(ratings.timeControl, bucket)
        )
      )
  )[0];
  return {
    id: userId,
    handle: user?.handle ?? "(gone)",
    rating: rating ? Math.round(rating.rating) : null,
  };
}

export function bucketOf(row: Pick<LiveRow, "clockMode" | "clockInitialMs" | "clockIncrementMs">): TimeControlBucket {
  if (row.clockMode === "daily") return "daily";
  return timeControlBucket({
    mode: row.clockMode as ClockConfig["mode"],
    initialMs: row.clockInitialMs,
    incrementMs: row.clockIncrementMs,
  });
}

export async function getLiveState(
  db: Db,
  gameId: string,
  forUserId: string | null,
  now = Date.now()
): Promise<LiveStateView> {
  let row = (await db.select().from(liveGames).where(eq(liveGames.id, gameId)))[0];
  if (!row) throw new AccountError("game_missing", "No such game.", 404);
  // Lazy flag finalize: the server is authoritative on time, so ANY state
  // read past flagfall ends the game — a throttled or vanished client can
  // never leave a flagged game hanging, and drift is bounded by the poll
  // cadence rather than by client timers.
  if (row.status === "active" && row.clockMode !== "daily") {
    const state = clockStateOf(row);
    if (isFlagged(state, now)) {
      await withGame(db, gameId, async (tx, fresh) => {
        if (fresh.status !== "active") return;
        const freshState = clockStateOf(fresh);
        if (!isFlagged(freshState, now)) return;
        await finishGame(
          tx,
          fresh,
          {
            result: fresh.turn === "white" ? "0-1" : "1-0",
            termination: "time forfeit",
            remainingAtFlagMs: remainingRawMs(freshState, freshState.turn, now),
          },
          now
        );
      });
      row = (await db.select().from(liveGames).where(eq(liveGames.id, gameId)))[0]!;
    }
  }
  const position = positionOf(row);
  const bucket = bucketOf(row);
  const [white, black] = await Promise.all([
    playerView(db, row.whiteUserId, row.variant, bucket),
    playerView(db, row.blackUserId, row.variant, bucket),
  ]);
  return {
    id: row.id,
    status: row.status,
    variant: row.variant,
    startFen: row.startFen,
    white,
    black,
    movesUci: row.movesUci.split(" ").filter(Boolean),
    movesSan: position.historySan(),
    fen: row.fen,
    turn: row.turn,
    seq: row.seq,
    rated: row.rated,
    clockMode: row.clockMode as LiveClockMode,
    clockInitialMs: row.clockInitialMs,
    clockIncrementMs: row.clockIncrementMs,
    clocks: { ...serverClocks(row, now), at: now },
    drawOfferBy: row.drawOfferBy,
    result: row.result,
    termination: row.termination,
    yourColor:
      forUserId === row.whiteUserId
        ? "white"
        : forUserId === row.blackUserId
          ? "black"
          : null,
    inCheck: position.isCheck(),
  };
}

interface FinishInput {
  result: "1-0" | "0-1" | "1/2-1/2";
  termination: string;
  /** Server-verified remaining ms of the flagged side at flagfall (gate metric). */
  remainingAtFlagMs?: number;
}

async function finishGame(tx: Db, row: LiveRow, input: FinishInput, now: number): Promise<void> {
  const seq = row.seq + 1;
  await tx
    .update(liveGames)
    .set({
      status: "finished",
      result: input.result,
      termination: input.termination,
      endedAt: new Date(now),
      seq,
      drawOfferBy: null,
    })
    .where(eq(liveGames.id, row.id));
  await appendEvent(tx, row.id, seq, "end", {
    result: input.result,
    termination: input.termination,
    ...(input.remainingAtFlagMs !== undefined
      ? { remainingAtFlagMs: input.remainingAtFlagMs }
      : {}),
  });

  // Archive: one games row per player (source 'online'), PGN with %clk.
  const position = positionOf(row);
  const history = position.historySan();
  const trail = (row.clockTrailJson as number[]) ?? [];
  const moves = history.map((san, index) => ({
    san,
    clockMsAfter: row.clockMode === "daily" ? undefined : trail[index],
  }));
  const [white, black] = await Promise.all([
    tx.select().from(users).where(eq(users.id, row.whiteUserId)),
    tx.select().from(users).where(eq(users.id, row.blackUserId)),
  ]);
  const whiteName = white[0]?.handle ?? "white";
  const blackName = black[0]?.handle ?? "black";
  const clockConfig: ClockConfig =
    row.clockMode === "daily"
      ? { mode: "fischer", initialMs: row.clockInitialMs, incrementMs: 0 }
      : liveConfig(row);
  let eco: { eco: string; name: string } | null = null;
  if (row.variant === "standard") {
    const replay = GamePosition.fromFen(row.startFen, "standard");
    const epds: string[] = [];
    for (const uci of row.movesUci.split(" ").filter(Boolean)) {
      replay.moveUci(uci);
      epds.push(replay.epd());
    }
    eco = openingForGame(epds);
  }
  const pgn = writePgn(
    {
      white: whiteName,
      black: blackName,
      result: input.result,
      variant: row.variant as VariantId,
      startFen: row.variant === "chess960" ? row.startFen : undefined,
      startPositionId: row.startPositionId ?? undefined,
      clock: clockConfig,
      rated: row.rated,
      playedAt: new Date(now),
      termination: input.termination,
      eco,
    },
    moves
  );
  for (const [userId, color] of [
    [row.whiteUserId, "white"],
    [row.blackUserId, "black"],
  ] as const) {
    await tx
      .insert(games)
      .values({
        userId,
        variant: row.variant,
        startFen: row.variant === "standard" ? null : row.startFen,
        startPositionId: row.startPositionId,
        source: "online",
        externalId: row.id,
        pgn,
        whiteName,
        blackName,
        userColor: color,
        result: input.result,
        termination: input.termination,
        timeControl:
          row.clockMode === "daily"
            ? `1/${Math.round(row.clockInitialMs / 1000)}`
            : `${Math.round(row.clockInitialMs / 1000)}+${Math.round(row.clockIncrementMs / 1000)}`,
        eco: eco?.eco ?? null,
        opening: eco?.name ?? null,
        playedAt: new Date(now),
      })
      .onConflictDoNothing({ target: [games.userId, games.source, games.externalId] });
  }

  // Ratings (§7 period batching via the shared module).
  if (row.rated) {
    const bucket = bucketOf(row);
    const readRating = async (userId: string) => {
      const rating = (
        await tx
          .select()
          .from(ratings)
          .where(
            and(
              eq(ratings.userId, userId),
              eq(ratings.variant, row.variant as VariantId),
              eq(ratings.timeControl, bucket)
            )
          )
      )[0];
      return { rating: rating?.rating ?? 1500, rd: rating?.rd ?? 350 };
    };
    const whiteRating = await readRating(row.whiteUserId);
    const blackRating = await readRating(row.blackUserId);
    const whiteScore = input.result === "1-0" ? 1 : input.result === "0-1" ? 0 : 0.5;
    await recordRatedResult(
      tx,
      row.whiteUserId,
      row.variant as VariantId,
      bucket,
      { opponentRating: blackRating.rating, opponentRd: blackRating.rd, score: whiteScore },
      new Date(now)
    );
    await recordRatedResult(
      tx,
      row.blackUserId,
      row.variant as VariantId,
      bucket,
      {
        opponentRating: whiteRating.rating,
        opponentRd: whiteRating.rd,
        score: (1 - whiteScore) as 0 | 0.5 | 1,
      },
      new Date(now)
    );

    // Fair play (A2.3/B0.5): move-time entropy per player, rated games only.
    const { computeMovetimeEntropy } = await import("./fairplay");
    await computeMovetimeEntropy(tx, row);
  }
}

/** Runs `fn` under the game's advisory lock with a fresh row. */
async function withGame<T>(
  db: Db,
  gameId: string,
  fn: (tx: Db, row: LiveRow) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`live:${gameId}`}))`);
    const row = (await tx.select().from(liveGames).where(eq(liveGames.id, gameId)))[0];
    if (!row) throw new AccountError("game_missing", "No such game.", 404);
    return fn(tx, row);
  });
}

function colorOf(row: LiveRow, userId: string): "white" | "black" {
  if (row.whiteUserId === userId) return "white";
  if (row.blackUserId === userId) return "black";
  throw new AccountError("not_player", "You are not playing this game.", 403);
}

export async function applyLiveMove(
  db: Db,
  gameId: string,
  userId: string,
  uci: string,
  now = Date.now()
): Promise<{ seq: number; finished: boolean }> {
  return withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active") throw new AccountError("game_over", "The game is over.", 409);
    const color = colorOf(row, userId);
    if (row.turn !== color) throw new AccountError("not_your_turn", "Not your turn.", 409);

    // Flag check FIRST — a move after your time ran out is a flag, not a move.
    if (row.clockMode === "daily") {
      const elapsed = row.turnStartedAt ? now - row.turnStartedAt.getTime() : 0;
      if (elapsed > row.clockInitialMs) {
        await finishGame(
          tx,
          row,
          {
            result: color === "white" ? "0-1" : "1-0",
            termination: "time forfeit",
            remainingAtFlagMs: 0,
          },
          now
        );
        return { seq: row.seq + 1, finished: true };
      }
    } else {
      const state = clockStateOf(row);
      if (isFlagged(state, now)) {
        await finishGame(
          tx,
          row,
          {
            result: color === "white" ? "0-1" : "1-0",
            termination: "time forfeit",
            remainingAtFlagMs: remainingRawMs(state, state.turn, now),
          },
          now
        );
        return { seq: row.seq + 1, finished: true };
      }
    }

    // Legality: server-side replay. NEVER skipped — premoves arrive here too (A3.5).
    const position = positionOf(row);
    const move = position.moveUci(uci);
    if (!move) throw new AccountError("illegal", "Illegal move.", 422);

    let clockWhiteMs = row.clockWhiteMs;
    let clockBlackMs = row.clockBlackMs;
    let remainingAfter = row.clockInitialMs;
    if (row.clockMode !== "daily") {
      const next = clockApplyMove(clockStateOf(row), now);
      if (next.flagged) {
        await finishGame(
          tx,
          row,
          {
            result: color === "white" ? "0-1" : "1-0",
            termination: "time forfeit",
            remainingAtFlagMs: 0,
          },
          now
        );
        return { seq: row.seq + 1, finished: true };
      }
      clockWhiteMs = next.whiteMs;
      clockBlackMs = next.blackMs;
      remainingAfter = color === "white" ? next.whiteMs : next.blackMs;
    }

    const seq = row.seq + 1;
    const newFen = position.fen();
    const trail = [...((row.clockTrailJson as number[]) ?? []), remainingAfter];
    await tx
      .update(liveGames)
      .set({
        movesUci: row.movesUci ? `${row.movesUci} ${uci}` : uci,
        fen: newFen,
        turn: color === "white" ? "black" : "white",
        clockWhiteMs,
        clockBlackMs,
        turnStartedAt: new Date(now),
        clockTrailJson: trail,
        seq,
        drawOfferBy: null,
      })
      .where(eq(liveGames.id, row.id));
    await appendEvent(tx, row.id, seq, "move", {
      uci,
      san: move.san,
      fen: newFen,
      by: color,
      clocks: { whiteMs: clockWhiteMs, blackMs: clockBlackMs, at: now },
    });

    // Natural end on the updated position.
    const outcome = position.outcome();
    if (outcome !== null) {
      const fresh = (await tx.select().from(liveGames).where(eq(liveGames.id, row.id)))[0]!;
      const result =
        outcome === "white" ? "1-0" : outcome === "black" ? "0-1" : "1/2-1/2";
      const termination =
        outcome === "draw"
          ? position.isStalemate()
            ? "stalemate"
            : "draw"
          : position.isCheckmate()
            ? "checkmate"
            : "variant end"; // third check delivered / king reached the hill
      await finishGame(tx, fresh, { result, termination }, now);
      return { seq: fresh.seq + 1, finished: true };
    }
    return { seq, finished: false };
  });
}

export async function resignLive(db: Db, gameId: string, userId: string): Promise<void> {
  await withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active") throw new AccountError("game_over", "The game is over.", 409);
    const color = colorOf(row, userId);
    await finishGame(
      tx,
      row,
      { result: color === "white" ? "0-1" : "1-0", termination: "resignation" },
      Date.now()
    );
  });
}

export async function drawAction(
  db: Db,
  gameId: string,
  userId: string,
  action: "offer" | "accept" | "decline"
): Promise<void> {
  await withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active") throw new AccountError("game_over", "The game is over.", 409);
    const color = colorOf(row, userId);
    const other = color === "white" ? "black" : "white";
    if (action === "offer") {
      const seq = row.seq + 1;
      await tx
        .update(liveGames)
        .set({ drawOfferBy: color, seq })
        .where(eq(liveGames.id, row.id));
      await appendEvent(tx, row.id, seq, "draw-offer", { by: color });
      return;
    }
    if (row.drawOfferBy !== other) {
      throw new AccountError("no_offer", "No draw offer to respond to.", 409);
    }
    if (action === "accept") {
      await finishGame(tx, row, { result: "1/2-1/2", termination: "draw agreed" }, Date.now());
    } else {
      const seq = row.seq + 1;
      await tx
        .update(liveGames)
        .set({ drawOfferBy: null, seq })
        .where(eq(liveGames.id, row.id));
      await appendEvent(tx, row.id, seq, "draw-decline", { by: color });
    }
  });
}

/**
 * Flag claim: the CLIENT only claims; the SERVER verifies with its own
 * arithmetic. The verified remaining time at the claim goes into the end
 * event — the gate reads it as the drift measurement.
 */
export async function claimFlag(
  db: Db,
  gameId: string,
  userId: string,
  now = Date.now()
): Promise<{ flagged: boolean; remainingMs: number }> {
  return withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active") throw new AccountError("game_over", "The game is over.", 409);
    colorOf(row, userId); // must be a player
    if (row.clockMode === "daily") {
      const elapsed = row.turnStartedAt ? now - row.turnStartedAt.getTime() : 0;
      const remaining = row.clockInitialMs - elapsed;
      if (remaining > 0) return { flagged: false, remainingMs: remaining };
      await finishGame(
        tx,
        row,
        {
          result: row.turn === "white" ? "0-1" : "1-0",
          termination: "time forfeit",
          remainingAtFlagMs: remaining,
        },
        now
      );
      return { flagged: true, remainingMs: remaining };
    }
    const state = clockStateOf(row);
    const remaining = remainingMs(state, state.turn, now);
    if (!isFlagged(state, now)) return { flagged: false, remainingMs: remaining };
    await finishGame(
      tx,
      row,
      {
        result: row.turn === "white" ? "0-1" : "1-0",
        termination: "time forfeit",
        // Signed: how far past zero the verified claim arrived (drift gate).
        remainingAtFlagMs: remainingRawMs(state, state.turn, now),
      },
      now
    );
    return { flagged: true, remainingMs: remaining };
  });
}

/** Abort: only before both sides have moved, inside the abort window. */
export async function abortLive(db: Db, gameId: string, userId: string): Promise<void> {
  await withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active") throw new AccountError("game_over", "The game is over.", 409);
    colorOf(row, userId);
    const moveCount = row.movesUci.split(" ").filter(Boolean).length;
    const age = Date.now() - row.createdAt.getTime();
    if (moveCount >= 2 && age > ABORT_WINDOW_MS) {
      throw new AccountError("no_abort", "The game can no longer be aborted — resign instead.", 409);
    }
    const seq = row.seq + 1;
    await tx
      .update(liveGames)
      .set({ status: "aborted", termination: "aborted", seq, endedAt: new Date() })
      .where(eq(liveGames.id, row.id));
    await appendEvent(tx, row.id, seq, "abort", { by: userId });
  });
}

/** Tab-blur signal during rated games (A2.3): recorded, never blocking. */
export async function recordBlur(db: Db, gameId: string, userId: string): Promise<void> {
  await withGame(db, gameId, async (tx, row) => {
    if (row.status !== "active" || !row.rated) return;
    const color = colorOf(row, userId);
    const seq = row.seq + 1;
    await tx.update(liveGames).set({ seq }).where(eq(liveGames.id, row.id));
    await appendEvent(tx, row.id, seq, "blur", { by: color });
  });
}

/** The user's most recent active live game (rejoin/redirect helper). */
export async function activeLiveGameFor(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select({ id: liveGames.id, createdAt: liveGames.createdAt })
    .from(liveGames)
    .where(
      and(
        eq(liveGames.status, "active"),
        sql`(${liveGames.whiteUserId} = ${userId} or ${liveGames.blackUserId} = ${userId})`
      )
    )
    .orderBy(sql`${liveGames.createdAt} desc`)
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Correspondence sweep (A3.6): cron flags every daily game whose side to
 * move exceeded the per-move budget. Realtime cannot do this — nobody is
 * connected to a correspondence game at 4am.
 */
export async function sweepDailyTimeouts(db: Db, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - 1);
  const stale = await db
    .select({ id: liveGames.id })
    .from(liveGames)
    .where(
      and(
        eq(liveGames.status, "active"),
        eq(liveGames.clockMode, "daily"),
        lt(
          sql`${liveGames.turnStartedAt} + make_interval(secs => ${sql.raw("clock_initial_ms / 1000.0")})`,
          cutoff
        )
      )
    )
    .limit(200);
  let flagged = 0;
  for (const { id } of stale) {
    await withGame(db, id, async (tx, row) => {
      if (row.status !== "active") return;
      const elapsed = row.turnStartedAt ? now - row.turnStartedAt.getTime() : 0;
      if (elapsed <= row.clockInitialMs) return;
      await finishGame(
        tx,
        row,
        {
          result: row.turn === "white" ? "0-1" : "1-0",
          termination: "time forfeit",
          remainingAtFlagMs: row.clockInitialMs - elapsed,
        },
        now
      );
      flagged++;
    });
  }
  return flagged;
}

export function validateClockSpec(spec: unknown): LiveClockSpec {
  if (typeof spec !== "object" || spec === null) {
    throw new AccountError("clock", "Clock spec required.");
  }
  const { mode, initialMs, incrementMs } = spec as Record<string, unknown>;
  if (mode !== "fischer" && mode !== "bronstein" && mode !== "delay" && mode !== "daily") {
    throw new AccountError("clock", "Clock mode must be fischer, bronstein, delay, or daily.");
  }
  const initial = Number(initialMs);
  const increment = Number(incrementMs ?? 0);
  if (mode === "daily") {
    if (initial < 6 * 3_600_000 || initial > 14 * 86_400_000) {
      throw new AccountError("clock", "Daily games are 6 hours to 14 days per move.");
    }
  } else if (!Number.isFinite(initial) || initial < 60_000 || initial > 3 * 3_600_000) {
    throw new AccountError("clock", "Base time is 1 minute to 3 hours.");
  }
  if (!Number.isFinite(increment) || increment < 0 || increment > 60_000) {
    throw new AccountError("clock", "Increment is 0–60 seconds.");
  }
  return { mode, initialMs: initial, incrementMs: increment };
}
