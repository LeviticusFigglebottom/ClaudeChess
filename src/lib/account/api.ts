import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { createClient } from "@/lib/supabase/server";
import { AccountError, type AuthShape, type Db, type UserRow } from "./types";
import { ensureUser, recoverableUntil } from "./users";

/**
 * Route-handler adapter layer: resolves the Supabase auth user, reconciles
 * the DB row, and maps AccountError to HTTP. Domain logic stays in the
 * sibling modules (testable against PGlite); everything here is glue.
 */

export function accountsConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.DATABASE_URL
  );
}

export async function getAuthShape(): Promise<AuthShape | null> {
  if (!accountsConfigured()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    id: user.id,
    isAnonymous: user.is_anonymous ?? false,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
  };
}

export interface RequestContext {
  db: Db;
  auth: AuthShape;
  user: UserRow;
}

/**
 * Auth + reconciliation for every account-backed route. Throws AccountError
 * (mapped by `handle`) when accounts are disabled, the caller is signed out,
 * or the account is soft-deleted (410 carries the recovery deadline).
 */
export async function requireUser(
  opts: { allowSoftDeleted?: boolean } = {}
): Promise<RequestContext> {
  if (!accountsConfigured()) {
    throw new AccountError(
      "accounts_disabled",
      "Accounts are not configured on this deployment.",
      503
    );
  }
  const auth = await getAuthShape();
  if (!auth) {
    throw new AccountError("unauthenticated", "Sign-in required.", 401);
  }
  const db = getDb();
  const ensured = await ensureUser(db, auth);
  if (ensured.softDeleted && !opts.allowSoftDeleted) {
    throw new AccountError(
      "account_deleted",
      `This account is pending deletion (recoverable until ${
        ensured.user.deletedAt ? recoverableUntil(ensured.user.deletedAt).toISOString() : "—"
      }).`,
      410
    );
  }
  return { db, auth, user: ensured.user };
}

export function jsonError(error: unknown): NextResponse {
  if (error instanceof AccountError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  console.error("[api] unexpected error:", error);
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong." } },
    { status: 500 }
  );
}

/** Wraps a route body: AccountError → typed JSON error, anything else → 500. */
export async function handleApi(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    return jsonError(error);
  }
}

/** Profile shape safe to return to the owning client. */
export function ownProfile(user: UserRow) {
  return {
    id: user.id,
    handle: user.handle,
    email: user.email,
    isAnonymous: user.isAnonymous,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    displayName: user.displayName,
    countryCode: user.countryCode,
    bio: user.bio,
    title: user.title,
    tier: user.tier,
    createdAt: user.createdAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AccountError("bad_json", "Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError("bad_json", "Request body must be valid JSON.");
  }
}
