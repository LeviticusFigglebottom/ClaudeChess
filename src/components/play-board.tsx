"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEngineAnalysis } from "./use-engine-analysis";
import type { WhitePovEval } from "@/lib/eval";

function formatEval(evaluation: WhitePovEval): string {
  if (evaluation.mateIn !== null) {
    return evaluation.mateIn > 0 ? `+M${evaluation.mateIn}` : `-M${-evaluation.mateIn}`;
  }
  const pawns = (evaluation.cp ?? 0) / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function gameOverText(chess: Chess): string | null {
  if (chess.isCheckmate()) {
    return `Checkmate — ${chess.turn() === "w" ? "Black" : "White"} wins`;
  }
  if (chess.isStalemate()) return "Draw — stalemate";
  if (chess.isThreefoldRepetition()) return "Draw — threefold repetition";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material";
  if (chess.isDraw()) return "Draw — fifty-move rule";
  return null;
}

/**
 * Free board for Phase 0: both sides playable, legality enforced by chess.js,
 * streaming engine analysis alongside. Bot opponents arrive in Phase 1.
 * Move input works by drag AND tap-tap (spec §10 mobile requirement).
 */
export function PlayBoard() {
  const chessRef = useRef(new Chess());
  const chess = chessRef.current;
  const [fen, setFen] = useState(chess.fen());
  const [history, setHistory] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [selected, setSelected] = useState<Square | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const engine = useEngineAnalysis();

  const gameOver = gameOverText(chess);
  const { status: engineStatus, analyze, stop } = engine;

  // Keep the engine pointed at the current position (restart on every change).
  useEffect(() => {
    if (engineStatus !== "ready") return;
    if (gameOver) stop();
    else analyze(fen);
  }, [engineStatus, fen, gameOver, analyze, stop]);

  const refresh = useCallback(() => {
    setFen(chess.fen());
    setHistory(chess.history());
    setSelected(null);
  }, [chess]);

  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      try {
        const move = chess.move({ from, to, promotion: "q" });
        setLastMove({ from: move.from, to: move.to });
        refresh();
        return true;
      } catch {
        return false;
      }
    },
    [chess, refresh]
  );

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(chess.moves({ square: selected, verbose: true }).map((m) => m.to as string));
  }, [chess, selected, fen]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSquareClick = useCallback(
    (square: Square) => {
      if (selected && legalTargets.has(square)) {
        tryMove(selected, square);
        return;
      }
      const piece = chess.get(square);
      if (piece && piece.color === chess.turn()) setSelected(square);
      else setSelected(null);
    },
    [chess, selected, legalTargets, tryMove]
  );

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      styles[lastMove.from] = { backgroundColor: "rgba(251, 191, 36, 0.25)" };
      styles[lastMove.to] = { backgroundColor: "rgba(251, 191, 36, 0.35)" };
    }
    if (selected) styles[selected] = { backgroundColor: "rgba(96, 165, 250, 0.4)" };
    for (const target of legalTargets) {
      styles[target] = {
        background: "radial-gradient(circle, rgba(96, 165, 250, 0.5) 22%, transparent 25%)",
      };
    }
    return styles;
  }, [lastMove, selected, legalTargets]);

  const newGame = useCallback(() => {
    chess.reset();
    setLastMove(null);
    refresh();
  }, [chess, refresh]);

  const undo = useCallback(() => {
    if (chess.undo()) {
      const previous = chess.history({ verbose: true }).at(-1);
      setLastMove(previous ? { from: previous.from, to: previous.to } : null);
      refresh();
    }
  }, [chess, refresh]);

  const topLine = engine.lines[0];
  const whiteBarPct = topLine ? topLine.wpWhite : 50;

  const movePairs = useMemo(() => {
    const pairs: { number: number; white: string; black: string | null }[] = [];
    for (let i = 0; i < history.length; i += 2) {
      pairs.push({
        number: i / 2 + 1,
        white: history[i] ?? "",
        black: history[i + 1] ?? null,
      });
    }
    return pairs;
  }, [history]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Board + eval bar */}
      <div className="flex w-full max-w-[640px] items-stretch gap-2">
        <div
          className="w-4 shrink-0 overflow-hidden rounded-sm bg-zinc-800"
          title={topLine ? `White win probability ${topLine.wpWhite.toFixed(1)}%` : "eval bar"}
        >
          <div className="flex h-full flex-col">
            <div
              className="w-full bg-zinc-900 transition-all duration-300"
              style={{ height: `${orientation === "white" ? 100 - whiteBarPct : whiteBarPct}%` }}
            />
            <div className="w-full flex-1 bg-zinc-100 transition-all duration-300" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <Chessboard
            id="play-board"
            position={fen}
            onPieceDrop={tryMove}
            onSquareClick={onSquareClick}
            boardOrientation={orientation}
            customSquareStyles={squareStyles}
            customDarkSquareStyle={{ backgroundColor: "#4a5568" }}
            customLightSquareStyle={{ backgroundColor: "#cbd5e0" }}
            autoPromoteToQueen
            areArrowsAllowed
          />
          {gameOver && (
            <div className="mt-3 rounded-lg bg-amber-950 px-4 py-2 text-center font-medium text-amber-300">
              {gameOver}
            </div>
          )}
        </div>
      </div>

      {/* Panel */}
      <div className="flex w-full flex-col gap-4 lg:w-80">
        <div className="flex gap-2">
          <button
            onClick={newGame}
            className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300"
          >
            New game
          </button>
          <button
            onClick={undo}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Undo
          </button>
          <button
            onClick={() => setOrientation((o) => (o === "white" ? "black" : "white"))}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Flip
          </button>
        </div>

        {/* Engine lines */}
        <div className="rounded-lg border border-zinc-800 p-3">
          <div className="mb-2 flex items-baseline justify-between text-xs text-zinc-500">
            <span>
              {engine.status === "booting" && "Engine booting…"}
              {engine.status === "error" && "Engine failed to load"}
              {engine.status === "ready" &&
                `${engine.meta?.name ?? "Stockfish"} · ${engine.meta?.variant} · ${engine.meta?.threads} thread${(engine.meta?.threads ?? 1) > 1 ? "s" : ""}`}
            </span>
            {engine.status === "ready" && engine.depth > 0 && (
              <span>
                d{engine.depth} · {(engine.nps / 1_000_000).toFixed(1)}Mnps
              </span>
            )}
          </div>
          {gameOver ? (
            <p className="text-sm text-zinc-400">Game over.</p>
          ) : (
            <ul className="space-y-1.5">
              {engine.lines.map((line) => (
                <li key={line.multipv} className="flex gap-2 text-sm">
                  <span className="w-14 shrink-0 font-mono font-medium text-amber-400">
                    {formatEval(line.evaluation)}
                  </span>
                  <span className="truncate text-zinc-400" title={line.pvSan.join(" ")}>
                    {line.pvSan.slice(0, 8).join(" ")}
                  </span>
                </li>
              ))}
              {engine.status === "ready" && engine.lines.length === 0 && (
                <li className="text-sm text-zinc-600">analyzing…</li>
              )}
            </ul>
          )}
        </div>

        {/* Move list */}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 p-3">
          {movePairs.length === 0 ? (
            <p className="text-sm text-zinc-600">
              Make a move — drag a piece or tap origin then destination.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {movePairs.map((pair) => (
                  <tr key={pair.number} className="text-zinc-300">
                    <td className="w-8 py-0.5 pr-2 text-right text-zinc-600">{pair.number}.</td>
                    <td className="w-1/2 py-0.5 font-medium">{pair.white}</td>
                    <td className="py-0.5 font-medium">{pair.black ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
