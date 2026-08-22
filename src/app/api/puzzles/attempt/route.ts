import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { recordPuzzleAttempt } from "@/lib/puzzles";

/** POST /api/puzzles/attempt {puzzleId, solved, timeMs?} — record + rate. */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    if (typeof body.puzzleId !== "string" || typeof body.solved !== "boolean") {
      throw new AccountError("bad_action", "puzzleId and solved required.");
    }
    const result = await recordPuzzleAttempt(db, user, {
      puzzleId: body.puzzleId,
      solved: body.solved,
      timeMs: typeof body.timeMs === "number" ? Math.round(body.timeMs) : null,
    });
    return NextResponse.json(result);
  });
}
