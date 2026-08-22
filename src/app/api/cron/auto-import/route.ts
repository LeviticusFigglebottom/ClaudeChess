import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { linkedAccounts, users } from "@/db/schema";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import { consumeUsage } from "@/lib/account/usage";
import { runImportChunk, type ImportSource } from "@/lib/import/importer";

/**
 * Weekly auto-import (C1: polling only — daily/weekly is correct, hourly
 * would be abusive). Vercel Cron target (vercel.json). Each opted-in linked
 * account gets a bounded number of chunks, each consuming the OWNER's
 * monthly import allowance — auto-import never bypasses A2.4 caps.
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
    const optedIn = await db
      .select()
      .from(linkedAccounts)
      .where(eq(linkedAccounts.autoImport, true))
      .limit(200);

    const results: { userId: string; source: string; imported: number; capped: boolean }[] = [];
    for (const linked of optedIn) {
      const user = (await db.select().from(users).where(eq(users.id, linked.userId)))[0];
      if (!user || user.deletedAt !== null) continue;
      let imported = 0;
      let capped = false;
      for (let chunk = 0; chunk < 6; chunk++) {
        const decision = await consumeUsage(db, user, { kind: "importsRun", amount: 1 });
        if (!decision.allowed) {
          capped = true;
          break;
        }
        try {
          const result = await runImportChunk(db, user, linked.source as ImportSource, {
            maxGames: 25,
          });
          imported += result.imported;
          if (result.done) break;
        } catch {
          break; // platform hiccup — next week's run resumes from the cursor
        }
      }
      results.push({ userId: linked.userId, source: linked.source, imported, capped });
    }
    return NextResponse.json({ accounts: results.length, results });
  });
}
