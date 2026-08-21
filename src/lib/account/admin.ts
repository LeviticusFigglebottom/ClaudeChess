import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { logAudit } from "./audit";
import { getUserByHandle } from "./users";
import { AccountError, type Db, type UserRow } from "./types";

/**
 * B1.3 — the admin grant path for users.title. Titles are FIDE-style,
 * admin-granted only, never self-service. Admins are designated by the
 * ADMIN_USER_IDS env var (comma-separated auth UUIDs) — deliberate: a
 * personal deployment needs a grant path, not an admin-management UI.
 */

export const GRANTABLE_TITLES = [
  "GM",
  "IM",
  "FM",
  "CM",
  "NM",
  "WGM",
  "WIM",
  "WFM",
  "WCM",
] as const;

export type GrantableTitle = (typeof GRANTABLE_TITLES)[number];

export function parseAdminIds(raw: string | undefined = process.env.ADMIN_USER_IDS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

export function isAdminId(userId: string, adminIds: Set<string> = parseAdminIds()): boolean {
  return adminIds.has(userId);
}

/** Grants (or with title=null revokes) a display title. Audit-logged. */
export async function grantTitle(
  db: Db,
  admin: Pick<UserRow, "id">,
  targetHandle: string,
  title: string | null,
  adminIds: Set<string> = parseAdminIds()
): Promise<UserRow> {
  if (!isAdminId(admin.id, adminIds)) {
    throw new AccountError("admin_required", "Admin access required.", 403);
  }
  if (title !== null && !(GRANTABLE_TITLES as readonly string[]).includes(title)) {
    throw new AccountError(
      "title_invalid",
      `Title must be one of ${GRANTABLE_TITLES.join(", ")} or null to revoke.`
    );
  }
  const target = await getUserByHandle(db, targetHandle);
  if (!target) throw new AccountError("user_not_found", "No player with that handle.", 404);
  const updated = await db
    .update(users)
    .set({ title })
    .where(eq(users.id, target.id))
    .returning();
  const user = updated[0];
  if (!user) throw new AccountError("user_missing", "Account disappeared.", 500);
  await logAudit(db, admin.id, "admin.grantTitle", {
    target: target.id,
    targetHandle: target.handle,
    title,
  });
  return user;
}
