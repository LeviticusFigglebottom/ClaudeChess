import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import {
  accountsConfigured,
  getAuthShape,
  handleApi,
  ownProfile,
  readJson,
} from "@/lib/account/api";
import { getRatingStates, seedRatings } from "@/lib/account/games";
import { AccountError } from "@/lib/account/types";
import { ensureUser, recoverableUntil, updatePrefs, upsertSession } from "@/lib/account/users";
import type { RatingPeriodState } from "@/lib/rating/period";

/**
 * POST /api/account/bootstrap — called by the client after every sign-in
 * (including the automatic anonymous one on first visit, A2.1). Idempotent:
 * creates/reconciles the users row, seeds server state from the device's
 * localStorage (prefs and ratings — fill-only, server always wins once it
 * has state), and registers the device session.
 *
 * This is also where the anonymous→permanent conversion lands server-side:
 * the auth id never changes, so games/ratings/attempts stay linked for free.
 */
export async function POST(request: Request) {
  return handleApi(async () => {
    if (!accountsConfigured()) {
      throw new AccountError("accounts_disabled", "Accounts are not configured.", 503);
    }
    const auth = await getAuthShape();
    if (!auth) throw new AccountError("unauthenticated", "Sign-in required.", 401);

    const body = await readJson(request);
    const db = getDb();
    const ensured = await ensureUser(db, auth, {
      desiredHandle: typeof body.desiredHandle === "string" ? body.desiredHandle : undefined,
    });

    if (ensured.softDeleted) {
      const deletedAt = ensured.user.deletedAt;
      return NextResponse.json(
        {
          softDeleted: true,
          recoverableUntil: deletedAt ? recoverableUntil(deletedAt).toISOString() : null,
        },
        { status: 410 }
      );
    }

    let user = ensured.user;

    // Preference sync (B2.5): DB wins once it holds prefs; otherwise the
    // device's localStorage copy seeds it. Either way the response carries
    // the authoritative object for the client cache.
    if (
      user.prefs == null &&
      typeof body.prefs === "object" &&
      body.prefs !== null &&
      !Array.isArray(body.prefs)
    ) {
      await updatePrefs(db, user.id, body.prefs);
      user = { ...user, prefs: body.prefs as Record<string, unknown> };
    }

    // Rating seed (fill-only) then authoritative read-back.
    if (Array.isArray(body.ratings)) {
      const entries = body.ratings
        .filter(
          (entry): entry is { variant: string; bucket: string; state: RatingPeriodState } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { variant?: unknown }).variant === "string" &&
            typeof (entry as { bucket?: unknown }).bucket === "string" &&
            typeof (entry as { state?: unknown }).state === "object"
        )
        .slice(0, 40);
      if (entries.length) await seedRatings(db, user.id, entries);
    }
    const ratings = await getRatingStates(db, user.id);

    let deviceRevoked = false;
    if (typeof body.deviceId === "string" && /^[0-9a-f-]{36}$/i.test(body.deviceId)) {
      const { revoked } = await upsertSession(db, user.id, {
        id: body.deviceId,
        label: typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 80) : null,
        userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? null,
        ip:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ?? null,
      });
      deviceRevoked = revoked;
    }

    return NextResponse.json({
      user: ownProfile(user),
      converted: ensured.converted,
      created: ensured.created,
      prefs: user.prefs ?? null,
      ratings,
      deviceRevoked,
    });
  });
}
