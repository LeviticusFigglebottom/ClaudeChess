import { NextResponse } from "next/server";
import { handleApi, ownProfile, readJson, requireUser } from "@/lib/account/api";
import { updateProfile } from "@/lib/account/users";

/** PATCH /api/account/profile — handle / display name / country / bio. */
export async function PATCH(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const updated = await updateProfile(db, user.id, {
      ...(typeof body.handle === "string" ? { handle: body.handle } : {}),
      ...("displayName" in body
        ? { displayName: typeof body.displayName === "string" ? body.displayName : null }
        : {}),
      ...("countryCode" in body
        ? { countryCode: typeof body.countryCode === "string" ? body.countryCode : null }
        : {}),
      ...("bio" in body ? { bio: typeof body.bio === "string" ? body.bio : null } : {}),
    });
    return NextResponse.json({ user: ownProfile(updated) });
  });
}
