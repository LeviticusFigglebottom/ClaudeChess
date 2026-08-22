import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { runAutoImportSweep } from "@/lib/import/auto-import";

/**
 * Weekly auto-import — manual/back-compat trigger. The scheduled entry point
 * is the consolidated /api/cron/daily dispatcher (Vercel Hobby allows max 2
 * once-daily crons); the sweep itself lives in src/lib/import/auto-import.
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
    const results = await runAutoImportSweep(getDb());
    return NextResponse.json({ accounts: results.length, results });
  });
}
