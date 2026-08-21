import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { challenges } from "@/db/schema";
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  declineChallenge,
  getChallengeByToken,
  listChallenges,
  toChallengeView,
} from "./challenges";
import {
  blockUser,
  canPair,
  isBlockedEither,
  listRelationships,
  requestFriend,
  respondFriend,
  unblockUser,
} from "./relationships";
import { createTestDb, type TestDb } from "./test-db";
import type { AuthShape, UserRow } from "./types";
import { ensureUser, softDeleteUser } from "./users";

/**
 * Friends, blocks, and challenge links (A2.2, Phase 1.5). The load-bearing
 * assertions: a block actually blocks — no challenges either direction, no
 * matchmaking pairing (canPair), severed friendship, voided open challenges.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});

let seq = 0;
async function makeUser(verified = false): Promise<UserRow> {
  const auth: AuthShape = verified
    ? {
        id: randomUUID(),
        isAnonymous: false,
        email: `${randomUUID()}@example.com`,
        emailConfirmedAt: new Date().toISOString(),
      }
    : { id: randomUUID(), isAnonymous: true, email: null, emailConfirmedAt: null };
  const { user } = await ensureUser(t.db, auth, { desiredHandle: `social-${seq++}` });
  return user;
}

describe("friends", () => {
  it("request → accept lifecycle", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const requested = await requestFriend(t.db, a.id, b.handle);
    expect(requested.status).toBe("pending");

    const bLists = await listRelationships(t.db, b.id);
    expect(bLists.incoming).toHaveLength(1);
    expect(bLists.incoming[0]?.from.handle).toBe(a.handle);

    await respondFriend(t.db, b.id, bLists.incoming[0]!.requestId, true);
    const aLists = await listRelationships(t.db, a.id);
    expect(aLists.friends.map((f) => f.handle)).toContain(b.handle);
  });

  it("a reverse pending request auto-accepts instead of duplicating", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await requestFriend(t.db, a.id, b.handle);
    const result = await requestFriend(t.db, b.id, a.handle);
    expect(result.status).toBe("accepted");
    const lists = await listRelationships(t.db, a.id);
    expect(lists.friends).toHaveLength(1);
    expect(lists.outgoing).toHaveLength(0);
  });

  it("declining deletes the request; only the addressee can respond", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await requestFriend(t.db, a.id, b.handle);
    const lists = await listRelationships(t.db, b.id);
    const requestId = lists.incoming[0]!.requestId;
    await expect(respondFriend(t.db, a.id, requestId, true)).rejects.toMatchObject({
      code: "request_missing",
    });
    await respondFriend(t.db, b.id, requestId, false);
    expect((await listRelationships(t.db, a.id)).outgoing).toHaveLength(0);
  });

  it("self-add and unknown handles are rejected", async () => {
    const a = await makeUser();
    await expect(requestFriend(t.db, a.id, a.handle)).rejects.toMatchObject({
      code: "self_friend",
    });
    await expect(requestFriend(t.db, a.id, "no-such-player-xyz")).rejects.toMatchObject({
      code: "user_not_found",
    });
  });
});

describe("GATE: blocks actually block", () => {
  it("block severs friendship, voids open challenges, kills pairing and re-adding", async () => {
    const a = await makeUser();
    const b = await makeUser();
    // Friends first, with a live challenge from b to a.
    await requestFriend(t.db, a.id, b.handle);
    const lists = await listRelationships(t.db, b.id);
    await respondFriend(t.db, b.id, lists.incoming[0]!.requestId, true);
    const challenge = await createChallenge(t.db, b, {
      toHandle: a.handle,
      variant: "standard",
      timeControl: "300+3",
      rated: false,
      color: "random",
    });
    expect(await canPair(t.db, a.id, b.id)).toBe(true);

    await blockUser(t.db, a.id, b.handle);

    // Friendship severed, both directions.
    expect((await listRelationships(t.db, a.id)).friends).toHaveLength(0);
    expect((await listRelationships(t.db, b.id)).friends).toHaveLength(0);
    // The open challenge is voided.
    const challengeRows = await t.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challenge.id));
    expect(challengeRows[0]?.status).toBe("canceled");
    // No matchmaking pairing (Phase 4 calls this).
    expect(await isBlockedEither(t.db, a.id, b.id)).toBe(true);
    expect(await isBlockedEither(t.db, b.id, a.id)).toBe(true);
    expect(await canPair(t.db, a.id, b.id)).toBe(false);
    expect(await canPair(t.db, b.id, a.id)).toBe(false);
    // No new challenges in either direction.
    const challengeInput = {
      variant: "standard",
      timeControl: "300+3",
      rated: false,
      color: "random" as const,
    };
    await expect(
      createChallenge(t.db, a, { ...challengeInput, toHandle: b.handle })
    ).rejects.toMatchObject({ code: "cannot_challenge" });
    await expect(
      createChallenge(t.db, b, { ...challengeInput, toHandle: a.handle })
    ).rejects.toMatchObject({ code: "cannot_challenge" });
    // No re-adding, from either side.
    await expect(requestFriend(t.db, a.id, b.handle)).rejects.toMatchObject({
      code: "cannot_add",
    });
    await expect(requestFriend(t.db, b.id, a.handle)).rejects.toMatchObject({
      code: "cannot_add",
    });
    // The blocked party cannot accept an open (token) challenge from the blocker.
    const open = await createChallenge(t.db, a, challengeInput);
    await expect(acceptChallenge(t.db, b, open.id)).rejects.toMatchObject({
      code: "cannot_accept",
    });

    // Unblock restores pairing.
    await unblockUser(t.db, a.id, b.id);
    expect(await canPair(t.db, a.id, b.id)).toBe(true);
  });

  it("blocked lists show only the blocker's own blocks", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await blockUser(t.db, a.id, b.handle);
    expect((await listRelationships(t.db, a.id)).blocked.map((u) => u.handle)).toContain(
      b.handle
    );
    expect((await listRelationships(t.db, b.id)).blocked).toHaveLength(0);
  });

  it("canPair refuses deleted accounts", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await softDeleteUser(t.db, b.id);
    expect(await canPair(t.db, a.id, b.id)).toBe(false);
  });
});

describe("challenges", () => {
  const input = {
    variant: "standard",
    timeControl: "300+3",
    rated: false,
    color: "random" as const,
  };

  it("direct challenges: addressee-only accept; decline; cancel", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    const direct = await createChallenge(t.db, a, { ...input, toHandle: b.handle });
    expect(direct.token).toBeNull();

    await expect(acceptChallenge(t.db, c, direct.id)).rejects.toMatchObject({
      code: "challenge_missing",
    });
    await expect(acceptChallenge(t.db, a, direct.id)).rejects.toMatchObject({
      code: "self_accept",
    });
    const accepted = await acceptChallenge(t.db, b, direct.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedByUserId).toBe(b.id);

    const second = await createChallenge(t.db, a, { ...input, toHandle: b.handle });
    await declineChallenge(t.db, b.id, second.id);
    const third = await createChallenge(t.db, a, { ...input, toHandle: b.handle });
    await cancelChallenge(t.db, a.id, third.id);
    await expect(cancelChallenge(t.db, b.id, third.id)).rejects.toMatchObject({
      code: "challenge_missing",
    });
  });

  it("open challenges carry a token anyone (except the creator) can accept once", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    const open = await createChallenge(t.db, a, input);
    expect(open.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(open.toUserId).toBeNull();

    const found = await getChallengeByToken(t.db, open.token!);
    expect(found?.id).toBe(open.id);

    await acceptChallenge(t.db, b, open.id);
    await expect(acceptChallenge(t.db, c, open.id)).rejects.toMatchObject({
      code: "challenge_closed",
    });
  });

  it("expired challenges cannot be accepted and render as expired", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const open = await createChallenge(t.db, a, { ...input, ttlMinutes: 5 });
    const later = new Date(Date.now() + 6 * 60_000);
    await expect(acceptChallenge(t.db, b, open.id, later)).rejects.toMatchObject({
      code: "challenge_expired",
    });
    const view = await toChallengeView(t.db, open, later);
    expect(view.status).toBe("expired");
  });

  it("rated challenges require verified accounts on both ends (A2.1)", async () => {
    const anon = await makeUser(false);
    const verified = await makeVerifiedPair();
    await expect(
      createChallenge(t.db, anon, { ...input, rated: true })
    ).rejects.toMatchObject({ code: "verified_required" });

    const rated = await createChallenge(t.db, verified.a, { ...input, rated: true });
    await expect(acceptChallenge(t.db, anon, rated.id)).rejects.toMatchObject({
      code: "verified_required",
    });
    const accepted = await acceptChallenge(t.db, verified.b, rated.id);
    expect(accepted.status).toBe("accepted");
  });

  it("validates variant and time control", async () => {
    const a = await makeUser();
    await expect(
      createChallenge(t.db, a, { ...input, variant: "duckchess" })
    ).rejects.toMatchObject({ code: "variant" });
    await expect(
      createChallenge(t.db, a, { ...input, timeControl: "banana" })
    ).rejects.toMatchObject({ code: "time_control" });
    await expect(
      createChallenge(t.db, a, { ...input, timeControl: "30+0" })
    ).rejects.toMatchObject({ code: "time_control" });
    const chess960 = await createChallenge(t.db, a, { ...input, variant: "chess960" });
    expect(chess960.variant).toBe("chess960");
  });

  it("lists split incoming and outgoing, hiding closed and expired", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await createChallenge(t.db, a, { ...input, toHandle: b.handle });
    const open = await createChallenge(t.db, a, input);
    const toCancel = await createChallenge(t.db, a, { ...input, toHandle: b.handle });
    await cancelChallenge(t.db, a.id, toCancel.id);

    const aLists = await listChallenges(t.db, a.id);
    expect(aLists.outgoing).toHaveLength(2);
    expect(aLists.incoming).toHaveLength(0);
    const bLists = await listChallenges(t.db, b.id);
    expect(bLists.incoming).toHaveLength(1);
    expect(bLists.incoming[0]?.from.handle).toBe(a.handle);
    expect(aLists.outgoing.map((c) => c.id)).toContain(open.id);
  });

  async function makeVerifiedPair() {
    return { a: await makeUser(true), b: await makeUser(true) };
  }
});
