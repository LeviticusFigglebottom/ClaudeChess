import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

/**
 * Account system (addendum A2) — domain layer. Every function in this
 * directory takes a `Db` handle and contains no HTTP, no Supabase, and no
 * browser code, so the whole account system is testable against in-process
 * PGlite (the same harness as gate G5). Route handlers under /api are thin
 * adapters over these functions.
 */

/** Any Drizzle Postgres database (postgres-js in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type UserRow = typeof schema.users.$inferSelect;

/**
 * Domain error with a stable machine code and the HTTP status a route
 * adapter should map it to. Messages are user-presentable.
 */
export class AccountError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.status = status;
  }
}

/** Shape of the Supabase auth user the domain layer needs (auth.users mirror). */
export interface AuthShape {
  id: string;
  isAnonymous: boolean;
  email: string | null;
  /** ISO timestamp when the email was confirmed; null while unverified. */
  emailConfirmedAt: string | null;
}

/**
 * Postgres unique-violation detection. drizzle-orm wraps driver errors in
 * DrizzleQueryError, so the 23505 code lives somewhere down the cause chain.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A2.1: rated multiplayer, game import, and any LLM feature require a
 * verified account. Anonymous users and unconfirmed emails both fail this.
 */
export function isVerified(
  user: Pick<UserRow, "isAnonymous" | "emailVerifiedAt">
): boolean {
  return !user.isAnonymous && user.emailVerifiedAt !== null;
}
