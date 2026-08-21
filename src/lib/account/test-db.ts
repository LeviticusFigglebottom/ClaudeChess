import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Db } from "./types";

/**
 * Test database: the full migration chain applied to in-process PGlite —
 * the same harness gate G5 uses, so account tests exercise the REAL schema
 * (FKs, cascades, citext, checks), not a mock.
 */
export interface TestDb {
  db: Db;
  raw: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = await PGlite.create({ extensions: { citext } });
  const migrationsDir = path.resolve(__dirname, "../../db/migrations");
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sql = readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, raw: client, close: () => client.close() };
}
