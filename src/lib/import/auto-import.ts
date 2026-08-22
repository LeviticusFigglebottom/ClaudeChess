import { eq } from "drizzle-orm";
import { linkedAccounts, users } from "@/db/schema";
import type { Db } from "@/lib/account/types";
import { consumeUsage } from "@/lib/account/usage";
import { runImportChunk, type ImportSource } from "./importer";

/**
 * Weekly auto-import sweep (C1: polling only — daily/weekly is correct,
 * hourly would be abusive). Each opted-in linked account gets a bounded
 * number of chunks, each consuming the OWNER's monthly import allowance —
 * auto-import never bypasses A2.4 caps. Domain function so both the
 * dedicated cron route and the consolidated daily dispatcher can run it,
 * and tests can drive it against PGlite.
 */
export interface AutoImportResult {
  userId: string;
  source: string;
  imported: number;
  capped: boolean;
}

export async function runAutoImportSweep(db: Db): Promise<AutoImportResult[]> {
  const optedIn = await db
    .select()
    .from(linkedAccounts)
    .where(eq(linkedAccounts.autoImport, true))
    .limit(200);

  const results: AutoImportResult[] = [];
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
        break; // platform hiccup — the next run resumes from the cursor
      }
    }
    results.push({ userId: linked.userId, source: linked.source, imported, capped });
  }
  return results;
}
