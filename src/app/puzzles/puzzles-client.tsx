"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-context";
import { GameBoard } from "@/components/game-board";
import { usePrefs } from "@/components/prefs-context";
import { GamePosition } from "@/lib/chess";
import { soundPlayer } from "@/lib/sound/player";

/**
 * Rated puzzle mode (Phase 3): the opponent's setup move plays out, you find
 * the whole winning line. Alternate checkmates count as solved (matching
 * Lichess's own rule). One attempt is rated; retries and solution-viewing
 * are free but the attempt is already booked.
 */

interface PuzzlePayload {
  id: string;
  fen: string;
  movesUci: string[];
  rating: number;
  themes: string[];
  /** Own-game drills only: where this blunder actually happened. */
  source?: { gameId: string; ply: number; opponent: string; playedAt: string | null };
}

type PuzzleMode = "rated" | "own";

interface RatingPayload {
  rating: number;
  rd: number;
  attempts: number;
}

type Phase = "loading" | "presenting" | "solving" | "solved" | "failed";

/**
 * Starter decks: one-click Lichess-theme filters so a new player (guests
 * included) has somewhere obvious to begin. Labels are ours; theme ids are
 * the puzzle set's. All counts are four-digit in the shipped 31k subset
 * except skewer/backRank (still ~700 each).
 */
const THEME_PRESETS: { label: string; themes: string | null }[] = [
  { label: "All", themes: null },
  { label: "Forks", themes: "fork" },
  { label: "Pins", themes: "pin" },
  { label: "Skewers", themes: "skewer" },
  { label: "Hanging pieces", themes: "hangingPiece" },
  { label: "Mate in 1", themes: "mateIn1" },
  { label: "Mate in 2", themes: "mateIn2" },
  { label: "Back rank", themes: "backRankMate" },
  { label: "Discovered attacks", themes: "discoveredAttack" },
  { label: "Endgames", themes: "endgame" },
];

export function PuzzlesClient() {
  const auth = useAuth();
  const { prefs } = usePrefs();
  const [puzzle, setPuzzle] = useState<PuzzlePayload | null>(null);
  const [rating, setRating] = useState<RatingPayload | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [fen, setFen] = useState<string>("");
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [delta, setDelta] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PuzzleMode>("rated");
  const modeRef = useRef<PuzzleMode>("rated");
  // Theme preset (rated mode): narrows the pool server-side. Works for
  // guests too — a themed starter deck beats an empty toolbox.
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const themeFilterRef = useRef<string | null>(null);
  const ownQueueRef = useRef<PuzzlePayload[] | null>(null);
  const ownIndexRef = useRef(0);
  const positionRef = useRef<GamePosition | null>(null);
  const solutionIndexRef = useRef(0);
  const startedAtRef = useRef(0);
  const attemptedRef = useRef(false);
  const liveRef = useRef<HTMLDivElement | null>(null);

  const announce = useCallback((text: string) => {
    if (liveRef.current) liveRef.current.textContent = text;
  }, []);

  const play = useCallback(
    (sound: Parameters<ReturnType<typeof soundPlayer>["play"]>[0]) => {
      soundPlayer().play(sound, prefs);
    },
    [prefs]
  );

  const loadNext = useCallback(async () => {
    setPhase("loading");
    setDelta(null);
    setError(null);
    attemptedRef.current = false;
    try {
      if (modeRef.current === "own") {
        if (ownQueueRef.current === null) {
          const response = await fetch("/api/puzzles/own");
          const body = (await response.json()) as {
            puzzles?: {
              id: string;
              fen: string;
              movesUci: string[];
              theme: string | null;
              source: PuzzlePayload["source"];
            }[];
            error?: { message: string };
          };
          if (!response.ok) throw new Error(body.error?.message ?? "load failed");
          ownQueueRef.current = (body.puzzles ?? []).map((entry) => ({
            id: entry.id,
            fen: entry.fen,
            movesUci: entry.movesUci,
            rating: 0,
            themes: entry.theme ? [entry.theme] : [],
            source: entry.source,
          }));
          ownIndexRef.current = 0;
        }
        const queue = ownQueueRef.current;
        if (queue.length === 0) {
          setPhase("loading");
          setError(
            "No blunders to drill yet — import and analyze a few games, then your own mistakes become puzzles."
          );
          return;
        }
        const own = queue[ownIndexRef.current % queue.length]!;
        ownIndexRef.current++;
        setPuzzle(own);
        const position = GamePosition.fromFen(own.fen, "standard");
        positionRef.current = position;
        solutionIndexRef.current = 0;
        setFen(position.fen());
        setLastMove(null);
        setPhase("presenting");
        setTimeout(() => {
          const setup = position.moveUci(own.movesUci[0]!);
          if (setup) {
            setFen(position.fen());
            setLastMove({ from: setup.from, to: setup.to });
            play(setup.san.includes("x") ? "capture" : "move");
            solutionIndexRef.current = 1;
            startedAtRef.current = Date.now();
            setPhase("solving");
            announce(
              `The blunder ${setup.san} just happened — punish it. ${
                position.turn === "w" ? "White" : "Black"
              } to move.`
            );
          }
        }, 600);
        return;
      }
      // Theme narrowing: preset chips and the §9.2 drill deck's
      // /puzzles?themes=a,b entry (B1.2) both land in themeFilterRef.
      const themes = themeFilterRef.current;
      const response = await fetch(
        `/api/puzzles/next${themes ? `?themes=${encodeURIComponent(themes)}` : ""}`
      );
      const body = (await response.json()) as {
        puzzle?: PuzzlePayload;
        rating?: RatingPayload;
        error?: { message: string };
      };
      if (!response.ok || !body.puzzle) throw new Error(body.error?.message ?? "load failed");
      setPuzzle(body.puzzle);
      setRating(body.rating ?? null);
      const position = GamePosition.fromFen(body.puzzle.fen, "standard");
      positionRef.current = position;
      solutionIndexRef.current = 0;
      setFen(position.fen());
      setLastMove(null);
      setPhase("presenting");
      // The setup move (the blunder) animates in, then it's the user's turn.
      setTimeout(() => {
        const setup = position.moveUci(body.puzzle!.movesUci[0]!);
        if (setup) {
          setFen(position.fen());
          setLastMove({ from: setup.from, to: setup.to });
          play(setup.san.includes("x") ? "capture" : "move");
          solutionIndexRef.current = 1;
          startedAtRef.current = Date.now();
          setPhase("solving");
          announce(
            `Puzzle ${body.puzzle!.rating}. Opponent played ${setup.san}. Find the best line — ${
              position.turn === "w" ? "White" : "Black"
            } to move.`
          );
        }
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load a puzzle.");
    }
  }, [announce, play]);

  // ?mode=own and ?themes= deep links (dashboard drill / §9.2 drill deck) —
  // applied before the first load; an effect (post-hydration) so SSR markup
  // stays mode-agnostic.
  useEffect(() => {
    const themesParam = new URLSearchParams(window.location.search).get("themes");
    if (themesParam) {
      themeFilterRef.current = themesParam;
      setThemeFilter(themesParam);
    }
    if (new URLSearchParams(window.location.search).get("mode") === "own") {
      modeRef.current = "own";
      setMode("own");
    }
  }, []);

  useEffect(() => {
    if (auth.status === "ready") void loadNext();
  }, [auth.status, loadNext]);

  const submitAttempt = useCallback(
    async (solved: boolean) => {
      if (attemptedRef.current || !puzzle) return;
      attemptedRef.current = true;
      // Own-game drills are unrated by design — nothing is booked.
      if (puzzle.id.startsWith("own:")) return;
      try {
        const response = await fetch("/api/puzzles/attempt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            puzzleId: puzzle.id,
            solved,
            timeMs: Date.now() - startedAtRef.current,
          }),
        });
        const body = (await response.json()) as {
          rating?: RatingPayload;
          delta?: number;
        };
        if (response.ok && body.rating) {
          setRating(body.rating);
          setDelta(body.delta ?? null);
        }
      } catch {
        // Offline — the puzzle still works, the rating just doesn't move.
      }
    },
    [puzzle]
  );

  const userMove = useCallback(
    (from: string, to: string): boolean => {
      const position = positionRef.current;
      if (!position || !puzzle || phase !== "solving") return false;
      const expected = puzzle.movesUci[solutionIndexRef.current];
      const move = position.move({ from, to });
      if (!move) return false;

      const isExpected =
        expected !== undefined &&
        (move.uci === expected ||
          (move.uci.length === 5 && move.uci.slice(0, 4) === expected.slice(0, 4)));
      const isAlternateMate = !isExpected && position.isCheckmate();

      if (!isExpected && !isAlternateMate) {
        position.undo();
        play("illegal");
        setPhase("failed");
        announce(`${move.san} is not it. Puzzle failed.`);
        void submitAttempt(false);
        return false;
      }

      setFen(position.fen());
      setLastMove({ from: move.from, to: move.to });
      play(position.isCheck() ? "check" : move.san.includes("x") ? "capture" : "move");
      solutionIndexRef.current++;

      if (isAlternateMate || solutionIndexRef.current >= puzzle.movesUci.length) {
        setPhase("solved");
        play("game-end-win");
        announce("Solved.");
        void submitAttempt(true);
        return true;
      }

      // Opponent's scripted reply.
      setTimeout(() => {
        const reply = puzzle.movesUci[solutionIndexRef.current];
        if (!reply) return;
        const replyMove = position.moveUci(reply);
        if (replyMove) {
          setFen(position.fen());
          setLastMove({ from: replyMove.from, to: replyMove.to });
          play(replyMove.san.includes("x") ? "capture" : "move");
          solutionIndexRef.current++;
          announce(`Opponent played ${replyMove.san}.`);
          if (solutionIndexRef.current >= puzzle.movesUci.length) {
            setPhase("solved");
            void submitAttempt(true);
          }
        }
      }, 350);
      return true;
    },
    [phase, puzzle, play, announce, submitAttempt]
  );

  const revealSolution = useCallback(() => {
    const position = positionRef.current;
    if (!position || !puzzle) return;
    const step = () => {
      const next = puzzle.movesUci[solutionIndexRef.current];
      if (!next) return;
      const move = position.moveUci(next);
      if (move) {
        setFen(position.fen());
        setLastMove({ from: move.from, to: move.to });
        solutionIndexRef.current++;
        setTimeout(step, 500);
      }
    };
    step();
  }, [puzzle]);

  const retry = useCallback(() => {
    if (!puzzle) return;
    const position = GamePosition.fromFen(puzzle.fen, "standard");
    position.moveUci(puzzle.movesUci[0]!);
    positionRef.current = position;
    solutionIndexRef.current = 1;
    setFen(position.fen());
    setPhase("solving");
  }, [puzzle]);

  const orientation = useMemo(() => {
    if (!puzzle) return "white" as const;
    // After the setup move, the solver is the side to move.
    return puzzle.fen.split(" ")[1] === "w" ? ("black" as const) : ("white" as const);
  }, [puzzle]);

  if (auth.status === "disabled" || auth.status === "offline") {
    return (
      <Shell rating={null}>
        <p className="text-sm text-text-dim">
          Puzzles need the puzzle database (account service offline). Local play and
          analysis still work.
        </p>
      </Shell>
    );
  }

  const position = positionRef.current;
  return (
    <Shell rating={rating}>
      <div ref={liveRef} className="sr-only" role="status" aria-live="polite" />
      <div className="mb-4 flex gap-2">
        {(
          [
            ["rated", "Rated"],
            ["own", "From my games"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              if (mode === value) return;
              setMode(value);
              modeRef.current = value;
              setError(null);
              void loadNext();
            }}
            aria-pressed={mode === value}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              mode === value
                ? "border-accent bg-surface-3 text-text"
                : "border-edge text-text-dim hover:border-edge-strong hover:bg-surface-2 hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "rated" && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Puzzle themes">
          {THEME_PRESETS.map((preset) => {
            const active =
              preset.themes === null ? themeFilter === null : themeFilter === preset.themes;
            return (
              <button
                key={preset.label}
                onClick={() => {
                  if (active) return;
                  themeFilterRef.current = preset.themes;
                  setThemeFilter(preset.themes);
                  setError(null);
                  void loadNext();
                }}
                aria-pressed={active}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-accent bg-surface-3 text-text"
                    : "border-edge text-text-dim hover:border-edge-strong hover:text-text"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
          {themeFilter !== null && !THEME_PRESETS.some((preset) => preset.themes === themeFilter) && (
            <span className="rounded-full border border-accent bg-surface-3 px-2.5 py-1 text-xs text-text">
              drill deck: {themeFilter}
            </span>
          )}
        </div>
      )}
      {error && <p className="mb-3 text-sm text-warn-1">{error}</p>}
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="w-full max-w-[560px]">
          <GameBoard
            boardId="puzzle"
            fen={fen || "8/8/8/8/8/8/8/8 w - - 0 1"}
            orientation={orientation}
            lastMove={lastMove}
            interactive={phase === "solving"}
            onMove={userMove}
            destsFrom={(square) => positionRef.current?.destsFrom(square) ?? []}
            canSelect={(square) => {
              const pos = positionRef.current;
              const piece = pos?.pieceAt(square);
              return Boolean(pos && piece && piece.color === pos.turn);
            }}
          />
        </div>
        <div className="w-full lg:w-80">
          <div className="card p-4">
            {phase === "loading" && <p className="text-sm text-text-faint">Loading puzzle…</p>}
            {(phase === "presenting" || phase === "solving") && puzzle && position && (
              <>
                <p className="text-sm text-text">
                  {position.turn === "w" ? "White" : "Black"} to move
                </p>
                <p className="mt-1 text-xs text-text-faint">
                  {puzzle.source
                    ? "This blunder is from one of your games — find the punishment you (or they) missed."
                    : "Find the best line — every move counts."}
                </p>
              </>
            )}
            {phase === "solved" && (
              <>
                <p className="text-sm font-medium text-brilliant">Solved.</p>
                {delta !== null && (
                  <p className="notation mt-1 text-xs text-text-dim">
                    {delta >= 0 ? "+" : ""}
                    {delta.toFixed(0)} puzzle rating
                  </p>
                )}
              </>
            )}
            {phase === "failed" && (
              <>
                <p className="text-sm font-medium text-warn-2">Not that.</p>
                {delta !== null && (
                  <p className="notation mt-1 text-xs text-text-dim">
                    {delta.toFixed(0)} puzzle rating
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={retry}
                    className="btn-ghost px-3 py-1 text-sm"
                  >
                    Retry (unrated)
                  </button>
                  <button
                    onClick={revealSolution}
                    className="btn-ghost px-3 py-1 text-sm"
                  >
                    View solution
                  </button>
                </div>
              </>
            )}
            {(phase === "solved" || phase === "failed") && (
              <div className="mt-3 border-t border-edge pt-3">
                {puzzle && puzzle.source ? (
                  <p className="mb-2 text-xs text-text-faint">
                    {puzzle.themes[0] && (
                      <span className="notation">{puzzle.themes[0].toLowerCase().replaceAll("_", " ")} · </span>
                    )}
                    from your game vs {puzzle.source.opponent}
                    {puzzle.source.playedAt
                      ? ` (${new Date(puzzle.source.playedAt).toLocaleDateString()})`
                      : ""}{" "}
                    ·{" "}
                    <Link
                      href={`/analysis/${puzzle.source.gameId}`}
                      className="text-text-dim underline underline-offset-2 hover:text-text"
                    >
                      open the review
                    </Link>
                  </p>
                ) : puzzle ? (
                  <p className="mb-2 text-xs text-text-faint">
                    puzzle <span className="notation">{puzzle.rating}</span> ·{" "}
                    {puzzle.themes.slice(0, 4).join(", ")}
                  </p>
                ) : null}
                <button onClick={() => void loadNext()} className="btn-primary px-4 py-1.5 text-sm">
                  Next puzzle
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ rating, children }: { rating: RatingPayload | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-paper">Puzzles</h1>
        {rating && (
          <span className="notation text-sm text-text-dim" title="Puzzle rating — its own pool, never comparable to game ratings">
            puzzle rating {rating.rating.toFixed(0)} ± {rating.rd.toFixed(0)}
            <span className="ml-2 text-xs text-text-faint">{rating.attempts} attempts</span>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
