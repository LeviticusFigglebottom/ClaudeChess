import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import {
  blockUser,
  listRelationships,
  removeFriend,
  requestFriend,
  respondFriend,
  unblockUser,
} from "@/lib/account/relationships";
import { AccountError } from "@/lib/account/types";

/** GET /api/friends — friends, pending requests both ways, block list. */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    return NextResponse.json(await listRelationships(db, user.id));
  });
}

/**
 * POST /api/friends — one mutation endpoint:
 *   { action: "request", handle }        send a friend request
 *   { action: "respond", requestId, accept }
 *   { action: "remove", userId }         unfriend / retract
 *   { action: "block", handle }          real block (A2.2)
 *   { action: "unblock", userId }
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    switch (body.action) {
      case "request": {
        if (typeof body.handle !== "string") throw new AccountError("bad_action", "handle required.");
        return NextResponse.json(await requestFriend(db, user.id, body.handle));
      }
      case "respond": {
        if (typeof body.requestId !== "string" || typeof body.accept !== "boolean") {
          throw new AccountError("bad_action", "requestId and accept required.");
        }
        await respondFriend(db, user.id, body.requestId, body.accept);
        return NextResponse.json({ ok: true });
      }
      case "remove": {
        if (typeof body.userId !== "string") throw new AccountError("bad_action", "userId required.");
        await removeFriend(db, user.id, body.userId);
        return NextResponse.json({ ok: true });
      }
      case "block": {
        if (typeof body.handle !== "string") throw new AccountError("bad_action", "handle required.");
        return NextResponse.json({ blocked: await blockUser(db, user.id, body.handle) });
      }
      case "unblock": {
        if (typeof body.userId !== "string") throw new AccountError("bad_action", "userId required.");
        await unblockUser(db, user.id, body.userId);
        return NextResponse.json({ ok: true });
      }
      default:
        throw new AccountError("bad_action", "Unknown action.");
    }
  });
}
