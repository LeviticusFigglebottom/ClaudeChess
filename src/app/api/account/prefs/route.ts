import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { updatePrefs } from "@/lib/account/users";

/**
 * PUT /api/account/prefs — the signed-in half of B2.5 preference storage.
 * localStorage stays the offline cache; this is the durable copy that
 * follows the account across devices and survives conversion.
 */
export async function PUT(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const saved = await updatePrefs(db, user.id, body.prefs);
    return NextResponse.json({ prefs: saved });
  });
}

export async function GET() {
  return handleApi(async () => {
    const { user } = await requireUser();
    return NextResponse.json({ prefs: user.prefs ?? null });
  });
}
