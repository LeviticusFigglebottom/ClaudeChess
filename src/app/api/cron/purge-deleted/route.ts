import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { purgeDeletedUsers } from "@/lib/account/users";

/**
 * GET /api/cron/purge-deleted — Vercel Cron target (see vercel.json):
 * hard-deletes accounts whose 30-day recovery window has passed (A2.4).
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: Request) {
  return handleApi(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
      throw new AccountError("forbidden", "Cron secret required.", 401);
    }
    if (!accountsConfigured()) {
      throw new AccountError("accounts_disabled", "Accounts are not configured.", 503);
    }
    const purged = await purgeDeletedUsers(getDb());
    return NextResponse.json({ purged: purged.length });
  });
}
