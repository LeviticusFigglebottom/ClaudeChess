import { NextResponse } from "next/server";
import { handleApi, ownProfile, requireUser } from "@/lib/account/api";
import { recoverUser } from "@/lib/account/users";

/** POST /api/account/recover — undo a soft delete within the 30-day window. */
export async function POST() {
  return handleApi(async () => {
    const { db, user } = await requireUser({ allowSoftDeleted: true });
    const recovered = await recoverUser(db, user.id);
    return NextResponse.json({ user: ownProfile(recovered) });
  });
}
