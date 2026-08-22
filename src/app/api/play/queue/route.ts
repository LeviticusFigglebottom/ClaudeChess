import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { isVariantId } from "@/lib/chess/variant";
import { activeLiveGameFor } from "@/lib/play/live";
import { joinQueue, leaveQueue, queueStatus, tryPair, validateClockSpec } from "@/lib/play";

/**
 * Matchmaking queue (§8). GET doubles as the searching poll: it retries the
 * pairing pass server-side and reports any active game to (re)join.
 */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const status = await queueStatus(db, user.id);
    if (status.queued) await tryPair(db, user.id);
    const gameId = await activeLiveGameFor(db, user.id);
    const after = await queueStatus(db, user.id);
    return NextResponse.json({ queued: after.queued, gameId });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    if (body.action === "leave") {
      await leaveQueue(db, user.id);
      return NextResponse.json({ queued: false, gameId: null });
    }
    if (body.action !== "join") throw new AccountError("bad_action", "Unknown action.");
    const variant = typeof body.variant === "string" && isVariantId(body.variant) ? body.variant : "standard";
    const result = await joinQueue(db, user, {
      variant,
      clock: validateClockSpec(body.clock),
      rated: body.rated === true,
    });
    return NextResponse.json(result);
  });
}
