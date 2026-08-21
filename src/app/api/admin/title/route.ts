import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { grantTitle } from "@/lib/account/admin";
import { AccountError } from "@/lib/account/types";

/**
 * POST /api/admin/title — B1.3's grant path for users.title. Admins are the
 * auth ids listed in ADMIN_USER_IDS (see .env.example). Every grant/revoke
 * is audit-logged. { handle, title } with title null to revoke.
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    if (typeof body.handle !== "string") {
      throw new AccountError("bad_action", "handle required.");
    }
    const title = body.title === null ? null : typeof body.title === "string" ? body.title : undefined;
    if (title === undefined) {
      throw new AccountError("bad_action", "title must be a string or null.");
    }
    const updated = await grantTitle(db, user, body.handle, title);
    return NextResponse.json({
      user: { handle: updated.handle, title: updated.title },
    });
  });
}
