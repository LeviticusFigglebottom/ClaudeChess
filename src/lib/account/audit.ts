import { auditLog } from "@/db/schema";
import type { Db } from "./types";

/**
 * Audit trail (A2.2): auth events, conversions, deletions, admin actions.
 * Rows outlive the user (FK is ON DELETE SET NULL) so account history stays
 * reconstructible after a hard delete.
 */
export async function logAudit(
  db: Db,
  userId: string | null,
  action: string,
  meta?: Record<string, unknown>
): Promise<void> {
  await db.insert(auditLog).values({ userId, action, meta });
}
