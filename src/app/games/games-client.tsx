"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-context";
import { ApiError } from "@/lib/account/client";

/**
 * Games list + the import surface (Phase 2, C1): connect your own chess.com /
 * Lichess handle, import incrementally with live progress, optional weekly
 * auto-import. Imported games are labeled by source; handles are unverified
 * (no platform offers an ownership check) and say so.
 */

interface GameRowPayload {
  id: string;
  variant: string;
  source: string;
  whiteName: string;
  blackName: string;
  userColor: "white" | "black";
  result: string;
  timeControl: string | null;
  eco: string | null;
  opening: string | null;
  isStudy: boolean;
  playedAt: string | null;
  plyCount: number;
  analyzedCount: number;
  errorCount: number;
}

interface LinkedView {
  source: "chesscom" | "lichess";
  externalUsername: string;
  verified: boolean;
  lastImportedAt: string | null;
  autoImport: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => null)) as T & {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? "http_error",
      body?.error?.message ?? `HTTP ${response.status}`,
      body
    );
  }
  return body;
}

export function GamesClient() {
  const auth = useAuth();
  const [games, setGames] = useState<GameRowPayload[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ games: GameRowPayload[] }>("/api/games?limit=50")
      .then((response) => setGames(response.games))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, []);

  useEffect(() => {
    if (auth.status === "ready") reload();
  }, [auth.status, reload]);

  if (auth.status === "disabled" || auth.status === "offline") {
    return (
      <Shell>
        <p className="text-sm text-text-dim">
          Saved games and import need the account service; this deployment is running
          local-only.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ImportPanel onImported={reload} />
      <div className="mt-6">
        {!games && <p className="text-sm text-text-faint">{error ?? "Loading…"}</p>}
        {games && games.length === 0 && (
          <p className="text-sm text-text-faint">
            No games yet — play a bot on the Play tab or import your history above.
          </p>
        )}
        {games && games.length > 0 && (
          <ul className="card overflow-hidden">
            {games.map((game) => (
              <GameRow key={game.id} game={game} />
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold text-paper">Games</h1>
      {children}
    </div>
  );
}

function GameRow({ game }: { game: GameRowPayload }) {
  const opponentIsWhite = game.userColor === "black";
  const opponent = opponentIsWhite ? game.whiteName : game.blackName;
  const won =
    (game.result === "1-0" && game.userColor === "white") ||
    (game.result === "0-1" && game.userColor === "black");
  const drew = game.result === "1/2-1/2";
  const analyzed = game.plyCount > 0 && game.analyzedCount === game.plyCount;
  return (
    <li className="border-b border-edge last:border-0">
      <Link
        href={`/analysis/${game.id}`}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
      >
        <span
          className={`notation w-8 text-sm ${won ? "text-brilliant" : drew ? "text-text-dim" : "text-warn-1"}`}
        >
          {won ? "1" : drew ? "½" : "0"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text">
            vs {opponent}
            {game.variant === "chess960" && (
              <span className="notation ml-2 text-xs text-text-faint">960</span>
            )}
          </span>
          <span className="block truncate text-xs text-text-faint">
            {game.opening ?? game.eco ?? "—"}
          </span>
        </span>
        <span className="notation hidden text-xs text-text-faint sm:block">
          {game.timeControl ?? ""}
        </span>
        <span className="hidden text-xs text-text-faint sm:block">
          {game.source === "local" ? "played here" : `${game.source} import`}
        </span>
        {analyzed ? (
          <span className="text-xs text-text-dim">
            reviewed
            {game.errorCount > 0 && (
              <span className="notation ml-1 text-warn-2">{game.errorCount}✗</span>
            )}
          </span>
        ) : game.analyzedCount > 0 ? (
          <span className="notation text-xs text-text-faint">
            {Math.round((game.analyzedCount / Math.max(1, game.plyCount)) * 100)}%
          </span>
        ) : (
          <span className="text-xs text-text-faint">not analyzed</span>
        )}
        <span className="text-xs text-text-faint">
          {game.playedAt ? new Date(game.playedAt).toLocaleDateString() : ""}
        </span>
      </Link>
    </li>
  );
}

function ImportPanel({ onImported }: { onImported: () => void }) {
  const auth = useAuth();
  const [linked, setLinked] = useState<LinkedView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runningRef = useRef(false);
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ imported: number; chunks: number } | null>(null);

  const reload = useCallback(() => {
    api<{ linked: LinkedView[] }>("/api/import")
      .then((response) => setLinked(response.linked))
      .catch(() => setLinked([]));
  }, []);

  useEffect(() => {
    if (auth.status === "ready") reload();
  }, [auth.status, reload]);

  const verified = auth.profile && !auth.profile.isAnonymous && auth.profile.emailVerifiedAt;

  const runImport = async (source: "chesscom" | "lichess") => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(source);
    setNotice(null);
    let imported = 0;
    let chunks = 0;
    try {
      for (;;) {
        const response = await api<{
          result: { imported: number; duplicates: number; done: boolean };
        }>("/api/import", {
          method: "POST",
          body: JSON.stringify({ action: "run", source }),
        });
        imported += response.result.imported;
        chunks++;
        setProgress({ imported, chunks });
        onImported();
        if (response.result.done) break;
        if (chunks >= 40) break; // session safety valve
      }
      setNotice(`Imported ${imported} new game${imported === 1 ? "" : "s"} from ${source === "chesscom" ? "chess.com" : "Lichess"}.`);
      reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import failed.");
    } finally {
      runningRef.current = false;
      setRunning(null);
      setProgress(null);
    }
  };

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold text-paper">Import your history</h2>
      {!verified ? (
        <p className="text-xs text-text-faint">
          Import needs a verified account (it runs real engine analysis on our side) —
          create one from the menu in the top right. Playing and in-browser analysis
          stay free for guests.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-text-faint">
            Connect your own handle — every account imports its own games. Handles are
            unverified (neither platform offers an ownership check without OAuth), so
            imported games are labeled with the source handle.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["chesscom", "lichess"] as const).map((source) => (
              <SourceCard
                key={source}
                source={source}
                linked={linked?.find((entry) => entry.source === source) ?? null}
                running={running === source}
                progress={running === source ? progress : null}
                onLink={async (username) => {
                  setNotice(null);
                  try {
                    await api("/api/import", {
                      method: "POST",
                      body: JSON.stringify({ action: "link", source, username }),
                    });
                    reload();
                  } catch (error) {
                    setNotice(error instanceof Error ? error.message : "Link failed.");
                  }
                }}
                onUnlink={async () => {
                  await api("/api/import", {
                    method: "POST",
                    body: JSON.stringify({ action: "unlink", source }),
                  });
                  reload();
                }}
                onAuto={async (autoImport) => {
                  await api("/api/import", {
                    method: "POST",
                    body: JSON.stringify({ action: "auto", source, autoImport }),
                  });
                  reload();
                }}
                onRun={() => void runImport(source)}
              />
            ))}
          </div>
        </>
      )}
      {notice && <p className="mt-3 text-xs text-text-dim">{notice}</p>}
    </section>
  );
}

function SourceCard({
  source,
  linked,
  running,
  progress,
  onLink,
  onUnlink,
  onAuto,
  onRun,
}: {
  source: "chesscom" | "lichess";
  linked: LinkedView | null;
  running: boolean;
  progress: { imported: number; chunks: number } | null;
  onLink: (username: string) => void;
  onUnlink: () => void;
  onAuto: (auto: boolean) => void;
  onRun: () => void;
}) {
  const [username, setUsername] = useState("");
  const label = source === "chesscom" ? "chess.com" : "Lichess";
  return (
    <div className="rounded-xl border border-edge bg-surface-2 p-3">
      <p className="mb-2 text-sm font-medium text-text">{label}</p>
      {!linked ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (username.trim()) onLink(username.trim());
          }}
        >
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={`${label} username…`}
            className="notation min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm text-text placeholder:text-text-faint"
            aria-label={`${label} username`}
          />
          <button className="btn-primary px-3 py-1 text-sm">
            Connect
          </button>
        </form>
      ) : (
        <div>
          <p className="notation text-sm text-text">
            @{linked.externalUsername}
            <span className="ml-2 text-xs text-text-faint">
              {linked.verified ? "verified" : "unverified"}
            </span>
          </p>
          <p className="mt-1 text-xs text-text-faint">
            {linked.lastImportedAt
              ? `last import ${new Date(linked.lastImportedAt).toLocaleString()}`
              : "never imported"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={onRun}
              disabled={running}
              className="btn-primary px-3 py-1 text-sm"
            >
              {running
                ? progress
                  ? `importing… ${progress.imported}`
                  : "importing…"
                : "Import now"}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-text-dim">
              <input
                type="checkbox"
                checked={linked.autoImport}
                onChange={(event) => onAuto(event.target.checked)}
              />
              weekly auto-import
            </label>
            <button onClick={onUnlink} className="text-xs text-text-faint hover:text-warn-2">
              disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
