"use client";

import { useCallback, useMemo, useState } from "react";
import { Chessboard } from "react-chessboard";
import type { Arrow } from "react-chessboard/dist/chessboard/types";
import { animationMs, boardColors } from "@/lib/prefs/prefs";
import { customPiecesFor } from "./pieces";
import { usePrefs } from "./prefs-context";

/**
 * The board with input handling shared by games and the analysis board:
 * drag AND tap-tap (spec §10), preference-driven theme/pieces/animation
 * (B2.5/B2.7), last-move and legal-target highlights. Castling by
 * tap-king-then-tap-rook works in chess960 because destsFrom offers the
 * rook square (A1.2).
 */
export function GameBoard({
  boardId,
  fen,
  orientation,
  lastMove,
  interactive,
  onMove,
  destsFrom,
  canSelect,
  arrows,
}: {
  boardId: string;
  fen: string;
  orientation: "white" | "black";
  lastMove: { from: string; to: string } | null;
  interactive: boolean;
  onMove(from: string, to: string): boolean;
  destsFrom(square: string): string[];
  canSelect(square: string): boolean;
  /** Review annotations (best move / played error) — [from, to, cssColor]. */
  arrows?: { from: string; to: string; color: string }[];
}) {
  const { prefs } = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);

  const legalTargets = useMemo(
    () => new Set(selected ? destsFrom(selected) : []),
    [selected, destsFrom, fen] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      const done = onMove(from, to);
      if (done) setSelected(null);
      return done;
    },
    [onMove]
  );

  const onSquareClick = useCallback(
    (square: string) => {
      if (!interactive) return;
      if (selected && legalTargets.has(square)) {
        tryMove(selected, square);
        return;
      }
      setSelected(canSelect(square) ? square : null);
    },
    [interactive, selected, legalTargets, tryMove, canSelect]
  );

  const colors = boardColors(prefs);

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      // Last-move tint is per-theme (BOARD_THEMES.highlight) so it stays
      // OBVIOUS on every board — a fixed sage tint vanished on green boards.
      styles[lastMove.from] = {
        backgroundColor: `color-mix(in oklab, ${colors.highlight} 55%, transparent)`,
      };
      styles[lastMove.to] = {
        backgroundColor: `color-mix(in oklab, ${colors.highlight} 78%, transparent)`,
        boxShadow: `inset 0 0 0 2px color-mix(in oklab, ${colors.highlight} 90%, black)`,
      };
    }
    if (selected) {
      styles[selected] = { backgroundColor: "color-mix(in oklab, var(--paper) 45%, transparent)" };
    }
    for (const target of legalTargets) {
      styles[target] = {
        background:
          "radial-gradient(circle, color-mix(in oklab, var(--black-adv) 55%, transparent) 22%, transparent 25%)",
      };
    }
    return styles;
  }, [lastMove, selected, legalTargets, colors.highlight]);

  return (
    <Chessboard
      id={boardId}
      position={fen}
      onPieceDrop={tryMove}
      onSquareClick={onSquareClick}
      boardOrientation={orientation}
      customSquareStyles={squareStyles}
      customDarkSquareStyle={{ backgroundColor: colors.dark }}
      customLightSquareStyle={{ backgroundColor: colors.light }}
      customPieces={customPiecesFor(prefs.pieceSet)}
      animationDuration={animationMs(prefs)}
      showBoardNotation={prefs.coordinates === "on"}
      arePiecesDraggable={interactive}
      autoPromoteToQueen
      areArrowsAllowed
      // Always an array: passing undefined leaves react-chessboard's
      // previous arrows on the board (stale best-move arrows on later plies).
      customArrows={(arrows ?? []).map((arrow) => [arrow.from, arrow.to, arrow.color] as Arrow)}
    />
  );
}
