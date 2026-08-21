import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { exportAccount } from "@/lib/account/export";

/**
 * GET /api/account/export — the full archive (A2.4): every game's PGN, all
 * analysis rows as JSON, ratings, prefs, trainer attempts. Downloadable.
 */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const dump = await exportAccount(db, user.id);
    return new NextResponse(JSON.stringify(dump, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="gambit-export-${user.handle}.json"`,
      },
    });
  });
}
