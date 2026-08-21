import { and, desc, eq, gt, or } from "drizzle-orm";
import { challenges, users } from "@/db/schema";
import { isVariantId, type VariantId } from "@/lib/chess/variant";
import { logAudit } from "./audit";
import { isBlockedEither, type PublicUser } from "./relationships";
import { getUserByHandle } from "./users";
import { AccountError, isVerified, type Db, type UserRow } from "./types";

/**
 * Challenges (A2.2): direct (to a named player) or open (a shareable token
 * link — toUserId null). Blocks are enforced at create AND accept; rated
 * challenges require verified accounts on both ends (A2.1). An accepted
 * challenge is where Phase 4 creates the multiplayer game.
 */

export const CHALLENGE_TTL_MINUTES_DEFAULT = 24 * 60;
export const CHALLENGE_TTL_MINUTES_MAX = 7 * 24 * 60;

/** Time controls a challenge may carry: "base+inc" in seconds, e.g. "300+3". */
const TIME_CONTROL_RE = /^([1-9]\d{1,4})\+(\d{1,3})$/;

export function validateChallengeTimeControl(timeControl: string): void {
  const match = timeControl.match(TIME_CONTROL_RE);
  if (!match) {
    throw new AccountError(
      "time_control",
      'Time control must be "base+increment" in seconds, e.g. "300+3".'
    );
  }
  const base = Number(match[1]);
  if (base < 60) {
    throw new AccountError("time_control", "Base time must be at least 60 seconds.");
  }
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface CreateChallengeInput {
  /** Omit for an open (shareable link) challenge. */
  toHandle?: string;
  variant: string;
  timeControl: string;
  rated: boolean;
  color: "white" | "black" | "random";
  ttlMinutes?: number;
}

export type ChallengeRow = typeof challenges.$inferSelect;

export async function createChallenge(
  db: Db,
  from: UserRow,
  input: CreateChallengeInput,
  now: Date = new Date()
): Promise<ChallengeRow> {
  if (!isVariantId(input.variant)) {
    throw new AccountError("variant", "Unknown variant.");
  }
  const variant = input.variant as VariantId;
  if (variant !== "standard" && variant !== "chess960") {
    throw new AccountError("variant", "Only standard and Chess960 challenges for now (variants arrive in Phase 4.5).");
  }
  validateChallengeTimeControl(input.timeControl);
  if (!["white", "black", "random"].includes(input.color)) {
    throw new AccountError("color", "Color must be white, black, or random.");
  }
  if (input.rated && !isVerified(from)) {
    throw new AccountError(
      "verified_required",
      "Rated challenges require a verified account.",
      403
    );
  }
  const ttl = Math.min(
    Math.max(input.ttlMinutes ?? CHALLENGE_TTL_MINUTES_DEFAULT, 5),
    CHALLENGE_TTL_MINUTES_MAX
  );
  const expiresAt = new Date(now.getTime() + ttl * 60_000);

  let toUserId: string | null = null;
  if (input.toHandle !== undefined && input.toHandle !== null && input.toHandle !== "") {
    const target = await getUserByHandle(db, input.toHandle);
    if (!target || target.deletedAt !== null) {
      throw new AccountError("user_not_found", "No player with that handle.", 404);
    }
    if (target.id === from.id) {
      throw new AccountError("self_challenge", "You cannot challenge yourself.");
    }
    if (await isBlockedEither(db, from.id, target.id)) {
      throw new AccountError("cannot_challenge", "You cannot challenge this player.", 403);
    }
    toUserId = target.id;
  }

  const inserted = await db
    .insert(challenges)
    .values({
      fromUserId: from.id,
      toUserId,
      variant,
      timeControl: input.timeControl,
      rated: input.rated,
      color: input.color,
      token: toUserId === null ? generateToken() : null,
      expiresAt,
    })
    .returning();
  const challenge = inserted[0];
  if (!challenge) throw new AccountError("challenge_insert", "Insert returned no row.", 500);
  await logAudit(db, from.id, "challenge.create", {
    challengeId: challenge.id,
    open: toUserId === null,
    rated: input.rated,
  });
  return challenge;
}

export function isExpired(challenge: ChallengeRow, now: Date = new Date()): boolean {
  return challenge.expiresAt.getTime() <= now.getTime();
}

export interface ChallengeView {
  id: string;
  from: PublicUser;
  to: PublicUser | null;
  variant: string;
  timeControl: string;
  rated: boolean;
  color: "white" | "black" | "random";
  status: "open" | "accepted" | "declined" | "canceled" | "expired";
  token: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedBy: PublicUser | null;
}

async function publicUser(db: Db, userId: string | null): Promise<PublicUser | null> {
  if (!userId) return null;
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) return null;
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    countryCode: user.countryCode,
    title: user.title,
  };
}

export async function toChallengeView(
  db: Db,
  challenge: ChallengeRow,
  now: Date = new Date()
): Promise<ChallengeView> {
  return {
    id: challenge.id,
    from: (await publicUser(db, challenge.fromUserId)) ?? {
      id: challenge.fromUserId,
      handle: "(deleted)",
      displayName: null,
      countryCode: null,
      title: null,
    },
    to: await publicUser(db, challenge.toUserId),
    variant: challenge.variant,
    timeControl: challenge.timeControl,
    rated: challenge.rated,
    color: challenge.color,
    status:
      challenge.status === "open" && isExpired(challenge, now) ? "expired" : challenge.status,
    token: challenge.token,
    createdAt: challenge.createdAt.toISOString(),
    expiresAt: challenge.expiresAt.toISOString(),
    acceptedBy: await publicUser(db, challenge.acceptedByUserId),
  };
}

export async function getChallengeByToken(db: Db, token: string): Promise<ChallengeRow | null> {
  const rows = await db.select().from(challenges).where(eq(challenges.token, token)).limit(1);
  return rows[0] ?? null;
}

export async function getChallenge(db: Db, id: string): Promise<ChallengeRow | null> {
  const rows = await db.select().from(challenges).where(eq(challenges.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Accepts a challenge. Every rule that applied at creation is re-checked at
 * accept time — blocks may have appeared since, the challenge may have
 * expired, and rated still needs a verified acceptor.
 */
export async function acceptChallenge(
  db: Db,
  acceptor: UserRow,
  challengeId: string,
  now: Date = new Date()
): Promise<ChallengeRow> {
  const challenge = await getChallenge(db, challengeId);
  if (!challenge) throw new AccountError("challenge_missing", "No such challenge.", 404);
  if (challenge.status !== "open") {
    throw new AccountError("challenge_closed", `This challenge was already ${challenge.status}.`, 409);
  }
  if (isExpired(challenge, now)) {
    throw new AccountError("challenge_expired", "This challenge has expired.", 410);
  }
  if (challenge.fromUserId === acceptor.id) {
    throw new AccountError("self_accept", "You cannot accept your own challenge.");
  }
  if (challenge.toUserId !== null && challenge.toUserId !== acceptor.id) {
    throw new AccountError("challenge_missing", "No such challenge.", 404);
  }
  if (await isBlockedEither(db, challenge.fromUserId, acceptor.id)) {
    throw new AccountError("cannot_accept", "You cannot accept this challenge.", 403);
  }
  if (challenge.rated && !isVerified(acceptor)) {
    throw new AccountError(
      "verified_required",
      "Rated challenges require a verified account.",
      403
    );
  }
  const updated = await db
    .update(challenges)
    .set({ status: "accepted", acceptedByUserId: acceptor.id, acceptedAt: now })
    .where(and(eq(challenges.id, challenge.id), eq(challenges.status, "open")))
    .returning();
  const accepted = updated[0];
  if (!accepted) {
    throw new AccountError("challenge_closed", "This challenge was just taken.", 409);
  }
  await logAudit(db, acceptor.id, "challenge.accept", { challengeId: challenge.id });
  return accepted;
}

/** Declines a direct challenge — addressee only. */
export async function declineChallenge(db: Db, userId: string, challengeId: string): Promise<void> {
  const updated = await db
    .update(challenges)
    .set({ status: "declined" })
    .where(
      and(
        eq(challenges.id, challengeId),
        eq(challenges.status, "open"),
        eq(challenges.toUserId, userId)
      )
    )
    .returning();
  if (!updated[0]) throw new AccountError("challenge_missing", "No such open challenge.", 404);
}

/** Cancels one's own open challenge. */
export async function cancelChallenge(db: Db, userId: string, challengeId: string): Promise<void> {
  const updated = await db
    .update(challenges)
    .set({ status: "canceled" })
    .where(
      and(
        eq(challenges.id, challengeId),
        eq(challenges.status, "open"),
        eq(challenges.fromUserId, userId)
      )
    )
    .returning();
  if (!updated[0]) throw new AccountError("challenge_missing", "No such open challenge.", 404);
}

export interface ChallengeLists {
  incoming: ChallengeView[];
  outgoing: ChallengeView[];
}

export async function listChallenges(
  db: Db,
  userId: string,
  now: Date = new Date()
): Promise<ChallengeLists> {
  const open = await db
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.status, "open"),
        gt(challenges.expiresAt, now),
        or(eq(challenges.toUserId, userId), eq(challenges.fromUserId, userId))
      )
    )
    .orderBy(desc(challenges.createdAt))
    .limit(50);
  const lists: ChallengeLists = { incoming: [], outgoing: [] };
  for (const challenge of open) {
    const view = await toChallengeView(db, challenge, now);
    if (challenge.fromUserId === userId) lists.outgoing.push(view);
    else lists.incoming.push(view);
  }
  return lists;
}
