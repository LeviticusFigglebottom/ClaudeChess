import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import { logAudit } from "./audit";
import { generateGuestHandle, generatePlayerHandle, validateHandle } from "./handles";
import { AccountError, isUniqueViolation, type AuthShape, type Db, type UserRow } from "./types";

/**
 * User lifecycle (A2.1/A2.4): anonymous-first creation, reconciliation with
 * the Supabase auth user, the anonymous→permanent conversion (which
 * preserves every FK-linked row because the auth id never changes — linking,
 * never copying), and soft delete with a 30-day recovery window.
 */

export const RECOVERY_WINDOW_DAYS = 30;

export interface EnsureUserResult {
  user: UserRow;
  created: boolean;
  /** True when this call flipped an anonymous row to permanent (A2.1 conversion). */
  converted: boolean;
  /** True when the row is soft-deleted; callers must refuse everything but recovery. */
  softDeleted: boolean;
}

export async function getUser(db: Db, userId: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** citext makes this case-insensitive on the DB side. */
export async function getUserByHandle(db: Db, handle: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  return rows[0] ?? null;
}

/**
 * Idempotent reconciliation between the Supabase auth user and our row.
 * Called on every bootstrap; creates the row on first visit, detects the
 * anonymous→permanent conversion (same id — every game/rating/attempt row
 * keeps pointing at it), and syncs email/verification state.
 */
export async function ensureUser(
  db: Db,
  auth: AuthShape,
  opts: { desiredHandle?: string; now?: Date; random?: () => number } = {}
): Promise<EnsureUserResult> {
  const now = opts.now ?? new Date();
  const random = opts.random ?? Math.random;

  const existing = await getUser(db, auth.id);
  if (existing) {
    if (existing.deletedAt !== null) {
      return { user: existing, created: false, converted: false, softDeleted: true };
    }
    const converted = existing.isAnonymous && !auth.isAnonymous;
    const emailVerifiedAt = auth.emailConfirmedAt ? new Date(auth.emailConfirmedAt) : null;
    const changed =
      converted ||
      existing.email !== auth.email ||
      (existing.emailVerifiedAt?.getTime() ?? null) !== (emailVerifiedAt?.getTime() ?? null);
    const updated = await db
      .update(users)
      .set({
        isAnonymous: auth.isAnonymous,
        email: auth.email,
        emailVerifiedAt,
        lastSeenAt: now,
      })
      .where(eq(users.id, auth.id))
      .returning();
    const user = updated[0];
    if (!user) throw new AccountError("user_missing", "Account row disappeared.", 500);
    if (converted) {
      await logAudit(db, user.id, "account.convert", { email: auth.email });
    } else if (changed) {
      await logAudit(db, user.id, "account.sync", {});
    }
    return { user, created: false, converted, softDeleted: false };
  }

  // First visit: create the row. Anonymous users get a guest handle; a
  // permanent signup may bring a desired handle (falling back to generated
  // rather than failing the bootstrap).
  let desired: string | null = null;
  if (opts.desiredHandle) {
    try {
      validateHandle(opts.desiredHandle);
      desired = opts.desiredHandle;
    } catch {
      desired = null;
    }
  }

  let lastViolation: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const handle =
      attempt === 0 && desired
        ? desired
        : auth.isAnonymous
          ? generateGuestHandle(random)
          : generatePlayerHandle(random);
    try {
      const inserted = await db
        .insert(users)
        .values({
          id: auth.id,
          handle,
          email: auth.email,
          isAnonymous: auth.isAnonymous,
          emailVerifiedAt: auth.emailConfirmedAt ? new Date(auth.emailConfirmedAt) : null,
          createdAt: now,
          lastSeenAt: now,
        })
        .returning();
      const user = inserted[0];
      if (!user) throw new AccountError("user_insert", "Insert returned no row.", 500);
      await logAudit(db, user.id, "account.create", { anonymous: auth.isAnonymous });
      return { user, created: true, converted: false, softDeleted: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastViolation = error;
      // id collision → concurrent bootstrap won; handle collision → retry.
      const raced = await getUser(db, auth.id);
      if (raced) {
        return {
          user: raced,
          created: false,
          converted: false,
          softDeleted: raced.deletedAt !== null,
        };
      }
    }
  }
  // Six straight unique violations with no visible row is not a plausible
  // handle-collision streak — surface the underlying error so a deployed
  // misconfiguration (wrong constraint, wrong database, RLS surprise) is
  // diagnosable from the response and the function log.
  const detail =
    lastViolation instanceof Error
      ? `${lastViolation.message}${lastViolation.cause instanceof Error ? ` <- ${lastViolation.cause.message}` : ""}`
      : String(lastViolation);
  console.error("[ensureUser] handle allocation exhausted:", lastViolation);
  throw new AccountError(
    "handle_generation",
    `Could not allocate a unique handle. last: ${detail}`.slice(0, 500),
    500
  );
}

export interface ProfilePatch {
  handle?: string;
  displayName?: string | null;
  countryCode?: string | null;
  bio?: string | null;
}

export async function updateProfile(
  db: Db,
  userId: string,
  patch: ProfilePatch
): Promise<UserRow> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.handle !== undefined) {
    validateHandle(patch.handle);
    set.handle = patch.handle;
  }
  if (patch.displayName !== undefined) {
    const name = patch.displayName?.trim() || null;
    if (name && name.length > 60) {
      throw new AccountError("display_name_length", "Display names are at most 60 characters.");
    }
    set.displayName = name;
  }
  if (patch.countryCode !== undefined) {
    const cc = patch.countryCode?.trim().toUpperCase() || null;
    if (cc && !/^[A-Z]{2}$/.test(cc)) {
      throw new AccountError("country_code", "Country codes are two letters (ISO 3166-1).");
    }
    set.countryCode = cc;
  }
  if (patch.bio !== undefined) {
    const bio = patch.bio?.trim() || null;
    if (bio && bio.length > 500) {
      throw new AccountError("bio_length", "Bios are at most 500 characters.");
    }
    set.bio = bio;
  }
  if (Object.keys(set).length === 0) {
    const user = await getUser(db, userId);
    if (!user) throw new AccountError("user_missing", "No such account.", 404);
    return user;
  }
  try {
    const updated = await db.update(users).set(set).where(eq(users.id, userId)).returning();
    const user = updated[0];
    if (!user) throw new AccountError("user_missing", "No such account.", 404);
    if (set.handle) await logAudit(db, userId, "account.rename", { handle: set.handle });
    return user;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AccountError("handle_taken", "That handle is already taken.", 409);
    }
    throw error;
  }
}

/**
 * Preference sync (B2.5): the full preference object lands in users.prefs;
 * the two A2.2 named columns stay denormalized mirrors. Content is
 * client-shaped — the server checks only that it is a sane JSON object.
 */
export async function updatePrefs(
  db: Db,
  userId: string,
  prefs: unknown
): Promise<Record<string, unknown>> {
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
    throw new AccountError("prefs_shape", "Preferences must be a JSON object.");
  }
  const obj = prefs as Record<string, unknown>;
  if (JSON.stringify(obj).length > 16_384) {
    throw new AccountError("prefs_size", "Preferences object is too large.");
  }
  const updated = await db
    .update(users)
    .set({
      prefs: obj,
      prefersBoardTheme: typeof obj.boardTheme === "string" ? obj.boardTheme : null,
      prefersPieceSet: typeof obj.pieceSet === "string" ? obj.pieceSet : null,
    })
    .where(eq(users.id, userId))
    .returning();
  if (!updated[0]) throw new AccountError("user_missing", "No such account.", 404);
  return obj;
}

/** A2.4 soft delete: 30-day recovery window; sessions revoked immediately. */
export async function softDeleteUser(db: Db, userId: string, now = new Date()): Promise<Date> {
  const updated = await db
    .update(users)
    .set({ deletedAt: now })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning();
  if (!updated[0]) throw new AccountError("user_missing", "No such active account.", 404);
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await logAudit(db, userId, "account.softDelete", {
    recoverableUntil: recoverableUntil(now).toISOString(),
  });
  return now;
}

export function recoverableUntil(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RECOVERY_WINDOW_DAYS * 86_400_000);
}

export async function recoverUser(db: Db, userId: string, now = new Date()): Promise<UserRow> {
  const user = await getUser(db, userId);
  if (!user || user.deletedAt === null) {
    throw new AccountError("not_deleted", "This account is not pending deletion.", 409);
  }
  if (now > recoverableUntil(user.deletedAt)) {
    throw new AccountError(
      "recovery_expired",
      "The 30-day recovery window has passed.",
      410
    );
  }
  const updated = await db
    .update(users)
    .set({ deletedAt: null })
    .where(eq(users.id, userId))
    .returning();
  await logAudit(db, userId, "account.recover", {});
  const recovered = updated[0];
  if (!recovered) throw new AccountError("user_missing", "Account disappeared.", 500);
  return recovered;
}

/**
 * Hard delete — the FK cascade tested by gate G5 and the Phase 1.5 gate does
 * the actual work. The audit row is written first and survives with a nulled
 * user id.
 */
export async function hardDeleteUser(db: Db, userId: string): Promise<void> {
  await logAudit(db, userId, "account.hardDelete", {});
  await db.delete(users).where(eq(users.id, userId));
}

/** Cron entry point: hard-delete every account past its recovery window. */
export async function purgeDeletedUsers(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - RECOVERY_WINDOW_DAYS * 86_400_000);
  const expired = await db
    .select({ id: users.id })
    .from(users)
    .where(and(lt(users.deletedAt, cutoff), sql`${users.deletedAt} is not null`));
  for (const row of expired) {
    await hardDeleteUser(db, row.id);
  }
  return expired.map((row) => row.id);
}

// --- Device sessions (A2.2) ---

/**
 * Records/refreshes this device's session row. The id is a client-generated
 * stable device UUID; a revoked row tells the device to sign itself out on
 * its next bootstrap.
 */
export async function upsertSession(
  db: Db,
  userId: string,
  device: { id: string; label?: string | null; ip?: string | null; userAgent?: string | null }
): Promise<{ revoked: boolean }> {
  const existing = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, device.id))
    .limit(1);
  const row = existing[0];
  if (row) {
    if (row.userId !== userId) {
      // Device switched accounts: retire the old row's claim on this id.
      await db
        .update(sessions)
        .set({ userId, deviceLabel: device.label ?? row.deviceLabel, ip: device.ip ?? row.ip, userAgent: device.userAgent ?? row.userAgent, revokedAt: null, createdAt: new Date() })
        .where(eq(sessions.id, device.id));
      return { revoked: false };
    }
    if (row.revokedAt !== null) return { revoked: true };
    await db
      .update(sessions)
      .set({ ip: device.ip ?? row.ip, userAgent: device.userAgent ?? row.userAgent })
      .where(eq(sessions.id, device.id));
    return { revoked: false };
  }
  await db.insert(sessions).values({
    id: device.id,
    userId,
    deviceLabel: device.label ?? null,
    ip: device.ip ?? null,
    userAgent: device.userAgent ?? null,
  });
  return { revoked: false };
}

export async function listSessions(db: Db, userId: string) {
  return db
    .select({
      id: sessions.id,
      deviceLabel: sessions.deviceLabel,
      createdAt: sessions.createdAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sessions.createdAt);
}

/** Marks a device session revoked; that device signs out on its next bootstrap. */
export async function revokeSession(db: Db, userId: string, sessionId: string): Promise<void> {
  const updated = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning();
  if (!updated[0]) throw new AccountError("session_missing", "No such session.", 404);
}
