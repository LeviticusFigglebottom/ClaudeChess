import { and, asc, desc, eq, isNull, lte, or, sql, gte } from "drizzle-orm";
import { ANALYSIS_SETTINGS } from "@/lib/eval";
import { games, plies, repertoireNodes } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { AccountError } from "@/lib/account/types";
import { GamePosition } from "@/lib/chess/position";
import { MAX_BOOK_PLY } from "@/lib/chess/openings";
import {
  bandsForRating,
  fetchExplorerPosition,
  // (live client — enrichment only; the aggregate below is the primary source)
  type ExplorerMove,
  type ExplorerPosition,
} from "@/lib/explorer";
import { fetchAggregatePosition } from "@/lib/explorer/local";
import { userRatingHint } from "./calibration";

/**
 * §9.4 Repertoire EV Optimizer — standard chess only (A1.2: undefined for
 * 960). The tree comes from the Lichess explorer at the user's rating band:
 *
 *   reachProb  = ∏ opponent move frequencies along the path
 *   scoreDelta = expectedScore(move) − expectedScore(weighted alternatives)
 *   EV         = reachProb × scoreDelta × 100        (points per 100 games)
 *   cost       = 1 per novel move, 0.5 when the position transposes
 *   priority   = EV / cost
 *
 * Expansion is best-first by priority with reachProb < 0.005 pruned, capped
 * per build call (the explorer is a shared upstream — politeness beats
 * completeness; builds are incremental and re-runnable). SM-2 drilling and
 * the own-leaks cross-reference live here too.
 */

const REACH_PRUNE = 0.005;
const OPPONENT_FREQ_FLOOR = 0.05;
const FETCH_BUDGET_PER_BUILD = 30;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function totalOf(move: ExplorerMove): number {
  return move.white + move.draws + move.black;
}

function scoreFor(move: ExplorerMove, color: "white" | "black"): number {
  const total = totalOf(move);
  if (total === 0) return 0.5;
  const white = (move.white + move.draws / 2) / total;
  return color === "white" ? white : 1 - white;
}

interface Frontier {
  fen: string;
  reachProb: number;
  /** Moves already played to reach here (for transposition detection only). */
  depth: number;
}

/**
 * §9.4 explorer read, LOCAL FIRST (Task 2b): the self-hosted aggregate is
 * the primary source — no external dependency; the live explorer is
 * enrichment for positions past the aggregate's pruned book, and its
 * failures surface only when the aggregate had nothing either.
 */
async function explorerPositionLocalFirst(
  db: Db,
  fen: string,
  opts: { speeds: string[]; ratings: string[] }
): Promise<{ position: ExplorerPosition }> {
  const local = await fetchAggregatePosition(db, fen, opts);
  if (local) return { position: local };
  return fetchExplorerPosition(db, fen, opts);
}

export interface BuildResult {
  fetched: number;
  nodesUpserted: number;
  frontierExhausted: boolean;
  /** Set when the explorer upstream refused mid-build (build resumes later). */
  upstreamError: string | null;
}

export async function buildRepertoireTree(
  db: Db,
  userId: string,
  color: "white" | "black"
): Promise<BuildResult> {
  const rating = await userRatingHint(db, userId);
  const ratingBand = bandsForRating(rating).join("+");
  const speeds = ["blitz", "rapid", "classical"];

  const known = new Set(
    (
      await db
        .select({ fen: repertoireNodes.fen })
        .from(repertoireNodes)
        .where(and(eq(repertoireNodes.userId, userId), eq(repertoireNodes.color, color)))
    ).map((row) => row.fen)
  );

  let fetched = 0;
  let nodesUpserted = 0;
  let upstreamError: string | null = null;
  const seen = new Set<string>();
  // Priority frontier of USER-to-move positions.
  const frontier: Frontier[] = [];
  if (color === "white") {
    frontier.push({ fen: START_FEN, reachProb: 1, depth: 0 });
  } else {
    // Black's tree starts one opponent move in: branch over White's replies.
    let position: ExplorerPosition;
    try {
      position = (
        await explorerPositionLocalFirst(db, START_FEN, { speeds, ratings: ratingBand.split("+") })
      ).position;
      fetched++;
    } catch (error) {
      return {
        fetched: 0,
        nodesUpserted: 0,
        frontierExhausted: false,
        upstreamError: error instanceof Error ? error.message : "explorer unavailable",
      };
    }
    const total = position.moves.reduce((sum, move) => sum + totalOf(move), 0);
    for (const move of position.moves) {
      const freq = total > 0 ? totalOf(move) / total : 0;
      if (freq < OPPONENT_FREQ_FLOOR) continue;
      const next = GamePosition.fromFen(START_FEN, "standard");
      if (!next.moveUci(move.uci)) continue;
      frontier.push({ fen: next.fen(), reachProb: freq, depth: 1 });
    }
  }

  while (frontier.length > 0 && fetched < FETCH_BUDGET_PER_BUILD) {
    frontier.sort((a, b) => b.reachProb - a.reachProb);
    const node = frontier.shift()!;
    if (node.reachProb < REACH_PRUNE) continue;
    if (seen.has(node.fen)) continue;
    seen.add(node.fen);

    let position: ExplorerPosition;
    try {
      const result = await explorerPositionLocalFirst(db, node.fen, {
        speeds,
        ratings: ratingBand.split("+"),
      });
      position = result.position;
      fetched++;
    } catch (error) {
      upstreamError = error instanceof Error ? error.message : "explorer unavailable";
      break; // resume on the next build call
    }
    const moves = position.moves.filter((move) => totalOf(move) >= 50);
    if (moves.length === 0) continue;

    // Weighted expected score of ALL candidate moves = the baseline.
    const grandTotal = moves.reduce((sum, move) => sum + totalOf(move), 0);
    const baseline = moves.reduce(
      (sum, move) => sum + scoreFor(move, color) * (totalOf(move) / grandTotal),
      0
    );

    for (const move of moves) {
      const scoreDelta = scoreFor(move, color) - baseline;
      const ev = node.reachProb * scoreDelta * 100;
      const probe = GamePosition.fromFen(node.fen, "standard");
      const legal = probe.moveUci(move.uci);
      if (!legal) continue;
      const resultingFen = probe.fen();
      const transposes = known.has(resultingFen) || seen.has(resultingFen);
      const cost = transposes ? 0.5 : 1;
      const priority = ev / cost;
      await db
        .insert(repertoireNodes)
        .values({
          userId,
          color,
          fen: node.fen,
          moveUci: move.uci,
          san: move.san,
          reachProb: node.reachProb,
          ratingBand,
          whiteWins: move.white,
          draws: move.draws,
          blackWins: move.black,
          evPerNode: ev,
          scoreDelta,
          cost,
          priority,
        })
        .onConflictDoUpdate({
          target: [
            repertoireNodes.userId,
            repertoireNodes.color,
            repertoireNodes.fen,
            repertoireNodes.moveUci,
          ],
          set: {
            reachProb: node.reachProb,
            ratingBand,
            whiteWins: move.white,
            draws: move.draws,
            blackWins: move.black,
            evPerNode: ev,
            scoreDelta,
            cost,
            priority,
            san: move.san,
          },
        });
      nodesUpserted++;

      // Recommend expanding through the BEST user move only (the repertoire
      // is one move per position); branch over the opponent's replies.
      if (move !== moves.reduce((best, m) => (scoreFor(m, color) > scoreFor(best, color) ? m : best))) {
        continue;
      }
      try {
        const reply = await explorerPositionLocalFirst(db, resultingFen, {
          speeds,
          ratings: ratingBand.split("+"),
        });
        fetched++;
        const replyTotal = reply.position.moves.reduce((sum, m) => sum + totalOf(m), 0);
        for (const opponentMove of reply.position.moves) {
          const freq = replyTotal > 0 ? totalOf(opponentMove) / replyTotal : 0;
          if (freq < OPPONENT_FREQ_FLOOR) continue;
          const nextReach = node.reachProb * freq;
          if (nextReach < REACH_PRUNE) continue;
          const after = GamePosition.fromFen(resultingFen, "standard");
          if (!after.moveUci(opponentMove.uci)) continue;
          frontier.push({ fen: after.fen(), reachProb: nextReach, depth: node.depth + 2 });
        }
      } catch (error) {
        upstreamError = error instanceof Error ? error.message : "explorer unavailable";
        break;
      }
    }
  }

  return {
    fetched,
    nodesUpserted,
    frontierExhausted: frontier.length === 0,
    upstreamError,
  };
}

export interface ToLearnRow {
  id: string;
  fen: string;
  moveUci: string;
  san: string | null;
  reachProb: number;
  evPerNode: number;
  priority: number;
  status: string;
  isLeak: boolean;
  dueAt: string | null;
}

export async function toLearnList(
  db: Db,
  userId: string,
  color: "white" | "black",
  limit = 40
): Promise<ToLearnRow[]> {
  const rows = await db
    .select()
    .from(repertoireNodes)
    .where(
      and(
        eq(repertoireNodes.userId, userId),
        eq(repertoireNodes.color, color),
        sql`${repertoireNodes.priority} > 0`
      )
    )
    .orderBy(desc(repertoireNodes.isLeak), desc(repertoireNodes.priority))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    fen: row.fen,
    moveUci: row.moveUci,
    san: row.san,
    reachProb: row.reachProb,
    evPerNode: row.evPerNode,
    priority: row.priority,
    status: row.status,
    isLeak: row.isLeak,
    dueAt: row.dueAt?.toISOString() ?? null,
  }));
}

/** Nodes due for SM-2 review (dueAt passed, or started but never scheduled). */
export async function dueDrills(
  db: Db,
  userId: string,
  color: "white" | "black",
  limit = 20
): Promise<ToLearnRow[]> {
  const rows = await db
    .select()
    .from(repertoireNodes)
    .where(
      and(
        eq(repertoireNodes.userId, userId),
        eq(repertoireNodes.color, color),
        or(
          lte(repertoireNodes.dueAt, new Date()),
          and(isNull(repertoireNodes.dueAt), eq(repertoireNodes.status, "learning"))
        )
      )
    )
    .orderBy(asc(repertoireNodes.dueAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    fen: row.fen,
    moveUci: row.moveUci,
    san: row.san,
    reachProb: row.reachProb,
    evPerNode: row.evPerNode,
    priority: row.priority,
    status: row.status,
    isLeak: row.isLeak,
    dueAt: row.dueAt?.toISOString() ?? null,
  }));
}

/** Classic SM-2 update. quality 0..5; below 3 resets repetitions. */
export function sm2Next(
  state: { easeFactor: number; intervalDays: number; repetitions: number },
  quality: number
): { easeFactor: number; intervalDays: number; repetitions: number } {
  const q = Math.max(0, Math.min(5, Math.round(quality)));
  const easeFactor = Math.max(1.3, state.easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (q < 3) return { easeFactor, intervalDays: 1, repetitions: 0 };
  const repetitions = state.repetitions + 1;
  const intervalDays =
    repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(state.intervalDays * easeFactor);
  return { easeFactor, intervalDays: Math.max(1, intervalDays), repetitions };
}

export async function recordDrill(
  db: Db,
  userId: string,
  nodeId: string,
  quality: number
): Promise<{ status: string; dueAt: string }> {
  const node = (
    await db.select().from(repertoireNodes).where(eq(repertoireNodes.id, nodeId))
  )[0];
  if (!node || node.userId !== userId) throw new AccountError("not_found", "No such node.", 404);
  const next = sm2Next(
    { easeFactor: node.easeFactor, intervalDays: node.intervalDays, repetitions: node.repetitions },
    quality
  );
  const dueAt = new Date(Date.now() + next.intervalDays * 86_400_000);
  const status = next.repetitions >= 3 ? "known" : "learning";
  await db
    .update(repertoireNodes)
    .set({
      easeFactor: next.easeFactor,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      dueAt,
      status,
      lastReviewedAt: new Date(),
    })
    .where(eq(repertoireNodes.id, nodeId));
  return { status, dueAt: dueAt.toISOString() };
}

/**
 * §9.4's second output: the user's own leaks — book-window moves from
 * their standard games whose explorer scoreDelta is clearly negative.
 * Those nodes jump to the top of the to-learn list (isLeak).
 */
export async function computeLeaks(
  db: Db,
  userId: string,
  color: "white" | "black"
): Promise<{ scanned: number; leaks: number }> {
  const rating = await userRatingHint(db, userId);
  const ratingBand = bandsForRating(rating).join("+");
  const speeds = ["blitz", "rapid", "classical"];

  const own = await db
    .select({
      fenBefore: plies.fenBefore,
      uci: plies.uci,
      san: plies.san,
      ply: plies.ply,
    })
    .from(plies)
    .innerJoin(games, eq(plies.gameId, games.id))
    .where(
      and(
        eq(games.userId, userId),
        eq(plies.degraded, false),
        // Progressive depth: provisional (pass-1) plies are §9-excluded.
        gte(plies.analyzedAtDepth, ANALYSIS_SETTINGS.review.depth),
        eq(games.variant, "standard"),
        eq(games.userColor, color),
        eq(plies.color, color),
        lte(plies.ply, MAX_BOOK_PLY)
      )
    );
  // Frequency of (position, played move) across the user's own games.
  const byPosition = new Map<
    string,
    { fen: string; moves: Map<string, { count: number; san: string }> }
  >();
  for (const row of own) {
    const epd = row.fenBefore.split(" ").slice(0, 4).join(" ");
    const bucket = byPosition.get(epd) ?? { fen: row.fenBefore, moves: new Map() };
    const entry = bucket.moves.get(row.uci) ?? { count: 0, san: row.san };
    entry.count += 1;
    bucket.moves.set(row.uci, entry);
    byPosition.set(epd, bucket);
  }

  let scanned = 0;
  let leaks = 0;
  let fetches = 0;
  for (const [, bucket] of [...byPosition.entries()].sort(
    (a, b) =>
      [...b[1].moves.values()].reduce((s, m) => s + m.count, 0) -
      [...a[1].moves.values()].reduce((s, m) => s + m.count, 0)
  )) {
    if (fetches >= 25) break;
    const repeated = [...bucket.moves.entries()].filter(([, entry]) => entry.count >= 2);
    if (repeated.length === 0) continue;
    const fen = bucket.fen;
    let position: ExplorerPosition;
    try {
      position = (await explorerPositionLocalFirst(db, fen, { speeds, ratings: ratingBand.split("+") }))
        .position;
      fetches++;
    } catch {
      break;
    }
    const candidates = position.moves.filter((move) => totalOf(move) >= 50);
    if (candidates.length < 2) continue;
    const grandTotal = candidates.reduce((sum, move) => sum + totalOf(move), 0);
    const baseline = candidates.reduce(
      (sum, move) => sum + scoreFor(move, color) * (totalOf(move) / grandTotal),
      0
    );
    for (const [uci, entry] of repeated) {
      scanned++;
      const played = candidates.find((move) => move.uci === uci);
      if (!played) continue;
      const scoreDelta = scoreFor(played, color) - baseline;
      if (scoreDelta >= -0.02) continue; // not clearly −EV
      leaks++;
      await db
        .insert(repertoireNodes)
        .values({
          userId,
          color,
          fen,
          moveUci: uci,
          san: entry.san,
          reachProb: 1,
          ratingBand,
          whiteWins: played.white,
          draws: played.draws,
          blackWins: played.black,
          evPerNode: scoreDelta * 100,
          scoreDelta,
          cost: 1,
          priority: Math.abs(scoreDelta) * 100,
          isLeak: true,
        })
        .onConflictDoUpdate({
          target: [
            repertoireNodes.userId,
            repertoireNodes.color,
            repertoireNodes.fen,
            repertoireNodes.moveUci,
          ],
          set: {
            isLeak: true,
            scoreDelta,
            evPerNode: scoreDelta * 100,
            priority: Math.abs(scoreDelta) * 100,
          },
        });
    }
  }
  return { scanned, leaks };
}
