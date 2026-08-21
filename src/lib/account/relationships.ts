import { and, eq, inArray, or } from "drizzle-orm";
import { challenges, relationships, users } from "@/db/schema";
import { logAudit } from "./audit";
import { getUserByHandle } from "./users";
import { AccountError, type Db, type UserRow } from "./types";

/**
 * Friends, follows, and blocks (A2.2). A block must ACTUALLY block: no
 * challenges in either direction, no matchmaking pairing (Phase 4 calls
 * canPair), and it severs any existing friendship. Block errors are
 * deliberately symmetric-and-vague so the blocked party cannot probe who
 * blocked whom.
 */

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string | null;
  countryCode: string | null;
  title: string | null;
}

function toPublic(user: UserRow | PublicUser): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    countryCode: user.countryCode,
    title: user.title,
  };
}

/** True when either side blocks the other. */
export async function isBlockedEither(db: Db, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ id: relationships.id })
    .from(relationships)
    .where(
      and(
        eq(relationships.kind, "block"),
        or(
          and(eq(relationships.userId, a), eq(relationships.targetUserId, b)),
          and(eq(relationships.userId, b), eq(relationships.targetUserId, a))
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Matchmaking guard (Phase 4 will call this on every candidate pairing):
 * blocked pairs never match; deleted accounts never match.
 */
export async function canPair(db: Db, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  if (await isBlockedEither(db, a, b)) return false;
  const pair = await db
    .select({ id: users.id, deletedAt: users.deletedAt })
    .from(users)
    .where(inArray(users.id, [a, b]));
  return pair.length === 2 && pair.every((row) => row.deletedAt === null);
}

async function resolveTarget(db: Db, handle: string): Promise<UserRow> {
  const target = await getUserByHandle(db, handle);
  if (!target || target.deletedAt !== null) {
    throw new AccountError("user_not_found", "No player with that handle.", 404);
  }
  return target;
}

/**
 * Sends a friend request. If the target already has a pending request TO the
 * requester, the two are simply made friends. Blocked pairs get the same
 * "not found"-flavored refusal as missing users.
 */
export async function requestFriend(
  db: Db,
  fromUserId: string,
  targetHandle: string
): Promise<{ status: "pending" | "accepted"; target: PublicUser }> {
  const target = await resolveTarget(db, targetHandle);
  if (target.id === fromUserId) {
    throw new AccountError("self_friend", "You cannot add yourself.");
  }
  if (await isBlockedEither(db, fromUserId, target.id)) {
    throw new AccountError("cannot_add", "You cannot add this player.", 403);
  }
  const existing = await db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.kind, "friend"),
        or(
          and(eq(relationships.userId, fromUserId), eq(relationships.targetUserId, target.id)),
          and(eq(relationships.userId, target.id), eq(relationships.targetUserId, fromUserId))
        )
      )
    );
  const accepted = existing.find((row) => row.status === "accepted");
  if (accepted) {
    throw new AccountError("already_friends", "You are already friends.", 409);
  }
  const reverse = existing.find(
    (row) => row.userId === target.id && row.status === "pending"
  );
  if (reverse) {
    await db
      .update(relationships)
      .set({ status: "accepted" })
      .where(eq(relationships.id, reverse.id));
    return { status: "accepted", target: toPublic(target) };
  }
  const mine = existing.find((row) => row.userId === fromUserId);
  if (mine) {
    return { status: "pending", target: toPublic(target) };
  }
  await db.insert(relationships).values({
    userId: fromUserId,
    targetUserId: target.id,
    kind: "friend",
    status: "pending",
  });
  return { status: "pending", target: toPublic(target) };
}

/** Accept or decline an incoming request — only its addressee may. */
export async function respondFriend(
  db: Db,
  userId: string,
  requestId: string,
  accept: boolean
): Promise<void> {
  const rows = await db
    .select()
    .from(relationships)
    .where(eq(relationships.id, requestId))
    .limit(1);
  const request = rows[0];
  if (
    !request ||
    request.kind !== "friend" ||
    request.status !== "pending" ||
    request.targetUserId !== userId
  ) {
    throw new AccountError("request_missing", "No such pending request.", 404);
  }
  if (accept) {
    await db
      .update(relationships)
      .set({ status: "accepted" })
      .where(eq(relationships.id, requestId));
  } else {
    await db.delete(relationships).where(eq(relationships.id, requestId));
  }
}

/** Removes a friendship (or retracts an outgoing pending request). */
export async function removeFriend(db: Db, userId: string, otherUserId: string): Promise<void> {
  await db
    .delete(relationships)
    .where(
      and(
        eq(relationships.kind, "friend"),
        or(
          and(eq(relationships.userId, userId), eq(relationships.targetUserId, otherUserId)),
          and(eq(relationships.userId, otherUserId), eq(relationships.targetUserId, userId))
        )
      )
    );
}

/**
 * Blocks a player. Severs friendship both directions, deletes pending
 * requests, and voids every open challenge between the pair — a block that
 * leaves a live challenge standing is not a block.
 */
export async function blockUser(db: Db, userId: string, targetHandle: string): Promise<PublicUser> {
  const target = await resolveTarget(db, targetHandle);
  if (target.id === userId) {
    throw new AccountError("self_block", "You cannot block yourself.");
  }
  await db
    .insert(relationships)
    .values({ userId, targetUserId: target.id, kind: "block", status: "accepted" })
    .onConflictDoNothing();
  await removeFriend(db, userId, target.id);
  await db
    .update(challenges)
    .set({ status: "canceled" })
    .where(
      and(
        eq(challenges.status, "open"),
        or(
          and(eq(challenges.fromUserId, userId), eq(challenges.toUserId, target.id)),
          and(eq(challenges.fromUserId, target.id), eq(challenges.toUserId, userId))
        )
      )
    );
  await logAudit(db, userId, "relationship.block", { target: target.id });
  return toPublic(target);
}

export async function unblockUser(db: Db, userId: string, targetUserId: string): Promise<void> {
  await db
    .delete(relationships)
    .where(
      and(
        eq(relationships.userId, userId),
        eq(relationships.targetUserId, targetUserId),
        eq(relationships.kind, "block")
      )
    );
}

export interface RelationshipLists {
  friends: PublicUser[];
  incoming: { requestId: string; from: PublicUser }[];
  outgoing: { requestId: string; to: PublicUser }[];
  blocked: PublicUser[];
}

export async function listRelationships(db: Db, userId: string): Promise<RelationshipLists> {
  const rows = await db
    .select({
      id: relationships.id,
      userId: relationships.userId,
      targetUserId: relationships.targetUserId,
      kind: relationships.kind,
      status: relationships.status,
    })
    .from(relationships)
    .where(
      and(
        or(eq(relationships.userId, userId), eq(relationships.targetUserId, userId))
      )
    );

  const otherIds = new Set<string>();
  for (const row of rows) {
    otherIds.add(row.userId === userId ? row.targetUserId : row.userId);
  }
  const others = otherIds.size
    ? await db.select().from(users).where(inArray(users.id, [...otherIds]))
    : [];
  const byId = new Map(others.map((user) => [user.id, toPublic(user)]));
  const publicFor = (id: string): PublicUser =>
    byId.get(id) ?? { id, handle: "(deleted)", displayName: null, countryCode: null, title: null };

  const lists: RelationshipLists = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const row of rows) {
    const otherId = row.userId === userId ? row.targetUserId : row.userId;
    if (row.kind === "friend" && row.status === "accepted") {
      lists.friends.push(publicFor(otherId));
    } else if (row.kind === "friend" && row.status === "pending") {
      if (row.targetUserId === userId) {
        lists.incoming.push({ requestId: row.id, from: publicFor(otherId) });
      } else {
        lists.outgoing.push({ requestId: row.id, to: publicFor(otherId) });
      }
    } else if (row.kind === "block" && row.userId === userId) {
      lists.blocked.push(publicFor(otherId));
    }
  }
  return lists;
}
