import { NextResponse } from "next/server";
import { handleApi, ownProfile, requireUser } from "@/lib/account/api";
import { getUsageSummary } from "@/lib/account/usage";
import { isAdminId } from "@/lib/account/admin";
import { listSessions } from "@/lib/account/users";

/**
 * GET /api/account/me — profile, the visible usage counters + caps (the
 * A2.4 gate requirement), and device sessions for the account page.
 */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const [usage, sessions] = await Promise.all([
      getUsageSummary(db, user),
      listSessions(db, user.id),
    ]);
    return NextResponse.json({
      user: ownProfile(user),
      usage,
      sessions,
      isAdmin: isAdminId(user.id),
    });
  });
}
