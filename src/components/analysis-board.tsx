"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GamePosition } from "@/lib/chess";
import { openingForEpd } from "@/lib/chess/openings";
import { classifyMove, type Classification, type WhitePovEval } from "@/lib/eval";
import { ClassificationIcon } from "./classification-icon";
import { FigurineSan } from "./pieces";
import { GameBoard } from "./game-board";
import { usePrefs } from "./prefs-context";
import { useEngineAnalysis } from "./use-engine-analysis";

function formatEval(evaluation: WhitePovEval, format: "cp" | "wp" | "both", wpWhite: number): string {
  const cpText =
    evaluation.mateIn !== null
      ? evaluation.mateIn > 0
        ? `+M${evaluation.mateIn}`
        : `-M${-evaluation.mateIn}`
      : `${(evaluation.cp ?? 0) >= 0 ? "+" : ""}${((evaluation.cp ?? 0) / 100).toFixed(2)}`;
  const wpText = `${wpWhite.toFixed(0)}%`;
  if (format === "cp") return cpText;
  if (format === "wp") return wpText;
  return `${cpText} · ${wpText}`;
}

function gameOverText(position: GamePosition): string | null {
  if (position.isCheckmate()) return `Checkmate — ${position.turn === "w" ? "Black" : "White"} wins`;
  if (position.isStalemate()) return "Draw — stalemate";
  if (position.isThreefold()) return "Draw — threefold repetition";
  if (position.isInsufficientMaterial()) return "Draw — insufficient material";
  if (position.isFiftyMoves()) return "Draw — fifty-move rule";
  return null;
}

interface PendingClassification {
  moveIndex: number;
  playedUci: string;
  bestUci: string;
  moverColor: "w" | "b";
  wpWhiteBefore: number;
  legalMoveCount: number;
  epdAfter: string;
}

/**
 * Free analysis board: both sides playable, streaming review-depth analysis,
 * live move badges (B2.4 preview: BOOK from the openings dataset, BEST and
 * the loss bands from consecutive depth-12+ evals — the full §4 pipeline
 * with BRILLIANT/GREAT/MISS inputs is Phase 2's batch review).
 */
export function AnalysisBoard() {
  const { prefs } = usePrefs();
  const positionRef = useRef<GamePosition | null>(null);
  positionRef.current ??= GamePosition.initial();
  const position = positionRef.current;

  const [fen, setFen] = useState(position.fen());
  const [history, setHistory] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [badges, setBadges] = useState<(Classification | null)[]>([]);
  const [sanInput, setSanInput] = useState("");
  const pendingRef = useRef<PendingClassification | null>(null);
  const engine = useEngineAnalysis();

  const gameOver = gameOverText(position);
  const { status: engineStatus, analyze, stop } = engine;

  useEffect(() => {
    if (engineStatus !== "ready") return;
    if (gameOver) stop();
    else analyze(fen);
  }, [engineStatus, fen, gameOver, analyze, stop]);

  // Resolve a pending live classification once the new position's analysis
  // is deep enough (or immediately when the position after is book).
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const book = openingForEpd(pending.epdAfter) !== null;
    const top = engine.lines[0];
    if (!book && (engine.depth < 12 || !top)) return;
    const wpWhiteAfter = top?.wpWhite ?? pending.wpWhiteBefore;
    const mover = pending.moverColor;
    const classification = classifyMove({
      variant: "standard",
      wpBefore: mover === "w" ? pending.wpWhiteBefore : 100 - pending.wpWhiteBefore,
      wpAfter: mover === "w" ? wpWhiteAfter : 100 - wpWhiteAfter,
      playedUci: pending.playedUci,
      bestUci: pending.bestUci,
      legalMoveCount: pending.legalMoveCount,
      isBook: book,
    });
    pendingRef.current = null;
    setBadges((previous) => {
      const next = [...previous];
      next[pending.moveIndex] = classification;
      return next;
    });
  }, [engine.depth, engine.lines]);

  const refresh = useCallback(() => {
    setFen(position.fen());
    setHistory(position.historySan());
    const last = position.lastMove();
    setLastMove(last ? { from: last.from, to: last.to } : null);
  }, [position]);

  const afterMove = useCallback(
    (moveUci: string) => {
      const top = engine.lines[0];
      const moverColor = position.turn === "w" ? "b" : "w"; // already flipped by the move
      if (top && top.firstUci) {
        pendingRef.current = {
          moveIndex: position.history().length - 1,
          playedUci: moveUci,
          bestUci: top.firstUci,
          moverColor,
          wpWhiteBefore: top.wpWhite,
          legalMoveCount: 0, // filled below from the pre-move position via undo probe
          epdAfter: position.epd(),
        };
        // Recover the pre-move legal move count without disturbing state.
        const played = position.lastMove();
        if (played && position.undo()) {
          pendingRef.current.legalMoveCount = position.legalMoveCount();
          position.moveUci(played.uci);
        }
      } else {
        pendingRef.current = null;
      }
      setBadges((previous) => {
        const next = [...previous];
        next[position.history().length - 1] = null;
        return next;
      });
      refresh();
    },
    [engine.lines, position, refresh]
  );

  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      const move = position.move({ from, to });
      if (!move) return false;
      afterMove(move.uci);
      return true;
    },
    [position, afterMove]
  );

  const trySan = useCallback(
    (san: string): boolean => {
      const move = position.moveSan(san.trim());
      if (!move) return false;
      afterMove(move.uci);
      return true;
    },
    [position, afterMove]
  );

  const newGame = useCallback(() => {
    position.reset();
    pendingRef.current = null;
    setBadges([]);
    setLastMove(null);
    refresh();
  }, [position, refresh]);

  const undo = useCallback(() => {
    if (position.undo()) {
      pendingRef.current = null;
      setBadges((previous) => previous.slice(0, position.history().length));
      const previous = position.lastMove();
      setLastMove(previous ? { from: previous.from, to: previous.to } : null);
      refresh();
    }
  }, [position, refresh]);

  const canSelect = useCallback(
    (square: string) => {
      const piece = position.pieceAt(square);
      return Boolean(piece && piece.color === position.turn);
    },
    [position, fen] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const topLine = engine.lines[0];
  const whiteBarPct = topLine ? topLine.wpWhite : 50;

  const movePairs = useMemo(() => {
    const pairs: {
      number: number;
      white: string;
      black: string | null;
      whiteBadge: Classification | null;
      blackBadge: Classification | null;
    }[] = [];
    for (let i = 0; i < history.length; i += 2) {
      pairs.push({
        number: i / 2 + 1,
        white: history[i] ?? "",
        black: history[i + 1] ?? null,
        whiteBadge: badges[i] ?? null,
        blackBadge: badges[i + 1] ?? null,
      });
    }
    return pairs;
  }, [history, badges]);

  const sanCell = (text: string, color: "w" | "b", badge: Classification | null) => (
    <span className="inline-flex items-center gap-1">
      {prefs.moveList === "figurine" ? (
        <FigurineSan san={text} color={color} setId={prefs.pieceSet} />
      ) : (
        text
      )}
      {badge && <ClassificationIcon classification={badge} className="text-xs" />}
    </span>
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex w-full max-w-[640px] items-stretch gap-2">
        {prefs.evalBar.show && (
          <div
            className="w-4 shrink-0 overflow-hidden rounded-sm border border-edge"
            title={topLine ? `White win probability ${topLine.wpWhite.toFixed(1)}%` : "eval bar"}
          >
            <div className="flex h-full flex-col">
              <div
                className="w-full bg-black-adv"
                style={{
                  height: `${orientation === "white" ? 100 - whiteBarPct : whiteBarPct}%`,
                  transition: "height var(--motion-eval) ease-out",
                }}
              />
              <div className="w-full flex-1 bg-white-adv" style={{ transition: "height var(--motion-eval) ease-out" }} />
            </div>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <GameBoard
            boardId="analysis"
            fen={fen}
            orientation={orientation}
            lastMove={lastMove}
            interactive
            onMove={tryMove}
            destsFrom={(square) => position.destsFrom(square)}
            canSelect={canSelect}
          />
          {gameOver && (
            <div className="mt-3 rounded-lg border border-edge-strong bg-raise px-4 py-2 text-center font-medium text-text">
              {gameOver}
            </div>
          )}
        </div>
      </div>

      <div className="flex w-full flex-col gap-4 lg:w-80">
        <div className="flex gap-2">
          <button
            onClick={newGame}
            className="rounded-lg bg-paper px-3 py-1.5 text-sm font-medium text-field hover:bg-white-adv"
          >
            Reset
          </button>
          <button
            onClick={undo}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
          >
            Undo
          </button>
          <button
            onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong hover:text-text"
          >
            Flip
          </button>
        </div>

        <div className="rounded-lg border border-edge p-3">
          <div className="mb-2 flex items-baseline justify-between text-xs text-text-faint">
            <span>
              {engine.status === "booting" && "Engine booting…"}
              {engine.status === "error" && "Engine failed to load"}
              {engine.status === "ready" &&
                `${engine.meta?.name ?? "Stockfish"} · ${engine.meta?.threads} thread${(engine.meta?.threads ?? 1) > 1 ? "s" : ""}`}
            </span>
            {engine.status === "ready" && engine.depth > 0 && (
              <span className="notation">
                d{engine.depth} · {(engine.nps / 1_000_000).toFixed(1)}Mn/s
              </span>
            )}
          </div>
          {gameOver ? (
            <p className="text-sm text-text-dim">Game over.</p>
          ) : (
            <ul className="space-y-1.5">
              {engine.lines.map((line) => (
                <li key={line.multipv} className="flex gap-2 text-sm">
                  <span className="notation w-20 shrink-0 font-medium text-lcd">
                    {formatEval(line.evaluation, prefs.evalBar.format, line.wpWhite)}
                  </span>
                  <span className="truncate text-text-dim" title={line.pvSan.join(" ")}>
                    {line.pvSan.slice(0, 8).join(" ")}
                  </span>
                </li>
              ))}
              {engine.status === "ready" && engine.lines.length === 0 && (
                <li className="text-sm text-text-faint">analyzing…</li>
              )}
            </ul>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-edge p-3">
          {movePairs.length === 0 ? (
            <p className="text-sm text-text-faint">
              Make a move — drag a piece or tap origin then destination. Move badges appear as the
              engine reaches depth 12.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {movePairs.map((pair) => (
                  <tr key={pair.number} className="text-text">
                    <td className="notation w-8 py-0.5 pr-2 text-right text-text-faint">
                      {pair.number}.
                    </td>
                    <td className="w-1/2 py-0.5">{sanCell(pair.white, "w", pair.whiteBadge)}</td>
                    <td className="py-0.5">
                      {pair.black ? sanCell(pair.black, "b", pair.blackBadge) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trySan(sanInput)) setSanInput("");
          }}
          className="flex gap-2"
        >
          <input
            value={sanInput}
            onChange={(event) => setSanInput(event.target.value)}
            placeholder="Type a move (SAN — e4, Nf3, O-O)"
            aria-label="Keyboard move entry"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-transparent px-3 py-1.5 text-sm placeholder:text-text-faint"
          />
          <button
            type="submit"
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-text-dim hover:border-edge-strong"
          >
            Play
          </button>
        </form>
      </div>
    </div>
  );
}
