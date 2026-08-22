import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import {
  abortLive,
  applyLiveMove,
  claimFlag,
  drawAction,
  getLiveState,
  recordBlur,
  resignLive,
} from "@/lib/play";

/**
 * Live game transport (§8): GET is the state poll (server-computed clocks
 * with a timestamp — clients render offsets, never authority); POST carries
 * every action. Premoves arrive as ordinary 'move' actions and get FULL
 * server validation (A3.5 — never skipped).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const { id } = await params;
    const state = await getLiveState(db, id, user.id);
    return NextResponse.json({ state });
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const { id } = await params;
    const body = await readJson(request);
    switch (body.action) {
      case "move": {
        if (typeof body.uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(body.uci)) {
          throw new AccountError("illegal", "Bad move encoding.", 422);
        }
        const result = await applyLiveMove(db, id, user.id, body.uci);
        const state = await getLiveState(db, id, user.id);
        return NextResponse.json({ ...result, state });
      }
      case "resign": {
        await resignLive(db, id, user.id);
        return NextResponse.json({ state: await getLiveState(db, id, user.id) });
      }
      case "draw-offer":
      case "draw-accept":
      case "draw-decline": {
        await drawAction(db, id, user.id, body.action.replace("draw-", "") as "offer" | "accept" | "decline");
        return NextResponse.json({ state: await getLiveState(db, id, user.id) });
      }
      case "flag": {
        const verdict = await claimFlag(db, id, user.id);
        return NextResponse.json({ ...verdict, state: await getLiveState(db, id, user.id) });
      }
      case "abort": {
        await abortLive(db, id, user.id);
        return NextResponse.json({ state: await getLiveState(db, id, user.id) });
      }
      case "blur": {
        await recordBlur(db, id, user.id);
        return NextResponse.json({ ok: true });
      }
      default:
        throw new AccountError("bad_action", "Unknown action.");
    }
  });
}
