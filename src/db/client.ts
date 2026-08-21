import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Server-side Drizzle client over Supabase Postgres. Lazy so that builds and
 * tests run without a database; throws a useful error at first use when
 * DATABASE_URL is missing.
 */
let db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — see .env.example");
  }
  // Supabase pooler (transaction mode) does not support prepared statements.
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema });
}

export function getDb() {
  db ??= createDb();
  return db;
}
