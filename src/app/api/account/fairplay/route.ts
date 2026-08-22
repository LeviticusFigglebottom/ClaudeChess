import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { listOwnFairplayFlags } from "@/lib/play";

/** A user's own fair-play signals (A2.3 collection, B0.5 self-transparency). */
export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const signals = await listOwnFairplayFlags(db, user.id);
    return NextResponse.json({ signals });
  });
}
