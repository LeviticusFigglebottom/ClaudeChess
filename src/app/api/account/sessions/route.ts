import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { listSessions, revokeSession } from "@/lib/account/users";

/** GET /api/account/sessions — device sessions for the account page. */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    return NextResponse.json({ sessions: await listSessions(db, user.id) });
  });
}

/**
 * POST /api/account/sessions — revoke one device session. The revoked device
 * signs itself out on its next bootstrap.
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    if (body.action !== "revoke" || typeof body.sessionId !== "string") {
      throw new AccountError("bad_action", 'Expected { action: "revoke", sessionId }.');
    }
    await revokeSession(db, user.id, body.sessionId);
    return NextResponse.json({ ok: true });
  });
}
