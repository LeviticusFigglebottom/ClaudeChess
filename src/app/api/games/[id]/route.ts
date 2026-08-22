import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { blunderTags, games, plies } from "@/db/schema";
import { handleApi, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { gameAccuracy, moveAccuracy, volatilityWeights } from "@/lib/eval";

/**
 * GET /api/games/[id] — the full review payload: game meta, every ply's
 * analysis record, motif tags with evidence (C3), per-side §4.5 accuracy.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const { id } = await params;
    const game = (await db.select().from(games).where(eq(games.id, id)))[0];
    if (!game || game.userId !== user.id) {
      throw new AccountError("game_missing", "No such game.", 404);
    }
    const plyRows = await db
      .select()
      .from(plies)
      .where(eq(plies.gameId, id))
      .orderBy(asc(plies.ply));
    const tags = plyRows.length
      ? await db
          .select()
          .from(blunderTags)
          .where(
            inArray(
              blunderTags.plyId,
              plyRows.map((row) => row.id)
            )
          )
      : [];

    // §4.5 accuracy per side over the analyzed plies.
    const analyzed = plyRows.filter((row) => row.wpBefore !== null);
    let accuracy: { white: number | null; black: number | null } = {
      white: null,
      black: null,
    };
    if (analyzed.length > 0 && analyzed.length === plyRows.length) {
      const whiteSeries = plyRows.map((row) =>
        row.color === "white" ? row.wpBefore! : 100 - row.wpBefore!
      );
      const weights = volatilityWeights(whiteSeries);
      const bySide = (color: "white" | "black") => {
        const indices = plyRows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.color === color);
        if (indices.length === 0) return null;
        return gameAccuracy(
          indices.map(({ row }) => moveAccuracy(Math.max(0, row.wpLoss ?? 0))),
          indices.map(({ index }) => weights[index]!)
        );
      };
      accuracy = { white: bySide("white"), black: bySide("black") };
    }

    const tagsByPly = new Map<number, typeof tags>();
    for (const tag of tags) {
      const list = tagsByPly.get(tag.plyId) ?? [];
      list.push(tag);
      tagsByPly.set(tag.plyId, list);
    }

    return NextResponse.json({
      game: {
        id: game.id,
        variant: game.variant,
        source: game.source,
        whiteName: game.whiteName,
        blackName: game.blackName,
        userColor: game.userColor,
        result: game.result,
        termination: game.termination,
        timeControl: game.timeControl,
        eco: game.eco,
        opening: game.opening,
        playedAt: game.playedAt?.toISOString() ?? null,
        startFen: game.startFen,
        pgn: game.pgn,
      },
      accuracy,
      plies: plyRows.map((row) => ({
        ply: row.ply,
        moveNumber: row.moveNumber,
        color: row.color,
        san: row.san,
        uci: row.uci,
        fenBefore: row.fenBefore,
        fenAfter: row.fenAfter,
        evalBeforeCp: row.evalBeforeCp,
        evalAfterCp: row.evalAfterCp,
        mateBefore: row.mateBefore,
        mateAfter: row.mateAfter,
        bestMoveUci: row.bestMoveUci,
        pv1: row.pv1,
        wpBefore: row.wpBefore,
        wpAfter: row.wpAfter,
        wpLoss: row.wpLoss,
        classification: row.classification,
        clockMsRemaining: row.clockMsRemaining,
        timeSpentMs: row.timeSpentMs,
        isCritical: row.isCritical,
        tbHit: row.tbHit,
        tbWdl: row.tbWdl,
        tags: (tagsByPly.get(row.id) ?? [])
          .sort((a, b) => a.rank - b.rank)
          .map((tag) => ({
            motif: tag.motif,
            rank: tag.rank,
            confidence: tag.confidence,
            evidence: tag.evidence,
            explanation: tag.explanation,
          })),
      })),
    });
  });
}
