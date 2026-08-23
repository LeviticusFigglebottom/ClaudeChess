import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { games } from "@/db/schema";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import { checkUsage, consumeUsage } from "@/lib/account/usage";
import { analyzeGameChunk, analysisProgress } from "@/lib/analysis/analyze-game";
import { AnalysisPool } from "@/lib/analysis/pool";
import { createTablebaseClient } from "@/lib/analysis/tablebase";

/**
 * Batch analysis (Phase 2, §3.3/§4) — the real body behind the Phase 1.5
 * guard chain. Chunked for serverless budgets: each call analyzes up to ~20
 * positions (≈8s) of the requested game and books exactly the plies it
 * analyzed against the monthly deep-analysis cap; the client loops until
 * done (that loop IS the streamed progress).
 */

/**
 * Fluid compute allows 300s on Hobby (measured: the platform kills at
 * exactly 300s). Explicit so chunk sizing below can rely on it: the ~60s
 * work target plus the worst single-search overshoot (one d24:1 verify
 * search, fitted budget 64s) stays far inside the window.
 */
export const maxDuration = 300;

let sharedPool: AnalysisPool | null = null;
function pool(): AnalysisPool {
  sharedPool ??= new AnalysisPool({ cap: 2, hashMb: 128 });
  return sharedPool;
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "Server-side analysis requires a verified account (A2.1) — in-browser analysis is free and unlimited.",
        403
      );
    }
    const body = await readJson(request);
    if (typeof body.gameId !== "string") {
      throw new AccountError("bad_action", "gameId required.");
    }
    const game = (await db.select().from(games).where(eq(games.id, body.gameId)))[0];
    if (!game || game.userId !== user.id) {
      throw new AccountError("game_missing", "No such game.", 404);
    }

    const CHUNK = 20;
    const allowance = await checkUsage(db, user, { kind: "analysisPliesDeep", amount: CHUNK });
    if (!allowance.allowed && allowance.remaining === 0) {
      return NextResponse.json(
        {
          error: {
            code: "usage_capped",
            message: `Monthly deep-analysis limit reached (${allowance.used}/${allowance.cap}).`,
          },
          usage: allowance,
        },
        { status: 429 }
      );
    }

    const result = await analyzeGameChunk(db, game.id, {
      pool: pool(),
      tb: createTablebaseClient(db),
      maxPositions: Math.min(CHUNK, Math.max(2, allowance.remaining)),
      // Work target per call — sized against maxDuration above, NOT a
      // platform guess: the deadline is checked between searches, so the
      // real ceiling is target + one search budget.
      maxMs: 60_000,
      // BASIC is the default (owner directive): d24 borderline verification
      // runs only when the caller asks for the full pass.
      skipVerify: body.full !== true,
    });
    if (result.analyzedPlies > 0) {
      await consumeUsage(db, user, { kind: "analysisPliesDeep", amount: result.analyzedPlies });
    }
    const progress = await analysisProgress(db, game.id);
    return NextResponse.json({
      analyzedPlies: result.analyzedPlies,
      progress,
      done: result.remainingPlies === 0,
      finalized: result.finalized,
      // Distinguishes the borderline-verification phase (evals complete,
      // analyzedPlies 0, not done) so the client can say what is happening
      // instead of pinning the bar at 100% in silence.
      verifyRemaining: result.analyzedPlies === 0 ? result.remainingPlies : 0,
    });
  });
}
