import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "./platforms";

/**
 * Lichess OAuth2 PKCE (public client — Lichess needs no app registration;
 * any client_id works with S256 PKCE). This is the ONLY ownership proof the
 * import system has: chess.com offers no OAuth at all, so chess.com links
 * stay permanently unverifiable and the UI must keep saying so.
 *
 * The token is single-purpose: exchanged, used for /api/account (identity)
 * and /api/rel/following (friend matching, enrichment only), then REVOKED —
 * we never store it. Scope is follow:read only.
 */

export const LICHESS_HOST = "https://lichess.org";
export const OAUTH_CLIENT_ID = "gambit-chess";
export const OAUTH_SCOPE = "follow:read";
/** Cookie carrying `state.verifier` between /start and /callback. */
export const OAUTH_COOKIE = "gambit-lichess-oauth";
export const OAUTH_COOKIE_PATH = "/api/oauth/lichess";
export const FOLLOWING_CAP = 500;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface PkceGrant {
  verifier: string;
  challenge: string;
  state: string;
}

export function newPkceGrant(): PkceGrant {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
    state: b64url(randomBytes(16)),
  };
}

export function redirectUri(origin: string): string {
  return `${origin}/api/oauth/lichess/callback`;
}

export function authorizeUrl(origin: string, challenge: string, state: string): string {
  const url = new URL("/oauth", LICHESS_HOST);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(origin));
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * The browser-facing routes run behind proxies (Vercel) — derive the public
 * origin from forwarded headers, falling back to the request URL.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export interface LichessIdentity {
  username: string;
  /** Lichess usernames this account follows (capped, enrichment only). */
  following: string[];
}

/**
 * Code → token → identity (+ follow list) → token revoked. Throws on any
 * failure of the identity chain; the follow-list fetch is best-effort — a
 * verification must not fail because the rel endpoint hiccuped.
 */
export async function exchangeAndFetchIdentity(
  origin: string,
  code: string,
  verifier: string,
  fetchFn: FetchLike = fetch
): Promise<LichessIdentity> {
  const tokenRes = await fetchFn(`${LICHESS_HOST}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(origin),
      client_id: OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`Lichess token exchange failed (${tokenRes.status})`);
  }
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("Lichess token exchange returned no access_token");
  const auth = { authorization: `Bearer ${token}` };
  try {
    const accountRes = await fetchFn(`${LICHESS_HOST}/api/account`, { headers: auth });
    if (!accountRes.ok) {
      throw new Error(`Lichess account fetch failed (${accountRes.status})`);
    }
    const username = ((await accountRes.json()) as { username?: string }).username;
    if (!username) throw new Error("Lichess account payload had no username");

    let following: string[] = [];
    try {
      const relRes = await fetchFn(`${LICHESS_HOST}/api/rel/following`, {
        headers: { ...auth, accept: "application/x-ndjson" },
      });
      if (relRes.ok) {
        following = (await relRes.text())
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(0, FOLLOWING_CAP)
          .map((line) => {
            try {
              return (JSON.parse(line) as { username?: string }).username ?? null;
            } catch {
              return null;
            }
          })
          .filter((name): name is string => name !== null);
      }
    } catch {
      // Enrichment only — verified with an empty follow list beats failing.
    }
    return { username, following };
  } finally {
    await fetchFn(`${LICHESS_HOST}/api/token`, { method: "DELETE", headers: auth }).catch(
      () => {}
    );
  }
}
