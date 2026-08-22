"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { useAuth } from "@/components/auth-context";
import { GameBoard } from "@/components/game-board";
import { usePrefs } from "@/components/prefs-context";
import { Ribbon } from "@/components/ribbon";
import { GamePosition } from "@/lib/chess";
import type { VariantId } from "@/lib/chess/variant";
import { soundPlayer } from "@/lib/sound/player";
import { createClient } from "@/lib/supabase/client";

/**
 * Live game client (Phase 4). The server is authoritative on everything;
 * this component renders server clock snapshots offset by local elapsed
 * time, queues ONE premove per A3.5 (sent as an ordinary move the instant
 * it is our turn — server-validated, auto-cancelled when the new position
 * has us in check, dropped silently if the server refuses), claims flagfall
 * when the local countdown hits zero (the server verifies with its own
 * arithmetic), and reports tab blur during rated games (A2.3 — recorded,
 * never blocking).
 *
 * Transport (§8): a Supabase Realtime channel per game carries a broadcast
 * "poke" (just a seq — never game data) so the opponent refetches
 * immediately; state polling stays underneath as the reconnect/resync
 * fallback (500 ms without a channel, relaxed when the channel is up).
 * Without Supabase env the poll IS the transport.
 */

interface StatePayload {
  id: string;
  status: "active" | "finished" | "aborted";
  variant: string;
  startFen: string;
  white: { id: string; handle: string; rating: number | null };
  black: { id: string; handle: string; rating: number | null };
  movesUci: string[];
  movesSan: string[];
  fen: string;
  turn: "white" | "black";
  seq: number;
  rated: boolean;
  clockMode: string;
  clocks: { whiteMs: number; blackMs: number; at: number };
  drawOfferBy: "white" | "black" | null;
  result: string | null;
  termination: string | null;
  yourColor: "white" | "black" | null;
  inCheck: boolean;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (ms < 20_000) {
    return `${minutes}:${String(seconds).padStart(2, "0")}.${Math.floor((Math.max(0, ms) % 1000) / 100)}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function LiveClient({ gameId }: { gameId: string }) {
  const auth = useAuth();
  const { prefs } = usePrefs();
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [premove, setPremove] = useState<{ from: string; to: string } | null>(null);
  const [sanInput, setSanInput] = useState("");
  const receivedAtRef = useRef(0);
  const seqRef = useRef(0);
  const flagClaimedRef = useRef(false);
  const premoveRef = useRef<{ from: string; to: string } | null>(null);
  premoveRef.current = premove;
  const liveRef = useRef<HTMLDivElement | null>(null);

  const play = useCallback(
    (sound: Parameters<ReturnType<typeof soundPlayer>["play"]>[0]) =>
      soundPlayer().play(sound, prefs),
    [prefs]
  );

  const position = useMemo(() => {
    if (!state) return null;
    try {
      return GamePosition.fromFen(state.fen, state.variant as VariantId);
    } catch {
      return null;
    }
  }, [state]);

  const applyState = useCallback(
    (next: StatePayload) => {
      const previousSeq = seqRef.current;
      seqRef.current = next.seq;
      receivedAtRef.current = Date.now();
      setState(next);
      if (next.seq > previousSeq && previousSeq > 0) {
        const lastSan = next.movesSan.at(-1);
        if (lastSan && liveRef.current) {
          liveRef.current.textContent = `${next.movesSan.length % 2 === 1 ? "White" : "Black"} played ${lastSan}`;
        }
        if (lastSan) play(next.inCheck ? "check" : lastSan.includes("x") ? "capture" : "move");
      }
      if (next.status !== "active" && previousSeq > 0 && state?.status === "active") {
        const won =
          (next.result === "1-0" && next.yourColor === "white") ||
          (next.result === "0-1" && next.yourColor === "black");
        play(next.result === "1/2-1/2" ? "game-end-draw" : won ? "game-end-win" : "game-end-loss");
      }
    },
    [play, state?.status]
  );

  const channelRef = useRef<RealtimeChannel | null>(null);
  const [realtimeUp, setRealtimeUp] = useState(false);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<StatePayload | null> => {
      try {
        const response = await fetch(`/api/play/${gameId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as {
          state?: StatePayload;
          error?: { code: string; message: string };
        };
        if (payload.state) applyState(payload.state);
        if (payload.state && response.ok) {
          // Poke the opponent's client over the game channel (seq only —
          // they refetch authoritative state; nothing trusts the channel).
          void channelRef.current?.send({
            type: "broadcast",
            event: "poke",
            payload: { seq: payload.state.seq },
          });
        }
        if (!response.ok) return null;
        return payload.state ?? null;
      } catch {
        return null;
      }
    },
    [gameId, applyState]
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/play/${gameId}`);
      const payload = (await response.json()) as {
        state?: StatePayload;
        error?: { message: string };
      };
      if (payload.state) applyState(payload.state);
      else if (!response.ok) setError(payload.error?.message ?? "Game unavailable.");
    } catch {
      // transient — next poll retries
    }
  }, [gameId, applyState]);

  // Poll loop — resync fallback (and the whole transport without Supabase).
  useEffect(() => {
    if (auth.status !== "ready") return;
    void refresh();
    const interval = setInterval(() => void refresh(), realtimeUp ? 2500 : 500);
    return () => clearInterval(interval);
  }, [auth.status, refresh, realtimeUp]);

  // Supabase Realtime channel per game (§8) — poke-only broadcast.
  useEffect(() => {
    if (auth.status !== "ready") return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return;
    }
    let client: SupabaseClient;
    try {
      client = createClient();
    } catch {
      return;
    }
    const channel = client.channel(`live:${gameId}`);
    channel.on("broadcast", { event: "poke" }, (message) => {
      const seq = Number((message.payload as { seq?: number } | undefined)?.seq ?? 0);
      if (seq > seqRef.current) void refresh();
    });
    channel.subscribe((status) => {
      setRealtimeUp(status === "SUBSCRIBED");
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      setRealtimeUp(false);
      void client.removeChannel(channel);
    };
  }, [auth.status, gameId, refresh]);

  // Local clock render tick (100 ms) — display only, never authority.
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 100);
    return () => clearInterval(interval);
  }, []);

  // Premove dispatch (A3.5): our turn arrived → auto-cancel on check, else
  // submit as an ordinary server-validated move; clear on any refusal.
  useEffect(() => {
    const queued = premoveRef.current;
    if (!state || !queued || state.status !== "active") return;
    if (state.yourColor === null || state.turn !== state.yourColor) return;
    setPremove(null);
    if (state.inCheck) return; // auto-cancel on check
    void post({ action: "move", uci: `${queued.from}${queued.to}` });
  }, [state, post]);

  // Tab-blur reporting during rated games (A2.3).
  useEffect(() => {
    if (!state?.rated || state.status !== "active" || state.yourColor === null) return;
    const onBlur = () => void post({ action: "blur" });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [state?.rated, state?.status, state?.yourColor, post]);

  void tick;
  const now = Date.now();
  const elapsed = state ? now - receivedAtRef.current : 0;
  const clocks = state
    ? {
        whiteMs:
          state.turn === "white" && state.status === "active"
            ? state.clocks.whiteMs - elapsed
            : state.clocks.whiteMs,
        blackMs:
          state.turn === "black" && state.status === "active"
            ? state.clocks.blackMs - elapsed
            : state.clocks.blackMs,
      }
    : { whiteMs: 0, blackMs: 0 };

  // Flag claim: local countdown hit zero → the server verifies.
  useEffect(() => {
    if (!state || state.status !== "active" || state.yourColor === null) return;
    const opponentClock = state.yourColor === "white" ? clocks.blackMs : clocks.whiteMs;
    const myClock = state.yourColor === "white" ? clocks.whiteMs : clocks.blackMs;
    if ((opponentClock <= 0 || myClock <= 0) && !flagClaimedRef.current) {
      flagClaimedRef.current = true;
      void post({ action: "flag" }).finally(() => {
        setTimeout(() => {
          flagClaimedRef.current = false;
        }, 1500);
      });
    }
  });

  const yourColor = state?.yourColor;
  const isYourTurn = state?.status === "active" && yourColor !== null && state?.turn === yourColor;

  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      if (!state || !position || state.status !== "active" || !yourColor) return false;
      if (state.turn !== yourColor) {
        // Premove arm (single slot per A3.5) — only from our own piece.
        const piece = position.pieceAt(from);
        if (piece && piece.color === (yourColor === "white" ? "w" : "b")) {
          setPremove({ from, to });
          play("premove-set");
          return false;
        }
        return false;
      }
      const probe = GamePosition.fromFen(state.fen, state.variant as VariantId);
      const move = probe.move({ from, to });
      if (!move) {
        play("illegal");
        return false;
      }
      // Optimistic render; server state overwrites on response.
      void post({ action: "move", uci: move.uci });
      return true;
    },
    [state, position, yourColor, post, play]
  );

  if (auth.status === "disabled" || auth.status === "offline") {
    return <Shell><p className="text-sm text-text-dim">Live play needs the account service.</p></Shell>;
  }
  if (error) {
    return <Shell><p className="text-sm text-warn-1">{error}</p></Shell>;
  }
  if (!state || !position) {
    return <Shell><p className="text-sm text-text-faint">Loading…</p></Shell>;
  }

  const orientation = yourColor ?? "white";
  const topPlayer = orientation === "white" ? state.black : state.white;
  const bottomPlayer = orientation === "white" ? state.white : state.black;
  const topClock = orientation === "white" ? clocks.blackMs : clocks.whiteMs;
  const bottomClock = orientation === "white" ? clocks.whiteMs : clocks.blackMs;
  const lastUci = state.movesUci.at(-1);
  const whiteWpGuess = 50; // no live engine in rated play — the bar stays neutral

  return (
    <Shell>
      <div ref={liveRef} className="sr-only" role="status" aria-live="polite" />
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="w-full max-w-[560px]">
          <PlayerBar player={topPlayer} clockMs={topClock} active={state.status === "active" && state.turn !== orientation} flag={topClock <= 0} />
          <div className="my-2 flex gap-2">
            {prefs.evalBar.show && state.status !== "active" && (
              <Ribbon value={(whiteWpGuess - 50) / 50} className="w-2 self-stretch" />
            )}
            <div className="min-w-0 flex-1" data-testid="live-board" data-fen={state.fen} data-seq={state.seq}>
              <GameBoard
                boardId={`live-${state.id}`}
                fen={state.fen}
                orientation={orientation}
                lastMove={lastUci ? { from: lastUci.slice(0, 2), to: lastUci.slice(2, 4) } : null}
                interactive={state.status === "active" && yourColor !== null}
                onMove={tryMove}
                destsFrom={(square) => (isYourTurn ? position.destsFrom(square) : premoveDests(position, square))}
                canSelect={(square) => {
                  const piece = position.pieceAt(square);
                  return Boolean(
                    piece && yourColor && piece.color === (yourColor === "white" ? "w" : "b")
                  );
                }}
              />
            </div>
          </div>
          <PlayerBar player={bottomPlayer} clockMs={bottomClock} active={state.status === "active" && state.turn === orientation} flag={bottomClock <= 0} />
          {premove && (
            <p className="mt-1 text-xs text-text-dim">
              premove {premove.from}–{premove.to}{" "}
              <button className="text-text-faint hover:text-text" onClick={() => setPremove(null)}>
                cancel
              </button>
            </p>
          )}
          {state.status === "active" && yourColor !== null && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!isYourTurn || !position) return;
                try {
                  const probe = GamePosition.fromFen(state.fen, state.variant as VariantId);
                  const move = probe.moveSan(sanInput.trim());
                  if (move) {
                    void post({ action: "move", uci: move.uci });
                    setSanInput("");
                  } else {
                    play("illegal");
                  }
                } catch {
                  play("illegal");
                }
              }}
              className="mt-2 flex gap-2"
            >
              <input
                value={sanInput}
                onChange={(event) => setSanInput(event.target.value)}
                placeholder="Type a move (SAN — e4, Nf3, O-O)"
                aria-label="Keyboard move entry"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm placeholder:text-text-faint"
              />
              <button
                type="submit"
                disabled={!isYourTurn}
                className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Play
              </button>
            </form>
          )}
        </div>

        <div className="w-full lg:w-80">
          <div className="card p-4">
            <p className="text-sm text-text">
              {state.rated ? "Rated" : "Casual"}
              {state.variant === "chess960" && " · Chess960"}
              {state.variant === "threecheck" && " · Three-check"}
              {state.variant === "koth" && " · King of the Hill"}
              {state.rated && (
                <span className="mt-0.5 block text-xs text-text-faint">
                  Fair-play signals are recorded on rated games and visible to you on
                  your account page.
                </span>
              )}
              {state.variant === "threecheck" && (
                <ChecksRemaining fen={state.fen} />
              )}
            </p>
            {state.status === "active" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <ActionButton onClick={() => void post({ action: "resign" })}>Resign</ActionButton>
                {state.drawOfferBy && state.drawOfferBy !== yourColor ? (
                  <>
                    <ActionButton onClick={() => void post({ action: "draw-accept" })}>
                      Accept draw
                    </ActionButton>
                    <ActionButton onClick={() => void post({ action: "draw-decline" })}>
                      Decline
                    </ActionButton>
                  </>
                ) : (
                  <ActionButton onClick={() => void post({ action: "draw-offer" })}>
                    Offer draw
                  </ActionButton>
                )}
                {state.movesUci.length < 2 && (
                  <ActionButton onClick={() => void post({ action: "abort" })}>Abort</ActionButton>
                )}
              </div>
            ) : (
              <div className="mt-3" data-testid="game-result">
                <p className="notation text-lg text-paper">{state.result ?? "aborted"}</p>
                <p className="text-sm text-text-dim">{state.termination}</p>
                <Link
                  href="/play"
                  className="btn-primary mt-3 px-4 py-1.5 text-sm"
                >
                  New game
                </Link>
              </div>
            )}
            {state.drawOfferBy === yourColor && state.status === "active" && (
              <p className="mt-2 text-xs text-text-faint">draw offered…</p>
            )}
          </div>

          <div className="card mt-4 max-h-72 overflow-y-auto p-3" data-testid="live-moves">
            {state.movesSan.length === 0 ? (
              <p className="text-sm text-text-faint">No moves yet.</p>
            ) : (
              <p className="notation text-sm leading-6 text-text-dim">
                {state.movesSan.map((san, index) => (
                  <span key={index} className="mr-1.5">
                    {index % 2 === 0 && (
                      <span className="text-text-faint">{Math.floor(index / 2) + 1}. </span>
                    )}
                    {san}
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

/** Premove destinations: pseudo-targets of our piece (server validates for real). */
function premoveDests(position: GamePosition, square: string): string[] {
  const piece = position.pieceAt(square);
  if (!piece) return [];
  // Offer every square — the premove is speculative by nature; the server is
  // the validator (A3.5). Restrict to plausible geometry via the facade by
  // flipping the turn is intentionally NOT done: the position will differ.
  const files = "abcdefgh";
  const all: string[] = [];
  for (const file of files) for (let rank = 1; rank <= 8; rank++) all.push(`${file}${rank}`);
  return all.filter((target) => target !== square);
}

function PlayerBar({
  player,
  clockMs,
  active,
  flag,
}: {
  player: { handle: string; rating: number | null };
  clockMs: number;
  active: boolean;
  flag: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-edge bg-surface px-3 py-1.5">
      <span className="text-sm text-text">
        {player.handle}
        {player.rating !== null && (
          <span className="notation ml-2 text-xs text-text-faint">{player.rating}</span>
        )}
      </span>
      <span
        className={`notation text-lg tabular-nums ${
          flag ? "text-flag" : active ? "text-paper" : "text-text-faint"
        }`}
        data-testid="clock"
      >
        {formatClock(clockMs)}
      </span>
    </div>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-ghost px-3 py-1 text-sm"
    >
      {children}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-paper">Live game</h1>
      {children}
    </div>
  );
}

/**
 * Three-check progress from the FEN's remaining-checks field ("2+3" = White
 * needs 2 more checks, Black 3).
 */
function ChecksRemaining({ fen }: { fen: string }) {
  const match = fen.match(/ (\d)\+(\d) /);
  if (!match) return null;
  return (
    <span className="notation mt-0.5 block text-xs text-text-dim">
      checks to win — White {match[1]}, Black {match[2]}
    </span>
  );
}
