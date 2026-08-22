import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { devAuthEnabled, requireUser } from "@/lib/account/api";
import { verifyLinkedAccount } from "@/lib/import/importer";
import {
  exchangeAndFetchIdentity,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  requestOrigin,
} from "@/lib/import/lichess-oauth";

/**
 * GET /api/oauth/lichess/callback — completes the PKCE flow. This is a
 * browser-facing redirect target, so every outcome (including failure) is a
 * redirect back to /games with a `verified=` marker, never a JSON error the
 * user would be stranded on.
 *
 * Dev-auth builds accept `?mock=<username>[&mockFollowing=a,b]` so the gate
 * harness can exercise the whole route + domain chain without a live Lichess
 * login; `devAuthEnabled()` is never true in production.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = requestOrigin(request);
  const finish = (query: string) => {
    const response = NextResponse.redirect(`${origin}/games?${query}`);
    // The grant cookie is single-use — clear it on every outcome.
    response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return response;
  };

  let db, user;
  try {
    ({ db, user } = await requireUser());
  } catch {
    return finish("verified=error&reason=signin");
  }

  try {
    const mock = url.searchParams.get("mock");
    if (devAuthEnabled() && mock) {
      const following = (url.searchParams.get("mockFollowing") ?? "")
        .split(",")
        .filter(Boolean);
      await verifyLinkedAccount(db, user.id, "lichess", mock, following);
      return finish("verified=lichess");
    }

    if (url.searchParams.get("error")) {
      return finish("verified=error&reason=denied");
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const store = await cookies();
    const [savedState, verifier] = (store.get(OAUTH_COOKIE)?.value ?? "").split(".");
    if (!code || !state || !savedState || !verifier || state !== savedState) {
      return finish("verified=error&reason=state");
    }

    const identity = await exchangeAndFetchIdentity(origin, code, verifier);
    await verifyLinkedAccount(db, user.id, "lichess", identity.username, identity.following);
    return finish("verified=lichess");
  } catch (error) {
    console.error("[oauth/lichess] verification failed:", error);
    return finish("verified=error&reason=exchange");
  }
}
