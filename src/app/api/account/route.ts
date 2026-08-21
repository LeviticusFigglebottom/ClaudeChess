import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { recoverableUntil, softDeleteUser } from "@/lib/account/users";

/**
 * DELETE /api/account — soft delete (A2.4): 30-day recovery window, sessions
 * revoked now, hard cascade later via the purge cron.
 */
export async function DELETE() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const deletedAt = await softDeleteUser(db, user.id);
    return NextResponse.json({
      softDeleted: true,
      recoverableUntil: recoverableUntil(deletedAt).toISOString(),
    });
  });
}
