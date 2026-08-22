import { NextResponse } from "next/server";
import { handleApi, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import {
  authorizeUrl,
  newPkceGrant,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  requestOrigin,
} from "@/lib/import/lichess-oauth";

/**
 * GET /api/oauth/lichess/start — begins the PKCE flow: mints a verifier +
 * state, parks them in a short-lived httpOnly cookie, and redirects to the
 * Lichess consent screen. The callback route completes the exchange.
 */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "Verifying a platform link requires a verified GAMBIT account.",
        403
      );
    }
    const { verifier, challenge, state } = newPkceGrant();
    const origin = requestOrigin(request);
    const response = NextResponse.redirect(authorizeUrl(origin, challenge, state));
    response.cookies.set(OAUTH_COOKIE, `${state}.${verifier}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.startsWith("https"),
      path: OAUTH_COOKIE_PATH,
      maxAge: 600,
    });
    return response;
  });
}
