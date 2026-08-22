"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isEnabled } from "@/lib/flags";
import { useAuth } from "./auth-context";

/**
 * Matchmaking entry (Phase 4): pick a time control, find an opponent. The
 * window widens server-side with queue time; blocked players never pair
 * (canPair). Rated needs a verified account (A2.1) — the server enforces,
 * the UI explains.
 */

const PRESETS: { label: string; mode: "fischer" | "daily"; initialMs: number; incrementMs: number }[] = [
  { label: "1+0", mode: "fischer", initialMs: 60_000, incrementMs: 0 },
  { label: "3+0", mode: "fischer", initialMs: 180_000, incrementMs: 0 },
  { label: "3+2", mode: "fischer", initialMs: 180_000, incrementMs: 2_000 },
  { label: "5+0", mode: "fischer", initialMs: 300_000, incrementMs: 0 },
  { label: "10+5", mode: "fischer", initialMs: 600_000, incrementMs: 5_000 },
  { label: "15+10", mode: "fischer", initialMs: 900_000, incrementMs: 10_000 },
  { label: "1 day", mode: "daily", initialMs: 86_400_000, incrementMs: 0 },
];

type QueueVariant = "standard" | "chess960" | "threecheck" | "koth";

export function VsHumanCard() {
  const auth = useAuth();
  const router = useRouter();
  const [preset, setPreset] = useState(1);
  const [variant, setVariant] = useState<QueueVariant>("standard");
  const [rated, setRated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const stopRef = useRef(false);

  const verified = auth.profile && !auth.profile.isAnonymous && auth.profile.emailVerifiedAt;

  const search = useCallback(async () => {
    setMessage(null);
    setSearching(true);
    stopRef.current = false;
    const spec = PRESETS[preset]!;
    try {
      const join = await fetch("/api/play/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join",
          variant,
          rated,
          clock: { mode: spec.mode, initialMs: spec.initialMs, incrementMs: spec.incrementMs },
        }),
      });
      const joined = (await join.json()) as {
        gameId?: string | null;
        error?: { message: string };
      };
      if (!join.ok) throw new Error(joined.error?.message ?? "Could not join the queue.");
      if (joined.gameId) {
        router.push(`/play/live/${joined.gameId}`);
        return;
      }
      // Poll until paired or cancelled.
      for (;;) {
        if (stopRef.current) return;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const response = await fetch("/api/play/queue");
        const status = (await response.json()) as { queued?: boolean; gameId?: string | null };
        if (status.gameId) {
          router.push(`/play/live/${status.gameId}`);
          return;
        }
        if (!status.queued) {
          setSearching(false);
          return;
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Matchmaking failed.");
      setSearching(false);
    }
  }, [preset, variant, rated, router]);

  const cancel = useCallback(async () => {
    stopRef.current = true;
    await fetch("/api/play/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "leave" }),
    });
    setSearching(false);
  }, []);

  // Rejoin banner for an in-progress game.
  const [activeGame, setActiveGame] = useState<string | null>(null);
  useEffect(() => {
    if (auth.status !== "ready") return;
    fetch("/api/play/queue")
      .then(async (response) => (response.ok ? response.json() : {}))
      .then((body: { gameId?: string | null }) => setActiveGame(body.gameId ?? null))
      .catch(() => undefined);
  }, [auth.status]);

  if (auth.status !== "ready") {
    return (
      <div className="max-w-xl rounded-xl border border-edge p-5">
        <h2 className="mb-2 text-lg font-semibold text-paper">Play a human</h2>
        <p className="text-sm text-text-faint">
          {auth.status === "connecting" ? "Connecting…" : "Live play needs the account service."}
        </p>
      </div>
    );
  }

  const chip = (active: boolean) =>
    `rounded border px-2.5 py-1 text-sm ${
      active
        ? "border-edge-strong bg-raise text-text"
        : "border-edge text-text-dim hover:border-edge-strong hover:text-text"
    }`;

  return (
    <div className="max-w-xl rounded-xl border border-edge p-5">
      <h2 className="mb-3 text-lg font-semibold text-paper">Play a human</h2>
      {activeGame && (
        <button
          onClick={() => router.push(`/play/live/${activeGame}`)}
          className="mb-3 block w-full rounded bg-lcd px-3 py-2 text-left text-sm font-medium text-field hover:opacity-90"
        >
          You have a game in progress — rejoin
        </button>
      )}
      <div className="mb-3">
        <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Time control</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((option, index) => (
            <button
              key={option.label}
              className={`${chip(preset === index)} notation`}
              onClick={() => setPreset(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-6">
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Variant</p>
          <div className="flex flex-wrap gap-2">
            <button className={chip(variant === "standard")} onClick={() => setVariant("standard")}>
              Standard
            </button>
            <button className={chip(variant === "chess960")} onClick={() => setVariant("chess960")}>
              Chess960
            </button>
            {isEnabled("FF_VARIANTS") && (
              <>
                <button
                  className={chip(variant === "threecheck")}
                  onClick={() => setVariant("threecheck")}
                >
                  Three-check
                </button>
                <button className={chip(variant === "koth")} onClick={() => setVariant("koth")}>
                  King of the Hill
                </button>
              </>
            )}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-text-faint">Rated</p>
          <div className="flex items-center gap-2">
            <button className={chip(!rated)} onClick={() => setRated(false)}>
              Casual
            </button>
            <button
              className={chip(rated)}
              onClick={() => setRated(true)}
              disabled={!verified}
              title={verified ? undefined : "Rated multiplayer requires a verified account"}
            >
              Rated
            </button>
          </div>
          {!verified && (
            <p className="mt-1 text-xs text-text-faint">rated needs a verified account</p>
          )}
        </div>
      </div>
      {searching ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-dim">Searching — the rating window widens as you wait…</span>
          <button
            onClick={() => void cancel()}
            className="rounded border border-edge px-3 py-1 text-sm text-text-dim hover:border-edge-strong"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => void search()}
          className="rounded bg-lcd px-5 py-2 text-sm font-medium text-field hover:opacity-90"
        >
          Find an opponent
        </button>
      )}
      {message && <p className="mt-2 text-xs text-warn-1">{message}</p>}
    </div>
  );
}
