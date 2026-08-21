import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  declineChallenge,
  getChallengeByToken,
  listChallenges,
  toChallengeView,
} from "@/lib/account/challenges";
import { AccountError } from "@/lib/account/types";

/** GET /api/challenges — open incoming/outgoing challenges. */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    return NextResponse.json(await listChallenges(db, user.id));
  });
}

/**
 * POST /api/challenges — create and respond:
 *   { action: "create", toHandle?, variant, timeControl, rated, color, ttlMinutes? }
 *     (omit toHandle for a shareable open link)
 *   { action: "accept" | "decline" | "cancel", id }
 *   { action: "accept", token }   accept an open link by token
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    switch (body.action) {
      case "create": {
        const challenge = await createChallenge(db, user, {
          toHandle: typeof body.toHandle === "string" ? body.toHandle : undefined,
          variant: typeof body.variant === "string" ? body.variant : "standard",
          timeControl: typeof body.timeControl === "string" ? body.timeControl : "",
          rated: body.rated === true,
          color:
            body.color === "white" || body.color === "black" ? body.color : "random",
          ttlMinutes: typeof body.ttlMinutes === "number" ? body.ttlMinutes : undefined,
        });
        return NextResponse.json({ challenge: await toChallengeView(db, challenge) });
      }
      case "accept": {
        let id = typeof body.id === "string" ? body.id : null;
        if (!id && typeof body.token === "string") {
          const byToken = await getChallengeByToken(db, body.token);
          if (!byToken) throw new AccountError("challenge_missing", "No such challenge.", 404);
          id = byToken.id;
        }
        if (!id) throw new AccountError("bad_action", "id or token required.");
        const accepted = await acceptChallenge(db, user, id);
        return NextResponse.json({
          challenge: await toChallengeView(db, accepted),
          // Phase 4 replaces this with the created game's id + realtime channel.
          play: null,
        });
      }
      case "decline": {
        if (typeof body.id !== "string") throw new AccountError("bad_action", "id required.");
        await declineChallenge(db, user.id, body.id);
        return NextResponse.json({ ok: true });
      }
      case "cancel": {
        if (typeof body.id !== "string") throw new AccountError("bad_action", "id required.");
        await cancelChallenge(db, user.id, body.id);
        return NextResponse.json({ ok: true });
      }
      default:
        throw new AccountError("bad_action", "Unknown action.");
    }
  });
}
