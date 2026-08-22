import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { sweepDailyTimeouts } from "@/lib/play";

/**
 * A3.6: correspondence timeouts are CRON-driven — Realtime only works while
 * someone is connected, which is the opposite of correspondence. Vercel Cron
 * target (vercel.json, hourly).
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
    const flagged = await sweepDailyTimeouts(getDb());
    return NextResponse.json({ flagged });
  });
}
