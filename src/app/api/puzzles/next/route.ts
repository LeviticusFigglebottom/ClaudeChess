import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { getPuzzleRating, nextPuzzle } from "@/lib/puzzles";

/**
 * GET /api/puzzles/next[?themes=a,b] — the next rated puzzle near the user's
 * puzzle rating. Free for everyone including anonymous users (A2.1: puzzles
 * are never gated; they cost us nothing).
 */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const themes = url.searchParams.get("themes")?.split(",").filter(Boolean);
    const [puzzle, rating] = await Promise.all([
      nextPuzzle(db, user.id, { themes }),
      getPuzzleRating(db, user.id),
    ]);
    return NextResponse.json({ puzzle, rating });
  });
}
