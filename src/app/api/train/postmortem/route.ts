import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { postmortemMetric, postmortemPrompts } from "@/lib/train";

/**
 * §9.5 — GET ?gameId= the up-to-5 critical prompts of a game review, or the
 * RIGHT_MOVE_WRONG_REASON metric without params. Submissions go through
 * /api/coach (the metered LLM route).
 */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const gameId = url.searchParams.get("gameId");
    if (gameId) {
      return NextResponse.json(await postmortemPrompts(db, user.id, gameId));
    }
    return NextResponse.json({ metric: await postmortemMetric(db, user.id) });
  });
}
