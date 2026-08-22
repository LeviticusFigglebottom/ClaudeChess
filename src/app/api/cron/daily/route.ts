import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { purgeDeletedUsers } from "@/lib/account/users";
import { runAutoImportSweep } from "@/lib/import/auto-import";
import { sweepDailyTimeouts } from "@/lib/play";

/**
 * Consolidated daily cron dispatcher — the ONLY scheduled entry in
 * vercel.json. Vercel's Hobby tier allows at most 2 cron jobs, each at most
 * once per day, so the individual jobs run here in sequence (each leg
 * isolated: one failing never starves the others):
 *
 *  - purge-deleted  (A2.4): hard-delete accounts past the 30-day window.
 *  - daily-timeouts (A3.6): BACKSTOP sweep for expired correspondence
 *    games nobody has loaded — the primary mechanism is lazy finalization
 *    on state read in getLiveState.
 *  - auto-import    (C1):   Mondays (UTC) only, preserving the weekly
 *    cadence the spec calls for.
 *
 * The per-job routes (/api/cron/purge-deleted, /api/cron/daily-timeouts,
 * /api/cron/auto-import) remain callable with the same secret for manual
 * runs; they are no longer scheduled.
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
    const db = getDb();
    const legs: Record<string, unknown> = {};

    try {
      legs.purgeDeleted = { purged: (await purgeDeletedUsers(db)).length };
    } catch (error) {
      legs.purgeDeleted = { error: error instanceof Error ? error.message : String(error) };
    }

    try {
      legs.dailyTimeouts = { flagged: await sweepDailyTimeouts(db) };
    } catch (error) {
      legs.dailyTimeouts = { error: error instanceof Error ? error.message : String(error) };
    }

    if (new Date().getUTCDay() === 1) {
      try {
        const results = await runAutoImportSweep(db);
        legs.autoImport = { accounts: results.length, results };
      } catch (error) {
        legs.autoImport = { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      legs.autoImport = { skipped: "runs Mondays (UTC)" };
    }

    return NextResponse.json(legs);
  });
}
