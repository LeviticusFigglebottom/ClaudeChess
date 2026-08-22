import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { games, plies, postmortemResponses } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { AccountError } from "@/lib/account/types";
import { cachedJsonCall, evidenceHash, llmAvailable } from "@/lib/llm/client";

/**
 * §9.5 Interrogative Post-Mortem — the one REQUIRED LLM use (C0: the input
 * is the user's free prose about their own thinking; no parser handles
 * that). Gated to isCritical plies, max 5 prompts per game review. The
 * verdict taxonomy is closed; RIGHT_MOVE_WRONG_REASON frequency is tracked
 * as its own metric because no other chess tool can see it.
 */

export const POSTMORTEM_MAX_PER_GAME = 5;

export const POSTMORTEM_VERDICTS = [
  "CORRECT",
  "RIGHT_MOVE_WRONG_REASON",
  "MISREAD_THREAT",
  "MISSED_OPPORTUNITY",
  "SOUND_BUT_INCOMPLETE",
] as const;
export type PostmortemVerdict = (typeof POSTMORTEM_VERDICTS)[number];

export interface PostmortemPrompt {
  plyId: number;
  ply: number;
  san: string;
  fenBefore: string;
  answered: boolean;
}

/** The up-to-5 critical plies of one game eligible for interrogation. */
export async function postmortemPrompts(
  db: Db,
  userId: string,
  gameId: string
): Promise<{ prompts: PostmortemPrompt[]; llm: boolean }> {
  const game = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!game || game.userId !== userId) throw new AccountError("not_found", "No such game.", 404);
  const rows = await db
    .select({
      id: plies.id,
      ply: plies.ply,
      san: plies.san,
      fenBefore: plies.fenBefore,
      color: plies.color,
      wpLoss: plies.wpLoss,
    })
    .from(plies)
    .where(and(eq(plies.gameId, gameId), eq(plies.isCritical, true), eq(plies.degraded, false)))
    .orderBy(asc(plies.ply));
  // The user's own critical moves, biggest stakes first, capped at 5.
  const own = rows
    .filter((row) => game.userColor === null || row.color === game.userColor)
    .sort((a, b) => Math.abs(b.wpLoss ?? 0) - Math.abs(a.wpLoss ?? 0))
    .slice(0, POSTMORTEM_MAX_PER_GAME)
    .sort((a, b) => a.ply - b.ply);
  const answered = own.length
    ? await db
        .select({ plyId: postmortemResponses.plyId })
        .from(postmortemResponses)
        .where(
          and(
            eq(postmortemResponses.userId, userId),
            inArray(
              postmortemResponses.plyId,
              own.map((row) => row.id)
            )
          )
        )
    : [];
  const answeredSet = new Set(answered.map((row) => row.plyId));
  return {
    prompts: own.map((row) => ({
      plyId: row.id,
      ply: row.ply,
      san: row.san,
      fenBefore: row.fenBefore,
      answered: answeredSet.has(row.id),
    })),
    llm: llmAvailable(),
  };
}

interface VerdictJson extends Record<string, unknown> {
  verdict: PostmortemVerdict;
  critique: string;
}

export async function submitPostmortem(
  db: Db,
  userId: string,
  input: { plyId: number; userReasoning: string }
): Promise<{ verdict: PostmortemVerdict; critique: string; cached: boolean }> {
  const reasoning = input.userReasoning.trim();
  if (reasoning.length < 3 || reasoning.length > 4000) {
    throw new AccountError("bad_reasoning", "Write a sentence or two (max 4000 chars).");
  }
  const row = (
    await db
      .select({
        id: plies.id,
        san: plies.san,
        fenBefore: plies.fenBefore,
        isCritical: plies.isCritical,
        bestMoveUci: plies.bestMoveUci,
        pv1: plies.pv1,
        wpBefore: plies.wpBefore,
        wpAfter: plies.wpAfter,
        wpLoss: plies.wpLoss,
        classification: plies.classification,
        gameUserId: games.userId,
      })
      .from(plies)
      .innerJoin(games, eq(plies.gameId, games.id))
      .where(eq(plies.id, input.plyId))
  )[0];
  if (!row || row.gameUserId !== userId) throw new AccountError("not_found", "No such ply.", 404);
  if (!row.isCritical) {
    throw new AccountError("not_critical", "Post-mortem is gated to critical positions (§9.5).");
  }
  if (!llmAvailable()) {
    throw new AccountError("llm_unavailable", "The coach needs an LLM key on this deployment.", 503);
  }

  const engineTruth = {
    bestMove: row.bestMoveUci,
    principalVariation: (row.pv1 ?? []).slice(0, 8),
    winProbBeforeMove: row.wpBefore,
    winProbAfterMove: row.wpAfter,
    winProbLost: row.wpLoss,
    classification: row.classification,
  };
  const key = `${row.id}:${evidenceHash({ fen: row.fenBefore, san: row.san, reasoning })}`;
  const { value, cached } = await cachedJsonCall<VerdictJson>(
    db,
    "postmortem",
    key,
    {
      system:
        "You are a chess coach evaluating a player's stated REASONING about a critical moment, " +
        "against engine truth that is already established. Judge the thinking, not the move. " +
        `Pick verdict from exactly: ${POSTMORTEM_VERDICTS.join(", ")}. ` +
        "RIGHT_MOVE_WRONG_REASON means the played move was fine but the stated justification is " +
        "not the reason it works. Critique in under 120 words, addressed to the player, concrete. " +
        'Respond with JSON only, no markdown fences: {"verdict": "...", "critique": "..."}',
      user: JSON.stringify({
        fenBefore: row.fenBefore,
        sanPlayed: row.san,
        userReasoning: reasoning,
        engineTruth,
      }),
      maxTokens: 400,
    },
    (raw) => {
      const value = raw as VerdictJson;
      if (!POSTMORTEM_VERDICTS.includes(value.verdict)) {
        throw new Error(`bad verdict ${String(value.verdict)}`);
      }
      if (typeof value.critique !== "string" || value.critique.length === 0) {
        throw new Error("critique missing");
      }
      return { verdict: value.verdict, critique: value.critique.slice(0, 1200) };
    }
  );

  await db
    .insert(postmortemResponses)
    .values({
      plyId: row.id,
      userId,
      userReasoning: reasoning,
      verdict: value.verdict,
      critique: value.critique,
    })
    .onConflictDoNothing();
  return { verdict: value.verdict, critique: value.critique, cached };
}

export interface PostmortemMetric {
  total: number;
  byVerdict: Record<string, number>;
  /** §9.5's own metric: RIGHT_MOVE_WRONG_REASON share per month. */
  rightMoveWrongReason: { month: string; total: number; count: number; share: number }[];
}

export async function postmortemMetric(db: Db, userId: string): Promise<PostmortemMetric> {
  const rows = await db
    .select()
    .from(postmortemResponses)
    .where(eq(postmortemResponses.userId, userId))
    .orderBy(desc(postmortemResponses.respondedAt))
    .limit(2000);
  const byVerdict: Record<string, number> = {};
  const byMonth = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    const month = row.respondedAt.toISOString().slice(0, 7);
    const bucket = byMonth.get(month) ?? { total: 0, count: 0 };
    bucket.total += 1;
    if (row.verdict === "RIGHT_MOVE_WRONG_REASON") bucket.count += 1;
    byMonth.set(month, bucket);
  }
  return {
    total: rows.length,
    byVerdict,
    rightMoveWrongReason: [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, bucket]) => ({
        month,
        total: bucket.total,
        count: bucket.count,
        share: bucket.total > 0 ? bucket.count / bucket.total : 0,
      })),
  };
}
