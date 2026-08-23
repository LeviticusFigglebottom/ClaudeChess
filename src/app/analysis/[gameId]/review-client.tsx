"use client";

import type { PieceSetId } from "@/lib/prefs/prefs";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-context";
import { ClassificationIcon } from "@/components/classification-icon";
import { GameBoard } from "@/components/game-board";
import { FigurineSan } from "@/components/pieces";
import { usePrefs } from "@/components/prefs-context";
import { Ribbon, RibbonStrip } from "@/components/ribbon";
import { useFlag } from "@/components/use-flag";
import { useAnalysisRunner } from "@/components/analysis-runner";
import type { BatchProgress } from "@/lib/analysis/client-batch";
import { analysisRunner } from "@/lib/analysis/runner";
import { isProvisional, needsVerify } from "@/lib/analysis/verify-rules";
import { evalLabel, explainPly } from "@/lib/eval/explain";
import { GamePosition } from "@/lib/chess/position";
import type { VariantId } from "@/lib/chess/variant";
import { START_FEN } from "@/lib/chess/fen";
import { ANALYSIS_SETTINGS, type Classification } from "@/lib/eval";

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
  pv2: string[] | null;
  pv3: string[] | null;
  pv2EvalCp: number | null;
  pv2Mate: number | null;
  pv3EvalCp: number | null;
  pv3Mate: number | null;
  wpBefore: number | null;
  wpAfter: number | null;
  wpLoss: number | null;
  classification: Classification | null;
  clockMsRemaining: number | null;
  timeSpentMs: number | null;
  isCritical: boolean;
  /** §3.3 watchdog: analysis completed only at reduced settings. */
  degraded: boolean;
  degradedDepth: number | null;
  /** Depth this ply's record was analyzed at (progressive: 12 → 18 → 24). */
  analyzedAtDepth: number | null;
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
  const autoResumedRef = useRef(false);
  const firstLoadRef = useRef(true);
  const liveRef = useRef<HTMLDivElement | null>(null);

  // Analysis runs in the GLOBAL runner (survives navigating to other tabs);
  // this page derives its progress display from the runner's snapshot.
  const runnerSnap = useAnalysisRunner();
  const mine = runnerSnap.current?.gameId === gameId ? runnerSnap.current : null;
  const analyzing = mine !== null || runnerSnap.queue.some((job) => job.gameId === gameId);
  const clientPhase = mine?.phase ?? null;
  const progress = mine?.serverProgress ?? null;
  const verifying = mine?.serverProgress?.verifyRemaining ?? 0;
  const fallbackNote = mine?.note ?? null;

  const load = useCallback(() => {
    fetch(`/api/games/${gameId}`)
      .then(async (response) => {
        const body = (await response.json()) as ReviewPayload & {
          error?: { message: string };
        };
        if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        setData(body);
        // Jump to the end on first load only — background-analysis reloads
        // must not yank the cursor out from under the reader.
        if (firstLoadRef.current) {
          firstLoadRef.current = false;
          setCursor(body.plies.length);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [gameId]);

  useEffect(() => {
    if (auth.status === "ready") load();
  }, [auth.status, load]);

  /**
   * Analysis is delegated to the GLOBAL runner (client engine first, server
   * chunk loop as fallback — both live in src/lib/analysis/runner so the
   * work survives navigating to other tabs). This page only enqueues and
   * subscribes.
   */
  const analyze = useCallback(() => {
    setError(null);
    const opponent = data
      ? `vs ${data.game.userColor === "black" ? data.game.whiteName : data.game.blackName}`
      : "this game";
    analysisRunner.enqueue([{ gameId, label: opponent }], { front: true });
  }, [gameId, data]);

  // Refresh the review as runner passes land; surface a failed run once.
  useEffect(() => {
    return analysisRunner.subscribeGame(gameId, (event) => {
      if (event === "pass") load();
      if (event === "done") {
        const result = analysisRunner.getSnapshot().lastResult;
        if (result?.gameId === gameId && !result.ok && result.error !== "cancelled") {
          setError(result.error ?? "Analysis failed.");
        }
        load();
      }
    });
  }, [gameId, load]);

  // Resume interrupted analysis automatically: partially-analyzed games
  // (a closed tab mid-run) pick up where they stopped, once per page view.
  useEffect(() => {
    if (!data || analyzing || autoResumedRef.current) return;
    const someAnalyzed = data.plies.some((ply) => ply.classification !== null);
    const incomplete = data.plies.some(
      (ply) =>
        !ply.degraded &&
        ((ply.classification === null && ply.wpBefore === null) ||
          (ply.analyzedAtDepth ?? 0) < ANALYSIS_SETTINGS.review.depth)
    );
    if (someAnalyzed && incomplete) {
      autoResumedRef.current = true;
      analyze();
    }
  }, [data, analyzing, analyze]);

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

  // Alternative previewed from the detail card's chips (arrow on the board).
  const [previewUci, setPreviewUci] = useState<string | null>(null);
  useEffect(() => setPreviewUci(null), [cursor]);

  // On error plies, annotate the board chess.com-style: the played move in
  // the mistake tone, the engine's line in the confident accent. Arrows are
  // drawn on the post-move board, so the best-move arrow starts from where
  // the piece STOOD — the standard review convention.
  const reviewArrows = useMemo(() => {
    const arrows: { from: string; to: string; color: string }[] = [];
    if (current?.classification && ERROR_CLASSES.includes(current.classification)) {
      const best = current.pv1?.[0];
      if (best && best !== current.uci) {
        arrows.push({
          from: current.uci.slice(0, 2),
          to: current.uci.slice(2, 4),
          color: "var(--warn-2)",
        });
        arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), color: "var(--accent)" });
      }
    }
    if (previewUci) {
      arrows.push({
        from: previewUci.slice(0, 2),
        to: previewUci.slice(2, 4),
        color: "var(--brilliant)",
      });
    }
    return arrows.length > 0 ? arrows : undefined;
  }, [current, previewUci]);

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
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="skeleton aspect-square w-full max-w-[560px]" />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="skeleton h-64 w-full" />
            <div className="skeleton h-24 w-full" />
          </div>
        </div>
      </Shell>
    );
  }

  const { game, accuracy } = data;
  const hasEvals = data.plies.length > 0 && data.plies.every((ply) => ply.wpBefore !== null);
  const reviewComplete =
    hasEvals &&
    data.plies.every(
      (ply) => ply.degraded || (ply.analyzedAtDepth ?? 0) >= ANALYSIS_SETTINGS.review.depth
    );
  const provisionalCount = data.plies.filter((ply) => isProvisional(ply)).length;
  // Borderline evals a deep (d24) pass would refine — the review is BASIC
  // by default (owner directive); deep verification is the opt-in below.
  const verifiableCount = data.plies.filter((ply) => needsVerify(ply)).length;
  const keyMoments = data.plies.filter(
    (ply) => ply.classification && KEY_CLASSES.includes(ply.classification)
  );

  const phaseLabel = (phase: BatchProgress): string => {
    switch (phase.phase) {
      case "boot":
        return "starting the engine…";
      case "pass1":
        return `quick pass (depth ${ANALYSIS_SETTINGS.provisional.depth}) — ${phase.done}/${phase.total} positions`;
      case "pass2":
        return `refining to depth ${ANALYSIS_SETTINGS.review.depth} — ${phase.done}/${phase.total} positions`;
      case "pass3":
        return `verifying ${phase.total} borderline ${phase.total === 1 ? "eval" : "evals"} at depth 24 — ${phase.done}/${phase.total}`;
      case "finalize":
        return "computing motifs and critical moments…";
    }
  };

  return (
    <Shell gameId={gameId}>
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
            accuracy <span className="text-text-faint">W</span> {accuracy.white.toFixed(1)} ·{" "}
            <span className="text-text-faint">B</span> {accuracy.black.toFixed(1)}
          </span>
        )}
      </header>

      {reviewComplete && analyzing && (
        // The review is COMPLETE at depth 18 — the d24 borderline refinement
        // and motif derivation continue quietly; nobody should wait on them.
        <p className="notation mb-4 text-xs text-text-faint">
          {clientPhase?.phase === "pass3"
            ? `deep-verifying ${clientPhase.total} borderline ${clientPhase.total === 1 ? "eval" : "evals"} at depth 24 (${clientPhase.done}/${clientPhase.total})…`
            : "refining evals and deriving motifs in the background…"}
        </p>
      )}
      {reviewComplete && !analyzing && verifiableCount > 0 && (
        // BASIC review complete (the default): full depth is the opt-in.
        <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-text-faint">
          <span>
            Basic review (depth {ANALYSIS_SETTINGS.review.depth}) — {verifiableCount} borderline{" "}
            {verifiableCount === 1 ? "eval" : "evals"} could sharpen with a deeper look.
          </span>
          <button
            onClick={() => {
              const opponent = `vs ${
                data.game.userColor === "black" ? data.game.whiteName : data.game.blackName
              }`;
              analysisRunner.enqueue([{ gameId, label: opponent, full: true }], { front: true });
            }}
            className="rounded border border-edge px-2 py-0.5 text-text-dim hover:border-edge-strong hover:text-text"
          >
            Deep-verify at depth 24
          </button>
        </p>
      )}
      {!reviewComplete && (
        <div className="card mb-4 flex items-center gap-3 p-3">
          <button
            onClick={() => void analyze()}
            disabled={analyzing}
            className="btn-primary px-4 py-1.5 text-sm"
          >
            {analyzing ? "Analyzing…" : provisionalCount > 0 ? "Finish analysis" : "Analyze game"}
          </button>
          <div className="min-w-0 flex-1">
            {clientPhase ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-raise">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(clientPhase.done / Math.max(1, clientPhase.total)) * 100}%`,
                      background: "var(--accent)",
                      transition: "width var(--motion-eval) ease-out",
                    }}
                  />
                </div>
                <p className="notation mt-1 text-xs text-text-faint">
                  analyzing in your browser · {phaseLabel(clientPhase)}
                </p>
              </>
            ) : progress ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-raise">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(progress.analyzed / Math.max(1, progress.total)) * 100}%`,
                      background: "var(--accent)",
                      transition: "width var(--motion-eval) ease-out",
                    }}
                  />
                </div>
                <p className="notation mt-1 text-xs text-text-faint">
                  {verifying > 0
                    ? `verifying ${verifying} borderline ${verifying === 1 ? "eval" : "evals"} at depth 24…`
                    : `${progress.analyzed} / ${progress.total} plies at depth 18`}
                </p>
              </>
            ) : (
              <p className="text-xs text-text-faint">
                {fallbackNote ??
                  "Reviews every position in your browser where supported — provisional results in seconds, depth 18 throughout. Deep verification (d24) stays optional afterwards."}
              </p>
            )}
          </div>
        </div>
      )}

      {provisionalCount > 0 && (
        <p className="mb-4 rounded-lg border border-warn-1/40 bg-surface px-3 py-2 text-xs text-text-dim">
          Provisional review at depth {ANALYSIS_SETTINGS.provisional.depth} on {provisionalCount}{" "}
          {provisionalCount === 1 ? "ply" : "plies"} — being refined to depth{" "}
          {ANALYSIS_SETTINGS.review.depth}
          {analyzing ? "…" : " when analysis resumes."} Provisional plies are excluded from
          trainer statistics.
        </p>
      )}

      {/* Wide two-column layout: the board scales with the viewport (the
          old fixed 560px looked postage-stamp-sized on large monitors); the
          sidebar holds the move list + coach detail with its own scroll. */}
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="min-w-0 flex-1">
          <div className="flex gap-2">
            {prefs.evalBar.show && (
              <Ribbon
                value={(whiteWp - 50) / 50}
                orientation="vertical"
                className="w-3 self-stretch"
                label={`White win probability ${whiteWp.toFixed(0)}%`}
              />
            )}
            <div className="w-full max-w-[min(calc(100vh-20rem),840px)] flex-1">
              <GameBoard
                boardId={`review-${game.id}`}
                fen={fen}
                orientation={game.userColor}
                lastMove={current ? { from: current.uci.slice(0, 2), to: current.uci.slice(2, 4) } : null}
                interactive={false}
                onMove={() => false}
                destsFrom={() => []}
                canSelect={() => false}
                arrows={reviewArrows}
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
              {hasEvals && (
                <div className="mt-4">
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
            </div>
          </div>
        </div>

        <div className="w-full min-w-0 lg:w-[26rem] lg:shrink-0 xl:w-[30rem] 2xl:w-[34rem]">
          <div className="max-h-[46vh] overflow-y-auto lg:max-h-[62vh]">
            <MoveList
              plies={data.plies}
              cursor={cursor}
              onSelect={setCursor}
              figurine={prefs.moveList === "figurine"}
              pieceSet={prefs.pieceSet}
            />
          </div>
          {current && (
            <PostmortemGate gameId={gameId} ply={current}>
              <PlyDetail
                ply={current}
                nextPly={data.plies[cursor] ?? null}
                variant={game.variant as VariantId}
                previewUci={previewUci}
                onPreview={setPreviewUci}
              />
            </PostmortemGate>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, gameId }: { children: React.ReactNode; gameId?: string }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-paper">Review</h1>
        <span className="flex gap-4">
          {gameId && (
            <Link
              href={`/analysis?game=${gameId}`}
              className="text-sm text-text-dim hover:text-text"
            >
              open in analysis board
            </Link>
          )}
          <Link href="/games" className="text-sm text-text-dim hover:text-text">
            ← games
          </Link>
        </span>
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
      className="btn-ghost px-2.5 py-1 text-sm"
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
  pieceSet: PieceSetId;
}) {
  const byNumber = new Map<number, { white?: PlyPayload; black?: PlyPayload }>();
  for (const ply of plies) {
    const row = byNumber.get(ply.moveNumber) ?? {};
    row[ply.color] = ply;
    byNumber.set(ply.moveNumber, row);
  }
  const rows = [...byNumber.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="card max-h-[420px] overflow-y-auto p-2">
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
interface PmPrompt {
  plyId: number;
  ply: number;
  answered: boolean;
}

/**
 * §9.5: on an interrogable critical ply, ask what the player was thinking
 * BEFORE the engine's verdict (the PlyDetail with lines and motifs) is
 * shown. Max 5 per game, chosen server-side; skippable; the coach's verdict
 * lands inline. Behind FF_POSTMORTEM.
 */
function PostmortemGate({
  gameId,
  ply,
  children,
}: {
  gameId: string;
  ply: PlyPayload;
  children: React.ReactNode;
}) {
  const enabled = useFlag("FF_POSTMORTEM");
  const [prompts, setPrompts] = useState<PmPrompt[] | null>(null);
  const [llm, setLlm] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [reasoning, setReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verdict: string; critique: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    fetch(`/api/train/postmortem?gameId=${gameId}`)
      .then(async (response) => (response.ok ? response.json() : null))
      .then((body: { prompts: PmPrompt[]; llm: boolean } | null) => {
        if (body) {
          setPrompts(body.prompts);
          setLlm(body.llm);
        }
      })
      .catch(() => undefined);
  }, [enabled, gameId]);

  const prompt = prompts?.find((row) => row.ply === ply.ply);
  useEffect(() => {
    setResult(null);
    setReasoning("");
    setError(null);
  }, [ply.ply]);

  if (!enabled || !llm || !prompt || prompt.answered || done.has(prompt.plyId)) {
    return <>{children}</>;
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plyId: prompt.plyId, userReasoning: reasoning }),
      });
      const body = (await response.json()) as {
        verdict?: string;
        critique?: string;
        error?: { message: string };
      };
      if (!response.ok || !body.verdict) throw new Error(body.error?.message ?? "Coach failed.");
      setResult({ verdict: body.verdict, critique: body.critique ?? "" });
      setDone((current) => new Set(current).add(prompt.plyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Coach failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mt-3 border-accent/40 p-3">
      {result === null ? (
        <>
          <p className="text-sm text-text">
            Before the engine speaks — what were you worried about here? What did you think
            their plan was?
          </p>
          <textarea
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded border border-edge bg-transparent px-2 py-1.5 text-sm text-text"
            placeholder="I thought…"
            aria-label="Your reasoning at this position"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void submit()}
              disabled={busy || reasoning.trim().length < 3}
              className="btn-primary px-4 py-1.5 text-sm"
            >
              {busy ? "Thinking…" : "Answer, then reveal"}
            </button>
            <button
              onClick={() => setDone((current) => new Set(current).add(prompt.plyId))}
              className="text-sm text-text-faint hover:text-text-dim"
            >
              skip
            </button>
            {error && <span className="text-xs text-warn-1">{error}</span>}
          </div>
        </>
      ) : (
        <div>
          <p className="notation text-sm text-paper">{result.verdict}</p>
          <p className="mt-1 text-sm text-text-dim">{result.critique}</p>
        </div>
      )}
      {result !== null && <div className="mt-2">{children}</div>}
    </div>
  );
}

const ERROR_CLASSES: Classification[] = ["INACCURACY", "MISTAKE", "BLUNDER", "MISS"];

/** UCI line → SAN list from a starting fen (stops at the first illegal move). */
function sanLine(fen: string, line: string[] | null, variant: VariantId, max = 6): string[] {
  if (!line || line.length === 0) return [];
  try {
    const replay = GamePosition.fromFen(fen, variant);
    const sans: string[] = [];
    for (const uci of line.slice(0, max)) {
      const move = replay.moveUci(uci);
      if (!move) break;
      sans.push(move.san);
    }
    return sans;
  } catch {
    return [];
  }
}

function PlyDetail({
  ply,
  nextPly,
  variant,
  previewUci,
  onPreview,
}: {
  ply: PlyPayload;
  nextPly: PlyPayload | null;
  variant: VariantId;
  /** Alternative currently previewed as a board arrow (toggled by chip). */
  previewUci: string | null;
  onPreview: (uci: string | null) => void;
}) {
  const bestLine = useMemo(
    () => sanLine(ply.fenBefore, ply.pv1, variant),
    [ply, variant]
  );
  // The actual refutation: the best line FROM the position the move created
  // (the next ply's stored pv1 — one search per position, spec §4).
  const punishment = useMemo(
    () => sanLine(ply.fenAfter, nextPly?.pv1 ?? null, variant),
    [ply, nextPly, variant]
  );
  const alternatives = useMemo(() => {
    const options: { san: string; uci: string; label: string | null }[] = [];
    const seen = new Set<string>();
    const entries: [string[] | null, number | null, number | null][] = [
      [ply.pv1, ply.evalBeforeCp, ply.mateBefore],
      [ply.pv2, ply.pv2EvalCp, ply.pv2Mate],
      [ply.pv3, ply.pv3EvalCp, ply.pv3Mate],
    ];
    for (const [line, cp, mate] of entries) {
      const san = sanLine(ply.fenBefore, line, variant, 1)[0];
      const uci = line?.[0];
      if (!san || !uci || seen.has(san)) continue;
      seen.add(san);
      options.push({ san, uci, label: evalLabel(cp, mate) });
    }
    return options;
  }, [ply, variant]);

  const playedIsBest = ply.bestMoveUci !== null && ply.uci === ply.bestMoveUci;
  const { verdict, notes } = useMemo(
    () =>
      explainPly({
        san: ply.san,
        classification: ply.classification,
        wpLoss: ply.wpLoss,
        playedIsBest,
        bestSan: bestLine[0] ?? null,
        mateAfterWhitePov: ply.mateAfter,
        moverIsWhite: ply.color === "white",
        motifs: ply.tags.map((tag) => ({ motif: tag.motif, evidence: tag.evidence })),
        provisional: isProvisional(ply),
        degraded: ply.degraded,
      }),
    [ply, playedIsBest, bestLine]
  );

  const isError = ply.classification !== null && ERROR_CLASSES.includes(ply.classification);
  const loss = ply.wpLoss ?? 0;

  return (
    <div className="card mt-3 p-3.5">
      <div className="flex items-baseline gap-2">
        <span className="notation text-sm font-semibold text-text">
          {ply.moveNumber}{ply.color === "black" ? "…" : "."} {ply.san}
        </span>
        {ply.classification && <ClassificationIcon classification={ply.classification} />}
        {loss >= 2 && (
          <span className="notation text-xs text-text-faint">(−{loss.toFixed(0)} WP)</span>
        )}
        {ply.isCritical && <span className="text-xs text-lcd">critical</span>}
        {ply.degraded && (
          <span
            className="text-xs text-warn-1"
            title="The engine search for this position exceeded its budget; the eval shown is from a reduced search and this ply is excluded from trainer statistics."
          >
            incomplete{ply.degradedDepth ? ` (d${ply.degradedDepth})` : ""}
          </span>
        )}
        {isProvisional(ply) && (
          <span
            className="text-xs text-warn-1"
            title={`Analyzed at depth ${ply.analyzedAtDepth} on the quick first pass; being refined to depth ${ANALYSIS_SETTINGS.review.depth}. Excluded from trainer statistics until then.`}
          >
            provisional (d{ply.analyzedAtDepth})
          </span>
        )}
        {ply.tbHit && <span className="text-xs text-brilliant">tablebase</span>}
        {ply.analyzedAtDepth !== null && !ply.degraded && !isProvisional(ply) && (
          <span
            className="notation ml-auto text-xs text-text-faint"
            title={
              ply.analyzedAtDepth >= 24
                ? "Eval verified at depth 24 (borderline refinement)"
                : "Reviewed at depth 18"
            }
          >
            d{ply.analyzedAtDepth}
          </span>
        )}
      </div>

      {ply.classification && <p className="mt-2 text-sm leading-snug text-text">{verdict}</p>}
      {notes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-text-dim">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {ply.tags[0]?.explanation && (
        <p className="mt-1.5 text-xs text-text-dim">{ply.tags[0].explanation}</p>
      )}

      {alternatives.length > 0 && !playedIsBest && ply.classification !== "BOOK" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-faint">Alternatives:</span>
          {alternatives.map((option) => (
            <button
              key={option.san}
              onClick={() => onPreview(previewUci === option.uci ? null : option.uci)}
              aria-pressed={previewUci === option.uci}
              title="Show this move on the board"
              className={`chip notation transition-colors ${
                previewUci === option.uci
                  ? "border-brilliant text-text"
                  : "hover:border-edge-strong hover:text-text"
              }`}
            >
              {option.san}
              {option.label && <span className="text-text-faint">{option.label}</span>}
            </button>
          ))}
        </div>
      )}

      {bestLine.length > 0 && !playedIsBest && (
        <p className="mt-2 text-xs text-text-faint">
          engine line <span className="notation text-text-dim">{bestLine.join(" ")}</span>
        </p>
      )}
      {isError && punishment.length > 0 && (
        <p className="mt-1 text-xs text-text-faint">
          the punishment <span className="notation text-warn-1">{punishment.join(" ")}</span>
        </p>
      )}

      {ply.tags.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-xs text-text-faint hover:text-text-dim">
            detector evidence ({ply.tags.map((tag) => tag.motif).join(" → ")})
          </summary>
          <ul className="mt-1 text-xs text-text-faint">
            {ply.tags.map((tag) => (
              <li key={tag.motif} className="truncate">
                {tag.motif.toLowerCase().replaceAll("_", " ")} · confidence{" "}
                {(tag.confidence * 100).toFixed(0)}%
                {tag.evidence ? ` · ${summarizeEvidence(tag.evidence)}` : ""}
              </li>
            ))}
          </ul>
        </details>
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
