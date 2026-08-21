"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-context";
import {
  ApiError,
  challengesApi,
  type ChallengeViewPayload,
} from "@/lib/account/client";

/**
 * Open challenge link landing (Phase 1.5). Visitors get an anonymous session
 * automatically (A2.1), so anyone with the link can accept — subject to the
 * same block/expiry/verification rules as everywhere else. Acceptance is the
 * Phase 4 handoff: this page starts the live game once multiplayer lands.
 */
export function ChallengeClient({ token }: { token: string }) {
  const auth = useAuth();
  const [challenge, setChallenge] = useState<ChallengeViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    challengesApi
      .byToken(token)
      .then((response) => setChallenge(response.challenge))
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 404
            ? "This challenge link does not exist."
            : err instanceof Error
              ? err.message
              : "Failed to load the challenge."
        )
      );
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await challengesApi.accept({ token });
      setChallenge(response.challenge);
      setAccepted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !challenge) {
    return (
      <Shell>
        <p className="text-sm text-warn-1">{error}</p>
      </Shell>
    );
  }
  if (!challenge) {
    return (
      <Shell>
        <p className="text-sm text-text-faint">Loading…</p>
      </Shell>
    );
  }

  const mine = auth.profile?.id === challenge.from.id;
  const closed = challenge.status !== "open";

  return (
    <Shell>
      <div className="max-w-md rounded-xl border border-edge p-5">
        <p className="text-sm text-text-dim">
          <span className="notation text-text">
            {challenge.from.title && (
              <span className="mr-1 text-brilliant">{challenge.from.title}</span>
            )}
            {challenge.from.handle}
          </span>{" "}
          challenges you to a game.
        </p>
        <div className="notation mt-3 flex items-baseline gap-4 text-lg text-paper">
          <span>{challenge.timeControl}</span>
          <span className="text-sm text-text-dim">
            {challenge.variant === "chess960" ? "Chess960" : "Standard"}
          </span>
          <span className="text-sm text-text-dim">{challenge.rated ? "Rated" : "Casual"}</span>
        </div>
        <p className="mt-1 text-xs text-text-faint">
          Expires {new Date(challenge.expiresAt).toLocaleString()}
        </p>

        <div className="mt-4">
          {accepted || (closed && challenge.status === "accepted") ? (
            <div>
              <p className="text-sm text-brilliant">
                Challenge accepted{challenge.acceptedBy ? ` by ${challenge.acceptedBy.handle}` : ""}.
              </p>
              <p className="mt-1 text-xs text-text-faint">
                Live play arrives with Phase 4 multiplayer — the match is recorded and
                will be playable the moment it ships. Meanwhile,{" "}
                <Link href="/play" className="text-text-dim underline hover:text-text">
                  warm up against a bot
                </Link>
                .
              </p>
            </div>
          ) : closed ? (
            <p className="text-sm text-text-faint">
              This challenge is {challenge.status}.
            </p>
          ) : mine ? (
            <p className="text-sm text-text-faint">
              This is your own challenge — share the link and keep this tab open.
            </p>
          ) : (
            <button
              onClick={() => void accept()}
              disabled={busy || auth.status !== "ready"}
              className="rounded bg-lcd px-5 py-2 text-sm font-medium text-field hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "…" : "Accept challenge"}
            </button>
          )}
          {error && <p className="mt-2 text-xs text-warn-1">{error}</p>}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-5 text-xl font-semibold text-paper">Challenge</h1>
      {children}
    </div>
  );
}
