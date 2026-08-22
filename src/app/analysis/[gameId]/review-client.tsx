"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-context";
import { ClassificationIcon } from "@/components/classification-icon";
import { GameBoard } from "@/components/game-board";
import { FigurineSan } from "@/components/pieces";
import { usePrefs } from "@/components/prefs-context";
import { Ribbon, RibbonStrip } from "@/components/ribbon";
import { ApiError } from "@/lib/account/client";
import { GamePosition } from "@/lib/chess/position";
import type { VariantId } from "@/lib/chess/variant";
import { START_FEN } from "@/lib/chess/fen";
import type { Classification } from "@/lib/eval";

/**
 * The review page (Phase 2 §8): board + eval bar (the B2 ribbon), move list
 * with Informant icons, per-side §4.5 accuracy, the eval graph as a ribbon
 * strip (tablebase region tinted per B0.1 — a treatment, never a value
 * jump), key-moments jump, and C3 mechanism chains rendered from detector
 * evidence. Keyboard ←/→ navigation with an ARIA live region (A3.7).
 */

interface TagPayload {
  motif: string;
  rank: number;
  confidence: number;
  evidence: Record<string, unknown> | null;
  explanation: string | null;
}

interface PlyPayload {
  ply: number;
  moveNumber: number;
  color: "white" | "black";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  evalBeforeCp: number | null;
  evalAfterCp: number | null;
  mateBefore: number | null;
  mateAfter: number | null;
  bestMoveUci: string | null;
  pv1: string[] | null;
  wpBefore: number | null;
  wpAfter: number | null;
  wpLoss: number | null;
  classification: Classification | null;
  clockMsRemaining: number | null;
  timeSpentMs: number | null;
  isCritical: boolean;
  tbHit: boolean;
  tags: TagPayload[];
}

interface ReviewPayload {
  game: {
    id: string;
    variant: string;
    source: string;
    whiteName: string;
    blackName: string;
    userColor: "white" | "black";
    result: string;
    termination: string | null;
    timeControl: string | null;
    eco: string | null;
    opening: string | null;
    playedAt: string | null;
    startFen: string | null;
  };
  accuracy: { white: number | null; black: number | null };
  plies: PlyPayload[];
}

const KEY_CLASSES: Classification[] = ["BLUNDER", "MISTAKE", "MISS", "BRILLIANT", "GREAT"];

export function ReviewClient({ gameId }: { gameId: string }) {
  const auth = useAuth();
  const { prefs } = usePrefs();
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0); // 0 = start position, n = after ply n
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ analyzed: number; total: number } | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    fetch(`/api/games/${gameId}`)
      .then(async (response) => {
        const body = (await response.json()) as ReviewPayload & {
          error?: { message: string };
        };
        if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        setData(body);
        setCursor(body.plies.length);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [gameId]);

  useEffect(() => {
    if (auth.status === "ready") load();
  }, [auth.status, load]);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      for (;;) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId }),
        });
        const body = (await response.json()) as {
          progress?: { analyzed: number; total: number };
          done?: boolean;
          error?: { message: string };
        };
        if (!response.ok) throw new ApiError(response.status, "analyze", body.error?.message ?? "failed", body);
        if (body.progress) setProgress(body.progress);
        if (body.done) break;
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setAnalyzing(false);
      setProgress(null);
    }
  }, [gameId, load]);

  // Keyboard navigation (A3.7).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!data) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCursor((value) => Math.max(0, value - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setCursor((value) => Math.min(data.plies.length, value + 1));
      } else if (event.key === "Home") {
        setCursor(0);
      } else if (event.key === "End") {
        setCursor(data.plies.length);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data]);

  // ARIA announcements on cursor change.
  useEffect(() => {
    if (!data || !liveRef.current) return;
    const ply = cursor > 0 ? data.plies[cursor - 1] : null;
    liveRef.current.textContent = ply
      ? `Move ${ply.moveNumber}${ply.color === "black" ? "…" : "."} ${ply.san}${
          ply.classification ? `, ${ply.classification.toLowerCase()}` : ""
        }`
      : "Start position";
  }, [cursor, data]);

  const current = cursor > 0 ? data?.plies[cursor - 1] : null;
  const fen = current?.fenAfter ?? data?.game.startFen ?? START_FEN;

  const whiteWp = useMemo(() => {
    if (!data) return 50;
    if (!current) {
      const first = data.plies[0];
      if (first?.wpBefore == null) return 50;
      return first.color === "white" ? first.wpBefore : 100 - first.wpBefore;
    }
    if (current.wpAfter == null) return 50;
    return current.color === "white" ? 100 - current.wpAfter : current.wpAfter;
  }, [data, current]);

  const stripEntries = useMemo(
    () =>
      (data?.plies ?? []).map((ply) => {
        const white =
          ply.wpAfter == null ? 50 : ply.color === "white" ? 100 - ply.wpAfter : ply.wpAfter;
        return {
          value: (white - 50) / 50,
          isBlunder: ply.classification === "BLUNDER",
          isTablebase: ply.tbHit,
          isCritical: ply.isCritical,
        };
      }),
    [data]
  );

  if (error) {
    return (
      <Shell>
        <p className="text-sm text-warn-1">{error}</p>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <p className="text-sm text-text-faint">Loading…</p>
      </Shell>
    );
  }

  const { game, accuracy } = data;
  const analyzed = data.plies.length > 0 && data.plies.every((ply) => ply.wpBefore !== null);
  const keyMoments = data.plies.filter(
    (ply) => ply.classification && KEY_CLASSES.includes(ply.classification)
  );

  return (
    <Shell>
      <div ref={liveRef} className="sr-only" role="status" aria-live="polite" />
      <header className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm text-text">
          <span className={game.userColor === "white" ? "font-semibold" : ""}>{game.whiteName}</span>
          <span className="text-text-faint"> vs </span>
          <span className={game.userColor === "black" ? "font-semibold" : ""}>{game.blackName}</span>
        </span>
        <span className="notation text-sm text-text">{game.result}</span>
        {game.opening && <span className="text-xs text-text-faint">{game.eco} {game.opening}</span>}
        {game.source !== "local" && (
          <span className="text-xs text-text-faint">{game.source} import · handle unverified</span>
        )}
        {accuracy.white !== null && accuracy.black !== null && (
          <span className="notation ml-auto text-sm text-text-dim">
            accuracy {accuracy.white.toFixed(1)} · {accuracy.black.toFixed(1)}
          </span>
        )}
      </header>

      {!analyzed && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-edge p-3">
          <button
            onClick={() => void analyze()}
            disabled={analyzing}
            className="rounded bg-lcd px-4 py-1.5 text-sm font-medium text-field hover:opacity-90 disabled:opacity-50"
          >
            {analyzing ? "Analyzing…" : "Analyze game"}
          </button>
          <div className="min-w-0 flex-1">
            {progress ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-raise">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(progress.analyzed / Math.max(1, progress.total)) * 100}%`,
                      background: "var(--lcd)",
                      transition: "width var(--motion-eval) ease-out",
                    }}
                  />
                </div>
                <p className="notation mt-1 text-xs text-text-faint">
                  {progress.analyzed} / {progress.total} plies at depth 18
                </p>
              </>
            ) : (
              <p className="text-xs text-text-faint">
                Depth-18 review of every position — evals, classifications, critical
                moments, and blunder mechanisms.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex gap-2">
          {prefs.evalBar.show && (
            <Ribbon
              value={(whiteWp - 50) / 50}
              orientation="vertical"
              className="w-3 self-stretch"
              label={`White win probability ${whiteWp.toFixed(0)}%`}
            />
          )}
          <div className="w-full max-w-[560px] flex-1">
            <GameBoard
              boardId={`review-${game.id}`}
              fen={fen}
              orientation={game.userColor}
              lastMove={current ? { from: current.uci.slice(0, 2), to: current.uci.slice(2, 4) } : null}
              interactive={false}
              onMove={() => false}
              destsFrom={() => []}
              canSelect={() => false}
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="flex gap-1">
                <NavButton onClick={() => setCursor(0)} label="Start">⏮</NavButton>
                <NavButton onClick={() => setCursor(Math.max(0, cursor - 1))} label="Previous move">←</NavButton>
                <NavButton onClick={() => setCursor(Math.min(data.plies.length, cursor + 1))} label="Next move">→</NavButton>
                <NavButton onClick={() => setCursor(data.plies.length)} label="End">⏭</NavButton>
              </div>
              {current?.timeSpentMs != null && (
                <span className="notation text-xs text-text-faint">
                  {(current.timeSpentMs / 1000).toFixed(1)}s thought
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <MoveList
            plies={data.plies}
            cursor={cursor}
            onSelect={setCursor}
            figurine={prefs.moveList === "figurine"}
            pieceSet={prefs.pieceSet}
          />
          {current && <PlyDetail ply={current} variant={game.variant as VariantId} />}
        </div>
      </div>

      {analyzed && (
        <div className="mt-5">
          <RibbonStrip
            entries={stripEntries}
            currentIndex={cursor > 0 ? cursor - 1 : null}
            onSelect={(index) => setCursor(index + 1)}
            ariaLabel="Evaluation graph — one bar per move"
          />
          {keyMoments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {keyMoments.map((ply) => (
                <button
                  key={ply.ply}
                  onClick={() => setCursor(ply.ply)}
                  className="flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-xs text-text-dim hover:border-edge-strong hover:text-text"
                >
                  <ClassificationIcon classification={ply.classification!} />
                  <span className="notation">
                    {ply.moveNumber}{ply.color === "black" ? "…" : "."} {ply.san}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-paper">Review</h1>
        <Link href="/games" className="text-sm text-text-dim hover:text-text">
          ← games
        </Link>
      </div>
      {children}
    </div>
  );
}

function NavButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="rounded border border-edge px-2.5 py-1 text-sm text-text-dim hover:border-edge-strong hover:text-text"
    >
      {children}
    </button>
  );
}

function MoveList({
  plies,
  cursor,
  onSelect,
  figurine,
  pieceSet,
}: {
  plies: PlyPayload[];
  cursor: number;
  onSelect: (cursor: number) => void;
  figurine: boolean;
  pieceSet: "classic" | "cburnett";
}) {
  const byNumber = new Map<number, { white?: PlyPayload; black?: PlyPayload }>();
  for (const ply of plies) {
    const row = byNumber.get(ply.moveNumber) ?? {};
    row[ply.color] = ply;
    byNumber.set(ply.moveNumber, row);
  }
  const rows = [...byNumber.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="max-h-[420px] overflow-y-auto rounded-lg border border-edge p-2">
      {rows.map(([number, row]) => (
        <div key={number} className="flex items-center gap-1 py-0.5 text-sm">
          <span className="notation w-8 text-right text-xs text-text-faint">{number}.</span>
          {(["white", "black"] as const).map((color) => {
            const ply = row[color];
            if (!ply) return <span key={color} className="flex-1" />;
            const active = cursor === ply.ply;
            return (
              <button
                key={color}
                onClick={() => onSelect(ply.ply)}
                className={`flex flex-1 items-center gap-1 rounded px-1.5 py-0.5 text-left ${
                  active ? "bg-raise text-text" : "text-text-dim hover:bg-raise hover:text-text"
                }`}
              >
                <span className="notation">
                  {figurine ? (
                    <FigurineSan
                      san={ply.san}
                      color={color === "white" ? "w" : "b"}
                      setId={pieceSet}
                    />
                  ) : (
                    ply.san
                  )}
                </span>
                {ply.classification && <ClassificationIcon classification={ply.classification} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** C3: mechanism chain + evidence for the selected ply. */
function PlyDetail({ ply, variant }: { ply: PlyPayload; variant: VariantId }) {
  const refutationSan = useMemo(() => {
    if (!ply.tags.length || !ply.pv1) return null;
    try {
      // The refutation line is the NEXT position's pv; here we show the best
      // line from before the move for context.
      const replay = GamePosition.fromFen(ply.fenBefore, variant);
      const sans: string[] = [];
      for (const uci of (ply.pv1 ?? []).slice(0, 6)) {
        const move = replay.moveUci(uci);
        if (!move) break;
        sans.push(move.san);
      }
      return sans.join(" ");
    } catch {
      return null;
    }
  }, [ply, variant]);

  const loss = ply.wpLoss ?? 0;
  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <div className="flex items-baseline gap-2">
        <span className="notation text-sm text-text">
          {ply.moveNumber}{ply.color === "black" ? "…" : "."} {ply.san}
        </span>
        {ply.classification && <ClassificationIcon classification={ply.classification} />}
        {loss >= 2 && (
          <span className="notation text-xs text-text-faint">(−{loss.toFixed(0)} WP)</span>
        )}
        {ply.isCritical && <span className="text-xs text-lcd">critical</span>}
        {ply.tbHit && <span className="text-xs text-brilliant">tablebase</span>}
      </div>

      {ply.tags.length > 0 && (
        <div className="mt-2">
          <p className="notation text-sm text-text">
            {ply.tags.map((tag) => tag.motif).join("  →  ")}
          </p>
          <ul className="mt-1 text-xs text-text-faint">
            {ply.tags.map((tag) => (
              <li key={tag.motif} className="truncate">
                {tag.motif.toLowerCase().replaceAll("_", " ")} · confidence{" "}
                {(tag.confidence * 100).toFixed(0)}%
                {tag.evidence ? ` · ${summarizeEvidence(tag.evidence)}` : ""}
              </li>
            ))}
          </ul>
          {ply.tags[0]?.explanation && (
            <p className="mt-1 text-xs text-text-dim">{ply.tags[0].explanation}</p>
          )}
        </div>
      )}

      {refutationSan && (
        <p className="mt-2 text-xs text-text-faint">
          best was <span className="notation text-text-dim">{refutationSan}</span>
        </p>
      )}
    </div>
  );
}

function summarizeEvidence(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join(" · ");
}
