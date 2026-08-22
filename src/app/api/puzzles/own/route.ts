import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { ownPuzzles } from "@/lib/puzzles/own";

/**
 * Unrated drills from the user's OWN analyzed blunders (standard games).
 * Never touches the rated puzzle pool.
 */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    return NextResponse.json({ puzzles: await ownPuzzles(db, user.id, "standard") });
  });
}
