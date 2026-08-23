"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAnalysisRunner } from "@/components/analysis-runner";
import { useAuth } from "@/components/auth-context";
import { api } from "@/lib/account/client";
import { analysisRunner, needsAnalysis } from "@/lib/analysis/runner";

/**
 * Home switches on auth: guests (and local-only mode) see the marketing
 * page; a signed-in account gets the DAILY REVIEW dashboard — the loop the
 * whole instrument exists for: sync new games → analyze → see what the
 * fingerprint says → drill one of your own blunders.
 */

interface GameRowPayload {
  id: string;
  variant: string;
  source: string;
  whiteName: string;
  blackName: string;
  userColor: "white" | "black";
  result: string;
  opening: string | null;
  isStudy: boolean;
  playedAt: string | null;
  plyCount: number;
  reviewedCount: number;
  errorCount: number;
}

interface LinkedView {
  source: "chesscom" | "lichess";
  externalUsername: string;
  verified: boolean;
  lastImportedAt: string | null;
}

interface FingerprintPayload {
  report?: {
    errorPlies: number;
    distribution: { motif: string; count: number; share: number }[];
    nature: { tactical: number; positional: number; tacticalShare: number };
  };
}

interface OwnPuzzlePayload {
  puzzles: { id: string; theme: string | null; source?: string }[];
}

export function HomeClient({ marketing }: { marketing: React.ReactNode }) {
  const auth = useAuth();
  if (auth.status === "ready" && auth.profile && !auth.profile.isAnonymous) {
    return <Dashboard handle={auth.profile.handle} />;
  }
  return <>{marketing}</>;
}

function Dashboard({ handle }: { handle: string }) {
  const [linked, setLinked] = useState<LinkedView[] | null>(null);
  const [games, setGames] = useState<GameRowPayload[] | null>(null);
  const [fingerprint, setFingerprint] = useState<FingerprintPayload["report"] | null>(null);
  const [drill, setDrill] = useState<OwnPuzzlePayload["puzzles"][number] | null>(null);
  const [drillCount, setDrillCount] = useState(0);

  const reload = useCallback(() => {
    api<{ linked: LinkedView[] }>("/api/import")
      .then((response) => setLinked(response.linked))
      .catch(() => setLinked([]));
    api<{ games: GameRowPayload[] }>("/api/games?limit=50")
      .then((response) => setGames(response.games))
      .catch(() => setGames([]));
    api<FingerprintPayload>("/api/train/fingerprint")
      .then((response) => setFingerprint(response.report ?? null))
      .catch(() => setFingerprint(null));
    api<OwnPuzzlePayload>("/api/puzzles/own")
      .then((response) => {
        const puzzles = response.puzzles ?? [];
        setDrillCount(puzzles.length);
        if (puzzles.length === 0) return setDrill(null);
        // "Of the day": stable within a day, rotates daily.
        const day = Math.floor(Date.now() / 86_400_000);
        setDrill(puzzles[day % puzzles.length] ?? null);
      })
      .catch(() => setDrill(null));
  }, []);

  useEffect(reload, [reload]);

  const latest = (games ?? []).find((game) => !game.isStudy) ?? null;
  const unanalyzed = (games ?? []).filter(needsAnalysis);

  return (
    <div className="mx-auto w-full max-w-5xl py-2">
      <h1 className="text-2xl font-bold text-paper">
        Welcome back, <span className="notation">{handle}</span>
      </h1>
      <p className="mb-6 mt-1 text-sm text-text-dim">
        Your daily loop: sync, analyze, see the pattern, drill it.
      </p>

      {/* Bento: three across on xl so the fold is content, not void. */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <SyncCard linked={linked} unanalyzed={unanalyzed} onDone={reload} />
        <LatestGameCard game={latest} loaded={games !== null} />
        <DrillCard drill={drill} drillCount={drillCount} />
        <FingerprintCard report={fingerprint} />
        <RecentGamesCard games={games} className="md:col-span-2" />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/play" className="btn-primary text-sm">
          Play
        </Link>
        <Link href="/puzzles" className="btn-ghost text-sm">
          Puzzles
        </Link>
        <Link href="/games" className="btn-ghost text-sm">
          My games
        </Link>
        <Link href="/friends" className="btn-ghost text-sm">
          Friends
        </Link>
        <Link href="/train" className="btn-ghost text-sm">
          Trainers
        </Link>
      </div>
    </div>
  );
}

function RecentGamesCard({
  games,
  className,
}: {
  games: GameRowPayload[] | null;
  className?: string;
}) {
  const recent = (games ?? []).filter((game) => !game.isStudy).slice(0, 6);
  if (recent.length < 2) return null;
  return (
    <section className={`card p-5 ${className ?? ""}`}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-paper">Recent games</h2>
        <Link href="/games" className="text-xs text-text-dim hover:text-text hover:underline">
          all games →
        </Link>
      </div>
      <ul>
        {recent.map((game) => {
          const won =
            (game.result === "1-0" && game.userColor === "white") ||
            (game.result === "0-1" && game.userColor === "black");
          const drew = game.result === "1/2-1/2";
          const opponent = game.userColor === "black" ? game.whiteName : game.blackName;
          return (
            <li key={game.id} className="border-b border-edge last:border-0">
              <Link
                href={`/analysis/${game.id}`}
                className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 text-sm transition-colors hover:bg-surface-2"
              >
                <span
                  className={`notation text-center text-xs font-semibold ${
                    won ? "text-brilliant" : drew ? "text-text-dim" : "text-warn-1"
                  }`}
                >
                  {won ? "W" : drew ? "½" : "L"}
                </span>
                <span className="truncate text-text">
                  vs {opponent}
                  {game.opening && (
                    <span className="ml-2 hidden truncate text-xs text-text-faint sm:inline">
                      {game.opening}
                    </span>
                  )}
                </span>
                <span className="text-xs text-text-faint">
                  {game.playedAt ? new Date(game.playedAt).toLocaleDateString() : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One button that runs the whole intake chain: import chunks for every
 * linked source, then client-side batch analysis over whatever arrived
 * (progress saved per move — closing the tab loses nothing).
 */
function SyncCard({
  linked,
  unanalyzed,
  onDone,
}: {
  linked: LinkedView[] | null;
  unanalyzed: GameRowPayload[];
  onDone: () => void;
}) {
  // The chain runs in the GLOBAL runner so it survives tab changes; this
  // card mirrors the runner's snapshot and refreshes when it goes idle.
  const snap = useAnalysisRunner();
  const running = snap.importing
    ? snap.importing
    : snap.current
      ? `analyzing ${snap.current.label}${
          snap.current.phase
            ? ` · ${snap.current.phase.phase} ${snap.current.phase.done}/${snap.current.phase.total}`
            : "…"
        }${snap.queue.length > 0 ? ` — ${snap.queue.length} queued` : ""}`
      : null;
  const note = snap.note ?? (snap.lastResult && !snap.lastResult.ok && snap.lastResult.error !== "cancelled" ? `Analysis stopped: ${snap.lastResult.error}` : null);

  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = running !== null;
    if (wasBusy.current && !busy) onDone();
    wasBusy.current = busy;
  }, [running, onDone]);

  const syncAndAnalyze = useCallback(() => {
    if (!linked || linked.length === 0) return;
    void analysisRunner.syncAndAnalyze(linked.map((account) => account.source));
  }, [linked]);

  return (
    <section className="card p-5">
      <h2 className="mb-2 text-base font-semibold text-paper">Sync &amp; analyze</h2>
      {linked === null ? (
        <div className="skeleton h-16 w-full" />
      ) : linked.length === 0 ? (
        <p className="text-sm text-text-dim">
          No platform accounts connected yet —{" "}
          <Link href="/games" className="text-brilliant hover:underline">
            connect chess.com or Lichess
          </Link>{" "}
          to pull your games in.
        </p>
      ) : (
        <>
          {linked.map((account) => (
            <p key={account.source} className="text-xs text-text-dim">
              <span className="notation">@{account.externalUsername}</span>
              <span className="ml-1.5 text-text-faint">
                ({account.source === "chesscom" ? "chess.com" : "Lichess"}
                {account.verified ? " ✓" : ""}) ·{" "}
                {account.lastImportedAt
                  ? `last sync ${new Date(account.lastImportedAt).toLocaleDateString()}`
                  : "never synced"}
              </span>
            </p>
          ))}
          <div className="mt-3 flex items-center gap-3">
            {running ? (
              <>
                <button
                  onClick={() => analysisRunner.stop()}
                  className="btn-ghost px-3 py-1.5 text-sm"
                >
                  Stop
                </button>
                <p className="notation min-w-0 flex-1 truncate text-xs text-text-dim">{running}</p>
              </>
            ) : (
              <button onClick={syncAndAnalyze} className="btn-primary px-4 py-1.5 text-sm">
                Import &amp; analyze
                {unanalyzed.length > 0 ? ` (${unanalyzed.length} waiting)` : ""}
              </button>
            )}
          </div>
        </>
      )}
      {note && <p className="mt-2 text-xs text-text-dim">{note}</p>}
    </section>
  );
}

function LatestGameCard({ game, loaded }: { game: GameRowPayload | null; loaded: boolean }) {
  if (!loaded) {
    return (
      <section className="card p-5">
        <h2 className="mb-2 text-base font-semibold text-paper">Latest game</h2>
        <div className="skeleton h-16 w-full" />
      </section>
    );
  }
  if (!game) {
    return (
      <section className="card p-5">
        <h2 className="mb-2 text-base font-semibold text-paper">Latest game</h2>
        <p className="text-sm text-text-dim">
          Nothing here yet —{" "}
          <Link href="/play" className="text-brilliant hover:underline">
            play a game
          </Link>{" "}
          or import your history.
        </p>
      </section>
    );
  }
  const opponent = game.userColor === "black" ? game.whiteName : game.blackName;
  const outcome =
    game.result === "1/2-1/2"
      ? "Draw"
      : game.result === "*"
        ? "Unfinished"
        : (game.result === "1-0") === (game.userColor === "white")
          ? "Won"
          : "Lost";
  const reviewed = game.plyCount > 0 && game.reviewedCount >= game.plyCount;
  return (
    <section className="card p-5">
      <h2 className="mb-2 text-base font-semibold text-paper">Latest game</h2>
      <p className="text-sm text-text">
        <span
          className={
            outcome === "Won" ? "text-accent" : outcome === "Lost" ? "text-warn-1" : "text-text-dim"
          }
        >
          {outcome}
        </span>{" "}
        vs <span className="notation">{opponent}</span>
        {game.playedAt && (
          <span className="ml-2 text-xs text-text-faint">
            {new Date(game.playedAt).toLocaleDateString()}
          </span>
        )}
      </p>
      {game.opening && <p className="mt-1 text-xs text-text-dim">{game.opening}</p>}
      <p className="mt-1 text-xs text-text-faint">
        {reviewed
          ? `analyzed — ${game.errorCount} error${game.errorCount === 1 ? "" : "s"} on your side`
          : "not fully analyzed yet"}
      </p>
      <Link
        href={`/analysis/${game.id}`}
        className="mt-3 inline-block text-sm text-brilliant hover:underline"
      >
        {reviewed ? "Open review →" : "Analyze →"}
      </Link>
    </section>
  );
}

function FingerprintCard({
  report,
}: {
  report: FingerprintPayload["report"] | null;
}) {
  const top = report?.distribution?.[0] ?? null;
  return (
    <section className="card p-5">
      <h2 className="mb-2 text-base font-semibold text-paper">Your blunder fingerprint</h2>
      {!report || report.errorPlies === 0 ? (
        <p className="text-sm text-text-dim">
          Analyze a few games and the fingerprint names which mistake you actually repeat.
        </p>
      ) : (
        <>
          <p className="text-sm text-text">
            {Math.round(report.nature.tacticalShare * 100)}% of your named errors are tactical
            <span className="text-text-faint"> ({report.errorPlies} errors analyzed)</span>
          </p>
          {top && (
            <p className="mt-1 text-xs text-text-dim">
              Most common: <span className="notation">{top.motif}</span> ·{" "}
              {Math.round(top.share * 100)}%
            </p>
          )}
        </>
      )}
      <Link
        href="/train/fingerprint"
        className="mt-3 inline-block text-sm text-brilliant hover:underline"
      >
        Full fingerprint →
      </Link>
    </section>
  );
}

function DrillCard({
  drill,
  drillCount,
}: {
  drill: OwnPuzzlePayload["puzzles"][number] | null;
  drillCount: number;
}) {
  return (
    <section className="card p-5">
      <h2 className="mb-2 text-base font-semibold text-paper">Drill of the day</h2>
      {!drill ? (
        <p className="text-sm text-text-dim">
          Once analysis finds blunders in your games, one becomes your daily drill — spot the
          punishment you missed.
        </p>
      ) : (
        <p className="text-sm text-text">
          A position from your own games
          {drill.theme && (
            <>
              {" "}
              — theme <span className="notation">{drill.theme}</span>
            </>
          )}
          <span className="text-text-faint"> · {drillCount} in your queue</span>
        </p>
      )}
      <Link
        href="/puzzles?mode=own"
        className="mt-3 inline-block text-sm text-brilliant hover:underline"
      >
        {drill ? "Solve it →" : "Puzzles →"}
      </Link>
    </section>
  );
}
