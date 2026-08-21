import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { listGames, saveBotGame, type SaveGamePayload } from "@/lib/account/games";

/**
 * POST /api/games — persist a finished bot game (anonymous users included:
 * their history is what makes conversion worth something). Rated games also
 * book the result into the server Glicko-2 period state and return the new
 * state for the client's localStorage cache.
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const result = await saveBotGame(db, user, body as unknown as SaveGamePayload);
    return NextResponse.json(result);
  });
}

/** GET /api/games?limit=&offset= — the user's saved games, newest first. */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const games = await listGames(db, user.id, {
      limit: Number(url.searchParams.get("limit") ?? 20) || 20,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    });
    return NextResponse.json({ games });
  });
}
